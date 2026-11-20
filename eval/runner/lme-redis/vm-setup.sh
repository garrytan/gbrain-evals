#!/usr/bin/env bash
# Sets up a Ubicloud VM for the LongMemEval run on Redis's open harness (run with ubi-runner.sh --setup from the
# synced gbrain-evals checkout). Keyless: it installs the toolchain, the pinned gbrain release and the vendored harness,
# and fetches both LongMemEval files at their pinned Hugging Face revision; lme_redis.py checks their sha256 on load.
set -euo pipefail
GBRAIN_TAG=${GBRAIN_TAG:-v0.60.752.0}
GBRAIN_SHA=${GBRAIN_SHA:-1f8d079d13c10d511c919cf69dd1e4c0137fbfcd}
sudo apt-get update -qq && sudo apt-get install -y -qq unzip git curl python3 >/dev/null
curl -fsSL https://bun.sh/install | bash -s bun-v1.4.4 >/dev/null
curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
bun install --frozen-lockfile >/dev/null
git clone -q --depth 1 --branch "$GBRAIN_TAG" https://github.com/garrytan/gbrain.git "$HOME/gbrain"
test "$(git -C "$HOME/gbrain" rev-parse HEAD)" = "$GBRAIN_SHA"
(cd "$HOME/gbrain" && bun install >/dev/null)
uv sync -q --python 3.12 --project eval/redis-agent-memory-benchmark
mkdir -p "$HOME/lme-cache/longmemeval-v1"
base=https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/98d7416c24c778c2fee6e6f3006e7a073259d48f
for f in longmemeval_s_cleaned.json longmemeval_oracle.json; do
  curl -fsSL -o "$HOME/lme-cache/longmemeval-v1/$f" "$base/$f"
done
(cd "$HOME/lme-cache/longmemeval-v1" && echo "d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442  longmemeval_s_cleaned.json
821a2034d219ab45846873dd14c14f12cfe7776e73527a483f9dac095d38620c  longmemeval_oracle.json" | sha256sum -c -)
echo LME_REDIS_SETUP_OK
