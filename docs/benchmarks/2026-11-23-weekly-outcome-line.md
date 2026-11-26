# Weekly held-out line: a grep agent matched gbrain on named-subject recall, so the line stops before week 1

- **We learned that a plain grep agent on claude-opus-5-5 finds changing facts about a named person or company about as
  well as gbrain and two memory servers.** The agent searches the raw chats with ripgrep and reads the files it finds;
  it has no memory system. It answered 190 of 192 questions on three 200,000-token chat histories and 192 of 192 on
  three 1,000,000-token ones. On the one world where all four systems ran at each length, gbrain and the extract-first
  server were level with it or one question behind, and the memory-bank server was two to four questions behind. If
  your agent's questions name what they ask about, you should measure plain text search over the raw conversations
  before you add a memory layer for recall.
- **We learned that describing the subject instead of naming it still left grep at 151 of 158 (0.956)** when the chats
  call people and companies by nicknames, roles or full names. We did not run gbrain on those questions, so this page
  makes no claim about gbrain against grep there.
- **What didn't work: none of the question designs we built got grep below the line's 0.95 ceiling on a fair set of
  questions.** Grep fell well below it on the 34 questions where the chats spell the subject's name with one
  letter changed (22 of 34), and two people asked blind agreed that such a pair is the same entity on 1 of 20. On those 34 questions every memory system scored below grep (gbrain 2 of 34), but because the items failed that
  check, those numbers are descriptive only and come from a judge nobody has checked against people.

Settled call: the weekly held-out line stops before week 1. No counted week runs, gbrain is not ranked against a grep
agent on held-out worlds, and the long and alias development worlds stay public so anyone can reproduce these pilots.

This page reports the pilots of the [weekly held-out line](2026-11-23-weekly-outcome-line-preregistration.md), run from
November 24 to 26, 2026, on public development worlds only. No sealed world was minted and no counted week ran.
[`eval/runner/weekly-line/results-recount.ts`](../../eval/runner/weekly-line/results-recount.ts) recounts model scores,
costs and paired comparisons from the committed records. The human fairness labels stay private and are reported only
in aggregate.

## Cost per correct answer: the grep agent with both primary readers

| Worlds (3 each, 64 questions per world) | claude-opus-5-5 right | claude-opus-5-5 $ per right answer | particle-1 right | particle-1 $ per right answer |
|---|---:|---:|---:|---:|
| Named subjects, about 200,000 tokens | 190/192 (0.990) | $0.024 | 180/192 (0.9375) | $0.004 |
| Named subjects, about 1,000,000 tokens | 192/192 (1.000) | $0.034 | 180/192 (0.9375) | $0.006 |
| Described subjects (alias worlds), about 185,000 tokens | 173/192 (0.901) | $0.076 | 171/192 (0.891) | $0.019 |

Here each reader is the agent: it searches, reads and answers. Dollars are the agent's own model calls; judging is not
included. gpt-6-astra judges claude-opus-5-5's answers and claude-opus-5-5 judges particle-1's. One particle-1 answer on
the alias worlds ran out of turns and counts as wrong.

## What the questions look like

Each world is a made-up chat history between a person and an assistant, about 150 sessions, in which
facts change: a job title is updated, a head office is corrected, a plan is called off, two people give conflicting
figures. Each world has 64 questions in eight kinds (the current value, a corrected value, a value repeated after it
went stale, conflicting values, a withdrawn plan, the value on a date, what was known on a date, and the history of a
value). A generator writes each world from a plan, so every answer is known before any system reads the chats.

The first two designs name the subject: "Which city is Quayside Health's offsite in?" The name appears in nearly every
session that holds the answer, so one ripgrep call for the name returns the handful of sessions that matter, and the
agent then reasons over their dates.

