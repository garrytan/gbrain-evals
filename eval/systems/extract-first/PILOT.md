# extract-first: Phase 2 pilot, 2026-10-05

These are setup checks for the [open-source memory shootout](../../../docs/plans/2026-10-05-oss-memory-shootout/PLAN.md),
not results. Each slice is one conversation or one haystack, too small to compare systems. The scores show that
ingest, retrieval, provenance, the reader and the judge ran end to end; the dollars and minutes size Phase 4.

**Status: ready, both configurations.** The recipe configuration (`gpt-5-mini`) needed four attempts: two failed on a
harness deadline (described below), one died when the machine restarted, and the fourth completed with every
question scored. The recipe needs the runner started with `BUN_CONFIG_HTTP_IDLE_TIMEOUT` until the harness fix lands.

## What ran

- Shim: `eval/systems/extract-first` at the lane branch (`mem0ai` 2.2.1, Qdrant 1.19.2), on the integration branch
  `capy/oss-memory-shootout`. The live conformance suite passed: 11/11 against the real proxy before the pilots
  (`conformance-extract-first-recipe`, $0.0069), and 21/21 on the current integration branch against the keyless fake
  provider after the queueing change below. `protocol_check.py` passed 26/26.
- Runner: `bun eval/runner/memory-qa/run.ts --benchmark <b> --system <shim URL> --qa reader --context native
  --policy vendor-default --paid --budget-run-id <id>`, with the runner's preregistered readers and judges. Reader
  and judge calls went through the same metering proxy as the shim, one proxy lease run and one ledger file per
  pilot, $5 lease each. Chunking followed extract-first's benchmark code: one turn per `add` for LoCoMo, two for
  LongMemEval-S and BEAM.
- Slices:
  - LoCoMo dev: `--shard 0/3`, which is exactly one conversation, `conv-44` (28 sessions, 675 turns, 158 questions,
    35 of them abstention).
  - LongMemEval-S: `--categories multi-session --limit 1`, question `2318644b`, one haystack of 41 sessions.
  - BEAM-100K dev: `--shard 0/6`, conversation `100k-1` (78 sessions, 188 turns, 20 questions).
- Dollars and tokens come from the proxy usage logs; the receipts' `cost.usd` reads $0 because the runner ledger
  does not see requests sent to the proxy.

## Results

| Run | Config | Questions (scored) | Ingest $ | `add` calls | Ingest min | Reader+judge $ per question | Retrieval p50 / p95 ms | recall_all@5 | recall_any@5 | QA |
|---|---|---|---|---|---|---|---|---|---|---|
| `pilot-extract-first-locomo-common` | common | 158 (123) | $0.968 | 675 | 25.7 | $0.00169 | 534 / 1,156 | 0.699 | 0.935 | 0.722 |
| `pilot-extract-first-lme-common` | common | 1 (1) | $0.505 | 263 | 14.0 (plus 28 runner start-up) | $0.0056 | 508 | 1 | 1 | 1 |
| `pilot-extract-first-beam-common` | common | 20 (18) | $0.244 | 94 | 6.3 | $0.0025 | 474 / 648 | 0.500 | 0.833 | 0.447 |
| `pilot-extract-first-locomo-recipe` (attempt 1) | recipe | 158 (0) | $2.33 | 593 | 149, not finished | n/a | n/a | n/a | n/a | n/a |
| `pilot-extract-first-locomo-recipe-r2` | recipe | 158 (0) | $0.33 | 101 | stopped at the deadline | $0.0016 (on an empty memory) | n/a | n/a | n/a | n/a |
| `pilot-extract-first-locomo-recipe-r3` | recipe | none | $0.06 | 18 | the machine restarted | n/a | n/a | n/a | n/a | n/a |
| `pilot-extract-first-locomo-recipe-r4` | recipe | 158 (123) | $2.725 | 675 | 185.1 | $0.00164 | 437 / 592 | 0.683 | 0.935 | 0.703 |

Readers and judges: LoCoMo `gpt-4o-mini` reader and `gpt-4o-2024-08-06` judge; LongMemEval-S `gpt-4o-2024-08-06`
for both; BEAM `gpt-4.1-mini` for both. Every common-model row was `scored`, with no reader, judge or retrieval
errors and no degraded ingest. Every item had `provenance_status: partial` (each memory cites the session whose
`add` created it; see the capability record). No proxy refusals and no tripwires in any run.

