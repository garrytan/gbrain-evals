# Preregistration: N6 visibility fuzz on Postgres over the real HTTP transport (2026-10-06)

Frozen on October 6, 2026, in its own commit, before the harness that runs it exists and before any cell runs. Nothing below changes after a cell runs; a later change is a dated amendment at the end. Workstream W12 of the [2026-10 follow-up round](../plans/2026-10-06-followups-round/PLAN.md) (inventory row D4; CEO finding C15; eng finding G-18).

## Question

N6 (`visibility-leak-fuzz`) gates gbrain's read surface on in-memory PGLite, calling `dispatchToolCall` in process with the options the stdio and HTTP servers pass. It has never exercised the production engine (Postgres), the network HTTP transport, OAuth token verification, a pooled database connection shared by callers of different authority, or a server whose caches were warmed by a more privileged caller. Does the visibility boundary hold on that combined production path? A leak there blocks every current-pin privacy claim in this round until gbrain fixes it.

## Evidence class

Regression gate on synthetic data with known answers (`synthetic-production-path`). It is not a held-out confirmation and it is not a penetration test of the network stack.

## Build and data

- gbrain `c5fb0201d1960a0a5a81c35d77718311b03154b7` (v0.60.95.0), the round's pin, installed dependency, Bun 1.4.2. The HTTP server is the gbrain CLI, `gbrain serve --http --bind 127.0.0.1 --port <free port>`, a separate process with a keyless environment.
- Postgres: the `pgvector/pgvector:pg16` Docker image (digest recorded in the receipt), published on `127.0.0.1` only, one fresh database per run created by the runner and dropped afterwards. Nothing listens on a public interface.
- World: N6's generator unchanged, `n6-visibility-v2`, seed 20260930, ledger hash recorded. Pages, raw data and ontology rows are written through gbrain's own write path (`put_page`, `put_raw_data`, `ontology_propose`) by a trusted local caller on the same Postgres database, as N6 does on PGLite. Sources `alpha` and `beta`.
- Parameter synthesis, targets (protected, public twin, never-written ghost), variants (each enum value, `source_id=beta`, `source_id=__all__`) and the leak scanners are N6's, including the named window and the notice-block parsing added in W2.

## The frozen coverage matrix

