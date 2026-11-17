# No-gbrain baselines for README's retrieval rows

Date: 2026-11-17. Preregistration: [PREREG.md](../../../plans/2026-11-17-readme-baselines/PREREG.md) (commit
`b9a4094b`). This folder adds the plain alternatives a developer would build instead of gbrain to three README rows,
on the same questions, ingestion orders and scorer as the published gbrain number, paired question by question with
gbrain's committed per-question records. No gbrain arm was run again.

## Takeaways

- **We learned that gbrain's relationship retrieval is what wins the attendance and one-hop template questions. You
  should turn it on when your notes carry typed relationships, such as a meeting's `## Attendees` list.** On "Who
  attended X?", gbrain found 80.3% of listed attendees in its top five; BM25 keyword search found 18.2% and plain
  Postgres hybrid search 24.7% (48 and 44 of 50 meetings better for gbrain, 0 worse; sign test p < 1e-12).
- **We learned that a plain BM25 keyword ranker finds as many answers on reworded one-hop relationship questions as
  gbrain with relationship retrieval on. You should not read the 0.411 to 0.537 gain as "better than plain search".**
  BM25 scored 0.616 recall at five against gbrain's 0.537 (19 questions better for gbrain, 33 for BM25, p = 0.070):
  no measurable difference at this sample size, with BM25 ahead on the point estimate. gbrain does beat vector-only
  search (0.438, p = 0.004) and plain hybrid search (0.467, p = 0.020) on the same questions.
- **We learned that most of gbrain's PrecisionMemBench precision comes from returning one result. You should cut any
  retriever to one result before crediting its ranking.** Plain hybrid cut to one result scored 0.563 precision and
  0.810 recall against gbrain tight mode with reranking at 0.586 and 0.825: no measurable difference (Holm p = 0.76
  for both). Only 5 of 63 paired cases differ in precision (4 favor gbrain, 1 plain hybrid).

## Results

Every row is retrieval only: no reader and no judge. Embeddings are OpenAI `text-embedding-3-large` at 1,536
dimensions, as in the gbrain rows. "Win" means gbrain is ahead and the preregistered paired test rejects at 0.05;
"no measurable difference" is not a claim that the two are equal.

