# Learn, evaluate, and extend gbrain

Start with [the case for gbrain](../README.md), then follow the route that fits
what you are trying to do.

| Your question | Read this |
|---|---|
| How do words, vectors, and relationships work together? | [Retrieval lessons](retrieval-lessons.md) |
| Which setup should I evaluate for my application? | [Settings by workload](settings.md) |
| What do the latest controlled comparisons show? | [September 9 retrieval refresh](benchmarks/2026-09-09-retrieval-refresh.md) |
| How do I run the benchmarks? | [Evaluation guide](../eval/README.md), [troubleshooting](../eval/RUNBOOK.md) |
| How can I contribute a competing system or new questions? | [Contributor guide](../eval/CONTRIBUTING.md) |
| Which outside scores are actually comparable? | [Cross-system comparison](comparison-systems.md) |

## Retrieval experiments

A report's date identifies an experiment, not necessarily the newest version of
its narrative. Start with the current reports, then follow the historical work
when you want to understand how a decision changed.

| Engineering question | Report |
|---|---|
| How do the corrected baselines, relationship switch, source preference, and return caps behave? | [September 9 refresh](benchmarks/2026-09-09-retrieval-refresh.md) |
| What improved conversation retrieval, and which proposed fixes failed? | [September 6 ranking experiments](benchmarks/2026-09-06-longmemeval-ranker-wave.md) |
| Can a system retrieve every conversation needed to answer a question? | [LongMemEval history and rescoring](benchmarks/2026-05-07-longmemeval-s.md) |
| How does limiting returned facts change precision and recall? | [PrecisionMemBench](benchmarks/2026-05-29-precisionmembench.md) |
| Can curated notes stay visible among longer imported chats? | [Source-swamp experiment](benchmarks/2026-04-25-brainbench-cat13b-source-swamp.md) |
| Can search find concepts described in different words? | [Original concept experiment](benchmarks/2026-04-23-brainbench-cat13-conceptual.md) |
| How did the specialized relationship adapter compare with search baselines? | [April four-adapter comparison](benchmarks/2026-04-19-brainbench-multi-adapter.md) |
| What did the original graph extraction change? | [BrainBench v1](benchmarks/2026-04-18-brainbench-v1.md) |
| How did subsequent gbrain versions behave on those earlier tests? | [v0.11 versus v0.12](benchmarks/2026-04-19-brainbench-v0_11-vs-v0_12.md), [v0.13](benchmarks/2026-04-19-knowledge-runtime-v0.13.md), [v0.20](benchmarks/2026-04-23-brainbench-v0.20.0.md), [v0.40 snapshot](benchmarks/2026-05-23-v0.40.6.0-snapshot.md) |

Earlier scorecards sometimes use a corrected-later harness or lack their raw
output. Those reports explain the limitation. In particular, the historical
relationship table compares several differences between adapters; its precision
gap does not isolate the effect of a graph alone.

## Saving, using, and improving memory

| Engineering question | Report |
|---|---|
| Does important material from a working session survive into saved pages? | [Transcript distillation](benchmarks/2026-08-16-brainbench-cat35-transcript-distill.md) |
| Does useful memory arrive at the right moment in a conversation? | [Memory conformance](benchmarks/2026-06-12-brainbench-memory.md) |
| Can a skill improve on held-out tasks, and can the judge detect cheating? | [Skill optimization](benchmarks/2026-06-03-skillopt.md) |
| Can the system distinguish kinds of claims and sensible confidence? | [Calibration and proposed takes](benchmarks/2026-05-18-brainbench-cat14-cat15-calibration.md) |
| What happens when tweet ingestion becomes parallel? | [Tweet ingestion](benchmarks/2026-04-18-tweet-ingestion.md) |
| What did the earlier ingestion worker comparisons measure? | [Subagent comparison](benchmarks/2026-04-18-minions-vs-openclaw-subagents.md), [production comparison](benchmarks/2026-04-18-minions-vs-openclaw-production.md) |

## Data and methods

A **corpus** is the material being searched. **Ground truth**, sometimes called
“gold,” is the answer key used to score a result. **Qrels** are relevance judgments:
a mapping from a question to the documents considered relevant.

- [Evaluation overview](../eval/README.md): corpus choices, adapter identifiers,
  metric definitions, and commands.
- [Relevance judgments](../qrels/README.md) and [baselines](../baselines/README.md):
  stored expectations and regression checks.
- [Source-swamp fixture](../eval/data/source-swamp-v1/_README.md),
  [multimodal fixture](../eval/data/multimodal/README.md),
  [calibration fixture](../eval/data/cat14-calibration/README.md), and
  [claim-extraction fixture](../eval/data/cat15-propose-takes/README.md).
- [LongMemEval cache](../eval/data/longmemeval/embed-cache/README.md): what the cache
  contains and what does not ship with a clone.
- [External question authors](../eval/external-authors/README.md): submitting new
  questions and understanding the existing synthetic questions.
- [Credits](../eval/CREDITS.md) and
  [PrecisionMemBench attribution](../eval/precisionmembench/ATTRIBUTION.md).

## Checking the evidence

The [receipt manifest](receipts-manifest.json) maps claims to raw results and
records missing evidence explicitly. A **receipt** is a machine-readable record
of what ran, under which configuration, and what it measured. A report explains
that record; the two should agree.

The [September 6 evidence guide](benchmarks/2026-09-06-longmemeval-ranker-wave/longmemeval/README.md)
explains the saved LongMemEval files and what their compacted records retain.

The [August audit](audit/2026-08-31-eval-audit.md) describes earlier problems in
scoring and execution. [Open work](../TODOS.md) distinguishes unfinished
experiments from completed fixes. [The changelog](../CHANGELOG.md) records changes
to this repository, separately from the gbrain dependency's version.

Maintainers can use the [Cat13 experiment recipe](../eval/runner/README-cat13-phase-e0.md)
and [repository writing guide](../CLAUDE.md). The
[older provider shootout runbook](../scripts/RUNBOOK_SHOOTOUT.md) is an archival
procedure with documented missing pieces; it is not the current refresh command.
