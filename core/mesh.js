import { NostrP2P } from '../lib/nostr-p2p.js';
import {
  SimplePool, finalizeEvent, generateSecretKey, getPublicKey, nip19,
  schnorr, sha256, bytesToHex, hexToBytes
} from '../lib/nostr-deps.js';
import { settings, getDB } from './db.js';
import { search as localSearch, searchAll as localSearchAll, allIndexedTerms, saveDoc, docHash } from './search.js';
import { stemmed } from './tokenize.js';
import { BloomFilter } from './bloom.js';

// --- Test seam --------------------------------------------------------------
// The mesh talks to the world through two network-facing classes (NostrP2P for
// WebRTC data channels, SimplePool for relay events). Tests inject fakes here
// instead of mocking modules, which is fragile across Node versions. Crypto
// (generateSecretKey, schnorr, nip19, ...) is never injected — it works fine
// and is needed to sign/verify real wire docs in the tests.
let injectedDeps = null;
export function setMeshDeps(deps) {
  injectedDeps = deps || null;
}
export function resetMeshDeps() {
  injectedDeps = null;
}

// Relays carry exactly two kinds of traffic, both addressed to a specific
// pubkey: signaling (WebRTC handshakes, handled in lib/nostr-p2p.js) and
// friend invites. Everything else travels over direct peer connections.
const INVITE_KIND = 25013;  // friend invite: { invitee, message }
const TOMBSTONE_CAP = 5000;
const REPAIR_TIMEOUT = 30 * 1000; // re-request a lost doc after this long
const FILTER_INTERVAL = 30 * 1000;
const GOSSIP_SINCE = 3600;  // seconds of past gossip to replay on subscribe
const MAX_HOPS_CAP = 5;
const QUERY_TIMEOUT = 2500; // hard cap to collect peer answers before returning
const GRACE_MS = 500;       // extra window for 2-hop answers after all direct peers respond
const SEEN_TTL = 20 * 1000; // keep query dedup/relay state this long
const GOSSIP_DEDUP_TTL = 15 * 60 * 1000; // ignore re-delivered gossip events this long

const DOC_CACHE_CAP = 20000;          // max cached peer docs before LRU eviction
const BACKFILL_INTERVAL = 5 * 60 * 1000; // proactive friend sync cadence
const BACKFILL_MAX = 1000;            // max docs per backfill response

const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.nostrplebs.com',
  'wss://relay.snort.social'
];

function resolveRelays() {
  try {
    const stored = (typeof localStorage !== 'undefined') && localStorage.getItem('nostr_p2p_relays');
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    }
  } catch { /* fall through to defaults */ }
  return DEFAULT_RELAYS;
}

const RELAYS = resolveRelays();

const RELAY_FAIL_LOG_MS = 60 * 1000; // log each dead relay at most once a minute
const relayFailLog = new Map();

function log(...a) {
  console.log('[mesh]', ...a);
}

let state = null;

async function ensureKeys() {
  let sk = await settings.get('nostrSecretKey');
  if (!sk || !/^[0-9a-f]{64}$/.test(sk)) {
    sk = bytesToHex(generateSecretKey());
    await settings.set('nostrSecretKey', sk);
    log('generated new keypair');
  }
  state.skHex = sk;
  state.sk = hexToBytes(sk);
  state.pk = getPublicKey(state.sk);
  state.npub = nip19.npubEncode(state.pk);
}

async function loadEdges() {
  state.edges = new Map();
  const db = await getDB();
  const rows = await db.getAll('trust');
  for (const r of rows) {
    if (!state.edges.has(r.truster)) state.edges.set(r.truster, []);
    state.edges.get(r.truster).push({ trusted: r.trusted, maxHops: r.maxHops });
  }
}

async function storeEdge(truster, trusted, maxHops) {
  const db = await getDB();
  await db.put('trust', { id: `${truster}|${trusted}`, truster, trusted, maxHops });
  if (!state.edges.has(truster)) state.edges.set(truster, []);
  const list = state.edges.get(truster);
  const i = list.findIndex(e => e.trusted === trusted);
  if (i >= 0) list[i] = { trusted, maxHops };
  else list.push({ trusted, maxHops });
}

function verifyEvent(e) {
  try {
    const serialized = JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]);
    const id = bytesToHex(sha256(new TextEncoder().encode(serialized)));
    if (id !== e.id) return false;
    return schnorr.verify(hexToBytes(e.sig), hexToBytes(e.id), hexToBytes(e.pubkey));
  } catch {
    return false;
  }
}

// --- Signed docs ------------------------------------------------------------

// Deterministic JSON (sorted keys) so signatures are reproducible everywhere.
function canonicalJson(obj) {
  if (Array.isArray(obj)) return '[' + obj.map(canonicalJson).join(',') + ']';
  if (obj && typeof obj === 'object') {
    return '{' + Object.keys(obj).sort()
      .map(k => `"${k}":${canonicalJson(obj[k])}`).join(',') + '}';
  }
  return JSON.stringify(obj);
}

function docPayload(d) {
  return {
    authorNpub: state.npub,
    url: d.url,
    title: d.title || '',
    description: d.description || '',
    direct_keywords: d.direct_keywords || '',
    related_keywords: d.related_keywords || '',
    timestamp: d.timestamp || 0
  };
}

function signDoc(doc) {
  const msg = sha256(new TextEncoder().encode(canonicalJson(docPayload(doc))));
  return bytesToHex(schnorr.sign(msg, state.sk));
}

// Verify a wire doc ({...fields, authorNpub, sig}). Returns true only for a
// valid author signature over the canonical payload.
function verifyDoc(d) {
  try {
    const pkHex = nip19.decode(d.authorNpub).data;
    const payload = {
      authorNpub: d.authorNpub,
      url: d.url,
      title: d.title || '',
      description: d.description || '',
      direct_keywords: d.direct_keywords || '',
      related_keywords: d.related_keywords || '',
      timestamp: d.timestamp || 0
    };
    const msg = sha256(new TextEncoder().encode(canonicalJson(payload)));
    return schnorr.verify(hexToBytes(d.sig), msg, hexToBytes(pkHex));
  } catch {
    return false;
  }
}

