# Preregistration: what gbrain's `query` hands the reader at 8,000 tokens, E1 (2026-10-08)

**Status: frozen on 2026-10-08,** before any paid call. The budgets `B_native` and `B_pseudo` stay open until the
label-free retrieval freeze; they are filled by amendment A1 below, before any live parity call or reader call. Nothing
else changes after the first paid cell runs; a later change gets a new dated amendment, before any cell it affects.

Plan: [docs/plans/2026-10-08-gbrain-budgeted-delivery/PLAN.md](../plans/2026-10-08-gbrain-budgeted-delivery/PLAN.md)
(v3, approved by Garry on 2026-10-08 with all eight recommended defaults; E1 cap $100). This file is the plan's E1
step 5 and fixes the arms, calls, settings, recipes, renderer, sizing rule, readings, reproduction band and drop order.

## The question

The open-source memory comparison measured gbrain through its internal ranking function (`hybridSearch`), not through
`query`, the operation an agent calls. Its reader saw undated chunks. E1 asks, on the comparison's own development
sets and without any gbrain code change, how much of gbrain's shortfall at 8,000 tokens comes from that measurement
and how much from the product, and which of four levers matters: dates, rendering, hit count or depth. It also asks
whether saved facts show headroom above the best E1 arm. E1 is exploratory triage: no default is set from it.

## Code and data identity

- gbrain under test: `garrytan/gbrain` `c5fb0201d1960a0a5a81c35d77718311b03154b7` (v0.60.95.0), the comparison's
  counted master, loaded as a `--gbrain` overlay. The declared `package.json` pin is `a865f8f8`; every receipt records
  both. The search, delivery and `query` files are byte-identical between the two, so the keyless tests (run against
  the pin) cover the loaded build.
- gbrain-evals: branch `capy/budgeted-delivery-e1`, cut from PR #89's head `4493e440` (the plan named `9c07b7e2`; the
  four later commits on that branch touch results, reports and arms parsing, not the gbrain adapter or renderer). The
  harness commit is `df8f458c`; this file and the campaign manifests are frozen in the commit that adds them.
- Sets, as in the comparison: the LongMemEval-S slice (`--limit 100 --seed 42`, 100 questions, one haystack each,
  inferential, each question its own cluster); LoCoMo dev (3 conversations, 587 questions, descriptive, conversation
  clusters); BEAM-100K dev (6 conversations, 120 questions, descriptive, conversation clusters).
- Embeddings `openai:text-embedding-3-large` at 1,536 dimensions; gbrain's `balanced` defaults with the Voyage
  reranker, as in the comparison's `gbrain-shootout-master-common` cells.

## Cells and calls

Two cells per benchmark, each importing the benchmark's sessions into its own PGLite brain.

**Cell A** (`--system gbrain-shootout`, unchanged adapter): `hybridSearch(query, { limit: 40 })` under the
`fixed-evidence` policy, exactly the comparison's call. Its frozen items feed `shootout-chunk`, `chunk-dated`,
`chunk-undated-twin`, `chunk-dated-pseudo` and `rehydrated`. Each retrieval row records whether the rerank score is
present (`accounting.rerank_present`); the reproduction arm keeps the comparison's rerank timeout and never fails on a
missing rerank.

**Cell B** (`--system gbrain-query`, `eval/runner/systems/gbrain-query/`): gbrain's `query` handler in process, as a
trusted local caller. Per question:

```
frozen list   query { query, limit: 25, expand: false, return_unit: 'chunk' }            (no token_budget; plan null)
deliveries    assembleEvidenceForHits(frozen list, return_unit 'auto', budget_tokens B_native)        auto-b_native
              assembleEvidenceForHits(frozen list, return_unit 'auto', budget_tokens B_pseudo)        auto-b_pseudo
              assembleEvidenceForHits(frozen list, return_unit 'auto')  (gbrain default, 24,000)      auto-default
              assembleEvidenceForHits(first 5 hits, return_unit 'auto', budget_tokens B_pseudo)       auto-l5-b_pseudo
live parity   query { query, limit: 25, expand: false, return_unit: 'auto', token_budget: B_native, use_cache: false }
settings      gbrain balanced defaults, plus (written to the brain's config table, checked at open)
              search.cache.enabled=false, decide.provider=none, search.crag_escalation=false,
              search.crag_think=false, search.track_retrieval=false
```

