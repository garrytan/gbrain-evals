#!/usr/bin/env bash
# The budgeted delivery H1 custody chain (docs/benchmarks/2026-10-10-gbrain-budgeted-delivery-h1-preregistration.md).
# The custodian runs it on the custody machine from the repository root at the registration commit; everything
# sealed-derived stays under the custody root, and only <root>/export/ and the access log leave it.
#
#   H1_SEALED_SRC=<owner's private dir with questions.json, labels.json, access-log.jsonl> \
#     bash eval/runner/budgeted-delivery/h1-run.sh all <custody root> <gbrain checkout>
#
# `all` pins Bun 1.4.2 inside the root, copies the sealed files into <root>/sealed/, then runs, stopping at the first
# failure (a rerun resumes: finished steps are skipped, memory-qa keeps finished rows, identical reader requests come
# from the custody QA cache, and frozen questions are never retrieved again):
#   custody-check -> corpus -> [freeze] -> [deliver] -> gate (deliver) -> [read-sonnet] -> [read-frontier]
#   -> gate (final) -> answers -> [score] -> compare -> decide -> budget -> export -> the access log returned
# Bracketed steps are local lease cells of the H1 campaign (manifests/campaign.json; eval/runner/shootout-cell.ts) with
# the campaign state inside the root: each runs `h1-run.sh cell <step>` behind its own lease proxy and ledger.
#
# Environment: H1_DECISION (default the committed decision.json), H1_CAMPAIGN (default the committed campaign),
# H1_SHARDS (default 4), H1_KEYLESS=1 for the keyless dry run (hash vectors and the reranker off in the freeze, and
# SHOOTOUT_KEYLESS_UPSTREAM pointing every lease proxy at budgeted-delivery/stub-proxy.ts).
set -euo pipefail
H=eval/runner/budgeted-delivery
DIR=docs/benchmarks/2026-10-10-gbrain-budgeted-delivery-h1
A=$DIR/manifests/arms
BUN_PIN=1.4.2
py() { python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print(eval(sys.argv[2]))" "$H1_DECISION" "$1"; }
log() { echo "[h1-run] $*" >&2; }
done_mark() { mkdir -p "$H1_ROOT/runs/done" && touch "$H1_ROOT/runs/done/$1"; }
is_done() { [ -e "$H1_ROOT/runs/done/$1" ]; }

setup_env() {
  export H1_DECISION=${H1_DECISION:-$DIR/decision.json} H1_SHARDS=${H1_SHARDS:-4}
  ID=$(py "d['decision_id']") COMMIT=$(py "d['gbrain']['commit']") BP=$(py "d['construction']['b_pseudo']") M=$(py "d['sealed']['manifest']")
  S=$H1_ROOT/sealed R=$H1_ROOT/runs MQ=$H1_ROOT/runs/memory-qa
  export TMPDIR=$H1_ROOT/tmp GBRAIN_EVALS_CUSTODY_LOG=$H1_ROOT/sealed/access-log.jsonl
  export GBRAIN_EVALS_QA_CACHE=$H1_ROOT/cache/qa GBRAIN_EVALS_EMBED_CACHE_ROOT=$H1_ROOT/cache/embed-shards
  COMMON=(--benchmark custody --corpus-file "$R/corpus.json" --split sealed --decision-id "$ID" --sealed-profile "$H1_ROOT"
    --system gbrain-query --embedding-model openai:text-embedding-3-large --embedding-dims 1536 --gbrain "$H1_GBRAIN@$COMMIT" --policy-setting variants=e2)
  DELIVER=(--embed hash --config search.reranker.enabled=false --policy-setting stage=deliver --policy-setting deliver_set=h1
    --policy-setting "b_pseudo=$BP" --frozen-from "$MQ/frozen.ndjson")
}

# ─── One lease cell (run by shootout-cell.ts behind the lease proxy) ───
if [ "${1:-}" = cell ]; then
  STEP=$2
  : "${H1_ROOT:?cell steps run under h1-run.sh all}" "${H1_GBRAIN:?}" "${SHOOTOUT_PROXY:?cell steps run behind a lease proxy}"
  setup_env
  case "$STEP" in
    freeze)
      if [ "${H1_KEYLESS:-}" = 1 ]; then EMB=(--embed hash --config search.reranker.enabled=false); else EMB=(--embed real); fi
      bash $H/e2-parallel.sh "$H1_SHARDS" "$MQ/freeze" -- "${COMMON[@]}" "${EMB[@]}" --purpose "budgeted delivery H1: freeze one ranked list per question" \
        --arms $A/retrieval-only.json --policy-setting stage=freeze
      cat "$MQ"/freeze/shard-*/retrievals/rows.ndjson > "$MQ/frozen.ndjson" ;;
    deliver)
      bash $H/e2-parallel.sh "$H1_SHARDS" "$MQ/deliver" -- "${COMMON[@]}" "${DELIVER[@]}" --purpose "budgeted delivery H1: deliver every arm from the frozen list" \
        --arms $A/retrieval-only.json ;;
    read-sonnet|read-frontier)
      E2_PARALLEL_MAX=${E2_PARALLEL_MAX:-4} bash $H/e2-parallel.sh "$H1_SHARDS" "$MQ/deliver" -- "${COMMON[@]}" "${DELIVER[@]}" \
        --purpose "budgeted delivery H1: $STEP readers on the frozen contexts" --arms "$A/$STEP.json" --replay ;;
    score)
      chmod 400 "$S/labels.json"
      mkdir -p "$R/scores"
      ARMS=$(py "' '.join([d['rule']['control_arm'], d['rule']['candidate_arm']] + [a['id'] for a in d['answer_arms'] if a['id'] not in (d['rule']['control_arm'], d['rule']['candidate_arm'])])")
      for arm in $ARMS; do
        [ -e "$R/scores/$arm.json" ] && continue
        bun eval/runner/sealed-confirmation.ts score --manifest "$M" --questions "$S/questions.json" --labels "$S/labels.json" \
          --run "$R/answers/$arm.jsonl" --judge --top-k 1000 --cap-usd 8 --spend "$R/scores/spend.jsonl" --custody-root "$H1_ROOT" \
          --purpose "budgeted delivery H1 ($arm): depth_first vs cap_only at gbrain ${COMMIT:0:9}" --decision-id "$ID" --out "$R/scores/$arm.json" > /dev/null
      done
      chmod 000 "$S/labels.json" ;;
    *) echo "unknown cell step $STEP" >&2; exit 2 ;;
  esac
  done_mark "cell-$STEP"
  exit 0
