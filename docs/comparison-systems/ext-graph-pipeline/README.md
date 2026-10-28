# Cognee shim

This directory runs [cognee](https://github.com/topoteretes/cognee) 1.6.2 behind the shootout's shim protocol
([PROTOCOL.md](../../../eval/systems/PROTOCOL.md)). Cognee turns documents into a knowledge graph: `add` stores the text, `cognify`
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
docker compose -f docs/comparison-systems/ext-graph-pipeline/docker-compose.yml build         # about 3 minutes
docs/comparison-systems/ext-graph-pipeline/tests/run_keyless.sh recipe                         # and: common
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
PROXY_HOSTPORT=host.docker.internal:8787 SHIM_CONFIG=common docker compose -f docs/comparison-systems/ext-graph-pipeline/docker-compose.yml up -d --wait
python3 docs/comparison-systems/ext-graph-pipeline/tests/protocol_check.py --questions 3 --out eval/reports/cognee-smoke.json
```

The shim maps a proxy refusal (HTTP 402) to the protocol's `budget` error.

## Stopping, restarts and snapshots

`bootstrap.sh snapshot`, `restart` and `down` stop the stack with `docker compose stop`: SIGTERM, then SIGKILL at the
end of the service's `stop_grace_period`. cognee keeps its graph in ladybug 0.19 (a fork of the Kuzu graph database),
opened in a worker subprocess. A ladybug store killed during a write or a checkpoint does not reopen. Every query
then fails with `Storage exception: Checksum verification failed, the WAL file is corrupted`. A kill in the middle of
a checkpoint leaves `.wal.checkpoint` and `.shadow` files, and cognee's recovery deletes only the `.wal` file. A kill in
the middle of a write leaves a torn `.wal`, which cognee deletes, silently dropping the writes since the last
checkpoint. Before amendment A22 the shim installed no SIGTERM handler. As PID 1 it ignored SIGTERM, so every stop
ended in SIGKILL (exit 137) after 10 seconds, whatever the graph was doing. A kill like that reproduces the error a
sealed S1 shard showed after its snapshot.

The shim now handles SIGTERM. It lets the request in flight finish (up to `SHIM_STOP_DRAIN_S`, default 300 seconds)
and keeps new requests out. Then it cancels leftover tasks on its event loop and closes every graph and vector engine,
which checkpoints the graph and ends the worker processes. It prints one `{"stopped": ...}` line and exits 0.
`stop_grace_period: 420s` leaves room for the whole sequence. An idle stop takes about 1.5 seconds. `bootstrap.sh
snapshot` warns when a container still exits 137.

The entity items' edge lines (which edges are listed, and in what order) depend on Python's hash randomization, so
they vary between processes. Chunk and fact items, and the ids and order of all items, do not.
With `PYTHONHASHSEED=0` a restarted or restored store returns byte-identical results.

## Scale limit of the graph store (amendment A23)

cognee opens each dataset's ladybug database once, in a worker process, with `buffer_pool_size` and `max_db_size` both
32 GiB (`DEFAULT_KUZU_BUFFER_POOL_SIZE` and `DEFAULT_KUZU_MAX_DB_SIZE` in `cognee/infrastructure/databases/graph/ladybug/adapter.py`),
and keeps it open for the life of the process. While it stays open, ladybug's buffer manager uses up that 32 GiB of
address space at a steady rate per turn pair written, although the file on disk grows far more slowly. When the space
runs out, a checkpoint fails with `Buffer manager exception: Maximum database size of 34359738368 bytes has been
reached`. It leaves `.wal.checkpoint`, an empty `.shadow` and the checkpoint lock files behind. From then on the store
does not reopen. Every write and every retrieval fails with `Storage exception: Checksum verification failed, the WAL file
is corrupted`, before and after a restart. No kill, stop or memory limit is involved.

| Run (public BEAM dev text, one namespace) | `max_db_size` | First failed session | Turn pairs written before it | Graph file then |
|---|---:|---:|---:|---:|
| keyless, container limit 6g | 32 GiB (shipped) | 1,080 | 1,314 | 90 MB |
| keyless, no container limit | 32 GiB (shipped) | 1,081 | 1,316 | |
| keyless | 1 GiB (diagnostic) | 29 | 43 | 6.5 MB |
| keyless, store restarted after session 20 | 1 GiB (diagnostic) | 55 | | |
| metered, `gpt-4.1-mini` | 1 GiB (diagnostic) | 47 | 64 | |
| metered, `gpt-4.1-mini` | 2 GiB (diagnostic) | 92 | 128 | |

The smaller sizes were diagnostics only. Counted runs keep cognee's shipped settings. With real extraction the store
takes about 64 turn pairs per GiB, so at the shipped 32 GiB it fails after about 2,050 turn pairs. That is about 1.9M
tokens of BEAM text, roughly a sixth of a BEAM-10M conversation. A restart resets the count, so the limit applies to
one process lifetime. cognee's own BEAM ingestion (`local_ingest.py`) also runs one process per conversation.

What follows is also cognee's behavior. `cognify(datasets=[ns])` revisits every item of the dataset on each call
and runs the pipeline again for any item not marked complete (incremental loading). With `raise_on_error=True`, the
failed call leaves the later items incomplete too. So once one item fails, every later `/ingest` fails, and each one
re-extracts all the sessions that failed before it. Keyless, chat calls per session rose from 2 to about 60 within 25
sessions of the first failure. With a real provider the cost of each session grows in the same way until a lease runs
out. A failure caused by the content behaves the same way: a forced provider refusal on one session made every later
session fail, each after about 257 seconds of cognee's retries.

Two more measurements bear on cost and time. Up to the failure, the work per turn pair does not grow with the store.
Keyless, chat calls stay at 2.0 per pair and prompt size stays flat from 0 to 1,314 pairs. Metered, the same 67-session
BEAM-100K dev conversation (`100k-11`) used 400k input and 123k output tokens when added to a namespace already
holding 1,000 sessions, against 394k and 119k in an empty namespace. That is $0.0029 a pair at list price either way.
Write time does grow: about 3.8 ms more per session for every session already stored (keyless, from 1.1 seconds a
session at the start to 4.8 seconds at 1,000).

Memory: the container peaked at 8.27 GB unconstrained at the failure, mostly cognee's vector worker (3.4 GB) and graph
worker (1.3 GB). Under the old 6g limit it reached the limit at about session 1,050, 30 sessions before the failure,
and recorded 6,673 `memory.max` events and no OOM kill. The failure came at the same session with and without the
limit, so the limit did not cause it, but it left no headroom. The limit is now 12g.

The sealed S1 shards (amendment A23) failed the same way. On c2, 4,893 of 6,227 sessions failed. Of the first 200,
175 were cognee's `CognifyFailedError` (`'float' object has no attribute 'replace'`), 23 the WAL-checksum error, 1
the size limit and 1 an `AttributeError`; then every retrieval failed on the WAL error. No graph-pipeline log has an
exit 137, so the corruption came before any stop. Six shards spent their $65 lease on ingest, and three ingested for 62
hours without finishing. The scoreboard reports the S1 cell as not run: three of ten shards measured past the 48-hour
limit per conversation, and the store's own failures account for the rest.

## Known behavior worth measuring

- After a delete, no chunk from the deleted session returns. Graph entities shared with a surviving session stay; in
  the keyless run their edge text still quoted the deleted session, in the metered smoke nothing did. `lifecycle-lite`
  should score entity and fact items, not only chunks.
- cognee's search takes no query date, so `query_time` is ignored; dates live in the item text.

## Metered smoke, 2026-10-05

One run per configuration through `eval/runner/metering-proxy.ts` (lease mode, $0.50 lease each, slot `cognee`),
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
