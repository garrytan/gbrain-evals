# Live-recall scorecard

gbrain 0.60.577.0 (52b9ccae4), schema 286, postgres, barrier: no_write_privilege, pgvector 0.8.2, mode: tokenmax.
Question forms eligible: 100 of 100 (questions loaded: 50, dropped for an absent gold page: 0).

## Arms, all queries (both forms)

| Arm | n | success@1 | success@5 (95% CI) | success@10 | success@20 | MRR | pages returned |
|---|---|---|---|---|---|---|---|
| keyword | 100 | 29.0 | 36.0 (30.0–42.0) | 38.0 | 38.0 | 0.3209 | 1.2 |
| vector | 100 | 19.0 | 40.0 (30.0–50.0) | 50.0 | 59.0 | 0.2848 | 20 |
| hybrid_lexical | 100 | 28.0 | 47.0 (40.0–54.0) | 54.0 | 56.0 | 0.3656 | 18 |
| hybrid | 100 | 38.0 | 57.0 (48.0–66.0) | 68.0 | 75.0 | 0.4641 | 20 |
| configured | 100 | 58.0 | 76.0 (66.0–85.0) | 77.0 | 78.0 | 0.654 | 20 |
| configured_window | 20 | 60.0 | 60.0 (30.0–85.0) | 60.0 | 60.0 | 0.6 | 19.6 |

## success@5 by type and form

| Arm | Type | exact n | exact | paraphrase n | paraphrase |
|---|---|---|---|---|---|
| keyword | identifier | 10 | 80.0 | 10 | 0.0 |
| keyword | error_string | 10 | 80.0 | 10 | 0.0 |
| keyword | time_window | 10 | 90.0 | 10 | 0.0 |
| keyword | cross_source | 10 | 10.0 | 10 | 0.0 |
| keyword | topic | 10 | 100.0 | 10 | 0.0 |
| vector | identifier | 10 | 30.0 | 10 | 30.0 |
| vector | error_string | 10 | 20.0 | 10 | 50.0 |
| vector | time_window | 10 | 40.0 | 10 | 0.0 |
| vector | cross_source | 10 | 80.0 | 10 | 40.0 |
| vector | topic | 10 | 80.0 | 10 | 30.0 |
| hybrid_lexical | identifier | 10 | 80.0 | 10 | 10.0 |
| hybrid_lexical | error_string | 10 | 80.0 | 10 | 10.0 |
| hybrid_lexical | time_window | 10 | 100.0 | 10 | 0.0 |
| hybrid_lexical | cross_source | 10 | 60.0 | 10 | 20.0 |
| hybrid_lexical | topic | 10 | 90.0 | 10 | 20.0 |
| hybrid | identifier | 10 | 70.0 | 10 | 40.0 |
| hybrid | error_string | 10 | 70.0 | 10 | 40.0 |
| hybrid | time_window | 10 | 90.0 | 10 | 0.0 |
| hybrid | cross_source | 10 | 70.0 | 10 | 60.0 |
| hybrid | topic | 10 | 100.0 | 10 | 30.0 |
| configured | identifier | 10 | 90.0 | 10 | 50.0 |
| configured | error_string | 10 | 90.0 | 10 | 70.0 |
| configured | time_window | 10 | 90.0 | 10 | 30.0 |
| configured | cross_source | 10 | 80.0 | 10 | 60.0 |
| configured | topic | 10 | 100.0 | 10 | 100.0 |
| configured_window | identifier | 0 | n/a | 0 | n/a |
| configured_window | error_string | 0 | n/a | 0 | n/a |
| configured_window | time_window | 10 | 70.0 | 10 | 50.0 |
| configured_window | cross_source | 0 | n/a | 0 | n/a |
| configured_window | topic | 0 | n/a | 0 | n/a |

## Paired comparisons (delta = B minus A)

