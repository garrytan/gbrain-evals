# Engine baseline on cat13: PGLite and Postgres match exactly; the Rust engine imports now but cannot run vector search yet

- **We learned that PGLite and Postgres return the same top 5 on every probe, on two gbrain builds.** You should treat a change between these two engines as quality-neutral on this bench and pick by latency and operations: Postgres in Docker answered about 4.5 times faster at p50 here (45 ms against 204 ms at gbrain dbc85b2d).
- **We learned that the Rust engine now imports and embeds the corpus, but serves no vector search.** You should not compare it with the other engines until its `searchVector` member exists. Without it, hybrid search runs keyword-only and cat13 marks every Rust run invalid (548 of 548 probes lose the vector arm).

**On the cat13 conceptual-recall bench (548 probes, world-v1), gbrain returns the same top 5 on PGLite and on Postgres for every probe in every run: nDCG@5 55.7%, P@5 27.4%, R@5 79.5%, MRR@5 67.5%. Postgres in Docker answers about 4.7 times faster at p50 (43 ms against 201 ms). On the first build (gbrain 6ad51d6b) the Rust store engine refused the first embedded import; on the second (dbc85b2d) it imports but has no vector search, so it still has no valid quality or latency number.**

This is the first baseline that runs one gbrain build on three storage engines with the same corpus, probes, gold, vectors and machine. It is a descriptive baseline, not a claim that one engine is better.

## Second build: gbrain dbc85b2d (Rust import fix)

gbrain `rust-engine/lane6-import-embedding-column` at dbc85b2d19111666a4f26b8f1052d86741a622e4 (0.60.737.0) lets the Rust engine's `upsertChunks` accept the `embeddingColumn` option. We rebuilt the addon at that commit and ran, serially and interleaved: rust r1, PGLite control, rust r2, Postgres control, rust r3. Every run used the same corpus, probes, gold, cache, search pins and machine as the first build, plus `--warm-passes 1` (after the scored pass, the same 548 probes run again on the same brain, timed but not scored). All 1576 embedding lookups per run hit the shared cache (1028 as before, plus 548 for the repeat pass), with zero misses and zero paid requests, so every run searched byte-identical vectors.

**The one-page repro now imports on all three engines.** PGLite, Postgres and Rust each report `imported`, 1 chunk, 1 embedded ([head-dbc85b2d/repro-output.log](head-dbc85b2d/repro-output.log)).

| Engine at dbc85b2d | Runs | nDCG@5 | P@5 (graded) | R@5 | MRR@5 | cold p50 / p95 ms | warm p50 / p95 ms |
|---|---|---|---|---|---|---|---|
| PGLite (control) | 1 | 55.7% | 27.4% | 79.5% | 67.5% | 204 / 224 | 203 / 221 |
| Postgres (control) | 1 | 55.7% | 27.4% | 79.5% | 67.5% | 45 / 53 | 44 / 54 |
| Rust store engine | 0 of 3 valid | invalid | invalid | invalid | invalid | invalid | invalid |

Cold is the scored first pass on a freshly imported brain; warm is the repeat pass on the same brain. One control run per engine has no spread to report.

**Observed.**

- **The controls did not move.** At dbc85b2d, PGLite and Postgres each returned the same ordered top 5 as the first build's PGLite run on all 548 probes ([head-dbc85b2d/top5-controls.json](head-dbc85b2d/top5-controls.json)), so the quality rows of both builds agree. Latency is within a few ms of the first build's band (PGLite p50 204 against 200 to 202; Postgres 45 against 41 to 47). We still keep the rows per build and do not pool runs across builds.
- **Rust stops at vector search.** In every Rust run each query logged `This brain's engine does not support searchVector yet (it needs the vector_search capability)`. Hybrid search salvaged the keyword arm, and cat13 recorded `SEARCH INCOMPLETE: 548 query execution/observation failures` and exited 3 (`run_status: error`). In gbrain at dbc85b2d, `src/core/rust-engine/store-members/vectors.ts` exports no members, so `searchVector` refuses with `engine_capability_missing`.
- **Rust is deterministic on its keyword-only path.** The three Rust runs returned identical top 5 lists on all 548 probes.
- **Diagnostic only, not comparable.** The keyword-only Rust rankings differ from the PGLite control's ordered top 5 on 548 of 548 probes (the top-5 set differs on 546). The scores are lower on 300 probes, higher on 82 and the same on 166. Diagnostic means over the three runs: nDCG@5 41.7%, R@5 65.3%, MRR@5 52.1%, cold p50 22 to 23 ms and p95 28 to 30 ms, warm p50 22 to 23 ms and p95 28 to 29 ms. Examples (target concept, then the top 3 of each):
  - `c13-00105` (synonym-fuzzy), target `concepts/developer-relations`: PGLite ranks it first; Rust returns a person page, a company page and an unrelated concept.
  - `c13-00108` (synonym), the same target: PGLite first; Rust misses it in the top 3.
  - `c13-00400` (body-fuzzy), target `concepts/revenue-durability`: PGLite misses it; Rust ranks it first.
  These numbers measure a keyword-only search against hybrid search. They are not a Rust engine result and not a quality or speed claim. Every probe row is in [head-dbc85b2d/per-query-invalid-runs.jsonl.gz](head-dbc85b2d/per-query-invalid-runs.jsonl.gz) and [head-dbc85b2d/top5-rust-diagnostic.json.gz](head-dbc85b2d/top5-rust-diagnostic.json.gz).

