#!/usr/bin/env bash
# Keyless restart check for lifecycle-lite (docs/benchmarks/2026-10-06-oss-memory-shootout-lifecycle-lite-preregistration.md).
#
# For each system named: the shared fake provider (eval/systems/_shim/fake_provider.py) stands where the metering
# proxy stands, the system's stack comes up at its common configuration through bootstrap.sh, lifecycle-lite runs one
# seed with a restart through `bootstrap.sh restart`, and the stack comes down. It shows whether a restart loses state
# for shim reasons; with canned provider answers its scores say nothing about memory quality. No provider key is used.
#
#   bash eval/systems/restart_check.sh markdown-notes extract-first temporal-graph memory-bank graph-pipeline
#
# FAKE_PROVIDER=<script> swaps in a vendor's own fake provider (extract-first's: eval/systems/extract-first/fake_provider.py), with
# BOOTSTRAP_PROXY_CHECK=off since it has no proxy status route; other variables reach the compose stack, so
# MEMORY_BANK_LLM_PROVIDER=mock selects memory-bank's built-in test LLM.
#
# Results per system in eval/reports/restart-check/<system>/ (RESTART_CHECK_OUT moves them): up, lifecycle-lite and
# compose logs, and the lifecycle-lite run directory with its receipt. Exits non-zero if any system failed to come up
# or its run was not complete.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
OUT=${RESTART_CHECK_OUT:-eval/reports/restart-check}
FAKE_PORT=${FAKE_PROVIDER_PORT:-18787}
SHIM_PORT=${RESTART_CHECK_SHIM_PORT:-18700}
SEEDS=${RESTART_CHECK_SEEDS:-1}
[ $# -gt 0 ] || { sed -n '2,13p' "$0" >&2; exit 2; }
mkdir -p "$OUT"

python3 "${FAKE_PROVIDER:-eval/systems/_shim/fake_provider.py}" --port "$FAKE_PORT" --log "$OUT/fake-provider.jsonl" >"$OUT/fake-provider.log" 2>&1 &
FAKE_PID=$!
trap 'kill "$FAKE_PID" 2>/dev/null || true' EXIT
up() { curl -s -o /dev/null "http://127.0.0.1:$FAKE_PORT/"; }
for _ in $(seq 1 100); do up && break; sleep 0.1; done
up || { echo "restart_check: the fake provider did not start" >&2; exit 1; }

status=0
for sys in "$@"; do
  dir="$OUT/$sys"
  rm -rf "$dir" && mkdir -p "$dir"
  echo "restart_check: $sys" >&2
  if bash eval/systems/bootstrap.sh up --system "$sys" --config common --port "$SHIM_PORT" --proxy-port "$FAKE_PORT" --timeout 900 >"$dir/up.log" 2>&1; then
    bun eval/runner/lifecycle-lite.ts --system "http://127.0.0.1:$SHIM_PORT" --seeds "$SEEDS" --finish-timeout-s 1800 --restart \
      --restart-cmd "bash eval/systems/bootstrap.sh restart --system $sys --port $SHIM_PORT --proxy-port $FAKE_PORT --timeout 900" \
      --output "$dir/run" >"$dir/lifecycle-lite.log" 2>&1 || status=1
    python3 -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1]))["run_status"] == "complete" else 1)' "$dir/run/receipt.json" 2>/dev/null || status=1
  else
    echo "restart_check: $sys did not come up (see $dir/up.log)" >&2
    status=1
  fi
  SHIM_HOST_PORT=$SHIM_PORT bash -c 'if docker info >/dev/null 2>&1; then exec docker compose "$@"; else exec sudo -E docker compose "$@"; fi' compose \
    -f "eval/systems/$sys/docker-compose.yml" logs --no-color --tail 300 >"$dir/compose.log" 2>&1 || true
  bash eval/systems/bootstrap.sh down --system "$sys" --port "$SHIM_PORT" >"$dir/down.log" 2>&1 || true
  tail -8 "$dir/lifecycle-lite.log" >&2 2>/dev/null || true
done
exit $status
