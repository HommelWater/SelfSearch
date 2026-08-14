import { tokenize } from './tokenize.js';

const BODY_TRUNCATE = 50000;
const DIRECT_LIMIT = 25;
const RELATED_LIMIT = 25;

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
