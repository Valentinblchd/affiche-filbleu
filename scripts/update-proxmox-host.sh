#!/bin/sh

set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Lance ce script en root sur l'hote Proxmox."
  exit 1
fi

APP_REPO_URL="${APP_REPO_URL:-https://github.com/Valentinblchd/affiche-filbleu.git}"
APP_BRANCH="${APP_BRANCH:-main}"
CT_HOSTNAME="${CT_HOSTNAME:-srv-filbleu}"
CTID="${CTID:-}"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Commande manquante: $1"
    exit 1
  fi
}

need_cmd pct
need_cmd curl
need_cmd awk

find_ctid_by_hostname() {
  pct list | awk 'NR > 1 { print $1 }' | while read -r current_id; do
    hostname_value="$(pct config "$current_id" | awk -F': ' '/^hostname: / { print $2 }')"
    if [ "$hostname_value" = "$CT_HOSTNAME" ]; then
      echo "$current_id"
      return 0
    fi
  done
  return 1
}

if [ -z "$CTID" ]; then
  CTID="$(find_ctid_by_hostname || true)"
fi

if [ -z "$CTID" ]; then
  echo "Impossible de trouver le CT. Definis CTID ou CT_HOSTNAME."
  exit 1
fi

if ! pct config "$CTID" >/dev/null 2>&1; then
  echo "Le CTID $CTID n'existe pas."
  exit 1
fi

if ! pct status "$CTID" | grep -q "status: running"; then
  echo "Demarrage du CT $CTID..."
  pct start "$CTID"
  sleep 5
fi

echo "Mise a jour du CT $CTID..."
pct exec "$CTID" -- env \
  CT_HOSTNAME="$CT_HOSTNAME" \
  APP_REPO_URL="$APP_REPO_URL" \
  APP_BRANCH="$APP_BRANCH" \
  bash -lc "bash <(curl -fsSL https://raw.githubusercontent.com/Valentinblchd/affiche-filbleu/main/scripts/install-ct.sh)"

ct_ip="$(
  pct exec "$CTID" -- bash -lc "hostname -I 2>/dev/null | awk 'NR==1 { print \$1 }'" \
    | tail -n 1 \
    | tr -d '\r'
)"

echo
echo "CT mis a jour."
echo "CTID: $CTID"
if [ -n "$ct_ip" ]; then
  echo "Interface: http://$ct_ip:3173"
else
  echo "IP non detectee. Fais: pct exec $CTID -- hostname -I"
fi
