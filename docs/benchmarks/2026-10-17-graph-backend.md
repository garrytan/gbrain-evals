# Graph backend: HydraDB vs Postgres for gbrain's graph walks (GBRA-123)

**Finding, 2026-10-18.** For the two graph walks gbrain runs, Postgres with the breadth-first walks of gbrain PR #6934
answers faster than HydraDB at every graph size we tested, and HydraDB gives the identical answer on every call. On
the 100,000-page graph, the 95th-percentile call takes 1.44 s on Postgres and 6.28 s through HydraDB; on the
1,000,000-page graph, 3.45 s against 6.28 s. The preregistered rule required HydraDB to be at least twice as fast and
50 ms faster on the Team or Company tier, so **the result is no: production HydraDB routing is not worth building for
these walks.** The adapter stays in gbrain-evals and nothing is added to gbrain.

HydraDB does win one kind of call: deep walks in both directions. At the Company tier a depth-3 `both` edge walk
takes 10.3 s at p95 on Postgres and 3.8 s on HydraDB. That is a lead for Postgres work in gbrain, not a reason to add
a second database.

This is a latency comparison for the same answer. A database choice does not make retrieval better or worse here:
every arm returns the same pages and edges for the same query, and we checked that call by call.

## The concrete case

gbrain is a memory system for agents ([repository](https://github.com/garrytan/gbrain)). It keeps notes as pages and
stores the links between pages (`works_at`, `invested_in`, plain mentions, and so on) in Postgres, in the `pages`
and `links` tables. A graph is that set of stored relationships; a graph database is a system built to store and
walk them.

Two engine calls walk the graph (`src/core/engine-sql/links.ts`):

- `traverseGraph(slug, depth)` answers "which pages can I reach from this page in up to N hops, and how far away is
  each one?" It returns every reached page with its shortest distance and the page's outgoing links.
- `traversePathsDetailed(slug, { depth, direction, linkType })` answers "which links sit within N hops of this page?"
  Direction is `out` (links the page makes), `in` (links pointing at it) or `both`, optionally restricted to one
  link type.

An invented example: an agent asks who is within two hops of `people/alice-example` through `works_with` links.
gbrain walks outward from Alice's page, collects every `works_with` edge it meets in two steps, and returns each edge
once with the depth at which it was first reached. Both calls stop at fixed caps (20,000 visited pages, 5,000 returned
edges) and say when they stopped.

[HydraDB](https://github.com/hydra-db/hydradb) is an object-store-native graph database written in Rust. It keeps
the graph in S3-compatible storage (here MinIO on the same machine), builds compressed traversal indexes with a
separate indexer, and answers a subset of the Cypher graph query language over HTTP. The question was whether moving
the walk itself to HydraDB, and keeping Postgres for page metadata, would make these calls fast enough to justify a
second database.

## The experiment

### Arms

| arm | what runs | why it is here |
|---|---|---|
| **A** | gbrain `b1fdcb843` on Postgres 17: the old walk, a recursive CTE that enumerates simple paths | the code before #6934 |
| **B** (comparator) | gbrain `fc1121cae58` (#6934 head) on Postgres 17: breadth-first walks, each page once at its shortest depth, each edge once | the code gbrain is moving to |
| **C** | HydraDB `fe496d475be` single node (graph-node + graph-indexer), store on MinIO on the same machine, plus Postgres 17 for page metadata | the candidate backend |
| **B-PGLite** | arm B's code on PGLite (embedded Postgres), Personal tier only | context for local installs |
| **D** | HydraDB with MinIO on a separate host | **not run** (see limits) |

Arms A and B load gbrain from two git worktrees and call the real `PostgresEngine` methods. Arm C is an eval-only
adapter (`eval/runner/graph-backend/hydra.ts`) that talks to HydraDB only over its HTTP API and reproduces gbrain's
breadth-first semantics and caps exactly:

- Vertex id = page id. For every link type the projection holds a forward relationship (`T_WORKS_WITH`, ...) and a
  reversed one (`R_WORKS_WITH`, ...), plus catch-all `LINK` and `LINK_R`. The reversed types exist because
  HydraDB's Cypher subset rejects incoming patterns in variable-length and batched reads, so an `in` walk is an
  outgoing walk over the reversed type, and `both` is the union.
- Each walk expands one layer at a time with batched `UNWIND $rows AS row MATCH (a {id: row.id})-[:T]->(b) RETURN
  row.id AS src, b.id AS dst` reads (1,000 ids per request, 8 requests in flight). A second strategy, per-depth
  `*d..d` queries plus client-side set difference, was implemented and calibrated on 20 uncounted start pages at
  the Personal and Team tiers (Company reused Team's choice). It won only for `traverseGraph` at the Personal tier (p95 1,944 against 1,964 ms) and lost badly at Team
  (21.8 s against 7.0 s), so Personal's `traverseGraph` used it and every other cell used layer-by-layer expansion
  (`*/calibration.json`).
- Returned ids are hydrated from Postgres (`slug, source_id, title, type`) in one query, so arm C returns the same
  shape as gbrain. Arm C's time is the whole call: HydraDB requests, the Postgres read and client-side assembly.
- The projection holds every link because no call here passes a privacy, temporal, grant or source filter. **That is
  a best case for HydraDB.** gbrain applies those filters at every hop; HydraDB's subset cannot express them per hop
  today, so a production router would need one projection per scope or would fall back to Postgres for filtered calls.

### Graphs

Seeded fictional graphs from `eval/runner/graph-backend/generate.ts` (seed `20261017`): power-law degree with hubs
(source rank `floor(N * u^2)`, target rank `floor(N * u^3)`, mapped through a seeded permutation), 10% `mentions`
links and five typed link kinds, three fictional sources, no self loops, at most one link per ordered pair.

| tier | pages | links | edge-list SHA-256 | machine |
|---|---:|---:|---|---|
| Personal | 10,000 | 60,000 | `9800af0f…` | Capy cloud machine, 4 vCPU, 16 GB |
| Team | 100,000 | 1,000,000 | `4fa33274…` | same machine |
| Company | 1,000,000 | 10,000,000 | `f8674218…` | Ubicloud `standard-16`, 16 vCPU, 64 GB |

Postgres ran with `shared_buffers` 4 GB (16 GB at Company, larger than `pages` + `links` at every tier), `jit`
off, `random_page_cost` 1.1, and `VACUUM ANALYZE` after load. HydraDB ran with its defaults except
`GRAPH_MAX_QUERY_SCAN_EDGES` (raised to 10^9) and `GRAPH_MAX_GRAPHBLAS_BYTES` (4 GiB). While arms A and B were timed,
HydraDB and MinIO were stopped.

### Workload

Per tier, 500 seeded start pages (Company: 200, as the preregistration allowed), one in ten drawn from the top 1% of
pages by degree. Every start page gets 22 calls: `traverseGraph` at depth 1, 2, 3, 5 and `traversePathsDetailed` for
`out`, `in`, `both`, with and without `linkType: works_with`, at depth 1, 2, 3. Each arm runs a cold pass (servers
restarted, OS cache dropped, HydraDB's local caches emptied) and then a warm pass, single caller, every call capped at
30 s. Arm A ran the first 100 start pages at Team and Company. At Team, arms B and C also ran 100 start pages with 8
concurrent callers.

## Results

### Headline: warm pass, all calls pooled

| tier | arm | calls | p50 ms | p95 ms | p99 ms | same answer as B |
|---|---|---:|---:|---:|---:|---|
| Personal | A old CTE | 11,000 | 1.6 | 272 | 370 | distinct sets differ on 2,758 of 22,000 calls, every one where a row cap fired |
| Personal | **B breadth-first** | 11,000 | 1.9 | **259** | 351 | (comparator) |
| Personal | B on PGLite | 11,000 | 2.7 | 334 | 440 | 22,000 of 22,000 |
| Personal | C HydraDB | 11,000 | 5.0 | 1,199 | 1,992 | 22,000 of 22,000 |
| Team | A old CTE (100 starts) | 2,200 | 6.3 | 1,214 | 2,526 | differ on 820 of 4,400, all where a cap fired |
| Team | **B breadth-first** | 11,000 | 6.2 | **1,439** | 3,028 | (comparator) |
| Team | C HydraDB | 11,000 | 8.7 | **6,278** | 6,635 | 24,042 of 24,042 compared |
| Company | A old CTE (100 starts) | 2,200 | 21.6 | 3,769 | 7,766 | differ on 820 of 4,400, all where a cap fired |
| Company | **B breadth-first** | 4,400 | 21.7 | **3,448** | 7,573 | (comparator) |
| Company | C HydraDB | 4,400 | 51.0 | **6,277** | 8,435 | 8,800 of 8,800 |

"Same answer" compares a digest of the full result: for `traverseGraph`, every page with its source, shortest depth,
title, type and outgoing links; for `traversePathsDetailed`, every edge with its depth plus the truncation flag. Cold
and warm passes are both counted. HydraDB matched Postgres on all 54,842 calls where both finished. Cold passes were
within a few percent of warm for every arm (`summary.json`), so a restart costs little here.

**Decision rule.** C's warm p95 is 0.23x B's speed at Team (4.84 s slower) and 0.55x at Company (2.83 s slower). The
rule needed at least 2x faster and 50 ms faster, with full correctness. Correctness holds on every cold and warm call;
speed does not. **Verdict: do not build production HydraDB routing.**

### By call

Warm p50 / p95 in ms; the last column is B's p95 divided by C's (above 1 means HydraDB is faster).

| call | Team B | Team C | Team B/C | Company B | Company C | Company B/C |
|---|---:|---:|---:|---:|---:|---:|
| `traverseGraph` d1 | 5.8 / 33 | 10.5 / 55 | 0.60 | 18.4 / 80 | 39 / 183 | 0.44 |
| `traverseGraph` d2 | 101 / 576 | 228 / 1,906 | 0.30 | 299 / 2,403 | 663 / 4,995 | 0.48 |
| `traverseGraph` d3 | 1,223 / 1,516 | 5,428 / 6,644 | 0.23 | 2,870 / 4,569 | 6,252 / 8,802 | 0.52 |
| `traverseGraph` d5 | 1,531 / 1,984 | 6,435 / 6,741 | 0.29 | 3,016 / 5,390 | 6,481 / 9,061 | 0.59 |
| paths `out` all d3 | 92 / 335 | 158 / 1,110 | 0.30 | 219 / 1,753 | 390 / 1,382 | 1.27 |
| paths `in` all d3 | 90 / 899 | 91 / 786 | 1.14 | 138 / 2,355 | 359 / 1,609 | 1.46 |
| paths `both` all d2 | 29 / 242 | 29 / 213 | 1.13 | 52 / 858 | 138 / 506 | 1.69 |
| paths `both` all d3 | 934 / 3,424 | 456 / 2,417 | 1.42 | 3,555 / 10,314 | 857 / 3,793 | **2.72** |
| paths `both` works_with d3 | 113 / 1,013 | 55 / 305 | **3.32** | 378 / 4,369 | 302 / 1,416 | **3.09** |
| paths `out` works_with d3 | 7.3 / 59 | 10.3 / 167 | 0.36 | 23 / 138 | 56 / 665 | 0.21 |
| paths (all 18 cells pooled) | 4.7 / 585 | 5.1 / 441 | 1.33 | 16.0 / 2,146 | 30.6 / 1,068 | 2.01 |

The full per-cell table for all three tiers and all arms is in `summary.json` (`tiers.<tier>.cells`).

What the numbers say:

- **`traverseGraph` decides the verdict.** It returns each reached page's outgoing links with their types. HydraDB's
  batched read returns only source and target ids, so the adapter reads every visited page once per link type: at
  depth 3 or more that is up to 20,000 pages times six relationships, 120 or more requests, and HydraDB served about
  13,000 rows per second per request here. Postgres reads the same links with one indexed join. A depth-1 walk with one
  link type is already slower on HydraDB.
- **Deep `both` walks are where HydraDB helps.** Postgres's `both` query unions an outgoing and an incoming join per
  layer and then classifies each edge against both endpoints' depths; on the hub-heavy Company graph that reaches 10.3 s
  at p95. HydraDB's layer reads stay near linear in the frontier. The pooled `traversePathsDetailed` p95 at Company is
  2.01x faster on HydraDB (2,146 against 1,068 ms), which would meet the rule's ratio for that call kind alone. The
  preregistered rule pools both calls, so this does not change the verdict; it marks gbrain's `both` walk as the
  slowest Postgres path and the first place to optimise.
- **Hub start pages** cost more on every arm (Company warm p95: B 5,960 ms at hubs, 3,199 ms elsewhere; C 6,970 and
  6,174 ms).

### Under load, Team tier, 8 concurrent callers

| arm | calls per second | p50 ms | p95 ms | timeouts |
|---|---:|---:|---:|---:|
| B breadth-first | **13.8** | 17.6 | 3,550 | 0 |
| C HydraDB | 2.4 | 99 | >= 30,000 | 158 of 2,200 (all `traverseGraph`) |

HydraDB's `traverseGraph` calls queue behind each other's batched reads; 158 hit the 30 s cap and are counted as
timeouts, never dropped. Every call that finished matched Postgres.

### Old CTE against breadth-first (A against B)

On these graphs the old path-enumerating CTE is not slower than breadth-first: its 20,000-row cap stops the path
explosion early (Team `traverseGraph` warm p95 1,385 ms for A, 1,800 ms for B). The cost is in the answer. A's cap is
applied before duplicates are removed, so on 2,758 of 22,000 Personal calls and 820 of 4,400 Team and Company calls it
returned fewer distinct pages or edges than exist. Every one of those differences is on a call where a row cap fired: the
5,000-edge cap (truncated in A or B), or A's walk cap, confirmed by an untimed probe counting at least 20,000 raw walk
rows. None is unexplained. Breadth-first returns
the complete answer at the same speed. The 22 s clique case that motivated #6934 is not in this workload; #6934's own
benchmark covers it.

### Exploratory, labelled as such: hops within 50 ms

For each start page, the deepest `traverseGraph` depth (1, 2, 3 or 5) that finished in 50 ms or less on the warm pass.

| tier | arm | 0 hops | 1 hop | 2 hops | 3 hops | 5 hops | median |
|---|---|---:|---:|---:|---:|---:|---:|
| Team | B | 8 | 382 | 107 | 2 | 1 | 1 |
| Team | C | 34 | 430 | 35 | 0 | 1 | 1 |
| Company | B | 28 | 163 | 9 | 0 | 0 | 1 |
| Company | C | 80 | 120 | 0 | 0 | 0 | 1 |

Neither backend walks past one hop within 50 ms for most start pages on graphs this large and hub-heavy; Postgres
reaches two hops for about a fifth of Team start pages, HydraDB for 7%.

### Load time, memory and disk

| tier | Postgres load (rows + ANALYZE) | `pages` + `links` on disk | HydraDB projection | index ready after | MinIO on disk | HydraDB local cache |
|---|---:|---:|---:|---:|---:|---:|
| Personal | 3.7 s | 25.6 MB | 31 s | 0 s | 199 MB | 44 to 119 MB |
| Team | 36 s | 295 MB | 13.6 min | 20 s | 5.10 GB | 0.26 to 1.0 GB |
| Company | 6.4 min | 2.86 GB | 3.5 h | 4.4 min | 15.7 GB | 1.0 GB |

The HydraDB projection writes four relationships per link (forward and reversed, typed and catch-all), so it stores
40 million relationships at Company. Peak container memory after loading at Company: graph-node 2.8 GB, indexer
3.2 GB, MinIO 1.2 GB, next to Postgres at 3.3 GB; after the warm pass, graph-node held 1.4 GB. Running arm C means
running Postgres **and** HydraDB, so its combined disk at Company is about 20 GB (Postgres data directory 4.2 GB plus
MinIO 15.7 GB) against 4.2 GB for Postgres alone.

## What to use and what to avoid

- **Keep gbrain's graph walks in Postgres and ship the breadth-first walks.** They return complete answers at the
  same speed as the old CTE on hub-heavy graphs and avoid its blow-up on dense ones. PGLite runs them about 30% slower
  than Postgres at the Personal tier (p95 334 against 259 ms) with identical answers.
- **Look at `traversePathsDetailed` with `direction: 'both'` next.** It is gbrain's slowest walk at scale (10.3 s
  p95 at depth 3 on the Company graph), and an engine that walks layer by layer did it 2.7x faster. A Postgres change
  (for example walking each direction's frontier separately before the depth comparison) is the cheap experiment.
- **Do not add HydraDB as a walk backend for these calls.** It loses on `traverseGraph` at every size, stores about
  five times as much as gbrain's `pages` and `links` tables, needs a separate indexer and a projection that took 3.5 hours at 10 million links, and could not
  apply gbrain's per-hop privacy, temporal and source filters.

### Limits

- **Best case for HydraDB.** No call passed a filter, so one projection served every call. With per-scope filters,
  HydraDB would need a projection per scope or a Postgres fallback.
- **Arm D was not run.** A separate MinIO host was "only if cheap". The Company projection alone took 3.5 hours, and a
  remote object store can only add latency to arm C, which already loses by 1.8x to 4.4x; the extra VM time could not
  change the verdict.
- **Single node, one shape per tier.** Personal and Team ran on a 4 vCPU machine, Company on 16 vCPU. HydraDB is built
  to scale query nodes out; one node per arm is what a gbrain install would run, but a cluster could change throughput.
- **Adapter design is ours.** The layer-by-layer reads, batch size (1,000) and client concurrency (8) were fixed before
  counted calls; a different query plan inside HydraDB (for example a server-side procedure returning typed edges)
  could narrow the `traverseGraph` gap. HydraDB's `algo.*` path procedures return paths, not walks, and are not
  used.
- **Cold pass** is a pass-level cold number (first touch after a restart), not a per-call cold read.
- **Projection checks.** Personal verified every relationship with a `count(*)`; at Team that count timed out against
  HydraDB's 30 s query deadline (`team/load-hydra-attempt1-count-timeout.log`), so Team and Company verified the
  projection by the edge count of each published index generation instead (`*/index-ready.json`). Correctness rests
  on the call-by-call comparison either way.
- **One interruption.** The Capy machine restarted during Team calibration (uncounted). Containers were restarted, the
  partial calibration pass was moved aside (`team/rows-interrupted-cal2.ndjson.gz`) and rerun; no counted call was
  affected.

## Reproduce and inspect

From the repository root, with Docker and Bun, no API keys, $0 in model spend:

```bash
# gbrain at the two SHAs, as worktrees
git clone https://github.com/garrytan/gbrain.git ../gbrain-src
git -C ../gbrain-src worktree add ../gbrain-A b1fdcb843a5c58a63eda7416dc4965d1926c5232
git -C ../gbrain-src worktree add ../gbrain-B fc1121cae5801f5bdc1eb8241432cf77b7ba5626
(cd ../gbrain-A && bun install) && (cd ../gbrain-B && bun install)
# HydraDB image from its own Dockerfile (about 7 minutes on 4 cores)
git clone https://github.com/hydra-db/hydradb.git ../hydradb && git -C ../hydradb checkout fe496d475be34b5f5ce60377108b039fd6d485d3
docker build -t hydradb:local ../hydradb
# one tier, resumable by stage and by call
eval/runner/graph-backend/stack.sh pg-up
GB_A=$PWD/../gbrain-A GB_B=$PWD/../gbrain-B eval/runner/graph-backend/run-tier.sh personal
# Team: add HYDRA_VERIFY=index. Company: PG_SHARED_BUFFERS=16GB PG_CACHE=40GB STARTS=200 HYDRA_VERIFY=index,
# on a 16 vCPU machine (eval/runner/graph-backend/ubicloud-setup.sh bootstraps one)
GB_B=$PWD/../gbrain-B bun eval/runner/graph-backend/analyze.ts docs/benchmarks/2026-10-17-graph-backend
```

- Code: `eval/runner/graph-backend/` (generator, Postgres loader, HydraDB loader and adapter, worker, runner, analyzer).
- Receipts: `docs/benchmarks/2026-10-17-graph-backend/<tier>/`: `rows.ndjson.gz` (one row per call: arm, pass, cell,
  start page, hub flag, status, milliseconds, result size, truncation, result digests), `identities.json` (both gbrain
  SHAs, the gbrain-evals commit, image ids, machine), `pg-settings.json` (every resolved Postgres setting),
  `load-*.json`, `index-ready.json`, `calibration.json`, `stats-*.json`, `worker-runs.ndjson`, `plan.json`.
  `summary.json` holds every percentile, correctness count and the decision inputs.
- Identities: gbrain A `b1fdcb843a5c58a63eda7416dc4965d1926c5232`, B `fc1121cae5801f5bdc1eb8241432cf77b7ba5626`;
  HydraDB `fe496d475be34b5f5ce60377108b039fd6d485d3`, image `sha256:574c68f9…`; Postgres `pgvector/pgvector:pg17`
  (`sha256:ac08538c…`); MinIO `bitnamilegacy/minio:2025.7.23` (`sha256:8935e75f…`; the official MinIO images are
  no longer pullable, see the preregistration's amendment).
- Preregistration: [2026-10-17-graph-backend-preregistration.md](2026-10-17-graph-backend-preregistration.md), pushed
  before any timed run, with one amendment written before any counted cell and one written after the runs that
  records what changed while running (no rule changed).
- Time and cost: Personal about 2 hours and Team about 7.5 hours on the Capy machine; Company 8 hours 24 minutes on one
  Ubicloud `standard-16` VM, about $4.20 at list price. No model calls.
