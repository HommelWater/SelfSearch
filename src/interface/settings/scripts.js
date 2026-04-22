window.addEventListener('DOMContentLoaded', onLoad);

async function insertData() {
    const settingsList = document.getElementById('settings-list');
    if (!settingsList) {
        console.error('Could not find #settings-list element');
        return;
    }

    // Clear existing content to avoid duplicates
    settingsList.innerHTML = '';

    // Get session token from localStorage
    const sessionToken = localStorage.getItem('session') || 'Not found';

    // Build MCP server URL
    const mcpUrl = `${window.location.origin}/mcp`;

    // Fetch user info from /me endpoint
    let username = 'Error loading';
    let inviteCode = 'Error loading';

    try {
        const response = await fetch('/me', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session: sessionToken })
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

    // Helper to prevent XSS
    function escapeHtml(str) {
        if (!str) return '';
        return str.replace(/[&<>]/g, function (m) {
            if (m === '&') return '&amp;';
            if (m === '<') return '&lt;';
            if (m === '>') return '&gt;';
            return m;
        });
    }

    // ---------- 1. Create settings-item for user info ----------
    const userInfoDiv = document.createElement('div');
    userInfoDiv.className = 'settings-item';
    userInfoDiv.innerHTML = `
        <div class="settings-title">Info</div>
        <div class="settings-content">Username: ${escapeHtml(username)}</div>
        <div class="settings-content">Session Token: ${escapeHtml(sessionToken)}</div>
        <div class="settings-content">MCP Server URL: ${escapeHtml(mcpUrl)}</div>
        <div class="settings-content">Invite Code: ${escapeHtml(inviteCode)}</div>
    `;

    // ---------- 2. Create settings-item for MCP JSON config (LM Studio) ----------
    // Build the config object
    const mcpConfig = {
        mcpServers: {
            "SelfSearch": {
                url: mcpUrl,
                headers: {
                    Authorization: `Bearer ${sessionToken}`
                }
            }
        }
    };

    const prettyJson = JSON.stringify(mcpConfig, null, 2);
    const escapedJson = escapeHtml(prettyJson);

    const mcpConfigDiv = document.createElement('div');
    mcpConfigDiv.className = 'settings-item';
    mcpConfigDiv.innerHTML = `
        <div class="settings-title">Example MCP Config for LM Studio</div>
        <div class="settings-content">
            <pre style="background:var(--color-card); color:var(--color-text); padding:10px; overflow-x:auto;">${escapedJson}</pre>
        </div>
    `;

    // Append both items to the settings list
    settingsList.appendChild(userInfoDiv);
    settingsList.appendChild(mcpConfigDiv);
}
function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>]/g, function(m) {
        if (m === '&') return '&amp;';
        if (m === '<') return '&lt;';
        if (m === '>') return '&gt;';
        return m;
    });
}

async function onLoad(){
    await insertData();
}