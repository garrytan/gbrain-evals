# Live-recall scorecard

gbrain 0.60.641.0 (2560ffddb), schema 297, postgres, barrier: no_write_privilege, pgvector 0.8.2, mode: tokenmax.
Protocol: batch3; primary comparisons (Holm family of two): p1_configured_vs_hybrid_lexical_freshness (P1), p2_configured_vs_hybrid_lexical_entity (P2).
Visibility epoch (GBRA-398): run post_gbra_398, freeze post_gbra_398 at gbrain 0.60.623.0.
Question forms eligible: 99 of 102 (questions loaded: 51, dropped for an absent gold page: 0).

## Arms, all queries (both forms)

| Arm | n | success@1 | success@5 (95% CI) | success@10 | success@20 | MRR | pages returned |
|---|---|---|---|---|---|---|---|
| keyword | 99 | 43.4 | 49.5 (45.5–53.1) | 49.5 | 49.5 | 0.4613 | 1.6869 |
| vector | 99 | 35.4 | 57.6 (49.0–66.0) | 65.7 | 67.7 | 0.4536 | 20 |
| hybrid_lexical | 99 | 35.4 | 55.6 (50.5–61.0) | 57.6 | 60.6 | 0.4419 | 17.5657 |
| hybrid | 99 | 43.4 | 64.6 (58.8–71.0) | 67.7 | 72.7 | 0.5321 | 20 |
| configured | 99 | 67.7 | 78.8 (71.7–85.7) | 78.8 | 78.8 | 0.7231 | 20 |
| configured_window | invalid: no_eligible_queries | | | | | | |

## success@5 by type and form

| Arm | Type | exact n | exact | paraphrase n | paraphrase |
|---|---|---|---|---|---|
| keyword | identifier | 0 | n/a | 0 | n/a |
| keyword | error_string | 0 | n/a | 0 | n/a |
| keyword | time_window | 0 | n/a | 0 | n/a |
| keyword | cross_source | 0 | n/a | 0 | n/a |
| keyword | topic | 0 | n/a | 0 | n/a |
| keyword | freshness | 25 | 100.0 | 23 | 0.0 |
| keyword | entity | 25 | 92.0 | 26 | 3.9 |
| vector | identifier | 0 | n/a | 0 | n/a |
| vector | error_string | 0 | n/a | 0 | n/a |
| vector | time_window | 0 | n/a | 0 | n/a |
| vector | cross_source | 0 | n/a | 0 | n/a |
| vector | topic | 0 | n/a | 0 | n/a |
| vector | freshness | 25 | 84.0 | 23 | 8.7 |
| vector | entity | 25 | 88.0 | 26 | 46.2 |
| hybrid_lexical | identifier | 0 | n/a | 0 | n/a |
| hybrid_lexical | error_string | 0 | n/a | 0 | n/a |
| hybrid_lexical | time_window | 0 | n/a | 0 | n/a |
| hybrid_lexical | cross_source | 0 | n/a | 0 | n/a |
| hybrid_lexical | topic | 0 | n/a | 0 | n/a |
| hybrid_lexical | freshness | 25 | 96.0 | 23 | 4.3 |
| hybrid_lexical | entity | 25 | 100.0 | 26 | 19.2 |
| hybrid | identifier | 0 | n/a | 0 | n/a |
| hybrid | error_string | 0 | n/a | 0 | n/a |
| hybrid | time_window | 0 | n/a | 0 | n/a |
| hybrid | cross_source | 0 | n/a | 0 | n/a |
| hybrid | topic | 0 | n/a | 0 | n/a |
| hybrid | freshness | 25 | 100.0 | 23 | 8.7 |
| hybrid | entity | 25 | 100.0 | 26 | 46.2 |
| configured | identifier | 0 | n/a | 0 | n/a |
| configured | error_string | 0 | n/a | 0 | n/a |
| configured | time_window | 0 | n/a | 0 | n/a |
| configured | cross_source | 0 | n/a | 0 | n/a |
| configured | topic | 0 | n/a | 0 | n/a |
| configured | freshness | 25 | 100.0 | 23 | 39.1 |
| configured | entity | 25 | 100.0 | 26 | 73.1 |

## Freshness: stale page ranked above the gold

