#!/usr/bin/env bash
# Memory proof wave, exploratory post hoc check of the LongMemEval-S combined-vs-raw gap: shard 1 of the combined row
# with facts_tokens=0, then the same shard at the original facts_tokens=1800 answered from the store the first cell
# ingested (equal ingest inputs share one store). Both cells run in order on one Ubicloud VM under one ledger whose
# program cap is CAP_USD (what is left of the approved $90 equivalence check); the ledger stops the run at the cap.
#
#   CAP_USD=16.16 bash eval/harness-provider/mpw-posthoc-lme-vm.sh [down]
#
# Env as eval/harness-provider/mpw-matched-vm.sh. State lives in ~/.capy/work/mpw/posthoc-lme. The VM's name is recorded
# in $OUT/VMS.md and pushed when it is created; the VM is destroyed once both receipts are pushed. The ledger sqlite is
# private: it stays in the state directory (mirrored off this machine by the operator), never in git or Drive.
set -uo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
COMMIT=${COMMIT:-$(git -C "$REPO" rev-parse HEAD)}
S=${UBI_RUNNER:-/home/user/.capy/drive/user-garry-tan/skills/ubicloud/scripts/ubi-runner.sh}
export UBI_OWNER=gbra52 UBI_GC_HOURS=0 UBICLOUD_API_KEY=${UBICLOUD_API_KEY:-$UBICLOUD_API_TOKEN}
M=$HOME/.capy/work/mpw/posthoc-lme; mkdir -p "$M"
OUT=$REPO/docs/benchmarks/2026-10-10-memory-proof-wave-lme-facts0
GBRAIN_SHA=d7467d1cf822442b965e435aa6979133edc96a72
SPECS="eval/harness-provider/cells/posthoc/longmemeval-s-gbrain-combined-shard1-facts0.json eval/harness-provider/cells/posthoc/longmemeval-s-gbrain-combined-shard1-facts1800-samestore.json"
log() { echo "$(date -u +%FT%TZ) [posthoc-lme] $*" | tee -a "$M/watch.log"; }

publish() {  # commit and push paths under $OUT, one writer at a time
  (
    flock 9
    cd "$REPO" && git add "$@" && git commit -q -m "$MSG" && git fetch -q origin \
      && git merge -q --no-edit origin/capy/mpw-harness && git push -q origin HEAD:capy/mpw-harness
  ) 9>"$HOME/.capy/work/mpw/publish.lock"
}
vmlog() { echo "| $(date -u +%FT%TZ) | \`$1\` | $2 |" >> "$OUT/VMS.md"; MSG="mpw posthoc lme: VM $1 $2" publish "$OUT/VMS.md" || log "VM note push failed"; }

if [ "${1:-}" = down ]; then
  vm=$(cat "$M/vm"); $S down "$vm" && vmlog "$vm" destroyed && rm -f "$M/vm"; exit
fi

if [ ! -s "$M/vm" ]; then
  vm=$($S up -s "${SIZE:-standard-16}") || { log "create failed"; exit 1; }
  echo "$vm" > "$M/vm"
  mkdir -p "$OUT"
  [ -f "$OUT/VMS.md" ] || printf '# VMs used by the post hoc LongMemEval-S facts_tokens=0 check\n\nAny VM listed as created without a later "destroyed" line can be removed from anywhere with `UBI_OWNER=gbra52 ubi-runner.sh down <name>`.\n\n| time | VM | event |\n|---|---|---|\n' > "$OUT/VMS.md"
  vmlog "$vm" created
fi
vm=$(cat "$M/vm"); log "vm $vm"

if ! $S ssh "$vm" 'test -f ~/.mpw-setup-done' 2>/dev/null; then
  log "setup"
  git -C "$REPO" archive --format=tar.gz "$COMMIT" | $S ssh "$vm" 'rm -rf ~/work/gbrain-evals && mkdir -p ~/work/gbrain-evals && tar -xzf - -C ~/work/gbrain-evals'
  printf 'GEMINI_API_KEY=%q\nOPENAI_API_KEY=%q\nVOYAGE_API_KEY=%q\n' "$GEMINI_API_KEY" "$OPENAI_API_KEY" "$VOYAGE_API_KEY" \
    | $S ssh "$vm" 'umask 077; cat > ~/.mpw-keys'
  $S ssh "$vm" "set -e
    sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq unzip build-essential >/dev/null
    curl -fsSL https://bun.sh/install | bash -s bun-v1.4.2 >/dev/null
    sudo ln -sf \$HOME/.bun/bin/bun /usr/local/bin/bun
    curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null
    export PATH=\$HOME/.bun/bin:\$HOME/.local/bin:\$PATH
    git clone -q --filter=blob:none https://github.com/garrytan/gbrain ~/work/gbrain
    git -C ~/work/gbrain fetch -q origin $GBRAIN_SHA
    git -C ~/work/gbrain cat-file -e $GBRAIN_SHA
    cd ~/work/gbrain-evals && bun install --frozen-lockfile >/dev/null && bun run harness:setup >/dev/null
    touch ~/.mpw-setup-done" > "$M/setup.log" 2>&1 || {
      log "setup failed, destroying $vm"; tail -20 "$M/setup.log"; $S down "$vm" && vmlog "$vm" "destroyed (setup failed)"; rm -f "$M/vm"; exit 1; }
