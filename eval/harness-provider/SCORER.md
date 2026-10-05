# How the harness lane scores answers

The harness lane runs gbrain and the comparator through the public agent-memory benchmark harness, pinned at commit `f618ed7b1f0eb9cad7b42e876f91a42f0eadb150` (see `harness.lock.json`). The harness's own runner scores answers in ways that can turn a failure into a pass or make it disappear from the average. This lane scores every cell with `mpw/scorer.py` instead. This page lists each difference from the harness scorer, so a reader can compare our numbers with numbers the harness reports.

## What stays the same

The scorer calls the harness's own judging code wherever it can, so the questions a judge sees are the ones the dataset authors wrote:

- Open-ended answers are judged with each dataset's own prompt (`get_judge_prompt_fn` or `build_judge_prompt`, else the harness default prompt), through the harness's `GeminiJudge.score`.
- The judge model is the dataset's own when it names one in code (BEAM uses `gemini:gemini-3.5-flash`), otherwise the cell's configured judge (`OMB_JUDGE_LLM` / `OMB_JUDGE_MODEL`).
- BEAM rows are scored by `BEAMDataset.score_result`: one judge call per rubric item, the same rubric prompt, the same rounding of each item to 0, 0.5 or 1, and the row's score is the mean. A row counts as correct at 0.5 or above.
- Multiple-choice answers (PersonaMem) use the harness's exact letter match. No model is involved.
- PrecisionMemBench uses the dataset's `score_retrieval`. Retrieved ids are mapped back to dataset ids through a reverse map that only the scorer holds, because the providers only ever see opaque ids.

## Differences

**1. The denominator is the schedule.** A cell schedules a fixed list of questions before it runs. Every scheduled question counts in the average. Questions that failed, could not be judged or have no record count as 0. The harness averages BEAM scores only over rows that produced a score, so a row it never judged drops out. With one answer scored 1.0 and one empty-context answer, the harness reports 1.0; this scorer reports 0.5.

**2. Empty context is not an automatic wrong answer.** When a provider returns nothing, the harness marks the question wrong without asking the answer model or the judge. In this lane the answer model always answers, even with an empty context, and the judge grades that answer. This matters most for questions whose correct answer is "that was never mentioned": the harness counts every such correct refusal as wrong when nothing was retrieved.

**3. Every row has a typed outcome.** Each scheduled question ends as exactly one of `answered`, `abstention`, `answer_failure`, `retrieval_failure`, `judge_failure` or `incomplete_ingest`. The harness has only correct or not correct, and an error that outlasts its retries stops the whole run. Answer, retrieval and ingest failures are never sent to the judge and count as 0.

**4. Abstentions are labelled and still judged.** An answer is labelled `abstention` when it is empty or when its first 240 characters contain a fixed phrase such as "I don't have enough information", "there is no information about", "was not mentioned" or "the context does not mention" (the full list is `ABSTENTION_PATTERNS` in `mpw/scorer.py`). The label never changes a score. It lets a reader see how often a system declines and whether those refusals were right.

**5. Judge fields must have the right JSON types.** The harness reads the judge's verdict with Python's `bool()`, so the string `"false"` counts as correct, as do `"no"` and `1`. Here `correct` must be a JSON `true` or `false`, `reason` must be a string, and a BEAM rubric `score` must be a JSON number from 0 to 1 (the harness accepts the string `"1.0"` and rounds 7 down to 1). A response with a missing or wrongly typed field is asked again once with the same prompt. If the second response is also invalid, or the judge call raises, the row is a `judge_failure`.

**6. Unparseable judge text is not a verdict.** When the harness's Gemini client cannot parse a response after its retries, it copies the raw text into every required field. The judge's sentence then becomes `correct`, and `bool()` of any non-empty sentence is true. Point 5 turns that into a `judge_failure`.

**7. A BEAM row needs a valid judgment for every rubric item.** The harness scores a rubric item 0 when its judge call fails, and scores a question with no rubric and no reference answer 0. Here either case makes the row a `judge_failure`. The record keeps each item's criterion, score, reason and number of attempts.

**8. Incomplete cells are flagged.** A cell is `complete` only when every scheduled question has a record and none is a `judge_failure` or `incomplete_ingest`. An incomplete cell's numbers are not reported as a result until it is resumed or re-judged.

**9. Reruns are never merged into earlier results.** The harness's `--only-failed` option and its save step merge new rows into the previous output file by question id, even when the earlier rows came from a different configuration. Here every record carries its cell id, records from another cell are refused, and a record for an unscheduled question or a duplicate record is an error rather than a silently kept or dropped row.

**10. The judge model is recorded and checked on every row.** Each judged row records the model id that produced the verdict. The scorer refuses to run when the judge it was given differs from the expected model, so a configuration slip cannot quietly change the judge.

**11. Both systems are judged together, blind.** `python -m mpw.rejudge` judges the answers from several cells over the same dataset, split and schedule in one pass. Before an answer reaches the judge, provider names, cell ids and provider-style ids (opaque `d-`/`u-` ids, UUIDs) are replaced with `[redacted]`. The answers from all cells are judged in one order shuffled with a recorded seed. The output holds per-cell judge records, an unblinding map from position to cell and question, and per-cell summaries over the fixed denominator. Judge responses are cached, so a rerun with the cache gives byte-identical output.

## Reproduce

```bash
bun run harness:setup
bun run harness:test
```

The tests use local scripted judges and make no network calls. `tests/test_scorer_golden.py` runs each harness behavior above against the pinned harness code and shows this scorer's result beside it. `tests/test_scorer_mutation.py` reintroduces each behavior into this scorer one at a time and checks that the conformance suite catches it. `tests/test_rejudge.py` covers blinding, shuffling, schedule checks, the judge model check and cached reruns.
