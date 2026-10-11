#!/usr/bin/env bash
# The budgeted delivery H1 keyless dry run: the whole custody chain (h1-run.sh all) on an invented fixture shaped like
# sealed confirmation v2 (h1-fixture.ts), with dummy keys, hash vectors, the reranker off and every lease proxy
# pointed at the stub proxy (--vary: answers and verdicts depend on the prompt and mean nothing). Then the refusal
# probes, a scan for fixture text outside the custody root, and evidence parity between E2's gbrain commit and the
# pin. No sealed file is read and no provider is called.
#
#   bash eval/runner/budgeted-delivery/h1-dry-run.sh <out dir outside the repository> <gbrain checkout> [<receipts dir>]
set -euo pipefail
OUT=$(mkdir -p "$1" && cd "$1" && pwd -P) GB=$(cd "$2" && pwd -P) REC=${3:-}
H=eval/runner/budgeted-delivery
DIR=docs/benchmarks/2026-10-10-gbrain-budgeted-delivery-h1
ROOT=$OUT/custody OWNER=$OUT/owner
E2_COMMIT=ca2c447bd39b31beb142247de424c096eefc8525
mkdir -p "$ROOT" "$OWNER"

bun $H/h1-fixture.ts --out "$OWNER" > "$OUT/fixture.json"
python3 - "$DIR/manifests/campaign.json" "$OUT" "$PWD/$DIR/manifests/cells/h1.json" <<'PY'
import json, sys
c = json.load(open(sys.argv[1]))
c.update(campaign_id=c['campaign_id'] + '-dry-run', ledger=sys.argv[2] + '/ledger.sqlite', cells_from=[sys.argv[3]])
json.dump(c, open(sys.argv[2] + '/campaign.json', 'w'), indent=2)
PY

PORT=$((8800 + RANDOM % 900))
bun $H/stub-proxy.ts --port "$PORT" --vary 2> "$OUT/stub.log" & STUB=$!
trap 'kill $STUB 2>/dev/null || true' EXIT
sleep 1
export OPENAI_API_KEY=keyless-dry-run ANTHROPIC_API_KEY=keyless-dry-run VOYAGE_API_KEY=keyless-dry-run
export H1_KEYLESS=1 SHOOTOUT_KEYLESS_UPSTREAM=http://127.0.0.1:$PORT H1_SHARDS=${H1_SHARDS:-2}
export H1_DECISION=$OWNER/decision.json H1_CAMPAIGN=$OUT/campaign.json H1_SEALED_SRC=$OWNER

START=$(date +%s)
bash $H/h1-run.sh all "$ROOT" "$GB" 2> "$OUT/h1-run.log" || { tail -30 "$OUT/h1-run.log" >&2; exit 1; }
END=$(date +%s)
export PATH="$ROOT/bun/bin:$PATH"

