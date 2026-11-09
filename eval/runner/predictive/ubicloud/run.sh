#!/usr/bin/env bash
# Run a predictive unit's paid smoke or counted run on an ephemeral Ubicloud VM, never on a Capy machine (crew rule: a
# long paid job must survive the launcher sleeping).
#
#   eval/runner/predictive/ubicloud/run.sh <unit> <smoke|paid> <cap-usd> [run.ts options...]
#   eval/runner/predictive/ubicloud/run.sh check        teardown check: fails if any VM of owner gbev55 remains
#
# Start it only inside a granted paid window. It creates the VM through scripts/ubicloud/ubi-runner.sh (owner gbev55),
# syncs this checkout, runs setup.sh (bun 1.4.4, ripgrep, bun install --frozen-lockfile), pushes the unit's state from
# ~/.capy/work/predictive/<unit>-<mode>/, runs vm-run.sh detached, pulls the state back, and destroys the VM on every
# exit path. Provider keys travel only through ubi-runner's --pass (into ~/.ubirun-env on the VM, mode 0600), never
# onto local disk or the command line. Run the same command again to resume: the episode log skips done episodes and
# never resends errored or in-flight ones unless --retry-errored is passed. It refuses to launch while any VM of owner gbev55
# still exists, because that VM may still be writing its own copy of the ledger. After every launch the teardown check runs.
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../../../.." && pwd)
UBI=${UBI_RUNNER:-$REPO/scripts/ubicloud/ubi-runner.sh}
export UBI_OWNER=gbev55 UBI_GC_HOURS=0
check() {
  local left
  left=$("$UBI" list --mine | grep -o "ubirun-$UBI_OWNER-[a-z0-9-]*" | sort -u || true)
  if [ -n "$left" ]; then
    echo "teardown check FAILED: VMs of owner $UBI_OWNER still exist:" >&2
    echo "$left" >&2
    echo "pull anything needed, then destroy each with: UBI_OWNER=$UBI_OWNER $UBI down <name>" >&2
    return 1
  fi
  echo "teardown check: no VMs of owner $UBI_OWNER remain"
}
[ "${1:-}" != check ] || { check; exit; }
unit=${1:?usage: run.sh <unit> <smoke|paid> <cap-usd> [run.ts options...] | run.sh check}; mode=${2:?smoke or paid}; cap=${3:?cap in dollars}; shift 3
case $unit in g1|g3|g4|g6) ;; *) echo "run.sh: unit must be g1, g3, g4 or g6" >&2; exit 2 ;; esac
if ! check >&2; then echo "run.sh: refusing to launch beside a live VM, which would be a second ledger writer; pull its work/$unit-$mode into ~/.capy/work/predictive and destroy it first" >&2; exit 2; fi
STATE_ROOT=$HOME/.capy/work/predictive
mkdir -p "$STATE_ROOT/$unit-$mode"
pass=()
for k in ANTHROPIC_API_KEY OPENAI_API_KEY PARTICLE_API_KEY; do if [ -n "${!k:-}" ]; then pass+=(--pass "$k"); fi; done
cmd="bash eval/runner/predictive/ubicloud/vm-run.sh $(printf '%q ' "$unit" "$mode" "$cap" "$@")"
rc=0
(cd "$REPO" && "$UBI" run --setup eval/runner/predictive/ubicloud/setup.sh ${pass[@]+"${pass[@]}"} \
  --push "$STATE_ROOT/$unit-$mode:work/$unit-$mode" --pull "work/$unit-$mode:$STATE_ROOT" -- "$cmd") || rc=$?
echo "run.sh: $unit $mode exited $rc; state in $STATE_ROOT/$unit-$mode (summary: out/summary.json)"
if ! check; then [ "$rc" != 0 ] || rc=1; fi
exit "$rc"
