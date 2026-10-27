INPUT: ceo 2ea3b35280d7f37a6d2ac5843bc6089f3c3ac7b02ffd288e073cbb190c36810c

# CEO review, round 2 (native voice): LHF wave 2, revision 2

Reviewer: Capy subagent on anthropic/claude-opus-5-5 (high). Machine check: `gstack: ok 1.91.101.0 for=autoplan`
(same machine as round 1). This was a read-only review with no provider spend; the only probes were keyless PGLite
runs from local audit notes (not committed). The checkout is untouched (`git status` is clean). The branch is at
`9a4e54e8`, which is master `3c16e9ba` plus item 0 and its docs follow-up. **origin/master has since moved to
`7f3c9f5f` (v0.60.252.0, 109 commits).**

## Verdict

Revision 2 is a better plan. It narrows the wave to latency work that changes no output, plus one quality fix, and
that is the right scope. It drops every item whose gate could not be made honest (4, 8, 9b, 10). It takes the
trigram index, which keeps exact `LIKE` semantics, and it puts a contract-parity harness in front of all of it.

I tested item 2's central premise directly. In PGLite, at 100k facts, master's unchanged `LIKE ANY` statement uses a
GIN trigram index through a bitmap index scan. The query dropped from 149 to 1.9 ms when no fact matches, and from
252 to 6.8 ms on common terms with 200 rows returned (local audit notes (not committed)).

Five problems remain, and none of them is a direction change.

1. **The plan is written against a master that no longer exists.** Master's Wave B (segmented storage) changed the
   exact predicates items 3 and 7 must match (`chunkVisibleFilter`, `chunkGenerationProbe`), took migration v248, and
   moved both engines' size ceilings.
2. **Item G's "only timings normalized" rule will report differences on unchanged code.** Each call mints a random
   `answer_id`. The rate-prompt cadence depends on a per-client counter. Implicit feedback can change ranking state
   between calls. The once-per-session behavior-change disclosure differs between master and the wave because of
   items 0 and 9.
3. **Item 1's JIT-off wrapper adds three round trips to every typed search.** On a remote database that already runs
   with JIT off, that is a latency regression.
4. **Item 3's byte-parity rule doesn't fit float math.** Two outputs can flip on a last-bit difference: lean rows
   print scores at 4 significant digits, and `high_vector_match` is a threshold at cosine 0.8.
5. **Item 9's gating split is circular.** The lexicon adds exactly the three wordings that split uses, and the
   held-out paraphrases have no pass bar.

## Round-1 findings: status

| Round 1 | Status in revision 2 | Note |
|---|---|---|
| F1 bench blind to items 1, 2, 4, 7 | **Resolved** by item G | New issues with G in N2 and N3 |
| F2 FTS semantics / trigram dismissed | **Resolved**: trigram, same query text | Confirmed in PGLite (above) |
| F3 lane overlap, prefetch dependency | **Resolved**: two lanes, prefetch dropped | Lane S's file list is incomplete (N7) |
| F4 item 8 gate underpowered | **Moot**: item 8 deferred | Deferred to its own powered plan |
| F5 trailer can't carry defaults | **Moot** | The NOT-in-scope entry names structured `row_defaults` |
| F6 lexicon missed measured forms, ambiguous verbs | **Resolved** | Gate is circular (N5) |
| F7 quoted titles refused before year rule | **Moot**: 9b deferred | — |
| F8 OCR rides on expansion model | **Moot**: item 10 deferred, OCR named | — |
| F9 pool 2 for Supavisor users | **Resolved**: pool 2/6 contention gate | — |
| F10 CLI snapshot staleness | **Resolved**: CLI snapshot dropped | — |
| F11 item 4 saving overstated | **Moot**: item 4 deferred | — |
| F12 ANALYZE could wedge migrations | **Resolved**: best effort, forced-failure test | Item 6 needs a per-search round-trip check (N9) |
| F13 lateness rule | **Partly resolved** | The trigger can't fire as worded (N6) |
| F14 smoke base mismatch | **Moot** | — |
| F15 larger payload levers | **Partly resolved**: named in NOT in scope; item 11 files deferred items with findings | — |
| F16 `budget_used` semantics | **Moot** | — |
| F17 EXISTS over expanded types | **Resolved** | — |
| F18 numbers | **Moot** | — |
| F19 request-log loss | **Resolved**: bounded queue, drop counter, shutdown await | — |

## 1. Right problem? Reframing?

Yes. The value in this revision sits in four items:
- item 5, remote round trips, about −750 ms per search at 30 ms RTT (an estimate);
- item 1, typed search on JIT-on Postgres, −500 ms;
- item 6, the entity-names batch at 55k pages, 5.4 s to 1.2 s;
- item 2, −25 to −200 ms on every MCP search on brains with many facts. My probe supports this.

