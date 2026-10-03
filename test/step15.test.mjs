import assert from 'node:assert/strict';
import { test } from 'node:test';
import './vendor/fake-indexeddb/auto.mjs';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const { getDB } = await import('../core/db.js');
const { search } = await import('../core/search.js');
const { indexFromPage } = await import('../core/capture.js');

// Capture `url` once: stable page content repeated, plus `variant` terms that
// appear only on this visit (recommendations / viewer-specific material).
async function visit(url, title, description, base, variant) {
  await indexFromPage({
    url,
    title,
    metaDescription: description,
    bodyText: base.join(' ').repeat(15) + ' ' + variant.join(' ').repeat(3)
  });
}

function keywords(doc) {
  return [...doc.direct_keywords.split(' '), ...doc.related_keywords.split(' ')].filter(Boolean);
}

test('keywords converge to the visit-stable core and search reflects it', async () => {
  const url = 'https://visit.example/sourdough';
  const base = ['sourdough', 'bread', 'recipe', 'flour', 'water', 'starter'];
  const variants = [
    ['bakery', 'famous', 'lovely'],
    ['chef', 'celebrity', 'huge'],
    ['kitchen', 'viral', 'magic']
  ];
  for (const v of variants) {
    await visit(url, 'Sourdough Bread Recipe', 'bake a rustic sourdough loaf', base, v);
  }

  const db = await getDB();
  const kws = keywords(await db.get('docs', url));
  for (const t of base) assert.ok(kws.includes(t), `stable term "${t}" kept across visits`);
  for (const t of variants.flat()) assert.ok(!kws.includes(t), `one-off recommendation "${t}" dropped`);

  // The stored keywords drive search: stable terms still find the page, a
  // dropped one-off term no longer matches it at all.
  assert.ok((await search('sourdough')).some(d => d.url === url), 'stable term still finds the page');
  assert.deepEqual(await search('famous'), [], 'a dropped one-off term no longer matches');
});

test('domain-common keywords stay off new pages of that domain', async () => {
  const db = await getDB();
  // A domain where every indexed page carries "video"/"watch" boilerplate.
  await db.put('domainStats', { domain: 'youtube.com', docs: 40, terms: { video: 40, watch: 38, channel: 36 } });

  const url = 'https://youtube.com/watch?v=abc';
  const base = ['buttery', 'croissant', 'pastry', 'flaky', 'dough'];
  // Each visit gets its own filler vocabulary (alphanumeric so tokenization
  // keeps them) so the fillers themselves don't become consensus-stable — they
  // only push the domain boilerplate below the per-capture keyword cutoff.
  const visits = [
    { extra: ['cream', 'butter'], fillers: Array.from({ length: 45 }, (_, i) => `alpha${i}`) },
    { extra: ['jam', 'honey'], fillers: Array.from({ length: 45 }, (_, i) => `beta${i}`) },
    { extra: ['cheese', 'ham'], fillers: Array.from({ length: 45 }, (_, i) => `gamma${i}`) }
  ];
  for (const v of visits) {
    await indexFromPage({
      url,
      title: 'Buttery Croissant Recipe',
      metaDescription: 'how to make buttery croissants',
      bodyText: base.join(' ').repeat(15) + ' video watch ' + v.extra.join(' ').repeat(3) + ' ' + v.fillers.join(' ')
    });
  }

  const kws = keywords(await db.get('docs', url));
  assert.ok(kws.length <= 10, `keyword set reduced, not inflated (got ${kws.length}: ${kws.join(',')})`);
  for (const t of base) assert.ok(kws.includes(t), `stable term "${t}" kept`);
  for (const t of ['video', 'watch']) assert.ok(!kws.includes(t), `domain-common "${t}" dropped`);
  for (const v of visits) for (const t of v.extra) assert.ok(!kws.includes(t), `one-off "${t}" dropped`);
});

test('the same boilerplate stays on domains where it is not common', async () => {
  const db = await getDB();
  const url = 'https://example.org/video-post';
  const base = ['granola', 'oats', 'honey', 'nuts', 'seed'];
  await indexFromPage({
    url,
    title: 'Granola Recipe',
    metaDescription: 'granola with oats and honey',
    bodyText: base.join(' ').repeat(15) + ' video watch subscribe ' + base.join(' ').repeat(3)
  });

  const kws = keywords(await db.get('docs', url));
  assert.ok(kws.includes('video'), 'without domain boilerplate stats, "video" is a valid keyword');

  // Search-level: "video" matches the page where it is content, but never the
  // youtube page where it was deprioritized as domain boilerplate.
  const hits = await search('video');
  assert.ok(hits.some(d => d.url === url), '"video" matches on the non-boilerplate domain');
  assert.ok(!hits.some(d => d.url === 'https://youtube.com/watch?v=abc'), '"video" does not match the youtube page');
});

test('different pages on the same domain keep their own keywords', async () => {
  const db = await getDB();
  const a = 'https://cooking.example/pasta';
  const b = 'https://cooking.example/curry';
  const baseA = ['pasta', 'tomato', 'basil', 'garlic', 'olive'];
  const baseB = ['curry', 'coconut', 'turmeric', 'ginger', 'rice'];

  for (const [url, title, desc, base] of [
    [a, 'Tomato Pasta', 'pasta with tomato and basil', baseA],
    [b, 'Coconut Curry', 'curry with coconut and turmeric', baseB],
    [a, 'Tomato Pasta', 'pasta with tomato and basil', baseA],
    [b, 'Coconut Curry', 'curry with coconut and turmeric', baseB]
  ]) {
    await visit(url, title, desc, base, []);
  }

  const kwsA = keywords(await db.get('docs', a));
  const kwsB = keywords(await db.get('docs', b));
  for (const t of baseA) assert.ok(kwsA.includes(t), `"${t}" stays on page A`);
  for (const t of baseB) assert.ok(kwsB.includes(t), `"${t}" stays on page B`);
  for (const t of baseA) assert.ok(!kwsB.includes(t), `"${t}" is not leaked onto page B`);
  for (const t of baseB) assert.ok(!kwsA.includes(t), `"${t}" is not leaked onto page A`);
});
