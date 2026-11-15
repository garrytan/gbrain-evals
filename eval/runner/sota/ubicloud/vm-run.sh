#!/usr/bin/env bash
# One SOTA loop window on the VM, as its one ledger writer. run.sh starts it there; it is not meant to run anywhere else.
#
#   bash eval/runner/sota/ubicloud/vm-run.sh <window> <cap-usd>
#
# State is ~/work/<window>/ (pushed from and pulled back to the launching machine): ledger.sqlite, run-id, cache/ and
# out/. The first launch creates the ledger with a program cap of <cap-usd>. Each launch reuses the recorded budget run
# while it is open with money left, else opens a new run with a <cap-usd> budget (after a cap pause, raise the program
# cap first with budget-ledger.ts set-cap on the launching machine's ledger). A step that fails is reported and the
# window goes on to the next, so one bad step never strands the others; the exit status is 1 if any step failed.
set -uo pipefail
window=${1:?window}; cap=${2:?cap in dollars}
S=$HOME/work/$window
L=$S/ledger.sqlite C=$S/cache O=$S/out
mkdir -p "$C" "$O"
OPUS=anthropic:claude-opus-5-5 SOL=openai:gpt-6.1-sol PARTICLE=particle:particle-1
GREP=sota-dev.baseline-file-agent.baseline GBRAIN=sota-dev.gbrain-defaults.agent-tools
rc=0
step() { echo "vm-run: $*"; "$@" || { echo "vm-run: FAILED ($?): $*"; rc=1; }; }
plan_file() { echo "$C/plan/$1-$2-$(printf '%s' "$3" | sed 's/[^a-zA-Z0-9.-]\{1,\}/_/g').txt"; }
if [ "$window" = rehearse ]; then
  step bun eval/runner/sota/oracle.ts plan --cache "$C"
  step bun eval/runner/sota/leader.ts plan --cache "$C"
  for cell in $GREP $GBRAIN sota-leader-beam.baseline-file-agent.baseline sota-leader-lme.baseline-full-context.baseline; do step bun eval/runner/q1/cell.ts show --cell "$cell"; done
  exit $rc
fi
[ -f "$L" ] || bun eval/runner/budget-ledger.ts init --budget-ledger "$L" --program-cap-usd "$cap" --reason "SOTA loop $window paid window (GST-2485)" >/dev/null
rid=$(cat "$S/run-id" 2>/dev/null || true)
left=0
if [ -n "$rid" ]; then
  left=$(bun eval/runner/budget-ledger.ts status --budget-ledger "$L" --budget-run-id "$rid" \
    | bun -e 'const s = JSON.parse(await Bun.stdin.text()); console.log(s.run && s.run.finished_at === null && s.run.remaining_usd > 0 ? 1 : 0)')
fi
if [ "$left" != 1 ]; then
  rid=$(bun eval/runner/budget-ledger.ts open --budget-ledger "$L" --runner "sota-$window" --budget-usd "$cap")
  echo "$rid" > "$S/run-id"
fi
echo "vm-run: $window on budget run $rid (ledger $L)"
P=(--paid --budget-ledger "$L" --budget-run-id "$rid")
case $window in
  oracle-dev)
    step bun eval/runner/sota/oracle.ts import-a4 --cache "$C"
    step bun eval/runner/sota/oracle.ts plan --cache "$C"
    for pair in "beam-1m $OPUS" "lme-s $OPUS" "lme-s $SOL"; do
      set -- $pair; f=$(plan_file oracle "$1" "$2")
      [ -s "$f" ] && step bun eval/runner/sota/oracle.ts run --benchmark "$1" --reader "$2" --items "$f" --cache "$C" --work "$O/oracle" "${P[@]}"
    done ;;
  dev-agent)
    for cell in $GREP $GBRAIN; do step bun eval/runner/q1/cell.ts run --cell "$cell" --arms whole-agent --out "$O/$cell" "${P[@]}"; done
    step bun eval/runner/sota/leader.ts import --from "$O/$GREP" --cell "$GREP" --cache "$C" ;;
  particle)
    step bun eval/runner/sota/oracle.ts plan --cache "$C"
    for b in beam-1m lme-s; do
      f=$(plan_file oracle "$b" "$PARTICLE")
      [ -s "$f" ] && step bun eval/runner/sota/oracle.ts run --benchmark "$b" --reader "$PARTICLE" --items "$f" --cache "$C" --work "$O/oracle" "${P[@]}"
    done
    for cell in $GREP $GBRAIN; do step bun eval/runner/q1/cell.ts run --cell "$cell" --arms whole-agent-particle --out "$O/$cell" "${P[@]}"; done ;;
  leader-cache)
    step bun eval/runner/sota/leader.ts plan --cache "$C"
    for triple in "lme-s whole-history $OPUS" "lme-s whole-history $SOL" "beam-1m grep-agent $OPUS" "beam-1m grep-agent $SOL"; do
      set -- $triple; f=$(plan_file leader "$1" "$3")
      [ -s "$f" ] && step bun eval/runner/sota/leader.ts run --benchmark "$1" --system "$2" --reader "$3" --items "$f" --cache "$C" --work "$O/leader" "${P[@]}"
    done ;;
  *) echo "vm-run: unknown window $window" >&2; exit 2 ;;
esac
bun eval/runner/budget-ledger.ts status --budget-ledger "$L" --budget-run-id "$rid" > "$S/ledger-status.json" || rc=1
exit $rc
