import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import 'fake-indexeddb/auto';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const realDeps = await import('../lib/nostr-deps.js');

const pools = [];
let lastP2P = null;
const sentLog = [];

class FakeSimplePool {
  constructor() { this.published = []; pools.push(this); }
  subscribeMany(relays, filters, params) { this.onevent = params.onevent; return { close() {} }; }
  publish(relays, event) { this.published.push(event); return [Promise.resolve()]; }
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

const { saveDoc } = await import('../core/search.js');
const { getDB } = await import('../core/db.js');
const mesh = await import('../core/mesh.js');
const { canonicalDoc, signWireDoc } = await import('./helpers.mjs');

const skFriend = realDeps.generateSecretKey();
const FRIEND = realDeps.nip19.npubEncode(realDeps.getPublicKey(skFriend));

async function cached(url) {
  const db = await getDB();
  const all = await db.getAll('docCache');
  return all.find(c => c.url === url);
}

test('docs we serve are signed and verify against our pubkey', async () => {
  const st = await mesh.handleMeshRequest({ p2p: true, op: 'status' });
  await saveDoc({
    url: 'https://me.example/post', title: 'My Post', description: 'my content',
    direct_keywords: 'content', related_keywords: '', timestamp: Math.floor(Date.now() / 1000), image_hash: ''
  });
  sentLog.length = 0;
  lastP2P.deliverFrom(FRIEND, { type: 'backfill_request', since: 0 });
  await new Promise(r => setTimeout(r, 20));

  const backfill = sentLog.find(e => e.msg.type === 'backfill');
  assert.ok(backfill, 'we should answer a backfill request');
  const doc = backfill.msg.docs.find(d => d.url === 'https://me.example/post');
  assert.ok(doc && doc.sig, 'served doc carries a signature');
  const pkHex = realDeps.nip19.decode(st.status.npub).data;
  const payload = {
    authorNpub: doc.authorNpub, url: doc.url, title: doc.title, description: doc.description,
    direct_keywords: doc.direct_keywords, related_keywords: doc.related_keywords, timestamp: doc.timestamp
  };
  const ok = realDeps.schnorr.verify(realDeps.hexToBytes(doc.sig), realDeps.sha256(new TextEncoder().encode(canonicalDoc(payload))), realDeps.hexToBytes(pkHex));
  assert.equal(ok, true, 'signature verifies against our pubkey');
});

test('unsigned or tampered docs are not cached', async () => {
  const now = Math.floor(Date.now() / 1000);
  // No signature at all.
  lastP2P.deliverFrom(FRIEND, {
    type: 'backfill', since: 0,
    docs: [{ url: 'https://bad.example/1', title: 'Unsigned', description: '', direct_keywords: 'x', related_keywords: '', timestamp: now, authorNpub: FRIEND }]
  });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(await cached('https://bad.example/1'), undefined, 'unsigned doc must be dropped');

  // Tampered: signed, then content changed after signing.
  const signed = signWireDoc(realDeps, skFriend, {
    authorNpub: FRIEND, url: 'https://bad.example/2', title: 'Real', description: '',
    direct_keywords: 'real', related_keywords: '', timestamp: now
  });
  const tampered = { ...signed, title: 'TAMPERED' };
  lastP2P.deliverFrom(FRIEND, { type: 'backfill', since: 0, docs: [tampered] });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(await cached('https://bad.example/2'), undefined, 'tampered doc must be dropped');
});

test('tombstones remove cached copies and block re-adds unless the doc is newer', async () => {
  const now = Math.floor(Date.now() / 1000);
  // Friend signs a doc and we cache it.
  const doc = signWireDoc(realDeps, skFriend, {
    authorNpub: FRIEND, url: 'https://gone.example/1', title: 'Doomed', description: 'doomed page',
    direct_keywords: 'doomed', related_keywords: '', timestamp: now
  });
  lastP2P.deliverFrom(FRIEND, { type: 'backfill', since: 0, docs: [doc] });
  await new Promise(r => setTimeout(r, 20));
  assert.ok(await cached('https://gone.example/1'), 'doc cached initially');

  // A signed tombstone from the author arrives via relays.
  const tombstone = realDeps.finalizeEvent({
    kind: 25016,
    created_at: now + 100,
    tags: [],
    content: JSON.stringify({ url: 'https://gone.example/1', author: FRIEND })
  }, skFriend);
  await pools[0].onevent(tombstone);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(await cached('https://gone.example/1'), undefined, 'cached copy removed by tombstone');

  // Re-caching the OLD version is blocked…
  lastP2P.deliverFrom(FRIEND, { type: 'backfill', since: 0, docs: [doc] });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(await cached('https://gone.example/1'), undefined, 'old version stays hidden after delete');

  // …but the author re-adding the page with a NEWER timestamp wins.
  const reAdded = signWireDoc(realDeps, skFriend, {
    authorNpub: FRIEND, url: 'https://gone.example/1', title: 'Doomed (v2)', description: 'doomed page v2',
    direct_keywords: 'doomed', related_keywords: '', timestamp: now + 200
  });
  lastP2P.deliverFrom(FRIEND, { type: 'backfill', since: 0, docs: [reAdded] });
  await new Promise(r => setTimeout(r, 20));
  const fresh = await cached('https://gone.example/1');
  assert.ok(fresh, 'newer version re-cached after delete');
  assert.equal(fresh.title, 'Doomed (v2)');
});

test('publishTombstone gossips an event and broadcasts to friends', async () => {
  const url = 'https://own.example/deleted';
  const resp = await mesh.handleMeshRequest({ p2p: true, op: 'publishTombstone', url });
  assert.equal(resp.success, true);
  const ev = pools[0].published.find(e => e.kind === 25016);
  assert.ok(ev, 'tombstone event gossiped');
  assert.equal(JSON.parse(ev.content).url, url);
  const db = await getDB();
  assert.ok(await db.get('tombstones', `${(await mesh.handleMeshRequest({ p2p: true, op: 'status' })).status.npub}|${url}`), 'tombstone stored locally');
});

mesh.stopMesh();
