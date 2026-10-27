# Preregistration: the proactive brief on Cat 40 family P, development phase v2 (wave 5 D6 redesign)

**Status: frozen.** The draft was committed on October 15, 2026 (Pacific). It was frozen on October 15, 2026 (Pacific) by the commit that
pins [the release under test](#the-release-under-test) here and in `BRIEF_V2_RELEASE` (`eval/runner/t0/brief.ts`):
gbrain v0.60.247.0, the first published release with the brief's page-edit source. No paid cell ran before that
commit. After it, every change is an amendment, appended at the bottom with its reason and committed before any cell
it governs.

This is a redesign written after seeing the results of the
[first development run](2026-10-14-proactive-brief-dev.md) (preregistration `6aa12098`). Garry approved it on October
15, 2026. That run's verdict stands: no improvement signal (both arms finished 70 of 72 paired tasks). Its result was
null because hot memory delivered the session-1 facts to both arms and the brief only pushed one of them again. This
design builds tasks where hot memory does not carry the needed fact.

It is still development evidence only. It does not decide whether the brief ships on by default. Under the plan's
wave 5 exit rule, only D6's sealed verdict can make that decision. The sealed seed stays out of scope: nothing here
mints, generates or reads sealed material.

Code: `eval/runner/t0-program-primary.ts` (the T0 carrier with the brief arms and the v2 conditions),
`eval/runner/t0/brief.ts` (conditions, crowd facts, hot-memory control, save path, analysis `summarizeBriefV2`),
`eval/runner/cat40/gbrain-arm.ts` (`GbrainSlot.backdateFactsSince`), and `eval/generators/program-primary-gen.ts`
(`PP_BRIEF_V2_DEV_SEEDS`, `PP_BRIEF_V2_SESSION2_DAY`). Tests: `test/eval/t0-brief.test.ts`.

## The question

The facts the task needs no longer reach the agent through hot memory, because they are too old or crowded out by
newer facts. In that situation, does gbrain's "Before you start" brief save the agent work on meeting-prep and reply
tasks, measured as fewer tool calls and fewer input tokens, without lowering task success?

The plan's wave 5 exit allows either measure: "an improvement in end-to-end task success **or user time saved**". The
first run measured success and found the expected ceiling. Finding 4 below predicts the same here, so this design
makes time saved the primary, with non-inferiority on success. This change was made in the draft before any v2 data
existed, and was approved on October 15, 2026 under the standing rule.

## What is known before any spend

These findings come from hermetic runs on October 15 ($0, scripted models, keyless brains) against gbrain v0.60.240.0
(`1355f32f`), the release the first run used. They shape the design, so they are frozen here.

1. **How hot memory chooses facts.** The UserPromptSubmit and SessionStart "Hot memory (recent facts)" block reads
   facts whose `created_at` is within the last 24 hours. It fetches the 30 newest and shows the top 10 after
   collapsing duplicates (`src/core/facts/meta-hook.ts`, `listFactsSince`). gbrain reads `Date.now()` and has no clock
   parameter, so the harness simulates elapsed time by moving timestamps.
2. **The aged condition removes the facts from hot memory.** After session 1, the harness backdated the facts session
   1 created to at least 72 hours before the cell. Hot memory then carried none of the three needed facts in 4 of 4
   aged cells. The brief still fired in 2 of 2 brief-on aged cells, because the brief has no time window. It carried
   the newest fact about the contact.
3. **The crowded condition pushes the facts out of hot memory.** After session 1, the harness saved 40 newer facts
   about other people through `remember`. Hot memory then carried none of the needed facts in 4 of 4 crowded cells,
   and a separate probe showed it filled with 10 of the newer facts. The brief fired in 2 of 2 brief-on crowded cells.
4. **The facts stay on the contact's page.** `remember` writes each fact into the entity page's `## Facts` fence
   (checked: after one `remember`, `get_page` on the contact returns the fact). The UserPromptSubmit hook names the
   contact's page in both arms ("Brain pages mentioned this turn"). So a reader that opens that page sees every saved
   fact whatever the brief switch says, and a reader that edited the page in session 1 left the facts there too. The
   brief can only change the outcome for a reader that does not open the page. It can also save the tool calls and
   tokens needed to find the facts.
5. **What the brief carries.** In v0.60.240.0, per counterparty, the brief carries the top open loop, then the newest
   fact, then more loops, with at most 3 items. Without loops it carries one fact, while each task needs three facts
   (the commitment, the moved date and the correction). v0.60.247.0 adds an edit item after the newest fact. That item
   is either the page's newest revision (`Ev<version id>`: the narrative lines it added, without the facts and takes
   sections) or its newest timeline entry (`Et<id>`), whichever was recorded last, within 30 days. It is dropped when
   it repeats a fact or loop already in the brief.
