#!/usr/bin/env bash
# The preregistered paired repeat for a suspected Cat 7 latency regression: three Cat 7 runs on a fresh VM.
set -u
export PATH="$HOME/.bun/bin:$PATH"
OUT="$HOME/out"; mkdir -p "$OUT"
git rev-parse HEAD > "$OUT/tree.txt"; grep '"gbrain"' package.json >> "$OUT/tree.txt"; grep '"version"' node_modules/gbrain/package.json >> "$OUT/tree.txt"
for i in 1 2 3; do
  bun eval/runner/perf.ts > "$OUT/perf-$i.log" 2>&1; echo $? > "$OUT/perf-$i.exit"
  cp eval/reports/perf/receipt.json "$OUT/perf-$i.json"
done
for i in 1 2 3; do bun docs/benchmarks/2026-10-03-wave8-f1-repin/repros/cat7-get-timeline-1k.ts >> "$OUT/cat7-1-repro.jsonl" 2>>"$OUT/cat7-1-repro.err"; echo "exit $?" >> "$OUT/cat7-1-repro.jsonl"; done
