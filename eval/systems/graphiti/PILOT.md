# Graphiti Phase 2 pilot (2026-10-05)

These are setup measurements, not results. Each run covers one conversation or one haystack, so its recall and QA
numbers can only show whether the pipeline works end to end and what it costs. They are not estimates of Graphiti's
quality and must not be quoted as scores. Counted cells come from the preregistered Phase 4 matrix.

## What ran

`graphiti-core` 0.30.2 on Neo4j 5.26 ran behind this directory's shim through the memory-qa runner:

```bash
bun eval/runner/memory-qa/run.ts --system http://127.0.0.1:8701 --qa reader --context native --policy vendor-default \
  --paid --budget-run-id <id> --output <dir> --benchmark <locomo|lme-s|beam-100k> <selection>
```

- **Selection.** LoCoMo dev used `--shard 0/3`, which ingests exactly one conversation (`conv-44`: 28 sessions, 675
  turns, 158 questions, 35 of them adversarial abstentions). LongMemEval-S used `--categories multi-session --limit 1`
  (one haystack, 41 sessions, one question). BEAM-100K dev used `--shard 0/6` (one conversation, 78 sessions,
  20 questions).
- **Configurations.** LoCoMo ran three ways: common with one episode per session (the shim default), common with one
  episode per message (Zep's harness granularity, `SHIM_GRANULARITY=message`), and recipe (`gpt-5.5` main model) with
  one episode per session. LongMemEval-S and BEAM ran common, one episode per session.
- **Policy and context.** `vendor-default`: `search_()` with its default `COMBINED_HYBRID_SEARCH_CROSS_ENCODER` recipe
  at limit 10 per result class, entity provenance through `MENTIONS`; native item text, no evidence budget.
- **Reader and judge.** The runner's preregistered defaults: LoCoMo `gpt-4o-mini` reads and `gpt-4o-2024-08-06` judges;
  LongMemEval-S `gpt-4o-2024-08-06` for both; BEAM-100K `gpt-4.1-mini` for both.
- **Metering.** Each run had its own metering proxy in lease mode with its own ledger: $5 leases, $12 for the recipe.
  The runner's reader and judge calls went through the same proxy (slot `reader`), so the proxy log separates vendor
  dollars from reading dollars. No run had a proxy refusal or a tripwire.
- **Code.** The three LoCoMo runs used harness `f95e114` and shim `cfe5837`; LongMemEval-S and BEAM used harness
  `87ff166` and shim `c732e96` (knobs under `settings`). In each case the shim's policy format matched what that harness
  sent.

## Results per run

Recall counts the 123 LoCoMo questions with gold sessions (abstentions excluded). QA counts every question,
abstentions included. "Ingest" is the vendor's spend before the first reader call. Latency is the shim's `service_ms`
around `search_` plus the provenance lookups.

| Run | Outcomes | Ingest | Strict recall@5 (all gold) | Any-gold recall@5 | QA | Latency p50 / p95 | Vendor per question | Reader + judge per question | Total |
|---|---|---|---|---|---|---|---|---|---|
| LoCoMo, common, session episodes | 157 scored, 1 retrieval error | $0.46, 7.4 min | 0.569 | 0.764 | 0.726 (service 0.722) | 2.6 s / 6.0 s | $0.0013 | $0.0026 | $1.08 |
| LoCoMo, common, message episodes | 158 scored | $1.77, 47.4 min | 0.618 | 0.837 | 0.627 | 2.1 s / 5.3 s | $0.0007 | $0.0016 | $2.14 |
| LoCoMo, recipe (`gpt-5.5`), session episodes | 158 scored | $4.10, 7.3 min | 0.634 | 0.854 | 0.696 | 2.2 s / 5.6 s | $0.0013 | $0.0027 | $4.72 |
| LongMemEval-S, one multi-session haystack, common | 1 scored | $1.54, 9.1 min | 1 of 1 | 1 of 1 | 1 of 1 | 1.5 s | (in ingest) | $0.084 | $1.63 |
| BEAM-100K `100k-1`, common | 20 scored | $1.60, 11.4 min | 0.056 | 0.278 | 0.537 | 2.3 s / 4.1 s | $0.0014 | $0.0086 | $1.81 |

- **Outcomes.** No dropped ids, no degraded ingest, no finish timeouts. The one retrieval error (LoCoMo common,
  session) came from the cross-encoder: OpenAI answered five reranker calls with 503 and one with a 200 whose body
  neither the proxy nor the SDK could parse; graphiti-core's reranker does not retry, so `search_` failed and the
  harness counted a product failure.
- **Provenance.** About two thirds of items were `exact` (facts and episodes) and one third `partial` (entity nodes
  through `MENTIONS`), none unavailable. Mean fan-out was 1.8 to 2.0 sources per item on LoCoMo and LongMemEval-S and
  3.0 on BEAM, where entities appear across many sessions. High fan-out is a plausible reason for BEAM's low strict
  recall (0.056) beside a QA of 0.537, since strict recall charges each item for every source it cites; this pilot
  does not verify that.
- **Context size.** Native contexts are large because episode items carry whole sessions: mean reader context 9,500
  tokens on LoCoMo (session episodes), 1,400 with message episodes, 18,000 on BEAM and 37,000 on LongMemEval-S. Reader
  cost per question follows.
- **Granularity on a real conversation.** Message episodes cost 3.9 times the ingest dollars and 6.4 times the ingest
  time of session episodes on `conv-44`, gave higher strict recall (0.618 against 0.569) and lower QA (0.627 against
  0.726): the reader gets short single-turn episodes instead of whole sessions.
- **Recipe.** The `gpt-5.5` recipe costs 8.9 times the common config's ingest on the same conversation ($4.10 against
  $0.46; 82 `gpt-5.5` calls cost $4.06). Its largest single reservation was $0.75, because graphiti-core asks for
  16,384 output tokens.

