#!/usr/bin/env bash
# Bootstrap for an engine-bench VM (Ubicloud, Ubuntu 24.04), run once as user ubi in the synced gbrain-evals checkout.
# Installs Docker and Bun 1.4.4, installs the checkout's dependencies, clones gbrain at GBRAIN_REF (the release under
# test) to ~/gbrain for --gbrain ~/gbrain@<ref>, and pulls the Postgres image, so the run itself downloads nothing.
set -euo pipefail
GBRAIN_REF=${GBRAIN_REF:?set GBRAIN_REF to the gbrain tag or commit under test}
PG_IMAGE=${PG_IMAGE:-pgvector/pgvector:pg16}
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io unzip git curl python3 jq >/dev/null
sudo systemctl enable --now docker
sudo chmod 666 /var/run/docker.sock
command -v bun >/dev/null || curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.4" >/dev/null
export PATH="$HOME/.bun/bin:$PATH"
bun install --frozen-lockfile >/dev/null
[[ -d "$HOME/gbrain" ]] || git clone -q --filter=blob:none https://github.com/garrytan/gbrain.git "$HOME/gbrain"
git -C "$HOME/gbrain" fetch -q --tags origin
git -C "$HOME/gbrain" checkout -q "$GBRAIN_REF"
docker pull -q "$PG_IMAGE" >/dev/null
echo "setup ok: $(nproc) vCPU, $(free -g | awk '/Mem:/{print $2}') GB, bun $(bun --version), gbrain $(git -C "$HOME/gbrain" describe --tags)"
