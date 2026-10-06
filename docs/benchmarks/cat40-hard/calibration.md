# Cat 40 Hard calibration record

This file records every calibration round of the Hard generator: the knobs, the reason for each change, per-model and per-family results, stop kinds, oracle-failure classification and cost. The freeze-rule analyzer appends its table for each round (`bun eval/runner/cat40/analyze.ts <results.jsonl> --freeze-rule --round N --calibration-md docs/benchmarks/cat40-hard/calibration.md`). Rules: [RUNBOOK.md](RUNBOOK.md#calibration-rules).

Calibration uses seed 20261005, 10 tasks per family from a world generated at the held-out density of 20 per family (the first 10 of each family, the same indices every round), fs, pg and oracle, 1 repeat, `--judge gpt-6.1-sol`. gbrain never runs on this seed.

## Round plan

| Round | Knob file | Change from the previous round and why | Result |
|---|---|---|---|
| 1 | [knobs.round-1.json](knobs.round-1.json) (knobs.default.json) | starting values: 16 turns, 10 to 40 H1 members, 3 to 6 H2 changes, 1 to 3 H3 look-alikes, 3 to 5 H4 sources, one look-alike fact in each H5 chain | stopped at 189 of 300 cells on its $38 budget run; H2 and H3 at 100% on fs and pg; two H1 answer-key defects (below) |
| 2 | [knobs.round-2.json](knobs.round-2.json) | 2026-10-05: H2 and H3 far too easy (fs 20/20 each); record counts, history length and distractors for those two families raised; background accounts lowered to hold world size; H1, H4, H5, noise and the turn cap unchanged (details below) | pooled fs 95%, pg 97%, oracle 99%; H2 to H5 at 95 to 100% on fs; knobs at their useful range |
| 3 | [knobs.round-3.json](knobs.round-3.json) (generator v2, 50k) | 2026-10-05, amendment A1: round-2 knobs plus the reference forms (15% of references by name, the rest split about evenly between code, nickname and account manager); records stop naming their account; calibration moves to the 50k world (details below) | pooled fs 76%, pg 83%, oracle 96%; H1 at 15-20%, mostly turn-cap stops; H2 to H5 at 85-100% |
| 4 | [knobs.round-4.json](knobs.round-4.json) (generator v2, 50k) | 2026-10-06, amendment A2: H2 to H5 questions ask about 2 to 3 accounts each; H1 sets of 6 to 12 members; manager weight raised to hold the manager share; 2,400 appended accounts to hold the 50k size (details below) | pending |

## Round 1 (2026-10-05)

World: seed 20261005, knobs.round-1.json, generator at `19b36fe`. Models Sonnet 5.5 and GPT-6 Astra, arms fs, pg and oracle, `--judge gpt-6.1-sol`, 10 tasks per family. The run stopped at 189 of 300 cells when its $38 budget run was spent: $35.18, about 2.2 to 5 times the v1 cost per cell (fs $0.253, pg $0.217, oracle $0.057 pooled). Cells ran in task order, so H4 has only 2 to 4 cells per arm and H5 none; the freeze rule was not evaluated.

| Arm | H1 | H2 | H3 | H4 | H5 |
|---|---|---|---|---|---|
| fs | 15/20 | 20/20 | 20/20 | 2/2 | not run |
| pg | 17/20 | 20/20 | 20/20 | 3/3 | not run |
| oracle | 16/20 | 20/20 | 20/20 | 4/4 | not run |

Stops: 187 `submitted`, 2 `turn_cap` (GPT-6 Astra fs, Sonnet 5.5 pg); no `error`, `context_overflow` or `harness_error`. Cost per cell by family shows where the money goes: H1 fs cells cost $0.65 on average, H2 to H4 cells $0.04 to $0.08.

### Answer-key defect: a renamed account's later records used its old name

Both oracle models missed the same member on H1-05 (a set of 21) and gave 30 for H1-10 (key 31). Both questions ask for accounts with an open escalated ticket and a renewal within 90 or 120 days on 2026-09-15, and the missing account is the same one: an H3 "renamed" account (former name and code PRRL, renamed on 2026-06-06). Its renewal amendment named the new name. Its ticket opened on 2026-07-12, five weeks after the rename, still named the old name, because the generator rendered every timeline document with the name the account had when its timeline was drawn. The H1 oracle evidence held both documents but not the rename notice, so nothing in the evidence tied the two names to one account. The answer key, computed from the ledger, counted it. Two models agreeing on the same miss pointed at the generator, not the models.

Fix (generator, before any freeze):

1. Records an account's own timeline writes on or after its rename date use the new name and code, as the rename notice says ("records from now on use the new name"); earlier records keep the old ones.
2. H1 oracle evidence includes the rename or merger notice of every member and near miss whose names differ across its records.
3. A merged account's names map to the account it merged into, so its tickets count for that account in H1, and its contract carries that account's renewal date (its own renewal amendment is not written). The previous generator kept them apart: a second case of the same defect, which caused none of round 1's oracle failures.
4. H1 predicates whose answer turns on a boundary a reader can take either way are not drawn: an owner change or a ticket event dated exactly on the as-of date, or a renewal on the first or last day of the window (or one day past it), for an account that holds every other clause.

Regression tests in `test/eval/cat40-hard.test.ts`: "round-1 defect (H1-05, H1-10) ...", "a merged account's tickets count for the account it merged into ...", "no H1 member turns on a boundary ...". The fix changes the calibration world, so round 1's cells stay as recorded and are not resumed; round 2 runs on the fixed generator.

Unresolved answer-key defects after this fix: none known. Round 2's oracle failures are read before any further knob change.

## Round 2 knobs (2026-10-05)

Target: H2 and H3 well below their round-1 100%, pooled fs within 40-70%, H1 and H4 about where they are. Changes, in knob-priority order:

| Knob | Round 1 | Round 2 | Group | Reason |
|---|---|---|---|---|
| `h3_lookalikes_min` / `max` | 1 / 3 | 3 / 5 | record counts | every H3 answer took one lookup among one to three look-alikes; three to five accounts sharing the name or code prefix mean more contracts to read and more chances to take a look-alike's value |
| `h2_changes_min` / `max` | 3 / 6 | 6 / 10 | history length | three to six change orders were read without error; six to ten puts more intermediate values between the question date and today |
| `h2_correction_rate` | 0.4 | 0.7 | history length | most changes now have a backdated correction, so the value in effect has to be resolved against later documents |
| `h2_intermediate_notes` | 2 | 4 | distractor rate | more confident agent notes stating superseded values |
| `accounts` | 110 | 75 | noise (size) | the extra look-alike accounts and change orders add about 600 documents; 35 fewer background accounts keep the world at about 4,500 documents and the H1 population at about 260 accounts (256 in round 1), so H1 set sizes stay in the same range |

Unchanged: H1 member counts, H4 sources and long-document rate, H5 noise sessions, emails, meetings, transcripts, tickets, handoffs, wrong-note rate, team updates and the 16-turn cap. If round 2 still leaves H2 or H3 above 80% on fs, these families' knobs are at their useful range, and the next lever is a generator change to how the question is asked (for example, a disambiguating fact that itself needs a lookup), which is allowed before the freeze and is recorded here first.

## Round 2 (2026-10-05)

World: seed 20261005, knobs.round-2.json, generator at `cfb84fa`, 4,526 documents. Models Sonnet 5.5 and GPT-6 Astra, arms fs, pg and oracle, 10 tasks per family, complete grid (300 cells), $49.36.

| Arm | H1 | H2 | H3 | H4 | H5 | pooled |
|---|---|---|---|---|---|---|
| fs | 16/20 | 19/20 | 20/20 | 20/20 | 20/20 | 95% |
| pg | 16/20 | 20/20 | 20/20 | 20/20 | 20/20 | 97% |
| oracle | 19/20 | 20/20 | 20/20 | 20/20 | 20/20 | 99% |

Most fs runs finished in 3 to 5 turns: the agent searched for the account name and read the matching documents. Raising history length and look-alike counts did not change that, because every relevant document still named the account. A turn cap tight enough to force misses (6 to 8) would measure speed rather than memory (CEO-UC1), so the next lever is the generator change in amendment A1, recorded here before any round-3 cell runs.

## Round 3 knobs (2026-10-05)

Target: pooled fs within 40-70% on the 50k world, with H2 to H5 well below round 2's 95-100%, by making the agent find records that do not name the account. Generator v2 (`model-ladder-hard-v2`, rules in [WORLD_SCHEMA.md](WORLD_SCHEMA.md#reference-forms-generator-v2)) keeps every round-2 fact and answer key and changes only how records refer to accounts. Changes:

| Knob | Round 2 | Round 3 | Group | Reason |
|---|---|---|---|---|
| `direct_name_share` | (1, v1) | 0.15 | reference forms (new) | round-2 agents searched for the account name and read what came back, because every record named it; at 0.15 about one record in seven still does, so a name search finds something but not the deciding records |
| `code_ref_weight` / `nickname_ref_weight` / `manager_ref_weight` | (none) | 0.25 / 0.25 / 0.5 | reference forms (new) | a drawn manager form falls back to code or nickname when it would fit more than one account or the handoff note is not written yet (about 40% of draws); doubling its weight makes the realized shares about even: name 15%, code 30%, nickname 30%, manager 24% of all references at 50k |
| world | 4k (4,526 documents) | 50k (53,631 documents) | scale (amendment A1) | a name search returns the most noise at 50k; the 4k base world is 4,792 documents (round 2 plus 266 account sheets) |

Unchanged: every round-2 knob, including H1 member counts (10 to 40) and the 16-turn cap. The reference-form knobs are not in the analyzer's knob-priority list (`KNOB_PRIORITY`), and they move difficulty the other way from it: a lower `direct_name_share` or a higher `manager_ref_weight` makes tasks harder. If round 3 lands above 70%, the next lever is a higher manager weight (the only form no fixed-string search finds); below 40%, a higher `direct_name_share`. Either is recorded here before the round runs.

**H1 set sizes.** The knobs allow any range, but an H1 key is computed over the 4k accounts only, so that it is the same at both scales (appended 50k accounts never satisfy a predicate, and since v2 they have their own account managers). The round-3 4k population is 261 accounts. Over 3,000 sampled predicates per template, member counts reach at most 25 (one owner), 34 (segment and open escalated ticket), 31 (open escalated ticket and renewal window) and 24 (region and renewal window), with medians of 14, 27, 4 and 3. Sets of 50 to 150 would need roughly four times the 4k accounts, which the 4k size band (3,000 to 5,000 documents) does not hold even with less routine mail per account, or broader predicates such as a region alone, which are degenerate. Round 3 keeps 10 to 40; the generator stops with a message rather than draw a predicate outside the range. The largest round-3 oracle prompt is about 67,000 tokens (H1-11 at 50k), well under the 200,000-token limit.

**Free difficulty proxy.** `bun eval/runner/cat40/hard-proxy.ts --scale large --knobs knobs.round-2.json --knobs knobs.round-3.json`, seed 20261005, 50k, no model call. For each task it takes the oracle's event records (documents that refer to an account) and asks: does the record contain the name the question asks about; does one case-insensitive grep for that name return it; and does it after a second grep for the account code (given by the CRM record) and a third for the nickname (given by the account sheet). H1 questions name no account, so each member or near miss is grepped by its own name. Shares are averaged over tasks.

| Family | records, round 2 | name verbatim, round 2 | one name grep, round 2 | records, round 3 | name verbatim, round 3 | one name grep, round 3 | name, then code, round 3 | name, code, then nickname, round 3 |
|---|---|---|---|---|---|---|---|---|
| H1 | 2,547 | 73.6% | 73.6% | 2,887 | 15.3% | 15.3% | 49.6% | 85.3% |
| H2 | 270 | 100.0% | 100.0% | 284 | 15.6% | 15.6% | 42.5% | 73.6% |
| H3 | 139 | 91.8% | 91.8% | 139 | 22.4% | 23.6% | 46.6% | 71.3% |
| H4 | 76 | 90.3% | 90.3% | 101 | 5.6% | 5.6% | 34.8% | 74.2% |
| H5 | 30 | 100.0% | 100.0% | 36 | 11.3% | 11.3% | 38.8% | 76.3% |
| all | 3,062 | 91.1% | 91.1% | 3,447 | 14.0% | 14.3% | 42.4% | 76.1% |

Round 2's H1 share is below 100% because v1 tickets and team updates already named an account by code about half the time; a second grep for the code reached 98% of round-2 records. In round 3 a name search reaches 14%, and the code and nickname searches together reach 76%. The remaining quarter use the manager form, which needs the account's descriptor from its sheet and its manager on the record's date from the handoff notes. The proxy measures what a search returns, not what an agent concludes; an agent that reads the CRM record and the account sheet first can still reach three quarters of the records with three searches, so the proxy is an upper bound on how much harder round 3 is.

Risks to read with the round-3 results: the oracle now has to resolve references from the resolution documents in its evidence (every reference reaches the asked name within two hops of the oracle's documents, checked by `hardWorldProblems`), so an oracle failure may be a resolution failure rather than an answer-key defect; and fs and pg cells will take more turns than in round 2, so a turn-cap share above 50% of failures is possible.

## Round 3 (2026-10-05)

World: seed 20261005, 50k (`--scale large`), knobs.round-3.json, generator v2 at `fd80bdd`, 53,631 documents, digest `c31e0b50…f8245`. Models Sonnet 5.5 and GPT-6 Astra, arms fs, pg and oracle, complete grid (300 cells), $99.35. The first attempt stopped while building the pg store: OpenAI's per-minute token limit for embeddings returned 429 and the build had no retry. `fd80bdd` adds backoff and retry; that attempt's output is kept apart (`cells-aborted-embed429`) and ran no cells.

| Arm | H1 | H2 | H3 | H4 | H5 | pooled |
|---|---|---|---|---|---|---|
| fs | 3/20 | 17/20 | 19/20 | 18/20 | 19/20 | 76% |
| pg | 4/20 | 19/20 | 20/20 | 20/20 | 20/20 | 83% |
| oracle | 16/20 | 20/20 | 20/20 | 20/20 | 20/20 | 96% |

Reference forms moved H1 (aggregation over 10 to 40 accounts) from 80% to 15-20%, mostly through turn-cap stops: resolving each member takes several searches. They did not move H2 to H5. In those families the question is about one account, and transcripts show the agent reading that account's sheet, then searching for every alias and the manager phrase in one pattern and reading the hits in about 10 calls. One-account questions stay within reach of a frontier agent with grep however the references are spread; the lever that changed difficulty is the number of accounts a question needs.

## Round 4 knobs (2026-10-06)

Target: H2 to H5 well below round 3's 85-100% on fs and pg, and H1 decided by finding members rather than by the turn cap, with pooled fs and pg within 40-70% on the 50k world. Amendment A2 records why: round 3 showed that one-account questions stay within reach of a frontier agent with grep however references are spread (the agent reads one account sheet, greps every alias and the manager phrase in one pattern and answers in about 10 calls), and that the number of accounts a question needs is what moves difficulty. The generator is still `model-ladder-hard-v2`; the multi-account rules are in [WORLD_SCHEMA.md](WORLD_SCHEMA.md#multi-account-questions-amendment-a2). Changes:

| Knob | Round 3 | Round 4 | Group | Reason |
|---|---|---|---|---|
| `multi_account_min` / `max` | (1, v2) | 2 / 3 | record counts (new) | each H2 to H5 question asks about 2 or 3 accounts that share no descriptor, first word, code prefix or account manager, so each needs its own sheet, alias search and reading; at 50k the questions ask about 2.4 to 2.7 accounts on average (below) |
| `h1_min_members` / `h1_max_members` | 10 / 40 | 6 / 12 | record counts | round 3's H1 ended fs 3/20 and pg 4/20, and each arm had 12 turn-cap stops pooled over all families, mostly H1: at about 15 members (round 3's mean on this seed) resolving every member did not fit in 16 turns. The suggested 6 to 20 would not shrink H1 here: the multi-account accounts double the 4k population (261 to 547 accounts), plain owner sets grow, and 6 to 20 gives a mean of 16.3 members. 6 to 12 gives a mean of 9.2. The generator narrows a question to one region (or, for the region template, one segment) when its plain predicate cannot land in range after half its attempts, so every template stays usable with the larger population |
| `manager_ref_weight` | 0.5 | 1.0 | reference forms | with twice the 4k accounts per manager, more manager draws would fit two accounts and fall back; on the 4k base, 0.5 would have dropped the realized manager share from round 3's 26% to 17%; at 1.0 it is 23% there and 30% of all references at 50k (25% in oracle documents; round 3: 24% and 22%), so the reference-form difficulty holds while the account count moves |
| `large_extra_accounts` | 2,800 | 2,400 | noise (size) | the extra task accounts add about 5,000 documents to the 4k base; 400 fewer appended accounts keep the 50k world at 54,999 documents (round 3: 53,631) and away from the 62,500 limit on the held-out seed |

Unchanged: every other round-3 knob, including the reference-form mix by name (15%) and the 16-turn cap. The 4k base world of a multi-account knob set has 10,038 documents, above the 4k band; under A2 it runs no cells and is only the 50k world's base, so the generator holds only the 50k world to its size band (CEO-F5). Multi-account worlds draw people from 76 surnames instead of 36 (the 4k world needs about twice the people); v1 and v2 worlds are unchanged.

**Answers.** A multi-account question lists its items as numbered single-account questions (the wording v2 uses) and asks for a JSON array of the answers in order. The Hard scorer grades it as `values` (new in `cat40-hard-score-v2`): each element is graded like a one-account value answer against its own accepted and wrong values, and success needs every element right. Earlier answer kinds score as before.

**Free difficulty proxy**, seed 20261005, 50k, no model call (`bun eval/runner/cat40/hard-proxy.ts --scale large --knobs knobs.round-3.json --knobs knobs.round-4.json`):

| Family | round 3: oracle docs per task | accounts per answer | name, code, then nickname grep | round 4: oracle docs per task | accounts per answer | name, code, then nickname grep |
|---|---|---|---|---|---|---|
| H1 | 212.5 | 15.1 | 85.3% | 229.5 | 9.2 | 82.5% |
| H2 | 16.2 | 1.0 | 73.6% | 43.0 | 2.7 | 70.0% |
| H3 | 15.8 | 1.0 | 71.3% | 39.1 | 2.4 | 68.0% |
| H4 | 7.0 | 1.0 | 74.2% | 17.1 | 2.6 | 74.1% |
| H5 | 5.2 | 1.0 | 76.3% | 13.3 | 2.5 | 71.2% |

In round 4, 15% of the oracle's event records name the asked account (round 3: 14%), and H2 to H5 oracle evidence grows two to three times. H1 oracle evidence stays near 230 documents because near misses (capped at 40 accounts) dominate it. The largest oracle prompt is about 49,000 tokens (H1-10). The 50k world has 54,999 documents, digest `20d1c8b9…341d5d`.

**Cost.** Without measured cells, `hard-ops.ts project --step calibrate --scale large --world <round-4 world>` gives $87.48 ($100.60 with the margin), from round-1 rates times the 50k factor. Round 3 cost $99.35 for the same grid; H2 to H5 cells now ask about two to three accounts, so expect them to cost about that many times round 3's, and H1 cells less. On the ledger machine the script projects from round 3's measured 50k cells, which are one-account cells and so understate H2 to H5.

## Notes after the freeze

Dated notes for runner or scorer fixes that leave every world digest unchanged (CEO-F17, ENG-F6).

## Analyzer output

### Round 2 (analyzer output, 2026-10-05)

Freeze rule, round 2: FAIL. Models: claude-sonnet-5-5, gpt-6-astra. Tasks: 50. Pooled arm: pg. Wilson 95% intervals in brackets; point estimates decide.

| Condition | measured | Wilson 95% | threshold | n | result |
|---|---|---|---|---|---|
| (a) pooled pg success (the better of fs and pg) | 96% (96/100) | [90.2, 98.4] | 40-70% | 100 | FAIL |
| (b) claude-sonnet-5-5: better of fs and pg (pg) | 94% (47/50) | [83.8, 97.9] | 20-80% | 50 | FAIL |
| (b) gpt-6-astra: better of fs and pg (fs) | 98% (49/50) | [89.5, 99.6] | 20-80% | 50 | FAIL |
| (c) claude-sonnet-5-5: oracle | 100% (50/50) | [92.9, 100.0] | at least 90% | 50 | PASS |
| (c) gpt-6-astra: oracle | 98% (49/50) | [89.5, 99.6] | at least 90% | 50 | PASS |
| (d) family H1: oracle, pooled over models | 95% (19/20) | [76.4, 99.1] | at least 80% | 20 | PASS |
| (d) family H2: oracle, pooled over models | 100% (20/20) | [83.9, 100.0] | at least 80% | 20 | PASS |
| (d) family H3: oracle, pooled over models | 100% (20/20) | [83.9, 100.0] | at least 80% | 20 | PASS |
| (d) family H4: oracle, pooled over models | 100% (20/20) | [83.9, 100.0] | at least 80% | 20 | PASS |
| (d) family H5: oracle, pooled over models | 100% (20/20) | [83.9, 100.0] | at least 80% | 20 | PASS |
| (e) turn_cap share of pooled pg failures | 50% (2/4) | [15.0, 85.0] | at most 50% | 4 | PASS |
| (grid) complete grid (2 models x 3 arms x 50 tasks) and one experiment | complete |  | no problems | 300 | PASS |

| Model | fs | pg | oracle |
|---|---|---|---|
| claude-sonnet-5-5 | 92% (46/50) [81.2, 96.8] | 94% (47/50) [83.8, 97.9] | 100% (50/50) [92.9, 100.0] |
| gpt-6-astra | 98% (49/50) [89.5, 99.6] | 98% (49/50) [89.5, 99.6] | 98% (49/50) [89.5, 99.6] |

| Family | fs | pg | oracle |
|---|---|---|---|
| H1 | 80% (16/20) [58.4, 91.9] | 80% (16/20) [58.4, 91.9] | 95% (19/20) [76.4, 99.1] |
| H2 | 95% (19/20) [76.4, 99.1] | 100% (20/20) [83.9, 100.0] | 100% (20/20) [83.9, 100.0] |
| H3 | 100% (20/20) [83.9, 100.0] | 100% (20/20) [83.9, 100.0] | 100% (20/20) [83.9, 100.0] |
| H4 | 100% (20/20) [83.9, 100.0] | 100% (20/20) [83.9, 100.0] | 100% (20/20) [83.9, 100.0] |
| H5 | 100% (20/20) [83.9, 100.0] | 100% (20/20) [83.9, 100.0] | 100% (20/20) [83.9, 100.0] |

| Arm | submitted | turn_cap | no_tool_call | context_overflow | error | harness_error | cost, all attempts |
|---|---|---|---|---|---|---|---|
| fs | 97 | 2 | 0 | 1 | 0 | 0 | $24.4804 |
| pg | 98 | 2 | 0 | 0 | 0 | 0 | $19.3140 |
| oracle | 100 | 0 | 0 | 0 | 0 | 0 | $5.5705 |

Cost of this round over every attempt (agent, embeddings, gbrain and judge): $49.36.

Next:
- Too easy: raise record counts (h1_min_members, h1_max_members, h4_sources_min, h4_sources_max, h3_lookalikes_min, h3_lookalikes_max) to make tasks harder. Priority order: record counts, then history length, then distractor rate, then noise, then turn cap.

### Round 3 (analyzer output, 2026-10-05)

Freeze rule, round 3: FAIL. Models: claude-sonnet-5-5, gpt-6-astra. Tasks: 50. Pooled arm: pg. Wilson 95% intervals in brackets; point estimates decide.

| Condition | measured | Wilson 95% | threshold | n | result |
|---|---|---|---|---|---|
| (a) pooled pg success (the better of fs and pg) | 83% (83/100) | [74.5, 89.1] | 40-70% | 100 | FAIL |
| (b) claude-sonnet-5-5: better of fs and pg (pg) | 80% (40/50) | [67.0, 88.8] | 20-80% | 50 | PASS |
| (b) gpt-6-astra: better of fs and pg (pg) | 86% (43/50) | [73.8, 93.0] | 20-80% | 50 | FAIL |
| (c) claude-sonnet-5-5: oracle | 94% (47/50) | [83.8, 97.9] | at least 90% | 50 | PASS |
| (c) gpt-6-astra: oracle | 98% (49/50) | [89.5, 99.6] | at least 90% | 50 | PASS |
| (d) family H1: oracle, pooled over models | 80% (16/20) | [58.4, 91.9] | at least 80% | 20 | PASS |
| (d) family H2: oracle, pooled over models | 100% (20/20) | [83.9, 100.0] | at least 80% | 20 | PASS |
| (d) family H3: oracle, pooled over models | 100% (20/20) | [83.9, 100.0] | at least 80% | 20 | PASS |
| (d) family H4: oracle, pooled over models | 100% (20/20) | [83.9, 100.0] | at least 80% | 20 | PASS |
| (d) family H5: oracle, pooled over models | 100% (20/20) | [83.9, 100.0] | at least 80% | 20 | PASS |
| (e) turn_cap share of pooled pg failures | 71% (12/17) | [46.9, 86.7] | at most 50% | 17 | FAIL |
| (grid) complete grid (2 models x 3 arms x 50 tasks) and one experiment | complete |  | no problems | 300 | PASS |

| Model | fs | pg | oracle |
|---|---|---|---|
| claude-sonnet-5-5 | 68% (34/50) [54.2, 79.2] | 80% (40/50) [67.0, 88.8] | 94% (47/50) [83.8, 97.9] |
| gpt-6-astra | 84% (42/50) [71.5, 91.7] | 86% (43/50) [73.8, 93.0] | 98% (49/50) [89.5, 99.6] |

| Family | fs | pg | oracle |
|---|---|---|---|
| H1 | 15% (3/20) [5.2, 36.0] | 20% (4/20) [8.1, 41.6] | 80% (16/20) [58.4, 91.9] |
| H2 | 85% (17/20) [64.0, 94.8] | 95% (19/20) [76.4, 99.1] | 100% (20/20) [83.9, 100.0] |
| H3 | 95% (19/20) [76.4, 99.1] | 100% (20/20) [83.9, 100.0] | 100% (20/20) [83.9, 100.0] |
| H4 | 90% (18/20) [69.9, 97.2] | 100% (20/20) [83.9, 100.0] | 100% (20/20) [83.9, 100.0] |
| H5 | 95% (19/20) [76.4, 99.1] | 100% (20/20) [83.9, 100.0] | 100% (20/20) [83.9, 100.0] |

| Arm | submitted | turn_cap | no_tool_call | context_overflow | error | harness_error | cost, all attempts |
|---|---|---|---|---|---|---|---|
| fs | 86 | 12 | 0 | 2 | 0 | 0 | $59.2660 |
| pg | 88 | 12 | 0 | 0 | 0 | 0 | $32.5637 |
| oracle | 100 | 0 | 0 | 0 | 0 | 0 | $7.5241 |

Cost of this round over every attempt (agent, embeddings, gbrain and judge): $99.35.

Next:
- Too easy: raise record counts (h1_min_members, h1_max_members, h4_sources_min, h4_sources_max, h3_lookalikes_min, h3_lookalikes_max) to make tasks harder. Priority order: record counts, then history length, then distractor rate, then noise, then turn cap.
- Difficulty comes from truncation (more than half of the pooled arm's failures are turn_cap stops): move content knobs, starting with record counts, not the turn cap. The turn cap moves only last, with a dated reason in calibration.md.
