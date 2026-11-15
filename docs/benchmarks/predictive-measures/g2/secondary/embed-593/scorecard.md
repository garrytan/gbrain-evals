# Live-recall scorecard

gbrain 0.60.593.0 (27f8b9d62), schema 291, pglite, barrier: copy, pgvector 0.8.1, mode: tokenmax. Synthetic brain, Voyage embeddings and rerank (voyage:voyage-4, voyage:rerank-2.5).
Protocol: batch2; primary comparisons (Holm family of two): p1_hybrid_vs_hybrid_lexical_paraphrase (P1), p2_configured_vs_hybrid_lexical_paraphrase (P2).
Synthetic conditions brain e6e4042248d7: unembedded chunk share 0.1 (18 of 180 chunks), synopsis vectors off, keyword candidate bound none, shell page share 0.
Question forms eligible: 200 of 200 (questions loaded: 100, dropped for an absent gold page: 0).

## Arms, all queries (both forms)

| Arm | n | success@1 | success@5 (95% CI) | success@10 | success@20 | MRR | pages returned |
|---|---|---|---|---|---|---|---|
| keyword | 200 | 38.5 | 38.5 (34.5–42.5) | 38.5 | 38.5 | 0.385 | 0.385 |
| vector | 200 | 81.5 | 89.5 (83.0–95.0) | 90.0 | 90.0 | 0.8513 | 20 |
| hybrid_lexical | 200 | 63.0 | 79.0 (74.0–84.0) | 84.5 | 93.0 | 0.6997 | 13.735 |
| hybrid | 200 | 84.5 | 90.0 (84.0–95.5) | 92.0 | 93.5 | 0.8721 | 20 |
| configured | 200 | 90.5 | 93.5 (89.0–97.0) | 93.5 | 93.5 | 0.92 | 20 |
| configured_window | 30 | 100.0 | 100.0 (100.0–100.0) | 100.0 | 100.0 | 1 | 4.6667 |

## success@5 by type and form

| Arm | Type | exact n | exact | paraphrase n | paraphrase |
|---|---|---|---|---|---|
| keyword | identifier | 20 | 35.0 | 20 | 0.0 |
| keyword | error_string | 20 | 100.0 | 20 | 0.0 |
| keyword | time_window | 20 | 100.0 | 20 | 0.0 |
| keyword | cross_source | 20 | 50.0 | 20 | 0.0 |
| keyword | topic | 20 | 100.0 | 20 | 0.0 |
| vector | identifier | 20 | 80.0 | 20 | 80.0 |
| vector | error_string | 20 | 90.0 | 20 | 90.0 |
| vector | time_window | 20 | 90.0 | 20 | 90.0 |
| vector | cross_source | 20 | 95.0 | 20 | 90.0 |
| vector | topic | 20 | 95.0 | 20 | 95.0 |
| hybrid_lexical | identifier | 20 | 100.0 | 20 | 50.0 |
| hybrid_lexical | error_string | 20 | 100.0 | 20 | 85.0 |
| hybrid_lexical | time_window | 20 | 100.0 | 20 | 40.0 |
| hybrid_lexical | cross_source | 20 | 100.0 | 20 | 65.0 |
| hybrid_lexical | topic | 20 | 100.0 | 20 | 50.0 |
| hybrid | identifier | 20 | 80.0 | 20 | 80.0 |
| hybrid | error_string | 20 | 90.0 | 20 | 90.0 |
| hybrid | time_window | 20 | 90.0 | 20 | 90.0 |
| hybrid | cross_source | 20 | 95.0 | 20 | 90.0 |
| hybrid | topic | 20 | 100.0 | 20 | 95.0 |
| configured | identifier | 20 | 85.0 | 20 | 80.0 |
| configured | error_string | 20 | 100.0 | 20 | 90.0 |
| configured | time_window | 20 | 100.0 | 20 | 90.0 |
| configured | cross_source | 20 | 100.0 | 20 | 95.0 |
| configured | topic | 20 | 100.0 | 20 | 95.0 |
| configured_window | identifier | 0 | n/a | 0 | n/a |
| configured_window | error_string | 0 | n/a | 0 | n/a |
| configured_window | time_window | 15 | 100.0 | 15 | 100.0 |
| configured_window | cross_source | 0 | n/a | 0 | n/a |
| configured_window | topic | 0 | n/a | 0 | n/a |

## Paired comparisons (delta = B minus A)