# ─── Refusal probes: each must refuse, and none may add an access-log line ───
R=$ROOT/runs LOG=$ROOT/sealed/access-log.jsonl
ID=$(python3 -c "import json;print(json.load(open('$H1_DECISION'))['decision_id'])")
M=$OWNER/manifest.json
export GBRAIN_EVALS_CUSTODY_LOG=$LOG TMPDIR=$ROOT/tmp
probe() {  # probe <name> <command...>: passes when the command exits non-zero and the access log is unchanged
  local name=$1; shift
  local before; before=$(wc -l < "$LOG")
  if "$@" > "$OUT/probe-$name.log" 2>&1; then echo "{\"probe\":\"$name\",\"refused\":false}"; return; fi
  local after; after=$(wc -l < "$LOG")
  local why; why=$(grep -E '^(error: |\[h1\] |\[sealed\] |Error: )' "$OUT/probe-$name.log" | head -1 | cut -c1-200 | sed "s#$OUT#<out>#g; s#\"#'#g")
  echo "{\"probe\":\"$name\",\"refused\":true,\"access_log_lines_added\":$((after - before)),\"message\":\"$why\"}"
}
chmod 400 "$ROOT/sealed/labels.json"
CTRL=$(python3 -c "import json;print(json.load(open('$H1_DECISION'))['rule']['control_arm'])")
{
  probe score-report-outside-root bun eval/runner/sealed-confirmation.ts score --manifest "$M" --questions "$ROOT/sealed/questions.json" --labels "$ROOT/sealed/labels.json" \
    --run "$R/answers/$CTRL.jsonl" --judge --cap-usd 1 --custody-root "$ROOT" --purpose probe --decision-id "$ID" --out "$OUT/score-outside.json"
  probe score-spend-outside-root bun eval/runner/sealed-confirmation.ts score --manifest "$M" --questions "$ROOT/sealed/questions.json" --labels "$ROOT/sealed/labels.json" \
    --run "$R/answers/$CTRL.jsonl" --judge --cap-usd 1 --custody-root "$ROOT" --purpose probe --decision-id "$ID" --out "$R/probe-score.json" --spend "$OUT/spend.jsonl"
  probe score-inside-repository bun eval/runner/sealed-confirmation.ts score --manifest "$M" --questions "$ROOT/sealed/questions.json" --labels "$ROOT/sealed/labels.json" \
    --run "$R/answers/$CTRL.jsonl" --judge --cap-usd 1 --custody-root "$PWD/eval/reports" --purpose probe --decision-id "$ID" --out "$PWD/eval/reports/probe.json"
  probe memory-qa-output-outside-root bun eval/runner/memory-qa/run.ts --benchmark custody --corpus-file "$R/corpus.json" --split sealed --decision-id "$ID" --purpose probe \
    --sealed-profile "$ROOT" --system gbrain-query --embed hash --gbrain "$GB@$(python3 -c "import json;print(json.load(open('$H1_DECISION'))['gbrain']['commit'])")" \
    --arms $DIR/manifests/arms/retrieval-only.json --policy-setting variants=e2 --policy-setting stage=freeze --output "$OUT/mqa-outside"
  probe gate-after-label-read bun $H/h1.ts gate --phase final --custody-root "$ROOT" --decision "$H1_DECISION" --corpus "$R/corpus.json" \
    $(for c in "$R"/memory-qa/deliver/shard-*/; do printf -- '--cell %s ' "${c%/}"; done) --out "$R/probe-gate.json"
  probe export-outside-root bun $H/h1.ts export --custody-root "$ROOT" --decision "$H1_DECISION" --corpus "$R/corpus.json" --runs "$R" --export-dir "$OUT/export-outside"
  mkdir -p "$ROOT/probe" && cp "$LOG" "$ROOT/probe/log-foreign.jsonl" && echo '{"action":"score","decision_id":"another-decision"}' >> "$ROOT/probe/log-foreign.jsonl"
  probe custody-check-foreign-log-line bun $H/h1.ts custody-check --custody-root "$ROOT" --decision "$H1_DECISION" --manifest "$M" --questions "$ROOT/sealed/questions.json" \
    --labels "$ROOT/sealed/labels.json" --access-log "$ROOT/probe/log-foreign.jsonl"
  cp "$ROOT/sealed/questions.json" "$ROOT/probe/questions.json" && printf ' ' >> "$ROOT/probe/questions.json"
  probe corpus-tampered-questions bun $H/h1.ts corpus --custody-root "$ROOT" --decision "$H1_DECISION" --manifest "$M" --questions "$ROOT/probe/questions.json" \
    --purpose probe --corpus-out "$ROOT/probe/corpus.json"
  cp "$OWNER/access-log.jsonl" "$OUT/owner-log-copy.jsonl"
  probe return-log-foreign-line bun $H/h1.ts return-log --custody-root "$ROOT" --decision "$H1_DECISION" --from "$ROOT/probe/log-foreign.jsonl" --to "$OUT/owner-log-copy.jsonl"
} > "$OUT/probes.ndjson"
chmod 000 "$ROOT/sealed/labels.json"

# ─── Fixture text outside the custody root and the owner's directory ───
MARK=$(python3 -c "import json;q=json.load(open('$OWNER/questions.json'));print(q['haystacks'][0]['sessions'][0]['turns'][0]['content'][:60])")
QID=$(python3 -c "import json;q=json.load(open('$OWNER/questions.json'));print(q['questions'][0]['question_id'])")
LEAKS=$( { grep -rlF -e "$MARK" -e "$QID" "$PWD" "$HOME/.cache" "$HOME/.gbrain" /tmp "$OUT" 2>/dev/null || true; } | grep -v -e "^$ROOT/" -e "^$OWNER/" -e "^$OUT/probe-" -e "^$OUT/owner-log-copy.jsonl$" | sed "s#$OUT#<out>#; s#$PWD#<repo>#; s#$HOME#~#" || true)

