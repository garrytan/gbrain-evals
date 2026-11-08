# Refresh write barrier preregistration: does `persistence.refresh_barrier` land every write made during a refresh?

Status: approved at the plan gate by GBEV-3 on 2026-11-06 (autoplan run-20261106170625, gate revision 1), with every
recommended change. It freezes when its pull request merges, before any counted trial or paid call; a change after that is
a dated amendment at the end. Owner: GBEV-44 (issue GST-1644), for GBRA-108. All-in cap:
$300, crew credits included. Runners: `eval/runner/refresh-barrier/` (concurrency trials and the named case), the Cat 18
and Cat 26 runners (retrieval), and an agent runner on the Cat 40 tool loop (agent experience).

## Question

gbrain's refresh write barrier (switch `persistence.refresh_barrier`, env `GBRAIN_REFRESH_BARRIER`, default off; gbrain
#8682 with the import-keyed deferral of #8705) answers a write that arrives while `gbrain sources refresh` fast-forwards
the checkout with a pending receipt and applies it after the refresh, where the default refuses it with
`worktree_refreshing` after waiting up to 10 s. Should the flag be turned on? This run answers three things on synthetic
test brains only: with the flag on, does every acknowledged write land exactly once, in admission order, in the database,
in Git and in search, with no hang or deadlock; does turning it on change retrieval; and do frontier agents handle its
pending receipts at least as well as the refusals they get today?

## Evidence class

Regression check and held-out confirmation for the flag decision. The schedule generator and the gate classes were built
and dry-run on #8705's branch at de22702a (development evidence, listed under "Dry runs"). The counted run uses seeds and
tasks never run before, on the build named below.

## Build and data

- **gbrain under test (G):** the first gbrain master commit that contains merged #8682 and #8705 with GBRA-341's fixes for
  GBRA-347's two findings, for the crash-resume refusal found by the G-compatibility smoke below (seed 33), which
  GBRA-108 routed to GBRA-341 on 2026-11-06, and for GST-1674: the two crash-resume shapes that still ended
  `refresh_recovery_required` at f04429da (a plain-git foreign commit in the fence window, and a commit landing between the
  merge and its bookkeeping). It must also contain GST-1623's fixes for the flag-on items #8705 landed with (held writes
  that take managed sync's outstanding slots and stall the importer, an expiry recheck race, and capture's supersedes), so
  the verdict judges the build that turns the flag on. Amendment 1 records its sha before the first counted trial. Besides
  the sha it may carry only
  compatibility fixes that the G-compatibility smoke below calls for and that touch no classifier, threshold or schedule,
  with the changed files re-hashed and one reviewer. Trials load G from a clean checkout with `bun install`
  (`--gbrain-root`); `run.ts` refuses a checkout with uncommitted changes, and a counted run refuses one whose HEAD is not
  `--gbrain-sha`. Nothing in gbrain is changed.
- **Detector check build:** #8705 at de22702a, which GBRA-347's TLA+ model shows breaks admission order. Used only for
  positive control PC2.
- **Retrieval comparator:** gbrain-evals' pin, gbrain 62637c96 (0.60.557.0), descriptive only.
- **gbrain-evals:** the commit that merges this preregistration. The receipt records the sha256 of every file in
  `eval/runner/refresh-barrier/`, `SCHEDULE_VERSION` 2 and `PARAMS` (`schedule.ts`). Version 2 differs from version 1
  only in that a tick never pushes a file a foreign commit changes (25 of the 500 counted seeds per engine had one such
  push, now sent to a new upstream note); every random draw, stratum and write is the same.
- **Fixture:** a synthetic brain per trial (`fixture.ts`): a bare `origin.git`, a second clone that pushes as another
  machine, and the managed checkout gbrain owns, with sources `alpha` and `beta`, eight `people/*-example` pages and eight
  `notes/topic-N` pages written in gbrain's own rendering. Git durability is on, as on a production brain. No real brain,
  person or data is used.
- **Engines and hosts:** Postgres 16 with pgvector (`pgvector/pgvector:pg16`), every actor its own OS process; PGLite, every
  actor a concurrent task in one process (PGLite admits one process). Concurrency trials run on Ubicloud standard-16 VMs,
  six trials at a time, in one fixed shuffled order (seed 2026) that interleaves arms and seeds; the quiet latency block runs
  two at a time, seed by seed with the arms alternating (off first on even seeds), so each seed's two arms run side by
  side. VMs are deleted after.
  Postgres runs with `max_connections=500` and `shared_buffers=512MB` (an eight-writer trial holds about 31 to 37
  connections); every result records `max_connections` and the server version, and a "too many clients" error is a
  `harness_error` with its own counter.
- **Hermetic environment:** every job runs as `bun --no-env-file` with provider keys removed (a child that still sees
  one exits 3), and each trial gets its own Git config: identity `Example <example@example.invalid>` in each clone's local
  config and a trial-local global file, `GIT_CONFIG_NOSYSTEM=1`, no hooks, no signing, no credential helper. A trial on a
  Capy machine then behaves as on a fresh VM.

## Arms

| Arm | Setting | Role |
|---|---|---|
| off | `GBRAIN_REFRESH_BARRIER` unset (today's default) | comparator |
| on | `GBRAIN_REFRESH_BARRIER=1` | arm under test |

There is no #8708 (`persistence.adopt_local_edits`) arm: #8708 has not landed. If it lands, a later amendment may add it
as an exploratory, non-gating arm.

Both arms replay the same seed's schedule, so every comparison is paired by seed (concurrency), query (retrieval) or task
(agents). Every trial process logs the `refresh_barrier` value gbrain resolved at start, and analysis requires it to
equal the arm.

## Part A: concurrency trials (keyless, gating)

**Trials.** Seeds 1001 to 1500 per engine, both arms: 2,000 trials. No dry run used these seeds. One seed fixes the whole trial (`schedule.ts`): 1, 2, 4
or 8 agent sessions, each issuing 3 to 8 writes at fixed offsets in a 30 s window (`remember` on a person, `remember`
unattributed, `put_page` create, `put_page` read-then-update, and blind `put_page` through the CLI path); 1 to 3
`sources refresh` ticks, each pausing at one of its boundaries (`drained`, `fenced`, `merged`, `syncing`) for 0.25 to
25 s, after another machine pushed 1 to 4 files 1 to 6 s earlier; and five fault strata. Over seeds 1001 to 1500:

| Stratum | What it adds | Postgres trials | PGLite trials |
|---|---|---|---|
| foreign | a plain-git commit into the checkout, then a managed sync | 140 | 140 |
| import_sequence | inside foreign: blind put A on the changed page, then write B on it, then the sync | 110 | 110 |
| crash | a tick killed at its pause, then `--resume` | 65 | n/a |
| writer_kill | one agent process killed after its second write | 47 | n/a |
| expiry | `persistence.refresh_barrier_max_wait_ms` 2 to 8 s, shorter than the pause | 80 | 65 |

That is 10,948 writes per arm on Postgres and 10,646 on PGLite. Sessions follow the documented client contract: retry a
retryable refusal with the same request id after `retry_after_ms` (at most 8 attempts), poll a pending receipt with
`get_write_request`, never reissue a pending write. On Postgres the schedule's clock (t0) starts 0.5 s after every writer
process has loaded gbrain and connected (90 s limit), so a slow cold start cannot shift a write; each write records its
slip from its planned offset. After the window the trial waits up to 120 s for every request and Git effect to settle,
refreshes each source until it reaches its upstream (40 attempts, 1.5 s apart), then reads ground truth (`verify.ts`).
gbrain asks the user before it publishes a diverged checkout's local commits (`refresh_diverged`). When a refresh in that
phase refuses that way and the commits the remote lacks include the cron's plain-git commit (synced, never pushed, while
the remote moved and no later write published it), the harness gives gbrain's standing consent
(`sources.refresh_publish_diverged`) once, as a user answering that prompt would, and counts the trials that needed it
per arm. Divergence made only of gbrain's own commits gets no consent, so a publication fault still shows as
`no_converge` and `unpublished`; a gbrain commit left unpushed beside a cron commit would be published by the consent
and is not detected.
In a writer_kill trial with a single writer, no live process would hold a consumer for the killed writer's accepted
writes, so the parent starts one for the settle phase, as a deployment's `gbrain serve` would.

