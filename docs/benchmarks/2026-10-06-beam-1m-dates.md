# BEAM-1M with every session dated: the starting line's 18.2% strict recall stands, and today's gbrain retrieves the same

Date: 2026-10-06. Workstream W13 of the [2026-10 follow-up round](../plans/2026-10-06-followups-round/PLAN.md). Evidence class: development evidence (BEAM-1M dev is public and was measured before). Builds: gbrain `6622a119e` (v0.60.48.0, the held-out program's starting-line build) and `c5fb0201` (v0.60.95.0, the round's pin). Spend: $2.76 ($1.62 retrieval, $1.14 answers). Status: retrieval **Complete** at both builds. Answer half **Complete** at `6622a119e`, **Not run** at `c5fb0201` (cap).

## The finding

[BEAM](https://github.com/mohammadtavakoli78/BEAM) is a public benchmark of very long conversations. In its 1M size, each conversation history holds about a million tokens, far too much to paste into a prompt, so a memory system has to find the right sessions. The held-out program's starting line measured [gbrain](https://github.com/garrytan/gbrain) there on 2026-10-05: 18.2% of questions had every needed session in the top 5. Those runs used a loader that dated only the first turn group of each BEAM batch, so about 96% of sessions reached gbrain and the reader without a date. gbrain-evals v0.10.32 fixed the loader. This report reruns BEAM-1M dev on the fixed loader.

**The correction is small.** Same build, same settings, every session dated:

| BEAM-1M dev, gbrain `6622a119e` | Starting line (old loader) | Fixed loader |
|---|---:|---:|
| Every gold session in the top 5 (strict recall, 198 questions) | 18.2% (36) | **18.2% (36)**; 2 questions gained, 2 lost |
| Any gold session in the top 5 | 68.7% (136) | 69.2% (137) |
| Every gold session in the top 10 | 27.8% (55) | 28.8% (57) |
| nDCG@10 | 0.428 | 0.432 |
| Answer accuracy, all 220 questions (`gpt-4.1-mini` reader and judge) | 54.6% | **53.5%** |
| Answerable questions (198) / abstention questions (22) | 58.7% / 18.2% | 56.1% / 29.5% |

The starting-line row stands within noise. Strict recall did not move. Answer accuracy moved by 1.1 points, with 29 answerable questions better and 42 worse. That spread is what a single reader sample at the provider's default temperature produces, not a measured effect of dates.

**Today's gbrain retrieves exactly the same.** On the fixed loader, the pin `c5fb0201`, which carries the nine held-out-program plans, returned the same recall on every one of the 198 questions as `6622a119e`. Its ranked session lists were identical on 212 of 220 questions and differed only within lower ranks on the other 8. The preregistered comparison ([`eval:decide verdict`](2026-10-06-beam-1m-dates/verdict.json)) is inconclusive, with a difference of exactly 0. On BEAM-1M with these settings (balanced mode, reranker off, query expansion off), the P-series did not change retrieval, so the place where strict recall is weakest has not improved. A likely reason, not tested here: the plans mostly target relationship questions, temporal edges and answer generation, which this hybrid-search path over conversation sessions does not use.

## The concrete case

An invented example in the style of BEAM's event-ordering questions: "In what order did I first try the three marathon training plans?" It needs several sessions from different months of one conversation. Strict recall counts the question as found only when every one of those sessions is in the top 5. With dates missing, gbrain and the reader could not tell an early session from a late one. With dates restored, retrieval still found every needed session on the same 36 of 198 questions. The bottleneck is finding all the sessions, not knowing when they happened.

## The experiment and results

**Data.** BEAM revision `b2da22e` (manifest `eval/decisions/datasets/beam-b2da22e.json`, SHA-256 `cb154a2f...`; every chat file SHA-checked by `eval:decide fetch`), size 1M, dev split: 11 conversations, 220 questions over 10 categories, 22 of them abstention questions without gold sessions.

**Settings, identical to the starting line.** `search.mode=balanced`, reranker off, autocut off, hybrid search with query expansion off, chunks reduced to distinct sessions, top 10, seed 42, `openai:text-embedding-3-large` at 1,536 dimensions. The runner's configuration hash includes fields that were added after the starting line ran. Hashed with the starting line's field set, the baseline arm's arguments reproduce its hash, `ed768142...`, exactly ([`hash-check.ts`](2026-10-06-beam-1m-dates/hash-check.ts)). This is a same-configuration correction.

**Sequence (preregistered).** `eval:decide init` (baseline `6622a119e`, candidate `c5fb0201`, [decision spec](2026-10-06-beam-1m-dates/decision.json)), then `fetch --benchmark beam-1m`, then `dev --only beam-1m --shards 3` under one ledger run, then `verdict`. Embeddings were computed once: the pin's arm reused the first arm's cache on all but 872 chunks, so its retrieval cost $0.06.

**Answer half.** The starting line's protocol: `openai:gpt-4.1-mini` reader over the top 5 sessions in date order (the LongMemEval step-by-step reading prompt), and a `gpt-4.1-mini` judge that rates each rubric item yes or no, 1 run. Both are protocol-fixed older models, kept so the corrected row is comparable (decisions G8 and G9). This is not a model comparison. The pin's answer arm was not run. The preregistered $2 cap could not cover a second arm after the first cost $1.14, as the preregistration expected.

| Category, answer accuracy (20 questions each, 22 for abstention) | Old loader | Fixed loader |
|---|---:|---:|
| Preference following | 83.7% | 92.4% |
| Instruction following | 71.2% | 71.2% |
| Contradiction resolution | 61.4% | 65.9% |
| Multi-session reasoning | 58.4% | 60.1% |
| Event ordering | 58.5% | 46.8% |
| Knowledge update | 45.5% | 45.5% |
| Temporal reasoning | 44.7% | 42.4% |
| Information extraction | 65.0% | 41.2% |
| Summarization | 39.9% | 39.7% |
| Abstention | 18.2% | 29.5% |

With one sample per question, a category of 20 questions moves by several points from reader variation alone. Event ordering and temporal reasoning, the categories dates should help most, did not improve.

| Arm | Status | Questions | Cost |
|---|---|---:|---:|
| Retrieval, `6622a119e`, fixed loader | Complete | 220 (198 with gold) | $1.57 |
| Retrieval, `c5fb0201`, fixed loader | Complete | 220 (198 with gold) | $0.06 |
| Answers, `6622a119e`, fixed loader | Complete | 220 | $1.14 |
| Answers, `c5fb0201`, fixed loader | Not run (cap) | | |

There were no errors, refusals or retries in any arm. Two deviations are recorded as [amendments](2026-10-06-beam-1m-dates-preregistration.md#amendments). The configuration-hash field set is described above. The answer half ran in 11 shards instead of 2, because the runner's up-front cost gate prices every embedding as uncached ($4.80 for a 120-question shard against a $2 run). Sharding splits conversations across processes and changes no question's result. The first retrieval attempt failed before any request: arm processes were checking a different ledger file than the one named, and that was fixed in gbrain-evals `91ab356` with a regression test. Wall time was about 25 minutes for retrieval (3 shards per arm, run in parallel) and about 50 minutes for answers, on a shared 4-core machine. Latency columns in the receipts are not comparable across arms for that reason.

## What to use and what to avoid

The held-out program's BEAM-1M starting line is correct as published: dates were not the reason strict recall is 18%. For anyone deciding whether gbrain helps on million-token conversation histories: with these settings, gbrain finds at least one needed session for 69% of questions and every needed session for 18%. The P-series releases between v0.60.48 and v0.60.95 did not change that. Settings this run did not test (the reranker, query expansion, a different reader) may change it, and they are where a BEAM-1M improvement would have to come from.

## Reproduce and inspect

Keyless, $0, under a second: recompute every number above from the committed rows.

```bash
bun docs/benchmarks/2026-10-06-beam-1m-dates/recount.ts --check
bun docs/benchmarks/2026-10-06-beam-1m-dates/recount.ts
# old: strict recall@5 36/198 (18.2%), any@5 68.7%, all@10 27.8%, nDCG@10 0.4282
# fixed: strict recall@5 36/198 (18.2%), any@5 69.2%, all@10 28.8%, nDCG@10 0.4315
# pin: strict recall@5 36/198 (18.2%), any@5 69.2%, all@10 28.8%, nDCG@10 0.4316
# answers: old loader 54.6%, fixed loader 53.5%
bun docs/benchmarks/2026-10-06-beam-1m-dates/hash-check.ts   # last line: ed768142... (needs the fetched dataset)
```

Live. You need `OPENAI_API_KEY`, a gbrain checkout holding both commits, and a budget ledger. Retrieval costs about $1.60 with a cold embedding cache, and the answer arm about $1.15.

```bash
bun run eval:decide fetch --benchmark beam-1m
bun run eval:decide dev --decision docs/benchmarks/2026-10-06-beam-1m-dates --only beam-1m --shards 3 \
  --paid --budget-usd 5 --budget-ledger <ledger.sqlite>
bun run eval:decide verdict --decision docs/benchmarks/2026-10-06-beam-1m-dates --only beam-1m
bun eval/runner/memory-qa/run.ts --benchmark beam-1m --split dev --embed real --gbrain <gbrain checkout>@6622a119e40ea09a7719233046aca24741863ed2 \
  --pin search.mode=balanced --pin search.reranker.enabled=false --pin search.autocut=false --top-k 10 --seed 42 \
  --qa reader --qa-runs 1 --qa-sessions 5 --reader openai:gpt-4.1-mini --judge openai:gpt-4.1-mini \
  --shard <i>/11 --output <dir>/shard-<i> --paid --budget-run-id <id> --budget-ledger <ledger.sqlite>
```

Receipts are in [`2026-10-06-beam-1m-dates/`](2026-10-06-beam-1m-dates/). `runs/beam-1m/{baseline,candidate}/shard-*` hold the retrieval receipts and rows, `qa/baseline/shard-*` the answer receipts and rows (answers included), `verdict.json` the paired comparison, and `beam-summary.json` every number with both preregistration attestations. Spend is in the round ledger: run `decide:beam-1m-dates-2026-10-06-2026-10-06T19-11-47-672Z-e8724dda` ($1.62) and run `w13-beam-1m-answer-half-2026-10-06T19-53-29-629Z-f22e9aa3` ($1.14, 995 requests).
