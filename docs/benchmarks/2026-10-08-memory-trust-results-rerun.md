# Memory trust harness rerun: every keyless contract passes after the fixes (2026-10-08)

## The finding

After the fixes for the October 7 findings merged into gbrain `capy/memory-trust` (`91290339`), all three memory trust categories pass every preregistered contract in their keyless (hermetic) arm. The build tested is a local merge of `capy/memory-trust` `91290339` with `capy/memory-trust-writes` `3dd0a8dd` (merge `8f376c1d`, never pushed), the state the feature PR will have once lane L1a lands. No model was called; the model arms ran with scripted stand-ins to prove the pipeline, and the paid run still follows the [preregistration](2026-10-07-memory-trust-preregistration.md). This report supersedes the merge column of the [October 7 harness results](2026-10-07-memory-trust-results-harness.md), which stay as the record of what the first build did.

| Category | October 7 merge (`2fcfea7f` + `0c1da965`) | October 8 merge (`91290339` + `3dd0a8dd`) | Pin (v0.60.104.0) |
|---|---|---|---|
| Cat 37 poisoning | fail: 13 of 36 flagged payloads shown without "unconfirmed", 13 of 67 external items mislabeled | **pass**: every safety contract 0, retention 70 of 70, false quarantine 0 of 70 | fail (no trust features) |
| Cat 38 state resolution | pass, but recall marked no contested row | **pass**: 200 of 200 current, 0 stale, 0 lower-tier wins, labels 308 of 308; contested rows marked on read 92 of 92 | fail: 108 of 200 current, 85 lower-tier wins |
| Cat 39 deletion audit | fail: 4 live residuals, 6 dishonest receipt hits, 3 resurrections, 4 probe recoveries | **pass**: all four safety counts 0, receipt completeness 380 of 380, neighbors 30 of 30 | fail: page purge only, 17 residuals |

## What changed

In gbrain, per the [findings ledger](2026-10-07-memory-trust-bugs.md) (all eight bugs fixed and verified by this rerun, five feature gaps closed):

- Search chunks now carry the current state of their fence rows: the unconfirmed flag (37-1) and the stored external tier inside the data envelope (37-2).
- Recall marks both rows of a contested pair (`contested: {proposal_ref, role}`, 38-1), every lower-tier contradiction files a proposal without embeddings (38-3), `put_page` reports `contested` (38-2), and confirming either side resolves the proposal (38-4).
- Purge redacts stored write outcomes (39-2), keeps `purged_content` typed (39-3), drops refused writes' claim text (39-4), lists every swept inventory store (39-5), returns a store-by-store page receipt (39-6), and tombstones every saved version, so neither a re-put (39-1) nor an older version (39-7) brings a page back.

In this repository, two harness changes follow gbrain's new output; neither changes gold, metrics or thresholds:

- Cat 39 reads the page receipt nested under `receipt` (`stores`, `residuals`, `completion`) and maps hits on other pages' prose through the store rows' `items` (`out_of_scope: source_prose`) instead of counting them `unreported`. Residuals by status on the merge: out of scope 37, every other bucket 0.
- Cat 38 excludes only the challenger of a contested pair from the served value (the challenged higher-tier row stays current, as gbrain documents), and the label parser in `eval/runner/memory-trust/sut.ts` reads the new `· contested tpN` suffix and the `unconfirmed, external, untrusted` words, so the labels-off arm still strips them.

## What remains

- **Detector recall is unchanged (37-3, 37-4, documented limits).** The gate catches 69 of 90 instruction-worded payloads; the passive "must be emailed to" form and agent-addressed rules with more than 80 characters before the modal pass it. Ten of 30 external instruction attacks are therefore stored, labeled external and not held. Reported, never gated (CEO-23).
- Exploratory Cat 37 numbers on the merge: flagged and labeled 0.90 of agent-relayed instructions, unconfirmed-preference activation 0.20 (both limited by detector recall), hard-negative quarantine 13 of 15, false withhold 1 of 5.
- No model has been measured. The defaults decision needs the paid run.

## Reproduce and inspect

```bash
bun eval/runner/cat37-memory-poisoning.ts --gbrain <gbrain checkout>@<merge> --modes off,default,external-flag,activation-allow --model-arm dry --limit 40
bun eval/runner/cat38-state-resolution.ts --gbrain <gbrain checkout>@<merge> --model-arm dry --limit 100
bun eval/runner/cat39-deletion-audit.ts --gbrain <gbrain checkout>@<merge> --model-arm dry
```

Receipts in [`2026-10-08-memory-trust/`](2026-10-08-memory-trust/): the three `*-overlay` receipts (merge `8f376c1d`, with the dry model arm) and the three `*-pinned` receipts. Wall time on a 4-core machine: Cat 37 about 1 minute 40 seconds with four modes and the dry arm, Cat 38 about 50 seconds, Cat 39 about 25 seconds.