**Named case (GBRA-108).** Write A held for an import, then write B to the same page, then the checkpoint, run
deterministically (`named-case.ts`): a plain-git commit changes page P and six later pages; A is a blind put to P; a
one-page managed sync slice imports P and yields before its checkpoint (the window in GBRA-347's repro test); B is issued;
the rest of the sync stamps the checkpoint. B is `put_page` update, `remember` or a blind put; 25 repetitions each, per
engine and arm (repetitions 101 to 125): 300 runs. A run is in the window when A was held for the import, P was imported before B, and the
checkpoint had not moved when B was issued.

**Failure classes.** A flag-on trial or named-case run fails if any write or the run shows one of these. One predicate
(`failureClasses` in `analyze.ts`) decides it for `trial.ts`, `named-case.ts` and the analysis alike:

| Class | Definition |
|---|---|
| lost | acknowledged (a committed or pending answer) and never applied: no request row, or committed with its marker in no page, fact, version or Git commit; or seen as committed by the client (in any answer or poll) while its row is missing, not committed, or committed without the write applied |
| lost_git | committed and in its page's current content, but absent from the checkout's Git HEAD after every Git effect settled |
| phantom | applied although its final state is not committed |
| duplicated | two request rows, or its marker twice in live facts, current pages, Git HEAD or the commit ledger |
| stuck | a request not final after the settle wait |
| overwritten | committed, then removed from its page's current content by anything other than a blind put admitted after it (CommitsInAdmissionOrder; GBRA-347 finding 1) |
| wrong_expiry | `refresh_barrier_expired` after its refresh released, or `pending_import_expired` more than 2 s after a sync or tick completed (ExpiryOnlyWhileWaiting; GBRA-347 finding 2) |
| unindexed | committed and in its page, but keyword search for its marker returns no chunk holding it |
| unpublished | committed and at the checkout's Git HEAD, but absent from the tracking remote's `main` after every Git effect settled and the sources converged (Git durability publishes every commit) |
| false_refusal | the writer's last answer was a non-retryable refusal and no poll reported it committed, yet it committed (an agent told "not saved" may save it again) |
| unexpected_outcome | an outcome outside the allow-list below: a refusal or final code not on it, a pending write ending failed or cancelled with another code, retries exhausted, a call or poll that timed out (60 s), or a read before an update that failed (the write still counts in the denominator) |
| hang | an actor past its deadline (writer 270 s past the window, tick 120 s past its pause, stop 30 s, convergence 150 s) or the settle wait not reached |
| deadlock | any Postgres deadlock (`pg_stat_database.deadlocks`) or any deadlock or 40P01 message |
| no_converge | after the load stops, a source cannot reach its upstream in 40 refreshes, or a pushed upstream marker is missing from Git HEAD, unless a committed blind put replaced its file after the import (the commit that dropped the marker added only committed blind-put markers; last writer wins, as for `overwritten`) |
| harness_error | a writer error, a tick or sync that threw without a gbrain error code (one gbrain refused with a code is an outcome, and convergence then decides no_converge), a process crash or non-zero exit the schedule did not plan, a bad argument (exit 2), a harness exception, an answer the harness cannot read (an OK body with no known state, an error with no code), a tick or sync status G is not known to return, a planned pause that never fired on a tick that refreshed, a process whose switch value differs from its arm, writers not ready within 90 s, "too many clients", an upstream push or cron commit the harness failed to make, or a tick, resume, sync or convergence process that exited non-zero other than a crash tick's planned kill |

**Allowed outcomes.** These are the protocol working, not failures: `revision_conflict` and `source_changed` (as a
refusal or a final state); `refresh_barrier_expired` only in the expiry stratum, as a final state only for a write held by
a refresh; `pending_import_expired` only for a write held for an import; and a retryable refusal (gbrain marks it
`retryable`, for example `worktree_refreshing`) that a retry under the same request id resolved. Anything else on a
flag-on write is `unexpected_outcome`. gbrain cancels a write only through an explicit cancel or `admission_paused`, so a
pending write whose issuing process died (writer_kill) must still commit; `cancelled` is never allowed. A tick that found
the checkout already current never reaches its boundary, so its unfired pause is counted apart, not as a harness_error.

**Triage.** A flag-on failure counts as gbrain's (FAIL) unless a harness-only fix, reviewed by one reader, makes the same
seed or run pass on the same G; then the verdict is FIX-METHOD and that engine's whole block reruns at the same seeds after
an amendment. A failed trial is never dropped, and every failure is reported with its seed and the repro command below.

**Provenance.** Every result records G's sha and a digest of the harness files, and every block's receipt records both;
results from more than one gbrain commit or harness tree, or from a tree other than the analyzer's, make the verdict
FIX-METHOD, and an analysis without a counted receipt for every block and engine reads UNCOUNTED. A block with a seed or
run missing, duplicated or outside the preregistered set is incomplete. A result file is never overwritten: `trial.ts` and
`named-case.ts` refuse an existing one, so a replay goes to another directory (their development `--replace` refuses inside
a directory that holds a counted run). A job that exits abnormally after writing
its result counts as `harness_error`. A job interrupted by stopping `run.ts` leaves no result and reruns when the block
resumes; the receipt and the analysis list every interrupted job.

**Primary gate.** Zero failed flag-on trials across all 1,000 flag-on trials and all 150 flag-on named-case runs. With
zero failures in n independent trials, the one-sided 95% upper bound on the failure probability per trial is
1 - 0.05^(1/n), about 3/n (rule of three). The analysis computes every bound on the n the run actually reached (named-case
runs in the window, writes actually held by a refresh or an import), not on the planned n:

| Unit | n (flag on) | 95% upper bound with 0 failures |
|---|---|---|
| trials, both engines | 1,000 | 0.30% |
| trials, one engine | 500 | 0.60% |
| writes, both engines (assumes independent writes) | 21,594 | 0.014% |
| writes held by a refresh or an import, flag on (assumes independent writes) | as reached | reported |
| crash trials (Postgres) | 65 | 4.5% |
| writer_kill trials (Postgres) | 47 | 6.2% |
| import_sequence trials, both engines | 220 | 1.4% |
| named-case runs in the window, both engines | 150 | 2.0% |

The bounds hold for this schedule distribution on these fixtures, not for any production workload. Writes in one trial
share a brain, so the per-write bounds assume an independence the design does not have; the per-trial bound is the primary
one.

**Write-latency gate (quiet latency block).** The barrier must not slow writes when no refresh is running, and a dedicated
block measures that. Per engine, seeds 2001 to 2100 replay their Part A writers and writes with no tick, upstream
push, foreign commit, sync or fault (`trial.ts --quiet`), in both arms. Take the seeds whose two runs both showed no
failure class and, from them, every write that ended committed, timed from its first call to its committed answer: at once,
after a retried refusal, or from polling a pending answer. A write whose writer stopped polling before it saw the commit is
timed to the database's commit time, and one with no commit time counts at the 180 s poll limit, so a write the barrier
slows past gbrain's inline wait raises the on-arm mean instead of leaving the sample. The pooled per-write mean latency of the on runs minus that of the off runs, with a 95% bootstrap interval that resamples whole seeds (10,000 resamples, seed
1), must have an upper bound of at most 25 ms on each engine. Quiet runs are flag-on trials like the others, so a failure
in one counts as a flag-on failure. The run count comes from the pre-freeze quiet smoke (below): it is the smallest count
at which a true difference of zero passes with more than 99% probability, given the spread the smoke measured.

