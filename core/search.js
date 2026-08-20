import { getDB } from './db.js';
import { docTerms, stemmed, TOKENIZER_VERSION } from './tokenize.js';
import { hostnameOf, domainTerms } from './domain.js';

const MAX_QUERY_CACHE = 200;
// Cap how many URLs a prefix fallback scan will collect, so a very short
// prefix can never turn into a full-index scan.
const MAX_PREFIX_URLS = 300;

// Deterministic JSON (sorted keys) so content hashes are reproducible.
function canonicalText(obj) {
  if (Array.isArray(obj)) return '[' + obj.map(canonicalText).join(',') + ']';
  if (obj && typeof obj === 'object') {
    return '{' + Object.keys(obj).sort()
      .map(k => `"${k}":${canonicalText(obj[k])}`).join(',') + '}';
  }
  return JSON.stringify(obj);
}

// Content hash of a doc's searchable fields — stored in the manifest so a
// missing or corrupt doc can be detected and repaired from peer caches.
export async function docHash(doc) {
  const canonical = canonicalText({
    url: doc.url,
    title: doc.title || '',
    description: doc.description || '',
    direct_keywords: doc.direct_keywords || '',
    related_keywords: doc.related_keywords || '',
    timestamp: doc.timestamp || 0
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// --- Inverted index maintenance -------------------------------------------

// Rebuild the inverted index + cached peer terms when the tokenizer changes
// (e.g. stemming was added), so old raw-token keys are replaced. Idempotent:
// runs once per TOKENIZER_VERSION and records the version in settings.
export async function rebuildIndexForVersion(db) {
  const saved = await db.get('settings', 'tokenizerVersion');
  if (saved && saved.value === TOKENIZER_VERSION) return;

  // Read everything before opening the write transaction to avoid overlapping
  // transactions on the same store.
  const docs = await db.getAll('docs');
  const cached = await db.getAll('docCache');

  const tx = db.transaction(['index', 'docCache', 'queryCache'], 'readwrite');
  const indexStore = tx.objectStore('index');
  await indexStore.clear();
  await tx.objectStore('queryCache').clear();

  for (const doc of docs) {
    for (const term of docTerms(doc)) {
      const post = await indexStore.get(term);
      if (!post) await indexStore.put({ term, urls: [doc.url] });
      else if (!post.urls.includes(doc.url)) {
        post.urls.push(doc.url);
        await indexStore.put(post);
      }
    }
  }

  // Re-derive cached peer terms so bloom filters match the new scheme too.
  const cacheStore = tx.objectStore('docCache');
  for (const c of cached) {
    c.terms = [
      ...stemmed(c.title || ''),
      ...stemmed(c.description || ''),
      ...stemmed(c.direct_keywords || ''),
      ...stemmed(c.related_keywords || '')
    ];
    await cacheStore.put(c);
  }

  await tx.done;
  await db.put('settings', { key: 'tokenizerVersion', value: TOKENIZER_VERSION });
}

async function unindexTerms(indexStore, doc) {
  for (const term of docTerms(doc)) {
    const post = await indexStore.get(term);
    if (!post) continue;
    post.urls = post.urls.filter(u => u !== doc.url);
    if (post.urls.length) await indexStore.put(post);
    else await indexStore.delete(term);
  }
}

async function indexTerms(indexStore, doc) {
  for (const term of docTerms(doc)) {
    const post = await indexStore.get(term);
    if (!post) {
      await indexStore.put({ term, urls: [doc.url] });
    } else if (!post.urls.includes(doc.url)) {
      post.urls.push(doc.url);
      await indexStore.put(post);
    }
  }
}

// --- Per-domain keyword stats (common-term deprioritization) ----------------

// Count a doc's keywords into its domain's stats: { domain, docs, terms }.
async function addDomainTerms(statsStore, doc) {
  const domain = hostnameOf(doc.url);
  if (!domain) return;
  const row = (await statsStore.get(domain)) || { domain, docs: 0, terms: {} };
  row.docs += 1;
  for (const t of domainTerms(doc)) row.terms[t] = (row.terms[t] || 0) + 1;
  await statsStore.put(row);
}

// Remove a doc's keywords from its domain's stats (re-index / delete).
async function removeDomainTerms(statsStore, doc) {
  const domain = hostnameOf(doc.url);
  if (!domain) return;
  const row = await statsStore.get(domain);
  if (!row) return;
  for (const t of domainTerms(doc)) {
    const next = (row.terms[t] || 0) - 1;
    if (next <= 0) delete row.terms[t];
    else row.terms[t] = next;
  }
  row.docs -= 1;
  if (row.docs <= 0) await statsStore.delete(domain);
  else await statsStore.put(row);
}

// User-level variants: the same counting, but across the whole index (key 'self').
async function addUserTerms(statsStore, doc) {
  const row = (await statsStore.get('self')) || { key: 'self', docs: 0, terms: {} };
  row.docs += 1;
  for (const t of domainTerms(doc)) row.terms[t] = (row.terms[t] || 0) + 1;
  await statsStore.put(row);
}

async function removeUserTerms(statsStore, doc) {
  const row = await statsStore.get('self');
  if (!row) return;
  for (const t of domainTerms(doc)) {
    const next = (row.terms[t] || 0) - 1;
    if (next <= 0) delete row.terms[t];
    else row.terms[t] = next;
  }
  row.docs -= 1;
  if (row.docs <= 0) await statsStore.delete('self');
  else await statsStore.put(row);
}

// Keyword frequency stats for a domain, or null when unknown.
export async function getDomainStats(domain) {
  if (!domain) return null;
  const db = await getDB();
  return (await db.get('domainStats', domain)) || null;
}

// Keyword frequency stats across the whole index, or null when unknown.
export async function getUserStats() {
  const db = await getDB();
  return (await db.get('userStats', 'self')) || null;
}

// Upsert a doc (replaces existing entry for the same url) and keep the
// inverted index and per-domain keyword stats in sync.
export async function saveDoc(doc) {
  const db = await getDB();
  const tx = db.transaction(['docs', 'index', 'domainStats', 'userStats'], 'readwrite');
  const docsStore = tx.objectStore('docs');
  const indexStore = tx.objectStore('index');
  const domainStore = tx.objectStore('domainStats');
  const userStore = tx.objectStore('userStats');

  const old = await docsStore.get(doc.url);
  if (old) {
    await unindexTerms(indexStore, old);
    await removeDomainTerms(domainStore, old);
    await removeUserTerms(userStore, old);
  }
  await docsStore.put(doc);
  await indexTerms(indexStore, doc);
  await addDomainTerms(domainStore, doc);
  await addUserTerms(userStore, doc);

  await tx.done;
  await db.put('manifest', { url: doc.url, hash: await docHash(doc), ts: Date.now() });
  return doc;
}

export async function deleteDoc(url) {
  const db = await getDB();
  const tx = db.transaction(['docs', 'index', 'domainStats', 'userStats', 'kwHistory'], 'readwrite');
  const docsStore = tx.objectStore('docs');
  const indexStore = tx.objectStore('index');
  const domainStore = tx.objectStore('domainStats');
  const userStore = tx.objectStore('userStats');

  const doc = await docsStore.get(url);
  let removed = false;
  let wasOwned = false;
  if (doc) {
    await unindexTerms(indexStore, doc);
    await removeDomainTerms(domainStore, doc);
    await removeUserTerms(userStore, doc);
    await docsStore.delete(url);
    removed = true;
    wasOwned = true;
  }
  await tx.objectStore('kwHistory').delete(url);
  await tx.done;

  // Drop it from cached queries so it doesn't reappear right after deletion.
  const qcRows = await db.getAll('queryCache');
  for (const row of qcRows) {
    if (row.results && row.results.some(r => r.url === url)) {
      const filtered = row.results.filter(r => r.url !== url);
      if (filtered.length) await db.put('queryCache', { ...row, results: filtered });
      else await db.delete('queryCache', row.query);
      removed = true;
    }
  }

  // Drop any cached peer copies (our local redundancy copy; the author's index
  // is unaffected).
  const cached = await db.getAll('docCache');
  for (const c of cached) {
    if (c.url === url) {
      await db.delete('docCache', c.id);
      removed = true;
    }
  }

  if (wasOwned) await db.delete('manifest', url);

  return { removed, wasOwned };
}

// --- Search ---------------------------------------------------------------

function score(doc, matchCount) {
  const ageDays = (Date.now() / 1000 - doc.timestamp) / 86400;
  return matchCount * 1000 + Math.max(0, 1000 - ageDays);
}

async function cacheQuery(db, key, results) {
  const existing = await db.getAll('queryCache');
  if (existing.length >= MAX_QUERY_CACHE) {
    existing.sort((a, b) => a.ts - b.ts);
    await db.delete('queryCache', existing[0].query);
  }
  await db.put('queryCache', { query: key, results, ts: Date.now() });
}

export async function search(query, { limit = 20 } = {}) {
  const terms = stemmed(query);
  if (!terms.length) return [];

  const key = terms.join(' ');
  const db = await getDB();

  const cached = await db.get('queryCache', key);
  if (cached) {
    cached.results.forEach(r => (r.cached = true));
    return cached.results.slice(0, limit);
  }

  const matchCount = new Map();
  for (const term of terms) {
    const post = await db.get('index', term);
    for (const url of post?.urls || []) {
      matchCount.set(url, (matchCount.get(url) || 0) + 1);
    }
  }

  // When nothing matches exactly, fall back to prefix matches on the index
  // terms ("sourdo" -> "sourdough"). A bounded key-range scan, not fuzzy.
  if (!matchCount.size && typeof IDBKeyRange !== 'undefined') {
    for (const term of terms) {
      const posts = await db.getAll('index', IDBKeyRange.bound(term, term + '\uffff'));
      for (const post of posts) {
        for (const url of post.urls || []) {
          matchCount.set(url, (matchCount.get(url) || 0) + 1);
        }
        if (matchCount.size >= MAX_PREFIX_URLS) break;
      }
      if (matchCount.size >= MAX_PREFIX_URLS) break;
    }
  }
  if (!matchCount.size) return [];

  const docsStore = db.transaction('docs').store;
  const out = [];
  for (const [url, count] of matchCount) {
    const doc = await docsStore.get(url);
    if (doc) out.push({ ...doc, matchCount: count });
  }

  const results = out
    .map(d => ({ ...d, score: score(d, d.matchCount) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  await cacheQuery(db, key, results);
  return results;
}

export async function getRecent(limit = 20) {
  const db = await getDB();
  const docs = await db.getAllFromIndex('docs', 'timestamp');
  return docs.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
}

// Terms of the whole local index — feeds the bloom filter builder.
export async function allIndexedTerms() {
  const db = await getDB();
  const rows = await db.getAll('index');
  return rows.map(r => r.term);
}
