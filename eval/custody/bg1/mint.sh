#!/usr/bin/env bash
# BG1 mint: plans, renders and checks the sealed changing-facts worlds in custody, one mint slot at a time, through
# eval/custody/bg1/render.ts (docs/benchmarks/2026-11-09-changing-facts-battleground-preregistration.md).
#
#   eval/custody/bg1/mint.sh [--bg1c [--tolerance 0.15] [--supply-ack <id>]] --out <dir>/bg1-custody --seed-file <path>.bg1-seed
#       --phrasing <path>.bg1-phrasing.json [--count <n>] [--start <slot>] [--target-tokens 200000] [--yield-gate-ack <id>]
#       (--fake [--fake-break <slot>:<session>:<attempts>,...]
#        | --budget-ledger <sqlite> --budget-run-id <id> --paid-window <unit> --window-cap-usd <n>)
#   eval/custody/bg1/mint.sh --bgw --batch <first slot> [--previous <previous batch's --out>] [--tolerance 0.15]
#       [--supply-ack <id>] --out <dir>/bgw-custody --seed-file <path>.bgw-seed --phrasing <path>.bgw-phrasing.json
#       [--count <n>] [--start <slot>] [--target-tokens 200000] [--yield-gate-ack <id>] (--fake ... | --budget-ledger ... as above)
#   eval/custody/bg1/mint.sh --dev --out <dir> [--worlds bg1-dev-01,...] [--target-tokens 200000]
#       (--fake [--fake-break <dev number>:<session>:<attempts>,...] | --budget-ledger ... as above)
#
# Two sealed sets share the seed, phrasing and world ids, each on slots of its own. Without --bg1c the mint is BG1's:
# slots 1 to 30, its kept list (BG1 planned 48 and released 31 to 48, never minted, to BG1-C on 2026-11-19). With
# --bg1c it is BG1-C's, the changing-facts confirmation (docs/benchmarks/2026-11-19-changing-facts-confirmation-
# preregistration.md): slots 31 to 96, minted in order from 31. --start defaults to the set's first slot and --count
# to the rest of its slots. A range that mixes the two sets refuses, and so does an --out whose set/worlds or render/
# holds a bg1-NNN entry outside the set's slots, so each set mints into a custody --out of its own and its drop counts
# never include the other's.
#
# What it guarantees:
#   - Output only counts and hashes. Every line is "bg1-mint key=value ...", render.ts's counts line, or a refusal
#     naming its reason. No world, question, phrasing or seed text is printed.
#   - Custody paths. --out must sit outside any git checkout and its name must start with "bg1-custody" (the sealed key
#     in .gstack/pregate.json refuses commits under such a path). The seed file (--seed-file or BG1_SEED_FILE, never a
#     default) must be named *.bg1-seed, sit outside any git checkout, be mode 600 or 400 and hold one line,
#     "bg1-seed-v1:" and 64 hex digits. The phrasing set (--phrasing or BG1_PHRASING_FILE) must be named
#     *.bg1-phrasing.json, sit outside any git checkout and be mode 600 or 400; render.ts checks that it carries the
#     custody marker, which every plan, world and question file then carries too. Files under --out are owner-only
#     (umask 077).
#   - Deterministic seeds. Slot i's world seed is HMAC-SHA256(seed line, "bg1/world/<i>") (changing-facts-gen.ts
#     sealedWorldSeed), for BG1 and BG1-C alike, and no file records it.
#   - Resume. A slot whose world is written from the same plan is skipped, and model replies are cached under
#     <out>/render-cache, so a rerun buys nothing twice. A recorded drop is final: a slot whose render record
#     (render/bg1-NNN.json) says dropped is never rendered again by any later invocation. mint.sh prints a
#     status=dropped_earlier line for it, counts it as dropped_earlier in the summary and leaves the record as it is.
#   - Yield gate. Two dropped worlds among the set's first five slots (1 to 5 for BG1, 31 to 35 for BG1-C) pause the
#     mint with exit 3. Drops are counted from the
#     render records under --out (render/bg1-NNN.json), so every invocation on one --out counts them, a resumed or
#     --start run included, and a run on an --out that already holds two pauses before it renders anything. A pause goes
#     to GBEV-3, whose approval id comes back as --yield-gate-ack (a- and 12 hex digits). mint.sh appends the id, the
#     time and the early-drop count to render/yield-gate-acks.jsonl, and from then on every invocation on that --out
#     counts only the drops past the latest acknowledged count, so two more pause it again. An ack is refused unless
#     the gate is paused, and so is an id an earlier pause used; the latest ack's id may be given again on a resumed
#     run. With no ack recorded, the gate is as above. Since a drop is final, the early-drop count never falls, so an
#     invocation that finds it below the latest ack's recorded count (a render record changed outside mint.sh) refuses
#     with exit 3 and a summary=refused line before it renders or acknowledges anything.
#   - BG1-C's drop cap and kept stop (--bg1c; --bgw per batch, below). Three dropped worlds among slots 31 to 96 pause the mint with exit 3
#     and a summary=paused reason=drop_cap line, counted from the render records as the yield gate counts. The same
#     --yield-gate-ack acknowledges either pause, and each ack line also records "drops", the total the drop cap
#     measures from. An ack moves only a paused gate's count: the yield gate's when it is paused, the drop cap's when it
#     is, so after a yield-gate ack the third drop in all still pauses, and after a drop-cap ack two early drops still
#     do. Three drops past the latest acknowledged total pause it again, and a total below it refuses as above. The
#     mint stops with exit 0 and a summary=kept line once 40 of BG1-C's slots hold a world that passed validation,
#     checked before the first slot and after each one.
#   - BG1-C's validation and top-up (--bg1c; --bgw per batch, below). The kept set is the first 40 slots that pass BG1's validation, so
#     after each written or skipped slot mint.sh runs validate.ts --slot on it (every deterministic gate, at
#     --target-tokens and --tolerance, default 0.15, and the duplicate gate against the earlier slots), which writes
#     render/bg1-NNN.validation.json and prints one counts-only line. Only a slot whose record says pass is kept, so the
#     mint goes on past a world that fails until 40 pass. A world that fails validation counts as a dropped world for
#     both stops and is never rendered again (BG1's Amendment 6 stop counts validation failures too); the summary lines
#     then end in invalid=<n>, this invocation's count. Once slot 96 is done with fewer than 40 kept, the mint pauses
#     with exit 3 and a summary=paused reason=slots_exhausted line, for GBEV-3. --fake-break <slot>:length (render.ts)
#     writes that slot's world over-long, the top-up drill. A --fake mint runs validate.ts --fake, which lets its template
#     worlds pass; a real one fails any template-rendered world. Before it renders, and before it reports kept, the mint
#     refuses (exit 2) when a slot from the set's first up to there is unresolved (no validation record and no dropped
#     render record), naming the slot to resume from, so an in-range --start never skips one.
#   - BG1-C's supply check (--bg1c; --bgw per batch, below; R111, the preregistration's pilot condition 3). Once slot 35 resolves (written
#     and validated, or dropped), and before a run that starts past slot 35 renders anything, mint.sh runs
#     eval/custody/bg1/supply.ts on slots 31 to 35 and prints its counts-only line; a run past slot 35 with any of them
#     unresolved refuses. More than 504 Gemini requests per kept world, or no kept world, pauses the mint with exit 3
#     and a summary=paused reason=supply line, for GBEV-3, before slot 36 renders, and every later run pauses the same
#     way. GBEV-3's approval id comes back as --supply-ack (a- and 12 hex digits), which mint.sh takes only while the
#     check fails and appends to render/supply-acks.jsonl; from then on the failed check prints supply=acked and the
#     mint goes on. A mint has one supply check, so an id other than the recorded one refuses.
#   - One ledger. A relative --budget-ledger is resolved once, against the directory mint.sh starts in, before the window
#     check, so the check, both proxies and render.ts all name the same ledger file. CDPATH is unset first, so a
#     relative --out or --budget-ledger never resolves against a directory the caller's CDPATH names.
#   - One key per proxy. Real mode needs the granted paid window: without --paid-window and --window-cap-usd, or with
#     the ledger's program cap or the run's budget unknown or above the window cap, it exits 2 before any proxy starts
#     (eval/runner/rs1/paid-window.ts check, the window guard in eval/runner/paid-arm.ts). Gemini's key comes only from
#     BG1_GEMINI_API_KEY in ~/.config/gbrain-evals/bg1.env (mode 600 or 400), never from GEMINI_API_KEY, and
#     claude-haiku-5-5's from ANTHROPIC_API_KEY in this shell. For each slot it starts two metering proxies
#     (eval/runner/harness-metering-proxy.ts), each holding only its own provider's key and joined to the open ledger
#     run, so every request is priced and reserved before it is sent. render.ts runs under 'env -i' with only their
#     ready files and never sees a real key. A key reaches its proxy through the environment, never a command line.
#
# Set W (--bgw), the weekly outcome line's own worlds (docs/benchmarks/2026-11-23-weekly-outcome-line-preregistration.md,
# "The worlds" and "Custody and exposure"; names and batch rules in eval/runner/memory-qa/bg1-names.ts): a third sealed set
# on slots 1001 and up, with its own seed file (*.bgw-seed, one "bgw-seed-v1:" line and 64 hex digits; slot i's world seed
# is HMAC-SHA256(seed line, "bgw/world/<i>"), changing-facts-gen.ts bgwWorldSeed) and phrasing set (*.bgw-phrasing.json),
# under the same mode and outside-checkout rules, and four-digit world ids (slot 1001 is bgw-1001). It mints one monthly
# batch per --out, whose name must start with bgw-custody: --batch names the batch by its first slot, which
# eval/custody/bg1/bgw-checks.ts batch checks before anything else (the batch's manifest template and split entries are
# committed, and it starts one slot past the end of the batch in --previous, or is its seed set's first batch, 1001 for
# W1). The batch's slots are its first slot and the 55 after it (56, BG1-C's 66 slots for 40 kept scaled to 34 and rounded
# down), and --start and --count stay inside them. The first run writes <out>/batch.json naming the set and batch, and a
# later run naming another batch refuses. Everything BG1-C does per slot applies to the batch: validation after each slot
# and the top-up, the yield gate on the batch's first five slots, the drop cap (two dropped worlds in the batch, BG1-C's
# three per 40 kept scaled to 34 and rounded down), the acknowledgements, the supply check on the batch's first five slots,
# the kept stop at 34 worlds (four weeks of eight and two spares) and slots_exhausted at the batch's last slot. An --out
# holding a bg1-NNN entry refuses a Set W mint, and one holding a bgw-NNNN entry refuses a BG1 or BG1-C mint.
#
# --fake renders with the template renderer and fake checks: no network, and no key or key file is read.
#
# A real --bg1c or --bgw mint first runs commitment.ts: the seed, its nonce and the phrasing must re-derive the commitment
# and phrasing SHA-256 that the set's seed check recorded beside the seed for launch amendment A, or the mint refuses
# (exit 2) before the window check or any proxy.
#
# --dev renders public dev worlds through render.ts --dev: stage 1's three, bg1-dev-01, -02 and -03 in that order, or
# the ones --worlds lists, in its order, from those three and the dev loop's 17 extra (bg1-dev-04 to bg1-dev-20),
# behind the same pair of metering proxies per world, on one ledger, after the same window check and with the same key
# sources as above. It reads no seed or phrasing file: render.ts plans each world from its public seed and refuses one
# whose plan or questions differ from the committed files. So it takes no --seed-file, --phrasing, --count, --start or
# --yield-gate-ack, and ignores BG1_SEED_FILE and BG1_PHRASING_FILE. --out must sit outside any git checkout, and it
# refuses a custody --out: one whose name starts with bg1-custody, in any case, or whose set/worlds or render/ holds a
# bg1-NNN entry, so dev worlds never sit beside sealed ones or share their render-cache. Output is counts and hashes. A dropped dev world stops the run with exit 3; the yield gate does
# not apply. At the end, or at a drop, it prints one render.ts --dev-report line per world it rendered: its attempts
# and, in real mode, its two proxies' requests and spend from the ledger. Layout under --out: set/
# (worlds/bg1-dev-NN/{plan,questions,world}.json and render/bg1-dev-NN.json; the root GBRAIN_EVALS_BG1_DEV_ROOT
# names), render-cache/ and proxy/.
#
# Layout under --out: set/ (worlds/bg1-NNN/{plan,questions,world}.json, the root GBRAIN_EVALS_BG1_SOURCE names),
# render/ (a counts-only record per slot), render-cache/ (model replies, holding BG1 text) and proxy/ (ready files,
# request logs and request bodies, holding BG1 text). All of it belongs in the encrypted archive.
set -euo pipefail
umask 077
unset CDPATH

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"

