# What gbrain hands the reader under a token budget: plan (v3)

Status: v3, approved by Garry on 2026-10-08 with all eight recommended defaults (G1 to G8 as written below) and with
every cap doubled: program $700 (was $350), E1 $100, E2 $270, E3 $10, E4 $80, H1 $240. Expected costs are unchanged;
the extra is headroom, not new scope. It integrates the CEO phase ([Claude](reviews/ceo-claude.md),
[Astra](reviews/ceo-astra.md)) and the engineering phase ([Claude](reviews/eng-claude.md),
[Astra](reviews/eng-astra.md)), each with two independent voices. The approval record is under
[Decisions for Garry](#decisions-for-garry). Lane A (E1's harness work and its paid run) can start; gbrain PR 1 and E2
wait for E1's readings.

The diagnosis comes from the committed shootout rows and a keyless replay ($0, hash vectors, no provider key in the
environment). Written 2026-10-08 against gbrain-evals `f1ce49fe` (main), the shootout results at `9c07b7e2` (branch
`capy/oss-memory-shootout`, draft PR #89), and gbrain `c5fb0201` (v0.60.95.0, the shootout's counted master). gbrain
master is now `7aa2caa`; every gbrain file cited here for search, delivery and the `query` operation is
byte-identical between the two, so the line numbers hold for both. All four reviewers checked the citations
independently and found them accurate. The harness code E1 extends (`eval/runner/systems/` and the multi-arm
memory-qa runner) exists only on PR #89's branch, so E1's code branches from that head (`9c07b7e2`) or lands after
PR #89 merges.

## In plain words

When an agent asks gbrain a question with room for 8,000 tokens of evidence, gbrain finds the right conversations more
often than any other system in the open-source memory comparison, yet the reader answers fewer questions correctly
than with systems that hand over whole sessions or short dated facts. This plan works out why, and what to build.

The short answer has three parts, each with what is established and what is not:

1. **The shootout adapter did not measure the agent's read path.** It called gbrain's internal ranking function, not
   the `query` operation an agent uses. So the reader got bare text chunks with no session dates and none of gbrain's
   evidence delivery. On LoCoMo temporal questions gbrain's own retrieval found every needed session 95 times in 100,
   but the reader answered 25 of 100 from undated chunks and 74 of 100 from the same sessions shown whole, dated, in
   date order and under a different reading prompt. That jump is a bundle of changes. The first experiment, E1,
   separates the date from the rest.
2. **`query` has a real problem at small budgets.** Through `query` with an 8,000-token budget, gbrain's `auto`
   delivery would still hand back mostly chunks, and more tokens than asked. `auto` was tuned for a 24,000-token budget
   and five hits; at 8,000 tokens and the 25 hits `query` returns by default, it gives each hit session a matching
   chunk first, expands whole sessions only after that, and delivers the sessions that did not fit as chunks outside
   the budget. The overrun is documented behavior, so fixing it is a contract change that Garry decides
   ([decision G1](#decisions-for-garry)). The fix engages only when a caller passes a budget explicitly, so the
   agent's default `query` call, which passes none, is untouched whatever the experiments find.
3. **Whole sessions are not the ceiling at 8,000 tokens.** With the sessions rehydrated, gbrain reaches 78% on the
   LongMemEval-S slice. Two systems that return extracted facts or observations reach 83% and 89% there, and one
   reaches 76% on LoCoMo with about 950 tokens. These are whole different systems, so they suggest, but do not prove,
   that compact dated evidence packs more answers into a fixed budget.

The plan proposes a measurement fix and five gbrain changes, each with a preregistrable test and a cost. The first
experiment, E1, costs about $47 (cap $50, [decision G2](#decisions-for-garry)). It needs no gbrain code, and it tells
us which of four levers matters before anything is built: dates, rendering, hit count, or depth.

## What changed in v3

The engineering phase found that three code paths the plan relied on do not behave as v2 assumed, and that several
E1 readings compared arms that differ in more than the lever they name. v3 fixes each one.

- **Frozen-hit delivery keeps the date.** gbrain's `assembleEvidenceForHits`, the path for delivering on a frozen hit
  list, drops `effective_date`, and the existing evidence fingerprint does not notice. The C2 gbrain PR projects the
  date, the parity check compares every field the reader consumes, and E1 takes dates from the harness's own session
  table so it is unaffected at `c5fb0201`.
- **The cap engages only on an explicit budget.** A new `budgetExplicit` flag on gbrain's evidence plan separates a
  passed budget from the default one, across `query`, `search`, `recall` and `assemble_evidence`. Every C2 variant is
  inert without an explicit budget, so the default-budget comparison is exact by construction and an H1 pass changes
  nothing for callers that don't pass a budget.
- **The cap is specified as code rules,** including spill, notes, the rank-one cut, the snippet cap that can grow a
  3-token allocation to 18 tokens, and a minimum-budget contract that goes to Garry under G1.
- **One `query` construction for E1 and E2.** One chunk-unit `query` call per question freezes the ranked hit list;
  every delivery variant runs on it through `assembleEvidenceForHits`; one live `query` call per question checks that
  the frozen delivery equals the product's.
- **Matched readings.** Reading 1 uses the paired date difference, reading 2 compares two dated arms, reading 3
  compares depth on the same hit list, and reading 4 compares renderings on the same blocks and reader. Two Sonnet
  control arms ($3.70) make that possible inside the $50 cap.
- **The budget is sized per rendering on the real hit list.** Pseudo-session rendering serializes turns as JSON and
  runs up to 1.27 times longer, so one value cannot fit both renderings.
- **One renderer from dev to held-out.** Pseudo-session means memory-qa's reading template, and H1 runs through
  memory-qa's custody path so E2 and H1 read the same bytes.
- **Corrected settings.** The cache pin used a key that does not exist, for a cache that is off in every build in
  scope; the diagnosis sentence about it was wrong. The `query` path's other settings (decide slots, CRAG, retrieval
  write-back, `expand`) are pinned and recorded.
- **Build plan.** Architecture and codepath-to-test diagrams, ordered tasks with effort, and a failure registry whose
  seven critical gaps each have a fix.
- **Costs.** E1 $44 to $47 (cap $50 unchanged); E2 cap $160 to $135, because the default-budget guard no longer needs
  reader calls; program about $270, cap $350.

The [review record](#review-record) maps every reviewer finding to the change it produced, and the
[decision log](#autonomous-decision-log) lists what was decided without Garry and why.

## What the shootout measured

The [preregistration](https://github.com/garrytan/gbrain-evals/blob/9c07b7e2f90715593b43d9bdc2a7652174636691/docs/benchmarks/2026-10-06-oss-memory-shootout-preregistration.md)
fixes the arms: one retrieval per question and policy, then either `native` context (the item text the system
returned, in rank order) or `rehydrated` context (the raw sessions behind the items' source ids, whole, in
first-appearance order, shown in date order with dates). The `fixed-evidence` policy packs to 8,000 tokens, counted as
characters divided by four; the packer takes items whole in rank order and the first item that does not fit ends the
pack. Readers are the frozen main readers (`gpt-4o-2024-08-06` on LongMemEval-S, `gpt-4o-mini` on LoCoMo,
`gpt-4.1-mini` on BEAM). Scores below are QA service quality (product failures count as wrong), recomputed from each
arm's `rows.ndjson.gz` and equal to the arm receipt's `qa_service_score`. The Astra reviews recomputed the gbrain rows
independently and got the same values.

Systems are named by kind: temporal-graph, graph-pipeline, extract-first, memory-bank, markdown-notes, plus the
plain-hybrid control (Postgres full-text plus pgvector over whole dated sessions, no gbrain code). The agent-runtime
system runs only in the agent tasks and has no row here.

**LongMemEval-S, 100-question slice (the inferential set), 8,000-token native evidence**

| System | QA service quality | Strict recall of all gold sessions at 5 | Mean context tokens |
|---|---:|---:|---:|
| memory-bank | 89.0% | 97.9% | 7,931 |
| graph-pipeline | 83.0% | 93.8% | 7,669 |
| extract-first | 77.0% | 93.8% | 7,804 |
| plain-hybrid control | 71.0% (71.7% of completed calls) | 89.6% | 6,276 |
| markdown-notes | 69.0% | 83.3% | 5,758 |
| **gbrain-shootout (master)** | **59.0%** | **97.9%** | 7,660 |
| temporal-graph | 37.0% | 39.6% | 6,950 |
| gbrain-shootout, same retrieval, rehydrated | 78.0% | 97.9% | 6,064 |
| full history, no retrieval (about 128,000 tokens) | 78.0% | n/a | 128,160 |
| gbrain-legacy (top five sessions whole, no budget) | 86.0% | 94.8% | 16,332 |
| no memory | 9.0% | n/a | 0 |

**LoCoMo dev (3 conversations, 587 questions, descriptive) and BEAM-100K dev (6 conversations, 120 questions,
descriptive), 8,000-token native evidence**

| System | LoCoMo QA | LoCoMo recall_all@5 | BEAM QA | BEAM recall_all@5 |
|---|---:|---:|---:|---:|
| extract-first | 76.0% (76.1% at its own default, 953 tokens) | 83.8% | 55.4% | 42.6% |
| memory-bank | 75.6% | 80.6% | 58.3% | 39.8% |
| graph-pipeline | 69.0% | 83.0% | 56.9% | 53.7% |
| markdown-notes | 67.3% | 73.3% | 57.6% | 44.4% |
| plain-hybrid control | 67.0% | 72.2% | 54.9% | 42.6% |
| temporal-graph | 65.4% | 63.8% | 43.1% | 12.0% |
| **gbrain-shootout (master)** | **64.9%** | **87.3%** | **60.5%** | **57.4%** |
| gbrain-shootout, rehydrated | 72.7% | 87.3% | 59.4% | 57.4% |

Two corrections to the summary we started from. On LongMemEval-S gbrain ties the memory-bank system on strict recall
(97.9% each) rather than leading alone. On BEAM-100K dev gbrain's native score is the highest of all systems at 8,000
tokens, and rehydrating does not help there (+19 / −23 questions); the accuracy gap is a LongMemEval-S and LoCoMo
finding, and BEAM has only six conversations.

## What the gbrain-shootout adapter hands the reader

All of this is from the committed rows (`receipts/gbrain-rows-profile.txt`) and the code at the cited lines.

**The call.** `GbrainShootoutSystem.retrieve` calls gbrain's `hybridSearch` library function with only a `limit`
(`eval/runner/systems/gbrain.ts:178-188` at `9c07b7e2`), 40 for `fixed-evidence` and the mode default for
`vendor-default` (`gbrain.ts:164`). It maps each result to an item of type `chunk` whose text is `chunk_text` alone,
with `valid_from: null` (`gbrain.ts:183-186`). It passes no gbrain config, so gbrain's own defaults apply: `balanced`
mode with the reranker on, search limit 25 and a 12,000-token search budget (`src/core/search/mode.ts:494-504`).
Every retrieval made two provider requests ($0.00064 to $0.00076 per question), which fits one query embedding plus
one rerank call. `balanced` also advertises a semantic result cache at similarity 0.92 (`mode.ts:494-498`), but
`semanticResultCacheAvailable()` returns `false` at `c5fb0201` and at master (`src/core/search/query-cache.ts:35`),
and the direct `hybridSearch` call does not pass through the cache wrapper, so no shootout row was served from a
cache. v3 still pins the cache off for future builds and asserts its runtime status `disabled` (C0).

**What comes back.** gbrain keeps at most two chunks per page (`src/core/search/dedup.ts:25`) and cuts the return to
its 12,000-token search budget (`src/core/search/hybrid/rank.ts:461`), so the budget, not the limit, decides the
count: asking for 40 returned about the same number as asking for 25 (18.9 against 18.5 chunks on the slice).

| Benchmark | Chunk items returned (min to max) | Tokens per item (harness count) | Items that fit 8,000 tokens (estimated) | Share kept |
|---|---:|---:|---:|---:|
| LongMemEval-S slice | 18.9 (16 to 24) | 636 | 12.1 | 64% |
| LoCoMo dev | 21.6 (19 to 26) | 542 | 14.3 | 66% |
| BEAM-100K dev | 19.1 (13 to 40) | 623 | 12.8 | 67% |

The estimate divides each question's packed 8,000-token context by its tokens per item from the unbudgeted arm, since
the published rows do not store packed item ids. The runner computes them (`qa_context` with `item_ids`, `source_ids`
and `prompt_sha256`, `eval/runner/memory-qa/run.ts:192,693`), but they did not reach the committed rows. So about a
third of what gbrain returned was cut by the harness packer, in rank order. Every new arm keeps `qa_context` in its
published rows so that no later reading has to estimate it.

**No dates.** gbrain renders each session as a conversation page whose date sits in the frontmatter and the title
(`eval/runner/memory-qa/corpus.ts:81-88`); chunk text is the turns only. gbrain's results carry the date as `title`
and `effective_date` (`src/core/types.ts:891`), and the `query` operation keeps both in its lean rows
(`src/core/search/lean-rows.ts:27`). The adapter dropped both, so the harness renderer printed no date for any gbrain
item (`eval/runner/systems/render.ts:46-48` prints one only when `valid_from` is set). The plain-hybrid control and
three of the five vendor shims set `valid_from` on their items; E1 checks whether the other two drop a date their
product returns.

**No evidence delivery.** gbrain's `return_unit` stage, whose default is `auto` (`src/core/search/evidence-delivery.ts:189`),
runs inside the `query` and `search` operations (`src/core/ops/search.ts:821` builds the plan, `:152` delivers), after
`hybridSearch` returns. Calling `hybridSearch` directly skips it. So `auto`, the delivery default that passed the
sealed v2 release check (192 against 132 of 200), was not in play in any shootout gbrain row.

**Rendering differs between the two shootout arms.** Native items are flattened to one line each (`renderItem`
replaces runs of whitespace with one space, `render.ts:46-48`) under `NATIVE_READER_TEMPLATE`. The rehydrated arm uses
LongMemEval's reading prompt (`READER_TEMPLATE`) with dated, turn-by-turn sessions in date order, each session's turns
serialized as JSON (`render.ts:36,79-123`; `eval/runner/memory-qa/qa.ts:35,45-47`). Sealed v2 decision 1 used a third
renderer, gbrain's own (`renderChatBlock`, `READER_NOTES_SYSTEM_TEXT`, `buildReaderUserText`;
`eval/runner/evidence-delivery/e1.ts:24-28`). v3 pins one of them for every pseudo-session arm from E1 to H1 (C0).

**What rehydration changed, same retrieval, same reader.** Rehydrated against native at 8,000 tokens:

| Benchmark | Rehydrated wins / losses | Wins where all gold sessions were already in the top five | Largest category change |
|---|---:|---:|---|
| LongMemEval-S slice | +25 / −6 | 24 of 25 | spread: knowledge-update +5, preference +5, temporal +3, multi-session +3, single-session-user +3 |
| LoCoMo dev | +90 / −44 | 72 of 90 | temporal 25 → 74 of 100 (95 of 100 had every gold session in the top five) |
| BEAM-100K dev | +19 / −23 | 9 of 19 | temporal 5.5 → 9.5 of 12, others flat or down |

Rehydration changes six things at once: which items fit the budget, how much of each session the reader sees, the
order (date order), the layout (turn by turn), whether dates are visible, and the reading prompt. On LoCoMo, against
the extract-first system's 76.0%, gbrain is behind by 49 temporal questions and ahead by 10 on multi-hop and
open-domain, so the temporal loss is about three quarters of the gap. Most of those 49 questions had every gold
session in the top five, which points to presentation rather than retrieval. Dates are the likeliest single cause,
but this table cannot separate them from the other five changes; E1's date-only pair does.

### What gbrain's own `query` would have delivered at 8,000 tokens

The keyless replay (`receipts/keyless-delivery-replay.ts`, outputs and summary beside it) imported each LoCoMo dev
conversation and each LongMemEval-S slice haystack into a fresh brain, ran `hybridSearch` and then the evidence stage
exactly as `query` does (`resolveEvidencePlan`, `effectivePlan`, `deliverEvidence`), with hash vectors, the reranker
off and `returnUnit: 'auto'` passed explicitly. Hash vectors rank worse than real embeddings, so the replay says
nothing about accuracy; it shows what the delivery stage does with a list of hits.

| LongMemEval-S slice, per question | Shootout chunks | `auto`, 8,000 budget, 25 hits (`query` default) | `auto`, 24,000 (product default), 25 hits | `auto`, 8,000, 5 hits |
|---|---:|---:|---:|---:|
| Blocks delivered | 19.8 chunks | 19.3 | 19.3 | 5.0 |
| Whole sessions among them | 0 | 0.6 | 6.7 | 2.2 |
| Sessions that fell back to chunks | n/a | 4.5 | 0 | 0 |
| Tokens delivered, gbrain's count | n/a | 10,523 (over budget on 100 of 100) | 23,998 | 7,927 (over budget on 0 of 100) |
| Tokens, harness count | 11,710 | 12,086 | 27,598 | 9,127 |

On LoCoMo dev the 8,000-token `auto` call was over budget on all 587 questions (mean 11,430 tokens by gbrain's count),
with 5.9 whole sessions and 6.5 fallen-back chunks per question. At 5 hits it stayed within budget on all 587 and
delivered all five sessions whole (mean 3,872 tokens).

Two product behaviors explain this, both visible in the code, pinned by gbrain's own tests and described in gbrain's
documentation:

- **Breadth before depth.** `allocate` first reserves every hit page's matching chunk ("floor") in rank order, then
  expands pages toward whole sessions in rank order (`src/core/search/evidence-delivery.ts:680-735`). With 25 hits
  and 8,000 tokens the floors use the budget, so almost nothing becomes a whole session.
- **The budget is not a cap under `auto`.** A conversation whose floor does not fit is "spilled" to its ranked chunks,
  which are appended after allocation without being counted against the budget (`evidence-delivery.ts:894-898,944-957`).
  Two tests pin this: the property test at `test/evidence-delivery.test.ts:228-270` ("hit lost" check and zero
  dropped at budgets 40 to 24,000) and the spill test at `:272-287`. Non-conversation chunks are reserved and emitted
  unchanged too (`evidence-delivery.ts:827-837,896`), so they can also exceed the budget. This is the documented
  contract: "`auto` never returns less than `chunk` would. `budget_used` exceeds `budget_tokens` only by such
  unchanged chunks" (gbrain `docs/evidence-delivery.md:118-123`). At 24,000 tokens and five hits, the setting `auto`
  was tuned and confirmed on, the spill almost never fires. At 8,000 tokens it fires on every question.

**A bare budget selects a different unit.** A `query` call that passes a numeric `token_budget` without an explicit
`return_unit` invokes legacy chunk budgeting, even when the configured unit is `auto`
(`src/core/ops/search.ts:129-140` passes `legacyBudget`; `evidence-delivery.ts:186-202` changes the implied unit to
`chunk`). So an ordinary caller who only passes a budget does not get `auto` today. Every `query` arm in this plan
passes `return_unit` explicitly; E1 also records, keylessly, what the bare-budget call returns, and
[decision G7](#decisions-for-garry) asks whether that should change.

**Token units.** gbrain counts delivered text with `cl100k` while the harness counts characters divided by four. On
the LongMemEval-S slice the harness count runs 1.15 times gbrain's on average, but 45 to 53 of 100 questions run
higher and the maximum is 1.288; on LoCoMo dev the mean is about 1.02 and the maximum 1.091
(`receipts/token-ratio-distribution.txt`). Those ratios are for raw delivered text. Pseudo-session and rehydrated
contexts serialize turns as JSON, which on the 89 LoCoMo dev sessions runs 1.159 times the Markdown turn text in
characters on average and 1.273 at most (measured $0 in the Claude engineering review). So the budget is sized per
benchmark and per rendering (C0).

### Diagnosis: adapter or product

Both, in proportions E1 is built to measure.

- **Adapter configuration.** The adapter measured gbrain's ranking function, not the agent's read path. It dropped
  the dates gbrain returns, skipped evidence delivery, and was read through a different layout and prompt than the
  rehydrated reference. On LoCoMo the missing dates are the likeliest main cause; E1's date-only pair, with identical
  selections, measures it. This needs no gbrain change, only new, separately named adapter modes and a new dated run;
  the frozen shootout rows stand as measured.
- **Product.** Through `query`, gbrain at 8,000 tokens would still deliver mostly chunks and overrun the budget,
  because `auto` spends a small budget on breadth and its documented contract does not treat the budget as a cap. The
  overrun is a contract question (G1). Whether the accuracy gap is the allocation algorithm or simply the hit count is
  open: at 5 hits `auto` already stays within budget and delivers whole sessions. E1 measures both.
- **Beyond whole sessions.** Even rehydrated, gbrain trails the fact- and observation-returning systems on
  LongMemEval-S (78% against 83% and 89%) and is near them on LoCoMo (72.7% against 76.0% and 75.6%). Whole sessions
  of about 2,900 tokens fit only two at a time into 8,000 tokens; the rehydrated pack averages 2.1 sessions on
  LongMemEval-S. Raw-session readouts on the slice stay between 78% and 86% at any volume (two sessions 78%, full
  history 78%, all retrieved 80%, five whole 86%). Those other systems differ in more than extraction, so this is a
  reason to probe facts early, not evidence that extraction is the cause.

## Candidate changes

Each candidate names its mechanism, where it lives, the preregistrable test and its cost. Costs come from the
shootout's measured per-question tokens and the ledger's prices (`eval/runner/budget-ledger.ts`), priced per arm from
its own token envelope; the [cost table](#cost-table) collects them. One 8,000-token arm with the main reader and
judge costs about $2.20 on the LongMemEval-S slice, about $1.10 on LoCoMo dev and about $0.60 on BEAM-100K dev. The
same arm with `claude-sonnet-5-5` ($2 per million input, $10 output) costs about $1.85 on the slice and about $9.25 on
the LongMemEval-S 500. An arm at the 24,000 default reads about 3.5 times the tokens on the slice and 2.2 times on
LoCoMo. A gbrain ingest's embeddings cost $1.53 on the slice (21,821 embeddings), about $7.65 on the 500, about $0.02
on LoCoMo dev and $0.11 on BEAM dev; separate cells share the warm embedding cache (`run.ts:483-486`), so embeddings
are paid once per benchmark and only the PGLite import repeats per cell. Retrieval with the reranker costs $0.07 to
$0.38 per 100 questions per policy. Replaying one slice arm's frozen contexts with the four newest frontier readers
(`claude-opus-5-5`, `gpt-6.1-sol`, `claude-sonnet-5-5`, `claude-fable-5-1`) costs about $20, most of it Fable. Every
estimate is cold cache; the embedding cache is local, so a warm machine pays less, and no estimate assumes it.

### C0. Measure through the agent's read path (measurement fix, not a product change)

**Two cells per benchmark, named recipes inside each.** A memory-qa cell is one system and one ingest, with arms
built from policy, context and reader (`eval/runner/memory-qa/arms.ts:60,64`). E1 uses two cells per benchmark:

- **Cell A**, `GbrainShootoutSystem` with a new `dated` option that adds an optional `event_date` to each item, taken
  from the namespace's session table by source id, never from the gbrain row. Native rendering ignores `event_date`,
  so `shootout-chunk` prompts stay byte-identical to the frozen golden. Its one `hybridSearch` retrieval at limit 40
  feeds `shootout-chunk`, `chunk-dated`, `chunk-undated-twin`, `chunk-dated-pseudo` and `rehydrated`.
- **Cell B**, a new `GbrainQuerySystem` that calls gbrain's `query` handler and `assembleEvidenceForHits` in process
  with a local operation context (the pattern in `eval/runner/a4-abstention.ts:271-272`). Its policies map
  `vendor-default` to no budget and `fixed-evidence` to `B`, as the memory-bank system's capability record passes its
  own `max_tokens: 8000`.

A third cell exists only if the five-hit prefix check below fails. The saved-facts probe is its own lane with its own
extraction, outside both cells.

**Replay identity keys.** Today `retrievalKey` is question plus policy mode, `contextKey` adds only context and
harness budget, and `runConfigHash` omits `policySettings` (`arms.ts:93-117`; `run.ts:351-357,519-523,719-736`), so
a 5-hit and a 25-hit delivery under `fixed-evidence`, or a swapped renderer on a resumed cell, could reuse the wrong
retrieval or prompt. Every arm gets an immutable recipe id: a hash of the adapter and loaded gbrain build, the
resolved call and settings, the retrieval variant (which frozen list), the delivery variant (unit, budget, hit
prefix), the renderer and its version, and the selection transform (for example, the undated twin). The relevant
parts enter the run, retrieval, context and arm hashes. Mutation tests change each field and require the affected
artifact to be invalidated, while adding only a reader reuses the frozen prompt. Existing frozen-row formats stay
readable; the new recipe format is versioned.

**One frozen hit list per question, with a live parity check.** `query` returns delivered blocks grouped per page,
so it exposes no pre-delivery hit list to record. gbrain already ships the seam: `assembleEvidenceForHits` is "the
library entry gbrain-evals calls for a frozen candidate list: the same plan resolution, assembler and output
redaction the `query` op applies" (`evidence-delivery.ts:1118-1124`). Per question, Cell B makes:

1. **One chunk-unit `query` call.** With `return_unit: 'chunk'` and no `token_budget`, the evidence plan resolves to
   null, so the evidence stage is inert and no chunk budget applies (`tokenBudget: !plan && ...`,
   `ops/search.ts:951`). The returned rows are the ranked hit list, frozen and memoized per question. The cell refuses
   the question if the plan is not null or a budget was applied.
2. **Every delivery variant on that list** through `assembleEvidenceForHits`: `auto` at `B_native`, `auto` at
   `B_pseudo`, `auto` with no budget (24,000), and `auto` at `B_pseudo` on the list's first five hits.
3. **One live `query` call** with `return_unit: 'auto'` at `B_native`. Its delivery is compared with the assembled
   `auto` at `B_native` on the evidence fingerprint and on every field the reader consumes: text, title, order, unit,
   spans, token totals and fallbacks. The fingerprint alone omits dates and titles (Astra found a real-PGLite case
   where assembly lost the date and the fingerprints matched), so it is not enough. At `c5fb0201` assembly carries no
   `effective_date`, so the date is checked against the session table instead. Equality means the frozen deliveries
   are the product's; a mismatch is recorded per question and labels that question's comparisons as product path.

The five-hit derivation is valid only if a limit-5 call returns the first five of the limit-25 list. The reranker's
input size is fixed by the mode (`reranker_top_n_in: 25`, `mode.ts:510`), not by the call's limit, so the prefix
should hold; a keyless test proves it, and if it fails, a separate limit-5 cell replaces the derivation. Two chunks
per page are allowed, so five hits can be fewer than five sessions; every row records hit count and distinct-session
count separately.

**The exact calls, preregistered.** Every arm's call is written into the preregistration and printed into each run's
receipt as resolved:

```
frozen list   query { query, limit: 25, expand: false, return_unit: 'chunk' }        (no token_budget; plan null)
deliveries    assembleEvidenceForHits(frozen list, return_unit 'auto', token_budget B_native | B_pseudo | omitted)
              assembleEvidenceForHits(first five of frozen list, return_unit 'auto', token_budget B_pseudo)
live parity   query { query, limit: 25, expand: false, return_unit: 'auto', token_budget: B_native, use_cache: false }
shootout      hybridSearch(query, { limit: 40 })                                       (unchanged)
settings      gbrain defaults for `balanced`, plus
              search.cache.enabled=false          (belt and braces; the cache is unavailable in these builds)
              decide.provider=none                (no decide slots, so no S3 evidence-gate pruning)
              search.crag_escalation=false, search.crag_think=false
              search.track_retrieval=false        (no fire-and-forget last_retrieved_at writes, ops/search.ts:1105)
```

`limit` is pinned in every arm: 25 is the agent default, 5 is the setting `auto` was confirmed on. `expand: false` is
a disclosed deviation from the agent default (`expand` defaults to true, `ops/search.ts:813`), chosen to match the
shootout's retrieval. The decide pin matters because decide slots are key-aware: with a TypeSafe key in the
environment the recommended slots default on (`src/core/ai/decide/config.ts:4-13`), and the A4 runs had such a key.
Settings reach gbrain through the adapter's real config channel; memory-qa passes `a.config`, not `a.pins`, to the
system today (`run.ts:504-509`), so a pin written only to `pins` would be a silent no-op. A keyless test asserts that
every pinned key exists in gbrain's `KNOWN_CONFIG_KEYS` and that its resolved value reaches the handler; an unknown or
unapplied key refuses the cell. The v2 key `search.cache_enabled` does not exist (the registered key is
`search.cache.enabled`, `src/core/config.ts:1312`), which is exactly the failure this test catches.

**One date channel.** Every dated gbrain arm carries its date the same way: the C1 header line at the start of the
item text, built from the session table's date, with `valid_from` unset and no title prefix. Setting `valid_from`
would make `renderItem` print `[valid <date> to present]` (`render.ts:47`), which reads as a fact's validity window,
and a title prefix (`Conversation on <date>`, `corpus.ts:85`) would add a second date. The header bytes are fixed in
the preregistration; the C1 gbrain PR must produce the same bytes (a string-equality test).

**`chunk-dated` and its twin.** `chunk-dated` keeps today's `hybridSearch` call and adds the header, so E1's
`chunk-dated` arm is C1's dev test. `chunk-undated-twin` renders `chunk-dated`'s selected ids without headers. When a
twin prompt's `prompt_sha256` equals the `native` prompt for the same question, and the reader and judge identities
match, the scored row is copied and marked `reused_from`; matching source ids alone is not enough.

**Pseudo-session rendering, pinned.** Pseudo-session means memory-qa's `READER_TEMPLATE` with `renderHistory` over
sessions rebuilt from delivered blocks, in date order with ties broken by rank (`qa.ts:35,45-47`). That matches the
`rehydrated` arm, as reading 3 needs, and H1 uses the same renderer through memory-qa's custody path. The
block-to-turns parser is specified and unit-tested:

- A turn starts at `**<speaker>:** ` (`corpus.ts:87`).
- gbrain's omission marker `[…]` (`EVIDENCE_OMISSION`, `evidence-delivery.ts:53`) becomes an explicit omission turn.
- A cut leading fragment keeps its text under the preceding speaker, or `unknown` when there is none.
- A leading C1 header is consumed as the session's date line and must equal the session table's date, else the row
  is harness-invalid; a session with no date renders its date as `unknown`, never an invented one.
- Two chunks from one session render as two pseudo-sessions with the same date.
- A pseudo-session contains only delivered block text, never raw source turns.

The packer counts the exact serialized history after ordering, numbering, JSON escaping and separators.

**Budget sizing, per benchmark and rendering, on the real hit list.** `B` is sized for each (benchmark, rendering)
pair that a `query` arm reads: `B_native` for native-dated, `B_pseudo` for pseudo-session.
`B = floor_100(8,000 / (r_max × 1.02))`, where `r_max` is the highest per-question ratio of the rendering's serialized
harness tokens to gbrain's `budget_used`, measured on the real frozen hit lists across every arm that will be read
at that budget, and 1.02 is a stated margin. The sizing script iterates until the value is stable and then verifies
that every serialized candidate context at `B` fits 8,000 harness tokens. Sizing costs $0 once the label-free
retrieval freeze has run, because delivery is local. The hash-vector replay selects different sessions than real
retrieval, so its maximum is not a bound for the paid run; its values (6,000 native on the slice and 7,100 on LoCoMo,
from raw text) are provisional only. Combining the two LoCoMo maxima (1.091 and 1.273) suggests roughly 5,600 for
pseudo-sessions there, as an upper-bound guess. `B` is frozen in a preregistration amendment after the retrieval
freeze and before the live parity call or any reader call.

**Reranker handling.** The shootout adapter never checked rerank presence (`rerankPinned: false`,
`gbrain.ts:182`) and ran with the 5-second rerank timeout (`mode.ts:511`); provider reranks can exceed it and fall back
to unreranked order (`eval/runner/evidence-delivery/freeze.ts:44-50`). So the reproduction arm keeps the shootout's
timeout and records rerank presence per row without failing. New arms retry a missing rerank as `harness_invalid`
under the runner's attempt accounting; a row still unreranked after the allowed attempts keeps the product's
fallback, is scored and counted, so product degradation never becomes a free exclusion. Both counts are reported
beside the reproduction band.

**Per-row accounting, typed.** The runner copies selected fields and discards `RetrieveResult.raw`
(`run.ts:664-676`), so diagnostics go in a new typed `RetrieveResult.accounting` field and are asserted by value
against the operation response, not by presence. Every row records the recipe id; gbrain `budget_tokens` and
`budget_used`; spilled-block count; delivery fallbacks (`fetch_failed`, `fetch_timeout`, `page_missing`, which today
degrade blocks silently to chunks); retrieval meta (`meta.decide`, `meta.crag`, `meta.degraded`, captured like
`emitResponseMeta('retrieval', ...)` in `a4-abstention.ts:271`); cache status (`disabled`); rerank presence; hit count
and distinct-session count; the live parity result; the harness token count before and after the packer; the
packer-cut item count; the packed item ids and source ids; the prompt hash; and both the declared gbrain pin
(`a865f8f8` in `package.json`) and the loaded commit (`c5fb0201`), as CLAUDE.md requires.

**Local measurement.** The adapter calls `query` as a trusted local caller. Remote calls require safe chunks, apply
private visibility and default to lean rows (`ops/search.ts:922-939`; `lean-rows.ts:35-50`), so E1 measures the local
path and says so; C2's source-safety tests cover the remote path.

Both cells are new named adapter modes in a new dated run. The shootout's frozen gbrain rows are not edited, and any
later comparison page labels these rows as an adapter revised after seeing the results, on development data.

### C1. Dated evidence blocks in gbrain (test folded into E1)

**Mechanism.** Every delivered conversation block, and every chunk from a dated page that the evidence stage delivers,
starts with a one-line date header built from `effective_date`, so a consumer that renders only the text still sees
when the conversation happened. This is the `query` counterpart of `think`'s date frame (P6 R1), which passed its
sealed LoCoMo check (+14.0 points, temporal 27 → 199 of 221). Today the date is only in separate fields.

**Where.** A `DeliverOptions` flag that only `query`, `search`, `recall` and `assemble_evidence` set, behind its own
config key, separate from C2's. Two paths stay untouched: the plan-null chunk path, whose bytes the off-path golden
protects ("must not be regenerated on a branch that changes the off path",
`test/evidence-delivery-golden.test.ts:7-13`), and `think`, which calls `deliverEvidence` by default and renders
delivered blocks verbatim beside its own date frame (`src/core/think/index.ts:527-540`). Three accounting rules: the
header is priced inside the allocation, before selection; `match_spans` (UTF-16 offsets into `chunk_text`) shift by
the header's exact length, with unmapped ids preserved; and the block is recounted after redaction. The evidence
fingerprint changes with the bytes, as it should.

**Frozen-hit dates.** `resolveFrozenHits` selects page and chunk fields but no `effective_date`
(`evidence-delivery.ts:1085-1086`), so on the frozen path a C1 header would silently vanish. The projection of
`p.effective_date, p.effective_date_source` lands in C2's first gbrain PR, because E2 delivers on frozen lists; a
keyless test requires live `query` and `assembleEvidenceForHits` on the same hits to produce identical delivered
bytes with C1 on and identical date fields with C1 off.

**Test.** E1's date-only pair: `chunk-dated` against an undated twin with the identical selected ids, native
rendering, on LoCoMo dev temporal and the slice. No separate C1 arms remain. C1 changes bytes on purpose, so it has
its own byte guard (guard 2 below), scoped to the cases where it can hold.

**Ships how.** C1 helps only readers that ignore fields, so it rides with the winning C2 variant to the held-out
decision as one bundle. H1's pseudo-session rendering takes each session's date from the harness session table, so
H1 can show C1 does no harm but cannot show its benefit; [decision G5](#decisions-for-garry) asks whether that is
acceptable.

**Cost.** Inside E1.

### C2. Budget-respecting conversation packing (the main candidate, a family of three)

**When it engages.** Only when three things hold: the caller passes `token_budget` explicitly, the unit resolves to
`auto`, and the packing setting names a variant. Today the evidence plan cannot tell an explicit budget from the
default: `EvidencePlan` holds the resolved `budgetTokens` and `explicitUnit` only (`evidence-delivery.ts:103-111`),
and `resolveEvidencePlan` collapses a passed budget and a config or default budget into one number (`:222-225`). C2
adds `budgetExplicit: boolean`, set from `typeof input.budget === 'number'`, and the resolved packing variant to the
plan; allocation reads both from the plan and never rereads global config. Without an explicit budget,
`deliverEvidence` runs today's code for every variant. A bare budget still selects legacy chunk budgeting (G7), and
`page`, `section`, `window` and `chunk` keep their behavior.

The same plan resolution serves four operations, and the cap applies to all four, named in the gbrain CHANGELOG and
in [decision G1](#decisions-for-garry): `query`, `search` (`ops/search.ts:129-140` with `op: 'search'`), `recall`'s
results arm (`src/core/ops/facts.ts:199-205`) and `assemble_evidence` (`evidence-delivery.ts:1142`). `think` passes
no budget (`think/index.ts:527-529`) and is unaffected. Replay through `assembleEvidenceForHits` gets an explicit
query-equivalent policy rather than inheriting another operation's semantics.

**The cap rule, for every variant.** Four code changes, written as rules:

1. **Global priority before allocation.** Rank one in global order, note or conversation, is reserved first. If it
   alone exceeds the budget, it is cut at a piece boundary with a counted omission marker, as `allocate` cuts rank one
   today (`:696-726`). Under `auto` that cut is unreachable today, because `if (spill) { spill(b); continue; }` runs
   first (`:695`); the cap disables spill.
2. **Notes get a prefix, not a reservation.** Non-conversation chunks are no longer reserved wholesale
   (`const reserved = passthrough.reduce(...)`, `:896`). After rank one, the rank-order prefix of them that fits is
   kept and the rest are listed in `dropped_reasons`. This also stops lower-ranked notes from crowding out a leading
   conversation.
3. **No spill.** A conversation whose floor does not fit is listed in `dropped_reasons`, not appended after
   allocation (`:944-957`).
4. **The cap holds at the final evidence boundary.** Redaction and the explicit snippet cap run after
   `deliverEvidence` today (`ops/search.ts:92-103`), and `capDeliveredSnippets` appends a recovery marker and updates
   `tokens_delivered` but not `budget_used` (`evidence-delivery.ts:988-1019`). Astra's keyless probe: a 3-token
   allocation reported `budget_used` 3 while its title, snippet and marker recounted to 18. Under the cap, the date
   header, redaction, snippet cap and markers are applied before the last recount, marker overhead is priced inside
   the allocation, and `budget_used` is the recount of the final evidence fields: title, date header, body, omission
   and recovery markers. JSON metadata outside those fields is not counted, and the contract says so.

**The minimum budget.** Three promises cannot all hold for every budget: cut at a boundary with a marker, non-empty
evidence for a non-empty hit list, and never over budget. A budget smaller than one title plus a marker breaks one of
them. v3 cuts rank one at a piece boundary (the allocator already slices inside a turn), and the choice for budgets
below a documented minimum goes to Garry under G1: the recommended default is a clear validation error that names the
minimum; the alternatives are empty evidence with a reason, or relaxing the marker promise. Zero, negative and
non-finite budgets get the same validation. Above the minimum, a non-empty hit list always yields non-empty evidence.

**The contract change.** For explicit budgets this reverses the documented "`auto` never returns less than `chunk`"
contract, so it waits on G1. The existing tests stay unchanged: the property test at
`test/evidence-delivery.test.ts:228-270` and the spill test at `:272-287` keep pinning today's path, because the test
helper `planOf` (`:174-176`) defaults to `budgetExplicit: false`. Explicit-budget twins are added beside them. The
doc paragraph at `docs/evidence-delivery.md:118-123` and the CHANGELOG change in the same PR and name all four
operations.

**Three allocation variants, one allocator.** Each is a value of `search.auto_packing`, registered in
`KNOWN_CONFIG_KEYS` beside `search.return_*` (`config.ts:1235,1403-1407`), with unknown values rejected. The default
is `off`, today's behavior even with an explicit budget, until H1 passes. For evals, `AssembleEvidenceInput` gets a
library-only `auto_packing` field (trusted local, not an MCP parameter) that wins over config per call, the pattern
`src/core/search/hybrid/request.ts:102-140` uses for eval A/B knobs. The variants are an options object on the
existing `allocate` (`order`, `maxGroups`, `spill`), not a second allocator:

1. **`cap_only`**: today's floors-first `allocate` with the cap rule. The smallest diff; it fixes the contract and
   changes nothing else.
2. **`breadth_capped` (C2-breadth)**: k is the largest number such that the first k conversation groups in rank order
   fit `B`, each priced as title, date header, floor and target window. The target window is the existing `window`
   unit's candidate around the floor, at its configured `return_window`, priced by the existing candidate machinery
   (`evidence-delivery.ts:203-206,833-854`). Rank one is protected by cap rule 1, so an oversized first group is cut,
   never skipped. Groups past k are listed in `dropped_reasons` as `breadth_cap`. Budget left after the k groups is
   spent by floors-first expansion within them. Groups are ordered by their best hit's rank, which has no ties. The
   formula is preregistered and property-tested.
3. **`depth_first` (C2-depth)**: after rank one and the note prefix, take conversation sessions in order of each
   session's best hit; take each whole if it fits what is left, else the largest window around its matching chunks
   that fits, else skip to the next; stop when no remaining session's matching chunk fits.

**Why these three.** Whole sessions beat chunks by 108 of 400 questions in the first evidence-delivery study, ten
chunks in place of five added nothing there, and the harness's depth-first rehydration gains 19 points on the slice
with the same hits, which favors depth. But sealed v2, the held-out material, has about 3,100-token chats, and its 80
multi-session and 40 knowledge-update questions need three or four gold chats: at about 6,000 tokens a depth-first
pack holds two whole chats and a window, so it cannot hold all the gold for most of them. The slice says the same:
two whole sessions 78%, five whole 86%. Breadth of about five with enough depth around each match may be the better
fit, and the cap alone may be most of the value. v3 tests all three instead of presuming one; whether depth-first
stays the preferred direction is [decision G3](#decisions-for-garry).

**Preregistered expectations.** On LongMemEval-S multi-session (about 133 of the 500 questions): `breadth_capped` at
or above today's `auto`; `depth_first` may fall below it. A variant whose multi-session paired estimate falls below
today's by more than the category guard does not go to held-out, whatever its overall score.

**Contract tests (keyless, in the gbrain PRs).** Properties over random corpora at budgets 40 to 24,000, using the
existing fake engine (`test/evidence-delivery.test.ts:43-190`):

- Without an explicit budget, every variant's bytes equal today's (guard 1, structural).
- An explicit 24,000 and the implied 24,000 differ only in the flag.
- With an explicit budget, the recount of the final evidence fields never exceeds it, every variant, every trial.

Fixed cases: mixed notes and chats with global rank one a note, and with rank one a chat; a leading chat followed by
an over-budget note; notes only, over budget (prefix kept, first cut, rest listed); budgets from 1 through the
documented minimum, plus zero, negative and non-finite values, per G1's answer; rank one longer than the budget (cut,
non-empty); spill disabled (no conversation appended outside the budget); zero conversation hits; a missing
`effective_date` (no invented date); redaction that grows or shrinks a block, recounted; `snippet_chars` through the
public operation, recounted; the remote clamp at 32,000 (the cap applies to the clamped value); a cached hit list
(`liveHits: false`) never revives cached text (`:882`); fetch failure, timeout, missing and deleted pages; a token
counter fallback; non-ASCII text for UTF-16 spans; `EVIDENCE_BLOCK_CHAR_CAP` reached before the budget; the
`breadth_capped` k on a fixed fixture; the `depth_first` order and stop rule; a source-swamp fixture modeled on
Cat13b (a curated note and several chat dumps with the same phrase, under a tight budget) checking the note is still
delivered; and `cat13b-source-swamp.ts --stub-embed` with the flag on, expected identical because ranking does not
change.

Unchanged-consumer checks: the off-path golden file and fixture unchanged; `think` prompt bytes equal with C1 on;
`recall` and `search` without a budget byte-identical. Security: the authorized batched page fetch, the live and
cached fallback distinction and the protected-body projection stay as they are (`evidence-delivery.ts:814-899`); the
leak suite (`test/e2e/evidence-delivery-leak.test.ts`) adds two sources with the same slug and private, deleted and
protected pages; local full rows and remote lean rows are both checked. Both storage engines run the suite
(`test/e2e/evidence-delivery-parity.test.ts` with `DATABASE_URL`) before any held-out request.

**Ships how.** Two gbrain PRs. PR 1, `cap_only`: plan provenance, the cap rule, the minimum-budget validation, the
frozen-hit date projection, the config key and library override, the doc paragraph, CHANGELOG and tests; no new
classes, about 60 to 90 source lines plus the final-boundary recount in `ops/search.ts`. PR 2: `breadth_capped` and
`depth_first` as `allocate` options. C1 rides in its own PR. The off-path golden does not change in any of them.

**Test.** E2 below. **Cost.** About $110, cap $135 (E2).

### C3. Session-level merge and ranking of chunks

**Mechanism.** Two parts. (a) Session fusion before delivery: score each session from all its chunk hits (for
example best reranker score plus a damped sum of the rest) and rank sessions, not chunks, so a session that matched
three times outranks one that matched once slightly higher. (b) In `chunk` and `window` delivery, merge same-session
hits into one block in document order with one date header, the way conversation delivery already groups by page
(`evidence-delivery.ts:833-845`). Today the per-page cap of two (`dedup.ts:25`) lets the same session take two of the
25 slots as two separate items, each paying for its own title.

**Test.** Retrieval gate first, nearly free: upstream strict recall_all@5 and @10 on the slice, LoCoMo dev and BEAM
dev (BEAM is where gbrain's recall is lowest, 57.4%), session fusion against today's ranking, with a non-inferiority
guardrail of 1 point on the slice and superiority sought on BEAM. Recall here is computed on the frozen ranked hit
lists, not on delivered blocks. QA only if recall moves: one arm per benchmark under the leading C2 variant. C3 stays
conditional; it is not a prerequisite for fixing the cap.

**Cost.** Retrieval-only runs: about $1.20 (ingest is cached by content; reranks and query embeddings are paid). QA
follow-up about $4 per arm across the three benchmarks.

### C4. Extracted facts as a delivery unit (restaged)

**Mechanism.** gbrain already extracts dated facts from conversations (`extraction.date_grounding` and
`facts.attribution` are on after P2), stores their embeddings and packs facts first in `recall` under a budget
(`src/core/ops/facts.ts:199-217`). But `recall` selects facts by entity, session or time, and the engine has no
query-ranked fact search (the only fact vector query is write-time dedup, `src/core/facts/similar-active.ts:57-65`).
The candidate adds query-ranked fact retrieval and a mixed unit for `query`: the top facts, each with its date and
source session, first, then the leading C2 variant's sessions or windows in what is left. This is the shape of the
two systems that lead at 8,000 tokens, and of the extract-first system's 76% on LoCoMo at 953 tokens, which suggests a
cost verdict (same accuracy, fewer tokens) as well as a quality one.

**What the existing facts lane can and cannot do.** The memory-qa facts lane runs gbrain's production extractor and
lets the reader answer from saved facts (`"facts": "conversation"`, `qa.context: "facts"`). But it runs only with
`--system gbrain`, the legacy adapter (`eval/runner/memory-qa/run.ts:397-405`); it takes all saved facts from the top
retrieved sessions, not query-ranked facts; and its prompt bypasses the session budget packer and records no facts
token count (`run.ts:756-774`; `qa.ts:74-77`). So it cannot run v1's "facts-only at 2,000 tokens" against C2 as
written. C4 has three steps:

1. **Saved-facts probe, now, inside E1.** The existing lane as it is, on LoCoMo dev only, with one harness change:
   record the facts context's token count per row. About $1.80 extraction and $1 QA. It runs on a different runner,
   prompt and ingest and is unbounded, which the readings disclose. It answers one question: is there headroom above
   the best E1 arm worth paying for? The extraction is saved as a frozen artifact for reuse.
2. **Stage 1, budgeting the existing facts lane.** Add a budget to the lane: facts ordered by their session's rank and
   then by date, packed by the harness count to 2,000 tokens (facts only) or packed first into 8,000 tokens with the
   remainder filled by the same session packer (facts then sessions), with exact token accounting, stable fact ids
   and packed fact ids. This is harness work, no gbrain code, and reuses the frozen extraction. Run on LoCoMo dev and
   BEAM dev against the best E1 arm, or the leading E2 variant once E2 has run.
3. **Production candidate.** Query-ranked fact search in gbrain with a bounded native-item adapter. It carries over
   `recall`'s source, visibility and expiry rules (`src/core/ops/facts.ts:232-244`) rather than treating stored
   embeddings as a ready public search API, keeps a minimum transcript allocation for questions about what the
   assistant said, and adds cross-source, private and deleted-fact tests. This is a larger product change with its own
   approval.

**Test.** Stage 1 readings are exploratory triage with intervals: facts-then-sessions against the baseline at 8,000,
and facts-only at 2,000 under a preregistered cost rule (non-inferior within 2 points at a quarter of the tokens),
kept separate from the quality rule. LoCoMo has three clusters, so neither reading establishes a mechanism; each can
only earn the next step.

**Lifecycle cost test.** Preregistered beside stage 1: break-even query count = extra ingest cost per haystack /
reader cost saved per query. For example, $1 of extraction against $0.015 saved per query breaks even after about 67
queries. That is arithmetic for the decision, not a measured product claim.

**Cost.** Probe $3 (in E1). Stage 1 about $27 (BEAM dev extraction $15 to $25, LoCoMo reused, QA about $4), cap $40.
The slice stage (about $1 extraction per question, $100 per pass) and the production candidate are separate approvals.

**Risk.** Facts drop what they were not asked to keep. Before attribution, saved facts trailed pages by 73 points on
questions about what the assistant said (P2). The mixed unit keeps sessions in the pack for that reason.

### C5. Ordering of the delivered blocks

**Mechanism.** Present the selected blocks in event-time order with dates, as the rehydrated arm does, instead of
rank order; or keep rank order and put the best block last. The harness supports a system that declares
`presentation: event-time` (`render.ts:110-117`). E1 and E2 render pseudo-sessions in date order, matching the
rehydrated reference, so C5 is the rank-order alternative to that.

**Test.** Reader-only arms on identical selections. The likely effect is a few points, below what 100 questions can
detect (about 12 to 18 points at 80% power), so on the slice this is exploratory only. A decisive run needs the full
LongMemEval-S 500, which E2 already ingests: one extra Sonnet arm there costs about $9.25.

**Cost.** About $2 exploratory on the slice inside E2; $9.25 on the 500 as a separate approval.

## Recommended first experiment: E1, measure the agent's read path (no gbrain code)

E1 answers the adapter-or-product question before anyone builds C2, and it separates four levers: dates, rendering,
hit count and depth. It needs only the C0 harness work in gbrain-evals, branched from PR #89's head, at the frozen
gbrain `c5fb0201`, so the paired comparison with the shootout rows is clean. Sets: the LongMemEval-S slice
(inferential, question-clustered), LoCoMo dev and BEAM-100K dev (descriptive).

| Arm | Cell | Rendering | Reader | Sets | What the reader gets | Question it answers |
|---|---|---|---|---|---|---|
| `shootout-chunk` | A | native | main | all three | today's adapter, limit 40 | reproduces 59.0% / 64.9% / 60.5%; link to the frozen rows |
| `chunk-dated` | A | native, dated | main | all three | the same chunks, each starting with the C1 date header | date effect; C1's dev test; reading 2's reference |
| `chunk-undated-twin` | A | native | main | all three | `chunk-dated`'s exact selected ids, no header | the undated half of the date-only pair |
| `query-auto` | B | native, dated | main | all three | `auto` on the frozen 25-hit list at `B_native`, harness pack at 8,000 with cuts counted | what today's product delivers at 8,000 harness tokens |
| `query-auto-default` | B | native, dated | main | slice, LoCoMo | `auto` on the frozen list, no budget (24,000) | gbrain as shipped; labeled as a different budget |
| `query-auto-pseudo` | B | pseudo-session | Sonnet on slice, main on LoCoMo | slice, LoCoMo | `auto` on the frozen list at `B_pseudo` | the H1 shape |
| `query-auto-pseudo-as-native` | B | native, dated | Sonnet | slice | `query-auto-pseudo`'s exact blocks, rendered native | rendering effect at a fixed selection and reader |
| `query-auto-l5-pseudo` | B | pseudo-session | Sonnet on slice, main on LoCoMo | slice, LoCoMo | `auto` on the frozen list's first five hits at `B_pseudo` | does hit count alone close the gap (an existing-knob reference) |
| `query-rehydrated` | B | rehydrated template | Sonnet | slice | whole sessions behind the frozen 25-hit list | depth reference on the same hits as the query arms |
| `chunk-dated-pseudo` | A | pseudo-session | Sonnet on slice, main on LoCoMo | slice, LoCoMo | the dated chunks, each as a pseudo-session | dated breadth at matched rendering |
| `rehydrated` | A | rehydrated template | main on all three; Sonnet too on slice | all three | the harness's whole sessions from the `shootout-chunk` hits | depth reference on the shootout hits; reproduces 78.0% / 72.7% / 59.4% |
| saved-facts probe | own lane | facts lane | main | LoCoMo | all saved facts from the top sessions, token count recorded | headroom above the best E1 arm |

Notes on the arms:

- **The date-only pair.** Header text changes which items fit, so `chunk-dated` alone is not a date-only comparison.
  The twin renders `chunk-dated`'s selected ids without headers. Because the packer takes a rank-order prefix, the
  twin's prompt is byte-identical to `shootout-chunk`'s on every question where the two selections match; those rows
  are reused by prompt hash, and only the differing questions need a reader call.
- **Pseudo-session rendering** is pinned in C0: memory-qa's `READER_TEMPLATE` and `renderHistory` over sessions
  rebuilt from delivered blocks by the specified parser, in date order, packed by the harness count of its own
  serialization at 8,000 tokens. Any selection difference from the native arm is counted.
- **Matched controls.** `query-auto-pseudo-as-native` holds blocks and reader fixed so reading 4 isolates rendering;
  `query-rehydrated` holds the hit list fixed so reading 3 isolates depth. The original `rehydrated` arm stays as the
  historical reproduction link and as the depth reference for the shootout hits.
- **Readers.** The main readers keep the link to the shootout. Readings that steer what gets built are read on the
  slice with `claude-sonnet-5-5`, the held-out reader, and `rehydrated` is read with both. The full four-reader check
  comes at E2, before anything reaches held-out; whether E1 should run it too is
  [decision G8](#decisions-for-garry).

Embeddings are paid once per benchmark; each cell imports into its own PGLite brain. Retrievals: the `hybridSearch`
call at limit 40, one chunk-unit `query` call at 25 hits, and one live `query` call at `B_native`, with the reranker
on and the cache pinned off. The five-hit arm derives from the frozen list unless its prefix check fails.

### Before E1 spends anything

1. **Branch from PR #89's head.** E1's code branches from `9c07b7e2` (or lands after PR #89 merges). Receipts record
   the declared pin `a865f8f8` and the loaded `c5fb0201`.
2. **Commit the harness with keyless tests.** `shootout-chunk` prompts byte-identical to the golden with the `dated`
   option off; `event_date` from the session table (null date gives no header; empty chunk text); header bytes equal
   to the preregistered format; twin ids equal to `chunk-dated`'s and twin reuse by prompt hash; the pseudo-session
   parser cases; the chunk-unit call's plan asserted null with no budget sent; the resolved-call receipt, refusing a
   cell whose unit, limit, budget or settings differ from the preregistered object; every pinned key present in
   `KNOWN_CONFIG_KEYS` and applied; live parity on a fixture brain; the limit-5 prefix; the bare-budget call's output
   recorded for G7; recipe-identity mutation tests; a missing rerank retried and counted; fake-meter tests for ledger
   reservation exhaustion, retries, the drop order and resume.
3. **Accounting gate, not a cap gate.** Run the committed adapters keyless through memory-qa (`--embed hash`,
   `run.ts:478`, reranker pinned off) on all three benchmarks, BEAM included. Every `query-auto` row must carry a
   complete accounting record whose values match the operation response. The gate passes when every record is
   complete and every cut is counted. It does not require `query-auto` to stay under budget, because today's `auto`
   does not by design; truncating inside the adapter would silently change what the arm measures. The
   never-over-budget assertion belongs to the C2 variants.
4. **Vendor date-fairness check.** A one-line audit of the two vendor shims that leave `valid_from` unset: does their
   product return a date the shim drops? The result is disclosed in the preregistration. If a shim drops a returned
   field, that is a harness bug, fixed for every system alike and rerun in a separately approved, dated run, not vendor
   tuning and not inside E1's budget.
5. **Commit the preregistration** with this table, the call objects, the settings pins, the recipe ids, the date
   channel, the renderer and parser, the sizing rule (values pending), the reproduction band, the readings below and
   the drop order.
6. **Freeze retrieval.** The label-free retrieval freeze (`hybridSearch` at 40 and the chunk-unit `query` at 25) is
   the first paid step, about $3 of E1's cap including the ingest embeddings.
7. **Freeze `B`.** Run the sizing script on the real frozen lists for each (benchmark, rendering) pair at $0 and
   commit the values and ratio distributions as a preregistration amendment. Only then run the live parity calls and
   any reader call.

### Reproduction band and stop rule

Two gbrain versions with the same adapter already differ by 3 to 5 points on slice arms (0.60.46 against 0.60.95 at
`9c07b7e2`), and identical requests flip about 5% of answers at provider-default temperature (auto v2 study). So
`shootout-chunk` and `rehydrated` must reproduce their frozen scores within 4 points on the slice, 3 on LoCoMo dev and
5 on BEAM-100K dev, with at least 85% per-question agreement on the slice. The reproduction arm keeps the shootout's
rerank timeout, and its count of unreranked rows is reported beside the band. A miss on any of them stops E1 for a
determinism check before any reading is made.

### Preregistered readings (exploratory triage, written before the run)

Every reading reports the paired difference with its cluster-bootstrap interval beside the point estimate. On 100
questions most intervals will span zero, so each reading names an uncertain outcome, and none of them sets a default.

1. **Date effect.** The paired difference `chunk-dated` minus `chunk-undated-twin`, on LoCoMo temporal and on the
   slice. The historical temporal gap is 49 points (25 to 74 of 100). If the paired difference recovers at least half
   of it, 24.5 points or more on LoCoMo temporal, the LoCoMo shortfall is mainly an adapter finding and the comparison
   page says so. Below that, the gap stays described as a presentation bundle. Both arms' absolute scores and the
   interval are reported; recovery relative to the historical 25 is reported separately and is not called a date-only
   effect.
2. **Product path at 8,000.** `query-auto` minus `chunk-dated`, native, main reader, on the slice (LoCoMo and BEAM
   descriptive). Both arms carry dates through the same channel, so the date cancels. On questions where the frozen
   `query` list equals the same-length prefix of the shootout's `hybridSearch` list and the live parity check holds,
   the difference is a delivery effect; elsewhere it is a product-path effect. The replay predicts little (0.6 whole
   sessions per question).
3. **Depth gap at matched rendering, reader and retrieval.** Sonnet on the slice, two matched pairs: (a)
   `query-rehydrated` minus the better of `query-auto-pseudo` and `query-auto-l5-pseudo`, all on the frozen `query`
   list; (b) `rehydrated` minus `chunk-dated-pseudo`, both on the shootout hits.
   - If `chunk-dated-pseudo` is within 3 points of `rehydrated`, dates and layout were the lever: C1 leads, and C2's
     depth variant moves down.
   - If `query-auto-l5-pseudo` is within 3 points of `query-rehydrated`, hit count is the lever: `breadth_capped`
     leads E2.
   - If both gaps are 5 points or more, E2 runs the full C2 family as planned.
   - Otherwise the outcome is uncertain: E2 still runs `cap_only` and `breadth_capped`, since the cap is a contract
     fix either way, and C4 stage 1 moves ahead of `depth_first`.
4. **Rendering effect.** `query-auto-pseudo` minus `query-auto-pseudo-as-native`: the same blocks and the same
   reader, so the difference is layout and prompt. Reported for the comparison page; it says how much of the shootout
   gap was rendering.
5. **As shipped.** `query-auto-default` is reported with its budget and token count; it informs the comparison page
   and decides nothing.
6. **Facts headroom.** The saved-facts probe against the best LoCoMo arm, disclosed as a different runner and an
   unbounded context. If it lands at or above the best E1 arm, C4 stage 1 earns its harness work now, gated on the
   best E1 arm rather than on C2 existing.

### E1 cost

| Item | Cost |
|---|---:|
| Ingest embeddings once per benchmark, and three retrieval policies with the reranker (`hybridSearch` at 40, chunk-unit `query` at 25, live parity `query` at `B_native`) | $3.60 |
| `shootout-chunk`, `chunk-dated`, `query-auto`, native, main readers, three sets | $11.70 |
| `chunk-undated-twin`, only questions whose prompt differs | up to $1.00 |
| `query-auto-default`, slice and LoCoMo (27,600 and 17,800 harness tokens per question) | $9.30 |
| Three pseudo-session arms, Sonnet on the slice | $5.55 |
| Two matched controls, Sonnet on the slice (`query-auto-pseudo-as-native`, `query-rehydrated`) | $3.70 |
| `rehydrated` on the slice, main reader and Sonnet | $4.05 |
| Four pseudo-session and rehydrated arms on LoCoMo, main reader | $4.40 |
| `rehydrated` on BEAM dev, main reader | $0.60 |
| Saved-facts probe on LoCoMo dev | $3.00 |
| **Total** | **about $47, cap $50** |

The matched controls are priced as full 8,000-token Sonnet arms although their contexts are smaller, and the
pseudo-session arms read at `B_pseudo`, below 8,000 harness tokens on average, so the estimate leans high. No
frontier four-reader replay in E1 (G8). If the ledger nears the cap, arms are dropped in this preregistered order:
the LoCoMo pseudo-session arms, then `query-auto-default` on LoCoMo, then the facts probe. The steering arms and
matched controls are never dropped. Wall time is about three hours on one VM. Keys: `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY` and `VOYAGE_API_KEY` (the reranker). The cap is [decision G2](#decisions-for-garry).

## Order of work after E1

1. **E2, the C2 family (dev verdict).** On a gbrain branch carrying PR 1 and PR 2, measured through `GbrainQuerySystem`.
   Primary: the LongMemEval-S 500 (all development data; it detects roughly 5 to 7 points, paired by question),
   pseudo-session rendering, `claude-sonnet-5-5`, 25 hits. Construction as in E1: one chunk-unit retrieval freeze on
   the 500, `B_pseudo` sized on that frozen list at $0, every variant delivered on the frozen list through
   `assembleEvidenceForHits` with the per-call `auto_packing` override (dates projected by PR 1), and a live `query`
   check per variant on the slice with the config key set and recorded. Arms: today's `auto`, `cap_only`,
   `breadth_capped`, `depth_first`; today's `window` unit as an existing-knob reference on the slice; LoCoMo dev and
   BEAM dev as descriptive tables; the slice in native rendering with the main reader for the baseline and the
   leading variant, as the link to E1 and the shootout. The default-budget guard is the structural keyless property,
   checked on the frozen evidence too, so it costs no reader calls. The four frontier readers replay the baseline and
   the leading variant on the slice questions. A 16,000-token sweep on the slice is exploratory and chooses the
   held-out budget. C5's rank-order arm rides along. Guard 9's latency comes from repeated live handler calls for
   baseline and candidate on the same VM, with the reranker's network time recorded separately, never from replay
   timing. About $110, cap $135 ([decision G4](#decisions-for-garry)). If E1 reading 3 says dates were the lever, E2
   shrinks to `cap_only` alone.
2. **E3, C3 retrieval gate.** About $1.20, run alongside E2. QA only if recall moves.
3. **E4, C4 stage 1**, budgeting the existing facts lane, gated on the E1 facts probe and compared with the best E1
   arm or the leading E2 variant. About $27, cap $40. The slice stage and the production candidate need their own
   approval.
4. **H1, held-out decision** for the one bundle that passes dev (the leading C2 variant with C1), on sealed
   confirmation set v2, through memory-qa's custody path.

## Architecture

```
gbrain-evals (branch from PR #89 head 9c07b7e2)                    gbrain (frozen c5fb0201 for E1; PR branches for E2)
───────────────────────────────────────────────                     ───────────────────────────────────────────────────
eval/runner/memory-qa/run.ts   --system gbrain-query ─┐
  typed accounting, qa_context kept, capture of meta  │
  settings through a.config (the channel it reads)    │
eval/runner/memory-qa/arms.ts                         │
  named recipes, recipe id in run/retrieval/context/  │
  arm hashes, twin reuse by prompt hash               │
                                                      ▼
eval/runner/systems/gbrain.ts                                         src/core/operations.ts   operations[]
  Cell A: GbrainShootoutSystem({dated})                               
    hybridSearch(limit 40) ────────────────────────────────────────▶  src/core/search/hybrid.ts
    items + event_date from the session table (not the gbrain row)    
  Cell B: GbrainQuerySystem (NEW)                                     
    query{return_unit:'chunk', limit 25} ──────────────────────────▶  src/core/ops/search.ts  query handler
      = frozen ranked hit list, memoized per question                   (plan null: evidence stage inert)
      pins: cache off, decide none, crag off, track_retrieval off       (C2 PR 1: final-boundary recount)
    assembleEvidenceForHits(frozen, auto, B_native | B_pseudo | none) ▶ src/core/search/evidence-delivery.ts
    assembleEvidenceForHits(frozen[first 5], auto, B_pseudo)            resolveFrozenHits  (+effective_date, PR 1)
    live check: query{return_unit:'auto', limit 25, B_native} ───────▶  resolveEvidencePlan (+budgetExplicit, packing, PR 1)
      fingerprint and every consumed field equal?  delivery | path      deliverEvidence → allocate(opts)   (PR 1, PR 2)
    accounting: delivery meta, retrieval meta (decide, crag,            capDeliveredSnippets inside the cap (PR 1)
      degraded), cache disabled, rerank presence, hit/session counts    DeliverOptions.dateHeader          (C1 PR)
                                                      │               src/core/config.ts  KNOWN_CONFIG_KEYS
eval/runner/systems/types.ts                          │                 + search.auto_packing (off | cap_only |
  Item.event_date?, RetrieveResult.accounting?        │                   breadth_capped | depth_first)  (PR 1)
eval/runner/systems/render.ts                         ▼               AssembleEvidenceInput.auto_packing (library only)
  native | native-dated | native-dated-twin |                         docs/evidence-delivery.md, CHANGELOG.md
  pseudo-session (READER_TEMPLATE + renderHistory, parser) |          test/evidence-delivery.test.ts (+ explicit twins)
  rehydrated (shootout hits or frozen query hits)                     test/evidence-delivery-golden.test.ts (unchanged)
  packContext → PackedContext{tokens_before, items_cut,               test/e2e/evidence-delivery-parity.test.ts (+dates)
                item_ids, prompt_sha256}                              test/e2e/evidence-delivery-leak.test.ts (+same slug)
docs/plans/.../budget-sizing.ts (NEW, $0 on frozen hits)              test/config-search-registry.test.ts (+auto_packing)
  → B per (benchmark, rendering)                                      unchanged consumers, guarded by tests:
docs/benchmarks/<date>-gbrain-budgeted-delivery-e1-preregistration.md   src/core/think/index.ts, plan-null chunk path
test/eval/gbrain-query-system.test.ts (NEW), memory-qa-arms.test.ts
eval/runner/memory-qa/run.ts --benchmark custody --split sealed  → H1 (same renderer as E2)
```

## Codepath to test

Every test is keyless (hash vectors, reranker off, no provider key) unless marked.

```
CODEPATH                                         TEST                                             CATCHES
───────────────────────────────────────────────  ───────────────────────────────────────────────  ──────────────────────────────
── gbrain-evals, E1 ──
recipe id in run/retrieval/context/arm hashes    change each field: affected artifact invalid;    wrong retrieval or prompt reused
                                                 reader-only addition reuses the prompt
shootout retrieval, dated option off             native prompt bytes == frozen golden             broken link to the shootout
dated option: event_date from session table      null date → no header; empty chunk text          invented or missing dates
header text                                      bytes == preregistered format (C1 PR repeats)    C1 test measuring other bytes
undated twin                                     twin ids == dated ids; no header; reused when    date pair not date-only;
                                                 prompt hash and reader/judge identity match      paying for identical prompts
pseudo-session parser                            speaker turns, omission turn, cut leading        malformed sessions read as data
                                                 fragment, header consumed, missing date
                                                 "unknown", delivered text only, exact count
chunk-unit query = frozen list                   plan null asserted; no budget sent               hidden chunk budget
assemble deliveries                              resolved call == preregistered object, else      wrong unit, limit, budget
                                                 the cell is refused
live parity                                      fingerprint and consumed fields equal on a       product path read as delivery
                                                 dated fixture brain                              
limit-5 prefix                                   live limit 5 ids == first 5 of limit 25          bogus five-hit derivation
settings pins                                    each key in KNOWN_CONFIG_KEYS and applied;       silent no-op pins, S3 pruning,
                                                 cache status disabled; meta recorded             retrieval write-back
bare-budget call (G7 record)                     token_budget without unit → chunk                documents the legacy unit
accounting gate (memory-qa --embed hash)         every row complete, values match response        incomplete or raw-only receipts
rerank missing                                   retried as harness_invalid; still missing is     silent unreranked rows, free
                                                 scored and counted                               exclusions
ledger                                           fake meter: exhaustion, retries, drop order,     overspend, wrong drop order
                                                 resume
B sizing script                                  recomputation reproduces committed values;       guard 4 failures from units
                                                 every candidate context fits 8,000
── gbrain, C2 PR 1 (cap_only) ──
resolveEvidencePlan.budgetExplicit               explicit 24000 vs implied 24000 differ only      cap reaching default callers
                                                 in the flag
no explicit budget, every variant                property: bytes == today's (random corpora,      guard 1 regression
                                                 budgets 40..24000)
cap at final boundary                            property: recount of final fields <= budget,     guard 3 regression
                                                 every variant; snippet_chars via the operation   snippet growth (3 → 18)
rank one protected                               leading chat + over-budget note; rank one a      notes crowd out rank one
                                                 note; rank one longer than budget (cut)          empty evidence
notes only over budget                           prefix kept, first cut, rest in dropped_reasons  unbounded passthrough
spill disabled                                   nothing appended outside the budget              spill outside budget
minimum budget                                   budgets 1..minimum, 0, negative, non-finite      silent contract choice
                                                 per G1 (b)
redaction grows or shrinks                       recount after redaction                          over budget after redaction
assemble carries effective_date                  live == assemble bytes (C1 on) and date fields   finding 1 regression
                                                 (C1 off)
unchanged consumers                              off-path golden unchanged; think bytes equal;    think, recall, search drift
                                                 recall and search without budget identical
security                                         leak suite: two sources same slug, private,      cached or cross-source text
                                                 deleted, protected; local full, remote lean
engines                                          cap, parity and date tests on Postgres           engine divergence
                                                 (needs DATABASE_URL)
── gbrain, PR 2 (variants) and C1 PR ──
breadth_capped k                                 k formula on a fixed fixture; drops as           unpreregistered k
                                                 breadth_cap; oversized first group cut
depth_first order                                whole, else window, else skip; stop rule         wrong allocation
C1 header                                        priced before selection; spans shifted by        broken coordinates; cap
                                                 header length; recount after redaction           broken by headers
── E2 and H1 ──
variant override on frozen lists                 receipt shows the variant per call; live check   wrong variant for a call
                                                 per variant on the slice
handler latency (guard 9)                        repeated live calls, reranker time separate      replay timing read as latency
H1 dry run through custody (keyless)             same renderer bytes as E2 on a fixture           dev read differs from held-out
```

## Implementation tasks

Effort compares a human engineer familiar with both repositories against Claude Code with gstack. It is engineering
time, not provider or VM runtime and not approval latency. Lane A can start once the plan is approved; its paid steps
need G2. Lane B starts once G1 is answered and runs in parallel with E1, because `cap_only` is needed whatever E1
finds. PR 2 waits on E1 reading 3, which may drop or reorder variants, and the C1 PR waits on reading 1.

| Order | Lane | Task, files and source findings | Verification | Human / CC |
|---|---|---|---|---|
| T1 | A | Branch from PR #89's head; receipts record declared pin and loaded commit. Eng Claude 12. | Receipt shows both commits. | 2 h / 10 min |
| T2 | A | Recipe identities and typed receipts in `arms.ts`, `run.ts`, `systems/types.ts`; settings through `a.config`; twin reuse by prompt hash; `qa_context` in published rows. Eng Astra 1, 10; Eng Claude 17, 19. | Parser, hash-mutation, restart, reader-only replay tests. | 8 h / 2 h |
| T3 | A | `GbrainQuerySystem` in `systems/gbrain.ts`: chunk-unit frozen list, assembled deliveries, live parity on all consumed fields, limit-5 prefix check, pins with key-existence check, accounting, rerank handling. Eng Claude 8, 9, 10, 13; Eng Astra 2. | New `test/eval/gbrain-query-system.test.ts`, keyless. | 12 h / 2 h |
| T4 | A | Rendering in `systems/render.ts` and `gbrain.ts`: `dated` option, native-dated, twin, pseudo-session with the parser, rehydration of the frozen query hits, packer-cut fields. Eng Claude 6, 7, 11; Eng Astra 3. | Golden native bytes unchanged; parser, twin and serialization tests. | 8 h / 90 min |
| T5 | A | Keyless accounting gate through memory-qa `--embed hash` on all three benchmarks; fake-meter ledger tests. Eng Claude 18; Eng Astra test plan. | Every row complete, values match. | 4 h / 30 min |
| T6 | A | Preregistration (calls, pins, recipes, date channel, renderer, readings, band, sizing rule, drop order) and the vendor date audit. Eng Claude 6, 7, 9, 10, 13; Eng Astra 3, 4. | Doc review; `bun run validate`. | 4 h / 30 min |
| T7 | A | Retrieval freeze, sizing script per (benchmark, rendering), `B` amendment before any reader call. Eng Claude 5. | Recomputation reproduces the committed values. | 4 h / 20 min, plus run |
| T8 | A | Paid E1 and the readings. | Band and stop rule applied before any reading. | 3 h / 30 min, plus about 3 h VM |
| T9 | B | `EvidencePlan.budgetExplicit` and packing in `resolveEvidencePlan`; `effective_date` in `resolveFrozenHits`; full-field parity test. Eng Claude 1, 2; Eng Astra 2, 7. | Plan and assemble tests. | 2 h / 15 min |
| T10 | B | `cap_only`: spill off when explicit, rank one protected, note prefix, drops listed, final-boundary recount in `ops/search.ts`, minimum-budget validation per G1 (b). Eng Claude 3; Eng Astra 5, 8. | Cap properties and fixed cases; existing tests unchanged. | 12 h / 3 h |
| T11 | B | Register `search.auto_packing` and the library override; doc paragraph, CHANGELOG and explicit-budget twins naming the four operations. Eng Claude 2, 16. | `bun test`; config rejects unknown values. | 5 h / 25 min |
| T12 | B | Both engines and security: Postgres arm of cap, parity and date tests; leak suite with same-slug sources; remote lean rows. Plan's both-engines rule; Eng Astra test plan. Opens gbrain PR 1. | e2e with `DATABASE_URL`. | 4 h / 30 min |
| T13 | B | PR 2: `breadth_capped` (preregistered k) and `depth_first` as `allocate` options, inert without an explicit budget. After E1 reading 3. Eng Claude 4, 15; Eng Astra 9. | Guard 1 structural property; k fixture. | 12 h / 2 h |
| T14 | B | C1 PR: `DeliverOptions` date header, priced, spans shifted; off-path and `think` untouched. After E1 reading 1. Eng Claude 14; Eng Astra 6. | Golden unchanged; spans test; `think` bytes equal. | 8 h / 2 h |
| T15 | C | E2 harness: the 500 through the T3 construction with per-call variant overrides; live per-variant check; live-handler latency; H1 custody dry run. Eng Claude 6, 8. | Keyless dry run on the slice. | 8 h / 1 h |
| T16 | C | Paid E2, dev verdict, H1 preregistration and decision records; custody request only after every guard passes. | Complete dev verdict and frozen choice. | 4 h / 1 h, plus runs and custody |

Totals: lane A about 45 human hours or 7.5 CC hours; gbrain PR 1 about 23 human hours or 4 CC hours; PR 2 and C1
about 20 human hours or 4 CC hours; lane C about 12 human hours or 2 CC hours. T2 and T3 share `run.ts` and stay in
one worktree; T4 can run in a second worktree once T2 fixes the interfaces. T10 to T14 share
`evidence-delivery.ts` and stay sequential. E2 waits for both lanes.

## Failure registry

A critical gap is a new path that could fail silently with no rejecting check and no existing test. The engineering
reviews found seven; each has a fix in v3.

| # | Path and silent failure | Fix in v3 | Test |
|---|---|---|---|
| 1 | Frozen-hit delivery drops `effective_date`; C1 headers and dates vanish in E2 and H1 evidence while the fingerprint still matches. | Project the date in `resolveFrozenHits` (PR 1); E1 takes dates from the session table; parity compares every consumed field. | Live against assembled bytes and date fields on a dated real-PGLite fixture. |
| 2 | "Pseudo-session" names two renderers; E2 picks a variant under one and H1 reads it under the other. | Pin memory-qa `READER_TEMPLATE` and `renderHistory`; H1 runs through memory-qa custody. | Keyless custody dry run produces E2's renderer bytes. |
| 3 | The block-to-turns parser turns cut fragments or omission markers into malformed sessions. | Specified parser: speaker turns, omission turn, leading fragment, consumed header, no raw turns. | Parser unit tests for every case. |
| 4 | Reading 2 counts date presence as a product-path effect. | One date channel for every dated gbrain arm; reading 2 compares `query-auto` with `chunk-dated`. | Header-bytes and `valid_from`-unset tests. |
| 5 | With a TypeSafe key present, decide slots turn on and the S3 gate prunes hits. | Pin `decide.provider=none`; record `meta.decide`, `meta.crag`, `meta.degraded`; check every pinned key exists and applies. | Settings-receipt test refusing unknown or unapplied keys. |
| 6 | A new recipe resumes the wrong retrieval or prompt because limit, mapping or renderer is not in the key. | Recipe id in run, retrieval, context and arm hashes; versioned format. | Hash-mutation and stale-manifest refusal tests. |
| 7 | The allocator passes but the snippet cap, header or redaction breaks the cap or the spans afterwards (3 reported, 18 actual). | Final-boundary recount with markers priced inside; header priced before selection; spans shifted. | Operation-level `snippet_chars`, tiny-budget and UTF-16 span tests. |

Other failure paths, each visible or handled:

| Path and failure | Handling |
|---|---|
| Pseudo-session contexts exceed 8,000 harness tokens and the packer cuts them | `B` per rendering on the real frozen lists; guard 4 catches any residue. |
| The cap reaches default callers, or never engages | `budgetExplicit` on the plan; guard 1 structural property. |
| Notes exceed the budget | Note prefix rule and its tests. |
| Rerank timeout leaves the reproduction arm unreranked | Presence recorded per row; count reported beside the band. |
| The cache pin names a nonexistent key | Corrected key, per-call `use_cache: false`, status asserted `disabled`, key-existence test. |
| `last_retrieved_at` writes race the harness's table truncation | `search.track_retrieval=false`. |
| A wrong variant serves an E2 call | Per-call library override recorded in the receipt; live check per variant. |
| A query capture is absent or ambiguous | Not used: the chunk-unit call returns the list synchronously, with the plan asserted null. |
| Diagnostics placed in `raw` disappear | Typed `RetrieveResult.accounting`, asserted by value. |
| Global config changes `think`, `recall` or omitted-budget output | Allocation reads only the plan; unchanged-consumer byte tests. |
| A tiny budget cannot fit title, header and marker | G1 (b) contract and its tests. |
| The local adapter is read as MCP-equivalent | Labeled local; remote lean and leak tests in C2. |
| A held-out candidate exceeds the dev ratio | Guard 4 fails as a terminal outcome; no retuning on sealed text. |
| The ledger refuses mid-cell | Fake-meter tests; denominators and reservations preserved. |
| Replay looks fast while the live handler regresses | Guard 9 from live handler calls only. |

## Cost table

Estimates are cold cache and priced per arm from each arm's own token envelope, with reader output, judges, retries
and a margin. Caps are proposals for approval; the budget ledger's reservations enforce them, and a spreadsheet
estimate is not a spending limit.

| Step | What it buys | v2 expected / cap | v3 expected / cap | Approved cap (2026-10-08) | Cap (2026-10-09) | Approval |
|---|---|---:|---:|---:|---:|---|
| E1 | adapter-or-product split; dates, rendering, hit count, depth, each on a matched pair; facts probe | $44 / $50 | $47 / $50 | $100 | $100 (done, $66.42) | G2 |
| E2 | dev verdict on the C2 family on the LongMemEval-S 500, frontier check, sweep, C5 | $110 / $160 | $110 / $135 | $270 | $600 | G4 |
| E3 | C3 retrieval gate | $1.20 / $5 | $1.20 / $5 | $10 | $25 | with E2 |
| E4 | C4 stage 1, budgeted facts lane on LoCoMo and BEAM dev | $27 / $40 | $27 / $40 | $80 | $80 | G6 |
| H1 | held-out decision on sealed v2, one opening | $85 / $120 | $85 / $120 | $240 | $240 | after dev, with custody |
| **Program total** | | **about $267 / $375** | **about $270 / $350** | **$700** | **$1,500** | G4 |
| Separate approvals | C4 slice stage (about $110); C4 production candidate; C5 on the 500 ($9.25) | | | | | each its own |

Caps raised by Garry 2026-10-09 so evals don't stop on a cap; expected costs unchanged. Leases are sized at about three
times their estimates, every call is still metered, a cell or arm past twice its estimate keeps going and is reported
with its cause, and the cap is only a runaway guard.

What moved and why. E1 adds two matched Sonnet controls (+$3.70) and replaces two `query` retrievals with one frozen
list and one live parity call (−$0.60). E2's cap drops by the $25 v2 reserved for reader calls on the default-budget
guard: with every variant inert without an explicit budget, that guard is exact by construction and costs nothing.
Budget sizing on the real frozen lists costs $0 after the retrieval freeze. H1 is unchanged; its default-budget pair
was already free when exact, and it now is exact by construction.

## Decision rule for turning a change on by default

This follows [docs/decisions.md](../../decisions.md): dev verdicts guide the work and never set a default; only a
held-out win turns a feature on, and the held-out set is opened once by the custodian after the comparison is
preregistered. It borrows the bars the held-out program used for P6 and the sealed v2 decision 1. "On by default"
here means the default value of `search.auto_packing` (and C1's key). Because every variant is inert without an
explicit budget, a default change reaches only callers that pass `token_budget`.

### Guards, the same on dev and held-out

Guards are numbered 1 to 9; they are not the G decisions. Each is defined once and applied to both stages, read on
that stage's primary set.

- **Guard 1, C2 compatibility (exact, structural).** Without an explicit budget, every C2 variant's delivered bytes
  equal today's. Checked by the keyless property test over random corpora and budgets, on the slice, LoCoMo dev and
  BEAM dev, and on the frozen held-out evidence before any label is read.
- **Guard 2, C1 change (exact where it can hold).** On a fixed selection (an allocation with header space reserved,
  or one that is not saturated), C1 on differs from C1 off only by one date header line per dated block and
  correspondingly shifted spans. At a saturated explicit budget the header is priced inside the allocation, so the
  selection can change; that change is measured on matched on/off twins with the same reserved envelope, not
  asserted equal. Without an explicit budget, a bundle (C1 with a C2 variant) equals C1 alone, byte for byte.
- **Guard 3, product-token cap (exact, candidates only).** The recount of the final evidence fields never exceeds an
  explicit `token_budget`, every question. Today's `auto` is not held to this; its overrun is recorded.
- **Guard 4, reader-context cap (exact, candidates only).** The serialized reader context fits 8,000 harness tokens
  with zero packer cuts, every question, for the rendering being read. The baseline goes through the same packer at
  the same budget, and its cuts are counted. An empirical ratio is not a universal bound: a held-out candidate that
  exceeds it fails this guard as a terminal outcome.
- **Guard 5, retrieval invariance (exact for delivery-only changes).** Frozen ranked hit ids identical between
  candidate and baseline. Delivered-source coverage (gold sessions among delivered blocks) and packed-source coverage
  are reported as their own metrics, with the preregistered expectation for each variant; they are not guards,
  because a correct cap can deliver fewer sessions. For C3, upstream recall_all@5 non-inferior within 1 point.
- **Guard 6, non-inferiority at the default budget.** Exact by guard 1, so no reader calls; 3 points if guard 1 ever
  fails to hold.
- **Guard 7, question kinds.** No question kind down by more than one question or 2% of that kind, whichever is larger;
  multi-session is also held to the preregistered expectation above.
- **Guard 8, abstention.** Not worse.
- **Guard 9, latency.** p95 of the `query` handler alone (excluding reader and judge) within +20%, from repeated live
  handler calls on the same VM, with the reranker's network time recorded separately.

### Dev gate

Per candidate, `decision.json` committed before any paid cell, verdict type `quality`, or `cost` for C4's facts-only
arm under its own rule.

- **Primary, superiority.** On the LongMemEval-S 500 at 8,000 harness tokens (`B_pseudo`), pseudo-session rendering,
  QA service quality with `claude-sonnet-5-5`, candidate against today's `auto` at the same gbrain base commit and the
  same frozen hit list. Rows paired by question after the cross-arm exclusion join, question clusters, cluster
  bootstrap with 10,000 draws, two-sided sign-flip p. Raw paired intervals are reported for every variant; no
  multiplicity correction in dev, because dev sets nothing. The candidate family (`cap_only`, `breadth_capped`,
  `depth_first`) and the breadth formula are fixed in the preregistration; any narrowing after E1 is recorded there.
- **Which variant goes to held-out.** The variant with the highest primary point estimate among those whose interval
  is above zero and that pass every guard and the reader check. If none qualifies, the dev verdict is `inconclusive`
  and no held-out opening is requested.
- **Descriptive.** LoCoMo dev and BEAM-100K dev category tables, and the slice in native rendering with the main
  reader. A loss of more than 3 points on LoCoMo or BEAM stops the candidate for review before any held-out request.
- **Reader check.** The four frontier readers replay the baseline and the leading variant on the slice questions. A
  candidate whose gain changes sign under two or more of the four does not go to held-out.
- **Model list.** Fixed in the preregistration; changing it after any cell runs requires a recorded reason, as
  CLAUDE.md requires.

### Held-out decision (H1)

- **Material.** [Sealed confirmation set v2](../../benchmarks/2026-10-01-sealed-confirmation-v2-protocol.md), 200
  questions over 40 invented personas with about 3,100-token chats, two of three openings left. It was built for
  delivery questions, and at 8,000 tokens it rewards breadth, which is why guard 7's multi-session expectation gates
  entry. Not eligible: LoCoMo sealed (7 conversations, below the 10-cluster minimum, "never a primary confirmation" in
  its split file, already used by P6, P2 E2, P3 E1 and the shootout's Phase 7) and BEAM-100K sealed (used by the P4
  core gate and Phase 7). LongMemEval-S has no sealed split.
- **Exposure, disclosed.** On 2026-10-04 and 2026-10-05 the set's session text (not its questions or `labels.json`)
  from 34 of 40 histories was imported into throwaway brains and sent to model providers for gbrain P8 quote grounding
  (protocol, "Exposure (added 2026-10-05)"). No label or ledger was read. This does not bias a delivery decision:
  nothing in delivery or in this plan was tuned on that text, and no label was seen. The preregistration names the
  exposure, as the protocol requires, and records the access log's state, verified at preregistration time (three
  lines after decision 1, per the protocol).
- **Path and rendering.** H1 runs through memory-qa's custody path (`--benchmark custody --split sealed`,
  `eval/runner/memory-qa/run.ts:5-7`), with the same pseudo-session renderer and parser as E2. That differs from
  decision 1, which used gbrain's renderer and reader text; the preregistration discloses it.
- **Arms, pinned.** Candidate bundle and today's default, both built as in E2: the chunk-unit retrieval freeze with
  `limit: 25`, then `assembleEvidenceForHits` with `return_unit: 'auto'` and the budget dev chose (8,000 harness
  tokens, `B_pseudo` from the most conservative dev ratio for that rendering, since the sealed text cannot be replayed
  for sizing, unless the sweep says otherwise). Both pass through the same harness packer at the same harness-token
  budget, with the baseline's overruns cut in rank order and counted. The same pair at 5 hits is reported as a
  reference (decision 1's hit count). The default-budget pair is exact by guard 1; its byte identity is confirmed on
  the frozen evidence before any label is read and reported at no reader cost.
- **Sample size, justified from dev.** The expected effect and discordance come from E2's paired results on the
  LongMemEval-S kinds sealed v2 is built from (multi-session, knowledge-update, temporal), and the detectable effect
  on 200 paired questions is computed from them before custody is requested. The old chunk score (66%) is not the
  baseline; today's `auto` is.
- **Pass.** Superiority at the tight budget with a persona-clustered 95% interval above zero and exact McNemar p below
  0.05; guard 6 (exact); guard 7; guard 8. Multiplicity applies only if more than one candidate is opened, which this
  plan does not do.
- **Reader.** `claude-sonnet-5-5` as primary, the other three frontier readers on the same frozen contexts, disclosed.
- **Terminal outcomes.** `pass` turns the bundle on for explicit budgets; callers that pass no budget see no change.
  `fail` or `inconclusive` leaves it opt-in; the set is not reopened for the same candidate, and no budget is tuned on
  it.
- **Records.** The frozen build SHA, `decision.json`, the dev and held-out verdicts committed under
  `docs/eval/decisions/<decision-id>/` in the gbrain pull request, as decisions.md describes.
- **Cost.** About $85: retrieval freeze $3.70 as measured in decision 1, Sonnet tight and 5-hit pairs about $16,
  judges about $3, frontier replay of the tight pair about $60; the default-budget pair costs nothing. Cap $120.

One opening tests one bundle. It carries this plan's candidate alone against the `auto` control: the 10x plan's
evidence brief (GBRA-60) did not qualify to join it (gbrain-evals#111: −3.0 points on its 400-question confirm split,
failing non-inferiority), so there is no joint opening. The last opening stays in reserve for C4 or a later default-budget change. Changing the
default budget itself (24,000), or what a call without a budget receives, is a separate decision and is not part of
this plan.

## Decisions for Garry

Each needs Garry's call because it changes a product contract, the direction of the plan or its budget. The
recommended default is what the plan does if he accepts it.

**Approved 2026-10-08.** Garry accepted all eight recommended defaults as written in the table below, G1 to G8, and
doubled every cap. The table keeps the v3 wording; where it names a cap, the doubled value applies:

| Step | Expected (unchanged) | Cap in v3 | Approved cap |
|---|---:|---:|---:|
| E1 | $47 | $50 | $100 |
| E2 | $110 | $135 | $270 |
| E3 | $1.20 | $5 | $10 |
| E4 | $27 | $40 | $80 |
| H1 | $85 | $120 | $240 |
| **Program** | **about $270** | **$350** | **$700** |

The extra is headroom against cost overruns, not new scope: no arm, reader or benchmark is added because of it, and
E1's preregistered drop order now applies near $100. G8's default stands, so E1's frontier reader is
`claude-sonnet-5-5` alone, with the frozen shootout readers kept as the reproduction link; `claude-fable-5-1` may run
smoke checks only and is never a counted reader in E1 (Garry's 2026-10-07 rule).

| # | Decision | Recommended default | Why | Blocks |
|---|---|---|---|---|
| G1 | (a) Make an explicit `token_budget` a hard cap under `auto` for `query`, `search`, `recall`'s results arm and `assemble_evidence`, reversing gbrain's documented contract that `auto` never returns less than `chunk` would (`docs/evidence-delivery.md:118-123`) for explicit budgets. (b) What an explicit budget below a documented minimum returns, since the cap, a counted cut marker and non-empty evidence cannot all hold for a budget smaller than one title plus a marker. (CEO Claude 2; Eng Claude 2, 4; Eng Astra 7, 8) | **(a) Yes, explicit budgets only, across the four operations. (b) A clear validation error naming the minimum.** A new `budgetExplicit` flag carries the distinction; every C2 variant and the cap are inert without it, which a structural keyless property test proves (guard 1). So an H1 pass changes nothing for callers that don't pass a budget, including the agent's default `query` call. Existing spill tests stay; explicit-budget twins, the doc paragraph and CHANGELOG ship in gbrain PR 1. | An explicit budget is the caller's cost promise; at 8,000 tokens today it is exceeded on every question. One meaning across the four operations that share the plan resolution is clearer than four. An error is clearer than silently empty evidence or a broken marker promise; the alternatives are empty evidence with a reason, or relaxing the marker. | gbrain PR 1 (lane B); E2 |
| G2 | Raise the E1 cap from v1's $30 to $50. (CEO Claude D19) | **Approve $50.** Expected about $47, up from $44 for two matched Sonnet controls the engineering reviews required, with a preregistered drop order if the ledger nears the cap. | The added arms (5 hits, the 24,000 default, pseudo-session rendering, the date-only twin, Sonnet on the steering arms, the matched controls) and the facts probe are what let E1 choose what to build, each on a comparison that changes one lever. | E1 paid steps |
| G3 | Whether depth-first packing stays the preferred direction now that the causal split is unproven. (CEO Astra D3, User Challenge, finding 3) | **Treat the three C2 variants as equals** and let the preregistered dev rule pick one; keep the name C2 and the depth variant in the family. | Sealed v2 at 8,000 tokens rewards breadth, the 5-hit replay already stays in budget, and the cap alone may be most of the value. `breadth_capped` now has a precise preregistered k; the 5-hit arm is an existing-knob reference, not a preview of it. | gbrain PR 2; E2 design |
| G4 | Raise E2 from v1's $58 expected, $90 cap to about $110, cap $135 (v2 asked $160), and the program total to about $270, cap $350 (v2 asked $375). | **Approve when E1's readings call for E2.** | The 500 detects 5 to 7 points where the slice detects only 12 to 18, so an `inconclusive` after $58 is the likely v1 outcome; Sonnet matches the held-out reader. The cap fell by the $25 default-budget guard reserve, now unnecessary. | E2 |
| G5 | Let C1 (date headers) ship inside the H1 bundle although H1's pseudo-session rendering takes each session's date from the harness session table, so the header can change only which blocks fit at the tight budget, and H1 can show C1 does no harm but not that it helps. | **Yes, ship in the bundle, disclosed**, with its benefit evidence from E1's paired date effect. Alternative: a native-rendered secondary pair in H1 (about $8, with Holm across the two). | C1 helps exactly the consumers that render text only, which H1's shape cannot represent. | H1 preregistration; C1 PR |
| G6 | Fund C4 stage 1 (budgeting the existing facts lane, about $27, cap $40) if the E1 facts probe shows headroom. | **Yes, gated on the probe**, compared with the best E1 arm, not on C2 existing. | The facts path is the only one aimed above the raw-session ceiling and the only one that could cut tokens several times over. | E4 |
| G7 | Whether a bare `token_budget` (no `return_unit`) should keep selecting legacy chunk budgeting. | **No change in this plan.** E1 records what that call returns, keylessly; C2 leaves the bare-budget path byte-identical; revisit after H1. | Changing the implied unit is a second contract change, and this plan should not stack two in one PR. | nothing in this plan |
| G8 | Run the four frontier readers on E1's steering arms too (CEO Astra finding 10), instead of Sonnet alone. | **Sonnet alone in E1**, four readers at E2 before any held-out request. Four readers on two E1 steering arms add about $36, for an expected $83 and a cap of about $90. | E1 chooses what to build next, which is cheap to reverse; no default rests on E1. Astra's CEO review asks for the full set; this is a budget and model-policy call, not an exemption the plan can grant itself. | E1 scope |

## Risks and limits

- **LongMemEval-S is development data.** gbrain's release configuration was chosen on it, so even the 500 guides
  work; only H1 sets a default.
- **E1 is small.** 100 slice questions detect only large effects, so E1's readings are triage with uncertain outcomes,
  sized for the 19-point rehydration gap, not for C5-sized effects. E2 moves to the 500 for that reason.
- **The win reaches explicit budgets only.** An H1 pass changes what callers that pass `token_budget` receive. The
  agent's default `query` call, which passes none, keeps today's 24,000-token `auto`; changing that is a separate
  decision.
- **Token units differ.** gbrain budgets in `cl100k`, the harness in characters divided by four, and the readers in
  their own tokenizers. The budget is sized per benchmark and rendering from the maximum per-question ratio on real
  hits, and overruns are counted, never silently cut.
- **E1 depends on an unmerged branch.** The harness E1 extends lives on draft PR #89. If that branch changes before
  E1's code lands, E1 rebases on it; the frozen shootout rows stay pinned to `9c07b7e2`.
- **Long sessions.** When a single session exceeds the budget, C2 delivers a window. BEAM-1M (gbrain strict recall
  18.2%) is the stress case and is out of scope here.
- **Fairness.** Re-running gbrain through a better adapter after seeing the comparison is tuning. Any comparison page
  shows the frozen row and the new row side by side, labeled, and vendor rows are not re-run with tuned settings. A
  shim that dropped a returned date is a harness bug fixed for every system alike.
- **Local measurement.** The adapter calls `query` as a trusted local caller; remote behavior is covered by C2's
  tests, not by E1's numbers.
- **Held-out openings are scarce.** Spending one cannot be undone, so the candidate family, guards and size are fixed
  before custody is requested, and `inconclusive` is a terminal result.
- **Fact extraction cost and coverage.** C4 adds about $1 per LongMemEval-S haystack at ingest and can drop
  assistant-side detail; it stays opt-in until its own held-out pass, and its economics are judged by the break-even
  test.

## Receipts for the diagnosis

- `receipts/gbrain-rows-profile.py` and its output `gbrain-rows-profile.txt`: the gbrain row profile (items, tokens
  per item, estimated 8,000-token pack, native against rehydrated flips by category), from the committed rows at
  `9c07b7e2`.
- `receipts/keyless-delivery-replay.ts`, `keyless-delivery-summary.py`, the per-question outputs
  `keyless-replay-lme-s-100.json.gz` and `keyless-replay-locomo-dev.json.gz`, and `keyless-delivery-summary.txt`:
  the $0 replay of `hybridSearch` plus the `query` evidence stage, run at gbrain master `7aa2caa` (its search and
  delivery files match `c5fb0201`; some keyword and vector-scan files changed, which do not affect delivery). Hash
  vectors, reranker off, no provider key present.
- `receipts/token-ratio-distribution.py` and its output `token-ratio-distribution.txt`: the per-question ratio of
  harness tokens to gbrain tokens for each replay configuration, on raw delivered text, and the provisional native
  budgets. Run from the `receipts/` directory. The Astra engineering review reran this script and the row profile and
  got byte-identical outputs.
- System scores per kind are each arm receipt's `qa_service_score` under
  [`docs/benchmarks/2026-10-06-oss-memory-shootout/results/`](https://github.com/garrytan/gbrain-evals/tree/9c07b7e2f90715593b43d9bdc2a7652174636691/docs/benchmarks/2026-10-06-oss-memory-shootout/results),
  merged across shards, latest lease per cell.
- Earlier evidence: [evidence delivery](../../benchmarks/2026-09-30-evidence-delivery.md) (page 361 against chunk 253
  of 400; ten chunks no better than five), [auto v2](../../benchmarks/2026-09-30-evidence-auto-v2.md) (auto 445
  against chunk 312 of 500 on development data; 24,000-token budget; about 5% of identical requests flip),
  [sealed v2 decision 1](../../benchmarks/2026-10-02-sealed-v2-decision-1.md) (auto 192 against chunk 132 of 200,
  held out, five hits, 24,000 tokens).
- The four reviews: [`reviews/ceo-claude.md`](reviews/ceo-claude.md), [`reviews/ceo-astra.md`](reviews/ceo-astra.md),
  [`reviews/eng-claude.md`](reviews/eng-claude.md) and [`reviews/eng-astra.md`](reviews/eng-astra.md). The engineering
  reviews' keyless probes (the JSON serialization overhead on LoCoMo dev, the frozen-hit date loss with an equal
  fingerprint, the snippet cap's 3 to 18 tokens, the arm parser rejecting the new recipes, and 51 passing gbrain
  delivery tests on PGLite) are described in those files.

## Review record

Every finding from the four reviews, and the change it produced. Classes are the reviewers' own: Mechanical changes
were applied, Taste changes were accepted under the decision log below, and owner calls and User Challenges went to
[Decisions for Garry](#decisions-for-garry).

### CEO phase (v1 to v2)

"Claude n" and "Astra n" are the finding numbers in each CEO review. The "Where" column names v2 sections, which v3
keeps; guards are now numbered 1 to 9.

| Reviewer and finding | Severity | Class | Change in v2 | Where |
|---|---|---|---|---|
| Claude 1 | Critical | Mechanical | The pre-spend gate is an accounting gate; the never-over-budget assertion moves to the C2 variants. | E1, "Before E1 spends anything" 3; guards 3, 4 |
| Astra 1 | High | Mechanical | Same as Claude 1; the budget comes from the per-question maximum, not the mean; a BEAM keyless replay is added. | C0 budget sizing; E1 gate |
| Claude 2 | High | Taste, owner call | The spill is named as documented behavior; the hard cap applies to explicit budgets only and waits on G1; doc, test and CHANGELOG move together. | Diagnosis; C2; G1 |
| Claude 3 | High | Taste | E1 adds `query` at 5 hits. | E1 table |
| Claude 4 | High | Taste | E1 adds `query` at the shipped 24,000 default, labeled as a different budget. | E1 table, reading 5 |
| Claude 5 | High | Taste | C2 becomes a family with `breadth_capped` beside `depth_first`; the multi-session expectation is preregistered and gates held-out. | C2; dev gate; guard 7 |
| Claude 6 | High | Taste | E1 adds pseudo-session rendering of `query`'s blocks; it is E2's primary rendering and H1's shape. | E1 table; E2; dev gate |
| Claude 7 | High | Taste | E2's primary is the LongMemEval-S 500; the slice stays as the link. | E2; dev gate; cost table; G4 |
| Claude 8 | Medium | Taste | E2's primary reader is `claude-sonnet-5-5`, matching H1; the frozen readers stay as the shootout link. | Dev gate; E1 readers |
| Claude 9 | Medium | Mechanical | H1 names the sealed v2 exposure and why it does not bias a delivery decision. | H1 "Exposure, disclosed" |
| Astra 8 | High | Mechanical | Same exposure disclosure, plus the verified access-log state; H1's size is justified from E2's dev analogues, not the old 66% chunk score; `inconclusive` is terminal; the candidate family is frozen before custody. | H1 |
| Claude 10 | Medium | Mechanical | `limit` is pinned in every arm (25 agent default, 5 reference); both H1 arms go through the same packer at the same budget, overruns counted. | C0 call; H1 "Arms, pinned" |
| Claude 11 | Medium | Mechanical | Budget sizing rule from the maximum per-question ratio, per benchmark, with a stated margin and the distribution recorded. | C0; `receipts/token-ratio-distribution.txt` |
| Claude 12 | Medium | Mechanical | Reproduction band (4 / 3 / 5 points, 85% agreement on the slice) and a stop rule. | E1 "Reproduction band" |
| Claude 13 | Medium | Taste | A saved-facts probe on LoCoMo dev runs inside E1 for about $3; C4 stage 1 is gated on the best E1 arm. | C4 step 1; E1 reading 6; G6 |
| Claude 14 | Medium | Mechanical | The depth reading compares `rehydrated` with the best dated breadth arm under the same rendering and reader, and reads `chunk-dated` on the slice. | E1 reading 3 |
| Claude 15 | Low | Taste | No Holm in dev; raw paired intervals; multiplicity only where a decision is made. | Dev gate; H1 "Pass" |
| Claude 16 | Low | Mechanical | Cache pinned off; cache status recorded per row. (v3 corrects the key and the reason; see Eng Claude 9.) | C0 call and accounting |
| Claude 17 | Low | Mechanical | Vendor date-fairness check in the E1 preregistration; a dropped field is a harness bug fixed for everyone. | E1 gate 4; risks |
| Claude 18 | Low | Taste | C1 folds into E1: `chunk-dated` uses C1's text header with `valid_from` unset; the separate C1 arms are gone. | C0 `chunk-dated`; C1 |
| Claude 19 | Info | none | Citations verified; no change needed. | Status note |
| Claude, sections 2, 8 and 0I | n/a | Mechanical | Per-row fields (`budget_used`, spill, fallbacks, cache, packer cuts, packed ids); a reranker failure fails the arm (v3 refines this; see Eng Claude 13); rank one is cut to fit, never dropped. | C0 accounting; C2 cap rule 1 |
| Astra 2 | High | Mechanical | `return_unit` is passed explicitly, because a bare budget selects legacy chunk budgeting; exact call objects preregistered; pre-delivery hit equivalence checked; delivery-only comparisons use one frozen hit list; the bare-budget call is recorded keylessly. | Diagnosis; C0; E1 gate 2; G7 |
| Astra 3 | High | Mechanical, plus User Challenge | The diagnosis calls the rehydration gain a bundle of six changes until isolated; E1 adds a date-only pair with identical selections; the gap to other systems is no longer called a fact-extraction benefit. The depth-first preference goes to Garry. | In plain words; diagnosis; E1 twin arm; G3 |
| Astra 4 | High | Mechanical | Guards split: C2 compatibility (guard 1), C1's intentional change (guard 2), the bundle; upstream ranking invariance separated from delivered coverage (guard 5); product-token and reader-context caps scoped separately (guards 3, 4). | Guards |
| Astra 5 | High | Mechanical | The cap covers all delivered output, including non-conversation chunks; minimum unit rule; mixed, notes-only, tiny-budget, missing-date, redaction, source-swamp and both-engine tests; the authorized fetch and protected-body projection are preserved. | C2 cap rule, contract tests |
| Astra 6 | Medium | Taste | `cap_only` and an existing-knob `window` reference join the comparison; the 5-hit arm is in E1; C3 to C5 are conditional, not prerequisites. | C2 variants; E2; C3 |
| Astra 7 | High | Mechanical | C4 split into the saved-facts probe, stage 1 that budgets the existing facts lane, and a production candidate with access-rule tests and a minimum transcript allocation. | C4 |
| Astra 9 | Medium | Mechanical | Costs priced per arm from each envelope (the 24,000 arms separately), cold cache stated; caps are proposals enforced by the ledger; a lifecycle break-even test for C4. | Cost table; C4 lifecycle test |
| Astra 10 | High | Mechanical, partly owner call | Decision-steering E1 readings use `claude-sonnet-5-5`; the four-reader check runs at E2 before held-out; running all four in E1 is G8. | E1 readers; G8 |
| Astra 11 | Medium | Taste | E1 and C4 thresholds are exploratory triage with intervals and an uncertain outcome; a separate cost rule for C4; the candidate family and sweep are fixed before results; one frozen decision goes to held-out. | E1 readings; C4 test; dev gate |
| Astra, "five small improvements" | n/a | Mechanical | Packed ids, upstream against delivered coverage, overrun reasons, a printed resolved-call receipt, cold and warm cost. | C0; guards; cost table |

### Engineering phase (v2 to v3)

"Eng Claude n" and "Eng Astra n" are the finding numbers in each engineering review; D numbers are each review's
decision ids.

| Reviewer and finding | Severity | Class | Change in v3 | Where |
|---|---|---|---|---|
| Eng Claude 1 | Critical | Mechanical (D1) | `resolveFrozenHits` projects `effective_date` in gbrain PR 1 with a live-against-assembled test; E1 takes dates from the session table. | C1 "Frozen-hit dates"; C0 Cell A; T9; failure registry 1 |
| Eng Claude 2 | High | Mechanical (D2) | `budgetExplicit` and the packing variant on `EvidencePlan`; all four affected operations named; `planOf` keeps existing tests on today's path. | C2 "When it engages", "The contract change"; G1 |
| Eng Claude 3 | High | Mechanical (D3) | Spill disabled under the cap, rank one reachable and protected, note prefix rule, drops listed; both spill tests named and kept. | C2 cap rules 1 to 3 |
| Eng Claude 4 | High | Taste (D4) | Cap and variants engage only on an explicit budget; guard 1 is a structural keyless property; guard 6 and H1's default-budget pair are exact; the consequence is stated in plain words. | C2; guards 1, 6; H1; G1; In plain words |
| Eng Claude 5 | High | Mechanical (D5) | `B` per (benchmark, rendering), sized on the real frozen hit lists after the retrieval freeze and before any reader call. | C0 budget sizing; E1 steps 6, 7; T7 |
| Eng Claude 6 | High | Mechanical (D6) | Pseudo-session pinned to memory-qa `READER_TEMPLATE` and `renderHistory`; H1 through memory-qa custody; parser specified and unit-tested. | C0 "Pseudo-session rendering"; H1 "Path and rendering"; failure registry 2, 3 |
| Eng Claude 7 | High | Mechanical (D7) | One date channel (header in text, `valid_from` unset, no title prefix); reading 2 compares `query-auto` with `chunk-dated`. | C0 "One date channel"; E1 reading 2; failure registry 4 |
| Eng Claude 8 | High | Taste (D8) | One chunk-unit `query` call per question freezes the hit list; deliveries through `assembleEvidenceForHits`; one live parity call; five-hit prefix proven keylessly with a fallback cell. | C0 "One frozen hit list"; E1; E2; H1 |
| Eng Claude 9 | Medium | Mechanical (D9) | Cache key corrected to `search.cache.enabled`; the diagnosis sentence and decision A10 fixed; per-call `use_cache: false`; status asserted `disabled`. | Adapter section; C0 settings; A10 |
| Eng Claude 10 | Medium | Mechanical (D10) | Pins `decide.provider=none`, `search.crag_escalation=false`, `search.crag_think=false`, `search.track_retrieval=false`; meta recorded; `expand: false` disclosed. | C0 settings and accounting; failure registry 5 |
| Eng Claude 11 | Medium | Taste (D11) | Two cells per benchmark, new context modes, one new system class; embeddings paid once, PGLite import per cell. | C0 "Two cells"; E1 cost |
| Eng Claude 12 | Medium | Mechanical (D12) | E1 code branches from PR #89's head; receipts record declared pin and loaded commit. | Status; E1 step 1; risks; T1 |
| Eng Claude 13 | Medium | Mechanical (D13) | Reproduction arm keeps the shootout's timeout and records rerank presence; new arms retry as `harness_invalid` and count the rest. | C0 "Reranker handling"; reproduction band |
| Eng Claude 14 | Medium | Taste (D14) | C1 through a `DeliverOptions` flag for four operations; plan-null chunk path and `think` untouched; spans shifted; guard 2 reworded. | C1 "Where"; guard 2; T14 |
| Eng Claude 15 | Medium | Mechanical (D15) | Precise `breadth_capped` k, preregistered and property-tested. | C2 variant 2 |
| Eng Claude 16 | Medium | Taste (D16) | `search.auto_packing` registered with unknown values rejected; library-only per-call override for evals. | C2 variants; T11 |
| Eng Claude 17 | Low | Mechanical | `qa_context` kept in published rows; only packer-cut and pre-pack counts added. | Adapter section; C0 accounting; T2 |
| Eng Claude 18 | Low | Mechanical | Accounting gate runs the committed adapters through memory-qa `--embed hash` on all three benchmarks. | E1 step 3; T5 |
| Eng Claude 19 | Low | Mechanical | Twin reuse by prompt hash, marked `reused_from`, tested. | C0 twin; T2 |
| Eng Claude D17 | n/a | Taste | C2 ships as two gbrain PRs, `cap_only` first. | C2 "Ships how"; implementation tasks |
| Eng Claude D18, UC | n/a | none | E1's arm list, G1 to G8 and caps kept by that review; no User Challenge raised. v3 adds arms and rewords decisions only where other findings required. | Decision log A48, A53 |
| Eng Astra 1 | High | Mechanical (D1) | Immutable recipe ids in run, retrieval, context and arm hashes, with mutation tests; versioned format. | C0 "Replay identity keys"; failure registry 6; T2 |
| Eng Astra 2 | High | Mechanical (D1, D2) | Date-preserving frozen seam; parity compares every consumed field, not the fingerprint alone; the capture sink is replaced by the synchronous chunk-unit call. | C0 live parity; C1; failure registry 1 |
| Eng Astra 3 | High | Mechanical (D3) | `query-auto-pseudo-as-native` (same blocks, same reader) for reading 4 and `query-rehydrated` (same hits) for reading 3, within the $50 cap. | E1 table, readings 3, 4; E1 cost |
| Eng Astra 4 | High | Mechanical (D4) | Reading 1's threshold is the paired difference, 24.5 points; absolute recovery reported separately. | E1 reading 1 |
| Eng Astra 5 | High | Mechanical (D5) | The cap holds at the final evidence boundary, including snippets, markers and the recount; "all delivered output" defined as evidence fields; operation-level tests. | C2 cap rule 4; failure registry 7 |
| Eng Astra 6 | High | Mechanical (D5) | Header priced before selection, spans shifted, recount after redaction; guard 2 scoped to fixed selections. | C1; guard 2 |
| Eng Astra 7 | High | Taste (D6) | Provenance on the plan, one resolved policy threaded into allocation, unknown config values rejected, explicit replay policy; `cap_only` first, then the variants as parameters. The cap spans four operations, which G1 now names for Garry's approval. | C2; G1; decision log A29, A51 |
| Eng Astra 8 | High | User Challenge (D7) | Global priority with rank one protected; adversarial cases added; the minimum-budget contract goes to Garry as G1 (b) with the review's recommended default. | C2 cap rule 1, "The minimum budget"; G1 |
| Eng Astra 9 | Medium | Taste (D8) | Breadth uses a priced target window from the existing window machinery, with tie, oversized-first-group and leftover rules; hit and distinct-session counts recorded; the 5-hit arm is an existing-knob reference. | C2 variant 2; C0 five-hit note; E1 table |
| Eng Astra 10 | Medium | Mechanical (D9) | Cache claim replaced by the runtime fact; settings applied through the channel the adapter reads; a test proves they arrive. | Adapter section; C0 settings |
| Eng Astra D10 | n/a | User Challenge | G1 to G8 untouched by that review; v3 rewords G1, G2, G4, G5 and G8 only where engineering findings changed their facts. | Decisions for Garry |
| Eng Astra, test plan and registry | n/a | Mechanical | Typed receipts asserted by value; fake-meter ledger tests; local measurement labeled; live-handler latency for guard 9; held-out ratio overrun terminal; leak suite with same-slug sources. | C0 accounting; C2 tests; guards 4, 9; failure registry |
| Eng Claude, performance review | n/a | Mechanical | Guard 9 measured on the same VM with the reranker's network time recorded separately. | Guard 9; E2 |

## Autonomous decision log

Decisions made in writing v2 and v3 without Garry, with the reason. Each one is reversible by editing this plan
before the E1 preregistration is committed.

| # | Decision | Class | Source | What the plan does | Reason |
|---|---|---|---|---|---|
| A1 | Accounting gate in place of the cap gate | Mechanical | CEO Claude 1, Astra 1 | Applied | The v1 gate could not pass, and truncating in the adapter would change what the arm measures. |
| A2 | Explicit `return_unit` and preregistered call objects | Mechanical | CEO Astra 2 | Applied | Without it a budget silently selects legacy chunk budgeting. |
| A3 | Add `query-auto-l5-pseudo` | Taste | CEO Claude 3, Astra 6 | Accepted | Cheapest test of "hit count, not algorithm"; the replay shows it already stays in budget. |
| A4 | Add `query-auto-default` on the slice and LoCoMo, not BEAM | Taste | CEO Claude 4 | Accepted, narrowed | The as-shipped row matters most for the comparison page; BEAM is descriptive and rehydration does not help there. |
| A5 | Pseudo-session rendering as E2's primary and the steering rendering in E1 | Taste | CEO Claude 6 | Accepted | It is the shape H1 reads, and it matches the rehydrated reference. |
| A6 | Date-only pair through an undated twin with identical ids, reusing byte-identical prompts | Mechanical | CEO Astra 3 | Applied | A header changes which items fit; reusing identical prompts keeps the twin under $1. |
| A7 | Pseudo-session arms on the slice read with Sonnet only; `rehydrated` read with both readers | Taste | CEO Claude 8, Astra 10 | Accepted | Keeps E1 under $50 while matching reader and rendering for the steering comparison. |
| A8 | Budget sizing from the maximum ratio × 1.02 per benchmark | Mechanical | CEO Claude 11, Astra 1 | Applied; refined in A33 | A mean ratio puts about half the slice over the limit. |
| A9 | Reproduction band 4 / 3 / 5 points and 85% agreement | Mechanical | CEO Claude 12 | Applied | Version-to-version drift is 3 to 5 points and identical requests flip about 5%; the band is tighter than drift and looser than noise. |
| A10 | Cache pinned off | Mechanical | CEO Claude 16 | Applied; key and reason corrected in v3 (A37) | v2's reason, near-duplicate LoCoMo questions served from cache, was wrong: the semantic cache is unavailable in every build in scope. The pin stays as a guard for future builds, through the correct key `search.cache.enabled` and per-call `use_cache: false`. |
| A11 | Vendor date-fairness check, fix outside E1's budget | Mechanical | CEO Claude 17 | Applied | Symmetry with the gbrain fix, without spending E1's money on vendor reruns. |
| A12 | Fold C1's test into E1 | Taste | CEO Claude 18 | Accepted | One arm serves both; separate C1 arms are removed. |
| A13 | C2 as a family of `cap_only`, `breadth_capped` and `depth_first`, one allocator | Taste | CEO Claude 5, Astra 6 | Accepted | Separates the cap fix from the allocation hypothesis at the smallest code cost; whether depth-first stays preferred is G3. |
| A14 | E2 primary on the LongMemEval-S 500 with Sonnet | Taste | CEO Claude 7, 8 | Accepted; budget is G4 | The slice cannot detect the likely effect; Sonnet matches H1 and the model rule. |
| A15 | Frozen hit list for E2's delivery variants, with a live check per variant | Mechanical | CEO Astra 2, 4 | Applied; mechanism set in A36 | Guarantees retrieval invariance and saves four retrievals on the 500. |
| A16 | One guard set for dev and held-out; category guard is one question or 2%, whichever is larger | Mechanical | CEO Astra 4, Claude 5 | Applied | v1's one-question rule was set for 200 questions and is noise on 133-question kinds in the 500; on sealed v2 the two rules agree. |
| A17 | Dev non-inferiority margin 3 points, as H1 | Mechanical | CEO Astra 4 | Applied; now a fallback behind guard 1 (A32) | One margin is consistent. |
| A18 | No Holm in dev; raw intervals; variant choice by a preregistered rule | Taste | CEO Claude 15, Astra 11 | Accepted | Dev sets nothing; one frozen decision reaches held-out. |
| A19 | Saved-facts probe inside E1 on LoCoMo dev, with a facts token count | Taste | CEO Claude 13, Astra 7 | Accepted | About $3 tells whether C4 is worth its harness work. |
| A20 | "Budgeting the existing facts lane" as C4 stage 1, harness work only | Mechanical | CEO Astra 7 | Applied | The lane cannot test a budget today; adding one reuses the extractor and frozen extraction. |
| A21 | C4 lifecycle break-even test and separate cost rule | Mechanical | CEO Astra 9, 11 | Applied | Quality and cost are different verdicts. |
| A22 | H1 exposure disclosure, pinned hit count and packer, 5-hit reference pair, sample size from dev | Mechanical | CEO Claude 9, 10, Astra 8 | Applied | Required by the protocol, and needed for a matched accuracy-per-token comparison. |
| A23 | H1 budget from the most conservative dev ratio | Mechanical | CEO Claude 11, Astra 8 | Applied; per rendering in v3 | Sealed text cannot be replayed for sizing without reading the set. |
| A24 | Diagnosis wording softened to a presentation bundle | Mechanical | CEO Astra 3 | Applied | The rows do not isolate dates from the other five changes. |
| A25 | Drop order if E1 nears its cap | Mechanical | CEO Astra 9 | Applied; matched controls protected in v3 | Caps are enforced by the ledger; the order keeps the steering arms. |
| A26 | Add a token-ratio receipt to the plan folder | Mechanical | CEO Claude 11 | Applied | The sizing rule needs committed evidence, computed at $0 from the existing replay outputs. |
| A27 | Project `effective_date` in `resolveFrozenHits`; E1 dates from the session table | Mechanical | Eng Claude 1, Astra 2 | Applied | Frozen-hit delivery is E2's and H1's path, and losing the date there is silent; E1 at `c5fb0201` must not depend on the fix. |
| A28 | Live parity on every consumed field, not the fingerprint alone | Mechanical | Eng Astra 2 | Applied | The fingerprint omits dates and titles; Astra's probe showed equal fingerprints with a lost date. |
| A29 | `budgetExplicit` on the plan; cap across `query`, `search`, `recall` and `assemble_evidence` | Mechanical | Eng Claude 2, Astra 7 | Applied; scope goes to Garry in G1 | Astra asked for a query-only scope unless separately authorized; Claude showed one plan resolution serves all four. One meaning of an explicit budget across them is the better contract, and G1 now names all four, so Garry's answer is the authorization. |
| A30 | Cap rules: spill disabled, rank one protected, note prefix, drops listed | Mechanical | Eng Claude 3, Astra 8 | Applied | The rank-one cut is unreachable under `auto` today, and wholesale note reservation can starve a leading conversation. |
| A31 | Cap enforced at the final evidence boundary | Mechanical | Eng Astra 5 | Applied | The snippet finalizer can grow output after a correct allocation without updating `budget_used`. |
| A32 | Cap and variants engage only on explicit budgets; guard 1 structural | Taste | Eng Claude 4 | Accepted | Removes v2's contradiction about variants at the default budget, makes the default-budget pair exact for free, and keeps every no-budget caller on today's bytes. |
| A33 | `B` per (benchmark, rendering) on the real frozen lists, frozen before readers | Mechanical | Eng Claude 5, Astra test plan | Applied | JSON turns run up to 1.27 times the Markdown text, so one `B` would fail guard 4 on pseudo-sessions; hash-vector maxima do not bound real retrieval. |
| A34 | Pseudo-session pinned to memory-qa; H1 through custody; parser specified | Mechanical | Eng Claude 6 | Applied | E2 and H1 must read the same bytes; memory-qa's template matches `rehydrated`, which reading 3 needs. |
| A35 | One date channel; reading 2 against `chunk-dated` | Mechanical | Eng Claude 7 | Applied | Otherwise reading 2 measures dates plus path, the confound the date pair exists to remove. |
| A36 | Frozen list from one chunk-unit `query` call, deliveries through `assembleEvidenceForHits`, one live parity call | Taste | Eng Claude 8, Astra 2 | Accepted, chosen over the capture sink | The capture sink is fire-and-forget and needs correlation; the chunk-unit call returns the list synchronously with the plan asserted null, and makes E1's `query` readings the same construction E2 uses. |
| A37 | Cache key and reason corrected, status asserted, settings through the adapter's real channel | Mechanical | Eng Claude 9, Astra 10 | Applied | A wrong key is a silent no-op, and memory-qa passes `a.config`, not `a.pins`. |
| A38 | Query-path pins recorded; `expand: false` disclosed; every pinned key checked against `KNOWN_CONFIG_KEYS` | Mechanical | Eng Claude 10 | Applied | Decide slots default on with a key present and can prune hits; the key check generalizes the cache-key lesson. |
| A39 | Two cells per benchmark with named recipes and identity keys | Taste and Mechanical | Eng Claude 11, Astra 1 | Accepted | Merges the two shapes: Claude's two cells avoid generalizing the runner, Astra's recipe ids keep resumes and replays collision-safe. |
| A40 | E1 branches from PR #89's head; receipts record pin and loaded commit | Mechanical | Eng Claude 12 | Applied | The harness E1 extends is not on `main`. |
| A41 | Rerank handling that keeps the reproduction arm comparable and never frees an exclusion | Mechanical | Eng Claude 13, Astra test plan | Applied | Failing whole arms on a timeout would move the reproduction outside its band for reasons unrelated to delivery. |
| A42 | C1 through `DeliverOptions`; header priced, spans shifted; guard 2 scoped | Taste and Mechanical | Eng Claude 14, Astra 6 | Accepted | Protects the off-path golden and `think`, and removes an equality that cannot hold at a saturated cap. |
| A43 | Breadth rule: priced window from the existing window machinery, prefix formula for k | Mechanical and Taste | Eng Claude 15, Astra 9 | Applied | Astra's priced window reuses existing code; Claude's prefix sum gives a deterministic k; together they are preregistrable. |
| A44 | Config key plus library-only per-call override | Taste | Eng Claude 16 | Accepted | Switching a brain-level key between E2 calls is easy to get wrong. |
| A45 | `qa_context` and typed accounting in published rows | Mechanical | Eng Claude 17, Astra test plan | Applied | The runner computes packed ids but discards `raw`. |
| A46 | Accounting gate through memory-qa with the committed adapters, values asserted | Mechanical | Eng Claude 18, Astra test plan | Applied | v2's gate ran the receipt script, not the code that will be measured. |
| A47 | Twin reuse requires the same final prompt hash and reader and judge identity | Mechanical | Eng Claude 19, Astra test plan | Applied | Frozen contexts are keyed by context name, so reuse needs its own rule. |
| A48 | Add the two matched Sonnet controls (+$3.70) | Mechanical | Eng Astra 3 | Applied within the $50 cap | Without them readings 3 and 4 change retrieval or reader along with the named lever; the cheaper alternative, relabeling them composite, would leave E1 unable to choose between C1 and C2's variants. |
| A49 | Reading 1 threshold as the paired difference, 24.5 points | Mechanical | Eng Astra 4 | Applied | An absolute score can pass with a zero date effect. |
| A50 | Five-hit arm described as an existing-knob reference; hit and session counts recorded | Mechanical | Eng Astra 9 | Applied | Two chunks per page mean five hits can be fewer than five sessions. |
| A51 | gbrain order: PR 1 `cap_only` in parallel with E1 once G1 is answered; PR 2 after E1 reading 3; C1 after reading 1 | Taste | Eng Claude D17, Astra 7 (D6) | Accepted | Merges Claude's parallel lanes with Astra's "cap first, then reuse it"; `cap_only` is needed in every E1 outcome, the variants and C1 are not. |
| A52 | Minimum-budget contract goes to Garry as G1 (b) | User Challenge | Eng Astra 8 (D7) | Not applied; recommended default recorded | It is a product-contract choice, which the plan cannot make for itself. |
| A53 | E2 cap from $160 to $135 | Mechanical | follows A32 | Applied; G4 updated | The $25 reserve paid for reader calls on a guard that is now exact by construction. |
| A54 | Guards renumbered guard 1 to guard 9 | Mechanical | editorial | Applied | The old G labels collided with the G decisions. |
| A55 | Guard 9 from live handler calls with reranker time separate; local measurement labeled; held-out ratio overrun terminal | Mechanical | Eng Claude performance review, Astra test plan | Applied | Replay omits retrieval, the reranker dominates handler latency, and a sealed set cannot be used to retune a budget. |

## Changelog

### 2026-10-09: caps raised so evals don't stop on a cap

Garry raised the caps: E2 $270 to $600, E3 $10 to $25, program $700 to $1,500, expected costs unchanged. Leases at
about 3x their estimates; spend-triggered drops withdrawn; overruns past 2x reported, not stopped. Recorded in the cost
table and in E2's preregistration (amendment A2).

### 2026-10-09: H1 opens alone; E1 done

H1 carries this plan's candidate alone against the `auto` control, because the 10x plan's evidence brief did not
qualify for a joint opening (gbrain-evals#111). E1 ran on branch `capy/budgeted-delivery-e1` (report
`docs/benchmarks/2026-10-08-gbrain-budgeted-delivery-e1.md`); its readings feed the E2 and gbrain PR 1 decisions.

### 2026-10-08: approved, caps doubled

Garry approved v3 with all eight recommended defaults (G1 to G8) and doubled every cap: program $350 to $700, E1 $50
to $100, E2 $135 to $270, E3 $5 to $10, E4 $40 to $80, H1 $120 to $240. Expected costs and scope are unchanged.
Recorded in the status line and under Decisions for Garry, and as an approved-cap column in the cost table. The
decision rows keep their v3 wording; the approved caps supersede the caps they name.

### 2026-10-08: v3 after the autoplan engineering phase (both voices)

Integrated every finding from the [Claude](reviews/eng-claude.md) and [Astra](reviews/eng-astra.md) engineering
reviews; this is the final autoplan version, awaiting approval. gbrain changes: `resolveFrozenHits` projects
`effective_date`; a `budgetExplicit` flag makes the cap and every C2 variant engage only on an explicit budget across
`query`, `search`, `recall` and `assemble_evidence`; the cap is written as four rules (rank one protected, note prefix,
no spill, final-boundary recount including the snippet cap); `breadth_capped` has a precise k; C1 goes through
`DeliverOptions` with priced headers and shifted spans; C2 ships as two PRs. Harness changes: two cells per benchmark
with recipe identity keys; one chunk-unit `query` freeze per question with deliveries through
`assembleEvidenceForHits` and one live parity check on every consumed field; one date channel; pseudo-session pinned
to memory-qa's template with a specified parser; `B` per benchmark and rendering on the real frozen lists; corrected
cache key and reason; pinned and recorded decide, CRAG, retrieval write-back and `expand`; rerank handling; typed
receipts; E1 branches from PR #89. E1 readings are matched: paired date threshold (24.5 points), reading 2 against
`chunk-dated`, two Sonnet controls for readings 3 and 4. H1 runs through memory-qa custody. Guards renumbered 1 to 9;
guard 1 is structural and guard 6 exact. G1 now names the four operations, adds the minimum-budget choice and states
that an H1 pass changes nothing for callers without a budget; G2, G4, G5 and G8 updated. Added the architecture and
codepath-to-test diagrams, implementation tasks with effort, and the failure registry. Costs: E1 $44 / $50 to $47 /
$50; E2 $110 / $160 to $110 / $135; program $267 / $375 to $270 / $350.

### 2026-10-08: v2 after the autoplan CEO phase (both voices)

Integrated every finding from the [Claude](reviews/ceo-claude.md) and [Astra](reviews/ceo-astra.md) CEO reviews. E1's
pre-spend gate is now an accounting gate; E1 gains `query` at 5 hits, `query` at the 24,000 default, pseudo-session
rendering, a date-only pair with identical selections and a $3 saved-facts probe, and absorbs C1's test. Every `query`
arm passes `return_unit: 'auto'`, a pinned limit and the cache off; the budget comes from the maximum per-question
ratio (provisional 6,000 on the slice and 7,100 on LoCoMo, from 6,900). C2 becomes a family (`cap_only`,
`breadth_capped`, `depth_first`) with a global cap and contract tests, compared on the LongMemEval-S 500 with
`claude-sonnet-5-5`. Guards are one consistent set; H1 discloses the sealed v2 exposure and pins hit count and packer.
C4 is restaged around budgeting the existing facts lane. Costs: E1 $18.40 / $30 to $44 / $50; E2 $58 / $90 to $110 /
$160; program $205 / $300 to $267 / $375. Added the review record, the decision log and eight decisions for Garry.

### 2026-10-08: first draft

Diagnosis from the shootout rows and a keyless replay; candidates C0 to C5 with tests and costs; E1 recommended at
about $18 (cap $30); decision rule with the dev gate and the held-out decision on sealed confirmation set v2.
