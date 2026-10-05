#!/usr/bin/env bash
# VM bootstrap for an open-source memory shootout cell (docs/plans/2026-10-05-oss-memory-shootout/PLAN.md).
#
# Run from the repository root on a fresh Ubuntu 24.04 Ubicloud VM. Subcommands:
#
#   setup  [--system NAME] [--datasets locomo,lme-s,beam-100k]
#          Once per VM (ubi-runner --setup): Docker with the compose plugin, Bun 1.3.14, `bun install --frozen-lockfile`,
#          the pinned datasets through `bun run eval:decide fetch` (each file checked against its SHA-256), and the
#          system's pinned images (`docker compose pull`, then `build` for the shim image).
#   proxy  --lease-id ID --lease-usd N [--max-output-tokens M] [--port 8787] [--out DIR]
#          Start the metering proxy for the cell's lease, detached, and wait for its status endpoint. A cell launched
#          by `bun eval/runner/shootout-cell.ts` already runs the proxy (SHOOTOUT_PROXY is set), so `up` skips this.
#   up     --system NAME [--config recipe|common] [--port 8700] [--proxy-port 8787] [--timeout 900]
#          Start the system's compose stack with SHIM_CONFIG, its egress relay pointed at the proxy on this host, and
#          the shim published on 127.0.0.1:PORT; wait for GET /health to answer {"ok": true}.
#   down   --system NAME      Stop the stack and remove its volumes.
#
# A counted cell command therefore looks like:
#   bash eval/systems/bootstrap.sh up --system mem0 --config common && \
#   bun eval/runner/memory-qa/run.ts --benchmark locomo --system http://127.0.0.1:8700 ... --output "$SHOOTOUT_OUT/mqa"; \
#   bash eval/systems/bootstrap.sh down --system mem0
#
# The proxy alone holds provider keys. Containers get a dummy key and reach the proxy only through their compose
# egress relay; the three relay variables the vendor stacks use (PROXY_UPSTREAM, PROXY_HOSTPORT, PROXY_URL) are all
# set here so every stack points at the same proxy.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
BUN_VERSION=1.3.14
die() { echo "bootstrap: $*" >&2; exit 1; }
log() { echo "bootstrap: $*" >&2; }
docker_cmd() { if docker info >/dev/null 2>&1; then docker "$@"; else sudo docker "$@"; fi; }

cmd=${1:-}; shift || true
SYSTEM="" CONFIG=recipe PORT="" PROXY_PORT=8787 TIMEOUT=900 DATASETS="" LEASE_ID="" LEASE_USD="" MAX_OUT="" OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --system) SYSTEM=$2; shift 2 ;;
    --config) CONFIG=$2; shift 2 ;;
    --port) PORT=$2; shift 2 ;;
    --proxy-port) PROXY_PORT=$2; shift 2 ;;
    --timeout) TIMEOUT=$2; shift 2 ;;
    --datasets) DATASETS=$2; shift 2 ;;
    --lease-id) LEASE_ID=$2; shift 2 ;;
    --lease-usd) LEASE_USD=$2; shift 2 ;;
    --max-output-tokens) MAX_OUT=$2; shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    *) die "unknown argument $1" ;;
  esac
done

compose_file() {
  [ -n "$SYSTEM" ] || die "--system is required"
  local f="eval/systems/$SYSTEM/docker-compose.yml"
  [ -f "$f" ] || die "no compose file for system $SYSTEM ($f)"
  echo "$f"
}

compose_env() {
  export SHIM_CONFIG="$CONFIG" SHIM_HOST_PORT="${PORT:-8700}"
  export PROXY_UPSTREAM="host.docker.internal:$PROXY_PORT" PROXY_HOSTPORT="host.docker.internal:$PROXY_PORT" PROXY_URL="http://host.docker.internal:$PROXY_PORT"
}