// --- Tombstones (signed deletes) --------------------------------------------

// A doc is hidden while a tombstone from its author is newer than (or equal to)
// it. If the author re-indexes the page later, the newer doc wins again.
async function isTombstoned(authorNpub, url, docTs) {
  const db = await getDB();
  const t = await db.get('tombstones', `${authorNpub}|${url}`);
  return !!(t && t.ts >= (docTs || 0));
}

// Sign a delete so it can propagate hop-by-hop through the mesh: every relay
// hop forwards the signed tombstone, and any receiver verifies it against the
// author's key before dropping their cached copy.
function signTombstone(url, ts) {
  const msg = sha256(new TextEncoder().encode(canonicalJson({ authorNpub: state.npub, url, ts })));
  return bytesToHex(schnorr.sign(msg, state.sk));
}

function verifyTombstone(t) {
  try {
    const pkHex = nip19.decode(t.authorNpub).data;
    const msg = sha256(new TextEncoder().encode(canonicalJson({ authorNpub: t.authorNpub, url: t.url, ts: t.ts })));
    return schnorr.verify(hexToBytes(t.sig), msg, hexToBytes(pkHex));
  } catch {
    return false;
  }
}

async function applyTombstone(authorNpub, url, ts) {
  const db = await getDB();
  await db.put('tombstones', { id: `${authorNpub}|${url}`, authorNpub, url, ts });
  let removed = false;
  const cached = await db.getAll('docCache');
  for (const c of cached) {
    if (c.authorNpub === authorNpub && c.url === url) {
      await db.delete('docCache', c.id);
      removed = true;
    }
  }
  if (removed) state.cacheDirty = true;
  // Keep the tombstone store bounded (LRU by timestamp).
  const rows = await db.getAll('tombstones');
  if (rows.length > TOMBSTONE_CAP) {
    rows.sort((a, b) => a.ts - b.ts);
    await db.delete('tombstones', rows[0].id);
  }
}

// A signed delete arrived over the data channel: verify it against the author,
// apply it locally, and forward it so peers-of-peers drop their cached copies
// too. Deduped so a tombstone doesn't bounce forever through the mesh.
async function handleTombstone(sender, msg) {
  const { url, authorNpub, ts, sig } = msg;
  if (!url || !authorNpub || !Number.isFinite(ts) || !sig) return;
  if (!verifyTombstone({ authorNpub, url, ts, sig })) return;
  const key = `tomb|${authorNpub}|${url}|${ts}`;
  const seenTs = state.seenEvents.get(key) || 0;
  if (Date.now() - seenTs < GOSSIP_DEDUP_TTL) return;
  state.seenEvents.set(key, Date.now());
  await applyTombstone(authorNpub, url, ts);
  for (const [npub] of state.p2p.connections) {
    if (npub === sender) continue;
    sendSafe(npub, { type: 'tombstone', url, authorNpub, ts, sig });
  }
}

// --- Repair (self-healing) ---------------------------------------------------

// Populate the manifest once from existing docs so pre-existing pages are
// trackable too.
async function ensureManifest(db) {
  if ((await db.getAll('manifest')).length) return;
  const docs = await db.getAll('docs');
  for (const d of docs) {
    await db.put('manifest', { url: d.url, hash: await docHash(d), ts: Date.now() });
  }
}

// Compare the manifest against the actual docs. Anything missing or with a
// mismatched content hash was lost unintentionally — request a signed copy
// from peers and restore it (LRU cache evictions are never repaired).
async function reconcileOwnedDocs() {
  if (!state || !state.started) return [];
  const db = await getDB();
  await ensureManifest(db);
  const manifest = await db.getAll('manifest');
  if (!manifest.length) return [];

  const docsStore = db.transaction('docs').store;
  const lost = [];
  for (const m of manifest) {
    const doc = await docsStore.get(m.url);
    if (!doc) {
      lost.push({ url: m.url, reason: 'missing' });
    } else if ((await docHash(doc)) !== m.hash) {
      lost.push({ url: m.url, reason: 'corrupt' });
    }
  }

  const now = Date.now();
  for (const { url } of lost) {
    if (now - (state.repairing.get(url) || 0) < REPAIR_TIMEOUT) continue;
    state.repairing.set(url, now);
    for (const [npub] of state.p2p.connections) sendSafe(npub, { type: 'doc_request', url });
  }
  return lost;
}

// A peer asks for a doc to repair its index — serve our own (signed) or any
// signed cached copy.
async function handleDocRequest(sender, msg) {
  const url = String(msg.url || '');
  if (!url) return;
  const db = await getDB();
  const own = await db.get('docs', url);
  if (own) {
    sendSafe(sender, { type: 'doc_response', doc: { ...toWireDoc(own), authorNpub: state.npub, timestamp: own.timestamp, sig: signDoc(own) } });
    return;
  }
  const cached = await db.getAll('docCache');
  const hit = cached.find(c => c.url === url);
  if (hit) {
    sendSafe(sender, {
      type: 'doc_response',
      doc: { url: hit.url, title: hit.title, description: hit.description,
        direct_keywords: hit.direct_keywords || '', related_keywords: hit.related_keywords || '',
        timestamp: hit.timestamp, authorNpub: hit.authorNpub, sig: hit.sig }
    });
  }
}

// We were repairing a doc and a peer sent a signed copy — restore it.
async function handleDocResponse(sender, msg) {
  const d = msg.doc;
  if (!d || !d.url || !d.sig) return;
  if (!state.repairing.has(d.url)) return;
  if (!verifyDoc(d)) return;
  state.repairing.delete(d.url);
  await saveDoc({
    url: d.url, title: d.title || '', description: d.description || '',
    direct_keywords: d.direct_keywords || '', related_keywords: d.related_keywords || '',
    timestamp: d.timestamp || Math.floor(Date.now() / 1000)
  });
  log(`[repair] restored ${d.url}`);
}

