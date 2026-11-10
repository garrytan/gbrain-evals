# Live-recall scorecard

gbrain 0.60.593.0 (27f8b9d62), schema 291, pglite, barrier: copy, pgvector 0.8.1, mode: tokenmax. Synthetic brain, Voyage embeddings and rerank (voyage:voyage-4, voyage:rerank-2.5).
Protocol: batch2; primary comparisons (Holm family of two): p1_hybrid_vs_hybrid_lexical_paraphrase (P1), p2_configured_vs_hybrid_lexical_paraphrase (P2).
Synthetic conditions brain 8939cf0c2ceb: unembedded chunk share 0 (0 of 180 chunks), synopsis vectors on, keyword candidate bound none, shell page share 0.
Question forms eligible: 200 of 200 (questions loaded: 100, dropped for an absent gold page: 0).

## Arms, all queries (both forms)

| Arm | n | success@1 | success@5 (95% CI) | success@10 | success@20 | MRR | pages returned |
|---|---|---|---|---|---|---|---|
| keyword | 200 | 38.5 | 38.5 (34.5–42.5) | 38.5 | 38.5 | 0.385 | 0.385 |
| vector | 200 | 91.5 | 99.5 (98.5–100.0) | 100.0 | 100.0 | 0.9534 | 20 |
| hybrid_lexical | 200 | 63.0 | 79.0 (74.0–84.0) | 84.5 | 93.0 | 0.6997 | 13.735 |
| hybrid | 200 | 93.5 | 99.5 (98.5–100.0) | 100.0 | 100.0 | 0.9634 | 20 |
| configured | 200 | 96.5 | 100.0 (100.0–100.0) | 100.0 | 100.0 | 0.9825 | 20 |
| configured_window | 30 | 100.0 | 100.0 (100.0–100.0) | 100.0 | 100.0 | 1 | 5.2667 |

## success@5 by type and form

| Arm | Type | exact n | exact | paraphrase n | paraphrase |
|---|---|---|---|---|---|
| keyword | identifier | 20 | 35.0 | 20 | 0.0 |
| keyword | error_string | 20 | 100.0 | 20 | 0.0 |
| keyword | time_window | 20 | 100.0 | 20 | 0.0 |
| keyword | cross_source | 20 | 50.0 | 20 | 0.0 |
| keyword | topic | 20 | 100.0 | 20 | 0.0 |
| vector | identifier | 20 | 100.0 | 20 | 100.0 |
| vector | error_string | 20 | 100.0 | 20 | 100.0 |
| vector | time_window | 20 | 100.0 | 20 | 100.0 |
| vector | cross_source | 20 | 100.0 | 20 | 95.0 |
| vector | topic | 20 | 100.0 | 20 | 100.0 |
| hybrid_lexical | identifier | 20 | 100.0 | 20 | 50.0 |
| hybrid_lexical | error_string | 20 | 100.0 | 20 | 85.0 |
| hybrid_lexical | time_window | 20 | 100.0 | 20 | 40.0 |
| hybrid_lexical | cross_source | 20 | 100.0 | 20 | 65.0 |
| hybrid_lexical | topic | 20 | 100.0 | 20 | 50.0 |
| hybrid | identifier | 20 | 100.0 | 20 | 100.0 |
| hybrid | error_string | 20 | 100.0 | 20 | 100.0 |
| hybrid | time_window | 20 | 100.0 | 20 | 100.0 |
| hybrid | cross_source | 20 | 100.0 | 20 | 95.0 |
| hybrid | topic | 20 | 100.0 | 20 | 100.0 |
| configured | identifier | 20 | 100.0 | 20 | 100.0 |
| configured | error_string | 20 | 100.0 | 20 | 100.0 |
| configured | time_window | 20 | 100.0 | 20 | 100.0 |
| configured | cross_source | 20 | 100.0 | 20 | 100.0 |
| configured | topic | 20 | 100.0 | 20 | 100.0 |
| configured_window | identifier | 0 | n/a | 0 | n/a |
| configured_window | error_string | 0 | n/a | 0 | n/a |
| configured_window | time_window | 15 | 100.0 | 15 | 100.0 |
| configured_window | cross_source | 0 | n/a | 0 | n/a |
| configured_window | topic | 0 | n/a | 0 | n/a |

## Paired comparisons (delta = B minus A)

