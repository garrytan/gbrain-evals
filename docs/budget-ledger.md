# The budget ledger

Every paid runner in this repository spends through one ledger. Before a request to a paid provider leaves the process, the runner reserves its worst-case cost in the ledger. After the response, it settles the reservation to the provider-reported usage. A reservation that would take a run past its `--budget-usd`, or all runs together past the program cap, is refused and the request is never sent.

Since 0.10.12 the ledger is a SQLite file (`bun:sqlite`, WAL mode, `synchronous=FULL`). It replaced `.budget/ledger.json`, which every reservation parsed and rewrote in full on the runner's event loop. At 110,000 entries one reserve plus settle blocked the loop for about 0.6 s, which made gbrain's tool latency in Cat 40 look 10 to 30 times slower than it was. A reserve or settle is now one short transaction whose cost does not grow with the ledger: on a 4-core cloud machine, a reserve plus settle pair took 0.45 to 0.8 ms with 200,000 entries in the ledger, most of it the two write-ahead-log fsyncs (about 0.4 ms each on that disk). `test/eval/budget-ledger-sqlite.test.ts` asserts the average stays under 5 ms on a 200,000-entry ledger and does not grow with its size.

This guide is written for the operator, usually an agent. Every refusal message names the command that fixes it.

## Create a ledger

```sh
bun eval/runner/budget-ledger.ts init --budget-ledger .budget/cat40-followups.sqlite --program-cap-usd 237 --reason "remaining authorization"
```

`init` records the program cap inside the ledger, with who set it, when and why. It defaults to $500 and never changes an existing ledger. The default ledger, `.budget/ledger.sqlite`, is also created on first use with the $500 default. Any other path must be created with `init` first: a runner pointed at a missing ledger refuses and prints the `init` command, so a typo in `--budget-ledger` cannot start a fresh ledger that forgets earlier spending.

A path ending in `.json` means its sibling `.sqlite` file. The runner prints one notice line when it maps a path this way.

## The program cap lives in the ledger

Runners take the cap from the ledger. Pass neither `--program-cap-usd` nor `BRAINBENCH_PROGRAM_CAP_USD` and the recorded cap applies. Pass one and it must equal the recorded cap; a different value is refused, and the message says whether it came from the flag or the environment variable. A campaign manifest's cap (the evidence-delivery campaigns) is an upper limit: the ledger's cap may be lower, never higher.

To change the cap, ask the user first, then record the change:

```sh
bun eval/runner/budget-ledger.ts set-cap --budget-ledger <path> --program-cap-usd <dollars> --reason "<who approved it and why>"
```

`set-cap` refuses a cap below what the ledger has already committed.

## Check a ledger

```sh
bun eval/runner/budget-ledger.ts status --budget-ledger <path> [--budget-run-id <id>]
bun eval/runner/budget-ledger.ts verify --budget-ledger <path>
```

`status` is read-only and prints one JSON object: the recorded cap, committed spend (settled cost plus open reservations), what is left, overshoot, run counts, the last cap change, the file size, how long the read took, and a `hints` array that ends with two runbook lines (both files present; cap mismatch). It never creates or migrates a ledger. Before migration it reads a legacy `ledger.json` without changing it.

`verify` is read-only too. It runs SQLite's integrity check and recomputes every run's committed total and the program total from the entries. It exits 1 and prints the first problem when anything disagrees.

## What a reservation counts

A reservation is the worst case for the request as sent:

- input: the system prompt, OpenAI `instructions`, messages and input, and the tool schemas at their full JSON size, at about 3 bytes per token;
- a request that continues an OpenAI response (`previous_response_id`) also reserves that response's reported input plus output tokens, because the provider bills the whole chain as input. A response id this process has not seen reserves a full 1,050,000-token context;
- when the request can write the provider's prompt cache at a price above the input price (OpenAI models with a cache-write price; Anthropic requests that set `cache_control`), all input is priced at the cache-write rate;
- output: the request's own output limit, or 4,096 tokens.

