#!/usr/bin/env bash
# W0 keyless re-pin (2026-11-16-w0-keyless-repin-preregistration.md), one VM. Usage: bash run.sh "old new" | "new old".
# Runs steps 1 to 13 at each build in the order given (steps 14 to 17 at the new build only), then step 18 (lifecycle,
# both builds in one matrix), then step 19: three rounds of Cat 7 and the Cat7-1 repro, alternating which build goes
# first. Output: ~/out/<old|new>/ and ~/out/{lifecycle,timing}. A step whose .exit file exists is skipped, so running the
# script again resumes where it stopped. No provider key is set; the script unsets them and records that in ~/out/keys.txt.
# gbrain runs with its shipped defaults, upkeep included (amendment of 2026-11-16, "Background upkeep"). Every step gets
# a fresh GBRAIN_HOME, a background monitor logs every live `gbrain serve` with its age to ~/out/serve-ages.log, and
# no serve may be alive when a timing step starts.
set -u
export PATH="$HOME/.bun/bin:$PATH"
KEYS="ANTHROPIC_API_KEY OPENAI_API_KEY VOYAGE_API_KEY PARTICLE_API_KEY GEMINI_API_KEY GOOGLE_API_KEY GOOGLE_GENERATIVE_AI_API_KEY GROQ_API_KEY OPENROUTER_API_KEY TOGETHER_API_KEY TYPESAFE_API_KEY JEV_TYPESAFE_API_KEY UBICLOUD_API_KEY UBICLOUD_API_TOKEN"
for k in $KEYS; do unset "$k"; done
ORDER=${1:?usage: run.sh "old new" or "new old"}
OLD=77cf8e1116e9af67c1983adcbb3223b96f0991a5
NEW=6ce7195b44a034f85aec811f11fbf862db376f50
W=docs/benchmarks/2026-10-03-wave8-f1-repin
D6=docs/benchmarks/2026-10-06-followups-repin
AOW=docs/benchmarks/2026-10-04-operator-wave-repin
PG_IMG=pgvector/pgvector:pg16
mkdir -p "$HOME/out"
{ for k in $KEYS GBRAIN_SWEEP GBRAIN_SWEEP_IDLE_INTERVAL_MS GBRAIN_HOME; do if [ -n "${!k:-}" ]; then echo "$k set"; else echo "$k unset"; fi; done
  for f in "$HOME/.env" "$HOME/.gbrain" "$HOME/.claude" "$HOME/.codex" "$HOME/.openclaw"; do if [ -e "$f" ]; then echo "$f exists"; else echo "$f absent"; fi; done; } > "$HOME/out/keys.txt"
SERVE_RE='(cli\.ts|gbrain) serve'
mkdir -p "$HOME/gh"
( while true; do
    for p in $(pgrep -f "$SERVE_RE" 2>/dev/null); do
      a=$(ps -o etimes= -p "$p" 2>/dev/null | tr -d ' ')
      [ -n "$a" ] && echo "$(date -u +%FT%TZ) pid=$p age_s=$a step=$(cat "$HOME/out/.step" 2>/dev/null)"
    done
    sleep 10
  done >> "$HOME/out/serve-ages.log" ) &
MON=$!
trap 'kill $MON 2>/dev/null' EXIT
sudo chmod 666 /var/run/docker.sock
pgstart() { docker rm -f "$1" >/dev/null 2>&1; docker run -d --name "$1" -p "127.0.0.1:$2:5432" -e POSTGRES_HOST_AUTH_METHOD=trust "$PG_IMG" >/dev/null
  for _ in $(seq 60); do docker exec "$1" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done; sleep 2; }
