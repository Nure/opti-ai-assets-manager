import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import axios from 'axios';
import crypto from 'crypto';
import mime from 'mime-types';
import FormData from 'form-data';
import { nanoid } from 'nanoid';
import { now } from './utils.js';
import { patchJob, getJob } from './store.js';

const outputDir = process.env.APP_OUTPUT_DIR || (await fs.stat('/host-app').then(() => '/host-app').catch(() => path.resolve(process.cwd(), '..')));
const DEFAULT_CMP_API_BASE = 'https://api.cmp.optimizely.com/v3';
const DEFAULT_TOKEN_URL = 'https://accounts.cmp.optimizely.com/o/oauth2/v1/token';
const DEFAULT_CONCURRENCY = 10;
const DEFAULT_RETRIES = 3;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function safePart(value = '') { return String(value || '').replace(/[\\/:*?"<>|\x00-\x1F]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 160) || 'root'; }
function safeRelPath(value = '') { return String(value || '').replace(/\\/g, '/').split('/').filter(Boolean).map(safePart).join('/'); }
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function normalizePath(value = '') { const v = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, ''); return v; }
const IGNORED_IMPORT_FILE_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'thumbs.db', 'Desktop.ini', 'desktop.ini']);
const IGNORED_IMPORT_FOLDER_NAMES = new Set(['__MACOSX', '.Spotlight-V100', '.Trashes', '.fseventsd']);
function isIgnoredImportPath(value = '') {
  const parts = String(value || '').replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.some(part => IGNORED_IMPORT_FOLDER_NAMES.has(part) || IGNORED_IMPORT_FILE_NAMES.has(part) || part.startsWith('._'));
}
function fileAssetType(fileName = '', contentType = '') {
  const ct = String(contentType || '').split(';')[0].toLowerCase();
  const ext = path.extname(fileName || '').toLowerCase();
  if (ct.startsWith('image/') || ['.jpg','.jpeg','.png','.gif','.webp','.avif','.svg','.ico','.bmp','.tif','.tiff'].includes(ext)) return 'image';
  if (ct.startsWith('video/') || ['.mp4','.mov','.webm','.avi','.mkv','.m4v','.wmv','.mpeg','.mpg'].includes(ext)) return 'video';
  return 'raw_file';
}
function responsePreview(data) {
  if (data == null) return '';
  try {
    if (Buffer.isBuffer(data)) return `<binary:${data.length}>`;
    if (typeof data === 'string') return data.slice(0, 600);
    const clean = JSON.parse(JSON.stringify(data));
    if (clean.access_token) clean.access_token = '***';
    if (clean.refresh_token) clean.refresh_token = '***';
    return JSON.stringify(clean).slice(0, 1200);
  } catch { return '[unserializable response]'; }
}
function httpStatusSummary(res) {
  return { status: res.status, statusText: res.statusText || '', contentType: res.headers?.['content-type'] || '', contentLength: res.headers?.['content-length'] || '', requestId: res.headers?.['x-request-id'] || res.headers?.['x-correlation-id'] || '' };
}
function pushTrace(job, event = {}) {
  const rows = job.importHttpEvents || [];
  rows.push({ id: nanoid(), at: now(), operationRunId: job.currentImportRunId || job.importSummary?.operationRunId || '', ...event });
  job.importHttpEvents = rows.slice(-10000);
}
function listRows(data, preferredKey = '') {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  for (const key of [preferredKey, 'folders', 'assets', 'results', 'items', 'data', 'records']) {
    if (key && Array.isArray(data[key])) return data[key];
  }
  if (data.data && typeof data.data === 'object') {
    for (const key of [preferredKey, 'folders', 'assets', 'results', 'items', 'records']) {
      if (key && Array.isArray(data.data[key])) return data.data[key];
    }
  }
  return [];
}
function folderRecordId(folder = {}) { return folder.id || folder.folder_id || folder.folderId || folder.guid || folder.uuid || ''; }
function folderRecordName(folder = {}) { return folder.name || folder.title || folder.folder_name || folder.folderName || ''; }
function assetRecordId(asset = {}) { return asset.id || asset.asset_id || asset.assetId || asset.guid || asset.uuid || ''; }
function assetRecordGuid(asset = {}) { return asset.guid || asset.asset_guid || asset.assetGuid || asset.file_guid || asset.fileGuid || ''; }
function isRetryableError(error) {
  const status = error?.response?.status || error?.status || 0;
  const code = String(error?.code || '');
  if ([408, 409, 425, 429, 500, 502, 503, 504].includes(status)) return true;
  if (['ECONNRESET','ETIMEDOUT','ECONNABORTED','ENOTFOUND','EAI_AGAIN'].includes(code)) return true;
  const msg = String(error?.message || '').toLowerCase();
  return msg.includes('timeout') || msg.includes('socket') || msg.includes('network') || msg.includes('temporar');
}
function incSummary(job, key, amount = 1) { job.importSummary = { ...(job.importSummary || {}), [key]: Number(job.importSummary?.[key] || 0) + amount }; }

