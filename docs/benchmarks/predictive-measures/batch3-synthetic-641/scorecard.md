# Live-recall scorecard

gbrain 0.60.641.0 (2560ffddb), schema 297, pglite, barrier: copy, pgvector 0.8.1, mode: tokenmax. Synthetic brain, Voyage embeddings and rerank (voyage:voyage-4, voyage:rerank-2.5).
Protocol: batch3; primary comparisons (Holm family of two): p1_configured_vs_hybrid_lexical_freshness (P1), p2_configured_vs_hybrid_lexical_entity (P2).
Synthetic conditions brain c2dcf99f4775: unembedded chunk share 0 (0 of 174 chunks), synopsis vectors on, keyword candidate bound none, shell page share 0.
Visibility epoch (GBRA-398): run post_gbra_398, freeze none (fixture).
Question forms eligible: 120 of 120 (questions loaded: 60, dropped for an absent gold page: 0).

## Arms, all queries (both forms)

| Arm | n | success@1 | success@5 (95% CI) | success@10 | success@20 | MRR | pages returned |
|---|---|---|---|---|---|---|---|
| keyword | 120 | 40.0 | 50.0 (50.0–50.0) | 50.0 | 50.0 | 0.4333 | 0.775 |
| vector | 120 | 73.3 | 100.0 (100.0–100.0) | 100.0 | 100.0 | 0.8482 | 20 |
| hybrid_lexical | 120 | 60.8 | 95.8 (91.7–99.2) | 95.8 | 95.8 | 0.7225 | 11.6417 |
| hybrid | 120 | 78.3 | 99.2 (97.5–100.0) | 100.0 | 100.0 | 0.8671 | 20 |
| configured | 120 | 65.0 | 100.0 (100.0–100.0) | 100.0 | 100.0 | 0.809 | 20 |
| configured_window | invalid: no_eligible_queries | | | | | | |

## success@5 by type and form

| Arm | Type | exact n | exact | paraphrase n | paraphrase |
|---|---|---|---|---|---|
| keyword | identifier | 0 | n/a | 0 | n/a |
| keyword | error_string | 0 | n/a | 0 | n/a |
| keyword | time_window | 0 | n/a | 0 | n/a |
| keyword | cross_source | 0 | n/a | 0 | n/a |
| keyword | topic | 0 | n/a | 0 | n/a |
| keyword | freshness | 30 | 100.0 | 30 | 0.0 |
| keyword | entity | 30 | 100.0 | 30 | 0.0 |
| vector | identifier | 0 | n/a | 0 | n/a |
| vector | error_string | 0 | n/a | 0 | n/a |
| vector | time_window | 0 | n/a | 0 | n/a |
| vector | cross_source | 0 | n/a | 0 | n/a |
| vector | topic | 0 | n/a | 0 | n/a |
| vector | freshness | 30 | 100.0 | 30 | 100.0 |
| vector | entity | 30 | 100.0 | 30 | 100.0 |
| hybrid_lexical | identifier | 0 | n/a | 0 | n/a |
| hybrid_lexical | error_string | 0 | n/a | 0 | n/a |
| hybrid_lexical | time_window | 0 | n/a | 0 | n/a |
| hybrid_lexical | cross_source | 0 | n/a | 0 | n/a |
| hybrid_lexical | topic | 0 | n/a | 0 | n/a |
| hybrid_lexical | freshness | 30 | 100.0 | 30 | 93.3 |
| hybrid_lexical | entity | 30 | 100.0 | 30 | 90.0 |
| hybrid | identifier | 0 | n/a | 0 | n/a |
| hybrid | error_string | 0 | n/a | 0 | n/a |
| hybrid | time_window | 0 | n/a | 0 | n/a |
| hybrid | cross_source | 0 | n/a | 0 | n/a |
| hybrid | topic | 0 | n/a | 0 | n/a |
| hybrid | freshness | 30 | 100.0 | 30 | 100.0 |
| hybrid | entity | 30 | 100.0 | 30 | 96.7 |
| configured | identifier | 0 | n/a | 0 | n/a |
| configured | error_string | 0 | n/a | 0 | n/a |
| configured | time_window | 0 | n/a | 0 | n/a |
| configured | cross_source | 0 | n/a | 0 | n/a |
| configured | topic | 0 | n/a | 0 | n/a |
| configured | freshness | 30 | 100.0 | 30 | 100.0 |
| configured | entity | 30 | 100.0 | 30 | 100.0 |

