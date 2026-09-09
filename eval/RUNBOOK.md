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
