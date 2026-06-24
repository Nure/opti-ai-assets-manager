import path from 'path';
import fs from 'fs/promises';
import XLSX from 'xlsx';

const dataDir = process.env.APP_DATA_DIR || path.resolve(process.cwd(), '../data');
const outputDir = process.env.APP_OUTPUT_DIR || (await fs.stat('/host-app').then(() => '/host-app').catch(() => path.resolve(process.cwd(), '..')));

function safeCell(value) {
  if (typeof value !== 'string') return value ?? '';
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}
function rowsSafe(rows) {
  return rows.map(row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, safeCell(v)])));
}
function folderName(value) { return String(value || '').trim() || 'Home'; }
function folderPath(value) { const v = String(value || '').trim(); return v && v !== 'undefined' && v !== 'null' ? v : '/'; }
function fileSafe(value = '') { return String(value || '').replace(/[\\/:*?"<>|\x00-\x1F]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 160) || 'download-report'; }

function isAnalyzeMetadataJob(job) {
  return job?.downloadSummary?.operationMode === 'analyze-assets-metadata';
}
function isAnalyzeAssetsJob(job) {
  return job?.downloadSummary?.operationMode === 'analyze-assets';
}
function isDownloadOnlyJob(job) {
  return (job?.downloadSummary?.operationMode || 'download-assets') === 'download-assets';
}
function cmpOperationLabel(job) {
  const mode = job?.downloadSummary?.operationMode || 'download-assets';
  if (mode === 'analyze-assets') return 'Downloads Assets Information Only';
  if (mode === 'analyze-assets-metadata') return 'Download CMP DAM Assets Info and Metadata';
  return 'Download Assets only';
}
function rowsForCurrentDownloadRun(job, key) {
  const rows = job?.[key] || [];
  const runId = job?.downloadSummary?.operationRunId || '';
  if (!runId) return rows;
  return rows.filter(r => !r.operationRunId || r.operationRunId === runId);
}

function safeHeader(value = '') {
  const base = String(value || '').trim() || 'Unnamed Field';
  return base
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 80);
}

function uniqueHeaders(headers) {
  const seen = new Map();
  return headers.map(h => {
    const base = safeHeader(h);
    const count = seen.get(base) || 0;
    seen.set(base, count + 1);
    return count ? `${base} (${count + 1})` : base;
  });
}

function valueFromAssetFieldRow(row = {}) {
  const v = row.resolvedValues || row.values || row.value || '';
  if (Array.isArray(v)) return v.filter(Boolean).join('; ');
  return String(v ?? '');
}

function buildAssetsMetadataRows(job) {
  const baseColumns = [
    'source', 'assetTitle', 'assetId', 'assetGuid', 'cmpFolderId', 'cmpFolderName', 'folderPath',
    'sourceUrl', 'requestEndpoint', 'originalFileName', 'savedFileName', 'fileName', 'fileNameSource', 'assetType', 'contentType', 'sizeBytes',
    'status', 'localRelativePath', 'checksum', 'retryCount', 'error', 'downloadedAt', 'analyzedAt', 'attemptedAt'
  ];

  const fieldRows = rowsForCurrentDownloadRun(job, 'assetFieldRows');
  const fieldsByAsset = new Map();
  const fieldKeyToHeader = new Map();

  for (const f of fieldRows) {
    const assetKey = f.assetId || f.assetGuid || f.assetTitle || '';
    const rawName = f.fieldName || f.fieldId || 'Unnamed Field';
    const key = `${f.fieldId || rawName}::${rawName}`;
    if (!fieldKeyToHeader.has(key)) fieldKeyToHeader.set(key, rawName);
    if (!fieldsByAsset.has(assetKey)) fieldsByAsset.set(assetKey, []);
    fieldsByAsset.get(assetKey).push({ key, value: valueFromAssetFieldRow(f) });
  }

  const uniqueFieldHeaders = uniqueHeaders([...fieldKeyToHeader.values()]);
  const fieldKeyToUniqueHeader = new Map();
  [...fieldKeyToHeader.keys()].forEach((key, idx) => fieldKeyToUniqueHeader.set(key, uniqueFieldHeaders[idx]));

  const rows = rowsForCurrentDownloadRun(job, 'downloadedAssets').map(a => {
    const row = {
      source: a.source || '',
      assetTitle: a.assetTitle || a.title || '',
      assetId: a.assetId || '',
      assetGuid: a.assetGuid || '',
      cmpFolderId: a.cmpFolderId || '',
      cmpFolderName: folderName(a.cmpFolderName),
      folderPath: folderPath(a.folderPath),
      sourceUrl: a.sourceUrl || '',
      requestEndpoint: a.requestEndpoint || '',
      originalFileName: a.originalFileName || '',
      savedFileName: a.savedFileName || '',
      fileName: a.fileName || '',
      fileNameSource: a.fileNameSource || '',
      assetType: a.assetType || '',
      contentType: a.contentType || '',
      sizeBytes: a.sizeBytes ?? '',
      status: a.status || '',
      localRelativePath: a.localRelativePath || '',
      checksum: a.checksum || '',
      retryCount: a.retryCount ?? '',
      error: a.error || '',
      downloadedAt: a.downloadedAt || '',
      analyzedAt: a.analyzedAt || '',
      attemptedAt: a.attemptedAt || ''
    };
    for (const h of uniqueFieldHeaders) row[h] = '';
    const assetKeyCandidates = [a.assetId, a.assetGuid, a.assetTitle || a.title].filter(Boolean);
    const rowsForAsset = assetKeyCandidates.flatMap(k => fieldsByAsset.get(k) || []);
    for (const f of rowsForAsset) {
      const header = fieldKeyToUniqueHeader.get(f.key);
      if (!header) continue;
      row[header] = row[header] ? `${row[header]}; ${f.value}` : f.value;
    }
    return row;
  });

  return { rows, header: [...baseColumns, ...uniqueFieldHeaders] };
}


function downloadAssetOverviewRows(job) {
  return rowsForCurrentDownloadRun(job, 'downloadedAssets').map(a => ({
    source: a.source || '',
    assetTitle: a.assetTitle || a.title || '',
    assetId: a.assetId || '',
    assetGuid: a.assetGuid || '',
    cmpFolderId: a.cmpFolderId || '',
    cmpFolderName: folderName(a.cmpFolderName),
    folderPath: folderPath(a.folderPath),
    sourceUrl: a.sourceUrl || '',
    requestEndpoint: a.requestEndpoint || '',
    originalFileName: a.originalFileName || '',
    savedFileName: a.savedFileName || '',
    fileName: a.fileName || '',
    fileNameSource: a.fileNameSource || '',
    assetType: a.assetType || '',
    contentType: a.contentType || '',
    sizeBytes: a.sizeBytes ?? '',
    status: a.status || '',
    localRelativePath: a.localRelativePath || '',
    checksum: a.checksum || '',
    retryCount: a.retryCount ?? '',
    error: a.error || '',
    downloadedAt: a.downloadedAt || '',
    analyzedAt: a.analyzedAt || '',
    attemptedAt: a.attemptedAt || ''
  }));
}

function downloadHttpTraceRows(job) {
  return rowsForCurrentDownloadRun(job, 'downloadHttpEvents').map(e => ({
    at: e.at,
    phase: e.phase,
    method: e.method,
    url: e.url,
    status: e.status,
    httpStatus: e.response?.status || '',
    contentType: e.response?.contentType || '',
    contentLength: e.response?.contentLength || '',
    requestId: e.response?.requestId || '',
    error: e.error || '',
    responsePreview: e.response?.bodyPreview || ''
  }));
}

function appendDownloadSheets(wb, job) {
  if (isAnalyzeMetadataJob(job)) {
    const { rows, header } = buildAssetsMetadataRows(job);
    const ws = XLSX.utils.json_to_sheet(rowsSafe(rows), { header });
    XLSX.utils.book_append_sheet(wb, ws, 'Assets Metadata');
    return;
  }

  if (isAnalyzeAssetsJob(job)) {
    const rows = downloadAssetOverviewRows(job);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rowsSafe(rows)), 'Assets Information Only');
    return;
  }

  // Download Assets only: keep this XLSX strictly download-specific.
  const summaryRows = [
    { metric: 'Job ID', value: job.id || '' },
    { metric: 'Job Name', value: job.name || '' },
    { metric: 'Status', value: job.status || '' },
    { metric: 'Download Source', value: job.downloadSummary?.source || '' },
    { metric: 'Operation Mode', value: job.downloadSummary?.operationMode || '' },
    { metric: 'Operation', value: cmpOperationLabel(job) },
    { metric: 'Operation Run ID', value: job.downloadSummary?.operationRunId || '' },
    { metric: 'Requested Assets', value: job.downloadSummary?.requested ?? '' },
    { metric: 'Downloaded Assets', value: job.downloadSummary?.downloaded ?? '' },
    { metric: 'Failed Assets', value: job.downloadSummary?.failed ?? '' },
    { metric: 'Skipped Assets', value: job.downloadSummary?.skipped ?? '' },
    { metric: 'Metadata Only', value: job.downloadSummary?.metadataOnly ?? '' },
    { metric: 'Folder ID', value: job.downloadSummary?.folderId || '' },
    { metric: 'Discovery Mode', value: job.downloadSummary?.discoveryMode || '' },
    { metric: 'All Assets', value: job.downloadSummary?.downloadAll ? 'Yes' : 'No' },
    { metric: 'Local Download Folder', value: job.downloadSummary?.localDownloadFolder || job.downloadSummary?.downloadRoot || '' },
    { metric: 'Retry Policy', value: job.downloadSummary?.retryPolicy || '' },
    { metric: 'Last Download At', value: job.downloadSummary?.lastDownloadAt || '' }
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rowsSafe(summaryRows)), 'Download Summary');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rowsSafe(downloadAssetOverviewRows(job))), 'Downloaded Assets');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rowsSafe(downloadHttpTraceRows(job))), 'Download HTTP Trace');
}

