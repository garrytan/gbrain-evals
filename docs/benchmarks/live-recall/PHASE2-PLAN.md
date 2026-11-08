# Live recall phase 2: does gbrain retrieval change answers on Garry's brain, and does a summarising retrieval subagent help or hurt? (GBEV-46, GST-1848)

> **Amendment, 2026-11-07.** Garry, through FOUN-32: "Eh don't cut corners to stay just under the limits we treat it as a guideline". The approved text below is unchanged, and these lines in it are superseded: D7's "$850 all-in" and "counted run hard cap $360", read as a hard stop (the $850 is now a planning guideline and $360 is the counted run's starting cap); D7's "A cap stop ends the run incomplete and is never retried"; the line under "Order, concurrency, cap and resume" that ends "the scorecard marks the run INCOMPLETE with what finished, and nothing reruns"; and the `LR_CAP_STOP` row under "Abort and stop codes", "none: the run is reported incomplete and never rerun". The ledger caps stay as runaway-spend stops, but a cap stop now pauses the run at its cap until GBEV-3 extends it, and `--resume --window-note <extension id> --budget-usd <new cap>` continues it. The preregistration's "Differences from the approved plan" records the change.

> **Amendment, 2026-11-08 (R78).** Garry: "Check the grader, not just the product", amended "Use Astra vs opus". The approved text below is unchanged, and these lines in it are superseded: gpt-6.1-sol as the judge of claude-opus-5-5 and particle-1 rows (now gpt-6-astra; Sol no longer judges), the $360 counted starting cap (now $600, with a $200 cap for the new judge check), and the second judge and Wintermute's audit as the judge's only checks (a gating judge check now runs on the box before the counted run). The preregistration's "Differences from the approved plan" records the change.

## ELI5

Phase 1 measured whether gbrain's search puts the page that answers a real question near the top of its results on Garry's own brain. Phase 2 asks the question that matters more: does that change the answer? Wintermute, Garry's own gbrain agent, turns its real recall questions into tasks, each with a short gold answer it checks against the page. Each task goes to three models (Claude Opus 5.5, particle-1 and GPT-6.1 Sol) in four ways: with no access to Garry's notes (A); with gbrain's own read tools, so the model searches and opens pages itself (B), seeing only what gbrain shows a remote agent (pages Garry flagged private stay out); through a helper call that searches, reads and hands back a short summary with citations (C); and with the five pages gbrain's search ranks first pasted in up front (D). A judge from another model family compares each answer with the gold answer and checks that every cited page supports what it is cited for. Everything runs on Wintermute's box, against Garry's brain, through a database login that cannot write. Only a scorecard of numbers leaves the box, including what the run cost, computed from each response's token counts. Garry agreed that retrieved page text may go to Anthropic, OpenAI and Particle's APIs for this. We prove the harness first on a public made-up brain: keyless in CI, then with the real models for a few dollars.

## Before → after

