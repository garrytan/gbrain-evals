# Hindsight Phase 2 pilot (2026-10-05)

These are setup measurements, not results. Each run covers one conversation or one haystack, so its recall and QA
numbers can only show whether the pipeline works end to end and what it costs. They are not estimates of Hindsight's
quality and must not be quoted as scores. Counted cells come from the preregistered Phase 4 matrix.

## What ran

Hindsight 0.10.2 ran behind this directory's shim (`capability.json`, both configs) through the memory-qa runner:

```bash
bun eval/runner/memory-qa/run.ts --system http://127.0.0.1:8700 --qa reader --context native --policy vendor-default \
  --paid --budget-run-id <id> --output <dir> --benchmark <locomo|lme-s|beam-100k> <selection>
```

- **Selection.** LoCoMo dev used `--shard 0/3`, which ingests exactly one conversation (`conv-44`: 28 sessions, 675
  turns, 158 questions, 35 of them adversarial abstentions). LongMemEval-S used `--categories multi-session --limit 1`
  (one haystack, 41 sessions, one question). BEAM-100K dev used `--shard 0/6` (one conversation, 78 sessions,
  20 questions).
- **Policy and context.** `vendor-default` (`budget` mid, `max_tokens` 4096, no chunks, `query_timestamp` set), native
  item text, no evidence budget (`--budget-tokens` unset).
- **Reader and judge.** The runner's preregistered defaults: LoCoMo `gpt-4o-mini` reads and `gpt-4o-2024-08-06` judges;
  LongMemEval-S `gpt-4o-2024-08-06` for both; BEAM-100K `gpt-4.1-mini` for both.
- **Metering.** Each run had its own metering proxy in lease mode, with its own ledger and a $5 lease. Hindsight's
  provider calls came through the compose egress relay; the runner's reader and judge calls went through the same
  proxy (`OPENAI_BASE_URL`, dummy key, slot `reader`), so the proxy log separates vendor dollars from reading dollars.
  No run had a proxy refusal or a tripwire.
- **Code.** Harness from `capy/oss-memory-shootout` at `f95e114` for the LoCoMo and LongMemEval-S runs (LongMemEval-S
  with a local, uncommitted fix for the forbidden-marker scan, see below) and at `87ff166` for BEAM. Shim at this
  lane's `cfe5837` for LoCoMo and LongMemEval-S and `c732e96` (knobs under `settings`) for BEAM; in each case the
  shim's policy format matched what that harness sent.

## Results per run

Recall counts the 123 LoCoMo questions with gold sessions (abstentions excluded). QA counts every question,
abstentions included. "Ingest" is the vendor's spend before the first reader call. Latency is the shim's `service_ms`
around `recall`.

| Run | Outcomes | Ingest | Strict recall@5 (all gold) | Any-gold recall@5 | QA | Latency p50 / p95 | Reader + judge per question | Total |
|---|---|---|---|---|---|---|---|---|
| LoCoMo `conv-44`, common | 158 scored | $0.096, 4.3 min, 54 extraction calls | 0.715 | 0.894 | 0.728 | 4.2 s / 5.4 s | $0.0027 | $0.52 |
| LoCoMo `conv-44`, recipe | 158 scored | $0.034, 3.9 min | 0.675 | 0.902 | 0.703 | 3.9 s / 4.7 s | $0.0029 | $0.49 |
| LongMemEval-S, one multi-session haystack, common | 1 scored | $0.42, 8.0 min, 246 extraction calls | 1 of 1 | 1 of 1 | 1 of 1 | 5.4 s | $0.021 | $0.44 |
| BEAM-100K `100k-1`, common | 20 scored | $0.49, 10.5 min | 0.389 | 0.667 | 0.526 | 5.8 s / 7.3 s | $0.0053 | $0.59 |

- **Outcomes.** No dropped ids, no retrieval, reader or judge errors, no degraded ingest, no finish timeouts.
- **Provenance.** Every returned item was `exact` (one source per item, fan-out 1.0), because every recall result
  carries its `document_id`. Items per question averaged 110 (LoCoMo common), 160 (LoCoMo recipe), 76 (LongMemEval-S)
  and 80 (BEAM); the native contexts averaged 6,000 to 7,700 tokens.
- **Query-time vendor cost.** About zero. Recall makes one embedding call in the common config, under $0.00002 per
  question, and none in the recipe config, whose embedder and reranker are local.
- **BEAM times.** 75 of 78 sessions carry the harness's disclosed synthetic times (BEAM dates almost no sessions).

