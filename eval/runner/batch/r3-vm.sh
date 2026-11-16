#!/usr/bin/env bash
# R3's driver on its Ubicloud VM (W10 preregistration, amendment of 2026-11-16): one process, so one ledger writer, and
# resumable, because every step skips what its state already holds. A paid stage starts only once the controller has
# written its paid-window marker, $R3_STATE/windows/<unit>, holding that unit's budget in dollars; the stage opens one
# budget run for the unit and passes --paid-window <unit> to every paid command. Every reader stage also waits for
# windows/manifests-on-origin, written once the frozen R3 manifests are committed and pushed. Order: A, P, B.
#
#   R3_PROGRAM_CAP_USD=<n> bash eval/runner/batch/r3-vm.sh
set -euo pipefail
cd "$(dirname "$0")/../../.."
ST=${R3_STATE:-$HOME/r3}
export W10_STATE_DIR=$ST/w10 W10_PARTICLE_STATE_DIR=$ST/particle LME_DATASET=$ST/data/longmemeval_s_cleaned.json PATH=$HOME/.bun/bin:$PATH
LEDGER=$ST/ledger.sqlite
OUT=docs/benchmarks/2026-11-16-longmemeval-w10-newest
W10=eval/runner/batch/w10.ts
log() { echo "[r3 $(date -u +%FT%TZ)] $*"; }
# Each step gets its own GBRAIN_HOME under the run directory, so nothing a gbrain call writes there reaches another step.
home() { mkdir -p "$ST/gbrain-home/$1" && echo "$ST/gbrain-home/$1"; }
mkdir -p "$ST/windows" "$ST/runs" "$OUT"

wait_for() { until [ -s "$ST/windows/$1" ]; do log "waiting for $1"; sleep 300; done; }
# The unit's budget run, opened once from its marker.
run_for() {
  [ -s "$ST/runs/$1" ] || bun eval/runner/budget-ledger.ts open --budget-ledger "$LEDGER" --runner "r3-$1" --budget-usd "$(cat "$ST/windows/$1")" > "$ST/runs/$1"
  cat "$ST/runs/$1"
}
# Poll until no batch of the lane is open; an intent in state unknown needs an operator, so the driver stops.
settle() {
  while :; do
    bun $W10 poll --budget-ledger "$LEDGER" >/dev/null
    local s; s=$(bun $W10 status --budget-ledger "$LEDGER")
    if grep -q ' unknown ' <<<"$s"; then log "an intent is unknown; resolve it by hand"; exit 4; fi
    grep -Eq ' (prepared|sending|submitted|ended) ' <<<"$s" || return 0
    sleep 60
  done
}
# One arm or judge to completion: the pilot (first batch of a provider and model), the rest, then the one retry.
drive() {
  local args=("$@") out
  for _ in 1 2; do
    out=$(GBRAIN_HOME=$(home "${args[0]}-${args[1]}-${args[2]:-reader}") bun $W10 "${args[@]}" --budget-ledger "$LEDGER" --budget-run-id "$(run_for R3-B)" --paid-window R3-B 2>&1) || { grep -q 'some pending ids already had an attempt' <<<"$out" || { echo "$out"; exit 1; }; break; }
    echo "$out"
    grep -q 'nothing left to submit' <<<"$out" && return 0
    settle
  done
  export GBRAIN_HOME; GBRAIN_HOME=$(home "${args[0]}-${args[1]}-${args[2]:-reader}")
  if [ "${args[0]}" = run ]; then bun $W10 retry "${args[1]}" --budget-ledger "$LEDGER" --budget-run-id "$(run_for R3-B)" --paid-window R3-B || true
  else bun $W10 "${args[@]}" --retry --budget-ledger "$LEDGER" --budget-run-id "$(run_for R3-B)" --paid-window R3-B || true; fi
  settle
}

[ -s "$LEDGER" ] || bun eval/runner/budget-ledger.ts init --budget-ledger "$LEDGER" --program-cap-usd "${R3_PROGRAM_CAP_USD:?R3_PROGRAM_CAP_USD}"

