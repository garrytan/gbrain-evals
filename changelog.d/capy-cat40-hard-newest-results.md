### Hard company questions re-measured on gbrain's newest release

- [docs/benchmarks/2026-11-19-cat40-hard-newest.md](docs/benchmarks/2026-11-19-cat40-hard-newest.md) reports the
  preregistered re-measurement at gbrain v0.60.742.0 on two new public-generator worlds: gbrain 325 and files 315 of
  400 right (+2.50 points, interval -1.50 to +6.50, parity), and gbrain behind where sources disagree (-16.25). Whether
  the build or the worlds explain the drop from October's leads is not yet known. Its per-step data, redacted run
  receipts and analysis sit beside it.
- particle-1's oracle, gbrain and files cells ran on the same build and worlds: 67 of 200 right with gbrain against 6
  with plain files (+30.5 points, 24.5 to 37.0), reported apart from the headline, with the Particle disclosure.
- README's two hard-company rows are replaced by the new parity row and a disagreeing-sources row, with the earlier
  builds' numbers in footnotes.
- [eval/runner/cat40/newest-confirm.ts](eval/runner/cat40/newest-confirm.ts) gains the interim look and the files
  pilots the amendments added, and the slot step passes `--accept-freeze-drift`;
  [eval/runner/cat40/newest_analysis.py](eval/runner/cat40/newest_analysis.py) gains `--look interim` and the z 1.98
  final interval.
