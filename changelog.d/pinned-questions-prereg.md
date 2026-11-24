### New category: pinned questions (preregistered)

- `eval/runner/pinned-questions.ts` tests gbrain's pinned questions on seeded fictional-company worlds: after one
  controlled change per question (edit, fact supersession, deletion, contradiction, unrelated edit), does gbrain flag
  exactly the sentences whose evidence changed, schedule the right questions for refresh, and come back with a
  matching answer? Keyless, with a scripted answerer. Generator `eval/generators/pinned-questions-gen.ts`, scorer
  `eval/runner/pinned-questions-score.ts`, registry row `pinned-questions`.
- `eval/runner/pinned-questions-paid.ts` measures whether a real model's refreshed answer is correct, through gbrain's
  own refresh path, with a judge from another model family.
- [docs/benchmarks/2026-11-24-pinned-questions-preregistration.md](docs/benchmarks/2026-11-24-pinned-questions-preregistration.md)
  fixes the counted seeds, metrics, judge check and what each outcome changes before any counted run.
