import assert from 'node:assert/strict';
import { test } from 'node:test';
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

const { saveDoc } = await import('../core/search.js');
const { getDB } = await import('../core/db.js');
const mesh = await import('../core/mesh.js');

mesh.setMeshDeps({ NostrP2P: FakeNostrP2P, SimplePool: FakeSimplePool, relays: [] });

const FRIEND = realDeps.nip19.npubEncode(realDeps.getPublicKey(realDeps.generateSecretKey()));

const DOC_URL = 'https://repair.example/page';
const now = Math.floor(Date.now() / 1000);

test('reconcile finds nothing wrong when docs match the manifest', async () => {
  await mesh.handleMeshRequest({ p2p: true, op: 'status' });
  await saveDoc({ url: DOC_URL, title: 'My Page', description: 'content', direct_keywords: 'repair', related_keywords: '', timestamp: now, image_hash: '' });
  const db = await getDB();
  assert.ok(await db.get('manifest', DOC_URL), 'manifest entry created on save');

  const resp = await mesh.handleMeshRequest({ p2p: true, op: 'reconcileDocs' });
  assert.equal(resp.success, true);
  assert.equal(resp.lost.length, 0, 'intact doc is not flagged for repair');
});

test('a missing doc is repaired from a peer cache with a verified signature', async () => {
  // Connect a friend we can request the doc from.
  await mesh.handleMeshRequest({ p2p: true, op: 'addFriend', npub: FRIEND });

  // Capture our own signed copy (a friend would have this cached).
  sentLog.length = 0;
  lastP2P.deliverFrom(FRIEND, { type: 'backfill_request', since: 0 });
  await mesh.flushMesh();
  const backfill = sentLog.find(e => e.msg.type === 'backfill');
  const signedDoc = backfill.msg.docs.find(d => d.url === DOC_URL);
  assert.ok(signedDoc && signedDoc.sig, 'we serve signed copies');

  // Simulate unintentional loss: the doc vanishes from `docs` but the manifest
  // (which tracks what we own) remains.
  const db = await getDB();
  await db.delete('docs', DOC_URL);

  sentLog.length = 0;
  const resp = await mesh.handleMeshRequest({ p2p: true, op: 'reconcileDocs' });
  assert.equal(resp.lost.length, 1, 'missing doc flagged');
  assert.equal(resp.lost[0].url, DOC_URL);

  // A friend answers the doc_request with our signed doc.
  await mesh.flushMesh();
  const req = sentLog.find(e => e.msg.type === 'doc_request');
  assert.ok(req, 'a doc_request went to the friend');
  lastP2P.deliverFrom(FRIEND, { type: 'doc_response', doc: signedDoc });
  await mesh.flushMesh();

  const restored = await db.get('docs', DOC_URL);
  assert.ok(restored, 'doc restored from the peer cache');
  assert.equal(restored.title, 'My Page');
  assert.ok(await db.get('manifest', DOC_URL), 'manifest entry still present');
});

test('a corrupted doc is detected and flagged for repair', async () => {
  const db = await getDB();
  const doc = await db.get('docs', DOC_URL);
  // Simulate silent corruption: content changed after indexing.
  await db.put('docs', { ...doc, title: 'TAMPERED PAGE' });
  const resp = await mesh.handleMeshRequest({ p2p: true, op: 'reconcileDocs' });
  const flagged = resp.lost.find(l => l.url === DOC_URL);
  assert.equal(flagged && flagged.reason, 'corrupt', 'hash mismatch detected as corrupt');
});

mesh.stopMesh();
