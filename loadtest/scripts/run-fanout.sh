#!/usr/bin/env bash
# One fan-out run: host guard, docker-stats sampler, k6, then copy the raw summary into results/.
#   run-fanout.sh <label> <two|one> <rate> [send_seconds]
# `one` sends everything to app1 only (nginx :8571); stop app2 yourself first so it is truly one
# instance. Output: loadtest/results/<date>-fanout-<label>-<mode>-<rate>.k6.json and .stats.csv
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
label="$1"; mode="$2"; rate="$3"; secs="${4:-30}"
world="${WORLD_FILE:-world-fan.json}"
date_tag="$(date +%F)"
name="fanout-$label-$mode-$rate"
base="http://127.0.0.1:8570"; [ "$mode" = one ] && base="http://127.0.0.1:8571"

# The guard also counts this stack's own leftover load from the previous run, so wait for it to
# settle (up to 10 minutes) instead of failing; a host that stays busy aborts the run.
for attempt in $(seq 1 30); do
  if bash "$ROOT/loadtest/scripts/load.sh" guard; then break; fi
  [ "$attempt" = 30 ] && { echo "ABORTED $name: host stayed busy"; exit 2; }
  sleep 20
done
echo "== $name: rate=$rate/s for ${secs}s base=$base"
total=$(( secs + 60 ))
node "$ROOT/loadtest/scripts/stats.ts" "$ROOT/loadtest/.work/out/$name.stats.csv" "$total" 2 &
sampler=$!
bash "$ROOT/loadtest/scripts/k6.sh" fanout.js "$name" "WORLD=/work/$world" "RATE=$rate" "SEND_SECONDS=$secs" "BASE=$base" >"$ROOT/loadtest/.work/out/$name.log" 2>&1
kill "$sampler" 2>/dev/null; wait "$sampler" 2>/dev/null
cp "$ROOT/loadtest/.work/out/$name.json" "$ROOT/loadtest/results/$date_tag-$name.k6.json"
cp "$ROOT/loadtest/.work/out/$name.stats.csv" "$ROOT/loadtest/results/$date_tag-$name.stats.csv"
node "$ROOT/loadtest/scripts/tabulate.ts" "$ROOT/loadtest/results/$date_tag-$name.k6.json" "$secs"
