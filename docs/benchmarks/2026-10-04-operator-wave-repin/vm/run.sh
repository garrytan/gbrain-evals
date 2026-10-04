#!/usr/bin/env bash
# Runs on each VM from the checkout root, with no provider key in the environment:
# the offline tier (Cat 34 against the installed gbrain package), N12 at seed 7, every ledger repro,
# the wave 8 + Foundations 1 checks and three runs of the Cat7-1 repro. Output goes to ~/out.
set -u
export PATH="$HOME/.bun/bin:$PATH"
OUT="$HOME/out"; mkdir -p "$OUT"
D=docs/benchmarks/2026-10-04-operator-wave-repin
git rev-parse HEAD > "$OUT/tree.txt"; git status --porcelain >> "$OUT/tree.txt"
grep '"gbrain"' package.json >> "$OUT/tree.txt"; grep '"version"' node_modules/gbrain/package.json >> "$OUT/tree.txt"
nproc >> "$OUT/tree.txt"; bun --version >> "$OUT/tree.txt"
GBRAIN_REPO="$PWD/node_modules/gbrain" bun eval/runner/all.ts --tier offline > "$OUT/offline-tier.log" 2>&1; echo $? > "$OUT/offline-tier.exit"
cp -r eval/reports "$OUT/reports"
bun eval/runner/n12-format-fidelity.ts --seed 7 --output "$OUT/n12-seed7" > "$OUT/n12-seed7.log" 2>&1; echo $? > "$OUT/n12-seed7.exit"
bun "$D/run-repros.ts" docs/benchmarks/2026-10-03-wave8-f1-repin/repros-109b992.txt "$OUT/repros.txt" \
  "bun docs/benchmarks/2026-10-03-wave8-f1-repin/repros/cat7-get-timeline-1k.ts" > "$OUT/repros.log" 2>&1
bun docs/benchmarks/2026-10-03-wave8-f1-repin/checks/run-all.ts "$OUT/checks-w8f1.json" > "$OUT/checks-w8f1.log" 2>&1; echo $? > "$OUT/checks-w8f1.exit"
for i in 1 2 3; do bun docs/benchmarks/2026-10-03-wave8-f1-repin/repros/cat7-get-timeline-1k.ts >> "$OUT/cat7-1-repro.jsonl" 2>>"$OUT/cat7-1-repro.err"; echo "exit $?" >> "$OUT/cat7-1-repro.jsonl"; done
echo done > "$OUT/DONE"
