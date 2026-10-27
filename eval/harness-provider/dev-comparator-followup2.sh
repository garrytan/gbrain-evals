#!/usr/bin/env bash
# Second follow-up: BEAM 100k and 500k combined targets whose tuning ran before the 95th-percentile steering
# landed and so found no in-gate setting. Reruns only the skipped targets (the shared store is reused).
set -uo pipefail
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
L="--budget-ledger ${LEDGER:-.budget/mpw-dev-vm.sqlite}"
D="bun eval/runner/harness-dev.ts sweep --provider comparator"
COMBINED='{"max_tokens":3500,"max_chunk_tokens":2000}'
waitfor() { while pgrep -f -- "$1" >/dev/null; do sleep 60; done; }
skipped() { python3 - "$1" <<'PY'
import json, sys
done, skip = set(), set()
for line in open(sys.argv[1]):
    r = json.loads(line)
    if r.get("step") == "run" and r.get("target"):
        (skip if r.get("skipped") else done).add(r["target"])
print(",".join(str(t) for t in sorted(skip - done)))
PY
}
rerun() {  # split units
  waitfor "--split $1"
  T=$(skipped "eval/reports/harness-dev/comparator-beam-$1-rag-combined.jsonl")
  [ -n "$T" ] && $D --dataset beam --split "$1" --units "$2" --lane combined --base "$COMBINED" --targets "$T" --no-default --sample 60 --name "comparator-beam-$1-rag-combined" -- $L
}
( rerun 100k 3,11,12,15 ) > eval/reports/harness-dev/track-beam-100k-rerun.log 2>&1 &
( rerun 500k 8,9,12,21,28,31,35 ) > eval/reports/harness-dev/track-beam-500k-rerun.log 2>&1 &
wait
