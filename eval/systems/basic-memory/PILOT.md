# Basic Memory: Phase 2 pilot, 2026-10-05

These are setup checks for the [open-source memory shootout](../../../docs/plans/2026-10-05-oss-memory-shootout/PLAN.md),
not results. Each slice is one conversation or one haystack, too small to compare systems; the scores show that
ingest, retrieval, provenance, the reader and the judge all ran end to end, and the dollars and minutes size Phase 4.

**Status: ready.** Every pilot completed with no dropped ids, no degraded ingest, no proxy refusals and no tripwires.
Every returned item carried exact provenance (one note per session).

## What ran

- Shim: `eval/systems/basic-memory` at the lane branch (Basic Memory 0.23.2), on the integration branch
  `capy/oss-memory-shootout` harness. The live conformance suite (`SHIM_URL=… bun test
  test/eval/systems-conformance.test.ts`) passed 11/11 for the recipe configuration before the pilots.
- Runner: `bun eval/runner/memory-qa/run.ts --benchmark <b> --system <shim URL> --qa reader --context native
  --policy vendor-default --paid --budget-run-id <id>`, with the runner's preregistered readers and judges. Reader
  and judge calls went through the same metering proxy as the shim (`OPENAI_BASE_URL=http://127.0.0.1:<port>/reader/openai/v1`),
  one proxy lease run and one ledger file per pilot, $5 lease each.
- Slices:
  - LoCoMo dev: `--shard 0/3`. The dev split has three conversations, so shard 0 of 3 is exactly one conversation,
    `conv-44` (28 sessions, 675 turns, 158 questions including 35 abstention questions).
  - LongMemEval-S: `--categories multi-session --limit 1`, which picks question `2318644b`, one haystack of 41 sessions.
  - BEAM-100K dev: `--shard 0/6`, conversation `100k-1` (78 sessions, 188 turns, 20 questions).
- Dollars, tokens and request counts come from the proxy usage logs. The receipts' `cost.usd` reads $0 because the
  runner ledger does not see requests sent to the proxy URL.

## Results

| Run | Config | Questions (scored) | Ingest $ | Ingest min | Reader+judge $ per question | Retrieval p50 / p95 ms | recall_all@5 | recall_any@5 | QA |
|---|---|---|---|---|---|---|---|---|---|
| `pilot-bm-locomo-recipe` | recipe | 158 (123) | $0 (no provider calls) | 0.8 | $0.00175 | 104 / 174 | 0.675 | 0.870 | 0.671 |
| `pilot-bm-locomo-common` | common | 158 (123) | $0.0033 (510 embedding calls) | 2.4 | $0.00217 | 337 / 586 | 0.642 | 0.862 | 0.684 |
| `pilot-bm-lme-common` | common | 1 (1) | $0.014 (697 embedding calls) | 4.5 embedding, plus 28.3 runner start-up | $0.065 | 500 | 0 | 1 | 1 |
| `pilot-bm-beam-common` | common | 20 (18) | $0.0156 (765 embedding calls) | 4.8 | $0.0068 | 381 / 512 | 0.556 | 0.778 | 0.559 |

Readers and judges: LoCoMo `gpt-4o-mini` reader and `gpt-4o-2024-08-06` judge; LongMemEval-S `gpt-4o-2024-08-06`
for both; BEAM `gpt-4.1-mini` for both. Recall is strict session recall over the scored, non-abstention questions;
QA is the judge's score over all rows. Outcomes: every row `scored`, no reader, judge or retrieval errors.

Observations that matter for Phase 4:

- **Items per question.** The recipe returned the full 10 notes for every question. The common configuration returned
  8.5 on average on LoCoMo and 9.2 on BEAM, because text-embedding-3-large scores fall under Basic Memory's default
  `semantic_min_similarity` of 0.55 more often (see README, metered smoke).
- **Context size.** The reader saw a median of 1,979 tokens (recipe) and 6,532 tokens (common) on LoCoMo, 14,113
  on BEAM and 28,467 on the LongMemEval-S haystack: Basic Memory returns long matched chunks of whole sessions, so
  the 8,000-token fixed-evidence budget will truncate it on BEAM and LongMemEval-S.
- **LongMemEval-S start-up.** The 28 minutes before the first embedding call are the harness, not Basic Memory:
  `new Sanitizer(corpus)` takes 1,700 seconds on the LongMemEval-S corpus (reproduced with `--system fake`, 1,710
  seconds for one question). It is paid once per runner process. One request in that run got HTTP 503 from
  OpenAI and LiteLLM's retry succeeded; ingest stayed `known`.
- **Ingest is serial.** `parallel_namespaces` is false, so haystacks run one after another; embedding one
  LongMemEval-S haystack took 4.5 minutes.

## Phase 4 extrapolation

Per-item inputs: the reader+judge cost per question and the ingest cost per conversation or haystack measured above.
Question counts: LoCoMo dev 587 (158 + 190 + 239), BEAM-100K dev 120, LongMemEval-S 100. The recipe arm runs LoCoMo
and BEAM only. One "reading arm" is one policy and one context mode; the plan runs both policies and both context
modes, so four reading arms per configuration, with ingest paid once per configuration and dataset if the arms reuse
it (else four times; for Basic Memory that changes the total by about $4).

| Item | Arithmetic | Per reading arm | Four arms |
|---|---|---|---|
| LoCoMo recipe reading | 587 × $0.00175 | $1.03 | $4.11 |
| LoCoMo common reading | 587 × $0.00217 | $1.27 | $5.10 |
| BEAM recipe reading | 120 × $0.0068 (common's rate; recipe contexts are shorter) | $0.82 | $3.28 |
| BEAM common reading | 120 × $0.0068 | $0.82 | $3.28 |
| LongMemEval-S common reading | 100 × $0.065 | $6.54 | $26.16 |
| Ingest, common | 3 × $0.0033 + 6 × $0.0156 + 100 × $0.014 | | $1.50 |
| Ingest, recipe | no provider calls | | $0 |
| **Total** | | | **about $43** |

Fixed-evidence packs up to 8,000 tokens, more than the vendor-default context on LoCoMo and less on BEAM and
LongMemEval-S, so its reading cost may differ from these rates by up to a factor of about 2 in either direction.
Wall time on one VM: LongMemEval-S dominates at about 100 × 4.5 minutes of embedding (7.5 hours serial) plus the
harness start-up; LoCoMo and BEAM take minutes per conversation.
