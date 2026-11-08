# gbrain's refresh write barrier passes its preregistered test at 773a29ee

- **We learned that gbrain can hold writes during a refresh instead of refusing them, and lose none.** With
  `persistence.refresh_barrier` on, gbrain at `773a29ee` (v0.60.614.0) lost, stuck, duplicated or overwrote no write in
  2,000 counted concurrency trials on Postgres and PGLite, the same clean record as with it off. Trials that met a
  `worktree_refreshing` refusal went from 170 (Postgres) and 138 (PGLite) to 0, and the p95 wait for a write's first
  answer during a refresh fell from about 10 s to 76 ms and 35 ms. Retrieval scores didn't change, and quiet writes
  stayed inside the 25 ms margin (Postgres -2.1 ms, PGLite +4.7 ms, 95% interval 0.3 to 9.3). You should turn the flag
  on, on gbrain `773a29ee` or later.
- **We learned that agents do far better with a write that is held than with one that is refused.** Refused writes
  led agents to resend under a new request id, which the test counts as a failure. With the flag on, gpt-6.1-sol's
  strict success went from 4 to 60 of 60 tasks, and claude-opus-5-5's from 15 to 37 adjudicated (14 to 28 raw). If you
  build tools for agents, you should answer a busy write with a status the agent can check on, not an error it has to
  retry.
- **What didn't work: the first counted run failed, and our scorer penalises untitled captures.** At gbrain
  `431cb3f9` the test read **FAIL**: two writes held behind refreshes that aborted stayed pending for up to about 300 s
  (GST-1853), and four overwrites matched a fault in our own detector. gbrain fixed the hangs in `773a29ee`, the two runs are never pooled, and the first stays FAIL. B1's latency gate also failed its first
  reading (Voyage 1.69 times flag-off, taken while this machine was creating VMs); Amendment 5 then added an idle-machine
  guard, and the guarded rerun passed. Separately,
  when an agent calls `capture` without a title, gbrain titles the note with its content, so the preregistered scorer
  counts the fact twice. That failed claude-opus-5-5 in 16 flag-off and 23 flag-on episodes and gpt-6.1-sol in 2
  flag-off ones. It works against the flag, and the results stand as scored. If you score agent writes, you should
  count writes or pages, not matches of the fact's text.

The preregistered verdict is **PASS**, and the benefit bars for recommending the flag on are met on both engines. Every
bound here comes from synthetic workloads: zero failures in 1,000 flag-on trials puts the per-trial failure rate under
0.30% at 95%, not at zero.

## The test

gbrain keeps a brain as a Git worktree and a database. While a refresh pulls upstream changes into the worktree, a write
that touches it can't land safely. Today gbrain refuses such a write with `worktree_refreshing` and the client retries.
With the barrier on, gbrain queues it and answers `pending`, then applies it once the refresh ends. The
[preregistration](2026-11-06-refresh-barrier-preregistration.md) fixed the arms (flag off and on, on Postgres and
PGLite), the failure classes, the bars and the decision rule before any counted trial. Its Amendments 1 to 6 record
every change and every procedure, each before the counted cell it affects.

