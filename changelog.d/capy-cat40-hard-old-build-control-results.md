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
  `--world-transcripts`, and that look refuses unless it gets both worlds, the same task ids in every arm and, for the
  widened-session sensitivity, a transcript for every gbrain attempt; the Cat 40 agent loop records the model id each
  provider served.
- The hard company questions' analysis and checks now refuse more mistakes instead of computing on them
  ([test/eval/cat40-hard-fail-closed.test.ts](test/eval/cat40-hard-fail-closed.test.ts)):
  [newest_analysis.py](eval/runner/cat40/newest_analysis.py) needs exactly the worlds N1 and N2 and every planned task id
  in every arm, and refuses a counted cell that ended on a provider 5xx or 429 unless `--accept-unretried` names it (both
  results pages' reproduce commands name the one disclosed HTTP 520 cell);
  [judge-check-hard.ts](eval/runner/cat40/judge-check-hard.ts) gives each real item an id with its arm, refuses a row drawn
  twice, and fails a judge roster that is empty or a judge that graded fewer than every item, with `report` requiring
  `--judges`; and the Cat 40 agent loop retries every 5xx from Anthropic and OpenAI that a resend can fix (all but 501 and 505),
  such as Cloudflare's 520, while
  Particle keeps its listed retry statuses.
