# Managed Postgres catch-up: first page at 15.5 s, page saves within a second of idle

**Measured by gbrain on October 8, 2026; mirrored into this repository on October 8, 2026. This mirror reruns nothing.**

This is the follow-up to [the October 7 report](2026-10-07-managed-sync-lanes-foreground.md), on the same rig: gbrain's `scripts/bench/managed-sync-catchup.ts`, Docker Postgres (`pgvector/pgvector:pg16`) behind a toxiproxy latency proxy at 57 ms, 1,500 generated notes with 34 already-deleted files first, default settings, on 16-vCPU Ubicloud VMs (Ubuntu 24.04). Every row is three runs per head. Master was gbrain `b5f12b12e` (v0.60.117.0); the wave was branch `capy/next-wave-g3-g6-g7` at `d6d9d5956`.

## The finding

| What you do | Master | Wave | gbrain's target |
|---|---|---|---|
| Time until the first page is committed | 19.0 / 19.3 / 19.6 s | **15.6 / 15.6 / 15.5 s** | ≤ 15 s, **missed by 0.5 s** |
| Slowest saves (p95) during a catch-up, over the idle p95 | +0.52 / +0.59 / +2.28 s, one save failed | **+0.52 / +0.52 / +0.77 s**, none failed | ≤ idle + 1 s, met |
| Catch-up speed while a page is saved every 5 s | 65.1 / 60.9 / 63.4% of idle | 55.4 / 64.4 / 60.1% of idle | ≥ 50%, met |
| Catch-up pages/min with nothing else running | 374 / 379 / 370 | 392 / 370 / 393 | no regression |

**A correction to the October 7 report.** Its catch-up-while-saving row (45% of idle) came from one run. Three more runs of the same code (`9d013e52d`) measured 60.6, 63.2 and 62.3%, and master has measured 57 to 71% in every run since, so that target was met, not missed.

## What changed

- **Described parameter types are saved for the next process**, so about 40 fewer describe round trips per run. A statement only the catch-up runs still describes on its first run.
- **A waiver run screens each frozen entry against that freeze's own read** instead of reading the page and checking permission again, and each freeze reads the page beside its origin check.
- **Claiming a lane group's followers locks only the group's rows.** It used to lock up to 63 rows past the group, including the next page save's row. Lock-wait samples per run fell from about 190 to 84.
- **A page save another process claimed but could not yet publish now holds back new lane groups**, as a queued one does. Master's +2.28 s run fits this case; its bench output does not name the cause.

## Limits of this result

- **One rig, synthetic notes, a simulated network**, as in the earlier reports.
- **The first-page time is measured after the bench's setup sync**, which warms the saved types for the statements it runs; the catch-up-only statements still describe once. A brain's second catch-up starts faster than this row.
- **Three runs per head.** Open-loop catch-up-while-saving runs spread by up to 15 points.

## Raw output

[`raw/`](2026-10-08-managed-sync-followup-wave/raw/) holds the bench JSON for every run: `master-b5f12b12e-r{1,2,3}-*`, `wave-d6d9d5956-r{1,2,3}-*` and the correction runs `master-9d013e52d-r{1,2,3}-*` (`g3-1500`: idle catch-up and first commit; `g67-fg`: the closed-loop page-save row; `g7-open`: one save every 5 s). Machine paths and database names are removed; [`results.json`](2026-10-08-managed-sync-followup-wave/results.json) summarizes them. gbrain's method and analysis are in its `docs/eval/managed-sync-catchup.md` ("Startup reads, lock scope and a held claim").

## Reproduce

In a gbrain checkout at the version under test, with Docker on Linux:

```bash
bun scripts/bench/managed-sync-catchup.ts --files 1500 --deletes 34 --rtt 57 --rows cli --max-minutes 10 --out g3-1500.json
bun scripts/bench/managed-sync-catchup.ts --files 1500 --deletes 34 --rtt 57 --rows foreground --fg-interval 5 --max-minutes 10 --out g67-fg.json
bun scripts/bench/managed-sync-catchup.ts --files 1500 --deletes 34 --rtt 57 --rows foreground-open --fg-interval 5 --max-minutes 10 --out g7-open.json
```

No provider keys are needed.
