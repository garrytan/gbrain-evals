## 1,000 pages

Receipt generated 2026-11-17T03:22:10.269Z. Counted: yes. Comparison: `pglite_vs_postgres`.

### Decision rule outcome

**pglite_adequate**. hybrid ratio 1.35 (95% interval 1.33 to 1.36), margin 2. PGLite hybrid p95 16.3 ms, interactive limit 100 ms.

### Paired latency (PGLite over Postgres + pgvector)

| Operation | n | Postgres + pgvector p50 / p95 (ms) | PGLite p50 / p95 (ms) | Mean difference, ms (95% interval) | Ratio (95% interval) | Holm p |
|---|---:|---:|---:|---:|---:|---:|
| get_page | 300 | 0.473 / 1.82 | 0.502 / 0.702 | -0.062 (-0.109 to -0.019) | 1.00 (0.951 to 1.05) | 0.007 |
| search_keyword | 300 | 4.44 / 6.04 | 6.01 / 9.59 | 1.99 (1.87 to 2.12) | 1.41 (1.39 to 1.44) | 9.00e-4 |
| search_vector | 300 | 5.32 / 6.49 | 7.17 / 7.91 | 1.73 (1.65 to 1.82) | 1.32 (1.30 to 1.34) | 9.00e-4 |
| search_hybrid_rrf | 300 | 9.96 / 11.8 | 13.1 / 16.3 | 3.52 (3.39 to 3.66) | 1.35 (1.33 to 1.36) | 9.00e-4 |
| search_keyword_filtered | 300 | 4.30 / 5.23 | 5.61 / 7.22 | 1.53 (1.46 to 1.59) | 1.35 (1.34 to 1.36) | 9.00e-4 |
| search_vector_filtered | 300 | 7.42 / 8.54 | 12.4 / 12.8 | 4.90 (4.82 to 4.97) | 1.65 (1.64 to 1.67) | 9.00e-4 |
| get_backlinks | 300 | 0.274 / 0.627 | 0.216 / 0.298 | -0.131 (-0.165 to -0.099) | 0.710 (0.669 to 0.753) | 9.00e-4 |
| list_pages | 300 | 0.954 / 2.82 | 1.50 / 1.64 | 0.282 (0.200 to 0.361) | 1.37 (1.31 to 1.44) | 9.00e-4 |
| get_timeline | 300 | 0.170 / 0.359 | 0.134 / 0.243 | -0.070 (-0.104 to -0.038) | 0.736 (0.698 to 0.774) | 9.00e-4 |

Order check, mean difference in ms by who ran first:

| Operation | Postgres + pgvector first (n) | PGLite first (n) |
|---|---:|---:|
| get_page | 0.033 (138) | -0.143 (162) |
| search_keyword | 2.01 (158) | 1.96 (142) |
| search_vector | 1.84 (158) | 1.61 (142) |
| search_hybrid_rrf | 3.63 (165) | 3.39 (135) |
| search_keyword_filtered | 1.62 (151) | 1.43 (149) |
| search_vector_filtered | 5.05 (152) | 4.75 (148) |
| get_backlinks | -0.083 (157) | -0.182 (143) |
| list_pages | 0.481 (142) | 0.104 (158) |
| get_timeline | -0.030 (150) | -0.111 (150) |

### Cost per 1,000 operations (price model 2026-11-16)

| Operation | blocks x ops | Postgres + pgvector USD | PGLite USD | Difference, USD (95% interval) | Postgres + pgvector CPU s | PGLite CPU s | CPU s difference (95% interval) |
|---|---:|---:|---:|---:|---:|---:|---:|
| get_page | 20 x 50 | $4.70e-6 | $4.67e-6 | -$2.15e-8 (-$1.39e-6 to $9.40e-7) | 0.408 | 0.349 | -0.059 (-0.179 to 0.025) |
| search_keyword | 20 x 50 | $6.13e-5 | $9.04e-5 | $2.91e-5 ($2.74e-5 to $3.06e-5) | 5.33 | 6.56 | 1.23 (1.09 to 1.36) |
| search_vector | 20 x 50 | $7.30e-5 | $9.81e-5 | $2.51e-5 ($2.25e-5 to $2.75e-5) | 6.35 | 7.13 | 0.784 (0.556 to 0.992) |
| search_hybrid_rrf | 20 x 50 | $1.20e-4 | $1.87e-4 | $6.73e-5 ($6.03e-5 to $7.41e-5) | 10.4 | 13.6 | 3.14 (2.53 to 3.73) |

