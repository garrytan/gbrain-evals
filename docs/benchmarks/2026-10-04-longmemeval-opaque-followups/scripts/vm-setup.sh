#!/usr/bin/env bash
# Ubicloud VM bootstrap for item 1a (run from the synced checkout as user ubi).
set -euo pipefail
sudo apt-get update -qq && sudo apt-get install -y -qq sqlite3 unzip >/dev/null
curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.2" >/dev/null
export PATH=$HOME/.bun/bin:$PATH
bun install --frozen-lockfile >/dev/null
mkdir -p ~/lme/data
curl -fsSLo ~/lme/data/longmemeval_s_cleaned.json https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json
echo "d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442  $HOME/lme/data/longmemeval_s_cleaned.json" | sha256sum -c -
bun --version