// Share our profile with connected peers over the data channel.
async function publishProfile() {
  if (!state) return;
  const profile = (await settings.get('profile')) || {};
  if (!profile.name && !profile.avatar && !profile.bio) return;
  const ts = profile.ts || 0;
  const msg = { type: 'profile', ts, profile: { name: profile.name || '', avatar: profile.avatar || '', bio: profile.bio || '' } };
  for (const [npub] of state.p2p.connections) sendSafe(npub, msg);
}

async function storePeerProfile(npub, profile, ts) {
  const db = await getDB();
  await db.put('profiles', { npub, name: profile.name || '', avatar: profile.avatar || '', bio: profile.bio || '', ts });
}

// A profile arrived over the data channel. Remember it for the peers feed;
// if it came from a device sharing our identity, adopt it as our own profile
// too (last-write-wins by ts) so every device of the same identity converges
// on one profile, then re-share it across the mesh.
async function handleProfileMessage(npub, msg) {
  const profile = msg.profile;
  const ts = msg.ts || Math.floor(Date.now() / 1000);
  await storePeerProfile(npub, profile, ts);
  if (npub !== state.npub) return;
  const local = (await settings.get('profile')) || {};
  const localTs = local.ts || 0;
  if (ts > localTs && (profile.name || profile.avatar || profile.bio)) {
    await settings.set('profile', { name: profile.name || '', avatar: profile.avatar || '', bio: profile.bio || '', ts });
    log(`[sync] adopted profile from device`);
    publishProfile();
  }
}

// Share our trust declarations with connected peers over the data channel, so
// friends-of-friends (and the mesh beyond) can build the same web of trust.
function sendTrustDeclarations() {
  if (!state) return;
  const mine = state.edges.get(state.npub) || [];
  for (const { trusted, maxHops } of mine) {
    const msg = { type: 'trust_declaration', truster: state.npub, trusted, maxHops };
    for (const [npub] of state.p2p.connections) sendSafe(npub, msg);
  }
}

// Add someone to our trust web (friend + edge + connect). Used by direct add,
// invite acceptance, and finalizing an accepted invite.
async function addTrusted(npub) {
  if (!state.friends.includes(npub)) {
    state.friends.push(npub);
    await settings.set('friends', state.friends);
  }
  await storeEdge(state.npub, npub, state.maxHops);
  sendTrustDeclarations();
  state.p2p.addPeer(npub);
  state.p2p.connect(npub);
}

// A friend invite arrives via relays: verify it's addressed to us + self-signed.
async function handleInviteEvent(e) {
  try {
    const { invitee, message } = JSON.parse(e.content);
    if (!invitee || invitee !== state.npub) return; // not addressed to us
    if (!verifyEvent(e)) return;
    const inviter = nip19.npubEncode(e.pubkey);
    const db = await getDB();
    await db.put('invites', {
      id: `in|${inviter}`, dir: 'in', npub: inviter,
      message: String(message || '').slice(0, 140),
      ts: Date.now(), status: 'pending'
    });
    log(`invite from ${inviter.slice(0, 12)}`);
  } catch { /* ignore malformed */ }
}

// The invitee accepted our invite over a direct connection — finalize the
// friendship (we already wanted the connection).
async function finalizeAcceptedInvite(npub) {
  const db = await getDB();
  const inv = await db.get('invites', `out|${npub}`);
  if (!inv || inv.status !== 'pending') return;
  await addTrusted(npub);
  await db.delete('invites', `out|${npub}`);
  log(`invite accepted by ${npub.slice(0, 12)}`);
}

// Share our routing bloom filter with connected peers over the data channel,
// so queries skip peers that cannot possibly match.
async function sendFilter() {
  if (!state) return;
  await refreshCachedTerms();
  const terms = await allIndexedTerms();
  for (const t of state.cachedTerms) terms.push(t);
  const bloom = BloomFilter.create(Math.max(1024, terms.length));
  bloom.addAll(terms);
  state.filterSeq++;
  const msg = { type: 'filter', bloom: bloom.toJSON(), termCount: terms.length, seq: state.filterSeq };
  for (const [npub] of state.p2p.connections) sendSafe(npub, msg);
}

// --- docCache (peer-doc redundancy) ------------------------------------------

async function getCacheCap() {
  return Math.max(1, Number(await settings.get('cacheCap')) || DOC_CACHE_CAP);
}

function docTermsOf(cachedDoc) {
  return cachedDoc.terms || [];
}

// Store peers' docs locally (keyed authorNpub|url) so their content survives
// them going offline. Covers on-demand answers and proactive friend backfill.
async function cachePeerDocs(docs) {
  if (!docs || !Array.isArray(docs) || !docs.length) return;
  const db = await getDB();
  const now = Date.now();
  let maxTs = 0;
  let idx = 0;
  for (const d of docs) {
    if (!d || !d.url || !d.authorNpub || !d.sig) continue;
    if (!verifyDoc(d)) continue;                    // tampered / unsigned → drop
    if (await isTombstoned(d.authorNpub, d.url, d.timestamp)) continue; // author deleted it
    // Last-write-wins: never let an older (but still authentic) copy roll
    // back a newer cached one — a stale peer shouldn't downgrade our cache.
    const existing = await db.get('docCache', `${d.authorNpub}|${d.url}`);
    if (existing && (existing.timestamp || 0) > (d.timestamp || 0)) continue;
    const terms = new Set([
      ...stemmed(d.title || ''),
      ...stemmed(d.description || ''),
      ...stemmed(d.direct_keywords || ''),
      ...stemmed(d.related_keywords || '')
    ]);
    await db.put('docCache', {
      id: `${d.authorNpub}|${d.url}`,
      authorNpub: d.authorNpub,
      url: d.url,
      title: d.title || '',
      description: d.description || '',
      direct_keywords: d.direct_keywords || '',
      related_keywords: d.related_keywords || '',
      timestamp: d.timestamp || Math.floor(now / 1000),
      addedAt: now + idx++, // distinct within a batch → deterministic LRU order
      terms: [...terms],
      sig: d.sig
    });
    if (d.timestamp > maxTs) maxTs = d.timestamp;
  }
  state.cacheDirty = true;
  await evictDocCache();
}

