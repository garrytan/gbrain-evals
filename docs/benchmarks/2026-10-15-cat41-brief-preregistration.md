# Preregistration: the proactive brief in native agent sessions, Cat 41 scenarios (wave 5 D7)

**Status: frozen.** The draft was committed on October 15, 2026 (Pacific) and reviewed the same day. Garry's
coordinating thread approved it, under the standing auto-approve rule, with four additions written in below. It was
frozen on October 15, 2026 (Pacific) by the commit that fills in [the freeze](#the-freeze). No paid D7 session ran
before that commit. After it, every change is an amendment, appended at the bottom with its reason and committed
before any session it governs.

D6 is closed: both development runs showed no gain, so the sealed seed is skipped and the brief stays off by default
([first run](2026-10-14-proactive-brief-dev.md); [v2](2026-10-15-proactive-brief-dev-v2.md), no time-saved signal).
Under the plan's wave 5 exit ("an improvement in end-to-end task success **or user time saved**"), D7 is the remaining
test that can show user time saved. It measures that time in real Claude Code and Codex sessions, through the hooks
that gbrain itself installs.

Code:

- `eval/runner/cat41/brief-scenarios.ts`: the scenarios, the cell setup and the probe.
- `eval/runner/cat41/brief-worlds.ts` and `brief-worlds.json`: the worlds, rendered from the program-primary generator.
- `eval/runner/cat41/brief-db.ts`: backdating and the brief replay timer, run inside the container.
- `eval/runner/cat41/brief-d7.ts`: the free smoke, the cell reader and the analysis `summarizeD7`.
- `eval/runner/cat41/in-container.ts`: arrival time per transcript line, the hook stdout copy, harness-wired cells and
  the smoke's fake harness provider.
- `eval/generators/program-primary-gen.ts`: `PP_D7_DEV_SEEDS`.

Tests: `test/eval/cat41-brief.test.ts`.

## The question

A user starts a native agent session to reply to an email, prepare for a meeting, or start on something they promised
a contact. What the agent needs was saved days earlier, or sits under newer, unrelated memories, so hot memory does
not carry it. Does gbrain's "Before you start" brief shorten the time to the agent's first correct output, without
lowering task success and within the attention, false-push and confident-wrong limits?

## What is known before any spend

1. **Hot memory carried the facts in D6 v1, not in v2.** v1's tasks were null because hot memory gave both arms the
   session-1 facts. v2 aged or crowded them out, and hot memory carried no needed fact in any of 144 cells. In v2 the
   brief cut session-2 tool calls by 6% and input tokens by 8%. Both arms finished 72 of 72.
2. **The brief carries two of a task's three facts.** Per counterparty it pushes the newest fact and the newest page
   edit or timeline entry. The [free smoke](#free-smoke-on-the-pinned-release) shows this here too: each positive
   scenario's brief held the commitment (a timeline item) and one of the corrected value or the new date (a fact item).
3. **The brief fires only on the UserPromptSubmit intent gate in these containers.** The prompt has to name a
   counterparty that gbrain resolves, and either match the reply or meeting lexicon or have a calendar meeting with
   that counterparty in the next 12 hours. The SessionStart calendar brief needs a freshly synced Google calendar,
   which a container does not have. So the SessionStart brief is out of scope, and every push here is a UserPromptSubmit
   push.
4. **Codex gets the same hooks on v0.60.247.0.** `gbrain setup codex` installs SessionStart and UserPromptSubmit read
   hooks. gbrain's capability table marks Codex push native-verified on codex-cli 0.162.1. In the free smoke, on
   the pinned image's codex-cli 0.160.0, both hooks fired and the brief reached the model's request in 3 of 3
   positive brief-on cells. So Codex is in.
5. **OpenClaw is unsupported.** On v0.60.247.0, `gbrain setup openclaw` refuses, and the capability table marks the
   thin-client route's push `unsupported`. D8b's route does not exist at this release. OpenClaw is recorded as
   unsupported and runs no session.
6. **Open loops cannot be pushed in this design.** gbrain creates open loops only from Google mail and calendar
   extraction, and writes them private. The push path is world-only, and it admits a loop only through a
   world-visible fact. So the start-of-task commitment is seeded as a world-visible timeline entry on the contact's
   page, which is how a user's agent records a promise in notes. The scenario tests the brief's timeline source. It
   does not test loops. The pull path (`context_pack` with `counterparty`) is available in every arm, and the `pull`
   arm measures it alone.
7. **The intermittent smoke miss has a likely mechanism.** gbrain drops a brief that is not ready when the turn is
   300 ms old (`TURN_BRIEF_CUTOFF_MS`), and the legacy turn context is assembled first. In the free smoke's replay, the
   first (cold) `turn_context` call on a fresh brain took 169 to 339 ms. It dropped the brief in 3 of 9 positive
   brief-on cells. Warm calls took 74 ms at the median and never dropped it. One live Codex cell delivered a partial
   brief (one item of two) when its hook took 918 ms. A rerun of the same cell delivered both. D7 logs this for every
   cell (see [Latency](#latency-diagnostic)).

**Prediction.** We expect a time ratio near 0.9, short of the 0.80 bar, because of item 2 and v2's small savings.
The brief saves a search for two facts, but agents still open the contact's page. The design keeps 15 pairs with no
repeats. Repeats would narrow the interval, but they cannot move a true ratio near 0.9 under 0.80.

## Worlds and scenarios (frozen at the freeze)

There are two new development worlds from the program-primary generator: `PP_D7_DEV_SEEDS` = 20261222 and 20261226.
They are the first two seeds from 20261221 that render, pass the solvability check, and put every moved meeting on or
after 2026-10-22, so no meeting passes during the run. No earlier run used them. Neither is a sealed seed: their
commitments differ from every published sealed commitment.

Each cell's brain holds:

- The world's notes, imported keyless (no embeddings; gbrain setup's default).
- What the user said after each of the four calls, saved as the dominant v2 save path records it. The corrected value
  and the moved date are `remember` facts on the contact (provenance "user said in chat (call notes)", content origin
  `user_said`). The commitment is a timeline entry on the contact's page.

The four scenarios per world:

| Scenario | Contact | Prompt | Needed values |
|---|---|---|---|
| `reply` | first reply task | T0's session-2 reply prompt ("X just emailed me … Draft my reply …") | commitment, new date, corrected value |
| `prep` | first prep task | T0's session-2 prep prompt ("Prep me for my next meeting with X …") | commitment, new date, corrected value |
| `task_start` | second reply task | "Help me get started on my follow-up for X: work out what I owe them and by when, then write the short cover email I'll send with it." | commitment, new date |
| `negative` | the namesake of the second prep task's contact | "Y just emailed me: "Hi …, quick check-in: anything new on your side since we last spoke?" Draft my reply." | none: the brief should stay silent, and the reply must not use the other contact's values |

`task_start` is **lexicon-dependent**. Its wording includes "follow-up", which is in the reply lexicon, so the
scenario exercises the same gate as `reply`. The free smoke replayed the same request without that word ("Help me get
started on what I owe X …"), and the brief stayed silent in 8 of 8 cells. A commitment-start prompt outside the
lexicon therefore gets no push at this release. The report labels `task_start` lexicon-dependent wherever it appears,
and reports the gap as a product finding (see [Product findings](#product-findings-reported-whatever-the-result)).

**Conditions.** World 20261222 ages `reply` and `task_start` and crowds `prep` and `negative`. World 20261226 swaps
them.

- **Aged:** every saved fact, timeline entry and page revision is dated 72 hours before the cell.
- **Crowded:** the items are saved at setup, and then 40 newer facts about other people are saved: v2's `crowdFacts`,
  which skips the contact and anyone sharing the contact's first name.

## Harnesses and arms (frozen at the freeze)

Each cell is one native session in a fresh Cat 41 container: image `gbrain-evals-cat41:v1`, Claude Code 2.1.285,
codex-cli 0.160.0, Bun 1.4.2. Before the session, gbrain wires the harness itself:
`gbrain setup <claude-code|codex> --gbrain-bin /usr/local/bin/gbrain --no-capture --no-providers`. So the hooks and the
MCP registration are gbrain's own. The driver keeps that config and adds only the API key helper.

| Arm | Wiring | Brief switch | Harnesses |
|---|---|---|---|
| `off` | gbrain setup with its read hooks (SessionStart, UserPromptSubmit) | `context.proactive_brief` unset | Claude Code, Codex |
| `on` | the same | `context.proactive_brief = true` | Claude Code, Codex |
| `pull` | gbrain setup `--no-hooks`, MCP only | unset (the pull brief does not read it) | Claude Code |

**Models.** These are the newest frontier model of each family, each in its native harness: Sonnet 5.5
(`claude-sonnet-5-5`) and Opus 5.5 (`claude-opus-5-5`) in Claude Code, and gpt-6.1-sol in Codex. Sonnet is reported
first. No Fable runs in any counted cell. Each runs at its harness's default settings.

## Sessions (frozen at the freeze)

There are 48 sessions, one per cell, with no repeats:

- 32 Claude Code hooks sessions: 4 scenarios × 2 worlds × 2 arms × Sonnet and Opus.
- 8 Codex sessions: 4 scenarios × world 20261222 × 2 arms × gpt-6.1-sol.
- 8 Claude Code pull sessions: 4 scenarios × 2 worlds × Sonnet.

A **pair** is the off and on cells for the same scenario, world, harness and model. The primary pools the 15 positive
pairs: 3 scenarios × (2 worlds × 2 Claude models + 1 world × Codex). The 5 negative pairs feed the false-push and
confident-wrong checks. The pull cells pair with Sonnet's `off` cells, as a descriptive comparison only.

A cell whose harness crashes (no final text, or a harness error) is retried up to twice, as in Cat 41. If it still
crashes, it is reported as not scored, and its pair leaves the primary.

## Primary measure and decision rule (frozen at the freeze)

**Time to the first correct action.** This is the time from the harness process's start to the arrival of the first
assistant output that makes the session's output so far correct. Each transcript line is timestamped on arrival.
Outputs are assistant text and the input of a file-writing tool (`Write`, `Edit`, `MultiEdit`, `Bash`; Codex agent
messages and commands).

- `reply` and `prep` count as correct when the T0 scorer (`t0-score-v3`) finds no failure and every needed value.
- `task_start` counts as correct when the commitment and the new date are stated with no failure.

A session that never gets there is counted at its full session time (censored).

**The product as shipped.** The primary scores every `on` cell as it ran. A brief that gbrain dropped or cut short
at its 300 ms turn deadline still counts against the brief.

**Part 1, time saved (`pairedRatio`).** The pooled ratio of time to the first correct action, brief-on total over
brief-off total, across the 15 positive pairs. Its 95% interval uses the delta method on the log ratio, with each pair
as its own cluster. Time is saved when the ratio is **≤ 0.80 and the upper bound is < 1**. This is the same effect size
as D6 v2's.

**Part 2, success non-inferiority (`pairedSuccess`).** End-to-end task success is judged on the final answer:

- `reply` and `prep`: no `t0-score-v3` failure.
- `task_start`: no failure, and the commitment and new date are stated.

The paired difference across the 15 positive pairs must have a 95% lower bound **≥ −5 points**.

**The checks.** The run is labelled "time saved in native sessions (development evidence)" only when all seven hold:

1. Part 1.
2. Part 2.
3. The hot-memory control holds: in each condition, at most 10% of positive cells have a needed value in hot memory.
4. No brief appears in any `off` or `pull` cell.
5. Every brief block is at most 1,800 characters.
6. False pushes are at most 0.05 per `on` session. Every item in a `negative` cell is a false push. In a positive cell,
   an item is a false push when it is stale, carries the namesake's values, is about another counterparty, or carries
   no needed value.
7. Confident-wrong cells in `on` are no more than in `off`.

If check 3 or 4 fails, the label is "inconclusive". Otherwise it is "no time-saved signal (development evidence only)".

**Delivered-only analysis (diagnostic only).** The report repeats Part 1 and Part 2 over the positive pairs whose
`on` cell got the full brief. A full brief means the live UserPromptSubmit brief had at least one item and no fewer
items than the uncut brief replayed on the same brain. This slice shows what a deadline-proof brief would do. It is
not a check and never changes the label.

**What a label allows.** Neither label flips the default by itself. "Time saved" puts a default-on proposal in front
of Garry, with this run as its evidence. "No time-saved signal" closes wave 5's brief work at default-off.

## Diagnostics (frozen definitions; per arm, scenario, condition, harness and model)

- **Surfaced:** the brief carried at least one needed value.
- **Acted on:** a pushed value appears in the final answer.
- **Repeated a stale item:** the final answer asserts a stale date or a stale value (`stale_date`, `stale_correction`).
  Pushed stale items are counted separately.
- **Confident-wrong:** a stale assertion, a namesake value, or, in `negative`, the other contact's values.
- Brief firing per scenario, items and characters. Whether the brief text reached the model is visible only in the
  smoke's captured requests.
- **Work to the first correct output:** model turns and tool calls up to that output (the session's totals when
  censored), as paired ratios beside the primary.
- **Provider latency:** for each model request, the wait from what the model was waiting on (the session's start or
  the previous tool result) to the first line of its reply, taken from line arrival times. That is provider latency
  plus generation. The report gives the paired ratio of total model wait, the median and maximum per request in each
  arm, and Claude Code's own API time. It uses these to say whether the primary's wall-clock ratio moved with the
  agent's work (turns and tool calls) or with API jitter.
- Session tool calls, input tokens, session time and cost, per arm.
- The pull arm: whether agents called `context_pack` with `counterparty`, and time and success against Sonnet's `off`
  cells.

### Latency diagnostic

For every hooked cell, the driver records each `gbrain hook` call's wall time (the wrapper's start and end) and its
stdout. After the session, `brief-db.ts replay` times the scenario prompt on the same brain five times, cold first:

- the full `turn_context` assembly with its 300 ms brief cutoff;
- the brief alone, with no cutoff.

The report gives the hook wall times and the cold and warm replay times. It counts cells where the live brief had fewer
items than the uncut brief (dropped or partial), and cold replays that dropped the brief. This bears on the smoke miss
and is not a check.

## Product findings (reported whatever the result)

The report states these two findings from the free smoke, with the paid run's latency data beside them, whatever the
verdict:

1. **The task-start intent gap.** A request to start on what the user owes a named contact gets no brief unless it
   uses a lexicon word. Without "follow-up", the brief fired 0 of 8 times.
2. **Cold-hook latency drops.** On a fresh brain, the first `turn_context` replay took 169 to 339 ms and dropped the
   brief in 3 of 9 positive cells. One live Codex hook took 918 ms and delivered one of the brief's two items.

## Free smoke on the pinned release

On October 15 the smoke ran every D7 cell and harness once: 24 Claude Code cells and 8 Codex cells, $0. The harness's
own model calls went to the container's fake provider with fake keys, which kept each request's body
(`bun eval/runner/cat41/brief-d7.ts smoke`). The record will be committed with the results.

- Setup succeeded in 32 of 32 cells. `gbrain setup` reported `configured`, `connection-verified` and `native-pending`.
- Both hooks fired in every hooked cell. UserPromptSubmit took 148 to 741 ms of wall time (median 226 ms), and
  SessionStart took 116 to 1,402 ms.
- The brief fired in 9 of 9 positive `on` cells and reached the model's request in all 9. It was silent in both
  harnesses' `negative` `on` cells, and in every `off` and `pull` cell.
- Hot memory carried no needed value in any cell, and neither did the rest of the injected context.
- Each brief had 2 items (482 to 509 characters), with 0 false pushes.
- The replay is summarized in item 7 above.

## Budget and stopping (frozen at the freeze)

A new ledger, `.budget/cat41-brief-d7.sqlite`, is capped at **$30**. That is the lower of $30 and the plan's D7
envelope ($15 to $30). Run order: Codex, then Sonnet, then Opus. Pairs run back to back, and the pull cells run last.
If committed spend passes $20 before the Opus pass starts, the Opus pass stops at the cap. Its unrun pairs are
reported, and nothing beyond $30 runs without approval.

**Estimate.** Cat 41's recorded sessions cost about $0.43 per Opus run and $0.53 per Codex run, so an agent session
here is expected to cost:

- Opus: about $0.70, × 16 = $11.20
- Sonnet: about $0.40, × 24 = $9.60
- gpt-6.1-sol: about $0.50, × 8 = $4.00

That is about $25 in all, against the $30 cap. The runner's planning estimate is $21.60.

## What is reported

The verdict and all seven checks, with Sonnet reported first. The report gives:

- the pooled time ratio and success difference with intervals, and each by scenario, model, condition and harness;
- the time in seconds per arm;
- the negative cells, the pull comparison, the control and the diagnostics;
- the latency diagnostic;
- spend.

A reader at the ceiling in both arms is called out. Records go under
`docs/benchmarks/2026-10-15-cat41-brief/`, with machine paths scrubbed. The analysis command is
`bun eval/runner/cat41/brief-d7.ts summarize --out <file> <pass dirs>`.

## The freeze

- **Release under test:** gbrain v0.60.247.0, commit `47f052af0c7f92f259daa9b1b51bb90370dcf520` (tag `v0.60.247.0`),
  pinned in `D7_RELEASE` (`eval/runner/cat41/brief-scenarios.ts`). `cat41-agent-operator.ts run` refuses paid D7
  sessions on any other commit or without `--preregistration`.
- **Pins:** image `gbrain-evals-cat41:v1` (Claude Code 2.1.285, codex-cli 0.160.0, Bun 1.4.2, Node 24.18.0).
- **Models:** `claude-sonnet-5-5` and `claude-opus-5-5` in Claude Code; `gpt-6.1-sol` in Codex.
- **Worlds:** `brief-worlds.json` as committed with this freeze (`d7-worlds-v1`, seeds 20261222 and 20261226).
- **Analysis:** `summarizeD7` (`d7-summary-v1`) as committed with this freeze.
- No paid D7 session ran before this commit. The free smoke used the container's fake provider, with fake keys.

## Amendments

**Amendment 1 (October 15, 2026, before any paid session).** The driver now deletes the previous run's hook-output
files in sorted order (`readdirSync(...).sort()` in `in-container.ts`), as the repository's readdir-determinism test
requires. This changes nothing about what a session sees or how it is scored.

**Amendment 2 (October 15, 2026, after the paid sessions; diagnostics only).** Two diagnostic counts in
`summarizeD7` did not match their definitions above, and are corrected. Neither feeds a check or the label.

1. The cold-replay drop count included `off` and `pull` cells. In those cells the brief switch is off, so
   `turn_context` never carries a brief. It now counts `on` cells only, as [Latency](#latency-diagnostic) defines.
2. The pull field counted hook calls. It now counts `context_pack` calls that name a `counterparty`, as the pull-arm
   diagnostic defines. It also reports, for every arm, how many cells made such a call.

Rerunning the analysis with these fixes leaves every check and the label unchanged.

