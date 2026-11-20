# Live-recall scorecard

gbrain 0.60.682.0 (42faabf28), schema 304, postgres, barrier: no_write_privilege, pgvector 0.8.2, mode: tokenmax.
Protocol: batch4; primary comparisons (Holm family of two): p1_hybrid_vs_hybrid_lexical_paraphrase (P1), p2_configured_vs_hybrid_lexical_paraphrase (P2).
Visibility epoch (GBRA-398): run post_gbra_398, freeze post_gbra_398 at gbrain 0.60.682.0.
Held out from 3 earlier question files (88eaa30c34d8, dd69701c5553, c023694ef59e): shared question ids 0, forms 0, gold pages 0.
Question forms eligible: 99 of 100 (questions loaded: 50, dropped for an absent gold page: 0).

## Arms, all queries (both forms)

| Arm | n | success@1 | success@5 (95% CI) | success@10 | success@20 | MRR | pages returned |
|---|---|---|---|---|---|---|---|
| keyword | 99 | 16.2 | 25.3 (18.2–32.3) | 26.3 | 26.3 | 0.2024 | 1.6667 |
| vector | 99 | 17.2 | 36.4 (26.3–46.9) | 38.4 | 47.5 | 0.2567 | 20 |
| hybrid_lexical | 99 | 13.1 | 30.3 (23.2–37.4) | 41.4 | 43.4 | 0.2105 | 19.7071 |
| hybrid | 99 | 25.3 | 42.4 (32.0–53.0) | 47.5 | 54.5 | 0.3344 | 20 |
| configured | 99 | 51.5 | 60.6 (49.0–71.7) | 60.6 | 60.6 | 0.5589 | 20 |
| configured_window | 20 | 90.0 | 100.0 (100.0–100.0) | 100.0 | 100.0 | 0.95 | 20 |

## success@5 by type and form

| Arm | Type | exact n | exact | paraphrase n | paraphrase |
|---|---|---|---|---|---|
| keyword | identifier | 10 | 0.0 | 10 | 0.0 |
| keyword | error_string | 10 | 60.0 | 10 | 0.0 |
| keyword | time_window | 10 | 100.0 | 10 | 0.0 |
| keyword | cross_source | 10 | 0.0 | 10 | 0.0 |
| keyword | topic | 10 | 90.0 | 9 | 0.0 |
| vector | identifier | 10 | 10.0 | 10 | 0.0 |
| vector | error_string | 10 | 0.0 | 10 | 0.0 |
| vector | time_window | 10 | 90.0 | 10 | 50.0 |
| vector | cross_source | 10 | 70.0 | 10 | 40.0 |
| vector | topic | 10 | 80.0 | 9 | 22.2 |
| hybrid_lexical | identifier | 10 | 80.0 | 10 | 10.0 |
| hybrid_lexical | error_string | 10 | 30.0 | 10 | 0.0 |
| hybrid_lexical | time_window | 10 | 80.0 | 10 | 0.0 |
| hybrid_lexical | cross_source | 10 | 30.0 | 10 | 0.0 |
| hybrid_lexical | topic | 10 | 70.0 | 9 | 0.0 |
| hybrid | identifier | 10 | 10.0 | 10 | 0.0 |
| hybrid | error_string | 10 | 20.0 | 10 | 0.0 |
| hybrid | time_window | 10 | 100.0 | 10 | 40.0 |
| hybrid | cross_source | 10 | 70.0 | 10 | 60.0 |
| hybrid | topic | 10 | 100.0 | 9 | 22.2 |
| configured | identifier | 10 | 40.0 | 10 | 10.0 |
| configured | error_string | 10 | 40.0 | 10 | 0.0 |
| configured | time_window | 10 | 100.0 | 10 | 80.0 |
| configured | cross_source | 10 | 90.0 | 10 | 80.0 |
| configured | topic | 10 | 100.0 | 9 | 66.7 |
| configured_window | identifier | 0 | n/a | 0 | n/a |
| configured_window | error_string | 0 | n/a | 0 | n/a |
| configured_window | time_window | 10 | 100.0 | 10 | 100.0 |
| configured_window | cross_source | 0 | n/a | 0 | n/a |
| configured_window | topic | 0 | n/a | 0 | n/a |

