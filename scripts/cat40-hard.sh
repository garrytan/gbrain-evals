#!/usr/bin/env bash
# Cat 40 Hard: the operator script for every step of the Hard campaign, on the SQLite ledger .budget/cat40-hard.sqlite.
#
# Plan: docs/plans/2026-10-05-cat40-hard/PLAN.md (Gate decisions first). Runbook: docs/benchmarks/cat40-hard/RUNBOOK.md.
# Run from the repository root.
#
#   hello                      $0 scripted run on the calibration seed (fs, memory, oracle, every family) and the freeze-rule table
#   status                     ledger, roster, freeze state, step artifacts and world hashes (never world content)       free
#   preflight <step>           the runner's --preflight for a step: keys, prices, identity, cells, slots, ledger, projection  free
#   step <step>                run one step after checking its predecessors, the budget decision and the projection
#
# Steps, in the plan's order (CEO-F16):
#   calibrate      ROUND=N (1-5) [SCALE=v1|large]: world from knobs.round-N.json, fs+pg+oracle on Sonnet 5.5 and GPT-6 Astra, 10 tasks per family, then the freeze-rule analyzer
#   freeze-check   ROUND=N: fs+pg+oracle on Opus 5.5, Fable 5.1 and GPT-6.1 Sol on round N's world (at most 2), then the analyzer over all five models
#   freeze         copy knobs.round-N.json to knobs.frozen.json and write freeze.json (code hashes, settings digest)            free
#   smoke          gbrain smoke on seed 20261099 with the frozen generator: 1 slot build and 1 task per family on Sonnet 5.5
#   heldout-world  the 50k held-out world (seed 20261006) and its 4k base from the frozen knobs; records hashes only          free
#   slots-50k      5 gbrain slot snapshots on the 50k held-out world
#   cells-50k      batch (a), primary: a 5-cell gbrain smoke on the 50k slots (halts on any harness error), then gbrain and fs on every model
#   oracle-50k     batch (b): the oracle reference on every model
#   pg-50k         batch (c): pg on every model
#   memory-50k     batch (d): memory on Sonnet 5.5 and GPT-6.1 Sol
#   report         analysis tables, the primary endpoint (gbrain minus fs at 50k) and every comparison, from committed results free
# Amendment A2 retired the 4k held-out steps (slots-4k, simple-4k, comparator, gbrain-4k); they stop with HARD_STEP_RETIRED.
#
# Environment:
#   GBRAIN_REPO   gbrain checkout (default ../gbrain);  GBRAIN_REF   the gbrain commit under test (current master; recorded resolved)
#   ROUND         calibration round for calibrate, freeze-check and freeze
#   SCALE         calibration world scale: large (the 50k world, default from round 3, amendment A1) or v1 (the 4k world, default for rounds 1-2)
#   LEDGER        default .budget/cat40-hard.sqlite (must match the roster)
#   BUDGET_USD    the step's --budget-usd instead of its projection plus 15% (the ledger gate still applies)
#   FREEZE_OVERRIDE  Garry's dated decision to freeze-check and freeze a round that fails the freeze rule; becomes the freeze note
#   PRINT_ONLY=1  print the commands instead of running them (guards are listed, not checked)
#
# Every refusal and stop-for-Garry condition exits 3 with a stable code (RUNBOOK.md lists them). A step that stops
# part way resumes by running the same step again: its --out directory is bound to the experiment, and the resume
# opens a new budget run (--new-budget-run) sized to the projection of the cells still missing.
set -euo pipefail
cd "$(dirname "$0")/.."

