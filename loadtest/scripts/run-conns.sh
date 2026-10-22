#!/usr/bin/env bash
# One connection-capacity run: run-conns.sh <target> [ramp_s] [hold_s] [vus]
# Safety: the guard runs first, and a watchdog kills k6 if the host load average exceeds 12 or
# available memory drops under 1500 MB. k6 itself aborts when more than 1% of attempts fail.
# Samples docker stats during the run and counts established client connections at nginx mid-hold.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
target="$1"; ramp="${2:-60}"; hold="${3:-30}"; vus="${4:-100}"
date_tag="$(date +%F)"
name="connections-$target"
for attempt in $(seq 1 30); do
  if bash "$ROOT/loadtest/scripts/load.sh" guard; then break; fi
  [ "$attempt" = 30 ] && { echo "ABORTED $name: host stayed busy"; exit 2; }
  sleep 20
done
total=$(( ramp + hold + 40 ))
node "$ROOT/loadtest/scripts/stats.ts" "$ROOT/loadtest/.work/out/$name.stats.csv" "$total" 2 &
sampler=$!
export K6_NAME="k6-$name"
bash "$ROOT/loadtest/scripts/k6.sh" connections.js "$name" WORLD=/work/world-cap.json "TARGET=$target" \
  "VUS=$vus" "RAMP_SECONDS=$ramp" "HOLD_SECONDS=$hold" >"$ROOT/loadtest/.work/out/$name.log" 2>&1 &
k6pid=$!
: >"$ROOT/loadtest/.work/out/$name.established.txt"
aborted=""
start=$(date +%s)
while kill -0 "$k6pid" 2>/dev/null; do
  sleep 3
  el=$(( $(date +%s) - start ))
  load1="$(cut -d' ' -f1 /proc/loadavg)"
  avail="$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)"
  # established TCP connections to the nginx listener (client side of the WebSockets)
  est="$(ss -Htn state established '( sport = :8570 )' | wc -l)"
  echo "t=${el}s established=$est load1=$load1 avail_mb=$avail" >>"$ROOT/loadtest/.work/out/$name.established.txt"
  if awk -v l="$load1" 'BEGIN { exit !(l > 12) }' || [ "$avail" -lt 1500 ]; then
    echo "WATCHDOG: host limit hit (load1=$load1 avail=$avail); killing k6" | tee -a "$ROOT/loadtest/.work/out/$name.established.txt"
    aborted="host-safety-limit"
    docker kill "$K6_NAME" >/dev/null 2>&1
    break
  fi
done
wait "$k6pid" 2>/dev/null
kill "$sampler" 2>/dev/null; wait "$sampler" 2>/dev/null
cp "$ROOT/loadtest/.work/out/$name.json" "$ROOT/loadtest/results/$date_tag-$name.k6.json" 2>/dev/null
cp "$ROOT/loadtest/.work/out/$name.stats.csv" "$ROOT/loadtest/results/$date_tag-$name.stats.csv"
cp "$ROOT/loadtest/.work/out/$name.established.txt" "$ROOT/loadtest/results/$date_tag-$name.established.txt"
echo "done $name aborted=${aborted:-no}"
tail -5 "$ROOT/loadtest/.work/out/$name.log"
