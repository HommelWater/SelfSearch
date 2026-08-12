import { captureAndIndex, browserApi } from './core/capture.js';
import { settings } from './core/db.js';
import { search, getRecent, deleteDoc } from './core/search.js';
import { startMesh, handleMeshRequest, syncMesh } from './core/mesh.js';

const api = browserApi();

// Chrome: the service worker can't run WebRTC, so the mesh lives in an
// offscreen document. Firefox: no offscreen API — run the mesh right here in
// the persistent background page.
function hasOffscreenApi() {
  try {
    return typeof chrome !== 'undefined' &&
      chrome.offscreen !== undefined &&
      typeof chrome.offscreen.createDocument === 'function';
  } catch {
    return false;
  }
}

const IS_CHROME_SW = hasOffscreenApi() && !location.href.includes('offscreen.html');

// Ensure the offscreen mesh host exists. Returns 'exists' | 'created' | 'failed'.
// Note: offscreen reason enum values are UPPERCASE ("WEB_RTC", "LOCAL_STORAGE").
async function ensureOffscreen() {
  if (!hasOffscreenApi()) return 'failed';
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL('offscreen.html')]
    });
    if (contexts.length) return 'exists';
  } catch { /* older Chrome without getContexts: fall through to create */ }
  for (const reason of ['WEB_RTC', 'LOCAL_STORAGE']) {
    try {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: [reason],
        justification: 'SelfSearch hosts its peer-to-peer WebRTC mesh in an offscreen document.'
      });
      return 'created';
    } catch (e) {
      if (String(e && e.message).includes('already exists')) return 'exists';
      console.warn(`Failed to create offscreen document (${reason})`, e);
    }
  }
  return 'failed';
}

if (IS_CHROME_SW) {
  ensureOffscreen();
} else {
  startMesh().catch(err => console.warn('[bg] mesh start failed', err));
}

// Firefox MV3 background pages are event pages that suspend when idle, which
// would drop the mesh. An alarm wakes the page periodically so the mesh stays
// maintained and reconnects. (Chrome's mesh lives in the persistent offscreen
// document, which never suspends, so no alarm is needed there.)
function setupKeepalive() {
  let hasAlarms = false;
  try { hasAlarms = !!(api.alarms && api.alarms.create); } catch { /* no alarms */ }
  if (!hasAlarms || IS_CHROME_SW) return;
  api.alarms.create('mesh-sync', { periodInMinutes: 0.5 });
  api.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'mesh-sync') syncMesh();
  });
}
setupKeepalive();

// ---- Chrome: port router to the offscreen mesh host ----
let meshPort = null;
const meshPending = new Map();
let meshSeq = 0;

api.runtime.onConnect.addListener((port) => {
  if (port.name !== 'mesh') return;
  meshPort = port;
  port.onMessage.addListener((msg) => {
    if (msg && msg.id != null && 'response' in msg) {
      const cb = meshPending.get(msg.id);
      if (cb) {
        meshPending.delete(msg.id);
        cb(msg.response);
      }
    }
  });
  port.onDisconnect.addListener(() => {
    if (meshPort === port) meshPort = null;
  });
});

function forwardToMesh(request, sendResponse) {
  const attempt = (n) => {
    if (meshPort) {
      const id = ++meshSeq;
      const timeout = setTimeout(() => {
        if (meshPending.has(id)) {
          meshPending.delete(id);
          sendResponse({ success: false, error: 'Mesh host not responding' });
        }
      }, 5000);
      meshPending.set(id, (resp) => {
        clearTimeout(timeout);
        sendResponse(resp);
      });
      try {
        meshPort.postMessage({ id, request });
      } catch {
        clearTimeout(timeout);
        meshPending.delete(id);
        attempt(n + 1);
      }
    } else if (n < 5) {
      setTimeout(() => attempt(n + 1), 400);
    } else {
      sendResponse({ success: false, error: 'Mesh host not connected yet' });
    }
  };
  attempt(0);
}

// ----- Non-p2p message handling (search, recent, settings) -----
async function handle(request) {
  switch (request.action) {
    case 'search':
      return { success: true, results: await search(request.query, { limit: request.limit }) };

    case 'recent':
      return { success: true, results: await getRecent(request.limit) };

    case 'deleteDoc': {
      const { removed, wasOwned } = await deleteDoc(request.url);
      // Publishing a tombstone propagates the delete to peers' caches. It only
      // matters for docs we own; the mesh drops cached copies + rebuilds its
      // filter in both cases.
      const req = { p2p: true, op: wasOwned ? 'publishTombstone' : 'refreshCache', url: request.url };
      if (!IS_CHROME_SW) {
        handleMeshRequest(req).catch(() => {});
      } else {
        api.runtime.sendMessage(req).catch(() => {});
      }
      return { success: true, deleted: removed };
    }

    case 'getSettings':
      return { success: true, settings: await settings.all() };

    case 'saveSettings':
      for (const [k, v] of Object.entries(request.values)) {
        await settings.set(k, v);
      }
      return { success: true };

    default:
      return { success: false, error: 'Unknown action' };
  }
}

api.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request && request.type === 'search_partial') return false; // streaming broadcast, handled by the search page
  if (request && request.p2p) {
    if (!IS_CHROME_SW) {
      // Firefox: we host the mesh right here.
      handleMeshRequest(request)
        .then(sendResponse)
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }
    // Chrome: the mesh lives in the offscreen document — ensure it exists and
    // forward the request over the port.
    ensureOffscreen().then(() => forwardToMesh(request, sendResponse));
    return true;
  }

  handle(request)
    .then(sendResponse)
    .catch(err => sendResponse({ success: false, error: err.message }));
  return true;
});

// ----- Icon click = index this page (one click, no popup) -----
function flashBadge(text, color) {
  try {
    api.action.setBadgeBackgroundColor({ color: color || '#2e7d32' });
    api.action.setBadgeText({ text });
    setTimeout(() => api.action.setBadgeText({ text: '' }), 2000);
  } catch { /* ignore */ }
}

api.action.onClicked.addListener(async (tab) => {
  try {
    await api.action.setBadgeText({ text: '…' });
    await captureAndIndex(tab);
    flashBadge('✓');
  } catch (err) {
    console.warn('[index] failed', err);
    flashBadge('✗', '#c62828');
  }
});

// ----- Open search (omnibox, keyboard, first run) -----
function openSearch(query) {
  const url = api.runtime.getURL(`search.html${query ? `?q=${encodeURIComponent(query)}` : ''}`);
  api.tabs.create({ url });
}

try {
  api.commands.onCommand.addListener((name) => {
    if (name === 'open-search') openSearch();
  });
} catch { /* commands unsupported */ }

try {
  api.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') openSearch();
  });
} catch { /* ignore */ }

// ----- Omnibox ("ss <query>") -----
try {
  api.omnibox.onInputChanged.addListener(async (text, suggest) => {
    const q = (text || '').trim();
    if (!q) { suggest([]); return; }
    const results = await search(q, { limit: 5 });
    suggest(results.map(r => ({
      content: q,
      description: `${r.title} — ${r.url}`
    })));
  });
  api.omnibox.onInputEntered.addListener((text) => openSearch(text.trim()));
} catch (e) {
  console.warn('omnibox unavailable', e);
}

console.log('SelfSearch background loaded');
