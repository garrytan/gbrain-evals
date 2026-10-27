# Graph backend: HydraDB vs Postgres: preregistration (GBRA-123)

**Status, 2026-10-17: preregistered, before any timed run.** Written and pushed before the first counted call. Any
change after a cell has run is a dated amendment at the end of this file. No model calls are made: the measurement has
zero model spend.

## Question

gbrain stores its link graph in Postgres (`pages` and `links` tables) and walks it with two engine calls:
`traverseGraph` (pages reachable from a start page, with their depth) and `traversePathsDetailed` (the edges reached,
by direction, optionally one link type). For the walks gbrain runs, which backend serves each walk within budget at
each graph size, and by how much:

- Postgres running the old walk (a recursive CTE that enumerates simple paths),
- Postgres running the breadth-first walk of gbrain PR #6934 (each page once at its shortest depth, each edge once),
- HydraDB, an object-store-native graph database, used as the walk engine with Postgres supplying page metadata?

The result decides whether production HydraDB routing is worth building (decision rule below). It changes no gbrain
default by itself. A database choice is not evidence of better retrieval: every arm must return the same answer to
the same query, and the comparison is time and resources for that same answer.

## Evidence class

Performance comparison on seeded synthetic graphs (development evidence for an engineering decision). No labels, no
held-out set, no model.

## Build and data

- **gbrain, arm A:** `b1fdcb843a5c58a63eda7416dc4965d1926c5232` (master before #6934), old path-enumerating CTE.
- **gbrain, arm B:** `fc1121cae5801f5bdc1eb8241432cf77b7ba5626` (#6934 head on 2026-10-17, branch
  `capy/bfs-graph-walks`), breadth-first walks. If the #6934 head moves before the Team tier runs, the run uses the head
  at that time and records it; walk code changes after the first counted cell are an amendment.
- Each SHA is a separate git worktree with its own `bun install`; the runner loads each engine in its own process and
  records `git rev-parse HEAD` of each worktree in every receipt. Both use their own `initSchema` on the same database
  (no migration differs between the two SHAs; the runner checks the schema version).
- **HydraDB:** `hydra-db/hydradb` at `fe496d475be34b5f5ce60377108b039fd6d485d3`, built locally with its own
  `Dockerfile` (`docker build -t hydradb:local .`), image id recorded. Used only over its HTTP query API; no HydraDB
  code is vendored into gbrain-evals (AGPL-3.0 server).
- **Postgres:** 17 (`pgvector/pgvector:pg17`, image id recorded), `shared_buffers` sized to hold `pages` + `links` +
  their indexes at the tier, `effective_cache_size` set to the VM's memory share, `ANALYZE pages, links` after load.
  All resolved settings (`SHOW ALL`) are saved with the receipts.
- **gbrain-evals:** the commit that adds the runner (recorded in every receipt via `git rev-parse HEAD`).
- **Fixture:** `eval/runner/graph-backend/generate.ts`, seed `20261017`, fictional pages only. Committed generator,
  not committed data; the SHA-256 of the generated edge list is recorded per tier.

### Corpora

| tier | pages | links | sources |
|---|---:|---:|---:|
| Personal | 10,000 | 60,000 | 3 |
| Team | 100,000 | 1,000,000 | 3 |
| Company | 1,000,000 | 10,000,000 | 3 |

- Degree: power law with hubs. Edge source rank `floor(N * u^2)`, target rank `floor(N * u^3)` (u uniform, seeded
  mulberry32), then ranks are mapped to page ids through one seeded permutation, so hub pages have high in- and
  out-degree and are spread across the id and slug order.
- No self loops; at most one link per ordered (from, to) pair, so every (depth, from, to) sort key is unique and the
  row caps truncate deterministically.
- Link types: 10% `mentions` (`link_source = 'mentions'`); the other 90% typed (`link_source = 'markdown'`):
  `works_with` 30%, `works_at` 20%, `invested_in` 15%, `advises` 15%, `founded` 10%.
- Pages: slug `p/NNNNNNN` (zero padded, id order equals slug order), `source_id` one of three fictional sources
  (`src-alpha`, `src-beta`, `src-gamma`) assigned by a seeded draw, type `note`, title from the slug. No page is
  deleted, private or quarantined.
- Every link is walkable in every scenario here (no privacy, temporal, grant or source filter is passed), so the HydraDB
  projection holds every link. This is a best case for HydraDB: per-call privacy, temporal and grant filters cannot be
  expressed per hop in HydraDB's Cypher subset today, so a production router would have to project a filtered graph
  per scope or fall back to Postgres for filtered calls.

## Arms

| arm | engine | walk code |
|---|---|---|
| **A** | Postgres 17 | gbrain `b1fdcb843`, old CTE `traverseGraph` / `traversePathsDetailed` through `PostgresEngine` |
| **B** (comparator) | Postgres 17 | gbrain `fc1121cae58`, breadth-first walks through `PostgresEngine` |
| **C** | HydraDB single node, store on local NVMe-backed MinIO (same VM), plus Postgres 17 for hydration | eval-only adapter in gbrain-evals |
| **D** (only if cheap) | HydraDB single node, MinIO on a separate VM | same adapter |
| **B-PGLite** (context, Personal tier only) | PGLite in process | gbrain `fc1121cae58` through `PGLiteEngine` |

Arm D runs only if Company arm C completes and a second VM fits in the remaining budget; otherwise it is recorded as
skipped with the reason. B-PGLite is context, not part of the decision.

All arms of a tier run on the same VM shape. Personal and Team run on the 4 vCPU / 16 GB Capy machine; Company runs on
one Ubicloud VM (shape recorded). While a Postgres-only arm is timed, the HydraDB and MinIO containers are stopped.

### HydraDB adapter (eval-only, `eval/runner/graph-backend/hydra-adapter.ts`)

- Vertex id = gbrain page id. Every vertex carries label `Page`.
- Relationship types: one catch-all `LINK` for every walkable link, so a walk over all link types is one pattern; plus
  one type per link type from a fixed mapping table built from the fixture's link types (`works_with` to `T_WORKS_WITH`,
  and so on), never from caller strings. A walk restricted to a link type uses that type's relationship.
