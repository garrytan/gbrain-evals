# GBRA-162 flag-on check: search.evidence_resolve_dates vs existing gbrain-evals categories

Date: 2026-10-21. gbrain cfa1a006b64c5baa199142bf0f0b56a0e3fc6c06 (flag off, stock) vs local commit f87c2221752ef5cd6d5c1a4a80d17c7a60a6029b (flag forced on, patch in flag-on.patch). gbrain-evals capy/gbra162-external-ideas-wave-a @ 3b70bbee. Keyless throughout (provider keys unset). Nothing pushed.

Instrumented build 1eafeab2 (instrument.patch, on top of f87c222) logs every deliverEvidence call with insertions and relative_dates fallbacks.

## Outputs
- sweep/all-{off,on,instr}.log, sweep/done-*.txt: offline sweep status per category
- sweep/receipt-diff.json: leaf-by-leaf receipt diff off vs on (45 files)
- sweep/instr-deliveries.ndjson, sweep/instr-summary.json: every delivery in the flag-on sweep
- rerun/n8-*.json: N8 determinism reruns; rerun/cat34/: Cat 34 receipts with GBRAIN_REPO
- redeliver/full-{off,on}.ndjson, redeliver/summary.json: keyless re-delivery of the committed LongMemEval-S frozen hits
- unit/unit-{off,on}.log, unit/set-*.txt: evidence-delivery unit tests
- costs/*.json: keyless cost estimators
- scripts/: every script used

## Findings

1. No existing keyless category changes with the flag on. All 36 dispatched offline categories got the same status in both builds. Cat 34 was rerun separately with GBRAIN_REPO and passed in both. The leaf-by-leaf receipt diff shows only timing, temp paths, UUIDs, N8 token means (they vary between reruns of the same build: off 213.699 and 213.715, on 213.704 and 213.715), N4 recall-marker tie order (scored as a sorted set, same outcome) and the Cat 28 timing ratio.
2. The sweep never actually inserts a date. The instrumented build logged 3,617 deliveries: ARS 90, Cat 39 90, N14 123 and N6 3,314 (N6 had zero conversation results). All had 0 insertions and 0 relative_dates fallbacks, because those corpora use named speakers or no turn labels, and only user/human/me turns get brackets. So the sweep rules out collateral breakage but does not test the feature itself.
3. Correction to the premise: a delivery plan exists without return_unit or token_budget. The default unit is auto, so plain search, query, recall and think deliver (and annotate) whenever a hit is a conversation-type page, unless the call is via a subagent snippet cap or uses a legacy budget. probe/probe.out shows brackets in a plain search. With the flag on, delivery meta always gains relative_dates {insertions: N}, even when N is 0.
4. LongMemEval-S re-delivery (keyless, committed frozen hits, 499 of 500 hit texts verified): under explicit budgets, relative_dates_over_budget fires on 71 to 111 of 500 questions. In 58 to 92 questions, the reassembled delivery carries fewer tokens than flag-off, so some evidence is cut to make room for brackets. The budget is never exceeded, result counts and reasons are unchanged, and local and remote fingerprints match 500/500 in both builds. Unbudgeted auto and page change 388 of 500 questions (+12,970 tokens in total, max +146 per question) with no fallbacks.
5. Unit tests (8 files, 190 tests): the pass sets are identical in both builds. One test fails in both (agent-retrieval-shapes E2 reversed adapter: expected verdict fail, got pass). It passes at the pinned gbrain 0.60.324.0, so the cause is drift between the pin and cfa1a006, not the flag.

