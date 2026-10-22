#!/usr/bin/env bash
# REST history pagination at several concurrency levels: run-history.sh [vus...] (default 10 50 200)
# Needs a seeded world (setup.ts + seed-history.ts) at loadtest/.work/world-hist.json.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
date_tag="$(date +%F)"
levels=("$@"); [ ${#levels[@]} -eq 0 ] && levels=(10 50 200)
for v in "${levels[@]}"; do
  for attempt in $(seq 1 30); do
    if bash "$ROOT/loadtest/scripts/load.sh" guard >/dev/null; then break; fi
    sleep 20
  done
  name="history-vus$v"
  bash "$ROOT/loadtest/scripts/k6.sh" history.js "$name" WORLD=/work/world-hist.json "VUS=$v" DURATION=20s \
    >"$ROOT/loadtest/.work/out/$name.log" 2>&1
  cp "$ROOT/loadtest/.work/out/$name.json" "$ROOT/loadtest/results/$date_tag-$name.k6.json"
  node -e "
    const m = JSON.parse(require('fs').readFileSync('$ROOT/loadtest/results/$date_tag-$name.k6.json')).metrics;
    const d = m['http_req_duration{name:history}'] ?? m.http_req_duration;
    console.log('vus=$v', 'requests', m.http_reqs.count, 'req/s', m.http_reqs.rate.toFixed(0),
      'p50', d.med.toFixed(1), 'p95', d['p(95)'].toFixed(1), 'p99', d['p(99)'].toFixed(1), 'failed', m.http_req_failed.value);"
  sleep 8
done
