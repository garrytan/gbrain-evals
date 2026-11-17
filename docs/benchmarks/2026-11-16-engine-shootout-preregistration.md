# Preregistration: PGLite or Postgres for a gbrain of a given size (engine shootout)

Frozen 2026-11-16, before the first counted run. Do not edit below this line except by appending a dated amendment under "Amendments".

## Question

gbrain can store a brain in PGLite (Postgres compiled to WebAssembly, running inside the gbrain process, one file tree on disk) or in a Postgres server with pgvector. A user choosing between them has no measured numbers. The decision this result changes: which engine a user should pick for a brain of a given size (1,000 pages and 10,000 pages here), and, later, whether PGLite can be deprecated in favor of the Rust engine.

This experiment answers the first part only. It publishes the PGLite versus Postgres baseline that a later Rust experiment will be compared against. It cannot say whether PGLite can be deprecated, because the Rust engine is not in it and concurrent access is not measured. The Rust arm stays a documented hook (the `ENGINES` table in `eval/runner/engine-shootout.ts`, where `--engines rust` is refused). It becomes its own preregistered experiment after the Rust engine passes search parity, and it reuses this corpus, these queries and this analysis.

## Public lesson

If PGLite stays within the margin: We learned that PGLite answers searches within about the same time as a Postgres server at this brain size, with paired intervals to show it. You should start on PGLite, since it needs no server, and move to Postgres when the numbers or your concurrency needs say so.

If it does not: We learned that PGLite falls outside the margin at this brain size, and by how much. You should run Postgres with pgvector for brains this size, and keep PGLite for small ones.

If the interval straddles the margin: no clear call at this sample size, and the report says so.

## Evidence class

Development evidence. The author ran a 300-page smoke run of this same runner (not counted, not published as a result) while building it, and saw, for example, PGLite roughly 1.3x to 1.8x the Postgres time on search operations and faster on point reads such as backlinks and timeline. The hypotheses and margins below were written with that in mind. Nothing at 1,000 or 10,000 pages has been run. Hash embeddings are a control, so the quality numbers here compare engines to each other and say nothing about how well real embeddings retrieve.

## Build and data

- gbrain: v0.60.734.0, commit `a278ddf45887e10f70e91e6c78e63d6822d4e492`, pinned in `package.json` and `bun.lock` through `bun eval/runner/gbrain-pin.ts bump`, and listed in `docs/gbrain-under-test.md`. This is gbrain's newest release at launch (checked with `git ls-remote --tags` on 2026-11-16). If a newer release lands before the first counted run, the pin is moved with a dated amendment committed before that run. The build freezes once the first counted run starts.
- gbrain-evals: the commit that contains this file. The receipt records `evals_commit`.
- Postgres: Docker image `pgvector/pgvector:pg16` (PostgreSQL 16.16), started with stock settings, no resource limits, bound to 127.0.0.1. The receipt records the image digest.
- Corpus: the committed `world-v1` pages (240), then seeded filler pages built from `synthetic-v1` and `source-swamp-v1` paragraphs, up to the scale. Filler never reuses `world-v1` text, so it cannot compete with the relevant pages of the queries. Seed 1337. Dataset SHA-256 fingerprints (the runner computes them over every page's text, every chunk's text and vector, the quality queries and the probe texts; links and timeline entries are derived from the pages):
  - 1,000 pages: `eea26c20c60d07528f7c212708e838c7e8d566b04a4d4b8232ef918fb30cf786` (2,454 chunks, 2,017 links, 4,474 timeline entries)
  - 10,000 pages: `3057ebc2ba2a2dad0bd1daae3651531844f284b8da92fd832230f2d0a359f8d0` (21,389 chunks, 20,015 links, 31,573 timeline entries)
  - A run whose receipt shows a different fingerprint is invalid.
