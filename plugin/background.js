chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'sendPageData') {
        fetch('http://127.0.0.1:5000/index', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Extension-Version': 'v1.0'
            },
            body: JSON.stringify(message.data)
        }).then(response => {
            if (!response.ok) {
                console.error('Server responded with status:', response.status);
            }
        }).catch(error => {
            console.error('Failed to send data:', error);
        });
    }
    if (message.action === 'captureScreenshot') {
        // captureVisibleTab is async—pass dataUrl into sendResponse
        chrome.tabs.captureVisibleTab(
          sender.tab.windowId,          // or null to default to current window
          { format: 'png' },
          (dataUrl) => {
            sendResponse({ screenshot: dataUrl });
          }
        );
        // MUST return true to indicate you’ll call sendResponse asynchronously
        return true;
      }
});

  