#!/usr/bin/env bash
# Bootstrap a fresh Ubicloud VM (Ubuntu) for the SOTA loop's windows: ripgrep (the grep agent), bun 1.4.4 (the version CI
# pins), a frozen-lockfile install, and the public dev data: LongMemEval-S and BEAM-1M's dev conversations only, never a
# held-out one. scripts/ubicloud/ubi-runner.sh runs it from the synced checkout (run --setup); run.sh passes it.
set -euo pipefail
BUN_VERSION=1.4.4
if ! command -v rg >/dev/null || ! command -v unzip >/dev/null || ! command -v git >/dev/null; then
  sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ripgrep unzip git >/dev/null
fi
if [ "$("$HOME/.bun/bin/bun" --version 2>/dev/null || true)" != "$BUN_VERSION" ]; then
  curl -fsSL https://bun.sh/install | bash -s "bun-v$BUN_VERSION" >/dev/null
fi
sudo ln -sf "$HOME/.bun/bin/bun" /usr/local/bin/bun
[ "$(bun --version)" = "$BUN_VERSION" ] || { echo "setup: bun $(bun --version) is not $BUN_VERSION" >&2; exit 1; }
bun install --frozen-lockfile
dev=$(bun -e "import { loadSplit } from './eval/runner/decisions/splits.ts'; console.log(loadSplit('beam-1m').dev.join(','))")
bun eval/runner/decide.ts fetch --benchmark beam-1m --conversations "$dev"
bun eval/runner/decide.ts fetch --benchmark lme-s
echo "setup: bun $(bun --version), $(rg --version | head -1), BEAM-1M dev conversations $dev and LongMemEval-S verified"