export async function exportDownloadXlsx(job) {
  await fs.mkdir(outputDir, { recursive: true });
  const wb = XLSX.utils.book_new();
  appendDownloadSheets(wb, job);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(outputDir, `${fileSafe(cmpOperationLabel(job))}-${job.id}-${stamp}.xlsx`);
  XLSX.writeFile(wb, outPath);
  return outPath;
}


function rowsForCurrentImportRun(job, key) {
  const rows = job?.[key] || [];
  const runId = job?.importSummary?.operationRunId || '';
  if (!runId) return rows;
  return rows.filter(r => !r.operationRunId || r.operationRunId === runId);
}

function importAssetRows(job) {
  return rowsForCurrentImportRun(job, 'importedAssets').map(a => ({
    sourceFileName: a.sourceFileName || '',
    relativePath: a.relativePath || '',
    sourceFolderPath: a.sourceFolderPath || '/',
    targetCmpFolderId: a.targetCmpFolderId || '',
    targetCmpFolderName: a.targetCmpFolderName || '',
    targetCmpFolderPath: a.targetCmpFolderPath || '/',
    assetTitle: a.assetTitle || '',
    assetId: a.assetId || '',
    assetGuid: a.assetGuid || '',
    assetType: a.assetType || '',
    contentType: a.contentType || '',
    sizeBytes: a.sizeBytes ?? '',
    checksum: a.checksum || '',
    status: a.status || '',
    retryCount: a.retryCount ?? '',
    uploadUrlEndpoint: a.uploadUrlEndpoint || '',
    createAssetEndpoint: a.createAssetEndpoint || '',
    uploadAttempts: a.uploadAttempts ?? '',
    tokenRefreshCount: a.tokenRefreshCount ?? '',
    uploadUrlRefreshCount: a.uploadUrlRefreshCount ?? '',
    lastStage: a.lastStage || '',
    error: a.error || '',
    uploadedAt: a.uploadedAt || ''
  }));
}

