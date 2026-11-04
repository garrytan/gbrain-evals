# Hindsight 1.1.0 with its server defaults (`recipe-1.1`)

This directory runs [Hindsight](https://github.com/vectorize-io/hindsight) 1.1.0 (tag v1.1.0, `a5a619b5`, released
2026-10-21) behind the shootout's shim protocol ([PROTOCOL.md](../../../../eval/systems/PROTOCOL.md)), with every server
setting at its 1.1.0 default. It is the `recipe-1.1` configuration of the `ext-memory-bank` kind, the build the RS1
preregistration names. The pinned 0.10.2 configurations (`recipe`, `common`) keep their own files one directory up,
unchanged, so Q1's and the memory proof wave's cells and hashes still describe what ran. The newest release is 1.2.0
(tag v1.2.0, `34a13868`, released 2026-11-03); this build does not use it.

## What changes from 0.10.2

| Setting | 0.10.2 `recipe` | 1.1.0 `recipe-1.1` |
|---|---|---|
| Extraction LLM (`openai` provider default) | `gpt-4o-mini` | unchanged |
| Embedder | local `BAAI/bge-small-en-v1.5`, 384 dimensions | unchanged |
| Reranker | local `cross-encoder/ms-marco-MiniLM-L-6-v2` | unchanged |
| Entity trigram threshold (`HINDSIGHT_API_ENTITY_TRGM_SIMILARITY_THRESHOLD`) | 0.15 | 0.3 |
| Decision model (`HINDSIGHT_API_DECISION_MODEL_PROVIDER`) | did not exist | `none` (off) |
| Consolidation through the decision model (`HINDSIGHT_API_CONSOLIDATION_USE_DECISION_MODEL`) | did not exist | `true`, inert: no decision model, and observations are off per bank |
| Recall `prefer_observations` | the client sent `false` on every recall | the client sends `null`, which resolves to the new server default `HINDSIGHT_API_RECALL_PREFER_OBSERVATIONS`, `false` |
| Per-candidate reranker truncation | LiteLLM reranker only, unset | every reranker (`HINDSIGHT_API_RERANKER_MAX_TOKENS_PER_CANDIDATE`), unset |

[hindsight.recipe-1.1.env](hindsight.recipe-1.1.env) writes out the first seven rows, so the record does not depend on
the image's defaults; the truncation knob is left unset, which is its default. The list
comes from comparing every module-level constant and every environment default in `hindsight_api/config.py` at both
tags. The trigram threshold is set on every database connection and decides which existing entity names are
candidates during entity resolution at retain; 1.1.0 raised it to the merge floor (`ENTITY_MERGE_MIN_SIMILARITY`, 0.3
in both), because candidates below the floor were always discarded (vendor #5367). The decision model is a new,
optional extra model that recall, reflect and consolidation can consult; its provider defaults to `none`, and this
recipe keeps the vendor's default. Other new settings (NVIDIA and ONNX rerankers, NVIDIA embeddings,
reflect and mental-model switches, logging) do not touch retain or recall here.

## How the shim builds it

The client calls are unchanged. On the PyPI wheels of `hindsight-client` 0.10.2 and 1.1.0, the methods the adapter
calls keep their signatures (only `arecall`'s `prefer_observations` default moved from `False` to `None`), and the
generated API calls and response fields it reads are identical. So the image runs the pinned adapter, `../shim.py`,
unchanged (copied in as `hindsight_shim.py`), and [shim.py](shim.py) adds one check: `/health` refuses unless the
server's `/version` reports the `server_version` that [capability.json](capability.json) records. The record's
`client_compatibility` field lists what was compared.

The lock (`uv.lock`, from `uv lock`) resolves `hindsight-client` 1.1.0's dependencies to the versions in Hindsight's
own `uv.lock` at v1.1.0, through `constraint-dependencies`, as the 0.10.2 bundle does. The server image is
`ghcr.io/vectorize-io/hindsight:1.1.0` by digest; its OCI labels name version 1.1.0 and revision `a5a619b5`, and it
carries both local models (`bge-small-en-v1.5` snapshot `5c38ec7c`, `ms-marco-MiniLM-L-6-v2` snapshot `233902d2`).
Postgres stays `pgvector/pgvector:0.8.1-pg18`. The compose project is `shootout-hindsight-recipe-11`, so its volumes
never mix with the 0.10.2 stack's.

## Licences

The server and `hindsight-client` 1.1.0 are MIT (the repository's LICENSE at the tag, the client's `pyproject.toml`
and its PyPI metadata). The default embedder `BAAI/bge-small-en-v1.5` is MIT and the default reranker
`cross-encoder/ms-marco-MiniLM-L-6-v2` is Apache-2.0, per their model cards (checked 2026-11-03).

## Run

```bash
bash eval/systems/bootstrap.sh up --system ext-memory-bank --config recipe-1.1
# restart, down, snapshot and restore take the same --config to find this stack
bash eval/systems/bootstrap.sh down --system ext-memory-bank --config recipe-1.1
```

Keyless plumbing check, from the repository root. Hindsight's own mock LLM (`HINDSIGHT_LLM_PROVIDER=mock`) turns each
input sentence into a canned fact, so no provider call is made and the proxy check can be off. `/health` reports
`llm_provider: mock`, so such a run cannot pass for a real one, and its retrieval results say nothing about memory
quality.

```bash
HINDSIGHT_LLM_PROVIDER=mock BOOTSTRAP_PROXY_CHECK=off bash eval/systems/bootstrap.sh up --system ext-memory-bank --config recipe-1.1
python3 docs/comparison-systems/ext-memory-bank/recipe-1.1/test_shim.py --url http://127.0.0.1:8700
```

`test_shim.py` runs the pinned protocol smoke test as written, except that it expects the record to hold exactly
`recipe-1.1` instead of `recipe` and `common`.

## Keyless smoke (2026-11-03)

The check above passed every step on this build with the mock LLM: health (server `api_version` 1.1.0), the
capability record, 3 retains (5, 4 and 4 memory units), finish, both retrieval policies (9 fact items each, the
painting session cited first, provenance exact), the namespace canary, delete (4 memory units removed, the survivor
still cited), the error shapes and the final reset. No provider call was made. No metered run has used this build yet;
stage 1 of RS1 is its first.
