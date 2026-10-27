INPUT: ceo 6fa9d38bfc024b00e8503e41313d327403736c9f865b87ef3dc5083abc1ba736

# CEO review (native voice): LHF wave 2, search latency and agent-visible result size

Reviewer: Capy subagent on anthropic/claude-opus-5-5 (high). Machine check: `gstack: ok 1.91.101.0 for=autoplan`.
Read-only review. Master is `3c16e9ba` (origin/master is the same commit; `git ls-remote` checked), and the branch adds
item 0 at `d5861ac6`. Spend: $0. My one keyless probe ran in PGLite from local audit notes (not committed).

## Verdict

The plan targets the right problem, and most of the items are cheap, real and well sourced. Two items carry most of
the value: item 5 (remote round trips: 1,550 ms per search at 30 ms RTT) and item 1 (typed-search JIT: −500 ms). Item 8
is the only agent-cost lever in the plan. But the plan's safety story is weaker than it says, for three reasons.

1. **The "results unchanged" gate can't see most of the items it gates.** The refactor-wave-1 bench has these
   properties:
   - its pages are all `type: note` in one source (`scripts/bench-refactor-wave-1.ts:131`);
   - it seeds no facts and runs `remote: false` (`:466`);
   - it sends no `types` and digests only the rows, with `score` included (`:474`).

   So it can't see items 1, 2, 4 or 7.
2. **Item 2 is not a pure-performance change, and its semantic change is understated.** The plan names one change
   ("ops" in "devops"). There are at least four, and the alternative that keeps exact semantics, #6734's trigram
   index, was dismissed on weak grounds.
3. **The item 8 paid gate is likely to fail even if item 8 does no harm.** A lower bound above −5 points on about 60
   paired tasks needs an observed gain of roughly +9 points. The plan's rule reverts an inconclusive item, so the
   wave's main cost lever would probably be reverted after $60 of spend.

The lane layout also conflicts with the coordinator contract. Lanes A and B share at least five files, and item 5's
fusion prefetch depends on the engine method that item 3 adds.

Fix the gates and the lanes, and pick the item 2 approach deliberately. The rest of the plan can ship as written,
with the medium fixes below.

## 1. Is this the right problem? Is there a 10x reframing?

Mostly yes. The cost audit shows gbrain's own provider spend is about 1% of agent-task dollars ($1.31 of $133.59 in
the P1 wave, per `docs/plans/2026-10-15-lhf-wave-2/audit/cost.md:14-16`). So the agent-cost lever is tool-result size, and the latency
lever is round trips and plan shape. The plan aims at both.

The plan doesn't analyze where the size actually sits. Search is 72% of all tool-result characters, and `chunk_text`
is 59% of search content (`cost.md:117-119`). Item 8a removes default-valued metadata, which is about 10% of the
total. Three larger levers go unexamined:
- p50 20 rows and p90 100 rows per search, at an average of 25k characters;
- 136 of 2,083 searches repeating a query already made in the same attempt;
- chunks re-sent across calls in one session.

None of these appears in the plan or in its NOT-in-scope list. A keyless replay over the same committed transcripts
could size them, for example:
- characters of `chunk_text` already delivered earlier in the same cell;
- characters of rows ranked below the last row the agent cited or opened.

That replay costs nothing and would point the next wave. It belongs in the wave report (F15).

On latency, the reader should know what the numbers mean for agents. A Cat 40 agent cell takes 37–85 s p50 and makes
about 18 calls, so 30–60 ms per search on PGLite (items 3 and 4) is under 2% of wall time. That is still worth taking
because it's cheap, but it is polish. The material wins go to two groups:
- remote and pooled Postgres users (item 5): 1.5 s per search × 18 calls is about 27 s per task;
- typed searches on JIT-on Postgres (item 1).

Sequencing and the drop rule should protect those two items (F13).

## 2. Premises: stated or assumed?

### Premise table (REALITY: premise-table)

