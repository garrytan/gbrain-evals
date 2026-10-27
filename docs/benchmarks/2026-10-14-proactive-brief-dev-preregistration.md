# Preregistration: the proactive brief on Cat 40 family P, development phase (wave 5 D6)

Frozen on October 14, 2026 (Pacific), in its own commit, before any paid cell. It implements the development half of
wave 5 item D6 of the approved plan
[Build the 10x memory advantage](https://github.com/garrytan/gbrain-evals/blob/capy/10x-memory-advantage-plan/docs/plans/2026-10-07-10x-memory-advantage/PLAN.md)
("Wave 5: The proactive brief"). Changes after this commit are amendments, appended at the bottom with their reason
and committed before any cell they govern.

This run uses development seeds only and produces development evidence only. It never decides whether the brief
ships on by default. Under the plan's wave 5 exit rule, only D6's sealed verdict can make that decision. The sealed seed is out of scope here:
it needs new custody on the owner's machine, and nothing in this run mints, generates or reads sealed material.

Code: `eval/runner/t0-program-primary.ts` (the T0 carrier, with the `brief-off` and `brief-on` arms),
`eval/runner/t0/brief.ts` (brief block, paid-arm guard, item classes, analysis), `eval/runner/t0/{delivery,score}.ts`
(unchanged delivery contract and scorer), `eval/generators/program-primary-gen.ts` (`PP_BRIEF_DEV_SEEDS`), registry
entry `proactive-brief` (legacy alias `D6`). Tests: `test/eval/t0-brief.test.ts`.

## The question

When gbrain pushes its "Before you start" brief into the session, do agents finish meeting-prep and reply tasks
correctly more often than with the brief off? The tasks need facts from an earlier session, and the request never
names those facts.

## What is known before any spend

These findings come from hermetic runs on October 14 ($0, scripted models, keyless brains) against gbrain v0.60.240.0. They shape the
design, so they are frozen here rather than discovered in the results.

1. **What the brief pushes.** In this release the brief is assembled from two arms (`src/core/context/proactive-brief.ts`).
   One is open loops, which only Google mail and calendar detection writes (`src/core/google/`). The other is the newest
   active fact about the counterparty. Per counterparty it shows the top loop, then the newest fact, then further loops,
   with at most 3 items, 600 characters per item and 1,800 characters in total. A brain built from markdown has no loops,
   so in every cell here the brief carries at most one item per named counterparty: the newest fact.
2. **When it fires.** The UserPromptSubmit gate needs two things: a counterparty resolved at confidence ≥ 0.8 through an
   alias or title, and a reply or meeting phrase from the deterministic lexicon. Session 2 of the T0 workload names the
   contact in full ("Prep me for my next meeting with …", "… just emailed me … Draft my reply"), so the brief fires on both
   task kinds. On one hermetic persona (seed 20261201, 4 tasks, both arms) it fired in 4 of 4 brief-on cells, with one
   item each (308 characters on average, 316 at most). It was silent in 4 of 4 brief-off cells. SessionStart showed no
   brief, because its calendar trigger needs calendar events.
3. **Overlap with hot memory.** Both arms already inject the session-1 facts. Facts written within the last 24 hours reach
   session 2 through the UserPromptSubmit "Hot memory (recent facts)" block whatever the brief switch says, and the two
   sessions run minutes apart. In the hermetic run, all 12 needed facts (3 per task) were in session 2's injected context in
   both arms. The brief carried 4 of them, one per task.
4. **Ceiling.** On the T0 workload the v0.60.106.0 baseline failed 0 of 64 for Sonnet 5.5 and gpt-6.1-sol. Opus 5.5 failed
   11 of 64 under `t0-score-v2`, and the scorer audit read 10 of those as disambiguations that `t0-score-v3` excuses.
5. **Why not the T0b workload.** On T0b version 2 worlds, prep prompts name the contact by first name plus a three-letter
   company code ("a call with Dario from TER"). The gate rejects both by design: a one-token first name is a common-word
   surface and the code is below the alias minimum. So the brief never fires on prep tasks, half of the brief-on cells
   could not pass the paid-arm guard, and those cells would test nothing. T0b's `passing` session-1 knob changes whether
   the reader saves the promise. That works the same way in both arms, because the brief only pushes what the brain holds.

**Prediction.** Findings 3 and 4 make a null result likely: no paired difference, with readers at or near the ceiling.
The run still measures the product path end to end. It shows whether the extra block changes behavior (tool calls,
tokens, confident-wrong answers), whether the guard holds on real readers, and what the brief costs in characters. The
decision rule below is written so that a null result cannot read as a gain.

## Workload (frozen)

- Generator `program-primary-v1` (`eval/generators/program-primary-gen.ts`), unchanged. Each persona has one brain of 73
  pages and 4 tasks. In session 1 the user tells the agent about a call with the contact (a commitment, a meeting moved
  to a new date, and a correction of a seat count, price or role) and asks it to update the brain. Session 2 runs in a new
  serve process on the simulated next day and asks for meeting prep or a reply that names none of the three facts.
- **New development seeds:** 20261201, 20261202, 20261203, 20261204, 20261205, 20261206 (`PP_BRIEF_DEV_SEEDS`). No
  earlier run used them. They are disjoint from T0's `PP_DEV_SEEDS` (20261008 to 20261015) and from every T0b seed.
  Every persona passes the generator's presence and solvability check. That gives 24 tasks: 12 prep and 12 reply.
- Persona-level nesting: the four tasks of a persona share one brain and run in order. Personas run in parallel (3 at a time).

## The release under test (frozen)

gbrain v0.60.240.0, commit `1355f32fa487efd1449d560ad0f334b293420c36` (Merge #6703), built through
`eval/runner/lifecycle/builds.ts` with tree and CLI-version verification, surface `starter`.

## Arms (frozen)

| Arm | What differs |
|---|---|
| `brief-off` | Nothing is set; `context.proactive_brief` keeps the release default (off). |
| `brief-on` | `gbrain config set context.proactive_brief true` runs on the brain after every snapshot restore, before session 1. It stays on through session 2. |

Everything else is the T0 carrier as frozen in
[the T0 preregistration](2026-10-08-program-primary-preregistration.md): the snapshot, the two sessions, the native-event
delivery contract `t0-delivery-v1` (`eval/runner/t0/delivery.ts`: SessionStart and UserPromptSubmit hook output injected
into the user turn the way Claude Code renders hook context), the stdio MCP tools, 20 turns per session, and the
system prompt. Every task runs once in each arm for each reader (paired), with 1 repeat.

## Readers and settings (frozen)

`claude-opus-5-5`, `claude-sonnet-5-5` and `gpt-6.1-sol`, the newest Opus, Sonnet and GPT models on October 14, 2026.
They use provider defaults: no extended thinking requested and OpenAI's default reasoning effort. No Fable, no older
generation and no gpt-5.4-mini run. No older bridge model is needed, because these three readers also ran the T0
baseline. Results are reported for each reader, and every reader whose brief-off arm is at 24 of 24 is named as a
ceiling.

## Scorer (frozen)

The primary scorer is `t0-score-v3` (`eval/runner/t0/score.ts`, `T0_SCORER_POSTHOC`). It holds the T0 failure definition
(missed commitment, stale date, stale correction, unsupported namesake value, execution error) with the audited
change-context and disambiguation rules. It was written after the T0 baseline and before any D6 data, and it is adopted
here as the primary because the T0 audit found that `t0-score-v2` counts disambiguations as `unsupported`. `t0-score-v2`
is reported as a secondary. A cell succeeds when the primary scorer does not fail it.

## Size (frozen)

6 personas × 4 tasks × 3 readers × 2 arms × 1 repeat = 144 cells, which is 72 pairs. Pairs are clustered by persona
(6 clusters).

## Primary measure and decision rule (frozen)

**Primary:** the paired difference in end-to-end task success, brief-on minus brief-off, over task × reader pairs and
pooled across the three readers. The 95% interval is persona-clustered (`riskDifference` in
`eval/runner/power/risk-ratio.ts`, t on 5 degrees of freedom), computed by `pairedSuccess` in `eval/runner/t0/brief.ts`.

**Development signal.** The run is labelled "improvement signal (development evidence only)" only when all of these hold,
and "no improvement signal (development evidence only)" otherwise:

1. the pooled paired success difference has a 95% lower bound above 0;
2. the paid-arm guard holds: no brief-off cell showed a brief (the run halts otherwise), and the brief failed to fire in
   at most 10% of brief-on cells;
3. attention: no session-2 brief block exceeds 1,800 characters;
4. false pushes: at most 0.05 false-push items per brief-on session;
5. no rise in confident-wrong: brief-on has no more confident-wrong cells than brief-off.

Checks 3 to 5 are the plan's exit bar (≤ 1,800 characters, false-push ≤ 5%, no confident-wrong rise). Uptake alone
never satisfies the rule.

**What each label allows.** "Improvement signal" means the design may go to the sealed phase unchanged, under its own
preregistration and custody. "No improvement signal" means the result is reported, and a sealed run of this design
needs a written redesign first. Neither label changes the release default.

## Diagnostics (frozen definitions, reported for each arm and reader)

- **Paid-arm guard.** A `brief-on` cell is `fired` when the UserPromptSubmit hook in session 2 carries a block that starts
  with `## Before you start`, and `miss` otherwise. A `brief-off` cell must show no such block in any hook of either
  session. If one does, the runner throws `BriefGuardError` and the run stops, because the arms would not be what they
  claim.
- **Brief characters.** The length of the session-2 brief block, from its header through its last item line. Reported as
  the maximum and as the mean over fired cells.
- **Item classes.** Each session-2 brief item is read from its quoted stored text. It **carries** a needed fact when it
  matches the gold matcher for the commitment, the new meeting date or the corrected value. It is **stale** when it
  asserts the old date or the pre-correction value outside a change context (v3 rules) and lacks that fact's current
  value. It is a **namesake** item when it matches a namesake value. It belongs to **another counterparty** when its slug
  is not the task's contact. An item is a **false push** when it is stale, a namesake item, about another counterparty,
  or carries no needed fact.
- **False pushes per session** (and per day: each cell's session 2 is one simulated day): false-push items divided by
  brief-on sessions. Sessions with at least one false push are also reported.
- **Uptake.** Over fired brief-on cells, the needed facts that relevant brief items carried, and the share of them that
  appear in the deliverable (scored by the primary scorer's hits). Uptake is diagnostic only. The paired brief-off cell's
  rate for the same facts is reported beside it, because hot memory carries the same facts in both arms.
- **Opportunity recall** over all tasks, each of which needs all three session-1 facts: the needed facts the brief
  carried, divided by 3 × cells. The same figure is reported for the whole injected context of session 2 (all hook
  text, hot memory included) in both arms. Tasks where the trigger did not fire count as misses.
- **Confident-wrong rate.** Cells whose deliverable the primary scorer fails for `stale_date`, `stale_correction` or
  `unsupported`.
- **Cost of the push.** Session-2 tool calls per task, session-2 input tokens per task, cell input tokens, and dollars per cell.
- **Capture.** Which of the three facts session 1's write calls carried, the same as T0 (not scored).

## Budget and stopping (frozen)

- A new budget ledger is capped at $45 for this phase (`bun eval/runner/budget-ledger.ts init --program-cap-usd 45`), so
  no earlier ledger's balance is used. The runner's preflight estimate uses the T0 baseline's measured mean cost per
  cell plus about 10%: Opus $0.42, Sonnet $0.17, gpt-6.1-sol $0.11, about $34 for 144 cells. The ledger enforces the
  real cap.
- Paid brief cells refuse to start without `--preregistration` naming this file committed and on `origin`, and the
  attestation goes into `experiment.json` and `receipt.json`.
- Harness errors (a cell that ends without a scored record) are logged in `harness-errors.jsonl`. The same command runs
  once more to fill missing cells, which resumes from `results.jsonl`. Cells still missing after that are reported as
  missing, and a pair with a missing side drops out of the primary. If the ledger cap stops the run, the analysis covers
  the complete pairs and the report says the run was truncated.
- No other stopping, peeking or re-running. The analysis runs once, after the last cell.

## What is reported

The development record (`docs/benchmarks/2026-10-14-proactive-brief-dev.md` and the run directory
`docs/benchmarks/2026-10-14-proactive-brief-dev/`) reports:

- the primary with its interval and discordant pairs, and the development label with each check;
- per-reader rows and ceilings, and prep and reply separately;
- every diagnostic above, with raw counts;
- spend from the ledger and the budget run ids;
- `t0-score-v2` as a secondary;
- a hermetic slice for the plumbing.

Machine-local paths are scrubbed from committed files.

## Amendments

None.
