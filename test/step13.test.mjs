import assert from 'node:assert/strict';
import { test } from 'node:test';
import './vendor/fake-indexeddb/auto.mjs';

globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {}
};

const { getDB, getDoc } = await import('../core/db.js');
const { saveDoc, search, rebuildIndexForVersion } = await import('../core/search.js');
const { docTerms, TOKENIZER_VERSION } = await import('../core/tokenize.js');

function doc(url, keywords, title = 'Page', description = '') {
  return {
    url,
    title,
    description,
    direct_keywords: keywords,
    related_keywords: '',
    timestamp: Math.floor(Date.now() / 1000)
  };
}

async function seed() {
  await saveDoc(doc('https://example.com/1', 'sourdough bread recipe', 'Sourdough Bread Recipe',
    'learn to bake a rustic sourdough loaf'));
  await saveDoc(doc('https://example.com/2', 'running training plan', 'Running Training Plan',
    'build a running routine with interval training'));
  await saveDoc(doc('https://youtube.com/watch?v=x', 'sourdough video', 'Sourdough Video'));
}

test('stemmed search matches across word forms', async () => {
  await seed();

  // "recipes" and "recipe" both stem to "recip" -> both docs... doc 1 has it.
  const r1 = await search('recipes');
  assert.ok(r1.some(d => d.url === 'https://example.com/1'), 'recipes matches the recipe doc');

  // "runs" stems to "run", matching the "running" doc.
  const r2 = await search('runs');
  assert.ok(r2.some(d => d.url === 'https://example.com/2'), 'runs matches the running doc');

  // Multi-word query, inflected.
  const r3 = await search('running routines');
  assert.ok(r3.some(d => d.url === 'https://example.com/2'), 'inflected multi-word query matches');

  // Stored keywords stay raw (only the index is stemmed).
  const stored = await getDoc('https://example.com/2');
  assert.ok(stored.direct_keywords.includes('running'), 'stored keywords are not stemmed');
});

test('prefix fallback matches when exact terms miss', async () => {
  await seed();
  // "sourdou" is not a real word form; prefix fallback reaches "sourdough".
  const r = await search('sourdou');
  assert.ok(r.some(d => d.url === 'https://example.com/1'), 'prefix search matches sourdough doc');
  assert.ok(r.some(d => d.url === 'https://youtube.com/watch?v=x'), 'prefix search crosses domains');

  // Exact results do not trigger the fallback, but a nonsense term returns nothing.
  assert.deepEqual(await search('zzzzq'), []);
});

test('docTerms index keys are stemmed', async () => {
  assert.deepEqual(
    docTerms({ title: 'Running Recipes', description: 'Bake sourdough loaves', direct_keywords: '', related_keywords: '' }),
    ['run', 'recip', 'bake', 'sourdough', 'loav']
  );
});

test('rebuildIndexForVersion reindexes when the tokenizer version changes', async () => {
  const db = await getDB();
  await seed();

  // Simulate a tokenizer upgrade: forget the version, seed an index with raw
  // (unstemed) keys, then rebuild.
  await db.put('settings', { key: 'tokenizerVersion', value: TOKENIZER_VERSION - 1 });
  await db.put('index', { term: 'recipes', urls: ['https://example.com/1'] });
  await db.put('index', { term: 'running', urls: ['https://example.com/2'] });

  await rebuildIndexForVersion(db);

  // Old raw keys are gone, stemmed keys present.
  assert.equal(await db.get('index', 'recipes'), undefined, 'raw key removed');
  assert.equal(await db.get('index', 'running'), undefined, 'raw key removed');
  assert.ok(await db.get('index', 'recip'), 'stemmed key present');
  assert.ok(await db.get('index', 'run'), 'stemmed key present');
  assert.equal((await db.get('settings', 'tokenizerVersion')).value, TOKENIZER_VERSION);

  // Rebuild is idempotent after the version is recorded.
  const before = (await db.getAll('index')).length;
  await rebuildIndexForVersion(db);
  assert.equal((await db.getAll('index')).length, before);
});
