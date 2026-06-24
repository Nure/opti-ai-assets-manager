import axios from 'axios';
import fs from 'fs/promises';
import XLSX from 'xlsx';
import { nanoid } from 'nanoid';
import { now } from './utils.js';

const DEFAULT_CMP_API_BASE = 'https://api.cmp.optimizely.com/v3';
const DEFAULT_TOKEN_URL = 'https://accounts.cmp.optimizely.com/o/oauth2/v1/token';
const DEFAULT_PAGE_SIZE = Number(process.env.CMP_TAG_PAGE_SIZE || 100);
const DEFAULT_CONCURRENCY = Number(process.env.CMP_TAG_CONCURRENCY || 5);
const DEFAULT_RETRIES = Number(process.env.CMP_TAG_RETRIES || 3);

function safeString(value = '') { return String(value ?? '').trim(); }
function normalizeName(value = '') { return safeString(value).toLowerCase().replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function mask(value = '') { const s = String(value || ''); return s.length <= 8 ? '***' : `${s.slice(0, 4)}…${s.slice(-4)}`; }
function responsePreview(data) {
  if (data == null) return '';
  try {
    if (typeof data === 'string') return data.slice(0, 800);
    const clean = JSON.parse(JSON.stringify(data));
    if (clean.access_token) clean.access_token = '***';
    if (clean.refresh_token) clean.refresh_token = '***';
    return JSON.stringify(clean).slice(0, 1400);
  } catch { return '[unserializable response]'; }
}
function httpStatusSummary(res) {
  return { status: res.status, statusText: res.statusText || '', contentType: res.headers?.['content-type'] || '', requestId: res.headers?.['x-request-id'] || res.headers?.['x-correlation-id'] || '' };
}
function listRows(data, preferredKey = '') {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  for (const key of [preferredKey, 'fields', 'label_groups', 'labelGroups', 'labels', 'results', 'items', 'data', 'records']) {
    if (key && Array.isArray(data[key])) return data[key];
  }
  if (data.data && typeof data.data === 'object') {
    for (const key of [preferredKey, 'fields', 'label_groups', 'labelGroups', 'labels', 'results', 'items', 'records']) {
      if (key && Array.isArray(data.data[key])) return data.data[key];
    }
  }
  return [];
}
function hasMore(data, rows, offset, pageSize) {
  const total = data?.total || data?.total_count || data?.totalCount || data?.pagination?.total || data?.meta?.total;
  if (Number.isFinite(Number(total))) return offset + rows.length < Number(total);
  return rows.length >= pageSize;
}
function pushTrace(job, event = {}) {
  const rows = job.tagHttpEvents || [];
  rows.push({ id: nanoid(), at: now(), operationRunId: job.currentTagRunId || job.tagSummary?.operationRunId || '', ...event });
  job.tagHttpEvents = rows.slice(-5000);
}
async function getCmpAccessToken({ job, clientId, clientSecret, tokenUrl = DEFAULT_TOKEN_URL, onLog, reason = 'initial' }) {
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret });
  await onLog(`CMP TAG AUTH POST endpoint: ${tokenUrl} (${reason})`);
  pushTrace(job, { phase: 'tag-auth', method: 'POST', url: tokenUrl, status: 'STARTED', request: { grant_type: 'client_credentials', client_id: mask(clientId), client_secret: '***' } });
  const res = await axios.post(tokenUrl, body, { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, timeout: 60000, validateStatus: () => true });
  const ok = res.status >= 200 && res.status < 300 && res.data?.access_token;
  await onLog(`CMP TAG AUTH response: HTTP ${res.status} ${res.statusText || ''}${ok ? '' : ' - failed'}`);
  pushTrace(job, { phase: 'tag-auth', method: 'POST', url: tokenUrl, status: ok ? 'SUCCESS' : 'FAILED', response: { ...httpStatusSummary(res), bodyPreview: responsePreview(res.data) } });
  if (!ok) throw new Error(`CMP authentication failed. HTTP ${res.status}. ${responsePreview(res.data)}`);
  return { token: res.data.access_token, expiresAt: Date.now() + Number(res.data.expires_in || 3600) * 1000 };
}
async function cmpRequest({ job, method = 'GET', endpoint, tokenState, refreshToken, onLog, phase, data }) {
  const upper = method.toUpperCase();
  const run = () => axios.request({
    method: upper,
    url: endpoint,
    data,
    headers: { Authorization: `Bearer ${tokenState.token}`, Accept: 'application/json', ...(!['GET', 'HEAD'].includes(upper) && data !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    timeout: 120000,
    validateStatus: () => true
  });
  await onLog(`${phase.toUpperCase()} ${upper} endpoint: ${endpoint}`);
  pushTrace(job, { phase, method: upper, url: endpoint, status: 'STARTED', request: { bodyPreview: responsePreview(data) } });
  let res = await run();
  if (res.status === 401 || res.status === 403) {
    await onLog(`${phase.toUpperCase()} received HTTP ${res.status}. Refreshing bearer token and retrying once.`, 'warn');
    job.tagSummary = { ...(job.tagSummary || {}), tokenRefreshCount: Number(job.tagSummary?.tokenRefreshCount || 0) + 1 };
    const refreshed = await refreshToken('tag 401/403 retry');
    tokenState.token = refreshed.token; tokenState.expiresAt = refreshed.expiresAt;
    res = await run();
  }
  pushTrace(job, { phase, method: upper, url: endpoint, status: res.status < 400 ? 'SUCCESS' : 'FAILED', response: { ...httpStatusSummary(res), bodyPreview: responsePreview(res.data) } });
  await onLog(`${phase.toUpperCase()} response: HTTP ${res.status} ${res.statusText || ''}${res.status >= 400 ? ` - ${responsePreview(res.data).slice(0, 240)}` : ''}`);
  if (res.status >= 400) throw new Error(`${phase} failed. HTTP ${res.status}. ${responsePreview(res.data)}`);
  return res.data;
}
async function fetchPaged({ job, apiBaseUrl, path, preferredKey, tokenState, refreshToken, onLog, phase }) {
  const base = apiBaseUrl.replace(/\/$/, '');
  const all = [];
  let offset = 0;
  while (true) {
    const sep = path.includes('?') ? '&' : '?';
    const endpoint = `${base}${path}${sep}page_size=${DEFAULT_PAGE_SIZE}&offset=${offset}`;
    const data = await cmpRequest({ job, method: 'GET', endpoint, tokenState, refreshToken, onLog, phase });
    const rows = listRows(data, preferredKey);
    all.push(...rows);
    if (!hasMore(data, rows, offset, DEFAULT_PAGE_SIZE)) break;
    offset += DEFAULT_PAGE_SIZE;
    if (offset > 100000) break;
  }
  return all;
}
function fieldId(f = {}) { return f.id || f.field_id || f.fieldId || f.uuid || f.guid || ''; }
function fieldName(f = {}) { return f.name || f.display_name || f.displayName || f.label || f.title || f.field_name || f.fieldName || ''; }
function fieldType(f = {}) { return f.type || f.field_type || f.fieldType || f.input_type || f.inputType || f.data_type || f.dataType || ''; }
function optionRows(obj = {}) {
  const pools = [obj.options, obj.values, obj.allowed_values, obj.allowedValues, obj.choices, obj.labels, obj.items, obj.data?.options, obj.data?.values].filter(Array.isArray);
  return pools.flat();
}
function optionId(o = {}) { return String(o.id || o.value_id || o.valueId || o.option_id || o.optionId || o.guid || o.uuid || o.value || '').trim(); }
function optionName(o = {}) { return String(o.name || o.label || o.title || o.display_name || o.displayName || o.value || '').trim(); }
function buildOptionMap(source = {}) {
  const map = new Map();
  for (const opt of optionRows(source)) {
    const id = optionId(opt); const name = optionName(opt);
    if (name && id) map.set(normalizeName(name), { id, name });
    if (id) map.set(normalizeName(id), { id, name: name || id });
  }
  return map;
}
function labelGroupId(g = {}) { return g.id || g.label_group_id || g.labelGroupId || g.field_id || g.fieldId || g.uuid || g.guid || ''; }
function labelGroupName(g = {}) { return g.name || g.title || g.label || g.display_name || g.displayName || ''; }
function rawCellString(value) {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value).trim();
}
function parseCellValues(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap(parseCellValues);
  const s = rawCellString(value);
  if (!s) return [];
  return s.split(';').map(v => v.trim()).filter(Boolean);
}
function isOptionLikeMatch(match = {}) {
  if (match.source === 'label') return true;
  const type = normalizeName(match.type || '');
  const textLike = ['text', 'text field', 'textarea', 'text area', 'rich text', 'string', 'plain text'].some(t => type === t || type.includes(t));
  if (textLike) return false;
  return ['dropdown','radio button','checkbox','label','labels','multi select','multiselect','multi-select','select','choice','choices','option','options','list'].some(t => type.includes(t));
}
function valuesForField(match, rawValue) {
  const raw = rawCellString(rawValue);
  if (!raw) return [];
  return isOptionLikeMatch(match) ? parseCellValues(rawValue) : [raw];
}
function readWorkbookRows(filePath) {
  const wb = XLSX.readFile(filePath, { cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { defval: '' });
}
function findAssetIdHeader(headers) {
  return headers.find(h => ['assetid', 'asset id', 'asset_id', 'assetguid', 'asset guid', 'id'].includes(normalizeName(h))) || '';
}
function buildCatalog(fields, labelGroups) {
  const headerMap = new Map();
  for (const f of fields) {
    const name = fieldName(f); const id = fieldId(f); if (!name || !id) continue;
    const rec = { source: 'field', id, name, type: fieldType(f) || 'text', raw: f, optionMap: buildOptionMap(f) };
    const key = normalizeName(name);
    if (!headerMap.has(key)) headerMap.set(key, []);
    headerMap.get(key).push(rec);
  }
  for (const g of labelGroups) {
    const name = labelGroupName(g); const id = labelGroupId(g); if (!name || !id) continue;
    const rec = { source: 'label', id, name, type: 'label', raw: g, optionMap: buildOptionMap(g) };
    const key = normalizeName(name);
    if (!headerMap.has(key)) headerMap.set(key, []);
    headerMap.get(key).push(rec);
  }
  return { headerMap };
}
function mapCellValue(match, values) {
  const optionLike = isOptionLikeMatch(match);
  if (!optionLike) return { values, resolvedValues: values, invalidValues: [], valueMode: 'raw-text' };
  const resolved = []; const invalid = [];
  for (const value of values) {
    const found = match.optionMap.get(normalizeName(value));
    if (found) resolved.push(found.id);
    else invalid.push(value);
  }
  return { values: resolved, resolvedValues: resolved.map(id => {
    for (const opt of match.optionMap.values()) if (opt.id === id) return opt.name || id;
    return id;
  }), invalidValues: invalid };
}
async function fetchCmpCatalog({ job, options, onLog }) {
  const apiBaseUrl = options.apiBaseUrl || DEFAULT_CMP_API_BASE;
  const tokenUrl = options.tokenUrl || DEFAULT_TOKEN_URL;
  const clientId = options.clientId || ''; const clientSecret = options.clientSecret || '';
  if (!clientId || !clientSecret) throw new Error('CMP Client ID and Client Secret are required.');
  const refreshToken = (reason) => getCmpAccessToken({ job, clientId, clientSecret, tokenUrl, onLog, reason });
  const tokenState = await refreshToken('initial');
  const fields = await fetchPaged({ job, apiBaseUrl, path: '/fields', preferredKey: 'fields', tokenState, refreshToken, onLog, phase: 'cmp-list-fields' });
  const labelGroups = await fetchPaged({ job, apiBaseUrl, path: '/label-groups', preferredKey: 'label_groups', tokenState, refreshToken, onLog, phase: 'cmp-list-label-groups' });
  return { apiBaseUrl, tokenUrl, clientId, clientSecret, tokenState, refreshToken, fields, labelGroups, catalog: buildCatalog(fields, labelGroups) };
}

export async function dryRunTagAssetsMetadata(job, filePath, options = {}, onLog = async()=>{}) {
  const runId = nanoid();
  job.currentTagRunId = runId;
  job.tagSummary = { operation: 'dry-run', operationRunId: runId, status: 'DRY_RUN_RUNNING', startedAt: now() };
  job.tagDryRunRows = [];
  job.tagHeaderRows = [];
  job.tagExecutionRows = [];
  job.tagHttpEvents = [];
  await onLog('Tag Assets Metadata dry run started. Reading XLSX and CMP fields/labels.');
  const rows = readWorkbookRows(filePath);
  const headers = Object.keys(rows[0] || {});
  const assetHeader = findAssetIdHeader(headers);
  if (!assetHeader) throw new Error('AssetID column is required. Accepted headers: AssetID, Asset ID, asset_id, assetGuid.');
  const metadataHeaders = headers.filter(h => h !== assetHeader && String(h || '').trim());
  const cmp = await fetchCmpCatalog({ job, options, onLog });
  const mapping = {};
  let missingHeaders = 0, matchedHeaders = 0, ambiguousHeaders = 0, invalidValues = 0, readyUpdates = 0, totalValues = 0;
  for (const header of metadataHeaders) {
    const matches = cmp.catalog.headerMap.get(normalizeName(header)) || [];
    let status = 'MATCHED'; let selected = null; let issue = '';
    if (!matches.length) { status = 'MISSING_FIELD_OR_LABEL'; missingHeaders++; issue = 'No matching CMP field or label group found.'; }
    else if (matches.length > 1) { selected = matches[0]; status = 'AMBIGUOUS_MATCH'; ambiguousHeaders++; issue = `Multiple CMP fields/labels matched. Using first: ${selected.name}.`; }
    else { selected = matches[0]; matchedHeaders++; }
    mapping[header] = selected ? { header, status, source: selected.source, fieldId: selected.id, fieldName: selected.name, type: selected.type } : { header, status, issue };
    job.tagHeaderRows.push({ header, status, cmpSource: selected?.source || '', cmpFieldId: selected?.id || '', cmpFieldName: selected?.name || '', cmpFieldType: selected?.type || '', issue });
  }
  for (const row of rows) {
    const assetId = safeString(row[assetHeader]);
    for (const header of metadataHeaders) {
      const rawValue = row[header];
      const map = mapping[header];
      const catalogMatch = (cmp.catalog.headerMap.get(normalizeName(header)) || [])[0] || null;
      const match = map?.fieldId ? { id: map.fieldId, name: map.fieldName, source: map.source, type: map.type, optionMap: catalogMatch?.optionMap || new Map() } : null;
      const inputValues = match ? valuesForField(match, rawValue) : parseCellValues(rawValue);
      if (!assetId && !inputValues.length) continue;
      totalValues += inputValues.length;
      let status = 'READY'; let resolvedValueIds = []; let resolvedTextValues = inputValues; let issue = ''; let valueMode = match && !isOptionLikeMatch(match) ? 'raw-text' : 'option-id';
      if (!assetId) { status = 'MISSING_ASSET_ID'; issue = 'AssetID is empty.'; }
      else if (!inputValues.length) { status = 'SKIPPED_EMPTY_VALUE'; issue = 'No spreadsheet value provided.'; }
      else if (!map?.fieldId) { status = 'MISSING_FIELD_OR_LABEL'; issue = map?.issue || 'Header not matched in CMP.'; }
      else {
        const converted = mapCellValue(match, inputValues);
        resolvedValueIds = converted.values;
        resolvedTextValues = converted.resolvedValues?.length ? converted.resolvedValues : inputValues;
        valueMode = converted.valueMode || valueMode;
        if (converted.invalidValues.length) { status = 'INVALID_VALUE'; issue = `Option/value not found in CMP: ${converted.invalidValues.join('; ')}`; invalidValues += converted.invalidValues.length; }
        else { readyUpdates++; }
      }
      job.tagDryRunRows.push({ assetId, header, xlsxValue: inputValues.join('; '), cmpMatchStatus: status, cmpSource: map?.source || '', cmpFieldId: map?.fieldId || '', cmpFieldName: map?.fieldName || '', cmpFieldType: map?.type || '', valueMode, resolvedValueIds: resolvedValueIds.join('; '), resolvedTextValues: resolvedTextValues.join('; '), issue, recommendation: status === 'READY' ? (valueMode === 'raw-text' ? 'Ready - text value will be written as-is from XLSX' : 'Ready to execute') : status === 'SKIPPED_EMPTY_VALUE' ? 'No action required' : 'Fix XLSX or CMP configuration before execution' });
    }
  }
  job.tagMapping = { runId, assetHeader, mapping, createdAt: now() };
  job.tagSummary = { operation: 'dry-run', operationRunId: runId, status: invalidValues || missingHeaders ? 'DRY_RUN_ISSUES' : 'DRY_RUN_READY', totalRows: rows.length, totalAssets: new Set(rows.map(r => safeString(r[assetHeader])).filter(Boolean)).size, metadataColumns: metadataHeaders.length, matchedHeaders, missingHeaders, ambiguousHeaders, totalValues, readyUpdates, invalidValues, canExecute: readyUpdates > 0 && !invalidValues && !missingHeaders ? 'Yes' : 'Review Required', lastDryRunAt: now() };
  job.status = job.tagSummary.status;
  await onLog(`Tag dry run complete: assets=${job.tagSummary.totalAssets}, columns=${metadataHeaders.length}, ready=${readyUpdates}, missingHeaders=${missingHeaders}, invalidValues=${invalidValues}.`);
  await fs.rm(filePath, { force: true }).catch(() => {});
  return job;
}


function assetFieldId(f = {}) { return String(f.id || f.field_id || f.fieldId || f.field?.id || f.definition?.id || '').trim(); }
function assetFieldType(f = {}) { return String(f.type || f.field_type || f.fieldType || f.field?.type || f.definition?.type || 'text').trim(); }
function assetFieldValues(f = {}) {
  const v = f.values ?? f.value ?? f.selected_values ?? f.selectedValues ?? [];
  if (Array.isArray(v)) return v.map(x => typeof x === 'object' ? String(x.id || x.value_id || x.valueId || x.value || x.name || '').trim() : String(x).trim()).filter(Boolean);
  if (v == null || v === '') return [];
  return [String(v).trim()].filter(Boolean);
}
async function fetchAssetFields({ job, assetId, cmp, onLog }) {
  const base = cmp.apiBaseUrl.replace(/\/$/, '');
  const rows = [];
  let offset = 0;
  while (true) {
    const endpoint = `${base}/assets/${encodeURIComponent(assetId)}/fields?page_size=${DEFAULT_PAGE_SIZE}&offset=${offset}`;
    const data = await cmpRequest({ job, method: 'GET', endpoint, tokenState: cmp.tokenState, refreshToken: cmp.refreshToken, onLog, phase: 'cmp-list-asset-fields' });
    const batch = listRows(data, 'fields');
    rows.push(...batch);
    if (!hasMore(data, batch, offset, DEFAULT_PAGE_SIZE)) break;
    offset += DEFAULT_PAGE_SIZE;
    if (offset > 100000) break;
  }
  return rows;
}
function bulkFieldPayloadFromExistingAndUpdates(existingFields = [], updateRows = []) {
  const byId = new Map();
  for (const existing of existingFields) {
    const id = assetFieldId(existing);
    if (!id) continue;
    byId.set(id, {
      id,
      type: assetFieldType(existing) || 'text',
      values: assetFieldValues(existing)
    });
  }
  for (const row of updateRows) {
    const id = String(row.cmpFieldId || '').trim();
    if (!id) continue;
    let values = String(row.resolvedValueIds || '').split(';').map(v => v.trim()).filter(Boolean);
    if (!values.length) values = row.valueMode === 'raw-text' ? [rawCellString(row.xlsxValue)].filter(Boolean) : parseCellValues(row.xlsxValue);
    byId.set(id, {
      id,
      type: row.cmpFieldType || 'text',
      values
    });
  }
  return Array.from(byId.values());
}

async function runLimited(items, limit, worker) {
  let index = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, async () => {
    while (index < items.length) {
      const item = items[index++];
      await worker(item);
    }
  });
  await Promise.all(workers);
}
function isRetryable(error) {
  const status = error?.response?.status || error?.status || 0;
  return [408, 409, 425, 429, 500, 502, 503, 504].includes(Number(status)) || /timeout|network|socket|temporar|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(String(error?.message || error?.code || ''));
}

export async function executeTagAssetsMetadata(job, options = {}, onLog = async()=>{}) {
  const runId = nanoid();
  const dryRows = (job.tagDryRunRows || []).filter(r => r.cmpMatchStatus === 'READY');
  if (!dryRows.length) throw new Error('No validated dry-run rows are ready for execution. Run Dry Run first and fix issues.');
  job.currentTagRunId = runId;
  job.tagExecutionRows = [];
  job.tagSummary = { ...(job.tagSummary || {}), operation: 'execute', operationRunId: runId, status: 'TAGGING_RUNNING', executionStartedAt: now(), requestedUpdates: dryRows.length };
  await onLog(`Tag execution started with ${dryRows.length} validated asset-field update(s).`);
  const cmp = await fetchCmpCatalog({ job, options, onLog });
  const concurrency = Math.max(1, Math.min(Number(options.concurrency || DEFAULT_CONCURRENCY), 20));
  const retryCount = Math.max(1, Math.min(Number(options.retryCount || DEFAULT_RETRIES), 10));
  let updated = 0, failed = 0, skipped = 0;
  const grouped = new Map();
  for (const row of dryRows) {
    if (!grouped.has(row.assetId)) grouped.set(row.assetId, []);
    grouped.get(row.assetId).push(row);
  }
  async function updateAssetGroup([assetId, rowsForAsset]) {
    const endpoint = `${cmp.apiBaseUrl.replace(/\/$/, '')}/assets/${encodeURIComponent(assetId)}/fields`;
    const execRows = rowsForAsset.map(row => {
      let values = String(row.resolvedValueIds || '').split(';').map(v => v.trim()).filter(Boolean);
      if (!values.length) values = row.valueMode === 'raw-text' ? [rawCellString(row.xlsxValue)].filter(Boolean) : parseCellValues(row.xlsxValue);
      return { ...row, operationRunId: runId, requestEndpoint: endpoint, updateMode: 'merge-bulk-fields', payloadType: row.cmpFieldType || 'text', payloadValues: values.join('; '), status: 'PENDING', retryCount: 0, updatedAt: '' };
    });
    for (let attempt = 1; attempt <= retryCount; attempt++) {
      for (const r of execRows) r.retryCount = attempt - 1;
      try {
        const existingFields = await fetchAssetFields({ job, assetId, cmp, onLog });
        await onLog(`CMP tag merge: asset=${assetId}, existingFields=${existingFields.length}, updates=${rowsForAsset.length}.`);
        const body = bulkFieldPayloadFromExistingAndUpdates(existingFields, rowsForAsset);
        const data = await cmpRequest({ job, method: 'PUT', endpoint, tokenState: cmp.tokenState, refreshToken: cmp.refreshToken, onLog, phase: 'cmp-update-asset-fields-bulk', data: body });
        for (const r of execRows) { r.status = 'UPDATED'; r.responsePreview = responsePreview(data); r.updatedAt = now(); }
        updated += execRows.length;
        break;
      } catch (e) {
        for (const r of execRows) { r.status = 'FAILED'; r.error = e.message; r.updatedAt = now(); }
        if (attempt < retryCount && isRetryable(e)) { await onLog(`Tag bulk update retry ${attempt}/${retryCount} for asset=${assetId}: ${e.message}`, 'warn'); await new Promise(r => setTimeout(r, attempt * 1000)); continue; }
        failed += execRows.length;
        break;
      }
    }
    job.tagExecutionRows.push(...execRows);
  }
  await runLimited(Array.from(grouped.entries()), concurrency, updateAssetGroup);
  skipped = Math.max(0, (job.tagDryRunRows || []).length - dryRows.length);
  job.tagSummary = { ...(job.tagSummary || {}), operation: 'execute', operationRunId: runId, status: failed ? 'TAG_EXECUTION_INCOMPLETE' : 'TAG_EXECUTED', requestedUpdates: dryRows.length, updated, failed, skipped, tokenRefreshCount: job.tagSummary?.tokenRefreshCount || 0, executedAt: now() };
  job.status = job.tagSummary.status;
  await onLog(`Tag execution complete: updated=${updated}, failed=${failed}, skipped=${skipped}.`, failed ? 'warn' : 'info');
  return job;
}
