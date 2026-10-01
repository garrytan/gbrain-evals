#!/usr/bin/env bash
# Bootstrap a fresh Ubicloud Ubuntu VM for the System One eval arms
# (scripts/ubicloud/ubi-runner.sh run --setup <this file>). Installs Bun and
# the checkout's dependencies and creates an empty keyless PGLite brain.
set -euo pipefail
sudo apt-get update -qq && sudo apt-get install -y -qq unzip python3 > /dev/null
curl -fsSL https://bun.sh/install | bash > /dev/null
echo 'export PATH="$HOME/.bun/bin:$PATH"' >> "$HOME/.profile"
export PATH="$HOME/.bun/bin:$PATH"
bun install > /dev/null
GBRAIN_HOME="$HOME/gbhome" bun src/cli.ts init --pglite --no-embedding > /dev/null
echo "setup ok: bun $(bun --version), $(nproc) vCPU"
