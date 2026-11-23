- **Rust engine gate suites close the last ways a broken run could pass or hide a Rust failure.**

### Fixed

- Cat 27 reads NOT_RUN when the TypeScript engines scored no probe, so a run where every engine errored on every probe no longer passes on empty, matching aggregates. Its error count now counts only errors from the system under test, so a harness error is not counted as an engine error. A probe a harness error left unscored still shows in that engine's probes scored.
- Cat 13 now also needs the same query text for every query id and the same gold-store fingerprint on every engine, so runs whose queries or gold labels differ never pair. A counted Cat 13 file needs that fingerprint on every engine.
- A Rust receipt that lacks a measured value (for example a crashed Cat 19 run with no health snapshot) is FAIL, where it read NOT_RUN. A TypeScript receipt that lacks one still reads NOT_RUN.
- A Rust cell killed by SIGSEGV, SIGABRT or SIGBUS, with a run log at the TypeScript engines' build, is FAIL, because those are crashes of the engine under test. SIGKILL and SIGTERM (a harness timeout or out-of-memory kill) still read NOT_RUN. The engine-bench preregistration adopts this rule in a 2026-11-23 amendment.
- An unreadable or old-format `exit.json` counts as no exit record for that cell instead of stopping `emit` for every suite.
- When the engines' receipts pair, `gate-suites.ts emit --counted` refuses Cat 13 and Cat 13b unless every engine embedded live with OpenAI text-embedding-3-large at 1536 dimensions, and then writes no file. Receipts that embedded differently from each other still read NOT_RUN.
- `run` refuses a Rust addon file whose SHA-256 is not the one `GBRAIN_RUST_ENGINE_ADDON_SHA256` names, before it loads anything.
- A Rust run that fails without a receipt now records the addon digest `run` checked and the addon's target (from its loader, or from its file name when it doesn't load), where its suite file had `rust_addon: null`, so a FINAL `eval-gates.json` counts that FAIL under E1 to E3 instead of refusing the file.
