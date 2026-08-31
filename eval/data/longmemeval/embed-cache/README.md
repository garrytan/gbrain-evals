# Embedding cache — content-addressed (NOT committed)

SHA-256(text) → vector. Filled by `bun eval/runner/longmemeval.ts`.

Cache files land at `eval/reports/longmemeval/embed-cache/embed-cache-<model>@<dimensions>.sqlite`
— the runner's default `--cache-dir` (longmemeval.ts `parseOpts`). This
directory under `eval/data/` holds only this README: no cache fixture ships
in the repo. The `eval/reports/` location is gitignored because the full `_s`
split cache is ~700MB, too big for plain git. First-time runs cost ~$2 in
OpenAI embeddings; subsequent runs hit the local cache and complete in
minutes for ~$0.

Cache properties:

- **Content-addressed.** Different chunk text → different SHA-256 → cache miss.
  No way for a tampered cache to inject wrong vectors.
- **Auto-invalidating.** Cache key includes `(model_id, dimensions)`. Switching
  to a different embedding model invalidates the entire cache without manual
  cleanup.
- **Shareable.** Anyone with the same dataset re-derives identical SHA-256 keys
  and warms their own cache from a fresh run, OR copies the binary file into
  `eval/reports/longmemeval/embed-cache/` and skips the cold-start cost.

To share a warm cache across a team without git: copy the SQLite file via
`scp`, `aws s3`, etc. The cache is concurrency-safe (WAL mode + 10s
busy_timeout) so multiple workers can read+write the same file.
