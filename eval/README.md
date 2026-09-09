# Running and understanding BrainBench

BrainBench is our collection of tests for gbrain. Each test asks a narrower question than “does memory work?” One checks whether search finds a relationship. Another checks whether an important decision survives when a conversation becomes a note.

Start with the [main guide](../README.md) for the findings and recommended reading, or the [September 2026 retrieval refresh](../docs/benchmarks/2026-09-09-retrieval-refresh.md) for the new comparison. This page explains the test machinery and how to work with it.

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

Paths in the table are relative to `eval/runner/`. A “Cat” number is simply a historical category identifier.

`bun run eval:run` launches the multi-adapter retrieval comparison. It does not launch every behavior test. `bun run eval:brainbench` starts the much broader category runner, which can call paid APIs. Its categories run in separate subprocesses with two slots by default; some categories require their own runtime inputs and are not included.

## The four retrieval adapters

An adapter gives one search method the same pages and asks it to return ranked results.

| Adapter name | What it does |
|---|---|
| `grep-only` | Scores words in the pages using BM25, a keyword-ranking formula. It is an in-memory implementation, not a shell call to `grep`. |
| `vector` | Embeds each page and the question as lists of numbers, then ranks pages by similarity. |
| `vector-grep-rrf-fusion` | Combines gbrain's keyword and vector rankings with graph traversal disabled. |
| `gbrain` | Extracts relationships and answers the supported relational templates through graph traversal. |

The long hybrid adapter name is a stable identifier in commands and saved results. In prose we call it **hybrid without graph traversal**.

The vector and hybrid adapters need `OPENAI_API_KEY`. Each run builds its own state. Do not assume LongMemEval's persistent embedding cache also exists in this runner.

```sh
# One complete comparison of the relational question family.
BRAINBENCH_N=1 bun eval/runner/multi-adapter.ts --queries relational

# All applicable families: relational, fuzzy and externally authored.
bun run eval:run

# One run of a single baseline on fuzzy questions.
BRAINBENCH_N=1 bun eval/runner/multi-adapter.ts --adapter grep-only --queries tier5
```

The default is five runs with seeded page-order shuffling. This checks sensitivity to ingestion order; it does not turn five deterministic runs into five independent datasets. The graph-template adapter only runs on question families it supports.

## Read the score correctly

**Precision@5** asks how many of five result slots contain relevant pages. Two relevant pages means 2/5, even if the adapter returned only two pages.

**Recall@5** asks what fraction of the relevant pages appeared in those five slots. If a question needs two pages and both appear, its recall is 100%.

LongMemEval's strict **recall_all@5** asks a different question: did *every* required conversation session appear? Getting one of two required sessions earns no credit on that question. These measures must be named explicitly when comparing results.

The scorer builds relational questions from the fictional world's relationship labels. It also scores the applicable built-in fuzzy and externally authored question families. Items without document relevance labels, such as answer-only or abstention cases, are excluded from this retrieval metric and listed in the receipt.

Adapters receive sanitized copies without the hidden relationship facts or answer labels. This is an API boundary and a reviewed coding rule, not operating-system isolation against malicious code reading files.

The old 49.1% precision / 97.9% recall graph result is a historical pre-audit measurement. Its missing raw receipt and template-specific parser limit what it establishes. Read the [original report](../docs/benchmarks/2026-04-23-brainbench-v0.20.0.md) and the dated refresh together.

## Find the files

- `data/world-v1/`: the 240-page fictional world.
- `data/amara-life-v1/`: emails, chats, calendar entries and notes with planted events.
- `data/gold/`: answer labels; some files remain explicitly incomplete.
- `runner/types.ts`: the adapter and query interfaces.
- `runner/queries/`: built-in questions and their validator.
- `schemas/`: saved-data and tool contracts.
- `reports/`: temporary output, ignored by Git.

Some Markdown files under `data/` are the text being tested. Editing them changes the experiment. Dataset READMEs explain those fixtures without changing their contents.

## Contribute or reproduce

Use [CONTRIBUTING.md](CONTRIBUTING.md) to add questions or an adapter, and [RUNBOOK.md](RUNBOOK.md) for setup failures and reproducibility. Browse the fictional world with `bun run eval:world:view`; on a machine without a desktop, `bun run eval:world:render` produces the HTML without opening a browser.

To reproduce an old result, match both the gbrain-evals revision and the gbrain code named in the report. Checking out a gbrain commit inside this repository does not select that dependency.
