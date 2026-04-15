window.addEventListener("pageshow", ()=>toggleTheme(0));
document.addEventListener('DOMContentLoaded', init_themes);
let themes = []

function toggleTheme(increment) {
    const currentIndex = get_theme_from_cookie();
    const newIndex = (currentIndex + increment) % themes.length;
    if (document.documentElement.classList.contains(themes[newIndex])) {
        return;
    }
    document.cookie = `theme=${newIndex}; path=/; SameSite=Lax; Max-Age=${30*24*60*60}`;
    localStorage.setItem("theme", `${newIndex}`);
    themes.forEach(theme => document.documentElement.classList.remove(theme));
    document.documentElement.classList.add(themes[newIndex]);
}

function get_theme_from_cookie() {
    const cookies = document.cookie.split(';');
    for (let cookie of cookies) {
        const [name, value] = cookie.trim().split('=');
        if (name === 'theme') {
            return parseInt(value, 10) || 0;
        }
    }
    return 0;
}

function getThemesFromCSS() {
    const themeNames = [];
    for (const sheet of document.styleSheets) {
        try {
            for (const rule of sheet.cssRules) {
                if (rule.selectorText && rule.selectorText.startsWith("html.")) {
                    const name = rule.selectorText.split(".")[1];
                    if (name && !themeNames.includes(name)) {
                        themeNames.push(name);
                    }
                }
            }
        } catch (e) {
        }
    }
    return themeNames;
}

function init_themes(){
    themes = getThemesFromCSS();
    const btn = document.getElementById("theme-toggle-button");
    if(btn){
        btn.addEventListener('click', ()=>toggleTheme(1));
    }
    toggleTheme(0)
}