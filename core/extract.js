import { tokenize } from './tokenize.js';

const BODY_TRUNCATE = 50000;
const DIRECT_LIMIT = 25;
const RELATED_LIMIT = 25;

function bytesToBase64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const meta = dataUrl.slice(0, comma);
  const b64 = dataUrl.slice(comma + 1);
  const mime = meta.match(/^data:([^;]+)/)[1] || 'image/jpeg';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function sha256Hex(blob) {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// --- Local extraction (no LLM): keyword frequency over the page text --------

// page: { title, metaDescription, metaKeywords, bodyText }
// Returns { title, description, direct_keywords, related_keywords }.
export function extractFromDom(page) {
  const title = String(page.title || '').trim();
  const body = String(page.bodyText || '').slice(0, BODY_TRUNCATE);

  // Weighted term frequencies: body 1x, title 3x, meta keywords 2x.
  const counts = new Map();
  const bump = (text, weight = 1) => {
    for (const t of tokenize(text)) counts.set(t, (counts.get(t) || 0) + weight);
  };
  bump(title, 3);
  if (page.metaKeywords) {
    for (const k of String(page.metaKeywords).split(/[,;]/)) {
      const t = k.trim().toLowerCase();
      if (t.length > 2) counts.set(t, (counts.get(t) || 0) + 2);
    }
  }
  bump(body, 1);

  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const direct = sorted.slice(0, DIRECT_LIMIT).map(([t]) => t);
  const related = sorted.slice(DIRECT_LIMIT, DIRECT_LIMIT + RELATED_LIMIT).map(([t]) => t);

  let description = String(page.metaDescription || '').trim();
  if (!description) {
    description = body.replace(/\s+/g, ' ').trim().slice(0, 200);
  }

  return {
    title: title || null,
    description,
    direct_keywords: direct.join(' '),
    related_keywords: related.join(' ')
  };
}

export { dataUrlToBlob, sha256Hex };
