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
  "deviations_from_vendor_code": ["…"]
}
```

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
