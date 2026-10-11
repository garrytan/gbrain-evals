#!/usr/bin/env bash
# Runs on each VM from the checkout root, with no provider key in the environment. Steps 1 to 6 are the
# 2026-10-06 re-pin's run.sh unchanged; 7 to 10 are this re-pin's additions (preregistration, "What runs").
# Output goes to ~/out.
set -u
export PATH="$HOME/.bun/bin:$PATH"
for k in ANTHROPIC_API_KEY OPENAI_API_KEY VOYAGE_API_KEY GROQ_API_KEY OPENROUTER_API_KEY TYPESAFE_API_KEY JEV_TYPESAFE_API_KEY; do unset "$k"; done
OUT="$HOME/out"; mkdir -p "$OUT"
D=docs/benchmarks/2026-10-06-followups-repin
W=docs/benchmarks/2026-10-03-wave8-f1-repin
git rev-parse HEAD > "$OUT/tree.txt"; git status --porcelain >> "$OUT/tree.txt"
grep '"gbrain"' package.json >> "$OUT/tree.txt"; grep '"version"' node_modules/gbrain/package.json >> "$OUT/tree.txt"
nproc >> "$OUT/tree.txt"; bun --version >> "$OUT/tree.txt"
# 1. offline tier
GBRAIN_REPO="$PWD/node_modules/gbrain" bun eval/runner/all.ts --tier offline > "$OUT/offline-tier.log" 2>&1; echo $? > "$OUT/offline-tier.exit"
cp -r eval/reports "$OUT/reports"
# 2. N12 at seed 7
bun eval/runner/n12-format-fidelity.ts --seed 7 --output "$OUT/n12-seed7" > "$OUT/n12-seed7.log" 2>&1; echo $? > "$OUT/n12-seed7.exit"
# 3. ledger repros: the 27 of 109b992, Cat7-1, N1-7
bun "$D/run-repros.ts" "$W/repros-109b992.txt" "$OUT/repros.txt" \
  "bun $W/repros/cat7-get-timeline-1k.ts" "bun $D/repros/n1-7-sweep-fences-ontology.ts" > "$OUT/repros.log" 2>&1
# 4. wave 8 + Foundations 1 checks, 5. operator-wave checks and the consented embed variant
bun "$W/checks/run-all.ts" "$OUT/checks-w8f1.json" > "$OUT/checks-w8f1.log" 2>&1; echo $? > "$OUT/checks-w8f1.exit"
bun docs/benchmarks/2026-10-04-operator-wave-repin/checks/run-all.ts "$OUT/checks-aow.json" > "$OUT/checks-aow.log" 2>&1; echo $? > "$OUT/checks-aow.exit"
bun docs/benchmarks/2026-10-04-operator-wave-repin/checks/embed-budget-stop-consented.ts > "$OUT/embed-consented.log" 2>&1; echo $? > "$OUT/embed-consented.exit"
# 6. Cat7-1 repro three more times
for i in 1 2 3; do bun "$W/repros/cat7-get-timeline-1k.ts" >> "$OUT/cat7-1-repro.jsonl" 2>>"$OUT/cat7-1-repro.err"; echo "exit $?" >> "$OUT/cat7-1-repro.jsonl"; done
# 7. memory trust ledger repros (37-1, 37-2, 37-5) against the installed gbrain
for f in fence-chunk-unconfirmed fence-chunk-external context-pack-newer-pages; do
  bun eval/runner/memory-trust/repro.ts "$f" > "$OUT/mt-repro-$f.log" 2>&1; echo $? > "$OUT/mt-repro-$f.exit"
done
# 8. full N1 and N5: PGLite and Postgres, every interface
PG_IMG=pgvector/pgvector:pg16
sudo chmod 666 /var/run/docker.sock   # the N6 runner reads the image digest with a plain docker inspect
pgstart() { sudo docker rm -f "$1" >/dev/null 2>&1; sudo docker run -d --name "$1" -p "127.0.0.1:$2:5432" -e POSTGRES_HOST_AUTH_METHOD=trust "$PG_IMG" >/dev/null
  for _ in $(seq 60); do sudo docker exec "$1" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done; sleep 2; }
pgstart n1-pg 55432
bun eval/runner/n1-knowledge-update.ts --engines pglite,postgres --pg-url postgres://postgres@127.0.0.1:55432/postgres --output "$OUT/n1-full" > "$OUT/n1-full.log" 2>&1; echo $? > "$OUT/n1-full.exit"
pgstart n1-pg 55432
bun eval/runner/n5-forget-residue.ts --engines pglite,postgres --pg-url postgres://postgres@127.0.0.1:55432/postgres --output "$OUT/n5-full" > "$OUT/n5-full.log" 2>&1; echo $? > "$OUT/n5-full.exit"
sudo docker rm -f n1-pg >/dev/null 2>&1
# 9. N6 on Postgres over real HTTP, the attested run and the negative control
pgstart n6-pg 55442
bun eval/runner/n6-postgres-http.ts --pg-url postgres://postgres@127.0.0.1:55442/postgres \
  --attest docs/benchmarks/2026-10-06-n6-postgres-http-preregistration.md --output "$OUT/n6pg" > "$OUT/n6pg.log" 2>&1; echo $? > "$OUT/n6pg.exit"
bun eval/runner/n6-postgres-http.ts --control-remote-private-pages --only get_page,search,list_pages --output "$OUT/n6pg-control" > "$OUT/n6pg-control.log" 2>&1; echo $? > "$OUT/n6pg-control.exit"
sudo docker rm -f n6-pg >/dev/null 2>&1
# 10. N8 and N6 attested against their gate preregistration
bun eval/runner/n8-proactive-recall.ts --attest docs/benchmarks/2026-10-06-n8-privacy-gate-preregistration.md --output "$OUT/n8-attest" > "$OUT/n8-attest.log" 2>&1; echo $? > "$OUT/n8-attest.exit"
bun eval/runner/n6-visibility-fuzz.ts --attest docs/benchmarks/2026-10-06-n8-privacy-gate-preregistration.md --output "$OUT/n6-attest" > "$OUT/n6-attest.log" 2>&1; echo $? > "$OUT/n6-attest.exit"
echo done > "$OUT/DONE"
