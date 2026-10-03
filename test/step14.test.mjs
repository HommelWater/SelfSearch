import assert from 'node:assert/strict';
import { test } from 'node:test';
import './vendor/fake-indexeddb/auto.mjs';

globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {}
};

const { getDB } = await import('../core/db.js');
const { saveDoc, deleteDoc, getUserStats } = await import('../core/search.js');
const { observeKeywords, getKwHistory } = await import('../core/kw.js');
const { extractFromDom } = await import('../core/extract.js');
const { indexFromPage, shouldAutoIndex } = await import('../core/capture.js');

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

test('userStats aggregate keywords across the whole index', async () => {
  await saveDoc(doc('https://a.com/1', 'sourdough bread recipe'));
  await saveDoc(doc('https://b.com/2', 'sourdough starter bread'));
  await saveDoc(doc('https://c.com/3', 'banana bread'));

  const us = await getUserStats();
  assert.equal(us.docs, 3);
  assert.equal(us.terms['bread'], 3);
  assert.equal(us.terms['sourdough'], 2);
  assert.equal(us.terms['recipe'], 1);

  // Re-saving a doc removes its old keywords from the user corpus.
  await saveDoc(doc('https://a.com/1', 'sourdough bread'));
  const us2 = await getUserStats();
  assert.equal(us2.docs, 3);
  assert.equal(us2.terms['recipe'], undefined);

  // Deleting a doc removes its keywords too.
  await deleteDoc('https://b.com/2');
  const us3 = await getUserStats();
  assert.equal(us3.docs, 2);
  assert.equal(us3.terms['starter'], undefined);
});

test('extraction deprioritizes keywords common to the whole index', async () => {
  // "recipe" appears on 9/10 of the user's indexed pages -> deprioritized.
  const userStats = { key: 'self', docs: 10, terms: { recipe: 9, bread: 8, sourdough: 1 } };
  const ex = extractFromDom({
    title: 'Sourdough Bread Recipe',
    bodyText: ('sourdough bread recipe flour water ').repeat(20)
  }, { userStats });
  const direct = ex.direct_keywords.split(' ');
  assert.ok(direct.includes('sourdough'), 'rare-on-user term stays a direct keyword');
  assert.ok(direct.indexOf('flour') < direct.indexOf('recipe'), 'user-common term is demoted below unique terms');
  assert.ok(direct.indexOf('sourdough') < direct.indexOf('bread'), 'order reflects the user corpus');
});

test('observeKeywords keeps stable terms and drops one-offs', async () => {
  const url = 'https://kw.test/1';
  let stable = await observeKeywords(url, ['sourdough', 'bread', 'recipe', 'widgetA']);
  assert.deepEqual(stable, ['sourdough', 'bread', 'recipe', 'widgetA'], 'first capture keeps everything');

  await observeKeywords(url, ['sourdough', 'bread', 'recipe', 'widgetB']);
  await observeKeywords(url, ['sourdough', 'bread', 'recipe', 'widgetC']);
  // Widgets appeared in only 1 of 3 captures -> 1/3 < 0.5 -> dropped.
  stable = await observeKeywords(url, ['sourdough', 'bread', 'recipe']);
  assert.deepEqual(stable, ['sourdough', 'bread', 'recipe'], 'consensus keeps only reappearing terms');
});

test('indexFromPage keeps only stable keywords across repeated captures', async () => {
  const url = 'https://youtube.com/watch?v=xyz';
  const base = 'sourdough bread recipe flour water starter ';
  const captures = [
    base.repeat(15) + ('bakery famous lovely ').repeat(3),
    base.repeat(15) + ('chef celebrity huge ').repeat(3),
    base.repeat(15) + ('kitchen viral magic ').repeat(3)
  ];
  for (const bodyText of captures) {
    await indexFromPage({
      url,
      title: 'Sourdough Bread Recipe',
      metaDescription: 'bake a sourdough loaf',
      metaKeywords: 'sourdough, bread, recipe',
      bodyText
    });
  }

  const db = await getDB();
  const stored = await db.get('docs', url);
  const kws = [...stored.direct_keywords.split(' '), ...stored.related_keywords.split(' ')];
  for (const t of ['sourdough', 'bread', 'recipe', 'flour', 'water', 'starter']) {
    assert.ok(kws.includes(t), `stable term "${t}" kept`);
  }
  for (const t of ['bakery', 'famous', 'lovely', 'chef', 'celebrity', 'huge', 'kitchen', 'viral', 'magic']) {
    assert.ok(!kws.includes(t), `one-off recommendation term "${t}" dropped`);
  }
});

test('deleteDoc removes the keyword history for a url', async () => {
  const url = 'https://hist.test/1';
  await indexFromPage({ url, title: 'Some Page', bodyText: ('word one two three four ').repeat(30) });
  assert.ok(await getKwHistory(url), 'history recorded for the url');
  await deleteDoc(url);
  assert.equal(await getKwHistory(url), null, 'history cleaned up on delete');
});

test('shouldAutoIndex gates auto-capture', () => {
  assert.equal(shouldAutoIndex({ url: 'https://a.com', bodyText: 'short' }), false, 'too little text');
  assert.equal(shouldAutoIndex({ url: 'chrome://settings', bodyText: 'x'.repeat(300) }), false, 'not an http page');
  assert.equal(shouldAutoIndex({ url: 'https://a.com', bodyText: 'word '.repeat(100) }), true);
});