## Paired comparisons (delta = B minus A)

| Comparison | Metric | Pairs | A | B | Delta (95% CI) | p | Holm p | MDE |
|---|---|---|---|---|---|---|---|---|
| p1_hybrid_vs_hybrid_lexical_paraphrase (P1) | success_at_5 | 49 | 2.0 | 24.5 | 22.4 (10.2 to 34.7) | 0.0028 | 0.0028 | 18.8 |
| p1_hybrid_vs_hybrid_lexical_paraphrase (P1) | mrr | 49 | 0.015 | 0.136 | 0.122 (0.054 to 0.200) | 0.0004 |  | 0.108 |
| p2_configured_vs_hybrid_lexical_paraphrase (P2) | success_at_5 | 49 | 2.0 | 46.9 | 44.9 (28.6 to 59.2) | 0.0001 | 0.0002 | 21.7 |
| p2_configured_vs_hybrid_lexical_paraphrase (P2) | mrr | 49 | 0.015 | 0.449 | 0.434 (0.295 to 0.573) | 0.0001 |  | 0.200 |
| batch1_p1_hybrid_vs_hybrid_lexical | success_at_5 | 99 | 30.3 | 42.4 | 12.1 (1.0 to 24.2) | 0.073 |  | 17.0 |
| batch1_p1_hybrid_vs_hybrid_lexical | mrr | 99 | 0.210 | 0.334 | 0.124 (0.040 to 0.208) | 0.007 |  | 0.121 |
| hybrid_lexical_vs_keyword | success_at_5 | 99 | 25.3 | 30.3 | 5.1 (-4.0 to 14.0) | 0.3841 |  | 12.9 |
| hybrid_lexical_vs_keyword | mrr | 99 | 0.202 | 0.210 | 0.008 (-0.051 to 0.070) | 0.8026 |  | 0.088 |
| hybrid_vs_keyword | success_at_5 | 99 | 25.3 | 42.4 | 17.2 (7.0 to 28.0) | 0.0048 |  | 14.9 |
| hybrid_vs_keyword | mrr | 99 | 0.202 | 0.334 | 0.132 (0.062 to 0.206) | 0.001 |  | 0.103 |
| configured_vs_keyword_paraphrase | success_at_5 | 49 | 0.0 | 46.9 | 46.9 (32.6 to 61.2) | 0.0001 |  | 20.2 |
| configured_vs_keyword_paraphrase | mrr | 49 | 0.000 | 0.449 | 0.449 (0.316 to 0.582) | 0.0001 |  | 0.197 |
| configured_vs_hybrid | success_at_5 | 99 | 42.4 | 60.6 | 18.2 (12.0 to 25.0) | 0.0001 |  | 9.7 |
| configured_vs_hybrid | mrr | 99 | 0.334 | 0.559 | 0.225 (0.163 to 0.288) | 0.0001 |  | 0.091 |
| vector_vs_keyword | success_at_5 | 99 | 25.3 | 36.4 | 11.1 (0.0 to 22.0) | 0.0707 |  | 15.3 |
| vector_vs_keyword | mrr | 99 | 0.202 | 0.257 | 0.054 (-0.019 to 0.128) | 0.1588 |  | 0.106 |
| configured_vs_keyword_exact | success_at_5 | 50 | 50.0 | 74.0 | 24.0 (10.0 to 38.0) | 0.0047 |  | 20.5 |
| configured_vs_keyword_exact | mrr | 50 | 0.401 | 0.667 | 0.266 (0.143 to 0.393) | 0.0001 |  | 0.179 |
| hybrid_vs_keyword_paraphrase | success_at_5 | 49 | 0.0 | 24.5 | 24.5 (12.2 to 36.7) | 0.0006 |  | 17.4 |
| hybrid_vs_keyword_paraphrase | mrr | 49 | 0.000 | 0.136 | 0.136 (0.070 to 0.213) | 0.0001 |  | 0.106 |
| window_vs_configured | success_at_5 | 20 | 90.0 | 100.0 | 10.0 (0.0 to 25.0) | 0.5 |  | 18.7 |
| window_vs_configured | mrr | 20 | 0.850 | 0.950 | 0.100 (0.000 to 0.250) | 0.5 |  | 0.187 |
| paraphrase_vs_exact_keyword | success_at_5 | 49 | 49.0 | 0.0 | -49.0 (-63.3 to -34.7) | 0.0001 |  | 20.2 |
| paraphrase_vs_exact_keyword | mrr | 49 | 0.399 | 0.000 | -0.399 (-0.522 to -0.276) | 0.0001 |  | 0.180 |
| paraphrase_vs_exact_vector | success_at_5 | 49 | 49.0 | 22.4 | -26.5 (-42.9 to -10.2) | 0.0041 |  | 22.8 |
| paraphrase_vs_exact_vector | mrr | 49 | 0.396 | 0.113 | -0.283 (-0.405 to -0.160) | 0.0002 |  | 0.178 |
| paraphrase_vs_exact_hybrid_lexical | success_at_5 | 49 | 59.2 | 2.0 | -57.1 (-71.4 to -42.9) | 0.0001 |  | 20.0 |
| paraphrase_vs_exact_hybrid_lexical | mrr | 49 | 0.409 | 0.015 | -0.394 (-0.499 to -0.289) | 0.0001 |  | 0.155 |
| paraphrase_vs_exact_hybrid | success_at_5 | 49 | 59.2 | 24.5 | -34.7 (-51.0 to -18.4) | 0.0002 |  | 22.4 |
| paraphrase_vs_exact_hybrid | mrr | 49 | 0.532 | 0.136 | -0.396 (-0.527 to -0.259) | 0.0001 |  | 0.195 |
| paraphrase_vs_exact_configured | success_at_5 | 49 | 73.5 | 46.9 | -26.5 (-40.8 to -14.3) | 0.0013 |  | 19.6 |
| paraphrase_vs_exact_configured | mrr | 49 | 0.660 | 0.449 | -0.211 (-0.347 to -0.071) | 0.0062 |  | 0.200 |

