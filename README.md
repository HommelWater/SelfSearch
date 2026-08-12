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
> identity, friends, trust web, relay gossip) works; **peer search** (bloom-filter
> query routing over the mesh, with streaming results) works. Redundancy
> (`docCache`) is next. See [DESIGN.md](DESIGN.md) for the full architecture.

## Install

Load the extension unpacked:

- **Chrome:** `chrome://extensions` → enable *Developer mode* → *Load unpacked* → select this folder.
- **Firefox:** `about:debugging` → *This Firefox* → *Load Temporary Add-on* → select `manifest.json`.

## Quick start

1. **Index a page.** Open a page you want to search later, click the icon, then
   *Index this page*. The page's own text is analyzed locally to extract
   `{title, description, keywords, url, timestamp}`. Add optional keywords of
   your own in the popup before indexing.
2. **Auto-index (optional).** Tick *Auto-index pages I spend time on* in the
   popup — pages you keep open for a few seconds get indexed by URL + title
   automatically, with no manual clicks.
3. **Search.** Type `ss <query>` in the address bar (omnibox), or open the
   extension popup → *Open Search*. Results are ranked, tagged (local / peer),
   and shown with the page's stored timestamp. Empty query shows your
   recently-indexed pages.

The extension stores everything in IndexedDB on your machine. Screenshots are
kept locally and never shared.

## Development

    npm install   # pulls in fake-indexeddb for the tests

Tests:

    npm test

## Repository layout

| Path | Purpose |
|------|---------|
| `core/` | Engine: `bloom.js` (routing filter), `tokenize.js`, `db.js` (IndexedDB), `extract.js` (local DOM extraction), `capture.js`, `search.js`, `mesh.js` (p2p host: keys, trust graph, gossip) |
| `lib/` | Vendored p2p libraries: `nostr-p2p.js` (WebRTC mesh), `nostr-deps.js`, `idb.js` |
| `background.js` | MV3 background: captures, routes; hosts the mesh on Firefox |
| `offscreen.html`/`offscreen.js` | Chrome-only persistent host for the WebRTC mesh |
| `popup.*`, `search.*` | Extension UI |
| `DESIGN.md` | Architecture + build plan |

## License

See [LICENSE](LICENSE).
