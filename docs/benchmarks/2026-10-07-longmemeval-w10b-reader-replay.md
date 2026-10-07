# Frontier readers on gbrain's September retrieval: Opus 5.5 answers 474/500

Measured 2026-10-06 and 2026-10-07. Status: **Complete** (six reader arms, every manifest question answered and judged). Evidence class: development (LongMemEval-S was used to tune the retrieval being replayed). **Retrieval from gbrain `a7cb37b` (2026-09-29)**, not today's gbrain; today's end-to-end number is in the [W10a report](2026-10-07-longmemeval-w10a-current-pin.md). These are benchmark readers, not gbrain's production `think`, and a result for a model applies to that model only.

[gbrain](https://github.com/garrytan/gbrain) is a Markdown-first memory system for agents. [LongMemEval](https://arxiv.org/abs/2410.10813) asks 500 questions about long histories of old conversations: gbrain retrieves the relevant conversations, a reader model answers from them, and a judge grades the answer. On 2026-09-29 we recorded the exact text every reader request carried (the R1 notes run and the R2 direct run, gbrain `a7cb37b`, reranker on, opaque session ids). This report sends that same text to today's frontier readers, changing only the model, so every arm is paired question by question with the Sonnet 4.6 reader that produced the published 451/500 (official judge).

## The finding

**Claude Opus 5.5 is the strongest reader on this retrieval: 474 of 500 (94.8%) under LongMemEval's official judge, against Sonnet 4.6's 451.** Paired, Opus won 28 and lost 5 (Holm-adjusted p = 0.0006). The secondary judge agrees (480 against 455).

**Every current reader scores higher than Sonnet 4.6 on the same text, but only Opus 5.5 and Sonnet 5.5 direct clear the preregistered test across all six arms.** In order of how people use them:

| Reader (prompt) | Official judge (gpt-4o) | Paired with Sonnet 4.6 | Preregistered result |
|---|---|---|---|
| Sonnet 5.5 (notes) | 462/500 (92.4%) | +22 / −11 | no reader difference shown (Holm p = 0.097) |
| Sonnet 5.5 (direct) | 465/500 (93.0%) | +38 / −10 against Sonnet 4.6 direct (437) | **higher** (Holm p = 0.0006) |
| GPT-6.1 Sol (notes) | 464/500 (92.8%) | +24 / −11 | no reader difference shown (Holm p = 0.055) |
| GPT-5.4 (official prompt) | 460/500 (92.0%) | +23 / −14 | no reader difference shown (Holm p = 0.15) |
| Opus 5.5 (notes) | **474/500 (94.8%)** | +28 / −5 | **higher** (Holm p = 0.0006) |

**Notes no longer beat direct answers with Sonnet 5.5.** In September, Sonnet 4.6 scored 451 with notes and 437 direct on identical retrieval (p = 0.049, official judge). With Sonnet 5.5 the two are 462 and 465 (notes +7 / −10, p = 0.63): the note-taking step that helped the older reader makes no measurable difference to the newer one, which thinks before answering either way.

**GPT-5.4, the reader of the published vendor rows, scores 460/500 on gbrain's reranked retrieval with LongMemEval's official prompt.** This links our numbers to those rows on matched reader and prompt (retrieval and judges still differ by system; see [comparison systems](../comparison-systems.md)). On the reranker-off sessions of 2026-10-04 the same reader and prompt scored 448 (official judge); those are different sessions, so the gap is context, not a test.

Fable 5.1 ran on a seeded 200-question subset before Garry's 2026-10-07 rule that Fable is for smoke tests only; its row is kept as recorded at the end of the results and no decision rests on it.

## The concrete case

*From the data.* For question `a06e4cfe` ("What is my preferred gin-to-vermouth ratio for a classic gin martini?") every arm received the same 22,000-token request: the question, its date, and the full text of the five conversations gbrain retrieved, framed as untrusted data. The readers differ only in how well they find "3:1 with a dash of citrus bitters" in one of them and say so. Most questions are like this one and every reader gets them right; the differences come from multi-session sums and comparisons, preference questions and dates.

## The experiment

- **Request text.** R1 (notes) and R2 (direct) reader calls from `docs/benchmarks/2026-09-29-longmemeval-opaque-qa/reranker-on/`, joined to their rows by question text and date (500 of 500, no duplicates). System and user text are replayed byte for byte (test B9). R1 and R2 used the same retrieval (500 of 500 identical chunk lists) with strict `recall_all@5` 450/470.
- **GPT-5.4 arm.** LongMemEval's official `run_generation.py` notes-first prompt (JSON history, sessions sorted by date), built from exactly the sessions R1's reader saw, parsed out of R1's text and mapped back to raw ids (test F4; the builder reproduces the 2026-09-29 arm b prompts byte for byte).
- **Settings, preregistered per model.** Claude 5.x readers think adaptively by default (Sonnet 5.5 and Opus 5.5 cannot turn it off), so all ran at `output_config.effort: "low"` with 4,096 output tokens (Fable 2,048). `gpt-6.1-sol` and `gpt-5.4`: `reasoning_effort: "medium"`, 12,000 completion tokens. No arm had a `max_tokens` finish or a reader error.
- **Judges.** Primary: LongMemEval's official `evaluate_qa.py` prompt on `gpt-4o-2024-08-06` (the September comparators' committed verdicts are reused). Secondary, report-only: the same prompt on `gpt-6.1-sol`, run on every arm and on the September Sonnet 4.6 answers.
- **Test.** One-sided superiority against the paired Sonnet 4.6 run at `min_effect` 0, Holm across all six arms (family [`w10b-official.json`](2026-10-06-longmemeval-w10-families/w10b-official.json)), all batched through the round's budget ledger. [Preregistration and amendments](2026-10-06-longmemeval-w10-preregistration.md).

