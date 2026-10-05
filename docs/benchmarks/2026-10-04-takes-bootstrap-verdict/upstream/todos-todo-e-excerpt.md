<!-- Verbatim excerpt of garrytan/gbrain TODOS.md, the TODO-E entry, at commit d37fab68e95e66347ba661e913cdafca330ae5a2 (merge of #6013, v0.60.59.0). -->

- **TODO-E (P1)**: 100+-case eval suite for takes-bootstrap classifier. v0.42.0
  ships the classifier + the 20-case eval scaffold per A24. Autopilot tier for
  takes-bootstrap STAYS `manual_only` until this lands. Required before any
  autopilot run of takes extraction.
  **Status (test-gap wave): the INSTRUMENT is shipped** — evals/takes-bootstrap/
  (123-case deterministic corpus with empty/attribution/adversarial precision
  classes, scorer v1 with per-kind precision ≥0.80 / recall ≥0.70 and
  malformed-is-failure, live harness driving the real extractTakesFromPages
  path + $0 replay mode), keyless-CI-guarded by test/eval-takes-bootstrap.test.ts.
  The tier flip still requires a GRADUATED live run committed with its
  predictions JSONL per evals/takes-bootstrap/README.md — needs a chat key,
  ~123 Haiku-class calls.
  **Status (GBRA-47 D-6, 2026-10-04): first live run NOT graduated.** Haiku 4.5,
  123 variants, $0.09: 75/123 pass; precision fact 0.714, take 0.894, bet 0.545,
  hunch 0.750 (recall 0.667); 3 forbid violations attributed press claims to the
  page holder. The tier stays `manual_only`. Next: complete the archetype labels
  (valid unlabeled claims count as imprecise), then fix bio-fact recall and
  press-claim attribution, then rerun. Record:
  docs/test-audit/2026-10-04/implementation/lane-c.md.

