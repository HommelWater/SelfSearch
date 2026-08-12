import assert from 'node:assert/strict';
import { test } from 'node:test';
import 'fake-indexeddb/auto';

const { saveDoc, deleteDoc, search } = await import('../core/search.js');
const { getDB } = await import('../core/db.js');

test('deleteDoc removes the doc from the index, queryCache, and docCache', async () => {
  const now = Math.floor(Date.now() / 1000);
  await saveDoc({
    url: 'https://x.example/1',
    title: 'Alpha Page',
    description: 'about alpha things',
    direct_keywords: 'alpha',
    related_keywords: '',
    timestamp: now,
    image_hash: ''
  });

  // A local search caches the result in queryCache.
  assert.equal((await search('alpha')).length, 1);

  // A cached peer copy of the same URL exists too.
  const db = await getDB();
  await db.put('docCache', {
    id: 'npub1peer|https://x.example/1',
    authorNpub: 'npub1peer',
    url: 'https://x.example/1',
    title: 'Alpha Page',
    description: 'about alpha things',
    direct_keywords: 'alpha',
    related_keywords: '',
    timestamp: now,
    addedAt: Date.now(),
    terms: ['alpha']
  });

  const { removed } = await deleteDoc('https://x.example/1');
  assert.equal(removed, true);

  assert.equal(await db.get('docs', 'https://x.example/1'), undefined, 'own doc deleted');
  assert.equal(await db.get('docCache', 'npub1peer|https://x.example/1'), undefined, 'cached peer copy deleted');

  // And it must not reappear from the query cache.
  assert.equal((await search('alpha')).length, 0, 'deleted doc should not come back from queryCache');
});
