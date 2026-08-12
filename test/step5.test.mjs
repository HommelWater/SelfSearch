import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import 'fake-indexeddb/auto';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const realDeps = await import('../lib/nostr-deps.js');

// --- Fake transport: replaces WebRTC/relays for the mesh -------------------
const sentLog = [];
let lastP2P = null;

class FakeSimplePool {
  constructor() { this.subs = []; }
  subscribeMany() { const sub = { close() {} }; this.subs.push(sub); return sub; }
  publish() { return []; }
  close() {}
}

class FakeNostrP2P {
  constructor(skHex, options) {
    lastP2P = this;
    this.options = options;
    this._connections = new Map();
    this.peers = new Set([this.npub]);
  }
  get connections() { return this._connections; }
  addPeer(npub) { this.peers.add(npub); }
  connect(npub) { this._connections.set(npub, { npub }); }
  removePeer(npub) { this._connections.delete(npub); }
  close() {}
  send(npub, msg) { sentLog.push({ to: npub, msg }); }
  deliverFrom(npub, msg) { this.options.onMessage(npub, msg); }
}

mock.module(new URL('../lib/nostr-p2p.js', import.meta.url), {
  exports: { NostrP2P: FakeNostrP2P }
});
mock.module(new URL('../lib/nostr-deps.js', import.meta.url), {
  exports: {
    SimplePool: FakeSimplePool,
    finalizeEvent: realDeps.finalizeEvent,
    generateSecretKey: realDeps.generateSecretKey,
    getPublicKey: realDeps.getPublicKey,
    nip19: realDeps.nip19,
    schnorr: realDeps.schnorr,
    sha256: realDeps.sha256,
    bytesToHex: realDeps.bytesToHex,
    hexToBytes: realDeps.hexToBytes
  }
});

const { saveDoc, deleteDoc } = await import('../core/search.js');
const { getDB, settings } = await import('../core/db.js');
const mesh = await import('../core/mesh.js');

const FRIEND = realDeps.nip19.npubEncode(realDeps.getPublicKey(realDeps.generateSecretKey()));

async function cachedDocs() {
  const db = await getDB();
  return await db.getAll('docCache');
}

test('docCache: backfill stores peer docs, served back in queries', async () => {
  await mesh.handleMeshRequest({ p2p: true, op: 'status' });
  await mesh.handleMeshRequest({ p2p: true, op: 'addFriend', npub: FRIEND });

  // Friend proactively backfills a doc about "sourdough".
  const now = Math.floor(Date.now() / 1000);
  lastP2P.deliverFrom(FRIEND, {
    type: 'backfill',
    since: 0,
    docs: [{
      url: 'https://friend.example/recipe',
      title: 'Sourdough Recipe',
      description: 'how to make sourdough bread',
      direct_keywords: 'sourdough bread baking',
      related_keywords: '',
      timestamp: now
    }]
  });
  await new Promise(r => setTimeout(r, 20));

  const cached = await cachedDocs();
  assert.equal(cached.length, 1, 'backfilled doc should be cached');
  assert.equal(cached[0].authorNpub, FRIEND, 'cached doc keeps the author npub');
  assert.ok(cached[0].terms.includes('sourdough'), 'cached doc stores searchable terms');

  // A query for "sourdough" should be answered with the cached doc, attributed
  // to the friend (even though we never indexed it ourselves).
  sentLog.length = 0;
  lastP2P.deliverFrom(FRIEND, {
    type: 'query', queryId: 'q1', query: 'sourdough', hops: 0, origin: FRIEND, path: [FRIEND], limit: 10
  });
  await new Promise(r => setTimeout(r, 20));
  const answer = sentLog.find(e => e.msg.type === 'query_answer');
  assert.ok(answer, 'we should answer the query');
  const hit = answer.msg.results.find(r => r.url === 'https://friend.example/recipe');
  assert.ok(hit, 'cached doc served in the answer');
  assert.equal(hit.authorNpub, FRIEND, 'served cached doc attributed to its author');

  // Friend detail: full index history from the cache.
  const peerDocs = await mesh.handleMeshRequest({ p2p: true, op: 'getPeerDocs', npub: FRIEND });
  assert.equal(peerDocs.success, true);
  assert.equal(peerDocs.docs.length, 1);
  assert.equal(peerDocs.docs[0].url, 'https://friend.example/recipe');
});

test('docCache: LRU eviction removes oldest beyond the cap', async () => {
  await settings.set('cacheCap', 2);
  const base = Math.floor(Date.now() / 1000);
  lastP2P.deliverFrom(FRIEND, {
    type: 'backfill', since: 0,
    docs: [
      { url: 'https://a.example/1', title: 'alpha', description: 'alpha one', direct_keywords: 'alpha', related_keywords: '', timestamp: base },
      { url: 'https://b.example/2', title: 'beta', description: 'beta two', direct_keywords: 'beta', related_keywords: '', timestamp: base + 1 },
      { url: 'https://c.example/3', title: 'gamma', description: 'gamma three', direct_keywords: 'gamma', related_keywords: '', timestamp: base + 2 }
    ]
  });
  await new Promise(r => setTimeout(r, 30));

  const remaining = (await cachedDocs()).map(c => c.url).sort();
  assert.equal(remaining.length, 2, 'only the cap remains after eviction');
  assert.ok(!remaining.includes('https://a.example/1'), 'oldest cached doc evicted first');
  assert.ok(remaining.includes('https://b.example/2') && remaining.includes('https://c.example/3'));

  await settings.set('cacheCap', 20000); // reset
});

mesh.stopMesh();
