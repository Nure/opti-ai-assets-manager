// Docker Compose loads .env through env_file. Avoid dotenv/config ESM subpath resolution issues in Node containers.
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import fs from 'fs/promises';
import multer from 'multer';
import { fileURLToPath } from 'url';
import { nanoid } from 'nanoid';
import { upsertJob, readDb, getJob, updateJob, patchJob, appendJobLog, addReport, deleteReport, getAllReports } from './store.js';
import { now } from './utils.js';
import { scanJob } from './scanner.js';
import { migrateAssets } from './migration.js';
import { importXlsxFromLink, importFolderFiles } from './importer.js';
import { enterpriseImportFolderFiles, resumeEnterpriseImport } from './importUploader.js';
import { exportJobXlsx, exportDownloadXlsx, exportImportXlsx, exportTagXlsx } from './exporter.js';
import { createSampleDownloadXlsx, downloadAssetsFromXlsx, downloadAssetsFromCmp } from './downloader.js';
import { dryRunTagAssetsMetadata, executeTagAssetsMetadata } from './tagger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.APP_DATA_DIR || path.resolve(process.cwd(), '../data');
const upload = multer({ dest: path.join(dataDir, 'tmp'), preservePath: true });
const app = express();
app.use(cors());
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '10mb' }));
app.use('/api/files', express.static(path.join(dataDir, 'exports')));

// Long imports can run for a long time and produce many store writes. Keep a
// lightweight in-memory mirror while an operation is running so console polling
// does not stop if the JSON store is briefly unavailable or a stale read returns
// a 404 during heavy checkpoint activity.
const runningOperations = new Map();

function rememberRunningLog(jobId, message, level = 'info') {
  const entry = runningOperations.get(jobId);
  if (!entry) return;
  entry.logs.push({ id: `${Date.now()}-${entry.logs.length}`, at: new Date().toISOString(), level, message });
  entry.logs = entry.logs.slice(-1500);
  entry.updatedAt = new Date().toISOString();
}

function publicJob(j) {
  return { id: j.id, name: j.name, cmsType: j.cmsType, status: j.status, summary: j.summary, scanSummary: j.scanSummary, downloadSummary: j.downloadSummary, importSummary: j.importSummary, migrationSummary: j.migrationSummary, downloadHttpEvents: j.downloadHttpEvents || [], importHttpEvents: j.importHttpEvents || [], createdAt: j.createdAt, updatedAt: j.updatedAt, reports: j.reports || [] };
}

function createReport(type, title, job) {
  const snapshot = {
    pages: job.pages || [],
    assetReferences: job.assetReferences || [],
    assets: job.assets || [],
    scanSummary: job.scanSummary || {},
    downloadSummary: job.downloadSummary || {},
    migrationSummary: job.migrationSummary || {},
    summary: job.summary || {},
    downloadedAssets: job.downloadedAssets || [],
    downloadHttpEvents: job.downloadHttpEvents || [],
    assetFieldRows: job.assetFieldRows || [],
    importSummary: job.importSummary || {},
    importedAssets: job.importedAssets || [],
    createdFolders: job.createdFolders || [],
    importFailedItems: job.importFailedItems || [],
    importHttpEvents: job.importHttpEvents || [],
    tagSummary: job.tagSummary || {},
    tagHeaderRows: job.tagHeaderRows || [],
    tagDryRunRows: job.tagDryRunRows || [],
    tagExecutionRows: job.tagExecutionRows || [],
    tagHttpEvents: job.tagHttpEvents || []
  };
  return { id: nanoid(), type, title, createdAt: now(), summary: type === 'scan' ? job.scanSummary || job.summary || {} : type === 'download' ? job.downloadSummary || job.summary || {} : type === 'migration' ? job.migrationSummary || job.summary || {} : type === 'tag' ? job.tagSummary || job.summary || {} : job.importSummary || job.summary || {}, snapshot };
}

