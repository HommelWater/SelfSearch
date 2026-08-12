import { NostrP2P } from '../lib/nostr-p2p.js';
import {
  SimplePool, finalizeEvent, generateSecretKey, getPublicKey, nip19,
  schnorr, sha256, bytesToHex, hexToBytes
} from '../lib/nostr-deps.js';
import { settings, getDB } from './db.js';
import { search as localSearch, allIndexedTerms, saveDoc, docHash } from './search.js';
import { tokenize } from './tokenize.js';
import { BloomFilter } from './bloom.js';

const TRUST_KIND = 25010;   // trust declaration: { truster, trusted, maxHops }
const FILTER_KIND = 25011;  // routing bloom filter gossip: { bloom, termCount, seq }
const PROFILE_KIND = 25012; // peer profile: { name, avatar, bio }
const INVITE_KIND = 25013;  // friend invite: { invitee, message }
const ACCEPT_KIND = 25014;  // invite accept: { inviter, invitee }
const TOMBSTONE_KIND = 25016; // signed delete: { url, author }
const TOMBSTONE_CAP = 5000;
const REPAIR_TIMEOUT = 30 * 1000; // re-request a lost doc after this long
const FILTER_INTERVAL = 30 * 1000;
const GOSSIP_SINCE = 3600;  // seconds of past gossip to replay on subscribe
const MAX_HOPS_CAP = 5;
const QUERY_TIMEOUT = 2500; // hard cap to collect peer answers before returning
const GRACE_MS = 500;       // extra window for 2-hop answers after all direct peers respond
const SEEN_TTL = 20 * 1000; // keep query dedup/relay state this long

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

