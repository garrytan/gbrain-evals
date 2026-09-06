# Comparison Systems — published numbers we benchmark against

Living list of memory / agentic-retrieval systems that publish numbers on
benchmarks gbrain runs. Update when a system publishes a new result, even
if it's not on a benchmark we currently run — the data informs which
benchmark we should add.

Format: the numbers tables are neutral and cited. The **"vs gbrain"** analysis
under each table is explicitly our read — what gbrain's pinned master does
architecturally, and why that wins or loses against each system, with the
mechanism named. Where gbrain loses, the loss and the reason stay in. The
current pin is v0.48.2.0 (`5cfb84f1`, 2026-09-02); each "vs gbrain" heading
states the gbrain version its analysis was written against (v0.47.8.0,
`2a56b512`, where that benchmark has no run at the current pin).

What gbrain master ships, for reference in the analyses below: hybrid
retrieval (Postgres/PGLite FTS keyword arm + provider-configurable embeddings,
fused by RRF), a source-boost layer that ranks curated directories above bulk
ingest, a typed knowledge graph with traversal, optional Haiku query
expansion, a reranker whose default is `voyage:rerank-2.5` (a cross-encoder
API call, not a generative model; `balanced` and `tokenmax` run it by
default, so the reranker-on arms below are the default path, and the
reranker-off hybrid row is kept as the like-for-like row against systems that
run no reranker), opt-in adaptive return-sizing for precision-shaped
questions,
and — unlike everything else on this page — a measured write path (the dream
distiller, scored by Cat 35) and an unprompted-recall reflex (scored by Cat
34). No LLM is required anywhere in the retrieval loop. Current LongMemEval
receipt, default path: **95.32% official session-level
`recall_all@5`** (448/470, `longmemeval_s` cleaned Sept-2025 revision, 30
abstention questions excluded, k=5, hybrid mode `balanced`, reranker
`voyage:rerank-2.5` on, autocut off, embedder
`openai:text-embedding-3-large@1536`, single run, 2026-09-02 at v0.48.2.0);
like-for-like reranker-off row: **93.19%** (438/470, same dataset,
denominator, date and version). Any-hit@5 (99.79% reranker on, 98.72% off) is
a diagnostic, not a headline.

## LongMemEval (`longmemeval_s`, cleaned Sept-2025 revision from `xiaowu0162/longmemeval-cleaned`, 500 questions, 470 scored)