case "$cmd" in
  setup)
    if ! command -v docker >/dev/null 2>&1; then
      log "installing Docker"
      sudo apt-get update -qq >/dev/null
      sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io docker-compose-v2 unzip curl python3 >/dev/null
      sudo usermod -aG docker "$(id -un)"
    fi
    if ! command -v bun >/dev/null 2>&1 || [ "$(bun --version)" != "$BUN_VERSION" ]; then
      log "installing Bun $BUN_VERSION"
      command -v unzip >/dev/null 2>&1 || { sudo apt-get update -qq >/dev/null; sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq unzip curl >/dev/null; }
      curl -fsSL https://bun.sh/install | bash -s "bun-v$BUN_VERSION" >/dev/null
      grep -q '.bun/bin' ~/.profile 2>/dev/null || echo 'export PATH=$HOME/.bun/bin:$PATH' >> ~/.profile
      export PATH="$HOME/.bun/bin:$PATH"
    fi
    bun install --frozen-lockfile
    for b in ${DATASETS//,/ }; do
      log "dataset $b (pinned revision, SHA-256 checked)"
      bun run eval:decide fetch --benchmark "$b"
    done
    if [ -n "$SYSTEM" ] && [ "$SYSTEM" != gbrain ]; then
      f=$(compose_file)
      compose_env
      log "pulling pinned images for $SYSTEM"
      docker_cmd compose -f "$f" pull --ignore-buildable --quiet
      docker_cmd compose -f "$f" build --quiet
    fi
    log "setup done"
    ;;

  proxy)
    [ -n "$LEASE_ID" ] && [ -n "$LEASE_USD" ] || die "proxy needs --lease-id and --lease-usd"
    PROXY_PORT=${PORT:-$PROXY_PORT}
    OUT=${OUT:-eval/reports/shootout/proxy/$LEASE_ID}
    mkdir -p "$OUT"
    args=(eval/runner/metering-proxy.ts --listen "0.0.0.0:$PROXY_PORT" --budget-ledger "$OUT/lease.sqlite" --lease-usd "$LEASE_USD" --run-id "$LEASE_ID" --usage-log "$OUT/usage.ndjson")
    [ -z "$MAX_OUT" ] || args+=(--max-output-tokens "$MAX_OUT")
    setsid bun "${args[@]}" >"$OUT/proxy.log" 2>&1 < /dev/null &
    echo $! > "$OUT/proxy.pid"
    for _ in $(seq 1 200); do curl -sf "http://127.0.0.1:$PROXY_PORT/__proxy/status" >/dev/null && break; sleep 0.1; done
    curl -sf "http://127.0.0.1:$PROXY_PORT/__proxy/status" || die "the metering proxy did not start (see $OUT/proxy.log)"
    echo
    ;;

  up)
    f=$(compose_file)
    compose_env
    if [ -n "${SHOOTOUT_PROXY:-}" ]; then PROXY_PORT=${SHOOTOUT_PROXY##*:}; compose_env; fi
    curl -sf "http://127.0.0.1:$PROXY_PORT/__proxy/status" >/dev/null || die "no metering proxy on port $PROXY_PORT; start one with: bash eval/systems/bootstrap.sh proxy --lease-id ... --lease-usd ..."
    log "starting $SYSTEM ($CONFIG) with the shim on 127.0.0.1:$SHIM_HOST_PORT"
    docker_cmd compose -f "$f" up -d
    deadline=$(( $(date +%s) + TIMEOUT ))
    until curl -sf "http://127.0.0.1:$SHIM_HOST_PORT/health" | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("ok") is True else 1)' 2>/dev/null; do
      [ "$(date +%s)" -lt "$deadline" ] || { docker_cmd compose -f "$f" logs --tail 50 >&2; die "$SYSTEM did not report healthy within ${TIMEOUT}s"; }
      sleep 2
    done
    curl -sf "http://127.0.0.1:$SHIM_HOST_PORT/health"; echo
    ;;

  down)
    f=$(compose_file)
    compose_env
    docker_cmd compose -f "$f" down -v
    ;;

  *)
    sed -n '2,27p' "$0" >&2
    exit 2
    ;;
esac
