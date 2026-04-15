console.log('Background script loaded');

// Storage keys
const STORAGE_SERVERS = 'bombus_servers';     // { "https://server1.com": "token1", ... }
const STORAGE_SELECTED = 'bombus_selected';   // string (server URL)

// ----- Server management -----
async function getServers() {
  const result = await browser.storage.local.get(STORAGE_SERVERS);
  return result[STORAGE_SERVERS] || {};
}

async function saveServers(servers) {
  await browser.storage.local.set({ [STORAGE_SERVERS]: servers });
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
  const result = await browser.storage.local.get(STORAGE_SELECTED);
  return result[STORAGE_SELECTED] || null;
}

async function setSelectedServer(url) {
  await browser.storage.local.set({ [STORAGE_SELECTED]: url });
}

// ----- Indexing -----
async function indexCurrentPage(apiUrl) {
  if (!apiUrl) throw new Error('No server selected. Please select a server in the popup.');

  const sessionToken = await getServerToken(apiUrl);
  if (!sessionToken) throw new Error(`No session token found for ${apiUrl}. Please re-add the server.`);

  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab) throw new Error('No active tab');

  const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  const base64 = dataUrl.split(',')[1];

  const response = await fetch(`${apiUrl}/index`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_token: sessionToken,
      url: tab.url,
      title: tab.title,
      image_base64: base64
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Indexing failed: ${response.status} - ${errorText}`);
  }

  return await response.json();
}

// ----- Message handling -----
browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
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