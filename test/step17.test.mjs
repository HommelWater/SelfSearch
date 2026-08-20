import assert from 'node:assert/strict';
import { test } from 'node:test';
import './vendor/fake-indexeddb/auto.mjs';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const { getDB } = await import('../core/db.js');
const { saveDoc, search } = await import('../core/search.js');
const { expandQuery, observeQueryKeys, observeQueryText } = await import('../core/qk.js');
const { stemmed } = await import('../core/tokenize.js');

function doc(url, keywords) {
  return {
    url,
    title: 'Page',
    description: '',
    direct_keywords: keywords,
    related_keywords: '',
    timestamp: Math.floor(Date.now() / 1000)
  };
}

test('thesaurus expands synonyms so question-style queries match', async () => {
  const keys = await expandQuery(['repair']);
  assert.ok(keys.includes('fix'), '"repair" should expand to "fix"');

  const cooking = await expandQuery(stemmed('cooking')); // stems to "cook"
  assert.ok(cooking.includes('recip'), '"cooking" should expand to "recipe" (stemmed)');
  assert.ok(cooking.includes('bake'), '"cooking" should expand to "bake"');

  assert.equal((await expandQuery(['oven'])).length, 0, 'unmapped terms expand to nothing');
});

test('learned co-occurrence expands with clicked keywords', async () => {
  await observeQueryKeys(['oven'], ['repair', 'guide']);
  const keys = await expandQuery(['oven']);
  assert.ok(keys.includes('repair'));
  assert.ok(keys.includes('guide'));
});

test('search finds a page via the thesaurus alone', async () => {
  await saveDoc(doc('https://qk.example/1', 'oven repair guide'));
  const hits = await search('fix');
  assert.ok(hits.some(d => d.url === 'https://qk.example/1'),
    'searching "fix" finds the "repair" page via thesaurus expansion');
});

test('search learns from a clicked result and finds it on a later query', async () => {
  await saveDoc(doc('https://qk.example/2', 'sourdough starter'));

  // "bread" does not match the page yet.
  assert.deepEqual(await search('bread'), []);

  // User clicks the result for that page under a different query that DOES match...
  await observeQueryText('leaven', 'sourdough starter');
  assert.ok((await search('leaven')).some(d => d.url === 'https://qk.example/2'),
    'the keyword the user clicked under a previous query now helps "leaven"');

  // The learned association also helps an unmapped word the user types later.
  await observeQueryText('bread', 'sourdough starter');
  const hits = await search('bread');
  assert.ok(hits.some(d => d.url === 'https://qk.example/2'),
    'after a click, "bread" finds the sourdough page via the learned map');
});

test('the learned map stays bounded', async () => {
  const many = Array.from({ length: 40 }, (_, i) => `keyword${i}`);
  await observeQueryKeys(['overflow'], many);
  const db = await getDB();
  const row = await db.get('qk', 'overflow');
  assert.ok(Object.keys(row.keys).length <= 20, 'query-key rows are capped');
});
