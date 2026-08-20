import assert from 'node:assert/strict';
import { test } from 'node:test';
import './vendor/fake-indexeddb/auto.mjs';

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

const { getDB, settings } = await import('../core/db.js');
const mesh = await import('../core/mesh.js');
const { signWireDoc } = await import('./helpers.mjs');

mesh.setMeshDeps({ NostrP2P: FakeNostrP2P, SimplePool: FakeSimplePool, relays: [] });

const skFriend = realDeps.generateSecretKey();
const FRIEND = realDeps.nip19.npubEncode(realDeps.getPublicKey(skFriend));

test('setProfile stores locally and shares it over the direct channel', async () => {
  await mesh.handleMeshRequest({ p2p: true, op: 'status' });
  await mesh.handleMeshRequest({ p2p: true, op: 'addFriend', npub: FRIEND });
  sentLog.length = 0;

  const resp = await mesh.handleMeshRequest({ p2p: true, op: 'setProfile', name: 'Alice', avatar: '🌻', bio: 'hello from alice' });
  assert.equal(resp.success, true);
  const saved = await settings.get('profile');
  assert.equal(saved.name, 'Alice');
  assert.equal(saved.avatar, '🌻');
  assert.equal(saved.bio, 'hello from alice');
  assert.ok(saved.ts > 0, 'profile stamped with a timestamp for last-write-wins');

  const sent = sentLog.find(e => e.to === FRIEND && e.msg.type === 'profile');
  assert.ok(sent, 'profile should be sent to the connected friend');
  assert.equal(sent.msg.profile.name, 'Alice');
});

test('getPeers returns profiles and recently-indexed peer docs', async () => {
  const now = Math.floor(Date.now() / 1000);
  // Friend backfills a signed doc -> cached.
  const friendDoc = signWireDoc(realDeps, skFriend, {
    authorNpub: FRIEND,
    url: 'https://friend.example/post', title: 'Weekend Baking', description: 'sourdough on saturday',
    direct_keywords: 'sourdough baking', related_keywords: '', timestamp: now
  });
  lastP2P.deliverFrom(FRIEND, { type: 'backfill', since: 0, docs: [friendDoc] });
  // A peer profile we heard about via gossip.
  const db = await getDB();
  await db.put('profiles', { npub: FRIEND, name: 'Alice', avatar: '🌻', bio: '', ts: now });
  await mesh.flushMesh();

  const resp = await mesh.handleMeshRequest({ p2p: true, op: 'getPeers' });
  assert.equal(resp.success, true);
  assert.equal(resp.peers.profiles[FRIEND].name, 'Alice');
  assert.ok(resp.peers.recentByPeer[FRIEND], 'peer should appear in the recent feed');
  assert.equal(resp.peers.recentByPeer[FRIEND][0].url, 'https://friend.example/post');
});

mesh.stopMesh();
