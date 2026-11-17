# PGLite and Postgres in gbrain: the engine-bench baseline (development runs)

- **We learned that gbrain gives the same answers on PGLite and on Postgres.** At gbrain v0.60.734.0 and v0.60.735.0, both engines passed six keyless correctness checks with identical counts (zero stale values, leaks, lost writes or bytes lost), 301 of 302 CLI, MCP and markdown outputs were byte-identical, and LongMemEval-S retrieval returned the same top 5 on 102 of 102 questions. You can move a brain between the two engines without changing what it returns, except for the `stale` flag in `gbrain search --json`, which only PGLite computes.
- **We learned that Postgres is the engine for concurrent clients and large brains.** With 16 concurrent clients PGLite served 0.05x Postgres's read rate (17.6 against 347.9 reads per second), and PGLite's import slows as the brain grows: 27.7 pages per second for the first 5,000 pages, 1.5 by 45,000. Postgres held 23 to 24 pages per second all the way to 100,000 pages. You should use Postgres for a brain that several agents read at once or that will grow past roughly 10,000 pages; for one client, PGLite matched Postgres on single reads and wrote faster.
- These are development runs made before the [preregistration](2026-11-17-engine-bench-preregistration.md) froze. They describe the two TypeScript engines and decide nothing. The Rust engine is not measured here: no gbrain release carries it yet, and the counted wave runs when gbrain's maintainers name a build.

## What engine-bench is

