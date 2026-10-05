# Hindsight shim

This directory runs [Hindsight](https://github.com/vectorize-io/hindsight) 0.10.2 behind the shootout's shim
protocol ([PROTOCOL.md](../PROTOCOL.md)) for the
[open-source memory shootout](../../../docs/plans/2026-10-05-oss-memory-shootout/PLAN.md). Hindsight stores
conversations in memory banks: `retain` asks an LLM to extract facts from each conversation, and `recall` returns
the facts that fit a token budget, ranked by semantic, keyword, graph and temporal search plus a local reranker.

## What runs

| Container | Image | Role |
|---|---|---|
| `db` | `pgvector/pgvector:0.8.1-pg18`, digest pinned | Postgres with pgvector, the documented external database |
| `hindsight` | `ghcr.io/vectorize-io/hindsight:0.10.2`, digest pinned, unmodified | the Hindsight API server with its local embedder and reranker |
| `shim` | built from `Dockerfile` (`hindsight-client==0.10.2`, `uv.lock`) | `shim.py`, the protocol adapter |
| `egress` | `alpine/socat`, digest pinned | the only container with a route out: publishes the shim and relays to the metering proxy |

The shim speaks only Hindsight's public HTTP API: one bank per namespace, one `retain` per session with
`document_id` set to the opaque source id and `timestamp` set to the session date, `recall` with
`query_timestamp` set to the question date, and `DocumentsApi.delete_document` for deletion. Every recall result
carries its `document_id`, so provenance is exact. [capability.json](capability.json) records every model role,
the retrieval policies and how they map to recall's real knobs (`budget`, `max_tokens`, `include_chunks`), and the
evidence for each value at the pinned tag.

## Configurations

`SHIM_CONFIG` picks the server's environment file:

- `recipe` ([hindsight.recipe.env](hindsight.recipe.env)): the server defaults. Extraction `gpt-4o-mini`, local
  embedder `BAAI/bge-small-en-v1.5` (384 dimensions), local reranker `cross-encoder/ms-marco-MiniLM-L-6-v2`.
- `common` ([hindsight.common.env](hindsight.common.env)): extraction `gpt-4.1-mini`, embedder
  `text-embedding-3-large` at 1,536 dimensions, reranker unchanged.

`HINDSIGHT_LLM_PROVIDER=mock` swaps in Hindsight's own test LLM, which turns each input sentence into a canned fact.
It proves the plumbing without a key; `/health` reports `llm_provider: mock` so such a run cannot pass for a real
one. Its retrieval results say nothing about memory quality.

## Build and run

From this directory:

```bash
docker compose build
# keyless control run (recipe needs no provider at all with the mock LLM)
HINDSIGHT_LLM_PROVIDER=mock SHIM_CONFIG=recipe docker compose up -d
python3 test_shim.py --url http://127.0.0.1:8700
# real run: every provider call goes to the metering proxy
SHIM_CONFIG=common PROXY_URL=http://<proxy host:port> PROXY_OPENAI_PATH=/<slot>/openai/v1 docker compose up -d
docker compose down -v
```

`PROXY_URL` is the metering proxy as reachable from Docker's bridge (default `http://host.docker.internal:8787`;
the proxy must listen on an address the bridge can reach, not only 127.0.0.1). `PROXY_OPENAI_PATH` (default
`/openai/v1`) is the proxy path that forwards to OpenAI. The containers hold a dummy key. `SHIM_HOST_PORT`
(default 8700) moves the published shim port.

`test_shim.py` (stdlib) drives a running shim through health, the capability record, reset, ingest of two dated
sessions, finish, retrieval under both policies, a canary that must not cross namespaces, delete with a survivor
check, the error shapes and a final reset.

## Metered smoke (2026-10-05)

One run of `test_shim.py` per configuration through the shootout's metering proxy
(`eval/runner/metering-proxy.ts` from branch `capy/shootout-harness` at `a0787f7`, lease mode, $0.50 lease per run,
one ledger per run). The workload is tiny and synthetic: two dated three-turn sessions and a two-turn canary
session in a second namespace (3 retains), then 7 recalls (both policies, the canary probe in each namespace,
after the delete, the survivor check, after the reset). Both runs passed every step, with zero proxy refusals,
zero tripwires and no request charged at its reservation. The real LLM extracted 2 memory units per session
(the mock LLM had made 4 to 5).

| Run | Requests | Input tokens | Output tokens | Cost | Ingest per session (service_ms) | Recall (service_ms, two policies) |
|---|---|---|---|---|---|---|
| `common`: `gpt-4.1-mini`, `text-embedding-3-large` at 1,536 | 13 | 9,283 | 709 | $0.0036 | 3,298 and 3,554 | 314 and 407 |
| `recipe`: `gpt-4o-mini`, local embedder and reranker | 3 | 8,939 | 778 | $0.0012 | 4,584 and 5,081 | 113 and 132 |

Per route: `common` made 3 `POST /v1/chat/completions` calls to `gpt-4.1-mini` (8,942 input and 709 output
tokens, $0.0036, all at ingest) and 10 `POST /v1/embeddings` calls to `text-embedding-3-large` (341 tokens, under
$0.0001: 3 at ingest, 7 at recall; the keyless run's request log shows each sends `dimensions: 1536`). `recipe` made only the 3 extraction calls; its
embedder and reranker are local, so a recall costs nothing. Retain extraction uses chat completions, which
confirms the provider route in `capability.json`. Raw proxy usage lines and step logs are on the lane machine
under `~/.capy/work/shootout/` (`usage-smoke-hindsight-*.ndjson`, `smoke-hindsight-*.log`); they are not
committed.

## Deviations from the vendor's benchmark code

The adapter starts from AMB's `hindsight-http` provider
([agent-memory-benchmark@f618ed7](https://github.com/vectorize-io/agent-memory-benchmark/blob/f618ed7b1f0eb9cad7b42e876f91a42f0eadb150/src/memory_bench/memory/hindsight.py)),
the code Hindsight's own `hindsight-system-evals` runs. `hindsight-benchmarks` scores extraction LLMs directly and
does not ingest through the server, so it is not used. The full list is in `capability.json`
(`deviations_from_vendor_code`); in short:

- Only opaque ids cross: no dataset ids in `document_id`, no `metadata` (it influences extraction), and a context
  of `Conversation between <speakers>` instead of AMB's context naming the session and sample.
- One bank per namespace and no `user:` tags.
- Turns are serialized as the harness sends them (`role`, `speaker`, `content`).
- One retain per session, waited on before the next, instead of async batches of 20; failures are reported, not
  retried.
- Retrieval amounts follow the shootout's two policies (client defaults; an 8,000-token cap) instead of AMB's
  per-dataset settings, which `capability.json` records under `vendor_benchmark_reference`.
- Observations (consolidated facts) are off in both configs, `enable_observations=false` per bank, as AMB sets for
  every dataset. The server default is on.
- The server skips its boot-time LLM key check.

## Changelog

### 2026-10-05: metered smoke

Added the metered smoke results for `common` and `recipe`. The shim now maps a metering-proxy refusal (HTTP 402,
kind `budget`) during retain or recall to the protocol's `budget` error.

### 2026-10-05: first version

Shim, capability record, pinned images and lock, compose file with an internal network, and the protocol smoke
test. Keyless runs pass for `recipe` and `common` with the mock LLM; the metered smoke is pending the metering proxy.
