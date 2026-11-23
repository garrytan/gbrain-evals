- **Every engine arm in the engine bench now creates its brain with the run's embedding model and vector width, so the Rust arm no longer rejects every vector it saves.**

### Fixed

- The Rust arm used to create its brain through `gbrain init` with embedding switched off and no width. gbrain then fixed the vector column at its install default of 1024 dimensions, while the PGLite and Postgres arms took 1536 from the run. Every 1536-dimension save on the Rust arm failed with `embedding_plane_split`. The harness caused this, not the Rust engine.
- `openEvalEngine` and `openScratchEvalEngine` in `eval/runner/eval-engine.ts` take the run's embedding as `embedding`. The Rust arm writes that model and width into its `gbrain init` config and no longer writes `embedding_disabled`. The Postgres arm passes the same pair to `initSchema`. The PGLite arm takes its width from the gateway the runner configured, and the check below holds it to the run's width.
- After init each arm reads back the width its brain stores. That is the `embedding_dimensions` config row on every arm, plus the `content_chunks.embedding` column type on PGLite and Postgres. The run stops with `EvalEngineEmbeddingMismatch` and a message naming both widths when they differ or when no width can be read.
- The Cat 13 engine arms in `gbrain-inline.ts`, the LongMemEval recall bench and the performance bench pass their run's embedding. Keyless runners that never store a vector keep the old keyless Rust config.
- Tests in `test/eval/eval-engine.test.ts` check that all three arms get the same model and width with `embedding_disabled` absent, that a brain at another width stops the run, and that a real PGLite brain fails the check when the gateway width differs and passes when it matches.
