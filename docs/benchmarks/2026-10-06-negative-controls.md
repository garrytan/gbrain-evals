# Live negative controls: Cat 14 and Cat 35 notice a broken configuration, Cat 20 and Cat 29 do not

**Finding.** Two of four model-backed categories score a deliberately broken configuration clearly lower than the working one, with today's models; two do not. On October 6, 2026, at gbrain `c5fb0201` (v0.60.95.0), with Claude Sonnet 5.5 as the category model and GPT-6.1 Sol as the judge: **Cat 14** (calibration) fell from a 67% calibrated win rate to 0% with no profile, and **Cat 35** (transcript distillation) fell from 89% coverage to 0% when the distiller read an unrelated transcript. Both pass the rule that a broken arm must score at most half the real one. **Cat 29** (think vs search) scored *higher* with meaningless hash embeddings (3.62 against 3.26 of 5), and **Cat 20** (brainstorm) scored 2.99 against 3.17 when every page's sentences were shuffled across the corpus. Both fail, so under the preregistered consequence they drop to report-only until their tests can detect breakage. Realistic partial faults moved the passing categories a lot: swapping 30% of the profile cut Cat 14's win rate from 67% to 17%, and cutting each transcript in half cut Cat 35's coverage from 89% to 24%.

Status: **Complete** (4 of 4 controls, 2 of 2 partial faults; scored arms after one failed launch, see "Failed attempts"). Evidence class: **harness validity**. Preregistration: [2026-10-06-negative-controls-preregistration.md](2026-10-06-negative-controls-preregistration.md) (pushed `4647401`, amendments `e92762b` and `16d7872` before any scored arm).

## Why this matters

A benchmark that can't score a broken configuration lower than a working one measures something other than what it names. The rule is the audit's, used on [October 2](2026-10-02-live-negative-controls.md) for Cat 25 and Cat 13: on the same fixture and seed, the degraded arm must score at most 0.5 times the real arm. These runs use live models, so a pass shows the category notices a real loss of capability.

## The controls