6. **Loops are out of scope.** Commitments that the mail extractor finds are written as private facts by design
   (`src/core/google/loops-extract.ts`, `visibility: 'private'`). The push brief is world-only: it admits a loop only
   through a world-visible fact, and detector loops have no fact at all. So a loop from a mail or calendar fixture
   cannot reach a pushed brief in this release, and this design has no loop condition. A loop condition would need
   its own preregistration on a release where such a loop can be pushed.
7. **Save path.** In the first run, all 14 brief-on misses were Sonnet 5.5 sessions that saved by editing pages and
   never called `remember`, which left the brief no fact to push. v0.60.247.0 adds the page-edit source to the brief.

**Prediction.** Finding 4 still makes a small or null difference in task success likely. Readers that open the
contact's page, or search, find the facts in both arms. In the first run, 143 of 144 session-2 cells called `get_page`,
`search`, `recall`, `entity` or `get_chunks`. The open question is whether reading one needed fact in the prompt makes
readers search less. In the first run, where hot memory carried the facts in both arms, session-2 tool calls were
6.10 per task with the brief off and 5.94 with it on, about 3% fewer. That is well short of the 20% this design
requires. A time-saved signal therefore needs a much larger effect once hot memory no longer carries the facts.

## Workload (frozen)

- Generator `program-primary-v1`, unchanged: one brain of 73 pages and 4 tasks per persona, with the same two
  sessions as the first run. In session 1 the user reports a call (a commitment, a moved meeting and a correction) and
  asks the agent to update the brain. Session 2 asks for meeting prep or a reply that names none of the three facts.
- **New development seeds:** 20261211, 20261213, 20261214, 20261215, 20261216, 20261217 (`PP_BRIEF_V2_DEV_SEEDS`).
  These are the first six seeds from 20261211 that render, pass the solvability check, and put every moved meeting on
  or after October 19, two days after session 2. No earlier run used them. That gives 24 tasks: 12 prep and 12 reply.
- **Session days:** session 1 is on October 14 in the world, and session 2 on October 17 (`PP_BRIEF_V2_SESSION2_DAY`).
- **Conditions,** assigned by task. Each persona's first reply task and first prep task are **aged**; its other two
  tasks are **crowded** (`briefCondition`). That gives 12 aged and 12 crowded tasks, with 6 prep and 6 reply in each.
  - **Aged:** after session 1 the server stops. Every fact created since the cell's restore gets its `created_at` set,
    and its `valid_from` when that is newer, to noon Pacific on October 14, or to 72 hours before the cell if that is
    earlier (`agedFactsAt`). This happens in one statement with triggers off, because gbrain's managed-writer trigger
    refuses operator writes to `facts` (`GbrainSlot.backdateFactsSince`). Page writes are untouched. Then session 2
    starts in a new server process.
  - **Crowded:** after session 1 the harness saves 40 facts (`CROWD_FACTS`) through the server's own `remember`
    tool, with provenance "user, a later session" and `content_origin: user_said`. Each fact is about a person in
    the persona's brain other than the task's contact and anyone sharing the contact's first name (the namesake). The
    facts contain no number or date and match none of the task's gold values (`crowdFacts`, tested). Then session 2
    starts in a new server process.

