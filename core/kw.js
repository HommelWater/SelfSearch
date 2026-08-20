import { getDB } from './db.js';

// Stable-keyword consensus: a page's body mixes its real content with random
// or viewer-specific material (recommendations, "you might also like", user
// comments). The same keyword reappearing across repeated captures is the
// content; a keyword seen once is noise. We keep the former and drop the latter.
const KW_WINDOW = 8;          // how many recent captures are considered
const CONSENSUS_RATIO = 0.5;  // a term must appear in >= this fraction to survive

// Per-URL observation history (local only; not shared over the mesh).
export async function getKwHistory(url) {
  const db = await getDB();
  return (await db.get('kwHistory', url)) || null;
}

// Record one capture's keywords for `url` and return the terms that have been
// stable across recent captures, ranked by how often they reappeared. A first
// capture keeps everything (ratio 1); one-off terms drop out as more samples
// arrive, and a genuinely changed page converges onto its new terms.
export async function observeKeywords(url, terms) {
  const db = await getDB();
  const h = (await db.get('kwHistory', url)) || { url, recent: [] };
  h.recent.push([...new Set(terms)]);
  if (h.recent.length > KW_WINDOW) h.recent = h.recent.slice(-KW_WINDOW);
  await db.put('kwHistory', h);

  const counts = new Map();
  for (const capture of h.recent) {
    for (const t of capture) counts.set(t, (counts.get(t) || 0) + 1);
  }
  const denom = h.recent.length;
  return [...counts.entries()]
    .filter(([, c]) => c / denom >= CONSENSUS_RATIO)
    .sort((a, b) => b[1] - a[1])
    .map(([t]) => t);
}
