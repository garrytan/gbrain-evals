# GBRA-133 lane C: Postgres round trips, round 2 (follow-up)

Each row reads before -> after -> after + fast path:

- **before:** origin/master 25006f32, which includes PR 1 and PR 2a but none of this lane's work.
- **after:** gbra133-pr2b-pg 762ae71b. That's the round-1 driver work (one pg_type fetch, #6930 pipelining) plus this round's read batching outside 4b.
- **after + fast path:** the branch plus the proposed PR 4b no-op fast path (fastpath-proposal.md). It's measured locally and not committed.

PR 4b is not merged (origin/capy/6712-pr4b is not an ancestor of master), so the fast path stays a proposal.

**Setup:**
- Harness: scripts/bench/sync-freshness.ts, local copy (harness.patch), Postgres managed mode, keyless, synthetic pages.
- Latency: toxiproxy at 57 ms RTT. PgBouncer is transaction mode with prepare=false.
- Machines: 4 vCPU and 15 GiB each, one config per machine, labels run back to back on the same brain.
- 100k PgBouncer: the brain was rebuilt with master's code at the start of round 2, because the round-1 database was lost when the machine slept. The other configs reused their round-1 brain after one unmeasured warmup sync applied master's new migrations.
- Reps: n=40 for no-op, single manual and serve (p95 shown); batch is n=5 (max shown). No rep failed.
- Column definitions are the same as round 1 (below).
- The serve and batch cells did not run on the fast-path label, and their "after" is 98c175f6, the round-2 head. Round 3 added only the retired-marker and resolver batching, which those paths don't run.

## No-op and single-file commit (before -> after -> after + fast path)

| pages | path | cell | n (before/after) | visible s, p50 / tail (before -> after) | exit s, p50 / tail (before -> after) | connections/run | pg_type fetches/run | round trips/run | dependent round trips/run |
|---|---|---|---|---|---|---|---|---|---|
| pages | path | cell | n (before/after) | visible s, p50 / tail (before -> after) | exit s, p50 / tail (before -> after) | connections/run | pg_type fetches/run | round trips/run | dependent round trips/run |
|---|---|---|---|---|---|---|---|---|---|
| 10000 | direct | single file, manual | 40/40/40 | 13.36 / p95 13.47 -> 13.46 / p95 13.57 -> 13.66 / p95 13.77 | 22.87 / p95 22.97 -> 22.20 / p95 22.44 -> 22.46 / p95 22.60 | 9 -> 9 -> 9 | 9 -> 1 -> 1 | 653 -> 639 -> 641 | 283 -> 266 -> 267 |
| 10000 | direct | no-op | 40/40/40 | - -> - -> - | 7.08 / p95 7.21 -> 6.42 / p95 6.50 -> 3.18 / p95 3.23 | 9 -> 9 -> 9 | 9 -> 1 -> 1 | 140 -> 126 -> 71 | 92 -> 78 -> 32 |
| 10000 | PgBouncer | single file, manual | 40/40/40 | 18.98 / p95 19.58 -> 13.37 / p95 13.60 -> 12.96 / p95 13.16 | 31.70 / p95 32.62 -> 22.04 / p95 22.43 -> 21.35 / p95 21.53 | 9 -> 9 -> 9 | 9 -> 1 -> 1 | 653 -> 639 -> 640 | 399 -> 268 -> 272 |
| 10000 | PgBouncer | no-op | 40/40/40 | - -> - -> - | 8.20 / p95 8.36 -> 6.13 / p95 6.69 -> 2.97 / p95 3.18 | 9 -> 9 -> 9 | 9 -> 1 -> 1 | 140 -> 126 -> 71 | 104 -> 77 -> 32 |
| 100000 | direct | single file, manual | 40/40/40 | 13.96 / p95 14.77 -> 13.87 / p95 13.97 -> 14.07 / p95 14.17 | 25.96 / p95 27.44 -> 25.08 / p95 25.21 -> 25.28 / p95 25.46 | 9 -> 9 -> 9 | 9 -> 1 -> 1 | 662 -> 648 -> 650 | 292 -> 277 -> 280 |
| 100000 | direct | no-op | 40/40/40 | - -> - -> - | 9.66 / p95 9.76 -> 8.86 / p95 9.04 -> 3.26 / p95 3.31 | 9 -> 9 -> 9 | 9 -> 1 -> 1 | 146 -> 135 -> 71 | 100 -> 87 -> 32 |
| 100000 | PgBouncer | single file, manual | 40/40/40 | 18.03 / p95 18.14 -> 13.16 / p95 13.26 -> 13.06 / p95 13.47 | 31.34 / p95 31.52 -> 23.01 / p95 23.23 -> 22.71 / p95 23.63 | 9 -> 9 -> 9 | 9 -> 1 -> 1 | 661 -> 648 -> 650 | 407 -> 278 -> 280 |
| 100000 | PgBouncer | no-op | 40/40/40 | - -> - -> - | 8.51 / p95 8.59 -> 7.15 / p95 7.27 -> 2.89 / p95 2.96 | 9 -> 9 -> 9 | 9 -> 1 -> 1 | 146 -> 135 -> 71 | 110 -> 87 -> 32 |

