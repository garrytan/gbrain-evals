- **Rust engine gate suites can no longer report a false pass or a false fail from a broken or mismatched run.**

### Fixed

- Cat 19's gate count now counts only gates that scored 1, so a gate that scored 0 without an error fails the suite instead of counting as passed. Cat 19 receipts list each gate's score under `data.gates`, and a receipt without them reads NOT_RUN.
- Cat 27 now also requires the same number of scored probes and errors on every engine, so a Rust probe that crashed can no longer pass on the probes that ran.
- A Rust cell with no receipt reads FAIL only when its runner left a run log and exited with a nonzero code at the TypeScript engines' gbrain build. A cell that never started, was killed by a signal or ran another build reads NOT_RUN. `run` records each runner's exit in `exit.json` beside its log.
- Receipts that embedded differently (stub, live or none, or another model or width) read NOT_RUN instead of being compared, and Cat 13 also needs the full, identical query set on every engine.
- `run` refuses a `--gbrain` build named by a tag, a branch or no ref. It needs `<checkout>@<sha>`, so a Rust cell that failed without a receipt can be matched to the TypeScript engines' build.
- In a paid run PGLite always fills the shared embedding cache and every other engine only reads it, and `run --paid` refuses an engine order that does not put PGLite first.
