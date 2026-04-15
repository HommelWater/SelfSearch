async function apiRequest(url, method = 'GET', data = null, json=true) {
    const options = {
        method: method,
    };

    if (data) {
        if (typeof data === 'string') {
            options.body = data;
            options.headers = { 'Content-Type': 'application/json' };
        } else {options.body = data;}
    }
    const response = await fetch(url, options);
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
    }
    if (json){
        const jsonResponse = await response.json();
        if (jsonResponse.type === "failure"){
            showToast(jsonResponse.data.notification, "failure");
            if(jsonResponse.data.href){
                location.href = jsonResponse.data.href;
            }
        }
        return jsonResponse;
    } else {
        return response;
    }   
}

// Show a popup to the user.
z_index_start = 10000
function popup(message, buttons = []){
    const popup = document.createElement('div');
    popup.className = "popup";
    popup.style.zIndex = z_index_start++;
    popup.innerHTML = `<div>${message}</div><div class="popup-button-list"></div>`;
    const button_elements = buttons.map(button =>{
        const button_element = document.createElement('div');
        button_element.className = "popup-button";
        button_element.innerText = button.text;
        button_element.addEventListener("click", button.function);
        button_element.addEventListener("click", ()=>popup.remove());
        return button_element;
    });
    popup.querySelector(".popup-button-list").append(...button_elements);
    document.documentElement.appendChild(popup);
}

// Displays a toast message to the user.
function showToast(message, type = 'success', duration = 3000) {
    // Remove existing toasts
    const existing = document.querySelector('.toast-notification');
    if (existing) existing.remove();
    
    // Create toast element
    const toast = document.createElement('div');
    toast.className = 'toast-notification';
    toast.textContent = message;
    
    // Colors based on type
    const colors = {
        success: '#22c55e',
        failure: '#ef4444',
        warning: '#f59e0b',
        info: '#3b82f6'
    };
    
    // Styles
    toast.style.cssText = `
        position: fixed;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        background: ${colors[type] || colors.success};
        color: white;
        padding: 5px 8px;
        font-size: 14px;
        font-weight: 500;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        z-index: 10000;
        opacity: 0;
        transition: opacity 0.3s ease, transform 0.3s ease;
        pointer-events: none;
        max-width: 90vw;
        text-align: center;
    `;
    
    document.body.appendChild(toast);
    
    // Animate in
    requestAnimationFrame(() => {
        toast.style.opacity = '1';
        toast.style.transform = 'translateX(-50%) translateY(0)';
    });
    
    // Remove after duration
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(-50%) translateY(-20px)';
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

// Upload a file to the server, onprogress is a callback function that gets called with the percentage of the upload progress.
// Usage:
// const file_data = await uploadFile(file, (pct)=>showToast(`Upload progress: ${pct}%`, "info", 1000)));
async function uploadFile(file, is_public, onProgress) {
    const session = localStorage.getItem("session");
    
    const formData = new FormData();
    formData.append('file', file);
    formData.append('session', session);
    formData.append('is_public', is_public);

    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();

        xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable) {
                onProgress(Math.round((e.loaded / e.total) * 100));
            }
        });

        xhr.addEventListener('load', () => {
            if (xhr.status !== 200) {
                showToast(`Upload failed: HTTP ${xhr.status}`, "failure");
                reject(new Error(`HTTP ${xhr.status}: ${xhr.responseText}`));
                return;
            }

            try {
                const jsonResponse = JSON.parse(xhr.response);
                
                if (jsonResponse.type === "failure") {
                    showToast(jsonResponse.data?.notification || "Upload failed", "failure");
                    if (jsonResponse.data?.href) {
                        location.href = jsonResponse.data.href;
                    }
                }
                
                resolve(jsonResponse);
            } catch (e) {
                showToast("Invalid server response", "failure");
                reject(new Error('Invalid JSON response'));
            }
        });

        xhr.addEventListener('error', () => {
            showToast("Upload failed: Network error", "failure");
            reject(new Error('Upload failed'));
        });
        
        xhr.addEventListener('abort', () => {
            showToast("Upload cancelled", "failure");
            reject(new Error('Upload aborted'));
        });

        xhr.open('POST', '/files/upload');
        xhr.send(formData);
    });
}

// Download a file by file id, onProgress is a callback function that gets passed the percentage of progress.
// Usage:
// const res = await downloadFile(file_id, (pct)=>showToast(`Download progress: ${pct}%`, "info", 1000));
async function downloadFile(file_id, onProgress) {
    const xhr = new XMLHttpRequest();
    
    xhr.onprogress = (e) => {
        if (onProgress && e.lengthComputable) {
            onProgress(Math.round((e.loaded / e.total) * 100));
        }
    };
    
    xhr.responseType = 'blob';
    xhr.open('POST', `/files/download/${file_id}`, true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.send(JSON.stringify({ session: localStorage.getItem("session") }));
    
    return new Promise((resolve, reject) => {
        xhr.onload = () => {
            const contentType = xhr.getResponseHeader('Content-Type');
            
            // Check for JSON error response (your API returns JSON on failure)
            if (contentType && contentType.includes('application/json')) {
                const reader = new FileReader();
                reader.onload = () => {
                    try {
                        const response = JSON.parse(reader.result);
                        if (response.type === "failure") {
                            showToast(response.data?.notification || 'Download failed', "error");
                            reject(new Error(response.data?.notification));
                        } else {
                            resolve(response);
                        }
                    } catch {
                        showToast('Invalid server response', "error");
                        reject(new Error('Invalid response'));
                    }
                };
                reader.readAsText(xhr.response);
                return;
            }
            
            // Handle file download (application/octet-stream or other binary types)
            const disposition = xhr.getResponseHeader('Content-Disposition');
            let filename = 'file';
            
            if (disposition) {
                // Try RFC 5987 format first: filename*=utf-8''encoded%20name.mp4
                const utf8Match = disposition.match(/filename\*=utf-8''([^;]+)/i);
                if (utf8Match) {
                    try {
                        filename = decodeURIComponent(utf8Match[1]);
                    } catch {
                        filename = utf8Match[1];
                    }
                } else {
                    // Fall back to standard format: filename="name.mp4" or filename=name.mp4
                    const standardMatch = disposition.match(/filename="?([^"]+)"?/);
                    if (standardMatch) {
                        filename = standardMatch[1];
                    }
                }
            }
            
            const url = URL.createObjectURL(xhr.response);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            resolve();
        };
        
        xhr.onerror = () => {
            showToast('Network error occurred', "error");
            reject(new Error('Network error'));
        };
        
        xhr.ontimeout = () => {
            showToast('Request timed out', "error");
            reject(new Error('Timeout'));
        };
    });
}