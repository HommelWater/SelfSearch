// Auto-index pages after the user visits them: when the page finishes loading,
// read its text and ask the background to index it. Repeated visits to the same
// URL accumulate capture samples, so only keywords stable across reloads stick.
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

function capture() {
  let page;
  try {
    page = readPageInfo();
  } catch (err) {
    return;
  }
  if (!shouldAutoIndex(page)) return;
  api.runtime.sendMessage({ action: 'autoIndex', page }).catch(() => {});
}

if (document.readyState === 'complete') capture();
else window.addEventListener('load', capture, { once: true });
