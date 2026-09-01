<!-- aggregated from eval/reports/longmemeval/rescore-may-copy.ndjson -->
# LongMemEval results

Dataset: `s`  |  Top-K: 5  |  recall_all@k is the official LongMemEval headline; recall_any@k (any-hit) is strictly looser and shown as a diagnostic. `_abs` questions are excluded from recall denominators (official protocol) and scored as abs_noise@k.

| Adapter | n | recall_all@k | recall_any@k | ndcg_any@k | abs_noise@k (n_abs) | errors (sut/infra) | p50 | p99 | Wall |
|---|---|---|---|---|---|---|---|---|---|
| gbrain-keyword | 470 | 10.64% | 20.43% | 16.22% | 2.67% (30) | 0/0 | 640ms | 2235ms | 414s |
| gbrain-vector | 470 | 79.36% | 97.45% | 88.67% | 32.67% (30) | 0/0 | 14455ms | 32052ms | 6638s |
| gbrain-hybrid | 470 | 83.40% | 97.66% | 90.58% | 33.33% (30) | 0/0 | 2243ms | 14643ms | 1500s |
| gbrain-hybrid+expansion | 470 | 84.26% | 97.66% | 90.83% | 35.33% (30) | 0/0 | 3581ms | 7357ms | 1960s |

## recall_all by question_type

| question_type | total | gbrain-keyword | gbrain-vector | gbrain-hybrid | gbrain-hybrid+expansion |
|---|---|---|---|---|---|
| knowledge-update | 72 | 12.5% (9/72) | 91.7% (66/72) | 98.6% (71/72) | 98.6% (71/72) |
| multi-session | 121 | 0.0% (0/121) | 65.3% (79/121) | 71.9% (87/121) | 71.1% (86/121) |
| single-session-assistant | 56 | 1.8% (1/56) | 100.0% (56/56) | 100.0% (56/56) | 100.0% (56/56) |
| single-session-preference | 30 | 6.7% (2/30) | 93.3% (28/30) | 93.3% (28/30) | 93.3% (28/30) |
| single-session-user | 64 | 46.9% (30/64) | 96.9% (62/64) | 96.9% (62/64) | 96.9% (62/64) |
| temporal-reasoning | 127 | 6.3% (8/127) | 64.6% (82/127) | 69.3% (88/127) | 73.2% (93/127) |
