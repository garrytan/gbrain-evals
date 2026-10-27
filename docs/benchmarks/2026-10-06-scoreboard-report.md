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
  --results <results root> --out <receipt dir>
# 2. Render scoreboard.json, scoreboard.md and the README headline block from the receipt.
bun eval/runner/scoreboard.ts render --receipt <receipt dir>
# 3. Recompute everything from the rows and compare byte for byte.
bun eval/runner/scoreboard.ts check --receipt <receipt dir>
```

The sealed sets are assembled on the custodian's host, inside custody, with `--custody` (it schedules them from their
corpora) and the A19 redo judgments (`--frontier-redo <dir>`, searched recursively for `.ndjson`; it refuses when none
load). That needs `GBRAIN_EVALS_CUSTODY_LOG`, `GBRAIN_EVALS_DATASETS` (the dataset root) and `GBRAIN_EVALS_BEAM10M_ROOT`,
the verified BEAM-10M root the launcher's `GBRAIN_EVALS_BEAM10M_SOURCE` names: a dataset root other than the default
moves BEAM-10M's default with it, so set both. The full receipt is checked there with `check --receipt <dir> --custody`
(no size budget), and the public tables are checked anywhere with `check --sums <SHA256SUMS>` against
`publication.json` `published.sha256`.

`publication.json` says which campaign covers which rows and at which launch tree each renders: public-v2 for the
external and baseline rows on LongMemEval (`4bccbd5a`), public-v3-s2 for gbrain on LongMemEval-S (`3532b1aa`),
public-v3-m for gbrain on LongMemEval-M (`0518e2fd`), and the sealed campaign (hash `a92b06c5` for every unit that runs from A24 on, `b13010e1` for units started under A23, `0c4459fc` for
the units settled under A22, and `eefd1799` for wave 1's settled units) for everything else. `--preview` writes no README block and opens the disclosures with a
public-results-only line; the preview is how this layout was checked.

## Provenance

**What is published (A25, Garry 2026-10-27 via GBRA-108: "Rec").** The full receipt (campaign.json, every cell's rows,
answers, judgments and run configuration, the appendix cells and power.json) carries the question ids of the sealed
BEAM-10M, BEAM-1M and BEAM-100K sets, so it stays sealed in custody until the follow-up current-master rerun (F6)
closes, or as Garry decides; publishing it would spend those sets as held-out material, F6 included. What is public:
the README headline block, `scoreboard.md› beside this report, and the receipt's `SHA256SUMS› on
`evals/q1-scoreboard-results› under `published/q1-scoreboard/›, nothing else. `SHA256SUMS› lists every receipt file's
sha256 sorted by path, plus one `render/› line for each public file (the full `scoreboard.md›, and the README's
headline block between its markers), so its hash commits the receipt and the public tables together.
`publication.json› (`published›) and the table below record the results-branch commit and that hash.

**How it is checked.** In custody, `bun eval/runner/scoreboard.ts check --receipt <dir> --custody› recomputes every table
from the rows. Anywhere, `bun eval/runner/scoreboard.ts check --commit <commit>› reads `published/q1-scoreboard/› at that
results-branch commit, refuses a `SHA256SUMS› hash other than the one `publication.json› records, and checks the
committed README block and `scoreboard.md› against their `render/› lines; `check --sums <SHA256SUMS>› does the same from
a local copy. When the full receipt is released, `check --commit› recomputes it from the rows.

| Field | Value |
|---|---|
| Results branch | `evals/q1-scoreboard-results` |
| Published path | `published/q1-scoreboard/SHA256SUMS` (aggregates only, A25) |
| Full receipt | sealed in custody until F6 closes, or as Garry decides |
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
   - **shipped-defaults' 10 `harness_invalid` answers (A24).** Every S1 cell is reported a second time without the
     questions of the 10 answers in the note below, so every system is read on the cohort gbrain's row was scored on.
     `publication.json` names the view (`sensitivity`, id `a24-shipped-defaults-harness-invalid`, set S1) by where
     its questions come from (`from_outcomes`: the `harness_invalid` answers of the 8k component arm, count 10), and
     the custodian's assembly derives the question ids from the sealed answers and refuses any other count, so no
     sealed id is written by hand.
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
   - **shipped-defaults: 10 `harness_invalid` answers.** In S1 shipped-defaults' 8k component arm, 10 answers (5 on
     each of c4 and c5), 0.4% of the row's answers, are recorded `harness_invalid`. A24's re-answer carried them
     forward under their earlier realization instead of answering them again. The custodian traced the 10 A22
     retrievals behind them: 9 failed as the shim's `degraded read (harness failure; retry after quiesce)` (8
     `expansion_not_applied`, 1 `expansion_partial` with `rescore_skipped`; c4 fixed-evidence 3, c5 fixed-evidence 3,
     c5 vendor-default 3), and the tenth, c4 vendor-default, scored; the stored strings carry no HTTP status. A harness
     failure leaves its question out of that row's mean, so the row is scored on the rest and the view in section 6
     shows every system without those questions. The carry-forward fix (a re-answer behind a failed retrieval
     retrieves again) goes into the follow-up rerun (F6), not this campaign.
   - **gbrain full-surface S2b `whole-think`: 10 gpt-6.1-sol answers at gbrain's own output limit (product).** On c0
     (6) and c1 (4), 10 Sol answers stopped at exactly 4,000 output tokens, and every scored Sol answer in those cells
     used fewer. At the pin, `gbrain think` gives 16,000 output tokens only to Claude 5, Claude 4.x, gpt-5 and o-series
     models and to recipes that declare thinking by default; gpt-6.1-sol gets the 4,000 default
     (`src/core/think/index.ts` `maxOutputTokensFor`). gbrain's own path labels that stop `output_truncated`, and the
     shim records any status other than an answer as `harness_invalid`, which is why the record named no reason. The
     attribution rests on that code, the custodian's count (all 10 stopped at exactly 4,000 output tokens) and a
     keyless $0 repro of the limit (`maxOutputTokensFor('openai:gpt-6.1-sol')` returns 4,000 at the pin); the pulled
     lease logs do not keep the shim's status field, so the `output_truncated` label itself was not observed. The
     limit and the flag are gbrain's shipped behavior with this model, so the 10 count as product failures, scored 0
     and kept in the denominator (`publication.json` `product_outcomes`; the renderer refuses any other count). gbrain
     #7421 (2026-10-24, after the pin) extends the 16,000-token limit to OpenAI reasoning models from gpt-5 to gpt-9.
   - **S3 file-agent: 23 gpt-6.1-sol `reader_error` answers.** A harness failure, so those questions leave that row's
     mean under the outcome rules; the row says how many.
   - **S3 agent runtime: 200 gpt-6.1-sol `retrieval_error` answers (A19, item E).** The runtime calls gpt-6.1-sol
     through chat completions with function tools and a reasoning effort, and the provider refuses that request. It is
     the runtime's own request, which the harness does not change, and the preregistration leaves it to the program
     owner; no alternative ran, so the row reports all 200 Sol answers as the runtime's failure, scored 0. Its Opus
     and Sonnet answers are unaffected, and the per-reader table shows each reader. 2 further answers are
     `reader_error`.
   - **Not run, with each cell's own reason.** graph-pipeline S1: the product's own behavior (A23); its graph store's
     hard-coded 32 GiB size limit, once reached, fails every later write and retrieval, its incremental re-extraction
     makes each session cost more, and three shards ingested for 62 hours without finishing. markdown-kb S1: projected
     about 61 hours, past the 48-hour limit per conversation, from the product's own reindex. markdown-kb S2b: "not run
     (projected about 60 h > cell wall clock on the pinned VM)": its local `bm reindex` embeds about 2.5 hours per
     conversation on the pinned VM, 8 of 24 conversations finished inside the 22-hour wall clock, $0 spent and no
     answer; that is how the product ingests, so it is the product's behavior, not a harness fault. verbatim-session's
     common configuration on S2a and S3: "not run: the harness has no common-config adapter for this system at this
     freeze (diagnostic config only)", a harness gap rather than a property of the system; the adapter is on the F6
     list. `publication.json` `not_run` carries each reason.
   - **Probe change.** The readiness probe uses an early passage of each system's last session from the A23 freeze
     on (Garry 2026-10-17 via GBRA-108: rec). A conversation settled before then and flagged `ingest_degraded` by a
     probe miss with 0 failed sessions keeps its flag, with a note that the old probe's passage started past the
     product's embedder window. verbatim-session c1 and c5 are two of these.
   - **Spend.** Sealed spend settled at $7,034.32 on the campaign ledgers against the $8,000 sealed cap; $6,729.26 of it
     is measured, $6,626.00 across the four freezes' cells plus $103.26 for the A19 frontier-judge backfill. Of 149 launch units, 114 settled complete, 8 partial and 27 not run. S2b full-context was underpriced:
     A23 priced each gpt-6.1-sol whole-history reading's reservation from its token estimate, but the metering proxy
     reserves the request's byte count as input tokens, about 3.6 times as much, so the $20 lease admitted one reading
     at a time. The lease was raised to $110 inside the A24 cap and the cell resumed; it settled complete, 720 of 720
     answers, at $191.34 measured across its seven leases. The receipt carries the same disclosure.
   - **gbrain synthesize model.** `whole-synthesize` answers with `claude-opus-4-7`, gbrain's shipped default at the
     pin (owner's ruling, 2026-10-16).
8. **Per-reader accuracy, frontier-judge agreement and derived columns.** Per-reader means; frontier-judge agreement
   per cell and pooled per system, on the answers each frontier judge scored, with its coverage (the A19 backfill
   filled 1,960 of 2,140 gpt-6.1-sol frontier judgments, and the frozen tool does not judge the other 180, which are
   temporal-graph `ingest_degraded` answers; 194 of 214 Opus redos landed, 2 remain `judge_error` and 18 fall outside
   a published arm; a redo replaces the logged error under the same key, and under 90% agreement flags the column);
   correct-abstention rates by system and set, and (if the hedge classifier passes its bar) confident-error and
   false-abstention rates.
9. **Found-and-fixed appendix.** The public-v2 gbrain rows at `7aa2caa0` (0.60.106.0), derived and tabled but never
   compared: LongMemEval-M `c1` and `c2` stalled at that pin (fixed in gbrain #6389, 0.60.133.0), so the
   LongMemEval-M row covers the 50 questions of `c0` and `c3`; LongMemEval-S `c0` and `c1` stalled during ingest and
   wrote no rows, so its two rows are listed as not run.
10. **Inputs.** The campaign hash, every input file's SHA-256, the statistics method and the power file.

## What the public preview showed

Rendered from public results only on 2026-10-12: 13 of 128 cells have rows (the LongMemEval rows above), the other
115 are pending in the sealed campaign, and the found-and-fixed appendix has three rows. `check` recomputed
the preview byte for byte. The preview is not published; its numbers appear when the full report does.
