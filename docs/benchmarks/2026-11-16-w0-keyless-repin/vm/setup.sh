#!/usr/bin/env bash
# Ubicloud VM bootstrap for the W0 keyless re-pin (2026-11-16-w0-keyless-repin-preregistration.md). Installs Bun 1.4.4,
# Docker with the digest-pinned pgvector image used by every earlier re-pin, two copies of this checkout under ~/w/old and
# ~/w/new that differ only in package.json and bun.lock (copied from vm/pins/, frozen install), a blobless gbrain clone for
# the lifecycle runner, and the cleaned LongMemEval-S file checked against its sha256 (skipped with W0_KEPT=1, because no
# kept row reads it). No provider key is set on the VM.
set -euo pipefail
for k in ANTHROPIC_API_KEY OPENAI_API_KEY VOYAGE_API_KEY PARTICLE_API_KEY GEMINI_API_KEY GOOGLE_API_KEY GOOGLE_GENERATIVE_AI_API_KEY GROQ_API_KEY OPENROUTER_API_KEY TOGETHER_API_KEY TYPESAFE_API_KEY JEV_TYPESAFE_API_KEY UBICLOUD_API_KEY UBICLOUD_API_TOKEN; do unset "$k"; done
R=docs/benchmarks/2026-11-16-w0-keyless-repin
OLD=77cf8e1116e9af67c1983adcbb3223b96f0991a5
NEW=6ce7195b44a034f85aec811f11fbf862db376f50
sudo apt-get update -qq && sudo apt-get install -y -qq unzip python3 git docker.io >/dev/null
sudo usermod -aG docker "$USER"
sudo docker pull -q pgvector/pgvector@sha256:7b822b0aac60967beb1ea5e576b8602c94c300a157d187f385ae3e0da199b90a
sudo docker tag pgvector/pgvector@sha256:7b822b0aac60967beb1ea5e576b8602c94c300a157d187f385ae3e0da199b90a pgvector/pgvector:pg16
curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.4" >/dev/null
export PATH="$HOME/.bun/bin:$PATH"
bun --version
SRC="$PWD"
for side in old new; do
  if [ "$side" = old ]; then sha=$OLD; else sha=$NEW; fi
  D="$HOME/w/$side"; rm -rf "$D"; mkdir -p "$D"
  cp -a "$SRC/." "$D/"
  cp "$SRC/$R/vm/pins/$sha.package.json" "$D/package.json"
  cp "$SRC/$R/vm/pins/$sha.bun.lock" "$D/bun.lock"
  (cd "$D" && bun install --frozen-lockfile >/dev/null && grep '"version"' node_modules/gbrain/package.json)
done
git clone -q --filter=blob:none https://github.com/garrytan/gbrain.git "$HOME/gbrain"
git -C "$HOME/gbrain" cat-file -e "$OLD^{commit}" && git -C "$HOME/gbrain" cat-file -e "$NEW^{commit}"
if [ "${W0_KEPT:-0}" != 1 ]; then
  mkdir -p "$HOME/data"
  curl -fsSL -o "$HOME/data/longmemeval_s_cleaned.json" https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json
  echo "d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442  $HOME/data/longmemeval_s_cleaned.json" | sha256sum -c -
fi
echo setup-ok
