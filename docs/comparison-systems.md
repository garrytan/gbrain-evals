# Comparing memory systems without comparing different things

This page compares gbrain, as this repository pins it (master `8a3eedeac`, v0.60.126.0), with published results for other memory systems. Every row keeps its own measurement or access date; external sources were last checked September 9, 2026. A source check confirms what an author published; it does not mean we reproduced the system. Everything above [Changelog](#changelog) is current.

Before comparing two memory scores, ask what each system had to do. Find one useful conversation? Find every conversation needed? Return only the right facts? Write the right answer? Those are different jobs, and a system can do one well while struggling with another.

Gbrain has evidence for each stage. Its release configuration finds all labeled evidence on 451/470 answerable LongMemEval questions (95.96%, opaque session ids, gbrain `109b992`; [recount](benchmarks/2026-10-04-longmemeval-opaque-followups.md)). With opaque ids its house reader answers 439/500 (87.8%) with the reranker off and 453/500 with it on, and a `gpt-5.4` reader answers 447/500 on the reranker-off sessions ([re-run](benchmarks/2026-09-29-longmemeval-opaque-qa.md)). The [September 9 refresh](benchmarks/2026-09-09-retrieval-refresh.md) measures how much irrelevant memory search returns: the tight adaptive configuration with reranking has mean precision 0.5859 and recall 0.8250 on PrecisionMemBench, while broad hybrid returns many more distractions.

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

The September 6 run measured gbrain v0.48.4.0 at `2efaaf8f8a817b5b82e023383618fdcdb1cc5f7d` (receipts from the pre-squash branch head `fd7e7fd9`). This repository now installs a different commit, gbrain master `8a3eedeac` (v0.60.126.0), so a fresh `bun install` does not reproduce that code exactly. The run used cached OpenAI `text-embedding-3-large` embeddings at 1,536 dimensions, balanced search, Voyage `rerank-2.5`, autocut off, relational pin three, and lexical metadata gating. The embedding choice pins this experiment; the current new-install embedding default is a different setting.

Without reranking, gbrain found all evidence on 439/470 questions (93.40%) and some evidence on 464/470 (98.72%). With reranking, the counts were 449/470 (95.53%) and 469/470 (99.79%). The paired strict comparison gained 18 questions and lost eight. The result supports the reranker in this configuration, while making its losses visible. October 4, 2026: [recounted with opaque session ids](benchmarks/2026-10-04-longmemeval-opaque-followups.md) at gbrain `109b992`, the counts are 434/470 and 463/470 without the reranker and 451/470 and 470/470 with it (+23/−6 paired); the published numbers are confirmed.

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
| **gbrain v0.48.4.0 (2026-09-06)** | 86.6% (433/500), invalid (September 28, 2026: the answer model saw `answer_` evidence-session ids; historical, not re-run in this configuration); non-abstention 86.0% (404/470); abstention 29/30; per type SSA 100 / SSU 98.6 / KU 89.7 / MS 83.5 / TR 80.5 / SSP 66.7 | QA-acc (NOT R@k), claude-sonnet-4-6 reader over full sessions represented by the first five chunks (60,000-character cap per session; abstention instruction added), gpt-4o judge with the official `evaluate_qa.py` prompts at temperature 0; 500/500 judged, 0 judge errors; retrieval on the same rows 95.53% recall_all@5 | n/a | 500 incl. abstention | yes — `docs/benchmarks/2026-09-06-longmemeval-ranker-wave.md` | gbrain's first judged row; protocols differ from every vendor row above, so no comparison is claimed in either direction |
| **gbrain v0.59.13.0 (2026-09-29), opaque session ids** | **87.8% (439/500)** house reader; 86.0% (430/500) GPT-4o reader on the same retrieved sessions (paired +21/−30, exact McNemar p = 0.26); official `evaluate_qa.py` judge 443/500 and 432/500 | QA-acc (NOT R@k). House: claude-sonnet-4-6, notes mode, 1,024 output tokens, full sessions behind the top-5 chunks. GPT-4o arm: `gpt-4o-2024-08-06` with LongMemEval's official `run_generation.py` reading prompt (JSON history, step by step), temperature 0. Reranker off, autocut off; gpt-4o judges; retrieval on the same rows 435/470 recall_all@5 | n/a | 500 incl. abstention | yes, `docs/benchmarks/2026-09-29-longmemeval-opaque-qa.md` | Leak-free replacement for the row above in a different configuration (reranker off, notes reader), so it does not measure the leak. Retrieval, context size and judges still differ from vendor rows; no comparison claimed |
| **gbrain v0.60.37.0 retrieval (2026-10-04), frontier reader** | **89.4% (447/500)** `gpt-5.4` reader (medium reasoning) with LongMemEval's official reading prompt; official `evaluate_qa.py` judge 448/500. GPT-4o on the identical prompts: 430/500 (paired +33/−16, exact McNemar p = 0.021) | QA-acc (NOT R@k). The prompts are the 2026-09-29 GPT-4o arm's, byte for byte: the distinct sessions behind gbrain's top-5 chunks, reranker off (435/470 recall_all@5), JSON history, step by step; gpt-4o judges | n/a | 500 incl. abstention | yes, `docs/benchmarks/2026-10-04-longmemeval-opaque-followups.md` | Same reader model as Zep's 90.2% and Memoria's 84.97%, but retrieval and judge differ (Zep used a gpt-5.4 judge); no ranking claimed |
| ContextFit fusion QA | 84.8% overall / 86.81% task-averaged (May note); 81.8% through the official `evaluate_qa.py` with a fresh GPT-4o judge (task-averaged 83.5%); 87.2% with a GPT-5-mini answerer + local GPT-4o judge (85.2% with a GPT-4o answerer) | QA-acc (NOT R@k), their pipeline | n/a | 500 incl. 30 abstention | yes (GPT-4o or GPT-5-mini generation + GPT-4o judge) | [their QA note](https://www.context.fit/longmemeval-fusion-qa-20260519.html), reported in [issue #10](https://github.com/garrytan/gbrain-evals/issues/10); [cf repo QA evidence](https://github.com/ContextFit/cf/blob/master/benchmarks/longmemeval_contextfit_qa_evidence_20260516.md) |

## What the closest retrieval comparisons tell us

On September 9 we downloaded MemPalace's three cited per-question files and joined their first five ranked session IDs to official cleaned gold. We reproduced every saved any-hit flag with zero mismatches. Strict counts were 403/470 for raw retrieval, 376/424 for the held-out hybrid subset, and 423/470 for the full reranked run. These confirm the strict recomputations first published here September 2.

The held-out file has 443/450 any-hits, which rounds to 98.4%. Excluding abstentions, its any-hit count is 417/424. Raw retrieval has 454/470 any-hits and the reranked file has 467/470. These counts let readers compare the same metric while keeping the different subsets visible.

Gbrain's strict scores are higher than those particular saved MemPal rankings. That is a useful result for the tested pipelines. It does not isolate why. Embedding models, chunking, candidate selection, and ranking all differ, and no matched embedder experiment exists, so this page makes no claim that embedding quality explains the gap.

[MemPalace's own benchmark notes](https://github.com/MemPalace/mempalace/blob/main/benchmarks/BENCHMARKS.md) disclose that the final move to its historical 100% any-hit result was developed against three known failing questions. Its later committed rerank reproduction is 496/500 any-hit, or 99.2%. The tuned headline, held-out subset, and full reproduction are separate observations. An [independent architecture analysis](https://arxiv.org/abs/2604.21284) also discusses the any-hit distinction; the counts here come directly from the primary ranking files.

ContextFit publishes both All@ and Any@. Its [whitepaper](https://www.context.fit/whitepaper.html), checked September 9, still reports 84.3% All@5 for its token-native path and 87.45% for optional embedding fusion, with route-gated Any@5 of 98.94%. Its earlier [May artifact](https://github.com/garrytan/gbrain-evals/issues/10) reported All@5 83.62%, All@10 91.28%, Any@5 96.60%, Any@10 98.72%, and MRR 0.8999. Those describe different recorded configurations.

We found no gold-ID prefix check in ContextFit's primary repository. A narrower, verifiable qualification applies: at commit `be36da8da17fdec0ee23bc6ecb1e2d7912eea325`, optional coverage and temporal paths in [the benchmark runner](https://github.com/ContextFit/cf/blob/be36da8da17fdec0ee23bc6ecb1e2d7912eea325/benchmarks/longmemeval_contextfit.py#L691) route using the dataset's `question_type`. The [May 16 token-only command](https://github.com/ContextFit/cf/blob/master/benchmarks/longmemeval_token_only_leaderboard_evidence_20260516.md) enables coverage reranking. That warrants a matched query-only check; it does not establish that every later whitepaper row used the same path or that the ranker read answer IDs.

Lethe's [paper](https://arxiv.org/html/2606.15903) reports 93.8% session R@5 over 500 questions. The strict variant is not established by that label, so it belongs beside a qualified any-hit comparison. [Agentmemory](https://github.com/rohitg00/agentmemory/blob/main/benchmark/LONGMEMEVAL.md) publishes 95.2% R@5 for BM25 plus vectors and 86.2% for BM25 alone. Those are useful local-stack references, not evidence that hosted embeddings explain every difference from gbrain.

The original LongMemEval paper's [Table 3](https://arxiv.org/html/2410.10813v2) uses the harder `_m` history. Its session-retrieval numbers are not competing `_s` scores. Gbrain needs a run on that split before claiming a comparison.

## Answer quality depends on the reader too

With opaque session ids, gbrain's house reader answers 439/500 (87.8%) with the reranker off, and a GPT-4o reader with the official reading prompt scores 430/500 on the same retrieved sessions, not a demonstrated difference ([re-run](benchmarks/2026-09-29-longmemeval-opaque-qa.md)). The historical 86.6% (433/500) is invalid: the answer model saw each session's raw id, and LongMemEval's evidence sessions, and only those, have ids starting with `answer_`. The same re-run found that the reader's evidence budget matters most: with only the five retrieved chunks instead of full sessions, the same reader fell from 89/100 to 65/100 on a fixed subset, while three different prompts over those chunks tied. The paragraph below describes the historical September 6 run. Retrieval scores are not affected as far as a 30-question check can tell; see the [notice in the full report](benchmarks/2026-09-06-longmemeval-ranker-wave.md). The result used a Sonnet 4.6 reader, a 512-token answer limit, full sessions represented by the first five chunks with a 60,000-character cap per session, and a GPT-4o judge. An abstention instruction and data-boundary wrappers differ from the original prompts. The [full report](benchmarks/2026-09-06-longmemeval-ranker-wave.md) discloses those choices and the limits of its compacted receipts.

Several external QA results are higher. They remain useful targets, but changing the reader, judge, context budget, or aggregation can move the score independently of retrieval. [Memoria's own experiment](https://dev.to/origin_matrix_b790e656217/benchmarking-memoria-on-longmemeval-strong-memory-retrieval-clear-reader-separation-435b) makes this particularly clear: identical retrieved memories produced 88.78%, 84.97%, and 70.74% answer accuracy with three readers, judged by GPT-5.4. One timeout left 499 scored questions.

[Mastra's report](https://mastra.ai/research/observational-memory) publishes six category counts. They total 468/500 = 93.6%; averaging the six category percentages equally gives its 94.87% headline. Both aggregations can be useful, but only one treats every question equally. The same distinction gives 84.8% per-question accuracy for its GPT-4o run, beside the reported 84.23% category average.

[Mem0's benchmark repository](https://github.com/mem0ai/memory-benchmarks) reports 472/500 and 474/500 with different retrieval cutoffs. The [independent 49.00% experiment](https://arxiv.org/html/2603.04814) uses a different extraction and judging setup. [Zep's 90.2% page](https://www.getzep.com/research/) and its [older 71.2% paper result](https://arxiv.org/abs/2501.13956) likewise use different model protocols. These are not paired measurements proving one product rose or fell by the difference.

[Hindsight's repository](https://github.com/vectorize-io/hindsight-benchmarks) reports 91.4% with Gemini-3 and 89.0% with GPT-OSS-120B; its [vendor post](https://hindsight.vectorize.io/blog/2026/03/23/agent-memory-benchmark) lists 94.6% under a less specific protocol. [MemCog's paper](https://arxiv.org/html/2605.28046v1) reports 95.80% QA accuracy. We retain each attribution rather than selecting whichever headline makes gbrain look best.

The [ByteRover page](https://www.byterover.dev/blog/benchmark_ai_agent_memory_real_production_byterover_top_market_accuracy_longmemeval), checked September 9, adds a 96.1% result for v2.1.5 and preserves earlier 92.8% and 92.2% runs, which the table labels as earlier runs. All remain external QA results with their own protocol.

The two old Supermemory URLs currently redirect to its homepage and blog index. Their 95%, experimental 98.60% pass@8, and 97.20% majority-vote figures remain a historical September 2 source record, not newly verified claims. Pass@8 means at least one of eight tries passed; it is not single-answer accuracy. The OMEGA 95.4% and older Mem0 93.4% figures in the September 6 report are also historical external citations with unmatched protocols, not comparison targets established by this harness.

## What gbrain's other configurations teach us

The [May report and September 2 rerun](benchmarks/2026-05-07-longmemeval-s.md) retain the earlier 438/470 unreranked and 448/470 reranked results. Both explicitly disabled autocut, even though the prose originally called the reranked row a complete release default. Fetching extra chunks to fill five distinct session slots raised each by one question, to 439 and 449.

The September 6 experiment then isolated autocut. With reranking on, the old cut scored 379/470; disabling it scored 449/470. Released tokenmax with expansion, reranking, and no cut scored 436/470. Expansion without reranking scored 255/470, and limiting expansion's fusion budget to 0.25 recovered it to 394/470, still below plain hybrid. These are stronger grounds for choosing balanced mode at a small result budget than any broad claim that adding more retrieval machinery must help. October 4, 2026: recounted with opaque ids at gbrain `109b992`, autocut on scored 384/470 against 451/470 off, but expansion without reranking scored 436/470 (budget 0.25: 435/470), level with plain hybrid at 434/470. The expansion losses do not reproduce at current gbrain with opaque ids ([report](benchmarks/2026-10-04-longmemeval-opaque-followups.md)).

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

The MemPal rows below are published retrieval results. Memori's 81.95% is instead answer accuracy, confirmed by [Memori's primary results page](https://memorilabs.ai/docs/memori-cloud/benchmark/results/). Each row names its own metric; the values are as reported.

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

Gbrain's [Cat 35](benchmarks/2026-08-16-brainbench-cat35-transcript-distill.md) asks what survives when an agent transcript becomes a readable page. The latest published candidate reached 88.1% judged salient-content recall (74.9% when the judge's quoted evidence must actually appear in the page, recomputed September 28, 2026; tuned on the same corpus), 82.7% mechanical quote fidelity, and 1.2% distraction leakage. Human judge calibration is pending. It is a different corpus and task from HaluMem, so the numeric difference has no comparative direction.

The useful common lesson is that material can be lost or distorted before search begins. [SummHay](https://arxiv.org/abs/2407.01370) is another relevant coverage-and-citation protocol; its historical 56.1 human joint score is also a different task. We do not claim that gbrain is the only system with a measured write path, or that a good read-path QA result tells us extraction is lossless.

## PrecisionMemBench: returning fewer distractions

[PrecisionMemBench](https://github.com/tenurehq/precisionmembench) has 35 stored beliefs, 77 single-query cases, and 12 session cases. Gbrain's published runs cover the 77 single-query cases. The upstream scorer returns null for some metrics, so reported means use metric-specific denominators.

The table below preserves the September 1 source snapshot, with gbrain's own rows replaced by the September 9 corrected run. The two local May gbrain rows used a seeding defect: four superseded beliefs were hidden using ground-truth metadata unavailable to other providers. They stay in the table, struck through, as historical invalid rows. They are not current upper-bound forecasts.

The corrected rows use this repository's wrapper around the upstream scorer on the 77 single-query cases, with all 35 beliefs indexed live. Their mean precision counts only cases where upstream returns a non-null precision (66 of 77 for tight adaptive with reranking, 70 of 77 for broad hybrid, 49 of 77 for keyword). The upstream rows come from the upstream README and may use different denominators. Latencies were measured on different machines and are not comparable across rows.

| System | Mean precision (single-turn) | p50 | Source |
|---|---|---|---|
| tenure (author's belief store) | 1.00 | 9.8ms | [upstream README](https://github.com/tenurehq/precisionmembench), accessed 2026-09-01 |
| gbrain tight adaptive + Voyage rerank, corrected 2026-09-09 | 0.5859 (66 non-null cases; recall 0.8250) | 373ms | [September 9 refresh](benchmarks/2026-09-09-retrieval-refresh.md) |
| gbrain tight adaptive, corrected 2026-09-09 | 0.5333 (65 non-null cases; recall 0.7320) | 229ms | [September 9 refresh](benchmarks/2026-09-09-retrieval-refresh.md) |
| gbrain broad hybrid, corrected 2026-09-09 | 0.0565 (70 non-null cases; recall 0.9884) | 214ms | [September 9 refresh](benchmarks/2026-09-09-retrieval-refresh.md) |
| gbrain keyword, corrected 2026-09-09 | 0.1361 (49 non-null cases; recall 0.1744) | 2ms | [September 9 refresh](benchmarks/2026-09-09-retrieval-refresh.md) |
| ~~gbrain adaptive (tight), May 2026~~ | ~~0.582~~ (invalid: flawed seeding; superseded by the corrected rows above) | ~270ms | [our report](benchmarks/2026-05-29-precisionmembench.md) |
| supermemory | 0.22 | 69ms | upstream README, accessed 2026-09-01 |
| yourmemory / agentmemory | 0.17 | 313ms / 82ms | upstream README, accessed 2026-09-01 |
| atomicmemory | 0.15 | 71ms | upstream README, accessed 2026-09-01 |
| gbrain (author's own integration) | 0.14 | 544ms | upstream README, accessed 2026-09-01; see note below |
| zep | 0.09 | 124ms | upstream README, accessed 2026-09-01 |
| vector baseline | 0.09 | 72ms | upstream README, accessed 2026-09-01 |
| ~~gbrain hybrid, historical May setup~~ | ~~0.075~~ (invalid: flawed seeding) | ~270ms | [our report](benchmarks/2026-05-29-precisionmembench.md) |
| mem0 | 0.06 | 65ms | upstream README, accessed 2026-09-01 |

The [September 9 corrected run](benchmarks/2026-09-09-retrieval-refresh.md) indexes all 35 beliefs live. Broad hybrid recorded precision 0.0565 and recall 0.9884, with or without reranking. Tight adaptive limits recorded 0.5333 / 0.7320 without reranking and 0.5859 / 0.8250 with it. Keyword search recorded 0.1361 / 0.1744. All five runs completed 77 cases with zero execution errors.

Mean recall has 43 non-null cases per arm. Mean precision has 49 / 70 / 70 / 65 / 66 non-null cases for keyword, hybrid, hybrid+rerank, tight adaptive, and tight adaptive+rerank respectively. Active passes were 5 / 0 / 0 / 25 / 29 out of 43; full case passes were 34 / 7 / 7 / 38 / 41 out of 77. The [detailed report](benchmarks/2026-05-29-precisionmembench.md) explains the structural cases and the old leak.

The tight configuration returns at most one entity result and one result for other query intents. Its precision gain costs recall. That can suit “What is my current database preference?” and fail “Which people work on infrastructure?” Broad hybrid's near-complete recall is useful, but its noise is a real weakness under a search contract that expects a precise set.

The upstream README still lists tenure at 1.00 precision, supermemory at 0.22, and its own gbrain integration at about 0.14 precision / 0.17 recall. The latter is a separate integration, closer in outcome to this repository's keyword path; matching rounded scores does not establish that the implementations are identical. The old May supermemory 0.43 / 819 ms comparison is not the upstream row checked September 1 or September 9. We make no current #2 or cross-provider latency claim from those mixed runs.

## Adding a comparison that an engineer can use

Record the question the benchmark asks, dataset revision and subset, result budget and unit, model and software versions, score definition and denominator, error handling, and whether results were selected after inspecting test failures. Link the primary source with an access date. Keep changed results as dated entries so readers can tell a new run from a corrected label.

A causal explanation needs a controlled change. If two systems use different models and chunking, report the observed difference without assigning it to one component. If gbrain has not run the benchmark, say so. The purpose of this page is to help choose the next useful experiment and the right configuration, not to manufacture one leaderboard from incompatible scores.

## Systems in the open-source comparison

The [open-source memory shootout](plans/2026-10-05-oss-memory-shootout/PLAN.md) names each system by its kind.
This table is the one place that maps a label to its project; the preregistrations, the manifests, the capability
records, the receipts and the reports link here instead of naming projects, versions, licenses or upstream links.

| Label | Kind | Project | Version and upstream identity | License | Upstream | Vendor benchmark code | Former ids and names |
|---|---|---|---|---|---|---|---|
| `temporal-graph` | a temporal knowledge-graph library | Graphiti (the open-source library, not Zep Cloud) | `graphiti-core` 0.30.2 (tag `v0.30.2`, commit `eaa4128681bc53487138a4bbc22d58336ebe70d2`), Neo4j 5.26.2; vendor MCP server `mcp-v1.1.0` (commit `11538f6d45561bcce9a4400b374fb2dc533dccb6`), whose pyproject declares `graphiti-core[falkordb]>=0.30.1` | Apache-2.0 | [getzep/graphiti](https://github.com/getzep/graphiti) | [getzep/zep-papers@4b7f26c](https://github.com/getzep/zep-papers/tree/4b7f26cc76cca20743314ba9acb8c2cb6adc42f6/kg_architecture_agent_memory/locomo_eval): `zep_locomo_ingestion.py` and `zep_locomo_search.py`, written for the Zep Cloud client | id `graphiti`; campaign parameter `graphiti_beam_recipe`; capability key `graphiti_recipe` |
| `graph-pipeline` | a knowledge-graph pipeline | Cognee | `cognee` 1.6.2 (tag `v1.6.2`, commit `ba3631f2ed363a6ea50d649c34c56885af6b36fe`); vendor MCP server `cognee-mcp` 0.5.6 | Apache-2.0 | [topoteretes/cognee](https://github.com/topoteretes/cognee) | [topoteretes/cognee@ba3631f](https://github.com/topoteretes/cognee/tree/ba3631f2ed363a6ea50d649c34c56885af6b36fe): `cognee/eval_framework/beam/local_ingest.py`, `preprocessing/preprocess.py`, `report_artifacts/100k_fixed/beam_hybrid_completion_20_20_qa_v1_config.json` | id `cognee` |
| `extract-first` | an extract-first memory server | Mem0 (open source, not the platform) | `mem0ai[nlp]` 2.2.1, Qdrant 1.19.2; vendor MCP server OpenMemory (being sunset, not used) | Apache-2.0 | [mem0ai/mem0](https://github.com/mem0ai/mem0) | [mem0ai/memory-benchmarks@4b61c5d](https://github.com/mem0ai/memory-benchmarks/tree/4b61c5d31b9c668a12b4f5e78064248a02c82d2b): `benchmarks/locomo/run.py`, `benchmarks/longmemeval/run.py`, `benchmarks/beam/run.py`, `benchmarks/common/mem0_client.py` | id `mem0`; env `MEM0_CHUNK_TURNS` |
| `agent-runtime` | a stateful agent runtime | Letta (Letta Code App Server, local backend) | Letta Code 0.34.4 (`@letta-ai/letta-code@0.34.4`), image `letta/letta:0.34.4@sha256:8ee7fb697e7f08b121a487b48315d45c64b195c12418264b091371c9e8ab3a5c` (OCI revision `f898fda60932b34ddbcfd389ea414515b0a5d272`, tag `v0.34.4` of `letta-ai/letta-code`); CLI `letta` | Apache-2.0 | [letta-ai/letta-code](https://github.com/letta-ai/letta-code) | none | id `letta`; env `LETTA_APP_SERVER_PORT`, `LETTA_WS_TOKEN_FILE` |
| `markdown-notes` | a Markdown notes server | Basic Memory | `basic-memory` 0.23.2 (tag `v0.23.2`, commit `c0bd87c6d5a4a58034b1d6c8c5018e443b0bd048`) | AGPL-3.0 | [basicmachines-co/basic-memory](https://github.com/basicmachines-co/basic-memory) | [basicmachines-co/basic-memory@c0bd87c](https://github.com/basicmachines-co/basic-memory/tree/c0bd87c6d5a4a58034b1d6c8c5018e443b0bd048/benchmarks): `benchmarks/src/basic_memory_benchmarks/{converters/locomo_to_corpus.py,providers/bm_local.py,scoring/qa.py}` | id `basic-memory` |
| `memory-bank` | a memory-bank server | Hindsight | server 0.10.2 (tag `v0.10.2`, commit `5fc4ce20917b916240cef27c212c387a177f115b`) and `hindsight-client` 0.10.2; image `ghcr.io/vectorize-io/hindsight:0.10.2@sha256:d1840062a5b79940ab7a9f4809ceb90fc776d4ad737cd9329e9b5836cc64ab70` | MIT | [vectorize-io/hindsight](https://github.com/vectorize-io/hindsight) | [vectorize-io/agent-memory-benchmark@f618ed7](https://github.com/vectorize-io/agent-memory-benchmark/blob/f618ed7b1f0eb9cad7b42e876f91a42f0eadb150/src/memory_bench/memory/hindsight.py): provider `hindsight-http`, the code `hindsight-system-evals` runs; `vectorize-io/hindsight-benchmarks@55c51f1d6e2477ee69c0a730a80b96a1596ff475` scores extraction LLMs directly and is not used | id `hindsight`; env `HINDSIGHT_LLM_PROVIDER`, `HINDSIGHT_URL`; Postgres user and database `hindsight` |

Versions are the pins of the 2026-10-06 preregistrations. Each label's shim lives in `eval/systems/<label>/`, with its
capability record, lock file and pilot notes. A capability record or receipt field that reads
`see comparison-systems table: <label>` held the upstream identity in this row's version and benchmark-code columns;
any commit or digest it kept is the same value.

**Former ids and names** are what the harness used until amendment A6 (ids) and A6b (environment variables, the
capability key and the Postgres credentials), both on 2026-10-08. An earlier cell, lease or result id is the current
one with the label replaced by the former id (`extract-first-common-locomo-r1-a2-7c50fc54` carried the extract-first
former id in place of `extract-first`). Ledger entries and logs written before A6 use the former ids; logs written
before A6b use the former environment variable names. The hashes of every file A6b changed, before and after, are in
[rename-a6b.json](benchmarks/2026-10-06-oss-memory-shootout/rename-a6b.json).

## Changelog

### 2026-10-09: Re-pin to gbrain `8a3eedeac`

gbrain-evals v0.10.59. The pin named in the opening changed from `fc548317f` (v0.60.122.0) to `8a3eedeac` (v0.60.126.0). No
comparison row changed.

### 2026-10-08: Re-pin to gbrain `fc548317f`

gbrain-evals v0.10.53. The pin named in the opening and in the LongMemEval installed-dependency note changed from `61624308b` (v0.60.120.0) to `fc548317f` (v0.60.122.0). No comparison row changed.

### 2026-10-08: Re-pin to gbrain `61624308b`

gbrain-evals v0.10.51. The pin named in the opening and in the LongMemEval installed-dependency note changed from `a865f8f` (v0.60.104.0) to `61624308b` (v0.60.120.0). No comparison row changed.

### 2026-10-08: Upstream identities move into the systems table (A6b)

The systems table gains the upstream identities that the capability records and receipts used to carry (package pins
with commits, vendor images with digests, vendor MCP servers, vendor benchmark code) and the former environment
variable names, capability key and Postgres credentials that amendment A6b replaced. Those records now point here.
The paragraph under the table no longer names a project outside the table. No number changed.

### 2026-10-07: Systems in the open-source comparison

Added the table that maps the open-source shootout's kind labels (`temporal-graph`, `graph-pipeline`,
`extract-first`, `agent-runtime`, `markdown-notes`, `memory-bank`) to their projects, versions, licenses and upstream
repositories. The shootout's code, manifests, results and preregistrations now use the labels and link here.

### 2026-10-08: Systems in the open-source comparison and their matched results

Added the table that maps the open-source shootout's kind labels (`temporal-graph`, `graph-pipeline`,
`extract-first`, `agent-runtime`, `markdown-notes`, `memory-bank`) to their projects, versions, licenses and upstream
repositories, and the matched results from [the comparison report](benchmarks/2026-10-06-oss-memory-shootout.md). The
shootout's code, manifests, results and preregistrations now use the labels and link here.

### 2026-10-07: Re-pin to gbrain `a865f8f`

gbrain-evals v0.10.37. The pin named in the opening and in the LongMemEval installed-dependency note changed from `c5fb0201` (v0.60.95.0) to `a865f8f` (v0.60.104.0). No comparison row changed.

### 2026-10-07: The matched-reader link on the release retrieval

gbrain-evals v0.10.37. Context for the vendor rows that used `gpt-5.4`: on gbrain's reranked retrieval from `a7cb37b` (2026-09-29), `gpt-5.4` at medium reasoning with LongMemEval's official prompt answered 460 of 500 (official judge), against 447 of 500 on the reranker-off retrieval of 2026-10-04 ([reader replay](benchmarks/2026-10-07-longmemeval-w10b-reader-replay.md)). Judges and retrieval budgets still differ from the vendor rows, so no row of the comparison table changed.

### 2026-10-06: Re-pin to gbrain `c5fb0201`

gbrain-evals v0.10.37. The pin named in the opening and in the LongMemEval installed-dependency note changed from `739e5cc` (v0.60.46.0) to `c5fb0201` (v0.60.95.0). No comparison row changed.

How this page changed, newest first. Measurement history lives in the dated reports and in
[CHANGELOG.md](../CHANGELOG.md).

### 2026-10-05: Restructured as a current-state page with this changelog

gbrain-evals v0.10.23. The "Updated September 9, 2026" line becomes a statement of the pin and of when external sources were last checked. The opening evidence paragraph leads with the opaque-id retrieval recount (451/470) and current answer results (439/500, 453/500, `gpt-5.4` 447/500) instead of the September 6 figures. Sentences that described earlier versions of this page (the wrong 442/450 count, the withdrawn causal claim about embedders, the unsubstantiated ContextFit gold-ID allegation, the mislabeled ByteRover version and the R@10 header on LoCoMo) now state the current position only; the history of those fixes is in the entries below. The answer-quality section leads with the leak-free result before explaining why 86.6% is invalid.

### 2026-10-04: Re-pin to gbrain `739e5cc`

[`bf5fa53`](https://github.com/garrytan/gbrain-evals/commit/bf5fa53). The installed-dependency note in the LongMemEval section changed from gbrain master `109b992` (v0.60.37.0) to `739e5cc` (v0.60.46.0), the agent-first operator wave. The September 6 measurement and its pin stay as they were.

### 2026-10-04: Opaque-id recount and a frontier-reader QA row

[`6bc98aa`](https://github.com/garrytan/gbrain-evals/commit/6bc98aa). The October 4 opaque-session-id follow-ups were added as dated annotations beside the published numbers, which stay in place:

- The September 6 retrieval paragraph gained the recount at gbrain `109b992`: 434/470 strict and 463/470 any-hit without the reranker, 451/470 and 470/470 with it (+23/−6 paired). The page says the published numbers are confirmed.
- The LongMemEval table gained a row for a `gpt-5.4` reader over gbrain v0.60.37.0 retrieval: 89.4% (447/500), 448/500 under the official `evaluate_qa.py` judge, against 430/500 for GPT-4o on identical prompts (paired +33/−16, exact McNemar p = 0.021). It notes the same reader model as Zep's 90.2% and Memoria's 84.97% but claims no ranking.
- The autocut and expansion paragraph gained the recount: autocut on 384/470 against 451/470 off, but expansion without reranking 436/470 (budget 0.25: 435/470), level with plain hybrid at 434/470. The page now says the September 6 expansion losses do not reproduce at current gbrain with opaque ids.

### 2026-10-03: Re-pin to gbrain `109b992`

[`f321afb`](https://github.com/garrytan/gbrain-evals/commit/f321afb). The installed-dependency note changed from gbrain master `48ed5e8` (v0.60.32.0) to `109b992` (v0.60.37.0), fix wave 8 and Foundations 1.

### 2026-10-02: Re-pin to gbrain `48ed5e8`

[`c8350c5`](https://github.com/garrytan/gbrain-evals/commit/c8350c5). The installed-dependency note changed from gbrain master `d44296c` (v0.60.30.0) to `48ed5e8` (v0.60.32.0), fix wave 7.

### 2026-10-02: Re-pin to gbrain `d44296c`

[`adffe95`](https://github.com/garrytan/gbrain-evals/commit/adffe95). The installed-dependency note changed from gbrain master `3a284ae` (v0.60.26.0) to `d44296c` (v0.60.30.0), fix waves 5 and 6.

### 2026-10-01: Re-pin to gbrain `3a284ae`

[`f94e98d`](https://github.com/garrytan/gbrain-evals/commit/f94e98d), gbrain-evals v0.10.5. The installed-dependency note changed from gbrain master `6c8373c` (v0.60.13.0) to `3a284ae` (v0.60.26.0), as part of the eval-category wave release.

### 2026-09-30: Re-pin to gbrain `6c8373c`

[`1ec19a2`](https://github.com/garrytan/gbrain-evals/commit/1ec19a2), gbrain-evals v0.10.2. The installed-dependency note changed from gbrain master `608a174` (v0.60.10.0) to `6c8373c` (v0.60.13.0).

### 2026-09-29: QA leak notice, opaque-id QA row and corrected PrecisionMemBench rows

[`88d0b19`](https://github.com/garrytan/gbrain-evals/commit/88d0b19), gbrain-evals v0.10.1.

- The 86.6% (433/500) September 6 answer-accuracy result is now marked invalid in the intro, the table row and "Answer quality depends on the reader too": on September 28 the team found the answer model saw raw session ids, and only evidence sessions have ids starting with `answer_`.
- A new table row records the leak-free September 29 re-run at gbrain v0.59.13.0: 87.8% (439/500) with the house reader and 86.0% (430/500) with a GPT-4o reader on the same sessions (paired +21/−30, p = 0.26). The reader paragraph adds that cutting the reader to five chunks dropped a fixed subset from 89/100 to 65/100.
- The pin sentence now separates the measured commit `2efaaf8f` (receipts from `fd7e7fd9`) from the installed gbrain master `608a174` (v0.60.10.0).
- The Cat 35 sentence adds 74.9% salient recall when the judge's quoted evidence must appear in the page (recomputed September 28).
- The PrecisionMemBench table gained four corrected September 9 gbrain rows (tight adaptive + rerank 0.5859, tight adaptive 0.5333, broad hybrid 0.0565, keyword 0.1361, each with its non-null case count and recall). The two May rows (0.582, 0.075) are now struck through as invalid. A new paragraph explains the per-metric denominators and that latencies come from different machines.

### 2026-09-09: Rewrite as a guide to comparing different measurements

[`9238ec8`](https://github.com/garrytan/gbrain-evals/commit/9238ec8), gbrain-evals v0.8.0. The page was retitled "Comparing memory systems without comparing different things" and rewritten in plain prose. The source tables stay, with corrections, but the per-benchmark "vs gbrain" win/loss analyses and the "What gbrain master ships" summary were removed.

- New sections: "Four questions hidden inside the word recall" (any-hit, strict all-hit, returned-set precision and answer accuracy, plus what K counts), "What the closest retrieval comparisons tell us", "Answer quality depends on the reader too" and "What gbrain's other configurations teach us".
- The headline evidence became the September 6 numbers (449/470 strict, 86.6% QA) and the September 9 PrecisionMemBench refresh (tight adaptive + rerank 0.5859 precision, 0.8250 recall).
- Corrections after a September 9 re-check: the MemPal held-out count changed from 442/450 to 443/450; the claim that embedding quality explains gbrain's lead over MemPal was dropped as untested; the unverified gold-id prefix allegation against ContextFit was removed and replaced by a narrower `question_type` routing caveat; ByteRover's 92.8% and 92.2% were relabeled as earlier runs; Memori's LoCoMo 81.95% was relabeled as QA accuracy, not R@10; the ConvoMem section now notes that the source ran 50 questions per category.
- The May PrecisionMemBench gbrain rows are now called invalid because of a seeding defect, not upper bounds.

### 2026-09-06: September 6 ranker-wave numbers and first gbrain QA row

[`1816017`](https://github.com/garrytan/gbrain-evals/commit/1816017), gbrain-evals v0.7.0. The current pin moved from v0.48.2.0 (`5cfb84f1`) to v0.48.4.0 (`2efaaf8f`). The gbrain retrieval headline moved from 95.32% (448/470) reranker on and 93.19% (438/470) off to 95.53% (449/470) and 93.40% (439/470), measured September 6 with autocut off. The gbrain rows note was rewritten around the ranker wave: the old default with autocut 0.35 scored 80.64% (379/470), released `tokenmax` 92.77% (436/470), expansion without reranking 54.26% (255/470), and the new `search.expansion_variant_budget` knob recovered it only to 83.83% (394/470). The table gained gbrain's first judged QA row, 86.6% (433/500) with a claude-sonnet-4-6 reader and gpt-4o judge, with no vendor comparison claimed.

### 2026-09-02: LongMemEval re-run at v0.48.2.0 and strict recomputations of competitor rows

[`4ceb7f9`](https://github.com/garrytan/gbrain-evals/commit/4ceb7f9), gbrain-evals v0.6.1.

- The current pin moved from v0.47.8.0 to v0.48.2.0 (`5cfb84f1`). The intro now describes the `voyage:rerank-2.5` reranker as on by default in `balanced` and `tokenmax` (it had said reranking was off by default), and states the new headline: 95.32% official `recall_all@5` (448/470) reranker on, 93.19% (438/470) off. They replace the resolved 83.40% figure in the metric key. The section heading now names the cleaned Sept-2025 dataset revision.
- New "our recomputation" rows give strict `recall_all@5` from MemPalace's committed per-question files: 90.0% (423/470) LLM rerank, 88.7% (376/424) held-out, 85.7% (403/470) raw. The published MemPal rows were relabeled as any-hit.
- The table added rows for agentmemory, the LongMemEval paper's `_m` baselines, MemCog, Zep, Hindsight, ByteRover, an independent Mem0 run (49.00%), and expanded Mastra, Supermemory, Memoria and Mem0 rows. Stella, Contriever and BM25 became one paper row.
- The gbrain rows note now carries all five arms with per-type counts (including hybrid+expansion at 54.89%, 258/470). ContextFit gained a gold-label leakage caveat.
- The "vs gbrain" analysis was rewritten against two yardsticks (95.32% and 93.19%). It now says the lead over MemPal raw is not from the keyword arm, because pure vector scores 93.8%.
- Elsewhere, the Cat 35 61.5% fix-wave history was trimmed to the 88.1% result, and the PrecisionMemBench caveat was reworded as current state. The source list gained entries for the new rows, the official evaluator code, the cleaned dataset and the MemPalace result files.

### 2026-09-01: Outside-review remediation: new competitor rows and PrecisionMemBench

[`29e9ac9`](https://github.com/garrytan/gbrain-evals/commit/29e9ac9), gbrain-evals v0.6.0.

- MemPalace's 96.6% is now settled as any-hit, citing arXiv 2604.21284. Its "vs gbrain" bullet now compares 97.66% against 96.6% on the same variant.
- New LongMemEval rows: ContextFit token-native (84.3% All@5) and embedding fusion (87.45% All@5), Lethe v1 (93.8%), Memoria (88.78% QA), Mem0 April 2026 (per-type QA) and ContextFit fusion QA (84.8%), each with a "vs gbrain" bullet. A ContextFit comparability caveat explains their own harness and cleaned dataset.
- The HaluMem analysis corrected the Cat 35 distractor leakage from zero to 1.2% (1/86). The zero figure belonged to the superseded 61.5% run.
- A new PrecisionMemBench section adds the upstream leaderboard, gbrain adaptive at 0.582 and default hybrid at 0.075 as upper bounds after the `superseded_by` leak fix, the upstream author's own gbrain row (0.14), and a note that the 0.43 supermemory row no longer appears upstream. Sources were added for each new row.

### 2026-08-31: LongMemEval erratum resolved at 83.40%

[`91d2af8`](https://github.com/garrytan/gbrain-evals/commit/91d2af8), gbrain-evals v0.5.1. The metric key now records that the any-hit erratum is resolved from the original May rows: gbrain's official `recall_all@5` is 83.40% (n=470) beside the reconciled 97.60% any-hit. The gbrain rows note gained the strict figures (83.4% hybrid, 84.3% hybrid+expansion, 79.4% vector, 10.6% keyword). A new warning says competitor rows do not state their variant.

### 2026-08-31: "vs gbrain" analyses and the any-hit erratum

[`bd5ba0d`](https://github.com/garrytan/gbrain-evals/commit/bd5ba0d), gbrain-evals v0.5.0 (BrainBench v0.3.0 in the commit subject). The eval-suite audit changed the page's format and its metric key:

- A format note and a summary of what gbrain master v0.47.8.0 (`2a56b512`) ships were added. Every benchmark section gained a "vs gbrain" block naming the mechanism behind each win or loss, or saying there is no gbrain number and so no claim.
- The LongMemEval metric key was corrected: the official evaluator computes strict `recall_all@k`, and gbrain's rows (97.6% hybrid, 97.4% vector, 19.8% keyword) used a looser any-hit variant, with re-measurement pending.
- The "add a row" guidance now allows the analysis blocks but requires a mechanism for every win and loss, the gbrain version, and no win claims on unrun benchmarks. HaluMem was added to the sources.

### 2026-08-30: HaluMem write-path section

[`d5b94c7`](https://github.com/garrytan/gbrain-evals/commit/d5b94c7), gbrain-evals v0.3.0. A new section added HaluMem (arXiv 2511.03506) as the published write-path benchmark, with Mem0 at 42.9% and Supermemory at 41.5% extraction recall on HaluMem-Medium. The rows are marked as context, not comparable. It named Cat 35 as gbrain's write-path benchmark, which this commit introduced, and SummHay as the planted-gold ancestor.

### 2026-05-24: Remove Hindsight and Mem0 rows

[`9ecc5b2`](https://github.com/garrytan/gbrain-evals/commit/9ecc5b2), gbrain v0.40.6.0 snapshot. The Hindsight 91.4% LongMemEval row, the Mem0 30-45% ConvoMem row and the Mem0 research-page source were removed, along with Hindsight's mention in the reading note. The commit stripped peer-system references from the docs.

### 2026-05-07: Page created

[`55fe214`](https://github.com/garrytan/gbrain-evals/commit/55fe214). Created as a living list of published numbers from memory and retrieval systems on benchmarks gbrain runs. It had LongMemEval `_s` rows (MemPal, Hindsight, Stella, Contriever, BM25, Mastra, Supermemory) with a note separating retrieval recall from QA accuracy, ConvoMem and LoCoMo tables marked as not yet run, a list of checked sources, and rules for adding a row (cite with an access date, keep caveats, stay neutral).
