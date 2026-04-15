(async function() {
  async function getDeclinedOrigins() {
    const result = await browser.storage.local.get('declinedOrigins');
    return result.declinedOrigins || [];
  }

  async function addDeclinedOrigin(origin) {
    const declined = await getDeclinedOrigins();
    if (!declined.includes(origin)) {
      declined.push(origin);
      await browser.storage.local.set({ declinedOrigins: declined });
    }
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    if (event.data?.type === 'CHECK_EXTENSION_USER') {
      const urlObj = new URL(window.location.href);
      const serverUrl = urlObj.origin + urlObj.pathname;
      if (!serverUrl) return;

      const declined = await getDeclinedOrigins();
      if (declined.includes(serverUrl)) return;

      // Get token from page's localStorage (the server sets it)
      const pageToken = localStorage.getItem('session') || null;

      // Check if we already have this server saved
      const response = await browser.runtime.sendMessage({
        action: 'checkOrigin',
        url: serverUrl
      });

      if (!response?.success) return;

      if (!response.token) {
        // Server not saved – show add prompt
        showPrompt(serverUrl, pageToken);
      } else if (response.token !== pageToken && pageToken) {
        // Token changed – update silently without prompt
        await browser.runtime.sendMessage({
          action: 'addServer',
          url: serverUrl,
          token: pageToken
        });
      }
    }
  });

  function showPrompt(serverOrigin, token) {
    // Remove existing modal if any
    const existing = document.getElementById('ext-add-site-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'ext-add-site-modal';
    modal.style.cssText = `
      position: fixed; top:0; left:0; width:100%; height:100%;
      background:rgba(0,0,0,0.6); z-index:100000;
      display:flex; align-items:center; justify-content:center;
      font-family:system-ui, sans-serif;
    `;
    const box = document.createElement('div');
    box.style.cssText = `
      background:#CADCAE; padding:20px; min-width:320px;
      box-shadow:0 4px 12px rgba(0,0,0,0.3); color:black;
      border: 1px solid #222;
    `;
    box.innerHTML = `
      <h3 style="margin:0 0 12px 0; border-left:3px solid #EDA35A; padding-left:8px;">➕ Add this search server?</h3>
      <p style="margin-bottom:8px;"><strong>Server URL:</strong><br>${escapeHtml(serverOrigin)}</p>
      <p style="margin-bottom:12px; font-size:0.85rem;">The extension will use this server to index pages.</p>
      <div style="display:flex; gap:8px; margin-top:16px;">
        <button id="ext-yes-btn" style="flex:1; background:#EDA35A; border:none; padding:8px; cursor:pointer;">Add Server</button>
        <button id="ext-no-btn" style="flex:1; background:#E1E9C9; border:none; padding:8px; cursor:pointer;">Never for this site</button>
      </div>
    `;
    modal.appendChild(box);
    document.body.appendChild(modal);

    const yesBtn = box.querySelector('#ext-yes-btn');
    const noBtn = box.querySelector('#ext-no-btn');

    yesBtn.onclick = async () => {
      await browser.runtime.sendMessage({
        action: 'addServer',
        url: serverOrigin,
        token: token || ''
      });
      modal.remove();
      showNotification(`✅ Server "${serverOrigin}" added!`);
    };
    noBtn.onclick = async () => {
      await addDeclinedOrigin(serverOrigin);
      modal.remove();
    };
  }

  function showNotification(msg) {
    const div = document.createElement('div');
    div.textContent = msg;
    div.style.cssText = `
      position:fixed; bottom:20px; right:20px; background:#EDA35A;
      color:black; padding:8px 16px; z-index:100001;
      font-family:system-ui; font-size:14px; box-shadow:0 2px 6px rgba(0,0,0,0.2);
    `;
    document.body.appendChild(div);
    setTimeout(() => div.remove(), 3000);
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>]/g, function(m) {
      if (m === '&') return '&amp;';
      if (m === '<') return '&lt;';
      if (m === '>') return '&gt;';
      return m;
    });
  }
})();