#!/usr/bin/env bash
# Ubicloud VM bootstrap for the re-pin regression runs: Bun 1.4.2 and a frozen install of this checkout.
set -euo pipefail
sudo apt-get update -qq && sudo apt-get install -y -qq unzip python3 git >/dev/null
curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.2" >/dev/null
export PATH="$HOME/.bun/bin:$PATH"
bun --version
bun install --frozen-lockfile
