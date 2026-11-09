#!/usr/bin/env bash
# RS1 mint: BEAM's generation pipeline (github.com/mohammadtavakoli78/BEAM at b2da22e) run in custody, one
# conversation and one step at a time, through eval/custody/rs1/rs1_mint.py.
#
#   eval/custody/rs1/mint.sh --out <dir>/rs1-custody --seed-file <path>.rs1-seed [--count 75] [--start 1]
#       (--fake --beam-dir <fake BEAM tree> | --stub-model
#        | --budget-ledger <sqlite> --budget-run-id <id> --paid-window <unit> --window-cap-usd <n>)
#       [--topic-source seeded|public] [--regenerate <validation report>]
#
# What it guarantees:
#   - Output only counts and hashes. Every line is "rs1-mint key=value ..."; BEAM's own output goes to /dev/null and
#     an error prints its class and a hash. No topic, conversation, question or seed text is printed.
#   - Custody paths. --out must sit outside any git checkout and its name must start with "rs1-custody" (the sealed
#     key in .gstack/pregate.json refuses commits under such a path). The seed file comes from --seed-file or
#     RS1_SEED_FILE, never a default; it must be named *.rs1-seed, sit outside any git checkout, be mode 600 or 400
#     and hold "rs1-seed-v1:" and 64 hex digits. The custody marker the sealed key's text rule matches sits in
#     topic.json, the topic attempts, the rubric files, and every item of beam/1/probing_questions/probing_questions.json
#     and its attempts/. BEAM's chat, plan and topics files and the per-ability candidate files under
#     beam/1/probing_questions/<ability>/ hold BEAM's own formats and are guarded by their path only.
#     Files under --out are created owner-only (umask 077).
#   - Deterministic seeds. Conversation i's seed is HMAC-SHA256(seed, "rs1/conversation/<i>"); its topic, category,
#     BEAM's random user profile and the item selection all derive from it.
#   - Resume without re-sampling. Each conversation's manifest.json records every finished step with the sha256 of
#     its outputs. A finished step is verified and skipped, never run again; a changed output stops the run.
#   - No silent gaps. BEAM's question and answer steps swallow model errors, so rs1_mint.py checks each one's output
#     against what BEAM was asked to write and fails the step, recording nothing, when they differ; the answer step also
#     fails a batch during which any model call raised. A failed answer step keeps chat.pickle's intact batches for the
#     rerun. 'rs1_mint.py check-gaps --out <dir>' checks a mint's
#     finished steps.
#   - Early stop. BEAM's truncate step keeps a chat's turns only until its running token count passes 1,040,000, and
#     BEAM answers each batch from that batch's plan and the ones before it, so no later batch feeds a kept turn. After
#     each answer batch rs1_mint.py runs BEAM's own chat_json and truncate code on a scratch copy of the chat and stops
#     answering once that truncate cuts; the truncate step then writes the same files it would for the full chat. The
#     manifest records the stop (early_stop), check-gaps checks the batches answered, and
#     'rs1_mint.py check-early-stop --out <dir>' (run with <dir>/tooling/venv/bin/python) replays the stop on finished
#     answer steps and compares the truncate output of the full chat and of the prefix the stop keeps. It can only test
#     a mint that answered every batch: an early-stopped mint's chat already ends at the stop, so its files match by
#     construction and say nothing about where it stopped. It exits 1 when a file differs and 3 (untested) when it
#     checked no conversation or only early-stopped ones; a clean pass needs at least one fully answered conversation.
#   - One key per step. Each step runs under 'env -i' with an explicit allowlist, from inside --out so a relative
#     write BEAM makes (its bad_json.log) stays in custody. In real mode a paid step gets a
#     metering-proxy token for its one provider (gemini-3.8-flash, or OpenAI embeddings for topic_check): mint.sh
#     starts eval/runner/harness-metering-proxy.ts for that step with only that provider's real key, joined to the
#     open RS1 budget run, so the ledger prices and reserves every request before it is sent.
#   - Pinned BEAM and dependencies (real and stub-model). eval/custody/rs1/beam-checkout.sh fetches BEAM at the pinned
#     commit with a blob filter and checks out only the paths in eval/custody/rs1/beam-paths.txt (BEAM's code, licence,
#     readme, public topics and dev conversations; no sealed conversation and nothing of the 10M tier, F28), removes the
#     origin remote so no later git command can fetch an excluded file, then checks HEAD, a clean tree, and that no file
#     outside the list is on disk or in the object store, deleting the checkout when one is. A full checkout
#     from before F28 is deleted and fetched again. Its Python dependencies install with uv from requirements.lock
#     (--require-hashes) into <out>/tooling/venv.
#
# Modes: --fake swaps the whole pipeline and every model call for a deterministic stub (no network, system python3;
# the keyless tests use it). --stub-model runs BEAM's own code with a deterministic stub model. Neither spends.
# Real mode needs RS1_GEMINI_API_KEY (the dedicated paid-tier Gemini key; GEMINI_API_KEY is never read in real mode, and
# each Gemini step's proxy gets RS1_GEMINI_API_KEY's value under the name GEMINI_API_KEY) and OPENAI_API_KEY in this
# shell, an open ledger run, and the granted paid window: --paid-window <unit> --window-cap-usd <n>. Without the window,
# or with a ledger program cap or run budget above its cap, it exits 2 before anything is fetched or started
# (eval/runner/rs1/paid-window.ts).
#
# Layout under --out: set/ (the minted set: set/conversations/cNNN/{manifest.json,topic.json,beam/1/...}),
# usage.json (counts-only usage per step and conversation), proxy/ (request logs, and request bodies holding RS1
# text), tooling/ (sparse BEAM checkout, venv, tiktoken cache). Everything but tooling/ belongs in the encrypted
# archive.
set -euo pipefail
umask 077

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
BEAM_REPO="https://github.com/mohammadtavakoli78/BEAM.git"
BEAM_COMMIT="b2da22eac88bb0874c64665f13457eb99835774a"
STEPS=(plan question answer chat_json truncate probe select rubric)