| Comparison | Metric | Pairs | A | B | Delta (95% CI) | p | Holm p | MDE |
|---|---|---|---|---|---|---|---|---|
| p1_hybrid_vs_hybrid_lexical_paraphrase (P1) | success_at_5 | 100 | 58.0 | 89.0 | 31.0 (20.0 to 42.0) | 0.0001 | 0.0002 | 15.8 |
| p1_hybrid_vs_hybrid_lexical_paraphrase (P1) | mrr | 100 | 0.399 | 0.835 | 0.436 (0.342 to 0.525) | 0.0001 |  | 0.131 |
| p2_configured_vs_hybrid_lexical_paraphrase (P2) | success_at_5 | 100 | 58.0 | 90.0 | 32.0 (21.0 to 43.0) | 0.0001 | 0.0002 | 15.4 |
| p2_configured_vs_hybrid_lexical_paraphrase (P2) | mrr | 100 | 0.399 | 0.870 | 0.471 (0.378 to 0.559) | 0.0001 |  | 0.128 |
| batch1_p1_hybrid_vs_hybrid_lexical | success_at_5 | 200 | 79.0 | 90.0 | 11.0 (3.5 to 18.0) | 0.0053 |  | 10.3 |
| batch1_p1_hybrid_vs_hybrid_lexical | mrr | 200 | 0.700 | 0.872 | 0.172 (0.105 to 0.233) | 0.0001 |  | 0.090 |
| hybrid_lexical_vs_keyword | success_at_5 | 200 | 38.5 | 79.0 | 40.5 (34.5 to 46.5) | 0.0001 |  | 8.8 |
| hybrid_lexical_vs_keyword | mrr | 200 | 0.385 | 0.700 | 0.315 (0.262 to 0.369) | 0.0001 |  | 0.076 |
| hybrid_vs_keyword | success_at_5 | 200 | 38.5 | 90.0 | 51.5 (44.5 to 58.5) | 0.0001 |  | 9.8 |
| hybrid_vs_keyword | mrr | 200 | 0.385 | 0.872 | 0.487 (0.418 to 0.554) | 0.0001 |  | 0.097 |
| configured_vs_keyword_paraphrase | success_at_5 | 100 | 0.0 | 90.0 | 90.0 (84.0 to 95.0) | 0.0001 |  | 8.5 |
| configured_vs_keyword_paraphrase | mrr | 100 | 0.000 | 0.870 | 0.870 (0.805 to 0.925) | 0.0001 |  | 0.088 |
| configured_vs_hybrid | success_at_5 | 200 | 90.0 | 93.5 | 3.5 (1.5 to 6.0) | 0.0139 |  | 3.6 |
| configured_vs_hybrid | mrr | 200 | 0.872 | 0.920 | 0.048 (0.021 to 0.077) | 0.0012 |  | 0.041 |
| vector_vs_keyword | success_at_5 | 200 | 38.5 | 89.5 | 51.0 (43.5 to 58.0) | 0.0001 |  | 10.2 |
| vector_vs_keyword | mrr | 200 | 0.385 | 0.851 | 0.466 (0.392 to 0.538) | 0.0001 |  | 0.104 |
| configured_vs_keyword_exact | success_at_5 | 100 | 77.0 | 97.0 | 20.0 (13.0 to 28.0) | 0.0001 |  | 11.3 |
| configured_vs_keyword_exact | mrr | 100 | 0.770 | 0.970 | 0.200 (0.130 to 0.280) | 0.0001 |  | 0.113 |
| hybrid_vs_keyword_paraphrase | success_at_5 | 100 | 0.0 | 89.0 | 89.0 (83.0 to 95.0) | 0.0001 |  | 8.8 |
| hybrid_vs_keyword_paraphrase | mrr | 100 | 0.000 | 0.835 | 0.835 (0.765 to 0.898) | 0.0001 |  | 0.094 |
| window_vs_configured | success_at_5 | 30 | 100.0 | 100.0 | 0.0 (0.0 to 0.0) | 1 |  | n/a |
| window_vs_configured | mrr | 30 | 0.967 | 1.000 | 0.033 (0.000 to 0.083) | 0.5 |  | 0.064 |
| paraphrase_vs_exact_keyword | success_at_5 | 100 | 77.0 | 0.0 | -77.0 (-85.0 to -69.0) | 0.0001 |  | 11.8 |
| paraphrase_vs_exact_keyword | mrr | 100 | 0.770 | 0.000 | -0.770 (-0.850 to -0.690) | 0.0001 |  | 0.118 |
| paraphrase_vs_exact_vector | success_at_5 | 100 | 90.0 | 89.0 | -1.0 (-3.0 to 0.0) | 1 |  | 2.8 |
| paraphrase_vs_exact_vector | mrr | 100 | 0.863 | 0.840 | -0.022 (-0.063 to 0.018) | 0.2946 |  | 0.058 |
| paraphrase_vs_exact_hybrid_lexical | success_at_5 | 100 | 100.0 | 58.0 | -42.0 (-52.0 to -32.0) | 0.0001 |  | 13.9 |
| paraphrase_vs_exact_hybrid_lexical | mrr | 100 | 1.000 | 0.399 | -0.601 (-0.674 to -0.523) | 0.0001 |  | 0.108 |
| paraphrase_vs_exact_hybrid | success_at_5 | 100 | 91.0 | 89.0 | -2.0 (-5.0 to 0.0) | 0.5086 |  | 3.9 |
| paraphrase_vs_exact_hybrid | mrr | 100 | 0.909 | 0.835 | -0.074 (-0.121 to -0.032) | 0.0009 |  | 0.063 |
| paraphrase_vs_exact_configured | success_at_5 | 100 | 97.0 | 90.0 | -7.0 (-12.0 to -3.0) | 0.014 |  | 7.2 |
| paraphrase_vs_exact_configured | mrr | 100 | 0.970 | 0.870 | -0.100 (-0.155 to -0.050) | 0.0002 |  | 0.077 |

## Custody

Read-only verified at start: true, at end: true. Guard refusals by verb: analyze 107, telemetry_write 20.
Exclusions: none.
Latency is harness latency (pool size 2, local database), not production latency. configured keeps gbrain's own default result limit, so its pages-returned column shows how deep success@10 and success@20 can reach.
