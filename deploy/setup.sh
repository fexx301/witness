#!/usr/bin/env bash
# Sets up the hosted Witness desk on a fresh Ubuntu 24.04 server (AWS Lightsail or EC2), and updates it
# when run again. Run it as a user with sudo:
#   bash setup.sh <your-name>.duckdns.org
# Before the first run: point the DuckDNS name at the server's static IP and open ports 80 and 443.
set -euo pipefail
DOMAIN="${1:?usage: bash setup.sh <your-name>.duckdns.org}"
REPO=https://github.com/fexx301/witness
APP=/opt/witness

# Node 22 and Caddy, from their official repositories.
sudo apt-get update
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
if ! command -v caddy >/dev/null; then
  sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update && sudo apt-get install -y caddy
fi
# Building the desk needs more memory than the smallest servers have.
if [ "$(free -m | awk '/Mem:/ {print $2}')" -lt 2000 ] && ! swapon --show | grep -q .; then
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

id witness >/dev/null 2>&1 || sudo useradd --system --home "$APP" --shell /usr/sbin/nologin witness
[ -d "$APP/.git" ] || sudo git clone "$REPO" "$APP"
# Owned by the service user, so git runs as that user too.
sudo chown -R witness:witness "$APP"
sudo -u witness git -C "$APP" pull --ff-only
if [ ! -f "$APP/.env" ]; then
  echo "Copy your .env to $APP/.env (and your data/ folder to $APP/data), then run this again." >&2
  exit 1
fi
sudo chmod 600 "$APP/.env"
sudo -u witness bash -c "cd $APP && npm ci && cd desk && npm ci && npm run build"

sudo install -m 644 "$APP/deploy/witness.service" /etc/systemd/system/witness.service
sed "s/WITNESS_DOMAIN/$DOMAIN/" "$APP/deploy/Caddyfile" | sudo tee /etc/caddy/Caddyfile >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable witness && sudo systemctl restart witness
sudo systemctl reload caddy
echo "Witness desk: https://$DOMAIN"
