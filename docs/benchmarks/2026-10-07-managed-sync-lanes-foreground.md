# Managed Postgres catch-up runs at 373 pages a minute, and a page save takes 2.5 s instead of 9

**Measured by gbrain on October 7 and 8, 2026; mirrored into this repository on October 8, 2026. This mirror reruns nothing.**

This is the follow-up to [the October 5 catch-up report](2026-10-05-managed-sync-catchup.md). The same rig was used: gbrain's `scripts/bench/managed-sync-catchup.ts`, a Docker Postgres (`pgvector/pgvector:pg16`) behind a toxiproxy latency proxy at 57 ms round trip, and generated notes plus deletions of 34 already-deleted files. This time master and the branch ran on the same 16-vCPU Ubicloud VM (Ubuntu 24.04) with default settings unless a row says otherwise. Master was `a865f8f8` (gbrain v0.60.104.0); the branch was gbrain [#6279](https://github.com/garrytan/gbrain/pull/6279) at `d00f4d035`, which ships as v0.60.107.0. Commits after `d00f4d035` changed tests, a bench script's report copy and a graduation-only cache scope; none touches the catch-up or `put_page` path.

## The finding

| What you do | Master | #6279 | gbrain's target |
|---|---|---|---|
| Catch up a 10,000-page backlog | 74.5 min | **33.5 min** | ≤ 40 min, met |
| Pages per minute once the catch-up is running (10k corpus) | 174.8 | **372.7** | ≥ 300, met |
| Time until the first page is committed (1,500 files) | 78.9 s | **20.3 s** | ≤ 15 s, **missed** |
| Save one page with nothing else running, p50 / p95 (30 writes) | 8.6 / 11.6 s | **2.53 / 2.78 s** | ≤ 3 / 4 s, met |
| Save one page during a catch-up, p50 / p95 | 11.3 / 17.1 s | 6.9 / 8.4 s | ≤ idle + 1 s (provisional), **missed** |
| Catch-up speed while a page is saved every 5 s | 4.6 pages/min | 58.2 (15% of idle) | ≥ 50% of idle, **missed** |
| Catch-up next to the database (about 0 ms), steady | 2,404 | **2,862** | ≥ 700, met |

**More lanes.** With a 20-connection pool, steady pages/min at 4 / 6 / 8 / 12 / 16 lanes was 333.5 / 369.4 / 399.9 / 406.6 / 408.5 (8 to 16 lanes are means of three runs; runs at one lane count spread by about 30 pages/min). Three repeated runs at the default 6 lanes gave 381.3, 378.9 and 374.5. On master the rate fell past 6 lanes, and an earlier branch head (`4004f1f2f`) collapsed to 56 to 88 pages/min at 8 to 16 lanes before the admit-ahead fix in `d00f4d035`.

## Why three targets missed

- **First commit (20 s).** The 20 s is five serial chains of round trips: startup reads (about 5.4 s), the 34 already-deleted files (5.6 s), the first group's freeze and admission (3.3 s), its preparation (2.7 s) and its publication (about 3.5 s). No single step holds the missing 5 s.
- **Page saves during a catch-up.** A page save waits for the sync groups already publishing, then publishes alone while no new group starts (about 2 s at 57 ms). With a save every 5 s and about 6.3 s from admission to visible, one is almost always pending, so the catch-up runs about 1.1 lanes on average. Letting each save start a full round of groups instead of one did not change it (a local 4-core bench: 55.2 against 57.4 pages/min). Reaching half the idle rate needs a page save to publish beside running groups, which gbrain's current ordering rule does not allow.

## What to use

- **Upgrade and keep the defaults.** The fast `put_page` path, foreground priority and batched waivers are on by default; each has a switch (`persistence.single_write_group`, `persistence.preadmit_cache`, `sync.foreground_priority`, `sync.waive_batch`) that accepts `0` or `false`.
- **Raise lanes only with pool room.** `sync.lanes` goes up to 16, clamped by the pool; the drain prints a `[sync] lanes:` line naming what limited it. Past about 8 lanes the gain is small.
- **Expect a catch-up to slow while an agent saves pages often.** At one save every 5 s it runs at about 15% of its idle speed.

## Limits of this result

- **One rig, synthetic notes, a simulated network**, as in the October 5 report. Embeddings were off in the throughput rows.
- **Single runs** for every row except the lane sweep and the 6-lane repeats. The two runs at 8, 12 and 16 lanes show how much one run can move.
- **The foreground rows use an open-loop writer** (one save every 5 s, whether or not earlier ones finished), so they are not comparable with the October 5 closed-loop foreground rows.

## Raw output

[`raw/`](2026-10-07-managed-sync-lanes-foreground/raw/) holds the bench JSON for every row: `master-a865f8f8-*` and `branch-d00f4d035-*` (`g3-1500`: 1,500 files; `g12-10k`: the 10k corpus; `g8-0ms`; `g5-putpage`: idle `put_page`; `g67-fg`: the open-loop foreground row; `g4-*`: the lane sweep). Machine paths and database names are removed. The numbers above are summarized in [`results.json`](2026-10-07-managed-sync-lanes-foreground/results.json). gbrain's method and the full analysis are in its [`docs/eval/managed-sync-catchup.md`](https://github.com/garrytan/gbrain/blob/master/docs/eval/managed-sync-catchup.md) ("Feeder, lanes to 16 and foreground priority").

## Reproduce

In a gbrain checkout at the version under test, with Docker on Linux:

```bash
bun scripts/bench/managed-sync-catchup.ts --files 1500 --deletes 34 --rtt 57 --rows cli --max-minutes 10 --out g3-1500.json
bun scripts/bench/managed-sync-catchup.ts --files 1500 --deletes 34 --rtt 0 --rows cli --max-minutes 10 --out g8-0ms.json
bun scripts/bench/foreground-put-page.ts --rtt 57 --writes 30 --out g5-putpage.json
bun scripts/bench/managed-sync-catchup.ts --files 1500 --deletes 34 --rtt 57 --rows foreground --fg-interval 5 --max-minutes 10 --out g67-fg.json
bun scripts/bench/managed-sync-catchup.ts --files 10000 --deletes 34 --receipt-history 300 --pad-words 300 --rtt 57 --rows cli --max-minutes 100 --out g12-10k.json
GBRAIN_SYNC_LANES=12 bun scripts/bench/managed-sync-catchup.ts --files 1500 --deletes 34 --rtt 57 --rows cli --max-minutes 8 --pool-size 20 --out lanes12.json
```

No provider keys are needed.