say() { printf 'bg1-mint %s\n' "$*"; }
die() { printf 'bg1-mint refused: %s\n' "$*" >&2; exit 2; }
file_mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }
owner_only() { case "$(file_mode "$1")" in 600|400) return 0 ;; *) return 1 ;; esac; }

OUT="" SEED_FILE="${BG1_SEED_FILE:-}" PHRASING="${BG1_PHRASING_FILE:-}" COUNT="" START="" TARGET=200000 MODE=real BREAKS=""
LEDGER="" RUN_ID="" WINDOW="" WINDOW_CAP="" ACK="" SUPPLY_ACK="" DEV=0 BG1C=0 BGW=0 BATCH="" PREVIOUS="" SEALED_ONLY="" DEV_WORLDS="bg1-dev-01,bg1-dev-02,bg1-dev-03" DEV_ONLY="" TOLERANCE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --dev) DEV=1; shift ;;
    --bg1c) BG1C=1; SEALED_ONLY+=" $1"; shift ;;
    --worlds) DEV_WORLDS="$2"; DEV_ONLY+=" $1"; shift 2 ;;
    --seed-file) SEED_FILE="$2"; SEALED_ONLY+=" $1"; shift 2 ;;
    --phrasing) PHRASING="$2"; SEALED_ONLY+=" $1"; shift 2 ;;
    --count) COUNT="$2"; SEALED_ONLY+=" $1"; shift 2 ;;
    --start) START="$2"; SEALED_ONLY+=" $1"; shift 2 ;;
    --target-tokens) TARGET="$2"; shift 2 ;;
    --tolerance) TOLERANCE="$2"; SEALED_ONLY+=" $1"; shift 2 ;;
    --fake) MODE=fake; shift ;;
    --fake-break) BREAKS="$2"; shift 2 ;;
    --budget-ledger) LEDGER="$2"; shift 2 ;;
    --budget-run-id) RUN_ID="$2"; shift 2 ;;
    --paid-window) WINDOW="$2"; shift 2 ;;
    --window-cap-usd) WINDOW_CAP="$2"; shift 2 ;;
    --yield-gate-ack) ACK="$2"; SEALED_ONLY+=" $1"; shift 2 ;;
    --supply-ack) SUPPLY_ACK="$2"; SEALED_ONLY+=" $1"; shift 2 ;;
    --bgw) BGW=1; SEALED_ONLY+=" $1"; shift ;;
    --batch) BATCH="$2"; SEALED_ONLY+=" $1"; shift 2 ;;
    --previous) PREVIOUS="$2"; SEALED_ONLY+=" $1"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) die "unknown argument $1" ;;
  esac
