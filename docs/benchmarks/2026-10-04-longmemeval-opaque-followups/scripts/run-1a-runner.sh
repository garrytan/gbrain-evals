#!/usr/bin/env bash
# Item 1a-R: the September 2 five-arm command through this repository's runner (opaque ids since v0.10.1).
set -u
cd "$(dirname "$0")/../../../.."
source $HOME/.lmeenv; export PATH=$HOME/.bun/bin:$PATH
W=$HOME/lme/1a-R; mkdir -p $W
bash eval/runner/longmemeval-batch.sh \
  --adapters hybrid,hybrid+expansion,hybrid-sessdiv,hybrid+rerank,hybrid-sessdiv+rerank \
  --embedding-model openai:text-embedding-3-large --embedding-dims 1536 \
  --path $HOME/lme/data/longmemeval_s_cleaned.json --budget-usd 11 --workers ${WORKERS:-6} \
  --ndjson $W/rows.ndjson > $W/batch.log 2>&1
echo "rc=$?" >> $W/batch.log
echo done > $W/ALLDONE