| Premise | Claim in plan | Receipt | Verdict |
|---|---|---|---|
| Type probe is a full DISTINCT scan outside jit-off | item 1 | `src/core/ops/search.ts:271` (master) | verified |
| Saved-facts scan is `LIKE ANY` over all active facts | item 2 | `search.ts:413`, `LIMIT 200` at `:415`, JS rule at `:418` | verified |
| Facts FTS index exists and could serve a prefilter | item 2 | `src/core/fts-language.ts:119-127` | verified, but the document keeps `/` inside slugs (see F2) |
| "The one semantic change" is substring → token-prefix | item 2 | PGLite probe: `to_tsvector('english', … 'people/alice example')` → `'people/alice'`; `alice:*` does not match | **false**: there are more changes |
| Order digests gate items 1-6 | goal | bench: one type, one source, no facts, `remote:false`, score in the digest (`bench-refactor-wave-1.ts:131,466,474`) | **does not hold for items 1, 2, 4 and 7** |
| `[gbrain search]` trailer can state row defaults | item 8a | `searchCountLine` returns null without `keyword_total` (`src/core/search/keyword-paging.ts:247`); `query` never adds the count | **partly false** (F5) |
| Cosine in SQL is order-identical | item 3 | evals audit prototype: 40/40 identical order (`evals-findings.md:96-100`) | measured on PGLite only |
| #6734 numbers: 1,569 → 735 ms at 30 ms RTT | item 5 | `latency.md:125-127`, measured at the default pool of 10 (`src/core/db.ts:66`) | measured; not measured at pool 2 (F9) |
| Fusion prefetch is independent of item 3 | lanes | #6734 `fusion-prefetch.ts` prefetches `getEmbeddingsByChunkIds`; the plan swaps that for item 3's cosines | **false**: lane B depends on lane A |
| Attendance lexicon additions cover the measured paraphrase split | item 9a | the split's forms are "were present at", "was in the room for", "took part in" (`gbrain-evals eval/generators/relational-paraphrase-gen.ts:43-45`) | **the plan covers 1 of 3** |
| Year tokens in quoted anchor titles become plannable | item 9b | the quote refusal runs first (`src/core/search/relational-plan.ts:211`, before the year rule at `:215`) | **no effect for quoted titles** |
| Only the expansion touchpoint changes | item 10 | `getImageOcrModel` falls back to the expansion model (`src/core/ai/gateway.ts:880-881`) | **false** (F8) |
| Cat 40 smoke can show a lower bound above −5 | item 8 gate | 60 paired tasks; no power calculation in the plan | estimated: underpowered (F4) |
| Item 4 saves −32 ms | item 4 | that −32 ms came from stubbing the count out (`latency.md:216-217`) | overstated (F11) |
| Item 8a saves −10 to −13% of tool-result characters | item 8a | −10.4% without `source_id` elision, on one single-source, managed-sync world (`cost.md:145-147`) | measured on one world; the upper end assumes elision the plan doesn't do (F18) |

`unverified=0`. The items not listed above were checked and hold: item 0's evidence, item 6's fix site, item 7's
diff (+43/−5, MERGEABLE) and item 11's numbers in `latency.md`.

### Reality rows

- REALITY: premise-table: 15 premises; 7 false or partly false (receipts in the table above), 0 unverified.
- REALITY: already-done: origin/master is still `3c16e9ba` (`git ls-remote origin refs/heads/master`). The only commit
  on the branch is item 0 (`d5861ac6`), and none of items 1-11 is on master.
- REALITY: surface-check: every named file exists at `3c16e9ba` (`search-settings.ts`, `fts-language.ts`,
  `vector-statement.ts`, `vector-index-walk.test.ts`, `lean-rows.ts`, `relational-intent.ts`, `relational-plan.ts`,
  `expansion.ts`, `expansion-prompt.ts`, `schema-migrations/helpers.ts`, `planner-stats.ts`), and so does the GBRA-94
  harness at `gbrain-evals/docs/benchmarks/2026-10-14-expansion-latency/harness`. The bench flags `--backend pgbouncer`
  and `--phases timings` exist (`bench-refactor-wave-1.ts:6,10`). The bench has no flag for typed queries, facts,
  multiple sources or remote mode (F1).
