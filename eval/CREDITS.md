# BrainBench credits

BrainBench combines project-authored tests, public benchmark material and comparison implementations. Attribution matters because a test written by a project's authors supplies different evidence from an independent submission. Everything above [Changelog](#changelog) is current as of gbrain-evals v0.10.22.

## Project work

- **garrytan:** BrainBench v1 and v1.1 architecture, adapter interface, extraction work at v0.10.5, and the per-link-type accuracy runner.
- **Claude Opus 4.7:** pair programming, tests and documentation.

## Questions and adapters

There are no human external query contributors recorded here yet. The 50 built-in Tier 5.5 questions use `author: "synthetic-outsider-v1"`; they are AI-authored placeholders, not independent researcher submissions. See [CONTRIBUTING.md](CONTRIBUTING.md) to contribute a question batch.

The retrieval adapters were implemented within this project:

| Adapter | Role |
|---|---|
| `gbrain` | The product under test: gbrain's hybrid search with relationship retrieval on |
| `vector-grep-rrf-fusion` | gbrain's hybrid search with graph traversal disabled |
| `grep-only` | BM25 keyword-ranking baseline |
| `vector` | Vector-similarity baseline using the same embedding model |
| `graph-oracle-parse` | Upper-bound control that parses the four generator question templates; not a product score |

These are useful controls, but they are not third-party implementations submitted by competing vendors. External adapters should record their author and implementation assumptions here.

## Data and upstream work

The committed `eval/data/world-v1/` corpus contains 240 fictional entities. Claude Opus wrote the generated prose. Its historical one-time generation cost was approximately $3.14; that is a recorded cost, not a current regeneration quote.

The `eval/data/system-one-v1/` datasets come from gbrain's System One v1 eval (MIT, garrytan/gbrain `feat/system-one-v1` at `9196543d`). Their synthetic S7 transcripts were written by `openai:gpt-5.6-luna` for about $0.75, and the S8 labels by `claude-sonnet-5` for about $2.51; both are recorded costs. The [System One data notes](data/system-one-v1/README.md) give each label's source.

The [PrecisionMemBench attribution](precisionmembench/ATTRIBUTION.md) names the upstream author, license, pinned revision and local adaptations. Other external benchmark sources are identified in their individual reports.

## Influences

**SWE-bench** helped establish the value of real comparison baselines. **MTEB** supplied a useful pattern for identifying models and versions in an experiment.

A **Codex** review challenged whether the early suite established anything beyond an internal test. That critique prompted the external-baseline work. The resulting controls make it easier for another engineer to decide what the evidence does and does not show.

## Changelog

How this page changed, newest first. Measurement history lives in the dated reports and in
[CHANGELOG.md](../CHANGELOG.md).

### 2026-10-05: Restructured as a current-state page with this changelog

gbrain-evals v0.10.22. The adapter table lists all five adapters with their current roles: `gbrain` is the product path with relationship retrieval on (it had read "the graph-based relational system under test"), and `graph-oracle-parse`, the template-parsing upper bound, is added.

### 2026-10-01: System One dataset attribution

[`b13b219`](https://github.com/garrytan/gbrain-evals/commit/b13b219), gbrain-evals v0.10.4. "Data and upstream work" gained a paragraph crediting the `eval/data/system-one-v1/` datasets to gbrain's System One v1 eval (MIT, `feat/system-one-v1` at `9196543d`). It records the generation models and costs (S7 transcripts by `openai:gpt-5.6-luna` for about $0.75, S8 labels by `claude-sonnet-5` for about $2.51) and links the System One data notes. The commit added the System One / Jev category.

### 2026-09-09: Rewrite as plain-language attribution

[`9238ec8`](https://github.com/garrytan/gbrain-evals/commit/9238ec8), gbrain-evals v0.8.0. The page was rewritten as part of the docs pass that explains retrieval in plain terms:

- A new intro explains why attribution matters: project-authored tests supply different evidence from independent submissions.
- "Core team" became "Project work". "External query authors" and "External adapters" merged into "Questions and adapters", which now calls the 50 `synthetic-outsider-v1` questions AI-authored placeholders and lists the four adapters in a table. It states that all four were built in this project and are controls, not vendor submissions.
- "Data" became "Data and upstream work". The $3.14 corpus cost is now labeled a historical recorded cost, not a regeneration quote, and a link to the PrecisionMemBench attribution was added.
- "Inspiration" became "Influences", rewritten as prose about SWE-bench, MTEB and the Codex review.

### 2026-05-24: Drop mem0 from example submissions

[`9ecc5b2`](https://github.com/garrytan/gbrain-evals/commit/9ecc5b2), gbrain v0.40.6.0 snapshot. The list of example third-party adapter submissions dropped mem0 and now reads "supermemory, Letta, Cognee". The commit removed peer-system references from the docs.

### 2026-04-23: Plain-English adapter names

[`8dab7f7`](https://github.com/garrytan/gbrain-evals/commit/8dab7f7). The adapter list was renamed to match the repository-wide rename: `gbrain-after` to `gbrain`, `hybrid-nograph` to `vector-grep-rrf-fusion`, `ripgrep-bm25` to `grep-only` and `vector-only` to `vector`.

### 2026-04-21: Page created

[`5bd8848`](https://github.com/garrytan/gbrain-evals/commit/5bd8848). Created with the initial BrainBench v1 extraction from gbrain. It credited garrytan and Claude Opus 4.7 as the core team, noted that the Tier 5.5 set held 50 synthetic placeholder queries and no human authors yet, listed the four internal adapters (`gbrain-after`, `hybrid-nograph`, `ripgrep-bm25`, `vector-only`), recorded the Claude Opus-generated `world-v1` corpus (240 entities, about $3.14 one-time), and named SWE-bench, Codex and MTEB as inspiration.
