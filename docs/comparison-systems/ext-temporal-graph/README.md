# Graphiti shim

This directory runs [Graphiti](https://github.com/getzep/graphiti) (the open-source `graphiti-core` 0.30.2, not
Zep Cloud) on Neo4j 5.26 behind the shootout's shim protocol ([PROTOCOL.md](../PROTOCOL.md)) for the
[open-source memory shootout](../../../docs/plans/2026-10-05-oss-memory-shootout/PLAN.md). Graphiti turns each
conversation into a temporal knowledge graph: an LLM extracts entities and the facts between them, and each fact
carries the time it became true and, once contradicted, the time it stopped being true.

## What runs

| Container | Image | Role |
|---|---|---|
| `neo4j` | `neo4j:5.26.2`, digest pinned (the tag in Graphiti's own compose file) | the graph database |
| `shim` | built from `Dockerfile` (`graphiti-core==0.30.2`, `uv.lock`) | `shim.py`, which runs graphiti-core in process |
| `egress` | `alpine/socat`, digest pinned | the only container with a route out: publishes the shim and relays to the metering proxy |

The lock resolves graphiti-core's dependencies to the versions in Graphiti's own `uv.lock` at v0.30.2 (through
`constraint-dependencies`): the newest `openai` on PyPI no longer ships `httpx`, which graphiti-core imports.

One `group_id` per namespace. Ingestion calls `add_episode(reference_time=<session date>)`. Retrieval calls
`search_()`, which returns separate ranked lists of facts (edges), entities (nodes), episodes and communities; the
shim concatenates them in that fixed order, each in Graphiti's own order, because their reranker scores are not
on one scale. Facts carry `valid_from` and `valid_to` from the edge's `valid_at` and `invalid_at`.
[capability.json](capability.json) records every model role, the retrieval policies, the provenance rule per item
class and the evidence for each value at the pinned tag.

## Configurations

- `SHIM_CONFIG=recipe`: graphiti-core's defaults. Main LLM `gpt-5.5` (reasoning effort `none`), small LLM
  `gpt-4.1-nano`, embedder `text-embedding-3-small` truncated to 1,024 dimensions (`EMBEDDING_DIM` default),
  cross-encoder `gpt-4.1-nano`.
- `SHIM_CONFIG=common`: both LLM roles `gpt-4.1-mini`, embedder `text-embedding-3-large` truncated to 1,536
  dimensions, cross-encoder unchanged.
- `SHIM_GRANULARITY=session` (default) adds one episode per session; `message` adds one per turn as Zep's LoCoMo
  harness does, with millisecond offsets so Graphiti sees the turn order.

## Build and run

From this directory:

```bash
docker compose build
# keyless plumbing run against the fake provider (it answers on the proxy's OpenAI route)
python3 fake_provider.py --port 8787 --log /tmp/fake-provider.jsonl &
SHIM_CONFIG=common docker compose up -d
python3 test_shim.py --url http://127.0.0.1:8700
# real run: every provider call goes to the metering proxy
SHIM_CONFIG=common PROXY_URL=http://<proxy host:port> PROXY_OPENAI_PATH=/<slot>/openai/v1 docker compose up -d
docker compose down -v
```

`PROXY_URL` is the metering proxy as reachable from Docker's bridge (default `http://host.docker.internal:8787`;
the proxy must listen on an address the bridge can reach). `PROXY_OPENAI_PATH` (default `/openai/v1`) is the proxy
path that forwards to OpenAI. Graphiti calls `POST /v1/responses` (structured extraction),
`POST /v1/chat/completions` (cross-encoder, with logprobs) and `POST /v1/embeddings`. The container holds a dummy
key. `SHIM_HOST_PORT` (default 8700) moves the published shim port.

`fake_provider.py` is a keyless stand-in for that route: hashed bag-of-words embeddings, schema-shaped structured
outputs with crude capitalized-word entities, and word-overlap reranker logprobs. It logs every request, which
shows the traffic went through the proxy address with the dummy key. Scores obtained with it are plumbing
evidence only. `test_shim.py` (stdlib) is the same protocol smoke test as Hindsight's.

## Deviations from the vendor's benchmark code

