- **The gate suites in gbrain's Rust engine plan now run on PGLite, Postgres or the Rust engine at a named gbrain build, and a new runner writes one pass, fail or not-run file per suite.**

### Added

- `GBRAIN_EVAL_ENGINE=pglite|postgres|rust` and `--gbrain <checkout>@<sha>` now work on every suite that gbrain's [RUST_ENGINE.md](https://github.com/garrytan/gbrain/blob/master/docs/designs/RUST_ENGINE.md) names in its eval gates E1 to E3: Cat 13, Cat 13b, Cat 10, Cat 12, Cat 7, BrainBench Cats 1+2 (`multi-adapter.ts` and `before-after.ts`), Cat 3, Cat 4, type-accuracy, Cat 24, Cat 22, Cat 19, Cat 27 and Cat 23. Each runner loads every gbrain module and the engine from the named build, writes its receipt to `eval/reports/<category>/engine-<kind>/`, and records the engine, the build and the Rust addon's SHA-256. With neither set, each runner scores exactly as before.
- `eval/runner/memory-verb-conformance.ts` runs gbrain's MEMORY_VERBS v1 conformance cases through `dispatchToolCall` on any engine, keyless, with the chat and embedding transports rigged to fail.
- `eval/runner/engine-bench/gate-suites.ts` runs those 15 suites on the three engines at one build and writes one `engine-bench.gate-suite/1` file per suite, with each suite's verdict, the measurements per engine and every metric Rust loses. It reads Cat 1 on the graph-first P@5 and R@5 of `before-after.ts`, with the `multi-adapter.ts` rows reported beside it; Cat 3 on R@5 and P@5 from its ranks; type-accuracy on strict F1, type accuracy and per-type F1, listing any query or edge where Rust differs as a divergence; Cat 13 on the per-query paired lower bound, with a strict comparison row beside it; and Cat 12 on its 24 assertions plus the same MCP operation count on every engine.
- A failing suite names the gbrain file and line of every engine call the Rust run refused. Gate runners record those call sites to the file `GBRAIN_EVAL_RUST_REFUSALS_FILE` names, and Cat 19 adds the site to its error message.
- `GBRAIN_RUST_ENGINE_ADDON_SHA256` makes a gate runner refuse any Rust addon file with a different digest before it opens a brain.
- Cat 13b takes `--embed-cache <sqlite>` and `--embed-cache-only`, and its live embeddings run under the budget ledger like Cat 13's. Cat 13 takes `--embed-cache-only` and `--budget-run-id` too, so in a paid gate run only the engine that fills the shared cache can call the provider.
- type-accuracy can also score the links the engine stores, and multi-adapter's engine-aware rows take `--stub-embed`.

### Changed

- Cats 19, 22, 24 and 27 no longer run raw SQL. They write sources and links and read provenance and counts through gbrain's typed engine calls, so they run on the Rust engine, which refuses raw SQL.
- A Rust brain made for a run now takes the run's embedding model and width, as PGLite and Postgres brains do. It used to take gbrain's default width, so any runner that embedded at another width failed on Rust alone.
