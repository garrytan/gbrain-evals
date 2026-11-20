#!/usr/bin/env bash
# One step of the LongMemEval run on Redis's harness, on the run VM (after vm-setup.sh).
#
#   vm-stage.sh <step> [KEY_NAME ...]    key values arrive on stdin, one per line, in the order named
#
# It reads the keys, then restarts itself detached in its own session, so the ssh call returns at once.
# Keys live only in the step's process environment, never on disk. Each step logs to ~/lme-state/logs/<step>.log and
# writes ~/lme-state/logs/<step>.exit when it ends. Voyage goes only through the metering proxy, which holds the real key
# and reserves every request in the stage's budget run; the gbrain adapter gets a proxy token.
set -uo pipefail
step=$1; shift
for name in "$@"; do IFS= read -r value; export "$name=$value"; done
if [ -z "${LME_STAGE_DETACHED:-}" ]; then
  mkdir -p "$HOME/lme-state/logs"; rm -f "$HOME/lme-state/logs/$step.exit"
  LME_STAGE_DETACHED=1 setsid -f bash "$0" "$step" </dev/null >/dev/null 2>&1
  echo "started $step; log ~/lme-state/logs/$step.log"; exit 0
fi
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
export LME_REDIS_STATE_DIR="$HOME/lme-state"
export LME_REDIS_MANIFEST_DIR="$HOME/lme-state/manifests"
LEDGER="$LME_REDIS_STATE_DIR/ledger.sqlite"
LOGS="$LME_REDIS_STATE_DIR/logs"; mkdir -p "$LOGS"
CACHE="$HOME/lme-cache"
DRV="bun $REPO/eval/runner/batch/lme-redis.ts"
PY="uv run -q --project $REPO/eval/redis-agent-memory-benchmark python $REPO/eval/runner/lme-redis/lme_redis.py"
BATCH_ARMS="gpt4o--off gpt4o--on gpt4o--agent-default gpt4o--full gpt4o--oracle opus--off opus--on opus--full opus--oracle sol--off sol--on sol--full sol--oracle"

only_env() {  # only_env "NAMES" CMD...: runs CMD with just the named variables, none of them on a command line
  local keep=" $1 " v; shift
  for v in $(compgen -e); do [[ $keep == *" $v "* ]] || unset "$v"; done
  exec "$@"
}
voyage_up() {  # starts the metering proxy and the gbrain adapter for stage $1
  local run_id; run_id=$(python3 -c "import json;print(json.load(open('$LME_REDIS_STATE_DIR/runs.json'))['$1'])")
  rm -f "$LME_REDIS_STATE_DIR/proxy-ready.json"
  (only_env "HOME PATH VOYAGE_API_KEY" bun "$REPO/eval/runner/harness-metering-proxy.ts" --budget-ledger "$LEDGER" --budget-run-id "$run_id" \
    --cell-id "lme-redis-$1" --labels gbrain --ready-file "$LME_REDIS_STATE_DIR/proxy-ready.json" --request-log "$LME_REDIS_STATE_DIR/proxy-$1.jsonl" \
    --bodies-dir "$LME_REDIS_STATE_DIR/proxy-bodies") > "$LOGS/proxy-$1.log" 2>&1 &
  PROXY_PID=$!
  for _ in $(seq 60); do [ -s "$LME_REDIS_STATE_DIR/proxy-ready.json" ] && break; sleep 1; done
  local base token
  base=$(python3 -c "import json;print(json.load(open('$LME_REDIS_STATE_DIR/proxy-ready.json'))['base_urls']['voyage'])")
  token=$(python3 -c "import json;print(json.load(open('$LME_REDIS_STATE_DIR/proxy-ready.json'))['env']['gbrain']['VOYAGE_API_KEY'])")
  mkdir -p "$HOME/gbhome/.gbrain"
  printf '{"embedding_model":"voyage:voyage-4","embedding_dimensions":1024,"provider_base_urls":{"voyage":"%s"}}\n' "$base" > "$HOME/gbhome/.gbrain/config.json"
  (export GBRAIN_HOME="$HOME/gbhome" GBRAIN_SRC="$HOME/gbrain/src" VOYAGE_API_KEY="$token" LME_REDIS_PORT=8787
   only_env "HOME PATH GBRAIN_HOME GBRAIN_SRC VOYAGE_API_KEY LME_REDIS_PORT" bun "$REPO/eval/runner/lme-redis/gbrain-server.ts") > "$LOGS/server-$1.log" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 60); do curl -sf 127.0.0.1:8787/ >/dev/null && break; sleep 1; done
  unset VOYAGE_API_KEY
}
voyage_down() { kill "$SERVER_PID" 2>/dev/null; kill -TERM "$PROXY_PID" 2>/dev/null; wait "$PROXY_PID" 2>/dev/null; }

