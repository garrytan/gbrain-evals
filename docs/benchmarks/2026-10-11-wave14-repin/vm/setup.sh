#!/usr/bin/env bash
# Ubicloud VM bootstrap for the wave 14 re-pin regression runs: Bun 1.4.2, Docker with the digest-pinned
# pgvector image (Postgres cells of N1, N5 and N6 over HTTP), and a frozen install of this checkout.
set -euo pipefail
sudo apt-get update -qq && sudo apt-get install -y -qq unzip python3 git docker.io >/dev/null
sudo usermod -aG docker "$USER"
sudo docker pull -q pgvector/pgvector@sha256:7b822b0aac60967beb1ea5e576b8602c94c300a157d187f385ae3e0da199b90a
sudo docker tag pgvector/pgvector@sha256:7b822b0aac60967beb1ea5e576b8602c94c300a157d187f385ae3e0da199b90a pgvector/pgvector:pg16
curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.2" >/dev/null
export PATH="$HOME/.bun/bin:$PATH"
bun --version
bun install --frozen-lockfile
