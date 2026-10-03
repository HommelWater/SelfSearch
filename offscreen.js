import { startMesh, handleMeshRequest } from './core/mesh.js';
import { browserApi } from './core/capture.js';

const api = browserApi();

startMesh().catch(err => console.error('[offscreen] mesh start failed', err));

// Talk to the service worker over a long-lived port: it forwards p2p requests
// from the popup, and we answer over the same port. Reconnect if the worker
// restarts.
function attachPort() {
  let port;
  try {
    port = api.runtime.connect({ name: 'mesh' });
    if (api.runtime.lastError) throw new Error(api.runtime.lastError.message);
  } catch {
    setTimeout(attachPort, 2000);
    return;
  }
  port.onMessage.addListener((msg) => {
    if (!msg || msg.id == null || !msg.request) return;
    handleMeshRequest(msg.request)
      .then(response => port.postMessage({ id: msg.id, response }))
      .catch(err => port.postMessage({ id: msg.id, response: { success: false, error: err.message } }));
  });
  port.onDisconnect.addListener(() => setTimeout(attachPort, 2000));
}

attachPort();
