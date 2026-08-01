#!/usr/bin/env bash
# Alternative to deploy hooks: trigger a Render deploy with your API key.
# Uses RENDER_API_KEY (already in your terminal env) + a service id.
#
#   RENDER_SERVICE_ID=srv-xxxx ./scripts/render-deploy.sh
#
# Verify the current Render API base/paths against Render's docs before relying
# on this in automation — treat the endpoint below as needing confirmation.
set -euo pipefail

: "${RENDER_API_KEY:?Set RENDER_API_KEY in your shell}"
: "${RENDER_SERVICE_ID:?Set RENDER_SERVICE_ID (e.g. srv-xxxx)}"

curl -fsS -X POST "https://api.render.com/v1/services/${RENDER_SERVICE_ID}/deploys" \
  -H "Authorization: Bearer ${RENDER_API_KEY}" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  -d '{}'

echo
echo "Deploy requested for ${RENDER_SERVICE_ID}."
