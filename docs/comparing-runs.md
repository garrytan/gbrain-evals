# Comparing two runs, and keeping the answer key away from the system

This page explains two pieces of evaluation machinery added in v0.10.4. The
first answers "did change B make gbrain better or worse than A, on the same
questions?" with paired statistics and a preregistered decision rule. The second
makes sure the system under test never sees the answer key while it is being
measured. Both come from amendments 4 and 6 of the September 28, 2026 plan, which
an independent reviewer added after finding that a comparison command printed a
bootstrap label without computing one, and that the only leak check searched for
one known string.

Nothing on this page is a new quality measurement of gbrain. The one worked
example recounts rows that were already published.

## Paired comparisons: `eval/runner/compare.ts`

Two runs over the same questions are paired data. A question that both runs get
right, or both get wrong, says nothing about which run is better; only the
questions where they differ do. The comparator uses that structure instead of
comparing two headline percentages.

```bash
bun eval/runner/compare.ts A.ndjson B.ndjson --metric recall_all --exclude-when is_abs=true
bun eval/runner/compare.ts A.ndjson B.ndjson --family family.json
```

A is the baseline and B the candidate. Each input is one JSON row per question
(NDJSON), a JSON array, or a JSON document with `--rows-path` (for example
`--a-rows-path per_query.gbrain --b-rows-path per_query.vector` on a Cat13
report). `--where adapter=gbrain-hybrid` selects rows on both sides.

### What it refuses to do

- **Compare different question sets.** Every id must be unique on each side and
  present on both. A missing or duplicated id blocks the comparison and names the
  id.
- **Quietly shrink the denominator.** One eligibility rule runs on both sides.
  Abstention items (`--exclude-when`) and harness, dependency or judge failures
  are ineligible; a failure of the system under test is a scored miss, following
  the repository's probe-accounting rule. If a question is eligible on one side
  and not the other, for example because a provider call failed only in run B,
  the comparison is blocked rather than dropping that question.
- **Count paraphrases as independent evidence.** Each item has a cluster id
  (`--cluster-by`, for example the target concept in Cat13). Intervals resample
  whole clusters and the significance test flips whole clusters. Ten paraphrases
  of one concept count as one unit, and the output reports how much clustering
  inflated the variance. Use clusters for groups of related items, not for broad
  strata: clustering LongMemEval by its six question types leaves six units and
  almost no power.

### What it reports

For each metric: the paired counts, the absolute change `mean(B) - mean(A)` with
a clustered 95% bootstrap interval, a clustered sign-flip p-value (exact up to 20
clusters), the exact McNemar test for yes/no outcomes, and a power note. The
power note gives the smallest change the design could detect with 80% power, and
the fact that an exact McNemar test needs at least 6 wins and no losses to reach
p < 0.05. A null result on a small set is labeled as not evidence of no effect.

The statistics generalize the family-clustered bootstrap, sign-flip test and
Holm correction in `eval/runner/situation-recall-regression.ts`. A test checks
that both give identical intervals and p-values on mean metrics.

### Worked example: a recount of published rows

The September 6 ranking report states that adding the Voyage reranker (A2)
gained 18 strict hits and lost 8 against plain hybrid search (A1), on the 470
answerable LongMemEval-S questions. The comparator reproduces that from the
committed rows:

```bash
D=docs/benchmarks/2026-09-06-longmemeval-ranker-wave/longmemeval
bun eval/runner/compare.ts $D/A1-hybrid-rerank-off-autocut-off.ndjson \
  $D/A2-hybrid-rerank-on-autocut-off.ndjson --metric recall_all_hit --exclude-when abstention=true
```

| Measure | Value |
|---|---|
| Pairs (answerable questions) | 470, with 30 abstention questions ineligible on both sides |
| Strict `recall_all@5`, A1 then A2 | 439/470 (93.40%), 449/470 (95.53%) |
| Paired change | +2.13 points, clustered 95% interval 0.00 to +4.26 (each question its own cluster) |
| A2 wins / losses | 18 / 8, exact McNemar p = 0.0755 |
| Detectable change at 80% power | about 3.0 points |

So the reranker gain the report describes is real in these rows, but on its own
it does not reach p < 0.05, and a change of that size is below what 470
questions can reliably detect. This is a recount of existing rows, not a new run.