## Results

### Historical reader replay, retrieval from gbrain `a7cb37b` (2026-09-29)

| Arm | Questions | Status | Official judge (gpt-4o) | Secondary judge (gpt-6.1-sol) | Judges agree | `max_tokens` finishes | Mean output tokens | Reader $ (batch) |
|---|---|---|---|---|---|---|---|---|
| Sonnet 4.6 notes (R1, 2026-09-29) | 500 | Complete | 451 | 455 | 486 | 0 | 243 | (Sept.) |
| Sonnet 4.6 direct (R2, 2026-09-29) | 500 | Complete | 437 | 436 | 487 | 0 | 90 | (Sept.) |
| Sonnet 5.5 notes | 500 | Complete | 462 | 468 | 488 | 0 | 203 | $11.77 |
| Sonnet 5.5 direct | 500 | Complete | 465 | 470 | 491 | 0 | 108 | $11.30 |
| GPT-6.1 Sol notes | 500 | Complete | 464 | 464 | 494 | 0 | 110 | $7.12 |
| GPT-5.4, official prompt | 500 | Complete | 460 | 459 | 491 | 0 | 452 | $9.53 |
| Opus 5.5 notes | 500 | Complete | **474** | **480** | 494 | 0 | 294 | $24.01 |

Output tokens include reasoning or thinking tokens. Mean input tokens: 22,077 for the Claude readers and 13,695 for `gpt-6.1-sol` on the same text (their tokenizers differ), 14,458 for `gpt-5.4`'s official prompt.

| Paired with Sonnet 4.6 (official judge) | Wins | Losses | One-sided p | Holm p | 95% CI of the difference | Result |
|---|---|---|---|---|---|---|
| Opus 5.5 notes | 28 | 5 | 0.0001 | 0.0006 | +2.6 to +6.8 points | higher |
| Sonnet 5.5 direct (against R2) | 38 | 10 | 0.0001 | 0.0006 | +3.0 to +8.4 | higher |
| GPT-6.1 Sol notes | 24 | 11 | 0.014 | 0.055 | +0.4 to +5.0 | no difference shown |
| Sonnet 5.5 notes | 22 | 11 | 0.032 | 0.097 | 0.0 to +4.4 | no difference shown |
| GPT-5.4 official prompt | 23 | 14 | 0.076 | 0.15 | −0.6 to +4.2 | no difference shown |
| Fable 5.1 notes (200 subset) | 8 | 5 | 0.25 | 0.25 | −2.0 to +5.0 | no difference shown |

