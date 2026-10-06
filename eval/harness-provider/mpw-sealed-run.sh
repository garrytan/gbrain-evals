#!/usr/bin/env bash
# Memory proof wave, sealed primary: BEAM 100k + 500k + 1M, gbrain (combined primary, raw secondary) and the
# comparator, the joint blinded re-judge and the preregistered analysis. Ids, specs, cells and per-question rows
# stay in custody ($C, outside the repository); only aggregates are published.
#
#   bash eval/harness-provider/mpw-sealed-run.sh open     # access-logged sealed open + specs
#   bash eval/harness-provider/mpw-sealed-run.sh gbrain   # six gbrain cells, local
#   bash eval/harness-provider/mpw-sealed-run.sh comparator <split> <vm-name>   # one size on its VM
#   bash eval/harness-provider/mpw-sealed-run.sh judge    # joint blinded re-judge per size
#   bash eval/harness-provider/mpw-sealed-run.sh analyse  # NI at -3.5 (primary) and the raw-lane secondary
#
# Env: C (custody dir), DECISION_ID, RESERVE (on|off, the validation verdict), GBRAIN (checkout@d7467d1cf),
# LEDGER (budget ledger), UBI_OWNER=gbra52 and UBI_GC_HOURS=0 for every Ubicloud command.
set -euo pipefail
: "${C:?custody dir}" "${DECISION_ID:?decision id}" "${RESERVE:?on|off}" "${GBRAIN:?gbrain checkout@sha}" "${LEDGER:?ledger}"
cd "$(dirname "$0")/../.."
PREREG=docs/benchmarks/2026-10-05-memory-proof-wave-preregistration.md
UBI=${UBI_RUNNER:-scripts/ubicloud/ubi-runner.sh}
case "${1:?step}" in
  open)
    bun eval/runner/memory-proof-wave-grouping.ts open --split sealed --strata beam/100k,beam/500k,beam/1m \
      --private "$C/grouping-private.json" --access-log "$C/access-log.jsonl" --decision-id "$DECISION_ID" \
      --purpose "sealed primary: gbrain vs the comparator, BEAM 100k + 500k + 1M, margin 3.5" \
      --preregistration "$PREREG" --out "$C/sealed-ids.json"
    python3 eval/harness-provider/mpw-sealed-specs.py "$C/sealed-ids.json" "$C/sealed-specs" --reserve "$RESERVE" ;;
  gbrain)
    for split in 100k 500k 1m; do for arm in combined raw; do
      bun run harness:cell run "$C/sealed-specs/sealed-beam-$split-gbrain-$arm.json" --cells-dir "$C/sealed-cells" \
        --gbrain "$GBRAIN" --budget-ledger "$LEDGER"
    done; done ;;
  comparator)
    split=${2:?split}; vm=${3:?vm}
    export UBI_OWNER=gbra52 UBI_GC_HOURS=0
    "$UBI" ssh "$vm" 'mkdir -p ~/custody/specs && chmod 700 ~/custody'
    "$UBI" ssh "$vm" "cat > ~/custody/specs/sealed-beam-$split-comparator.json" < "$C/sealed-specs/sealed-beam-$split-comparator.json"
    "$UBI" ssh "$vm" "set -a; . ~/.mpw-keys; set +a; cd work/gbrain-evals && export PATH=\$HOME/.bun/bin:\$HOME/.local/bin:\$PATH && \
      (bun eval/runner/budget-ledger.ts status --budget-ledger ~/custody/ledger.sqlite >/dev/null 2>&1 || bun eval/runner/budget-ledger.ts init --budget-ledger ~/custody/ledger.sqlite --program-cap-usd 60 --reason 'sealed comparator, beam $split') && \
      bun run harness:cell run ~/custody/specs/sealed-beam-$split-comparator.json --cells-dir ~/custody/cells --budget-ledger ~/custody/ledger.sqlite"
    "$UBI" ssh "$vm" 'cd ~/custody && tar --exclude="*/store" --exclude="_stores" -czf - cells ledger.sqlite' | tar -C "$C/sealed-cells" --strip-components=1 -xzf - --wildcards 'cells/*' ;;
  judge)
    for split in 100k 500k 1m; do
      ids=$(python3 -c "import json,glob,sys; print(' '.join(sorted(json.load(open(f))['cell_id'] for f in glob.glob('$C/sealed-cells/*/cell.json') if json.load(open(f))['spec'].get('seal')=='sealed' and json.load(open(f))['spec']['split']=='$split')))")
      bun run harness:cell rejudge $ids --cells-dir "$C/sealed-cells" --out "$C/sealed-rejudge-$split" --budget-usd 20 --budget-ledger "$LEDGER"
      for id in $ids; do cp "$C/sealed-cells/$id/cell.json" "$C/sealed-rejudge-$split/$id/"; done
    done ;;
  analyse)
    pair() { python3 -c "
import json, glob
cells = {}
for f in glob.glob('$C/sealed-rejudge-$1/*/cell.json'):
    s = json.load(open(f))['spec']; cells[(s['provider'], s.get('lane'))] = f.rsplit('/', 1)[0]
print(cells[('gbrain', '$2')] + ':' + cells[('comparator', 'combined')])"; }
    for arm in combined raw; do
      bun eval/runner/memory-proof-wave-sealed-analysis.ts --pair "$(pair 100k $arm)" --pair "$(pair 500k $arm)" --pair "$(pair 1m $arm)" \
        --margin 3.5 --draws 9999 --seed 20261005 --out "$C/sealed-analysis-$arm.json" --rows "$C/sealed-rows-$arm.jsonl"
    done ;;
esac
