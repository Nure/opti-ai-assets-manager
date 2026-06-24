const state = { tab: 'scan', cmsType: 'cms12', job: null, busy: false, selectedReport: null, reportHistory: [], selectedImportReport: null, selectedTagReport: null, selectedFolderFiles: [], selectedTagXlsxFile: null, logsSeen: new Set(), pollTimer: null, pollFailures: 0, lastPollError: '', pollingPaused: false, waitingOperation: false, importStopping: false };
const $ = (id) => document.getElementById(id);
const on = (id, event, handler) => { const el = $(id); if (el) el.addEventListener(event, handler); return el; };

function log(message, level = 'info', at = new Date().toISOString(), id = `${Date.now()}-${Math.random()}`) {
  if (state.logsSeen.has(id)) return;
  state.logsSeen.add(id);
  const p = document.createElement('p');
  p.className = `logLine ${level}`;
  p.textContent = `${new Date(at).toLocaleTimeString()} — ${message}`;
  $('log').prepend(p);
  while ($('log').children.length > 300) $('log').lastChild.remove();
}

function setTab(tab) {
  state.tab = tab;
  ['scan','download','migrate','tag','reports','console'].forEach(t => {
    $(`tab-${t}`).classList.toggle('active', t === tab);
    $(`view-${t}`).classList.toggle('hidden', t !== tab);
  });
  if (tab === 'console') { state.pollingPaused = false; pollNow({ manual: true }).then(startPolling); }
  else startPolling();
  if (tab === 'reports') loadReportHistory();
}

const MODEL_OPTIONS = {
  gemini: [
    'gemini-2.5-pro','gemini-2.5-flash','gemini-2.5-flash-lite',
    'gemini-2.0-flash','gemini-1.5-pro','gemini-1.5-flash'
  ],
  claude: [
    'claude-opus-4-1','claude-opus-4-0',
    'claude-sonnet-4-5','claude-sonnet-4-0',
    'claude-3-7-sonnet-latest','claude-3-5-sonnet-latest','claude-3-5-haiku-latest'
  ],
  openai: [
    'gpt-5.5','gpt-5.4','gpt-5.4-mini','gpt-5.4-nano',
    'gpt-5','gpt-5-mini','gpt-5-nano','gpt-4.1','gpt-4.1-mini','gpt-4o','gpt-4o-mini'
  ]
};

function updateCmsFields() {
  state.cmsType = $('cmsType').value;
  const targetMode = getScanMode() === 'target';
  $('cms12Fields').classList.toggle('hidden', targetMode || state.cmsType !== 'cms12');
  $('wpFields').classList.toggle('hidden', targetMode || state.cmsType !== 'wordpress');
}

function getScanMode() {
  if ($('modeTarget')?.checked) return 'target';
  if ($('modeFull')?.checked) return 'full';
  return 'test';
}

function setScanMode(mode) {
  ['Test','Full','Target'].forEach(name => {
    const el = $(`mode${name}`);
    if (el) el.checked = name.toLowerCase() === mode;
  });
  updateScanMode();
}

function updateScanMode() {
  const mode = getScanMode();
  const isTarget = mode === 'target';
  $('testOptions').classList.toggle('hidden', mode !== 'test');
  $('targetOptions').classList.toggle('hidden', !isTarget);
  $('liveDomainOptions').classList.toggle('hidden', isTarget);
  $('startPageOptions').classList.toggle('hidden', isTarget);
  $('cms12Fields').classList.toggle('hidden', isTarget || state.cmsType !== 'cms12');
  $('wpFields').classList.toggle('hidden', isTarget || state.cmsType !== 'wordpress');
  $('scanBtn').textContent = mode === 'test'
    ? `▶ Run Test Scan - ${Number($('testPageCount').value || 5)} Page(s)`
    : mode === 'full'
      ? '▶ Run Full Scan'
      : '▶ Scan Target Page';
}

function updateAiModels() {
  const provider = $('aiProvider').value;
  const modelSelect = $('aiModel');
  const models = MODEL_OPTIONS[provider] || [];
  modelSelect.innerHTML = models.map(m => `<option value="${m}">${m}</option>`).join('');
  const label = provider === 'gemini' ? 'Gemini API Key' : provider === 'claude' ? 'Claude API Key' : 'OpenAI API Key';
  $('apiKeyLabel').textContent = label;
  $('aiApiKey').placeholder = `Optional if configured in .env (${provider.toUpperCase()} key)`;
}

function updateDownloadOption() {
  const value = $('downloadOption')?.value || '';
  $('downloadXlsxPanel')?.classList.toggle('hidden', value !== 'xlsx');
  $('downloadCmpPanel')?.classList.toggle('hidden', value !== 'cmp');
}

function getCmpDownloadScope() {
  return $('cmpDownloadAll')?.checked ? 'all' : 'folder';
}

function updateCmpDownloadScope() {
  const isAll = getCmpDownloadScope() === 'all';
  $('cmpFolderFields')?.classList.toggle('hidden', isAll);
}

function updateCmpOperationMode() {
  const mode = $('cmpAssetOperation')?.value || 'download-assets';
  if ($('downloadCmpBtn')) {
    $('downloadCmpBtn').textContent = mode === 'analyze-assets'
      ? 'Downloads Assets Information Only'
      : mode === 'analyze-assets-metadata'
        ? 'Download CMP DAM Assets Info and Metadata'
        : 'Download Assets from CMP DAM';
  }
}

async function api(url, options = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(text || `${res.status} ${res.statusText}`);
    err.status = res.status;
    err.url = url;
    throw err;
  }
  return res.json();
}

function getConfig() {
  const scanMode = getScanMode();
  const selectedModel = $('customAiModel').value.trim() || $('aiModel').value;
  const common = {
    scanMode,
    baseUrl: scanMode === 'target' ? '' : $('baseUrl').value.trim(),
    targetPageUrl: $('targetPageUrl').value.trim(),
    pageUrls: scanMode === 'target' ? '' : $('pageUrls').value,
    testPageCount: Number($('testPageCount').value || 5),
    pageLimit: scanMode === 'full' ? 0 : Number($('testPageCount').value || 5),
    testScan: scanMode === 'test',
    enableAiScan: $('enableAiScan').checked,
    aiProvider: $('aiProvider').value,
    aiModel: selectedModel,
    aiApiKey: $('aiApiKey').value,
    geminiModel: selectedModel,
    geminiApiKey: $('aiProvider').value === 'gemini' ? $('aiApiKey').value : ''
  };
  if (state.cmsType === 'cms12') {
    return { ...common, cmsApiUrl: $('cmsApiUrl').value.trim(), bearerToken: $('cmsBearerToken').value, languages: $('languages').value, includeBlocks: $('includeBlocks').checked };
  }
  return { ...common, wpApiUrl: $('wpApiUrl').value.trim(), username: $('wpUsername').value, password: $('wpPassword').value, bearerToken: $('wpBearerToken').value, includeMediaLibrary: $('includeMediaLibrary').checked };
}

function isImportRunning() {
  return ['IMPORTING','IMPORT_STOP_REQUESTED'].includes(state.job?.status);
}

function updateImportActionButtons() {
  const running = isImportRunning() || state.waitingOperation && state.job?.status === 'IMPORTING';
  const start = $('startFolderImportBtn');
  const stop = $('stopImportBtn');
  if (start) start.disabled = running || state.busy;
  if (stop) {
    stop.classList.toggle('hidden', !running);
    stop.disabled = !running || state.importStopping;
    stop.textContent = state.importStopping ? 'Stopping Import...' : 'Stop Import';
  }
}

function setBusy(value) {
  state.busy = value;
  ['scanBtn','downloadXlsxBtn','downloadCmpBtn','importXlsxBtn','migrateBtn','tagDryRunBtn'].forEach(id => { if ($(id)) $(id).disabled = value; });
  updateImportActionButtons();
}

function latestReport(type) {
  return (state.job?.reports || []).find(r => r.type === type);
}

function latestHistoryReport(type) {
  return (state.reportHistory || []).filter(r => r.type === type).sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
}

