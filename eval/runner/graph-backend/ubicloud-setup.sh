#!/usr/bin/env bash
# Bootstrap for the Company tier VM (Ubicloud, Ubuntu 24.04), run once as user ubi
# in the synced gbrain-evals checkout. Installs Docker and Bun, checks out gbrain
# at the two SHAs under test, and pulls the Postgres and MinIO images. The
# HydraDB image is loaded separately (docker load of the image built from
# hydra-db/hydradb on the Capy machine), so both tiers run the same image id.
set -euo pipefail
GB_A_SHA=${GB_A_SHA:-b1fdcb843a5c58a63eda7416dc4965d1926c5232}
GB_B_SHA=${GB_B_SHA:-fc1121cae5801f5bdc1eb8241432cf77b7ba5626}
HYDRADB_SHA=${HYDRADB_SHA:-fe496d475be34b5f5ce60377108b039fd6d485d3}
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io unzip git curl python3 >/dev/null
sudo systemctl enable --now docker
sudo chmod 666 /var/run/docker.sock
command -v bun >/dev/null || curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"
W=$HOME/.capy/work/g123
mkdir -p "$W"
echo "$HYDRADB_SHA" > "$W/hydradb.sha"
if [[ ! -d "$W/gbrain-src" ]]; then git clone -q --filter=blob:none https://github.com/garrytan/gbrain.git "$W/gbrain-src"; fi
git -C "$W/gbrain-src" fetch -q origin "$GB_A_SHA" "$GB_B_SHA" 2>/dev/null || git -C "$W/gbrain-src" fetch -q origin capy/bfs-graph-walks master
for x in A B; do
  sha=GB_${x}_SHA; sha=${!sha}
  [[ -d "$W/gbrain-$x" ]] || git -C "$W/gbrain-src" worktree add -q -f "$W/gbrain-$x" "$sha"
  (cd "$W/gbrain-$x" && bun install --frozen-lockfile >/dev/null)
done
(cd "$(dirname "$0")/../../.." && bun install >/dev/null)
docker pull -q pgvector/pgvector:pg17 >/dev/null
docker pull -q bitnamilegacy/minio:2025.7.23 >/dev/null
echo "setup ok: $(nproc) vCPU, $(free -g | awk '/Mem:/{print $2}') GB"
