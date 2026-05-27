#!/usr/bin/env bash
# Pushes provider API keys to SSM Parameter Store as SecureString.
# The EC2 instance reads these at startup via userdata.
#
# Usage:
#   OPENAI_API_KEY=sk-... DEEPGRAM_API_KEY=... ELEVENLABS_API_KEY=... \
#     infra/scripts/put-secrets.sh

set -euo pipefail

PROJECT="${PROJECT:-vtm}"
ENVIRONMENT="${ENVIRONMENT:-dev}"
REGION="${AWS_REGION:-eu-central-1}"

put() {
  local name="$1"
  local value="$2"
  if [ -z "$value" ]; then
    echo "  - $name: (empty, skipping)"
    return
  fi
  aws ssm put-parameter \
    --region "$REGION" \
    --name "/${PROJECT}/${ENVIRONMENT}/${name}" \
    --value "$value" \
    --type SecureString \
    --overwrite >/dev/null
  echo "  ✓ $name"
}

echo "→ Writing SSM parameters to /${PROJECT}/${ENVIRONMENT}/* in ${REGION}"
put OPENAI_API_KEY           "${OPENAI_API_KEY:-}"
put DEEPGRAM_API_KEY         "${DEEPGRAM_API_KEY:-}"
put ELEVENLABS_API_KEY       "${ELEVENLABS_API_KEY:-}"
put ELEVENLABS_VOICE_ID_EN   "${ELEVENLABS_VOICE_ID_EN:-21m00Tcm4TlvDq8ikWAM}"
put ELEVENLABS_VOICE_ID_DE   "${ELEVENLABS_VOICE_ID_DE:-pNInz6obpgDQGcFmaJgB}"
echo "→ Done. EC2 picks these up on next reboot, or re-run userdata via:"
echo "    aws ec2 reboot-instances --instance-ids <id>"
