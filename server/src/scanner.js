import axios from 'axios';
import * as cheerio from 'cheerio';
import { nanoid } from 'nanoid';
import { toAbsoluteUrl, canonicalizeUrl, getAssetType, looksLikeAsset, uniqueBy } from './utils.js';

const http = axios.create({ timeout: 45000, maxRedirects: 8, validateStatus: s => s < 500 });

function authHeaders(config = {}) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (compatible; OptiDAM-Copilot/2.0; +https://www.optimizely.com)',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9'
  };
  if (config.bearerToken) headers.Authorization = `Bearer ${config.bearerToken}`;
  if (config.username && config.password) headers.Authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`;
  return headers;
}

function extractFromSrcset(srcset, baseUrl, context) {
  return String(srcset || '')
    .split(',')
    .map(part => part.trim().split(/\s+/)[0])
    .filter(Boolean)
    .map(src => ({ url: toAbsoluteUrl(src, baseUrl), context }));
}

export function inferFolderPath(absUrl) {
  try {
    const u = new URL(absUrl);
    const parts = u.pathname.split('/').filter(Boolean);
    parts.pop();
    return parts.length ? `/${parts.join('/')}` : '/';
  } catch { return '/'; }
}

export function extractAssetRefsFromHtml(html, pageUrl, baseUrl, pageMeta = {}) {
  const $ = cheerio.load(html || '');
  const refs = [];
  const push = (raw, location, attribute, element = '') => {
    const abs = toAbsoluteUrl(raw, pageUrl || baseUrl);
    if (!abs || !looksLikeAsset(abs)) return;
    refs.push({
      id: nanoid(),
      pageId: pageMeta.id,
      pageTitle: pageMeta.title || $('title').first().text().trim() || pageUrl,
      pageUrl,
      rawUrl: raw,
      absoluteUrl: abs,
      normalizedUrl: canonicalizeUrl(abs),
      assetType: getAssetType(abs),
      location,
      attribute,
      element,
      folderPath: inferFolderPath(abs),
      status: 'DISCOVERED'
    });
  };

  const pushManyAttrs = (selector, attrs, location) => {
    $(selector).each((_, el) => {
      const htmlSnippet = $.html(el).slice(0, 800);
      for (const attr of attrs) {
        const value = $(el).attr(attr);
        if (!value) continue;
        if (/srcset/i.test(attr)) {
          extractFromSrcset(value, pageUrl || baseUrl, `${location}:${attr}`).forEach(x => push(x.url, location, attr, htmlSnippet));
        } else {
          push(value, location, attr, htmlSnippet);
        }
      }
    });
  };

  pushManyAttrs('img', ['src','srcset','data-src','data-srcset','data-lazy-src','data-original','data-url','data-image','data-desktop','data-mobile'], 'html:img');
  pushManyAttrs('source', ['src','srcset','data-src','data-srcset','data-lazy-src'], 'html:source');
  pushManyAttrs('video,audio,track,embed,object', ['src','data','poster','data-src'], 'html:media');
  pushManyAttrs('a', ['href','data-href','data-url'], 'html:a');
  pushManyAttrs('meta[property="og:image"],meta[name="twitter:image"],meta[itemprop="image"]', ['content'], 'html:meta-image');
  pushManyAttrs('link[rel="icon"],link[rel="shortcut icon"],link[rel="apple-touch-icon"],link[rel="preload"],link[as="image"]', ['href','imagesrcset'], 'html:link-asset');

  // Generic attribute sweep catches lazy-loading libraries and CMS-rendered custom components.
  $('*').each((_, el) => {
    const attribs = el.attribs || {};
    const htmlSnippet = $.html(el).slice(0, 800);
    for (const [attr, value] of Object.entries(attribs)) {
      if (!value || /^(class|id|role|aria-|alt|title)$/i.test(attr)) continue;
      if (/srcset|imagesrcset/i.test(attr)) {
        extractFromSrcset(value, pageUrl || baseUrl, `attr:${attr}`).forEach(x => push(x.url, 'attribute-sweep', attr, htmlSnippet));
        continue;
      }
      if (/url|src|href|image|poster|background|file|asset|thumbnail|media/i.test(attr)) push(value, 'attribute-sweep', attr, htmlSnippet);
    }
  });

  const extractCssUrls = (css, location) => {
    [...String(css || '').matchAll(/url\(\s*['"]?([^'"\)]+)['"]?\s*\)/gi)].forEach(m => push(m[1], location, 'url()', String(css).slice(0, 800)));
  };
  $('[style]').each((_, el) => extractCssUrls($(el).attr('style') || '', 'inline-style'));
  $('style').each((_, el) => extractCssUrls($(el).html() || '', 'style-block'));

  // Raw fallback catches URLs embedded in JSON, data attributes, scripts, or custom CMS components.
  const absoluteAssetRegex = /(https?:\/\/[^\s"'<>\)]+(?:\.(?:jpg|jpeg|png|gif|webp|avif|svg|ico|bmp|tiff?|pdf|docx?|rtf|txt|csv|xlsx?|xlsm|pptx?|ppsx?|mp4|mov|webm|avi|mkv|m4v|wmv|mpe?g|mp3|wav|aac|m4a|ogg|ai|psd|eps|indd|sketch|fig|xd|zip|rar|7z|tar|gz)|\/(?:globalassets|siteassets|contentassets|contentmedia|media|assets|images?)\/)[^\s"'<>\)]*)/gi;
  [...String(html || '').matchAll(absoluteAssetRegex)].forEach(m => push(m[1], 'raw-html-regex', 'regex', m[0]));

  const relativeAssetRegex = /(["'=\(]\s*)((?:\/|\.\/|\.\.\/)[^\s"'<>\)]+(?:\.(?:jpg|jpeg|png|gif|webp|avif|svg|ico|bmp|tiff?|pdf|docx?|rtf|txt|csv|xlsx?|xlsm|pptx?|ppsx?|mp4|mov|webm|avi|mkv|m4v|wmv|mpe?g|mp3|wav|aac|m4a|ogg|ai|psd|eps|indd|sketch|fig|xd|zip|rar|7z|tar|gz)|\/(?:globalassets|siteassets|contentassets|contentmedia|media|assets|images?)\/)[^\s"'<>\)]*)/gi;
  [...String(html || '').matchAll(relativeAssetRegex)].forEach(m => push(m[2], 'raw-relative-regex', 'regex', m[2]));

  return uniqueBy(refs, r => `${r.pageUrl}|${r.normalizedUrl}|${r.location}|${r.attribute}`);
}

function extractInternalLinks(html, currentUrl, liveBaseUrl) {
  const $ = cheerio.load(html || '');
  const base = new URL(liveBaseUrl);
  const links = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    const absolute = toAbsoluteUrl(href, currentUrl || liveBaseUrl);
    if (!absolute) return;
    try {
      const u = new URL(absolute);
      if (u.hostname !== base.hostname) return;
      if (looksLikeAsset(u.toString())) return;
      u.hash = '';
      links.push(u.toString());
    } catch { /* ignore invalid links */ }
  });
  return [...new Set(links)];
}

async function fetchRenderedPage(url, config) {
  const res = await http.get(url, { headers: authHeaders(config) });
  return { status: res.status, html: res.data, finalUrl: res.request?.res?.responseUrl || url };
}

function jsonPrompt({ html, page, refs }) {
  const text = cheerio.load(html || '').text().replace(/\s+/g, ' ').slice(0, 6000);
  const assetList = refs.slice(0, 80).map(r => ({ url: r.absoluteUrl, type: r.assetType, location: r.location }));
  return `You are an enterprise CMS asset migration scan assistant. The deterministic parser has already extracted asset URLs from this live page. Do not invent URLs. Analyze the page context and return JSON only with: pagePurpose, assetCompletenessRisk(low|medium|high), possibleMissedAssetPatterns, recommendedNextChecks, confidenceScore. Page URL: ${page.url}. Extracted assets: ${JSON.stringify(assetList)}. Page text: ${text}`;
}

function safeJson(raw) {
  const text = String(raw || '{}').trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(text); } catch { return { raw: text.slice(0, 4000) }; }
}

async function analyzeWithGemini(prompt, config) {
  const apiKey = config.aiApiKey || config.geminiApiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) return { skipped: true, reason: 'Gemini API key was not provided.' };
  const model = config.aiModel || config.geminiModel || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json' } })
  });
  if (!res.ok) return { error: `Gemini request failed with HTTP ${res.status}` };
  const data = await res.json();
  return safeJson(data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}');
}

async function analyzeWithClaude(prompt, config) {
  const apiKey = config.aiApiKey || process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { skipped: true, reason: 'Claude API key was not provided.' };
  const model = config.aiModel || process.env.CLAUDE_MODEL || 'claude-sonnet-4-5';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 900, messages: [{ role: 'user', content: `${prompt}\nReturn JSON only.` }] })
  });
  if (!res.ok) return { error: `Claude request failed with HTTP ${res.status}` };
  const data = await res.json();
  return safeJson((data?.content || []).map(p => p.text || '').join('\n'));
}

async function analyzeWithOpenAI(prompt, config) {
  const apiKey = config.aiApiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) return { skipped: true, reason: 'OpenAI API key was not provided.' };
  const model = config.aiModel || process.env.OPENAI_MODEL || 'gpt-5.4-mini';
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, input: `${prompt}\nReturn JSON only.` })
  });
  if (!res.ok) return { error: `OpenAI request failed with HTTP ${res.status}` };
  const data = await res.json();
  const raw = data.output_text || (data.output || []).flatMap(o => o.content || []).map(c => c.text || '').join('\n');
  return safeJson(raw || '{}');
}

async function analyzePageWithAI({ html, page, refs, config }) {
  if (!config.enableAiScan) return null;
  const provider = String(config.aiProvider || 'gemini').toLowerCase();
  const prompt = jsonPrompt({ html, page, refs });
  try {
    if (provider === 'gemini') return await analyzeWithGemini(prompt, config);
    if (provider === 'claude') return await analyzeWithClaude(prompt, config);
    if (provider === 'openai') return await analyzeWithOpenAI(prompt, config);
    return { skipped: true, reason: `Unsupported AI provider: ${provider}` };
  } catch (e) {
    return { error: e.message };
  }
}


function normalizeHttpUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}

function createStartQueue(config) {
  if (config.scanMode === 'target') return [normalizeHttpUrl(config.targetPageUrl)];
  const baseUrl = normalizeHttpUrl(config.baseUrl);
  const manualUrls = String(config.pageUrls || '')
    .split(/\n|,/)
    .map(x => x.trim())
    .filter(Boolean)
    .map(u => toAbsoluteUrl(u, baseUrl))
    .filter(Boolean);
  return manualUrls.length ? manualUrls : [baseUrl];
}

async function crawlLiveDomainPageByPage(job, onLog = async () => {}) {
  const config = job.config || {};
  const scanMode = config.scanMode || (config.testScan ? 'test' : 'full');
  const baseUrl = scanMode === 'target' ? normalizeHttpUrl(config.targetPageUrl) : normalizeHttpUrl(config.baseUrl);
  const pageLimit = scanMode === 'target' ? 1 : scanMode === 'full' ? Infinity : Math.max(1, Number(config.testPageCount || config.pageLimit || 5));
  const queue = createStartQueue(config);
  const seen = new Set();
  const pages = [];
  let refs = [];

  while (queue.length && pages.length < pageLimit) {
    const next = queue.shift();
    let currentUrl;
    try {
      currentUrl = new URL(next);
      currentUrl.hash = '';
    } catch { continue; }
    const url = currentUrl.toString();
    if (seen.has(url)) continue;
    seen.add(url);

    const pageId = `live-${pages.length + 1}`;
    await onLog(`Scanning page ${pages.length + 1}/${pageLimit === Infinity ? 'full' : pageLimit}: ${url}`);
    try {
      const fetched = await fetchRenderedPage(url, config);
      const $ = cheerio.load(fetched.html || '');
      const title = $('title').first().text().trim() || url;
      const pageRecord = {
        id: pageId,
        title,
        url,
        finalUrl: fetched.finalUrl,
        source: `${job.cmsType}-live-domain-crawl`,
        status: 'SCANNED',
        httpStatus: fetched.status,
        scannedAt: new Date().toISOString()
      };
      const pageRefs = extractAssetRefsFromHtml(fetched.html, url, baseUrl, pageRecord);
      await onLog(`Found ${pageRefs.length} asset reference(s) on ${url}.`);
      pageRecord.aiAnalysis = await analyzePageWithAI({ html: fetched.html, page: pageRecord, refs: pageRefs, config });
      pages.push(pageRecord);
      refs = refs.concat(pageRefs);

      if (scanMode !== 'target') {
        for (const link of extractInternalLinks(fetched.html, url, baseUrl)) {
          if (!seen.has(link) && (pageLimit === Infinity || queue.length + pages.length < pageLimit * 3)) queue.push(link);
        }
      }
    } catch (e) {
      await onLog(`Page scan failed for ${url}: ${e.message}`, 'error');
      pages.push({ id: pageId, title: url, url, source: `${job.cmsType}-live-domain-crawl`, status: 'FAILED', error: e.message, scannedAt: new Date().toISOString() });
    }
  }

  return { pages, refs };
}

export async function scanJob(job, onLog = async () => {}) {
  const scanMode = job.config.scanMode || (job.config.testScan ? 'test' : 'full');
  const scanUrl = scanMode === 'target' ? normalizeHttpUrl(job.config.targetPageUrl) : normalizeHttpUrl(job.config.baseUrl);
  await onLog('Scan job started. Preparing live-domain crawler.');
  if (!scanUrl || !/^https?:\/\//i.test(scanUrl)) throw new Error(scanMode === 'target' ? 'A Target page URL is required. Example: https://www.customer-site.com/page' : 'A live Base URL is required for page-by-page scanning. Example: https://www.customer-site.com');
  job.config = { ...job.config, ...(scanMode === 'target' ? { targetPageUrl: scanUrl } : { baseUrl: scanUrl }) };
  if (scanMode === 'target') await onLog(`Target page mode enabled. Only this page will be scanned: ${scanUrl}`);

  const { pages, refs: rawRefs } = await crawlLiveDomainPageByPage(job, onLog);
  const refs = uniqueBy(rawRefs, r => `${r.normalizedUrl}|${r.pageUrl}|${r.location}`);
  const assetMap = new Map();

  for (const ref of refs) {
    if (!assetMap.has(ref.normalizedUrl)) {
      assetMap.set(ref.normalizedUrl, {
        id: nanoid(),
        normalizedUrl: ref.normalizedUrl,
        sourceUrl: ref.absoluteUrl,
        assetType: ref.assetType,
        folderPath: ref.folderPath,
        status: 'DISCOVERED',
        references: 0,
        createdAt: new Date().toISOString()
      });
    }
    assetMap.get(ref.normalizedUrl).references += 1;
  }

  job.pages = pages;
  job.assetReferences = refs;
  job.assets = [...assetMap.values()];
  job.summary = {
    scanMode: scanMode === 'target' ? 'TARGET_PAGE' : scanMode === 'full' ? 'FULL_LIVE_DOMAIN_PAGE_BY_PAGE' : 'TEST_LIVE_DOMAIN_PAGE_BY_PAGE',
    aiProvider: job.config.enableAiScan ? job.config.aiProvider : 'disabled',
    aiModel: job.config.enableAiScan ? job.config.aiModel : 'disabled',
    testScan: scanMode === 'test',
    pageLimit: scanMode === 'full' ? 'unlimited' : scanMode === 'target' ? 1 : Number(job.config.testPageCount || job.config.pageLimit || 5),
    pagesScanned: pages.filter(p => p.status === 'SCANNED').length,
    pagesFailed: pages.filter(p => p.status === 'FAILED').length,
    uniqueAssets: job.assets.length,
    references: refs.length,
    lastScanAt: new Date().toISOString()
  };
  job.scanSummary = { ...job.summary };
  await onLog(`Scan complete. ${job.summary.pagesScanned} pages scanned, ${job.summary.uniqueAssets} unique assets found.`);
  job.status = 'SCANNED';
  return job;
}