- Direction `out` uses `-[:T]->`, `in` uses the incoming pattern `<-[:T]-`, `both` is the union of out and in at every
  layer.
- Minimum depth: two strategies are implemented. (1) per-depth `*d..d` queries from the seed plus client-side set
  difference (a node's minimum depth is the smallest d at which it appears; the seed is removed when a cycle returns
  it); (2) layer-by-layer expansion with batched `UNWIND $rows AS row MATCH (a {id: row.id})-[:T]->(b) RETURN row.id
  AS src, b.id AS dst` over the frontier. A calibration on 20 start pages that are not among the counted start pages,
  at the Personal and Team tiers, picks the faster strategy per call kind; the choice is fixed and recorded before
  the counted Team run and documented in the report. `both` is not expressible as one directed pattern (paths may
  alternate direction), so `both` always uses strategy (2).
- Caps: the adapter reproduces gbrain's caps exactly. The walk keeps at most `TRAVERSE_WALK_ROW_CAP` (20,000) visited
  pages, filling each layer in (slug, id) order, which equals id order in this fixture; edges are ordered by
  (depth, from slug, to slug) and cut at `TRAVERSE_PATH_ROW_CAP` (5,000) with the same `truncated` flag. A walk cap
  can only fire on the last layer the walk reaches, so per-depth results are exact up to that layer.
- Edges (`traversePathsDetailed` and the per-node `links` list of `traverseGraph`): batched `UNWIND ... MATCH` over the
  visited ids, once per link-type relationship (the batched read returns only `src` and `dst`, so the link type comes
  from which relationship matched). Batches are 1,000 ids (server cap 1,024), pages of up to 4,096 rows, requests in
  parallel up to a fixed client concurrency (recorded).
- Hydration: the returned ids are read from Postgres (`id, slug, source_id, title, type`) in one `WHERE id = ANY($1)`
  query, so arm C returns the same shape as gbrain's calls. Link `context` is empty in this fixture and is not read.
- Any HydraDB response that signals a budget, truncation or error is recorded as an error for that call, never
  silently accepted. Server budgets are raised to fit the largest call and recorded.

## Workloads

Per tier, a seeded list of start pages: **500** pages, of which 50 are drawn from the top 1% of pages by total degree
(hubs) and 450 uniformly from the rest. At the Company tier the count may be reduced to 200 (20 hubs + 180) if the run
is time-bound; the count used is recorded.

