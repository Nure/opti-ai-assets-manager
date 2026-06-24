import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { nanoid } from 'nanoid';
import { checksum, extensionFromUrl, safeFilename, getAssetType, now } from './utils.js';

const dataDir = process.env.APP_DATA_DIR || path.resolve(process.cwd(), '../data');
const http = axios.create({ timeout: 45000, responseType: 'arraybuffer', maxRedirects: 5, validateStatus: s => s < 500 });

async function downloadAsset(asset) {
  const maxMb = Number(process.env.MAX_DOWNLOAD_MB || 250);
  const res = await http.get(asset.sourceUrl, { headers: { 'User-Agent': 'AI-DAM-Migration-Copilot/1.0' } });
  if (res.status >= 400) throw new Error(`Download failed with HTTP ${res.status}`);
  const buffer = Buffer.from(res.data);
  if (buffer.length > maxMb * 1024 * 1024) throw new Error(`Asset exceeds ${maxMb}MB limit`);
  const contentType = res.headers['content-type'] || '';
  const ext = extensionFromUrl(asset.sourceUrl, contentType);
  const fileName = safeFilename(`${asset.id}${ext}`);
  const outDir = path.join(dataDir, 'downloads', asset.id);
  await fs.mkdir(outDir, { recursive: true });
  const filePath = path.join(outDir, fileName);
  await fs.writeFile(filePath, buffer);
  return { filePath, fileName, sizeBytes: buffer.length, checksum: checksum(buffer), contentType, assetType: getAssetType(asset.sourceUrl, contentType) };
}

async function uploadToCmp(asset) {
  if (!process.env.CMP_API_BASE_URL || !process.env.CMP_BEARER_TOKEN) {
    const safeName = encodeURIComponent(asset.fileName || `${asset.id}`);
    return {
      mode: 'SIMULATED',
      cmpAssetId: `sim-${asset.id}`,
      cmpUrl: `${process.env.PUBLIC_BASE_URL || 'http://localhost:8080'}/simulated-cmp/${safeName}`,
      reason: 'CMP_API_BASE_URL or CMP_BEARER_TOKEN is not configured. No external upload was attempted.'
    };
  }

  // Adapter point for Optimizely CMP DAM import. The exact endpoint can be adjusted per customer/environment.
  // This preserves an enterprise-safe abstraction instead of hard-coding experimental API behavior.
  const payload = {
    source_file_name: asset.fileName,
    source_folder_path: asset.folderPath,
    checksum: asset.checksum,
    metadata: asset.aiMetadata || {},
    org_id: process.env.CMP_ORG_ID,
    folder_id: process.env.CMP_DEFAULT_FOLDER_ID
  };
  const res = await axios.post(`${process.env.CMP_API_BASE_URL.replace(/\/$/, '')}/assets/imports`, payload, {
    headers: { Authorization: `Bearer ${process.env.CMP_BEARER_TOKEN}`, 'Content-Type': 'application/json' },
    timeout: 60000,
    validateStatus: s => s < 500
  });
  if (res.status >= 400) throw new Error(`CMP upload failed with HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 400)}`);
  return {
    mode: 'CMP_API',
    cmpAssetId: res.data.id || res.data.asset_id || res.data.assetId || nanoid(),
    cmpUrl: res.data.url || res.data.asset_url || res.data.publicUrl || res.data.public_url,
    raw: res.data
  };
}

async function generateAiMetadata(asset) {
  if (!process.env.OPENAI_API_KEY) {
    return { status: 'SKIPPED', reason: 'OPENAI_API_KEY is not configured', confidenceScore: 0 };
  }
  try {
    const model = process.env.OPENAI_MODEL || 'gpt-5-mini';
    const prompt = `Return JSON metadata for a DAM asset. Do not invent brand/legal claims. Asset URL: ${asset.sourceUrl}. Asset type: ${asset.assetType}. Folder: ${asset.folderPath}.`;
    const res = await axios.post('https://api.openai.com/v1/responses', {
      model,
      input: prompt,
      text: { format: { type: 'json_object' } }
    }, { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 60000 });
    const text = res.data.output_text || res.data.output?.[0]?.content?.[0]?.text || '{}';
    return { status: 'COMPLETED', model, ...JSON.parse(text) };
  } catch (e) {
    return { status: 'FAILED', reason: e.message, confidenceScore: 0 };
  }
}

export async function migrateAssets(job, options = {}, onLog = async () => {}) {
  const assets = job.assets || [];
  await onLog(`Migration started for ${assets.length} asset(s).`);
  const byChecksum = new Map();
  const results = [];
  for (const [index, asset] of assets.entries()) {
    try {
      await onLog(`Processing asset ${index + 1}/${assets.length}: ${asset.sourceUrl || asset.fileName || asset.normalizedUrl}`);
      if (asset.status === 'UPLOADED_TO_CMP' && !options.force) { results.push(asset); continue; }
      let updated = { ...asset, status: 'DOWNLOADING', updatedAt: now() };
      await onLog('Downloading or reading asset file.');
      let downloadMeta;
      if (asset.localFilePath) {
        const buffer = await fs.readFile(asset.localFilePath);
        downloadMeta = { filePath: asset.localFilePath, fileName: asset.fileName, sizeBytes: buffer.length, checksum: checksum(buffer), contentType: asset.contentType || '', assetType: asset.assetType };
      } else {
        downloadMeta = await downloadAsset(asset);
      }
      updated = { ...updated, ...downloadMeta, assetType: downloadMeta.assetType || updated.assetType, status: 'DOWNLOADED' };
      await onLog(`Checksum calculated: ${updated.checksum}`);

      const existing = byChecksum.get(updated.checksum);
      if (existing) {
        updated.status = 'DUPLICATE_DETECTED';
        updated.duplicateOf = existing.id;
        updated.duplicateReason = `Same SHA-256 checksum as ${existing.sourceUrl || existing.fileName}. Exact binary duplicate; CMP URL will be reused.`;
        await onLog(`Duplicate detected. ${updated.duplicateReason}`);
        updated.cmpAssetId = existing.cmpAssetId;
        updated.cmpUrl = existing.cmpUrl;
        results.push(updated);
        continue;
      }

      await onLog('Generating optional AI metadata.');
      updated.aiMetadata = await generateAiMetadata(updated);
      updated.status = 'AI_ANALYZED';
      await onLog('Uploading asset to CMP DAM adapter or simulation mode.');
      const cmp = await uploadToCmp(updated);
      updated = { ...updated, ...cmp, status: 'UPLOADED_TO_CMP', uploadedAt: now() };
      byChecksum.set(updated.checksum, updated);
      results.push(updated);
    } catch (e) {
      await onLog(`Asset failed: ${e.message}`, 'error');
      results.push({ ...asset, status: 'FAILED', error: e.message, updatedAt: now() });
    }
  }
  job.assets = results;
  job.status = 'MIGRATED';
  job.summary = {
    ...(job.summary || {}),
    uploaded: results.filter(a => a.status === 'UPLOADED_TO_CMP').length,
    duplicates: results.filter(a => a.status === 'DUPLICATE_DETECTED').length,
    failed: results.filter(a => a.status === 'FAILED').length,
    lastMigrationAt: now()
  };
  job.migrationSummary = { uploaded: job.summary.uploaded, duplicates: job.summary.duplicates, failed: job.summary.failed, lastMigrationAt: job.summary.lastMigrationAt };
  await onLog(`Migration complete. Uploaded ${job.summary.uploaded}, duplicates ${job.summary.duplicates}, failed ${job.summary.failed}.`);
  return job;
}
