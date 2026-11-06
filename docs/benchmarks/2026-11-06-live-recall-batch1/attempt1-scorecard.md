# Live-recall scorecard

gbrain 0.60.577.0 (52b9ccae4), schema 286, postgres, barrier: no_write_privilege, pgvector 0.8.2, mode: tokenmax.
Question forms eligible: 0 of 100 (questions loaded: 50, dropped for an absent gold page: 0).

## Arms, all queries (both forms)

| Arm | n | success@1 | success@5 (95% CI) | success@10 | success@20 | MRR | pages returned |
|---|---|---|---|---|---|---|---|
| keyword | invalid: no_eligible_queries | | | | | | |
| vector | invalid: no_eligible_queries | | | | | | |
| hybrid_lexical | invalid: no_eligible_queries | | | | | | |
| hybrid | invalid: no_eligible_queries | | | | | | |
| configured | invalid: no_eligible_queries | | | | | | |
| configured_window | invalid: no_eligible_queries | | | | | | |

## success@5 by type and form

| Arm | Type | exact n | exact | paraphrase n | paraphrase |
|---|---|---|---|---|---|

## Paired comparisons (delta = B minus A)

| Comparison | Metric | Pairs | A | B | Delta (95% CI) | p | Holm p | MDE |
|---|---|---|---|---|---|---|---|---|
| p1_hybrid_vs_hybrid_lexical (P1) | success_at_5 | 0 | n/a | n/a | n/a (n/a) | n/a |  | n/a |
| p1_hybrid_vs_hybrid_lexical (P1) | mrr | 0 | n/a | n/a | n/a (n/a) | n/a |  | n/a |
| p2_configured_vs_hybrid_lexical_paraphrase (P2) | success_at_5 | 0 | n/a | n/a | n/a (n/a) | n/a |  | n/a |
| p2_configured_vs_hybrid_lexical_paraphrase (P2) | mrr | 0 | n/a | n/a | n/a (n/a) | n/a |  | n/a |
| hybrid_lexical_vs_keyword | success_at_5 | 0 | n/a | n/a | n/a (n/a) | n/a |  | n/a |
| hybrid_lexical_vs_keyword | mrr | 0 | n/a | n/a | n/a (n/a) | n/a |  | n/a |
| hybrid_vs_keyword | success_at_5 | 0 | n/a | n/a | n/a (n/a) | n/a |  | n/a |
| hybrid_vs_keyword | mrr | 0 | n/a | n/a | n/a (n/a) | n/a |  | n/a |
| configured_vs_keyword_paraphrase | success_at_5 | 0 | n/a | n/a | n/a (n/a) | n/a |  | n/a |
| configured_vs_keyword_paraphrase | mrr | 0 | n/a | n/a | n/a (n/a) | n/a |  | n/a |
| configured_vs_hybrid | success_at_5 | 0 | n/a | n/a | n/a (n/a) | n/a |  | n/a |
| configured_vs_hybrid | mrr | 0 | n/a | n/a | n/a (n/a) | n/a |  | n/a |
| vector_vs_keyword | success_at_5 | 0 | n/a | n/a | n/a (n/a) | n/a |  | n/a |
| vector_vs_keyword | mrr | 0 | n/a | n/a | n/a (n/a) | n/a |  | n/a |
| configured_vs_keyword_exact | success_at_5 | 0 | n/a | n/a | n/a (n/a) | n/a |  | n/a |
| configured_vs_keyword_exact | mrr | 0 | n/a | n/a | n/a (n/a) | n/a |  | n/a |
| hybrid_vs_keyword_paraphrase | success_at_5 | 0 | n/a | n/a | n/a (n/a) | n/a |  | n/a |
| hybrid_vs_keyword_paraphrase | mrr | 0 | n/a | n/a | n/a (n/a) | n/a |  | n/a |
| window_vs_configured | success_at_5 | 0 | n/a | n/a | n/a (n/a) | n/a |  | n/a |
| window_vs_configured | mrr | 0 | n/a | n/a | n/a (n/a) | n/a |  | n/a |
| paraphrase_vs_exact_keyword | success_at_5 | 0 | n/a | n/a | n/a (n/a) | n/a |  | n/a |
| paraphrase_vs_exact_keyword | mrr | 0 | n/a | n/a | n/a (n/a) | n/a |  | n/a |
| paraphrase_vs_exact_vector | success_at_5 | 0 | n/a | n/a | n/a (n/a) | n/a |  | n/a |
| paraphrase_vs_exact_vector | mrr | 0 | n/a | n/a | n/a (n/a) | n/a |  | n/a |
| paraphrase_vs_exact_hybrid_lexical | success_at_5 | 0 | n/a | n/a | n/a (n/a) | n/a |  | n/a |
| paraphrase_vs_exact_hybrid_lexical | mrr | 0 | n/a | n/a | n/a (n/a) | n/a |  | n/a |
| paraphrase_vs_exact_hybrid | success_at_5 | 0 | n/a | n/a | n/a (n/a) | n/a |  | n/a |
| paraphrase_vs_exact_hybrid | mrr | 0 | n/a | n/a | n/a (n/a) | n/a |  | n/a |
| paraphrase_vs_exact_configured | success_at_5 | 0 | n/a | n/a | n/a (n/a) | n/a |  | n/a |
| paraphrase_vs_exact_configured | mrr | 0 | n/a | n/a | n/a (n/a) | n/a |  | n/a |

## Custody

Read-only verified at start: true, at end: true. Guard refusals by verb: telemetry_write 14.
Exclusions: hybrid_lexical_degraded 100.
Latency is harness latency (pool size 2, local database), not production latency. configured keeps gbrain's own default result limit, so its pages-returned column shows how deep success@10 and success@20 can reach.
