(function() {
    function processPageText(clone) {
        const forbiddenTags = ['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'HEADER', 'FOOTER', 'NAV'];
        
        // Remove unwanted elements
        clone.querySelectorAll(forbiddenTags.join(',')).forEach(el => el.remove());
        
        // Get clean text content
        const rawText = clone.body.innerText || "";
        
        // Process text
        return rawText.split(/[\n\r]+/)
            .map(line => line.trim())
            .filter(line => {
                // Basic garbage filtering
                const text = line.toLowerCase();
                const isGarbage = text.length < 20 || 
                               text.startsWith('cookie') ||
                               /login|sign up|modal|popup/i.test(text);
                return !isGarbage && line.length > 0;
            });
    }

    document.addEventListener('DOMContentLoaded', () => {
        const clone = document.cloneNode(true);
        function processAndSend() {
            const pageData = {
                url: window.location.href,
                domain: new URL(window.location.href).hostname,
                title: document.title,
                timestamp: new Date().toISOString(),
                text: processPageText(clone)
            };
    
            chrome.runtime.sendMessage({ action: 'sendPageData', data: pageData });
        }

        // Create button.
        const button = document.createElement('button');
        button.textContent = 'Process Page';
        button.style.position = 'fixed';
        button.style.top = '10px';
        button.style.right = '10px';
        button.style.zIndex = '9999';
        button.style.padding = '8px 12px';
        button.style.backgroundColor = '#007bff';
        button.style.color = '#fff';
        button.style.border = 'none';
        button.style.borderRadius = '4px';
        button.style.cursor = 'pointer';
        button.style.boxShadow = '0 2px 4px rgba(0,0,0,0.3)';
        document.body.appendChild(button);
        button.addEventListener('click', processAndSend);
    });
})();