import { extractFromDom } from './extract.js';
import { saveDoc, getDomainStats, getUserStats } from './search.js';
import { hostnameOf } from './domain.js';
import { observeKeywords } from './kw.js';

export function browserApi() {
  return typeof browser !== 'undefined' ? browser : chrome;
}

// Runs inside the page (content script or scripting.executeScript) to grab its
// text content. NOTE: content.js carries an inlined copy of this + shouldAutoIndex
// (content scripts can't import in every browser) — keep them in sync.
export function readPageInfo() {
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

// Auto-capture only real web pages with actual content — skips shell pages,
// JS-only apps and anything without enough text to extract from.
export function shouldAutoIndex(page) {
  return /^https?:\/\//.test(String(page.url || '')) &&
    String(page.bodyText || '').trim().length >= 200;
}

// Core indexing pipeline: take page info (from DOM), extract keywords, keep
// only the terms stable across captures, store the doc. Shared by the manual
// icon-click path and the automatic post-click capture.
export async function indexFromPage(page, { keywords = '' } = {}) {
  const url = (page && page.url) || '';
  if (!url) return null;
  const title = (page && page.title) || '';

  // Deprioritize terms common to this domain AND common across the whole index
  // (e.g. "recipe" everywhere in a cooking-heavy index).
  const domain = hostnameOf(url);
  const domainStats = domain ? await getDomainStats(domain) : null;
  const userStats = await getUserStats();

  const extracted = extractFromDom({ title, ...(page || {}) }, { domainStats, userStats });

  // The keywords observed on this capture feed the stability filter: terms
  // that reappear across reloads survive; one-off recommendation/random terms
  // drop out as more captures accumulate.
  const extractedTerms = [
    ...String(extracted.direct_keywords || '').split(' ').filter(Boolean),
    ...String(extracted.related_keywords || '').split(' ').filter(Boolean)
  ];
  const stable = await observeKeywords(url, extractedTerms);

  // User-entered keywords are explicit and always kept, ahead of stable ones.
  const userKw = keywords.trim().split(/[,;\s]+/).filter(k => k.length > 1);
  const combined = [...new Set([...userKw, ...stable])];

  const doc = {
    url,
    title: String(extracted.title || title || '').trim(),
    description: String(extracted.description || '').trim(),
    direct_keywords: combined.slice(0, 30).join(' '),
    related_keywords: combined.slice(30, 60).join(' '),
    timestamp: Math.floor(Date.now() / 1000)
  };

  await saveDoc(doc);
  return doc;
}

// Capture the current tab: read the page DOM, extract keywords locally, merge
// user keywords, store the doc. Text metadata only — no screenshots.
export async function captureAndIndex(tab, { keywords = '' } = {}) {
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
  if (!page) page = { url: tab.url || '', title: tab.title || '' };

  return indexFromPage(page, { keywords });
}
