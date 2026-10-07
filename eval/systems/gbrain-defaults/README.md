# gbrain-defaults shim

This directory runs gbrain with its shipped defaults behind the comparison harness's
[shim protocol v1](../PROTOCOL.md), sandboxed like the external systems: gbrain is installed the documented way inside
its own image, holds dummy provider keys, and reaches Voyage, OpenAI and Anthropic only through the metering proxy.
It is the Q1 scoreboard's headline gbrain row, kind `gbrain-defaults` in [kinds.json](../kinds.json).

## What it runs

| Piece | Value |
|---|---|
| gbrain | `bun install -g github:garrytan/gbrain#<GBRAIN_SHA>` at image build; default `c5fb0201d1960a0a5a81c35d77718311b03154b7` (0.60.95.0) |
| Runtime | Bun 1.4.2 (`oven/bun:1.4.2-slim` by digest) inside the image only; the harness host keeps its own Bun |
| Install | `config.json` with `provider_base_urls.{voyage,openai,anthropic}` pointed at the proxy, then `gbrain init --pglite --json`, `gbrain apply-migrations --yes --non-interactive --no-autopilot-install`, and the scripted "defaults" reply (each first-run decision's default argv, as init prints it) |
| Resolved defaults | PGLite, `voyage:voyage-4` at 1,024 dimensions, search mode `tokenmax` (reranker `voyage:rerank-2.5`, LLM expansion with `claude-haiku-4-5`, search limit 50), synthesis `claude-opus-4-7`; read live from `gbrain search modes --json` and `gbrain models --json` and published under `/capabilities` → `resolved` with a sha256 |
| Agent surface | `gbrain serve --surface starter` over MCP stdio, the registration gbrain's `harness_wiring` option names; `GBRAIN_FULL_SURFACE=1` serves `--surface full` for the labeled `think` row |
| Network | the shim container sits on an internal network; the `egress` relay publishes the shim and forwards `egress:9000` to the proxy |

gbrain does not read a `VOYAGE_BASE_URL` environment variable; its Voyage recipe takes its base URL from
`provider_base_urls.voyage` (`src/core/ai/build-gateway-config.ts`, `gateway.ts` `applyOpenAICompatConfig`), and the
native OpenAI and Anthropic clients fold `provider_base_urls.{openai,anthropic}` into their base URLs. So the shim
writes all three before `init` runs its embedding probe.

## How the shim maps the protocol

| Endpoint | What happens |
|---|---|
| `/reset` | a fresh scripted install for the namespace, verified against the stack's first (reference) install: resolved configuration, config hash and starter `tools/list` must match |
| `/ingest` | `put_page` of one `type: conversation` page at `conversations/<date>/<source id>` (frontmatter `type`, `title`, `date`; one `**Speaker** (YYYY-MM-DD h:mm AM): text` block per turn, gbrain's conversation-parser anchor shape, never truncated) with request id `uuidv5(namespace|source_id)` and `wait_ms` 30000; a pending receipt is polled with `get_write_request` until terminal. A replay returns gbrain's stored receipt; different content for a written session is refused |
| `/finish` | the quiesce barrier: stop serve, `gbrain doctor --json` with the brain to itself, require every expected page and 0 chunks missing embeddings (restarting serve to drain embedding effects while short), restart serve, confirm every page with `list_pages`. Doctor under a live serve (`details.reason: live_serve`) fails it |
| `/retrieve` | `query`: bare for `vendor-default`, `limit: 50, autocut: false` for `fixed-evidence`, never `token_budget` (it switches gbrain to chunk delivery). The response meta and notices come back under `raw`, classified per the capability record's `degraded_reads`. The preregistered shipped-behavior delivery fallbacks (`redaction_unmapped`, `no_text_chunks`; `GBRAIN_SHIPPED_FALLBACKS` overrides, `/capabilities` → `shipped_behavior` shows the set) are recorded and counted (`/health` → `shipped_fallbacks`), never a degraded read |
| `/delete_source` | `unsupported`: the starter surface has no page delete |
| `/answer` | gbrain's own answer (the protocol's optional route, advertised as `/capabilities` → `answer`: modes `synthesize`, plus `think` on the full surface, and `models.synthesize`, gbrain's resolved `models.think`): `synthesize` (starter), or `think` with `model` and `reference_date` on the full surface |
| `/stats`, `/restart` | serve memory and brain size, and serve restart time, for the stress pilot |

`service_ms` is measured in the shim around each MCP call; `gbrain_ms` in each response is the MCP call itself.
Namespaces run one at a time (`parallel_namespaces: false`): each brain is a clean install at one fixed
`GBRAIN_HOME`, moved in and out of place by rename. Brains are never copied, because gbrain binds a brain's content
checkout to its inode and birth time and a copied brain refuses writes with `recovery_required`.

## Run it

```bash
# Keyless, with the in-compose fake upstream standing where the proxy stands
PROXY_UPSTREAM=fake-upstream:8787 docker compose -f eval/systems/gbrain-defaults/docker-compose.yml --profile keyless up -d --build
SHIM_URL=http://127.0.0.1:8700 bun test test/eval/systems-conformance.test.ts
SHOOTOUT_DOCKER_TESTS=1 bun test test/eval/gbrain-defaults-docker.test.ts     # its own stack, then torn down

# Metered, behind a lease proxy
bash eval/systems/bootstrap.sh proxy --lease-id <id> --lease-usd <n>
bash eval/systems/bootstrap.sh up --system gbrain-defaults --timeout 900
```

The first start installs the reference brain (about 15 seconds keyless); every `/reset` after it runs one clean
install. `eval/runner/q1/stress-pilot.ts` drives the dev stress pilot against this stack.
