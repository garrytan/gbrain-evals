#!/usr/bin/env bash
# Memory proof wave, matched secondary rows: one cell from eval/harness-provider/cells/matched/<name>.json on its own
# Ubicloud VM, resumable, with its public receipt committed and pushed as soon as it finishes.
#
#   bash eval/harness-provider/mpw-matched-vm.sh <name>
#
# Env: UBICLOUD_API_TOKEN, GEMINI_API_KEY, OPENAI_API_KEY, VOYAGE_API_KEY; COMMIT (default HEAD, must be pushed).
# State lives in $M (default ~/.capy/work/mpw/matched/<name>): the VM name, logs and the pulled cell. A relaunch reuses
# the recorded VM and a running cell. The VM's name is recorded in
# docs/benchmarks/2026-10-09-memory-proof-wave-matched/VMS.md and pushed when the VM is created, so a lost run machine
# cannot strand it: `ubi-runner.sh down <name>` works from anywhere. The VM is destroyed once its cell is pulled.
# The ledger sqlite is private: it stays in $M (mirrored off this machine by the operator), never in git or Drive.
set -uo pipefail
name=${1:?name}
REPO=$(cd "$(dirname "$0")/../.." && pwd)
COMMIT=${COMMIT:-$(git -C "$REPO" rev-parse HEAD)}
S=${UBI_RUNNER:-/home/user/.capy/drive/user-garry-tan/skills/ubicloud/scripts/ubi-runner.sh}
export UBI_OWNER=gbra52 UBI_GC_HOURS=0 UBICLOUD_API_KEY=${UBICLOUD_API_KEY:-$UBICLOUD_API_TOKEN}
M=${M:-$HOME/.capy/work/mpw/matched}/$name; mkdir -p "$M"
OUT=$REPO/docs/benchmarks/2026-10-09-memory-proof-wave-matched
GBRAIN_SHA=d7467d1cf822442b965e435aa6979133edc96a72
log() { echo "$(date -u +%FT%TZ) [$name] $*" | tee -a "$M/watch.log"; }
spec=eval/harness-provider/cells/matched/$name.json
read -r provider cap < <(git -C "$REPO" show "$COMMIT:$spec" | python3 -c "import json,sys; s=json.load(sys.stdin); print(s['provider'], s['budget_usd'])")

publish() {  # commit and push paths under $OUT, one writer at a time
  (
    flock 9
    cd "$REPO" && git add "$@" && git commit -q -m "$MSG" && git fetch -q origin \
      && git merge -q --no-edit origin/capy/mpw-harness && git push -q origin HEAD:capy/mpw-harness
  ) 9>"$HOME/.capy/work/mpw/publish.lock"
}

if [ ! -s "$M/vm" ]; then
  vm=$($S up -s "${SIZE:-standard-16}") || { log "create failed"; exit 1; }
  echo "$vm" > "$M/vm"
  mkdir -p "$OUT"
  echo "| $(date -u +%FT%TZ) | $name | \`$vm\` | created |" >> "$OUT/VMS.md"
  MSG="mpw matched: record VM $vm for $name" publish "$OUT/VMS.md" || log "VM note push failed"
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
    if [ $provider = gbrain ]; then
      git clone -q --filter=blob:none https://github.com/garrytan/gbrain ~/work/gbrain
      git -C ~/work/gbrain fetch -q origin $GBRAIN_SHA
      git -C ~/work/gbrain cat-file -e $GBRAIN_SHA
    fi
    cd ~/work/gbrain-evals && bun install --frozen-lockfile >/dev/null && bun run harness:setup >/dev/null
    touch ~/.mpw-setup-done" > "$M/setup.log" 2>&1 || {
      log "setup failed, destroying $vm"; tail -20 "$M/setup.log"; $S down "$vm"
      echo "| $(date -u +%FT%TZ) | $name | \`$vm\` | destroyed (setup failed) |" >> "$OUT/VMS.md"
      MSG="mpw matched: VM $vm destroyed after failed setup" publish "$OUT/VMS.md"; rm -f "$M/vm"; exit 1; }
fi