done

[ -n "$OUT" ] || die "--out is required"
if [ "$DEV" = 1 ]; then
  [ -z "$SEALED_ONLY" ] || die "--dev plans the public dev worlds from their public seeds and phrasing, so it takes no$SEALED_ONLY"
  case "$(basename "$OUT" | tr '[:upper:]' '[:lower:]')" in bg1-custody*|bgw-custody*) die "--dev never writes into a custody --out, so its name may not start with bg1-custody or bgw-custody" ;; esac
  for f in "$OUT"/set/worlds/bg1-[0-9][0-9][0-9]* "$OUT"/render/bg1-[0-9][0-9][0-9]*; do
    if [ -e "$f" ] || [ -L "$f" ]; then die "--dev never writes into a custody --out, and this one holds a sealed bg1-NNN entry under set/worlds or render/"; fi
  done
  for f in "$OUT"/set/worlds/bgw-[0-9][0-9][0-9][0-9]* "$OUT"/render/bgw-[0-9][0-9][0-9][0-9]*; do
    if [ -e "$f" ] || [ -L "$f" ]; then die "--dev never writes into a custody --out, and this one holds a sealed bgw-NNNN entry under set/worlds or render/"; fi
  done
else
  [ -z "$DEV_ONLY" ] || die "--worlds lists public dev worlds, so it needs --dev"
  [ -n "$SEED_FILE" ] || die "--seed-file (or BG1_SEED_FILE) is required; there is no default seed"
  [ -n "$PHRASING" ] || die "--phrasing (or BG1_PHRASING_FILE) is required; sealed worlds never use the public phrasing"
fi
# The set's slots, kept target and drop cap: BG1's 1 to 30; BG1-C's 31 to 96 with 40 kept and a cap of three drops
# (bg1-names.ts BG1C_FIRST_SLOT, BG1C_LAST_SLOT and BG1C_N_FINAL); or a Set W batch's 56 slots from --batch with 34 kept
# and a cap of two drops (BGW_BATCH_SLOTS, BGW_BATCH_KEPT and BGW_DROP_CAP). GATED marks the two sets that validate each
# slot and carry the drop cap, the kept stop and the supply check. KIND names the seed and phrasing files.
[ "$BGW" = 0 ] || [ "$BG1C" = 0 ] || die "--bgw and --bg1c name two different sealed sets; give one"
[ "$BGW" = 1 ] || [ -z "$BATCH$PREVIOUS" ] || die "--batch and --previous name a Set W batch, so they need --bgw"
if [ "$BGW" = 1 ]; then
  [[ "$BATCH" =~ ^[1-9][0-9]{3}$ ]] || die "--bgw needs --batch <first slot>, the four-digit first slot of the batch (1001 for the first)"
  SET="Set W batch bgw-$BATCH" FIRST=$BATCH LAST=$((BATCH + 55)) KEPT_TARGET=34 DROP_CAP=2 KIND=bgw GATED=1 SET_ARGS=(--bgw --batch "$BATCH") RENDER_ARGS=(--bgw)