| Comparison | Metric | Pairs | A | B | Delta (95% CI) | p | Holm p | MDE |
|---|---|---|---|---|---|---|---|---|
| p1_hybrid_vs_hybrid_lexical_paraphrase (P1) | success_at_5 | 100 | 58.0 | 99.0 | 41.0 (31.0 to 51.0) | 0.0001 | 0.0002 | 14.4 |
| p1_hybrid_vs_hybrid_lexical_paraphrase (P1) | mrr | 100 | 0.399 | 0.927 | 0.527 (0.447 to 0.605) | 0.0001 |  | 0.113 |
| p2_configured_vs_hybrid_lexical_paraphrase (P2) | success_at_5 | 100 | 58.0 | 100.0 | 42.0 (32.0 to 52.0) | 0.0001 | 0.0002 | 13.9 |
| p2_configured_vs_hybrid_lexical_paraphrase (P2) | mrr | 100 | 0.399 | 0.965 | 0.566 (0.489 to 0.640) | 0.0001 |  | 0.107 |
| batch1_p1_hybrid_vs_hybrid_lexical | success_at_5 | 200 | 79.0 | 99.5 | 20.5 (15.5 to 25.5) | 0.0001 |  | 7.2 |
| batch1_p1_hybrid_vs_hybrid_lexical | mrr | 200 | 0.700 | 0.963 | 0.264 (0.224 to 0.303) | 0.0001 |  | 0.056 |
| hybrid_lexical_vs_keyword | success_at_5 | 200 | 38.5 | 79.0 | 40.5 (34.5 to 46.5) | 0.0001 |  | 8.8 |
| hybrid_lexical_vs_keyword | mrr | 200 | 0.385 | 0.700 | 0.315 (0.262 to 0.369) | 0.0001 |  | 0.076 |
| hybrid_vs_keyword | success_at_5 | 200 | 38.5 | 99.5 | 61.0 (57.0 to 65.5) | 0.0001 |  | 6.2 |
| hybrid_vs_keyword | mrr | 200 | 0.385 | 0.963 | 0.578 (0.529 to 0.628) | 0.0001 |  | 0.070 |
| configured_vs_keyword_paraphrase | success_at_5 | 100 | 0.0 | 100.0 | 100.0 (100.0 to 100.0) | 0.0001 |  | n/a |
| configured_vs_keyword_paraphrase | mrr | 100 | 0.000 | 0.965 | 0.965 (0.940 to 0.990) | 0.0001 |  | 0.036 |
| configured_vs_hybrid | success_at_5 | 200 | 99.5 | 100.0 | 0.5 (0.0 to 1.5) | 1 |  | 1.4 |
| configured_vs_hybrid | mrr | 200 | 0.963 | 0.983 | 0.019 (-0.001 to 0.041) | 0.0942 |  | 0.030 |
| vector_vs_keyword | success_at_5 | 200 | 38.5 | 99.5 | 61.0 (57.0 to 65.5) | 0.0001 |  | 6.2 |
| vector_vs_keyword | mrr | 200 | 0.385 | 0.953 | 0.568 (0.516 to 0.621) | 0.0001 |  | 0.075 |
| configured_vs_keyword_exact | success_at_5 | 100 | 77.0 | 100.0 | 23.0 (15.0 to 31.0) | 0.0001 |  | 11.8 |
| configured_vs_keyword_exact | mrr | 100 | 0.770 | 1.000 | 0.230 (0.150 to 0.310) | 0.0001 |  | 0.118 |
| hybrid_vs_keyword_paraphrase | success_at_5 | 100 | 0.0 | 99.0 | 99.0 (97.0 to 100.0) | 0.0001 |  | 2.8 |
| hybrid_vs_keyword_paraphrase | mrr | 100 | 0.000 | 0.927 | 0.927 (0.887 to 0.963) | 0.0001 |  | 0.055 |
| window_vs_configured | success_at_5 | 30 | 100.0 | 100.0 | 0.0 (0.0 to 0.0) | 1 |  | n/a |
| window_vs_configured | mrr | 30 | 0.950 | 1.000 | 0.050 (0.000 to 0.100) | 0.25 |  | 0.075 |
| paraphrase_vs_exact_keyword | success_at_5 | 100 | 77.0 | 0.0 | -77.0 (-85.0 to -69.0) | 0.0001 |  | 11.8 |
| paraphrase_vs_exact_keyword | mrr | 100 | 0.770 | 0.000 | -0.770 (-0.850 to -0.690) | 0.0001 |  | 0.118 |
| paraphrase_vs_exact_vector | success_at_5 | 100 | 100.0 | 99.0 | -1.0 (-3.0 to 0.0) | 1 |  | 2.8 |
| paraphrase_vs_exact_vector | mrr | 100 | 0.975 | 0.932 | -0.043 (-0.080 to -0.008) | 0.0293 |  | 0.052 |
| paraphrase_vs_exact_hybrid_lexical | success_at_5 | 100 | 100.0 | 58.0 | -42.0 (-52.0 to -32.0) | 0.0001 |  | 13.9 |
| paraphrase_vs_exact_hybrid_lexical | mrr | 100 | 1.000 | 0.399 | -0.601 (-0.674 to -0.523) | 0.0001 |  | 0.108 |
| paraphrase_vs_exact_hybrid | success_at_5 | 100 | 100.0 | 99.0 | -1.0 (-3.0 to 0.0) | 1 |  | 2.8 |
| paraphrase_vs_exact_hybrid | mrr | 100 | 1.000 | 0.927 | -0.073 (-0.113 to -0.037) | 0.0002 |  | 0.055 |
| paraphrase_vs_exact_configured | success_at_5 | 100 | 100.0 | 100.0 | 0.0 (0.0 to 0.0) | 1 |  | n/a |
| paraphrase_vs_exact_configured | mrr | 100 | 1.000 | 0.965 | -0.035 (-0.060 to -0.010) | 0.0175 |  | 0.036 |

## Custody

Read-only verified at start: true, at end: true. Guard refusals by verb: analyze 107, telemetry_write 20.
Exclusions: none.
Latency is harness latency (pool size 2, local database), not production latency. configured keeps gbrain's own default result limit, so its pages-returned column shows how deep success@10 and success@20 can reach.
