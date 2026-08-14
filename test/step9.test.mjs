import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import './vendor/fake-indexeddb/auto.mjs';

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
const { canonicalDoc, signWireDoc, signTombstone } = await import('./helpers.mjs');

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

  // The author deletes the page, telling us over the direct channel.
  lastP2P.deliverFrom(FRIEND, signTombstone(realDeps, skFriend, FRIEND, 'https://gone.example/1', Math.floor(Date.now() / 1000)));
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

test('publishTombstone broadcasts to friends and stores locally', async () => {
  const st = await mesh.handleMeshRequest({ p2p: true, op: 'status' });
  await mesh.handleMeshRequest({ p2p: true, op: 'addFriend', npub: FRIEND });
  sentLog.length = 0;

  const url = 'https://own.example/deleted';
  const resp = await mesh.handleMeshRequest({ p2p: true, op: 'publishTombstone', url });
  assert.equal(resp.success, true);
  const sent = sentLog.find(e => e.to === FRIEND && e.msg.type === 'tombstone' && e.msg.url === url);
  assert.ok(sent, 'tombstone broadcast to connected friends');
  const db = await getDB();
  assert.ok(await db.get('tombstones', `${st.status.npub}|${url}`), 'tombstone stored locally');
});

test('an older cached copy never overwrites a newer one (last-write-wins)', async () => {
  const now = Math.floor(Date.now() / 1000);
  const newer = signWireDoc(realDeps, skFriend, {
    authorNpub: FRIEND, url: 'https://lww.example/1', title: 'Newer',
    description: 'lww newer', direct_keywords: 'lww', related_keywords: '', timestamp: now
  });
  lastP2P.deliverFrom(FRIEND, { type: 'backfill', since: 0, docs: [newer] });
  await new Promise(r => setTimeout(r, 20));

  const older = signWireDoc(realDeps, skFriend, {
    authorNpub: FRIEND, url: 'https://lww.example/1', title: 'Older (stale)',
    description: 'lww older', direct_keywords: 'lww', related_keywords: '', timestamp: now - 1000
  });
  lastP2P.deliverFrom(FRIEND, { type: 'backfill', since: 0, docs: [older] });
  await new Promise(r => setTimeout(r, 20));

  const c = await cached('https://lww.example/1');
  assert.ok(c, 'doc cached');
  assert.equal(c.title, 'Newer', 'older copy must not replace the newer one');
});

test('forged query answers are dropped before being shown', async () => {
  await mesh.handleMeshRequest({ p2p: true, op: 'addFriend', npub: FRIEND });
  const now = Math.floor(Date.now() / 1000);
  const real = signWireDoc(realDeps, skFriend, {
    authorNpub: FRIEND, url: 'https://forge.example/real', title: 'Real Page',
    description: 'realforge needle', direct_keywords: 'needle', related_keywords: '', timestamp: now
  });
  const forged = { ...signWireDoc(realDeps, skFriend, {
    authorNpub: FRIEND, url: 'https://forge.example/forged', title: 'Real-ish',
    description: 'forge needle', direct_keywords: 'needle', related_keywords: '', timestamp: now
  }), title: 'FORGED' };

  const respPromise = mesh.handleMeshRequest({
    p2p: true, op: 'search', query: 'needle', queryId: 'forge-q', timeout: 3000
  });
  await new Promise(r => setTimeout(r, 50));
  lastP2P.deliverFrom(FRIEND, { type: 'query_answer', queryId: 'forge-q', results: [real, forged] });
  const resp = await respPromise;

  assert.equal(resp.success, true);
  const urls = resp.results.map(r => r.url);
  assert.ok(urls.includes('https://forge.example/real'), 'valid answer is shown');
  assert.ok(!urls.includes('https://forge.example/forged'), 'forged answer is dropped');
});

test('trust declarations propagate over the data channel into the trust graph', async () => {
  const skOther = realDeps.generateSecretKey();
  const OTHER = realDeps.nip19.npubEncode(realDeps.getPublicKey(skOther));
  // Our friend trusts someone we don't know — they tell us over the channel.
  lastP2P.deliverFrom(FRIEND, { type: 'trust_declaration', truster: FRIEND, trusted: OTHER, maxHops: 2 });
  await new Promise(r => setTimeout(r, 20));

  const peers = await mesh.handleMeshRequest({ p2p: true, op: 'getPeers' });
  const reach = peers.peers.reachable.find(r => r.npub === OTHER);
  assert.ok(reach, 'friend-of-friend becomes reachable via the declaration');
  assert.equal(reach.depth, 2, 'declared peer sits two hops away');
});

