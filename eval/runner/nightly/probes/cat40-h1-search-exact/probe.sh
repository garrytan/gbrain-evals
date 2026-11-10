#!/usr/bin/env bash
# Cat 40 H1 probe: the nightly's cat40-hard-m suite, H1 items only, on gbrain 001c8c39 with one change, search_exact on
# the starter MCP surface (gbrain-starter-search-exact.diff). Run on a Ubicloud VM from the root of a
# scripts/nightly-export.sh export of this branch, after scripts/nightly-vm.sh, with the probe commit's Git bundle at
# probe/gbrain-starter-search-exact.bundle in the export (the commit is local to the probe; it is not in gbrain's remote).
#
#   bash eval/runner/nightly/probes/cat40-h1-search-exact/probe.sh <night YYYY-MM-DD> <cap dollars> [run.ts limit seconds]
#
# The cap is both the probe ledger's program cap (budget-ledger.ts init, on a fresh ledger) and its one run's budget
# (run.ts opens the run from --night-cap-usd and --month-cap-usd). It never touches the nightly ledger.
# Everything else is the nightly matrix cell: run.ts, the Cat 40 adapter's commands, both frontier readers, k = 3, the
# 16-turn cap, the scorer and the dev set's suite digest. --cat40-call-turns only records each gbrain call's turn.
# Exit: run.ts's own code (0, 3 NIGHTLY_CAP_STOP, 4 NIGHTLY_VM_LOST, 5 NIGHTLY_HARNESS, 1 or 2 refused), 124 when
# run.ts hit the time limit, 1 when this script refused to start.
set -uo pipefail
NIGHT=${1:?night}; CAP=${2:?cap dollars}; LIMIT=${3:-18000}
export PATH="$HOME/.bun/bin:$PATH"
HERE=eval/runner/nightly/probes/cat40-h1-search-exact
BASE=001c8c39e84d726e9bb6ecbae053458c970d5af3
PROBE=ef29213d65a754a3fd24d1589455f78ee32185b2
BRANCH=probe/cat40-h1-starter-search-exact
ITEMS=H1-02,H1-03,H1-04,H1-05,H1-06,H1-07,H1-09,H1-10,H1-11,H1-12,H1-15,H1-16,H1-17,H1-18
G="$HOME/gbrain"
L=vout/ledger/CAT40-H1-PROBE.sqlite
NDIR=vout/nights/$NIGHT/${PROBE:0:12}
mkdir -p vout/out vout/ledger
refuse() { echo "probe.sh: $*" | tee vout/out/refused.txt >&2; exit 1; }
[[ "$NIGHT" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || refuse "night must be YYYY-MM-DD, got $NIGHT"
[[ "$CAP" =~ ^[1-9][0-9]*$ ]] || refuse "cap must be whole dollars, got $CAP"
[[ "$LIMIT" =~ ^[1-9][0-9]*$ ]] || refuse "limit must be whole seconds, got $LIMIT"
test -z "${PARTICLE_API_KEY:-}" || refuse "PARTICLE_API_KEY is set on this VM; the probe calls no particle-1"
test -f probe/gbrain-starter-search-exact.bundle || refuse "no probe/gbrain-starter-search-exact.bundle in the export"
git -C "$G" cat-file -e "$BASE^{commit}" 2>/dev/null || git -C "$G" fetch -q origin "$BASE" || refuse "can't fetch $BASE into $G"
git -C "$G" fetch -q "$PWD/probe/gbrain-starter-search-exact.bundle" "refs/heads/$BRANCH:refs/heads/$BRANCH" || refuse "can't fetch the probe bundle into $G"
[ "$(git -C "$G" rev-parse "$BRANCH")" = "$PROBE" ] || refuse "the bundle's $BRANCH isn't $PROBE"
[ "$(git -C "$G" rev-parse "$PROBE^")" = "$BASE" ] || refuse "$PROBE's parent isn't $BASE"
git -C "$G" diff "$BASE" "$PROBE" > vout/out/gbrain-probe.diff
cmp -s vout/out/gbrain-probe.diff "$HERE/gbrain-starter-search-exact.diff" || refuse "$BASE..$PROBE differs from $HERE/gbrain-starter-search-exact.diff"
if [ ! -f "$L" ]; then
  bun --no-env-file eval/runner/budget-ledger.ts init --budget-ledger "$L" --program-cap-usd "$CAP" \
    --reason "CAT40-H1-PROBE: Cat 40 H1 with search_exact on gbrain's starter surface (GBEV-3 brief to GBEV-74, $NIGHT)" || refuse "ledger init failed"
fi
echo "probe.sh: gbrain $PROBE (parent $BASE), ledger $L, night $NDIR"
# ubi-runner kills a command that prints nothing for UBI_IDLE_TIMEOUT (1800 s); a Cat 40 slot build can run quieter than that.
( while sleep 300 </dev/null >/dev/null 2>&1; do echo "[heartbeat $(date -u +%H:%M)] $(cat "$NDIR/outcomes.jsonl" 2>/dev/null | wc -l) outcome rows, $(cat "$NDIR/suites/cat40-hard-m/cells/attempts.jsonl" 2>/dev/null | wc -l) cell attempts"; done ) &
HB=$!
timeout --signal=TERM --kill-after=120 "$LIMIT" bun --no-env-file eval/runner/nightly/run.ts --ref "$PROBE" --tier matrix --night "$NIGHT" \
  --suites cat40-hard-m --items "$ITEMS" --paid --budget-ledger "$L" --night-cap-usd "$CAP" --month-cap-usd "$CAP" \
  --gbrain-clone "$G" --cat40-slot-allowance-usd 4 --cat40-call-turns --out vout/nights 2>&1 | tee vout/run-probe.log
rc=${PIPESTATUS[0]}
kill "$HB" 2>/dev/null
[ "$rc" -ne 124 ] || echo "probe.sh: run.ts hit its $LIMIT s limit; the probe is partial"
echo "run.ts exit $rc"
echo "$rc" > vout/exit-probe
bun --no-env-file eval/runner/budget-ledger.ts verify --budget-ledger "$L" > vout/ledger-verify.json 2>&1
bun --no-env-file eval/runner/budget-ledger.ts status --budget-ledger "$L" > vout/ledger-status.json 2>&1
if [ -f "$NDIR/outcomes.jsonl" ]; then
  python3 - "$NDIR" <<'EOF'
import gzip, json, os, sys
d = sys.argv[1]
out = {}
for line in open(os.path.join(d, 'outcomes.jsonl'), encoding='utf8'):
    if line.strip():
        out.setdefault(json.loads(line)['suite'], []).append(line if line.endswith('\n') else line + '\n')
os.makedirs(os.path.join(d, 'by-suite'), exist_ok=True)
for suite, lines in out.items():
    with open(os.path.join(d, 'by-suite', f'{suite}.jsonl.gz'), 'wb') as f:
        with gzip.GzipFile(filename='', mode='wb', fileobj=f, mtime=0) as g:
            g.write(''.join(lines).encode('utf8'))
EOF
fi
cp -a vout/ledger vout/run-probe.log vout/exit-probe vout/ledger-verify.json vout/ledger-status.json vout/out/ 2>/dev/null
if [ -d "$NDIR" ]; then mkdir -p "vout/out/nights/$NIGHT" && cp -a "$NDIR" "vout/out/nights/$NIGHT/"; fi
exit "$rc"