async function getCmpAccessToken({ job, clientId, clientSecret, tokenUrl = DEFAULT_TOKEN_URL, onLog, reason = 'initial' }) {
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret });
  await onLog(`CMP AUTH POST endpoint: ${tokenUrl} (${reason})`);
  pushTrace(job, { phase: 'auth', method: 'POST', url: tokenUrl, status: 'STARTED', request: { reason, grant_type: 'client_credentials', client_id: clientId ? `${clientId.slice(0,4)}…${clientId.slice(-4)}` : '', client_secret: '***' } });
  const res = await axios.post(tokenUrl, body, { headers: { 'Content-Type': 'application/x-www-form-urlencoded', accept: 'application/json' }, timeout: 60000, validateStatus: () => true });
  const ok = res.status >= 200 && res.status < 300 && res.data?.access_token;
  await onLog(`CMP AUTH response: HTTP ${res.status} ${res.statusText || ''}${ok ? '' : ' - failed'}`);
  pushTrace(job, { phase: 'auth', method: 'POST', url: tokenUrl, status: ok ? 'SUCCESS' : 'FAILED', response: { ...httpStatusSummary(res), bodyPreview: responsePreview(res.data) } });
  if (!ok) throw new Error(`CMP authentication failed. HTTP ${res.status}. ${responsePreview(res.data)}`);
  return { token: res.data.access_token, expiresAt: Date.now() + Number(res.data.expires_in || 3600) * 1000 };
}
async function cmpRequest({ job, method = 'GET', endpoint, tokenState, refreshToken, onLog, phase, data, headers = {} }) {
  const upperMethod = String(method || 'GET').toUpperCase();
  const baseHeaders = { Authorization: `Bearer ${tokenState.token}`, Accept: 'application/json' };
  // CMP rejects some GET requests when a Content-Type header is present without a body.
  // Only send Content-Type when we actually send a JSON request body.
  if (!['GET', 'HEAD'].includes(upperMethod) && data !== undefined) {
    baseHeaders['Content-Type'] = 'application/json';
  }
  const run = async () => axios.request({
    method: upperMethod,
    url: endpoint,
    ...(data !== undefined ? { data } : {}),
    headers: { ...baseHeaders, ...headers },
    timeout: 120000,
    validateStatus: () => true
  });
  await onLog(`${phase.toUpperCase()} ${method} endpoint: ${endpoint}`);
  pushTrace(job, { phase, method, url: endpoint, status: 'STARTED', request: { headers: { Authorization: 'Bearer ***' }, bodyPreview: responsePreview(data) } });
  let res;
  try {
    res = await run();
  } catch (e) {
    const msg = `${phase.toUpperCase()} request failed before HTTP response: ${e.code || ''} ${e.message || e}`.trim();
    await onLog(msg, 'error');
    pushTrace(job, { phase, method, url: endpoint, status: 'NETWORK_ERROR', error: msg });
    throw e;
  }
  if (res.status === 401 || res.status === 403) {
    await onLog(`${phase.toUpperCase()} received HTTP ${res.status}. Refreshing bearer token and retrying once.`, 'warn');
    incSummary(job, 'tokenRefreshCount');
    pushTrace(job, { phase, method, url: endpoint, status: 'TOKEN_REFRESH_RETRY', response: { ...httpStatusSummary(res), bodyPreview: responsePreview(res.data) } });
    const refreshed = await refreshToken('401/403 retry');
    tokenState.token = refreshed.token; tokenState.expiresAt = refreshed.expiresAt;
    try {
      res = await run();
    } catch (e) {
      const msg = `${phase.toUpperCase()} retry failed before HTTP response: ${e.code || ''} ${e.message || e}`.trim();
      await onLog(msg, 'error');
      pushTrace(job, { phase, method, url: endpoint, status: 'NETWORK_ERROR_AFTER_TOKEN_REFRESH', error: msg });
      throw e;
    }
  }
  const bodyPreview = responsePreview(res.data);
  pushTrace(job, { phase, method, url: endpoint, status: res.status < 400 ? 'SUCCESS' : 'FAILED', response: { ...httpStatusSummary(res), bodyPreview } });
  await onLog(`${phase.toUpperCase()} response: HTTP ${res.status} ${res.statusText || ''}${res.status >= 400 ? ` - ${bodyPreview.slice(0, 240)}` : ''}`);
  return res;
}
async function getUploadUrl({ job, apiBaseUrl, tokenState, refreshToken, onLog }) {
  const endpoint = `${apiBaseUrl.replace(/\/$/, '')}/upload-url`;
  let res;
  try {
    res = await cmpRequest({ job, method: 'GET', endpoint, tokenState, refreshToken, onLog, phase: 'cmp-upload-url' });
  } catch (e) {
    await onLog(`CMP-UPLOAD-URL failed before a usable HTTP response: ${e.code || ''} ${e.message || e}`.trim(), 'error');
    throw e;
  }
  if (res.status >= 400) {
    const preview = responsePreview(res.data);
    await onLog(`CMP-UPLOAD-URL failed. HTTP ${res.status}. Response preview: ${preview.slice(0, 500)}`, 'error');
    throw new Error(`GET /upload-url failed. HTTP ${res.status}. ${preview}`);
  }
  await onLog(`CMP-UPLOAD-URL response preview: ${responsePreview(res.data).slice(0, 700)}`);
  return res.data;
}
function uploadUrlInfo(payload = {}) {
  const root = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  const uploadUrl = root.upload_url || root.uploadUrl || root.url || root.presigned_url || root.presignedUrl || root.endpoint || root.upload?.url || '';
  const rawMeta = root.upload_meta_fields || root.uploadMetaFields || root.fields || root.meta_fields || root.metaFields || root.upload?.fields || [];

  const normaliseField = (field) => {
    if (!field || typeof field !== 'object') return null;
    const name = field.name ?? field.Name ?? field.key ?? field.Key ?? field.field ?? field.fieldName;
    const value = field.value ?? field.Value ?? field.val ?? field.default ?? field.content ?? '';
    if (!name) return null;
    return { name: String(name), value: value == null ? '' : String(value) };
  };

  let metaFields = [];
  if (Array.isArray(rawMeta)) {
    // CMP/S3 requires the meta fields in the exact order returned by /upload-url.
    metaFields = rawMeta.map(normaliseField).filter(Boolean);
  } else if (rawMeta && typeof rawMeta === 'object') {
    // Object-style responses are less common, but keep insertion order when present.
    metaFields = Object.entries(rawMeta).map(([name, value]) => ({ name: String(name), value: value == null ? '' : String(value) }));
  }

  let key = root.key || root.upload_key || root.uploadKey || root.file_key || root.fileKey || '';
  if (!key) {
    const keyField = metaFields.find(field => ['key','upload_key','uploadkey','file_key','filekey'].includes(field.name.toLowerCase()));
    key = keyField?.value || '';
  }

  return {
    uploadUrl,
    key,
    meta: metaFields,
    metaFieldNames: metaFields.map(f => f.name),
    rawPreview: responsePreview(payload)
  };
}

