window.addEventListener('DOMContentLoaded', onLoad);

async function insertData(){
    const settingsDiv = document.querySelector('.settings-item');
    if (!settingsDiv) {
        console.error('Could not find .settings-item element');
        return;
    }

    // Get session token from localStorage (adjust key if needed)
    const sessionToken = localStorage.getItem('session') || 'Not found';

    // Build MCP server URL: current origin + /mcp
    const mcpUrl = `${window.location.origin}/mcp`;

    // Fetch user info from /me endpoint
    let username = 'Error loading';
    let inviteCode = 'Error loading';

    try {
        const response = await fetch('/me', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({'session':sessionToken})
        });

        if (response.ok) {
            const data = await response.json();
            username = data.username || 'Unknown';
            inviteCode = data.invite_code || data.inviteCode || 'None';
        } else {
            console.warn('Failed to fetch /me:', response.status);
            username = 'Unauthenticated';
            inviteCode = 'Unauthenticated';
        }
    } catch (err) {
        console.error('Fetch error:', err);
        username = 'Network error';
        inviteCode = 'Network error';
    }

    // Update the inner HTML of settings-item
    settingsDiv.innerHTML = `
        <div class="settings-title">Info</div>
        <div class="settings-content">Username: ${escapeHtml(username)}</div>
        <div class="settings-content">Session Token: ${escapeHtml(sessionToken)}</div>
        <div class="settings-content">MCP Server URL: ${escapeHtml(mcpUrl)}</div>
        <div class="settings-content">Invite Code: ${escapeHtml(inviteCode)}</div>
    `;

    // Helper to prevent XSS
    function escapeHtml(str) {
        if (!str) return '';
        return str.replace(/[&<>]/g, function(m) {
            if (m === '&') return '&amp;';
            if (m === '<') return '&lt;';
            if (m === '>') return '&gt;';
            return m;
        });
    }
}

async function onLoad(){
    await insertData();
}