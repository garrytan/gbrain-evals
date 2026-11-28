# Filtered vector search with materialization off: preregistration

Written on 2026-11-26 for GST-4006, the first of two pull requests (R77: this preregistration, then one results pull
request). Nothing in this experiment has run. This file is frozen by its merge commit. Any later change is a dated
amendment under "Amendments", committed on the results branch before the cells it governs.

## The question

gbrain answers a vector search on Postgres with one SQL statement that joins the nearest chunks from the HNSW index to
their pages and applies the caller's filters. For some of those statements gbrain already turns the planner's
`enable_material` setting off, because the planner otherwise filters every page once, stores the survivors in a
Materialize node and rescans them for each candidate chunk: about 2.2 s for a 250-row window over 51,000 pages, against
10 ms with the setting off (the comment on `JOINED_STATEMENT_SETTINGS` in gbrain's
[`src/core/search/vector-statement.ts`](https://github.com/garrytan/gbrain/blob/3a360389f152e62ccb627ab96eccfad8a9204e75/src/core/search/vector-statement.ts)).
Today gbrain applies it only when the statement also has an "index walk", which a search narrowed by type, date,
frontmatter (`where`) or a small source scope never has. So those filtered searches keep the planner's own plan, on
purpose: the same comment says that with materialization ruled out the planner may switch to an exact scan of the
filtered pages first, which returns a different set of chunks.

[gbrain#9817](https://github.com/garrytan/gbrain/issues/9817) proposes applying the setting to those filtered searches
too. Its author measured a 4.2 s median falling to about 1 s on a real 18,211-page library, large gains on generated
corpora of 6,000 and 18,000 pages, a slowdown on a 600-page corpus (17 ms to 41 ms on Postgres) and a 1.25-point loss
of exact-neighbour recall in one 6,000-page cell. Before gbrain changes its default, this experiment measures the
latency gain and the recall cost across corpus sizes, filter kinds and selectivities, cache state, and the Postgres and
pgvector versions gbrain supports.

## The public lesson

- If it wins: "We learned that turning off Postgres materialization for filtered vector searches makes them N times
  faster at the sizes real brains reach, with no measurable loss of nearest-neighbour recall. You should get it by
  upgrading gbrain, or set `enable_material=off` for filtered pgvector joins in your own stack."
- If it loses on recall somewhere: "We learned that the faster plan finds fewer true nearest neighbours when
  <condition>. You should keep the planner's plan there, and you should measure recall against an exact scan before
  adopting planner settings that speed up filtered vector search."
- If latency doesn't improve: "We learned that at the sizes gbrain brains reach, Postgres already plans filtered vector
  searches well, so the setting buys nothing. You don't need it."

## What the result decides

GBrain's maintainers (GBRA-108) decide whether gbrain flips the default. Each outcome changes what they do (R97). The
cell states and the realistic set are defined under "Decision rule".

| Outcome | What happens |
|---|---|
| **Flip.** Latency improves on the realistic affected cells, no realistic cell loses recall beyond the margin or is unresolved, and no realistic cell regresses on latency | GBRA-108 flips the default: the predicate change in "Arms" ships in gbrain, with this result linked from its changelog |
| **Limited flip.** Latency improves, but some realistic cells lose recall, stay unresolved or regress on latency, and a rule over what gbrain knows at query time (filter kind, estimated filtered share, corpus size) separates them from the safe cells | GBRA-108 gets the rule and the cells it covers. The rule is exploratory: it is confirmed on a fresh corpus seed and query set (stage 1b, below) before GBRA-108 ships it |
| **No flip.** Recall is lost beyond the margin, or latency regresses, wherever latency improves, and no rule separates them | gbrain keeps today's plan and #9817 is answered with the cells and plans that show why |
| **Close.** Latency doesn't improve on the realistic affected cells | #9817 is closed with the measurements; nothing changes in gbrain |

Any outcome publishes the results page with every cell, and the plans.

## Evidence class

Development evidence on generated and public data. Neither corpus was used to tune the code under test. The latent
generator is gbrain's own planner bench corpus (below), so gbrain's maintainers have seen its geometry.

## Build and data

- **gbrain**: the newest release tag on gbrain's master at launch, today v0.60.776.0
  ([`3a360389`](https://github.com/garrytan/gbrain/tree/3a360389f152e62ccb627ab96eccfad8a9204e75)). The results branch's
  first commit runs `bun eval/runner/gbrain-pin.ts bump`; if a newer release lands before the first counted cell, the
  pin moves in a dated amendment. The build freezes when the first counted cell starts (R100), and the results name it.
- **gbrain-evals**: the results branch commit each run records.
- **Corpus L (latent, synthetic).** gbrain's own planner bench generator, `scripts/bench/hnsw-latent-corpus.ts` at the
  pin: brain-shaped pages of 1 to 60 chunks (mean about 7.5), topic structure with low-rank local variation, unit
  vectors at 1024 dimensions (gbrain's default, `voyage-4`), seed 9817. Four sizes by chunk count: 15,000, 75,000,
  375,000 and 1,500,000 chunks (about 2,000, 10,000, 50,000 and 200,000 pages). 10% of pages are private (the
  generator's visibility draw), because the private-page rule is what makes the materialized plan expensive.
- **Corpus W (real text).** English Wikipedia (`wikimedia/wikipedia`, `20231101.en`, CC BY-SA 4.0) cut into
  brain-shaped pages by gbrain's `scripts/bench/hnsw-real-corpus-prep.py` at the pin, 375,000 chunks, embedded with
  `voyage-4` at 1024 dimensions. Queries are first sentences of sampled chunks, embedded as queries (below). The text
  and vectors stay on the run's machines and are never committed; the results record the shard list and the hashes of
  `pages.tsv`, `chunks.txt` and the vector file.
- **Filter attributes.** Each page gets a `type`, an `effective_date`, a frontmatter tag `fv_tag` and a
  `source_id` from a rank between 0 and 1, in one of two modes:
  - *independent*: the rank is a hash of the page id, so the filter has nothing to do with where the page sits in vector
    space;
  - *clustered*: pages are ordered by a locality-sensitive hash of their first chunk's vector (signs of 8 seeded random
    projections, 256 buckets, buckets in seeded order), so a filter selects whole regions of the space. This is the hard
    case for filtered nearest-neighbour search, as when an agent asks about meetings and meetings sit in one corner of
    the space.

  The mode is switched by rewriting the page attributes and running `VACUUM ANALYZE pages`; chunks and the HNSW index
  are untouched. Type and tag each use a separate rank, so the two filters select different pages.
- **Seeds.** Corpus 9817, attributes 9818, queries 9819, bootstrap 9820. Stage 1b uses 19817 to 19819.

## Arms

Both arms call gbrain's own `engine.searchVector(embedding, opts)` on the same database, connection settings and query
vectors. Nothing else differs.

- **C (comparator): gbrain as it ships** at the pin. A pooled attempt of a joined statement gets
  `JOINED_STATEMENT_SETTINGS` (`enable_material = off`) only when the statement has an index walk:
  `!!shape.indexWalkSql && !walk && !(scopeScan && shape.scopeScanSql) && !exact` in `src/core/postgres-engine.ts`,
  and `!!stmt.indexWalkSql && !indexWalk && !(scopeScan && stmt.scopeScanSql)` in `src/core/pglite-engine.ts`.
- **T: materialization off for filtered joins.** A copy of the same tree with `!!shape.indexWalkSql` replaced by
  `shape.relaxed` in the first predicate and `!!stmt.indexWalkSql` by `stmt.relaxed` in the second, which is the
  change #9817 describes. The harness applies it to a copy of the pinned checkout, refuses to run unless each
  replacement matches exactly once, and records the hashes of both patched files. The index walk, the scope scan, the
  exact fallback and the legacy guard keep today's settings in both arms. The change was written here from the issue's
  description; no code from #9817 is checked out or run (R45).

Where the arms differ: a statement that is relaxed (an HNSW-indexed `embedding` column, the legacy guard off) but has
no index walk, which is a search with a `type`, `types`, `where`, `afterDate` or `beforeDate` filter, or a source
scope under 4% of pages, or one whose small scope scan came back short. Everywhere else the two arms run the same SQL
with the same settings, and those cells are sanity checks.

Not tested, with the reason: IVFFlat, because gbrain's chunk search builds only HNSW (`idx_chunks_embedding`); and
embeddings wider than 2,000 dimensions, because gbrain builds no chunk index for them and both arms then run the same
exact scan.

## Cells

A cell is one corpus and size, engine and version, attribute mode, caller, filter, limit and cache state.

- **Filters** (share of pages selected): `type` at 0.1%, 1%, 5%, 20% and 50%; `afterDate` at the same five shares;
  `where: { fv_tag }` at the same five; `type` (20%) with `afterDate` (50%) together; a source scope of 1% and of 3%
  of pages; and two sanity filters where the arms are identical by construction, no filter and a 50% source scope.
- **Callers**: a trusted caller (gbrain's local default, no private-page rule) and a caller gbrain treats as untrusted
  (`excludePrivate: true`, which adds the private-page rule that the `JOINED_STATEMENT_SETTINGS` comment names as the
  cause of the expensive plan). 10% of pages are private in every cell.
- **Limits**: 20 (gbrain's default) everywhere, and 50 on the primary engine in independent mode.
- **Queries per cell**: 200 at 375,000 chunks and below and on W, 100 at 1,500,000. A query starts from a chunk: on L
  the generator's own query perturbation of that chunk, on W the chunk's first sentence. In independent mode the chunks
  come from random pages, one fixed set per corpus and size. In clustered mode half the queries come from pages the
  filter selects and half from pages it doesn't, drawn per filter, and both halves are reported. A filter that leaves
  no page out for the caller (no filter for the trusted caller) uses the independent set instead, and the sanity
  cells always do.
- **Warm cache**: each query runs once per arm untimed, then three timed repeats with the arm order alternating by query
  and repeat (AB, BA, AB for even queries; BA, AB, BA for odd ones).
- **Cold cache**: in independent mode with the untrusted caller, the `type`, `afterDate` and `where` filters at 1% and 20%, limit 20, 30 queries
  per cell. Before each timed search the harness restarts Postgres, drops the operating system's page cache
  (`sync; echo 3 > /proc/sys/vm/drop_caches`) and opens a fresh gbrain engine, so gbrain's first-call probes are part of
  the timing, as they are after a real restart. For PGLite it closes and reopens the engine after dropping the cache.
- **Engines and versions**:
  - *Primary*: PostgreSQL 17 with pgvector 0.8.7 (`pgvector/pgvector:0.8.7-pg17`, pinned by digest at launch), every
    size of L and W, every filter, both modes, both callers, both limits, warm and cold.
  - *Version sweep*: PostgreSQL 15, 16 and 18 with pgvector 0.8.7, and PostgreSQL 17 with pgvector 0.7.4 (the oldest
    pgvector gbrain accepts, without iterative scans), on L at 75,000 and 375,000 chunks, both modes, both callers, limit 20,
    warm and cold. gbrain supports PostgreSQL 15 and newer (its `postgres15-compat` CI job) and pgvector 0.7 and newer
    (`docs/guides/move-to-postgres.md`).
  - *PGLite*: gbrain's default engine at the PGLite the pin installs, on L at 15,000, 75,000 and 375,000 chunks (375,000
    is near the 50,000-page size gbrain's README gives as PGLite's range), both modes, both callers, limit 20, warm and
    cold.
- **Postgres settings**: gbrain's own bench sizing (`scripts/bench/hnsw-scale-vm-setup.sh` at the pin):
  `shared_buffers` 25% and `effective_cache_size` 75% of the machine's memory, `random_page_cost` 1.1,
  `effective_io_concurrency` 200, everything else at Postgres defaults, including `work_mem` (4 MB). The schema and
  the HNSW index come from gbrain's `initSchema` with its default index parameters; the index is built after the
  load, then every table is vacuumed and analyzed.
- **Machines**: one Ubicloud VM per engine and version, the database and the harness on the same VM, one client at a
  time. Primary: `standard-16` (64 GB). Version sweep and PGLite: `standard-8` (32 GB).

## Metric and denominator

- **Latency** of one `searchVector` call, wall time in the harness process: p50, p95 and p99 per cell and arm over all
  timed repeats (warm) or all timed searches (cold). Query embedding is outside the timing. The primary statistics are
  the ratios T/C of p50 and of p95.
- **Recall@k** for one query and arm: the share of the exact top k pages (k = the limit) that the arm returned, over
  `min(k, eligible pages)`. gbrain returns one row per page, its best chunk, so the unit is a page. A query whose filter
  leaves no eligible page is left out of recall and counted. The arm's rows are the first timed repeat's; the harness
  records whether later repeats returned the same ordered pages.
- **Exact ground truth**: gbrain's own `exactSql` for the same statement (`buildVectorSearchStatement` at the pin,
  every eligibility predicate, the distance written as `+ 0` so no index can serve it), with its candidate window
  unbounded (`null` bound at `innerLimitIdx`, as gbrain's own exact fallback binds it), so every eligible chunk is
  scored before pages are collapsed. It runs in its own read transaction with JIT off. The corpus's slugs and sources
  match no source boost (`GBRAIN_SOURCE_BOOST` and `GBRAIN_SEARCH_EXCLUDE` unset), so every page's factor is 1 and
  the oracle ranks pages by pure cosine distance. The pilot checks both properties: on every pilot cell the oracle
  must agree with an independent float64 brute force over the generated vectors (each eligible page ranked by its
  best chunk's cosine) on the ordered top k pages for every query, apart from ties within 1e-6, and its scores must
  equal those cosines within 1e-5.
- **Secondary**: recall@10 inside limit-20 results; the share of queries where T and C return the same ordered pages;
  searches gbrain reports as incomplete (`onVectorPoolMeta`); errors.
- **Errors**: a search that throws counts as recall 0 and is timed to the throw; a cell with more than 1% errors in
  either arm is invalid, reported as such, and fixed before it counts.
- **Plans**: a separate capture pass (not timed) runs the first 5 queries of every cell per arm and, inside each vector
  attempt's own transaction and settings, runs `EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON)` of that attempt's
  statement before the statement itself, so the plans show `enable_material` and every Materialize node. On PGLite the
  same is done through its transaction handle. The results publish each cell's plan summary (node types,
  Materialize nodes, the index used, temporary blocks, attempts per search) and representative plans in full.

## Decision rule

Intervals are 95% percentile bootstrap intervals, 10,000 resamples over queries (a query's repeats move together).

**The realistic set** is L at 15,000, 75,000 and 375,000 chunks and W, on every engine and version tested, both modes,
both callers, both limits and both cache states. L at 1,500,000 chunks is the larger size: reported, and used only to say whether a
flip should carry a size limit.

**Affected cells** are those whose filter is one of `type`, `afterDate`, `where`, the combination, or a source scope
under 4%. An affected cell is **reached** when at least one arm-T search in it ran a joined pooled attempt; every
cell reports the share of its T searches that did. Recall and latency states apply to every affected cell, but the
pooled latency test below uses only reached cells, because an unreached cell runs the same SQL in both arms.

Each cell gets one state for recall and one for latency:

- **Recall** on the paired per-query difference T − C in recall@k, with a non-inferiority margin of 0.01 (one point):
  - *safe* when the interval's lower end is at or above −0.01;
  - *loss* when the mean is below −0.01 and the interval's upper end is below 0;
  - *unresolved* otherwise.
- **Latency**:
  - *improves* when the p50 ratio's upper end is below 0.90 and the p95 ratio's upper end is below 1.00;
  - *regresses* when the p50 ratio's lower end is above 1.10 with p50 at least 5 ms slower, or the p95 ratio's lower end
    is above 1.10 with p95 at least 20 ms slower;
  - *neutral* otherwise.

A cell that comes out *loss* or *regresses* is re-run once on a fresh query set (seed 29819) and keeps that state only if
the re-run agrees; this guards the many cells against chance calls. Sanity cells check the harness directly: their captured attempts must
have identical SQL and settings in both arms, and they must return the same ordered pages in both arms for at least
99% of queries. For latency, the geometric mean of the p50 ratios over all warm sanity cells of one engine and
version must have an interval inside 0.95 to 1.05; a single sanity cell's interval missing 1 is expected by chance
across this many cells and is reported, not acted on. A failed check means the harness is wrong, and it is fixed
before anything counts.

**Latency improves on the realistic affected cells** when the geometric mean of the p50 ratios over the realistic
affected, reached warm cells has an interval below 1.00, the same holds for the p95 ratios, and at least one realistic size has
affected cells that *improve*.

The outcome in "What the result decides" follows:

- **Flip** when latency improves on the realistic affected cells and every realistic affected cell is *safe* on recall
  and not *regresses* on latency.
- **Limited flip** when latency improves and some realistic cells are *loss*, *unresolved* or *regresses*. The rule
  proposed to GBRA-108 is the simplest threshold on filter kind, estimated filtered share or corpus size that puts every
  such cell on the keep-today side and the most *improves* cells on the flip side. It is exploratory, and **stage 1b**
  confirms it: one fresh L corpus (seed 19817) at the sizes the rule depends on, fresh queries, every filter on both sides
  of the threshold, primary engine. The rule passes when, on stage 1b, every cell on its flip side is *safe* on recall and none *regresses* on
  latency; an *unresolved* flip-side cell fails it.
- **No flip** when latency improves but no such rule exists, or the stage 1b check fails.
- **Close** when latency doesn't improve on the realistic affected cells.

**Smallest detectable difference.** With 200 queries a cell resolves the 0.01 recall margin when the per-query difference
has a standard deviation up to about 0.07 (interval half-width 0.0098). The pilot measures that deviation; if it would
make the half-width larger than 0.008 in a cell family, that family's query count rises (up to 500) by a dated amendment
before counted runs. For latency, with 600 warm timings per arm a cell resolves a p50 ratio of 0.90 against 1.00 when
the run-to-run spread is that of the pilot; the pilot reports the interval widths it saw.

## Stage 2 (runs only on its trigger)

**Trigger**: some realistic cell ends *loss* on recall after its re-run, and the outcome is a limited flip or no flip.
Then the question is whether that recall loss changes the answers an agent gets. Stage 2 measures end-to-end answer
accuracy on an existing dev world with filtered retrieval, arm C against arm T, reader `claude-opus-5-5`. Its judge is
`gpt-6.2-astra`, another family from the reader, checked on at least 100 outputs labelled by people with kappa of at
least 0.6 before its numbers count (R78), unless the chosen world has a deterministic answer key, which is then the
primary scorer. Its world, filters, sample size, smallest detectable difference and cost are frozen in a dated amendment
and go to the Captain for approval before any stage 2 call. Without the trigger, stage 2 doesn't run, and the results
say so.

## Pilot per arm

Before counted runs, on the primary engine at L 15,000 and 75,000 chunks, every filter, both modes, both callers, 20 queries per cell,
warm, plus the cold procedure on two cells. Its machine time is at most a tenth of the plan's. It must show, for each arm:

- **The part under test ran.** The harness classifies every attempt a search runs (index walk, scope scan, joined
  pooled attempt or exact fallback) from its SQL, and records per search whether a joined pooled attempt ran. Only
  joined pooled attempts are where the arms differ, so the check is on those: in arm T their captured plans show
  `enable_material = off` among the attempt's settings, and in arm C the setting at its default, with whether a
  Materialize node sits on the page join. Searches that an index walk or a scope scan answered never reach the changed
  code; the pilot counts them per cell, and a cell where no T search ran a joined pooled attempt is reported as not
  reached rather than as exposure. Where the planner picks the same plan in both arms, the pilot says so: that is a
  result, not a failure. Sanity cells show identical SQL and settings in both arms.
- **No model judge.** The primary metric is computed against exact ground truth, so there is no judge to check.
- **The units can be supplied at the planned rate.** The exact oracle agrees with the float64 brute force (above); every
  cell has its queries, and the clustered split has both halves; the projected machine hours for the counted grid fit
  the plan, or the grid is cut by a dated amendment that says what was cut.

The pilot publishes no number.

## Judge check

No model judge in stage 1: recall is measured against an exact scan of the same vectors with the same filter, which is
deterministic, so R78 doesn't apply to the primary. Stage 2, if it runs, names and checks its judge as above.

## Interim look

No look is planned. Stage 1 makes no paid model calls apart from the W embeddings, and it is a descriptive grid run once
with no stopping decision.

## Budget

Paid calls are the `voyage-4` embeddings of corpus W only, made through gbrain-evals' budget ledger
(`eval/runner/budget-ledger.ts`): each request is reserved against the run's budget before it is sent, a cap is set in
the ledger, and reaching it pauses the embedding at a batch boundary until the cap is extended; embedded batches are
cached on disk, so the run resumes where it stopped. Everything else is machine time on Ubicloud VMs, each destroyed when
its work ends. Amounts are in GST-4006, not here.

## Amendments

### 2026-11-26: the pin, the oracle's boost factor, and an affected set that is never reached

Committed on the results branch before any pilot or counted cell. It changes no arm, cell, metric or threshold.

1. **Pin.** The results branch's first commit runs `bun eval/runner/gbrain-pin.ts bump`, which moves `package.json`
   to v0.60.776.0 ([`3a360389`](https://github.com/garrytan/gbrain/tree/3a360389f152e62ccb627ab96eccfad8a9204e75)),
   the build this plan already names and still gbrain's newest release.
2. **Why the oracle's factor is 1.** "Exact ground truth" says every page's factor is 1 because `GBRAIN_SOURCE_BOOST`
   and `GBRAIN_SEARCH_EXCLUDE` are unset. That alone isn't enough: gbrain always merges its default source boosts
   (for example `originals/` 1.5, `daily/` 0.8, `archive/` 0.5) and the brain's `search.source_boosts` config, and
   always applies its default hard excludes (`test/`, `attachments/`, `.raw/`), in
   `src/core/search/source-boost.ts` at the pin. The factor is 1 because the corpus slugs (`bench/latent/p<n>` on L,
   `bench/wiki/<article id>` on W, the slugs gbrain's own `scripts/bench/hnsw-iterative-scan.ts` gives that corpus) match no prefix in the resolved boost map or hard-exclude list, the brain sets no
   `search.source_boosts`, and the two variables are unset. Before loading, the harness checks every slug against
   `resolveBoostMap()` and `resolveHardExcludes()` at the pin and refuses to run if one matches. The pilot's brute-force
   check (scores within 1e-5) still catches any factor other than 1.
3. **No reached cell.** If no realistic affected warm cell is reached (every arm-T search there was answered by an index
   walk, a scope scan or the exact fallback), latency does not improve on the realistic affected cells and the outcome
   is **Close**, reported with every cell's reached share.

Both 2 and 3 were raised by the preregistration's second review round and left open on #662 for this amendment.

### 2026-11-26: query counts after the pilot, brute-force ground truth, and a truth stop

Committed on the results branch after the pilot and before any counted cell. It changes no arm, filter, size, metric,
margin or outcome rule. Approved by the experiment's owner on GST-4006.

1. **Query counts.** The pilot passed its other checks (see "Pilot per arm"), but its projected recall half-width was
   above 0.008 in every family of the untrusted caller, on both engines it ran on, and under 0.008 in every trusted
   family. Under "Smallest detectable difference", those families rise to the rule's ceiling of 500 queries per cell at
   375,000 chunks and below and on W. At 1,500,000 chunks, where the plan set 100 queries for cost, they rise to 250,
   the same factor. That size is outside the realistic cells the outcome pools. Trusted cells keep 200 (100 at
   1,500,000), and cold cells keep 30. In clustered mode an untrusted cell draws its own 500 queries, as before. In
   independent mode the trusted cells use the first 200 queries of the same seeded set (`--queries-untrusted`).
2. **Ground truth.** "Exact ground truth" names gbrain's `exactSql` with an unbounded candidate window. At the planned
   sizes the pilot showed that query costs about as much as the timed searches it checks, and more on unselective
   filters, so most of the grid's machine time would go to it. On every pilot cell (366 cells, two engines) it agreed
   with the float64 brute force on every query, under the rule in that section (ties within 1e-6, scores within 1e-5).
   So counted cells take the brute force as their truth (`--truth brute`): each eligible page ranked by its best
   chunk's cosine with the query, over the vectors the harness loaded (generated on L, `vectors.f32` on W), with
   eligibility from the same page attributes and caller rule. `exactSql` keeps running as a check on the first 20
   queries of every cell at the cell's largest limit (`--exact-check 20`). Both results go to `oracle-check.jsonl`,
   and the recount's `truth_check` lists every checked cell.
3. **Truth stop.** If `exactSql` and the brute force disagree on any checked query, that cell stops before any
   search runs. It's written to `truth-stops.jsonl`, reported, and goes to the experiment's owner before its
   numbers count. It is never quietly re-run or dropped.
4. **Harness only.** `exactSql` now runs on its own pool of connections, so several run at once on Postgres. This
   changes no timed search and no result.

### 2026-11-27: stage 2 skipped, the order of the stage 1b look, and W's re-run corpus

Committed on the results branch before any stage 1b result was read, and before the W re-runs finished. It changes no
arm, cell, metric, margin or outcome rule. Approved by the experiment's owner on GST-4006.

1. **Stage 2 doesn't run.** Its trigger fired. On L at 375,000 chunks, the untrusted caller's cold `where` 20% cell
   ends *loss* on PostgreSQL 15, 16 and 18, and each re-run on seed 29819 agreed. The loss is not a different
   nearest-neighbour ranking. After a restart, some arm-T searches on that filter run into the 8 s budget of gbrain's
   vector pool (`const deadline = performance.now() + 8_000` in `src/core/search/vector-pool.ts` at the pin). gbrain
   then reports them incomplete (`onVectorPoolMeta`) and returns fewer than k pages. Warm, the same queries finish in
   about 0.9 s with every page, and arm C returns the same pages cold and warm. The candidate rule from stage 1 keeps
   today's plan on these cells, so measuring answer accuracy there would not change what ships. Stage 2 is skipped,
   and the cold-cache timeout is reported as a finding about gbrain in its own right: how many queries hit the budget,
   how many pages they returned, and whether gbrain's callers see the incomplete flag. A rule broadened to flip any
   untrusted `where` 20% cell reopens stage 2.
2. **Stage 1b's order.** Stage 1b's runs (L at 75,000 and 375,000 chunks, seeds 19817, 19818 and 19819, primary
   engine, every filter, both modes, both callers, limits 20 and 50, warm and cold) started before the last stage 1
   re-runs finished, so the confirmation would finish the same day. The rule is fixed from stage 1 data alone and
   committed on this branch before any stage 1b result is read. Stage 1b is recounted on its own, apart from stage 1.
3. **W's re-run corpus.** Two W cells came out *regresses* and need re-runs. W's vectors weren't kept after its run
   machines were destroyed, so the re-runs rebuild the corpus. The same prep script at the pin cuts the same shards,
   and the run stops before embedding unless `pages.tsv` and `chunks.txt` match the hashes the W runs recorded. Then
   `voyage-4` embeds the text again. The results report whether the new `vectors.f32` matches the recorded hash.
   If it doesn't, the re-run used re-embedded vectors of the same text, and the results say so beside those two cells.


### 2026-11-27: PGLite at 375,000 chunks is left out, because its HNSW index never finished building

Committed on the results branch after the PGLite 375,000-chunk runs were stopped. No cell of them ran, so no number is
dropped. It changes no other arm, cell, metric or outcome rule. Approved by the experiment's owner on GST-4006, with a
deadline of 20:00 UTC on 2026-11-27.

The plan puts PGLite on L at 15,000, 75,000 and 375,000 chunks. At 375,000 chunks (53,324 pages), gbrain's default chunk
index (`CREATE INDEX ... USING hnsw (embedding vector_cosine_ops)` from `chunkEmbeddingIndexSql` at the pin, PGLite
0.4.3) never finished building:

- Four `standard-8` machines (8 vCPU, 32 GB), one per mode and caller, loaded the corpus by about 09:15 UTC. The
  index build then ran single-threaded at 100% of one core, with about 4.7 GB resident and a 7.5 GB data directory,
  for about 10.8 hours with `maintenance_work_mem` at 1 GB (the harness's PGLite default). It didn't finish.
- One of the four was restarted at 11:10 UTC with `maintenance_work_mem` at 2 GB. That build ran for about 8.8 hours
  and didn't finish either.
- For scale, the same index on PGLite at 75,000 chunks built in 70 s, and at 15,000 chunks in 14 s, both at 1 GB.

All four machines were destroyed at 20:00 UTC. PGLite's results cover 15,000 and 75,000 chunks, and PGLite cells at
375,000 chunks are reported as not run, with this reason. The results report this as a finding about gbrain in its
own right: at the top of the size range gbrain's README gives for PGLite, its default index couldn't be built within a
working day.

### 2026-11-27: the rule stage 1b confirms

Committed on the results branch before any stage 1b result was read. It names the rule, as "Limited flip" under
"Decision rule" asks, from stage 1's cells after their re-runs. The only re-runs still out are PGLite's at 15,000 and
75,000 chunks, and those cells are on the keep side under any threshold that separates the rest. It changes no arm,
cell, metric, margin or outcome rule.

**The rule.** Turn materialization off for a filtered joined attempt when the search has a date bound (`afterDate` or
`beforeDate`), alone or with a `type` filter, and the brain holds at least 375,000 chunks (about 50,000 pages on L).
Every other search keeps today's plan.

It is the threshold that keeps every realistic *loss*, *unresolved* and *regresses* cell on the keep side, and puts the
most *improves* cells on the flip side. That is a search over filter kind (`type`, date, `where`, the combination,
small scopes), nominal share (0.1% to 50%) and size (15,000, 75,000 and 375,000 chunks). On stage 1 it covers 180
realistic affected cells: none blocks, and 69 improve. No share bound is needed. Every date and combination cell at
375,000 chunks is *safe* on recall and none *regresses*, across PostgreSQL 15 to 18 and pgvector 0.7.4 and 0.8.7. At
1,500,000 chunks the same filters are all *safe*, and none *regresses*, so the rule carries no upper size limit.

**Stage 1b's pass condition** (from "Decision rule"): on the fresh corpus (seeds 19817 to 19819, primary engine), every
cell the rule flips, meaning date and combination filters at 375,000 chunks, both modes, both callers, limits 20 and
50, warm and cold, is *safe* on recall, and none *regresses*. An *unresolved* flip-side cell fails it. The 75,000-chunk
cells are the keep side and are reported, not tested.
