#!/usr/bin/env bash
# Bootstrap a fresh Ubicloud VM (Ubuntu) for the predictive runner: ripgrep, bun 1.4.4 (the version CI pins) and a
# frozen-lockfile install, then a keyless dry run to prove the checkout works. scripts/ubicloud/ubi-runner.sh runs it
# from the synced checkout (run --setup); eval/runner/predictive/ubicloud/run.sh passes it. Safe to rerun.
set -euo pipefail
BUN_VERSION=1.4.4
if ! command -v rg >/dev/null || ! command -v unzip >/dev/null || ! command -v git >/dev/null; then
  sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ripgrep unzip git >/dev/null
fi
if [ "$("$HOME/.bun/bin/bun" --version 2>/dev/null || true)" != "$BUN_VERSION" ]; then
  curl -fsSL https://bun.sh/install | bash -s "bun-v$BUN_VERSION" >/dev/null
fi
# The detached command runs under bash -lc, which skips ~/.bashrc, so bun goes on the system PATH.
sudo ln -sf "$HOME/.bun/bin/bun" /usr/local/bin/bun
[ "$(bun --version)" = "$BUN_VERSION" ] || { echo "setup: bun $(bun --version) is not $BUN_VERSION" >&2; exit 1; }
bun install --frozen-lockfile
bun eval/runner/predictive/run.ts g4 --dry-run --tasks 1 --k 1 >/dev/null
echo "setup: bun $(bun --version), $(rg --version | head -1), predictive dry run ok"