Part A's in-trial measure is reported but does not gate: per seed, the mean first-answer latency of writes issued outside
every refresh window (each tick, resume and sync from its start to its end plus 1 s, as `trial.ts` records them) and
answered committed at once, as a paired bootstrap of on minus off. It gated in the first draft. At f04429da its per-seed
means rested on 1 to 40 writes, with a per-seed spread of about 250 ms on Postgres, so at 500 seeds a true difference of
zero would have failed about one time in three. GBEV-3 chose the quiet block on 2026-11-06, keeping the 25 ms margin.

**Secondary measures (descriptive, paired by seed, both arms).** Each failure class per arm. First-call outcome per write
(committed, pending, retryable refusal by code, refusal by code, timeout). Blocked time: the first answer's latency for
writes issued while a tick is paused (p50, p95, max). Attempts per write. On the flag-on arm, defer-to-apply and
release-to-apply latency (p50, p95, max). Refresh liveness: ticks completed within their five attempts, and convergence
attempts. Schedule fidelity: each write's slip from its planned offset, and planned pauses fired, skipped (checkout already
current) and missed. Unexpected outcomes by reason, on both arms. Intervals are 95% bootstrap intervals over seeds (10,000
resamples, seed 1).

**Positive controls.** Without them a clean flag-on result proves nothing, so a miss makes the verdict FIX-METHOD:

- **PC1, the problem exists here.** On the off arm, at least 5% of each engine's trials show at least one
  `worktree_refreshing` refusal. (Over seeds 1001 to 1500, 102 Postgres and 110 PGLite schedules place a write inside a
  paused tick early enough to be refused.)
- **PC2, the detector sees a real bug.** Before the counted run, the flag-on named case at de22702a, 10 runs per B kind
  per engine, through the counted harness tree (the same harness digest), reports `overwritten` in at least 80% of runs in
  the window.
- **PC3, the named case reaches its window.** At least 90% of each flag-on named-case cell (engine and B kind) is in the
  window. Only runs in the window count toward the 150.
- **PC4, the harness is sound.** `harness_error` in under 1% of trials in either arm.
- **PC5, the flag is live.** Per engine, on what actually ran: at least 5% of flag-on trials have a write that was held by
  a refresh (`deferred_refresh_id` set) and answered pending first; no flag-on write outside the expiry stratum got
  `worktree_refreshing` as its first answer; and every process's logged switch value equals its arm, in both arms.

## Part B: retrieval does not regress (gating)

`retrieval.ts` runs both runners at G once per arm, in a scratch gbrain-evals worktree whose `node_modules/gbrain` is a copy
of G (both runners import the pinned package), and compares them query by query:

- **Cat 18** (`cat18-embedding-providers.ts`, synthetic-v1: 165 pages, 25 queries, hybrid search in balanced mode, reranker
  off), cells `openai` (`text-embedding-3-large`) and `voyage` (`voyage-3-large`). Metric: page-normalized Recall@10.
- **Cat 26** (`cat26-contextual-retrieval.ts`, 30 pages, 10 queries), its three modes. Metrics: R@3 and MRR.
- **B1, deterministic:** both runners with `--stub-embed` (hash embeddings, no provider). Any difference is gbrain's, so the
  margin is -0.01: in every cell and metric, the lower bound of the paired 95% bootstrap interval over queries (10,000
  resamples, seed 1) of on minus off is at least -0.01. B1 also gates search latency: in each Cat 18 cell, the median
  `query_ms` on the on arm is at most 1.2 times the off arm's.
- **B2, real embedders:** the same with the providers above. Provider noise can move a ranking, so the margin is -0.02.
  Its embedding calls are paid and go through the budget ledger (run `gbev44-refresh-barrier-b2`); that path lands with
  Part C's runner, and until then `retrieval.ts` runs only B1.
- A query that errored scores 0 in its arm. Both runners build their brains by inline import, which the flag should not
  touch, so any difference is a finding. G against the pin (`--label pin`) is reported, not gated.
- Before each arm, `retrieval.ts` resolves the switch through gbrain's own reader for a fresh brain in that arm's
  environment and gbrain copy, and records it; an arm that does not resolve to its value is not scored and is redone. The
  result records G, the harness digest and the gbrain-evals commit.
- **B3, inside Part A:** the `unindexed` class checks that every committed write is searchable, which is where the flag
  can change retrieval.

## Part C: agent experience (paid, gating against harm)

Runner: `eval/runner/refresh-barrier/agent.ts`, with its analyzer (the paired bootstrap below and the errored, rerun and
unexposed counts), which land in their own pull request, reviewed at full depth, before the first Part C paid window (this
one freezes the protocol).

- **Subjects:** `claude-opus-5-5` and `gpt-6.1-sol` (primary, gating) and `particle-1` (counted, reported in the first
  table with cost per correct answer beside `claude-opus-5-5`, not gating, run in its own crew paid window), at medium
  reasoning effort, through the Cat 40 tool loop (`eval/runner/cat40/loop.ts`), 4,096 output tokens per turn, 24 turns.
  The record keeps the effort sent and the effort that took effect. `scripts/model-freshness.ts` must pass for each model
  before its first paid call. No Sonnet or Haiku; Fable is not used.
- **Brain and tools:** a fresh PGLite synthetic brain per episode. The agent sees the tool list and server instructions
  that gbrain's MCP server at G returns, captured to a file whose sha256 the receipt records, and calls them as a remote
  MCP client in the same process.