- REALITY: binding-decisions: `gstack-decision-search --scope branch --recent 50` returned nothing, and the plan has no
  `## Binding decisions` section. Item 0 records Garry's approval of 2026-10-15 in the `d5861ac6` commit message.
- REALITY: numbers: the latency numbers come from audit scratch harnesses
  (`[measured: local audit notes (not committed), synthetic corpus]`). The item 8a characters come from
  `[measured: P1 replay]`. Item 5's "under 500 ms" is `[estimated]` (735 measured, minus about 240 estimated for
  post-fusion reads). Every baseline is `[re-measure before gate]` on the integrated tree.
- REALITY: deferred-asks: these audit asks are dropped or deferred:
  - a backfill ANALYZE for brains that already ran v240 (replaced by the F4b staleness change);
  - `source_id` elision;
  - referrer-row and `get_backlinks` elision;
  - midnight-date shortening;
  - batched variant embeds;
  - the synopsis cache ordering fix (C6).

  Only some of these are named under NOT in scope. The gate template should list each one with its reason.
- REALITY: pr-count: `.gstack/ship-policy.json` uses `stamp-at-merge` with the default of one PR per wave. The plan
  opens one PR. See F13 for the cost of tying item 5 to it.

## 3. The six-month regret scenarios

- **Saved facts quietly disappear for entity-scoped facts.** A fact saved under `people/alice-example` with the text
  "Prefers morning calls" matches the query "alice" today through the `LIKE` over `fact || entity_slug`. Under the FTS
  prefilter it doesn't, because the slug's lexeme is `people/alice` (verified). `entitySavedFacts` covers this only when
  the query resolves to an entity (`search.ts:474`). No eval measures `saved_facts`, so nobody notices (F2).
- **The main cost lever gets reverted after $60.** The Cat 40 smoke comes back with a lower bound around −10 even when
  the point estimate is zero, the rule reverts item 8, and the report reads like evidence that item 8 hurts (F4).
- **Rows lose their trust labels with no statement of the default.** On `query` results, and on any `search` call
  whose count is skipped, rows arrive without `trust_tier` and with no trailer (F5). That breaks #5575's rule that
  every row says how much it deserves influence.
- **One item holds up the whole wave.** Item 5 needs a review of every raw-SQL config writer, a Postgres E2E pass and
  a pool-pressure check. It is still in review while the S items wait for the one merge slot (F13).
- **The 30 ms RTT users see little of the win.** Those are Supabase Supavisor users, and doctor tells them to run
  `GBRAIN_POOL_SIZE=2` (`src/commands/doctor/checks/consolidation-cycle.ts:115`). Item 5's `Promise.all` fan-out queues
  on two connections, so they see a fraction of the measured gain. Under concurrent searches the fan-out can also
  starve the pool (F9).

## 4. Alternatives dismissed without enough analysis

- **#6734's trigram index for item 2.** The plan rejects it for two reasons: write cost on fact inserts, and the v246
  collision. Neither is strong:
  - Project rules pick migration numbers at merge time, so the collision is a renumbering.
  - Fact inserts happen in background extraction, not on the read path, and nobody measured the write cost.
  - pg_trgm is already in gbrain's toolset (pg_trgm name resolution, `src/core/engine-sql/pages.ts:680`).
  - It serves the existing `LIKE ANY` exactly, because every term already has at least 3 characters (`search.ts:388`).

  So it keeps results unchanged, which is the plan's own rule for items 1-6. The threshold-in-SQL change in #6734 can
  be separated from the index. This is the better default; the FTS route needs the fixes in F2 (F2, user challenge).
- **Keyword count, item 4.** The plan doesn't weigh the TODOS alternative: skip the count on PGLite brains above N
  pages and report `keyword_total: null` with the documented degraded stage (`latency.md:221-223`). Its saving is
  easier to predict than reordering the count (F11).
