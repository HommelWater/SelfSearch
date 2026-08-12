import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import 'fake-indexeddb/auto';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const realDeps = await import('../lib/nostr-deps.js');

const pools = [];
let lastP2P = null;

class FakeSimplePool {
  constructor() { this.published = []; pools.push(this); }
  subscribeMany() { return { close() {} }; }
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
const sentLog = [];

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

const { getDB, settings } = await import('../core/db.js');
const mesh = await import('../core/mesh.js');

const FRIEND = realDeps.nip19.npubEncode(realDeps.getPublicKey(realDeps.generateSecretKey()));

test('setProfile stores locally and gossips a PROFILE_KIND event', async () => {
  await mesh.handleMeshRequest({ p2p: true, op: 'status' });

  const resp = await mesh.handleMeshRequest({ p2p: true, op: 'setProfile', name: 'Alice', avatar: '🌻', bio: 'hello from alice' });
  assert.equal(resp.success, true);
  assert.deepEqual(await settings.get('profile'), { name: 'Alice', avatar: '🌻', bio: 'hello from alice' });

  const ev = pools[0].published.find(e => e.kind === 25012);
  assert.ok(ev, 'a profile event should be gossiped');
  const content = JSON.parse(ev.content);
  assert.equal(content.name, 'Alice');
});

test('getPeers returns profiles and recently-indexed peer docs', async () => {
  const now = Math.floor(Date.now() / 1000);
  // Friend backfills a doc -> cached.
  lastP2P.deliverFrom(FRIEND, {
    type: 'backfill', since: 0,
    docs: [{ url: 'https://friend.example/post', title: 'Weekend Baking', description: 'sourdough on saturday', direct_keywords: 'sourdough baking', related_keywords: '', timestamp: now }]
  });
  // A peer profile we heard about via gossip.
  const db = await getDB();
  await db.put('profiles', { npub: FRIEND, name: 'Alice', avatar: '🌻', bio: '', ts: now });
  await new Promise(r => setTimeout(r, 20));

  const resp = await mesh.handleMeshRequest({ p2p: true, op: 'getPeers' });
  assert.equal(resp.success, true);
  assert.equal(resp.peers.profiles[FRIEND].name, 'Alice');
  assert.ok(resp.peers.recentByPeer[FRIEND], 'peer should appear in the recent feed');
  assert.equal(resp.peers.recentByPeer[FRIEND][0].url, 'https://friend.example/post');
});

mesh.stopMesh();