G=""; [ "$provider" = gbrain ] && G="--gbrain \$HOME/work/gbrain@${GBRAIN_SHA:0:9}"
$S ssh "$vm" "cat > ~/run.sh" <<EOS
echo \$\$ > ~/run.pid
set -a; . ~/.mpw-keys; set +a
export PATH=\$HOME/.bun/bin:\$HOME/.local/bin:\$PATH
cd ~/work/gbrain-evals
L="--budget-ledger \$HOME/cells/ledger.sqlite"
mkdir -p ~/cells
test -f ~/cells/ledger.sqlite || bun eval/runner/budget-ledger.ts init \$L --program-cap-usd $cap --reason "memory proof wave matched secondary row $name" >/dev/null
cid=\$(bun run harness:cell plan $spec --cells-dir ~/cells $G \$L 2>/dev/null | python3 -c "import json,sys; t=sys.stdin.read(); print(json.loads(t[t.index('{'):])['cell_id'])")
echo \$cid > ~/cells/cell-id
for attempt in 1 2 3 4; do
  if [ -f ~/cells/\$cid/summary.json ]; then break; fi
  if [ -d ~/cells/\$cid/stages ]; then step=resume; else step=run; fi
  echo "[vm] \$cid: \$step (attempt \$attempt)"
  bun run harness:cell \$step $spec --cells-dir ~/cells $G \$L
done
bun eval/runner/budget-ledger.ts status \$L > ~/cells/ledger-status.json 2>/dev/null
test -f ~/cells/\$cid/summary.json; echo \$? > ~/cells/exit
EOS
if ! $S ssh "$vm" 'test -f ~/cells/exit || { test -f ~/run.pid && kill -0 $(cat ~/run.pid) 2>/dev/null; }'; then
  log "starting the cell"
  $S ssh "$vm" 'nohup setsid bash ~/run.sh > ~/run.log 2>&1 < /dev/null &'
fi
until $S ssh "$vm" 'test -f ~/cells/exit' 2>/dev/null; do
  sleep 300
  $S ssh "$vm" 'c=$(cat ~/cells/cell-id 2>/dev/null); echo "$(date -u +%T) ingest=$(ls ~/cells/$c/stages/ingest 2>/dev/null | wc -l) answer=$(ls ~/cells/$c/stages/answer 2>/dev/null | wc -l) judge=$(ls ~/cells/$c/stages/judge 2>/dev/null | wc -l)"' >> "$M/progress.log" 2>/dev/null
done
log "cell exit $($S ssh "$vm" 'cat ~/cells/exit; tail -2 ~/run.log' | tr '\n' ' ' | cut -c1-300)"

# Receipt: the cell's JSON files (VM home paths scrubbed to ~/), its ledger status and a tarball of stages, scorer and the proxy request log. Request
# bodies stay out (gigabytes of extraction prompts); embedding bodies' input_type is kept for the read/ingest split.
cid=$($S ssh "$vm" 'cat ~/cells/cell-id')
$S ssh "$vm" "cd ~/cells/$cid && python3 - <<'PY'
import json, os
out = open('proxy/embedding-input-types.jsonl', 'w')
for line in open('proxy/requests.jsonl'):
    r = json.loads(line)
    p = f\"proxy/bodies/{r['body_sha256']}.json\"
    if r.get('kind') == 'embedding' and os.path.exists(p):
        out.write(json.dumps({'body_sha256': r['body_sha256'], 'input_type': json.load(open(p)).get('input_type')}) + '\n')
PY
tar -czf ~/receipt.tgz --exclude=proxy/bodies stages scorer proxy timestamp-manifest.json"
dest=$OUT/cells/$cid; mkdir -p "$dest"
$S ssh "$vm" "cd ~/cells/$cid && tar -cf - *.json" | tar -xf - -C "$dest"
$S ssh "$vm" 'cat ~/receipt.tgz' > "$dest/receipt.tgz"
$S ssh "$vm" 'cat ~/cells/ledger-status.json' > "$dest/ledger-status.json"
$S ssh "$vm" 'cat ~/cells/ledger.sqlite' > "$M/ledger.sqlite"
(cd "$REPO" && bun -e '
  import { readFileSync, writeFileSync } from "node:fs";
  import { scrubMachinePaths } from "./eval/runner/receipt.ts";
  for (const f of process.argv.slice(1)) writeFileSync(f, scrubMachinePaths(readFileSync(f, "utf8"), undefined, "/home/ubi"));
' "$dest"/*.json) || { log "path scrub failed; receipt not published"; exit 1; }
if tar -tzf "$dest/receipt.tgz" >/dev/null && [ -s "$dest/summary.json" ]; then
  MSG="mpw matched: receipt for $cid ($name)" publish "$dest" && log "receipt pushed"
  $S down "$vm" && log "destroyed $vm"
  echo "| $(date -u +%FT%TZ) | $name | \`$vm\` | destroyed after the receipt was pushed |" >> "$OUT/VMS.md"
  MSG="mpw matched: VM $vm destroyed ($name done)" publish "$OUT/VMS.md"
else
  log "receipt incomplete; VM $vm kept for a retry"
fi
