- **Rust engine gate suites close the last ways a broken run could pass or hide a Rust failure.**

### Fixed

- Cat 27 reads NOT_RUN when the TypeScript engines scored no probe, so a run where every engine errored on every probe no longer passes on empty, matching aggregates. Its error count now counts only errors from the system under test, so a harness error on PGLite or Postgres is no longer charged to Rust.
- Cat 13 now also needs the same query text for every query id and the same gold-store fingerprint on every engine, so two corpus revisions with the same number of queries never pair.
- A Rust receipt that lacks a measured value (for example a crashed Cat 19 run with no health snapshot) is FAIL, where it read NOT_RUN. A TypeScript receipt that lacks one still reads NOT_RUN.
- A Rust cell killed by SIGSEGV, SIGABRT or SIGBUS, with a run log at the TypeScript engines' build, is FAIL, because those are crashes of the engine under test. SIGKILL and SIGTERM (a harness timeout or out-of-memory kill) still read NOT_RUN.
- An unreadable or old-format `exit.json` counts as no exit record for that cell instead of stopping `emit` for every suite.
