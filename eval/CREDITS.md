# BrainBench credits

BrainBench combines project-authored tests, public benchmark material and comparison implementations. Attribution matters because a test written by a project's authors supplies different evidence from an independent submission.

## Project work

- **garrytan:** BrainBench v1 and v1.1 architecture, adapter interface, extraction work at v0.10.5, and the per-link-type accuracy runner.
- **Claude Opus 4.7:** pair programming, tests and documentation.

## Questions and adapters

There are no human external query contributors recorded here yet. The 50 built-in Tier 5.5 questions use `author: "synthetic-outsider-v1"`; they are AI-authored placeholders, not independent researcher submissions. See [CONTRIBUTING.md](CONTRIBUTING.md) to contribute a question batch.

The four current comparison adapters were implemented within this project:

| Adapter | Role |
|---|---|
| `gbrain` | The graph-based relational system under test |
| `vector-grep-rrf-fusion` | gbrain's hybrid search with graph traversal disabled |
| `grep-only` | BM25 keyword-ranking baseline |
| `vector` | Vector-similarity baseline using the same embedding model |

These are useful controls, but they are not third-party implementations submitted by competing vendors. External adapters should record their author and implementation assumptions here.

## Data and upstream work

The committed `eval/data/world-v1/` corpus contains 240 fictional entities. Claude Opus wrote the generated prose. Its historical one-time generation cost was approximately $3.14; that is a recorded cost, not a current regeneration quote.

The [PrecisionMemBench attribution](precisionmembench/ATTRIBUTION.md) names the upstream author, license, pinned revision and local adaptations. Other external benchmark sources are identified in their individual reports.

## Influences

**SWE-bench** helped establish the value of real comparison baselines. **MTEB** supplied a useful pattern for identifying models and versions in an experiment.

A **Codex** review challenged whether the early suite established anything beyond an internal test. That critique prompted the external-baseline work. The resulting controls make it easier for another engineer to decide what the evidence does and does not show.