If a settled cost is still above its reservation, the difference is recorded as `overshoot_usd` in the run summary, the receipt and `status`. It already counts against both caps.

## Failures stop spending

- A write that fails (disk full, I/O error, failed fsync) records nothing and makes the process refuse every further reservation until it restarts. Run `verify` before restarting.
- Another process holding the ledger's write lock for 20 s makes a reservation refuse rather than wait forever.
- A file that is not a SQLite ledger, or that SQLite cannot read, refuses with the `verify` command.
- A ledger file replaced while a runner is open (a restore from backup) is reopened before the next write; that runner's run then is not in the new file, and it refuses.

## Event-loop lag in every receipt

`startPaidRun` starts a monitor that records how late a 10 ms timer fires. The run's summary and every receipt's cost block carry `event_loop_lag_ms: {p50, p99, max}`, or `null` with `event_loop_lag_unavailable` and the reason. A synchronous stall on the runner's event loop, like the old ledger rewrite, shows up there. `eval/runner/cat40/analyze.ts --receipt <file>` warns when p99 is 50 ms or more, because tool latency from that run is then not trustworthy.

## Migrating a legacy ledger.json

The first paid run (or `init`) on a path whose legacy `ledger.json` exists migrates it once. The migration holds two locks: `ledger.json.lock`, which code from before 0.10.12 also takes, and the new ledger's creation lock. Then:

1. It writes the SQLite ledger to a temporary file, fsyncs it, renames it into place and fsyncs the directory.
2. It copies `ledger.json` to `ledger.json.migrated` and fsyncs the copy.
3. It atomically replaces `ledger.json` with a tombstone, `{"schema_version": 2, "migrated_to": "<ledger path>"}`.

Every run and entry keeps its id, amounts, status, tokens, timestamps and participant. Open reservations stay committed at their reserved amount and can still be settled. The migrated ledger records the cap passed explicitly, or $500. The legacy file's own `program_cap_usd` only recorded the flag of its last writer, so it is not carried over.

Code from before 0.10.12 reads the tombstone as an unreadable ledger and refuses to spend, so an old worker cannot split the accounting.

A crash during migration is safe at every step. Before the rename, the legacy file is still the only ledger and the next open retries. After it, both a real `ledger.json` and the SQLite ledger exist, and every runner refuses with one of two messages:

- **Totals match:** an interrupted migration. Finish it with `bun eval/runner/budget-ledger.ts migrate --finish --budget-ledger <path>`.
- **Totals differ:** one file has spending the other lacks. Stop and ask the user; do not delete or rename either file.

### Upgrade procedure

1. Stop every runner that uses the ledger.
2. Pull this version.
3. Run `bun eval/runner/budget-ledger.ts status` (it shows the unmigrated legacy totals).
4. Start one runner, or run `init`, to migrate.

### Downgrade

Downgrading is safe only while `verify` shows no spending after the migration (compare its totals with `ledger.json.migrated`). Then restore `ledger.json.migrated` to `ledger.json`, move the SQLite file aside and check out the older version. Once anything has been spent through the SQLite ledger, keep it: the older code cannot see that spending.

## Recovering a damaged ledger

When `verify` fails:

1. Stop every runner and copy the ledger with its `-wal` and `-shm` files.
2. On the copy, run `sqlite3 <copy> ".recover" | sqlite3 <recovered>.sqlite`.
3. Run `verify` on the recovered file and compare its totals with the last good `status` output and the providers' usage pages.
4. Ask the user before spending against the recovered file.

## A free smoke run

Nothing here sends a paid request:

```sh
L=$(mktemp -d)/smoke.sqlite
bun eval/runner/budget-ledger.ts init --budget-ledger $L --program-cap-usd 5
RUN=$(bun eval/runner/budget-ledger.ts open --runner smoke --budget-usd 1 --budget-ledger $L)
bun eval/runner/budget-ledger.ts status --budget-ledger $L --budget-run-id $RUN
bun eval/runner/budget-ledger.ts close --budget-run-id $RUN --budget-ledger $L
bun eval/runner/budget-ledger.ts verify --budget-ledger $L
bun eval/runner/cat40-model-ladder.ts --scripted --arms fs,memory,oracle --tasks A01 --out $(mktemp -d)
```