say() { printf 'rs1-mint %s\n' "$*"; }
die() { printf 'rs1-mint refused: %s\n' "$*" >&2; exit 2; }

OUT="" SEED_FILE="${RS1_SEED_FILE:-}" COUNT=75 START=1 MODE=real BEAM_DIR="" TOPIC_SOURCE=seeded REGENERATE=""
LEDGER="" RUN_ID="" WINDOW="" WINDOW_CAP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --seed-file) SEED_FILE="$2"; shift 2 ;;
    --count) COUNT="$2"; shift 2 ;;
    --start) START="$2"; shift 2 ;;
    --fake) MODE=fake; shift ;;
    --stub-model) MODE=stub-model; shift ;;
    --beam-dir) BEAM_DIR="$2"; shift 2 ;;
    --topic-source) TOPIC_SOURCE="$2"; shift 2 ;;
    --regenerate) REGENERATE="$2"; shift 2 ;;
    --budget-ledger) LEDGER="$2"; shift 2 ;;
    --budget-run-id) RUN_ID="$2"; shift 2 ;;
    --paid-window) WINDOW="$2"; shift 2 ;;
    --window-cap-usd) WINDOW_CAP="$2"; shift 2 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) die "unknown argument $1" ;;
  esac
done

[ -n "$OUT" ] || die "--out is required"
[ -n "$SEED_FILE" ] || die "--seed-file (or RS1_SEED_FILE) is required; there is no default seed"
[[ "$COUNT" =~ ^[0-9]+$ && "$START" =~ ^[0-9]+$ && "$START" -ge 1 ]] || die "--count and --start must be whole numbers, --start at least 1"
[[ "$TOPIC_SOURCE" =~ ^(seeded|public)$ ]] || die "--topic-source is seeded or public"
case "$(basename "$OUT")" in rs1-custody*) ;; *) die "--out must be a directory whose name starts with rs1-custody" ;; esac

if [ "$MODE" = real ]; then
  [ -n "$WINDOW" ] && [ -n "$WINDOW_CAP" ] || die "real mode spends real keys, so it needs --paid-window <unit> and --window-cap-usd <n> from the granted paid window (--fake and --stub-model spend nothing)"
  [ -n "$LEDGER" ] && [ -n "$RUN_ID" ] || die "real mode needs --budget-ledger and --budget-run-id (an open RS1 ledger run)"
  test -n "${RS1_GEMINI_API_KEY:-}" || die "RS1_GEMINI_API_KEY is not set; real mode takes Gemini's key only from it, never from GEMINI_API_KEY"
  test -n "${OPENAI_API_KEY:-}" || die "OPENAI_API_KEY is not set"
  command -v bun >/dev/null || die "bun is not on PATH"
  bun "$REPO/eval/runner/rs1/paid-window.ts" check --paid-window "$WINDOW" --window-cap-usd "$WINDOW_CAP" --budget-ledger "$LEDGER" --budget-run-id "$RUN_ID" >/dev/null || exit 2
  GEMINI_API_KEY="$RS1_GEMINI_API_KEY"
  export GEMINI_API_KEY
