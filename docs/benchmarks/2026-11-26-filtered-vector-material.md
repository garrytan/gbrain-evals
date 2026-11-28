# Turning off materialization speeds up gbrain's date-filtered vector searches on large brains, and only there

- **We learned that turning off Postgres materialization (`enable_material = off`) makes gbrain's date-filtered vector
  searches several times faster on brains of 375,000 chunks (about 50,000 pages), with no measurable loss of
  nearest-neighbour recall.** Across PostgreSQL 15 to 18, pgvector 0.7.4 and 0.8.7, and generated and Wikipedia
  corpora, the rule below flips 180 realistic cells. None loses recall beyond a one-point margin, and none has a confirmed slowdown: 12 have p50 intervals slightly above 1 but
  under the plan's 1.1 threshold, and the one that crossed it (Wikipedia, 0.1% date, untrusted, 1.14 to 1.17) came out
  neutral on its re-run. On 1% date filters it also fixes recall for untrusted
  callers: with limit 20 on pgvector 0.8.7, the shipped plan walks the approximate vector index and returns 60% to 72% of the true top 20
  pages on generated data (85% to 87% on Wikipedia), while with materialization off the planner scores the filtered
  chunks exactly and returns all of them. Trusted callers already get all of them.
  The 69 that speed up have a median p50 of 0.11 times the shipped plan's. All of the gain goes to callers gbrain treats
  as untrusted, whose searches carry the private-page rule. A fresh corpus confirmed the rule: its 38 cells there are all safe, none regresses (5 have p50 intervals just above 1, at most 1.06), and the 17 that speed up have a median p50 of 0.12 times the shipped plan's. You should get it when gbrain ships the
  rule: date filters, alone or with a type filter, on brains of at least 375,000 chunks.
- **We learned that turning it off everywhere is the wrong call.** On brains of 75,000 chunks (about 10,000 pages),
  filters that select 20% or 50% of pages get slower, mostly `type` and frontmatter filters, and after a restart some
  date filters too. Warm, they're up to 2.3 times slower at
  p50 and 1.7 times slower at p95. After a restart they're up to 5.9 times slower at p50. This held on PostgreSQL 15 to 18 with pgvector 0.8.7 and on PGLite, and
  re-runs on fresh queries agreed. On brains of 375,000 chunks, after a restart, frontmatter filters at 20% lose 4 to 5
  points of recall because some searches run into gbrain's 8 s vector budget. You should keep today's plan for every
  search outside the rule.
- **We learned that gbrain's 8 s vector budget quietly shortens results.** With pgvector 0.7.4 at 375,000 chunks,
  every cold search in the 20% filter cells ran out the budget in both arms and returned a median of 5 of 20 pages. On
  gbrain as it ships at 1,500,000 chunks, 705 of 750 searches with a 1% date filter and limit 50 ran it out, and
  recall fell to 0.56. gbrain does flag these searches (`vector_candidates_incomplete` in the response's
  `degraded` list). You should watch for that flag, and move to pgvector 0.8 or later.

Settled call: limited flip. Turn materialization off for date-filtered vector searches, alone or with a type filter, on brains of at least 375,000 chunks, and keep today's plan for every other search; a fresh corpus confirmed it.

