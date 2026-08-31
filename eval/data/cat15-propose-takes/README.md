# cat15 — propose_takes extraction precision/recall

If cat14 measures whether the OUTPUT side of gbrain's calibration wave works
(`think --with-calibration` produces better answers), cat15 measures whether
the INPUT side works: does the `propose_takes` extractor prompt actually find
the gradeable claims hiding in a user's prose, so the calibration loop has
fuel?

## What the eval measures

For each probe:

1. Read the fixture page from the corpus that ships inside the gbrain package
   (`node_modules/gbrain/test/fixtures/calibration/`; override with
   `CAT15_CORPUS_DIR` when pointing at a local gbrain checkout).
2. Run gbrain's PRODUCTION extractor prompt (`EXTRACT_TAKES_PROMPT`, imported
   directly from `node_modules/gbrain/src/core/cycle/propose-takes.ts`, never
   mirrored) against the page body via the extract model.
3. Load the hand-labeled `.gradeable-claims.json` ground truth.
4. A Haiku matcher judge (temperature 0) labels each extracted claim TP/FP
   and each ground-truth claim TP/FN via structured tool-use. The tool output
   is validated for full coverage — exactly one entry per ground-truth claim,
   every extracted claim accounted exactly once — with one corrective retry.
   A still-malformed judge is a `judge` error (probe excluded from means),
   never a fake 0.
5. Precision = TP / extracted, recall = TP / ground-truth, F1 per probe;
   aggregate per split. A page with zero labeled claims where the extractor
   correctly returns `[]` scores a trivially-correct 1.0.

## Gates

- training avg F1 >= 0.85
- holdout avg F1 >= 0.80
- training - holdout gap <= 0.10 (overfitting signal)

Dry runs (`CAT15_DRY_RUN=1`) and filtered runs (`CAT15_PROBES=...`) can never
report `pass` — their summary and receipt are forced to `partial` with
`publishable: false`.

## Probe taxonomy (8 probes)

| Probe ID | Split | Genre |
|----------|-------|-------|
| `cat15-train-concept-market` | training | concept-with-timeline |
| `cat15-train-meeting-fundraise` | training | meeting-notes |
| `cat15-train-daily` | training | daily-journal |
| `cat15-hold-concept-execution` | holdout | concept-with-timeline |
| `cat15-hold-daily` | holdout | daily-journal |
| `cat15-hold-meeting-hiring` | holdout | meeting-notes |
| `cat15-hold-essay-conviction` | holdout | essay-on-self-calibration |
| `cat15-hold-people-bob` | holdout | people-page |

## The fix-feedback loop (failure mode → where to fix)

Per-probe dumps land in `eval/reports/cat15-propose-takes/<probe_id>.json`.
`.matches[]` entries with `extracted_index: null` are false negatives (the
prompt missed a labeled claim); `extracted_count - true_positives` counts the
false positives (over-extraction).

| Failure mode | Diagnostic signal | Where to fix |
|--------------|-------------------|--------------|
| Missed hedged claims (FN) | `matches[]` nulls cluster on "maybe"/"I'd guess" claims | The conviction-inference rules in `EXTRACT_TAKES_PROMPT` (gbrain `src/core/cycle/propose-takes.ts`) — add hedging examples |
| Pure-fact over-extraction (FP) | Extracted claims are dates/founding facts, judge rationale says "pure fact" | The NOT-gradeable list in `EXTRACT_TAKES_PROMPT` — sharpen the fact-vs-forecast contrast examples |
| Restatement double-extraction (FP) | Two extracted claims map to one ground-truth assertion | The restatement bullet in the NOT-gradeable list; also check the `EXISTING FENCE ROWS` dedup block wiring |
| Unparseable output (`extraction_parse_failed`) | Probe scored 0 with a `sut` error in the receipt | Output-format instructions at the bottom of `EXTRACT_TAKES_PROMPT`; check `parseExtractorOutput` / `isWellFormedEmptyExtraction` in gbrain |
| One genre drags the split | `by_genre` avg_F1 floor well below the split average | Genre-specific worked example in the prompt (people-pages were the hardest genre at tuning time, F1 floor 0.80) |
| Judge errors pile up | receipt `errors[]` origin `judge` | Matcher tool schema / corrective-retry text in `eval/runner/cat15-propose-takes.ts` — this is harness, not gbrain |

If you re-tune the prompt: run cat15 BEFORE bumping
`PROPOSE_TAKES_PROMPT_VERSION` in gbrain, and keep the train-holdout gap
under 0.10. The version bump invalidates gbrain's `take_proposals`
idempotency cache, so old proposals stay as audit history and the next cycle
re-extracts fresh.

## How to run

```bash
# Full live run (8 probes, extract via Sonnet + judge via Haiku)
bun eval/runner/cat15-propose-takes.ts

# Hermetic pipeline smoke (no API spend; verdict forced to partial)
CAT15_DRY_RUN=1 bun eval/runner/cat15-propose-takes.ts

# Single probe (debugging one failure)
CAT15_PROBES=cat15-hold-people-bob bun eval/runner/cat15-propose-takes.ts

# Missing corpus / API key writes a skipped receipt and exits non-zero
# unless acknowledged:
bun eval/runner/cat15-propose-takes.ts --allow-skip
```

Outputs: per-probe dumps + `_summary.json` (with run provenance: dry-run
flag, probe filter, models, prompt version, timestamps) +
`receipt.json` under `eval/reports/cat15-propose-takes/`.

## Files

- `probes.jsonl` — probe definitions (this directory).
- `test-fixtures/` — tiny hermetic pages + ground truth used only by
  `test/eval/cat15-propose-takes.test.ts` (not part of the scored corpus).
- Scored corpus: `node_modules/gbrain/test/fixtures/calibration/`
  (`extract-takes-corpus/` = training, `holdout/` = holdout).
- Runner: `eval/runner/cat15-propose-takes.ts`.
