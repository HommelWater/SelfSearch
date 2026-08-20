import assert from 'node:assert/strict';
import { BloomFilter } from '../core/bloom.js';
import { tokenize, docTerms, stemmed } from '../core/tokenize.js';
import { stem } from '../core/stem.js';
import { extractFromDom } from '../core/extract.js';
import { hostnameOf, domainTerms, termDomainRatio } from '../core/domain.js';

// --- Bloom filter basics ---
const b = new BloomFilter(1024, 5);
b.add('react');
b.add('webassembly');
assert.equal(b.has('react'), true);
assert.equal(b.has('webassembly'), true);
assert.equal(b.has('neverseen'), false);

// --- False positive rate stays low ---
const fp = BloomFilter.create(5000, 0.01);
for (let i = 0; i < 5000; i++) fp.add(`term${i}`);
let fpCount = 0;
for (let i = 0; i < 5000; i++) {
  if (fp.has(`nomatch${i}`)) fpCount++;
}
assert.ok(fpCount / 5000 < 0.05, `fp rate too high: ${fpCount / 5000}`);

// --- Roundtrip through base64 JSON ---
const original = new BloomFilter(4096, 7);
original.addAll(['alpha', 'beta', 'gamma']);
const json = original.toJSON();
const restored = BloomFilter.fromJSON(json);
for (const t of ['alpha', 'beta', 'gamma']) assert.equal(restored.has(t), true);
assert.equal(restored.has('delta'), false);
assert.equal(original.bits, restored.bits);
assert.equal(original.hashes, restored.hashes);

// --- Union ---
const a = new BloomFilter(1024, 5).addAll(['one', 'two']);
const c = new BloomFilter(1024, 5).addAll(['three']);
a.union(c);
assert.equal(a.has('one'), true);
assert.equal(a.has('three'), true);

// --- Size mismatch is rejected ---
assert.throws(() => new BloomFilter(1024, 5).union(new BloomFilter(2048, 5)));

// --- Tokenize ---
assert.deepEqual(tokenize('Hello World, this is a TEST!'), ['hello', 'world', 'test']);
assert.equal(tokenize('the a an and').length, 0);
assert.equal(tokenize('x').length, 0);
assert.deepEqual(
  docTerms({ title: 'Rust WebAssembly Tutorial', description: 'Learn rust and webassembly', direct_keywords: '', related_keywords: '' }),
  ['rust', 'webassembl', 'tutori', 'learn']
);

// --- Stemming (Porter) ------------------------------------------------------
assert.equal(stem('caresses'), 'caress');
assert.equal(stem('ponies'), 'poni');
assert.equal(stem('feed'), 'feed');
assert.equal(stem('agreed'), 'agre');
assert.equal(stem('sing'), 'sing');
assert.equal(stem('sky'), 'sky');
assert.equal(stem('conditional'), 'condit');
assert.equal(stem('running'), 'run');
assert.equal(stem('runs'), 'run');
assert.equal(stem('bananas'), 'banana');
assert.equal(stem('baking'), 'bake');
assert.equal(stem('adoption'), 'adopt');
assert.equal(stem('hopefulness'), 'hope');
assert.deepEqual(stemmed('running recipes sourdough'), ['run', 'recip', 'sourdough']);

// --- Local DOM keyword extraction ---
const ex = extractFromDom({
  title: 'Sourdough Bread Recipe',
  metaDescription: 'A simple sourdough bread recipe for beginners.',
  metaKeywords: 'sourdough, bread, baking',
  bodyText: ('sourdough bread baking recipe flour water starter knead loaf ').repeat(20) + 'random unrelated text about weather'
});
assert.equal(ex.title, 'Sourdough Bread Recipe');
assert.ok(ex.description.includes('sourdough'), 'description falls back to meta description');
const direct = ex.direct_keywords.split(' ');
for (const kw of ['sourdough', 'bread', 'baking', 'recipe']) {
  assert.ok(direct.includes(kw), `direct keywords should include "${kw}"`);
}
const weatherIdx = direct.indexOf('weather');
const loafIdx = direct.indexOf('loaf');
assert.ok(loafIdx >= 0, '"loaf" (high frequency) should be a direct keyword');
assert.ok(weatherIdx === -1 || loafIdx < weatherIdx, 'high-frequency terms must rank above low-frequency ones');
assert.equal(Array.isArray(ex.related_keywords.split(' ')), true);

// --- Domain helpers ---
assert.equal(hostnameOf('https://www.youtube.com/watch?v=abc'), 'youtube.com');
assert.equal(hostnameOf('https://m.youtube.com/watch?v=abc'), 'youtube.com');
assert.equal(hostnameOf('https://youtube.com'), 'youtube.com');
assert.equal(hostnameOf('https://news.ycombinator.com/item?id=1'), 'news.ycombinator.com');
assert.equal(hostnameOf('not a url'), '');
assert.deepEqual(
  domainTerms({ direct_keywords: 'quantum banana quantum', related_keywords: 'physics fruit' }),
  ['quantum', 'banana', 'physics', 'fruit']
);
const stats = { domain: 'youtube.com', docs: 10, terms: { video: 10, watch: 9, baking: 1 } };
assert.equal(termDomainRatio('video', stats), 1);
assert.equal(termDomainRatio('watch', stats), 0.9);
assert.equal(termDomainRatio('baking', stats), 0.1);
assert.equal(termDomainRatio('missing', stats), 0);
assert.equal(termDomainRatio('anything', null), 0);

// --- Common domain keywords are deprioritized ------------------------------
// On a domain where "video"/"watch" appear on nearly every page, extraction
// should favor the terms unique to this page over the domain-wide boilerplate.
const exDom = extractFromDom({
  title: 'Sourdough Bread Video',
  metaDescription: 'learn to bake sourdough bread',
  metaKeywords: 'sourdough, bread, baking, video',
  bodyText: ('sourdough bread baking video watch ').repeat(20)
}, { domainStats: stats });
const directDom = exDom.direct_keywords.split(' ');
assert.ok(directDom.includes('sourdough'), 'unique page term should stay a direct keyword');
assert.ok(directDom.includes('baking'), 'rare-on-domain term should stay a direct keyword');
assert.ok(!directDom.includes('video'), 'term on every domain doc is dropped from keywords');
assert.ok(directDom.indexOf('sourdough') < directDom.indexOf('watch'),
  'unique terms rank above common domain terms');

// Below the doc threshold the domain stats are not applied yet.
const smallStats = { domain: 'youtube.com', docs: 2, terms: { video: 2, watch: 2 } };
const exSmall = extractFromDom({
  title: 'Sourdough Bread Video',
  bodyText: ('sourdough bread baking video watch ').repeat(20)
}, { domainStats: smallStats });
assert.ok(exSmall.direct_keywords.split(' ').includes('video'),
  'deprioritization only kicks in after MIN_DOMAIN_DOCS');
console.log('All tests passed');
