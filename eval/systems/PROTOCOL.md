# Memory-system shim protocol (v1)

Every system in the [open-source memory shootout](https://github.com/garrytan/gbrain-evals/blob/1b7cc28/docs/plans/2026-10-05-oss-memory-shootout/PLAN.md) runs
behind a small HTTP service, its shim, inside the vendor's own pinned image. The harness
(`eval/runner/systems/http.ts`) talks only this protocol, so vendor Python never enters the Bun process. gbrain
implements the same interface in process (`eval/runner/systems/gbrain.ts`).

All bodies are JSON. Every response carries `service_ms`, the time the shim spent inside the vendor call. Errors return
HTTP 4xx or 5xx with `{ "error": { "kind": "...", "message": "..." } }`, where `kind` is one of `unsupported`,
`product_error`, `timeout`, `invalid_request` or `budget` (the metering proxy refused a provider call).

## What crosses the boundary

The harness sanitizes everything before it reaches a shim. A shim receives opaque ids (`ns-…`, `src-…`), dated text and
speaker roles only, never dataset ids, answer labels, question categories or abstention markers. A shim must not log
request bodies outside its container, and must turn off vendor telemetry.

All provider calls go through `OPENAI_BASE_URL` (and `ANTHROPIC_BASE_URL`, `VOYAGE_BASE_URL` where used), which point at
the metering proxy. The container holds a dummy key; the proxy injects the real one. A shim whose SDK cannot be pointed
at the proxy is `blocked`.

## Endpoints

| Method and path | Request | Response |
|---|---|---|
| `GET /health` | | `{ "ok": true, "config": "recipe" \| "common" }` once the vendor backend accepts writes; `config` is the active `SHIM_CONFIG` (the shared base adds it when a shim does not) |
| `GET /capabilities` | | the capability record (below) |
| `POST /reset` | `{ "ns" }` | `{ "ok": true }`; the namespace is empty afterwards, including pending background work |
| `POST /ingest` | `{ "ns", "session": { "source_id", "event_time", "turns": [{ "role", "speaker", "content" }] } }` | `{ "items_created", "warnings": [], "errors": [], "completeness": "known" \| "unknown" \| "degraded" }` |
| `POST /finish` | `{ "ns", "timeout_s" }` | `{ "ready", "waited_ms", "completeness" }` after the vendor's background work drains |
| `POST /retrieve` | `{ "ns", "question", "query_time", "policy": { "name", "mode": "vendor-default" \| "fixed-evidence", "settings": {} } }` | `{ "items": [Item], "applied_settings": {}, "truncated": false, "raw": <vendor response, optional> }` |
| `POST /delete_source` | `{ "ns", "source_id" }` | `{ "status": "deleted" \| "partial" \| "unsupported", "receipt": {} }` |
| `GET /entities?ns=` (optional) | | the namespace's entity nodes and the system's own links between them (below) |
| `POST /answer` (optional) | `{ "ns", "question", "query_time", "mode", "model"? }` | the system's own answer (below) |

`event_time` and `query_time` are ISO-8601 strings or `null`. Sessions within one namespace arrive in event-time order,
one at a time. Different namespaces may be driven in parallel only if the capability record says
`"parallel_namespaces": true`.

An **Item** is one piece of returned evidence, in the system's own rank order:

```json
{ "id": "vendor item id", "rank": 1, "type": "fact | episode | chunk | note | entity | observation",
  "text": "the text the system returned", "source_ids": ["src-…"], "valid_from": null, "valid_to": null,
  "provenance_status": "exact | partial | unavailable" }
```

`source_ids` must be ids this namespace ingested; the harness rejects any other. `exact` means every listed source
contributed this item; `partial` means some did and the list may be incomplete; `unavailable` means the system's public
API cannot say, and `source_ids` is empty. A shim never queries a vendor database privately to manufacture provenance.

## Own answer (optional)

A system with its own answer endpoint (an answer verb, an agent reply) serves `POST /answer` and advertises it in its
capability record as `"answer": { "modes": ["…"], "models": { "<mode>": "provider:model" } }`. `modes` lists the
answer routes the running stack serves (gbrain-defaults: `synthesize`; `think` too when the stack runs with
`GBRAIN_FULL_SURFACE=1`). `models` names the model each mode answers with when the request carries no `model`, so the
harness can record the answer under that reader (`own:<model>`); a mode whose model the request picks (gbrain's
`think`, the frontier reader as `model`) may be absent from it. A system without the route omits `answer`, and the
harness never emulates one.

The request carries the sanitized question, its date, the mode and, optionally, the reader model. The response:

```json
{ "answer": "the full answer text", "outcome": "scored | harness_invalid", "degraded": null,
  "source_ids": ["src-…"], "model": "provider:model or null", "usage": { "input": 0, "output": 0 } , "usd": null,
  "raw": {} }
```

`outcome` is `scored` for an answer, also a product-degraded one (`degraded` names how, for example gbrain's
`extractive_fallback`); `harness_invalid` when the answer path could not run for a reason outside the product (a
provider refusal through the proxy), which the harness retries under the outcome rules. A mode the stack does not serve
is the `unsupported` error kind. `source_ids` are the ingested sources the answer cites.

## Entity readout (optional)

A system that resolves entities (merges two mentions of one person or company into one node, or proposes that two
nodes may be one) can serve `GET /entities?ns=<ns>`, which the entity-resolution head-to-head reads after ingest
(`eval/runner/entity-h2h/`). It reports what the system itself decided, read through the vendor's public node or
graph API; the shim never resolves anything on its own. The response:

```json
{ "entities": [{ "id": "vendor node id", "name": "the node's name", "type": "Person | null",
                 "source_ids": ["src-…"], "provenance_status": "exact | partial" }],
  "links": [{ "a": "node id", "b": "node id", "kind": "vendor link name", "tier": "auto | proposed", "score": null }],
  "notes": "how the shim read nodes, provenance and links" }
```

`source_ids` are the ingested sources that mention the node (`exact` when the vendor records every mention,
`partial` when it may not). `links` holds the system's own merge or same-entity edges between two surviving nodes:
`auto` when the system treats the two as one entity (a merge pointer such as `merged_into`), `proposed` when it
only flags them for review (a `SAME_AS` review band). A system that merges by reusing one node has no link for it:
both sources simply list the same node. A system without the route answers the `unsupported` error kind.

An entity-h2h shim also reports, under `GET /health`, the head-to-head setting its stack started in:
`"entity_h2h": { "setting": "default" | "<grid setting>", "settings": { "<knob>": value } }`. The setting comes from
`ENTITY_H2H_SETTING` (`eval/runner/entity-h2h/run.ts stack-env` writes it, with any server-side knob), and the
settings are the knob values the shim applied or the server was given, from the bundle's
`capability.json` `entity_h2h_tuning`. The runner refuses a cell (`STACK_CONFIG_MISMATCH`) whose stack reports
anything but the cell's own setting and settings.

## Capability record

```json
{
  "system": "ext-extract-first", "protocol": 1,
  "versions": { "package": "<package>==<version>", "lock_sha256": "…", "image": "…@sha256:…", "vendor_benchmark_code": "repo@commit or null" },
  "configs": {
    "recipe": { "model_roles": { "extraction": "…", "small": "…", "embedder": "…", "dims": 0, "reranker": null }, "notes": "documented local install" },
    "common": { "model_roles": { "extraction": "gpt-4.1-mini", "embedder": "text-embedding-3-large", "dims": 1536 }, "unsettable": [] }
  },
  "time": "native | in-text | none",
  "provenance": { "status": "exact | partial | unavailable", "mechanism": "…" },
  "delete": "native | public-api-composition | unsupported",
  "readiness": "how /finish knows background work is done",
  "namespace": "user_id | group_id | bank | dataset | project | …",
  "parallel_namespaces": false,
  "retrieval_policies": {
    "vendor-default": { "settings": { "k": 20 }, "notes": "what the knobs map to in the vendor API" },
    "fixed-evidence": { "settings": { "k": 200 }, "notes": "…" }
  },
  "streaming": "disabled | supported",
  "telemetry_off": ["ENV=VALUE"],
  "agent_surface": { "kind": "vendor-mcp | harness-mcp | native-agent | none", "transport": "stdio | http", "version": "…" },
  "deviations_from_vendor_code": ["…"],
  "answer": { "modes": ["…"], "models": { "<mode>": "provider:model" } }
}
```

`answer` is present only on a system that serves `POST /answer`. `entity_readout` is present only on a system that
serves `GET /entities` and says how its shim builds the readout: `endpoint`, `entities` (the vendor API the nodes come
from), `provenance` (how each node's sources are found), `links` (each vendor link name and the tier it maps to, empty
when the system keeps no such link) and `merge` (what the system does with a mention of a node it already has).

The active configuration is chosen at container start with `SHIM_CONFIG=recipe|common`; `/capabilities` reports both
and `/health` reports the active one.

### Retrieval policy settings

Each `retrieval_policies` entry holds its knobs under `settings`, a flat map of the values the shim passes to the vendor
call (`{ "k": 20 }`, `{ "budget": "mid", "max_tokens": 4096 }`), next to any documentation keys (`notes`, `maps_to`,
`resolved`, `why`, `api`). The harness sends exactly that `settings` map, merged with any `--policy-setting key=value`
overrides, as `policy.settings` on every `/retrieve`; documentation keys never cross. A shim reads its knobs from
`policy.settings` and falls back to its own record's `settings` for the mode. Records written before `settings` existed
are flattened by dropping the documentation keys, and the receipt says so (`policy.settings_source: flattened`); move
the knobs under `settings` so nothing is guessed.

A system with no passive memory API (`agent_surface.kind` `native-agent`, every policy `"supported": false`) answers
every passive call (`/reset`, `/ingest`, `/finish`, `/retrieve`, `/delete_source`) with the `unsupported` error kind.

The harness records `/health` and `/capabilities` (system, active config, versions) in each run's receipt and hashes
them into the run configuration, so a `recipe` run and a `common` run never share an output directory.

## Conformance

`bun test test/eval/systems-conformance.test.ts` drives a shim through reset, ingest of two dated sessions, finish,
retrieve, namespace isolation (a canary in one namespace never returns from another), delete and error shapes. It runs
keyless against the in-repo fake shim (`eval/systems/_fake/`) and, with `SHIM_URL` set, against any running shim.
