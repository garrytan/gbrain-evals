<!-- aggregated from ~/lme/1a-R/rows.ndjson -->
# LongMemEval results

Dataset: `s`  |  Top-K: 5  |  recall_all@k is the official LongMemEval headline; recall_any@k (any-hit) is strictly looser and shown as a diagnostic. `_abs` questions are excluded from recall denominators (official protocol) and scored as abs_noise@k. div@k = mean DISTINCT sessions in the scored top-k; shortfall = fraction of scored rows with fewer than k distinct sessions available (pre-slice supply for sessdiv rows).

| Adapter | n | recall_all@k | recall_any@k | ndcg_any@k | div@k | shortfall | abs_noise@k (n_abs) | errors (sut/infra) | p50 | p99 | Wall |
|---|---|---|---|---|---|---|---|---|---|---|---|
| gbrain-hybrid | 470 | 92.77% | 98.51% | 93.26% | 4.91 | 9.15% | 36.67% (30) | 0/0 | 43650ms | 177229ms | 29514s |
| gbrain-hybrid+expansion | 470 | 93.62% | 99.36% | 94.04% | 5.00 | 0.00% | 37.33% (30) | 0/0 | 8045ms | 16919ms | 4287s |
| gbrain-hybrid-sessdiv | 470 | 92.98% | 98.51% | 93.32% | 5.00 | 0.00% | 36.67% (30) | 0/0 | 2539ms | 4951ms | 1400s |
| gbrain-hybrid+rerank | 470 | 95.96% | 99.79% | 96.07% | 4.90 | 10.00% | 36.00% (30) | 0/0 | 3487ms | 6592ms | 1911s |
| gbrain-hybrid-sessdiv+rerank | 470 | 96.17% | 99.79% | 96.12% | 5.00 | 0.00% | 36.00% (30) | 0/0 | 3216ms | 5490ms | 1737s |

## recall_all by question_type

| question_type | total | gbrain-hybrid | gbrain-hybrid+expansion | gbrain-hybrid-sessdiv | gbrain-hybrid+rerank | gbrain-hybrid-sessdiv+rerank |
|---|---|---|---|---|---|---|
| knowledge-update | 72 | 98.6% (71/72) | 98.6% (71/72) | 98.6% (71/72) | 100.0% (72/72) | 100.0% (72/72) |
| multi-session | 121 | 90.1% (109/121) | 90.1% (109/121) | 90.1% (109/121) | 93.4% (113/121) | 93.4% (113/121) |
| single-session-assistant | 56 | 100.0% (56/56) | 100.0% (56/56) | 100.0% (56/56) | 100.0% (56/56) | 100.0% (56/56) |
| single-session-preference | 30 | 96.7% (29/30) | 100.0% (30/30) | 96.7% (29/30) | 100.0% (30/30) | 100.0% (30/30) |
| single-session-user | 64 | 98.4% (63/64) | 98.4% (63/64) | 98.4% (63/64) | 100.0% (64/64) | 100.0% (64/64) |
| temporal-reasoning | 127 | 85.0% (108/127) | 87.4% (111/127) | 85.8% (109/127) | 91.3% (116/127) | 92.1% (117/127) |