elif [ "$BG1C" = 1 ]; then SET=BG1-C FIRST=31 LAST=96 KEPT_TARGET=40 DROP_CAP=3 KIND=bg1 GATED=1 SET_ARGS=(--bg1c) RENDER_ARGS=()
else SET=BG1 FIRST=1 LAST=30 KEPT_TARGET="" DROP_CAP="" KIND=bg1 GATED=0 SET_ARGS=() RENDER_ARGS=(); fi
if [ "$GATED" = 1 ]; then
  TOLERANCE="${TOLERANCE:-0.15}"
  [[ "$TOLERANCE" =~ ^0?\.[0-9]+$ && ! "$TOLERANCE" =~ ^0?\.0+$ ]] || die "--tolerance must be a decimal between 0 and 1"
elif [ -n "$TOLERANCE" ]; then
  die "--tolerance sets BG1-C's per-slot validation, so it needs --bg1c (or Set W's, with --bgw)"
fi
START="${START:-$FIRST}"
[[ "${COUNT:-0}" =~ ^[0-9]+$ && "$START" =~ ^[0-9]+$ ]] || die "--count and --start must be whole numbers"
START=$((10#$START))
COUNT=$((10#${COUNT:-$((LAST - START + 1 > 0 ? LAST - START + 1 : 0))}))
END=$((START + COUNT - 1))
if [ "$START" -le 30 ] && [ "$END" -ge 31 ]; then die "slots $START to $END mix BG1's slots (1 to 30) and BG1-C's (31 to 96); a mint covers one set"; fi
if [ "$BGW" = 0 ] && [ "$START" -ge 1001 ]; then die "slots 1001 and up are Set W's, so they need --bgw --batch <first slot>"; fi
if [ "$BG1C" = 0 ] && [ "$BGW" = 0 ] && [ "$START" -ge 31 ]; then die "slots 31 to 96 are BG1-C's, so they need --bg1c"; fi
[ "$START" -ge "$FIRST" ] && [ "$START" -le "$LAST" ] && [ "$END" -le "$LAST" ] || die "--start must be at least $FIRST and the last slot at most $LAST ($SET's slots)"
[[ "$TARGET" =~ ^[0-9]+$ ]] || die "--target-tokens must be a whole number"
[ "$MODE" = fake ] || [ -z "$BREAKS" ] || die "--fake-break is a --fake drill"
[ -z "$ACK" ] || [[ "$ACK" =~ ^a-[0-9a-f]{12}$ ]] || die "--yield-gate-ack takes GBEV-3's approval id, a- and 12 hex digits"
[ -z "$SUPPLY_ACK" ] || [ "$GATED" = 1 ] || die "--supply-ack acknowledges BG1-C's supply check, so it needs --bg1c (or Set W's, with --bgw)"
[ -z "$SUPPLY_ACK" ] || [[ "$SUPPLY_ACK" =~ ^a-[0-9a-f]{12}$ ]] || die "--supply-ack takes GBEV-3's approval id, a- and 12 hex digits"
if [ "$DEV" = 0 ]; then
  case "$(basename "$OUT")" in "$KIND"-custody*) ;; *) die "--out must be a directory whose name starts with $KIND-custody" ;; esac
  case "$SEED_FILE" in *."$KIND"-seed) ;; *) die "the seed file must be named *.$KIND-seed" ;; esac
  case "$PHRASING" in *."$KIND"-phrasing.json) ;; *) die "the phrasing file must be named *.$KIND-phrasing.json" ;; esac
  for f in "$OUT"/set/worlds/bg1-[0-9][0-9][0-9]* "$OUT"/render/bg1-[0-9][0-9][0-9]*; do
    [ -e "$f" ] || [ -L "$f" ] || continue
    entry="$(basename "$f")"
    [ "$BGW" = 0 ] || die "this --out holds $entry, which is not one of $SET's slots ($FIRST to $LAST); Set W mints into a custody --out of its own"
    slot=$((10#${entry:4:3}))
    [ "$slot" -ge "$FIRST" ] && [ "$slot" -le "$LAST" ] || die "this --out holds $entry, which is not one of $SET's slots ($FIRST to $LAST); BG1 and BG1-C each mint into a custody --out of their own"
  done
  for f in "$OUT"/set/worlds/bgw-* "$OUT"/render/bgw-*; do
    [ -e "$f" ] || [ -L "$f" ] || continue
    entry="$(basename "$f")"
    [ "$BGW" = 1 ] || die "this --out holds $entry, which is a Set W entry, not one of $SET's slots ($FIRST to $LAST); Set W mints into a custody --out of its own"
    [[ "${entry%%.*}" =~ ^bgw-([0-9]{4})$ ]] && [ "${BASH_REMATCH[1]}" -ge "$FIRST" ] && [ "${BASH_REMATCH[1]}" -le "$LAST" ] \
      || die "this --out holds $entry, which is not one of $SET's slots ($FIRST to $LAST); each Set W batch mints into a custody --out of its own"
  done
fi

command -v bun >/dev/null || die "bun is not on PATH"
BUN="$(command -v bun)"
# Set W: bgw-checks.ts batch refuses a batch that may not mint before anything is written or spent, and names its seed set.
BATCH_SET=""
if [ "$BGW" = 1 ]; then
  [ -z "$PREVIOUS" ] || { [ -d "$PREVIOUS" ] || die "--previous is not a directory"; PREVIOUS="$(cd "$PREVIOUS" && pwd)"; }
  BATCH_LINE="$(env -i PATH=/usr/bin:/bin HOME="$HOME" LANG=C.UTF-8 TZ=UTC "$BUN" "$HERE/bgw-checks.ts" batch --batch "$BATCH" ${PREVIOUS:+--previous "$PREVIOUS"})" || exit 2
  [[ "$BATCH_LINE" =~ \ set=(W[0-9]+)\  ]] || die "bgw-checks.ts batch printed no seed set"
  BATCH_SET="${BASH_REMATCH[1]}"
  BATCH_RECORD="{\"set\":\"$BATCH_SET\",\"batch\":\"bgw-$BATCH\"}"
  if [ -e "$OUT/batch.json" ] || [ -L "$OUT/batch.json" ]; then
    [ "$(cat "$OUT/batch.json")" = "$BATCH_RECORD" ] || die "this --out is another batch's (its batch.json does not name bgw-$BATCH); each Set W batch mints into a custody --out of its own"
  fi
fi
BG1_KEY=""
# BG1-C and Set W: a real mint renders only from the seed and phrasing its seed commitment file records (commitment.ts).
if [ "$MODE" = real ] && [ "$GATED" = 1 ]; then
  env -i PATH=/usr/bin:/bin HOME="$HOME" LANG=C.UTF-8 TZ=UTC "$BUN" "$HERE/commitment.ts" "${SET_ARGS[0]}" --seed-file "$SEED_FILE" --phrasing "$PHRASING" || exit 2
fi
if [ "$MODE" = real ]; then
  [ -n "$WINDOW" ] && [ -n "$WINDOW_CAP" ] || die "real mode spends real keys, so it needs --paid-window <unit> and --window-cap-usd <n> from the granted paid window (--fake spends nothing)"
  [ -n "$LEDGER" ] && [ -n "$RUN_ID" ] || die "real mode needs --budget-ledger and --budget-run-id (an open BG1 ledger run)"
  [ -d "$(dirname "$LEDGER")" ] || die "the --budget-ledger directory does not exist"
  LEDGER="$(cd "$(dirname "$LEDGER")" && pwd)/$(basename "$LEDGER")"
  "$BUN" "$REPO/eval/runner/rs1/paid-window.ts" check --paid-window "$WINDOW" --window-cap-usd "$WINDOW_CAP" --budget-ledger "$LEDGER" --budget-run-id "$RUN_ID" >/dev/null || exit 2
  KEY_FILE="$HOME/.config/gbrain-evals/bg1.env"
  [ -f "$KEY_FILE" ] || die "real mode takes Gemini's key only from BG1_GEMINI_API_KEY in ~/.config/gbrain-evals/bg1.env, which does not exist"
  owner_only "$KEY_FILE" || die "~/.config/gbrain-evals/bg1.env must be mode 600 or 400"
  BG1_KEY="$(sed -nE 's/^(export[[:space:]]+)?BG1_GEMINI_API_KEY=//p' "$KEY_FILE" | tail -n 1)"
  BG1_KEY="${BG1_KEY%\"}"
  BG1_KEY="${BG1_KEY#\"}"
  [ -n "$BG1_KEY" ] || die "~/.config/gbrain-evals/bg1.env has no BG1_GEMINI_API_KEY line"
  test -n "${ANTHROPIC_API_KEY:-}" || die "ANTHROPIC_API_KEY is not set (claude-haiku-5-5 is the second validator)"
fi

inside_checkout() {
  local d="$1"
  while [ ! -d "$d" ]; do d="$(dirname "$d")"; done
  git -C "$d" rev-parse --is-inside-work-tree >/dev/null 2>&1
}
inside_checkout "$OUT" && die "--out must sit outside any git checkout"
if [ "$DEV" = 0 ]; then
  for f in "$SEED_FILE" "$PHRASING"; do
    [ -f "$f" ] || die "$(basename "$f") does not exist"
    inside_checkout "$(cd "$(dirname "$f")" && pwd)" && die "$(basename "$f") must sit outside any git checkout"
    owner_only "$f" || die "$(basename "$f") must be mode 600 or 400"
  done
  grep -Eqx "$KIND-seed-v1:[0-9a-f]{64}" "$SEED_FILE" && [ "$(grep -c '' "$SEED_FILE")" -eq 1 ] || die "the seed file does not hold one $KIND-seed-v1 line"
  SEED_FILE="$(cd "$(dirname "$SEED_FILE")" && pwd)/$(basename "$SEED_FILE")"
  PHRASING="$(cd "$(dirname "$PHRASING")" && pwd)/$(basename "$PHRASING")"
  mkdir -p "$OUT/render"
  [ "$BGW" = 0 ] || [ -e "$OUT/batch.json" ] || printf '%s\n' "$BATCH_RECORD" > "$OUT/batch.json"
  [ "$BGW" = 0 ] || printf '%s\n' "$BATCH_LINE"
fi
mkdir -p "$OUT/set/worlds" "$OUT/render-cache"
OUT="$(cd "$OUT" && pwd)"

PIDS=()
stop_proxies() {
  local pid
  for pid in ${PIDS[@]+"${PIDS[@]}"}; do kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; done
  PIDS=()
}
trap stop_proxies EXIT

# Starts a metering proxy for one slot and one provider, holding only that provider's key, and waits for its ready file.
start_proxy() {
  local id="$1" provider="$2" ready="$OUT/proxy/ready/$1-$2.json" keep name
  case "$provider" in gemini) keep=GEMINI_API_KEY ;; anthropic) keep=ANTHROPIC_API_KEY ;; esac
  mkdir -p "$OUT/proxy/ready" "$OUT/proxy/requests" "$OUT/proxy/bodies"
  rm -f "$ready"
  (
    if [ "$provider" = gemini ]; then GEMINI_API_KEY="$BG1_KEY"; export GEMINI_API_KEY; fi
    drop=()
    for name in $(compgen -e); do case "$name" in PATH|HOME|"$keep") ;; *) drop+=(-u "$name") ;; esac; done
    exec env ${drop[@]+"${drop[@]}"} "$BUN" "$REPO/eval/runner/harness-metering-proxy.ts" \
      --budget-ledger "$LEDGER" --budget-run-id "$RUN_ID" --cell-id "bg1-$id-$provider" --labels bg1 --ready-file "$ready" \
      --request-log "$OUT/proxy/requests/$id-$provider.jsonl" --bodies-dir "$OUT/proxy/bodies"
  ) >>"$OUT/proxy/$id-$provider.log" 2>&1 &
  PIDS+=($!)
  for _ in $(seq 1 100); do [ -s "$ready" ] && break; sleep 0.1; done
  [ -s "$ready" ] || die "the $provider metering proxy for $id did not start"
}