Per `add` call with the common models: LoCoMo $0.00142 (8,399 input and 102 output tokens), LongMemEval-S $0.00184
(8,946 and 224), BEAM $0.0024 (9,986 and 297). Almost all input is extract-first's own extraction prompt. With `gpt-5-mini`
(attempt 4): $0.00404 per call (8,490 input and 1,732 output tokens, most of them reasoning) and 16.4 seconds per call
on average, against about 2.3 seconds for `gpt-4.1-mini`. The reader saw a median of 963 tokens of memories on LoCoMo,
1,060 on LongMemEval-S and 1,142 on BEAM: 20 short facts.

## What went wrong in the recipe attempts

1. **Attempt 1.** Each `/ingest` blocked until extract-first had processed every turn of the session, one `add` per turn
   at 10 to 16 seconds each, so a 25-turn session takes about 6 minutes. Bun's `fetch` aborts any request after
   300 seconds without response bytes, whatever `AbortSignal` the caller passes (`The operation timed out.`;
   reproduced with a 330-second server: aborted at 300.007 s by default, completed with
   `BUN_CONFIG_HTTP_IDLE_TIMEOUT=14400`). The runner counted all 28 sessions as failed. The shim kept working through
   the queue, so the spend was real, but the runner never recorded the sessions as ingested. Every question then
   failed source validation ("20 returned source id(s) were never ingested") and was recorded as a
   `retrieval_error`, a product failure, although the cause was the harness deadline.
2. **Fix in the shim.** `/ingest` now queues the session on the namespace's single worker and returns `unknown` at
   once; `/finish` waits for the queue to drain, as the protocol allows. `/reset` cancels queued work.
3. **Attempt 2.** With queueing, `/finish` became the long request, and Bun aborted it at its 300-second limit too.
   The runner recorded `ingest_degraded` for all 158 questions; I restarted the shim to stop the orphaned queue.
4. **Attempts 3 and 4** ran the runner with `BUN_CONFIG_HTTP_IDLE_TIMEOUT=14400`. Attempt 3 died when the machine
   restarted after 18 calls; attempt 4 completed (one `/finish` of 185 minutes). The durable fix belongs in
   `eval/runner/systems/http.ts`: pass `timeout: false` (or a `socketTimeout` equal to the deadline) to `fetch`,
   because Bun ignores the `AbortSignal` for this limit.

## Phase 4 extrapolation

Inputs: the measured per-item costs above; a recipe LoCoMo conversation costs $2.725 (attempt 4). For BEAM, the
recipe is the common BEAM cost times the measured `gpt-5-mini` to `gpt-4.1-mini` per-call ratio on LoCoMo (2.84):
$0.69 per conversation. Question counts: LoCoMo dev 587, BEAM-100K dev
120, LongMemEval-S 100; the recipe arm skips LongMemEval-S. One reading arm is one policy and one context mode; the plan
runs four per configuration. Ingest is paid once per configuration and dataset, and LoCoMo dev is ingested twice
for run-to-run variance.

| Item | Arithmetic | Dollars |
|---|---|---|
| LoCoMo ingest, common, twice | 2 × 3 × $0.968 | $5.81 |
| LoCoMo ingest, recipe, twice | 2 × 3 × $2.725 | $16.35 |
| BEAM ingest, common | 6 × $0.244 | $1.46 |
| BEAM ingest, recipe | 6 × $0.69 | $4.15 |
| LongMemEval-S ingest, common | 100 × $0.505 | $50.50 |
| Reading, per arm | LoCoMo 2 × 587 × $0.00169 + BEAM 2 × 120 × $0.0025 + LongMemEval-S 100 × $0.0056 | $3.15 |
| Reading, four arms | 4 × $3.15 | $12.60 |
| **Total** | | **about $91** |

Two conditions move this number. If the harness re-ingests for each of the four reading arms instead of reusing
one ingest per configuration, the total rises to about $325, so reuse matters for extract-first. And the `fixed-evidence`
policy (top 200 memories, packed to 8,000 tokens) gives the reader about 8 times the vendor-default context, so
its reading arms may cost several times the per-arm figure above.

Wall time: ingest is serial within a namespace and parallel across namespaces (`parallel_namespaces: true`).
LongMemEval-S is about 100 × 14 minutes of `gpt-4.1-mini` calls (23 hours serial; about 3 hours at 8 namespaces in
parallel, if rate limits allow) plus the harness start-up. The recipe took 3 hours 5 minutes for one LoCoMo
conversation; the three can run in parallel.
