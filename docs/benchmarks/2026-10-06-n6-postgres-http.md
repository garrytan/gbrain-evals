# The visibility boundary holds on Postgres over real HTTP: 155 of 155 mandatory cells covered, 0 leaks at gbrain `c5fb0201`

Date: 2026-10-06. Workstream W12 of the [2026-10 follow-up round](../plans/2026-10-06-followups-round/PLAN.md). Evidence class: regression gate on synthetic data with known answers. Build: gbrain `c5fb0201` (v0.60.95.0), the round's pin. No model is involved and the cost is $0. Status: **Complete** for the 155 mandatory cells; the 13 optional cells are **Not covered** (named below).

## The finding

[gbrain](https://github.com/garrytan/gbrain) is a memory system for agents. It keeps some things from remote callers: pages marked `visibility: private`, Takes rows held by a named person, private Facts and ontology rows, derived atoms (private unless marked otherwise), and sources a caller was not granted. N6, the visibility fuzz, has gated that promise since September, but only on in-memory PGLite with the server's call logic replayed in process. Production deployments run Postgres behind `gbrain serve --http`, with OAuth tokens, a connection pool shared by every caller and server-side caches.

This run puts N6's world and probes on that production path. A fresh Postgres database, a real `gbrain serve --http` process bound to `127.0.0.1`, and five principals, each making real HTTP requests:

| Principal | Credential | Mandatory cells covered | Result |
|---|---|---:|---|
| `none` | no `Authorization` header | 31 of 31 | every request refused with 401, no canary in status, headers or body |
| `invalid-token` | a well-formed token the server never issued | 31 of 31 | every request refused with 401 |
| `expired-token` | a real token from a client with a 60 s lifetime, used after it expired | 31 of 31 | every request refused with 401; the same token worked before it expired |
| `scoped` | OAuth client, scope `read`, source `alpha` | 31 of 31 | 928 signal-bearing probes, 0 leaks, 0 existence oracles |
| `owner` | OAuth client, scopes `read write admin`, sources `alpha` and `beta` | 31 of 31 | 906 signal-bearing probes, 0 leaks, 0 existence oracles; it did read the `beta`-only page, so its grant was real |

All 31 read ops N6 covers on PGLite were covered here for every principal. That is 155 of 155 mandatory cells, over 10,756 HTTP calls with 0 harness errors. The preregistered gate [passes](2026-10-06-n6-postgres-http-preregistration.md).

To check that the gate can fail, the same runner started the server with gbrain's documented operator escape hatch `GBRAIN_REMOTE_PRIVATE_PAGES=1`, which shows private pages to remote callers. On three ops it reported 470 leaking probes, for example the private note's body returned by `get_page`, and failed as it should.

The claim this supports is narrow: on Postgres over HTTP at `c5fb0201`, none of the five principals got protected content from these 31 ops in this seeded world. It is not a general guarantee, and it is not a test of TLS, proxies or the network stack beyond localhost.

## The concrete case

An invented example from the fixture. Source `alpha` holds a private note, `notes/guwahusoq`, titled "Note zxkapewezeteq", next to a public twin with the same shape. The scoped client calls `search` for "zxkapewezeteq". The trusted local caller on the same database, asked the same thing, finds the private note, so the probe aims at real content. The scoped client gets no hit and no trace of it. Asked for the public twin's word, the same client finds the twin, so the empty answer is filtering, not a broken search. Asked for a word that was never written, it gets a response identical to the private case once volatile fields are masked. A difference there would reveal that the private page exists, even without its text.

## The experiment and results

**World and probes.** N6's generator unchanged (`n6-visibility-v2`, seed 20260930): 19 pages in sources `alpha` and `beta`, eight protected classes, each with a public twin and a never-written ghost. Pages, raw data and ontology rows were written through gbrain's own write path by a trusted local caller, after the server started, because gbrain journals Postgres writes and the server's persistence consumer applies them. Every probe runs three calls (protected, ghost, twin), with N6's parameter synthesis and scanners, including W2's named window and notice-block parsing.

**What is scanned.** Every text block of every response, notice blocks included, for protected markers. Slug fields, and `beta` rows for the scoped client, for existence. Protected and ghost responses are compared for existence oracles, which is how a count or aggregate that includes a protected row would show up. For refused principals, the status line, headers and body.

**Conditions** (frozen in the preregistration):

| Condition | How | Measured |
|---|---|---|
| Warm caches | `owner` probes everything first, then `owner` and `scoped` interleaved, then `scoped` again | every scoped cell had signal in both later phases |
| Pooled connections | server pool of 8 (`GBRAIN_POOL_SIZE=8`), 8 requests in flight across both principals | up to 9 server connections to the database and 5 active at once during the interleaved phase |
| Rate limits | raised (`GBRAIN_HTTP_RATE_LIMIT_IP` and `_TOKEN`) so the probe load is not throttled | 0 responses with HTTP 429 |
| Sessions | the server is stateless (it issues no MCP session id) | recorded |

| Phase | Probes | Wall time |
|---|---:|---:|
| notice warm-up (one neutral call per op and principal) | 88 | not timed separately |
| `owner` alone | 945 | 18 s |
| `owner` and `scoped` interleaved | 2,005 | 33 s |
| `scoped` again | 1,060 | 18 s |

The whole run took 1 min 43 s on the shared 4-core cloud machine, including setup, the trusted local replays and a wait for the short-lived token to expire.

**Optional cells (Not covered).** The preregistration named 13 optional ops: the schema-pack ops (`get_active_schema_pack`, `list_schema_packs`, `schema_stats`, `schema_lint`, `schema_graph`, `schema_explain_type`, `schema_review_orphans`), the aggregate ops (`takes_scorecard`, `takes_calibration`, `get_calibration_profile`, `find_anomalies`, `find_experts`) and `open_loops`. All 13 were called by every principal and none leaked. None had signal, because N6's world holds no protected content those ops return. Each needs its own seeded fixture: a schema pack with a private type, resolved Takes and calibration rows, Gmail-shaped open loops. That did not fit the time box, so these are Not covered, and a zero there means "not measured".

**A harness defect found on the way (amendment).** The first attested run covered every mandatory cell with 0 leaks but reported 2 existence oracles, both on `think`. In each, the protected response carried one extra block, gbrain's `synthesis_keyless` info notice, and was otherwise identical to the ghost. Two diagnostic reruns put the extra notice on a different target each time, always on the principal's first `think` call. gbrain's HTTP notice ledger shows such notices once per client (`src/core/notice-ledger.ts`), and this stateless transport gives the harness no session to isolate calls. The runner now makes one neutral call per op and principal before the probes, so those notices are consumed first. The warm-up responses are scanned too. The fix is a dated amendment in the preregistration, and the first receipt is kept.

| Run | Status | Note |
|---|---|---|
| First attested run | Failed | 155/155 covered, 0 leaks, 2 oracles from the once-per-client notice |
| Attested run after the fix | Complete | 155/155 covered, 0 leaks, 0 oracles, 0 accepted unauthenticated requests |
| Negative control (`GBRAIN_REMOTE_PRIVATE_PAGES=1`, 3 ops) | Complete | fails with 470 leaking probes, as expected |

## What to use and what to avoid

For the 31 covered read ops, a gbrain at `c5fb0201` served over HTTP from Postgres keeps private pages, held Takes, private Facts and ontology rows, derived atoms and ungranted sources away from OAuth clients, including a full-scope client, and refuses missing, forged and expired tokens. Pooled connections and caches warmed by a more privileged client did not carry anything across. Do not read this as covering the schema-pack, aggregate or open-loop ops, writes by write-scoped clients, or deployments with `GBRAIN_REMOTE_PRIVATE_PAGES=1` or `search.remote_private_pages` set, which deliberately show private pages to remote callers.

## Reproduce and inspect

Keyless, $0, under a second: recompute the verdict from the committed cells.

```bash
bun eval/runner/n6-postgres-http.ts rescore docs/benchmarks/2026-10-06-n6-postgres-http/receipt.json
# n6-postgres-http: pass; mandatory cells 155/155 covered; leaks 0; oracles 0; accepted 0
bun eval/runner/n6-postgres-http.ts rescore docs/benchmarks/2026-10-06-n6-postgres-http/receipt-control-remote-private-pages.json   # fail, 470 leaks (exit 1)
```

Live, keyless and $0, about 2 minutes. It needs Docker and Bun 1.4.2.

```bash
docker run -d --name n6-pg -p 127.0.0.1:55442:5432 -e POSTGRES_HOST_AUTH_METHOD=trust pgvector/pgvector:pg16
bun install --frozen-lockfile
bun eval/runner/n6-postgres-http.ts --pg-url postgres://postgres@127.0.0.1:55442/postgres \
  --attest docs/benchmarks/2026-10-06-n6-postgres-http-preregistration.md --output /tmp/n6pg
bun eval/runner/n6-postgres-http.ts --control-remote-private-pages --only get_page,search,list_pages --output /tmp/n6pg-control
bun test test/eval/n6-postgres-http.test.ts
docker rm -f n6-pg
```

Receipts in [`2026-10-06-n6-postgres-http/`](2026-10-06-n6-postgres-http/): `receipt.json` is the counting run, with the preregistration attestation, the Postgres image digest (`pgvector/pgvector@sha256:7b822b0a...`, PostgreSQL 16.15), every cell, the pool samples and the refusal status codes. `receipt-run1-notice-order.json` is the first run, and `receipt-control-remote-private-pages.json` the negative control. Runner: `eval/runner/n6-postgres-http.ts`, which reuses N6's seeding, synthesis and scanners from `eval/runner/n6-visibility-fuzz.ts`.
