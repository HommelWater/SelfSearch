// DOM elements
const serverSelect = document.getElementById('serverSelect');
const removeBtn = document.getElementById('removeServerBtn');
const indexBtn = document.getElementById('indexBtn');
const indexStatusDiv = document.getElementById('indexStatus');
const addStatusDiv = document.getElementById('addStatus');

// Helper to show status
function showStatus(element, message, type) {
  element.innerHTML = '';
  const div = document.createElement('div');
  div.className = `status ${type}`;
  div.textContent = message;
  element.appendChild(div);
  setTimeout(() => {
    if (element.firstChild === div) element.removeChild(div);
  }, 4000);
}

async function detectSelfSearchServer() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab) return null;

  // Function to inject (same logic)
  const detectFunc = () => {
    return {
      is_selfsearch_server: localStorage.getItem('SELFSEARCH_SERVER') || false,
      sessionToken: localStorage.getItem('session') || null,
      origin: window.location.origin,
      url: window.location.href
    };
  };

  let result;
  // Use the appropriate API
  if (browser.scripting && browser.scripting.executeScript) {
    // Chrome MV3
    const results = await browser.scripting.executeScript({
      target: { tabId: tab.id },
      func: detectFunc
    });
    result = results[0]?.result;
  } else if (browser.tabs.executeScript) {
    // Firefox (and fallback)
    const results = await browser.tabs.executeScript(tab.id, {
      code: `(${detectFunc.toString()})();`
    });
    result = results[0];
  } else {
    console.error('No scripting API available');
  }
  if (result && result.is_selfsearch_server && result.sessionToken) {
    return {
      is_selfsearch_server: result.is_selfsearch_server,
      token: result.sessionToken,
      serverOrigin: result.url
    };
  }
  return null;
}

  async function getProcessedOrigins() {
    const result = await browser.storage.local.get('declinedOrigins');
    return result.declinedOrigins || [];
  }

  async function addProcessedOrigin(origin) {
    const declined = await getProcessedOrigins();
    if (!declined.includes(origin)) {
      declined.push(origin);
      await browser.storage.local.set({ declinedOrigins: declined });
    }
  }


async function showPrompt() {
  
  const d = await detectSelfSearchServer();
  if (!d) return;
  const {is_selfsearch_server, token, serverOrigin} = d;
  if (!is_selfsearch_server) return;

  const declined = await getProcessedOrigins();
  if (declined.includes(serverOrigin)) return;
  
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
    showStatus(indexStatusDiv, `Server "${serverOrigin}" added!`, 'success');
    await addProcessedOrigin(serverOrigin);
  };

  noBtn.onclick = async () => {
    await addProcessedOrigin(serverOrigin);
    modal.remove();
  };
}

// Load servers and populate dropdown
async function loadServers() {
  const response = await browser.runtime.sendMessage({ action: 'getServers' });
  if (!response.success) return;
  const servers = response.servers;
  const selectedResp = await browser.runtime.sendMessage({ action: 'getSelectedServer' });
  const selectedUrl = selectedResp.success ? selectedResp.selected : null;

  // Clear dropdown
  serverSelect.innerHTML = '';
  const urls = Object.keys(servers);
  if (urls.length === 0) {
    const option = document.createElement('option');
    option.textContent = '— No servers —';
    option.disabled = true;
    serverSelect.appendChild(option);
    indexBtn.disabled = true;
    removeBtn.disabled = true;
    return;
  }

  indexBtn.disabled = false;
  removeBtn.disabled = false;

  for (const url of urls) {
    const option = document.createElement('option');
    option.value = url;
    option.textContent = url;
    if (selectedUrl === url) option.selected = true;
    serverSelect.appendChild(option);
  }

  // If no selected but we have servers, select first and save
  if (!selectedUrl && urls.length > 0) {
    await browser.runtime.sendMessage({ action: 'setSelectedServer', url: urls[0] });
  }
}

// Remove selected server
removeBtn.addEventListener('click', async () => {
  const selected = serverSelect.value;
  if (!selected) return;
  const response = await browser.runtime.sendMessage({ action: 'removeServer', url: selected });
  if (response.success) {
    showStatus(indexStatusDiv, `Removed ${selected}`, 'success');
    await loadServers();
  } else {
    showStatus(indexStatusDiv, `Failed to remove: ${response.error}`, 'error');
  }
});

// Change selected server
serverSelect.addEventListener('change', async () => {
  const url = serverSelect.value;
  if (url && url !== '— No servers —') {
    await browser.runtime.sendMessage({ action: 'setSelectedServer', url });
  }
});

// Index current page
indexBtn.addEventListener('click', async () => {
  const storeImage = document.getElementById('storeImageCheckbox').checked;
  indexBtn.disabled = true;
  indexBtn.textContent = 'Indexing...';
  showStatus(indexStatusDiv, 'Sending to server...', 'info');
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const response = await browser.runtime.sendMessage({ action: 'indexPage', tab:tab, stored:storeImage });
  indexBtn.disabled = false;
  indexBtn.textContent = '📸 INDEX THIS PAGE';
  if (response.type === "failure") {
    showStatus(indexStatusDiv, `❌ Error: ${response.data.notification}`, 'error');
  } else if (!response.success){
    showStatus(indexStatusDiv, `❌ Error: ${response.error}`, 'error');
  } else{
    showStatus(indexStatusDiv, '✅ Page indexed successfully!', 'success');
  }
});

// Initial load
loadServers();
showPrompt();