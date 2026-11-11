#!/usr/bin/env bash
# Run one SOTA loop paid window on an ephemeral Ubicloud VM, never on a Capy machine (crew rule: a long paid job must
# survive the launcher sleeping).
#
#   eval/runner/sota/ubicloud/run.sh <window> <cap-usd> [--cache-seed <dir>]
#   eval/runner/sota/ubicloud/run.sh check        teardown check: fails if any VM of owner gbev78 remains
#
# Windows, whose steps vm-run.sh runs in order:
#   rehearse      keyless: the VM setup and every plan step, with no key on the VM and no ledger run
#   oracle-dev    oracle rows: A4's Sol rows on BEAM-1M, then the BEAM-1M Opus and LongMemEval Opus and Sol rows the
#                 cache lacks (sota/oracle.ts)
#   dev-agent     the SOTA dev test's Opus and Sol rows on both agents (q1 cells sota-dev.*, arm whole-agent), then the
#                 grep agent's rows into the leader cache (sota/leader.ts import)
#   particle      the SOTA dev test's particle-1 rows on both agents (arm whole-agent-particle); PARTICLE_API_KEY goes
#                 to the VM in this window only
#   leader-cache  the leader rows the cache lacks: the whole history on lme-s-hard, the grep agent on beam-1m-hard
#
# Start a paid window only once it is granted. State is ~/.capy/work/sota-windows/<window>/ (pushed to the VM and pulled
# back): ledger.sqlite, run-id, cache/ (the outcome cache: copied from --cache-seed on the first launch, so seed it with
# the current cache and copy it back when the window is done) and out/ (the q1 cells' and runners' output). The first
# launch creates the ledger with a program cap of <cap-usd>; a relaunch resumes the open budget run, and the runners
# skip what they already hold (the q1 cells resume, the oracle and leader runs buy only rows the cache lacks). Provider
# keys travel only through ubi-runner's --pass, never onto local disk or the command line. It refuses to launch while any
# VM of owner gbev78 exists or another launch of the window holds its state directory, so the ledger has one writer, and
# the teardown check runs after every launch.
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../../../.." && pwd)
UBI=${UBI_RUNNER:-$REPO/scripts/ubicloud/ubi-runner.sh}
export UBI_OWNER=gbev78 UBI_GC_HOURS=0 UBI_TTL_HOURS=${UBI_TTL_HOURS:-12}
check() {
  local out left
  out=$("$UBI" list --mine) || { echo "teardown check FAILED: could not list the VMs of owner $UBI_OWNER" >&2; return 1; }
  left=$(printf '%s\n' "$out" | grep -o "ubirun-$UBI_OWNER-[a-z0-9-]*" | sort -u || true)
  if [ -n "$left" ]; then
    echo "teardown check FAILED: VMs of owner $UBI_OWNER still exist:" >&2
    echo "$left" >&2
    echo "pull anything needed, then destroy each with: UBI_OWNER=$UBI_OWNER $UBI down <name>" >&2
    return 1
  fi
  echo "teardown check: no VMs of owner $UBI_OWNER remain"
}
[ "${1:-}" != check ] || { check; exit; }
window=${1:?usage: run.sh <window> <cap-usd> [--cache-seed <dir>] | run.sh check}; cap=${2:?cap in dollars}; shift 2
seed=
while [ $# -gt 0 ]; do case $1 in --cache-seed) seed=${2:?--cache-seed <dir>}; shift 2 ;; *) echo "run.sh: unknown option $1" >&2; exit 2 ;; esac; done
case $window in rehearse|oracle-dev|dev-agent|particle|leader-cache) ;; *) echo "run.sh: window must be rehearse, oracle-dev, dev-agent, particle or leader-cache" >&2; exit 2 ;; esac
STATE=$HOME/.capy/work/sota-windows/$window
mkdir -p "$STATE"
exec 9<"$STATE"
if ! flock -n 9; then echo "run.sh: refusing to launch: another launch of $window holds $STATE, and a second would be a second ledger writer" >&2; exit 2; fi
if ! check >&2; then echo "run.sh: refusing to launch until the VM list shows no VM of owner $UBI_OWNER: a launch beside a live one would be a second ledger writer" >&2; exit 2; fi
if [ ! -d "$STATE/cache" ]; then
  if [ -n "$seed" ]; then cp -a "$seed" "$STATE/cache"; else mkdir -p "$STATE/cache"; fi
fi
keys=()
case $window in
  rehearse) ;;
  particle) keys=(ANTHROPIC_API_KEY OPENAI_API_KEY PARTICLE_API_KEY) ;;
  dev-agent) keys=(ANTHROPIC_API_KEY OPENAI_API_KEY VOYAGE_API_KEY) ;;
  *) keys=(ANTHROPIC_API_KEY OPENAI_API_KEY) ;;
esac
pass=()
for k in ${keys[@]+"${keys[@]}"}; do
  [ -n "${!k:-}" ] || { echo "run.sh: window $window needs $k set" >&2; exit 2; }
  pass+=(--pass "$k")
done
cmd="bash eval/runner/sota/ubicloud/vm-run.sh $(printf '%q ' "$window" "$cap")"
rc=0
(cd "$REPO" && "$UBI" run --setup eval/runner/sota/ubicloud/setup.sh ${pass[@]+"${pass[@]}"} \
  --push "$STATE:work/$window" --pull "work/$window:$HOME/.capy/work/sota-windows" -- "$cmd") 9<&- || rc=$?
echo "run.sh: $window exited $rc; state in $STATE (ledger status: ledger-status.json)"
if ! check; then [ "$rc" != 0 ] || rc=1; fi
exit "$rc"
