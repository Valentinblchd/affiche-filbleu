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
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-}"
ROOTFS_STORAGE="${ROOTFS_STORAGE:-}"
BRIDGE="${BRIDGE:-vmbr0}"
CORES="${CORES:-2}"
MEMORY_MB="${MEMORY_MB:-2048}"
SWAP_MB="${SWAP_MB:-512}"
DISK_GB="${DISK_GB:-8}"
UNPRIVILEGED="${UNPRIVILEGED:-1}"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Commande manquante: $1"
    exit 1
  fi
}

need_cmd pveam
need_cmd pct
need_cmd pvesm
need_cmd curl
need_cmd awk
need_cmd sort

find_storage() {
  content_type="$1"
  pvesm status --enabled 1 --content "$content_type" 2>/dev/null \
    | awk 'NR > 1 { print $1; exit }'
}

if [ -z "$TEMPLATE_STORAGE" ]; then
  TEMPLATE_STORAGE="$(find_storage vztmpl)"
fi

if [ -z "$ROOTFS_STORAGE" ]; then
  ROOTFS_STORAGE="$(find_storage rootdir)"
fi

if [ -z "$TEMPLATE_STORAGE" ]; then
  echo "Aucun storage avec le contenu 'vztmpl' n'a ete trouve. Definis TEMPLATE_STORAGE."
  exit 1
fi

if [ -z "$ROOTFS_STORAGE" ]; then
  echo "Aucun storage avec le contenu 'rootdir' n'a ete trouve. Definis ROOTFS_STORAGE."
  exit 1
fi

if [ -z "$CTID" ]; then
  if command -v pvesh >/dev/null 2>&1; then
    CTID="$(pvesh get /cluster/nextid)"
  else
    CTID=200
    while pct status "$CTID" >/dev/null 2>&1; do
      CTID=$((CTID + 1))
    done
  fi
fi

if pct status "$CTID" >/dev/null 2>&1; then
  echo "Le CTID $CTID existe deja. Change CTID."
  exit 1
fi

echo "Recherche du template Debian 12..."
pveam update >/dev/null
template_name="$(
  pveam available --section system \
    | awk '/debian-12-standard_.*amd64/ { print $2 }' \
    | sort -V \
    | tail -n 1
)"

if [ -z "$template_name" ]; then
  echo "Impossible de trouver un template Debian 12 standard."
  exit 1
fi

template_volume="$(
  pveam list "$TEMPLATE_STORAGE" \
    | awk -v template="$template_name" '$1 ~ template { print $1; exit }'
)"

if [ -z "$template_volume" ]; then
  echo "Telechargement du template $template_name..."
  pveam download "$TEMPLATE_STORAGE" "$template_name"
  template_volume="$(
    pveam list "$TEMPLATE_STORAGE" \
      | awk -v template="$template_name" '$1 ~ template { print $1; exit }'
  )"
fi

if [ -z "$template_volume" ]; then
  echo "Le template Debian 12 n'a pas pu etre prepare."
  exit 1
fi

root_password="$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 20)"

echo "Creation du CT $CTID ($CT_HOSTNAME)..."
pct create "$CTID" "$template_volume" \
  --hostname "$CT_HOSTNAME" \
  --cores "$CORES" \
  --memory "$MEMORY_MB" \
  --swap "$SWAP_MB" \
  --rootfs "${ROOTFS_STORAGE}:${DISK_GB}" \
  --net0 "name=eth0,bridge=${BRIDGE},ip=dhcp,type=veth" \
  --onboot 1 \
  --unprivileged "$UNPRIVILEGED" \
  --features nesting=1 \
  --password "$root_password"

echo "Demarrage du CT..."
pct start "$CTID"

echo "Preparation du CT..."
ready=0
attempt=1
while [ "$attempt" -le 15 ]; do
  if pct exec "$CTID" -- bash -lc "apt-get update >/dev/null 2>&1"; then
    ready=1
    break
  fi
  sleep 4
  attempt=$((attempt + 1))
done

if [ "$ready" -ne 1 ]; then
  echo "Le CT n'a pas obtenu de reseau a temps. Verifie le bridge/DHCP puis relance."
  exit 1
fi

pct exec "$CTID" -- bash -lc "apt-get install -y ca-certificates curl"

echo "Installation de l'application dans le CT..."
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
echo "CT cree et configure."
echo "CTID: $CTID"
echo "Nom: $CT_HOSTNAME"
echo "Mot de passe root du CT: $root_password"
if [ -n "$ct_ip" ]; then
  echo "Interface: http://$ct_ip:3173"
else
  echo "IP DHCP non detectee tout de suite. Fais: pct exec $CTID -- hostname -I"
fi
