# Running the benchmarks without surprises

Use this guide when setting up a run or investigating a failure. For choosing a benchmark, start with [eval/README.md](README.md). Run the commands below from the repository root.

## Install the code being tested

```sh
bun install --frozen-lockfile
ls -ld node_modules/gbrain
```

The dependency is pinned to a GitHub commit in `package.json`. A symlink means a local checkout is linked instead. Record the actual loaded revision before comparing results.

If a `gbrain/*` import fails, check the installation and whether a stale local link points to an incompatible checkout. Use `bun link gbrain` only after registering the intended checkout with `bun link` in that checkout.

If PGLite reports a missing `pglite.wasm`, the dependency layout may lack the nested path gbrain expects. This repository's postinstall script creates that link. Re-run installation, or inspect and run `bun scripts/postinstall-pglite-link.ts`.

## Know which APIs the command calls

| Work | Keys or services |
|---|---|
| Query validation, receipt checks, keyword baseline, graph-template retrieval, type accuracy | No model API required |
| Vector and hybrid retrieval in the multi-adapter runner | `OPENAI_API_KEY` |
| LongMemEval retrieval | Key for the selected embedder; `ANTHROPIC_API_KEY` for generative expansion; `VOYAGE_API_KEY` for Voyage reranking |
| Cat14 calibration and Cat15 claim extraction | `ANTHROPIC_API_KEY`; their embedding setup is handled by the runner |
| Cat30–33 SkillOpt | `ANTHROPIC_API_KEY` |
| Cat34 memory conformance | No model API; the subprocess removes provider keys |
| Cat35 transcript distillation | `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` |
| Regenerating model-written corpora | Usually `ANTHROPIC_API_KEY`; read the particular generator first |

Set keys in your environment using your normal secret-management method. Do not put real keys in commands saved to reports.

A skipped adapter or incomplete receipt is not a measured pass. Some runners accept `--allow-skip` to acknowledge missing prerequisites, but the skip remains part of the result.

## Start with a narrow run

```sh
bun run eval:query:validate
bun eval/runner/validate-data.ts --quiet
BRAINBENCH_N=1 bun eval/runner/multi-adapter.ts --adapter grep-only --queries relational
```

For the full four-adapter relational comparison:

```sh
BRAINBENCH_N=1 bun eval/runner/multi-adapter.ts --queries relational
```

`BRAINBENCH_N` changes the number of runs in this scorer; its default is 5. It is not a universal repeat count for every category. The vector and hybrid adapters build fresh state per run, so repeated runs can repeat embedding work.

`bun run eval:brainbench` launches many different categories. The default is two subprocess slots. `BRAINBENCH_LLM_CONCURRENCY` limits participating judge calls within a process; it is not a global provider-call or spending limit. Read category-specific budgets before launching the sweep.

## Search returns no useful results

For a hybrid adapter, verify that ingestion created chunks and embeddings. Calling `engine.putPage` alone does not populate everything `hybridSearch` needs; the comparison adapter uses `importFromContent`.

For a graph comparison, inspect whether the question family is supported. The multi-adapter graph baseline recognizes specific relational templates. It does not provide a general natural-language graph parser.

For a configuration experiment, inspect the resolved settings and observed behavior in the receipt. A value echoed into configuration does not prove an unknown key affected search. Cat13's reranker and keyword-confidence checks add explicit observations for those features.

Keep a low score separate from a harness failure. A valid run in which gbrain misses the answer is useful evidence; a run whose adapter never initialized is not a clean comparison.

## LongMemEval takes longer or costs more than expected

The full dataset and embedding cache do not ship with the repository. Download the revision named in the report, and pass its path explicitly.

```sh
bun eval/runner/longmemeval.ts \
  --path ~/datasets/longmemeval/longmemeval_s.json \
  --top-k 5 --stratify 2 --adapters hybrid \
  --embedding-model openai:text-embedding-3-large --embedding-dims 1536
```

The small stratified sample checks setup; it is not the published full score. The runner's default top-k is 8, so five-result comparisons must specify 5.

The default cache directory is `eval/reports/longmemeval/embed-cache/`. Reuse only a cache for the matching model and dimensions. Warm embeddings remove repeated embedding charges, not expansion, reranking or answer-generation charges. Historical cold embedding cost was about $2; measure the present run instead of treating that as a cap.

