#!/usr/bin/env bash
# The 8k conversion keyless dry run: the development reading (c8k-run.sh dev, on a LongMemEval-S slice) and the whole
# held-out custody chain (c8k-run.sh all) on H1's invented fixture shaped like sealed confirmation v2 (h1-fixture.ts),
# with dummy keys, hash vectors, the reranker off and every lease proxy pointed at the stub proxy (--vary: answers,
# extracted facts and verdicts depend on the prompt and mean nothing). Then the refusal probes and a scan for fixture
# text outside the custody root. No sealed file is read and no provider is called.
#
#   bash eval/runner/budgeted-delivery/c8k-dry-run.sh <out dir outside the repository> <gbrain checkout> [<receipts dir>]
#
# C8K_DRY_DEV_LIMIT sets the development slice (default the decision's 100; 0 skips the development reading).
set -euo pipefail
OUT=$(mkdir -p "$1" && cd "$1" && pwd -P) GB=$(cd "$2" && pwd -P) REC=${3:-}
H=eval/runner/budgeted-delivery
DIR=docs/benchmarks/2026-10-26-gbrain-8k-conversion
ROOT=$OUT/custody OWNER=$OUT/owner
mkdir -p "$ROOT" "$OWNER"
COMMIT=$(git -C "$GB" rev-parse HEAD) VERSION=$(git -C "$GB" show HEAD:VERSION)

# The fixture, and a copy of the committed decision filled as the custodian fills it: the gbrain commit, and the access
# log's recorded state (H1's six recorded lines plus 29 invented lines of H1's decision, the expected 35).
bun $H/h1-fixture.ts --out "$OWNER" --decision $DIR/decision.json > "$OUT/fixture.json"
python3 - "$OWNER" "$COMMIT" "$VERSION" "$DIR/manifests/campaign.json" "$OUT" "$PWD/$DIR/manifests/cells/c8k.json" <<'PY'
import json, sys
owner, commit, version, campaign, out, cells = sys.argv[1:]
d = json.load(open(owner + '/decision.json'))
entries = d['sealed']['access_log_before']['entries']
h1 = [e['decision_id'] for e in entries if e['action'] == 'fill-at-custody'][0]
filled = [e for e in entries if e['action'] != 'fill-at-custody']
filled += [{'action': 'open', 'decision_id': h1}] + [{'action': 'score', 'decision_id': h1}] * (d['sealed']['access_log_before']['lines'] - len(filled) - 1)
d['sealed']['access_log_before'] = {'verified': 'dry run: invented lines', 'lines': len(filled), 'entries': filled}
d['gbrain'].update(commit=commit, version=version)
d['fixture'] = 'Keyless dry-run copy of the committed 8k conversion decision file: sealed.set, manifest, commitments and counts are the fixture\'s; gbrain.commit and the access-log state are filled as the custodian fills them.'
json.dump(d, open(owner + '/decision.json', 'w'), indent=2)
with open(owner + '/access-log.jsonl', 'w') as f:
  for i, e in enumerate(filled):
    f.write(json.dumps({'at': '2026-10-%02dT12:00:00.000Z' % (1 + i % 25), 'action': e['action'], 'purpose': 'invented fixture line', 'decision_id': e['decision_id'], 'labels_sha256': 'fixture', 'run_sha256': None, 'operator': 'fixture', 'host': 'fixture'}) + '\n')
c = json.load(open(campaign))
c.update(campaign_id=c['campaign_id'] + '-dry-run', ledger=out + '/ledger.sqlite', cells_from=[cells])
c['parameters']['gbrain_sha'] = commit
json.dump(c, open(out + '/campaign.json', 'w'), indent=2)
PY

