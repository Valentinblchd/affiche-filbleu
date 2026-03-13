#!/bin/sh

set -eu

IMAGE_TAR="${IMAGE_TAR:-./affiche-filbleu-image.tar}"
IMAGE_NAME="${IMAGE_NAME:-affiche-filbleu:latest}"
CONTAINER_NAME="${CONTAINER_NAME:-affiche-filbleu}"
HOST_PORT="${HOST_PORT:-3173}"
APP_PORT="${APP_PORT:-3173}"

docker load -i "$IMAGE_TAR"

if docker ps -a --format '{{.Names}}' | grep -Fxq "$CONTAINER_NAME"; then
  docker rm -f "$CONTAINER_NAME" >/dev/null
fi

docker run -d \
  --name "$CONTAINER_NAME" \
  --restart unless-stopped \
  -p "${HOST_PORT}:${APP_PORT}" \
  "$IMAGE_NAME"

printf 'Affiche Fil Bleu disponible sur http://127.0.0.1:%s\n' "$HOST_PORT"
