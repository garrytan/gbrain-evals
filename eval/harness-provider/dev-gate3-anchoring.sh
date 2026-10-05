#!/usr/bin/env bash
# Gate 3: gbrain `search.entity_anchoring` on against off, raw lane, 8k target, gemini-3.8-flash.
# Per slice: the off arm runs in full; the on arm first runs a retrieval-only probe (no answer or judge calls)
# that records which questions anchoring changed; the on arm runs in full only when the probe saw it fire.
# Both arms share one store (search_config is read-time). Env: G3 (gbrain build path@sha), LEDGER.
set -uo pipefail
# Gate 3 runs on the build that fixes the persistence stall, repeated slugs and the image arm (#6066 head).
G3="$HOME/.capy/work/mpw/gbrain@b0e70f498"
L="--budget-ledger ${LEDGER:-.budget/mpw-dev-local.sqlite}"
D="bun eval/runner/harness-dev.ts sweep --provider gbrain"
EMB='"embedding_model":"voyage:voyage-4","embedding_dimensions":1024'
arm() { echo "{$EMB,\"search_config\":{\"search.entity_anchoring\":\"$1\"}}"; }
fired() {  # track -> number of anchored questions in the newest tuning file of its ingest cell
  python3 - "eval/reports/harness-dev/$1.jsonl" <<'PY'
import glob, json, os, sys
rows = [json.loads(l) for l in open(sys.argv[1])] if os.path.exists(sys.argv[1]) else []
tune = [r for r in rows if r.get("step") == "tune"]
if not tune or tune[-1].get("code") not in (0, 4):
    print(-1); sys.exit()
cell = [r for r in rows if r.get("step") == "ingest"][-1]["cell"]
files = sorted(glob.glob(f"eval/reports/harness-cells/{cell}/tuning/auto-*.json"))
rows = json.load(open(files[-1]))["targets"]["8000"]["rows"] if files else []
print(len(rows[-1].get("entity_anchored", [])) if rows else 0)
PY
}
slice() {  # name dataset split selector...
  local name=$1 ds=$2 sp=$3; shift 3
  $D --dataset "$ds" --split "$sp" "$@" --base '{"token_budget":8100}' --extra "$(arm false)" --targets 8000 --no-default --sample 40 --name "gate3-$name-off" -- --gbrain "$G3" $L
  $D --dataset "$ds" --split "$sp" "$@" --base '{"token_budget":8100}' --extra "$(arm true)" --targets 8000 --no-default --sample 1000 --probe --name "gate3-$name-on-probe" -- --gbrain "$G3" $L
  n=$(fired "gate3-$name-on-probe")
  [ "$n" -lt 0 ] && { echo "[gate3] $name: the probe did not run; skipping the on arm"; return; }
  echo "[gate3] $name: anchoring fired on $n questions in the probe"
  [ "$n" -gt 0 ] && $D --dataset "$ds" --split "$sp" "$@" --base '{"token_budget":8100}' --extra "$(arm true)" --targets 8000 --no-default --sample 40 --name "gate3-$name-on" -- --gbrain "$G3" $L
}
slice lme-ku-temporal longmemeval s --question-ids-file eval/reports/harness-dev/longmemeval_s_ku_temporal.ids.json
slice personamem-32k personamem 32k --question-ids-file eval/reports/harness-dev/personamem_32k_dev.ids.json
slice beam-100k beam 100k --units 3,11,12,15
slice beam-500k beam 500k --units 8,9,12,21,28,31,35
slice beam-1m beam 1m --units 1,6,16,21,22,25,26
echo "[gate3] done"