# ─── Evidence parity: freeze and deliver the fixture at E2's commit and at the pin ───
COMMIT=$(python3 -c "import json;print(json.load(open('$H1_DECISION'))['gbrain']['commit'])")
P=$ROOT/parity
for sha in "$COMMIT" "$E2_COMMIT"; do
  C=(--benchmark custody --corpus-file "$R/corpus.json" --split sealed --decision-id "$ID" --sealed-profile "$ROOT" --system gbrain-query --embed hash
    --embedding-model openai:text-embedding-3-large --embedding-dims 1536 --config search.reranker.enabled=false --gbrain "$GB@$sha" --policy-setting variants=e2
    --provider-proxy "http://127.0.0.1:$PORT" --arms $DIR/manifests/arms/retrieval-only.json)
  GBRAIN_EVALS_CUSTODY_LOG=$ROOT/parity-access-log.jsonl bash $H/e2-parallel.sh 1 "$P/${sha:0:9}/freeze" -- "${C[@]}" --purpose "dry-run parity freeze" --policy-setting stage=freeze
  cat "$P/${sha:0:9}"/freeze/shard-*/retrievals/rows.ndjson > "$P/${sha:0:9}/frozen.ndjson"
  GBRAIN_EVALS_CUSTODY_LOG=$ROOT/parity-access-log.jsonl bash $H/e2-parallel.sh 1 "$P/${sha:0:9}/deliver" -- "${C[@]}" --purpose "dry-run parity deliver" \
    --policy-setting stage=deliver --policy-setting deliver_set=h1 --policy-setting b_pseudo=5500 --frozen-from "$P/${COMMIT:0:9}/frozen.ndjson"
done 2> "$OUT/parity.log"
bun $H/h1.ts parity --custody-root "$ROOT" --decision "$H1_DECISION" --a "$P/${E2_COMMIT:0:9}" --b "$P/${COMMIT:0:9}" --out "$R/parity.json" > /dev/null

H1_COMMIT=$COMMIT E2_COMMIT=$E2_COMMIT python3 - "$OUT" "$ROOT" "$START" "$END" "$LEAKS" <<'PY'
import json, sys, os
out, root, start, end, leaks = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), sys.argv[5]
probes = [json.loads(l) for l in open(out + '/probes.ndjson') if l.strip()]
labels_mode = oct(os.stat(root + '/sealed/labels.json').st_mode & 0o777)
summary = {
  'kind': 'budgeted-delivery-h1-dry-run',
  'note': 'Keyless: an invented fixture (h1-fixture.ts), dummy keys, hash vectors and the reranker off in the freeze, every lease proxy pointed at stub-proxy.ts --vary. Answers, verdicts, the decision outcome and every dollar figure in export/ledger/summary.json are meaningless: the dollars are the stub usage (prompt characters / 4 in, 2 tokens out) priced at list prices by the lease proxies; nothing was paid.',
  'bun': os.popen('bun --version').read().strip(), 'gbrain_commits': {'chain': os.environ.get('H1_COMMIT', ''), 'parity': sorted([os.environ.get('H1_COMMIT', ''), os.environ.get('E2_COMMIT', '')])},
  'fixture': json.load(open(out + '/fixture.json')),
  'chain_wall_seconds': end - start, 'labels_mode_after_run': labels_mode,
  'probes': probes, 'all_probes_refused_without_a_label_read': all(p['refused'] and p['access_log_lines_added'] == 0 for p in probes),
  'fixture_text_outside_custody': [l for l in leaks.split('\n') if l.strip()],
  'parity': json.load(open(root + '/runs/parity.json')),
}
json.dump(summary, open(out + '/dry-run-summary.json', 'w'), indent=2)
print(json.dumps({k: summary[k] for k in ('chain_wall_seconds', 'labels_mode_after_run', 'all_probes_refused_without_a_label_read', 'fixture_text_outside_custody')}, indent=2))
PY
if [ -n "$REC" ]; then
  mkdir -p "$REC"
  rm -rf "$REC/export" && cp -r "$ROOT/export" "$REC/export"
  cp "$OUT/dry-run-summary.json" "$REC/"
fi
