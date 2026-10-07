# LongMemEval end to end on today's gbrain: 468/500 with a Sonnet 5.5 reader

Measured 2026-10-06 on gbrain `c5fb0201` (v0.60.95.0), the pin in `package.json`. Status: **Complete** (500 of 500 questions). Evidence class: development (LongMemEval-S was used to tune gbrain's retrieval). Reader: `claude-sonnet-5-5` through gbrain's benchmark notes reader; **benchmark notes reader; not production `think`**. The result applies to Sonnet 5.5, not to gbrain's default Sonnet 4.6.

[gbrain](https://github.com/garrytan/gbrain) is a Markdown-first memory system for agents. [LongMemEval](https://arxiv.org/abs/2410.10813) asks 500 questions about long histories of old conversations (about 50 conversations and 115,000 tokens per question in the `_s` split). gbrain imports each question's history, retrieves the conversations that look relevant, and a reader model answers from them. A judge model grades each answer against the dataset's reference.

## The finding

**Today's gbrain, with its release retrieval and a Sonnet 5.5 reader, answers 468 of 500 questions correctly (93.6%, exact 95% interval 91.1% to 95.6%) under LongMemEval's official judge.** The round's secondary judge (`gpt-6.1-sol`) gives 475 of 500. The two judges agree on 493 of 500 answers.

**That is no measurable change from the September retrieval.** The same reader on the 2026-09-29 retrieval from gbrain `a7cb37b` answered 462 of 500. Paired question by question, today's build won 11 and lost 5 (preregistered one-sided test, p = 0.081): "no change shown at the measured power" (80% power for about 2.2 points at the observed discordance). The difference combines everything that changed between the two builds and their configurations, including the nine P-series features; it is not attributed to any one of them.

**Retrieval itself is unchanged on this benchmark.** Strict retrieval (every labeled evidence conversation in the top 5) is 449 of 470 answerable questions today against 450 of 470 at `a7cb37b` (+0 / -1). For 401 of 500 questions, the reader received byte-for-byte the same request text as in September, and on those 401 the two runs still disagreed on 13 answers (9 one way, 4 the other). That is the run-to-run variation of a single sample at the provider's default temperature, and it is about as large as the whole build difference.

## The concrete case

*From the data.* Question `a06e4cfe` asks "What is my preferred gin-to-vermouth ratio for a classic gin martini?" Somewhere in about 50 earlier conversations, the user once said they settled on 3:1 with a dash of citrus bitters. gbrain returns its top five text chunks, reranked by `voyage:rerank-2.5`; the reader then reads the full text of each distinct conversation behind them (here 5 conversations, about 22,000 Sonnet 5.5 input tokens), takes brief notes and answers.

## The experiment

- **Code and configuration.** `gbrain eval longmemeval` at `c5fb0201`, release retrieval: `--top-k 5 --no-trajectory --mode balanced --reranker on --autocut off`, `voyage:rerank-2.5`, OpenAI `text-embedding-3-large` at 1,536 dimensions, opaque session ids (no request contains `answer_`). Retrieval config hash `fa81621a511e`. Every row was reranked; no row has a degraded stage.
- **Reader requests.** gbrain's harness ran unmodified with a stub reader that recorded each request and returned a placeholder, so retrieval ran for real while the reader cost nothing (the method of the 2026-09-29 driver). The recorded system and user text then went to `claude-sonnet-5-5` through the Anthropic Message Batches API with nothing changed but the model, a 3,500-token output limit and `output_config.effort: "low"` (Sonnet 5.5 always thinks adaptively; see the [preregistration](2026-10-06-longmemeval-w10-preregistration.md), including the amendment that set 3,500 tokens to fit the cap). House notes prompt `gbrain-lme-reader-v4-notes-fullsessions` (SHA-256 `3db7ccbb…`), mean 4.9 conversations per question, no conversation cut by the 60,000-character bound.
- **Judges.** Primary: LongMemEval's official `evaluate_qa.py` prompt on `gpt-4o-2024-08-06`, temperature 0. Secondary, report-only: the same prompt on `gpt-6.1-sol` at low effort.
- **Comparator.** The W10b arm `w10b-sonnet55-notes`: the same reader and settings (4,096 output tokens) on the request text recorded at `a7cb37b` on 2026-09-29 ([W10b report](2026-10-07-longmemeval-w10b-reader-replay.md)).
- **Denominator.** All 500 questions, including the 30 whose correct answer is that the information is not available.

## Results

### Current pin (gbrain `c5fb0201`), benchmark notes reader; not production `think`

| Arm | Questions | Status | Correct, official judge (gpt-4o) | Correct, secondary judge (gpt-6.1-sol) | Judges agree | `max_tokens` finishes | Reader errors |
|---|---|---|---|---|---|---|---|
| `c5fb0201`, Sonnet 5.5 notes | 500 | Complete | **468 (93.6%)** | 475 (95.0%) | 493 | 0 | 0 |
| `a7cb37b` retrieval (2026-09-29), same reader | 500 | Complete | 462 (92.4%) | 468 (93.6%) | 488 | 0 | 0 |

| Paired, `c5fb0201` against `a7cb37b` | Wins | Losses | Test | Result |
|---|---|---|---|---|
| Official judge (preregistered) | 11 | 5 | one-sided superiority, p = 0.081 | no change shown |
| Secondary judge (report-only) | 11 | 4 | | |
| Only the 401 questions with identical request text | 9 | 4 | | run-to-run variation |
| Only the 99 questions whose request text changed | 2 | 1 | | |

`compare.ts` power note (from the observed discordance): with 500 pairs, a two-sided 0.05 test has 80% power for a change of about 2.2 points; the observed +1.2 points is below that, so this is not evidence of no effect either. The preregistration's planning figure was 3.1 points one-sided at an assumed 8% discordance; the observed discordance was 3.2%.

By type (official judge; secondary judge in brackets):

| Type | Questions | `c5fb0201` | `a7cb37b` retrieval |
|---|---|---|---|
| single-session-user | 64 | 62 (64) | 63 (64) |
| single-session-assistant | 56 | 56 (56) | 56 (56) |
| single-session-preference | 30 | 30 (30) | 29 (29) |
| knowledge-update | 72 | 71 (72) | 68 (69) |
| temporal-reasoning | 127 | 118 (118) | 115 (115) |
| multi-session | 121 | 103 (107) | 104 (109) |
| abstention | 30 | 28 (28) | 27 (26) |

### Retrieval

| Build | Strict `recall_all@5` (470 answerable) | Same top-5 conversation list as September | Same set of conversations |
|---|---|---|---|
| `c5fb0201` | 449 | 401 of 500 | 438 of 500 |
| `a7cb37b` (2026-09-29 R1) | 450 | | |

## What to use and what to avoid

- **gbrain's current retrieval gives a strong reader what it needs on this benchmark.** 93.6% with Sonnet 5.5 is the current-pin number; the September house number (451/500, 90.2%, under the official judge with Sonnet 4.6) is a different reader, not a different build.
- **Do not read the P-series into this number.** LongMemEval-S retrieval is near its ceiling for gbrain (449 of 470 strict), so the P-series features have little room to show here; BEAM-1M and the held-out program are where they are measured.
- **Single-sample noise is about 13 answers in 500 for this reader.** Two runs on identical prompts differ by that much, so a few-point difference between single runs of any two configurations is not a result on its own.
- **Limits.** One sample per question at provider-default temperature; development data; Sonnet 5.5 only; the notes reader is gbrain's benchmark reader, while gbrain's product answerer (`think`) no longer reads notes-first.

## Cost and time

| Item | Requests | Reserved | Settled |
|---|---|---|---|
| Retrieval: embedding 500 histories (cold cache), one-time per history | 24,351 | | $7.56 |
| Retrieval: Voyage rerank, one per question | 500 | | $0.35 |
| Reader, Sonnet 5.5 (batch, 50% of list) | 500 | $19.84 | $11.59 |
| Official judge (batch) | 500 | $0.25 | $0.18 |
| Secondary judge (batch) | 500 | $5.22 | $0.15 |
| **Total (W10a run, $28 cap)** | | | **$19.83** |

Per question: reader $0.023, rerank $0.0007, one-time embedding $0.015. Wall time: retrieval capture 3 hours 7 minutes on the 4-vCPU Capy machine (22.5 s per question, mostly embedding the histories); the reader batch finished in 6 minutes. Batch requests report no per-request latency, so none is given. No request failed or was retried; the secondary-judge batch was the slowest (46 minutes).

## Reproduce and inspect

Keyless $0 re-score from the committed rows (verdicts recomputed from the stored judge replies, then the preregistered family through `compare.ts`):

```bash
bun eval/runner/batch/w10-rescore.ts w10a docs/benchmarks/2026-10-07-longmemeval-w10a-current-pin docs/benchmarks/2026-10-07-longmemeval-w10b-reader-replay
```

Expected: `"official": 468` for `w10a-sonnet55-notes`, `"official": 462` for `w10b-sonnet55-notes`, McNemar wins 11, losses 5, status `inconclusive`, and "re-score matches".

Receipts in [`2026-10-07-longmemeval-w10a-current-pin/`](2026-10-07-longmemeval-w10a-current-pin/):

- `capture/captures.ndjson.gz`: every reader request gbrain's harness built at `c5fb0201` (system and user text); `capture/harness-rows.ndjson.gz`: the harness rows with retrieval results, recall and search metadata; `capture/capture-run.json`: arguments, retrieval spend and the preregistration attestation; `capture/capture-log.txt`.
- `arms/w10a-sonnet55-notes/rows.ndjson`: answers, finish reasons, usage, cost and both judges' replies per question; `receipt.json`: batch ids, reservations, settlement, the confirmed batch factor and the attestation.
- `summary.json`, and the paired files `compare-w10a-a.ndjson` / `-b.ndjson`.
- Manifest: [`w10a-sonnet55-notes.json`](2026-10-06-longmemeval-w10-manifests/w10a-sonnet55-notes.json); family: [`w10a-official.json`](2026-10-06-longmemeval-w10-families/w10a-official.json).

Live re-run (about $20 and 3.5 hours on a cold embedding cache; `OPENAI_API_KEY`, `VOYAGE_API_KEY`, `ANTHROPIC_API_KEY`; the dataset `longmemeval_s_cleaned.json`, SHA-256 `d6f21ea9…`, in `$LME_DATASET`):

```bash
bun eval/runner/batch/w10a-capture.ts                      # retrieval with the stub reader (about $8)
bun eval/runner/batch/w10.ts build w10a-sonnet55-notes     # refuses if the bodies differ from the committed manifest
bun eval/runner/batch/w10.ts run w10a-sonnet55-notes && bun eval/runner/batch/w10.ts poll
bun eval/runner/batch/w10.ts judge w10a-sonnet55-notes official && bun eval/runner/batch/w10.ts poll
bun eval/runner/batch/w10.ts judge w10a-sonnet55-notes secondary && bun eval/runner/batch/w10.ts poll
bun eval/runner/batch/w10.ts export w10a-sonnet55-notes <dir>
```

Through gbrain's own CLI, the same retrieval with the reader live: `gbrain eval longmemeval longmemeval_s_cleaned.json --top-k 5 --no-trajectory --mode balanced --reranker on --autocut off --model anthropic:claude-sonnet-5-5 --reader-mode notes --reader-max-tokens 1024 --judge --judge-model openai:gpt-4o` (the harness sends 1,024 tokens and no effort setting, so its numbers can differ from this report's).
