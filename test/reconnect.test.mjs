import assert from 'node:assert/strict';
import { test, mock } from 'node:test';

const realDeps = await import('../lib/nostr-deps.js');

// --- Fakes ------------------------------------------------------------------
const pools = [];
class FakeSimplePool {
  constructor() { this.published = []; pools.push(this); }
  subscribeMany() { return { close() {} }; }
  publish(relays, event) { this.published.push(event); return [Promise.resolve()]; }
  close() {}
}

class FakeChannel {
  constructor() { this.readyState = 'open'; this.onopen = null; this.onclose = null; this.onmessage = null; }
  send() {}
  close() {}
}

class FakePC {
  constructor() {
    this.localDescription = null;
    this.remoteDescription = null;
    this.signalingState = 'stable';
    this.connectionState = 'new';
    this.iceConnectionState = 'new';
    this.onicecandidate = null;
    this.onconnectionstatechange = null;
    this.oniceconnectionstatechange = null;
    this.ondatachannel = null;
  }
  createDataChannel() { return new FakeChannel(); }
  createOffer() { this.signalingState = 'have-local-offer'; return Promise.resolve({ type: 'offer', sdp: 'offer-sdp' }); }
  setLocalDescription(d) { this.localDescription = d; return Promise.resolve(); }
  setRemoteDescription(d) { this.remoteDescription = d; this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable'; return Promise.resolve(); }
  createAnswer() { return Promise.resolve({ type: 'answer', sdp: 'answer-sdp' }); }
  addIceCandidate() { return Promise.resolve(); }
  close() { this.connectionState = 'closed'; }
}
globalThis.RTCPeerConnection = FakePC;
globalThis.RTCIceCandidate = class { constructor(c) { this.c = c; } };

// nostr-p2p imports nostr-deps with a cache-busting query; mock that instance.
mock.module(new URL('../lib/nostr-deps.js?v=10', import.meta.url), {
  exports: {
    SimplePool: FakeSimplePool,
    finalizeEvent: realDeps.finalizeEvent,
    generateSecretKey: realDeps.generateSecretKey,
    getPublicKey: realDeps.getPublicKey,
    nip19: realDeps.nip19,
    nip44: realDeps.nip44,
    schnorr: realDeps.schnorr,
    sha256: realDeps.sha256,
    bytesToHex: realDeps.bytesToHex,
    hexToBytes: realDeps.hexToBytes
  }
});

const { NostrP2P } = await import('../lib/nostr-p2p.js');

// Deterministic clock so we can age an offer past PENDING_TIMEOUT.
let fakeNow = Date.now();
const origNow = Date.now;
Date.now = () => fakeNow;

test('a stale re-offer of an in-flight handshake is re-answered (no reconnect deadlock)', async () => {
  const skA = realDeps.bytesToHex(realDeps.generateSecretKey());
  const pkA = realDeps.getPublicKey(realDeps.hexToBytes(skA));
  const npubA = realDeps.nip19.npubEncode(pkA);
  const skB = realDeps.bytesToHex(realDeps.generateSecretKey());
  const pkB = realDeps.getPublicKey(realDeps.hexToBytes(skB));

  const b = new NostrP2P(skB, { peers: new Set([npubA]) });
  const bPool = pools[0];

  // A's offer to B (encrypted as A would send it).
  const ck = realDeps.nip44.getConversationKey(realDeps.hexToBytes(skA), pkB);
  const offerTs = Math.floor(fakeNow / 1000);
  const content = realDeps.nip44.encrypt(
    JSON.stringify({ type: 'offer', ots: offerTs, sdp: { type: 'offer', sdp: 'sdp-1' } }),
    ck
  );
  const offerEvent = { id: 'x', sig: 'y', kind: 25000, created_at: offerTs, tags: [['p', pkB]], pubkey: pkA, content };

  // 1. First (fresh) offer → B creates an answering session and publishes an answer.
  await b.handleSignal(offerEvent);
  assert.equal(b.sessions.size, 1, 'B should hold an answering session');
  const session = [...b.sessions.values()][0];
  assert.equal(session.initiator, false);
  assert.ok(session.answerSdp, 'answer SDP should be remembered');
  assert.equal(bPool.published.length, 1, 'answer should be published');

  // 2. The initiator re-sends the *same* offer 31s later (now a stale ots).
  //    This is the reconnect deadlock: the answering session is kept alive by
  //    the re-sends, so neither side times out, but the stale offer used to be
  //    dropped by the age guard — meaning the answer was never re-sent and the
  //    handshake could never complete.
  fakeNow += 31000;
  await b.handleSignal(offerEvent);
  assert.equal(bPool.published.length, 2, 'stale re-offer must re-trigger an answer, not be dropped');

  b.close();
  Date.now = origNow;
});

test('allowSelf links to our own npub but skips our own signals', async () => {
  const sk = realDeps.bytesToHex(realDeps.generateSecretKey());
  const pk = realDeps.getPublicKey(realDeps.hexToBytes(sk));
  const npub = realDeps.nip19.npubEncode(pk);

  const inst = new NostrP2P(sk, { allowSelf: true });
  // A device may initiate a connection to its own npub (multi-device sync).
  inst.connect(npub);
  assert.equal(inst.sessions.has(npub), true, 'device may connect to its own npub');

  // The relay echoes our own published signal back — it must be ignored so we
  // never handshake with ourselves.
  const id = inst._sendSignal(pk, { type: 'offer', ots: 1, sdp: { type: 'offer', sdp: 'x' } });
  await inst.handleSignal({ id, pubkey: pk, kind: 25000, created_at: 1, tags: [['p', pk]], content: 'x', sig: 'x' });
  assert.equal(inst.sessions.size, 1, 'own signal must not create a second session');
  inst.close();
});

test('allowSelf accepts our own npub as a peer and answers a device handshake', async () => {
  const sk = realDeps.bytesToHex(realDeps.generateSecretKey());
  const pk = realDeps.getPublicKey(realDeps.hexToBytes(sk));
  const npub = realDeps.nip19.npubEncode(pk);

  const inst = new NostrP2P(sk, { allowSelf: true, peers: new Set() });
  const pool = pools[pools.length - 1];

  // The mesh links device sync by adding our own npub as a known peer.
  inst.addPeer(npub);
  assert.equal(inst.peers.has(npub), true, 'own npub accepted as a peer with allowSelf');
  const publishedBefore = pool.published.length; // maintenance may already offer

  // The other device (same identity key) offers a handshake addressed to us.
  const ck = realDeps.nip44.getConversationKey(realDeps.hexToBytes(sk), pk);
  const offerTs = Math.floor(Date.now() / 1000);
  const content = realDeps.nip44.encrypt(
    JSON.stringify({ type: 'offer', ots: offerTs, sdp: { type: 'offer', sdp: 'device-sdp' } }),
    ck
  );
  const offerEvent = { id: 'device-offer', sig: 'y', kind: 25000, created_at: offerTs, tags: [['p', pk]], pubkey: pk, content };

  await inst.handleSignal(offerEvent);
  assert.equal(inst.sessions.size, 1, 'device offer must not be dropped');
  const s = [...inst.sessions.values()][0];
  assert.equal(s.initiator, false, 'we answer the other device handshake');
  assert.ok(pool.published.length > publishedBefore, 'an answer is published for the device link');
  inst.close();
});
