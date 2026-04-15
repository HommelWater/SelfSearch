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

    // Create modal container
    const modal = document.createElement('div');
    modal.id = 'ext-add-site-modal';
    modal.style.cssText = `
      position: fixed; top:0; left:0; width:100%; height:100%;
      background:rgba(0,0,0,0.6); z-index:100000;
      display:flex; align-items:center; justify-content:center;
      font-family:system-ui, sans-serif;
    `;

    // Create box
    const box = document.createElement('div');
    box.style.cssText = `
      background:#CADCAE; padding:20px; min-width:320px;
      box-shadow:0 4px 12px rgba(0,0,0,0.3); color:black;
      border: 1px solid #222;
    `;

    // Create heading with border-left style
    const heading = document.createElement('h3');
    heading.style.cssText = 'margin:0 0 12px 0; border-left:3px solid #EDA35A; padding-left:8px;';
    heading.textContent = '➕ Add this search server?';
    box.appendChild(heading);

    // Server URL paragraph
    const urlPara = document.createElement('p');
    urlPara.style.marginBottom = '8px';
    urlPara.innerHTML = '<strong>Server URL:</strong><br>'; // Static HTML is OK
    const urlText = document.createTextNode(serverOrigin);
    urlPara.appendChild(urlText);
    box.appendChild(urlPara);

    // Description paragraph
    const descPara = document.createElement('p');
    descPara.style.cssText = 'margin-bottom:12px; font-size:0.85rem;';
    descPara.textContent = 'The extension will use this server to index pages.';
    box.appendChild(descPara);

    // Button container
    const btnDiv = document.createElement('div');
    btnDiv.style.cssText = 'display:flex; gap:8px; margin-top:16px;';

    // Add Server button
    const yesBtn = document.createElement('button');
    yesBtn.id = 'ext-yes-btn';
    yesBtn.style.cssText = 'flex:1; background:#EDA35A; border:none; padding:8px; cursor:pointer;';
    yesBtn.textContent = 'Add Server';
    btnDiv.appendChild(yesBtn);

    // Never button
    const noBtn = document.createElement('button');
    noBtn.id = 'ext-no-btn';
    noBtn.style.cssText = 'flex:1; background:#E1E9C9; border:none; padding:8px; cursor:pointer;';
    noBtn.textContent = 'Never for this site';
    btnDiv.appendChild(noBtn);

    box.appendChild(btnDiv);
    modal.appendChild(box);
    document.body.appendChild(modal);

    // Event handlers (same logic, just use the variables directly)
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