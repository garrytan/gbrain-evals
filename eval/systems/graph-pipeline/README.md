# graph-pipeline shim

This directory runs graph-pipeline at its pinned release (the
[comparison table](../../../docs/comparison-systems.md#systems-in-the-open-source-comparison) names the project and its
pin) behind the shootout's shim protocol ([PROTOCOL.md](../PROTOCOL.md)). graph-pipeline turns documents into a knowledge graph: `add` stores the text, `cognify`
chunks it, has an LLM extract entities and relationships, writes summaries and embeds everything. The shim exposes
that pipeline as `/ingest` and graph-pipeline's hybrid retrieval as `/retrieve`, with no answer generation.

The facts behind every setting are in [capability.json](capability.json), checked against the pinned wheel and tag
(`ba3631f`).

## What it runs

- **One namespace, one graph-pipeline dataset.** Datasets are isolated by graph-pipeline's default access control, which gives each
  dataset its own graph and vector store.
- **Ingest follows graph-pipeline's own BEAM code** (the package's `eval_framework/beam/local_ingest.py`). Each session becomes one
  JSON-list document with one turn pair per item, headed `Session`, `Turn` and `Time anchor`, and the shim runs
  `add` then `cognify(chunker=JsonListChunker, extractor="llm")` for that session before answering. Ingest is
  synchronous, so `/finish` returns at once.
