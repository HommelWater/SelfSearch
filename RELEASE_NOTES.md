SelfSearch 1.3.0 - Release Notes

Searching and indexing got smarter.

Auto-indexing

- Pages are indexed automatically as you visit them - no need to click the icon for every page. A content script captures the page's text as it loads and the background indexes it fully (searchable, keyword-extracted).
- A toggle on the search page controls auto-indexing ("Auto-index visited pages"); it is on by default and can be switched off at any time.
- Pages with no real content (JS shells, loading screens) are skipped.

Better keywords

- Domain-aware extraction. Keywords that appear on nearly every page of a domain (e.g. "video"/"likes" on youtube.com) are deprioritized, so each page's unique terms rank first.
- User-aware extraction. The same applies across your whole index - if you index lots of cooking pages, "recipe" stops dominating every page's keywords.
- Stable keywords across visits. A page's recommendations and viewer-specific content change between visits; only the keywords that reappear across repeated visits are kept. Random material drops out, and a genuinely changed page converges onto its new terms.
- User-entered keywords always stay at the front of a page's tags.

Search quality

- Stemming (Porter) is applied at index and query time, so "running", "runs" and "run" all match the same pages.
- Prefix matching as a fallback: typing "sourdou" still finds the "sourdough" page.
- Your index is rebuilt automatically once after upgrading so all existing pages use the new matching.

Development

- Tests: node test/run.mjs (53 tests). No npm, no build step.
- The mesh test suite is now reliable - fakes are injected through explicit test seams instead of experimental module mocking.

---

SelfSearch 1.2.3 - Release Notes

- Removed the unused 'storage' permission from the manifest. All data was already kept in IndexedDB, so nothing changes functionally. This resolves a Chrome Web Store policy violation ("requesting but not using a permission").

---

SelfSearch 1.2.1 - Release Notes

Privacy

- No screenshots are taken, ever. The screenshot capture code has been removed entirely; indexing reads the page's text only.
- Fewer permissions. The 'tabs' permission is gone (it existed only for screenshots); the extension now asks for the minimum needed to index and connect.
- IP address disclosure is now disclosed up front. Connecting to a peer over WebRTC shows that peer your IP address, which reveals your approximate location. A notice now appears on the Peers page before you add a friend, and the privacy policy explains the implication. Only add people you trust.

What changed

- Removed screenshot capture: no image is captured, stored, or hashed when you index a page.
- Dropped the images IndexedDB store and the now-unused image helpers.
- Dropped the tabs permission from the manifest.
- Added the IP-address/location disclosure to the Peers tab UI, the privacy policy, and the design notes.

Development

- Tests: node test/run.mjs (32 tests). No npm, no build step.

---

SelfSearch 1.2.0 - Release Notes

SelfSearch has been rewritten. It is now a serverless peer-to-peer extension: the server is gone and the entire search engine runs inside the browser, with no backend, no accounts, and no cloud.

What changed

- Fully local engine. Click the icon to index a page; titles, keywords, and descriptions are extracted locally from the page's own text. No cloud, no API keys, no host permissions.
- No server to install. Load the extension, index pages, search. No setup script, no domain, no login.

Search across a trusted network (opt-in)

- Nostr identity. Your keypair is your address (npub); the secret key stays in your extension storage.
- Friends and invites. Add friends by npub, or send a friend invite that both sides accept automatically.
- WebRTC mesh. Peers connect directly over WebRTC; relays are used only for connection signaling and friend invitations.
- Bloom-filter routing. Queries fan out over a hop-limited web of trust (default 2 hops), so you can find content in your friends' networks.
- Streaming results. Answers appear as they arrive, attributed to the author, not whoever relayed them.

Trust and integrity

- Signed docs. Every doc served to peers carries a per-doc author signature. Caches verify before storing; unsigned or tampered docs are dropped, and forged answers are never shown.
- Signed tombstones. Deleting a page publishes a signed delete that propagates through the mesh, so cached copies of deleted pages disappear.
- Self-healing repair. A manifest of your docs detects loss or corruption and restores authentic copies from peers.
- Last-write-wins. Doc caches and profile sync never let an older copy roll back a newer one.

Redundancy

- docCache. Peers' docs are cached on-demand from query answers and proactively backfilled from direct friends, so content survives a peer going offline and stays searchable.
- Peers feed. See who your peers are and what they have recently indexed.

Multi-device sync

- Enter the same nsec on another device to make it the same identity; devices sharing a key link automatically and replicate your index (last-write-wins), so all your devices converge.
- Profile updates (name/avatar/bio) sync across your devices too.

Quality of life

- Omnibox search (ss <query>), Alt+Shift+S, or the search page hub with Search / Peers / Profile tabs.
- Privacy and bandwidth. Text metadata only. No screenshots are taken. Relays only carry signaling and invites.

What didn't change

- Text-only metadata; no screenshots are taken.
- A clear privacy policy (see PRIVACY.txt).

Development

- The project is dependency-free: pure ES modules with relative imports. Tests run with Node's built-in runner - node test/run.mjs (30 tests). No npm, no build step, nothing to install.
