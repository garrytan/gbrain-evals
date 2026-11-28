#!/usr/bin/env bash
# run-one.sh <engine> <label> <outdir> [extra cat13 args...]
# Runs one cat13 gbrain-arm cell on the given engine and copies the receipt + report out of eval/reports.
set -u
engine=$1; label=$2; out=$(realpath -m "$3"); shift 3
# Map the installation key by name; never print it.
[ -n "${OPENAI_API_KEY:-}" ] || export OPENAI_API_KEY="${OPENAI_API_KEY__OPEN_AI_KEY:-}"
export PATH=$HOME/.cargo/bin:$HOME/.bun/bin:$PATH
EVALS_DIR=${EVALS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)}
export GBRAIN_RUST_ENGINE_ADDON=${GBRAIN_RUST_ENGINE_ADDON:-$EVALS_DIR/node_modules/gbrain/rust/target/addon/gbrain_engine.linux-x64-glibc.node}
cd "$EVALS_DIR"
# Isolate from the sandbox ~/.gbrain (it carries embedding_disabled=true, which turns hybridSearch keyword-only).
export GBRAIN_HOME=${BENCH_GBRAIN_HOME:-/var/tmp/bench-gbrain-home}; rm -rf "$GBRAIN_HOME"; mkdir -p "$GBRAIN_HOME"
rm -rf eval/reports/cat13-conceptual
mkdir -p "$out/$label"
GBRAIN_EVAL_ENGINE=$engine bun eval/runner/cat13-conceptual.ts --adapter gbrain \
  --pg-url "${BENCH_PG_URL:-postgres://postgres@127.0.0.1:55432/postgres}" "$@" > "$out/$label/stdout.log" 2>&1
rc=$?
echo "$rc" > "$out/$label/exit_code"
cp eval/reports/cat13-conceptual/*.json "$out/$label/" 2>/dev/null || true
echo "$engine $label EXIT=$rc"
exit $rc
