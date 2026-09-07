# autocut floor replay — /home/vercel-sandbox/gbrain-lme-receipts/A4.ndjson
rows=500 skipped_error=0 k=5 jump=0.2 minKeep=1

validate-live @ 0.35: OK (500 rows reproduce the recorded live decision)

## all rows
| floor | n | recall_all@k | recall_any@k | autocut applied | mean returned | mean est_tokens | mean kept pool |
|---|---|---|---|---|---|---|---|
| off | 500 | 475 (95.00%) | 499 (99.80%) | 0 | 5.00 | 3256 | 47.35 |
| 0.10 | 500 | 399 (79.80%) | 497 (99.40%) | 365 | 2.49 | 1633 | 13.81 |
| 0.20 | 500 | 399 (79.80%) | 497 (99.40%) | 365 | 2.49 | 1633 | 13.81 |
| 0.35 | 500 | 399 (79.80%) | 497 (99.40%) | 365 | 2.49 | 1633 | 13.81 |
| 0.50 | 500 | 413 (82.60%) | 498 (99.60%) | 307 | 2.88 | 1875 | 19.08 |
| 0.65 | 500 | 444 (88.80%) | 499 (99.80%) | 187 | 3.67 | 2382 | 30.02 |
| 0.80 | 500 | 466 (93.20%) | 499 (99.80%) | 91 | 4.33 | 2817 | 38.88 |

## paired recall_all vs first floor
| floor | baseline | wins | losses | net | per-type net |
|---|---|---|---|---|---|
| off | off | 0 | 0 | +0 | single-session-user:+0 multi-session:+0 single-session-preference:+0 temporal-reasoning:+0 knowledge-update:+0 single-session-assistant:+0 |
| 0.10 | off | 0 | 76 | -76 | single-session-user:+0 multi-session:-25 single-session-preference:+0 temporal-reasoning:-30 knowledge-update:-21 single-session-assistant:+0 |
| 0.20 | off | 0 | 76 | -76 | single-session-user:+0 multi-session:-25 single-session-preference:+0 temporal-reasoning:-30 knowledge-update:-21 single-session-assistant:+0 |
| 0.35 | off | 0 | 76 | -76 | single-session-user:+0 multi-session:-25 single-session-preference:+0 temporal-reasoning:-30 knowledge-update:-21 single-session-assistant:+0 |
| 0.50 | off | 0 | 62 | -62 | single-session-user:+0 multi-session:-21 single-session-preference:+0 temporal-reasoning:-20 knowledge-update:-21 single-session-assistant:+0 |
| 0.65 | off | 0 | 31 | -31 | single-session-user:+0 multi-session:-6 single-session-preference:+0 temporal-reasoning:-6 knowledge-update:-19 single-session-assistant:+0 |
| 0.80 | off | 0 | 9 | -9 | single-session-user:+0 multi-session:+0 single-session-preference:+0 temporal-reasoning:+0 knowledge-update:-9 single-session-assistant:+0 |

## half A (seed seed42)
| floor | n | recall_all@k | recall_any@k | autocut applied | mean returned | mean est_tokens | mean kept pool |
|---|---|---|---|---|---|---|---|
| off | 250 | 237 (94.80%) | 249 (99.60%) | 0 | 5.00 | 3284 | 47.01 |
| 0.10 | 250 | 193 (77.20%) | 249 (99.60%) | 181 | 2.47 | 1639 | 13.90 |
| 0.20 | 250 | 193 (77.20%) | 249 (99.60%) | 181 | 2.47 | 1639 | 13.90 |
| 0.35 | 250 | 193 (77.20%) | 249 (99.60%) | 181 | 2.47 | 1639 | 13.90 |
| 0.50 | 250 | 201 (80.40%) | 249 (99.60%) | 154 | 2.84 | 1871 | 18.77 |
| 0.65 | 250 | 218 (87.20%) | 249 (99.60%) | 93 | 3.66 | 2405 | 29.88 |
| 0.80 | 250 | 233 (93.20%) | 249 (99.60%) | 49 | 4.30 | 2827 | 37.95 |

## half B (seed seed42)
| floor | n | recall_all@k | recall_any@k | autocut applied | mean returned | mean est_tokens | mean kept pool |
|---|---|---|---|---|---|---|---|
| off | 250 | 238 (95.20%) | 250 (100.00%) | 0 | 5.00 | 3228 | 47.68 |
| 0.10 | 250 | 206 (82.40%) | 248 (99.20%) | 184 | 2.52 | 1626 | 13.71 |
| 0.20 | 250 | 206 (82.40%) | 248 (99.20%) | 184 | 2.52 | 1626 | 13.71 |
| 0.35 | 250 | 206 (82.40%) | 248 (99.20%) | 184 | 2.52 | 1626 | 13.71 |
| 0.50 | 250 | 212 (84.80%) | 249 (99.60%) | 153 | 2.93 | 1880 | 19.38 |
| 0.65 | 250 | 226 (90.40%) | 250 (100.00%) | 94 | 3.67 | 2359 | 30.16 |
| 0.80 | 250 | 233 (93.20%) | 250 (100.00%) | 42 | 4.36 | 2807 | 39.82 |

## top rerank score histogram
| bin | count |
|---|---|
| [0.0, 0.1) | 0 |
| [0.1, 0.2) | 0 |
| [0.2, 0.3) | 0 |
| [0.3, 0.4) | 43 |
| [0.4, 0.5) | 117 |
| [0.5, 0.6) | 108 |
| [0.6, 0.7) | 73 |
| [0.7, 0.8) | 67 |
| [0.8, 0.9) | 77 |
| [0.9, 1.0) | 15 |

Glossary: recall_all@k = every gold session among the distinct sessions of the first k kept chunk rows; recall_any@k = at least one; mean est_tokens = returned-window token estimate (autocut benefit metric).
