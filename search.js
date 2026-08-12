import { search, getRecent } from './core/search.js';
import { docCount } from './core/db.js';
import { browserApi } from './core/capture.js';

const api = browserApi();

const queryInput = document.getElementById('query');
const goBtn = document.getElementById('go');
const metaDiv = document.getElementById('meta');
const resultsDiv = document.getElementById('results');

// Set while a network search is in flight; used to filter streaming partials.
let currentQueryId = null;

function fmtTime(ts) {
  return new Date(ts * 1000).toLocaleString();
}

function render(results) {
  resultsDiv.innerHTML = '';
  if (!results.length) {
    const div = document.createElement('div');
    div.className = 'empty';
    div.textContent = 'No results. Index pages with the extension, then search again.';
    resultsDiv.appendChild(div);
    return;
  }
  for (const r of results) {
    const el = document.createElement('div');
    el.className = 'result';

    const h = document.createElement('h3');
    const a = document.createElement('a');
    a.href = r.url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = r.title;
    h.appendChild(a);
    el.appendChild(h);

    const url = document.createElement('div');
    url.className = 'url';
    url.textContent = r.url;
    el.appendChild(url);

    if (r.description) {
      const desc = document.createElement('div');
      desc.className = 'desc';
      desc.textContent = r.description;
      el.appendChild(desc);
    }

    const kw = [];
    if (r.direct_keywords) kw.push(...r.direct_keywords.split(' ').filter(Boolean));
    if (r.related_keywords) kw.push(...r.related_keywords.split(' ').filter(Boolean));
    if (kw.length) {
      const k = document.createElement('div');
      k.className = 'kw';
      k.textContent = 'tags: ' + [...new Set(kw)].slice(0, 12).join(', ');
      el.appendChild(k);
    }

    const foot = document.createElement('div');
    foot.className = 'foot';
    const ts = document.createElement('span');
    ts.textContent = fmtTime(r.timestamp);
    foot.appendChild(ts);
    const right = document.createElement('span');
    if (r.cached) {
      const c = document.createElement('span');
      c.className = 'cached';
      c.textContent = 'cached';
      right.appendChild(c);
      right.appendChild(document.createTextNode(' · '));
    }
    if (r.source) {
      const s = document.createElement('span');
      s.className = r.source === 'peer' ? 'cached' : 'local';
      s.textContent = r.source === 'peer' ? (r.authorNpub ? 'peer ' + short(r.authorNpub) : 'peer') : 'local';
      right.appendChild(s);
      right.appendChild(document.createTextNode(' · '));
    }
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = 'delete';
    del.addEventListener('click', async () => {
      await api.runtime.sendMessage({ action: 'deleteDoc', url: r.url });
      run();
    });
    right.appendChild(del);
    foot.appendChild(right);
    el.appendChild(foot);

    resultsDiv.appendChild(el);
  }
}

function short(npub, n = 12) {
  return npub.length > n + 3 ? npub.slice(0, n) + '…' : npub;
}

async function run() {
  const q = queryInput.value.trim();
  if (!q) {
    currentQueryId = null;
    const count = await docCount();
    metaDiv.textContent = `${count} indexed page${count === 1 ? '' : 's'}.`;
    render(await getRecent(20));
    return;
  }
  currentQueryId = null; // drop partials from any previous search
  const t0 = performance.now();
  const results = await search(q, { limit: 20 });
  const ms = Math.round(performance.now() - t0);
  metaDiv.textContent = `${results.length} result${results.length === 1 ? '' : 's'} · ${ms}ms · searching network…`;
  render(results);

  // Stream peer results in as they arrive (mesh broadcasts `search_partial`).
  const queryId = (crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : Date.now() + '-' + Math.random().toString(36).slice(2);
  currentQueryId = queryId;

  let resp;
  try {
    resp = await api.runtime.sendMessage({ p2p: true, op: 'search', query: q, limit: 20, queryId });
  } catch {
    resp = null;
  }

  if (!resp || !resp.success) {
    currentQueryId = null;
    const total = Math.round(performance.now() - t0);
    metaDiv.textContent = `${results.length} result${results.length === 1 ? '' : 's'} · ${total}ms · mesh: ${resp?.error || 'offline'}`;
  } else if (resp.results && resp.results.length) {
    // Mesh answered synchronously without streaming (or partials missed) —
    // the response is authoritative.
    currentQueryId = null;
    const total = Math.round(performance.now() - t0);
    metaDiv.textContent =
      `${resp.results.length} result${resp.results.length === 1 ? '' : 's'} · ${total}ms` +
      (resp.queriedPeers ? ` · ${resp.answeredPeers}/${resp.queriedPeers} peers` : '');
    render(resp.results);
  }
}

// Incoming streaming updates from the mesh while a search is in flight.
api.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'search_partial' || msg.queryId !== currentQueryId) return false;
  const n = msg.results.length;
  metaDiv.textContent = msg.done
    ? `${n} result${n === 1 ? '' : 's'} · ${msg.answeredPeers}/${msg.queriedPeers} peers`
    : `${n} result${n === 1 ? '' : 's'} · streaming ${msg.answeredPeers}/${msg.queriedPeers} peers…`;
  render(msg.results);
  if (msg.done) currentQueryId = null;
  return false;
});

goBtn.addEventListener('click', run);
queryInput.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });

run();