| README row (gbrain build) | gbrain | Baseline | Baseline score | Paired test, gbrain minus baseline | Result |
|---|---:|---|---:|---|---|
| Reworded one-hop relationship questions, recall at five, relationship retrieval on (`3a284ae`) | 0.537 | BM25 (keyless) | 0.616 | 19 better / 33 worse / 93 same of 145; sign p = 0.070; mean -0.079, 95% CI -0.155 to -0.004 | no measurable difference |
| same | 0.537 | vector only | 0.438 | 27 / 9 / 109; p = 0.0039; mean +0.099, CI +0.033 to +0.167 | **win** |
| same | 0.537 | plain hybrid (full-text + pgvector, RRF) | 0.467 | 23 / 9 / 113; p = 0.020; mean +0.070, CI +0.007 to +0.134 | **win** |
| Meeting attendance, "Who attended X?" recall at five, relationship retrieval on, keyword path (`c5fb0201`) | 0.803 | BM25 (matched: gbrain's row used no embeddings) | 0.182 | 48 / 0 / 2 of 50; p = 7e-15; mean +0.621, CI +0.536 to +0.704 | **win** |
| same | 0.803 | plain hybrid (context: uses embeddings) | 0.247 | 44 / 0 / 6; p = 1e-13; mean +0.557, CI +0.467 to +0.644 | **win** |
| PrecisionMemBench precision, tight adaptive + reranking (`2efaaf8f`) | 0.586 | plain hybrid, one result (k = 1) | 0.563 | 63 cases defined on both: 4 better / 1 worse; cluster sign-flip p = 0.38, Holm 0.76; mean +0.042, CI -0.016 to +0.111 | no measurable difference |
| PrecisionMemBench recall, same | 0.825 | plain hybrid, k = 1 | 0.810 | 43 cases: 3 / 1; p = 0.75, Holm 0.76; mean +0.016, CI -0.054 to +0.085 | no measurable difference |

Each relationship and attendance question was asked on three ingestion orders (seeds 1 to 3, the gbrain receipts'
exact orders, checked by hash). The test pairs per question, averaging the three runs on each side. The intervals are
percentile bootstraps over questions (10,000 draws). PrecisionMemBench uses the test from `precisionmembench-s3.ts`
(each case its own cluster, seed 20261006, 10,000 draws, Holm across precision and recall); the exact sign test agrees
(p = 0.38 and 0.63).

**Context rows, not README claims.**

| Comparison | gbrain | Baseline | Paired result |
|---|---:|---|---|
| Reworded one-hop, relationship retrieval **off** (0.411) vs BM25 | 0.411 | 0.616 | 18 / 50; p = 0.0001: **loss** for gbrain's ordinary hybrid search |
| same, off vs vector only | 0.411 | 0.438 | 12 / 14; p = 0.85: no measurable difference |
| same, off vs plain hybrid | 0.411 | 0.467 | 8 / 14; p = 0.29: no measurable difference |
| Template one-hop wording ("Who works at X?"), on (0.763) vs BM25 | 0.763 | 0.624 | 35 / 8; p = 0.00004: win |
| Attendance, paraphrased wording ("Who took part in X?"), on vs BM25 | 0.260 | 0.238 | 9 / 7; p = 0.80: no measurable difference |
| same, on vs plain hybrid | 0.260 | 0.247 | 7 / 7; p = 1: no measurable difference |
| PrecisionMemBench, gbrain broad hybrid vs plain hybrid at its default ten results | precision 0.057, recall 0.988 | precision 0.103, recall 0.985 | precision: loss for gbrain (Holm p = 0.0002), but gbrain broad returns up to 20 beliefs and plain hybrid 10, so this measures return size; recall: no measurable difference |

## Why null?

- **Reworded relationship questions, BM25.** The relationship arm fired on 99 of 435 gbrain runs; on the rest gbrain
  answers with its ordinary hybrid search, which scores 0.411 and loses to BM25 on this corpus. The questions name an
  entity ("Who holds a stake in Acme?"), and world-v1's pages repeat that name in prose, so keyword
  overlap alone finds many answer pages. The sample (52 questions that differ) is enough to see the direction but not
  to reject. Verdict: FIX-METHOD for README's wording: say the relationship arm lifts gbrain's own search and that
  plain BM25 is as good on this split; the arm is not a cut candidate, because it wins on template wording and
  attendance.
- **PrecisionMemBench.** Both systems return about one belief per search, so the benchmark mostly measures whether the
  top result is right, and a plain hybrid's top result is right as often. The 77 cases leave few that can differ (5).
  The preregistered outcome for a tie applies: the precision gain comes from returning less, not from gbrain's
  ranking. Verdict: KEEP gbrain's tight mode (it is how gbrain gets there) and FIX-METHOD for the README claim.
- **Attendance, paraphrased wording (context).** gbrain's parser never recognized these wordings (0 of 150 fired), so
  gbrain runs plain search and matches the baselines.

## What could not be verified

- **PrecisionMemBench harness.** gbrain's 0.586 came from the older runner (`eval/runner/precisionmembench.ts`). The
  baseline ran through the newer system runner, which wraps the same vendored scorer and the same metric contract
  (mean per-case precision over cases where it is defined, here 64 for plain hybrid and 66 for gbrain; mean recall
  over the 43 cases where it is defined), so per-case scores pair directly. Two inputs differ: the newer runner sends
  upstream's own belief text (name, aliases, content, why it matters) where the old one wrote a Markdown page with
  "Also known as:", and it searches one namespace per user and scope where the old one searched by scope for every
  user. Dropping the one case that depends on user scoping (`isolation-user-scoping`) leaves the result unchanged
  (precision +0.043, p = 0.37). The old runner only runs gbrain, so no fully identical-harness baseline exists.
- **Ingestion orders.** BM25, vector and plain hybrid rank the same way whatever order pages arrive in, so their three
  runs per question are identical; the three orders add information only on the gbrain side.
- **Return size.** gbrain's relationship rows return 4.86 distinct pages on average; the baselines always return 5.
  Cutting each baseline to gbrain's page count on the same run moves BM25 0.616 to 0.616, plain hybrid 0.467 to 0.463
  and vector 0.438 to 0.434, so no conclusion changes.
- **gbrain build.** The gbrain numbers are the published ones at `3a284ae`, `c5fb0201` and `2efaaf8f`. Newer
  gbrain releases were not measured, by design. The vector arm calls gbrain's embedding client (at the repository's
  package pin) only to embed; no gbrain search, import or ranking code runs in any arm.
- **Smallest detectable difference.** The preregistration states none for these rows; the intervals above show what
  each sample can resolve.

## How the baselines work

- **BM25** (`eval/runner/adapters/grep-only.ts`): a classic keyword ranker over each page's title (counted twice),
  body and timeline, k1 1.5, b 0.75. No key needed.
