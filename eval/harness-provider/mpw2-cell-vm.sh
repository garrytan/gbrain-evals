#!/usr/bin/env bash
# Memory proof wave 2: one cell on its stage's Ubicloud VM. Cells of one stage run in order on one VM, so cells with
# equal ingest inputs share its store, under one stage ledger whose program cap is the stage's released budget.
#
#   STAGE_CAP_USD=<cap> GBRAIN_SHA=<sha> bash eval/harness-provider/mpw2-cell-vm.sh <stage> <spec.json>
#   bash eval/harness-provider/mpw2-cell-vm.sh <stage> down
#
# Env: UBICLOUD_API_TOKEN, GEMINI_API_KEY, OPENAI_API_KEY, VOYAGE_API_KEY, ANTHROPIC_API_KEY; COMMIT (default HEAD,
# must be pushed). The VM's name is recorded in $OUT/VMS.md and pushed when it is created, so a lost run machine
# cannot strand it. Each finished cell's public receipt (JSON files with VM paths scrubbed, a tarball of stages,
# scorer and the request log without bodies, the stage ledger's status) is pushed as soon as the cell ends. The
# stage ledger sqlite is private: it is copied to ~/.capy/work/mpw2/<stage>/ledger.sqlite after every cell for the
# operator to mirror, never committed. BEAM-100K and BEAM-1M per-question rows stay out of git (GBRA-49 ruling):
# their cells publish summary and spend only.
set -uo pipefail
stage=${1:?stage}; arg=${2:?spec or down}
REPO=$(cd "$(dirname "$0")/../.." && pwd)
COMMIT=${COMMIT:-$(git -C "$REPO" rev-parse HEAD)}
S=${UBI_RUNNER:-/home/user/.capy/drive/user-garry-tan/skills/ubicloud/scripts/ubi-runner.sh}
export UBI_OWNER=gbra52 UBI_GC_HOURS=0 UBICLOUD_API_KEY=${UBICLOUD_API_KEY:-$UBICLOUD_API_TOKEN}
M=$HOME/.capy/work/mpw2/$stage; mkdir -p "$M"
OUT=$REPO/docs/benchmarks/2026-10-10-memory-proof-wave-2/$stage
BRANCH=$(git -C "$REPO" rev-parse --abbrev-ref HEAD)
log() { echo "$(date -u +%FT%TZ) [mpw2 $stage] $*" | tee -a "$M/watch.log"; }

publish() {  # commit and push paths under $OUT, one writer at a time
  (
    flock 9
    cd "$REPO" && git add "$@" && git commit -q -m "$MSG" && git fetch -q origin \
      && git merge -q --no-edit "origin/$BRANCH" && git push -q origin "HEAD:$BRANCH"
  ) 9>"$HOME/.capy/work/mpw2/publish.lock"
}
vmlog() { echo "| $(date -u +%FT%TZ) | \`$1\` | $2 |" >> "$OUT/VMS.md"; MSG="mpw2 $stage: VM $1 $2" publish "$OUT/VMS.md" || log "VM note push failed"; }

if [ "$arg" = down ]; then
  vm=$(cat "$M/vm"); $S down "$vm" && vmlog "$vm" destroyed && rm -f "$M/vm"; exit
fi
spec=$arg
git -C "$REPO" cat-file -e "$COMMIT:$spec" || { log "$spec is not in $COMMIT"; exit 1; }
SHA=${GBRAIN_SHA:?GBRAIN_SHA}

if [ ! -s "$M/vm" ]; then
  vm=$($S up -s "${SIZE:-standard-16}") || { log "create failed"; exit 1; }
  echo "$vm" > "$M/vm"
  mkdir -p "$OUT"
  [ -f "$OUT/VMS.md" ] || printf '# VMs used by memory proof wave 2, stage %s\n\nAny VM listed as created without a later "destroyed" line can be removed from anywhere with `UBI_OWNER=gbra52 ubi-runner.sh down <name>`.\n\n| time | VM | event |\n|---|---|---|\n' "$stage" > "$OUT/VMS.md"
  vmlog "$vm" created
fi
vm=$(cat "$M/vm"); log "vm $vm"

if ! $S ssh "$vm" "test -f ~/.mpw-setup-$COMMIT" 2>/dev/null; then
  log "setup at $COMMIT, gbrain $SHA"
  git -C "$REPO" archive --format=tar.gz "$COMMIT" | $S ssh "$vm" 'rm -rf ~/work/gbrain-evals && mkdir -p ~/work/gbrain-evals && tar -xzf - -C ~/work/gbrain-evals'
  printf 'GEMINI_API_KEY=%q\nOPENAI_API_KEY=%q\nVOYAGE_API_KEY=%q\nANTHROPIC_API_KEY=%q\n' "$GEMINI_API_KEY" "$OPENAI_API_KEY" "$VOYAGE_API_KEY" "${ANTHROPIC_API_KEY:-}" \
    | $S ssh "$vm" 'umask 077; cat > ~/.mpw-keys'
  $S ssh "$vm" "set -e
    if [ ! -f ~/.mpw-base-done ]; then
      sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null
      sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq unzip build-essential >/dev/null
      curl -fsSL https://bun.sh/install | bash -s bun-v1.4.2 >/dev/null
      sudo ln -sf \$HOME/.bun/bin/bun /usr/local/bin/bun
      curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null
      git clone -q --filter=blob:none https://github.com/garrytan/gbrain ~/work/gbrain
      touch ~/.mpw-base-done
    fi
    export PATH=\$HOME/.bun/bin:\$HOME/.local/bin:\$PATH
    git -C ~/work/gbrain fetch -q origin $SHA
    git -C ~/work/gbrain cat-file -e $SHA
    cd ~/work/gbrain-evals && bun install --frozen-lockfile >/dev/null && bun run harness:setup >/dev/null
    touch ~/.mpw-setup-$COMMIT" > "$M/setup.log" 2>&1 || { log "setup failed; VM $vm kept"; tail -20 "$M/setup.log"; exit 1; }
