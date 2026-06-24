import crypto from 'crypto';
import path from 'path';
import mime from 'mime-types';

const assetExtensions = new Set([
  // Images
  '.jpg','.jpeg','.png','.gif','.webp','.svg','.avif','.ico','.bmp','.tif','.tiff',
  // Documents and office files
  '.pdf','.doc','.docx','.rtf','.txt','.csv','.xls','.xlsx','.xlsm','.ppt','.pptx','.pps','.ppsx',
  // Video
  '.mp4','.mov','.webm','.avi','.mkv','.m4v','.wmv','.mpeg','.mpg',
  // Audio
  '.mp3','.wav','.aac','.m4a','.ogg',
  // Creative/design/source assets
  '.ai','.psd','.eps','.indd','.sketch','.fig','.xd',
  // Archives and packages
  '.zip','.rar','.7z','.tar','.gz'
]);

export function now() { return new Date().toISOString(); }

export function toAbsoluteUrl(url, baseUrl) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim().replaceAll('&amp;', '&');
  if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('mailto:') || trimmed.startsWith('tel:')) return null;
  try { return new URL(trimmed, baseUrl).toString(); } catch { return null; }
}

export function canonicalizeUrl(url) {
  try {
    const u = new URL(url);
    ['utm_source','utm_medium','utm_campaign','utm_term','utm_content','fbclid','gclid'].forEach(k => u.searchParams.delete(k));
    u.hash = '';
    return u.toString();
  } catch { return url; }
}

export function getAssetType(url, contentType = '') {
  const ext = path.extname((url || '').split('?')[0]).toLowerCase();
  const ct = contentType.toLowerCase();
  if (ct.startsWith('image/') || ['.jpg','.jpeg','.png','.gif','.webp','.svg','.avif','.ico','.bmp','.tif','.tiff'].includes(ext)) return 'image';
  if (ct.includes('pdf') || ['.pdf'].includes(ext)) return 'document';
  if (ct.startsWith('video/') || ['.mp4','.mov','.webm','.avi','.mkv','.m4v','.wmv','.mpeg','.mpg'].includes(ext)) return 'video';
  if (ct.startsWith('audio/') || ['.mp3','.wav','.aac','.m4a','.ogg'].includes(ext)) return 'audio';
  if (['.doc','.docx','.rtf','.txt','.csv','.xls','.xlsx','.xlsm','.ppt','.pptx','.pps','.ppsx'].includes(ext)) return 'document';
  if (['.ai','.psd','.eps','.indd','.sketch','.fig','.xd'].includes(ext)) return 'design-source';
  if (['.zip','.rar','.7z','.tar','.gz'].includes(ext)) return 'archive';
  return 'file';
}

export function looksLikeAsset(url) {
  try {
    const u = new URL(url);
    const ext = path.extname(u.pathname).toLowerCase();
    return assetExtensions.has(ext) || /globalassets|siteassets|contentassets|contentmedia|content\/dam|wp-content\/uploads|\/media\/|\/assets\/|\/images?\//i.test(u.pathname) || /(format|width|height|quality|rendition|asset)/i.test(u.search);
  } catch { return false; }
}

export function checksum(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function safeFilename(name) {
  return (name || 'asset').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 180);
}

export function extensionFromUrl(url, fallbackMime) {
  const ext = path.extname(new URL(url).pathname);
  if (ext) return ext;
  const fromMime = fallbackMime ? mime.extension(fallbackMime) : '';
  return fromMime ? `.${fromMime}` : '';
}

export function uniqueBy(items, keyFn) {
  const seen = new Set();
  return items.filter(item => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
