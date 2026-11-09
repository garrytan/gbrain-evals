# Narrowed RS1 results: is gbrain within 3.5 points of the two leading memory servers on new BEAM conversations?

This file will hold the results of the test preregistered in
[2026-11-08-rs1-narrow-preregistration.md](2026-11-08-rs1-narrow-preregistration.md). The preregistration was frozen by
its merge commit, `325a1c04` (#390), on 2026-11-08. No RS1 conversation has been minted and no counted cell has run yet.

Changes to the harness, pins or cells made before a counted run land on this branch as dated commits, and each is
recorded under the preregistration's "Amendments" heading. Counted runs start from a pushed commit on this branch, and
that commit and its cells digest are recorded there.

## Run log

- **2026-11-08:** preregistration and harness merged at `325a1c04`. Next: stage 1 on set `RS1-dev2` (public BEAM
  data only), the pre-run fixes listed in the preregistration's amendments, then wave A.
- **2026-11-08, stage 1 on `RS1-dev2`:** ran on one Ubicloud VM from `80518b25`, 09:05Z to 23:20Z, with conversations
  `1m-20` and `1m-28`. It is a smoke test and not a counted result, so its scores are not reported here. The first
  launch, from `799813b3`, was refused by the preflight before any lease was taken. Fix 6 in the amendments covers it.
  - **Rows.** All four rows completed: the floor, gbrain-defaults `rs1-stable`, the memory-bank server and the
    extract-first server. Each has 40 questions, 80 answers (Opus and Sol live), 0 unjudged answers and 0 invalid
    reasons.
  - **Judge views.** The three system rows were judged under both views, 160 judgments each. As preregistered, the
    floor row was judged by the protocol judge only, 80 judgments.
  - **Server bundles.** Both ingested both conversations: 851 and 870 sessions, 0 failed sessions, 0 degraded
    conversations. One embedding request during the extract-first server's ingest returned HTTP 400, was not billed,
    and failed no session.
  - **particle-1 re-reads.** All four completed, each with 40 answers and 0 unjudged. The three system-row re-reads
    were also judged under the frontier view by gpt-6.1-sol.
  - **Spend.** Stage 1 finished inside its window cap, with no ledger overshoot and no open reservations.
  - **gbrain ingest at the stable tag.** 1,974,748 tokens over 12,591 s of ingest wall time, or 1.77 VM hours per
    million tokens. The placeholder was 1.92. The repricing that follows from it is the preregistration's 2026-11-08
    "pricing rerun after stage 1" amendment.

## Disclosures

- gbrain is Garry Tan's own project.
- Disclosure: Y Combinator, which Garry Tan runs, is an investor in Particle, which makes particle-1.
- Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator. Garry Tan runs Y Combinator.
