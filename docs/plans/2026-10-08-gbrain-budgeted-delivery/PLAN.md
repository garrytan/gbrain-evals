# What gbrain hands the reader under a token budget: plan

Status: draft for Garry's approval. Planning only: no paid call was made and no gbrain or harness code changed. The
diagnosis below comes from the committed shootout rows and a keyless replay ($0, hash vectors, no provider key in the
environment). Written 2026-10-08 against gbrain-evals `f1ce49fe` (main), the shootout results at `9c07b7e2` (branch
`capy/oss-memory-shootout`), and gbrain `c5fb0201` (v0.60.95.0, the shootout's counted master). gbrain master is now
`7aa2caa`; every gbrain file cited here for search, delivery and the `query` operation is byte-identical between the
two, so the line numbers hold for both.

## In plain words

When an agent asks gbrain a question with room for 8,000 tokens of evidence, gbrain finds the right conversations more
often than any other system in the open-source memory comparison, yet the reader answers fewer questions correctly
than with systems that hand over whole sessions or short dated facts. This plan works out why, and what to build.

The short answer has three parts:

1. **Most of the LoCoMo gap and part of the LongMemEval gap come from how the comparison called gbrain.** The
   shootout adapter called gbrain's internal ranking function, not the `query` operation an agent uses. So the reader
   got bare text chunks with no session dates and none of gbrain's evidence delivery. On LoCoMo temporal questions
   gbrain's own retrieval found every needed session 95 times in 100, but the reader answered 25 of 100 from undated
   chunks and 74 of 100 from the same sessions shown whole with their dates.
2. **The rest is a real product gap.** If the adapter had called `query` with an 8,000-token budget, gbrain's `auto`
   delivery would still have handed back mostly chunks, and more tokens than asked. `auto` was designed for a
   24,000-token budget and five hits; at 8,000 tokens and the 25 hits `query` returns by default, it gives each hit
   session a matching chunk first and only then expands whole sessions, and it delivers the sessions that did not fit
   as chunks outside the budget.
3. **Whole sessions are not the ceiling at 8,000 tokens.** With the sessions rehydrated, gbrain reaches 78% on the
   LongMemEval-S slice. Two systems that return extracted facts or observations reach 83% and 89% there, and one
   reaches 76% on LoCoMo with about 950 tokens. Compact, dated evidence packs more answers into a fixed budget.

The plan proposes five gbrain changes, each with a preregistrable test on this harness and a cost from the measured
per-question costs, and one measurement fix that comes first. The recommended first experiment costs about $18 (cap
$30) and settles how much of the gap the measurement fix closes before any gbrain code is written.

## What the shootout measured

The [preregistration](https://github.com/garrytan/gbrain-evals/blob/9c07b7e2f90715593b43d9bdc2a7652174636691/docs/benchmarks/2026-10-06-oss-memory-shootout-preregistration.md)
fixes the arms: one retrieval per question and policy, then either `native` context (the item text the system
returned, in rank order) or `rehydrated` context (the raw sessions behind the items' source ids, whole, in
first-appearance order, shown in date order with dates). The `fixed-evidence` policy packs to 8,000 tokens, counted as
characters divided by four; the packer takes items whole in rank order and the first item that does not fit ends the
pack. Readers are the frozen main readers (`gpt-4o-2024-08-06` on LongMemEval-S, `gpt-4o-mini` on LoCoMo,
`gpt-4.1-mini` on BEAM). Scores below are QA service quality (product failures count as wrong), recomputed from each
arm's `rows.ndjson.gz` and equal to the arm receipt's `qa_service_score`.

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
one rerank call.

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
order.

**No dates.** gbrain renders each session as a conversation page whose date sits in the frontmatter and the title
(`eval/runner/memory-qa/corpus.ts:81-88`); chunk text is the turns only. gbrain's results carry the date as `title`
and `effective_date` (`src/core/types.ts:891`), and the `query` operation keeps both in its lean rows
(`src/core/search/lean-rows.ts:27`). The adapter dropped both, so the harness renderer printed no date for any gbrain
item (`eval/runner/systems/render.ts:46-48` prints one only when `valid_from` is set). The plain-hybrid control and
three of the five vendor shims set `valid_from` on their items.

**No evidence delivery.** gbrain's `return_unit` stage, whose default is `auto` (`src/core/search/evidence-delivery.ts:189`),
runs inside the `query` and `search` operations (`src/core/ops/search.ts:821` builds the plan, `:152` delivers), after
`hybridSearch` returns. Calling `hybridSearch` directly skips it. So `auto`, the delivery default that passed the
sealed v2 release check (192 against 132 of 200), was not in play in any shootout gbrain row.

**What the missing dates and sessions cost, same retrieval, same reader.** Rehydrated against native at 8,000 tokens:

| Benchmark | Rehydrated wins / losses | Wins where all gold sessions were already in the top five | Largest category change |
|---|---:|---:|---|
| LongMemEval-S slice | +25 / −6 | 24 of 25 | spread: knowledge-update +5, preference +5, temporal +3, multi-session +3, single-session-user +3 |
| LoCoMo dev | +90 / −44 | 72 of 90 | temporal 25 → 74 of 100 (95 of 100 had every gold session in the top five) |
| BEAM-100K dev | +19 / −23 | 9 of 19 | temporal 5.5 → 9.5 of 12, others flat or down |

On LoCoMo, against the extract-first system's 76.0%, gbrain is behind by 49 temporal questions and ahead by 10 on
multi-hop and open-domain. The temporal loss alone is about three quarters of the gap. That is dates, not retrieval.

### What gbrain's own `query` would have delivered at 8,000 tokens

The keyless replay (`receipts/keyless-delivery-replay.ts`, outputs and summary beside it) imported each LoCoMo dev
conversation and each LongMemEval-S slice haystack into a fresh brain, ran `hybridSearch` and then the evidence stage
exactly as `query` does (`resolveEvidencePlan`, `effectivePlan`, `deliverEvidence`), with hash vectors and the
reranker off. Hash vectors rank worse than real embeddings, so the replay says nothing about accuracy; it shows what
the delivery stage does with a list of hits.

| LongMemEval-S slice, per question | Shootout chunks | `auto`, 8,000 budget, 25 hits (`query` default) | `auto`, 24,000 (product default), 25 hits | `auto`, 8,000, 5 hits |
|---|---:|---:|---:|---:|
| Blocks delivered | 19.8 chunks | 19.3 | 19.3 | 5.0 |
| Whole sessions among them | 0 | 0.6 | 6.7 | 2.2 |
| Sessions that fell back to chunks | n/a | 4.5 | 0 | 0 |
| Tokens delivered, gbrain's count | n/a | 10,523 (over budget on 100 of 100) | 23,998 | 7,927 |
| Tokens, harness count | 11,710 | 12,086 | 27,598 | 9,127 |

On LoCoMo dev the 8,000-token `auto` call was over budget on all 587 questions (mean 11,430 tokens by gbrain's count),
with 5.9 whole sessions and 6.5 fallen-back chunks per question.

Two product behaviors explain this, both visible in the code and pinned by gbrain's own test:

- **Breadth before depth.** `allocate` first reserves every hit page's matching chunk ("floor") in rank order, then
  expands pages toward whole sessions in rank order (`src/core/search/evidence-delivery.ts:680-735`). With 25 hits
  and 8,000 tokens the floors use the budget, so almost nothing becomes a whole session.
- **The budget is not a cap under `auto`.** A conversation whose floor does not fit is "spilled" to its ranked chunks,
  which are appended after allocation without being counted against the budget (`evidence-delivery.ts:894-898`; the
  test `test/evidence-delivery.test.ts:272-287` asserts the spill and that nothing is dropped). At 24,000 tokens and
  five hits, the setting `auto` was tuned and confirmed on, this almost never fires. At 8,000 tokens it fires on every
  question.

Also measured: gbrain counts delivered text with `cl100k` while the harness counts characters divided by four, and on
LongMemEval-S the harness count runs about 15% higher (27,598 against 23,998). Any adapter that passes gbrain a budget
must leave that margin or the harness packer cuts the last block.

### Diagnosis: adapter or product

Both, in a known proportion per benchmark.

- **Adapter configuration.** The adapter measured gbrain's ranking function, not the agent's read path. It dropped the
  dates gbrain returns and skipped evidence delivery. On LoCoMo the missing dates most likely account for most of the
  gap (temporal 25 against 74 with the same sessions, though rehydration also changes chunks into whole sessions);
  E1's `chunk-dated` arm separates the two. This needs no gbrain change, only a new, separately named adapter
  and a new dated run; the frozen shootout rows stand as measured.
- **Product.** Through `query`, gbrain at 8,000 tokens would still deliver mostly chunks and overrun the budget,
  because `auto` spends a small budget on breadth and does not treat the budget as a cap. The rehydrated arm, which
  is a crude depth-first packer, gains 19 points on LongMemEval-S with the same retrieval. That is the product gap
  worth building against.
- **Beyond whole sessions.** Even rehydrated, gbrain trails the fact- and observation-returning systems on
  LongMemEval-S (78% against 83% and 89%) and is near them on LoCoMo (72.7% against 76.0% and 75.6%). Whole sessions
  of about 2,900 tokens fit only two at a time into 8,000 tokens; the keyless replay shows the rehydrated pack
  averages 2.1 sessions on LongMemEval-S.

## Candidate changes

Each candidate names its mechanism, where it lives, the preregistrable test and its cost. Costs come from the
shootout's measured per-question tokens and the ledger's prices: one 8,000-token arm with the main reader and judge
costs about $2.20 on the LongMemEval-S slice (reader 6,638 input tokens per question at $2.50 per million, plus the
judge), about $1.10 on LoCoMo dev (reader $0.74, judge about $0.35) and about $0.60 on BEAM-100K dev. A gbrain ingest
costs $1.53 on the slice (21,821 embeddings), about $0.02 on LoCoMo dev and $0.11 on BEAM dev; retrieval with the
reranker costs $0.07 to $0.38 per benchmark per policy. Replaying one arm's frozen contexts with the four newest
frontier readers (`claude-opus-5-5`, `gpt-6.1-sol`, `claude-sonnet-5-5`, `claude-fable-5-1`) costs about $20 on the
slice, most of it Fable.

### C0. Measure through the agent's read path (measurement fix, not a product change)

A new adapter, `gbrain-query`, calls gbrain's `query` operation in process (the handler at
`src/core/ops/search.ts:812`, or over MCP stdio as the evidence-delivery study's E3 did) with `expand: false`, so the
only difference from today's adapter is delivery. Items are the delivered blocks: type `page` for a conversation block
and `chunk` otherwise, text prefixed with the title, `valid_from` set from `effective_date`, one source id per block.
Its capability record passes the budget through the `fixed-evidence` settings, as the memory-bank system's record
passes its own `max_tokens: 8000`: `token_budget` = 6,900 (8,000 divided by the measured 1.15 ratio, frozen from the
keyless replay before any paid cell), and no budget under `vendor-default` (the 24,000 default).

A second item mapping, `chunk-dated`, keeps today's `hybridSearch` call and adds only the title and `valid_from`. It
isolates the date effect from the delivery effect.

Both are new named adapters in a new dated run. The shootout's frozen gbrain rows are not edited, and any later
comparison page labels these rows as an adapter revised after seeing the results, on development data.

### C1. Dated evidence blocks in gbrain

**Mechanism.** Every delivered conversation block (and every chunk from a dated page) starts with a one-line date
header built from `effective_date`, so a consumer that renders only the text still sees when the conversation
happened. This is the `query` counterpart of `think`'s date frame (P6 R1), which passed its sealed LoCoMo check
(+14.0 points, temporal 27 → 199 of 221). Today the date is only in separate fields.

**Where.** `deliverEvidence` and the chunk passthrough in `src/core/search/evidence-delivery.ts:899-955`, plus the
plain chunk path's output rows.

**Test.** Dev, same retrieval: `chunk-dated` text-only rendering (header in the text, `valid_from` unset) against
today's chunks. Primary: LoCoMo dev temporal (descriptive, 3 clusters) and LongMemEval-S slice temporal-reasoning. It
can only help readers who ignore fields, so it rides along with C2 rather than claiming a default on its own.

**Cost.** Reader-only arms: about $4 for all three benchmarks per arm.

### C2. Budget-aware conversation packing (the main candidate)

**Mechanism.** Under `auto` with a budget B, treat B as a hard cap and fill it depth first:

1. Pay for non-conversation chunks first, as today.
2. Group conversation hits by session and order sessions by their best hit's rank.
3. Walk the sessions in order. Take a session whole if it fits what is left. If it does not, take the window around
   its matching chunks that fits, if that window is at least one chunk; otherwise skip it and try the next session.
4. Stop when no remaining session's matching chunk fits. Hits that got nothing are reported in `dropped_reasons`,
   never appended outside the budget.

When every hit session fits whole (the 24,000-token default with short sessions), the output is byte-identical to
today's, which is a keyless assertion, not a hope. This replaces `allocate`'s floors-first pass for `auto` only
(`evidence-delivery.ts:680-735` and `:894-898`); `page`, `section` and `window` keep their behavior.

**Why it should work.** Whole sessions beat chunks by 108 of 400 questions in the first evidence-delivery study, ten
chunks in place of five added nothing there, and the harness's own depth-first rehydration gains 19 points on the
slice with the same hits. C2 does the same as the rehydrated arm, plus it does not stop at the first session that is
too long, and it spends the leftover on the next session's matching window.

**Test.** Dev decision (rule below): `gbrain-query` with C2 against `gbrain-query` today, both at the 6,900 budget,
on the slice, LoCoMo dev and BEAM dev; guardrail arms at the default budget; the harness rehydrated arm is reported as
a reference. A budget sweep (8,000 and 16,000 harness tokens) is exploratory and chooses the held-out budget.

**Cost.** Dev run with four arms per benchmark (C2 and baseline at 8,000; both at the default budget): about $9 on
the slice plus $1.70 ingest and retrieval, $5.20 on LoCoMo dev, $2.70 on BEAM dev, and $40 for the frontier replay of
the two 8,000-token arms on the slice. About $58, cap $90. The sweep adds about $8.

### C3. Session-level merge and ranking of chunks

**Mechanism.** Two parts. (a) Session fusion before delivery: score each session from all its chunk hits (for
example best reranker score plus a damped sum of the rest) and rank sessions, not chunks, so a session that matched
three times outranks one that matched once slightly higher. (b) In `chunk` and `window` delivery, merge same-session
hits into one block in document order with one date header, the way conversation delivery already groups by page
(`evidence-delivery.ts:833-845`). Today the per-page cap of two (`dedup.ts:25`) lets the same session take two of the
25 slots as two separate items, each paying for its own title.

**Test.** Retrieval gate first, nearly free: strict recall_all@5 and @10 on the slice, LoCoMo dev and BEAM dev
(BEAM is where gbrain's recall is lowest, 57.4%), session fusion against today's ranking, with a non-inferiority
guardrail of 1 point on the slice and superiority sought on BEAM. QA only if recall moves: one arm per benchmark
under C2.

**Cost.** Retrieval-only runs: about $1.20 (ingest is cached by content; reranks and query embeddings are paid).
QA follow-up about $4 per arm across the three benchmarks.

### C4. Extracted facts as a delivery unit

**Mechanism.** gbrain already extracts dated facts from conversations (`extraction.date_grounding` and
`facts.attribution` are on after P2), stores their embeddings and packs facts first in `recall` under a budget
(`src/core/ops/facts.ts:199-217`). But `recall` selects facts by entity, session or time, and the engine has no
query-ranked fact search (the only fact vector query is write-time dedup, `src/core/facts/similar-active.ts:57-65`).
The candidate adds query-ranked fact retrieval and a mixed unit for `query`: the top facts, each with its date and
source session, first, then C2's whole sessions in what is left. This is the shape of the two systems that lead at
8,000 tokens, and of the extract-first system's 76% on LoCoMo at 953 tokens, which suggests a cost verdict
(same accuracy, fewer tokens) as well as a quality one.

**Test.** The memory-qa facts lane already runs gbrain's production extractor and lets the reader answer from saved
facts (`"facts": "conversation"`, `qa.context: "facts"`). Stage 1: LoCoMo dev and BEAM dev, facts-only at 2,000
tokens and facts-then-sessions at 8,000, against C2 at 8,000. Advance to the slice only if facts-then-sessions beats
C2 by at least 3 points on LoCoMo dev, or facts-only matches C2 within 2 points at a quarter of the tokens.

**Cost.** Extraction is the bill: about $0.02 per LoCoMo session (89 sessions, $1.80), about $15 to $25 for BEAM dev's
486 longer sessions, and about $1 per slice question, $100 per extraction pass on the slice. Stage 1 is about $30
with QA; the slice stage about $110.

**Risk.** Facts drop what they were not asked to keep. Before attribution, saved facts trailed pages by 73 points on
questions about what the assistant said (P2). The mixed unit keeps sessions in the pack for that reason.

### C5. Ordering of the delivered blocks

**Mechanism.** Present the selected blocks in event-time order with dates, as the rehydrated arm does, instead of
rank order; or keep rank order and put the best block last. The harness supports a system that declares
`presentation: event-time` (`render.ts:110-117`).

**Test.** Reader-only arms on identical selections. The likely effect is a few points, below what 100 questions can
detect (about 12 to 18 points at 80% power), so on the slice this is exploratory only. A decisive run needs the full
LongMemEval-S 500 (development data): about $28 for two arms including a fresh ingest.

**Cost.** $4.40 exploratory on the slice; $28 on the 500.

## Recommended first experiment: E1, measure the agent's read path ($0 code in gbrain)

E1 answers the adapter-or-product question with money before anyone builds C2. It needs only the C0 adapters in
gbrain-evals, at the frozen gbrain `c5fb0201`, so the paired comparison with the shootout rows is clean.

| Arm | What the reader gets | Question it answers |
|---|---|---|
| `shootout-chunk` | today's adapter (reproduces 59.0% / 64.9% / 60.5%) | run-to-run link to the frozen rows |
| `chunk-dated` | the same chunks with title and date | how much is the missing date |
| `query-auto` | `query` with `auto` at a 6,900 budget | what gbrain's current product delivers at 8,000 harness tokens |
| `rehydrated` | the harness's whole sessions from the `shootout-chunk` hits | the depth-first reference, reproduces 78.0% / 72.7% / 59.4% |

All four share one ingest and the two retrievals (the `hybridSearch` call and the `query` call) per question, with
the main readers and judges of the shootout. Sets: the LongMemEval-S slice (inferential, question-clustered),
LoCoMo dev and BEAM-100K dev (descriptive).

Preregistered readings, written before the run:

- `chunk-dated` minus `shootout-chunk` on LoCoMo temporal is the date effect. If it recovers at least half of the
  25 → 74 temporal gap, the LoCoMo shortfall is an adapter finding and the comparison page says so.
- `query-auto` minus `shootout-chunk` on the slice is what today's product adds at 8,000 tokens. The keyless replay
  predicts little (0.6 whole sessions per question).
- `rehydrated` minus `query-auto` on the slice is the product gap C2 targets. If it is under 5 points, C2 is
  deprioritized and C4 moves up.

**Cost.** Slice: 4 arms at about $2.20, ingest and two retrievals about $1.70, so about $10.50. LoCoMo dev: about
$5.20. BEAM-100K dev: about $2.70. **About $18.40, cap $30**, no frontier replay (E1 is a measurement, not a product
decision). Wall time is about two hours on one VM. Keys: `OPENAI_API_KEY` and `VOYAGE_API_KEY` (the reranker).

Before E1 spends anything: commit the two adapters with keyless tests (byte-identical `shootout-chunk` retrieval
against the golden; `query-auto` delivered tokens never above 8,000 by the harness count on the keyless replay), and
freeze the 6,900 budget and this table in a preregistration.

## Order of work after E1

1. **E2, C2 with C1 (dev verdict).** About $58, cap $90. Built on a gbrain branch behind a config key
   (`search.auto_packing=depth_first`), measured through `gbrain-query`.
2. **E3, C3 retrieval gate.** About $1.20, run alongside E2. QA only if recall moves.
3. **E4, C4 stage 1** after E2, because its baseline is C2. About $30; the slice stage ($110) needs its own approval.
4. **E5, C5 ordering**, exploratory on the slice ($4.40) folded into E2's run.
5. **H1, held-out decision** for whichever of C2 (with C1) and C4 passes dev, on sealed confirmation set v2.

Total through E4 stage 1 and H1, with the sweep and E5: about $205 expected, cap $300. The LongMemEval-S 500 runs and the C4 slice stage
are separate approvals.

## Decision rule for turning a change on by default

This follows [docs/decisions.md](../../decisions.md): dev verdicts guide the work and never set a default; only a
held-out win turns a feature on, and the held-out set is opened once by the custodian after the comparison is
preregistered. It borrows the bars the held-out program used for P6 and the sealed v2 decision 1.

**Dev gate (per candidate, `decision.json` committed before any paid cell, verdict type `quality`, or `cost` for
C4's facts-only arm):**

- Primary, superiority: on the LongMemEval-S slice at 8,000 harness tokens, QA service quality with the main reader,
  candidate against today's `gbrain-query` at the same gbrain base commit. Rows paired by question after the
  cross-arm exclusion join, question clusters, cluster bootstrap with 10,000 draws, two-sided sign-flip p, Holm across
  every candidate in the family. The slice detects about 12 to 18 points at 80% power; a smaller true effect reads
  `inconclusive`, which is not a loss.
- Guardrails: (1) exact: at the default budget, delivered bytes identical to today's whenever today's delivery cut
  nothing, checked keyless on the slice and LoCoMo dev; (2) exact: delivered tokens never above the budget by the
  harness count, every question; (3) non-inferiority at the default budget on the slice, tolerance 5 points; (4) no
  LongMemEval-S category down by more than one question; (5) strict recall_all@5 identical for delivery-only changes,
  non-inferior within 1 point for C3; (6) `query` p95 latency within +20%.
- Descriptive, not decisive: LoCoMo dev and BEAM-100K dev category tables. A loss of more than 3 points on either
  stops the candidate for review before any held-out request.
- Reader check: the four frontier readers replay the primary pair's frozen contexts. A candidate whose gain changes
  sign under two or more of the four does not go to held-out, so no default rests on one older reader.

**Held-out decision (H1):**

- Material: [sealed confirmation set v2](../../benchmarks/2026-10-01-sealed-confirmation-v2-protocol.md), 200 questions
  over 40 invented personas with about 3,100-token chats, two of three openings left. It was built for delivery
  questions and its chunk baseline is far from ceiling (66%). Not eligible: LoCoMo sealed (7 conversations, below the
  10-cluster minimum, "never a primary confirmation" in its split file, already used by P6, P2 E2, P3 E1 and the
  shootout's Phase 7) and BEAM-100K sealed (used by the P4 core gate and Phase 7). LongMemEval-S has no sealed split.
- Arms: candidate and current default at the budget dev chose (8,000 harness tokens unless the sweep says otherwise),
  and both at the product default budget. The default-budget pair is first checked for byte identity on the frozen
  evidence before any label is read; if identical, it is reported as exact and costs no reader calls.
- Pass: superiority at the tight budget with a persona-clustered 95% interval above zero and exact McNemar p below
  0.05; non-inferiority at the default budget with a 3-point margin (as in decision 1) unless shown exact; no question
  kind down by more than one question; abstention not worse.
- Reader: `claude-sonnet-5-5` as primary, the other three frontier readers on the same frozen contexts, disclosed.
- Records: the frozen build SHA, `decision.json`, the dev and held-out verdicts committed under
  `docs/eval/decisions/<decision-id>/` in the gbrain pull request, as decisions.md describes.
- Cost: about $85 (retrieval freeze $3.70 as measured in decision 1, Sonnet arms about $20, judges about $2, frontier
  replay of the tight-budget pair about $60), cap $120.

One opening tests C2 with C1 as one bundle. The last opening stays in reserve for C4 or a later default-budget change.
Changing the default budget itself (24,000) is a separate decision and is not part of this plan.

## Risks and limits

- **LongMemEval-S is development data.** gbrain's release configuration was chosen on it, so slice results guide
  work; only H1 sets a default.
- **The slice is small.** 100 questions detect only large effects. E1 and E2 are sized for the 19-point rehydration
  gap, not for C5-sized effects.
- **Token units differ.** gbrain budgets in `cl100k`, the harness in characters divided by four, and the readers in
  their own tokenizers. The 1.15 ratio is measured on LongMemEval-S; LoCoMo runs about 1.02. The adapter's budget is
  frozen per benchmark from the keyless replay, and overruns are counted, never silently cut.
- **Long sessions.** When a single session exceeds the budget, C2 delivers a window. BEAM-1M (gbrain strict recall
  18.2%) is the stress case and is out of scope here.
- **Fairness.** Re-running gbrain through a better adapter after seeing the comparison is tuning. Any comparison page
  shows the frozen row and the new row side by side, labeled, and vendor rows are not re-run with tuned settings.
- **Fact extraction cost and coverage.** C4 adds about $1 per LongMemEval-S haystack at ingest and can drop
  assistant-side detail; it stays opt-in until its own held-out pass.

## Receipts for the diagnosis

- `receipts/gbrain-rows-profile.py` and its output `gbrain-rows-profile.txt`: the gbrain row profile (items, tokens
  per item, estimated 8,000-token pack, native against rehydrated flips by category), from the committed rows at
  `9c07b7e2`.
- `receipts/keyless-delivery-replay.ts`, `keyless-delivery-summary.py`, the per-question outputs
  `keyless-replay-lme-s-100.json.gz` and `keyless-replay-locomo-dev.json.gz`, and `keyless-delivery-summary.txt`:
  the $0 replay of `hybridSearch` plus the `query` evidence stage, run at gbrain master `7aa2caa` (its search and
  delivery files match `c5fb0201`; some keyword and vector-scan files changed, which do not affect delivery). Hash
  vectors, reranker off, no provider key present.
- System scores per kind are each arm receipt's `qa_service_score` under
  [`docs/benchmarks/2026-10-06-oss-memory-shootout/results/`](https://github.com/garrytan/gbrain-evals/tree/9c07b7e2f90715593b43d9bdc2a7652174636691/docs/benchmarks/2026-10-06-oss-memory-shootout/results),
  merged across shards, latest lease per cell.
- Earlier evidence: [evidence delivery](../../benchmarks/2026-09-30-evidence-delivery.md) (page 361 against chunk 253
  of 400; ten chunks no better than five), [auto v2](../../benchmarks/2026-09-30-evidence-auto-v2.md) (auto 445
  against chunk 312 of 500 on development data; 24,000-token budget), [sealed v2 decision 1](../../benchmarks/2026-10-02-sealed-v2-decision-1.md)
  (auto 192 against chunk 132 of 200, held out).

## Changelog

### 2026-10-08: first draft

Diagnosis from the shootout rows and a keyless replay; candidates C0 to C5 with tests and costs; E1 recommended at
about $18 (cap $30); decision rule with the dev gate and the held-out decision on sealed confirmation set v2.