- **Item 8a design.** The audit's adaptive form, which hoists a value only when every row in the response shares it,
  is not compared with fixed defaults. Fixed defaults save only on brains whose common values match the declared
  defaults.

## 5. Competitive and contributor risk

The external competitive risk here is low; this is internal performance work. The real risk is contributor
throughput. @troyhoffman-oss has two active performance PRs, and #6734 is 250 commits behind master and CONFLICTING.
A slow wave means more rebases on their side and a widening gap. Crediting them and adding `Supersedes` lines is
right. If item 5 slips, take #6747 (small, MERGEABLE) in this wave anyway rather than holding it for item 5.

## Cross-item interactions the plan doesn't state

- Item 4 can remove `keyword_total`, and item 8a needs the trailer that depends on it (F5).
- Item 5's prefetch consumes item 3's new engine method (F3).
- Items 2 and 5 both rewrite `matchingSavedFacts` and response meta in `ops/search.ts`. Items 1 and 4 change
  `ops/search.ts` too (`:264-285` and `:762,775`).
- Item 10's expansion default moves OCR (F8).
- The Cat 40 smoke isolates item 8, but items 2 and 9 also change what agents see, and no agent-level check covers
  them (F14).

## Error and rescue notes (for the registry)

These are the failure paths the plan needs to name:
- **Item 2:** the FTS prefilter throws (no index, or a bad tsquery). Today any error returns `[]` silently
  (`search.ts:424-426`). The fallback to `LIKE` should run on error too, not only when the index is missing.
- **Item 6:** ANALYZE fails or times out after the index was built (F12).
- **Item 5:** a snapshot read after a write in the same CLI op (F10), and starvation at pool 2 (F9).
- **Item 4:** the count misses its grace window (`keyword_count_unavailable` rises).

The plan's 1% gate on `keyword_count_unavailable` is right.

## Not in scope and what already exists

The NOT-in-scope list is sound. Type-filtered vector walk, TODO-D and the `full`-surface budget each have stated
reasons. Add the levers from section 1 as a measured follow-up rather than leaving them unmentioned.

The "What already exists" list matches the code, apart from the trailer's coverage (F5) and the facts FTS document's
slug handling (F2).

