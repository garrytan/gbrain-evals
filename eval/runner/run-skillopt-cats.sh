#!/usr/bin/env bash
# Sequential driver for the full SkillOpt Track B suite (cat30/32/33/31).
# Continue-on-failure: each cat writes its own receipt + we capture its exit
# code; one failing cat does not block the others — but the SUITE exit code is
# non-zero when ANY cat failed (audit orchestrators-14: the old script always
# exited 0, so a caller or CI checking $? saw success when all four cats
# failed). Writes a DONE sentinel at the end so a poller (or a resumed agent
# session) can tell the run finished even if the launching shell was suspended.
#
# Env: ANTHROPIC_API_KEY + OPENAI_API_KEY must be exported by the caller.
# Usage: nohup bash eval/runner/run-skillopt-cats.sh > /tmp/skillopt-cats.log 2>&1 &
set -u
cd "$(dirname "$0")/../.." || exit 2
SENTINEL="${SKILLOPT_SENTINEL:-/tmp/skillopt-cats.done}"
rm -f "$SENTINEL"

OVERALL=0

run_cat () {
  local name="$1"; shift
  echo ""
  echo "════════════════════════════════════════════════════════════"
  echo "▶ $name  ($(date '+%H:%M:%S'))"
  echo "════════════════════════════════════════════════════════════"
  bun "eval/runner/$name"
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    OVERALL=1
  fi
  echo "◀ $name exit=$rc  ($(date '+%H:%M:%S'))"
  echo "$name=$rc" >> "$SENTINEL.partial"
}

# Order: headline first (cat30), then defense (cat32), then transfer (cat33),
# then the priciest ablation last (cat31) so cheaper signal lands first.
run_cat cat30-skillopt-improvement.ts
run_cat cat32-skillopt-reward-hacking.ts
run_cat cat33-skillopt-transfer.ts
run_cat cat31-skillopt-ablation.ts

echo ""
echo "════════════════════════════════════════════════════════════"
echo "ALL CATS COMPLETE ($(date '+%H:%M:%S'))"
cat "$SENTINEL.partial" 2>/dev/null
mv -f "$SENTINEL.partial" "$SENTINEL" 2>/dev/null || touch "$SENTINEL"
echo "sentinel: $SENTINEL"
if [ "$OVERALL" -ne 0 ]; then
  echo "SUITE FAILED: one or more cats exited non-zero (see per-cat lines above)" >&2
fi
exit "$OVERALL"