function activeImportReport() {
  return state.selectedImportReport?.type === 'import' ? state.selectedImportReport : latestHistoryReport('import');
}

function activeTagReport() {
  return state.selectedTagReport?.type === 'tag' ? state.selectedTagReport : latestHistoryReport('tag');
}

function hydrateLatestImportReport() {
  if (!state.selectedImportReport) {
    const latest = latestHistoryReport('import');
    if (latest) state.selectedImportReport = latest;
  }
}

function latestSnapshot() {
  const reports = state.job?.reports || [];
  return state.selectedReport?.snapshot || reports[0]?.snapshot || state.job || {};
}

function refreshStats() {
  const job = state.job;
  const scan = job?.scanSummary || latestReport('scan')?.summary || {};
  const download = job?.downloadSummary || latestReport('download')?.summary || {};
  const migration = job?.migrationSummary || latestReport('migration')?.summary || {};
  const importReport = activeImportReport();
  const imp = job?.importSummary && Object.keys(job.importSummary || {}).length ? job.importSummary : (importReport?.summary || importReport?.snapshot?.importSummary || latestReport('import')?.summary || {});
  const assets = job?.assets || [];

  $('stat-scan-pages').textContent = scan.pagesScanned ?? job?.pages?.length ?? 0;
  $('stat-scan-refs').textContent = scan.references ?? job?.assetReferences?.length ?? 0;
  $('stat-scan-assets').textContent = scan.uniqueAssets ?? assets.length ?? 0;
  $('stat-scan-failed').textContent = scan.pagesFailed ?? 0;

  $('stat-dl-requested').textContent = download.requested ?? job?.downloadedAssets?.length ?? 0;
  $('stat-dl-downloaded').textContent = download.downloaded ?? (job?.downloadedAssets || []).filter(a => a.status === 'DOWNLOADED').length;
  $('stat-dl-metadata').textContent = download.metadataOnly ?? (job?.downloadedAssets || []).filter(a => a.status === 'METADATA_ONLY').length;
  $('stat-dl-failed').textContent = download.failed ?? (job?.downloadedAssets || []).filter(a => a.status === 'FAILED').length;

  $('stat-mig-assets').textContent = assets.length;
  $('stat-mig-uploaded').textContent = migration.uploaded ?? assets.filter(a => a.status === 'UPLOADED_TO_CMP').length;
  $('stat-mig-duplicates').textContent = migration.duplicates ?? assets.filter(a => a.status === 'DUPLICATE_DETECTED').length;
  $('stat-mig-failed').textContent = migration.failed ?? assets.filter(a => a.status === 'FAILED').length;
  if ($('stat-import-files')) $('stat-import-files').textContent = imp.requestedFiles ?? 0;
  if ($('stat-import-uploaded')) $('stat-import-uploaded').textContent = imp.uploaded ?? 0;
  if ($('stat-import-folders')) $('stat-import-folders').textContent = (imp.createdFolders ?? 0) + (imp.reusedFolders ?? 0);
  if ($('stat-import-failed')) $('stat-import-failed').textContent = imp.failed ?? 0;
  const tagReport = activeTagReport();
  const tag = job?.tagSummary && Object.keys(job.tagSummary || {}).length ? job.tagSummary : (tagReport?.summary || tagReport?.snapshot?.tagSummary || {});
  if ($('stat-tag-assets')) $('stat-tag-assets').textContent = tag.totalAssets ?? 0;
  if ($('stat-tag-columns')) $('stat-tag-columns').textContent = tag.metadataColumns ?? 0;
  if ($('stat-tag-ready')) $('stat-tag-ready').textContent = tag.readyUpdates ?? tag.updated ?? 0;
  if ($('stat-tag-issues')) $('stat-tag-issues').textContent = Number(tag.missingHeaders || 0) + Number(tag.invalidValues || 0) + Number(tag.failed || 0);
  if ($('tagExecuteBtn')) $('tagExecuteBtn').disabled = state.busy || !(job?.tagSummary?.readyUpdates > 0 || tagReport?.snapshot?.tagDryRunRows?.some?.(r => r.cmpMatchStatus === 'READY'));

  $('job-status').textContent = job ? job.status : 'No job yet';
  $('job-id').textContent = job ? `${job.name} · ${job.id}` : 'Create scan job';
  $('consoleStatus').textContent = job ? `${job.status} · ${job.id}` : 'No active job';
  $('exportLink').classList.toggle('disabled', !job);
  $('exportLink').href = job ? `/api/jobs/${job.id}/export.xlsx` : '#';
  if ($('downloadExportLink')) {
    const exportJobId = state.selectedReport?.type === 'download' && state.selectedReport?.jobId ? state.selectedReport.jobId : job?.id;
    $('downloadExportLink').classList.toggle('disabled', !exportJobId);
    $('downloadExportLink').href = exportJobId ? `/api/jobs/${exportJobId}/export-download.xlsx` : '#';
  }
  if ($('exportImportLink')) {
    const importReport = activeImportReport();
    const exportJobId = importReport?.jobId || job?.id;
    const reportId = importReport?.id || '';
    $('exportImportLink').classList.toggle('disabled', !exportJobId);
    $('exportImportLink').href = exportJobId ? (reportId ? `/api/jobs/${exportJobId}/reports/${reportId}/export-import.xlsx` : `/api/jobs/${exportJobId}/export-import.xlsx`) : '#';
  }
  if ($('tagExportLink')) {
    const tagReport = activeTagReport();
    const exportJobId = tagReport?.jobId || job?.id;
    const reportId = tagReport?.id || '';
    $('tagExportLink').classList.toggle('disabled', !exportJobId);
    $('tagExportLink').href = exportJobId ? (reportId ? `/api/jobs/${exportJobId}/reports/${reportId}/export-tag.xlsx` : `/api/jobs/${exportJobId}/export-tag.xlsx`) : '#';
  }
  updateImportActionButtons();

  renderAssetPreview();
  renderDownloadPreview();
  renderDownloadHistory();
  renderImportPreview();
  renderImportHistory();
  renderTagPreview();
  renderTagHistory();
  renderReportHistory();
  renderReportPreview();
}

