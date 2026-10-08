#!/usr/bin/env bash
# VM bootstrap for an open-source memory shootout cell (docs/plans/2026-10-05-oss-memory-shootout/PLAN.md).
#
# Run from the repository root on a fresh Ubuntu 24.04 Ubicloud VM. Subcommands:
#
#   setup  [--system NAME] [--datasets locomo,lme-s,beam-100k] [--conversations id,id]
#          Once per VM (ubi-runner --setup): Docker with the compose plugin, Bun 1.3.14, `bun install --frozen-lockfile`,
#          the pinned datasets through `bun run eval:decide fetch` (each file checked against its SHA-256), and the
#          system's pinned images (`docker compose pull`, then `build` for the shim image). --conversations fetches
#          only those BEAM conversations' files (a dev smoke never downloads a sealed conversation).
#   proxy  --lease-id ID --lease-usd N [--max-output-tokens M] [--port 8787] [--out DIR]
#          Start the metering proxy for the cell's lease, detached, and wait for its status endpoint. A cell launched
#          by `bun eval/runner/shootout-cell.ts` already runs the proxy (SHOOTOUT_PROXY is set), so `up` skips this.
#   up     --system NAME [--config recipe|common] [--port 8700] [--proxy-port 8787] [--timeout 900]
#          Start the system's compose stack with SHIM_CONFIG, its egress relay pointed at the proxy on this host, and
#          the shim published on 127.0.0.1:PORT; wait for GET /health to answer {"ok": true}.
#   restart --system NAME [--port 8700] [--timeout 900]
#          Restart the stack's containers in place (`docker compose restart`): processes start fresh, volumes and
#          container file systems are kept. Waits for GET /health as `up` does. lifecycle-lite's restart checkpoint
#          runs it as its --restart-cmd.
#   down   --system NAME      Stop the stack and remove its volumes.
#   snapshot --system NAME --out TAR [--port 8700] [--timeout 900]
#          Stop the stack, tar every named volume of its compose project into TAR (one <volume>.tar per volume plus
#          volumes.json), write TAR.sha256, start the stack again and wait for GET /health. A Q1 shim cell's
#          snapshot_command runs it with --out "$SHOOTOUT_SNAPSHOT_DIR/<system>.tar" once ingest is complete.
#   restore --system NAME --from TAR [--config recipe|common] [--port 8700] [--timeout 900]
#          Check TAR against TAR.sha256 when present, create the stack without starting it, replace every named
#          volume's contents with the snapshot's, then start the stack and wait for GET /health. A Q1 shim cell's
#          restore_command runs it with --from "$SHOOTOUT_RESTORE_DIR/<system>.tar" before the cell command.
#
# A counted cell command therefore looks like:
#   bash eval/systems/bootstrap.sh up --system ext-extract-first --config common && \
#   bun eval/runner/memory-qa/run.ts --benchmark locomo --system http://127.0.0.1:8700 ... --output "$SHOOTOUT_OUT/mqa"; \
#   bash eval/systems/bootstrap.sh down --system ext-extract-first
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

cmd=${1:-}; shift || true
SYSTEM="" CONFIG=recipe PORT="" PROXY_PORT=8787 TIMEOUT=900 DATASETS="" CONVERSATIONS="" LEASE_ID="" LEASE_USD="" MAX_OUT="" OUT="" FROM=""
while [ $# -gt 0 ]; do
  case "$1" in
    --system) SYSTEM=$2; shift 2 ;;
    --config) CONFIG=$2; shift 2 ;;
    --port) PORT=$2; shift 2 ;;
    --proxy-port) PROXY_PORT=$2; shift 2 ;;
    --timeout) TIMEOUT=$2; shift 2 ;;
    --datasets) DATASETS=$2; shift 2 ;;
    --conversations) CONVERSATIONS=$2; shift 2 ;;
    --lease-id) LEASE_ID=$2; shift 2 ;;
    --lease-usd) LEASE_USD=$2; shift 2 ;;
    --max-output-tokens) MAX_OUT=$2; shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    --from) FROM=$2; shift 2 ;;
    *) die "unknown argument $1" ;;
  esac
