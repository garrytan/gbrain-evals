# Weekly held-out line preregistration: does gbrain's newest release beat a grep agent and the leading memory servers on questions nobody tuned for?

Written 2026-11-23 for GBEV-3 (issue GST-3602), after a lean `/autoplan --kind feature` review (run
`autoplan-mtcarx-20261123144832`, one claude-opus-5-5 reviewer, 21 findings) whose gate Garry Tan answered "Do it" on
2026-11-23, taking every recommendation. This file freezes the plan for a standing weekly line. No world has been minted
and no cell has run. It is frozen by the commit that adds it, pushed before any paid call. Every later change is a dated
amendment under "Amendments", written before the weeks it governs. The harness lands in its own pull requests before the
pilot (see "Harness"), and launch amendment A, written after the pilot and before the first counted week, names the
harness commit, the world length, the block size and the seed commitment.

The line reuses the method of the [changing-facts confirmation (BG1-C)](2026-11-19-changing-facts-confirmation-preregistration.md)
and, through it, the [changing-facts battleground (BG1)](2026-11-09-changing-facts-battleground-preregistration.md): the
generator, the custody program, the judges, the per-world statistic and the missing-data rules. Where this file is silent,
BG1-C's preregistration governs.

## The question

Every week, on 8 newly minted sealed worlds that nobody developing a memory system has seen, and every four weeks on the
32 worlds of a block: does gbrain's newest release, reading 8,000 tokens of memory, answer questions about changing facts
more accurately than

1. **a grep agent**: a model given the chats as dated Markdown files and three tools (list a folder, ripgrep, read a
   file) for up to 40 turns, the simplest whole system a developer would build instead of installing a memory layer; and
2. **the two memory servers BG1-C compared**, the extract-first server and the memory-bank server,

in each of two classes: **what is true now** (S1 to S5, 40 questions a world) and **questions about the past** (S6 to S8,
24 questions a world)? The readers are claude-opus-5-5 and particle-1. A loss is reported the same way as a win.

## What each outcome changes (R97)

Each block gives each comparison one word from the verdict rules below: **ahead**, **behind**, **level within 3 points**,
**split by reader** or **no measurable difference**. The family 1 comparisons (the grep agent) are the headline.

| Block result | What gbrain's maintainers do | What the line's page says |
|---|---|---|
| gbrain **behind the grep agent** on either class | Matching the grep agent on that class becomes the first item on gbrain's improvement list, ahead of new features, with the block's per-kind rows and exposure (did the values the answer needs reach the reader) naming retrieval or reading as the cause. No gbrain release note claims better recall than search on that class until a later block reads level or ahead. A second behind block in a row on the same class starts one "Why null?" cycle on gbrain's retrieval, ending in keep, fix the method or a cut candidate, and a cut candidate goes to the project owner in plain words. One fix to test first is giving gbrain's own tool surface grep and read tools over the Markdown it already stores | "gbrain (releases <builds>) is behind a grep agent on <class> by <x> points (<interval>)" |
| gbrain **level with the grep agent** on a class | Direction stays. The page shows cost per correct answer beside accuracy, because a tie leaves cost and structure as gbrain's case. Kinds where the grep agent leads become issues for gbrain's maintainers | "level with a grep agent within 3 points on <class>", with cost per correct answer |
| gbrain **ahead of the grep agent** on a class | Direction stays | "gbrain (releases <builds>) beats a grep agent on held-out <class> questions by <x> points (<interval>)" |
| gbrain **behind a server** on a class | That class's per-kind rows and exposure go to gbrain's maintainers as issues, as BG1-C's did | "behind <server> on <class> by <x> points" |
| gbrain **ahead of or level with a server** | The block's row is published | as measured. "The leading competitor" in any summary is whichever server led gbrain in that block, never one picked in advance |
| **split by reader** or **no measurable difference** | Nothing changes on that comparison; the block's per-reader rows are published | the per-reader rows and "no measurable difference at this sample size" |
| A weekly point outside the previous block's 95% interval by more than the weekly smallest detectable difference | An advisory issue to gbrain's maintainers with the release range since the last point and the flag's simulated false-alarm rate. It holds no release | a flag line on the line's page |

A block's word belongs to the set of gbrain releases its counted worlds ran on, and every claim names that set. A claim
names one release only when every counted world in the block ran on it.

Per-kind rows and exposure go to gbrain's maintainers once per block, never weekly, so they cannot steer by the live set
week to week.

## Public lesson

Whether a memory layer beats the cheapest alternative a developer has, letting the model grep their files, on facts that
change, measured on data that nobody could tune for, every week. If it doesn't, that is the lesson, stated plainly, with
the class and size of the gap.

## Why we are asking, and why the answer is not known

