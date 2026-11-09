# SkillOpt optimizer benchmark retired: frontier models saturate it

Measured on November 3, 2026 at gbrain v0.60.557.0 (`62637c96a`), with the runner at gbrain-evals `88d3b3f5`. Run in thread GBEV-30 (issue GST-1013). The rules are in the [SkillOpt ceiling preregistration](2026-11-02-skillopt-ceiling/PREREGISTRATION.md), whose dated amendments record gate 1's results and the retirement. The raw results are in [`runs/gate-1/`](2026-11-02-skillopt-ceiling/runs/gate-1/).

## The finding

gbrain ships skills: instruction files an agent loads for one kind of task. `query` answers a question from the brain, `briefing` writes notes for a day of meetings, and `fact-check` checks a claim a gbrain pipeline produced. gbrain's SkillOpt rewrites a skill from scored practice tasks, once (the one-shot rewrite) or over many steps (the iterative loop). An optimizer can only show a gain where the shipped skill leaves room, and our first task sets left none: one Opus 5.5 rewrite scored 1.00 on every pair of skill and model ([November 2 report](2026-11-01-skillopt-method/REPORT.md)). So we built a harder task set, v3, and ran a cheap headroom gate on it before building the optimizer comparison.

Claude Opus 5.5 solved v3 without any skill. On the 36 sealed gate tasks per skill, Opus with no skill answered all 36 `query` tasks and 35 of 36 `briefing` tasks. On the 18 of each set that come from held-out families, kinds of task no practice task shares, it answered every one. The shipped skills scored 1.000 on both, and so did every rewrite the gate scored (the leak audit had disqualified `briefing`'s rubric one-shot). An optimizer has nothing left to improve here, so Garry Tan retired the benchmark on November 3: "I guess we are just saturated and we should note saturation and consider the category retired".

The result rests on `query` and `briefing` on Opus 5.5. `fact-check` couldn't be read, because of a bug in our own harness, and GPT-6.1 Sol didn't run: the preregistered rule skips it once every Opus pair reads saturated.

Garry also decided, the same day, to retire gbrain's iterative SkillOpt loop ("Ok I guess we should just retire it from gbrain as well. But we should mark it as deprecated and remove it in a month"): gbrain#8525 adds the deprecation notice, removal is due on or after December 3, 2026, and this repository's Cats 30 to 33, which run the loop, are deleted after that release.

## The concrete case

A held-out `query` task asks: "Who founded the company that acquired the company Idris Aldana works with?" That is three hops on an invented brain. Idris Aldana's page names his employer, Varley Networks; Varley's page names the company that bought it, Lorvale Logistics; Lorvale's page names its founder. Planted on the way are names that answer a nearby question instead, such as Varley's own founder and the founder of Idris's previous employer.

With no skill, Opus made two tool calls. A keyword search for "Idris Aldana" returned his page and Varley's, and Opus then read Lorvale's page. Its answer began:

> Answer: Desmond Desai founded the company in question, Lorvale Logistics.

It went on to cite each page in the chain and to rule out the nearby founders by name. That is the procedure the shipped `query` skill teaches, so the skill had nothing to add.

## Results

Scores are the share of tasks answered right on substance: the value or verdict the brain supports, from the page that decides it, whatever the answer's layout. Each skill has 36 gate tasks, never shown to an optimizer, and 18 of them come from held-out families. The shipped skill is the seed. The rewrite column is the better of two Opus 5.5 one-shot rewrites on the 24 selection tasks, or the seed when neither beats it. "Told the pages" is a control in which the model is told which pages decide the answer. Cost per correct answer is metered USD at list price over correct gate rollouts.

| Model | Skill | No skill: 36 tasks / held-out 18 | Seed: 36 / held-out 18 | Rewrite kept | Told the pages | $ per correct, no skill / seed | Gate label |
|---|---|---|---|---|---|---|---|
| `claude-opus-5-5` | `query` | 1.000 / 1.000 | 1.000 / 1.000 | the seed, 1.000 | 1.000 | $0.078 / $0.058 | saturated |
| `claude-opus-5-5` | `briefing` | 0.972 / 1.000 | 1.000 / 1.000 | the seed, 1.000 | 0.972 | $0.23 / $0.26 | saturated |
| `claude-opus-5-5` | `fact-check` | 0.861 / 0.778 | 0.889 / 0.778 | the seed, 0.889 | 0.889 | $0.14 / $0.12 | invalid |
| `particle-1` | all three | not run: gbrain's gateway has no Particle route at this pin | | | | | |
| `gpt-6.1-sol` | all three | not run: skipped by the preregistered rule once every Opus pair read saturated | | | | | |

A pair is saturated when its kept rewrite scores above 0.80 or within 0.15 of the told-the-pages control; the gate needed two pairs with room, and it found none. No rewrite beat the seed on selection, where the seed already scored 1.000 on all three skills. The three rewrites from the November 2 report (#304) tie the seed too: +0 [0, 0], with 0 wins and 0 losses on each pair. That last read is preliminary by the preregistration, and its deciding read on the sealed test tasks will not run.

## Why this is saturation and not a broken test

Every null result here gets four checks before it is reported.

- **The scorer isn't passing negated wrong answers.** 191 answers that scored right had a negation within five words of the deciding value (`query` 14, `briefing` 29, `fact-check` 148), the shape a wrong answer such as "it was not Desmond Desai" would take. GPT-6.1 Sol, from a different model family than the Opus answers, judged each one as a Capy subagent working from a written brief ([`judge-brief.md`](2026-11-02-skillopt-ceiling/runs/gate-1/refusal-audit/judge-brief.md)). None was a wrong answer scored right.
- **The harness isn't limiting the model.** Opus made 4,756 tool calls over the gate stage's 1,068 rollouts and none was refused. No rollout hit the turn limit or the output limit, and on no pair does the told-the-pages control beat the shipped skill.
- **There is no room to measure.** Scores at 1.000 can't show a difference at any sample size.
- **The frontier model already does the job.** The shipped skill adds at most one task of 36 over no skill, on `briefing` and on `fact-check`.

So `query` and `briefing` read as a true ceiling on Opus 5.5. `fact-check` reads FIX-METHOD, for the reasons in the next section.

## Why `fact-check` can't be read

The gate's rule voids a pair when more than 10% of its no-skill or seed answers fail a form check. On `fact-check`, 22 of 36 no-skill answers (61%) did, and 17 of those 22 were right on substance. The contract asks for "a label of your skill's six-level scale", which a model with no skill can't know, so it wrote labels such as `CONTRADICTED`.

Every arm, the told-the-pages control included, also missed the same four `fact-check` tasks, all from the held-out three-hop family. In all 24 of those rollouts the answer names the person the answer key holds. Each fails the per-part status check: the answers check the claim's three links one by one and mark the true links verified or supported, and the answer key scores the claim as one contradicted part. So `fact-check`'s 0.861 and 0.778 come from a scoring mismatch on one family, not from room an optimizer could use. Whether a corrected contract and key would leave any room is not measured.

## What it cost

Gate 1 cost $133.87 over 3,304 requests, against its $470 cap: `query` $23.74, `briefing` $67.92 and `fact-check` $42.21, the rewrites included. Before it, calibration's train-only read cost $15.45, after a first calibration at an older gbrain ($27.95) was superseded. The program ledger closed at $177.27 of its $9,163 cap. With the $337 #304 spent, the SkillOpt program used $514.27 of the $9,500 Garry approved.

## What this does not show

- It does not show that skill optimization is useless on harder, real work. It measures this benchmark: a synthetic brain of short pages (173 to 309 words) searched by keyword, where Opus with no skill averaged 1.7 tool calls per `query` task. A real brain with long pages and messier records could leave room that v3 does not.
- It does not measure `fact-check` (above) or GPT-6.1 Sol. At calibration, on 12 practice tasks each, Sol scored 1.000, 1.000 and 0.917 with the shipped skills while gbrain's rollout path refused 52% of its `briefing` tool calls and 84% of its `fact-check` tool calls, and no retry after any of those 305 refusals succeeded. That is a separate harness problem in gbrain's rollout path, which this benchmark never resolved. Most of it was a gbrain bug, since fixed: see the addendum below.
- It does not measure particle-1, which gbrain's gateway can't call at this pin.
- It ran one gate where the preregistration allowed two. The preregistered path was one task revision, a second gate and then a read of the sealed test split before any cut. Garry's decision ends the study after gate 1, so this is his call on gate 1's evidence, not a preregistered verdict. The revision was built and never run, and the 96 test tasks per skill stay sealed.
- It never measured the iterative loop, whose arms would have run only after a gate pass, so it gives no evidence on the loop either way. The two earlier results that measured it, the [June 3 run](2026-06-03-skillopt.md) and the [November 1 re-baseline](2026-11-01-skillopt-rebaseline/REPORT.md), found the full loop tied a one-shot rewrite.

## Addendum (2026-11-04): most of Sol's `get_page` refusals were a gbrain bug, fixed in v0.60.570.0

Most of these refusals were gbrain rejecting a call shape it now accepts. Sol fills in every optional argument of `get_page`, so most of its page reads sent two or three window selectors (`lines` and `bytes`, often `around_chunk_id` too) beside `body: "full"`. gbrain v0.60.557.0, this benchmark's pin, refused any call with more than one selector (`invalid_params`). gbrain v0.60.570.0 ([gbrain#8509](https://github.com/garrytan/gbrain/pull/8509), `241cef5a`) reads one window instead. It applies the first usable selector in the order cursor, `around_chunk_id`, `lines`, `bytes`, and its `window_selector` field says which one applied and what it set aside.

A keyless replay sent every recorded Sol `get_page` call to the SkillOpt rollout registry at both gbrain builds, against the brain each run read. No model ran, so the replay shows what gbrain now does with the calls Sol made. It can't show whether Sol would answer differently.

| Recorded Sol `get_page` calls | Refused at v0.60.557.0 | Refused for sending two or three selectors | Of those, read at v0.60.570.0 | Still refused or failed at v0.60.570.0 |
|---|---|---|---|---|
| This benchmark's calibration (v3 brain) | 305 of 305 | 233 | 233: 221 `lines` windows, 12 `around_chunk_id` windows | 72: 61 sent `bytes: {offset: 0, length: 0}` beside `lines`, 8 a `section` and 3 a `grep` beside `lines` |
| The [frontier probe](2026-11-01-skillopt-method/REPORT.md#tool-errors-in-the-skillopt-rollout-path) (v2 brain) | 606 of 607 (one call's arguments aren't JSON) | 436 | 435: 285 `lines` windows, 150 `around_chunk_id` windows | 171: 169 `known_as_of` beside read-view arguments, 1 a `grep` beside `lines`, 1 `page_not_found` |

The one probe call refused for its selectors that doesn't read asks for `people/chris-davis-49`, a page that isn't in the brain. It now gets `page_not_found` instead of `invalid_params`. The other calls that still refuse break rules this fix didn't change. gbrain refuses `known_as_of` beside read-view arguments, and `section` or `grep` beside a window, on purpose. It rejects a zero-length `bytes` as a malformed selector even when a usable `lines` comes with it. These refusals come from the same habit of filling in every optional argument. Replayed as Sol sent them, 72 of the calibration's 305 (40 of 127 in `briefing`, 32 of 178 in `fact-check`) and 171 of the probe's 606 still fail. Only a live Sol rerun can show how many page reads Sol would lose, because its later calls depend on what its earlier ones returned.

Not every call that sent `around_chunk_id` reads that window. 89 of the probe's three-selector reads asked for `view: "markdown"`, which has no `around_chunk_id` window, so gbrain set it aside and read `lines`. The probe's committed input names the page as `[withheld]` in 128 of its `get_page` calls, because the one-shot proposer wasn't shown those pages, and 86 of them were refused for their selectors. Those calls replay against a stand-in page (`people/vera-chen-14`, the one the acceptance test uses), where 14 recorded chunk ids don't exist, so those reads fell through to `lines`.

Two controls back the replay. At v0.60.557.0 it reproduces the recorded outcome of all 305 calibration calls. Opus's 1,193 `get_page` calls in calibration and gate 1 read at both builds, and each returns the same result once revision ids and timestamps are masked. Gate 1 ran Opus only, so it has no Sol calls.

Reproduce, with no keys, in about 25 seconds per build:

```sh
R=docs/benchmarks/2026-11-02-skillopt-ceiling/runs/get-page-replay/replay.ts
bun $R before.json.gz                  # in a checkout with package.json pinning gbrain 62637c96a, after bun install
bun $R after.json.gz                   # in a checkout with package.json pinning gbrain 241cef5a, after bun install
bun $R --compare before.json.gz after.json.gz
```

The per-call outcomes at both builds and their comparison are in [`runs/get-page-replay/`](2026-11-02-skillopt-ceiling/runs/get-page-replay/). This repository pinned v0.60.557.0 when the replay ran. It now pins v0.60.623.0 (`d253ec0ff`), where the same replay gives every one of the 2,105 recorded calls the same outcome, and every read the same digest, as at `241cef5aa` (v0.60.570.0) ([`compare-570-623.json`](2026-11-02-skillopt-ceiling/runs/get-page-replay/compare-570-623.json)). The benchmark stays retired, and its stages keep their v0.60.557.0 pin.

## What changes in this repository

The registry marks the SkillOpt method benchmark (N15) retired and Cats 30 to 33 deprecated, with the removal date. N15's keyless check keeps running in CI, because it guards the frozen task sets behind the published results. Cats 30 to 33 and their tests stay until gbrain's removal release reaches the pin, then go in one change. No new result is published from either.

## Reproduce and inspect

These commands need no keys and run from the repository root:

```sh
# Held-out-family scores from the gate receipt and the task files
python3 docs/benchmarks/2026-11-02-skillopt-ceiling/runs/gate-1/held_out_families.py

# The refusal audit's flagged answers and the judge's input, rebuilt from the rollout rows
D=$(mktemp -d) && gunzip -c docs/benchmarks/2026-11-02-skillopt-ceiling/runs/gate-1/rows.jsonl.gz > "$D/rows.jsonl"
bun docs/benchmarks/2026-11-02-skillopt-ceiling/runs/gate-1/refusal-audit/flag.ts "$D"
bun docs/benchmarks/2026-11-02-skillopt-ceiling/runs/gate-1/refusal-audit/prep.ts "$D" "$D/input.jsonl"
```

The first prints each arm's score on all 36 gate tasks and on the 18 held-out ones; the second and third rebuild [`flagged.json`](2026-11-02-skillopt-ceiling/runs/gate-1/refusal-audit/flagged.json) and the judge's input byte for byte. The judge's verdicts, one reason per answer, are in [`judged.jsonl`](2026-11-02-skillopt-ceiling/runs/gate-1/refusal-audit/judged.jsonl), and its brief in [`judge-brief.md`](2026-11-02-skillopt-ceiling/runs/gate-1/refusal-audit/judge-brief.md). The judging step itself can't be rerun keylessly.

- Receipt: [`runs/gate-1/receipt.json`](2026-11-02-skillopt-ceiling/runs/gate-1/receipt.json): gbrain pin `62637c96a`, dataset `skillopt-method-v3` (MANIFEST `5729db40…a615`), the per-task results of every arm, tool calls, refusals and stop reasons per arm, metered cost per arm and pair, and the gate verdict.
- Rollouts: [`rows.jsonl.gz`](2026-11-02-skillopt-ceiling/runs/gate-1/rows.jsonl.gz), one row per rollout with its answer and tool calls. The rewrites' inputs and outputs: [`one-shot/`](2026-11-02-skillopt-ceiling/runs/gate-1/one-shot/).
- Calibration: [`runs/calibration-reread/`](2026-11-02-skillopt-ceiling/runs/calibration-reread/).
- Rerunning the gate spends about $134 and needs `ANTHROPIC_API_KEY` (and `OPENAI_API_KEY` if Sol's gate runs) and a budget-ledger run: `bun eval/runner/n15-skillopt-method.ts --dataset v3 --stage gate --attempt 1 --calibration <opus receipt>,<sol receipt> --paid --budget-run-id <id>`. With `--fake` instead of `--paid` it runs the same path keyless on a scripted transport.

## Disclosures

gbrain is Garry Tan's own project.

Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator. Garry Tan runs Y Combinator.

Disclosure: Y Combinator, which Garry Tan runs, is an investor in Particle, which makes particle-1.
