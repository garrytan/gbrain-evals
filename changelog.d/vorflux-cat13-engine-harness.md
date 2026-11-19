**The concept-recall bench (cat13) can now run its gbrain arm on PGLite, Postgres or gbrain's Rust engine, and time each query.**

### Added

- `GBRAIN_EVAL_ENGINE=pglite|postgres|rust` picks the storage engine for cat13's gbrain arm. Without it the arm keeps its in-memory PGLite brain. Postgres needs `--pg-url` or `LIFECYCLE_PG_URL` and gets a scratch database per run. The receipt records only whether the Postgres server was local (`postgres_server: loopback|remote`), never its host.
- Before any paid request, the run stops with exit 69 and writes a skipped receipt when Postgres has no URL or cannot make a scratch database, or when the Rust engine is missing from the gbrain build or its addon does not load. A Rust engine that loads but refuses a later step still fails the run as before.
- `--embed-cache <sqlite>` lets every engine search the same cached vectors. The receipt records the cache's file name and hit counts.
- Each per-query row records `latency_ms`.
- `--warm-passes N` (0 to 10) runs the same probes again on the same brain after the scored pass, timed but not scored, so a receipt reports first-pass and repeat-pass latency apart.

### Fixed

- The Rust engine's init step now receives `GBRAIN_RUST_ENGINE_ADDON`, so a locally built addon loads.
