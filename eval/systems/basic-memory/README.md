# Basic Memory shim

This directory runs [Basic Memory](https://github.com/basicmachines-co/basic-memory) `0.23.2` behind the shootout's
[shim protocol v1](../PROTOCOL.md). Basic Memory stores notes as Markdown files and indexes them in SQLite with
full-text search and local vector search (sqlite-vec). Its documented local install needs no API key, so the recipe
configuration runs end to end without any provider call.

## What it runs

| Piece | Value |
|---|---|
| Package | `basic-memory==0.23.2`, every transitive dependency held to the vendor's own `uv.lock` at tag `v0.23.2` (commit `c0bd87c6`) through `constraint-dependencies` in `pyproject.toml` |
| Prereleases | `fastmcp==4.0.0b1` and `fastmcp-slim==4.0.0b1` (Basic Memory requires `fastmcp==4.0.0b1`), plus `opentelemetry-instrumentation` and `opentelemetry-semantic-conventions` `0.63b1` from the vendor lock. uv's default `if-necessary` prerelease mode resolves them; `prerelease = "allow"` is not needed and would pull newer betas |
| Base image | `python:3.12-slim-bookworm@sha256:54c85f3c…`, uv `0.12.3` by digest |
| Recipe embedder | FastEmbed `bge-small-en-v1.5` (384 dimensions), baked into the image at build time |
| Reranker | off. `jinaai/jina-reranker-v1-tiny-en` is the configured local model, but `reranker_enabled` defaults to `False` (`config_models.py:430`) and the vendor benchmark leaves it off |
| Common embedder | `text-embedding-3-large` at 1,536 dimensions through Basic Memory's LiteLLM provider, sent to `OPENAI_BASE_URL` |
| Agent surface | the vendor MCP server, `bm mcp` over stdio |

`capability.json` is the full capability record. The shim adds the `uv.lock` hash at run time and the image digest
from `SHIM_IMAGE` when the harness sets it.

## How the shim maps the protocol

The flow starts from Basic Memory's own LoCoMo benchmark (`benchmarks/` at tag `v0.23.2`): a converter writes one
note per session, the `bm-local` provider runs `bm project add` and `bm reindex --search --embeddings -p`, then calls
`search_notes` with `search_type="hybrid"` and JSON output over a warm `bm mcp` stdio session.

| Endpoint | What happens |
|---|---|
| `/reset` | `bm project remove <ns> --delete-notes`, then an empty directory `/data/notes/<ns>` |
| `/ingest` | writes `<source_id>.md` in the vendor converter's format: title `src-… (1:56 pm on 8 May, 2023)`, `session_date` frontmatter, a `# Chat session at …` heading and one `- **Speaker:** text` line per turn |
| `/finish` | `bm project add` on first use, then the vendor's `bm reindex --search --embeddings -p <ns>`. It reports `degraded` when the embedding summary shows errors or `bm status --json` counts fewer files than were written |
| `/retrieve` | `search_notes(query, project=<ns>, page_size=k, search_type="hybrid", output_format="json")`; k is 10 for `vendor-default` and 30 for `fixed-evidence`. Each row is one whole note, so each item cites exactly one session (`provenance_status: exact`) |
| `/delete_source` | the `delete_note` MCP tool on `<ns>/<source_id>`, then a check that the file is gone |

Basic Memory has no reference date in search, so `query_time` is ignored and the date lives in the note text.

## Deviations from the vendor benchmark

1. Sessions arrive one at a time and are indexed at `/finish`; the vendor converts a whole dataset first.
2. Note ids use the opaque `src-…` id, and the frontmatter drops `dataset_id`, `conversation_id` and
   `session_number`, which would carry dataset identity past the sanitizer.
3. The date is rendered from the ISO `event_time` into LoCoMo's phrase format for every dataset; the vendor copies
   LoCoMo's raw string. A LoCoMo date round-trips to the same text.
4. Real-time file watching is off (`BASIC_MEMORY_INDEX_CHANGES=false`) so the warm MCP server never indexes at the
   same time as `bm reindex`. Indexing still runs only through the vendor's command.
5. The MCP session starts with the container and serves every project; the vendor starts it after the first ingest.
6. Item text is the row's `matched_chunk`, prefixed with the note title when the chunk lacks it, as the vendor's
   `assemble_context` does. The vendor's 12,000-character, 10-hit context budget is replaced by the harness packer.
7. The MCP client is written here from scratch. Basic Memory is AGPL-3.0, so the container runs it unmodified and
   this repository copies none of its code.

## Build and run

```bash
docker build -f eval/systems/basic-memory/Dockerfile -t shootout/basic-memory:0.23.2 eval/systems
docker compose -f eval/systems/basic-memory/docker-compose.yml up -d
python3 eval/systems/basic-memory/protocol_check.py --url http://127.0.0.1:8701
```

Compose puts the shim on an internal network. Its only exits are `proxy`, a TCP relay to the metering proxy
(`PROXY_UPSTREAM`, default `host.docker.internal:8787`), and `ingress`, which publishes the shim's port on
`127.0.0.1:${SHIM_HOST_PORT:-8701}`. The container holds a dummy `OPENAI_API_KEY`. `SHIM_CONFIG=common` switches to
the common embedder; the recipe never calls a provider.

`protocol_check.py` is a stdlib script that drives any running shim through health, the capability record, reset,
two dated sessions, finish, dated probes, a namespace-isolation canary with a witness, delete and error shapes. Pass
`--json` to keep the full request and response transcript.

Timing on a 4-core machine: each `bm` CLI call costs about 5 seconds of start-up, so `/reset` takes about 6 seconds
and `/finish` about 15 seconds for a small namespace. Search over the warm MCP session took about 50 ms per query in the protocol check, after
a 1.5-second first query that loads the embedder.

## Changelog

### 2026-10-05: first version
Recipe configuration passes all 26 protocol checks keyless inside the sandboxed compose stack, with egress blocked.
