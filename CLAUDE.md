# gbrain-evals — repo guide

This repo runs benchmarks against gbrain. It depends on `gbrain` as a library
(via the GitHub URL in `package.json`). Eval corpora and adapters live here so
gbrain itself stays small and benchmarks evolve independently.

## Repo layout

- `eval/runner/` — one `.ts` per benchmark family (cat13b-source-swamp,
  longmemeval, etc). Each runner produces a JSON in `eval/reports/` and an
  optional markdown summary.
- `eval/data/` — committed corpora (world-v1, source-swamp-v1, gold qrels,
  amara-life-v1) + content-addressed embedding caches. Anyone who clones gets
  warm fixtures.
- `eval/reports/` — gitignored. Transient run output. Baselines worth keeping
  get hand-copied into `docs/benchmarks/<slug>/`.
- `docs/benchmarks/` — published reports + the SVG charts they reference.
- `node_modules/gbrain` — symlink (when locally linked) or npm fetch (when
  pinned to a SHA in package.json). Link a local checkout for development:
  `cd ~/git/gbrain && bun link && cd ~/git/gbrain-evals && bun link gbrain`.

## When you write a benchmark report — the platonic ideal

The published report at `docs/benchmarks/<date>-<slug>.md` is the artifact a
reader stumbles into who has never heard of gbrain or the benchmark we're
running. **It must stand on its own.** No "see our docs," no "as we explained
in PR #X," no internal jargon without a gloss.

Every benchmark report MUST have these sections, in this order:

### 1. Headline (one viewport)

- Bold one-sentence verdict with the comparison: "gbrain hits 99.X% on the
  public LongMemEval `_s` split, X points above [closest published system]."
- A single SVG card showing the head-to-head numbers across systems.
- A short paragraph (2-3 sentences) naming what changed and why a reader
  should care.

### 2. What is gbrain

3-4 paragraphs of plain prose. Write for someone who has not heard of gbrain
before and has 60 seconds. Cover:

- Personal-knowledge brain that runs locally, no cloud lock-in, files on
  disk + Postgres index. Markdown source of truth, derived index.
- Hybrid retrieval: keyword + vector with RRF fusion + source-aware boost
  + optional Haiku query expansion. Each layer earns its keep on real
  retrieval workloads.
- "What's it for" — capturing notes, contacts, deals, decisions; recalling
  them weeks later when the context is gone; never losing the connection
  between two things you wrote down apart.

Link to the gbrain repo. Link to the gbrain CLI README. Don't repeat the
README; just give a reader enough to know whether they're in the right
neighborhood.

### 3. What is the benchmark

For LongMemEval and ConvoMem and any future public benchmark we support:

- Who built it. Link to the paper / HuggingFace / GitHub.
- What's in the dataset. Question count. Question types. Ground-truth shape.
- What metric we report (Recall@k, R@k, QA accuracy, etc.) and why we
  picked it. If we picked retrieval recall over end-to-end QA, say so and
  link the published QA evaluator.
- "Why this benchmark" — what failure mode does it stress that other
  benchmarks don't.

### 4. Adapters tested — every gbrain feature explained

For EVERY gbrain configuration in the comparison table, write a short
section that includes:

- **What this adapter is.** One sentence describing the retrieval pipeline.
- **What gbrain feature it exercises.** Name the actual code path:
  `engine.searchKeyword`, `hybridSearch`, `expandQuery`, the source-boost
  CASE expression in `sql-ranking.ts`, etc.
- **Why it would matter on this benchmark.** Tie it to the kind of
  question that exercises this layer.
- **Real-world use case.** What does this look like in a user's actual
  workflow? "Recalling a preference you stated three months ago" is a
  better example than "single-session-user question type."

Example for hybrid+expansion:

> **`gbrain-hybrid+expansion`** runs `hybridSearch(engine, query, {expansion: true, expandFn: expandQuery})`. The keyword + vector RRF stack from `gbrain-hybrid` plus a Claude Haiku call that rewrites the user's question into 2 alternative phrasings. All 3 phrasings hit the index; results fuse via RRF. This is gbrain's CLI default (`gbrain query` ships with expansion on).
>
> **Why it helps:** the question often uses different vocabulary than the answer. "What car issue did I mention?" doesn't share words with "the GPS isn't working right after my dealership visit." Vector embedding closes some of that gap; query expansion closes more by generating alternative phrasings the vector model can match.
>
> **Real-world parallel:** when you ask gbrain "who do I know who works in vertical AI" it doesn't just match "vertical AI" verbatim. Haiku expands to alternative phrasings like "AI for specific industries," "applied AI startups in narrow domains" — then RRF-fuses. Without expansion, narrow phrasings hide what's in the brain.

### 5. Results — head-to-head table

Required columns:
| System | Recall@k | k | n | LLM in retrieval loop | Source |

Include EVERY published system we can find at the same metric. MemPalace,
Stella, Contriever, BM25 all publish numbers on LongMemEval R@5;
they belong in the table. Mastra and Supermemory publish QA accuracy not
R@k — flag them as "different metric, not directly comparable" but keep
them in the table as context.

Bold the gbrain row(s).

### 6. Per-question-type breakdown

