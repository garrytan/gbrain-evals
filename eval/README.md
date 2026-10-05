# Running and understanding BrainBench

BrainBench is our collection of tests for gbrain. Each test asks a narrower question than “does memory work?” One checks whether search finds a relationship. Another checks whether an important decision survives when a conversation becomes a note.

Every runner loads the gbrain declared in `package.json`: master `739e5cc` (v0.60.46.0) as `gbrain`, plus the fixed-purpose aliases `gbrain-cues` and `gbrain-reader` for the experiments that name them. Most category runners also take `--gbrain <checkout>[@ref]` to measure another build as a copied overlay. Start with the [main guide](../README.md) for what gbrain does today, or the [documentation index](../docs/README.md) for every report. This page explains the test machinery and how to work with it. Everything above [Changelog](#changelog) is current.

## Start with a free check

From the repository root:

```sh
bun install --frozen-lockfile
bun run eval:query:validate
bun eval/runner/validate-data.ts --quiet
bun test test/eval/receipts-manifest.test.ts test/eval/query-cli.test.ts
```

These commands check query structure, dataset references and selected published artifacts. They do not call a model API. To run the repository's full unit and integration suite, use `bun run test`.

A small offline retrieval run is:

```sh
BRAINBENCH_N=1 bun eval/runner/multi-adapter.ts --adapter grep-only --queries relational
```

It searches the committed fictional corpus and writes a receipt under `eval/reports/multi-adapter/`. A receipt is the machine-readable record of what ran, what was scored and what failed.

## Choose the test that answers your question

| Question | Entry point | What to know |
|---|---|---|
| Do relationships help search? | `multi-adapter.ts --queries relational` | Four adapters; the graph adapter recognizes four known question templates. |
| Can search find a concept under different wording? | `cat13-conceptual.ts` | Keyword, vector and hybrid comparisons; explicit settings and held-out concepts. |
| Do long chat dumps bury a useful short note? | `cat13b-source-swamp.ts` | Compares normal source ranking with the same search whose source weights are neutral. |
| Can search recover old conversation evidence? | `longmemeval.ts` | External dataset; specify `--top-k 5` for the published five-result comparison. |
| Does search return too much irrelevant material? | `precisionmembench.ts` | External 77-case benchmark; result limits matter. |
| Do conversations become useful notes? | `cat35-transcript-distill.ts` | Model-backed write-path test; the default is a small paid setup run. |
| Does the right memory appear without asking? | `cat34-brainbench-memory.ts` | Offline conformance test with separate production and integration-contract rows. |
| Does a small decision model (Jev) beat gbrain's rules at triage, reranking or spotting contradictions? | `system-one-jev.ts` | `verify` checks the September 30 record offline; `run` replays a slot's matched pair against a gbrain checkout passed with `--gbrain`. |
| Does gbrain help an agent finish company-knowledge tasks better than grep, a memory tool or Postgres? | `cat40-model-ladder.ts` | Paid agent loop over a 4,000-document fictional company; build gbrain slots with `--build-slots` first; `--scripted` runs the hermetic arms for $0. |
| Do real agents (Claude Code, Codex) ask before spending or destroying data, and recover from gbrain's errors? | `cat41-agent-operator.ts` | Paid; pinned harnesses in Docker; `cat41/after-pass.sh <gbrain checkout> <commit>` runs a candidate, its gate and the Cat 40 instruction check. |

Paths in the table are relative to `eval/runner/`. A “Cat” number is simply a historical category identifier.

`bun run eval:run` launches the multi-adapter retrieval comparison. It does not launch every behavior test. `bun run eval:brainbench` starts the much broader category runner, which can call paid APIs. Its categories run in separate subprocesses with two slots by default; some categories require their own runtime inputs and are not included.

## The retrieval adapters

An adapter gives one search method the same pages and asks it to return ranked results. Four adapters are comparison systems; the fifth is an upper-bound control.

| Adapter name | What it does |
|---|---|
| `grep-only` | Scores words in the pages using BM25, a keyword-ranking formula. It is an in-memory implementation, not a shell call to `grep`. |
| `vector` | Embeds each page and the question as lists of numbers, then ranks pages by similarity. |
| `vector-grep-rrf-fusion` | Combines gbrain's keyword and vector rankings with graph traversal disabled. |
| `gbrain` | The product path: gbrain's hybrid search with relationship retrieval on, answering every question family. |
| `graph-oracle-parse` | Parses the four generator question templates with regular expressions and follows the fixture's graph. It knows the question form in advance, so treat it as an upper bound, not a product score. Receipts before v0.10.1 call this adapter `gbrain`. |

The long hybrid adapter name is a stable identifier in commands and saved results. In prose we call it **hybrid without graph traversal**.

The vector and hybrid adapters need `OPENAI_API_KEY`. Each run builds its own state. Do not assume LongMemEval's persistent embedding cache also exists in this runner.

```sh
# One complete comparison of the relational question family.
BRAINBENCH_N=1 bun eval/runner/multi-adapter.ts --queries relational

# All applicable families: relational, fuzzy and synthetic-outsider.
bun run eval:run

# One run of a single baseline on fuzzy questions.
BRAINBENCH_N=1 bun eval/runner/multi-adapter.ts --adapter grep-only --queries tier5
```

The default is five runs with seeded page-order shuffling. This checks sensitivity to ingestion order; it does not turn five deterministic runs into five independent datasets. The graph-template adapter only runs on question families it supports.

## Read the score correctly

**Precision@5** asks how many of five result slots contain relevant pages. Two relevant pages means 2/5, even if the adapter returned only two pages.

**Recall@5** asks what fraction of the relevant pages appeared in those five slots. If a question needs two pages and both appear, its recall is 100%.

LongMemEval's strict **recall_all@5** asks a different question: did *every* required conversation session appear? Getting one of two required sessions earns no credit on that question. These measures must be named explicitly when comparing results.

The scorer builds relational questions from the fictional world's relationship labels. It also scores the applicable built-in fuzzy and synthetic-outsider question families. The synthetic-outsider family is the 50 AI-authored Tier 5.5 placeholder questions; it uses the `externally-authored` tier id reserved for outside submissions, but no outside author wrote it. Receipts before v0.10.1 label this family `externally-authored`. Items without document relevance labels, such as answer-only or abstention cases, are excluded from this retrieval metric and listed in the receipt.

Adapters receive sanitized copies without the hidden relationship facts or answer labels. This is an API boundary and a reviewed coding rule, not operating-system isolation against malicious code reading files.

The old 49.1% precision / 97.9% recall graph result is a historical pre-audit measurement. Its missing raw receipt and template-specific parser limit what it establishes. Read the [original report](../docs/benchmarks/2026-04-23-brainbench-v0.20.0.md) and the dated refresh together.

## Find the files

- `data/world-v1/`: the 240-page fictional world.
- `data/amara-life-v1/`: emails, chats, calendar entries and notes with planted events.
- `data/gold/`: answer labels generated from the amara-life skeleton (`contradictions.json`, `implicit-preferences.json`, `poison.json`); `validate-data.ts` fails on a hand-written template row.
- `runner/types.ts`: the adapter and query interfaces.
- `runner/queries/`: built-in questions and their validator.
- `schemas/`: saved-data and tool contracts.
- `reports/`: temporary output, ignored by Git.

Some Markdown files under `data/` are the text being tested. Editing them changes the experiment. Dataset READMEs explain those fixtures without changing their contents.

## Contribute or reproduce

Use [CONTRIBUTING.md](CONTRIBUTING.md) to add questions or an adapter, and [RUNBOOK.md](RUNBOOK.md) for setup failures and reproducibility. Paid runs spend through the budget ledger described in [docs/budget-ledger.md](../docs/budget-ledger.md). Browse the fictional world with `bun run eval:world:view`; on a machine without a desktop, `bun run eval:world:render` produces the HTML without opening a browser.

To reproduce an old result, match both the gbrain-evals revision and the gbrain code named in the report. Checking out a gbrain commit inside this repository does not select that dependency.

## Changelog

How this page changed, newest first. Measurement history lives in the dated reports and in
[CHANGELOG.md](../CHANGELOG.md).

### 2026-10-05: Restructured as a current-state page with this changelog

gbrain-evals v0.10.23. The introduction names the gbrain each runner loads (`739e5cc` plus the `gbrain-cues` and `gbrain-reader` aliases) and the `--gbrain` overlay flag, and points to the documentation index instead of calling the September 9 refresh "the new comparison". "The four retrieval adapters" becomes "The retrieval adapters", since the table lists five, and the `gbrain` and `graph-oracle-parse` rows describe their current roles, with the pre-v0.10.1 name kept as a note for reading old receipts.

### 2026-10-04: Cat 40 and Cat 41 rows in the test table

[`da5093b`](https://github.com/garrytan/gbrain-evals/commit/da5093b). "Choose the test that answers your question" gained two rows. `cat40-model-ladder.ts` asks whether gbrain helps an agent finish company-knowledge tasks better than grep, a memory tool or Postgres (paid agent loop over a 4,000-document fictional company; `--build-slots` first, `--scripted` for the $0 hermetic arms). `cat41-agent-operator.ts` asks whether Claude Code and Codex ask before spending or destroying data and recover from gbrain's errors (paid, pinned harnesses in Docker, `cat41/after-pass.sh` for a candidate). The commit described both categories as they stand across the docs.

### 2026-10-03: Budget ledger pointer

[`cb8979c`](https://github.com/garrytan/gbrain-evals/commit/cb8979c), gbrain-evals v0.10.12. "Contribute or reproduce" now says paid runs spend through the budget ledger and links `docs/budget-ledger.md`. The commit added the SQLite budget ledger.

### 2026-10-01: System One / Jev row

[`b13b219`](https://github.com/garrytan/gbrain-evals/commit/b13b219), gbrain-evals v0.10.4. The test table gained a row for `system-one-jev.ts`: does a small decision model (Jev) beat gbrain's rules at triage, reranking or spotting contradictions? `verify` checks the September 30 record offline, and `run` replays a slot's matched pair against a `--gbrain` checkout.

### 2026-09-29: `gbrain` adapter becomes the product path

[`88d0b19`](https://github.com/garrytan/gbrain-evals/commit/88d0b19), gbrain-evals v0.10.1.

- The `gbrain` adapter row now describes the product path (hybrid search with relationship retrieval on, answering every question family) instead of template-based graph traversal. A new `graph-oracle-parse` row describes the old regex-template adapter, labels it an upper bound rather than a product score, and notes it was named `gbrain` before v0.10.1.
- The Tier 5.5 family is now called `synthetic-outsider` in the run comments and scoring section. The page explains it is the 50 AI-authored placeholders under the reserved `externally-authored` tier id, and that receipts before v0.10.1 use the old label.
- The `data/gold/` entry now says the labels are generated from the amara-life skeleton (`contradictions.json`, `implicit-preferences.json`, `poison.json`) and that `validate-data.ts` fails on a hand-written template row, replacing "some files remain explicitly incomplete".

### 2026-09-09: Rewrite as a guide to the test machinery

[`9238ec8`](https://github.com/garrytan/gbrain-evals/commit/9238ec8), gbrain-evals v0.8.0. The page was rewritten from a benchmark landing page into "Running and understanding BrainBench", as part of the docs pass that explains retrieval with reproducible comparisons:

- The "+31 points P@5" headline, the directory tree, the three contributor paths and the scorecard table were removed. The 49.1% precision / 97.9% recall result is now described as a historical pre-audit measurement with no raw receipt, with links to the original report and the September 2026 retrieval refresh.
- New sections: a free offline check, a "Choose the test that answers your question" table covering seven entry points (multi-adapter, Cat13, Cat13b, LongMemEval, PrecisionMemBench, Cat35, Cat34), a plain-English table of the four adapters, and "Read the score correctly", which separates Precision@5, Recall@5 and LongMemEval's strict recall_all@5.
- It now states that `bun run eval:run` launches only the retrieval comparison, that adapters get sanitized pages through an API boundary rather than OS isolation, and that reproducing a result needs both the gbrain-evals revision and the gbrain code identity.

### 2026-08-31: Audit corrections to corpus and metrics notes

[`bd5ba0d`](https://github.com/garrytan/gbrain-evals/commit/bd5ba0d), gbrain-evals v0.5.0 (BrainBench v0.3.0 in the commit subject). Two corrections from the eval-suite audit. The `amara-life-v1/` entry now says the corpus is committed and only the `_cache/` prose cache is gitignored (it had said the corpus was gitignored and generated on demand). The metrics bullet now says the scorecard covers only the 145 canonical relational queries, and the 80 tier-5 and tier-5.5 queries are schema-validated but not yet wired into the `eval:run` scorer.

### 2026-04-23: Plain-English adapter names

[`8dab7f7`](https://github.com/garrytan/gbrain-evals/commit/8dab7f7). Adapter names were replaced throughout the intro, file tree and scorecard: `gbrain-after` to `gbrain`, `hybrid-nograph` to `vector-grep-rrf-fusion`, `ripgrep-bm25` to `grep-only`, `vector-only` to `vector`. The mechanical rename also caught prose, so "vector+keyword hybrid" became "vector+keyword vector-grep-rrf-fusion".

### 2026-04-21: Page created

[`5bd8848`](https://github.com/garrytan/gbrain-evals/commit/5bd8848). Created with the initial BrainBench v1 extraction from gbrain. It presented BrainBench as a public benchmark of four adapters on the 240-page fictional corpus, headlined gbrain beating hybrid search without the graph by +31 points P@5, and included a quickstart, an annotated `eval/` file tree, three contributor paths, a methodology summary and an N=5 scorecard (`gbrain-after` 49.1% P@5 / 97.9% R@5, `hybrid-nograph` 17.8% / 65.1%, `ripgrep-bm25` 17.1% / 62.4%, `vector-only` 10.8% / 40.7%).