## Per-item costs for Phase 4

| Item | Common | Recipe |
|---|---|---|
| Ingest, one LoCoMo conversation (about 28 sessions, 80k characters) | $0.096, 4.3 min | $0.034, 3.9 min |
| Ingest, one LongMemEval-S haystack (41 sessions here; haystacks run about 500k characters) | $0.42, 8.0 min | not run (recipe arm is off LME-S) |
| Ingest, one BEAM-100K conversation (78 sessions, 520k characters) | $0.49, 10.5 min | not run; scaled from the LoCoMo ratio (0.35x): about $0.17 |
| Vendor cost per question | under $0.0001 | $0 |
| Reader + judge per question, native context | LoCoMo $0.0027, LME-S $0.021, BEAM $0.0053 | LoCoMo $0.0029 |

## Phase 4 extrapolation

The matrix is the plan's: LoCoMo dev (3 conversations, 587 questions, ingested twice for run-to-run variance) and
BEAM-100K dev (6 conversations, 120 questions) in both configs, LongMemEval-S (100 haystacks, 100 questions) in the
common config only. Each question is retrieved under both policies and read in both context modes (four reader and
judge passes). Reader cost per question is the measured native-context cost; source-rehydrated contexts are packed to
the evidence budget and may cost more or less.

| Benchmark | Config | From pilot | Ingest | Vendor query | Reader + judge | Subtotal | Ingest minutes, serial |
|---|---|---|---|---|---|---|---|
| LoCoMo dev | recipe | LoCoMo recipe | $0.20 | $0 | $6.72 | $6.92 | 23 |
| LoCoMo dev | common | LoCoMo common | $0.58 | $0 | $6.29 | $6.87 | 26 |
| BEAM-100K dev | common | BEAM common | $2.92 | $0 | $2.55 | $5.48 | 63 |
| BEAM-100K dev | recipe | BEAM common, ingest scaled by 0.35 | $1.03 | $0 | $2.55 | $3.58 | 63 |
| LongMemEval-S 100 | common | LME-S common | $41.88 | $0 | $8.24 | $50.12 | 800 |
| **Total** | | | | | | **about $73** | |

LongMemEval-S ingestion dominates: 100 haystacks of about half a million characters each, at $0.42 per haystack.
Ingest time is about 13 hours serial for LongMemEval-S; namespaces can run in parallel
(`parallel_namespaces: true`), so a cell VM running 8 at once needs under 2 hours.

## Problems found and fixed

- **Policy settings.** The first launch sent the runner's whole policy object (knobs plus notes) as `policy.settings`,
  and the shim refused every retrieval as `unsupported` (158 of 158). The knobs now sit under
  `retrieval_policies.<mode>.settings`, as PROTOCOL.md specifies, and the shim accepts exactly those. That attempt
  spent $0.10 on ingest.
- **Offset-less times.** Live conformance sends ISO times without an offset; the shim now reads them as UTC.
- **Harness, LongMemEval-S.** `forbiddenMarkers` scanned the joined corpus once per candidate id, which on
  LongMemEval-S (about 20,000 ids, 250 MB) runs for hours before the first call. This run used a local exact one-pass
  scan; the harness lane has since replaced it with a linear scan (`e73bb48`).
- **Harness, BEAM.** BEAM sessions first arrived with `event_time: null`, which the shim refuses rather than dating
  facts to the wall clock; all 78 sessions failed and the conversation was correctly marked `ingest_degraded`. The
  harness now supplies disclosed synthetic times (`e73bb48`), and the BEAM row above is the rerun.
- **Machine sleep.** One launch died when the lane machine slept, after $0.04 of ingest; it was rerun from scratch.

Spend in this pilot, all through metered leases: $2.04 in the four runs above and $0.14 in the attempts listed here.

## Reproduce and inspect

`eval/systems/hindsight/docker-compose.yml` with `SHIM_CONFIG`, `PROXY_URL` and `PROXY_OPENAI_PATH`, a metering proxy
per run (`bun eval/runner/metering-proxy.ts --listen 0.0.0.0:<port> --budget-ledger <file> --lease-usd 5 --run-id <id>`),
then the runner command above. Datasets come from `bun run eval:decide fetch --benchmark <name>`. Receipts, rows,
attempts, proxy usage logs and shim logs are on the lane machine under `~/.capy/work/shootout/pilots/` and
`~/.capy/work/shootout/usage-*.ndjson`; rows contain dataset text, so they are not committed.
