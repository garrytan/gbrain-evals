# LHF wave 2: latency, retrieval quality and cost

Plan for gbrain's second low-hanging-fruit fix wave, approved by Garry on 2026-10-15 after two gstack autoplan
rounds (run `autoplan-20261015220653`, gate revision 2, approved as-is).

- [PLAN.md](PLAN.md): the plan, revision 2, with the round-2 dispositions that bind implementation.
- [audit/](audit/): the three read-only audits the plan came from (eval findings, latency, cost).
- [reviews/](reviews/): CEO, DX and engineering reviews from both rounds (`*.r1.md` is round 1), consensus
  tables, findings, gate files and the review record.

Measured verdicts for every item, shipped or dropped: [VERDICTS.md](VERDICTS.md).

Machine-local paths in the audits and review records were rewritten after export: committed artifacts point to their
repo-relative path, and everything else (prompts, plan snapshots, probes, scratch receipts) reads "local audit notes (not
committed)". The `result_sha256` values in `reviews/run.json` and `reviews/review-record.md` hash the review files as
the reviewers wrote them, before that rewrite; no other text changed.
