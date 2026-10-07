openai @ 1536 dims, 4766 pages, 60003 chunks, 100 queries
| selectivity | k | mode | recall@k | p50 ms | p95 ms | underfilled |
|---|---|---|---|---|---|---|
| 10% | 10 | strict_order | 1 | 70.7 | 89 | 0 |
| 10% | 10 | relaxed_order | 1 | 74.4 | 89.3 | 0 |
| 10% | 50 | strict_order | 1 | 77.2 | 90.2 | 0 |
| 10% | 50 | relaxed_order | 1 | 76.1 | 89.6 | 0 |
| 50% | 10 | strict_order | 0.95 | 12.3 | 17.5 | 0 |
| 50% | 10 | relaxed_order | 0.967 | 12.3 | 18.7 | 0 |
| 50% | 50 | strict_order | 0.937 | 18.9 | 28.4 | 0 |
| 50% | 50 | relaxed_order | 0.937 | 18.9 | 28 | 0 |
