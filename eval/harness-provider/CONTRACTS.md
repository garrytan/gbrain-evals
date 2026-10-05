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

## Metering proxy (`eval/runner/metering-proxy.ts`)

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

`eval/runner/stub-upstream.ts` serves deterministic OpenAI, Anthropic, Gemini,
Groq and Voyage responses (schema-valid structured output, hash embeddings,
usage blocks) for keyless tests, the mode smoke and the quickstart fixture.

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
`prepare()` and stops it in `cleanup()`; data lives in `config.data_dir`
(default `<store_dir>/comparator-server`), with the embedded database under
an isolated HOME there.

- LLM route: the launcher passes the `comparator` label's proxy values to the
  harness process as `MPW_COMPARATOR_OPENAI_BASE_URL` (`<proxy>/openai/v1`)
  and `MPW_COMPARATOR_OPENAI_API_KEY` (its `mpwp-comparator-...` token). The
  server refuses a non-loopback base URL. Its extraction model is the
  server's documented default for that provider unless `llm_model` is set.
- Embeddings, reranking and the database are local CPU work (reported as
  local compute in `receipt()`, not as spend). `receipt()["unmetered"]`
  lists anything that bypasses the proxy; at 0.10.2 it is empty.
- Provider config: `max_tokens` (facts budget), `max_chunk_tokens` (raw-chunk
  budget, 0 for facts only), `budget`, `server_url`, `data_dir`, `id_salt`,
  `llm_model`, `startup_timeout_s`.
- Ids: every emitted id (documents, facts, chunks, source ids, banks, and any
  `*_id`/`*_ids` field or id-keyed map inside `raw_response`) is
  `c-<hex12>` = HMAC-sha256(salt, original). `reverse_ids()` maps them back
  for the scorer only.

## Scorer (`mpw/scorer.py`)

Typed outcomes from `mpw/records.py`; strict judge field validation; a fixed
scheduled denominator; BEAM rubric completeness. The re-judge
(`mpw/rejudge.py`) blinds and shuffles answers from several cells and calls
each dataset's own judge, asserting its model id.
