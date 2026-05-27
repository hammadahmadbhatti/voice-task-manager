#!/usr/bin/env bash
# Deploys the realtime backend to EC2 via SSM RunCommand (no SSH needed).
#
# Usage:
#   infra/scripts/deploy-ssm.sh                  # builds + uploads + deploys
#   DEPLOY_ID=manual-123 infra/scripts/deploy-ssm.sh    # re-deploys existing artifact in S3
#
# Prereqs:
#   - terraform apply has succeeded
#   - aws-cli configured
#   - jq installed
#   - pnpm installed (only if building a new artifact)

set -eu

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

INSTANCE_ID=$(terraform -chdir=infra/terraform output -raw ec2_instance_id)
BUCKET=$(terraform -chdir=infra/terraform output -raw audio_bucket)

# If DEPLOY_ID isn't set, build a new artifact + upload it.
if [ -z "${DEPLOY_ID:-}" ]; then
  echo "→ Installing + building shared + realtime..."
  pnpm install --frozen-lockfile >/dev/null
  pnpm --filter @vtm/shared build >/dev/null
  pnpm --filter @vtm/realtime build >/dev/null

  # pnpm deploy produces a portable, flat node_modules tree (no symlinks)
  # with only production deps + the workspace deps bundled in. This is
  # exactly what we need for a self-contained EC2 artifact.
  echo "→ Running pnpm deploy → portable artifact..."
  DEPLOY_DIR=$(mktemp -d)
  rm -rf "$DEPLOY_DIR"     # pnpm deploy wants the dir to NOT exist
  pnpm --filter @vtm/realtime --prod deploy "$DEPLOY_DIR" >/dev/null

  DEPLOY_ID="manual-$(date +%s)"
  # macOS BSD tar: --no-mac-metadata strips com.apple.* extended attrs
  # that GNU tar on Linux warns about. Falls back gracefully on Linux.
  echo "→ Packing artifact..."
  TAR_FLAGS=""
  if tar --no-mac-metadata --version >/dev/null 2>&1; then
    TAR_FLAGS="--no-mac-metadata"
  fi
  COPYFILE_DISABLE=1 tar $TAR_FLAGS -C "$DEPLOY_DIR" -czf vtm-app.tgz .

  echo "→ Uploading to s3://$BUCKET/deploys/${DEPLOY_ID}.tgz ($(du -h vtm-app.tgz | cut -f1))"
  aws s3 cp --no-progress vtm-app.tgz "s3://$BUCKET/deploys/${DEPLOY_ID}.tgz"

  rm -rf "$DEPLOY_DIR" vtm-app.tgz
else
  echo "→ Reusing existing artifact: $DEPLOY_ID"
fi

echo "→ Triggering SSM deploy on $INSTANCE_ID"

# The script that runs ON the EC2. Note: AWS-RunShellScript executes via
# /bin/sh (dash on Ubuntu). Outer is POSIX-safe; inner pm2 block uses bash.
INNER_SCRIPT=$(cat <<'REMOTE'
set -eu
DEPLOY_ID="__DEPLOY_ID__"
BUCKET="__BUCKET__"

echo "[deploy] downloading artifact..."
# --no-progress: hide the byte-by-byte progress bar (otherwise SSM captures
# every progress refresh as separate output, drowning out the actual log).
aws s3 cp --no-progress "s3://${BUCKET}/deploys/${DEPLOY_ID}.tgz" /tmp/app.tgz

echo "[deploy] unpacking..."
sudo install -d -o vtm -g vtm /opt/vtm/app.new
sudo tar -C /opt/vtm/app.new -xzf /tmp/app.tgz
sudo chown -R vtm:vtm /opt/vtm/app.new

echo "[deploy] atomic swap..."
sudo rm -rf /opt/vtm/app.old 2>/dev/null || true
if [ -d /opt/vtm/app ]; then sudo mv /opt/vtm/app /opt/vtm/app.old; fi
sudo mv /opt/vtm/app.new /opt/vtm/app

echo "[deploy] pm2 (re)start..."
sudo -u vtm bash -lc '
  set -euo pipefail
  cd /opt/vtm/app
  export $(grep -v "^#" /opt/vtm/.env | xargs -d "\n")
  if pm2 describe vtm >/dev/null 2>&1; then
    pm2 reload vtm --update-env
  else
    pm2 start dist/server.js --name vtm --max-restarts 10 --time
  fi
  pm2 save
'

echo "[deploy] health probe..."
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  if curl -fsS --max-time 2 http://127.0.0.1:4000/health >/dev/null; then
    echo "[deploy] healthy on attempt $i"
    rm -f /tmp/app.tgz
    exit 0
  fi
  sleep 1
done
echo "[deploy] HEALTH FAILED — pm2 status:"
sudo -u vtm pm2 list
sudo -u vtm pm2 logs vtm --lines 40 --nostream
exit 1
REMOTE
)

# Substitute placeholders (single-quote heredoc above prevents shell expansion)
INNER_SCRIPT="${INNER_SCRIPT//__DEPLOY_ID__/$DEPLOY_ID}"
INNER_SCRIPT="${INNER_SCRIPT//__BUCKET__/$BUCKET}"

PARAMS=$(jq -n --arg cmd "$INNER_SCRIPT" '{commands: [$cmd]}')

CMD_ID=$(aws ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --document-name "AWS-RunShellScript" \
  --parameters "$PARAMS" \
  --comment "deploy $DEPLOY_ID" \
  --query "Command.CommandId" --output text)
echo "→ SSM command: $CMD_ID"
echo "→ Waiting for it to finish..."

aws ssm wait command-executed --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" 2>/dev/null || true

STATUS=$(aws ssm get-command-invocation \
  --command-id "$CMD_ID" \
  --instance-id "$INSTANCE_ID" \
  --query "Status" --output text)

echo ""
echo "==================== Output ===================="
# `cat` at the end forces no-pager — important for AWS CLI v2 which pages by default.
aws ssm get-command-invocation \
  --command-id "$CMD_ID" \
  --instance-id "$INSTANCE_ID" \
  --query "StandardOutputContent" --output text | cat

ERR=$(aws ssm get-command-invocation \
  --command-id "$CMD_ID" \
  --instance-id "$INSTANCE_ID" \
  --query "StandardErrorContent" --output text)
if [ -n "$ERR" ] && [ "$ERR" != "None" ]; then
  echo ""
  echo "==================== Stderr ===================="
  echo "$ERR" | cat
fi

echo ""
echo "==================== Status: $STATUS ===================="
[ "$STATUS" = "Success" ] || exit 1
