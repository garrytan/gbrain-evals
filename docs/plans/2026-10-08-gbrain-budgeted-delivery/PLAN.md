# What gbrain hands the reader under a token budget: plan (v2)

Status: v2, revised after the autoplan CEO phase with two independent voices ([Claude review](reviews/ceo-claude.md),
[Astra review](reviews/ceo-astra.md)). Still planning only: no paid call was made and no gbrain or harness code
changed. Eight calls are open for Garry under [Decisions for Garry](#decisions-for-garry); each has a recommended
default, and nothing that depends on one runs before he answers it.

The diagnosis comes from the committed shootout rows and a keyless replay ($0, hash vectors, no provider key in the
environment). Written 2026-10-08 against gbrain-evals `f1ce49fe` (main), the shootout results at `9c07b7e2` (branch
`capy/oss-memory-shootout`), and gbrain `c5fb0201` (v0.60.95.0, the shootout's counted master). gbrain master is now
`7aa2caa`; every gbrain file cited here for search, delivery and the `query` operation is byte-identical between the
two, so the line numbers hold for both. Both reviewers checked the citations independently and found them accurate.

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
   ([decision G1](#decisions-for-garry)).
3. **Whole sessions are not the ceiling at 8,000 tokens.** With the sessions rehydrated, gbrain reaches 78% on the
   LongMemEval-S slice. Two systems that return extracted facts or observations reach 83% and 89% there, and one
   reaches 76% on LoCoMo with about 950 tokens. These are whole different systems, so they suggest, but do not prove,
   that compact dated evidence packs more answers into a fixed budget.

The plan proposes a measurement fix and five gbrain changes, each with a preregistrable test and a cost. The first
experiment, E1, costs about $44 (cap $50, up from $30 in v1, [decision G2](#decisions-for-garry)). It needs no gbrain
code, and it tells us which of four levers matters before anything is built: dates, rendering, hit count, or depth.

## What changed in v2

- **E1 can start.** v1's pre-spend gate asked today's `auto` to stay under the budget, which it does not do by design.
  v2 replaces it with an accounting gate and keeps the hard-cap assertion for the candidates that promise one.
- **E1 asks the cheaper questions first.** It adds `query` with 5 hits, `query` at the shipped 24,000-token default, and
  a rendering of `query`'s blocks as dated pseudo-sessions, the shape the held-out decision reads. It folds C1's test
  in, adds a date-only pair with identical selections, and runs a $3 saved-facts probe on LoCoMo dev.
- **The call is pinned.** Every `query` arm passes `return_unit: 'auto'` explicitly, because a budget without it
  silently selects legacy chunk budgeting. Hit counts, cache and budget sizing are pinned too.
- **Comparisons are matched.** Readings that compare delivery use one rendering, one reader and one frozen hit list.
- **C2 becomes a family.** Cap-only, capped breadth (C2-breadth) and depth-first (C2-depth) share one allocator and
  are compared with today's `auto` on the full LongMemEval-S 500 with `claude-sonnet-5-5`, the held-out reader.
- **Guards are consistent.** The same definitions apply on dev and held-out, and C1's intentional byte change is
  separated from C2's compatibility promise.
- **The held-out decision is repaired.** It discloses the sealed v2 exposure, pins hit count and packer, and justifies
  its size from dev analogues instead of the old chunk score.
- **C4 is restaged.** The saved-facts probe runs now; stage 1 first adds a budget to the existing facts lane; the
  production fact search is a separate candidate with its own access-rule tests and a break-even cost test.

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
arm's `rows.ndjson.gz` and equal to the arm receipt's `qa_service_score`. The Astra review recomputed the gbrain rows
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
one rerank call. `balanced` also turns on the semantic result cache at similarity 0.92 (`mode.ts:494-498`), which can
serve one question's hits to a near-duplicate question; v2 pins it off (C0).

**What comes back.** gbrain keeps at most two chunks per page (`src/core/search/dedup.ts:25`) and cuts the return to
its 12,000-token search budget (`src/core/search/hybrid/rank.ts:461`), so the budget, not the limit, decides the
count: asking for 40 returned about the same number as asking for 25 (18.9 against 18.5 chunks on the slice).

| Benchmark | Chunk items returned (min to max) | Tokens per item (harness count) | Items that fit 8,000 tokens (estimated) | Share kept |
|---|---:|---:|---:|---:|
| LongMemEval-S slice | 18.9 (16 to 24) | 636 | 12.1 | 64% |
| LoCoMo dev | 21.6 (19 to 26) | 542 | 14.3 | 66% |
| BEAM-100K dev | 19.1 (13 to 40) | 623 | 12.8 | 67% |

The estimate divides each question's packed 8,000-token context by its tokens per item from the unbudgeted arm, since
the rows do not store packed item ids. So about a third of what gbrain returned was cut by the harness packer, in rank
order. Every new arm in this plan stores its packed item ids so that no later reading has to estimate them.

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
LongMemEval's reading prompt (`READER_TEMPLATE`) with dated, turn-by-turn sessions in date order
(`render.ts:36,79-123`; `eval/runner/memory-qa/qa.ts:35,45-47`). Sealed v2 decision 1 rendered each delivered block as
a dated pseudo-session through that same reading prompt.

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

Two product behaviors explain this, both visible in the code, pinned by gbrain's own test and described in gbrain's
documentation:

- **Breadth before depth.** `allocate` first reserves every hit page's matching chunk ("floor") in rank order, then
  expands pages toward whole sessions in rank order (`src/core/search/evidence-delivery.ts:680-735`). With 25 hits
  and 8,000 tokens the floors use the budget, so almost nothing becomes a whole session.
- **The budget is not a cap under `auto`.** A conversation whose floor does not fit is "spilled" to its ranked chunks,
  which are appended after allocation without being counted against the budget (`evidence-delivery.ts:894-898,944-957`;
  the test `test/evidence-delivery.test.ts:272-287` asserts the spill and that nothing is dropped). Non-conversation
  chunks are reserved and emitted unchanged too (`evidence-delivery.ts:827-837`), so they can also exceed the budget.
  This is the documented contract: "`auto` never returns less than `chunk` would. `budget_used` exceeds
  `budget_tokens` only by such unchanged chunks" (gbrain `docs/evidence-delivery.md:118-123`). At 24,000 tokens and
  five hits, the setting `auto` was tuned and confirmed on, the spill almost never fires. At 8,000 tokens it fires on
  every question.

**A bare budget selects a different unit.** A `query` call that passes a numeric `token_budget` without an explicit
`return_unit` invokes legacy chunk budgeting, even when the configured unit is `auto`
(`src/core/ops/search.ts:129-140` passes `legacyBudget`; `evidence-delivery.ts:186-202` changes the implied unit to
`chunk`). So an ordinary caller who only passes a budget does not get `auto` today. Every `query` arm in this plan
passes `return_unit: 'auto'`; E1 also records, keylessly, what the bare-budget call returns, and
[decision G7](#decisions-for-garry) asks whether that should change.

**Token units.** gbrain counts delivered text with `cl100k` while the harness counts characters divided by four. On
the LongMemEval-S slice the harness count runs 1.15 times gbrain's on average, but 45 to 53 of 100 questions run
higher and the maximum is 1.288; on LoCoMo dev the mean is about 1.02 and the maximum 1.091
(`receipts/token-ratio-distribution.txt`). A budget converted with the mean ratio puts about half the slice questions
over the harness limit, so v2 sizes the budget from the maximum (C0).

### Diagnosis: adapter or product

Both, in proportions E1 is built to measure.

- **Adapter configuration.** The adapter measured gbrain's ranking function, not the agent's read path. It dropped
  the dates gbrain returns, skipped evidence delivery, and was read through a different layout and prompt than the
  rehydrated reference. On LoCoMo the missing dates are the likeliest main cause; E1's date-only pair, with identical
  selections, measures it. This needs no gbrain change, only new, separately named adapters and a new dated run; the
  frozen shootout rows stand as measured.
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
LoCoMo. A gbrain ingest costs $1.53 on the slice (21,821 embeddings), about $7.65 on the 500, about $0.02 on LoCoMo
dev and $0.11 on BEAM dev; retrieval with the reranker costs $0.07 to $0.38 per 100 questions per policy. Replaying
one slice arm's frozen contexts with the four newest frontier readers (`claude-opus-5-5`, `gpt-6.1-sol`,
`claude-sonnet-5-5`, `claude-fable-5-1`) costs about $20, most of it Fable. Every estimate is cold cache; the
embedding cache is local, so a warm machine pays less, and no estimate assumes it.

### C0. Measure through the agent's read path (measurement fix, not a product change)

**Adapter.** A new adapter, `gbrain-query`, calls gbrain's `query` handler in process with a local operation context
(`src/core/ops/search.ts:812`). Items are the delivered blocks: type `page` for a conversation block and `chunk`
otherwise, text prefixed with the title, `valid_from` set from `effective_date`, one source id per block. Its
capability record passes the budget through the `fixed-evidence` settings, as the memory-bank system's record passes
its own `max_tokens: 8000`, and passes no budget under `vendor-default` (the 24,000 default).

**The exact call, preregistered.** Every arm's parameter object is written into the preregistration and printed into
each run's receipt as resolved:

```
{ query, limit: 25 | 5, expand: false, return_unit: 'auto', token_budget: B_bench | omitted }
search settings: gbrain defaults for `balanced`, plus search.cache_enabled=false via the existing search pins
```

`limit` is pinned in every arm: 25 is the agent default, 5 is the setting `auto` was confirmed on. The receipt also
records the resolved mode, reranker, search budget and code identities, so a wrong implicit unit or a different hit
count refuses the cell as harness-invalid instead of producing a mislabeled score.

**Budget sizing rule.** `B_bench = floor_100(8,000 / (r_max × 1.02))`, where `r_max` is the highest per-question ratio
of harness tokens to gbrain tokens across the keyless replay's configurations on that benchmark, measured on the
adapter's serialized items (title prefix and date header included), and 1.02 is a stated margin. From today's replay
(raw delivered text, before title prefixes) the provisional values are 6,000 on the LongMemEval-S slice
(`r_max` 1.288) and 7,100 on LoCoMo dev (`r_max` 1.091). BEAM-100K dev has no keyless replay yet; it gets one before
its value is set. The final values and the full ratio distribution are frozen in the preregistration from the
committed adapter, before any paid cell. This replaces v1's single 6,900, which was 8,000 divided by the mean.

**Two retrieval paths, kept apart.** The shootout arm requests 40 hits from `hybridSearch`; `query` requests 25 and
runs through `hybridSearchCached` and operation-level behavior (`ops/search.ts:919-978`). So a difference between
them is a product-path difference, not a delivery effect, unless their pre-delivery hits match. The adapter records
`query`'s upstream ranked hit ids before delivery; a keyless check compares them with `hybridSearch` at limit 25 on
the same brain. Where they match, the difference may be described as delivery; where they do not, it is labeled
product path. Delivery-only comparisons (E1's rendering arms, all of E2) run delivery variants on one frozen ranked
hit list per question.

**`chunk-dated`.** A second item mapping keeps today's `hybridSearch` call and adds a one-line date header in the item
text, built from `effective_date`, with `valid_from` unset. That is exactly the text C1 would ship, so E1's
`chunk-dated` arm is C1's dev test.

**Per-row accounting.** Every row records gbrain `budget_tokens` and `budget_used`, spilled-block count, delivery
fallbacks (`fetch_failed`, `fetch_timeout`, `page_missing`, which today degrade blocks silently to chunks), cache
status, the `auto_packing` setting, the harness token count before and after the packer, the packer-cut item count,
the packed item ids and source ids, and the prompt hash. A reranker failure fails the arm instead of degrading it.

Both mappings are new named adapters in a new dated run. The shootout's frozen gbrain rows are not edited, and any
later comparison page labels these rows as an adapter revised after seeing the results, on development data.

### C1. Dated evidence blocks in gbrain (test folded into E1)

**Mechanism.** Every delivered conversation block (and every chunk from a dated page) starts with a one-line date
header built from `effective_date`, so a consumer that renders only the text still sees when the conversation
happened. This is the `query` counterpart of `think`'s date frame (P6 R1), which passed its sealed LoCoMo check
(+14.0 points, temporal 27 → 199 of 221). Today the date is only in separate fields.

**Where.** `deliverEvidence` and the chunk passthrough in `src/core/search/evidence-delivery.ts:899-955`, plus the
plain chunk path's output rows, behind its own config key, separate from C2's.

**Test.** E1's date-only pair: `chunk-dated` against an undated twin with the identical selected ids, native
rendering, on LoCoMo dev temporal and the slice. No separate C1 arms remain. C1 changes bytes on purpose, so it has
its own byte guard (G2 below): delivered text differs from today's only by one header line per dated block.

**Ships how.** C1 helps only readers that ignore fields, so it rides with the winning C2 variant to the held-out
decision as one bundle, as in v1. The held-out rendering prints dates from the field, so H1 can show C1 does no harm
but cannot show its benefit; [decision G5](#decisions-for-garry) asks whether that is acceptable.

**Cost.** Inside E1.

### C2. Budget-respecting conversation packing (the main candidate, now a family of three)

**The cap, for every variant.** When the caller passes `token_budget` explicitly and the unit resolves to `auto`, the
budget is a hard cap on everything `query` delivers: dated titles, headers, block bodies, omission markers and
non-conversation chunks, counted with gbrain's own counter. The minimum unit rule: if the first unit in rank order
does not fit alone, it is cut to fit at a turn boundary with a counted omission marker, as `allocate` already cuts
rank one today (`evidence-delivery.ts:696-726`), so a non-empty hit list never yields empty evidence. Everything that
gets nothing is listed in `dropped_reasons`, never appended outside the budget. Without an explicit budget the
default path keeps today's behavior. This reverses the documented "never less than `chunk`" contract for explicit
budgets, so it waits on [decision G1](#decisions-for-garry); the gbrain PR updates `docs/evidence-delivery.md:118-123`,
the test at `test/evidence-delivery.test.ts:272-287` and CHANGELOG together.

**Three allocation variants, one function.** Each is a value of one config key, `search.auto_packing`, implemented as
a parameter of the existing allocator rather than a second allocator:

1. **`cap_only`**: today's floors-first `allocate`, with the hard cap. The smallest diff; it fixes the contract and
   changes nothing else.
2. **`breadth_capped` (C2-breadth)**: floors-first, fed only the top k conversation groups that fit with each floor
   plus a window around it, k scaled to the budget, with the hard cap. E1's 5-hit arm previews it.
3. **`depth_first` (C2-depth)**: v1's design. Pay for non-conversation chunks first; group conversation hits by
   session in order of each session's best hit; take each session whole if it fits what is left, else the largest
   window around its matching chunks that fits, else skip to the next session; stop when no remaining session's
   matching chunk fits.

When every hit session fits whole (the 24,000-token default with short sessions), every variant's output is
byte-identical to today's, which is a keyless assertion, not a hope. `page`, `section` and `window` keep their
behavior.

**Why these three.** Whole sessions beat chunks by 108 of 400 questions in the first evidence-delivery study, ten
chunks in place of five added nothing there, and the harness's depth-first rehydration gains 19 points on the slice
with the same hits, which favors depth. But sealed v2, the held-out material, has about 3,100-token chats, and its 80
multi-session and 40 knowledge-update questions need three or four gold chats: at about 6,000 tokens a depth-first
pack holds two whole chats and a window, so it cannot hold all the gold for most of them. The slice says the same:
two whole sessions 78%, five whole 86%. Breadth of about five with enough depth around each match may be the better
fit, and the cap alone may be most of the value. v2 tests all three instead of presuming one; whether depth-first
stays the preferred direction is [decision G3](#decisions-for-garry).

**Preregistered expectations.** On LongMemEval-S multi-session (about 133 of the 500 questions): `breadth_capped` at
or above today's `auto`; `depth_first` may fall below it. A variant whose multi-session paired estimate falls below
today's by more than the category guard does not go to held-out, whatever its overall score.

**Contract tests (keyless, in the gbrain PR).** Never over an explicit budget by gbrain's count, every case; mixed
note and chat hits; notes only, where non-conversation chunks alone exceed the budget; a budget smaller than one
chunk; a missing `effective_date` (no invented date); redaction that grows or shrinks a block, recounted after the
redaction pass; rank one longer than the budget (cut, not dropped); zero conversation hits; a source-swamp fixture
modeled on Cat13b (a curated note and several chat dumps with the same phrase, under a tight budget) checking the
note is still delivered; and `cat13b-source-swamp.ts --stub-embed` with the flag on, expected identical because
ranking does not change. The authorized batched page fetch, the live and cached fallback distinction and the
protected-body projection stay as they are (`evidence-delivery.ts:814-899`); a candidate never revives unreadable
cached text. Both storage engines run the suite before any held-out request.

**Test.** E2 below. **Cost.** About $110, cap $160 (E2).

### C3. Session-level merge and ranking of chunks

**Mechanism.** Two parts. (a) Session fusion before delivery: score each session from all its chunk hits (for
example best reranker score plus a damped sum of the rest) and rank sessions, not chunks, so a session that matched
three times outranks one that matched once slightly higher. (b) In `chunk` and `window` delivery, merge same-session
hits into one block in document order with one date header, the way conversation delivery already groups by page
(`evidence-delivery.ts:833-845`). Today the per-page cap of two (`dedup.ts:25`) lets the same session take two of the
25 slots as two separate items, each paying for its own title.

**Test.** Retrieval gate first, nearly free: upstream strict recall_all@5 and @10 on the slice, LoCoMo dev and BEAM
dev (BEAM is where gbrain's recall is lowest, 57.4%), session fusion against today's ranking, with a non-inferiority
guardrail of 1 point on the slice and superiority sought on BEAM. Recall here is computed on the upstream ranked hits
the adapter records, not on delivered blocks. QA only if recall moves: one arm per benchmark under the leading C2
variant. C3 stays conditional; it is not a prerequisite for fixing the cap.

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
written. v2 splits C4 into three steps:

1. **Saved-facts probe, now, inside E1.** The existing lane as it is, on LoCoMo dev only, with one harness change:
   record the facts context's token count per row. About $1.80 extraction and $1 QA. It runs on a different runner
   and prompt and is unbounded, which the readings disclose. It answers one question: is there headroom above the best
   E1 arm worth paying for? The extraction is saved as a frozen artifact for reuse.
2. **Stage 1, budgeting the existing facts lane.** Add a budget to the lane: facts ordered by their session's rank and
   then by date, packed by the harness count to 2,000 tokens (facts only) or packed first into 8,000 tokens with the
   remainder filled by the same session packer (facts then sessions), with exact token accounting and packed fact ids.
   This is harness work, no gbrain code, and reuses the frozen extraction. Run on LoCoMo dev and BEAM dev against the
   best E1 arm, or the leading E2 variant once E2 has run.
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
hit count and depth. It needs only the C0 adapters in gbrain-evals, at the frozen gbrain `c5fb0201`, so the paired
comparison with the shootout rows is clean. Sets: the LongMemEval-S slice (inferential, question-clustered), LoCoMo
dev and BEAM-100K dev (descriptive).

| Arm | Rendering | Reader | Sets | What the reader gets | Question it answers |
|---|---|---|---|---|---|
| `shootout-chunk` | native | main | all three | today's adapter, limit 40 | reproduces 59.0% / 64.9% / 60.5%; link to the frozen rows |
| `chunk-dated` | native | main | all three | the same chunks, each with the C1 date header | date effect; C1's dev test |
| `chunk-undated-twin` | native | main | all three | `chunk-dated`'s exact selected ids, no header | the undated half of the date-only pair |
| `query-auto` | native | main | all three | `query`, `auto`, 25 hits, `B_bench`, harness pack at 8,000 with cuts counted | what today's product delivers at 8,000 harness tokens |
| `query-auto-default` | native | main | slice, LoCoMo | `query`, `auto`, 25 hits, no budget (24,000) | gbrain as shipped; labeled as a different budget |
| `query-auto-pseudo` | pseudo-session | Sonnet on slice, main on LoCoMo | slice, LoCoMo | `query-auto`'s delivered blocks, each as a dated pseudo-session | the H1 shape; product against rendering |
| `query-auto-l5-pseudo` | pseudo-session | Sonnet on slice, main on LoCoMo | slice, LoCoMo | `query`, `auto`, 5 hits, `B_bench` | does hit count alone close the gap |
| `chunk-dated-pseudo` | pseudo-session | Sonnet on slice, main on LoCoMo | slice, LoCoMo | the dated chunks, each as a pseudo-session | dated breadth at matched rendering |
| `rehydrated` | rehydrated template | main on all three; Sonnet too on slice | all three | the harness's whole sessions from the `shootout-chunk` hits | depth reference; reproduces 78.0% / 72.7% / 59.4% |
| saved-facts probe | facts lane | main | LoCoMo | all saved facts from the top sessions, token count recorded | headroom above the best E1 arm |

Notes on the arms:

- **The date-only pair.** Header text changes which items fit, so `chunk-dated` alone is not a date-only comparison.
  The twin renders `chunk-dated`'s selected ids without headers. Because the packer takes a rank-order prefix, the
  twin's prompt is byte-identical to `shootout-chunk`'s on every question where the two selections match; those rows
  are reused, and only the differing questions need a reader call.
- **Pseudo-session rendering** shows each delivered block as a dated session through the rehydrated arm's reading
  template, in date order, the way sealed v2 decision 1 rendered `auto`'s blocks. It is packed by the harness count
  of its own serialization at 8,000 tokens; any selection difference from the native arm is counted.
- **Readers.** The main readers keep the link to the shootout. Readings that steer what gets built are read on the
  slice with `claude-sonnet-5-5`, the held-out reader, and `rehydrated` is read with both so the comparison is matched.
  The full four-reader check comes at E2, before anything reaches held-out; whether E1 should run it too is
  [decision G8](#decisions-for-garry).

All arms share one ingest per benchmark. Retrievals: the `hybridSearch` call at limit 40, and the `query` call at 25
hits with and without a budget and at 5 hits, with the cache pinned off.

### Before E1 spends anything

1. **Commit the adapters with keyless tests.** `shootout-chunk` retrieval byte-identical to the golden; `chunk-dated`
   mapping (title and date present; a null date renders as none; empty chunk text); the resolved-call receipt for each
   arm, refusing a cell whose unit, limit or settings differ from the preregistered object; the pre-delivery hit
   comparison between `query` and `hybridSearch` at limit 25; the bare-budget call's output recorded for G7.
2. **Accounting gate, not a cap gate.** On the keyless replay of all three benchmarks (adding the missing BEAM dev
   replay), every `query-auto` row must carry a complete accounting record: `budget_used`, spilled-block count,
   fallbacks, cache status, harness tokens before and after the packer and the packer-cut count. The gate passes when
   every record is complete and every cut is counted. It does not require `query-auto` to stay under budget, because
   today's `auto` does not by design; fixing that inside the adapter by truncating would silently change what the arm
   measures. The never-over-budget assertion belongs to the C2 variants.
3. **Freeze `B_bench`** per benchmark from the committed adapter's serialized items, with the ratio distribution.
4. **Vendor date-fairness check.** A one-line audit of the two vendor shims that leave `valid_from` unset: does their
   product return a date the shim drops? The result is disclosed in the preregistration. If a shim drops a returned
   field, that is a harness bug, fixed for every system alike and rerun in a separately approved, dated run, not vendor
   tuning and not inside E1's budget.
5. **Commit the preregistration** with this table, the call objects, the reproduction band, the readings below and
   the drop order.

### Reproduction band and stop rule

Two gbrain versions with the same adapter already differ by 3 to 5 points on slice arms (0.60.46 against 0.60.95 at
`9c07b7e2`), and identical requests flip about 5% of answers at provider-default temperature (auto v2 study). So
`shootout-chunk` and `rehydrated` must reproduce their frozen scores within 4 points on the slice, 3 on LoCoMo dev and
5 on BEAM-100K dev, with at least 85% per-question agreement on the slice. A miss on any of them stops E1 for a
determinism check before any reading is made.

### Preregistered readings (exploratory triage, written before the run)

Every reading reports the paired difference with its cluster-bootstrap interval beside the point estimate. On 100
questions most intervals will span zero, so each reading names an uncertain outcome, and none of them sets a default.

1. **Date effect.** `chunk-dated` minus `chunk-undated-twin`, on LoCoMo temporal and on the slice. If it recovers at
   least half of LoCoMo's 25 → 74 temporal gap (50 or more of 100), the LoCoMo shortfall is mainly an adapter finding
   and the comparison page says so. Below that, the gap stays described as a presentation bundle.
2. **Product path at 8,000.** `query-auto` minus `shootout-chunk`, native, on the slice. Described as a delivery effect
   only where the pre-delivery hits match; otherwise as a product-path effect. The replay predicts little (0.6 whole
   sessions per question).
3. **Depth gap at matched rendering.** `rehydrated` minus the best of `query-auto-pseudo`, `query-auto-l5-pseudo` and
   `chunk-dated-pseudo`, all with Sonnet on the slice.
   - If `chunk-dated-pseudo` is within 3 points of `rehydrated`, dates and layout were the lever: C1 leads, and C2's
     depth variant moves down.
   - If `query-auto-l5-pseudo` is within 3 points of `rehydrated`, hit count is the lever: `breadth_capped` leads E2.
   - If the gap to the best arm is 5 points or more, E2 runs the full C2 family as planned.
   - If it is under 5 points and neither case above holds, the outcome is uncertain: E2 still runs `cap_only` and
     `breadth_capped`, since the cap is a contract fix either way, and C4 stage 1 moves ahead of `depth_first`.
4. **Rendering effect.** `query-auto-pseudo` minus `query-auto`, slice, reported for the comparison page; it says how
   much of the shootout gap was layout and prompt.
5. **As shipped.** `query-auto-default` is reported with its budget and token count; it informs the comparison page
   and decides nothing.
6. **Facts headroom.** The saved-facts probe against the best LoCoMo arm, disclosed as a different runner and an
   unbounded context. If it lands at or above the best E1 arm, C4 stage 1 earns its harness work now, gated on the
   best E1 arm rather than on C2 existing.

### E1 cost

| Item | Cost |
|---|---:|
| Ingest (all three) and four retrieval policies with the reranker | $4.20 |
| `shootout-chunk`, `chunk-dated`, `query-auto`, native, main readers, three sets | $11.70 |
| `chunk-undated-twin`, only questions whose selection differs | up to $1.00 |
| `query-auto-default`, slice and LoCoMo (27,600 and 17,800 harness tokens per question) | $9.30 |
| Three pseudo-session arms, Sonnet on the slice | $5.55 |
| `rehydrated` on the slice, main reader and Sonnet | $4.05 |
| Four pseudo-session and rehydrated arms on LoCoMo, main reader | $4.40 |
| `rehydrated` on BEAM dev, main reader | $0.60 |
| Saved-facts probe on LoCoMo dev | $3.00 |
| **Total** | **about $44, cap $50** |

No frontier four-reader replay in E1 (G8). If the ledger nears the cap, arms are dropped in this preregistered order:
the LoCoMo pseudo-session arms, then `query-auto-default` on LoCoMo, then the facts probe. Wall time is about three
hours on one VM. Keys: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` and `VOYAGE_API_KEY` (the reranker). The cap raise from
$30 is [decision G2](#decisions-for-garry).

## Order of work after E1

1. **E2, the C2 family (dev verdict).** On a gbrain branch behind `search.auto_packing`, measured through
   `gbrain-query`. Primary: the LongMemEval-S 500 (all development data; it detects roughly 5 to 7 points, paired by
   question), pseudo-session rendering, `claude-sonnet-5-5`, 25 hits, `B_bench` sized by the same rule from a
   keyless replay of all 500, delivery variants on one frozen ranked hit list per question, with a live product-path
   check per variant on the slice. Arms: today's `auto`,
   `cap_only`, `breadth_capped`, `depth_first`; today's `window` unit as an existing-knob reference on the slice; the
   default-budget guard; LoCoMo dev and BEAM dev as descriptive tables; the slice in native rendering with the main
   reader for the baseline and the leading variant, as the link to E1 and the shootout. The four frontier readers
   replay the baseline and the leading variant on the slice questions. A 16,000-token sweep on the slice is
   exploratory and chooses the held-out budget. C5's rank-order arm rides along. About $110, cap $160
   ([decision G4](#decisions-for-garry)). If E1 reading 3 says dates were the lever, E2 shrinks to `cap_only` alone.
2. **E3, C3 retrieval gate.** About $1.20, run alongside E2. QA only if recall moves.
3. **E4, C4 stage 1**, budgeting the existing facts lane, gated on the E1 facts probe and compared with the best E1
   arm or the leading E2 variant. About $27, cap $40. The slice stage and the production candidate need their own
   approval.
4. **H1, held-out decision** for the one bundle that passes dev (the leading C2 variant with C1), on sealed
   confirmation set v2.

## Cost table

Estimates are cold cache and priced per arm from each arm's own token envelope, with reader output, judges, retries
and a margin. Caps are proposals for approval; the budget ledger's reservations enforce them, and a spreadsheet
estimate is not a spending limit.

| Step | What it buys | v1 expected / cap | v2 expected / cap | Approval |
|---|---|---:|---:|---|
| E1 | adapter-or-product split; dates, rendering, hit count, depth; facts probe | $18.40 / $30 | $44 / $50 | G2 |
| E2 | dev verdict on the C2 family on the LongMemEval-S 500, frontier check, sweep, C5 | $58 / $90, plus sweep $8 and E5 $4.40 | $110 / $160 (sweep and C5 included) | G4 |
| E3 | C3 retrieval gate | $1.20 / n/a | $1.20 / $5 | with E2 |
| E4 | C4 stage 1, budgeted facts lane on LoCoMo and BEAM dev | $30 / n/a | $27 / $40 | with E2 |
| H1 | held-out decision on sealed v2, one opening | $85 / $120 | $85 / $120 | after dev, with custody |
| **Program total** | | **about $205 / $300** | **about $267 / $375** | G4 |
| Separate approvals | C4 slice stage (about $110); C4 production candidate; C5 on the 500 ($9.25) | | | each its own |

The E2 increase comes from three review findings: the 500 in place of the slice (about $9.25 per Sonnet arm plus
$7.65 ingest), two more variants, and pricing the default-budget guard from its real envelope. The guard costs reader
calls only on questions whose delivered bytes differ from today's, expected few; the cap reserves $25 for it, and
spending past that stops and reports.

## Decision rule for turning a change on by default

This follows [docs/decisions.md](../../decisions.md): dev verdicts guide the work and never set a default; only a
held-out win turns a feature on, and the held-out set is opened once by the custodian after the comparison is
preregistered. It borrows the bars the held-out program used for P6 and the sealed v2 decision 1.

### Guards, the same on dev and held-out

Each guard is defined once and applied to both stages, read on that stage's primary set.

- **G1, C2 compatibility (exact).** At the default budget, each C2 variant's delivered bytes equal today's whenever
  today's delivery spilled and cut nothing. Checked keyless on the slice, LoCoMo dev and BEAM dev, and on the frozen
  held-out evidence before any label is read.
- **G2, C1 change (exact).** With C1 on, delivered text differs from C1 off only by one date header line per dated
  block. A bundle (C1 with a C2 variant) at the default budget equals C1 alone, byte for byte, whenever G1's condition
  holds.
- **G3, product-token cap (exact, candidates only).** gbrain's `budget_used` never exceeds an explicit `token_budget`,
  every question, counting all delivered output. Today's `auto` is not held to this; its overrun is recorded.
- **G4, reader-context cap (exact, candidates only).** The serialized reader context fits 8,000 harness tokens with
  zero packer cuts, every question. The baseline goes through the same packer at the same budget, and its cuts are
  counted.
- **G5, retrieval invariance (exact for delivery-only changes).** Upstream ranked hit ids identical between candidate
  and baseline. Delivered-source coverage (gold sessions among delivered blocks) is reported as its own metric, with
  the preregistered expectation for each variant; it is not a guard, because a correct cap can deliver fewer sessions.
  For C3, upstream recall_all@5 non-inferior within 1 point.
- **G6, non-inferiority at the default budget.** 3 points, unless G1 and G2 show the pair exact.
- **G7, question kinds.** No question kind down by more than one question or 2% of that kind, whichever is larger;
  multi-session is also held to the preregistered expectation above.
- **G8, abstention.** Not worse.
- **G9, latency.** p95 of the `query` handler alone (excluding reader and judge) within +20%.

### Dev gate

Per candidate, `decision.json` committed before any paid cell, verdict type `quality`, or `cost` for C4's facts-only
arm under its own rule.

- **Primary, superiority.** On the LongMemEval-S 500 at 8,000 harness tokens (`B_bench`), pseudo-session rendering,
  QA service quality with `claude-sonnet-5-5`, candidate against today's `gbrain-query` at the same gbrain base commit
  and the same frozen hit list. Rows paired by question after the cross-arm exclusion join, question clusters,
  cluster bootstrap with 10,000 draws, two-sided sign-flip p. Raw paired intervals are reported for every variant; no
  multiplicity correction in dev, because dev sets nothing. The candidate family (`cap_only`, `breadth_capped`,
  `depth_first`) is fixed in the preregistration.
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
  delivery questions, and at 8,000 tokens it rewards breadth, which is why G7's multi-session expectation gates entry.
  Not eligible: LoCoMo sealed (7 conversations, below the 10-cluster minimum, "never a primary confirmation" in its
  split file, already used by P6, P2 E2, P3 E1 and the shootout's Phase 7) and BEAM-100K sealed (used by the P4 core
  gate and Phase 7). LongMemEval-S has no sealed split.
- **Exposure, disclosed.** On 2026-10-04 and 2026-10-05 the set's session text (not its questions or `labels.json`)
  from 34 of 40 histories was imported into throwaway brains and sent to model providers for gbrain P8 quote grounding
  (protocol, "Exposure (added 2026-10-05)"). No label or ledger was read. This does not bias a delivery decision:
  nothing in delivery or in this plan was tuned on that text, and no label was seen. The preregistration names the
  exposure, as the protocol requires, and records the access log's state, verified at preregistration time (three
  lines after decision 1, per the protocol).
- **Arms, pinned.** Candidate bundle and today's default, both `query` with `limit: 25`, `return_unit: 'auto'` and
  the budget dev chose (8,000 harness tokens, `B_bench` from the most conservative dev ratio, since the sealed text
  cannot be replayed for sizing, unless the sweep says otherwise). Both pass through the same harness packer at the
  same harness-token budget, with the baseline's overruns cut in rank order and counted. The same pair at 5 hits is
  reported as a reference (decision 1's hit count). Both at the product default budget, first checked for byte
  identity on the frozen evidence before any label is read; if identical, reported as exact at no reader cost.
  Rendering: dated pseudo-sessions, as in decision 1.
- **Sample size, justified from dev.** The expected effect and discordance come from E2's paired results on the
  LongMemEval-S kinds sealed v2 is built from (multi-session, knowledge-update, temporal), and the detectable effect
  on 200 paired questions is computed from them before custody is requested. The old chunk score (66%) is not the
  baseline; today's `auto` is.
- **Pass.** Superiority at the tight budget with a persona-clustered 95% interval above zero and exact McNemar p below
  0.05; G6 at the default budget unless shown exact; G7; G8. Multiplicity applies only if more than one candidate is
  opened, which this plan does not do.
- **Reader.** `claude-sonnet-5-5` as primary, the other three frontier readers on the same frozen contexts, disclosed.
- **Terminal outcomes.** `pass` turns the bundle on. `fail` or `inconclusive` leaves it opt-in; the set is not
  reopened for the same candidate, and no budget is tuned on it.
- **Records.** The frozen build SHA, `decision.json`, the dev and held-out verdicts committed under
  `docs/eval/decisions/<decision-id>/` in the gbrain pull request, as decisions.md describes.
- **Cost.** About $85: retrieval freeze $3.70 as measured in decision 1, Sonnet tight and 5-hit pairs about $16,
  judges about $3, frontier replay of the tight pair about $60; the default-budget pair costs nothing if exact. Cap
  $120.

One opening tests one bundle. The last opening stays in reserve for C4 or a later default-budget change. Changing the
default budget itself (24,000) is a separate decision and is not part of this plan.

## Decisions for Garry

Each needs Garry's call because it changes a product contract, the direction of the plan or its budget. The
recommended default is what the plan does if he accepts it.

| # | Decision | Recommended default | Why | Blocks |
|---|---|---|---|---|
| G1 | Make the budget a hard cap under `auto` only when the caller passes `token_budget` explicitly. This reverses gbrain's documented contract that `auto` never returns less than `chunk` would (`docs/evidence-delivery.md:118-123`, pinned by `test/evidence-delivery.test.ts:272-287`). (Claude D2, finding 2) | **Yes, explicit budgets only.** The default path keeps today's spill and stays byte-identical. Doc paragraph, test and CHANGELOG change in the same gbrain PR. | An explicit budget is the caller's cost promise; today it means "about this much", and at 8,000 tokens it is exceeded on every question. Callers who rely on the default lose nothing. | the gbrain branch for E2 |
| G2 | Raise the E1 cap from $30 to $50. (Claude D19) | **Approve $50.** Expected about $44, with a preregistered drop order if the ledger nears the cap. | The added arms (5 hits, the 24,000 default, pseudo-session rendering, the date-only twin, Sonnet on the steering arms) and the facts probe are what let E1 choose what to build. | E1 |
| G3 | Whether depth-first packing stays the preferred direction now that the causal split is unproven. (Astra D3, User Challenge, finding 3) | **Treat the three C2 variants as equals** and let the preregistered dev rule pick one; keep the name C2 and the depth variant in the family. | Sealed v2 at 8,000 tokens rewards breadth, the 5-hit replay already stays in budget, and the cap alone may be most of the value. v2 keeps depth-first in the family, so nothing is removed. | E2 design |
| G4 | Raise E2 from $58 expected, $90 cap to about $110, cap $160, and the program total from about $205, cap $300 to about $267, cap $375. | **Approve when E1's readings call for E2.** | The 500 detects 5 to 7 points where the slice detects only 12 to 18, so an `inconclusive` after $58 is the likely v1 outcome; Sonnet matches the held-out reader. | E2 |
| G5 | Let C1 (date headers) ship inside the H1 bundle although H1's pseudo-session rendering prints dates from the field, so H1 can show C1 does no harm but not that it helps. | **Yes, ship in the bundle, disclosed**, with its benefit evidence from E1's dev date pair. Alternative: a native-rendered secondary pair in H1 (about $8, with Holm across the two). | C1 helps exactly the consumers that render text only, which H1's shape cannot represent. | H1 preregistration |
| G6 | Fund C4 stage 1 (budgeting the existing facts lane, about $27, cap $40) if the E1 facts probe shows headroom. | **Yes, gated on the probe**, compared with the best E1 arm, not on C2 existing. | The facts path is the only one aimed above the raw-session ceiling and the only one that could cut tokens several times over. | E4 |
| G7 | Whether a bare `token_budget` (no `return_unit`) should keep selecting legacy chunk budgeting. | **No change in this plan.** E1 records what that call returns, keylessly; revisit after H1. | Changing the implied unit is a second contract change, and this plan should not stack two in one PR. | nothing in this plan |
| G8 | Run the four frontier readers on E1's steering arms too (Astra finding 10), instead of Sonnet alone. | **Sonnet alone in E1**, four readers at E2 before any held-out request. Full four-reader E1 adds about $36 and needs a cap of about $90. | E1 chooses what to build next, which is cheap to reverse; no default rests on E1. Astra's review asks for the full set; this is a budget and model-policy call, not an exemption the plan can grant itself. | E1 scope |

## Risks and limits

- **LongMemEval-S is development data.** gbrain's release configuration was chosen on it, so even the 500 guides
  work; only H1 sets a default.
- **E1 is small.** 100 slice questions detect only large effects, so E1's readings are triage with uncertain outcomes,
  sized for the 19-point rehydration gap, not for C5-sized effects. E2 moves to the 500 for that reason.
- **Token units differ.** gbrain budgets in `cl100k`, the harness in characters divided by four, and the readers in
  their own tokenizers. The budget is sized per benchmark from the maximum per-question ratio, and overruns are
  counted, never silently cut.
- **Long sessions.** When a single session exceeds the budget, C2 delivers a window. BEAM-1M (gbrain strict recall
  18.2%) is the stress case and is out of scope here.
- **Fairness.** Re-running gbrain through a better adapter after seeing the comparison is tuning. Any comparison page
  shows the frozen row and the new row side by side, labeled, and vendor rows are not re-run with tuned settings. A
  shim that dropped a returned date is a harness bug fixed for every system alike.
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
- `receipts/token-ratio-distribution.py` and its output `token-ratio-distribution.txt` (new in v2): the per-question
  ratio of harness tokens to gbrain tokens for each replay configuration, and the provisional `B_bench` values. Run
  from the `receipts/` directory.
- System scores per kind are each arm receipt's `qa_service_score` under
  [`docs/benchmarks/2026-10-06-oss-memory-shootout/results/`](https://github.com/garrytan/gbrain-evals/tree/9c07b7e2f90715593b43d9bdc2a7652174636691/docs/benchmarks/2026-10-06-oss-memory-shootout/results),
  merged across shards, latest lease per cell.
- Earlier evidence: [evidence delivery](../../benchmarks/2026-09-30-evidence-delivery.md) (page 361 against chunk 253
  of 400; ten chunks no better than five), [auto v2](../../benchmarks/2026-09-30-evidence-auto-v2.md) (auto 445
  against chunk 312 of 500 on development data; 24,000-token budget; about 5% of identical requests flip),
  [sealed v2 decision 1](../../benchmarks/2026-10-02-sealed-v2-decision-1.md) (auto 192 against chunk 132 of 200,
  held out, five hits, 24,000 tokens).
- The two CEO reviews: [`reviews/ceo-claude.md`](reviews/ceo-claude.md) and [`reviews/ceo-astra.md`](reviews/ceo-astra.md).

## Review record

Every finding from both CEO reviews, and the change it produced in v2. "Claude n" and "Astra n" are the finding
numbers in each review. Classes are the reviewers' own: Mechanical changes were applied, Taste changes were accepted
under the decision log below, and owner calls went to [Decisions for Garry](#decisions-for-garry).

| Reviewer and finding | Severity | Class | Change in v2 | Where |
|---|---|---|---|---|
| Claude 1 | Critical | Mechanical | The pre-spend gate is an accounting gate; the never-over-budget assertion moves to the C2 variants. | E1, "Before E1 spends anything" 2; guards G3, G4 |
| Astra 1 | High | Mechanical | Same as Claude 1; the budget comes from the per-question maximum, not the mean; a BEAM keyless replay is added. | C0 budget sizing; E1 gate |
| Claude 2 | High | Taste, owner call | The spill is named as documented behavior; the hard cap applies to explicit budgets only and waits on G1; doc, test and CHANGELOG move together. | Diagnosis; C2 "The cap"; G1 |
| Claude 3 | High | Taste | E1 adds `query` at 5 hits. | E1 table |
| Claude 4 | High | Taste | E1 adds `query` at the shipped 24,000 default, labeled as a different budget. | E1 table, reading 5 |
| Claude 5 | High | Taste | C2 becomes a family with `breadth_capped` beside `depth_first`; the multi-session expectation is preregistered and gates held-out. | C2; dev gate; G7 |
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
| Claude 16 | Low | Mechanical | `search.cache_enabled=false` pinned; cache status recorded per row. | C0 call and accounting |
| Claude 17 | Low | Mechanical | Vendor date-fairness check in the E1 preregistration; a dropped field is a harness bug fixed for everyone. | E1 gate 4; risks |
| Claude 18 | Low | Taste | C1 folds into E1: `chunk-dated` uses C1's text header with `valid_from` unset; the separate C1 arms are gone. | C0 `chunk-dated`; C1 |
| Claude 19 | Info | none | Citations verified; no change needed. | Status note |
| Claude, sections 2, 8 and 0I | n/a | Mechanical | Per-row fields (`budget_used`, spill, fallbacks, cache, packer cuts, packed ids); a reranker failure fails the arm; rank one is cut to fit, never dropped. | C0 accounting; C2 minimum unit rule |
| Astra 2 | High | Mechanical | `return_unit: 'auto'` is passed explicitly, because a bare budget selects legacy chunk budgeting; exact call objects preregistered; pre-delivery hit equivalence checked; delivery-only comparisons use one frozen hit list; the bare-budget call is recorded keylessly. | Diagnosis; C0; E1 gate 1; G7 |
| Astra 3 | High | Mechanical, plus User Challenge | The diagnosis now calls the rehydration gain a bundle of six changes until isolated; E1 adds a date-only pair with identical selections; the gap to other systems is no longer called a fact-extraction benefit. The depth-first preference goes to Garry. | In plain words; diagnosis; E1 twin arm; G3 |
| Astra 4 | High | Mechanical | Guards split: C2 compatibility (G1), C1's intentional change (G2), the bundle; upstream ranking invariance separated from delivered coverage (G5); product-token and reader-context caps scoped separately (G3, G4). | Guards |
| Astra 5 | High | Mechanical | The cap covers all delivered output, including non-conversation chunks; minimum unit rule; mixed, notes-only, tiny-budget, missing-date, redaction, source-swamp and both-engine tests; the authorized fetch and protected-body projection are preserved. | C2 "The cap", "Contract tests" |
| Astra 6 | Medium | Taste | `cap_only` and an existing-knob `window` reference join the comparison; the 5-hit arm is in E1; C3 to C5 are conditional, not prerequisites. | C2 variants; E2; C3 |
| Astra 7 | High | Mechanical | C4 split into the saved-facts probe, stage 1 that budgets the existing facts lane, and a production candidate with access-rule tests and a minimum transcript allocation. | C4 |
| Astra 9 | Medium | Mechanical | Costs priced per arm from each envelope (the 24,000 arms separately), cold cache stated; caps are proposals enforced by the ledger; a lifecycle break-even test for C4. | Cost table; C4 lifecycle test |
| Astra 10 | High | Mechanical, partly owner call | Decision-steering E1 readings use `claude-sonnet-5-5`; the four-reader check runs at E2 before held-out; running all four in E1 is G8. | E1 readers; G8 |
| Astra 11 | Medium | Taste | E1 and C4 thresholds are exploratory triage with intervals and an uncertain outcome; a separate cost rule for C4; the candidate family and sweep are fixed before results; one frozen decision goes to held-out. | E1 readings; C4 test; dev gate |
| Astra, "five small improvements" | n/a | Mechanical | Packed ids, upstream against delivered coverage, overrun reasons, a printed resolved-call receipt, cold and warm cost. | C0; guards; cost table |

## Autonomous decision log

Decisions made in writing v2 without Garry, with the reason. Each one is reversible by editing this plan before the
E1 preregistration is committed.

| # | Decision | Class | Source | What v2 does | Reason |
|---|---|---|---|---|---|
| A1 | Accounting gate in place of the cap gate | Mechanical | Claude 1, Astra 1 | Applied | The v1 gate could not pass, and truncating in the adapter would change what the arm measures. |
| A2 | Explicit `return_unit: 'auto'` and preregistered call objects | Mechanical | Astra 2 | Applied | Without it a budget silently selects legacy chunk budgeting. |
| A3 | Add `query-auto-l5-pseudo` | Taste | Claude 3, Astra 6 | Accepted | Cheapest test of "hit count, not algorithm"; the replay shows it already stays in budget. |
| A4 | Add `query-auto-default` on the slice and LoCoMo, not BEAM | Taste | Claude 4 | Accepted, narrowed | The as-shipped row matters most for the comparison page; BEAM is descriptive and rehydration does not help there. |
| A5 | Pseudo-session rendering as E2's primary and the steering rendering in E1 | Taste | Claude 6 | Accepted | It is the shape H1 reads, and it matches the rehydrated reference. |
| A6 | Date-only pair through an undated twin with identical ids, reusing byte-identical prompts | Mechanical | Astra 3 | Applied | A header changes which items fit; reusing identical prompts keeps the twin under $1. |
| A7 | Pseudo-session arms on the slice read with Sonnet only; `rehydrated` read with both readers | Taste | Claude 8, Astra 10 | Accepted | Keeps E1 under $50 while matching reader and rendering for the steering comparison. |
| A8 | Budget sizing from the maximum ratio × 1.02 per benchmark | Mechanical | Claude 11, Astra 1 | Applied | A mean ratio puts about half the slice over the limit; the new receipt shows the distribution. |
| A9 | Reproduction band 4 / 3 / 5 points and 85% agreement | Mechanical | Claude 12 | Applied | Version-to-version drift is 3 to 5 points and identical requests flip about 5%; the band is tighter than drift and looser than noise. |
| A10 | Cache pinned off | Mechanical | Claude 16 | Applied | LoCoMo asks many near-duplicate questions, and a cache hit changes delivery. |
| A11 | Vendor date-fairness check, fix outside E1's budget | Mechanical | Claude 17 | Applied | Symmetry with the gbrain fix, without spending E1's money on vendor reruns. |
| A12 | Fold C1's test into E1 | Taste | Claude 18 | Accepted | One arm serves both; separate C1 arms are removed. |
| A13 | C2 as a family of `cap_only`, `breadth_capped` and `depth_first`, one allocator | Taste | Claude 5, Astra 6 | Accepted | Separates the cap fix from the allocation hypothesis at the smallest code cost; whether depth-first stays preferred is G3. |
| A14 | E2 primary on the LongMemEval-S 500 with Sonnet | Taste | Claude 7, 8 | Accepted; budget is G4 | The slice cannot detect the likely effect; Sonnet matches H1 and the model rule. |
| A15 | Frozen hit list for E2's delivery variants, with a live check per variant | Mechanical | Astra 2, 4 | Applied | Guarantees retrieval invariance and saves four retrievals on the 500. |
| A16 | One guard set for dev and held-out; category guard is one question or 2%, whichever is larger | Mechanical | Astra 4, Claude 5 | Applied | v1's one-question rule was set for 200 questions and is noise on 133-question kinds in the 500; on sealed v2 the two rules agree. |
| A17 | Dev non-inferiority margin 3 points, as H1 | Mechanical | Astra 4 | Applied | v1 used 5 on the slice and 3 on held-out; the 500 supports 3, and one margin is consistent. |
| A18 | No Holm in dev; raw intervals; variant choice by a preregistered rule | Taste | Claude 15, Astra 11 | Accepted | Dev sets nothing; one frozen decision reaches held-out. |
| A19 | Saved-facts probe inside E1 on LoCoMo dev, with a facts token count | Taste | Claude 13, Astra 7 | Accepted | About $3 tells whether C4 is worth its harness work. |
| A20 | "Budgeting the existing facts lane" as C4 stage 1, harness work only | Mechanical | Astra 7 | Applied | The lane cannot test a budget today; adding one reuses the extractor and frozen extraction. |
| A21 | C4 lifecycle break-even test and separate cost rule | Mechanical | Astra 9, 11 | Applied | Quality and cost are different verdicts. |
| A22 | H1 exposure disclosure, pinned hit count and packer, 5-hit reference pair, sample size from dev | Mechanical | Claude 9, 10, Astra 8 | Applied | Required by the protocol, and needed for a matched accuracy-per-token comparison. |
| A23 | H1 budget from the most conservative dev ratio | Mechanical | Claude 11, Astra 8 | Applied | Sealed text cannot be replayed for sizing without reading the set. |
| A24 | Diagnosis wording softened to a presentation bundle | Mechanical | Astra 3 | Applied | The rows do not isolate dates from the other five changes. |
| A25 | Drop order if E1 nears its cap | Mechanical | Astra 9 | Applied | Caps are enforced by the ledger; the order keeps the steering arms. |
| A26 | Add a token-ratio receipt to the plan folder | Mechanical | Claude 11 | Applied | The sizing rule needs committed evidence, computed at $0 from the existing replay outputs. |

## Changelog

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