run() {
  case "$step" in
    init)
      bun "$REPO/eval/runner/budget-ledger.ts" init --budget-ledger "$LEDGER" --program-cap-usd "$PROGRAM_CAP" --reason "GBEV-113 LongMemEval on Redis's harness (GST-3250)"
      $DRV open-stage judge-check --budget-ledger "$LEDGER" --budget-usd "$JUDGE_CHECK_CAP"
      $DRV open-stage pilot --budget-ledger "$LEDGER" --budget-usd "$PILOT_CAP" ;;
    freeze)
      voyage_up pilot
      (cd "$REPO/eval/redis-agent-memory-benchmark" && $PY freeze --cache-dir "$CACHE" --out "$LME_REDIS_STATE_DIR/frozen" --server-url http://127.0.0.1:8787 --concurrency "${CONCURRENCY:-6}")
      rc=$?; voyage_down
      [ $rc = 0 ] && $DRV build --frozen "$LME_REDIS_STATE_DIR/frozen" ;;
    parity)
      voyage_up pilot
      (cd "$REPO/eval/redis-agent-memory-benchmark" && $PY parity --cache-dir "$CACHE" --frozen "$LME_REDIS_STATE_DIR/frozen" --out "$LME_REDIS_STATE_DIR/parity" --server-url http://127.0.0.1:8787 --limit 3)
      rc=$?; voyage_down; return $rc ;;
    controls)
      (cd "$REPO/eval/redis-agent-memory-benchmark" && $PY controls --cache-dir "$CACHE" --out "$LME_REDIS_STATE_DIR/controls.jsonl") || return 1
      for j in protocol opus astra; do $DRV judge-controls $j --controls "$LME_REDIS_STATE_DIR/controls.jsonl" --stage judge-check --budget-ledger "$LEDGER" || return 1; done ;;
    pilot)
      for a in $BATCH_ARMS; do $DRV run "$a" --stage pilot --ids pilot --budget-ledger "$LEDGER" || return 1; done ;;
    judges)
      for a in $BATCH_ARMS ${EXTRA_ARMS:-}; do for role in protocol cross; do $DRV judge "$a" "$role" --stage pilot --ids pilot --budget-ledger "$LEDGER" --cache-dir "$CACHE" || return 1; done; done ;;
    particle)
      for m in off on full oracle; do $DRV particle "particle--$m" --stage pilot --ids pilot --budget-ledger "$LEDGER" || return 1; done ;;
    label)
      for j in opus astra; do $DRV label $j --stage pilot --ids pilot --budget-ledger "$LEDGER" || return 1; done ;;
    archive-pilot)  # before the counted wave: no pilot answer counts, so pilot answers and the pilot freeze move aside
      local A="$LME_REDIS_STATE_DIR/pilot-archive"
      [ -e "$A" ] && { echo "$A already exists" >&2; return 1; }
      mkdir -p "$A/manifests" "$A/bodies"
      cp "$LME_REDIS_STATE_DIR/batch-state.sqlite" "$A/" || return 1
      python3 -c "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('DELETE FROM results'); c.execute('DELETE FROM intents'); c.commit()" "$LME_REDIS_STATE_DIR/batch-state.sqlite" || return 1
      for d in frozen particle judge-messages labels answers report parity; do [ -e "$LME_REDIS_STATE_DIR/$d" ] && mv "$LME_REDIS_STATE_DIR/$d" "$A/"; done
      for f in "$LME_REDIS_MANIFEST_DIR"/*--*.json; do case $(basename "$f") in controls--*) ;; *) mv "$f" "$A/manifests/" ;; esac; done
      [ -e "$LME_REDIS_MANIFEST_DIR/reuse.json" ] && mv "$LME_REDIS_MANIFEST_DIR/reuse.json" "$A/manifests/"
      for f in "$LME_REDIS_STATE_DIR"/bodies/*.ndjson.gz; do case $(basename "$f") in controls--*) ;; *) mv "$f" "$A/bodies/" ;; esac; done
      cp "$LME_REDIS_STATE_DIR/order.json" "$A/" ;;
    poll)
      $DRV poll --stage "${STAGE:-pilot}" --budget-ledger "$LEDGER" ;;
    *) echo "unknown step $step" >&2; return 2 ;;
  esac
}
run > "$LOGS/$step.log" 2>&1
echo $? > "$LOGS/$step.exit"
