#!/usr/bin/env bash
# One entity-dedupe head-to-head memory-system attempt on the VM. run.sh starts it there; it is not meant to run
# anywhere else.
#
#   bash eval/runner/entity-h2h/ubicloud/vm-run.sh <cell> <system> <config> <lease-usd> <run|restart|continue> <attempt> <stop-usd|none>
#
# State is ~/work/<cell>/ (pushed from and pulled back to the launching machine). This attempt's metering proxy is the
# one writer of its own lease ledger, attempt-<n>/lease.sqlite, and logs every request to attempt-<n>/usage.ndjson;
# the runner writes cell/. The world is written fresh from ENTITY_H2H_SEED into ~/world, outside the state folder.
# The stack and the proxy are stopped before exit, whatever the runner's status, so the final pull reads a ledger
# nobody is writing. Exit status: the runner's (0 done, 2 refusal, 3 error, 4 paused, 5 failed (infrastructure)).
set -uo pipefail
cell=${1:?cell}; system=${2:?system}; config=${3:?config}; lease=${4:?lease}; mode=${5:?mode}; attempt=${6:?attempt}; stop=${7:-none}
S=$HOME/work/$cell C=$HOME/work/$cell/cell A=$HOME/work/$cell/attempt-$attempt W=$HOME/world
run_id=entity-h2h-$cell-a$attempt
[ -n "${ENTITY_H2H_SEED:-}" ] || { echo "vm-run: ENTITY_H2H_SEED is not set" >&2; exit 2; }
[ ! -e "$A" ] || { echo "vm-run: $A exists; every attempt gets a fresh lease ledger" >&2; exit 2; }
mkdir -p "$S"
rm -rf "$W"
bun eval/runner/entity-h2h/run.ts world --seed "$ENTITY_H2H_SEED" --output "$W" >/dev/null || exit 3
bash eval/systems/bootstrap.sh proxy --lease-id "$run_id" --lease-usd "$lease" --out "$A" >/dev/null || exit 3
stop_all() {
  bash eval/systems/bootstrap.sh down --system "$system" --config entity-h2h || true
  if [ -f "$A/proxy.pid" ]; then kill "$(cat "$A/proxy.pid")" 2>/dev/null; for _ in $(seq 1 100); do kill -0 "$(cat "$A/proxy.pid")" 2>/dev/null || break; sleep 0.1; done; fi
  bun eval/runner/budget-ledger.ts status --budget-ledger "$A/lease.sqlite" --budget-run-id "$run_id" > "$A/ledger-status.json" 2>/dev/null || true
}
trap stop_all EXIT
bash eval/systems/bootstrap.sh up --system "$system" --config entity-h2h --port 8700 || exit 3
paid=(--shim http://127.0.0.1:8700 --proxy http://127.0.0.1:8787 --budget-ledger "$A/lease.sqlite" --budget-run-id "$run_id" --usage-log "$A/usage.ndjson")
case $mode in
  run) bun eval/runner/entity-h2h/run.ts run --system "$system" --config "$config" --world "$W" --output "$C" "${paid[@]}" ;;
  restart) bun eval/runner/entity-h2h/run.ts restart --output "$C" "${paid[@]}" ;;
  continue) bun eval/runner/entity-h2h/run.ts continue --output "$C" --stop-usd "$stop" "${paid[@]}" ;;
  *) echo "vm-run: unknown mode $mode" >&2; exit 2 ;;
esac