## Serve and batch of 60 (before -> after 98c175f6)

| pages | path | cell | n (before/after) | visible s, p50 / tail (before -> after) | exit s, p50 / tail (before -> after) | connections/run | pg_type fetches/run | round trips/run | dependent round trips/run |
|---|---|---|---|---|---|---|---|---|---|
| 10000 | direct | single file, serve | 40/40 | 11.77 / p95 11.97 -> 11.78 / p95 12.28 | - -> - | 0 -> 0 | 0 -> 0 | 558 -> 556 | 208 -> 209 |
| 10000 | direct | batch of 60, manual | 5/5 | 57.03 / max 60.16 -> 57.25 / max 58.72 | 83.65 / max 87.15 -> 83.19 / max 85.08 | 10 -> 10 | 10 -> 1 | 7878 -> 7855 | 330 -> 315 |
| 10000 | PgBouncer | single file, serve | 40/40 | 17.69 / p95 18.89 -> 12.08 / p95 12.61 | - -> - | 0 -> 0 | 0 -> 0 | 539 -> 559 | 272 -> 205 |
| 10000 | PgBouncer | batch of 60, manual | 5/5 | 82.76 / max 83.40 -> 58.31 / max 61.30 | 118.45 / max 119.01 -> 84.44 / max 88.15 | 10 -> 10 | 10 -> 1 | 8437 -> 7877 | 291 -> 316 |
| 100000 | direct | single file, serve | 40/40 | 12.18 / p95 12.37 -> 12.18 / p95 12.38 | - -> - | 0 -> 0 | 0 -> 0 | 552 -> 552 | 204 -> 202 |
| 100000 | direct | batch of 60, manual | 5/5 | 59.83 / max 60.65 -> 59.54 / max 59.70 | 89.98 / max 91.12 -> 89.05 / max 89.59 | 10 -> 10 | 10 -> 1 | 7965 -> 7952 | 294 -> 320 |
| 100000 | PgBouncer | single file, serve | 40/40 | 19.84 / p95 19.94 -> 12.18 / p95 12.71 | - -> - | 0 -> 0 | 0 -> 0 | 552 -> 552 | 280 -> 201 |
| 100000 | PgBouncer | batch of 60, manual | 5/5 | 82.53 / max 82.91 -> 57.04 / max 57.24 | 119.28 / max 119.69 -> 84.41 / max 84.88 | 10 -> 10 | 10 -> 1 | 8448 -> 7850 | 305 -> 338 |

## Targets

