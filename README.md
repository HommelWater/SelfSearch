## SelfSearch

SelfSearch is a self-hosted search engine. A browser extension captures web pages you visit. A server stores and indexes them locally. You can search your browsing history via web UI, API, or AI agents (MCP protocol).
## Quick start

    git clone https://github.com/HommelWater/SelfSearch.git
    cd SelfSearch
    sudo bash setup.sh

Follow the prompts (domain, email, Google API key). The script installs the backend, Nginx, SSL, and a systemd service.

After installation, visit your domain, log in as admin with TOTP, and start indexing pages.
Browser extension

Extension location: src/plugin/

    Chrome: chrome://extensions -> Developer mode -> Load unpacked -> select src/plugin

    Firefox: about:debugging -> This Firefox -> Load Temporary Add-on -> select src/plugin/manifest.json

Or visit their respective add-on/extension pages:
    https://addons.mozilla.org/en-US/firefox/addon/selfsearch-indexer/

Click the extension icon on any page, select your server, then click "Index this page".

## Searching

    Web UI: /search

    API: POST to /search/search with session_token, query, page

    MCP endpoint for AI agents: /mcp (Bearer token authentication)

## Multi-user

Admins can generate invite codes, add users, and delete users (with recursive deletion). Login uses TOTP.

## License

See LICENSE file.
