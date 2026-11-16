### LongMemEval: gbrain against the whole history, re-measured at gbrain's newest release (preregistered)

- **What changed.** The W10 preregistration gains a dated amendment (2026-11-16) for R3, which re-runs W10c's
  question at gbrain v0.60.733.0 (`6ce7195b`) on the same 150 questions. The question: does gbrain's retrieval answer
  as well as pasting the whole conversation history into the prompt? The readers are Claude Opus 5.5, GPT-6.1 Sol and
  particle-1. R3 also re-measures strict recall@5 on the 470 answerable questions, behind README's heading "Finding all
  the evidence: gbrain leads every system we can score strictly". Each reader row gets the official judge plus a judge
  from another model family, and that second judge is checked against labelled answers before its verdicts count. The
  amendment's preregistered tests are non-inferiority at 7 points, the loss test and a regression test against
  `c5fb0201`.
- **Why.** Every published W10 number was measured on gbrain `c5fb0201`, 616 releases behind the newest release.
- **Harness.** `eval/runner/batch/` gains R3's arms and judges (`w10.ts`, `w10a-capture.ts --r3`, `w10-particle.ts`),
  the judge check (`r3-judge-check.ts`), a keyless report (`r3-report.ts`) and a resumable driver for the run machine
  (`r3-vm.sh`, `r3-vm-setup.sh`). Every paid R3 step refuses to run outside its named paid window and on any gbrain
  build but `6ce7195b`. Keyless tests: [test/eval/r3-longmemeval.test.ts](test/eval/r3-longmemeval.test.ts).
