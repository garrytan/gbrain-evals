### Tests run against gbrain v0.60.743.0

- `package.json` and `bun.lock` move the `gbrain` dependency from v0.60.733.0 (`6ce7195b4`) to v0.60.743.0
  (`16124807c`), gbrain's newest release on 2026-11-19, 10 releases and 101 commits later.
  [docs/gbrain-under-test.md](docs/gbrain-under-test.md#the-pin) names the new pin. No result was rerun.
- [test/eval/sharing-contract.test.ts](test/eval/sharing-contract.test.ts) now runs its 12 scenarios in CI instead of
  skipping, because the pin is past v0.60.738.0. Its `fetch` now refuses any host but `127.0.0.1`, and a scenario
  fails if it called `fetch` for another host.
- gbrain v0.60.743.0 ships a `src/core/rust-engine` folder, but its engine factory still doesn't construct a rust
  engine. So the rust arm refuses with `rust_kind_unsupported` instead of `rust_engine_not_in_build`, and the tests
  that run on the pinned build expect that reason.
  [eval/runner/engine-bench/perf.ts](eval/runner/engine-bench/perf.ts) now checks rust with the shared preflight before
  any work, so it still refuses with exit code 3. It no longer runs the PGLite arm first and then exits 1 when the rust
  child fails.
