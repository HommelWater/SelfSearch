#!/bin/bash

set -e

die() { echo "ERROR: $*" >&2; exit 1; }
info() { echo "INFO: $*"; }
check_command() { command -v "$1" >/dev/null 2>&1; }

if [ "$EUID" -ne 0 ] && check_command sudo; then
    SUDO="sudo"
else
    SUDO=""
fi

cd "$(dirname "$0")" || die "Failed to cd to script directory"
PROJECT_ROOT="$(pwd)"

$SUDO apt-get update -qq
$SUDO apt-get install -y -qq nginx certbot python3-certbot-nginx python3-venv python3-pip

VENV_DIR="${PROJECT_ROOT}/venv"
python3 -m venv "$VENV_DIR"
source "$VENV_DIR/bin/activate"
pip install -q fastapi pyotp uvicorn[standard] python-multipart requests websockets google-genai tantivy

ENV_FILE="${PROJECT_ROOT}/.env"
if [ -f "$ENV_FILE" ]; then
    set -a; source "$ENV_FILE"; set +a
else
    touch "$ENV_FILE"
fi

# --- Required env vars ---
REQUIRED_VARS=("GOOGLE_API_KEY")
for VAR in "${REQUIRED_VARS[@]}"; do
    if [ -z "${!VAR}" ]; then
        read -p "Enter value for $VAR: " VALUE
        echo "$VAR=$VALUE" >> "$ENV_FILE"
        export "$VAR=$VALUE"
    fi
done

# --- Port configuration ---
if [ -z "$APP_PORT" ]; then
    read -p "Enter internal port for FastAPI (default 8000): " APP_PORT_INPUT
    APP_PORT="${APP_PORT_INPUT:-8000}"
    echo "APP_PORT=$APP_PORT" >> "$ENV_FILE"
    export APP_PORT="$APP_PORT"
else
    info "Using existing APP_PORT=$APP_PORT from .env"
fi

# --- Domain and email for SSL ---
read -p "Enter your domain name: " DOMAIN
read -p "Enter your email for Let's Encrypt: " EMAIL

# --- Nginx config ---
NGINX_CONF="/etc/nginx/sites-available/${DOMAIN}"
$SUDO tee "$NGINX_CONF" > /dev/null <<EOF
server {
    listen 80;
    server_name $DOMAIN;
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl;
    server_name $DOMAIN;

    location / {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF

$SUDO ln -sf "$NGINX_CONF" "/etc/nginx/sites-enabled/"
$SUDO rm -f /etc/nginx/sites-enabled/default
$SUDO nginx -t || die "Invalid Nginx config"

$SUDO certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" || die "Certbot failed"
$SUDO systemctl reload nginx

# --- Systemd service ---
SERVICE_NAME="fastapi-${DOMAIN//./-}"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
$SUDO tee "$SERVICE_FILE" > /dev/null <<EOF
[Unit]
Description=FastAPI app for $DOMAIN
After=network.target

[Service]
User=$(whoami)
WorkingDirectory=${PROJECT_ROOT}/src
EnvironmentFile=${ENV_FILE}
ExecStart=${VENV_DIR}/bin/uvicorn main:app --host 127.0.0.1 --port ${APP_PORT}
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

$SUDO systemctl daemon-reload
$SUDO systemctl enable "$SERVICE_NAME"
$SUDO systemctl restart "$SERVICE_NAME"

$SUDO systemctl enable nginx
$SUDO systemctl restart nginx

info "Setup complete! App is running on https://$DOMAIN (internal port $APP_PORT)"