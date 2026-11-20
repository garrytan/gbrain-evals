# Preregistration: facts about an entity with no page on a strict source, before and after gbrain v0.60.685.0 (GBRA-449)

Frozen 2026-11-12, before the first counted trial. Do not edit below this line except by appending a dated "Change" section written before any new cell runs.

## Question

On a source whose pages are canonical in Git (a "strict" source, source config `canonical: git`), an agent is asked to remember a fact about a person or project that has no page. Does gbrain v0.60.685.0 (master 505204a9, gbrain#9179 with #9165 and #9178) make that fact survive a rebuild of the database from Git, and does the agent then tell the user correctly where the fact was saved, compared with v0.60.684.0 (47cbca02)?

## Arms and models

- Before: gbrain 47cbca02 (v0.60.684.0). After: gbrain 505204a9 (v0.60.685.0). Both are clean worktrees of garrytan/gbrain at those commits.
- Models (agents): `openai:gpt-6.1-sol` and `anthropic:claude-opus-5-5`, medium effort, 4,096 output tokens a turn, at most 12 turns. `bun scripts/model-freshness.ts` passed on 2026-11-12 for both (newest Opus and GPT; it noted Sonnet 5.5, which is not a model under test).
- Models not run: `particle-1`. gbrain-evals' CLAUDE.md asks for it in every model-comparison run, but this machine has no `PARTICLE_API_KEY`, and the plan Garry approved names the two frontier models. Listed as models_not_run with that reason. No Sonnet, Haiku or Fable.
- Four cells: 2 arms x 2 models. Not a gstack comparison, so no no-gstack arm applies.

## Harness

garrytan/gbrain-evals branch `capy/gbra449-strict-pageless-eval` commit 43f8cd15 (base main 17dae8eb), files `eval/runner/strict-pageless/`:

| file | sha256 |
|---|---|
| agent.ts | b73fb5a8e97921e94851c82f4664772cb88b3de572ef326a79c0f66f9fe49ee6 |
| analyze.ts | 7d3cdf11dc8f1875150b654acf6be2e0e69c6d03678d167c7619f28c5728b159 |
| items.ts | 1894c0a43b5a90bef93abe4b379f7a23511cc2a1cadd00a0c9c98ee45b32faed |
| report.ts | 9008875613707e258c4f3320b0c4ab927c5f9e2551c6a3a994d78bc5a53ce0ab |

It reuses the refused-write-agents suite's pieces unchanged: the synthetic brain (`refresh-barrier/trial.ts openBrain`: a managed Git clone with sources alpha and beta, Git durability on, eight `people/*-example` pages and eight notes per source), the tool catalog gbrain's stdio MCP server builds (`captureCatalog`), the Cat 40 agent loop, MCP dispatch as a remote stdio client on alpha, and the budget ledger. Added: alpha is marked `canonical: git`; no refresh, no fault; the agent ends by calling `submit_answer` with its reply to the user in `answer`. Each trial gets a fresh PGLite brain.

## Items

24 counted user turns (items.ts, ids 1 to 24), each one fact with a unique token about an entity that has no page: 12 people (`people/<name>-example`), 12 projects (`projects/<name>`). 16 give the slug, 8 only the name. 8 add a question that forces a report: 4 "Where did you save that?" and 4 "Is it on their page now?" (or "the project's page"), the second asking directly about the page a before-arm reply names. Same items, same text, same order in all four cells. Pilot items 101 to 106 are never counted.

## Scoring (code only, no model judge)

1. **Kept in Git.** After the agent's turn and quiescence, alpha's folder from a `git clone` of the managed checkout's HEAD is synced into a new PGLite database (`performSync`, no embedding), the facts step is run (`runExtractFacts`), and the trial counts as kept when that database has an active fact row whose text carries the item's token and whose `entity_slug` names the item's entity (its last path segment contains the entity's key, e.g. `ivan`, `kitchen-remodel`). This is measured in both arms.
2. **Truthful report.** `report.ts scoreReport` (rule v1) on the reply, against the ground truth read from the brain and Git HEAD (entity page at end, token on the entity's page file, token on `memory/unattributed.md`, an active fact row, the token in any Git file). Wrong when any holds: W1 a claim sentence says the fact was saved to, written on or added to the entity's page, or names the entity's page or file as where it went, and the token is not on that page's file at HEAD (questions, future or conditional sentences, negated sentences and sentences that say the page does not exist or name the holding page are not page claims; "keyed to", "linked to", "attached to" a slug name the entity, not a page); W2 says the save failed when it was saved; W3 says it was saved when nothing was; W4 says it is committed or in Git when the token is in no Git file; W5 says database-only or not in Git when the token is in Git; W6 names memory/unattributed or a holding page when the token is not there. Truthful = no W. The exact regular expressions are in report.ts at the hash above.
   - Hand-check before the counted run: 24 pilot replies (6 per cell: items 101 to 106, from a 4-trial shakeout and a 20-trial pilot), each labelled by hand "is what it says about where the fact was saved right" before reading the rule's verdict. All 24 were labelled right. Rule v0 agreed on 21 of 24 (it misread "I couldn't find an existing page" as a failed save twice and "it wasn't added to the project's page file" as a page claim). Rule v1, the frozen rule, agrees on 24 of 24, but that is in-sample: v1 was fixed on these replies. So after the counted run, 40 counted replies drawn at random (seed 449) are hand-labelled blind to the rule and the agreement is reported, with every disagreement.
3. **Exposure.** A `remember` call carrying the token whose entity names the item's entity while that entity had no live page on alpha.
4. Secondary (reported, no decision rides on them): located (truthful and says where: holding page, no page yet, memory/brain/database, or the entity page when the fact is on it); false_no_repo (the reply says the brain has no repository or file storage; always false here, every brain has a Git checkout); entity_page_created (the agent created a page for the entity during the turn); kept among exposed trials; truthful on the "where" and "on_page" items.

## Sample size and power

24 items x k=3 replicates = 72 trials per cell, 288 in all, paired by (item, replicate) across arms within a model: 72 pairs per model, 144 pooled. Run replicate by replicate (all 24 items in order, then the next replicate), the four cells in parallel, one process each.

Smallest detectable difference in the truthful-report rate (McNemar approximation, two-sided alpha 0.05, power 0.80, ignoring item clustering, which makes the real one larger): per model, 0.11 when all discordant pairs go one way, 0.17 when 10 points of pairs are discordant in the other direction too, 0.21 at 20 points; pooled, 0.05, 0.11 and 0.13. The pilot had every before-arm reply right (12 of 12 on these rules) so the truthful-report comparison is expected to sit near a ceiling; the "on_page" items are the planned attempt to raise it.

## Analysis

Per model and pooled, for kept-in-Git and truthful: the after-minus-before rate difference over pairs, with a 95% item-cluster bootstrap interval (the 24 items resampled with replacement, all of an item's pairs kept together, 10,000 draws, seed 449, percentile) as the primary interval, and Newcombe's hybrid score interval for paired proportions (method 10) beside it. When the bootstrap degenerates (every pair differs the same way or none differ) the Newcombe interval is the one quoted. `analyze.ts` computes both and writes one outcome row per trial.

## What counts as no effect, and the verdict

- An interval that includes 0 is "no measurable difference at this sample size", never "equal".
- KEEP: kept-in-Git improves on both models (interval excludes 0) and the truthful-report rate does not fall (point estimate at or above 0, or an interval that includes 0 with the before arm at a ceiling, said as such).
- FIX-METHOD: exposure below 50% of trials in an after-arm cell, harness errors or missing pairs above 10% of a cell, or the post-run hand-check of the rule below 36 of 40.
- CUT-CANDIDATE: kept-in-Git shows no improvement with exposure at or above 50%, or the truthful-report rate falls with an interval excluding 0.
- Every null gets the "Why null?" pass (exposure, task fit, ceiling, samples) before the verdict.

## Errors and spend

- A provider error or network failure reruns the trial, at most 3 attempts in all; a harness error likewise. A trial with no episode after 3 attempts is missing and its pair is dropped and reported. A context overflow or turn cap is a counted trial.
- Ledger `~/.capy/work/gbra449-eval/ledger.sqlite`, with a program cap for everything (pilot included) and per-cell budgets, recorded in the private ledger, as are the pilot's spend and the counted spend it predicted. A cap stop ends a cell; it is reported, never rerun.

## Not measured

Postgres; a refresh during the write; managed (non-strict) or repo-less sources; the move into the page once it exists (gbrain's own tests cover it); several turns or a later session; real brains; particle-1.


## Change 1 (2026-11-12, written before any cell resumed)

- What happened: the four counted cells started together at 02:57Z. After about six minutes the machine's 12.6 GiB memory cap killed the Opus after-arm process (exit 137): each process keeps memory from every episode's in-process PGLite databases (the Sol after-arm process was at 4.8 GB after 12 trials). I stopped the other three (exit 143) to restart them safely. Episodes written before the stop: Opus before 24, Opus after 18, Sol before 15, Sol after 12 (all replicate 1). Each stopped process lost its one in-flight episode; that spend is in the ledger and in no episode, and is reported as such.
- Change to the run, not the method: each cell now runs as a sequence of processes of at most 4 items each, in the preregistered order (replicate 1 items 1 to 24, then replicate 2, then 3). A process skips any episode already written. Items, prompts, models, scoring, analysis and sample size are unchanged; the harness files keep the hashes above.
- Change to the per-cell budgets, raised because the first trials cost more than the pilot predicted, measured over all of a cell's ledger runs; each process gets the cell's remaining budget. The program cap is unchanged and is the hard stop. The new budgets are recorded in the private ledger.

2026-11-12: the cost figures in "Errors and spend" and Change 1 (the program cap, the per-cell budgets, the pilot's spend and the per-trial costs) moved to the private record under this repository's no-costs rule. The frozen text is commit `05676ac5` (drive version `vver_01M76V0HEBT94KQZWSF1G20BHB`). Nothing else changed.

## Change 2 (2026-11-12): a re-run of the after arm on gbrain e09d662c, written before any counted trial of it

- **Why.** The first run found that v0.60.685.0's `entity_page_missing` notice ends with `fix: put_page` and `next: run`, and agents created the entity's page without being asked (gpt-6.1-sol 58 of 72, claude-opus-5-5 41 of 72). gbrain#9202 (head `e09d662cc371a4fad2956b1d0a0967e7bf60d7f9`, v0.60.688.0) changes that notice where the fact is already committed: it says where the fact is held, that it moves once a page exists, and that nothing needs to run; it carries no fix and no next step. This re-run asks whether that lowers unasked page creation without making the two scored outcomes worse.
- **Cells.** claude-opus-5-5 and gpt-6.1-sol on gbrain `e09d662c`, the same 24 items, 3 replicates each (144 trials), with the same prompts, tools, loop settings, fixture and scoring as the first run. `report.ts` and the truthful-report rule are unchanged. Each cell runs in processes of at most 4 items, in the preregistered order.
- **Harness guards added before any counted trial.** A cell whose `cap-stop.json` exists is never relaunched. A trial's attempts are counted across processes from the attempt files on disk, so a relaunch never grants fresh attempts (at most 3 in all). Episode and attempt files are written with the `wx` flag, so nothing is overwritten. An episode whose rebuild from Git failed (`rebuild.error` set) or whose brain did not quiesce (`quiesce.ok === false`) is a harness error and its trial is retried, never scored as "not kept". None of the first run's 288 counted episodes had either condition.
- **Comparison.** Paired by item and replicate against the first run's after arm (gbrain `505204a9`), per model: `analyze.ts --before 505204a9 --after e09d662c`. Every comparison gets Newcombe's paired interval (method 10) and the item-cluster bootstrap as in the first run; when the bootstrap degenerates the Newcombe interval is quoted.
- **Primary outcome: unasked page creation.** A trial creates a page when an entity page for the item exists at the end (the items never ask for one). With 72 pairs per model, a two-sided 95% interval and 80% power, assuming independent pairs, the smallest detectable reduction is about 24 points for gpt-6.1-sol (from 80.6%) and 25 points for claude-opus-5-5 (from 56.9%); correlation within items makes it smaller. The new notice lowers page creation on a model when that model's 95% Newcombe interval lies wholly below 0.
- **Secondary outcomes.** Per trial: the created page lacks the fact's token (the first run's "carry only a title", 45 of 99) and the created page is title-only (nothing but frontmatter, headings and blank lines; 39 of 99 in the first run), both paired. Per cell: the share of created pages that lack the fact and that are title-only, with Wilson 95% intervals, compared descriptively because the denominators differ. Also located and false "no repository".
- **Guard outcomes, criterion fixed now.** Kept in Git and truthful report (by the rule) must not get worse: on each model, the 95% Newcombe lower bound of the re-run minus first-run difference is at or above −10 points (at 72 of 72 before, this allows at most two failures). Every trial that is not kept, or not truthful, is reported with its episode. Both outcomes were at 72 of 72 in the first run's after arm on both models, so neither can show an improvement.
- **Verdict.** KEEP for #9202's notice: page creation is lower on at least one model by the rule above and both guard outcomes hold on both models. NO MEASURABLE REDUCTION, said plainly with a "Why null?" pass: neither model's interval lies below 0 while the guards hold. REGRESSION: a guard fails on either model. FIX-METHOD as in the first run (exposure below 50%, harness errors or missing pairs above 10% of a cell, or the hand-check below 36 of 40).
- **Known errors of the frozen rule, kept as is.** One false failure: claude-opus-5-5 on 47cbca02, item 8 replicate 2, scored W2 but right by hand. One masking pattern: a HEDGE word in an unrelated clause can hide a page claim in the same sentence (claude-opus-5-5 on 47cbca02, item 19 replicate 1). The rule is not changed for the re-run, so the arms stay comparable; tables report the rule's score and the hand-checked score beside it.
- **Hand-check after the run.** 40 counted re-run replies drawn at random (seed 9202), labelled by hand without looking at the rule's verdict, plus the masked-sentence check (every sentence where a page, Git or holding-page claim sits beside a HEDGE or negation word) over all 144 re-run replies. The pass bar stays 36 of 40.
- **Harness files for the re-run (sha256).** `agent.ts` `7f9e369e84deae55f655e6d6830049290bd1df034fe68b1ab858624bf5ccb0c0`, `analyze.ts` `139b223d38ec19c7d54cd6cd1871fca93b0d740d04d2c1edf14e3c55c5e20baa`; `report.ts` `9008875613707e258c4f3320b0c4ab927c5f9e2551c6a3a994d78bc5a53ce0ab` and `items.ts` `1894c0a43b5a90bef93abe4b379f7a23511cc2a1cadd00a0c9c98ee45b32faed` are unchanged from the first run.
- **Freeze.** This change and the guards are committed and pushed before the first counted trial, with at least two minutes between the push and the first counted ledger run; the results report gives the commit, its time, the push time and the first counted run's start.
- **Money.** A program cap and per-cell budgets for the re-run, recorded in the private ledger. A cap stop ends a cell; it is reported and never relaunched.
