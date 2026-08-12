import { browserApi } from './core/capture.js';

const api = browserApi();

const indexBtn = document.getElementById('indexBtn');
const keywordsInput = document.getElementById('keywordsInput');
const indexStatus = document.getElementById('indexStatus');
const openSearchBtn = document.getElementById('openSearchBtn');

const meshStatusDiv = document.getElementById('meshStatus');
const npubDisplay = document.getElementById('npubDisplay');
const maxHopsInput = document.getElementById('maxHopsInput');
const friendInput = document.getElementById('friendInput');
const addFriendBtn = document.getElementById('addFriendBtn');
const friendsList = document.getElementById('friendsList');

function showStatus(el, message, type) {
  el.textContent = message;
  el.className = `status ${type}`;
}

function short(npub, n = 16) {
  return npub.length > n + 3 ? npub.slice(0, n) + '…' : npub;
}

async function loadSettings() {
  const resp = await api.runtime.sendMessage({ action: 'getSettings' });
  if (!resp?.success) return;
}

indexBtn.addEventListener('click', async () => {
  indexBtn.disabled = true;
  indexBtn.textContent = 'Indexing...';
  showStatus(indexStatus, 'Extracting keywords...', 'info');
  try {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    const resp = await api.runtime.sendMessage({
      action: 'capture',
      tab,
      keywords: keywordsInput.value.trim()
    });
    if (!resp?.success) throw new Error(resp?.error || 'Failed to index');
    showStatus(indexStatus, `✅ Indexed: ${resp.doc.title}`, 'success');
    keywordsInput.value = '';
  } catch (err) {
    showStatus(indexStatus, `❌ ${err.message}`, 'error');
  } finally {
    indexBtn.disabled = false;
    indexBtn.textContent = '📸 INDEX THIS PAGE';
  }
});

openSearchBtn.addEventListener('click', () => {
  api.tabs.create({ url: api.runtime.getURL('search.html') });
});

// ----- P2P mesh -----

async function p2p(op, extra = {}) {
  try {
    return await api.runtime.sendMessage({ p2p: true, op, ...extra });
  } catch {
    return null;
  }
}

function renderFriends(friends, connected) {
  friendsList.innerHTML = '';
  if (!friends.length) {
    friendsList.textContent = 'No friends yet — add an npub to join the network.';
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

    const label = document.createElement('span');
    label.className = 'f-npub';
    label.textContent = short(f);
    label.title = f;
    row.appendChild(label);

    const rm = document.createElement('button');
    rm.textContent = '✕';
    rm.title = 'Remove friend';
    rm.addEventListener('click', async () => {
      await p2p('removeFriend', { npub: f });
      meshStatus();
    });
    row.appendChild(rm);

    friendsList.appendChild(row);
  }
}

async function meshStatus() {
  const resp = await p2p('status');
  if (!resp || !resp.success) {
    const why = resp?.error || 'no response — mesh host not reachable';
    showStatus(meshStatusDiv, `Mesh: ${why}`, 'error');
    return;
  }
  const s = resp.status;
  npubDisplay.value = s.npub || '';
  maxHopsInput.value = s.maxHops || 2;
  const relayEntries = Object.entries(s.relays || {});
  const relaysUp = relayEntries.filter(([, up]) => up).length;
  const relayText = relayEntries.length ? ` · Relays: ${relaysUp}/${relayEntries.length}` : '';
  showStatus(
    meshStatusDiv,
    `Connected: ${s.connected.length} · Trusted network: ${s.reachable.length} · Filters: ${s.peerFilterCount}${relayText}`,
    'info'
  );
  renderFriends(s.friends, s.connected);
}

maxHopsInput.addEventListener('change', async () => {
  await p2p('setMaxHops', { maxHops: maxHopsInput.value });
  meshStatus();
});

addFriendBtn.addEventListener('click', async () => {
  const npub = friendInput.value.trim().toLowerCase();
  if (!npub) return;
  addFriendBtn.disabled = true;
  const resp = await api.runtime.sendMessage({ p2p: true, op: 'addFriend', npub });
  addFriendBtn.disabled = false;
  if (resp?.success) {
    friendInput.value = '';
    meshStatus();
  } else {
    showStatus(meshStatusDiv, `❌ ${resp?.error || 'Failed to add friend'}`, 'error');
  }
});

friendInput.addEventListener('keydown', e => { if (e.key === 'Enter') addFriendBtn.click(); });

loadSettings();
meshStatus();
setInterval(meshStatus, 3000);