## Cat 40 cost-wave runbook

`scripts/cat40-followups.sh` assembles every paid command of the Cat 40 follow-ups plan (`docs/plans/2026-10-03-cat40-followups/PLAN.md`, with the 2026-10-03 gate decisions). All of them spend through `.budget/cat40-followups.sqlite`, created with the $237 that remained of the program's $2,000 authorization. Nothing else may spend against it while the plan runs. `PRINT_ONLY=1` prints the commands without running them.

| Step | What it does | Step budget |
|---|---|---|
| `init` | creates the ledger with the $237 cap | free |
| `power` | CI half-width of two near-identical held-out builds (the ship rule's power check) | free |
| `slots-dev` | `ad7900d` slot brains on the dev world, built one at a time | $6 |
| `dev1` | C1+C2 on 3 models | $18 |
| `latency` | replays 40 of dev round 1's own `search` and `query` calls, one worker per slot on all 5 slots; passes when the harness p50 is within 2x of the replay and the run's lag p99 is under 50 ms | $1 |
| `screen1`, `screen2` | dev-round harm screen against the `51a30c1` fix-wave ladder: drop a change at -5 points or worse, or when `total_usd` per task did not fall | free |
| `dev2` | C1 to C4 on 3 models; refuses until `latency` and `screen1` pass | $18 |
| `world` | regenerates the held-out world and checks its digest starts `df9e4f65cf60` | free |
| `slots-holdout`, `slots-control` | slot brains for the final build and for `566a242a` on the held-out world | $6 each |
| `holdout` | final build, 6 models x 2 repeats; refuses until `screen2` passes | $95 |
| `control` | `566a242a` with the same models, repeats and arguments | $85 |
| `compare` | the ship rule: holdout against control, -5 point margin with the -3 point result beside it, no new leaks, per-model and per-family flags at -8; then `analyze.ts` with cost split, lag warnings and ledger reconciliation | free |
| `ladder` | optional: the 11-model dev ladder with what is left, `--order model` | remaining |

Every agent step's `--out` directory is bound to its experiment (`experiment.json`: build, world, models, arms, label, flags and budget run). Rerunning a step after a timeout resumes it and joins its original budget run, so the restart does not get a fresh budget. A changed build is refused on the same directory; set `OUT_SUFFIX` for a rerun after dropping a change.

The runner's agent steps refuse to start when a slot snapshot they need is missing. Slot builds are their own steps because five concurrent builds used to reserve $25 of allowances at once, more than a dev round's budget.

## What reads the ledger

Every runtime reader goes through `eval/runner/budget-ledger.ts` (`ledgerStatus`, `readLedger`, `BudgetRun`): `paid-arm.ts`, `all.ts`, `evidence-delivery.ts` (it read `ledger.json` directly before 0.10.12), `evidence-auto-v2.ts`, `evidence-delivery/ledger-preload.ts`, `longmemeval-batch.sh` through the CLI, and every runner that calls `startPaidRun`.

Three other files called ledgers are not budget ledgers and are not covered: `eval/runner/bug-ledger.ts` (the bug ledger), `eval/runner/system-one/recount.ts` (historical System One spend records) and the Python retrieval-refresh orchestrator's `budget-ledger.json` (`scripts/run-retrieval-refresh.py`), which keeps its own cap outside this guard (TODOS.md).

Test files that pointed at `ledger.json` now point at the resolved `.sqlite` path, so none of their checks pass vacuously: `budget-ledger.test.ts`, `paid-runner-budget.test.ts`, `longmemeval-metrics.test.ts`, `longmemeval-batch-sh.test.ts`, `wave-step0.test.ts` and `situation-native-evidence-35.test.ts`. `evidence-delivery-bridges.test.ts` keeps its `l.json` paths on purpose: they exercise the `.json` to `.sqlite` mapping. The `ledger.json` names in the sealed-confirmation, LongMemEval-M pilot and historical-path tests are other files.
