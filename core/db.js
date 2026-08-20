import { openDB } from '../lib/idb.js';
import { hostnameOf, domainTerms } from './domain.js';
import { rebuildIndexForVersion } from './search.js';

const DB_NAME = 'selfsearch';
const DB_VERSION = 10;

let dbPromise = null;

// Stores:
//   docs         keyPath url     — your own indexed pages
//   docCache     keyPath id      — peers' docs (id = authorNpub + '|' + url)
//   index        keyPath term    — inverted index term -> { term, urls: [url...] }
//   domainStats  keyPath domain  — per-domain keyword frequency (common-term deprioritization)
//   userStats    keyPath key     — keyword frequency across the whole index (key 'self')
//   kwHistory    keyPath url     — recent keyword captures per URL (stable-keyword consensus)
//   queryCache   keyPath query   — rolling LRU query -> results
//   trust        keyPath id      — trust edges (id = truster + '|' + trusted)
//   profiles     keyPath npub    — gossiped peer profiles (name, avatar, bio)
//   invites      keyPath id      — friend invites (id = in|npub / out|npub)
//   tombstones   keyPath id      — signed deletes (id = authorNpub + '|' + url)
//   manifest     keyPath url     — owned-doc content hashes (for repair/sync)
//   settings     keyPath key     — kv settings (nostr key, friends, ...)

// Rebuild per-domain keyword stats from scratch (doc -> domain -> keywords).
// Runs once per session when the DB first opens so existing docs contribute to
// common-term detection immediately; saveDoc keeps the store updated afterwards.
export async function rebuildDomainStats(db) {
  const docs = await db.getAll('docs');
  const rows = new Map();
  for (const doc of docs) {
    const domain = hostnameOf(doc.url);
    if (!domain) continue;
    let row = rows.get(domain);
    if (!row) {
      row = { domain, docs: 0, terms: {} };
      rows.set(domain, row);
    }
    row.docs += 1;
    for (const t of domainTerms(doc)) row.terms[t] = (row.terms[t] || 0) + 1;
  }
  const tx = db.transaction('domainStats', 'readwrite');
  await tx.store.clear();
  for (const row of rows.values()) await tx.store.put(row);
  await tx.done;
}

// Per-user keyword stats: how common each keyword is across the whole index,
// not just one domain. Same { docs, terms } shape as domain stats, keyed 'self'.
export async function rebuildUserStats(db) {
  const docs = await db.getAll('docs');
  const row = { key: 'self', docs: 0, terms: {} };
  for (const doc of docs) {
    row.docs += 1;
    for (const t of domainTerms(doc)) row.terms[t] = (row.terms[t] || 0) + 1;
  }
  const tx = db.transaction('userStats', 'readwrite');
  await tx.store.clear();
  await tx.store.put(row);
  await tx.done;
}

export function getDB() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion, newVersion, transaction) {
        if (!db.objectStoreNames.contains('docs')) {
          const s = db.createObjectStore('docs', { keyPath: 'url' });
          s.createIndex('timestamp', 'timestamp');
        }
        if (!db.objectStoreNames.contains('docCache')) {
          const s = db.createObjectStore('docCache', { keyPath: 'id' });
          s.createIndex('addedAt', 'addedAt');
        } else if (transaction && !transaction.objectStore('docCache').indexNames.contains('addedAt')) {
          transaction.objectStore('docCache').createIndex('addedAt', 'addedAt');
        }
        if (!db.objectStoreNames.contains('index')) {
          db.createObjectStore('index', { keyPath: 'term' });
        }
        if (!db.objectStoreNames.contains('domainStats')) {
          db.createObjectStore('domainStats', { keyPath: 'domain' });
        }
        if (!db.objectStoreNames.contains('userStats')) {
          db.createObjectStore('userStats', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('kwHistory')) {
          db.createObjectStore('kwHistory', { keyPath: 'url' });
        }
        if (!db.objectStoreNames.contains('queryCache')) {
          db.createObjectStore('queryCache', { keyPath: 'query' });
        }
        if (!db.objectStoreNames.contains('trust')) {
          db.createObjectStore('trust', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('profiles')) {
          db.createObjectStore('profiles', { keyPath: 'npub' });
        }
        if (!db.objectStoreNames.contains('invites')) {
          db.createObjectStore('invites', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('tombstones')) {
          db.createObjectStore('tombstones', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('manifest')) {
          db.createObjectStore('manifest', { keyPath: 'url' });
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
      }
    }).then(async (db) => {
      await rebuildDomainStats(db);
      return db;
    }).then(async (db) => {
      await rebuildUserStats(db);
      return db;
    }).then(async (db) => {
      // Rebuild the inverted index if the tokenizer changed (e.g. stemming was
      // added). Static import even though search.js imports getDB — the ESM
      // cycle is safe because neither side calls the other at eval time, and
      // dynamic import() is not allowed in a service worker.
      await rebuildIndexForVersion(db);
      return db;
    });
  }
  return dbPromise;
}

export const settings = {
  async get(key) {
    const db = await getDB();
    return (await db.get('settings', key))?.value;
  },
  async set(key, value) {
    const db = await getDB();
    await db.put('settings', { key, value });
  },
  async all() {
    const db = await getDB();
    const rows = await db.getAll('settings');
    return Object.fromEntries(rows.map(r => [r.key, r.value]));
  },
  async del(key) {
    const db = await getDB();
    await db.delete('settings', key);
  }
};

export async function docCount() {
  const db = await getDB();
  return await db.count('docs');
}

export async function getDoc(url) {
  const db = await getDB();
  return await db.get('docs', url);
}

export async function getAllDocs() {
  const db = await getDB();
  return await db.getAll('docs');
}

export async function allDocTerms() {
  const db = await getDB();
  const rows = await db.getAll('index');
  const out = [];
  for (const r of rows) out.push(r.term);
  return out;
}