fi

inside_checkout() {
  local d="$1"
  while [ ! -d "$d" ]; do d="$(dirname "$d")"; done
  git -C "$d" rev-parse --is-inside-work-tree >/dev/null 2>&1
}
inside_checkout "$OUT" && die "--out must sit outside any git checkout"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
[ -f "$SEED_FILE" ] || die "the seed file does not exist"
SEED_FILE="$(cd "$(dirname "$SEED_FILE")" && pwd)/$(basename "$SEED_FILE")"
inside_checkout "$SEED_FILE" && die "the seed file must sit outside any git checkout"
[ -z "$REGENERATE" ] || [ -f "$REGENERATE" ] || die "--regenerate names no file"
[ -z "$REGENERATE" ] || REGENERATE="$(cd "$(dirname "$REGENERATE")" && pwd)/$(basename "$REGENERATE")"

TOOLING="$OUT/tooling"
mkdir -p "$TOOLING" "$OUT/set/conversations"

if [ "$MODE" = fake ]; then
  [ -n "$BEAM_DIR" ] || die "--fake needs --beam-dir (a BEAM-shaped tree with topics/ and chats/)"
  PY="$(command -v python3)" || die "python3 is not on PATH"
  BEAM_DIR="$(cd "$BEAM_DIR" && pwd)"
else
  command -v uv >/dev/null || die "uv is not on PATH"
  BEAM_DIR="$TOOLING/beam"
  bash "$HERE/beam-checkout.sh" "$BEAM_DIR" "$BEAM_REPO" "$BEAM_COMMIT" "$HERE/beam-paths.txt"
  LOCK="$HERE/requirements.lock"
  LOCK_SHA="$(sha256sum "$LOCK" | cut -d' ' -f1)"
  VENV="$TOOLING/venv"
  if [ "$(cat "$VENV/.rs1-lock-sha256" 2>/dev/null)" != "$LOCK_SHA" ]; then
    rm -rf "$VENV"
    uv venv -q --python 3.12 "$VENV" >/dev/null 2>&1 || die "uv could not create a Python 3.12 venv"
    VIRTUAL_ENV="$VENV" uv pip install -q --require-hashes --no-deps -r "$LOCK" >/dev/null 2>&1 || die "uv could not install requirements.lock"
    echo "$LOCK_SHA" > "$VENV/.rs1-lock-sha256"
  fi
  say "venv=ready lock_sha256=$LOCK_SHA packages=$(grep -c '^[a-z0-9]' "$LOCK")"
  PY="$VENV/bin/python"
fi

"$PY" "$HERE/rs1_mint.py" check-seed --seed-file "$SEED_FILE" >/dev/null || exit 2
mkdir -p "$TOOLING/tiktoken" "$OUT/proxy/requests" "$OUT/proxy/bodies" "$OUT/proxy/ready"

PROXY_PID=""
stop_proxy() {
  if [ -n "$PROXY_PID" ]; then kill "$PROXY_PID" 2>/dev/null || true; wait "$PROXY_PID" 2>/dev/null || true; PROXY_PID=""; fi
}
trap stop_proxy EXIT

