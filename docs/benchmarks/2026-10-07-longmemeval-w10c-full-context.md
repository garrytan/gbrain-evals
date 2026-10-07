# gbrain against pasting the whole history: within 7 points on LongMemEval, at about one seventh of the reader cost

Measured 2026-10-06. Status: **Complete** (150 of 150 questions in all four arms). Evidence class: development (LongMemEval-S was used to tune gbrain's retrieval). Builds: gbrain `c5fb0201` (v0.60.95.0) for retrieval and for rendering the full history. Readers: `claude-sonnet-5-5` and `gpt-6.1-sol`. **This table compares 150-question pairs only; do not set it beside the 500-question numbers.**

[gbrain](https://github.com/garrytan/gbrain) is a Markdown-first memory system for agents. [LongMemEval](https://arxiv.org/abs/2410.10813) asks questions about long histories of old conversations. The simplest alternative to a memory system is to skip retrieval and paste the whole history into a model with a long context window. On LongMemEval-S that is about 50 conversations per question, which fits in today's frontier context windows. This experiment asks what gbrain's retrieval costs and buys against that alternative, with the reader held fixed.

## The finding

**gbrain's retrieval does as well as the whole history within the preregistered 7-point margin, for both readers.** On the same 150 questions:

- With `claude-sonnet-5-5`: whole history 144 of 150 (96.0%), gbrain 139 of 150 (92.7%). Non-inferiority at 7 points passes (Holm-adjusted one-sided p = 0.035).
- With `gpt-6.1-sol`: whole history 141 of 150 (94.0%), gbrain 137 of 150 (91.3%). Non-inferiority passes (Holm-adjusted p = 0.014).

**The whole history scored a little higher with both readers, and the gap sits in multi-session questions.** The preregistered test of "whole history better by more than 7 points" did not pass for either reader, so the result is "gbrain within 7 points", not "the same". All of Sonnet's five-question gap and all of `gpt-6.1-sol`'s net four are in multi-session questions, where the answer is spread over more conversations than gbrain's top 5 always returns.

**gbrain's reader input is about one eighth of the whole history, and its recurring cost per question is about one seventh.** The Sonnet 5.5 reader cost $0.024 per question with gbrain (reader plus rerank) and $0.173 with the whole history, at batch prices. For `gpt-6.1-sol`: $0.015 against $0.107. gbrain also pays a one-time $0.015 per history to embed it.

## The concrete case

*From the data.* Question `129d1232` asks "How much money did I raise in total through all the charity events I participated in?" The answer, $5,850, is the sum of amounts mentioned in several separate conversations. With the whole history, the reader sees every one of them. gbrain returns the five best-matching passages and gives the reader the full conversations behind them; if a charity conversation is not among them, the sum comes out wrong. Questions like this are where the whole history wins. Single-fact questions ("what ratio did I settle on for my martini?") come out the same either way.

## The experiment

- **Subset.** 150 of the 500 questions, stratified by the report's seven question types with a fixed seed (`20261006`): abstention 9, knowledge-update 22, multi-session 36, single-session-assistant 17, single-session-preference 9, single-session-user 19, temporal-reasoning 38. The ids are in the manifests.
- **gbrain arms.** The current-pin retrieval of [W10a](2026-10-07-longmemeval-w10a-current-pin.md): release configuration (`balanced`, `voyage:rerank-2.5`, autocut off, top 5), house notes prompt over the full text of the retrieved conversations. Sonnet 5.5 rows are W10a's own (no new calls); `gpt-6.1-sol` read the same captured prompts (`w10c-sol-currentpin`).
- **Whole-history arms.** The same house notes prompt with every haystack conversation in place of the retrieved ones, in haystack order, rendered with gbrain's own page renderer and `<chat_session>` framing. Mean input 171,596 tokens for Sonnet 5.5 (largest 176,056) and 106,683 for `gpt-6.1-sol` (largest 108,844), as each provider counts them; every prompt stays under the 200,000-token long-context price tiers. No conversation was cut by the 60,000-character bound.
- **Reader settings.** Sonnet 5.5: adaptive thinking at `output_config.effort: "low"`, 4,096 output tokens (3,500 in W10a's rows, by amendment); `gpt-6.1-sol`: `reasoning_effort: "medium"`, 12,000 completion tokens. No arm had a `max_tokens` finish.
- **Judges.** Primary: LongMemEval's official `evaluate_qa.py` prompt on `gpt-4o-2024-08-06`. Secondary, report-only: the same prompt on `gpt-6.1-sol`.
- **Test.** Preregistered ([W10 preregistration](2026-10-06-longmemeval-w10-preregistration.md)): gbrain non-inferior to the whole history at a 7-point margin, per reader, Holm across the two readers (family `w10c-noninferiority.json`); and the whole history better than gbrain by more than 7 points (family `w10c-loss.json`).

## Results

### Full-context comparison, 150-question pairs only

| Reader | Arm | Status | Correct, official judge (gpt-4o) | Correct, secondary judge (gpt-6.1-sol) | Judges agree | `max_tokens` finishes | Mean input tokens | Reader $ per question |
|---|---|---|---|---|---|---|---|---|
| `claude-sonnet-5-5` | whole history | Complete 150/150 | **144 (96.0%)** | 144 | 146 | 0 | 171,596 | $0.173 |
| `claude-sonnet-5-5` | gbrain (`c5fb0201`) | Complete 150/150 | **139 (92.7%)** | 143 | 146 | 0 | 22,242 | $0.023 |
| `gpt-6.1-sol` | whole history | Complete 150/150 | **141 (94.0%)** | 141 | 150 | 0 | 106,683 | $0.107 |
| `gpt-6.1-sol` | gbrain (`c5fb0201`) | Complete 150/150 | **137 (91.3%)** | 139 | 146 | 0 | 13,794 | $0.014 |

Exact 95% intervals (official judge): Sonnet whole history 91.5% to 98.5%, gbrain 87.3% to 96.3%; `gpt-6.1-sol` whole history 88.9% to 97.2%, gbrain 85.6% to 95.3%. Type-weighted to the full 500's mix, the official-judge accuracies are 96.0%, 92.6%, 94.0% and 91.3%, within 0.1 point of the stratified ones.

| Test (official judge, Holm across the two readers) | Reader | gbrain wins | Whole history wins | Result |
|---|---|---|---|---|
| gbrain non-inferior at 7 points | Sonnet 5.5 | 2 | 7 | **pass**, Holm p = 0.035 |
| gbrain non-inferior at 7 points | `gpt-6.1-sol` | 1 | 5 | **pass**, Holm p = 0.014 |
| whole history better by more than 7 points | Sonnet 5.5 | | | not shown (unadjusted p = 0.96, Holm 1.0) |
| whole history better by more than 7 points | `gpt-6.1-sol` | | | not shown (unadjusted p = 0.99, Holm 1.0) |

By type (official judge):

| Type | Questions | Sonnet whole | Sonnet gbrain | sol whole | sol gbrain |
|---|---|---|---|---|---|
| multi-session | 36 | 34 | 29 | 33 | 29 |
| temporal-reasoning | 38 | 36 | 36 | 34 | 33 |
| knowledge-update | 22 | 22 | 22 | 22 | 22 |
| single-session-user | 19 | 18 | 18 | 19 | 19 |
| single-session-assistant | 17 | 17 | 17 | 17 | 17 |
| single-session-preference | 9 | 9 | 9 | 9 | 9 |
| abstention | 9 | 8 | 8 | 7 | 8 |

### Cost per question

| | Sonnet 5.5, gbrain | Sonnet 5.5, whole history | `gpt-6.1-sol`, gbrain | `gpt-6.1-sol`, whole history |
|---|---|---|---|---|
| Recurring: reader input and output (batch prices) | $0.0233 | $0.1728 | $0.0144 | $0.1073 |
| Recurring: retrieval query (Voyage rerank; query embedding under $0.0001) | $0.0007 | none | $0.0007 | none |
| **Recurring total** | **$0.024** | **$0.173** | **$0.015** | **$0.107** |
| One-time: embedding the history (`text-embedding-3-large`) | $0.015 | none | $0.015 | none |

Recurring cost is paid on every question; the one-time cost is paid once per history and amortizes over every question asked of it. Judging is excluded from both. At list prices (no batch discount), every reader figure doubles. Latency is not reported: batch requests carry no per-request timing, and batch turnaround is not latency.

## What to use and what to avoid

- **Use gbrain's retrieval when cost per question matters.** Within 7 points of the whole history at about one seventh of the recurring cost on this benchmark, and it keeps working when the history grows past any context window, which LongMemEval-S does not test.
- **Paste the whole history when it fits, accuracy is everything and multi-session questions dominate.** The whole history answered 4 to 5 more of 36 multi-session questions with both readers.
- **Limits.** 150 questions, a 7-point margin chosen for this sample size, development data, one sample per question; LongMemEval-S histories are short enough to paste, so this says nothing about histories that are not; privacy (what leaves the machine) and latency are not measured here.

## Reproduce and inspect

Keyless $0 re-score from the committed rows (verdicts recomputed from the stored judge replies, both preregistered families through `compare.ts`):

```bash
bun eval/runner/batch/w10-rescore.ts w10c docs/benchmarks/2026-10-07-longmemeval-w10c-full-context docs/benchmarks/2026-10-07-longmemeval-w10a-current-pin
```

Expected: official 139, 137, 144 and 141 for the four arms, non-inferiority `pass` for both readers, loss family `inconclusive`, and "re-score matches".

Receipts in [`2026-10-07-longmemeval-w10c-full-context/`](2026-10-07-longmemeval-w10c-full-context/): `arms/<arm>/rows.ndjson` (answers, usage, cost, both judges' replies), `arms/<arm>/receipt.json` (batch ids, reservations, settlement, attestation), `summary.json` and the paired `compare-*.ndjson` files. Manifests (with per-question session counts for the whole-history prompts in `.meta.json`): [`2026-10-06-longmemeval-w10-manifests/w10c-*`](2026-10-06-longmemeval-w10-manifests/). Families: [`w10c-noninferiority.json`](2026-10-06-longmemeval-w10-families/w10c-noninferiority.json), [`w10c-loss.json`](2026-10-06-longmemeval-w10-families/w10c-loss.json).

Live re-run (about $45 and one hour; `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`; the dataset `longmemeval_s_cleaned.json`, SHA-256 `d6f21ea9…`, in `$LME_DATASET`; the current-pin arm reads W10a's committed capture):

```bash
for arm in w10c-sol-currentpin w10c-sol-full w10c-sonnet55-full; do
  bun eval/runner/batch/w10.ts build $arm      # refuses if the bodies differ from the committed manifest
  bun eval/runner/batch/w10.ts run $arm && bun eval/runner/batch/w10.ts poll
  bun eval/runner/batch/w10.ts judge $arm official && bun eval/runner/batch/w10.ts poll
  bun eval/runner/batch/w10.ts judge $arm secondary && bun eval/runner/batch/w10.ts poll
  bun eval/runner/batch/w10.ts export $arm docs/benchmarks/2026-10-07-longmemeval-w10c-full-context/arms/$arm
done
```
