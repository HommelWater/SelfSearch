# SelfSearch P2P — Design

A browser add-on that turns your browsing history into a personal, searchable
index — and lets a trusted group of people search across each other's indexes,
with **no central server**.

The old design had an extension screenshot pages and ship them to a self-hosted
server (Tantivy index, Gemini extraction). The new design runs the whole
pipeline in the browser and replaces the server with a WebRTC peer-to-peer mesh
over Nostr relays. Extraction is fully local.

## Goals

- Serverless: no backend, no self-hosting, no accounts.
- Each node is a full search engine (capture → extract → index → search).
- Search across a **web of trust**: your friends, and their friends, up to a
  configurable hop limit.
- Redundant: text-only docs are tiny, so nodes cache large amounts of peers'
  data to survive peers going offline.
- Privacy-preserving: sharing is opt-in, text metadata only, everything signed.

## Non-goals

- No image/screenshot sharing between peers (captures stay on the capturing node).
- No open/public network by default (trust web only).
- No streaming or real-time updates of the index.

## Stack

- Manifest V3 extension (Firefox + Chrome).
- `lib/nostr-p2p.js` — WebRTC data-channel mesh, signaling over Nostr relays,
  schnorr signing of every message (already in repo).
- `lib/nostr-deps.js` — bundled nostr-tools + noble crypto (already in repo).
- `lib/idb.js` — IndexedDB promise wrapper (already in repo).
- **Local extraction** — weighted term-frequency keyword extraction over page
  DOM text, plus optional user keywords.

## Architecture overview

```
                    ┌─────────────────────────────────────────┐
                    │             Node (a browser)            │
                    │                                         │
   page visit ──►   │  capture ──► local extract ──► docs ──► inverted│
                    │                            index        │
                    │                               │         │
                    │                          filter_self     │
                    │                          (bloom: my docs │
                    │                           ∪ docCache)    │
                    │                               │          │
                    │                          gossip/route    │
                    │                               │          │
                    │   queryCache ◄── search ──► query ───────┼──┐
                    │                                         │  │ WebRTC mesh
                    └─────────────────────────────────────────┘  │ (Nostr relays
                                                                    for signaling)
                    ┌─────────────────────────────────────────┐  │
                    │            Peer node (browser)          │◄─┘
                    │  same pipeline, own keypair, own cache  │
                    └─────────────────────────────────────────┘
```

## Identity & transport

- Identity is a **nostr keypair**. `npub` is the peer address; the secret key
  lives in extension storage (settings page).
- Signaling runs over the relays configured in `nostr-p2p.js` (defaults, or
  self-hosted via `nostr_p2p_relays` in localStorage).
- Data flows over WebRTC data channels, capped at ~12 live connections per node
  (`maxConnections`). Every application message is signed (schnorr) and carries
  the sender's npub; receivers verify before processing.
- **Persistent context requirement (MV3):** service workers get killed, and the
  WebRTC mesh must stay alive. The mesh runs in an **offscreen document**
  (Chrome) / persistent background page (Firefox), with the popup and content
  scripts talking to it via `runtime.sendMessage`.

## Trust model (web of trust)

Trust is transitive, hop-limited.

- A user explicitly **adds a friend** by npub. Adding a friend publishes a
  signed **trust declaration** (a nostr event, kind e.g. `25010`):
  `{ signer: npubA, trusts: npubB, maxHops: N }`.
- Trust declarations are gossiped through the mesh (they're small and signed).
- Every node builds a local **trust graph** from the declarations it has seen
  (only accepting declarations signed by nodes it already trusts). BFS from your
  own key computes **trust distance**: a node at depth ≤ `maxHops` (default 2)
  is queryable.
- `maxHops` per trust declaration lets a friend cap how far *their* network
  extends through them.

## Data model (IndexedDB)

| Store      | Key                | Content |
|------------|--------------------|---------|
| `docs`     | `url`              | Your own indexed pages: `{url, title, description, direct_keywords, related_keywords, timestamp}` + `image_hash` (image stays local) |
| `docCache` | `(authorNpub, url)` | Copies of peers' docs: same fields + `authorNpub` + `signature` + `timestamp` (author's) + `addedAt` |
| `queryCache` | normalized query | `{query, results, answeredBy[], ts}` — rolling LRU |
| `index`    | term → `[url...]`  | Inverted index over `docs` (and optionally `docCache`) for local search |
| `settings` | key                | nostr secret key, friends, `maxHops`, cache caps |

Screenshots/images are **never** shared; they live only under the capturing
node's own storage.

## Bloom filters (routing)

- Each node maintains `filter_self`: a bloom filter over the terms in
  **`docs` ∪ `docCache`** — everything it can serve.
