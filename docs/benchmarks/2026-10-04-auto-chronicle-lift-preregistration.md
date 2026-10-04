# Preregistration: does automatic event extraction help? `auto_chronicle` off versus on (2026-10-04)

Frozen on October 4, 2026, in its own commit, before any run with `auto_chronicle` on against the corpus below. Nothing here changes after a run; a later change gets a new dated file.

## The question

gbrain v0.60.45.0 ([#5993](https://github.com/garrytan/gbrain/pull/5993)) turned `auto_chronicle` on by default. When a meeting, conversation or calendar page is saved, a `chronicle` cycle phase sends it once to the configured chat model and writes what happened (the meeting, decisions, commitments) as timeline event pages, which `chronicle_day`, `chronicle_since`, `chronicle_last_seen` and search can then return. Each page costs one chat call, capped at $0.25, with at most 200 automatic calls a day.

gbrain's release notes say plainly that the default flipped without a measured quality lift. Their own measurement was extraction accuracy on a labeled fixture of 31 pages written for the feature (24 that should be judged, 53 hand-labeled events), with `anthropic:claude-sonnet-4-6`: recall 46 of 53 (87%) and 45 of 53 (85%) in two runs, 4 wrong or not-yet-happened events per run (16.7% of 24 judged pages), 1 duplicate per run, $0.068 per run, and no controls judged. Their gate was recall at least 60% and false plus premature events at most 20% of judged pages. The wrong events came from two patterns, now a P2 item in gbrain's TODOS ("Drop future-dated events extracted from past pages"): a future date mentioned in a past meeting written as an event, and a plan in a chat written as if it happened. Nobody compared an agent with these events against one without them.

This experiment asks three things on a world gbrain's extractor was not written against:

1. Are the extracted events accurate: how many labeled events are found, and how many are wrong or premature?
2. What does it cost per page, and does it stay off pages it should not read?
3. Does an agent answer temporal questions better with the events than without them?

Per the eval-driven defaults practice, default-on is supported only when the feature measurably helps.

## The corpus

**amara-life-v1** (`eval/data/amara-life-v1/`, generated 2026-04-19 with seed 42, committed and not regenerated). It is one fictional week, April 13 to 19, 2026, in the work life of a venture partner: 8 meeting notes, 20 calendar invites, 300 Slack messages in four channels, 50 emails, 40 dated journal notes and 6 documents.

Why this world:

- It is fixed, committed and dated, and it was written for BrainBench months before `auto_chronicle` existed, by a different generator than gbrain's fixture. Nothing in it was tuned against the extractor.
- It has all three page kinds the feature reads, plus many it must not read.
- Its meeting notes are full of planned follow-ups with dates after the meeting (a board meeting on May 15, a board seat effective May 1, decks due April 21 and April 25), which is exactly the premature-event pattern gbrain found. Its Slack chatter is dense with statements of intent ("will share by EOD tomorrow"), which tests false events.

Worlds considered and rejected: N3's world (its meeting bodies are placeholder text and its events come from a scripted judge, so extraction cannot be measured); transcript-distill-v1 (single-person reflections with few dated events, in a different world); world-v1 and model-ladder-v1 (entity and company documents, almost no meeting-shaped pages).

**Rendering** (`renderCorpus` in `eval/runner/chronicle-lift.ts`, digest `1f7df155a5776e498d5439f67cb8dbe1785dc32479ab58c684340af368508625`): meeting notes as they are (`meetings/`); each calendar invite as a `calendar-event` page under `cal/` with its start, end and attendees; Slack as one `conversation` page per channel per UTC day under `conversations/` (20 pages); emails, notes and documents as ordinary pages. 144 pages, of which 48 are meeting, conversation or calendar pages and 96 are controls that must never be judged.

**Labels** (`eval/data/chronicle-lift-v1/gold-events.json`): 38 expected events on the 28 meeting and calendar pages (18 on the 8 meetings, one per invite). They were written by the agent running this experiment (Capy) from the page text, before any run, and no person reviewed them. The rules: the meeting itself on the page's date; each bullet under a Decisions heading, dated the page's date; a past occurrence the page dates to a day ("approved at yesterday's meeting"). Action items and statements made at a meeting are not required, but they are not wrong when dated the meeting day. Anything dated after the page's date is never expected. An extracted event matches when its day (UTC, gbrain's default `chronicle.tz`) equals the expected day and its summary contains one of the expected event's keywords; matching is a maximum matching per page. The 20 Slack pages are judged by the feature but not labeled: their messages are too dense with small occurrences for a recall denominator to mean anything.

## The arms

All arms use the installed gbrain `739e5cc` (v0.60.46.0), Bun 1.4.2, and the same steps (`eval/runner/chronicle-lift.ts run`):

1. `gbrain init --pglite --non-interactive --no-embedding`;
2. `gbrain config set chronicle.auto_recent_days 365` and `chronicle.auto_settle_seconds 0`;
3. **OFF only:** `gbrain config set auto_chronicle false`;
4. `gbrain import <vault> --no-embed`;
5. `gbrain dream --phase chronicle --json`, repeated until a run judges nothing (at most 12 runs).

**OFF** is one brain. **ON-A** and **ON-B** are two independent brains with the default (`auto_chronicle` unset, which means on), so run-to-run variation is visible. The judge is gbrain's default chat model, reached with only an Anthropic key, through a local proxy that meters every call into the budget ledger. gbrain's judge has no seed; the pairing is the same corpus, code, settings and questions in every arm.

Two settings depart from a fresh install, and both apply to every arm. `chronicle.auto_recent_days` defaults to 30: the corpus is dated about 170 days before the run, so with the default every page is skipped as `history` and the ON arm would equal OFF. `chronicle.auto_settle_seconds` defaults to 180 seconds; 0 lets the phase run straight after the import instead of waiting. Neither changes what the judge sees. No embedding key is configured in any arm, so search is keyword-only.

## Metrics

On each ON brain:

1. **Event recall**: matched expected events out of 38, and by class (18 meeting, 20 calendar).
2. **False or premature events** on the 28 labeled pages. Every extracted event left unmatched is classified. *Premature*: its day is after its page's date (mechanical). Otherwise it is hand-reviewed against its page: *duplicate* (another event from the same page already records that occurrence on that day), *supported* (the page says it happened, was decided, said or committed on that day), or *false* (the page does not support it happening on that day: a plan written as done, a past occurrence put on the wrong day, or an invention). The headline rate uses gbrain's denominator: (false + premature) divided by the 28 judged labeled pages. The share of all events written on those pages is reported beside it.
3. **Conversation pages**: events written on the 20 Slack pages, events per page and mechanical premature events (day after the channel-day). False events on these pages are hand-reviewed on a sample of 25 non-premature events per ON brain (the events sorted by slug, then drawn with Mulberry32 seed 4); reported, not gated.
4. **Events per judged page** and **cost per judged page**, both from the metered proxy (the budget ledger's prices) and from gbrain's own recorded `spent_usd`, with the model that was called.
5. **Controls judged**: `chronicle_page_state` rows for any of the 96 non-chronicle pages. Must be 0.

Against OFF and ON-A:

6. **Temporal question accuracy** (`eval/data/chronicle-lift-v1/questions.json`, 36 questions written from the corpus before any run, with deterministic scoring): 5 "who did Amara meet on day X" lists, 8 "on what date did this meeting happen", 6 "when did Amara last meet X as of April 18", 6 "what was decided", 8 premature traps ("on what date did X happen" where X is only planned, so the right answer is UNKNOWN) and 3 dates of Slack posts. The agent is `claude-sonnet-4-6` through the Cat 40 agent loop (`eval/runner/cat40/loop.ts`), at most 12 turns, told that today is 2026-04-19, connected to `gbrain serve` (stdio, the default full tool surface) with no provider key. Each question runs twice per arm, in the same order. A question's score is the mean of its two runs; the lift is mean ON minus mean OFF over the 36 questions, with a paired bootstrap 95% interval over questions (10,000 resamples, seed 20261004). A run that ends in a provider error or without an answer scores 0 and is reported; finished cells are never rerun.

## The decision rule

- **Gate A, accuracy** (each ON brain): recall of the 38 labeled events at least 60%, and false plus premature events at most 20% of the 28 judged labeled pages. These are gbrain's own thresholds, applied to a new world.
- **Gate B, scope**: 0 control pages judged on each ON brain.
- **Gate C, cost**: metered cost per judged page at most $0.25 (the per-page cap) on each ON brain.
- **D, the lift**: the paired 95% interval for ON minus OFF accuracy.

The verdict:

- **Default-on is supported** when A, B and C hold on both ON brains and D's interval lies above 0.
- **Default-on is not supported by a measured lift** when A, B and C hold on both ON brains and D's interval includes 0. Extraction is then accurate enough to be safe, but this run shows no gain for an agent.
- **Default-on is contradicted** when A or B fails on either ON brain, or D's interval lies below 0.

Reported but outside the rule: the premature-trap accuracy in each arm (whether wrong events mislead the agent), the per-type accuracies, the Slack sample, and run-to-run differences between ON-A and ON-B.

## Budget

Estimated spend is about $12 of the $25 the task authorizes: about $0.20 per ON brain for 48 judge calls (gbrain's fixture cost $0.0028 per page; a smoke on one invented page cost $0.0039), and about $0.04 to $0.10 per agent run for 144 runs. The agent figure comes from a cost pilot made before this commit: the OFF brain built from this corpus and two development questions that are not in the set (Latitude Summit city, CarbonLoop burn multiple), which cost $0.145 with a cold prompt cache and $0.042 with a warm one ($0.19 in total). The run opens one budget-ledger run capped at $20. If the cap stops the run, the result is reported as partial.

Before this commit, nothing ran with `auto_chronicle` on against this corpus: the only ON run was the smoke on one invented meeting page, used to check the phase path (it wrote three events, two of them dated after the meeting).
