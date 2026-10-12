# The head-to-head memory scoreboard (Q1): report layout

**Status: layout, results pending.** This page fixes where each part of the Q1 report goes before the sealed waves
settle, so the published report is the layout below with the generated tables filled in. Nothing here is a result.
The rules it follows are in the [preregistration](2026-10-06-scoreboard-preregistration.md); every system is named
by kind, and products appear only on [comparisons and their protocols](../comparison-systems.md).

## How the report is built

The report's tables are generated, never typed. Three commands rebuild them from the campaigns' pulled state:

```bash
# 1. Assemble the receipt: merge every settled cell at its campaign's launch tree, list unsettled cells as pending.
bun eval/runner/q1/publish.ts --config docs/benchmarks/2026-10-06-scoreboard/publication.json \
  --results <checkout of evals/q1-scoreboard-results> --out <results checkout>/published/q1-scoreboard
# 2. Render scoreboard.json, scoreboard.md and the README headline block from the receipt.
bun eval/runner/scoreboard.ts render --receipt <receipt dir>
# 3. Recompute everything from the rows and compare byte for byte.
bun eval/runner/scoreboard.ts check --receipt <receipt dir>
```

`publication.json` says which campaign covers which rows and at which launch tree each renders: public-v2 for the
external and baseline rows on LongMemEval (`4bccbd5a`), public-v3-s2 for gbrain on LongMemEval-S (`3532b1aa`),
public-v3-m for gbrain on LongMemEval-M (`0518e2fd`), and the sealed campaign (hash `43749abd`, and `eefd1799` for
wave 1's other units) for everything else. `--preview` writes no README block and opens the disclosures with a
public-results-only line; the preview is how this layout was checked.

## Provenance

**Where the receipt lives (decided 2026-10-12, auto-approved under Garry's standing rule of 2026-10-12).** The full
receipt (campaign.json, every cell's rows, answers, judgments and run configuration, the appendix cells and
power.json) is pushed to `evals/q1-scoreboard-results` under `published/q1-scoreboard/`, with a `SHA256SUMS` file
listing every file's sha256 sorted by path. `publication.json` (`published`) and this section record the results-branch
commit that holds it and the sha256 of `SHA256SUMS`; both are empty until the sealed waves settle and the receipt is
pushed. Main keeps only the rendered tables: `scoreboard.md` beside this report and the README headline block. To
verify, check out that commit, confirm the `SHA256SUMS` hash, and run `bun eval/runner/scoreboard.ts check` on the
receipt, which recomputes every table from the rows. Fetching the receipt by commit inside `check` is not built yet;
it lands with the real render.

| Field | Value |
|---|---|
| Results branch | `evals/q1-scoreboard-results` |
| Receipt path | `published/q1-scoreboard/` |
| Commit | pending |
| `SHA256SUMS` sha256 | pending |

## Report sections, in order

1. **The finding.** The generated verdict sentence for BEAM-10M (family F1), with the date range, the gbrain build
   and, when F1 is descriptive (power decision: minimum detectable difference about 13.58 points), the sentence that
   says so. Then where gbrain loses, from the three largest losses the generator lists.
2. **The headline table.** The README block: six columns (accuracy at 8k with the three-reader mean, dollars per
   month for a personal agent, p50 answer latency, write-to-queryable p50, receipt link), one row per kind, and
   the size curve across BEAM-100K, BEAM-1M and BEAM-10M for gbrain, the two baselines that need no memory system
   and the best external row.
3. **Builds.** Each row carries the build it measured, in the report's Build column:
   - gbrain `f05943e6` (0.60.138.0) on every sealed and public row (A14, A15);
   - external kinds as `bundle lock <hash>, capabilities <hash>`, which
     [the builds table](../comparison-systems.md#builds-the-q1-scoreboard-measured) maps to products;
   - baselines as `harness baseline`.
4. **Families and comparisons.** F1 (8k component rows), F2 (whole-system rows) and F3 (strict recall of all gold
   sessions at 10, diagnostic), each with its cohort, interval, Holm-adjusted p and eligibility notes.
5. **Public rows.** LoCoMo (S3), LongMemEval-S (S4 for gbrain's 500 questions, S4-slice for the 100-question
   shootout slice), LongMemEval-M (S5) and the sealed BEAM-100K and BEAM-1M rows, all descriptive. Each set is
   labeled with its exposure: LongMemEval was gbrain's development data and LoCoMo was used to choose its settings.
6. **Sensitivity view (A21).** Every LongMemEval-S cell, on both S4 and S4-slice, is reported a second time without
   the 13 questions whose haystacks repeat one session id with identical turns and different dates. gbrain's
   adapter refuses the second copy and the other systems keep it, so the view drops those questions for every
   system: 487 questions for gbrain's S4 row, 95 on the slice. The row on all questions stays the reported one; the
   view is never a claim. LongMemEval-M needs no view, because its loader keeps each repeat as its own occurrence.
7. **Per-reader accuracy and derived columns.** Per-reader means, correct-abstention rates by system and set, and
   (if the hedge classifier passes its bar) confident-error and false-abstention rates.
8. **Found-and-fixed appendix.** The public-v2 gbrain rows at `7aa2caa0` (0.60.106.0), derived and tabled but never
   compared: LongMemEval-M `c1` and `c2` stalled at that pin (fixed in gbrain #6389, 0.60.133.0), so the
   LongMemEval-M row covers the 50 questions of `c0` and `c3`; LongMemEval-S `c0` and `c1` stalled during ingest and
   wrote no rows, so its two rows are listed as not run.
9. **Inputs.** The campaign hash, every input file's SHA-256, the statistics method and the power file.

## What the public preview showed

Rendered from public results only on 2026-10-12: 13 of 128 cells have rows (the LongMemEval rows above), the other
115 are pending in the sealed campaign, and the found-and-fixed appendix has three rows. `check` recomputed
the preview byte for byte. The preview is not published; its numbers appear when the full report does.
