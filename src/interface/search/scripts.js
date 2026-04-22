window.addEventListener('DOMContentLoaded', onLoad);

async function requestRecentlyIndexed(){
    const data = {};
    data.session_token = localStorage.getItem("session") || "";
    try {
        const res = await fetch('/search/recent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
        if (!res.ok) throw new Error(res.status);
        const r = await res.json();
        if (r.type && r.type === "failure"){
            location.href = "/auth";
        }
        const results = r.recently_indexed;

        document.getElementById("newly-indexed-content").innerHTML = results.length > 0 ? "" : "No recently indexed pages found.";
        results.forEach(r => {
            addRecentlyIndexed(r.title, r.description, r.url);
        });
    } catch (e) {
        console.error(e);
    }
}

async function search(e){
    e.preventDefault();
    const data = {};
    data.query = document.getElementById("search-input").value;
    data.session_token = localStorage.getItem("session");
    try {
        const res = await fetch('/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
        if (!res.ok) throw new Error(res.status);
        const r = await res.json();
        const results = r.search_results;

        document.getElementById("search-results").innerHTML = results.length > 0 ? "" : "No search results for this query.";
        results.forEach(r => {
            addSearchResult(r.doc.title, r.doc.description, r.doc.url);
        });
    } catch (e) {
        console.error(e);
    }
}

function addSearchResult(title, description, url){
    const resultsElement = document.getElementById("search-results");
    const result = document.createElement("div");
    result.className = "search-result";

    const resultHeader = document.createElement('div');
    resultHeader.className = "result-header";
    resultHeader.innerText = title;

    const resultDescription = document.createElement('div');
    resultDescription.className = "result-description";
    resultDescription.innerText = description;

    result.replaceChildren(resultHeader, resultDescription);
    result.addEventListener('click', () => {
        window.open(url, '_blank').focus();
    });
    resultsElement.appendChild(result);
}

function addRecentlyIndexed(title, description, url){
    const resultsElement = document.getElementById("newly-indexed-content");
    const result = document.createElement("div");
    result.className = "search-result";

    const resultHeader = document.createElement('div');
    resultHeader.className = "result-header";
    resultHeader.innerText = title;

    const resultDescription = document.createElement('div');
    resultDescription.className = "result-description";
    resultDescription.innerText = description;

    result.replaceChildren(resultHeader, resultDescription);
    result.addEventListener('click', () => {
        window.open(url, '_blank').focus();
    });
    resultsElement.appendChild(result);
}

async function onLoad(){
    localStorage.setItem("SELFSEARCH_SERVER", "true");
    document.getElementById('search-form').addEventListener('submit', search);
    document.getElementById('settings-button').addEventListener('click', ()=>location.href="/settings")
    await requestRecentlyIndexed();
}