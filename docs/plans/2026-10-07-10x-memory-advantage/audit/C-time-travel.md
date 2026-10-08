# Audit C: a brain you can travel back through in time (bet 4)

Auditor: GBRA-60 sub-audit C. Read-only. Pins: gbrain master `7aa2caa0` (v0.60.106.0), gbrain-evals main `f1ce49fe` (v0.10.40). Date 2026-10-07.
Scope: (i) belief history ("what did I believe about X on March 1", "what changed this week"), (ii) graded takes into a track record ("who has been right about what"), (iii) pages that keep themselves current (summary refresh with reviewable diff and sources).
Every number below is cited to a file I read. "Not found" means I searched and did not find it.

## 0. Verdict in five lines

1. Valid-time history is largely built: facts, ontology, takes and typed links all carry "when it was true", and the as-of reads pass synthetic gates (N3 513/513, N1 388/388, temporal edges held-out as-of exact 0.678). What is missing is **recorded time** ("what did the brain believe on D"), which is stored only in DB columns that the Markdown-first rebuild resets, and is exposed by no op.
2. Takes already store holder + weight + resolution, and gbrain already computes per-holder accuracy/Brier (`takes_scorecard`). But grading accuracy has **never been measured**, auto-resolution is off by default, the calibration profile covers only the owner, and there is no "who has been right" ranking.
3. No refresh loop exists for existing entity pages. The pieces exist (claim-unit diff + quote grounding in `synthesize-verify.ts`, proposal queues, `revert_version`, a stale-summary detector), but the closest measured analogue, pinned questions in #6066, **tied** anchored retrieval on accuracy. A living-page feature has to win on tokens, cost per read and reviewability, not on accuracy.
4. Public headroom for this bet is on BEAM, not LongMemEval: LME-S knowledge-update 71/72 and temporal 118/127 (saturated), BEAM-1M knowledge update 45.5%, temporal reasoning 42.4%, event ordering 46.8% (dev, gpt-4.1-mini reader).
5. The biggest structural overlap is GBRA-58 (trust tiers + `forget --purge`): purge must reach exactly the history tables this bet reads, and trust-guarded supersession changes what a "belief change" is.

---

## 1. WHAT EXISTS TODAY

### 1.1 Belief-bearing records and their time columns

| Record | Where | Valid time | Recorded time | History kept | Canonical? |
|---|---|---|---|---|---|
| Facts | `facts` table (`src/core/schema-migrations/v045-facts-hot-memory-v0-31.ts:113-145`), `## Facts` fence (`src/core/facts-fence.ts:1-40`) | `valid_from` (default `now()`), `valid_until` | `created_at`, `expired_at`; `expired_at` is **derived** "valid_until + now()" (`facts-fence.ts` header) | struck fence rows `superseded by #N` / `forgotten:`; `superseded_by` FK | fence is system of record; DB is a derived index |
| Fact kinds | `kind IN ('event','preference','commitment','belief','fact','idea')` (v045 + v145) | | | | |
| Ontology dimensions | facts rows via `ontology_propose` / `ontology_get asof` (`src/core/ops/chronicle.ts:141-200`) | `valid_from`/`valid_to` params | none queryable | supersede on new value; "a backdated conflict is flagged not rewritten" | DB rows (managed writes since N1-1 fix) |
| Takes | `takes` table (`v037-takes-and-synthesis-evidence.ts:25-50`), `## Takes` fence (`src/core/takes-fence.ts:1-37`) | `since_date`, `until_date` (fence `since` cell, `A → B` ranges) | `created_at`, `updated_at`; upsert keeps `created_at` (`engine-sql/takes.ts:75-90`) | append-only rows, strike + `superseded by #N` (`supersedeRow`, `takes-fence.ts:535`) | fence canonical |
| Typed relationships | `links` + `link_transitions` + `link_relationships` (`src/core/link-temporal-schema.ts:27-90`) | `valid_ranges DATEMULTIRANGE`, `first_start/last_start/last_end` | `recorded_at` = earliest evidence, `retired_at` = when the brain learned it ended (`link-relationships.ts:114-126`) | one row per relationship, **overwritten**; removed when evidence disappears (`link-relationships.ts:105-107`) | derived from pages |
| Pages | `page_versions` (`src/schema.sql:608-615`, plus `knowledge_revision,timeline,title,type,tags,is_deleted,source_path` in `src/core/page-state/versions.ts:13-16`) | page `effective_date` | `snapshot_at` (preimage per write) | full preimage on every managed write (`import-file.ts:835,1447,1657`, `persistence/page-prepare.ts:291`, etc.) | DB only |
| Metric trajectories | typed-claim facts (`v067-facts-typed-claim-columns.ts`), `find_trajectory` (`ops/insights.ts:268`) | period | | corrected points dropped | fence |
| Chronicle events | event pages + `chronicle_*` ops (`ops/chronicle.ts:88+`) | event date | | | pages |

Takeaways:
- gbrain is bi-temporal **in storage** for facts and relationships but uni-temporal **in queries**: every `as_of`/`asof` param is valid time (`ontology_get` description: "Valid-time as-of day", `ops/chronicle.ts:152`; `get_links as_of`, `ops/edge-temporal.ts:17-20`).
- Recorded time is not durable across a Markdown rebuild. The fence carries no recorded-time column; the facts reconcile deletes and reinserts a page's fence rows (`deleteFactsForPage`, `engine-sql/facts.ts:301-331`; TODOS.md:704 "atomic wipe+reinsert"), so `created_at` resets. `page_versions` is DB-only, and `src/commands/migrate-engine.ts` mentions it only in a cascade comment (line 958); I found no copy step (not found).
- `takes` `since` defaults to the write date when the caller omits it (`persistence/takes-prepare.ts:20-36`, `since: params.since ?? date`, with `since_supplied` recorded on the intent), so for late-captured beliefs valid time and recorded time are conflated.

### 1.2 Query surface today