# Stage A: retrieval at the newest release (embeddings and rerank), then the $0 builds that freeze R3's manifests.
if [ ! -f "$ST/stage-A.done" ]; then
  wait_for R3-A
  GBRAIN_HOME=$(home capture) bun eval/runner/batch/w10a-capture.ts --r3 --budget-ledger "$LEDGER" --budget-run-id "$(run_for R3-A)" --paid-window R3-A 2>&1 | tee -a "$ST/capture.log"
  rows=$(grep -c '"question_id"' "$W10_STATE_DIR/r3-capture/rows.ndjson" || true)
  [ "$rows" = 500 ] || { log "capture holds $rows of 500 rows"; exit 2; }
  mkdir -p "$OUT/capture"
  gzip -c "$W10_STATE_DIR/r3-capture/captures.ndjson" > "$OUT/capture/captures.ndjson.gz"
  gzip -c "$W10_STATE_DIR/r3-capture/rows.ndjson" > "$OUT/capture/harness-rows.ndjson.gz"
  cp "$(ls -t "$W10_STATE_DIR"/r3-capture/capture-run-*.json | head -1)" "$OUT/capture/capture-run.json"
  export GBRAIN_HOME; GBRAIN_HOME=$(home build)
  bun $W10 build r3-opus55-newest && bun $W10 build r3-sol-newest
  bun eval/runner/batch/w10-particle.ts build --r3 --gbrain-c5fb0201 "$ST/gbrain-c5fb0201" --out "$OUT" > /dev/null
  bun $W10 build r3-opus55-full
  touch "$ST/stage-A.done"
  log "stage A done: pull the manifests, commit and push them, then write windows/manifests-on-origin"
fi

# R3's manifests reach origin before any reader request (the amendment's order): once the controller has committed and
# pushed what stage A froze, this VM checks its untracked copies byte for byte against that commit and fast-forwards.
if [ ! -f "$ST/manifests.merged" ]; then
  wait_for manifests-on-origin
  git fetch -q origin "$(cat "$ST/windows/manifests-on-origin")"
  git diff --name-only HEAD FETCH_HEAD | while read -r f; do
    if [ -f "$f" ] && ! git ls-files --error-unmatch "$f" >/dev/null 2>&1; then
      git show "FETCH_HEAD:$f" | cmp -s - "$f" || { log "$f differs from the pushed copy"; exit 5; }
      rm "$f"
    fi
  done
  git merge -q --ff-only FETCH_HEAD
  touch "$ST/manifests.merged"
fi

# Stage P: particle-1's reads, in their own paid window, first after the capture: Particle windows run one at a time
# across the crew, so R3-P closes before the batch lane's long waits. Its co-judge runs in stage B under R3-B.
if [ ! -f "$ST/stage-P.done" ]; then
  wait_for R3-P
  for arm in r3-particle-newest r3-particle-full r3-particle-currentpin; do
    [ -f "$OUT/arms/$arm/receipt.json" ] && continue
    [ -d "$OUT/arms/$arm" ] && mv "$OUT/arms/$arm" "$ST/partial-$arm-$(date +%s)"
    GBRAIN_HOME=$(home "$arm") bun eval/runner/batch/w10-particle.ts run "$arm" --out "$OUT/arms/$arm" --cache "$ST/particle-cache" --budget-ledger "$LEDGER" --paid --budget-run-id "$(run_for R3-P)" --paid-window R3-P || log "$arm: the run exited non-zero (its receipt says why)"
  done
  touch "$ST/stage-P.done"
  log "stage P done: particle-1's reads are finished"
fi

# Stage B: the judge check, the three new reader arms, then every judge over them, over W10c's stored Sol rows and
# over particle-1's rows.
if [ ! -f "$ST/stage-B.done" ]; then
  wait_for R3-B
  export GBRAIN_HOME; GBRAIN_HOME=$(home judge-check)
  bun eval/runner/batch/r3-judge-check.ts plan --out "$OUT/judge-check"
  bun eval/runner/batch/r3-judge-check.ts run --out "$OUT/judge-check" --cache "$ST/judge-check-cache" --budget-ledger "$LEDGER" --paid --budget-run-id "$(run_for R3-B)" --paid-window R3-B
  bun eval/runner/batch/r3-judge-check.ts report --out "$OUT/judge-check" > /dev/null || log "judge check: a gate failed (report.json says which)"
  for arm in r3-opus55-newest r3-sol-newest r3-opus55-full; do drive run "$arm"; done
  for arm in r3-opus55-newest r3-sol-newest r3-opus55-full; do drive judge "$arm" official; done
  for arm in r3-opus55-newest r3-opus55-full r3-particle-newest r3-particle-full r3-particle-currentpin; do drive judge "$arm" secondary; done
  for arm in r3-sol-newest w10c-sol-full w10c-sol-currentpin; do drive judge "$arm" opus; done
  for arm in r3-opus55-newest r3-sol-newest r3-opus55-full; do bun $W10 export "$arm" "$OUT/arms/$arm" --budget-ledger "$LEDGER" > /dev/null; done
  for j in w10c-sol-full--opus w10c-sol-currentpin--opus r3-particle-newest--secondary r3-particle-full--secondary r3-particle-currentpin--secondary; do bun $W10 export-judge "$j" "$OUT/judges/$j" --budget-ledger "$LEDGER"; done
  touch "$ST/stage-B.done"
  log "stage B done"
fi
bun eval/runner/budget-ledger.ts status --budget-ledger "$LEDGER" > "$ST/ledger-status.json" || true
log "all stages done"
