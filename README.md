# gbrain-evals

**Public, reproducible benchmarks for personal-knowledge agent stacks.** Two
families: **BrainBench** (our own corpus, the in-house Cat 1–12 suite) and
**public benchmarks** (LongMemEval today; ConvoMem + LoCoMo on the roadmap).
[gbrain](https://github.com/garrytan/gbrain) is the reference stack under test,
but any adapter that implements the interface can be scored.

## Headline result

> **97.60% R@5 on the public LongMemEval `_s` benchmark — SOTA, beating
> MemPalace's published 96.6% on the same dataset, same K, same n, with no LLM
> in the retrieval loop.**
> [Full report →](docs/benchmarks/2026-05-07-longmemeval-s.md)

Two other numbers that hold against current master:

- **49.1% P@5 / 97.9% R@5 on BrainBench v1 relational queries** — beats
  commodity vector RAG by 38 points P@5; the graph layer alone is worth ~30.
- **Zero retrieval regression across 20 releases** (v0.20.0 → v0.40.6.0),
  headline numbers byte-identical to baseline.

## Results

| Benchmark | gbrain result | Date | Report |
|---|---|---|---|
| **LongMemEval `_s`** (public) | **97.60% R@5 (SOTA)** | 2026-05-07 | [link](docs/benchmarks/2026-05-07-longmemeval-s.md) |
| v0.40.6.0 snapshot (all evals) | master HEAD | 2026-05-23 | [link](docs/benchmarks/2026-05-23-v0.40.6.0-snapshot.md) |
| BrainBench v0.20.0 baseline | P@5 49.1% / R@5 97.9% | 2026-04-23 | [link](docs/benchmarks/2026-04-23-brainbench-v0.20.0.md) |
| BrainBench Cat 13b — Source Swamp | top-1 93.3% | 2026-04-25 | [link](docs/benchmarks/2026-04-25-brainbench-cat13b-source-swamp.md) |
| PrecisionMemBench (external) | #2 — 0.582 precision w/ opt-in gate | 2026-05-29 | [link](docs/benchmarks/2026-05-29-precisionmembench.md) |
| Cross-system comparison | living list | — | [link](docs/comparison-systems.md) |

## Why a separate repo

Benchmark corpora (world-v1 + amara-life-v1 ≈ 4MB) shouldn't ship in every
gbrain install. Clone this when you want to *run* benchmarks against gbrain, not
to use gbrain as a brain. `gbrain-evals` depends on `gbrain` via its GitHub URL;
`bun install` pulls it in as a library and evals call its `gbrain/*` subpath
exports (`pglite-engine`, `search/hybrid`, `operations`, …).

## Quickstart

```sh
git clone https://github.com/garrytan/gbrain-evals.git
cd gbrain-evals
bun install        # pulls gbrain as a library dep
```

### LongMemEval (public, 500 questions × 4 adapters)

```sh
mkdir -p ~/datasets/longmemeval
curl -Lo ~/datasets/longmemeval/longmemeval_s.json \
  https://huggingface.co/datasets/xiaowu0162/longmemeval/resolve/main/longmemeval_s

export OPENAI_API_KEY="sk-..."         # vector + hybrid adapters
export ANTHROPIC_API_KEY="sk-ant-..."  # hybrid+expansion adapter only

bash eval/runner/longmemeval-batch.sh                  # all 4 adapters, parallel, resumable
bash eval/runner/longmemeval-batch.sh --adapters hybrid
bun eval/runner/longmemeval.ts --stratify 10           # fast 10-per-type sample
```

First run pays ~$2 in OpenAI embeddings; later runs hit the local
content-addressed cache (~$0).

### BrainBench (in-house 240-page fictional life)

```sh
bun run eval:run                  # full 4-adapter benchmark (N=5, ~15 min, no API keys)
bun run eval:run:dev              # N=1 smoke
bun run eval:type-accuracy        # per-link-type accuracy
bun run eval:world:view           # browse the corpus
```

## Public benchmarks

| Benchmark | What it tests | gbrain best |
|---|---|---|
| **LongMemEval `_s`** | retrieval recall over long chat (500 Q, ~50 distractor sessions) | **97.60% R@5 (SOTA)** |
| PrecisionMemBench | retrieval *precision* isolation on a 35-belief belief store | #2 (see below) |
| ConvoMem / LoCoMo | conversational memory at scale / multi-hop | roadmap |

### PrecisionMemBench (external)

[PrecisionMemBench](https://github.com/tenurehq/precisionmembench) isolates
retrieval *precision* from answer quality on a small structured belief store. We
ran gbrain against it with Tenure's own scorer vendored verbatim. Two honest
takeaways:

1. gbrain's **default top-K hybrid scores 0.076 precision** — a precision-only
   benchmark punishes returning many results and letting a model sort them out
   (recall stays 0.99). This is expected, and it prompted a real feature.
2. With **intent-aware adaptive return-sizing** (an opt-in gbrain retrieval
   feature, default-off), gbrain reaches **0.582 precision / 29 active passes**,
   clear of supermemory (0.43) on both axes at a third of the latency — **#2**
   behind the benchmark author's purpose-built belief store.

It's a narrow lexical probe (35 beliefs, embedding-invariant by design), not a
measure of what a personal brain is for. Full numbers, caveats, and the
"return-tight beats a score-cliff detector" finding are in the
[report](docs/benchmarks/2026-05-29-precisionmembench.md).

Run it:

```sh
bun eval/runner/precisionmembench.ts --mode gbrain-hybrid     # default baseline (0.076)
bun eval/runner/precisionmembench.ts --mode gbrain-adaptive --entity-max 1 --other-max 1   # 0.582
bun eval/runner/precisionmembench-instrument.ts              # policy sweep + cliff read
```

`gbrain-adaptive` needs a gbrain build with the `adaptiveReturn` SearchOpt
(`bun link` a local checkout until it lands on `gbrain` master); the other modes
run on master.

## BrainBench Cat catalog

| Cat | Tests | Threshold | Status |
|-----|-------|-----------|--------|
| 1+2 | Retrieval (relational, 240-page rich prose) | P@5 > 0.39, R@5 > 0.83 | shipping |
| 3 | Identity resolution (aliases, handles, emails) | recall > 0.80 | shipping |
| 4 | Temporal queries (as-of, point, range, recency) | as-of recall > 0.80 | shipping |
| 5 | Source attribution / provenance | citation_accuracy > 0.90 | shipping |
| 6 | Auto-link precision under prose at scale | link_precision > 0.95 | shipping |
| 7 | Performance / latency | p95 < 200ms | shipping |
| 8 | Skill behavior compliance | all > 0.90 | shipping |
| 9 | End-to-end workflows (5 × rubric) | 80% pass | shipping |
| 10 | Robustness / adversarial (22 cases) | 100%, no crash | shipping |
| 11 | Multi-modal ingest (PDF + audio + HTML) | text > 0.95, WER < 0.15 | shipping |
| 12 | MCP operation contract (trust boundary) | no silent corruption | shipping |

Cats 5, 8, 9 are programmatic (driven via their `runCatN` harness API, not a CLI
script).

## The fictional corpus

- **world-v1** (2.0MB, committed): 240 Opus-generated biographical pages (80
  people, 80 companies, 50 meetings, 30 concepts). Each carries `_facts` gold
  that never crosses the adapter boundary (sealed-qrels enforcement).
- **amara-life-v1** (2.1MB, committed): one messy fictional week — 50 emails,
  300 Slack messages, 20 calendar events, 8 transcripts, 40 notes, 6 docs, with
  planted contradictions, stale facts, and poison items. Regenerate with
  `bun run eval:generate-amara-life` (seed=42, deterministic).

## Repo layout

```
gbrain-evals/
├── VERSION, CHANGELOG.md             semver, kept in sync with package.json
├── CLAUDE.md                         spec for the platonic-ideal report
├── eval/
│   ├── data/                         world-v1, amara-life-v1, gold/, longmemeval/
│   ├── precisionmembench/            vendored scorer + fixtures + gbrain adapters
│   ├── runner/                       Cat runners, LongMemEval, PrecisionMemBench, adapters
│   ├── reports/                      transient run output (gitignored)
│   └── cli/                          world-view, query-validate, query-new
├── test/eval/                        unit tests
└── docs/
    ├── benchmarks/                   published scorecards + their data/charts
    └── comparison-systems.md         living cross-system R@k list
```

## Contributing

- **Reproduce a scorecard:** `git checkout <sha-from-scorecard> && bun run eval:run`.
- **Submit an adapter:** implement `eval/runner/adapters/<name>.ts` against the
  `Adapter` interface, register it in `multi-adapter.ts`, run `bun run eval:run`,
  open a PR with your scorecard in `docs/benchmarks/`.
- **Extend a Cat:** add `eval/runner/catN-*.ts`, wire into `all.ts`, add
  `test/eval/catN.test.ts`, commit a baseline.

Anti-gaming is structural: sealed qrels at the adapter boundary, N=3/5/10
tolerance bands, judge-version pinning, randomized per-seed query order.

## License

MIT. Fixtures are fully fictional and redistributable. Vendored
PrecisionMemBench artifacts are MIT (tenurehq); see
`eval/precisionmembench/ATTRIBUTION.md`.

## Relationship to gbrain

`gbrain-evals` is a **consumer** of `gbrain`, importing its public surface via
`gbrain/*` subpath exports (`operations`, `pglite-engine`, `search/hybrid`,
`import-file`, `embedding`, `types`, `config`, `engine`). gbrain is one
reference stack among many, not the benchmark's subject.
