# Comparing memory systems without comparing different things

Updated September 9, 2026. Historical rows keep their original measurement or access dates. A source check confirms what an author published; it does not mean we reproduced the system.

Before comparing two memory scores, ask what each system had to do. Find one useful conversation? Find every conversation needed? Return only the right facts? Write the right answer? Those are different jobs, and a system can do one well while struggling with another.

Gbrain now has evidence for each stage. The [September 6 experiment](benchmarks/2026-09-06-longmemeval-ranker-wave.md) found all labeled evidence on 449/470 answerable LongMemEval questions, or 95.53%, and answered 433/500 questions correctly, or 86.6%. The [September 9 refresh](benchmarks/2026-09-09-retrieval-refresh.md) also measures how much irrelevant memory search returns. Its tight adaptive configuration with reranking has mean precision 0.5859 and recall 0.8250 on PrecisionMemBench, while broad hybrid returns many more distractions.

Those results give engineers useful choices. They do not establish one universal ranking of memory systems. Use [retrieval lessons](retrieval-lessons.md) for the practical conclusions and [settings](settings.md) for the controls behind them.

## Four questions hidden inside the word “recall”

| Measure | What a passing result means | A failure it can hide |
|---|---|---|
| Any-hit retrieval | At least one required source was returned | A second required source is missing |
| Strict all-hit retrieval | Every labeled source was returned | The writer misreads the sources |
| Returned-set precision | A large share of returned facts are relevant | Useful facts were left out |
| Answer accuracy | A judge accepts the generated answer | Which stage helped or failed is unclear |

Suppose one session records a running workout and another records yoga. A question asking for total exercise time needs both. Any-hit can give full credit after finding only running. Strict retrieval catches the omission. Even with both sessions present, a writer can add the times incorrectly.

A fifth detail matters: what does K count? Gbrain's ordinary LongMemEval path returns five chunk rows, then scores the distinct sessions represented by those rows. Another system may return five complete sessions. A third may retrieve twenty candidates, rerank them, and give an answering model thousands of words. The same `@5` label does not make their full protocols identical.

## LongMemEval: the evidence we have