## Family band (success@5, all comparisons together)

Simultaneous 95.0% band from one max-t bootstrap over 16 comparisons, resampling 50 questions within 5 question types (seed 20261106, 10000 draws): critical value 2.8889 (Bonferroni would use 2.9552).

| Comparison | Delta | Family band | Excludes zero |
|---|---|---|---|
| p1_hybrid_vs_hybrid_lexical_paraphrase | 22.4 | 6.6 to 38.3 | yes |
| p2_configured_vs_hybrid_lexical_paraphrase | 44.9 | 28.9 to 60.9 | yes |
| batch1_p1_hybrid_vs_hybrid_lexical | 12.1 | 0.5 to 23.7 | yes |
| hybrid_lexical_vs_keyword | 5.1 | -4.2 to 14.3 | no |
| hybrid_vs_keyword | 17.2 | 7.0 to 27.3 | yes |
| configured_vs_keyword_paraphrase | 46.9 | 32.3 to 61.6 | yes |
| configured_vs_hybrid | 18.2 | 8.5 to 27.9 | yes |
| vector_vs_keyword | 11.1 | 0.3 to 21.9 | yes |
| configured_vs_keyword_exact | 24.0 | 10.0 to 38.0 | yes |
| hybrid_vs_keyword_paraphrase | 24.5 | 9.6 to 39.4 | yes |
| window_vs_configured | 10.0 | -8.4 to 28.4 | no |
| paraphrase_vs_exact_keyword | -49.0 | -59.9 to -38.0 | yes |
| paraphrase_vs_exact_vector | -26.5 | -48.4 to -4.6 | yes |
| paraphrase_vs_exact_hybrid_lexical | -57.1 | -75.3 to -39.0 | yes |
| paraphrase_vs_exact_hybrid | -34.7 | -54.6 to -14.8 | yes |
| paraphrase_vs_exact_configured | -26.5 | -46.2 to -6.9 | yes |

## Custody

Read-only verified at start: true, at end: true. Guard refusals by verb: insert 1, telemetry_write 16.
Exclusions: hybrid_lexical_degraded 1.
Latency is harness latency (pool size 2, local database), not production latency. configured keeps gbrain's own default result limit, so its pages-returned column shows how deep success@10 and success@20 can reach.
