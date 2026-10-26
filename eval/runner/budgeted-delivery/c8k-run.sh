#!/usr/bin/env bash
# The 8k conversion custody chain (docs/benchmarks/2026-10-26-gbrain-8k-conversion-preregistration.md) and its
# development reading. The custodian runs both on the custody machine from the repository root at the registration
# commit; everything sealed-derived stays under the custody root, and only <root>/export/ and the access log leave it.
#
#   bash eval/runner/budgeted-delivery/c8k-run.sh dev <custody root> <gbrain checkout>
#   C8K_SEALED_SRC=<owner's private dir with questions.json, labels.json, access-log.jsonl> \
#     bash eval/runner/budgeted-delivery/c8k-run.sh all <custody root> <gbrain checkout>
#
# "dev" (LongMemEval-S dev100, public labels, decides nothing; under <root>/dev):
#   dev-corpus -> [dev-import] -> [dev-extract] -> [dev-freeze] -> gate (retrieval) -> [dev-read] -> gate (final)
#   -> answers -> [dev-score] -> dev-summary
# "all" (sealed confirmation v2, the last opening):
#   custody-check -> corpus -> [import] -> [extract] -> [freeze] -> gate (retrieval) -> [read-sonnet] -> [read-frontier]
#   -> gate (final) -> answers -> [score] -> compare -> decide -> budget -> export -> the access log returned
# Bracketed steps are local lease cells of one campaign (manifests/campaign.json, $300 over both) with the campaign
# state inside the root, so "dev" and "all" share one ledger. A rerun resumes: finished steps are skipped, histories
# already imported, extracted or frozen are kept, and identical reader requests come from the custody QA cache.
#
# Environment: C8K_DECISION (default the committed decision.json), C8K_CAMPAIGN (default the committed campaign),
# C8K_KEYLESS=1 for the keyless dry run (hash vectors, the reranker off, dummy keys, and SHOOTOUT_KEYLESS_UPSTREAM
# pointing every lease proxy at budgeted-delivery/stub-proxy.ts), C8K_DEV_LIMIT (default the decision's 100).
set -euo pipefail
H=eval/runner/budgeted-delivery
DIR=docs/benchmarks/2026-10-26-gbrain-8k-conversion
BUN_PIN=1.4.2
py() { python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print(eval(sys.argv[2]))" "$C8K_DECISION" "$1"; }
log() { echo "[c8k-run] $*" >&2; }
done_mark() { mkdir -p "$C8K_ROOT/runs/done" && touch "$C8K_ROOT/runs/done/$1"; }
is_done() { [ -e "$C8K_ROOT/runs/done/$1" ]; }

setup_env() {
  export C8K_DECISION=${C8K_DECISION:-$DIR/decision.json}
  ID=$(py "d['decision_id']") COMMIT=$(py "d['gbrain']['commit']") M=$(py "d['sealed']['manifest']")
  S=$C8K_ROOT/sealed R=$C8K_ROOT/runs V=$C8K_ROOT/dev
  export TMPDIR=$C8K_ROOT/tmp GBRAIN_EVALS_CUSTODY_LOG=$C8K_ROOT/sealed/access-log.jsonl GBRAIN_EVALS_QA_CACHE=$C8K_ROOT/cache/qa
  export GBRAIN_HOME=$C8K_ROOT/gbrain-home
  GB=(--gbrain "$C8K_GBRAIN@$COMMIT")
  [ "${C8K_KEYLESS:-}" = 1 ] && GB+=(--keyless)
  return 0
}
c8k() { bun $H/c8k.ts "$1" --custody-root "$C8K_ROOT" --decision "$C8K_DECISION" "${@:2}"; }
dev() { c8k "$1" --development --access-log "$V/access-log.jsonl" "${@:2}"; }

# extract <c8k|dev> <dir>: extraction is serial on PGLite, so C8K_EXTRACT_SHARDS (default 4) processes take every nth
# history each, then one pass checks that every history finished and writes the summary.
extract() {
  local n=${C8K_EXTRACT_SHARDS:-4} pids=() k
  for ((k = 0; k < n; k++)); do "$1" extract --corpus "$2/corpus.json" --brains "$2/brains" "${GB[@]}" --shard "$k" --shards "$n" > /dev/null & pids+=($!); done
  for k in ${pids[@]+"${pids[@]}"}; do wait "$k"; done
  "$1" extract --corpus "$2/corpus.json" --brains "$2/brains" "${GB[@]}" --out "$2/extract.json" > /dev/null
}

# ─── One lease cell (run by shootout-cell.ts behind the lease proxy) ───
if [ "${1:-}" = cell ]; then
  STEP=$2
  : "${C8K_ROOT:?cell steps run under c8k-run.sh all or dev}" "${C8K_GBRAIN:?}" "${SHOOTOUT_PROXY:?cell steps run behind a lease proxy}"
  setup_env
  case "$STEP" in
    import|freeze) c8k "$STEP" --corpus "$R/corpus.json" --brains "$R/brains" --evidence-dir "$R/evidence" "${GB[@]}" --out "$R/$STEP.json" > /dev/null ;;
    dev-import|dev-freeze) dev "${STEP#dev-}" --corpus "$V/corpus.json" --brains "$V/brains" --evidence-dir "$V/evidence" "${GB[@]}" --out "$V/${STEP#dev-}.json" > /dev/null ;;
    extract) extract c8k "$R" ;;
    dev-extract) extract dev "$V" ;;
    read-sonnet) c8k read --corpus "$R/corpus.json" --evidence-dir "$R/evidence" --readers-dir "$R/readers" --reader sonnet-5-5 --out "$R/read/sonnet-5-5.json" > /dev/null ;;
    read-frontier)
      for r in opus-5-5 gpt-6-1-sol; do c8k read --corpus "$R/corpus.json" --evidence-dir "$R/evidence" --readers-dir "$R/readers" --reader "$r" --out "$R/read/$r.json" > /dev/null; done ;;
    dev-read)
      for r in $(py "' '.join(sorted({a['reader'] for a in d['answer_arms'] if a['role'] == 'development'}))"); do
        dev read --corpus "$V/corpus.json" --evidence-dir "$V/evidence" --readers-dir "$V/readers" --reader "$r" --qa-cache "$V/cache/qa" --out "$V/read/$r.json" > /dev/null
      done ;;
    dev-score) dev dev-score --corpus "$V/corpus.json" --answers-dir "$V/answers" --out-dir "$V/scores" --qa-cache "$V/cache/qa" --out "$V/scores-summary.json" > /dev/null ;;
    score)
      chmod 400 "$S/labels.json"
      mkdir -p "$R/scores"
      for arm in $(py "' '.join(a['id'] for a in d['answer_arms'] if a['role'] in ('primary', 'replay'))"); do
        [ -e "$R/scores/$arm.json" ] && continue
        bun eval/runner/sealed-confirmation.ts score --manifest "$M" --questions "$S/questions.json" --labels "$S/labels.json" \
          --run "$R/answers/$arm.jsonl" --judge --top-k 1000 --cap-usd 2 --spend "$R/scores/spend.jsonl" --custody-root "$C8K_ROOT" \
          --purpose "8k conversion ($arm) at gbrain ${COMMIT:0:9}" --decision-id "$ID" --out "$R/scores/$arm.json" > /dev/null
      done
      chmod 000 "$S/labels.json" ;;
    *) echo "unknown cell step $STEP" >&2; exit 2 ;;
  esac
  done_mark "cell-$STEP"
  exit 0
