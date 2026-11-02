# SkillOpt method benchmark: frontier probe and test-split read, November 2, 2026

Measured on gbrain v0.60.542.0 (`ca1281a2`) with the runner at gbrain-evals `13ae2442` (probe code) and `d4ac793b` (preregistration amendment 3). The targets are `claude-opus-5-5` and `gpt-6.1-sol`, and `claude-opus-5-5` proposed every rewrite. Run and written up in thread GBEV-24 (issue GST-799). [Preregistration](PREREGISTRATION.md): amendment 2 covers the probe and amendment 3 covers the test read, and each was pushed before the calls it covers. [Probe results](probe/frontier/README.md).

## The finding

One rewrite of gbrain's shipped skills, written from 24 training tasks, scored 1.00 on held-out test tasks for all six pairs of skill and frontier model. Each skill was `query`, `briefing` or `fact-check`, and each model was Claude Opus 5.5 or GPT-6.1 Sol. The shipped skill scored 0.47 to 0.78. Each rewrite beat its shipped skill by 0.22 to 0.53, with no task lost, and every comparison survives a Holm correction across the twelve tests. Since one rewrite already reaches the tasks' ceiling, a skill optimizer has nothing left to show on these tasks. The counted optimizer benchmark was therefore not run. Under Garry's null-result rule (R48), the benchmark as designed is a **CUT-CANDIDATE**, and gbrain's SkillOpt loop keeps the CUT-CANDIDATE from the [November 1 re-baseline](../2026-11-01-skillopt-rebaseline/REPORT.md) (preregistered rule 3). gbrain v0.60.542.0 already makes one gated rewrite its default (E1), and this result supports that.

The gain is almost all output form, not better retrieval or reasoning. On the training tasks, the shipped skill's failures were 24 citation checks, 18 `STATUS:` checks and 9 abstention checks, against one wrong value. The rewrites were written from the shared criteria text and the failed check kinds, and they made the skill's own output contract stick: the citation form, one `STATUS:` line, and an abstention that names what is missing.

The shipped skills still help. With the skill, answers beat no skill on five of the six pairs (KEEP). The exception is `query` on GPT-6.1 Sol, where no skill scored 0.86 and the shipped skill 0.72 (CUT-CANDIDATE). The whole loss is on multi-hop questions, where the shipped skill led Sol to cite a different page than the one that holds the answer.

One more finding is for gbrain itself. On GPT-6.1 Sol, all 607 `get_page` calls in the probe's training runs failed. Sol fills every optional `get_page` argument with an empty or default-looking value (`known_as_of: ""`, `cursor: ""`, `section: ""`, `grep: ""`), and gbrain rejects each one. A keyless reproduction against the rollout's own tool registry gives the errors word for word. Sol answered from search snippets instead. Opus 5.5 lost 5 of 127 calls.

## The concrete case

`fact-check` asks for a verdict on a claim a gbrain pipeline produced, for example "Vera Chen founded Mosaic - Consumer Social Startup." Its shipped SKILL.md describes a six-level confidence status. The scorer counts an answer only when one `STATUS:` line gives the status the brain evidence supports. With the shipped skill, Sol failed 13 of the 24 training tasks, every one on the `STATUS:` check: no status line, or one the evidence does not support. Every `get_page` call Sol made had failed, and it hedged. The rewrite says to give exactly one `STATUS:` line for the claim as a whole, never to put STATUS on per-part lines, and that tool errors are not evidence. On the 36 test tasks, Sol went from 0.53 to 1.00, and every compound and founder claim the shipped skill missed was now right.

## Results on the sealed test split

36 test tasks per skill. Each arm ran no skill once per task, the shipped skill (seed) 3 times, and the kept rewrite 3 times, and the score is the mean over tasks of the median of runs. Intervals are 95% task-level bootstrap intervals (10,000 resamples). "Wins / losses" counts tasks, with an exact McNemar p. Cost per correct answer is metered USD at list price over correct rollouts. Opus `briefing` scored Sol's kept rewrite, because the leak audit rejected both of Opus's own (amendment 3).

| Target | Skill | No skill | Seed | Rewrite | Seed − no skill | Verdict | Rewrite − seed | Verdict | $ per correct: seed / rewrite |
|---|---|---|---|---|---|---|---|---|---|
| Opus 5.5 | `query` | 0.28 | 0.75 | **1.00** | +0.47 [0.31, 0.64], 17 / 0, p 1.5e-5 | KEEP | +0.25 [0.11, 0.39], 9 / 0, p 0.0039 | rewrite beats seed | $0.16 / $0.10 |
| Opus 5.5 | `briefing` | 0.17 | 0.47 | **1.00** | +0.31 [0.17, 0.44], 11 / 0, p 0.00098 | KEEP | +0.53 [0.36, 0.69], 19 / 0, p 3.8e-6 | rewrite beats seed | $0.74 / $0.10 |
| Opus 5.5 | `fact-check` | 0.00 | 0.78 | **1.00** | +0.78 [0.64, 0.92], 28 / 0, p 7.5e-9 | KEEP | +0.22 [0.08, 0.36], 8 / 0, p 0.0078 | rewrite beats seed | $0.23 / $0.13 |
| GPT-6.1 Sol | `query` | 0.86 | 0.72 | **1.00** | −0.14 [−0.28, 0.00], 1 / 6, p 0.13 | **CUT-CANDIDATE** | +0.28 [0.14, 0.42], 10 / 0, p 0.0020 | rewrite beats seed | $0.033 / $0.026 |
| GPT-6.1 Sol | `briefing` | 0.17 | 0.58 | **1.00** | +0.42 [0.17, 0.64], 20 / 5, p 0.0041 | KEEP | +0.42 [0.25, 0.58], 15 / 0, p 6.1e-5 | rewrite beats seed | $0.16 / $0.034 |
| GPT-6.1 Sol | `fact-check` | 0.00 | 0.53 | **1.00** | +0.53 [0.36, 0.69], 19 / 0, p 3.8e-6 | KEEP | +0.47 [0.31, 0.64], 17 / 0, p 1.5e-5 | rewrite beats seed | $0.18 / $0.036 |