done

compose_file() {
  [ -n "$SYSTEM" ] || die "--system is required"
  local f="eval/systems/$SYSTEM/docker-compose.yml"
  # External systems' install bundles live beside the comparison page that names them (docs/comparison-systems.md);
  # the harness addresses them by kind id (eval/systems/kinds.json).
  [ -f "$f" ] || f="docs/comparison-systems/$SYSTEM/docker-compose.yml"
  [ -f "$f" ] || die "no compose file for system $SYSTEM (looked in eval/systems/$SYSTEM and docs/comparison-systems/$SYSTEM); kind ids are listed in eval/systems/kinds.json"
  echo "$f"
}

# The stacks name their relay settings differently: the extract-first server and the Markdown knowledge base read
# PROXY_UPSTREAM and PROXY_SLOT (and would take PROXY_URL as their in-network base URL), the temporal graph library and
# the memory-bank server read PROXY_URL and PROXY_OPENAI_PATH, the graph pipeline and the agent runtime read
# PROXY_HOSTPORT and PROXY_OPENAI_PATH. Every stack's provider calls arrive on the proxy slot
# named after the system, which the harness binds to each question for attribution.
compose_env() {
  export SHIM_CONFIG="$CONFIG" SHIM_HOST_PORT="${PORT:-8700}" PROXY_SLOT="$SYSTEM"
  export PROXY_UPSTREAM="host.docker.internal:$PROXY_PORT" PROXY_HOSTPORT="host.docker.internal:$PROXY_PORT"
  export PROXY_OPENAI_PATH="/$SYSTEM/openai/v1" PROXY_ANTHROPIC_PATH="/$SYSTEM/anthropic"
  case "$SYSTEM" in
    ext-temporal-graph|ext-memory-bank) export PROXY_URL="http://host.docker.internal:$PROXY_PORT" ;;
    *) unset PROXY_URL ;;
  esac
}

# Wait until the shim on SHIM_HOST_PORT answers GET /health with {"ok": true}, or fail with the stack's last logs.
wait_healthy() {
  local f=$1 deadline=$(( $(date +%s) + TIMEOUT ))
  until curl -sf "http://127.0.0.1:$SHIM_HOST_PORT/health" | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("ok") is True else 1)' 2>/dev/null; do
    [ "$(date +%s)" -lt "$deadline" ] || { compose -f "$f" logs --tail 50 >&2; die "$SYSTEM did not report healthy within ${TIMEOUT}s"; }
    sleep 2
  done
  curl -sf "http://127.0.0.1:$SHIM_HOST_PORT/health"; echo
}

# Compose interpolates the caller's environment: never let the cell's own base URLs or keys reach a container. The cell
# token (SHOOTOUT_CELL_TOKEN, set by the launcher) does pass: the stacks present it as their dummy provider key, so the
# strict lease proxy admits their calls.
compose() { env -u OPENAI_BASE_URL -u ANTHROPIC_BASE_URL -u VOYAGE_BASE_URL -u OPENAI_API_KEY -u ANTHROPIC_API_KEY -u VOYAGE_API_KEY bash -c 'if docker info >/dev/null 2>&1; then exec docker compose "$@"; else exec sudo -E docker compose "$@"; fi' compose "$@"; }
dock() { if docker info >/dev/null 2>&1; then docker "$@"; else sudo docker "$@"; fi; }

# The image that tars volumes: the pinned egress relay image every stack already pulls (busybox tar).
SNAPSHOT_IMAGE=${SNAPSHOT_IMAGE:-alpine/socat:1.8.0.3@sha256:beb4a68d9e4fe6b0f21ea774a0fde6c31f580dde6368939ed70100c5385b015e}

