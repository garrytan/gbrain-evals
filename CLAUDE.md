# Working on gbrain-evals

This repository tests [gbrain](https://github.com/garrytan/gbrain), a memory system for agents. gbrain stores the original notes as Markdown and builds a database index for search and relationships. This repository contains the test data, comparison adapters, scoring code and published results.

The dependency in `package.json` pins the gbrain code under test. A local `bun link` overrides that installation. Record both the declared pin and the code actually loaded when they differ.

## Write for the engineer deciding whether to try gbrain

Explain why a feature could help, then show the evidence. A reader should understand the problem, the setting that changes the outcome, and the limits of the result without knowing our internal names.

Use ordinary words and concrete cases. “Find both conversations needed to compare two dates” explains more than “improve multi-session recall.” Define technical terms when they first matter. A graph is a set of stored relationships; a graph database is a way to store and query them. Do not treat a database choice as proof of better retrieval.

Be positively disposed toward the product and exact about the experiment. Show the cases where gbrain earns consideration. Explain failures as useful information about when and how to use it. Avoid claims such as “only system,” “best,” or “beats the field” unless the comparison actually establishes them.

Use short paragraphs, active verbs and plain English. No marketing slogans, em dashes or inflated vocabulary. Preserve useful technical names in code formatting so readers can find the implementation.

## Repository map

- `eval/runner/`: benchmark runners, scoring helpers and adapters.
- `eval/data/`: committed corpora and answer labels. Many Markdown files here are test inputs, including deliberately flawed skills.
- `eval/reports/`: temporary run output, ignored by Git.
- `docs/benchmarks/`: published explanations and the measurements supporting them.
- `docs/receipts-manifest.json`: artifact paths, hashes and selected expected values checked by tests.
- `test/eval/`: the main suite run by `bun run test`, which also runs the unit tests colocated under `eval/`, the Python orchestrator tests and the validators.
- `node_modules/gbrain`: the installed dependency, or a linked checkout.

The LongMemEval embedding cache is local and uncommitted. Its default location is under `eval/reports/longmemeval/embed-cache/`. A fresh clone has no warm cache. Never describe repeated API work as free unless the particular runner caches it.

## Shape of a top-level document

README.md, the hub pages in `docs/` (index, settings, retrieval lessons, comparisons) and the guides in `eval/` (README, CONTRIBUTING, CREDITS) have two parts:

1. **Current state, on top.** A first-time reader, human or agent, learns what gbrain does at the commit `package.json` pins, in present tense. Only [docs/gbrain-under-test.md](docs/gbrain-under-test.md#the-pin) names the pin's version and commit; every other page links there, so a re-pin changes one page. Give each number its gbrain commit. Replace a superseded claim instead of appending an "Update" or a dated amendment beside it.
2. **`## Changelog`, at the bottom.** Newest first, one `### YYYY-MM-DD: <what changed>` entry per change, linking the commit, saying what changed on that page (old value to new value) and why. History, superseded numbers and corrections to earlier wording live here, in dated reports and in CHANGELOG.md. A published number later found invalid or overstated is listed in [docs/corrections.md](docs/corrections.md), not in a current-state part.

README's current state has three parts, in this order: **what gbrain does** (capabilities in plain words), **current results** (one table, each number with its gbrain commit and report) and **how gbrain compares** with other systems, to the best we know. Put gbrain's best foot forward, exactly: lead with what it does well, keep each comparison on a matched metric, and list known limits after. Never add an "Update, <date>" block; fold a new result into the right table and record the change in the changelog.

When you change one of these documents, update the current state and add its changelog entry in the same commit.

## Shape of a benchmark report

Every report, finding file and investigation write-up opens with its takeaways. After them, use the structure that makes the result easiest to assess. The default is:

1. **Two or three takeaways, then the finding.** Open with 2 or 3 plain bullets, each in the form "We learned X. You should do X." What works comes first: where gbrain, gstack or our harness help, and why that matters to someone building agents. What didn't work comes second, stated plainly and never buried. When the main result is a null, lead with the useful lesson the data supports, with its number (for example "you don't need X; plain Opus already does Y"), and state the null right after it. Then give the tested configuration, the date and the main measurement, and say whether the result is one we recommend or an experiment that remains inconclusive. Our own mechanics (issue codes, ledger paths, gate details) go at the end of the report or in the pull request's closing Agent notes section.
2. **The concrete case.** Show the sort of question or input involved, explain what the system has to do, and define unfamiliar terms. Clearly label invented examples.
3. **The experiment and results.** Describe the corpus, comparison arms, metric and sample size. Include the head-to-head table, relevant breakdowns and the settings that changed behavior. Explain what each important number means.
4. **What to use and what to avoid.** Connect the evidence to a workload. Report losses, errors, tuning, weak controls and incomplete measurements beside the claims they qualify.
5. **Reproduce and inspect.** Give repository-root commands, dependency and dataset identities, required keys, output paths and observed run time. Link the raw results and any charts.

The takeaways change the order, not the evidence. The preregistered primary result is always one of the bullets, with its interval, and a secondary or exploratory result is labeled as such and shows its interval. A null is not proof that two setups are equal: unless a preregistered margin shows they are, call it no measurable difference at that sample size. No number is rounded in our favor, no caveat is dropped, and disclosures follow [docs/disclosures.md](docs/disclosures.md), both where the lines go (a finding file keeps them in its closing Disclosures section) and what a result favoring a disclosed company must also show.

Don't publish what a finding cost. Show a cost only where it is part of the lesson, such as cost per correct answer between two setups or a per-task price the design depends on. Program totals, budgets, caps and spend stay out of public docs (CHANGELOG.md included), commit messages and pull request bodies; they belong in the tracking issue and private notes. This covers what we write; raw receipts and ledger files keep the fields they recorded, as the evidence rules below require.

A report must make sense on its own. Introduce gbrain and any external benchmark briefly, with links to their primary sources. Explain each compared adapter in terms of what it does, the feature it exercises, and the practical reason to test it.

Use tables and charts when they improve understanding. Keep original charts with historical results. New charts must come from identified measurements; do not redraw an old chart to imply a new run.

## Evidence rules

- **Do not rewrite the experiment.** Preserve benchmark inputs, model-produced output, raw receipts, frozen prompt text, labels, dates and historical measurements. Rewrite the explanation around them.
- **Name the denominator.** Recall of all required sessions, recall of any required session, document recall, precision and answer accuracy answer different questions. Never combine them under one “accuracy” number.
- **Compare matching conditions.** Identify dataset revision, top-k, configuration, model, dimensions, version and any tuning. Different metrics or datasets may provide context but do not establish a ranking.
- **Separate control from capability.** Hash embeddings and scripted models can prove the harness works. Their scores cannot prove real search or model quality.
- **Treat errors explicitly.** Follow the runner's accounting rules. A missing key or a partial run is not a passing full benchmark. Never hide a failed adapter from the results.
- **Keep provenance.** Copy worthwhile receipts out of `eval/reports/` before a later run overwrites them. Include per-question results when available.
- **Disclose missing evidence.** A historical table without raw results stays historical. New measurements belong beside it, with their own date and code identity.
- **Protect private data.** Public examples use the fictional corpora or generic placeholders. Do not publish real personal notes, names or secrets.
- **Plan the eval loop before spending.** Every preregistration registered on or after 2026-11-19 follows the team's eval-loop practices page (`software-factory/evals/eval-loop-practices.md` in the team drive), and `bun eval/runner/prereg.ts` refuses its registry entry in CI unless it carries them as fields ([PREREGISTRATION-TEMPLATE.md](docs/benchmarks/PREREGISTRATION-TEMPLATE.md#registry-entry) has the shape): the `decision` each outcome changes, a pilot per arm in `pilots` on at most a tenth of that arm's budget showing the part under test ran, the judge passes and the units can be supplied, a `judge_check` (at least 40 labelled outputs, kappa of at least 0.6, a judge from another model family, errors read per arm) or the reason there is no model judge, and an `interim_look` at half the units with O'Brien-Fleming bounds at the plan's own alpha and a futility stop when `paid_tier` is `over-500`. A quick look (`paid_tier: "quick-look"`) carries only its question, decision and stop rule, and publishes no number. The results page the entry names carries one `Settled call:` line, the ship-or-kill call the result settled or `none`, and never its cost, which goes to the private ledger. Any Markdown file under `docs/` whose name contains `prereg` or ends in `-protocol.md` counts as a preregistration and needs a registry entry. Entries and preregistration files older than the check are listed in [preregistrations-grandfathered.json](docs/benchmarks/preregistrations-grandfathered.json) and keep their rules; CI refuses any name on that list that wasn't in the repository when the list was first committed.

The artifact manifest checks selected hashes and values; it does not verify every sentence in the docs. Review prose claims and links separately.

## Running and publishing work

Start with the smallest check that can catch a broken setup. Read the runner's flags before starting a paid run; there is no universal smoke or cost-limit flag. `BRAINBENCH_N` controls only runners that read it, and the LLM semaphore is not a global spending cap.

Use the task's authorized budget and scope. Preserve failed and partial measurements. Do not regenerate benchmark corpora as part of a documentation change or to obtain a better score.

For a new report:

1. Write down the question, the public lesson it is after, the comparison and the decision rule before running.
2. Verify the scorer and a small setup run.
3. Run the agreed comparison with explicit configuration.
4. Save the raw output, resolved settings and code identities.
5. Write the report from the results, including unsuccessful candidates.
6. Run the relevant artifact, data and documentation checks.

### Test lanes and CI

CI is the one full test run. `.gstack/pregate.json` maps these exact /ship lane commands in `ship_lanes_from`: `bun run test`, `TEST_SHARDS=1 bun run test`, `TEST_SHARDS=2 bun run test`, `bun run test:unit` and `bun run test:py`. Once CI has passed at the branch's exact, clean tree, /ship takes that run as the lane's result (`LANE: <label> carried run=<id>/<attempt>`) instead of running the suite again, and the pregate's tests stage does the same for the test files it selects (`CI_CARRY: accepted`). Both read the record that CI's `tested-tree` job writes with `scripts/ci-tested-tree.ts`, which names the tree the run tested and every test file it ran. On a machine with fewer than 8 cores, such as a Capy cloud machine, the pregate runs no tests locally: `.gstack/pregate.json` declares a `remote_gate` and the CI runs that clear it (`remote_gate_runs`), so the tests stage waits for CI's verified run at the exact tree and clears from it (`CI_CARRY: cleared pregate.json/remote_gate`). The `remote_gate` command itself only says so and fails, because this repository has no other remote test machine.

Pass the full suite to /ship as `--lane test='bun run test'` and push early, so CI runs beside the review. A pull-request run tests GitHub's merge of the branch into main, so it carries only while the branch contains main's tip. Any other lane command, the typecheck included, runs on your machine. The `tested-tree` job fails when a test file under `test/eval/` or `eval/` registers no tests, because Bun's report leaves the file out and no lane could carry; give it at least one test (a skipped one counts). The record also lists the harness Python tests under `eval/harness-provider/tests/` from the JUnit report of CI's `harness (pytest)` job, so a pull request that adds or changes one can carry, and it fails when a tracked `test_*.py` there collects no tests. No lane command runs those files, so no lane's inventory lists them; the pregate requires the ones a change touches.

CI splits the Bun suite into six shard jobs, each with a 15-minute limit, by the per-file times in `test/timings.json`. Bun shards whole files, so one slow file can't be split, and a file the timings don't list counts as a median file. When you add a test file that takes more than a minute, or a shard job nears 10 minutes, refresh the timings from a CI run's `tested-files-*` reports with `bun scripts/test-timings.ts` (its header has the commands).

### Versions and the changelog

A pull request never edits `VERSION`, the `version` in `package.json` or a released section of CHANGELOG.md. It adds its changelog entry as `changelog.d/<branch-slug>.md`: the entry text only, with no `## [x]` heading, opened with `bump: minor` or `bump: major` front matter only when the change warrants more than a patch. [changelog.d/README.md](changelog.d/README.md) has the format, and /ship writes the file in its changelog step. Write a fragment's links from the repository root, as in CHANGELOG.md, because the release copies its text into CHANGELOG.md unchanged and `scripts/check-links.py` checks fragment links from the root. `.gstack/ship-policy.json` sets `merge: direct`, `changelog_fragments`, `bump: patch` and `land.merged_checks`.

Each pull request merges at its own green head. After /ship writes its receipt, run `gstack-ship-queue ready --pr <n> --no-screen` at that head; the merge is then `gstack-ship-queue land --pr <n> --pin <sha> --allow-repo-commands`, which merges that exact commit or nothing. When main has moved past the pull request's merge base, land builds the pin merged onto main's tip in a throwaway worktree and runs the policy's `land.merged_checks` there: `bun run validate` and `bun eval/runner/prereg.ts`, which took 3.4 minutes together in one timed run, and land stops either one at 15 minutes. Run land as a background command or with a timeout of at least 40 minutes, because a land that is killed partway leaves the land lock held, and every other land refuses with `QUEUE_LAND_LOCKED` until the same land command runs again. Land compares the merged tree's `bun.lock` and `package.json` dependencies with those of the checkout it runs from, so run it from a checkout at main's `bun.lock` with `bun install` done. It merges only when both checks pass, so a branch that is behind main doesn't have to merge main and rerun CI before it lands, unless it changes dependencies. It refuses with `QUEUE_LAND_MERGED_CHECKS` when a check fails, `QUEUE_LAND_NOT_CLEAN` on a conflict, or `QUEUE_NOT_READY` when the dependencies differ; then merge main into the branch, fix what the refusal names, and ship and report the new head. The checks are repo commands, so land runs them only with `--allow-repo-commands` and never under `--dry-run`. They don't run the unit suite or the typecheck, so CI, which runs on every push to main, stays the full check of what landed. A results pull request whose counted runs ran from commits on its own branch still merges by hand as a merge commit, so those commits stay in main's history, and it carries a fragment like any other.

A release follows each merge, and the agent whose pull request just merged cuts it. A release pull request needs no /ship receipt and no `ready` record, because land checks that its head is exactly the release stamp of its merge base.

1. **Stamp and push the release branch.** From a checkout of this repository, preview with `gstack-release-stamp open --base main --dry-run`, which pushes nothing, then run it with `gh` switched off, so it stops after the push:

   ```sh
   nogh=$(mktemp -d) && printf '#!/bin/sh\necho "gh is switched off" >&2\nexit 1\n' > "$nogh/gh" && chmod +x "$nogh/gh"
   PATH="$nogh:$PATH" gstack-release-stamp open --base main
   ```

   It stamps origin/main in a throwaway worktree (the next patch version in `VERSION` and `package.json`, and every fragment folded into one CHANGELOG.md section with the files deleted), pushes that commit to `release/<version>` and prints `PUSHED: release/<version> <sha>`. It then stops with `RELEASE_STAMP_INVALID` and "`release/<version>` is pushed, so open its PR by hand". That stop is expected, because the tool opens its pull request with `gh pr create` and has no option to skip that step. When changelog.d on main holds no fragment, the preview and the run stop with `RELEASE_STAMP_EMPTY` instead, because there is nothing to release.
2. **Open the pull request without `gh`.** Use your platform's pull-request tool; on Capy that is `tools.pr.create` with `head: "release/<version>"`, the title `Release v<version>` and a body with one plain line per change, with its pull request, taken from the folded CHANGELOG.md section. Never edit the release branch.
3. **Report it ready.** When every required check is green at `<sha>` and the pull request's head is still `<sha>`, report it ready to merge with `<sha>` as the pin.
4. **Merge.** The maintainer merges it with `gstack-ship-queue land --pr <n> --pin <sha>`. If another pull request landed after the stamp, land refuses with `RELEASE_STAMP_INVALID`; run step 1 again, which replaces the branch and updates the same pull request, and report the new sha.

### Choose the gbrain build

Every new run, development or counted, measures gbrain's newest release at the moment it starts (Garry, 2026-11-16:
"We don't care about old Gbrain builds. We care about newest always!"). The newest release is the highest version tag
merged into gbrain's master (`git ls-remote --tags https://github.com/garrytan/gbrain.git` lists the tags). It is not
the weekly `stable` tag, the `latest-stable` alias or this repository's `package.json` pin when that lags.

- **Move the pin to it.** `bun eval/runner/gbrain-pin.ts bump` moves `gbrain` in `package.json` and `bun.lock` to the
  newest release, rewrites the pin line of [docs/gbrain-under-test.md](docs/gbrain-under-test.md#the-pin), the one
  page that names the pin, with a changelog entry there, writes a `changelog.d` fragment, and prints the commit range
  and gbrain's changelog in between; it exits 2 when that release is already pinned. Read the printed changelog for
  changes that break the harness, and describe a new capability on that page by hand when it matters. Results
  measured at older commits keep naming their commit, and a re-pin changes no published number.
- **A preregistration names "newest release at launch".** If a newer release lands before the experiment's first
  counted gbrain run, re-pin in a dated amendment committed before that run.
- **The build freezes once counted gbrain runs start,** so the experiment's numbers stay tied to one commit, which
  the results record. A results branch keeps that pin when it merges main: resolve `package.json` and `bun.lock` to
  it until its counted runs finish, then take main's pin at the last main merge, so main never moves back.
- **Run an older build only when the question is about that build,** such as a regression bisect or a
  stable-versus-master check, and say so. The nightly check keeps `stable` only as master's regression reference.
  `gbrain-cues` and `gbrain-reader` are frozen pins of the experiments that name them
  ([eval/runner/pins.ts](eval/runner/pins.ts)); new work uses `gbrain`.

### Choose models

gbrain and gstack are built for frontier models, so every model-comparison run (Cat 40 Model Ladder, answer-model
benchmarks and any paid agent-task eval) tests them on the newest frontier Opus and GPT, today `claude-opus-5-5` and
`gpt-6.2-sol`, plus `particle-1` as the primary low-cost model. These rules follow the gbrain project rule of
2026-10-07, Garry's decision of 2026-10-31 that `claude-opus-5-5` and `particle-1` are the primary models, and his
rule of 2026-11-01 that evals test gbrain and gstack on frontier models.

- **Run the primary models: `claude-opus-5-5` and the newest Particle model, today `particle-1` (Garry, 2026-10-31).**
  Every model-comparison run includes both as readers or agents, and its first table shows both with cost per correct
  answer. A campaign already preregistered adds particle-1 at its next amendment. particle-1 is Particle AI's low-cost
  model, called as `particle:particle-1` through `https://api.particle.ai/v1` with `PARTICLE_API_KEY` (Chat Completions
  only; responses name it `particle-ai/particle-1`). Send `reasoning_effort` explicitly (counted cells use `high`, its
  default, unless the campaign fixes one effort for every reader) and an output limit with room for reasoning; the
  receipt records the effort sent and effective, the limit and the weight version. A runner with no `particle:` route
  lists particle-1 under `models_not_run` with the reason. First paired numbers:
  [particle replay](docs/benchmarks/2026-11-01-longmemeval-particle-replay/REPORT.md).
- **Always run the newest frontier Opus and GPT.** Today's counted frontier readers are `claude-opus-5-5` and
  `gpt-6.2-sol`. The runner's code still names `gpt-6.1-sol` (`FRONTIER_READERS` in `eval/runner/systems/baselines.ts`,
  which the workload sweep's model check requires) and the ledger has no `gpt-6.2-sol` price yet, so the first run on
  `gpt-6.2-sol` registers its price and moves `FRONTIER_READERS` in its own change. Before a run, check which models
  are newest (`bun scripts/model-freshness.ts` reads the providers' model lists, Particle's included) and add any that
  the run doesn't already include. Register a price for a new model in `eval/runner/budget-ledger.ts` so the ledger can
  reserve it.
- **particle-1 never judges a counted cell.** Counted judges stay protocol-matched (for example `gpt-4o-2024-08-06` for
  LongMemEval and `gpt-6.1-sol` for Cat 40 Hard). particle-1 becomes the default reader and agent for a development loop
  once it passes that loop's preregistered agreement test; development judges are the ones the dataset's harness fixes,
  else `gpt-6.2-sol`.
- **Sonnet and Haiku are not models under test (Garry, 2026-11-01).** A comparison run no longer needs them. Never run
  one as an agent, reader, answer model, optimizer or optimization target, never use one as a stand-in for a frontier
  model, and never spend a run on transfer between them. The exception is a run that asks a question about that tier
  and says so in its preregistration or brief.
- **Judges are separate from the models under test.** A protocol's judge stays. Where the protocol leaves the judge
  open, a cheaper judge is fine, Sonnet and Haiku included, as long as no model judges its own family's rows: a Claude
  judge never grades a Claude model's answers, and a GPT judge never grades a GPT model's.
- **Fable is for smoke tests only (Garry, 2026-10-07).** Opus 5.5 is the top Anthropic model in counted runs. Run
  Fable only in small smoke tests (for example a pre-merge agent smoke), never in paid counted cells, practice
  rounds or held-out runs. A run already preregistered with Fable records the change and its reason in the
  preregistration before any new cell runs.
- **Do not run older generations** (for example Sonnet 4.6 next to Sonnet 5.5, GPT-5.x next to GPT-6.x, Haiku 4.5,
  older Opus). The one exception is a single older model that is the only shared link to the previous eval's
  results. If a model that appears in both runs already gives that link, add no older model. `gpt-4.1-mini` runs
  only under this exception, as the bridge to earlier BEAM runs.
- **Do not run gpt-5.4-mini.** Never base a product change, gate or release decision on a gpt-5.4-mini-only finding.
- **Report the models people use first** after the primary models' first table. A reader-matched comparison with a
  published system keeps that system's reader. Note a ceiling (a model at 100% on every arm cannot show a difference)
  rather than counting it as a win or a tie.
- **Preregistered gates keep their model list.** To change the models of an existing preregistered gate, record the
  change and its reason in the preregistration before any new cell runs. A preregistered program that names Sonnet or
  Haiku as a model under test makes that change before its next run: Opus 5.5, GPT-6.2 Sol and, where the runner has a
  route, particle-1.
- **Defaults follow the same rules.** A live category's default models are current-generation models, and its default
  models under test are frontier models, never Sonnet or Haiku. `test/eval/model-defaults.test.ts` holds both, for
  single defaults and for comparison sets. A default that keeps an older model, or a Sonnet or Haiku model under test,
  on purpose (a frozen protocol, a mirror of gbrain's own default, or a dated move that waits on named follow-up work)
  is a named exception with its reason in `eval/runner/model-defaults.ts`. Changing a default is a new receipt
  identity: never pool its results with the old model's.

To add a category, follow the "Add a category" checklist in [eval/CONTRIBUTING.md](eval/CONTRIBUTING.md): registry row and preregistered promotion rules first, the shared hermetic environment, the paid-arm guard, the scorer mutation kit and the bug ledger.

Follow the current task's branch and review instructions. This guide does not authorize pushing, merging or publishing.

## Match a change to a useful test

| Change | Relevant experiment |
|---|---|
| Source ranking or bulk chat dominating notes | Cat13b source swamp |
| Retrieval, expansion, reranking or answer generation over conversations | LongMemEval |
| Conceptual search and paraphrases | Cat13 |
| Relationship ranking | Relational queries and graph-specific controls |
| Source separation | Source-isolation and multi-source tests |
| Transcript ingestion, fact extraction or synthesis | Cat35 |
| Automatic memory injection and continuity | Cat34 |
| A shipped skill (`query`, `briefing`, `fact-check`) or SkillOpt itself | None measures the effect: the SkillOpt optimizer benchmark is retired because frontier models saturate its task sets ([finding](docs/benchmarks/2026-11-03-skillopt-retired.md)), and Cats 30 to 33 are deprecated, because gbrain's iterative loop is to be removed on or after 2026-12-03. `bun eval/runner/n15-skillopt-method.ts` keyless still checks the frozen task sets |

A feature change should have evidence on the behavior it changes. A benchmark that stays flat can still provide a useful regression check. For changes outside the current task, record follow-up work rather than silently expanding scope.

## Comparisons and historical documents

Maintain the dated source list in [comparison-systems.md](docs/comparison-systems.md). Prefer published artifacts and primary sources. State when we recomputed another system's score rather than quoting its authors.

When a claim changes, keep the old result identifiable and explain the new evidence. Keep changelog dates, attribution, audit identifiers and unfinished work intact while making their descriptions easier to read.
