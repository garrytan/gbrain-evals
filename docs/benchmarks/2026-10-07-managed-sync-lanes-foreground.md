# Managed Postgres catch-up runs at 368 pages a minute, and a page save takes 2.5 s instead of 9

**Measured by gbrain on October 7 and 8, 2026; mirrored into this repository on October 8, 2026. This mirror reruns nothing.**

This is the follow-up to [the October 5 catch-up report](2026-10-05-managed-sync-catchup.md). The same rig was used: gbrain's `scripts/bench/managed-sync-catchup.ts`, a Docker Postgres (`pgvector/pgvector:pg16`) behind a toxiproxy latency proxy at 57 ms round trip, and generated notes plus deletions of 34 already-deleted files. Master and the branch ran on 16-vCPU Ubicloud VMs (Ubuntu 24.04) with default settings unless a row says otherwise. Master was `a865f8f8` (gbrain v0.60.104.0); the branch was gbrain [#6279](https://github.com/garrytan/gbrain/pull/6279) at `0ba3b1f7c`, which ships as v0.60.111.0. Commits after `0ba3b1f7c` changed tests, a generated CLI flag registry, test shard weights and docs; none touches the catch-up or `put_page` path. The lane sweep's means come from the earlier head `d00f4d035`, which has the same lane code.

## The finding

| What you do | Master | #6279 | gbrain's target |
|---|---|---|---|
| Catch up a 10,000-page backlog | 74.5 min | **33.6 min** | ≤ 40 min, met |
| Pages per minute once the catch-up is running (10k corpus) | 174.8 | **367.9** | ≥ 300, met |
| Time until the first page is committed (1,500 files) | 78.9 s | **18.4 s** | ≤ 15 s, **missed** |
| Save one page with nothing else running, p50 / p95 (30 writes) | 8.6 / 11.6 s | **2.46 / 2.72 s** | ≤ 3 / 4 s, met |
| Save one page during a catch-up, p95 (next save when the last returns) | 17.1 s | 4.06 s against 2.59 s idle, none failed | ≤ idle + 1 s (provisional), **missed** (idle + 1.5 s) |
| Catch-up speed while a page is saved every 5 s, whether or not the last finished | 0.4 pages/min, 115 of 120 saves failed | 174.4 (45% of idle 391.1), none of 120 failed; saves p50 / p95 3.5 / 21.9 s | ≥ 50% of idle, **missed** |
| Catch-up next to the database (about 0 ms), steady | 2,404 | **3,332** | ≥ 700, met |

**More lanes.** With a 20-connection pool, steady pages/min at 4 / 6 / 8 / 12 / 16 lanes was 333.5 / 369.4 / 399.9 / 406.6 / 408.5 at `d00f4d035` (8 to 16 lanes are means of three runs; runs at one lane count spread by about 30 pages/min). Three repeated runs at the default 6 lanes gave 381.3, 378.9 and 374.5. A single sweep at `0ba3b1f7c` gave 334.2 / 388.7 / 395.7 / 415.5 / 371.9; its 16-lane run sits inside the spread of single runs but below 12, and was not repeated. On master the rate fell past 6 lanes.

## Why three targets missed

gbrain recorded all three as misses in its preregistration before shipping.

- **First commit (18 s).** A serial chain of round trips: startup reads (about 3.9 s), the 34 already-deleted files (3.9 s), the first group's waiver and admission (3.2 s), its claim and preparation (about 3 s) and its publication (3.3 s). About 2 s of it is first-use statement descriptions.
- **Page saves during a catch-up.** A save that names no running sync group's page now publishes beside the running groups. The remaining tail is saves waiting on brain-wide counters that every sync group also updates.
- **Catch-up while saving every 5 s.** An earlier run at `e2656589d` measured 204.2 pages/min (53% of idle 385), saves p50 / p95 3.2 / 14.6 s. The code between it and `0ba3b1f7c` changed startup only. One run per head cannot tell a regression from run-to-run spread, so the miss is recorded from the final run, and gbrain repeats it in its next wave.

## What to use

- **Upgrade and keep the defaults.** The fast `put_page` path, foreground priority and batched waivers are on by default; each has a switch (`persistence.single_write_group`, `persistence.preadmit_cache`, `sync.foreground_priority`, `sync.waive_batch`) that accepts `0` or `false`.
- **Raise lanes only with pool room.** `sync.lanes` goes up to 16, clamped by the pool; the drain prints a `[sync] lanes:` line naming what limited it. Past about 8 lanes the gain is small.
- **Expect a catch-up to slow while an agent saves pages often.** At one save every 5 s it runs at about half its idle speed, and the slowest saves take about 20 s.

## Limits of this result

- **One rig, synthetic notes, a simulated network**, as in the October 5 report. Embeddings were off in the throughput rows.
- **Single runs** for every row except the lane sweep at `d00f4d035` and the 6-lane repeats. The three runs at 8, 12 and 16 lanes show how much one run can move.
- **Two foreground rows.** The save-every-5-s row is open loop (a save every 5 s whether or not earlier ones finished). The save-during-catch-up row is closed loop (next save when the last returns, at least 1 s apart), like the October 5 foreground rows.

## Raw output

[`raw/`](2026-10-07-managed-sync-lanes-foreground/raw/) holds the bench JSON for every row: `master-a865f8f8-*`, `branch-0ba3b1f7c-*` (the final counted run), `branch-d00f4d035-*` (the earlier run and the three-run lane sweep) and `branch-e2656589d-g7-open` (`g3-1500`: 1,500 files; `g12-10k`: the 10k corpus; `g8-0ms`; `g5-putpage`: idle `put_page`; `g67-fg`: the closed-loop foreground row; `g7-open`: the open-loop foreground row; `g4-*`: the lane sweep). Machine paths and database names are removed. The numbers above are summarized in [`results.json`](2026-10-07-managed-sync-lanes-foreground/results.json). gbrain's method and the full analysis are in its [`docs/eval/managed-sync-catchup.md`](https://github.com/garrytan/gbrain/blob/master/docs/eval/managed-sync-catchup.md) ("Feeder, lanes to 16 and foreground priority").

## Reproduce

In a gbrain checkout at the version under test, with Docker on Linux:

```bash
bun scripts/bench/managed-sync-catchup.ts --files 1500 --deletes 34 --rtt 57 --rows cli --max-minutes 10 --out g3-1500.json
bun scripts/bench/managed-sync-catchup.ts --files 1500 --deletes 34 --rtt 0 --rows cli --max-minutes 10 --out g8-0ms.json
bun scripts/bench/foreground-put-page.ts --rtt 57 --writes 30 --out g5-putpage.json
bun scripts/bench/managed-sync-catchup.ts --files 1500 --deletes 34 --rtt 57 --rows foreground --fg-interval 5 --max-minutes 10 --out g67-fg.json
bun scripts/bench/managed-sync-catchup.ts --files 1500 --deletes 34 --rtt 57 --rows foreground-open --fg-interval 5 --max-minutes 10 --out g7-open.json
bun scripts/bench/managed-sync-catchup.ts --files 10000 --deletes 34 --receipt-history 300 --pad-words 300 --rtt 57 --rows cli --max-minutes 100 --out g12-10k.json
GBRAIN_SYNC_LANES=12 bun scripts/bench/managed-sync-catchup.ts --files 1500 --deletes 34 --rtt 57 --rows cli --max-minutes 8 --pool-size 20 --out lanes12.json
```

No provider keys are needed.
