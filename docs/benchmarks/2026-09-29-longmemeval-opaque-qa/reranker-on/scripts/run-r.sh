#!/usr/bin/env bash
# Reranker-on arms on gbrain a7cb37b. R1: notes/1024 (house default + reranker). R2: direct/512 (published config minus the leak).
set -u
ARM=$1
cd $M6_DIR
case $ARM in
  r1) READER="--reader-mode notes --reader-max-tokens 1024" ;;
  r2) READER="--reader-mode direct --reader-max-tokens 512" ;;
  *) echo "arm must be r1|r2"; exit 2 ;;
esac
export GBRAIN_EMBEDDING_MODEL=openai:text-embedding-3-large GBRAIN_EMBEDDING_DIMENSIONS=1536 GBRAIN_LME_DEBUG=1 M6_CALLS=$PWD/$ARM/calls.ndjson
touch $ARM/rows.ndjson
bun driver-r.ts data/longmemeval_s_cleaned.json --top-k 5 --no-trajectory --mode balanced --reranker on --autocut off \
  --model anthropic:claude-sonnet-4-6 $READER --judge --judge-model openai:gpt-4o --max-usd 10 --yes --by-type \
  --embed-cache $PWD/embed-cache.sqlite --output $PWD/$ARM/rows.ndjson --resume-from $PWD/$ARM/rows.ndjson 2>> $ARM/stderr.full.txt
echo "rc=$?" >> $ARM/stderr.full.txt