PORT=$((8800 + RANDOM % 900))
bun $H/stub-proxy.ts --port "$PORT" --vary 2> "$OUT/stub.log" & STUB=$!
trap 'kill $STUB 2>/dev/null || true' EXIT
sleep 1
export OPENAI_API_KEY=keyless-dry-run ANTHROPIC_API_KEY=keyless-dry-run VOYAGE_API_KEY=keyless-dry-run
export C8K_KEYLESS=1 SHOOTOUT_KEYLESS_UPSTREAM=http://127.0.0.1:$PORT
export C8K_DECISION=$OWNER/decision.json C8K_CAMPAIGN=$OUT/campaign.json C8K_SEALED_SRC=$OWNER

DEV_LIMIT=${C8K_DRY_DEV_LIMIT:-$(python3 -c "import json;print(json.load(open('$C8K_DECISION'))['development']['limit'])")}
DEV_START=$(date +%s)
if [ "$DEV_LIMIT" != 0 ]; then
  C8K_DEV_LIMIT=$DEV_LIMIT bash $H/c8k-run.sh dev "$ROOT" "$GB" 2> "$OUT/c8k-dev.log" || { tail -30 "$OUT/c8k-dev.log" >&2; exit 1; }
fi
START=$(date +%s)
bash $H/c8k-run.sh all "$ROOT" "$GB" 2> "$OUT/c8k-run.log" || { tail -30 "$OUT/c8k-run.log" >&2; exit 1; }
END=$(date +%s)
curl -s "http://127.0.0.1:$PORT/__proxy/status" > "$OUT/stub-status.json"
export PATH="$ROOT/bun/bin:$PATH"

