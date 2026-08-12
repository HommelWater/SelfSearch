import { getDB } from './db.js';
import { docTerms, tokenize } from './tokenize.js';

const MAX_QUERY_CACHE = 200;

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

// Upsert a doc (replaces existing entry for the same url) and keep the
// inverted index in sync. imageBlob (optional) is stored locally.
export async function saveDoc(doc, imageBlob) {
  const db = await getDB();
  const tx = db.transaction(['docs', 'index', 'images'], 'readwrite');
  const docsStore = tx.objectStore('docs');
  const indexStore = tx.objectStore('index');

  const old = await docsStore.get(doc.url);
  if (old) await unindexTerms(indexStore, old);
  await docsStore.put(doc);
  await indexTerms(indexStore, doc);

  if (imageBlob && doc.image_hash) {
    await tx.objectStore('images').put({ hash: doc.image_hash, blob: imageBlob });
  }
  await tx.done;
  await db.put('manifest', { url: doc.url, hash: await docHash(doc), ts: Date.now() });
  return doc;
}

export async function deleteDoc(url) {
  const db = await getDB();
  const tx = db.transaction(['docs', 'index', 'images'], 'readwrite');
  const docsStore = tx.objectStore('docs');
  const indexStore = tx.objectStore('index');

  const doc = await docsStore.get(url);
  let removed = false;
  let wasOwned = false;
  if (doc) {
    await unindexTerms(indexStore, doc);
    await docsStore.delete(url);
    if (doc.image_hash) await tx.objectStore('images').delete(doc.image_hash);
    removed = true;
    wasOwned = true;
  }
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
  const terms = tokenize(query);
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
