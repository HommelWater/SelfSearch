# SelfSearch

A browser extension that turns your browsing history into a personal, searchable
index — and lets a trusted group of people search across each other's indexes,
peer-to-peer, **with no server**.

Every node is a full search engine: it captures pages you visit, extracts
title/keywords/description **locally on your device** (no cloud, no API keys),
stores them locally, and lets you search them. Peer nodes connect over a WebRTC
mesh (signaling via Nostr relays) and route queries using bloom filters over a
hop-limited web of trust.

> **Status:** local engine (capture → index → search) works; P2P mesh (nostr
> identity, friends, trust web, data-channel gossip) works; **peer search**
> (bloom-filter query routing over the mesh, with streaming results) works;
> **redundancy (`docCache`)** works — peers' docs are cached on-demand and
> backfilled from friends, served in queries, and covered by the routing filter.
> **Profiles and a peers feed** let you see who your peers are and what they've
> recently indexed. See [DESIGN.md](DESIGN.md) for the full architecture.

## Install

Load the extension unpacked:

- **Chrome:** `chrome://extensions` → enable *Developer mode* → *Load unpacked* → select this folder.
- **Firefox:** `about:debugging` → *This Firefox* → *Load Temporary Add-on* → select `manifest.json`.

## Quick start

1. **Index a page.** Open a page you want to search later and **click the
   extension icon** — the current page is indexed in one click. Keywords, a
   title, and a description are extracted locally from the page's own text.
2. **Search.** Type `ss <query>` in the address bar (omnibox), press
   `Alt+Shift+S`, or open the search page from the icon's context menu. The
   search page also holds **Peers** (your ID, friends, and what peers have
   recently indexed) and **Profile** (your name/avatar/bio, shared with peers).
3. **Add a friend.** Open the search page → *Peers*, paste their npub. Your
   nodes connect over a WebRTC mesh and build redundancy by caching each
   other's pages.

The extension stores everything in IndexedDB on your machine. Only text
metadata is ever shared, and only with peers you add.

## Development

No build step and no package manager. The extension is plain ES modules, and
the tests use Node's built-in runner (the fake IndexedDB they need is vendored
in `test/vendor/`, so there are no dependencies to install).

Tests (requires only Node.js):

    node test/run.mjs

## Repository layout

| Path | Purpose |
|------|---------|
| `core/` | Engine: `bloom.js` (routing filter), `tokenize.js`, `db.js` (IndexedDB), `extract.js` (local DOM extraction), `capture.js`, `search.js`, `mesh.js` (p2p host: keys, trust graph, gossip) |
| `lib/` | Vendored p2p libraries: `nostr-p2p.js` (WebRTC mesh), `nostr-deps.js`, `idb.js` |
| `test/` | Tests (Node's built-in runner) + vendored `fake-indexeddb` |

## License

See [LICENSE](LICENSE).
