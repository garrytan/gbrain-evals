#!/usr/bin/env bash
# Ubicloud VM bootstrap for the evidence-delivery runs: Bun, gbrain-evals deps,
# the pinned gbrain checkout and the LongMemEval-S dataset (hash-checked).
set -euo pipefail
GBRAIN_SHA=732ee8116b6fd7d2de38824a54d35f57e4ea35c4
command -v unzip >/dev/null || { sudo apt-get update -qq && sudo apt-get install -y -qq unzip >/dev/null; }
command -v bun >/dev/null || { curl -fsSL https://bun.sh/install | bash >/dev/null; }
export PATH="$HOME/.bun/bin:$PATH"
bun install >/dev/null
if [ ! -d "$HOME/gbrain" ]; then git clone -q https://github.com/garrytan/gbrain.git "$HOME/gbrain"; fi
git -C "$HOME/gbrain" fetch -q origin "$GBRAIN_SHA" 2>/dev/null || git -C "$HOME/gbrain" fetch -q origin capy/evidence-delivery
git -C "$HOME/gbrain" -c advice.detachedHead=false checkout -q "$GBRAIN_SHA"
(cd "$HOME/gbrain" && bun install >/dev/null)
mkdir -p "$HOME/data"
[ -f "$HOME/data/longmemeval_s_cleaned.json" ] || curl -fsSL -o "$HOME/data/longmemeval_s_cleaned.json" https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json
echo "d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442  $HOME/data/longmemeval_s_cleaned.json" | sha256sum -c -
git -C "$HOME/gbrain" rev-parse HEAD