# "<volume key> <docker volume name>" for every named volume of the stack's compose project.
stack_volumes() {
  local f=$1 project key
  project=$(compose -f "$f" config --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)["name"])')
  for key in $(compose -f "$f" config --volumes); do
    echo "$key $(dock volume ls -q --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.volume=$key" | head -1)"
  done
}
sha_of() { sha256sum "$1" | cut -d' ' -f1; }

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
      bun run eval:decide fetch --benchmark "$b" ${CONVERSATIONS:+--conversations "$CONVERSATIONS"}
    done
    if [ -n "$SYSTEM" ] && [ "$SYSTEM" != gbrain ]; then
      f=$(compose_file)
      compose_env
      log "pulling pinned images for $SYSTEM"
      compose -f "$f" pull --ignore-buildable --quiet
      compose -f "$f" build --quiet
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
    compose -f "$f" up -d
    wait_healthy "$f"
    ;;

  restart)
    f=$(compose_file)
    compose_env
    log "restarting $SYSTEM in place (volumes and container file systems kept)"
    compose -f "$f" restart
    wait_healthy "$f"
    ;;

  down)
    f=$(compose_file)
    compose_env
    compose -f "$f" down -v
    ;;

  snapshot)
    [ -n "$OUT" ] || die "snapshot needs --out <tar>"
    f=$(compose_file)
    compose_env
    work=$(mktemp -d)
    # A failed snapshot still starts the stack again, so the cell's remaining questions see a running system.
    trap 'rc=$?; rm -rf "$work"; [ $rc -eq 0 ] || compose -f "$f" start >/dev/null 2>&1 || true' EXIT
    log "stopping $SYSTEM to snapshot its volumes"
    compose -f "$f" stop
    echo '{"system": "'"$SYSTEM"'", "volumes": [' > "$work/volumes.json"
    sep=""
    while read -r key vol; do
      [ -n "$vol" ] || die "volume $key of $SYSTEM does not exist (is the stack up?)"
      dock run --rm --network none -v "$vol:/v:ro" -v "$work:/out" --entrypoint tar "$SNAPSHOT_IMAGE" -C /v -cf "/out/$key.tar" .
      printf '%s{"key": "%s", "sha256": "%s"}' "$sep" "$key" "$(sha_of "$work/$key.tar")" >> "$work/volumes.json"
      sep=", "
    done < <(stack_volumes "$f")
    echo ']}' >> "$work/volumes.json"
    mkdir -p "$(dirname "$OUT")"
    tar -C "$work" -cf "$OUT" .
    sha_of "$OUT" > "$OUT.sha256"
    log "snapshot $OUT sha256 $(cat "$OUT.sha256")"
    compose -f "$f" start
    wait_healthy "$f"
    ;;

  restore)
    [ -n "$FROM" ] && [ -f "$FROM" ] || die "restore needs --from <tar> naming an existing snapshot"
    f=$(compose_file)
    compose_env
    if [ -f "$FROM.sha256" ] && [ "$(sha_of "$FROM")" != "$(cat "$FROM.sha256")" ]; then die "$FROM does not match $FROM.sha256; the snapshot is damaged"; fi
    work=$(mktemp -d)
    trap 'rm -rf "$work"' EXIT
    tar -C "$work" -xf "$FROM"
    [ -f "$work/volumes.json" ] || die "$FROM is not a bootstrap.sh snapshot (no volumes.json)"
    compose -f "$f" up --no-start
    compose -f "$f" stop
    while read -r key vol; do
      [ -f "$work/$key.tar" ] || die "the snapshot has no volume $key"
      [ "$(sha_of "$work/$key.tar")" = "$(python3 -c 'import json,sys; print(next(v["sha256"] for v in json.load(open(sys.argv[1]))["volumes"] if v["key"] == sys.argv[2]))' "$work/volumes.json" "$key")" ] || die "volume $key does not match its recorded sha256"
      dock run --rm --network none -v "$vol:/v" -v "$work:/in:ro" --entrypoint sh "$SNAPSHOT_IMAGE" -c "find /v -mindepth 1 -delete && tar -C /v -xf /in/$key.tar"
    done < <(stack_volumes "$f")
    log "restored $SYSTEM from $FROM; starting it"
    compose -f "$f" up -d
    wait_healthy "$f"
    ;;

  *)
    sed -n '2,37p' "$0" >&2
    exit 2
    ;;
esac