CMD="${1:-}"
STEP="${2:-}"
GBRAIN_REPO="${GBRAIN_REPO:-../gbrain}"
LEDGER="${LEDGER:-.budget/cat40-hard.sqlite}"
JUDGE=gpt-6.1-sol
MODELS=claude-sonnet-5-5,claude-opus-5-5,gpt-6.1-sol,claude-fable-5-1
CAL_MODELS=claude-sonnet-5-5,gpt-6-astra
CHECK_MODELS=claude-opus-5-5,claude-fable-5-1,gpt-6.1-sol
MEMORY_MODELS=claude-sonnet-5-5,gpt-6.1-sol
CAL_SEED=20261005
SMOKE_SEED=20261099
HELDOUT_SEED=20261006
DOCS=docs/benchmarks/cat40-hard
REPORTS=eval/reports/cat40/hard
HOLDOUT=eval/reports/cat40/hard-holdout
RUNNER=eval/runner/cat40-model-ladder.ts
GEN=eval/generators/model-ladder-gen.ts
OPS=eval/runner/cat40/hard-ops.ts
ANALYZE=eval/runner/cat40/analyze.ts
STATS=docs/benchmarks/2026-10-02-model-ladder/holdout/holdout_stats.py
GBRAIN_LABEL=gbrain-hard

print_only() { [[ "${PRINT_ONLY:-}" == 1 ]]; }
note() { echo "[cat40-hard] $*" >&2; }
stop() { # stop CODE what fix [decision]
  echo "[cat40-hard] STOP $1: $2" >&2; echo "  fix: $3" >&2; [[ -n "${4:-}" ]] && echo "  decision needed: $4" >&2; exit 3
}
run() {
  local arg line=''
  for arg in "$@"; do
    if [[ "$arg" =~ ^[A-Za-z0-9_./:=,@+-]+$ ]]; then line+="$arg "; else line+="$(printf '%q' "$arg") "; fi
  done
  echo "${line% }"
  print_only || "$@"
}
need() { # need <file> <what> : a predecessor artifact
  print_only && { echo "# requires: $2 ($1)"; return; }
  [[ -e "$1" ]] || stop HARD_PREDECESSOR_MISSING "$2 is missing ($1)" "run the step that produces it first; see scripts/cat40-hard.sh with no arguments for the order"
}
gbrain_ref() {
  [[ -n "${GBRAIN_REF:-}" ]] || { print_only && { echo '<GBRAIN_REF>'; return; }; stop HARD_PREDECESSOR_MISSING "GBRAIN_REF is not set" "export GBRAIN_REF=<gbrain master commit> (the preregistered commit)"; }
  print_only && { echo "$GBRAIN_REF"; return; }
  git -C "$GBRAIN_REPO" rev-parse --verify --quiet "$GBRAIN_REF^{commit}" || stop HARD_PREDECESSOR_MISSING "GBRAIN_REF=$GBRAIN_REF is not a commit in $GBRAIN_REPO" "fetch it, or fix GBRAIN_REF"
}
round() {
  [[ "${ROUND:-}" =~ ^[1-5]$ ]] || stop HARD_PREDECESSOR_MISSING "ROUND must be 1 to 5 (got '${ROUND:-}')" "export ROUND=<calibration round>; there are at most 5 tuning rounds"
  echo "$ROUND"
}
budget_decision() {
  print_only && { echo "# requires: the budget decision recorded in $DOCS/ledger-roster.json"; return; }
  bun -e "const r = JSON.parse(require('fs').readFileSync('$DOCS/ledger-roster.json', 'utf8')); process.exit(r.decision && r.authorization_usd ? 0 : 1)" \
    || stop HARD_BUDGET_DECISION_MISSING "no budget decision in $DOCS/ledger-roster.json" "record Garry's decision (tier and authorization) in the roster" "Garry picks the funded tier"
  bun "$OPS" roster >/dev/null || exit 3
}
# The step budget: the projection plus 15%, rounded up to a dollar. Extra args: --measured files.
budget_for() {
  local step="$1"; shift
  if [[ -n "${BUDGET_USD:-}" ]]; then echo "$BUDGET_USD"; return; fi
  if print_only; then echo '<projection+15%>'; return; fi
  bun "$OPS" project --step "$step" "$@" | bun -e 'const p = JSON.parse(await Bun.stdin.text()); console.log(Math.ceil(p.with_margin_usd))'
}
# Stop unless the Hard ledger has at least $1 dollars left (the projection plus 15%).
budget_gate() {
  print_only && { echo "# requires: the Hard ledger to have at least \$$1 left"; return; }
  local left
  left="$(bun eval/runner/budget-ledger.ts status --budget-ledger "$LEDGER" | bun -e 'const s = JSON.parse(await Bun.stdin.text()); console.log(s.totals.remaining_usd ?? -1)')"
  bun -e "process.exit(Number('$left') >= Number('$1') ? 0 : 1)" \
    || stop HARD_BUDGET_SHORT "the step projects \$$1 with the 15% margin; the Hard ledger has \$$left left" "do not raise the cap yourself" "Garry decides whether to fund, narrow or stop the step"
}
# A resume of a step whose budget run was spent opens a new run for the remaining cells (--new-budget-run).
resume_args() { print_only && return; [[ -f "$1/experiment.json" ]] && ! complete "$1" && echo --new-budget-run || true; }
done_arg() { [[ -f "$1/attempts.jsonl" ]] && echo "--done $1/attempts.jsonl" || true; }
measured() { # comma list of existing attempts files
  local out='' f
  for f in "$@"; do [[ -f "$f" ]] && out+="${out:+,}$f"; done
  [[ -n "$out" ]] && echo "--measured $out" || true
}
complete() { # complete <out dir>: the last receipt says complete and no planned cell is missing
  bun -e "const fs = require('fs'); const d = '$1'; if (!fs.existsSync(d)) process.exit(1); const r = fs.readdirSync(d).filter(f => /^receipt-\\d+\\.json$/.test(f)).sort().pop(); process.exit(r && JSON.parse(fs.readFileSync(d + '/' + r, 'utf8')).complete ? 0 : 1)"
}
harness_errors() { bun -e "const fs = require('fs'); const p = '$1/attempts.jsonl'; const n = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.stop === 'harness_error').length : 0; console.log(n)"; }
world_hash() { [[ -f "$1" ]] && sha256sum "$1" | cut -c1-64 || echo missing; }