Under the secondary judge (report-only) the same comparisons are: Opus +28 / −3, Sonnet 5.5 direct +41 / −7, Sonnet 5.5 notes +25 / −12, `gpt-6.1-sol` +22 / −13, `gpt-5.4` +18 / −14, Fable +6 / −5.

`compare.ts` power notes at the observed discordance: with 500 pairs, a two-sided 0.05 test has 80% power for differences of about 3.2 to 3.8 points (5.1 points for Fable's 200); Holm's stricter levels for the lower-ranked arms need more. Sonnet 5.5 notes (+2.2 points), `gpt-6.1-sol` (+2.6) and `gpt-5.4` (+1.8) sit below what this design can confirm, so "no difference shown" is not evidence of no difference.

**Sensitivity to the Fable rule.** The family keeps the Fable comparison as preregistered. Had Fable been removed after the fact, Holm over five arms would also have counted `gpt-6.1-sol` as higher (adjusted p = 0.041). We report the preregistered result and note this here so the reader can see it.

By type (official judge):

| Type | Questions | Sonnet 4.6 notes | Sonnet 5.5 notes | Sonnet 5.5 direct | GPT-6.1 Sol | GPT-5.4 official | Opus 5.5 |
|---|---|---|---|---|---|---|---|
| single-session-user | 64 | 63 | 63 | 63 | 64 | 63 | 64 |
| single-session-assistant | 56 | 56 | 56 | 56 | 56 | 56 | 55 |
| single-session-preference | 30 | 24 | 29 | 28 | 29 | 29 | 30 |
| knowledge-update | 72 | 69 | 68 | 71 | 71 | 66 | 70 |
| temporal-reasoning | 127 | 112 | 115 | 114 | 115 | 118 | 117 |
| multi-session | 121 | 100 | 104 | 104 | 102 | 104 | 109 |
| abstention | 30 | 27 | 27 | 29 | 27 | 24 | 29 |

Most of Opus 5.5's lead over Sonnet 4.6 is in multi-session questions (+9) and preference questions (+6). GPT-5.4 with the official prompt is weakest on abstention (24 of 30): that prompt has no instruction to say when the information is missing, which gbrain's house prompt adds.

**Notes against direct, Sonnet 5.5, same retrieval (report-only):** notes 462, direct 465 (notes +7 / −10, exact McNemar p = 0.63); secondary judge 468 against 470 (+10 / −12, p = 0.83).

### Fable 5.1, 200-question subset (run before the 2026-10-07 smoke-only rule; not a counted cell)

| Arm | Questions | Status | Official judge | Secondary judge | `max_tokens` finishes | Reader $ |
|---|---|---|---|---|---|---|
| Sonnet 4.6 notes on the same 200 | 200 | Complete | 178 | 183 | 0 | (Sept.) |
| Fable 5.1 notes (2,048 tokens) | 200 | Complete | 181 | 184 | 0 | $24.49 |

## What to use and what to avoid

- **For the strongest answers on gbrain's retrieval, use Opus 5.5.** It is the only notes reader clearly above Sonnet 4.6 here, at about twice Sonnet 5.5's cost per question ($0.048 against $0.024 at batch prices).
- **Sonnet 5.5 is the better-value step up from the Sonnet 4.6 default,** but on notes its gain is not established at this sample size; with Sonnet 5.5, the direct prompt does as well as notes and halves the output tokens.
- **This is a hypothesis for gbrain's defaults, not a default change.** These are benchmark readers on frozen September retrieval; moving gbrain's product models (decision G6) needs its own production-path evaluation.
- **Limits.** Single sample per question at provider-default temperature (W10a shows two identical runs of one reader differing on 13 answers in 500); development data; the official judge accepts some "the information is not available" answers to answerable questions ([W8 control](2026-10-06-w8-longmemeval-control.md)), which the secondary judge does not.

## Cost and time

| Arm | Reader settled | Judges settled | Worst case reserved (reader) |
|---|---|---|---|
| Sonnet 5.5 notes (with 10-question pilot) | $11.77 | $0.34 | $21.71 |
| Sonnet 5.5 direct | $11.30 | $0.26 | $21.28 |
| GPT-6.1 Sol notes | $7.12 | $0.25 | $38.69 |
| GPT-5.4 official (pilot, batch, retry of 57) | $9.53 | $0.39 | $61.44 |
| Opus 5.5 notes (with pilot) | $24.01 | $0.35 | $43.42 |
| Fable 5.1 notes, 200 (with pilot) | $24.49 | $0.16 | $33.70 |
| Secondary judge on the September Sonnet 4.6 answers | | $0.32 | |
| **Total (W10b run, $107 cap)** | | | **$90.29** |

Every arm ran through the batch APIs at 50% of list price; each provider-and-model's 10-question pilot confirmed the discount from the provider's own accounting before the full batch (`service_tier: "batch"` on every Anthropic message; OpenAI batch usage equal to the sum of its rows). Reader batches finished in 3 to 12 minutes, except `gpt-5.4`'s, which stalled at 431 of 490 for 45 minutes and was cancelled (unfinished requests are not billed); its 57 unfinished requests used their one preregistered resubmission and all succeeded. Two judge batches stalled the same way near the end (2 and 15 requests) and were handled the same way. No reservation was refused and nothing was resubmitted automatically. Batch requests carry no per-request latency, so none is reported.

## Reproduce and inspect

Keyless $0 re-score from the committed rows (verdicts recomputed from the stored judge replies, the preregistered families through `compare.ts`):

```bash
bun eval/runner/batch/w10-rescore.ts w10b docs/benchmarks/2026-10-07-longmemeval-w10b-reader-replay
```

Expected: official 462, 465, 464, 460, 474 and 181 for the six arms, Opus and Sonnet 5.5 direct `pass`, the rest `inconclusive`, and "re-score matches".

Receipts in [`2026-10-07-longmemeval-w10b-reader-replay/`](2026-10-07-longmemeval-w10b-reader-replay/): `arms/<arm>/rows.ndjson` (answers, finish reasons, usage, cost, both judges' replies per question), `arms/<arm>/receipt.json` (batch ids, reservations, settlements, the pilot's batch-price evidence, the preregistration attestation), `baselines/r1-sonnet46|r2-sonnet46/` (secondary-judge verdicts on the September answers), `summary.json` and the paired `compare-*.ndjson` files. Manifests: [`2026-10-06-longmemeval-w10-manifests/w10b-*`](2026-10-06-longmemeval-w10-manifests/).

Live re-run (about $90 and a few hours; `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`; the `gpt-5.4` arm also needs `longmemeval_s_cleaned.json`, SHA-256 `d6f21ea9…`, in `$LME_DATASET`; the other arms read only committed receipts):

```bash
for arm in w10b-sonnet55-notes w10b-sonnet55-direct w10b-sol-notes w10b-gpt54-official w10b-opus55-notes; do
  bun eval/runner/batch/w10.ts build $arm      # refuses if the bodies differ from the committed manifest
  bun eval/runner/batch/w10.ts run $arm && bun eval/runner/batch/w10.ts poll   # first run is the 10-question pilot; run again for the rest
  bun eval/runner/batch/w10.ts judge $arm official && bun eval/runner/batch/w10.ts poll
  bun eval/runner/batch/w10.ts judge $arm secondary && bun eval/runner/batch/w10.ts poll
  bun eval/runner/batch/w10.ts export $arm docs/benchmarks/2026-10-07-longmemeval-w10b-reader-replay/arms/$arm
done
```
