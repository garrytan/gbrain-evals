# Nine-plan held-out program: starting line, preregistrations, verdicts and scorecard

This report collects one feature program for [gbrain](https://github.com/garrytan/gbrain), a memory system for agents. Eight feature plans (P1 to P8) each change gbrain in one pull request. P0 is the evaluation plan: it measures the starting line on gbrain master and runs the held-out harness every other plan uses. Each feature idea has a preregistered decision rule, a development verdict on data the implementer may see, and a held-out verdict on sealed data that only the custodian opens. The held-out verdict sets the idea's default.

Status on 2026-10-05: 14 held-out decisions are in. Six ideas pass and ship on: dated relationships, the certified nightly contradiction check, date-grounded extraction, the multi-relation planner, the zero-model write guard and the review-gated withdrawal. Seven P5 hypotheses pass while P5's remaining cells run. Five ideas lose or miss their gate, and each one ships off, ships in a safer mode or leaves its pull request. The remaining ideas wait on sealed runs.

## How the program decides a default

1. **Preregistration first.** Each plan writes its arms, metrics, pass bars and default rule before any sealed cell runs. A change after that point is recorded as an amendment with its date and reason, or as a decision when it comes after a sealed result.
2. **Development data guides the work.** Development verdicts use the shared dev splits and seeds. They never set a default.
3. **The custodian runs the sealed cells.** The custodian holds the sealed questions, held-out phrasings and seeds on its own machine, logs every opening, and publishes aggregates only. The implementer never sees sealed text or row-level answers.
4. **The verdict sets the default.** An idea that measurably wins turns on (when its prerequisite, such as a provider key, is present). An idea that loses, is inconclusive or misses a precondition ships off, or leaves the pull request when its preregistration says so.
5. **A failed held-out set is spent.** A fix after a held-out failure is developed on new development data and judged on fresh sealed material.

Raw sealed rows, held-out phrasings, seeds' generated text and labels stay in custody. The custodian's aggregate verdict files are in [`2026-10-05-heldout-verdicts/`](2026-10-05-heldout-verdicts/README.md). Each plan's own record lives in its gbrain pull request under `docs/eval/decisions/`.

## The starting line on master

Measured by P0 on 2026-10-04 at gbrain master `6622a119e` (v0.60.48.0), before any of the eight plans merged. Retrieval is `hybridSearch` with query expansion off, reranker off and autocut off, `text-embedding-3-large` at 1,536 dimensions, top five distinct sessions. All rows come from development splits, so they carry no sealed material.

| Benchmark (split) | Questions | Retrieval: recall of all gold sessions at 5 | Answer accuracy | Reader and judge |
|---|---|---|---|---|
| LongMemEval-S (all 500, dev by design) | 500 (470 with gold sessions) | **92.8%** | **85.6%** | `gpt-4o-2024-08-06` reader and judge, official per-type prompts |
| LoCoMo (dev, 3 conversations) | 587 (464 answerable) | 75.6% | **67.5%** all questions; 68.5% answerable | `gpt-4o-mini` reader, `gpt-4o-2024-08-06` judge |
| LoCoMo adversarial questions (dev) | 123 | n/a | **63.4%** abstain correctly; 42.3% repeat the planted false answer | as above |
| BEAM-100K (dev, 6 conversations) | 120 (108 with gold) | **45.4%** (any gold session: 80.6%) | 57.1% | `gpt-4.1-mini` reader and per-rubric-item judge |
| BEAM-1M (dev, 11 conversations) | 220 (198 with gold) | **18.2%** (any gold session: 68.7%) | 54.6% | `gpt-4.1-mini` reader and per-rubric-item judge |

Recall of all gold sessions at 5 asks whether every session needed for the answer is in the top five. It is the strict retrieval number. Answer accuracy is the judged share of correct answers over every question in the split, including abstention questions. LongMemEval-S cannot be held out by re-splitting (its 500 questions are public and were used in earlier tuning), so it serves as a regression check; LoCoMo, BEAM and the program's seeded worlds provide the sealed sets.

BEAM-1M is a conversation history far too large to paste into a prompt, and strict recall there is 18%. That makes it the clearest place for a retrieval improvement to show.

The receipts, per-question rows and the recount script are in [`2026-10-05-heldout-program/starting-line/`](2026-10-05-heldout-program/starting-line/). Starting-line spend was $32.09.

## Program scorecard

One row per idea. "Held-out verdict" is the custodian's sealed result against the preregistered bar. "Default" is what the idea ships with.

| Plan | Idea | Setting | Held-out verdict | Default | gbrain PR |
|---|---|---|---|---|---|
| P1 | Dated typed relationships with live-only reads and as-of queries | `graph.edge_validity` | Round 1 **FAIL** (traps 101/115, recall −4.9 and −6.2 points); round 2 **PASS** on fresh phrasing | on | [#6018](https://github.com/garrytan/gbrain/pull/6018), merged, v0.60.57.0 |
| P1 | Nightly contradiction check closes superseded relationships | `dream.edge_contradictions.mode` | **PASS** for all five judge models (0 wrong closures) | `apply` for the five certified models, `propose` for others | #6018 |
| P1 | Corrections reach every read surface (E3) | none | report-only | none | #6018 |
| P2 | Hub dampening of high-degree pages in ranking | `search.hub_dampening` | pending; development predicts a fail | off | [#6020](https://github.com/garrytan/gbrain/pull/6020), draft |
| P2 | Date-grounded fact extraction | `extraction.date_grounding` | **PASS** (unresolved relative dates 8.95% → 2.05%, QA +1.2 points) | on | #6020 |
| P2 | Speaker attribution for saved facts | `facts.attribution` | pending (Amendment 2 set) | off until the sealed run | #6020 |
| P2 | Per-arm score explain and missing-page diagnosis | none | not gated (diagnostic output) | n/a | #6020 |
| P3 | Use-attributed feedback weights from explicit ratings | `feedback.enabled` | world-v1 **PASS** (+2.04 NDCG@10 points); LoCoMo **FAIL** (−0.12, CI crosses 0) | off (opt-in), by decision | [#6014](https://github.com/garrytan/gbrain/pull/6014), merged, v0.60.63.0 |
| P3 | Implicit citation signal | `feedback.implicit` | not run (gated on E1 passing both corpora) | off | #6014 |
| P3 | Relational triplet scoring | `search.triplet_scoring` | **FAIL** (relational arm fired on 17% of questions, bar 80%) | removed | #6014 |
| P3 | Declared single-value relations close the older value | `dream.single_value.mode` | **FAIL** (3 wrong closures, bar 0) | `propose` | #6014 |
| P4 | Save-before-compaction notice and batched `remember` | `memory.pressure.enabled` | pending (BEAM-500K sealed) | off until the sealed run | [#6015](https://github.com/garrytan/gbrain/pull/6015), draft |
| P4 | Always-loaded core memory tier | `memory.core.enabled` | pending (BEAM-100K sealed preference and instruction questions) | off until the sealed run | #6015 |
| P5 | Typed relation lines (`- works_at [[companies/x]]`) | `line_grammar.enabled` | H1 **PASS**, H2 **PASS**; H3 and H6 pending | off until H3 and H6 | [#6017](https://github.com/garrytan/gbrain/pull/6017), draft |
| P5 | Wanted pages for unresolved links | `wanted_pages.enabled` | H4 local **PASS** (0 of 3,738 edges lost) | set when P5's first run completes | #6017 |
| P5 | Similar-page hint on create | `put_page.similar_pages` | H5a **PASS**; H5b pending | set when P5's first run completes | #6017 |
| P5 | Validity ranges on relation lines | `line_grammar.effective_ranges` | H7 **PASS** | on once the LongMemEval-S guardrail holds | #6017 |
| P5 | Wanted rows from remote writes | `wanted_pages.remote` | H8 not run (waits on the build with gbrain#6025) | off | #6017 |
| P5 | Link-typing changes after the edge-validity merge | none | H9 **PASS** | kept | #6017 |
| P5 | Advisory and board roles are not employment starts | none | H10 **PASS** (36 → 0 extra employment starts) | kept | #6017 |
| P6 | Time-aware search | not yet published | held-out run in progress | n/a | no PR yet |
| P7 | Multi-relation query planner | `search.relational_planner` | **PASS** (24 better, 0 worse; +27 points strict all-hit@10) | on in `balanced` and `tokenmax` | [#6019](https://github.com/garrytan/gbrain/pull/6019), merged, v0.60.60.0 |
| P7 | One-hop orientation | `search.relational_orient_onehop` | does not meet its rule (1 better, 0 worse, p = 1.0) | off | #6019 |
| P8 | Zero-model write guard, write cost published | guard always on | **PASS** (0 commit-path generative attempts in both arms) | on | [#6027](https://github.com/garrytan/gbrain/pull/6027), draft |
| P8 | Review-gated semantic withdrawal | `decide.slots.conflict.review_withdraw` | **PASS** (precision lower bound 0.970, recall 0.977) | on where the conflict slot is on | #6027 |
| P8 | Quote grounding in `think` and dream writers | `think.quote_verify`, `dream.quote_verify` | **FAIL** (4.70% of supported quotes flagged, Wilson upper 7.61%, bar 5%) | off (opt-in) | #6027 |
| P8 | Advertised tool surface for new installs | `mcp.advertised_surface` | pending | `full` | #6027 |
| P8 | Duplicate review kinds | `review_duplicate_page`, `review_duplicate_entity` | not run until P1 and P5 enqueue candidates | off | #6027 |
| P8 | `remember.replaces` | none | no sealed run (conformance and race tests) | on | #6027 |

The P8 pull request's own record still lists the withdrawal review as pending; the custodian's verdict above is the newer result. The P3 raw-query routing guard in #6014 has no preregistered experiment and no default rides on it.

## Plan records

Each section lists the preregistration, the development verdicts and every held-out verdict so far, with links to the records in the gbrain pull request.

### P1: dated typed relationships

gbrain [#6018](https://github.com/garrytan/gbrain/pull/6018) (merged, v0.60.57.0). Records: [round 1](https://github.com/garrytan/gbrain/blob/master/docs/eval/decisions/p1-dev-2026-10-04/README.md), [round 2](https://github.com/garrytan/gbrain/blob/master/docs/eval/decisions/p1-dev-2026-10-04-r2/README.md), [E2 certification](https://github.com/garrytan/gbrain/blob/master/docs/eval/decisions/p1-e2-2026-10-05/README.md).

A relationship such as "works at Acme" gets a start and an end date. Reads of "who works at Acme now" use only live relationships, and "where did Alice work on date D" reads the relationship that was valid on D. The decisive workload is the temporal-edges category: seeded people with employment histories written as timeline prose, plus trap lines (investments, alumni meetings, advisory roles) that must not move employment.

**Preregistration.** E1 decides `graph.edge_validity`: now-precision +0.10, as-of +0.15, during-year F1 +0.15 and stale-summary correction +0.20 (each a superiority gate with a cluster-bootstrap interval above zero), current-employer and live-edge recall non-inferior within 0.02, traps at least 99%, write-order invariance on every item. E2 certifies `apply` mode per judge model: wrong closures at most 1% in all three runs and as-of at least 10 points above the E1 arm. E3 checks that a correction reaches each read surface and carries no bar.

**Development.** Round 1 passed every temporal-edges gate on phrasing set A (traps 0.446 → 1.000, now-precision 0.343 → 1.000). Round 2 passed on sets A, A2 and A3, which were written after the round-1 held-out failure without sight of the held-out phrasing.

**Held-out verdicts.**

| Decision | Material | Result | Verdict |
|---|---|---|---|
| E1 round 1 ([file](2026-10-05-heldout-verdicts/p1-e1-heldout-2026-10-04.json)) | phrasing set B, seeds 11, 13, 17 | traps 101/115 (investment after exit 37/43, alumni meeting 29/37, advisor 35/35); current-employer recall −0.049 [−0.080, −0.022]; live-edge recall −0.062 [−0.096, −0.029]; now-precision 0.357 → 0.710 | **FAIL** |
| E1 round 2 ([file](2026-10-05-heldout-verdicts/p1-e1-r2-heldout-2026-10-04.json)) | fresh phrasing set C, same seeds | now-precision 0.376 → 0.943; as-of 0.208 → 0.678; during-year F1 0.455 → 0.653; correction 0 → 0.364; recall −0.004 and −0.005 (non-inferior); traps 115/115; invariance 240/240 | **PASS** |
| E2 ([file](2026-10-05-heldout-verdicts/p1-e2-r2-heldout-2026-10-04.json)) | set C joins-only ledger | 0 wrong closures in all 15 runs (`claude-haiku-4-5`, `claude-sonnet-5-5`, `claude-opus-5-5`, `claude-fable-5-1`, `gpt-6.1-sol`); as-of +0.111 to +0.115 over the E1 arm; 0 undated pairs closed | **PASS** for all five |
| E3 ([file](2026-10-05-heldout-verdicts/p1-e3-r2-heldout-2026-10-04.json)) | set C, 155 people per surface | correction shown correctly: entity and context pack 27.7%, compiled context 27.7%, ambient turn context 23.9%, `query` 0% (baseline 0% everywhere) | report-only |

Round 1's cause is recorded in the round-2 record: the build overfit set A. Start and end cues anywhere on a line moved employment even on investing, meeting and event lines; past-tense prose closed dated starts at an unknown date; and some transitions ("moved from A to B", "started at X") were missed. Round 2 fixes the rules, not the wording, and passed on phrasing it had never seen. In E2 all five models sit at the same ceiling, so the result certifies `apply` as safe with each of them; it does not rank them. 41 of 66 closures are dated after the true end, which is late, not wrong.

### P2: hub dampening, date-grounded extraction, speaker attribution

gbrain [#6020](https://github.com/garrytan/gbrain/pull/6020) (draft). Preregistration: [`2026-10-04-p2-ranking-extraction-preregistration.md`](2026-10-04-p2-ranking-extraction-preregistration.md) with Amendment 1 (E2 moves to sealed LoCoMo through the facts lane, correctness-primary) and Amendment 2 (E3 uses 60 sealed synthetic conversations in five speaker-case families). Records at the PR head: [date grounding](https://github.com/garrytan/gbrain/blob/cec83da49e6f5c40f844e17e2c1d538fcec972bc/docs/eval/decisions/p2-date-grounding-dev/README.md), [attribution](https://github.com/garrytan/gbrain/blob/cec83da49e6f5c40f844e17e2c1d538fcec972bc/docs/eval/decisions/p2-attribution-dev/README.md), [attribution gate](https://github.com/garrytan/gbrain/blob/cec83da49e6f5c40f844e17e2c1d538fcec972bc/docs/eval/decisions/p2-attribution-gate-dev/README.md), [hub dampening](https://github.com/garrytan/gbrain/blob/cec83da49e6f5c40f844e17e2c1d538fcec972bc/docs/eval/decisions/p2-hub-dampening-dev/README.md).

**Date-grounded extraction** rewrites a relative time phrase in a saved fact ("last week") as the absolute date it refers to. The primary metric is the share of saved facts that still hold an unresolved relative phrase.

| Stage | Data | Result |
|---|---|---|
| Development | LoCoMo dev (3 conversations), LongMemEval-S temporal | unresolved 6.9% → 1.3% (LoCoMo) and 6.8% → 2.3% (LongMemEval-S), audit rows excluded; QA inconclusive |
| Held-out ([file](2026-10-05-heldout-verdicts/p2-e2-heldout-2026-10-04.json)) | 7 sealed LoCoMo conversations, 1,076 questions, 2 extractions per arm, 10 reader and judge replicates | unresolved 8.95% → 2.05% (−77% relative, CI [−8.3, −5.5] points); temporal QA +0.8 [−1.2, +2.7] (guard ≥ −3, pass); overall QA +1.2 [+0.6, +1.7]; recall@5 unchanged; facts per conversation −0.3%. **PASS**, $132.43 |

**Speaker attribution** saves what the assistant said as its own facts ("Assistant recommended …"). The development gate showed saved facts trailing pages by 73.3 points on questions about the assistant's side; with attribution on, single-session-assistant accuracy rose 23.3% → 60.0% (+36.7 [+20.0, +53.3]) and single-session-user stayed at 73.7%. The sealed E3 run under Amendment 2 is pending.

**Hub dampening** lowers the ranking boost a page gets from a very high inbound link count. On the development hub-heavy world (seed 1, 32,652 pages, four hubs of 5,000 to 30,000 inbound links), every half degree raises concept recall (+1.4 to +3.0 nDCG@5 points) but loses most hub-as-answer recall (−78.5 to −83.0), and both controls (backlink boost removed, boosts capped at +2%) beat it on concept recall. Development predicts a held-out fail; under the preregistration the setting then stays off and the search-side mechanism leaves the pull request. The sealed run (seeds 2 and 3) is pending.

### P3: retrieval feedback, triplet scoring, declared single-value relations

gbrain [#6014](https://github.com/garrytan/gbrain/pull/6014) (merged, v0.60.63.0). Records: [preregistration](https://github.com/garrytan/gbrain/blob/master/docs/eval/decisions/p3-retrieval-feedback/PREREGISTRATION.md), [held-out verdicts](https://github.com/garrytan/gbrain/blob/master/docs/eval/decisions/p3-retrieval-feedback/VERDICTS.md).

**Preregistration.** Feedback influence λ is fixed at 0.1 (0.05 and 0.2 exploratory). E1 replays oracle ratings and is evaluated per corpus; "E1 passes" needs both corpora. E2 tests the implicit citation signal and runs only if E1 passes both. E3 is the no-regression guard. E4 decides `search.triplet_scoring` with a precondition that the relational arm fires on at least 80% of constrained questions and a bar of +2.0 NDCG@10 points. E5 decides whether `dream.single_value.mode` defaults to `apply`: 0 wrong closures, undated and same-date conflicts left open, no as-of regression.

**Development.** At λ = 0.1 a citation raises a page's multiplier by about 0.25% per citation, at most 5%, and does not change what `think` gathers. LongMemEval-S (all 500) returns identical retrieval lists with feedback on, read latency +0.6 ms.

**Held-out verdicts.**

| Decision | Material | Result | Verdict |
|---|---|---|---|
| E1 world-v1 ([file](2026-10-05-heldout-verdicts/p3-e1-heldout-2026-10-04.json)) | 72 sealed base questions, trained on all 73 dev questions | +2.04 NDCG@10 points [+1.03, +3.28], 38 better and 5 worse; exposure-frequency arm −1.50; cold-start +1.44; `advises` category −2.0 (6 rows) | **PASS** |
| E1 LoCoMo (same file) | 7 sealed conversations, train and score halves inside each | −0.12 [−1.02, +0.61]; cold-start −3.0 (16 rows) | **FAIL** |
| E2 | | not run, per the gate | n/a |
| E4 ([file](2026-10-05-heldout-verdicts/p3-e4-heldout-2026-10-04.json)) | 218 constrained questions, custodian phrasing B, seeds 41, 53, 67 | relational arm fired on 17.0% (who-at-topic 3.3%, portfolio-by-sector 47.2%, attendees-by-role 0%); +0.39 [+0.09, +0.81]; 1 hit@1 win, 0 losses | **FAIL** (precondition) |
| E5 ([file](2026-10-05-heldout-verdicts/p3-e5-heldout-2026-10-05.json)) | P1 phrasing set C, seeds 11, 13, 17 | 3 of 3 applied closures wrong; now-precision 0.943 → 0.913 [−0.086, 0], non-inferiority not shown; as-of, during-year F1, traps and invariance unchanged | **FAIL** |

Exploratory λ = 0.2 gives +5.45 on world-v1 and −2.23 on LoCoMo. The preregistration did not say whether the cold-start and category clauses belong to E1's pass bar. Garry chose on 2026-10-05, after the sealed results, that E1's bar is the clause labelled E1, so feedback ships with `feedback.enabled=false` (opt-in, explicit ratings only). The P3 record states this as a decision, not a preregistered outcome.

E4's cause: the one-hop relational parser keys on exact surface forms, so reworded questions skip the relational arm and triplet scoring never acts on them. E5's cause: the employment-start cue `EMPLOYMENT.start` also matches "took an advisory role with X", so an advisory line on a page that asserts `works_at` to X becomes a newer employment start, and the single-value rule closes the real current employer. P5's `NOT_EMPLOYMENT_ROLE` guard removes that start (P5 H10 below).

### P4: core memory and save before compaction

gbrain [#6015](https://github.com/garrytan/gbrain/pull/6015) (draft). Records at the PR head: [preregistration](https://github.com/garrytan/gbrain/blob/66956a3ee1617a6c6a462c8acb8a153b87a49893/docs/eval/CORE_MEMORY_PREREGISTRATION.md), [streaming dev pilot](https://github.com/garrytan/gbrain/blob/66956a3ee1617a6c6a462c8acb8a153b87a49893/docs/eval/decisions/p4-stream-dev-pilot/README.md), [kit dev verdict](https://github.com/garrytan/gbrain/blob/66956a3ee1617a6c6a462c8acb8a153b87a49893/docs/eval/decisions/p4-dev-2026-10-04/verdict.json).

The harness (`eval/runner/p4-stream/`) streams a conversation into an agent with a 32k-token window through gbrain's real Claude Code hooks and forces compaction. Arm B gets a growth-aware save notice before compaction and `remember` with `items`; arm C loads a question-blind standing-preferences page as core memory every session; arm A′ is master. The pressure gate (E1) is all 24 sealed BEAM-500K conversations (480 questions); the core gate (E1-core) is the 56 sealed BEAM-100K preference-following and instruction-following questions.

Development: early LongMemEval-S B results ran with two faults (batched `remember` refused per-item provenance, and the 700-token reply cap cut batched tool calls to empty arguments), so they are not evidence for or against the feature. Both faults are fixed. The sealed runs are pending.

### P5: typed relation lines, wanted pages, similar-page hint

gbrain [#6017](https://github.com/garrytan/gbrain/pull/6017) (draft). Records at the PR head: [first-run preregistration](https://github.com/garrytan/gbrain/blob/460b6e7be3e2200dfe9beec637d0f11417aee874/docs/eval/decisions/p5-dev-2026-10-04/preregistration.md), [dev results](https://github.com/garrytan/gbrain/blob/460b6e7be3e2200dfe9beec637d0f11417aee874/docs/eval/decisions/p5-dev-2026-10-04/dev-results.md), [delta preregistration](https://github.com/garrytan/gbrain/blob/460b6e7be3e2200dfe9beec637d0f11417aee874/docs/eval/decisions/p5-delta-2026-10-05/preregistration.md).

P5 is decided in two sealed runs: the first on frozen build `21befeb5b` and a delta run on `011bd0b6a` for pieces that landed after the freeze. `line_grammar.enabled` needs H1, H2, H3 and H6.

| Hypothesis | Material | Result | Verdict |
|---|---|---|---|
| H1 link typing ([file](2026-10-05-heldout-verdicts/p5-heldout-2026-10-05.json)) | world-v1, 240 pages | any-type match 0.493 → 0.493; type accuracy 0.747 → 0.767; 240/240 pages identical with the grammar on and off | **PASS** |
| H2 relation lines reach the graph | template set B, seeds 29, 37, 43 | typed recall 0.811 → 1.000; 0 decoy types added (120 decoys) | **PASS** |
| H4 forward references (local) | seeds 31, 47, 59 | edges lost 1,849/3,810 → 0/3,738; withheld recall 0 → 1.000; non-entity share 0 | **PASS**; HTTP arm not measurable (first sweep fails with `writer_coordinator_required` in both builds) |
| H5a similar-page hint | name pools, seeds 23, 41, 61 | lexical recall@3 0 → 0.980; solvable recall@3 0 → 0.815; hint on no-referent names 4.7% (192 names) | **PASS** |
| H3, H5b, H6 | | runners built after the first run; sealed cells pending | pending |
| H7 validity ranges ([file](2026-10-05-heldout-verdicts/p5-delta-heldout-2026-10-05.json)) | P1 set C stints as relation lines | as-of on range pages 0.228 → 1.000 [+0.695, +0.846]; live 1.000 → 1.000; prose pages identical 123/123 | **PASS** |
| H8 remote wanted rows | | waits on the build with gbrain#6025 | not run |
| H9 typing changes | template set B, seeds 71, 79, 83; set C | any-type match 0.506 → 0.506; live recall 0.555 → 0.560 | **PASS** |
| H10 advisory-role guard | set C plus 108 probe people | extra employment starts: guard 0, no guard 36; every P1 gate identical with and without the guard; report-only wrong closures on P3's master build 54 → 0 (probe) and 3 → 0 (set C) | **PASS** |

Guardrails: N4 entity resolution passes with 0 wrong merges on both builds. The LongMemEval-S guardrail is pending.

### P6: time-aware search

No gbrain pull request yet. The held-out run is in progress; its preregistration and verdict land here when the pull request opens.

### P7: multi-relation query planner

gbrain [#6019](https://github.com/garrytan/gbrain/pull/6019) (merged, v0.60.60.0). Preregistration: [`2026-10-04-p7-multi-hop-planner-preregistration.md`](2026-10-04-p7-multi-hop-planner-preregistration.md), scored by [`heldout-verdict.ts`](2026-10-04-p7-multi-hop-planner/heldout-verdict.ts). Records: [dev](https://github.com/garrytan/gbrain/blob/master/docs/eval/decisions/p7-dev-2026-10-04/README.md), [held-out](https://github.com/garrytan/gbrain/blob/master/docs/eval/decisions/p7-heldout-2026-10-05/README.md).

The planner answers questions that chain two or three relationships ("who founded the companies Alice invested in?") with deterministic chain templates over typed edges. Development: on all 500 LongMemEval-S questions the planner plans none, and recall and latency are unchanged.

Held-out ([file](2026-10-05-heldout-verdicts/p7-heldout-2-2026-10-04.json)), N9 v1 composed set, second opening, build `94bd52e01`: **PASS** on benefit gates 1 to 6.

| Gate | Result |
|---|---|
| Sign test, paraphrase questions | 24 better, 0 worse, p = 1.2 × 10⁻⁷ |
| Strict all-hit@10, five typed families | 0 → 27.0% (reranker off), 1.1% → 28.1% (reranker on) |
| Safety | chain answer precision 0.83, edge-evidence correctness 0.85; non-gold pages above the first gold page 3.31 → 0.09 |
| One-hop regression | 0 questions worse |
| False fire | 0 of 500 LongMemEval-S, 0 of 77 non-relational, 0 of 50 concept queries |

The planner plans 70% of plainly worded questions and 21% of reworded ones, the same surface-form limit P3's E4 found in the one-hop parser. `search.relational_orient_onehop` stays off: 1 better, 0 worse (p = 1.0) does not meet its rule. All P7 sealed cells cost $5.05.

### P8: write guard, semantic withdrawal, quote grounding, advertised surface

gbrain [#6027](https://github.com/garrytan/gbrain/pull/6027) (draft). Records at the PR head: [preregistration](https://github.com/garrytan/gbrain/blob/14f5eb06326b60c78d4a28182ea5053ebd0a645b/docs/eval/decisions/p8/PREREGISTRATION.md), [dev results](https://github.com/garrytan/gbrain/blob/14f5eb06326b60c78d4a28182ea5053ebd0a645b/docs/eval/decisions/p8/DEV_RESULTS.md), [held-out verdicts](https://github.com/garrytan/gbrain/blob/14f5eb06326b60c78d4a28182ea5053ebd0a645b/docs/eval/decisions/p8/SEALED_VERDICTS.md). Dev receipts: [`2026-10-04-p8-dev/`](2026-10-04-p8-dev/).

| Part | Material | Result | Verdict |
|---|---|---|---|
| Write cost ([file](2026-10-05-heldout-verdicts/p8-write-cost-2026-10-05.json)) | 1,000 LongMemEval-S sessions per arm, 10,313 messages | commit-path generative attempts 0 in both arms; fact extraction on $9.94 per 1,000 pages ($0.96 per 1,000 messages), off $0.32 ($0.03); extraction jobs drain in 78 minutes on PGLite | **PASS** |
| Semantic withdrawal review ([file](2026-10-05-heldout-verdicts/p8-withdraw-heldout-2026-10-05.json)) | 240 families, 1,680 candidates, disjoint name and value pools | action precision lower bound 0.970 (124/124 families); end-to-end recall 0.977; 0 proposals on corrected values; N5 contracts pass | **PASS** |
| Quote grounding ([file](2026-10-05-heldout-verdicts/p8-quotes-heldout-2026-10-05.json)) | 128 custodian questions, 319 supported spans | 15 wrongly flagged (4.70%), Wilson 95% [2.87%, 7.61%], bar ≤ 5% | **FAIL** |
| Advertised surface | | sealed Cat 40 run pending | pending |

The withdrawal-review paraphrase pairs are model-written and custodian-checked, as the 2026-10-05 amendment records. Quote-grounding failures fall into a few shapes: bracketed editorial insertions inside a quote, link markup kept from the page, a quote truncated mid-word with an ellipsis, and dropped trailing punctuation.

## What the losses teach

- **Surface-form parsers cap relational ideas.** P3's triplet scoring and P7's planner both act only when a parser recognizes the question. The planner wins anyway because composed questions had no answer before; triplet scoring has nothing to act on. Widening parser coverage on reworded questions is the prerequisite for retesting relational ranking ideas.
- **A broad cue breaks a downstream rule.** P3 E5's three wrong closures come from one employment-start alternative in P1's lexicon. P5's guard removes them, and a retest on fresh material decides whether single-value closures can default to `apply`.
- **Feedback helps entity-heavy brains, not chat history.** World-v1 gains 2 NDCG@10 points; LoCoMo stays flat at λ = 0.1 and falls at λ = 0.2.
- **A held-out failure followed by a fix on new development data works.** P1 failed set B, fixed general rules on sets A2 and A3, and passed set C.

## Reproduce and inspect

- Starting line: [`2026-10-05-heldout-program/starting-line/`](2026-10-05-heldout-program/starting-line/) holds each shard's `receipt.json`, `run-config.json` and `rows.ndjson.gz`. `bun docs/benchmarks/2026-10-05-heldout-program/recount-starting-line.ts` recomputes [`summary.json`](2026-10-05-heldout-program/starting-line/summary.json) from the rows. The runs used `bun run eval:decide` sources `lme-s`, `locomo`, `beam-100k` and `beam-1m` on the dev split, seed 42, with an overlay of gbrain `6622a119e`, and need `OPENAI_API_KEY`.
- Held-out aggregates: [`2026-10-05-heldout-verdicts/`](2026-10-05-heldout-verdicts/README.md). Sealed rows stay with the custodian.
- Branch history: [`2026-10-05-heldout-program/branch-folds.md`](2026-10-05-heldout-program/branch-folds.md) lists how each plan's evaluation branch is folded into this one.

Head-to-head comparisons against external memory systems, a full-context baseline and a file-agent baseline at matched cost are not part of this report.
