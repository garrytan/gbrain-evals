#!/usr/bin/env bash
# Memory proof wave, #6066 equivalence check on the public BEAM dev conversations: one Ubicloud VM per BEAM size,
# holding both gbrain lanes' cells and stores for every phase. Resumable; each phase's public receipt is committed and
# pushed as soon as it finishes. The VM is kept between phases (its stores are the replay inputs) and destroyed with
# `down` once the last phase is published.
#
#   bash eval/harness-provider/mpw-equivalence-vm.sh <100k|500k|1m> baseline
#   bash eval/harness-provider/mpw-equivalence-vm.sh <100k|500k|1m> down
#
# baseline: both lanes' cells (eval/harness-provider/cells/equivalence/beam-<size>-gbrain-{combined,raw}.json) run end
# to end on the freeze build, then each is replayed retrieval-only twice on the same build against copies of its store:
# the noise floor for every later diff.
#
# Env: UBICLOUD_API_TOKEN, GEMINI_API_KEY, OPENAI_API_KEY, VOYAGE_API_KEY; COMMIT (default HEAD, must be pushed);
# CAP_USD (the VM ledger's program cap for this phase). State lives in ~/.capy/work/mpw/equivalence/<size>. The VM's
# ledger is private: it stays on cloud machines and is mirrored by the operator, never committed.
set -uo pipefail
split=${1:?size}; phase=${2:?phase}
REPO=$(cd "$(dirname "$0")/../.." && pwd)
COMMIT=${COMMIT:-$(git -C "$REPO" rev-parse HEAD)}
S=${UBI_RUNNER:-/home/user/.capy/drive/user-garry-tan/skills/ubicloud/scripts/ubi-runner.sh}
export UBI_OWNER=gbra52 UBI_GC_HOURS=0 UBICLOUD_API_KEY=${UBICLOUD_API_KEY:-$UBICLOUD_API_TOKEN}
M=$HOME/.capy/work/mpw/equivalence/$split; mkdir -p "$M"
OUT=$REPO/docs/benchmarks/2026-10-10-memory-proof-wave-equivalence
BASE=d7467d1cf822442b965e435aa6979133edc96a72
HEAD_SHA=5002c91f1ca1a745f524e7dbb886e3feff676016
name=beam-$split
log() { echo "$(date -u +%FT%TZ) [$name $phase] $*" | tee -a "$M/watch.log"; }

publish() {
  (
    flock 9
    cd "$REPO" && git add "$@" && git commit -q -m "$MSG" && git fetch -q origin \
      && git merge -q --no-edit origin/capy/mpw-harness && git push -q origin HEAD:capy/mpw-harness
  ) 9>"$HOME/.capy/work/mpw/publish.lock"
}
vmlog() { mkdir -p "$OUT"; echo "| $(date -u +%FT%TZ) | $name | \`$1\` | $2 |" >> "$OUT/VMS.md"; MSG="mpw equivalence: VM $1 $2" publish "$OUT/VMS.md" || log "VM note push failed"; }

if [ "$phase" = down ]; then
  vm=$(cat "$M/vm"); $S down "$vm" && vmlog "$vm" destroyed && rm -f "$M/vm"; exit
fi

if [ ! -s "$M/vm" ]; then
  vm=$($S up) || { log "create failed"; exit 1; }
  echo "$vm" > "$M/vm"
  [ -f "$OUT/VMS.md" ] || printf '%s\n\n%s\n\n%s\n%s\n' "# Memory proof wave equivalence check: Ubicloud VMs" \
    "Every VM the equivalence check uses, recorded when it is created and when it is destroyed, so a lost run machine cannot strand one. Any VM listed as created without a later \"destroyed\" line can be removed from anywhere with \`UBI_OWNER=gbra52 ubi-runner.sh down <name>\`." \
    "| Time (UTC) | BEAM size | VM | Event |" "|---|---|---|---|" > "$OUT/VMS.md"
  vmlog "$vm" created
fi
vm=$(cat "$M/vm"); log "vm $vm"

NEW_SHA=d7d7686de0fb8e9ad24a16f89df6cc6a3166f0e7
if ! $S ssh "$vm" 'test -f ~/.mpw-setup-done' 2>/dev/null; then
  log "setup"
  printf 'GEMINI_API_KEY=%q\nOPENAI_API_KEY=%q\nVOYAGE_API_KEY=%q\n' "$GEMINI_API_KEY" "$OPENAI_API_KEY" "$VOYAGE_API_KEY" \
    | $S ssh "$vm" 'umask 077; cat > ~/.mpw-keys'
  $S ssh "$vm" "set -e
    sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq unzip build-essential >/dev/null
    curl -fsSL https://bun.sh/install | bash -s bun-v1.4.2 >/dev/null
    sudo ln -sf \$HOME/.bun/bin/bun /usr/local/bin/bun
    curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null
    git clone -q --filter=blob:none https://github.com/garrytan/gbrain ~/work/gbrain
    git -C ~/work/gbrain fetch -q origin $BASE $HEAD_SHA
    git -C ~/work/gbrain cat-file -e $BASE && git -C ~/work/gbrain cat-file -e $HEAD_SHA
    touch ~/.mpw-setup-done" > "$M/setup.log" 2>&1 || { log "setup failed"; tail -20 "$M/setup.log"; exit 1; }
