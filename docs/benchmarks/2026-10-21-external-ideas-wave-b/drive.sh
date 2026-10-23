#!/usr/bin/env bash
set -u
L=$HOME/.capy/work/gbra162/lme
DS=$HOME/.capy/work/datasets/longmemeval_s_cleaned.json
cd $HOME/.capy/work/gbra162/pin
export GBRAIN_EMBEDDING_MODEL=voyage:voyage-4 GBRAIN_EMBEDDING_DIMENSIONS=1024
mkdir -p $L/shards $L/runs $L/calls
python3 - <<'EOF'
import os
L=os.path.expanduser('~/.capy/work/gbra162/lme')
ids=[l.strip() for l in open(os.path.expanduser('~/.capy/work/datasets/lme-s-470.txt')) if l.strip()]
for s in range(4):
    open(f'{L}/shards/s{s}.txt','w').write('\n'.join(ids[s::4])+'\n')
EOF
spend() { python3 - <<'EOF'
import json,glob,os
L=os.path.expanduser('~/.capy/work/gbra162/lme')
e=r=0
for f in glob.glob(L+'/calls/*.jsonl')+[L+'/smoke-calls.jsonl']:
    for l in open(f):
        try: o=json.loads(l)
        except: continue
        if o.get('kind')=='embedding': e+=o.get('input_tokens') or 0
        if o.get('kind')=='rerank': r+=o.get('input_tokens') or 0
print(f"{e*0.06/1e6 + r*0.02/1e6:.4f} embed_tokens={e} rerank_tokens={r}")
EOF
}
run() { # name k flags...
  local name=$1 k=$2; shift 2
  for s in 0 1 2 3; do
    mkdir -p $L/home-$name-$k-s$s
    GBRAIN_HOME=$L/home-$name-$k-s$s GBRAIN_AI_CALL_LOG=$L/calls/$name-k$k-s$s.jsonl bun run src/cli.ts eval longmemeval $DS --retrieval-only --by-type --no-trajectory --mode balanced --reranker on --autocut off \
      --question-ids $L/shards/s$s.txt --top-k $k --embed-cache $L/embed-s$s.sqlite --output $L/runs/$name-k$k-s$s.ndjson "$@" > $L/runs/$name-k$k-s$s.log 2>&1 &
  done
  wait
  echo "$(date -u +%H:%M:%S) done $name k$k; spend $(spend)"
  local total=$(spend | cut -d' ' -f1)
  if python3 -c "import sys; sys.exit(0 if float('$total') > 18 else 1)"; then echo "SPEND STOP at $total"; exit 3; fi
}
run B0 5
run B0 10
run B1 5 --reranker-document titled
run B1 10 --reranker-document titled
run B2 5 --reranker-fuse rrf
run B2 10 --reranker-fuse rrf
run B3 5 --reranker-fuse rrf --reranker-document titled
run B3 10 --reranker-fuse rrf --reranker-document titled
echo ALL DONE