| target | after (branch) | after + fast path (needs a 4b hunk) |
|---|---|---|
| no-op at 57 ms ≤ 3 s | missed: 6.42 s direct and 6.13 s PgBouncer at 10k; 8.86 s and 7.15 s at 100k | 10k direct 3.18 s (p95 3.23 s), just over. 10k PgBouncer 2.97 s (p95 3.18 s). 100k direct 3.26 s (p95 3.31 s), just over. 100k PgBouncer 2.89 s (p95 2.96 s). |
| 100k single-file ≤ 5 s | missed: visible 13.87 s direct, 13.16 s PgBouncer | not affected (14.07 s and 13.06 s) |
| PgBouncer ≤ 300 round trips per commit | met: 268 dependent round trips at 10k and 278 at 100k (was 399 and 407) | met |

## What this round changed (all outside 4b, commits 98c175f6 and 762ae71b)

Each change was measured as dependent round trips (waves) per call. Every result matches today's semantics, and each has a red/green test on both engines.

| read | waves before -> after |
|---|---|
| capacity forecast (post-sync notice): reads sent together | 8 -> 1-2 |
| extraction lag (post-sync nudge): one config snapshot; the count and mention preview go together | 8 -> 2 |
| connect-time config merge plus gateway re-stamp: one config table read instead of two (moved to src/cli/db-plane-config.ts) | 2 reads -> 1 |
| default source path: reuses the resolver's source listing; tier-5 config read sent with tier 4; emptiness guard sent with the sole-source listing | 5 -> 2 |
| retired-marker cleanup at connect: persistence row and deactivations read together | 3 -> 2 |

Test: test/read-waves-gbra133.test.ts and its Postgres twin test/e2e/read-waves-gbra133-postgres.test.ts. They fail 6/6 on master on both engines (red-waves-unit-master.txt, red-waves-pg-master.txt) and pass 6/6 on the branch.

## What was not changed, and why