pgstop() { docker rm -f "$1" >/dev/null 2>&1; }
step() {
  local name=$1; shift
  [ -f "$OUT/$name.exit" ] && return 0
  local t0 gh; t0=$(date +%s); gh=$(mktemp -d "$HOME/gh/$name.XXXX")
  echo "$OUT/$name" > "$HOME/out/.step"
  GBRAIN_HOME="$gh" bash -c "$*" > "$OUT/$name.log" 2>&1; echo $? > "$OUT/$name.exit"
  echo "$name $(( $(date +%s) - t0 ))" >> "$OUT/durations.txt"
}
for side in $ORDER; do
  OUT="$HOME/out/$side"; mkdir -p "$OUT"; cd "$HOME/w/$side" || exit 2
  if [ ! -f "$OUT/tree.txt" ]; then
    { git rev-parse HEAD; git status --porcelain; grep '"gbrain"' package.json; grep '"version"' node_modules/gbrain/package.json
      sha256sum bun.lock; nproc; bun --version; grep -m1 'model name' /proc/cpuinfo; date -u +%FT%TZ; } > "$OUT/tree.txt"
  fi
  # 1. offline tier
  step offline-tier "GBRAIN_REPO=\"$PWD/node_modules/gbrain\" bun eval/runner/all.ts --tier offline"
  # 2. N12 at seed 7
  step n12-seed7 "bun eval/runner/n12-format-fidelity.ts --seed 7 --output $OUT/n12-seed7"
  # 3. ledger repros: the 27 of 109b992, Cat7-1, N1-7
  step repros "bun $D6/run-repros.ts $W/repros-109b992.txt $OUT/repros.txt 'bun $W/repros/cat7-get-timeline-1k.ts' 'bun $D6/repros/n1-7-sweep-fences-ontology.ts'"
  # 4. wave 8 and Foundations 1 checks; 5. operator-wave checks and the consented embed-budget-stop variant
  step checks-w8f1 "bun $W/checks/run-all.ts $OUT/checks-w8f1.json"
  step checks-aow "bun $AOW/checks/run-all.ts $OUT/checks-aow.json"
  step embed-consented "bun $AOW/checks/embed-budget-stop-consented.ts"
  # 6. memory trust ledger repros 37-1, 37-2, 37-5
  for f in fence-chunk-unconfirmed fence-chunk-external context-pack-newer-pages; do step "mt-repro-$f" "bun eval/runner/memory-trust/repro.ts $f"; done
  # 7. full N1 and N5: PGLite and Postgres, every interface
  if [ ! -f "$OUT/n1-full.exit" ]; then pgstart n1-pg 55432; fi
  step n1-full "bun eval/runner/n1-knowledge-update.ts --engines pglite,postgres --pg-url postgres://postgres@127.0.0.1:55432/postgres --output $OUT/n1-full"
  if [ ! -f "$OUT/n5-full.exit" ]; then pgstart n1-pg 55432; fi
  step n5-full "bun eval/runner/n5-forget-residue.ts --engines pglite,postgres --pg-url postgres://postgres@127.0.0.1:55432/postgres --output $OUT/n5-full"
  pgstop n1-pg
  # 8. N6 on Postgres over real HTTP, attested, and its negative control
  if [ ! -f "$OUT/n6pg.exit" ]; then pgstart n6-pg 55442; fi
  step n6pg "bun eval/runner/n6-postgres-http.ts --pg-url postgres://postgres@127.0.0.1:55442/postgres --attest docs/benchmarks/2026-10-06-n6-postgres-http-preregistration.md --output $OUT/n6pg"
  step n6pg-control "bun eval/runner/n6-postgres-http.ts --control-remote-private-pages --only get_page,search,list_pages --output $OUT/n6pg-control"
  pgstop n6-pg
  # 9. N8 and N6 attested against the N8 privacy gate preregistration
  step n8-attest "bun eval/runner/n8-proactive-recall.ts --attest docs/benchmarks/2026-10-06-n8-privacy-gate-preregistration.md --output $OUT/n8-attest"
  step n6-attest "bun eval/runner/n6-visibility-fuzz.ts --attest docs/benchmarks/2026-10-06-n8-privacy-gate-preregistration.md --output $OUT/n6-attest"
  # 10. agent retrieval shapes (ARS-1 to ARS-15)
  step ars "bun eval/runner/agent-retrieval-shapes.ts --output $OUT/ars"
  # 11. attendance world and the composed questions behind the multi-relation planner (keyword path)
  step n9-attendees "bun eval/runner/n9-multi-hop-paraphrase.ts --corpus eval/data/world-v1-attendees --output $OUT/n9-attendees"
  step n9-world-v1 "bun eval/runner/n9-multi-hop-paraphrase.ts --corpus eval/data/world-v1 --output $OUT/n9-world-v1"
  step attendance-score-attendees "bun eval/runner/attendance-world-score.ts --receipt $OUT/n9-attendees/receipt.json --corpus eval/data/world-v1-attendees --json"
  step attendance-score-world-v1 "bun eval/runner/attendance-world-score.ts --receipt $OUT/n9-world-v1/receipt.json --corpus eval/data/world-v1 --json"
  step attendee-role "bun eval/runner/attendee-role-planner.ts --corpus eval/data/world-v1-attendees --output $OUT/attendee-role"
  # 12. one-hop relationship questions, keyword path (the keyless sibling of README's paid N9 row)
  step relational-ab "bun eval/runner/relational-ab.ts --output-dir $OUT/relational-ab"
  # 13. N3 and N4 at a second seed
  step n3-seed7 "bun eval/runner/n3-temporal-asof.ts --seed 7 --output $OUT/n3-seed7"
  step n4-seed7 "bun eval/runner/n4-entity-resolution.ts --seed 7 --output $OUT/n4-seed7"
  if [ "$side" = new ]; then
    # 14. N1 with the belief ledger on (the off arm is step 7)
    if [ ! -f "$OUT/n1-ledger-on.exit" ]; then pgstart n1-pg 55432; fi
    step n1-ledger-on "EVAL_BELIEF_LEDGER=1 bun eval/runner/n1-knowledge-update.ts --engines pglite,postgres --pg-url postgres://postgres@127.0.0.1:55432/postgres --output $OUT/n1-ledger-on"
    pgstop n1-pg
    # 15. forecast journal, gbrain's own keyless harness
    step forecast-journal "mkdir -p $OUT/forecast-journal && cd node_modules/gbrain && bun evals/forecast-journal/harness.ts --check && bun evals/forecast-journal/harness.ts --run --json $OUT/forecast-journal/summary.json --md $OUT/forecast-journal/summary.md"
    # 16. keyless partial-match search on LongMemEval-S through gbrain's query operation
    step lme-keyless "cd node_modules/gbrain && bun run src/cli.ts eval longmemeval $HOME/data/longmemeval_s_cleaned.json --retrieval-only --top-k 10 --no-trajectory --mode balanced --reranker off --autocut off --by-type --via-operation query --op-expand off --output $OUT/lme-keyless.jsonl"
    # 17. N14 large pages, Wave B4's command set without its eight exploratory repeats
    if [ ! -f "$OUT/n14-postgres-large.exit" ]; then pgstart n14-pg 55452; fi
    export N14_PG_ADMIN_URL=postgres://postgres@127.0.0.1:55452/postgres
    BIG="--arms single-page,native --concurrency 1"
    step n14-pglite-2mb "bun eval/runner/n14-large-page-fidelity.ts --tiers 2mb --lifecycle --output $OUT/n14/pglite/2mb"
    step n14-pglite-20mb "bun eval/runner/n14-large-page-fidelity.ts --tiers 20mb --concurrency 1 --lifecycle --output $OUT/n14/pglite/20mb"
    step n14-pglite-24mib "bun eval/runner/n14-large-page-fidelity.ts --tiers 24mib --concurrency 1 --lifecycle --output $OUT/n14/pglite/24mib"
    step n14-pglite-large "bun eval/runner/n14-large-page-fidelity.ts --tiers 100mib,128mib,200mb,256mib,260mib $BIG --lifecycle --output $OUT/n14/pglite/large"
    step n14-postgres-2mb "bun eval/runner/n14-large-page-fidelity.ts --tiers 2mb --engine postgres --lifecycle --output $OUT/n14/postgres/2mb"
    step n14-postgres-large "bun eval/runner/n14-large-page-fidelity.ts --tiers 100mib,128mib,200mb,256mib,260mib $BIG --engine postgres --lifecycle --output $OUT/n14/postgres/large"
    pgstop n14-pg
  fi
  if [ ! -d "$OUT/reports" ]; then cp -r eval/reports "$OUT/reports"; fi