// LRU eviction: drop the oldest-added cached docs until under the cap.
async function evictDocCache() {
  const db = await getDB();
  const cap = await getCacheCap();
  const count = await db.count('docCache');
  if (count <= cap) return;
  const rows = await db.getAllFromIndex('docCache', 'addedAt');
  const overflow = rows.length - cap;
  for (let i = 0; i < overflow; i++) {
    await db.delete('docCache', rows[i].id);
  }
  state.cacheDirty = true;
}

// Rebuild the cached-term set when the cache changed (the filter only needs
// the union of terms, not per-doc data).
async function refreshCachedTerms() {
  if (!state.cacheDirty) return;
  const db = await getDB();
  const cached = await db.getAll('docCache');
  const set = new Set();
  for (const c of cached) {
    for (const t of docTermsOf(c)) set.add(t);
  }
  state.cachedTerms = set;
  state.cacheDirty = false;
}

// Invites are the only non-signaling traffic we accept from relays, and only
// when addressed to our own pubkey (the subscription filters on #p). Relays
// mirror every published event, so dedupe each invite once.
function onInviteEvent(e) {
  if (!e || !e.id) return;
  const seenTs = state.seenEvents.get(e.id) || 0;
  if (Date.now() - seenTs < GOSSIP_DEDUP_TTL) return;
  state.seenEvents.set(e.id, Date.now());
  handleInviteEvent(e).catch(() => {});
}

// --- Peer search ------------------------------------------------------------

function sendSafe(npub, msg) {
  try { state.p2p.send(npub, msg); } catch { /* not connected / closing */ }
}

function runtimeApi() {
  try { return typeof browser !== 'undefined' ? browser : chrome; } catch { return null; }
}

// Stream partial results to the search page while we're still collecting, so
// answers show up as they arrive instead of all at once at the end.
function broadcastSearchUpdate(queryId, pending, done) {
  const api = runtimeApi();
  if (!api || !api.runtime) return; // not in a messaging context (tests)
  try {
    const offset = pending.offset || 0;
    const ranked = rankResults(pending.results);
    const results = ranked.slice(offset, offset + pending.limit);
    api.runtime.sendMessage({
      type: 'search_partial',
      queryId,
      results,
      total: ranked.length,
      queriedPeers: (pending.targets || []).length,
      answeredPeers: pending.answered ? pending.answered.size : 0,
      done
    }).catch(() => {});
  } catch { /* ignore */ }
}

// Does this peer's gossiped bloom filter match any query term? Unknown filter
// → include them (small trusted network; a fresh peer may not have gossiped).
function filterMatches(npub, terms) {
  const f = state.peerFilterObjs.get(npub);
  if (!f) return true;
  return terms.some(t => f.has(t));
}

function toWireDoc(doc) {
  return {
    url: doc.url,
    title: doc.title,
    description: doc.description,
    timestamp: doc.timestamp,
    direct_keywords: doc.direct_keywords || '',
    related_keywords: doc.related_keywords || '',
    matchCount: doc.matchCount || 0
  };
}

async function handleQuery(sender, msg) {
  const { queryId, query, hops, path, limit } = msg;
  if (!queryId || !query) return;
  // Dedup: only process a query once per queryId (handles branch loops where
  // the same query reaches us via two friends).
  if (state.seenQueries.has(queryId)) return;
  state.seenQueries.set(queryId, Date.now());
  // Remember who to relay answers back to.
  if (!state.pendingRelay.has(queryId)) state.pendingRelay.set(queryId, { upstream: sender, ts: Date.now() });

  const terms = stemmed(query);

  // Always answer (even empty) so the origin knows we responded and can stop
  // waiting instead of sitting out the full collection window. Serve our own
  // docs plus anything we have cached from peers (redundancy).
  const local = terms.length ? await localSearch(query, { limit: msg.limit || 10 }) : [];
  const results = local.map(d => ({ ...toWireDoc(d), authorNpub: state.npub, sig: signDoc(d) }));
  if (terms.length) {
    const db = await getDB();
    const cached = await db.getAll('docCache');
    for (const c of cached) {
      if (!terms.some(t => docTermsOf(c).includes(t))) continue;
      results.push({
        url: c.url, title: c.title, description: c.description,
        direct_keywords: c.direct_keywords || '', related_keywords: c.related_keywords || '',
        timestamp: c.timestamp, matchCount: 1, authorNpub: c.authorNpub, sig: c.sig
      });
      if (results.length >= (msg.limit || 10) + 20) break;
    }
  }
  sendSafe(sender, { type: 'query_answer', queryId, results });

  // Forward toward the edge of the trust web if hops remain.
  if (hops > 0) {
    const nextPath = [...(path || []), state.npub];
    for (const [candidate] of state.p2p.connections) {
      if (candidate === sender || nextPath.includes(candidate)) continue;
      if (!filterMatches(candidate, terms)) continue;
      sendSafe(candidate, {
        type: 'query', queryId, query, hops: hops - 1,
        origin: msg.origin, path: nextPath, limit
      });
    }
  }
}

function handleAnswer(sender, msg) {
  const { queryId, results } = msg;
  if (!queryId || !Array.isArray(results)) return;
  // On-demand caching: whatever answers pass through us, keep a copy.
  if (results.length) track(() => cachePeerDocs(results));
  const pending = state.pendingQueries.get(queryId);
  if (pending) {
    // We originated this query — aggregate the answers. Only results carrying
    // a valid author signature are shown: a lying peer can inject forged or
    // tampered results, and those must never reach the user.
    for (const r of results) {
      if (!r || !r.url || !r.sig || !verifyDoc(r)) continue;
      const existing = pending.results.get(r.url);
      if (existing) {
        existing.matchCount = Math.max(existing.matchCount, r.matchCount || 0);
        if ((r.timestamp || 0) > (existing.timestamp || 0)) Object.assign(existing, r);
      } else {
        pending.results.set(r.url, { ...r, source: 'peer' });
      }
    }
    pending.answered.add(sender);
    pending.onUpdate?.();
    pending.onSettled?.();
    return;
  }
  // Relay the answer toward the origin.
  const relay = state.pendingRelay.get(queryId);
  if (relay) sendSafe(relay.upstream, msg);
}