| Comparison | Metric | Pairs | A | B | Delta (95% CI) | p | Holm p | MDE |
|---|---|---|---|---|---|---|---|---|
| p1_hybrid_vs_hybrid_lexical (P1) | success_at_5 | 100 | 47.0 | 57.0 | 10.0 (1.0 to 20.0) | 0.0919 | 0.0919 | 14.4 |
| p1_hybrid_vs_hybrid_lexical (P1) | mrr | 100 | 0.366 | 0.464 | 0.099 (0.037 to 0.162) | 0.0057 |  | 0.093 |
| p2_configured_vs_hybrid_lexical_paraphrase (P2) | success_at_5 | 50 | 12.0 | 62.0 | 50.0 (36.0 to 64.0) | 0.0001 | 0.0002 | 20.0 |
| p2_configured_vs_hybrid_lexical_paraphrase (P2) | mrr | 50 | 0.074 | 0.499 | 0.425 (0.302 to 0.549) | 0.0001 |  | 0.180 |
| hybrid_lexical_vs_keyword | success_at_5 | 100 | 36.0 | 47.0 | 11.0 (4.0 to 19.0) | 0.0113 |  | 10.8 |
| hybrid_lexical_vs_keyword | mrr | 100 | 0.321 | 0.366 | 0.045 (-0.009 to 0.104) | 0.1295 |  | 0.081 |
| hybrid_vs_keyword | success_at_5 | 100 | 36.0 | 57.0 | 21.0 (11.0 to 31.0) | 0.0004 |  | 14.5 |
| hybrid_vs_keyword | mrr | 100 | 0.321 | 0.464 | 0.143 (0.075 to 0.214) | 0.0002 |  | 0.101 |
| configured_vs_keyword_paraphrase | success_at_5 | 50 | 0.0 | 62.0 | 62.0 (48.0 to 76.0) | 0.0001 |  | 19.4 |
| configured_vs_keyword_paraphrase | mrr | 50 | 0.000 | 0.499 | 0.499 (0.377 to 0.624) | 0.0001 |  | 0.181 |
| configured_vs_hybrid | success_at_5 | 100 | 57.0 | 76.0 | 19.0 (13.0 to 26.0) | 0.0001 |  | 9.7 |
| configured_vs_hybrid | mrr | 100 | 0.464 | 0.654 | 0.190 (0.115 to 0.263) | 0.0001 |  | 0.108 |
| vector_vs_keyword | success_at_5 | 100 | 36.0 | 40.0 | 4.0 (-8.0 to 17.0) | 0.646 |  | 18.3 |
| vector_vs_keyword | mrr | 100 | 0.321 | 0.285 | -0.036 (-0.125 to 0.057) | 0.4359 |  | 0.130 |
| configured_vs_keyword_exact | success_at_5 | 50 | 72.0 | 90.0 | 18.0 (4.0 to 32.0) | 0.0364 |  | 20.7 |
| configured_vs_keyword_exact | mrr | 50 | 0.642 | 0.809 | 0.167 (0.041 to 0.302) | 0.0145 |  | 0.187 |
| hybrid_vs_keyword_paraphrase | success_at_5 | 50 | 0.0 | 34.0 | 34.0 (22.0 to 48.0) | 0.0001 |  | 19.0 |
| hybrid_vs_keyword_paraphrase | mrr | 50 | 0.000 | 0.230 | 0.230 (0.140 to 0.331) | 0.0001 |  | 0.136 |
| window_vs_configured | success_at_5 | 20 | 60.0 | 60.0 | 0.0 (-30.0 to 30.0) | 1 |  | 46.7 |
| window_vs_configured | mrr | 20 | 0.537 | 0.600 | 0.063 (-0.263 to 0.350) | 0.7656 |  | 0.459 |
| paraphrase_vs_exact_keyword | success_at_5 | 50 | 72.0 | 0.0 | -72.0 (-84.0 to -58.0) | 0.0001 |  | 18.0 |
| paraphrase_vs_exact_keyword | mrr | 50 | 0.642 | 0.000 | -0.642 (-0.762 to -0.516) | 0.0001 |  | 0.176 |
| paraphrase_vs_exact_vector | success_at_5 | 50 | 50.0 | 30.0 | -20.0 (-36.0 to -4.0) | 0.0447 |  | 24.0 |
| paraphrase_vs_exact_vector | mrr | 50 | 0.361 | 0.209 | -0.152 (-0.297 to -0.003) | 0.0495 |  | 0.211 |
| paraphrase_vs_exact_hybrid_lexical | success_at_5 | 50 | 82.0 | 12.0 | -70.0 (-84.0 to -56.0) | 0.0001 |  | 20.0 |
| paraphrase_vs_exact_hybrid_lexical | mrr | 50 | 0.658 | 0.074 | -0.584 (-0.700 to -0.459) | 0.0001 |  | 0.175 |
| paraphrase_vs_exact_hybrid | success_at_5 | 50 | 80.0 | 34.0 | -46.0 (-62.0 to -30.0) | 0.0001 |  | 22.9 |
| paraphrase_vs_exact_hybrid | mrr | 50 | 0.698 | 0.230 | -0.468 (-0.607 to -0.314) | 0.0001 |  | 0.212 |
| paraphrase_vs_exact_configured | success_at_5 | 50 | 90.0 | 62.0 | -28.0 (-40.0 to -16.0) | 0.0001 |  | 18.0 |
| paraphrase_vs_exact_configured | mrr | 50 | 0.809 | 0.499 | -0.310 (-0.432 to -0.191) | 0.0001 |  | 0.175 |

## Custody

Read-only verified at start: true, at end: true. Guard refusals by verb: telemetry_write 17.
Exclusions: none.
Latency is harness latency (pool size 2, local database), not production latency. configured keeps gbrain's own default result limit, so its pages-returned column shows how deep success@10 and success@20 can reach.
