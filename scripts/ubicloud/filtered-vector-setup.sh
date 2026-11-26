#!/usr/bin/env bash
# Bootstrap for a filtered vector search VM (Ubicloud, Ubuntu 24.04), run once as user ubi in the synced gbrain-evals
# checkout (docs/benchmarks/2026-11-26-filtered-vector-material-preregistration.md). Installs Docker and Bun, the
# checkout's dependencies, gbrain at GBRAIN_REF in ~/gbrain with its own dependencies, builds arm T in
# ~/gbrain-material-off, and starts one Postgres server on 127.0.0.1:5434 sized as gbrain's own bench sizes it
# (scripts/bench/hnsw-scale-vm-setup.sh at the pin): shared_buffers 25% and effective_cache_size 75% of memory,
# random_page_cost 1.1, effective_io_concurrency 200, everything else at Postgres defaults. PG_IMAGE=none skips
# Postgres (the PGLite VM); WIKI=1 adds pyarrow for gbrain's Wikipedia corpus prep.
#
#   PG_IMAGE=pgvector/pgvector:0.8.7-pg17 GBRAIN_REF=<sha> bash scripts/ubicloud/filtered-vector-setup.sh
set -euo pipefail
GBRAIN_REF=${GBRAIN_REF:?set GBRAIN_REF to the pinned gbrain commit}
PG_IMAGE=${PG_IMAGE:-pgvector/pgvector:0.8.7-pg17}
BUN_VERSION=${BUN_VERSION:-1.4.4}
t0=$(date +%s)
step() { echo "[fv-setup +$(( $(date +%s) - t0 ))s] $*"; }

echo force-unsafe-io | sudo tee /etc/dpkg/dpkg.cfg.d/99-fv-bench >/dev/null
apt_get() { sudo DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1 apt-get -qq -o Acquire::Languages=none "$@" >/dev/null; }
step apt
apt_get update
apt_get install -y --no-install-recommends docker.io git ca-certificates python3 python3-pip procps postgresql-client jq unzip curl
sudo systemctl start docker
sudo chmod 666 /var/run/docker.sock
[ "${WIKI:-0}" != 1 ] || pip3 install -q --break-system-packages pyarrow

pull=
if [ "$PG_IMAGE" != none ]; then
  step "postgres image $PG_IMAGE"
  docker pull -q "$PG_IMAGE" >/dev/null &
  pull=$!
fi

step "bun $BUN_VERSION"
if ! command -v bun >/dev/null || [ "$(bun --version)" != "$BUN_VERSION" ]; then
  tmp=$(mktemp -d)
  curl -fsSL --retry 5 --retry-all-errors -o "$tmp/bun.zip" "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/bun-linux-x64.zip"
  python3 -m zipfile -e "$tmp/bun.zip" "$tmp"
  mkdir -p "$HOME/.bun/bin"
  install -m 755 "$tmp/bun-linux-x64/bun" "$HOME/.bun/bin/bun"
  rm -rf "$tmp"
fi
export PATH="$HOME/.bun/bin:$PATH"
grep -q '.bun/bin' "$HOME/.profile" || echo 'export PATH="$HOME/.bun/bin:$PATH"' >> "$HOME/.profile"

step dependencies
bun install --frozen-lockfile >/dev/null
[ -d "$HOME/gbrain" ] || git clone -q --filter=blob:none https://github.com/garrytan/gbrain.git "$HOME/gbrain"
git -C "$HOME/gbrain" fetch -q origin "$GBRAIN_REF"
git -C "$HOME/gbrain" checkout -q "$GBRAIN_REF"
(cd "$HOME/gbrain" && bun install --frozen-lockfile >/dev/null)
bun eval/runner/filtered-vector/patch-arm.ts "$HOME/gbrain" "$HOME/gbrain-material-off"
[ -z "$pull" ] || wait "$pull"

if [ "$PG_IMAGE" != none ]; then
  mem_mb=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1024 ))
  shared=$(( mem_mb / 4 ))
  cache=$(( mem_mb * 3 / 4 ))
  shm=$(( mem_mb / 2 ))
  step "postgres: ${mem_mb} MB RAM, shared_buffers ${shared}MB, effective_cache_size ${cache}MB"
  sudo mkdir -p /var/lib/fv-pg
  docker rm -f fv-pg >/dev/null 2>&1 || true
  docker run -d --name fv-pg --shm-size="${shm}m" -p 127.0.0.1:5434:5432 -e POSTGRES_PASSWORD=postgres \
    -v /var/lib/fv-pg:/var/lib/postgresql/data "$PG_IMAGE" \
    -c shared_buffers="${shared}MB" -c effective_cache_size="${cache}MB" -c random_page_cost=1.1 -c effective_io_concurrency=200 >/dev/null
  for _ in $(seq 1 90); do PGPASSWORD=postgres psql -h 127.0.0.1 -p 5434 -U postgres -tAc 'select 1' >/dev/null 2>&1 && break; sleep 1; done
  PGPASSWORD=postgres psql -h 127.0.0.1 -p 5434 -U postgres -tAc "select version(), (select default_version from pg_available_extensions where name = 'vector')"
  echo "image_digest=$(docker image inspect --format '{{index .RepoDigests 0}}' "$PG_IMAGE")"
fi
step "ready: $(nproc) vCPU, gbrain $(git -C "$HOME/gbrain" rev-parse HEAD), disk $(df -h "$HOME" | awk 'NR==2 {print $4}') free"
