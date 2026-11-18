#!/usr/bin/env bash
# Ubicloud VM bootstrap for the LongMemEval plain-hybrid retrieval baseline (run once as user ubi from the synced
# checkout): Bun at the version CI pins, a frozen install, and LongMemEval-S cleaned fetched and checked against its
# pinned SHA-256 by the repository's own fetcher.
set -euo pipefail
sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq unzip sqlite3 >/dev/null
BUN_VERSION=$(sed -n 's/^ *bun-version: *\([0-9.]*\).*/\1/p' .github/workflows/ci.yml | head -1)
curl -fsSL https://bun.sh/install | bash -s "bun-v$BUN_VERSION" >/dev/null
export PATH="$HOME/.bun/bin:$PATH"
grep -q '.bun/bin' "$HOME/.profile" 2>/dev/null || echo 'export PATH="$HOME/.bun/bin:$PATH"' >> "$HOME/.profile"
bun install --frozen-lockfile >/dev/null
bun run eval:decide fetch --benchmark lme-s
echo "vm-setup ready: $(nproc) vCPU, $(free -g | awk '/Mem:/{print $2}') GB, bun $(bun --version)"
