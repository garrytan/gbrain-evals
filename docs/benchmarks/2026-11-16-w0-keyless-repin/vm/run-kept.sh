#!/usr/bin/env bash
# W0 kept rows (2026-11-16-w0-keyless-repin-preregistration.md, amendment "Kept rows"): the privacy and data-loss
# contracts that need Postgres, HTTP or large pages, at the newest release only. Usage:
#   bash run-kept.sh a|b|all [new|old] [label]
#   a    the privacy and data-loss ledger repros, full N1 (belief ledger off and on), full N5, N6 on Postgres over HTTP
#        and its negative control
#   b    the lifecycle matrix (one build) and N14 large pages (Wave B4's command set)
#   all  a, then b (one VM)
# A step name instead of a part (n1-full, n6pg, lifecycle, n14-postgres-large, ...) runs only that step: with a label it
# is the second run at newest, and with side old it is the rerun at 77cf8e111 that the amendment allows after a failure.
# Output: ~/out/<side>[-<label>]/. A step whose .exit file exists is skipped, so running the script again resumes.
# gbrain runs with its shipped defaults, upkeep included; every step gets a fresh GBRAIN_HOME, and a background monitor
# logs every live `gbrain serve` with its age to serve-ages.log (amendment "Background upkeep"). No provider key is set.
set -u
export PATH="$HOME/.bun/bin:$PATH"
KEYS="ANTHROPIC_API_KEY OPENAI_API_KEY VOYAGE_API_KEY PARTICLE_API_KEY GEMINI_API_KEY GOOGLE_API_KEY GOOGLE_GENERATIVE_AI_API_KEY GROQ_API_KEY OPENROUTER_API_KEY TOGETHER_API_KEY TYPESAFE_API_KEY JEV_TYPESAFE_API_KEY UBICLOUD_API_KEY UBICLOUD_API_TOKEN"
for k in $KEYS; do unset "$k"; done
PART=${1:?usage: run-kept.sh a|b|all|<step> [new|old] [label]}
SIDE=${2:-new}
LABEL=${3:-}
OLD=77cf8e1116e9af67c1983adcbb3223b96f0991a5
NEW=6ce7195b44a034f85aec811f11fbf862db376f50
case "$SIDE" in new) SHA=$NEW ;; old) SHA=$OLD ;; *) echo "side must be new or old" >&2; exit 2 ;; esac
R=docs/benchmarks/2026-11-16-w0-keyless-repin
D6=docs/benchmarks/2026-10-06-followups-repin
PG_IMG=pgvector/pgvector:pg16
OUT="$HOME/out/$SIDE${LABEL:+-$LABEL}"; mkdir -p "$OUT" "$HOME/gh"
cd "$HOME/w/$SIDE" || exit 2
{ for k in $KEYS GBRAIN_SWEEP GBRAIN_SWEEP_IDLE_INTERVAL_MS GBRAIN_HOME; do if [ -n "${!k:-}" ]; then echo "$k set"; else echo "$k unset"; fi; done
  for f in "$HOME/.env" "$HOME/.gbrain" "$HOME/.claude" "$HOME/.codex" "$HOME/.openclaw"; do if [ -e "$f" ]; then echo "$f exists"; else echo "$f absent"; fi; done; } > "$OUT/keys-$PART.txt"
if [ ! -f "$OUT/tree.txt" ]; then
  { git rev-parse HEAD; git status --porcelain; grep '"gbrain"' package.json; grep '"version"' node_modules/gbrain/package.json
    sha256sum bun.lock; nproc; bun --version; grep -m1 'model name' /proc/cpuinfo; date -u +%FT%TZ; } > "$OUT/tree.txt"
fi
SERVE_RE='(cli\.ts|gbrain) serve'
( while true; do
    for p in $(pgrep -f "$SERVE_RE" 2>/dev/null); do
      a=$(ps -o etimes= -p "$p" 2>/dev/null | tr -d ' ')
      [ -n "$a" ] && echo "$(date -u +%FT%TZ) pid=$p age_s=$a step=$(cat "$OUT/.step" 2>/dev/null)"
    done
    sleep 10
  done >> "$OUT/serve-ages.log" ) &
MON=$!
trap 'kill $MON 2>/dev/null' EXIT
sudo chmod 666 /var/run/docker.sock
pgstart() { docker rm -f "$1" >/dev/null 2>&1; docker run -d --name "$1" -p "127.0.0.1:$2:5432" -e POSTGRES_HOST_AUTH_METHOD=trust "$PG_IMG" >/dev/null
  for _ in $(seq 60); do docker exec "$1" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done; sleep 2; }
