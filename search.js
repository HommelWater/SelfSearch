import { search, getRecent } from './core/search.js';
import { docCount } from './core/db.js';
import { browserApi } from './core/capture.js';

const api = browserApi();

const queryInput = document.getElementById('query');
const goBtn = document.getElementById('go');
const metaDiv = document.getElementById('meta');
const resultsDiv = document.getElementById('results');
const autoIndexCheckbox = document.getElementById('autoIndexCheckbox');

// Set while a network search is in flight; used to filter streaming partials.
let currentQueryId = null;

function fmtTime(ts) {
  return new Date(ts * 1000).toLocaleString();
}

function short(npub, n = 12) {
  return npub.length > n + 3 ? npub.slice(0, n) + '…' : npub;
}

// ----- Search tab (unchanged behaviour) -----

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
    a.addEventListener('click', () => {
      // Learn this query -> this result's keywords (query-key map).
      api.runtime.sendMessage({
        action: 'logResultClick',
        query: queryInput.value.trim(),
        keywords: [r.direct_keywords, r.related_keywords].filter(Boolean).join(' ')
      }).catch(() => {});
    });
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
    // Peer results live in the network's index — nothing for us to delete.
    if (r.source !== 'peer') right.appendChild(del);
    foot.appendChild(right);
    el.appendChild(foot);

    resultsDiv.appendChild(el);
  }
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

// Auto-index toggle (persisted; the background respects it for autoIndex).
async function loadAutoIndex() {
  try {
    const resp = await api.runtime.sendMessage({ action: 'getSettings' });
    if (resp && resp.success) autoIndexCheckbox.checked = resp.settings.autoIndex !== false;
  } catch { /* background may be unreachable yet */ }
}
autoIndexCheckbox.addEventListener('change', async () => {
  try {
    await api.runtime.sendMessage({ action: 'saveSettings', values: { autoIndex: autoIndexCheckbox.checked } });
  } catch { /* ignore */ }
});
loadAutoIndex();

// Support ?q= from the omnibox / external opens.
const urlQuery = new URLSearchParams(location.search).get('q');
if (urlQuery) {
  queryInput.value = urlQuery;
  run();
} else {
  run();
}

// ----- Tabs -----

const tabs = document.querySelectorAll('.tab');
tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    tabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    document.querySelectorAll('.tab-body').forEach(s => { s.style.display = 'none'; });
    const target = document.getElementById('tab-' + tab.dataset.tab);
    target.style.display = '';
    if (tab.dataset.tab === 'peers') loadPeers();
  });
});

// ----- Peers tab -----

async function p2p(op, extra = {}) {
  try {
    return await api.runtime.sendMessage({ p2p: true, op, ...extra });
  } catch {
    return null;
  }
}

const peerStatus = document.getElementById('peerStatus');
const npubDisplay = document.getElementById('npubDisplay');
const inviteInput = document.getElementById('inviteInput');
const inviteBtn = document.getElementById('inviteBtn');
const inviteMsg = document.getElementById('inviteMsg');
const invitesList = document.getElementById('invitesList');
const friendsList = document.getElementById('friendsList');
const peerFeed = document.getElementById('peerFeed');

function peerName(npub, profiles) {
  const p = profiles[npub];
  return p && p.name ? p.name : short(npub);
}

function peerHasName(npub, profiles) {
  const p = profiles[npub];
  return !!(p && p.name);
}

function renderInvites(invites, profiles) {
  invitesList.innerHTML = '';
  const pending = invites || [];
  if (!pending.length) {
    invitesList.textContent = 'No pending invites.';
    invitesList.style.cssText = 'font-size: 0.75rem; color: #2c3e2f; margin: 4px 0;';
    return;
  }
  for (const inv of pending) {
    const row = document.createElement('div');
    row.className = 'peer-card';
    const head = document.createElement('div');
    head.className = 'head';
    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.textContent = (profiles[inv.npub] && profiles[inv.npub].avatar) || '👤';
    head.appendChild(avatar);
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = inv.dir === 'in' ? peerName(inv.npub, profiles) : 'You';
    const small = document.createElement('small');
    small.textContent = inv.dir === 'in' ? ' wants to connect' : ' invited ' + short(inv.npub) + ' — waiting…';
    who.appendChild(small);
    head.appendChild(who);
    row.appendChild(head);
    if (inv.message) {
      const msg = document.createElement('div');
      msg.className = 'bio';
      msg.textContent = '“' + inv.message + '”';
      row.appendChild(msg);
    }
    if (inv.dir === 'in') {
      const btns = document.createElement('div');
      btns.className = 'server-row';
      const accept = document.createElement('button');
      accept.textContent = 'Accept';
      accept.addEventListener('click', async () => {
        await p2p('respondInvite', { npub: inv.npub, accept: true });
        loadPeers();
      });
      const decline = document.createElement('button');
      decline.className = 'secondary';
      decline.textContent = 'Decline';
      decline.addEventListener('click', async () => {
        await p2p('respondInvite', { npub: inv.npub, accept: false });
        loadPeers();
      });
      btns.appendChild(accept);
      btns.appendChild(decline);
      row.appendChild(btns);
    }
    invitesList.appendChild(row);
  }
}