Items 3 and 7 are smaller, solid wins.

Deferring tool-result size is the right call. Each of its gates needed a protocol decision or a powered eval, and
item 11 files the deferred items with the findings attached, so the next plan starts with evidence.

Item G is the long-term asset. A contract-parity harness that runs on master makes every later performance wave
cheaper to gate, so it is worth getting right (N2, N3).

## 2. Premises

### Premise table (REALITY: premise-table)

| Premise | Receipt | Verdict |
|---|---|---|
| Unchanged `LIKE ANY` statement uses a GIN trigram index | PGLite probe at 100k facts: Bitmap Index Scan on the trigram index, 149→1.9 ms and 252→6.8 ms (`trgm.ts`) | **verified** |
| pg_trgm available on both engines | v240 `idx_pages_slug_trgm` (`src/core/schema-migrations/v240-*.ts:21`); PGLite bundles `pg_trgm.tar.gz` (`src/core/pglite-embedded-asset-paths.ts:32`) | verified |
| Item 3 matches `getEmbeddingsByChunkIds`' "current-projection filter" | On master `7f3c9f5f`, that function filters with `chunkVisibleFilter('p','cc')`, not `currentTextProjectionFilter` (`engine-sql/chunks.ts`, read via the GitHub API) | **stale**: master changed (N1) |
| #6747 applies to the current walk | master `7f3c9f5f` added `chunkGenerationProbe('cc')` and a split chunk/page visibility clause to `vector-statement.ts` | still MERGEABLE on GitHub, but must be re-verified against the new predicates (N1) |
| Migration number at the merge slot | master took v248 (`v248-segmented-page-storage.ts`) | fine per the rules |
| Only timings vary between identical runs | `mintAnswerId()` on every rateable answer (`src/core/feedback/record.ts:204`); `how_to_rate` depends on the `answersSinceHint` per-client counter (`:218-220`); implicit "cited" learning enqueues ranking updates (`:212-214`) | **false** (N2) |
| JIT-off typed check costs one statement | `jitOffRead` = BEGIN, `SET LOCAL jit = off`, query, COMMIT (`src/core/postgres-engine.ts:371-373`, `search-settings.ts:24-30`) | **4 round trips** (N4) |
| SQL cosine can be byte-identical | JS accumulates in float64 (`hybrid.ts` `cosineSimilarity`); pgvector accumulates in float32; lean scores print at 4 significant digits (`src/core/search/lean-rows.ts:63`); `DEFAULT_HIGH_COSINE_FLOOR = 0.8` (`src/core/search/evidence.ts:63`) | **not guaranteed** (N3) |
| A missing or zero vector maps to "not hydrated, cosine 0" | JS returns the raw, un-blended results only when no vector hydrated at all (`hybrid.ts:1604`); a zero-norm vector counts as hydrated in JS | edge case (N3) |
| Attendance gate measures generalization | the plan adds exactly the split's three forms (`relational-paraphrase-gen.ts:43-45`); the held-out 30 have no bar | **circular** (N5) |
| "No growth" on files at their size ceiling | `postgres-engine.ts` is 3,060 lines, exactly at its ceiling (`scripts/module-size-limits.tsv:24`); items 1 and 3 need engine members | conflicts (N8) |

`unverified=0`.

### Reality rows

- REALITY: premise-table: 11 premises; 2 verified, 5 false or stale, 4 conditional (receipts in the table above).
- REALITY: already-done: none of items 1-11 is on origin/master `7f3c9f5f`. The 109 new commits touch
  `engine-sql/chunks.ts`, `engine.ts`, both engines, `vector-statement.ts`, `relational-recall.ts` and
  `module-size-limits.tsv` (GitHub compare `3c16e9ba...7f3c9f5f`). The wave branch has not merged them.
- REALITY: surface-check: these files exist: `scripts/bench-refactor-wave-1.ts`,
  `src/core/postgres-engine/search-settings.ts`, `src/core/engine-sql/chunks.ts`,
  `src/core/search/relational-recall.ts` (`titleSeedTypes` at `:131-133`), gbrain-evals
  `eval/runner/attendance-world-score.ts` and `eval/runner/n9-multi-hop-paraphrase.ts`. These bench flags and
  `executeRaw` options do not exist yet: `--rtt-ms`, pool-contention mode, and the `jitOff` option on `executeRaw`.
  All of them are new work in item G or item 1.
- REALITY: binding-decisions: the plan has no `## Binding decisions` section, and branch decision search returned
  nothing. Item 0 carries Garry's approval of 2026-10-15 in `d5861ac6`.
