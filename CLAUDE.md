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
- `test/eval/`: the suite run by `bun run test`.
- `node_modules/gbrain`: the installed dependency, or a linked checkout.

The LongMemEval embedding cache is local and uncommitted. Its default location is under `eval/reports/longmemeval/embed-cache/`. A fresh clone has no warm cache. Never describe repeated API work as free unless the particular runner caches it.

## Shape of a benchmark report

Use the structure that makes the result easiest to assess. The default is:

1. **The finding.** State the useful conclusion, the tested configuration, the date and the main measurement. Distinguish a result we recommend from an experiment that remains inconclusive.
2. **The concrete case.** Show the sort of question or input involved, explain what the system has to do, and define unfamiliar terms. Clearly label invented examples.
3. **The experiment and results.** Describe the corpus, comparison arms, metric and sample size. Include the head-to-head table, relevant breakdowns and the settings that changed behavior. Explain what each important number means.
4. **What to use and what to avoid.** Connect the evidence to a workload. Report losses, errors, tuning, weak controls and incomplete measurements beside the claims they qualify.
5. **Reproduce and inspect.** Give repository-root commands, dependency and dataset identities, required keys, output paths and observed time/cost. Link the raw results and any charts.

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

The artifact manifest checks selected hashes and values; it does not verify every sentence in the docs. Review prose claims and links separately.

## Running and publishing work

Start with the smallest check that can catch a broken setup. Read the runner's flags before starting a paid run; there is no universal smoke or cost-limit flag. `BRAINBENCH_N` controls only runners that read it, and the LLM semaphore is not a global spending cap.

Use the task's authorized budget and scope. Preserve failed and partial measurements. Do not regenerate benchmark corpora as part of a documentation change or to obtain a better score.

For a new report:

1. Write down the question, comparison and decision rule before running.
2. Verify the scorer and a small setup run.
3. Run the agreed comparison with explicit configuration.
4. Save the raw output, resolved settings and code identities.
5. Write the report from the results, including unsuccessful candidates.
6. Run the relevant artifact, data and documentation checks.

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

A feature change should have evidence on the behavior it changes. A benchmark that stays flat can still provide a useful regression check. For changes outside the current task, record follow-up work rather than silently expanding scope.

## Comparisons and historical documents

Maintain the dated source list in [comparison-systems.md](docs/comparison-systems.md). Prefer published artifacts and primary sources. State when we recomputed another system's score rather than quoting its authors.

When a claim changes, keep the old result identifiable and explain the new evidence. Keep changelog dates, attribution, audit identifiers and unfinished work intact while making their descriptions easier to read.