async function runOperation(jobId, status, operationName, runner, reportType, reportTitle) {
  await patchJob(jobId, { status });
  runningOperations.set(jobId, { status, operationName, logs: [], updatedAt: new Date().toISOString() });
  const safeLogger = async (message, level = 'info') => {
    rememberRunningLog(jobId, message, level);
    const written = await appendJobLog(jobId, message, level);
    if (!written) {
      const latest = await getJob(jobId).catch(() => null);
      if (!latest) {
        // Do not fail the long-running import only because the console store could
        // not be updated. The checkpoint remains the source of truth for resume.
        return null;
      }
    }
    return written;
  };
  await safeLogger(`${operationName} started.`);
  setImmediate(async () => {
    try {
      const job = await getJob(jobId);
      const updated = await runner(job, safeLogger);
      updated.updatedAt = now();

      // Important: runner logs are written directly to the persisted job while the
      // long-running operation is in progress. The `job` object passed into the
      // runner is an older in-memory snapshot, so blindly upserting it at the end
      // can erase detailed logs such as CMP-UPLOAD-URL response previews,
      // presigned-upload failures, and sample failed-item diagnostics. Merge the
      // latest persisted logs/reports back before saving the final job payload.
      const latestBeforeSave = await getJob(jobId);
      if (latestBeforeSave) {
        updated.logs = latestBeforeSave.logs || updated.logs || [];
        updated.reports = latestBeforeSave.reports || updated.reports || [];
      }

      await upsertJob(updated);
      if (reportType) await addReport(jobId, createReport(reportType, reportTitle, updated));
      const finalStatus = String(updated.status || '').toUpperCase();
      if (finalStatus.includes('INCOMPLETE') || finalStatus.includes('FAILED') || finalStatus.includes('ERROR') || finalStatus.includes('STOP')) {
        await safeLogger(`${operationName} completed with errors. Check the latest report, failed items, and HTTP trace.`, 'warn');

        if (operationName.toLowerCase().includes('import')) {
          const latestAfterSave = await getJob(jobId);
          const summary = latestAfterSave?.importSummary || updated.importSummary || {};
          await safeLogger(`Import diagnostics: uploaded=${summary.uploaded || 0}, failed=${summary.failed || 0}, pending=${summary.pending || 0}, foldersCreated=${summary.createdFolders || 0}, foldersReused=${summary.reusedFolders || 0}.`, 'warn');
          const failedItem = (latestAfterSave?.importFailedItems || updated.importFailedItems || [])[0];
          if (failedItem) {
            await safeLogger(`First failed item: ${failedItem.relativePath || failedItem.folderPath || failedItem.fileName || 'unknown'}; stage=${failedItem.stage || 'UNKNOWN'}; error=${failedItem.error || 'No error captured'}.`, 'warn');
          }
          const lastTrace = (latestAfterSave?.importHttpEvents || updated.importHttpEvents || []).slice(-1)[0];
          if (lastTrace) {
            const status = lastTrace.response?.status || lastTrace.status || '';
            const preview = lastTrace.response?.bodyPreview || lastTrace.error || '';
            await safeLogger(`Last import HTTP trace: phase=${lastTrace.phase || ''}, method=${lastTrace.method || ''}, status=${status}, endpoint=${lastTrace.url || ''}${preview ? `, preview=${String(preview).slice(0, 220)}` : ''}.`, 'warn');
          }
        }
      } else {
        await safeLogger(`${operationName} finished successfully.`);
      }
    } catch (e) {
      await safeLogger(`${operationName} failed: ${e.message}`, 'error');
      await patchJob(jobId, { status: 'FAILED', error: e.message });
    } finally {
      const entry = runningOperations.get(jobId);
      if (entry) {
        entry.status = 'DONE';
        entry.updatedAt = new Date().toISOString();
        setTimeout(() => runningOperations.delete(jobId), 10 * 60 * 1000);
      }
    }
  });
}

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'AI DAM Migration Copilot' }));

app.get('/api/jobs', async (req, res) => {
  const db = await readDb();
  res.json(db.jobs.map(publicJob));
});

app.post('/api/jobs', async (req, res) => {
  const { name, cmsType, config } = req.body;
  const job = {
    id: nanoid(),
    name: name || `${cmsType || 'CMS'} migration ${new Date().toISOString()}`,
    cmsType,
    config,
    status: 'CREATED',
    pages: [],
    assetReferences: [],
    assets: [],
    downloadedAssets: [],
    reports: [],
    logs: [],
    summary: {},
    scanSummary: {},
    importSummary: {},
    migrationSummary: {},
    createdAt: now(),
    updatedAt: now()
  };
  await upsertJob(job);
  await appendJobLog(job.id, 'Job created.');
  res.json(job);
});

