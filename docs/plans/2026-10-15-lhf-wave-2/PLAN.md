<!-- gstack-autoplan-scope: --no-ui --agent-primary -->
# Low-hanging fruit wave 2: search latency, retrieval quality and cost

Status: revision 2 for autoplan review, 2026-10-15 (GBRA thread "Plan fixes for latency, retrieval, and cost").
Item 0 is already approved by Garry (2026-10-15: "OK we should go ahead and approve this flip") and committed on
branch `capy/lhf-wave-2` (`d5861ac6`, docs follow-up `9a4e54e8`). Everything else waits for the autoplan gate and
Garry's approval.

Revision 2 applies the first review round (CEO, DX and Eng, each with a Claude Opus 5.5 native voice and a GPT-6
Astra outside voice; 82 findings). It narrows the wave to changes that keep every observable result and contract
the same, and moves the contract-changing and design-heavy items to their own plans:

- Item 2 now keeps exact `LIKE` semantics through a trigram index (the reviewers reproduced saved-fact losses with
  the text-index prefilter: stopwords, slug lexemes, emails and the 200-row cap).
- Item 8 (smaller lean rows and `context_pack`) is out: `context_pack` fields and `budget_used` are frozen by
  `MEMORY_VERBS_v1`, lean-row defaults are not machine-recoverable on `query`, and the paid smoke could not decide.
- Item 4 (PGLite count) is out: as written it saves about 0 ms, because the response still waits for the count.
- Item 10 (expansion model) is out: the expansion model is also the OCR fallback and the init auto-pin, and
  expansion is now off by default (item 0), so the saving is small.
- Item 9b (year tokens in planner anchors) is out: quoted anchors are refused before the year rule runs.
- Item 5 keeps the per-request config snapshot on MCP only, the one-statement settings, concurrent response-meta
  reads and concurrent entity resolve, and adds a pool-contention gate; the post-fusion fan-out, fusion prefetch and
  the CLI snapshot are out.
- A new item G builds the gate harness first, because the existing bench could not see items 1, 2 and 7.

Inputs: three audits run on 2026-10-15 against gbrain master `3c16e9ba` (v0.60.250.0) and gbrain-evals `d744fa38`,
all keyless except about $0.02 of Haiku probes:

- unfixed product findings mined from gbrain-evals (`evals-findings.md`, 15 items),
- search hot-path latency measured on PGLite 400 / 10k pages and Postgres 16 at 20k pages, with and without a
  30 ms round-trip proxy that models a remote pooler (`latency.md`, 11 items),
- default provider spend and agent-token cost (`cost.md`, 9 items).

The audit files and the review record will be committed beside this plan in gbrain-evals
`docs/plans/2026-10-15-lhf-wave-2/`.

## Problem

The previous low-hanging-fruit wave (gbrain-evals `docs/plans/2026-10-11-low-hanging-fruit/PLAN.md`, all items
closed 2026-10-13) fixed the obvious mode and payload issues and added per-stage timings. Those timings and the
evals since then point at a second layer of cheap fixes:

1. **Typed searches are slow on Postgres.** A search with `types: ['email']` spends 542 ms in setup against 7 ms
   untyped, because the type check `SELECT DISTINCT p.type …` (`src/core/ops/search.ts:271`) JIT-compiles on
   every call (534 ms of LLVM compile for 36 ms of work). This is half of the Cat 40 Hard symptom "email-typed
   searches are 13% of searches and 44% of search time" (gbrain TODOS P2).
2. **Every MCP search scans all saved facts.** `matchingSavedFacts` (`ops/search.ts:383-430`) runs
   `LIKE ANY('%term%', …)` over every active fact: 27 ms at 10k facts, 122 ms at 50k, 203 ms at 100k
   (PGLite microbench). No index can serve it. This is the lookup gbrain-evals D4 blamed for MCP search going from
   about 140 to 200 ms after #5932. Contributor PR #6734 (@troyhoffman-oss) measured a trigram index on the exact
   match expression at 55-65 ms against about 270 ms on a production-shaped brain.
3. **Search ships about 100 full embeddings to JavaScript to compute cosine.** `cosineReScore`
   (`src/core/search/hybrid.ts:1568-1633`) is about 99% of the `fuse` stage. A prototype computing cosine in SQL
   cut PGLite median search from 86 to 62 ms (400 pages) and 244 to 209 ms (10k) with identical result order
   (40/40). Reviewers found the prototype's edge behavior differs (NaN for zero vectors, NULL for missing ones, an
   error on a dimension mismatch, where JS returns 0 per row), so the fix must preserve those semantics.