fi

[ "${1:-}" = all ] || { sed -n 2,19p "$0" >&2; exit 2; }
[ -n "${H1_SEALED_SRC:-}" ] || { echo "set H1_SEALED_SRC to the owner's private directory" >&2; exit 2; }
mkdir -p "$2"
export H1_ROOT=$(cd "$2" && pwd -P) H1_GBRAIN=$(cd "$3" && pwd -P)
setup_env
CAMPAIGN=${H1_CAMPAIGN:-$DIR/manifests/campaign.json}
mkdir -p "$S" "$R" "$TMPDIR" "$H1_ROOT/cache"
git -C "$H1_GBRAIN" cat-file -e "$COMMIT^{commit}" || { echo "the gbrain checkout has no commit $COMMIT" >&2; exit 2; }
if [ "${H1_KEYLESS:-}" = 1 ] && [ -z "${SHOOTOUT_KEYLESS_UPSTREAM:-}" ]; then echo "H1_KEYLESS=1 needs SHOOTOUT_KEYLESS_UPSTREAM (the stub proxy)" >&2; exit 2; fi
if [ "${H1_KEYLESS:-}" != 1 ] && [ -n "${SHOOTOUT_KEYLESS_UPSTREAM:-}" ]; then echo "SHOOTOUT_KEYLESS_UPSTREAM is set outside a keyless dry run" >&2; exit 2; fi

# Bun 1.4.2 (the CI pin) inside the root, whatever the host has.
if [ "$(bun --version 2>/dev/null)" != "$BUN_PIN" ]; then
  if [ ! -x "$H1_ROOT/bun/bin/bun" ]; then log "installing Bun $BUN_PIN into the custody root"; curl -fsSL https://bun.sh/install | BUN_INSTALL="$H1_ROOT/bun" bash -s "bun-v$BUN_PIN" > /dev/null; fi
  export PATH="$H1_ROOT/bun/bin:$PATH"
fi
[ "$(bun --version)" = "$BUN_PIN" ] || { echo "bun $(bun --version) is not $BUN_PIN" >&2; exit 2; }

# The sealed files, copied once from the owner's private directory.
for f in questions.json labels.json access-log.jsonl; do
  [ -e "$S/$f" ] || { chmod u+r "$H1_SEALED_SRC/$f" 2>/dev/null || true; cp "$H1_SEALED_SRC/$f" "$S/$f"; }