# ─── Refusal probes: each must refuse, and none may add an access-log line ───
R=$ROOT/runs LOG=$ROOT/sealed/access-log.jsonl
ID=$(python3 -c "import json;print(json.load(open('$C8K_DECISION'))['decision_id'])")
A0=$(python3 -c "import json;print([a['id'] for a in json.load(open('$C8K_DECISION'))['answer_arms'] if a['role'] == 'primary' and a['arm'] == 'A0'][0])")
M=$OWNER/manifest.json
export GBRAIN_EVALS_CUSTODY_LOG=$LOG TMPDIR=$ROOT/tmp
probe() {  # probe <name> <command...>: passes when the command exits non-zero and the access log is unchanged
  local name=$1; shift
  local before; before=$(wc -l < "$LOG")
  if "$@" > "$OUT/probe-$name.log" 2>&1; then echo "{\"probe\":\"$name\",\"refused\":false}"; return; fi
  local after; after=$(wc -l < "$LOG")
  local why; why=$(grep -E '^(error: |\[c8k\] |\[sealed\] |Error: )' "$OUT/probe-$name.log" | head -1 | cut -c1-200 | sed "s#$OUT#<out>#g; s#$PWD#<repo>#g; s#\"#'#g")
  echo "{\"probe\":\"$name\",\"refused\":true,\"access_log_lines_added\":$((after - before)),\"message\":\"$why\"}"
}
c8k() { bun $H/c8k.ts "$1" --custody-root "$ROOT" "${@:2}"; }
chmod 400 "$ROOT/sealed/labels.json"
mkdir -p "$ROOT/probe"
python3 - "$C8K_DECISION" "$ROOT/probe/decision-other-commit.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); d['gbrain']['commit'] = '0' * 40
json.dump(d, open(sys.argv[2], 'w'), indent=2)
PY
{
  probe score-report-outside-root bun eval/runner/sealed-confirmation.ts score --manifest "$M" --questions "$ROOT/sealed/questions.json" --labels "$ROOT/sealed/labels.json" \
    --run "$R/answers/$A0.jsonl" --judge --cap-usd 1 --custody-root "$ROOT" --purpose probe --decision-id "$ID" --out "$OUT/score-outside.json"
  probe score-spend-outside-root bun eval/runner/sealed-confirmation.ts score --manifest "$M" --questions "$ROOT/sealed/questions.json" --labels "$ROOT/sealed/labels.json" \
    --run "$R/answers/$A0.jsonl" --judge --cap-usd 1 --custody-root "$ROOT" --purpose probe --decision-id "$ID" --out "$R/probe-score.json" --spend "$OUT/spend.jsonl"
  probe score-inside-repository bun eval/runner/sealed-confirmation.ts score --manifest "$M" --questions "$ROOT/sealed/questions.json" --labels "$ROOT/sealed/labels.json" \
    --run "$R/answers/$A0.jsonl" --judge --cap-usd 1 --custody-root "$PWD/eval/reports" --purpose probe --decision-id "$ID" --out "$PWD/eval/reports/probe.json"
  probe gate-after-label-read c8k gate --decision "$C8K_DECISION" --phase final --corpus "$R/corpus.json" --evidence-dir "$R/evidence" --readers-dir "$R/readers" \
    --gbrain "$GB@$COMMIT" --keyless --out "$R/probe-gate.json"
  probe freeze-unfilled-decision c8k freeze --decision $DIR/decision.json --corpus "$R/corpus.json" --brains "$R/brains" --evidence-dir "$ROOT/probe/evidence" --gbrain "$GB@$COMMIT" --keyless
  probe freeze-other-gbrain-commit c8k freeze --decision "$ROOT/probe/decision-other-commit.json" --corpus "$R/corpus.json" --brains "$R/brains" --evidence-dir "$ROOT/probe/evidence" --gbrain "$GB@$COMMIT" --keyless
  probe read-outside-root c8k read --decision "$C8K_DECISION" --corpus "$R/corpus.json" --evidence-dir "$R/evidence" --readers-dir "$OUT/readers-outside" --reader sonnet-5-5
  probe export-outside-root c8k export --decision "$C8K_DECISION" --corpus "$R/corpus.json" --runs "$R" --export-dir "$OUT/export-outside"
  cp "$LOG" "$ROOT/probe/log-foreign.jsonl" && echo '{"action":"score","decision_id":"another-decision"}' >> "$ROOT/probe/log-foreign.jsonl"
  probe custody-check-foreign-log-line c8k custody-check --decision "$C8K_DECISION" --manifest "$M" --questions "$ROOT/sealed/questions.json" \
    --labels "$ROOT/sealed/labels.json" --access-log "$ROOT/probe/log-foreign.jsonl"
  cp "$ROOT/sealed/questions.json" "$ROOT/probe/questions.json" && printf ' ' >> "$ROOT/probe/questions.json"
  probe corpus-tampered-questions c8k corpus --decision "$C8K_DECISION" --manifest "$M" --questions "$ROOT/probe/questions.json" --purpose probe --corpus-out "$ROOT/probe/corpus.json"
  cp "$OWNER/access-log.jsonl" "$OUT/owner-log-copy.jsonl"
  probe return-log-foreign-line c8k return-log --decision "$C8K_DECISION" --from "$ROOT/probe/log-foreign.jsonl" --to "$OUT/owner-log-copy.jsonl"
} > "$OUT/probes.ndjson"
chmod 000 "$ROOT/sealed/labels.json"

# ─── Fixture text outside the custody root and the owner's directory ───
MARK=$(python3 -c "import json;q=json.load(open('$OWNER/questions.json'));print(q['haystacks'][0]['sessions'][0]['turns'][0]['content'][:60])")
QID=$(python3 -c "import json;q=json.load(open('$OWNER/questions.json'));print(q['questions'][0]['question_id'])")
LEAKS=$( { grep -rlF -e "$MARK" -e "$QID" "$PWD" "$HOME/.cache" "$HOME/.gbrain" /tmp "$OUT" 2>/dev/null || true; } | grep -v -e "^$ROOT/" -e "^$OWNER/" -e "^$OUT/probe-" -e "^$OUT/owner-log-copy.jsonl$" | sed "s#$OUT#<out>#; s#$PWD#<repo>#; s#$HOME#~#" || true)