Use the runner's `--ndjson` option for resumable per-question output. Preserve that stream as well as the aggregate if the result will be published. [Cache details](data/longmemeval/embed-cache/README.md).

## Cat35 refuses its cost preflight

The default `CAT35_HARD_STOP_USD` is $40. The historical full run projected $45 and required an explicitly chosen $50 cap, despite measuring about $6.20 in judge and fact-extraction costs.

This preflight is deliberately conservative. More importantly, the measured receipt excludes dream-subagent spend because the underlying phase API does not expose it. A receipt total is therefore not a complete invoice.

The default Cat35 command runs two transcripts as a paid setup check. `CAT35_FULL=1` selects the full corpus. Match the task's authorized budget before increasing a cap.

## Query validation fails

**A temporal question needs a date.** Set `as_of_date` to `"corpus-end"`, `"per-source"`, or a specific ISO date. If the question is not temporal, clarify its wording. The trigger rules live in `eval/runner/queries/validator.ts`.

**A slug has the wrong shape.** Use a lowercase `directory/page-name` identifier. Then verify that it names an actual page; syntax validation alone cannot establish that.

**An ID is repeated.** Give each question a unique ID. Built-in fuzzy questions use `q5-`, and externally authored placeholders use `q55-`. The scaffolder generates a `q-` identifier.

**An answer-only or abstention item is absent from the retrieval score.** The multi-adapter scorer excludes questions without document relevance labels and records those exclusions. They need a different scoring task.

## Tests hang or fail

```sh
bun run test
bun test test/eval/query-cli.test.ts test/eval/receipts-manifest.test.ts
```

The first command runs the repository suite. The second isolates inexpensive checks. Other useful focused tests include:

```sh
bun test eval/runner/queries/validator.test.ts
bun test eval/runner/adapters/grep-only.test.ts
bun test eval/runner/adapters/vector.test.ts
bun test eval/generators/world-html.test.ts
```

Those older colocated tests exist, but `bun run test` does not include them automatically.

At gbrain v0.46.3, PGLite teardown could freeze Bun's test runner in a synchronous WASM loop. That particular problem stopped reproducing at the v0.47.8.0 pin. If it recurs, use an external process timeout to isolate it; a frozen runtime may not service Bun's own timeout.

## Browse the fictional world

```sh
bun run eval:world:render
```

Open the generated `eval/data/world-v1/world.html` in a browser. `eval:world:view` also tries to open it automatically using the platform's desktop command. A cloud machine may have no desktop to open.

If the rendered page is stale, run the renderer again. Unexpected unescaped HTML should be reported with the fictional entity slug and the input that produced it.

## Preserve the experiment

The committed corpora are the shared test inputs. Model-backed regeneration changes their bytes and can change the answers. Do not delete or overwrite `world-v1/` merely to troubleshoot a runner.

For an intentional dataset revision, choose a new corpus version, update the generator/output location and labels together, and validate the new data. A seeded generator can choose the same cases while a model still writes different prose.

Save a worthwhile run under a dated path in `docs/benchmarks/`, including its raw results, settings and code identities. Default files under `eval/reports/` may be overwritten by the next run. The [artifact manifest](../docs/receipts-manifest.json) and its tests check selected saved results; they do not validate every documentation claim.

## Cat36 situation-aware recall and the all-category release gate

Cat36 asks whether generated situation cues help retrieve original evidence for indirect questions. The [2026-09-23 protocol](../docs/benchmarks/2026-09-23-situation-recall-protocol.md) defines the experiment, profiles, budgets, source-only construction boundary, and exact reproduction commands. It is not a published capability result. The declared candidate is `ca314d8af825308190cbe13dd08949d564a994a3` (v0.54.0.0), verified in a separate clean packaged install. Independent corpus relevance review, credentials, external budget enforcement, and complete live comparisons remain prerequisites.

Start keyless:

```sh
bun run eval:cat36:smoke
bun run eval:cat36
bun eval/runner/situation-recall-regression.ts inventory
```

The first command scores one development family's four probes; the second scores all 160 development probes. Both explicitly run offline keyword plumbing, with no live generation or embedding calls, and write nonpublishable receipts. The source corpus is still constructed in smoke mode. CI bounds the smoke subprocess to 180 seconds. The inventory command does not run benchmarks; exit 2 lists unresolved required prerequisites rather than a pass.