**Hypotheses (not tested).**

- Once `searchVector` serves the default `embedding` column, Rust would run the same hybrid path as the other engines and this bench could score it.
- Most of the keyword-only gap comes from the missing vector arm, since the losses cluster in the synonym templates, where the probe shares few words with the target. We did not run a keyword-only PGLite control, so this bench cannot yet say whether Rust's keyword arm itself matches PGLite's.

## Results (first build, gbrain 6ad51d6b)

| Engine | Scored runs | nDCG@5 | P@5 (graded) | R@5 | MRR@5 | p50 query ms | p95 query ms |
|---|---|---|---|---|---|---|---|
| PGLite (in-process, in memory) | 3 | 55.7% [55.7 to 55.7, sd 0.0] | 27.4% [27.4 to 27.4, sd 0.0] | 79.5% [79.5 to 79.5, sd 0.0] | 67.5% [67.5 to 67.5, sd 0.0] | 201 [200 to 202, sd 1] | 220 [219 to 220, sd 1] |
| Postgres 18.6 + pgvector 0.8.7 (Docker, same VM) | 3 | 55.7% [55.7 to 55.7, sd 0.0] | 27.4% [27.4 to 27.4, sd 0.0] | 79.5% [79.5 to 79.5, sd 0.0] | 67.5% [67.5 to 67.5, sd 0.0] | 43 [41 to 47, sd 3] | 56 [55 to 57, sd 1] |
| Rust store engine | 0 of 3 | blocked | blocked | blocked | blocked | blocked | blocked |

Cells are mean [min to max, sample sd] across the scored runs. Raw numbers: [summary.json](summary.json), [table.md](table.md).

**Query size.** The storage engines make no paid calls. All paid work is embedding, and it is the same for every engine: the warm-up run embedded the corpus chunks once (ingest, a one-time step per corpus) and the 548 probe texts. We size a query in tokens counted with tiktoken's `cl100k_base` encoding, the tokenizer of text-embedding-3-large, not by characters divided by 4. The 548 probes average 6.72 tokens each. The six scored runs read every vector, corpus and probe, from the shared cache and made zero paid requests.

## What we observed

- **Identical rankings.** For all 548 probes, the top 5 page ids were identical across all six scored runs (3 PGLite, 3 Postgres). Zero search failures, zero degraded searches (`vector_enabled` true on every call). The run-to-run spread of every quality metric is zero.
- **Latency.** Postgres p50 43 ms, PGLite p50 201 ms. The spread between runs is small (sd 1 to 3 ms). Wall time for a whole run: PGLite about 120 s, Postgres about 33 s.
- **Rust.** All three runs stopped at ingest with `OperationError: This brain's engine does not support upsertChunks (option embeddingColumn) yet (it needs the chunks capability), so nothing ran.` (exit 3). See [rust/](rust/).

## Why the Rust engine was blocked on the first build (observed)

gbrain's own import path (`src/core/import-file.ts`) passes an `embeddingColumn` option to `upsertChunks` on every import that embeds chunks. The Rust engine's `upsertChunks` member accepts only `sourceId`, `expectedRevision`, `sealChunkerVersion`, `pageId` and `deferSeal`, so it refuses the call, even when the column is the default `embedding`. A minimal repro ([harness/rust-embed-import.repro.ts](harness/rust-embed-import.repro.ts)) imports one page with stub vectors on each engine from the same build: PGLite and Postgres import and embed the page; Rust refuses with `engine_capability_missing`. The refusal comes from the product, not from this harness, so this bench cannot measure Rust until gbrain lets the Rust `upsertChunks` take that option.