function renderFriends(friends, connected, profiles) {
  friendsList.innerHTML = '';
  if (!friends.length) {
    friendsList.textContent = 'No friends yet — invite an npub to join the network.';
    friendsList.style.cssText = 'font-size: 0.75rem; color: #2c3e2f; margin: 4px 0;';
    return;
  }
  for (const f of friends) {
    const row = document.createElement('div');
    row.className = 'friend-row';

    const dot = document.createElement('span');
    dot.className = `dot${connected.includes(f) ? ' on' : ''}`;
    dot.title = connected.includes(f) ? 'connected' : 'not connected';
    row.appendChild(dot);

    const p = profiles[f] || {};
    const label = document.createElement('button');
    label.className = 'friend-link';
    const fsub = peerHasName(f, profiles) ? short(f) + ' · view index →' : 'view index →';
    const fa = document.createElement('span');
    fa.className = 'fa';
    fa.textContent = p.avatar || '👤';
    label.appendChild(fa);
    label.appendChild(document.createTextNode(' ' + peerName(f, profiles)));
    const fsubEl = document.createElement('span');
    fsubEl.className = 'fsub';
    fsubEl.textContent = fsub;
    label.appendChild(fsubEl);
    label.addEventListener('click', () => openPeerDetail(f, profiles, connected));
    row.appendChild(label);

    const rm = document.createElement('button');
    rm.className = 'secondary';
    rm.textContent = '✕';
    rm.title = 'Remove friend';
    rm.addEventListener('click', async () => {
      await p2p('removeFriend', { npub: f });
      loadPeers();
    });
    row.appendChild(rm);

    friendsList.appendChild(row);
  }
}

// ----- Friend detail: their entire (cached) index -----

const peersMain = document.getElementById('peersMain');
const peerDetail = document.getElementById('peerDetail');
const peerDetailContent = document.getElementById('peerDetailContent');
let currentPeerDetail = null;

function openPeerDetail(npub, profiles, connected) {
  currentPeerDetail = npub;
  peersMain.style.display = 'none';
  peerDetail.style.display = '';
  loadPeerDetail(npub, profiles, connected);
}

function closePeerDetail() {
  currentPeerDetail = null;
  peerDetail.style.display = 'none';
  peersMain.style.display = '';
  loadPeers();
}

document.getElementById('peerDetailBack').addEventListener('click', closePeerDetail);

async function loadPeerDetail(npub, profiles, connected) {
  const p = profiles[npub] || {};
  peerDetailContent.innerHTML = '<div class="empty">Loading…</div>';

  const resp = await p2p('getPeerDocs', { npub });
  const docs = (resp && resp.success) ? resp.docs : [];
  const isConnected = connected && connected.includes(npub);

  peerDetailContent.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'peer-card';
  const head = document.createElement('div');
  head.className = 'head';
  const avatar = document.createElement('span');
  avatar.className = 'avatar';
  avatar.textContent = p.avatar || '👤';
  head.appendChild(avatar);
  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = peerName(npub, profiles);
  head.appendChild(who);
  card.appendChild(head);
  if (p.bio) {
    const bio = document.createElement('div');
    bio.className = 'bio';
    bio.textContent = p.bio;
    card.appendChild(bio);
  }
  const npubLine = document.createElement('div');
  npubLine.className = 'bio';
  npubLine.textContent = npub;
  card.appendChild(npubLine);
  const meta = document.createElement('div');
  meta.className = 'bio';
  meta.textContent =
    `${isConnected ? '● connected' : '○ not connected'} · ` +
    `${docs.length} indexed page${docs.length === 1 ? '' : 's'} (cached)`;
  card.appendChild(meta);
  peerDetailContent.appendChild(card);

  if (!docs.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No pages cached from this peer yet — they appear as they backfill.';
    peerDetailContent.appendChild(empty);
    return;
  }

  for (const d of docs) {
    const el = document.createElement('div');
    el.className = 'result';
    const h = document.createElement('h3');
    const a = document.createElement('a');
    a.href = d.url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = d.title || d.url;
    h.appendChild(a);
    el.appendChild(h);
    const url = document.createElement('div');
    url.className = 'url';
    url.textContent = d.url;
    el.appendChild(url);
    if (d.description) {
      const desc = document.createElement('div');
      desc.className = 'desc';
      desc.textContent = d.description;
      el.appendChild(desc);
    }
    const foot = document.createElement('div');
    foot.className = 'foot';
    const ts = document.createElement('span');
    ts.textContent = fmtTime(d.timestamp);
    foot.appendChild(ts);
    el.appendChild(foot);
    peerDetailContent.appendChild(el);
  }
}