app.get('/api/jobs/:id', async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

app.get('/api/jobs/:id/logs', async (req, res) => {
  // For very large imports the JSON store can be under heavy write pressure.
  // Always check the in-memory active-operation mirror first so console polling
  // does not get a false 404 while folders/assets are still being processed.
  const running = runningOperations.get(req.params.id);
  let job = null;
  try {
    job = await getJob(req.params.id);
  } catch (e) {
    if (running) {
      return res.json({
        logs: running.logs || [],
        status: running.status || 'RUNNING',
        updatedAt: running.updatedAt,
        transient: true,
        storeWarning: e.message
      });
    }
    throw e;
  }

  if (!job && running) {
    return res.json({
      logs: running.logs || [],
      status: running.status || 'RUNNING',
      updatedAt: running.updatedAt,
      transient: true
    });
  }

  if (!job) return res.status(404).json({ error: 'Job not found' });

  const combinedLogs = running ? [...(job.logs || []), ...(running.logs || [])] : (job.logs || []);
  const seen = new Set();
  const deduped = [];
  for (const log of combinedLogs) {
    const key = log.id || `${log.at}-${log.message}`;
    if (seen.has(key)) continue;
    seen.add(key); deduped.push(log);
  }
  res.json({ logs: deduped.slice(-1500), status: running?.status || job.status, updatedAt: running?.updatedAt || job.updatedAt, transient: !!running });
});

app.get('/api/jobs/:id/download-events', async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ events: job.downloadHttpEvents || [], downloadSummary: job.downloadSummary || {}, downloadedAssets: job.downloadedAssets || [] });
});


app.get('/api/reports', async (req, res) => {
  const reports = await getAllReports();
  res.json(reports);
});

app.delete('/api/reports/:jobId/:reportId', async (req, res) => {
  try {
    const updated = await deleteReport(req.params.jobId, req.params.reportId);
    if (!updated) return res.status(404).json({ error: 'Job not found' });
    res.json(await getAllReports());
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/jobs/:id/reports', async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job.reports || []);
});

app.delete('/api/jobs/:id/reports/:reportId', async (req, res) => {
  try {
    const updated = await deleteReport(req.params.id, req.params.reportId);
    if (!updated) return res.status(404).json({ error: 'Job not found' });
    res.json(updated.reports || []);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/jobs/:id/scan', async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  await runOperation(req.params.id, 'SCANNING', 'Scan', (j, logger) => scanJob(j, logger), 'scan', `Scan report - ${job.name}`);
  res.status(202).json(await getJob(req.params.id));
});

app.post('/api/jobs/:id/import/xlsx-link', async (req, res) => {
  const { xlsxUrl } = req.body;
  if (!xlsxUrl) return res.status(400).json({ error: 'xlsxUrl is required' });
  const job = await getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  await runOperation(req.params.id, 'IMPORTING', 'XLSX import', async (j, logger) => {
    await logger(`Importing XLSX link: ${xlsxUrl}`);
    const updated = await importXlsxFromLink(j, xlsxUrl);
    updated.importSummary = { ...(updated.importSummary || {}), xlsxImported: updated.summary?.xlsxImported || 0, lastImportAt: now() };
    updated.status = 'IMPORTED';
    return updated;
  }, 'import', `XLSX import report - ${job.name}`);
  res.status(202).json(await getJob(req.params.id));
});

app.post('/api/jobs/:id/import/folder', upload.array('assets', 50000), async (req, res) => {
  const files = req.files || [];
  const job = await getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (!files.length) return res.status(400).json({ error: 'No files were uploaded.' });
  const relativePaths = (() => {
    try { return JSON.parse(req.body.relativePaths || '[]'); } catch { return []; }
  })();
  if (Array.isArray(relativePaths) && relativePaths.length) {
    files.forEach((file, index) => {
      file.relativePath = relativePaths[index] || file.originalname;
    });
  }
  const options = {
    clientId: req.body.clientId,
    clientSecret: req.body.clientSecret,
    apiBaseUrl: req.body.apiBaseUrl,
    tokenUrl: req.body.tokenUrl,
    parentFolderId: req.body.parentFolderId,
    concurrency: Number(req.body.concurrency || 10),
    retryCount: Number(req.body.retryCount || 3),
    reuseExistingFolders: String(req.body.reuseExistingFolders || 'true') !== 'false'
  };
  await runOperation(req.params.id, 'IMPORTING', 'Enterprise CMP folder import', async (j, logger) => {
    const folderCount = new Set(files.map(f => String(f.relativePath || f.originalname || '').replace(/\\/g, '/').split('/').slice(0, -1).join('/')).filter(Boolean)).size;
    await logger(`Enterprise CMP folder import received ${files.length} file(s) across ${folderCount} folder path(s).`);
    return enterpriseImportFolderFiles(j, files, options, logger);
  }, 'import', `Import on ${new Date().toLocaleString()} - Folder upload - ${job.name}`);
  res.status(202).json(await getJob(req.params.id));
});

app.post('/api/jobs/:id/import/stop', async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const running = runningOperations.get(req.params.id);
  if (running) {
    running.stopRequested = true;
    rememberRunningLog(req.params.id, 'Stop requested by user. The importer will checkpoint progress and stop before starting new folders/files.', 'warn');
  }
  const updated = await patchJob(req.params.id, {
    importStopRequested: true,
    status: job.status === 'IMPORTING' ? 'IMPORT_STOP_REQUESTED' : job.status,
    importSummary: { ...(job.importSummary || {}), status: 'STOP_REQUESTED', stopRequestedAt: now(), resumeAvailable: 'Yes' }
  });
  await appendJobLog(req.params.id, 'Stop requested by user. The importer will checkpoint progress and stop safely.', 'warn');
  res.json(updated);
});

app.post('/api/jobs/:id/import/resume', async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  await runOperation(req.params.id, 'IMPORTING', req.body?.retryFailedOnly ? 'Retry failed import items' : 'Resume import', async (j, logger) => {
    return resumeEnterpriseImport(j, req.body || {}, logger);
  }, 'import', `Import resume on ${new Date().toLocaleString()} - ${job.name}`);
  res.status(202).json(await getJob(req.params.id));
});


