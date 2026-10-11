#!/usr/bin/env bash
# Amendment 3 (preregistration): on one VM, steps 9 and 10 and the operator-wave checks at both pins with the N6-5
# and E2 fixes, then Cat 7 and the
# Cat7-1 repro interleaved between the pins on the same host. Run from the after checkout with the before
# checkout's path as $1; both are this tree and differ only in package.json and bun.lock. Output goes to ~/out.
set -u
export PATH="$HOME/.bun/bin:$PATH"
for k in ANTHROPIC_API_KEY OPENAI_API_KEY VOYAGE_API_KEY GROQ_API_KEY OPENROUTER_API_KEY TYPESAFE_API_KEY JEV_TYPESAFE_API_KEY; do unset "$k"; done
declare -A DIR=([after]="$PWD" [before]="$(cd "$1" && pwd)")
W=docs/benchmarks/2026-10-03-wave8-f1-repin
PG_IMG=pgvector/pgvector:pg16
sudo chmod 666 /var/run/docker.sock
pgstart() { sudo docker rm -f "$1" >/dev/null 2>&1; sudo docker run -d --name "$1" -p "127.0.0.1:$2:5432" -e POSTGRES_HOST_AUTH_METHOD=trust "$PG_IMG" >/dev/null
  for _ in $(seq 60); do sudo docker exec "$1" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done; sleep 2; }
for side in before after; do
  OUT="$HOME/out/$side"; mkdir -p "$OUT"; cd "${DIR[$side]}"
  git rev-parse HEAD > "$OUT/tree.txt"; git status --porcelain >> "$OUT/tree.txt"
  grep '"gbrain"' package.json >> "$OUT/tree.txt"; grep '"version"' node_modules/gbrain/package.json >> "$OUT/tree.txt"
  nproc >> "$OUT/tree.txt"; bun --version >> "$OUT/tree.txt"; grep -m1 'model name' /proc/cpuinfo >> "$OUT/tree.txt"
  pgstart n6-pg 55442
  bun eval/runner/n6-postgres-http.ts --pg-url postgres://postgres@127.0.0.1:55442/postgres \
    --attest docs/benchmarks/2026-10-06-n6-postgres-http-preregistration.md --output "$OUT/n6pg" > "$OUT/n6pg.log" 2>&1; echo $? > "$OUT/n6pg.exit"
  bun eval/runner/n6-postgres-http.ts --control-remote-private-pages --only get_page,search,list_pages --output "$OUT/n6pg-control" > "$OUT/n6pg-control.log" 2>&1; echo $? > "$OUT/n6pg-control.exit"
  sudo docker rm -f n6-pg >/dev/null 2>&1
  bun eval/runner/n8-proactive-recall.ts --attest docs/benchmarks/2026-10-06-n8-privacy-gate-preregistration.md --output "$OUT/n8-attest" > "$OUT/n8-attest.log" 2>&1; echo $? > "$OUT/n8-attest.exit"
  bun eval/runner/n6-visibility-fuzz.ts --attest docs/benchmarks/2026-10-06-n8-privacy-gate-preregistration.md --output "$OUT/n6-attest" > "$OUT/n6-attest.log" 2>&1; echo $? > "$OUT/n6-attest.exit"
  bun docs/benchmarks/2026-10-04-operator-wave-repin/checks/run-all.ts "$OUT/checks-aow.json" > "$OUT/checks-aow.log" 2>&1; echo $? > "$OUT/checks-aow.exit"
done
for i in 1 2 3; do
  if [ $((i % 2)) -eq 1 ]; then order="before after"; else order="after before"; fi
  for side in $order; do
    OUT="$HOME/out/$side"; cd "${DIR[$side]}"
    bun eval/runner/perf.ts > "$OUT/perf-$i.log" 2>&1; echo $? > "$OUT/perf-$i.exit"
    cp eval/reports/perf/receipt.json "$OUT/perf-$i.json"
    bun "$W/repros/cat7-get-timeline-1k.ts" >> "$OUT/cat7-1-repro.jsonl" 2>>"$OUT/cat7-1-repro.err"; echo "exit $?" >> "$OUT/cat7-1-repro.jsonl"
  done
done
echo done > "$HOME/out/DONE"
