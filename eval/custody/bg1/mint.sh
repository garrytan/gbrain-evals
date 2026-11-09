#!/usr/bin/env bash
# BG1 mint: plans, renders and checks the sealed changing-facts worlds in custody, one mint slot at a time, through
# eval/custody/bg1/render.ts (docs/benchmarks/2026-11-09-changing-facts-battleground-preregistration.md).
#
#   eval/custody/bg1/mint.sh --out <dir>/bg1-custody --seed-file <path>.bg1-seed --phrasing <path>.bg1-phrasing.json
#       [--count 48] [--start 1] [--target-tokens 200000] [--yield-gate-ack <approval id>]
#       (--fake [--fake-break <slot>:<session>:<attempts>,...]
#        | --budget-ledger <sqlite> --budget-run-id <id> --paid-window <unit> --window-cap-usd <n>)
#   eval/custody/bg1/mint.sh --dev --out <dir> [--target-tokens 200000]
#       (--fake [--fake-break <dev number>:<session>:<attempts>,...] | --budget-ledger ... as above)
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
#     sealedWorldSeed), and no file records it.
#   - Resume. A slot whose world is written from the same plan is skipped, and model replies are cached under
#     <out>/render-cache, so a rerun buys nothing twice.
#   - Yield gate. Two dropped worlds among mint slots 1 to 5 pause the mint with exit 3. Drops are counted from the
#     render records under --out (render/bg1-NNN.json), so every invocation on one --out counts them, a resumed or
#     --start run included, and a run on an --out that already holds two pauses before it renders anything. A pause goes
#     to GBEV-3, whose approval id comes back as --yield-gate-ack (a- and 12 hex digits). mint.sh appends the id, the
#     time and the early-drop count to render/yield-gate-acks.jsonl, and from then on every invocation on that --out
#     counts only the drops past the latest acknowledged count, so two more pause it again. An ack is refused unless
#     the gate is paused, and so is an id an earlier pause used; the latest ack's id may be given again on a resumed
#     run. With no ack recorded, the gate is as above.
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
# --fake renders with the template renderer and fake checks: no network, and no key or key file is read.
#
# --dev renders stage 1's three public dev worlds, bg1-dev-01, -02 and -03 in that order, through render.ts --dev,
# behind the same pair of metering proxies per world, on one ledger, after the same window check and with the same key
# sources as above. It reads no seed or phrasing file: render.ts plans each world from its public seed and refuses one
# whose plan or questions differ from the committed files. So it takes no --seed-file, --phrasing, --count, --start or
# --yield-gate-ack, and ignores BG1_SEED_FILE and BG1_PHRASING_FILE. --out must sit outside any git checkout and needs
# no bg1-custody name. Output is counts and hashes. A dropped dev world stops the run with exit 3; the yield gate does
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

OUT="" SEED_FILE="${BG1_SEED_FILE:-}" PHRASING="${BG1_PHRASING_FILE:-}" COUNT=48 START=1 TARGET=200000 MODE=real BREAKS=""
LEDGER="" RUN_ID="" WINDOW="" WINDOW_CAP="" ACK="" DEV=0 SEALED_ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --dev) DEV=1; shift ;;
    --seed-file) SEED_FILE="$2"; SEALED_ONLY+=" $1"; shift 2 ;;
    --phrasing) PHRASING="$2"; SEALED_ONLY+=" $1"; shift 2 ;;
    --count) COUNT="$2"; SEALED_ONLY+=" $1"; shift 2 ;;
    --start) START="$2"; SEALED_ONLY+=" $1"; shift 2 ;;
    --target-tokens) TARGET="$2"; shift 2 ;;
    --fake) MODE=fake; shift ;;
    --fake-break) BREAKS="$2"; shift 2 ;;
    --budget-ledger) LEDGER="$2"; shift 2 ;;
    --budget-run-id) RUN_ID="$2"; shift 2 ;;
    --paid-window) WINDOW="$2"; shift 2 ;;
    --window-cap-usd) WINDOW_CAP="$2"; shift 2 ;;
    --yield-gate-ack) ACK="$2"; SEALED_ONLY+=" $1"; shift 2 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) die "unknown argument $1" ;;
  esac