The official [retrieval evaluator](https://github.com/xiaowu0162/LongMemEval/blob/main/src/retrieval/eval_utils.py) distinguishes `recall_all` from `recall_any`. Its [printing code](https://github.com/xiaowu0162/LongMemEval/blob/main/src/evaluation/print_retrieval_metrics.py) excludes abstention questions for retrieval. For the cleaned small split, that leaves 470 of 500 questions. Answer accuracy includes the 30 abstention questions.

Gbrain v0.48.4.0 is pinned at `2efaaf8f8a817b5b82e023383618fdcdb1cc5f7d`. The September 6 run used cached OpenAI `text-embedding-3-large` embeddings at 1,536 dimensions, balanced search, Voyage `rerank-2.5`, autocut off, relational pin three, and lexical metadata gating. The embedding choice pins this experiment; the current new-install embedding default is a different setting.

Without reranking, gbrain found all evidence on 439/470 questions (93.40%) and some evidence on 464/470 (98.72%). With reranking, the counts were 449/470 (95.53%) and 469/470 (99.79%). The paired strict comparison gained 18 questions and lost eight. The result supports the reranker in this configuration, while making its losses visible.

The detailed source table below preserves earlier external snapshots. Rows saying “our recomputation” are counts from published rankings, not new executions of the external software. QA rows are deliberately labeled: their percentages cannot be ranked against retrieval percentages.

| System | Headline | Metric | k | n | LLM in loop | Source |
|---|---|---|---|---|---|---|
| MemPal hybrid v4 + LLM rerank (published) | 100% (500/500) claimed 2026-03-25; 99.2% (496/500) in the committed 2026-04-14 reproduction; README says "at least 99%" | R@5 (**any-hit**); LLM reranks the top-20 candidates | 5 | 500 incl. 30 abstention | yes (Claude Haiku/Sonnet for the 100% runs; minimax-m2.7 via Ollama in the committed reproduction) | [BENCHMARKS.md](https://github.com/MemPalace/mempalace/blob/main/benchmarks/BENCHMARKS.md); the last 99.4% to 100% step was three hand-coded fixes for three failing Qs (their own caveat) |
| MemPal hybrid v4 + LLM rerank (our recomputation) | **90.0%** (423/470; 449/500 = 89.8% with abstentions) | `recall_all@5` (strict), our recomputation from their committed per-question rankings joined to official gold labels; rechecked 2026-09-09 | 5 | 470 | yes (LLM reranker over top-20) | [results_mempal_hybrid_v4_llmrerank_session_20260414_1659.jsonl](https://github.com/MemPalace/mempalace/blob/main/benchmarks/results_mempal_hybrid_v4_llmrerank_session_20260414_1659.jsonl), accessed 2026-09-02 |
| MemPal hybrid v4, held-out (published) | 98.4% R@5 (443/450); 99.8% R@10 (449/450) | R@5 (**any-hit**); keyword/temporal/name boosts, no LLM | 5 | 450 held-out (seed 42, tuned on the other 50; incl. 26 abstention) | none | [BENCHMARKS.md](https://github.com/MemPalace/mempalace/blob/main/benchmarks/BENCHMARKS.md), their held-out figure; distinct from the full-set reranked run |
| MemPal hybrid v4, held-out (our recomputation) | **88.7%** (376/424; 399/450 with abstentions) | `recall_all@5` (strict), our recomputation from their committed rankings; subset of a tuned split, loosely comparable | 5 | 424 | none | [results_mempal_hybrid_v4_held_out_session_20260414_1634.jsonl](https://github.com/MemPalace/mempalace/blob/main/benchmarks/results_mempal_hybrid_v4_held_out_session_20260414_1634.jsonl), accessed 2026-09-02 |
| MemPal raw (ChromaDB), published | 96.6% (483/500; 454/470 on non-abstention) | R@5 (**any-hit**, per [arXiv 2604.21284](https://arxiv.org/abs/2604.21284); 29 of 30 abstention Qs score as hits) | 5 | 500 | none | their public-facing headline; [issue #29](https://github.com/MemPalace/mempalace/issues/29) |
| MemPal raw (ChromaDB), our recomputation | **85.7%** (403/470; 425/500 = 85.0% with abstentions) | `recall_all@5` (strict), our recomputation from their committed rankings; their logged any-hit reproduced with 0 mismatches. Per type strict vs any-hit: multi-session 77.7% vs 99.2%, temporal 76.4% vs 94.5%, knowledge-update 97.2% vs 100% | 5 | 470 | none | [results_mempal_raw_session_20260414_1629.jsonl](https://github.com/MemPalace/mempalace/blob/main/benchmarks/results_mempal_raw_session_20260414_1629.jsonl), accessed 2026-09-02 |
| ContextFit token-native + evidence certificates | 84.3% All@5 (396/470, 2026-05-24) / 96.8% Any@5; 80.43% All@5 (378/470, 2026-05-16) | All@ + Any@ (their harness, "cleaned" dataset; custom harness; see optional type-routing caveat below) | 5 | 470 | none (no vector DB) | [whitepaper](https://www.context.fit/whitepaper.html), accessed 2026-09-01 |
| ContextFit + OpenAI embedding fusion | 87.45% All@5 (411/470, 2026-05-24) / 98.3% Any@5 (98.94% = 465/470 route-gated) / 99.2% Any@10 | All@ + Any@ (their harness, "cleaned" dataset; custom harness; see optional type-routing caveat below) | 5 / 10 | 470 | none (embeddings as fusion signal, no LLM call) | [whitepaper](https://www.context.fit/whitepaper.html), accessed 2026-09-01; May 2026 artifact in [issue #10](https://github.com/garrytan/gbrain-evals/issues/10) |
| Lethe v1 | 93.8% overall | R@5, "gold session in top-k" (any-hit-shaped; `recall_all` unstated) | 5 | 500 (no abstention exclusion) | none | [arXiv 2606.15903](https://arxiv.org/abs/2606.15903), Appendix Q Table 16 |
| LongMemEval paper (Wu et al.), Stella V5 session-level, `_m` split | 0.706 R@5 / 0.783 R@10 (K=V); 0.732 R@5 / 0.862 R@10 (K=V+fact); Appendix E.2 sweep R@5: BM25 0.634, Contriever 0.723, Stella 0.720 | `recall_all@k` (strict, per the evaluator code) | 5 / 10 | 470 | none | [arXiv 2410.10813v2](https://arxiv.org/html/2410.10813v2) Table 3 + Appendix E.2; Table 3 is `_m` (500-session haystacks); the Appendix E.2 sweep does not state its split (M inferred); not a matched S-split comparison |
| agentmemory (rohitg00) | 95.2% R@5 (BM25 + vector); 98.6% R@10; 99.4% R@20; BM25-only R@5 86.2% | R@k (**any-hit**; abstention filter never fires, so all 500 count) | 5 / 10 / 20 | 500 | none | [LONGMEMEVAL.md](https://github.com/rohitg00/agentmemory/blob/main/benchmark/LONGMEMEVAL.md), accessed 2026-09-02 |
| Mastra Observational Memory | 94.87% macro (unweighted mean of six category accuracies) / 93.6% micro (468/500), gpt-5-mini actor; 93.27% (gemini-3-pro-preview); 84.23% macro / 84.8% micro (gpt-4o) | QA-acc (NOT R@k), gpt-4o judge, official prompts; full-context compression system, no recall@k exists | n/a | 500 (abstentions folded into their categories) | yes (gpt-5-mini) | [mastra.ai/research/observational-memory](https://mastra.ai/research/observational-memory), accessed 2026-09-02 |
| Supermemory (research page) | 95% overall (own page); 81.6% (gpt-4o reader) / 85.2% (gemini-3-pro reader) as listed by Mastra | QA-acc (NOT R@k); the page labels it "Recall@k=15 with aggregation" but the same figures sit in its gpt-4o LLM-as-judge table, so it is answer accuracy with top-15 retrieval, mislabeled as recall | n/a (top-15 retrieval) | 500 | yes | [supermemory.ai/research/longmembench](https://supermemory.ai/research/longmembench/), accessed 2026-09-02; [mastra research page](https://mastra.ai/research/observational-memory) |
| Supermemory "99% SOTA" post | ~99%; 98.60% is pass@8 (correct if any of 8 variants got it); 97.20% majority vote | QA-acc (NOT R@k) | n/a | 500 | yes (Gemini-2/GPT-4o ensemble) | [their ASMR post](https://supermemory.ai/blog/we-broke-the-frontier-in-agent-memory-introducing-99-sota-memory-system/); self-declared parody, authors flag it as experimental, not production |
| Memoria (MatrixOrigin) | 88.78% (443/499, claude-opus-4.6 reader) / 84.97% (424/499, gpt-5.4 reader) / 70.74% (353/499, claude-sonnet-4.5 reader), three readers on identical frozen retrieval | QA-acc (NOT R@k), gpt-5.4 judge; title says "retrieval" but no recall metric is reported | n/a (10 memories/Q) | 499 judged of 500 (1 timeout; abstention included) | yes | [their post](https://medium.com/@matrixorigin-database/benchmarking-memoria-on-longmemeval-strong-memory-retrieval-clear-reader-separation-ee6c89c75d76) ([mirror](https://dev.to/origin_matrix_b790e656217/benchmarking-memoria-on-longmemeval-strong-memory-retrieval-clear-reader-separation-435b)) |
| Mem0 (self-reported, April 2026 algorithm) | 94.4% (472/500) at top-200; 94.8% (474/500) at top-50; earlier 93.4% (2026-04). Per type at 94.4: single-session-user 98.6, single-session-assistant 98.2, single-session-preference 96.7, knowledge-update 93.6, temporal 97.0, multi-session 88.0 | QA-acc (NOT R@k), gpt-4o answerer from up to 200 retrieved memories + gpt-4o judge; the "at Top-k" cutoffs are QA accuracy per cutoff, not recall@k; no LongMemEval retrieval metric published | n/a | 500 incl. abstention (`longmemeval_s_cleaned` pinned in run.py) | yes | [mem0ai/memory-benchmarks](https://github.com/mem0ai/memory-benchmarks), accessed 2026-09-02; [mem0.ai blog, 2026-05-11](https://mem0.ai/blog/ai-memory-benchmarks-in-2026) (per-type figures; the 94.4% overall sits in the page meta, the repo carries the count) |
| Mem0 (independent, arXiv 2603.04814) | 49.00%; long-context GPT-5-mini 82.40% in the same paper | QA-acc (NOT R@k), GPT-5-mini judge, 3-vote majority, GPT-5-nano extraction | n/a | 500 | yes | [arXiv 2603.04814](https://arxiv.org/html/2603.04814) |
| MemCog (WeChat/Tencent) | 95.80 overall; multi-session 92.48; knowledge-update 91.03; temporal 98.50; single-user 100.00; ablations 95.00 (no proactive) / 93.37 (no graph overlay) | QA-acc (NOT R@k), GPT-4o judge; split and answer backbone not stated, baselines copied from other papers; no LongMemEval retrieval metric at all | n/a | 500 (S split inferred) | yes | [arXiv 2605.28046v1](https://arxiv.org/html/2605.28046v1) |
| Zep (research page, 2026) | 90.2% (451/500); multi-session 83.5%; retrieval latency 104/162 ms p50/p95 | QA-acc (NOT R@k), gpt-5.4 reader (medium reasoning) + gpt-5.4 judge, cross-encoder reranking; the 2025 paper's gpt-4o reader scored 71.2% (gpt-4o-mini 63.8%) | n/a | 500 incl. abstention | yes | [getzep.com/research](https://www.getzep.com/research/), accessed 2026-09-02; [arXiv 2501.13956](https://arxiv.org/abs/2501.13956) |
| Hindsight (Vectorize) | 91.4% (Gemini-3 answerer, own repo; per category 97.1 / 96.4 / 80.0 / 94.9 / 91.0 / 87.2); 89.0% (GPT-OSS-120B); 94.6% on the vendor page (backbone undisclosed) | QA-acc (NOT R@k), LLM judge (GPT-OSS-120B judge in the paper); vendor page markets it under non-official category names | n/a | 500 incl. abstention | yes | [vectorize-io/hindsight-benchmarks](https://github.com/vectorize-io/hindsight-benchmarks); [hindsight.vectorize.io](https://hindsight.vectorize.io/blog/2026/03/23/agent-memory-benchmark), accessed 2026-09-02 |
| ByteRover, earlier runs | 92.8% (464/500) run 1; 92.2% (461/500) run 2 | QA-acc (NOT R@k), Gemini 3.1 Pro answerer, Gemini 3 Flash or 3.1 Pro judge; competitor rows on their page are copied from vendors with different judges | n/a | 500 incl. abstention | yes | [byterover.dev blog](https://www.byterover.dev/blog/benchmark_ai_agent_memory_real_production_byterover_top_market_accuracy_longmemeval), accessed 2026-09-02 |
| **gbrain v0.48.4.0 (2026-09-06)** | **86.6% (433/500)**; non-abstention 86.0% (404/470); abstention 29/30; per type SSA 100 / SSU 98.6 / KU 89.7 / MS 83.5 / TR 80.5 / SSP 66.7 | QA-acc (NOT R@k), claude-sonnet-4-6 reader over full sessions represented by the first five chunks (60,000-character cap per session; abstention instruction added), gpt-4o judge with the official `evaluate_qa.py` prompts at temperature 0; 500/500 judged, 0 judge errors; retrieval on the same rows 95.53% recall_all@5 | n/a | 500 incl. abstention | yes — `docs/benchmarks/2026-09-06-longmemeval-ranker-wave.md` | gbrain's first judged row; protocols differ from every vendor row above, so no comparison is claimed in either direction |
| ContextFit fusion QA | 84.8% overall / 86.81% task-averaged (May note); 81.8% through the official `evaluate_qa.py` with a fresh GPT-4o judge (task-averaged 83.5%); 87.2% with a GPT-5-mini answerer + local GPT-4o judge (85.2% with a GPT-4o answerer) | QA-acc (NOT R@k), their pipeline | n/a | 500 incl. 30 abstention | yes (GPT-4o or GPT-5-mini generation + GPT-4o judge) | [their QA note](https://www.context.fit/longmemeval-fusion-qa-20260519.html), reported in [issue #10](https://github.com/garrytan/gbrain-evals/issues/10); [cf repo QA evidence](https://github.com/ContextFit/cf/blob/master/benchmarks/longmemeval_contextfit_qa_evidence_20260516.md) |

## What the closest retrieval comparisons tell us

On September 9 we downloaded MemPalace's three cited per-question files and joined their first five ranked session IDs to official cleaned gold. We reproduced every saved any-hit flag with zero mismatches. Strict counts were 403/470 for raw retrieval, 376/424 for the held-out hybrid subset, and 423/470 for the full reranked run. These confirm the strict recomputations first published here September 2.

The held-out file has 443/450 any-hits, which rounds to 98.4%. This page formerly printed 442/450 beside that percentage; the count was wrong. Excluding abstentions, its any-hit count is 417/424. Raw retrieval has 454/470 any-hits and the reranked file has 467/470. These counts let readers compare the same metric while keeping the different subsets visible.

Gbrain's strict scores are higher than those particular saved MemPal rankings. That is a useful result for the tested pipelines. It does not isolate why. Embedding models, chunking, candidate selection, and ranking all differ. Earlier versions of this page attributed the gap to embedding quality without a matched embedder experiment. We no longer make that causal claim.

[MemPalace's own benchmark notes](https://github.com/MemPalace/mempalace/blob/main/benchmarks/BENCHMARKS.md) disclose that the final move to its historical 100% any-hit result was developed against three known failing questions. Its later committed rerank reproduction is 496/500 any-hit, or 99.2%. The tuned headline, held-out subset, and full reproduction are separate observations. An [independent architecture analysis](https://arxiv.org/abs/2604.21284) also discusses the any-hit distinction; the counts here come directly from the primary ranking files.

ContextFit publishes both All@ and Any@. Its [whitepaper](https://www.context.fit/whitepaper.html), checked September 9, still reports 84.3% All@5 for its token-native path and 87.45% for optional embedding fusion, with route-gated Any@5 of 98.94%. Its earlier [May artifact](https://github.com/garrytan/gbrain-evals/issues/10) reported All@5 83.62%, All@10 91.28%, Any@5 96.60%, Any@10 98.72%, and MRR 0.8999. Those describe different recorded configurations.

The previous version of this page alleged a gold-ID prefix check in ContextFit's reranker. We could not substantiate that claim in the primary repository and have removed it. A narrower, verifiable qualification remains: at commit `be36da8da17fdec0ee23bc6ecb1e2d7912eea325`, optional coverage and temporal paths in [the benchmark runner](https://github.com/ContextFit/cf/blob/be36da8da17fdec0ee23bc6ecb1e2d7912eea325/benchmarks/longmemeval_contextfit.py#L691) route using the dataset's `question_type`. The [May 16 token-only command](https://github.com/ContextFit/cf/blob/master/benchmarks/longmemeval_token_only_leaderboard_evidence_20260516.md) enables coverage reranking. That warrants a matched query-only check; it does not establish that every later whitepaper row used the same path or that the ranker read answer IDs.

Lethe's [paper](https://arxiv.org/html/2606.15903) reports 93.8% session R@5 over 500 questions. The strict variant is not established by that label, so it belongs beside a qualified any-hit comparison. [Agentmemory](https://github.com/rohitg00/agentmemory/blob/main/benchmark/LONGMEMEVAL.md) publishes 95.2% R@5 for BM25 plus vectors and 86.2% for BM25 alone. Those are useful local-stack references, not evidence that hosted embeddings explain every difference from gbrain.

The original LongMemEval paper's [Table 3](https://arxiv.org/html/2410.10813v2) uses the harder `_m` history. Its session-retrieval numbers are not competing `_s` scores. Gbrain needs a run on that split before claiming a comparison.

## Answer quality depends on the reader too

Gbrain's 86.6% answer result used a Sonnet 4.6 reader, a 512-token answer limit, full sessions represented by the first five chunks with a 60,000-character cap per session, and a GPT-4o judge. An abstention instruction and data-boundary wrappers differ from the original prompts. The [full report](benchmarks/2026-09-06-longmemeval-ranker-wave.md) discloses those choices and the limits of its compacted receipts.

Several external QA results are higher. They remain useful targets, but changing the reader, judge, context budget, or aggregation can move the score independently of retrieval. [Memoria's own experiment](https://dev.to/origin_matrix_b790e656217/benchmarking-memoria-on-longmemeval-strong-memory-retrieval-clear-reader-separation-435b) makes this particularly clear: identical retrieved memories produced 88.78%, 84.97%, and 70.74% answer accuracy with three readers, judged by GPT-5.4. One timeout left 499 scored questions.

[Mastra's report](https://mastra.ai/research/observational-memory) publishes six category counts. They total 468/500 = 93.6%; averaging the six category percentages equally gives its 94.87% headline. Both aggregations can be useful, but only one treats every question equally. The same distinction gives 84.8% per-question accuracy for its GPT-4o run, beside the reported 84.23% category average.

[Mem0's benchmark repository](https://github.com/mem0ai/memory-benchmarks) reports 472/500 and 474/500 with different retrieval cutoffs. The [independent 49.00% experiment](https://arxiv.org/html/2603.04814) uses a different extraction and judging setup. [Zep's 90.2% page](https://www.getzep.com/research/) and its [older 71.2% paper result](https://arxiv.org/abs/2501.13956) likewise use different model protocols. These are not paired measurements proving one product rose or fell by the difference.

[Hindsight's repository](https://github.com/vectorize-io/hindsight-benchmarks) reports 91.4% with Gemini-3 and 89.0% with GPT-OSS-120B; its [vendor post](https://hindsight.vectorize.io/blog/2026/03/23/agent-memory-benchmark) lists 94.6% under a less specific protocol. [MemCog's paper](https://arxiv.org/html/2605.28046v1) reports 95.80% QA accuracy. We retain each attribution rather than selecting whichever headline makes gbrain look best.

The [ByteRover page](https://www.byterover.dev/blog/benchmark_ai_agent_memory_real_production_byterover_top_market_accuracy_longmemeval), checked September 9, now adds a 96.1% result for v2.1.5 and preserves earlier 92.8% and 92.2% runs. The old version of this table attached the v2.1.5 label to those earlier scores; it now labels them as earlier runs. All remain external QA results with their own protocol.

The two old Supermemory URLs currently redirect to its homepage and blog index. Their 95%, experimental 98.60% pass@8, and 97.20% majority-vote figures remain a historical September 2 source record, not newly verified claims. Pass@8 means at least one of eight tries passed; it is not single-answer accuracy. The OMEGA 95.4% and older Mem0 93.4% figures in the September 6 report are also historical external citations with unmatched protocols, not comparison targets established by this harness.

## What gbrain's other configurations teach us

The [May report and September 2 rerun](benchmarks/2026-05-07-longmemeval-s.md) retain the earlier 438/470 unreranked and 448/470 reranked results. Both explicitly disabled autocut, even though the prose originally called the reranked row a complete release default. Fetching extra chunks to fill five distinct session slots raised each by one question, to 439 and 449.

The September 6 experiment then isolated autocut. With reranking on, the old cut scored 379/470; disabling it scored 449/470. Released tokenmax with expansion, reranking, and no cut scored 436/470. Expansion without reranking scored 255/470, and limiting expansion's fusion budget to 0.25 recovered it to 394/470, still below plain hybrid. These are stronger grounds for choosing balanced mode at a small result budget than any broad claim that adding more retrieval machinery must help.

Graph relationships and curated-source priorities need other fixtures. LongMemEval has no useful graph edges for the relational pin to exercise. The [fresh report](benchmarks/2026-09-09-retrieval-refresh.md) and [retrieval lessons](retrieval-lessons.md) explain those cases. The old difference between graph-first and text adapters is not a graph-only causal measurement.

## ConvoMem: an unrun comparison for gbrain

This historical table comes from [MemPalace's benchmark page](https://github.com/MemPalace/mempalace/blob/main/benchmarks/BENCHMARKS.md), checked again September 9. ConvoMem contains over 75,000 QA pairs, but the page's reproduction command uses a limit of 50 per category; the dataset size must not be treated as the number evaluated in this row.

| System | Score | Notes |
|---|---|---|
| MemPal | 92.9% | verbatim text + semantic search |
| Gemini (long context) | 70-82% | full history in context window |
| Block extraction | 57-71% | LLM-processed blocks |

There is no gbrain ConvoMem run in this repository. Similar architecture does not justify predicting a score near 92.9%. An index can avoid rereading an entire history, but query cost is not guaranteed to stay flat as the corpus grows. A matched run would need the exact subset, output contract, reader, judge, and cost accounting.

## LoCoMo: retrieval and QA were mixed here too

The MemPal rows below are published retrieval results. Memori's 81.95% is instead answer accuracy, confirmed by [Memori's primary results page](https://memorilabs.ai/docs/memori-cloud/benchmark/results/). The old table put all four under an R@10 header; the labels below correct that error without changing the reported values.

| System / mode | Published score | Notes |
|---|---|---|
| MemPal hybrid v5 + Sonnet rerank | 100% | "structurally guaranteed (top-k > sessions)" — needs caveat |
| MemPal bge-large + Haiku rerank | 96.3% | top-15, R@10 |
| Memori | 81.95% QA accuracy | [LLM-judged answers](https://memorilabs.ai/docs/memori-cloud/benchmark/results/), not R@10 |
| MemPal hybrid v5 (no rerank) | 88.9% | top-10 |

MemPal's [own caveat](https://github.com/MemPalace/mempalace/blob/main/benchmarks/BENCHMARKS.md#locomo-100--a-separate-caveat) says the top-50 candidate budget exceeds the 19–32 sessions in each conversation. Candidate coverage is then automatic. A final ranked or answered result can still require work, but that setup does not demonstrate selective retrieval from a large history.

No gbrain LoCoMo result is published here. The graph may be useful when a question follows explicit relationships, but that is a hypothesis for this dataset, not a score. The 88.9% retrieval result and 81.95% answer result cannot establish a seven-point victory for one system over the other.

## Saving memory: HaluMem and Cat 35

[HaluMem](https://arxiv.org/html/2511.03506) evaluates memory extraction, updating, and answering. Its Table 3 gives these Medium-corpus extraction results, checked September 9:

| System | Extraction recall | Corpus | Source |
|---|---|---|---|
| Mem0 | 42.9% | HaluMem-Medium (Table 3) | arXiv 2511.03506 |
| Supermemory | 41.5% | HaluMem-Medium (Table 3) | arXiv 2511.03506 |

Gbrain's [Cat 35](benchmarks/2026-08-16-brainbench-cat35-transcript-distill.md) asks what survives when an agent transcript becomes a readable page. The latest published candidate reached 88.1% judged salient-content recall, 82.7% mechanical quote fidelity, and 1.2% distraction leakage. Human judge calibration is pending. It is a different corpus and task from HaluMem, so the numeric difference has no comparative direction.

The useful common lesson is that material can be lost or distorted before search begins. [SummHay](https://arxiv.org/abs/2407.01370) is another relevant coverage-and-citation protocol; its historical 56.1 human joint score is also a different task. We do not claim that gbrain is the only system with a measured write path, or that a good read-path QA result tells us extraction is lossless.

## PrecisionMemBench: returning fewer distractions

[PrecisionMemBench](https://github.com/tenurehq/precisionmembench) has 35 stored beliefs, 77 single-query cases, and 12 session cases. Gbrain's published runs cover the 77 single-query cases. The upstream scorer returns null for some metrics, so reported means use metric-specific denominators.

The table below preserves the September 1 source snapshot. Its two local May gbrain rows used a seeding defect: four superseded beliefs were hidden using ground-truth metadata unavailable to other providers. They are historical, invalid comparison rows, not current upper-bound forecasts.

| System | Mean precision (single-turn) | p50 | Source |
|---|---|---|---|
| tenure (author's belief store) | 1.00 | 9.8ms | [upstream README](https://github.com/tenurehq/precisionmembench), accessed 2026-09-01 |
| **gbrain adaptive (tight)** | **0.582** (May result with flawed seeding; superseded) | ~270ms | [our report](benchmarks/2026-05-29-precisionmembench.md) |
| supermemory | 0.22 | 69ms | upstream README, accessed 2026-09-01 |
| yourmemory / agentmemory | 0.17 | 313ms / 82ms | upstream README, accessed 2026-09-01 |
| atomicmemory | 0.15 | 71ms | upstream README, accessed 2026-09-01 |
| gbrain (author's own integration) | 0.14 | 544ms | upstream README, accessed 2026-09-01; see note below |
| zep | 0.09 | 124ms | upstream README, accessed 2026-09-01 |
| vector baseline | 0.09 | 72ms | upstream README, accessed 2026-09-01 |
| **gbrain hybrid, historical May setup** | **0.075** (flawed seeding) | ~270ms | [our report](benchmarks/2026-05-29-precisionmembench.md) |
| mem0 | 0.06 | 65ms | upstream README, accessed 2026-09-01 |

The [September 9 corrected run](benchmarks/2026-09-09-retrieval-refresh.md) indexes all 35 beliefs live. Broad hybrid recorded precision 0.0565 and recall 0.9884, with or without reranking. Tight adaptive limits recorded 0.5333 / 0.7320 without reranking and 0.5859 / 0.8250 with it. Keyword search recorded 0.1361 / 0.1744. All five runs completed 77 cases with zero execution errors.

Mean recall has 43 non-null cases per arm. Mean precision has 49 / 70 / 70 / 65 / 66 non-null cases for keyword, hybrid, hybrid+rerank, tight adaptive, and tight adaptive+rerank respectively. Active passes were 5 / 0 / 0 / 25 / 29 out of 43; full case passes were 34 / 7 / 7 / 38 / 41 out of 77. The [detailed report](benchmarks/2026-05-29-precisionmembench.md) explains the structural cases and the old leak.

The tight configuration returns at most one entity result and one result for other query intents. Its precision gain costs recall. That can suit “What is my current database preference?” and fail “Which people work on infrastructure?” Broad hybrid's near-complete recall is useful, but its noise is a real weakness under a search contract that expects a precise set.

The upstream README still lists tenure at 1.00 precision, supermemory at 0.22, and its own gbrain integration at about 0.14 precision / 0.17 recall. The latter is a separate integration, closer in outcome to this repository's keyword path; matching rounded scores does not establish that the implementations are identical. The old May supermemory 0.43 / 819 ms comparison is not the upstream row checked September 1 or September 9. We make no current #2 or cross-provider latency claim from those mixed runs.

## Adding a comparison that an engineer can use

Record the question the benchmark asks, dataset revision and subset, result budget and unit, model and software versions, score definition and denominator, error handling, and whether results were selected after inspecting test failures. Link the primary source with an access date. Keep changed results as dated entries so readers can tell a new run from a corrected label.

A causal explanation needs a controlled change. If two systems use different models and chunking, report the observed difference without assigning it to one component. If gbrain has not run the benchmark, say so. The purpose of this page is to help choose the next useful experiment and the right configuration, not to manufacture one leaderboard from incompatible scores.