async function postToPresignedUpload({ job, uploadUrl, meta, filePath, fileName, contentType, onLog }) {
  await onLog(`PRESIGNED UPLOAD POST endpoint: ${uploadUrl}`);
  const metaFields = Array.isArray(meta) ? meta : [];
  const metaFieldNames = metaFields.map(m => m.name);
  pushTrace(job, { phase: 'presigned-upload', method: 'POST', url: uploadUrl, status: 'STARTED', request: { fileName, contentType, metaFields: metaFieldNames, fileField: 'file appended last' } });

  const form = new FormData();
  // Per CMP docs, related meta fields must be appended in the same order received.
  for (const field of metaFields) {
    if (field?.name) form.append(field.name, field.value ?? '');
  }

  const stat = await fs.stat(filePath);
  const checksum = sha256(await fs.readFile(filePath));
  // Per CMP docs, the file field name must be "file" and it must be appended at the end.
  form.append('file', fsSync.createReadStream(filePath), {
    filename: fileName,
    contentType: contentType || mime.lookup(fileName) || 'application/octet-stream',
    knownLength: stat.size
  });

  const headers = form.getHeaders();
  try {
    const length = await new Promise((resolve, reject) => form.getLength((err, len) => err ? reject(err) : resolve(len)));
    headers['Content-Length'] = length;
  } catch {
    // Some streams cannot calculate length; the request can still proceed chunked.
  }

  let res;
  try {
    res = await axios.post(uploadUrl, form, {
      headers,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 0,
      validateStatus: () => true
    });
  } catch (e) {
    const msg = `Presigned upload failed before HTTP response: ${e.code || ''} ${e.message || e}`.trim();
    await onLog(msg, 'error');
    pushTrace(job, { phase: 'presigned-upload', method: 'POST', url: uploadUrl, status: 'NETWORK_ERROR', error: msg });
    throw e;
  }
  const ok = res.status >= 200 && res.status < 300;
  pushTrace(job, { phase: 'presigned-upload', method: 'POST', url: uploadUrl, status: ok ? 'SUCCESS' : 'FAILED', response: { ...httpStatusSummary(res), bodyPreview: responsePreview(res.data) } });
  await onLog(`PRESIGNED UPLOAD response: HTTP ${res.status} ${res.statusText || ''}${ok ? '' : ` - ${responsePreview(res.data).slice(0, 320)}`}`);
  if (!ok) {
    const error = new Error(`Presigned upload failed. HTTP ${res.status}. ${responsePreview(res.data)}`);
    error.status = res.status;
    error.response = res;
    throw error;
  }
  return { sizeBytes: stat.size, checksum };
}

async function createCmpAsset({ job, apiBaseUrl, tokenState, refreshToken, onLog, key, title, folderId }) {
  const endpoint = `${apiBaseUrl.replace(/\/$/, '')}/assets`;
  const payload = { key, title: String(title || 'Untitled Asset').slice(0, 100) };
  if (folderId) payload.folder_id = folderId;
  else payload.folder_id = null;
  await onLog(`CMP-CREATE-ASSET payload: key=${key ? 'yes' : 'no'}, title="${payload.title}", folder_id=${payload.folder_id || 'null'}`);
  const res = await cmpRequest({ job, method: 'POST', endpoint, tokenState, refreshToken, onLog, phase: 'cmp-create-asset', data: payload });
  if (res.status >= 400) throw new Error(`POST /assets failed. HTTP ${res.status}. ${responsePreview(res.data)}`);
  return res.data;
}
async function listChildFolders({ job, apiBaseUrl, tokenState, refreshToken, onLog, parentFolderId }) {
  // Enterprise imports can involve thousands of folders. Fetch all child folders
  // for a parent with pagination once, then cache the result per parent.
  const all = [];
  const pageSize = 100;
  for (let offset = 0; ; offset += pageSize) {
    const params = new URLSearchParams();
    if (parentFolderId) params.set('parent_folder_id', parentFolderId);
    params.set('page_size', String(pageSize));
    params.set('offset', String(offset));
    const endpoint = `${apiBaseUrl.replace(/\/$/, '')}/folders?${params.toString()}`;
    const res = await cmpRequest({ job, method: 'GET', endpoint, tokenState, refreshToken, onLog, phase: 'cmp-list-folders' });
    if (res.status >= 400) return all;
    const rows = listRows(res.data, 'folders');
    all.push(...rows);
    const total = Number(res.data?.total || res.data?.total_count || res.data?.count || 0);
    if (rows.length < pageSize) break;
    if (total && all.length >= total) break;
  }
  return all;
}

