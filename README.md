# gbrain-evals

**Public benchmarks for personal-knowledge agent stacks.** Two families,
both reproducible: BrainBench (our own corpus, in-house Cats 1–12) and
public benchmarks (LongMemEval today, ConvoMem + LoCoMo on the roadmap).

## Latest results

**v0.40.6.0 comprehensive snapshot (2026-05-23)** — every published eval
result against current master in one page, plus the gap-map for what
v0.36.x → v0.40.6.0 features still need eval coverage. **Read the
snapshot:** [docs/benchmarks/2026-05-23-v0.40.6.0-snapshot.md](docs/benchmarks/2026-05-23-v0.40.6.0-snapshot.md).

**Headline numbers that hold up against v0.40.6.0:**

- **97.60% R@5 on public LongMemEval `_s`** — SOTA against MemPalace's
  published 96.6% baseline on the same dataset, same K, same n, no LLM
  in the retrieval loop.
- **49.1% P@5 / 97.9% R@5 on BrainBench v1 relational queries** — beats
  commodity vector RAG by 38 points P@5 and ripgrep-BM25 by 32 points.
  The graph layer alone is worth 30 points.
- **Zero retrieval regression across 20 releases** (v0.20.0 → v0.40.6.0).
  Headline numbers byte-identical to the v0.20.0 baseline.

| Benchmark | Latest result | Date | Report |
|---|---|---|---|
| v0.40.6.0 snapshot (comprehensive) | gbrain master HEAD | 2026-05-23 | [link](docs/benchmarks/2026-05-23-v0.40.6.0-snapshot.md) |
| LongMemEval `_s` (public) | gbrain-hybrid 97.60% R@5 | 2026-05-07 | [link](docs/benchmarks/2026-05-07-longmemeval-s.md) |
| BrainBench Cat 14+15 — Calibration A/B | gates v0.36.1.0 advice quality | 2026-05-18 | [link](docs/benchmarks/2026-05-18-brainbench-cat14-cat15-calibration.md) |
| BrainBench Cat 13b — Source Swamp | gbrain top-1 93.3% | 2026-04-25 | [link](docs/benchmarks/2026-04-25-brainbench-cat13b-source-swamp.md) |
| BrainBench v0.20.0 baseline | gbrain P@5 49.1% / R@5 97.9% | 2026-04-23 | [link](docs/benchmarks/2026-04-23-brainbench-v0.20.0.md) |
| Cross-system comparison | MemPal / Mastra / Stella / Contriever | living | [docs/comparison-systems.md](docs/comparison-systems.md) |

## Why a separate repo

Benchmark corpora (world-v1 + amara-life-v1 = ~4MB) shouldn't land in
every gbrain install. This repo is what you clone when you want to run
BrainBench against gbrain, not what you clone to use gbrain as a brain.

`gbrain-evals` depends on `gbrain` via the GitHub URL. When you `bun install`
here, gbrain gets pulled in as a library. Evals call into gbrain's core
modules (`pglite-engine`, `operations`, `link-extraction`, etc.) via the
`gbrain/*` subpath exports.

## 5-minute quickstart

```sh
# Clone + install (pulls gbrain as a library dep)
git clone https://github.com/garrytan/gbrain-evals.git
cd gbrain-evals
bun install
```

### Run LongMemEval (public benchmark, 500 questions × 4 adapters)

```sh
# Download the LongMemEval _s split (~278MB, one-time)
mkdir -p ~/datasets/longmemeval
curl -Lo ~/datasets/longmemeval/longmemeval_s.json \
  https://huggingface.co/datasets/xiaowu0162/longmemeval/resolve/main/longmemeval_s

export OPENAI_API_KEY="sk-..."        # required for vector + hybrid adapters
export ANTHROPIC_API_KEY="sk-ant-..." # required for hybrid+expansion adapter only

# 4 adapters × 500 questions, 3 parallel workers, 10-min batches w/ resume
bash eval/runner/longmemeval-batch.sh

# One adapter only
bash eval/runner/longmemeval-batch.sh --adapters hybrid

# Stratified sample for fast iteration
bun eval/runner/longmemeval.ts --stratify 10  # 10 Q's per type
```

First run pays ~$2 OpenAI embeddings; subsequent runs hit the local
content-addressed cache (~$0). See the published
[longmemeval-s benchmark report](docs/benchmarks/2026-05-07-longmemeval-s.md)
for headline numbers and methodology.

### Run BrainBench (in-house corpus, 240-page fictional life)