- REALITY: numbers: these numbers are measured:
  - item 2's gain, by my probe in PGLite (`[measured: trgm.ts, synthetic 16-word facts]`);
  - item 1's 500 ms (`[measured: audit-latency pg20k]`).

  Item 5's ~800 ms is labelled an estimate, which is correct. Every baseline needs re-measuring on a tree that
  contains master `7f3c9f5f`.
- REALITY: deferred-asks: items 4, 8, 9b and 10, the post-fusion fan-out, fusion prefetch and the CLI snapshot are
  each listed under NOT in scope with a reason, and item 11 files them with findings. Nothing is silently dropped.
- REALITY: pr-count: one wave PR (`.gstack/ship-policy.json`, `stamp-at-merge`). Item 5 can split into its own PR
  under the lateness rule.

## 3. Six-month regret scenarios

- **Item G gets loosened by hand.** Its first run on unchanged code shows diffs in `answer_id`, `how_to_rate` and the
  disclosure block, so people add normalizations ad hoc until it stops catching real changes (N2).
- **Item 3 is waived.** A 1e-7 cosine difference flips a printed 4th significant digit or a `high_vector_match` at
  0.8. The "byte for byte" rule then forces a waiver nobody wrote down (N3).
- **Parity is checked against the old master.** Receipts and baselines are taken on `3c16e9ba`, then master's
  segmented-storage visibility rules arrive at merge time. Item 3's SQL is written to the old predicate, and the
  wave's parity claims no longer describe what ships (N1).
- **Typed searches get slower for Supabase users.** Their remote JIT-off databases are what the first install path
  recommends at 1,000+ files, and they would see typed searches 50-90 ms slower (N4).
- **Item 9 looks like a big win and isn't.** It reports 100% firing on the split it was written to, while real
  paraphrases outside those three forms still miss (N5).

## 4. Alternatives not weighed

- **Item 1: run the batched EXISTS without the JIT-off transaction.** An EXISTS with `LIMIT 1` on an indexed
  `p.type` should cost far below `jit_above_cost`, so it doesn't need the wrapper. Keep JIT off only for the rare
  DISTINCT on the missing-type path, and assert "no `JIT:` block" with JIT on in the E2E plan test (N4).
- **Item 3: avoid byte parity on floats.** Either compare full rows before rounding with a stated 1e-6 rule, or keep
  the floating-point arithmetic identical by returning the vectors only for rows whose cosine is near a threshold.
  The first is simpler, so state the rule in the decision rule (N3).

## 5. Competitive and contributor risk

Low. Contributor credit and `Supersedes` lines for #6734 and #6747 are kept, and the PR comment for #6734 lists each
dropped commit and where it is filed. That is good contributor hygiene.

#6747 should still land even if item 5 slips. The lateness rule already allows that, because item 7 is ordered
before item 5 in lane S.

## Error and failure modes (for the registries)

- **Item 3:** the SQL statement fails and falls back to JS for that search. Watch for a Postgres statement failure
  inside an outer transaction: a fallback inside an aborted transaction would also fail. Confirm `cosineReScore`
  never runs inside the caller's transaction.
- **Item 2:** the index build fails or is slow on upgrade (CONCURRENTLY on Postgres, inline on PGLite). On fact
  inserts, GIN pending-list flushes show up at p95, which the insert gate measures.
- **Item 6:** ANALYZE fails or times out and only warns (covered). The new staleness probe must not add a statement
  to every search (N9).
- **Item 5:** a response-meta read rejects and its own catch keeps it (stated). If several reads reject together,
  which error surfaces may differ from serial order; the parity harness should include a forced-failure case.

## NOT in scope / What already exists

NOT in scope is complete and gives a reason for each entry. What already exists is accurate, with three exceptions:
the projection-filter reference (now `chunkVisibleFilter` on master), the size ceilings, and the walk predicates.
All three changed on master after the plan was written.

