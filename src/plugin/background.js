console.log('Background script loaded');
const api = typeof browser !== 'undefined' ? browser : chrome;
console.log('Using API:', api === browser ? 'browser' : 'chrome');
console.log('contextMenus available:', !!api.contextMenus);
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

api.contextMenus.create({
  id: "index-image",
  title: "Index image to Bombus",
  contexts: ["image"]
});

api.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.id !== "index-image") return;
  
  let blob;
  let filename;
  
  // Try 1: Get from content script (already loaded in page)
  try {
    const response = await api.tabs.sendMessage(tab.id, {
      action: 'getImageBlob',
      srcUrl: info.srcUrl
    });
    
    if (response.success) {
      blob = new Blob([response.data], { type: response.type });
      filename = response.filename || extractFilename(info.srcUrl);
    }
  } catch (e) {
    console.log('Content script failed, trying fetch:', e);
  }
  
  // Try 2: Fetch directly (may fail due to CORS/auth)
  if (!blob) {
    try {
      const fetchResponse = await fetch(info.srcUrl, {
        credentials: 'include' // Send cookies if needed
      });
      if (!fetchResponse.ok) throw new Error(`HTTP ${fetchResponse.status}`);
      blob = await fetchResponse.blob();
      filename = extractFilename(info.srcUrl);
    } catch (e) {
      console.error('Both methods failed:', e);
      // Notify user
      api.notifications.create({
        type: 'basic',
        title: 'Bombus Search',
        message: 'Could not access image. It may require authentication or be blocked by CORS.'
      });
      return;
    }
  }
  
  await uploadBlob(blob, filename, info.srcUrl, tab);
});

function extractFilename(url) {
  try {
    return new URL(url).pathname.split('/').pop() || 'image.jpg';
  } catch {
    return 'image.jpg';
  }
}


// ----- Indexing -----
async function indexCurrentPage(apiUrl) {
  if (!apiUrl) throw new Error('No server selected. Please select a server in the popup.');

  const sessionToken = await getServerToken(apiUrl);
  if (!sessionToken) throw new Error(`No session token found for ${apiUrl}. Please re-add the server.`);

  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab) throw new Error('No active tab');

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
  formData.append('is_screenshot', true);
  formData.append('screenshot', blob, 'screenshot.jpg');

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
          const data = await indexCurrentPage(selected);
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