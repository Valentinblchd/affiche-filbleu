#!/bin/sh

set -eu

APP_DIR="${APP_DIR:-/opt/affiche-filbleu}"
APP_BRANCH="${APP_BRANCH:-}"

json_disabled() {
  printf '{"enabled":false,"updateAvailable":false,"currentVersion":"","latestVersion":"","branch":"","error":"%s"}\n' "$1"
}

if ! command -v git >/dev/null 2>&1; then
  json_disabled "git-non-disponible"
  exit 0
fi

if [ ! -d "$APP_DIR/.git" ]; then
  json_disabled "deploiement-sans-git"
  exit 0
fi

cd "$APP_DIR"

branch="${APP_BRANCH}"
if [ -z "$branch" ]; then
  branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
fi
if [ -z "$branch" ] || [ "$branch" = "HEAD" ]; then
  branch="main"
fi

current_commit="$(git rev-parse HEAD 2>/dev/null || true)"
if [ -z "$current_commit" ]; then
  json_disabled "commit-local-introuvable"
  exit 0
fi

latest_commit="$(git ls-remote --heads origin "refs/heads/$branch" 2>/dev/null | awk 'NR==1 { print $1 }')"

current_short="$(printf '%s' "$current_commit" | cut -c1-7)"

if [ -z "$latest_commit" ]; then
  printf '{"enabled":true,"updateAvailable":false,"currentVersion":"%s","latestVersion":"","branch":"%s","error":"verification-distante-indisponible"}\n' \
    "$current_short" \
    "$branch"
  exit 0
fi

latest_short="$(printf '%s' "$latest_commit" | cut -c1-7)"

if [ "$current_commit" = "$latest_commit" ]; then
  update_available=false
else
  update_available=true
fi

printf '{"enabled":true,"updateAvailable":%s,"currentVersion":"%s","latestVersion":"%s","branch":"%s","error":""}\n' \
  "$update_available" \
  "$current_short" \
  "$latest_short" \
  "$branch"
