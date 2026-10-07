# MemPalace shim

This directory runs [MemPalace](https://github.com/MemPalace/mempalace) `3.10.0` (PyPI, released 2026-09-16; tag
`v3.10.0`, commit `22fd87f09c19d5ffb2d6966486483353937931c0`) behind the shootout's
[shim protocol v1](../../../eval/systems/PROTOCOL.md), as the `ext-verbatim-session` kind. MemPalace stores
conversations verbatim, with no extraction or summarization, and searches them with ChromaDB vector search. Its
headline LongMemEval number (96.6% recall@5) comes from its raw mode: whole sessions in a ChromaDB collection,
queried with ChromaDB's default local embedder. Its 100% numbers add an LLM reranker on top; this bundle never runs
that step.

## What it runs

| Piece | Value |
|---|---|
| Package | `mempalace==3.10.0`, all 77 transitive dependencies held to the vendor's own `uv.lock` at tag `v3.10.0` through `constraint-dependencies` in `pyproject.toml`, resolved with `exclude-newer = 2026-10-06T00:00:00Z` (`chromadb==1.5.7`, `onnxruntime==1.24.4`) |
| Base image | `python:3.12-slim-bookworm@sha256:54c85f3c…`, uv `0.12.3` by digest |
| Embedder | ChromaDB's default `all-MiniLM-L6-v2` ONNX model (384 dimensions), baked into the image at build time. The build checks it gives the same vector as MemPalace's own default `minilm` embedder (cosine 1.0) |
| LLM | none. No model is called on ingest or retrieval, and the LLM reranker (`--llm-rerank`) is off |
| Vendor benchmark code | `benchmarks/locomo_bench.py` at the pinned commit, downloaded at build and checked by sha256 (`ba717874…`). The shim imports its corpus builder, query call and keyword, quoted-phrase and person-name helpers unmodified. MemPalace is MIT-licensed |
| Common config | not built. MemPalace has no extraction model, and this bundle runs only the local-embedder modes; the shim refuses `SHIM_CONFIG=common` |

`capability.json` is the full capability record. The shim adds the `uv.lock` hash at run time and the image digest
from `SHIM_IMAGE` when the harness sets it.

## Which modes run, and why

Only the two modes that need no API key:

- **`raw`**, the vendor's default `--mode raw`: vector search over whole-session drawers, top k.
- **`hybrid`**, `locomo_bench.py --mode hybrid` without `--llm-rerank`: vector search for 3k candidates, then each
  distance is shrunk by keyword overlap with the question's predicate words (weight 0.50), exact quoted phrases (0.60)
  and person names (0.20), and the top k are kept.

Both benchmark scripts build each palace with ChromaDB directly (`chromadb.PersistentClient`, collection
`mempal_drawers`, no custom embedding function), not with the `mempalace` miner or CLI. The shim does the same, so
it measures the code path behind the vendor's published raw and hybrid numbers. MemPalace's own `mempalace search`
(BM25 plus vector search over mined drawers and closets) is a different path and is not exercised here.

The LongMemEval script's hybrid modes (v1 to v4) are not run. They read LongMemEval's `question_date` string,
match LongMemEval question wording ("you suggested…"), add synthetic preference drawers, and v4 carries three fixes
the vendor tuned on three named misses. The LoCoMo hybrid is the vendor's general-purpose version.

## How the shim maps the protocol

