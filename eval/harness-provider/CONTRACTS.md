# Harness lane contracts

Internal interface notes for the code under `eval/harness-provider/` and the
TypeScript launcher in `eval/runner/harness-*.ts`. The user-facing guide is
`docs/benchmarks/harness-quickstart.md`.

## Naming

The comparator is "the comparator" everywhere: provider id `comparator`,
output directories `comparator`, receipts `comparator`. Its product name and
its maker's name are never written in this repository. Python code resolves
the harness registry key, package names and environment variable prefixes at
runtime through `mpw.names` (sha256 match against `harness.lock.json`).
`scripts/check-comparator-name.ts` fails CI when either name appears.

## Processes

```
bun eval/runner/harness-cell.ts  (launcher: cell id, budget run, metering proxy in-process)
  ├─ python -m mpw.cell run      (harness process; label "harness")
  │    ├─ bun <gbrain>/src/cli.ts serve   (stdio MCP per unit; label "gbrain")
  │    └─ comparator server               (pinned release; label "comparator")
  └─ metering proxy  ──►  api.openai.com | api.anthropic.com | generativelanguage.googleapis.com | api.groq.com | api.voyageai.com
```

Every child gets a clean environment (`harnessProcessEnv`), never the
launcher's. Provider keys in a child are proxy tokens (`mpwp-<label>-<hex>`),
never real keys, so a request that skips the proxy fails with 401 upstream
and costs nothing. Base URLs:

| Provider | Child env | Proxy path prefix | Upstream |
|---|---|---|---|
| OpenAI | `OPENAI_BASE_URL=<proxy>/openai/v1`, `OPENAI_API_KEY` | `/openai` | `https://api.openai.com` |
| Anthropic | `ANTHROPIC_BASE_URL=<proxy>/anthropic`, `ANTHROPIC_API_KEY` | `/anthropic` | `https://api.anthropic.com` |
| Gemini | `GOOGLE_GEMINI_BASE_URL=<proxy>/gemini`, `GEMINI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY` | `/gemini` | `https://generativelanguage.googleapis.com` |
| Groq | `GROQ_BASE_URL=<proxy>/groq`, `GROQ_API_KEY` | `/groq` | `https://api.groq.com` |
| Voyage | gbrain `provider_base_urls.voyage=<proxy>/voyage/v1`, `VOYAGE_API_KEY` | `/voyage` | `https://api.voyageai.com` |

## Metering proxy (`eval/runner/harness-metering-proxy.ts`)

```ts
startMeteringProxy({
  run,              // BudgetRun from budget-ledger.ts (the one shared SQLite ledger)
  cellId,           // named in refusals and receipts
  requestLogPath,   // JSONL: one line per request (label, tag, provider, model, kind, reserved, actual, tokens, status, refused)
  bodiesDir,        // exact request bodies, <sha256>.json
  labels,           // process labels to mint tokens for
  upstreams?,       // test/stub override per provider
  realKeys?,        // default: process.env of the launcher
  port?,
}): Promise<{ url; port; tokens; envFor(label): Record<string,string>; stats(); close() }>
```

- Before dispatch: price with `priceRequest`, reserve on the run; a refused
  reservation answers HTTP 402 `{"error":{"type":"mpw_budget_refused","message":...}}`
  naming the cell, the committed spend, the cap and the non-spending next
  step, and nothing goes upstream. An unpriceable request is refused the same way.
- After the response: decode usage (JSON and SSE) and settle; undecodable
  usage charges the reservation.
- An optional `x-mpw-tag` request header is recorded and stripped.
- An unknown token answers 401 without dispatch.

Additions beyond the signature above (all additive): the returned object
also has `baseUrls` (proxy base URL per provider, for gbrain's
`provider_base_urls.voyage`), `exhausted` (true after any refusal) and
`lastRefusal` (the exact refusal text). Refusal bodies never contain 429,
500, 502, 503, 504, 529 or "rate", because the harness Gemini, OpenAI and
Groq clients retry on those substrings; a zero-width space breaks them.
Settlement: decoded usage reconciles; a 4xx without usage settles at $0
(the provider rejected it before doing work); anything else without usage
is charged at its reservation. Free requests (model listings, Gemini
countTokens) are forwarded without a reservation. The CLI form takes
`--upstream <provider>=<url>` for stubs.