## Per-item costs for Phase 4

| Item | Common, session episodes | Recipe, session episodes |
|---|---|---|
| Ingest, one LoCoMo conversation | $0.46, 7.4 min (message episodes: $1.77, 47 min) | $4.10, 7.3 min |
| Ingest, one LongMemEval-S haystack (41 sessions here) | $1.54, 9.1 min | not run (recipe arm is off LME-S) |
| Ingest, one BEAM-100K conversation (78 sessions) | $1.60, 11.4 min | not run; scaled by the LoCoMo ratio 8.9x: about $14.3 |
| Vendor cost per question, vendor-default (cross-encoder, limit 10) | $0.0013 to $0.0014 | $0.0013 |
| Reader + judge per question, native context | LoCoMo $0.0026, LME-S $0.084, BEAM $0.0086 | LoCoMo $0.0027 |

## Phase 4 extrapolation

The matrix is the plan's: LoCoMo dev (3 conversations, 587 questions, ingested twice for run-to-run variance) and
BEAM-100K dev (6 conversations, 120 questions) in both configs, LongMemEval-S (100 haystacks, 100 questions) in the
common config only, all with session episodes. Each question is retrieved under both policies and read in both context
modes (four reader and judge passes). The fixed-evidence policy (limit 50 per class) was not piloted; its cross-encoder
cost is assumed to be 5 times vendor-default's, since the reranker makes one call per candidate. Reader cost per
question is the measured native-context cost; source-rehydrated contexts are packed to the evidence budget and will
likely cost less than Graphiti's large native contexts.

| Benchmark | Config | From pilot | Ingest | Vendor query | Reader + judge | Subtotal | Ingest minutes, serial |
|---|---|---|---|---|---|---|---|
| LoCoMo dev | recipe | LoCoMo recipe | $24.59 | $4.54 | $6.27 | $35.41 | 44 |
| LoCoMo dev | common | LoCoMo common, session | $2.75 | $4.47 | $6.18 | $13.40 | 44 |
| BEAM-100K dev | common | BEAM common | $9.63 | $1.04 | $4.14 | $14.80 | 68 |
| BEAM-100K dev | recipe | BEAM common, ingest scaled 8.9x | $85.98 | $1.04 | $4.14 | $91.15 | 68 |
| LongMemEval-S 100 | common | LME-S common (vendor query from LoCoMo) | $154.25 | $0.78 | $33.56 | $188.59 | 910 |
| **Total** | | | | | | **about $343** | |

Two lines dominate: LongMemEval-S ingestion ($1.54 per haystack: 3.9 million input tokens for 41 sessions, consistent with
each extraction prompt carrying the previous 10 episodes, and LongMemEval-S sessions are long) and the recipe arm on BEAM (scaled, not measured). With
the plan's whole Phase 4 line at $380 for every system, Graphiti alone would use most of it. Options for the
preregistration: drop the recipe arm from BEAM (saves about $91), cap LongMemEval-S for Graphiti at a smaller
stratified slice, or measure one BEAM recipe conversation before deciding. Message episodes on LoCoMo would add about
$16.95 per config instead of $13.40 and 284 serial ingest minutes; they are not in this total.

Ingest time is about 15 hours serial for LongMemEval-S; namespaces can run in parallel (`parallel_namespaces: true`),
so a cell VM running 8 at once needs about 2 hours, subject to provider rate limits on `gpt-4.1-mini`.

## Problems found and fixed

- **Policy settings.** The first launch sent the runner's whole policy object as `policy.settings`, and the shim
  refused every retrieval as `unsupported`. The knobs now sit under `retrieval_policies.<mode>.settings`, as
  PROTOCOL.md specifies. That attempt spent $0.26 on ingest before it was stopped.
- **Offset-less times.** Live conformance sends ISO times without an offset; the shim now reads them as UTC.
- **Harness, LongMemEval-S.** The forbidden-marker scan ran for 15 minutes at full CPU before any provider call (fixed
  by the harness lane in `e73bb48`); the rerun above used the fixed harness.
- **Harness, BEAM.** BEAM sessions first arrived with `event_time: null`; Graphiti's `add_episode` needs a reference
  time and the shim refuses to invent one, so all 78 sessions failed and the conversation was marked
  `ingest_degraded` ($0.014). The harness now supplies disclosed synthetic times (75 of 78 sessions in this
  conversation), and the BEAM row above is the rerun.
- **Delete residue.** `protocol_check` passes 31 of 32 checks against the keyless fake provider. The miss is "deleted
  fact no longer in text": after `remove_episode`, text from the deleted session can survive in an entity summary or
  in a fact Graphiti first stored from another session. That is Graphiti's own delete behaviour, which P2 measures;
  the shim does not repair it.
- **Machine sleep.** One launch died when the lane machine slept, after $0.06 of ingest; it was rerun from scratch.

Spend in this pilot, all through metered leases: $11.37 in the five runs above and $0.34 in the attempts listed here.

## Reproduce and inspect

`eval/systems/graphiti/docker-compose.yml` with `SHIM_CONFIG`, `SHIM_GRANULARITY`, `PROXY_URL` and `PROXY_OPENAI_PATH`,
a metering proxy per run (`bun eval/runner/metering-proxy.ts --listen 0.0.0.0:<port> --budget-ledger <file>
--lease-usd <cap> --run-id <id>`), then the runner command above. Datasets come from
`bun run eval:decide fetch --benchmark <name>`. Receipts, rows, attempts, proxy usage logs and shim logs are on the lane
machine under `~/.capy/work/shootout/pilots/` and `~/.capy/work/shootout/usage-*.ndjson`; rows contain dataset text,
so they are not committed.