| Arm | n | stale-first (95% CI) | exact | paraphrase |
|---|---|---|---|---|
| keyword | 48 | 2.1 (0.0–6.7) | 4.0 | 0.0 |
| vector | 48 | 25.0 (12.2–38.8) | 28.0 | 21.7 |
| hybrid_lexical | 48 | 4.2 (0.0–10.9) | 4.0 | 4.3 |
| hybrid | 48 | 6.3 (0.0–13.6) | 4.0 | 8.7 |
| configured | 48 | 6.3 (0.0–14.0) | 0.0 | 13.0 |

## Entity: look-alike page ranked above the gold

| Arm | n | decoy-first (95% CI) | exact | paraphrase |
|---|---|---|---|---|
| keyword | 49 | 0.0 (0.0–0.0) | 0.0 | 0.0 |
| vector | 49 | 0.0 (0.0–0.0) | 0.0 | 0.0 |
| hybrid_lexical | 49 | 0.0 (0.0–0.0) | 0.0 | 0.0 |
| hybrid | 49 | 0.0 (0.0–0.0) | 0.0 | 0.0 |
| configured | 49 | 0.0 (0.0–0.0) | 0.0 | 0.0 |

## Paired comparisons (delta = B minus A)

| Comparison | Metric | Pairs | A | B | Delta (95% CI) | p | Holm p | MDE |
|---|---|---|---|---|---|---|---|---|
| p1_configured_vs_hybrid_lexical_freshness (P1) | success_at_5 | 48 | 52.1 | 70.8 | 18.8 (8.7 to 28.6) | 0.0037 | 0.0037 | 14.0 |
| p1_configured_vs_hybrid_lexical_freshness (P1) | mrr | 48 | 0.390 | 0.677 | 0.287 (0.184 to 0.393) | 0.0001 |  | 0.152 |
| p2_configured_vs_hybrid_lexical_entity (P2) | success_at_5 | 51 | 58.8 | 86.3 | 27.5 (17.3 to 37.5) | 0.0001 | 0.0002 | 14.6 |
| p2_configured_vs_hybrid_lexical_entity (P2) | mrr | 51 | 0.491 | 0.766 | 0.275 (0.172 to 0.380) | 0.0001 |  | 0.151 |
| hybrid_vs_hybrid_lexical_freshness | success_at_5 | 48 | 52.1 | 56.3 | 4.2 (-4.1 to 12.5) | 0.6235 |  | 11.7 |
| hybrid_vs_hybrid_lexical_freshness | mrr | 48 | 0.390 | 0.474 | 0.084 (0.004 to 0.160) | 0.055 |  | 0.114 |
| hybrid_vs_hybrid_lexical_entity | success_at_5 | 51 | 58.8 | 72.5 | 13.7 (3.9 to 24.5) | 0.0384 |  | 15.2 |
| hybrid_vs_hybrid_lexical_entity | mrr | 51 | 0.491 | 0.587 | 0.096 (0.002 to 0.192) | 0.0619 |  | 0.137 |
| configured_vs_keyword_freshness | success_at_5 | 48 | 52.1 | 70.8 | 18.8 (8.9 to 28.6) | 0.0038 |  | 14.0 |
| configured_vs_keyword_freshness | mrr | 48 | 0.510 | 0.677 | 0.167 (0.083 to 0.255) | 0.0025 |  | 0.126 |
| configured_vs_keyword_entity | success_at_5 | 51 | 47.1 | 86.3 | 39.2 (27.5 to 51.0) | 0.0001 |  | 16.8 |
| configured_vs_keyword_entity | mrr | 51 | 0.415 | 0.766 | 0.351 (0.236 to 0.472) | 0.0001 |  | 0.172 |
| batch2_p1_hybrid_vs_hybrid_lexical_paraphrase | success_at_5 | 49 | 12.2 | 28.6 | 16.3 (4.1 to 28.6) | 0.0392 |  | 18.9 |
| batch2_p1_hybrid_vs_hybrid_lexical_paraphrase | mrr | 49 | 0.104 | 0.172 | 0.068 (-0.020 to 0.158) | 0.1429 |  | 0.127 |
| hybrid_lexical_vs_keyword | success_at_5 | 99 | 49.5 | 55.6 | 6.1 (0.0 to 12.4) | 0.1143 |  | 8.7 |
| hybrid_lexical_vs_keyword | mrr | 99 | 0.461 | 0.442 | -0.019 (-0.075 to 0.040) | 0.522 |  | 0.083 |
| hybrid_vs_keyword | success_at_5 | 99 | 49.5 | 64.6 | 15.2 (8.1 to 23.2) | 0.0002 |  | 10.9 |
| hybrid_vs_keyword | mrr | 99 | 0.461 | 0.532 | 0.071 (0.007 to 0.141) | 0.0463 |  | 0.097 |
| configured_vs_keyword_paraphrase | success_at_5 | 49 | 2.0 | 57.1 | 55.1 (40.8 to 69.4) | 0.0002 |  | 20.1 |
| configured_vs_keyword_paraphrase | mrr | 49 | 0.020 | 0.520 | 0.500 (0.367 to 0.633) | 0.0002 |  | 0.195 |
| configured_vs_hybrid | success_at_5 | 99 | 64.6 | 78.8 | 14.1 (7.1 to 21.2) | 0.0006 |  | 9.9 |
| configured_vs_hybrid | mrr | 99 | 0.532 | 0.723 | 0.191 (0.125 to 0.255) | 0.0001 |  | 0.093 |
| vector_vs_keyword | success_at_5 | 99 | 49.5 | 57.6 | 8.1 (-1.0 to 17.6) | 0.1558 |  | 13.7 |
| vector_vs_keyword | mrr | 99 | 0.461 | 0.454 | -0.008 (-0.087 to 0.075) | 0.8549 |  | 0.118 |
| configured_vs_keyword_exact | success_at_5 | 50 | 96.0 | 100.0 | 4.0 (0.0 to 10.0) | 0.5025 |  | 7.8 |
| configured_vs_keyword_exact | mrr | 50 | 0.893 | 0.922 | 0.028 (-0.052 to 0.117) | 0.5883 |  | 0.121 |
| hybrid_vs_keyword_paraphrase | success_at_5 | 49 | 2.0 | 28.6 | 26.5 (14.3 to 38.8) | 0.0006 |  | 17.8 |
| hybrid_vs_keyword_paraphrase | mrr | 49 | 0.020 | 0.172 | 0.152 (0.084 to 0.231) | 0.0003 |  | 0.107 |
| window_vs_configured | skipped: arm_invalid_or_absent | | | | | | | |
| paraphrase_vs_exact_keyword | success_at_5 | 48 | 95.8 | 2.1 | -93.8 (-100.0 to -85.4) | 0.0001 |  | 9.9 |
| paraphrase_vs_exact_keyword | mrr | 48 | 0.899 | 0.021 | -0.878 (-0.958 to -0.778) | 0.0001 |  | 0.131 |
| paraphrase_vs_exact_vector | success_at_5 | 48 | 85.4 | 27.1 | -58.3 (-72.9 to -41.7) | 0.0001 |  | 21.8 |
| paraphrase_vs_exact_vector | mrr | 48 | 0.748 | 0.151 | -0.597 (-0.718 to -0.469) | 0.0001 |  | 0.179 |
| paraphrase_vs_exact_hybrid_lexical | success_at_5 | 48 | 97.9 | 12.5 | -85.4 (-93.8 to -75.0) | 0.0001 |  | 14.4 |
| paraphrase_vs_exact_hybrid_lexical | mrr | 48 | 0.774 | 0.104 | -0.670 (-0.787 to -0.542) | 0.0001 |  | 0.179 |
| paraphrase_vs_exact_hybrid | success_at_5 | 48 | 100.0 | 27.1 | -72.9 (-85.4 to -60.4) | 0.0001 |  | 18.2 |
| paraphrase_vs_exact_hybrid | mrr | 48 | 0.891 | 0.165 | -0.726 (-0.813 to -0.630) | 0.0001 |  | 0.136 |
| paraphrase_vs_exact_configured | success_at_5 | 48 | 100.0 | 56.3 | -43.8 (-58.3 to -29.2) | 0.0001 |  | 20.3 |
| paraphrase_vs_exact_configured | mrr | 48 | 0.918 | 0.510 | -0.408 (-0.563 to -0.254) | 0.0001 |  | 0.224 |

## Custody

Read-only verified at start: true, at end: true. Guard refusals by verb: insert 2, telemetry_write 15.
Exclusions: hybrid_lexical_degraded 2, keyword_error 1.
Latency is harness latency (pool size 2, local database), not production latency. configured keeps gbrain's own default result limit, so its pages-returned column shows how deep success@10 and success@20 can reach.