## The three gates

A comparison family is a JSON file written before the runs it judges. It names
each comparison, its metric, its cluster and its gate. The example below is an
illustration; `raw_id_leaks` stands for a per-question safety count that a runner
would record:

```json
{
  "schema_version": 1,
  "family_id": "lme-s-example",
  "registered_at": "2026-09-29",
  "alpha": 0.05,
  "seed": 20260929,
  "draws": 10000,
  "min_clusters": 10,
  "id_field": "question_id",
  "exclude_when": ["is_abs=true"],
  "comparisons": [
    { "id": "no-raw-ids", "metric": "raw_id_leaks", "gate": "exact", "assertion": { "kind": "every_b_equals", "value": 0 } },
    { "id": "strict-recall", "metric": "recall_all", "gate": "noninferiority", "direction": "higher", "tolerance": 0.01, "cluster_by": "question_id" },
    { "id": "latency", "metric": "latency_ms", "gate": "exploratory", "direction": "lower" }
  ]
}
```

- **Exact gates** cover correctness and safety. One violating item fails the
  family immediately; no p-value is computed and none can excuse it. When an
  exact gate fails, the statistical gates are not run. Three newly broken
  known-correct cases fail here even though their McNemar p-value is 0.25.
  Assertions: `every_b_equals`, `b_at_most`, `b_at_least`, and
  `no_item_regression` (no item may get worse).
- **Non-inferiority gates** cover noisy quality metrics. B passes only when it is
  shown to be no worse than A by more than the stated tolerance: the
  Holm-adjusted one-sided p-value is at most alpha, which means the lower end of
  the interval clears minus the tolerance. A wide interval is "inconclusive", not
  a pass, because failing to find a difference is not proof that none exists. An
  interval entirely below minus the tolerance is a fail. Fewer clusters than
  `min_clusters` is inconclusive.
- **Exploratory metrics** are reported with unadjusted p-values and never affect
  the verdict. Metrics given on the command line but missing from the family are
  added as exploratory and labeled as outside it.

Holm correction runs over the non-inferiority comparisons, the family's
confirmatory tests. Exit status: 0 pass (or exploratory only), 1 fail, 2
inconclusive or blocked.

## The independent evaluator

gbrain and this repository share ingestion and product calls, but scoring stays
on the evaluator's side (`eval/runner/evaluator/`).

- **Gold store.** Evidence labels and reference answers live in a private field
  of a `GoldStore`. It hands out scores, not labels; serializing it prints only
  its name, size and fingerprint.
- **Separate gold loader.** The LongMemEval runner now keeps only gold-free
  question views. The evaluator reads the dataset file itself and refuses to
  continue if the bytes differ from what the runner read. Cat13 gold comes from a
  separate read of the corpus, and the runner's probes must match it id for id and
  text for text, so shifted or permuted labels cannot be scored.
- **Reference scorer.** The metrics are reimplemented from their definitions
  without importing the product or `metrics.ts`. Tests hold it to the historical
  scorers on hand-computed rankings and 2,000 random cases. Repeated ids are
  counted and never credited twice.
- **Input allowlist.** Every payload sent to the system under test (LongMemEval
  pages and queries, Cat13 pages and queries) or to the LongMemEval reader is
  checked against a declared shape. Undeclared fields at any depth, non-plain
  objects (including the gold store itself), accessors and symbols are refused.
  So is any raw dataset session id appearing more often than the conversation
  text itself accounts for, which catches a leak whether or not the id starts
  with `answer_`. A violation voids the run instead of counting as one failed
  question. Receipts record the gold-store fingerprint, the loader, the scorer
  version and the boundary names under `resolved_config.evaluator`.

`test/eval/evaluator-adversarial.test.ts` holds the cases the evaluator must
catch: known rankings, permuted labels, removed metadata, duplicate ids, an empty
system, wrong answers, and adapters that leak gold, return nothing or return
duplicates.

### Limits

The separation is in-process. A product running in the same process could still
open dataset files from disk; the receipts say so (`isolation: in-process`).
Process isolation, and applying the allowlist to the other runners that talk to
readers or judges (reading notes, Cat29, Cat35), are open work.
