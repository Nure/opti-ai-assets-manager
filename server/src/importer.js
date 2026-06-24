import fs from 'fs/promises';
import path from 'path';
import axios from 'axios';
import XLSX from 'xlsx';
import { nanoid } from 'nanoid';
import { canonicalizeUrl, getAssetType, toAbsoluteUrl, now } from './utils.js';

const dataDir = process.env.APP_DATA_DIR || path.resolve(process.cwd(), '../data');

function normalizeRow(row, baseUrl) {
  const get = (...names) => names.map(n => row[n]).find(Boolean);
  const assetLink = get('asset_link', 'Asset Link', 'Asset URL', 'assetUrl', 'url', 'URL');
  const folderPath = get('folder', 'Folder', 'Folder Path', 'folderPath') || '/xlsx-import';
  const pageTitle = get('page_title', 'Page Title', 'title', 'Title') || '';
  const pageUrl = get('page_link', 'Page Link', 'Page URL', 'pageUrl') || '';
  const absolute = assetLink ? toAbsoluteUrl(assetLink, baseUrl) : null;
  if (!absolute) return null;
  return {
    id: nanoid(),
    normalizedUrl: canonicalizeUrl(absolute),
    sourceUrl: absolute,
    assetType: getAssetType(absolute),
    folderPath,
    source: 'xlsx-link',
    status: 'DISCOVERED',
    references: 1,
    xlsxPageTitle: pageTitle,
    xlsxPageUrl: pageUrl,
    createdAt: now()
  };
}

export async function importXlsxFromLink(job, xlsxUrl) {
  const res = await axios.get(xlsxUrl, { responseType: 'arraybuffer', timeout: 30000 });
  const wb = XLSX.read(Buffer.from(res.data), { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  const imported = rows.map(row => normalizeRow(row, job.config.baseUrl)).filter(Boolean);
  job.assets = mergeAssets(job.assets || [], imported);
  job.summary = { ...(job.summary || {}), xlsxImported: imported.length, lastImportAt: now() };
  return job;
}

export async function importFolderFiles(job, files) {
  const uploadDir = path.join(dataDir, 'uploads', job.id);
  await fs.mkdir(uploadDir, { recursive: true });
  const imported = [];
  for (const f of files) {
    const relativePath = f.originalname || f.filename;
    const folderPath = '/' + path.dirname(relativePath).replace(/^\.$/, '').replace(/\\/g, '/');
    const finalPath = path.join(uploadDir, `${nanoid()}-${path.basename(relativePath)}`);
    await fs.rename(f.path, finalPath);
    imported.push({
      id: nanoid(),
      normalizedUrl: `local://${relativePath}`,
      sourceUrl: `local://${relativePath}`,
      localFilePath: finalPath,
      fileName: path.basename(relativePath),
      assetType: getAssetType(relativePath),
      folderPath: folderPath === '/' ? '/folder-import' : folderPath,
      source: 'folder-drag-drop',
      status: 'DISCOVERED',
      references: 1,
      createdAt: now()
    });
  }
  job.assets = mergeAssets(job.assets || [], imported);
  job.summary = { ...(job.summary || {}), folderImported: imported.length, lastImportAt: now() };
  return job;
}

function mergeAssets(current, incoming) {
  const map = new Map(current.map(a => [a.normalizedUrl, a]));
  for (const a of incoming) {
    if (map.has(a.normalizedUrl)) map.set(a.normalizedUrl, { ...map.get(a.normalizedUrl), references: (map.get(a.normalizedUrl).references || 0) + 1 });
    else map.set(a.normalizedUrl, a);
  }
  return [...map.values()];
}
