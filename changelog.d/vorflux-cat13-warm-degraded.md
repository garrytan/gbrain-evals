**The concept-recall bench (cat13) now flags every search that ran degraded, and a degraded repeat search no longer counts in warm latency.**

### Added

- Each per-query row records `degraded` and, when true, a short `degraded_reason` (reason codes only, never error text). Each `--warm-passes` repeat gets its own entry in `warm_searches` with its latency and flag.
- For gbrain-backed arms, degraded means gbrain's own per-search report listed a problem. The problem can be that the vector arm did not run (`vector_not_enabled`), a fail-open stage fired (`meta.degraded`), the search meta was missing, the reranker or expansion did not match the pin, the relational arm errored, or the search threw. This is the same list that already marks a scored pass incomplete. The reranker arm uses its per-query reranker reports. Arms with no per-search report are degraded only when the query throws. The scorecard names which signal an arm used (`degraded_signal`).
- The warm block reports `searches`, `clean_searches`, `warm_excluded_degraded` and a count per reason, and the run log prints the excluded count beside warm p50 and p95.

### Fixed

- Warm p50 and p95 are computed from clean repeat searches only. Before, a repeat that fell back to keyword-only search, skipped the reranker or returned a partial result was timed into warm latency. First-pass latency rules are unchanged, because a degraded scored search on a gbrain-backed arm already makes the run incomplete.
