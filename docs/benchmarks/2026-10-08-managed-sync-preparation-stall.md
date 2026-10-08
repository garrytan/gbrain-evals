# A stuck write no longer stops a managed catch-up: it is cut off, named and held within 240 s, though a table lock still pins the connection pool

**Measured by gbrain on October 8, 2026; mirrored into this repository on October 8, 2026. This mirror reruns nothing.**

This is the measured verdict for gbrain issue [#6278](https://github.com/garrytan/gbrain/issues/6278) and its fix, gbrain [#6298](https://github.com/garrytan/gbrain/pull/6298), which merged into gbrain master as `b65d4bae7` (v0.60.112.0). It follows [the October 7 catch-up report](2026-10-07-managed-sync-lanes-foreground.md): that one measured how fast a managed Postgres brain catches up a backlog, this one measures what happens when one write in the catch-up cannot finish.

The runs used gbrain's `scripts/bench/managed-sync-stall-repro.ts` on 16-vCPU Ubicloud VMs (Ubuntu 24.04): a Docker Postgres (`pgvector/pgvector:pg16`) behind PgBouncer 1.26 in transaction mode, toxiproxy adding 57 ms of round trip, and a fixture source with id `bench`. Every sync ran the way the reporter's loop does, non-TTY, as `timeout 3600 gbrain sync --source bench --no-pull --no-embed`, repeated until the source reported synced. The commit of each run is named in its table. The fixed-head 15,000-entry runs were measured at `846bea442` (v0.60.108.0), which is PR #6298's head at the time (`14962f947`) plus the bench's capture code. The merged head `b65d4bae7` was not rerun on that load. Its throughput was checked by the 1,500-file bench described below.

## The finding

On a managed Postgres brain, `gbrain sync` prepares each write (checks, reads, a content comparison) before it publishes it. Only `remember` and `put_page` preparation had a time limit. If one sync write never finished preparing, its owner kept renewing the claim, nothing behind it on that checkout ran, and the 3600 s non-TTY watchdog killed the sync. The next pass walked into the same write. One reporter's 13,600-entry catch-up made four passes this way and landed 153 entries.

After the fix, every preparation has a budget (120 s for a sync file or a maintenance write) and a hard ceiling (600 s). A write cut off twice is finished `preparation_stalled`, the sync holds its file, and `gbrain sources writer status` names the step it was on. What the bench measured:

| What you do | 0.60.105.0 | Fixed head | Result |
|---|---|---|---|
| Catch up 15,000 entries with heavy fact adoption, pool 10 | never drained: 102 pages in 47.6 min, then the bench stopped it | **2 passes, 91 min**, 14,980 entries committed, 20 held | the stall no longer happens |
| The same at pool 3 | never drained: 62 pages in 47.1 min | **3 passes of 3600 s**, 14,980 committed, 20 held | the stall no longer happens |
| Longest window with no page committed (pool 10 / pool 3) | 888 s / 668 s | 605 s / 544 s | adoption writes queued ahead of the sync, not one stuck request |
| Failed fence-adoption receipts | 471 `repeated_marker` and 276 "does not render its legacy fact" (throughput head) | **0** | met |
| Non-TTY watchdog stops (`sync_deadline_stop`) | none reached (bench stopped the run first) | **0 in 5 passes** | met |
| A table lock held for 300 s: when is the stuck file held? | never: members stay `preparing` until the lock drops (forced probe, 240 s) | **240 s**, file held with its step | met for the head member |
| A table lock held for 300 s: are the pool connections freed? | no, pinned until the lock drops | **no**, 9 of 10 pinned until the lock drops | open, gbrain #6318 |
| Catch-up speed on 1,500 files (bench; the base column is the #6279 branch, merged as `9d013e52d`, not 0.60.105.0) | 150.4 wall / 401.5 steady pages/min | 150.0 / 378.1 (-0.3% / -5.8%) | inside the 20% gate |
| One pass drains 15,000 entries at `timeout 3600` | no | **no**: 2 passes (pool 10), 3 passes (pool 3) | not met at 3600 s; met at 14,400 s by arithmetic |

"Never drained" for 0.60.105.0 means the bench stopped the run 15 minutes after it captured the stall, with about 100 of 15,000 pages in. The reporter's own run would have waited for the watchdog.

## How the cause picture changed

The reporter's evidence was one write in `running` with claim phase `preparing` for 700 s while its owner renewed the lease. Three findings moved the picture, in this order.

**1. The lock-wait class, proven by a forced probe.** The natural stall did not reproduce: 2 x 100 minutes on 0.60.105.0 at pool 10 and 3 with the 15,000-page fixture showed no request in `preparing` for more than one 30 s sample. What did reproduce the exact signature is a server-side wait with no timeout. Through a transaction-mode pooler, gbrain's startup `statement_timeout` is dropped (`SHOW statement_timeout` read `0` through the pooler and `5min` direct), and preparation reads run outside the publication transaction, so no per-transaction guard covers them. Holding `LOCK TABLE pages IN ACCESS EXCLUSIVE MODE` in another session through the pooler left `managed_sync_import` members in `running` / `preparing` for the whole hold (240 s on 0.60.105.0, 200 s on the throughput head), with the claim renewed every 10 s, `pg_stat_activity` showing `Lock` / `relation`, zero pages committed, and everything resuming within 15 s of release. The await was the first `pages` read after the lock appeared, `assertSyncPageOrigin` at step `page_origin`. [Raw probe dumps](2026-10-08-managed-sync-preparation-stall/raw/phase0/local-probes/). What held a lock on the reporter's managed brain is not known.

**2. A never-settling await, found live by the reporter.** After upgrading to 0.60.110.0 the reporter captured a live stall that the lock theory does not fit: `statement_timeout` was 10 minutes on both URLs, no `AccessExclusiveLock`, no statement older than 3 seconds, no lock wait over a second, and sixteen members of one group stuck in `preparing` for 25+ minutes. Running `prepareManagedSyncMutation` on those sixteen rows from a scratch process took 2.6 to 3.4 s each, so the data was fine. The wedge needed two persistence consumers on the host (`gbrain serve` and the sync CLI); with one, the same group published in 22 s. That is a promise that never settles with nothing in flight at the database, which the Phase 0 bench had ruled out for its own topology. The root cause is open as gbrain #6317. This bench did not reproduce it. The fix contains it by racing a timer against every preparation, so the budget wins even when nothing is in flight, and gbrain's forced-fault tests cover that on the single and grouped routes.

**3. Two zero-progress modes.** The bench found a second way for a catch-up to stop that is not a stuck preparation. When `extract_facts` has hundreds of legacy rows to adopt, its adoption writes time out their receipt wait and leave about 200 `managed_maintenance_adopt_fact_fence` requests queued on the checkout ahead of the sync. Each takes 5 to 20 s at 57 ms, so the sync committed nothing for 888 s (pool 10) and 668 s (pool 3) on 0.60.105.0 while a different adoption was running at every sample. The fixed head still shows this window (605 s and 544 s), now because every adoption succeeds and more of them publish. Nothing in it is one request holding the root.

A third probe, a toxiproxy `timeout` toxic on half the connections, hung the consumer's own tick in `refresh_roots` with one connection `idle in transaction` for 397 s and no claim held. That is not a `preparing` blocker and this fix does not address it.

## What shipped

- **A budget and a ceiling for every write's preparation.** 120 s for a sync file or a maintenance write (`persistence.sync_preparation_ms`, `persistence.maintenance_preparation_ms`), 30 s for `remember`, `put_page` and `edit_page`, a 600 s ceiling (`persistence.preparation_ceiling_ms`) and two attempts (`persistence.max_preparation_attempts`), behind the `preparation_deadlines` switch. A write cut off twice, or killed mid-preparation once and cut off once, finishes `preparation_stalled`.
- **A hold instead of a stall.** The sync holds a `preparation_stalled` file the way it holds a broken-frontmatter file, writes the hold behind a narrower gate (only requests that can change that entry's outcome), and a breaker stops the run `blocked` / `preparation_systemic` when many files stall.
- **The stall is named.** `gbrain sources writer status --json` shows the step, how long the write has been there, what it waits on (`git`, `fs`, `db`, `pool`, or `unknown`), the owner process, and `claim.stall` once the budget passes. The progress line prints `stalled <N>s on <step>`.
- **Lock waits end at the budget on the server.** Preparation reads run as `BEGIN; SET LOCAL statement_timeout; <statement>; COMMIT` in one round trip, which holds through a transaction-mode pooler. Doctor's `persistence_session_timeouts` reports a pooler that drops the session timeout.
- **Fence writes stop failing the write path.** Fact adoption writes whitespace and CRLF differences back instead of refusing them, a second facts fence in a timeline is caught before a maintenance write is submitted, and rows the fence cannot hold are counted by doctor `fence_integrity` as `unrenderable_legacy_facts`.
- **Two follow-up fixes (lane B7), found by the second lock run:** `gbrain sources retry-held` now clears a stalled hold in the same drain, and a write-capacity refusal waits with backoff instead of ending the pass with exit 1.

## 15,000 entries, before and after

Heavy adoption: 1,000 legacy fact rows over 250 pages, 12 pages whose rows cannot round-trip through the fence, 20 backlog pages and 20 history pages with a repeated facts-fence marker, and `gbrain dream --phase extract_facts` every 60 s with 20 rows dripped before each run. 1,500 history pages were imported first, then 15,000 backlog entries. "Steady" is the middle 80% of a pass by time. "Wall" is pages committed over the pass's elapsed time. Pass ends marked rc 124 are the outer `timeout 3600`, not gbrain's watchdog.

| Run | gbrain commit | Pool | Passes to drain | Pages per pass | Pages/min wall per pass | Pages/min steady per pass | Longest window, no page committed | Watchdog stops | Failed receipts | Holds at end |
|---|---|---|---|---|---|---|---|---|---|---|
| 0.60.105.0 | `8e11aa1f` | 10 | never; bench stopped it at 47.6 min | 102 | 2.1 | 2.4 | 888 s (queued adoptions) | 0 | not captured | not captured |
| 0.60.105.0 | `8e11aa1f` | 3 | never; bench stopped it at 47.1 min | 62 | 1.3 | 1.3 | 668 s (same) | 0 | not captured | not captured |
| Throughput head (v0.60.107.0) | `d99e2b43` | 10 | 3 (167 min) | 3,900 / 7,538 / 3,542 | 65 / 125.7 / 74.5 | 58.9 / 126.6 / 85.9 | 285 s (tail) | 0 | 471 `repeated_marker`, 276 "does not render its legacy fact" | 20 `invalid_fence` / `repeated_marker` |
| Throughput head (v0.60.107.0) | `d99e2b43` | 3 | not reached; 11,987 of 15,000 at the 170 min cap | 3,425 / 4,747 | 57.1 / 79.1 | 59.8 / 78.9 / 86.8 | 33 s | 0 | same two classes | 20 |
| **Fixed head** (v0.60.108.0) | `846bea442` | 10 | **2** (91 min) | 7,719 / 7,261 | 128.7 / 231.1 | 119.8 / 262.5 | 605 s (pass 1, queued adoptions); 285 s (pass 2 tail, 20 holds and a links pass) | **0** | **0** | 20 `invalid_fence` / `repeated_marker` |
| **Fixed head** (v0.60.108.0) | `846bea442` | 3 | **3** passes of 3600 s; the third was cut at 14,996 of 15,000 processed and the printed `retry-held` sync closed it | 3,076 / 6,355 / 5,545 | 51.3 / 106 / 92.5 | 46.5 / 104.8 / 93.5 | 544 s / 0 s / 64 s | **0** | **0** | 20 |

The 0.60.105.0 rows stopped early, so their failed receipts and holds were not captured. The throughput head is the build that carries gbrain #6279's lanes, and gbrain's upstream documents call it GBRA-45. It is the right middle row: it has the faster write path but not the preparation budget.

How to read them:

- **The stall is gone; the throughput ceiling is not.** At 120 to 260 pages/min a single 3600 s pass cannot hold 15,000 entries, so the fixed head needs two passes at pool 10 and three at pool 3. Each pass checkpoints and the next resumes at the cursor without re-walking (pass 2 at pool 10 started at 7,719; pass 3 at pool 3 started at 9,435). The reporter's loop used `timeout 14400`.
- **The remaining zero-progress window is the adoption queue,** the second mode above. In the pool-10 run the sync committed nothing from 09:59:12 to 10:09:51 while 22 different adoption writes ran. The fixed head's window is longer than the throughput head's (285 s) because 255 adoption writes now commit instead of failing; the queue is the same size and more of it publishes.
- **No pass ended on the watchdog or a drain stop,** and none printed `restart_required`. No sync member was ever past its budget in these runs: the deep samples saw 3,676 `preparing` blockers and the oldest phase age was 29.6 s.
- **The reporter-scale load never stalled 0.60.105.0.** With 60 legacy rows and nine refusals a pass, pool 10 committed 964 pages in pass 1 (16.1 pages/min) and pool 3 committed 256 (4.3). Those rows are in [`results.json`](2026-10-08-managed-sync-preparation-stall/results.json) as context, not as a before/after.

## The forced table lock, before and after the server-side bound

The same 3,000-entry backlog with heavy adoption, pool 10, 57 ms, PgBouncer in transaction mode. A second session held `LOCK TABLE pages IN ACCESS EXCLUSIVE MODE` through the pooler twice, about 300 s each time. The first run is the head before the bounded reads (lane A9), the second adds them, the stalled-line fix (lane B6) and the drain's owner-pid fix.

| | Before the bounded reads (`846bea442`) | With them (`a99c00565`) |
|---|---|---|
| Budget fires | at 120 s, reported and named (39 overdue observations, all with step and wait cause) | at 120 s, reported and named (19 overdue observations, all with step and wait cause) |
| Group members released at the budget | **no**; 18 members stayed `running` / `preparing` until the lock dropped | **the head member, yes**: released `preparation_deadline`, reclaimed within about 10 s, charged attempt 2 |
| Sync file held | no; a 300 s lock stays inside the 600 s ceiling and no member reached the limit | **yes, at 240 s**: `companies/scale-0-3152.md` held `preparation_stalled` at step `origin_check`; the 73 members behind it were cancelled to be re-frozen |
| Adoption write caught by the lock | finished `preparation_stalled` at about 240 s | same |
| Pool connections pinned during the hold | 9 of 10 in `Lock` / `relation` for the whole hold | **9 of 10, same** |
| Statements ended by the server-side bound | none (not yet shipped) | **0**, though 2,035 bounded `BEGIN; SET LOCAL statement_timeout` transactions ran |
| `stalled <N>s on <step>` progress lines | 0 (the pass went silent for five watchdog ticks) | 127, naming the step, the wait cause and the allowance |
| First page committed after the lock dropped | 28 s | about 2 min (the 73 cancelled pages were re-frozen and re-admitted first) |
| How the pass ended | `synced`: 2,980 of 3,000 committed in 3,471 s (51.5 wall, 58.6 steady, longest window 665 s) | exit 1, `Error queue_capacity` at 1,501 s with 242 pages; 89 queued adoption writes plus one running sat at the 100-request principal limit |
| Finishing | none needed | `retry-held` then the printed sync imported the remaining 2,755 entries in 1,006 s, `synced`, 2,979 of 3,000 committed |

The connections stayed pinned because the statements that block under this lock are not the ones the bound wraps. Every one of the nine is an autocommit statement outside `executeRaw`: the import pipeline's content-hash lookup (four connections), `readPageSnapshot`, the `page_projections` join, and the group-memoized origin read. So the budget frees the head member's claim, but the member's own bounded read waits for a free connection, and the file is held when the consumer's race ends it at 240 s, not when the server cancels a statement. gbrain recorded the unbounded reads as #6318. A lock that holds longer than the ceiling is the case this leaves exposed, and no run held a lock that long.

The second run found two more problems. The stalled file was not re-held by the printed sync, it was never re-screened, because the sync finished the old cursor and only a fresh discovery reads the `retry-held` schedule. And the `queue_capacity` refusal at admission escaped the drain as an exit 1 with no summary. Lane B7 fixed both (a pass that finishes its cursor while re-screens are scheduled now yields so the next pass takes them; the drain waits with `waiting for write capacity (N outstanding of M)` and ends `blocked` / `write_capacity`). Local probe tests cover them; the VM run was not repeated.

## Fence outcomes on the fixed head

- **Held with a reason, never failed.** All 20 repeated-marker pages in the backlog ended held `invalid_fence` / `repeated_marker` in every run, written before admission. The 20 history pages with a repeated marker were never submitted as adoption writes; `extract_facts` reports them `FACTS_FENCE_FAILED` and skips them.
- **Adoption:** `trailing_ws`, `leading_ws` and `crlf` rows adopted (3 of 3 each, every run). `whitespace_only` rows stayed pending (3 of 3 left) and doctor `fence_integrity` lists exactly 3 `unrenderable_legacy_facts` with `next: report`. 908 of 988 control rows adopted; the 80 on marker pages are skipped by design.
- **Concurrent repair did not run.** `gbrain dream --phase fence_repair` 20 minutes into pass 1 found 22 candidates, repaired none, and reported all 22 as `sync_in_progress`, with no `owner_unavailable`. Repair during a sync is a separate, later change.

## Verdict by goal

gbrain's plan set five goals. Here is how each came out, in plain words.

| Goal | Verdict | What the measurements show |
|---|---|---|
| **G1.** One request never stops a catch-up | **Partly met** | A write that cannot prepare is cut off at 120 s, finished `preparation_stalled` by 240 s, and its file is held; no pass of the five reporter-shape passes stopped on one request. Under a table lock the head member is held at 240 s, but nine of ten pool connections stay pinned until the lock drops (#6318), and the pass under that lock exited on `queue_capacity` before lane B7 (fixed, tested locally, not rerun). The never-settling await the reporter found is cut by the same timer race; gbrain's forced-fault tests cover it and this bench did not reproduce it. |
| **G2.** Writer status names the step | **Met** | Every overdue claim carried `claim.stall` with step, step age, wait cause and budget (39 and 19 observations). `diagnostic.reason` still reads `cause_unknown` on the same rows, which is a wording clash, not missing evidence. |
| **G3.** Fence defects never consume the write path | **Met** | 0 fence refusals at preparation in both 15,000-entry runs (471 and 276 on the throughput head); 20 pages held with the reason; whitespace and CRLF facts adopt; whitespace-only rows are counted. |
| **G4.** `fence_repair` runs during the sync | **Not met in this release** | 22 candidates, none repaired, all `sync_in_progress`. Scoped to the follow-up change. |
| **G5.** Throughput within 20%, zero watchdog stops, one pass | **Rate and watchdog met. One pass is not met at a 3600 s timeout, and is met at the reporter's 14,400 s by arithmetic.** | The 1,500-file bench lost 0.3% wall and 5.8% steady against its base, inside the 20% gate. On the 15,000-entry load the fixed head ran 120 / 263 pages/min steady at pool 10 against 59 / 127 / 86 for the throughput head, with 0 watchdog stops in 5 passes and every pass resuming at its checkpoint. One 3600 s pass cannot hold 15,000 entries at those rates (two passes at pool 10, three at pool 3). The measured passes add up to 5,483 s at pool 10 and about 10,800 s plus a short tail at pool 3, both inside 14,400 s, but no run used that timeout, and the reporter's backlog is 13,600 entries, not 15,000. |

Not measured in this mirror, though the plan listed them: foreground `put_page` latency during the catch-up, a database outage and recovery, and several poisoned entries in one run. gbrain's tests cover the hold and breaker paths; this bench does not.

## What to use

- **Upgrade, restart every owner process, and keep the defaults.** The deadlines are on by default. A `gbrain serve`, jobs worker or autopilot on an older version never gives up on a stuck write, so the guarantee needs every owner on v0.60.112.0. `gbrain sources writer status --json` shows each running write's owner version.
- **Loop the sync with a long timeout.** Use `timeout 14400 gbrain sync --source <id> --no-pull --no-embed` or loop shorter passes; every pass resumes at its checkpoint. A held file stays out of the index until `gbrain sources retry-held <id>` and the printed sync import it.
- **Read the `stalled <N>s on <step>` line before restarting anything.** A long window with the step `queued` is the adoption queue, not a stuck write.
- **Expect a table lock to hold the pool.** Until #6318, a lock on `pages` still pins most connections for its duration; the file is held at 240 s but the rest of the pool waits. Check `gbrain doctor --only persistence_session_timeouts` to see whether your pooler drops the session timeout.
- **Do not run the sync and `gbrain serve` as two consumers on one host** until #6317 lands. The reporter's wedge needed both.

## Limits of this result

- **One rig, synthetic notes, a simulated network and a stand-in pooler** (PgBouncer, not the reporter's). The reporter's own trigger is still unproven; the bench reproduced the lock class by force and the adoption flood naturally.
- **Single runs.** Each row is one run, so a difference of a few percent between rows is inside run-to-run spread.
- **The fixed-head throughput rows predate the final head.** They ran at `846bea442`. The later lanes (A9 bounded reads, B6, B7) were checked by the lock runs and the 1,500-file bench, not by a new 15,000-entry run. The 1,500-file bench's head commit is not recorded in the PR body; the head that passed gbrain's full gate was `7485fe241`.
- **The fixture is 15,000 entries with a heavy adoption load.** The reporter's backlog was 13,600 entries. The first `extract_facts` run on 1,000 legacy rows takes over 20 minutes on every build and is killed by the harness, as in earlier runs.
- **The 0.60.105.0 rows are truncated by the bench** 15 minutes after it captured the stall, so they show the stall, not the whole drain.
- **Pool 3 pass 3 was cut at the timeout** at 14,996 of 15,000 entries processed, and the printed `retry-held` sync closed it. That counts as three passes plus a short follow-up.

## Cost

The bench made no model calls and sent no embeddings (`--no-embed`); the one `fence_repair` run reports $0.0000 on the model. It used about 16.4 hours of 16-vCPU VM time, summed from sampled run lengths: 630 minutes in the 0.60.105.0 and throughput-head runs, 330 minutes in the three fixed-head runs of the first set, and 25 minutes in the second lock run, not counting setup or the follow-up `retry-held` syncs.

The change itself costs little throughput. The 1,500-file catch-up bench went from 150.4 to 150.0 pages/min wall and 401.5 to 378.1 steady (-0.3% and -5.8%), which sits inside the bench's run-to-run spread. A bounded read pipelines `BEGIN; SET LOCAL statement_timeout; <statement>; COMMIT` into one round trip, so it adds no round trips to a preparation statement.

## Raw output

[`raw/`](2026-10-08-managed-sync-preparation-stall/raw/) holds, per run, the bench's `report.json` (parameters, fixture, pooler settings, pass results, hold records, writer-status summaries), `passes.jsonl`, `adoption.jsonl`, each pass's stderr, the stall captures (`stall-1.json`: the writer queue and `pg_stat_activity` at the moment the bench saw no progress), `retry-held.json`, `fence-repair.json`, `doctor-fence-integrity.json` and the run log. `timeline.jsonl` is every 30 s sample reduced to its time, pass, committed page count and no-commit window; the two lock runs also keep their full `samples.jsonl.gz`. The full sample files of the other runs (2 to 14 MB each) are not mirrored. The directories are:

- `phase0/release-0.60.105-*`: 0.60.105.0 (`8e11aa1f`) at pool 10 and 3, heavy and light adoption.
- `phase0/gbra45-head-d99e2b43-*`: the throughput head at pool 10 and 3.
- `phase0/local-probes/`: the forced-lock and dark-connection probes and their step dumps.
- `phase41-fixed-head-846bea44-pool10`, `-pool3` and `-lock`: the fixed head's reporter-shape and first lock runs.
- `phase41b-fixed-head-a99c00565-lock`: the lock run with the bounded reads.
- `phase41-summary.json` and `phase41b-summary.json`: gbrain's summarizer output for those runs.

Machine paths, database names and VM names are replaced with `<work>`, `<home>`, `<fixture-home>`, `<db>` and `<vm>`. The numbers above are collected in [`results.json`](2026-10-08-managed-sync-preparation-stall/results.json) with the gbrain commit of every row. gbrain's method and full analysis are in its [`docs/eval/managed-sync-stall-repro.md`](https://github.com/garrytan/gbrain/blob/master/docs/eval/managed-sync-stall-repro.md).

## Reproduce

In a gbrain checkout at the version under test, with Docker on Linux and a 16-vCPU host.

```bash
# reporter shape, fixed head (the 0.60.105.0 rows pass --cli-repo <0.60.105 checkout> --stall-kill-minutes 15)
bun scripts/bench/managed-sync-stall-repro.ts --files 15000 --history 1500 --legacy-facts 1000 --marker-pages 20 \
  --doomed-pages 12 --drip-rows 20 --backlog-marker-pages 20 --rtt 57 --pool-size 10 --max-minutes 150 --passes 4 \
  --adoption-interval 60 --fence-repair-at 20 --retry-held-after --out .context/bench/stall-p10
# forced table lock, two holds of 300 s
bun scripts/bench/managed-sync-stall-repro.ts --files 3000 --history 1500 --legacy-facts 1000 --marker-pages 20 \
  --doomed-pages 12 --drip-rows 20 --backlog-marker-pages 20 --rtt 57 --pool-size 10 --max-minutes 50 --passes 2 \
  --adoption-interval 60 --stall-minutes 2 --sample-seconds 15 --chaos-at 3 --chaos-kind lock --chaos-for 300 \
  --chaos-repeat 2 --chaos-gap 300 --retry-held-after --out .context/bench/stall-lock-b
python3 scripts/bench/stall-repro-summarize.py .context/bench/stall-p10 .context/bench/stall-lock-b
```

The first command is the reporter-shape run; change `--pool-size` to 3 for the second pool size. The second is the lock scenario. The bench's `--cli-repo` flag points at the gbrain checkout whose `gbrain sync` it drives (the current checkout when omitted). The 1,500-file throughput check is `scripts/bench/managed-sync-catchup.ts --files 1500 --deletes 34 --rtt 57 --rows cli` as in [the October 7 report](2026-10-07-managed-sync-lanes-foreground.md#reproduce). No provider keys are needed.