// A friend asked us to backfill — send our own docs newer than `since`.
async function handleBackfillRequest(sender, msg) {
  const since = Number(msg.since) || 0;
  const db = await getDB();
  const docs = (await db.getAllFromIndex('docs', 'timestamp'))
    .filter(d => d.timestamp > since)
    .slice(-BACKFILL_MAX)
    .map(d => ({ ...toWireDoc(d), authorNpub: state.npub, timestamp: d.timestamp, sig: signDoc(d) }));
  sendSafe(sender, { type: 'backfill', since, docs });
}

// We asked a peer to backfill — store what they sent. A peer with our own npub
// is another of our devices: restore their copy into OUR index (multi-device
// sync, last-write-wins by timestamp) instead of the peer cache.
function handleBackfill(sender, msg) {
  if (!Array.isArray(msg.docs)) return;
  const isDevice = sender === state.npub;
  const task = isDevice
    ? syncDocsFromDevice(msg.docs)
    : cachePeerDocs(msg.docs.map(d => ({ ...d, authorNpub: sender })));
  // Return the promise so flushMesh (test hook) waits for the full cache+evict.
  return task
    .then(() => {
      let maxTs = 0;
      for (const d of msg.docs) if (d.timestamp > maxTs) maxTs = d.timestamp;
      if (maxTs) state.lastBackfillBy.set(sender, maxTs);
    })
    .catch(err => console.warn('[mesh] backfill failed', err));
}

// Multi-device sync: restore docs authored by our own identity (sent by one of
// our devices) into our own index. LWW by timestamp; deletes (tombstones) win
// against older copies.
async function syncDocsFromDevice(docs) {
  const db = await getDB();
  for (const d of docs) {
    if (!d || !d.url || !d.sig) continue;
    if (!verifyDoc(d)) continue;
    if (await isTombstoned(state.npub, d.url, d.timestamp)) continue; // we deleted it
    const local = await db.get('docs', d.url);
    if (local && (local.timestamp || 0) >= (d.timestamp || 0)) continue; // local is newer/equal
    await saveDoc({
      url: d.url, title: d.title || '', description: d.description || '',
      direct_keywords: d.direct_keywords || '', related_keywords: d.related_keywords || '',
      timestamp: d.timestamp || Math.floor(Date.now() / 1000)
    });
  }
  if (docs.length) log(`[sync] merged ${docs.length} docs from device`);
}

// Proactive sync for direct friends (distance 1): request their docs, sending
// a `since` so only newer content comes back.
function requestBackfills() {
  for (const [npub] of state.p2p.connections) {
    sendSafe(npub, { type: 'backfill_request', since: state.lastBackfillBy.get(npub) || 0 });
  }
}

// Fire-and-forget message handlers are tracked so tests can flush them
// deterministically (see flushMesh) instead of sleeping on a fixed delay.
const inflight = new Set();
function track(fn) {
  const p = Promise.resolve().then(fn).catch(err => console.warn('[mesh] handler error', err));
  inflight.add(p);
  p.finally(() => inflight.delete(p));
}

// Test hook: resolve once every fire-and-forget message handler has settled.
export async function flushMesh() {
  for (let i = 0; i < 100 && inflight.size; i++) {
    await Promise.allSettled([...inflight]);
    await new Promise(r => setTimeout(r, 1));
  }
}

function handlePeerMessage(npub, msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'query') {
    track(() => handleQuery(npub, msg));
  } else if (msg.type === 'query_answer') {
    track(() => handleAnswer(npub, msg));
  } else if (msg.type === 'backfill_request') {
    track(() => handleBackfillRequest(npub, msg));
  } else if (msg.type === 'backfill') {
    track(() => handleBackfill(npub, msg));
  } else if (msg.type === 'tombstone') {
    // Signed delete: verify against the author, drop our cached copy, then
    // forward so peers-of-peers learn of the deletion too.
    track(() => handleTombstone(npub, msg));
  } else if (msg.type === 'profile') {
    if (!msg.profile || typeof msg.profile !== 'object') return;
    track(() => handleProfileMessage(npub, msg));
  } else if (msg.type === 'filter') {
    const { bloom, termCount, seq } = msg;
    if (!bloom || !Number.isFinite(termCount) || !Number.isFinite(seq)) return;
    state.peerFilters.set(npub, { bloom, termCount, seq, ts: Date.now() });
    state.peerFilterObjs.set(npub, BloomFilter.fromJSON(bloom));
  } else if (msg.type === 'trust_declaration') {
    // A peer sharing who they trust. Data-channel messages are signed by the
    // sender, so a declaration can only ever claim trust on the sender's own
    // behalf (truster === npub). Feed it into our trust graph.
    const { truster, trusted, maxHops } = msg;
    if (truster !== npub || !trusted || !Number.isFinite(maxHops)) return;
    track(() => storeEdge(truster, trusted, Math.max(0, Math.min(maxHops, MAX_HOPS_CAP))));
  } else if (msg.type === 'invite_accept') {
    // They accepted our invite — finalize our side of the friendship.
    track(() => finalizeAcceptedInvite(npub));
  } else if (msg.type === 'doc_request') {
    track(() => handleDocRequest(npub, msg));
  } else if (msg.type === 'doc_response') {
    track(() => handleDocResponse(npub, msg));
  }
}

function pruneMeshState() {
  const now = Date.now();
  for (const [qid, ts] of state.seenQueries) {
    if (now - ts > SEEN_TTL) state.seenQueries.delete(qid);
  }
  for (const [qid, r] of state.pendingRelay) {
    if (now - r.ts > SEEN_TTL) state.pendingRelay.delete(qid);
  }
  for (const [id, ts] of state.seenEvents) {
    if (now - ts > GOSSIP_DEDUP_TTL) state.seenEvents.delete(id);
  }
}