### Quality, paired per query

| Mode | Metric | n | Postgres + pgvector | PGLite | Difference (95% interval) | Queries that differ |
|---|---|---:|---:|---:|---:|---:|
| keyword | Recall@5 | 71 | 0.092 | 0.092 | 0 (0 to 0) | 0 |
| keyword | nDCG@10 | 71 | 0.075 | 0.075 | 0 (0 to 0) | 0 |
| vector | Recall@5 | 71 | 0.230 | 0.230 | 0 (0 to 0) | 0 |
| vector | nDCG@10 | 71 | 0.165 | 0.165 | 0 (0 to 0) | 0 |
| hybrid | Recall@5 | 71 | 0.265 | 0.265 | 0 (0 to 0) | 0 |
| hybrid | nDCG@10 | 71 | 0.210 | 0.210 | 0 (0 to 0) | 0 |

### Descriptive, one run each

| Measure | Postgres + pgvector | PGLite |
|---|---:|---:|
| Bulk import of 1,000 pages (pages/s) | 67.5 | 52.1 |
| Chunk upserts during import (chunks/s) | 264 | 160 |
| Cold start to first answer (ms) | 457 | 801 |
| Peak memory (engine plus server) (MB) | 253 | 2,146 |
| On-disk size, no WAL (MB) | 86.3 | 85.9 |
| Empty keyword result rate | 0.859 | 0.859 |
| CPU seconds per 1,000 mixed queries | 7.07 | 8.72 |
| USD per 1,000 mixed queries | $8.14e-5 | $1.20e-4 |

## 10,000 pages

Receipt generated 2026-11-17T03:35:52.189Z. Counted: yes. Comparison: `pglite_vs_postgres`.

### Decision rule outcome

**pglite_adequate**. hybrid ratio 1.45 (95% interval 1.41 to 1.50), margin 2. PGLite hybrid p95 86.8 ms, interactive limit 100 ms.

### Paired latency (PGLite over Postgres + pgvector)

| Operation | n | Postgres + pgvector p50 / p95 (ms) | PGLite p50 / p95 (ms) | Mean difference, ms (95% interval) | Ratio (95% interval) | Holm p |
|---|---:|---:|---:|---:|---:|---:|
| get_page | 300 | 1.37 / 2.74 | 3.67 / 3.99 | 2.08 (2.00 to 2.15) | 2.46 (2.36 to 2.56) | 9.00e-4 |
| search_keyword | 300 | 4.94 / 26.8 | 6.43 / 65.3 | 9.82 (7.93 to 11.9) | 1.36 (1.29 to 1.44) | 9.00e-4 |
| search_vector | 300 | 9.47 / 11.5 | 11.9 / 14.7 | 2.51 (2.39 to 2.64) | 1.27 (1.26 to 1.28) | 9.00e-4 |
| search_hybrid_rrf | 300 | 16.0 / 39.5 | 21.3 / 86.8 | 13.6 (11.6 to 15.8) | 1.45 (1.41 to 1.50) | 9.00e-4 |
| search_keyword_filtered | 300 | 4.00 / 15.2 | 3.94 / 30.0 | 3.34 (2.57 to 4.18) | 1.10 (1.05 to 1.16) | 9.00e-4 |
| search_vector_filtered | 300 | 51.4 / 54.6 | 20.5 / 27.4 | -30.9 (-31.4 to -30.4) | 0.393 (0.384 to 0.401) | 9.00e-4 |
| get_backlinks | 300 | 1.16 / 2.34 | 3.39 / 3.66 | 2.04 (1.97 to 2.11) | 2.69 (2.58 to 2.80) | 9.00e-4 |
| list_pages | 300 | 0.979 / 3.12 | 1.50 / 1.61 | 0.234 (0.133 to 0.335) | 1.33 (1.26 to 1.40) | 9.00e-4 |
| get_timeline | 300 | 0.245 / 0.655 | 0.171 / 0.243 | -0.147 (-0.186 to -0.112) | 0.627 (0.588 to 0.668) | 9.00e-4 |

