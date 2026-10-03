#!/usr/bin/env bash
# Cat 41 after-pass for the agent-first operator wave, plus the Cat 40 F1/F10 check.
#
#   eval/runner/cat41/after-pass.sh <gbrain checkout> <candidate commit> [cat41 budget USD] [cat40 budget USD]
#
# Runs from the gbrain-evals repository root. Needs Docker, ANTHROPIC_API_KEY and
# OPENAI_API_KEY, and the candidate commit pushed to GitHub (the docs tasks read
# raw.githubusercontent.com/garrytan/gbrain/<commit>/, the fresh install runs
# `bun install -g github:garrytan/gbrain#<commit>`). Spend observed for the
# baseline: about $16 (Cat 41) and $32 (Cat 40).
set -euo pipefail
GBRAIN="${1:?gbrain checkout path}"
SHA="$(git -C "$GBRAIN" rev-parse "${2:?candidate commit}")"
CAT41_USD="${3:-40}"
CAT40_USD="${4:-45}"
SHORT="${SHA:0:7}"
BASE=eval/reports/cat41/baseline-master-566a242
AFTER="eval/reports/cat41/after-$SHORT"
PUB=docs/benchmarks/2026-10-03-agent-operator

docker image inspect gbrain-evals-cat41:v1 >/dev/null 2>&1 || docker build -t gbrain-evals-cat41:v1 eval/runner/cat41

# Restore the published baseline when this clone has no local copy.
if [ ! -d "$BASE/runs" ]; then
  mkdir -p "$BASE"
  tar xzf "$PUB/baseline-master-566a242/runs.tar.gz" -C "$BASE"
  cp "$PUB/baseline-master-566a242/"{meta.json,overhead.json} "$BASE/"
fi

RID="$(bun eval/runner/budget-ledger.ts open --runner cat41-agent-operator --budget-usd "$CAT41_USD" | tail -1)"
bun eval/runner/cat41-agent-operator.ts run --gbrain "$GBRAIN@$SHA" --label "after-$SHORT" --repeat 3 --concurrency 4 \
  --paid --budget-run-id "$RID" --out "$AFTER"
bun eval/runner/budget-ledger.ts close --budget-run-id "$RID"
bun eval/runner/cat41-agent-operator.ts overhead --gbrain "$GBRAIN@$SHA" --out "$AFTER"
bun eval/runner/cat41-agent-operator.ts gate --before "$BASE" --after "$AFTER" --out "$AFTER/gate.json" || GATE_FAILED=1

bun eval/runner/cat40-model-ladder.ts --models gpt-5.4-mini,gpt-5.4,claude-sonnet-4-6 --arms gbrain \
  --gbrain-label "gbrain-aow-$SHORT" --max-tool-chars 100000000 --transcripts --slots 5 \
  --gbrain-repo "$GBRAIN" --gbrain-ref "$SHA" --repeat 2 --budget-usd "$CAT40_USD" --concurrency 6 --judge none \
  --out "eval/reports/cat40/aow-f1f10-after-$SHORT"
bun eval/runner/cat40/analyze.ts "$PUB/f1f10-cat40-baseline-master/results.jsonl" "eval/reports/cat40/aow-f1f10-after-$SHORT/results.jsonl" \
  --md "eval/reports/cat40/aow-f1f10-after-$SHORT/analysis-before-after.md"

echo "Cat 41 gate: $AFTER/gate.json (exit ${GATE_FAILED:-0}); Cat 40: eval/reports/cat40/aow-f1f10-after-$SHORT/analysis-before-after.md"
exit "${GATE_FAILED:-0}"