The alias design ([Amendment 1](2026-11-23-weekly-outcome-line-preregistration.md#amendment-1-2026-11-25-questions-that-describe-their-subject-at-200000-tokens-before-week-1))
removes that shortcut. Sessions call each entity by a nickname, a role ("the firm downstairs"), a one-letter
misspelling or a pronoun, and the question describes the subject instead of naming it, sometimes in two steps: "the
former boss of the person who did the calligraphy on our wedding invitations". The generator refuses any question that
shares a distinctive word with the sessions that hold its answer.

## The systems

- **grep agent:** the chats as dated Markdown files, with list, ripgrep and read tools, up to 40 turns and a written
  answer (`baseline-file-agent`, [eval/runner/systems/file-agent.ts](../../eval/runner/systems/file-agent.ts)). It is the
  agent the BEAM-1M and BEAM-10M results call the file agent.
- **gbrain:** its newest release when each run started, default fact extraction with name tags on, `query` with the
  facts block on, and 8,000 tokens of context per question. The build is named on every row.
- **extract-first server** and **memory-bank server:** two memory servers as the changing-facts confirmation ran them,
  each with its shipped extraction model, at 8,000 tokens. [Comparisons and their protocols](../comparison-systems.md)
  names each product and version.

## Named subjects: everything is near the ceiling

The grep agent's pooled scores are in the first table. The other three systems ran on one world at each length, with
claude-opus-5-5 reading:

| claude-opus-5-5 reading, 64 questions | 200,000 tokens (`bg1-dev-01`) | 1,000,000 tokens (`bg1-dev-long-01`) |
|---|---:|---:|
| grep agent | 63/64 | 64/64 |
| gbrain | 63/64, v0.60.768.0 (`528595df`), $0.056 per right answer | 63/64, v0.60.769.0 (`38831bb6`), $0.073 |
| extract-first server | 63/64, $0.106 | 63/64, $0.345 |
| memory-bank server | 59/64, $0.055 | 62/64, $0.074 |

Dollars per right answer for the three memory systems cover ingesting the world, the reader and the
judge. The grep agent ingests nothing; its agent calls cost $0.024 and $0.034 per right answer (first table). One
question is 1.6 points at 64 questions, so no row is more than four questions from the grep agent, and one world gives
no interval. At 1,000,000 tokens the memory-bank server's miss on "Which customer is Project Ostrava piloting with?"
answered that the pilot had been called off, which reads as right; nobody adjudicated it.

Opus grep remained near the ceiling on both named-subject pilots: 190 of 192 at 200,000 tokens and 192 of 192 at
1,000,000 tokens. The pilots used different worlds, so they don't isolate the effect of history length.

## Described subjects: grep held on plain aliases

| Questions on the alias worlds (claude-opus-5-5 and particle-1 as the grep agent) | claude-opus-5-5 | particle-1 |
|---|---:|---:|
| All 192 | 173 (0.901) | 171 (0.891) |
| Evidence names the subject by nickname, role or full name (158) | 151 (0.956) | 145 (0.918) |
| Evidence names the subject by a one-letter misspelling (34) | 22 (0.647) | 26 (0.765) |

By world, claude-opus-5-5 scored 57, 61 and 55 of 64, and particle-1 59, 57 and 55. On the plain aliases the grep
agent stayed at the line's 0.95 ceiling. Most of claude-opus-5-5's misses were on misspellings. It often noticed
the spelling ("spelled differently from Clem's surname") and decided the name meant someone else.

gbrain and the two servers were not run on the 158 plain-alias questions, so there is no gbrain number to set beside
151 of 158.

## The misspelling questions: not a fair test

Before reading anything into the 34 misspelling questions we asked whether a careful person would treat a one-letter
misspelling, such as "Clementine Hadded" for "Clementine Haddad", as the same entity. Two people each labelled 20 real
pairs from those questions, shown with the evidence session and no system or answer, plus 5 control pairs and 2
attention pairs. Before any answer was opened, we set the rule that the misspelling counts as fair only if at least 15 of
the 20 pairs settle as "same entity".

- The two labellers agreed "same entity" on 1 of the 20 pairs. One labeller said yes on 1 of 20 and the other on 9 of
  20; even if a third person sided with every yes, at most 9 of 20 could count as fair.
- Both labellers got all 5 controls and both attention pairs right. The second labeller's page recorded far less active
  time than it reported, so its labels carry a speed caveat; the verdict doesn't depend on them, since the first
  labeller alone said yes on 1 of 20.
- Both raised the ambiguity unprompted: "Should an obvious typo count as the same entity?"

So the misspelling alias is not established as a fair test, and a gbrain advantage confined to it would not have
counted toward continuing the line.

## Stage 2 on the 34 misspelling questions: descriptive only

While the fairness check ran, gbrain and the two servers each ingested all three alias worlds whole and were asked
only the 34 misspelling questions. These items failed the fairness check above, so this table is descriptive,
and its judge (gpt-6-astra) is an **unchecked judge**: the agreement check against people that this line requires
never ran (below).

| claude-opus-5-5 reading, 34 questions | Right | By world (14, 6, 14) | Minus grep, paired (95% Wald) | Row right, grep wrong | Grep right, row wrong | Exact McNemar p | $ per right answer |
|---|---:|---|---|---:|---:|---:|---:|
| grep agent (same answers as above) | 22 | 9, 5, 8 | | | | | |
| extract-first server | 11 | 4, 2, 5 | -32.4 points (-50.1 to -14.6) | 1 | 12 | 0.0034 | $1.157 |
| memory-bank server | 8 | 5, 0, 3 | -41.2 (-59.6 to -22.7) | 1 | 15 | 0.0005 | $0.334 |
| gbrain v0.60.774.0 (`e8791f54`) | 2 | 1, 0, 1 | -58.8 (-75.4 to -42.3) | 0 | 20 | 0.000002 | $1.324 |

Dollars cover each whole cell, ingest included. The Wald intervals are rough at 34 pairs; the exact McNemar test is the
primary one. Of grep's 12 misses, the extract-first server got one right (`bg1-dev-alias-03:s1_updated:4`), the
memory-bank server one (`bg1-dev-alias-01:s4_conflicting:5`) and gbrain none. Every discordant id is in the recount's
`--json` output.

In the gbrain answers we read, the reader says its memories describe the subject but don't identify it. On
`bg1-dev-alias-01:s2_corrected:0` it found "Our newest customer launches weather satellites" and no name for that
customer. What didn't come back was the line that ties a description or a misspelled name to the entity. That points
at entity resolution, but these questions can't settle it, because the items themselves failed the fairness check.

## Why the line stops

[Amendment 1](2026-11-23-weekly-outcome-line-preregistration.md#amendment-1-2026-11-25-questions-that-describe-their-subject-at-200000-tokens-before-week-1)
moved the line to described subjects after the named-subject pilots hit the ceiling at both lengths. Its stop rule
needed the grep agent below 0.95 and a judge check that could run; the alias pilot read 0.901 by judge, but each judge
had fewer than 40 answers it called wrong, so the other rows stayed held and the decision went to the line's owner.

Garry Tan then approved one more step. If gbrain resolved the misspellings grep missed and people
judged the misspellings fair, the line would continue; otherwise it stops and the results are published. Neither held.
gbrain got none of grep's 12 misspelling misses right, and people did not judge the misspellings fair. The line stops
before week 1.

## What we didn't measure

- **gbrain on plain aliases.** Stage 2 asked only the 34 misspelling questions, so there is no gbrain number on the 158
  plain-alias questions, where the grep agent scored 151.
- **particle-1 on gbrain and the servers** at 1,000,000 tokens and in stage 2. The 1,000,000-token re-reads were
  skipped once the stop rules fired. The stage 2 plan left out particle-1 on cost.
- **More than one world per length** for gbrain and the two servers on named subjects.

## The judge check never ran

This line requires each judge to agree with at least 100 labelled grep-agent answers (kappa at least 0.6), with at
least 40 of them judged wrong, before its numbers count. The grep agent was too accurate to supply that many wrong
answers: 12 among 384 at 1,000,000 tokens, all particle-1's, and 19 and 20 per judge on the alias worlds. So no labels
were bought for the judge check, and no kappa exists. The model scores come from judges this line never checked against
people, so read them as descriptive. Stage 2's wrong answers would not have joined the pool either: the pool code accepts
only the grep agent's cells, and it fails closed.

The line's own stop rule also had a model-free construction-label reading of the alias pilot. That scorer misread
answers that give the current value and then narrate its history, counting them as unsettled, so it was not used and
its reading is not reported.

## Method notes

- **Readers and judges.** claude-opus-5-5 and particle-1 read at medium effort. gpt-6-astra grades claude-opus-5-5's
  answers and claude-opus-5-5 grades particle-1's; no model grades its own family.
- **Resumed cells.** In stage 2, the gbrain and memory-bank cells stopped after 33 and 31 of 34 questions on their
  first budget leases and were resumed once on fresh campaigns. A resume restores the earlier lease's store snapshot and
  its checkpointed answers, and the cell then asks only the questions without an answer
  (`shootout-cell.ts resume --from-campaign`, snapshot mode). Both resumes ran on committed code at `910f39156`.
  Commit `f9b0ead10` adds a regression test that a resume into a cell with answers asks none of them again, ingests
  nothing again and adds only the missing ids, and makes `runCell` refuse an output folder whose receipts were
  written under the other upstream (a keyless rehearsal into a paid cell, or the reverse). Each committed answer file
  holds one answer per question.
- **System-internal models.** The extract-first server extracted with gpt-4.1-mini, as the changing-facts confirmation
  configured it, and the memory-bank server with its shipped gpt-4o-mini; gbrain's own extraction resolved to
  claude-haiku-5-5. None of them reads or judges.
- **Server receipts by kind.** This repository names other memory products only in
  [docs/comparison-systems.md](../comparison-systems.md). So in the six committed receipts of the extract-first and
  memory-bank cells, `system.versions` and `system.capabilities` are replaced by a pointer to that kind's
  `capability.json` and the sha256 of the original block; every count, answer, judgment and dollar is unchanged.
- **Worlds.** Named subjects: `bg1-dev-01` to `-03` and `bg1-dev-long-01` to `-03`, already committed. Alias:
  `bg1-dev-alias-01` to `-03` (changing-facts-gen@3), committed with this page; their `world.json` sha256 prefixes
  are `04d01519fcf6f76f`, `b9f5b4a58ac9e1f0` and `0c301fe7c16764c4`, and each passes
  `bun eval/custody/bg1/validate.ts --dev <id> --set <dir>` with no failed gate. World end 2026-11-22.

## Reproduce and inspect

```sh
bun eval/runner/weekly-line/results-recount.ts          # model scores, costs and paired comparisons
bun eval/runner/weekly-line/results-recount.ts --json   # with the discordant ids
bun test test/eval/weekly-line-results.test.ts          # checks them against this page
```

No key is needed. The per-question records are under
[`2026-11-23-weekly-outcome-line/pilot/`](2026-11-23-weekly-outcome-line/pilot): one folder per cell, with its
answers, gating judgments, receipt, run config and per-question rows, and a `leases/` folder with each budget lease's
summary. `named-200k/` and `named-1m/` hold the named-subject pilots, `alias-stage1/` the grep agent on the alias
worlds and `alias-stage2/` the misspelling stage. The fairness check's labels stay private; this page gives only their
counts.

## Disclosures

gbrain is Garry Tan's own project.

Disclosure: Y Combinator, which Garry Tan runs, is an investor in Particle, which makes particle-1.

Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator. Garry Tan runs Y Combinator.
