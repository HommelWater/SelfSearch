(function() {
  // Improved text processing with garbage filtering
  function processPageText() {
      const forbiddenTags = ['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'HEADER', 'FOOTER', 'NAV'];
      const clone = document.cloneNode(true);
      
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

  // Send data to server
  async function sendData(pageData) {
      try {
          const response = await fetch('https://your-search-engine-server.com/api/save', {
              method: 'POST',
              headers: {
                  'Content-Type': 'application/json',
                  'Extension-Version': 'v1.0'
              },
              body: JSON.stringify(pageData)
          });

          if (!response.ok) {
              console.error('Server responded with:', response.status);
          }
      } catch (error) {
          console.error('Failed to send data:', error);
      }
  }

  // Create page data object
  const pageData = {
      url: window.location.href,
      domain: new URL(window.location.href).hostname,
      title: document.title,
      timestamp: new Date().toISOString(),
      text: processPageText()
  };

  // Send the data
  sendData(pageData);
})();