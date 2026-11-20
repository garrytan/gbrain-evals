# Measured no-gbrain baselines for README's result rows: preregistration

Committed 2026-11-17, before any run below. Tracking issue: GST-2935.

## Question

README's results table asks one question: does an agent get more right with gbrain than without it? Twelve rows report
a gbrain number with no measured alternative. This plan runs, for each of them, the alternative a developer would
actually use instead of gbrain, on the same tasks, harness, reader and judge as the published gbrain number, so the row
can say whether gbrain wins, ties or loses.

## Rules for every arm

- No gbrain code runs in a baseline arm. The baselines don't depend on a gbrain build, so the gbrain-build rule doesn't
  apply to them, and **no gbrain arm is run again**: each pairs with the published gbrain number and its saved
  per-question records, at the commit README names.
- Same tasks, same scorer, same reader and judge as the gbrain row. Where the gbrain row used a reader or judge that is
  not a model under test today (Sonnet 5.5, Sonnet 4.6, Haiku 4.5), the baseline uses that same model so the pair
  matches, and the report says so.
- Sealed and held-out sets get no new arm.
- Every paid call goes through the budget ledger (`eval/runner/budget-ledger.ts`).
- Paired comparisons use the test the gbrain row's own report used; where it used none, an exact two-sided McNemar
  (binary outcomes) or sign test (graded outcomes) at alpha 0.05, with a 95% interval. **Win**: gbrain ahead and the
  test rejects. **Loss**: the baseline ahead and the test rejects. Otherwise **no measurable difference** at that
  sample size, which is not a claim that the two are equal. A tie or loss gets a "Why null?" note in the report.

## Arms

| README row | Baseline arm | n | Reader / judge / embedder | What each outcome changes in README |
|---|---|---|---|---|
| LongMemEval, every needed conversation in the top five (451 of 470) | plain Postgres full-text plus pgvector, reciprocal-rank fusion (`PlainHybridSystem`, the scoreboard's `baseline-hybrid`), one row per session | 470 answerable of 500 | text-embedding-3-large, 1,536 dims | win: gbrain keeps the row; tie or loss: README says plain hybrid search finds as much at five results |
| LongMemEval right answers, Sonnet 5.5 reader (468 of 500) | (a) the whole history in the prompt; (b) plain hybrid's top five sessions; (c) the question alone | 500 | Sonnet 5.5 (matches the row), `gpt-4o-2024-08-06` judge | win over (b): retrieval quality matters; tie or loss against (a): README says the whole history answers as well or better at higher cost per question, as it already does for 150 questions |
| Opus 5.5 reading saved gbrain results (474 of 500) | plain hybrid's top five sessions, read by Opus 5.5 | 500 | Opus 5.5, `gpt-4o-2024-08-06` judge | as above, for the frontier reader |
| A search that quotes a saved message word for word | the same quoted probe, and the question, against plain hybrid; target conversation in the top ten | 500 | text-embedding-3-large | win or tie: README states it; loss: README says plain full-text finds quotes as well |
| Reworded one-hop relationship questions, recall in the top five (0.537) | BM25 keyword ranker, vector-only, and plain hybrid over the same pages and paraphrases | 145 questions x 3 orders | text-embedding-3-large | win: the relationship layer earns its keep on reworded questions; tie or loss: README says plain search does as well |
| Meeting attendance, "who attended" recall in the top five (80%) | BM25 and plain hybrid over the same world | 50 meetings x 3 orders | text-embedding-3-large | win: link-following helps attendance questions; tie or loss: stated plainly |
| PrecisionMemBench precision (0.586) | plain hybrid cut to one result (`k=1`), the same return size as gbrain's tight mode | 77 cases | text-embedding-3-large | win: the gain is gbrain's ranking; tie or loss: the gain comes from returning less |
| Contradiction finding (146 of 150, Haiku 4.5) | the same model and the same 2,680 candidate pairs, with a plain "do these contradict?" prompt that shows each side's date | 2,680 pairs | claude-haiku-4-5 (matches the row) | win: gbrain's dated prompt avoids false conflicts; tie: a bare prompt does as well |
| Contradiction judging on current models (150 of 150, 0 of 251) | the same plain prompt on the same 741 pairs | 741 pairs x 4 models | the row's four models | as above |
| Timeline extraction (37 and 38 of 38) | the same model with a plain "list the dated events on this page" prompt, per page | 48 pages x 2 runs | claude-sonnet-4-6 (matches the row) | win: fewer premature or wrong events; tie: a bare prompt dates events unaided |
| Session to memory page (88.1% judged) | the same model writes one memory page per transcript from a plain prompt | 24 transcripts | claude-sonnet-4-6 writer and judge (matches the row) | win: gbrain's triage and synthesis keep more; tie or loss: stated plainly |
| An attacker's false claim adopted in a later session (1.5% to 5%) | an agent with a plain Postgres memory (keyword and vector search, save), same scenarios and tools | same scenarios as the labels-absent arm | Opus 5.5, Sonnet 5.5 (matches the row), GPT-6.1 Sol | win: trust labels protect beyond plain memory; tie: plain memory also rarely adopts the claim |

## Rows with no baseline run

The held-out multi-relation planner row and every row that checks gbrain's own behaviour move to a second README table
with no comparison column. The sealed v2 whole-conversation row already has a measured no-memory arm.

