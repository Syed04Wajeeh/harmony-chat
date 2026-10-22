#!/usr/bin/env bash
# Fan-out rate sweep: sweep.sh <label> <two|one> <rate>...   (stops early after a run that errors)
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
label="$1"; mode="$2"; shift 2
for rate in "$@"; do
  bash "$ROOT/loadtest/scripts/run-fanout.sh" "$label" "$mode" "$rate" 30 | tail -1
  sleep 10
done
