import { extractFromDom, dataUrlToBlob, sha256Hex } from './extract.js';
import { saveDoc } from './search.js';

export function browserApi() {
  return typeof browser !== 'undefined' ? browser : chrome;
}

// Runs inside the page (via scripting.executeScript) to grab its text content.
function readPageInfo() {
  const meta = (name) => {
    const el = document.querySelector(`meta[name="${name}"]`);
    return el && el.content ? el.content.trim() : '';
  };
  const bodyText = (document.body && document.body.innerText) || '';
  return {
    title: document.title || '',
    url: location.href || '',
    metaDescription: meta('description'),
    metaKeywords: meta('keywords'),
    bodyText: bodyText.slice(0, 100000)
  };
}

// Capture the current tab: read the page DOM, extract keywords locally, merge
// user keywords, store the doc. `screenshot: false` skips the (heavy) image
// capture; `auto: true` marks the doc as auto-indexed so it can be refreshed.
export async function captureAndIndex(tab, { keywords = '', screenshot = true, auto = false } = {}) {
  const api = browserApi();

  // Page text (activeTab grants us the current tab while the popup is open).
  let page = null;
  try {
    const results = await api.scripting.executeScript({
      target: { tabId: tab.id },
      func: readPageInfo
    });
    page = results && results[0] && results[0].result ? results[0].result : null;
  } catch (err) {
    console.warn('[capture] could not read page DOM, using tab metadata', err);
  }

  const url = (page && page.url) || tab.url || '';
  const title = (page && page.title) || tab.title || '';

  // Screenshot — stored locally (never shared). Skipped for auto-indexing.
  let blob = null;
  let imageHash = '';
  if (screenshot) {
    try {
      const dataUrl = await api.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 80 });
      blob = dataUrlToBlob(dataUrl);
      imageHash = await sha256Hex(blob);
    } catch (err) {
      console.warn('[capture] screenshot failed', err);
    }
  }

  // Extract keywords locally from the page DOM (fast, always available).
  const extracted = extractFromDom({ title, ...(page || {}) });

  // Merge user-entered keywords.
  const userKw = keywords.trim().split(/[,;\s]+/).filter(k => k.length > 1);
  const direct = [...userKw, ...String(extracted.direct_keywords || '').split(' ').filter(Boolean)];
  const related = String(extracted.related_keywords || '').split(' ').filter(Boolean);

  const doc = {
    url,
    title: String(extracted.title || title || '').trim(),
    description: String(extracted.description || '').trim(),
    direct_keywords: [...new Set(direct)].slice(0, 30).join(' '),
    related_keywords: [...new Set(related)].slice(0, 30).join(' '),
    timestamp: Math.floor(Date.now() / 1000),
    image_hash: imageHash,
    ...(auto ? { auto: true } : {})
  };

  await saveDoc(doc, blob);
  return { ...doc, visionUsed: false };
}