- **Fault:** the harness holds the agent's first call to a journaled write tool (a tool not marked read-only that takes a
  `request_id`: `remember`, `put_page`, `append_page`, `edit_page` and the like), starts a refresh of `alpha` after
  one upstream push, waits until the refresh pauses at `drained` for 14 s, then lets the write through. Off, the write
  waits about 10 s and is refused with `worktree_refreshing`; on, it answers pending. Everything else is identical, and
  the tool list's sha256 is the same in both arms. An episode whose fault never fired is reported as unexposed.
- **Tasks:** 60 generated tasks (seeded, ids 1 to 60) per model and arm: "save these four facts from my day to my brain,
  then report", two updates to existing people, one new note and one fact to remember, each with a distinctive token (for
  example a badge number). The agent ends by calling `submit_answer` with each fact as saved, pending or failed. Smoke
  and development runs use ids above 60 only.
- **Scoring, from tool logs and the brain after it settles, no judge:** strict success means all four tokens land exactly
  once, the report is correct for every fact (saved or pending for one that landed, failed for one that did not, none
  unreported), and no write was reissued under a new request id. Each part is recorded. Also: duplicates, missing facts,
  misreports, tool calls, retries, and for each refused write whether the agent retried under the same request id, how
  long it waited and whether that reached `retry_after_ms`; pending answers delivered as errors (`write_pending`) and
  whether a reissue followed; wall time, tokens and cost.
- **Errored episodes:** an episode that ends on a provider error or a network failure measured the provider, not the
  agent, so it is written as uncounted with its stop reason and rerun under the same task id inside the same paid window,
  at most twice; a task still errored after that leaves that model's Part C incomplete. A context overflow is the agent's
  own trajectory, which the flag can lengthen, so it counts as a failed episode in its arm. A cap stop is terminal: it
  ends that model's Part C INCOMPLETE, and nothing reruns. Errored and rerun counts are reported per model and arm.
- **Rule, per primary model:** paired bootstrap over tasks (10,000 resamples, seed 1) of on minus off strict success.
  Non-inferior when the lower bound is at least -0.10. Harm when the upper bound is below 0. Otherwise inconclusive.
- **Power:** with 60 paired tasks and strict success near 0.9 in both arms with independent errors, the standard error of
  the paired difference is about 0.055, so the rule detects a true harm of about 15 points with 80% power and shows
  non-inferiority at true parity about half the time. Outcomes correlated within a task shrink the error and raise both.
- **Smoke and headroom:** two episodes per primary model and arm (ids above 60) before the counted episodes, inside the
  smoke cap, not counted. The smoke also measures cost per episode: if a model's projected counted cost passes its cap,
  its counted episodes do not start until GBEV-3 decides. If every smoke episode succeeds strictly in both arms, the
  findings say the measure may be at its ceiling, and the result is read for harm only (CLAUDE.md).

## Decision rule

| Verdict | When |
|---|---|
| PASS | Part A has zero failed flag-on trials, quiet runs and named-case runs, PC1 to PC5 hold, the write-latency gate (quiet block) holds on both engines, every B1 and B2 margin and the B1 latency ratio hold, and Part C is non-inferior for both primary models |
| PASS, agent experience inconclusive | as PASS, but Part C is inconclusive for a primary model without showing harm |
| FAIL | a flag-on failure that counts as gbrain's (see Triage), the write-latency gate or the B1 latency ratio missed, a Part B margin missed because of the flag, or Part C harm for a primary model |
| FIX-METHOD | a positive control missed, a flag-on failure a reviewed harness-only fix clears, or a counted cell incomplete for a reason other than the cap |
| INCOMPLETE | the cap stopped the run (it is not retried), or the quiet latency block has no runs on an engine |

**Recommending the flag on.** PASS says turning the flag on is safe; recommending it also needs a benefit. The findings
recommend flag on only if the verdict is PASS and, on each engine, flag-on writes outside the expiry stratum got
`worktree_refreshing` as their first answer in at most 0.1% of cases and the p95 blocked time (first-answer latency of
writes issued while a tick is paused) is under 1 s. Otherwise they say the flag is safe but its benefit was not shown.
particle-1's Part C result never changes the verdict or the recommendation.

Off-arm failures do not decide the verdict; they are reported per class as what the flag changes. A FAIL or FIX-METHOD
gets one "Why null?" cycle (R48) before it is reported. A gbrain bug found here (in either arm) goes to GBRA-108 with a
minimal repro on a test brain.

## What each outcome changes

| If it passes | If it fails | If FIX-METHOD or inconclusive |
|---|---|---|
| Evidence for GBRA-108 to turn the flag on by default; the findings name the residual bounds above | The flag stays off; the failing class, seed and repro go to GBRA-108 | The harness or task set is fixed by amendment and the affected block reruns; no flag recommendation until then |

## What this does not test

Garry's production brain or agent; brains with more than one host; network remotes (the remote is a local bare
repository); the lock-level interleaving of GBRA-347's finding 2, which GBRA-341's unit test covers (the expiry stratum
and `wrong_expiry` only catch it end to end by chance); syncs that take minutes (fixtures are small, so windows are
short); agents other than the three Part C models; #8708's local-edit adoption; and same-line Git conflicts between
another machine's push and a local plain-git commit (`integrate_conflict`, after which gbrain parks the file's publication
until a person resolves it; the schedule avoids them by construction).

## Budget

All-in cap $300 from the start of GBEV-44, counting this thread's and its subagents' credits (1,000 credits = $1); about
$40 was spent before the plan gate, no paid model call among it. Paid API calls go through `eval/runner/budget-ledger.ts`,
which reserves before each request and refuses past a cap. A ledger run holds one budget, so each item is its own run
(`gbev44-refresh-barrier-c-opus`, `-c-sol`, `-c-particle`, `-c-smoke`, `-b2`); both arms of one model join the same run:

| Item | Cap |
|---|---|
| Part C, claude-opus-5-5 (120 counted episodes) | $65 |
| Part C, gpt-6.1-sol (120 counted episodes) | $35 |
| Part C, particle-1 (120 counted episodes, not gating, own paid window) | $6 |
| Part C smoke (primary models) | $5 |
| Part B embeddings (B2: the two corpora embedded four times each) | $5 |
| Ubicloud VMs (Part A and the quiet block, about 7 VM-hours) | $20 |
| Crew credits, from the gate to the findings | $110 |

That is about $286 with the spend before the gate.

A cap stop ends that part INCOMPLETE and is never retried (R71). Part A is keyless: its child environment is an
allowlist with no provider key.

## Dry runs (development evidence, not counted)

On #8705 at de22702a, Postgres and PGLite, with seeds below 100 and named-case repetitions below 30:

- Off arm, seeds 10 and 66 (Postgres) and 4 (PGLite): 4, 10 and 4 `worktree_refreshing` refusals, all later committed
  on retry, every gate class 0.
- On arm, seeds 6, 7 (crash), 10, 13, 15 (writer_kill), 22 and 66 (Postgres) and 4 (PGLite): every gate class 0 except
  PGLite seed 13, where a blind put held for an import landed over a later `remember` (`overwritten`). That is GBRA-347's
  finding 1, which G fixes.
