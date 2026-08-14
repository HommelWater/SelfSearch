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

const { getDB, settings } = await import('../core/db.js');
const mesh = await import('../core/mesh.js');

const skFriend = realDeps.generateSecretKey();
const pkFriend = realDeps.getPublicKey(skFriend);
const FRIEND = realDeps.nip19.npubEncode(pkFriend);
const INVITER = realDeps.nip19.npubEncode(realDeps.getPublicKey(realDeps.generateSecretKey()));

test('sendInvite publishes an invite event and tracks it', async () => {
  const st = await mesh.handleMeshRequest({ p2p: true, op: 'status' });
  assert.equal(st.success, true);
  assert.ok(!st.status.friends.includes(FRIEND));

  const resp = await mesh.handleMeshRequest({ p2p: true, op: 'sendInvite', npub: FRIEND, message: 'hi!' });
  assert.equal(resp.success, true);
  const ev = pools[0].published.find(e => e.kind === 25013);
  assert.ok(ev, 'invite event should be gossiped');
  assert.equal(JSON.parse(ev.content).invitee, FRIEND);

  const db = await getDB();
  const out = await db.get('invites', `out|${FRIEND}`);
  assert.ok(out, 'outgoing invite tracked');
});

test('accepting an invite adds the inviter and records the acceptance', async () => {
  const db = await getDB();
  await db.put('invites', { id: `in|${INVITER}`, dir: 'in', npub: INVITER, message: '', ts: Date.now(), status: 'pending' });

  const resp = await mesh.handleMeshRequest({ p2p: true, op: 'respondInvite', npub: INVITER, accept: true });
  assert.equal(resp.success, true);
  assert.ok(resp.friends.includes(INVITER), 'inviter added as a friend');

  const acc = await settings.get('acceptedInvites');
  assert.ok(acc && acc.includes(INVITER), 'acceptance remembered for the direct handshake');

  assert.equal(await db.get('invites', `in|${INVITER}`), undefined, 'invite cleared after accepting');
});

test('invite_accept over the direct channel finalizes our side', async () => {
  await mesh.handleMeshRequest({ p2p: true, op: 'status' });
  // We invited the friend; they accepted and connected, telling us over the
  // data channel. (No relay events involved.)
  const db = await getDB();
  await db.put('invites', { id: `out|${FRIEND}`, dir: 'out', npub: FRIEND, message: '', ts: Date.now(), status: 'pending' });

  lastP2P.deliverFrom(FRIEND, { type: 'invite_accept' });
  await new Promise(r => setTimeout(r, 20));

  const after = await mesh.handleMeshRequest({ p2p: true, op: 'status' });
  assert.ok(after.status.friends.includes(FRIEND), 'invitee added as a friend after accepting');
  assert.equal(lastP2P.connections.has(FRIEND), true, 'connection initiated to the invitee');
  assert.equal(await db.get('invites', `out|${FRIEND}`), undefined, 'outgoing invite cleared');
});

mesh.stopMesh();