[gbrain](https://github.com/garrytan/gbrain) stores a personal knowledge brain in one of two engines today: PGLite (Postgres compiled to WebAssembly, running inside the gbrain process, no server) or a Postgres server with pgvector. gbrain is adding a third engine written in Rust. engine-bench is gbrain-evals' independent check of whether that engine works like the two it would replace. Its [phase 1 preregistration](2026-11-17-engine-bench-preregistration.md) asks three things of every engine: the same correctness counts, the same output bytes on every surface a user or agent reads, and the same retrieval answers. Speed is phase 2, for a later default-on decision.

The preregistration publishes this PGLite and Postgres baseline on its own, so the comparison Rust will face is public before any Rust number exists.

## Results

### Correctness: six keyless checks (gbrain v0.60.735.0)

Each check runs as its own process per engine with `GBRAIN_EVAL_ENGINE` set, keyless, on one shared pgvector container. Every contract is a count whose bar is zero.

| Check | What it guards | PGLite | Postgres | Wall time PGLite / Postgres |
|---|---|---|---|---|
| N1 knowledge update | stale values served, private value leaks, acknowledged writes lost | pass, all 0 | pass, all 0 | 366 s / 248 s |
| N5 forget | prohibited outputs, reactivations, collateral expirations, unauthorized forgets, private canary leaks | pass, all 0 | pass, all 0 | 559 s / 353 s |
| N6 privacy, in process | content, existence and oracle leaks, gate bypasses, sealed-chunk violations | pass, all 0 | pass, all 0 | 139 s / 281 s |
| N6 privacy over HTTP | leaks, oracles, accepted invalid principals | refused (runs on Postgres only) | pass, all 0 | 1 s / 149 s |
| N12 chat formats | fabricated turns, noise leaks, invented timestamps, false attendance | pass, all 0 | pass, all 0 | 11 s / 10 s |
| N14 large pages (2 MB tier) | crashes, responses over cap, round-trip byte loss, presence failures | pass, all 0 | pass, all 0 | 94 s / 73 s |

No gbrain finding: the two engines never disagreed on a count. N6 over HTTP seeds the brain in process while `gbrain serve --http` holds it, which a one-process engine like PGLite does not allow, so the runner refuses PGLite by design.

### Output bytes: CLI JSON, MCP and markdown (gbrain v0.60.734.0)

A fixed 65-page corpus and a 54-step script run through `gbrain --json` and `gbrain call`, through stdio MCP, and through gbrain's markdown export. Outputs are compared byte for byte after seven listed masks for values that change on every run (database location, engine directory, work directory, timestamps, UUIDs, durations, search stage timings).

| Surface | Identical | Differs | Not applicable |
|---|---|---|---|
| CLI | 55 | 1 | 0 |
| MCP | 47 | 0 | 7 (CLI-only commands with no MCP tool) |
| Markdown | 199 | 0 | 0 |
| **Total** | **301** | **1** | 7 |

The one difference is the `stale` field of `gbrain search --json`: PGLite marks a hit stale when its page has a timeline entry newer than the page, and Postgres always returns `false`. It was reported to gbrain's maintainers. Between v0.60.734.0 and v0.60.735.0 only the version line of gbrain's `package.json` changed.

### Same answers: LongMemEval-S retrieval (gbrain v0.60.735.0)

[LongMemEval-S](https://huggingface.co/datasets/xiaowu0162/longmemeval) asks questions about long chat histories; each question has a haystack of sessions and one or more answer sessions. Per question, each engine gets a fresh store, the haystack is imported through gbrain's import path, and gbrain's search returns the top 5 with the reranker, query expansion and autocut off. Vectors come only from an embedding cache for `voyage-4` at 1,024 dimensions, filled once beforehand; no provider was called during the run.

This dry run used 102 questions, 17 per question type, stratified. 6 are abstention questions and are left out of recall, so 96 are scored. The metric is recall_all@5: the share of questions with every answer session in the top 5.

| Arm | PGLite | Postgres | Postgres minus PGLite, 95% interval | Identical top 5 |
|---|---|---|---|---|
| keyword | 10.4% | 10.4% | 0 [0, 0] | 102 / 102 |
| vector | 99.0% | 99.0% | 0 [0, 0] | 102 / 102 |
| hybrid | 97.9% | 97.9% | 0 [0, 0] | 102 / 102 |

recall_any@5 was 18.8% (keyword), 99.0% (vector) and 99.0% (hybrid) on both engines. Time per question averaged 3.17 s on PGLite (2.28 s import, 0.67 s open) and 2.11 s on Postgres (1.51 s import, 0.44 s open). This is a 102-question sample; the counted run uses all 500.

### Speed at 10,000 pages (gbrain v0.60.734.0)

A seeded synthetic corpus (the 240 `world-v1` pages plus seeded filler pages, each with links and dated timeline lines) is written through gbrain's own import path with a seeded local embedder, so both engines store the same vectors and no provider is called. Each query runs on both engines back to back in a seeded order; 2,000 timed queries per operation after warm-up. Ratios are PGLite over Postgres with 95% paired bootstrap intervals; below 1 means PGLite is faster.

| Operation | Postgres p50 | PGLite p50 | p50 ratio | p99 ratio |
|---|---|---|---|---|
| get_page | 2.1 ms | 2.2 ms | 1.03 [1.02, 1.03] | 1.04 [0.80, 1.23] |
| put_page | 32.5 ms | 34.0 ms | 1.05 [1.03, 1.07] | 1.56 [1.51, 1.61] |
| keyword search | 12.0 ms | 12.5 ms | 1.04 [1.00, 1.08] | 1.80 [1.70, 1.95] |
| vector search | 21.7 ms | 24.6 ms | 1.13 [1.12, 1.15] | 1.29 [1.22, 1.33] |
| hybrid search | 84.5 ms | 109.5 ms | 1.30 [1.28, 1.31] | 2.26 [2.12, 2.32] |
| keyword search, filtered by type | 9.2 ms | 9.4 ms | 1.02 [0.99, 1.04] | 1.58 [1.41, 1.95] |
| vector search, filtered by type | 83.9 ms | 45.3 ms | 0.54 [0.53, 0.55] | 0.67 [0.65, 0.68] |
| graph walk, depth 1 / 2 / 3 | 2.2 / 2.4 / 2.7 ms | 2.4 / 2.6 / 3.0 ms | 1.08 / 1.10 / 1.11 | 0.96 / 0.98 / 1.12 |
| backlinks | 1.9 ms | 2.0 ms | 1.07 [1.06, 1.07] | 0.94 [0.76, 1.17] |
| timeline | 0.6 ms | 0.4 ms | 0.57 [0.57, 0.58] | 0.44 [0.39, 0.50] |
| list_pages | 1.9 ms | 1.9 ms | 0.97 [0.96, 0.97] | 0.46 [0.27, 0.72] |

Throughput alternates 5-second windows between the engines, 10 repetitions per setting (median operations per second; ratio is PGLite over Postgres, above 1 means PGLite is faster):

| Clients | Kind | Postgres | PGLite | Ratio |
|---|---|---|---|---|
| 1 | read | 35.3 | 33.2 | 0.94 [0.91, 0.97] |
| 1 | write | 28.6 | 58.7 | 1.95 [1.84, 2.05] |
| 4 | read | 149.0 | 23.1 | 0.15 [0.14, 0.17] |
| 4 | write | 133.8 | 63.3 | 0.44 [0.39, 0.49] |
| 16 | read | 347.9 | 17.6 | 0.05 [0.05, 0.05] |
| 16 | write | 303.1 | 63.4 | 0.19 [0.17, 0.21] |

Single values: import 19.7 pages per second on PGLite (586 s) against 29.0 on Postgres (349 s); peak memory 2,092 MB against 820 MB (Postgres counts client plus server working set); cold start (median of 11 fresh processes) 782 ms against 492 ms; store size on disk 706 MB against 1,005 MB.

### Import at 100,000 pages (gbrain v0.60.734.0)

The same import, one VM per engine, import only:

| Pages imported | PGLite, last 5,000 pages | PGLite put p50 | Postgres, last 5,000 pages | Postgres put p50 |
|---|---|---|---|---|
| 5,000 | 27.7 pages/s | 36.8 ms | | |
| 20,000 | 6.2 pages/s | 156.2 ms | | |
| 40,000 | 1.8 pages/s | 563.5 ms | 24.2 pages/s | 41.5 ms |
| 45,000 | 1.5 pages/s | 658.6 ms | 23.9 pages/s | 42.0 ms |
| 100,000 | not reached (stopped at the 3.75 h limit) | | 23.0 pages/s | 43.5 ms |

Postgres imported 100,000 pages in 4,124 s at a steady rate. On PGLite the time per page grows with the number of pages already stored, so total import time grows roughly with the square of the brain's size.

## What to use and what to avoid

- **Either engine for correctness.** No check, output or retrieval answer separated them, apart from `stale`. If your workflow reads `stale` from `gbrain search --json`, know that Postgres always reports `false` at this build.
- **PGLite for one client and a small brain.** One reader saw no meaningful difference (0.94x), and one writer was faster on PGLite (1.95x), with no server to run.
- **Postgres for several clients or a large brain.** PGLite's read rate falls as clients are added (23.1 reads per second at 4 clients, 17.6 at 16), and its import slows sharply past about 10,000 pages. PGLite's p99 latency was also higher on writes and on keyword and hybrid search.
- **Limits of this evidence.** These are development runs on one machine each, made before the preregistration froze. The 10,000-page speed run started at a load average of 3.55, above the bar of 2 that a counted run requires, and used 2,000 queries per operation, so its p99 intervals are wide (up to about ±0.2). The LongMemEval-S run is a 102-question sample. N14 ran only its 2 MB tier.

## Reproduce

From the repository root, with Bun and Docker, and a gbrain checkout at the named tag (`--gbrain <checkout>@<ref>` loads a verified copy):

```sh
bun eval/runner/engine-bench/correctness.ts --dev --engines pglite,postgres --gbrain <gbrain checkout>@v0.60.735.0
bun eval/runner/engine-bench/surface-parity.ts --dev --engines pglite,postgres --gbrain <gbrain checkout>@v0.60.734.0
bun eval/runner/engine-bench/lme-recall.ts run --dev --engines pglite,postgres --arms keyword,vector,hybrid --stratify 17 --gbrain <gbrain checkout>@v0.60.735.0
bun eval/runner/engine-bench/perf.ts --dev --scale 10000 --engines pglite,postgres --gbrain <gbrain checkout>@v0.60.734.0
```

The vector and hybrid arms need the filled embedding cache; its sha256 is in [lme-recall/cache.sha256](2026-11-17-engine-bench/lme-recall/cache.sha256). Run times: correctness about 38 minutes for both engines on a 4-core machine; the 10,000-page speed run about 51 minutes on a 16-vCPU Ubicloud `standard-16` VM; the 100,000-page Postgres import 69 minutes.

Raw receipts, per-question rows and logs are in [2026-11-17-engine-bench/](2026-11-17-engine-bench/): `correctness/` (the stage receipt and each runner's receipt and log), `surface-parity/`, `lme-recall/` (receipt, NDJSON rows, cache coverage count) and `speed/` (the 10,000-page receipt with every paired query, the 100,000-page Postgres receipt and both engines' 100,000-page logs).

## Disclosures

- gbrain is Garry Tan's own project.