- **Managed mode read once per process.** readManagedMode is the deactivation fence that a managed sync re-checks between phases (sync-authority assertManagedSyncActive, with a FOR SHARE lock in the publish path). A per-process cache would let a running drain keep publishing after `writer deactivate` committed. The no-op's 5 reads come from separate 4b entry points (sync-delegate, perform, sync-run, discovery). Sharing them needs a run-scoped context threaded through 4b code, which belongs with the fast path.
- **page-state/guards.ts:123 "16 waves".** On closer attribution these are the BEGIN and COMMIT of each page transaction: withHeldPageKeys wraps the transaction, so the stack lands there. They are not guard reads. The guard statements themselves are already pipelined (#5984). Sending BEGIN together with the first statement would be a driver change to `begin()`, and it doesn't fit #6543's rule that nothing is pipelined across a transaction boundary on a pooler URL.
- **page-state/snapshot.ts:100 and transactions.ts:87.** snapshot.ts:100 is one readPageSnapshot per page, and its callers are 4b (sync-prepare, coordinator). transactions.ts:87 is the existing memo/pipeline helper, which shows up as the frame of calls already batched.
- **The 9 connections per run** come from the drain's parallel prewarm (sync-drain.ts, 4b) and cost about one wave.

## Round 1 (for reference)

Before = origin/master 248d0821 (v0.60.309.0). After = branch gbra133-pr2b-pg at 222b4212.
Harness: scripts/bench/sync-freshness.ts (local copy with --pooler, --brain-rev and --trace analysis; harness.patch alongside), engine postgres, mode managed, keyless, synthetic pages.
Latency: toxiproxy adds 57 ms RTT between gbrain and the endpoint (measured RTT about 60 ms). "PgBouncer" = transaction-mode PgBouncer 1.x behind the same proxy, prepare=false.
Machines: 4 vCPU / 15 GiB cloud machines, one bench at a time per machine. 10k direct, 10k PgBouncer and 100k PgBouncer each ran on their own machine; 100k direct ran on the primary. Master and branch ran back to back on the same machine and brain.
Reps: n=40 for no-op, single manual and single serve (p95 shown); batch n=5 (max shown). No rep failed.

Column notes:
- visible = commit to first search hit (search_ms). exit = commit to sync process exit. Times in seconds.
- connections, pg_type fetches, round trips and dependent round trips are per sync process, medians over reps, from the SQL trace. A dependent round trip is a wave: a statement that had to wait for an earlier response, counted across connections.
- Serve cells trace only the commit window of a long-running serve, so its pool and type fetch happened before the window (0 connections).
- Batch dependent-round-trip counts are not comparable: 60 imports run in parallel on 10 connections and their chains overlap. Read batch by wall time and total round trips.

| pages | path | cell | n (before/after) | visible s, p50 / tail (before -> after) | exit s, p50 / tail (before -> after) | connections/run | pg_type fetches/run | round trips/run | dependent round trips/run |
|---|---|---|---|---|---|---|---|---|---|
| 10000 | direct | single file, manual | 40/40 | 13.56 / p95 14.12 -> 13.47 / p95 13.57 | 23.14 / p95 23.77 -> 23.11 / p95 23.23 | 9 -> 9 | 9 -> 1 | 652 -> 644 | 281 -> 280 |
| 10000 | direct | single file, serve | 40/40 | 14.56 / p95 14.66 -> 14.47 / p95 14.57 | - -> - | 0 -> 0 | 0 -> 0 | 533 -> 535 | 212 -> 216 |
| 10000 | direct | batch of 60, manual | 5/5 | 59.31 / max 60.05 -> 59.33 / max 59.45 | 86.46 / max 87.35 -> 86.33 / max 86.60 | 10 -> 10 | 10 -> 1 | 7953 -> 7944 | 283 -> 287 |
| 10000 | direct | no-op | 40/40 | - -> - | 7.16 / p95 7.27 -> 7.18 / p95 7.28 | 9 -> 9 | 9 -> 1 | 137 -> 132 | 91 -> 93 |
| 10000 | PgBouncer | single file, manual | 40/40 | 18.04 / p95 18.25 -> 12.76 / p95 12.96 | 30.22 / p95 30.41 -> 21.86 / p95 22.22 | 9 -> 9 | 9 -> 1 | 650 -> 644 | 400 -> 282 |
| 10000 | PgBouncer | single file, serve | 40/40 | 19.44 / p95 19.64 -> 14.35 / p95 14.45 | - -> - | 0 -> 0 | 0 -> 0 | 527 -> 535 | 268 -> 217 |
| 10000 | PgBouncer | batch of 60, manual | 5/5 | 82.21 / max 82.51 -> 56.32 / max 56.61 | 117.29 / max 117.65 -> 82.47 / max 82.67 | 10 -> 10 | 10 -> 1 | 8431 -> 7853 | 297 -> 341 |
| 10000 | PgBouncer | no-op | 40/40 | - -> - | 7.26 / p95 7.33 -> 6.48 / p95 6.54 | 9 -> 9 | 9 -> 1 | 137 -> 132 | 101 -> 93 |
| 100000 | direct | single file, manual | 40/40 | 13.97 / p95 14.36 -> 13.88 / p95 13.96 | 26.15 / p95 26.85 -> 26.00 / p95 26.15 | 9 -> 9 | 9 -> 1 | 661 -> 653 | 291 -> 292 |
| 100000 | direct | single file, serve | 40/40 | 14.95 / p95 15.05 -> 14.95 / p95 15.05 | - -> - | 0 -> 0 | 0 -> 0 | 522 -> 521 | 203 -> 204 |
| 100000 | direct | batch of 60, manual | 5/5 | 59.61 / max 61.17 -> 59.83 / max 60.13 | 89.81 / max 91.42 -> 89.91 / max 90.22 | 10 -> 10 | 10 -> 1 | 7970 -> 7968 | 289 -> 294 |
| 100000 | direct | no-op | 40/40 | - -> - | 9.75 / p95 10.42 -> 9.68 / p95 9.81 | 9 -> 9 | 9 -> 1 | 146 -> 141 | 100 -> 102 |
| 100000 | PgBouncer | single file, manual | 40/40 | 18.05 / p95 18.16 -> 12.85 / p95 12.95 | 31.88 / p95 32.04 -> 23.60 / p95 23.81 | 9 -> 9 | 9 -> 1 | 660 -> 653 | 409 -> 292 |
| 100000 | PgBouncer | single file, serve | 40/40 | 19.53 / p95 20.93 -> 14.34 / p95 14.45 | - -> - | 0 -> 0 | 0 -> 0 | 544 -> 525 | 285 -> 205 |
| 100000 | PgBouncer | batch of 60, manual | 5/5 | 82.23 / max 82.42 -> 56.10 / max 56.51 | 119.19 / max 119.32 -> 84.05 / max 84.50 | 10 -> 10 | 10 -> 1 | 8443 -> 7850 | 289 -> 346 |
| 100000 | PgBouncer | no-op | 40/40 | - -> - | 8.99 / p95 9.12 -> 8.25 / p95 8.37 | 9 -> 9 | 9 -> 1 | 146 -> 141 | 110 -> 101 |


### What changed

1. **One pg_type fetch per process per database** (vendored postgres@3.4.9 `array_types` store, src/core/pg-type-cache.ts `sharedArrayTypes`). 9 (10 in batch) fetches per run become 1, everywhere. The fetches ran in parallel with the boot prewarm, so this saves about 5 round trips and about 0.5 s of summed connect-phase time but little wall time on direct.
2. **Pipelining inside transactions behind a transaction pooler** (#6930, vendored `transaction_pipeline`, src/core/db.ts `transactionPipelineOptions`, depth 100). Since #6543, a pooler URL sent one statement per round trip. Now statements issued together on a held connection inside a transaction share a round trip; nothing is ever sent behind COMMIT/ROLLBACK/END/ABORT/PREPARE TRANSACTION, and autocommit statements still go one at a time. PgBouncer single-file commit: 400 to 282 dependent round trips at 10k (409 to 292 at 100k), visible 18.0 to 12.8 s. `GBRAIN_PG_TXN_PIPELINE=0` restores the old behavior.
3. **Connection reuse** needed no change: a sync process already uses one pool (`module`). Its 9 connections all open at boot in the parallel prewarm in persistence/sync-drain.ts (a PR 4b file), so they cost about one wave, not nine.

### Targets

| target | result |
|---|---|
| no-op at 57 ms ≤ 3 s | missed. Exit p50 7.18 s direct and 6.48 s PgBouncer at 10k; 9.68 s and 8.25 s at 100k. |
| 100k single-file ≤ 5 s | missed. Visible p50 13.88 s direct and 12.85 s PgBouncer (p95 13.96 s and 12.95 s). |
| PgBouncer ≤ 300 round trips per commit | met for dependent round trips: 282 at 10k and 292 at 100k (was 400 and 409). Total statements per commit stay about 650. |
| p95 with n ≥ 40 | met for no-op, single manual and serve; batch is n=5, so max is shown. |

### Why the latency targets are out of reach at the engine seam

At 57 ms, each dependent round trip costs about 60 ms. A single-file commit still needs about 280 of them on both paths, which is about 16.8 s of wave span. Visible ≤ 5 s would need fewer than about 80. A no-op needs about 92, and ≤ 3 s leaves room for about 35 after process start. The driver now pipelines everything that is issued together, so the remaining waves are application statements that wait on the previous answer.

Stack attribution of a master single-file commit at 10k (GBRAIN_QUERY_STACKS plus trace; attr-single.txt): 247 waves, 156 from files outside PR 4b, 84 from PR 4b files and 7 from the driver or connect. Top callers outside 4b: page-state/guards.ts:123 (16), page-state/snapshot.ts:100 (10), page-state/transactions.ts:87 (9), persistence/managed-mode.ts:54 (7), persistence/ownership.ts:75 (5). Top 4b callers: persistence/sync-lease.ts:85 (5), authority.ts:165, sync-holds.ts:449 and company-brain/profile.ts:29/33. The no-op is a long tail of one- and two-wave callers (attr-noop.txt) led by managed-mode.ts:54, sync-holds.ts:449 and guards.ts:123, so reaching ≤ 3 s needs a cheap "nothing to do" exit before the full managed boot, not a driver change.

An observation not chased: after the change, the PgBouncer arm is 0.7 to 1.0 s faster than direct at a similar dependent-round-trip count (12.76 vs 13.47 s at 10k, 12.85 vs 13.88 s at 100k).

### Raw data

n40/{10k-direct,10k-pgbouncer,100k-direct,100k-pgbouncer}/*.json (one JSON per cell, per-rep traces inside; logs/*-sql.jsonl are per-rep SQL traces). report.ts regenerates the table: `bun report.ts n40/10k-direct,n40/10k-pgbouncer,n40/100k-direct,n40/100k-pgbouncer`.



## Round 4 (no-op only, 57 ms, n=40): master c9f309f31 vs branch fda2a7e1 (idle-tick fast path)

Fresh containers and rebuilt brains on every machine, so absolute numbers are not comparable with rounds 1-3; both labels ran on the same brain.

| Cell | master p50/p95 | branch p50/p95 | dependent RTs |
|---|---|---|---|
| 10k direct | 5.91/5.98 s | 4.09/4.18 s | 69 -> 40 |
| 10k PgBouncer | 6.16/6.29 s | 3.62/3.72 s | 82 -> 41 |
| 100k direct | 8.18/8.28 s | 6.27/6.38 s | 78 -> 49 |
| 100k PgBouncer | 7.21/7.41 s | 4.61/4.70 s | 89 -> 49 |

100k: the ghost-page scan (sync-ghosts.ts -> ghost-pages.ts scanGhostSource) reads 11 sequential 10k-page batches and stats every page file, about 2 s per no-op.

## Round 5 (GBRA-133 PR 2b integrated tree, 57 ms RTT, n=40 no-op, fresh brains)

Labels: m = master c9f309f31, c = combined gbra133-pr2b e4ec4528, p = gbra133-pr2b-pg2 3dee6f9ce (c + (a) one routing read per single-source CLI sync, (b) settings restore pipelined with COMMIT). Exit p50 / p95 in seconds; dependent round trips per run in brackets. At 10k all three labels ran on one brain. At 100k, part 2 found the machines restarted, so p ran on a rebuilt brain and m and c were rerun on that brain (m5b, c5b); the table uses those same-brain numbers.

| cell | master | combined | combined + a/b |
|---|---|---|---|
| 10k direct | 5.90 / 5.98 (70) | 3.73 / 3.80 (39) | 3.34 / 3.39 (32) |
| 10k PgBouncer | 6.11 / 6.18 (81) | 3.32 / 3.40 (39) | 2.90 / 2.99 (32) |
| 100k direct | 8.12 / 8.21 (78) | 3.90 / 3.97 (39) | 3.49 / 3.59 (32) |
| 100k PgBouncer | 7.34 / 7.46 (90) | 3.51 / 3.92 (39) | 3.00 / 3.08 (31) |

Round trips per run: 140-149 -> 109 -> 101; connections 10 in every cell; pg_type fetches 10 -> 1 -> 1.

Ghost scan: master sends 11 `SELECT id, slug, source_path, source_uri FROM pages` batches per no-op at 100k (2 at 10k); combined and pg2 send 0 in every cell, so lane D's cache removes the ~2 s at 100k direct (8.12 -> 3.90 s) and the no-op no longer scales with brain size. Part 1 (separate brain at 100k) agreed: 100k direct 8.20 -> 3.94, 100k PgBouncer 7.34 -> 3.54.
