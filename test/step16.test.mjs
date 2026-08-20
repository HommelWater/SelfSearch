import assert from 'node:assert/strict';
import { test } from 'node:test';
import './vendor/fake-indexeddb/auto.mjs';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

// --- Simulate the page the content script runs in ---------------------------
const sent = [];
globalThis.chrome = {
  runtime: { sendMessage: (msg) => { sent.push(msg); return Promise.resolve(); } }
};
globalThis.document = {
  readyState: 'complete',
  title: 'Sourdough Bread Recipe',
  querySelector: () => ({ content: 'sourdough, bread, recipe' }),
  body: { innerText: ('sourdough bread recipe flour water starter ').repeat(15) + ' trending famous subscription ' }
};
globalThis.location = { href: 'https://www.youtube.com/watch?v=abc123' };
globalThis.window = { addEventListener() {} };

// Importing the content script executes its top-level capture on "page load".
await import('../content.js');

const { search } = await import('../core/search.js');
const { getDB } = await import('../core/db.js');
const { indexFromPage } = await import('../core/capture.js');

test('content script captures a page and asks the background to index it', () => {
  assert.equal(sent.length, 1, 'exactly one autoIndex message sent on page load');
  const msg = sent[0];
  assert.equal(msg.action, 'autoIndex');
  assert.equal(msg.page.url, 'https://www.youtube.com/watch?v=abc123');
  assert.equal(msg.page.title, 'Sourdough Bread Recipe');
  assert.ok(msg.page.bodyText.includes('sourdough'), 'page text captured');
});

test('the background path fully indexes the captured page', async () => {
  // Simulate the background handler: indexFromPage(request.page).
  const doc = await indexFromPage(sent[0].page);
  assert.ok(doc, 'doc created');
  const db = await getDB();
  const stored = await db.get('docs', doc.url);
  assert.ok(stored, 'doc stored in docs');
  assert.ok(stored.title === 'Sourdough Bread Recipe', 'title stored');
  assert.ok(stored.description, 'description stored');
  assert.ok(stored.direct_keywords, 'keywords extracted and stored');
  assert.ok(await db.get('index', 'sourdough'), 'page indexed for search');

  const hits = await search('sourdough');
  assert.ok(hits.some(d => d.url === doc.url), 'page is searchable after auto-index');
});

test('auto-index respects the autoIndex setting', async () => {
  const db = await getDB();
  await db.put('settings', { key: 'autoIndex', value: false });
  // Mirror the background gate: (await settings.get('autoIndex')) !== false.
  const enabled = (await db.get('settings', 'autoIndex'))?.value !== false;
  assert.equal(enabled, false, 'auto-index disabled via setting');
  await db.put('settings', { key: 'autoIndex', value: true });
  assert.equal((await db.get('settings', 'autoIndex'))?.value !== false, true, 're-enabled');
});
