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
| `refused-write-agents` | The same task with the barrier off, so the first write is refused: does the agent recover? A replay under the request id the refusal names is a retry, not a resend | deterministic |
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
grades its own family: GPT-6 Astra judges every family's answers except OpenAI's, which Claude Opus 5.5 judges. So
claude-opus-5-5 and particle-1 share a judge, and their agreement compares the two readers, not two reader-and-judge
pairs. QA judgments and provider calls are cached by content, so a resumed night repeats none of them.

The QA reader may write up to 8,192 output tokens per answer. The limit is `qa_max_tokens` in each QA suite's config,
so it is part of the suite digest, and memory-qa's receipt records the limit it sent. 8,192 is what the BEAM rows of
the file agent (a model with list, grep and read tools over the sessions as files) give Claude on every turn, and at
half that no frontier answer on BEAM-1M dev reached the limit ([S1 fixes](benchmarks/2026-10-12-beam-1m-s1-fixes.md)). memory-qa's own default is 1,024 tokens, and Claude's
adaptive thinking counts against it. On the 2026-11-10 master night, at that default, 19 of Opus's 25 BEAM failures
were answers cut off before they finished. particle-1 keeps its own floor of 16,000 tokens.

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
  failures are `harness` rows (`harness_error`): they are counted on their own line and left out of every rate. An
  answer cut off at its output limit (finish reason `length`, `max_tokens` or `max_output_tokens`) is a harness row
  too, whatever the judge gave it, because it measured our limit and not gbrain. Rows from older nights that record only
  the finish reason are read the same way. Items the night scheduled and didn't run are shown as not run, with the
  reason, and left out of every rate.
