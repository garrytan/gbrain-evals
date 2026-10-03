#!/usr/bin/env bash
# Cat 40 follow-ups: the paid runs of the gbrain cost wave, on one SQLite budget ledger capped at $237.
#
# Plan: docs/plans/2026-10-03-cat40-followups/PLAN.md, as changed by Garry's gate decisions of 2026-10-03
# (UC1 ship rule with a -5 point margin; UC2 a contemporaneous 566a242a control instead of the 11-model ladder;
# UC3 the SQLite ledger). Ledger guide: docs/budget-ledger.md.
#
# Run from the repository root, one step at a time, in this order. Every paid step prints the ledger status
# first and refuses when the ledger has less left than the step's budget. Nothing else may spend against
# this ledger while the plan runs.
#
#   init           create the ledger with the $237 cap (once)                                           free
#   status         print the ledger status                                                              free
#   power          CI half-width of two near-identical held-out builds (gate UC1 power check)          free
#   slots-dev      ad7900d slot snapshots on the dev world, built one at a time (no-op when present)   budget $6
#   dev1           dev round 1: C1+C2 ($GBRAIN_C12_REF), 3 models, gbrain arm                          budget $18
#   latency        Item 1 latency check on dev round 1; dev2 and later refuse until it passes          budget $1
#   screen1        dev round 1 harm screen against the 51a30c1 fix-wave ladder                          free
#   dev2           dev round 2: C1-C4 ($GBRAIN_C1234_REF); refuses until screen1 passes                budget $18
#   screen2        dev round 2 harm screen                                                              free
#   world          regenerate the held-out world (seed 20261003) and check its digest                  free
#   slots-holdout  snapshots for the final build on the held-out world (no operator ANALYZE)            budget $6
#   slots-control  snapshots for 566a242a on the held-out world                                         budget $6
#   holdout        final build ($GBRAIN_FINAL_REF), held-out world, 6 models x 2 repeats; needs screen2  budget $95
#   control        566a242a with the same models, repeats and argv as holdout (gate UC2)               budget $85
#   compare        the ship rule: holdout against control (-5 point margin, -3 beside it)               free
#   ladder         optional: the 11-model dev ladder with whatever is left, complete models in order   remaining
#
# Environment:
#   GBRAIN_REPO        gbrain checkout (default ../gbrain)
#   GBRAIN_C12_REF     commit with C1+C2;  GBRAIN_C1234_REF  commit with C1-C4;  GBRAIN_FINAL_REF  the build to ship
#                      (each must resolve to a commit in GBRAIN_REPO; the resolved sha is what the runner records)
#   LEDGER             budget ledger (default .budget/cat40-followups.sqlite)
#   PRINT_ONLY=1       print every command instead of running it (refs may be unset; guards are listed, not checked)
#
# A step that times out resumes by running the same step again: its --out directory is bound to the experiment
# and its budget run, so the restart continues within the original budget. A changed build needs a new --out
# (set OUT_SUFFIX, for example OUT_SUFFIX=-rerun after dropping a change).
set -euo pipefail
cd "$(dirname "$0")/.."

STEP="${1:-}"
GBRAIN_REPO="${GBRAIN_REPO:-../gbrain}"
LEDGER="${LEDGER:-.budget/cat40-followups.sqlite}"
PROGRAM_CAP_USD=237
CONTROL_REF=566a242a
DEV_SLOT_REF="${DEV_SLOT_REF:-ad7900d}"
HOLDOUT_WORLD_DIR=eval/reports/cat40/holdout
HOLDOUT_WORLD="$HOLDOUT_WORLD_DIR/world.json"
HOLDOUT_DIGEST_PREFIX=df9e4f65cf60
REPORTS=eval/reports/cat40
OUT_SUFFIX="${OUT_SUFFIX:-}"
DEV_MODELS=gpt-5.4-mini,gpt-5.4,claude-sonnet-4-6
HOLDOUT_MODELS=claude-haiku-4-5,claude-sonnet-4-6,claude-sonnet-5-5,gpt-5.4-mini,gpt-5.4,gpt-6.1-sol
LADDER_MODELS=claude-haiku-4-5,claude-sonnet-4-6,claude-sonnet-5,claude-sonnet-5-5,claude-opus-5-5,gpt-5.4-mini,gpt-5.4,gpt-5.5,gpt-6-sol,gpt-6.1-sol,gpt-6-astra
FIX_WAVE_RESULTS=docs/benchmarks/2026-10-02-model-ladder/fix-wave-ladder/results.jsonl
HISTORICAL_HOLDOUT=docs/benchmarks/2026-10-02-model-ladder/holdout/results.jsonl
STATS=docs/benchmarks/2026-10-02-model-ladder/holdout/holdout_stats.py
RUNNER=eval/runner/cat40-model-ladder.ts
LEDGER_CLI=eval/runner/budget-ledger.ts
INIT_REASON='remaining authorization for the Cat 40 follow-ups: $2,000 program authorization minus $1,763 spent across four machines ledgers (2026-10-03)'