fi

$S ssh "$vm" "cat > ~/run.sh" <<EOS
echo \$\$ > ~/run.pid
set -a; . ~/.mpw-keys; set +a
export PATH=\$HOME/.bun/bin:\$HOME/.local/bin:\$PATH
cd ~/work/gbrain-evals
L="--budget-ledger \$HOME/cells/ledger.sqlite"; G="--gbrain \$HOME/work/gbrain@${GBRAIN_SHA:0:9}"
mkdir -p ~/cells; : > ~/cells/cell-ids
test -f ~/cells/ledger.sqlite || bun eval/runner/budget-ledger.ts init \$L --program-cap-usd ${CAP_USD:?CAP_USD} --reason "mpw posthoc lme facts_tokens=0, inside the approved \\\$90 equivalence check" >/dev/null
ok=0
for spec in $SPECS; do
  cid=\$(bun run harness:cell plan \$spec --cells-dir ~/cells \$G \$L 2>/dev/null | python3 -c "import json,sys; t=sys.stdin.read(); print(json.loads(t[t.index('{'):])['cell_id'])")
  echo \$cid >> ~/cells/cell-ids
  for attempt in 1 2 3 4; do
    if [ -f ~/cells/\$cid/summary.json ]; then break; fi
    if [ -d ~/cells/\$cid/stages ]; then step=resume; else step=run; fi
    echo "[vm] \$cid: \$step (attempt \$attempt)"
    bun run harness:cell \$step \$spec --cells-dir ~/cells \$G \$L
  done
  test -f ~/cells/\$cid/summary.json || { ok=1; break; }
done
bun eval/runner/budget-ledger.ts status \$L > ~/cells/ledger-status.json 2>/dev/null
echo \$ok > ~/cells/exit
EOS
if ! $S ssh "$vm" 'test -f ~/cells/exit || { test -f ~/run.pid && kill -0 $(cat ~/run.pid) 2>/dev/null; }'; then
  log "starting the cells"
  $S ssh "$vm" 'nohup setsid bash ~/run.sh > ~/run.log 2>&1 < /dev/null &'
fi
until $S ssh "$vm" 'test -f ~/cells/exit' 2>/dev/null; do
  sleep 300
  $S ssh "$vm" 'for c in $(cat ~/cells/cell-ids 2>/dev/null); do echo "$(date -u +%T) $c ingest=$(ls ~/cells/$c/stages/ingest 2>/dev/null | wc -l) answer=$(ls ~/cells/$c/stages/answer 2>/dev/null | wc -l) judge=$(ls ~/cells/$c/stages/judge 2>/dev/null | wc -l)"; done' >> "$M/progress.log" 2>/dev/null
done
log "cells exit $($S ssh "$vm" 'cat ~/cells/exit; tail -2 ~/run.log' | tr '\n' ' ' | cut -c1-300)"
$S ssh "$vm" 'cat ~/cells/ledger.sqlite' > "$M/ledger.sqlite"

# Receipts as in mpw-matched-vm.sh: each cell's JSON files (VM home paths scrubbed), a tarball of stages, scorer and
# the proxy request log without bodies, and the shared ledger's status.
mkdir -p "$OUT/cells"
$S ssh "$vm" 'cat ~/cells/ledger-status.json' > "$OUT/ledger-status.json"
for cid in $($S ssh "$vm" 'cat ~/cells/cell-ids'); do
  $S ssh "$vm" "test -f ~/cells/$cid/summary.json" || { log "$cid has no summary; not published"; continue; }
  $S ssh "$vm" "cd ~/cells/$cid && tar -czf ~/receipt-$cid.tgz --exclude=proxy/bodies stages scorer proxy timestamp-manifest.json"
  dest=$OUT/cells/$cid; mkdir -p "$dest"
  $S ssh "$vm" "cd ~/cells/$cid && tar -cf - *.json" | tar -xf - -C "$dest"
  $S ssh "$vm" "cat ~/receipt-$cid.tgz" > "$dest/receipt.tgz"
  tar -tzf "$dest/receipt.tgz" >/dev/null || { log "$cid receipt tarball unreadable"; exit 1; }
done
(cd "$REPO" && bun -e '
  import { readFileSync, writeFileSync } from "node:fs";
  import { scrubMachinePaths } from "./eval/runner/receipt.ts";
  for (const f of process.argv.slice(1)) writeFileSync(f, scrubMachinePaths(readFileSync(f, "utf8"), undefined, "/home/ubi"));
' "$OUT"/cells/*/*.json "$OUT/ledger-status.json") || { log "path scrub failed; receipt not published"; exit 1; }
MSG="mpw posthoc lme: facts_tokens=0 receipts" publish "$OUT/cells" "$OUT/ledger-status.json" && log "receipts pushed" || { log "receipt push failed; VM $vm kept"; exit 1; }
$S down "$vm" && log "destroyed $vm" && vmlog "$vm" "destroyed after the receipts were pushed" && rm -f "$M/vm"
