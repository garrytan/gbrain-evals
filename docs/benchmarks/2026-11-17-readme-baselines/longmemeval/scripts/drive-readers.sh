#!/usr/bin/env bash
# Drives the four RB-LME reader arms and their official judge through the batch lane, one batch at a time:
# submit (pilot first for a new provider and model), poll until it settles, repeat until the arm reports
# "nothing left to submit". Idempotent: a rerun picks up where the lane's state left off. Stops on any error,
# including a batch in state unknown or ids that need the preregistered single retry.
# Needs RB_GBRAIN_DIR, LME_DATASET, W10_STATE_DIR, W10_MANIFEST_DIR and RB_LEDGER (see results.md).
set -euo pipefail
W="bun eval/runner/batch/w10.ts"
L=(--budget-ledger "$RB_LEDGER")
settle() {
  while $W status "${L[@]}" 2>/dev/null | grep -Eq ' (prepared|sending|submitted|ended) '; do
    $W poll "${L[@]}" >/dev/null || true
    sleep "${POLL_SECONDS:-60}"
  done
  if $W status "${L[@]}" 2>/dev/null | grep -q ' unknown '; then echo "drive-readers: a batch is in state unknown; resolve it by hand" >&2; exit 3; fi
}
step() {
  while :; do
    settle
    out=$($W "$@" "${L[@]}" 2>&1) || { echo "$out" >&2; exit 1; }
    echo "$out" | tail -1
    echo "$out" | grep -q 'nothing left to submit' && return 0
  done
}
for arm in ${RB_ARMS_ORDER:-rb-sonnet55-none rb-sonnet55-hybrid5 rb-opus55-hybrid5 rb-sonnet55-full}; do step run "$arm"; done
for arm in ${RB_ARMS_ORDER:-rb-sonnet55-none rb-sonnet55-hybrid5 rb-opus55-hybrid5 rb-sonnet55-full}; do step judge "$arm" official; done
settle
$W status "${L[@]}"
