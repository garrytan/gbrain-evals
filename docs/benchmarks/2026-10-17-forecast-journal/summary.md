# W7 forecast-journal gate: PASS

20 cohorts, 5622 predictions, fixtures sha256 `ad271efc7fb94cc53170984619bb9a9346c9ca98fdec826e6d8e66046a9fd44a`, as of 2026-10-16T00:00:00Z.

| Criterion | Threshold | Result |
|---|---|---|
| Median Spearman rho, shrunk accuracy vs true skill (12 holders, n >= 10) | >= 0.8 | 0.905 (90% of cohorts >= 0.8; raw accuracy 0.905) |
| Who-was-right set-F1, macro over 800 topics | >= 0.95 | 1.000 |
| Denominator (journal totals and per-holder counts) | exact | 0 mismatches |
| low_n flags | exact | 0 mismatches |
| Prediction times labelled since_date, uncertified | exact | 0 mismatches |
| Remote probes | all pass | 8/8 |

- pass: remote takes_list unchanged by horizons, no journal fields
- pass: remote takes_search unchanged by horizons, no journal fields
- pass: remote takes_scorecard {} unchanged, no groups or journal
- pass: local takes_scorecard {} unchanged by horizons
- pass: remote takes_scorecard {group_by: holder} refused
- pass: remote takes_scorecard {group_by: source} refused
- pass: remote takes_scorecard {min_n: 5} refused
- pass: no MCP op reads the journal or horizons

Per-cohort rho (shrunk): 0.741, 0.986, 0.853, 0.886, 0.958, 0.923, 0.874, 0.958, 0.923, 0.937, 0.937, 0.907, 0.902, 0.874, 0.874, 0.839, 0.921, 0.965, 0.748, 0.888

