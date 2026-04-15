document.addEventListener('DOMContentLoaded', load);

function load(){
    document.getElementById('login-button').addEventListener('click', login);
    setEnterPressEvent();
}

async function login(){
    const code = document.getElementById('login-code').value;
	let username = document.getElementById('login-username').value;

    let targetHost = window.location.host.replace(/^0\.0\.0\.0/, 'localhost');
    if (username.includes('@')) {
        const parts = username.split('@');
        username = parts[0];
        targetHost = parts[1];
    }

    const json = await apiRequest(`//${targetHost}/auth/`, "POST", JSON.stringify({
        code: code,
        username: username
    }));

    const type = json.type;
    const rdata = json.data;
    if (type == "signup"){
        generateTOTPQRCode(rdata.secret, targetHost, username);
        document.getElementById('login-code').value = "";
    } else
    if (type == "login"){
        localStorage.setItem("session", rdata.session_key);
        location.href = "/";
    }
}

function generateTOTPQRCode(secret, issuer, accountName) {
    document.getElementById("login-code").innerHTML = "";
    const container = document.getElementById("qrcode");
    container.innerHTML = "";
    
    const totpUri = `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}?secret=${encodeURIComponent(secret)}&issuer=${encodeURIComponent(issuer)}`;
    
    const link = document.createElement("a");
    link.href = totpUri;
    link.style.display = "inline-block";
    link.style.cursor = "pointer";
    link.style.position = "relative";
    link.title = "Click to open authenticator app";
    
    new QRCode(link, {
        text: totpUri,
        width: 256,
        height: 256,
        colorDark: "#000000",
        colorLight: "#ffffff",
        correctLevel: QRCode.CorrectLevel.H
    });
    
    container.appendChild(link);
    
    setTimeout(() => {
        const badge = document.createElement("div");
        badge.textContent = "🟢 Click to open";
        badge.style.cssText = `
            position: absolute; bottom: 5px; right: 5px;
            background: rgba(255,255,255,0.9); padding: 4px 8px;
            border-radius: 4px; font-size: 10px; pointer-events: none;
        `;
        link.appendChild(badge);
    }, 50);
    
    document.getElementById('qrcode-label').innerHTML = 
        `Scan the QR code or click to open in your authenticator app. You might have to add a new "account" in the case of the apple password manager.`;
}

function setEnterPressEvent(){
    const loginCode = document.getElementById('login-code');
    const loginButton = document.getElementById('login-button');
    
    loginCode.addEventListener('keypress', function(event) {
        if (event.key === 'Enter') {
            event.preventDefault();
            loginButton.click();
        }
    });
}