- Quality queries: the 71 Tier 5 and Tier 5.5 queries that carry gold pages (`getAllTierQueries()` in `eval/runner/queries/`, files `tier5-fuzzy.ts` sha256 `156993c0ed543cec74e8af8245bba1fb86b8a8d96df550bcf683cf8727f10798` and `tier5_5-synthetic.ts` sha256 `29d0be0f152c5107ee4b712008d49c31b8ba18fa13db027bbee1bdf84a5eeb42`). Relevance is binary, by page slug.
- Latency probes: 400 seeded probe texts and vectors. Each timed operation uses probe `i mod 400` for the i-th query, so both engines see the same input in the same position.
- Embeddings: `hash-embed-v1`, a seeded feature-hashing embedder defined in the runner, 1024 dimensions to match the `vector(1024)` column gbrain creates by default at this pin (a test checks the width against the installed gbrain). No provider is called.
- Machine: one Linux machine, 8 logical CPUs, 30 GB memory, Docker, the benchmark run alone on it. The receipt records the machine, the CPU model, and the Bun and Docker versions.

## Arms

- Reference (comparator): Postgres with pgvector, in a local container.
- Other: PGLite, in process, on-disk data directory.
- Both are opened through gbrain's own `BrainEngine` at the pinned commit, with gbrain's own schema (`initSchema`) and gbrain's own search methods.
- Not in this experiment: the Rust engine (hook only), a hosted Postgres service, concurrent clients, real embedding models. The report lists each as not measured.

Operations timed, each with the same input on both engines:

| Group | Operations (paired, 300 queries each by default) |
|---|---|
| Point reads | `get_page`, `get_backlinks`, `get_timeline` |
| Search | `search_keyword`, `search_vector`, `search_hybrid_rrf` (engine-level reciprocal rank fusion of the two lists, k = 60), and `search_keyword_filtered` and `search_vector_filtered` (by page type) |
| Listing | `list_pages` |

