# gbrain-evals

You may remember who said something without remembering their words. Or remember
an idea without remembering who said it. Those are different retrieval problems.
[gbrain](https://github.com/garrytan/gbrain) combines word search, meaning-based
search, and relationships between pages to help an agent find what it needs.

This repository explains why gbrain is worth evaluating for agent memory and
personal knowledge applications. It contains the experiments, the data, and the
code behind that case. You can reproduce our results, compare another system,
or add the questions your application needs to answer.

**Start with [what we learned about retrieval](docs/retrieval-lessons.md).**
For a working configuration, read [the settings guide](docs/settings.md).
For datasets, methods, and every report, use [the documentation index](docs/README.md).

## Why put gbrain on your shortlist?

**It finds evidence across long conversations.** In the September 6 LongMemEval
run, gbrain found every labeled conversation needed for **449 of 470 answerable
questions, or 95.53%**, within five returned text chunks. A question can require
several conversations, so finding just one does not count. The answer model then
answered **433 of 500 questions correctly, or 86.6%**, including questions whose
correct response was to abstain. Those are separate measurements with separate
denominators. [Read the experiment](docs/benchmarks/2026-09-06-longmemeval-ranker-wave.md).

**It can find an idea described in different words.** On our held-out concept
questions, gbrain put an exact target first on **130/181 questions**, versus
**118/181** for vector search alone. That configuration used a reranker, which
reads candidate passages again with the question, and a rule limiting when page
metadata can affect rank. The extra model call helped the overall score, though
some questions got worse. [Compare all six configurations](docs/benchmarks/2026-09-09-retrieval-refresh.md#concept-search-order-meaning-and-popularity).

**It has a way to use relationships as evidence.** Suppose you ask who invested
in Acme. Searching for “Acme” finds pages that mention the company. Following an
“invested in” connection finds its investor. In our controlled production test,
enabling relationship retrieval raised first-place hits from **9/39 to 21/39**
on investor questions. The calls shared their index and query vectors. Attendance
questions did not improve because the fixture's link direction did not match
the parser's expectation. [Read the controlled comparison](docs/benchmarks/2026-09-09-retrieval-refresh.md#production-relationship-retrieval-one-switch).

**You can see what each setting buys you.** Returning fewer results saves reading,
but a question about two events may need two old conversations. On LongMemEval,
turning off the score-based trimming step raised complete retrieval from
**379/470 to 449/470**. Extra query rewrites, meanwhile, hurt retrieval at a
five-result limit. These experiments produced practical defaults:
[when to rerank, trim, expand, or favor a source](docs/settings.md).

**The system is inspectable.** gbrain keeps knowledge in Markdown files and builds
a database index for searching it. Its retrieval pipeline exposes configuration
and diagnostics. This suite keeps dated results and the records used to calculate
them. Hosted embedding and reranking services receive the text they process;
local storage does not make those API calls local. See the
[pinned gbrain implementation](https://github.com/garrytan/gbrain/tree/2efaaf8f8a817b5b82e023383618fdcdb1cc5f7d)
and [how to reproduce a run](eval/README.md).

## What should you learn here?

| Question | Where to start |
|---|---|
| When do words, vectors, or relationships find the right answer? | [Retrieval lessons](docs/retrieval-lessons.md) |
| Which configuration should I try? | [Settings by workload](docs/settings.md) |
| What changed after fixing the benchmark adapters? | [September retrieval refresh](docs/benchmarks/2026-09-09-retrieval-refresh.md) |
| How do retrieval scores differ from answer accuracy? | [What the scores mean](docs/retrieval-lessons.md#what-the-scores-mean) |
| How does gbrain compare with other memory systems? | [Comparisons and their protocols](docs/comparison-systems.md) |
| Can I reproduce a result or test my own system? | [Run the suite](eval/README.md), [contribute an adapter](eval/CONTRIBUTING.md) |

The useful question is which setup fits your questions. A copied phrase, a vague
recollection, and a relationship lookup exercise different parts of the system.
A good score on one is a reason to investigate that capability, not a promise
about every workload.

## Try a small experiment

Install [Bun](https://bun.sh/) and clone this repository:

```sh
git clone https://github.com/garrytan/gbrain-evals.git
cd gbrain-evals
bun install --frozen-lockfile

# No provider calls: rank the committed documents by matching words.
BRAINBENCH_N=1 bun eval/runner/multi-adapter.ts --adapter grep-only

# Check the committed corpus and question files.
bun eval/runner/validate-data.ts
bun run eval:query:validate
```

To compare all four existing adapters, set `OPENAI_API_KEY` in your environment:

```sh
BRAINBENCH_N=1 bun eval/runner/multi-adapter.ts --queries all
```

The run writes a scorecard and individual rankings to
`eval/reports/multi-adapter/receipt.json`. It uses the fictional corpus already in
the repository. The graph-template adapter only runs on the relationship questions
it understands. Vector and hybrid adapters make paid embedding calls; this runner
does not ship with a persistent warm embedding cache.

For the complete pinned configuration matrix, prerequisites, output paths, and
spending controls, follow the [refresh report](docs/benchmarks/2026-09-09-retrieval-refresh.md).
For a useful first evaluation of your own application, choose representative
questions and their relevant documents before comparing systems. The
[contributor guide](eval/CONTRIBUTING.md) explains the question and adapter formats.

## Memory has a write side too

Retrieval can only find information that was saved. Our
[transcript-distillation experiment](docs/benchmarks/2026-08-16-brainbench-cat35-transcript-distill.md)
measures how much useful material survives when an agent session becomes a memory
page. The recorded repair improved retention from **70.2% to 88.1%**, and all
20 sessions expected to produce pages did so. The same run measured **7.0% claim
hallucination**; human calibration of the judge remains unfinished. These results
help evaluate the write path without treating retention as correctness.

We also test [when memory should surface during a conversation](docs/benchmarks/2026-06-12-brainbench-memory.md),
source isolation, identities, dates, and other behaviors. The
[full index](docs/README.md) explains each benchmark in ordinary terms.

## Inspect or extend the work

- `eval/data/` contains public fixtures and answer keys. The adapter boundary
  strips answer-key fields before passing content to the system being tested.
- `eval/runner/` contains runners and the shared scoring functions.
- `eval/reports/` holds temporary output. Published records live beside their
  reports in `docs/benchmarks/`.
- `test/eval/` contains tests for the harness; `.github/workflows/ci.yml` runs the
  checks that do not require provider credentials.

This is gbrain's evaluation repository. External adapters and independently
written questions are welcome. The
[August audit](docs/audit/2026-08-31-eval-audit.md) explains earlier scoring and
harness errors; dated reports identify the results they affect. The
[receipt manifest](docs/receipts-manifest.json) maps published claims to saved
records and explicitly records missing evidence.

Code is MIT licensed. Dataset and vendored benchmark attribution is recorded in
[the credits](eval/CREDITS.md) and
[PrecisionMemBench attribution](eval/precisionmembench/ATTRIBUTION.md).