- Filters are **gossiped** periodically (broadcast on connect, then on a
  maintenance interval and on significant local index growth).
- Filter updates are signed and carry a sequence number so stale ones are
  ignored.
- A bloom filter has no false negatives for its own set, only false positives —
  routing to a superset is safe. To counter stale/partial filters, queries also
  do a bounded flood (see below).

Why a bloom filter and not a DHT: at personal/trusted-group scale (tens of
nodes), gossiped filters are simpler, have no churn/replication logic, and reuse
the mesh that already exists for transport. To scale *past* a couple of hops
without flooding, filters grow into per-friend **aggregate filters** for guided
routing — see [Scaling beyond two hops](#scaling-beyond-two-hops).

## Message protocol (over the data channel, all signed)

| Type                 | Payload |
|----------------------|---------|
| `trust_declaration`  | `{ truster, trusted, maxHops, sig }` — gossiped |
| `filter`             | `{ bloom, seq, termCount }` — gossiped, who can serve what |
| `aggregate_filter`   | `{ friend, bloom, horizon, seq }` — gossiped, subtree summaries for routing (kind `25015`) |
| `profile`            | `{ name, avatar, bio }` — gossiped (relay kind `25012`), self-signed |
| `query`              | `{ queryId, terms[], hops, budget, origin, path[] }` — forwardable |
| `query_answer`       | `{ queryId, results: [{url, title, description, keywords, timestamp, authorNpub, sig}] }` |
| `backfill_request`   | `{ friendNpub, since }` — proactive sync, friends only |
| `backfill`           | `{ docs: [...] }` — full doc set, friends only |

## Query flow (search)

1. Normalize query → **check `queryCache`** first. Hit → return immediately
   (offline / repeat searches are instant).
2. Split into terms. Compute the set of trusted peers (distance ≤ `maxHops`,
   deduped, never queried twice per queryId) whose `filter_self` matches any
   term.
3. Send `query` to that set with `hops = maxHops - 1` and `path = [myNpub]`.
4. Each recipient:
   - Runs the query against its **local** inverted index (`docs` ∪ `docCache`).
   - If `hops > 0`, forwards to its own trusted peers not already in `path`,
     whose filters match, with `hops - 1` and `path + [recipient]`.
5. Answers flow back to the origin, **deduped by URL across authors**, merged,
   ranked (score, recency), attributed by `authorNpub` (not the serving node).
6. Origin stores results into `docCache` (with author signature) and
   `queryCache`, then renders.

## Redundancy (caching)

Text-only docs are ~1–2 KB, so each node can hold tens of thousands of peers'
docs comfortably.

- **`docCache` — hybrid population:**
  - *On-demand:* every query answer fills the cache (whole mesh).
  - *Proactive:* direct friends (distance 1) exchange `backfill_request` /
    `backfill` on connect and on idle, so close peers are fully redundant.
  - Peers at distance ≥ 2 are only cached on-demand (bandwidth + privacy).
- **Eviction:** LRU, capped by count (default ~100k docs) and/or MB
  (configurable). `addedAt` orders eviction; author `timestamp` handles
  staleness (newest wins on URL collision).
- **Serving from cache:** a node's `filter_self` covers its `docCache`, so a
  query routed to a cached author's neighborhood can be answered by a different
  node entirely — a peer going offline doesn't lose its content from search.
- **`queryCache`:** LRU keyed by normalized query, fixed max size (e.g. 200
  entries). Provides offline search and fast repeats.
- **Verification:** cached docs keep the author's signature; serve-time
  verification catches tampered cache entries.

## Scaling beyond two hops

The hop limit (`maxHops = 2`) is what keeps the query flood bounded today. A
web of trust is a **small-world graph** — paths between members are short — so
the network's diameter is not the obstacle. The obstacles are *fan-out* and
*reach*, and the fixes are **aggregate bloom filters** (routing instead of
flooding) and **replication** (content comes to you instead of you travelling to
it).

### Aggregate bloom filters (guided routing)

Today `filter_self` is a neighbor-level hint: "which of my direct friends might
have term X?" For a deeper search it must become a routing table: "which friend
is on a path to someone who has X?"

- Each node gossips an **aggregate filter** per trusted friend: the union of
  that friend's `filter_self` and the aggregates of the friend's trusted
  network, up to an aggregation horizon (default ~3 hops of summaries).
- Routing becomes **greedy descent**: at each hop, forward the query only to
  the friends whose aggregate contains a term (usually a single best path),
  instead of to every filter-matching friend. Per-hop fan-out stops growing
  exponentially with depth.
- Because aggregates summarise whole subtrees, a query can reach content 4–5+
  edges away while each hop makes one onward decision.
- This is the approach Gnutella's Query Routing Protocol used to scale to
  millions of nodes; the mesh + relay gossip substrate needed here already
  exists.

Bloom false positives may send a query down a dead end, so routing keeps a
small **backtrack budget** (a bounded number of alternative paths) on top of
the global budget below.

### Replication: the content horizon

Routing is only half the answer. The other half is that **content should be
near you, not a journey away.**

- `docCache` (see Redundancy) means a node answers from its own docs **plus
  everything it has cached**, and `filter_self` / aggregates include cached
  content.
- Every query answer already fills the cache, and friends backfill each other,
  so content **replicates toward demand**: pages people search for become
  available 1–2 hops from everyone who asked.
- The effective search radius becomes the **content horizon**, not the hop
  count. A substantial network becomes searchable with a modest hop limit
  because the answers live close by.

### Bounded search budget

Depth must not become an unbounded cost. Add a per-query **budget** (max nodes
visited / answers relayed) carried in the query and decremented at each node,
alongside the hop counter. Nodes refuse to forward once the budget is
exhausted. This caps worst-case load on every node regardless of `maxHops`,
so the hop limit can be raised (e.g., to 5–6, matching the trust web's
diameter) without overloading anyone.

### What this changes

- **Protocol:** gossip an `aggregate_filter` (relay kind `25015`) alongside
  `filter_self`; queries carry a `budget` field in addition to `hops`.
- **Trust stays the boundary:** aggregates are computed only from trusted
  peers' declarations, and forwarding only ever follows trusted edges.

### Costs (honest)

- Aggregate filters are unions of many nodes' content → larger filters and more
  false positives. Sized by covered term count (as today); mitigated by the
  small backtrack budget.
- Aggregates and replication consume bandwidth (gossip + backfill) and storage
  (bounded by the `docCache` cap). Both are bounded.
- Aggregates leak "roughly what this subtree contains" — acceptable inside a
  trust web, a privacy concern for an open network.


## Capture pipeline (local extraction)

1. On "Index this page", read the page's DOM text via a content-script injection
   (title, meta description/keywords, body text).
2. **Extract locally**: weighted term-frequency keyword extraction over the page
   text (title 3x, meta keywords 2x, body 1x) → `{title, description,
   direct_keywords, related_keywords}`. No cloud, no API keys.
3. User-entered keywords (from the popup) are merged in.
4. Store `{url, title, description, direct_keywords, related_keywords,
   timestamp}` in `docs`; image stored locally (not shared).
5. Update inverted index + rebuild/re-gossip `filter_self`.

## Security & privacy

- All app messages signed + verified; unknown/untrusted senders are dropped.
- Trust graph is only extended by declarations signed by already-trusted nodes.
- Peers-of-peers contribute **read-only**: they can serve cached content, never
  write to your `docs`.
- Text metadata only — no images, no full browsing raw data beyond the
  extracted fields.
- Secret keys stay in the user's extension storage.
- Result attribution keeps the web-of-trust accountable (per-node rate/penalty
  is a future feature).

## MV3 / portability notes

- Mesh runs in a persistent context (offscreen doc on Chrome, background page on
  Firefox). The existing manifest's Firefox-style `background.scripts` is
  already the right shape.
- `lib/` files are ES modules; import them into the background/offscreen entry.

## Build plan

1. **Local engine** — capture → local extraction → `docs`; inverted index; local
   search; bloom filter builder over own docs; `queryCache`.
2. **Mesh plumbing** — persistent p2p context; keypair + settings UI; add/remove
   friends; trust declarations + gossip; trust-graph computation.
3. **Routing** — gossip `filter_self` (docs ∪ docCache); `query` broadcast with
   hop counter + path dedupe; forwarding; answer merge/dedupe/rank/attribute.
4. **Redundancy layer** — `docCache` (hybrid population, LRU eviction),
   proactive `backfill` for friends, served-by-cache fallback, filter covers
   cache. Done.
5. **Polish** — cross-author URL dedupe, per-node result attribution, offline
   search via caches, privacy/bandwidth settings, README + store listing.
6. **Scale** — aggregate bloom filters (gossip kind `25015`, per-friend subtree
   summaries) for greedy guided routing; per-query `budget`; raise `maxHops` to
   5–6 with the budget capping worst-case load. (Design above.)

## Open questions / future work

- Per-node rate limiting / penalty scoring for bad actors.
- Compression/delta updates for `filter_self` and `aggregate_filter` gossip.
- Backtrack routing beyond one parallel path when greedy descent dead-ends.
