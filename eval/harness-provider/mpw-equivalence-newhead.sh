#!/usr/bin/env bash
# Memory proof wave #6066 equivalence check, new-head phase. Runs ON the size's VM (mpw-equivalence-vm.sh <size>
# newhead), after the baseline phase left both lanes' d7467d1cf cells and stores in ~/eq.
#
# Per lane, in ~/eq/nh/<lane>:
#   p0-1, p0-2  the baseline cell replayed on d7467d1cf against its own store, with the probe: the noise floor
#   r2a         the same replay on the new head against the baseline store (retrieval changes alone)
#   r2b         as r2a, on a copy of the baseline store after the new head's `gbrain extract --stale` (#6343)
#   ingest      the lane re-ingested on the new head (an ingest-only cell); a watchdog stops both lanes' ingests
#               once their spend passes 1.25x the baseline ingest spend, and the phase reports it
#   r3          the baseline cell replayed on the new head against the new-head store (end to end)
#   census-*    store-census.ts on the baseline store (d7467d1cf), the r2a and r2b store copies and the new-head store
#   answer-*    questions whose delivered context changed in r2a or r3 answered again from the replayed context
#               (reanswer), then judged jointly with the baseline answers to the same questions (rejudge)
set -uo pipefail
split=${1:?size}
BASE=d7467d1cf; NEW=${NEW_SHA:?NEW_SHA}
set -a; . ~/.mpw-keys; set +a
export PATH=$HOME/.bun/bin:$HOME/.local/bin:$PATH
cd ~/work/gbrain-evals
L="--budget-ledger $HOME/eq/ledger.sqlite"
GB="--gbrain $HOME/work/gbrain@$BASE"; GN="--gbrain $HOME/work/gbrain@${NEW:0:9}"
OV=$HOME/work/gbrain-evals/.gbrain-overlays

ledger() { bun eval/runner/budget-ledger.ts status $L | python3 -c "import json,sys; t=json.load(sys.stdin)['totals']; print(t['$1'])"; }
replay() {  # <cell> <store> <out> <gbrain flag...>
  [ -f "$3/replay-diff.json" ] && return 0
  rm -rf "$3"; bun run harness:cell replay "$1" --store "$2" --out "$3" "${@:4}" --probe --budget-usd 1 --cells-dir ~/eq/cells $L
}
changed() { python3 -c "import json; d=json.load(open('$1/replay-diff.json'))['questions']; json.dump(sorted(q for q, v in d.items() if v == 'changed'), open('$2', 'w'))"; }

