import { openDB } from '../lib/idb.js';

const DB_NAME = 'selfsearch';
const DB_VERSION = 4;

let dbPromise = null;

// Stores:
//   docs        keyPath url        — your own indexed pages
//   docCache    keyPath id         — peers' docs (id = authorNpub + '|' + url)
//   index       keyPath term       — inverted index term -> { term, urls: [url...] }
//   queryCache  keyPath query      — rolling LRU query -> results
//   images      keyPath hash       — screenshots, never shared
//   trust       keyPath id         — trust edges (id = truster + '|' + trusted)
//   settings    keyPath key        — kv settings (nostr key, friends, vision models, ...)
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
        if (!db.objectStoreNames.contains('queryCache')) {
          db.createObjectStore('queryCache', { keyPath: 'query' });
        }
        if (!db.objectStoreNames.contains('images')) {
          db.createObjectStore('images', { keyPath: 'hash' });
        }
        if (!db.objectStoreNames.contains('trust')) {
          db.createObjectStore('trust', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
      }
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
