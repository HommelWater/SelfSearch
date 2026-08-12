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

const { getDB } = await import('../core/db.js');
const mesh = await import('../core/mesh.js');
const { signWireDoc } = await import('./helpers.mjs');

const nsecHex = realDeps.bytesToHex(realDeps.generateSecretKey());
const nsecSk = realDeps.hexToBytes(nsecHex);
const NPUB = realDeps.nip19.npubEncode(realDeps.getPublicKey(nsecSk));
const now = Math.floor(Date.now() / 1000);

test('setIdentity rekeys the mesh and enables device sync', async () => {
  await mesh.handleMeshRequest({ p2p: true, op: 'status' });
  const resp = await mesh.handleMeshRequest({ p2p: true, op: 'setIdentity', nsec: nsecHex });
  assert.equal(resp.success, true, resp.error || '');
  assert.equal(resp.npub, NPUB, 'mesh rekeyed to the identity of the nsec');

  const peers = await mesh.handleMeshRequest({ p2p: true, op: 'getPeers' });
  assert.equal(peers.peers.syncDevices, true, 'device sync enabled by default');
  assert.ok(lastP2P.connections.has(NPUB), 'linked to our own npub (the other device)');

  const identity = await mesh.handleMeshRequest({ p2p: true, op: 'getIdentity' });
  assert.equal(identity.nsec, nsecHex, 'the nsec is exposed for copying across devices');
  assert.equal(identity.npub, NPUB);
});

test('backfill from a same-identity device restores docs into our own index', async () => {
  const doc = signWireDoc(realDeps, nsecSk, {
    authorNpub: NPUB, url: 'https://sync.example/1', title: 'From Device A',
    description: 'synced across devices', direct_keywords: 'sync', related_keywords: '', timestamp: now
  });
  lastP2P.deliverFrom(NPUB, { type: 'backfill', since: 0, docs: [doc] });
  await new Promise(r => setTimeout(r, 20));

  const db = await getDB();
  const stored = await db.get('docs', 'https://sync.example/1');
  assert.ok(stored, 'doc restored as our own, not just cached');
  assert.equal(stored.title, 'From Device A');
  assert.ok(await db.get('manifest', 'https://sync.example/1'), 'manifest updated for synced doc');
  const cached = await db.getAll('docCache');
  assert.ok(!cached.some(c => c.url === 'https://sync.example/1'), 'not duplicated into the peer cache');
});

test('device sync is last-write-wins by timestamp', async () => {
  const db = await getDB();
  // An older copy of the same page must not overwrite our newer one.
  const older = signWireDoc(realDeps, nsecSk, {
    authorNpub: NPUB, url: 'https://sync.example/1', title: 'Stale Title',
    description: 'old', direct_keywords: 'sync', related_keywords: '', timestamp: now - 500
  });
  lastP2P.deliverFrom(NPUB, { type: 'backfill', since: 0, docs: [older] });
  await new Promise(r => setTimeout(r, 20));
  assert.equal((await db.get('docs', 'https://sync.example/1')).title, 'From Device A', 'older copy ignored');

  // A newer copy wins.
  const newer = signWireDoc(realDeps, nsecSk, {
    authorNpub: NPUB, url: 'https://sync.example/1', title: 'From Device A (edited)',
    description: 'newer', direct_keywords: 'sync', related_keywords: '', timestamp: now + 500
  });
  lastP2P.deliverFrom(NPUB, { type: 'backfill', since: 0, docs: [newer] });
  await new Promise(r => setTimeout(r, 20));
  assert.equal((await db.get('docs', 'https://sync.example/1')).title, 'From Device A (edited)', 'newer copy applied');
});

mesh.stopMesh();