done

[ -n "$OUT" ] || die "--out is required"
if [ "$DEV" = 1 ]; then
  [ -z "$SEALED_ONLY" ] || die "--dev plans the public dev worlds from their public seeds and phrasing, so it takes no$SEALED_ONLY"
else
  [ -n "$SEED_FILE" ] || die "--seed-file (or BG1_SEED_FILE) is required; there is no default seed"
  [ -n "$PHRASING" ] || die "--phrasing (or BG1_PHRASING_FILE) is required; sealed worlds never use the public phrasing"
fi
[[ "$COUNT" =~ ^[0-9]+$ && "$START" =~ ^[0-9]+$ ]] || die "--count and --start must be whole numbers"
[ "$START" -ge 1 ] && [ $((START + COUNT - 1)) -le 48 ] || die "--start must be at least 1 and the last slot at most 48"
[[ "$TARGET" =~ ^[0-9]+$ ]] || die "--target-tokens must be a whole number"
[ "$MODE" = fake ] || [ -z "$BREAKS" ] || die "--fake-break is a --fake drill"
[ -z "$ACK" ] || [[ "$ACK" =~ ^a-[0-9a-f]{12}$ ]] || die "--yield-gate-ack takes GBEV-3's approval id, a- and 12 hex digits"
if [ "$DEV" = 0 ]; then
  case "$(basename "$OUT")" in bg1-custody*) ;; *) die "--out must be a directory whose name starts with bg1-custody" ;; esac
  case "$SEED_FILE" in *.bg1-seed) ;; *) die "the seed file must be named *.bg1-seed" ;; esac
  case "$PHRASING" in *.bg1-phrasing.json) ;; *) die "the phrasing file must be named *.bg1-phrasing.json" ;; esac
fi

command -v bun >/dev/null || die "bun is not on PATH"
BUN="$(command -v bun)"
BG1_KEY=""
if [ "$MODE" = real ]; then
  [ -n "$WINDOW" ] && [ -n "$WINDOW_CAP" ] || die "real mode spends real keys, so it needs --paid-window <unit> and --window-cap-usd <n> from the granted paid window (--fake spends nothing)"
  [ -n "$LEDGER" ] && [ -n "$RUN_ID" ] || die "real mode needs --budget-ledger and --budget-run-id (an open BG1 ledger run)"
  [ -d "$(dirname "$LEDGER")" ] || die "the --budget-ledger directory does not exist"
  LEDGER="$(cd "$(dirname "$LEDGER")" && pwd)/$(basename "$LEDGER")"
  "$BUN" "$REPO/eval/runner/rs1/paid-window.ts" check --paid-window "$WINDOW" --window-cap-usd "$WINDOW_CAP" --budget-ledger "$LEDGER" --budget-run-id "$RUN_ID" >/dev/null || exit 2
  KEY_FILE="$HOME/.config/gbrain-evals/bg1.env"
  [ -f "$KEY_FILE" ] || die "real mode takes Gemini's key only from BG1_GEMINI_API_KEY in ~/.config/gbrain-evals/bg1.env, which does not exist"
  owner_only "$KEY_FILE" || die "~/.config/gbrain-evals/bg1.env must be mode 600 or 400"
  BG1_KEY="$(sed -n 's/^BG1_GEMINI_API_KEY=//p' "$KEY_FILE" | tail -n 1)"
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
  grep -Eqx 'bg1-seed-v1:[0-9a-f]{64}' "$SEED_FILE" && [ "$(grep -c '' "$SEED_FILE")" -eq 1 ] || die "the seed file does not hold one bg1-seed-v1 line"
  SEED_FILE="$(cd "$(dirname "$SEED_FILE")" && pwd)/$(basename "$SEED_FILE")"
  PHRASING="$(cd "$(dirname "$PHRASING")" && pwd)/$(basename "$PHRASING")"
  mkdir -p "$OUT/render"
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

