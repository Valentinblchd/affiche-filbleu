# Deployment

## Proxmox CT direct

Recommended for the in-app update flow:

1. Create a Debian 12 CT.
2. Give it outbound internet access.
3. Install from the repository with `scripts/install-ct.sh`.

Local run from a copied project:

```bash
APP_REPO_URL=https://github.com/ton-compte/affiche-filbleu.git ./scripts/install-ct.sh
```

One-line install once this repository is hosted online:

```bash
APP_REPO_URL=https://github.com/ton-compte/affiche-filbleu.git bash <(curl -fsSL https://raw.githubusercontent.com/ton-compte/affiche-filbleu/main/scripts/install-ct.sh)
```

This mode enables:

- systemd service startup
- update detection from the UI
- confirm-before-update from the UI
- automatic restart after update

## Ready image

A ready-to-load Docker image is available in this project:

```text
affiche-filbleu-image.tar
```

On the target server:

```bash
docker load -i affiche-filbleu-image.tar
docker run -d --name affiche-filbleu --restart unless-stopped -p 3173:3173 affiche-filbleu:latest
```

Open:

```text
http://IP_DU_SERVEUR:3173
```

## Quick start script

You can also run:

```bash
./run-docker-image.sh
```

## Rebuild locally

```bash
docker compose up -d --build
```

## Proxmox CT

Recommended:

1. Create a Debian 12 CT.
2. Install Docker inside it.
3. Copy this project into the CT.
4. Run `./run-docker-image.sh` or `docker compose up -d --build`.

The app needs outbound internet access for Fil Bleu data and address lookup.
