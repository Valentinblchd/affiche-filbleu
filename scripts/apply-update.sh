#!/bin/sh

set -eu

APP_DIR="${APP_DIR:-/opt/affiche-filbleu}"
APP_BRANCH="${APP_BRANCH:-}"
SYSTEMD_SERVICE_NAME="${SYSTEMD_SERVICE_NAME:-affiche-filbleu}"
UPDATE_LOG_FILE="${UPDATE_LOG_FILE:-$APP_DIR/update.log}"

exec >>"$UPDATE_LOG_FILE" 2>&1

printf '[%s] Debut mise a jour\n' "$(date '+%Y-%m-%d %H:%M:%S')"

if ! command -v git >/dev/null 2>&1; then
  echo "git est introuvable"
  exit 1
fi

cd "$APP_DIR"

branch="${APP_BRANCH}"
if [ -z "$branch" ]; then
  branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
fi
if [ -z "$branch" ] || [ "$branch" = "HEAD" ]; then
  branch="main"
fi

git fetch origin "$branch" --quiet

current_commit="$(git rev-parse HEAD)"
remote_commit="$(git rev-parse "origin/$branch")"

if [ "$current_commit" = "$remote_commit" ]; then
  echo "Aucune mise a jour a appliquer"
  exit 0
fi

git pull --ff-only origin "$branch"

if [ -f package-lock.json ]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi

sleep 1
systemctl restart "$SYSTEMD_SERVICE_NAME"
