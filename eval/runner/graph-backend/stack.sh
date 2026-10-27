#!/usr/bin/env bash
# Container stack for the graph-backend benchmark (GBRA-123).
#
#   stack.sh pg-up          Postgres 17 (pgvector image), tuned by PG_SHARED_BUFFERS / PG_CACHE
#   stack.sh hydra-up       MinIO + HydraDB graph-node + graph-indexer (fresh store with HYDRA_FRESH=1)
#   stack.sh hydra-stop     stop HydraDB and MinIO (while a Postgres-only arm is timed)
#   stack.sh cold <pg|hydra> restart the server(s), empty HydraDB's local caches, drop the OS page cache
#   stack.sh stats          container memory, MinIO and cache directory sizes as JSON
#
# State lives under $GB_RUN (default ~/.capy/work/g123/run). HydraDB is used only
# through its own image built from hydra-db/hydradb; nothing is vendored.
set -euo pipefail
RUN=${GB_RUN:-$HOME/.capy/work/g123/run}
NET=gb
TOKEN=local-development-token-32-bytes-xx
PG_IMAGE=${PG_IMAGE:-pgvector/pgvector:pg17}
MINIO_IMAGE=${MINIO_IMAGE:-bitnamilegacy/minio:2025.7.23}
HYDRA_IMAGE=${HYDRA_IMAGE:-hydradb:local}
PG_SHARED_BUFFERS=${PG_SHARED_BUFFERS:-4GB}
PG_CACHE=${PG_CACHE:-10GB}
HYDRA_ENV=(
  -e CLOUD_PROVIDER=aws -e AWS_ACCESS_KEY_ID=benchadmin -e AWS_SECRET_ACCESS_KEY=benchadmin-secret -e AWS_DEFAULT_REGION=us-east-1
  -e AWS_ENDPOINT=${MINIO_ENDPOINT:-http://gb-minio:9000} -e AWS_BUCKET=hydra -e AWS_ALLOW_HTTP=true -e AWS_VIRTUAL_HOSTED_STYLE_REQUEST=false
  -e GRAPH_NAMESPACE=default -e GRAPH_ID=default -e GRAPH_CELL_ID=cell-0 -e GRAPH_CELLS=cell-0
  -e GRAPH_AUTH_TOKEN_FILE=/secrets/token -e RUST_MIN_STACK=33554432
)
NODE_ENV=(
  -e GRAPH_NODE_ID=node-0 -e GRAPH_BOLT_NODE_ADDRESSES=node-0=127.0.0.1:7687 -e GRAPH_ADVERTISED_BOLT_ADDR=127.0.0.1:7687
  -e GRAPH_DATA_CACHE_DIR=/var/cache/slatedb/data -e GRAPH_ALLOW_PLAINTEXT=true
  -e GRAPH_MAX_QUERY_SCAN_EDGES=${HYDRA_MAX_SCAN_EDGES:-1000000000}
  -e GRAPH_MAX_GRAPHBLAS_BYTES=${HYDRA_MAX_GRAPHBLAS_BYTES:-4294967296}
  -e GRAPH_INDEXER_NOTIFY_URL=http://gb-hydra-indexer:9091/v1/changes:process
)

net() { docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null; }
wait_http() { for _ in $(seq 1 120); do curl -sf "$1" >/dev/null && return 0; sleep 1; done; echo "timeout waiting for $1" >&2; return 1; }
drop_caches() { sync; sudo sh -c 'echo 3 > /proc/sys/vm/drop_caches'; }

pg_up() {
  net; mkdir -p "$RUN/pg"
  docker rm -f gb-pg >/dev/null 2>&1 || true
  docker run -d --name gb-pg --network "$NET" -p 5433:5432 -e POSTGRES_PASSWORD=bench -v "$RUN/pg:/var/lib/postgresql/data" "$PG_IMAGE" \
    -c shared_buffers="$PG_SHARED_BUFFERS" -c effective_cache_size="$PG_CACHE" -c work_mem=64MB -c maintenance_work_mem=1GB \
    -c max_connections=100 -c random_page_cost=1.1 -c jit=off >/dev/null
  for _ in $(seq 1 120); do docker exec gb-pg pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
  sleep 2
}

minio_up() {
  net; mkdir -p "$RUN/minio"; sudo chown -R 1001:1001 "$RUN/minio"
  docker rm -f gb-minio >/dev/null 2>&1 || true
  docker run -d --name gb-minio --network "$NET" -p 9000:9000 -v "$RUN/minio:/bitnami/minio/data" \
    -e MINIO_ROOT_USER=benchadmin -e MINIO_ROOT_PASSWORD=benchadmin-secret -e MINIO_DEFAULT_BUCKETS=hydra "$MINIO_IMAGE" >/dev/null
  wait_http http://127.0.0.1:9000/minio/health/live
}

hydra_containers() {
  mkdir -p "$RUN/hcache" "$RUN/icache" "$RUN/secrets"
  printf '%s\n' "$TOKEN" | sudo tee "$RUN/secrets/token" >/dev/null
  sudo chown -R 10001:10001 "$RUN/hcache" "$RUN/icache" "$RUN/secrets"
  docker rm -f gb-hydra gb-hydra-indexer >/dev/null 2>&1 || true
  docker run -d --name gb-hydra-indexer --network "$NET" --user 10001:10001 -v "$RUN/icache:/var/cache/slatedb" -v "$RUN/secrets:/secrets" \
    --entrypoint /usr/local/bin/graph-indexer "${HYDRA_ENV[@]}" -e GRAPH_INDEXER_ADMIN_ADDR=0.0.0.0:9091 -e GRAPH_INDEXER_BUILD_MODE=full "$HYDRA_IMAGE" >/dev/null
  docker run -d --name gb-hydra --network "$NET" --user 10001:10001 -p 8443:8443 -p 9090:9090 -v "$RUN/hcache:/var/cache/slatedb" -v "$RUN/secrets:/secrets" \
    "${HYDRA_ENV[@]}" "${NODE_ENV[@]}" "$HYDRA_IMAGE" >/dev/null
  wait_http http://127.0.0.1:9090/readyz
}

hydra_up() {
  if [[ "${HYDRA_FRESH:-0}" == 1 ]]; then
    docker rm -f gb-hydra gb-hydra-indexer gb-minio >/dev/null 2>&1 || true
    sudo rm -rf "$RUN/minio" "$RUN/hcache" "$RUN/icache"
  fi
  if [[ -z "${MINIO_ENDPOINT:-}" ]]; then minio_up; fi
  hydra_containers
}

case "${1:-}" in
  pg-up) pg_up ;;
  hydra-up) hydra_up ;;
  hydra-stop) docker stop gb-hydra gb-hydra-indexer gb-minio >/dev/null 2>&1 || true ;;
  cold)
    case "${2:-}" in
      pg) docker restart gb-pg >/dev/null; drop_caches; for _ in $(seq 1 120); do docker exec gb-pg pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done; sleep 1 ;;
      hydra)
        docker stop gb-hydra gb-hydra-indexer >/dev/null
        sudo sh -c "rm -rf '$RUN/hcache'/* '$RUN/icache'/*"
        if [[ -z "${MINIO_ENDPOINT:-}" ]]; then docker restart gb-minio >/dev/null; wait_http http://127.0.0.1:9000/minio/health/live; fi
        docker restart gb-pg >/dev/null
        drop_caches
        docker start gb-hydra-indexer gb-hydra >/dev/null
        wait_http http://127.0.0.1:9090/readyz
        for _ in $(seq 1 120); do docker exec gb-pg pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done ;;
      *) echo "cold pg|hydra" >&2; exit 2 ;;
    esac ;;
  stats)
    mem=$(docker stats --no-stream --format '{"name":"{{.Name}}","mem":"{{.MemUsage}}"}' 2>/dev/null | paste -sd, -)
    du_b() { sudo du -sb "$1" 2>/dev/null | cut -f1 || echo 0; }
    echo "{\"containers\":[$mem],\"minio_bytes\":$(du_b "$RUN/minio"),\"hydra_cache_bytes\":$(du_b "$RUN/hcache"),\"indexer_cache_bytes\":$(du_b "$RUN/icache"),\"pg_data_bytes\":$(du_b "$RUN/pg")}" ;;
  *) sed -n '2,12p' "$0"; exit 2 ;;
esac