A keyword-only run on Rust does work (import with `noEmbed`, then hybrid search with no vectors), but that is a different search path from the PGLite and Postgres arms. We did not run it as a substitute, because it would not be a fair comparison.

## Hypotheses (not tested here)

- The Rust member could accept `embeddingColumn` when the column is the default `embedding`. That would unblock this bench. (The second build did this: the import now works, and the next block is vector search.)
- The PGLite gap is likely the cost of single-threaded WASM Postgres against a native server on 8 vCPUs, not network or tuning. We did not profile it.
- Both engines run the same SQL and pgvector code paths. On a 240-page corpus the candidate sets are small, so approximate-index effects did not change any ranking. A larger corpus could separate them.

## Method

These rules apply to every run in this folder and to later runs of this baseline.

- **Cold and warm passes.** `--warm-passes 1` gives two passes over the same 548 probes on the same brain, in the same process. The cold pass is the first query pass after import, and it is the only scored pass. The warm pass repeats every probe, is timed and is not scored. We report cold p50/p95 and warm p50/p95 separately and never pool them. The OS page cache is not dropped between passes, so "cold" means the first pass after import, not a cold disk.
- **Postgres locale.** Text ordering in Postgres depends on the database's collation, so a locale change can move ties in a ranked list. We record the locale from the `pg_database` catalog, because PostgreSQL 16 and later removed `SHOW lc_collate`:

  ```sql
  SELECT datname, datcollate, datctype, datlocprovider, pg_encoding_to_char(encoding) FROM pg_database;
  ```

  Runs from 2026-11-20 record `en_US.UTF-8` for both `datcollate` and `datctype`, the libc provider (`datlocprovider = c`) and `UTF8` encoding. The two builds reported above (6ad51d6b and dbc85b2d) did not record the locale, so a Postgres difference between those runs and later ones may come partly from the locale.
