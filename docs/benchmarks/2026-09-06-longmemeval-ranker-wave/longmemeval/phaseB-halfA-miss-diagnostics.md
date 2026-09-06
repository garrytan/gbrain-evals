# LongMemEval miss diagnostics (Phase B1)

Pins: mode=balanced, reranker=off, autocut=off, expansion_variant_budget=legacy; k=5, depth=200, fused_limit=50, inner_limit=50, reranker_top_n_in=25.
Questions scanned: 500; diagnosed: 10; strict misses: 10; errors: 0.
Embed cache: 2153 hits, 0 misses, 0 bypassed, 0 infra fault(s) (/home/vercel-sandbox/.cache/gbrain-eval/longmemeval-embed.sqlite). Clause sub-query embeds bypass the cache and are not counted.

## What the numbers mean

- **recall_all@k** — Did EVERY gold session for the question land among the distinct sessions in the top k retrieved chunks? A multi-session question with two gold sessions only counts when both are there — this is the evidence-complete rate the answer model actually needs. Abstention (_abs) questions stay out of the denominator unless --include-abstention.
- **vector_rank** — Position (1 = best) of the first chunk of the gold session in the vector arm alone, searched to `depth` rows. null = not found within depth.
- **keyword_rank** — Same position in the keyword (full-text) arm alone. `relaxed` marks an AND→OR fallback hit, which hybrid drops before fusion when the vector arm is healthy.
- **title_rank** — Same position in the page-title arm (session slugs), one page of results.
- **fused_rank** — Position after Reciprocal Rank Fusion of all arms, BEFORE the reranker — over chunk rows (`rows`) and over distinct sessions (`sessions`). From one hybridSearch call at fused_limit under the receipt pins.
- **post_rerank_rank** — Position in the cross-encoder reranked pool from that same call, before autocut / the limit slice. null when the reranker did not run.
- **final_rank** — Position among the rows the fused call actually returned (after autocut and the limit slice).
- **class** — (i) absent from every arm within depth = embedding/lexical recall loss; (ii) present in some arm but outside the fused top-k = fusion demotion / second-clause starvation; (iii) inside the fused top-k but reranked out = reranker limitation; (iv) ceiling = more gold sessions than k, unreachable by construction; rerun_hit = the re-created run puts the gold inside the top-k (the receipt miss did not reproduce under these pins); autocut_dropped / post_fusion_dropped = the gold survived fusion (+rerank) inside the top-k and a later trim removed it.
- **h1_signature** — Second-event starvation signature: the question has ≥2 gold sessions, one sits at fused session rank 1-3 and the missing one at 6-15.
- **splitter_fired** — The frozen clause splitter (between X and Y; first … or …; before/after with two verb phrases; how many days/weeks/months between) produced exactly two sub-queries for the question.
- **h1_supported** — Counterfactual check: some clause sub-query, embedded and searched alone, puts the missing gold session in its vector top-5.
- **h3a** — Candidate generation: the gold is in the vector arm within depth but beyond the pre-fusion pool (`inner_limit`), so fusion never saw it.
- **h3b** — Reranker depth: the gold is in the fused pool but beyond `reranker_top_n_in`, so the reranker never scored it.
- **inner_limit** — Rows each arm hands to fusion for a call at the receipt k: max(2k, PRE_FUSION_POOL_FLOOR) capped at MAX_SEARCH_LIMIT.
- **reranker_top_n_in** — How many fused rows the mode bundle sends to the reranker.
- **split_membership** — Which seeded split lists (dev40 / decision430 / halfA430 / halfB430) each missed question belongs to; Phase B chooses a mechanism on half A and confirms on half B.

## Misses by question_type × class (questions, primary class)

| question_type | ii_in_pool_fused_out | iv_ceiling | total |
|---|---:|---:|---:|
| single-session-user | 1 | 0 | 1 |
| temporal-reasoning | 8 | 1 | 9 |

## Missing gold sessions by class

| class | sessions |
|---|---:|
| ii_in_pool_fused_out | 12 |
| iv_ceiling | 2 |

## Hypothesis counters

| counter | n |
|---|---:|
| h1_signature | 4 |
| splitter_fired | 2 |
| h1_supported (clause top-5 contains missing gold) | 1 |
| h3a (vector top-200, outside inner_limit 50) | 0 |
| h3b (fused pool, beyond reranker_top_n_in 25) | 0 |
| autocut_dropped | 0 |
| rerun_hit (receipt miss did not reproduce) | 0 |

## Split membership of the misses

| split | misses |
|---|---:|
| dev40 | 0 |
| decision430 | 10 |
| halfA430 | 10 |
| halfB430 | 0 |
| halfA470 | 4 |
| halfB470 | 6 |
| unsplit | 0 |

## Per-question itemization

Ranks are `vector / keyword / title / fused(rows;sessions) / post-rerank(rows) / final(rows)` per gold session; `—` = not found. Hypotheses: H1sig, split(pattern), H1sup, H3a, H3b.