# Renders one world through render.ts with the given arguments, in real mode behind its own pair of metering proxies,
# and prints render.ts's line. Sets LINE and RC.
render_one() {
  local id="$1"
  shift
  local allow=(PATH=/usr/bin:/bin HOME="$HOME" LANG=C.UTF-8 TZ=UTC) args=("$@" --cache "$OUT/render-cache" --target-tokens "$TARGET")
  if [ "$MODE" = fake ]; then
    args+=(--fake)
    [ -z "$BREAKS" ] || args+=(--fake-break "$BREAKS")
  else
    start_proxy "$id" gemini
    start_proxy "$id" anthropic
    allow+=(BG1_GEMINI_READY="$OUT/proxy/ready/$id-gemini.json" BG1_ANTHROPIC_READY="$OUT/proxy/ready/$id-anthropic.json")
    args+=(--paid-window "$WINDOW" --window-cap-usd "$WINDOW_CAP" --budget-ledger "$LEDGER" --budget-run-id "$RUN_ID")
  fi
  RC=0
  LINE="$(cd "$OUT" && env -i "${allow[@]}" "$BUN" "$HERE/render.ts" "${args[@]}")" || RC=$?
  stop_proxies
  [ -z "$LINE" ] || printf '%s\n' "$LINE"
}