`eval/runner/metering-proxy-testkit.ts` exports `createMeteredTestCell` and
`assertZeroBalanceBlocks({ label, spawn, trigger, stop })`, the per-process
zero-balance check (refused at zero balance with no upstream hit and no new
committed spend; reaches the stub and settles with budget). The comparator
server launcher must pass it under label `comparator`.

`eval/runner/stub-upstream.ts` serves deterministic OpenAI, Anthropic, Gemini,
Groq and Voyage responses (schema-valid structured output, hash embeddings,
usage blocks) for keyless tests, the mode smoke and the quickstart fixture.

## Launcher actions (`eval/runner/harness-cell.ts`)

| Action | Spends | What it does |
|---|---|---|
| `plan <spec>` | no | Resolve the schedule and manifest hashes in Python, compute the cell id, write `cell.json`, print the estimate |
| `run <spec\|id>` | yes | Refuses when stage receipts exist; opens a ledger run for the cell's remaining budget, starts the proxy, runs `python -m mpw.cell run` |
| `resume <id>` | yes | Recomputes the id and refuses on any change (names the fields); continues missing receipts only |
| `tune <id> --grid <json>` | retrieval only | `python -m mpw.tune` on the ingested store: delivered tokens per knob setting, no answer or judge call |
| `rejudge <id> <id>` | judge only | `python -m mpw.rejudge` through the proxy with the dataset's own judge |
| `cli -- <args>` | no | The harness's own CLI with the providers registered (keyless) |

`--stub-upstream` routes every provider to `eval/runner/stub-upstream.ts` against a throwaway ledger inside the cell.
`spend.json` accumulates every ledger run a cell made, so `resume` can only use what is left of `budget_usd`.

Cell gates (`summary.json`): `complete` (every scheduled question has a typed outcome and no judge failure or incomplete ingest), `no_answer_or_retrieval_failures`, `delivered_context` (mean and p95 within ±10% of `target_tokens`) and `no_remote_clamp` (gbrain's `budget_clamped` never set). A reader refusal is scored as an answer and kept in the record's `error`.

## Cell directory and records

See `mpw/records.py`. Stage files: `stages/{ingest,retrieve,answer,judge}/<id>.json`.

## Providers (`mpw/gbrain_provider.py`, `mpw/comparator_provider.py`)

Both subclass the harness `MemoryProvider`. Config comes from the
constructor argument or, when absent, `MPW_PROVIDER_CONFIG` (JSON). The cell
runner hands providers projected documents only: opaque ids
(`d-<hex>`), opaque units (`u-<hex>`), content/messages and the timestamp
the provenance manifest allows. Each provider may implement

```python
def retrieve_with_meta(self, query, k=10, user_id=None, query_timestamp=None) -> tuple[list[Document], dict | None, dict]
```

returning provider metadata (delivered tokens, clamp flags, knob values)
separately from `raw_response`, because the LongMemEval, LoCoMo and LifeBench
prompt builders substitute `json.dumps(raw_response)` for the context
whenever it is non-None.

## Comparator server (`mpw/comparator_server.py`, `comparator.lock.json`)

The comparator's current release runs as its own server, installed by
`bun run harness:comparator install` into `.harness/comparator/<version>/`
from `comparator.lock.json` (exact versions, sha256 per wheel, CPU torch,
local model weights at pinned revisions). The provider starts it in
`prepare()` and stops it in `cleanup()` (also atexit, and Linux
`PR_SET_PDEATHSIG` when started from the main thread); data lives in
`config.data_dir` (default `<store_dir>/comparator-server`), with the
embedded database under an isolated HOME there. `stop()` also reaps the
embedded database, which runs in its own session and survives a SIGKILL of
the server.

- LLM route: `MPW_CHILD_ENV_COMPARATOR` (the proxy's `envFor('comparator')`
  as JSON). The server gets `OPENAI_BASE_URL` / `OPENAI_API_KEY` from it as
  its LLM base URL and key and refuses a non-loopback base URL. Its
  extraction model is the server's documented default (`openai:gpt-4o-mini`
  at 0.10.2) unless `extraction_model` (`provider:model`) is set; only the
  `openai` route is wired.
- Embeddings, reranking and the database are local CPU work, reported as
  local compute in `receipt()`, not as spend. `receipt()["unmetered"]` lists
  anything that bypasses the proxy; at 0.10.2 it is empty (the server suite
  passes in a loopback-only network namespace).