- Named case, on arm: `overwritten` in 7 of 7 runs in the window (B as update, remember and blind put; both engines).
  Off arm: A is refused `source_changed` and B lands. A PC2 rehearsal through `run.ts` (repetitions 1 to 10, every B kind,
  both engines) was in the window and `overwritten` in 60 of 60 runs.
- Part B plumbing, B1 only (stub embeddings, de22702a): every Cat 18 and Cat 26 cell identical off and on.
- In 2 of 7 runs, an off-arm `remember` (Postgres seed 10) got gbrain's frozen-verb pending answer: error
  `unavailable` with `write_error: write_pending` and a `write_request` still running (the shape gbrain's own
  `admittedPendingReceipt` reads as pending). The dry-run harness read only the error code, called it a non-retryable
  refusal and flagged `false_refusal`; the write committed exactly once. The harness now reads that shape as pending, as
  gbrain does (`classifyResult`). `false_refusal` stays a class for a real refusal that commits. The shape went to
  GBRA-108 as a client hazard: a client that keys on the error code may resubmit.
- Once, under machine load, a PGLite off-arm trial (seed 13) never converged: its local commits were not published and
  the refresh refused `refresh_diverged` for 60 s. Three reruns converged. Counted trials record every Git effect's state
  so a recurrence can be diagnosed.

### G-compatibility smoke at the fixed #8705 head (bf3085d1, development evidence)

The updated harness ran keyless at bf3085d1, schedule version 1 for most trials: seeds 13 to 36 on both engines and arms
(96 trials) and named-case repetitions 11 and 12 (24 runs). PC1, PC3, PC4 and PC5 held on both engines; `harness_error`
was 0; every planned pause on a tick that refreshed fired (41 of 174 planned pauses were skipped because the checkout was already current, and the rest of the unfired ones
belonged to ticks gbrain refused); every
process's switch value matched its arm. The named case on the on arm was in the window in 12 of 12 runs and never
`overwritten`, so GBRA-347's finding 1 is fixed at that build. Flag-on blocked time was p95 95 ms (Postgres) and 33 ms
(PGLite), against 10.4 s and 9.9 s off. Three things failed, and each changed something:

- Seed 24 failed on both arms and engines (`no_converge`, `unpublished`): a tick pushed the file a foreign commit had
  changed, both added a top line, and the merge stopped on `integrate_conflict`. That is the schedule's fault, fixed in
  schedule version 2.
- Seed 33 (Postgres, crash stratum) failed on the on arm in 2 of 3 runs and never on the off arm (0 of 3): a refresh
  killed at `fenced` after its own drain moved HEAD resumed as `refresh_recovery_required`, leaving 44 deferred writes
  pending with no end. Reported to GBRA-108 with the event logs; GBRA-341 fixed it in #8705 at f04429da (below), and seed
  33 reruns at G before the counted run.
- Three off-arm `remember` refusals had the wire code `scope_denied`: gbrain's frozen memory-verb contract answers a
  `source_changed` (pending import) conflict that way, with the reason in `write_error`. The spec client now reads
  `write_error` when a frozen code carries one, so these are allowed `source_changed` outcomes.

The write-latency gate as first drafted counted writes during refreshes that ended in a refusal, which made it noisy; it
then used the refresh windows that `trial.ts` records and only writes answered committed at once, and after the smoke
below it moved to the quiet block.

### Seed 33 and the G-compatibility smoke at f04429da (development evidence)

GBRA-341's fix for seed 33 is #8705 at f04429da. On fresh brains (a template built on f04429da's schema), seed 33 passed in
4 of 4 runs on the Postgres on arm: each tick was killed at `fenced` (three after the `refresh_diverged` retries and drain
that preceded both failures at bf3085d1), each resume came back `abandoned` with its refresh row `aborted`, a later
refresh completed, and every deferred write committed (15 to 23 a run). The off arm passed 3 of 3, and PGLite passed once
per arm. GBRA-108 then named two crash-resume shapes that still end `refresh_recovery_required` by design (a plain-git
foreign commit in the fence window, and a commit landing between the merge and its bookkeeping). Writes held behind such a
refresh stay `stuck` until a person acts, so they stay flag-on failures here; the counted schedule can reach them (21 of
its 65 Postgres crash trials also make a foreign commit), and G waits for GST-1674's fix.

The harness then ran keyless at f04429da with schedule version 2: seeds 13 to 36 on both engines and arms (96 trials) and
named-case repetitions 11 and 12 (24 runs). The on arm had 0 failed trials in 48 and 0 failures among 345 held writes;
PC1, PC3, PC4 and PC5 held with 0 `harness_error`; the named case was in the window in 12 of 12 on-arm runs with no
failure; flag-on blocked time was p95 92 ms (Postgres) and 39 ms (PGLite). Two things changed:

- Seed 16 failed on the off arm (Postgres, `no_converge`): an upstream marker was missing from HEAD while both sources
  were current. A blind put to that page (`alpha/people/eli-example.md`) committed late, after two `worktree_refreshing`
  refusals, which fits it replacing the file after the import (last writer wins); seven kept reruns did not repeat it.
  `no_converge` now excuses a marker a committed blind put dropped, as `overwritten` already did.
- The in-trial latency measure failed on both engines without a sign of a real slowdown (Postgres mean +1 ms, interval
  -106 to +91 ms; PGLite +36 ms, -26 to +96 ms; pooled medians 372 against 370 ms and 207 against 209 ms), because each
  seed's mean rests on few writes. The gate moved to the quiet block.

### Crash-resume smoke at #8705 149455d4 (development evidence)

#8705 at 149455d4 folds in GST-1674, and GBRA-347's TLA+ model passes on it. On fresh brains (a template built on its
schema), keyless, Postgres, both arms: seed 33 (twice on the on arm, once off) and six uncounted seeds with the shapes of
the counted crash trials that make a foreign commit near the crashed tick. 271, 798 and 963 pause at `fenced` with the
foreign commit before the merge; 355 and 408 pause at `merged` and 222 at `syncing`, with the commit between the merge
and its bookkeeping. No refresh ended `recovery_required`, and 13 of the 15 runs passed with every class at 0. Seed 798
failed on both arms with `no_converge`: the cron's plain-git commit was synced but never pushed, the remote moved, no
later write published it, and every convergence refresh answered `refresh_diverged`, which waits for the user's consent
by design. The convergence phase now gives that consent as described under Part A; seed 798 then passed on both arms
(twice on, once off).

### Quiet latency smoke (f04429da, development evidence)

Seeds 101 to 130 per engine at f04429da, on a 4-vCPU Capy machine, two trials at a time with each seed's arms side by
side: 0 failed runs and 0 `harness_error` in 120.

| Engine | Writes per arm | Pooled mean, on against off | On minus off (95% interval) | Standard error | Smallest count for a 99% pass at zero |
|---|---|---|---|---|---|
| Postgres | 524 | 249.7 against 244.3 ms | +5.4 ms (-16.2 to +23.9) | 10.2 ms | 93 |
| PGLite | 841 and 842 | 242.6 against 226.8 ms | +15.7 ms (-3.3 to +35.1) | 9.8 ms | 85 |