WRITTEN=0 SKIPPED=0 DROPPED=0 DROPPED_EARLIER=0 INVALID=0
if [ "$DEV" = 1 ]; then
  RENDERED=()
  dev_report() {
    local id ledger=()
    [ "$MODE" = fake ] || ledger=(--budget-ledger "$LEDGER" --budget-run-id "$RUN_ID")
    for id in ${RENDERED[@]+"${RENDERED[@]}"}; do
      (cd "$OUT" && env -i PATH=/usr/bin:/bin HOME="$HOME" LANG=C.UTF-8 TZ=UTC "$BUN" "$HERE/render.ts" --dev-report "$id" --set "$OUT/set" ${ledger[@]+"${ledger[@]}"})
    done
  }
  IFS=, read -r -a DEV_IDS <<<"$DEV_WORLDS"
  [ ${#DEV_IDS[@]} -gt 0 ] || die "--worlds names no world"
  for id in "${DEV_IDS[@]}"; do
    [[ "$id" =~ ^bg1-dev-(0[1-9]|1[0-9]|20)$ ]] || die "--worlds takes bg1-dev-01 to bg1-dev-20, not $id"
  done
  [ "$(printf '%s\n' "${DEV_IDS[@]}" | sort | uniq -d)" = "" ] || die "--worlds lists a world twice"
  for id in "${DEV_IDS[@]}"; do
    render_one "$id" --dev "$id" --set "$OUT/set"
    RENDERED+=("$id")
    case "$RC" in
      0) case "$LINE" in *" status=skipped "*) SKIPPED=$((SKIPPED + 1)) ;; *) WRITTEN=$((WRITTEN + 1)) ;; esac ;;
      11)
        dev_report
        say "summary=stopped reason=dev_world_dropped mode=$MODE world=$id written=$WRITTEN skipped=$SKIPPED"
        exit 3 ;;
      *) exit "$RC" ;;
    esac
  done
  dev_report
  say "summary=dev mode=$MODE worlds=${#DEV_IDS[@]} written=$WRITTEN skipped=$SKIPPED"
  exit 0
fi