- Provider config: `max_tokens` (facts budget), `max_chunk_tokens` (raw-chunk
  budget, 0 for facts only), `budget`, `extraction_model`, `server_url`,
  `data_dir`, `id_salt`, `startup_timeout_s`.
- Hooks: `retrieve_with_meta` (knob values, fact/chunk counts, bank),
  `reset_unit(unit)` (drops the unit's bank), `last_ingest_receipt(unit)`
  (documents and facts stored, `barrier_ms` spent waiting for the server's
  extraction queue, expected extraction calls, bank config, server receipt).
  Ingest returns only when the bank has no pending or failed operations and
  stores every document; otherwise it raises.
- Ids: every emitted id (documents, facts, chunks, source ids, banks, and any
  `*_id`/`*_ids` field or id-keyed map inside `raw_response`) is
  `c-<hex12>` = HMAC-sha256(salt, original); ids inside a document's
  `context` are hashed before the server sees them. `reverse_ids()` maps
  them back for the scorer only (the cell runner composes it with the
  projection's map for retrieval scoring). The salt (`id-salt`), the map
  (`reverse-ids.jsonl`) and the bank registry (`banks.json`) are kept in
  `data_dir`, so a resumed cell keeps its banks and ids.

## Scorer (`mpw/scorer.py`)

Typed outcomes from `mpw/records.py`; strict judge field validation; a fixed
scheduled denominator; BEAM rubric completeness. Published differences from
the harness scorer: `SCORER.md`.

```python
judge_answer(*, dataset, split, query, answer, judge_llm=None, expected_judge_model=None,
             cell_id, retrieved_original=None, cache_dir=None, retries=1) -> JudgeRecord
aggregate(scheduled_ids, records, cell_id=None) -> dict
resolve_judge_llm(dataset)           # dataset.default_judge_llm() else get_judge_llm()
map_retrieved(documents, id_map)     # RetrieveRecord dicts -> harness Documents, ids mapped back
```

- `query` is the original harness `Query` (gold answers, rubric meta);
  `answer` an AnswerRecord or its dict. `judge_llm` and
  `expected_judge_model` are required for open-ended datasets and ignored
  for MCQ and retrieval; a model mismatch raises `JudgeModelMismatch`.
- `judge_answer` never raises on a judge problem: it returns `judge_failure`.
  Failure outcomes on the answer are passed through without a judge call
  (score 0, or None for `incomplete_ingest`). Answers that decline are
  `abstention` and are judged like any other answer.
- `score` is in [0, 1]; `correct` is the judge's boolean, or `score >= 0.5`
  for BEAM. `rubric` holds BEAM's per-item judgments, `requests` every judge
  call with its attempts, `details` dataset metrics (PrecisionMemBench).
- `aggregate` keys: `scheduled`, `counts` (every outcome plus `missing`),
  `judged`, `correct`, `accuracy`, `mean_score`, `complete`, `missing_ids`,
  `judge_failure_ids`, `incomplete_ingest_ids`. It raises on unscheduled,
  duplicate, foreign-cell or inconsistent records.

## Re-judge (`mpw/rejudge.py`)

`python -m mpw.rejudge --cell <dir> --cell <dir> [--seed N] --out <dir> --judge-model provider:model [--cache <dir>]`

Reads `cell.json` keys `cell_id` (or `id`), `spec.dataset`, `spec.split`,
`spec.provider` (optional) and `resolved.schedule` (dataset query ids), and
`stages/answer/<qid>.json`. Refuses fewer than two cells, duplicate cell
ids, different dataset/split/schedule, retrieval datasets and a judge whose
model id differs from `--judge-model`. Writes
`<out>/<cell_id>/stages/judge/<qid>.json`, `<out>/unblinding.json`,
`<out>/summary.json` and the judge cache (`<out>/judge-cache` by default).

## Workload suite B2 (corrections) adapter: decision

The B2 driver is TypeScript (`runCorrectionArm` with a `CorrectionAdapter`). The simpler path is a TypeScript adapter per system, not a Python bridge: gbrain over stdio MCP (`put_pages`/`put_page`, `get_page`/`edit_page`, `forget`, `remember`, `query` with the same `token_budget` and `return_unit`), and the comparator through its HTTP API on the pinned server (`mpw.comparator_server` starts and reaps it, `bun run harness:comparator install` installs it; its edit/invalidate and retain operations), both launched with `MPW_CHILD_ENV_*` from the metering proxy and calling `storePresenceFailures` after ingest. It is not built in this lane.
