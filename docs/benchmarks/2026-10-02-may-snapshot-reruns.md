# Fresh receipts for May snapshot categories 19, 20 and 21

**Finding.** On October 2, 2026, at gbrain `d44296c` (v0.60.30.0), the current runners for Categories 19, 20 and 21 produced publishable receipts, replacing the rows the [May 23 snapshot](2026-05-23-v0.40.6.0-snapshot.md) marks invalid. Cat 19 passed: the doctor's plan took a deliberately damaged brain from a health score of 10 to 85. Cat 20 failed its gate: every graded brainstorm idea cited real pages, but the judge rated the ideas 1.17 out of 5 on average against a 2.5 floor. Cat 21 passed, with both embedders at the ceiling, so it no longer tells the two apart. The May numbers stay in the snapshot as history.

[gbrain](https://github.com/garrytan/gbrain) is a memory system for agents. These three categories test maintenance (`doctor`), idea generation (`brainstorm`) and search over source code.

## Cat 19: does the doctor's plan repair a damaged brain?

The runner seeds 30 pages with known gaps: no embeddings and no extracted links. It asks gbrain's planner (`computeRecommendations`) what to do, runs the recommended steps through gbrain's own entry points (`runEmbedCore` for stale embeddings, `runExtract` for links) and measures the brain again. This run used live OpenAI embeddings (`CAT19_LIVE_EMBED=1`) so the receipt is publishable; CI runs the same loop with hash embeddings on every pull request.

| Measurement | Before | After | Gate |
|---|---:|---:|---|
| Brain health score (`getHealth().brain_score`) | 10 | 85 | rise of at least 15 |
| Extracted links (SQL count) | 0 | 35 | grew |
| Pages missing embeddings | 30 | 0 | 0, with 0 embed failures |
| Gates passed | | 5 of 5 | all |

The May row claimed a rise from 10 to 50 from link extraction alone and was invalid because the old runner read a field that does not exist. The audit also noted that the runner executes a fixed script rather than the planned steps; the current runner checks that the plan recommends `embed.stale` (gate 2) and then runs the embed and extract steps itself, so it measures the plan's main step and the repair, not arbitrary planned steps.

## Cat 20: are brainstorm ideas grounded and useful?

Three questions against the 165-page synthetic-v1 corpus. For each, gbrain's `runBrainstorm` generated 72 ideas (24 crosses of a close page and a far page, three ideas each) with `claude-sonnet-4-6`, and its internal judge passed 22, 14 and 33 of them. Grounding is computed from the idea text itself: an idea counts when both cited slugs exist and appear verbatim in the text. Nothing is injected, unlike the May runner. A `claude-haiku-4-5` judge (`judge-2026-09-28-untrusted-v1`) then scored the passing ideas for novelty and usefulness.

| Question (abbreviated) | Ideas | Passing | Grounding (passing ideas) | Judge (of 5) |
|---|---:|---:|---:|---:|
| Next product for an inference platform | 72 | 22 | 1.00 | 0.5 |
| How an early-ML fund differentiates | 72 | 14 | 1.00 | 1.5 |
| Research direction: agent memory and picking robots | 72 | 33 | 1.00 | 1.5 |
| **Mean** | | | **1.00** (gate 0.5) | **1.17** (gate 2.5) |

Verdict: **fail**, on the judge floor. Grounding, the property the May runner faked, now holds on its own: 69 of 69 graded ideas cite two real pages in their text. The low judge score is a measured result, not yet explained. The receipt stores the score per question but not the judge's rationale, so this run cannot say whether the ideas are weak or the judge is harsh. The next step is to record the rationale and compare with a second judge model.

## Cat 21: code search with two embedders

The runner ingests 60 TypeScript files from gbrain's own `src/core` (12 gold files and 48 distractors) and runs 12 symbol-lookup questions such as "hybridSearch function" through gbrain's hybrid search, once with Voyage `voyage-code-3` and once with OpenAI `text-embedding-3-large`.

| Embedder | Files ingested | Gold present | First result correct | MRR | Recall at 5 |
|---|---:|---:|---:|---:|---:|
| `voyage-code-3` (1024 dims) | 60 of 60 | 12 of 12 | 12 of 12 | 1.000 | 100% |
| `text-embedding-3-large` (1536 dims) | 60 of 60 | 12 of 12 | 12 of 12 | 1.000 | 100% |

Both cells are at the ceiling. Every question names the symbol it wants, and hybrid search includes a keyword arm, so the exact name finds the file whichever embedder is used. The runner names `voyage-code-3` "best by MRR" only because it is listed first in a tie. The May row (both 2 of 12) was bounded by a bug that never ingested 11 of the 12 gold files; with that fixed, this fixture cannot separate the embedders. Paraphrased questions that do not name the symbol would be needed to test the `reindex --code` recommendation.

## Reproduce

```bash
CAT19_LIVE_EMBED=1 bun eval/runner/cat19-doctor-remediate.ts   # OPENAI_API_KEY
bun eval/runner/cat20-brainstorm.ts --live-judge                 # ANTHROPIC_API_KEY, OPENAI_API_KEY
bun eval/runner/cat21-code-retrieval.ts                          # VOYAGE_API_KEY, OPENAI_API_KEY
```

Observed time and cost: Cat 19 under 10 seconds and under $0.01 of embeddings; Cat 20 about 11 minutes, $1.08 of brainstorm calls as reported by gbrain (3 x $0.36) plus a few cents of judging; Cat 21 about 2.5 minutes and an estimated $0.10 of embeddings (none of these runners writes a cost field). Receipts, dated reports and run logs: [Cat 19](2026-10-02-may-snapshot-reruns/cat19-doctor-remediate/receipt.json), [Cat 20](2026-10-02-may-snapshot-reruns/cat20-brainstorm/receipt.json), [Cat 21](2026-10-02-may-snapshot-reruns/cat21-code-retrieval/receipt.json). The run plan was committed beforehand in [the paid-reruns plan](2026-10-02-paid-reruns-plan.md).
