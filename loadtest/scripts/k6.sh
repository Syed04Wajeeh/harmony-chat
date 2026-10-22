#!/usr/bin/env bash
# Run one k6 script in the pinned grafana/k6 image with a CPU cap, on the host network (so it
# reaches the 127.0.0.1-only nginx listeners). Writes the summary to loadtest/.work/out/<name>.json.
#   k6.sh <script.js> <name> [KEY=VALUE ...]      env: K6_CPUS (default 3)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
K6_IMAGE="grafana/k6:1.3.0"
script="$1"; name="$2"; shift 2
mkdir -p "$ROOT/loadtest/.work/out"
chmod 777 "$ROOT/loadtest/.work/out"
envs=()
for kv in "$@"; do envs+=(-e "$kv"); done
exec docker run --rm ${K6_NAME:+--name $K6_NAME} --network host --cpus "${K6_CPUS:-3}" --memory 6g \
  --ulimit nofile=1048576:1048576 \
  -v "$ROOT/loadtest/k6:/k6:ro" -v "$ROOT/loadtest/.work:/work:ro" \
  -v "$ROOT/loadtest/.work/out:/out" \
  "$K6_IMAGE" run --quiet --summary-export "/out/$name.json" "${envs[@]}" "/k6/$script"