```sh
# Run the full 4-adapter benchmark (N=5, ~15 min, no API keys required)
bun run eval:run

# Fast iteration (N=1)
bun run eval:run:dev

# Per-link-type accuracy report
bun run eval:type-accuracy

# Browse the fictional corpus
bun run eval:world:view

# Full BrainBench v1 scorecard (all Cats, published tier N=10)
bun run eval:brainbench:published       # ~$200 Opus baseline
bun run eval:brainbench                 # N=5 iteration (~$100)
bun run eval:brainbench:smoke           # N=1 smoke (~$22)
```

## Public benchmarks

| Benchmark | Source | What it tests | gbrain best result |
|---|---|---|---|
| **LongMemEval `_s`** | [xiaowu0162/longmemeval](https://huggingface.co/datasets/xiaowu0162/longmemeval) | Retrieval recall over long-running chat (500 Q's, 6 question types, ~50 distractor sessions per haystack) | **97.60% R@5** ([report](docs/benchmarks/2026-05-07-longmemeval-s.md)) |
| LongMemEval `_oracle` | same source, easier split (3 sessions per haystack) | sanity baseline | not yet run (trivial) |
| LongMemEval `_m` | same source, harder split (200 distractors) | retrieval under heavier noise | filed as TODO |
| ConvoMem (Salesforce) | 75K+ multi-turn QA pairs | conversational memory at scale | filed as TODO |
| LoCoMo | 1,986 multi-hop QA | multi-hop reasoning over conversation | filed as TODO |

Each public benchmark gets a runner under `eval/runner/<bench>.ts`, a
report under `docs/benchmarks/<date>-<bench>.md`, and per-row entries in
[`docs/comparison-systems.md`](docs/comparison-systems.md) with sourced
numbers from MemPalace, Mastra, Supermemory, Stella,
Contriever, and BM25 baselines.

## BrainBench Cat catalog

| Cat | What it tests | Threshold | Status |
|-----|--------------|-----------|--------|
| 1+2 | Retrieval (relational queries over 240-page rich-prose) | P@5 > 0.39, R@5 > 0.83 | shipping |
| 2 | Per-link-type accuracy on rich prose | type F1 per category | shipping |
| 3 | Identity resolution (aliases, handles, emails) | recall > 0.80 | shipping |
| 4 | Temporal queries (as-of, point, range, recency) | as-of recall > 0.80 | shipping |
| 5 | Source attribution / provenance (claim → source classification) | citation_accuracy > 0.90 | shipping (programmatic) |
| 6 | Auto-link precision under prose (at scale) | link_precision > 0.95 | shipping (baseline-only) |
| 7 | Performance / latency | p95 < 200ms per query | shipping |
| 8 | Skill behavior compliance (brain-first, back-link, citation, tier) | all > 0.90 | shipping (programmatic) |
| 9 | End-to-end workflows (5 flows × rubric) | 80% pass per workflow | shipping (programmatic) |
| 10 | Robustness / adversarial (22 hand-crafted cases) | 100% pass, no crash | shipping |
| 11 | Multi-modal ingest (PDF + audio + HTML) | text > 0.95, WER < 0.15 | shipping (opt-in fixtures) |
| 12 | MCP operation contract (trust boundary, input validation) | no silent corruption | shipping |

Cats 5, 8, 9 are "programmatic" — they need runtime inputs (claim catalog,
probe catalog, scenarios + agent state) and are invoked via their `runCatN`
harness API rather than as standalone CLI scripts.

## The fictional corpus: world-v1 + amara-life-v1

**world-v1** (committed, 2.0MB): 240 Opus-generated biographical pages.
80 people, 80 companies, 50 meetings, 30 concepts. Each page carries
`_facts` gold metadata that never crosses the adapter boundary (Day 9
sealed-qrels enforcement).

**amara-life-v1** (committed, 2.1MB): Amara Okafor's messy week in April
2026. 50 emails + 300 Slack messages across 4 channels + 20 calendar
events + 8 meeting transcripts + 40 first-person notes + 6 reference docs.
Planted perturbations: 10 contradictions, 5 stale facts, 5 paraphrased-
injection poison items, 3 implicit preferences.

Regenerate with `bun run eval:generate-amara-life` (requires
`ANTHROPIC_API_KEY`, ~$4 Opus, ~15 min, deterministic from seed=42).

## Repo layout

```
gbrain-evals/
├── CLAUDE.md                         Spec for the platonic-ideal benchmark report
├── eval/
│   ├── data/
│   │   ├── world-v1/                 240 committed biographical pages (BrainBench)
│   │   ├── amara-life-v1/            Amara's fictional life (BrainBench)
│   │   ├── gold/                     Sealed qrels + perturbation gold
│   │   ├── longmemeval/embed-cache/  Embedding cache (gitignored, ~700MB)
│   │   └── multimodal/               PDF/audio/HTML fixtures (on-demand)
│   ├── schemas/                      Portable JSON Schema contracts
│   ├── generators/                   world.ts + amara-life.ts + Opus
│   ├── runner/                       12 Cat runners + LongMemEval + adapters + judge
│   │   ├── adapters/                 grep-only, vector, vector-grep-rrf-fusion, claude-sonnet
│   │   ├── loaders/                  PDF + corpus loaders
│   │   ├── queries/                  Tier 5 fuzzy + 5.5 synthetic
│   │   ├── all.ts                    BrainBench master runner
│   │   ├── cat{5,6,8,9,11}-*.ts      v1 Complete runners
│   │   ├── longmemeval.ts            LongMemEval runner (4 adapters, NDJSON resume, parallel sharding)
│   │   ├── longmemeval-cache.ts      Content-addressed embedding cache (SQLite, WAL, busy_timeout)
│   │   ├── longmemeval-aggregate.ts  Aggregator over the NDJSON stream
│   │   ├── longmemeval-batch.sh      3-worker × 10-min batch wrapper with auto-resume
│   │   ├── longmemeval-chart.ts      Inline-SVG headline + per-type chart generator
│   │   ├── tool-bridge.ts            12 read + 3 dry_run tools
│   │   ├── judge.ts                  Haiku judge, structured evidence contract
│   │   ├── recorder.ts               6-artifact flight-recorder
│   │   └── llm-budget.ts             Shared Anthropic-call semaphore
│   ├── reports/                      Transient run output (gitignored)
│   └── cli/                          world-view, query-validate, query-new
├── test/eval/                        Unit tests (314 tests, 1354 expect calls)
└── docs/
    ├── benchmarks/                   Published scorecards per release + their charts
    └── comparison-systems.md         Living list of named systems w/ published R@k numbers
```

## Three contributor paths

### 1. Reproduce a published scorecard
```sh
git checkout <commit-sha-from-scorecard>
bun run eval:run
# Match within tolerance bands (deterministic adapters byte-match)
```

### 2. Submit a new adapter
1. Implement `eval/runner/adapters/<your-adapter>.ts` against the `Adapter`
   interface (`init(pages, config) → BrainState`, `query(q, state) → RankedDoc[]`).
2. Register it in `eval/runner/multi-adapter.ts`.
3. Run `bun run eval:run` — it scores side-by-side against the 4 references.
4. Open a PR with your scorecard in `docs/benchmarks/YYYY-MM-DD-<stack>.md`.

### 3. Extend a Cat
1. Add a new Cat runner at `eval/runner/catN-*.ts`.
2. Wire into `eval/runner/all.ts` CATEGORIES.
3. Add tests at `test/eval/catN.test.ts`.
4. Commit a baseline to `docs/benchmarks/`.

## Design doc + methodology

- `docs/benchmarks/TEMPLATE-brainbench-v1.md` — scorecard format (coming in v1 Complete ship)
- BrainBench v1 design doc: `~/.gstack/projects/garrytan-gbrain/garrytan-garrytan-gbrain-evals-design-20260418-081754.md` (original)
- 3-axis metric framework: Retrieval (Cat 1-4), Ingestion (Cat 2, 6, 11), Assistant/personalization (Cat 5, 8, 9)
- Anti-gaming: sealed qrels at the adapter boundary, N=3/5/10 tolerance bands,
  judge-version pinning, randomized query order per seeded run

## License

MIT. Fixtures (world-v1, amara-life-v1) are fully fictional and redistributable.

## Relationship to gbrain

`gbrain-evals` is a **consumer** of `gbrain`. The benchmark imports gbrain's
public surface via `gbrain/*` subpath exports:

- `gbrain/operations` — the 36 operations (tool-bridge exposes 12 read-only + 3 dry_run)
- `gbrain/pglite-engine` — in-memory Postgres for adapter state
- `gbrain/link-extraction` — extractor under test
- `gbrain/import-file`, `gbrain/embedding`, `gbrain/transcription` — ingest pipeline
- `gbrain/search/vector-grep-rrf-fusion` — vector-grep-rrf-fusion RAG implementation
- `gbrain/types`, `gbrain/config`, `gbrain/engine` — type contracts

Any adapter that implements the `Adapter` interface can be scored — gbrain
is one of many reference stacks, not the benchmark's subject.
