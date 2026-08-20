import assert from 'node:assert/strict';
import { test } from 'node:test';
import './vendor/fake-indexeddb/auto.mjs';

globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {}
};

const { getDB, rebuildDomainStats } = await import('../core/db.js');
const { saveDoc, deleteDoc, getDomainStats } = await import('../core/search.js');

function doc(url, keywords, title = 'Page') {
  return {
    url,
    title,
    description: '',
    direct_keywords: keywords,
    related_keywords: '',
    timestamp: Math.floor(Date.now() / 1000)
  };
}

test('saveDoc accumulates per-domain keyword stats', async () => {
  await saveDoc(doc('https://www.youtube.com/watch?v=1', 'sourdough bread video', 'Sourdough Bread Video'));
  await saveDoc(doc('https://www.youtube.com/watch?v=2', 'sourdough starter video', 'Sourdough Starter Video'));
  await saveDoc(doc('https://www.youtube.com/watch?v=3', 'bread flour video', 'Bread Flour Video'));

  const st = await getDomainStats('youtube.com');
  assert.ok(st, 'domain stats exist for youtube.com');
  assert.equal(st.docs, 3);
  assert.equal(st.terms['video'], 3, 'video appears on every doc of the domain');
  assert.equal(st.terms['sourdough'], 2);
  assert.equal(st.terms['bread'], 2);
  assert.equal(st.terms['starter'], 1);
  assert.equal(st.terms['flour'], 1);

  // A different domain keeps its own stats.
  await saveDoc(doc('https://example.org/post/1', 'quantum banana'));
  const other = await getDomainStats('example.org');
  assert.equal(other.docs, 1);
  assert.equal(other.terms['quantum'], 1);
  assert.equal((await getDomainStats('youtube.com')).docs, 3, 'youtube stats unchanged');

  // www./m. collapse onto the main domain.
  assert.equal((await getDomainStats('youtube.com')).docs, 3);
  assert.equal(await getDomainStats('www.youtube.com'), null, 'www prefix is normalized away');
});

test('re-saving a doc updates the domain stats', async () => {
  // Re-save v1 without the "video" keyword.
  await saveDoc(doc('https://www.youtube.com/watch?v=1', 'sourdough bread', 'Sourdough Bread'));
  const st = await getDomainStats('youtube.com');
  assert.equal(st.docs, 3);
  assert.equal(st.terms['video'], 2, 'video removed from the re-saved doc');
  assert.equal(st.terms['sourdough'], 2);
  assert.equal(st.terms['bread'], 2);
});

test('deleteDoc decrements the domain stats', async () => {
  await deleteDoc('https://www.youtube.com/watch?v=2');
  const st = await getDomainStats('youtube.com');
  assert.equal(st.docs, 2);
  assert.equal(st.terms['sourdough'], 1);
  assert.equal(st.terms['starter'], undefined, 'term exclusive to the deleted doc is dropped');

  await deleteDoc('https://www.youtube.com/watch?v=3');
  const st2 = await getDomainStats('youtube.com');
  assert.equal(st2.docs, 1);
  assert.equal(st2.terms['video'], undefined);

  await deleteDoc('https://www.youtube.com/watch?v=1');
  assert.equal(await getDomainStats('youtube.com'), null, 'row removed when the last doc is deleted');
});

test('rebuildDomainStats re-aggregates from existing docs', async () => {
  const db = await getDB();
  await saveDoc(doc('https://www.youtube.com/watch?v=9', 'sourdough bread video', 'Sourdough Bread Video'));
  await db.delete('domainStats', 'youtube.com');
  await rebuildDomainStats(db);
  const st = await getDomainStats('youtube.com');
  assert.equal(st.docs, 1);
  assert.equal(st.terms['sourdough'], 1);
  assert.equal(st.terms['video'], 1);
});
