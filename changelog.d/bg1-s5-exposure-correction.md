### Changing-facts battleground: corrected exposure for withdrawn facts

- **Corrected.** [docs/benchmarks/2026-11-15-changing-facts-battleground-results.md](docs/benchmarks/2026-11-15-changing-facts-battleground-results.md)
  now says gbrain's contexts held the withdrawal for 85% of the withdrawn-fact (S5) questions, against 95% for the
  memory-bank server and 97% for the extract-first server. It first said 60% against 52% and 80%, and put gbrain's S5
  loss to the memory-bank server down to reading; with the corrected figures, gbrain's context held the withdrawal less
  often than both servers' by more than its S5 loss to each. The published count took a call-off anywhere in the
  context; the corrected one needs the entity, the withdrawn value and a call-off word in one sentence. Hybrid search's
  contexts held the right value for 20% of all questions, not 23%. The corrected figures sit in
  `exposure-correction.json` beside the unchanged `verdict.json`, and [docs/corrections.md](docs/corrections.md) lists
  the correction. No accuracy figure, interval or verdict changes.