app.get('/api/sample-assets-download.xlsx', async (req, res) => {
  try {
    const outPath = await createSampleDownloadXlsx();
    res.download(outPath, 'sample-assets-download.xlsx');
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/jobs/:id/download/xlsx-link', async (req, res) => {
  const { xlsxUrl } = req.body;
  if (!xlsxUrl) return res.status(400).json({ error: 'xlsxUrl is required' });
  const job = await getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  await runOperation(req.params.id, 'DOWNLOADING_ASSETS', 'Download assets from XLSX', async (j, logger) => {
    const updated = await downloadAssetsFromXlsx(j, xlsxUrl, logger);
    return updated;
  }, 'download', `Downloaded on ${new Date().toLocaleString()} - XLSX - ${job.name}`);
  res.status(202).json(await getJob(req.params.id));
});

app.post('/api/jobs/:id/download/cmp', async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const operationMode = req.body?.operationMode || 'download-assets';
  const opLabel = operationMode === 'analyze-assets' ? 'Downloads Assets Information Only' : operationMode === 'analyze-assets-metadata' ? 'Download CMP DAM Assets Info and Metadata' : 'Download Assets from CMP DAM';
  await runOperation(req.params.id, operationMode === 'download-assets' ? 'DOWNLOADING_ASSETS' : 'ANALYZING_ASSETS', opLabel, async (j, logger) => {
    const updated = await downloadAssetsFromCmp(j, req.body || {}, logger);
    return updated;
  }, 'download', `Downloaded on ${new Date().toLocaleString()} - CMP DAM - ${opLabel} - ${job.name}`);
  res.status(202).json(await getJob(req.params.id));
});