- **Vector only** (`eval/runner/adapters/vector.ts`): one embedding per page, cosine similarity to the question.
- **Plain hybrid** (`PlainHybridSystem` in `eval/runner/systems/baselines.ts`): one row per page (or per belief) in
  Postgres, full-text search and pgvector search fused by reciprocal rank. `eval/runner/retrieval-baselines.ts` wraps
  it as a page adapter for the relationship and attendance questions;
  `eval/runner/precisionmembench-system.ts --system plain-hybrid` runs it on PrecisionMemBench.

Recall at five is the gbrain rows' definition: the first five distinct pages in rank order, gold pages among them
divided by gold pages (`eval/runner/metrics.ts`). For attendance the gold is the meeting page's own `## Attendees`
list, as in the gbrain row.

## Reproduce

From the repository root at this branch's head (`bun install` first; live arms need `OPENAI_API_KEY` and an open
budget-ledger run):

```bash
bun eval/runner/budget-ledger.ts open --runner readme-baselines-retrieval --budget-usd <dollars>
D=docs/benchmarks/2026-11-17-readme-baselines/retrieval
# relationship row (world-v1, paraphrase split)
bun eval/runner/retrieval-baselines.ts run --arm bm25 --split paraphrase --output $D/relationship/bm25-paraphrase.rows.json
bun eval/runner/retrieval-baselines.ts run --arm vector --split paraphrase --output $D/relationship/vector-paraphrase.rows.json --paid --budget-run-id <id>
bun eval/runner/retrieval-baselines.ts run --arm plain-hybrid --split paraphrase --output $D/relationship/hybrid-paraphrase.rows.json --paid --budget-run-id <id>
bun eval/runner/retrieval-baselines.ts pair --baseline $D/relationship/bm25-paraphrase.rows.json \
  --gbrain docs/benchmarks/2026-10-01-n9-multi-hop/relational-ab-3a284ae-paid.receipt.json --gbrain-arm on --output $D/relationship/bm25-paraphrase.vs-gbrain-on.json
# attendance row (world-v1-attendees, "Who attended X?")
bun eval/runner/retrieval-baselines.ts run --arm bm25 --split template --corpus eval/data/world-v1-attendees --template attended --output $D/attendance/bm25-template.rows.json
bun eval/runner/retrieval-baselines.ts run --arm plain-hybrid --split template --corpus eval/data/world-v1-attendees --template attended --output $D/attendance/hybrid-template.rows.json --paid --budget-run-id <id>
bun eval/runner/retrieval-baselines.ts pair --baseline $D/attendance/bm25-template.rows.json \
  --gbrain docs/benchmarks/2026-10-06-attendance-world/n9-hermetic-world-v1-attendees.json --output $D/attendance/bm25-template.vs-gbrain-on.json
# PrecisionMemBench
bun eval/runner/precisionmembench-system.ts --system plain-hybrid --policy-setting k=1 --output $D/precisionmembench/plain-hybrid-k1 --paid --budget-run-id <id>
bun $D/pair-pmb.ts --gbrain docs/benchmarks/2026-09-09-retrieval-refresh/precision-adaptive-rerank/attempt-2/2026-09-09-gbrain-adaptive-body-text-e1-o1-rerank-openai-text-embedding-3-large-1536-min1.json \
  --baseline $D/precisionmembench/plain-hybrid-k1 --output $D/precisionmembench/plain-hybrid-k1.vs-gbrain-tight-rerank.json
```

The same pattern gives the other files: `--gbrain-arm off` for the off-arm pairs, `--split paraphrase` for the
paraphrased attendance wording, and `--system plain-hybrid` without `--policy-setting` for the ten-result run, paired
against `precision-hybrid/attempt-2`. Every run finished in minutes on a 4-core machine. The keyless tests are
`bun test eval/runner/retrieval-baselines.test.ts` and the `plain-hybrid` block of
`test/eval/precisionmembench-system.test.ts`.

## Files

- `relationship/`: per-run rows for BM25, vector and plain hybrid (paraphrase), BM25 (template), and each pairing
  against gbrain on and off.
- `attendance/`: per-run rows for BM25 and plain hybrid (template and paraphrase wording) and their pairings.
- `precisionmembench/plain-hybrid-k1/` and `plain-hybrid-default/`: the system runner's full output (receipt,
  per-case rows, attempts, upstream report) and the per-case pairings.
- `pair-pmb.ts`: the PrecisionMemBench pairing script.
- `receipt.json`: models, dates, code commit and file hashes, the gbrain records paired, and per-run ledger usage.

## Disclosures

gbrain is Garry Tan's own project.