function table(rows, cols) {
  if (!rows?.length) return '<p class="muted">No data yet.</p>';
  return `<table><thead><tr>${cols.map(c => `<th>${c.label}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${cols.map(c => `<td>${escapeHtml(String(c.value(r) ?? ''))}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}
function escapeHtml(s){return s.replace(/[&<>"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));}

function renderAssetPreview() {
  const rows = (state.job?.assets || []).slice(0, 12);
  $('assetPreview').innerHTML = table(rows, [
    {label:'Asset URL', value:r=>r.sourceUrl || r.normalizedSourceUrl || r.originalName},
    {label:'Type', value:r=>r.assetType || r.mimeType || 'unknown'},
    {label:'Folder', value:r=>r.folderPath || '/'},
    {label:'Checksum', value:r=>r.checksum || ''},
    {label:'Status', value:r=>r.status},
    {label:'Duplicate Reason', value:r=>r.duplicateReason || ''}
  ]);
}

function currentDownloadSnapshot() {
  return state.selectedReport?.type === 'download' ? state.selectedReport.snapshot || {} : state.job || {};
}

function renderDownloadPreview() {
  if (!$('downloadPreview')) return;
  const snap = currentDownloadSnapshot();
  const rows = (snap.downloadedAssets || []).slice(0, 100);
  $('downloadPreview').innerHTML = table(rows, [
    {label:'Source', value:r=>r.source || ''},
    {label:'Asset Title', value:r=>r.title || ''},
    {label:'Asset ID', value:r=>r.assetId || ''},
    {label:'Asset GUID', value:r=>r.assetGuid || ''},
    {label:'CMP Folder ID', value:r=>r.cmpFolderId || ''},
    {label:'CMP Folder Name', value:r=>r.cmpFolderName || 'Home'},
    {label:'Source URL', value:r=>r.sourceUrl || ''},
    {label:'HTTP', value:r=>r.httpStatus || ''},
    {label:'Local Path', value:r=>r.localRelativePath || r.downloadFolder || ''},
    {label:'Folder', value:r=>r.folderPath || '/'},
    {label:'Type', value:r=>r.assetType || r.contentType || ''},
    {label:'Size', value:r=>r.sizeBytes || ''},
    {label:'Checksum', value:r=>r.checksum || ''},
    {label:'Retries', value:r=>r.retryCount ?? ''},
    {label:'Upload Attempts', value:r=>r.uploadAttempts ?? ''},
    {label:'Token Refreshes', value:r=>r.tokenRefreshCount ?? ''},
    {label:'Upload URL Refreshes', value:r=>r.uploadUrlRefreshCount ?? ''},
    {label:'Last Stage', value:r=>r.lastStage || ''},
    {label:'Status', value:r=>r.status || ''},
    {label:'Error', value:r=>r.error || ''}
  ]);
  if ($('downloadTracePreview')) renderDownloadTrace();
}

function renderDownloadTrace() {
  const snap = currentDownloadSnapshot();
  const events = (snap.downloadHttpEvents || []).slice().reverse().slice(0, 100);
  $('downloadTracePreview').innerHTML = table(events, [
    {label:'Time', value:r=>r.at ? new Date(r.at).toLocaleTimeString() : ''},
    {label:'Phase', value:r=>r.phase || ''},
    {label:'Method', value:r=>r.method || ''},
    {label:'Endpoint', value:r=>r.url || ''},
    {label:'Result', value:r=>r.status || ''},
    {label:'HTTP', value:r=>r.response?.status || ''},
    {label:'Type', value:r=>r.response?.contentType || ''},
    {label:'Length', value:r=>r.response?.contentLength || ''},
    {label:'Error / Preview', value:r=>r.error || r.response?.bodyPreview || ''}
  ]);
}


function currentImportSnapshot() {
  const report = activeImportReport();
  if (report?.snapshot) return report.snapshot;
  return state.job || {};
}

function renderImportPreview() {
  if (!$('importPreview')) return;
  const snap = currentImportSnapshot();
  const rows = (snap.importedAssets || []).slice(0, 120);
  $('importPreview').innerHTML = table(rows, [
    {label:'File Name', value:r=>r.sourceFileName || ''},
    {label:'Relative Path', value:r=>r.relativePath || ''},
    {label:'Source Folder', value:r=>r.sourceFolderPath || '/'},
    {label:'CMP Folder ID', value:r=>r.targetCmpFolderId || ''},
    {label:'CMP Folder', value:r=>r.targetCmpFolderName || ''},
    {label:'CMP Folder Path', value:r=>r.targetCmpFolderPath || '/'},
    {label:'Asset ID', value:r=>r.assetId || ''},
    {label:'Asset GUID', value:r=>r.assetGuid || ''},
    {label:'Type', value:r=>r.assetType || ''},
    {label:'Size', value:r=>r.sizeBytes || ''},
    {label:'Checksum', value:r=>r.checksum || ''},
    {label:'Retries', value:r=>r.retryCount ?? ''},
    {label:'Upload Attempts', value:r=>r.uploadAttempts ?? ''},
    {label:'Token Refreshes', value:r=>r.tokenRefreshCount ?? ''},
    {label:'Upload URL Refreshes', value:r=>r.uploadUrlRefreshCount ?? ''},
    {label:'Last Stage', value:r=>r.lastStage || ''},
    {label:'Status', value:r=>r.status || ''},
    {label:'Error', value:r=>r.error || ''}
  ]);
}

function renderImportHistory() {
  if (!$('importHistory')) return;
  const reports = (state.reportHistory?.length ? state.reportHistory : (state.job?.reports || []).map(r => ({ ...r, jobId: state.job.id, jobName: state.job.name, cmsType: state.job.cmsType }))).filter(r => r.type === 'import');
  if (!reports.length) {
    $('importHistory').innerHTML = '<p class="muted">No import history yet. Run an enterprise folder import to create an import-only report.</p>';
    return;
  }
  $('importHistory').innerHTML = reports.map(r => {
    const active = state.selectedImportReport?.id === r.id ? 'active' : '';
    const uploaded = r.summary?.uploaded ?? r.snapshot?.importSummary?.uploaded ?? '';
    const failed = r.summary?.failed ?? r.snapshot?.importSummary?.failed ?? '';
    return `<div class="historyItem ${active}">
      <button class="historyOpen" data-import-id="${r.id}" data-import-job="${r.jobId || ''}" type="button">
        <b>${escapeHtml(r.title)}</b>
        <span>${new Date(r.createdAt).toLocaleString()} · uploaded=${uploaded} · failed=${failed}</span>
        <small>${escapeHtml(r.jobName || 'Current job')}</small>
      </button>
      <button class="danger" data-import-delete="${r.id}" data-import-job="${r.jobId || ''}" type="button">Delete</button>
    </div>`;
  }).join('');
  document.querySelectorAll('[data-import-id]').forEach(btn => btn.onclick = async () => {
    const report = reports.find(r => r.id === btn.dataset.importId && (!btn.dataset.importJob || r.jobId === btn.dataset.importJob));
    if (!report) return;
    state.selectedImportReport = report;
    if (report.jobId && (!state.job || state.job.id !== report.jobId)) {
      try { state.job = await api(`/api/jobs/${report.jobId}`); }
      catch (e) { log(`Could not open import report job: ${e.message}`, 'error'); }
    }
    renderImportHistory(); renderImportPreview(); refreshStats();
  });
  document.querySelectorAll('[data-import-delete]').forEach(btn => btn.onclick = async () => deleteReport(btn.dataset.importDelete, btn.dataset.importJob));
}


function currentTagSnapshot() {
  const report = activeTagReport();
  if (report?.snapshot) return report.snapshot;
  return state.job || {};
}

function renderTagPreview() {
  if (!$('tagPreview')) return;
  const snap = currentTagSnapshot();
  const execRows = snap.tagExecutionRows || [];
  const dryRows = snap.tagDryRunRows || [];
  const headerRows = snap.tagHeaderRows || [];
  if (execRows.length) {
    $('tagPreview').innerHTML = table(execRows.slice(0, 200), [
      {label:'Asset ID', value:r=>r.assetId || ''},
      {label:'Field / Label', value:r=>r.cmpFieldName || r.header || ''},
      {label:'Type', value:r=>r.cmpFieldType || ''},
      {label:'Value Mode', value:r=>r.valueMode || ''},
      {label:'XLSX Value', value:r=>r.xlsxValue || ''},
      {label:'Payload Values', value:r=>r.payloadValues || ''},
      {label:'Status', value:r=>r.status || ''},
      {label:'Retries', value:r=>r.retryCount ?? ''},
      {label:'Endpoint', value:r=>r.requestEndpoint || ''},
      {label:'Error', value:r=>r.error || ''}
    ]);
    return;
  }
  if (dryRows.length) {
    $('tagPreview').innerHTML = table(dryRows.slice(0, 200), [
      {label:'Asset ID', value:r=>r.assetId || ''},
      {label:'XLSX Header', value:r=>r.header || ''},
      {label:'XLSX Value', value:r=>r.xlsxValue || ''},
      {label:'CMP Status', value:r=>r.cmpMatchStatus || ''},
      {label:'CMP Source', value:r=>r.cmpSource || ''},
      {label:'CMP Field/Label ID', value:r=>r.cmpFieldId || ''},
      {label:'CMP Field/Label Name', value:r=>r.cmpFieldName || ''},
      {label:'Type', value:r=>r.cmpFieldType || ''},
      {label:'Value Mode', value:r=>r.valueMode || ''},
      {label:'Resolved Value IDs', value:r=>r.resolvedValueIds || ''},
      {label:'Resolved Text Values', value:r=>r.resolvedTextValues || ''},
      {label:'Issue', value:r=>r.issue || ''},
      {label:'Recommendation', value:r=>r.recommendation || ''}
    ]) + (headerRows.length ? '<h3>Header mapping</h3>' + table(headerRows.slice(0, 100), [
      {label:'Header', value:r=>r.header || ''},
      {label:'Status', value:r=>r.status || ''},
      {label:'CMP Source', value:r=>r.cmpSource || ''},
      {label:'CMP ID', value:r=>r.cmpFieldId || ''},
      {label:'CMP Name', value:r=>r.cmpFieldName || ''},
      {label:'Type', value:r=>r.cmpFieldType || ''},
      {label:'Issue', value:r=>r.issue || ''}
    ]) : '');
    return;
  }
  $('tagPreview').innerHTML = '<p class="muted">No tag dry run or execution report yet.</p>';
}

function renderTagHistory() {
  if (!$('tagHistory')) return;
  const reports = (state.reportHistory?.length ? state.reportHistory : (state.job?.reports || []).map(r => ({ ...r, jobId: state.job.id, jobName: state.job.name, cmsType: state.job.cmsType }))).filter(r => r.type === 'tag');
  if (!reports.length) {
    $('tagHistory').innerHTML = '<p class="muted">No tag history yet. Upload an XLSX and run Dry Run to create a tag report.</p>';
    return;
  }
  $('tagHistory').innerHTML = reports.map(r => {
    const active = state.selectedTagReport?.id === r.id ? 'active' : '';
    const summary = r.summary || r.snapshot?.tagSummary || {};
    const ready = summary.readyUpdates ?? summary.updated ?? '';
    const issues = Number(summary.missingHeaders || 0) + Number(summary.invalidValues || 0) + Number(summary.failed || 0);
    return `<div class="historyItem ${active}">
      <button class="historyOpen" data-tag-id="${r.id}" data-tag-job="${r.jobId || ''}" type="button">
        <b>${escapeHtml(r.title)}</b>
        <span>${new Date(r.createdAt).toLocaleString()} · ready/updated=${ready} · issues=${issues}</span>
        <small>${escapeHtml(r.jobName || 'Current job')} · ${escapeHtml(summary.status || '')}</small>
      </button>
      <button class="danger" data-tag-delete="${r.id}" data-tag-job="${r.jobId || ''}" type="button">Delete</button>
    </div>`;
  }).join('');
  document.querySelectorAll('[data-tag-id]').forEach(btn => btn.onclick = async () => {
    const report = reports.find(r => r.id === btn.dataset.tagId && (!btn.dataset.tagJob || r.jobId === btn.dataset.tagJob));
    if (!report) return;
    state.selectedTagReport = report;
    if (report.jobId && (!state.job || state.job.id !== report.jobId)) {
      try { state.job = await api(`/api/jobs/${report.jobId}`); }
      catch (e) { log(`Could not open tag report job: ${e.message}`, 'error'); }
    }
    renderTagHistory(); renderTagPreview(); refreshStats();
  });
  document.querySelectorAll('[data-tag-delete]').forEach(btn => btn.onclick = async () => deleteReport(btn.dataset.tagDelete, btn.dataset.tagJob));
}


function renderReportPreview() {
  const snap = latestSnapshot();
  $('selectedReportTitle').textContent = state.selectedReport ? `${state.selectedReport.title}` : 'Latest report preview';
  if (state.selectedReport?.type === 'download' || (snap.downloadedAssets || []).length) {
    const rows = (snap.downloadedAssets || state.job?.downloadedAssets || []).slice(0, 80);
    const traceRows = (snap.downloadHttpEvents || state.job?.downloadHttpEvents || []).slice().reverse().slice(0, 50);
    $('reportPreview').innerHTML = table(rows, [
      {label:'Source', value:r=>r.source || ''},
      {label:'Asset Title', value:r=>r.title || ''},
      {label:'Asset ID', value:r=>r.assetId || ''},
      {label:'Asset GUID', value:r=>r.assetGuid || ''},
      {label:'CMP Folder ID', value:r=>r.cmpFolderId || ''},
      {label:'Source URL', value:r=>r.sourceUrl || ''},
      {label:'HTTP', value:r=>r.httpStatus || ''},
      {label:'Local Path', value:r=>r.localRelativePath || r.downloadFolder || ''},
      {label:'Folder', value:r=>r.folderPath || '/'},
      {label:'Checksum', value:r=>r.checksum || ''},
      {label:'Retries', value:r=>r.retryCount ?? ''},
      {label:'Status', value:r=>r.status || ''},
      {label:'Error', value:r=>r.error || ''}
    ]) + '<h3>HTTP trace</h3>' + table(traceRows, [
      {label:'Time', value:r=>r.at ? new Date(r.at).toLocaleTimeString() : ''},
      {label:'Phase', value:r=>r.phase || ''},
      {label:'Method', value:r=>r.method || ''},
      {label:'Endpoint', value:r=>r.url || ''},
      {label:'Result', value:r=>r.status || ''},
      {label:'HTTP', value:r=>r.response?.status || ''},
      {label:'Error / Preview', value:r=>r.error || r.response?.bodyPreview || ''}
    ]);
    return;
  }
  const rows = (snap.assetReferences || state.job?.assetReferences || []).slice(0, 20);
  $('reportPreview').innerHTML = table(rows, [
    {label:'Page Title', value:r=>r.pageTitle || ''},
    {label:'Page URL', value:r=>r.pageUrl || ''},
    {label:'Asset Link', value:r=>r.absoluteUrl || r.sourceUrl || ''},
    {label:'Asset Type', value:r=>r.assetType || ''},
    {label:'Folder', value:r=>r.folderPath || '/'},
    {label:'Status', value:r=>r.status || 'DISCOVERED'}
  ]);
}


function renderDownloadHistory() {
  if (!$('downloadHistory')) return;
  const reports = (state.reportHistory?.length ? state.reportHistory : (state.job?.reports || []).map(r => ({ ...r, jobId: state.job.id, jobName: state.job.name, cmsType: state.job.cmsType }))).filter(r => r.type === 'download');
  if (!reports.length) {
    $('downloadHistory').innerHTML = '<p class="muted">No download history yet. Run Option A or Option B to create a download report.</p>';
    return;
  }
  const latestByJobAndType = new Map();
  reports.forEach(r => {
    const key = `${r.jobId || 'current'}:${r.type}`;
    if (!latestByJobAndType.has(key)) latestByJobAndType.set(key, r.id);
  });
  $('downloadHistory').innerHTML = reports.map(r => {
    const locked = latestByJobAndType.get(`${r.jobId || 'current'}:${r.type}`) === r.id;
    const active = state.selectedReport?.id === r.id ? 'active' : '';
    const downloaded = r.summary?.downloaded ?? r.snapshot?.downloadSummary?.downloaded ?? '';
    const failed = r.summary?.failed ?? r.snapshot?.downloadSummary?.failed ?? '';
    return `<div class="historyItem ${active}">
      <button class="historyOpen" data-download-id="${r.id}" data-download-job="${r.jobId || ''}" type="button">
        <b>${escapeHtml(r.title)}</b>
        <span>${new Date(r.createdAt).toLocaleString()} · downloaded=${downloaded} · failed=${failed}</span>
        <small>${escapeHtml(r.jobName || 'Current job')} · ${escapeHtml(r.summary?.source || r.snapshot?.downloadSummary?.source || '')}</small>
      </button>
      <button class="danger" data-download-delete="${r.id}" data-download-job="${r.jobId || ''}" ${locked ? 'disabled title="Latest download report for this job is retained"' : ''} type="button">Delete</button>
    </div>`;
  }).join('');
  document.querySelectorAll('[data-download-id]').forEach(btn => btn.onclick = async () => {
    const report = reports.find(r => r.id === btn.dataset.downloadId && (!btn.dataset.downloadJob || r.jobId === btn.dataset.downloadJob));
    if (!report) return;
    state.selectedReport = report;
    if (report.jobId && (!state.job || state.job.id !== report.jobId)) {
      try { state.job = await api(`/api/jobs/${report.jobId}`); }
      catch (e) { log(`Could not open download report job: ${e.message}`, 'error'); }
    }
    renderDownloadHistory(); renderDownloadPreview(); refreshStats();
  });
  document.querySelectorAll('[data-download-delete]').forEach(btn => btn.onclick = async () => deleteReport(btn.dataset.downloadDelete, btn.dataset.downloadJob));
}

function renderReportHistory() {
  const reports = (state.reportHistory?.length ? state.reportHistory : (state.job?.reports || []).map(r => ({ ...r, jobId: state.job.id, jobName: state.job.name, cmsType: state.job.cmsType }))).filter(r => r.type !== 'download' && r.type !== 'import' && r.type !== 'tag');
  if (!$('reportHistory')) return;
  if (!reports.length) {
    $('reportHistory').innerHTML = '<p class="muted">No scan/migration history yet. Download, Import, and Tag histories are available inside their own tabs.</p>';
    return;
  }

  const latestByJobAndType = new Map();
  reports.forEach(r => {
    const key = `${r.jobId || 'current'}:${r.type}`;
    if (!latestByJobAndType.has(key)) latestByJobAndType.set(key, r.id);
  });

  $('reportHistory').innerHTML = reports.map(r => {
    const locked = latestByJobAndType.get(`${r.jobId || 'current'}:${r.type}`) === r.id;
    const active = state.selectedReport?.id === r.id ? 'active' : '';
    return `<div class="historyItem ${active}">
      <button class="historyOpen" data-id="${r.id}" data-job="${r.jobId || ''}" type="button">
        <b>${escapeHtml(r.title)}</b>
        <span>${escapeHtml(r.type.toUpperCase())} · ${new Date(r.createdAt).toLocaleString()}</span>
        <small>${escapeHtml(r.jobName || 'Current job')} · ${escapeHtml(r.cmsType || '')}</small>
      </button>
      <button class="danger" data-delete="${r.id}" data-job="${r.jobId || ''}" ${locked ? 'disabled title="Latest report for this operation is retained"' : ''} type="button">Delete</button>
    </div>`;
  }).join('');

  document.querySelectorAll('[data-id]').forEach(btn => btn.onclick = async () => {
    const report = reports.find(r => r.id === btn.dataset.id && (!btn.dataset.job || r.jobId === btn.dataset.job));
    if (!report) return;
    state.selectedReport = report;
    if (report.jobId && (!state.job || state.job.id !== report.jobId)) {
      try { state.job = await api(`/api/jobs/${report.jobId}`); }
      catch (e) { log(`Could not open report job: ${e.message}`, 'error'); }
    }
    renderReportHistory(); renderReportPreview(); refreshStats();
  });
  document.querySelectorAll('[data-delete]').forEach(btn => btn.onclick = async () => deleteReport(btn.dataset.delete, btn.dataset.job));
}

async function deleteReport(reportId, jobId) {
  if (!reportId) return;
  const activeJobId = jobId || state.job?.id;
  if (!activeJobId) return;
  try {
    state.reportHistory = await api(`/api/reports/${activeJobId}/${reportId}`, { method: 'DELETE' });
    if (state.job?.id === activeJobId) state.job.reports = state.reportHistory.filter(r => r.jobId === activeJobId);
    if (state.selectedReport?.id === reportId) state.selectedReport = null;
    if (state.selectedImportReport?.id === reportId) state.selectedImportReport = null;
    if (state.selectedTagReport?.id === reportId) state.selectedTagReport = null;
    log('Historical report deleted. Latest operation reports and latest stats are retained.');
    await loadReportHistory(false);
    refreshStats();
  } catch (e) { log(`Delete report error: ${e.message}`, 'error'); }
}

async function reloadJob(jobId = null) {
  const id = jobId || state.job?.id;
  if (!id) return;
  const latest = await api(`/api/jobs/${id}`);
  // Avoid stale polling overwriting a newer active operation.
  if (state.job?.id && state.job.id !== id) return;
  state.job = latest;
  await loadReportHistory(false);
  refreshStats();
}

async function loadReportHistory(render = true) {
  try {
    state.reportHistory = await api('/api/reports');
    hydrateLatestImportReport();
    if (render) { renderReportHistory(); renderDownloadHistory(); renderImportHistory(); renderImportPreview(); renderTagHistory(); renderTagPreview(); }
  } catch (e) {
    log(`Report history load error: ${e.message}`, 'error');
  }
}

function operationRunning() {
  return ['SCANNING','IMPORTING','IMPORT_STOP_REQUESTED','MIGRATING','DOWNLOADING_ASSETS','TAG_DRY_RUNNING','TAGGING_METADATA'].includes(state.job?.status);
}

function stopPolling() {
  if (state.pollTimer) clearTimeout(state.pollTimer);
  state.pollTimer = null;
}

function shouldPollConsole() {
  if (!state.job || state.pollingPaused) return false;
  return state.tab === 'console' || operationRunning() || state.waitingOperation;
}

async function pollNow({ manual = false } = {}) {
  if (!state.job) return false;
  const pollJobId = state.job.id;
  if (document.hidden && !operationRunning() && !manual) return false;
  try {
    const data = await api(`/api/jobs/${pollJobId}/logs`);
    // If a new operation started while this request was in flight, ignore stale logs.
    if (state.job?.id !== pollJobId) return true;
    state.pollFailures = 0;
    state.lastPollError = '';
    state.pollingPaused = false;
    (data.logs || []).forEach(l => log(l.message, l.level, l.at, l.id));
    await reloadJob(pollJobId);
    return true;
  } catch (e) {
    state.pollFailures += 1;
    const message = e?.message || 'Failed to fetch';

    // A 404 means the browser is holding an old/stale job id. Only clear the active
    // job if it is still the same job that produced the 404. This prevents an old
    // polling request from wiping out a newly-created import job.
    if (e?.status === 404) {
      // During very large imports the backend may briefly be unable to read the
      // persisted job while it is writing heavy checkpoints/logs. Do not clear an
      // active import job immediately; keep polling for a while so the UI does
      // not falsely stop around folder 1000+.
      const activeLongOperation = operationRunning() || state.waitingOperation;
      if (activeLongOperation && state.pollFailures < 30) {
        if (message !== state.lastPollError) {
          log(`Console polling warning: job ${pollJobId || ''} was temporarily unavailable. Continuing because an operation is active.`, 'warn');
          state.lastPollError = message;
        }
        return false;
      }
      if (state.job?.id === pollJobId) {
        stopPolling();
        state.pollingPaused = true;
        state.job = null;
        refreshStats();
      }
      if (message !== state.lastPollError) {
        log(`Console polling stopped because job ${pollJobId || ''} no longer exists. Start or select a new operation.`, 'warn');
        state.lastPollError = message;
      }
      return false;
    }

    const isConnectionFailure = /Failed to fetch|NetworkError|ERR_CONNECTION|Load failed|fetch/i.test(message);

    if (message !== state.lastPollError) {
      log(`Console polling warning: ${message}`, 'warn');
      state.lastPollError = message;
    }

    if (isConnectionFailure && state.pollFailures >= 3) {
      state.pollingPaused = true;
      stopPolling();
      log('Console polling paused because the backend is unavailable. Restart Docker and refresh the browser to resume.', 'warn');
    }
    return false;
  }
}

function startPolling() {
  stopPolling();
  if (!shouldPollConsole()) return;
  const delay = operationRunning() || state.waitingOperation ? 2000 : 5000;
  state.pollTimer = setTimeout(async () => {
    await pollNow();
    startPolling();
  }, delay);
}

async function waitForOperation(doneStatuses = ['SCANNED','IMPORTED','MIGRATED','FAILED']) {
  setBusy(true);
  state.waitingOperation = true;
  setTab('console');
  stopPolling();
  while (state.job && !doneStatuses.includes(state.job.status)) {
    await new Promise(r => setTimeout(r, 2000));
    const ok = await pollNow();
    updateImportActionButtons();
    if (!ok && state.pollingPaused) break;
  }
  state.waitingOperation = false;
  if (!state.pollingPaused) await loadReportHistory(false);
  refreshStats();
  setBusy(false);
  startPolling();
}

async function createAndScan() {
  const config = getConfig();
  if (config.scanMode === 'target' && !config.targetPageUrl) return log('Target page URL is required.', 'error');
  if (config.scanMode !== 'target' && !config.baseUrl) return log('Live Base URL is required.', 'error');
  setBusy(true);
  try {
    log('Creating migration job.');
    let created = await api('/api/jobs', { method: 'POST', body: JSON.stringify({ name: `${state.cmsType.toUpperCase()} to CMP DAM`, cmsType: state.cmsType, config }) });
    state.job = created; state.pollFailures = 0; state.pollingPaused = false; refreshStats(); startPolling();
    log(`Starting ${config.scanMode} scan${config.scanMode === 'test' ? `, limited to ${config.testPageCount} page(s)` : ''}.`);
    state.job = await api(`/api/jobs/${created.id}/scan`, { method: 'POST' });
    refreshStats();
    await waitForOperation(['SCANNED','FAILED']);
    if (state.job.status === 'SCANNED') { await loadReportHistory(false); setTab('migrate'); }
  } catch (e) { log(`Error: ${e.message}`, 'error'); }
  finally { setBusy(false); }
}


async function ensureJobForDownload() {
  if (state.job) return state.job;
  log('Creating download-only job.');
  state.job = await api('/api/jobs', { method: 'POST', body: JSON.stringify({ name: 'Asset download operation', cmsType: state.cmsType || 'download', config: { operation: 'download-only' } }) });
  state.pollFailures = 0; state.pollingPaused = false; refreshStats(); startPolling();
  return state.job;
}

async function downloadFromXlsx() {
  const xlsxUrl = $('downloadXlsxUrl').value.trim();
  if (!xlsxUrl) return log('XLSX public link is required.', 'error');
  setBusy(true);
  try {
    const job = await ensureJobForDownload();
    log('Starting asset download from XLSX manifest.');
    state.job = await api(`/api/jobs/${job.id}/download/xlsx-link`, { method: 'POST', body: JSON.stringify({ xlsxUrl }) });
    refreshStats(); await waitForOperation(['ASSETS_DOWNLOADED','ASSETS_ANALYZED','FAILED']);
    if (['ASSETS_DOWNLOADED','ASSETS_ANALYZED'].includes(state.job.status)) { state.selectedReport = null; await loadReportHistory(false); setTab('download'); }
  } catch (e) { log(`Download from XLSX error: ${e.message}`, 'error'); }
  finally { setBusy(false); }
}

async function downloadFromCmp() {
  const clientId = $('cmpClientId').value.trim();
  const clientSecret = $('cmpClientSecret').value.trim();
  const scope = getCmpDownloadScope();
  const folderId = $('cmpFolderId').value.trim();
  if (!clientId || !clientSecret) return log('CMP Client ID and Client Secret are required.', 'error');
  if (scope === 'folder' && !folderId && !$('cmpAssetIds').value.trim()) return log('Folder ID is required unless All Assets or explicit Asset IDs are provided.', 'error');
  setBusy(true);
  try {
    const job = await ensureJobForDownload();
    const body = {
      clientId,
      clientSecret,
      apiBaseUrl: $('cmpApiBaseUrl').value.trim() || 'https://api.cmp.optimizely.com/v3',
      tokenUrl: $('cmpTokenUrl').value.trim() || 'https://accounts.cmp.optimizely.com/o/oauth2/v1/token',
      folderId: scope === 'folder' ? folderId : '',
      downloadAll: scope === 'all',
      includeSubfolders: $('cmpIncludeSubfolders').checked,
      searchText: $('cmpSearchText').value.trim(),
      assetIds: $('cmpAssetIds').value,
      operationMode: $('cmpAssetOperation')?.value || 'download-assets',
      assetTypes: ['article','image','video','raw_file','structured_content']
    };
    const mode = $('cmpAssetOperation')?.value || 'download-assets';
    log(`${mode}: ${scope === 'all' ? 'CMP DAM All Assets / Analyze All using paginated asset listing.' : 'CMP DAM folder operation with folder-aware discovery.'}`);
    state.job = await api(`/api/jobs/${job.id}/download/cmp`, { method: 'POST', body: JSON.stringify(body) });
    refreshStats(); await waitForOperation(['ASSETS_DOWNLOADED','ASSETS_ANALYZED','FAILED']);
    if (['ASSETS_DOWNLOADED','ASSETS_ANALYZED'].includes(state.job.status)) { state.selectedReport = null; await loadReportHistory(false); setTab('download'); }
  } catch (e) { log(`CMP download error: ${e.message}`, 'error'); }
  finally { setBusy(false); }
}

async function importXlsx() {
  if (!state.job) return log('Create and scan a job first.', 'error');
  const xlsxUrl = $('xlsxUrl').value.trim();
  if (!xlsxUrl) return log('XLSX URL is required.', 'error');
  setBusy(true);
  try {
    state.job = await api(`/api/jobs/${state.job.id}/import/xlsx-link`, { method: 'POST', body: JSON.stringify({ xlsxUrl }) });
    refreshStats(); await waitForOperation(['IMPORTED','SCANNED','MIGRATED','FAILED']);
  } catch (e) { log(`XLSX error: ${e.message}`, 'error'); }
  finally { setBusy(false); }
}

function getFileRelativePath(file) {
  return file._relativePath || file.webkitRelativePath || file.name;
}

const ignoredImportFileNames = new Set(['.DS_Store', 'Thumbs.db', 'thumbs.db', 'Desktop.ini', 'desktop.ini']);
const ignoredImportFolderNames = new Set(['__MACOSX', '.Spotlight-V100', '.Trashes', '.fseventsd']);
function isIgnoredImportPath(value = '') {
  const parts = String(value || '').replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.some(part => ignoredImportFolderNames.has(part) || ignoredImportFileNames.has(part) || part.startsWith('._'));
}

function setSelectedFolderFiles(files, source = 'Folder selection') {
  const incoming = Array.from(files || []);
  const ignored = incoming.filter(file => isIgnoredImportPath(getFileRelativePath(file)));
  state.selectedFolderFiles = incoming.filter(file => !isIgnoredImportPath(getFileRelativePath(file)));
  const selected = state.selectedFolderFiles;
  const folders = new Set(selected.map(f => getFileRelativePath(f).split('/').slice(0, -1).join('/')).filter(Boolean));
  const countText = selected.length ? `${selected.length} file(s) selected` : 'No files selected';
  if ($('folderInputCount')) $('folderInputCount').textContent = countText;
  if ($('folderSelectionSummary')) $('folderSelectionSummary').textContent = selected.length ? `${selected.length} file(s) selected across ${folders.size} folder path(s).` : 'No folder selected yet.';
  if ($('importDropHint') && selected.length) {
    $('importDropHint').classList.add('drop-complete');
    const strong = $('importDropHint').querySelector('strong');
    const span = $('importDropHint').querySelector('span');
    if (strong) strong.textContent = `${selected.length} file(s) captured`;
    if (span) span.textContent = `${folders.size} folder path(s) detected. You can now start the CMP folder import.`;
  }
  log(selected.length ? `${source} captured: ${selected.length} file(s), ${folders.size} folder path(s).${ignored.length ? ` Excluded ${ignored.length} OS hidden/system file(s).` : ''}` : (ignored.length ? `${source} did not include importable files. Excluded ${ignored.length} OS hidden/system file(s).` : 'Folder selection cleared.'));
}

function handleFolderSelection(event) {
  setSelectedFolderFiles(Array.from(event.target.files || []), 'Folder selection');
}

function withRelativePath(file, relativePath) {
  try { Object.defineProperty(file, '_relativePath', { value: relativePath || file.name, configurable: true }); } catch (_) { file._relativePath = relativePath || file.name; }
  return file;
}

function readEntryFile(entry) {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function readDirectoryEntries(reader) {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

async function traverseDroppedEntry(entry, parentPath = '') {
  if (!entry) return [];
  const cleanName = (entry.name || '').replace(/^\/+|\/+$/g, '');
  const currentPath = parentPath ? `${parentPath}/${cleanName}` : cleanName;
  if (entry.isFile) {
    const file = await readEntryFile(entry);
    return [withRelativePath(file, currentPath || file.name)];
  }
  if (entry.isDirectory) {
    const reader = entry.createReader();
    const all = [];
    while (true) {
      const batch = await readDirectoryEntries(reader);
      if (!batch.length) break;
      for (const child of batch) all.push(...await traverseDroppedEntry(child, currentPath));
    }
    return all;
  }
  return [];
}

async function filesFromDropEvent(event) {
  const items = Array.from(event.dataTransfer?.items || []);
  const entries = items.map(item => item.webkitGetAsEntry ? item.webkitGetAsEntry() : null).filter(Boolean);
  if (entries.length) {
    const out = [];
    for (const entry of entries) out.push(...await traverseDroppedEntry(entry));
    return out;
  }
  return Array.from(event.dataTransfer?.files || []).map(f => withRelativePath(f, f.name));
}

function setupImportDropZone() {
  const zone = $('importDropZone');
  if (!zone) return;
  let dragDepth = 0;
  ['dragenter','dragover'].forEach(evt => zone.addEventListener(evt, e => { e.preventDefault(); e.stopPropagation(); if (evt === 'dragenter') dragDepth += 1; zone.classList.add('drag-over'); }));
  zone.addEventListener('dragleave', e => { e.preventDefault(); e.stopPropagation(); dragDepth = Math.max(0, dragDepth - 1); if (dragDepth === 0) zone.classList.remove('drag-over'); });
  zone.addEventListener('drop', async e => {
    e.preventDefault(); e.stopPropagation(); dragDepth = 0; zone.classList.remove('drag-over');
    try {
      if ($('folderSelectionSummary')) $('folderSelectionSummary').textContent = 'Reading dropped folder structure...';
      const files = await filesFromDropEvent(e);
      setSelectedFolderFiles(files, 'Drag-and-drop folder');
    } catch (err) {
      log(`Drag-and-drop error: ${err.message}`, 'error');
      if ($('folderSelectionSummary')) $('folderSelectionSummary').textContent = 'Could not read dropped folder. Use folder picker instead.';
    }
  });
}

async function createImportJob() {
  log('Creating import-only job.');
  stopPolling();
  state.pollFailures = 0;
  state.pollingPaused = false;
  state.waitingOperation = false;
  state.job = await api('/api/jobs', { method: 'POST', body: JSON.stringify({ name: 'Enterprise CMP folder import', cmsType: 'cmp-dam', config: { operation: 'enterprise-import' } }) });
  refreshStats();
  startPolling();
  return state.job;
}

async function ensureImportJob() {
  if (state.job) {
    try {
      await api(`/api/jobs/${state.job.id}`);
      return state.job;
    } catch (e) {
      if (e?.status !== 404) throw e;
      log(`Active job ${state.job.id} no longer exists. Creating a new import-only job.`, 'warn');
      state.job = null;
    }
  }
  return createImportJob();
}

function importOptions() {
  return {
    clientId: $('importCmpClientId')?.value.trim() || '',
    clientSecret: $('importCmpClientSecret')?.value.trim() || '',
    apiBaseUrl: $('importCmpApiBaseUrl')?.value.trim() || 'https://api.cmp.optimizely.com/v3',
    tokenUrl: $('importCmpTokenUrl')?.value.trim() || 'https://accounts.cmp.optimizely.com/o/oauth2/v1/token',
    parentFolderId: $('importParentFolderId')?.value.trim() || '',
    concurrency: $('importConcurrency')?.value || '10',
    retryCount: $('importRetryCount')?.value || '3',
    reuseExistingFolders: $('importReuseFolders')?.checked ? 'true' : 'false'
  };
}

async function startFolderImport() {
  const files = state.selectedFolderFiles || [];
  if (!files.length) return log('Select a local folder first.', 'error');
  const opts = importOptions();
  ['importCmpClientId','importCmpClientSecret'].forEach(id => $(id)?.classList.remove('inputError'));
  if (!opts.clientId || !opts.clientSecret) {
    if (!opts.clientId) $('importCmpClientId')?.classList.add('inputError');
    if (!opts.clientSecret) $('importCmpClientSecret')?.classList.add('inputError');
    const acc = $('importConfigAccordion'); if (acc) acc.open = true;
    return log('CMP Client ID and Client Secret are required for Import & Migrate.', 'error');
  }
  setBusy(true);
  try {
    // A new folder import always gets an isolated import-only job.
    const job = await createImportJob();
    const form = new FormData();
    Object.entries(opts).forEach(([k,v]) => form.append(k, v));
    const relativePaths = files.map(file => getFileRelativePath(file));
    form.append('relativePaths', JSON.stringify(relativePaths));
    files.forEach((file, index) => {
      const rel = relativePaths[index] || file.name;
      form.append('assets', file, rel);
    });
    log(`Starting enterprise CMP folder import with ${files.length} file(s), ${new Set(relativePaths.map(p => p.split('/').slice(0, -1).join('/')).filter(Boolean)).size} folder path(s), parallel uploads=${opts.concurrency}.`);
    const res = await fetch(`/api/jobs/${job.id}/import/folder`, { method: 'POST', body: form });
    if (!res.ok) throw new Error(await res.text());
    state.job = await res.json();
    refreshStats(); const acc = $('importConfigAccordion'); if (acc) acc.open = false; await waitForOperation(['IMPORTED','IMPORT_INCOMPLETE','IMPORT_STOPPED','FAILED']);
    state.selectedImportReport = null; await loadReportHistory(true); setTab('migrate');
  } catch (e) { log(`Enterprise folder import error: ${e.message}`, 'error'); }
  finally { setBusy(false); }
}

async function resumeImport(retryFailedOnly = false) {
  let targetJobId = state.job?.id || activeImportReport()?.jobId;
  if (!targetJobId) return log('No import job/checkpoint is available to resume.', 'error');
  setBusy(true);
  try {
    if (!state.job || state.job.id !== targetJobId) state.job = await api(`/api/jobs/${targetJobId}`);
    const opts = importOptions();
    state.importStopping = false;
    log(retryFailedOnly ? 'Retrying failed import items from checkpoint.' : 'Resuming previous import from checkpoint.');
    state.job = await api(`/api/jobs/${targetJobId}/import/resume`, { method: 'POST', body: JSON.stringify({ ...opts, retryFailedOnly }) });
    refreshStats(); await waitForOperation(['IMPORTED','IMPORT_INCOMPLETE','IMPORT_STOPPED','FAILED']);
    state.selectedImportReport = null; await loadReportHistory(true); setTab('migrate');
  } catch (e) { log(`Import resume error: ${e.message}`, 'error'); }
  finally { setBusy(false); state.importStopping = false; updateImportActionButtons(); }
}

async function stopImport() {
  if (!state.job?.id) return log('No active import job to stop.', 'warn');
  state.importStopping = true;
  updateImportActionButtons();
  try {
    const res = await api(`/api/jobs/${state.job.id}/import/stop`, { method: 'POST', body: JSON.stringify({}) });
    state.job = res;
    log('Stop requested by user. The importer will finish the current active request and checkpoint progress.', 'warn');
    refreshStats();
  } catch (e) {
    log(`Stop import error: ${e.message}`, 'error');
  } finally {
    startPolling();
  }
}


function tagOptions() {
  return {
    clientId: $('tagCmpClientId')?.value.trim() || '',
    clientSecret: $('tagCmpClientSecret')?.value.trim() || '',
    apiBaseUrl: $('tagCmpApiBaseUrl')?.value.trim() || 'https://api.cmp.optimizely.com/v3',
    tokenUrl: $('tagCmpTokenUrl')?.value.trim() || 'https://accounts.cmp.optimizely.com/o/oauth2/v1/token',
    concurrency: $('tagConcurrency')?.value || '5',
    retryCount: $('tagRetryCount')?.value || '3'
  };
}
function updateTagXlsxUi() {
  const file = state.selectedTagXlsxFile;
  if ($('tagXlsxCount')) $('tagXlsxCount').textContent = file ? file.name : 'No XLSX selected';
  if ($('tagClearXlsxBtn')) $('tagClearXlsxBtn').classList.toggle('hidden', !file);
  if ($('tagXlsxHelp')) {
    $('tagXlsxHelp').textContent = file
      ? `Selected: ${file.name}. Remove it before uploading a corrected XLSX.`
      : 'Dry Run uses the currently selected XLSX only. If a dry run fails, remove the file, fix the spreadsheet, and upload the corrected XLSX.';
  }
}
function handleTagXlsxSelection(event) {
  const file = Array.from(event.target.files || [])[0] || null;
  state.selectedTagXlsxFile = file;
  // A newly selected XLSX should be treated as a new dry-run input. Keep history, but clear the active tag report preview.
  state.selectedTagReport = null;
  updateTagXlsxUi();
}
function clearTagXlsxSelection() {
  state.selectedTagXlsxFile = null;
  if ($('tagXlsxInput')) $('tagXlsxInput').value = '';
  state.selectedTagReport = null;
  updateTagXlsxUi();
  renderTagPreview();
  refreshStats();
  log('Removed selected Tag Assets Metadata XLSX. Upload the corrected spreadsheet and run Dry Run again.');
}
async function ensureTagJob() {
  if (state.job && state.job.cmsType === 'cmp-dam-tag') return state.job;
  log('Creating Tag Assets Metadata job.');
  stopPolling();
  state.job = await api('/api/jobs', { method: 'POST', body: JSON.stringify({ name: 'Tag Assets Metadata', cmsType: 'cmp-dam-tag', config: { operation: 'tag-assets-metadata' } }) });
  state.pollFailures = 0; state.pollingPaused = false; refreshStats(); startPolling();
  return state.job;
}
function validateTagInputs(requireFile = true) {
  const opts = tagOptions();
  ['tagCmpClientId','tagCmpClientSecret'].forEach(id => $(id)?.classList.remove('inputError'));
  if (!opts.clientId || !opts.clientSecret) {
    if (!opts.clientId) $('tagCmpClientId')?.classList.add('inputError');
    if (!opts.clientSecret) $('tagCmpClientSecret')?.classList.add('inputError');
    log('CMP Client ID and Client Secret are required for Tag Assets Metadata.', 'error');
    return null;
  }
  if (requireFile && !state.selectedTagXlsxFile) {
    log('Choose an XLSX file before running Dry Run.', 'error');
    return null;
  }
  return opts;
}
async function tagDryRun() {
  const opts = validateTagInputs(true);
  if (!opts) return;
  setBusy(true);
  try {
    const job = await ensureTagJob();
    const form = new FormData();
    Object.entries(opts).forEach(([k,v]) => form.append(k, v));
    form.append('xlsx', state.selectedTagXlsxFile, state.selectedTagXlsxFile.name);
    log(`Starting Tag Assets Metadata dry run using ${state.selectedTagXlsxFile.name}.`);
    const res = await fetch(`/api/jobs/${job.id}/tag/dry-run`, { method: 'POST', body: form });
    if (!res.ok) throw new Error(await res.text());
    state.job = await res.json();
    refreshStats(); await waitForOperation(['DRY_RUN_READY','DRY_RUN_ISSUES','FAILED']);
    state.selectedTagReport = null; await loadReportHistory(true); setTab('tag');
  } catch (e) { log(`Tag dry run error: ${e.message}`, 'error'); }
  finally { setBusy(false); }
}
async function tagExecute() {
  const opts = validateTagInputs(false);
  if (!opts) return;
  const targetJobId = state.job?.id || activeTagReport()?.jobId;
  if (!targetJobId) return log('Run Dry Run first before Execute.', 'error');
  setBusy(true);
  try {
    if (!state.job || state.job.id !== targetJobId) state.job = await api(`/api/jobs/${targetJobId}`);
    log('Starting Tag Assets Metadata execution. Only validated dry-run rows will be updated.');
    state.job = await api(`/api/jobs/${targetJobId}/tag/execute`, { method: 'POST', body: JSON.stringify(opts) });
    refreshStats(); await waitForOperation(['TAG_EXECUTED','TAG_EXECUTION_INCOMPLETE','FAILED']);
    state.selectedTagReport = null; await loadReportHistory(true); setTab('tag');
  } catch (e) { log(`Tag execution error: ${e.message}`, 'error'); }
  finally { setBusy(false); }
}


async function migrate() {
  if (!state.job) return log('Create and scan a job first.', 'error');
  setBusy(true);
  try {
    log('Starting migration pipeline.');
    state.job = await api(`/api/jobs/${state.job.id}/migrate`, { method: 'POST', body: JSON.stringify({}) });
    refreshStats(); await waitForOperation(['MIGRATED','FAILED']);
    if (state.job.status === 'MIGRATED') { await loadReportHistory(false); setTab('reports'); }
  } catch (e) { log(`Migration error: ${e.message}`, 'error'); }
  finally { setBusy(false); }
}

window.addEventListener('beforeunload', stopPolling);
document.addEventListener('visibilitychange', () => { if (document.hidden && !operationRunning()) stopPolling(); else startPolling(); });

window.addEventListener('DOMContentLoaded', () => {
  ['scan','download','migrate','tag','reports','console'].forEach(t => on(`tab-${t}`, 'click', () => setTab(t)));
  on('cmsType', 'change', updateCmsFields);
  ['modeTest','modeFull','modeTarget'].forEach(id => on(id, 'change', e => { if (e.target.checked) setScanMode(id.replace('mode','').toLowerCase()); else e.target.checked = true; }));
  on('testPageCount', 'input', updateScanMode);
  on('aiProvider', 'change', updateAiModels);
  on('scanBtn', 'click', createAndScan);
  on('downloadOption', 'change', updateDownloadOption);
  on('cmpAssetOperation', 'change', updateCmpOperationMode);
  ['cmpDownloadByFolder','cmpDownloadAll'].forEach(id => on(id, 'change', updateCmpDownloadScope));
  on('downloadXlsxBtn', 'click', downloadFromXlsx);
  on('downloadCmpBtn', 'click', downloadFromCmp);
  on('importXlsxBtn', 'click', importXlsx);
  on('folderInput', 'change', handleFolderSelection);
  on('startFolderImportBtn', 'click', startFolderImport);
  on('stopImportBtn', 'click', stopImport);
  on('resumeImportBtn', 'click', () => resumeImport(false));
  on('tagXlsxInput', 'change', handleTagXlsxSelection);
  on('tagClearXlsxBtn', 'click', clearTagXlsxSelection);
  on('tagDryRunBtn', 'click', tagDryRun);
  on('tagExecuteBtn', 'click', tagExecute);
  on('refreshTagHistoryBtn', 'click', async () => { await loadReportHistory(); renderTagHistory(); renderTagPreview(); });
  on('retryFailedImportBtn', 'click', () => resumeImport(true));
  on('migrateBtn', 'click', migrate);
  on('refreshHistoryBtn', 'click', async () => { await loadReportHistory(); if (state.job) await reloadJob(); });
  on('refreshDownloadHistoryBtn', 'click', async () => { await loadReportHistory(); if (state.job) await reloadJob(); renderDownloadHistory(); });
  on('clearConsoleBtn', 'click', () => { const logEl = $('log'); if (logEl) logEl.innerHTML = ''; state.logsSeen.clear(); state.lastPollError = ''; });
  log('Ready. Create a job, scan a live domain, download assets from XLSX or CMP DAM, import optional assets, then migrate.');
  updateAiModels(); updateCmsFields(); updateScanMode(); updateDownloadOption(); updateCmpDownloadScope();
  updateCmpOperationMode(); updateTagXlsxUi(); setupImportDropZone(); loadReportHistory(true).then(() => refreshStats()); refreshStats(); startPolling();
});