Required: a table with one row per question type, one column per gbrain
adapter. If competing systems published per-type breakdowns (MemPal does),
include those columns too. Identify the rows where gbrain wins by a wide
margin AND the rows where gbrain doesn't (1.7% of LongMemEval Q's land in
"temporal-reasoning slipped past top-K" — say so).

Always include a paragraph below the table picking out 1-3 illustrative
patterns. "Single-session-assistant goes from keyword 0% to hybrid 100% —
this is where vector retrieval pays for itself." Don't just dump tables.

### 7. Charts — committed SVG

Two charts minimum, generated by `eval/runner/longmemeval-chart.ts`:
- **Headline card** — head-to-head against published systems.
- **Per-type grouped bar chart** — one bar per adapter per question_type.

Inline SVG so GitHub renders without an image host. Both stored under
`docs/benchmarks/<date>-<slug>/`. Reference with relative paths.

### 8. Latency + cost

A small table:
| Adapter | p50 / question | p99 / question | per-1000 questions wall | per-1000 cost |

Be honest about cost. If the user can run gbrain-hybrid for $0.50 with the
embedding cache warm, and the headline number is 99%+, that's the story.
If the warm cache costs $50 to build the first time, say so. Don't hide it.

### 9. Limits & caveats

What this benchmark DOESN'T measure. Always include:

- Retrieval recall ≠ QA accuracy. The user model still has to write a
  correct answer from the retrieved context. We don't measure that here
  unless we ran the published QA judge.
- Sample size and K differences vs other published systems.
- Whether tuning happened (be explicit if any adapter was tuned on the
  benchmark vs held out).
- What's "not in scope" for this run that the user might ask about.

### 10. Reproduction

Exact commands. Verified to work on a fresh machine. Include:
- Repo clone
- `bun link gbrain` if pointing at a local checkout
- Dataset download URLs and target paths
- Required env vars (OPENAI_API_KEY, ANTHROPIC_API_KEY)
- The runner command(s) to reproduce the table
- Where the JSON + SVG land
- Roughly how long it takes and how much it costs

If we ship a warm embedding cache as a fixture (we do — see
`eval/data/longmemeval/embed-cache/README.md`), make this clear: the user
gets sub-1-min retrieval-only runs without paying $5 for first embedding.

### 11. Methodology details

- Adapter implementations (what gbrain code path each exercises).
- Whether expansion was on or off (and why).
- Top-K rationale.
- Engine recycling, reset semantics, dim mismatch guards.
- Stratification rules if applied.
- Determinism notes (cache, seeded sampling, embedding model
  determinism).

### 12. Files

Bullet list of exactly which files in this repo + which gbrain commit are
involved. Read-only; nothing the reader has to do, just full disclosure.

## Voice rules (carried from gbrain CLAUDE.md)

- Lead with the point. Real numbers. Concrete files + line numbers.
- No em dashes. No AI vocabulary (delve, robust, comprehensive, nuanced,
  fundamental, etc.). No marketing copy.
- Tie technical choices to user outcomes. "The agent does ~3x less reading"
  beats "improved precision."
- Be direct about quality and limits. If gbrain loses on a question type,
  say so; don't bury it in caveats.
- Sound like a builder talking to a builder.
- Privacy rule: no real names from the brain in any public artifact. Use
  generic placeholders for examples. (Public benchmarks like LongMemEval
  use synthesized question_ids; those are fine to quote as-is.)

## Workflow when running a new benchmark

1. **Spec first.** Write the report skeleton at
   `docs/benchmarks/<date>-<slug>.md` with all 12 sections marked
   "[pending]". This forces you to think about every section before any
   numbers exist.
2. **Build the runner** at `eval/runner/<slug>.ts`. One file. Imports from
   `gbrain/*` subpath exports. Outputs JSON to `eval/reports/<slug>/`.
   Stratified-sample support if the dataset is too big for full runs.
3. **Smoke first.** Run with `--limit 10` or `--stratify 2`. Verify the
   adapters work and the output JSON is well-formed. Cheap.
4. **Build a chart generator** at `eval/runner/<slug>-chart.ts` (or extend
   `longmemeval-chart.ts` if the shape generalizes). Inline SVG only.
5. **Run the full thing** with all adapters. If embedding-heavy, warm the
   cache once on a smoke run, then commit it as a fixture.
6. **Fill in the report** against the spec above. Every section. No
   placeholders shipped.
7. **Commit + push to main.** Solo repo, direct commits OK. No branch
   protection rules to dance around.

## When you ADD a gbrain feature that affects retrieval

You owe a benchmark. Pick the right one:
- Source-boost-related → cat13b-source-swamp-v1
- Query expansion / model routing → longmemeval-s (six question types
  stress retrieval differently)
- Code-aware retrieval → cat13 conceptual-recall + a code-corpus follow-up
- Cross-source federation → world-v1 multi-source mode

Don't ship the gbrain feature without an updated benchmark line. Even if
the number doesn't move, the regression test is the deliverable.

## Comparing against other systems

Keep a running list at `docs/comparison-systems.md` (create if missing):
which systems published which numbers on which benchmarks, with link to
source. Update whenever a new system publishes a relevant number.

When MemPalace ships v3.5 (or whatever) and re-publishes a R@5 number,
update the head-to-head table in the relevant report — don't quietly let
old numbers stay. The benchmark page is a living artifact, not a one-time
publication.
