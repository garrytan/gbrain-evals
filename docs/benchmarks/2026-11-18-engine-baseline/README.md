# Engine baseline on cat13: PGLite and Postgres match exactly; the Rust engine cannot run the bench yet

**On the cat13 conceptual-recall bench (548 probes, world-v1), gbrain returns the same top 5 on PGLite and on Postgres for every probe in every run: nDCG@5 55.7%, P@5 27.4%, R@5 79.5%, MRR@5 67.5%. Postgres in Docker answers about 4.7 times faster at p50 (43 ms against 201 ms). The Rust store engine refuses the first embedded import, so it has no quality or latency number yet.**

This is the first baseline that runs one gbrain build on three storage engines with the same corpus, probes, gold, vectors and machine. It is a descriptive baseline, not a claim that one engine is better.

## Results

| Engine | Scored runs | nDCG@5 | P@5 (graded) | R@5 | MRR@5 | p50 query ms | p95 query ms |
|---|---|---|---|---|---|---|---|
| PGLite (in-process, in memory) | 3 | 55.7% [55.7 to 55.7, sd 0.0] | 27.4% [27.4 to 27.4, sd 0.0] | 79.5% [79.5 to 79.5, sd 0.0] | 67.5% [67.5 to 67.5, sd 0.0] | 201 [200 to 202, sd 1] | 220 [219 to 220, sd 1] |
| Postgres 18.6 + pgvector 0.8.7 (Docker, same VM) | 3 | 55.7% [55.7 to 55.7, sd 0.0] | 27.4% [27.4 to 27.4, sd 0.0] | 79.5% [79.5 to 79.5, sd 0.0] | 67.5% [67.5 to 67.5, sd 0.0] | 43 [41 to 47, sd 3] | 56 [55 to 57, sd 1] |
| Rust store engine | 0 of 3 | blocked | blocked | blocked | blocked | blocked | blocked |

Cells are mean [min to max, sample sd] across the scored runs. Raw numbers: [summary.json](summary.json), [table.md](table.md).

**Cost per query.** The storage engines make no paid calls. All paid work is embedding, and it is the same for every engine: the warm-up run embedded the corpus chunks once (ingest, a one-time cost per corpus) and the 548 probe texts. Its query phase measured about $0.0000009 per query (text-embedding-3-large, uncached). The six scored runs read every vector, corpus and probe, from the shared cache and made zero paid requests.

## What we observed

- **Identical rankings.** For all 548 probes, the top 5 page ids were identical across all six scored runs (3 PGLite, 3 Postgres). Zero search failures, zero degraded searches (`vector_enabled` true on every call). The run-to-run spread of every quality metric is zero.
- **Latency.** Postgres p50 43 ms, PGLite p50 201 ms. The spread between runs is small (sd 1 to 3 ms). Wall time for a whole run: PGLite about 120 s, Postgres about 33 s.
- **Rust.** All three runs stopped at ingest with `OperationError: This brain's engine does not support upsertChunks (option embeddingColumn) yet (it needs the chunks capability), so nothing ran.` (exit 3). See [rust/](rust/).

## Why the Rust engine is blocked (observed)

gbrain's own import path (`src/core/import-file.ts`) passes an `embeddingColumn` option to `upsertChunks` on every import that embeds chunks. The Rust engine's `upsertChunks` member accepts only `sourceId`, `expectedRevision`, `sealChunkerVersion`, `pageId` and `deferSeal`, so it refuses the call, even when the column is the default `embedding`. A minimal repro ([harness/rust-embed-import.repro.ts](harness/rust-embed-import.repro.ts)) imports one page with stub vectors on each engine from the same build: PGLite and Postgres import and embed the page; Rust refuses with `engine_capability_missing`. The refusal comes from the product, not from this harness, so this bench cannot measure Rust until gbrain lets the Rust `upsertChunks` take that option.

A keyword-only run on Rust does work (import with `noEmbed`, then hybrid search with no vectors), but that is a different search path from the PGLite and Postgres arms. We did not run it as a substitute, because it would not be a fair comparison.

## Hypotheses (not tested here)

- The Rust member could accept `embeddingColumn` when the column is the default `embedding`. That would unblock this bench.
- The PGLite gap is likely the cost of single-threaded WASM Postgres against a native server on 8 vCPUs, not network or tuning. We did not profile it.
- Both engines run the same SQL and pgvector code paths. On a 240-page corpus the candidate sets are small, so approximate-index effects did not change any ranking. A larger corpus could separate them.

## What is comparable and what is not

Comparable: one gbrain build, one machine, one corpus, the same 548 probes and graded gold, byte-identical vectors from one cache, the same search pins (balanced mode, reranker off, autocut off, expansion off), serial runs with nothing else running, interleaved PGLite and Postgres order.

