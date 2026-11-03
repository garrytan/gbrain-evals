# Graphiti 0.31.2 with its shipped defaults (`shipped-0.31`)

This directory runs [Graphiti](https://github.com/getzep/graphiti) at its newest release, `graphiti-core` 0.31.2
(tag v0.31.2, `d72407dc`, published 2026-10-20), exactly as the package ships it. It is the `shipped-0.31`
configuration of the `ext-temporal-graph` kind. The pinned 0.30.2 configurations (`recipe`, `common`) keep their own
files one directory up, unchanged, so Q1's cells and hashes still describe what ran.

## What changes from 0.30.2

| Role | 0.30.2 `recipe` | 0.31.2 `shipped-0.31` |
|---|---|---|
| Main LLM (extraction) | `gpt-5.5` | `gpt-6-luna` |
| Small LLM | `gpt-4.1-nano` | `gpt-6-luna` |
| Embedder | `text-embedding-3-small`, 1,024 dimensions | unchanged |
| Cross-encoder (logprob reranker) | `gpt-4.1-nano` | `gpt-4.1-mini` |

The LLM requests use reasoning effort `none` (`'auto'` resolves to `none` for GPT 5.1 and later majors) and
verbosity `low`. Every `gpt-6` request carries `prompt_cache_options: {"mode": "explicit"}` with no breakpoint, so no
prompt-cache writes are billed. Extraction uses the combined node-and-edge prompt (`use_combined_extraction=True` by
default). The reranker moved to `gpt-4.1-mini` because `gpt-6-luna` rejects `max_tokens` and `logit_bias`.
`LLMRuntime` (prompt and model routing, new in 0.31) is opt-in and not used. `remove_episode` now keeps an edge that
another episode still supports and rebuilds the summaries of surviving nodes, which makes LLM calls on delete.

## How the shim builds it

`shipped.py` reuses the pinned adapter, `../shim.py`, unchanged (the image copies it in as `graphiti_shim.py`), and
replaces only the construction: `Graphiti(uri, user, password)` with no clients. graphiti-core then picks every model
and setting itself. Its default clients read `OPENAI_BASE_URL` and `OPENAI_API_KEY` from the environment, and compose
points `OPENAI_BASE_URL` at the egress relay, so every provider call reaches the metering proxy. At start the shim reads
the resolved models back from the instance and refuses to serve unless they match `capability.json`.

The lock (`uv.lock`, from `uv lock`) resolves graphiti-core's dependencies to the versions in Graphiti's own `uv.lock`
at v0.31.2, through `constraint-dependencies`, as the pinned bundle does. Neo4j stays `neo4j:5.26.2`, still the tag in
Graphiti's own compose file. The compose project is `shootout-graphiti-shipped-031`, so its volumes never mix with the
0.30.2 stack's.

## Run

```bash
bash eval/systems/bootstrap.sh up --system ext-temporal-graph --config shipped-0.31
# restart, down, snapshot and restore take the same --config to find this stack
bash eval/systems/bootstrap.sh down --system ext-temporal-graph --config shipped-0.31
```

Keyless plumbing check, from the repository root:

```bash
python3 docs/comparison-systems/ext-temporal-graph/fake_provider.py --port 8787 --log /tmp/fake-provider.jsonl &
BOOTSTRAP_PROXY_CHECK=off bash eval/systems/bootstrap.sh up --system ext-temporal-graph --config shipped-0.31
python3 docs/comparison-systems/ext-temporal-graph/shipped-0.31/test_shim.py --url http://127.0.0.1:8700
```

`test_shim.py` runs the pinned protocol smoke test as written, except that it expects the record to hold exactly
`shipped-0.31` instead of `recipe` and `common`.

`probe.py models` sends one tiny real request to each model the shipped configuration calls, shaped the way
graphiti-core sends it. `probe.py stack --url <shim> --usage-log <proxy usage.ndjson>` ingests two short synthetic
sessions and runs one search through a running stack, then sums the metering proxy's usage per route and model.

## Probe (2026-10-29)

`probe.py models`, direct to the provider: `gpt-6-luna` answered a strict structured output (51 input, 17 output, 0
reasoning tokens), `gpt-4.1-mini` answered with logprobs (`True` at 0.0, `False` at -16.0), and
`text-embedding-3-small` returned 1,536 dimensions, which graphiti-core truncates to 1,024. Total $0.00004.

`probe.py stack`, through `eval/runner/metering-proxy.ts` in lease mode ($0.40 lease), two three-turn sessions and one
fixed-evidence search:

| Route and model | Requests | Input tokens | Output tokens | Cost |
|---|---|---|---|---|
| `/v1/responses` `gpt-6-luna` (ingest) | 10 | 13,545 | 705 | $0.0017 |
| `/v1/embeddings` `text-embedding-3-small` | 9 (8 at ingest) | 188 | 0 | under $0.0001 |
| `/v1/chat/completions` `gpt-4.1-mini` (search rerank) | 12 | 1,122 | 12 | $0.0005 |

31 requests forwarded, 0 refused, $0.0022 billed. Ingest took about 11 seconds per session and spent about 13,700
input tokens on about 90 tokens of conversation. That ratio is mostly fixed prompt overhead on tiny sessions and does
not predict the cost of a long session. Each `gpt-6-luna` request reserves about $0.0094 against the lease before it is
forwarded, because graphiti-core asks for 16,384 output tokens.