# Slot $1's world id: bg1- and three digits, or Set W's bgw- and four.
world_id() { if [ "$BGW" = 1 ]; then printf 'bgw-%d' "$1"; else printf 'bg1-%03d' "$1"; fi; }
# True when world $1's render record under --out says dropped, whichever invocation dropped it, or (BG1-C and Set W)
# its validation record says fail.
dropped_record() {
  grep -Eq '"status": ?"dropped"' "$OUT/render/$1.json" 2>/dev/null || { [ "$GATED" = 1 ] && grep -Eq '"status": ?"fail"' "$OUT/render/$1.validation.json" 2>/dev/null; }
}
# BG1-C: " invalid=<n>" for summary lines once this invocation has a world that failed validation.
invalid_tail() { [ "$INVALID" = 0 ] || printf ' invalid=%s' "$INVALID"; }
# The dropped worlds among slots $1 to $2 that the render records under --out hold.
drops_among() {
  local n=0 s
  for ((s = $1; s <= $2; s++)); do dropped_record "$(world_id "$s")" && n=$((n + 1)); done
  printf '%s' "$n"
}
# The yield gate's early drops, among the set's first five slots, and BG1-C's drops among all its slots.
early_drops() { drops_among "$FIRST" $((FIRST + 4)); }
all_drops() { drops_among "$FIRST" "$LAST"; }
ACKS="$OUT/render/yield-gate-acks.jsonl"
# Sets ACK_EARLY and ACK_DROPS to the early-drop count and (BG1-C) the total the latest acknowledgement recorded, or
# 0 with none recorded.
ack_counts() {
  local re last
  ACK_EARLY=0 ACK_DROPS=0
  [ -s "$ACKS" ] || return 0
  last="$(tail -n 1 "$ACKS")"
  if [ "$GATED" = 1 ]; then re='^\{"ack":"a-[0-9a-f]{12}","at":"[0-9TZ:-]*","early_drops":([0-9]+),"drops":([0-9]+)\}$'
  else re='^\{"ack":"a-[0-9a-f]{12}","at":"[0-9TZ:-]*","early_drops":([0-9]+)\}$'; fi
  [[ "$last" =~ $re ]] || die "render/yield-gate-acks.jsonl ends in a line that is not an acknowledgement"
  ACK_EARLY=$((10#${BASH_REMATCH[1]}))
  ACK_DROPS=$((10#${BASH_REMATCH[2]:-0}))
}
# Exits 3 when the early-drop count $1 is below the latest ack's count $2: a recorded drop is final, so the count falls
# only when a render record changed outside mint.sh.
drops_kept() {
  [ "$1" -lt "$2" ] || return 0
  say "summary=refused reason=early_drops_below_ack mode=$MODE written=$WRITTEN skipped=$SKIPPED dropped=$DROPPED last_slot=$3 early_drops=$1 acked_drops=$2"
  exit 3
}
# BG1-C: the same refusal for the drop cap's total.
total_drops_kept() {
  [ "$1" -lt "$2" ] || return 0
  say "summary=refused reason=drops_below_ack mode=$MODE written=$WRITTEN skipped=$SKIPPED dropped=$DROPPED last_slot=$3 drops=$1 acked_total_drops=$2"
  exit 3
}
# Pauses with exit 3 on two early drops past the latest acknowledged count, or, for BG1-C, three drops past the latest
# acknowledged total; refuses with exit 3 when either count is below its acknowledged one. $1 is the last slot.
yield_gate() {
  local n m
  n="$(early_drops)"
  m="$(all_drops)"
  ack_counts
  drops_kept "$n" "$ACK_EARLY" "$1"
  [ "$GATED" = 0 ] || total_drops_kept "$m" "$ACK_DROPS" "$1"
  local tail_counts
  tail_counts="$([ "$DROPPED_EARLIER" = 0 ] || printf ' dropped_earlier=%s' "$DROPPED_EARLIER")"
  if [ $((n - ACK_EARLY)) -ge 2 ]; then
    say "summary=paused reason=yield_gate mode=$MODE written=$WRITTEN skipped=$SKIPPED dropped=$DROPPED last_slot=$1 early_drops=$n$([ ! -s "$ACKS" ] || printf ' acked_drops=%s' "$ACK_EARLY")$([ "$GATED" = 0 ] || printf ' drops=%s' "$m")$tail_counts$(invalid_tail)"
    exit 3
  fi
  [ "$GATED" = 1 ] && [ $((m - ACK_DROPS)) -ge "$DROP_CAP" ] || return 0
  say "summary=paused reason=drop_cap mode=$MODE written=$WRITTEN skipped=$SKIPPED dropped=$DROPPED last_slot=$1 drops=$m$([ ! -s "$ACKS" ] || printf ' acked_total_drops=%s' "$ACK_DROPS")$tail_counts$(invalid_tail)"
  exit 3
}
# BG1-C: the slots among 31 to 96 whose validation record says pass.
kept_worlds() {
  local n=0 s
  for ((s = FIRST; s <= LAST; s++)); do ! grep -Eq '"status": ?"pass"' "$OUT/render/$(world_id "$s").validation.json" 2>/dev/null || n=$((n + 1)); done
  printf '%s' "$n"
}
# BG1-C: validates slot $1's world (validate.ts --slot), which writes its validation record, and prints its line; a
# fail adds to INVALID.
validate_slot() {
  local line rc=0
  line="$(cd "$OUT" && env -i PATH=/usr/bin:/bin HOME="$HOME" LANG=C.UTF-8 TZ=UTC "$BUN" "$HERE/validate.ts" ${SET_ARGS[@]+"${SET_ARGS[@]}"} --slot "$1" --set "$OUT/set" \
    --seed-file "$SEED_FILE" --phrasing "$PHRASING" --target-tokens "$TARGET" --tolerance "$TOLERANCE" $([ "$MODE" != fake ] || printf -- --fake))" || rc=$?
  [ -z "$line" ] || printf '%s\n' "$line"
  case "$rc" in 0) ;; 12) INVALID=$((INVALID + 1)) ;; *) exit "$rc" ;; esac
}
SUPPLY_ACKS="$OUT/render/supply-acks.jsonl"
# BG1-C: supply.ts's counts-only line over slots 31 to 35, run with no key; supply_run exits with its code.
supply_run() { (cd "$OUT" && env -i PATH=/usr/bin:/bin HOME="$HOME" LANG=C.UTF-8 TZ=UTC "$BUN" "$HERE/supply.ts" ${SET_ARGS[@]+"${SET_ARGS[@]}"} --out "$OUT"); }
# BG1-C: the approval id render/supply-acks.jsonl records for a failed supply check, or nothing with none recorded.
supply_acked() {
  local last re='^\{"ack":"(a-[0-9a-f]{12})","at":"[0-9TZ:-]*"\}$'
  [ -s "$SUPPLY_ACKS" ] || return 0
  last="$(tail -n 1 "$SUPPLY_ACKS")"
  [[ "$last" =~ $re ]] || die "render/supply-acks.jsonl ends in a line that is not an acknowledgement"
  printf '%s' "${BASH_REMATCH[1]}"
}
# BG1-C: runs supply.ts on slots 31 to 35 and prints its line. Over its limit (exit 12) the mint pauses with exit 3
# unless GBEV-3's approval is recorded; supply.ts's refusal (a slot among 31 to 35 unresolved) or any other failure
# exits with its code. $1 is the last slot.
supply_check() {
  [ "$GATED" = 1 ] || return 0
  local line rc=0 acked
  line="$(supply_run)" || rc=$?
  [ -z "$line" ] || printf '%s\n' "$line"
  case "$rc" in
    0) return 0 ;;
    12) ;;
    *) exit "$rc" ;;
  esac
  acked="$(supply_acked)"
  if [ -n "$acked" ]; then say "supply=acked ack=$acked"; return 0; fi
  say "summary=paused reason=supply mode=$MODE written=$WRITTEN skipped=$SKIPPED dropped=$DROPPED dropped_earlier=$DROPPED_EARLIER last_slot=$1$(invalid_tail)"
  exit 3
}
# BG1-C and Set W: refuses (exit 2) when a slot from the set's first through $1 is unresolved, with neither a validation
# record nor a dropped render record, so a mint never reports kept or renders past a slot an in-range --start skipped.
unresolved_check() {
  [ "$GATED" = 1 ] || return 0
  local s id
  for ((s = FIRST; s <= $1; s++)); do
    id="$(world_id "$s")"
    [ -e "$OUT/render/$id.validation.json" ] || dropped_record "$id" || die "slot $s ($id) is unresolved: it has neither a validation record nor a dropped render record, so resume the mint with --start $s"
  done
}
# BG1-C: stops the mint with exit 0 once KEPT_TARGET worlds are kept, after unresolved_check. $1 is the last slot.
kept_stop() {
  [ -n "$KEPT_TARGET" ] || return 0
  local k
  k="$(kept_worlds)"
  [ "$k" -ge "$KEPT_TARGET" ] || return 0
  unresolved_check "$1"
  say "summary=kept mode=$MODE kept=$k written=$WRITTEN skipped=$SKIPPED dropped=$DROPPED dropped_earlier=$DROPPED_EARLIER last_slot=$1$(invalid_tail)"
  exit 0
}
if [ -n "$ACK" ] && ! { [ -s "$ACKS" ] && tail -n 1 "$ACKS" | grep -Fq "{\"ack\":\"$ACK\","; }; then
  ! grep -Fq "{\"ack\":\"$ACK\"," "$ACKS" 2>/dev/null || die "approval $ACK acknowledged an earlier pause; a new pause needs a new approval"
  ! grep -Fq "{\"ack\":\"$ACK\"," "$SUPPLY_ACKS" 2>/dev/null || die "approval $ACK acknowledged the supply check; a yield-gate or drop-cap pause needs an approval of its own"
  n="$(early_drops)"
  m="$(all_drops)"
  ack_counts
  drops_kept "$n" "$ACK_EARLY" $((START - 1))
  if [ "$GATED" = 0 ]; then
    [ $((n - ACK_EARLY)) -ge 2 ] || die "the yield gate is not paused on this --out, so --yield-gate-ack has nothing to acknowledge"
    printf '{"ack":"%s","at":"%s","early_drops":%s}\n' "$ACK" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$n" >> "$ACKS"
    say "yield_gate_ack=$ACK early_drops=$n"
  else
    total_drops_kept "$m" "$ACK_DROPS" $((START - 1))
    early=$ACK_EARLY total=$ACK_DROPS
    [ $((n - ACK_EARLY)) -lt 2 ] || early=$n
    [ $((m - ACK_DROPS)) -lt "$DROP_CAP" ] || total=$m
    [ "$early" != "$ACK_EARLY" ] || [ "$total" != "$ACK_DROPS" ] || die "neither the yield gate nor the drop cap is paused on this --out, so --yield-gate-ack has nothing to acknowledge"
    printf '{"ack":"%s","at":"%s","early_drops":%s,"drops":%s}\n' "$ACK" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$early" "$total" >> "$ACKS"
    say "yield_gate_ack=$ACK early_drops=$early drops=$total"
  fi
