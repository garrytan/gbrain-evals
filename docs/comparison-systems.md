# Comparison Systems — published numbers we benchmark against

Living list of memory / agentic-retrieval systems that publish numbers on
benchmarks gbrain runs. Update when a system publishes a new result, even
if it's not on a benchmark we currently run — the data informs which
benchmark we should add.

Format: the numbers tables are neutral and cited. The **"vs gbrain"** analysis
under each table is explicitly our read — what gbrain's latest pinned master
(v0.47.8.0, `2a56b512`) does architecturally, and why that wins or loses
against each system, with the mechanism named. Where gbrain loses, the loss
and the reason stay in.

What gbrain master ships, for reference in the analyses below: hybrid
retrieval (Postgres/PGLite FTS keyword arm + provider-configurable embeddings,
fused by RRF), a source-boost layer that ranks curated directories above bulk
ingest, a typed knowledge graph with traversal, optional Haiku query
expansion, optional cross-encoder reranking (off by default), opt-in adaptive
return-sizing for precision-shaped questions, and — unlike everything else on
this page — a measured write path (the dream distiller, scored by Cat 35) and
an unprompted-recall reflex (scored by Cat 34). No LLM is required anywhere in
the default retrieval loop.

## LongMemEval (`xiaowu0162/longmemeval` `_s` split, 500 questions)

