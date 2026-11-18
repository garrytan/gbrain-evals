#!/usr/bin/env bash
# Run one entity-dedupe head-to-head memory-system cell (by default ext-temporal-graph, whose serial ingest takes
# hours) detached on an ephemeral Ubicloud VM, never on a Capy machine (crew rule: a long paid job must survive the
# launcher sleeping). Spend and safety follow the preregistration
# (docs/benchmarks/2026-11-18-entity-dedupe-h2h-preregistration.md, "Spend and safety"); the runner is
# eval/runner/entity-h2h/run.ts.
#
#   eval/runner/entity-h2h/ubicloud/run.sh launch <cell> <system> <config> <lease-usd> [<choice-file>]
#                                                      config: default, tuning:<setting> or tuned (with its choice file)
#   eval/runner/entity-h2h/ubicloud/run.sh restart <cell> <lease-usd>              after a crash: reconcile, then page one
#   eval/runner/entity-h2h/ubicloud/run.sh continue <cell> <lease-usd> <stop-usd>   after a pause: reconcile, then page one
#   eval/runner/entity-h2h/ubicloud/run.sh pull <cell>     stop the cell's command, bring its state back, destroy the VM
#   eval/runner/entity-h2h/ubicloud/run.sh check           teardown check: fails while a VM of this owner or a cell
#                                                           in flight remains
#
# A cell's state is ~/.capy/work/entity-h2h-cells/<cell>/ (pushed to the VM and pulled back): cell/ (the runner's
# --output: cell.json, output, reconcile records) and attempt-<n>/ (that attempt's lease ledger, usage log and proxy
# log). Each launch is a fresh VM, so each attempt ingests into a fresh database and namespace from page one; nothing
# resumes in place. Before a restart or continue this script reconciles every earlier attempt's ledger against its
# proxy usage log on this machine (run.ts reconcile), and the runner refuses (LEDGER_UNRECONCILED) otherwise. The
# runner allows one restart; a second failure ends the cell as "failed (infrastructure)" (exit 5).
#
# Configurations (eval/runner/entity-h2h/tuning.ts): before any VM starts, this script checks the setting against the
# system's grid (run.ts stack-env) and the seed rules: a tuning:<setting|default> cell runs only with ENTITY_H2H_SEED set
# to the held-out seed 20261118 and a world of 5 instances per family, a tuned cell never on that seed and only with the
# choice record from run.ts choose, which travels to the VM as <cell>/choice.json. A tuned cell whose system has no
# documented dedupe setting, or whose rule chose default, is the default cell, so it starts no VM (TUNED_IS_DEFAULT). default and tuned cells write the
# world at 20 per family; a restart or continue takes the cell's own. vm-run.sh starts the stack in the cell's setting,
# and the runner refuses (STACK_CONFIG_MISMATCH) a stack that reports another.
#
# The world's seed travels only as ENTITY_H2H_SEED through ubi-runner's --pass (never on this machine's command line),
# and the VM writes the world itself (vm-run.sh passes it to run.ts world as an argument there). ENTITY_H2H_WORLD=smoke
# on launch (default full) makes that the 2026-11-17 smoke's world, for re-smokes; restart and continue read it from
# the cell. OPENAI_API_KEY goes to the VM's metering proxy the same way, the only key a memory cell
# needs. One ledger writer: the VM's proxy is the only writer of an attempt's ledger, and this script refuses to launch
# while any VM of its owner exists, while another launch holds the cell's state folder, or while any cell's final pull
# has not landed. vCPU lines: ubi-runner refuses a create past UBI_QUOTA_VCPUS (464, project) or UBI_CREW_VCPUS (208,
# crew); this script pins both and refuses a caller who raises them. Teardown: ubi-runner destroys the VM on every exit
# path, and `check` must print no VM before a report. A stop counts only when the VM is destroyed and
# `ubi-runner.sh list --mine` prints nothing.
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../../../.." && pwd)
UBI=${UBI_RUNNER:-$REPO/scripts/ubicloud/ubi-runner.sh}
for v in UBI_QUOTA_VCPUS UBI_CREW_VCPUS; do
  want=464; [ "$v" = UBI_CREW_VCPUS ] && want=208
  if [ -n "${!v:-}" ] && [ "${!v}" -gt "$want" ]; then echo "run.sh: $v=${!v} is above the crew's line of $want vCPUs" >&2; exit 2; fi