fi
if [ -n "$SUPPLY_ACK" ]; then
  ! grep -Fq "{\"ack\":\"$SUPPLY_ACK\"," "$ACKS" 2>/dev/null || die "approval $SUPPLY_ACK acknowledged a yield-gate or drop-cap pause; the supply check needs an approval of its own"
  acked="$(supply_acked)"
  if [ -n "$acked" ]; then
    [ "$acked" = "$SUPPLY_ACK" ] || die "the supply check on this --out is already acknowledged by $acked, and a mint has one supply check"
  else
    rc=0
    supply_run >/dev/null || rc=$?
    case "$rc" in
      12) printf '{"ack":"%s","at":"%s"}\n' "$SUPPLY_ACK" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$SUPPLY_ACKS"
          say "supply_ack=$SUPPLY_ACK" ;;
      0) die "the supply check passes on this --out, so --supply-ack has nothing to acknowledge" ;;
      *) exit "$rc" ;;
    esac
  fi
fi
yield_gate $((START - 1))
kept_stop $((START - 1))
[ "$START" -le $((FIRST + 4)) ] || supply_check $((START - 1))
unresolved_check $((START - 1))
for ((slot = START; slot < START + COUNT; slot++)); do
  id="$(world_id "$slot")"
  if dropped_record "$id"; then
    DROPPED_EARLIER=$((DROPPED_EARLIER + 1))
    say "slot=$slot world=$id status=dropped_earlier"
    [ "$slot" -ne $((FIRST + 4)) ] || supply_check "$slot"
    continue
  fi
  render_one "$id" --set "$OUT/set" --seed-file "$SEED_FILE" --phrasing "$PHRASING" --slot "$slot" ${RENDER_ARGS[@]+"${RENDER_ARGS[@]}"}
  case "$RC" in
    0) case "$LINE" in *" status=skipped "*) SKIPPED=$((SKIPPED + 1)) ;; *) WRITTEN=$((WRITTEN + 1)) ;; esac ;;
    11) DROPPED=$((DROPPED + 1)) ;;
    *) exit "$RC" ;;
  esac
  [ "$GATED" = 0 ] || [ "$RC" != 0 ] || validate_slot "$slot"
  yield_gate "$slot"
  [ "$slot" -ne $((FIRST + 4)) ] || supply_check "$slot"
  kept_stop "$slot"
done

if [ "$GATED" = 1 ] && [ "$END" -eq "$LAST" ]; then
  say "summary=paused reason=slots_exhausted mode=$MODE kept=$(kept_worlds) written=$WRITTEN skipped=$SKIPPED dropped=$DROPPED dropped_earlier=$DROPPED_EARLIER last_slot=$LAST$(invalid_tail)"
  exit 3
fi
say "summary=mint mode=$MODE slots=$COUNT written=$WRITTEN skipped=$SKIPPED dropped=$DROPPED dropped_earlier=$DROPPED_EARLIER$([ -z "$KEPT_TARGET" ] || printf ' kept=%s' "$(kept_worlds)")$(invalid_tail)"