Every quiet write in the smoke was answered committed at once or refused for a revision conflict, none pending or retried,
so timing to the committed answer gives the same numbers: re-analysed with this harness, +5.4 ms and +15.7 ms with the same
intervals.

The standard error is the interval's half-width over 1.96; a true difference of zero passes with more than 99% probability
when 1.96 plus 2.33 standard errors fit within 25 ms. The counted block uses 100 seeds per engine (2001 to 2100), about 2
VM-hours. The smoke ran on a smaller machine than the counted VMs, so its spread is an estimate; the count is fixed here and
does not move with the counted data.

## Before the counted run: G-compatibility smoke

The harness was built against #8705's branch, so before the first counted trial it runs keyless at G on uncounted seeds
(below 100), both engines and arms, plus named-case repetitions below 100 and quiet-block runs on seeds 101 to 104, on
both engines. It passes only if every
planned pause on a tick that refreshed fired, sync and tick completions were recorded, the on arm held and deferred at
least one write, no unreadable answer or unknown status appeared, every process's switch value equalled its arm, and
`harness_error` is 0. One of these trials runs on a Ubicloud VM of the counted shape. If it fails, Amendment 1 may carry a
compatibility fix as described under "Build and data", and the smoke reruns. PC2 runs in the same window, at de22702a.

## Reproducing a failure

Every result names its seed or repetition, engine and arm, and `run.ts`'s receipt names G and the sha256 of every harness
file. To replay one on a test machine with Docker:

1. Start Postgres: `docker run -d --name rb-pg -p 5434:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=gbrain_test
   pgvector/pgvector:pg16 -c max_connections=500 -c shared_buffers=512MB`.
2. Check out G (`git -C <gbrain> checkout <sha> && bun install`) and build a template database with G's schema (a fresh
   database on which `PostgresEngine.initSchema()` ran).
3. Replay with the work directory kept: `bun --no-env-file eval/runner/refresh-barrier/trial.ts --seed <n> --arm on
   --engine postgres --out <dir> --gbrain-root <gbrain> --pg-admin postgres://postgres:postgres@localhost:5434/gbrain_test
   --template <template> --keep` (PGLite: `--engine pglite`, no database). For a named-case run, `named-case.ts --b <kind>
   --rep <n>` with the same options.