# Shared by every agent step: gbrain arm only, starter surface, uncapped tool results (the runner default),
# transcripts for the latency comparator, and the ledger with its recorded cap as a cross-check.
COMMON=(--arms gbrain --surface starter --gbrain-repo "$GBRAIN_REPO" --budget-ledger "$LEDGER" --program-cap-usd "$PROGRAM_CAP_USD" --transcripts)
# Dev rounds and the ladder match the 51a30c1 fix-wave ladder's argv (operator ANALYZE on, ad7900d brains).
DEV_ARGS=(--slot-ref "$DEV_SLOT_REF" --slots 5 --concurrency 6 --repeat 1)
# Held-out runs match the 77dcf414 held-out receipt's argv; the control repeats it exactly with another build.
HOLDOUT_ARGS=(--world "$HOLDOUT_WORLD" --repeat 2 --no-pglite-analyze --slots 5 --concurrency 10 --models "$HOLDOUT_MODELS")

print_only() { [[ "${PRINT_ONLY:-}" == 1 ]]; }
die() { echo "[cat40-followups] $*" >&2; exit 1; }
note() { echo "[cat40-followups] $*" >&2; }

run() {
  local arg line=''
  for arg in "$@"; do
    if [[ "$arg" =~ ^[A-Za-z0-9_./:=,@+-]+$ ]]; then line+="$arg "; else line+="$(printf '%q' "$arg") "; fi
  done
  echo "${line% }"
  print_only || "$@"
}

# Resolve a ref variable to a full commit in GBRAIN_REPO (placeholder in PRINT_ONLY mode when unset).
ref() {
  local name="$1" value="${!1:-}"
  if [[ -z "$value" ]]; then
    print_only && { echo "<$name>"; return; }
    die "$name is not set: export $name=<commit in $GBRAIN_REPO> (see the header of $0)"
  fi
  if print_only && ! git -C "$GBRAIN_REPO" rev-parse --verify --quiet "$value^{commit}" >/dev/null 2>&1; then echo "$value"; return; fi
  git -C "$GBRAIN_REPO" rev-parse --verify --quiet "$value^{commit}" || die "$name=$value is not a commit in $GBRAIN_REPO"
}

# Print the ledger status and refuse when less than $1 dollars are left.
preflight_budget() {
  local need="$1"
  run bun "$LEDGER_CLI" status --budget-ledger "$LEDGER"
  print_only && return
  local left
  left="$(bun "$LEDGER_CLI" status --budget-ledger "$LEDGER" | bun -e 'const s = JSON.parse(await Bun.stdin.text()); console.log(s.totals.remaining_usd ?? -1)')"
  bun -e "process.exit(Number('$left') >= Number('$need') ? 0 : 1)" \
    || die "the ledger has \$$left left, less than this step's \$$need budget. Stop and ask the user before raising the cap (bun $LEDGER_CLI set-cap ...)."
}

# Refuse unless a free check passed (its command exits 0). In PRINT_ONLY mode, list the guard instead.
guard() {
  local what="$1"; shift
  if print_only; then echo "# requires: $what"; return; fi
  "$@" >/dev/null || die "refusing: $what has not passed. Run it, read its output, and follow the plan's gate-failure rule before spending more."
}