- **Retrieve follows graph-pipeline's reported BEAM configuration**: `search(query_type=HYBRID_COMPLETION,
  only_context=True, verbose=True)`. The shim returns graph-pipeline's ranked chunks, then entities, then facts, in the order
  graph-pipeline renders them into its own context string (kept in `raw.context`).
  - `vendor-default`: `top_k` 15, which graph-pipeline caps to 10 chunks, 10 entities and 10 facts.
  - `fixed-evidence`: 20 chunks and 20 entities (graph-pipeline's `hybrid_completion_20_20_qa_v1`), 10 facts; the harness
    packs to 8,000 tokens.
- **Provenance**: each session's graph-pipeline Data id is pinned (`uuid5(ns, source_id)`) and labelled with the source id,
  so chunk items cite exactly one session. Entity and fact items come from the merged graph and report
  `unavailable`.
- **Delete**: `forget(data_id=..., dataset=...)`.
- **Models**: `SHIM_CONFIG=recipe` keeps graph-pipeline's defaults (`openai/gpt-5.6-luna` for every LLM stage,
  `text-embedding-3-large` at 3,072 dimensions). `SHIM_CONFIG=common` sets `gpt-4.1-mini` and
  `text-embedding-3-large` at 1,536 dimensions. Both pin `GRAPH_EXTRACTOR=llm`, so a missing key fails loudly
  instead of switching to the local GLiNER extractor. `/health` reports the models graph-pipeline actually resolved.
- **Telemetry off**: `TELEMETRY_DISABLED=1`, `LITELLM_LOCAL_MODEL_COST_MAP=True`, `HF_HUB_OFFLINE=1`.

## Deviations from graph-pipeline's code

Listed in full under `deviations_from_vendor_code` in [capability.json](capability.json). In short: documents are
added as JSON text rather than files; turns are paired in arrival order and labelled by speaker, because LoCoMo has
two named speakers rather than a user and an assistant; BEAM turn compression, session distillation and the global
context index are left out because they are BEAM-specific additions; `search(verbose=True)` replaces `recall()`,
because `recall(only_context=True)` collapses the context into one rendered prompt string; and the harness's fixed
reader replaces graph-pipeline's per-question-type prompts. AMB's graph-pipeline provider uses plain chunk retrieval (`CHUNKS`, top
50) with a local embedder; this shim follows graph-pipeline's own BEAM code because it exercises the graph.

## Network and keys

[docker-compose.yml](docker-compose.yml) puts the shim on an internal Docker network with no route out. Its only
peers are `egress`, a TCP relay to the metering proxy at `PROXY_HOSTPORT`, and `gateway`, which publishes the shim
on `127.0.0.1:8701`. The container holds a dummy key; the proxy injects the real one. All LLM and embedding calls go
to `LLM_ENDPOINT` and `EMBEDDING_ENDPOINT`, which point at the relay.

## Build and check

From the repository root:

```bash
docker compose -f eval/systems/graph-pipeline/docker-compose.yml build         # about 3 minutes
eval/systems/graph-pipeline/tests/run_keyless.sh recipe                         # and: common
```

The keyless check swaps the metering proxy for [tests/fake_provider.py](tests/fake_provider.py), an
OpenAI-compatible stand-in that returns schema-valid canned extractions and hashed bag-of-words embeddings. It
proves the plumbing, not memory quality. [tests/protocol_check.py](tests/protocol_check.py) then drives the shim
through reset, two dated sessions, a canary session in a second namespace, finish, both retrieval policies,
isolation in both directions, delete and reset.

Result on 2026-10-05 (4-core Capy machine): 28 of 28 checks pass in both configurations, the shim container cannot
reach the internet directly, and all 52 provider calls (41 embeddings, 11 chat) arrived through the relay with the
configured model names. Each session took 1 to 5 seconds to ingest against the fake provider.

For a metered run, start the metering proxy (`eval/runner/metering-proxy.ts`) on `0.0.0.0:8787`, then:

```bash
PROXY_HOSTPORT=host.docker.internal:8787 SHIM_CONFIG=common docker compose -f eval/systems/graph-pipeline/docker-compose.yml up -d --wait
python3 eval/systems/graph-pipeline/tests/protocol_check.py --questions 3 --out eval/reports/graph-pipeline-smoke.json
```

The shim maps a proxy refusal (HTTP 402) to the protocol's `budget` error.

## Known behavior worth measuring

- After a delete, no chunk from the deleted session returns. Graph entities shared with a surviving session stay; in
  the keyless run their edge text still quoted the deleted session, in the metered smoke nothing did. `lifecycle-lite`
  should score entity and fact items, not only chunks.
- graph-pipeline's search takes no query date, so `query_time` is ignored; dates live in the item text.

## Metered smoke, 2026-10-05

One run per configuration through `eval/runner/metering-proxy.ts` (lease mode, $0.50 lease each, slot `graph-pipeline`),
using `tests/protocol_check.py --questions 3`: two dated sessions (4 and 3 turns) in one namespace, a canary session
in a second namespace, both retrieval policies, isolation, three questions, delete and reset. Numbers are from the
proxy's usage log and `/__proxy/status`; timings are the shim's wall time on the 4-core Capy machine.

| | common | recipe |
|---|---|---|
| Protocol checks | 28/28 | 28/28 |
| Chat model, requests | `gpt-4.1-mini`, 11 | `gpt-5.6-luna`, 11 |
| Chat tokens in / out | 6,078 / 1,456 | 6,047 / 2,982 |
| Embeddings (`text-embedding-3-large`), requests, tokens | 41, 2,098 (1,536 dims) | 41, 2,212 (3,072 dims) |
| Dollars, chat + embeddings | $0.00476 + $0.00027 = $0.00503 | $0.00479 + $0.00029 = $0.00508 |
| Ingest per session (s1, s2, canary) | 11.6 s, 4.6 s, 5.5 s | 18.7 s, 5.8 s, 11.7 s |
| Query latency (3 questions) | 0.67 to 0.78 s | 0.62 to 0.69 s |
| Refusals, tripwires | 0, 0 | 0, 0 |

All three questions returned the session holding the answer, with the answer word in the evidence, in both runs. With
a real extractor the delete left no entity or fact mentioning the deleted fact (the keyless run, with canned
extraction, did leave some). One tiny conversation does not predict LoCoMo cost;
the Phase 2 pilots measure cost per conversation.