function importFolderRows(job) {
  return rowsForCurrentImportRun(job, 'createdFolders').map(f => ({
    sourceFolderPath: f.sourceFolderPath || '',
    cmpFolderId: f.cmpFolderId || '',
    cmpFolderName: f.cmpFolderName || '',
    parentCmpFolderId: f.parentCmpFolderId || '',
    parentFolderPath: f.parentFolderPath || '/',
    status: f.status || '',
    requestEndpoint: f.requestEndpoint || '',
    createdAt: f.createdAt || '',
    error: f.error || ''
  }));
}

function importFailedRows(job) {
  return rowsForCurrentImportRun(job, 'importFailedItems').map(f => ({
    itemType: f.itemType || '',
    fileName: f.fileName || '',
    relativePath: f.relativePath || '',
    folderPath: f.folderPath || '/',
    stage: f.stage || '',
    status: f.status || '',
    retryCount: f.retryCount ?? '',
    error: f.error || '',
    lastAttemptAt: f.lastAttemptAt || ''
  }));
}

function importHttpTraceRows(job) {
  return rowsForCurrentImportRun(job, 'importHttpEvents').map(e => ({
    at: e.at || '',
    phase: e.phase || '',
    method: e.method || '',
    endpoint: e.url || '',
    status: e.status || '',
    httpStatus: e.response?.status || '',
    contentType: e.response?.contentType || '',
    contentLength: e.response?.contentLength || '',
    requestId: e.response?.requestId || '',
    error: e.error || '',
    responsePreview: e.response?.bodyPreview || ''
  }));
}

