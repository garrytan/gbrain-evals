# Nine-plan held-out program: starting line, preregistrations, verdicts and scorecard

This report collects one feature program for [gbrain](https://github.com/garrytan/gbrain), a memory system for agents. Eight feature plans (P1 to P8) each change gbrain in one pull request. P0 is the evaluation plan: it measures the starting line on gbrain master and runs the held-out harness every other plan uses. Each feature idea has a preregistered decision rule, a development verdict on data the implementer may see, and a held-out verdict on sealed data that only the custodian opens. The held-out verdict sets the idea's default.

This report covers the plans whose gbrain pull requests have merged: P1 (#6018), P3 (#6014), P7 (#6019), P8 (#6027), P4 (#6015) and P6 (#6112). Across P1, P3 and P7's eight held-out decisions, three ideas pass and ship on: dated relationships, the certified nightly contradiction check and the multi-relation planner. Four ideas lose or miss their gate, and each one ships off, ships in a safer mode or leaves its pull request. P8's write guard, semantic withdrawal and quote grounding pass and ship on, and its narrower advertised surface fails. P4's pre-compaction save notice passes and ships on, and its always-loaded core memory tier fails and ships off. P6's `think` date frame passes and ships on, and its fact keys and time scope were killed in development. P2 and P5 are in progress; their records join this report as each gbrain pull request lands.

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

**BEAM session dates (note added 2026-10-06).** The BEAM rows above ran on a loader that dated only the first turn group of each BEAM batch, so about 96% of BEAM sessions reached gbrain and the reader without a date. BEAM dates each batch once, and the loader now gives every turn group its batch's date. They stand as measured. A rerun of BEAM-100K dev on the same build with the fixed loader, reported only, gives strict recall of all gold sessions at 5 of 47.2% (45.4% before, 2 more questions) and answer accuracy of 58.0% (57.1% before). Per question type, the changes are within ±1 question of 12 and mixed in sign. Receipt and rows: [`starting-line-beam-dates/`](2026-10-05-heldout-program/starting-line-beam-dates/beam-100k-qa/shard-0/receipt.json). BEAM-1M was not rerun.

## Program scorecard

One row per idea. "Held-out verdict" is the custodian's sealed result against the preregistered bar. "Default" is what the idea ships with.

| Plan | Idea | Setting | Held-out verdict | Default | gbrain PR |
|---|---|---|---|---|---|
| P1 | Dated typed relationships with live-only reads and as-of queries | `graph.edge_validity` | Round 1 **FAIL** (traps 101/115, recall −4.9 and −6.2 points); round 2 **PASS** on fresh phrasing; custodian check on a third phrasing **FAIL** (traps 89/105) | on | [#6018](https://github.com/garrytan/gbrain/pull/6018), merged, v0.60.57.0 |
| P1 | Nightly contradiction check closes superseded relationships | `dream.edge_contradictions.mode` | **PASS** for all five judge models (0 wrong closures) | `apply` for the five certified models, `propose` for others | #6018 |
| P1 | Corrections reach every read surface (E3) | none | report-only | none | #6018 |
| P2 | Hub dampening, date-grounded extraction, speaker attribution | in progress, see gbrain PR | in progress | in progress | [#6020](https://github.com/garrytan/gbrain/pull/6020), draft |
| P3 | Use-attributed feedback weights from explicit ratings | `feedback.enabled` | world-v1 **PASS** (+2.04 NDCG@10 points); LoCoMo **FAIL** (−0.12, CI crosses 0) | off (opt-in), by decision | [#6014](https://github.com/garrytan/gbrain/pull/6014), merged, v0.60.63.0 |
| P3 | Implicit citation signal | `feedback.implicit` | not run (gated on E1 passing both corpora) | off | #6014 |
| P3 | Relational triplet scoring | `search.triplet_scoring` | **FAIL** (relational arm fired on 17% of questions, bar 80%) | removed | #6014 |
| P3 | Declared single-value relations close the older value | `dream.single_value.mode` | **FAIL** (3 wrong closures, bar 0); retest with the advisory-role guard: safe (0 wrong) but no correct closure measured | `propose` | #6014 |
| P4 | Core memory tier and save before compaction ([records](2026-10-05-heldout-program/p4.md)) | `memory.pressure.enabled`, `memory.core.enabled` | pressure gate **PASS** (+11.35 points); core gate **FAIL** (`gpt-6.1-sol` −2.4, `claude-fable-5-1` −2.4) | pressure notice on; core off (opt-in) | [#6015](https://github.com/garrytan/gbrain/pull/6015), merged, v0.60.87.0 |
| P5 | Typed relation lines, wanted pages, similar-page hint | in progress, see gbrain PR | in progress | in progress | [#6017](https://github.com/garrytan/gbrain/pull/6017), draft |
| P6 | Time-aware retrieval and reading ([records](2026-10-05-heldout-program/p6.md)) | `think` date frame | date frame sealed LoCoMo **PASS** (+14.0 points), LongMemEval-M confirmation pending; fact keys, time scope and notes-first killed in development | date frame on | [#6112](https://github.com/garrytan/gbrain/pull/6112), merged, v0.60.88.0 |
| P7 | Multi-relation query planner | `search.relational_planner` | **PASS** (24 better, 0 worse; +27 points strict all-hit@10) | on in `balanced` and `tokenmax` | [#6019](https://github.com/garrytan/gbrain/pull/6019), merged, v0.60.60.0 |
| P7 | One-hop orientation | `search.relational_orient_onehop` | does not meet its rule (1 better, 0 worse, p = 1.0) | off | #6019 |
| P8 | Write guard, semantic withdrawal, quote grounding, advertised surface ([records](2026-10-05-heldout-program/p8.md)) | guard, `review_withdraw`, `think.quote_verify`, `mcp.advertised_surface` | write cost **PASS**, withdrawal **PASS**, quote grounding first run **FAIL** and fresh retest **PASS**, narrower surface **FAIL** | guard, withdrawal and quote grounding on; new installs advertise `full` | [#6027](https://github.com/garrytan/gbrain/pull/6027), merged, v0.60.77.0 |

The P3 raw-query routing guard in #6014 has no preregistered experiment and no default rides on it.

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

**Generalization check on fresh wording (custodian, 2026-10-05).** A second custodian ran E1 again on a new phrasing set (seeds 103, 107, 109) that shares no wording with sets B and C, comparing master (`8c9a8e9a4`, which contains #6018) to the round-2 baseline `6622a119e`. It **fails** the traps gate: 89 of 105 (investment after exit 29/35, alumni meeting 27/37, advisor 33/33). The feature still lifts now-precision (0.336 → 0.768) and as-of (0.167 → 0.556), with recall unchanged and invariance 240/240. During-year F1 (+0.137) and stale-summary correction (0 in both builds) miss their bars. The cause is lexicon coverage. The employment cue list recognizes none of this set's dated join, leave and move lines (an onboarding-style join verb, a leave phrase whose phrasal verb is split by its object, and an exchange-style "A for B" move), so ended jobs never close. The former employer then stays live, which is exactly what the investment and alumni traps check. Record: [`p1-e1-sete-2026-10-05.json`](2026-10-05-heldout-verdicts/p1-e1-sete-2026-10-05.json).

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

E4's cause: the one-hop relational parser keys on exact surface forms, so reworded questions skip the relational arm and triplet scoring never acts on them. E5's cause: the employment-start cue `EMPLOYMENT.start` also matches "took an advisory role with X", so an advisory line on a page that asserts `works_at` to X becomes a newer employment start, and the single-value rule closes the real current employer. A guard that keeps advisory and board roles from starting employment is in progress in gbrain#6017; a retest on fresh sealed material decides whether single-value closures can default to `apply`.

#### Root causes of the P3 failures (custodian analysis)

A second custodian reread each failed decision's sealed receipts to separate harness defects from product defects and real limits. No harness defect was found in E1, E4 or E5.

- **E1 LoCoMo is a limit of the benchmark shape, not a bug.** The feedback weights apply: at λ = 0.1 the frozen arm changes 91 of the 518 scored rankings (40 better, 51 worse) in all 7 conversations, and at λ = 0.2 it changes 185 (56 better, 129 worse), so a larger λ does not help. No scored question is in the training half, and the whole run makes about one pass of embedding requests, so every arm reads the same cached vectors. The cause is that a LoCoMo conversation is a small closed set of sessions: the training half's gold sessions cover 16 to 30 of each conversation's 19 to 32 sessions, and each rated answer marks about 20 sessions, so every session collects both "useful" and "not useful" ratings. A page-level prior that ignores the query cannot say which session answers a new question. On world-v1 an entity page answers many questions, so the same prior helps.
- **E4 is explained by parser coverage; triplet scoring itself behaves as designed.** Triplet scoring changed the ranking on all 37 questions where the relational arm fired and on none of the other 181. On the fired questions it gains +2.27 NDCG@10 points, close to the development gain at full coverage (+1.94). The arm fired on 0 of 56 attendee questions, 3 of 90 who-at-topic questions and 34 of 72 portfolio questions. Even with full parser coverage, the gain sits at about the +2.0 bar.
- **E5 is a product defect, and a retest on fresh material shows the guard removes the wrong closures.** On a new held-out phrasing set (seeds 113, 127, 131), master without the guard applies 23 single-value closures, all wrong. Master with gbrain#6017's guard applies none and passes every E5 gate, so the retest shows the guard is safe for `apply`. It cannot show a benefit: with the guard there is no dated conflict left to close, which misses the precondition the retest preregistered (at least 10 applied closures). Because no E5 run has recorded a correct closure, `apply` has no measured benefit, and `dream.single_value.mode` stays `propose` (decision, 2026-10-05). A later report-only recheck on a third fresh set (set G, on gbrain#6017's re-frozen build `970c3088b`) applied 3 single-value closures, all correct, with 0 wrong; the default stays `propose` until a preregistered decision measures a benefit. The retest also finds a remaining defect: link typing still types a company named in a dated advisory, board or observer line as `works_at`, on master and on #6017's head. With the guard that edge has no start date, so the company shows as a current employer at every date (as-of exact 0.553 with the guard against 0.642 without it on this set). Record: [`p3-e5-setf-retest-2026-10-05.json`](2026-10-05-heldout-verdicts/p3-e5-setf-retest-2026-10-05.json).

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

## What the losses teach

- **Surface-form parsers cap relational ideas.** P3's triplet scoring and P7's planner both act only when a parser recognizes the question. The planner wins anyway because composed questions had no answer before; triplet scoring has nothing to act on. Widening parser coverage on reworded questions is the prerequisite for retesting relational ranking ideas.
- **A broad cue breaks a downstream rule.** P3 E5's three wrong closures come from one employment-start alternative in P1's lexicon. Narrowing that cue is in progress, and a retest on fresh material decides whether single-value closures can default to `apply`.
- **Feedback helps entity-heavy brains, not chat history.** World-v1 gains 2 NDCG@10 points; LoCoMo stays flat at λ = 0.1 and falls at λ = 0.2.
- **A held-out failure followed by a fix on new development data works.** P1 failed set B, fixed general rules on sets A2 and A3, and passed set C.

## Reproduce and inspect

- Starting line: [`2026-10-05-heldout-program/starting-line/`](2026-10-05-heldout-program/starting-line/) holds each shard's `receipt.json`, `run-config.json` and `rows.ndjson.gz`. `bun docs/benchmarks/2026-10-05-heldout-program/recount-starting-line.ts` recomputes [`summary.json`](2026-10-05-heldout-program/starting-line/summary.json) from the rows. The runs used `bun run eval:decide` sources `lme-s`, `locomo`, `beam-100k` and `beam-1m` on the dev split, seed 42, with an overlay of gbrain `6622a119e`, and need `OPENAI_API_KEY`.
- Held-out aggregates: [`2026-10-05-heldout-verdicts/`](2026-10-05-heldout-verdicts/README.md). Sealed rows stay with the custodian.
- Branch history: [`2026-10-05-heldout-program/branch-folds.md`](2026-10-05-heldout-program/branch-folds.md) lists how each plan's evaluation branch is folded into main.

Head-to-head comparisons against external memory systems, a full-context baseline and a file-agent baseline at matched cost are not part of this report.

## Changelog

- 2026-10-06: P6 merged (gbrain#6112, v0.60.88.0): the `think` date frame passes sealed LoCoMo and ships on; LongMemEval-M confirmation pending.
- 2026-10-06: P4 merged (gbrain#6015, v0.60.87.0): pressure gate PASS and on, core gate FAIL and off; the opening paragraph now lists P8 and P4 among the merged plans.
- 2026-10-05: First publication (gbrain-evals#71). The starting line on gbrain master `6622a119e`, the held-out records of P1, P3 and P7, and the program scorecard, with P2, P4, P5, P6 and P8 listed as in progress.
- 2026-10-05: P3 gains the custodian's root-cause analysis of E1, E4 and E5 and the E5 retest on fresh material.
- 2026-10-05: P1 gains the custodian's E1 check on a third phrasing set (fails traps, lexicon coverage); the E5 record states that `dream.single_value.mode` stays `propose`.
- 2026-10-05: P3 records the report-only E5 recheck on set G (3 correct closures, 0 wrong). Plans still in progress publish their records in their own pages under `2026-10-05-heldout-program/`.
- 2026-10-06: The starting line notes that its BEAM rows ran on a loader that left most sessions undated, with a reported-only BEAM-100K dev rerun on the fixed loader.
