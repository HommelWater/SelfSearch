import assert from 'node:assert/strict';
import { BloomFilter } from '../core/bloom.js';
import { tokenize, docTerms } from '../core/tokenize.js';
import { extractFromDom } from '../core/extract.js';

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
  ['rust', 'webassembly', 'tutorial', 'learn']
);

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
console.log('All tests passed');
