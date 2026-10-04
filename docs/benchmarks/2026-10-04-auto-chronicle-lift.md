# Automatic event extraction, off versus on: it finds the meetings and helps with "who did I meet that day", but it records plans as if they happened (2026-10-04)

## The finding

We tested gbrain v0.60.46.0 (`739e5cc`) with `auto_chronicle`, its automatic event extraction, off and on, on a fixed fictional work week it was never tuned on. Under the decision rule we froze before the run, **default-on is contradicted**: the feature fails gbrain's own accuracy gate on this world, in both independent runs.

The failure is narrow and fixable, and the feature does useful work:

- **It finds what happened.** Recall of 38 hand-labeled events was 35 and 37 (92% and 97%); every calendar invite and almost every meeting and decision was found. It never touched a page it should not read (0 of 96).
- **It also records what has not happened.** Every meeting note lists follow-ups with dates ("send the deck by April 21", "board meeting in Austin on May 15"). The extractor wrote 22 and 25 of these as timeline events on their future dates, close to three per meeting. Counting 5 and 2 past events put on days the notes do not support, that is 27 wrong events per run on 28 judged pages (0.96 per page). gbrain's gate allows 0.20. gbrain already knows this pattern (its TODOS: "Drop future-dated events extracted from past pages"); on this corpus it is the main behavior, not an edge case.
- **An agent did better with the events, but not decisively.** On 36 temporal questions, a Claude Sonnet 4.6 agent over gbrain's MCP server answered 94.4% with extraction off and 100% with it on. Both differences were "who did Amara meet on day X" questions, which the agent answered from `chronicle_day` instead of piecing pages together. The paired 95% interval is 0 to +13.9 points: every difference favors on, but the interval touches zero.
- **The wrong events did not fool this agent**, because it knew today's date: asked when a planned event happened, it answered UNKNOWN 16 of 16 times in each arm. An agent asking after those dates pass has no such check.

The cost was $0.57 for 48 pages per run, $0.0118 per page, four times gbrain's fixture, because each page produced about eight events.

**What would change the call.** None of the 47 events dated after their page's date on the labeled pages (22 and 25) was something the page says happened. A rule that drops events dated after the page's own date, which is gbrain's proposed fix, would have left 5 and 2 wrong events (0.18 and 0.07 per page), inside the gate, without losing a matched event. That is an after-the-fact reading of these receipts, not a preregistered result; the fix needs its own measured run.

## What one of these looks like

Here is a slice of a real page from the corpus, a meeting note dated April 18, 2026:

> Amara takes the Helios board seat effective May 1st ... She'll plan to attend the May 15th board meeting in person in Austin.
>
> - [ ] Amara to complete board onboarding paperwork by April 25th

From that page, both runs wrote these timeline events, among others:

| Event day | Event summary (run ON-B) | Our label |
|---|---|---|
| 2026-04-17 | Helios Energy board formally approved the new director appointment at their meeting | matched ("approved at yesterday's meeting") |
| 2026-04-18 | Kofi and Amara met to discuss the Helios Energy investment and upcoming board seat transition | matched (the meeting) |
| 2026-04-25 | Amara to complete Helios Energy board onboarding paperwork | premature |
| 2026-05-01 | Amara takes the Helios Energy board seat effective May 1st, replacing the outgoing independent director | premature |
| 2026-05-15 | Amara to attend the Helios Energy board meeting in person in Austin | premature |

A later `gbrain day 2026-05-15` returns the Austin board meeting as something that happened that day. Nothing in the brain says it did.

## Background

