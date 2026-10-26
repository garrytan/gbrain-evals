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
public-v3-m for gbrain on LongMemEval-M (`0518e2fd`), and the sealed campaign (hash `a92b06c5` for every unit that runs from A24 on, `b13010e1` for units started under A23, `0c4459fc` for
the units settled under A22, and `eefd1799` for wave 1's settled units) for everything else. `--preview` writes no README block and opens the disclosures with a
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
   - every sealed and public GBrain row reads "GBrain 0.60.138.0 (f05943e6, 2026-10-09)" (A14, A15). The label comes
     from `publication.json` through `publish.ts`, the renderer refuses a GBrain row without one, and a footnote says
     the build is not current master and that a rerun of the GBrain rows at current master is planned after A23;
   - external kinds as `bundle lock <hash>, capabilities <hash>`, which
     [the builds table](../comparison-systems.md#builds-the-q1-scoreboard-measured) maps to products;
   - baselines as `harness baseline`.
4. **Families and comparisons.** F1 (8k component rows), F2 (whole-system rows) and F3 (strict recall of all gold
   sessions at 10, diagnostic), each with its cohort, interval, Holm-adjusted p and eligibility notes.
5. **Public rows.** LoCoMo (S3), LongMemEval-S (S4 for gbrain's 500 questions, S4-slice for the 100-question
   shootout slice), LongMemEval-M (S5) and the sealed BEAM-100K and BEAM-1M rows, all descriptive. Each set is
   labeled with its exposure: LongMemEval was gbrain's development data and LoCoMo was used to choose its settings.
6. **Sensitivity views (A21, A24).** No view is a claim, and the row on all questions stays the reported one.
   - **Repeated sessions (A21).** Every LongMemEval-S cell, on both S4 and S4-slice, is reported a second time
     without the 13 questions whose haystacks repeat one session id with identical turns and different dates.
     gbrain's adapter refuses the second copy and the other systems keep it, so the view drops those questions for
     every system: 487 questions for gbrain's S4 row, 95 on the slice. LongMemEval-M needs no view, because its
     loader keeps each repeat as its own occurrence.
   - **temporal-graph's 8 conversations (A24 option 1).** Every BEAM-10M cell, on S1 and S1-sweep, is reported a
     second time on the 8 conversations temporal-graph measured validly (c0-c7: `10m-1`, `10m-10`, `10m-2` to
     `10m-7`), so its row can be read against every other system on the same questions.
   - **shipped-defaults' 10 `harness_invalid` answers (draft, A24).** Every S1 cell is reported a second time
     without the questions of the 10 answers in the note below, so every system is read on the cohort gbrain's row
     was scored on. The view's question ids are added to `publication.json` (`sensitivity`, id
     `a24-shipped-defaults-harness-invalid`, set S1) when the sealed receipt is assembled, not before.
7. **Row notes (A23, A24).** These notes sit beside the rows they qualify:
   - **temporal-graph: pinned models retired (A24 option 1; GBRA-108 2026-10-26, under Garry's "don't bother me, do
     what makes sense").** The pinned configuration's reranker and ingest model were retired by their provider, so
     its calls fail, and we don't change a competitor's settings. Every temporal-graph cell that did not settle
     before the retirement reads "not run: pinned config calls a model its provider retired". The S1 row (and its
     S1-sweep arms) is shown on the 8 conversations A17 measured validly (c0-c7); c8 and c9 are not run. Its
     comparisons on that subset are descriptive and never claim, every system is also shown on those 8
     conversations (section 6), and temporal-graph is retested at its current release in the follow-up
     current-master rerun (F6). `publication.json` `retired` records this, and the renderer refuses a
     temporal-graph row off that subset or a not-run one without the reason.
   - **shipped-defaults: 10 `harness_invalid` answers (draft).** In S1 shipped-defaults' 8k component arm, 10
     answers (5 on each of c4 and c5), 0.4% of the row's answers, are recorded `harness_invalid`: they failed at
     0 ms with no usage under A22, and the A24 re-answer carried them forward under their earlier realization
     instead of answering them again. A harness failure leaves its question out of that row's mean, so the row is
     scored on the rest and the view in section 6 shows every system without those questions. The cause is under
     diagnosis; its fix goes into a future freeze, and these answers are not run again under A24.
   - **Not run.** graph-pipeline S1: three of ten shards measured past the 48-hour limit per conversation, and the
     graph store's own failures account for the rest. markdown-kb S1: projected about 61 hours, past the 48-hour
     limit, from the product's quadratic reindex. Each note carries its measurement.
   - **Probe change.** The readiness probe uses an early passage of each system's last session from the A23 freeze
     on (Garry 2026-10-17 via GBRA-108: rec). A conversation settled before then and flagged `ingest_degraded` by a
     probe miss with 0 failed sessions keeps its flag, with a note that the old probe's passage started past the
     product's embedder window. verbatim-session c1 and c5 are two of these.
   - **Spend: S2b full-context underpriced.** A23 priced each gpt-6.1-sol reading's reservation at about $5.40 from
     its token estimate; the metering proxy reserves the request's byte count, about $19.29 a call, so the $20 lease
     admitted one reading at a time. The lease was raised to $110 inside the A24 cap and the cell resumed: about
     $4.46 an answer, about $89 for the 20, against about $11 projected. The receipt carries the same disclosure.
     These are interim figures (draft); the settled ledger figures replace them when the report renders.
   - **gbrain synthesize model.** `whole-synthesize` answers with `claude-opus-4-7`, gbrain's shipped default at the
     pin (owner's ruling, 2026-10-16).
8. **Per-reader accuracy and derived columns.** Per-reader means, correct-abstention rates by system and set, and
   (if the hedge classifier passes its bar) confident-error and false-abstention rates.
9. **Found-and-fixed appendix.** The public-v2 gbrain rows at `7aa2caa0` (0.60.106.0), derived and tabled but never
   compared: LongMemEval-M `c1` and `c2` stalled at that pin (fixed in gbrain #6389, 0.60.133.0), so the
   LongMemEval-M row covers the 50 questions of `c0` and `c3`; LongMemEval-S `c0` and `c1` stalled during ingest and
   wrote no rows, so its two rows are listed as not run.
10. **Inputs.** The campaign hash, every input file's SHA-256, the statistics method and the power file.

## What the public preview showed

Rendered from public results only on 2026-10-12: 13 of 128 cells have rows (the LongMemEval rows above), the other
115 are pending in the sealed campaign, and the found-and-fixed appendix has three rows. `check` recomputed
the preview byte for byte. The preview is not published; its numbers appear when the full report does.