- On BEAM-10M, gbrain's whole system was 12.2 points behind the file agent (the same grep agent) at v0.60.748.0
  ([BEAM-10M at newest](2026-11-19-beam10m-newest/results/README.md)), on 10 conversations and 199 questions. BEAM's histories are long
  single-user conversations without planned changing facts.
- On BG1-C's 40 sealed worlds, gbrain v0.60.753.0 was ahead of the memory-bank server on what is true now (+1.2, +0.2 to
  +2.2), level with the extract-first server (+0.6), and behind both on questions about the past (-4.5 and -3.0)
  ([results](2026-11-19-changing-facts-confirmation-results.md)). No grep agent ran on BG1 worlds.
- Read by claude-opus-5-5 on BG1's public development worlds, gbrain led the memory-bank and extract-first servers on
  current values by +3.4 and +1.9 points. On BG1-C's sealed worlds, Opus's own rows read +0.6 and -1.9: one lead shrank
  and the other reversed. The sealed run also differed in its worlds (a new seed and phrasing set) and its gbrain build.
  A development number can't stand in for a held-out one, so the line is held out every week.
- A BG1 world is about 200,000 tokens, which fits in a frontier model's window. A grep agent may answer nearly every
  question; the ceiling rules below say what happens then.

## The worlds

- **Generator.** `changing-facts-gen@1` (`eval/generators/changing-facts-gen.ts`) with BG1's Amendment 4 sealed fixes:
  140 to 160 dated sessions over about 18 months, 64 questions in eight kinds of eight (S1 updated, S2 corrected, S3
  repeated stale, S4 conflicting, S5 withdrawn, S6 as of, S7 as known, S8 history), gold from the plan's oracles over its
  events, never from rendered text. Rendered by gemini-3.8-flash through the custody renderer
  (`eval/custody/bg1/render.ts`) and kept only when `eval/custody/bg1/validate.ts` passes it (deterministic checks, the
  Gemini claim check and the claude-haiku-5-5 second validator).
- **A set of its own.** The line's worlds are set W on slots 1001 and up (ids `bgw-1001` onward), apart from BG1 (slots 1
  to 30) and BG1-C (slots 31 to 96). Each world is counted in exactly one week and never again.
- **A new seed and a new phrasing set.** The line does not reuse BG1's seed or private phrasing. Its first quarter uses a
  new seed line and a new private phrasing set, W1, written in custody. Every quarter after that gets a new seed line and
  phrasing set on a new slot range. Launch amendment A publishes the SHA-256 of
  `gbrain-evals weekly-line seed commitment v1|<seed line>|nonce=<32 random bytes, hex>` and of the phrasing file for W1;
  each rotation amendment does the same for its set. The aggregates name the seed and phrasing ids of every world.
- **Rotation as confirmation.** The first block of a new quarter is fresh in seed and in phrasing, so it also confirms
  the previous quarter's verdicts. A retired set's worlds may then be published as public development worlds.
- **Length.** About 200,000 tokens, BG1's length, unless the pilot moves it (see "Ceiling").
- **Minting.** Monthly, in custody: four weeks of worlds plus two spares, in slot order, the first kept worlds by BG1-C's
  validation and drop rules. A week uses its 8 worlds in slot order; a spare fills a week whose mint fell short.
- **Dates.** As in BG1, every date in a world is an offset from the world end, resolved at load from the world end set for
  that week: the Sunday before the week's Tuesday launch. The runner refuses once its clock passes that world end by 14
  days.

## Custody and exposure

BG1-C's custody program applies unchanged on the custody host: render, hold and run the sealed worlds in custody; at
rest, an encrypted archive; custody scripts print only counts and hashes; counted cells launch from the custody host with
hash-checked copies of one week's worlds, deleted at teardown; any per-question work runs in custody. A filled manifest of
the line's own pins every file of set W.

- **What leaves custody each week:** the aggregates only. Per world and per class, each arm's mean score and each paired
  difference, per reader and pooled; cost per correct answer; the gbrain release and commit; the comparators' versions;
  the seed and phrasing ids. Per-kind rows and exposure leave once per block. No question text, value, name or plan
  leaves custody while its set is live, and the aggregates writer refuses a field that could carry one.
- **Copies.** A week's worlds are kept in one copy, because a lost world costs one re-mint, not an experiment. The seed
  line and phrasing set are kept in two copies on two hosts once the second host is reachable.
- **When custody is down.** If the custody host is offline at launch, the launch retries every 2 hours for 24 hours. Then
  the week records "no point: custody host offline". Public worlds never stand in. If the month's mint falls short, the
  spares fill one week, and a week with no worlds records "no point: no worlds". A block with fewer than 16 counted
  worlds gets no verdict, and the next block starts on schedule.
