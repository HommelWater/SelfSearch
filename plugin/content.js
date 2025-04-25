(function() {
    function processPageText() {
        const forbiddenTags = ['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'HEADER', 'FOOTER', 'NAV'];
        const clone = document.body.cloneNode(true);
        forbiddenTags.forEach(tag => {
            clone.querySelectorAll(tag).forEach(el => el.remove());
        });
        return clone.innerText || "";
    }

    function processAndSend() {
        chrome.runtime.sendMessage({ action: 'captureScreenshot' }, (response) => {
            const pageData = {
                url: window.location.href,
                domain: window.location.hostname,
                title: document.title,
                timestamp: new Date().toISOString(),
                text: processPageText(),
                screenshot: response.screenshot
            };
            chrome.runtime.sendMessage({ action: 'sendPageData', data: pageData });
        });
    }

    const button = document.createElement('button');
    button.textContent = 'Process Page';
    Object.assign(button.style, {
        position: 'fixed',
        top: '10px',
        right: '10px',
        zIndex: '9999',
        padding: '8px 12px',
        backgroundColor: '#007bff',
        color: '#fff',
        border: 'none',
        borderRadius: '4px',
        cursor: 'pointer',
        boxShadow: '0 2px 4px rgba(0,0,0,0.3)'
    });
    document.body.appendChild(button);
    button.addEventListener('click', processAndSend);
})();