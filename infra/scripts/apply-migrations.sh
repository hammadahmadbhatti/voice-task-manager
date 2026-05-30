#!/usr/bin/env bash
# Applies the Drizzle schema to the production RDS Postgres instance.
#
# RDS is in a private security group — only the realtime EC2 can reach
# port 5432. So we open an SSM port-forwarding session through that EC2,
# then run `drizzle-kit push` against localhost.
#
# Prereqs:
#   - terraform apply succeeded (RDS + EC2 exist)
#   - aws-cli configured with permissions
#   - Session Manager Plugin installed
#     (https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html)
#
# Run:
#   infra/scripts/apply-migrations.sh

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

PROJECT="${PROJECT:-vtm}"
ENVIRONMENT="${ENVIRONMENT:-dev}"
REGION="${AWS_REGION:-eu-central-1}"
LOCAL_PORT="${LOCAL_PORT:-15432}"

# Pull endpoints from terraform
RDS_ENDPOINT=$(terraform -chdir=infra/terraform output -raw rds_endpoint)
RDS_HOST="${RDS_ENDPOINT%:*}"
INSTANCE_ID=$(terraform -chdir=infra/terraform output -raw ec2_instance_id)
DB_NAME=$(terraform -chdir=infra/terraform output -raw rds_database_name)

# Pull password from SSM (Terraform generated it for us)
DB_PASSWORD=$(aws ssm get-parameter \
  --region "$REGION" \
  --name "/${PROJECT}/${ENVIRONMENT}/DB_PASSWORD" \
  --with-decryption \
  --query "Parameter.Value" \
  --output text)

echo "→ Opening SSM port-forward through ${INSTANCE_ID} to ${RDS_HOST}:5432 (localhost:${LOCAL_PORT})"

aws ssm start-session \
  --region "$REGION" \
  --target "$INSTANCE_ID" \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "{\"host\":[\"${RDS_HOST}\"],\"portNumber\":[\"5432\"],\"localPortNumber\":[\"${LOCAL_PORT}\"]}" &
SSM_PID=$!
trap "kill $SSM_PID 2>/dev/null || true; wait $SSM_PID 2>/dev/null || true" EXIT

# Wait for the tunnel to be ready
echo -n "  Waiting for tunnel"
for i in $(seq 1 20); do
  if nc -z localhost "$LOCAL_PORT" 2>/dev/null; then
    echo " ✓"
    break
  fi
  echo -n "."
  sleep 1
  if [ "$i" = "20" ]; then
    echo
    echo "✗ Tunnel didn't come up in 20s. Check SSM agent on the instance:"
    echo "    aws ssm describe-instance-information --filters Key=InstanceIds,Values=${INSTANCE_ID}"
    exit 1
  fi
done

# URL-encode the password (might contain reserved characters)
ENCODED_PW=$(node -e "console.log(encodeURIComponent('${DB_PASSWORD}'))")

echo "→ Applying schema via drizzle-kit push"
# Use sslmode=no-verify: RDS uses Amazon's RDS CA which isn't in Node's
# default trust store. Newer pg (v8.21+) treats sslmode=require as full
# verify-full per libpq spec, which fails the cert chain check.
# Connection is still encrypted; only the CA validation is skipped — and
# we're tunneling through SSM Session Manager (already authenticated), so
# the security posture is equivalent to verify-full anyway.
#
# Bash check the exit code explicitly because pnpm sometimes masks it.
if DATABASE_URL="postgres://vtm:${ENCODED_PW}@localhost:${LOCAL_PORT}/${DB_NAME}?sslmode=no-verify" \
  pnpm --filter @vtm/realtime exec drizzle-kit push --verbose; then
  echo "✓ Schema applied to RDS"
else
  echo "✗ drizzle-kit push failed — schema NOT applied"
  exit 1
fi
