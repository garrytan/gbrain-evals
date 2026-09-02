# gbrain-evals

The test suite for [gbrain](https://github.com/garrytan/gbrain), the long-term
memory an AI agent reads from and writes to — and the public record of how it
stacks up against every memory system that publishes numbers.

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

## Where gbrain beats the field

Head-to-head, against every system with a published number we can find
(sources + caveats in [docs/comparison-systems.md](docs/comparison-systems.md)):

| Arena | gbrain | Best competitor | The gap |
|---|---|---|---|
| **Reading memory back** (LongMemEval retrieval component, `longmemeval_s` cleaned Sept-2025 revision, 500 public questions, 470 scored; not end-to-end QA) | **93.19% official `recall_all@5` reranker off** (438/470; hybrid, k=5, the like-for-like row) **/ 95.32% with the default Voyage reranker** (448/470; `voyage:rerank-2.5`, the release default path), both 2026-09-02 at gbrain v0.48.2.0 · any-hit@5 98.72% / 99.79% (diagnostic only), no LLM in the retrieval loop (the reranker row adds one Voyage rerank call per query, no generative model) | MemPalace publishes any-hit only (96.6% raw, 98.4% tuned held-out, a since-retracted 100%); our recomputation of their committed per-question rankings under the strict metric gives **85.7%** raw (403/470), 88.7% on the tuned held-out subset (376/424), and **90.0%** with an LLM reranking the top 20 (423/470). ContextFit self-reports strict All@5 **87.45%** (411/470, 2026-05-24; loosely comparable, its rerank layer reads gold labels) and 98.94% any-hit. The LongMemEval paper's dense retrievers score 0.706 / 0.732 strict recall@5 on the harder M split (a floor, not a peer). The 90-96% figures from Mastra, Mem0, MemCog, Zep, Hindsight, ByteRover and Supermemory are LLM-judged answer accuracy: a different race, and one gbrain has not published a run in | On the strict official metric (ALL gold sessions in the top 5) we found no published score above 93.19% on this dataset (our reranker-off row; the release default path scores 95.32%), with two caveats: the two closest strict comparisons are our own recomputations of MemPalace's files, and the field is thin. The history stays public: 83.4% in May 2026 at v0.28.8 (that report led with 97.60% any-hit, 488/500 with abstentions counted, 97.66% on the 470 scored; now a diagnostic only); an unreleased keyword-fallback fusion regression dropped hybrid to 51.3% between v0.28.8 and v0.48.0.0 (re-measured 2026-09-02 at the v0.47.8.0 pin: 51.39%); v0.48.0.0 fixed it to 93.19%, and the v0.48.2.0 re-run reproduces that receipt exactly with the reranker off and lifts it to 95.32% with the default `voyage:rerank-2.5` on (18 questions gained, 8 lost, paired). Ceiling at k=5 is 99.4% (3 questions carry 6 gold sessions). Pure vector on the same corpus scored 93.8% (v0.48.0.0 receipt), so hybrid is roughly neutral on this benchmark. The other v0.48.2.0 arms, same run: session-diversity over-fetch 93.40% (adds one question over hybrid; slot starvation is not the miss class) and 95.53% with the reranker; tokenmax's LLM multi-query expansion 54.89%, harmful at k=5 (3 gained, 183 lost against hybrid). gbrain's retrieval costs ~$0.50 per 1,000 questions with the embedding cache warm ([sources + caveats](docs/comparison-systems.md); [report + re-run](docs/benchmarks/2026-05-07-longmemeval-s.md)). |
| **Writing memory down** (Cat 35, agent-session distillation) | **88.1% of salient content survives** into pages rated 91% usable, 1.2% junk leakage (1/86 distractors), all 20 sessions emit | **Nobody.** No other system publishes write-path numbers for agent working sessions at all (HaluMem, the only other write-path benchmark, covers persona-chat memory points) | gbrain is the only memory system that measures — and publishes — whether the important stuff from a working session actually survives into memory, including whether the emotional tenor survives. First benchmark of its kind. |
| **Volunteering memory at the right moment** (Cat 34, 149 gold turns) | **0 know-to-ask failures, push precision 1.0, write-back fidelity 1.0, 0 cross-source leaks** | **Nobody publishes comparable numbers.** We can't find another memory system that measures whether the right memory shows up *unprompted* at the right turn | The failure mode users actually feel — "my agent should have known that" — measured and at zero on every harness seam. Run receipts are committed under [docs/benchmarks/2026-06-12-brainbench-memory/](docs/benchmarks/2026-06-12-brainbench-memory/) (June originals plus a labeled re-run at the pin), and current-baseline numbers cite gbrain's `evals/brainbench/baselines/main.json` at the pinned SHA. |
| **Precision under a hostile metric** (PrecisionMemBench, outside benchmark) | **0.582 precision at ~270ms** with adaptive return-sizing on (an upper bound pending re-run on the fixed harness: the audit removed a seed-time shortcut from our adapter) | supermemory 0.43 at 819ms (the leaderboard revision our May run compared against; the author's current table lists supermemory at 0.22, see [comparison-systems.md](docs/comparison-systems.md)) | Even read as an upper bound, it clears the nearest general-purpose system on both axes at a third of the latency; #2 overall behind only the benchmark author's purpose-built belief store. The hermetic keyword mode has already re-measured on the fixed harness (0.139 to 0.136); the adaptive row republishes when the keyed re-run lands. |
| **Relational recall vs the default RAG stack** (240-page corpus) | **97.9% R@5 / 49.1% P@5** (pre-audit metrics, re-measure pending: the run predates the audit's metric-helper fixes and ran on a corpus that carried dangling links) | plain vector RAG (same embedder): 38 points less precision on the same pre-audit harness | The graph layer is worth ~30 points of precision on its own in that run; both sides ran on the same harness, so the gap is the sturdier claim than either absolute number. This is the gap between gbrain and the vector-store default that most memory products ship. |

Three things nobody else in this space does at all:

- **A measured write path.** Every competitor publishes read-side retrieval
  scores. gbrain also publishes what fraction of a session's salient content
  survives *into* memory — the half of the problem that determines whether
  there's anything worth retrieving later.
- **A self-auditing benchmark suite.** In August 2026 we ran a 35-agent audit
  of this suite against itself, published all
  [239 findings](docs/audit/2026-08-31-eval-audit.md) (236 fixed), issued
  errata instead of silently editing history, and put falsifiable gates plus
  hermetic CI behind every number. When you read a gbrain score, you can read
  the machinery that produced it and every bug that machinery ever had.
- **Benchmarks that bite back.** Cat 35's first published run scored 61.5%
  with 4 sessions producing no page at all. gbrain shipped a fix wave aimed at
  exactly those failures and the re-run hit 88.1%. A benchmark that can't fail
  can't do that.

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

## The numbers, report by report

| What we measured | Result | Plain English | Report |
|---|---|---|---|
| **LongMemEval** (public dataset, `longmemeval_s` cleaned Sept-2025 revision: 500 questions over long chat histories, 470 scored) | **93.19% official `recall_all@5` reranker off / 95.32% with the default Voyage reranker** (438/470 and 448/470; 2026-09-02, gbrain v0.48.2.0, k=5) · any-hit@5 98.72% / 99.79% (diagnostic) | Under the official metric, ALL of a question's gold sessions in the top 5, hybrid search at k=5 with the reranker off scores 93.19% (n=470, the 30 abstention questions excluded per the official protocol), reproducing master's v0.48.0.0 receipt exactly. By type: knowledge-update 98.6%, multi-session 92.6%, single-session-assistant 100%, single-session-preference 96.7%, single-session-user 98.4%, temporal-reasoning 84.3% (the weakest, and the next target). Median 3.7 s per question, 0 errors. With the release default reranker `voyage:rerank-2.5` on (the `balanced` and `tokenmax` modes run it), the same run scores 95.32% (448/470): 18 questions gained and 8 lost against reranker-off hybrid, temporal-reasoning up to 89.8%, knowledge-update and every single-session type at 100%, median 3.8 s per question, 0 errors. The reranker-off row stays the like-for-like comparison against May and v0.48.0.0. The May 2026 run at v0.28.8 scored 83.4% on the same metric (its 97.60% headline was any-hit, 488/500 with abstentions counted, 97.66% on the 470 scored, and stays reproducible from the same rows); between the two, an unreleased keyword-fallback fusion regression took hybrid to 51.3%, re-measured this run at the v0.47.8.0 pin (51.39%) and fixed in v0.48.0.0. Same run, the other arms: hybrid-sessdiv (3x over-fetch, top-5 distinct sessions) 93.40%, one question over hybrid, so slot starvation is not the miss class; hybrid-sessdiv+rerank 95.53%; hybrid+expansion (tokenmax's LLM multi-query expansion) 54.89%, 183 questions lost and 3 gained against hybrid, harmful at k=5 (49.6% on the v0.48.0.0 receipt). **Erratum resolved 2026-08-31** at $0 from the archived per-question stream, ground truth re-validated 500/500. | [report + re-run](docs/benchmarks/2026-05-07-longmemeval-s.md) |
| **Relational questions** ("who introduced X to Y?") on a 240-page fictional life | **97.9% recall@5, 49.1% precision@5** (pre-audit metrics, re-measure pending) | Beats plain vector search by 38 points of precision on the same pre-audit harness. The graph layer (who-knows-whom) is worth about 30 of those points on its own. This run predates the audit's metric-helper fixes and a corpus dangling-link fix; v0.5.0 declared earlier BrainBench scores not comparable across that boundary. | [report](docs/benchmarks/2026-04-23-brainbench-v0.20.0.md) |
| **Stability across 20 releases** (v0.20.0 → v0.40.6.0) | **zero regression** | The headline numbers stayed identical, release after release. New features did not quietly make retrieval worse. | [report](docs/benchmarks/2026-05-23-v0.40.6.0-snapshot.md) |
| **PrecisionMembench** (an outside precision-only test) | **#2, and an honest #1-by-default story** | See the honesty note below. | [report](docs/benchmarks/2026-05-29-precisionmembench.md) |
| **SkillOpt** (can a skill improve itself, without cheating?) | **4/4 skills 0 → 1.00; cheating blocked; gains transfer** | Deficient skills rewrote themselves to perfect on held-out tasks; a keyword-stuffing cheat is caught by an independent judge; a skill optimized on one model works on another. | [report](docs/benchmarks/2026-06-03-skillopt.md) |
| **Transcript distillation** (Cat 35: does the important stuff from an agent session survive into a brain page?) | **88.1% salient-unit recall, all 20 sessions emit, 91% usable** | First benchmark to measure the write path for agent working sessions (HaluMem covers persona-chat memory points), including whether the emotional tenor survives. It earned its keep immediately: the first published run scored 61.5% with 4 sessions never producing pages, gbrain ran a fix wave aimed at exactly those failures (v0.47.8.0), and the bracketed re-run keeps 88% of what matters (vs a 93% judge ceiling) with hallucination halved to 7%, quote fidelity up from 45% to 83%, and 1.2% distractor leakage (1/86). One gate stays open: the human judge-calibration sample (weighted kappa, report §11) is still pending. | [report](docs/benchmarks/2026-08-16-brainbench-cat35-transcript-distill.md) |
| **Memory conformance** (Cat 34: does the right memory volunteer itself at the right moment, on every harness?) | **0 know-to-ask failures, push precision 1.0, recall 0.91 on the production seam** (the codex contract seam scores 0.552: a 1-fragment injection budget, not a retrieval miss) | Across 149 gold turns the agent never has to be told what it should already know, junk is never injected, and nothing leaks across sources. The first published run missed 9 know-to-ask turns; the committed CI baseline gates every gbrain PR against these numbers, and the misses were fixed upstream within releases. Receipts are committed under [docs/benchmarks/2026-06-12-brainbench-memory/](docs/benchmarks/2026-06-12-brainbench-memory/) (June originals plus a labeled re-run at the pin); current-baseline numbers cite gbrain's `evals/brainbench/baselines/main.json` at the pinned SHA. | [report](docs/benchmarks/2026-06-12-brainbench-memory.md) |

A living cross-system comparison lives in
[docs/comparison-systems.md](docs/comparison-systems.md).

## We report the bad numbers too

The clearest example of how we think is PrecisionMembench, an outside test that
scores retrieval *precision* only and punishes any system that returns several
results and lets the model sort them out.

- gbrain's **default** scored **0.075 precision** on it. That looks bad, and we
  published it. It is bad *on this specific test* because gbrain's default is
  tuned to never miss the answer (recall stayed at 0.99), which is the right call
  for the general case.
- That result prompted a real feature: an opt-in setting that tightens how many
  results come back when the question wants a single answer. With it on, gbrain
  reaches **0.582 precision** at a third of the latency of the nearest
  general-purpose system, second only to a tool purpose-built for that one
  benchmark. That 0.582 is an upper bound until the re-run on the fixed
  harness lands: the audit removed a seed-time shortcut from our adapter, and
  the hermetic keyword mode already re-measured 0.139 to 0.136 on the fixed
  harness.

We left the honest 0.075 default in the README on purpose. A system you build on
should optimize for the real distribution of questions, not for topping a narrow
test, and it should tell you plainly when a number comes from a corner case.

The same discipline applies to our own harness: the 2026-08-31 audit
([full report](docs/audit/2026-08-31-eval-audit.md)) turned 35 agents loose on
this suite, adversarially verified 239 findings against the code, fixed 236 of
them, and published the lot — including the metric bug behind the LongMemEval
erratum above. The head-to-head claims survive because they are scoped to what
the machinery can actually prove. That is the difference between this table
and a landing page.
Anti-gaming is built into the harness itself: sealed answer keys at the boundary,
tolerance bands from repeated runs, pinned judge versions, and seeded
randomization where order could bias a result (page-ingestion order is shuffled
per run in the BrainBench scorer; LongMemEval samples are drawn by a seeded
per-type shuffle via `--seed`, not first-N). Questions themselves run in fixed
dataset order, so results are reproducible line for line.

## What we test, end to end

Each row is a real test with a committed pass/fail threshold. "Shipping" means
the hermetic form runs in this repo's CI on every PR (typecheck, unit suite,
keyless runner subset, data-integrity gate, qrels + baseline retrieval gate);
rows needing API keys run manually and land receipts under `eval/reports/`.

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
# The cleaned Sept-2025 revision (every published gbrain number uses it);
# the runner reads it from the longmemeval_s.json path.
curl -Lo ~/datasets/longmemeval/longmemeval_s.json \
  https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json

export OPENAI_API_KEY="sk-..."         # embeddings
export ANTHROPIC_API_KEY="sk-ant-..."  # only for the query-expansion variant
export VOYAGE_API_KEY="pa-..."         # only for the rerank variants (no key = adapter skipped, and the receipt says so)

# Pass the embedding model in provider:model form; the receipted run used
# openai:text-embedding-3-large at 1536 dims. Without --adapters the runner
# defaults to the four legacy adapters (keyword, vector, hybrid, hybrid+expansion).
bash eval/runner/longmemeval-batch.sh \
  --adapters hybrid,hybrid+expansion,hybrid-sessdiv,hybrid+rerank,hybrid-sessdiv+rerank \
  --embedding-model openai:text-embedding-3-large --embedding-dims 1536   # the five published arms, parallel, resumable (K=5)
bun eval/runner/longmemeval.ts --top-k 5 --stratify 10 \
  --embedding-model openai:text-embedding-3-large --embedding-dims 1536   # fast 10-per-type sample at the published K
```

The runner pins search mode `balanced` with the reranker and autocut off for
every adapter, and pins `voyage:rerank-2.5` on for the `rerank` specs, so a
missing reranker key can never be scored as a reranked run.

First run costs about $2 in embeddings; later runs hit a local cache and cost
roughly nothing.

**Our own suite (we call it BrainBench):**

```sh
bun run eval:run        # the full retrieval + behavior suite, about 15 min
bun run eval:run:dev    # one-shot smoke test
bun run eval:world:view # browse the fictional corpus the tests run against
```

Honesty note on keys: the keyword/BM25 and graph adapters are fully offline;
the vector and hybrid adapters embed with OpenAI, so `eval:run` wants
`OPENAI_API_KEY` (first run ~$2, then the local embedding cache makes reruns
free). Keyless runs cover the offline subset and say so in their receipts
instead of silently passing.

**The precision test:**

```sh
bun eval/runner/precisionmembench.ts --mode gbrain-hybrid    # the honest default (0.075)
bun eval/runner/precisionmembench.ts --mode gbrain-adaptive --entity-max 1 --other-max 1  # 0.582 (upper bound, pending re-run on the fixed harness)
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
- **24 fictional agent sessions** (committed): coding, ideation, deal,
  emotional-processing, mixed routine-signal, and pure-routine control
  conversations with 173 planted salient units (each with a verbatim anchor),
  86 true-but-routine distractors, and 2 attribution hazards — the Cat 35
  write-path corpus. Regenerate with
  `bun run eval:generate-transcript-distill` (seed 350001; ~$6 without the local
  Opus cache, under $1 with it — the Haiku audit pass always re-runs).

## Repo layout

```
gbrain-evals/
├── eval/
│   ├── data/         the corpora + sealed answer keys + public datasets
│   ├── generators/   deterministic corpus builders (skeleton + cached LLM prose)
│   ├── runner/       one file per benchmark (our suite, LongMemEval, ...)
│   ├── reports/      transient run output (gitignored)
│   └── cli/          browse + validate the corpus
├── docs/
│   ├── benchmarks/   the published scorecards, with their data and charts
│   └── comparison-systems.md
├── scripts/          postinstall shim (links pglite for the pinned gbrain) + runners
└── test/eval/        unit tests for the harness itself
```

## Contributing

- **Reproduce a result:** every scorecard names the commit it ran on.
  `git checkout <sha> && bun install --frozen-lockfile && bun run eval:run`.
  The gbrain dependency is pinned to an exact SHA in `package.json` and the
  lockfile is committed, so a checkout resolves the same bits that produced
  the scorecard. (Scorecards dated before 2026-08-31 predate the pin — the
  dependency floated on `#master` then, so those runs are reproducible only
  approximately; each report names the gbrain version it ran against.)
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
its public interface. (One exception: the Cat 35 write-path runner deep-imports
three ingest/extract/synthesize internals from `gbrain/src`, which is why the
dependency is pinned to an exact SHA.) gbrain is the reference system under test
here, but the
harness scores anything that implements the adapter interface, so the comparison
stays fair.
