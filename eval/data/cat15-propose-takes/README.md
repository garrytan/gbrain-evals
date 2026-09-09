# Cat15: finding predictions worth checking later

Before gbrain can learn from someone's track record, it must identify statements that could later turn out to be right or wrong. “The company was founded in 2020” is a fact. “This hiring plan will slow the launch” is a prediction that could be evaluated later.

Cat15 checks whether the `propose_takes` extractor finds those claims without treating every sentence as a forecast. It complements [Cat14](../cat14-calibration/README.md), which tests how a stored track record affects advice.

## How the test works

The runner reads eight fixture pages from the gbrain package's calibration corpus. It imports the production `EXTRACT_TAKES_PROMPT` from gbrain instead of keeping a separate copy, runs extraction, then compares the output with hand-labeled `.gradeable-claims.json` files.

A Haiku judge matches extracted claims to the labels. Every extracted and labeled claim must be accounted for exactly once. Invalid judge output gets one corrective retry; a second failure is a judge error and is excluded from the score rather than reported as poor extraction.

An extracted claim that matches a label is a **true positive**. An extra claim is a **false positive**. A labeled claim that was missed is a **false negative**.

- **Precision:** matched claims divided by extracted claims.
- **Recall:** matched claims divided by labeled claims.
- **F1:** one score combining precision and recall.

A page with no labeled claims scores 1.0 when the extractor correctly returns an empty list. Unparseable extractor output is a system failure and scores zero.

## Training and held-out pages

| Probe | Split | Kind of page |
|---|---|---|
| `cat15-train-concept-market` | Training | Concept with a timeline |
| `cat15-train-meeting-fundraise` | Training | Meeting notes |
| `cat15-train-daily` | Training | Daily journal |
| `cat15-hold-concept-execution` | Held out | Concept with a timeline |
| `cat15-hold-daily` | Held out | Daily journal |
| `cat15-hold-meeting-hiring` | Held out | Meeting notes |
| `cat15-hold-essay-conviction` | Held out | Essay about personal judgment |
| `cat15-hold-people-bob` | Held out | Person page |

Training average F1 must reach 0.85, held-out average F1 0.80, and the training-minus-held-out gap must be at most 0.10. The held-out pages check whether improvements extend beyond the examples used while developing the prompt.

Dry or filtered runs are always marked partial and `publishable: false`; passing one selected case is not a full benchmark pass.

## Run it

From the repository root:

```sh
# Live extraction and judging: requires ANTHROPIC_API_KEY.
bun eval/runner/cat15-propose-takes.ts

# Free pipeline check; always marked partial.
CAT15_DRY_RUN=1 bun eval/runner/cat15-propose-takes.ts

# Investigate one page.
CAT15_PROBES=cat15-hold-people-bob bun eval/runner/cat15-propose-takes.ts

bun test test/eval/cat15-propose-takes.test.ts
```

The default scored corpus is `node_modules/gbrain/test/fixtures/calibration/`: `extract-takes-corpus/` for training and `holdout/` for held-out pages. Set `CAT15_CORPUS_DIR` to point at a deliberately selected alternative checkout.

Missing corpus files or keys produce a skipped receipt and a nonzero exit. `--allow-skip` acknowledges the skip without converting it into a measurement.

Outputs go to `eval/reports/cat15-propose-takes/`: individual probe dumps, `_summary.json` and `receipt.json`. The summary identifies models, prompt version, filters and dry-run status.

## Diagnose a missed claim

In a dump's `.matches[]`, `extracted_index: null` means the extractor missed a labeled claim. Extra claims equal `extracted_count - true_positives`.

| Pattern | Useful place to investigate |
|---|---|
| “Maybe” and “I'd guess” claims disappear | Hedging and conviction rules in `EXTRACT_TAKES_PROMPT` |
| Dates and historical facts are treated as forecasts | The prompt's list of statements that are not gradeable |
| The same prediction appears twice | Restatement instructions and the existing-claims deduplication step |
| Output cannot be parsed | Output instructions and production parsing functions |
| One kind of page scores poorly | Examples covering that genre |
| Judge output repeatedly fails validation | The matcher schema and retry logic in the runner |

Run Cat15 before changing gbrain's `PROPOSE_TAKES_PROMPT_VERSION`. A version bump invalidates the extraction cache: prior proposals remain as history and a later cycle extracts again.

The local `test-fixtures/` pages are small inputs for unit tests, not the scored corpus. Preserve their text unless intentionally changing the test.