- **Provider data use.** Google receives the sealed text for rendering and the claim check, under paid-tier API terms.
  Anthropic receives it for the validator, gbrain's shipped fact extraction (claude-haiku-5-5), the Opus readers and the
  Opus judge. Voyage receives it for gbrain's embeddings (voyage-4). Particle receives it for particle-1's
  reads. OpenAI receives the questions, gold answers and Opus's answers for the Astra judge, and the extract-first and
  memory-bank servers send session text to their own shipped extraction models.

## Systems

| Row | What it is | Configuration |
|---|---|---|
| gbrain | gbrain's newest release at launch: the highest version tag merged into gbrain's master when the week's cells start, frozen for that week and recorded with its commit. Each week measures the release that is newest that Tuesday | `rs1-stable` as BG1-C ran it: default fact extraction with name tags on, `query` with the facts block on, an 8,000-token reading budget (arm P) |
| grep agent | `baseline-file-agent` (`eval/runner/systems/file-agent.ts`): the sessions as `YYYY/MM/DD/<opaque>.md` files and `list_dir`, `grep` (ripgrep, uncapped, `files_only` available) and `read_file`, at most 40 turns, a prose `submit_answer`. Running out of turns or context scores 0. It is the same agent the BEAM-1M and BEAM-10M results call the file agent | the reader is the agent; no reading budget |
| extract-first server | as BG1-C ran it | `common`, its BG1-C bundle lock, its shipped extraction model |
| memory-bank server | as BG1-C ran it | `recipe`, its BG1-C bundle lock, its shipped extraction model |

Systems are named by kind; [comparisons and their protocols](../comparison-systems.md) names each product and version.
The servers keep their BG1-C locks until the next quarterly rotation, which moves each to its newest release by dated
amendment; every row names its server's version and the date that version was fixed.

The grep agent runs in this repository's own agent loop, as the BEAM rows ran it, not in a coding-agent product (GBEV-3
ruling, 2026-11-23). Public text calls it "a grep agent" or "a 40-turn grep agent over the chats as files", never by a
product name. The pilot carries a quick look (below) at Opus in Claude Code doing the same job, and if Claude Code does
better by more than the weekly smallest detectable difference, launch amendment A makes it the grep row before week 1,
but only if both readers pass their pilots and judge checks on Claude Code. Otherwise the grep row stays in our loop for
both readers and the quick look is reported as a note. Public text names the grep row's harness whenever it is not the
40-turn loop.

No row has gstack installed or loaded: every row is our own API loop or a server, so the no-kit condition (R44) holds for
all of them. gbrain's own agent tools (`query`, `search`, `get_page`) in the grep agent's loop are not a row yet. They
can join later as a secondary comparison by dated amendment, and never replace the grep-agent comparison.

## Readers and judges

- **Readers:** claude-opus-5-5 and particle-1 on every row, at the one effort BG1-C fixed for every reader (medium), with
  particle-1's output limit leaving room for its reasoning. On gbrain and the two servers, claude-opus-5-5 reads each
  8,000-token context live and particle-1 re-reads the same frozen context byte for byte afterwards. On the grep agent,
  each reader is the agent, so the grep agent's particle-1 row measures particle-1 as an agent; every table says so.
- **Judges (R78, R116):** gpt-6-astra grades claude-opus-5-5's answers; claude-opus-5-5 grades particle-1's. No model grades
  its own family, particle-1 never judges, and no gpt-4o model sits in a role we choose.
