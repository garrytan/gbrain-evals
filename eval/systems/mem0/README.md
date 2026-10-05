# Mem0 shim

This directory runs [Mem0](https://github.com/mem0ai/mem0) open source, `mem0ai` `2.2.1`, behind the shootout's
[shim protocol v1](../PROTOCOL.md). Mem0 asks an LLM to extract short facts ("memories") from each batch of
messages, embeds them and stores them in Qdrant; search combines vector similarity, BM25 keyword scores and an entity
boost. This is the open-source SDK, not the Mem0 platform, so platform-only features (timestamps, reference dates)
are absent.

## What it runs

| Piece | Value |
|---|---|
| Package | `mem0ai[nlp]==2.2.1`, `fastembed` (BM25 sparse vectors for Qdrant) and `en_core_web_sm` 3.8.0, the documented hybrid-search install. `uv.lock` resolved on 2026-10-05 with `exclude-newer` and no prereleases (qdrant-client 1.19.1, openai 3.24.0, spacy 3.8.16, fastembed 0.8.1) |
| Backend | Qdrant server `v1.19.2` by digest, on the same internal network |
| Base image | `python:3.12-slim-bookworm@sha256:54c85f3c…`, uv `0.12.3` by digest |
| Recipe models | extraction `gpt-5-mini`, embedder `text-embedding-3-small` (1,536 dimensions): the SDK defaults, read back from the running `Memory` and reported by `/health` |
| Common models | extraction `gpt-4.1-mini`, embedder `text-embedding-3-large` at 1,536 dimensions (mem0 sends `dimensions` when `embedding_dims` is set) |
| Reranker | none configured; `search(rerank=False)` is the default |
| Agent surface | a harness MCP wrapper over this SDK, not built yet. OpenMemory, Mem0's own MCP server, is being sunset |

`capability.json` is the full capability record. The shim adds the `uv.lock` hash, the image digest from
`SHIM_IMAGE` and the resolved models at run time.

## How the shim maps the protocol

The flow starts from `mem0ai/memory-benchmarks` at commit `4b61c5d3`: `session_to_chunks` turns each turn into one
message `{"role", "content": "Speaker: text"}`, groups `CHUNK_SIZE` messages per `add` call (1 for LoCoMo, 2 for
LongMemEval and BEAM) and scopes everything by `user_id`.

| Endpoint | What happens |
|---|---|
| `/reset` | `delete_all(user_id)`, then the namespace moves to a fresh `user_id` (`<ns>.g<n>`), because `delete_all` leaves the scope's 10 most recent raw messages in the history store, where the next extraction call would read them |
| `/ingest` | one `Memory.add(messages, user_id, metadata={source_id, session_date})` per chunk of `MEM0_CHUNK_TURNS` turns, each chunk headed by a system line `This conversation took place at 1:56 pm on 8 May, 2023.`. A failed chunk is reported in `errors` and marks the session `degraded`; a metering-proxy refusal (HTTP 402) stops the session with `budget` |
| `/finish` | returns at once: `add` is synchronous |
| `/retrieve` | `Memory.search(question, top_k=k, filters={"user_id"})`, k is 20 for `vendor-default` (the SDK default) and 200 for `fixed-evidence` (the vendor benchmark's largest cutoff). Each memory carries the `source_id` of the session whose add created it (`provenance_status: partial`) and its session date as `valid_from` |
| `/delete_source` | `get_all(filters={user_id, source_id})`, then `delete(memory_id)` for each, then a re-check that none is left |

### Time

OSS 2.2.1 rejects a non-null `timestamp` on `add` (`main.py:818`) and a non-null `reference_date` on `search`
(`main.py:1447`), so the date travels as text and `query_time` is not sent. One limit remains: the extraction
prompt's `## Observation Date`, which the prompt calls the only temporal anchor, is always today's wall-clock date in
OSS (`configs/prompts.py`, `_resolve_dates`). Relative phrases such as "yesterday" may therefore resolve against
2026 even with the session date in the messages. This is how Mem0 OSS behaves on replayed history, so the shim does
not work around it (for example through the `prompt` argument); the report should say so.

## Deviations from the vendor benchmark

1. memory-benchmarks drives its own FastAPI server built from Mem0's `feat/v3-pipeline` branch; the shim calls the
   pinned 2.2.1 SDK in process against the same Qdrant backend. That server passes `user_id` to `search()` as a
   keyword, which 2.2.1 rejects, so the shim uses `filters={"user_id"}`.
2. The session date goes into the messages as a system line. The vendor sends `timestamp=<epoch>` to its OSS server,
   whose request model has no `timestamp` field, so in the vendor's own OSS runs the date never reaches Mem0.
3. Roles come from the harness; when a role is neither `user` nor `assistant`, the first speaker becomes `user` and
   the others `assistant`, the vendor's mapping. Image captions are not sent; the sanitized sessions carry text only.
4. Every `add` carries `metadata={"source_id", "session_date"}` for provenance and deletion; the vendor sends none.
5. `user_id` is the opaque namespace plus a reset generation, not `locomo_<conv>_<run_id>`.
6. The recipe extraction model is the SDK default `gpt-5-mini`; memory-benchmarks' server defaults to `gpt-4o-mini`.
7. Search runs once per question at the policy's `top_k`; the vendor searches once at `top_k=200` and slices.

The image also works around a fastembed 0.8.1 bug: its offline loader requires two files that the `Qdrant/bm25`
repository never had (`mock.file`, `tamil.txt`), so the build creates them empty. Without this, BM25 is silently off
in a container with no route to Hugging Face.

## Build and run

```bash
docker build -f eval/systems/mem0/Dockerfile -t shootout/mem0:2.2.1 eval/systems
docker compose -f eval/systems/mem0/docker-compose.yml up -d
python3 eval/systems/basic-memory/protocol_check.py --url http://127.0.0.1:8702
```

Compose puts the shim and Qdrant on an internal network. The only exits are `proxy`, a TCP relay to the metering proxy
(`PROXY_UPSTREAM`, default `host.docker.internal:8787`, with `OPENAI_BASE_URL=${PROXY_URL}/openai/v1`), and `ingress`,
which publishes the shim on `127.0.0.1:${SHIM_HOST_PORT:-8702}`. The container holds a dummy `OPENAI_API_KEY`. Set
`SHIM_CONFIG=common` for the common models and `MEM0_CHUNK_TURNS=1` for LoCoMo cells.

### Keyless plumbing test

`fake_provider.py` stands in for the metering proxy's OpenAI route: hashed bag-of-words embeddings and a scripted
extraction that turns each new message into one memory. It logs every request's path, model and dimensions, and
whether the dummy key arrived. It proves the SDK honors `OPENAI_BASE_URL`, asks for the expected models and that the
shim speaks the protocol. Its scores say nothing about Mem0's quality.

```bash
python3 eval/systems/mem0/fake_provider.py --port 8787 --log /tmp/fake-provider.jsonl   # in its own terminal
docker compose -f eval/systems/mem0/docker-compose.yml up -d
python3 eval/systems/basic-memory/protocol_check.py --url http://127.0.0.1:8702
```

## Changelog

### 2026-10-05: first version
Both configurations pass all 26 protocol checks against the keyless fake provider, with egress blocked except the
proxy relay. No real provider call has been made yet.
