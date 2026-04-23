console.log('Background script loaded');
const api = typeof browser !== 'undefined' ? browser : chrome;
console.log('Using API:', api === browser ? 'browser' : 'chrome');

// Storage keys
const STORAGE_SERVERS = 'bombus_servers';     // { "https://server1.com": "token1", ... }
const STORAGE_SELECTED = 'bombus_selected';   // string (server URL)

// ----- Server management -----
async function getServers() {
  const result = await api.storage.local.get(STORAGE_SERVERS);
  return result[STORAGE_SERVERS] || {};
}

async function saveServers(servers) {
  await api.storage.local.set({ [STORAGE_SERVERS]: servers });
}

async function addServer(url, token) {
  const origin = new URL(url).origin;
  const granted = await browser.permissions.request({
    origins: [`${origin}/*`]
  });
  if (!granted) {
    throw new Error('User denied host permission');
  }
  const servers = await getServers();
  servers[url] = token;
  await saveServers(servers);
  return true;
}

async function getServerToken(url) {
  const servers = await getServers();
  return servers[url] || null;
}

async function removeServer(url) {
  const servers = await getServers();
  delete servers[url];
  await saveServers(servers);
  // If removed server was selected, clear selection
  const selected = await getSelectedServer();
  if (selected === url) {
    await setSelectedServer(null);
  }
}

async function getSelectedServer() {
  const result = await api.storage.local.get(STORAGE_SELECTED);
  return result[STORAGE_SELECTED] || null;
}

async function setSelectedServer(url) {
  await api.storage.local.set({ [STORAGE_SELECTED]: url });
}

// ----- Indexing -----
async function indexCurrentPage(apiUrl, tab, stored=false) {
  if (!apiUrl) throw new Error('No server selected. Please select a server in the popup.');

  const sessionToken = await getServerToken(apiUrl);
  if (!sessionToken) throw new Error(`No session token found for ${apiUrl}. Please re-add the server.`);

  // Capture as blob instead of dataURL
  const dataUrl = await api.tabs.captureVisibleTab(tab.windowId, { 
    format: 'jpeg', 
    quality: 80 
  });
  
  // Convert dataURL to Blob
  const response = await fetch(dataUrl);
  const blob = await response.blob();

  // Create FormData
  const formData = new FormData();
  formData.append('session_token', sessionToken);
  formData.append('url', tab.url);
  formData.append('title', tab.title);
  formData.append('filename', 'screenshot.jpg');
  formData.append('stored', stored);
  formData.append('image', blob, 'screenshot.jpg');

  const fetchResponse = await fetch(`${apiUrl}/index`, {
    method: 'POST',
    body: formData // No Content-Type header needed - browser sets it with boundary
  });

  if (!fetchResponse.ok) {
    const errorText = await fetchResponse.text();
    throw new Error(`Indexing failed: ${fetchResponse.status} - ${errorText}`);
  }

  return await fetchResponse.json();
}

// ----- Message handling -----
api.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const handleAsync = async () => {
    try {
      switch (request.action) {
        case 'getServers':
          return { success: true, servers: await getServers() };
        case 'getSelectedServer':
          return { success: true, selected: await getSelectedServer() };
        case 'setSelectedServer':
          await setSelectedServer(request.url);
          return { success: true };
        case 'addServer':
          await addServer(request.url, request.token);
          return { success: true };
        case 'removeServer':
          await removeServer(request.url);
          return { success: true };
        case 'indexPage': {
          const selected = await getSelectedServer();
          if (!selected) throw new Error('No server selected');
          const data = await indexCurrentPage(selected, request.tab, request.stored);
          data["success"] = true;
          return data;
        }
        case 'checkOrigin': {
          const token = await getServerToken(request.url);
          return { success: true, token };
        }
        default:
          return { success: false, error: 'Unknown action' };
      }
    } catch (err) {
      console.error(`Error in action ${request.action}:`, err);
      return { success: false, error: err.message };
    }
  };

  handleAsync().then(sendResponse);
  return true; // indicates async response
});