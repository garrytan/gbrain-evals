# The nightly gbrain check

The nightly check runs a frozen development set against one gbrain commit, usually gbrain master, and reports what
broke since the night before. It answers three questions a person changing gbrain needs every morning: which tasks
fail, why they fail, and whether last night's commits made anything worse. The runner is
[`eval/runner/nightly/run.ts`](../eval/runner/nightly/run.ts); the report is written by
[`report.ts`](../eval/runner/nightly/report.ts).

A night's numbers are development numbers. They exist to catch regressions and point at causes, so they are never a
published benchmark result and never stand in for one.

## What a night runs

The dev set is a versioned list of suites and items in
[`eval/data/nightly/devset-v1.json`](../eval/data/nightly/devset-v1.json), chosen for headroom: items that frontier
models on gbrain still miss, plus a few spread-out canaries. Each suite has its own digest. A night is compared with an
earlier night only suite by suite, and only where the digests match, so changing one suite starts a new baseline for
that suite alone. `bun eval/runner/nightly/select-devset.ts --check` rebuilds the file from the committed results and
checks that nothing changed.

| Suite | What it checks | Scoring |
|---|---|---|
| `cat40-hard-m` | Cat 40 Hard world M: company questions an agent answers through gbrain's MCP tools | deterministic |
| `refresh-barrier-agents` | An agent saves four facts while a refresh holds the first write, as production runs it | deterministic, from the brain, Git and the tool log |
| `refused-write-agents` | The same task with the barrier off, so the first write is refused: does the agent recover? | deterministic |
| `concurrent-writers` | Seeded keyless trials where writers race refreshes, crashes, kills and imports, on PGLite and Postgres | deterministic |
| `system-smokes` | Seven keyless smokes on a seeded synthetic brain (below) | deterministic |
| `lme-s-hard` | LongMemEval-S questions a frontier reader on gbrain got wrong, plus canaries | judge |
| `beam-1m-hard` | Questions from three public BEAM-1M dev conversations where frontier readers on gbrain missed most rubric items | judge |
| `tool-contract-replay` | Each model family's recorded tool calls replayed keyless through gbrain's rollout, write-capture and MCP paths | deterministic |

The seven system smokes cover the places where gbrain master broke in the 30 days before the check was built:
upgrading from the previous night's commit, upgrading from an old release, an ingest retried across an upgrade,
managed sync, source-pinned sync, Postgres 15 and the query contract. The upgrade smokes start from a brain the older
build wrote, so they need a gbrain clone with its release tags.

A suite can name a gbrain commit it requires. On a ref that lacks that commit, the suite is skipped and the report says
why.

## Tiers

Each invocation runs one gbrain ref (`--ref master`, `--ref stable` or a commit) at one tier:

- **nightly** runs the suites that are cheap to repeat every night: `tool-contract-replay`, `concurrent-writers`,
  `system-smokes`, `refresh-barrier-agents` and `refused-write-agents`. The two agent suites run on `gpt-6.1-sol`.
- **matrix** runs every suite with both frontier readers, `claude-opus-5-5` and `gpt-6.1-sol`. On matrix nights the
  report also compares master with stable.
