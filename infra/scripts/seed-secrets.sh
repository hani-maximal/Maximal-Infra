#!/usr/bin/env bash
# Writes integration credentials to the app-config Secrets Manager secret.
# Run once after `tofu apply`, and again whenever credentials change.
# DB credentials are managed automatically by RDS and do not need seeding.
#
# Usage:
#   export JWT_SECRET="$(openssl rand -hex 32)"
#   export GITHUB_APP_ID=123456
#   export GITHUB_PRIVATE_KEY="$(cat /path/to/maximal-infra-fixes.private-key.pem)"
#   export GITHUB_INSTALLATION_ID=78901234
#   ./infra/scripts/seed-secrets.sh [name] [aws-profile]
#
# Optional vars:
#   GITHUB_TOKEN         — PAT alternative to GitHub App credentials
#   SLACK_BOT_TOKEN      — xoxb-... token
#   SLACK_CHANNEL        — channel ID for approval messages
#   AWS_PROFILE          — named AWS profile (or pass as second argument)

set -euo pipefail

NAME=${1:-maximal}
PROFILE=${2:-${AWS_PROFILE:-}}

AWS_ARGS=()
[[ -n "$PROFILE" ]] && AWS_ARGS+=(--profile "$PROFILE")

SECRET_NAME="${NAME}/app-config"

echo "Seeding Secrets Manager: $SECRET_NAME"

SECRET_JSON=$(jq -n \
  --arg jwt      "${JWT_SECRET:?JWT_SECRET is required}" \
  --arg gh_token "${GITHUB_TOKEN:-}" \
  --arg gh_app   "${GITHUB_APP_ID:-}" \
  --arg gh_key   "${GITHUB_PRIVATE_KEY:-}" \
  --arg gh_inst  "${GITHUB_INSTALLATION_ID:-}" \
  --arg slack_tok "${SLACK_BOT_TOKEN:-}" \
  --arg slack_chan "${SLACK_CHANNEL:-}" \
  '{
    jwt_secret:             $jwt,
    github_token:           $gh_token,
    github_app_id:          $gh_app,
    github_private_key:     $gh_key,
    github_installation_id: $gh_inst,
    slack_bot_token:        $slack_tok,
    slack_channel:          $slack_chan
  }')

aws secretsmanager put-secret-value \
  "${AWS_ARGS[@]}" \
  --secret-id "$SECRET_NAME" \
  --secret-string "$SECRET_JSON"

echo "Done."