| Endpoint | What happens |
|---|---|
| `/reset` | deletes and recreates `mempal_drawers` in the namespace's palace, `/data/palaces/<ns>/palace` (one ChromaDB `PersistentClient` per namespace) |
| `/ingest` | builds the vendor's session document with `build_corpus_from_sessions(..., granularity="session")`, every turn as `Speaker said, "text"`, and upserts it as one drawer whose id is the `src-…` id, with `timestamp` = `event_time` |
| `/finish` | nothing to wait for: ChromaDB embeds and indexes inside the upsert. Reports the drawer count |
| `/retrieve` | `collection.query(query_texts=[question])` through the vendor's `_query`; `recipe` and `k` come from `policy.settings`. `vendor-default` is `recipe=raw, k=10` (the vendor's default mode and `--top-k`); `fixed-evidence` is `recipe=raw, k=50` (the vendor's documented top-50 run). `--policy-setting recipe=hybrid` switches either policy to the hybrid recipe. Each item is one whole session, `type: episode`, `source_ids: [src-…]`, `provenance_status: exact`, `valid_from` = the stored event time |
| `/delete_source` | native: `collection.delete(ids=[source_id])`, then `collection.get` confirms the drawer is gone |

The session date is stored as drawer metadata, where the vendor puts it, and returned as `valid_from`; it is not in
the drawer text, and neither recipe reads `query_time`.

## Deviations from the vendor benchmark

1. Sessions arrive one at a time and are upserted into a persistent palace per namespace; the vendor adds a whole
   conversation in one call into a temporary palace. HNSW search is approximate, so batching could change near-ties.
2. Drawer ids and `corpus_id` metadata are the opaque `src-…` ids instead of `doc_<i>` and `session_<n>`.
3. `timestamp` metadata is the ISO `event_time`, not LoCoMo's raw date string. Neither recipe reads it.
4. Every dataset uses the LoCoMo session document with all turns. The LongMemEval script indexes user turns only;
   the shim cannot tell datasets apart, and keeping assistant turns lets questions about what the assistant said
   find their session.
5. The hybrid recipe is the LoCoMo script's; the LongMemEval script's v1 to v4 hybrids are not run (see above).
6. The scoring loop from `run_benchmark` is re-implemented in `shim.py` with the vendor's constants; everything it
   calls is the vendor's own function.
7. The embedder is baked into the image and the container has no internet route; the vendor downloads it on first use.

## Build and run

```bash
docker build -f docs/comparison-systems/ext-verbatim-session/Dockerfile -t shootout/mempalace:3.10.0 .
docker compose -f docs/comparison-systems/ext-verbatim-session/docker-compose.yml up -d
python3 eval/systems/_shim/protocol_check.py --url http://127.0.0.1:8703
```

Compose puts the shim on an internal network. Its only exits are `proxy`, a TCP relay to the metering proxy
(`PROXY_UPSTREAM`, default `host.docker.internal:8787`), and `ingress`, which publishes the shim on
`127.0.0.1:${SHIM_HOST_PORT:-8703}`. The shim holds a dummy `OPENAI_API_KEY` and an `OPENAI_BASE_URL` pointing at the
proxy, so any unexpected provider call would be counted there. Telemetry is off: `ANONYMIZED_TELEMETRY=False`
(ChromaDB), `HF_HUB_OFFLINE=1`, `HF_HUB_DISABLE_TELEMETRY=1`.

## Keyless check, 2026-10-06

`docs/comparison-systems/ext-verbatim-session/tests/run_keyless.sh` brings the stack up with
`eval/systems/_shim/fake_provider.py` as the proxy upstream, checks that the shim container cannot reach the internet
directly, runs `protocol_check.py --questions 3` against the raw recipe, runs one hybrid retrieval, then reads the
fake provider's request counts and tears the stack down.

Result on 2026-10-06 (image `sha256:f1bb34c488c17414150c963d94f7fb7e4023988048303e15eda2d21f1189c2f5`, built
locally): the shim had no direct route out (DNS fails inside the sandbox; the proxy route answers), 32/32 protocol
checks passed, the hybrid probe ranked the right session first, and the fake provider received zero requests. Ingest
took about 0.2 to 0.3 seconds per session and retrieval a few milliseconds on a 4-core machine. This is a plumbing
check, not a measurement of retrieval quality.

## Known limits

- Item text is the drawer document: every turn as `Speaker said, "text"`, with no date. The date reaches the reader
  only through `valid_from`.
- One drawer per session, so a long session is embedded as one vector; MiniLM reads only the first 256 word pieces of
  each drawer (ChromaDB's ONNX model truncates longer input), so the end of a long session does not affect its rank.
- No reference date: questions like "what did I do last week" get no temporal help in either recipe.
- `parallel_namespaces` is false; namespaces are isolated by separate palace directories.
- The common-models arm is not available from this bundle.

## Changelog

### 2026-10-06: first version
Pins MemPalace 3.10.0 (commit `22fd87f`) with the vendor's lock, runs the raw and hybrid recipes with the LLM
reranker off, and passes all 32 protocol checks keyless with zero provider requests.