export async function exportImportXlsx(job) {
  await fs.mkdir(outputDir, { recursive: true });
  const wb = XLSX.utils.book_new();
  const summaryRows = [
    { metric: 'Job ID', value: job.id || '' },
    { metric: 'Job Name', value: job.name || '' },
    { metric: 'Status', value: job.status || '' },
    { metric: 'Import Status', value: job.importSummary?.status || '' },
    { metric: 'Requested Files', value: job.importSummary?.requestedFiles ?? '' },
    { metric: 'Uploaded Assets', value: job.importSummary?.uploaded ?? '' },
    { metric: 'Failed Assets', value: job.importSummary?.failed ?? '' },
    { metric: 'Created Folders', value: job.importSummary?.createdFolders ?? '' },
    { metric: 'Reused Folders', value: job.importSummary?.reusedFolders ?? '' },
    { metric: 'Parent Folder ID', value: job.importSummary?.parentFolderId || '' },
    { metric: 'Parallel Uploads', value: job.importSummary?.concurrency ?? '' },
    { metric: 'Retry Count', value: job.importSummary?.retryCount ?? '' },
    { metric: 'Pending Assets', value: job.importSummary?.pending ?? '' },
    { metric: 'Resume Available', value: job.importSummary?.resumeAvailable || '' },
    { metric: 'Token Refresh Count', value: job.importSummary?.tokenRefreshCount ?? '' },
    { metric: 'Upload URL Refresh Count', value: job.importSummary?.uploadUrlRefreshCount ?? '' },
    { metric: 'Resumed', value: job.importSummary?.resumed || '' },
    { metric: 'Retry Failed Only', value: job.importSummary?.retryFailedOnly || '' },
    { metric: 'Local Import Folder', value: job.importSummary?.localImportFolder || job.importRootRelativePath || '' },
    { metric: 'Checkpoint JSON', value: job.importSummary?.checkpoint || '' },
    { metric: 'Started At', value: job.importSummary?.startedAt || '' },
    { metric: 'Completed At', value: job.importSummary?.completedAt || '' }
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rowsSafe(summaryRows)), 'Import Summary');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rowsSafe(importAssetRows(job))), 'Imported Assets');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rowsSafe(importFolderRows(job))), 'Created Folders');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rowsSafe(importFailedRows(job))), 'Failed Items');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rowsSafe(importHttpTraceRows(job))), 'Import HTTP Trace');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(outputDir, `Import and Migrate-${job.id}-${stamp}.xlsx`);
  XLSX.writeFile(wb, outPath);
  return outPath;
}

export async function exportJobXlsx(job) {
  await fs.mkdir(path.join(dataDir, 'exports'), { recursive: true });
  const wb = XLSX.utils.book_new();
  const summaryRows = [
    { metric: 'Job ID', value: job.id || '' },
    { metric: 'Job Name', value: job.name || '' },
    { metric: 'Status', value: job.status || '' },
    { metric: 'Pages Scanned', value: job.scanSummary?.pagesScanned ?? '' },
    { metric: 'Asset References', value: job.scanSummary?.references ?? '' },
    { metric: 'Unique Assets', value: job.scanSummary?.uniqueAssets ?? '' },
    { metric: 'Migration Uploaded', value: job.migrationSummary?.uploaded ?? '' },
    { metric: 'Migration Failed', value: job.migrationSummary?.failed ?? '' }
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rowsSafe(summaryRows)), 'Summary');

  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rowsSafe((job.pages || []).map(p => ({
    id: p.id, title: p.title, url: p.url, finalUrl: p.finalUrl, source: p.source, status: p.status, httpStatus: p.httpStatus, scannedAt: p.scannedAt, error: p.error || ''
  })))), 'Pages');

  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rowsSafe((job.assetReferences || []).map(r => ({
    pageTitle: r.pageTitle, pageUrl: r.pageUrl, assetLink: r.absoluteUrl, rawAssetLink: r.rawUrl, assetType: r.assetType, location: r.location, attribute: r.attribute, folderPath: r.folderPath, status: r.status
  })))), 'Asset References');

  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rowsSafe((job.assets || []).map(a => ({
    assetId: a.id, assetLink: a.sourceUrl, cmpUrl: a.cmpUrl, assetType: a.assetType, folderPath: a.folderPath, fileName: a.fileName, status: a.status, checksum: a.checksum, duplicateOf: a.duplicateOf, duplicateReason: a.duplicateReason, references: a.references, sizeBytes: a.sizeBytes, uploadMode: a.mode, error: a.error
  })))), 'Asset Status');

  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rowsSafe((job.assets || []).filter(a => a.duplicateOf).map(a => ({
    assetLink: a.sourceUrl, duplicateOf: a.duplicateOf, reason: a.duplicateReason, checksum: a.checksum, cmpUrlReused: a.cmpUrl
  })))), 'Duplicates');

  const outPath = path.join(dataDir, 'exports', `${job.id}-migration-report.xlsx`);
  XLSX.writeFile(wb, outPath);
  return outPath;
}