done
export UBI_OWNER=${UBI_OWNER:-gbev99} UBI_GC_HOURS=0 UBI_REAP=0 UBI_TTL_HOURS=${UBI_TTL_HOURS:-12} UBI_QUOTA_VCPUS=${UBI_QUOTA_VCPUS:-464} UBI_CREW_VCPUS=${UBI_CREW_VCPUS:-208}
SIZE=${UBI_SIZE:-standard-8}
CELLS=$HOME/.capy/work/entity-h2h-cells
mkdir -p "$CELLS"
in_flight() {
  local m
  for m in "$CELLS"/*.in-flight; do
    [ -f "$m" ] || continue
    echo "$(basename "$m" .in-flight) $(sed -n 's/^vm=//p' "$m")"
  done
}
check() {
  local out left rc=0
  if [ -n "$(in_flight)" ]; then
    echo "teardown check FAILED: a cell is still in flight (its final pull never landed):" >&2
    in_flight | while read -r cell vm; do echo "  $cell on $vm: $0 pull $cell" >&2; done
    rc=1
  fi
  out=$("$UBI" list --mine) || { echo "teardown check FAILED: could not list the VMs of owner $UBI_OWNER" >&2; return 1; }
  left=$(printf '%s\n' "$out" | grep -o "ubirun-$UBI_OWNER-[a-z0-9-]*" | sort -u || true)
  if [ -n "$left" ]; then
    echo "teardown check FAILED: VMs of owner $UBI_OWNER still exist:" >&2
    echo "$left" >&2
    echo "pull anything needed ($0 pull <cell>), then destroy each with: UBI_OWNER=$UBI_OWNER $UBI down <name>" >&2
    return 1
  fi
  [ "$rc" = 0 ] || return 1
  echo "teardown check: no VMs of owner $UBI_OWNER remain"
}
cmd=${1:-}
case $cmd in
  check) check; exit ;;
  pull)
    cell=${2:?usage: run.sh pull <cell>}
    marker=$CELLS/$cell.in-flight
    [ -f "$marker" ] || { echo "run.sh: no in-flight marker for $cell ($marker)" >&2; exit 2; }
    vm=$(sed -n 's/^vm=//p' "$marker")
    exec 9<"$CELLS/$cell" && flock -n 9 || { echo "run.sh: refusing to pull: a launch of $cell still holds $CELLS/$cell; $marker stays" >&2; exit 2; }
    "$UBI" stop "$vm" || true
    "$UBI" ssh "$vm" 'test -f ~/.ubirun-cmd.rc && s=$(cat ~/.ubirun-cmd.pid) && [ -n "$s" ] && { pgrep -s "$s" >/dev/null; [ $? -eq 1 ]; }' \
      || { echo "run.sh: the command on $vm, or a step it started, has not exited (or the VM cannot be reached), so its ledger may still change; $marker stays" >&2; exit 1; }
    UBI_FINAL_PULL=1 "$UBI" pull "$vm" "work/$cell" "$CELLS" || { echo "run.sh: the pull from $vm failed; $marker stays" >&2; exit 1; }
    rm -f "$marker"
    echo "run.sh: $cell's state is back in $CELLS/$cell; destroying $vm"
    "$UBI" down "$vm" || { echo "run.sh: could not destroy $vm; run: UBI_OWNER=$UBI_OWNER $UBI down $vm" >&2; exit 1; }
    exit 0 ;;
  launch) cell=${2:?cell}; system=${3:?system}; config=${4:?config}; lease=${5:?lease in dollars}; choice=${6:-}; mode=run; stop= ;;
  restart) cell=${2:?cell}; lease=${3:?lease in dollars}; mode=restart; stop= ;;
  continue) cell=${2:?cell}; lease=${3:?lease in dollars}; stop=${4:?new stop in dollars}; mode=continue ;;
  *) echo "usage: run.sh launch <cell> <system> <config> <lease-usd> [<choice-file>] | restart <cell> <lease-usd> | continue <cell> <lease-usd> <stop-usd> | pull <cell> | check" >&2; exit 2 ;;
esac
[[ "$cell" =~ ^[a-z0-9][a-z0-9.-]{0,40}$ ]] || { echo "run.sh: a cell name is lowercase letters, digits, dots and hyphens" >&2; exit 2; }
[[ "$UBI_TTL_HOURS" =~ ^[1-9][0-9]{0,2}$ ]] || { echo "run.sh: UBI_TTL_HOURS must be a whole number of hours from 1 to 999" >&2; exit 2; }
STATE=$CELLS/$cell
mkdir -p "$STATE"
exec 9<"$STATE"
if ! flock -n 9; then echo "run.sh: refusing to launch: another launch of $cell holds $STATE, and a second would be a second ledger writer" >&2; exit 2; fi
if [ -n "$(in_flight)" ]; then echo "run.sh: refusing to launch: a cell's final pull never landed, so its ledger here is stale; pull it first ($0 pull <cell>)" >&2; exit 2; fi
if ! check >&2; then echo "run.sh: refusing to launch until no VM of owner $UBI_OWNER exists: a launch beside a live one could be a second ledger writer" >&2; exit 2; fi
if [ "$mode" = run ]; then
  [ ! -e "$STATE/cell" ] || { echo "run.sh: $STATE/cell exists; a cell launches once, then restarts or continues" >&2; exit 2; }
  case $system in ext-temporal-graph|ext-graph-pipeline|ext-extract-first|ext-memory-bank) ;; *) echo "run.sh: system must be a memory-system kind id" >&2; exit 2 ;; esac
  attempt=1
  case $config in
    default) per_family=20 ;;
    tuning:*) per_family=5 ;;
    tuned) per_family=20; [ -z "$choice" ] || [ -f "$choice" ] || { echo "run.sh: no choice record at $choice" >&2; exit 2; } ;;
    *) echo "run.sh: config is default, tuning:<setting> or tuned" >&2; exit 2 ;;
  esac
  [ "$config" = tuned ] || [ -z "$choice" ] || { echo "run.sh: a choice file goes with config tuned only" >&2; exit 2; }
  if [ -n "$choice" ]; then cp "$choice" "$STATE/choice.json"; else rm -f "$STATE/choice.json"; fi
  (cd "$REPO" && bun eval/runner/entity-h2h/run.ts stack-env --system "$system" --config "$config" ${choice:+--choice "$STATE/choice.json"} >/dev/null) || { echo "run.sh: $system cannot run config $config; no VM was started" >&2; exit 2; }
  world=${ENTITY_H2H_WORLD:-full}
  case $world in full|smoke) ;; *) echo "run.sh: ENTITY_H2H_WORLD is full or smoke" >&2; exit 2 ;; esac
  if [ "$world" = smoke ]; then [ "$config" = default ] || { echo "run.sh: the smoke world runs config default only" >&2; exit 2; }; per_family=2; fi
else
  [ -f "$STATE/cell/cell.json" ] || { echo "run.sh: $STATE/cell/cell.json is missing; launch the cell first" >&2; exit 2; }
  system=$(bun -e 'console.log(JSON.parse(await Bun.file(process.argv[1]).text()).system)' "$STATE/cell/cell.json")
  attempt=$(( $(bun -e 'console.log(JSON.parse(await Bun.file(process.argv[1]).text()).attempts.length)' "$STATE/cell/cell.json") + 1 ))
  per_family=$(bun -e 'console.log(JSON.parse(await Bun.file(process.argv[1]).text()).world.per_family)' "$STATE/cell/cell.json")
  world=$(bun -e 'console.log(JSON.parse(await Bun.file(process.argv[1]).text()).world.smoke === true ? "smoke" : "full")' "$STATE/cell/cell.json")
  (cd "$REPO" && bun eval/runner/entity-h2h/run.ts reconcile --output "$STATE/cell") || { echo "run.sh: the reconcile failed; no $mode launches until it passes" >&2; exit 2; }
fi
if [ -e "$STATE/attempt-$attempt" ]; then
  echo "run.sh: $STATE/attempt-$attempt exists but the cell lists $((attempt - 1)) attempts: an earlier attempt stopped before the runner recorded it, so its lease ledger is not counted in the cell's spend. Check that its ledger-status.json shows nothing committed, move the folder aside, then retry; no VM was started" >&2
  exit 2
fi
for k in ENTITY_H2H_SEED OPENAI_API_KEY; do
  [ -n "${!k:-}" ] || { echo "run.sh: $k must be set" >&2; exit 2; }
done
if [ "$mode" = run ]; then
  case $config in
    tuning:*) [ "$ENTITY_H2H_SEED" = 20261118 ] || { echo "run.sh: a tuning cell runs only on the held-out seed: set ENTITY_H2H_SEED=20261118; no VM was started" >&2; exit 2; } ;;
    tuned) [ "$ENTITY_H2H_SEED" != 20261118 ] || { echo "run.sh: a tuned cell never runs on the held-out seed 20261118; no VM was started" >&2; exit 2; } ;;
  esac
fi
cmd_line="bash eval/runner/entity-h2h/ubicloud/vm-run.sh $(printf '%q ' "$cell" "$system" "${config:-from-cell}" "$lease" "$mode" "$attempt" "${stop:-none}" "$per_family")"
vm=ubirun-$UBI_OWNER-$(date +%s)-erh-$(head -c3 /dev/urandom | od -An -tx1 | tr -d ' \n')-t$UBI_TTL_HOURS
printf 'vm=%s\nlaunched_at=%s\n' "$vm" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$CELLS/$cell.in-flight"
rc=0
(cd "$REPO" && "$UBI" run -n "$vm" -s "$SIZE" --setup eval/runner/entity-h2h/ubicloud/setup.sh --env "ENTITY_H2H_SYSTEM=$system" --env "ENTITY_H2H_WORLD=$world" --pass ENTITY_H2H_SEED --pass OPENAI_API_KEY \
  --push "$STATE:work/$cell" --pull "work/$cell:$CELLS" -- "$cmd_line") 9<&- || rc=$?
echo "run.sh: $cell attempt $attempt exited $rc; state in $STATE"
if [ "$rc" != 253 ] && [ "$rc" != 255 ] && [ "$rc" -lt 128 ] && mine=$("$UBI" list --mine) && ! grep -q -- "$vm" <<<"$mine"; then
  rm -f "$CELLS/$cell.in-flight"
fi
if ! check; then [ "$rc" != 0 ] || rc=1; fi
exit "$rc"
