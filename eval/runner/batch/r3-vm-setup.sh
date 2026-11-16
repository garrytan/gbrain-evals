#!/usr/bin/env bash
# R3's Ubicloud VM setup (W10 preregistration, amendment of 2026-11-16). Runs once in the synced checkout as `ubi`:
# Bun 1.4.4, this checkout's dependencies, gbrain at R3's frozen sha in node_modules/gbrain (package.json's pin is left
# alone; the R3 runners refuse any other build), a gbrain c5fb0201 checkout for W10c's whole-history text, and
# LongMemEval-S checked against its SHA-256. No provider is called here.
set -euo pipefail
: "${GBRAIN_SHA:?GBRAIN_SHA names the frozen R3 gbrain commit}"
C5FB0201=c5fb0201d1960a0a5a81c35d77718311b03154b7
ST=${R3_STATE:-$HOME/r3}
export PATH=$HOME/.bun/bin:$PATH
[ "$(bun --version 2>/dev/null)" = 1.4.4 ] || curl -fsSL https://bun.sh/install | bash -s bun-v1.4.4
bun install --frozen-lockfile
checkout() {
  rm -rf "$1" && git init -q "$1" && git -C "$1" remote add origin https://github.com/garrytan/gbrain.git
  git -C "$1" fetch -q --depth 1 origin "$2" && git -C "$1" -c advice.detachedHead=false checkout -q FETCH_HEAD
  (cd "$1" && bun install --frozen-lockfile)
}
[ "$(git -C node_modules/gbrain rev-parse HEAD 2>/dev/null)" = "$GBRAIN_SHA" ] || checkout node_modules/gbrain "$GBRAIN_SHA"
[ "$(git -C "$ST/gbrain-c5fb0201" rev-parse HEAD 2>/dev/null)" = $C5FB0201 ] || checkout "$ST/gbrain-c5fb0201" $C5FB0201
mkdir -p "$ST/data" "$ST/windows"
D=$ST/data/longmemeval_s_cleaned.json
[ -s "$D" ] || curl -fsSLo "$D" https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/98d7416c24c778c2fee6e6f3006e7a073259d48f/longmemeval_s_cleaned.json
echo "d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442  $D" | sha256sum -c -
bun -e "const { assertR3Gbrain } = await import('./eval/runner/batch/w10.ts'); console.log(JSON.stringify({ gbrain: assertR3Gbrain() }))"
