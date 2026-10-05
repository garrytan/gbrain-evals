# Cognee shim

This directory runs [cognee](https://github.com/topoteretes/cognee) 1.6.2 behind the shootout's shim protocol
([PROTOCOL.md](../PROTOCOL.md)). Cognee turns documents into a knowledge graph: `add` stores the text, `cognify`
chunks it, has an LLM extract entities and relationships, writes summaries and embeds everything. The shim exposes
that pipeline as `/ingest` and cognee's hybrid retrieval as `/retrieve`, with no answer generation.

The facts behind every setting are in [capability.json](capability.json), checked against the v1.6.2 wheel and tag
(`ba3631f`).

## What it runs

- **One namespace, one cognee dataset.** Datasets are isolated by cognee's default access control, which gives each
  dataset its own graph and vector store.
- **Ingest follows cognee's own BEAM code** (`cognee/eval_framework/beam/local_ingest.py`). Each session becomes one
  JSON-list document with one turn pair per item, headed `Session`, `Turn` and `Time anchor`, and the shim runs
  `add` then `cognify(chunker=JsonListChunker, extractor="llm")` for that session before answering. Ingest is
  synchronous, so `/finish` returns at once.
- **Retrieve follows cognee's reported BEAM configuration**: `cognee.search(query_type=HYBRID_COMPLETION,
  only_context=True, verbose=True)`. The shim returns cognee's ranked chunks, then entities, then facts, in the order
  cognee renders them into its own context string (kept in `raw.context`).
  - `vendor-default`: `top_k` 15, which cognee caps to 10 chunks, 10 entities and 10 facts.
  - `fixed-evidence`: 20 chunks and 20 entities (cognee's `hybrid_completion_20_20_qa_v1`), 10 facts; the harness
    packs to 8,000 tokens.
- **Provenance**: each session's cognee Data id is pinned (`uuid5(ns, source_id)`) and labelled with the source id,
  so chunk items cite exactly one session. Entity and fact items come from the merged graph and report
  `unavailable`.
- **Delete**: `cognee.forget(data_id=..., dataset=...)`.
- **Models**: `SHIM_CONFIG=recipe` keeps cognee's defaults (`openai/gpt-5.6-luna` for every LLM stage,
  `text-embedding-3-large` at 3,072 dimensions). `SHIM_CONFIG=common` sets `gpt-4.1-mini` and
  `text-embedding-3-large` at 1,536 dimensions. Both pin `GRAPH_EXTRACTOR=llm`, so a missing key fails loudly
  instead of switching to the local GLiNER extractor. `/health` reports the models cognee actually resolved.
- **Telemetry off**: `TELEMETRY_DISABLED=1`, `LITELLM_LOCAL_MODEL_COST_MAP=True`, `HF_HUB_OFFLINE=1`.

## Deviations from cognee's code

Listed in full under `deviations_from_vendor_code` in [capability.json](capability.json). In short: documents are
added as JSON text rather than files; turns are paired in arrival order and labelled by speaker, because LoCoMo has
two named speakers rather than a user and an assistant; BEAM turn compression, session distillation and the global
context index are left out because they are BEAM-specific additions; `search(verbose=True)` replaces `recall()`,
because `recall(only_context=True)` collapses the context into one rendered prompt string; and the harness's fixed
reader replaces cognee's per-question-type prompts. AMB's cognee provider uses plain chunk retrieval (`CHUNKS`, top
50) with a local embedder; this shim follows cognee's own BEAM code because it exercises the graph.

## Network and keys

[docker-compose.yml](docker-compose.yml) puts the shim on an internal Docker network with no route out. Its only
peers are `egress`, a TCP relay to the metering proxy at `PROXY_HOSTPORT`, and `gateway`, which publishes the shim
on `127.0.0.1:8701`. The container holds a dummy key; the proxy injects the real one. All LLM and embedding calls go
to `LLM_ENDPOINT` and `EMBEDDING_ENDPOINT`, which point at the relay.

## Build and check

From the repository root:

```bash
docker compose -f eval/systems/cognee/docker-compose.yml build         # about 3 minutes
eval/systems/cognee/tests/run_keyless.sh recipe                         # and: common
```

The keyless check swaps the metering proxy for [tests/fake_provider.py](tests/fake_provider.py), an
OpenAI-compatible stand-in that returns schema-valid canned extractions and hashed bag-of-words embeddings. It
proves the plumbing, not memory quality. [tests/protocol_check.py](tests/protocol_check.py) then drives the shim
through reset, two dated sessions, a canary session in a second namespace, finish, both retrieval policies,
isolation in both directions, delete and reset.

Result on 2026-10-05 (4-core Capy machine): 28 of 28 checks pass in both configurations, the shim container cannot
reach the internet directly, and all 52 provider calls (41 embeddings, 11 chat) arrived through the relay with the
configured model names. Each session took 1 to 5 seconds to ingest against the fake provider.

For a metered run, start the metering proxy, then:

```bash
PROXY_HOSTPORT=host.docker.internal:8787 SHIM_CONFIG=common docker compose -f eval/systems/cognee/docker-compose.yml up -d --wait
python3 eval/systems/cognee/tests/protocol_check.py --questions 3 --out eval/reports/cognee-smoke.json
```

## Known behavior worth measuring

- After a delete, no chunk from the deleted session returns, but graph entities shared with a surviving session stay
  and their edge text can still quote the deleted session. `lifecycle-lite` should score entity and fact items, not
  only chunks.
- cognee's search takes no query date, so `query_time` is ignored; dates live in the item text.
