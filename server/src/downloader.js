import axios from 'axios';
import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import XLSX from 'xlsx';
import mime from 'mime-types';
import { nanoid } from 'nanoid';
import { Document, Packer, Paragraph, HeadingLevel, TextRun } from 'docx';
import { now, getAssetType } from './utils.js';

const dataDir = process.env.APP_DATA_DIR || path.resolve(process.cwd(), '../data');
const outputDir = process.env.APP_OUTPUT_DIR || (await fs.stat('/host-app').then(() => '/host-app').catch(() => path.resolve(process.cwd(), '..')));
const downloadRoot = outputDir;
const samplePath = path.join(outputDir, 'sample-assets-download.xlsx');
const DEFAULT_CMP_API_BASE = 'https://api.cmp.optimizely.com/v3';
const DEFAULT_TOKEN_URL = 'https://accounts.cmp.optimizely.com/o/oauth2/v1/token';
const MAX_DOWNLOAD_MB = Number(process.env.MAX_DOWNLOAD_MB || 250);
const CMP_PAGE_SIZE = Number(process.env.CMP_DOWNLOAD_PAGE_SIZE || 100);
const DOWNLOAD_CONCURRENCY = Number(process.env.DOWNLOAD_CONCURRENCY || 10);
const MAX_DOWNLOAD_RETRIES = Number(process.env.MAX_DOWNLOAD_RETRIES || 3);

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function maskSecret(value = '') {
  const s = String(value || '');
  if (!s) return '';
  if (s.length <= 8) return '***';
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}
function safeHeaderValue(value = '') { return String(value || '').replace(/Bearer\s+[^\s]+/gi, 'Bearer ***'); }
function responsePreview(data) {
  if (data == null) return '';
  try {
    if (Buffer.isBuffer(data)) return `<binary:${data.length}>`;
    if (typeof data === 'string') return data.slice(0, 500);
    const clean = JSON.parse(JSON.stringify(data));
    if (clean.access_token) clean.access_token = '***';
    if (clean.refresh_token) clean.refresh_token = '***';
    return JSON.stringify(clean).slice(0, 1200);
  } catch { return '[unserializable response]'; }
}
function httpStatusSummary(res) {
  return {
    status: res.status,
    statusText: res.statusText || '',
    contentType: res.headers?.['content-type'] || '',
    contentLength: res.headers?.['content-length'] || '',
    requestId: res.headers?.['x-request-id'] || res.headers?.['x-correlation-id'] || ''
  };
}
function pushHttpEvent(job, event = {}) {
  const events = job.downloadHttpEvents || [];
  events.push({ id: nanoid(), at: now(), operationRunId: job.currentDownloadRunId || job.downloadSummary?.operationRunId || '', operationMode: job.currentDownloadOperationMode || job.downloadSummary?.operationMode || '', ...event });
  job.downloadHttpEvents = events.slice(-3000);
}
function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function safePart(value = '') { return String(value || '').replace(/[\\/:*?"<>|\x00-\x1F]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 160) || 'root'; }
function extFromUrl(url = '') { try { return path.extname(new URL(url).pathname); } catch { return path.extname(url); } }
function getFileNameFromDisposition(header = '') {
  const m = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(header || '');
  return m ? decodeURIComponent(m[1].replace(/"/g, '')) : '';
}
function hasMeaningfulExtension(name = '') {
  const ext = path.extname(String(name || '').split('?')[0]);
  return !!ext && ext.length <= 12;
}
function contentTypeToExt(contentType = '') {
  const ct = String(contentType || '').split(';')[0].trim().toLowerCase();
  const explicit = {
    'application/pdf': '.pdf',
    'application/msword': '.doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.ms-excel': '.xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'application/vnd.ms-powerpoint': '.ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
    'application/postscript': '.ai',
    'application/illustrator': '.ai',
    'image/vnd.adobe.photoshop': '.psd'
  };
  if (explicit[ct]) return explicit[ct];
  const ext = mime.extension(ct);
  return ext ? `.${ext}` : '';
}
function isLikelySignedTokenName(name = '') {
  const clean = String(name || '').replace(/\.[a-z0-9]{1,8}$/i, '');
  if (!clean) return true;
  if (/^[A-Za-z0-9_-]{24,}={0,2}$/.test(clean)) return true;
  if (/^[a-f0-9]{24,}$/i.test(clean)) return true;
  return false;
}
function filenameFromUrlIfSafe(url = '') {
  try {
    const base = path.basename(new URL(url || '').pathname || '');
    if (!base || !hasMeaningfulExtension(base) || isLikelySignedTokenName(base)) return '';
    return base;
  } catch { return ''; }
}
function sanitizeFileNamePreserveExt(name = '', fallbackExt = '') {
  const raw = String(name || '').trim();
  const ext = path.extname(raw) || fallbackExt || '';
  const base = path.basename(raw, path.extname(raw)) || 'asset';
  return `${safePart(base)}${ext}`;
}

function stripHtml(value = '') {
  return String(value || '')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function textParagraphs(value = '') {
  const text = stripHtml(value);
  if (!text) return [];
  return text.split(/\n{1,}/).map(t => t.trim()).filter(Boolean);
}
function articleTextCandidates(asset = {}) {
  const candidates = [];
  const keys = ['body','content','article_body','articleBody','html','html_body','htmlBody','description','summary','excerpt','text','copy'];
  for (const key of keys) {
    const v = asset[key];
    if (typeof v === 'string' && v.trim()) candidates.push({ label: key, value: v });
  }
  for (const containerKey of ['article','data','attributes','metadata','fields']) {
    const obj = asset[containerKey];
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
    for (const key of keys) {
      const v = obj[key];
      if (typeof v === 'string' && v.trim()) candidates.push({ label: `${containerKey}.${key}`, value: v });
    }
  }
  return candidates;
}
function isCmpArticleAsset(asset = {}) {
  const type = String(asset.type || asset.asset_type || asset.assetType || asset.kind || '').toLowerCase();
  const ct = String(assetContentType(asset) || '').toLowerCase();
  return type === 'article' || ct === 'application/x-article' || ct.includes('x-article');
}
async function exportCmpArticleAsDocx({ asset = {}, job, source = 'cmp-dam', folderPath = '', metadata = {}, requestEndpoint = '', onLog = async()=>{} }) {
  const startedAt = now();
  const root = ensureDownloadFolder(job);
  const cleanFolderPath = normalizedFolderPath(folderPath);
  const targetFolder = cleanFolderPath === '/' ? root : path.join(root, ...cleanFolderPath.split(/[\/]+/).filter(Boolean).map(safePart));
  await fs.mkdir(targetFolder, { recursive: true });

  const title = metadata.title || assetTitle(asset) || 'CMP Article';
  const id = metadata.assetId || assetId(asset);
  const guid = metadata.assetGuid || assetGuid(asset);
  const fields = articleTextCandidates(asset);
  const children = [
    new Paragraph({ text: title, heading: HeadingLevel.TITLE }),
    new Paragraph({ children: [new TextRun({ text: `Asset ID: ${id || 'N/A'}`, bold: true })] }),
    new Paragraph({ children: [new TextRun({ text: `Asset GUID: ${guid || 'N/A'}`, bold: true })] }),
    new Paragraph({ children: [new TextRun({ text: `Exported from CMP article asset`, italics: true })] }),
    new Paragraph({ text: '' })
  ];

  if (fields.length) {
    for (const field of fields) {
      children.push(new Paragraph({ text: field.label, heading: HeadingLevel.HEADING_2 }));
      for (const para of textParagraphs(field.value)) children.push(new Paragraph({ text: para }));
    }
  } else {
    children.push(new Paragraph({ text: 'Article content was not exposed in the CMP asset payload. The document below contains available asset metadata.', heading: HeadingLevel.HEADING_2 }));
    children.push(new Paragraph({ text: `Title: ${title}` }));
    children.push(new Paragraph({ text: `Asset ID: ${id || ''}` }));
    children.push(new Paragraph({ text: `Folder: ${metadata.cmpFolderName || 'Home'} (${cleanFolderPath})` }));
    if (asset.description) children.push(new Paragraph({ text: stripHtml(asset.description) }));
  }

  const doc = new Document({ sections: [{ properties: {}, children }] });
  const buffer = await Packer.toBuffer(doc);
  const baseName = sanitizeFileNamePreserveExt(`${title}.docx`, '.docx');
  const { path: localPath, fileName: finalName } = await uniqueLocalFilePath(targetFolder, baseName);
  await fs.writeFile(localPath, buffer);
  const relativePath = path.relative(outputDir, localPath);
  await onLog(`Exported CMP article asset as DOCX: ${relativePath}`);
  return {
    id: nanoid(), source, sourceUrl: '', requestEndpoint, httpStatus: '', httpContentType: '',
    title, assetTitle: title, assetId: id || '', assetGuid: guid || '', cmpFolderId: metadata.cmpFolderId || '', cmpFolderName: normalizedFolderName(metadata.cmpFolderName),
    folderPath: cleanFolderPath, originalFileName: `${title}.docx`, savedFileName: finalName, fileName: finalName, fileNameSource: 'cmp-article-docx-export',
    localFilePath: localPath, localRelativePath: relativePath,
    downloadFolder: path.relative(outputDir, targetFolder), downloadRoot: job.downloadFolderRelativePath || path.relative(outputDir, root),
    assetType: 'article', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', sourceContentType: assetContentType(asset) || 'application/x-article',
    sizeBytes: buffer.length, checksum: sha256(buffer), status: 'DOWNLOADED', retryCount: 0, startedAt, downloadedAt: now(), exportFormat: 'docx'
  };
}
async function uniqueLocalFilePath(targetFolder, desiredName) {
  const cleanName = sanitizeFileNamePreserveExt(desiredName || `asset-${nanoid(8)}`);
  const ext = path.extname(cleanName);
  const base = path.basename(cleanName, ext);
  let candidate = path.join(targetFolder, cleanName);
  let i = 1;
  while (true) {
    try { await fs.access(candidate); }
    catch { return { path: candidate, fileName: path.basename(candidate) }; }
    candidate = path.join(targetFolder, `${base} (${i})${ext}`);
    i += 1;
  }
}
function resolveLocalFileName({ metadata = {}, dispositionName = '', responseContentType = '', url = '' }) {
  const originalFileName = metadata.originalFileName || metadata.fileName || '';
  const originalContentType = metadata.originalContentType || metadata.contentType || '';
  const ext = path.extname(originalFileName)
    || path.extname(dispositionName)
    || contentTypeToExt(originalContentType)
    || contentTypeToExt(responseContentType)
    || extFromUrl(url)
    || '';

  let source = 'generated';
  let desired = '';
  if (originalFileName && hasMeaningfulExtension(originalFileName) && !isLikelySignedTokenName(originalFileName)) {
    desired = originalFileName; source = 'cmp-original-file-name';
  } else if (dispositionName && hasMeaningfulExtension(dispositionName) && !isLikelySignedTokenName(dispositionName)) {
    desired = dispositionName; source = 'content-disposition';
  } else if (metadata.title) {
    desired = `${metadata.title}${ext || ''}`; source = 'asset-title-plus-extension';
  } else if (metadata.assetId) {
    desired = `${metadata.assetId}${ext || ''}`; source = 'asset-id-plus-extension';
  } else {
    const safeUrlName = filenameFromUrlIfSafe(url);
    desired = safeUrlName || `asset-${nanoid(8)}${ext || ''}`;
    source = safeUrlName ? 'safe-url-basename' : 'generated';
  }
  return { desiredFileName: sanitizeFileNamePreserveExt(desired, ext), originalFileName: originalFileName || dispositionName || '', fileNameSource: source };
}
function uniqueName(fileName, fallbackExt = '') {
  const clean = sanitizeFileNamePreserveExt(fileName || `asset-${nanoid(8)}${fallbackExt || ''}`, fallbackExt);
  return clean.includes('.') ? clean : `${clean}${fallbackExt || ''}`;
}
function formatFolderDate(d = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}
function ensureDownloadFolder(job) {
  if (!job.downloadFolderName) {
    job.downloadFolderName = `Downloaded on ${formatFolderDate(new Date())}`;
    job.downloadFolderRelativePath = job.downloadFolderName;
    job.downloadStartedAt = now();
  }
  return path.join(downloadRoot, job.downloadFolderName);
}
function parseRowsFromWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { defval: '' });
}
function first(row, keys) {
  const lower = Object.fromEntries(Object.entries(row).map(([k, v]) => [String(k).toLowerCase().trim(), v]));
  for (const key of keys) {
    const v = lower[key.toLowerCase()];
    if (v !== undefined && String(v).trim()) return String(v).trim();
  }
  return '';
}

function collectFileCandidates(asset = {}) {
  const candidates = [];
  const add = (item = {}, source = '') => {
    if (!item) return;
    if (typeof item === 'string') {
      if (/^https?:\/\//i.test(item)) candidates.push({ url: item, source });
      return;
    }
    if (typeof item !== 'object') return;
    const urlKeys = ['download_url','downloadUrl','original_url','originalUrl','asset_url','assetUrl','public_url','publicUrl','url','source_url','sourceUrl','file_url','fileUrl'];
    const nameKeys = ['original_file_name','originalFileName','file_name','fileName','filename','name','title'];
    const ctKeys = ['content_type','contentType','mime_type','mimeType','mime'];
    const sizeKeys = ['size_bytes','sizeBytes','file_size','fileSize','size'];
    const guidKeys = ['guid','file_guid','fileGuid','asset_guid','assetGuid','uuid','id'];
    const url = urlKeys.map(k => item[k]).find(v => typeof v === 'string' && /^https?:\/\//i.test(v)) || '';
    const fileName = nameKeys.map(k => item[k]).find(v => typeof v === 'string' && v.trim()) || '';
    const contentType = ctKeys.map(k => item[k]).find(v => typeof v === 'string' && v.trim()) || '';
    const sizeBytes = sizeKeys.map(k => item[k]).find(v => v !== undefined && v !== null && String(v).trim()) || '';
    const guid = guidKeys.map(k => item[k]).find(v => typeof v === 'string' && v.trim()) || '';
    const role = String(item.type || item.kind || item.role || item.variant || item.name || source || '').toLowerCase();
    if (url || fileName || guid || contentType) candidates.push({ url, fileName, contentType, sizeBytes, guid, role, source, raw: item });
  };

  add(asset.file, 'asset.file');
  add(asset.original_file, 'asset.original_file');
  add(asset.originalFile, 'asset.originalFile');
  for (const key of ['files','renditions','attachments','downloadUrls','download_links','urls']) {
    const v = asset[key];
    if (Array.isArray(v)) v.forEach(item => add(item, key));
    else if (v && typeof v === 'object') Object.values(v).forEach(item => add(item, key));
  }
  // Top-level candidate last, because top-level url can sometimes be preview/thumbnail.
  add(asset, 'asset');
  return candidates;
}
function candidateScore(c = {}, allowPreview = false) {
  const role = String(c.role || c.source || '').toLowerCase();
  const url = String(c.url || '').toLowerCase();
  const name = String(c.fileName || '').toLowerCase();
  let score = 0;
  if (c.url) score += 10;
  if (c.fileName && hasMeaningfulExtension(c.fileName) && !isLikelySignedTokenName(c.fileName)) score += 40;
  if (c.contentType) score += 10;
  if (/(original|source|master|download|raw)/i.test(role + ' ' + name + ' ' + url)) score += 50;
  if (/(thumbnail|thumb|preview|rendition|crop|resize|small|medium)/i.test(role + ' ' + name + ' ' + url)) score -= allowPreview ? 10 : 100;
  return score;
}
function bestFileCandidate(asset = {}, { allowPreview = false } = {}) {
  const candidates = collectFileCandidates(asset).filter(c => c.url || c.fileName || c.guid);
  candidates.sort((a,b) => candidateScore(b, allowPreview) - candidateScore(a, allowPreview));
  return candidates[0] || {};
}
function extractDownloadUrl(asset = {}, { allowPreview = false } = {}) {
  const candidate = bestFileCandidate(asset, { allowPreview });
  if (candidate.url) return candidate.url;
  const directKeys = allowPreview
    ? ['download_url','downloadUrl','original_url','originalUrl','asset_url','assetUrl','public_url','publicUrl','url','source_url','sourceUrl','thumbnail_url','thumbnailUrl']
    : ['download_url','downloadUrl','original_url','originalUrl','asset_url','assetUrl','public_url','publicUrl','source_url','sourceUrl'];
  for (const k of directKeys) if (typeof asset[k] === 'string' && /^https?:\/\//i.test(asset[k])) return asset[k];
  return '';
}
function originalFileNameFromAsset(asset = {}, url = '') {
  const candidate = bestFileCandidate(asset, { allowPreview: false });
  const name = candidate.fileName || asset.original_file_name || asset.originalFileName || asset.file_name || asset.fileName || asset.filename || asset.file?.name || asset.file?.file_name || asset.file?.fileName || '';
  if (name && hasMeaningfulExtension(name) && !isLikelySignedTokenName(name)) return String(name);
  return filenameFromUrlIfSafe(url);
}
function originalContentTypeFromAsset(asset = {}) {
  const candidate = bestFileCandidate(asset, { allowPreview: false });
  return candidate.contentType || assetContentType(asset) || '';
}
function originalSizeFromAsset(asset = {}) {
  const candidate = bestFileCandidate(asset, { allowPreview: false });
  return candidate.sizeBytes || assetSizeBytes(asset) || '';
}
function fileGuidFromAsset(asset = {}) {
  const candidate = bestFileCandidate(asset, { allowPreview: false });
  return candidate.guid || asset.file_guid || asset.fileGuid || asset.file?.guid || asset.file?.file_guid || '';
}
function assetTitle(asset = {}) { return asset.title || asset.name || asset.file_name || asset.fileName || asset.id || asset.asset_id || 'cmp-asset'; }
function assetId(asset = {}) { return asset.id || asset.asset_id || asset.assetId || asset.guid || asset.key || ''; }
function assetGuid(asset = {}) { return asset.guid || asset.asset_guid || asset.assetGuid || asset.uuid || asset.content_guid || ''; }

function assetContentType(asset = {}) {
  return asset.content_type || asset.contentType || asset.mime_type || asset.mimeType || asset.file?.content_type || asset.file?.contentType || asset.file?.mime_type || asset.file?.mimeType || '';
}
function assetSizeBytes(asset = {}) {
  return asset.size_bytes || asset.sizeBytes || asset.file_size || asset.fileSize || asset.size || asset.file?.size_bytes || asset.file?.sizeBytes || asset.file?.size || '';
}
function assetFileName(asset = {}, url = '') {
  return originalFileNameFromAsset(asset, url) || '';
}
function normalizeCmpAssetType(value = '') {
  const v = String(value || '').toLowerCase().trim();
  if (['image','video','article','raw_file','structured_content','audio'].includes(v)) return v;
  return '';
}
function classifyAssetTypeFromExtension(fileNameOrUrl = '', contentType = '') {
  const ext = (path.extname(String(fileNameOrUrl || '').split('?')[0]).replace('.', '') || '').toLowerCase();
  const ct = String(contentType || '').toLowerCase();
  if (ct.startsWith('image/') || ['jpg','jpeg','png','gif','webp','avif','svg','ico','bmp','tif','tiff'].includes(ext)) return 'image';
  if (ct.startsWith('video/') || ['mp4','mov','webm','avi','mkv','m4v','wmv','mpeg','mpg'].includes(ext)) return 'video';
  if (ct.startsWith('audio/') || ['mp3','wav','aac','m4a','ogg','flac'].includes(ext)) return 'audio';
  if (ct === 'application/x-article' || ct.includes('x-article')) return 'article';
  if (['pdf','doc','docx','rtf','txt','csv'].includes(ext)) return 'document';
  if (['xls','xlsx','xlsm'].includes(ext)) return 'spreadsheet';
  if (['ppt','pptx','pps','ppsx'].includes(ext)) return 'presentation';
  if (['ai','psd','eps','indd','sketch','fig','xd'].includes(ext)) return 'design-source';
  if (['zip','rar','7z','tar','gz'].includes(ext)) return 'archive';
  if (ct) return ct.split('/')[0] || 'raw_file';
  return 'raw_file';
}
function deriveAssetType(asset = {}, url = '', contentType = '') {
  const cmpType = normalizeCmpAssetType(asset.type || asset.asset_type || asset.assetType || asset.kind);
  const detected = classifyAssetTypeFromExtension(assetFileName(asset, url) || url, contentType || assetContentType(asset));
  // raw_file is too generic for migration reports, so prefer concrete file classification when available.
  if (cmpType && cmpType !== 'raw_file') return cmpType;
  return detected || cmpType || 'raw_file';
}
function findFirstUrlDeep(value) {
  if (!value) return '';
  if (typeof value === 'string') return /^https?:\/\//i.test(value) ? value : '';
  if (Array.isArray(value)) {
    for (const item of value) { const u = findFirstUrlDeep(item); if (u) return u; }
  } else if (typeof value === 'object') {
    for (const v of Object.values(value)) { const u = findFirstUrlDeep(v); if (u) return u; }
  }
  return '';
}
function primitiveValue(value) {
  if (value == null) return '';
  if (typeof value === 'object') return value.id || value.value_id || value.valueId || value.guid || value.uuid || value.key || value.name || value.label || value.title || value.value || JSON.stringify(value);
  return String(value);
}
function fieldValueArray(values) {
  if (values == null) return [];
  if (Array.isArray(values)) return values.flatMap(v => fieldValueArray(v));
  if (typeof values === 'object') {
    if (Array.isArray(values.values)) return fieldValueArray(values.values);
    if (Array.isArray(values.selected_values)) return fieldValueArray(values.selected_values);
    if (Array.isArray(values.selectedValues)) return fieldValueArray(values.selectedValues);
    if (Array.isArray(values.labels)) return fieldValueArray(values.labels);
    return [primitiveValue(values)].filter(Boolean);
  }
  return [String(values)].filter(Boolean);
}
function flattenFieldValues(values) {
  return fieldValueArray(values).join('; ');
}
function labelLookupKeys(value) {
  const v = String(value || '').trim();
  if (!v) return [];
  return [v, v.toLowerCase()];
}
function resolveFieldValues(values, labelValueMap = {}) {
  return fieldValueArray(values).map(v => {
    for (const key of labelLookupKeys(v)) {
      if (labelValueMap[key]) return labelValueMap[key];
    }
    return v;
  }).join('; ');
}
function fieldNameFromRecord(f = {}) {
  return f.name || f.label || f.title || f.field_name || f.fieldName || f.key || f.id || 'Unnamed Field';
}
function fieldRowsForAsset(asset, fieldsPayload, labelValueMap = {}) {
  const rows = listRows(fieldsPayload, 'fields');
  return rows.map(f => {
    const rawValues = f.values ?? f.value ?? f.selected_values ?? f.selectedValues ?? f.labels ?? f.options;
    const fieldType = f.type || f.field_type || f.fieldType || '';
    const isLabel = String(fieldType || '').toLowerCase().includes('label') || !!f.label_group_id || !!f.labelGroupId || !!f.labels;
    return {
      source: 'cmp-dam',
      assetTitle: assetTitle(asset),
      assetId: assetId(asset),
      assetGuid: assetGuid(asset),
      fieldId: f.id || f.field_id || f.fieldId || '',
      fieldName: fieldNameFromRecord(f),
      fieldType,
      isLabel,
      values: resolveFieldValues(rawValues, labelValueMap),
      rawValues: flattenFieldValues(rawValues),
      rawJson: responsePreview(f)
    };
  });
}
function labelGroupRowsFromPayload(payload) {
  const groups = listRows(payload, 'label_groups');
  const rows = [];
  function visitOption(option = {}, group = {}) {
    const valueId = option.id || option.value_id || option.valueId || option.guid || option.uuid || option.key || option.value || '';
    const optionName = option.name || option.label || option.title || option.display_name || option.displayName || option.value || '';
    if (valueId || optionName) rows.push({
      labelGroupId: group.id || group.group_id || group.groupId || group.guid || group.uuid || '',
      labelGroupName: group.name || group.label || group.title || group.display_name || group.displayName || '',
      optionId: valueId,
      optionName,
      rawJson: responsePreview(option)
    });
    for (const key of ['options','values','labels','children','items']) {
      if (Array.isArray(option[key])) option[key].forEach(child => visitOption(child, group));
    }
  }
  for (const group of groups) {
    for (const key of ['options','values','labels','children','items']) {
      if (Array.isArray(group[key])) group[key].forEach(option => visitOption(option, group));
    }
  }
  return rows;
}
function buildLabelValueMap(labelGroupRows = []) {
  const map = {};
  for (const row of labelGroupRows) {
    if (!row.optionId || !row.optionName) continue;
    for (const key of labelLookupKeys(row.optionId)) map[key] = row.optionName;
  }
  return map;
}

function folderPathFromAsset(asset = {}, fallback = '') {
  return asset.__folderPath || asset.folder_path || asset.folderPath || asset.folder?.path || asset.folder?.name || asset.folder_name || asset.folderName || fallback || '';
}
function folderIdFromAsset(asset = {}, fallback = '') { return asset.__folderId || asset.folder_id || asset.folderId || asset.folder?.id || fallback || ''; }
function folderNameFromAsset(asset = {}, fallback = '') { return asset.__folderName || asset.folder?.name || asset.folder_name || asset.folderName || fallback || ''; }
function normalizedFolderPath(value = '') { const v = String(value || '').trim().replace(/^\/+|\/+$/g, ''); return v || '/'; }
function normalizedFolderName(value = '') { return String(value || '').trim() || 'Home'; }
function folderRecordId(folder = {}) { return folder.id || folder.folder_id || folder.folderId || folder.guid || folder.uuid || ''; }
function folderRecordName(folder = {}) { return folder.name || folder.title || folder.folder_name || folder.folderName || folder.id || 'folder'; }
function folderRecordPath(folder = {}, parentPath = '') {
  const explicit = folder.path || folder.folder_path || folder.folderPath || folder.full_path || folder.fullPath;
  if (explicit) return String(explicit).replace(/^\/+/, '');
  const name = folderRecordName(folder);
  return [parentPath, name].filter(Boolean).join('/');
}
function listRows(data, preferredKey = '') {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  for (const key of [preferredKey, 'folders', 'assets', 'results', 'items', 'data', 'records']) {
    if (key && Array.isArray(data[key])) return data[key];
  }
  return [];
}
function decorateAssetFolder(asset, folderCtx = {}) {
  if (!asset || typeof asset !== 'object') return asset;
  return {
    ...asset,
    __folderId: asset.__folderId || folderIdFromAsset(asset, folderCtx.id || ''),
    __folderName: asset.__folderName || folderNameFromAsset(asset, folderCtx.name || ''),
    __folderPath: asset.__folderPath || folderPathFromAsset(asset, folderCtx.path || '')
  };
}

function alreadyDownloadedKeys(job) {
  const s = new Set();
  for (const a of job.downloadedAssets || []) {
    if (a.status !== 'DOWNLOADED') continue;
    if (a.assetId) s.add(`id:${a.assetId}`);
    if (a.sourceUrl) s.add(`url:${a.sourceUrl}`);
  }
  return s;
}

async function ensureSampleXlsx() {
  await fs.mkdir(path.dirname(samplePath), { recursive: true });
  try { await fs.access(samplePath); return samplePath; } catch {}
  const rows = [
    { source_url: 'https://www.example.com/globalassets/images/hero-banner.jpg', file_name: 'hero-banner.jpg', folder_path: 'Global Assets/Images/Hero', title: 'Hero Banner', asset_id: '', asset_guid: '', notes: 'Replace with customer asset URL' },
    { source_url: 'https://www.example.com/globalassets/documents/company-brochure.pdf', file_name: 'company-brochure.pdf', folder_path: 'Global Assets/Documents/Brochures', title: 'Company Brochure', asset_id: '', asset_guid: '', notes: 'PDF example' },
    { source_url: 'https://www.example.com/globalassets/video/overview.mp4', file_name: 'overview.mp4', folder_path: 'Global Assets/Video', title: 'Overview Video', asset_id: '', asset_guid: '', notes: 'Video example' }
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Assets');
  XLSX.writeFile(wb, samplePath);
  return samplePath;
}

async function downloadUrlToDisk({ url, job, jobId, source, folderPath = '', fileName = '', metadata = {}, onLog = async()=>{}, authToken = '' }) {
  const startedAt = now();
  const root = ensureDownloadFolder(job);
  const cleanFolderPath = normalizedFolderPath(folderPath);
  const targetFolder = cleanFolderPath === '/' ? root : path.join(root, ...cleanFolderPath.split(/[\/]+/).filter(Boolean).map(safePart));
  await fs.mkdir(targetFolder, { recursive: true });
  const baseHeaders = { 'User-Agent': 'OptiDAM-Copilot/2.8 AssetDownloader' };
  if (authToken) baseHeaders.Authorization = `Bearer ${authToken}`;
  let lastError;
  for (let attempt = 1; attempt <= MAX_DOWNLOAD_RETRIES; attempt++) {
    await onLog(`HTTP GET asset download endpoint: ${url} (attempt ${attempt}/${MAX_DOWNLOAD_RETRIES})`);
    pushHttpEvent(job, { phase: 'asset-download', method: 'GET', url, request: { responseType: 'arraybuffer', maxDownloadMb: MAX_DOWNLOAD_MB, attempt, headers: { Authorization: authToken ? 'Bearer ***' : undefined } }, status: 'STARTED' });
    try {
      const res = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 120000,
        maxContentLength: MAX_DOWNLOAD_MB * 1024 * 1024,
        headers: baseHeaders,
        validateStatus: s => s < 500
      });
      const statusInfo = httpStatusSummary(res);
      await onLog(`HTTP GET response: ${res.status} ${res.statusText || ''} | content-type=${statusInfo.contentType || 'unknown'} | content-length=${statusInfo.contentLength || 'unknown'}`);
      pushHttpEvent(job, { phase: 'asset-download', method: 'GET', url, status: res.status < 400 ? 'SUCCESS' : 'FAILED', response: statusInfo, attempt });
      if (res.status >= 400) throw new Error(`HTTP ${res.status} while downloading ${url}`);
      const buffer = Buffer.from(res.data);
      const responseContentType = res.headers['content-type'] || '';
      const contentType = metadata.originalContentType || metadata.contentType || responseContentType || mime.lookup(metadata.originalFileName || url) || '';
      const dispositionName = getFileNameFromDisposition(res.headers['content-disposition']);
      const nameInfo = resolveLocalFileName({ metadata: { ...metadata, fileName }, dispositionName, responseContentType, url });
      const { path: localPath, fileName: finalName } = await uniqueLocalFilePath(targetFolder, nameInfo.desiredFileName);
      await fs.writeFile(localPath, buffer);
      const relativePath = path.relative(outputDir, localPath);
      await onLog(`Saved file locally: ${relativePath} (filename source: ${nameInfo.fileNameSource})`);
      return {
        id: nanoid(), source, sourceUrl: url, requestEndpoint: url, httpStatus: res.status, httpContentType: responseContentType,
        title: metadata.title || '', assetTitle: metadata.title || '', assetId: metadata.assetId || '', assetGuid: metadata.assetGuid || '', cmpFolderId: metadata.cmpFolderId || '', cmpFolderName: normalizedFolderName(metadata.cmpFolderName),
        folderPath: cleanFolderPath, originalFileName: nameInfo.originalFileName || metadata.originalFileName || '', savedFileName: finalName, fileName: finalName, fileNameSource: nameInfo.fileNameSource,
        localFilePath: localPath, localRelativePath: relativePath,
        downloadFolder: path.relative(outputDir, targetFolder), downloadRoot: job.downloadFolderRelativePath || path.relative(outputDir, root),
        assetType: metadata.assetType || classifyAssetTypeFromExtension(finalName || metadata.originalFileName || url, contentType), contentType, sizeBytes: buffer.length, checksum: sha256(buffer),
        status: 'DOWNLOADED', retryCount: attempt - 1, startedAt, downloadedAt: now()
      };
    } catch (e) {
      lastError = e;
      pushHttpEvent(job, { phase: 'asset-download', method: 'GET', url, status: 'FAILED', error: e.message, attempt });
      if (attempt < MAX_DOWNLOAD_RETRIES) {
        await onLog(`Download attempt ${attempt} failed. Retrying: ${e.message}`, 'warn');
        await sleep(700 * attempt);
      }
    }
  }
  throw lastError;
}

async function runPool(items, concurrency, worker) {
  const out = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length || 1) }, async () => {
    while (index < items.length) {
      const i = index++;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function createSampleDownloadXlsx() { return ensureSampleXlsx(); }

export async function downloadAssetsFromXlsx(job, xlsxUrl, onLog = async () => {}) {
  await ensureSampleXlsx();
  job.downloadHttpEvents = job.downloadHttpEvents || [];
  ensureDownloadFolder(job);
  await onLog(`Download root folder in app directory: ${job.downloadFolderRelativePath}`);
  await onLog(`XLSX MANIFEST GET endpoint: ${xlsxUrl}`);
  pushHttpEvent(job, { phase: 'xlsx-manifest', method: 'GET', url: xlsxUrl, status: 'STARTED' });
  const res = await axios.get(xlsxUrl, { responseType: 'arraybuffer', timeout: 60000, validateStatus: s => s < 500 });
  await onLog(`XLSX MANIFEST response: HTTP ${res.status} ${res.statusText || ''} | content-type=${res.headers['content-type'] || 'unknown'}`);
  pushHttpEvent(job, { phase: 'xlsx-manifest', method: 'GET', url: xlsxUrl, status: res.status < 400 ? 'SUCCESS' : 'FAILED', response: httpStatusSummary(res) });
  if (res.status >= 400) throw new Error(`XLSX manifest download failed. HTTP ${res.status}`);
  const rows = parseRowsFromWorkbook(Buffer.from(res.data));
  await onLog(`XLSX parsed with ${rows.length} row(s).`);
  const items = rows.map((row, idx) => ({
    rowNumber: idx + 2,
    url: first(row, ['source_url','asset_url','download_url','cmp_url','url','asset link','asset_link']),
    fileName: first(row, ['file_name','filename','name']),
    folderPath: first(row, ['folder_path','folder','path','dam_folder']),
    title: first(row, ['title','asset_title']),
    assetId: first(row, ['asset_id','assetid','id']),
    assetGuid: first(row, ['asset_guid','guid','assetguid']),
    raw: row
  })).filter(item => item.url);

  const existing = alreadyDownloadedKeys(job);
  const downloaded = [];
  const failed = [];
  const skipped = [];
  await runPool(items, DOWNLOAD_CONCURRENCY, async (item, i) => {
    try {
      if (existing.has(`url:${item.url}`)) {
        const rec = { id: nanoid(), source: 'xlsx-link', sourceUrl: item.url, folderPath: normalizedFolderPath(item.folderPath), cmpFolderName: normalizedFolderName(''), title: item.title, assetId: item.assetId, assetGuid: item.assetGuid, status: 'SKIPPED_ALREADY_DOWNLOADED', manifestRow: item.rowNumber, attemptedAt: now() };
        skipped.push(rec);
        await onLog(`Skipping row ${item.rowNumber}; already downloaded in this job.`);
        return;
      }
      await onLog(`XLSX asset ${i + 1}/${items.length}: ${item.url}`);
      const result = await downloadUrlToDisk({ url: item.url, job, jobId: job.id, source: 'xlsx-link', folderPath: item.folderPath, fileName: item.fileName, metadata: { title: item.title, assetId: item.assetId, assetGuid: item.assetGuid }, onLog });
      downloaded.push({ ...result, manifestRow: item.rowNumber });
    } catch (e) {
      const fail = { id: nanoid(), source: 'xlsx-link', sourceUrl: item.url, folderPath: normalizedFolderPath(item.folderPath), cmpFolderName: normalizedFolderName(''), fileName: item.fileName, title: item.title, assetId: item.assetId, assetGuid: item.assetGuid, status: 'FAILED', error: e.message, manifestRow: item.rowNumber, attemptedAt: now() };
      failed.push(fail);
      await onLog(`Failed XLSX asset row ${item.rowNumber}: ${e.message}`, 'error');
    }
  });
  job.downloadedAssets = [...(job.downloadedAssets || []), ...downloaded, ...failed, ...skipped];
  job.status = 'ASSETS_DOWNLOADED';
  job.downloadSummary = {
    source: 'xlsx-link', manifestRows: rows.length, requested: items.length, downloaded: downloaded.length, failed: failed.length, skipped: skipped.length,
    downloadRoot: job.downloadFolderRelativePath, localDownloadFolder: job.downloadFolderRelativePath, lastDownloadAt: now(), httpEvents: (job.downloadHttpEvents || []).length
  };
  return job;
}

async function getCmpAccessToken({ job, clientId, clientSecret, tokenUrl = DEFAULT_TOKEN_URL, onLog = async()=>{} }) {
  const payload = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' });
  await onLog(`AUTH POST token endpoint: ${tokenUrl}`);
  await onLog(`AUTH request body: grant_type=client_credentials, client_id=${maskSecret(clientId)}, client_secret=***`);
  pushHttpEvent(job, { phase: 'auth', method: 'POST', url: tokenUrl, status: 'STARTED', request: { grant_type: 'client_credentials', client_id: maskSecret(clientId), client_secret: '***' } });
  let res;
  try {
    res = await axios.post(tokenUrl, payload.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 60000, validateStatus: s => s < 500 });
  } catch (e) {
    pushHttpEvent(job, { phase: 'auth', method: 'POST', url: tokenUrl, status: 'FAILED', error: e.message });
    throw e;
  }
  const ok = res.status >= 200 && res.status < 300 && !!res.data?.access_token;
  await onLog(`AUTH response: HTTP ${res.status} ${res.statusText || ''} | access_token=${ok ? 'received' : 'not received'}`, ok ? 'info' : 'error');
  pushHttpEvent(job, { phase: 'auth', method: 'POST', url: tokenUrl, status: ok ? 'SUCCESS' : 'FAILED', response: { ...httpStatusSummary(res), bodyPreview: responsePreview(res.data) } });
  if (!ok) throw new Error(`CMP authentication failed. HTTP ${res.status}. ${responsePreview(res.data)}`);
  return { token: res.data.access_token, expiresAt: Date.now() + Number(res.data.expires_in || 3600) * 1000 };
}

async function cmpGet({ job, endpoint, tokenState, refreshToken, onLog, phase }) {
  const request = async () => axios.get(endpoint, { headers: { Authorization: `Bearer ${tokenState.token}`, accept: 'application/json' }, timeout: 60000, validateStatus: s => s < 500 });
  await onLog(`${phase.toUpperCase()} GET endpoint: ${endpoint}`);
  pushHttpEvent(job, { phase, method: 'GET', url: endpoint, status: 'STARTED', request: { headers: { Authorization: 'Bearer ***', accept: 'application/json' } } });
  let res = await request();
  if (res.status === 401 || res.status === 403) {
    await onLog(`${phase.toUpperCase()} received HTTP ${res.status}. Refreshing bearer token and retrying once.`, 'warn');
    pushHttpEvent(job, { phase, method: 'GET', url: endpoint, status: 'TOKEN_REFRESH_RETRY', response: { ...httpStatusSummary(res), bodyPreview: responsePreview(res.data) } });
    const refreshed = await refreshToken();
    tokenState.token = refreshed.token;
    tokenState.expiresAt = refreshed.expiresAt;
    res = await request();
  }
  await onLog(`${phase.toUpperCase()} response: HTTP ${res.status} ${res.statusText || ''}`);
  pushHttpEvent(job, { phase, method: 'GET', url: endpoint, status: res.status < 400 ? 'SUCCESS' : 'FAILED', response: { ...httpStatusSummary(res), bodyPreview: responsePreview(res.data) } });
  return res;
}

async function listCmpAssets({ job, apiBaseUrl = DEFAULT_CMP_API_BASE, tokenState, refreshToken, folderId, includeSubfolders = true, searchText = '', assetTypes = ['article','image','video','raw_file','structured_content'], downloadAll = false, onLog = async()=>{} }) {
  const assets = [];
  let offset = 0;
  const pageSize = Math.min(100, Math.max(1, CMP_PAGE_SIZE));
  let page = 1;
  while (true) {
    const params = new URLSearchParams();
    for (const t of assetTypes) params.append('type', t);
    if (folderId) params.set('folder_id', folderId);
    params.set('include_subfolder_assets', String(!!includeSubfolders));
    if (searchText) params.set('search_text', searchText);
    params.set('offset', String(offset));
    params.set('page_size', String(pageSize));
    const endpoint = `${apiBaseUrl.replace(/\/$/, '')}/assets?${params.toString()}`;
    const res = await cmpGet({ job, endpoint, tokenState, refreshToken, onLog, phase: 'cmp-list-assets' });
    const data = res.data;
    if (res.status >= 400) throw new Error(`CMP asset list failed. HTTP ${res.status}. ${responsePreview(data)}`);
    const rows = Array.isArray(data) ? data : (data.assets || data.results || data.items || data.data || []);
    assets.push(...rows);
    await onLog(`CMP pagination page ${page}: fetched ${rows.length}; total collected ${assets.length}.`);
    if (!downloadAll) break;
    if (!rows.length || rows.length < pageSize) break;
    offset += rows.length;
    page += 1;
    if (page > 10000) throw new Error('CMP pagination safety stop reached after 10,000 pages. Narrow the folder/search criteria.');
  }
  return assets;
}

async function getCmpAssetById({ job, apiBaseUrl = DEFAULT_CMP_API_BASE, tokenState, refreshToken, id, onLog = async()=>{} }) {
  const endpoint = `${apiBaseUrl.replace(/\/$/, '')}/assets/${encodeURIComponent(id)}`;
  const res = await cmpGet({ job, endpoint, tokenState, refreshToken, onLog, phase: 'cmp-get-asset' });
  if (res.status >= 400) throw new Error(`GET /assets/${id} returned HTTP ${res.status}. ${responsePreview(res.data)}`);
  return res.data;
}


async function getCmpAssetFields({ job, apiBaseUrl = DEFAULT_CMP_API_BASE, tokenState, refreshToken, asset, onLog = async()=>{} }) {
  const id = assetId(asset);
  if (!id) throw new Error('Cannot fetch CMP asset fields because asset id is missing.');
  const allRows = [];
  let offset = 0;
  const pageSize = Math.min(100, Math.max(1, CMP_PAGE_SIZE));
  let firstPayload = null;
  while (true) {
    const params = new URLSearchParams({ offset: String(offset), page_size: String(pageSize) });
    const endpoint = `${apiBaseUrl.replace(/\/$/, '')}/assets/${encodeURIComponent(id)}/fields?${params.toString()}`;
    const res = await cmpGet({ job, endpoint, tokenState, refreshToken, onLog, phase: 'cmp-get-asset-fields' });
    if (res.status >= 400) throw new Error(`GET /assets/${id}/fields returned HTTP ${res.status}. ${responsePreview(res.data)}`);
    if (!firstPayload) firstPayload = res.data;
    const rows = listRows(res.data, 'fields');
    allRows.push(...rows);
    if (!rows.length || rows.length < pageSize) break;
    offset += rows.length;
    if (offset > 100000) throw new Error(`Field pagination safety stop reached for asset ${id}.`);
  }
  if (Array.isArray(firstPayload)) return allRows;
  return { ...(firstPayload && typeof firstPayload === 'object' ? firstPayload : {}), fields: allRows };
}

async function listCmpLabelGroups({ job, apiBaseUrl = DEFAULT_CMP_API_BASE, tokenState, refreshToken, onLog = async()=>{} }) {
  const allRows = [];
  let offset = 0;
  const pageSize = Math.min(100, Math.max(1, CMP_PAGE_SIZE));
  let firstPayload = null;
  while (true) {
    const params = new URLSearchParams({ offset: String(offset), page_size: String(pageSize) });
    const endpoint = `${apiBaseUrl.replace(/\/$/, '')}/label-groups?${params.toString()}`;
    const res = await cmpGet({ job, endpoint, tokenState, refreshToken, onLog, phase: 'cmp-list-label-groups' });
    if (res.status >= 400) throw new Error(`GET /label-groups returned HTTP ${res.status}. ${responsePreview(res.data)}`);
    if (!firstPayload) firstPayload = res.data;
    const rows = listRows(res.data, 'label_groups');
    allRows.push(...rows);
    if (!rows.length || rows.length < pageSize) break;
    offset += rows.length;
    if (offset > 100000) throw new Error('Label group pagination safety stop reached.');
  }
  const payload = Array.isArray(firstPayload) ? allRows : { ...(firstPayload && typeof firstPayload === 'object' ? firstPayload : {}), label_groups: allRows };
  const labelRows = labelGroupRowsFromPayload(payload);
  await onLog(`CMP label groups fetched: ${allRows.length} group(s), ${labelRows.length} option value(s).`);
  return { groups: allRows, rows: labelRows, valueMap: buildLabelValueMap(labelRows) };
}

async function getCmpFileUrlByGuid({ job, apiBaseUrl = DEFAULT_CMP_API_BASE, tokenState, refreshToken, guid, onLog = async()=>{} }) {
  if (!guid) return '';
  const endpoint = `${apiBaseUrl.replace(/\/$/, '')}/file-urls`;
  const request = async () => axios.post(endpoint, { guids: [guid] }, { headers: { Authorization: `Bearer ${tokenState.token}`, accept: 'application/json', 'Content-Type': 'application/json' }, timeout: 60000, validateStatus: s => s < 500 });
  await onLog(`CMP FILE URL POST endpoint: ${endpoint} for guid=${guid}`);
  pushHttpEvent(job, { phase: 'cmp-file-urls', method: 'POST', url: endpoint, status: 'STARTED', request: { guids: [guid], headers: { Authorization: 'Bearer ***' } } });
  let res = await request();
  if (res.status === 401 || res.status === 403) {
    await onLog(`CMP FILE URL received HTTP ${res.status}. Refreshing bearer token and retrying once.`, 'warn');
    const refreshed = await refreshToken();
    tokenState.token = refreshed.token;
    tokenState.expiresAt = refreshed.expiresAt;
    res = await request();
  }
  const ok = res.status >= 200 && res.status < 300;
  pushHttpEvent(job, { phase: 'cmp-file-urls', method: 'POST', url: endpoint, status: ok ? 'SUCCESS' : 'FAILED', response: { ...httpStatusSummary(res), bodyPreview: responsePreview(res.data) } });
  await onLog(`CMP FILE URL response: HTTP ${res.status} ${res.statusText || ''}`);
  if (!ok) return '';
  return findFirstUrlDeep(res.data);
}

function makeAssetOverviewRecord(asset, { url = '', requestEndpoint = '', status = 'ANALYZED', error = '', localRelativePath = '', checksum = '', retryCount = '' } = {}) {
  const contentType = originalContentTypeFromAsset(asset) || (url ? mime.lookup(url) || '' : '');
  const originalFileName = originalFileNameFromAsset(asset, url);
  const fileName = originalFileName || (assetTitle(asset) ? `${assetTitle(asset)}${contentTypeToExt(contentType) || ''}` : '');
  const folderPath = normalizedFolderPath(folderPathFromAsset(asset, ''));
  return {
    id: nanoid(),
    source: 'cmp-dam',
    title: assetTitle(asset),
    assetTitle: assetTitle(asset),
    assetId: assetId(asset),
    assetGuid: assetGuid(asset),
    cmpFolderId: folderIdFromAsset(asset, ''),
    cmpFolderName: normalizedFolderName(folderNameFromAsset(asset, 'Home')),
    folderPath,
    sourceUrl: url || extractDownloadUrl(asset, { allowPreview: false }) || '',
    requestEndpoint,
    originalFileName,
    savedFileName: '',
    fileName,
    fileNameSource: originalFileName ? 'cmp-original-file-name' : 'metadata-title',
    assetType: deriveAssetType(asset, originalFileName || url, contentType),
    contentType,
    sizeBytes: originalSizeFromAsset(asset),
    status,
    error,
    localRelativePath,
    checksum,
    retryCount,
    rawAsset: asset,
    analyzedAt: now()
  };
}



async function getCmpFolderById({ job, apiBaseUrl = DEFAULT_CMP_API_BASE, tokenState, refreshToken, folderId, onLog = async()=>{} }) {
  if (!folderId) return null;
  const endpoint = `${apiBaseUrl.replace(/\/$/, '')}/folders/${encodeURIComponent(folderId)}`;
  try {
    const res = await cmpGet({ job, endpoint, tokenState, refreshToken, onLog, phase: 'cmp-get-folder' });
    if (res.status >= 400) {
      await onLog(`CMP folder metadata endpoint returned HTTP ${res.status}; using folder-${folderId} as local folder name.`, 'warn');
      return null;
    }
    return res.data;
  } catch (e) {
    await onLog(`CMP folder metadata lookup failed: ${e.message}. Continuing with fallback folder name.`, 'warn');
    return null;
  }
}

async function listCmpFolders({ job, apiBaseUrl = DEFAULT_CMP_API_BASE, tokenState, refreshToken, parentFolderId = '', onLog = async()=>{} }) {
  const folders = [];
  let offset = 0;
  const pageSize = Math.min(100, Math.max(1, CMP_PAGE_SIZE));
  let endpointFailed = false;
  while (true) {
    const params = new URLSearchParams();
    if (parentFolderId) params.set('parent_folder_id', parentFolderId);
    params.set('offset', String(offset));
    params.set('page_size', String(pageSize));
    const endpoint = `${apiBaseUrl.replace(/\/$/, '')}/folders?${params.toString()}`;
    const res = await cmpGet({ job, endpoint, tokenState, refreshToken, onLog, phase: 'cmp-list-folders' });
    if (res.status >= 400) {
      endpointFailed = true;
      await onLog(`CMP folder listing endpoint returned HTTP ${res.status}; folder-tree traversal will fallback to asset metadata/listing.`, 'warn');
      break;
    }
    const rows = listRows(res.data, 'folders');
    folders.push(...rows);
    await onLog(`CMP folder pagination: fetched ${rows.length}; total folders collected ${folders.length}.`);
    if (!rows.length || rows.length < pageSize) break;
    offset += rows.length;
    if (offset > 1000000) throw new Error('CMP folder pagination safety stop reached. Narrow the criteria.');
  }
  return endpointFailed ? null : folders;
}

function dedupeAssets(assets = []) {
  const seen = new Set();
  const out = [];
  for (const asset of assets) {
    const key = assetId(asset) ? `id:${assetId(asset)}` : extractDownloadUrl(asset) ? `url:${extractDownloadUrl(asset)}` : `obj:${JSON.stringify(asset).slice(0,200)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(asset);
  }
  return out;
}

async function discoverCmpAssetsFolderAware({ job, apiBaseUrl, tokenState, refreshToken, options, explicitIds, downloadAll, onLog }) {
  if (explicitIds.length) {
    const cmpAssets = [];
    await onLog(`Fetching ${explicitIds.length} explicit CMP asset id(s).`);
    for (const id of explicitIds) {
      try { cmpAssets.push(await getCmpAssetById({ job, apiBaseUrl, tokenState, refreshToken, id, onLog })); }
      catch (e) { cmpAssets.push({ id, status: 'FAILED_METADATA', error: e.message }); }
    }
    return { assets: cmpAssets, discoveryMode: 'explicit-asset-ids' };
  }

  const assetTypes = options.assetTypes || ['article','image','video','raw_file','structured_content'];
  const searchText = options.searchText || '';
  const allAssets = [];

  async function fetchAssetsForFolder(folderCtx, includeSubfolders = false) {
    const rows = await listCmpAssets({
      job, apiBaseUrl, tokenState, refreshToken,
      folderId: folderCtx.id || '',
      includeSubfolders,
      searchText,
      assetTypes,
      downloadAll: true,
      onLog
    });
    return rows.map(a => decorateAssetFolder(a, folderCtx));
  }

  async function traverseFolder(folderCtx) {
    allAssets.push(...await fetchAssetsForFolder(folderCtx, false));
    const childFolders = await listCmpFolders({ job, apiBaseUrl, tokenState, refreshToken, parentFolderId: folderCtx.id, onLog });
    if (childFolders === null) return false;
    for (const child of childFolders) {
      const childCtx = { id: folderRecordId(child), name: folderRecordName(child), path: folderRecordPath(child, folderCtx.path) };
      if (!childCtx.id) continue;
      await traverseFolder(childCtx);
    }
    return true;
  }

  if (downloadAll) {
    await onLog('CMP All Assets: attempting folder-tree traversal plus root-level assets.');
    allAssets.push(...await fetchAssetsForFolder({ id: '', name: '', path: '' }, false));
    const rootFolders = await listCmpFolders({ job, apiBaseUrl, tokenState, refreshToken, parentFolderId: '', onLog });
    if (rootFolders !== null) {
      for (const folder of rootFolders) {
        const ctx = { id: folderRecordId(folder), name: folderRecordName(folder), path: folderRecordPath(folder, '') };
        if (!ctx.id) continue;
        await traverseFolder(ctx);
      }
      return { assets: dedupeAssets(allAssets), discoveryMode: 'folder-tree-download-all' };
    }
    await onLog('Folder-tree traversal unavailable; falling back to paginated /assets All Assets. Folder paths will come from asset metadata when present.', 'warn');
    const fallbackAssets = await listCmpAssets({ job, apiBaseUrl, tokenState, refreshToken, folderId: '', includeSubfolders: true, searchText, assetTypes, downloadAll: true, onLog });
    return { assets: dedupeAssets(fallbackAssets), discoveryMode: 'paginated-assets-download-all-fallback' };
  }

  if (!options.folderId) throw new Error('Provide a Folder ID or choose All Assets.');
  const folderMeta = await getCmpFolderById({ job, apiBaseUrl, tokenState, refreshToken, folderId: options.folderId, onLog });
  const rootCtx = {
    id: options.folderId,
    name: folderMeta ? folderRecordName(folderMeta) : `folder-${options.folderId}`,
    path: folderMeta ? folderRecordPath(folderMeta, '') : `folder-${options.folderId}`
  };
  await onLog(`CMP folder download root: ${rootCtx.path} (${rootCtx.id})`);

  if (options.includeSubfolders !== false) {
    const ok = await traverseFolder(rootCtx);
    if (ok) return { assets: dedupeAssets(allAssets), discoveryMode: 'folder-tree-by-folder-id' };
    await onLog('Child folder traversal unavailable; falling back to /assets?folder_id=...&include_subfolder_assets=true.', 'warn');
    const fallbackAssets = await listCmpAssets({ job, apiBaseUrl, tokenState, refreshToken, folderId: options.folderId, includeSubfolders: true, searchText, assetTypes, downloadAll: true, onLog });
    return { assets: dedupeAssets(fallbackAssets.map(a => decorateAssetFolder(a, rootCtx))), discoveryMode: 'folder-id-include-subfolders-fallback' };
  }

  allAssets.push(...await fetchAssetsForFolder(rootCtx, false));
  return { assets: dedupeAssets(allAssets), discoveryMode: 'single-folder-no-subfolders' };
}


function cmpOperationLabel(operationMode = '') {
  if (operationMode === 'analyze-assets') return 'Downloads Assets Information Only';
  if (operationMode === 'analyze-assets-metadata') return 'Download CMP DAM Assets Info and Metadata';
  return 'Download Assets only';
}

export async function downloadAssetsFromCmp(job, options = {}, onLog = async () => {}) {
  const clientId = options.clientId || process.env.CMP_CLIENT_ID;
  const clientSecret = options.clientSecret || process.env.CMP_CLIENT_SECRET;
  const apiBaseUrl = options.apiBaseUrl || process.env.CMP_API_BASE_URL || DEFAULT_CMP_API_BASE;
  const tokenUrl = options.tokenUrl || process.env.CMP_TOKEN_URL || DEFAULT_TOKEN_URL;
  const operationMode = options.operationMode || options.cmpAssetOperation || 'download-assets';
  const shouldDownload = operationMode === 'download-assets';
  const includeFields = operationMode === 'analyze-assets-metadata';
  if (!clientId || !clientSecret) throw new Error('CMP Client ID and Client Secret are required.');

  // Start a clean, isolated CMP operation run. Previous scan/download/analyze rows remain in report history,
  // but the current XLSX and latest table must only use the selected CMP Asset Operation.
  const operationRunId = nanoid();
  job.currentDownloadRunId = operationRunId;
  job.currentDownloadOperationMode = operationMode;
  job.currentDownloadOperationLabel = cmpOperationLabel(operationMode);
  job.downloadedAssets = [];
  job.assetFieldRows = [];
  job.labelGroupRows = [];
  job.downloadHttpEvents = [];
  job.downloadSummary = {
    source: 'cmp-dam',
    operationMode,
    operationRunId,
    operationLabel: cmpOperationLabel(operationMode),
    startedAt: now(),
    status: 'RUNNING'
  };
  ensureDownloadFolder(job);
  await onLog(`Download/analyze root in app directory: ${job.downloadFolderRelativePath}`);
  await onLog(`CMP operation selected: ${operationMode}`);
  await onLog('Requesting CMP access token using client credentials flow.');
  const refreshToken = () => getCmpAccessToken({ job, clientId, clientSecret, tokenUrl, onLog });
  const tokenState = await refreshToken();
  await onLog('CMP access token received. Listing assets.');

  const explicitIds = String(options.assetIds || '').split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
  const downloadAll = !!options.downloadAll;
  const discovery = await discoverCmpAssetsFolderAware({ job, apiBaseUrl, tokenState, refreshToken, options, explicitIds, downloadAll, onLog });
  const cmpAssets = discovery.assets;

  await onLog(`CMP discovery mode: ${discovery.discoveryMode}. Returned ${cmpAssets.length} asset metadata record(s).`);
  let labelRows = [];
  let labelValueMap = {};
  if (includeFields) {
    await onLog('Metadata mode enabled: fetching label groups, then asset fields/labels using GET /assets/{asset_id}/fields.');
    try {
      const labelInfo = await listCmpLabelGroups({ job, apiBaseUrl, tokenState, refreshToken, onLog });
      labelRows = labelInfo.rows;
      labelValueMap = labelInfo.valueMap;
    } catch (e) {
      await onLog(`CMP label groups lookup failed: ${e.message}. Field values will be exported with raw IDs when option names cannot be resolved.`, 'warn');
    }
  }
  if (shouldDownload) await onLog(`Downloading binaries with ${DOWNLOAD_CONCURRENCY} parallel worker(s).`);

  const existing = alreadyDownloadedKeys(job);
  const downloaded = [];
  const failed = [];
  const metadataOnly = [];
  const skipped = [];
  const analyzed = [];
  const fieldRows = [];

  await runPool(cmpAssets, DOWNLOAD_CONCURRENCY, async (asset, i) => {
    const id = assetId(asset);
    const guid = assetGuid(asset);
    const title = assetTitle(asset);
    const metadataEndpoint = id ? `${apiBaseUrl.replace(/\/$/, '')}/assets/${encodeURIComponent(id)}` : '';
    try {
      if (asset.status === 'FAILED_METADATA') throw new Error(asset.error);

      if (includeFields && id) {
        try {
          const fieldsPayload = await getCmpAssetFields({ job, apiBaseUrl, tokenState, refreshToken, asset, onLog });
          const rows = fieldRowsForAsset(asset, fieldsPayload, labelValueMap);
          fieldRows.push(...rows);
          asset.__fieldCount = rows.length;
          await onLog(`CMP asset fields fetched for ${id}: ${rows.length} field/label row(s).`);
        } catch (e) {
          fieldRows.push({ source: 'cmp-dam', assetTitle: title, assetId: id, assetGuid: guid, fieldId: '', fieldName: '', fieldType: '', isLabel: '', values: '', error: e.message, rawJson: '' });
          await onLog(`CMP asset fields failed for ${id || title}: ${e.message}`, 'warn');
        }
      }

      if (!shouldDownload) {
        const url = extractDownloadUrl(asset, { allowPreview: false });
        analyzed.push(makeAssetOverviewRecord(asset, { url, requestEndpoint: metadataEndpoint || 'CMP asset listing endpoint', status: includeFields ? 'ANALYZED_WITH_METADATA' : 'ANALYZED' }));
        await onLog(`Analyzed CMP asset ${i + 1}/${cmpAssets.length}: ${id || title}`);
        return;
      }

      if (id && existing.has(`id:${id}`)) {
        const rec = makeAssetOverviewRecord(asset, { requestEndpoint: metadataEndpoint, status: 'SKIPPED_ALREADY_DOWNLOADED' });
        skipped.push(rec);
        await onLog(`Skipping CMP asset ${id}; already downloaded in this job.`);
        return;
      }

      const folderPath = folderPathFromAsset(asset, '');
      const cmpFolderId = folderIdFromAsset(asset, options.folderId || '');
      const cmpFolderName = folderNameFromAsset(asset, 'Home');
      if (isCmpArticleAsset(asset)) {
        const result = await exportCmpArticleAsDocx({
          asset, job, source: 'cmp-dam', folderPath, requestEndpoint: metadataEndpoint || 'CMP asset listing endpoint',
          metadata: { title, assetId: id, assetGuid: guid, cmpFolderId, cmpFolderName }, onLog
        });
        downloaded.push({ ...result, rawAsset: asset });
        return;
      }

      let url = extractDownloadUrl(asset, { allowPreview: false });
      const fileGuid = fileGuidFromAsset(asset) || guid;
      if (!url && fileGuid) {
        url = await getCmpFileUrlByGuid({ job, apiBaseUrl, tokenState, refreshToken, guid: fileGuid, onLog });
      }
      if (!url) {
        const rec = makeAssetOverviewRecord(asset, { requestEndpoint: metadataEndpoint || 'CMP asset listing endpoint', status: 'METADATA_ONLY', error: 'No downloadable URL was found in the CMP asset payload and file-url fallback did not produce a URL.' });
        metadataOnly.push(rec);
        await onLog(`CMP asset ${id || title}: metadata fetched but no downloadable URL found.`, 'warn');
        return;
      }
      await onLog(`CMP asset ${i + 1}/${cmpAssets.length}: ${id || title}`);
      const contentType = originalContentTypeFromAsset(asset);
      const originalFileName = originalFileNameFromAsset(asset, url);
      const result = await downloadUrlToDisk({
        url, job, jobId: job.id, source: 'cmp-dam', folderPath, fileName: originalFileName,
        metadata: { title, assetId: id, assetGuid: guid, cmpFolderId, cmpFolderName, originalFileName, originalContentType: contentType, contentType, assetType: deriveAssetType(asset, originalFileName || url, contentType) }, onLog, authToken: tokenState.token
      });
      downloaded.push({ ...result, rawAsset: asset, requestEndpoint: result.requestEndpoint || url, sizeBytes: result.sizeBytes || assetSizeBytes(asset) });
    } catch (e) {
      const fail = makeAssetOverviewRecord(asset, { requestEndpoint: metadataEndpoint || 'CMP asset listing endpoint', status: 'FAILED', error: e.message });
      failed.push(fail);
      await onLog(`CMP asset failed: ${e.message}`, 'error');
    }
  });

  const tagRecord = r => ({ ...r, operationRunId, operationMode, operationLabel: cmpOperationLabel(operationMode) });
  job.assetFieldRows = fieldRows.map(tagRecord);
  job.labelGroupRows = labelRows.map(tagRecord);
  job.downloadedAssets = [...analyzed, ...downloaded, ...failed, ...metadataOnly, ...skipped].map(tagRecord);
  job.status = shouldDownload ? 'ASSETS_DOWNLOADED' : 'ASSETS_ANALYZED';
  job.downloadSummary = {
    source: 'cmp-dam', operationMode, operationRunId, operationLabel: cmpOperationLabel(operationMode), requested: cmpAssets.length,
    analyzed: analyzed.length, downloaded: downloaded.length, failed: failed.length, metadataOnly: metadataOnly.length, skipped: skipped.length,
    fieldRows: fieldRows.length, labelOptions: labelRows.length,
    folderId: options.folderId || '', downloadAll, explicitIds: explicitIds.length, discoveryMode: discovery.discoveryMode, concurrency: DOWNLOAD_CONCURRENCY,
    downloadRoot: job.downloadFolderRelativePath, localDownloadFolder: job.downloadFolderRelativePath, lastDownloadAt: now(), httpEvents: (job.downloadHttpEvents || []).length,
    retryPolicy: `${MAX_DOWNLOAD_RETRIES} attempts per file; bearer token refresh on 401/403 for CMP API calls; file-url fallback uses POST /file-urls when asset GUID is available`
  };
  delete job.currentDownloadRunId;
  delete job.currentDownloadOperationMode;
  delete job.currentDownloadOperationLabel;
  return job;
}
