# A managed Postgres sync wedges when a transaction-mode pooler drops one round trip, and two consumers only multiply the chance

**Measured by gbrain on October 8, 2026 (GBRA-61, Phase 0 of the #6317 plan); mirrored into this repository on October 8, 2026. This mirror reruns nothing and spends nothing here.**

This follows [the October 8 preparation stall mirror](2026-10-08-managed-sync-preparation-stall.md). It records the reproduction behind gbrain issues [#6278](https://github.com/garrytan/gbrain/issues/6278) and [#6317](https://github.com/garrytan/gbrain/issues/6317): one production brain on Postgres behind Supavisor's transaction-mode pooler had not committed a sync page for eighteen days while every health signal stayed green. gbrain's record is `docs/eval/managed-sync-two-consumer-repro.md` in PR [#6330](https://github.com/garrytan/gbrain/pull/6330) (v0.60.117.0); the harness is `scripts/bench/managed-sync-stall-repro.ts` with `--scenario two-consumer` and `--chaos-kind partition`, on 16-vCPU Ubicloud VMs, PgBouncer in transaction mode, 57 ms of injected round trip, a 15,000-page backlog on a 1,500-page history source. Every number below is from the captures under `~/.capy/work/gbra61/phase0/` on the GBRA-61 machine (733 MB, not committed).

## The finding

| Question | Answer | Where |
|---|---|---|
| Does the wedge need two consumers on the host? | **No.** One `gbrain sync --no-lanes` with no `serve` wedges within one sample when the client→pooler half of its connections is dropped (socket left open). | runs E2, F2 (0.60.110), F (#6298's head) |
| What hangs? | postgres.js's query promise in `PostgresEngine.runUnsafe`: the backend sits `active` / `wait_event=ClientRead` for minutes, the consumer's `expired_claims` round trip is parked in JS (135 s observed, 5 s deadline fired, nothing settled), lease renewals park (claims lapse), the drain's progress poll parks 109–177 s, zero commits, 3.6–4.9% CPU. `cancel()` re-sends CancelRequest forever; the socket discard sits in a `finally` behind the parked await. | gbrain `postgres-engine.ts:2733-2744`, `vendor/postgres/src/index.js:463` |
| Does the preparation budget shipped in v0.60.112.0 (#6298) cover it? | **No, by construction**: the budget races preparers; the parked awaits are the consumer tick, the renewal, the publication transaction and the drain's poll. In run F a 16-member group sat at `publish:transaction` for 166 s with `abandoned_preparations: 0`, no `preparation_deadline`, no `preparation_stalled`; only the network recovering (lift at +240 s) ended it (commit at +281 s). | run F |
| Do two consumers wedge on their own? | **No.** 2 h 49 min of the reporter's two-process shape (`serve --http` plus the sync CLI with 6 lanes) on 0.60.110, three arms, published 4,951 pages with no `preparing` claim older than 25.5 s and no server-side statement older than 11.5 s. A second consumer doubles the pooled round trips a dropped exchange can park, and a group memo or transaction parks every member at once (how sixteen members showed the same age). | runs A, B, C |
| What fixes it? | gbrain [#6329](https://github.com/garrytan/gbrain/pull/6329) (v0.60.114.0): after `cancel()`, a statement still pending at the settle window has its connection discarded, the phase ends `deadline_exceeded`, the drain resumes. [#6330](https://github.com/garrytan/gbrain/pull/6330) (v0.60.117.0) routes the consumer's own round trips over the direct/session-mode URL when one is configured, shows the owner backend's `pg_stat_activity` state in `writer status`, and makes "healthy" mean data moved. | gbrain CHANGELOG 0.60.114.0, 0.60.117.0 |

## Two-consumer arms (0.60.110, `1935c74a`)

Seed drain run 7–8 min then SIGTERM (the reporter's watchdog kill), 40 s for its claims to lapse, `gbrain serve --http` boots alone and claims the dead run's FIFO head, `gbrain sync --source bench --no-pull --no-embed` 75 s later, pool 10, `GBRAIN_SYNC_LANES=6`; 15 s samples. Wedge rule: a `preparing` stamp older than 5 min with nothing older than 10 s in `pg_stat_activity`.

| run | arm | two-consumer phase | pages | pages/min | max `preparing` stamp age | max active statement | longest window with no commit | wedges |
|---|---|---|---|---|---|---|---|---|
| A | plain | 50 min | 432 → 3,215 | 55 | 25.5 s | 4.8 s | 100 s (the seed-kill → serve gap) | 0 |
| B | adoption writes (60 legacy rows, 26 marker pages, `dream --phase extract_facts` every 120 s) + CLI SIGTERM/restart every 600 s (6 restarts) | 62 min | 73 → 1,153 | 17–23 | 16.3 s | 3.9 s | 67 s | 0 |
| C | + `GBRAIN_DIRECT_DATABASE_URL` (dual pool, as a Supabase deployment runs) + `--inspect`, restarts every 900 s (3) | 57 min | 93 → 1,181 | 19–24 | 16.8 s | 11.5 s | 115 s | 0 |

The one cross-process effect seen is bounded: while a serve-held group publishes under the exclusive worktree lock, the CLI's six lane transactions wait for their commit turn (`awaitLaneTurn`, `idle in transaction`, worst 47 s) and roll back at 60 s. None of this parks a preparation.

## Candidate causes

| candidate | verdict | evidence |
|---|---|---|
| (a) pool self-deadlock in the claiming process | ruled out | every wedge dump had the pool's `open` or `connecting` queues non-empty while statements were parked; renewals went through the ordinary pool and parked on sockets, not on the pool |
| (b) cross-process state (lane sets, `claimedHeadOrder`, `page_write_guards FOR UPDATE`, the native worktree lock) | ruled out as the mechanism | runs A, B, C above; the worktree lock is try-acquire, lane-turn waits are bounded at 60 s |
| (c) a shared memo or transaction that never settles | the fan-out, not the trigger | one parked round trip parks every member of a group memo or group transaction |
| (d) a transaction-pooler exchange that never completes plus an await that cannot be cancelled | **reproduced** | runs E2, F2, F; the reporter's 17:09Z live capture on Supavisor :6543 |

## What this changes in gbrain

- `persistence.single_consumer` (one full consumer per host, #6330) ships **off**: the preregistered reading said on only if the two-consumer arm wedged and the single-process arm did not, and the single-process arm wedged.
- A preparation budget cannot stand in for a client-side settle on every round trip; v0.60.114.0 adds the settle.
- A renewing lease is not proof of life: #6330's drain fingerprint, `data_moving` and `writer movement` treat "data moved" as the signal.

## Limits of this result

- **The partition is PgBouncer plus `iptables DROP`, not Supavisor.** PgBouncer forwards cancel requests; the reporter's pooler did not visibly do so. A `read ECONNRESET` un-parked one tick after about 2.5 min on the branch head, which did not happen to the reporter in 25 min.
- **The two-consumer arms never wedged naturally**, so no `lslocks` / fdinfo capture exists from inside a two-consumer wedge; the ruling-out rests on 2 h 49 min with none plus the single-process reproduction.
- **Single runs per arm, synthetic notes, a simulated network**, as in the earlier catch-up mirrors.
- **The Bun inspector cannot enumerate parked promises**; the await was named from gbrain's step marks and the driver's code, not from a heap walk.
