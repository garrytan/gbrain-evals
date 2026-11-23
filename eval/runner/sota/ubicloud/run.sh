#!/usr/bin/env bash
# Run one SOTA loop paid window on an ephemeral Ubicloud VM, never on a Capy machine (crew rule: a long paid job must
# survive the launcher sleeping).
#
#   eval/runner/sota/ubicloud/run.sh <window> <cap-usd> [--cache-seed <dir>]
#   eval/runner/sota/ubicloud/run.sh check        teardown check: fails if any VM of owner gbev78 remains, or any
#                                                 window is still in flight
#   eval/runner/sota/ubicloud/run.sh pull <window>
#                                                 stop the window's command on its VM, bring its state back, then
#                                                 destroy the VM and clear the window's in-flight marker
#
# Windows, whose steps vm-run.sh runs in order:
#   rehearse      keyless: the VM setup and every plan step, with no key on the VM and no ledger run
#   oracle-dev    oracle rows: A4's gpt-6.1-sol rows on BEAM-1M (imported, never bought), then the Opus and gpt-6.2-sol
#                 rows the cache lacks on BEAM-1M and LongMemEval (sota/oracle.ts)
#   dev-agent     the SOTA dev test's Opus and Sol rows on both agents (q1 cells sota-dev.*, arm whole-agent), then the
#                 grep agent's rows into the leader cache (sota/leader.ts import)
#   particle      particle-1's oracle rows on the dev pool, then the SOTA dev test's particle-1 rows on both agents (arm
#                 whole-agent-particle; the gbrain agent's ingest needs VOYAGE_API_KEY); PARTICLE_API_KEY goes to the VM
#                 in this window only
#   leader-cache  the leader rows the cache lacks: the whole history on lme-s-hard, the grep agent on beam-1m-hard
#
# Start a paid window only once it is granted. State is ~/.capy/work/sota-windows/<window>/ (pushed to the VM and pulled
# back): ledger.sqlite, run-id, cache/ (the outcome cache: copied from --cache-seed on the first launch, so seed it with
# the current cache and copy it back when the window is done) and out/ (the q1 cells' and runners' output). The first
# launch creates the ledger with a program cap of <cap-usd>; a relaunch resumes the open budget run, and the runners
# skip what they already hold (the q1 cells resume, the oracle and leader runs buy only rows the cache lacks). Provider
# keys travel only through ubi-runner's --pass, never onto local disk or the command line. It refuses to launch while any
# VM of owner gbev78 exists or another launch of the window holds its state directory, so the ledger has one writer, and
# the teardown check runs after every launch. Each window's VM carries a UBI_TTL_HOURS (default 12) lifetime in its
# name, but nothing destroys gbev78 VMs automatically: run.sh never reaps (it sets UBI_REAP=0), because a gbev78 VM past
# its lifetime may hold a window's only ledger. Every launch and the teardown check refuse while any gbev78 VM exists,
# expired or not, and name each one past its TTL with its age, so a person pulls it (run.sh pull <window>) or destroys
# it by hand (UBI_OWNER=gbev78 ubi-runner.sh down <name>).
#
# In flight: before each launch, ~/.capy/work/sota-windows/<window>.in-flight records the VM and the launch time. It is
# cleared only once the run's final pull of the window's state has landed and the VM is gone (the runner exits with
# the command's status, neither 253, a failed pull, nor 255, a lost VM, nor a signal). While any marker exists, every
# launch refuses and the teardown check fails, printing the pull command: a launch after a lost pull would otherwise
# push a stale ledger, or open a fresh one with a full cap, and overspend by up to one cap. `run.sh pull <window>`
# refuses while a launch of the window still runs, stops the window's command and waits for its exit status, brings
# the state back, then destroys the VM and clears the marker; it keeps the marker when any step fails. If the VM is
# already gone, its ledger and cache are
# lost with it: delete the marker by hand only once someone has decided how to account for that window's spend.
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../../../.." && pwd)
UBI=${UBI_RUNNER:-$REPO/scripts/ubicloud/ubi-runner.sh}
export UBI_OWNER=gbev78 UBI_GC_HOURS=0 UBI_REAP=0 UBI_TTL_HOURS=${UBI_TTL_HOURS:-12}
WINDOWS=$HOME/.capy/work/sota-windows
# in_flight: one "<window> <vm> <launched_at>" line per in-flight marker.
in_flight() {
  local m
  for m in "$WINDOWS"/*.in-flight; do
    [ -f "$m" ] || continue
    echo "$(basename "$m" .in-flight) $(sed -n 's/^vm=//p' "$m") $(sed -n 's/^launched_at=//p' "$m")"
  done
}
in_flight_hint() {
  local window vm at
  while read -r window vm at; do
    echo "window $window is in flight on VM $vm (launched $at): its ledger and cache have not come back. Pull them with:" >&2
    echo "  $0 pull $window" >&2
    echo "which stops the command (UBI_OWNER=$UBI_OWNER $UBI stop $vm) and, once it has exited, runs: UBI_OWNER=$UBI_OWNER $UBI pull $vm work/$window $WINDOWS, then UBI_OWNER=$UBI_OWNER $UBI down $vm" >&2
  done <<<"$(in_flight)"
}
check() {
  local out left vm now born ttl rc=0
  if [ -n "$(in_flight)" ]; then
    echo "teardown check FAILED: a window is still in flight" >&2
    in_flight_hint
    rc=1
  fi
  out=$("$UBI" list --mine) || { echo "teardown check FAILED: could not list the VMs of owner $UBI_OWNER" >&2; return 1; }
  left=$(printf '%s\n' "$out" | grep -o "ubirun-$UBI_OWNER-[a-z0-9-]*" | sort -u || true)
  if [ -n "$left" ]; then
    echo "teardown check FAILED: VMs of owner $UBI_OWNER still exist:" >&2
    echo "$left" >&2
    now=$(date +%s)
    while read -r vm; do
      [[ "$vm" =~ ^ubirun-$UBI_OWNER-([0-9]{10})-.*-t([1-9][0-9]{0,2})$ ]] || continue
      born=${BASH_REMATCH[1]} ttl=${BASH_REMATCH[2]}
      [ $(( now - born )) -gt $(( ttl * 3600 )) ] || continue
      echo "$vm is $(( (now - born) / 3600 ))h old, past its ${ttl}h TTL: pull or down by hand; nothing destroys $UBI_OWNER VMs automatically" >&2
    done <<<"$left"
    echo "pull anything needed, then destroy each with: UBI_OWNER=$UBI_OWNER $UBI down <name>" >&2
    return 1
  fi
  [ "$rc" = 0 ] || return 1
  echo "teardown check: no VMs of owner $UBI_OWNER remain"
}
[ "${1:-}" != check ] || { check; exit; }
if [ "${1:-}" = pull ]; then
  window=${2:?usage: run.sh pull <window>}
  marker=$WINDOWS/$window.in-flight
  [ -f "$marker" ] || { echo "run.sh: no in-flight marker for $window ($marker)" >&2; exit 2; }
  vm=$(sed -n 's/^vm=//p' "$marker")
  [ -n "$vm" ] || { echo "run.sh: $marker names no VM" >&2; exit 2; }
  exec 9<"$WINDOWS/$window" && flock -n 9 || { echo "run.sh: refusing to pull: a launch of $window still holds $WINDOWS/$window; $marker stays" >&2; exit 2; }
  "$UBI" stop "$vm" || true
  # The exit status proves only that the wrapper's command exited; a paid step it started can outlive it in the same
  # session (setsid makes the wrapper's pid the session id), so every process in that session must be gone too.
  "$UBI" ssh "$vm" 'test -f ~/.ubirun-cmd.rc && s=$(cat ~/.ubirun-cmd.pid) && [ -n "$s" ] && { pgrep -s "$s" >/dev/null; [ $? -eq 1 ]; }' \
    || { echo "run.sh: the command on $vm, or a step it started, has not exited (or the VM cannot be reached), so its ledger may still change; $marker stays" >&2; exit 1; }
  UBI_FINAL_PULL=1 "$UBI" pull "$vm" "work/$window" "$WINDOWS" || { echo "run.sh: the pull from $vm failed; $marker stays" >&2; exit 1; }
  rm -f "$marker"
  echo "run.sh: $window's state is back in $WINDOWS/$window; destroying $vm"
  "$UBI" down "$vm" || { echo "run.sh: could not destroy $vm; run: UBI_OWNER=$UBI_OWNER $UBI down $vm" >&2; exit 1; }
  exit 0
fi
[[ "$UBI_TTL_HOURS" =~ ^[1-9][0-9]{0,2}$ ]] || { echo "run.sh: UBI_TTL_HOURS must be a whole number of hours from 1 to 999" >&2; exit 2; }
window=${1:?usage: run.sh <window> <cap-usd> [--cache-seed <dir>] | run.sh check}; cap=${2:?cap in dollars}; shift 2
seed=
while [ $# -gt 0 ]; do case $1 in --cache-seed) seed=${2:?--cache-seed <dir>}; shift 2 ;; *) echo "run.sh: unknown option $1" >&2; exit 2 ;; esac; done
case $window in rehearse|oracle-dev|dev-agent|particle|leader-cache) ;; *) echo "run.sh: window must be rehearse, oracle-dev, dev-agent, particle or leader-cache" >&2; exit 2 ;; esac
STATE=$WINDOWS/$window
mkdir -p "$STATE"
exec 9<"$STATE"
if ! flock -n 9; then echo "run.sh: refusing to launch: another launch of $window holds $STATE, and a second would be a second ledger writer" >&2; exit 2; fi
if [ -n "$(in_flight)" ]; then
  echo "run.sh: refusing to launch: a window's final pull never landed, so its ledger and cache here are stale" >&2
  in_flight_hint
  exit 2
fi
if ! check >&2; then echo "run.sh: refusing to launch until the VM list shows no VM of owner $UBI_OWNER: a launch beside a live one would be a second ledger writer, and one past its lifetime may hold a window's only ledger, so a person pulls it and destroys it by hand" >&2; exit 2; fi
if [ ! -d "$STATE/cache" ]; then
  if [ -n "$seed" ]; then cp -a "$seed" "$STATE/cache"; else mkdir -p "$STATE/cache"; fi
fi
keys=()
case $window in
  rehearse) ;;
  particle) keys=(ANTHROPIC_API_KEY OPENAI_API_KEY VOYAGE_API_KEY PARTICLE_API_KEY) ;;
  dev-agent) keys=(ANTHROPIC_API_KEY OPENAI_API_KEY VOYAGE_API_KEY) ;;
  *) keys=(ANTHROPIC_API_KEY OPENAI_API_KEY) ;;
esac
pass=()
for k in ${keys[@]+"${keys[@]}"}; do
  [ -n "${!k:-}" ] || { echo "run.sh: window $window needs $k set" >&2; exit 2; }
  pass+=(--pass "$k")
done
cmd="bash eval/runner/sota/ubicloud/vm-run.sh $(printf '%q ' "$window" "$cap")"
vm=ubirun-$UBI_OWNER-$(date +%s)-sota-$(head -c3 /dev/urandom | od -An -tx1 | tr -d ' \n')-t$UBI_TTL_HOURS
printf 'vm=%s\nlaunched_at=%s\n' "$vm" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$WINDOWS/$window.in-flight"
rc=0
(cd "$REPO" && "$UBI" run -n "$vm" --setup eval/runner/sota/ubicloud/setup.sh ${pass[@]+"${pass[@]}"} \
  --push "$STATE:work/$window" --pull "work/$window:$WINDOWS" -- "$cmd") 9<&- || rc=$?
echo "run.sh: $window exited $rc; state in $STATE (ledger status: ledger-status.json)"
if [ "$rc" != 253 ] && [ "$rc" != 255 ] && [ "$rc" -lt 128 ] && mine=$("$UBI" list --mine) && ! grep -q -- "$vm" <<<"$mine"; then
  rm -f "$WINDOWS/$window.in-flight"
fi
if ! check; then [ "$rc" != 0 ] || rc=1; fi
exit "$rc"
