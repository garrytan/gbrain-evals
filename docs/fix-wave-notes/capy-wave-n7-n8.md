# Eval-category wave, lane for amendment 8: N7 and N8 (branch `capy/wave-n7-n8`)

Based on `capy/eval-wave-step0` (`8eb51d3`). Adds two categories, `open-loops-email` (N7) and `proactive-recall` (N8), their generators, tests, receipts, reports and seven plus four bug-ledger entries. VERSION and CHANGELOG are untouched; the integrator writes the wave entry. All runs used the pinned gbrain `3a284aea26889b77c633aebb4149c3016d834ee6` (v0.60.26.0) through a copied overlay (`--gbrain <gbrain checkout>@3a284ae...`); the receipts record `loaded_git_head` for that commit.

## Order of commits (preregistration first)

1. `beba868` adjudicates N8's three disputed associative-recall-v1 negatives (`eval/data/n8-proactive-recall/associative-negatives-adjudication-v1.json`). Agent adjudication, pending human review; frozen corpus files unchanged.
2. `37c8621` preregisters both registry rows and promotion rules, with placeholder runners, before any run.
3. `655202a` preregisters the paid N7 extractor arm (`docs/plans/2026-10-01-eval-category-wave/prereg-n7-extractor-arm.md`) before any paid request.
4. Later commits: generators, runners, tests, receipts, reports, the ledger and these notes. The only registry change after step 2 is the headline denominator text (exact counts); no rule or threshold moved.

## N7 open-loops-email (gates)

- Path: generator ledger rendered as raw Gmail API JSON, parsed by gbrain's `GmailClient.getThread` through a stub fetch, judged by `detectThreadLoop` at a pinned now; store rounds through `applyThreadLoopVerdict`, `loops_close`, `loops_mute`, `open_loops` on PGLite; ranking checks with `Date.now` overridden in process.
- Result at the pin: five safety contracts 0 violations, recall 45 of 45, closure 39 of 39, counterparty 45 of 45. Verdict `pass`, so the row is `gate` as preregistered (amendment 1). If the integrator prefers every wave category to start report-only, empty `safety_contracts` and `quality_thresholds` for `open-loops-email`; that is the only edit.
- Findings: N7-1 bug (nudge on first sight), N7-2 to N7-7 feature gaps (any reply closes; no fulfillment tracking, confirmed end to end by the paid replay; Gmail only; wall-clock ranking; detection-age ranking; link question marks).
- Paid arm: 36 calls, $0.10 of the lane's $10 cap, budget run `eval-category-wave-n7-n8-2026-10-01T19-34-00-779Z-147c2e1d` in this machine's local ledger (`.budget/` is not committed). The preregistration said 12 controls and 31 calls; the seed has 13 and 36, which the report states.

## N8 proactive-recall (report-only)

- Path: `volunteer_context` (trusted local with and without `prior_context`, remote with `prior_context`, a ten-point `min_confidence` sweep) and `assembleTurnContext` in process for the IPC-only `turn_context`; scored on final delivered pages and bytes; associative-recall-v1 as one-turn windows with strict and adjudicated false-alarm rates; never, random and keyword-search baselines.
- Result at the pin: the private-page contracts fail (4 remote, 4 `turn_context`); soft-deleted and `prior_context` contracts hold; alias and title recall 42 of 42 with 0 of 68 innocuous false alarms; common-word aliases fire 6 of 6; associative recall 0 of 240.
- Findings: N8-1 and N8-2 bugs (private pages to remote callers and into the injected block; one mechanism, the resolver has no `excludePrivate`), N8-3 and N8-4 feature gaps.
- The privacy contracts do not depend on the associative labels. After N8-1 and N8-2 are fixed, consider moving those two contracts into a gating rule even while the rest of N8 waits for human label review. That is a call for the wave owner.

## For the fix wave

- N8-1 and N8-2 are a privacy leak. The minimal fix is to make `resolveEntitiesToPointers` honor an `excludePrivate` option (it already filters `deleted_at`), pass `resolveExcludePrivatePages(ctx.engine, ctx.remote)` from `volunteer_context`, and pass `true` from turn-mode `assembleTurnContext` (it already pins hot facts to world). Rerun N6 too: its `volunteer_context` probes had no signal, so it should gain a window that names a protected page.
- N7-1: measure the grace window from the first unanswered message in the trailing run (inbound and outbound), as the close-lane comment already intends. N7's contested-class metrics turn into the evidence.

## Verification

- `bun run typecheck` clean; `bun run test` green (see the run recorded in the final report); `bun eval/runner/bug-ledger.ts validate` passes; `bun eval/runner/all.ts --tier offline --only N7,N8`: N7 PASS (safety 5/5, quality 3/3, about 5 s), N8 REPORTED (about 32 s).
- Both runners are deterministic on repeated runs at the pin (identical `outputs_sha256`).
- Repros under `docs/benchmarks/2026-10-01-n7-open-loops-email/repro/` and `docs/benchmarks/2026-10-01-n8-proactive-recall/repro/` print expected and actual for every ledger entry that has one.

## Coordination

The registry, `docs/README.md` and the shared bug ledger (`docs/benchmarks/2026-10-01-wave-bugs.json` and its Markdown view) are the files other lanes also touch. This lane adds only its own registry rows, three README rows (N7, N8 and the ledger view) and the N7 and N8 ledger entries; regenerate the Markdown view after merging the JSON.