pgstop() { docker rm -f "$1" >/dev/null 2>&1; }
want() { case "$PART" in all) return 0 ;; "$1"|"$2") return 0 ;; *) return 1 ;; esac; }
step() {
  local name=$1; shift
  [ -f "$OUT/$name.exit" ] && return 0
  local t0 gh; t0=$(date +%s); gh=$(mktemp -d "$HOME/gh/$name.XXXX")
  echo "$name" > "$OUT/.step"
  GBRAIN_HOME="$gh" bash -c "$*" > "$OUT/$name.log" 2>&1; echo $? > "$OUT/$name.exit"
  echo "$name $(( $(date +%s) - t0 ))" >> "$OUT/durations.txt"
}
if want a repros-pdl; then
  step repros-pdl "bun $D6/run-repros.ts $R/repros-privacy-data-loss.txt $OUT/repros-pdl.txt"
fi
if want a n1-full || want a n1-ledger-on || want a n5-full; then
  pgstart kept-n1-pg 55432
  want a n1-full && step n1-full "bun eval/runner/n1-knowledge-update.ts --engines pglite,postgres --pg-url postgres://postgres@127.0.0.1:55432/postgres --output $OUT/n1-full"
  if [ "$SIDE" = new ] && want a n1-ledger-on; then
    pgstart kept-n1-pg 55432
    step n1-ledger-on "EVAL_BELIEF_LEDGER=1 bun eval/runner/n1-knowledge-update.ts --engines pglite,postgres --pg-url postgres://postgres@127.0.0.1:55432/postgres --output $OUT/n1-ledger-on"
  fi
  if want a n5-full; then
    pgstart kept-n1-pg 55432
    step n5-full "bun eval/runner/n5-forget-residue.ts --engines pglite,postgres --pg-url postgres://postgres@127.0.0.1:55432/postgres --output $OUT/n5-full"
  fi
  pgstop kept-n1-pg
fi
if want a n6pg || want a n6pg-control; then
  pgstart kept-n6-pg 55442
  want a n6pg && step n6pg "bun eval/runner/n6-postgres-http.ts --pg-url postgres://postgres@127.0.0.1:55442/postgres --attest docs/benchmarks/2026-10-06-n6-postgres-http-preregistration.md --output $OUT/n6pg"
  want a n6pg-control && step n6pg-control "bun eval/runner/n6-postgres-http.ts --control-remote-private-pages --only get_page,search,list_pages --output $OUT/n6pg-control"
  pgstop kept-n6-pg
fi
if want b lifecycle; then
  mkdir -p "$OUT/lifecycle"
  pgstart kept-lc-pg 55462
  step lifecycle "bun eval/runner/lifecycle-experiment.ts --gbrain-repo $HOME/gbrain --builds $SIDE=$SHA --engines pglite,postgres --pg-url postgres://postgres@127.0.0.1:55462/postgres --concurrency 6 --work $HOME/lc-work/$SIDE${LABEL:+-$LABEL} --out $OUT/lifecycle/receipt.json"
  pgstop kept-lc-pg
  step lifecycle-report "bun eval/runner/lifecycle-report.ts $OUT/lifecycle/receipt.json"
fi
if [ "$SIDE" = new ] && { want b n14-pglite-2mb || want b n14-pglite-20mb || want b n14-pglite-24mib || want b n14-pglite-large || want b n14-postgres-2mb || want b n14-postgres-large; }; then
  pgstart kept-n14-pg 55452
  export N14_PG_ADMIN_URL=postgres://postgres@127.0.0.1:55452/postgres
  BIG="--arms single-page,native --concurrency 1"
  want b n14-pglite-2mb && step n14-pglite-2mb "bun eval/runner/n14-large-page-fidelity.ts --tiers 2mb --lifecycle --output $OUT/n14/pglite/2mb"
  want b n14-pglite-20mb && step n14-pglite-20mb "bun eval/runner/n14-large-page-fidelity.ts --tiers 20mb --concurrency 1 --lifecycle --output $OUT/n14/pglite/20mb"
  want b n14-pglite-24mib && step n14-pglite-24mib "bun eval/runner/n14-large-page-fidelity.ts --tiers 24mib --concurrency 1 --lifecycle --output $OUT/n14/pglite/24mib"
  want b n14-pglite-large && step n14-pglite-large "bun eval/runner/n14-large-page-fidelity.ts --tiers 100mib,128mib,200mb,256mib,260mib $BIG --lifecycle --output $OUT/n14/pglite/large"
  want b n14-postgres-2mb && step n14-postgres-2mb "bun eval/runner/n14-large-page-fidelity.ts --tiers 2mb --engine postgres --lifecycle --output $OUT/n14/postgres/2mb"
  want b n14-postgres-large && step n14-postgres-large "bun eval/runner/n14-large-page-fidelity.ts --tiers 100mib,128mib,200mb,256mib,260mib $BIG --engine postgres --lifecycle --output $OUT/n14/postgres/large"
  pgstop kept-n14-pg
fi
{ grep -m1 'model name' /proc/cpuinfo; nproc; free -g
  if [ -e "$HOME/.gbrain" ]; then echo "$HOME/.gbrain exists after the run"; else echo "$HOME/.gbrain absent after the run"; fi; } > "$OUT/host-$PART.txt"
echo done > "$OUT/DONE-$PART"
