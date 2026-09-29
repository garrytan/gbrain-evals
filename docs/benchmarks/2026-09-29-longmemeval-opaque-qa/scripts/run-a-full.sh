#!/usr/bin/env bash
# Arm (a): house reader (notes, 1024, claude-sonnet-4-6), full 500, opaque ids, reranker OFF.
set -u
cd $M6_DIR
export GBRAIN_EMBEDDING_MODEL=openai:text-embedding-3-large GBRAIN_EMBEDDING_DIMENSIONS=1536 GBRAIN_LME_DEBUG=1 M6_CALLS=$PWD/a/calls.ndjson
bun driver-a.ts data/longmemeval_s_cleaned.json --top-k 5 --no-trajectory --mode balanced --reranker off --autocut off \
  --model anthropic:claude-sonnet-4-6 --judge --judge-model openai:gpt-4o --max-usd 10 --yes --by-type \
  --embed-cache $PWD/embed-cache.sqlite --output $PWD/a/rows.ndjson --resume-from $PWD/a/rows.ndjson "$@" 2>> a/stderr.full.log
echo "rc=$?" >> a/stderr.full.log
