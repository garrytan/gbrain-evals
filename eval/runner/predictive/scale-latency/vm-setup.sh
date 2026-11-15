#!/usr/bin/env bash
# Scale-latency VM setup (GBEV-55 G5). ubicloud.ts runs this once on a fresh
# Ubuntu 24.04 Ubicloud VM, inside the synced gbrain-evals checkout. It installs
# Postgres 16 with pgvector, makes a scratch database "scale" owned by a
# superuser role "ubi" (gbrain's schema creates the vector extension) that
# connects over loopback without a password to it and to the per-pin copies
# ubicloud.ts makes from it (the VM is ephemeral, listens on
# loopback only and holds only fictional pages), gives Postgres a memory budget
# sized for a 300k-page brain, and installs bun and the repo's dependencies.
# Running it again changes nothing that is already in place.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
sudo -E apt-get update -qq
sudo -E apt-get install -y -qq postgresql postgresql-16-pgvector git curl unzip >/dev/null

HBA=$(sudo -u postgres psql -tAc 'SHOW hba_file')
if ! sudo grep -q '# scale-latency' "$HBA"; then
  sudo sed -i '1i host all ubi 127.0.0.1/32 trust # scale-latency' "$HBA"
fi
sudo -u postgres psql -qc "ALTER SYSTEM SET shared_buffers = '8GB'"
sudo -u postgres psql -qc "ALTER SYSTEM SET effective_cache_size = '24GB'"
sudo -u postgres psql -qc "ALTER SYSTEM SET maintenance_work_mem = '2GB'"
sudo systemctl restart postgresql

sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname = 'ubi'" | grep -q 1 || sudo -u postgres createuser --superuser ubi
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname = 'scale'" | grep -q 1 || sudo -u postgres createdb -O ubi scale

[ -x "$HOME/.bun/bin/bun" ] || curl -fsSL https://bun.sh/install | bash >/dev/null
"$HOME/.bun/bin/bun" install --frozen-lockfile
