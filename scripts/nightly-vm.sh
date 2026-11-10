#!/usr/bin/env bash
# Bootstrap for the nightly gbrain check on a fresh Ubicloud VM (Ubuntu 24.04), run once as user ubi from the root of
# the synced gbrain-evals checkout (or an export made by scripts/nightly-export.sh), for example:
#
#   UBI_OWNER=<owner> scripts/ubicloud/ubi-runner.sh run -s standard-16 --setup scripts/nightly-vm.sh -- '<nightly command>'
#
# It mirrors CI (.github/workflows/ci.yml): Bun at the version CI pins, python3 and git, then a frozen install of this
# checkout, which installs the gbrain the package.json pins. On top of CI it installs Docker with the pgvector images
# for Postgres 15 and the current Postgres (18), starts both bound to 127.0.0.1, and clones gbrain with every release tag
# so the runner can build master, the previous night and old releases as verified copies (eval/runner/lifecycle/builds.ts).
#
# Nothing here reads, needs or forwards a provider key; the keyless suites run without one.
#
# Settings (environment): BUN_VERSION (default: the bun-version CI pins), GBRAIN_DIR (default ~/gbrain),
# NIGHTLY_PG_PORT (55432, Postgres 18) and NIGHTLY_PG15_PORT (55415, Postgres 15). The admin URLs it prints are
# postgres://postgres@127.0.0.1:<port>/postgres (trust authentication, loopback only).
set -euo pipefail
# ubi-runner runs a setup script from a copy in the VM's home, inside the synced checkout, so the checkout is the cwd.
REPO=$PWD
grep -q '"name": "gbrain-evals"' "$REPO/package.json" 2>/dev/null || { echo "nightly-vm: run this from the gbrain-evals checkout root" >&2; exit 1; }
CI_BUN=$(sed -n 's/^ *bun-version: *\([0-9.]*\).*/\1/p' .github/workflows/ci.yml | head -1)
BUN_VERSION=${BUN_VERSION:-${CI_BUN:-1.4.4}}
GBRAIN_DIR=${GBRAIN_DIR:-$HOME/gbrain}
PG_PORT=${NIGHTLY_PG_PORT:-55432}
PG15_PORT=${NIGHTLY_PG15_PORT:-55415}
# pgvector images, pinned by digest (pulled 2026-11-09): Postgres 18, the newest with a pgvector image, and Postgres 15.
PG_IMAGE=pgvector/pgvector@sha256:c29f30688a9ad961691bdf0ec1650717cc132a5814619d80f80463d6e4c42e47
PG15_IMAGE=pgvector/pgvector@sha256:88164492558c9773a1e17a8305abaca7863e05b3d8bbcdb792774890a2047e06

# Downloads from GitHub and Docker Hub sometimes answer 5xx for a minute; each one is tried up to 5 times.
retry() { local n; for n in 1 2 3 4 5; do "$@" && return 0; echo "nightly-vm: attempt $n of 5 failed: $*" >&2; sleep $((n * 15)); done; return 1; }

retry sudo apt-get update -qq
retry sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io git curl unzip python3 ca-certificates >/dev/null
sudo systemctl enable --now docker
sudo chmod 666 /var/run/docker.sock

if [ "$(bun --version 2>/dev/null || true)" != "$BUN_VERSION" ]; then
  retry bash -c 'set -o pipefail; curl -fsSL https://bun.sh/install | bash -s "bun-v$1" >/dev/null' _ "$BUN_VERSION"
fi
export PATH="$HOME/.bun/bin:$PATH"
grep -q '.bun/bin' "$HOME/.profile" 2>/dev/null || echo 'export PATH="$HOME/.bun/bin:$PATH"' >> "$HOME/.profile"
[ "$(bun --version)" = "$BUN_VERSION" ] || { echo "nightly-vm: bun $(bun --version) is not the pinned $BUN_VERSION" >&2; exit 1; }

retry bun install --frozen-lockfile >/dev/null
# The QA suites' datasets, fetched at their pinned revisions and checked by SHA-256 (eval/runner/memory-qa/corpus.ts).
for b in lme-s beam-1m; do retry bun run eval:decide fetch --benchmark "$b" >/dev/null; done

if [ -d "$GBRAIN_DIR/.git" ]; then
  retry git -C "$GBRAIN_DIR" fetch -q --tags origin
else
  retry bash -c 'rm -rf "$1" && git clone -q https://github.com/garrytan/gbrain.git "$1"' _ "$GBRAIN_DIR"
fi

# A night's trials, smokes and agents share each server at once, which needs more clients than Postgres's default 100.
pgstart() { # name port image
  docker rm -f "$1" >/dev/null 2>&1 || true
  docker run -d --name "$1" --restart unless-stopped -p "127.0.0.1:$2:5432" -e POSTGRES_HOST_AUTH_METHOD=trust "$3" \
    -c max_connections=500 -c shared_buffers=512MB >/dev/null
}
retry docker pull -q "$PG_IMAGE" >/dev/null
retry docker pull -q "$PG15_IMAGE" >/dev/null
pgstart nightly-pg "$PG_PORT" "$PG_IMAGE"
pgstart nightly-pg15 "$PG15_PORT" "$PG15_IMAGE"
for c in nightly-pg nightly-pg15; do
  for _ in $(seq 1 60); do docker exec "$c" pg_isready -q -U postgres && break; sleep 1; done
  docker exec "$c" pg_isready -q -U postgres || { echo "nightly-vm: $c did not start" >&2; exit 1; }
  docker exec "$c" psql -qAt -U postgres -c 'CREATE EXTENSION IF NOT EXISTS vector' >/dev/null
done

echo "nightly-vm ready: $(nproc) vCPU, $(free -g | awk '/Mem:/{print $2}') GB, bun $(bun --version), $(docker --version | cut -d, -f1)"
echo "  gbrain-evals $(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo '(exported tree)'), pinned gbrain $(cat node_modules/gbrain/VERSION)"
echo "  gbrain clone $GBRAIN_DIR at master $(git -C "$GBRAIN_DIR" rev-parse --short origin/master) ($(git -C "$GBRAIN_DIR" show origin/master:VERSION)), $(git -C "$GBRAIN_DIR" tag | wc -l) tags"
echo "  postgres $(docker exec nightly-pg psql -qAt -U postgres -c 'SHOW server_version') at postgres://postgres@127.0.0.1:$PG_PORT/postgres"
echo "  postgres $(docker exec nightly-pg15 psql -qAt -U postgres -c 'SHOW server_version') at postgres://postgres@127.0.0.1:$PG15_PORT/postgres"
