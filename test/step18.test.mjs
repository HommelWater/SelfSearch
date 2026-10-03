import assert from 'node:assert/strict';
import { test } from 'node:test';
import './vendor/fake-indexeddb/auto.mjs';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const { saveDoc, search, searchAll } = await import('../core/search.js');

const now = Math.floor(Date.now() / 1000);
async function seed() {
  for (let i = 0; i < 25; i++) {
    await saveDoc({
      url: `https://page.example/${i}`,
      title: `Page ${i}`,
      description: '',
      direct_keywords: 'shared term',
      related_keywords: `uniq${i}`,
      timestamp: now + i
    });
  }
}

test('search pages through results with offset and exposes total', async () => {
  await seed();

  const p1 = await search('shared', { limit: 10, offset: 0 });
  assert.equal(p1.length, 10, 'first page holds the page size');
  assert.equal(p1.total, 25, 'total reflects every match (non-enumerable)');

  const p2 = await search('shared', { limit: 10, offset: 10 });
  assert.equal(p2.length, 10);
  assert.equal(p2.total, 25);

  const p3 = await search('shared', { limit: 10, offset: 20 });
  assert.equal(p3.length, 5, 'last page holds the remainder');
  assert.equal(p3.total, 25);

  // Pages never overlap.
  const disjoint = (a, b) => [...a.map(d => d.url)].every(u => !b.some(d => d.url === u));
  assert.ok(disjoint(p1, p2), 'page 1 and page 2 disjoint');
  assert.ok(disjoint(p2, p3), 'page 2 and page 3 disjoint');
});

test('page 0 is cached; later pages recompute with the same total', async () => {
  const p0 = await search('shared', { limit: 10, offset: 0 });
  const p0cached = await search('shared', { limit: 10, offset: 0 });
  assert.ok(p0cached[0]?.cached, 'repeat page-0 search is served from cache');

  const p1 = await search('shared', { limit: 10, offset: 10 });
  assert.equal(p0.total, p1.total, 'cached and recomputed totals agree');
});

test('searchAll returns the full ranked set for the mesh to merge', async () => {
  const { results, total } = await searchAll('shared');
  assert.equal(total, 25);
  assert.equal(results.length, 25);
});

test('no matches report a total of 0', async () => {
  const r = await search('zzzznooo');
  assert.equal(r.length, 0);
  assert.equal(r.total, 0);
});
