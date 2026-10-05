# A managed Postgres brain across the internet catches up about 150 pages a minute

**Measured by gbrain from October 3 to 5, 2026; mirrored into this repository on October 5, 2026. This mirror reruns nothing.**

[gbrain](https://github.com/garrytan/gbrain) is a memory system for agents. It keeps notes as Markdown files in a Git repository and indexes them in a database. In **managed** mode, every change to the index goes through a write journal: each page gets its own write request and receipt, so an agent can always see what was saved, by whom, and what failed. `gbrain sync` reads the changes in the Git repository and publishes them through that journal.

## The finding

When the database is far away (57 ms round trip in this rig, about the distance from a laptop to a hosted Postgres in another region), catching up a backlog used to crawl. Each saved page took several hundred sequential database round trips. Three gbrain releases changed that:

| gbrain | What changed | Pages per minute at 57 ms | 10,000-file backlog |
|---|---|---|---|
| v0.60.39.0 | one page per `gbrain sync` run, looped in a shell | 3.4 | about 49 h |
| v0.60.48.0 ([#5996](https://github.com/garrytan/gbrain/pull/5996)) | one run drains the backlog; pages save in groups | 13.1 (15.7 on the 10k row) | about 10.7 h |
| v0.60.58.0 ([#6021](https://github.com/garrytan/gbrain/pull/6021)) | 17 instead of 48 round trips per page; the next group is queued while one saves | 28.8 (30.9 on the 10k row) | about 5.4 h |
| v0.60.73.0 ([#6098](https://github.com/garrytan/gbrain/pull/6098)) | up to six groups save at once, committing in file order | **152.8 steady, 137.4 over the whole run** | **about 1.2 h** |

Every page still gets its own write request, receipt and attribution, and a failed page still stops the run before anything after it is published. Next to the database (~0 ms) the same catch-up runs at 740.6 pages per minute on v0.60.73.0, against 544.9 on v0.60.58.0.

This is gbrain's measurement. Its method and every table are in gbrain's [`docs/eval/managed-sync-catchup.md`](https://github.com/garrytan/gbrain/blob/master/docs/eval/managed-sync-catchup.md). The bench output for the v0.60.48.0, v0.60.58.0 and v0.60.73.0 rows is copied into [`raw/`](2026-10-05-managed-sync-catchup/raw/), with machine paths and database names removed, and the numbers below are summarized in [`results.json`](2026-10-05-managed-sync-catchup/results.json). The v0.60.73.0 rows were measured on gbrain #6098's head 348d74613, then stamped v0.60.70.0, so the raw files carry that stamp. Before shipping as v0.60.73.0 the PR merged master and changed only how a blocked drain finishes: it now waits for its lanes and cancels the groups they released. That touches only the end of a failed run, not throughput.

## What was measured

**The rig.** `scripts/bench/managed-sync-catchup.ts` in gbrain: a local Docker Postgres (`pgvector/pgvector:pg16`) behind a toxiproxy latency proxy that adds half the round-trip time in each direction, on a 4-vCPU Linux host. Each row builds a fresh brain, activates managed mode, commits a backlog of generated notes plus deletions of 34 already-deleted files (the shape of the original report, [gbrain#5984](https://github.com/garrytan/gbrain/issues/5984)), and runs the real `gbrain sync` CLI. A socket-level SQL trace records every round trip.

**The rows.**

- `cli`, 500 files: `gbrain sync --source bench --no-pull --no-embed --json`, repeated until it reports `synced` (v0.60.39.0 needed one run per page; later versions finish in one run). 10-minute time box.
- `cli`, 1,500 files: the same, so the steady state is visible after startup.
- 10k: 10,000 files of about 300 words with 300 earlier managed pages, 15-minute time box, extrapolated to the full backlog.
- `foreground`: the same catch-up while another process saves one page every second; reports that page write's latency idle and during the catch-up.

**Two rates.** *Wall* is pages committed over the whole run. *Steady state* is pages committed between the first and the last group commit of the run, from the SQL trace. At 57 ms the first minute or so of any run is discovery and the 34 already-deleted files, which run one at a time before groups form (about 80 s on these corpora), so a short backlog's wall rate stays below its steady state.

| v0.60.73.0 at 57 ms | Steady state | Wall |
|---|---|---|
| 4 lanes, 1,500 files | 137.9 | 115.8 |
| 6 lanes, 1,500 files | 149.9 | 123.9 |
| 6 lanes (default), 10k files | 152.8 | 137.4 |

**Foreground writes.** At 57 ms a single page write takes about 12 s even when nothing else runs, because each one is a long chain of round trips.

| | Idle p50 / p95 | During catch-up p50 / p95 | Failures |
|---|---|---|---|
| v0.60.58.0 | 12.4 / 14.9 s | 11.6 / 15.1 s | 0 |
| v0.60.73.0, 6 lanes | 11.8 / 14.1 s | 11.3 / 15.8 s | 0 |

The idle figures come from 5 writes per run, so their p95 values carry about ±1 s of noise.

## What to use and what to avoid

- **Leave lanes on (the default) for a managed brain whose database is not on the same machine.** A 10,000-file first sync takes about an hour at 57 ms. `drain.bulk.lanes` in `gbrain sync --json` shows how many groups saved at once.
- **Give the connection pool room.** Lanes are capped by the pool: a pool of 10 allows 6, a pool of 5 allows 1. Raise `GBRAIN_POOL_SIZE` on a host that syncs large backlogs.
- **Do not expect the steady rate on a small backlog.** For a few hundred files the first minute of setup dominates.
- **Next to the database nothing needs tuning:** catch-up is several hundred pages a minute either way.

## Limits of this result

- **One rig, synthetic notes.** The corpora are generated pages with cross-links. Real notes with heavier frontmatter, attachments or embeddings will publish slower per page; embeddings were off (`--no-embed`) in the throughput rows.
- **A simulated network.** Latency comes from a proxy on one host, with no packet loss or bandwidth limit.
- **Foreground latency is near its bound.** During a catch-up the foreground p95 sits about 1.7 s above idle on v0.60.73.0, against gbrain's "about 1 s" goal, on a 5-write idle sample. Writes did not fail.
- **The baseline row is quoted, not copied.** The v0.60.39.0 numbers come from gbrain's report; its raw JSON was not committed upstream.

## Reproduce and inspect

In a gbrain checkout at the version under test, with Docker on Linux:

```bash
# 57 ms, 1,500 files, 10 minutes
bun scripts/bench/managed-sync-catchup.ts --files 1500 --deletes 34 --rtt 57 --rows cli --max-minutes 10 --keep --label lanes
# the 10k row
bun scripts/bench/managed-sync-catchup.ts --files 10000 --deletes 34 --receipt-history 300 --pad-words 300 --rtt 57 --rows cli --max-minutes 15
# foreground latency during catch-up
bun scripts/bench/managed-sync-catchup.ts --files 500 --deletes 34 --rtt 57 --rows foreground --max-minutes 10
```

No provider keys are needed and the runs cost nothing beyond the machine. `--keep` keeps the SQL trace (`sql-trace.jsonl` in the row's home); `--analyze <trace>` prints the per-phase tables gbrain's report uses.
