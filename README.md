# gbrain-evals

The test suite for [gbrain](https://github.com/garrytan/gbrain), the long-term
memory an AI agent reads from and writes to.

Everything here is public, runs on your own machine, and can be reproduced from a
commit hash. We test the whole surface that an agent's memory has to get right,
not just the one number that looks good in a tweet: finding the relevant thing,
remembering who's who, keeping time straight, not contradicting itself, citing
where a fact came from, and staying fast when the brain has hundreds of thousands
of pages. And we publish the numbers we are not proud of right next to the ones we
are, because a memory system you are going to build on has to be honest about
where it is weak.

If you are deciding whether to trust gbrain with your agent's memory, this repo is
how you check our work instead of taking our word for it.

## How these benchmarks work (the 60-second version)

A benchmark here is three things:

1. **A corpus** — a pile of realistic content (chat logs, meeting notes, emails,
   biographical pages). Some is a fictional life we generated; some is a public
   dataset other researchers use.
2. **Questions with sealed answers** — each question has a known-correct answer
   that lives in a separate file the system under test never sees. gbrain has to
   find the answer from the content alone. It cannot peek at the answer key, so it
   cannot cheat.
3. **A score** — we run the question, look at what came back, and compare it to
   the sealed answer.

Two plain-English measures show up everywhere:

- **Recall** — "was the right thing in what we got back?" Recall@5 of 97% means
  the correct memory was in the top 5 results 97 times out of 100.
- **Precision** — "of what we got back, how much was actually relevant?" High
  precision means little junk mixed in.

Most questions want high recall (don't miss the answer). Some want high precision
(don't bury it). A real memory system has to be good at both, in the right
proportion for the question being asked. We test for that balance, not for one
metric at the expense of the other.

## Where gbrain lands today

| What we measured | Result | Plain English | Report |
|---|---|---|---|
| **LongMemEval** (public dataset, 500 questions over long chat histories) | **97.6% recall@5** | The right memory is in the top 5 results 97.6% of the time. Best published score on this test, with no LLM in the retrieval loop. | [report](docs/benchmarks/2026-05-07-longmemeval-s.md) |
| **Relational questions** ("who introduced X to Y?") on a 240-page fictional life | **97.9% recall@5, 49.1% precision@5** | Beats plain vector search by 38 points of precision. The graph layer (who-knows-whom) is worth about 30 of those points on its own. | [report](docs/benchmarks/2026-04-23-brainbench-v0.20.0.md) |
| **Stability across 20 releases** (v0.20.0 → v0.40.6.0) | **zero regression** | The headline numbers stayed identical, release after release. New features did not quietly make retrieval worse. | [report](docs/benchmarks/2026-05-23-v0.40.6.0-snapshot.md) |
| **PrecisionMembench** (an outside precision-only test) | **#2, and an honest #1-by-default story** | See the honesty note below. | [report](docs/benchmarks/2026-05-29-precisionmembench.md) |

A living cross-system comparison lives in
[docs/comparison-systems.md](docs/comparison-systems.md).

## We report the bad numbers too

The clearest example of how we think is PrecisionMembench, an outside test that
scores retrieval *precision* only and punishes any system that returns several
results and lets the model sort them out.

- gbrain's **default** scored **0.076 precision** on it. That looks bad, and we
  published it. It is bad *on this specific test* because gbrain's default is
  tuned to never miss the answer (recall stayed at 0.99), which is the right call
  for the general case.
- That result prompted a real feature: an opt-in setting that tightens how many
  results come back when the question wants a single answer. With it on, gbrain
  reaches **0.582 precision** at a third of the latency of the nearest
  general-purpose system, second only to a tool purpose-built for that one
  benchmark.

We left the honest 0.076 default in the README on purpose. A system you build on
should optimize for the real distribution of questions, not for topping a narrow
test, and it should tell you plainly when a number comes from a corner case.
Anti-gaming is built into the harness itself: sealed answer keys at the boundary,
tolerance bands from repeated runs, pinned judge versions, and randomized
question order.

## What we test, end to end

Each row is a real test with a committed pass/fail threshold. "Shipping" means it
runs in CI and gates releases.

| Area | What it checks | Bar | Status |
|------|----------------|-----|--------|
| Retrieval | Find the relevant page in rich prose at scale | recall@5 > 0.83 | shipping |
| Identity | Resolve aliases, handles, emails to one person | recall > 0.80 | shipping |
| Time | "As of last March", point/range/recency questions | as-of recall > 0.80 | shipping |
| Provenance | Cite which source a fact came from | accuracy > 0.90 | shipping |
| Linking | Connect related pages without false links | precision > 0.95 | shipping |
| Speed | Stay fast under load | p95 < 200ms | shipping |
| Skills | Agent behaviors do what they claim | all > 0.90 | shipping |
| Workflows | Full multi-step tasks, judged by rubric | 80% pass | shipping |
| Robustness | 22 adversarial inputs, never crash or corrupt | 100% | shipping |
| Multi-modal | Ingest PDF + audio + HTML correctly | text > 0.95, audio WER < 0.15 | shipping |
| Trust boundary | The agent-facing API can't be tricked into silent corruption | no corruption | shipping |

## Run it yourself

```sh
git clone https://github.com/garrytan/gbrain-evals.git
cd gbrain-evals
bun install          # pulls gbrain in as a library
```

**The public dataset (LongMemEval, 500 questions):**

```sh
mkdir -p ~/datasets/longmemeval
curl -Lo ~/datasets/longmemeval/longmemeval_s.json \
  https://huggingface.co/datasets/xiaowu0162/longmemeval/resolve/main/longmemeval_s

export OPENAI_API_KEY="sk-..."         # embeddings
export ANTHROPIC_API_KEY="sk-ant-..."  # only for the query-expansion variant

bash eval/runner/longmemeval-batch.sh         # all variants, parallel, resumable
bun eval/runner/longmemeval.ts --stratify 10  # fast 10-per-type sample
```

First run costs about $2 in embeddings; later runs hit a local cache and cost
roughly nothing.

**Our own suite (we call it BrainBench; no API keys, fully offline):**

```sh
bun run eval:run        # the full retrieval + behavior suite, about 15 min
bun run eval:run:dev    # one-shot smoke test
bun run eval:world:view # browse the fictional corpus the tests run against
```

**The precision test:**

```sh
bun eval/runner/precisionmembench.ts --mode gbrain-hybrid    # the honest default (0.076)
bun eval/runner/precisionmembench.ts --mode gbrain-adaptive --entity-max 1 --other-max 1  # 0.582
```

## The corpora

We test against content we can publish, so anyone can reproduce a result without
touching private data.

- **A 240-page fictional life** (2.0MB, committed): 80 people, 80 companies, 50
  meetings, 30 concepts, generated by Opus. Each page ships with a sealed answer
  key that never crosses into the system under test.
- **One messy fictional week** (2.1MB, committed): 50 emails, 300 chat messages,
  20 calendar events, 8 transcripts, 40 notes, with planted contradictions, stale
  facts, and deliberate junk, so we can test whether the brain stays straight when
  the input is realistic and noisy. Regenerate deterministically with
  `bun run eval:generate-amara-life` (seed 42).

## Repo layout

```
gbrain-evals/
├── eval/
│   ├── data/         the corpora + sealed answer keys + public datasets
│   ├── runner/       one file per benchmark (our suite, LongMemEval, ...)
│   ├── reports/      transient run output (gitignored)
│   └── cli/          browse + validate the corpus
├── docs/
│   ├── benchmarks/   the published scorecards, with their data and charts
│   └── comparison-systems.md
└── test/eval/        unit tests for the harness itself
```

## Contributing

- **Reproduce a result:** every scorecard names the commit it ran on.
  `git checkout <sha> && bun run eval:run`.
- **Score your own system:** implement an adapter against our interface, register
  it, run the suite, and open a PR with your scorecard. gbrain is one system under
  test, not the subject of the benchmark.
- **Add a test:** new benchmark file, wire it in, add a unit test, commit a
  baseline.

## License

MIT. The fictional corpora are fully made up and free to redistribute. The
vendored precision-test artifacts are MIT (tenurehq); see
`eval/precisionmembench/ATTRIBUTION.md`.

## Relationship to gbrain

This repo uses gbrain the way you would: it installs gbrain as a library and calls
its public interface. gbrain is the reference system under test here, but the
harness scores anything that implements the adapter interface, so the comparison
stays fair.