Cat36's default output is a new `eval/reports/cat36-associative-retrieval/<timestamp>-<pid>/` directory with `build.json`, `probes.ndjson`, and `receipt.json`. Choose another new directory with `--output`. Keep the build and per-probe evidence beside the receipt. An offline `verdict: pass` means the plumbing ran, not that situation cues improve retrieval. `all.ts` also runs only this explicitly labeled Cat36 offline smoke; its other categories retain their existing, potentially paid defaults.

The primary is `all_evidence_in_top5_chunks`, not page recall or answer accuracy. All required original source spans must occur in the five production chunks actually returned. The corpus has 120 families across five domains: 160 development and 320 holdout probes. Negative probes are excluded from positive recall means and receive separate cue false-fire accounting. Do not tune on holdout or treat unreviewed fixture labels as validated capability gold.

Live runs require an approved `Cat36Profile`, exact product SHA, a verified package-content hash for archive installs, matching baseline/candidate settings, configured provider credentials, and an externally enforced isolated budget covering every paid lane. Do not infer a spending cap from `BRAINBENCH_N`, concurrency, or a number written into a profile. After all prerequisites are ready:

```sh
bun eval/runner/cat36-associative-retrieval.ts \
  --profile /absolute/path/to/approved-profile.json \
  --output /absolute/path/to/new-run-output
```

Do not append `--profile` to `eval:cat36`, which explicitly selects offline mode. Missing public cue or real contextual-summary execution support blocks the corresponding live arm; a config echo or Cat26 title fallback cannot replace it. Separate source-only builds and fresh output/DB/config/HOME namespaces prevent candidate artifacts from leaking into B or C0. The live embedding cache is keyed by source/model/dimensions/construction identity and input side, with distinct construction-arm namespaces and observed hit/miss counts. A fresh clone has no warm cache; generation, reranking, judging, and cache misses can still repeat paid work.

### Grounded-answer replay is a separate secondary measurement

The [grounded-answer replay](runner/cat36-grounded-answers.ts) consumes the existing retrieval run's `receipt.json`, `build.json`, and `probes.ndjson`. It leaves them unchanged and sends the answer model only the frozen question and actually returned original excerpts. Gold evidence goes only to the judge. Exact source matching rejects cue prose and inaccessible content; a fluent answer cannot make up for missing required evidence.

Start with validation only, which makes no provider calls and writes no output:

```sh
bun eval/runner/cat36-grounded-answers.ts \
  --input /absolute/path/to/existing-C1-dev-output
bun test test/eval/cat36-grounded-answers.test.ts
```