python3 - "$OUT" "$ROOT" "$DEV_START" "$START" "$END" "$LEAKS" "$COMMIT" "$DEV_LIMIT" <<'PY'
import json, sys, os
out, root, dev_start, start, end, leaks, commit, dev_limit = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5]), sys.argv[6], sys.argv[7], int(sys.argv[8])
R = root + '/runs'
probes = [json.loads(l) for l in open(out + '/probes.ndjson') if l.strip()]
outcome = json.load(open(R + '/decision-outcome.json'))
gate_r, gate_f = json.load(open(R + '/gate-retrieval.json')), json.load(open(R + '/gate.json'))
log = [json.loads(l) for l in open(root + '/sealed/access-log.jsonl') if l.strip()]
d_id = outcome['decision_id']
mine = [(i, e['action']) for i, e in enumerate(log) if e.get('decision_id') == d_id]
summary = {
  'kind': 'c8k-dry-run',
  'note': 'Keyless: an invented fixture (h1-fixture.ts), dummy keys, hash vectors and the reranker off, every lease proxy pointed at stub-proxy.ts --vary (stub facts are the first-person sentences of each turn). Answers, facts, verdicts, the decision outcome and every dollar figure are meaningless: the dollars are the stub usage (prompt characters / 4 in, 2 tokens out) priced at list prices by the lease proxies; nothing was paid.',
  'bun': os.popen('bun --version').read().strip(), 'gbrain_commit': commit,
  'fixture': json.load(open(out + '/fixture.json')),
  'development_slice': dev_limit, 'development_wall_seconds': start - dev_start if dev_limit else None,
  'chain_wall_seconds': end - start, 'labels_mode_after_run': oct(os.stat(root + '/sealed/labels.json').st_mode & 0o777),
  'stub': json.load(open(out + '/stub-status.json')),
  'gates': {'retrieval': {'pass': gate_r['pass'], 'problems': gate_r['problems']}, 'final': {'pass': gate_f['pass'], 'problems': gate_f['problems']}},
  'access_log': {'lines_before': json.load(open(R + '/custody-check.json'))['access_log']['before'], 'this_decision': [a for _, a in mine],
    'label_reads': sum(1 for _, a in mine if a == 'score'), 'label_reads_after_final_gate': all(i >= gate_f['access_log_lines_at_gate'] for i, a in mine if a == 'score'),
    'decide_label_reads': outcome['label_reads']},
  'outcome_meaningless': {'recommended_prefix': outcome['recommended_prefix'], 'recommended_standalone': outcome['recommended_standalone'], 'recommendations': outcome['recommendations'], 'verdicts': {c['id']: c['label'] for c in outcome['comparisons']}, 'problems': outcome['problems']},
  'probes': probes, 'all_probes_refused_without_a_label_read': all(p['refused'] and p['access_log_lines_added'] == 0 for p in probes),
  'fixture_text_outside_custody': [l for l in leaks.split('\n') if l.strip()],
}
json.dump(summary, open(out + '/dry-run-summary.json', 'w'), indent=2)
print(json.dumps({k: summary[k] for k in ('chain_wall_seconds', 'development_wall_seconds', 'gates', 'access_log', 'all_probes_refused_without_a_label_read', 'fixture_text_outside_custody', 'stub')}, indent=2))
PY
if [ -n "$REC" ]; then
  mkdir -p "$REC"
  rm -rf "$REC/export" && cp -r "$ROOT/export" "$REC/export"
  cp "$OUT/dry-run-summary.json" "$REC/"
  if [ "$DEV_LIMIT" != 0 ]; then
    rm -rf "$REC/dev" && mkdir -p "$REC/dev"
    for f in corpus-summary.json import.json extract.json freeze.json gate-retrieval.json gate.json answers-summary.json dev-summary.json ledger-summary.json; do cp "$ROOT/dev/$f" "$REC/dev/"; done
  fi
fi
