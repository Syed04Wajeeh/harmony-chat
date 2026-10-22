#!/usr/bin/env bash
# Manage the isolated `harmony-load` stack. Never touches the production `harmony` project.
#   load.sh up | down | ps | logs [service] | guard
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT/deploy/load/compose.load.yml"
ENV_FILE="$ROOT/deploy/load/.env"
PROJECT=harmony-load

dc() { docker compose -p "$PROJECT" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

ensure_env() {
  if [ ! -f "$ENV_FILE" ]; then
    umask 077
    {
      echo "PROXY_SHARED_SECRET=$(openssl rand -hex 32)"
      echo "LOAD_PG_PASSWORD=$(openssl rand -hex 16)"
      echo "PUBLIC_ORIGIN=https://load.example.test"
    } >"$ENV_FILE"
  fi
}

# Refuse to start a heavy run when the shared host is busy (load average > 6, < 2.5 GB available).
guard() {
  local load avail
  load="$(cut -d' ' -f1 /proc/loadavg)"
  avail="$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)"
  echo "host load1=$load available_mb=$avail"
  if awk -v l="$load" 'BEGIN { exit !(l > 6) }'; then echo "ABORT: load average above 6" >&2; exit 2; fi
  if [ "$avail" -lt 2500 ]; then echo "ABORT: available memory below 2500 MB" >&2; exit 2; fi
}

case "${1:-}" in
  up)
    guard
    ensure_env
    dc up -d --build --wait
    echo "harmony-load is up: http://127.0.0.1:8570 (balanced), :8571 (app1), :8572 (app2)"
    ;;
  down)
    if [ -f "$ENV_FILE" ]; then dc down -v --remove-orphans; fi
    docker image rm harmony-load-app:local >/dev/null 2>&1 || true
    rm -f "$ENV_FILE"
    ;;
  ps) dc ps ;;
  logs) shift; dc logs --no-color "$@" ;;
  guard) guard ;;
  env) ensure_env; echo "$ENV_FILE" ;;
  *) echo "usage: $0 up|down|ps|logs|guard" >&2; exit 64 ;;
esac