Before: phase 1 (batch 2, gbrain 0.60.593.0, #385 at 3b9c3367) says configured search puts the right page in its top five for 88% of exactly-worded questions and 48% of paraphrased ones, and that vectors and the reranker add 18 and 32 points on paraphrases. Nothing says whether that changes what an agent answers, whether an agent that searches for itself recovers from a paraphrase miss by searching again, whether a summarising retrieval helper (the "agent in the middle" Parcha removed from its Recall design) helps or hurts, or what a correct answer costs on each model.

After: one command on Wintermute's box produces an aggregate task scorecard (live-recall-task-scorecard/v1). For each arm and model it gives the share of answers that are correct, correct and grounded (every citation supports its claim), abstained, and confidently wrong, each with an interval; citation faithfulness; exposure (did the agent search, see, open and cite a gold page); tokens, tool calls and latency; and the run's cost from each response's usage at the ledger's list prices, with cost per correct answer. It carries paired deltas B−A, C−B and D−B with cluster-bootstrap intervals, and four preregistered primary tests, Holm-corrected. The first table shows Opus 5.5 and particle-1 with cost per correct answer.

## Why it matters

Retrieval quality is only a means. Wintermute's own ranking of its five proposals calls task success "the number that matters". Phase 1's 40-point paraphrase gap could cost answers, or an agent that searches several times could make it up; only an outcome measurement can say which, and the answer decides whether gbrain's next work goes into ranking or into how agents search. The summariser question decides an architecture: Parcha removed its retrieval agent because it "repeated the caller's work and hid the evidence", while a summariser on a cheap model is the obvious way to cut cost. Cost per correct answer on Opus 5.5 against particle-1 is the number Garry asked every model comparison to lead with. These are real questions from Garry's own history, which no public benchmark can stand in for.

## What caused this work

Wintermute's message 263752 (2026-11-06) proposed five evals; item 3 is the task-success eval, and its addendum 263779 suggests building it from the real recall questions, adding a no-retrieval and a subagent-summary setup, and reporting correct-and-grounded answers per dollar by question type. Phase 1 (GST-1639, GBEV-43) built items 1 and 2, designed and priced item 3, and merged its batch 2 results in #385. Garry answered "Donit" on 2026-11-07 (recorded 23:28Z on GST-1848), taking recommendation T1: phase 2 may send retrieved private page text from his brain to Anthropic, OpenAI and Particle through their APIs. GBEV-3 opened GST-1848 with a $850 all-in hard stop, box keys for counted runs, the same server-enforced barrier as phase 1, and at most two merged PRs (R77).

## Big decisions

D1. Tasks. (a) Wintermute turns phase 1's 100 frozen questions (batches 1 and 2, gold pages already chosen page-first) into tasks: each keeps its type and two forms, each form reworded as a question with a checkable answer that keeps the form's property (exact uses the page's words, paraphrase avoids them), plus a gold answer of one to four required facts taken from the gold pages. Questions with no checkable answer are dropped and replaced by new tasks of the same type, to 100 (minimum 60). (b) A fresh set of 100 tasks. Recommendation: (a). It is Wintermute's own suggestion, it reuses page-first gold, and it costs Wintermute the least. Flip to (b) if Wintermute says fewer than 60 phase 1 questions have a checkable answer.

D2. Arm B's tools. (a) gbrain's own read operations query, search and get_page, with gbrain's own names, descriptions and parameter schemas from the loaded version, run in process through phase 1's guarded engine as gbrain's untrusted remote caller (see Privacy posture), with query expansion forced off as in phase 1. (b) All 12 read operations tool-bridge.ts exposes. (c) Two tools written for this eval. Recommendation: (a): it is gbrain as an agent sees it, and every extra operation is more code reaching Garry's live database through the barrier. Flip to (b) if Wintermute reports it uses other operations for most recall needs.

D3. Arm C's summariser model. (a) The same model as the answerer, so C−B measures the architecture alone. (b) particle-1 summarises for every answerer, the cheap-helper design. Recommendation: (a). (b) is a later question once (a) shows whether the architecture costs answers.

D4. Arm D, one-shot retrieval. (a) Add it: the runner calls query once with the task text and pastes the first five distinct pages (each capped at 8,000 characters). It links phase 1's success@5 to outcomes and, against B, measures whether letting the model search again recovers paraphrase misses. Descriptive only, no primary test. About $55 of the expected counted spend. (b) Skip it. Recommendation: (a).

D5. Primary comparisons. (a) Four primaries on the paraphrase form (one pair per question; paired delta with cluster-bootstrap interval and exact McNemar p), Holm-corrected across the four: P1 B minus A on correct, for Opus 5.5 and for particle-1; P2 C minus B on correct-and-grounded, for Opus 5.5 and for particle-1. The paraphrase pass runs to completion before the exact pass starts, so a cap stop cannot cut a primary. GPT-6.1 Sol, the exact form, both forms pooled, D, types and every other cell are descriptive with intervals. (b) Pool both forms, clustered by question, for the primaries. Recommendation: (a): users ask in their own words, phase 1 shows paraphrases are where retrieval struggles, and it keeps the primaries safe under the cap. MDD at N = 100 with 20% discordant pairs: 12.5 points at alpha 0.05, 14.9 at Holm's tightest level (Power below).

D6. Judging. (a) One judge call per answer, with the task form, Wintermute's gold answer, the answer and the text of up to eight cited pages (each capped at 12,000 characters, snapshotted through the barrier when the answer was submitted). It returns, per required fact, present, missing or contradicted; whether the answer abstains; and, per citation, supported, unsupported or not a page. The runner derives the verdicts: correct means every required fact present and none contradicted; grounded means at least one citation and every citation supported (an unjudged or not-a-page citation counts as unsupported). gpt-6.1-sol judges Opus 5.5 and particle-1 rows and claude-opus-5-5 judges GPT-6.1 Sol rows; particle-1 never judges. Two descriptive checks: claude-opus-5-5 also judges particle-1's paraphrase-pass rows of B, C and D (agreement and kappa with the counted judge, about $19), and Wintermute grades 30 randomly drawn rows blind to arm and model, from which only the agreement count leaves the box. (b) No agreement checks. Recommendation: (a): we can never read a judged row, so agreement numbers are the only evidence the judge works.

D7. Money: $850 all-in. Crew build, two /ship runs and coordination $320; public fixture smoke $10 on crew keys under one paid window; counted run hard cap $360 on box keys, computed by the runner from usage at list prices; one R48/R61 cycle reserve $110; unallocated $50. Expected counted spend about $290 (Cost below, corrected after review), so the cap sits 24% above the estimate, and the paraphrase pass alone ($157 expected) fits even at 2.3 times the estimate. A cost gate after the smoke sends the run back to GBEV-3 if the projection breaks either margin. A cap stop ends the run incomplete and is never retried.

D8. What the API calls carry. Garry's T1 consent names retrieved page text. The calls also necessarily carry the task text (every arm) and, for the judge, Wintermute's gold answer and the model's answer; all are private, and none comes to our machines, the repo, the drive or any message. Decided (GBEV-3, F1, 2026-11-07): covered by T1, since phase 2 cannot be answered or graded without them; nothing beyond that leaves the box. OpenAI calls are sent with store false, so no transcript is stored as a retrievable response object in the box's OpenAI account.

D9. Reasoning effort. (a) One fixed effort for every reader and judge: medium (particle-1 is sent reasoning_effort medium explicitly, which CLAUDE.md allows when a campaign fixes one effort for every reader). (b) Each model's default (particle-1 high). Recommendation: (a): comparable across models, and the cost estimate assumes it.

## Implementation plan

Everything new sits beside phase 1's runner and reuses its barrier, guards and fixture. No gbrain change, no package.json pin change, no change to phase 1's scorecard or its tests. Gate answered 2026-11-07 by agent:GBEV-3 ("do it: A1 B1 C1 D1 E1 F1"); this revision folds in d1b, d2a, d3a and d4a and every Medium and Low finding.

### Privacy posture (d1b, GBEV-3 condition A1)

Every gbrain read in phase 2 runs as gbrain's untrusted remote caller (OperationContext remote: true, the posture gbrain's MCP server gives agents and tool-bridge.ts uses), in every arm, in the judge's page reads and in the gold-page check. gbrain then hides pages flagged private (frontmatter visibility private; derived atoms and synthesized concepts with no visibility; pinned-question pages; private lineage) and serves only safe chunks (no protected facts or takes fences). The runner forces this: the env escape hatch GBRAIN_REMOTE_PRIVATE_PAGES is deleted from its process, and it refuses to start (LR_PRIVACY_RELAXED) if the brain's config sets search.remote_private_pages to a relaxing value. A fixture test shows a private-flagged page is unreachable in B, C, D and the judge. The exclusion rule is written into the preregistration.

Gold pages: `tasks freeze` connects through the barrier and checks every task's gold pages under the same posture (get_page finds the page, and it has at least one safe chunk). A task with an unreachable gold page is dropped from the frozen set, never counted as a retrieval miss; Wintermute may replace it with a reachable task and freeze again. freeze.json records the count dropped (a number only) and the sorted line numbers kept. If the kept N is under 60, the runner says so and we tell GBEV-3 before the freeze is committed. At run time the check repeats; a task whose gold page became unreachable since the freeze is excluded and counted, and more than 10% aborts (LR_GOLD_MISSING_CAP, as in phase 1).

### Shape

Arms are Arm objects for Cat 40's runAgent (eval/runner/cat40/loop.ts), so the loop, provider branches, retries, classifyStops and usage receipts are the ones Cat 40 and the particle runs already trust. The runner is a scheduler and a run directory around them.

### Files

- eval/runner/live-recall/tasks.ts (CLI): `tasks check`, `tasks freeze`, `tasks estimate`, `tasks run`, `tasks judge` and `tasks score`. Task file parsing and validation, freeze, the scheduler with bounded concurrency, stop mapping, resume and the run directory. Budget flags come from budgetOptionsFrom (--budget-usd, --budget-ledger, --program-cap-usd), as everywhere else in the repo.
- eval/runner/live-recall/task-arms.ts: arms A to D, the gbrain tool executor (operations loaded with importGbrain(gut, 'src/core/operations.ts'), never tool-bridge's pinned import, so the box's gbrain version drives the box's engine), the degraded-stage capture, and the page snapshots.
- eval/runner/live-recall/task-judge.ts: the frozen judge prompt, the judge call, the structured response parser, verdict derivation, and judge-family routing (a function that refuses a same-family judge and refuses particle-1).
- eval/runner/live-recall/task-scorecard.ts: aggregation into live-recall-task-scorecard/v1, intervals, paired comparisons, Holm, an alpha-parameterised MDD helper (normalQuantile from stats/paired.ts; phase 1's mde() is untouched), the structural allowlist validator, the leak scan and the Markdown render. Reuses wilson, clusterBootstrapProportion, clusteredPairedDelta, exactMcNemar and holmAdjusted.
- eval/runner/live-recall/brain.ts: new abort codes in ABORT_CODES (below); no change to the barrier or guards.
- eval/runner/cat40/loop.ts: an opt-in openaiStore: false for the OpenAI branch (store false, include reasoning.encrypted_content, and the accumulated input resent each turn instead of previous_response_id), and an exported single-call helper for the judge with the same retries, effort, store, fetch and onAttempt seams. Defaults unchanged; a test pins that Cat 40's request bodies are byte-identical with the options unset.
- eval/data/live-recall-v1/tasks.jsonl: the 20 public fixture questions as tasks with gold answers, plus one fixture page flagged private, written for this fixture.
- test/eval/live-recall-tasks.test.ts (keyless).
- docs/benchmarks/live-recall/PHASE2-PREREGISTRATION.md: question, system under test, privacy posture, tasks, arms, prompts and tool descriptions (verbatim), judge prompt (verbatim), metrics, comparisons, decision rules, power, cost, cap and gates, errors and the stop mapping, order, custody, provider data terms (dated), limits, and a closing Disclosures section. Frozen sample and counted-run identity are filled on the results branch before any counted run.
- docs/benchmarks/live-recall/PHASE2-PLAN.md: this plan as approved, with the review record and Disclosures.
- docs/benchmarks/live-recall/RUN-KIT.md: a phase 2 section (steps, keys, cap, resume, abort codes). SCORECARD.md: the task scorecard format.
- CHANGELOG.md [Unreleased] and the docs index pointer.

### Task file (private, stays on the box)

JSONL, one task per line: id (short, opaque), type (identifier, error_string, time_window, cross_source, topic), source_question (the phase 1 question id, or null for a new task), forms {exact, paraphrase} as questions, gold_pages [slugs], gold_answer {text, required_facts [{id, fact}] (1 to 4), acceptable_variants (optional)}, window (optional), gold_found_by. Validation refuses a task with no required facts or no gold page (LR_TASKS_INVALID, line number and field only). freeze writes N submitted, N kept, the count dropped as unreachable, counts by type, the file's sha256, the kept line numbers, and the MDD for the four primaries at the kept N, numbers only; run refuses a file whose hash does not match (LR_FREEZE_MISMATCH).

### Arms (same tasks, same order, every model)

All arms share one system frame: the assistant answers a question for Garry Tan and finishes with submit_answer. Phase 2's submit_answer (passed as LoopConfig.submitTool, frozen in the preregistration) takes the answer as a short paragraph with an inline [slug] citation after each claim that comes from a page, plus a sources list; it may say plainly that the notes do not hold the answer. Turn cap 12, 8,192 output tokens a turn, tool results capped at 16,000 characters, effort medium for every model (particle-1 is sent reasoning_effort medium), classifyStops on, OpenAI with store false.

- A, no retrieval: told that Garry's notes are not available in this setting, to answer from what it knows and to say plainly when it does not know. No tools but submit_answer.
- B, gbrain tools: gbrain's own query, search and get_page operations, with the names, descriptions and parameter schemas of the loaded version, minus any expansion parameter (the executor forces expand false, as tool-bridge.ts does). The model decides what to search and open.
- C, summariser then answerer: a summariser loop with B's tools whose final tool is a submit_answer-named tool with the summary schema (at most 300 words, inline citations), so the loop needs no change; then an answerer call with no tools but submit_answer, given the task and the summary only, citing only the summary's sources.
- D, one-shot: the runner runs phase 1's configured-arm search (hybridSearch as the brain is configured, expansion off) with the task text, under the remote posture (excludePrivate and requireSafeChunks set), takes the first five distinct pages, opens each with get_page (8,000 characters each) and pastes them under slug headers; one call, no tools but submit_answer. The scorecard reports D's gold-in-top-5 rate beside phase 1's success@5.

The query operation adds gbrain's result cache, alias fan-out, query arms and its CRAG grade on top of hybridSearch. That is gbrain as an agent sees it, so B and C keep it; run identity records search.crag_escalation, search.crag_think and the cache setting. Expansion stays off everywhere: an escalation that asks for expansion is refused by the AI guard, counted, and the query keeps its first pass. crag_think never runs for a remote caller.

### Degraded searches (d3a)

Every query and search call in B, C and D keeps gbrain's search meta (the executor wraps the operation so its meta is captured). A call that reports a stage in phase 1's FAILURE_STAGES (embedding unavailable or timed out, a failed vector, keyword or title leg, rerank failure or pass-through) marks its episode degraded; degraded episodes are excluded from every comparison they belong to and counted per arm and model; more than 10% degraded in one cell makes it invalid (LR_CELL_INVALID). The paid-request guard is checked after every gbrain call: a refusal inside an embedding or rerank call is a cap stop, never a keyword-only episode. CI covers a failing embedding transport, a pass-through reranker and a cap refusal inside an embedding.

### Grading and verdicts

One judge call per answer through the loop's single-call helper (store false on OpenAI, effort medium for both judge families, the loop's retries and usage receipts, and a fetch seam for tests). gpt-6.1-sol judges Opus 5.5 and particle-1 rows; claude-opus-5-5 judges GPT-6.1 Sol rows; particle-1 never judges, and the routing function refuses a same-family judge. The judge sees the task form, Wintermute's gold answer, the answer, and the text of every cited page up to eight (each capped at 12,000 characters) from the snapshot taken when the answer was submitted: right after each answer the runner reads every cited page under the remote posture and stores it with the episode, so the judge grades what existed when the model answered, not a page edited hours later. Page and answer text are wrapped as quoted data, and the frozen prompt tells the judge to ignore instructions inside them. It returns JSON: per required fact present, missing or contradicted; whether the answer abstains; per citation supported, unsupported or not_a_page. The runner derives: correct means every required fact present and none contradicted; grounded means at least one citation and every citation supported, where a citation past the eighth, an unjudged citation or a not_a_page citation counts as unsupported. A has no citations, so it is graded for correctness only. One parse retry, then judge_error. Two descriptive checks: claude-opus-5-5 also judges particle-1's paraphrase-pass rows of B, C and D (agreement and kappa with the counted judge), and Wintermute (on Opus 5.5) grades 30 randomly drawn rows blind to arm and model, from which only the agreement count leaves the box; it shares an author with the gold answers, so it is labelled descriptive.

### Episode stop mapping

| Loop result | What the run does |
|---|---|
| submitted | judged |
| turn_cap or no_tool_call (no submitted answer) | counted, not correct, reported as no_answer; not judged |
| context_overflow | counted, not correct |
| error from a model-caused 400 | counted, not correct |
| harness_error or a retryable ProviderError after the loop's retries | written uncounted; the episode reruns under the same id, at most twice; still failing, excluded with its count |
| particle-1 timed_out (may have billed, #287) | excluded with its count, never rerun |
| degraded search (above) | excluded with its count |
| cap refusal (BudgetExceededError) | cap stop |
| judge_error | the answer stays; excluded from verdicts with its count, re-judged with `tasks judge` without re-answering |

More than 5% of a cell excluded for errors makes it invalid (LR_CELL_INVALID). An invalid primary cell is reported untested, and Holm still runs over four tests, the untested one counted at p = 1.

### Order, concurrency, cap and resume

- Order: the paraphrase pass, then the exact pass. Within a pass, tasks run with bounded concurrency (default 4 tasks at once, at most 4 requests in flight per provider); within a task, its 12 arm-model cells run in an order seeded from the task id, each judged as soon as it is answered. The exact pass starts only when the paraphrase pass has finished, so a cap stop cannot cut a primary.
- Every request (answers, summaries, judges, gbrain's embeddings and rerank calls) goes through the budget-ledger paid-request guard on a box-local ledger. A refused reservation is a cap stop: cap-stop.json is written, the process exits with a distinct code and prints LR_CAP_STOP with spent, reserved and unknown dollars, the scorecard marks the run INCOMPLETE with what finished, and nothing reruns. OpenAI's encrypted reasoning items inflate the guard's byte-based reservation a little, so it over-reserves rather than under-reserves.
- Cost: per-role cost comes from the loop's onAttempt receipts (each response's usage at the ledger's list prices) and gbrain's provider cost from the ledger rows by kind; the scorecard's total is reconciled to the ledger total and the difference is reported. Crew credits are counted separately at 1,000 credits per dollar.
- Each answer record is written atomically before judging. --resume skips episodes with a judged record, re-judges an answered but unjudged one, and reruns one with no record (except a particle-1 timed_out, which stays excluded). A non-fixture --resume needs --window-note <id> (GBEV-3's window note, CREW rule #287), recorded in run identity; without it the runner refuses (LR_RESUME_NEEDS_WINDOW).
- `tasks estimate`, run on the box after the freeze, reads the frozen gold pages' sizes through the barrier and projects the counted cost from the smoke's measured tokens per episode, printing totals only, so the window request carries a number.

### Abort and stop codes (d4a)

Each code has an anchor in RUN-KIT.md with what happened, the fix and the recovery, and prints only the code, a line number or field name, and counts.

| Code | Meaning | Recovery |
|---|---|---|
| LR_TASKS_INVALID | a task line fails validation | fix the line and freeze again |
| LR_FREEZE_MISMATCH | the task file's hash differs from the freeze | run with the frozen file |
| LR_GOLD_MISSING_CAP | more than 10% of kept tasks lost their gold page since the freeze | freeze again and record a new sample |
| LR_PRIVACY_RELAXED | the brain relaxes remote private-page visibility | none in the runner; GBEV-3 decides |
| LR_CAP_STOP | the ledger refused a reservation at the cap | none: the run is reported incomplete and never rerun |
| LR_CELL_INVALID | a cell passed the error or degraded cap | reported in the scorecard, not an abort |
| LR_JUDGE_ERROR | judge output failed to parse twice | `tasks judge <run dir>` re-judges without re-answering |
| LR_RESUME_NEEDS_WINDOW | --resume on a counted run without --window-note | ask GBEV-3 for a window note |

Phase 1's barrier, schema, embedding, preflight and custody codes apply unchanged.

### Scorecard and custody

scorecard.json (live-recall-task-scorecard/v1) and scorecard.md are the only outbound files, built by `tasks score <run dir>`, which can run again without re-answering. Per arm, model and form: n, correct, correct-and-grounded, partial, abstained, no_answer and confidently-wrong rates (Wilson intervals; cluster bootstrap over tasks when forms are pooled), citation counts and the supported share, exposure (share with at least one tool call, with a gold page among search results, with a gold page opened, with a gold page cited; for C the summariser's and the summary's; for D the share with a gold page among the five pasted), tool calls and turns, tokens by kind, latency p50 and p95, exclusions by reason, cost by role (answer, summariser, judge, second judge, gbrain's provider calls) and cost per correct answer; the comparisons with deltas, intervals, McNemar and Holm p, and the MDD at the frozen N; C minus B on plain correctness beside P2; judge agreement (kappa, agreement count) and Wintermute's audit count; the dropped-unreachable count; run identity (runner commit, harness digest, gbrain commit and version, schema version, barrier kind, privacy posture, crag and cache settings, models, efforts and output limits sent, cap, window note). The validator accepts only allowlisted strings and numbers under known keys. The leak scan checks both files for every task form, gold fact, gold answer and every slug the run saw; needles made only of digits and punctuation are left to the validator (a number can only appear under a known numeric key), so a numeric gold fact cannot false-positive against a token count. A hit aborts LR_CUSTODY_LEAK with the field name only. Per-episode transcripts, page snapshots, judge outputs and detail rows stay in the run directory on the box.

### Public fixture, CI and smoke

- CI (keyless): the fixture brain from phase 1 with hash embeddings, plus one private-flagged page, and scripted models that answer through the provider fetch under the paid-request guard (installPaidRequestGuard with a fake fetch on a temporary ledger, the loop on global fetch). Asserts: every arm runs end to end; B and C reach gbrain only through the guarded engine, a write attempt is refused, and the private page is unreachable in B, C, D and the judge; degraded embedding, pass-through rerank and a cap refusal inside an embedding behave as above; the judge parser and verdict derivation, including an unjudged citation counting as unsupported; a same-family judge and a particle-1 judge are refused; every OpenAI request body, judges included, carries store false; ledger totals equal the fake usage at list prices, and the scorecard total reconciles; a tiny --budget-usd produces LR_CAP_STOP with no rerun; the paraphrase pass completes before the exact pass; particle-1 timed_out is never rerun; an answered but unjudged record resumes judge-only; a canary in a task form, a gold fact and a slug never reaches scorecard.json, scorecard.md or the terminal, and a numeric gold fact does not false-positive; freeze mismatch, invalid task and missing window note abort with their codes; an oracle answerer scores 1.0 and an empty one 0.0; Cat 40's request bodies are byte-identical with the new loop options unset.
- Paid smoke (after the PR merges, crew keys, one paid window, cap $10): five fixture tasks, paraphrase form, four arms, three models, both judges. It proves the three provider paths, store false, the judge routing and the cost accounting against each provider's usage, and measures tokens per episode for `tasks estimate`. A harness check only; its scores say nothing about Garry's brain.
- Cost gate before the counted window: `tasks estimate` on the box. If the projected paraphrase pass exceeds 75% of the $360 cap ($270), or the projected total exceeds the cap, it goes back to GBEV-3 before any counted call.

### Power

Paired binary outcome, two-sided, 80% power, in points (the runner's mde formula, with Holm's level from the new helper).

| Comparison | N = 60 | N = 100 |
|---|---|---|
| A primary, paraphrase form, 20% discordant, alpha 0.05 / Holm's tightest 0.0125 | 16.2 / 19.3 | 12.5 / 14.9 |
| Same, 30% discordant | 19.8 / 23.7 | 15.4 / 18.3 |
| Descriptive, both forms pooled, 20% discordant | 11.5 to 16.2 | 8.9 to 12.5 |
| One type alone (N/5 tasks), 20% discordant | about 36 | about 28 |

A single rate near 50% at n = 100 has a Wilson interval of about plus or minus 10 points. B minus A is expected to be large (private facts), so P1 is well powered. C minus B is the test most likely to sit near its MDD: a summariser effect of 5 to 10 points would not be detected, and P2 also charges C for citing through a 300-word summary, so C minus B on plain correctness is reported beside it.

How results feed decisions, fixed now: P1 holding says retrieval through gbrain changes answers on this brain, and the B and D exposure numbers say whether misses come from search or from reading. A P2 drop (C below B, Holm-significant) is evidence against a summarising helper in front of gbrain for that model. A P2 null is reported as "no difference detected, MDD x points", never as "summarisers are fine", and goes through R48 with the exposure and correctness-only numbers. D minus B, descriptive, says whether letting the model search again recovers paraphrase misses.

### Cost

Assumptions per answer at medium effort, from phase 1's page sizes and Cat 40's tool loops (the smoke checks them on short pages; `tasks estimate` scales them to the frozen gold pages): A about 1.2k tokens in and 1.5k out; B about 39k in over four turns (most of it cache reads on Anthropic and OpenAI) and 3k out; C a B-sized summariser plus 3k in and 1.5k out for the answerer; D about 12k in and 1.5k out. Judge about 11k in (2k for A) and 2k out with reasoning. At the ledger's list prices (Opus 5.5 $4/$20, Sol $2/$10, particle-1 $0.25/$1 per million):

| Per task form | A | B | C | D |
|---|---|---|---|---|
| Opus 5.5 answers | $0.035 | $0.16 | $0.19 | $0.078 |
| GPT-6.1 Sol answers | $0.017 | $0.07 | $0.09 | $0.04 |
| particle-1 answers | $0.002 | $0.013 | $0.016 | $0.004 |
| Judges (Sol on Opus and particle-1 rows, Opus on Sol rows) | $0.096 | $0.168 | $0.168 | $0.168 |

That is about $1.32 per task form, $263 for 100 tasks in two forms, plus $25 for the second judge on the paraphrase pass: about $290 expected, $157 of it in the paraphrase pass. gbrain's embeddings and rerank calls add cents. The $360 counted cap sits 24% above the total and 2.3 times above the paraphrase pass, which holds every primary. The money split is unchanged: crew $320, smoke $10, counted cap $360, R48/R61 reserve $110, unallocated $50.

### Coordination and order

1. The preregistration PR with the harness and this plan; one /ship; READY.
2. Right after the gate, in parallel with the build: the task brief to ALPH-72 (Wintermute's liaison under ALPH-11), with the box key check (ANTHROPIC, OPENAI and PARTICLE keys, test -n only; if one is missing, ALPH-11 arranges it, else GBEV-3 decides), and GBRA-108 asked to confirm phase 1's barrier for phase 2 (SELECT-only role, no sequence grants, no memberships), which ALPH-72 recreates and proves before the run.
3. After the PR merges: the public smoke under a paid window (ledger run and keys named in the request).
4. Wintermute freezes the tasks; the freeze numbers, dropped count, MDD, runner commit and harness digest go into the preregistration on the results branch as a dated, pushed commit before any counted run. The cost gate runs on the box.
5. GBEV-3 grants the counted window; ALPH-72 runs it on the box with box keys; only the scorecard returns.
6. Results PR with the findings, then R48 "Why null?" for any null, one /ship, READY.

### Limits

One brain, one owner, one agent writing the tasks; Wintermute also uses gbrain, so the gold_found_by shares are reported. One trial per cell, so model randomness sits inside the discordance. Query expansion is off in every arm, as in phase 1. Tool surface restricted to three read operations. Private-flagged pages and unsafe chunks are out of scope by consent, so the result covers what gbrain shows a remote agent, not what Garry's local CLI sees. We never see a judged row, so the judge's quality rests on the two agreement checks. The run reads the live database through the no-write role, so pages change only as Garry's own brain changes during the run; the run's start and end times are recorded, and the judge grades the snapshot each model saw.

### Test plan

Before push: test/eval/live-recall-tasks.test.ts, test/eval/live-recall.test.ts (unchanged, as a regression check for the shared brain code), the Cat 40 loop tests that cover the OpenAI branch and the new byte-identity test, the CLI on the fixture with scripted models, freeze and run on a malformed task file, and the custody scan against a planted leak. test/eval/live-recall-postgres.test.ts runs once if brain.ts changes beyond ABORT_CODES. CI runs the full suite.

### Any outside terms, licences or rights involved?

Provider API data terms for sending page text, task text, gold answers and model answers to Anthropic, OpenAI and Particle are covered by Garry's T1 consent as GBEV-3 confirmed it (F1, 2026-11-07); the preregistration records each provider's API retention and training terms with the date checked, Particle's in particular, and that every OpenAI call sends store false. Parcha's write-up is cited for context only. The fixture tasks are original fictional text under the repo's MIT licence. No licence changes, no new dependencies.

## Review record

Lean autoplan run autoplan-20261107233925 (one native reviewer, claude-opus-5-5): 19 findings (4 High, 9 Medium, 5 Low, 1 Informational), one user challenge (F1). Gate answered "do it: A1 B1 C1 D1 E1 F1" by agent:GBEV-3 on 2026-11-07 (d1b d2a d3a d4a p1b, plus F1 outside the gate: task text, gold answers and model answers sent to the three APIs are covered by T1). GBEV-3 conditions on A1: private-flagged pages and unsafe chunks excluded the way gbrain does for a remote caller, the rule in the preregistration, unreachable-gold tasks dropped or replaced before the freeze with the count recorded, and GBEV-3 told before the freeze if N falls under 60. Findings F4 to F12 and F14 to F19 are folded into this revision; the reviewer's Shape 2 (arms on Cat 40's runAgent, cost from receipts and the ledger) is adopted.

## Disclosures

Disclosure: Y Combinator, which Garry Tan runs, is an investor in Particle, which makes particle-1.

gbrain is Garry Tan's own project.

Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator. Garry Tan runs Y Combinator.
