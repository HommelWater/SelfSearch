# fake-indexeddb (vendored)

In-memory implementation of the IndexedDB API, used only by the tests so they
can run in Node without a browser. Pure ESM build vendored here so the project
has zero dependencies and needs no package manager.

- Source: https://github.com/dumbmatter/fakeIndexedDB
- License: MIT (see https://github.com/dumbmatter/fakeIndexedDB/blob/master/LICENSE)
- Vendored version: 6.2.5 (build/esm/ only, plus auto/entry)
- To update: `npm pack fake-indexeddb@<version>` in a temp dir, extract
  `build/esm/`, and update `auto.mjs`'s imports.