lane() {
  l=$1; cid=$(cat ~/eq/$l.cell); store=$(cat ~/eq/$l.store); N=~/eq/nh/$l; mkdir -p $N
  replay $cid $store $N/p0-1 $GB && replay $cid $store $N/p0-2 $GB && replay $cid $store $N/r2a $GN || return 1
  if [ ! -f $N/r2b/replay-diff.json ]; then
    rm -rf $N/linked-store && cp -r $store $N/linked-store
    for home in $N/linked-store/gbrain/units/*/; do
      python3 - "$home" <<'PY'
import json, sys, pathlib
home = pathlib.Path(sys.argv[1]); cfg = home / ".gbrain" / "config.json"
c = json.loads(cfg.read_text()); c["database_path"] = str(home / ".gbrain" / "brain.pglite"); c["self_upgrade"] = {**c.get("self_upgrade", {}), "mode": "off"}; cfg.write_text(json.dumps(c, indent=2))
PY
      (cd $home && mkdir -p home tmp && env -i PATH=$PATH HOME=${home}home GBRAIN_HOME=${home%/} TMPDIR=${home}tmp GBRAIN_NO_AUTOPILOT_INSTALL=1 GBRAIN_NO_BANNER=1 GBRAIN_NO_ONBOARD_NUDGE=1 GBRAIN_NO_SKILL_NAG=1 GBRAIN_NO_PROBE_PROMPT=1 GBRAIN_INIT_SKIP_EMBED_CHECK=1 NO_COLOR=1 bun $OV/${NEW:0:9}/src/cli.ts extract --stale --json) >> $N/extract-stale.log 2>&1 \
        || { echo "extract --stale failed in $home" >> $N/extract-stale.log; return 1; }
    done
    replay $cid $N/linked-store $N/r2b $GN || return 1
  fi
  echo $(ledger committed_usd) > $N/committed-before-ingest
}

lane combined > ~/eq/nh-combined.log 2>&1 & a=$!
lane raw > ~/eq/nh-raw.log 2>&1 & b=$!
wait $a; ra=$?; wait $b; rb=$?
[ $ra = 0 ] && [ $rb = 0 ] || { echo "$ra $rb replay" > ~/eq/nh.exit; exit 1; }

# Ingest guard: the baseline ingest spend is both lanes' store-writing gbrain traffic (extraction chat and document
# embeddings) outside replays. A watchdog stops both new-head ingests if their spend passes 1.25x of it.
spent_since() { python3 -c "
import sqlite3; c = sqlite3.connect('$HOME/eq/ledger.sqlite')
print(c.execute(\"SELECT COALESCE(SUM(COALESCE(actual_usd, reserved_usd)), 0) FROM entries WHERE description LIKE '%/gbrain)%' AND description NOT LIKE '%rerank%' AND created_at >= ?\", ('$1',)).fetchone()[0])"; }
base_ingest=$(python3 -c "
import sqlite3; c = sqlite3.connect('$HOME/eq/ledger.sqlite')
print(c.execute(\"SELECT COALESCE(SUM(actual_usd), 0) FROM entries WHERE description LIKE '%/gbrain)%' AND description NOT LIKE '%rerank%' AND run_id NOT LIKE 'harness-replay%'\").fetchone()[0])")
limit=$(python3 -c "print(round(1.25 * $base_ingest, 4))")
headroom=$(python3 -c "import json; print(sum(json.load(open(f'eval/harness-provider/cells/equivalence/beam-$split-gbrain-{l}.json'))['budget_usd'] for l in ('combined', 'raw')) + 1)")
bun eval/runner/budget-ledger.ts set-cap $L --program-cap-usd $(python3 -c "print(round($(ledger committed_usd) + $headroom, 2))") \
  --reason "mpw #6066 equivalence beam $split: new-head ingest (watchdog stops it at 1.25x baseline ingest spend)" >/dev/null
start=$(date -u +%Y-%m-%dT%H:%M:%S)
ingest() {
  l=$1; spec=eval/harness-provider/cells/equivalence/beam-$split-gbrain-$l.json; N=~/eq/nh/$l
  bun run harness:cell ingest $spec --cells-dir ~/eq/cells $GN $L > $N/ingest.log 2>&1 || return 1
  grep -oP '\[cell\] store \K\S+' $N/ingest.log | tail -1 > $N/new.store
}
ingest combined & a=$!; ingest raw & b=$!
stopped=false
while kill -0 $a 2>/dev/null || kill -0 $b 2>/dev/null; do
  sleep 20
  if python3 -c "import sys; sys.exit(0 if $(spent_since $start) > $limit else 1)"; then
    stopped=true; pkill -TERM -P $a; pkill -TERM -P $b; kill $a $b 2>/dev/null; break
  fi
done
wait $a; ia=$?; wait $b; ib=$?
echo "{\"baseline_ingest_usd\": $base_ingest, \"limit_usd\": $limit, \"new_head_ingest_usd\": $(spent_since $start), \"stopped\": $stopped}" > ~/eq/nh/ingest-guard.json
bun eval/runner/budget-ledger.ts status $L > ~/eq/nh/ledger-after-ingest.json
$stopped && { echo "ingest-guard" > ~/eq/nh.exit; exit 1; }
[ $ia = 0 ] && [ $ib = 0 ] || { echo "$ia $ib ingest" > ~/eq/nh.exit; exit 1; }
bun eval/runner/budget-ledger.ts set-cap $L --program-cap-usd $(python3 -c "print(round($(ledger committed_usd) + ${ANSWER_ALLOWANCE_USD:-12}, 2))") \
  --reason "mpw #6066 equivalence beam $split: end-to-end replays and changed-question answers (reservation headroom)" >/dev/null

finish() {
  l=$1; cid=$(cat ~/eq/$l.cell); N=~/eq/nh/$l
  replay $cid ~/eq/cells/_stores/$(cat $N/new.store) $N/r3 $GN || return 1
  bun eval/harness-provider/mpw_tools/store-census.ts --gbrain $OV/$BASE --store $(cat ~/eq/$l.store) --out $N/census-base.json --probe-log $N/p0-1/probe.jsonl
  bun eval/harness-provider/mpw_tools/store-census.ts --gbrain $OV/${NEW:0:9} --store $N/r2a/store --out $N/census-r2a.json --probe-log $N/r2a/probe.jsonl
  bun eval/harness-provider/mpw_tools/store-census.ts --gbrain $OV/${NEW:0:9} --store $N/r2b/store --out $N/census-r2b.json
  bun eval/harness-provider/mpw_tools/store-census.ts --gbrain $OV/${NEW:0:9} --store ~/eq/cells/_stores/$(cat $N/new.store) --out $N/census-new.json
  for r in r2a r3; do
    [ -f $N/answer-$r/summary.json ] && continue
    changed $N/$r $N/changed-$r.json
    [ "$(cat $N/changed-$r.json)" = "[]" ] && { echo '{"changed": 0}' > $N/answer-$r.skipped; continue; }
    s=$([ $r = r2a ] && echo 21 || echo 23)
    bun run harness:cell reanswer $cid --sample $s --out $N/reanswer-$r --retrievals $N/$r/$cid --questions $N/changed-$r.json --budget-usd 2 --cells-dir ~/eq/cells $L || return 1
    J=$N/judge-$r/cells; rm -rf $J; mkdir -p $J
    cp -r ~/eq/cells/$cid $J/$cid && cp -r $N/reanswer-$r/$cid-s$s $J/$cid-s$s
    python3 - $J $cid $cid-s$s $N/changed-$r.json <<'PY'
import json, sys
j, *cells, changed = sys.argv[1:]
keep = set(json.load(open(changed)))
for c in cells:
    p = f"{j}/{c}/cell.json"; d = json.load(open(p))
    d["resolved"]["schedule"] = [q for q in d["resolved"]["schedule"] if q in keep]
    json.dump(d, open(p, "w"), indent=2)
PY
    bun run harness:cell rejudge $cid $cid-s$s --cells-dir $J --out $N/answer-$r --budget-usd 3 $L || return 1
  done
}
finish combined > ~/eq/nh-finish-combined.log 2>&1 & a=$!
finish raw > ~/eq/nh-finish-raw.log 2>&1 & b=$!
wait $a; fa=$?; wait $b; fb=$?
bun eval/runner/budget-ledger.ts status $L > ~/eq/ledger-status.json
echo "$fa $fb" > ~/eq/nh.exit