async function validateParentFolder({ job, apiBaseUrl, tokenState, refreshToken, onLog, parentFolderId }) {
  if (!parentFolderId) return { folderId: '', folderName: 'Home', folderPath: '/' };
  const endpoint = `${apiBaseUrl.replace(/\/$/, '')}/folders/${encodeURIComponent(parentFolderId)}`;
  await onLog(`CMP-PARENT-FOLDER VALIDATE GET endpoint: ${endpoint}`);
  const res = await cmpRequest({ job, method: 'GET', endpoint, tokenState, refreshToken, onLog, phase: 'cmp-parent-folder-validate' });
  if (res.status >= 400) {
    throw new Error(`Parent CMP Folder ID validation failed. HTTP ${res.status}. ${responsePreview(res.data)}`);
  }
  const root = res.data?.data && typeof res.data.data === 'object' ? res.data.data : res.data;
  const folderId = folderRecordId(root) || parentFolderId;
  const folderName = folderRecordName(root) || 'Provided parent folder';
  await onLog(`Parent CMP folder validated: ${folderName} → ${folderId}`);
  return { folderId, folderName, folderPath: '/' };
}

async function createFolder({ job, apiBaseUrl, tokenState, refreshToken, onLog, name, parentFolderId }) {
  const endpoint = `${apiBaseUrl.replace(/\/$/, '')}/folders`;
  const payload = { name, parent_folder_id: parentFolderId || null };
  const res = await cmpRequest({ job, method: 'POST', endpoint, tokenState, refreshToken, onLog, phase: 'cmp-create-folder', data: payload });
  if (res.status >= 400) throw new Error(`POST /folders failed. HTTP ${res.status}. ${responsePreview(res.data)}`);
  return res.data;
}
async function ensureFolder({ job, apiBaseUrl, tokenState, refreshToken, onLog, name, parentFolderId, reuseExisting, folderChildrenCache }) {
  const parentKey = parentFolderId || '__ROOT__';
  if (reuseExisting) {
    if (!folderChildrenCache.has(parentKey)) {
      const children = await listChildFolders({ job, apiBaseUrl, tokenState, refreshToken, onLog, parentFolderId });
      const byName = new Map();
      for (const child of children) {
        const childName = String(folderRecordName(child)).trim().toLowerCase();
        if (childName) byName.set(childName, child);
      }
      folderChildrenCache.set(parentKey, byName);
      await onLog(`Folder cache loaded for parent ${parentFolderId || 'Home'}: ${children.length} existing child folder(s).`);
    }
    const cached = folderChildrenCache.get(parentKey);
    const match = cached.get(String(name).trim().toLowerCase());
    if (match && folderRecordId(match)) {
      return { folderId: folderRecordId(match), folderName: folderRecordName(match), status: 'REUSED_EXISTING', raw: match };
    }
  }
  const created = await createFolder({ job, apiBaseUrl, tokenState, refreshToken, onLog, name, parentFolderId });
  const createdRoot = created?.data && typeof created.data === 'object' ? created.data : created;
  const result = { folderId: folderRecordId(createdRoot) || folderRecordId(created), folderName: folderRecordName(createdRoot) || folderRecordName(created) || name, status: 'CREATED', raw: created };
  if (reuseExisting && result.folderId) {
    if (!folderChildrenCache.has(parentKey)) folderChildrenCache.set(parentKey, new Map());
    folderChildrenCache.get(parentKey).set(String(name).trim().toLowerCase(), { id: result.folderId, name: result.folderName });
  }
  return result;
}
function buildManifestFromMulter(files = []) {
  const manifest = [];
  const ignored = [];
  for (const f of files) {
    // Preserve nested folders using the explicit browser-sent relative path manifest.
    // Multer/browser originalname can be flattened to the basename, especially for drag-and-drop.
    const rawRel = f.relativePath || f.originalname || f.filename || path.basename(f.path);
    const rel = safeRelPath(rawRel);
    const fileName = path.basename(rel);
    const folderPath = path.dirname(rel).replace(/^\.$/, '').replace(/\\/g, '/');
    if (!fileName || isIgnoredImportPath(rel)) {
      ignored.push({ relativePath: rel || String(rawRel || ''), fileName: fileName || String(rawRel || ''), sourceTempPath: f.path, reason: 'OS hidden/system file excluded' });
      continue;
    }
    manifest.push({ id: nanoid(), sourceTempPath: f.path, originalName: f.originalname || fileName, relativePath: rel, fileName, folderPath: folderPath === '.' ? '' : folderPath, contentType: f.mimetype || mime.lookup(fileName) || 'application/octet-stream', sizeBytes: f.size || 0, status: 'PENDING', retryCount: 0, uploadAttempts: 0, tokenRefreshCount: 0, uploadUrlRefreshCount: 0 });
  }
  return { manifest, ignored };
}