The adapter starts from Zep's LoCoMo harness
([zep-papers@4b7f26c](https://github.com/getzep/zep-papers/tree/4b7f26cc76cca20743314ba9acb8c2cb6adc42f6/kg_architecture_agent_memory/locomo_eval)),
written for Zep Cloud and translated to the graphiti-core calls it wraps. The full list is in `capability.json`
(`deviations_from_vendor_code`); in short:

- Zep Cloud's `graph.add(type='message')` becomes `add_episode(source=EpisodeType.message)`.
- One episode per session by default instead of one per message: per-message ingestion costs about 30 times the
  extraction calls on LoCoMo, and turns sharing the session time make Graphiti's previous-episode window pick
  tied episodes in arbitrary order. `SHIM_GRANULARITY=message` keeps Zep's granularity.
- `source_description='chat conversation'`, which graphiti-core requires; episode names are opaque source ids so
  provenance and deletion map back through public node APIs.
- Retrieval follows the shootout's two policies over `search_()` (its default recipe at limit 10, and at limit 50
  for the 8,000-token budget) instead of Zep's two searches, recorded under `vendor_benchmark_reference`.
- `search_` takes no query time; the shim ignores `query_time` and says so in `applied_settings`.

## Metered smoke (2026-10-05)

One run of `test_shim.py` per configuration through the shootout's metering proxy
(`eval/runner/metering-proxy.ts` from branch `capy/shootout-harness` at `a0787f7`, lease mode, one ledger per run).
Leases were $0.50 for `common` with session episodes, $1.50 for `common` with message episodes and $2.00 for
`recipe`. The workload is tiny and synthetic: two dated three-turn sessions and a two-turn canary session in a
second namespace, then 7 retrievals (both policies, the canary probe in each namespace, after the delete, the
survivor check, after the reset). Every run passed every step, with zero proxy refusals, zero tripwires and no
request charged at its reservation.

| Run | Requests | Input tokens | Output tokens | Cost | Ingest per session (service_ms) | Retrieve (service_ms, two policies) |
|---|---|---|---|---|---|---|
| `common`, session episodes | 88 | 18,929 | 755 | $0.0072 | 11,421 and 5,959 | 1,083 and 1,225 |
| `common`, message episodes | 168 | 53,025 | 1,531 | $0.0211 | 19,693 and 24,095 | 2,167 and 1,259 |
| `recipe` (`gpt-5.5`), session episodes | 108 | 22,831 | 985 | $0.0897 | 10,514 and 12,363 | 1,654 and 948 |

By route and model:

| Run | `/v1/responses` (extraction) | `/v1/chat/completions` (`gpt-4.1-nano` cross-encoder) | `/v1/embeddings` |
|---|---|---|---|
| `common`, session | 9 calls to `gpt-4.1-mini`, 13,930 in / 707 out, $0.0067 | 48 calls, 4,499 in / 48 out, $0.0005 | 31 calls to `text-embedding-3-large`, $0.0001 |
| `common`, message | 31 calls to `gpt-4.1-mini`, 44,799 in / 1,445 out, $0.0202 | 86 calls, 7,594 in / 86 out, $0.0008 | 51 calls to `text-embedding-3-large`, $0.0001 |
| `recipe`, session | 7 calls to `gpt-5.5`, 12,721 in / 834 out, $0.0886; 6 calls to `gpt-4.1-nano`, 4,102 in / 91 out, $0.0004 | 60 calls, 5,454 in / 60 out, $0.0006 | 35 calls to `text-embedding-3-small`, under $0.0001 |

What the numbers mean for the counted runs:

- Message episodes cost about 3 times session episodes here, on three-turn sessions. The ratio grows with turns
  per session (LoCoMo sessions run about 20 to 30 turns), because each turn becomes its own extraction.
- The recipe's `gpt-5.5` extraction costs about 13 times `gpt-4.1-mini` per run. Each `gpt-5.5` request reserves
  up to $0.54 against the lease before forwarding (graphiti-core asks for 16,384 output tokens at $30 per million),
  so a lease must cover the concurrent reservations, not only the expected spend.
- Retrieval is not free: the default recipe's cross-encoder makes one `gpt-4.1-nano` call per candidate, about
  7 to 12 calls per retrieval on this tiny graph, plus one embedding call.

Neo4j logs "property key does not exist" notices when a search runs on a graph with no facts yet (the canary
namespace); they are warnings, not failures. Raw proxy usage lines and step logs are on the lane machine under
`~/.capy/work/shootout/` (`usage-smoke-graphiti-*.ndjson`, `smoke-graphiti-*.log`); they are not committed.

## Provenance and deletion

Facts cite the sessions in their edge's `episodes` list (exact). Entity nodes have no `episodes` field at 0.30.2;
the shim uses the public `EpisodicNode.get_by_entity_node_uuid` (episodes with a `MENTIONS` edge to the node) and
reports `partial`, or `unavailable` with `settings.node_provenance = "none"`. Episodes cite themselves.
Deletion calls `Graphiti.remove_episode` for each episode of the source and keeps its semantics: an edge goes only
if the removed episode created it, and a node goes only if no other episode mentions it.

## Phase 2 pilot

[PILOT.md](PILOT.md) records the 2026-10-05 pilots through the memory-qa runner (one LoCoMo conversation, one
LongMemEval-S haystack, one BEAM-100K conversation): costs per ingested item, reader and judge costs, latency,
outcomes and the Phase 4 cost extrapolation. Its scores are setup evidence, not results.

## Changelog

### 2026-10-05: Phase 2 pilot, policy settings

Added PILOT.md. Retrieval policies keep their knobs under `retrieval_policies.<mode>.settings` (PROTOCOL.md), offset-less
ISO times are read as UTC, and the shim maps a metering-proxy refusal to the `budget` error.

### 2026-10-05: metered smoke

Added the metered smoke results for `common` (session and message episodes) and `recipe`. The shim now maps a
metering-proxy refusal (HTTP 402, kind `budget`) to the protocol's `budget` error.

### 2026-10-05: first version

Shim, capability record, pinned images and vendor-constrained lock, compose file with an internal network, fake
provider and the protocol smoke test. Keyless runs pass against the fake provider for `recipe` and `common`, at
both granularities; the metered smoke is pending the metering proxy.