[gbrain](https://github.com/garrytan/gbrain) is a memory system for agents: it stores notes as Markdown and builds a database index for search and relationships. Since v0.60.45.0 ([#5993](https://github.com/garrytan/gbrain/pull/5993)), saving a meeting, conversation or calendar page queues it for a `chronicle` cycle phase that sends the page once to the configured chat model and writes the events it returns as timeline event pages. `chronicle_day`, `chronicle_since`, `chronicle_last_seen` and search can then return them. Each page costs one chat call, capped at $0.25, with at most 200 automatic calls a day; `gbrain config set auto_chronicle false` turns it off.

gbrain's release notes say the default flipped without a measured quality lift. Their own run, on 31 pages written for the feature, found 85% to 87% of 53 labeled events, with 4 wrong or premature events on 24 judged pages (16.7%) per run. This experiment repeats that measurement on a world nobody wrote for the feature, and adds the comparison they did not run: the same agent, the same questions, extraction off and on.

## The experiment and results

### Design

Everything below was frozen in [the preregistration](2026-10-04-auto-chronicle-lift-preregistration.md) before any run with extraction on.

**Corpus.** [amara-life-v1](../../eval/data/amara-life-v1/), a committed, fictional week (April 13 to 19, 2026) in the life of a venture partner, generated in April for BrainBench and not regenerated: 8 meeting notes, 20 calendar invites, 300 Slack messages (rendered as 20 channel-day conversation pages), 50 emails, 40 journal notes and 6 documents. 144 pages; 48 are meeting, conversation or calendar pages, and 96 must never be judged.

**Labels.** 38 expected events on the 28 meeting and calendar pages: each meeting itself, each decision under a Decisions heading, and one past event dated by the text ("yesterday's meeting"). Commitments made at a meeting are not required but count as correct when dated the meeting day. An extracted event matches when its day equals the expected day and its summary contains a keyword. The labels and the 36 questions were written by the agent running the experiment (Capy) from the page text, before any run; no person reviewed them. Slack pages are judged but unlabeled.

**Arms.** OFF (`auto_chronicle false`) and two independent ON brains (ON-A, ON-B), all built the same way with gbrain `739e5cc`: `gbrain init --no-embedding`, `gbrain import`, then `gbrain dream --phase chronicle` until nothing was left. The judge was gbrain's default chat model, `anthropic:claude-sonnet-4-6`. Two settings apply to every arm: `chronicle.auto_recent_days 365`, because the corpus is about 170 days old and the default of 30 would skip every page as history, and `chronicle.auto_settle_seconds 0`, so the phase runs right after import. With these settings, extracting from a page dated April 18 behaves as it would have on April 18, so "dated after the page" means "in the future when extracted".

**Questions.** 36, scored without a judge model: 5 "who did Amara meet on day X" lists, 8 meeting dates, 6 "when did Amara last meet X", 6 decisions, 8 traps about planned events (the right answer is UNKNOWN) and 3 Slack post dates. The agent was `claude-sonnet-4-6` in the Cat 40 agent loop, at most 12 turns, told today is 2026-04-19, connected to `gbrain serve` (default tool list, no provider key, so keyword search only). Each question ran twice against OFF and twice against ON-A.

### Extraction

| | ON-A | ON-B |
|---|---|---|
| Pages judged (of 48) | 48 | 48 |
| Control pages judged (of 96) | 0 | 0 |
| Events written | 380 | 381 |
| Events per judged page: meetings / invites / Slack | 8.3 / 1.0 / 14.7 | 8.3 / 1.0 / 14.8 |
| **Recall of labeled events** (of 38) | **35 (92.1%)** | **37 (97.4%)** |
| Meetings (of 18) / invites (of 20) | 15 / 20 | 17 / 20 |
| Events on the 28 labeled pages | 86 | 86 |
| Premature: dated after the page's own date | 22 | 25 |
| False: dated on or before the page, not supported on that day | 5 | 2 |
| Duplicates | 0 | 0 |
| Correct but not required (commitments, statements) | 24 | 22 |
| **False + premature per judged labeled page** (gate: 0.20 or less) | **0.96** | **0.96** |
| False + premature as a share of events on those pages | 31.4% | 31.4% |
| Slack: premature events (of 294 and 295) | 17 | 22 |
| Slack: false events in a review sample of 25 | 0 | 2 |
| Cost (metered, budget ledger prices) | $0.5656 | $0.5677 |
| Cost per judged page (gate: $0.25 or less) | $0.0118 | $0.0118 |
| Phase wall time, 48 pages | 415 s | 411 s |

The premature events were mostly commitments (13 and 14), scheduled meetings (4 and 5) and milestones such as "takes the board seat effective May 1st". The latest was dated September 1, for "Threshold Robotics plans to kick off the Series B" in a page from April 15. The false events follow one pattern: a vague past date became a specific day. "Back in 2024" became January 1, 2024, "last month" became March 1, and a quarter's revenue result was put on the day of the meeting that discussed it (run A only, twice). Each unmatched event and its classification is in [`review.json`](2026-10-04-auto-chronicle-lift/review.json); the matched pairs come from `chronicle-lift.ts score`.

Our keyword matching is as lenient as gbrain's: a meeting's expected event can be matched by a commitment that names the same person. Reading every matched pair by hand, the meeting itself was also extracted on every meeting page, so the recall figures do not depend on that leniency.

### The agent's questions

| Question type | Questions | OFF | ON-A |
|---|---|---|---|
| Who did Amara meet on day X | 5 | 60% | **100%** |
| On what date was this meeting | 8 | 100% | 100% |
| When did Amara last meet X | 6 | 100% | 100% |
| What was decided | 6 | 100% | 100% |
| Planned event traps (answer: UNKNOWN) | 8 | 100% | 100% |
| Slack post dates | 3 | 100% | 100% |
| **All** (each question's score is the mean of 2 runs) | **36** | **94.4%** | **100%** |

The paired difference is +5.6 points, with a bootstrap 95% interval of 0.0 to +13.9 points. Both differing questions failed in both OFF runs: April 14 (the agent listed 2 of the 4 people) and April 18 (it missed the meeting with Kofi, which has notes but no invite). In both arms the agent called `chronicle_day` first; with extraction off it returned nothing and the agent fell back to search and `list_pages`.

The traps passed in both arms because the agent compared each planned date with "today is 2026-04-19" and the open checkboxes in the notes ("the task checkbox remains unchecked"). It read the false May 15 event and still answered UNKNOWN. These questions show that the wrong events did not mislead an agent that knows the date is before them; they do not show what happens once the date has passed.

Agent runs cost $15.23 for 144 runs (OFF $7.79, ON-A $7.44), about $0.11 each; the day lists cost the most because the agent opened many pages.

### The decision

| Rule | ON-A | ON-B |
|---|---|---|
| A. Recall at least 60% and false + premature at most 0.20 per judged labeled page | recall passes, **0.96 fails** | recall passes, **0.96 fails** |
| B. No control page judged | passes | passes |
| C. Cost per judged page at most $0.25 | passes | passes |
| D. Paired 95% interval for ON minus OFF accuracy | 0.0 to +13.9 points: touches zero | not run (preregistered) |

A fails on both ON brains, so under the preregistered rule **default-on is contradicted**. D on its own would have read "not supported by a measured lift": the direction favors extraction but the interval is not above zero. ([`summary.json`](2026-10-04-auto-chronicle-lift/summary.json))

## What to use and what to avoid

- **Turn it off for now if your meeting notes list dated follow-ups** (`gbrain config set auto_chronicle false`), or if anything downstream treats `gbrain day` results as fact. On these meeting notes and invites, 27 of the 86 events it wrote per run (31%) were plans or misdated facts; on the Slack pages far fewer were (17 and 22 premature of about 295).
- **Turn it on if you ask "what did I do that day" or "when did I last see this person"** and can live with that error rate, or once gbrain drops events dated after their page. Day questions went from 60% to 100% here, and recall is high.
- **For gbrain:** the measurement supports the P2 item already in gbrain's TODOS, and argues for the page's own date as the cutoff rather than the extraction time. A backfill of last year's notes today would keep "May 15" events under an extraction-time rule. Telling the judge to emit only what already happened, and to leave out events whose day the text does not give, addresses the false events. Calendar invites would not need a model call at all (all 20 were extracted correctly, one event each).
- **Limits.** One synthetic week of one person's work, 28 labeled pages and one agent model. The labels and questions were written by the agent that ran the experiment and not reviewed by a person. Search was keyword-only in both arms. The questions were answerable from the pages in most cases, so they leave little room for a lift; a harder question set, or an agent without "today" in its prompt, could move D either way. The Slack review is a sample of 25 events per run.

## Reproduce and inspect

From the repository root, with Bun 1.4.2, gbrain `739e5cc` installed, and `ANTHROPIC_API_KEY` set. The output directory must be outside this repository: `gbrain init` refuses to create its content directory inside another Git worktree.

```bash
bun eval/runner/chronicle-lift.ts corpus --out ~/lift-corpus                                       # render the 144 pages, $0
bun eval/runner/chronicle-lift.ts run --out ~/lift --budget-usd 20                                 # 3 brains + 144 agent runs: about 45 min, $16.36 here
bun eval/runner/chronicle-lift.ts score --out ~/lift --review docs/benchmarks/2026-10-04-auto-chronicle-lift/review.json
bun eval/runner/chronicle-lift.ts run --out ~/lift-x --arms on-a --no-qa --budget-usd 2            # one ON brain only, about $0.57
bun test eval/runner/chronicle-lift.test.ts                                                        # scorer tests, $0
```

**Receipts** ([`2026-10-04-auto-chronicle-lift/`](2026-10-04-auto-chronicle-lift/)): `build-*.json` (every step, the phase summaries, metered cost by model), `events-on-a.json` and `events-on-b.json` (every event page), `ledger-*.json` (gbrain's per-page `chronicle_page_state` rows, including the 48 `auto_chronicle_off` skips in OFF), `qa-results.jsonl` (every agent run with its answer and tool calls), `review.json`, `scores.json` and `summary.json`.

**How the run went.** The first counted attempt stopped at OFF's `gbrain init`, before any paid call, because its output directory was inside this repository ([receipt](2026-10-04-auto-chronicle-lift/receipt-attempt-1-stopped-at-init.json)). The second built all three brains and finished 5 agent runs; we stopped it by hand once agent runs were costing $0.18 to $0.40 against a $0.04 to $0.10 estimate, because with the old code a refused budget reservation in one arm would have let the other keep calling the model after the guard was removed (fixed in `2181c9a`). It resumed on the same brains, joined to the same budget-ledger run, and finished the other 139 runs. No finished run was repeated. Receipts from the second attempt's builds have no top-level receipt (the stop came before it was written); the builds' own records and the ledger cover them. Code: `785203b` for the builds and the first 5 agent runs; `af77f2c` (runner as of `2181c9a`, with this report's draft uncommitted) for the rest.

**Cost.** Budget-ledger run `chronicle-lift-v1-2026-10-04T15-19-48-589Z-01aba458`: $17.16 committed, of which $1.13 was extraction, $15.37 agent runs, and $0.66 reservations left unsettled when the run was stopped (counted, though Anthropic may not have billed them in full). Before the preregistration: a $0.19 cost pilot on the OFF brain and a $0.004 smoke on one invented page. Total: $17.35.
