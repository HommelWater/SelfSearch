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
  indexBtn.disabled = true;
  indexBtn.textContent = 'Indexing...';
  showStatus(indexStatusDiv, 'Sending to server...', 'info');
  const response = await browser.runtime.sendMessage({ action: 'indexPage' });
  indexBtn.disabled = false;
  indexBtn.textContent = '📸 INDEX THIS PAGE';
  console.log(response)
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