The cell refuses a frozen-list response that carries delivery meta (the plan was not null). Each pin must be a key in
gbrain's `KNOWN_CONFIG_KEYS` (or `DECIDE_CONFIG_KEYS` for `decide.provider`) and must read back from the brain; an
unknown or unapplied pin refuses the cell. The semantic cache's runtime status (`disabled`) is recorded per row. A
frozen list without rerank scores is retried up to three times; a list still unreranked keeps gbrain's fallback, is
scored, and is counted.

The frozen list is retrieved once, in the freeze cell. The deliver cell re-imports the same sessions (embeddings from
the freeze cell's cache), re-resolves each frozen chunk by page and chunk index, delivers every variant and makes the
one live call. The parity check compares the live delivery with `auto-b_native` on every field a reader consumes
(slug, title, text, unit, chunk ids, spans, tokens, truncation, fallback, `auto` reason, and the totals) and records
the evidence fingerprint separately. At `c5fb0201` the assembled blocks carry no `effective_date` (a keyless fixture
pins this), so dates are never taken from gbrain rows: every dated render reads the session table.

The five-hit derivation was checked keylessly (`test/eval/gbrain-query-system.test.ts`, "a limit-5 frozen list is
the first five of the limit-25 list"); it held, so no separate limit-5 cell runs. Two chunks per page are allowed, so
every row records hit count and distinct-session count.

The bare-budget call (`query { …, token_budget: N }` with no `return_unit`) is recorded keylessly for decision G7: it
resolves no evidence plan and applies legacy chunk budgeting (same test file).

## Recipes and the date channel

Each arm is a named recipe (`eval/runner/memory-qa/arms.ts`, `recipeHash`): its item source, renderer, renderer
version, header format and any selection transform enter the frozen context key and the arm hash. The shootout's
`native` and `rehydrated` contexts keep their old keys, so `shootout-chunk` prompts are produced by the unchanged
code path.

| Recipe | Cell | Items | Render | Transform | Recipe hash (first 16) |
|---|---|---|---|---|---|
| `shootout-chunk` (context `native`) | A | retrieved | native | none | shootout key |
| `chunk-dated` | A | retrieved | native-dated | none | `3657f6388625138e` |
| `chunk-undated-twin` | A | retrieved | native | exactly `chunk-dated`'s packed ids; reuses `native`'s scored row when the prompt hash, reader and judge match | `a893b80da9ab891f` |
| `chunk-dated-pseudo` | A | retrieved | pseudo-session | none | `a6b3706a0008ac5e` |
| `rehydrated` (context `rehydrated`) | A | retrieved | rehydrated | none | shootout key |
| `query-auto` | B | `auto-b_native` | native-dated | none | `71ad067bf128f895` |
| `query-auto-default` | B | `auto-default` | native-dated | none | `6d3e310e1f51e3c8` |
| `query-auto-pseudo` | B | `auto-b_pseudo` | pseudo-session | none | `dde0b346b6564203` |
| `query-auto-pseudo-as-native` | B | `auto-b_pseudo` | native-dated | exactly `query-auto-pseudo`'s packed blocks | `3c8f6ebc58f634e5` |
| `query-auto-l5-pseudo` | B | `auto-l5-b_pseudo` | pseudo-session | none | `584bb7c15fd4e8dd` |
| `query-rehydrated` | B | retrieved (the frozen list) | rehydrated | none | `46b84fcfe8b2f7cc` |

**One date channel.** Every dated gbrain render prints the C1 header at the start of the item text,
`Conversation date: YYYY-MM-DD` followed by a blank line, where the day is the ISO day of the session table's date
for the item's source (`isoSessionDate`). `valid_from` stays unset and no title prefix is added. An undated session or
an empty item gets no header. The gbrain C1 PR must produce the same bytes for the same date.

**Native rendering** is the comparison's `renderItem` (one line per item, whitespace collapsed) under
`NATIVE_READER_TEMPLATE`, in rank order, packed whole items until 8,000 harness tokens (characters divided by four).

**Pseudo-session rendering** is memory-qa's `READER_TEMPLATE` with `renderHistory`, the rehydrated arm's renderer.
Each delivered block becomes one session with the session table's raw date (or `unknown`) and turns rebuilt by the
parser in `eval/runner/systems/render.ts` (`parseBlockTurns`): a turn starts at `**<speaker>:** ` at a line start;
gbrain's omission marker becomes an omission turn; a cut leading fragment stays under the preceding speaker in the
block, or `unknown`; a leading C1 header is consumed and must equal the session table's day, else the row is
harness-invalid; two blocks from one session stay two sessions with the same date; only delivered text is used.
Blocks are taken whole in rank order while the exact serialized history (date order, numbering, JSON escaping,
separators) fits 8,000 harness tokens.

Every reader row records the recipe and its hash, the harness tokens before and after the packer, the number of
items or blocks the packer cut, the packed ids and source ids, the prompt hash and the prompt's UTF-8 bytes.

## Budget sizing (values in amendment A1)

For each benchmark and rendering read through `query`: `B = floor_100(8000 / (r_max × 1.02))`, where `r_max` is the
highest per-question ratio of the rendering's serialized harness tokens to gbrain's `budget_used`, across every
delivery read at that budget (`native`: `auto-b_native`; `pseudo`: `auto-b_pseudo` and `auto-l5-b_pseudo`), measured
on the real frozen lists. The freeze cell records, per question and per grid budget from 3,500 to 8,000 in steps of
100, gbrain's `budget_used` and the serialized token counts of the full list and its first five hits; the script
(`eval/runner/budgeted-delivery/budget-sizing.ts`) starts at 8,000 and iterates until B is stable. Verification at
the chosen B: no serialized delivery exceeds 8,000 harness tokens unless gbrain itself delivered more than B
(`auto`'s documented overrun, which the arm's packer then cuts and counts). BEAM is read only through `query-auto`,
so it needs only `B_native`; its `B_pseudo` is computed and recorded but read by no arm.

## Arms and readers

Readers follow G8: `claude-sonnet-5-5` (the newest Sonnet and the held-out reader) is the only frontier reader in E1.
The comparison's frozen main readers keep the link to its rows: `gpt-4o-2024-08-06` on the slice, `gpt-4o-mini` on
LoCoMo, `gpt-4.1-mini` on BEAM. Judges as in the comparison: `gpt-4o-2024-08-06` on the slice and LoCoMo,
`gpt-4.1-mini` on BEAM. `claude-fable-5-1` runs no counted reader in E1 (Garry's 2026-10-07 rule: Fable is
smoke-only). Arms files: `docs/benchmarks/2026-10-08-gbrain-budgeted-delivery-e1/manifests/arms/`.

| Arm | Slice | LoCoMo dev | BEAM-100K dev |
|---|---|---|---|
| `shootout-chunk` | main | main | main |
| `chunk-dated` | main | main | main |
| `chunk-undated-twin` | main | main | main |
| `chunk-dated-pseudo` | Sonnet | main (droppable) | none |
| `rehydrated` | main and Sonnet | main | main |
| `query-auto` | main | main | main |
| `query-auto-default` | main | main (droppable) | none |
| `query-auto-pseudo` | Sonnet | main (droppable) | none |
| `query-auto-pseudo-as-native` | Sonnet | none | none |
| `query-auto-l5-pseudo` | Sonnet | main (droppable) | none |
| `query-rehydrated` | Sonnet | none | none |
| saved-facts probe | none | main (droppable) | none |

The saved-facts probe is memory-qa's existing facts lane as it is (`--system gbrain --facts conversation --qa reader
--qa-context facts`), on LoCoMo dev with the main reader, at gbrain `c5fb0201`; the one harness change records the
facts context's token count per row (`qa_facts_tokens`). It runs on a different adapter (the legacy path), prompt and
ingest, with an unbounded context, and the readings say so.

## Accounting gate (passed before any spend)

The committed adapters ran keyless through memory-qa (hash vectors, reranker off, the stub proxy answering every
reader and judge call with canned text) on all three benchmarks, both cells and every arm
(`eval/runner/budgeted-delivery/keyless-gate.sh`), and `accounting-gate.ts` checked every row: pins applied, cache
status, the frozen and live requests equal to the preregistered objects, every delivery record complete and agreeing
with its own blocks (block counts, per-block tokens against `tokens_delivered`, evidence bytes, spill count, overrun
fields, unit, budget), live parity recorded, rerank presence on Cell A rows, and every reader context with its cut
count. It does not require `query-auto` to stay under budget. Results: see amendment A0.

## Vendor date fairness (disclosed, no action)

Two vendor shims leave `valid_from` unset. Neither drops a date its product returns: memory-bank prints each fact's
`occurred` and `mentioned` times into the item text (`eval/systems/memory-bank/shim.py`, `_fact_text`), and
graph-pipeline ingests every turn pair with a `Time anchor: <event time>` line that its returned chunks carry
(`render_session`). So no harness fix is owed for them, and E1 reruns no vendor.

## Reproduction band and stop rule

`shootout-chunk` and `rehydrated` (main readers) must reproduce the comparison's frozen scores
(`gbrain-shootout-master-common-*`, QA service quality 59.0% / 64.9% / 60.5% and 78.0% / 72.7% / 59.4%) within 4
points on the slice, 3 on LoCoMo dev and 5 on BEAM-100K dev, with at least 85% per-question agreement on the slice.
The count of unreranked Cell A rows is reported beside the band. A miss stops E1 for a determinism check before any
reading is made.

## Readings (exploratory triage)

Every reading reports the paired difference with a cluster-bootstrap 95% interval (10,000 draws,
`eval/runner/stats/paired.ts`) beside the point estimate, after the cross-arm harness-exclusion join. Scores are QA
service quality (product failures count as wrong). None sets a default.

1. **Date effect.** `chunk-dated` minus `chunk-undated-twin`, main reader, on LoCoMo temporal and on the slice. If the
   paired difference on LoCoMo temporal is 24.5 points or more (half the historical 49-point gap), the LoCoMo
   shortfall is mainly an adapter finding; below that it stays a presentation bundle. Absolute scores and recovery
   against the historical 25 are reported separately and not called a date effect.
2. **Product path at 8,000.** `query-auto` minus `chunk-dated`, main reader, on the slice (LoCoMo and BEAM
   descriptive). On questions where the frozen `query` list equals the same-length prefix of Cell A's list and live
   parity holds, the difference is a delivery effect; elsewhere a product-path effect. Both counts are reported.
3. **Depth at matched rendering, reader and retrieval** (Sonnet, slice): (a) `query-rehydrated` minus the better of
   `query-auto-pseudo` and `query-auto-l5-pseudo`; (b) `rehydrated` minus `chunk-dated-pseudo`.
   - `chunk-dated-pseudo` within 3 points of `rehydrated`: dates and layout were the lever; C1 leads and C2's depth
     variant moves down.
   - `query-auto-l5-pseudo` within 3 points of `query-rehydrated`: hit count is the lever; `breadth_capped` leads E2.
   - Both gaps 5 points or more: E2 runs the full C2 family.
   - Otherwise uncertain: E2 runs `cap_only` and `breadth_capped`, and C4 stage 1 moves ahead of `depth_first`.
4. **Rendering effect.** `query-auto-pseudo` minus `query-auto-pseudo-as-native` (same blocks, same reader).
5. **As shipped.** `query-auto-default` with its budget and token count; decides nothing.
6. **Facts headroom.** The saved-facts probe against the best LoCoMo arm, disclosed as a different runner and an
   unbounded context. At or above the best E1 arm: C4 stage 1 earns its harness work now.

Each row also reports, per `query` arm: gbrain's `budget_used` against B, the share of questions over budget, spilled
blocks, hit and distinct-session counts, packer cuts, and live parity.

## Budget, spending order and drop order

Cap $100 (approved; expected about $47). One campaign ledger (`campaign.json`, `eval/runner/shootout-cell.ts`): VM
cells reserve leases and spend through their metering proxies; host reader replays reserve from the same campaign run
(`--paid --budget-ledger … --budget-run-id …`). Spending order: (1) the keyless accounting gate ($0); (2) the
label-free retrieval freeze (freeze cells, no reader or judge call); (3) B sized at $0 and committed as amendment A1;
(4) deliver cells (live parity) and only then reader calls, protected arms first. Before the optional steps, the drop
planner (`eval/runner/budgeted-delivery/drop-order.ts`) drops, in this order, until the rest fits what the ledger has
left: the LoCoMo pseudo-session arms (`chunk-dated-pseudo`, `query-auto-pseudo`, `query-auto-l5-pseudo`), then
`query-auto-default` on LoCoMo, then the facts probe. Steering arms and matched controls are never dropped; if they
alone do not fit, E1 stops.

## Amendments

### A0 (2026-10-08): accounting gate results

Passed on all three benchmarks before the first paid cell, at gbrain `c5fb0201` (overlay), hash vectors, reranker off,
budgets from the keyless sizing run on a coarse grid (provisional, never used for a paid arm). Receipts:
`docs/benchmarks/2026-10-08-gbrain-budgeted-delivery-e1/receipts/keyless-gate/`.

| Benchmark | Cell A rows | Cell B rows | Problems | Live parity equal | `auto-b_native` over budget (spilled) | Keyless B (native / pseudo) |
|---|---:|---:|---:|---:|---:|---:|
| LoCoMo dev | 587 | 587 | 0 | 587 of 587 | 587 of 587 | 6,000 / 6,000 |
| BEAM-100K dev | 120 | 120 | 0 | 120 of 120 | 119 of 120 | 6,000 / 6,000 |
| LongMemEval-S slice | 100 | 100 | 0 | 100 of 100 | 100 of 100 | 6,000 / 4,000 |

Every delivery record was complete and agreed with its own blocks, and every reader context counted its cuts. The
undated twin reused the `native` scored row on 453 of 587 LoCoMo questions (identical prompt bytes). As expected,
today's `auto` overran an explicit budget on nearly every question; the gate records that and does not fail on it.

### A1 (2026-10-08): budgets, frozen before any deliver cell, live parity call or reader call

From `budget-sizing.ts` on the real frozen lists of the freeze cells (`e1-freeze-*`, settled at $2.90 in total), grid
3,500 to 8,000 in steps of 100. Ratios are serialized harness tokens over gbrain's `budget_used` at the chosen B.
Receipts (counts only): `docs/benchmarks/2026-10-08-gbrain-budgeted-delivery-e1/receipts/sizing/`.

| Benchmark | Questions | `B_native` | native ratio, max | `B_pseudo` | pseudo ratio, max (full list and first five) | `auto` over B on the full list (native) |
|---|---:|---:|---|---:|---|---:|
| LongMemEval-S slice | 100 | **6,200** | 1.251 (p50 1.144, p99 1.249) | **5,500** | 1.409 (p50 1.189, p99 1.315) | 100 of 100 |
| LoCoMo dev | 587 | **7,300** | 1.061 (p50 1.012, p99 1.058) | **6,400** | 1.218 (p50 1.166, p99 1.211) | 587 of 587 |
| BEAM-100K dev | 120 | **6,400** | 1.219 (p50 1.033, p99 1.204) | **6,000** | 1.292 (p50 1.145, p99 1.282) | 119 of 120 |

Verification passed for every pair: no serialized delivery exceeds 8,000 harness tokens unless gbrain delivered more
than B. On the full 25-hit list gbrain delivered more than B on nearly every question (the documented spill), so those
contexts are cut by the arm's packer and the cuts are counted. No Cell A or Cell B frozen list lacked rerank scores
(0 of 807 in each cell), so no rerank retry fired. BEAM reads only `B_native`.

## Changelog

### 2026-10-08: A1 budgets

`B_native` and `B_pseudo` filled from the real frozen lists, before any deliver cell or reader call.

### 2026-10-08: frozen

First version, frozen before any paid call; B pending (A1).
