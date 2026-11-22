- **The free behavior checks now run on PGLite, Postgres or the Rust engine, chosen with `GBRAIN_EVAL_ENGINE`.**

### Added

- Cat 2 link types, temporal edges, the Cat 9 free checks, Cat 22 source isolation, Cat 24 capture provenance and Cats 37, 38 and 39 open their brains through `eval/runner/eval-engine.ts`. Set `GBRAIN_EVAL_ENGINE` to `pglite`, `postgres` or `rust` to pick the engine. Leave it unset and each check runs on PGLite as before, with the same receipt.
- Postgres runs create a scratch database through `--pg-url` or `LIFECYCLE_PG_URL` and drop it afterwards. Rust runs create the brain with a rust config and `gbrain init`, as a user does.
- A step that an engine refuses is reported as `engine_not_supported_by_runner` with its reason. It never counts as a pass or a fail, and a check with such a step is at best partial. The receipt lists these steps under `engine_not_supported_by_runner`.
- With an engine named, Cat 2 also scores the links that the engine stores after import and `extract links`, using the same scorer and floors as the extraction score.
- Cat 22 seeds its sources and graph edges through the engine's typed members when the engine has no raw SQL. Cat 24 reads provenance back through `getPage` and `getChunks` in that case.
- `--output <dir>` on Cat 2, Cat 22 and Cat 24 writes the receipt to a chosen directory, so a nightly job can keep one receipt per engine.
- Tests in `test/eval/behavior-checks-engine.test.ts` cover the step ledger, the verdict rule, the Cat 9 engine setup with a stub CLI, the Cat 22 typed seeding and the Cat 2 page import.
