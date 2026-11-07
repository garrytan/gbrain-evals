# Live-recall scorecard

gbrain 0.60.577.0 (52b9ccae4), schema 286, postgres, barrier: no_write_privilege, pgvector 0.8.2, mode: tokenmax.
Protocol: batch2; primary comparisons (Holm family of two): p1_hybrid_vs_hybrid_lexical_paraphrase (P1), p2_configured_vs_hybrid_lexical_paraphrase (P2).
Question forms eligible: 100 of 100 (questions loaded: 50, dropped for an absent gold page: 0).

## Arms, all queries (both forms)

| Arm | n | success@1 | success@5 (95% CI) | success@10 | success@20 | MRR | pages returned |
|---|---|---|---|---|---|---|---|
| keyword | 100 | 27.0 | 32.0 (25.0–38.0) | 34.0 | 34.0 | 0.289 | 0.93 |
| vector | 100 | 23.0 | 44.0 (33.0–55.0) | 49.0 | 53.0 | 0.3169 | 20 |
| hybrid_lexical | 100 | 29.0 | 48.0 (40.0–56.0) | 58.0 | 60.0 | 0.3865 | 18.6 |
| hybrid | 100 | 33.0 | 54.0 (44.0–64.0) | 63.0 | 67.0 | 0.4289 | 20 |
| configured | 100 | 56.0 | 68.0 (59.0–77.0) | 72.0 | 72.0 | 0.6124 | 20 |
| configured_window | 20 | 100.0 | 100.0 (100.0–100.0) | 100.0 | 100.0 | 1 | 20 |

## success@5 by type and form

| Arm | Type | exact n | exact | paraphrase n | paraphrase |
|---|---|---|---|---|---|
| keyword | identifier | 10 | 40.0 | 10 | 0.0 |
| keyword | error_string | 10 | 80.0 | 10 | 0.0 |
| keyword | time_window | 10 | 100.0 | 10 | 0.0 |
| keyword | cross_source | 10 | 10.0 | 10 | 0.0 |
| keyword | topic | 10 | 90.0 | 10 | 0.0 |
| vector | identifier | 10 | 20.0 | 10 | 30.0 |
| vector | error_string | 10 | 0.0 | 10 | 0.0 |
| vector | time_window | 10 | 90.0 | 10 | 60.0 |
| vector | cross_source | 10 | 80.0 | 10 | 10.0 |
| vector | topic | 10 | 90.0 | 10 | 60.0 |
| hybrid_lexical | identifier | 10 | 90.0 | 10 | 40.0 |
| hybrid_lexical | error_string | 10 | 60.0 | 10 | 10.0 |
| hybrid_lexical | time_window | 10 | 80.0 | 10 | 0.0 |
| hybrid_lexical | cross_source | 10 | 70.0 | 10 | 10.0 |
| hybrid_lexical | topic | 10 | 100.0 | 10 | 20.0 |
| hybrid | identifier | 10 | 40.0 | 10 | 30.0 |
| hybrid | error_string | 10 | 60.0 | 10 | 10.0 |
| hybrid | time_window | 10 | 100.0 | 10 | 60.0 |
| hybrid | cross_source | 10 | 70.0 | 10 | 10.0 |
| hybrid | topic | 10 | 100.0 | 10 | 60.0 |
| configured | identifier | 10 | 80.0 | 10 | 40.0 |
| configured | error_string | 10 | 70.0 | 10 | 10.0 |
| configured | time_window | 10 | 100.0 | 10 | 90.0 |
| configured | cross_source | 10 | 90.0 | 10 | 30.0 |
| configured | topic | 10 | 100.0 | 10 | 70.0 |
| configured_window | identifier | 0 | n/a | 0 | n/a |
| configured_window | error_string | 0 | n/a | 0 | n/a |
| configured_window | time_window | 10 | 100.0 | 10 | 100.0 |
| configured_window | cross_source | 0 | n/a | 0 | n/a |
| configured_window | topic | 0 | n/a | 0 | n/a |

## Paired comparisons (delta = B minus A)