done
h1() { bun $H/h1.ts "$@" --custody-root "$H1_ROOT" --decision "$H1_DECISION"; }
cells() { for c in "$MQ"/deliver/shard-*/; do printf -- '--cell\n%s\n' "${c%/}"; done; }
run_cell() {
  is_done "cell-$1" && return 0
  local st=$H1_ROOT/state
  [ -e "$st/state.json" ] || bun eval/runner/shootout-cell.ts init --campaign "$CAMPAIGN" --state "$st" > /dev/null
  log "cell h1-$1: reserve and launch"
  bun eval/runner/shootout-cell.ts reserve --campaign "$CAMPAIGN" --state "$st" --cell "h1-$1" > /dev/null
  bun eval/runner/shootout-cell.ts launch --campaign "$CAMPAIGN" --state "$st" --cell "h1-$1" > "$R/launch-$1.json"
  is_done "cell-$1" || { echo "cell h1-$1 did not finish; rerun h1-run.sh all to resume it" >&2; exit 1; }
}

if [ ! -e "$R/custody-check.json" ]; then
  chmod 400 "$S/labels.json"
  h1 custody-check --manifest "$M" --questions "$S/questions.json" --labels "$S/labels.json" --out "$R/custody-check.json" > /dev/null
fi
chmod 000 "$S/labels.json"
[ -e "$R/corpus.json" ] || h1 corpus --manifest "$M" --questions "$S/questions.json" --purpose "custody corpus for the memory-qa cells" --corpus-out "$R/corpus.json" > /dev/null
run_cell freeze
run_cell deliver
[ -e "$R/gate-deliver.json" ] || { h1 gate --phase deliver --corpus "$R/corpus.json" $(cells) --out "$R/gate-deliver.json.tmp" > /dev/null && mv "$R/gate-deliver.json.tmp" "$R/gate-deliver.json"; }
run_cell read-sonnet
run_cell read-frontier
[ -e "$R/gate.json" ] || { h1 gate --phase final --corpus "$R/corpus.json" $(cells) --out "$R/gate.json.tmp" > /dev/null && mv "$R/gate.json.tmp" "$R/gate.json"; }
[ -e "$R/answers-summary.json" ] || h1 answers --corpus "$R/corpus.json" $(cells) --out-dir "$R/answers" --out "$R/answers-summary.json" > /dev/null
run_cell score
mkdir -p "$R/compare"
CTRL=$(py "d['rule']['control_arm']") CAND=$(py "d['rule']['candidate_arm']")
bun eval/runner/compare.ts "$R/scores/$CTRL.json" "$R/scores/$CAND.json" --family $DIR/family.json --rows-path per_question --json > "$R/compare/primary.json"
for pair in $(py "' '.join(c['id'] + ':' + c['a'] + ':' + c['b'] for c in d['descriptive']['comparisons'])"); do
  IFS=: read -r cid ca cb <<< "$pair"
  bun eval/runner/compare.ts "$R/scores/$ca.json" "$R/scores/$cb.json" --family $DIR/family-descriptive.json --rows-path per_question --json > "$R/compare/$cid.json"
done
h1 decide --gate "$R/gate.json" --compare "$R/compare/primary.json" --control-score "$R/scores/$CTRL.json" --candidate-score "$R/scores/$CAND.json" \
  $(for f in "$R"/answers/*.jsonl; do printf -- '--answers\n%s\n' "$f"; done) --out "$R/decision-outcome.json" > /dev/null
bun eval/runner/shootout-cell.ts status --campaign "$CAMPAIGN" --state "$H1_ROOT/state" > "$R/ledger-status.private.json"
mkdir -p "$R/ledger"
h1 budget --status "$R/ledger-status.private.json" --out "$R/ledger/summary.json" > /dev/null
rm -rf "$H1_ROOT/export" "$H1_ROOT/.export-staging"
h1 export --corpus "$R/corpus.json" --runs "$R" $(cells) --export-dir "$H1_ROOT/export" > /dev/null
# The access log goes back to the owner's directory: only lines appended under this decision may differ.
h1 return-log --from "$S/access-log.jsonl" --to "$H1_SEALED_SRC/access-log.jsonl" > /dev/null
log "verdict: $(python3 -c "import json;print(json.load(open('$R/decision-outcome.json'))['verdict'])"); export: $H1_ROOT/export"