For every start page, 22 calls:

- `traverseGraph(slug, depth)` for depth 1, 2, 3, 5;
- `traversePathsDetailed(slug, { depth, direction, linkType })` for direction `out`, `in`, `both`, linkType none and
  `works_with`, depth 1, 2, 3.

**Passes.** For each arm and tier: restart the database server(s) and drop the OS page cache (and empty HydraDB's local
cache directory), then run every call once in a fixed seeded order (**cold pass**), then run every call again (**warm
pass**). The cold pass is the first touch after a restart, so later calls in it benefit from earlier ones; it is reported
as a pass-level cold number, not per-call cold. Single caller.

**Throughput (Team tier only):** after the warm pass, 8 concurrent callers run the first 100 start pages' 2,200 calls
for arms B and C; reported as calls per second and per-call p50/p95 under load.

**Arm A scope.** A runs all 500 start pages at Personal and the first 100 start pages in list order at Team and Company.
A circuit breaker stops a (tier, pass, call kind, direction, linkType, depth) cell of arm A after 10 timeouts; its
remaining calls are recorded as `not_run_breaker` with the count reported beside timeouts. A is context for the A vs B
comparison and is not in the decision rule.

**Timeouts.** Every call in every arm is capped at 30 s. A timeout is recorded as a timeout (latency counted as at least
30 s in percentiles); it is never dropped. When timeouts are 5% or more of a cell, its p95 is reported as `>= 30 s`.

## Metrics

- **Latency:** full-call wall time measured in the runner, p50 / p95 / p99 per (arm, tier, pass, call kind, direction,
  linkType, depth) cell and pooled per (arm, tier, pass). For arm C, full call = HydraDB queries + Postgres hydration +
  client-side assembly. Percentiles use nearest rank.
- **Throughput:** calls per second at 8 callers (Team, B and C).
- **Load / projection time:** Postgres load (insert, index, ANALYZE); HydraDB projection (vertex labels, `LINK` edges,
  per-type edges) until a read returns the full edge count.
- **Memory and disk:** per arm after the warm pass: container memory (`docker stats`), Postgres relation sizes
  (`pg_total_relation_size`), MinIO data directory and HydraDB cache directory size; Postgres + HydraDB combined for arm C.
- **Correctness (gating):** for every call run by both B and C: identical page sets and identical minimum depths
  (`traverseGraph`), identical per-node `links` sets, identical distinct edge sets with identical depths
  (`traversePathsDetailed`), identical `truncated` flags. Every mismatch is reported and investigated, never hidden.
- **A vs B (context):** identical distinct page sets and distinct (from, to, link type) edge sets when no cap fires. A
  mismatch triggers an untimed probe of A's raw walk row count; a probe at or above 20,000 rows classifies it as
  "A's cap fired" (the old LIMIT-before-DISTINCT cap), otherwise it is a real mismatch.
- **Exploratory, labelled as such:** hops within a 50 ms budget. From the warm `traverseGraph` rows, for each start page,
  the largest depth in {1, 2, 3, 5} whose call finished in 50 ms or less (0 if depth 1 did not); distribution and median
  per arm at the Team and Company tiers.

## Decision rule

Recommend building production HydraDB routing **only if**, on the Team or the Company tier, arm C's warm-pass pooled p95
full-call latency is **at least 2x faster** than arm B's **and at least 50 ms faster** in absolute terms, **with 100%
correctness** (zero B vs C mismatches and zero C errors on that tier).

Otherwise the result is published, the adapter stays in gbrain-evals, and nothing is added to gbrain.

Per-cell comparisons (by call kind, direction, depth, hub vs non-hub) are reported as breakdowns and do not change the
verdict. A tier where C could not load or failed counts as C not meeting the rule on that tier.

## What each outcome changes

| If C meets the rule | If C does not | If incomplete |
|---|---|---|
| Propose a production routing design for the tier(s) where it won, with the filter limitation as its first open problem | Publish; keep the adapter in gbrain-evals; no gbrain change | Publish what ran with the missing cells named; no gbrain change |

## Runner failure contract

- Per-call 30 s timeout (cancelled server-side where the backend supports it).
- Resumable by cell: completed cells are appended to an NDJSON receipt and skipped on rerun.
- A failed call is recorded with its error text. A failed arm load exits non-zero after recording what ran.