The study ran from November 26 to 28, 2026, under the [frozen plan and its amendments](2026-11-26-filtered-vector-material-preregistration.md).
It measured gbrain v0.60.776.0 ([`3a360389`](https://github.com/garrytan/gbrain/tree/3a360389f152e62ccb627ab96eccfad8a9204e75)),
the newest release when the first counted cell started. This is development evidence on generated and public data. No
model is called apart from `voyage-4`, which embedded the Wikipedia corpus.

## The question

gbrain answers a vector search on Postgres with one SQL statement. It joins the nearest chunks from the HNSW index to
their pages and applies the caller's filters. For statements with an index walk, gbrain already turns the planner's
`enable_material` setting off. A search narrowed by type, date, frontmatter (`where`) or a small source scope has
no index walk, so it keeps the planner's own plan. [gbrain#9817](https://github.com/garrytan/gbrain/issues/9817)
proposes turning the setting off for those searches too. This experiment measures what that does to latency and recall
before gbrain's maintainers decide.

## Results

Both arms call gbrain's own `engine.searchVector` on the same database with the same query vectors. **C** is gbrain
as it ships. **T** is the same build with `enable_material = off` for every relaxed joined statement, which is the
change #9817 describes. Recall@k is measured against the exact top k pages from a float64 brute force over the loaded
vectors. gbrain's own `exactSql` checked that brute force on the first 20 queries of every cell and agreed on every
checked query in all 1,490 stage 1 cells and all 252 stage 1b cells, so no cell stopped.

### The pooled result

Over the 1,118 realistic affected warm cells where T ran a joined attempt, T's p50 latency is **0.742 times C's (95%
interval 0.741 to 0.743)**, and its p95 is **0.800 times C's (0.797 to 0.802)**. Both are geometric means of the
per-cell ratios. Latency improves as the plan defines it, so the outcome turns on the cells that lose recall or
regress. After re-runs, 81 realistic affected cells still do. The outcome is therefore a **limited flip**: a rule that
leaves those cells on today's plan, confirmed on a fresh corpus (stage 1b, below).

### By engine, corpus and caller

Each row counts one engine, corpus and caller's affected cells: filters by `type`, date, `where`, type with date,
and source scopes of 1% and 3%.

- **Latency.** A cell *improves* when its p50 ratio's interval is below 0.90 and its p95 ratio's interval is below
  1.00. It *regresses* when its p50 ratio's interval is above 1.10 with p50 at least 5 ms slower, or when its p95 ratio
  meets the same test with a 20 ms gap.
- **Recall.** A cell is *safe* when the paired recall difference's interval stays above −0.01.

The ratio columns are geometric means over the warm cells T reached.

| engine | corpus | caller | affected cells | improves | neutral | regresses | safe | loss | unresolved | p50 T/C | p95 T/C |
|---|---|---|---|---|---|---|---|---|---|---|---|
| pg15-v087 | latent-375000 | trusted | 36 | 0 | 36 | 0 | 36 | 0 | 0 | 1.00 | 1.00 |
| pg15-v087 | latent-375000 | untrusted | 42 | 24 | 18 | 0 | 40 | 1 | 1 | 0.26 | 0.29 |
| pg15-v087 | latent-75000 | trusted | 36 | 0 | 36 | 0 | 36 | 0 | 0 | 1.00 | 1.01 |
| pg15-v087 | latent-75000 | untrusted | 42 | 6 | 25 | 11 | 42 | 0 | 0 | 0.72 | 0.88 |
| pg16-v087 | latent-375000 | trusted | 36 | 0 | 36 | 0 | 36 | 0 | 0 | 1.00 | 1.01 |
| pg16-v087 | latent-375000 | untrusted | 42 | 24 | 18 | 0 | 40 | 1 | 1 | 0.28 | 0.34 |
| pg16-v087 | latent-75000 | trusted | 36 | 0 | 36 | 0 | 36 | 0 | 0 | 1.01 | 1.02 |
| pg16-v087 | latent-75000 | untrusted | 42 | 5 | 26 | 11 | 42 | 0 | 0 | 0.75 | 0.93 |
| pg17-v074 | latent-375000 | trusted | 36 | 0 | 36 | 0 | 36 | 0 | 0 | 1.00 | 1.00 |
| pg17-v074 | latent-375000 | untrusted | 42 | 2 | 36 | 4 | 42 | 0 | 0 | 0.77 | 0.99 |
| pg17-v074 | latent-75000 | trusted | 36 | 0 | 36 | 0 | 36 | 0 | 0 | 1.00 | 1.00 |
| pg17-v074 | latent-75000 | untrusted | 42 | 6 | 36 | 0 | 42 | 0 | 0 | 0.61 | 0.95 |
| pg17-v087 | latent-15000 | trusted | 54 | 0 | 54 | 0 | 54 | 0 | 0 | 1.01 | 1.00 |
| pg17-v087 | latent-15000 | untrusted | 60 | 7 | 47 | 6 | 60 | 0 | 0 | 1.02 | 0.98 |
| pg17-v087 | latent-1500000 | trusted | 54 | 4 | 50 | 0 | 54 | 0 | 0 | 0.98 | 1.00 |
| pg17-v087 | latent-1500000 | untrusted | 60 | 17 | 43 | 0 | 60 | 0 | 0 | 0.51 | 0.52 |
| pg17-v087 | latent-375000 | trusted | 54 | 0 | 54 | 0 | 54 | 0 | 0 | 1.01 | 1.01 |
| pg17-v087 | latent-375000 | untrusted | 60 | 33 | 27 | 0 | 58 | 1 | 1 | 0.27 | 0.30 |
| pg17-v087 | latent-75000 | trusted | 54 | 0 | 54 | 0 | 54 | 0 | 0 | 1.00 | 1.01 |
| pg17-v087 | latent-75000 | untrusted | 60 | 12 | 37 | 11 | 60 | 0 | 0 | 0.71 | 0.86 |
| pg17-v087 | wiki-375000 | trusted | 54 | 0 | 54 | 0 | 54 | 0 | 0 | 1.01 | 1.01 |
| pg17-v087 | wiki-375000 | untrusted | 60 | 25 | 35 | 0 | 60 | 0 | 0 | 0.45 | 0.41 |
| pg18-v087 | latent-375000 | trusted | 36 | 0 | 36 | 0 | 36 | 0 | 0 | 1.00 | 1.01 |
| pg18-v087 | latent-375000 | untrusted | 42 | 24 | 18 | 0 | 40 | 1 | 1 | 0.30 | 0.37 |
| pg18-v087 | latent-75000 | trusted | 36 | 0 | 36 | 0 | 36 | 0 | 0 | 1.00 | 1.00 |
| pg18-v087 | latent-75000 | untrusted | 42 | 5 | 26 | 11 | 42 | 0 | 0 | 0.75 | 0.93 |
| pglite | latent-15000 | trusted | 36 | 0 | 36 | 0 | 36 | 0 | 0 | 1.00 | 1.01 |
| pglite | latent-15000 | untrusted | 42 | 5 | 28 | 9 | 42 | 0 | 0 | 1.11 | 1.08 |
| pglite | latent-75000 | trusted | 36 | 0 | 36 | 0 | 36 | 0 | 0 | 1.00 | 1.00 |
| pglite | latent-75000 | untrusted | 42 | 8 | 24 | 10 | 42 | 0 | 0 | 0.67 | 0.86 |

Three things stand out.

- **Trusted callers see no change.** All 576 realistic affected trusted cells are neutral, at every size. Without the
  private-page rule the planner doesn't build the costly materialized plan, so there is nothing to turn off.
- **The gain grows with brain size.** Take the untrusted caller's warm limit-20 filtered cells and compare median p50s.
  - At 375,000 chunks on PostgreSQL 15 to 18 with pgvector 0.8.7, C takes 304 to 359 ms and T takes 35 to 46 ms.
  - At 1,500,000 chunks, C takes 154 ms and T takes 56 ms.
  - On the Wikipedia corpus at 375,000 chunks, C takes 79 ms and T takes 46 ms.
- **At 75,000 chunks T wins most cells but loses on broad filters.** Each of PostgreSQL 15 to 18 with pgvector 0.8.7,
  and PGLite, has 10 or 11 regressing cells there, and re-runs agreed on every one. Most are `type` and `where`
  filters at 20% or 50%, warm or cold. The rest are slower at p95: cold date filters at 20% on PostgreSQL 15 to 17,
  and type with date on PostgreSQL 18. At 15,000 chunks, 6 PostgreSQL 17 cells and 9 PGLite cells regress, among them
  date filters at 20% or 50%. So date filters gain only on large brains, which is why the rule has a size floor.

### The rule

The rule we hand gbrain's maintainers is a threshold on filter kind, nominal share and brain size. It is the one that leaves every
losing, unresolved and regressing realistic cell on today's plan and moves the most improving cells to T. It was fixed
from stage 1 alone and committed before any stage 1b result was read:

> Turn materialization off for a filtered joined attempt when the search has a date bound (`afterDate` or
> `beforeDate`), alone or with a `type` filter, and the brain holds at least 375,000 chunks. Every other search keeps
> today's plan.

The grid measured `afterDate` alone and one combination, a 20% `type` filter with a 50% `afterDate` bound. The
rule's `beforeDate`, two-sided date windows and other `type` shares with a date are extrapolated from those cells, not
measured.

The rule's flip side in stage 1:

| engine | corpus | cells the rule flips | improves | loss, unresolved or regresses | lowest recall interval end | median p50 T/C of improving cells | range |
|---|---|---|---|---|---|---|---|
| pg15-v087 | latent-375000 | 26 | 12 | 0 | 0.000 | 0.10 | 0.03 to 0.60 |
| pg16-v087 | latent-375000 | 26 | 12 | 0 | 0.000 | 0.12 | 0.04 to 0.63 |
| pg17-v074 | latent-375000 | 26 | 2 | 0 | 0.000 | 0.04 | 0.04 to 0.04 |
| pg17-v087 | latent-1500000 | 38 | 13 | 0 | 0.000 | 0.04 | 0.01 to 0.78 |
| pg17-v087 | latent-375000 | 38 | 17 | 0 | 0.000 | 0.12 | 0.03 to 0.66 |
| pg17-v087 | wiki-375000 | 38 | 14 | 0 | 0.000 | 0.13 | 0.06 to 0.69 |
| pg18-v087 | latent-375000 | 26 | 12 | 0 | 0.000 | 0.11 | 0.05 to 0.62 |

Every flip-side cell is *safe*, and the lowest end of any recall interval is 0.000. On 1% date filters with limit
20 on pgvector 0.8.7, T is better for the untrusted caller: C's captured plans walk the HNSW index and return 67% to
72% of the true top 20 on L warm (60% to 68% cold, where some of PostgreSQL 15's searches also ran out gbrain's 8 s
budget) and 85% to 87% on W, while T's plans score the date-filtered chunks exactly and return all of them, warm and
cold. The trusted caller's C already returns all of them. On pgvector 0.7.4, only 2 of the
26 cells improve, because that version's searches are slow in both arms (below). At 1,500,000 chunks, which the plan
reports but doesn't pool, the same filters are all *safe* and none regresses, so the rule needs no upper size limit.

### Stage 1b: the rule on a fresh corpus

Stage 1b reran the whole grid of PostgreSQL 17 with pgvector 0.8.7 at 75,000 and 375,000 chunks on a fresh L corpus
and fresh queries (seeds 19817, 19818 and 19819): every filter, both modes, both callers, limits 20 and 50, warm and
cold. That is 252 cells, one for each stage 1 cell on that engine at those sizes. It was recounted on its own.

- **The checks passed.** The brute force agreed with `exactSql` on every checked query in all 252 cells. The sanity
  cells ran identical SQL and settings in both arms, and their pooled p50 ratio was 1.001 (0.996 to 1.007).
- **The rule passes.** All 38 cells on its flip side are *safe* on recall, and none *regresses*. 17 improve, with a
  median p50 of 0.12 times C's. The other 21 are neutral: every trusted cell, and three untrusted cells with 0.1% date
  filters.
- **The keep side looks like stage 1.** Over 211 realistic affected warm cells, T's pooled p50 is 0.665 times C's
  (0.663 to 0.666) and its p95 0.706 times (0.701 to 0.710). Fifteen cells block, all on the keep side. Two are the
  cold untrusted `type` and `where` filters at 20% and 375,000 chunks, where 5 and 9 of T's 30 searches ran out
  gbrain's 8 s budget and lost recall. The other 13 regress at 75,000 chunks: `type` and `where` filters at 20% and
  50%, and one cold date filter at 20%.

The rule's flip side in stage 1b:

| cell | recall | latency | p50 T/C | p95 T/C | recall interval low end |
|---|---|---|---|---|---|
| pg17-v087 latent 375000 clustered untrusted date-0.1 k20 warm | safe | neutral | 1.08 | 0.99 | 0.000 |
| pg17-v087 latent 375000 clustered untrusted date-1 k20 warm | safe | improves | 0.25 | 0.10 | 0.265 |
| pg17-v087 latent 375000 clustered untrusted date-5 k20 warm | safe | improves | 0.14 | 0.18 | 0.006 |
| pg17-v087 latent 375000 clustered untrusted date-20 k20 warm | safe | improves | 0.09 | 0.06 | 0.000 |
| pg17-v087 latent 375000 clustered untrusted date-50 k20 warm | safe | improves | 0.04 | 0.02 | 0.000 |
| pg17-v087 latent 375000 clustered untrusted type-20+date-50 k20 warm | safe | improves | 0.14 | 0.37 | 0.000 |
| pg17-v087 latent 375000 independent untrusted date-0.1 k20 warm | safe | neutral | 0.79 | 1.00 | 0.000 |
| pg17-v087 latent 375000 independent untrusted date-0.1 k50 warm | safe | neutral | 1.00 | 1.00 | 0.000 |
| pg17-v087 latent 375000 independent untrusted date-1 k20 warm | safe | improves | 0.29 | 0.38 | 0.284 |
| pg17-v087 latent 375000 independent untrusted date-1 k50 warm | safe | improves | 0.07 | 0.07 | 0.000 |
| pg17-v087 latent 375000 independent untrusted date-5 k20 warm | safe | improves | 0.14 | 0.11 | 0.000 |
| pg17-v087 latent 375000 independent untrusted date-5 k50 warm | safe | improves | 0.11 | 0.10 | 0.059 |
| pg17-v087 latent 375000 independent untrusted date-20 k20 warm | safe | improves | 0.08 | 0.06 | 0.000 |
| pg17-v087 latent 375000 independent untrusted date-20 k50 warm | safe | improves | 0.06 | 0.05 | 0.000 |
| pg17-v087 latent 375000 independent untrusted date-50 k20 warm | safe | improves | 0.03 | 0.03 | 0.000 |
| pg17-v087 latent 375000 independent untrusted date-50 k50 warm | safe | improves | 0.03 | 0.02 | 0.000 |
| pg17-v087 latent 375000 independent untrusted type-20+date-50 k20 warm | safe | improves | 0.12 | 0.10 | 0.000 |
| pg17-v087 latent 375000 independent untrusted type-20+date-50 k50 warm | safe | improves | 0.63 | 0.77 | 0.007 |
| pg17-v087 latent 375000 independent untrusted date-1 k20 cold | safe | improves | 0.25 | 0.25 | 0.208 |
| pg17-v087 latent 375000 independent untrusted date-20 k20 cold | safe | improves | 0.62 | 0.50 | 0.000 |
| pg17-v087 latent 375000 clustered trusted date-0.1 k20 warm | safe | neutral | 0.98 | 0.99 | 0.000 |
| pg17-v087 latent 375000 clustered trusted date-1 k20 warm | safe | neutral | 1.00 | 1.00 | 0.000 |
| pg17-v087 latent 375000 clustered trusted date-5 k20 warm | safe | neutral | 1.02 | 0.98 | 0.000 |
| pg17-v087 latent 375000 clustered trusted date-20 k20 warm | safe | neutral | 1.00 | 1.03 | 0.000 |
| pg17-v087 latent 375000 clustered trusted date-50 k20 warm | safe | neutral | 0.98 | 0.99 | 0.000 |
| pg17-v087 latent 375000 clustered trusted type-20+date-50 k20 warm | safe | neutral | 1.03 | 0.99 | 0.000 |
| pg17-v087 latent 375000 independent trusted date-0.1 k20 warm | safe | neutral | 1.01 | 1.02 | 0.000 |
| pg17-v087 latent 375000 independent trusted date-0.1 k50 warm | safe | neutral | 1.01 | 0.99 | 0.000 |
| pg17-v087 latent 375000 independent trusted date-1 k20 warm | safe | neutral | 1.01 | 0.98 | 0.000 |
| pg17-v087 latent 375000 independent trusted date-1 k50 warm | safe | neutral | 1.01 | 1.00 | 0.000 |
| pg17-v087 latent 375000 independent trusted date-5 k20 warm | safe | neutral | 1.04 | 1.01 | 0.000 |
| pg17-v087 latent 375000 independent trusted date-5 k50 warm | safe | neutral | 0.99 | 1.01 | 0.000 |
| pg17-v087 latent 375000 independent trusted date-20 k20 warm | safe | neutral | 0.99 | 1.00 | 0.000 |
| pg17-v087 latent 375000 independent trusted date-20 k50 warm | safe | neutral | 1.01 | 1.00 | 0.000 |
| pg17-v087 latent 375000 independent trusted date-50 k20 warm | safe | neutral | 1.00 | 1.02 | 0.000 |
| pg17-v087 latent 375000 independent trusted date-50 k50 warm | safe | neutral | 1.00 | 1.00 | 0.000 |
| pg17-v087 latent 375000 independent trusted type-20+date-50 k20 warm | safe | neutral | 1.02 | 1.05 | 0.000 |
| pg17-v087 latent 375000 independent trusted type-20+date-50 k50 warm | safe | neutral | 1.02 | 1.00 | 0.000 |

### Cells that lose recall, stay unresolved or regress

Every cell that came out *loss* or *regresses* was re-run once on fresh queries (seed 29819). A cell keeps that state
only when its re-run agrees. When the re-run disagrees, the cell takes the re-run's state, and both are reported. Of
the 93 re-runs, 77 agreed, and 16 regressions went away. The full list is in
[`tables.md`](2026-11-26-filtered-vector-material/tables.md#re-runs).

| engine | brain size (chunks) | loss | unresolved | regresses, warm | regresses, cold |
|---|---|---|---|---|---|
| PostgreSQL 15, pgvector 0.8.7 | 375,000 | 1 | 1 | 0 | 0 |
| PostgreSQL 15, pgvector 0.8.7 | 75,000 | 0 | 0 | 8 | 3 |
| PostgreSQL 16, pgvector 0.8.7 | 375,000 | 1 | 1 | 0 | 0 |
| PostgreSQL 16, pgvector 0.8.7 | 75,000 | 0 | 0 | 8 | 3 |
| PostgreSQL 17, pgvector 0.7.4 | 375,000 | 0 | 0 | 4 | 0 |
| PostgreSQL 17, pgvector 0.8.7 | 375,000 | 1 | 1 | 0 | 0 |
| PostgreSQL 17, pgvector 0.8.7 | 75,000 | 0 | 0 | 8 | 3 |
| PostgreSQL 17, pgvector 0.8.7 | 15,000 | 0 | 0 | 6 | 0 |
| PostgreSQL 18, pgvector 0.8.7 | 375,000 | 1 | 1 | 0 | 0 |
| PostgreSQL 18, pgvector 0.8.7 | 75,000 | 0 | 0 | 9 | 2 |
| PGLite 0.4.3 | 75,000 | 0 | 0 | 8 | 2 |
| PGLite 0.4.3 | 15,000 | 0 | 0 | 9 | 0 |
| **Total** | | **4** | **4** | **60** | **13** |

Every *loss* and *unresolved* cell is a cold `type` or `where` filter at 20% for the untrusted caller, and every
*regresses* cell is below 375,000 chunks or on pgvector 0.7.4. None is on the rule's flip side. Each cell is listed in
[`tables.md`](2026-11-26-filtered-vector-material/tables.md#cells-that-lose-stay-unresolved-or-regress).

## gbrain's 8 s vector budget on cold caches

The plan's amendment asks for this to be reported as a finding in its own right. gbrain's vector pool gives each search
8 s (`const deadline = performance.now() + 8_000` in `src/core/search/vector-pool.ts`). A search that hasn't
filled its limit by then returns what it has and is flagged incomplete. Callers of gbrain's search operation see this
as a `vector_candidates_incomplete` entry in the response's `degraded` list, with reason `timeout`, and the CLI
prints it as an incomplete-results notice. This harness reads the same flag through `onVectorPoolMeta`.

| cell | C incomplete | T incomplete | C pages (median, incomplete) | T pages (median, incomplete) | recall C | recall T | recall state |
|---|---|---|---|---|---|---|---|
| pg17-v074 latent 375000 clustered untrusted scope-50 k20 warm | 0 of 1500 | 1 of 1500 | n/a | 10 | 0.994 | 0.993 | safe |
| pg17-v074 latent 375000 independent untrusted type-20 k20 cold | 30 of 30 | 30 of 30 | 5 | 5 | 0.235 | 0.235 | safe |
| pg17-v074 latent 375000 independent untrusted date-20 k20 cold | 30 of 30 | 30 of 30 | 5 | 5 | 0.237 | 0.237 | safe |
| pg17-v074 latent 375000 independent untrusted where-20 k20 cold | 30 of 30 | 30 of 30 | 5 | 5 | 0.220 | 0.220 | safe |
| pg17-v087 latent 1500000 clustered untrusted type-20+date-50 k20 warm | 3 of 750 | 0 of 750 | 19 | n/a | 0.947 | 0.947 | safe |
| pg17-v087 latent 1500000 independent untrusted date-1 k50 warm | 705 of 750 | 0 of 750 | 38 | n/a | 0.560 | 0.982 | safe |
| pg17-v087 latent 1500000 independent untrusted type-20+date-50 k20 warm | 49 of 750 | 0 of 750 | 17 | n/a | 0.902 | 0.918 | safe |
| pg17-v087 latent 375000 independent untrusted type-20 k20 cold | 0 of 30 | 2 of 30 | n/a | 17 | 0.955 | 0.937 | unresolved |
| pg17-v087 latent 375000 independent untrusted where-20 k20 cold | 0 of 30 | 5 of 30 | n/a | 15 | 0.953 | 0.912 | loss |
| pg15-v087 latent 375000 independent untrusted date-1 k20 cold | 5 of 30 | 0 of 30 | 12 | n/a | 0.602 | 1.000 | safe |
| pg15-v087 latent 375000 independent untrusted type-20 k20 cold | 0 of 30 | 3 of 30 | n/a | 17 | 0.932 | 0.913 | unresolved |
| pg15-v087 latent 375000 independent untrusted where-20 k20 cold | 0 of 30 | 5 of 30 | n/a | 17 | 0.958 | 0.918 | loss |
| pg16-v087 latent 375000 independent untrusted type-20 k20 cold | 0 of 30 | 3 of 30 | n/a | 17 | 0.928 | 0.908 | unresolved |
| pg16-v087 latent 375000 independent untrusted where-20 k20 cold | 0 of 30 | 5 of 30 | n/a | 16 | 0.953 | 0.905 | loss |
| pg17-v074 latent 375000 independent untrusted date-1 k20 cold | 30 of 30 | 3 of 30 | 0 | 11 | 0.008 | 0.957 | safe |
| pg18-v087 latent 375000 independent untrusted type-20 k20 cold | 0 of 30 | 3 of 30 | n/a | 17 | 0.907 | 0.887 | unresolved |
| pg18-v087 latent 375000 independent untrusted where-20 k20 cold | 0 of 30 | 5 of 30 | n/a | 14 | 0.928 | 0.877 | loss |
| pg17-v087 wiki 375000 independent untrusted type-20 k20 cold | 0 of 30 | 1 of 30 | n/a | 19 | 0.985 | 0.983 | safe |

The table shows four cases.

- **Cold `where` and `type` filters at 20%, PostgreSQL 15 to 18, 375,000 chunks.** After a restart, 2 to 5 of each
  cell's 30 T searches ran out the budget at about 8,015 ms. They returned a median of 14 to 17 pages instead of 20. C
  finished every search. Warm, the same queries take about 0.9 s in T and return every page. These are the four *loss*
  and four *unresolved* cells. The re-runs of the *loss* cells found 7 to 9 incomplete T searches each. The rule keeps
  today's plan on all of them. Under the plan's amendment of 2026-11-27, a rule broadened to flip any untrusted
  `where` 20% cell reopens stage 2.
- **pgvector 0.7.4, 375,000 chunks, cold.** Every search in the cold 20% cells ran out the budget in both arms. They
  returned a median of 5 pages, for recall of about 0.23 in both arms. In the cold 1% date cell, all 30 of C's searches ran
  out the budget: 25 returned no pages and 5 returned one (recall 0.008). Only 3 of T's did, returning a median of 11 pages, and T's recall was
  0.957.
- **Cold 1% date filter, PostgreSQL 15, 375,000 chunks.** 5 of C's 30 searches ran out the budget and returned a
  median of 12 pages, so C's recall was 0.60. T finished every search, with recall 1.00. This cell is on the rule's
  flip side.
- **gbrain as it ships, 1,500,000 chunks, warm.**
  - With a 1% date filter and limit 50, 705 of C's 750 searches ran out the budget. They returned a median of 38 pages,
    for recall of 0.56. T finished every search, with recall 0.98.
  - With type and date together, 49 of C's 750 searches ran it out.

## pgvector 0.7.4 is several times slower for untrusted filtered searches

gbrain accepts pgvector 0.7 and newer, and 0.7.4 has no iterative index scans. Compare C's median p50 over the warm limit-20
filtered cells on PostgreSQL 17, with pgvector 0.7.4 and then 0.8.7:

| Brain size | Caller | pgvector 0.7.4 | pgvector 0.8.7 |
|---|---|---|---|
| 375,000 chunks | untrusted | 1,525 ms | 328 ms |
| 375,000 chunks | trusted | 291 ms | 34 ms |
| 75,000 chunks | untrusted | 364 ms | 77 ms |

On 0.7.4, the warm 20% and 50% cells take 2.8 to 6.3 s per search in both arms. Turning materialization off doesn't
fix this. It makes four 0.7.4 cells worse at p95: clustered `where` and `type` at 5%, and both 3% scopes. A brain
on pgvector 0.7 should move to 0.8 before anything else.

## PGLite at 375,000 chunks: the default index never finished building

The plan puts PGLite at 15,000, 75,000 and 375,000 chunks. At 375,000 chunks (53,324 pages), gbrain's default chunk
index (`CREATE INDEX ... USING hnsw (embedding vector_cosine_ops)` on PGLite 0.4.3) never finished building.

- Four `standard-8` machines ran the build. Each ran single-threaded, at 100% of one core.
- Three ran with `maintenance_work_mem` at 1 GB for about 10.8 hours. One ran with 2 GB for about 8.8 hours.
- The same index built in 70 s at 75,000 chunks and in 14 s at 15,000 chunks.

A [dated amendment](2026-11-26-filtered-vector-material-preregistration.md#2026-11-27-pglite-at-375000-chunks-is-left-out-because-its-hnsw-index-never-finished-building)
leaves those cells out, so PGLite's results cover 15,000 and 75,000 chunks. gbrain's README gives about 50,000 pages as
PGLite's range, so a brain near the top of that range may not be able to build its own default index in a working day.
gbrain's maintainers have the details.

## What else the data shows

- **The sanity checks passed on every engine and version.** These are the cells where both arms run the same SQL by
  construction: no filter, and a 50% source scope.
  - The captured attempts had identical SQL and settings in both arms.
  - The arms returned the same ordered pages for at least 99.8% of queries.
  - The pooled p50 ratio's interval fell inside 0.95 to 1.05 on each engine and version. It ranged from 0.960 to 0.975
    on PostgreSQL 18 to 1.006 to 1.020 on pgvector 0.7.4.
- **The plans show the mechanism.** Take the 1,120 warm cells filtered by `type`, date, `where` or both where T ran
  a joined attempt.
  - In 766 of them, C's captured joined attempts contain a Materialize node and T's don't.
  - In 15, both arms' plans contain one.
  - In 339, neither arm's plan contains one.

  Every cell's plan summary is in [`cells.md`](2026-11-26-filtered-vector-material/recount/cells.md), and the full
  plans are in each run's `plans.jsonl`.
- **A later gbrain release changes the code around this predicate.** gbrain v0.60.778.0
  ([#10507](https://github.com/garrytan/gbrain/pull/10507)) doesn't change either arm on the cells measured here,
  because it touches only statements with an index walk. But at 778, the same condition also turns `enable_sort` off
  and sends short windows straight to the exact fallback. A flip on 778 or later should therefore extend only
  `enable_material` to the relaxed statements. Applying this experiment's predicate as written would be a different
  treatment, and it would need its own measurement.

## How it works

- **Corpora.**
  - L is gbrain's own planner bench generator (`scripts/bench/hnsw-latent-corpus.ts` at the pin): 1024 dimensions,
    seed 9817, at 15,000, 75,000, 375,000 and 1,500,000 chunks (2,200 to about 200,000 pages), with 10% of pages
    private.
  - W is English Wikipedia (`wikimedia/wikipedia`, `20231101.en`), cut into 375,000 chunks by gbrain's
    `scripts/bench/hnsw-real-corpus-prep.py` and embedded with `voyage-4`. Its text and vectors aren't committed;
    the runs record their hashes (`pages.tsv` `deaa312f`, `chunks.txt` `7c3355b4`, `vectors.f32`
    `d9f50fc5`). W was rebuilt for its two re-runs, and the rebuilt files hashed the same.
- **Filters.** `type`, `afterDate` and `where: { fv_tag }`, each at 0.1%, 1%, 5%, 20% and 50% of pages, plus
  `type` 20% with `afterDate` 50%, and source scopes of 1% and 3%. Two sanity cells run no filter and a 50% scope.
  Every filter runs in two modes: independent of the vectors, and clustered with them, so that it selects whole regions
  of vector space.
- **Callers.** A trusted caller, and an untrusted one (`excludePrivate: true`).
- **Queries.**
  - Each trusted cell has 200 queries and each untrusted cell has 500, at 375,000 chunks and below and on W. At
    1,500,000 chunks the counts are 100 and 250.
  - Each warm query runs once per arm untimed, then three timed repeats with alternating arm order.
  - Cold cells run 30 queries. Each one runs after a Postgres restart, a dropped page cache and a fresh engine.
- **Engines.** Each run's `manifest.json` pins its Postgres image by digest.
  - PostgreSQL 17 with pgvector 0.8.7 runs every size, on `standard-16` machines.
  - PostgreSQL 15, 16 and 18 with pgvector 0.8.7, and PostgreSQL 17 with pgvector 0.7.4, run 75,000 and 375,000
    chunks, on `standard-8` machines.
  - PGLite 0.4.3 runs 15,000 and 75,000 chunks.
- **Harness commits.** The counted runs used `eval/runner/filtered-vector/` at three versions on this branch.
  - `0559c376` adds the brute-force truth.
  - `875020d4` holds the brute force's vectors in segments, so 1,500,000 chunks fit in memory. This changes nothing
    below 2^18 chunks.
  - `8f674b62` mounts PostgreSQL 18's data where its image expects it.

  The L runs on PostgreSQL 17 at 15,000 to 375,000 chunks started at `0559c376`, and the rest at `875020d4` or
  later. Runs started after the plan's amendments record the amendment commits, which change no harness file. None of
  the commits changes a timed search, and each run records its commit.

## Reproduce and inspect

The raw rows of every counted run are in [`runs/`](2026-11-26-filtered-vector-material/runs), one `.tar.zst` per
run directory. Unpack them and recount from the repository root:

```bash
mkdir -p /tmp/fv && for f in docs/benchmarks/2026-11-26-filtered-vector-material/runs/*.tar.zst; do n=$(basename "$f" .tar.zst); mkdir -p "/tmp/fv/$n" && zstd -dc --long=27 "$f" | tar xf - -C "/tmp/fv/$n"; done
bun eval/runner/filtered-vector/recount.ts --out /tmp/fv-recount --resamples 10000 $(ls -d /tmp/fv/*/ | grep -v -e '-rr-' -e '/s1b-') $(ls -d /tmp/fv/*-rr-*/ | sed 's/^/--rerun /')
bun eval/runner/filtered-vector/recount.ts --out /tmp/fv-recount-1b --resamples 10000 $(ls -d /tmp/fv/s1b-*/)
bun eval/runner/filtered-vector/tables.ts --recount /tmp/fv-recount --stage1b /tmp/fv-recount-1b $(ls -d /tmp/fv/*/ | grep -v /s1b-)
```

The stage 1 recount takes about 90 minutes on one core at 10,000 resamples. Its output is committed in
[`recount/`](2026-11-26-filtered-vector-material/recount), and stage 1b's, which takes about 16 minutes, in
[`recount-1b/`](2026-11-26-filtered-vector-material/recount-1b).

- `summary.json` holds the decision, truth check and sanity checks.
- `cells.json.gz` (the recount's `cells.json`, gzipped) and `cells.md` hold every cell.
- [`tables.md`](2026-11-26-filtered-vector-material/tables.md) holds every table on this page, printed by
  `tables.ts`. Its "Figures in the prose" section also prints the warm medians, the flip-side cells whose p50
  interval lies above 1 and the incomplete searches that returned at most one page.

To run a cell yourself, use `eval/runner/filtered-vector/run.ts`, and set up the machine with
`scripts/ubicloud/filtered-vector-setup.sh`. Each run's `manifest.json` records its image digest, commits and
Postgres settings.

## Disclosures

gbrain is Garry Tan's own project.

## Changelog

### 2026-11-28: Results

First version: the stage 1 grid with its re-runs, stage 1b, the cold-cache budget finding, pgvector 0.7.4's latency
and PGLite's 375,000-chunk index.
