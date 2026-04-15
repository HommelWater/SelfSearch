#!/bin/bash

set -e  # exit on any error

# --- Helper functions ---
die() {
    echo "ERROR: $*" >&2
    exit 1
}

warn() {
    echo "WARNING: $*" >&2
}

info() {
    echo "INFO: $*"
}

check_command() {
    command -v "$1" >/dev/null 2>&1
}

# --- Ensure we are root or can use sudo ---
if [ "$EUID" -ne 0 ]; then
    if check_command sudo; then
        SUDO="sudo"
        info "Using sudo for privileged commands"
    else
        die "Please run as root or install sudo"
    fi
else
    SUDO=""
fi

# --- Go to script directory ---
cd "$(dirname "$0")" || die "Failed to cd to script directory"
PROJECT_ROOT="$(pwd)"

# --- Install required system packages ---
info "Updating package list and installing required packages..."
$SUDO apt-get update -qq
$SUDO apt-get install -y -qq nginx certbot python3-certbot-nginx python3-venv python3-pip

# --- Setup Python virtual environment and dependencies ---
VENV_DIR="${PROJECT_ROOT}/venv"
info "Creating Python virtual environment at $VENV_DIR"
python3 -m venv "$VENV_DIR"
source "$VENV_DIR/bin/activate"

info "Installing Python dependencies..."
pip install -q fastapi pyotp uvicorn[standard] python-multipart requests websockets google-genai tantivy

# --- Load or create .env file ---
ENV_FILE="${PROJECT_ROOT}/.env"
if [ -f "$ENV_FILE" ]; then
    info "Loading existing .env file"
    set -a
    source "$ENV_FILE"
    set +a
else
    info "No .env file found, will create one"
    touch "$ENV_FILE"
fi

# List of required environment variables
REQUIRED_VARS=("GOOGLE_API_KEY")
# Optional: you can add more variables here, e.g., "DATABASE_URL", "SECRET_KEY"

for VAR in "${REQUIRED_VARS[@]}"; do
    if [ -z "${!VAR}" ]; then
        read -p "Enter value for $VAR: " VALUE
        echo "$VAR=$VALUE" >> "$ENV_FILE"
        export "$VAR=$VALUE"
        info "Saved $VAR to .env"
    else
        info "Using existing $VAR from .env"
    fi
done

# --- Ask for domain and email for SSL ---
read -p "Enter your domain name (e.g., example.com): " DOMAIN
if [ -z "$DOMAIN" ]; then
    die "Domain name cannot be empty"
fi

read -p "Enter your email address for Let's Encrypt notifications: " EMAIL
if [ -z "$EMAIL" ]; then
    die "Email address cannot be empty"
fi

# --- Create Nginx configuration ---
NGINX_CONF="/etc/nginx/sites-available/${DOMAIN}"
info "Creating Nginx configuration for $DOMAIN"
$SUDO tee "$NGINX_CONF" > /dev/null <<EOF
server {
    listen 80;
    server_name $DOMAIN;
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl;
    server_name $DOMAIN;

    # SSL will be handled by certbot after obtaining the certificate
    # Temporary self-signed or no cert; certbot will modify this file.
    # For now, just a placeholder.

    location / {
        proxy_pass http://127.0.0.1:8000;
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

# Enable the site (disable default if it exists)
$SUDO ln -sf "$NGINX_CONF" "/etc/nginx/sites-enabled/"
$SUDO rm -f /etc/nginx/sites-enabled/default

# Test Nginx configuration
info "Testing Nginx configuration"
$SUDO nginx -t || die "Invalid Nginx configuration"

# --- Obtain SSL certificate using certbot ---
info "Obtaining SSL certificate from Let's Encrypt for $DOMAIN"
$SUDO certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" || die "Certbot failed"

# Reload Nginx to apply SSL configuration
$SUDO systemctl reload nginx

# --- Create systemd service for the FastAPI app ---
SERVICE_NAME="fastapi-${DOMAIN//./-}"  # replace dots with dashes
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

info "Creating systemd service $SERVICE_NAME"
$SUDO tee "$SERVICE_FILE" > /dev/null <<EOF
[Unit]
Description=FastAPI app for $DOMAIN
After=network.target

[Service]
User=$(whoami)
WorkingDirectory=${PROJECT_ROOT}/src
EnvironmentFile=${ENV_FILE}
ExecStart=${VENV_DIR}/bin/uvicorn main:app --host 127.0.0.1 --port 8000
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

# Reload systemd, enable and start the service
$SUDO systemctl daemon-reload
$SUDO systemctl enable "$SERVICE_NAME"
$SUDO systemctl restart "$SERVICE_NAME"

# --- Ensure Nginx is running and enabled ---
$SUDO systemctl enable nginx
$SUDO systemctl restart nginx

info "Setup completed successfully!"
info "Your application should be available at https://$DOMAIN"
info "Check service status: sudo systemctl status $SERVICE_NAME"
info "Check Nginx logs: sudo journalctl -u nginx"