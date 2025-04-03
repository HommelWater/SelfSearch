async function loadJSON(url) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      return await response.json();
    } catch (error) {
      console.error('Failed to load JSON:', error);
      return null;
    }
}

function average(vectors) {
    const embedding = new Float32Array(300).fill(0);
    if (vectors.length === 0) return embedding;
    
    for (const vector of vectors) {
        for (let i = 0; i < vector.length; i++) {
            embedding[i] += vector[i];
        }
    }
    
    for (let i = 0; i < embedding.length; i++) {
        embedding[i] /= vectors.length;
    }
    
    return embedding;
}

async function embed(line) {
    line = line.replace(/[.,]/g, '').split(" ");
    const tokens = line.map(word => wordmap[word] ?? 0);
    const vectors = await Promise.all(tokens.map(token => getVector(token))); // Need await
    return average(vectors); // Need to return
}


const VECTOR_SIZE = 300 * 4; // 300 floats × 4 bytes each
let vectorCache = new Map(); // Simple in-memory cache
const MAX_CACHE_SIZE = 100; // Keep only recent vectors

async function getVector(idx) {
    if (vectorCache.has(idx)) {
        return vectorCache.get(idx);
    }

    const byteOffset = idx * VECTOR_SIZE;
    const byteEnd = byteOffset + VECTOR_SIZE - 1;

    try {
        const response = await fetch(chrome.runtime.getURL('vectormap.bin'), {
            headers: { 'Range': `bytes=${byteOffset}-${byteEnd}` }
        });

        if (response.status !== 206) throw new Error('Range requests not supported');
        
        const buffer = await response.arrayBuffer();
        const vector = new Float32Array(buffer);
        
        if (vectorCache.size >= MAX_CACHE_SIZE) {
            const firstKey = vectorCache.keys().next().value;
            vectorCache.delete(firstKey);
        }
        vectorCache.set(idx, vector);
        
        return vector;
    } catch (error) {
        console.error(`Failed to fetch vector ${idx}:`, error);
        return new Float32Array(300).fill(0);
    }
}

let wordmap;
(async () => {
    try {
        wordmap = await loadJSON(chrome.runtime.getURL('wordmap.json'));
        console.log('Wordmap loaded successfully');
    } catch (error) {
        console.error('Failed to load wordmap:', error);
    }
})();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('test')
    if (message.action === "processPage") {
        Promise.all(message.data.textLines.map(line => embed(line)))
            .then(lineEmbeds => average(lineEmbeds))
            .then(finalEmbed => {
                sendResponse({
                    status: "ok",
                    embedding: Array.from(finalEmbed)
                });
            })
            .catch(error => {
                console.log('error: ' + error.message)
                sendResponse({ status: "error", error: error.message });
            });
        return true;
    }
});