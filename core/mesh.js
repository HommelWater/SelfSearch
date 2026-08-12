import { NostrP2P } from '../lib/nostr-p2p.js';
import {
  SimplePool, finalizeEvent, generateSecretKey, getPublicKey, nip19,
  schnorr, sha256, bytesToHex, hexToBytes
} from '../lib/nostr-deps.js';
import { settings, getDB } from './db.js';
import { search as localSearch, allIndexedTerms } from './search.js';
import { tokenize } from './tokenize.js';
import { BloomFilter } from './bloom.js';

const TRUST_KIND = 25010;   // trust declaration: { truster, trusted, maxHops }
const FILTER_KIND = 25011;  // routing bloom filter gossip: { bloom, termCount, seq }
const FILTER_INTERVAL = 30 * 1000;
const GOSSIP_SINCE = 3600;  // seconds of past gossip to replay on subscribe
const MAX_HOPS_CAP = 5;
const QUERY_TIMEOUT = 2500; // hard cap to collect peer answers before returning
const GRACE_MS = 500;       // extra window for 2-hop answers after all direct peers respond
const SEEN_TTL = 20 * 1000; // keep query dedup/relay state this long

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

async function publishTrust(trusted, maxHops) {
  const event = finalizeEvent({
    kind: TRUST_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: JSON.stringify({ truster: state.npub, trusted, maxHops })
  }, state.sk);
  await Promise.allSettled(state.pool.publish(RELAYS, event));
}

async function publishFilter() {
  if (!state) return;
  const terms = await allIndexedTerms();
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
  // waiting instead of sitting out the full collection window.
  const local = terms.length ? await localSearch(query, { limit: msg.limit || 10 }) : [];
  sendSafe(sender, {
    type: 'query_answer',
    queryId,
    results: local.map(d => ({ ...toWireDoc(d), authorNpub: state.npub }))
  });

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

function handlePeerMessage(npub, msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'query') {
    handleQuery(npub, msg).catch(err => console.warn('[mesh] handleQuery error', err));
  } else if (msg.type === 'query_answer') {
    handleAnswer(npub, msg);
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
      { kinds: [TRUST_KIND, FILTER_KIND], since: Math.floor(Date.now() / 1000) - GOSSIP_SINCE },
      { onevent: onGossipEvent }
    );

    // (Re)publish our own declarations + ensure local edges for friends.
    for (const f of state.friends) {
      await storeEdge(state.npub, f, state.maxHops);
      await publishTrust(f, state.maxHops);
    }

    state.p2p = new NostrP2P(state.skHex, {
      onConnect: () => publishFilter(),
      onDisconnect: () => {},
      onMessage: handlePeerMessage,
      peers: new Set(state.friends)
    });
    for (const f of state.friends) {
      try { state.p2p.connect(f); } catch { /* skip bad npub */ }
    }

    state.syncTimer = setInterval(() => syncNow(), FILTER_INTERVAL);
    syncNow();

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
          relays
        }
      };
    }

    case 'addFriend': {
      const npub = String(request.npub || '').trim().toLowerCase();
      if (!/^npub1[0-9a-z]{58}$/.test(npub)) return { success: false, error: 'Invalid npub' };
      if (npub === state.npub) return { success: false, error: 'That is your own key' };
      if (!state.friends.includes(npub)) {
        state.friends.push(npub);
        await settings.set('friends', state.friends);
      }
      await storeEdge(state.npub, npub, state.maxHops);
      await publishTrust(npub, state.maxHops);
      state.p2p.addPeer(npub);
      state.p2p.connect(npub);
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

    case 'search': {
      const res = await searchNetwork(request.query, {
        limit: request.limit || 20,
        timeout: request.timeout,
        queryId: request.queryId
      });
      return { success: true, results: res.results, queriedPeers: res.queriedPeers, answeredPeers: res.answeredPeers, queryId: res.queryId };
    }

    default:
      return { success: false, error: `Unknown p2p op: ${request.op}` };
  }
}