function foldersFromManifest(manifest = []) {
  const set = new Set();
  for (const item of manifest) {
    const parts = String(item.folderPath || '').split('/').filter(Boolean);
    let current = '';
    for (const p of parts) { current = current ? `${current}/${p}` : p; set.add(current); }
  }
  return [...set].sort((a,b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}
async function copyFilesToImportRoot(manifest, sourceRoot) {
  for (const item of manifest) {
    const dest = path.join(sourceRoot, ...item.relativePath.split('/').map(safePart));
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rename(item.sourceTempPath, dest).catch(async () => fs.copyFile(item.sourceTempPath, dest));
    item.localSourcePath = dest;
  }
}
async function writeJsonAtomic(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${nanoid()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, filePath);
}
async function readJson(filePath) { return JSON.parse(await fs.readFile(filePath, 'utf8')); }
async function runPool(items, concurrency, worker) {
  let index = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length || 1) }, async () => {
    while (index < items.length) {
      const i = index++;
      await worker(items[i], i);
    }
  });
  await Promise.all(workers);
}
function importRootName() { return `Import on ${new Date().toISOString().replace('T',' ').slice(0,19).replace(/:/g,'-')}`; }
function importedAssetRow(item = {}, extra = {}) {
  return {
    sourceFileName: item.fileName,
    relativePath: item.relativePath,
    sourceFolderPath: item.folderPath || '/',
    targetCmpFolderId: item.targetCmpFolderId || '',
    targetCmpFolderName: item.targetCmpFolderName || '',
    targetCmpFolderPath: item.targetCmpFolderPath || '/',
    assetTitle: item.assetTitle || path.basename(item.fileName || '', path.extname(item.fileName || '')),
    assetId: item.assetId || '',
    assetGuid: item.assetGuid || '',
    assetType: item.assetType || fileAssetType(item.fileName, item.contentType),
    contentType: item.contentType || '',
    sizeBytes: item.sizeBytes || '',
    checksum: item.checksum || '',
    status: item.status || '',
    retryCount: item.retryCount ?? 0,
    uploadAttempts: item.uploadAttempts ?? '',
    tokenRefreshCount: item.tokenRefreshCount ?? '',
    uploadUrlRefreshCount: item.uploadUrlRefreshCount ?? '',
    lastStage: item.lastStage || '',
    uploadUrlEndpoint: item.uploadUrlEndpoint || '',
    createAssetEndpoint: item.createAssetEndpoint || '',
    error: item.error || '',
    uploadedAt: item.uploadedAt || '',
    ...extra
  };
}
function upsertRow(rows, row, key = 'relativePath') {
  const idx = rows.findIndex(r => r[key] && r[key] === row[key]);
  if (idx >= 0) rows[idx] = { ...rows[idx], ...row };
  else rows.push(row);
}
async function checkpointWrite(job, checkpoint) {
  checkpoint.updatedAt = now();
  await writeJsonAtomic(job.importCheckpointPath, checkpoint);
}

async function shouldStopImport(job, checkpoint, onLog = async()=>{}) {
  if (checkpoint.stopRequested) return true;
  const latest = await getJob(job.id).catch(() => null);
  if (latest?.importStopRequested) {
    checkpoint.stopRequested = true;
    checkpoint.status = 'STOP_REQUESTED';
    checkpoint.stopRequestedAt = latest.importSummary?.stopRequestedAt || now();
    await checkpointWrite(job, checkpoint).catch(() => {});
    await onLog('Stop request detected. Import will stop after the current safe checkpoint.', 'warn');
    return true;
  }
  return false;
}
function optionsFromInput(options = {}) {
  return {
    clientId: options.clientId || process.env.CMP_CLIENT_ID,
    clientSecret: options.clientSecret || process.env.CMP_CLIENT_SECRET,
    apiBaseUrl: options.apiBaseUrl || process.env.CMP_API_BASE_URL || DEFAULT_CMP_API_BASE,
    tokenUrl: options.tokenUrl || process.env.CMP_TOKEN_URL || DEFAULT_TOKEN_URL,
    parentFolderId: String(options.parentFolderId || '').trim(),
    concurrency: Math.max(1, Math.min(25, Number(options.concurrency || DEFAULT_CONCURRENCY))),
    maxRetries: Math.max(1, Math.min(10, Number(options.retryCount || DEFAULT_RETRIES))),
    reuseExistingFolders: options.reuseExistingFolders !== false
  };
}