| Question | Op / CLI | Notes |
|---|---|---|
| What was true on D (relationships) | `get_links {as_of, during, status}`, `get_backlinks {status, as_of}` (`ops/links.ts:382-404`, `ops/edge-temporal.ts`) | default reads hide ended edges and say so (`former_relationships_hidden` notice) |
| What was true on D (attribute) | `ontology_get {asof}`, `gbrain ontology <entity> --asof` | valid time |
| Timeline up to D | `get_timeline {before}` | N3 104/104 |
| Pages dated in a window | `query {since, until}` (`ops/search.ts:801-802`), `think {since, until}` (`ops/takes.ts:218-219`, `think/temporal-window.ts:46-93`, undated pages kept) | content date, not belief date |
| Answer as if today were D | `think {reference_date}` (`ops/takes.ts:220`, `docs/guides/time-aware-recall.md`) | shifts "today" only; **evidence written after D is still visible** |
| Facts history | `recall {include_expired, supersessions, since}` (`ops/facts.ts:213-227`) | no `as_of` |
| What changed since | `delta {since|cursor|session_id}` (`ops/facts.ts:761-777`) | lists changed pages as `title → slug (updated_at)` (`context/turn-context.ts:770`), facts, thread events; **no before/after** |
| Events since | `chronicle_since`, `chronicle_day`, `chronicle_on_this_day`, `chronicle_last_seen` | N3 all pass |
| Page history | `get_versions` (CLI `gbrain history`), `revert_version` (CLI `gbrain revert`) (`ops/admin.ts:191-249`) | no `at` param, no diff output |
| Takes | `takes_list {active, resolved, holder, kind}` (`ops/takes.ts:26-60`) | no `as_of` |
| Founder track | `gbrain founder scorecard <entity>` (`src/commands/founder-scorecard.ts:1-40`): claim_accuracy from resolved takes **on that entity's page**, consistency, growth, red flags | subject-centric, not holder-centric |

`search` declares no `since`/`until` (N3 report, "Unsupported"); the 2026-10-01 knowledge-layer proposal (gbrain-evals `docs/plans/2026-10-01-knowledge-layer/PLAN.md`, "Where we actually are") already flagged "`as_of` is not a parameter of `search`/`query`" and "No explicit `supersedes` edge on ordinary pages". The 2026-09-28 10x plan listed "As-of queries in think and search (N3)" as product item 15 and a takes-vs-facts contradiction flow as item 14 (`docs/plans/2026-09-28-gbrain-10x/PLAN.md:440-446`); neither shipped as a recorded-time feature.

### 1.3 Supersession machinery

- Explicit fence supersession (strike + `superseded by #N`) for facts and takes; `remember.replaces` (P8, `src/core/verbs.ts:99`, "fact_id this fact replaces (same entity)", full-surface only; evidence: conformance/race tests only, "No sealed run", `docs/eval/decisions/p8/PREREGISTRATION.md:71-74`).
- Implicit supersession by cosine: hard-coded 0.95 on master; #6066 turns it into a per-model table (`src/core/facts/supersession-threshold.ts` on `capy/mpw-integration`), voyage-4@1024 stays 0.95, uncalibrated models never supersede by cosine and hand pairs to the `conflict` decide sweep.
- `gbrain repair take-supersession` rebuilds struck-take pointers on managed brains (TODOS.md:290, completed).
- Relationship closure: `edge_contradictions` dream phase (model judges "can both hold?", date arithmetic picks the end, `closeContradiction` `link-validity.ts:313`), `CERTIFIED_APPLY_MODELS` (`cycle/edge-contradictions.ts:86`) apply; proposals in `link_edge_proposals` with `gbrain edge-proposals list|accept|reject|undo|date` (`docs/guides/temporal-edges.md`); declared single-value relations (`link-single-value.ts`, `dream.single_value.mode` default `propose`).
- Contradictions: `find_contradictions`, N2 judge prompt v4.

### 1.4 Takes, grading and calibration