fi

MODE=${1:-}
[ "$MODE" = all ] || [ "$MODE" = dev ] || { sed -n 2,22p "$0" >&2; exit 2; }
[ "$MODE" = dev ] || [ -n "${C8K_SEALED_SRC:-}" ] || { echo "set C8K_SEALED_SRC to the owner's private directory" >&2; exit 2; }
mkdir -p "$2"
export C8K_ROOT=$(cd "$2" && pwd -P) C8K_GBRAIN=$(cd "$3" && pwd -P)
setup_env
CAMPAIGN=${C8K_CAMPAIGN:-$DIR/manifests/campaign.json}
mkdir -p "$R" "$V" "$TMPDIR" "$GBRAIN_HOME" "$C8K_ROOT/cache"
git -C "$C8K_GBRAIN" cat-file -e "$COMMIT^{commit}" 2>/dev/null || { echo "the gbrain checkout has no commit $COMMIT (write the wave's merge commit into the decision first)" >&2; exit 2; }
if [ "${C8K_KEYLESS:-}" = 1 ] && [ -z "${SHOOTOUT_KEYLESS_UPSTREAM:-}" ]; then echo "C8K_KEYLESS=1 needs SHOOTOUT_KEYLESS_UPSTREAM (the stub proxy)" >&2; exit 2; fi
if [ "${C8K_KEYLESS:-}" != 1 ] && [ -n "${SHOOTOUT_KEYLESS_UPSTREAM:-}" ]; then echo "SHOOTOUT_KEYLESS_UPSTREAM is set outside a keyless dry run" >&2; exit 2; fi

