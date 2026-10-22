#!/usr/bin/env bash
# Build and roll out the stack. nginx config is bind-mounted, so compose does not notice when
# it changes; restart the proxies only when deploy/nginx differs from the last deploy.
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose up -d --build --remove-orphans

state=.deploy-nginx.sha
current=$(cat deploy/nginx/* | sha256sum | cut -d' ' -f1)
if [[ ! -f $state || $(cat "$state") != "$current" ]]; then
  echo "nginx config changed, restarting proxies"
  docker compose restart nginx integrations
  echo "$current" > "$state"
fi

docker compose ps
