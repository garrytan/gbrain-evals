# Cognee Phase 2 pilots, 2026-10-05

These pilots check that cognee 1.6.2 runs end to end through the shootout harness and measure what it costs. The scores
below are setup evidence from one conversation or one haystack each. They are not results and must not be quoted as
cognee's accuracy.

All four runs used the `memory-qa` runner from the integration branch `capy/oss-memory-shootout` (`f95e114`, plus this
lane's commits up to `c44a46b`). Every run had the `vendor-default` policy, `native` context and `--qa reader` with the
runner's preregistered reader and judge. Provider calls from the shim and from the reader went through one metering
proxy run per pilot (`eval/runner/metering-proxy.ts`, lease mode, $5 lease each). The machine was a 4-core Capy cloud
machine running the shim in Docker. Per-run summaries (counts and usage, no dataset text) are in
[pilot-2026-10-05/](pilot-2026-10-05/). They were made with [tests/pilot_summary.py](tests/pilot_summary.py).

## What ran

| Pilot | Selection | Config | Sessions | Turn pairs (cognee chunks) | Questions |
|---|---|---|---|---|---|
| LoCoMo dev | `--split dev --shard 0/3` (conversation `conv-44`, all its questions) | recipe | 28 | 343 | 158 |
| LoCoMo dev | same | common | 28 | 343 | 158 |
| LongMemEval-S | `--categories multi-session --limit 1` (haystack `2318644b`) | common | 41 | 263 | 1 |
| BEAM-100K dev | `--split dev --shard 0/6` (conversation `100k-1`, all its questions) | common | 78 | 94 | 20 |

`--shard 0/n` was used because `--limit` draws a category-stratified sample across every dev conversation, so it cannot
pin one conversation.

## Measurements

Dollars and tokens come from the proxy's usage log. Ingest is every shim request before the first reader request.
Cognee's retrieval makes only embedding calls, so this split is exact. Latency is the runner's `retrieve` wall time.

| | LoCoMo recipe | LoCoMo common | LME-S common | BEAM-100K common |
|---|---|---|---|---|
| Outcomes | 158 scored | 158 scored | 1 scored | 20 scored |
| Failed or degraded ingest | 0 of 28 sessions | 0 of 28 | 0 of 41 | 0 of 78 (after the fix below) |
| Ingest LLM | `gpt-5.6-luna`, 687 calls, 430k in / 227k out | `gpt-4.1-mini`, 687 calls, 432k / 111k | `gpt-4.1-mini`, 527 calls, 501k / 227k | `gpt-4.1-mini`, 189 calls, 337k / 83k |
| Ingest embeddings (`text-embedding-3-large`) | 294 calls, 149k tokens | 270 calls, 134k | 464 calls, 285k | 499 calls, 183k |
| **Ingest dollars** | **$0.378** (repeat: $0.377) | **$0.369** | **$0.600** | **$0.291** |
| Ingest minutes (provider activity) | 6.5 | 3.0 | 8.5 | 8.7 |
| Ingest dollars per turn pair | $0.00110 | $0.00108 | $0.00228 | $0.00309 |
| Reader and judge | `gpt-4o-mini` + `gpt-4o` | same | `gpt-4o` + `gpt-4o` | `gpt-4.1-mini` + `gpt-4.1-mini` (rubric) |
| **Reader + judge dollars per question** | **$0.00168** | **$0.00167** | **$0.0206** | **$0.00885** |
| Query-time embeddings per question | $0.000003 | $0.000003 | under $0.0001 | $0.000005 |
| Retrieval latency p50 / p95 | 0.85 s / 3.4 s | 0.73 s / 1.18 s | 0.81 s (one query) | 0.68 s / 0.81 s |
| Native context, mean tokens | 2,065 | 1,946 | 7,575 | 18,859 |
| Items per question | 30 (10 chunks, 10 entities, 10 facts) | 30 | 30 | 30 |
| Provenance mix | 1/3 exact (chunks), 2/3 unavailable (entities, facts) | same | same | same |
| Proxy refusals, tripwires | 0, 0 | 0, 0 | 0, 0 | 0, 0 |
| Setup-only scores | recall_all@5 0.75, recall_any@5 0.94, QA 0.73 | 0.70, 0.91, QA 0.71 | 1.0, 1.0, QA 1.0 | 0.44, 0.78, QA 0.53 |

The LoCoMo recipe conversation ingested twice, because the first attempt failed at retrieval (below). The two ingest
costs, $0.377 and $0.378, are a first run-to-run variance sample.

## Problems found

1. **Shim, fixed (`04e55e3`).** The runner passes a policy's whole `retrieval_policies` entry as its settings. The shim
   rejected the descriptive keys, so the first LoCoMo recipe attempt ended with 158 `harness_invalid` rows. That attempt
   was not dropped; it is kept under `~/.capy/work`. The policies are now flat settings plus an ignored `maps_to`.
2. **Shim, fixed (`c44a46b`).** BEAM dates (`March-15-2024`) do not parse in `isoSessionDate`, so every BEAM session
   reached the shim with `event_time: null` and `synthetic_time: false`. The shim rejected null dates, so the first BEAM
   attempt was 20 `ingest_degraded` rows from 78 failed sessions. The protocol allows null, so the shim now writes
   `Time anchor: unknown`. **The BEAM numbers above therefore had no session dates.** Treat its temporal and
   event-ordering behavior as unmeasured until the harness parses BEAM dates.
3. **Harness: dates.** `isoSessionDate` needs BEAM's `Month-DD-YYYY` format. Only the first session of a BEAM batch
   carries a date, so `ingestPlan`'s synthetic fill has nothing to anchor to. The engineering review predicted this
   (finding C6).
4. **Harness: 28-minute start on LongMemEval-S.** The runner started at 20:14:37 UTC and cognee created the dataset at
   20:43:02, with no provider calls in between. Building `new Sanitizer(corpus)` for the full LongMemEval-S corpus ran
   past 10 minutes in a standalone test. The LME-S 100 matrix pays that on every run unless it is fixed.
5. **Harness: lost errors.** The runner counts failed ingest sessions but does not record their error messages, so the
   BEAM failure needed a manual reproduction to diagnose.
6. **Harness: paid guard ignores `--budget-ledger`.** `run.ts` calls `requirePaidArm` without a ledger path, so the guard
   reads only `.budget/ledger.sqlite`. These pilots used that default ledger (gitignored), with a recorded $20 program
   cap.
7. **Harness: active config not in the receipt.** The LoCoMo recipe and common runs have the same `run_config_hash`
   (`5b18fe8f4ddf`). The receipt does not record the shim's `/health` (active `SHIM_CONFIG`, resolved models). Fold
   `/health` into the receipt and the run hash, or a recipe row and a common row can share an output directory.

## Phase 4 cost for cognee, extrapolated

Assumptions: ingest cost scales with turn pairs within a dataset, because cognee makes one extraction pass per chunk
and the shim makes one chunk per turn pair. Recipe ingest on BEAM is scaled by the LoCoMo recipe-to-common ratio
(1.024), because BEAM had no recipe pilot. LoCoMo dev ingests twice, as the plan requires. One reader-and-judge pass
per question is counted; each extra context mode or budget repeats only that cost, not ingest.

| Set | Size | Ingest | Reader + judge, per pass |
|---|---|---|---|
| LoCoMo dev, common | 3 conversations, 1,045 turn pairs, ingested twice | 2 × 1,045 × $0.00108 = $2.25 | 587 × $0.00167 = $0.98 |
| LoCoMo dev, recipe | same | 2 × 1,045 × $0.00110 = $2.30 | $0.99 |
| BEAM-100K dev, common | 6 conversations, 694 turn pairs | 694 × $0.00309 = $2.15 | 120 × $0.00885 = $1.06 |
| BEAM-100K dev, recipe | same | $2.20 | $1.06 |
| LME-S 100, common only | 100 haystacks, mean 249 turn pairs | 100 × 249 × $0.00228 = $57 (by characters: $63) | 100 × $0.0206 = $2.06 |
| **Total** | | **about $66 to $72** | **about $6.15 per pass** |

With the plan's two budgets and two context modes as four reader passes over the same retrievals, cognee's Phase 4
share is about **$91 to $97**. LongMemEval-S ingest is about 85% of the ingest and about 60% of that total. The D2-A frontier-reader replays are extra and
priced per reader, not per system.

Time: one container ingests serially (`parallel_namespaces: false`). LME-S 100 at about 8 minutes per haystack is about
14 hours of ingest on one container, plus the 28-minute sanitizer start per run. It should run as several
containers, one per shard. LoCoMo dev is about 10 minutes per ingest on common and 20 on recipe; BEAM dev is about one
hour.

## Reproduce

From the repository root, with datasets fetched (`bun eval/runner/decide.ts fetch --benchmark <b>`), a ledger opened
(`bun eval/runner/budget-ledger.ts open --runner <name> --budget-usd 5`), the metering proxy listening on
`0.0.0.0:8787` and the shim up (`SHIM_CONFIG=<config> PROXY_HOSTPORT=host.docker.internal:8787 docker compose -f
eval/systems/cognee/docker-compose.yml up -d --wait`):

```bash
OPENAI_BASE_URL=http://127.0.0.1:8787/reader/openai/v1 bun eval/runner/memory-qa/run.ts \
  --benchmark locomo --split dev --shard 0/3 --system http://127.0.0.1:8701 \
  --policy vendor-default --context native --qa reader --paid --budget-run-id <id> --output <dir>
python3 eval/systems/cognee/tests/pilot_summary.py <dir> <proxy usage log>
```

The other pilots swap in `--benchmark lme-s --categories multi-session --limit 1` and
`--benchmark beam-100k --shard 0/6`.