Order check, mean difference in ms by who ran first:

| Operation | Postgres + pgvector first (n) | PGLite first (n) |
|---|---:|---:|
| get_page | 2.29 (138) | 1.89 (162) |
| search_keyword | 9.80 (158) | 9.83 (142) |
| search_vector | 2.49 (158) | 2.54 (142) |
| search_hybrid_rrf | 14.7 (165) | 12.3 (135) |
| search_keyword_filtered | 3.24 (151) | 3.44 (149) |
| search_vector_filtered | -30.2 (152) | -31.6 (148) |
| get_backlinks | 2.15 (157) | 1.91 (143) |
| list_pages | 0.425 (142) | 0.062 (158) |
| get_timeline | -0.075 (150) | -0.219 (150) |

### Cost per 1,000 operations (price model 2026-11-16)

| Operation | blocks x ops | Postgres + pgvector USD | PGLite USD | Difference, USD (95% interval) | Postgres + pgvector CPU s | PGLite CPU s | CPU s difference (95% interval) |
|---|---:|---:|---:|---:|---:|---:|---:|
| get_page | 20 x 50 | $1.29e-5 | $4.95e-5 | $3.66e-5 ($3.60e-5 to $3.73e-5) | 1.09 | 3.59 | 2.49 (2.44 to 2.55) |
| search_keyword | 20 x 50 | $1.19e-4 | $2.70e-4 | $1.51e-4 ($1.25e-4 to $1.79e-4) | 10.2 | 19.5 | 9.32 (7.58 to 11.2) |
| search_vector | 20 x 50 | $1.29e-4 | $1.59e-4 | $2.93e-5 ($2.46e-5 to $3.38e-5) | 11.0 | 11.5 | 0.444 (0.033 to 0.843) |
| search_hybrid_rrf | 20 x 50 | $2.66e-4 | $4.73e-4 | $2.07e-4 ($1.78e-4 to $2.39e-4) | 22.7 | 34.2 | 11.5 (9.44 to 13.7) |

### Quality, paired per query

| Mode | Metric | n | Postgres + pgvector | PGLite | Difference (95% interval) | Queries that differ |
|---|---|---:|---:|---:|---:|---:|
| keyword | Recall@5 | 71 | 0.063 | 0.063 | 0 (0 to 0) | 0 |
| keyword | nDCG@10 | 71 | 0.064 | 0.064 | 0 (0 to 0) | 0 |
| vector | Recall@5 | 71 | 0.042 | 0.042 | 0 (0 to 0) | 0 |
| vector | nDCG@10 | 71 | 0.035 | 0.035 | 0 (0 to 0) | 0 |
| hybrid | Recall@5 | 71 | 0.092 | 0.092 | 0 (0 to 0) | 0 |
| hybrid | nDCG@10 | 71 | 0.092 | 0.092 | 0 (0 to 0) | 0 |

### Descriptive, one run each

| Measure | Postgres + pgvector | PGLite |
|---|---:|---:|
| Bulk import of 10,000 pages (pages/s) | 63.7 | 29.8 |
| Chunk upserts during import (chunks/s) | 216 | 89.4 |
| Cold start to first answer (ms) | 507 | 885 |
| Peak memory (engine plus server) (MB) | 484 | 2,188 |
| On-disk size, no WAL (MB) | 411 | 429 |
| Empty keyword result rate | 0.859 | 0.859 |
| CPU seconds per 1,000 mixed queries | 13.5 | 23.5 |
| USD per 1,000 mixed queries | $1.59e-4 | $3.25e-4 |