fi
$S ssh "$vm" "git -C ~/work/gbrain fetch -q origin $NEW_SHA && git -C ~/work/gbrain cat-file -e $NEW_SHA" >> "$M/setup.log" 2>&1 || { log "fetch of $NEW_SHA failed"; exit 1; }
# The harness checkout follows COMMIT on every launch; cells and stores live outside it.
git -C "$REPO" archive --format=tar.gz "$COMMIT" | $S ssh "$vm" 'mkdir -p ~/work/gbrain-evals && tar -xzf - -C ~/work/gbrain-evals'
$S ssh "$vm" 'export PATH=$HOME/.bun/bin:$HOME/.local/bin:$PATH; cd ~/work/gbrain-evals && bun install --frozen-lockfile >/dev/null && bun run harness:setup >/dev/null' >> "$M/setup.log" 2>&1 \
  || { log "harness setup failed"; exit 1; }

if [ "$phase" = baseline ]; then
  $S ssh "$vm" "cat > ~/$phase.sh" <<EOS
set -a; . ~/.mpw-keys; set +a
export PATH=\$HOME/.bun/bin:\$HOME/.local/bin:\$PATH
cd ~/work/gbrain-evals
L="--budget-ledger \$HOME/eq/ledger.sqlite"; G="--gbrain \$HOME/work/gbrain@${BASE:0:9}"
mkdir -p ~/eq
test -f ~/eq/ledger.sqlite || bun eval/runner/budget-ledger.ts init \$L --program-cap-usd ${CAP_USD:?CAP_USD} --reason "mpw #6066 equivalence, beam $split" >/dev/null
python3 -c "import json,sys; sys.exit(json.load(sys.stdin)['totals']['program_cap_usd'] == ${CAP_USD})" < <(bun eval/runner/budget-ledger.ts status \$L) && bun eval/runner/budget-ledger.ts set-cap \$L --program-cap-usd ${CAP_USD} --reason "mpw #6066 equivalence, beam $split: $phase at $COMMIT (within the approved \$90 check)" >/dev/null
lane() {
  spec=eval/harness-provider/cells/equivalence/beam-$split-gbrain-\$1.json
  cid=\$(bun run harness:cell plan \$spec --cells-dir ~/eq/cells \$G \$L 2>/dev/null | python3 -c "import json,sys; t=sys.stdin.read(); print(json.loads(t[t.index('{'):])['cell_id'])")
  echo \$cid > ~/eq/\$1.cell
  for attempt in 1 2 3 4; do
    [ -f ~/eq/cells/\$cid/summary.json ] && break
    if [ -d ~/eq/cells/\$cid/stages ]; then step=resume; else step=run; fi
    echo "[vm] \$cid: \$step (attempt \$attempt)"
    bun run harness:cell \$step \$spec --cells-dir ~/eq/cells \$G \$L
  done
  [ -f ~/eq/cells/\$cid/summary.json ] || return 1
  store=\$HOME/eq/cells/_stores/\$(grep -oP '\[cell\] store \K\S+' ~/eq/\$1.log | tail -1)
  echo \$store > ~/eq/\$1.store
  for n in 1 2; do
    [ -f ~/eq/replay-base-\$n-\$cid/replay-diff.json ] && continue
    bun run harness:cell replay \$cid --store \$(cat ~/eq/\$1.store) --out ~/eq/replay-base-\$n-\$cid \$G --budget-usd 1 --cells-dir ~/eq/cells \$L
  done
}
lane combined > ~/eq/combined.log 2>&1 & a=\$!
lane raw > ~/eq/raw.log 2>&1 & b=\$!
wait \$a; ra=\$?; wait \$b; rb=\$?
bun eval/runner/budget-ledger.ts status \$L > ~/eq/ledger-status.json 2>/dev/null
echo "\$ra \$rb" > ~/eq/$phase-$COMMIT.exit
EOS
fi

if [ "$phase" = newhead ]; then
  $S ssh "$vm" "cat > ~/$phase.sh" <<EOS
rm -f ~/eq/nh.exit
NEW_SHA=$NEW_SHA bash ~/work/gbrain-evals/eval/harness-provider/mpw-equivalence-newhead.sh $split
cp ~/eq/nh.exit ~/eq/$phase-$COMMIT.exit
EOS
fi
X="~/eq/$phase-$COMMIT.exit"
if ! $S ssh "$vm" "test -f $X"; then
  until $S ssh "$vm" "test -f $X || ! { test -f ~/$phase.pid && kill -0 \$(cat ~/$phase.pid) 2>/dev/null; }"; do log "a $phase run is in progress"; sleep 300; done
  if ! $S ssh "$vm" "test -f $X"; then
    log "starting"
    $S ssh "$vm" "nohup setsid bash -c 'echo \$\$ > ~/$phase.pid; exec bash ~/$phase.sh' > ~/$phase.log 2>&1 < /dev/null &"
  fi
