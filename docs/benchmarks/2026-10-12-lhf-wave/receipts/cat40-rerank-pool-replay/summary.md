# Cat 40 rerank-pool replay: 25 vs 50

gbrain f77f1418caed, search.mode tokenmax, top_n_in 50 vs 25. Calls: 1030 of 1030 (excluded, op error in both arms: 0; missing pairs: 0).

**Gate:** gold hit@5 under 25 is 37.0% vs 37.9% under 50 over 966 paired calls; difference -0.93 pts, one-sided 95% lower bound -1.55 pts (margin -1 pt). Verdict: **inconclusive**.

| Arm | calls | ok | op error | rerank failed | rerank missing | reused | gold calls | gold hit@5 | rerank tokens | valid |
|---|---|---|---|---|---|---|---|---|---|---|
| 50 | 1030 | 1030 | 0 | 0 | 0 | 0 | 966 | 37.9% | 4786415 | yes |
| 25 | 1030 | 1030 | 0 | 0 | 0 | 0 | 966 | 37.0% | 2609230 | yes |

**Top-20 overlap** (n 1030): mean 0.772, median 0.8, p10 0.55, min 0.2; identical 96. Buckets: 1.0: 96, 0.90-0.99: 211, 0.75-0.89: 358, 0.50-0.74: 320, <0.50: 45.

**Pool rows 26 to 50 in the top 20 (arm 50):** 933 of 1030 calls whose pool exceeded 25 (90.6%), 4211 rows in all.

**Prefix check:** the 25 pool was the first 25 of the 50 pool on 1030 of 1030 calls; 0 reranked documents could not be mapped to a chunk.

| Family | calls | gold calls | hit@5 50 | hit@5 25 | mean overlap | rows 26-50 entered (rate) |
|---|---|---|---|---|---|---|
| H1 | 128 | 128 | 7.0% | 7.8% | 0.6961 | 86.7% |
| H2 | 166 | 166 | 22.9% | 20.5% | 0.811 | 87.4% |
| H3 | 435 | 435 | 54.5% | 53.6% | 0.7739 | 90.6% |
| H4 | 237 | 237 | 34.6% | 33.8% | 0.7618 | 94.1% |
| H5 | 64 | 0 | n/a | n/a | 0.8477 | 93.8% |

