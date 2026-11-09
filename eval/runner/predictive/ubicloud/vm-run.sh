#!/usr/bin/env bash
# The paid run on the VM, as the run's one ledger writer. run.sh starts it there; it is not meant to run anywhere else.
#
#   bash eval/runner/predictive/ubicloud/vm-run.sh <unit> <smoke|paid> <cap-usd> [run.ts options...]
#
# State is ~/work/<unit>-<mode>/ (pushed from and pulled back to the launching machine): ledger.sqlite, run-id, and
# out/ with episodes.jsonl and summary.json. The first launch creates the ledger with a program cap of <cap-usd>. Each
# launch reuses the recorded budget run while it is open with money left, else opens a new run with a <cap-usd> budget
# (after a cap pause, raise the program cap first with budget-ledger.ts set-cap on the launching machine's ledger).
set -euo pipefail
unit=${1:?unit}; mode=${2:?smoke or paid}; cap=${3:?cap in dollars}; shift 3
case $mode in smoke) flags=(--paid --smoke) ;; paid) flags=(--paid) ;; *) echo "vm-run: mode must be smoke or paid" >&2; exit 2 ;; esac
S=$HOME/work/$unit-$mode
L=$S/ledger.sqlite
mkdir -p "$S/out"
[ -f "$L" ] || bun eval/runner/budget-ledger.ts init --budget-ledger "$L" --program-cap-usd "$cap" --reason "GBEV-55 predictive $unit $mode paid window" >/dev/null
rid=$(cat "$S/run-id" 2>/dev/null || true)
left=0
if [ -n "$rid" ]; then
  left=$(bun eval/runner/budget-ledger.ts status --budget-ledger "$L" --budget-run-id "$rid" \
    | bun -e 'const s = JSON.parse(await Bun.stdin.text()); console.log(s.run && s.run.finished_at === null && s.run.remaining_usd > 0 ? 1 : 0)')
fi
if [ "$left" != 1 ]; then
  rid=$(bun eval/runner/budget-ledger.ts open --budget-ledger "$L" --runner "predictive-$unit-$mode" --budget-usd "$cap")
  echo "$rid" > "$S/run-id"
fi
echo "vm-run: $unit $mode on budget run $rid (ledger $L)"
bun eval/runner/predictive/run.ts "$unit" "${flags[@]}" --budget-run-id "$rid" --budget-ledger "$L" --out "$S/out" "$@"