Metric column key (corrected 2026-08-31; resolved same day): **R@k** =
session-level retrieval recall. The OFFICIAL LongMemEval evaluator computes
`recall_all@k` — ALL of a question's ground-truth sessions must land in
top-k — and that is what systems using the published evaluator report. The
gbrain 97.6% was measured with a looser ANY-HIT variant (≥1 ground-truth
session in top-k); the erratum is now RESOLVED from the original run's raw
rows: **83.40% official `recall_all@5`** (n=470, `_abs` excluded) alongside
the exactly-reconciled 97.60% any-hit. VARIANT STATUS (updated 2026-09-01):
MemPalace's 96.6% is now settled as ANY-HIT. The independent critical
analysis ([arXiv 2604.21284](https://arxiv.org/abs/2604.21284), Dey &
Viradecha) states verbatim: "The 96.6% figure—the most widely cited—is
recall_any@5: at least one of the five returned results contains the
correct answer session." The remaining competitor rows still don't state
their variant; treat any cross-variant reading as non-comparable in both
directions. ContextFit publishes BOTH variants (All@ and Any@) but on their
own scoring implementation and a "cleaned" dataset revision, not the
official evaluator — see the caveat under their rows. **QA-acc** =
end-to-end answer accuracy via an LLM judge. **Different metrics, never
directly comparable.**

| System | Headline | Metric | k | n | LLM in loop | Source |
|---|---|---|---|---|---|---|
| MemPal hybrid v4 + Haiku rerank | 100% | R@5 | 5 | 500 | yes (Haiku) | [BENCHMARKS.md](https://github.com/MemPalace/mempalace/blob/main/benchmarks/BENCHMARKS.md) — tuned on 3 specific failing Qs |
| MemPal hybrid v4 + Haiku, held-out | 98.4% | R@5 | 5 | 450 | yes (Haiku) | held-out generalisable figure |
| MemPal raw (ChromaDB) | 96.6% | R@5 (**any-hit**, per [arXiv 2604.21284](https://arxiv.org/abs/2604.21284)) | 5 | 500 | none | their public-facing headline |
| ContextFit token-native + evidence certificates | 84.3% All@5 / 96.8% Any@5 | All@ + Any@ (their harness, "cleaned" dataset) | 5 | 470 | none (no vector DB) | [whitepaper](https://www.context.fit/whitepaper.html), accessed 2026-09-01 |
| ContextFit + OpenAI embedding fusion | 87.45% All@5 / 98.3% Any@5 (98.94% route-gated) / 99.2% Any@10 | All@ + Any@ (their harness, "cleaned" dataset) | 5 / 10 | 470 | none (embeddings as fusion signal, no LLM call) | [whitepaper](https://www.context.fit/whitepaper.html), accessed 2026-09-01; May 2026 artifact in [issue #10](https://github.com/garrytan/gbrain-evals/issues/10) |
| Lethe v1 | 93.8% overall | R@5, "gold session in top-k" (any-hit-shaped; `recall_all` unstated) | 5 | 500 (no abstention exclusion) | none | [arXiv 2606.15903](https://arxiv.org/abs/2606.15903), Appendix Q Table 16 |
| Stella | ~85% | R@5 | 5 | 500 | none | academic dense retriever |
| Contriever | ~78% | R@5 | 5 | 500 | none | academic dense retriever |
| BM25 (sparse) | ~70% | R@5 | 5 | 500 | none | published baseline in the LongMemEval paper |
| Mastra | 94.87% | QA-acc (NOT R@k) | n/a | 500 | yes (GPT-5-mini) | [mastra.ai/research/observational-memory](https://mastra.ai/research/observational-memory) |
| Supermemory ASMR | ~99% | QA-acc (NOT R@k) | n/a | 500 | yes (Gemini-2/GPT-4o ensemble) | [their ASMR post](https://supermemory.ai/blog/we-broke-the-frontier-in-agent-memory-introducing-99-sota-memory-system/) — authors flag it as experimental, not production |
| Memoria (MatrixOrigin) | 88.78% (best reader) | QA-acc (NOT R@k) | n/a (10 memories/Q) | 499 (1 timeout) | yes (reader claude-opus-4.6, judge GPT-5.4) | [their post](https://medium.com/@matrixorigin-database/benchmarking-memoria-on-longmemeval-strong-memory-retrieval-clear-reader-separation-ee6c89c75d76) ([mirror](https://dev.to/origin_matrix_b790e656217/benchmarking-memoria-on-longmemeval-strong-memory-retrieval-clear-reader-separation-435b)) |
| Mem0 (April 2026 algorithm) | 88.0-98.6% per type | QA-acc (NOT R@k), GPT-4o judge | n/a | not stated | yes | [mem0.ai blog, 2026-05-11](https://mem0.ai/blog/ai-memory-benchmarks-in-2026); no overall figure in the body, see note |
| ContextFit fusion QA | 84.8% overall / 86.81% task-averaged | QA-acc (NOT R@k), their pipeline | n/a | 500 | yes (GPT-4o generation + GPT-4o judge) | [their QA note](https://www.context.fit/longmemeval-fusion-qa-20260519.html), reported in [issue #10](https://github.com/garrytan/gbrain-evals/issues/10) |

gbrain's own rows — any-hit: 97.6% hybrid / 97.4% vector / 19.8% keyword;
official `recall_all@5` (erratum resolved 2026-08-31 from the same raw
rows): **83.4% hybrid / 84.3% hybrid+expansion / 79.4% vector / 10.6%
keyword** — live in the
[2026-05-07 report + resolution](benchmarks/2026-05-07-longmemeval-s.md).

**Important reading note:** Mastra, Supermemory, Memoria, Mem0, and the
ContextFit QA row are end-to-end QA accuracy (does the system produce the
right answer string, judged by an LLM). MemPal, ContextFit's retrieval
rows, Lethe, and the gbrain numbers in this table are retrieval recall
(does the right session land in top-k). A system can have 100% retrieval
recall and 60% QA accuracy if its answer model is bad, and vice versa.
Don't compare them head-to-head without naming the gap.

**ContextFit comparability caveat (their rows above):** the numbers come
from ContextFit's own pipeline and scoring implementation on a dataset they
label "LongMemEval-S cleaned" (their revision), not the official evaluator
on the unmodified split and not our harness. Their May 2026 artifact
([issue #10](https://github.com/garrytan/gbrain-evals/issues/10)) reported
All@5 83.62% / All@10 91.28% / Any@5 96.60% / Any@10 98.72% / MRR 0.8999
(n=470, 30 abstentions excluded, the same denominator convention as gbrain's
resolved numbers); the whitepaper as of 2026-09-01 shows the newer
84.3%/87.45% All@5 figures above. Same ballpark as gbrain's official
`recall_all@5`, not the same instrument.

### vs gbrain (master, v0.47.8.0), row by row

- **MemPal hybrid v4 + Haiku rerank (100% / 98.4% held-out) — gbrain loses
  on raw score, on purpose.** MemPal runs a Haiku cross-encoder pass over
  every query's candidates; that stage genuinely rescues the last points of
  recall (their held-out 98.4% vs raw 96.6% shows the rerank is worth ~2
  points). gbrain ships reranking OFF by default and scores 97.6% (any-hit)
  on embeddings + keywords + RRF alone — within 0.8 points of the held-out
  reranked figure with zero LLM calls, deterministic results, and ~$0.50 per
  1,000 questions instead of a model invocation per query. The tradeoff is
  explicit: if you want the last point of recall and will pay per-query
  LLM latency for it, MemPal's architecture buys it; gbrain treats the
  retrieval loop as infrastructure that must be cheap, fast, and
  reproducible. (Their 100% row is tuned on the 3 failing questions —
  their own caveat — so 98.4% is the honest comparison target.)
- **MemPal raw ChromaDB (96.6%, any-hit) — gbrain wins, now on a settled
  same-variant comparison (97.66% vs 96.6%, both any-hit per
  [arXiv 2604.21284](https://arxiv.org/abs/2604.21284)), and the mechanism
  is the keyword arm.** A pure vector store misses questions whose evidence hinges
  on exact tokens embeddings blur together: names, handles, dates, numbers.
  gbrain's FTS arm catches those and RRF promotes them; that fusion is the
  measured 0.2-1.0 point edge over vector-only on this dataset (gbrain's own
  vector-only adapter scores 97.4% vs hybrid 97.6% — the report's per-type
  table shows the lift concentrated in multi-session questions).
- **ContextFit (84.3% All@5 token-native / 87.45% fused; 96.8-98.94% Any@5)
  — the closest published `recall_all`-comparable rows, currently at or
  above gbrain's, with caveats that cut both ways.** gbrain's official
  `recall_all@5` is 83.40% (hybrid) / 84.26% (+expansion) on the unmodified
  public split scored by our audited aggregator; ContextFit self-reported
  83.62% All@5 in the May artifact and shows 84.3% token-only / 87.45%
  fused in the current whitepaper (their scoring, their "cleaned" dataset
  revision, their pipeline). We don't claim a `recall_all` lead, and we
  don't concede one either: same ballpark, different instrument.
  Mechanism: a token-native index with no vector database, an
  evidence-certificate rerank stage, and OpenAI `text-embedding-3-small`
  as an optional fusion signal; no LLM call in the loop, the same class
  as gbrain hybrid. The Any→All collapse is similar in both systems
  (their May artifact: 96.60 → 83.62, -12.98pp; gbrain: 97.66 → 83.40,
  -14.26pp): multi-session evidence sets are where everyone bleeds. The
  row to watch is multi-session All@5, where their whitepaper reports
  65.3% token-only / 72.7% fused vs gbrain's 71.9%.
- **Lethe v1 (93.8% R@5) — gbrain leads by ~3.9pp on the comparable
  any-hit reading, with an embedder-size asterisk.** Lethe's stack is
  BM25 (FTS5) + MiniLM-L6-v2 dense + RRF on a single CPU: architecturally
  gbrain-hybrid's sibling with a 384-dim local embedder instead of
  `text-embedding-3-large@1536`. Their metric is "fraction of questions
  where the gold session is in the top-k" (singular), i.e. any-hit-shaped:
  read 93.8% against gbrain's 97.66% any-hit, not against 83.40%
  `recall_all`. Per-type R@5 (Appendix Q, Table 16): knowledge-update
  0.987, multi-session 0.940, single-session-assistant 0.964,
  single-session-preference 0.900, single-session-user 0.900,
  temporal-reasoning 0.925; R@1 0.796, R@10 0.982. Denominator note:
  their n=500 keeps the 30 abstention questions; gbrain's resolved
  numbers use n=470. Most of the gap between 93.8 and 97.66 is embedder
  quality; the fact that a CPU-only MiniLM stack gets within 4 points is
  the honest takeaway for builders who can't ship OpenAI embeddings.
- **Stella (~85%) / Contriever (~78%) — gbrain wins on embedder quality
  plus fusion.** These are single-model academic dense retrievers: no
  keyword arm, no fusion, older embedding models. gbrain's margin here is
  mostly text-embedding-3-large being a stronger encoder, with hybrid
  fusion on top. Fair caveat: they're research baselines, not products.
- **BM25 (~70%) — gbrain wins for the mirror-image reason, and our own data
  proves the point twice.** Conversational memory is paraphrase-heavy; the
  question's words rarely match the answer session's words, so sparse
  keyword retrieval alone caps out low. Notably gbrain's own keyword-only
  adapter scores just 19.8% at K=5 on this dataset — worse than the paper's
  BM25 baseline (different chunking granularity) — which is exactly why
  gbrain never ships keyword-only: the arm earns its keep only inside the
  fusion.
- **Mastra (94.87% QA-acc) — not better or worse; measuring a different
  thing.** Mastra publishes end-to-end answer accuracy with GPT-5-mini in
  the loop, so their number blends memory quality with answer-model
  quality. gbrain deliberately publishes retrieval recall in isolation so
  the memory layer's contribution is auditable on its own; we don't have a
  comparable QA-acc number yet (TODOS.md). Until one side publishes the
  other's metric, no win/loss claim is honest here.
- **Supermemory ASMR (~99% QA-acc) — same metric gap, plus a write-path
  asterisk.** An experimental multi-model ensemble (their own flag: not
  production) scoring QA accuracy, not retrieval. Worth reading next to
  their HaluMem extraction recall of 41.5% (table below): a striking
  read-path number can coexist with losing more than half the salient
  content at write time. gbrain's position is that the write path is where
  memory systems actually die, which is why Cat 35 exists.
- **Memoria (88.78% QA-acc) — different metric, no win/loss claim; the
  design is the interesting part.** MatrixOrigin froze one Memoria
  retrieval snapshot (10 memories per question) and ran three readers over
  the identical retrieved context: claude-opus-4.6 scored 88.78%, GPT-5.4
  84.97%, claude-sonnet-4.5 70.74% (n=499, one timeout). An 18-point
  spread on frozen retrieval is reader quality, not memory quality; it is
  the cleanest public demonstration of why gbrain publishes retrieval recall
  in isolation instead of blending it into a QA number. They publish no
  retrieval-only recall figure, so there is nothing to line up against
  gbrain's R@5 rows.
- **Mem0 April-2026 algorithm (per-type QA-acc: single-session-user 98.6,
  single-session-assistant 98.2, knowledge-update 93.6, multi-session
  88.0) — different metric, not directly comparable.** GPT-4o-judged
  answer accuracy through Mem0's own pipeline. Sourcing note: the page's
  meta headline says 94.4% overall, but the article body never states an
  overall figure, so we cite only the per-type numbers the body supports.
  Directionally their weakest row (multi-session 88.0 QA-acc) is the same
  question type where gbrain's `recall_all@5` drops to 71.9%: multi-session
  evidence is the shared open problem, measured on different axes.
- **ContextFit fusion QA (84.8%) — context row, their pipeline end to
  end.** ContextFit retrieval → GPT-4o source-aware generation → GPT-4o
  judging. Sits below Mastra's 94.87% QA-acc, which mostly says the two
  pipelines made different generation/judging choices; neither ran the
  other's retrieval. No gbrain QA-acc number exists yet (TODOS.md), so no
  claim in either direction.

## ConvoMem (Salesforce, 75K+ QA pairs)

| System | Score | Notes |
|---|---|---|
| MemPal | 92.9% | verbatim text + semantic search |
| Gemini (long context) | 70-82% | full history in context window |
| Block extraction | 57-71% | LLM-processed blocks |

We don't run ConvoMem yet. Filed as a follow-up.

### vs gbrain (master, v0.47.8.0)

- **gbrain has no number here, so no win/loss claim — that's the honest
  status.** Mechanically, gbrain's verbatim-FTS + semantic fusion is the
  same architecture class as MemPal's 92.9% row, so we'd expect that
  neighborhood, but expectations aren't results. The blocker is scale
  (75K+ QA pairs of judged evaluation), not architecture; it's on the
  follow-up list.
- **Gemini long-context (70-82%) — the whole-history-in-context approach
  gbrain exists to replace.** Stuffing the full history into a context
  window degrades recall as the haystack grows (that's the 70-82 spread)
  and costs per-token on every single query forever. gbrain's answer is an
  index you query, not a context you re-read: retrieval cost stays flat as
  the brain grows.
- **Block extraction (57-71%) — the failure mode gbrain's write path is
  measured against.** Pre-digesting history into LLM-summarized blocks
  loses the details questions later need — the same lossy-extraction
  problem HaluMem quantifies (below). gbrain also distills (the dream
  pass), but it's the only system that publishes what fraction survives,
  and its distiller is gated on that number (Cat 35: 61.5% → fix wave →
  88.1%).

## LoCoMo (1,986 multi-hop QA pairs)

| System / mode | R@10 | Notes |
|---|---|---|
| MemPal hybrid v5 + Sonnet rerank | 100% | "structurally guaranteed (top-k > sessions)" — needs caveat |
| MemPal bge-large + Haiku rerank | 96.3% | top-15, R@10 |
| Memori | 81.95% | published baseline |
| MemPal hybrid v5 (no rerank) | 88.9% | top-10 |

We don't run LoCoMo yet. Filed as a follow-up.

### vs gbrain (master, v0.47.8.0)

- **No gbrain number, no claim.** Two mechanism notes for when we run it:
  MemPal's 100% row is structurally guaranteed (top-k exceeds the session
  count, so recall can't miss) — a caveat their own page half-raises; the
  informative rows are 88.9% unreranked vs 96.3% reranked, the same
  ~LLM-rerank-buys-points shape as LongMemEval. LoCoMo is multi-hop, which
  is the question shape gbrain's typed graph traversal is built for (it's
  worth ~30 points of precision over plain vector on our relational
  benchmark) — that makes LoCoMo the most interesting unrun benchmark on
  this page for gbrain specifically.
- **Memori (81.95%) — no direct comparison until we run it**; it's the
  published non-reranked baseline the field measures against here.

## Write-path / memory-extraction benchmarks (HaluMem)

HaluMem ([arXiv 2511.03506](https://arxiv.org/abs/2511.03506), 2025) is the
only published benchmark that scores the WRITE path of memory systems —
extraction recall of gold memory points from synthetic persona conversations,
scored FULL/PARTIAL/OMITTED at 1/0.5/0. Different corpus and task shape from
our Cat 35 (persona chit-chat vs agent working sessions; memory points vs a
distilled page artifact) — **context rows, not directly comparable.**

| System | Extraction recall | Corpus | Source |
|---|---|---|---|
| Mem0 | 42.9% | HaluMem-Medium (Table 3) | arXiv 2511.03506 |
| Supermemory | 41.5% | HaluMem-Medium (Table 3) | arXiv 2511.03506 |

Reading note: the same products report 90%+ on read-path QA benchmarks
(Mem0 self-reports 92.5% LLM-judged accuracy on LoCoMo, arXiv 2504.19413).
The write path is where extraction quality actually lives; nobody publishes
it voluntarily. Cat 35 (transcript → brain-page distillation fidelity) is
gbrain's write-path benchmark; SummHay ([arXiv 2407.01370](https://arxiv.org/abs/2407.01370),
human ceiling 56.1 joint score) is the planted-gold protocol ancestor.

### vs gbrain (master, v0.47.8.0)

- **Mem0 (42.9%) / Supermemory (41.5%) — gbrain's comparable-in-spirit
  number is 88.1% salient-unit survival, but on a different corpus and
  task, so treat the gap as directional, not a scoreboard.** The honest
  mechanism story: Mem0/Supermemory extract memory points as a side effect
  of the chat loop; gbrain's dream distiller is a dedicated synthesis pass
  whose output is measured against planted gold (173 salient units with
  verbatim anchors, 86 distractors) and gated in CI — when the first run
  scored 61.5% with 4 sessions producing no page, gbrain shipped a fix wave
  aimed at those specific failures and the re-run hit 88.1% with 1.2%
  distractor leakage (1/86; the zero-leakage figure belongs to the
  superseded 61.5% run). The reason to believe the number: the benchmark can
  fail, has failed, and forced fixes. What would make this row rigorous:
  running gbrain's distiller on HaluMem-Medium itself (their corpus, their
  scoring) — filed as the natural follow-up when we take on ConvoMem/LoCoMo.

## PrecisionMemBench (tenurehq, precision-only; 77 single-turn + 12 session cases)

Source: the [tenurehq/precisionmembench](https://github.com/tenurehq/precisionmembench)
README results tables (accessed 2026-09-01). Our full run:
[2026-05-29 report](benchmarks/2026-05-29-precisionmembench.md). The gbrain
rows carry the audit caveat from that report: the harness originally leaked
the fixture's `superseded_by` answer key into seed time; the leak is removed,
the hermetic keyword mode re-measured 0.1389 → 0.1361 on the fixed harness,
and the hybrid/adaptive/think rows are **upper bounds pending a keyed
re-run**.

| System | Mean precision (single-turn) | p50 | Source |
|---|---|---|---|
| tenure (author's belief store) | 1.00 | 9.8ms | [upstream README](https://github.com/tenurehq/precisionmembench), accessed 2026-09-01 |
| **gbrain adaptive (tight)** | **0.582** (upper bound, pending re-run on the fixed harness) | ~270ms | [our report](benchmarks/2026-05-29-precisionmembench.md) |
| supermemory | 0.22 | 69ms | upstream README, accessed 2026-09-01 |
| yourmemory / agentmemory | 0.17 | 313ms / 82ms | upstream README, accessed 2026-09-01 |
| atomicmemory | 0.15 | 71ms | upstream README, accessed 2026-09-01 |
| gbrain (author's own integration) | 0.14 | 544ms | upstream README, accessed 2026-09-01; see note below |
| zep | 0.09 | 124ms | upstream README, accessed 2026-09-01 |
| vector baseline | 0.09 | 72ms | upstream README, accessed 2026-09-01 |
| **gbrain default hybrid** | **0.075** | ~270ms | [our report](benchmarks/2026-05-29-precisionmembench.md) |
| mem0 | 0.06 | 65ms | upstream README, accessed 2026-09-01 |

Sourcing notes:

- **The supermemory 0.43 @ 819ms row in our May report does not appear in
  the current upstream README** (their single-turn table shows supermemory
  at 0.22 @ 69ms). The 0.43 pair is the leaderboard revision our May run
  compared against; it stays in the report as the historical comparison and
  is unsourced upstream as of 2026-09-01. The mem0 (0.06) and zep (0.09)
  rows our report quotes DO match the current upstream table.
- **The upstream README now carries its own gbrain row**: 0.14 precision at
  0.17 recall, measured by the benchmark author's integration. It matches
  no mode in our report (our default hybrid measures 0.075 precision at
  0.99 recall). A precision of 0.14 alongside 0.17 recall says the
  integrations differ materially; flagged, not yet reconciled.

### vs gbrain (master, v0.47.8.0)

- **tenure (1.00) — gbrain loses, expected and disclosed.** The author's
  belief store is purpose-built for exactly this benchmark's shape
  (single-belief lookups with supersession chains). gbrain's 0.582
  adaptive mode is the general-purpose runner-up, and even that number is
  an upper bound until the fixed-harness re-run.
- **supermemory / mem0 / zep (0.22 / 0.06 / 0.09) — gbrain's adaptive mode
  clears the general-purpose field at its measured upper bound**, and the
  default-hybrid 0.075 lands inside the same cluster, which is the honest
  cost of shipping a recall-first default (recall 0.99 on this benchmark).
  Mechanism: opt-in adaptive return-sizing trims the returned set when the
  question wants one answer; the default never misses but buries.

## Sources we've checked (so we don't redo the lookup)

- [`MemPalace/mempalace/benchmarks/BENCHMARKS.md`](https://github.com/MemPalace/mempalace/blob/main/benchmarks/BENCHMARKS.md) — most thorough public benchmark page in this category. They credit competitors fairly and call out their own tuning caveats.
- [`mastra.ai/research/observational-memory`](https://mastra.ai/research/observational-memory) — observational-memory framework, QA accuracy.
- [`supermemory.ai/blog/we-broke-the-frontier-in-agent-memory-introducing-99-sota-memory-system/`](https://supermemory.ai/blog/we-broke-the-frontier-in-agent-memory-introducing-99-sota-memory-system/) — Supermemory ASMR. Experimental ensemble, not production.
- [LongMemEval HuggingFace](https://huggingface.co/datasets/xiaowu0162/longmemeval) — the dataset itself. Three splits: `_oracle` (15MB, ~3 sessions per Q), `_s` (278MB, ~50 sessions per Q), `_m` (2.7GB, more distractors).
- [HaluMem, arXiv 2511.03506](https://arxiv.org/abs/2511.03506) — the only external write-path benchmark; Table 3 carries the Mem0/Supermemory extraction rows.
- [ContextFit whitepaper](https://www.context.fit/whitepaper.html) (accessed 2026-09-01) — current All@/Any@ numbers (84.3% All@5 token-native + certificates, 87.45% All@5 fused, 98.94% Any@5 route-gated). Their May 2026 artifact (All@5 83.62 / Any@5 96.60 / MRR 0.8999) and QA artifact (84.8%) are in [gbrain-evals issue #10](https://github.com/garrytan/gbrain-evals/issues/10) with repro links and SHA-256s; their pipeline and dataset revision, not ours.
- [arXiv 2604.21284](https://arxiv.org/abs/2604.21284) — "Spatial Metaphors for LLM Memory: A Critical Analysis of the MemPalace Architecture" (Dey & Viradecha). Settles MemPalace's 96.6% as `recall_any@5`; attributes the retrieval performance to ChromaDB's embedding stack + verbatim storage, not the palace metaphor.
- [arXiv 2606.15903](https://arxiv.org/abs/2606.15903) — "Control-Plane Placement Shapes Forgetting" (Yang). Appendix Q / Table 16 carries the Lethe v1 LongMemEval-S per-type R@5 rows quoted above.
- [Memoria on LongMemEval (MatrixOrigin)](https://medium.com/@matrixorigin-database/benchmarking-memoria-on-longmemeval-strong-memory-retrieval-clear-reader-separation-ee6c89c75d76) ([dev.to mirror](https://dev.to/origin_matrix_b790e656217/benchmarking-memoria-on-longmemeval-strong-memory-retrieval-clear-reader-separation-435b) — the Medium page 403s some fetchers) — frozen-retrieval, three-reader QA-acc design.
- [mem0.ai/blog/ai-memory-benchmarks-in-2026](https://mem0.ai/blog/ai-memory-benchmarks-in-2026) (2026-05-11) — Mem0's April-2026 algorithm per-type LongMemEval QA-acc; overall 94.4% appears only in the page's meta headline, not the body.
- [tenurehq/precisionmembench](https://github.com/tenurehq/precisionmembench) README (accessed 2026-09-01) — current single-turn and session leaderboard tables, including the author's own gbrain row (0.14).

## When you add a new comparison row

Cite the source page directly (link to the section + accessed-on date).
Note any caveats the source itself raises (tuning-on-failing-Qs,
experimental-not-production, metric-mismatch). Numbers tables stay neutral
and cited; the "vs gbrain" analysis blocks are explicitly our read — name
the mechanism behind every win AND every loss (an unexplained win is
marketing, an unexplained loss is a bug report waiting to happen), state the
gbrain version analyzed, and never claim a win on a benchmark we haven't
run.
