# Fix wave 9: pinning `search_path` costs about 10-13% on bulk fact inserts; takes-quality receipts change protocol

**Measured by gbrain on October 5, 2026, on a development machine; mirrored into this repository the same day. This mirror reruns nothing and spent $0.**

[gbrain](https://github.com/garrytan/gbrain) is a memory system for agents. It keeps notes as Markdown and indexes them in a database, either PGLite (Postgres compiled to WebAssembly, in process) or Postgres. Fix wave 9 ([garrytan/gbrain#6111](https://github.com/garrytan/gbrain/pull/6111), v0.60.74.0, open and pending merge at head `1fbe8660c`) carries two changes that matter to anyone comparing gbrain measurements over time. One has a measured cost. The other changes how one eval's receipts should be compared. The source text is copied unchanged into [`upstream/`](2026-10-05-fix-wave-9-mirror/upstream/), and the numbers below are in [`verdict.json`](2026-10-05-fix-wave-9-mirror/verdict.json).

## The finding

1. **Pinning `search_path` is an accepted cost, not a retrieval change.** Bulk fact inserts got slower: 10,000 rows took 1.31-1.46 s before and 1.45-1.69 s after on PGLite, and 531-536 ms before and 565-604 ms after on Postgres 16. At the midpoints that is 13% slower on PGLite and 10% on Postgres. Fact fingerprints, which `forget` uses to recognize a withdrawn claim, are byte-identical before and after on both engines, and the fingerprint index is still used. Search does not change. gbrain accepts the insert cost as the price of the security fix.
2. **Takes-quality receipts move to protocol 2.** A malformed judge reply now gets one correction. No score was measured before and after, so this is a comparability note, not a verdict: a protocol 1 receipt and a protocol 2 receipt are dissimilar inputs.

## Pinning `search_path` (#5190, migration v211)

**What changed.** A Postgres function looks up any unqualified name it uses, such as `lower` or `facts`, through a list of schemas called the `search_path`. If the function does not fix that list, it uses the caller's, so a caller who puts their own schema first can make gbrain's functions call their code instead. Supabase's database linter flags this. Fix wave 9 gives every gbrain plpgsql function `SET search_path = pg_catalog, public`, and migration v211 (`function_search_path`) applies the setting to existing brains. The fact fingerprint functions back an index and must stay inlinable, and Postgres does not inline a function with a `SET` clause. So those functions instead name `pg_catalog` on each built-in they call.

**What it costs.** The withdrawal trigger runs on every fact insert, and it now runs with a pinned setting, which Postgres switches in and back on each call. gbrain's wave lane timed it on its own machine, three runs per side:

| Engine | Before (10,000 fact inserts) | After | Change at the midpoints |
|---|---|---|---|
| PGLite | 1.31-1.46 s | 1.45-1.69 s | +13% |
| Postgres 16 | 531-536 ms | 565-604 ms | +10% |

Comparing range ends instead of midpoints, the slowdown is between 6% and 16%. These are local timings from one machine, not a controlled benchmark: gbrain published the ranges, not the individual runs or the hardware.

**What stays the same.** gbrain captured a golden of 24 claims on master before the change: for each claim, its fingerprint, its version 1 fingerprint and its normalized text. They cover case, whitespace, punctuation, Unicode, emoji and the empty string. After the change every value is byte-identical, on PGLite and on Postgres, so a claim withdrawn before upgrading is still recognized after. An `EXPLAIN` check confirms that queries still use the fingerprint index. Both checks live in `test/fact-fingerprint-search-path.test.ts`, which also runs on Postgres through `test/e2e/fact-fingerprint-search-path-postgres.test.ts`. Its other four cases (a hostile caller `search_path`, the setting after a fresh migrate, re-applying the pin, a withdrawal surviving the migration) fail on master and pass with the fix; the golden and the index check pass on both.

**What to use and what to avoid.** Nothing to change for retrieval: search, recall and fingerprints behave as before, so earlier retrieval results in this repository stand for builds with this fix. Expect bulk fact imports to take roughly a tenth longer. If you compare fact-insert timings across gbrain versions, this change accounts for that step.

## Takes-quality protocol 2 (#5325)

**What changed.** `gbrain eval takes-quality` asks a panel of judge models to score a sample of a brain's takes on a rubric. Before, an unparseable reply or one that skipped a rubric dimension counted as an error, like a provider failure. With a small panel one such slip could drop a cycle below quorum and make a paid run report `inconclusive`. Under protocol 2:

- every judge runs with thinking off;
- each malformed slot (`parse_failed`, including an empty reply, or `incomplete_scores`) is re-asked once, with the same model and sample plus the validator's error;
- each correction is priced against `--budget-usd` before it is sent; one that is not sent is recorded with `corrected: null` and `skipped_reason` `budget` or `aborted`;
- a corrected reply replaces the first attempt only when it validates (`correction_selection_rule: corrected_if_valid`);
- provider errors and valid low scores are never re-asked, so a judge that dislikes a take does not get a second chance to like it;
- corrections count toward `cost_usd` and the cap.

Receipts gain `protocol_version` (absent reads as 1), `correction_selection_rule` and `corrections`. `gbrain eval takes-quality regress` now lists a protocol difference among the dissimilar inputs, beside the corpus, prompt and rubric hashes. It warns and does not refuse.

**How to compare receipts.** No takes-quality score was measured before and after this change, so nothing here says protocol 2 raises or lowers scores. Fewer runs should end `inconclusive` for format slips, but that is the mechanism, not a measurement. Compare takes-quality receipts only within one `protocol_version`, with the same model panel, corpus, prompt and rubric. A score difference between a protocol 1 and a protocol 2 receipt is a difference of inputs and should be reported as one. This repository has published no takes-quality receipts so far, so no earlier result here is affected.

## Limits of this mirror

- **Local timing.** The insert cost comes from three runs per side on one development machine. The per-run values and hardware are not published, so the ranges cannot be recomputed here.
- **Pending merge.** gbrain#6111 was open at head `1fbe8660cb0dc1737d7bd9323aa9c6410dc80ec8` when this was written. Its title names v0.60.74.0, while `VERSION` at that head still reads 0.60.72.0 until the wave is restamped. The cited commits are `daf7426b6` (#5190) and `8a2d8a82a` (#5325); both are ancestors of that head.
- **No takes-quality measurement.** Protocol 2 is recorded as a change of method only.

## Reproduce and inspect

In a gbrain checkout at `1fbe8660c` (keyless, $0; the Postgres half needs `DATABASE_URL` pointing at a pgvector Postgres):

```bash
bun test test/fact-fingerprint-search-path.test.ts                   # golden, hostile search_path, index plan (PGLite)
bun test test/e2e/fact-fingerprint-search-path-postgres.test.ts      # the same cases on Postgres
bun test test/eval-takes-quality-runner.serial.test.ts test/eval-takes-quality-regress.test.ts   # protocol 2 corrections and regress
```

The insert timing was a one-off lane measurement with no committed script. Sources: the commit messages of `daf7426b6` and `8a2d8a82a`, gbrain `CHANGELOG.md` and `docs/eval-takes-quality.md` at the PR head, all copied in [`upstream/`](2026-10-05-fix-wave-9-mirror/upstream/).