function renderPeerFeed(recentByPeer, profiles) {
  peerFeed.innerHTML = '';
  const authors = Object.entries(recentByPeer)
    .sort((a, b) => (b[1][0]?.timestamp || 0) - (a[1][0]?.timestamp || 0));

  if (!authors.length) {
    const div = document.createElement('div');
    div.className = 'empty';
    div.textContent = 'Nothing cached from peers yet. Add friends and search to build redundancy.';
    peerFeed.appendChild(div);
    return;
  }

  for (const [npub, docs] of authors) {
    const p = profiles[npub] || {};
    const card = document.createElement('div');
    card.className = 'peer-card';

    const head = document.createElement('div');
    head.className = 'head';
    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.textContent = p.avatar || '👤';
    head.appendChild(avatar);
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = peerName(npub, profiles);
    if (peerHasName(npub, profiles)) {
      const small = document.createElement('small');
      small.textContent = ' ' + short(npub);
      who.appendChild(small);
    }
    head.appendChild(who);
    card.appendChild(head);

    if (p.bio) {
      const bio = document.createElement('div');
      bio.className = 'bio';
      bio.textContent = p.bio;
      card.appendChild(bio);
    }

    for (const d of docs) {
      const doc = document.createElement('div');
      doc.className = 'doc';
      const a = document.createElement('a');
      a.href = d.url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = d.title || d.url;
      doc.appendChild(a);
      const url = document.createElement('div');
      url.className = 'durl';
      url.textContent = d.url;
      doc.appendChild(url);
      const ts = document.createElement('div');
      ts.className = 'dts';
      ts.textContent = fmtTime(d.timestamp);
      doc.appendChild(ts);
      card.appendChild(doc);
    }

    peerFeed.appendChild(card);
  }
}

async function loadPeers() {
  if (currentPeerDetail) return; // friend detail view is open; don't clobber it
  const resp = await p2p('getPeers');
  if (!resp || !resp.success) {
    peerStatus.textContent = `Peers: ${resp?.error || 'mesh not reachable'}`;
    peerStatus.className = 'status error';
    return;
  }
  const p = resp.peers;
  npubDisplay.value = p.npub || '';
  peerStatus.textContent =
    `Connected: ${p.connected.length} · Trusted network: ${p.reachable.length} · Cached: ${p.cachedDocs}`;
  peerStatus.className = 'status info';
  renderInvites(p.invites, p.profiles);
  renderFriends(p.friends, p.connected, p.profiles);
  renderPeerFeed(p.recentByPeer, p.profiles);
}

inviteBtn.addEventListener('click', async () => {
  const npub = inviteInput.value.trim().toLowerCase();
  if (!npub) return;
  inviteBtn.disabled = true;
  const resp = await api.runtime.sendMessage({ p2p: true, op: 'sendInvite', npub });
  inviteBtn.disabled = false;
  if (resp?.success) {
    inviteInput.value = '';
    showStatus(inviteMsg, 'Invite sent — they can accept it from their Peers page.', 'success');
    loadPeers();
  } else {
    showStatus(inviteMsg, `❌ ${resp?.error || 'Failed to send invite'}`, 'error');
  }
});
inviteInput.addEventListener('keydown', e => { if (e.key === 'Enter') inviteBtn.click(); });

setInterval(() => {
  const active = document.querySelector('.tab.active');
  if (active && active.dataset.tab === 'peers') loadPeers();
}, 5000);

// ----- Profile tab -----

const profileName = document.getElementById('profileName');
const profileAvatar = document.getElementById('profileAvatar');
const profileBio = document.getElementById('profileBio');
const saveProfileBtn = document.getElementById('saveProfileBtn');
const profileStatus = document.getElementById('profileStatus');

