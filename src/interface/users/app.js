document.addEventListener("DOMContentLoaded", renderUserTree);

function formatDate(timestamp) {
    const date = new Date(timestamp * 1000);
    const now = new Date();
    const diffDays = Math.floor((now - date) / (1000 * 60 * 60 * 24));
    
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays} days ago`;
    if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function getInitials(username) {
    return username.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
}

function createUserNode(user, childrenCount, isRoot = false) {
    console.log(user);
    const node = document.createElement('div');
    node.className = 'user-node';
    
    const hasChildren = childrenCount > 0;
    const isDirect = user.parent_id === null || user.parent_id === undefined;
    
    node.innerHTML = `
        <div class="user-card ${hasChildren ? 'has-children' : ''}" onclick="toggleNode(this)">
            <div class="toggle-btn ${hasChildren ? '' : 'leaf'} ${isRoot ? 'expanded' : ''}">
                ${hasChildren ? '▶' : ''}
            </div>
            <div class="delete-button" id="delete-btn-${user.id}">🗑️</div>
            <div class="avatar">${getInitials(user.username)}</div>
            <div class="user-info">
                <div class="username">${user.username}</div>
                <div class="meta-info">
                    <span>📅 ${formatDate(user.creation_datetime)}</span>
                    ${hasChildren ? `<span class="meta-dot"></span><span class="children-count">${childrenCount} invite${childrenCount !== 1 ? 's' : ''}</span>` : ''}
                </div>
            </div>
        </div>
        <div class="children ${isRoot ? 'expanded' : 'collapsed'}"></div>
    `;

    const session = localStorage.getItem("session"); 
    const fn_delete_one = async ()=>{
        await apiRequest("/users/delete", "POST", JSON.stringify({"session":session, "user_id":user.id, "recursive":false}));
        location.href = "/users";
    };
    const fn_delete_all = async ()=>{
        await apiRequest("/users/delete", "POST", JSON.stringify({"session":session, "user_id":user.id, "recursive":true}));
        location.href = "/users";
    };
    const fn_delete_none = ()=>{console.log("Cancelled deleting user.")};

    node.querySelector('.delete-button').addEventListener("click", async ()=>{
        popup("Are you sure you want to delete this user?", [{"text":"Yes.", "function":fn_delete_one},{"text":"Yes, including children.", "function":fn_delete_all}, {"text":"No!", "function":fn_delete_none}]);
    });
    return node;
}

function toggleNode(card) {
    const btn = card.querySelector('.toggle-btn');
    const children = card.nextElementSibling;
    
    if (btn.classList.contains('leaf')) return;
    
    const isExpanded = children.classList.contains('expanded');
    
    if (isExpanded) {
        children.classList.remove('expanded');
        children.classList.add('collapsed');
        btn.classList.remove('expanded');
    } else {
        children.classList.remove('collapsed');
        children.classList.add('expanded');
        btn.classList.add('expanded');
    }
}

function calculateStats(users) {
    const total = users.length;
    const parentCounts = {};
    let maxDepth = 0;
    
    users.forEach(u => {
        if (u.parent_id) {
            parentCounts[u.parent_id] = (parentCounts[u.parent_id] || 0) + 1;
        }
    });
    
    // Calculate depth (simplified)
    const depthMap = {};
    users.forEach(u => {
        let depth = 0;
        let current = u;
        while (current.parent_id) {
            const parent = users.find(p => p.id === current.parent_id);
            if (!parent) break;
            depth++;
            current = parent;
        }
        depthMap[u.id] = depth;
        maxDepth = Math.max(maxDepth, depth);
    });
    
    const avgInvites = total > 0 ? (Object.values(parentCounts).reduce((a, b) => a + b, 0) / total).toFixed(1) : 0;
    
    return { total, maxDepth: maxDepth + 1, avgInvites };
}

async function renderUserTree() {
    const session = localStorage.getItem("session");
    const rootContainer = document.getElementById('treeRoot');
    
    const res = await apiRequest("/users/", "POST", JSON.stringify({session}));
    if (!res || res.type === "failure") return;
    const users = res.data.users;
    
    const container = document.createElement('div');
    const nodes = new Map();
    const childrenCount = {};
    
    // Count children for each user
    users.forEach(u => {
        if (u.parent_id) {
            childrenCount[u.parent_id] = (childrenCount[u.parent_id] || 0) + 1;
        }
    });
    
    // Create all user nodes first
    users.forEach(u => {
        const isRoot = u.parent_id === null || u.parent_id === undefined;
        const node = createUserNode(u, childrenCount[u.id] || 0, isRoot);
        nodes.set(u.id, node);
    });
    
    // Attach to parents or container
    users.forEach(u => {
        const node = nodes.get(u.id);
        if (u.parent_id && nodes.has(u.parent_id)) {
            const parentChildren = nodes.get(u.parent_id).querySelector('.children');
            parentChildren.appendChild(node);
        } else {
            container.appendChild(node);
        }
    });
    
    // Update stats
    const stats = calculateStats(users);
    document.getElementById('totalUsers').textContent = stats.total;
    document.getElementById('totalLevels').textContent = stats.maxDepth;
    document.getElementById('avgChildren').textContent = stats.avgInvites;
    document.getElementById('statsBar').style.display = 'flex';
    
    rootContainer.innerHTML = '';
    rootContainer.appendChild(container);
}