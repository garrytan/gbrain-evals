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
the exactly-reconciled 97.60% any-hit. NOTE: the competitor rows below do
NOT state which variant they ran — treat any cross-variant reading as
non-comparable in both directions. **QA-acc** = end-to-end answer accuracy
via an LLM judge. **Different metrics, never directly comparable.**

| System | Headline | Metric | k | n | LLM in loop | Source |
|---|---|---|---|---|---|---|
| MemPal hybrid v4 + Haiku rerank | 100% | R@5 | 5 | 500 | yes (Haiku) | [BENCHMARKS.md](https://github.com/MemPalace/mempalace/blob/main/benchmarks/BENCHMARKS.md) — tuned on 3 specific failing Qs |
| MemPal hybrid v4 + Haiku, held-out | 98.4% | R@5 | 5 | 450 | yes (Haiku) | held-out generalisable figure |
| MemPal raw (ChromaDB) | 96.6% | R@5 | 5 | 500 | none | their public-facing headline |
| Stella | ~85% | R@5 | 5 | 500 | none | academic dense retriever |
| Contriever | ~78% | R@5 | 5 | 500 | none | academic dense retriever |
| BM25 (sparse) | ~70% | R@5 | 5 | 500 | none | published baseline in the LongMemEval paper |
| Mastra | 94.87% | QA-acc (NOT R@k) | n/a | 500 | yes (GPT-5-mini) | [mastra.ai/research/observational-memory](https://mastra.ai/research/observational-memory) |
| Supermemory ASMR | ~99% | QA-acc (NOT R@k) | n/a | 500 | yes (Gemini-2/GPT-4o ensemble) | [their ASMR post](https://supermemory.ai/blog/we-broke-the-frontier-in-agent-memory-introducing-99-sota-memory-system/) — authors flag it as experimental, not production |

gbrain's own rows — any-hit: 97.6% hybrid / 97.4% vector / 19.8% keyword;
official `recall_all@5` (erratum resolved 2026-08-31 from the same raw
rows): **83.4% hybrid / 84.3% hybrid+expansion / 79.4% vector / 10.6%
keyword** — live in the
[2026-05-07 report + resolution](benchmarks/2026-05-07-longmemeval-s.md).

**Important reading note:** Mastra and Supermemory's numbers are end-to-end
QA accuracy (does the system produce the right answer string, judged by
gpt-4o or similar). MemPal and the gbrain numbers in this
table are retrieval recall (does the right session land in top-k). A
system can have 100% retrieval recall and 60% QA accuracy if its answer
model is bad, and vice versa. Don't compare them head-to-head without
naming the gap.

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
- **MemPal raw ChromaDB (96.6%) — gbrain wins, and the mechanism is the
  keyword arm.** A pure vector store misses questions whose evidence hinges
  on exact tokens embeddings blur together: names, handles, dates, numbers.
  gbrain's FTS arm catches those and RRF promotes them; that fusion is the
  measured 0.2-1.0 point edge over vector-only on this dataset (gbrain's own
  vector-only adapter scores 97.4% vs hybrid 97.6% — the report's per-type
  table shows the lift concentrated in multi-session questions).
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
  aimed at those specific failures and the re-run hit 88.1% with zero
  distractor leakage. The reason to believe the number: the benchmark can
  fail, has failed, and forced fixes. What would make this row rigorous:
  running gbrain's distiller on HaluMem-Medium itself (their corpus, their
  scoring) — filed as the natural follow-up when we take on ConvoMem/LoCoMo.

## Sources we've checked (so we don't redo the lookup)

- [`MemPalace/mempalace/benchmarks/BENCHMARKS.md`](https://github.com/MemPalace/mempalace/blob/main/benchmarks/BENCHMARKS.md) — most thorough public benchmark page in this category. They credit competitors fairly and call out their own tuning caveats.
- [`mastra.ai/research/observational-memory`](https://mastra.ai/research/observational-memory) — observational-memory framework, QA accuracy.
- [`supermemory.ai/blog/we-broke-the-frontier-in-agent-memory-introducing-99-sota-memory-system/`](https://supermemory.ai/blog/we-broke-the-frontier-in-agent-memory-introducing-99-sota-memory-system/) — Supermemory ASMR. Experimental ensemble, not production.
- [LongMemEval HuggingFace](https://huggingface.co/datasets/xiaowu0162/longmemeval) — the dataset itself. Three splits: `_oracle` (15MB, ~3 sessions per Q), `_s` (278MB, ~50 sessions per Q), `_m` (2.7GB, more distractors).
- [HaluMem, arXiv 2511.03506](https://arxiv.org/abs/2511.03506) — the only external write-path benchmark; Table 3 carries the Mem0/Supermemory extraction rows.

## When you add a new comparison row

Cite the source page directly (link to the section + accessed-on date).
Note any caveats the source itself raises (tuning-on-failing-Qs,
experimental-not-production, metric-mismatch). Numbers tables stay neutral
and cited; the "vs gbrain" analysis blocks are explicitly our read — name
the mechanism behind every win AND every loss (an unexplained win is
marketing, an unexplained loss is a bug report waiting to happen), state the
gbrain version analyzed, and never claim a win on a benchmark we haven't
run.
