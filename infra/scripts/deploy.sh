#!/usr/bin/env bash
# Deploys the realtime backend to the EC2 instance.
#
# Prereqs:
#   - `terraform apply` has succeeded in infra/terraform
#   - SSH key configured OR aws-cli with SSM Session Manager plugin
#   - Node + pnpm on your laptop
#
# Usage:
#   infra/scripts/deploy.sh
#
# Strategy:
#   1. Build apps/realtime locally
#   2. Tarball: dist + package.json + node_modules
#   3. Upload to /tmp on the instance (via SSH or SSM file transfer)
#   4. Atomically swap /opt/vtm/app
#   5. pm2 reload

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

EC2_HOST="${EC2_HOST:-}"
SSH_KEY="${SSH_KEY:-}"

if [ -z "$EC2_HOST" ]; then
  EC2_HOST="$(cd infra/terraform && terraform output -raw ec2_public_ip 2>/dev/null || true)"
fi
if [ -z "$EC2_HOST" ]; then
  echo "ERROR: set EC2_HOST=<ip> or run from a directory where 'terraform output' works."
  exit 1
fi

echo "→ Building realtime backend..."
pnpm --filter @vtm/realtime --filter @vtm/shared install
pnpm --filter @vtm/realtime build

echo "→ Packaging..."
TMP="$(mktemp -d)"
cp -R apps/realtime/dist "$TMP/dist"
cp apps/realtime/package.json "$TMP/"
cp -R apps/realtime/node_modules "$TMP/node_modules"
cp -R packages/shared "$TMP/shared"
cp -R node_modules "$TMP/root_node_modules" 2>/dev/null || true
tar -C "$TMP" -czf vtm-app.tgz .

echo "→ Uploading..."
SSH_OPTS=()
if [ -n "$SSH_KEY" ]; then SSH_OPTS=(-i "$SSH_KEY"); fi
SSH_OPTS+=(-o StrictHostKeyChecking=accept-new)

scp "${SSH_OPTS[@]}" vtm-app.tgz "ubuntu@${EC2_HOST}:/tmp/vtm-app.tgz"

ssh "${SSH_OPTS[@]}" "ubuntu@${EC2_HOST}" bash <<'REMOTE'
set -euo pipefail
sudo install -d -o vtm -g vtm /opt/vtm/app.new
sudo tar -C /opt/vtm/app.new -xzf /tmp/vtm-app.tgz
sudo chown -R vtm:vtm /opt/vtm/app.new

# Atomic swap
sudo rm -rf /opt/vtm/app.old || true
if [ -d /opt/vtm/app ]; then sudo mv /opt/vtm/app /opt/vtm/app.old; fi
sudo mv /opt/vtm/app.new /opt/vtm/app

# (Re)start with pm2 — runs under the vtm user
sudo -u vtm bash -lc '
  cd /opt/vtm/app
  export $(grep -v "^#" /opt/vtm/.env | xargs -d "\n")
  pm2 describe vtm > /dev/null 2>&1 \
    && pm2 reload vtm \
    || pm2 start dist/server.js --name vtm --max-restarts 10 --time
  pm2 save
'

rm -f /tmp/vtm-app.tgz
echo "→ Deploy complete."
REMOTE

rm -rf "$TMP" vtm-app.tgz
echo "✓ Deployed to $EC2_HOST"