# Bun 1.4.2 (the CI pin) inside the root, whatever the host has.
if [ "$(bun --version 2>/dev/null)" != "$BUN_PIN" ]; then
  if [ ! -x "$C8K_ROOT/bun/bin/bun" ]; then log "installing Bun $BUN_PIN into the custody root"; curl -fsSL https://bun.sh/install | BUN_INSTALL="$C8K_ROOT/bun" bash -s "bun-v$BUN_PIN" > /dev/null; fi
  export PATH="$C8K_ROOT/bun/bin:$PATH"
fi
[ "$(bun --version)" = "$BUN_PIN" ] || { echo "bun $(bun --version) is not $BUN_PIN" >&2; exit 2; }

run_cell() {
  is_done "cell-$1" && return 0
  local st=$C8K_ROOT/state
  [ -e "$st/state.json" ] || bun eval/runner/shootout-cell.ts init --campaign "$CAMPAIGN" --state "$st" > /dev/null
  log "cell c8k-$1: reserve and launch"
  bun eval/runner/shootout-cell.ts reserve --campaign "$CAMPAIGN" --state "$st" --cell "c8k-$1" > /dev/null
  bun eval/runner/shootout-cell.ts launch --campaign "$CAMPAIGN" --state "$st" --cell "c8k-$1" > "$st/launch-$1.json"
  is_done "cell-$1" || { echo "cell c8k-$1 did not finish; rerun c8k-run.sh $MODE to resume it" >&2; exit 1; }
}
# gate <phase> <out> <command...>: kept only when it passes; a failed gate stops the chain and prints its problems.
gate() {
  local phase=$1 out=$2; shift 2
  [ -e "$out" ] && return 0
  if "$@" --phase "$phase" --out "$out.tmp" > /dev/null; then mv "$out.tmp" "$out"; else
    python3 -c "import json,sys;print('\n'.join(json.load(open(sys.argv[1])).get('problems', [])))" "$out.tmp" >&2 || true
    echo "the $phase gate failed; nothing after it runs" >&2; exit 1
  fi
}

if [ "$MODE" = dev ]; then
  touch "$V/access-log.jsonl"
  [ -e "$V/corpus.json" ] || dev dev-corpus --corpus-out "$V/corpus.json" ${C8K_DEV_LIMIT:+--limit "$C8K_DEV_LIMIT"} --out "$V/corpus-summary.json" > /dev/null
  run_cell dev-import
  run_cell dev-extract
  run_cell dev-freeze
  gate retrieval "$V/gate-retrieval.json" dev gate --corpus "$V/corpus.json" --evidence-dir "$V/evidence" "${GB[@]}"
  run_cell dev-read
  gate final "$V/gate.json" dev gate --corpus "$V/corpus.json" --evidence-dir "$V/evidence" --readers-dir "$V/readers" "${GB[@]}"
  [ -e "$V/answers-summary.json" ] || dev answers --corpus "$V/corpus.json" --readers-dir "$V/readers" --out-dir "$V/answers" --out "$V/answers-summary.json" > /dev/null
  run_cell dev-score
  dev dev-summary --corpus "$V/corpus.json" --scores-dir "$V/scores" --readers-dir "$V/readers" --evidence-dir "$V/evidence" --out "$V/dev-summary.json" > /dev/null
  bun eval/runner/shootout-cell.ts status --campaign "$CAMPAIGN" --state "$C8K_ROOT/state" > "$V/ledger-status.json"
  c8k budget --development --status "$V/ledger-status.json" --out "$V/ledger-summary.json" > /dev/null
  log "development reading done: $V/dev-summary.json"
  exit 0