[gbrain](https://github.com/garrytan/gbrain) is a memory system for agents. Each category tests one feature end to end; each control breaks the input that feature depends on and keeps everything else, including what the judge treats as the truth.

| Category | What it tests | Real arm | Broken arm | Error it should catch |
|---|---|---|---|---|
| Cat 14 | `think` adapting answers to a person's calibration profile (their known biases), judged blind A/B against the uncalibrated answer | real profile seeded | no profile seeded (judge still sees the real one) | calibration that ignores the profile |
| Cat 20 | `brainstorm` ideas from crossing close and far pages, scored by four judges | the [W7 run](2026-10-06-cat20-judges.md) | the same run with every body sentence shuffled across all 165 pages (seed 20261006) | ideas that don't depend on what the brain holds |
| Cat 29 | `think`'s answer against the raw search payload, judged blind | live `text-embedding-3-large` embeddings | deterministic hash embeddings (no meaning) | answers that don't depend on retrieval |
| Cat 35 | the dream lane distilling a transcript into brain pages, coverage of planted facts | each of 8 transcripts as written | each replaced by a transcript from another scenario, scored against the original's facts | a distiller credited for content it never read |

Models: `claude-sonnet-5-5` for `think`, `brainstorm`, the Cat 35 distiller, fact extraction and dream triage; `gpt-6.1-sol` as judge for Cat 14, 29 and 35 (through an OpenAI Responses shim with JSON-schema output, reasoning effort low); the four W7 judges for Cat 20. Every arm samples at the provider default: Sonnet 5.5 rejects `temperature`, and the OpenAI judge path sends none. Results describe these models, not gbrain's default chat model.

## Results

| Category | Statistic | Real | Broken | Ratio (limit 0.5) | Signal floor | Injection check | Verdict |
|---|---|---:|---:|---:|---|---|---|
| Cat 14 calibration | calibrated win rate (of 6 win-eligible probes) | 0.667 (4 of 6) | 0.000 | 0.00 | met (≥ 2 wins) | no calibration block in any of 8 calibrated prompts | **pass** |
| Cat 20 brainstorm | median of the three counted judges' mean score on all ideas (0 to 5) | 3.14 | 2.99 | 0.95 | met (> 1.0) | shuffled corpus recorded (seed, hash) | **fail** |
| Cat 29 think vs search | mean `think` score, blind pairwise judge (0 to 5) | 3.26 | 3.62 | 1.11 | met (> 0) | `embed_transport: stubbed-hash` | **fail** |
| Cat 35 distillation | dream-lane coverage, macro (67 planted items) | 0.891 | 0.000 | 0.00 | met (> 0.10) | 8 donor transcripts, each from another scenario, with hashes | **pass** |

What the failures mean:

- **Cat 29.** Its five questions ask about named companies and facts in the synthetic corpus, so keyword search finds the right pages without meaningful embeddings, and `think` writes as good an answer (here slightly better, within noise for 5 questions). The category measures synthesis over keyword-findable pages, not retrieval. `think` beat raw search on all 5 questions in both arms.
- **Cat 20.** The table counts Claude Sonnet 5.5, GPT-6.1 Sol and Claude Opus 5.5; the preregistered four-judge median with Claude Fable 5.1 (smoke-only since 2026-10-07, [amendment](2026-10-06-negative-controls-preregistration.md#2026-10-07-fable-51-is-smoke-only)) gives 3.17 against 2.99, ratio 0.94, the same verdict. With shuffled pages, Sonnet 5.5 still writes plausible, well-formed ideas that cite the pages, and the judges rate them nearly as well: 2.92 to 3.15 by judge against 3.11 to 3.55 for the real corpus. The judges score idea quality in general more than whether the ideas follow from the brain's content.

Partial faults (report-only, no rule):

| Category | Fault | Real | Partial | Drop |
|---|---|---:|---:|---:|
| Cat 14 | 30% of each profile's bias tags and pattern statements swapped for other probes' (seed 20261006) | 0.667 win rate | 0.167 | 0.50 |
| Cat 35 | each transcript cut to its first half at a line break | 0.891 coverage | 0.241 | 0.65 |

Cat 35's half-transcript drop is uneven, as it should be: coverage of facts planted early fell from 0.85 to 0.52, in the middle from 0.90 to 0.17, and late from 0.91 to 0.02. That the early facts also dropped suggests the distiller writes less, or triage scores the shorter transcript lower, when half the conversation is missing.

## What to use and what to avoid

- **Keep Cat 14 and Cat 35 as gates.** Both separate a broken input from a working one by far more than the rule needs, and both register realistic partial faults.
- **Treat Cat 20 and Cat 29 as report-only** until their tests can tell a broken brain from a working one. For Cat 29, questions that need meaning rather than names (paraphrases, as Cat 21 now uses) would make the embedding matter. For Cat 20, a judge rubric that checks whether an idea actually uses the cited pages' content, or a grounding check on page facts rather than slugs, would make the corpus matter.
- These are single runs with small samples (6 win-eligible probes, 5 questions, 8 transcripts). The two passes have large margins; the two failures are not close either.

## Failed attempts (kept, not scored)

The first launch was refused at budget-run open, before any request (runner estimates above the per-run budgets; amendment `e92762b`). The second launch failed on the provider side: Sonnet 5.5 rejects `temperature`, which Cat 14's and Cat 29's `think` clients sent at 0, so every Cat 14 probe and the first Cat 29 calls returned HTTP 400. The ledger charged each failed request at its reservation: $1.95 for the three Cat 14 runs, $0.16 for a fourth Cat 14 run I stopped, and $0.44 for the partial Cat 29 run (mostly corpus embeddings). The runners now send `temperature` only to models that accept it (amendment `16d7872`), and every arm reran once. The failed attempts' logs and receipts are in [`attempt1/`](2026-10-06-negative-controls/attempt1/).

## Reproduce and inspect

Keyless, $0, from the committed receipts (applies the rule, floors and injection checks; prints the partial faults):

```bash
bun eval/runner/w8-negative-controls.ts summarize docs/benchmarks/2026-10-06-negative-controls
```

Expected: Cat 14 pass (0.667, 0), Cat 20 fail (ratio 0.941), Cat 29 fail (ratio 1.110), Cat 35 pass (0.891, 0).

Live reruns (each needs `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`; L is the ledger):

```bash
bun eval/runner/cat14-calibration.ts --model anthropic:claude-sonnet-5-5 --judge-model openai:gpt-6.1-sol --profile-mode {real|none|swap30} --budget-ledger L --budget-usd 0.75 --estimate-usd 0.4
bun eval/runner/cat29-think-vs-search.ts --model anthropic:claude-sonnet-5-5 --judge-model openai:gpt-6.1-sol --embed-mode {real|hash} --budget-ledger L --budget-usd 0.75 --estimate-usd 0.4
bun eval/runner/cat35-transcript-distill.ts --lanes dream --transcripts coding-reflection-01,coding-reflection-02,emotional-processing-01,emotional-processing-02,people-deal-01,people-deal-02,startup-ideation-01,startup-ideation-02 \
  --model anthropic:claude-sonnet-5-5 --judge-model openai:gpt-6.1-sol --transcript-mode {real|unrelated|half} --budget-ledger L --budget-usd 3 --estimate-usd 1.5
bun eval/runner/cat20-brainstorm.ts --model anthropic:claude-sonnet-5-5 --idea-judges anthropic:claude-sonnet-5-5,openai:gpt-6.1-sol,anthropic:claude-opus-5-5,anthropic:claude-fable-5-1 \
  --shuffle-corpus 20261006 --budget-ledger L --budget-usd 9
```

Spend: $12.94 for this lane's W8 part, within its $20 share of W8's $25 cap: scored arms $10.39 (Cat 14 $0.89, Cat 29 $0.39, Cat 35 $1.25, Cat 20 degraded $7.86) and failed attempts $2.55; the Cat 20 real arm is W7's spend. Wall time: Cat 14 about 5 minutes per arm, Cat 29 2 minutes, Cat 35 3 to 5 minutes, Cat 20 54 minutes. Judge errors: none for Cat 14, 29 and 35; Fable missed 42 of 216 idea scores in the Cat 20 broken arm (excluded from its mean). Artifacts in [`2026-10-06-negative-controls/`](2026-10-06-negative-controls/): each arm's receipt (with the preregistration attestation and ledger cost), Cat 14's per-probe dumps (prompts' calibration-block check and both answers), Cat 35's detailed receipts and distilled pages, run logs, and `summary.json`.