- **smoke** runs every item once, with both readers, on master only. It checks that every path works end to end.
- **bisect** reruns one suite's firing items on one commit. [`bisect.ts`](../eval/runner/nightly/bisect.ts) drives it
  (see [Find the commit that broke something](#find-the-commit-that-broke-something)).

`--suites`, `--items`, `--readers` and `--k` narrow or override a tier's plan. Keyless suites (the replay, the trials
and the smokes) never call a model, so they run without keys on every tier.

## Readers and k

A reader is the model that answers or acts in a suite. The dev set's readers are `claude-opus-5-5` and `gpt-6.1-sol`;
the nightly tier uses `gpt-6.1-sol` alone, and keyless suites have no reader.

k is the number of trials per item. Agent suites run each item 3 times; QA suites, the replay, the trials and the
smokes run once, and the smoke tier runs everything once. The QA suites are judged across model families, so no judge
grades its own family: GPT-6 Astra judges Claude's answers and Claude Opus 5.5 judges every other family's. QA
judgments and provider calls are cached by content, so a resumed night repeats none of them.

## What the report shows

Each night writes `report.md`, `summary.json` and `outcomes.jsonl.gz` into its night directory,
`<out>/<night>/<ref>`. For each suite, reader and ref, the report shows:

- **pass^1 and pass^k.** pass^1 is the plain pass rate. pass^k (pass^3 on agent suites) is tau-bench's estimator: the
  chance that k trials drawn from an item's trials all pass, averaged over items. It rewards an agent that succeeds
  every time, not just once.
- **Failures by cause.** Every failed row gets one cause from the shared failure-cause library
  ([`eval/runner/failure-causes`](../eval/runner/failure-causes), causes listed in
  [TAXONOMY.md](failure-causes/TAXONOMY.md)), the same rules the other evals' failures go through, or `unclassified`
  when no deterministic rule explains it. The nightly never sends a row to a model labeller. Provider and harness
  failures are `harness` rows (`harness_error`): they are counted on their own line and left out of every rate. Items
  the night scheduled and didn't run are shown as not run, with the reason, and left out of every rate.
- **Weekly failure causes.** Each outcome row carries the fields the failure-cause `nightly` adapter reads, so a week
  of nights can go through `bun eval/runner/failure-causes/cli.ts classify` and `report` beside the other evals.
- **Cost per correct answer.** The suite's recorded cost divided by its passing rows. It's a metric for spotting a
  change that costs more for the same result.
- **Against the previous master night.** Suite by suite, where the digests match, the report flags any increase in a
  deterministic signal (refused tool calls, tool errors, harness errors, lost, stuck, duplicated or overwritten writes,
  failed smokes), a pass-rate drop whose paired bootstrap interval excludes zero, a strong flip (an item that passed
  every trial and now passes none) and a rise in cost per correct answer with no gain in pass rate. It also lists the
  gbrain commits since that night.
- **Against stable.** On matrix nights the same rules compare master with the stable release, in their own section.
- **Fixes.** [`eval/data/nightly/fixes.json`](../eval/data/nightly/fixes.json) records each gbrain fix shipped for a
  nightly finding, and the report shows its items every night, so a fix that regresses shows up next to its record.

A night run with `--fake` says so at the top of its report: its numbers test the plumbing and measure no model.

## Cat 40 world M is a dev set, never a Hard-freeze result

The nightly runs Cat 40 world M with the ladder's `--dev-set` flag. That runs it on the current harness code instead of
refusing because the code changed since Cat 40 Hard's freeze, and the cells receipt records which frozen files have
changed. Every such receipt carries the label "dev-set run on the current harness, not a Hard-freeze result: never
publish or compare it as one". The nightly report marks the suite "(dev set)" and lists the changed files under
"Dev-set runs". These numbers are never published or compared as Cat 40 Hard results.

## Run a night without keys

`--fake` runs every suite on its own keyless path: Cat 40's scripted agents on keyword-only slots, Part C's fake
provider and memory-qa's fake system. It makes no paid call and refuses `--paid`. You need a gbrain clone with its
release tags (`--gbrain-clone`, or `GBRAIN_REPO`, or `../gbrain` by default):

```bash
bun eval/runner/nightly/run.ts --ref master --tier matrix --fake --out eval/reports/nightly --gbrain-clone ../gbrain
```

The runner builds the commit into a verified copy of gbrain and runs each suite in its own child processes. The
Postgres trials need `--pg-admin <url>`; without it they are skipped and the suite is marked partial. The Postgres 15
smoke needs both `--pg-admin` and `--pg15-admin`; without them it records a harness failure. Use `--suites` to run
only what your machine supports.

A night that calls models runs only with `--paid` and a [budget ledger](budget-ledger.md) run. Without `--fake` or
`--paid`, a night that includes a model suite is refused before anything runs.

## Pay for a night

A paid night spends through one run in a durable budget ledger that carries from night to night. Each nightly run's
budget is the smaller of the night cap and what is left of the 30-night cap. An open nightly run holds its whole budget
against the 30-night cap (or what it committed, if that is more), whatever its age, because a resume or a bisect step
can still spend it. A closed run holds what it committed in the 30 days before. So two runs opened one after another
can't add up past the 30-night cap. Two opens at the same moment can, so open runs one at a time.

Only a run's opener closes it. A night gets its run in one of two ways:

- **The night opens it.** Pass `--paid --budget-ledger <path> --night-cap-usd <n> --month-cap-usd <n>`. The runner
  records in `night.json` that it opened the run, and closes it when the night, or a later resume of it, ends without a
  stop. A night that stops leaves its run open for the resume.
- **You open it and pass it in.** A matrix night opens one run for master and stable together:

```bash
RUN=$(bun eval/runner/nightly/ledger.ts open --budget-ledger <path> --night <YYYY-MM-DD> --ref matrix --night-cap-usd <n> --month-cap-usd <n>)
bun eval/runner/nightly/run.ts --ref master --tier matrix --paid --budget-ledger <path> --budget-run-id "$RUN" --out <dir> --gbrain-clone ../gbrain
bun eval/runner/nightly/run.ts --ref stable --tier matrix --paid --budget-ledger <path> --budget-run-id "$RUN" --out <dir> --gbrain-clone ../gbrain
bun eval/runner/nightly/ledger.ts close --budget-ledger <path> --budget-run-id "$RUN"
```

Each `run.ts` line also needs the settings its suites need, as described under
[Run a night without keys](#run-a-night-without-keys): `--pg-admin` and `--pg15-admin` for the Postgres trials and
smoke, and `--cat40-slot-allowance-usd` for a paid Cat 40 run. `--resume` repeats the night's first arguments, so a
night started without them can't gain them on a resume.

The runner never closes a run passed in with `--budget-run-id`, on the night or on a resume. It refuses an id that
isn't a nightly run, and one that is already closed. If you won't resume a stopped night, close its run, so its unspent
budget stops counting against the 30-night cap.

## When a night stops

The runner exits with a code and prints the command that resumes the night:

| Exit | Name | Meaning |
|---|---|---|
| 3 | `NIGHTLY_CAP_STOP` | The night's ledger run has no budget left. Paid suites stopped where they were. |
| 4 | `NIGHTLY_VM_LOST` | The runner was signalled because the machine is going away. Running children were killed. |
| 5 | `NIGHTLY_HARNESS` | A suite failed to run, or recorded harness or provider failures. Those rows are counted apart. |

A refused paid run exits 2, and any other error exits 1.

```bash
bun eval/runner/nightly/run.ts --resume <night dir>
```

`--resume` reruns only what is missing or recorded as a harness failure, on the gbrain commit the night started on,
even if the ref has moved since. It first settles the stopped run's open ledger reservations. Run it only after every
child process of the stopped run has exited. On a Ubicloud VM that holds by construction, because `ubi-runner.sh`
destroys the VM, and every child with it, on every exit path. A night can be resumed at most twice.

A fresh run into a night directory that already holds a `night.json` is refused and prints the `--resume` command
instead, so a second run never adds to a night's outcomes.

## Find the commit that broke something

When a flag fires, `bisect.ts` binary-searches the first-parent commits between the good night and the bad one,
rerunning only the firing items. A commit is bad when at least half of those items' trials fail there.

```bash
bun eval/runner/nightly/bisect.ts --suite <id> --items <a,b> --good <sha> --bad <sha> --gbrain-clone ../gbrain --out <dir> --fake
```

Each step runs `run.ts` on one commit with only the firing items. Pass the settings the suite needs, and bisect hands
them to every step: `--cat40-slot-allowance-usd` for Cat 40, and `--pg-admin` (with `--pg-template`) and
`--pg15-admin` for the Postgres trials and smoke. Keyless suites cost only machine time. A paid bisect works like a
matrix night: it gets its own ledger run from `ledger.ts open` (or takes an open one its caller opened), passes it to
every step with `--paid --budget-ledger <path> --budget-run-id <id>`, and the run's opener closes it with
`ledger.ts close` when the bisect ends. No step closes it.

## Run it on a Ubicloud VM

A full night needs Postgres 15, a current Postgres and more cores than a laptop, so it runs on an ephemeral
Ubicloud VM:

1. `scripts/nightly-export.sh <dest>` writes the files a night needs: every tracked file outside `docs/`, plus the few
   `docs/benchmarks` inputs the runner reads. The rest of `docs/` is past results a night never reads.
2. From that export, `scripts/ubicloud/ubi-runner.sh run -s standard-16 --src . --setup scripts/nightly-vm.sh -- '<night command>'`
   boots the VM, runs the night and destroys the VM on every exit path. `ubi-runner.sh list --mine` printing nothing
   confirms it is gone.
3. [`scripts/nightly-vm.sh`](../scripts/nightly-vm.sh) mirrors CI: the Bun version CI pins, a frozen install, then
   Docker with pgvector images for Postgres 15 and Postgres 18 (pinned by digest, bound to 127.0.0.1) and a gbrain
   clone with every release tag. It prints the two Postgres admin URLs to pass as `--pg-admin` and `--pg15-admin`.
   It never reads or forwards a provider key.

## Changelog

### 2026-11-10: Failures by cause use the shared taxonomy

Failures by cause came from the nightly's own `classify.ts` and its ten causes. They now come from the shared
failure-cause library and its taxonomy, so a nightly failure and another eval's failure get the same cause. Added the
weekly failure-cause step and the not-run rows for scheduled items a night skipped.

### 2026-11-09: Paid nights, resumes and bisect settings

Added how a paid night gets and closes its ledger run: an open run holds its whole budget against the 30-night cap, only
its opener closes it, and the matrix and bisect flows open one run and close it at the end. `--resume` now says to run
only once the stopped run's children have exited, a fresh run into an existing night is refused, and bisect passes the
Cat 40 and Postgres settings to every step. The matrix example says which settings its runs need, and the 30-night cap
holds for runs opened one at a time.

### 2026-11-09: First version

New page: what the nightly check runs at each tier, its readers and k, what the report shows, why Cat 40 world M is
labelled a dev set, how to run a night keyless, the exit codes and `--resume`, bisect and the Ubicloud bootstrap.