fi

# The sealed files, copied once from the owner's private directory.
mkdir -p "$S"
for f in questions.json labels.json access-log.jsonl; do
  [ -e "$S/$f" ] || { chmod u+r "$C8K_SEALED_SRC/$f" 2>/dev/null || true; cp "$C8K_SEALED_SRC/$f" "$S/$f"; }
done
if [ ! -e "$R/custody-check.json" ]; then
  chmod 400 "$S/labels.json"
  c8k custody-check --manifest "$M" --questions "$S/questions.json" --labels "$S/labels.json" --out "$R/custody-check.json" > /dev/null
fi
chmod 000 "$S/labels.json"
[ -e "$R/corpus.json" ] || c8k corpus --manifest "$M" --questions "$S/questions.json" --purpose "custody corpus for the 8k conversion cells" --corpus-out "$R/corpus.json" > /dev/null
run_cell import
run_cell extract
run_cell freeze
gate retrieval "$R/gate-retrieval.json" c8k gate --corpus "$R/corpus.json" --evidence-dir "$R/evidence" "${GB[@]}"
run_cell read-sonnet
run_cell read-frontier
gate final "$R/gate.json" c8k gate --corpus "$R/corpus.json" --evidence-dir "$R/evidence" --readers-dir "$R/readers" "${GB[@]}"
[ -e "$R/answers-summary.json" ] || c8k answers --corpus "$R/corpus.json" --readers-dir "$R/readers" --out-dir "$R/answers" --out "$R/answers-summary.json" > /dev/null
run_cell score
mkdir -p "$R/compare"
primary() { py "[a['id'] for a in d['answer_arms'] if a['role'] == 'primary' and a['arm'] == '$1'][0]"; }
cmp() { bun eval/runner/compare.ts "$R/scores/$1.json" "$R/scores/$2.json" --family "$3" --rows-path per_question --json > "$R/compare/$4.json"; }
for pair in $(py "' '.join(c['id'] + ':' + c['a'] + ':' + c['b'] for c in d['rule']['comparisons'])"); do
  IFS=: read -r cid ca cb <<< "$pair"
  cmp "$(primary "$ca")" "$(primary "$cb")" $DIR/family.json "$cid"
done
cmp "$(primary "$(py "d['rule']['f1_noninferiority']['reference']")")" "$(primary "$(py "d['rule']['f1_noninferiority']['candidate']")")" $DIR/family.json F1-noninferiority
for pair in $(py "' '.join(c['id'] + ':' + c['a'] + ':' + c['b'] for c in d['descriptive']['comparisons'])"); do
  IFS=: read -r cid ca cb <<< "$pair"
  cmp "$ca" "$cb" $DIR/family-descriptive.json "$cid"
done
c8k decide --gate "$R/gate.json" --compare-dir "$R/compare" --scores-dir "$R/scores" --answers-dir "$R/answers" --out "$R/decision-outcome.json" > /dev/null
bun eval/runner/shootout-cell.ts status --campaign "$CAMPAIGN" --state "$C8K_ROOT/state" > "$R/ledger-status.private.json"
mkdir -p "$R/ledger"
c8k budget --status "$R/ledger-status.private.json" --out "$R/ledger/summary.json" > /dev/null
rm -rf "$C8K_ROOT/export"
c8k export --corpus "$R/corpus.json" --runs "$R" --export-dir "$C8K_ROOT/export" > /dev/null
# The access log goes back to the owner's directory: only lines appended under this decision may differ.
c8k return-log --from "$S/access-log.jsonl" --to "$C8K_SEALED_SRC/access-log.jsonl" > /dev/null
log "outcome: $(python3 -c "import json;print(json.load(open('$R/decision-outcome.json'))['outcome'])"); export: $C8K_ROOT/export"
