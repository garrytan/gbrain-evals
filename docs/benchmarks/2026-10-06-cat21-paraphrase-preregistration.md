# Preregistration: Cat 21 code search on questions that don't name the symbol (W5)

Written 2026-10-06, before any embedder ran on the new questions. Plan: [W5 in the 2026-10 follow-up round](../plans/2026-10-06-followups-round/PLAN.md). Results go to [`2026-10-06-cat21-paraphrase/`](2026-10-06-cat21-paraphrase/).

## Question

Does a code-tuned embedder find the right source file better than a general one when the question describes behavior instead of naming the function? On 2026-10-02 every Cat 21 question named its symbol, so the keyword arm found it and both embedders tied at 12/12. The answer decides whether gbrain's `reindex --code` recommendation (switch to a Voyage code embedder for code-heavy brains) has evidence behind it.

## Evidence class

Development evidence. The 24 questions were written by an agent who read the 12 known gold files, so they are written around the answers. Nothing here is a held-out confirmation.

## Build and data

- gbrain `c5fb0201d1960a0a5a81c35d77718311b03154b7` (v0.60.95.0), installed as `node_modules/gbrain`.
- Corpus: 60 TypeScript files from gbrain's `src/core` at that commit, the runner's existing construction: the 12 gold files plus 48 distractors ordered by FNV-1a hash of their path, each body cut at 36,000 characters, ingested as markdown-wrapped code with `importFromContent`. Each cell builds its own fresh in-memory PGLite brain.
- Questions: the 12 named questions in `QUERIES` (split `named`, regression) and [`eval/data/cat21-paraphrase-v1/questions.json`](../../eval/data/cat21-paraphrase-v1/questions.json), 24 questions, sha256 `63f8401d69a7d920f794584a5afce0540fa7b9342f8ce0f444da2f794fa9e713` (split `paraphrase`, primary). Both splits run in one invocation (`--split both`), so each cell answers all 36 questions from the same index.

## Arms

Three embedders, otherwise identical. Search is pinned in every cell to `balanced` mode with the reranker, query expansion and autocut off and a 1,000,000-token budget, and the runner verifies per query that the reranker did not fire and the vector arm did not degrade.

| Cell | Embedder | Dimensions |
|---|---|---|
| `voyage-code-3` | `voyage:voyage-code-3` | 1,024 |
| `voyage-code-4` | `voyage:voyage-code-4` | 1,024 |
| `openai-default` | `openai:text-embedding-3-large` | 1,536 |

No model generates or judges anything. There is no comparator by default; all three pairwise comparisons are tested.

## Metric and denominator

Per cell and split: mean reciprocal rank (MRR) of the gold file among the deduplicated pages of the top 30 chunks (primary), recall at 5 and first-place hits (secondary). The paraphrase denominator is 24 questions per cell; the named denominator is 12. A query that errors, degrades to keyword-only or trips a pin scores 0 in the paired analysis and makes its cell invalid under the runner's existing rule. Analysis unit: the question. Cluster: the gold file (12 clusters of 2 paraphrase questions each).

## Decision rule

Primary comparison: the three pairwise MRR differences on the paraphrase split, each a paired difference clustered by gold file, tested with the exact sign-flip test over the 12 files (4,096 patterns) and given a cluster-bootstrap 95% interval (seed 20261006, 10,000 draws), Holm-corrected across the three. The keyless script `eval/runner/cat21-paired.ts` computes all of it from the receipt. Recall at 5 gets the same analysis with its own Holm family and is report-only. The named split keeps its existing regression gate (each valid cell MRR at least 0.5) and its comparisons are report-only.

Minimum detectable effect: with 12 clusters, a Holm-adjusted p under 0.05 needs roughly 11 of 12 files to move the same way; 10 of 12 gives a two-sided p of 0.039 before correction and 0.12 after. In MRR terms that is a difference of roughly 0.15 or more.

Non-inferiority margin for "tie" wording: 0.10 MRR. Two embedders are reported as tied on paraphrases only when their difference's 95% interval lies inside plus or minus 0.10. Otherwise a non-significant difference is reported as "not distinguished at this sample size".

Ceiling: if every cell has at least 23 of 24 paraphrase questions at first place, the split is at the ceiling and cannot separate the embedders.

## What each outcome changes

| If it wins | If it loses | If inconclusive or at the ceiling |
|---|---|---|
| Cat 21 adopts the paraphrase questions as its main split; the `reindex --code` recommendation gets evidence | The tie is reported as real on paraphrases too | Report "not distinguished" |

"Wins" means at least one pairwise MRR difference has a Holm-adjusted p under 0.05; the recommendation gets evidence only if a Voyage code embedder is the winner against `text-embedding-3-large`. "Loses" means every pairwise interval lies inside the 0.10 margin.

## Budget

Ledger `/workspace/gbrain-evals/.budget/followups-2026-10.sqlite`, one budget run `cat21-code-retrieval`, `--budget-usd 2` (the plan's W5 cap). Every embedding request goes through the ledger's paid-request guard (reserve before send, settle to provider usage). Estimate about $0.30 (about 0.6M tokens per cell at $0.18, $0.12 and $0.13 per 1M). A reservation past the cap is refused and the cell is published as failed. The report states actual spend beside the estimate.

Runner: `bun eval/runner/cat21-code-retrieval.ts --split both --cells voyage-code-3,voyage-code-4,openai-default --preregistration docs/benchmarks/2026-10-06-cat21-paraphrase-preregistration.md --budget-ledger <ledger> --budget-usd 2`. It attests this preregistration before the first paid request and writes the attestation into its receipt.

## Amendments

None yet.