// Search our own index and, in parallel, fan the query out to connected
// trusted peers whose bloom filters match. Streams partial result sets as
// answers arrive, then broadcasts a final "done" update. Returns the merged
// (deduped by URL, ranked) results at the end.
async function searchNetwork(query, { limit = 20, offset = 0, timeout = QUERY_TIMEOUT, queryId } = {}) {
  const terms = stemmed(query);
  const results = new Map();

  // Local results: ALL matches, so the merged set can be paged consistently
  // after peer answers are added.
  const local = terms.length ? await localSearchAll(query) : { results: [], total: 0 };
  for (const d of local.results) results.set(d.url, { ...toWireDoc(d), authorNpub: state.npub, source: 'local' });

  const qid = queryId || ((crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36));

  // Targets: connected peers whose filter matches any term.
  const targets = [];
  for (const [npub] of state.p2p.connections) {
    if (filterMatches(npub, terms)) targets.push(npub);
  }

  if (targets.length) {
    // Peers at depth >= 2 only get answers via our friends forwarding, which
    // takes longer than a direct round-trip — so if the trust web extends past
    // our friends, keep collecting a little longer after the last direct answer.
    const hasDeeperHops = [...computeTrustGraph().values()].some(n => n.depth >= 2);
    const started = Date.now();
    const pending = {
      results, answered: new Set(), targets, limit, offset,
      onSettled: null, onUpdate: null, broadcastTimer: null
    };
    state.pendingQueries.set(qid, pending);

    // Debounce partial broadcasts so a burst of answers coalesces into one update.
    const scheduleBroadcast = () => {
      if (pending.broadcastTimer) return;
      pending.broadcastTimer = setTimeout(() => {
        pending.broadcastTimer = null;
        broadcastSearchUpdate(qid, pending, false);
      }, 60);
    };
    pending.onUpdate = scheduleBroadcast;

    const msg = {
      type: 'query', queryId: qid, query,
      hops: Math.max(0, state.maxHops - 1),
      origin: state.npub, path: [state.npub], limit
    };
    for (const t of targets) sendSafe(t, msg);

    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      const timer = setTimeout(finish, timeout);
      pending.onSettled = () => {
        if (pending.answered.size < targets.length) return;
        clearTimeout(timer);
        if (!hasDeeperHops) finish();                       // direct answers are all we'll get
        else setTimeout(finish, Math.max(0, GRACE_MS - (Date.now() - started)));
      };
    });

    if (pending.broadcastTimer) { clearTimeout(pending.broadcastTimer); pending.broadcastTimer = null; }
    state.pendingQueries.delete(qid);

    broadcastSearchUpdate(qid, pending, true); // final
    const merged = rankResults(results);
    return {
      results: withTotal(merged.slice(offset, offset + limit), merged.length),
      queriedPeers: targets.length,
      answeredPeers: pending.answered.size,
      queryId: qid
    };
  }

  // No peers queried: stream a single "done" update so the page stops waiting.
  broadcastSearchUpdate(qid, { results, targets, limit, offset, answered: new Set() }, true);
  const merged = rankResults(results);
  return {
    results: withTotal(merged.slice(offset, offset + limit), merged.length),
    queriedPeers: 0, answeredPeers: 0, queryId: qid
  };
}

// Attach the total match count as a non-enumerable property on a result array.
function withTotal(results, total) {
  Object.defineProperty(results, 'total', { value: total, enumerable: false });
  return results;
}

function rankResults(results) {
  const now = Date.now() / 1000;
  return [...results.values()]
    .map(d => {
      const age = (now - (d.timestamp || 0)) / 86400;
      const score = (d.matchCount || 1) * 1000 + Math.max(0, 1000 - age);
      return { ...d, score };
    })
    .sort((a, b) => b.score - a.score);
}

// Keep the network warm: re-share our profile, routing filter, and trust
// declarations with connected peers so late joiners and missed messages
// self-heal.
function syncNow() {
  if (!state || !state.started) return;
  publishProfile();
  sendFilter();
  sendTrustDeclarations();
  pruneMeshState();
}

export function syncMesh() {
  if (state && state.started) syncNow();
}

// BFS over trust edges from our own key. Reachable = depth <= maxHops and every
// edge on the path declared a large enough maxHops.
export function computeTrustGraph() {
  const out = new Map();
  if (!state) return out;
  out.set(state.npub, { depth: 0, budget: state.maxHops });
  const queue = [state.npub];
  while (queue.length) {
    const t = queue.shift();
    const cur = out.get(t);
    if (cur.budget <= 0) continue;
    for (const { trusted, maxHops } of state.edges.get(t) || []) {
      if (maxHops < 1) continue; // tombstone
      const nb = Math.min(cur.budget - 1, maxHops - 1);
      const existing = out.get(trusted);
      if (!existing || nb > existing.budget) {
        out.set(trusted, { depth: cur.depth + 1, budget: nb });
        queue.push(trusted);
      }
    }
  }
  return out;
}