- **Judge checks (model-labelled):** BG1's judge check covers both judges on 8,000-token answers (160 labels each, kappa
  1.0). The grep agent's answers are free prose from a different source, so a new check runs on public development
  worlds before the first counted week: at least 100 labelled grep-agent answers per judge (gpt-6-astra on Opus's answers,
  claude-opus-5-5 on particle-1's), at least 40% of them judged wrong, and including answers that hit the turn cap, that
  called no tool and that hedge. Labels come from the oracle gold where it settles the answer and from gemini-3.8-flash
  where it doesn't. A judge counts only at kappa at least 0.6, with errors read per row. Human labels replace the model
  labels if they exist by then.

## Estimand and verdict rules

- **Score.** Each question scores the share of the two readers whose answer the judge passes (0, 0.5 or 1). A world's
  class score is the mean over that class's questions, times 100.
- **Comparison.** For each world, gbrain's class score minus the other row's. A comparison's estimate is the mean of
  those per-world differences over the block's counted worlds, with a paired t interval on N - 1 degrees of freedom. A
  restricted wild cluster bootstrap over worlds (BG1-C's method) is reported beside it.
- **Families.** Family 1: grep agent, now and past (two comparisons). Family 2: extract-first and memory-bank, now and
  past (four comparisons). Holm's step-down within each family, at two-sided 0.05.
- **Words.** Ahead: the Holm-adjusted test rejects and the estimate is above 0. Behind: it rejects and the estimate is
  below 0. Level within 3 points: the comparison is not ahead or behind and its simultaneous interval (95% adjusted by
  Bonferroni within its family: 97.5% in family 1, 98.75% in family 2) lies inside -3 to +3. Otherwise no measurable
  difference at this sample size.
- **Reader agreement.** Ahead, behind or level is published only when claude-opus-5-5's own estimate and particle-1's own
  estimate on that comparison have the same sign (level: both inside -3 to +3). Otherwise the word is "split by reader",
  with both readers' rows.
- **The look (R113).** Each block is one counted run. It takes one look when its 16th counted world is scored (normally
  the end of week 2; later if a week records no point) and stops a comparison only for efficacy, at O'Brien-Fleming
  bounds for two looks at information 0.5 and 1 of the planned 32 worlds, at that Holm step's alpha: at two-sided 0.05, |z| 2.797 at the look and 1.977 at the end; at 0.025, 3.183 and 2.250; at 0.0167,
  3.394 and 2.400; at 0.0125, 3.539 and 2.502. There is no futility stop, because the line runs either way. If the block ends with fewer than 32 counted worlds, both
  bounds stay as fixed here; the two tests are then more correlated, so the overall error stays at or below alpha. A
  comparison that crosses at the look gets its word then, labelled early, and the early word covers only the releases
  measured in those 16 worlds, named with it. The block's remaining weeks still run, and the full-block estimate and
  interval are published beside the early word. If the full-block estimate has the opposite sign, the comparison's
  block word is "changed within the block", with both rows and their releases, and no claim names either direction.
- **Weekly points.** Each week reports the same differences over its own 8 worlds, with intervals, and never a verdict
  word. The rolling display pools the last four weekly points (up to 32 worlds, each measured once on its own week's
  build) and names the builds it covers. A block's builds are listed with its verdict, because a block mixes up to four
  releases.
- **Missing data.** BG1-C's rules, on one common question set per comparison: a harness failure on either row, for
  either reader, leaves that question out of the comparison for both rows and both readers, and is counted, so every
  paired difference is taken over the same questions. A product failure (turn cap, context overflow, retrieval error)
  scores 0. A comparison whose common set loses more than 5% of a block's questions is descriptive for that block.
- **Ceiling.** Inside a block, a class where both rows of a comparison average at least 97% reports "ceiling" for that
  comparison instead of a word.

### Reported beside the verdict, not part of it

All-64 scores, per-reader rows, per-kind rows and exposure (per block), cost per correct answer for each reader and row,
turn-cap and context-overflow rates for the grep agent, and the regression flag with its false-alarm rate, simulated from
BG1-C's per-world differences.

## Predictions, recorded before any data

- gbrain stays level with or ahead of the two servers on what is true now, and behind at least one on questions about the
  past, as in BG1-C.
- The grep agent reads every session it needs on 200,000-token worlds, so it is at least level with gbrain on what is
  true now and ahead on questions about the past, where it can read every dated version of a fact. If so, the first
  block reads "behind a grep agent" on the past.

## Power

The smallest detectable difference, 80% power, at each family's strictest Holm step (two-sided 0.025 in family 1, 0.0125
in family 2), t on N - 1 degrees of freedom, for per-world standard deviations of the paired class difference that BG1-C
suggests for two readers (its three-reader values were 3.2 and 4.3 on what is true now and 6.1 and 6.9 on the past):

| Worlds | Family 1, SD 4.5 / 6 / 7.5 / 9 | Family 2, SD 4.5 / 6 / 7.5 / 9 |
|---|---|---|
| 8 (one week) | 5.9 / 7.9 / 9.9 / 11.9 | 6.7 / 9.0 / 11.2 / 13.5 |
| 32 (one block) | 2.6 / 3.4 / 4.3 / 5.1 | 2.8 / 3.7 / 4.6 / 5.6 |

A week shows only large gaps, such as BEAM-10M's. A block resolves about 3 points on what is true now and about 4.5 on the
past, the size of BG1-C's losses. Before the first counted week, the harness recomputes the two-reader standard
deviations for family 2 from BG1-C's receipts in custody; if they are larger than this table assumes, launch amendment
A resizes the week before any counted unit. The grep agent's between-world standard deviation can't come from a
one-world pilot, so family 1 is stated at the table's largest column (SD 9) until the first block measures it, and that
block's measured value sets the detectable difference later blocks claim, by dated amendment.

## Ceiling

If the grep agent with claude-opus-5-5 scores at least 95% on the pilot's public development worlds, launch amendment A
starts the line on longer worlds instead (about 1,000,000 tokens, BEAM-1M's scale, by the generator's session count),
before the first counted week.

## Pilots (R111) and the quick look (R112)

Before the first counted week, on public development world `bg1-dev-01` at the counted settings, each row runs its
pilot on at most a tenth of its block budget, read by both readers and judged by its judges:

- gbrain: the reader's context holds facts-block lines on at least one question, every question is answered and judged,
  and the row's cost per world is inside its rate.
- grep agent: every answer comes from at least one ripgrep call that returned (the receipt records the ripgrep version),
  every answer is judged, and the row's cost and turns per answer are measured; they price the weeks.
- extract-first and memory-bank: each server returns memories for every question, every answer is judged, and each
  server's cost per world is inside its rate.
- The mint: one world of set W at the counted length passes validation in custody.

A row that fails its pilot is fixed or left out, and a left-out row is reported as left out. The quick look puts Opus in
Claude Code (its own system prompt preset, the chats as files, no gstack installed) on the grep agent's pilot questions,
publishes no number and only decides which grep row the line runs.

## Harness

Lands in pull requests after this file and before the pilot:

1. ripgrep on every BG1 cell machine: installed, checked by the launch check before any cell starts, its version written
   to every grep-agent receipt, and a ripgrep process that fails to start is a harness failure, never an empty search.
2. Set W: its slot range, its loader, its filled manifest and its custody checks, beside BG1 and BG1-C's.
3. The weekly cell set: gbrain, the two servers and the grep agent, with both readers and their judges, per week.
4. The weekly runner: newest gbrain release at launch, the week's worlds, the cells, the re-reads and the judging.
5. The aggregates writer and the line's page: the per-world differences, the verdict rules above, the look, the rolling
   display, the regression flag and a test that refuses any field carrying sealed text.

## Run order

1. This file, merged.
2. The harness.
3. The judge check on public answers, the pilots and the quick look.
4. Launch amendment A: the harness commit, the grep row, the world length, the week's size, the seed commitment and the
   first world end.
5. The first monthly mint in custody.
6. Week 1 on the first Tuesday after the mint, then one week every Tuesday, a block every four weeks.

## Risks

- **Ceiling.** Handled by the pilot rule and the in-block ceiling rule.
- **Tuning against the line.** Handled by block-only per-kind detail, rotation and the confirmation block.
- **A release that breaks the harness.** A week whose gbrain row can't run records "no point: gbrain release failed to
  run" with the error, and that failure goes to gbrain's maintainers as a bug in that release.
- **Comparator drift.** Servers stay at fixed versions within a quarter.

## What it can and can't claim

It can say, per block and class, whether gbrain's releases of that month were ahead of, level with or behind a grep agent
and each server on held-out changing facts at an 8,000-token reading budget, for two readers. It can't say which gbrain
change caused a difference, how gbrain does at other budgets, or how it does on other kinds of memory question.

## Freeze

This file is frozen by the commit that adds it. The registry entry is
[`preregistrations.d/weekly-outcome-line.json`](preregistrations.d/weekly-outcome-line.json). The line's page is
`docs/benchmarks/2026-11-23-weekly-outcome-line.md`, and each block's results land in one pull request under
`docs/benchmarks/2026-11-23-weekly-outcome-line/` (GBEV-3 ruling, 2026-11-23: the block is the experiment).

## Amendments

### Amendment 1 (2026-11-25): questions that describe their subject, at 200,000 tokens, before week 1

Written before any counted week, any mint of set W and any counted gbrain run. It changes the worlds, the pilot and the
order the pilot runs in, and its caps. Everything this amendment doesn't name stays as frozen above.

**Why.** The pilot on public development worlds hit the ceiling twice. The grep agent with claude-opus-5-5 scored 0.990 on
the 200,000-token worlds, and on three 1,000,000-token worlds it answered 192 of 192 questions, so the move to longer worlds
that "Ceiling" calls for changed nothing. Every question names its subject, and that name appears in nearly every evidence
session, so one ripgrep call for the name returns the handful of sessions that matter. The questions measured reasoning
over sessions a keyword had already found, not memory. The re-plan offered four options; Garry Tan chose the first on
2026-11-25 ("Do it 1"): questions that no shared keyword ties to their sessions, back at 200,000 tokens.

**Generator.** The line moves to `changing-facts-gen@3` (`eval/generators/changing-facts-gen.ts`, with its name, role and property
pools in `eval/generators/changing-facts-alias.ts`). It keeps @2's 140 to 160 sessions, its eight kinds of eight questions and
its oracles, and changes how sessions and questions refer to people, companies, projects and deals:

- Each entity has an alias set: a canonical name, a nickname, a role ("my yoga teacher", "the firm downstairs"), a
  misspelling of one letter that keeps the first two, and a pronoun. A session names an entity by its nickname, role,
  misspelling or pronoun, and a pronoun line carries its antecedent in the same line. The canonical name appears only in
  the line that introduces it with the nickname, and a separate line links the nickname to the role.
- Each entity has a property ("sets crosswords for a local paper"), and about half have a one-way relation to another
  entity (landlord, mentor, former boss, founder, commissioner, counterparty). Property and relation lines sit only in
  sessions that hold no tracked fact.
- A question never names its subject. It describes it by its property, or in two steps through a relation ("the former
  boss of the person who did the calligraphy on our wedding invitations"); 13, 10 and 11 of the 64 questions in the three
  development worlds take two steps.
- Ground truth stays fixed by construction: the generator knows every alias, so each question's gold and the entity its
  description picks out come from the plan, never from rendered text. The alias worlds carry the gold-audit fixes the
  extra and long development worlds already have: a withdrawn fact's retraction says the plan is not happening, not only
  that a report was false, and a history question never asks about a slot with a scheduled change.
- The generator refuses to plan a world that fails any of these checks (`buildQuestions` and `aliasPlanProblems` in
  `eval/generators/changing-facts-gen.ts`): a question shares a distinctive word (one outside the generator's own
  templates and stopwords) with the planned lines of any of its evidence sessions; a description resolves to no entity or
  to more than one through the world's own lines; an alias names two entities. The leak check leaves the templates' words
  out because each recurs for every entity of its kind, so where only one entity in a world holds a slot of the
  question's kind, the kind word alone ("offsite", "piloting", "job title") still finds the evidence: 8 of the 192
  questions in the three development worlds (the generator's `isolatingWords`), and the stop rule's reading includes
  them. A question's evidence sessions are the sessions holding its fact; the lines that resolve its description sit in
  other sessions, so retrieval measured on evidence sessions measures finding the fact, not resolving the subject.
- `eval/custody/bg1/validate.ts` adds the gate `alias_leak` for @3 worlds: a rendered session that names an entity's
  canonical name outside its introducing line, or an evidence session that holds one of its question's key terms as a
  whole phrase, fails the world. It matches a key term of two words only as the phrase, so one of its words alone ("milk"
  from "oat milk") in a rendered evidence session passes the gate.
- @3 has only a public phrasing set so far, and a sealed @3 plan refuses until set W's custody inputs are re-cut for it
  (below).

**Length.** About 200,000 tokens. The longer-world move in "Ceiling" is withdrawn, since length did not change the
result.

**Pilot worlds.** The pilot and the judge check run on three new public development worlds of @3,
`bg1-dev-alias-01` (the pilot) and `bg1-dev-alias-02` and `-03` (the judge check), committed with their plans and questions
under `eval/data/changing-facts-v1/` and rendered by the custody renderer before the pilot. They replace `bg1-dev-01` to
`-03` for the pilot, at the counted settings and the caps "Money" sets below
(`bun eval/runner/weekly-line/pilot.ts plan --length alias`).

**Pilot order and the stop rule.** The grep agent goes first, on all three alias worlds: its pilot cell on
`bg1-dev-alias-01` and the judge check's cell on `-02` and `-03`, 192 questions for each reader. Its claude-opus-5-5
answers are scored together against the construction labels, not the judges' verdicts: an answer counts as right only
when it names the question's gold with no stale or decoy value and doesn't hedge (the judge check's gold-settled rule),
and every other answer, a turn-cap or context-overflow answer included, counts as wrong. So a judge's error or a failed
judge call can't move the reading across 0.95, and an answer the labels leave unsettled can only lower it. The reading
counts only when both cells finished complete and claude-opus-5-5's own loop answered each of the 192 questions once; a
missing or failed answer (a reader error, a budget stop) holds the reading until a resume answers it, and never counts as
right. Only the two cells of this pilot count. The other three rows run their pilots only if the reading is below 0.95
and the judge check can draw its sample from the grep agent's answers; their campaigns are written only from that
reading (`pilot.ts campaigns --length alias --grep-cell <dir>...`).

If the Opus grep agent scores 95% or more on the pilot, the line stops and we publish the grep result.

| Pilot result | What happens |
|---|---|
| The grep agent with claude-opus-5-5 scores 0.95 or more | The line stops before week 1 and no other row runs. We publish the grep result as a findings write-up, with the named-subject results at 200,000 and 1,000,000 tokens beside it, and commit the long and alias worlds as public development worlds so anyone can reproduce it (the re-plan's option 4) |
| Below 0.95, and the judge check can't draw at least 40 answers each judge called wrong from the grep agent's answers | The other three rows stay held and the reading goes back to the line's owner, who decides before any of them runs. No claim is published from the pilot |
| Below 0.95, and gbrain's pilot accuracy is within 3 points of the grep agent's on `bg1-dev-alias-01` (inside the level band a block resolves) | The line runs as frozen above, from launch amendment A. One world can't give a verdict, so the first block decides |
| Below 0.95, and gbrain is more than 3 points behind the grep agent on the pilot world | The line runs as frozen above. Because the world is public, its per-kind rows go to gbrain's maintainers at once as an advisory issue naming retrieval or reading, ahead of the first block. No claim is published from the pilot |
| Below 0.95, and gbrain is more than 3 points ahead of the grep agent on the pilot world | The line runs as frozen above. No claim is published until a block reads gbrain ahead |

Either way the pilot publishes no verdict of its own, and a row that fails its R111 checks is fixed or left out as
"Pilots" says.

**Judge check.** Unchanged in its gates: at least 100 labelled grep-agent answers per judge, at least 40% of them judged
wrong, and a kappa of at least 0.6. Its labels keep the construction rule: the oracle gold labels an answer wherever it
settles it, and gemini-3.8-flash labels the rest, reported as model-labelled. Harder questions should also give the check
the wrong answers the named-subject pilot was short of; if they don't, the other rows stay held, as the table says.

**Money (2026-11-25).** One paid window covers the alias worlds' mint and both stages of the pilot: the grep agent's
stage (its pilot cell, the judge check's cell and the labelling pass) and the other rows' stage. The per-ledger caps are
resized for that window from each stage's expected spend, in place of a tenth of each row's block budget, so the mint
and both stages together fit inside the window's cap (`WEEKLY_ALIAS_PILOT_MONEY` in
`eval/runner/q1/cells/weekly-line.ts`). `pilot.ts campaigns` refuses either stage unless the mint's and both stages'
caps together fit the window's cap, and the dry run (`pilot.ts plan --length alias`) prints each ledger's cap. A cap
reached pauses its run for an extension, as the line's other caps do.

**Fixes before the window (2026-11-25).** Four fixes land on the results branch before the paid window opens, each with a
keyless test that fails without it:

- The stop rule scores its own reference answers right (d7571ca82). A withdrawal answer that leads with "none" and names
  the withdrawn partner only as context ("None: the plan with Lisbon was called off") now counts as right, so the 192
  reference answers score 192 of 192 and a stale answer set scores 0 of 192. It is a label of the stop rule's own
  (`pilot.ts stopRuleLabel`): BG1's `matchAnswer` and the judge check's `goldLabel`, which counted scoring also uses, are
  unchanged.
- A judge with no verdicts makes the judge check short (d9b663f57), so the other rows stay held instead of the check
  passing on one judge alone.
- The stop rule reads only paid cells (403dc365a). Cell receipts now record a keyless upstream or the paid window they
  ran under, and `campaigns --grep-cell` refuses a keyless rehearsal cell or a receipt without that record.
- The window's caps are re-split (a28f552f3): the mint's cap rises above its estimate, the grep agent's stage is unchanged
  and the other rows' stage shrinks to fit, inside the same window (`WEEKLY_ALIAS_PILOT_MONEY`).
- The stop rule's withdrawal label is tightened, and the paid window's record is tested (the commit after 1b144674d,
  "2026-11-25: a withdrawal answer must also end on 'none' to count for the stop rule"). A withdrawal answer now counts
  as right only when its last tracked value is a none-form too, so "None, Goldcrest Insurance" no longer does; the
  reference answers still score 192 of 192 and the stale set 0 of 192. A keyless test checks that a run whose lease proxy
  reports paid mode records its granted window.

**Stage 2 on the misspelling questions (2026-11-25).** The grep agent's reading came in below 0.95 with the judge check
short, so the table above held the other rows for the line's owner. Garry Tan decided on 2026-11-25 ("Do it" to GBEV-3's
J2): the other rows run a stage 2 of their own, in a paid window of its own with no mint, as follows. Written before any
stage-2 cell runs.

- **Question filter.** gbrain, extract-first and memory-bank run on all three alias worlds, each world ingested whole, and
  are asked only the 34 questions whose evidence names their subject by its misspelling: a planned line in one of the
  question's evidence sessions refers to its subject by the misspelling alias (`changing-facts-gen.ts
  misspellingQuestionIds`, set `BGW-misspell-alias`, `pilot.ts campaigns --length alias --misspelling-stage`). It is
  the split the stage-1 results read the grep agent's 22 of 34 on. The 34 ids: `bg1-dev-alias-01:s2_corrected:0`,
  `bg1-dev-alias-01:s2_corrected:1`, `bg1-dev-alias-01:s3_repeated_stale:5`, `bg1-dev-alias-01:s3_repeated_stale:6`,
  `bg1-dev-alias-01:s3_repeated_stale:7`, `bg1-dev-alias-01:s4_conflicting:1`, `bg1-dev-alias-01:s4_conflicting:5`,
  `bg1-dev-alias-01:s4_conflicting:6`, `bg1-dev-alias-01:s5_withdrawn:7`, `bg1-dev-alias-01:s7_as_known:0`,
  `bg1-dev-alias-01:s7_as_known:2`, `bg1-dev-alias-01:s8_history:2`, `bg1-dev-alias-01:s8_history:4`,
  `bg1-dev-alias-01:s8_history:7`, `bg1-dev-alias-02:s2_corrected:3`, `bg1-dev-alias-02:s5_withdrawn:0`,
  `bg1-dev-alias-02:s5_withdrawn:1`, `bg1-dev-alias-02:s5_withdrawn:4`, `bg1-dev-alias-02:s5_withdrawn:5`,
  `bg1-dev-alias-02:s8_history:1`, `bg1-dev-alias-03:s1_updated:0`, `bg1-dev-alias-03:s1_updated:4`,
  `bg1-dev-alias-03:s1_updated:5`, `bg1-dev-alias-03:s2_corrected:0`, `bg1-dev-alias-03:s2_corrected:1`,
  `bg1-dev-alias-03:s5_withdrawn:2`, `bg1-dev-alias-03:s5_withdrawn:3`, `bg1-dev-alias-03:s6_as_of:6`,
  `bg1-dev-alias-03:s7_as_known:5`, `bg1-dev-alias-03:s7_as_known:7`, `bg1-dev-alias-03:s8_history:0`,
  `bg1-dev-alias-03:s8_history:1`, `bg1-dev-alias-03:s8_history:2`, `bg1-dev-alias-03:s8_history:3`.
- **The comparison.** Each row's claude-opus-5-5 answers on exactly those 34 ids are compared with the grep agent's
  claude-opus-5-5 answers from stage 1 on the same ids, 22 of 34 right, paired by question: the discordant pairs both ways,
  listed by id, and an exact McNemar test. Both sides are scored by the same gating judge, gpt-6-astra. No number on the
  other 158 questions comes from stage 2, since no row is asked them.
- **Readers.** claude-opus-5-5 reads each row live with its gating judge, gpt-6-astra. particle-1 is left out of stage 2 on
  cost, and there are no re-reads.
- **gbrain build (R100).** gbrain's newest release at launch, the highest version tag on its main branch when the stage
  starts, v0.60.773.0 or later (v0.60.774.0, commit e8791f54e6b12cfa307363c3414b5bfe43db0b8a, when this line was written;
  checked again with `git ls-remote --tags` at launch). This re-pins the alias pilot's gbrain row from the build named
  below; no counted gbrain run has started.
- **Judge check.** Stage 2's answers that gpt-6-astra judges wrong join that judge's pool beside the grep agent's. The
  check's gates are unchanged: labelling runs only if each judge's pool reaches 40 answers judged wrong. claude-opus-5-5's
  pool gains nothing, since no particle-1 answer is read in stage 2, so unless labelling runs the comparison is reported as
  having an unchecked judge.
- **Money.** Each row's cell has its own ledger at its cap, and the three caps together stay inside stage 2's window
  (`WEEKLY_ALIAS_STAGE2_MONEY`); `campaigns --misspelling-stage` refuses otherwise. A cap reached pauses its row at the
  cell boundary for an extension.

**Readers and judges.** Unchanged: claude-opus-5-5 and particle-1 read every row; gpt-6-astra judges claude-opus-5-5's
answers and claude-opus-5-5 judges particle-1's.

**gbrain build.** gbrain's newest release at launch, the highest version tag on its main branch when each run starts
(v0.60.772.0, commit d12c584e087952cf48a170ce36011e0370ab9e27, when this amendment was written). If a newer release lands
before the first counted gbrain run, a dated amendment re-pins it before that run; once counted gbrain runs start, the
build is frozen for the block.

**No-gstack arm (R44).** No row has gstack installed or loaded, and gstack is not under test, so every row is the no-kit
condition and R44 holds as in "Systems". The Claude Code quick look, if it runs, keeps no gstack installed.

**Custody.** Set W's W1 seed line and phrasing set, and W1-long's, were written for @1 and @2. Before week 1, the line's
owner re-cuts both in custody for @3 (a new private phrasing set with @3's question templates, which describe their
subject and never name it), and launch amendment A publishes their commitment and phrasing SHA-256 as frozen above. No
world of set W has been minted, so no counted world changes.

## Disclosures

gbrain is Garry Tan's own project. Disclosure: Y Combinator, which Garry Tan runs, is an investor in Particle, which makes
particle-1.