- **Part A, concurrency (keyless, gating):** 500 seeded trials per engine and arm, in which several writers race
  refreshes, crashes, writer kills and import sequences. Every write is checked against the database, the client's view
  and Git. A named case (GBRA-108's) runs 25 times per kind, engine and arm, and a quiet block of 100 seeds per engine
  and arm measures write latency with no refresh.
- **Part B, retrieval (gating):** Cat 18 (165 pages, 25 queries, two embedders) and Cat 26 (30 pages, 10 queries, three
  modes), run off and on and compared query by query. B1 uses hash embeddings and also gates search latency. B2 uses the
  real embedders.
- **Part C, agents (paid, gating against harm):** claude-opus-5-5 and gpt-6.1-sol each do 60 generated "save these four
  facts, then report" tasks per arm on a fresh PGLite brain. The harness holds the agent's first write until a refresh
  is paused, so off, it gets `worktree_refreshing`, and on, it gets `pending`. Strict success needs all four tokens
  landed exactly once, a correct report, and no write reissued under a new request id.

## Results at 773a29ee

All counted cells come from gbrain `773a29eede3b3ea91e0e2cba4012078b5d42c602` and harness digest `500cc5ba4b97`, from
#384 heads `8dc1cbd6` (Part A), `2d5fafb8` (B1, B2) and `ee216726` (Part C), whose differences are docs and scripts
outside the harness. `analyze.ts` reads them as one unmixed set.

### Part A: no failures in either arm

| Block | Engine | Off: runs, failures | On: runs, failures |
|---|---|---|---|
| Trials | Postgres | 500, 0 | 500, 0 |
| Trials | PGLite | 500, 0 | 500, 0 |
| Named case | both | 150, 0 | 150 (all in the window), 0 |
| Quiet | both | 200, 0 | 200, 0 |

Every failure class reads 0 in both arms: lost, lost in Git, phantom, duplicated, stuck, overwritten, wrong expiry,
unindexed, unpublished, false refusal, unexpected outcome, hang, deadlock, no convergence and harness error. The 95%
upper bounds on the flag-on failure rate:

- 0.30% per trial over both engines (0.60% per engine).
- 2.0% per named-case run, and 1.5% per quiet run.
- Strata: 5.8% for crashes (n = 50), 6.2% for writer kills (n = 47) and 1.6% for import sequences (n = 181).
- 0.045% per held write (n = 6,632). That bound treats writes as independent, which they aren't, so the trial bound is
  the primary one.

The positive controls all held:

- **PC1:** with the flag off, 34% of Postgres trials and 28% of PGLite trials met at least one `worktree_refreshing`
  refusal. The bar is at least 5%.
- **PC2:** the detector caught the planted admission-order bug at `de22702a` in 60 of 60 named runs.
- **PC3:** every flag-on named-case run was in its window.
- **PC4:** there were no harness errors in 2,000 trials.
- **PC5:** with the flag on, 89% and 85% of trials had a write held by a refresh and answered `pending` first. No
  flag-on write outside expiry got `worktree_refreshing` first, and every process's switch matched its arm.

Quiet write latency, on minus off, paired over 100 seeds: Postgres -2.1 ms (95% interval -8.7 to 3.9), PGLite +4.7 ms
(0.3 to 9.3). The margin is 25 ms, so both pass.

### What the flag changes

| | Postgres off | Postgres on | PGLite off | PGLite on |
|---|---|---|---|---|
| Trials with a `worktree_refreshing` answer | 170 | 0 | 138 | 0 |
| Writes outside expiry whose first answer was `worktree_refreshing` | 298 of 8,795 | 0 of 8,795 | 279 of 9,139 | 0 of 9,139 |
| p95 first-answer wait while a refresh is paused | 10,009 ms | 76 ms | 10,048 ms | 35 ms |
| Pending write, from deferral to applied: p50, p95 | n/a | 4.3 s, 22.1 s | n/a | 4.2 s, 20.4 s |

With the flag off, a write that meets a refresh waits about 10 s and is refused. With it on, the write is answered in
tens of milliseconds and lands once the refresh ends, about 0.5 to 0.7 s after release at the median. Paired over seeds,
the flag cuts the retryable-refusal rate by 4.6 points on Postgres (95% 4.0 to 5.3) and 3.6 points on PGLite (3.1 to
4.2), and the blocked time by 6.9 s and 6.5 s. Both of the preregistered benefit bars are met: `worktree_refreshing`
first answers outside expiry are at 0% (the bar is at most 0.1%), and p95 blocked time is under 1 s on each engine. So
the findings recommend turning the flag on.

### Part B: retrieval doesn't change

- **B2, real embedders** (17:43 UTC): all eight cells are identical off and on. Cat 18 Recall@10 is 0.283
  (OpenAI) and 0.450 (Voyage). Cat 26 R@3 and MRR are 1.0 in every mode.
- **B1, hash embeddings:** all eight score cells were identical in every one of five readings. The latency gate (median
  Cat 18 `query_ms`, on at most 1.2 times off) took five readings:
   15:19 UTC, set aside as FIX-METHOD, not a result about gbrain: OpenAI 54/64 ms (1.19), Voyage 35/59 ms (1.69). The
     run overlapped this machine creating the Part A VMs (Amendment 5).
   Four uncounted diagnostics on the idle machine, 15:31 to 15:36: ratios from 0.95 to 1.17 in every cell.
   The binding run, under the idle guard of Amendment 5, 17:34 UTC: OpenAI 38/42 ms (1.11), Voyage 36/37 ms (1.03),
     **pass**. The guard found it valid: it started at load 0.10, foreign runnable tasks never showed in two samples in
     a row, and the 1-minute load went from 0.24 to 0.46 across the off arm and from 0.46 to 0.94 across the on arm.

### Part C: agents do at least as well with the flag on

| Model | Arm | Raw strict success | Adjudicated | Reissues (excused) |
|---|---|---|---|---|
| claude-opus-5-5 | off | 14 / 60 | 15 / 60 | 67 (16) |
| claude-opus-5-5 | on | 28 / 60 | 37 / 60 | 16 (16) |
| gpt-6.1-sol | off | 4 / 60 | 4 / 60 | 56 (0) |
| gpt-6.1-sol | on | 60 / 60 | 60 / 60 | 0 (0) |

On minus off, paired over the 60 tasks (10,000 resamples, seed 1):

- claude-opus-5-5: +36.7 points adjudicated (95% +18.3 to +55.0), and +23.3 raw (+6.7 to +40.0).
- gpt-6.1-sol: +93.3 points (+86.7 to +98.3), raw and adjudicated alike.

Both models are non-inferior (the lower bound is above -10 points) under both readings, so the verdict doesn't depend on
the adjudication. Amendment 3's rule excuses a resend that follows a write refused `invalid_params` with gbrain's
"nothing was written", and `scripts/refresh-barrier-partc-adjudicate.ts` applies it the same way to every arm and model.
No episode errored, overflowed its context or ran unexposed. Amendment 2's procedure 4 rescored no episode: no raw or
adjudicated success had a fact token twice in Git HEAD. No Part C run paused.

The flag-off failures are mostly agents resending a refused write under a new request id. gbrain answered every one of
Sol's 60 held flag-off writes with `worktree_refreshing`, and Sol reissued in 56 of them. With the flag on, Sol got
`pending`, waited on `get_write_request` and reissued nothing.

Opus's held flag-on writes answered as follows:

- `pending` in 43 episodes.
- `invalid_params` in 10, because Opus sent an unknown `source` parameter.
- A batch envelope in 7: a batched `remember` whose per-item answers were `pending`. The episode record labels these
  `unexpected_ok`.

## Limitations

- **Synthetic workloads.** Part A's trials and Part C's tasks are generated. The bounds say how rare a failure must be
  to go unseen in this many runs, not that none exists.
- **B1's latency gate is noisy.** It is a single median of 25 queries per arm, so one reading can swing, as the 15:19
  reading did.
- **Capture titles count as duplicates.** When an agent calls `capture` without a title, gbrain titles the note with its
  content, so the fact's token appears in the title, the heading and the body. The preregistered scorer counts that as a
  duplicate, in both arms. It failed Opus in 16 flag-off and 23 flag-on episodes, and Sol in 2 flag-off episodes. In
  each case it was a single capture call, not a second write. It works against the flag-on arm, and the result stands as
  scored.
- **Low Opus success in both arms.** Opus's strict success is low under both flags (raw 23% off, 47% on), mostly from
  reissues and the capture titles above. Part C measures the difference between arms, not absolute agent quality.
- **Two engines, one G.** The result covers Postgres and PGLite at `773a29ee`. A later gbrain build is a new G.

## The first counted run, at 431cb3f9

The counted Part A at `431cb3f9` (2026-11-07, digest `8e8520f8b606`) read FAIL with 6 flag-on failures (Amendment 3):

- **2 hangs.** These were gbrain's. A write held behind a refresh that ended `aborted` or `abandoned` stayed pending
  until a later refresh, up to about 300 s. That was GST-1853, fixed in `773a29ee`.
- **4 overwrites.** These matched a fault in our own `removerOf` detector, and 3 of them are shown by replay. The
  detector was fixed and reviewed before any later counted cell.

GBRA-108 ruled that the run stands as scored. Part C didn't run at that G.

## Reproducing it

- Part A, per block: `bun eval/runner/refresh-barrier/run.ts --block trials|named|quiet --engine postgres|pglite
  --seeds|--reps <range>` at G, then `analyze.ts`. Each block's receipt records G, the digest and the runner commit.
- B1: `bun scripts/refresh-barrier-b1-guard.ts --out <dir> --max-wait-min 60 -- bun --no-env-file
  eval/runner/refresh-barrier/retrieval.ts --gbrain-root <G> --work <dir> --stub-embed --label g`.
- B2: `retrieval.ts --gbrain-root <G> --work <dir> --label g --budget-ledger <ledger>`.
- Part C: `bun eval/runner/refresh-barrier/agent.ts --model <provider:id> --arm off|on --tasks 1-60 --out <dir>
  --gbrain-root <G> --budget-ledger <ledger>`, then `bun scripts/refresh-barrier-partc-adjudicate.ts --partc <dir>`.
- Summaries are in [2026-11-08-refresh-barrier-results/](2026-11-08-refresh-barrier-results/): the analysis, the
  adjudication, B1's result and guard record, and B2's result, with their cost fields left out. The full outputs are
  kept outside the repository: about 90 MB for Part A and 240 episode records for Part C.

## Disclosures

gbrain is Garry Tan's own project.

Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator. Garry
Tan runs Y Combinator.