Metric column key: **R@k** = session-level retrieval recall. The OFFICIAL
LongMemEval evaluator computes `recall_all@k` — ALL of a question's
ground-truth sessions must land in top-k — and that is what systems using the
published evaluator report. A looser ANY-HIT variant (≥1 ground-truth session
in top-k) is also common in vendor pages and is a diagnostic, not the
official metric. gbrain's figures are **95.53% official `recall_all@5`** on
the release default path (449/470, 2026-09-06 at v0.48.4.0, hybrid, k=5,
`voyage:rerank-2.5` on, autocut off; any-hit@5 99.79% as a diagnostic) and
**93.40%** with the reranker off (439/470, same run; any-hit@5 98.72%; the
2026-09-02 receipt's 438/470 is reproduced row for row on 469 of 470
questions), both on the same cleaned dataset revision and the same n=470
denominator; the gbrain rows note under the table carries every arm of the
2026-09-06 ranker wave (`docs/benchmarks/2026-09-06-longmemeval-ranker-wave.md`). VARIANT STATUS
(checked 2026-09-02):
MemPalace's 96.6%, 98.4% and 100% rows are all ANY-HIT (their script computes
`recall_all` but never prints it); we recomputed the strict metric from their
committed per-question result files and added those rows to the table, each
labeled "our recomputation". The independent critical
analysis ([arXiv 2604.21284](https://arxiv.org/abs/2604.21284), Dey &
Viradecha) states verbatim: "The 96.6% figure—the most widely cited—is
recall_any@5: at least one of the five returned results contains the
correct answer session." Rows whose source does not state a variant are
labeled as such; treat any cross-variant reading as non-comparable in both
directions. ContextFit publishes BOTH variants (All@ and Any@) but on their
own scoring implementation and a "cleaned" dataset revision, not the
official evaluator, and its rerank layer reads gold labels during the run
(loosely comparable) — see the caveat under their rows. **QA-acc** =
end-to-end answer accuracy via an LLM judge. **Different metrics, never
directly comparable.**

| System | Headline | Metric | k | n | LLM in loop | Source |
|---|---|---|---|---|---|---|
| MemPal hybrid v4 + LLM rerank (published) | 100% (500/500) claimed 2026-03-25; 99.2% (496/500) in the committed 2026-04-14 reproduction; README says "at least 99%" | R@5 (**any-hit**); LLM reranks the top-20 candidates | 5 | 500 incl. 30 abstention | yes (Claude Haiku/Sonnet for the 100% runs; minimax-m2.7 via Ollama in the committed reproduction) | [BENCHMARKS.md](https://github.com/MemPalace/mempalace/blob/main/benchmarks/BENCHMARKS.md); the last 99.4% to 100% step was three hand-coded fixes for three failing Qs (their own caveat) |
| MemPal hybrid v4 + LLM rerank (our recomputation) | **90.0%** (423/470; 449/500 = 89.8% with abstentions) | `recall_all@5` (strict), our recomputation from their committed per-question rankings joined to official gold labels | 5 | 470 | yes (LLM reranker over top-20) | [results_mempal_hybrid_v4_llmrerank_session_20260414_1659.jsonl](https://github.com/MemPalace/mempalace/blob/main/benchmarks/results_mempal_hybrid_v4_llmrerank_session_20260414_1659.jsonl), accessed 2026-09-02 |
| MemPal hybrid v4, held-out (published) | 98.4% R@5 (442/450); 99.8% R@10 (449/450) | R@5 (**any-hit**); keyword/temporal/name boosts, no LLM | 5 | 450 held-out (seed 42, tuned on the other 50; incl. 26 abstention) | none | [BENCHMARKS.md](https://github.com/MemPalace/mempalace/blob/main/benchmarks/BENCHMARKS.md), their held-out generalisable figure |
| MemPal hybrid v4, held-out (our recomputation) | **88.7%** (376/424; 399/450 with abstentions) | `recall_all@5` (strict), our recomputation from their committed rankings; subset of a tuned split, loosely comparable | 5 | 424 | none | [results_mempal_hybrid_v4_held_out_session_20260414_1634.jsonl](https://github.com/MemPalace/mempalace/blob/main/benchmarks/results_mempal_hybrid_v4_held_out_session_20260414_1634.jsonl), accessed 2026-09-02 |
| MemPal raw (ChromaDB), published | 96.6% (483/500; 454/470 on non-abstention) | R@5 (**any-hit**, per [arXiv 2604.21284](https://arxiv.org/abs/2604.21284); 29 of 30 abstention Qs score as hits) | 5 | 500 | none | their public-facing headline; [issue #29](https://github.com/MemPalace/mempalace/issues/29) |
| MemPal raw (ChromaDB), our recomputation | **85.7%** (403/470; 425/500 = 85.0% with abstentions) | `recall_all@5` (strict), our recomputation from their committed rankings; their logged any-hit reproduced with 0 mismatches. Per type strict vs any-hit: multi-session 77.7% vs 99.2%, temporal 76.4% vs 94.5%, knowledge-update 97.2% vs 100% | 5 | 470 | none | [results_mempal_raw_session_20260414_1629.jsonl](https://github.com/MemPalace/mempalace/blob/main/benchmarks/results_mempal_raw_session_20260414_1629.jsonl), accessed 2026-09-02 |
| ContextFit token-native + evidence certificates | 84.3% All@5 (396/470, 2026-05-24) / 96.8% Any@5; 80.43% All@5 (378/470, 2026-05-16) | All@ + Any@ (their harness, "cleaned" dataset; rerank layer reads gold labels, see caveat below) | 5 | 470 | none (no vector DB) | [whitepaper](https://www.context.fit/whitepaper.html), accessed 2026-09-01 |
| ContextFit + OpenAI embedding fusion | 87.45% All@5 (411/470, 2026-05-24) / 98.3% Any@5 (98.94% = 465/470 route-gated) / 99.2% Any@10 | All@ + Any@ (their harness, "cleaned" dataset; rerank layer reads gold labels, see caveat below) | 5 / 10 | 470 | none (embeddings as fusion signal, no LLM call) | [whitepaper](https://www.context.fit/whitepaper.html), accessed 2026-09-01; May 2026 artifact in [issue #10](https://github.com/garrytan/gbrain-evals/issues/10) |
| Lethe v1 | 93.8% overall | R@5, "gold session in top-k" (any-hit-shaped; `recall_all` unstated) | 5 | 500 (no abstention exclusion) | none | [arXiv 2606.15903](https://arxiv.org/abs/2606.15903), Appendix Q Table 16 |
| LongMemEval paper (Wu et al.), Stella V5 session-level, `_m` split | 0.706 R@5 / 0.783 R@10 (K=V); 0.732 R@5 / 0.862 R@10 (K=V+fact); Appendix E.2 sweep R@5: BM25 0.634, Contriever 0.723, Stella 0.720 | `recall_all@k` (strict, per the evaluator code) | 5 / 10 | 470 | none | [arXiv 2410.10813v2](https://arxiv.org/html/2410.10813v2) Table 3 + Appendix E.2; Table 3 is `_m` (500-session haystacks); the Appendix E.2 sweep does not state its split (M inferred); a floor not a peer |
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
| ByteRover 2.1.5 | 92.8% (464/500) run 1; 92.2% (461/500) run 2 | QA-acc (NOT R@k), Gemini 3.1 Pro answerer, Gemini 3 Flash or 3.1 Pro judge; competitor rows on their page are copied from vendors with different judges | n/a | 500 incl. abstention | yes | [byterover.dev blog](https://www.byterover.dev/blog/benchmark_ai_agent_memory_real_production_byterover_top_market_accuracy_longmemeval), accessed 2026-09-02 |
| **gbrain v0.48.4.0 (2026-09-06)** | **86.6% (433/500)**; non-abstention 86.0% (404/470); abstention 29/30; per type SSA 100 / SSU 98.6 / KU 89.7 / MS 83.5 / TR 80.5 / SSP 66.7 | QA-acc (NOT R@k), claude-sonnet-4-6 reader over the FULL text of the top-5 retrieved sessions (abstention instruction added), gpt-4o (2024-08-06) judge with the official `evaluate_qa.py` prompts at temperature 0; 500/500 judged, 0 judge errors; retrieval on the same rows 95.53% recall_all@5 | n/a | 500 incl. abstention | yes — `docs/benchmarks/2026-09-06-longmemeval-ranker-wave.md` | gbrain's first judged row; protocols differ from every vendor row above, so no comparison is claimed in either direction |
| ContextFit fusion QA | 84.8% overall / 86.81% task-averaged (May note); 81.8% through the official `evaluate_qa.py` with a fresh GPT-4o judge (task-averaged 83.5%); 87.2% with a GPT-5-mini answerer + local GPT-4o judge (85.2% with a GPT-4o answerer) | QA-acc (NOT R@k), their pipeline | n/a | 500 incl. 30 abstention | yes (GPT-4o or GPT-5-mini generation + GPT-4o judge) | [their QA note](https://www.context.fit/longmemeval-fusion-qa-20260519.html), reported in [issue #10](https://github.com/garrytan/gbrain-evals/issues/10); [cf repo QA evidence](https://github.com/ContextFit/cf/blob/master/benchmarks/longmemeval_contextfit_qa_evidence_20260516.md) |

gbrain's own rows, all official session-level `recall_all@5` on
`longmemeval_s` (cleaned Sept-2025 revision, 500 questions, 470 scored, k=5),
measured 2026-09-06 at v0.48.4.0 by the in-repo `gbrain eval longmemeval`
harness (embedder `openai:text-embedding-3-large@1536`, one shared embedding
cache, single run, 0 errors in every arm; decisions on the 430 questions
outside the seed-42 dev slice). Release default path: **95.53%
gbrain-hybrid+rerank (449/470)**, `voyage:rerank-2.5` on, autocut off (any-hit@5
99.79%, 4.89 distinct sessions in the top-5); paired against reranker-off
hybrid it gains 18 questions and loses 8. Like-for-like row against systems
that run no reranker: **93.40% gbrain-hybrid (439/470)**, reranker off
(any-hit@5 98.72%; 4.90 distinct sessions). Per type with the reranker off:
knowledge-update 98.6% (71/72), multi-session 92.6% (112/121),
single-session-assistant 100% (56/56), single-session-preference 96.7%
(29/30), single-session-user 98.4% (63/64), temporal-reasoning 85.0%
(108/127); with the reranker on: knowledge-update 100% (72/72), multi-session
92.6% (112/121, unchanged), single-session-assistant 100%, single-session-
preference 100% (30/30), single-session-user 100% (64/64), temporal-reasoning
90.6% (115/127). The default that shipped before v0.48.4.0 (reranker on WITH
autocut 0.35) scored 80.64% (379/470): the cut kept the best session and
dropped the rest, so autocut is now off. `tokenmax` as released (LLM
multi-query expansion at the legacy weighting, reranker on, autocut off)
scores 92.77% (436/470); at equal variant weight without the reranker,
expansion drops strict recall to 54.26% (255/470), and the new
`search.expansion_variant_budget` knob at its smallest pre-registered value
recovers to 83.83% (394/470) — still below plain hybrid, so the bundles keep
the legacy weighting. The 2026-09-02 sibling-runner rows (438 / 448 / 258 and
the two session-diverse arms at 439 / 449) remain in the 2026-05-07 report as
the prior receipt.

**Important reading note:** Mastra, both Supermemory rows, Memoria, Mem0
(both rows), MemCog, Zep, Hindsight, ByteRover, and the ContextFit QA row
are end-to-end QA accuracy (does the system produce the right answer string,
judged by an LLM). MemPal, ContextFit's retrieval rows, Lethe, agentmemory,
the LongMemEval paper row, and the gbrain numbers in this table are
retrieval recall (does the right session land in top-k), and within
retrieval recall the strict `recall_all` and the loose any-hit are two more
columns that must not be mixed. A system can have 100% retrieval recall and
60% QA accuracy if its answer model is bad, and vice versa (Memoria: 88.78%
vs 70.74% on identical retrieval). Don't compare them head-to-head without
naming the gap.

**ContextFit comparability caveat (their rows above):** the numbers come
from ContextFit's own pipeline and scoring implementation on a dataset they
label "LongMemEval-S cleaned" (their revision), not the official evaluator
on the unmodified split and not our harness. Their May 2026 artifact
([issue #10](https://github.com/garrytan/gbrain-evals/issues/10)) reported
All@5 83.62% / All@10 91.28% / Any@5 96.60% / Any@10 98.72% / MRR 0.8999
(n=470, 30 abstentions excluded, the same denominator convention as gbrain's
numbers); the whitepaper as of 2026-09-01 shows the newer 84.3%/87.45% All@5
figures above. Gold-label leakage caveat: their rerank
layer uses a gold-id prefix check and routes by the gold `question_type`
label, so the pipeline is not leak-free and we mark the All@5 rows loosely
comparable rather than comparable. Below gbrain's 93.19% reranker-off and
95.32% reranker-on official `recall_all@5`, but not the same instrument, so
the margin is not a same-instrument margin.

### vs gbrain (v0.48.2.0, `5cfb84f1`, 2026-09-02), row by row

Two yardsticks for every bullet, both official `recall_all@5` on
`longmemeval_s` cleaned, 470 scored, k=5, single run, 2026-09-02 at
v0.48.2.0: gbrain-hybrid+rerank 95.32% (448/470, `voyage:rerank-2.5` on, the
default path; any-hit@5 99.79%) and gbrain-hybrid 93.19% (438/470,
reranker off, the like-for-like row against systems that run no reranker;
any-hit@5 98.72%). Each bullet names which one it uses: rows that
run a reranker of their own get the reranker-on number, rows with no
reranker and no LLM get the reranker-off number.

- **MemPal hybrid v4 + LLM rerank (any-hit 98.4% held-out / 99.2% committed
  reproduction / retracted 100%; strict 90.0% by our recomputation): the fair
  reranker-to-reranker read is gbrain-hybrid+rerank 95.32% vs 90.0% (+5.3pp,
  448/470 vs 423/470), and the reranker-off row also leads, 93.19% vs 90.0%
  (+3.2pp, 438/470 vs 423/470) with no reranker and no LLM in the loop; the
  any-hit diagnostics sit within a point or two of each other (99.79%
  reranker on / 98.72% off vs 98.4% held-out, 99.2% on the committed full-set
  reproduction).** The mechanism on both sides is the same lever: in their
  own committed files an LLM rerank over the top-20 lifts strict recall from
  85.7% to 90.0% (+4.3pp); in gbrain's run the `voyage:rerank-2.5`
  cross-encoder lifts it from 93.19% to 95.32% (+2.1pp,
  18 questions gained and 8 lost, paired). The smaller lift on gbrain's side
  starts from a higher floor (93.19% against their 85.7% before reranking).
  Their 100% row was tuned on three failing questions and their README
  says "at least 99%", so 98.4% (any-hit) and 90.0% (strict) are the honest
  comparison targets. Cost still favors gbrain: the reranker is one
  cross-encoder API call per query rather than a generative model call, and
  the reranker-off path stays at roughly $0.50 per 1,000 questions with the
  embedding cache warm.
- **MemPal raw ChromaDB (any-hit 96.6%; strict 85.7% by our recomputation):
  no LLM and no reranker on their side, so the like-for-like row is
  reranker-off gbrain-hybrid, which leads on both variants, 93.19% vs 85.7%
  strict (+7.5pp, 438/470 vs 403/470) and 98.72% vs 96.6% any-hit; the
  default path widens it to 95.32% vs 85.7% (+9.6pp), and the
  mechanism is NOT the keyword arm.** Pure vector on the same corpus scores
  93.8% strict (v0.48.0.0 receipt), level with hybrid, so the FTS arm is not
  the lever. The gap to MemPalace's raw setup is embedder quality
  (`text-embedding-3-large@1536` against ChromaDB's default embedding stack;
  our read) plus session-level ranking. Where it shows: their
  multi-session questions rescore at 77.7% strict against 99.2% any-hit, and
  temporal at 76.4% against 94.5%; gbrain's multi-session is 92.6% (112/121)
  and temporal 84.3% (107/127). Hybrid earns its keep elsewhere in the suite
  (relational recall, exact-token lookups), not on this benchmark.
- **ContextFit (87.45% All@5 fused / 84.3% token-native; 98.94% Any@5
  route-gated): no LLM on their side but an evidence-certificate rerank
  layer, so both gbrain rows apply; reranker-off gbrain leads by 5.7pp on the
  closest published strict-style row (93.19% vs 87.45%, 438/470 vs 411/470)
  and the default path by 7.9pp (95.32% vs 87.45%, 448/470 vs
  411/470), with an instrument caveat that cuts against a clean win.** Their
  `all_evidence@5` matches the official
  definition, but their rerank layer uses a gold-id prefix check and routes
  by the gold `question_type` label, so the pipeline is not leak-free, and
  the scoring is their own implementation; we mark the row loosely
  comparable and do not treat the 5.7pp as a same-instrument margin.
  Mechanism on their side: a token-native index with no vector database plus
  evidence-certificate reranking and `text-embedding-3-small` as a fusion
  signal, no LLM call, the same class as gbrain hybrid. Multi-session All@5
  is where the gap concentrates: their whitepaper reports 72.7% fused vs
  gbrain's 92.6% (reranker on or off). Any-hit is a wash reranker off
  (98.94% vs 98.72%) and 99.79% vs 98.94% with the reranker on.
- **Lethe v1 (93.8% "gold session in top-k", any-hit-shaped; row not
  re-verified 2026-09-02): no strict comparison is possible because
  Lethe reports no `recall_all`.** Its 93.8% any-hit sits beside gbrain's
  98.72% any-hit diagnostic, not the strict yardstick above, and the
  denominators differ (their n=500 keeps the 30 abstention questions; ours is
  470). Same architecture family as gbrain-hybrid (BM25 + MiniLM-L6-v2 dense
  + RRF, CPU only, 384-dim local embedder). Our read: most of the difference
  is embedder quality; a CPU-only stack within a few any-hit points of an
  OpenAI-embedded one remains the useful takeaway for builders who cannot
  ship hosted embeddings.
- **LongMemEval paper baselines (Stella V5 0.706 / 0.732 strict R@5 on the
  `_m` split; Appendix E.2 sweep BM25 0.634, Contriever 0.723, Stella
  0.720): a floor, not a peer.** These are the only strict `recall_all@5`
  numbers in the original paper and they are measured on `_m` (500-session
  haystacks, about 10x more distractors than `_s`), so gbrain's 93.19% and
  95.32% on `_s` are not a win over them; publishing a gbrain strict score on `_m` is
  the open follow-up.
- **agentmemory (rohitg00, 95.2% R@5 any-hit, BM25 + vector, no LLM):
  loosely comparable to gbrain's any-hit diagnostic only (98.72% vs 95.2%);
  no strict number to line up.** Their abstention filter never fires, so all
  500 count. Same architecture class as gbrain-hybrid; the gap is consistent
  with the embedder-quality story above.
- **Mastra (94.87% macro QA-acc / 93.6% micro), Mem0 (94.4% self-reported;
  49.00% in an independent GPT-5-mini-judged run), MemCog (95.80%), Zep
  (90.2%), Hindsight (91.4%; 94.6% on the vendor page), ByteRover (92.8%),
  Supermemory (95%, mislabeled "Recall@k=15" on its page; ~99% pass@8 in a
  self-declared parody post), Memoria (88.78% / 84.97% / 70.74% across three
  readers on identical retrieval): a different race, no win or loss claim.**
  Every one of these is LLM-judged end-to-end answer accuracy and moves with
  the reader and judge model: Memoria's 18-point spread on frozen retrieval,
  Zep's 71.2% (2025, gpt-4o reader) to 90.2% (2026, gpt-5.4 reader), Mem0's
  94.4% self-reported against 49.00% independent. Mastra's headline is
  additionally a macro average of six category accuracies (per-question
  93.6% = 468/500). gbrain has published no answer-accuracy run on
  LongMemEval, so nothing in this cluster can be placed beside 93.19% or
  95.32%; the
  honest next step is to run the official `evaluate_qa.py` with a named
  reader and judge and publish it (TODOS.md). Directionally, the weakest QA
  rows (Mem0 multi-session 88.0, Zep multi-session 83.5) and gbrain's weakest
  strict row (temporal 84.3% reranker off, 89.8% with the reranker on) point
  at the same open problems, measured on different axes.
- **ContextFit fusion QA (81.8% through the official evaluator / 87.2% with
  a GPT-5-mini answerer and local judge; 84.8% in their May note): context
  row, their pipeline end to end.** No gbrain QA-acc number exists, so no
  claim in either direction.
- **gbrain's own other arms (official `recall_all@5`, `longmemeval_s`
  cleaned, 470 scored, k=5, 2026-09-02 at v0.48.2.0): hybrid+expansion
  54.89% (258/470), hybrid-sessdiv 93.40% (439/470), hybrid-sessdiv+rerank
  95.53% (449/470).** Expansion, the LLM multi-query arm that `tokenmax`
  turns on, is harmful at k=5: paired against reranker-off hybrid it loses
  183 questions and gains 3, so no comparison row on this page should be
  read against a `tokenmax` configuration. Session-diversity over-fetch adds
  exactly one question with or without the reranker (93.40% vs 93.19%;
  95.53% vs 95.32%), which says slot starvation is not the miss class on this
  dataset; the remaining misses are ranking misses, mostly temporal-reasoning
  (84.3% reranker off, 89.8% on, 90.6% with over-fetch and reranker). 95.53%
  is the best single number in the run but is not the headline: the headline
  is the default path, 95.32%, and the like-for-like row is 93.19%.

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
  and its distiller is gated on that number (Cat 35: 88.1%).

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
  verbatim anchors, 86 distractors) and gated in CI; the run scores 88.1%
  salient-unit survival with 1.2% distractor leakage (1/86). The reason to
  believe the number: the benchmark has a committed gate it can fail. What
  would make this row rigorous:
  running gbrain's distiller on HaluMem-Medium itself (their corpus, their
  scoring) — filed as the natural follow-up when we take on ConvoMem/LoCoMo.

## PrecisionMemBench (tenurehq, precision-only; 77 single-turn + 12 session cases)

Source: the [tenurehq/precisionmembench](https://github.com/tenurehq/precisionmembench)
README results tables (accessed 2026-09-01). Our full run:
[2026-05-29 report](benchmarks/2026-05-29-precisionmembench.md). The gbrain
rows carry the caveat from that report: they were measured on a harness
that leaked the fixture's `superseded_by` answer key into seed time; the
current harness closes that leak (the hermetic keyword mode measures 0.1361
on it), and the hybrid/adaptive/think rows are **upper bounds pending a keyed
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

- **The supermemory 0.43 @ 819ms row in the 2026-05-29 report does not
  appear in the upstream README** (accessed 2026-09-01; their single-turn
  table shows supermemory at 0.22 @ 69ms). The 0.43 pair is the leaderboard
  revision that report compared against and is unsourced upstream. The mem0
  (0.06) and zep (0.09) rows the report quotes DO match the upstream table.
- **The upstream README carries its own gbrain row**: 0.14 precision at
  0.17 recall, measured by the benchmark author's integration. It matches
  no mode in our report (our default hybrid measures 0.075 precision at
  0.99 recall). A precision of 0.14 alongside 0.17 recall says the
  integrations differ materially; flagged, unreconciled.

### vs gbrain (master, v0.47.8.0)

- **tenure (1.00) — gbrain loses, expected and disclosed.** The author's
  belief store is purpose-built for exactly this benchmark's shape
  (single-belief lookups with supersession chains). gbrain's 0.582
  adaptive mode is the general-purpose runner-up, and even that number is
  an upper bound pending the keyed re-run on the current harness.
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
- [gbrain PR #4787](https://github.com/garrytan/gbrain/pull/4787), the v0.48.0.0 receipt behind the pure-vector 93.8% strict row quoted above.
- LongMemEval official evaluator: [`eval_utils.py`](https://raw.githubusercontent.com/xiaowu0162/LongMemEval/main/src/retrieval/eval_utils.py) and [`print_retrieval_metrics.py`](https://raw.githubusercontent.com/xiaowu0162/LongMemEval/main/src/evaluation/print_retrieval_metrics.py) in [xiaowu0162/LongMemEval](https://github.com/xiaowu0162/LongMemEval); `recall_all@k` / `recall_any@k` definitions, the `_abs` drop, and the session-level k widening. Paper: [arXiv 2410.10813v2](https://arxiv.org/html/2410.10813v2) (Table 3, Appendix E.2, temporal subset, answer-accuracy tables).
- [xiaowu0162/longmemeval-cleaned](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned) (Sept 2025 revision: 1,243 filler sessions removed, all 500 questions and gold labels kept; [oracle file](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json) used to join gold labels for the MemPalace recomputation).
- MemPalace committed per-question result files (accessed 2026-09-02), the inputs to our strict recomputation: [raw ChromaDB](https://github.com/MemPalace/mempalace/blob/main/benchmarks/results_mempal_raw_session_20260414_1629.jsonl), [hybrid_v4 held-out](https://github.com/MemPalace/mempalace/blob/main/benchmarks/results_mempal_hybrid_v4_held_out_session_20260414_1634.jsonl), [hybrid_v4 + LLM rerank](https://github.com/MemPalace/mempalace/blob/main/benchmarks/results_mempal_hybrid_v4_llmrerank_session_20260414_1659.jsonl); plus [issue #29](https://github.com/MemPalace/mempalace/issues/29) (abstention handling; the maintainer's own end-to-end QA figures 66.8% / 67.2% / 53.2%).
- ContextFit repo evidence files: [token-only leaderboard evidence](https://github.com/ContextFit/cf/blob/master/benchmarks/longmemeval_token_only_leaderboard_evidence_20260516.md), [QA evidence](https://github.com/ContextFit/cf/blob/master/benchmarks/longmemeval_contextfit_qa_evidence_20260516.md); pages [fusion 2026-05-19](https://www.context.fit/longmemeval-fusion-20260519.html), ["gbrain_style" 2026-05-25](https://www.context.fit/longmemeval_gbrain_style_contextfit_20260525.html), [fusion QA](https://www.context.fit/longmemeval-fusion-qa-20260519.html). Source of the gold-label leakage caveat (gold-id prefix check + `question_type` routing in the rerank layer).
- [MemCog, arXiv 2605.28046v1](https://arxiv.org/html/2605.28046v1) — 95.80 QA-acc, GPT-4o judge; no retrieval metric on LongMemEval. Its Table 2 baseline "Overall" column is not used here: three cells are column-shifted temporal sub-scores copied from another paper, the mem0 row appears in neither cited source, and the Hindsight row uses a different judge than the caption claims.
- [mem0ai/memory-benchmarks](https://github.com/mem0ai/memory-benchmarks) (the 94.4% = 472/500 count and the `longmemeval_s_cleaned` pin) and [arXiv 2603.04814](https://arxiv.org/html/2603.04814) (independent Mem0 49.00%, GPT-5-mini judge).
- Zep: [arXiv 2501.13956](https://arxiv.org/abs/2501.13956) (2025 paper, gpt-4o reader 71.2%, gpt-4o-mini 63.8%) and [getzep.com/research](https://www.getzep.com/research/) (2026 page, 90.2% with gpt-5.4 reader + judge).
- [vectorize-io/hindsight-benchmarks](https://github.com/vectorize-io/hindsight-benchmarks) and [hindsight.vectorize.io](https://hindsight.vectorize.io/blog/2026/03/23/agent-memory-benchmark) — 91.4% / 89.0% QA-acc; the vendor page's 94.6% is labeled "retrieval accuracy" there, which it is not.
- [byterover.dev blog](https://www.byterover.dev/blog/benchmark_ai_agent_memory_real_production_byterover_top_market_accuracy_longmemeval) — 92.8% / 92.2% QA-acc, Gemini answerer and judge.
- [supermemory.ai/research/longmembench](https://supermemory.ai/research/longmembench/) — the 95% figure, labeled "Recall@k=15 with aggregation" but sitting in the gpt-4o LLM-as-judge table.
- [rohitg00/agentmemory LONGMEMEVAL.md](https://github.com/rohitg00/agentmemory/blob/main/benchmark/LONGMEMEVAL.md) — 95.2% R@5 any-hit, all 500 counted.

## When you add a new comparison row

Cite the source page directly (link to the section + accessed-on date).
Note any caveats the source itself raises (tuning-on-failing-Qs,
experimental-not-production, metric-mismatch). Numbers tables stay neutral
and cited; the "vs gbrain" analysis blocks are explicitly our read — name
the mechanism behind every win AND every loss (an unexplained win is
marketing, an unexplained loss is a bug report waiting to happen), state the
gbrain version analyzed, and never claim a win on a benchmark we haven't
run.
