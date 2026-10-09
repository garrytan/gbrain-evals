# The program primary: baseline on gbrain v0.60.106.0

## The finding

On October 8, 2026 we ran the program primary's development baseline on the frozen release, gbrain v0.60.106.0
(`7aa2caa0`). The program primary is the end-to-end task a 10x claim is measured on. An agent hears about a
commitment, a moved meeting and a correction in one session. In a fresh session it has to prepare for that meeting
or draft the reply. Three current readers ran it: Sonnet 5.5, Opus 5.5 and gpt-6.1-sol, 64 runs each.

**At this release the workload is at its ceiling.** Sonnet 5.5 and gpt-6.1-sol failed 0 of 64 runs each. The
preregistered scorer counts 11 failures for Opus 5.5 (17.2%, persona-clustered 95% interval 6.1% to 28.3%). We read
all 11 deliverables. Each one names the contact's namesake only to warn the user not to mix the two people up ("Don't
mix him up with Yusuf Varga ... you owe *him* the revised statement of work"). Read by a person, no run of any
reader failed. A 10x reduction in failures needs failures to reduce. So on this workload the measured "factor" is
`ceiling` for every reader: no ratio exists.

The harness itself works. Two mutants break the memory on purpose. One drops the item from every channel. The other
lets the correction never land. They fail 32 of 32 and 32 of 32 runs against 0 of 32 for the same Sonnet 5.5 tasks,
so the primary does detect lost and stale memory. A real Claude Code process with gbrain's hooks registered agrees
with the injected-context carrier on 8 of 8 tasks. That lifts the "injected-context component test" label for Sonnet
5.5 on this workload, with the caveat that both arms pass everything.

The workload needs to be harder before it can carry the 10x claim. The table under "What to use and what to avoid"
lists what made it easy. This is a development baseline. It authorizes nothing: no candidate has been compared
against it, and no sealed seed exists.

Spend: $61.02 of the $80 budget-ledger cap (run `t0-program-primary-2026-10-08T21-07-30-319Z-3c3e450c`). PW, the
power work, cost $0.

## The concrete case

gbrain is a memory system for agents. It stores notes as Markdown pages and builds a search index over them. A
coding-agent harness such as Claude Code reaches it two ways: through MCP tools the agent calls (pull), and through
hooks that push context into the conversation at session start and at each prompt.

Here is one invented task from persona 20261008:

- **Session 1.** "Just got off a call with Matteo Brandt. Please update my brain with this: I promised Matteo I'd
  send the SOC 2 bridge letter before our pricing review. Correction: the price in my notes is wrong: we quoted $24
  per seat, not $21. Our pricing review moved from Monday, October 26 to Friday, October 30, same time."
- **Session 2, the next day, in a new session.** "Prep me for my next meeting with Matteo Brandt: who they are now,
  when we're meeting, where things stand, and anything I owe them."

The brain still says October 26 and $21 on Matteo's person page, the deal page, the meeting page and a daily note.
Another contact named Matteo works at another company and has his own meeting, deal and open promise. A deliverable
fails if it misses the bridge letter, gives October 26 or $21 as current, or states one of the other Matteo's
values.

## The experiment and results

**Setup.** There are 8 development personas, one per seed (20261008 to 20261015). Each is an invented founder with
about 73 pages. Each persona has 4 tasks: 2 meeting-prep and 2 reply, so 32 tasks in all. Each brain is a PGLite
gbrain built with the frozen release. Pages are embedded with `openai:text-embedding-3-large`, and the agent reaches
the brain through `gbrain serve --surface starter` over stdio.

Each session runs the release's own `gbrain hook session-start` and `gbrain hook user-prompt` commands at the points
Claude Code would. Their output is injected into the user turn. The model then works through gbrain's MCP tools for
up to 20 turns. The contract the carrier follows is frozen in the
[preregistration](2026-10-08-program-primary-preregistration.md): context source, deadlines, byte caps, session
reset, persistence and startup maintenance. Scoring is deterministic (`t0-score-v2`, amendment 1). The
preregistration also freezes the arms, the loss tolerance (3.0 points), the resource envelope and the statistics.

**Results.** These are baseline-arm failures under the preregistered scorer, with persona-clustered 95% intervals.

| Reader | Runs | Failures (v2) | 95% interval | Complete deliverables | Failures on human reading |
|---|---:|---:|---|---:|---:|
| Sonnet 5.5 | 64 | 0 | 0 to 0 | 64 | 0 |
| Opus 5.5 | 64 | 11 (all `unsupported`) | 6.1% to 28.3% | 53 | 0 |
| gpt-6.1-sol | 64 | 0 | 0 to 0 | 58 | 0 |

