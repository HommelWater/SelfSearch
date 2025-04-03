(function() {
    const rawText = document.body.innerText || "";
    const textArray = rawText.split("\n")
                            
                             .map(line => line.trim())
                             .filter(line => line.length > 0);
  
    const pageData = {
      url: window.location.href,
      title: document.title,
      timestamp: new Date().toISOString(),
      images: Array.from(document.images).map(img => img.src),
      textLines: textArray
    };
})();