**Mandatory ops: the 31 read ops N6 covered at `c5fb0201` on PGLite** (W2 receipt `2026-10-06-n8-privacy-gate/n6-receipt-c5fb0201.json`): `entity`, `get_page`, `list_pages`, `fetch`, `search`, `query`, `assemble_evidence`, `get_tags`, `get_links`, `get_backlinks`, `traverse_graph`, `get_timeline`, `get_versions`, `get_raw_data`, `resolve_slugs`, `get_chunks`, `find_orphans`, `takes_list`, `takes_search`, `think`, `get_recent_salience`, `chronicle_day`, `chronicle_since`, `chronicle_last_seen`, `ontology_get`, `volunteer_chronicle`, `volunteer_context`, `recall`, `context_pack`, `delta`, `find_trajectory`. (The plan said 30; `volunteer_context` became the 31st with W2's named window.)

**Mandatory principals, every call over real HTTP to the running server:**

| Principal | How it authenticates | What it may see |
|---|---|---|
| `none` | no `Authorization` header | nothing: every request refused |
| `invalid-token` | a well-formed bearer token the server never issued | nothing: every request refused |
| `expired-token` | a real access token from a client registered with `--token-ttl 60`, used after it expired (the runner waits past `expires_in` plus 5 s) | nothing: every request refused |
| `scoped` | OAuth `client_credentials` client, scope `read`, write source `alpha`, no federation | only `alpha`, no private page, no held Take, no private Fact or ontology row, no derived atom |
| `owner` | OAuth `client_credentials` client, scopes `read write admin`, source `alpha`, federated read `alpha,beta` | `alpha` and `beta`; still no private page, held Take, private Fact or ontology row, or derived atom, because gbrain excludes private pages for every remote caller unless the operator opts out (`src/core/search/private-visibility.ts`), and the default Takes holder list is `world` |

**Mandatory cells: 31 ops x 5 principals = 155.** A cell is covered when:

- refused principals (`none`, `invalid-token`, `expired-token`): the runner made at least one `tools/call` for the op, aimed at a protected target, and the server refused it (HTTP 401 or 403, or a JSON-RPC error naming authentication), with no protected marker or protected slug anywhere in the status line, headers or body. The principal's `initialize` and `tools/list` are refused too (checked once per principal).
- `scoped` and `owner`: at least one signal-bearing probe, as N6 defines it: the trusted local caller on the same Postgres database, given the same arguments, reads protected content, and the principal sees the public twin through the op.

**Conditions the mandatory cells run under:**

- *Warm caches.* The probe pass runs in three phases on one server process: `owner` first (it warms every server-side cache with a caller that can read `beta`), then `owner` and `scoped` interleaved, then `scoped` alone again. Leaks are counted in every phase. The scoped cell is covered only if its probes ran in both later phases.
- *Pooled connections.* The server runs with `GBRAIN_POOL_SIZE=8` and the interleaved phase keeps 8 requests in flight across both principals, so pooled connections serve callers of different authority back to back. The runner samples `pg_stat_activity` for the server's database during that phase; fewer than 2 concurrent server connections means the condition was not met, and every `scoped` and `owner` cell counts as not covered.
- *Fresh sessions.* Every probe call opens its own MCP session with the principal's cached access token, so gbrain's per-session notice dedupe cannot make a protected and a ghost call differ.

**What is scanned, per response:** returned pages and rows, excerpts and snippets (every text block, notice blocks included), counts and aggregate fields (through N6's existence-oracle check: a protected target must answer exactly like a never-written ghost once target values and volatile keys are masked, so a count that includes a protected row differs), and error text (refusals and tool errors are scanned like successes).

**Optional cells, named in advance,** each a surface N6 does not seed today: the schema-pack ops (`get_active_schema_pack`, `list_schema_packs`, `schema_stats`, `schema_lint`, `schema_graph`, `schema_explain_type`, `schema_review_orphans`), the aggregate ops (`takes_scorecard`, `takes_calibration`, `get_calibration_profile`, `find_anomalies`, `find_experts`) and the open-loop op (`open_loops`). Each needs its own seeded protected content and positive control. Any optional cell not finished inside the one-day time box is published as **Not covered** by name with its reason; an optional cell never affects the gate unless it leaks.

## Metric and denominator

Per cell: probes, signal-bearing probes, content leaks (a protected marker in any response), existence leaks (a protected slug, or a `beta` row for `scoped`, in a field the probe did not ask for), existence oracles, refusals and harness errors. Denominators are each cell's own probe count. A harness timeout or a call that never completed is an error row, never a clean probe. Wall time and call counts per phase are recorded.

## Decision rule

Pass requires all of:

1. 0 content leaks, 0 existence leaks and 0 existence oracles in every cell, mandatory and optional, in every phase.
2. 0 accepted requests from `none`, `invalid-token` and `expired-token` (any non-refused response is a leak, whatever its body).
3. Every one of the 155 mandatory cells covered. A missing mandatory cell fails the gate, whatever the reason (the op is not exposed over HTTP, the harness could not reach it, the pooled-connection condition was not met).
4. The run completes with valid accounting (harness errors under 2% of calls, none in a mandatory cell's only signal-bearing probe).

No statistics: exact counts on deterministic runs. One publication run, with this file's attestation in the receipt (`--attest`). A leak is published as a gbrain finding with a keyless repro, the rule is not relaxed, and this round's current-pin privacy claims are withheld until gbrain fixes it. A harness defect found after a cell runs is fixed in its own commit, recorded as a dated amendment here, and the run is repeated; the earlier receipt is kept.

## What each outcome changes

| If it passes | If it fails on a leak | If a mandatory cell is missing |
|---|---|---|
| The visibility boundary is shown on Postgres over real HTTP for these 31 ops and five principals; README's privacy rows may say "PGLite and Postgres, in process and over HTTP" for the covered ops | A gbrain finding with a repro; privacy claims at the pin withheld until fixed | The gate fails; the report names each missing cell and why, and the claim stays limited to what was covered |

## Budget

None: no paid request, no provider key in any process. No ledger run is opened. Local Docker on the primary machine, or a Ubicloud VM with no provider key if local Docker fails.

## Amendments

None yet.