- **Finish reasons.** Every row records the reader's finish reason where the suite's runner records one (the QA
  suites, from memory-qa's reader receipt), and null where it records none: Cat 40 Hard and the Part C agent suites
  keep no per-call finish, and the keyless suites have no reader.
- **Weekly failure causes.** Each outcome row carries the fields the failure-cause `nightly` adapter reads, so a week
  of nights can go through `bun eval/runner/failure-causes/cli.ts classify` and `report` beside the other evals. List a
  QA suite's published logs archive (`logs/<suite>.tar.gz`, role `logs`) beside its outcomes: its memory-qa receipts say
  how many sessions each reader was given, so a question with more gold sessions than that is labelled `reader_budget`,
  a suite cause, instead of a gbrain retrieval or ranking cause. Without the archive those rows label as before. The
  weekly report still shows what retrieval did on those rows: each one's first secondary cause, counted per source on
  the "Suite causes" list and in `summary.json` as `reader_budget_secondary`.
- **Items the support check rejects.** `eval/data/nightly/beam-1m-hard-support.json` records, per beam-1m-hard item,
  what the BEAM support check found: whether each of its two validators (gemini-3.8-flash and claude-haiku-5-5) judged
  the reference answer supported by the turns the item cites, and whether the October arm given every gold session
  passed it. A failed row on an item both validators reject, or one that cites no turn, counts as `item_unsupported` in
  the weekly failure causes, not as a gbrain failure, when that arm failed the item too (3 items): the cited gold
  sessions don't support the answer. The label is the only effect. Those items stay in the pass-rate and strong-flip
  flags, and the report lists their failed rows on one line. The arm ran before the 8,192-token output limit, so some of
  its fails may be truncation; an answer it left empty at its output limit records no verdict and labels nothing. The
  record sits beside the dev
  set, not in it, so the suite digest doesn't change. The six abstention items cite no turn by design and are not
  checked.
- **Cost per correct answer.** The suite's recorded cost divided by its passing rows. It's a metric for spotting a
  change that costs more for the same result.
- **Against the previous master night.** Suite by suite, where the digests match, the report flags any increase in a
  deterministic signal (refused tool calls, tool errors, harness errors, lost, stuck, duplicated or overwritten writes,
  failed smokes), a pass-rate drop whose paired bootstrap interval excludes zero, a strong flip (an item that passed
  every trial and now passes none) and a rise in cost per correct answer with no gain in pass rate. A cut-off answer
  counts there as a harness error, never as a pass-rate drop or a flip. It also lists the gbrain commits since that
  night.
- **Against stable.** On matrix nights the same rules compare master with the stable release, in their own section.
- **particle-1's agreement with Opus.** On a night that runs particle-1 beside claude-opus-5-5 (`--readers
  claude-opus-5-5,particle-1`), the report checks whether the low-cost reader marks the same items right and wrong as
  Opus. particle-1 runs on the QA suites only: Part C's worker and the Cat 40 Hard runner take Claude and GPT readers,
  so the night leaves particle-1 off the agent suites. The nightly tier plans no QA suite, so pass `--suites
  lme-s-hard,beam-1m-hard` there, or use the matrix or smoke tier. particle-1's first trial of an item and Opus's first
  counted trial are each reader's pass or fail. Two kinds of error say nothing about either reader, so they leave the
  item unpaired with their cause named: a harness row whose cause is a stage both readers share, before or after the
  reader (embedding, retrieval, rerank or the judge), and a gbrain tool error, on either reader's row, whose embedding
  or retrieval provider returned a 429 or 5xx. So do a row a run-level stop cut off, an item Opus has no counted trial
  for and one the night didn't run for particle-1. Three kinds of error stay fails: an error from particle-1's own
  provider or call (a crash, an invalid answer, a 4xx or 5xx on the reader call), so a reader that breaks on hard items
  can't drop them; a particle-1 harness row whose text names no shared stage, which counts as particle-1's own; and a
  gbrain tool error with no provider marker, which is gbrain's own failure and a fail for the reader whose row it is.
  Each harness row's cause is the one the runner wrote with it, else a named marker in its error text (memory-qa's
  `RERANKER_INACTIVE` refusal, whose hint is "make the reranker reachable", an embedding or retrieval failure, a judge
  error), else particle-1's own. memory-qa records a gbrain search or import failure as gbrain's own error, not a
  harness row, and the QA adapter turns it into a `search` tool error. That error's provider cause is the one the
  adapter wrote from the whole error text, else, for an error that isn't a refusal, a marker in its stored message: an
  HTTP 429 or 5xx status (`HTTP 503`, `status 429`, gbrain's `returned 503:`, the OpenAI SDK's `429 status code`) or
  a provider's wording for one (`Rate limit reached`, `rate limit exceeded`, `The server had an error`, `Too Many
  Requests`, `Internal Server Error`, `Bad Gateway`, `Service Unavailable`, `Gateway Timeout`). A retry-exhaustion
  message such as `Failed after 3 attempts. Last error: ...` counts through the error it quotes, so retries that ended
  on a dropped connection stay a fail. The cause is embedding when the text names embedding (`text-embedding-3-large`,
  `[embed(...)]`) and retrieval otherwise. Only the agreement check reads that cause: pass rates, flags and failure
  causes count the row as they did before. The report and `summary.json` count unpaired items by cause, per suite and
  for the verdict. Per suite the report
  shows raw agreement, Cohen's kappa (agreement beyond what the two pass rates give by chance) and particle-1's pass-rate
  gap to Opus. A suite counts toward the verdict with at least 20 paired items. particle-1 passes when the counted suites
  hold at least 40 items, no more than 10% of scheduled items are unpaired, the item-weighted mean of the counted suites'
  kappas is at least 0.6 and their raw agreement is at least 85%. Below those floors the verdict reads not measured, with
  the reason, and a scheduled suite with no paired item is listed with its reason. A night that ends on a budget stop
  (including Particle's 402) or loses its VM also reads not measured, because the items it never reached aren't
  particle-1's fails, and a suite that stopped before writing any row counts every item it planned as unpaired. The
  kappa of every suite's table pooled is shown for reference only, because pooling counts differences in difficulty
  between suites as agreement. The verdict decides whether particle-1 joins as a nightly reader.
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
| 5 | `NIGHTLY_HARNESS` | A suite failed to run, or recorded harness or provider failures other than cut-off answers. Those rows are counted apart. |

A refused paid run exits 2, and any other error exits 1.

```bash
bun eval/runner/nightly/run.ts --resume <night dir>
```

`--resume` reruns only what is missing or recorded as a harness failure, on the gbrain commit the night started on,
even if the ref has moved since. An answer cut off at its output limit stays as recorded, because memory-qa keeps it as
answered and the reader's cached reply would be cut off the same way, so it neither ends a night with exit 5 nor gets
rerun. The report still counts it as a harness row and flags a rise. A gbrain tool error isn't a harness failure
either, so a resume keeps it as recorded, and an item a provider's 429 or 5xx left unpaired stays unpaired in that
night's agreement check. A resume first settles the stopped run's open ledger reservations. Run it only after every
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

## Disclosures

Disclosure: Y Combinator, which Garry Tan runs, is an investor in Particle, which makes particle-1. The full list is in
[disclosures](disclosures.md).

## Changelog

### 2026-11-11: A replay of the request id a refusal names counts as a retry

Since gbrain v0.60.671.0, a write refused `worktree_refreshing` names the request id to replay it with, a new one when
the call sent none. The write scorer read a refused call's id only from the agent's own arguments, so a replay of the
named id counted as a resend under a new id, and `refused-write-agents` scored v0.60.671.0 at 2 of 90 trials where the
agent had replayed correctly in 88 of 88. Now a replay of the named id is a retry under the same id, as the
refresh-barrier preregistration's Amendment 7 records, and only a new id is a resend. The same trials score 90 of 90;
every row scored at an earlier gbrain commit keeps its score. `refresh-barrier-agents` and `refused-write-agents` share
the scorer, so both suites' digests changed and their first night under the new rule starts a new baseline.

### 2026-11-11: gbrain's provider failures no longer count against either reader

memory-qa records a gbrain search or embedding failure as gbrain's own error, which the QA adapter turns into a tool
error, not a harness row. So an embedding provider's 429 that hit only particle-1's search still counted as a particle-1
fail, although the entry below said embedding and retrieval failures leave the item unpaired; that held only for
harness rows. Now a gbrain tool error whose embedding or retrieval provider returned a 429 or 5xx leaves the item
unpaired with the embedding or retrieval cause, on Opus's row as well as particle-1's, and the report counts it with the
other unpaired causes. A gbrain tool error with no provider marker is still a fail for the reader whose row it is. A
resume keeps these rows as recorded, because they aren't harness failures, so such an item stays unpaired for that
night. Pass rates, flags and failure causes don't change.

### 2026-11-11: Shared-stage failures no longer count against particle-1

A particle-1 harness row used to count as a particle-1 fail whatever failed. Now only an error from particle-1's own
provider or call does. A failure in a stage both readers share (embedding, retrieval, rerank or the judge) leaves the
item unpaired with its cause named, and the report counts unpaired items by cause. A judge error on a particle-1 answer,
which counted as a fail, is now unpaired. Run-level stops still read not measured. The weekly failure-cause report now
shows each `reader_budget` row's first secondary cause per source.

### 2026-11-11: Two suite causes keep rows out of gbrain's failure counts

The QA readers get the top 5 sessions, so a question with 6 or more gold sessions can't get all its evidence to the
reader however well gbrain ranks. The weekly failure causes used to blame gbrain for those rows (wrong ranking, partial
evidence or a retrieval miss). They are now `reader_budget`, a suite cause kept out of gbrain's ranking, when the
week's sources list the suite's logs archive, whose memory-qa receipts record each reader's session count. BEAM items
where the cited gold sessions don't support the answer, by both support validators, or that cite no turn, and that a
reader given every gold session also failed, are now `item_unsupported` in the weekly failure causes. This report lists
their failed rows on one line and keeps them in its pass-rate and strong-flip flags.

### 2026-11-11: QA readers get 8,192 output tokens, and a cut-off answer is a harness row

The QA suites' reader output limit went from memory-qa's 1,024-token default to 8,192 tokens, set in the dev set as
`qa_max_tokens`, because at 1,024 most of Opus's BEAM failures were answers cut off before they finished. The change
gives `lme-s-hard` and `beam-1m-hard` new suite digests, so both start a new baseline. An answer cut off at its output
limit is now a harness row, on old nights' rows too, and every row records a finish reason, null where its suite records
none. A cut-off answer doesn't end a night with exit 5 or get rerun by a resume, which would only repeat it. The weekly
failure-cause output counts every harness row as a failure, even one its judge passed, as this report already did.

### 2026-11-10: A stricter particle-1 agreement verdict

The verdict now reads the item-weighted mean of per-suite kappas instead of the pooled kappa, which stays in the report
for reference. A suite counts with at least 20 paired items and the verdict needs 40, a particle-1 crash or harness
failure counts as a fail, and more than 10% of scheduled items unpaired reads as not measured, as does a night that ends
on a budget stop or loses its VM. A suite that stopped before writing rows counts its planned items as unpaired. A kappa
of exactly 0.6 now passes. GPT-6 Astra judges particle-1's QA answers as well as Claude's, qualified reader names such as
`particle:particle-1` match, and a night leaves particle-1 off the agent suites, whose runners refuse it. The page now
says the nightly tier plans no QA suite, so a particle-1 night there needs `--suites lme-s-hard,beam-1m-hard`.

### 2026-11-10: particle-1's agreement with Opus

Added the report section that scores particle-1 against claude-opus-5-5 on a night that runs both: raw agreement,
Cohen's kappa and the pass-rate gap per suite, and the pooled verdict. Added a Disclosures section for Particle.

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