After separately approving the answer and judge budgets and configuring their external enforcement, use a `GroundedProfile` rather than a retrieval `Cat36Profile`. It names both models and output-token limits, the exact product identity matching the retrieval build, and separate `answer_budget`/`judge_budget` approvals. The judge currently supports only `claude-haiku-4-5-20251001`; answer models use the public OpenAI, Anthropic, or Google gateway routes. The [protocol's grounded-answer section](../docs/benchmarks/2026-09-23-situation-recall-protocol.md#replay-grounded-answers-as-a-separate-secondary-check) lists every field and provider prerequisite.

```sh
bun eval/runner/cat36-grounded-answers.ts \
  --execute --input /absolute/path/to/existing-C1-dev-output \
  --profile /absolute/path/to/approved-grounded-profile.json \
  --output /absolute/path/to/new-grounded-output \
  --answer-max-usd "$APPROVED_ANSWER_MAX_USD" \
  --judge-max-usd "$APPROVED_JUDGE_MAX_USD"
```

The explicit amounts must equal the two approved profile caps. Neither these flags nor output-token limits enforce a local dollar budget. The driver verifies product bindings before stripping ambient state, then imports the gateway under fresh recorded HOME/config/XDG/database paths. Only the approved answer/judge credentials survive; other provider, source, and database settings do not. It restores the environment even after failures. Parallel replays need separate processes.

The new `cat36-grounded-answers` receipt and `answers.ndjson` preserve original answers, token usage, raw judge responses, retries, and failures. SUT failures are misses; judge failures are excluded and keep incomplete runs nonpublishable. Failed-call usage can be unknown, and the shared judge's dollar figure is an estimate, not a billing ledger. Offline injected runs remain plumbing-only. No grounded-answer score replaces the retrieval primary, and no live result is claimed here.

### Native operation conformance and release comparison

Native operation conformance is a separate keyless replay:

```sh
bun eval/runner/cat36-operation-conformance.ts --offline --smoke
```

It calls native `search`, `query`, and `recall`, retaining their raw responses instead of imposing the raw-five primary. Offline `query` disables expansion; live operation replay retains the native default. It checks explicit cue-prose fields, original chunk text, and source-policy serialization, not answer quality or every possible paraphrase. A missing required operation blocks before paid import. Use `--surfaces search,query` only for a clearly labeled subset diagnostic. Its separate output directory contains `build.json`, `operations.ndjson`, and `receipt.json`; all offline outputs remain nonpublishable.

The all-category comparator is stricter than the legacy `all.ts` report. It requires every registered cell, complete matched probe IDs and denominators, actual feature observations where applicable, native floors, correct loaded product identity, a publishable receipt, and successful child termination. Required unsupported categories remain blocked. Cats5/8/9 need real reviewed runtime catalogs; their templates and default native baseline-only verdicts are not full release evidence. Cat34's official keyless tests and its separately budgeted semantic-delivery profile remain distinct.

Compare only collected strict receipts against the preregistered run manifest:

```sh
bun eval/runner/situation-recall-regression.ts compare \
  /absolute/path/to/frozen-run-manifest.json \
  /absolute/path/to/collected-cell-results.json
```

Every category/slice must be non-worse, with zero allowed observed decline and no lost critical known-correct case. Cat36 also targets at least a 10-point indirect recall gain with a positive family-clustered interval. A broader retrieval claim additionally requires a preregistered, multiplicity-corrected gain on an existing opportunity benchmark. Incomplete, noisy, partial, or skipped results cannot promote the feature. Preserve them rather than changing the corpus, relaxing floors, or repeating until a favorable result appears.

For a smaller existing-retrieval development check, `situation-recall-cat13b.ts --profile <file> --output <new-dir>` validates a separate native gbrain-cohort pilot; add `--execute` only after explicit budget approval and verified external caps. It preserves the 30-query, 20-page source-swamp inputs and native five-page protocol, with `token_budget: 12000`. It is not full Cat13b release coverage and does not share Cat36's exact-span primary. See the protocol's [bounded pilot instructions](../docs/benchmarks/2026-09-23-situation-recall-protocol.md#a-bounded-existing-benchmark-pilot).

LongMemEval answer replay requires new retrieval artifacts collected with `--retain-evidence`; it will not fetch extra text to repair historical ID-only rows. `longmemeval-answers.ts --dataset <file> --rows <ndjson> --receipt <file> --adapter <name>` validates those inputs without providers. The separately approved live path uses hash-pinned models/data, fresh output and independent external answer/judge allowances. Its shared-judge grounding result is not the official LongMemEval answer-accuracy protocol; see the [replay contract](../docs/benchmarks/2026-09-23-situation-recall-protocol.md#retain-longmemeval-evidence-before-answer-replay).

For capture itself, `--retain-evidence` also requires a fresh `--ndjson <file>`, an explicit fresh `--output <file.json>` (and its derived Markdown path), and a fresh receipt path selected by `--reports-dir <dir>`. It does not resume into old artifacts. The protocol provides a complete capture command; do not merely append the flag to an old run command. Capture may make provider calls and requires its own authorization and enforced allowance.

`situation-recall-regression.ts collect <frozen-profile.json> <native-artifact.json>` normalizes retained observations for Cats2/4/6/18/18b/24/35. It explicitly returns `release_eligible: false`; it is not the paired release decision. `situation-recall-associative.ts --profile <json> --output <fresh-dir> [--corpus <dir>]` validates the separate development recipes by default. Its live path requires `--live --allow-paid`, exact recipe/corpus review and external cap admission. See the protocol's [native collection](../docs/benchmarks/2026-09-23-situation-recall-protocol.md#collect-retained-native-observations) and [associative replay](../docs/benchmarks/2026-09-23-situation-recall-protocol.md#exercise-separate-associative-development-recipes) contracts, including the blocked traversal and transport cases.