"Complete" means the commitment, the new date and the corrected value all appear. gpt-6.1-sol left out the corrected
value 6 times: it stated the seat count without the price, or the reverse. An omission is not a failure under the
plan's definition.

**Mutants and ablation.** All three arms ran on Sonnet 5.5, on the 32 tasks, one repeat each.

| Arm | What it breaks | Failures | Failure kinds | Detected |
|---|---|---:|---|---|
| `mutant-forced-drop` | session 1 rolled back, session-2 push dropped | 32/32 | missed commitment 32, stale date 32, stale correction 31 | yes |
| `mutant-stale-correction` | the correction never lands; date and commitment do | 32/32 | stale correction 32 | yes |
| `ablation-push-off` | hook output dropped in both sessions; brain intact | 0/32 | none | not a mutant |

The ablation shows that on this workload, the push channel changes nothing measurable. Without any hook context,
Sonnet 5.5 still pulled every fact through MCP and passed all 32 tasks. With push on, session 2 did carry the facts.
The SessionStart context pack served "Hot memory" lines from session 1's `remember` calls whenever the agent had
made them (37 of 64 Sonnet sessions, 63 of 64 gpt-6.1-sol, 56 of 64 Opus). UserPromptSubmit always pushed a pointer
to the contact's page.

**Capture.** Session 1's write calls carried all three facts in 192 of 192 baseline runs. Every reader edited the
person, deal and meeting pages, and most also called `remember`.

**Native parity slice.** This slice ran a real Claude Code process on 8 tasks (the first task of each persona) with
Sonnet 5.5. It used Claude Code 2.1.285, with gbrain's hooks in its settings and gbrain's MCP server in its config.

| | Injected carrier (baseline, repeat 1) | Claude Code |
|---|---|---|
| Failures | 0/8 | 0/8 |
| Push context recorded in the session-2 transcript | n/a | 8/8 |
| Outcome agreement | 8/8 | |

The preregistered rule needs 7 of 8 agreements and the push context in every session-2 transcript. Both held, so for
Sonnet 5.5 on this workload, the carrier's results count as the end-to-end primary. For Opus 5.5 and gpt-6.1-sol,
the injected-context label stands. Agreement at 0 failures on both arms says little about how failures would
compare.

**Resource envelope of the baseline.** The preregistered limits are multipliers of these numbers.

| Reader | Session-2 wall time p50 / p95 | Reader tokens per run (input / output) | Dollars per run (reader + gbrain) |
|---|---|---|---|
| Sonnet 5.5 | 9.6 s / 15.8 s | 150,203 / 4,017 | $0.155 |
| Opus 5.5 | 20.6 s / 35.0 s | 244,604 / 5,612 | $0.380 |
| gpt-6.1-sol | 20.5 s / 30.7 s | 114,217 / 2,355 | $0.100 |

A run is both sessions. Wall time is measured with four personas running at once. Token counts are
`usage-receipt/v1` input and output totals across both sessions. gbrain's own provider calls (query embeddings and
reranking) cost under $0.001 per run.

**Scorer audit (preregistered).** We drew 30 baseline deliverables with a seed, 10 per reader, and labeled them by
hand. The scorer agreed on 29 of 30 ([scorer-audit.json](2026-10-08-program-primary/scorer-audit.json)). The one
disagreement is an Opus disambiguation that the scorer counts as `unsupported`. We also read every one of the 11 Opus
failures outside the sample: all are disambiguations. `t0-score-v3` is a post-hoc rule that accepts a
disambiguation anywhere in the same paragraph. It cuts Opus to 1 failure, and that one is also a disambiguation
("This is a different Hana from Hana Okafor"). v3 was written after we saw the outputs, so it is reported here and
never replaces v2. The superseded v1 rules would count 24 to 33 failures per reader, almost all of them correct
deliverables that cite an outdated record.

**Power (PW).** The interval for the failure-risk ratio is the conditional binomial. The simulation chose it under
the preregistered rule, because it is the only method with at least 93% coverage in every scenario. The delta method
and the persona bootstrap undercover when the candidate has few failures
([power.json](2026-10-08-program-primary/power.json)). The preregistered sample-size rule is computed at the measured
pooled baseline rate (v2: 11 of 192, 5.7%). Detecting `10x` with 80% probability for a candidate whose true factor
is 20 would need 136 personas. That is above the 32-persona cap, so a candidate comparison on this workload would run
at 32 personas, where `10x` is reached with probability 0.18. On the human reading the baseline rate is 0 and no
ratio exists at any sample size.

## What to use and what to avoid