WRITTEN=0 SKIPPED=0 DROPPED=0
if [ "$DEV" = 1 ]; then
  RENDERED=()
  dev_report() {
    local id ledger=()
    [ "$MODE" = fake ] || ledger=(--budget-ledger "$LEDGER" --budget-run-id "$RUN_ID")
    for id in ${RENDERED[@]+"${RENDERED[@]}"}; do
      (cd "$OUT" && env -i PATH=/usr/bin:/bin HOME="$HOME" LANG=C.UTF-8 TZ=UTC "$BUN" "$HERE/render.ts" --dev-report "$id" --set "$OUT/set" ${ledger[@]+"${ledger[@]}"})
    done
  }
  for id in bg1-dev-01 bg1-dev-02 bg1-dev-03; do
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
  say "summary=dev mode=$MODE worlds=3 written=$WRITTEN skipped=$SKIPPED"
  exit 0
fi

# The dropped worlds among slots 1 to 5 that the render records under --out hold, whichever invocation dropped them.
early_drops() {
  local n=0 s
  for s in 1 2 3 4 5; do grep -Eq '"status": ?"dropped"' "$OUT/render/$(printf 'bg1-%03d' "$s").json" 2>/dev/null && n=$((n + 1)); done
  printf '%s' "$n"
}
ACKS="$OUT/render/yield-gate-acks.jsonl"
# The early-drop count the latest acknowledgement recorded, or 0 with none recorded.
acked_drops() {
  local n=0
  [ ! -s "$ACKS" ] || n="$(tail -n 1 "$ACKS" | sed -n 's/^{"ack":"a-[0-9a-f]\{12\}","at":"[0-9TZ:-]*","early_drops":\([0-9][0-9]*\)}$/\1/p')"
  [ -n "$n" ] || die "render/yield-gate-acks.jsonl ends in a line that is not an acknowledgement"
  printf '%s' "$n"
}
yield_gate() {
  local n a
  n="$(early_drops)"
  a="$(acked_drops)"
  [ $((n - a)) -ge 2 ] || return 0
  say "summary=paused reason=yield_gate mode=$MODE written=$WRITTEN skipped=$SKIPPED dropped=$DROPPED last_slot=$1 early_drops=$n$([ ! -s "$ACKS" ] || printf ' acked_drops=%s' "$a")"
  exit 3
}
if [ -n "$ACK" ] && ! { [ -s "$ACKS" ] && tail -n 1 "$ACKS" | grep -Fq "{\"ack\":\"$ACK\","; }; then
  ! grep -Fq "{\"ack\":\"$ACK\"," "$ACKS" 2>/dev/null || die "approval $ACK acknowledged an earlier pause; a new pause needs a new approval"
  n="$(early_drops)"
  a="$(acked_drops)"
  [ $((n - a)) -ge 2 ] || die "the yield gate is not paused on this --out, so --yield-gate-ack has nothing to acknowledge"
  printf '{"ack":"%s","at":"%s","early_drops":%s}\n' "$ACK" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$n" >> "$ACKS"
  say "yield_gate_ack=$ACK early_drops=$n"
fi
yield_gate $((START - 1))
for ((slot = START; slot < START + COUNT; slot++)); do
  id="$(printf 'bg1-%03d' "$slot")"
  render_one "$id" --set "$OUT/set" --seed-file "$SEED_FILE" --phrasing "$PHRASING" --slot "$slot"
  case "$RC" in
    0) case "$LINE" in *" status=skipped "*) SKIPPED=$((SKIPPED + 1)) ;; *) WRITTEN=$((WRITTEN + 1)) ;; esac ;;
    11) DROPPED=$((DROPPED + 1)) ;;
    *) exit "$RC" ;;
  esac
  yield_gate "$slot"
done

say "summary=mint mode=$MODE slots=$COUNT written=$WRITTEN skipped=$SKIPPED dropped=$DROPPED"
