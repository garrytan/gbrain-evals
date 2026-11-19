### Hard company questions: gbrain's smaller lead is not a regression

- [docs/benchmarks/2026-11-19-cat40-hard-old-build-control.md](docs/benchmarks/2026-11-19-cat40-hard-old-build-control.md)
  reports the preregistered old-build control: gbrain `09d21554d` (October) on the November 19 worlds and tasks got 331
  of 400 against the files agent's 315 (+4.00 points, 0.00 to +8.25), and v0.60.742.0 scored 1.50 points below it
  (-4.50 to +1.50), so the smaller lead is not a gbrain regression. Its per-step data, redacted receipts and analysis
  sit beside it.
- README's hard-company row, "We learned" line, footnote 3 and known-limits line, and the newest-build results doc, now
  say so instead of "not yet known".
- [eval/runner/cat40/old-build-control.ts](eval/runner/cat40/old-build-control.ts) plans the control's steps;
  [eval/runner/cat40/newest_analysis.py](eval/runner/cat40/newest_analysis.py) gains `--look control` and
  `--world-transcripts`; the Cat 40 agent loop records the model id each provider served.