| question_id | type | splits | gold | missing | per-gold ranks | class | hypotheses |
|---|---|---|---|---|---|---|---|
| 5d3d2817 | single-session-user | decision430, halfA430, halfB470 | answer_235eb6fb | answer_235eb6fb | answer_235eb6fb*: 15/6r/—/15;15/—/15 [ii_in_pool_fused_out] | ii_in_pool_fused_out | — |
| b46e15ed | temporal-reasoning | decision430, halfA430, halfA470 | answer_4bfcc250_4, answer_4bfcc250_3, answer_4bfcc250_2, answer_4bfcc250_1 | answer_4bfcc250_4, answer_4bfcc250_2 | answer_4bfcc250_4*: 14/5r/—/14;14/—/14 [ii_in_pool_fused_out]<br>answer_4bfcc250_3: 3/3r/—/3;3/—/3 [hit]<br>answer_4bfcc250_2*: 20/6r/—/20;20/—/— [ii_in_pool_fused_out]<br>answer_4bfcc250_1: 1/1r/—/1;1/—/1 [hit] | ii_in_pool_fused_out | H1sig |
| af082822 | temporal-reasoning | decision430, halfA430, halfB470 | answer_b51b6115_1 | answer_b51b6115_1 | answer_b51b6115_1*: 15/1r/—/15;15/—/15 [ii_in_pool_fused_out] | ii_in_pool_fused_out | — |
| gpt4_7f6b06db | temporal-reasoning | decision430, halfA430, halfB470 | answer_5d8c99d3_1, answer_5d8c99d3_2, answer_5d8c99d3_3 | answer_5d8c99d3_1, answer_5d8c99d3_3 | answer_5d8c99d3_1*: 6/8r/—/6;6/—/6 [ii_in_pool_fused_out]<br>answer_5d8c99d3_2: 2/5r/—/2;2/—/2 [hit]<br>answer_5d8c99d3_3*: 7/7r/—/7;7/—/7 [ii_in_pool_fused_out] | ii_in_pool_fused_out | H1sig |
| gpt4_468eb063 | temporal-reasoning | decision430, halfA430, halfB470 | answer_9b09d95b_1 | answer_9b09d95b_1 | answer_9b09d95b_1*: 6/18r/—/6;6/—/6 [ii_in_pool_fused_out] | ii_in_pool_fused_out | — |
| gpt4_21adecb5 | temporal-reasoning | decision430, halfA430, halfA470 | answer_1e2369c9_1, answer_1e2369c9_2 | answer_1e2369c9_1 | answer_1e2369c9_1*: 8/1r/—/8;8/—/8 [ii_in_pool_fused_out]<br>answer_1e2369c9_2: 4/2r/—/4;4/—/4 [hit] | ii_in_pool_fused_out | split(how_many_between) |
| gpt4_4929293b | temporal-reasoning | decision430, halfA430, halfB470 | answer_add9b013_2, answer_add9b013_1 | answer_add9b013_2 | answer_add9b013_2*: 6/30r/—/6;6/—/6 [ii_in_pool_fused_out]<br>answer_add9b013_1: 3/26r/—/3;3/—/3 [hit] | ii_in_pool_fused_out | H1sig |
| gpt4_68e94288 | temporal-reasoning | decision430, halfA430, halfB470 | answer_9793daa4_2, answer_9793daa4_1 | answer_9793daa4_2, answer_9793daa4_1 | answer_9793daa4_2*: 6/20r/—/6;6/—/6 [ii_in_pool_fused_out]<br>answer_9793daa4_1*: 7/8r/—/7;7/—/7 [ii_in_pool_fused_out] | ii_in_pool_fused_out | — |
| a3838d2b | temporal-reasoning | decision430, halfA430, halfA470 | answer_4ffa04a2_1, answer_4ffa04a2_6, answer_4ffa04a2_4, answer_4ffa04a2_3, answer_4ffa04a2_5, answer_4ffa04a2_2 | answer_4ffa04a2_3, answer_4ffa04a2_5 | answer_4ffa04a2_1: 1/1/—/1;1/—/1 [hit]<br>answer_4ffa04a2_6: 2/2/—/2;2/—/2 [hit]<br>answer_4ffa04a2_4: 3/—/—/4;3/—/4 [hit]<br>answer_4ffa04a2_3*: 8/—/—/9;8/—/9 [iv_ceiling]<br>answer_4ffa04a2_5*: 5/—/—/6;5/—/6 [iv_ceiling]<br>answer_4ffa04a2_2: 4/—/—/5;4/—/5 [hit] | iv_ceiling | H1sig, split(before_after), H1sup |
| gpt4_93f6379c | temporal-reasoning | decision430, halfA430, halfA470 | answer_544fe66c_2, answer_544fe66c_1, answer_544fe66c_3 | answer_544fe66c_2 | answer_544fe66c_2*: 3/—/—/6;6/—/6 [ii_in_pool_fused_out]<br>answer_544fe66c_1: 2/—/—/5;5/—/5 [hit]<br>answer_544fe66c_3: 1/1/—/4;4/—/4 [hit] | ii_in_pool_fused_out | — |