## Budget

Zero model spend. Compute: the Capy machine for Personal and Team; one Ubicloud VM for Company (and a second, small one
for arm D if it runs), owner tag `gbra123`, under 20 USD of VM time, destroyed when done.

## Amendments

### 2026-10-17, before any counted cell: adapter details forced by HydraDB's subset and image availability

Found while building the adapter against the HydraDB image, on 5 uncounted smoke start pages (no counted or calibration
cell had run):

1. **Incoming walks use reversed relationship types.** HydraDB rejects an incoming pattern in variable-length `MATCH`
   ("variable-length MATCH requires a fixed source id") and in batched `UNWIND` reads ("UNWIND source requires an id
   field"); only a single-hop, single-seed incoming `MATCH` works. So the projection adds a reversed relationship for
   every link type (`R_<TYPE>`, to -> from) and `LINK_R`, and direction `in` walks those outgoing. `both` is the
   union of forward and reversed types. The projection therefore holds four relationships per link (forward and
   reversed, typed and catch-all).
2. **Relationship batches carry no properties.** HydraDB rejects properties on a batched relationship `CREATE` ("UNWIND
   batch requires one fixed relationship type without properties"), so no `id` property is written; the edge batch
   deduplicates on (src, dst, type).
3. **Per-depth strategy for `traversePathsDetailed`.** Strategy (1) also applies to `out` and `in` path walks
   (walk with `*d..d` over `LINK`, `LINK_R` or the filtered type, then batched edge reads level by level); `both`
   stays layer by layer. Calibration picks per call kind (`traverseGraph`, `traversePathsDetailed`) as written.
4. **HydraDB runs with its indexer.** Arm C runs `graph-node` plus `graph-indexer` (both from the same image) so
   reads use published CSC index generations; counted calls start only after the indexer has published a generation
   for every relationship with its full edge count. Server settings raised from defaults:
   `GRAPH_MAX_QUERY_SCAN_EDGES=1000000000`, `GRAPH_MAX_GRAPHBLAS_BYTES=4294967296`. Everything else is default.
   The indexer's memory counts toward arm C.
5. **MinIO image.** The official `minio/minio` images are no longer pullable (Docker Hub denies the pull, quay.io returns
   401, dl.min.io returns 410). MinIO runs from `bitnamilegacy/minio:2025.7.23`, the same MinIO release date HydraDB's
   own scripts pin (`RELEASE.2025-07-23T15-54-02Z`).
6. **Receipt digests** are the first 16 hex characters of SHA-1 over the canonical result.

### 2026-10-18, after the runs: what changed while running (no rule changed)

Results: [2026-10-17-graph-backend.md](2026-10-17-graph-backend.md).

1. **Team and Company projection check.** At the Team tier the per-relationship `count(*)` check exceeded HydraDB's
   30 s query deadline after the load had finished (log kept as `team/load-hydra-attempt1-count-timeout.log`). The Team
   projection was reloaded from an empty store, and Team and Company verify the projection by the edge count of each
   index generation the indexer published (`HYDRA_VERIFY=index`), which must equal the expected count for every
   relationship before counted calls start. Personal used the `count(*)` check.
2. **Company calibration.** No calibration ran at Company; it reuses the Team choice (layer-by-layer for both calls),
   fixed before the counted Team run as written above.
3. **Company start pages.** 200 (20 hubs + 180), as allowed for a time-bound run. Arm A ran the first 100 at Team and
   Company, as written.
4. **Interruption.** The Capy machine restarted at 02:13 UTC during the uncounted Team calibration pass `cal2` of the
   per-depth strategy. Its partial rows were moved to `team/rows-interrupted-cal2.ndjson.gz` and the pass was rerun
   after the containers restarted. No counted cell was running.
5. **Arm D skipped.** The Company projection took 3.5 hours and arm C already missed the rule by 1.8x to 4.4x; a
   remote object store can only add latency, so the extra run could not change the verdict.
6. **Throughput timeouts.** Under 8 callers at Team, 158 HydraDB `traverseGraph` calls hit the 30 s cap. They are
   reported as timeouts. The decision rule's correctness condition is evaluated on the cold and warm passes, where HydraDB
   had no error or timeout; the verdict is the same either way because the speed condition fails.