## The release under test

- gbrain v0.60.247.0, commit `47f052af0c7f92f259daa9b1b51bb90370dcf520` (gbrain #6751, the brief's page-edit source). It is built through
  `eval/runner/lifecycle/builds.ts` with tree and CLI-version verification, surface `starter`. Paid v2 cells refuse to
  run on any other commit.
- The page-edit source has no switch of its own. It is part of the brief behind `context.proactive_brief`, which is
  off by default, so `BRIEF_V2_EXTRA_CONFIG` stays empty and brief-on sets only `context.proactive_brief`.
- Before any paid cell, a free smoke (scripted, keyless) runs on this release, and the hermetic slice (one persona,
  both arms) reruns on it. Their record goes into the results directory, added after the freezing commit. The smoke
  must show four things for every task of one persona, under both save paths: hot memory carries no needed fact in
  either condition, the brief fires in brief-on cells, it stays silent in brief-off cells, and it emits an edit item
  when session 1 saved by editing the page.

## Arms (frozen)

| Arm | What differs |
|---|---|
| `brief-off` | Nothing is set: the release default, with the brief (and its page-edit source) off. |
| `brief-on` | After every snapshot restore and before session 1, `context.proactive_brief` is set to `true`. In this release that also turns on the page-edit source. It stays on through session 2. |

Everything else is the T0 carrier, unchanged from the first run: the snapshot, the native-event delivery contract
`t0-delivery-v1`, the stdio MCP tools, 20 turns per session and the system prompt. Every task runs once in each arm
for each reader (paired), with 1 repeat.

## Readers and settings (frozen)

`claude-opus-5-5`, `claude-sonnet-5-5` and `gpt-6.1-sol`, the newest Opus, Sonnet and GPT models, with provider
defaults. If a newer model in any of these families exists on the day of the freezing commit, the commit names it and
says why. No Fable, no older generation and no gpt-5.4-mini run. Results are reported for each reader, and every
reader whose brief-off arm is at 24 of 24 is named as a ceiling.

## Scorer (frozen)

The primary scorer is `t0-score-v3`, the same as the first run, and `t0-score-v2` is reported as a secondary. A cell
succeeds when the primary scorer does not fail it.

## Size (frozen)

6 personas × 4 tasks × 3 readers × 2 arms × 1 repeat = 144 cells. That is 72 pairs: 36 aged and 36 crowded, clustered
by persona (6 clusters).

## Primary measure and decision rule (frozen)

The primary has two parts. Both are computed over the task × reader pairs of both conditions (72 pairs), paired by
task and reader, reported for each reader, then pooled across the three readers, with persona-clustered 95% intervals
(6 clusters, t on 5 degrees of freedom). Each condition is also reported separately, and neither is a co-primary.

**Part 1, time saved (`pairedRatio`).** This is the ratio of session-2 tool calls, brief-on total over brief-off total,
across the pairs. The interval comes from the delta method on the log ratio (`ratioInterval`, method `delta-t`, in
`eval/runner/power/risk-ratio.ts`). The same ratio is computed for session-2 input tokens. Tool calls are the primary
efficiency measure because the plan names "tool calls and input tokens per task" as D6's measures. The plan's "time to
the first correct action" belongs to D7, and a T0 session has one deliverable at its end rather than timestamped
actions marked correct. Session-2 wall time from the first hook to the deliverable is reported as a diagnostic only:
it includes provider latency, which varies with the hour the cell runs.

**Part 2, non-inferiority on success (`pairedSuccess`).** This is the paired difference in end-to-end task success,
brief-on minus brief-off, under `t0-score-v3`.

**Development signal.** The run is labelled "time-saved signal (development evidence only)" only when all seven
checks hold, and "no time-saved signal (development evidence only)" otherwise (`summarizeBriefV2`):

1. **time saved:** the pooled session-2 tool-call ratio is at most 0.80 (at least 20% fewer tool calls with the brief
   on), its 95% upper bound is below 1, and the pooled session-2 input-token ratio's 95% upper bound is also below 1.
   Brief-on adds its block to the prompt, so fewer calls have to mean fewer tokens overall;
2. **success is non-inferior:** the pooled paired success difference has a 95% lower bound at or above −5 points;
3. **the hot-memory control holds:** in each condition, at most 10% of cells (both arms) carry any needed fact in
   session 2's hot-memory lines. If more do, the condition did not remove the fact from hot memory and the run cannot
   answer the question;
4. **the paid-arm guard holds:** no brief-off cell shows a brief (the run halts otherwise), and among brief-on cells
   whose session 1 saved anything (`remember` or a page write), the brief fails to fire in at most 10%. Brief-on cells
   whose session 1 saved nothing are reported separately, because the brain then holds nothing to push;
5. attention: no session-2 brief block exceeds 1,800 characters;
6. false pushes: at most 0.05 false-push items per brief-on session;
7. no rise in confident-wrong: brief-on has no more confident-wrong cells than brief-off.

Checks 5 to 7 are the plan's exit bar. The per-reader rows are reported for every reader, but they are not separate
gates. Uptake alone never satisfies the rule. A pooled success difference whose 95% lower bound is above 0 is reported
as a success improvement. It is a secondary finding and does not replace check 1.

**What each label allows.** "Time-saved signal" means the design may go to the sealed phase unchanged, under its own
preregistration and custody. "No time-saved signal" means the result is reported, and whether D6 continues is
Garry's decision. Neither label changes the release default.

## Diagnostics (frozen definitions; for each arm, condition and reader)

- Everything the first run reported, with the same definitions: the guard, brief characters, item classes, false
  pushes per session and per day, uptake with the paired brief-off rate for the same facts, opportunity recall of the
  brief and of all injected context, the confident-wrong rate, session-2 tool calls and input tokens per task, cell
  input tokens, dollars per cell, and capture.
- **The hot-memory control:** for each cell, which needed facts (by gold matcher) appear in session 2's hot-memory
  lines, across all hooks. Counts are given per condition and separately for brief-off cells.
- **Save path:** session 1's save path, which is `remember` if any `remember` call was made, else `page` if a
  `put_page` or `edit_page` call was made, else `none`. The brief's firing rate is reported for each save path.
- **Efficiency per condition and reader:** the tool-call, input-token and wall-time ratios with their intervals, plus
  each arm's means.
- **Setup records:** for each cell, the backdated fact ids and their timestamp (aged), or the count of crowd facts
  saved and refused (crowded).

## Budget and stopping (frozen)

- A new budget ledger is capped at $35 for this phase, so no earlier ledger's balance is used. The preflight estimate
  is the first run's measured mean cost per cell plus about 10%: Opus $0.34, Sonnet $0.18, gpt-6.1-sol $0.10, about
  $30 for 144 cells. The ledger enforces the real cap.
- Paid cells refuse to start without `--preregistration` naming this file committed and on `origin`. They also refuse
  until `BRIEF_V2_RELEASE` is pinned, and on any build other than the pinned commit.
- Harness errors follow the same rules as the first run. The same command runs once more to fill missing cells.
  Pairs with a missing side drop out of the primary. If the cap stops the run, the analysis covers the complete pairs
  and the report says it was truncated. There is no other stopping, peeking or re-running, and the analysis runs once
  after the last cell.

## What is reported

The development record (`docs/benchmarks/2026-10-15-proactive-brief-dev-v2.md` and the run directory
`docs/benchmarks/2026-10-15-proactive-brief-dev-v2/`) reports:

- both parts of the primary with their intervals, the success discordant pairs, and the label with each check;
- each condition, each reader with ceilings, and prep and reply separately;
- the hot-memory control and firing by save path;
- every diagnostic, with raw counts;
- spend from the ledger with the budget run id;
- `t0-score-v2` as a secondary;
- the hermetic slice on the pinned release.

Machine-local paths are scrubbed from committed files.

## Amendments

None.