app.post('/api/jobs/:id/tag/dry-run', upload.single('xlsx'), async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (!req.file) return res.status(400).json({ error: 'XLSX file is required.' });
  const options = {
    clientId: req.body.clientId,
    clientSecret: req.body.clientSecret,
    apiBaseUrl: req.body.apiBaseUrl,
    tokenUrl: req.body.tokenUrl
  };
  await runOperation(req.params.id, 'TAG_DRY_RUNNING', 'Tag Assets Metadata Dry Run', async (j, logger) => {
    return dryRunTagAssetsMetadata(j, req.file.path, options, logger);
  }, 'tag', `Tag Assets Metadata Dry Run - ${job.name}`);
  res.status(202).json(await getJob(req.params.id));
});

app.post('/api/jobs/:id/tag/execute', async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const options = {
    clientId: req.body.clientId,
    clientSecret: req.body.clientSecret,
    apiBaseUrl: req.body.apiBaseUrl,
    tokenUrl: req.body.tokenUrl,
    concurrency: req.body.concurrency,
    retryCount: req.body.retryCount
  };
  await runOperation(req.params.id, 'TAGGING_METADATA', 'Tag Assets Metadata Execute', async (j, logger) => {
    return executeTagAssetsMetadata(j, options, logger);
  }, 'tag', `Tag Assets Metadata Execute - ${job.name}`);
  res.status(202).json(await getJob(req.params.id));
});


app.post('/api/jobs/:id/migrate', async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  await runOperation(req.params.id, 'MIGRATING', 'Migration', (j, logger) => migrateAssets(j, req.body || {}, logger), 'migration', `Migration report - ${job.name}`);
  res.status(202).json(await getJob(req.params.id));
});


app.get('/api/jobs/:id/reports/:reportId/export-tag.xlsx', async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const report = (job.reports || []).find(r => r.id === req.params.reportId && r.type === 'tag');
  if (!report) return res.status(404).json({ error: 'Tag report not found' });
  const snapshot = report.snapshot || {};
  const reportJob = {
    ...job,
    status: report.summary?.status || snapshot.tagSummary?.status || job.status,
    tagSummary: snapshot.tagSummary || report.summary || {},
    tagHeaderRows: snapshot.tagHeaderRows || [],
    tagDryRunRows: snapshot.tagDryRunRows || [],
    tagExecutionRows: snapshot.tagExecutionRows || [],
    tagHttpEvents: snapshot.tagHttpEvents || []
  };
  const outPath = await exportTagXlsx(reportJob);
  res.download(outPath);
});

app.get('/api/jobs/:id/export-tag.xlsx', async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const outPath = await exportTagXlsx(job);
  res.download(outPath);
});


app.get('/api/jobs/:id/reports/:reportId/export-import.xlsx', async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const report = (job.reports || []).find(r => r.id === req.params.reportId && r.type === 'import');
  if (!report) return res.status(404).json({ error: 'Import report not found' });
  const snapshot = report.snapshot || {};
  const reportJob = {
    ...job,
    status: report.summary?.status || snapshot.importSummary?.status || job.status,
    importSummary: snapshot.importSummary || report.summary || {},
    importedAssets: snapshot.importedAssets || [],
    createdFolders: snapshot.createdFolders || [],
    importFailedItems: snapshot.importFailedItems || [],
    importHttpEvents: snapshot.importHttpEvents || []
  };
  const outPath = await exportImportXlsx(reportJob);
  res.download(outPath);
});

app.get('/api/jobs/:id/export-import.xlsx', async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const outPath = await exportImportXlsx(job);
  res.download(outPath);
});

app.get('/api/jobs/:id/export-download.xlsx', async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const outPath = await exportDownloadXlsx(job);
  res.download(outPath);
});

app.get('/api/jobs/:id/export.xlsx', async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const outPath = await exportJobXlsx(job);
  res.download(outPath);
});

app.get('/simulated-cmp/:name', async (req, res) => res.type('text/plain').send('Simulated CMP DAM URL. Configure CMP_API_BASE_URL and CMP_BEARER_TOKEN for real uploads.'));

const publicDir = path.resolve(__dirname, '../public');
app.use(express.static(publicDir));
app.get('*', async (req, res) => {
  try { res.sendFile(path.join(publicDir, 'index.html')); }
  catch { res.status(404).send('Frontend not found.'); }
});

await fs.mkdir(path.join(dataDir, 'tmp'), { recursive: true });
const port = Number(process.env.PORT || 8080);
app.listen(port, () => console.log(`AI DAM Migration Copilot listening on ${port}`));