| Comparison | Metric | Pairs | A | B | Delta (95% CI) | p | Holm p | MDE |
|---|---|---|---|---|---|---|---|---|
| p1_hybrid_vs_hybrid_lexical_paraphrase (P1) | success_at_5 | 50 | 16.0 | 34.0 | 18.0 (4.0 to 32.0) | 0.0363 | 0.0363 | 20.7 |
| p1_hybrid_vs_hybrid_lexical_paraphrase (P1) | mrr | 50 | 0.132 | 0.245 | 0.114 (-0.004 to 0.238) | 0.0736 |  | 0.173 |
| p2_configured_vs_hybrid_lexical_paraphrase (P2) | success_at_5 | 50 | 16.0 | 48.0 | 32.0 (16.0 to 48.0) | 0.0012 | 0.0024 | 23.3 |
| p2_configured_vs_hybrid_lexical_paraphrase (P2) | mrr | 50 | 0.132 | 0.450 | 0.318 (0.168 to 0.465) | 0.0003 |  | 0.213 |
| batch1_p1_hybrid_vs_hybrid_lexical | success_at_5 | 100 | 48.0 | 54.0 | 6.0 (-4.0 to 16.0) | 0.3476 |  | 14.8 |
| batch1_p1_hybrid_vs_hybrid_lexical | mrr | 100 | 0.387 | 0.429 | 0.042 (-0.045 to 0.130) | 0.3521 |  | 0.125 |
| hybrid_lexical_vs_keyword | success_at_5 | 100 | 32.0 | 48.0 | 16.0 (7.0 to 26.0) | 0.0037 |  | 13.5 |
| hybrid_lexical_vs_keyword | mrr | 100 | 0.289 | 0.387 | 0.098 (0.025 to 0.172) | 0.0141 |  | 0.107 |
| hybrid_vs_keyword | success_at_5 | 100 | 32.0 | 54.0 | 22.0 (13.0 to 31.0) | 0.0001 |  | 13.4 |
| hybrid_vs_keyword | mrr | 100 | 0.289 | 0.429 | 0.140 (0.065 to 0.214) | 0.0007 |  | 0.107 |
| configured_vs_keyword_paraphrase | success_at_5 | 50 | 0.0 | 48.0 | 48.0 (34.0 to 62.0) | 0.0001 |  | 20.0 |
| configured_vs_keyword_paraphrase | mrr | 50 | 0.000 | 0.450 | 0.450 (0.319 to 0.582) | 0.0001 |  | 0.191 |
| configured_vs_hybrid | success_at_5 | 100 | 54.0 | 68.0 | 14.0 (6.0 to 22.0) | 0.0021 |  | 11.3 |
| configured_vs_hybrid | mrr | 100 | 0.429 | 0.612 | 0.183 (0.122 to 0.246) | 0.0001 |  | 0.089 |
| vector_vs_keyword | success_at_5 | 100 | 32.0 | 44.0 | 12.0 (0.0 to 23.0) | 0.0658 |  | 16.3 |
| vector_vs_keyword | mrr | 100 | 0.289 | 0.317 | 0.028 (-0.057 to 0.110) | 0.5182 |  | 0.121 |
| configured_vs_keyword_exact | success_at_5 | 50 | 64.0 | 88.0 | 24.0 (10.0 to 38.0) | 0.0043 |  | 20.5 |
| configured_vs_keyword_exact | mrr | 50 | 0.578 | 0.775 | 0.197 (0.084 to 0.317) | 0.0015 |  | 0.170 |
| hybrid_vs_keyword_paraphrase | success_at_5 | 50 | 0.0 | 34.0 | 34.0 (22.0 to 48.0) | 0.0001 |  | 19.0 |
| hybrid_vs_keyword_paraphrase | mrr | 50 | 0.000 | 0.245 | 0.245 (0.145 to 0.353) | 0.0001 |  | 0.152 |
| window_vs_configured | success_at_5 | 20 | 95.0 | 100.0 | 5.0 (0.0 to 15.0) | 1 |  | 14.0 |
| window_vs_configured | mrr | 20 | 0.950 | 1.000 | 0.050 (0.000 to 0.150) | 1 |  | 0.140 |
| paraphrase_vs_exact_keyword | success_at_5 | 50 | 64.0 | 0.0 | -64.0 (-76.0 to -50.0) | 0.0001 |  | 19.2 |
| paraphrase_vs_exact_keyword | mrr | 50 | 0.578 | 0.000 | -0.578 (-0.703 to -0.447) | 0.0001 |  | 0.187 |
| paraphrase_vs_exact_vector | success_at_5 | 50 | 56.0 | 32.0 | -24.0 (-38.0 to -10.0) | 0.0042 |  | 20.5 |
| paraphrase_vs_exact_vector | mrr | 50 | 0.409 | 0.224 | -0.185 (-0.299 to -0.071) | 0.0034 |  | 0.164 |
| paraphrase_vs_exact_hybrid_lexical | success_at_5 | 50 | 80.0 | 16.0 | -64.0 (-78.0 to -50.0) | 0.0001 |  | 20.8 |
| paraphrase_vs_exact_hybrid_lexical | mrr | 50 | 0.641 | 0.132 | -0.509 (-0.638 to -0.381) | 0.0001 |  | 0.186 |
| paraphrase_vs_exact_hybrid | success_at_5 | 50 | 74.0 | 34.0 | -40.0 (-54.0 to -26.0) | 0.0001 |  | 21.2 |
| paraphrase_vs_exact_hybrid | mrr | 50 | 0.612 | 0.245 | -0.367 (-0.487 to -0.245) | 0.0001 |  | 0.170 |
| paraphrase_vs_exact_configured | success_at_5 | 50 | 88.0 | 48.0 | -40.0 (-56.0 to -24.0) | 0.0002 |  | 22.6 |
| paraphrase_vs_exact_configured | mrr | 50 | 0.775 | 0.450 | -0.326 (-0.459 to -0.191) | 0.0002 |  | 0.193 |

## Custody

Read-only verified at start: true, at end: true. Guard refusals by verb: telemetry_write 17.
Exclusions: none.
Latency is harness latency (pool size 2, local database), not production latency. configured keeps gbrain's own default result limit, so its pages-returned column shows how deep success@10 and success@20 can reach.
