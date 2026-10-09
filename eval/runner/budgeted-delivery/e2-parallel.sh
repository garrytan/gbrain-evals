#!/usr/bin/env bash
# Run one memory-qa command as N conversation shards in parallel, for the budgeted delivery E2 cells
# (docs/benchmarks/2026-10-09-gbrain-budgeted-delivery-e2-preregistration.md). Each shard gets `--shard i/N`, its own
# `--output <dir>/shard-i`, its own log beside it, and its own embedding cache outside <dir> (never pulled). The
# gbrain overlay named by `--gbrain` is built once before the shards start, so they never race to build it.
# Exits non-zero when any shard does. E2_PARALLEL_MAX caps how many shards run at once (default all N): a reader replay
# holds about 2.5 GB, so a 16 GB host runs four at a time.
#
#   bash eval/runner/budgeted-delivery/e2-parallel.sh <N> <dir> -- <run.ts arguments without --shard and --output>
set -uo pipefail
N=$1 DIR=$2
shift 2
[ "${1:-}" = "--" ] && shift
mkdir -p "$DIR"
GB=""
for ((k = 1; k <= $#; k++)); do [ "${!k}" = "--gbrain" ] && { j=$((k + 1)); GB=${!j}; }; done
if [ -n "$GB" ]; then
  GBRAIN_SPEC="$GB" bun -e 'import { resolveGbrainUnderTest } from "./eval/runner/gbrain-under-test.ts"; console.error(`[e2-parallel] overlay ${resolveGbrainUnderTest(process.env.GBRAIN_SPEC!).root}`)' || exit 1
fi
CACHE=${GBRAIN_EVALS_EMBED_CACHE_ROOT:-$HOME/.cache/gbrain-evals/e2-embed}
MAX=${E2_PARALLEL_MAX:-$N}
pids=()
for ((i = 0; i < N; i++)); do
  while [ "$(jobs -rp | wc -l)" -ge "$MAX" ]; do wait -n || true; done
  GBRAIN_EVALS_EMBED_CACHE="$CACHE/$(basename "$DIR")-shard-$i" bun eval/runner/memory-qa/run.ts "$@" --shard "$i/$N" --output "$DIR/shard-$i" > "$DIR/shard-$i.log" 2>&1 &
  pids+=($!)
done
rc=0
for i in "${!pids[@]}"; do
  if ! wait "${pids[$i]}"; then rc=1; echo "[e2-parallel] shard $i/$N failed; see $DIR/shard-$i.log" >&2; tail -5 "$DIR/shard-$i.log" >&2; fi
done
echo "[e2-parallel] $DIR: $N shards, exit $rc" >&2
exit $rc