done
# 18. lifecycle: both builds in one matrix (2 builds x 2 engines x 3 interfaces), from the new build's tree
OUT="$HOME/out/lifecycle"; mkdir -p "$OUT"; cd "$HOME/w/new" || exit 2
if [ ! -f "$OUT/lifecycle.exit" ]; then pgstart lc-pg 55462; fi
step lifecycle "bun eval/runner/lifecycle-experiment.ts --gbrain-repo $HOME/gbrain --builds old=$OLD,new=$NEW --engines pglite,postgres --pg-url postgres://postgres@127.0.0.1:55462/postgres --concurrency 6 --out $OUT/receipt.json"
pgstop lc-pg
step lifecycle-report "bun eval/runner/lifecycle-report.ts $OUT/receipt.json"
# 19. timing: three rounds of Cat 7 and the Cat7-1 repro per build, alternating which build goes first
TOUT="$HOME/out/timing"; mkdir -p "$TOUT"
for i in 1 2 3; do
  if [ $((i % 2)) -eq 1 ]; then order="$ORDER"; else order=$(echo "$ORDER" | awk '{print $2" "$1}'); fi
  for side in $order; do
    OUT="$TOUT/$side"; mkdir -p "$OUT"; cd "$HOME/w/$side" || exit 2
    if [ ! -f "$OUT/perf-$i.exit" ]; then
      left=$(pgrep -f "$SERVE_RE" | tr '\n' ' '); echo "before perf-$i: live serve pids: ${left:-none}" >> "$OUT/serve-before.txt"
      [ -n "$left" ] && pkill -f "$SERVE_RE" && sleep 2
    fi
    step "perf-$i" "bun eval/runner/perf.ts && cp eval/reports/perf/receipt.json $OUT/perf-$i.json"
    step "cat7-1-repro-$i" "bun $W/repros/cat7-get-timeline-1k.ts"
  done
done
grep -m1 'model name' /proc/cpuinfo > "$HOME/out/host.txt"; nproc >> "$HOME/out/host.txt"; free -g >> "$HOME/out/host.txt"
if [ -e "$HOME/.gbrain" ]; then echo "$HOME/.gbrain exists after the run" >> "$HOME/out/host.txt"; else echo "$HOME/.gbrain absent after the run" >> "$HOME/out/host.txt"; fi
echo done > "$HOME/out/DONE"