fi

name=$(basename "$spec" .json)
$S ssh "$vm" "cat > ~/run-$name.sh" <<EOS
set -a; . ~/.mpw-keys; set +a
export PATH=\$HOME/.bun/bin:\$HOME/.local/bin:\$PATH
cd ~/work/gbrain-evals
L="--budget-ledger \$HOME/cells/ledger.sqlite"; G="--gbrain \$HOME/work/gbrain@${SHA:0:9}"
mkdir -p ~/cells
test -f ~/cells/ledger.sqlite || bun eval/runner/budget-ledger.ts init \$L --program-cap-usd ${STAGE_CAP_USD:?STAGE_CAP_USD} --reason "memory proof wave 2, stage $stage" >/dev/null
cid=\$(bun run harness:cell plan $spec --cells-dir ~/cells \$G \$L 2>/dev/null | python3 -c "import json,sys; t=sys.stdin.read(); print(json.loads(t[t.index('{'):])['cell_id'])")
echo \$cid > ~/cells/$name.cell-id
for attempt in 1 2 3 4; do
  if [ -f ~/cells/\$cid/summary.json ]; then break; fi
  if [ -d ~/cells/\$cid/stages ]; then step=resume; else step=run; fi
  echo "[vm] \$cid: \$step (attempt \$attempt)"
  bun run harness:cell \$step $spec --cells-dir ~/cells \$G \$L
done
bun eval/runner/budget-ledger.ts status \$L > ~/cells/ledger-status.json 2>/dev/null
test -f ~/cells/\$cid/summary.json; echo \$? > ~/cells/$name.exit
EOS
if ! $S ssh "$vm" "test -f ~/cells/$name.exit || { test -f ~/run-$name.pid && kill -0 \$(cat ~/run-$name.pid) 2>/dev/null; }"; then
  log "starting $name"
  $S ssh "$vm" "nohup setsid bash -c 'echo \$\$ > ~/run-$name.pid; exec bash ~/run-$name.sh' > ~/run-$name.log 2>&1 < /dev/null &"
fi
until $S ssh "$vm" "test -f ~/cells/$name.exit" 2>/dev/null; do
  sleep 300
  $S ssh "$vm" "c=\$(cat ~/cells/$name.cell-id 2>/dev/null); echo \"\$(date -u +%T) $name \$c ingest=\$(ls ~/cells/\$c/stages/ingest 2>/dev/null | wc -l) answer=\$(ls ~/cells/\$c/stages/answer 2>/dev/null | wc -l) judge=\$(ls ~/cells/\$c/stages/judge 2>/dev/null | wc -l)\"" >> "$M/progress.log" 2>/dev/null
done
log "$name exit $($S ssh "$vm" "cat ~/cells/$name.exit; tail -2 ~/run-$name.log" | tr '\n' ' ' | cut -c1-300)"
$S ssh "$vm" 'cat ~/cells/ledger.sqlite' > "$M/ledger.sqlite"
cid=$($S ssh "$vm" "cat ~/cells/$name.cell-id")
$S ssh "$vm" "test -f ~/cells/$cid/summary.json" || { log "$cid has no summary; nothing published, VM $vm kept"; exit 1; }

dest=$OUT/cells/$cid; mkdir -p "$dest"
aggregates_only=$(git -C "$REPO" show "$COMMIT:$spec" | python3 -c "import json,sys; s=json.load(sys.stdin); print(int(s['dataset'] == 'beam' and s['split'] in ('100k', '1m') and s.get('seal') != 'dev'))")
if [ "$aggregates_only" = 1 ]; then
  $S ssh "$vm" "cd ~/cells/$cid && tar -cf - summary.json spend.json" | tar -xf - -C "$dest"
else
  $S ssh "$vm" "cd ~/cells/$cid && tar -czf ~/receipt-$cid.tgz --exclude=proxy/bodies stages scorer proxy timestamp-manifest.json && tar -cf - *.json" | tar -xf - -C "$dest"
  $S ssh "$vm" "cat ~/receipt-$cid.tgz" > "$dest/receipt.tgz"
  tar -tzf "$dest/receipt.tgz" >/dev/null || { log "$cid receipt tarball unreadable"; exit 1; }
fi
$S ssh "$vm" 'cat ~/cells/ledger-status.json' > "$OUT/ledger-status.json"
(cd "$REPO" && bun -e '
  import { readFileSync, writeFileSync } from "node:fs";
  import { scrubMachinePaths } from "./eval/runner/receipt.ts";
  for (const f of process.argv.slice(1)) writeFileSync(f, scrubMachinePaths(readFileSync(f, "utf8"), undefined, "/home/ubi"));
' "$dest"/*.json "$OUT/ledger-status.json") || { log "path scrub failed; receipt not published"; exit 1; }
MSG="mpw2 $stage: receipt for $cid ($name)" publish "$dest" "$OUT/ledger-status.json" && log "receipt pushed: $cid" || { log "receipt push failed"; exit 1; }