async function handleTombstoneEvent(e) {
  try {
    const { url, author } = JSON.parse(e.content);
    const authorNpub = nip19.npubEncode(e.pubkey);
    if (!url || (author && author !== authorNpub)) return;
    if (!verifyEvent(e)) return;
    await applyTombstone(authorNpub, url, e.created_at);
    log(`tombstone ${url} by ${authorNpub.slice(0, 12)}`);
  } catch { /* ignore malformed */ }
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

async function publishTrust(trusted, maxHops) {
  const event = finalizeEvent({
    kind: TRUST_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: JSON.stringify({ truster: state.npub, trusted, maxHops })
  }, state.sk);
  await Promise.allSettled(state.pool.publish(RELAYS, event));
}

// Gossip our profile so peers know who we are (self-signed, like the rest).
async function publishProfile() {
  if (!state) return;
  const profile = (await settings.get('profile')) || {};
  if (!profile.name && !profile.avatar && !profile.bio) return;
  const event = finalizeEvent({
    kind: PROFILE_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: JSON.stringify({ name: profile.name || '', avatar: profile.avatar || '', bio: profile.bio || '' })
  }, state.sk);
  await Promise.allSettled(state.pool.publish(RELAYS, event));
}

async function storePeerProfile(npub, profile, ts) {
  const db = await getDB();
  await db.put('profiles', { npub, name: profile.name || '', avatar: profile.avatar || '', bio: profile.bio || '', ts });
}

// Add someone to our trust web (friend + edge + connect). Used by direct add,
// invite acceptance, and receiving an invite accept.
async function addTrusted(npub) {
  if (!state.friends.includes(npub)) {
    state.friends.push(npub);
    await settings.set('friends', state.friends);
  }
  await storeEdge(state.npub, npub, state.maxHops);
  await publishTrust(npub, state.maxHops);
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

// An invite accept arrives via relays: the invitee accepted OUR invite, so add
// them (we already wanted the connection).
async function handleAcceptEvent(e) {
  try {
    const { inviter, invitee } = JSON.parse(e.content);
    const accepter = nip19.npubEncode(e.pubkey);
    if (inviter !== state.npub || invitee !== accepter) return;
    if (!verifyEvent(e)) return;
    await addTrusted(accepter);
    const db = await getDB();
    await db.delete('invites', `out|${accepter}`);
    log(`invite accepted by ${accepter.slice(0, 12)}`);
  } catch { /* ignore malformed */ }
}

async function publishFilter() {
  if (!state) return;
  await refreshCachedTerms();
  const terms = await allIndexedTerms();
  for (const t of state.cachedTerms) terms.push(t);
  const bloom = BloomFilter.create(Math.max(1024, terms.length));
  bloom.addAll(terms);
  state.filterSeq++;
  const event = finalizeEvent({
    kind: FILTER_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: JSON.stringify({ bloom: bloom.toJSON(), termCount: terms.length, seq: state.filterSeq })
  }, state.sk);
  await Promise.allSettled(state.pool.publish(RELAYS, event));
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
    const terms = new Set([
      ...tokenize(d.title || ''),
      ...tokenize(d.description || ''),
      ...tokenize(d.direct_keywords || ''),
      ...tokenize(d.related_keywords || '')
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

function onGossipEvent(e) {
  if (e.kind === TRUST_KIND) {
    try {
      const { truster, trusted, maxHops } = JSON.parse(e.content);
      if (!truster || !trusted || !Number.isFinite(maxHops)) return;
      if (e.pubkey !== truster) return; // must be self-signed
      if (!verifyEvent(e)) return;
      storeEdge(truster, trusted, Math.max(0, Math.min(maxHops, MAX_HOPS_CAP)));
      log(`trust ${truster.slice(0, 12)} -> ${trusted.slice(0, 12)} (${maxHops})`);
    } catch { /* ignore malformed */ }
  } else if (e.kind === FILTER_KIND) {
    try {
      const { bloom, termCount, seq } = JSON.parse(e.content);
      if (!bloom || !Number.isFinite(termCount) || !Number.isFinite(seq)) return;
      state.peerFilters.set(e.pubkey, { bloom, termCount, seq, ts: Date.now() });
      state.peerFilterObjs.set(e.pubkey, BloomFilter.fromJSON(bloom));
    } catch { /* ignore malformed */ }
  } else if (e.kind === PROFILE_KIND) {
    try {
      const profile = JSON.parse(e.content);
      if (!profile || typeof profile !== 'object') return;
      if (!verifyEvent(e)) return;
      storePeerProfile(e.pubkey, profile, e.created_at);
    } catch { /* ignore malformed */ }
  } else if (e.kind === INVITE_KIND) {
    handleInviteEvent(e).catch(() => {});
  } else if (e.kind === ACCEPT_KIND) {
    handleAcceptEvent(e).catch(() => {});
  } else if (e.kind === TOMBSTONE_KIND) {
    handleTombstoneEvent(e).catch(() => {});
  }
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
    const results = rankResults(pending.results).slice(0, pending.limit);
    api.runtime.sendMessage({
      type: 'search_partial',
      queryId,
      results,
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

  const terms = tokenize(query);

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
  if (results.length) cachePeerDocs(results).catch(err => console.warn('[mesh] cache answers failed', err));
  const pending = state.pendingQueries.get(queryId);
  if (pending) {
    // We originated this query — aggregate the answers.
    for (const r of results) {
      if (!r || !r.url) continue;
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

// We asked a friend to backfill — store what they sent.
function handleBackfill(sender, msg) {
  if (!Array.isArray(msg.docs)) return;
  cachePeerDocs(msg.docs.map(d => ({ ...d, authorNpub: sender })))
    .then(() => {
      let maxTs = 0;
      for (const d of msg.docs) if (d.timestamp > maxTs) maxTs = d.timestamp;
      if (maxTs) state.lastBackfillBy.set(sender, maxTs);
    })
    .catch(err => console.warn('[mesh] cache backfill failed', err));
}

// Proactive sync for direct friends (distance 1): request their docs, sending
// a `since` so only newer content comes back.
function requestBackfills() {
  for (const [npub] of state.p2p.connections) {
    sendSafe(npub, { type: 'backfill_request', since: state.lastBackfillBy.get(npub) || 0 });
  }
}

function handlePeerMessage(npub, msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'query') {
    handleQuery(npub, msg).catch(err => console.warn('[mesh] handleQuery error', err));
  } else if (msg.type === 'query_answer') {
    handleAnswer(npub, msg);
  } else if (msg.type === 'backfill_request') {
    handleBackfillRequest(npub, msg).catch(err => console.warn('[mesh] backfill request error', err));
  } else if (msg.type === 'backfill') {
    handleBackfill(npub, msg);
  } else if (msg.type === 'tombstone') {
    // Data-channel tombstone: the sender is the author, so it only affects
    // cached docs attributed to them.
    applyTombstone(npub, msg.url, Math.floor(Date.now() / 1000)).catch(() => {});
  } else if (msg.type === 'doc_request') {
    handleDocRequest(npub, msg).catch(() => {});
  } else if (msg.type === 'doc_response') {
    handleDocResponse(npub, msg).catch(err => console.warn('[mesh] repair error', err));
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
}

// Search our own index and, in parallel, fan the query out to connected
// trusted peers whose bloom filters match. Streams partial result sets as
// answers arrive, then broadcasts a final "done" update. Returns the merged
// (deduped by URL, ranked) results at the end.
async function searchNetwork(query, { limit = 20, timeout = QUERY_TIMEOUT, queryId } = {}) {
  const terms = tokenize(query);
  const results = new Map();

  // Local results.
  const local = terms.length ? await localSearch(query, { limit }) : [];
  for (const d of local) results.set(d.url, { ...toWireDoc(d), authorNpub: state.npub, source: 'local' });

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
      results, answered: new Set(), targets, limit,
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
    return {
      results: rankResults(results).slice(0, limit),
      queriedPeers: targets.length,
      answeredPeers: pending.answered.size,
      queryId: qid
    };
  }

  // No peers queried: stream a single "done" update so the page stops waiting.
  broadcastSearchUpdate(qid, { results, targets, limit, answered: new Set() }, true);
  return { results: rankResults(results).slice(0, limit), queriedPeers: 0, answeredPeers: 0, queryId: qid };
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

// Keep the network warm: re-gossip our routing filter and re-publish our trust
// declarations so late-joining peers (and peers that missed earlier gossip)
// can still learn who we trust.
function syncNow() {
  if (!state || !state.started) return;
  publishFilter();
  publishProfile();
  for (const f of state.friends) publishTrust(f, state.maxHops);
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
  state = state || {
    friends: [], maxHops: 2, edges: new Map(),
    peerFilters: new Map(), peerFilterObjs: new Map(), filterSeq: 0,
    pendingQueries: new Map(), pendingRelay: new Map(), seenQueries: new Map(),
    lastBackfillBy: new Map(), cachedTerms: new Set(), cacheDirty: true,
    repairing: new Map(),
    started: false, starting: false, lastError: null
  };
  state.starting = true;
  try {
    await ensureKeys();
    state.friends = (await settings.get('friends')) || [];
    state.maxHops = Number(await settings.get('maxHops')) || 2;
    await loadEdges();

    state.pool = new SimplePool({
      enableReconnect: true,
      onRelayConnectionFailure: (url) => log(`relay unreachable: ${url}`)
    });
    state.sub = state.pool.subscribeMany(
      RELAYS,
      { kinds: [TRUST_KIND, FILTER_KIND, PROFILE_KIND, INVITE_KIND, ACCEPT_KIND, TOMBSTONE_KIND], since: Math.floor(Date.now() / 1000) - GOSSIP_SINCE },
      { onevent: onGossipEvent }
    );

    // (Re)publish our own declarations + ensure local edges for friends.
    for (const f of state.friends) {
      await storeEdge(state.npub, f, state.maxHops);
      await publishTrust(f, state.maxHops);
    }

    state.p2p = new NostrP2P(state.skHex, {
      onConnect: (npub) => {
        publishFilter();
        // Proactive redundancy for direct friends as soon as they connect.
        sendSafe(npub, { type: 'backfill_request', since: 0 });
      },
      onDisconnect: () => {},
      onMessage: handlePeerMessage,
      peers: new Set(state.friends)
    });
    for (const f of state.friends) {
      try { state.p2p.connect(f); } catch { /* skip bad npub */ }
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
      await publishTrust(npub, 0); // tombstone
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
      const db = await getDB();
      await db.put('invites', { id: `out|${npub}`, dir: 'out', npub, message: String(request.message || ''), ts: Date.now(), status: 'pending' });
      return { success: true };
    }

    case 'respondInvite': {
      const npub = String(request.npub || '');
      const db = await getDB();
      if (request.accept) {
        await addTrusted(npub);
        const event = finalizeEvent({
          kind: ACCEPT_KIND,
          created_at: Math.floor(Date.now() / 1000),
          tags: [['p', nip19.decode(npub).data]],
          content: JSON.stringify({ inviter: npub, invitee: state.npub })
        }, state.sk);
        await Promise.allSettled(state.pool.publish(RELAYS, event));
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
      // terms and re-gossip the routing filter.
      state.cacheDirty = true;
      await publishFilter();
      return { success: true };
    }

    case 'publishTombstone': {
      const url = String(request.url || '');
      if (!url) return { success: false, error: 'Missing url' };
      const ts = Math.floor(Date.now() / 1000);
      const event = finalizeEvent({
        kind: TOMBSTONE_KIND,
        created_at: ts,
        tags: [],
        content: JSON.stringify({ url, author: state.npub })
      }, state.sk);
      await Promise.allSettled(state.pool.publish(RELAYS, event));
      // Fast path to connected friends, then apply locally.
      for (const [npub] of state.p2p.connections) sendSafe(npub, { type: 'tombstone', url });
      await applyTombstone(state.npub, url, ts);
      state.cacheDirty = true;
      await publishFilter();
      return { success: true };
    }

    case 'reconcileDocs': {
      const lost = await reconcileOwnedDocs();
      return { success: true, lost };
    }

    case 'search': {
      const res = await searchNetwork(request.query, {
        limit: request.limit || 20,
        timeout: request.timeout,
        queryId: request.queryId
      });
      return { success: true, results: res.results, queriedPeers: res.queriedPeers, answeredPeers: res.answeredPeers, queryId: res.queryId };
    }

    case 'setProfile': {
      const profile = {
        name: String(request.name || '').slice(0, 40),
        avatar: String(request.avatar || '').slice(0, 4),
        bio: String(request.bio || '').slice(0, 200)
      };
      await settings.set('profile', profile);
      await publishProfile();
      return { success: true, profile };
    }

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
