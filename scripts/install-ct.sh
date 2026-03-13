#!/bin/sh

set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Lance ce script en root dans le CT."
  exit 1
fi

APP_REPO_URL="${APP_REPO_URL:-${1:-}}"
APP_BRANCH="${APP_BRANCH:-main}"
APP_DIR="${APP_DIR:-/opt/affiche-filbleu}"
APP_HOST="${APP_HOST:-0.0.0.0}"
APP_PORT="${APP_PORT:-3173}"
SERVICE_NAME="${SERVICE_NAME:-affiche-filbleu}"
ENV_FILE="/etc/default/$SERVICE_NAME"
SERVICE_FILE="/etc/systemd/system/$SERVICE_NAME.service"

if [ -z "$APP_REPO_URL" ]; then
  echo "Renseigne APP_REPO_URL, par exemple :"
  echo "APP_REPO_URL=https://github.com/ton-compte/affiche-filbleu.git $0"
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y ca-certificates curl git gnupg

if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/^v//' | cut -d. -f1)" -lt 20 ]; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  printf 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main\n' \
    >/etc/apt/sources.list.d/nodesource.list
  apt-get update
fi

apt-get install -y nodejs

mkdir -p "$(dirname "$APP_DIR")"

if [ -d "$APP_DIR/.git" ]; then
  cd "$APP_DIR"
  git fetch origin "$APP_BRANCH" --quiet
  git checkout "$APP_BRANCH"
  git pull --ff-only origin "$APP_BRANCH"
else
  rm -rf "$APP_DIR"
  git clone --branch "$APP_BRANCH" "$APP_REPO_URL" "$APP_DIR"
fi

cd "$APP_DIR"

chmod +x "$APP_DIR/scripts/check-update.sh" "$APP_DIR/scripts/apply-update.sh" "$APP_DIR/scripts/install-ct.sh"

if [ -f package-lock.json ]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi

cat >"$ENV_FILE" <<EOF
HOST=$APP_HOST
PORT=$APP_PORT
APP_DIR=$APP_DIR
APP_BRANCH=$APP_BRANCH
SELF_UPDATE_ENABLED=1
SYSTEMD_SERVICE_NAME=$SERVICE_NAME
UPDATE_CHECK_SCRIPT=$APP_DIR/scripts/check-update.sh
UPDATE_APPLY_SCRIPT=$APP_DIR/scripts/apply-update.sh
UPDATE_LOG_FILE=$APP_DIR/update.log
EOF

cat >"$SERVICE_FILE" <<EOF
[Unit]
Description=Affiche Fil Bleu
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=-$ENV_FILE
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node $APP_DIR/server.js
Restart=always
RestartSec=3
User=root

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

printf 'Affiche Fil Bleu disponible sur http://%s:%s\n' "$APP_HOST" "$APP_PORT"