fi
until $S ssh "$vm" "test -f $X" 2>/dev/null; do
  sleep 300
  $S ssh "$vm" 'for l in combined raw; do c=$(cat ~/eq/$l.cell 2>/dev/null); echo "$(date -u +%T) $l ingest=$(ls ~/eq/cells/$c/stages/ingest 2>/dev/null | wc -l) answer=$(ls ~/eq/cells/$c/stages/answer 2>/dev/null | wc -l) judge=$(ls ~/eq/cells/$c/stages/judge 2>/dev/null | wc -l)"; done' >> "$M/progress.log" 2>/dev/null
done
log "exit $($S ssh "$vm" "cat $X")"

# Public receipt (paths scrubbed; the ledger stays private). baseline: per lane, the cell's JSON files and a tarball of
# its stages, scorer and request log (bodies out), plus each replay's diff and records. newhead: per lane, every
# replay's diff, spend and gzipped probe log, the store censuses, the changed-question lists, the re-answer and
# re-judge summaries, the extract --stale log, and the ingest guard.
dest=$OUT/$split/$phase; rm -rf "$dest"; mkdir -p "$dest"
if [ "$phase" = baseline ]; then
$S ssh "$vm" "cd ~/eq && rm -rf pub && for l in combined raw; do c=\$(cat \$l.cell); mkdir -p pub/\$l && cp cells/\$c/*.json pub/\$l/ \
  && (cd cells/\$c && tar -czf ~/eq/pub/\$l/receipt.tgz --exclude=proxy/bodies stages scorer proxy) \
  && for r in replay-base-*-\$c; do [ -d \$r ] && mkdir -p pub/\$l/\${r%-\$c} && cp \$r/replay-diff.json \$r/spend.json pub/\$l/\${r%-\$c}/ 2>/dev/null \
     && (cd \$r && tar -czf ~/eq/pub/\$l/\${r%-\$c}/records.tgz --exclude=store --exclude=proxy/bodies .); done; done; cp ledger-status.json pub/ 2>/dev/null; \
  tar -cf - -C pub ." | tar -xf - -C "$dest"
else
$S ssh "$vm" "cd ~/eq/nh && rm -rf ~/eq/pub-nh && mkdir -p ~/eq/pub-nh && cp ingest-guard.json ~/eq/pub-nh/ 2>/dev/null; cp ~/eq/ledger-status.json ~/eq/pub-nh/ 2>/dev/null; \
  for l in combined raw; do P=~/eq/pub-nh/\$l; mkdir -p \$P; cp \$l/census-*.json \$l/changed-*.json \$l/answer-*.skipped \$l/extract-stale.log \$P/ 2>/dev/null; \
    for r in p0-1 p0-2 r2a r2b r3; do [ -d \$l/\$r ] || continue; mkdir -p \$P/\$r; cp \$l/\$r/replay-diff.json \$l/\$r/spend.json \$P/\$r/ 2>/dev/null; gzip -c \$l/\$r/probe.jsonl > \$P/\$r/probe.jsonl.gz 2>/dev/null; \
      (cd \$l/\$r && tar -czf \$P/\$r/records.tgz --exclude=store --exclude=proxy/bodies --exclude=probe.jsonl --exclude=bun-probe.sh .); done; \
    for r in r2a r3; do [ -d \$l/answer-\$r ] && mkdir -p \$P/answer-\$r && cp \$l/answer-\$r/summary.json \$l/answer-\$r/unblinding.json \$P/answer-\$r/ 2>/dev/null; \
      for d in \$l/reanswer-\$r/*/; do [ -f \$d/spend.json ] && cp \$d/spend.json \$P/answer-\$r/reanswer-spend.json; done; done; \
    c=\$(grep -oP 'cell \K[a-z0-9-]+(?=:)' \$l/ingest.log | head -1); [ -n \"\$c\" ] && mkdir -p \$P/ingest && cp ~/eq/cells/\$c/*.json \$P/ingest/ 2>/dev/null; done; \
  tar -cf - -C ~/eq/pub-nh ." | tar -xf - -C "$dest"
fi
$S ssh "$vm" 'cat ~/eq/ledger.sqlite' > "$M/ledger.sqlite"
(cd "$REPO" && find "$dest" \( -name '*.json' -o -name '*.log' \) -print0 | xargs -0 bun -e '
  import { readFileSync, writeFileSync } from "node:fs";
  import { scrubMachinePaths } from "./eval/runner/receipt.ts";
  for (const f of process.argv.slice(1)) writeFileSync(f, scrubMachinePaths(readFileSync(f, "utf8"), undefined, "/home/ubi"));
') || { log "path scrub failed; receipt not published"; exit 1; }
MSG="mpw equivalence: beam $split $phase receipt" publish "$dest" && log "receipt pushed"
