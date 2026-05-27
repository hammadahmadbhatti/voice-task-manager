#!/usr/bin/env bash
# Runs on the EC2 instance via SSM RunCommand. Pulls a deploy artifact
# from S3, atomically swaps /opt/vtm/app, and reloads pm2.
#
# Invoked by .github/workflows/deploy-realtime.yml with two arguments:
#   $1 = s3://bucket/key of the .tar.gz artifact
#   $2 = deploy id (used as a tag for logging)

set -euo pipefail

S3_URI="${1:?missing s3 uri}"
DEPLOY_ID="${2:-$(date +%s)}"

log() {
  echo "[$(date -Iseconds)] [deploy:${DEPLOY_ID}] $*"
}

log "Downloading artifact: ${S3_URI}"
install -d -o vtm -g vtm /opt/vtm/incoming
aws s3 cp "${S3_URI}" /opt/vtm/incoming/app.tgz

log "Unpacking to /opt/vtm/app.new"
sudo install -d -o vtm -g vtm /opt/vtm/app.new
sudo tar -C /opt/vtm/app.new -xzf /opt/vtm/incoming/app.tgz
sudo chown -R vtm:vtm /opt/vtm/app.new

log "Atomic swap"
sudo rm -rf /opt/vtm/app.old 2>/dev/null || true
if [ -d /opt/vtm/app ]; then
  sudo mv /opt/vtm/app /opt/vtm/app.old
fi
sudo mv /opt/vtm/app.new /opt/vtm/app

log "Reloading pm2"
sudo -u vtm bash -lc '
  set -euo pipefail
  cd /opt/vtm/app
  export $(grep -v "^#" /opt/vtm/.env | xargs -d "\n")
  pm2 describe vtm >/dev/null 2>&1 \
    && pm2 reload vtm --update-env \
    || pm2 start dist/server.js --name vtm --max-restarts 10 --time
  pm2 save
'

log "Health check"
# pm2 reload is graceful, so wait briefly and then probe.
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS --max-time 2 http://127.0.0.1:4000/health >/dev/null; then
    log "Health OK on attempt $i"
    break
  fi
  if [ "$i" = "10" ]; then
    log "Health check failed — rolling back"
    sudo rm -rf /opt/vtm/app
    sudo mv /opt/vtm/app.old /opt/vtm/app
    sudo -u vtm bash -lc 'cd /opt/vtm/app && pm2 reload vtm --update-env'
    exit 1
  fi
  sleep 1
done

rm -f /opt/vtm/incoming/app.tgz
log "Deploy complete"