4. **Remote Postgres pays about 44 serial round trips per search.** At 30 ms RTT a search takes 1,550 ms against
   189 ms direct. Per search: 17 single-key config reads, 2 whole-table config reads, and BEGIN / `SET LOCAL` /
   `set_config` / COMMIT envelopes around 1-ms statements. #6734's per-request config snapshot alone took search
   from 1,569 to 735 ms at 30 ms RTT on the audit harness (measured on the PR's own tree, 250 commits behind master).
5. **Index migrations leave the planner without statistics.** `buildIndexOnline`
   (`src/core/schema-migrations/helpers.ts:83`) never runs ANALYZE, and PGLite has no autovacuum. On a 55k-page
   PGLite brain after v240, a 50-name `entity names` batch took 5,378 ms, and 1,200 ms after `ANALYZE pages`.
6. **Federated vector search spills to disk.** Contributor PR #6747 (@troyhoffman-oss): the vector index walk lets
   the planner materialize the whole scope's chunk-page join; on PGLite that exceeds the 4 MB `work_mem` and is
   re-read per ANN candidate. 1.3 s per search becomes 0.5 s with per-row key probes. The SQL is shared, so it also
   changes the Postgres plan.
7. **Paraphrased attendance questions never reach relationship retrieval.** Attendance matches only
   "attended"/"attendees" (`src/core/search/relational-intent.ts:170-173`), so paraphrased attendance questions
   fired 0 of 150 times in the gbrain-evals relational paraphrase split.

Two findings from the audits change the picture rather than the code. For agent tasks, gbrain's own provider
calls are about 1% of the bill (Cat 40 next-confirm P1: $1.31 of $133.59), and gbrain is already cheaper per
successful task than plain files on Opus 5.5 and Sonnet 5.5; only GPT-6.1 Sol is dearer (0.32 vs 0.24 $ on Hard
world M). The cost lever left is tool-result size, which needs a versioned contract decision and gets its own plan
(see NOT in scope).

## Implementation plan

### Goal and decision rule

Ship one wave PR that cuts search latency with no change to any observable result, plus one narrow retrieval-quality
fix. Each item is gated before it ships:

- **Performance items (1, 2, 3, 5, 6, 7) must leave every observable output the same.** Gate: the contract-parity
  harness from item G. Results and metadata must match master byte for byte after normalizing only timings and
  float scores (scores within 1e-6, order identical). An item whose parity differs does not ship until the
  difference is explained and the item is changed to remove it.
- **Each performance item must also show its gain** on the receipts named in its entry, measured on the integrated
  tree with interleaved base and branch runs. A number from another tree is labelled an estimate.
- **The quality item (9) must improve the target split without losing others.** Gate preregistered in gbrain-evals
  before the lexicon change: on `world-v1-attendees` (gbrain-evals `2026-10-06-attendance-world`) the paraphrase
  split fires relationship retrieval on at least 80% of its 150 questions (0 today) with recall@5 not lower; the
  "Who attended X?" template split is unchanged; a competing-intent split (employment, education, location
  wordings) and the relational paraphrase split have zero false attendance routes. Because the existing paraphrase
  split is development data, 30 further attendance paraphrases are written and committed before the lexicon change
  and reported separately as held out.

### Items

**0. `tokenmax` `query` no longer expands by default (approved, done).** `MODE_BUNDLES.tokenmax.expansion` is
false, so no mode expands by default; `search.expansion true` or `expand: true` restores it. Docs, skills, init
picker, tune copy, troubleshooting advice and the phrasing guard updated; BEHAVIOR_CHANGES row. Evidence: GBRA-94,
300 LongMemEval-S questions with the reranker, strict recall@10 298 vs 299 (the reference's own re-run 298),
`query` p50 2,022 to 227 ms, $0.631 per 1k queries saved. The init picker no longer claims `tokenmax` builds
per-chunk synopses (import demotes it to `title`; nothing schedules the synopsis job on default installs).

**G. Contract-parity and latency harness (lands first).** Extend `scripts/bench-refactor-wave-1.ts`:

- an order-only digest `[source_id, slug, chunk_index]` plus a score check within 1e-6, replacing the digest that
  hashes raw scores;
- a full remote-response comparison (`remote: true`, MCP dispatch path) covering result rows, saved facts,
  `type_filter_notice`, every notice block, counts, trust and visibility fields and continuation data, with only
  timings normalized;
- fixtures that exercise the items: typed queries including a missing type and a schema-pack alias, seeded saved
  facts (stopword, slug-only, email/URL, stemming, substring and >200-match cases), two federated sources, zero,
  missing and halfvec embeddings, and private/quarantined pages;
- the 30 ms delay proxy committed as a bench option (`--rtt-ms`), with statement and round-trip counts;
- a pool-contention mode: pool sizes 2 and 6, eight concurrent searches plus a small write, reporting p50/p95,
  timeouts and throughput.

The harness runs on master first; its baseline receipts are committed before any item lands.

**1. Typed-search type check without JIT.** Add a `jitOff` option to `executeRaw` (Postgres through the existing
`jitOffRead`, PGLite no-op). Check the requested types with one batched `EXISTS` over each requested type's
schema-expanded set, under the same page policy, JIT off. Only when a requested type is missing, run the existing
`SELECT DISTINCT p.type` list (also JIT off) to build the unchanged `type_filter_notice` with its "Page types in
this brain" list. Gate: parity on the typed, missing-type and alias fixtures; a Postgres E2E plan test with no
`JIT:` block on either statement. Expected: about −500 ms per typed search on Postgres with JIT on (gbrain's own
docker image), about −30 ms with JIT off.

**2. Saved-facts match through a trigram index, same semantics.** Take #6734's index: a GIN trigram index on the
exact expression the saved-fact match uses (`SAVED_FACT_HAYSTACK_SQL`, shared by the query and the index), built
`CONCURRENTLY` on Postgres, migration number taken at the merge slot. The query text is unchanged, so matching,
the newest-200 cap and the JS 75% rule are unchanged; terms shorter than three characters still scan, as today.
Not taken from #6734: moving the threshold into SQL (it changes which facts are found) and the OR-retry commit.
Gates: parity on every saved-facts fixture; an insert-cost check at 100k facts (fact insert p50 and p95 with and
without the index, PGLite and Postgres), which must stay within +25%, otherwise the item is dropped and filed; an
upgraded-brain test that the planner uses the index after item 6's ANALYZE. Expected: −25 to −200 ms per MCP
search/query on brains with 10k-100k active facts.

**3. Cosine re-score in SQL with the JavaScript semantics.** New engine method in `engine-sql/chunks.ts` returning
one float per chunk id for text-space rows: `CASE` maps zero-norm or missing vectors to NULL (treated as not
hydrated, cosine 0, the #3695 rule), a dimension mismatch is filtered before the operator so it cannot fail the
statement, the active column, current-projection filter and halfvec cast match `getEmbeddingsByChunkIds`. The
image space keeps the JS path. If the SQL statement fails, the call falls back to the existing JS path for that
search. Gate: parity on the zero, missing, halfvec, mixed-space and threshold-boundary fixtures on both engines,
including `create_safety` and evidence categories. Expected: PGLite −20 to −35 ms per search/query, Postgres −3
to −5 ms.

**5. Fewer serial round trips on remote Postgres (revise #6734).** Take from #6734, ported onto current master:

- the per-request config snapshot for MCP dispatch (one whole-table read per request; writes read live; reads
  after the request ends or on another engine fall back to per-key reads);
- one settings statement per search transaction, keeping the nested-transaction restore fix and the #6543
  statement-timeout budget literal;
- concurrent response-meta reads (safe-index probe, projection readiness, entity saved facts, saved-fact match,
  held-file coverage), each keeping its own catch;
- concurrent entity resolve;
- the off-reply `mcp_request_log` insert, with a bounded queue, a drop counter reported by doctor, and shutdown
  awaiting in-flight inserts.

Gates: parity; round-trip counts and the 30 ms RTT A/B on the integrated tree; the pool-contention mode at pool 2
and 6 must show no new timeouts and p95 no worse than master (if it regresses, cap the response-meta concurrency
and re-measure); the PR's discrimination tests, revised to exclude the dropped behaviors; the full Postgres E2E
tier. Expected at 30 ms RTT: search about 1,550 to about 800 ms (estimate from the PR tree, to be re-measured);
about −25 ms at 1-2 ms RTT; no change on PGLite. Credit "Contributed by @troyhoffman-oss", `Co-Authored-By:`
trailer, `Supersedes #6734`; the PR comment lists each dropped commit with its reason and where it is filed.
Lateness rule: if item 5 is not parity-clean and gate-green when the other items are, the wave ships without it
and item 5 follows as its own PR.

**6. Planner statistics after index migrations.** `buildIndexOnline` runs `ANALYZE <table>` after it creates or
rebuilds an index, best effort: a failure or timeout logs a warning with the command to run and never fails a
migration whose index is valid. The F4b staleness check also flags an expression index that has no `pg_stats` row
under its own name (both engines), so brains whose index is already present get their statistics on the next
maintenance pass; empty or all-null expressions do not stay flagged. Gate: an upgraded PGLite fixture with a
pre-existing v240 index gets statistics; a forced ANALYZE failure leaves the migration applied and the warning
printed. Expected (gbrain TODOS): 50-name `entity names` batch on a 55k-page PGLite brain 5.4 s to about 1.2 s.

**7. Federated vector walk with key probes (take #6747).** Per-ANN-row key probes for chunks and pages,
unchanged predicates, its plan test kept, plus a Postgres E2E plan test with the same assertions and a two-source
timing row on both engines. Credit @troyhoffman-oss, `Supersedes #6747`. Expected: PGLite federated search about
1.3 s to 0.5 s on the contributor's brain; the harness's two-source fixture gives our own number.

**9. Paraphrased attendance questions.** Add the three paraphrase forms that missed in the gbrain-evals split
("were present at", "was in the room for", "took part in", from `eval/generators/relational-paraphrase-gen.ts:43-45`)
plus "participated in" and "sat in on", each pinned by a parser test. Broader verbs
("joined", "was at", "went to") route to attendance only when the anchor resolves to a meeting or event type;
otherwise the query keeps the normal retrieval path. Negative tests assert the chosen relation and returned
evidence for employment ("who joined acme-example"), education and location wordings. BEHAVIOR_CHANGES row. Gate
as stated in the decision rule: the keyless `eval/runner/attendance-world-score.ts` and the N9 hermetic arm, plus
the paid N9 arm (about $0.13); cap $2.

**11. TODO bookkeeping.** Close with evidence: "JIT off for the remote title arm" (done by #6039), "MCP search on
Postgres slows sharply between 10k and 20k pages" (2026-10-15 nightly: 36.3 ms at 20k, 68.4 ms at 10k; add the 20k
ceiling to the scale tier). Mark #4951 mitigated-unverified. File every deferred item below with its reviewer
findings attached.

### Behavior changes

Disclosed with BEHAVIOR_CHANGES rows and in the PR body: item 0 (done) and item 9. Items 1, 2, 3, 5, 6 and 7 are
gated to produce no observable change; the new trigram index (item 2) and the bounded request-log queue (item 5)
are listed in the PR body as operational changes (index build time on upgrade, audit rows that can be dropped
under backpressure, counted by doctor).

### Measurement

Keyless (no spend): item G's harness on PGLite (400 and 10k pages) and Postgres (400 and 20k pages, direct and at
30 ms RTT, pool 2 and 6). Every item's before/after numbers go into one gbrain-evals report,
`docs/benchmarks/2026-10-16-lhf-wave-2.md`, with item 0's GBRA-94 verdict mirrored.

Paid, preregistered in gbrain-evals before any counted cell: item 9's relational splits at the wave head, cap $2.
Program cap: $5. No paid cell is rerun to change a verdict.

### Budget and sequencing

1. Item G first, on `capy/lhf-wave-2`, with master baseline receipts.
2. Two lanes with disjoint file ownership, each branching from the branch after G lands:
   - Lane S, search path (one owner, items in order 1, 3, 7, 2, 5): `src/core/ops/search.ts` and modules peeled out
     of it (type filter, saved facts), `engine-sql/*`, `vector-statement.ts`, both engines, `search-settings.ts`,
     `vector-settings.ts`, `config-snapshot.ts`, `mcp/dispatch.ts`, `serve-http*.ts`, the item 2 migration file.
   - Lane M, small items (6, 9, 11): `schema-migrations/helpers.ts`, the F4b staleness check, `relational-intent.ts`
     and its resolver guard, `TODOS.md`.
3. The integrator (this thread) alone owns `behavior-change-notice.ts`, `CHANGELOG.md`, `module-size-limits.tsv`,
   `engine-sql-baseline.tsv`, goldens and generated trees. Files at their size ceilings (`hybrid.ts`, both
   engines, `gateway.ts`) get no growth: new code goes in peeled modules.
4. Lanes run targeted suites and `ci:ubicloud:diff`; the integrator merges them, runs the harness and the paid
   item 9 gate, removes any item that fails, and only then runs the full Ubicloud gate once on the final tree. A
   later change of anything but stamps reruns the full gate.
5. One wave PR, PATCH stamped at the merge slot, handed to GBRA-40 with the accepted item set and gated tree.
6. Verdicts, including nulls, mirrored to gbrain-evals in a pushed PR.

### NOT in scope

- **Tool-result size (old item 8 and the larger levers):** lean-row default elision needs structured, per-brain
  `row_defaults` that are machine-recoverable on `query` and keep the `[gbrain dates]` labels and the
  `create_safety` guard; `context_pack` compaction needs an opt-in format or a v2 protocol decision, because v1
  freezes card fields and `budget_used`; `chunk_text` is 59% of search output and repeated searches 6.5%. One
  payload plan with a powered, preregistered Cat 40 rule.
- **PGLite keyword count (old item 4):** a skip above a page threshold with a distinct `skipped` state, preserving
  the original grace deadline, gated on the TODOS rule (under 1% unavailable, under 100 ms added p50 on the 55k slot).
- **Expansion model and rewrite count (old item 10):** Haiku 5.5 for expansion needs one resolver shared by serving
  and `gbrain models`, unchanged OCR fallback and init auto-pin rules; goes with TODO-D (`TIER_DEFAULTS`,
  `synthesize`/`think` on Opus 4.7 at $0.094 per call, other utility-tier callers). #6335 stays open as TODO-D input.
- **Post-fusion read fan-out, fusion prefetch and the CLI config snapshot (from item 5):** each needs its own
  failure-semantics and staleness design.
- **Year tokens in planner anchors (old item 9b):** needs anchor spans kept through the parser.
- Type-filtered vector search using the index walk (the second half of the email-typed symptom), a size budget for
  the `full` tool surface, Family E transcript ranking, mention links on write, H1 aggregation, proactive brief gaps,
  scoped HNSW recall, chat-key-only `tokenmax` without a reranker (needs a current measurement), query-embed
  in-flight dedupe, the PGLite timeline `stale` subquery, and #6771 (@lubosxyz, different subsystem).

### What already exists

- Stage timings: `_meta.retrieval.timings`, `--explain` (gbrain #6601); bench `scripts/bench-refactor-wave-1.ts`
  with `--backend pgbouncer` round-trip counts.
- Jit-off wrappers for search statements (#6039): `src/core/postgres-engine/search-settings.ts`, `jitOffRead`.
- Trigram indexes already in the schema (v240 `idx_pages_slug_trgm`), so `pg_trgm` is available on both engines.
- Index walk: `src/core/search/vector-statement.ts`; plan test `test/search/vector-index-walk.test.ts`.
- Relational parser and recall: `src/core/search/relational-intent.ts`, `relational-recall.ts` (`titleSeedTypes`).
- gbrain-evals harnesses: relational paraphrase runner (`2026-10-01-n9-multi-hop`), GBRA-94
  (`2026-10-14-expansion-latency/harness`).

## Review record

(filled by autoplan)

### Round-2 dispositions (binding on implementation)

Round 2 (revision 2) raised no user challenge. Its mechanical findings are accepted and bind the lanes as follows.
Where a finding offered a heavier fix and a narrower one, the narrower one is taken and the rest is filed.

- **Base.** `capy/lhf-wave-2` merges master `7f3c9f5f` (v0.60.252.0, `8e615169`) before item G; G's baselines are
  taken on that tree. Items 3 and 7 follow master's `chunkVisibleFilter` and generation probes; #6747 is ported by
  hand onto master's rewritten walk. (CEO N1, Eng N6)
- **Item G determinism.** Each arm restores a database clone from one template before every pass; implicit
  feedback learning is off; the call sequence, clock and client ids are fixed. Allowed normalizations, listed in
  the harness: timings, `answer_id` (canonicalized by position, consistently in metadata and notices),
  `how_to_rate` cadence fields, and the one-time `behavior_changes` disclosure, which is asserted separately. Write
  side effects (feedback, retrieval and request-log rows) are diffed separately. A master-against-master run must
  come back clean, and a sensitivity run with a deliberate one-row change must fail, before any item's gate counts.
  Fixtures add live, staged and retired segmented generations. The latency injector reuses the existing toxiproxy
  harness and its `--rtt` flag. TESTING.md section and a `bench:parity` script. (CEO N2, DX N5/N9, Eng N2,
  outside F3/F8)
- **Item 3 numeric rule and hydration.** Hydration presence is returned separately from cosine: hydrated zero-norm
  and dimension-mismatched vectors score 0 without evaluating the operator; absent or invisible rows stay
  unhydrated; the all-missing early return is kept. Parity compares pre-rounding values with measured tolerances
  (cosine 5e-6, score 2e-6), allows permutations only among tolerance-equal scores, re-rounds lean scores before
  comparing, and allows an evidence or `create_safety` flip only within tolerance of the 0.8 boundary, each listed
  in the receipt. The JS fallback logs once per process with the SQLSTATE and marks `_meta.retrieval`; G forces it
  once and asserts the SQL path ran otherwise. `cosineReScore` moves to `search/cosine-rescore.ts` to stay under the
  `hybrid.ts` ceiling. (CEO N3, DX N6, Eng N1/N12, outside F2)
- **Item 1 round trips.** The engine reads the server's `jit` setting once; the wrapper runs only when JIT is on,
  inside one envelope that keeps the caller's deadline, abort signal and nested restoration. Receipts cover JIT on
  and off at RTT 0 and 30 ms, hit and miss. (CEO N4, Eng N3, outside F5)
- **Item 2 evidence.** Before anything else in item 2, a receipt on master's unchanged statement at 10k, 50k and
  100k facts on both engines, with an EXPLAIN assertion that the trigram index serves it after ANALYZE; no use or
  no gain drops the item. The insert gate adds p99, max, batch throughput and search latency with a full GIN pending
  list; PGLite uses `fastupdate = off` if it spikes. An interrupted or invalid build names the index's own rebuild,
  not `request-indexes`. Item 2 lands after item 6. (Eng N4/N5, outside F2)
- **Item 5 narrowed further.** The off-reply `mcp_request_log` insert is dropped from this wave (filed): its loss
  counter would need cross-process reporting and an opt-out. Item 5 runs on its own branch from G with its own
  files and a cut-off: if it is not parity-clean and gate-green 48 hours after item 2 merges into the wave branch,
  the wave ships without it. (DX N1/N2, outside F3/F9, CEO N6, Eng N11)
- **Item 6 owners.** PGLite: `buildIndexOnline` prints the build notice and "then analyzing <table>", and
  `maybeRefreshPlannerStats` recovers present indexes. Postgres: doctor reports "expression index <name> has no
  statistics" with its own reason, and `gbrain repair planner-stats --apply` (extended to expression-index tables)
  is the recovery; this is operator-driven and documented as such. The probe runs on the maintenance path, never per
  search; G asserts no added statement per search. (DX N3/N4, Eng N7, CEO N9, outside F4/F6)
- **Item 9 narrowed.** Only unambiguous forms are added: "were present at", "was in the room for", "took part in",
  "participated in", "sat in on", and the "participants" noun frame. The broad verbs ("joined", "was at", "went
  to") and the resolver guard are dropped, so no employment, education or location wording can newly route to
  attendance. The gate is the 30 held-out paraphrases, written by someone other than the lexicon author and hashed
  before the change: at least 80% firing, recall@5 not lower, zero false routes on the competing-intent split
  measured on chosen relations and returned evidence; the development split is reported beside it. The row names
  `relational: false` and `search.relational_retrieval false`. (CEO N5/N11, outside F1/F4, Eng N13, DX N7)
- **Ownership and ceilings.** Lane S's planned files are generated from a dry run of each item's diff and include
  `hybrid.ts`, `engine.ts` and the peeled modules; `relational-recall.ts` belongs to lane M. Lanes regenerate goldens
  locally for their gates; the integrator commits generated files. The integrator raises the `engine.ts` and engine
  ceiling rows once, delegate lines only, with reasons. (CEO N7/N8, Eng N8/N10, outside F7)
- **PR body operational changes.** Item 2's index build time and measured insert p50/p95/p99 delta, and item 6's
  ANALYZE time at 55k pages. (CEO N10, DX N8, Eng N14)
