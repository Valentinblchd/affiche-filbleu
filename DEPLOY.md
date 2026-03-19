# Deployment

## Proxmox host one-line install

Run this on the Proxmox host shell as `root`:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Valentinblchd/affiche-filbleu/main/scripts/install-proxmox-host.sh)"
```

Defaults:

- CT hostname: `srv-filbleu`
- repo: `https://github.com/Valentinblchd/affiche-filbleu.git`
- branch: `main`
- DHCP network on `vmbr0`
- port: `3173`

You can override values if needed:

```bash
CT_HOSTNAME=srv-filbleu CTID=317 APP_BRANCH=main bash -c "$(curl -fsSL https://raw.githubusercontent.com/Valentinblchd/affiche-filbleu/main/scripts/install-proxmox-host.sh)"
```

## Proxmox CT direct

Recommended for the automatic CT update flow:

1. Create a Debian 12 CT.
2. Give it outbound internet access.
3. Install from the repository with `scripts/install-ct.sh`.

Local run from a copied project:

```bash
APP_REPO_URL=https://github.com/Valentinblchd/affiche-filbleu.git ./scripts/install-ct.sh
```

One-line install once this repository is hosted online:

```bash
CT_HOSTNAME=srv-filbleu APP_REPO_URL=https://github.com/Valentinblchd/affiche-filbleu.git bash <(curl -fsSL https://raw.githubusercontent.com/Valentinblchd/affiche-filbleu/main/scripts/install-ct.sh)
```

This mode enables:

- systemd service startup
- timezone fixed to `Europe/Paris`
- automatic background update checks
- automatic update apply without confirmation
- automatic restart after update

## Optional update-status protection

If the app is exposed on a LAN or behind a public reverse proxy, you can also protect `GET /api/update-status`:

- `UPDATE_STATUS_REQUIRE_AUTH=1`
- `UPDATE_API_TOKEN=<strong-secret>`

With this enabled, both `/api/update-status` and `/api/update-apply` only accept:

- loopback requests
- `Authorization: Bearer <token>`
- `X-Update-Token: <token>`

If you protect `/api/update-status`, browser-based auto-reload needs the same token through your reverse proxy or a simple auth layer in front of the app.

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