4. Read `<dir>/trials/<engine>/<arm>/<seed>.json` (the classes per write) and `<dir>/work/<engine>-<arm>-<seed>/` (every
   actor's event log, the three Git repositories, and the database left in place by `--keep`).

A schedule is a pure function of its seed, so the replay issues the same writes at the same offsets; timing between
processes is not replayed exactly, which is why a failure is triaged on the same seed rather than assumed to repeat.

## Disclosures

gbrain is Garry Tan's own project.

Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator. Garry
Tan runs Y Combinator.

Disclosure: Y Combinator, which Garry Tan runs, is an investor in Particle, which makes particle-1.

## Amendments

### Amendment 1, 2026-11-06: G, and harness fixes before the first counted trial

Recorded before any counted trial. Apart from the particle-1 money cut under **Part C models**, it changes no threshold,
count, seed range, cap, arm or verdict rule.

- **G:** the first gbrain master commit containing #8765 (barrier wave 2). GBRA-108 set this on 2026-11-07: #8765 folds in
  GBRA-360's fix for a foreign commit that lands between a refresh's merge and its bookkeeping on the live path, which
  GST-1674 fixed only on the recovery path. The G-compatibility smoke at `deef2593` (master v0.60.600.0, #8748, GST-1623's
  fixes) found that shape ending `refresh_recovery_required` without a crash (seed 355, off arm, 1 of 4 runs), and the outcome
  does not depend on the flag. G therefore contains everything the list above names plus #8765. GBRA-108 sends its sha when
  #8765 lands, and a dated entry records that sha before the first counted trial. Every counted block passes it to
  `run.ts` as `--gbrain-sha`, and `analyze.ts` now needs it too (`--gbrain-sha`, the full 40-character sha): a
  result, receipt, Part B result or Part C episode from another gbrain commit makes the verdict FIX-METHOD.
- **G-compatibility smoke at deef2593 (development evidence, uncounted):** with this harness, seeds 1 to 24 on both engines
  and arms (96 trials) had 0 failures and 0 harness errors; PC1 to PC5 held, with PC2 at de22702a overwritten in 60 of 60
  runs; 48 named-case runs had 0 failures; one trial per engine on a Ubicloud standard-16 VM passed. On Postgres the crash
  stratum passed on the on arm (seeds 33, 271, 798, 963, 355, 408 and 222, and seed 33 four times); seed 355 failed once
  on the off arm as described under **G**. The smoke reruns at G.
- **Hermetic environment:** the gbrain CLI that the owner's publish child runs is started as `bun --no-env-file`, like every
  other trial process. One rule (`PROVIDER_KEYS` in `fixture.ts`) names a key-like variable: any name containing KEY,
  TOKEN, SECRET, PASSWORD, PASSWD, CREDENTIAL, BEARER or AUTH, or a provider's name. `run.ts` keeps those variables out of
  every job, `openBrain` deletes them before any in-process brain opens (PGLite trials, named-case runs and Part C), and a
  child that still sees one exits 3. `agent.ts` reads the model's key once, before any brain opens, and hands each episode only
  the provider fetch built from it, never the key.
- **Verdict:** `analyze.ts` applies the decision rule to Parts A, B and C together and lists every reason, so a missed
  positive control reads FIX-METHOD and still lists each flag-on failure. It recommends the flag only on PASS with the
  benefit test.
- **Resuming a counted block:** `run.ts` refuses an existing result that lacks this run's G sha and harness digest, and a
  job the run log records as finished whose result is gone, so a counted result is never deleted and run again.
- **Crash placeholders:** PC5 leaves a job that wrote no result out of its switch and deferral checks; the placeholder
  still counts as a harness_error.
- **Failure classes:** `lost_git` and `unpublished` no longer depend on gbrain's own write-through report, so a committed
  write missing from Git HEAD or from `main` counts even when gbrain reported it not written through. A write that ends
  `cancelled` is always `unexpected_outcome`, as "`cancelled` is never allowed" says. A trial that has no commit ledger
  (no commit record in gbrain's `commit-ledger.jsonl`) but has a write that ended committed is a harness_error. At
  df7fca85 the ledger records every commit with a null request_id (writers `effect` and `merge`), so its per-request duplicate
  signal cannot fire there; `duplicated` still reads requests per id, live facts, pages and Git HEAD.
- **Settle wait:** approved by GBEV-3 (2026-11-07) at GBRA-108's request; changes no gate class, threshold or count. The sentence
  "After the window the trial waits up to 120 s for every request and Git effect to settle" now reads: after the window the
  trial waits up to 120 s for every request, refresh and Git effect to settle, and also for non-Git effects (`links`,
  `facts-backstop`) while a process that runs their retries is alive (on Postgres, the wait before the writers stop; on
  PGLite, both waits). Only requests, refreshes and Git effects decide `hang`; a non-Git effect still open at 120 s is
  reported under **Residual non-Git effects** and never counted. GBRA-356 found that these effects requeue on a 30 s retry
  after meeting a concurrent publication's recovery record, so they lag rather than stick (gbrain #8754).
- **Residual non-Git effects:** `analyze.ts` reports, per engine and arm, how many trials end with a non-Git effect still
  queued or running with error_code `recovery_required`, and how many such rows. They are not a failure class, since the
  classes above cover requests and Git effects only (GBRA-108 and GBEV-3, 2026-11-07, after the uncounted smoke at
  df7fca85 showed them in both arms). The verdict reports both counts per arm beside `trials_with_publish_consent`.
- **Part B:** B2 now runs, only on a named budget ledger: `retrieval.ts` opens or joins ledger run
  `gbev44-refresh-barrier-b2` ($5), every runner process joins it, and a cap stop finishes the run and records
  `cap_stop`, which reads INCOMPLETE. B1 and B2 results go to separate directories (`out/<label>-b1` and
  `out/<label>-b2`). A preregistered cell missing from an arm makes that result incomplete, which the decision rule reads
  as FIX-METHOD.
- **Part C:** `agent.ts` and its analysis follow "Errored episodes" above. An episode that stopped on a provider error or
  a network failure is written uncounted with its stop reason and the task reruns under the same id, at most twice;
  attempts from an earlier invocation count toward those two. A context overflow is a counted failure. A cap stop writes
  `cap-stop.json`, finishes that model's ledger run and leaves its Part C INCOMPLETE. A ledger lock timeout or a failed
  ledger write is not a cap stop: the run stops without writing the episode, so a resume runs it. Counted runs take only
  tasks 1 to 60, and smoke and `--fake` runs only ids above 60. Every episode records G's sha and the harness digest.
  `analyze.ts --partc` reports, per model and arm, the episodes, strict successes, errored, rerun, unexposed and
  context-overflow counts and the spend, and per model the paired bootstrap described above.
- **Part C models:** particle-1 is dropped from Part C: money cut ordered by GBEV-3 (2026-11-07); particle-1 did not gate.
  Part C runs claude-opus-5-5 and gpt-6.1-sol only, the `particle:particle-1` budget item ($6) is removed, and `agent.ts`
  refuses a particle model. The verdict always read the two gating models, so no verdict rule changes. With particle-1
  gone, no Part C episode puts a key into the environment gbrain runs in.

### Amendment 2, 2026-11-07: G's sha, three harness fixes, the $390 cap and five run procedures

Recorded before any counted trial. It changes no threshold, count, seed range, arm or verdict rule. It raises the all-in
cap, records a standing money-cut rule for Part C, and adds the run procedures below.

- **G:** `431cb3f91c615a6409d695d12f8af3ffec742475` (gbrain master v0.60.608.0, the merge of #8765), the first master commit
  containing #8765 and GST-1674's live-retry fix (GBRA-360: a plain-git commit that lands in a live refresh retry's fence
  window ends in a retry or an abort, never in a stuck `refresh_recovery_required`). GBRA-108 sent the sha on 2026-11-07.
  Every counted block and `analyze.ts` take it as `--gbrain-sha`. Its source differs from #8765's head 1efd624d, where the smoke below ran, only by master merges outside
  refresh, recovery and the barrier (upgrade channels, Git LFS during clones, a stall line's wording), and the
  G-compatibility smoke at G reruns the crash stratum regardless. For the record, GBRA-108 notes two accepted review
  findings in gbrain's `laterWriteRefusal` (a caller-set `managed_sync_` kind, and a compacted receipt read as a later
  write) that are fixed in #8766, not in G. Neither case occurs in this harness, and `refresh_barrier` stays off everywhere
  real until #8766 lands.
- **Counted code (R77, 2026-11-07):** the results ship in the same pull request as this amendment, #384, instead of after
  a merge. Counted runs use a pushed head of #384 with harness digest `8e8520f8b606`, never a merge commit, and every
  receipt records that head (`gbrain_evals.sha`, with `dirty` false) and the digest. Pushes after the first counted
  trial add results and findings only and change no harness file.
- **Harness fixes (digest `8e8520f8b606`):** three fixes since Amendment 1, each found by an uncounted smoke. None changes
  a failure class, threshold or count.
  1. *Writers start gbrain's persistence consumer* (`child.ts`), as `gbrain serve` does. At f6e8a9f4, seed 271's on arm
     hung in 3 of 4 runs with 7 or 8 Git effects still open at 120 s while the writer was alive. GBRA-360 traced it to
     the harness: the writer never ran the consumer that drains the effects it queues, a process shape gbrain does not ship.
  2. *The crash hold stays rooted* (`runtime.ts`). A crash tick's pause waited on a promise nothing referenced, so
     garbage collection could end the hold and release the refresh's file lock before the parent killed the process. The
     pause now waits on a promise held from a global. (GBRA-360's patch carries fixes 1 and 2.)
  3. *A foreign commit retries on gbrain's index lock* (`runtime.ts`, `trial.ts`). With fix 1, gbrain's own Git effects
     can hold `.git/index.lock` at the moment the plain-git cron commits. At 1efd624d, seed 222's foreign commit failed on
     it and the trial scored `harness_error`. The cron now tries again up to 40 times, 250 ms apart, as its next run would,
     and logs its attempts. A test covers it.

  With these fixes the uncounted smoke at #8765's head 1efd624d passed 86 of 86: seed 355 14 of 14 per arm, seed 271
  6 of 6 per arm, the crash stratum (seeds 33, 271, 798, 963, 355, 408 and 222) 7 of 7 per arm, and seeds 1 to 8 on both
  engines and arms 32 of 32.
- **G-compatibility smoke at G (development evidence, uncounted):** harness digest `8e8520f8b606`, on a 4-vCPU Capy
  machine. Seeds 1 to 24 on both engines and arms (96 trials) had 0 failures and 0 `harness_error`; PC1 to PC5 held, with
  PC2 at de22702a overwritten in 60 of 60 runs; 48 named-case runs (repetitions 1 to 4) and 16 quiet runs (seeds 101 to
  104) had 0 failures. On Postgres the crash stratum (seeds 33, 271, 798, 963, 355, 408 and 222) passed 7 of 7 per arm,
  seed 355 passed 14 of 14 per arm and seed 271 passed 6 of 6 per arm. Seed 1 on both engines and arms passed on a
  Ubicloud standard-16 VM, which was then deleted. The smoke passes.

  Its four quiet seeds put Postgres's on-minus-off write latency at +55.4 ms (26 to 71.5), above the 25 ms margin. The
  gate uses 100 seeds, so 30 more quiet seeds (105 to 134, Postgres) ran at G: +1.0 ms (-17.5 to +19.1) with this harness
  and +0.5 ms (-14.5 to +15.3) with Amendment 1's (main 489e140d, before the consumer fix). Both intervals hold zero and
  sit inside the margin, so the consumer fix does not slow quiet writes and the four-seed reading did not repeat.
- **Cap:** $390 all-in, GBRA-108 picked (c) on 2026-11-07; GBEV-3 confirmed it fits R71. It replaces the $300 under
  **Budget** and is the hard stop. Every paid line keeps its cap there: Part C claude-opus-5-5 $65, gpt-6.1-sol $35, the
  Part C smoke $5, B2 $5 and Ubicloud VMs $20. All-in spend when this entry was written: about $266.
- **Part C money cut (standing rule):** if the Part C smoke's measured cost per episode projects the run past $390, Part
  C's task count is cut by the same number of tasks for each model so the projection lands at about $380. A dated
  amendment records it as "money cut ordered by GBEV-3 (2026-11-07)", with the task count and the minimum detectable
  difference it leaves, before the first counted episode.
- **Run procedures:**
  1. B2 runs once, and its ledger run `gbev44-refresh-barrier-b2` is finished right after, so no later process can
     join it.
  2. Each counted Part C invocation first checks that the gbrain checkout is clean and at G (`git status --porcelain`
     empty, HEAD equal to G), and does not start otherwise.
  3. Before each paid invocation, the run environment is checked by name, never by value, for variables whose name
     contains AUTH (such as AUTHORIZATION, HTTP_AUTHORIZATION or an OAUTH variable), which `PROVIDER_KEYS` does not match.
     The invocation starts only when none is set.
  4. A Part C episode with a fact's token more than once in Git HEAD is not a strict success, even when `scoreEpisode`
     scores it one (its `duplicates` field lists the fact, but `success` reads current pages only). The episode is
     rescored by hand, and the adjudication (episode id, fact, the Git HEAD count) is recorded beside the results.
  5. One invocation runs per model and arm at a time, because two concurrent runs of one model and arm share a work
     directory and would delete each other's work and pay twice.
### Amendment 3, 2026-11-07: the counted Part A at G, its triage, a detector fix and a new harness digest

Recorded after the counted Part A at G and before any new counted cell. It changes no threshold, count, seed range, cap
or arm. It fixes one detector, records the harness digest every later counted cell uses, and adds a Part C scoring rule
(GBEV-3's B1, which the Part C verdict reads) before any counted Part C episode.

- **Counted Part A at G, scored as frozen:** #384 head `b3bbb0a8`, digest `8e8520f8b606`, on four Ubicloud standard-16
  VMs that were then deleted. The run had 2,000 trials, 300 named-case runs and 400 quiet runs, half of each flag-on,
  all with 0 `harness_error`. It reads **FAIL**, with 6 flag-on failures: `overwritten` in trials 1491 on both engines,
  PGLite trial 1075 and Postgres quiet run 2033, and `hang` in Postgres trial 1142 and PGLite trial 1192. PC1 to PC5,
  the write-latency gate, B1 and B2 held. GBRA-108 (2026-11-07): "Score the counted Part A at G 431cb3f9 exactly as the
  frozen prereg says. If that's FAIL, it's FAIL; don't re-score it." The findings report every number `analyze.ts`
  gives.
- **The two hangs are gbrain's.** A write held behind a refresh that ends `aborted` (seed 1192: `refresh_diverged` five
  times) or `abandoned` (seed 1142: the crash's resume) is not released or refused. It stays pending until a later
  refresh completes, which here is the convergence step, up to about 300 s after its first call. GBRA-108 ruled it a
  gbrain bug to fix before the flag turns on (GST-1853, GBRA-372). No harness change applies.
- **The four overwrites match a detector fault, and three are shown.** `removerOf` (`verify.ts`) named as removers every
  marker in the dropping revision that the revision just before it lacked. A blind put writes back the copy of the file
  it read, so its revision can carry an older marker back in: the cron line `FCM1491f1q` in seed 1491, or the earlier
  write `RBM2033w7o3q` in quiet seed 2033. The detector credited that older marker as a remover, so a blind put admitted
  later, which the `overwritten` row allows (last writer wins), read as an overwrite. `removerOf` now counts only
  markers that no earlier revision held. A new unit test on a four-revision page modelled on seed 1491 ("removerOf
  leaves out markers that a blind put carried back from the copy it read") gets `[FCM1491f1q, RBM1491iaq]` from the old
  code and `[RBM1491iaq]` from the fix. Replays at G on the same schedules, three per seed: with the old detector, seed
  1491 read `overwritten` in 3 of 3 on each engine and off-arm quiet 2033 in 2 of 3; with the fixed detector, all 12
  replays of 1491 (both engines) and quiet 2033 (both arms) pass, and 1491's replays credit `RBM1491iaq` alone. On-arm
  quiet 2033 passed its three old-detector replays, but its counted record settles it: of its removers `[RBM2033w7o3q,
  RBM2033w2o1q]`, the first (seq 72) committed before the dropped write (seq 73), so the new rule leaves it out, and the
  second is a blind put admitted later (seq 75). PGLite 1075 passed all three old-detector replays and its page history
  wasn't kept, so it is attributed to the detector by its signature only, not by a replay: its counted record credits
  the cron line `FCM1075f1q` beside `RBM1075iaq`, a blind put admitted later (seq 38 against 37), as in 1491.
  `removedByBlindPut`, the exemption in `no_converge`, uses the same function. PC2 at digest `17b629b49ea5`: the fixed
  detector still catches the admission-order bug at gbrain `de22702a` in 60 of 60 named runs. One reader reviewed the
  fix (subagent, claude-opus-5-5, 2026-11-07) and approved it with notes, which this text carries.
- **How Triage applies.** A failure that a reviewed harness-only fix clears would make the verdict FIX-METHOD, with that
  engine's block rerun at the same G. The two hangs are gbrain's, so the verdict at G stays FAIL, and the rerun moves to
  the next G with the fixed detector.
- **Harness digest from here on:** `17b629b49ea5`, which changes `verify.ts` only. Every later counted cell runs with
  it, and its results are never pooled with results from `8e8520f8b606`.
- **Next G:** the first gbrain master commit containing GST-1853's fix. GBRA-108 sends the sha, and a dated entry
  records it before the G-compatibility smoke and a fresh counted Part A run there. The projected cost goes to GBRA-108
  against the $390 cap before anything is spent.
- **Part C at G:** not run. GBEV-3 decided on 2026-11-07 (A1) that counted Part C runs only at a G where PASS is still
  reachable. The smoke at G (two episodes per model and arm, $1.33) is development evidence. The paid window closed
  after B2 and the smoke, with $1.37 on the budget ledger (B2 $0.033, smoke $1.334).
- **Part C adjudication (GBEV-3, B1, 2026-11-07), recorded before any counted Part C episode:** a write refused
  `invalid_params` with gbrain's "nothing was written", followed by a corrected call carrying the same fact token,
  counts as one write attempt and its resend, not a reissue. A resend after a success, a timeout, a busy or barrier
  answer, or any other error still counts as a reissue. A recorded script applies the rule identically to both arms and
  both models. The findings report the raw preregistered strict success beside the adjudicated number, and the verdict
  reads the adjudicated number. If the two disagree on the verdict, the findings say so in their first lines. The
  reason: in the smoke, claude-opus-5-5 passed an unknown `source` parameter to `remember`, gbrain refused it and wrote
  nothing, and the corrected resend was scored as a reissue, which failed both of Opus's on-arm smoke episodes.
