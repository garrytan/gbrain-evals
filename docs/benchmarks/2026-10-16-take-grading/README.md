# Take-grading eval records (2026-10-16)

Records for the wave 4b W6 take-grading eval, mirrored from gbrain [#6882](https://github.com/garrytan/gbrain/pull/6882) (`evals/take-grading/`). The question, sets, arms and decision rule are in the [preregistration](../2026-10-16-take-grading-preregistration.md), frozen in gbrain `d99b84694` before any counted run.

| Path | What it is |
|---|---|
| `fixtures.jsonl` | The 908 fixtures as frozen (dev 118, counted 790). |
| `results/dev/dev1/` | Dev round 1, prompt version 1: one row per fixture and model, with each run's `.meta.json`. |
| `results/dev/dev2/` | Dev round 2, prompt `hybrid-evidence-v2`. |
| `results/counted/` | The counted run, one file per model, with each run's `.meta.json` (gbrain commit, preregistration commit, prompt hash, fixture and harness hashes, spend). |
| `summary.json`, `summary.md` | The harness's `--score` output over the three counted files. |
| `verdict.json` | The decision: per-model measures, qualifying models, `GRADE_TAKES_MEASURED_MODELS`, spend. |

The dev rounds ran on the dev split before one regeneration of the fixtures (progress hits placed before an early achievement), so a few dev rows differ in evidence from the frozen `fixtures.jsonl`; their `fixtures_sha256` in `.meta.json` names the version they ran on. Dev rows are context and never count. The report is [`../2026-10-16-take-grading.md`](../2026-10-16-take-grading.md).