test('a forged trust declaration (not self-signed) is ignored', async () => {
  const skAttacker = realDeps.generateSecretKey();
  const VICTIM = realDeps.nip19.npubEncode(realDeps.getPublicKey(skAttacker));
  const skOther = realDeps.generateSecretKey();
  const OTHER = realDeps.nip19.npubEncode(realDeps.getPublicKey(skOther));
  // A peer cannot claim *someone else* trusts the target.
  lastP2P.deliverFrom(FRIEND, { type: 'trust_declaration', truster: VICTIM, trusted: OTHER, maxHops: 2 });
  await new Promise(r => setTimeout(r, 20));
  const peers = await mesh.handleMeshRequest({ p2p: true, op: 'getPeers' });
  assert.ok(!peers.peers.reachable.some(r => r.npub === OTHER), 'declaration signed by a third party is dropped');
});

test('signed tombstones are verified and forwarded to peers-of-peers', async () => {
  // Two connected friends: FRIEND (the author) and a second hop FRIEND2.
  const skOther = realDeps.generateSecretKey();
  const FRIEND2 = realDeps.nip19.npubEncode(realDeps.getPublicKey(skOther));
  await mesh.handleMeshRequest({ p2p: true, op: 'addFriend', npub: FRIEND2 });
  sentLog.length = 0;

  const now = Math.floor(Date.now() / 1000);
  const url = 'https://forward.example/1';
  const doc = signWireDoc(realDeps, skFriend, {
    authorNpub: FRIEND, url, title: 'Forwarded', description: 'forward me',
    direct_keywords: 'forward', related_keywords: '', timestamp: now
  });
  lastP2P.deliverFrom(FRIEND, { type: 'backfill', since: 0, docs: [doc] });
  await new Promise(r => setTimeout(r, 20));
  assert.ok(await cached(url), 'doc cached from author');

  // The author deletes it: verify + apply + forward to the other friend.
  const tomb = signTombstone(realDeps, skFriend, FRIEND, url, Math.floor(Date.now() / 1000));
  lastP2P.deliverFrom(FRIEND, tomb);
  await new Promise(r => setTimeout(r, 20));

  assert.equal(await cached(url), undefined, 'cached copy removed locally');
  const fwd = sentLog.find(e => e.to === FRIEND2 && e.msg.type === 'tombstone' && e.msg.url === url);
  assert.ok(fwd, 'tombstone forwarded to the other connected peer');
});

test('an unsigned or forged tombstone is not applied or forwarded', async () => {
  const skOther = realDeps.generateSecretKey();
  const FRIEND2 = realDeps.nip19.npubEncode(realDeps.getPublicKey(skOther));
  await mesh.handleMeshRequest({ p2p: true, op: 'addFriend', npub: FRIEND2 });
  sentLog.length = 0;

  const now = Math.floor(Date.now() / 1000);
  const url = 'https://forward-bad.example/1';
  const doc = signWireDoc(realDeps, skFriend, {
    authorNpub: FRIEND, url, title: 'Stay', description: 'stay cached',
    direct_keywords: 'stay', related_keywords: '', timestamp: now
  });
  lastP2P.deliverFrom(FRIEND, { type: 'backfill', since: 0, docs: [doc] });
  await new Promise(r => setTimeout(r, 20));
  assert.ok(await cached(url), 'doc cached from author');

  // No signature at all.
  lastP2P.deliverFrom(FRIEND, { type: 'tombstone', url });
  await new Promise(r => setTimeout(r, 20));
  assert.ok(await cached(url), 'unsigned tombstone is ignored');

  // Signed, but by someone who is not the claimed author (wrong key).
  const forged = signTombstone(realDeps, skOther, FRIEND, url, Math.floor(Date.now() / 1000));
  lastP2P.deliverFrom(FRIEND, forged);
  await new Promise(r => setTimeout(r, 20));
  assert.ok(await cached(url), 'tombstone whose signature does not match its author is ignored');
  assert.ok(!sentLog.some(e => e.msg.type === 'tombstone' && e.msg.url === url), 'no forwarding of a bad tombstone');
});

mesh.stopMesh();