Holm-adjusted across all twelve comparisons, every KEEP and every rewrite-beats-seed stays below 0.02. The Sol `query` CUT-CANDIDATE follows its preregistered rule (a point difference of 0 or below) and makes no significance claim (Holm p 0.12). The test split agrees with selection (the [probe](probe/frontier/README.md)) on every pair: every clean rewrite was at 0.92 or 1.00 on selection.

**Where the shipped skill misses**, as tasks right per family on test (no skill / seed / rewrite):

| Target | Skill | Family results |
|---|---|---|
| Opus 5.5 | `query` | multi-hop 0 / 2 / 11 of 11; superseded, record pair and negative all at the ceiling with the seed |
| GPT-6.1 Sol | `query` | multi-hop 6 / 1 / 11 of 11; every other family at the ceiling even with no skill |
| Opus 5.5 | `briefing` | two meetings 0 / 3 / 20 of 20; with an absent subject 0 / 8 / 10 of 10; negative 6 / 6 / 6 |
| GPT-6.1 Sol | `briefing` | two meetings 0 / 20 / 20 of 20; with an absent subject 0 / 0 / 10 of 10; negative 6 / 1 / 6 |
| Opus 5.5 | `fact-check` | compound and founder claims 0 / 9 / 14 of 14; superseded, not-founder and negative 0 / 19 / 22 of 22 |
| GPT-6.1 Sol | `fact-check` | compound and founder claims 0 / 0 / 14 of 14; superseded, not-founder and negative 0 / 19 / 22 of 22 |

## Why null? (R48)

**The optimizer benchmark (CUT-CANDIDATE).**
- **Exposure:** the seeds ran as system prompts with every declared tool served, `recall` and `get_timeline` included. 7 of the 12 proposed rewrites passed the audit, and those 7 were scored.
- **Task fit:** the tasks follow each skill's own output contract and come from templated families. A rewrite that learns a family's procedure and the scorer's contract carries across the whole family.
- **Power and saturation:** saturated. Every kept rewrite sits at the 1.00 ceiling on both splits, so no optimizer arm could score higher.
- **Frontier model:** the shipped skills matter on these tasks for both models (KEEP on 5 of 6), so there was something to optimize, and one rewrite took all of it.

This says nothing about tasks where one rewrite falls short. Building those would be a new study.

**The shipped `query` skill on GPT-6.1 Sol (CUT-CANDIDATE).**
- **Exposure:** the skill was the system prompt for every rollout.
- **Task fit:** a multi-hop question such as "Who founded the company that Adam Lopez works with?" counts only when it cites the founder's own page. The shipped skill misses it on both models (Opus 2 of 11, Sol 1 of 11). With no skill, Sol got 6.
- **Power:** 7 discordant tasks, not significant (p 0.13), but the point difference is negative, and that is the preregistered CUT-CANDIDATE rule.
- **Frontier model without the skill:** Sol with no skill is at the ceiling on every other `query` family.

On these tasks, the shipped `query` skill costs Sol accuracy and adds nothing. The rewrite fixes it (1.00).

**Sol's `get_page` errors** lower every Sol arm equally and change no verdict above. They do mean Sol's numbers come from a rollout where one core read tool never worked.

## What this changes

- **For gbrain:**
  - The rewrites are in [probe/frontier/](probe/frontier/README.md) (`f0b-*/one-shot/*-rewrite-*.txt`, with the kept ones named in each test receipt). Their output-contract sections are candidates for the shipped `query`, `briefing` and `fact-check` skills. They were tuned against this benchmark's criteria text, so review them before adopting any; they are not ready to ship as they are.
  - `get_page` should treat empty optional arguments as absent, or the tool schema should stop GPT callers filling them.
  - E1's one-shot default stands.
- **For this benchmark:** the rollout server, the outside optimizer arms (GEPA, Microsoft SkillOpt, `best_of_n`) and both gbrain loop arms did not run. That includes gbrain at the pin on the B1.7 tag `732ef509` and gbrain from the wave. particle-1 did not run either, because the pin's gateway has no Particle recipe.

## Spend

Metered by the budget ledger at list price from the providers' usage fields:
- frontier probe: $145.04;
- test read: $163.06, against a $220 cap and a $191 estimate;
- earlier Haiku probes: $28.73.

The program total is $336.83, inside the approved $1,000.

## Disclosures

gbrain is Garry Tan's own project.

Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator. Garry Tan runs Y Combinator.
