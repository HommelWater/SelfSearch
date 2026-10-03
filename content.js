// Auto-index pages after the user visits them: capture a page's text when it
// finishes loading AND whenever its URL changes without a reload (single-page
// apps), then ask the background to index it. Repeated captures of the same
// URL accumulate samples, so only keywords stable across visits stick.
//
// This is a classic (non-module) content script — the helpers it needs are
// inlined here rather than imported, because module content scripts are not
// supported in every browser. Keep them in sync with core/capture.js.

function readPageInfo() {
  const meta = (name) => {
    const el = document.querySelector(`meta[name="${name}"]`);
    return el && el.content ? el.content.trim() : '';
  };
  const bodyText = (document.body && document.body.innerText) || '';
  return {
    title: document.title || '',
    url: location.href || '',
    metaDescription: meta('description'),
    metaKeywords: meta('keywords'),
    bodyText: bodyText.slice(0, 100000)
  };
}

function shouldAutoIndex(page) {
  return /^https?:\/\//.test(String(page.url || '')) &&
    String(page.bodyText || '').trim().length >= 200;
}

const api = typeof browser !== 'undefined' ? browser : chrome;

let lastCaptured = '';
let lastSeenUrl = location.href;
let settleTimer = null;
let retryTimer = null;
let pollTimer = null;
let dead = false; // extension reloaded/updated: this page's messaging context is gone

// The extension context is gone (extension reloaded/updated while this tab
// stayed open): stop every timer so this zombie script does nothing more.
function markDead() {
  if (dead) return;
  dead = true;
  if (pollTimer) clearInterval(pollTimer);
  if (settleTimer) clearTimeout(settleTimer);
  if (retryTimer) clearTimeout(retryTimer);
}

function send(page) {
  if (dead) return;
  lastCaptured = page.url;
  try {
    // `chrome.runtime.id` is undefined once the context is invalidated; check
    // it first so we never call into a dead context.
    if (!api.runtime || !api.runtime.id) {
      markDead();
      return;
    }
    api.runtime.sendMessage({ action: 'autoIndex', page }).catch(() => markDead());
  } catch {
    // chrome.runtime throws synchronously ("Extension context invalidated")
    // after the extension is reloaded/updated while this tab stayed open. The
    // fresh content script will take over on the next page load.
    markDead();
  }
}

function capture() {
  if (dead) return;
  let page;
  try {
    page = readPageInfo();
  } catch (err) {
    return;
  }
  if (!page.url || page.url === lastCaptured) return;
  if (String(page.bodyText || '').trim().length < 200) {
    // SPA content may still be rendering — try once more shortly after.
    if (!retryTimer && location.href === page.url) {
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (location.href === page.url) capture();
      }, 2000);
    }
    return;
  }
  send(page);
}

// URL changed without a full reload (SPA navigation): debounce so the app has
// a moment to render its new view before we read the DOM.
function onUrlChange() {
  lastSeenUrl = location.href;
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    settleTimer = null;
    capture();
  }, 800);
}

// Full page loads (initial load + hard navigations).
if (document.readyState === 'complete') capture();
else window.addEventListener('load', capture, { once: true });

// SPA navigations: history.pushState/replaceState fire no event, so wrap them;
// back/forward and hash changes fire popstate/hashchange. Some apps (e.g.
// Discord) cache a reference to the native pushState at startup, so the wrap
// is missed — the polling fallback below catches any URL change regardless of
// how the app navigated.
const hist = history.pushState;
history.pushState = function (...args) {
  hist.apply(this, args);
  onUrlChange();
};
const histReplace = history.replaceState;
history.replaceState = function (...args) {
  histReplace.apply(this, args);
  onUrlChange();
};
window.addEventListener('popstate', onUrlChange);
window.addEventListener('hashchange', onUrlChange);

// Fallback: detect URL changes we couldn't hook, plus a fast check when the
// tab becomes visible again (navigation may have happened in the background).
pollTimer = setInterval(() => {
  if (dead) return;
  if (location.href !== lastSeenUrl) onUrlChange();
}, 1000);
document.addEventListener('visibilitychange', () => {
  if (dead) return;
  if (document.visibilityState === 'visible' && location.href !== lastSeenUrl) onUrlChange();
});