```gstack-findings
{"id":"F1","severity":"High","title":"The 'order digests match master' gate can't see items 1, 2, 4 and 7: the bench has one page type, one source, no facts, no types queries, remote:false, and a digest that includes score","file":"scripts/bench-refactor-wave-1.ts","line":474,"fix":"Before any lane starts, extend the bench fixture: mixed page types plus typed queries (including a missing type and a schema-pack alias), seeded facts (slug-only, hyphenated and apostrophe terms), a second source, and a remote:true pass. Use the order-only digest [source_id, slug, chunk_index] and add a meta digest covering saved_facts ids, type_filter_notice, keyword_total/keyword_truncated and the lean row projection. Gate items 1-6 on that bench."}
{"id":"F2","severity":"High","title":"Item 2's FTS prefilter changes results in more ways than 'ops in devops', and the trigram alternative that keeps exact LIKE semantics was dismissed on weak grounds","file":"src/core/fts-language.ts","line":121,"fix":"Default: take #6734's trigram index on lower(fact || ' ' || entity_slug) alone (renumbered at merge, no threshold change), with a keyless fact-insert throughput micro-bench as the write-cost receipt. If FTS stays: (1) match slug path segments separately, since the 'people/alice' lexeme makes 'alice:*' miss slug-only facts (verified in PGLite); (2) reclassify item 2 as a contract item with a BEHAVIOR_CHANGES row; (3) gate on a keyless saved_facts parity replay over recorded Cat 40 queries against world M facts, with every difference explained; (4) fall back to LIKE on any prefilter error, not only when the index is missing.","user_challenge":true,"changes":"direction"}
{"id":"F3","severity":"High","title":"Lanes A and B overlap, which the coordinator contract's lane-check refuses: shared files (ops/search.ts, hybrid.ts/rank.ts, both engines, vector-statement.ts) and item 5's fusion prefetch needs item 3's new cosine method; items 4 and 8 both touch keyword-paging.ts","fix":"Re-lane by file: put items 3 and 5 in one lane, or stack lane B on lane A's branch. Lane C starts after lane A lands its keyword-paging change. Declare each lane's planned files up front and run gstack-lane-check before starting lanes, not at merge."}
{"id":"F4","severity":"High","title":"The item 8 paid gate (lower bound above -5 points on about 60 paired tasks) is underpowered: an observed gain of about +9 points is needed, so a harmless item 8 is likely reverted after $60","fix":"Preregister a power calculation using the discordance rate from the last Cat 40 dev rounds. Either use the established dev harm screen (pooled paired point estimate better than -5, CI reported), or size n to the margin. Gate 8a (information-preserving by construction) on the keyless replay and spend the paid cells on 8b, which removes fields agents read. Preregister the run order (Sol first) and a per-model cost estimate: on Cat 40 Hard M costs ($0.32-1.10 per success), 120 cells can exceed the $60 cap."}
{"id":"F5","severity":"High","title":"Item 8a relies on the '[gbrain search]' trailer to state elided defaults, but the trailer is null without keyword_total: never on query, and not when item 4 skips the count","file":"src/core/search/keyword-paging.ts","line":247,"fix":"Emit the defaults statement on its own whenever any row elides a field: a fixed model-visible line in dispatch plus _meta.retrieval.row_defaults. Cover search, query, count-unavailable and count-skipped paths with golden tests. Keep non-default trust tiers inline on their rows."}
{"id":"F6","severity":"Medium","title":"Item 9a's lexicon misses 2 of the 3 measured paraphrase forms ('was in the room for', 'took part in') and adds ambiguous verbs ('joined', 'was at', 'went to') that collide with employment and education wording","file":"src/core/search/relational-intent.ts","line":170,"fix":"Add the measured forms plus 'participated in'. Allow 'joined', 'was at' and 'went to' only with a meeting/event-shaped anchor (anchor page type, or a meeting noun). Add a false-fire gate on works_at and education paraphrases. Score on paraphrase wordings written before the lexicon change, because the current split is development data."}
{"id":"F7","severity":"Medium","title":"Item 9b has no effect on quoted anchor titles: the planner refuses any quoted query before the year-token rule","file":"src/core/search/relational-plan.ts","line":211,"fix":"Limit 9b to year tokens inside a resolved anchor span (title or alias match), or relax the quote refusal for a quoted span that resolves to one anchor, with planner tests for both cases."}
{"id":"F8","severity":"Medium","title":"Item 10 silently moves image OCR to Haiku 5.5: getImageOcrModel falls back to the expansion model when embedding_image_ocr_model is unset","file":"src/core/ai/gateway.ts","line":880,"fix":"Leave the OCR default unchanged when only the expansion default moves: resolve OCR from the pre-change default, or apply the measured default only in the expansion resolver. Add a resolver test. Note Haiku 5.5's measured +570 ms p95 on expansion in the BEHAVIOR_CHANGES row."}
{"id":"F9","severity":"Medium","title":"Item 5 was measured at the default pool of 10, but the 30 ms RTT users are Supavisor users whom doctor tells to set GBRAIN_POOL_SIZE=2; at pool 2 the Promise.all fan-out queues and can starve under concurrent searches","file":"src/commands/doctor/checks/consolidation-cycle.ts","line":115,"fix":"Add delay-proxy A/B runs at GBRAIN_POOL_SIZE=2 and 10 through transaction-mode pgbouncer, plus a concurrency stress run (N concurrent searches at pool 2) with no timeouts and p95 recorded. Cap the fan-out width at the pool size."}
{"id":"F10","severity":"Medium","title":"Item 5 widens #6734's snapshot to CLI operation dispatch, so long-running CLI read ops would read stale config for their whole run, kill switches included","fix":"In CLI dispatch, apply the request snapshot only to search/query-family read ops, or bound its lifetime. Keep write ops and every op that reads paid-feature or kill-switch keys (decide.*, trust.*) on live reads. Add a test that a config write made by another process mid-op is seen by a long op."}
{"id":"F11","severity":"Medium","title":"Item 4's -32 ms came from stubbing the count out; starting the count after the search only saves time when the keyword arm did not fill its page","fix":"Report the expected saving as fill rate x count time, measured on the bench with the extended fixture. Compare it with the TODOS alternative (skip the count on PGLite above N pages, report keyword_total null with the degraded stage) and pick on the receipt."}
{"id":"F12","severity":"Medium","title":"Item 6's ANALYZE inside buildIndexOnline can fail the migration (statement timeout on a large table) after the index is already built, and repeated failures wedge upgrades","file":"src/core/schema-migrations/helpers.ts","line":111,"fix":"Make ANALYZE best-effort: catch it, log it and leave it to the F4b staleness path. Test on a brain that already ran v240 on master and then upgrades, and on a forced ANALYZE timeout."}
{"id":"F13","severity":"Medium","title":"The wave bundles item 5 (M effort, medium risk, contributor port) with S items and has no lateness rule, so the S items wait on item 5's reviews","fix":"Set an integration cut-off: if item 5 is not green on the integrated tree by then, ship the wave without it, and item 5 takes the next merge slot. Take #6747 (item 7) independently of item 5."}
{"id":"F14","severity":"Medium","title":"The item 8 smoke compares master with master+item 8, while 'paid gates run on the integrated tree'; agent-visible changes from items 2 and 9 get no agent-level check","fix":"Run the smoke as wave head vs master, which is what ships, and attribute item 8 with the keyless character counts. Alternatively, state that items 2 and 9 ship on keyless gates only."}
{"id":"F15","severity":"Medium","title":"The larger result-size levers are not analyzed: chunk_text is 59% of search output, searches repeat within cells (6.5%), and rows run p90 100 per call; item 8a moves about 10%","fix":"Add a $0 replay to the wave report sizing chunk_text re-delivered in the same cell and rows ranked below the last cited or opened row, then file a follow-up plan with those numbers. No product change in this wave."}
{"id":"F16","severity":"Medium","title":"Item 8b: 'budget_used measures the serialized result' is ambiguous; if packing follows it, text shrinks at the same budget_tokens; facts[] carries valid_from and context that text does not render","file":"src/core/ops/facts.ts","line":842,"fix":"Keep packing on text, report the serialized size in a separate field (e.g. serialized_tokens), drop only fields from cards[] that text fully renders, and leave facts[] and edges intact. Add a replay check that text at the default budget is unchanged."}
{"id":"F17","severity":"Low","title":"Item 1's EXISTS must cover each requested type's expanded set, not the literal type, or types reached through a schema-pack alias get dropped","file":"src/core/ops/search.ts","line":280,"fix":"Probe EXISTS over p.type = ANY(expandedTypes) per requested type, keep the full DISTINCT (jit-off) for the missing-type notice only, and add a schema-pack alias test."}
{"id":"F18","severity":"Low","title":"Item 8a's '-10 to -13%' upper end assumes source_id elision the plan doesn't do; the measured figure is -10.4% on one single-source, managed-sync world","fix":"State -10.4% [measured: P1 replay, single source] and note that multi-source or mixed-trust brains save less; get a keyless count on the nightly scale corpus if available."}
{"id":"F19","severity":"Low","title":"A non-blocking mcp_request_log insert can drop audit rows on shutdown or under backpressure","fix":"Bound the pending inserts, flush them on shutdown, and count drops in a metric doctor can read."}
{"id":"F20","severity":"Informational","title":"Item 9's real-user reach is limited: attended edges exist only for meeting notes with documented attendee lists, and prose-only attendance is unsupported (N12-9)","fix":"Say so in the BEHAVIOR_CHANGES row and the wave report so the paraphrase gain isn't read as general attendance recall."}
```