latency_passed() { bun -e "const v = JSON.parse(require('fs').readFileSync('$REPORTS/followups-latency$OUT_SUFFIX/verdict.json', 'utf8')); process.exit(v.verdict.pass ? 0 : 1)"; }
screen() { python3 "$STATS" "$FIX_WAVE_RESULTS" "$REPORTS/followups-$1/results.jsonl" --models "$DEV_MODELS" --harm-screen "gbrain-$2-dev,gbrain-next"; }
complete() { bun -e "const fs = require('fs'); const d = '$REPORTS/followups-$1'; const r = fs.readdirSync(d).filter(f => /^receipt-\\d+\\.json$/.test(f)).sort().pop(); process.exit(r && JSON.parse(fs.readFileSync(d + '/' + r, 'utf8')).complete ? 0 : 1)"; }

case "$STEP" in
  init)
    run bun "$LEDGER_CLI" init --budget-ledger "$LEDGER" --program-cap-usd "$PROGRAM_CAP_USD" --reason "$INIT_REASON"
    ;;
  status)
    run bun "$LEDGER_CLI" status --budget-ledger "$LEDGER"
    ;;
  power)
    run python3 "$STATS" "$HISTORICAL_HOLDOUT" --power gbrain-next,gbrain-next-51a30c1
    ;;
  slots-dev)
    preflight_budget 6
    run bun "$RUNNER" --build-slots --gbrain-repo "$GBRAIN_REPO" --gbrain-ref "$DEV_SLOT_REF" --slots 5 --slot-build-allowance-usd 2 \
      --budget-usd 6 --budget-ledger "$LEDGER" --program-cap-usd "$PROGRAM_CAP_USD" --out "$REPORTS/followups-slots-dev"
    ;;
  dev1)
    C12="$(ref GBRAIN_C12_REF)"
    preflight_budget 18
    run bun "$RUNNER" --models "$DEV_MODELS" "${COMMON[@]}" "${DEV_ARGS[@]}" --gbrain-ref "$C12" --gbrain-label gbrain-c12-dev \
      --budget-usd 18 --out "$REPORTS/followups-dev1$OUT_SUFFIX"
    ;;
  latency)
    C12="$(ref GBRAIN_C12_REF)"
    preflight_budget 1
    run bun eval/runner/cat40/latency-replay.ts --run "$REPORTS/followups-dev1$OUT_SUFFIX" --label gbrain-c12-dev --gbrain-repo "$GBRAIN_REPO" \
      --gbrain-ref "$C12" --slot-ref "$DEV_SLOT_REF" --slots 5 --calls 40 --budget-usd 1 --budget-ledger "$LEDGER" --program-cap-usd "$PROGRAM_CAP_USD" \
      --out "$REPORTS/followups-latency$OUT_SUFFIX"
    ;;
  screen1)
    run python3 "$STATS" "$FIX_WAVE_RESULTS" "$REPORTS/followups-dev1$OUT_SUFFIX/results.jsonl" --models "$DEV_MODELS" --harm-screen gbrain-c12-dev,gbrain-next
    ;;
  dev2)
    C1234="$(ref GBRAIN_C1234_REF)"
    guard "the latency check (step latency)" latency_passed
    guard "the dev round 1 harm screen (step screen1)" screen "dev1$OUT_SUFFIX" c12
    preflight_budget 18
    run bun "$RUNNER" --models "$DEV_MODELS" "${COMMON[@]}" "${DEV_ARGS[@]}" --gbrain-ref "$C1234" --gbrain-label gbrain-c1234-dev \
      --budget-usd 18 --out "$REPORTS/followups-dev2$OUT_SUFFIX"
    ;;
  screen2)
    run python3 "$STATS" "$FIX_WAVE_RESULTS" "$REPORTS/followups-dev1/results.jsonl" "$REPORTS/followups-dev2$OUT_SUFFIX/results.jsonl" --models "$DEV_MODELS" \
      --harm-screen gbrain-c1234-dev,gbrain-next
    ;;
  world)
    run bun eval/generators/model-ladder-gen.ts --seed 20261003 --out "$HOLDOUT_WORLD_DIR"
    if ! print_only; then
      digest="$(bun -e "import { worldDigest } from './eval/generators/model-ladder-gen.ts'; console.log(worldDigest(JSON.parse(require('fs').readFileSync('$HOLDOUT_WORLD', 'utf8'))))")"
      [[ "$digest" == "$HOLDOUT_DIGEST_PREFIX"* ]] || die "held-out world digest $digest does not start with $HOLDOUT_DIGEST_PREFIX (the 77dcf414 baseline's world); do not run held-out steps on it"
      note "held-out world $HOLDOUT_WORLD digest $digest"
    else
      echo "# requires: the world digest to start with $HOLDOUT_DIGEST_PREFIX"
    fi
    ;;
  slots-holdout|slots-control)
    if [[ "$STEP" == slots-holdout ]]; then SLOT_BUILD="$(ref GBRAIN_FINAL_REF)"; else SLOT_BUILD="$CONTROL_REF"; fi
    [[ -f "$HOLDOUT_WORLD" ]] || print_only || die "run the world step first"
    preflight_budget 6
    run bun "$RUNNER" --build-slots --world "$HOLDOUT_WORLD" --no-pglite-analyze --gbrain-repo "$GBRAIN_REPO" --gbrain-ref "$SLOT_BUILD" --slots 5 \
      --slot-build-allowance-usd 2 --budget-usd 6 --budget-ledger "$LEDGER" --program-cap-usd "$PROGRAM_CAP_USD" --out "$REPORTS/followups-$STEP"
    ;;
  holdout)
    FINAL="$(ref GBRAIN_FINAL_REF)"
    guard "the dev round 2 harm screen (step screen2)" screen "dev2$OUT_SUFFIX" c1234
    preflight_budget 95
    run bun "$RUNNER" "${COMMON[@]}" "${HOLDOUT_ARGS[@]}" --gbrain-ref "$FINAL" --gbrain-label gbrain-c1234-holdout \
      --budget-usd 95 --out "$REPORTS/followups-holdout$OUT_SUFFIX"
    ;;
  control)
    preflight_budget 85
    run bun "$RUNNER" "${COMMON[@]}" "${HOLDOUT_ARGS[@]}" --gbrain-ref "$CONTROL_REF" --gbrain-label gbrain-566a242a-control \
      --budget-usd 85 --out "$REPORTS/followups-control"
    ;;
  compare)
    run python3 "$STATS" "$REPORTS/followups-holdout$OUT_SUFFIX/results.jsonl" "$REPORTS/followups-control/results.jsonl" "$HISTORICAL_HOLDOUT" \
      --ship-rule gbrain-c1234-holdout,gbrain-566a242a-control --power gbrain-next,gbrain-next-51a30c1
    for d in holdout$OUT_SUFFIX control; do
      receipts=()
      for r in "$REPORTS/followups-$d"/receipt-*.json; do [[ -e "$r" ]] && receipts+=(--receipt "$r"); done
      run bun eval/runner/cat40/analyze.ts "$REPORTS/followups-$d/results.jsonl" --subject "$( [[ $d == control ]] && echo gbrain-566a242a-control || echo gbrain-c1234-holdout )" \
        ${receipts[@]+"${receipts[@]}"} --budget-ledger "$LEDGER" --md "$REPORTS/followups-$d/analysis.md" --json "$REPORTS/followups-$d/analysis.json"
    done
    ;;
  ladder)
    FINAL="$(ref GBRAIN_FINAL_REF)"
    guard "a complete held-out run (step holdout)" complete "holdout$OUT_SUFFIX"
    guard "a complete control run (step control)" complete control
    if print_only; then LEFT='<remaining_usd from status>'; else
      run bun "$LEDGER_CLI" status --budget-ledger "$LEDGER"
      LEFT="$(bun "$LEDGER_CLI" status --budget-ledger "$LEDGER" | bun -e 'const s = JSON.parse(await Bun.stdin.text()); console.log(Math.floor((s.totals.remaining_usd ?? 0) * 100) / 100)')"
      bun -e "process.exit(Number('$LEFT') >= 5 ? 0 : 1)" || die "only \$$LEFT left; the ladder is optional and does not run"
    fi
    # Partial-ladder rule: complete models in the listed order until the budget runs out; label the ladder partial.
    run bun "$RUNNER" --models "$LADDER_MODELS" "${COMMON[@]}" "${DEV_ARGS[@]}" --order model --gbrain-ref "$FINAL" --gbrain-label gbrain-c1234-ladder \
      --budget-usd "$LEFT" --out "$REPORTS/followups-ladder$OUT_SUFFIX"
    ;;
  *)
    sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
    [[ -z "$STEP" || "$STEP" == help || "$STEP" == --help ]] && exit 0
    exit 2
    ;;
esac
