import { getDB } from './db.js';
import { stemmed } from './tokenize.js';
import { stem } from './stem.js';

// --- Query-key map ----------------------------------------------------------
// Turns a user's words into the keys most likely to be in the index. Two
// sources, both expanded into the query before lookup:
//
//   1. A static thesaurus of related concepts (cold-start free): searching
//      "fixing" also tries "repair", "recipe" also tries "bake", "meaning"
//      also tries "define" — so question-style queries still match pages that
//      phrase things differently.
//   2. A learned co-occurrence map (IndexedDB store 'qk'): every time the user
//      clicks a search result, that query's terms are associated with the
//      result's keywords. Future searches expand with the most-clicked keys.

const CLUSTERS = [
  ['repair', 'repairs', 'fix', 'fixes', 'restore', 'restores', 'troubleshoot'],
  ['recipe', 'recipes', 'cook', 'cooks', 'cooking', 'bake', 'bakes', 'baking', 'ingredient', 'ingredients'],
  ['guide', 'guides', 'tutorial', 'tutorials', 'walkthrough', 'manual', 'howto', 'learn', 'lesson', 'course'],
  ['install', 'installs', 'setup', 'configure', 'config', 'configuration'],
  ['review', 'reviews', 'rating', 'ratings', 'opinion', 'recommend', 'recommended', 'best', 'top'],
  ['problem', 'issue', 'issues', 'error', 'errors', 'broken', 'fail', 'fails', 'failing'],
  ['compare', 'comparison', 'versus', 'vs', 'difference', 'differences'],
  ['remove', 'removes', 'delete', 'deletes', 'uninstall', 'clear'],
  ['price', 'pricing', 'cost', 'costs', 'cheap', 'expensive', 'worth'],
  ['find', 'finding', 'search', 'searching', 'locate', 'where'],
  ['build', 'building', 'create', 'creating', 'make', 'makes', 'making', 'develop'],
  ['define', 'definition', 'meaning', 'explain', 'explains']
];

// Stem each cluster once so thesaurus keys match the inverted index keys.
const THESAURUS = new Map();
for (const cluster of CLUSTERS) {
  const stems = [...new Set(cluster.map(stem))];
  for (const s of stems) {
    const others = stems.filter(x => x !== s);
    THESAURUS.set(s, (THESAURUS.get(s) || []).concat(others));
  }
}

const MAX_KEYS_PER_TERM = 3;   // learned keys added per query term
const MAX_KEYS_PER_ROW = 20;   // learned keys kept per query term (bounds the store)
const MAX_EXPANSION = 8;       // total extra terms tried per query

// Extra search keys for the given (stemmed) query terms. Thesaurus first, then
// learned; each learned key carries its click count so the most-useful keys win.
export async function expandQuery(terms, db = null) {
  if (!terms.length) return [];
  const extra = new Map();
  for (const t of terms) {
    for (const k of THESAURUS.get(t) || []) {
      if (!terms.includes(k) && !extra.has(k)) extra.set(k, 1);
    }
  }
  db = db || await getDB();
  for (const t of terms) {
    const row = await db.get('qk', t);
    if (!row || !row.keys) continue;
    const top = Object.entries(row.keys)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_KEYS_PER_TERM);
    for (const [k, w] of top) {
      if (!terms.includes(k) && !extra.has(k)) extra.set(k, w);
    }
  }
  return [...extra.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_EXPANSION)
    .map(([k]) => k);
}

// Associate a clicked result's keywords with the query terms that found it.
export async function observeQueryKeys(queryTerms, keyTerms) {
  if (!queryTerms.length || !keyTerms.length) return;
  const db = await getDB();
  const tx = db.transaction('qk', 'readwrite');
  for (const qt of queryTerms) {
    const row = (await tx.store.get(qt)) || { term: qt, keys: {} };
    for (const kt of keyTerms) {
      if (kt === qt) continue;
      row.keys[kt] = (row.keys[kt] || 0) + 1;
    }
    const top = Object.entries(row.keys).sort((a, b) => b[1] - a[1]).slice(0, MAX_KEYS_PER_ROW);
    row.keys = Object.fromEntries(top);
    await tx.store.put(row);
  }
  await tx.done;
}

// Convenience: stem raw query/keyword strings, then observe the pairs.
export async function observeQueryText(query, keywords) {
  return observeQueryKeys(stemmed(query), stemmed(keywords));
}