export async function startMesh() {
  if (state && (state.started || state.starting)) return;
  const { NostrP2P: P2PImpl = NostrP2P, SimplePool: PoolImpl = SimplePool, relays = RELAYS } = injectedDeps || {};
  state = state || {
    friends: [], maxHops: 2, edges: new Map(),
    peerFilters: new Map(), peerFilterObjs: new Map(), filterSeq: 0,
    pendingQueries: new Map(), pendingRelay: new Map(), seenQueries: new Map(),
    seenEvents: new Map(), lastBackfillBy: new Map(), cachedTerms: new Set(), cacheDirty: true,
    repairing: new Map(), syncDevices: false, acceptedInvites: [],
    started: false, starting: false, lastError: null
  };
  state.starting = true;
  try {
    await ensureKeys();
    state.friends = (await settings.get('friends')) || [];
    state.maxHops = Number(await settings.get('maxHops')) || 2;
    state.syncDevices = !!(await settings.get('syncDevices'));
    await loadEdges();

    state.pool = new PoolImpl({
      enableReconnect: true,
      onRelayConnectionFailure: (url) => {
        const last = relayFailLog.get(url) || 0;
        const now = Date.now();
        if (now - last < RELAY_FAIL_LOG_MS) return;
        relayFailLog.set(url, now);
        log(`relay unreachable: ${url}`);
      }
    });
    // The only relay subscription: friend invites addressed to our pubkey.
    // (Connection signaling is subscribed separately in NostrP2P, also filtered
    // to our pubkey.)
    state.sub = state.pool.subscribeMany(
      relays,
      { kinds: [INVITE_KIND], '#p': [state.pk], since: Math.floor(Date.now() / 1000) - GOSSIP_SINCE },
      { onevent: onInviteEvent }
    );

    // Ensure local edges for friends (drives the reachable view + hop budget).
    for (const f of state.friends) {
      if (f === state.npub) continue; // never declare trust toward ourselves
      await storeEdge(state.npub, f, state.maxHops);
    }

    state.acceptedInvites = (await settings.get('acceptedInvites')) || [];
    state.p2p = new P2PImpl(state.skHex, {
      onConnect: (npub) => {
        // If we accepted an invite from this peer, tell them now that we're
        // connected so they can finalize their side too.
        if (state.acceptedInvites.includes(npub)) {
          state.acceptedInvites = state.acceptedInvites.filter(n => n !== npub);
          settings.set('acceptedInvites', state.acceptedInvites);
          sendSafe(npub, { type: 'invite_accept' });
        }
        // Push our profile + routing filter + trust web, then sync docs.
        publishProfile();
        sendFilter();
        sendTrustDeclarations();
        sendSafe(npub, { type: 'backfill_request', since: 0 });
      },
      onDisconnect: () => {},
      onMessage: handlePeerMessage,
      peers: new Set(state.friends),
      allowSelf: state.syncDevices
    });
    for (const f of state.friends) {
      try { state.p2p.connect(f); } catch { /* skip bad npub */ }
    }
    // Anyone we invited (pending or accepted) is known to us — accept their
    // inbound handshake so the connection can establish without relays.
    const allInvites = await getDB().then(db => db.getAll('invites'));
    for (const inv of allInvites) {
      if (inv.dir === 'out' && inv.npub !== state.npub) {
        try { state.p2p.addPeer(inv.npub); } catch { /* skip bad npub */ }
      }
    }
    // Multi-device sync: link to other devices sharing our identity key.
    if (state.syncDevices) {
      state.p2p.addPeer(state.npub);
      state.p2p.connect(state.npub);
    }

    state.syncTimer = setInterval(() => syncNow(), FILTER_INTERVAL);
    state.backfillTimer = setInterval(() => {
      requestBackfills();
      reconcileOwnedDocs().catch(() => {});
    }, BACKFILL_INTERVAL);
    syncNow();
    reconcileOwnedDocs().catch(err => console.warn('[mesh] reconcile error', err));

    state.lastError = null;
    state.started = true;
    log(`mesh started as ${state.npub}`);
  } catch (err) {
    state.lastError = err?.message || String(err);
    log('mesh start failed:', state.lastError);
    throw err;
  } finally {
    state.starting = false;
  }
}

export function stopMesh() {
  if (!state) return;
  if (state.syncTimer) clearInterval(state.syncTimer);
  if (state.backfillTimer) clearInterval(state.backfillTimer);
  try { state.sub?.close(); } catch { /* ignore */ }
  try { state.p2p?.close(); } catch { /* ignore */ }
  try { state.pool?.close(RELAYS); } catch { /* ignore */ }
  state.started = false;
}

