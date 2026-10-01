# Preregistration: N7 extractor arm (paid)

Date: 2026-10-01. Frozen before the arm's first paid request. Category: `open-loops-email` (N7). Lane cap: $10 of the wave's $150.

## What it measures

gbrain's LLM commitment extractor (`runLoopsExtract`, `src/core/google/loops-extract.ts` at `3a284ae`) on Gmail-shaped thread pages rendered by gbrain's own `renderThreadPage` from the N7 generator ledger (seed 7). This is the semantic task of wave amendment 8: promises and their fulfillment, labeled by the generator, never mapped onto reply closure.

Threads (named denominators, seed 7):
- 15 promise threads: 4 `promise_pending`, 4 `promise_fulfilled`, 4 `promise_then_thanks` (12 promises by me) and 3 `promise_to_me` (promises to me).
- 12 control threads with no promise: 8 `ack_thanks` and 4 `outbound_fyi`.
- Fulfillment replay: the 4 `promise_fulfilled` threads extracted twice, first without the fulfilling message, then with it.

Model: gbrain's default chat model, `anthropic:claude-sonnet-4-6`, through gbrain's gateway with the key passed in gateway config only (process keys stay stripped, `GBRAIN_HOME` fresh, System One off).

## Metrics

- Promise recall: promise threads with at least one extracted commitment in the right direction (`owed_by_me` for my promises, `owed_to_me` for theirs), over the 11 promise threads whose promise is still open (`promise_pending`, `promise_then_thanks`, `promise_to_me`).
- Due-date exact match: extracted `due_iso` equals the ledger due date, over right-direction extractions on those 11 threads.
- Fulfilled-promise suppression on a single pass: `promise_fulfilled` threads (4) where the full thread yields no open `owed_by_me` commitment.
- Fulfillment gap on replay: of the 4 replayed threads, how many still hold an open `commitment_owed_by_me` loop after the second extraction. Expected 4 of 4 if the documented gap holds; any loop that closes is reported as evidence against the gap.
- False commitments: `owed_by_me` commitments on the 12 control threads.

## Decision rule

Exploratory. Nothing gates and no gbrain default changes on this arm. The receipt verdict is `pass` when every planned extraction returned (no provider or harness error), `partial` when some failed, and `fail` when none returned: a completion verdict, not a quality verdict. The fulfillment-gap entry in the bug ledger (N7-3) stays a feature gap whatever the numbers say; the replay only shows whether the gap is observable end to end.

## Cost estimate

31 extraction calls. Each thread page is under 3,000 input tokens and a reply under 600 output tokens: about $0.02 per call at $3 and $15 per million tokens, so about $0.60 in total. The guard reserves each call's worst case (4,096 output tokens), so the arm runs with `--paid --budget-run-id <id>` against a run capped at $10.