COMMON=(--judge "$JUDGE" --budget-ledger "$LEDGER" --transcripts)

case "$CMD" in
  hello)
    out="${HELLO_OUT:-$(mktemp -d)}"
    run bun "$GEN" --mode hard --seed "$CAL_SEED" --knobs "$DOCS/knobs.default.json" --out "$out/world"
    run bun "$RUNNER" --scripted --world "$out/world/world.json" --arms fs,memory,oracle --out "$out/cells"
    run bun "$ANALYZE" "$out/cells/results.jsonl" --comparator fs
    set +e
    run bun "$ANALYZE" "$out/cells/results.jsonl" --freeze-rule --round 0
    set -e
    note "hello done in $out (scripted, \$0; the scripted oracle submits the answer key, so its rows show the scorer's success path)"
    ;;
  status)
    run bun eval/runner/budget-ledger.ts status --budget-ledger "$LEDGER" || true
    run bun "$OPS" roster || true
    run bun "$OPS" freeze check || true
    for d in "$REPORTS"/calibration/round-*/cells "$REPORTS"/calibration/round-*/freeze-check "$REPORTS"/smoke/cells "$REPORTS"/cells-50k-smoke "$REPORTS"/cells-50k "$REPORTS"/oracle-50k "$REPORTS"/pg-50k "$REPORTS"/memory-50k; do
      [[ -d "$d" ]] || continue
      if complete "$d"; then s=complete; else s=incomplete; fi
      echo "$d: $s, $(harness_errors "$d") harness-error attempts"
    done
    for w in "$HOLDOUT/50k/world.json" "$HOLDOUT/base-4k/world.json" "$REPORTS/smoke/world/world.json"; do echo "$w sha256 $(world_hash "$w")"; done
    ;;
  preflight|step)
    case "$STEP" in
      calibrate)
        R="$(round)"; KNOBS="$DOCS/knobs.round-$R.json"; DIR="$REPORTS/calibration/round-$R"
        SCALE="${SCALE:-$([[ "$R" -ge 3 ]] && echo large || echo v1)}"
        [[ "$SCALE" == v1 || "$SCALE" == large ]] || { echo "[cat40-hard] SCALE must be v1 or large (got '$SCALE')" >&2; exit 2; }
        if [[ "$R" == 1 && ! -f "$KNOBS" ]]; then print_only || cp "$DOCS/knobs.default.json" "$KNOBS"; fi
        need "$KNOBS" "the round's knob file (record the knob change and its reason in $DOCS/calibration.md first)"
        if [[ "$R" -gt 1 ]]; then need "$REPORTS/calibration/round-$((R - 1))/cells/results.jsonl" "round $((R - 1))'s results"; fi
        budget_decision
        if [[ "$SCALE" == large ]]; then
          run bun "$GEN" --mode hard --seed "$CAL_SEED" --knobs "$KNOBS" --out "$DIR/base-4k"
          run bun "$GEN" --mode hard --seed "$CAL_SEED" --knobs "$KNOBS" --scale large --base-world "$DIR/base-4k/world.json" --out "$DIR/world"
        else
          run bun "$GEN" --mode hard --seed "$CAL_SEED" --knobs "$KNOBS" --out "$DIR/world"
        fi
        ARGS=(--world "$DIR/world/world.json" --models "$CAL_MODELS" --arms oracle,fs,pg --per-family 10 --repeat 1 --concurrency 6 "${COMMON[@]}" --out "$DIR/cells" --step calibrate)
        PRIOR=(); for p in "$REPORTS"/calibration/round-*/cells/attempts.jsonl; do [[ -f "$p" ]] && PRIOR+=("$p"); done
        M="$(measured ${PRIOR[@]+"${PRIOR[@]}"})"
        if [[ "$CMD" == preflight ]]; then HARD_MEASURED="${M#--measured }" run bun "$RUNNER" "${ARGS[@]}" --preflight; exit; fi
        B="$(budget_for calibrate --scale "$SCALE" --world "$DIR/world/world.json" $M $(done_arg "$DIR/cells"))"
        budget_gate "$B"
        HARD_MEASURED="${M#--measured }" run bun "$RUNNER" "${ARGS[@]}" --preflight
        run bun "$RUNNER" "${ARGS[@]}" --budget-usd "$B" $(resume_args "$DIR/cells")
        set +e
        run bun "$ANALYZE" "$DIR/cells/results.jsonl" --freeze-rule --round "$R" --calibration-md "$DOCS/calibration.md"; rc=$?
        set -e
        print_only && exit 0
        if [[ $rc -ne 0 ]]; then
          [[ "$R" -lt 5 ]] && stop HARD_FREEZE_RULE_FAILED "round $R fails the freeze rule (table appended to $DOCS/calibration.md)" "read oracle failures first; then write knobs.round-$((R + 1)).json changing the knob group the analyzer names, with a dated reason in calibration.md, and run ROUND=$((R + 1)) $0 step calibrate"
          stop HARD_FREEZE_RULE_FAILED "round 5 fails the freeze rule; no tuning rounds remain" "stop" "Garry decides with the calibration table in $DOCS/calibration.md"
        fi
        note "round $R passes the freeze rule on $CAL_MODELS; next: ROUND=$R $0 step freeze-check"
        ;;
      freeze-check)
        R="$(round)"; DIR="$REPORTS/calibration/round-$R"
        need "$DIR/cells/results.jsonl" "round $R's results"
        if ! print_only; then
          n=$(find "$REPORTS/calibration" -mindepth 2 -maxdepth 2 -type d -name freeze-check ! -path "*/round-$R/*" | wc -l)
          [[ "$n" -lt 2 ]] || stop HARD_FREEZE_RULE_FAILED "2 freeze checks already ran" "stop" "Garry decides with the calibration table"
          bun "$ANALYZE" "$DIR/cells/results.jsonl" --freeze-rule --round "$R" >/dev/null || [[ -n "${FREEZE_OVERRIDE:-}" ]] || stop HARD_PREDECESSOR_MISSING "round $R does not pass the freeze rule" "a freeze check runs only after a passing round, or with FREEZE_OVERRIDE naming Garry's dated decision"
        fi
        budget_decision
        ARGS=(--world "$DIR/world/world.json" --models "$CHECK_MODELS" --arms oracle,fs,pg --per-family 10 --repeat 1 --concurrency 6 "${COMMON[@]}" --out "$DIR/freeze-check" --step freeze-check)
        M="$(measured "$DIR/cells/attempts.jsonl")"
        if [[ "$CMD" == preflight ]]; then HARD_MEASURED="${M#--measured }" run bun "$RUNNER" "${ARGS[@]}" --preflight; exit; fi
        WSCALE="$(print_only && echo '<round scale>' || bun -e "console.log(JSON.parse(require('fs').readFileSync('$DIR/world/manifest.json', 'utf8')).scale)")"
        B="$(budget_for freeze-check --scale "$WSCALE" --world "$DIR/world/world.json" $M $(done_arg "$DIR/freeze-check"))"
        budget_gate "$B"
        run bun "$RUNNER" "${ARGS[@]}" --budget-usd "$B" $(resume_args "$DIR/freeze-check")
        set +e
        run bun "$ANALYZE" "$DIR/cells/results.jsonl" "$DIR/freeze-check/results.jsonl" --freeze-rule --round "$R" --calibration-md "$DOCS/calibration.md"; rc=$?
        set -e
        print_only && exit 0
        [[ $rc -eq 0 || -n "${FREEZE_OVERRIDE:-}" ]] || stop HARD_FREEZE_RULE_FAILED "the freeze check on round $R's world fails on the five models" "tune again within the round limit (ROUND=$((R + 1)) step calibrate) or stop after 2 freeze checks" "Garry decides when no rounds or freeze checks remain"
        note "freeze check passes; next: ROUND=$R $0 step freeze"
        ;;
      freeze)
        R="$(round)"
        need "$REPORTS/calibration/round-$R/freeze-check/results.jsonl" "round $R's passing freeze check"
        [[ "$CMD" == preflight ]] && { echo "freeze is free; it writes $DOCS/knobs.frozen.json and $DOCS/freeze.json"; exit 0; }
        run bun "$OPS" freeze write --knobs "$DOCS/knobs.round-$R.json" --note "${FREEZE_OVERRIDE:-round $R passed the freeze rule and the five-model freeze check} ($(date -u +%F))"
        note "commit $DOCS/knobs.frozen.json and $DOCS/freeze.json now; next: GBRAIN_REF=<master> $0 step smoke"
        ;;
      smoke)
        need "$DOCS/freeze.json" "the freeze record"
        REF="$(gbrain_ref)"; budget_decision
        run bun "$GEN" --mode hard --seed "$SMOKE_SEED" --knobs "$DOCS/knobs.frozen.json" --out "$REPORTS/smoke/world"
        SLOTS=(--build-slots --world "$REPORTS/smoke/world/world.json" --gbrain-repo "$GBRAIN_REPO" --gbrain-ref "$REF" --slots 1 --slot-build-allowance-usd 2 --budget-ledger "$LEDGER" --out "$REPORTS/smoke/slots")
        ARGS=(--world "$REPORTS/smoke/world/world.json" --models claude-sonnet-5-5 --arms gbrain --gbrain-label "$GBRAIN_LABEL" --gbrain-repo "$GBRAIN_REPO" --gbrain-ref "$REF" --slots 1 --concurrency 1 --per-family 1 "${COMMON[@]}" --out "$REPORTS/smoke/cells" --step smoke)
        if [[ "$CMD" == preflight ]]; then run bun "$OPS" project --step smoke --world "$REPORTS/smoke/world/world.json"; exit; fi
        B="$(budget_for smoke $(done_arg "$REPORTS/smoke/cells"))"
        budget_gate "$B"
        run bun "$RUNNER" "${SLOTS[@]}" --budget-usd 3
        run bun "$RUNNER" "${ARGS[@]}" --budget-usd "$B" $(resume_args "$REPORTS/smoke/cells")
        print_only && exit 0
        n="$(harness_errors "$REPORTS/smoke/cells")"
        [[ "$n" == 0 ]] || stop HARD_SMOKE_FAILED "$n harness-error attempts in the gbrain smoke" "read $REPORTS/smoke/cells/attempts.jsonl, fix the harness (not the generator), rerun the smoke" "Garry decides if the fix touches the frozen generator"
        note "smoke clean; next: fill the preregistration, then $0 step heldout-world"
        ;;
      heldout-world)
        need "$REPORTS/smoke/cells/results.jsonl" "a clean gbrain smoke"
        print_only || grep -q "Held-out seed: $HELDOUT_SEED" "$DOCS/PREREGISTRATION.md" || stop HARD_PREREG_MISSING "PREREGISTRATION.md does not name the held-out seed" "write 'Held-out seed: $HELDOUT_SEED' and commit the preregistration before generating the held-out world"
        [[ "$CMD" == preflight ]] && { echo "heldout-world is free; it writes $HOLDOUT/50k and its base $HOLDOUT/base-4k (amendment A2: no 4k cells) and prints hashes only"; exit 0; }
        run bun "$GEN" --mode hard --seed "$HELDOUT_SEED" --knobs "$DOCS/knobs.frozen.json" --out "$HOLDOUT/base-4k"
        run bun "$GEN" --mode hard --seed "$HELDOUT_SEED" --knobs "$DOCS/knobs.frozen.json" --scale large --base-world "$HOLDOUT/base-4k/world.json" --out "$HOLDOUT/50k"
        print_only || note "record this in PREREGISTRATION.md (ENG-F18): 50k $(world_hash "$HOLDOUT/50k/world.json") (its 4k base $(world_hash "$HOLDOUT/base-4k/world.json") runs no cells). Do not open the worlds."
        ;;
      slots-4k|simple-4k|comparator|gbrain-4k)
        stop HARD_STEP_RETIRED "$STEP is a 4k held-out step, which amendment A2 (PREREGISTRATION.md) retired" "run the 50k path: heldout-world, slots-50k, cells-50k, oracle-50k, pg-50k, memory-50k, report"
        ;;
      slots-50k)
        W="$HOLDOUT/50k/world.json"
        need "$W" "the 50k held-out world"
        REF="$(gbrain_ref)"; budget_decision
        ARGS=(--build-slots --world "$W" --gbrain-repo "$GBRAIN_REPO" --gbrain-ref "$REF" --slots 5 --slot-build-allowance-usd 4 --budget-ledger "$LEDGER" --out "$REPORTS/$STEP")
        if [[ "$CMD" == preflight ]]; then run bun "$OPS" project --step "$STEP" --world "$W"; exit; fi
        B="$(budget_for "$STEP" --world "$W")"
        budget_gate "$B"
        run bun "$RUNNER" "${ARGS[@]}" --budget-usd "$B"
        ;;
      cells-50k|oracle-50k|pg-50k|memory-50k)
        W="$HOLDOUT/50k/world.json"
        need "$W" "the 50k held-out world"
        case "$STEP" in
          cells-50k) need "$REPORTS/slots-50k" "the 50k slot build step" ;;
          oracle-50k) PREV=cells-50k ;;
          pg-50k) PREV=oracle-50k ;;
          memory-50k) PREV=pg-50k ;;
        esac
        if [[ -n "${PREV:-}" ]]; then
          need "$REPORTS/$PREV/results.jsonl" "batch $PREV (the 50k batches run in order: cells-50k, oracle-50k, pg-50k, memory-50k)"
          print_only || complete "$REPORTS/$PREV" || stop HARD_CELLS_INCOMPLETE "batch $PREV is incomplete" "rerun $0 step $PREV to resume it first"
        fi
        budget_decision
        # Cost basis for the held-out batches: the frozen round (the one with a freeze check) and the 50k cells
        # already run. Earlier rounds asked smaller questions and would understate the cost per cell.
        FROZEN_DIR="$(dirname "$(ls -d "$REPORTS"/calibration/round-*/freeze-check 2>/dev/null | sort -V | tail -1)")"
        CAL=(); for p in "$FROZEN_DIR"/cells/attempts.jsonl "$FROZEN_DIR"/freeze-check/attempts.jsonl "$REPORTS"/cells-50k-smoke/attempts.jsonl "$REPORTS"/cells-50k/attempts.jsonl; do [[ -f "$p" ]] && CAL+=("$p"); done
        M="$(measured ${CAL[@]+"${CAL[@]}"})"
        case "$STEP" in
          cells-50k) REF="$(gbrain_ref)"; ARMS=(--models "$MODELS" --arms gbrain,fs --gbrain-label "$GBRAIN_LABEL" --gbrain-repo "$GBRAIN_REPO" --gbrain-ref "$REF" --slots 5) ;;
          oracle-50k) ARMS=(--models "$MODELS" --arms oracle) ;;
          pg-50k) ARMS=(--models "$MODELS" --arms pg) ;;
          memory-50k) ARMS=(--models "$MEMORY_MODELS" --arms memory) ;;
        esac
        ARGS=(--world "$W" "${ARMS[@]}" --concurrency 10 --repeat 1 "${COMMON[@]}" --out "$REPORTS/$STEP" --step "$STEP")
        if [[ "$CMD" == preflight ]]; then HARD_MEASURED="${M#--measured }" run bun "$RUNNER" "${ARGS[@]}" --preflight; exit; fi
        if [[ "$STEP" == cells-50k ]]; then
          SMOKE=(--world "$W" --models claude-sonnet-5-5 --arms gbrain --gbrain-label "$GBRAIN_LABEL" --gbrain-repo "$GBRAIN_REPO" --gbrain-ref "$REF" --slots 5 --concurrency 5 --per-family 1 "${COMMON[@]}" --out "$REPORTS/cells-50k-smoke")
          print_only || budget_gate 5
          run bun "$RUNNER" "${SMOKE[@]}" --budget-usd 5
          if ! print_only; then n="$(harness_errors "$REPORTS/cells-50k-smoke")"; [[ "$n" == 0 ]] || stop HARD_SMOKE_FAILED "$n harness-error attempts in the 50k 5-cell smoke" "read $REPORTS/cells-50k-smoke/attempts.jsonl and fix the harness before the 50k cells"; fi
        fi
        B="$(budget_for "$STEP" --world "$W" $M $(done_arg "$REPORTS/$STEP"))"
        budget_gate "$B"
        run bun "$RUNNER" "${ARGS[@]}" --budget-usd "$B" $(resume_args "$REPORTS/$STEP")
        ;;
      report)
        [[ "$CMD" == preflight ]] && { echo "report is free"; exit 0; }
        need "$REPORTS/cells-50k/attempts.jsonl" "the primary 50k batch (cells-50k)"
        FILES=("$REPORTS/cells-50k/attempts.jsonl"); SIMPLE=fs
        if [[ -f "$REPORTS/pg-50k/attempts.jsonl" ]] && { print_only || complete "$REPORTS/pg-50k"; }; then FILES+=("$REPORTS/pg-50k/attempts.jsonl"); SIMPLE=fs,pg; fi
        run python3 "$STATS" "${FILES[@]}" --hard-headline "$GBRAIN_LABEL,fs" --simple "$SIMPLE"
        for b in oracle-50k memory-50k; do [[ -f "$REPORTS/$b/attempts.jsonl" ]] && FILES+=("$REPORTS/$b/attempts.jsonl"); done
        run bun "$ANALYZE" "${FILES[@]}" --subject "$GBRAIN_LABEL" --comparator fs --md "$REPORTS/analysis-50k.md" --json "$REPORTS/analysis-50k.json" --budget-ledger "$LEDGER"
        ;;
      *) stop HARD_PREDECESSOR_MISSING "unknown step '$STEP'" "use one of: calibrate freeze-check freeze smoke heldout-world slots-50k cells-50k oracle-50k pg-50k memory-50k report" ;;
    esac
    ;;
  *)
    sed -n '2,36p' "$0" | sed 's/^# \{0,1\}//'
    [[ -z "$CMD" || "$CMD" == help || "$CMD" == --help ]] && exit 0
    exit 2
    ;;
esac