// Restart the mesh from scratch with the identity currently in settings.
async function rekey() {
  stopMesh();
  state = null;
  await startMesh();
}
export async function handleMeshRequest(request) {
  if (!state || !state.started) {
    try {
      await startMesh();
    } catch (err) {
      return { success: false, error: `Mesh failed to start: ${state?.lastError || err?.message}` };
    }
  }
  if (!state.started) return { success: false, error: `Mesh not running: ${state?.lastError || 'unknown'}` };
  if (!request || !request.op) return { success: false, error: 'Missing p2p op' };

  switch (request.op) {
    case 'status': {
      const graph = computeTrustGraph();
      let relays = {};
      try {
        for (const [url, ok] of state.pool.listConnectionStatus()) relays[url] = ok;
      } catch { /* no relay status available */ }
      return {
        success: true,
        status: {
          npub: state.npub,
          connected: [...state.p2p.connections.keys()],
          friends: state.friends,
          maxHops: state.maxHops,
          reachable: [...graph.keys()]
            .filter(n => n !== state.npub)
            .map(n => ({ npub: n, depth: graph.get(n).depth })),
          peerFilterCount: state.peerFilters.size,
          cachedDocs: await getDB().then(db => db.count('docCache')),
          relays
        }
      };
    }

    case 'addFriend': {
      const npub = String(request.npub || '').trim().toLowerCase();
      if (!/^npub1[0-9a-z]{58}$/.test(npub)) return { success: false, error: 'Invalid npub' };
      if (npub === state.npub) return { success: false, error: 'That is your own key' };
      await addTrusted(npub);
      return { success: true, friends: state.friends };
    }

    case 'removeFriend': {
      const npub = String(request.npub || '');
      state.friends = state.friends.filter(f => f !== npub);
      await settings.set('friends', state.friends);
      const list = state.edges.get(state.npub) || [];
      const i = list.findIndex(e => e.trusted === npub);
      if (i >= 0) list.splice(i, 1);
      const db = await getDB();
      await db.delete('trust', `${state.npub}|${npub}`);
      state.p2p.removePeer(npub);
      return { success: true, friends: state.friends };
    }

    case 'setMaxHops': {
      const n = Math.max(1, Math.min(MAX_HOPS_CAP, Math.floor(Number(request.maxHops)) || 2));
      state.maxHops = n;
      await settings.set('maxHops', n);
      return { success: true, maxHops: n };
    }

    case 'sendInvite': {
      const npub = String(request.npub || '').trim().toLowerCase();
      if (!/^npub1[0-9a-z]{58}$/.test(npub)) return { success: false, error: 'Invalid npub' };
      if (npub === state.npub) return { success: false, error: 'That is your own key' };
      if (state.friends.includes(npub)) return { success: false, error: 'Already friends' };
      const event = finalizeEvent({
        kind: INVITE_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['p', nip19.decode(npub).data]],
        content: JSON.stringify({ invitee: npub, message: String(request.message || '').slice(0, 140) })
      }, state.sk);
      await Promise.allSettled(state.pool.publish(RELAYS, event));
      // We accept their inbound handshake once they accept, so the connection
      // can establish without any other relay traffic.
      state.p2p.addPeer(npub);
      const db = await getDB();
      await db.put('invites', { id: `out|${npub}`, dir: 'out', npub, message: String(request.message || ''), ts: Date.now(), status: 'pending' });
      return { success: true };
    }

    case 'respondInvite': {
      const npub = String(request.npub || '');
      const db = await getDB();
      if (request.accept) {
        await addTrusted(npub);
        // Remember the acceptance so we can tell the inviter over the direct
        // connection once it establishes (they finalize on `invite_accept`).
        if (!state.acceptedInvites.includes(npub)) {
          state.acceptedInvites.push(npub);
          await settings.set('acceptedInvites', state.acceptedInvites);
        }
      }
      await db.delete('invites', `in|${npub}`);
      return { success: true, friends: state.friends };
    }

    case 'getPeerDocs': {
      const npub = String(request.npub || '');
      const db = await getDB();
      const docs = (await db.getAll('docCache'))
        .filter(c => c.authorNpub === npub)
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
        .slice(0, 500)
        .map(c => ({ url: c.url, title: c.title, description: c.description, timestamp: c.timestamp }));
      return { success: true, npub, docs };
    }

    case 'refreshCache': {
      // The local store changed under us (e.g. a delete) — rebuild the cached
      // terms and re-share the routing filter over direct connections.
      state.cacheDirty = true;
      await sendFilter();
      return { success: true };
    }

    case 'publishTombstone': {
      const url = String(request.url || '');
      if (!url) return { success: false, error: 'Missing url' };
      const ts = Math.floor(Date.now() / 1000);
      const sig = signTombstone(url, ts);
      // Send a signed delete to connected peers (they forward it onward), then
      // apply locally.
      for (const [npub] of state.p2p.connections) {
        sendSafe(npub, { type: 'tombstone', url, authorNpub: state.npub, ts, sig });
      }
      await applyTombstone(state.npub, url, ts);
      state.cacheDirty = true;
      await sendFilter();
      return { success: true };
    }

    case 'reconcileDocs': {
      const lost = await reconcileOwnedDocs();
      return { success: true, lost };
    }

    case 'search': {
      const res = await searchNetwork(request.query, {
        limit: request.limit || 20,
        offset: request.offset || 0,
        timeout: request.timeout,
        queryId: request.queryId
      });
      return {
        success: true,
        results: res.results,
        total: res.results.total || 0,
        queriedPeers: res.queriedPeers,
        answeredPeers: res.answeredPeers,
        queryId: res.queryId
      };
    }

    case 'setProfile': {
      const profile = {
        name: String(request.name || '').slice(0, 40),
        avatar: String(request.avatar || '').slice(0, 4),
        bio: String(request.bio || '').slice(0, 200),
        ts: Math.floor(Date.now() / 1000)
      };
      await settings.set('profile', profile);
      await publishProfile();
      return { success: true, profile };
    }

    case 'setIdentity': {
      const nsec = String(request.nsec || '').trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(nsec)) return { success: false, error: 'Invalid nsec (must be 64 hex characters)' };
      const sameKey = nsec === (await settings.get('nostrSecretKey'));
      await settings.set('nostrSecretKey', nsec);
      await settings.set('syncDevices', true);
      if (sameKey) {
        state.syncDevices = true;
        state.p2p.addPeer(state.npub);
        state.p2p.connect(state.npub);
      } else {
        await rekey();
      }
      return { success: true, npub: state.npub, syncDevices: true };
    }

    case 'setSyncDevices': {
      const on = !!request.enabled;
      await settings.set('syncDevices', on);
      state.syncDevices = on;
      if (on) {
        state.p2p.addPeer(state.npub);
        state.p2p.connect(state.npub);
      } else {
        state.p2p.removePeer(state.npub);
      }
      return { success: true, enabled: on };
    }

    case 'getIdentity':
      return { success: true, npub: state.npub, nsec: state.skHex };

    case 'getPeers': {
      const graph = computeTrustGraph();
      const db = await getDB();
      const profilesRows = await db.getAll('profiles');
      const profiles = {};
      for (const p of profilesRows) profiles[p.npub] = { name: p.name, avatar: p.avatar, bio: p.bio };

      // What have peers recently indexed? From our docCache (what we've cached
      // of theirs), newest first, a few per author.
      const recentByPeer = {};
      const cached = await db.getAll('docCache');
      cached.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      for (const c of cached) {
        if (!recentByPeer[c.authorNpub]) recentByPeer[c.authorNpub] = [];
        if (recentByPeer[c.authorNpub].length < 10) {
          recentByPeer[c.authorNpub].push({
            url: c.url, title: c.title, description: c.description, timestamp: c.timestamp
          });
        }
      }
      return {
        success: true,
        peers: {
          npub: state.npub,
          ownProfile: (await settings.get('profile')) || {},
          syncDevices: state.syncDevices,
          friends: state.friends,
          connected: [...state.p2p.connections.keys()],
          reachable: [...graph.keys()].filter(n => n !== state.npub).map(n => ({ npub: n, depth: graph.get(n).depth })),
          cachedDocs: await db.count('docCache'),
          profiles,
          invites: (await db.getAll('invites')).sort((a, b) => b.ts - a.ts),
          recentByPeer
        }
      };
    }

    default:
      return { success: false, error: `Unknown p2p op: ${request.op}` };
  }
}
