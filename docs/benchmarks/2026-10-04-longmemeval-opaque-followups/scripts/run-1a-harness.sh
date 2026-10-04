#!/usr/bin/env bash
# Item 1a-H orchestration on one VM. Phase 1: A1 in four 125-question shards, each with its own cache; merge
# caches and rows; a no-op full A1 resume writes the run summary. Phase 2: the other seven arms and the four
# development-slice replays, each as its own process on its own copy of the merged cache.
set -u
cd "$(dirname "$0")"
S=$PWD
REPO=$(cd ../../../.. && pwd)
R=$REPO/docs/benchmarks/2026-09-06-longmemeval-ranker-wave/longmemeval
A3=$R/A3-hybrid-expansion-rerank-off-autocut-off.ndjson
W=$HOME/lme/1a-H
PRE="--search-pin search.relational_rerank_pin=0 --search-pin search.metadata_boost_gate=always"
mkdir -p $W/shards
source $HOME/.lmeenv
python3 - "$HOME/lme/data/longmemeval_s_cleaned.json" "$W/shards" "$R" <<'PY'
import json,sys
ids=[q['question_id'] for q in json.load(open(sys.argv[1]))]
for i in range(4): open(f'{sys.argv[2]}/q{i}.txt','w').write('\n'.join(ids[i*125:(i+1)*125])+'\n')
dev=[json.loads(l)['question_id'] for l in open(f'{sys.argv[3]}/devslice40-budget0.25.ndjson') if '"question_id"' in l]
open(f'{sys.argv[2]}/dev40.txt','w').write('\n'.join(dev)+'\n'); print(len(ids), len(dev))
PY
# Phase 1
for i in 0 1 2 3; do
  bash $S/run-arm.sh $W/A1-shard$i $W/A1-shard$i/cache.sqlite --mode balanced --reranker off --autocut off $PRE --question-ids $W/shards/q$i.txt &
done
wait
for i in 0 1 2 3; do [ -f $W/A1-shard$i/DONE ] || { echo "shard $i failed"; exit 1; }; done
cp $W/A1-shard0/cache.sqlite $W/cache-merged.sqlite
for i in 1 2 3; do sqlite3 $W/cache-merged.sqlite "ATTACH '$W/A1-shard$i/cache.sqlite' AS s; INSERT OR IGNORE INTO embed_cache SELECT * FROM s.embed_cache; DETACH s;"; done
sqlite3 $W/cache-merged.sqlite "PRAGMA wal_checkpoint(TRUNCATE); SELECT count(*) FROM embed_cache;" > $W/cache-merged.count
mkdir -p $W/A1
for i in 0 1 2 3; do grep '"question_id"' $W/A1-shard$i/rows.ndjson; done > $W/A1/rows.ndjson
cat $W/A1-shard*/calls.ndjson > $W/A1/calls.ndjson
cp $W/cache-merged.sqlite $W/A1/cache.sqlite
bash $S/run-arm.sh $W/A1 $W/A1/cache.sqlite --mode balanced --reranker off --autocut off $PRE
# Phase 2
arm() { local name=$1; shift; mkdir -p $W/$name; cp $W/cache-merged.sqlite $W/$name/cache.sqlite; bash $S/run-arm.sh $W/$name $W/$name/cache.sqlite "$@"; }
arm A2    --mode balanced --reranker on  --autocut off $PRE &
arm A3    --mode balanced --reranker off --autocut off --expansion-replay $A3 $PRE &
arm A4    --mode balanced --reranker on  --autocut on  $PRE &
arm A3p   --mode balanced --reranker off --autocut off --expansion-replay $A3 --expansion-variant-budget 0.25 $PRE &
arm A3pR  --mode tokenmax --reranker on  --autocut on  --expansion-replay $A3 --expansion-variant-budget 0.25 $PRE &
arm TMXR  --mode tokenmax --reranker on  --autocut off --expansion-replay $A3 &
arm FINAL --mode balanced --reranker on  --autocut off &
for b in 2.0 1.0 0.5 0.25; do
  arm dev40-b$b --mode balanced --reranker off --autocut off --expansion-replay $A3 --expansion-variant-budget $b --question-ids $W/shards/dev40.txt $PRE &
done
wait
ls $W/*/DONE $W/*/FAILED 2>/dev/null
echo ALLDONE > $W/ALLDONE
