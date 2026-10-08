# Preregistration: BEAM-1M dev failure analysis, the 1M no-memory floor and cheap repair arms (2026-10-08)

Frozen on October 8, 2026, in its own commit, before any paid request of this analysis. Nothing below changes after a paid request; a later change is a dated amendment at the end. Item B2 / E5.3 of wave 0 in the 10x memory advantage plan (`docs/plans/2026-10-07-10x-memory-advantage/PLAN.md` on [draft PR #97](https://github.com/garrytan/gbrain-evals/pull/97), thread GBRA-60), approved by the maintainer on 2026-10-08 with a wave 0 cap of $200, of which this item's cap is **$60**.

## Question

The 2026-10-06 rerun of BEAM-1M dev ([report](2026-10-06-beam-1m-dates.md)) scored 53.5% with a `gpt-4.1-mini` reader and judge, 18.2% strict recall at 5. Three things about that number are unknown or wrong, and this analysis settles them on the development split only:

1. **Its floor.** What does a reader score with no memory at all on these 220 questions? The 0.278 quoted so far is BEAM-100K's (120 questions); the 1M floor has never been measured.
2. **Where the loss is.** How much is the reader, how much is retrieval, and how much is a reading context of 5 turn groups?
3. **Which cheap change helps.** Reranker on, 10 turn groups read instead of 5, a deeper candidate pool with one chunk per session, and current frontier readers.

## Evidence class

Development evidence. BEAM-1M dev (11 conversations) is public and has been measured before. No sealed BEAM conversation is read: the runner now loads only the dev conversations' files on a dev run (`loadCorpus(..., only)`), and GBRA-52 owns every BEAM sealed opening. Results here can rank candidate fixes for wave 3's S1; they cannot make anything a default.

## What the free decomposition already found (computed before this file, $0)

`docs/benchmarks/2026-10-08-beam-1m-failure-analysis/decompose.ts` over the committed 2026-10-06 rows: 49 of 194 answerable questions with gold need more than 5 gold turn groups (strict@5 on the 145 feasible: 36), strict@10 57 of 160 feasible; 57 none@5 questions with gold plus 4 answerable questions whose gold the loader cannot map; committed-wrong answers 50 of 220 by hand label; strict all-items-met 75 of 220.

It also found a **reader-prompt defect** in `eval/runner/memory-qa/qa.ts`. BEAM dates sessions as `Month-DD-YYYY` ("March-05-2024"), and `renderHistory` sorted those strings alphabetically, so "sessions in date order" was alphabetical by month name (April, August, December, February, ...). The reader's "Current Date" (the conversation's latest session, `lastDate`) was the alphabetically last string, which is earlier than the true latest session in 8 of the 11 dev conversations (for `1m-28`, October 5, 2024 instead of May 5, 2025). This analysis fixes the sort for BEAM's format only (`sessionDateKey`; every other date format keeps its string key, so LongMemEval and LoCoMo prompts are byte-identical) and measures the fix with the bridge reader as arm A0. Every new answer arm uses the fixed prompt.

## Builds and data

- Frozen evidence for the reading arms: the committed ranked lists of the 2026-10-06 bridge arm, `docs/benchmarks/2026-10-06-beam-1m-dates/qa/baseline/shard-*/rows.ndjson.gz` (gbrain `6622a119e`, `openai:text-embedding-3-large` at 1,536 dimensions, balanced, reranker off, top 10), replayed with `--retrieved-from`. The replay rescores retrieval from the lists; it must reproduce strict@5 36/198 exactly or the arm is reported as a harness fault.
- Fresh retrieval arms: gbrain `7aa2caa0` (v0.60.106.0, master at this plan's pin), as a copied overlay; `voyage:voyage-4` at 1,024 dimensions, gbrain's shipped embedding default.
- gbrain-evals: this branch (main `f1ce49fe` plus this item's runner changes).
- Dataset: BEAM `b2da22e` (manifest `eval/decisions/datasets/beam-b2da22e.json`), size 1M, dev split: 11 conversations, 220 questions (198 answerable, 22 abstention; 194 with mappable gold).

## Arms, in run order

Readers: the counted readers are `anthropic:claude-sonnet-5-5`, `anthropic:claude-opus-5-5` and `openai:gpt-6.1-sol` (the newest Sonnet, Opus and GPT on 2026-10-08). `openai:gpt-4.1-mini` runs only as the bridge to the published 53.5%. Fable is not run (smoke-only rule, 2026-10-07). `gpt-5.4-mini` is never run. The judge is `openai:gpt-4.1-mini`, one yes/no call per rubric item, the protocol-fixed instrument of every BEAM row so far; it is not a reader comparison. Reader prompt: the LongMemEval step-by-step reading prompt, sessions in date order (fixed sort), 1 run, Anthropic `max_tokens` 1,024 at temperature 0, OpenAI reasoning models `max_completion_tokens` 2,000 at their default settings (the runner's existing settings). The full answer and the provider's finish reason are stored per answer in `answers.ndjson`.

| # | Arm | Evidence | Readers | Estimate |
|---|---|---|---|---:|
| S | Smoke: 2 questions per counted reader and the bridge, frozen top 5 | frozen | all four | $0.10 |
| A1 | **No-memory floor**: `--qa-context none`, empty history | none | `gpt-4.1-mini`, Sonnet 5.5, Opus 5.5, gpt-6.1-sol | $6 |
| A0 | Bridge with the date-order fix: frozen top 5 | frozen top 5 | `gpt-4.1-mini` | $1.2 |
| A2 | Frontier reader replay on the frozen top 5 | frozen top 5 | Sonnet 5.5, Opus 5.5, gpt-6.1-sol | $22 |
| A3 | Read 10 turn groups instead of 5: frozen top 10 | frozen top 10 | Sonnet 5.5 | $8.5 |
| A4 | Oracle-evidence ceiling: every gold turn group, `--qa-context oracle` | gold | Sonnet 5.5 | $5.5 |
| R0 | Retrieval only: voyage-4, balanced, reranker off, top 10 | fresh | none | $0.70 |
| R1 | Retrieval only: voyage-4, balanced default reranker on (`voyage:rerank-2.5`, top_n_in 25) | fresh | none | $0.25 |
| R2 | Retrieval only: voyage-4, reranker off, deeper pool with per-session diversity (`--pool-depth 200 --search-limit 100 --max-per-session 1`) | fresh | none | $0.01 |
| A5 | Reranker answers: R0's top 5 and R1's top 5 | R0, R1 | Sonnet 5.5 | $8 |

Sonnet 5.5 is the single reader of A3, A4 and A5 because it is the cheapest counted reader per token that spends no reasoning tokens; the three-reader comparison is A2. A5's two cells share the reader cache: a question whose top-5 set is identical in R0 and R1 renders the same prompt and reuses one answer, so the paired difference on it is exactly zero. The same holds for any repeated prompt in any arm, and the report counts reused answers.

Reranker fidelity (fail closed): R1 is `invalid`, and its numbers are not reported as a reranker result, unless every query with results carries rerank scores, no query reports a rerank degradation (failed, skipped or passed through), and the budget ledger holds at least one `voyage:rerank-2.5` request per reranked query. A harness once ran 0 of 5,985 rerank calls; these checks catch that.

Commands (repository root; `GBRAIN_EVALS_DATASETS` set; `<run>` is a ledger run opened per arm with `bun eval/runner/budget-ledger.ts open --runner b2-<arm> --budget-usd <cap> --budget-ledger .budget/b2-beam-1m-2026-10-08.sqlite`; shards `i/11`, one conversation each):

```bash
F=docs/benchmarks/2026-10-06-beam-1m-dates/qa/baseline
# A1 (per reader)
bun eval/runner/memory-qa/run.ts --benchmark beam-1m --split dev --qa reader --qa-context none --reader <reader> --judge openai:gpt-4.1-mini --qa-runs 1 --seed 42 --shard i/11 --output <out>/shard-i --paid --budget-run-id <run> --budget-ledger <ledger>
# A0, A2 (per reader), A3 (--qa-sessions 10)
bun eval/runner/memory-qa/run.ts --benchmark beam-1m --split dev --retrieved-from $F --top-k 10 --qa reader --qa-sessions 5 --reader <reader> --judge openai:gpt-4.1-mini --qa-runs 1 --seed 42 --shard i/11 --output <out>/shard-i --paid --budget-run-id <run> --budget-ledger <ledger>
# A4
bun eval/runner/memory-qa/run.ts --benchmark beam-1m --split dev --qa reader --qa-context oracle --reader anthropic:claude-sonnet-5-5 --judge openai:gpt-4.1-mini --qa-runs 1 --seed 42 --shard i/11 --output <out>/shard-i --paid --budget-run-id <run> --budget-ledger <ledger>
# R0 / R1 / R2
bun eval/runner/memory-qa/run.ts --benchmark beam-1m --split dev --embed real --embedding-model voyage:voyage-4 --embedding-dims 1024 --gbrain <gbrain checkout>@7aa2caa0 \
  --pin search.mode=balanced --pin search.reranker.enabled=false|true [--pin search.reranker.model=voyage:rerank-2.5] [--pool-depth 200 --search-limit 100 --max-per-session 1] \
  --top-k 10 --seed 42 --shard i/11 --output <out>/shard-i --paid --budget-run-id <run> --budget-ledger <ledger>
# A5: A2's command with --retrieved-from <R0 out> and <R1 out>, reader Sonnet 5.5
```

## Metrics and denominators

- **Answers**, for every arm and reader: mean rubric score over all 220 questions; the **strict all-items-met rate** (score 1, every rubric item met) over 220; both again over the 198 answerable and the 22 abstention questions. **The same reader's no-memory floor (A1) is printed beside every answer number.** A report line that quotes an answer score without its floor and its strict rate is wrong.
- **Retrieval**, for R0, R1, R2 and the replays: strict recall of all gold turn groups at 5 and at 10 over the 198 answerable questions (the published denominator, where the 4 answerable questions without mappable gold count as misses), and the same over the feasible subsets (145 at 5, 160 at 10); any@5; nDCG@10; strict@10 and nDCG@10 for event ordering and summarization separately.
- **Committed-wrong rate**: an answer scored 0 that states a value, regardless of hedge wording, over 220, split answerable and abstention; false abstentions (an answerable question declined) beside it. For the bridge row these are hand labels (`committed-wrong-labels.json`); for new arms the deterministic decline detector in `decompose.ts` (52 of 55 agreement with the hand labels) gives the count, labelled approximate.
- **Tokens**: provider input and output tokens per answer, and the runner's context estimate (characters / 4).
- Paired differences: candidate minus comparator on the same questions, cluster bootstrap by conversation (11 clusters, `clusteredPairedDelta`, 10,000 draws, seed 42), 95% interval. With 11 clusters only large effects resolve; an interval that crosses zero is "not distinguished at this sample size", never a tie.

## Comparisons (all descriptive, no gate)

| Comparison | Pairs | What it answers |
|---|---|---|
| A0 bridge minus the published bridge row | 220 | effect of the date-order fix on the published number |
| A2 reader minus A0 | 220 per reader | what a frontier reader gets from the same evidence |
| A2 reader minus that reader's A1 floor | 220 | how much the memory adds for that reader |
| A3 minus A2 Sonnet | 220 | reading 10 turn groups instead of 5 |
| A4 minus A2 Sonnet | 220 | the reading ceiling with perfect evidence |
| R1 minus R0, R2 minus R0 (retrieval) | 198 | reranker and deeper pool effects on strict@5/@10 |
| A5 R1 minus A5 R0 (answers) | 220 | whether the reranker's retrieval change reaches answers |
| R0 minus the frozen OpenAI lists (retrieval) | 198 | voyage-4 versus text-embedding-3-large, different builds (labelled as such) |

## What each outcome changes

These results order wave 3's S1 candidates by evidence and name the floor and strict rate for every future BEAM-1M quote. A change whose paired interval on Sonnet answers or on strict@5 excludes zero in its favour moves up S1's list; one that crosses zero stays where the plan put it, labelled not distinguished; one that loses is recorded as a negative result. No product default changes from development evidence alone.

## Budget and stop rule

One new ledger, `.budget/b2-beam-1m-2026-10-08.sqlite`, created with `bun eval/runner/budget-ledger.ts init --program-cap-usd 60 --reason "B2/E5.3 cap, wave 0 of the 10x memory advantage plan (GBRA-60), maintainer approval 2026-10-08"`. Every paid request (embedding, rerank, reader, judge) is reserved there first; the ledger refuses any reservation past $60. Arms run in the order above. Before each arm, its estimate is compared with what the ledger has left: an arm whose estimate would take committed spend past $60 does not start, the analysis stops there, and the remaining arms are published as Not run (cap). A refused reservation mid-arm leaves that arm Partial; nothing is retried outside the ledger. Caches (`GBRAIN_EVALS_EMBED_CACHE`, `GBRAIN_EVALS_QA_CACHE`) are lane-local and cold at the start.

A reader whose answers finish at the output limit with empty text on more than 5% of an arm's questions is reported as harness-limited for that arm and not interpreted as a model result; a rerun with a larger limit would be an amendment.

## Amendments

Both amendments were written after the smoke (arm S, 2 questions per reader, $0.37) and before any counted cell.

1. **2026-10-08, sampling.** The smoke's Sonnet 5.5 and Opus 5.5 calls were refused with "`temperature` is deprecated for this model". The reading lane now sends no `temperature` to Claude 5-family models (`sendsTemperature` in `qa.ts`, the repository's existing `acceptsTemperature` rule), so both sample at the provider default, as `gpt-6.1-sol` already did. `gpt-4.1-mini` (reader and judge) keeps temperature 0. Every receipt records `temperature_sent`.
2. **2026-10-08, single-reader arms.** The smoke measured Anthropic input tokens at 1.64 times OpenAI's for the same prompts (10,510 against 6,380), and `gpt-6.1-sol` used 156 to 236 output tokens per answer. Re-estimated with those numbers, the plan above costs about $58 against the $60 cap. A3, A4 and A5 therefore use **`openai:gpt-6.1-sol`** instead of Sonnet 5.5 (estimates $7.2, $3.7 and $6.6 including the judge; plan total about $49). The comparisons in the table change reader accordingly: A3, A4 and A5 are compared with A2's `gpt-6.1-sol` cell and with `gpt-6.1-sol`'s A1 floor. The three-reader comparison (A2) and the four floors (A1) are unchanged.
