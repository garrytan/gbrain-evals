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

## Where gbrain stands

gbrain's clearest comparative result is retrieval: finding every conversation a
question needs. On [LongMemEval](https://arxiv.org/abs/2410.10813)'s cleaned
small split, gbrain found all labeled evidence sessions for **449 of 470
answerable questions (95.53%)** in its first five returned chunks. That is
higher than every other system we can score on the same strict metric from
its saved per-question rankings.

| System | Strict `recall_all@5` | Where the number comes from |
|---|---|---|
| **gbrain v0.48.4.0**, `balanced` with Voyage reranker | **95.53% (449/470)** | our run, September 6 |
| gbrain v0.48.4.0, same without the reranker | 93.40% (439/470) | our run, September 6 |
| MemPalace hybrid v4 + LLM rerank | 90.0% (423/470) | our strict recount of their saved rankings |
| MemPalace hybrid v4, held-out subset | 88.7% (376/424) | our strict recount; different denominator |
| MemPalace raw (ChromaDB) | 85.7% (403/470) | our strict recount of their saved rankings |
| ContextFit + embedding fusion | 87.45% (411/470) All@5 | self-reported, their own harness |

A question counts only if every required session is found, so finding one of
two needed conversations earns nothing. Many published LongMemEval "R@5" scores
of 95% to 100% count a question as found when any one required session appears.
MemPalace's raw rankings find at least one required session for 454/470
questions (96.6%) but all of them for only 403/470 (85.7%). Three limits
apply. gbrain's five results are chunks, which can cover fewer than five
sessions, while MemPalace returns five whole sessions. The gbrain configuration
was chosen on these same 470 questions, with no held-out confirmation yet.
Embedders, chunking and ranking all differ, so this shows how the tested
pipelines compare, not why. Sources, dates and every row we could not match are
in [comparisons and their protocols](docs/comparison-systems.md).

**Answer accuracy is not yet a matched comparison.** gbrain's judged answers
were correct on 433 of 500 questions (86.6%) with a Sonnet 4.6 reader, and that
number is pending a re-run: the answer model could see session ids that mark
the labeled evidence. Published results for other systems range from 81.6% to
96.1%, each with its own reader, judge and prompts, and several are above
86.6%. We have not run gbrain with a matching reader, so we claim no ranking on
answers in either direction.

## Why put gbrain on your shortlist?

**It finds evidence across long conversations.** In the September 6 LongMemEval
run, gbrain found every labeled conversation needed for **449 of 470 answerable
questions, or 95.53%**, within five returned text chunks. The answer model then
read the full sessions behind those chunks and answered **433 of 500 questions
correctly, or 86.6%**, including questions whose correct response was to
abstain. Those are separate measurements with separate denominators. Two
caveats belong next to them. The release setting (autocut off) was chosen by
comparing arms on the same 470 questions, and the pre-registered target of at
least 92% answer accuracy was missed. On September 28 we also found that the
answer model saw the `answer_` prefix that LongMemEval puts on every labeled
evidence session id, so the 433/500 figure is pending a re-run with opaque ids.
A 30-question check found no effect of the prefix on retrieval.
[Read the experiment](docs/benchmarks/2026-09-06-longmemeval-ranker-wave.md).

**Keeping the conversations intact can help the answer model use them.** In a
separate September 24 matched reading study, asking Sonnet 4.6 to take brief
notes before answering raised judged correct answers from 308/361 to 324/361
on fixed retrieved sessions. Nine notes responses hit the output limit, and
manual review found grading artifacts. This measures answer reading, not a
retrieval gain. Both arms saw the same `answer_` session ids, so the
comparison is matched, but the result is pending a re-run with opaque ids. A
later reader release defaults to notes with a larger output limit; that new
default has only a selected-case completion check here, not a fresh accuracy
comparison. [Read the study](docs/benchmarks/2026-09-25-reading-notes.md).

**It can find an idea described in different words, with a reranker.** On our
held-out concept questions, gbrain with a reranker put an exact target first
on **130/181 questions**. A reranker reads candidate passages again together
with the question. Without it, gbrain scored 102/181, below vector search
alone at 118/181. We have not yet run vector search with the same reranker, so
the like-for-like comparison is 102 against 118 without reranking. The
reranker gained 37 questions and lost 9. For concept questions, test gbrain
with reranking and keep vector search as a serious alternative.
[Compare all six configurations](docs/benchmarks/2026-09-09-retrieval-refresh.md#concept-search-order-meaning-and-popularity).

**It has a way to use relationships as evidence.** Suppose you ask who invested
in Acme. Searching for “Acme” finds pages that mention the company. Following an
“invested in” connection finds its investor. In our controlled production test
over 145 relationship questions, enabling relationship retrieval raised
first-place hits from **14% to 24%** and recall at five from 0.663 to 0.724,
improving recall on 45 question runs and worsening none. The gain was
concentrated: investor questions rose from 9/39 to 21/39 first-place hits,
while attendance questions stayed at 0/50 because the fixture's link direction
did not match the parser's expectation. The calls shared their index and query
vectors. [Read the controlled comparison](docs/benchmarks/2026-09-09-retrieval-refresh.md#production-relationship-retrieval-one-switch).

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
local storage does not make those API calls local. The retrieval results above
were measured at gbrain [`2efaaf8f`](https://github.com/garrytan/gbrain/tree/2efaaf8f8a817b5b82e023383618fdcdb1cc5f7d)
(v0.48.4.0). This repository currently installs
[`939232f`](https://github.com/garrytan/gbrain/tree/939232f1746381b4e932d620d6c709e29198f14c)
(v0.55.0.0), whose search modes are identical. See
[how to reproduce a run](eval/README.md).

## What should you learn here?

| Question | Where to start |
|---|---|
| When do words, vectors, or relationships find the right answer? | [Retrieval lessons](docs/retrieval-lessons.md) |
| Which configuration should I try? | [Settings by workload](docs/settings.md) |
| What changed after fixing the benchmark adapters? | [September retrieval refresh](docs/benchmarks/2026-09-09-retrieval-refresh.md) |
| Does memory stay correct after edits, forgetting and restarts? | [Lifecycle experiment](docs/benchmarks/2026-09-29-lifecycle.md) |
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
page. The recorded repair improved judged retention from **70.2% to 88.1%**,
and all 20 sessions expected to produce pages did so. When a retained item must
also have its quoted evidence present in the page, the scores are **58.2% to
74.9%**. The same run measured **7.0% claim hallucination**. These are in-sample
results: the repair was developed on this same 24-transcript corpus, from a
single run, and human calibration of the judge remains unfinished. They help
evaluate the write path without treating retention as correctness.

We also test [when memory should surface during a conversation](docs/benchmarks/2026-06-12-brainbench-memory.md),
source isolation, identities, dates, and other behaviors. The
[full index](docs/README.md) explains each benchmark in ordinary terms.

## Corrections

On September 28, 2026 an audit found several published numbers that were
invalid or overstated. Each report keeps its original figures, labeled, beside
a dated correction:

- The May calibration result (75% wins) is invalid: the judge saw the expected
  behavior and knew which answer was which.
  [Report](docs/benchmarks/2026-05-18-brainbench-cat14-cat15-calibration.md).
- The April relationship precision at five was 39.2% to 44.7% on a lenient
  denominator; divided by five slots it is 29.9% to 35.4%, against a best
  possible 36.0%. The same report's undocumented alias recall falls from 31.0%
  to 13.75%, and its link type accuracy of 70.7% to 88.5% came from a lenient
  scorer; a strict re-run at the current pin gives 86.6% (240/277).
  [Report](docs/benchmarks/2026-04-18-brainbench-v1.md).
- The April and May relationship tables' `gbrain` row (49.1% precision at
  five) came from a regular-expression parser of the four question templates,
  now named `graph-oracle-parse`; it is not a product score.
  [Report](docs/benchmarks/2026-04-19-brainbench-multi-adapter.md).
- The Cat 35 88.1% is judge-only; evidence-verified retention is 74.9%.
  [Report](docs/benchmarks/2026-08-16-brainbench-cat35-transcript-distill.md).
- The May snapshot's Category 18b to 29 rows came from runners written before
  the August audit; Cat 29's +4.00 synthesis lift also scored the same
  single-answer call twice. [Report](docs/benchmarks/2026-05-23-v0.40.6.0-snapshot.md).
- The LongMemEval answer accuracy (433/500) and the reading-notes result
  (308/361 to 324/361) are pending re-runs because the answer model saw
  `answer_` session ids. Retrieval numbers are unaffected as far as a
  30-question check can tell.

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