function rowsForCurrentTagRun(job, key) {
  const rows = job?.[key] || [];
  const runId = job?.tagSummary?.operationRunId || '';
  if (!runId) return rows;
  return rows.filter(r => !r.operationRunId || r.operationRunId === runId || key === 'tagDryRunRows' || key === 'tagHeaderRows');
}
function tagHttpTraceRows(job) {
  return (job.tagHttpEvents || []).map(e => ({
    at: e.at || '',
    phase: e.phase || '',
    method: e.method || '',
    endpoint: e.url || '',
    status: e.status || '',
    httpStatus: e.response?.status || '',
    contentType: e.response?.contentType || '',
    requestId: e.response?.requestId || '',
    error: e.error || '',
    responsePreview: e.response?.bodyPreview || ''
  }));
}
export async function exportTagXlsx(job) {
  await fs.mkdir(outputDir, { recursive: true });
  const wb = XLSX.utils.book_new();
  const summaryRows = [
    { metric: 'Job ID', value: job.id || '' },
    { metric: 'Job Name', value: job.name || '' },
    { metric: 'Status', value: job.status || '' },
    { metric: 'Operation', value: job.tagSummary?.operation || '' },
    { metric: 'Tag Status', value: job.tagSummary?.status || '' },
    { metric: 'Total Rows', value: job.tagSummary?.totalRows ?? '' },
    { metric: 'Total Assets', value: job.tagSummary?.totalAssets ?? '' },
    { metric: 'Metadata Columns', value: job.tagSummary?.metadataColumns ?? '' },
    { metric: 'Matched Headers', value: job.tagSummary?.matchedHeaders ?? '' },
    { metric: 'Missing Headers', value: job.tagSummary?.missingHeaders ?? '' },
    { metric: 'Invalid Values', value: job.tagSummary?.invalidValues ?? '' },
    { metric: 'Ready Updates', value: job.tagSummary?.readyUpdates ?? '' },
    { metric: 'Requested Updates', value: job.tagSummary?.requestedUpdates ?? '' },
    { metric: 'Updated', value: job.tagSummary?.updated ?? '' },
    { metric: 'Failed', value: job.tagSummary?.failed ?? '' },
    { metric: 'Skipped', value: job.tagSummary?.skipped ?? '' },
    { metric: 'Can Execute', value: job.tagSummary?.canExecute || '' },
    { metric: 'Token Refresh Count', value: job.tagSummary?.tokenRefreshCount ?? '' },
    { metric: 'Last Dry Run At', value: job.tagSummary?.lastDryRunAt || '' },
    { metric: 'Executed At', value: job.tagSummary?.executedAt || '' }
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rowsSafe(summaryRows)), 'Tag Summary');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rowsSafe(job.tagHeaderRows || [])), 'Header Mapping');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rowsSafe(job.tagDryRunRows || [])), 'Dry Run Validation');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rowsSafe(rowsForCurrentTagRun(job, 'tagExecutionRows'))), 'Execution Results');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rowsSafe(tagHttpTraceRows(job))), 'Tag HTTP Trace');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const label = job.tagSummary?.operation === 'execute' ? 'Tag Assets Metadata Execution' : 'Tag Assets Metadata Dry Run';
  const outPath = path.join(outputDir, `${label}-${job.id}-${stamp}.xlsx`);
  XLSX.writeFile(wb, outPath);
  return outPath;
}