Not comparable or limited:

- **Environment.** Postgres runs natively in a Docker container and is reached over local TCP; PGLite runs inside the bench process as WASM. The latency gap measures this whole setup, not the storage engines alone.
- **Build.** The gbrain code under test is `rust-cli-members` at 6ad51d6b90dd, not master and not the `package.json` pin (6ce7195b44a0, which has no Rust engine). Receipts record both.
- **Small, synthetic corpus.** 240 pages of world-v1. Zero variance here comes from a deterministic pipeline and cached vectors, not from a large sample. It says nothing about engine behavior at 100k pages.
- **Latency resolution.** Per-query times use `Date.now()` (1 ms) and include the cached query-embedding lookup, which is the same for every engine.
- **Preregistration.** The prediction and stop rule ([PREREGISTRATION.md](PREREGISTRATION.md)) were written before any paid run, but kept locally, not committed to origin first, so this is not an attested preregistration under `eval/runner/prereg.ts` and is not listed in `preregistrations.json`. One prediction failed: we predicted Docker Postgres would be slower than PGLite; it was faster.
- **Verdict field.** Receipts say `verdict: partial` because only the gbrain arm ran (`--adapter gbrain`), not the full standard cat13 run.

## Reproduce

1. Check out this branch; link the gbrain build under test as `node_modules/gbrain` (`rust-cli-members` at 6ad51d6b90dd) and build its addon (`rust/target/addon/gbrain_engine.linux-x64-glibc.node`).
2. Start Postgres: `docker run -d --name bench-pg -p 127.0.0.1:55432:5432 -e POSTGRES_HOST_AUTH_METHOD=trust pgvector/pgvector@sha256:c29f30688a9ad961691bdf0ec1650717cc132a5814619d80f80463d6e4c42e47 -c max_connections=200 -c shared_buffers=512MB`.
3. Create a budget ledger: `bun eval/runner/budget-ledger.ts init --budget-ledger /var/tmp/bench-ledger.sqlite --program-cap-usd <your cap> --reason "engine baseline"`.
4. With `OPENAI_API_KEY` set, run one warm-up and then the scored runs, serially:

```bash
A="--reranker off --autocut off --embed-cache /var/tmp/bench-embed-cache.sqlite --budget-usd <per-run budget> --estimate-usd <estimate> --budget-ledger /var/tmp/bench-ledger.sqlite"
H=docs/benchmarks/2026-11-18-engine-baseline/harness
$H/run-one.sh pglite warmup-pglite out/runs $A
for i in 1 2 3; do $H/run-one.sh rust rust-r$i out/runs $A; done
for i in 1 2 3; do for e in pglite postgres; do $H/run-one.sh $e $e-r$i out/runs $A; done; done
python3 $H/summarize.py out/runs out/summary
```

`run-one.sh` finds the repo from its own location, sets `GBRAIN_EVAL_ENGINE`, an empty `GBRAIN_HOME` and the addon path (default: the addon inside the linked `node_modules/gbrain`; override with `GBRAIN_RUST_ENGINE_ADDON`), then copies the receipt out of the Git-ignored `eval/reports/`. Override the Postgres URL with `BENCH_PG_URL`. The runs above used the same script with sandbox paths as defaults. The warm-up takes about 7 minutes; each scored run takes 0.5 to 2 minutes.

## Metrics

- nDCG@5 and P@5 (graded) are the values cat13 stores per probe (graded gold: target concept 3, co-occurrence peer 1; P@5 counts grade 1 or more).
- R@5: share of the probe's grade-3 targets in the top 5. MRR@5: 1 / rank of the first grade-3 target in the top 5, else 0. Both are computed by [harness/summarize.py](harness/summarize.py) from the saved rows.
- p50 and p95: nearest-rank percentiles of the per-probe `latency_ms` (the adapter's `query()` call), per run.

## Files

- [summary.json](summary.json), [table.md](table.md): per-run and per-engine numbers.
- [per-query.jsonl.gz](per-query.jsonl.gz): one row per probe per scored run (top 5, graded gold, metrics, latency, search failures).
- [receipts/](receipts/): full cat13 receipts (gzip) and logs for the warm-up and the six scored runs, including every search observation.
- [rust/](rust/): logs and receipts of the three refused Rust runs.
- [environment.json](environment.json): commits, addon hash, Postgres image digest, machine, run order.
- [harness/](harness/): the run script, the summarizer and the Rust repro.
- Harness change in this branch: `eval/runner/adapters/gbrain-inline.ts`, `eval/runner/cat13-conceptual.ts`, `eval/runner/eval-engine.ts`.