async function processCheckpoint(job, checkpoint, options = {}, onLog = async()=>{}, { retryFailedOnly = false, resume = false } = {}) {
  const opts = optionsFromInput({ ...options, parentFolderId: checkpoint.parentFolderId || options.parentFolderId });
  if (!opts.clientId || !opts.clientSecret) throw new Error('CMP Client ID and Client Secret are required for CMP folder import.');
  job.currentImportRunId = checkpoint.operationRunId;
  job.importSummary = { ...(job.importSummary || {}), operationRunId: checkpoint.operationRunId, status: 'RUNNING', source: 'folder-drag-drop-cmp-import', resumed: resume ? 'Yes' : 'No', retryFailedOnly: retryFailedOnly ? 'Yes' : 'No', requestedFiles: checkpoint.files?.length || 0, parentFolderId: opts.parentFolderId, concurrency: opts.concurrency, retryCount: opts.maxRetries, localImportFolder: checkpoint.localImportFolder, tokenRefreshCount: job.importSummary?.tokenRefreshCount || 0, uploadUrlRefreshCount: job.importSummary?.uploadUrlRefreshCount || 0 };
  await patchJob(job.id, { importSummary: job.importSummary, status: 'IMPORTING', importStopRequested: false });

  const refreshToken = (reason = 'initial') => getCmpAccessToken({ job, clientId: opts.clientId, clientSecret: opts.clientSecret, tokenUrl: opts.tokenUrl, onLog, reason });
  const tokenState = await refreshToken(resume ? 'resume' : 'initial');

  // Parent CMP Folder ID is the destination root. Validate it once only.
  // Child-folder pagination is used only when folder reuse is enabled, not for parent validation.
  const destinationRoot = await validateParentFolder({ job, apiBaseUrl: opts.apiBaseUrl, tokenState, refreshToken, onLog, parentFolderId: opts.parentFolderId });
  checkpoint.parentFolderValidation = { folderId: destinationRoot.folderId, folderName: destinationRoot.folderName, validatedAt: now(), status: 'VALIDATED' };
  await checkpointWrite(job, checkpoint);

  // Rehydrate existing folder map from checkpoint.
  const folderChildrenCache = new Map();
  const folderMap = new Map();
  if (opts.parentFolderId) folderMap.set('', { folderId: destinationRoot.folderId, folderName: destinationRoot.folderName, folderPath: '/' });
  for (const [fp, ctx] of Object.entries(checkpoint.folderMap || {})) folderMap.set(fp, ctx);

  // Create missing folders by depth first. Existing checkpoint folders are skipped.
  const folderPaths = foldersFromManifest(checkpoint.files || []);
  await onLog(`CMP folder tree preparation: ${folderPaths.length} nested folder path(s) detected${opts.parentFolderId ? ` under validated parent ${destinationRoot.folderName} (${destinationRoot.folderId})` : ' under CMP root'}. Folder listing/pagination will run only if folder reuse is enabled.`);
  let folderProgress = 0;
  for (const fp of folderPaths) {
    if (await shouldStopImport(job, checkpoint, onLog)) break;
    folderProgress += 1;
    if (folderProgress === 1 || folderProgress % 100 === 0 || folderProgress === folderPaths.length) {
      await onLog(`Folder preparation progress: ${folderProgress}/${folderPaths.length} path(s).`);
    }
    if (folderMap.get(fp)?.folderId) continue;
    const parts = fp.split('/').filter(Boolean);
    const name = parts[parts.length - 1];
    const parentPath = parts.slice(0, -1).join('/');
    const parentId = parentPath ? folderMap.get(parentPath)?.folderId : opts.parentFolderId;
    try {
      const result = await ensureFolder({ job, apiBaseUrl: opts.apiBaseUrl, tokenState, refreshToken, onLog, name, parentFolderId: parentId || '', reuseExisting: opts.reuseExistingFolders, folderChildrenCache });
      const row = { sourceFolderPath: fp, cmpFolderId: result.folderId, cmpFolderName: result.folderName || name, parentCmpFolderId: parentId || '', parentFolderPath: parentPath || '/', status: result.status, requestEndpoint: `${opts.apiBaseUrl.replace(/\/$/, '')}/folders`, createdAt: now(), error: '', operationRunId: checkpoint.operationRunId };
      folderMap.set(fp, { folderId: result.folderId, folderName: result.folderName || name, folderPath: fp });
      checkpoint.folderMap[fp] = folderMap.get(fp);
      checkpoint.folders = checkpoint.folders || [];
      upsertRow(checkpoint.folders, row, 'sourceFolderPath');
      job.createdFolders = job.createdFolders || [];
      upsertRow(job.createdFolders, row, 'sourceFolderPath');
      await checkpointWrite(job, checkpoint);
      await onLog(`Folder ready: ${fp} → ${result.folderId} (${result.status})`);
    } catch (e) {
      const row = { sourceFolderPath: fp, cmpFolderId: '', cmpFolderName: name, parentCmpFolderId: parentId || '', parentFolderPath: parentPath || '/', status: 'FAILED', requestEndpoint: `${opts.apiBaseUrl.replace(/\/$/, '')}/folders`, createdAt: now(), error: e.message, operationRunId: checkpoint.operationRunId };
      job.createdFolders = job.createdFolders || [];
      upsertRow(job.createdFolders, row, 'sourceFolderPath');
      job.importFailedItems = job.importFailedItems || [];
      upsertRow(job.importFailedItems, { itemType: 'folder', fileName: '', relativePath: '', folderPath: fp, stage: 'CREATE_FOLDER', status: 'FAILED', retryCount: 0, error: e.message, lastAttemptAt: now(), operationRunId: checkpoint.operationRunId }, 'folderPath');
      await checkpointWrite(job, checkpoint);
      await onLog(`Folder creation failed: ${fp}: ${e.message}`, 'error');
    }
  }

  const candidates = (checkpoint.files || []).filter(f => {
    if (f.status === 'ASSET_CREATED' && f.assetId) return false;
    if (retryFailedOnly) return ['FAILED','PENDING_RETRY'].includes(f.status);
    return !['ASSET_CREATED'].includes(f.status);
  });
  await onLog(`${resume ? 'Resuming' : 'Uploading'} ${candidates.length} pending/failed file(s) with ${opts.concurrency} parallel worker(s).`);

  await runPool(candidates, opts.concurrency, async (item, idx) => {
    if (await shouldStopImport(job, checkpoint, onLog)) return;
    const folderCtx = item.folderPath ? folderMap.get(item.folderPath) : { folderId: destinationRoot.folderId || '', folderName: destinationRoot.folderName || 'Home', folderPath: '/' };
    if (item.folderPath && !folderCtx?.folderId) {
      item.status = 'FAILED';
      item.lastStage = 'TARGET_FOLDER_NOT_READY';
      item.error = `Target CMP folder was not created for source path: ${item.folderPath}`;
      job.importFailedItems = job.importFailedItems || [];
      upsertRow(job.importFailedItems, { itemType: 'asset', fileName: item.fileName, relativePath: item.relativePath, folderPath: item.folderPath || '/', stage: item.lastStage, status: 'FAILED', retryCount: item.retryCount || 0, error: item.error, lastAttemptAt: now(), operationRunId: checkpoint.operationRunId }, 'relativePath');
      job.importedAssets = job.importedAssets || [];
      upsertRow(job.importedAssets, { ...importedAssetRow(item), operationRunId: checkpoint.operationRunId }, 'relativePath');
      await checkpointWrite(job, checkpoint);
      await onLog(`Skipping ${item.relativePath}: ${item.error}`, 'error');
      return;
    }
    item.targetCmpFolderId = folderCtx?.folderId || destinationRoot.folderId || '';
    item.targetCmpFolderName = folderCtx?.folderName || (item.targetCmpFolderId ? destinationRoot.folderName : 'Home');
    item.targetCmpFolderPath = folderCtx?.folderPath || '/';
    item.assetTitle = path.basename(item.fileName, path.extname(item.fileName)).slice(0, 100) || item.fileName.slice(0,100);
    item.assetType = fileAssetType(item.fileName, item.contentType);

    if (item.status === 'ASSET_CREATED' && item.assetId) return;
    for (let attempt = 1; attempt <= opts.maxRetries; attempt++) {
      item.retryCount = attempt - 1;
      item.uploadAttempts = Number(item.uploadAttempts || 0) + 1;
      item.lastAttemptAt = now();
      try {
        item.status = 'UPLOADING'; item.lastStage = 'GET_UPLOAD_URL'; item.error = '';
        await checkpointWrite(job, checkpoint);
        const uploadInfo = uploadUrlInfo(await getUploadUrl({ job, apiBaseUrl: opts.apiBaseUrl, tokenState, refreshToken, onLog }));
        incSummary(job, 'uploadUrlRefreshCount');
        item.uploadUrlRefreshCount = Number(item.uploadUrlRefreshCount || 0) + 1;
        const metaFieldCount = Array.isArray(uploadInfo.meta) ? uploadInfo.meta.length : Object.keys(uploadInfo.meta || {}).length;
        await onLog(`CMP-UPLOAD-URL parsed: uploadUrl=${uploadInfo.uploadUrl ? 'yes' : 'no'}, key=${uploadInfo.key ? 'yes' : 'no'}, metaFields=${metaFieldCount}${uploadInfo.metaFieldNames?.length ? ` [${uploadInfo.metaFieldNames.join(', ')}]` : ''}.`);
        if (!uploadInfo.uploadUrl || !uploadInfo.key) {
          throw new Error(`CMP upload-url response did not include ${!uploadInfo.uploadUrl ? 'upload URL' : ''}${!uploadInfo.uploadUrl && !uploadInfo.key ? ' and ' : ''}${!uploadInfo.key ? 'key' : ''}. Check the CMP /upload-url response shape.`);
        }
        item.uploadUrlEndpoint = `${opts.apiBaseUrl.replace(/\/$/, '')}/upload-url`;
        item.uploadKey = uploadInfo.key;

        item.lastStage = 'PRESIGNED_BINARY_UPLOAD';
        const binary = await postToPresignedUpload({ job, uploadUrl: uploadInfo.uploadUrl, meta: uploadInfo.meta, filePath: item.localSourcePath, fileName: item.fileName, contentType: item.contentType, onLog });
        item.status = 'BINARY_UPLOADED'; item.sizeBytes = binary.sizeBytes; item.checksum = binary.checksum;
        await checkpointWrite(job, checkpoint);

        item.lastStage = 'CREATE_CMP_ASSET';
        const asset = await createCmpAsset({ job, apiBaseUrl: opts.apiBaseUrl, tokenState, refreshToken, onLog, key: uploadInfo.key, title: item.assetTitle, folderId: item.targetCmpFolderId });
        item.status = 'ASSET_CREATED'; item.assetId = assetRecordId(asset); item.assetGuid = assetRecordGuid(asset); item.uploadedAt = now(); item.createAssetEndpoint = `${opts.apiBaseUrl.replace(/\/$/, '')}/assets`; item.lastStage = 'ASSET_CREATED';
        const row = { ...importedAssetRow(item), operationRunId: checkpoint.operationRunId };
        job.importedAssets = job.importedAssets || [];
        upsertRow(job.importedAssets, row, 'relativePath');
        await checkpointWrite(job, checkpoint);
        await onLog(`Uploaded ${idx + 1}/${candidates.length}: ${item.relativePath} → assetId=${item.assetId || 'unknown'}`);
        return;
      } catch (e) {
        item.error = e.message;
        item.status = attempt < opts.maxRetries && isRetryableError(e) ? 'PENDING_RETRY' : 'FAILED';
        const level = item.status === 'PENDING_RETRY' ? 'warn' : 'error';
        await onLog(`Upload failed for ${item.relativePath} (attempt ${attempt}/${opts.maxRetries}, stage=${item.lastStage || 'UNKNOWN'}): ${e.message}`, level);
        await checkpointWrite(job, checkpoint);
        if (item.status === 'FAILED') break;
        await sleep(800 * attempt);
      }
    }
    if (item.status === 'FAILED') {
      const failed = { itemType: 'asset', fileName: item.fileName, relativePath: item.relativePath, folderPath: item.folderPath || '/', stage: item.lastStage || 'UPLOAD_OR_CREATE_ASSET', status: 'FAILED', retryCount: item.retryCount || 0, error: item.error || '', lastAttemptAt: now(), operationRunId: checkpoint.operationRunId };
      job.importFailedItems = job.importFailedItems || [];
      upsertRow(job.importFailedItems, failed, 'relativePath');
      job.importedAssets = job.importedAssets || [];
      upsertRow(job.importedAssets, { ...importedAssetRow(item), operationRunId: checkpoint.operationRunId }, 'relativePath');
    }
  });

  const uploaded = (checkpoint.files || []).filter(f => f.status === 'ASSET_CREATED').length;
  const failed = (checkpoint.files || []).filter(f => f.status === 'FAILED').length;
  const pending = (checkpoint.files || []).filter(f => !['ASSET_CREATED','FAILED'].includes(f.status)).length;
  const stopped = !!checkpoint.stopRequested;
  checkpoint.status = stopped ? 'STOPPED' : (failed || pending ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED');
  checkpoint.completedAt = now();
  await checkpointWrite(job, checkpoint);
  job.importSummary = {
    ...job.importSummary,
    status: checkpoint.status,
    requestedFiles: checkpoint.files.length,
    uploaded,
    failed,
    pending,
    stopped: stopped ? 'Yes' : 'No',
    stoppedAt: stopped ? now() : '',
    createdFolders: (job.createdFolders || []).filter(f => f.operationRunId === checkpoint.operationRunId && f.status === 'CREATED').length,
    reusedFolders: (job.createdFolders || []).filter(f => f.operationRunId === checkpoint.operationRunId && f.status === 'REUSED_EXISTING').length,
    localImportFolder: checkpoint.localImportFolder,
    checkpoint: path.relative(outputDir, job.importCheckpointPath),
    resumeAvailable: stopped || failed || pending ? 'Yes' : 'No',
    completedAt: now()
  };
  job.status = stopped ? 'IMPORT_STOPPED' : (failed || pending ? 'IMPORT_INCOMPLETE' : 'IMPORTED');
  await onLog(`Enterprise CMP import summary: uploaded=${uploaded}, failed=${failed}, pending=${pending}, foldersCreated=${job.importSummary.createdFolders || 0}, foldersReused=${job.importSummary.reusedFolders || 0}.`, failed || pending ? 'warn' : 'info');
  if (failed || pending) {
    const sampleFailed = (checkpoint.files || []).find(f => f.status === 'FAILED' || !['ASSET_CREATED'].includes(f.status));
    if (sampleFailed) await onLog(`Sample incomplete item: ${sampleFailed.relativePath}, stage=${sampleFailed.lastStage || 'UNKNOWN'}, error=${sampleFailed.error || 'No error captured'}`, 'warn');
  }
  delete job.currentImportRunId;
  await patchJob(job.id, { importSummary: job.importSummary, importedAssets: job.importedAssets || [], createdFolders: job.createdFolders || [], importFailedItems: job.importFailedItems || [], importHttpEvents: job.importHttpEvents || [], status: job.status, importStopRequested: false, importRootRelativePath: checkpoint.localImportFolder, importCheckpointPath: job.importCheckpointPath });
  return job;
}

export async function enterpriseImportFolderFiles(job, files = [], options = {}, onLog = async()=>{}) {
  const opts = optionsFromInput(options);
  if (!opts.clientId || !opts.clientSecret) throw new Error('CMP Client ID and Client Secret are required for CMP folder import.');
  const operationRunId = nanoid();
  const rootName = importRootName();
  const importRoot = path.join(outputDir, rootName);
  const sourceRoot = path.join(importRoot, '_source-files');
  await fs.mkdir(sourceRoot, { recursive: true });
  const { manifest, ignored } = buildManifestFromMulter(files);
  if (ignored.length) {
    await Promise.all(ignored.map(item => item.sourceTempPath ? fs.rm(item.sourceTempPath, { force: true }).catch(() => {}) : Promise.resolve()));
    await onLog(`Excluded ${ignored.length} OS hidden/system file(s) from import, including .DS_Store, Apple resource forks, __MACOSX, Thumbs.db, and desktop.ini.`, 'warn');
  }
  if (!manifest.length) throw new Error('No importable files remain after excluding OS hidden/system files.');
  await copyFilesToImportRoot(manifest, sourceRoot);

  job.currentImportRunId = operationRunId;
  job.importHttpEvents = [];
  job.importedAssets = [];
  job.createdFolders = [];
  job.importFailedItems = [];
  job.importSummary = { operationRunId, status: 'RUNNING', source: 'folder-drag-drop-cmp-import', startedAt: now(), requestedFiles: manifest.length, ignoredFiles: ignored.length, parentFolderId: opts.parentFolderId, concurrency: opts.concurrency, retryCount: opts.maxRetries, localImportFolder: rootName, tokenRefreshCount: 0, uploadUrlRefreshCount: 0, resumeAvailable: 'No' };
  job.importRootPath = importRoot;
  job.importRootRelativePath = rootName;
  job.importCheckpointPath = path.join(importRoot, 'import-checkpoint.json');
  await patchJob(job.id, { importSummary: job.importSummary, importRootRelativePath: rootName, importCheckpointPath: job.importCheckpointPath, status: 'IMPORTING' });

  const checkpoint = { jobId: job.id, operationRunId, status: 'RUNNING', parentFolderId: opts.parentFolderId, localImportFolder: rootName, sourceRoot: path.relative(outputDir, sourceRoot), folderMap: {}, folders: [], files: manifest, ignoredFiles: ignored, createdAt: now(), updatedAt: now() };
  await checkpointWrite(job, checkpoint);
  await onLog(`Enterprise CMP import initialized: ${manifest.length} importable file(s)${ignored.length ? `, ${ignored.length} hidden/system file(s) excluded` : ''}, root=${rootName}, parallel uploads=${opts.concurrency}, retries=${opts.maxRetries}.`);
  return processCheckpoint(job, checkpoint, options, onLog, { resume: false });
}

export async function resumeEnterpriseImport(job, options = {}, onLog = async()=>{}) {
  if (!job.importCheckpointPath) throw new Error('No import checkpoint is available for this job.');
  const checkpoint = await readJson(job.importCheckpointPath);
  const pendingCount = (checkpoint.files || []).filter(f => options.retryFailedOnly ? f.status === 'FAILED' : !['ASSET_CREATED'].includes(f.status)).length;
  if (!pendingCount) {
    await onLog('No pending or failed files found in checkpoint.');
    return job;
  }
  checkpoint.stopRequested = false;
  checkpoint.status = 'RUNNING';
  await onLog(`Resume requested for ${pendingCount} file(s). Reusing existing import folder and checkpoint: ${checkpoint.localImportFolder}.`);
  return processCheckpoint(job, checkpoint, options, onLog, { resume: true, retryFailedOnly: !!options.retryFailedOnly });
}