# Starts a metering proxy for one paid step holding only that provider's real key; sets READY to its ready file. The
# key reaches the proxy through the environment: env's command line names only the variables it removes.
start_proxy() {
  local cid="$1" step="$2" provider="$3" ready="$OUT/proxy/ready/$1-$2.json" key name
  local drop=()
  case "$provider" in gemini) key=GEMINI_API_KEY ;; openai) key=OPENAI_API_KEY ;; esac
  for name in $(compgen -e); do case "$name" in PATH|HOME|"$key") ;; *) drop+=(-u "$name") ;; esac; done
  rm -f "$ready"
  env ${drop[@]+"${drop[@]}"} bun "$REPO/eval/runner/harness-metering-proxy.ts" \
    --budget-ledger "$LEDGER" --budget-run-id "$RUN_ID" --cell-id "rs1-$cid-$step" --labels rs1 --ready-file "$ready" \
    --request-log "$OUT/proxy/requests/$cid-$step.jsonl" --bodies-dir "$OUT/proxy/bodies" \
    >>"$OUT/proxy/$cid-$step.log" 2>&1 &
  PROXY_PID=$!
  for _ in $(seq 1 100); do [ -s "$ready" ] && break; sleep 0.1; done
  [ -s "$ready" ] || die "the metering proxy for $cid $step did not start"
  READY="$ready"
}

provider_for() {
  case "$1" in topic|plan|question|answer|probe|rubric) echo gemini ;; topic_check) echo openai ;; *) echo none ;; esac
}

STEPS_RUN=0 STEPS_SKIPPED=0
run_step() {
  local index="$1" step="$2" provider rc=0 cid line
  cid="$(printf 'c%03d' "$index")"
  provider="$(provider_for "$step")"
  local allow=(PATH=/usr/bin:/bin HOME="$HOME" LANG=C.UTF-8 TZ=UTC PYTHONHASHSEED=0 PYTHONDONTWRITEBYTECODE=1
    PYTHON_DOTENV_DISABLED=1 TIKTOKEN_CACHE_DIR="$TOOLING/tiktoken" HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
    TRANSFORMERS_VERBOSITY=error TOKENIZERS_PARALLELISM=false GRPC_VERBOSITY=NONE)
  if [ "$MODE" = fake ] && [ -n "${RS1_FAKE_TOPIC_COLLIDE:-}" ]; then allow+=(RS1_FAKE_TOPIC_COLLIDE="$RS1_FAKE_TOPIC_COLLIDE"); fi
  if [ "$MODE" = real ] && [ "$provider" != none ]; then
    start_proxy "$cid" "$step" "$provider"
    allow+=(RS1_PROXY_READY="$READY")
  fi
  local args=(step --out "$OUT" --conv-index "$index" --step "$step" --seed-file "$SEED_FILE" --mode "$MODE"
    --beam-dir "$BEAM_DIR" --topic-source "$TOPIC_SOURCE")
  [ -z "$REGENERATE" ] || args+=(--regenerate "$REGENERATE")
  [ "$MODE" != real ] || args+=(--paid-window "$WINDOW" --window-cap-usd "$WINDOW_CAP" --budget-ledger "$LEDGER" --budget-run-id "$RUN_ID")
  line="$(cd "$OUT" && env -i "${allow[@]}" "$PY" "$HERE/rs1_mint.py" "${args[@]}")" || rc=$?
  stop_proxy
  printf '%s\n' "$line"
  case "$line" in *" status=skipped "*) STEPS_SKIPPED=$((STEPS_SKIPPED + 1)) ;; *) STEPS_RUN=$((STEPS_RUN + 1)) ;; esac
  return "$rc"
}

COMPLETE=0 DROPPED=0 EXHAUSTED=0
for ((i = START; i < START + COUNT; i++)); do
  rc=0
  for _ in 1 2 3 4 5; do
    rc=0; run_step "$i" topic || rc=$?
    [ "$rc" -eq 0 ] || break
    rc=0; run_step "$i" topic_check || rc=$?
    [ "$rc" -eq 10 ] || break
  done
  if [ "$rc" -eq 11 ]; then DROPPED=$((DROPPED + 1)); continue; fi
  [ "$rc" -eq 0 ] || exit "$rc"
  for step in "${STEPS[@]}"; do
    rc=0; run_step "$i" "$step" || rc=$?
    if [ "$rc" -eq 12 ]; then EXHAUSTED=$((EXHAUSTED + 1)); continue 2; fi
    [ "$rc" -eq 0 ] || exit "$rc"
  done
  COMPLETE=$((COMPLETE + 1))
done

"$PY" "$HERE/rs1_mint.py" usage --out "$OUT"
say "summary=mint mode=$MODE conversations=$COUNT complete=$COMPLETE dropped=$DROPPED select_exhausted=$EXHAUSTED steps_run=$STEPS_RUN steps_skipped=$STEPS_SKIPPED"
