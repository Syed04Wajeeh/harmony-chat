#!/usr/bin/env bash
# Run a node script N times with the host guard before each run: repeat.sh <n> <outprefix> <script> [args...]
# Writes <outprefix>-<i>.json / .log and prints one line per run.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
n="$1"; prefix="$2"; script="$3"; shift 3
for i in $(seq 1 "$n"); do
  bash "$ROOT/loadtest/scripts/load.sh" guard >/dev/null || { echo "run $i aborted by host guard"; continue; }
  node "$ROOT/loadtest/scripts/$script" "$@" --out "$prefix-$i.json" >"$prefix-$i.log" 2>&1
  echo "run $i exit=$?"
done
