#!/usr/bin/env bash
# Bootstrap a fresh Ubuntu 24.04 VM (Ubicloud) for harness cells: Bun 1.4.2, uv 0.12.3,
# the pinned harness venv and the pinned comparator server. Run from the synced checkout.
set -euo pipefail
sudo apt-get update -qq && sudo apt-get install -y -qq unzip git curl python3 >/dev/null
curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.2" >/dev/null
curl -LsSf https://astral.sh/uv/0.12.3/install.sh | sh >/dev/null
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
echo 'export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"
bun install --frozen-lockfile
bun run harness:setup
bun run harness:comparator install
