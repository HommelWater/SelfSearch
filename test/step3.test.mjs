import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import 'fake-indexeddb/auto';

globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {}
};

// Capture the mesh's streaming broadcasts (chrome.runtime.sendMessage).
const streamed = [];
globalThis.chrome = {
  runtime: { sendMessage: (msg) => { streamed.push(msg); return Promise.resolve(); } }
};

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
  // Simulate a remote peer that answers every query after a short delay.
  send(npub, msg) {
    sentLog.push({ to: npub, msg });
    if (msg.type === 'query') {
      setTimeout(() => {
        const result = signWireDoc(realDeps, skFriend, {
          authorNpub: FRIEND_NPUB, url: 'https://remote.example/result',
          title: 'Remote Result', description: 'found on the remote peer',
          direct_keywords: msg.query, related_keywords: '',
          timestamp: Math.floor(Date.now() / 1000)
        });
        this.options.onMessage(npub, {
          type: 'query_answer',
          queryId: msg.queryId,
          results: [{ ...result, matchCount: 2 }]
        });
      }, 10);
    }
  }
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
const mesh = await import('../core/mesh.js');
const { signWireDoc } = await import('./helpers.mjs');

const skFriend = realDeps.generateSecretKey();
const FRIEND_NPUB = realDeps.nip19.npubEncode(realDeps.getPublicKey(skFriend));
const OTHER_NPUB = realDeps.nip19.npubEncode(realDeps.getPublicKey(realDeps.generateSecretKey()));

test('peer search returns local + remote results', async () => {
  // Local doc about "quantum banana".
  await saveDoc({
    url: 'https://local.example/quantum',
    title: 'Quantum Banana Theory',
    description: 'bananas and quantum mechanics',
    direct_keywords: 'quantum banana theory',
    related_keywords: 'physics fruit',
    timestamp: Math.floor(Date.now() / 1000),
    image_hash: ''
  });

  // Start mesh, add a friend (fake transport marks them connected).
  const st = await mesh.handleMeshRequest({ p2p: true, op: 'status' });
  assert.equal(st.success, true);
  assert.ok(lastP2P, 'mesh created a p2p instance');

  const added = await mesh.handleMeshRequest({ p2p: true, op: 'addFriend', npub: FRIEND_NPUB });
  assert.equal(added.success, true, added.error || '');
  assert.equal(lastP2P.connections.size, 1);

  // Search with a short network timeout.
  const resp = await mesh.handleMeshRequest({ p2p: true, op: 'search', query: 'quantum banana', limit: 20, timeout: 300 });
  assert.equal(resp.success, true, resp.error || '');
  assert.equal(resp.queriedPeers, 1, 'query should be sent to the connected friend');
  assert.equal(resp.answeredPeers, 1, 'fake peer should answer');

  const urls = resp.results.map(r => r.url);
  assert.ok(urls.includes('https://local.example/quantum'), 'local result present');
  assert.ok(urls.includes('https://remote.example/result'), 'remote result present');

  const local = resp.results.find(r => r.url === 'https://local.example/quantum');
  const remote = resp.results.find(r => r.url === 'https://remote.example/result');
  assert.equal(local.source, 'local');
  assert.equal(remote.source, 'peer');

  // Streaming: the mesh broadcasts partials tagged with the queryId.
  const partials = streamed.filter(m => m.type === 'search_partial' && m.queryId === resp.queryId);
  assert.ok(partials.length >= 1, 'search partials should be broadcast');
  const done = partials.find(p => p.done);
  assert.ok(done, 'a final done partial should be broadcast');
  assert.ok(done.results.some(r => r.url === 'https://remote.example/result'), 'done partial includes the peer result');
  assert.equal(done.answeredPeers, 1);

  // The query message that went over the wire carries a hop budget + path.
  const queryMsg = sentLog.find(e => e.msg.type === 'query');
  assert.ok(queryMsg, 'a query message was sent');
  assert.ok(Array.isArray(queryMsg.msg.path) && queryMsg.msg.path.length === 1);
  assert.ok(queryMsg.msg.hops >= 1);
});

test('mesh responds to an incoming query with local results', async () => {
  const st = await mesh.handleMeshRequest({ p2p: true, op: 'status' });
  // Simulate a friend asking us a question our index can answer.
  lastP2P.options.onMessage(OTHER_NPUB, {
    type: 'query',
    queryId: 'q_inbound_1',
    query: 'quantum banana',
    hops: 1,
    origin: OTHER_NPUB,
    path: [OTHER_NPUB],
    limit: 10
  });
  await new Promise(r => setTimeout(r, 20));
  const answer = sentLog.find(e => e.msg.type === 'query_answer');
  assert.ok(answer, 'we should answer inbound queries');
  assert.equal(answer.msg.queryId, 'q_inbound_1');
  assert.equal(answer.msg.results[0].authorNpub, st.status.npub, 'answers are attributed to us');
});

mesh.stopMesh();
