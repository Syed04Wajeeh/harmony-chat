#!/bin/sh
# Post a message to a Harmony channel through an incoming webhook.
#
# 1. Create the webhook (guild owner or instance admin); the URL path is shown only once:
#      curl -H 'Tailscale-User-Login: you@example.com' -H "Origin: $PUBLIC_ORIGIN" \
#           -H 'Content-Type: application/json' -X POST \
#           http://127.0.0.1:8470/api/channels/<channel id>/webhooks -d '{"name": "Backups"}'
# 2. Export the host-local integration ingress and the path from the response:
#      export HARMONY_WEBHOOK_URL=http://127.0.0.1:8471/api/webhooks/<id>/<token>
#
# Usage: post-from-script.sh "message text" [username]
set -eu

: "${HARMONY_WEBHOOK_URL:?set HARMONY_WEBHOOK_URL}"
text=${1:?usage: post-from-script.sh "message text" [username]}
username=${2:-Script}

# jq builds the JSON so quotes and newlines in the message cannot break the payload.
payload=$(jq -n --arg content "$text" --arg username "$username" \
  '{content: $content, username: $username}')

# 204 No Content on success; add ?wait=true to get the created message back.
curl --fail --silent --show-error \
  -H 'Content-Type: application/json' \
  -d "$payload" \
  "$HARMONY_WEBHOOK_URL"