Use this harness: the generator, the delivery contract, the scorer and the two mutants. It runs gbrain's real hooks
at the release's deadlines and caps. It catches both lost and stale memory. A real Claude Code process gives the
same results.

Do not use this workload to claim a failure-reduction factor for gbrain. It is too easy for current readers, for
these reasons:

| What makes it easy | Why it matters | Possible change (needs a new preregistration) |
|---|---|---|
| Session 1 says "please update my brain", and every reader wrote all three facts | capture never fails | state the facts in passing, without a request to save them, or across several turns |
| One contact per task, named in session 2 | retrieval is trivial (the push pointer, `get_page`) | refer to the contact by role or company, or ask about several meetings at once |
| 73-page brains | search never misses | the large brain sizes from the wave 3 manifest |
| Stale values sit beside fresh edits on the same pages | readers see both and pick the newer | a correction made in another tool (a daily note or an email digest) that leaves the page untouched |
| Session 2 is one day later, with no maintenance in between | nothing decays | run the dream cycle and autopilot between sessions, or add intervening sessions |

Each row is a hypothesis about what would make a baseline fail. None of them has been measured. Opus 5.5 warns the
user about the namesake, which the v2 scorer counts as a failure; a new scorer version should excuse
disambiguation in the same paragraph (v3), validated against a fresh audit.

**Known limits.** One phrasing set exists, so a held-out run changes seeds, not wording. The mutants and the ablation
ran on Sonnet 5.5 only. Stop and SessionEnd hooks, transcript capture and the dream cycle are outside the delivery
contract. Latency was measured under four concurrent personas on a 4-core cloud machine.

## Reproduce and inspect

```bash
# keyless hermetic slice: scripted reader, one persona, all four arms, $0, about 4 minutes
bun eval/runner/t0-program-primary.ts --gbrain <gbrain checkout>@7aa2caa0 --output eval/reports/t0-program-primary/hermetic

# paid baseline (ANTHROPIC_API_KEY, OPENAI_API_KEY; VOYAGE_API_KEY for gbrain's reranker)
bun eval/runner/budget-ledger.ts open --runner t0-program-primary --budget-usd 80
bun eval/runner/t0-program-primary.ts --gbrain <gbrain checkout>@7aa2caa0 --output <dir> --arms baseline --repeat 2 --concurrency 4 --paid --budget-run-id <id>
bun eval/runner/t0-program-primary.ts --gbrain <gbrain checkout>@7aa2caa0 --output <dir> --readers claude-sonnet-5-5 --arms mutant-forced-drop,mutant-stale-correction,ablation-push-off --paid --budget-run-id <id>
bun eval/runner/t0/parity.ts --gbrain <gbrain checkout>@7aa2caa0 --output <dir> --tasks p20261008-t1,p20261009-t1,p20261010-t1,p20261011-t1,p20261012-t1,p20261013-t1,p20261014-t1,p20261015-t1 --paid --budget-run-id <id>   # needs `claude` 2.1.285 on PATH
bun eval/runner/t0/analyze.ts <dir>/results.jsonl

# PW validation ($0, about 90 s)
bun eval/runner/power/validate.ts --sims 2000
```

Code identities: gbrain `7aa2caa0aa2a9f031730cd351cd516cf4f9f5802` (v0.60.106.0, tree `217fa377`), copied into a
verified overlay. `package.json` pins v0.60.104.0, which this run did not load. The gbrain-evals runner commits are
on branch `capy/t0-program-primary`: preregistration `1e5caf3`, amendment 1 `76910b7`, amendment 2 `0dcf723`. Runs
used Bun 1.4.2. The world digest is `f7e082a3`.

Receipts are in [`2026-10-08-program-primary/`](2026-10-08-program-primary/). `baseline/results.jsonl.gz` holds
every cell: deliverables, hook outputs, tool calls and both scorer versions. `baseline/usage.jsonl.gz` holds every
model call in `usage-receipt/v1`. `baseline/receipt.json` has the summary and the registry metrics. The directory
also has `parity/`, `smoke/` (the 3-cell setup smoke), `hermetic/`, `scorer-audit.json` and `power.json`.

| Ledger spend | Dollars |
|---|---:|
| Setup smoke (3 cells) | 0.81 |
| Baseline, 192 cells | 40.63 |
| Mutants, 64 cells | 11.34 |
| Push-off ablation, 32 cells | 5.38 |
| Native parity slice, 8 tasks | 1.77 |
| Brain builds (embeddings) and unattributed requests | 1.09 |
| **Total, budget ledger** | **61.02** |

The registry entry `program-primary` (legacy alias `T0`) gates whether a run counts. Its preregistered rules pass on
this run: both mutants are detected and 100% of cells were scored.