## Freshness: stale page ranked above the gold

| Arm | n | stale-first (95% CI) | exact | paraphrase |
|---|---|---|---|---|
| keyword | 60 | 20.0 (11.7–28.3) | 40.0 | 0.0 |
| vector | 60 | 30.0 (16.7–43.3) | 33.3 | 26.7 |
| hybrid_lexical | 60 | 50.0 (33.3–66.7) | 40.0 | 60.0 |
| hybrid | 60 | 28.3 (13.3–45.0) | 30.0 | 26.7 |
| configured | 60 | 25.0 (11.7–40.0) | 33.3 | 16.7 |

## Paired comparisons (delta = B minus A)

| Comparison | Metric | Pairs | A | B | Delta (95% CI) | p | Holm p | MDE |
|---|---|---|---|---|---|---|---|---|
| p1_configured_vs_hybrid_lexical_freshness (P1) | success_at_5 | 60 | 96.7 | 100.0 | 3.3 (0.0 to 8.3) | 0.4996 | 0.4996 | 6.5 |
| p1_configured_vs_hybrid_lexical_freshness (P1) | mrr | 60 | 0.599 | 0.844 | 0.245 (0.174 to 0.323) | 0.0001 |  | 0.109 |
| p2_configured_vs_hybrid_lexical_entity (P2) | success_at_5 | 60 | 95.0 | 100.0 | 5.0 (0.0 to 10.0) | 0.2466 | 0.4932 | 7.8 |
| p2_configured_vs_hybrid_lexical_entity (P2) | mrr | 60 | 0.846 | 0.774 | -0.072 (-0.177 to 0.034) | 0.2038 |  | 0.154 |
| hybrid_vs_hybrid_lexical_freshness | success_at_5 | 60 | 96.7 | 100.0 | 3.3 (0.0 to 8.3) | 0.4996 |  | 6.5 |
| hybrid_vs_hybrid_lexical_freshness | mrr | 60 | 0.599 | 0.800 | 0.201 (0.134 to 0.273) | 0.0001 |  | 0.101 |
| hybrid_vs_hybrid_lexical_entity | success_at_5 | 60 | 95.0 | 98.3 | 3.3 (-3.3 to 10.0) | 0.6237 |  | 9.3 |
| hybrid_vs_hybrid_lexical_entity | mrr | 60 | 0.846 | 0.934 | 0.089 (0.039 to 0.143) | 0.0021 |  | 0.075 |
| configured_vs_keyword_freshness | success_at_5 | 60 | 50.0 | 100.0 | 50.0 (50.0 to 50.0) | 0.0001 |  | n/a |
| configured_vs_keyword_freshness | mrr | 60 | 0.367 | 0.844 | 0.478 (0.428 to 0.531) | 0.0001 |  | 0.074 |
| configured_vs_keyword_entity | success_at_5 | 60 | 50.0 | 100.0 | 50.0 (50.0 to 50.0) | 0.0001 |  | n/a |
| configured_vs_keyword_entity | mrr | 60 | 0.500 | 0.774 | 0.274 (0.192 to 0.353) | 0.0001 |  | 0.117 |
| batch2_p1_hybrid_vs_hybrid_lexical_paraphrase | success_at_5 | 60 | 91.7 | 98.3 | 6.7 (0.0 to 15.0) | 0.2198 |  | 11.3 |
| batch2_p1_hybrid_vs_hybrid_lexical_paraphrase | mrr | 60 | 0.578 | 0.840 | 0.261 (0.181 to 0.346) | 0.0001 |  | 0.117 |
| hybrid_lexical_vs_keyword | success_at_5 | 120 | 50.0 | 95.8 | 45.8 (41.7 to 49.2) | 0.0001 |  | 5.0 |
| hybrid_lexical_vs_keyword | mrr | 120 | 0.433 | 0.723 | 0.289 (0.242 to 0.337) | 0.0001 |  | 0.069 |
| hybrid_vs_keyword | success_at_5 | 120 | 50.0 | 99.2 | 49.2 (47.5 to 50.0) | 0.0001 |  | 2.3 |
| hybrid_vs_keyword | mrr | 120 | 0.433 | 0.867 | 0.434 (0.395 to 0.470) | 0.0001 |  | 0.053 |
| configured_vs_keyword_paraphrase | success_at_5 | 60 | 0.0 | 100.0 | 100.0 (100.0 to 100.0) | 0.0001 |  | n/a |
| configured_vs_keyword_paraphrase | mrr | 60 | 0.000 | 0.799 | 0.799 (0.728 to 0.864) | 0.0001 |  | 0.098 |
| configured_vs_hybrid | success_at_5 | 120 | 99.2 | 100.0 | 0.8 (0.0 to 2.5) | 1 |  | 2.3 |
| configured_vs_hybrid | mrr | 120 | 0.867 | 0.809 | -0.058 (-0.126 to 0.008) | 0.0987 |  | 0.097 |
| vector_vs_keyword | success_at_5 | 120 | 50.0 | 100.0 | 50.0 (50.0 to 50.0) | 0.0001 |  | n/a |
| vector_vs_keyword | mrr | 120 | 0.433 | 0.848 | 0.415 (0.367 to 0.457) | 0.0001 |  | 0.066 |
| configured_vs_keyword_exact | success_at_5 | 60 | 100.0 | 100.0 | 0.0 (0.0 to 0.0) | 1 |  | n/a |
| configured_vs_keyword_exact | mrr | 60 | 0.867 | 0.819 | -0.047 (-0.108 to 0.011) | 0.1587 |  | 0.087 |
| hybrid_vs_keyword_paraphrase | success_at_5 | 60 | 0.0 | 98.3 | 98.3 (95.0 to 100.0) | 0.0001 |  | 4.7 |
| hybrid_vs_keyword_paraphrase | mrr | 60 | 0.000 | 0.840 | 0.840 (0.765 to 0.908) | 0.0001 |  | 0.103 |
| window_vs_configured | skipped: arm_invalid_or_absent | | | | | | | |
| paraphrase_vs_exact_keyword | success_at_5 | 60 | 100.0 | 0.0 | -100.0 (-100.0 to -100.0) | 0.0001 |  | n/a |
| paraphrase_vs_exact_keyword | mrr | 60 | 0.867 | 0.000 | -0.867 (-0.933 to -0.800) | 0.0001 |  | 0.097 |
| paraphrase_vs_exact_vector | success_at_5 | 60 | 100.0 | 100.0 | 0.0 (0.0 to 0.0) | 1 |  | n/a |
| paraphrase_vs_exact_vector | mrr | 60 | 0.842 | 0.855 | 0.013 (-0.035 to 0.063) | 0.6263 |  | 0.071 |
| paraphrase_vs_exact_hybrid_lexical | success_at_5 | 60 | 100.0 | 91.7 | -8.3 (-16.7 to -1.7) | 0.0662 |  | 10.1 |
| paraphrase_vs_exact_hybrid_lexical | mrr | 60 | 0.867 | 0.578 | -0.288 (-0.376 to -0.203) | 0.0001 |  | 0.124 |
| paraphrase_vs_exact_hybrid | success_at_5 | 60 | 100.0 | 98.3 | -1.7 (-5.0 to 0.0) | 1 |  | 4.7 |
| paraphrase_vs_exact_hybrid | mrr | 60 | 0.894 | 0.840 | -0.055 (-0.117 to 0.000) | 0.083 |  | 0.083 |
| paraphrase_vs_exact_configured | success_at_5 | 60 | 100.0 | 100.0 | 0.0 (0.0 to 0.0) | 1 |  | n/a |
| paraphrase_vs_exact_configured | mrr | 60 | 0.819 | 0.799 | -0.021 (-0.085 to 0.042) | 0.5747 |  | 0.090 |

## Custody

Read-only verified at start: true, at end: true. Guard refusals by verb: analyze 63, telemetry_write 9.
Exclusions: none.
Latency is harness latency (pool size 2, local database), not production latency. configured keeps gbrain's own default result limit, so its pages-returned column shows how deep success@10 and success@20 can reach.