- Fence format (`takes-fence.ts:9-17`): `| # | claim | kind | who | weight | since | source |`; kinds open-ended since v0.38 (`TakeKind = string`, line 43) but the parser's `KIND_VALUES` is still the closed four (TODOS.md:2271-2275), and `takes_add`/`takes_supersede` pin the four literals (TODOS.md:2304-2309).
- Holder semantics: "Who HOLDS this belief ... NOT the person the belief is ABOUT" (`takes-fence.ts:50-70`), with the comment that holder/subject confusion was "the #1 attribution error (6.5/10)" in a 2026-05-10 cross-modal eval. (Privacy note: that comment block uses real-looking person and company slugs as examples, and `ops/takes.ts:35,99` uses the owner's first name as a holder example; both conflict with the CLAUDE.md privacy rule and would leak into any track-record UI copy. Not reproduced here.)
- Resolution: `takes_resolve` / `gbrain takes resolve`; 4-state quality `correct|incorrect|partial|unresolvable` (`takes-resolution.ts:22-58`, v043, v080); `resolved_by` stamped `mcp:<client>` for remote callers (`takes-prepare.ts:22-27`), surfaced as `mcp_resolved` on the scorecard (`ops/takes.ts:115-120`).
- Scorecard: `takes_scorecard {holder, domain_prefix, since, until}` (`ops/takes.ts:91-127`), SQL `engine-sql/takes.ts:580-619`: Brier = mean (weight − outcome)² over correct/incorrect rows of **any kind** (filter is on `resolved_quality`, not `kind='bet'`); accuracy = correct/(correct+incorrect); partial and unresolvable excluded from Brier (`finalizeScorecard`, `takes-resolution.ts:90-113`), `PARTIAL_RATE_WARNING_THRESHOLD = 0.20`.
- Calibration curve: `takes_calibration {holder, bucket_size}` (`ops/takes.ts:131-155`).
- Cycle trio (`src/core/cycle.ts:160-176`): `propose_takes` → `take_proposals` queue (pending/accepted/rejected; "auto-accept is intentionally NOT a thing"); `grade_takes` (`cycle/grade-takes.ts:1-34`): hybrid-search evidence, items annotated relative to `since_date`, 4k-char cap, verdicts to `take_grade_cache` with `applied=false`; auto-apply only when `cycle.grade_takes.auto_resolve.enabled` and confidence ≥ 0.95, loosening needs `--allow-loosen-confidence`; `calibration_profile` (`cycle/calibration-profile.ts`): **one holder per run** (owner via `resolveOwnerHolder`, line 232), needs ≥ 5 resolved takes (line 286), prompt version `v0.36.1.0-stub` (line 41), voice-gated pattern statements, domain scorecards via pack `calibration_domains` (`calibration/domain-aggregators.ts`).
- `get_calibration_profile {holder}` (`ops/calibration.ts:14-37`) reads the latest `calibration_profiles` row (DDL `src/schema.sql:1562-1590`).
- `drift` phase (`cycle/drift.ts:1-23`): default off, judge flags takes whose evidence shifted, **report-only**; `dream.drift.auto_update` "mutates NOTHING in v1"; `drift_decisions` audit table exists since v043 but has no writer that applies.
- `think --take` persists the owner's synthesized position as a take (`think/persist-take.ts:1-27`); think reads **active takes only** (`think/gather.ts:6-7`) and never weights a take by its holder's record; `withCalibration` adds the owner profile to the prompt (Cat 14).
- Founder scorecard (§1.2), `find_trajectory`, `gbrain eval trajectory`.
- Contributor PR #5552 (@wesleymatosdev, open): `remember` hard-codes `confidence: 1` in `memory-prepare.ts`, so every agent-written fact enters at human-reviewed confidence; the PR adds an optional `confidence` param.

### 1.5 Living-page building blocks

- Page model: compiled truth + append-only timeline. Summary shown on cards/packs = frontmatter `summary`, else the first prose sentence of compiled truth with fences stripped (`safeSynopsis`, `context/retrieval-reflex.ts:587-616`). Nothing regenerates it.
- Stale-summary detector (deterministic, zero LLM): `link-relationship-notes.ts:27-45` appends "summary may be stale: it still names X" when the summary names an ended state relationship; shown on `entity`, `context_pack`, ambient turn context and compiled context (`docs/guides/temporal-edges.md`, "Reading").
- `enrich` / `enrich_thin` (`src/commands/enrich.ts:1-30`, `cycle/enrich-thin.ts:1-30`): grounded brain-internal synthesis for **thin** person/company pages only (body below a char threshold), pre-LLM grounding gate, re-enrich window 30 days, default off, writes directly via `publishMaintenancePage` (no review queue). The header claims "93.6% of people/company pages are stubs" (a production-brain observation in a code comment, not a published measurement).
- Dream `synthesize` + `synthesize-verify.ts:1-60`: claim units (sentences, list items, table rows) that are new versus the **pre-run revision in `page_versions`**; quotes/attribution/numbers/decisions verified against source transcripts; failing units leave the body into frontmatter `unverified_claims`; provenance in `grounding.quotes`; zero LLM; kill switch `dream.synthesize.quote_verify`. This is a working "diff + verify + quarantine" engine, today scoped to dream pages.
- Proposal/review patterns to reuse: `take_proposals`, `link_edge_proposals` (accept/reject/undo/stale), P8 `review_withdraw` lane, `gbrain repair … --diff` preview then `--apply` (`src/commands/repair.ts:45-71`), `revert_version`.
- `auto_think` (`cycle/auto-think.ts:1-15`): runs configured questions, default off, draft staging; #6066 migrates it into pinned questions.
- Pinned questions (#6066, `src/core/questions/*`, migration `v220-pinned-questions.ts` on the branch): owner-private standing questions, per-sentence evidence pointers, staleness computed at read time, leased refresh revalidated at commit, `context_pack.pinned_questions`. Shipping **opt-in**.
- Entity-anchored retrieval (#6066, `search.entity_anchoring`, default off until verdict; `retrieveEvidence` in `src/core/questions/refresh.ts`): entity page, then linkers/namers newest first, then hybrid hits, facts, timeline, takes.
- Mention index (Cat 40 entity-recall wave, landed; `docs/architecture/key-files/entity-recall.md`): `page_mention_state`, `mention_index_status`, `referenced_by` on the card, coverage state. Gives a per-entity "new evidence arrived" signal.
- Held files and fence repair: a held file imports nothing until repaired; `invalid_fence` holds clear on the next maintenance run; `fence_repair` phase right after `sync` (`cycle.ts:126-127`); put_page and append verbs normalize their target fence (#6188).

### 1.6 Tests that pin today's behaviour (read by name; gbrain `test/`, 2,842 files)

Temporal edges:
- `link-validity.test.ts`, `link-relationships.test.ts`, `link-temporal-evidence.test.ts`, `link-temporal-put-page.test.ts`, `link-temporal-reads.test.ts`, `link-single-value.test.ts`
- `cycle-edge-contradictions.test.ts`, `edge-proposals-list-flags.test.ts`, `edge-proposals-json-bigint.test.ts`

Ontology and as-of:
- `chronicle-ontology.test.ts`, `chronicle-ontology-ops.test.ts`, `chronicle-ontology-private-visibility.test.ts`
- `ontology-backdated-same-value.test.ts` (N3 bug 1), `ontology-revert.test.ts` (N1-2), `ontology-fence-sweep.test.ts` (N1-7), `ontology-fact-visibility.test.ts` (N1-3), `managed-ontology-propose.test.ts` (N1-1)
- `chronicle-last-seen-matching.test.ts`, `chronicle-timeline-reads.test.ts`

Supersession and history:
- `facts-supersede-not-withdrawal.test.ts`, `repair-take-supersession.test.ts`, `consolidate-valid-until.test.ts`
- `get-versions-response-bounds.test.ts`, `delta-cursor-integrity.test.ts`, `delta-cursor-microseconds.test.ts`
- P8 cites `remember-replaces.test.ts` and `e2e/p8-memory-writes-postgres.test.ts`

Takes:
- extraction: `extract-takes*.test.ts` (10 files incl. `extract-takes-bootstrap-safety`, `extract-takes-holder-producer-seam`), `persistence-managed-takes-extract.test.ts`, `persistence-take-receipt-authority.test.ts`
- proposals: `propose-takes*.test.ts` (5 files)
- grading: `grade-takes.test.ts`, `grade-takes-evidence.test.ts`, `grade-takes-ensemble.test.ts`
- calibration: `calibration-profile.test.ts`, `calibration-cli.test.ts`, `doctor-calibration-checks.test.ts`
- quality eval: `eval-takes-quality-*.test.ts` (11 files), `eval-takes-bootstrap*.test.ts`

Living-page pieces:
- `cycle-synthesize-verify.test.ts`, `cycle-synthesize-verify-decisions.test.ts`, `cycle-synthesize-grounding-coverage.test.ts`, `cycle-patterns-quote-verify.test.ts`
- `entity-card-*.test.ts` (loops, private backlinks, perf)

What these tests do not cover, by name search: none tests recorded-time reads, a belief diff, grading verdict accuracy against gold, a multi-holder profile, or a summary refresh. Hermetic tests inject `opts.judge` / `opts.evidenceRetriever` for `grade_takes` (`grade-takes.ts:30-33`), so the judge prompt's real precision is untested.

---

## 2. WHAT HAS BEEN MEASURED

All synthetic/dev unless marked held-out or sealed.

| # | Measure | Number | Date / pin | Data class | Source |
|---|---|---|---|---|---|
| M1 | N3 temporal as-of, all probes | 500/513 → **513/513** after fixes | 2026-09-30, `608a174`/`f8d1e39` → `6c8373c` | synthetic, $0, now a gate | gbrain-evals `docs/benchmarks/2026-09-30-n3-temporal-asof.md` |
| M2 | N3 page-date filter vs valid-time gold | 86/104 (18 differ when a late note changes the answer); vs recorded-time gold 104/104 | same | synthetic | same, "Page-date filtering versus true as-of state" |
| M3 | N3 boomerang first stint recorded last (`ontology_get`) | 0/3 (bug, fixed in v0.60.13.0) | 2026-09-30 | synthetic | same |
| M4 | N1 knowledge update | Oct 1: current 288/388 (74.2%), history 168/385 (43.6%), 0 stale; Oct 2 after wave 6: **388/388, 385/385**, 0 stale, 0 lost | 2026-10-01 `3a284ae`; 2026-10-02 `d44296c` | synthetic lifecycle, gate (N1-ci) | `docs/benchmarks/2026-10-01-n1-knowledge-update.md` |
| M5 | N1 paid arm, implicit supersession via `remember` | **0/10** value changes superseded; 0/10 controls; 10/10 near-dupes deduped | 2026-10-01 | synthetic, report-only, $0.000006 | same, "Paid arm" |
| M6 | Supersession threshold sweep (#6066) | voyage-4 @0.95: corrections missed **46.7%**, coexisting wrongly replaced 3.75%; 3-large @0.95: missed 63.3%, wrongly replaced **53.75%**; no 3-large threshold meets the guard | gbrain `7d2cc1c70` (branch) | synthetic dev | `docs/eval/decisions/supersession-threshold-dev/README.md` on `capy/mpw-integration` |
| M7 | Temporal edges E1 dev (set A) | as-of exact 0.212 → 0.900; stale summary flagged in `context_pack` 0.000 → 0.867; current-employer recall 0.842 both | 2026-10-04, `bc6723c85` | dev | gbrain `docs/eval/decisions/p1-dev-2026-10-04/README.md` |
| M8 | Temporal edges E1 held-out set B (round 1) | **FAIL**: traps 101/115, recall non-inferiority failed | 2026-10-04 | held-out | same, header |
| M9 | Temporal edges E1 held-out set C (round 2) | **PASS**: current-employer precision 0.376 → 0.943; as-of exact 0.208 → **0.678**; during-year F1 0.455 → 0.653; stale-summary correction 0.000 → **0.364**; traps 115/115; order invariance 240/240 | baseline `6622a119e`, candidate `feb077ef9` | held-out (custodian) | `docs/eval/decisions/p1-dev-2026-10-04-r2/README.md:84-97` |
| M10 | E3 ingestion-to-answer after a correction | `entity`/`context_pack`/compiled context show it for **0.277** of people, ambient context 0.239, baseline 0; ceiling is link typing ("Signed on with [X] as CTO" not typed `works_at`) | same | held-out, report-only | same, lines 99-103 |
| M11 | E2 `apply` certification, 5 models | 0 wrong closures, as-of +0.111 to +0.115 over E1, 0 undated closed; **41 of 66 closures late**; 51 proposals/model went stale within a cycle | frozen `feb077ef9` | held-out | `docs/eval/decisions/p1-e2-2026-10-05/README.md` |
| M12 | Takes bootstrap frontier | Sonnet 5.5, GPT-6.1 Sol, Opus 5.5: **0 forbidden attributions, 0 malformed of 123**; per-kind bars missed by all (fact P 0.615-0.714, bet P 0.514-0.667); "not yet graduated", labels incomplete; Haiku 4.5 (Oct 4): 3 forbidden | 2026-10-06, `c5fb0201`; $0.17-0.58/arm | dev | `docs/benchmarks/2026-10-06-takes-bootstrap-frontier.md` |
| M13 | Cat 15 propose_takes extraction | F1 0.952 training / 0.922 unseen, 48 labeled claims, "small and in-sample" | 2026-05-18, `04dbab44` | dev, report-only | `docs/benchmarks/2026-05-18-brainbench-cat14-cat15-calibration.md`; registry `eval/registry.ts:371-376` |
| M14 | Cat 14 calibrated advice | May 75% **retracted** (judge saw expected behaviour); Oct 2 blind rerun: preferred 5/6, gate **FAIL** (counter 2/4 vs 80%, voice 31% vs 95%); Oct 6 negative control passes (0.67 vs 0) | `d44296c`; `c5fb0201` | 8 hand-written probes | `docs/benchmarks/2026-10-02-cat14-rerun.md`; gbrain-evals `TODOS.md:43` |
| M15 | Grading predictions against outcomes, and profile generation | **not tested**: "Grading predictions against reality and generating the profile were not directly tested" | 2026-05-18 | — | May report, "What calibration means here"; line 131 proposes 30 human-graded predictions |
| M16 | Quote grounding (P8) | first sealed FAIL 4.7% wrongly flagged (UB 7.6%); rescore 16/319 (UB 8.0%) FAIL; fresh-material retest **PASS** 5/321 (1.56%, UB 3.59%) | build `7715e647a` | sealed/held-out | `docs/eval/decisions/p8/SEALED_VERDICTS.md:1-40` |
| M17 | Pinned questions B5 (#6066) | anchored reader 96.8% vs pinned 98.1%, pinned not better in seed 42 → **opt-in**; anchoring lifts query+reader 88.4% → 96.8%, stale-wrong **11.6% → 0%**; cost per correct read at 100 reads/write: pinned $0.00057, anchored $0.00152, full evidence $0.00284 | gbrain `1384a0db` (branch) | dev, 3 seeds | `docs/eval/decisions/c4-pinned-questions/README.md` on `capy/mpw-integration` |
| M18 | LongMemEval-S by type | knowledge-update **71/72**, temporal-reasoning **118/127**, overall 468/500 (93.6%) | 2026-10-06, `c5fb0201`, Sonnet 5.5 reader | development (used for tuning) | `docs/benchmarks/2026-10-07-longmemeval-w10a-current-pin.md:46-56` |
| M19 | BEAM-1M dev by category (fixed loader) | knowledge update **45.5%**, temporal reasoning **42.4%**, event ordering **46.8%**, contradiction resolution 65.9%; strict recall 18.2%; P-series changed retrieval by exactly 0 | 2026-10-06, `6622a119e` / `c5fb0201`; gpt-4.1-mini reader+judge, 20 q/category | dev | `docs/benchmarks/2026-10-06-beam-1m-dates.md:14-60` |
| M20 | Time-aware think date frame | LoCoMo held-out 88.2% vs 74.2% (+14.0, CI [+11.8,+16.2]); LME-S dev 90.0% vs 80.7% | see guide | held-out (LoCoMo) | `docs/guides/time-aware-recall.md` |
| M21 | N2 contradiction judge | 4 counted models catch 150/150 planted conflicts, 0 of 40 dated changes called contradictions; gpt-6-luna $0.21 per 1,000 pairs; Haiku 4.5 fails | 2026-10-06, `c5fb0201` | dev | `docs/benchmarks/2026-10-06-n2-judges.md` |
| M22 | N5 forget residue in history | forgotten claims remain in `get_versions` (30 token hits) and vault git history (24) | 2026-10-01 | synthetic | `docs/benchmarks/2026-10-01-n5-forget-residue.md:90` |
| M23 | Cat 40 family E (account briefs: status + latest email/meeting) | 4-5/30 on the dev world across builds | 2026-10-04 plan | dev | gbrain-evals `docs/plans/2026-10-04-cat40-entity-recall/PLAN.md:41,284` |

Not found: any measurement of `grade_takes` verdict accuracy, `calibration_profile` faithfulness, `drift` judge precision, `enrich`/`enrich_thin` output quality, `delta` usefulness, `get_versions`/`revert_version` as a recall surface, holder-level track-record ranking, or a sealed set for any temporal/belief question.

Negative results the plan must carry forward: M3, M5, M6, M8, M14 (retraction), M15, M16 (first FAIL), M17 (tie), M19 (no movement), and the advisory-line wrong closures that keep `dream.single_value.mode` at `propose` (`docs/guides/temporal-edges.md`, "Held-out testing found wrong closures when an advisory timeline line ... counted as the start of a new job").

---

## 3. GAPS between Garry's bet and reality

G1. **No recorded-time query anywhere.** `think --reference-date 2024-03-01` still reads pages written in 2026. "What did I believe about X on March 1" cannot be answered; N3 computes recorded-time gold but only scores the page-date filter against it (M2).
G2. **Recorded time is not durable.** Fence rows have no recorded-time column; facts reconcile wipes and reinserts; `expired_at` is derived from `valid_until`; `page_versions` and `link_relationships.recorded_at/retired_at` are DB-only and the latter is a single overwritten row. A `migrate-engine` or full rebuild loses belief history.
G3. **"What changed this week" is a page list, not a belief diff.** `delta` returns slugs and timestamps; nothing reports "X's employer changed from A to B (cause: edge closure on 2026-10-03, evidence: …)". `get_versions` has no diff and no `at`.
G4. **No unified belief key.** A belief about X's employer may live in a fact, an ontology dimension, a take and a `works_at` edge; nothing links them, so a change in one does not show as a change in the others (P1 E3: corrections reach only 0.277 of surfaces).
G5. **Implicit supersession is weak by design.** `remember` without `replaces` keeps both values (M5); cosine misses ~47% of corrections on the default model (M6). Belief history built on facts alone inherits this.
G6. **Grading is unmeasured and off.** `grade_takes` writes unapplied verdicts; nobody has measured verdict precision or evidence leakage (M15). Without it, a track record is a record of hand resolutions only.
G7. **Track record is owner-only and unranked.** `calibration_profile` runs for one holder; `takes_scorecard` takes a single holder; no shrinkage for small n (profile threshold is 5 resolved takes), no decay, no skill score against a baseline, Brier mixes kinds, no "who was right about topic T" query, and think does not use holder records when weighing conflicting takes.
G8. **Takes extraction not graduated** (M12): fact/bet precision < 0.80 for every model; holder/subject confusion is the documented top error. A leaderboard over mis-typed or mis-attributed takes would be confidently wrong about people.
G9. **No refresh loop for existing pages.** Summaries are hand-written or first-sentence; `enrich` only touches thin pages and writes without review; the stale-summary note fires only for ended state relationships (one signal of many).
G10. **No per-sentence provenance in compiled truth** outside dream pages (`grounding.quotes`), so a refreshed summary has nothing to point at unless the loop adds it.
G11. **Public benchmark headroom is not where the synthetic gates are.** N1/N3/temporal-edges are at ceiling; BEAM time categories sit at 42-47% (M19) and are bottlenecked by retrieval (strict recall 18.2%), which this bet does not touch.
G12. **No sealed set for belief questions.** Every M-row for takes and history is dev or synthetic except P1 E1/E2 and P8 grounding.

---

## 4. RISKS and prior failures not to repeat

R1. **Unblinded judges.** Cat 14's 75% was retracted because the judge saw expected behaviour (M14). Any track-record or refresh-quality judge must not see gold, arm labels or notes.
R2. **Maintained answers tie fresh retrieval** (M17). Do not justify living pages on accuracy; preregister tokens per read, cost per correct read, stale-wrong rate and human accept rate as primaries.
R3. **Advisory/qualified lines misread as state changes** (M8 traps 101/115; single-value wrong closures). Belief-change detection from prose must ship propose-first with a held-out trap set.
R4. **Cosine supersession** wrongly replaced 53.75% of coexisting claims on 3-large (M6). Never derive "belief changed" from similarity alone; use explicit `replaces`, fence strikes, dated transitions or a judged conflict.
R5. **Late-recorded / boomerang merges** broke as-of before (N3 bug 1, M3). Every new history writer needs the boomerang and backdated cases in its tests.
R6. **Managed writer guard.** `ontology_propose` was refused on every default brain (N1-1) and a maintenance sweep lost acknowledged ontology writes (N1-7, fixed in #6265, gbrain-evals `TODOS.md:149`). New ledgers and refresh writes must go through the persistence coordinator and be covered by N1-ci-style lifecycle cells.
R7. **Fence format churn** creates held files (`invalid_fence`). Do not add columns to the Facts or Takes fences; keep recorded time in the DB plus git.
R8. **Purge versus history.** N5 shows forgotten text in `get_versions` (M22); GBRA-58's `forget --purge` will remove it. A belief ledger that stores claim text would be one more store to purge and one more residue finding.
R9. **Privacy.** Track records name real people; holder strings appear in op descriptions and fence comments today (§1.4 note). Remote reads must keep `takesHoldersAllowList`; published examples use placeholders.
R10. **Tool-surface bloat.** P8 found fewer advertised tools cost −8.5 points (`starter`) and −9.9 (`verbs`), and kept `full` (`p8/SEALED_VERDICTS.md`, "Advertised tool surface"). Prefer additive params on existing ops (frozen v1 verbs allow additive fields) over new top-level tools.
R11. **Budget starvation and unraced phases.** The calibration trio runs via bare `timePhase` without abort signal (TODOS.md:1904) and can be skipped every cycle by `insufficient_cycle_budget` (TODOS.md:1928). A nightly refresh phase placed late will starve the same way.
R12. **Late closures.** 41/66 edge closures are dated late (M11); a belief diff must label inferred end dates as upper bounds, not facts.
R13. **Ceilings.** N1/N3 are at 100%; they can gate regressions, not prove wins (gbrain-evals CLAUDE.md, "Report the models people use first ... Note a ceiling").
R14. **Model rules.** Counted runs use Opus 5.5, newest Sonnet and GPT; Fable smoke-only; no gpt-5.4-mini (project AGENTS.md). M12/M21 Fable rows are already marked non-counting.

---

## 5. PROPOSED WORK ITEMS

Design first, then items. Effort = human-days / agent-hours (CC+gstack). Costs use `src/core/model-pricing.ts` list prices: Sonnet 5.5 $2/$10 per M tokens (line 117), Opus 5.5 $4/$20 (108), Haiku 4.5 $1/$5 (121), GPT-6.1 Sol $2/$10 (150).

### 5.1 Design: what a belief is

A **belief** is a keyed, holder-attributed claim with a value, a confidence, a valid-time interval and a recorded-time interval:

`(subject, key, holder) → value, weight, valid [from, to), recorded [at, retracted_at), cause, origin(page, row|edge, knowledge_revision), trust_tier`

- `fact` row → holder `world` (or `attributed_to`, v215), key = ontology dimension or normalized claim hash, weight = confidence.
- `take` row → holder from the `who` cell, weight from `weight`, key = (page, row_num) chain head.
- typed relationship → holder `world`, key = (from, link_type), value = to-page, valid = stint.
- page summary → holder `brain`, key = (page, 'summary'), value = summary text hash (for living pages).

Store it as an append-only **`belief_events`** projection (one migration): `id, source_id, subject_slug, key, holder, kind(fact|take|relationship|ontology|summary), op(assert|supersede|retract|resolve|close|reopen), value_hash, value_preview(nullable, purgeable), weight, valid_from, valid_to, recorded_at, origin_page_id, origin_row, knowledge_revision uuid, cause, trust_tier (nullable until GBRA-58 lands), created_by`. Write it in the same transaction that projects facts/takes/links (`persistence/canonical-projections.ts`, `link-relationships.ts`), by diffing the old and new projection on stable identities (facts `(source_id, source_markdown_slug, row_num)`, takes `(page_id, row_num)`, relationships `(from, to, type)`). Recorded time comes from the transaction; backfill once from `page_versions` preimages, then `git log` for the brain repo (precedent: `src/core/git-first-commit.ts`), marking backfilled rows `recorded_at_quality: 'backfilled'`. Never store recorded time in the fences (R7). On purge, null `value_preview` and keep the hash (R8).

Why not page revisions alone: `page_versions` answers "what did the page say on D" well and cheaply (serve it directly, item W2), but cannot answer "what did I believe about X" across pages, holders and edges.

### 5.2 Design: query surface (additive params, no new top-level verbs)

- `known_as_of: YYYY-MM-DD[THH:MM]` (recorded time) and existing `as_of` (valid time) on `recall`, `takes_list`, `get_links`, `ontology_get`, `entity` (card shows values as known then).
- `get_page {at}` / `get_versions {at, diff: true}`: the version current at T plus a unified diff against now (reuse `repair --diff` rendering).
- `think {known_as_of}`: gather filters pages to snapshots at T (page_versions), facts/takes/edges via `belief_events`; the prompt states "Knowledge as of T" separately from `reference_date`. Refuse with `invalid_params` when T predates the ledger's coverage, and return `coverage_from` (agent operator contract).
- `delta {beliefs: true}`: grouped per subject, before → after, cause, evidence pointer, and inferred-date flags (R12). Default off so `delta`'s v1 output is byte-identical.
- CLI: `gbrain beliefs <entity> [--as-of D] [--known-as-of D] [--since 7d] [--json]`.

### 5.3 Design: graded takes into a track record

- Grade events: keep `take_grade_cache` as the judge ledger; add `take_resolution_events` only if a resolution can change (today `resolved_*` columns are overwritten on re-resolve). Every apply (human, `mcp:<client>`, judge auto-apply) emits a `belief_events` `resolve` row, which gives history without a second table. Prefer this: no extra migration.
- `track_record {holder? | domain_prefix? | topic? | subject?, since, half_life_days}` (extend `takes_scorecard` additively rather than a new op): n, accuracy with Beta(1,1)-shrunk interval, Brier, Brier skill score vs the holder's base rate and vs 0.5, calibration slope from the existing curve, exponential decay weight (default half-life 365 d, config `calibration.half_life_days`), by kind, and the 3 strongest resolved examples with page/row citations; `group_by: 'holder'` returns a ranked list (the "who has been right about X" answer), with `min_n` (default 5, matching the profile threshold) and a `low_n` flag.
- Separate sources from people: `facts.source` and `takes.source` are free text; a `source` grouping over resolved takes gives "which source has been right" without new schema.
- `calibration_profile` loops over holders with ≥ min_n resolved takes (bounded per cycle), not just the owner.
- think: when two active takes conflict, attach each holder's record line inside the `<take>` block (≈ 15 tokens each). Ship behind a flag, evaluate blind (R1).
- Trust: auto-resolve stays off until W6's precision gate passes; remote-resolved rows stay segregated (`mcp_resolved`).

### 5.4 Design: living pages

- Region: a machine-maintained summary block (frontmatter `summary` plus an optional `<!--- gbrain:summary:begin/end -->` region at the top of compiled truth). Human-written prose outside the region is never rewritten.
- Trigger (zero LLM): per entity page, a staleness score from (a) `link_relationships` status changes since last refresh, (b) new timeline rows, (c) new/superseded facts or takes with `entity_slug` = page, (d) new referrers from the mention index newer than the last refresh, (e) the existing "summary may be stale" detector. Rank by staleness × inbound links; cap per cycle.
- Evidence: #6066's `retrieveEvidence` (anchored, newest first), restricted to items newer than the base revision plus the current page.
- Proposal: rewritten summary + per-sentence footnote citations; run through the `synthesize-verify.ts` claim-unit verifier (numbers, quotes, attribution, dates must occur in cited evidence); failing sentences dropped and listed. Store in `page_refresh_proposals` (`page_id, base_knowledge_revision, proposed_text, diff, evidence jsonb, verifier_report, model, cost_usd, status proposed|applied|rejected|stale|undone, trust_tier`).
- Review: `gbrain pages refresh list|show --diff|accept|reject|undo` (CLI) and a read op for agents; accept is trusted-local/admin (it raises trust). `dream.page_refresh.mode` = `off` default, `propose` opt-in, `apply` only for certified models after a held-out pass (the E2 pattern).
- Apply via the managed coordinator with expected revision (stale if the page moved), producing a normal page version, so `revert_version` undoes it.

### 5.5 Work items

| ID | Goal (one line) | Files | Migration | Effort h-d / agent-h | Proof: metric + dataset | Paid cost |
|---|---|---|---|---|---|---|
| W1 | `belief_events` ledger written at projection time, with backfill from `page_versions` + git | new `src/core/beliefs/{ledger,backfill}.ts`, `persistence/canonical-projections.ts`, `link-relationships.ts`, `engine-sql/beliefs.ts`, `schema.sql` fragment, `engine-sql/bootstrap.ts`, doctor check `belief_ledger_coverage` | **yes**, 1 additive (table + 3 indexes + RLS) | 5 / 10-14 | N1 full + N1-ci unchanged (388/388, 0 stale); new lifecycle probe: ledger event count = fence/edge changes in every cell incl. restart, reimport, concurrent; boomerang + backdated cases | $0 |
| W2 | Recorded-time reads: `known_as_of` on recall/takes_list/get_links/ontology_get/entity; `get_page at`; `get_versions at, diff` | `ops/facts.ts`, `ops/takes.ts`, `ops/links.ts`, `ops/chronicle.ts`, `ops/admin.ts`, `verbs/entity-card.ts`, `page-state/versions.ts` | no | 4 / 8-10 | New N3-R arm in gbrain-evals: N3 seed-3 ledger's existing recorded-time oracle, 104 probes, target 104/104, plus valid-time arm unchanged at 513/513 | $0 |
| W3 | `think {known_as_of}` (evidence filtered to what was recorded by T) | `think/index.ts`, `think/gather.ts`, `think/temporal-context.ts`, `ops/takes.ts` | no | 3 / 6-8 | "Belief as-of" QA: N3 + temporal-edges ledgers rendered as notes recorded late; accuracy vs recorded-time gold, hindsight-leak rate (answer uses a fact recorded after T) target 0; Sonnet 5.5 + GPT-6.1 Sol + Opus 5.5, ~200 q | ≈ $3-6 (3 models × 200 q × ~6k in/300 out) |
| W4 | `delta {beliefs:true}` and `gbrain beliefs <entity>`: "what changed this week" as a belief diff | `ops/facts.ts` (delta), `context/turn-context.ts`, new `src/commands/beliefs.ts`, CLI table | no | 3 / 6-8 | Weekly-change probes generated from ledger recorded dates: set-F1 of changed (subject,key) per week, before/after value exact, inferred-date flagged; target F1 ≥ 0.95 synthetic; token cost vs `delta` page list reported | $0 |
| W5 | Time-model fixes found here: P1 follow-up (close at gap / record upper bound), honor `since_supplied` so late-captured takes keep valid ≠ recorded, `migrate-engine` copies `page_versions` | `cycle/edge-contradictions.ts`, `link-validity.ts`, `takes-write.ts`, `commands/migrate-engine.ts` | no | 2 / 4-6 | E2 rerun: late closures 41/66 → report; as-of exact ≥ current; migrate-engine round-trip test keeps version count | ≈ $5 for an E2 rerun on 3 counted models (est., E2 report has no cost line) |
| W6 | Measure and gate grading: `grade_takes` verdict precision and leakage | gbrain-evals new category `take-grading` (generator + runner), gbrain `cycle/grade-takes.ts` only for fixes | no | 4 / 8-10 | Synthetic ledger of propositions with known resolution dates rendered into notes (extend B4 `beliefs.ts` propositions), plus 30 human-graded predictions (as proposed in the May report, line 131); metrics: wrong applied resolution ≤ 1% at the 0.95 auto-apply threshold, unresolvable when evidence predates resolution, coverage; preregistered; counted models Opus 5.5, Sonnet 5.5, GPT-6.1 Sol plus default | ≈ $5-15 (est. ~1.5k in/150 out per take ≈ $0.0045 on Sonnet 5.5; 1,000 takes × 3 models) |
| W7 | `track_record` (extend `takes_scorecard`): group_by holder/source, shrinkage, decay, skill score, citations; multi-holder `calibration_profile` | `ops/takes.ts`, `engine-sql/takes.ts`, `takes-resolution.ts`, `cycle/calibration-profile.ts`, `calibration/domain-aggregators.ts` | no | 4 / 8-12 | Synthetic world with holders of known skill (calibrated / overconfident / contrarian / random): Spearman ρ between computed and true skill ≥ 0.8 at n ≥ 10 resolved each; "who was right about T" set-F1; B4 beliefs suite (#69) as the chat-derived arm; privacy: N6-style remote probes with holder allow-lists | $0 hermetic; B4 arm inside #69 budget |
| W8 | think uses holder records when takes conflict (flag, report-only first) | `think/gather.ts`, `think/sanitize.ts` (`<take>` block), `think/prompt.ts` | no | 2 / 4-6 | Cat 14-style blind A/B, both orders, judge from another family, 40+ probes, plus a degraded arm (shuffled records) for the negative-control rule | ≈ $3-8 |
| W9 | Living-page refresh loop (propose mode) | new `cycle/page-refresh.ts`, `src/core/page-refresh/{trigger,evidence,propose,apply}.ts`, reuse `cycle/synthesize-verify.ts`, `questions/refresh.ts` `retrieveEvidence`, `commands/pages-refresh.ts`, ops read op, doctor check | **yes**, 1 additive (`page_refresh_proposals`) | 7 / 14-20 | New category `living-pages`: entity worlds with dated changes after the summary was written; primaries: stale-summary rate (summary asserts an ended/superseded value) vs baseline, E3-style correction coverage (0.277 today), unsupported-sentence rate ≤ 2% (verifier + blind judge), unchanged-sentence preservation, human accept rate on 50 blinded proposals; secondary: Cat 40 family E (4-5/30 today) and tokens delivered per entity question at equal accuracy | ≈ $0.017/page refresh on Sonnet 5.5 (6k in/500 out, est.); eval ≈ $15-40 for 3 counted models; Cat 40 rerun cost not read (see `scripts/cat40-followups.sh` in gbrain-evals) |
| W10 | Per-sentence provenance render + review UX for refreshed blocks (footnotes to page/row/edge), and `revert_version` undo path | `markdown.ts`, `page-refresh/apply.ts`, `link-extraction.ts` (footnote targets must not create links twice) | no | 2 / 4-6 | Round-trip tests: provenance survives sync/reimport, no duplicate links, held-file count unchanged on the fixture brain | $0 |
| W11 | Sealed confirmation for belief questions | gbrain-evals: custodian-minted set from W3/W4/W9 generators with a new seed; preregistration first | no | 2 / 4 | Same metrics as W3/W4/W9 on sealed data, single custodian run | ≈ $10-20 |
| W12 | Public-benchmark check of bet 4 | gbrain-evals BEAM runner | no | 1 / 2 | BEAM-1M (and 10M via GBRA-49's scoreboard) knowledge-update, temporal, event-ordering categories with `known_as_of`/belief diff available to the reader; report-only because retrieval is the bottleneck (M19) | ≈ $3-5 per BEAM-1M answer arm (M19 spent $1.14 per arm with gpt-4.1-mini; counted models cost more) |

Order: W1 → W2 → W4 (cheap, $0, synthetic gates) → W5 → W6 → W7 → W3/W8 → W9 → W10 → W11/W12. W6 must pass before any auto-resolve or public "track record" claim. W9 ships `off`/`propose` only until W11.

How each maps to Garry's 10x framing: W2/W3/W4 are capability (d) nobody else ships on human-readable Markdown, and also (b) tokens (a belief diff or a card as known on D is far smaller than a full evidence pack); W6/W7/W8 target (a) fewer confident wrong answers about who to trust; W9 is (d) plus (b) (M17: a maintained answer costs $0.00057 per correct read against $0.00284 for full evidence at 100 reads/write) and (a) via stale-wrong rate (M17: 11.6% → 0% from anchoring alone).

---

## 6. OVERLAPS with in-flight threads and PRs

| Thread / PR | What it changes | Overlap with this bet | Recommendation |
|---|---|---|---|
| **GBRA-58**, issue #5575 (trust tiers, write gate, `forget --purge`); plan not yet written (thread status waiting, no PR) | `trust_tier` on facts, takes, pages, chunks; I2 taint = min(inputs); I3 lower tier cannot supersede higher (becomes a pending proposal); purge removes content from every store with a receipt | (1) Every `belief_events` row needs `trust_tier`; I3 creates a new event type (`supersede_blocked` / proposal). (2) A refreshed summary is `model_inferred` at best and inherits min(evidence tiers) (I2); it must never overwrite `user_confirmed` text, which W9's region design ensures. (3) Purge must reach `page_versions`, `belief_events.value_preview`, `page_refresh_proposals` and `take_grade_cache` evidence; tombstone hashes keep history counts consistent. (4) Both touch `persistence/canonical-projections.ts`, `page-prepare.ts`, `sync-prepare.ts`. | Land GBRA-58's tier columns first or design `belief_events.trust_tier` nullable and backfilled by its migration; add the ledger and proposal tables to its purge store list and to its BrainBench `deletion` suite; reuse its pending-proposal lane for blocked supersessions. |
| **GBRA-52**, gbrain #6066 + gbrain-evals #69 (memory proof wave; BEAM sealed runs in progress) | per-model supersession thresholds (`facts/supersession-threshold.ts`), interleaved candidates (opt-in), dated evidence header (`search/evidence-date.ts`), pinned questions (`src/core/questions/*`, migration v220), entity-anchored retrieval; evals #69 workload suites B3 time-and-relationships and **B4 beliefs** (holder, weight change, resolved set, resolved one; 25 histories × 6 questions, `eval/workload-suites/beliefs.ts`) | Supersession decisions are belief events (W1 must record `threshold_model` and "left to conflict review"); pinned questions are the living-answer precedent and their B5 tie (M17) is this bet's main risk; `retrieveEvidence` is W9's evidence source; the evidence date header is what a `known_as_of` reader needs; B4 is a ready dataset for W7, B3 for W2/W3. Migration number v220 is taken on that branch; master is at v219. | Do not start W9 until #6066 merges (reuse, not copy, `retrieveEvidence`); pick migration numbers at merge time; run W7's chat arm through #69's harness rather than a new one. |
| **GBRA-39**, gbrain #6271 (Cat 40 Hard fixes) + evals #76/#93/#77 | every name an entity goes by, keyword counts, rerank/write failures named, remember reliability | Holder and subject resolution for track records depend on alias handling; Cat 40 family E (account briefs) is W9's downstream metric; Cat 40 Hard (#76: gbrain trails plain files by 11.3 points on a 55,000-document company) is where token-cost claims for living pages would be tested. | Use #6271's alias resolution for holder normalization; schedule W9's Cat 40 measurement after #6271 lands. |
| **GBRA-45**, branch `capy/sync-feeder-fast-writes` | sync and put_page fast path (`coordinator.ts`, `page-mutations.ts`) | W1 writes the ledger inside projection transactions; W9 applies proposals through the coordinator. | Build W1/W9 on top of GBRA-45 after it merges; add ledger writes to its fast-path tests. |
| **GBRA-59**, plan for #6278 (managed sync stall; preparation without deadline; `fence_repair` `owner_unavailable`) | persistence preparation deadlines, lease renewal | A nightly `page_refresh` phase adds managed maintenance writes that could hold the root lease the same way. | Gate W9's phase on GBRA-59's fix; give refresh writes the same preparation deadline as `put_page`. |
| **GBRA-49** Q2 parser gaps (evals #88, gbrain branch `capy/q2-parser-gaps`) and Q1 scoreboard with BEAM-10M | typed relation line grammar (`line_grammar.enabled`), six relationship-typing units, temporal-edges transition-identity metrics | Link typing is the ceiling on relationship belief history (M10: 0.277, "Signed on with [X] as CTO" not typed). Transition-identity metrics overlap W1's relationship events. BEAM-10M is W12's long-horizon public set. | Reuse #88's transition-identity metrics in W1 tests; run W12 on GBRA-49's scoreboard. |
| Contributor PRs #5552 (remember graded confidence, @wesleymatosdev) and #5086 (think date window from an explicit question date, @tarush1989) | `remember` `confidence` param; temporal window derivation | #5552 matters for belief weights from `remember`; #5086 overlaps W3's think time handling. | Never merge directly; fold into a fix-wave PR with credit if adopted (project AGENTS.md "Shipping in gbrain"). |
| Earlier plans | 2026-09-28 10x plan items 14 (contradiction flow) and 15 (as-of in think/search); 2026-10-01 knowledge-layer proposal ("True now" row) | Same gaps as G1/G3/G4. | Cite and supersede; do not re-plan from scratch. |

## 7. Open questions for the plan owner

1. Should recorded-time history be a supported guarantee across `migrate-engine` and fresh imports (requires the git backfill in W1), or best-effort from the ledger's start date?
2. Is a ranked "who has been right" list about real people acceptable for remote MCP callers at all, or trusted-local only until GBRA-58 tiers exist?
3. For living pages, which primary metric decides default-on: stale-summary rate, tokens per entity question, or human accept rate? M17 says accuracy alone will not move.