The one-engine run also records the other operations (`put_page`, `upsert_chunks`, the text-projection seal, `put_page_update`, a hub page's backlinks), as descriptive rows.

## Metric and denominator

Primary: on `search_hybrid_rrf`, the geometric-mean ratio of PGLite time to Postgres time over the queries, which is `exp(mean(ln(pglite_ms / postgres_ms)))`. A ratio of 2 means PGLite takes twice as long. The analysis unit is the query. The denominator is every timed query after the warm-up (default 300 per operation). Each query is its own cluster for the bootstrap. Nothing is dropped: a failed call fails the run (see "Stop rules").

Secondary, each reported with a paired 95% interval:

- The same ratio and the mean millisecond difference for the other eight paired operations, with sign-flip p-values Holm-adjusted across the nine latency operations.
- p50, p95 and p99 per engine per operation (descriptive).
- Quality on the 71 queries, paired per query: Recall@5 and nDCG@10 for keyword, vector and hybrid, PGLite minus Postgres. The denominator is the 71 queries. A query with no result scores 0 and counts. The empty-result rate is reported.
- Cost per operation, for `get_page`, `search_keyword`, `search_vector` and `search_hybrid_rrf`: 20 blocks of 50 identical operations, run on both engines in a random order per block, so a block is the pairing unit. Each side records wall seconds, client CPU seconds (`process.cpuUsage`) and server CPU seconds (the container's cgroup `usage_usec`; PGLite has none, its work is in the client). Dollars per 1,000 operations are CPU seconds and memory held, priced with the model below. The difference is PGLite minus Postgres with a paired interval over the 20 blocks.

Descriptive only, one run per engine, no interval and no decision rides on them: bulk import throughput (pages per second, including the seal step), cold start (median of 5 repetitions, warm OS file cache), peak memory, on-disk size.

Price model, list prices as assumptions and not quotes, retrieved 2026-11-16 by web search (not the AWS price API): AWS Fargate Linux/x86 in us-east-1 at $0.04048 per vCPU-hour and $0.004445 per GB-hour (https://aws.amazon.com/fargate/pricing/), and, as a separate monthly line for comparison, Amazon RDS for PostgreSQL db.t4g.medium (2 vCPU, 4 GB, Single-AZ, us-east-1) at $0.065 per hour (https://aws.amazon.com/rds/postgresql/pricing/). Memory is each engine's measured memory held: for PGLite the engine's resident memory in the benchmark process (peak minus the harness's own baseline), for Postgres the container's working set (the `docker stats` definition) plus the client's. The price model is in the runner and in every receipt, so a reader can apply their own prices to the measured inputs.

## Decision rule

For each scale, applied mechanically by `applyDecisionRule` in the runner and written to the receipt as `paired.<comparison>.decision`:

1. Quality gate. If the paired interval for hybrid Recall@5 or hybrid nDCG@10 excludes 0, the outcome is `withheld_quality_differs`. The engines are meant to return the same pages from the same data, so a difference is a finding about correctness, and latency does not decide anything until it is understood.
2. `pglite_adequate`: the upper bound of the 95% interval of the hybrid ratio is at most 2.0 and PGLite's hybrid p95 is at most 100 ms.
3. `postgres_recommended`: the lower bound of that interval is above 2.0, or PGLite's hybrid p95 is above 100 ms.
4. Otherwise `no_clear_call`.

The 2.0 ratio margin and the 100 ms p95 limit are product assumptions chosen before any counted run. They are not findings, and the report says so. The 100 ms figure is a common limit for an interaction to feel immediate. A reader with a different limit can apply it to the p95 values in the receipt. The decision is per scale. Nothing is pooled across scales and no trend is tested. The report shows both scales side by side.

Intervals: clustered paired bootstrap (`eval/runner/stats/paired.ts`, `clusteredPairedDelta`), 95% percentile interval, 10,000 draws, seed 1337. Each query (or block) is its own cluster, and a result is exact when there are 20 clusters or fewer. The test statistic's two-sided p-values come from the same helper, Holm-adjusted across the nine latency operations. Latency ratios are bootstrapped on the log scale and exponentiated.

Order effects: the order in which the two engines run each query is random from a seeded generator. The receipt records who ran first, and the report shows the mean difference by order as a check. A large order effect is reported next to the result it affects, not corrected away.

Sample size: 300 queries per operation, chosen so intervals on the ratio are narrow next to the 2.0 margin (in the 300-page smoke run, 40 queries gave interval widths of roughly 0.15 on a ratio near 1.5). No formal minimum detectable effect is claimed. A result whose interval includes the margin is `no_clear_call`, said as "no measurable difference at that sample size", never as equal. Cost is paired over only 20 blocks, so those intervals are wide and the report says so. They are secondary.

## What each outcome changes

| If it wins (`pglite_adequate` at a scale) | If it loses (`postgres_recommended` at a scale) | If inconclusive (`no_clear_call`, or `withheld_quality_differs`) |
|---|---|---|
| The docs can tell users of brains this size to start on PGLite. That does not argue for removing PGLite. The Rust experiment starts from this number as the one to beat. | The docs name the size from which a Postgres server is advised, and the Rust experiment is told which PGLite weakness to look at. If it holds at 1,000 pages the advice becomes "Postgres for any brain you search often". | No advice changes. The report states what the interval allows and what a larger or longer run would need. A quality difference is filed as an engine bug before any latency claim is published. |

The deprecation question is not decided by any outcome here.

## Budget

Keyless. The run makes no provider requests, needs no API key, and gives the children a minimal environment with no keys. The only cost is machine time and a local Docker container, which the runner starts, labels `gbrain-evals.engine-shootout` and removes in a `finally` block. There is no ledger.

## Stop rules

- One counted run per scale (1,000 and 10,000 pages), with `bun eval/runner/engine-shootout.ts --scale <n> --cold-reps 5 --out docs/benchmarks/2026-11-16-engine-shootout/results`. The run order is 1,000 first.
- A run is invalid, and may be repeated, only if: the dataset fingerprint differs from the one above, a call fails or times out, the Postgres container exits, the receipt lacks `preregistration_attestation`, or another heavy process shared the machine (load average above 2 at launch). An invalid run's receipt is kept and named in the report with the reason. Every valid run is published. At most two repeats per scale. If a repeat is valid it replaces the invalid run, and no other run is chosen over another by its result.
- No run is repeated because of how its result looks. There is no peeking: the analysis is the code at the preregistration commit, and the report states anything the receipts show beyond it as exploratory.
- If the 10,000-page run cannot finish for an infrastructure reason (memory, disk or time), the report says "not run" with the reason, and the decision for that scale stays open.
- A changed gbrain pin, a changed margin or a changed analysis is a dated amendment committed before the run it affects.

## Amendments

None yet.