const identityNpub = document.getElementById('identityNpub');
const identityNsec = document.getElementById('identityNsec');
const identityNsecDisplay = document.getElementById('identityNsecDisplay');
const revealNsecBtn = document.getElementById('revealNsecBtn');
const copyNsecBtn = document.getElementById('copyNsecBtn');
const setIdentityBtn = document.getElementById('setIdentityBtn');
const syncDevicesCheckbox = document.getElementById('syncDevicesCheckbox');
const syncNowBtn = document.getElementById('syncNowBtn');
const syncStatus = document.getElementById('syncStatus');

let currentNsec = null;

function showStatus(el, message, type) {
  el.textContent = message;
  el.className = `status ${type}`;
}

async function loadProfile() {
  const resp = await p2p('getPeers');
  if (!resp?.success) return;
  const own = resp.peers.ownProfile || {};
  profileName.value = own.name || '';
  profileAvatar.value = own.avatar || '';
  profileBio.value = own.bio || '';
  identityNpub.value = resp.peers.npub || '';
  syncDevicesCheckbox.checked = !!resp.peers.syncDevices;
  renderSyncStatus(resp.peers);
}

function renderSyncStatus(peers) {
  const connected = peers.connected || [];
  const linked = connected.includes(peers.npub);
  syncStatus.textContent = peers.syncDevices
    ? (linked ? 'Device sync on — linked to your other devices.' : 'Device sync on — other devices will link when online.')
    : 'Device sync off.';
  syncStatus.className = linked ? 'status success' : 'status info';
}

revealNsecBtn.addEventListener('click', async () => {
  if (currentNsec) {
    identityNsecDisplay.type = identityNsecDisplay.type === 'password' ? 'text' : 'password';
    revealNsecBtn.textContent = identityNsecDisplay.type === 'password' ? 'Show' : 'Hide';
    return;
  }
  const resp = await p2p('getIdentity');
  if (resp?.success) {
    currentNsec = resp.nsec;
    identityNsecDisplay.value = resp.nsec;
    identityNsecDisplay.type = 'text';
    revealNsecBtn.textContent = 'Hide';
    showStatus(syncStatus, 'This nsec IS your identity — anyone with it can act as you.', 'error');
  } else {
    showStatus(syncStatus, `❌ ${resp?.error || 'Failed to load identity'}`, 'error');
  }
});

copyNsecBtn.addEventListener('click', async () => {
  if (!currentNsec) await revealNsecBtn.click();
  if (!currentNsec) return;
  try {
    await navigator.clipboard.writeText(currentNsec);
    showStatus(syncStatus, 'nsec copied to clipboard.', 'success');
  } catch {
    identityNsecDisplay.select();
    document.execCommand('copy');
    showStatus(syncStatus, 'nsec copied to clipboard.', 'success');
  }
});

saveProfileBtn.addEventListener('click', async () => {
  const resp = await p2p('setProfile', {
    name: profileName.value.trim(),
    avatar: profileAvatar.value.trim(),
    bio: profileBio.value.trim()
  });
  if (resp?.success) {
    showStatus(profileStatus, 'Profile saved — shared with peers.', 'success');
  } else {
    showStatus(profileStatus, `❌ ${resp?.error || 'Failed to save'}`, 'error');
  }
});

setIdentityBtn.addEventListener('click', async () => {
  const nsec = identityNsec.value.trim();
  if (!nsec) return;
  setIdentityBtn.disabled = true;
  const resp = await p2p('setIdentity', { nsec });
  setIdentityBtn.disabled = false;
  if (resp?.success) {
    identityNsec.value = '';
    showStatus(syncStatus, 'Identity set — syncing with your devices.', 'success');
    loadProfile();
  } else {
    showStatus(syncStatus, `❌ ${resp?.error || 'Failed to set identity'}`, 'error');
  }
});

syncDevicesCheckbox.addEventListener('change', async () => {
  const resp = await p2p('setSyncDevices', { enabled: syncDevicesCheckbox.checked });
  if (resp?.success) loadProfile();
});

syncNowBtn.addEventListener('click', async () => {
  const resp = await p2p('getPeers');
  const peers = resp && resp.success ? resp.peers : {};
  renderSyncStatus(peers);
  showStatus(syncStatus, 'Syncing…', 'info');
  await p2p('reconcileDocs');
  const after = await p2p('getPeers');
  renderSyncStatus(after && after.success ? after.peers : {});
});

loadProfile();