```gstack-findings
{"id":"N1","severity":"High","title":"The plan is written against 3c16e9ba, but master is now 7f3c9f5f (v0.60.252.0, 109 commits of segmented storage) and changes the predicates items 3 and 7 must match","file":"src/core/engine-sql/chunks.ts","fix":"Merge current master into capy/lhf-wave-2 (merge commit) before item G, and take G's baseline receipts on that tree. Item 3's SQL cosine must use master's chunkVisibleFilter('p','cc'). Re-verify #6747's key probes against the new chunkGenerationProbe and split visibility clause in vector-statement.ts, adding a segmented-page fixture to G. Re-read the size ceilings in module-size-limits.tsv after the merge."}
{"id":"N2","severity":"High","title":"Item G's 'only timings normalized' rule will report differences on unchanged code: a random answer_id per call, a per-client how_to_rate cadence, implicit cited-feedback learning, and a behavior-change disclosure that differs between master and the wave","file":"src/core/feedback/record.ts","line":204,"fix":"List the allowed normalizations up front (timings, answer_id, how_to_rate presence, the one-time behavior_changes disclosure block). Run each arm on a fresh brain with an identical call sequence and implicit learning off. Add a self-test that two master-vs-master runs show zero diffs, and a sensitivity test where an injected change (one dropped saved fact, one reordered row) must be flagged. Both must pass before any item is gated."}
{"id":"N3","severity":"Medium","title":"Item 3's byte-parity rule doesn't fit float math: pgvector accumulates in float32 and JS in float64, lean rows print scores at 4 significant digits, and high_vector_match is a threshold at cosine 0.8; mapping zero-norm vectors to NULL also changes the all-unhydrated early return","file":"src/core/search/hybrid.ts","line":1604,"fix":"State the parity rule for floats in the decision rule: compare full rows before rounding, scores and cosine within 1e-6, and allow a flipped printed digit or evidence category only when the value is within 1e-6 of the rounding or threshold boundary, listed in the receipt. Return a hydrated flag separately from the cosine value, so 'no vector hydrated' keeps returning un-blended results exactly as the JS path does, with a fixture where every candidate is zero-norm or mismatched."}
{"id":"N4","severity":"Medium","title":"Item 1's JIT-off wrapper turns the type check into BEGIN, SET LOCAL, query, COMMIT (4 round trips), a regression on remote databases already running with JIT off","file":"src/core/postgres-engine.ts","line":371,"fix":"Run the batched EXISTS as one plain statement if its estimated cost is below jit_above_cost (assert in the Postgres E2E plan test with jit=on that no JIT: block appears), and keep jitOff only for the missing-type DISTINCT. Add typed queries to G's --rtt-ms 30 receipts with jit=off and require no regression."}
{"id":"N5","severity":"Medium","title":"Item 9's gating split is circular: the lexicon adds exactly that split's three wordings, so 80% firing is near-certain, while the 30 held-out paraphrases have no pass bar","fix":"Make the held-out set the gate: at least 80% firing and zero false attendance routes, written by someone other than the lexicon author, committed and hashed before the change. Report the development split beside it."}
{"id":"N6","severity":"Low","title":"The lateness rule for item 5 can't trigger as worded: item 5 is last in lane S, so 'when the other items are' ready, it has not started","fix":"Replace the trigger with a concrete cut-off, e.g. a date or a fixed time after item 2 lands. Past it, the wave ships without item 5 and item 5 goes to the next slot as its own PR."}
{"id":"N7","severity":"Low","title":"Lane S's planned-file list leaves out files its items must change: hybrid.ts (cosineReScore), engine.ts (the BrainEngine interface for executeRaw jitOff and the new method), files #6734 touched (alias-fanout.ts, mentions/policy.ts, engine-sql/titles.ts and others); relational-recall.ts (the item 9 guard) belongs to neither lane","fix":"Declare complete planned-file lists per lane, generated from a dry run of each item's diff, so gstack-lane-check has real inputs. Assign relational-recall.ts to lane M."}
{"id":"N8","severity":"Low","title":"'No growth' on files at their size ceiling conflicts with items 1 and 3, which need engine members or signature changes in both engines (postgres-engine.ts is exactly at its 3,060-line ceiling)","file":"scripts/module-size-limits.tsv","line":24,"fix":"Name the ratchet bumps the integrator will take (delegate lines only, with reasons in the tsv), or route item 3 through an existing engine read in a peeled module."}
{"id":"N9","severity":"Low","title":"Item 6's new expression-index staleness probe must not add a statement to every search on remote Postgres","fix":"Run the probe in the throttled once-per-engine or maintenance path, and have G's round-trip counts assert no added statement per search when item 6 lands."}
{"id":"N10","severity":"Low","title":"The PR's operational changes list leaves out item 6's ANALYZE time during migrations; under the contract an omitted change found in review is Critical","fix":"Add item 6's ANALYZE time on upgrade (about 1 s at 55k pages per the TODOS) to the PR body's operational changes, next to item 2's index build."}
{"id":"N11","severity":"Low","title":"Item 9's meeting/event guard hardcodes type names ('meeting', 'event' in titleSeedTypes), so brains whose schema pack aliases meeting types are blocked","file":"src/core/search/relational-recall.ts","line":132,"fix":"Resolve the guard's types through expandEngineTypeFilters and add a schema-pack alias test."}
```
