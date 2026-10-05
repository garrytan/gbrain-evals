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

## Provenance and deletion

Facts cite the sessions in their edge's `episodes` list (exact). Entity nodes have no `episodes` field at 0.30.2;
the shim uses the public `EpisodicNode.get_by_entity_node_uuid` (episodes with a `MENTIONS` edge to the node) and
reports `partial`, or `unavailable` with `settings.node_provenance = "none"`. Episodes cite themselves.
Deletion calls `Graphiti.remove_episode` for each episode of the source and keeps its semantics: an edge goes only
if the removed episode created it, and a node goes only if no other episode mentions it.

## Changelog

### 2026-10-05: first version

Shim, capability record, pinned images and vendor-constrained lock, compose file with an internal network, fake
provider and the protocol smoke test. Keyless runs pass against the fake provider for `recipe` and `common`, at
both granularities; the metered smoke is pending the metering proxy.