- **Query size.** Token counts use tiktoken `cl100k_base` (mean 6.72 tokens per probe), as above.
- **Degraded warm searches.** A warm repeat can come back degraded (for example, with its vector arm off), and its latency then measures a different search path. [PR 547](https://github.com/garrytan/gbrain-evals/pull/547) adds a per-search degraded flag and reason to the warm pass and a `warm_excluded_degraded` count, so those repeats can be left out of warm latency. At our last read (2026-11-20), PR 547 was not merged into main, so receipts from main do not carry these fields yet.
- **Excluded repeats are shown (GBEV-3).** Any published warm p95 shows, beside it, how many degraded repeats were excluded and their reasons, including when the count is 0.
- **Rust engine results.** Rust numbers stay out of the results tables on main until a named gbrain release can select the Rust engine. That is expected through `engine: "rust"` in the config and `gbrain init`, from 2026-11-21. Until then, a Rust run from a branch build is a diagnostic: it can show whether the engine works, not a result to compare.

## What is comparable and what is not

Comparable: one gbrain build, one machine, one corpus, the same 548 probes and graded gold, byte-identical vectors from one cache, the same search pins (balanced mode, reranker off, autocut off, expansion off), serial runs with nothing else running, interleaved PGLite and Postgres order.

Not comparable or limited:

- **Environment.** Postgres runs natively in a Docker container and is reached over local TCP; PGLite runs inside the bench process as WASM. The latency gap measures this whole setup, not the storage engines alone.
- **Build.** The gbrain code under test is `rust-cli-members` at 6ad51d6b90dd for the first build and `rust-engine/lane6-import-embedding-column` at dbc85b2d1911 for the second, neither on master and neither the `package.json` pin (6ce7195b44a0, which has no Rust engine). Receipts record each. Rows are reported per build, never pooled.
- **Warm pass.** `--warm-passes` repeats the probes on the same brain in the same process. "Cold" means the first query pass after import, not a cold OS page cache; the store was never evicted from memory. See [Method](#method).
- **Small, synthetic corpus.** 240 pages of world-v1. Zero variance here comes from a deterministic pipeline and cached vectors, not from a large sample. It says nothing about engine behavior at 100k pages.
- **Latency resolution.** Per-query times use `Date.now()` (1 ms) and include the cached query-embedding lookup, which is the same for every engine.
- **Preregistration.** The prediction and stop rule ([PREREGISTRATION.md](PREREGISTRATION.md)) were written before any paid run, but kept locally, not committed to origin first, so this is not an attested preregistration under `eval/runner/prereg.ts` and is not listed in `preregistrations.json`. One prediction failed: we predicted Docker Postgres would be slower than PGLite; it was faster.
- **Verdict field.** Receipts say `verdict: partial` because only the gbrain arm ran (`--adapter gbrain`), not the full standard cat13 run.

## Reproduce

1. Check out this branch; link the gbrain build under test as `node_modules/gbrain` (`rust-cli-members` at 6ad51d6b90dd) and build its addon (`rust/target/addon/gbrain_engine.linux-x64-glibc.node`).
2. Start Postgres, with its port published on the loopback interface only and the locale pinned: `docker run -d --name bench-pg -p <loopback>:55432:5432 -e POSTGRES_HOST_AUTH_METHOD=trust -e LANG=en_US.utf8 -e POSTGRES_INITDB_ARGS="--locale=en_US.UTF-8 --encoding=UTF8" pgvector/pgvector@sha256:c29f30688a9ad961691bdf0ec1650717cc132a5814619d80f80463d6e4c42e47 -c max_connections=200 -c shared_buffers=512MB`. Record the locale with the `pg_database` query in [Method](#method). The two builds above started the container without the locale flags and did not record the locale.
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

For the second build, link gbrain dbc85b2d, rebuild the addon (`bun run rust:build` in the gbrain checkout), and add `--warm-passes 1` to `A`:

```bash
for s in rust:rust-r1 pglite:pglite-ctl rust:rust-r2 postgres:postgres-ctl rust:rust-r3; do $H/run-one.sh ${s%%:*} ${s#*:} out/dbc $A; done
python3 $H/summarize.py out/dbc out/dbc-summary
python3 $H/compare-top5.py out/dbc-summary/top5-rust-diagnostic.json pglite-ctl=out/dbc-summary/per-query.jsonl:pglite-0 \
  rust-r1=out/dbc-summary/per-query-invalid-runs.jsonl:rust-1
```

The five runs took about 7 minutes in all (PGLite about 4 minutes with the repeat pass, Postgres 1, each Rust run under 1).

`run-one.sh` finds the repo from its own location, sets `GBRAIN_EVAL_ENGINE`, an empty `GBRAIN_HOME` and the addon path (default: the addon inside the linked `node_modules/gbrain`; override with `GBRAIN_RUST_ENGINE_ADDON`), then copies the receipt out of the Git-ignored `eval/reports/`. Override the Postgres URL with `BENCH_PG_URL`. The runs above used the same script with sandbox paths as defaults. The warm-up takes about 7 minutes; each scored run takes 0.5 to 2 minutes.

## Metrics

- nDCG@5 and P@5 (graded) are the values cat13 stores per probe (graded gold: target concept 3, co-occurrence peer 1; P@5 counts grade 1 or more).
- R@5: share of the probe's grade-3 targets in the top 5. MRR@5: 1 / rank of the first grade-3 target in the top 5, else 0. Both are computed by [harness/summarize.py](harness/summarize.py) from the saved rows.
- p50 and p95: nearest-rank percentiles of the per-probe `latency_ms` (the adapter's `query()` call), per run. Cold and warm passes are reported apart; a warm p95 carries its count of excluded degraded repeats (see [Method](#method)).
- Query tokens: tiktoken `cl100k_base` count of each probe text.

## Files

- [summary.json](summary.json), [table.md](table.md): per-run and per-engine numbers.
- [per-query.jsonl.gz](per-query.jsonl.gz): one row per probe per scored run (top 5, graded gold, metrics, latency, search failures).
- [receipts/](receipts/): full cat13 receipts (gzip) and logs for the warm-up and the six scored runs, including every search observation.
- [rust/](rust/): logs and receipts of the three refused Rust runs.
- [environment.json](environment.json): commits, addon hashes, Postgres image digest, machine, run order for both builds.
- [head-dbc85b2d/](head-dbc85b2d/): the second build: repro output, receipts and logs of the five runs, [summary.json](head-dbc85b2d/summary.json), [table.md](head-dbc85b2d/table.md), the control rows (`per-query.jsonl.gz`), the invalid Rust rows and the top-5 comparisons.
- [harness/](harness/): the run script, the summarizer, [compare-top5.py](harness/compare-top5.py) and the Rust repro.
- Harness: the engine arm (`eval/runner/adapters/gbrain-inline.ts`, `eval/runner/cat13-conceptual.ts`, `eval/runner/eval-engine.ts`) is on main through [PR 523](https://github.com/garrytan/gbrain-evals/pull/523).
