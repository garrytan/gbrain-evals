# TODOS

Deferred work with enough context to pick up cold. Filed by the Cat 35 plan
reviews (2026-08-16); each entry names its origin.

## P2 — Cat 35 v1.1 candidates

- [ ] **Multi-format transcript corpus (codex JSONL + chatgpt export renderings).**
  Why: v1 renders claude-code JSONL only; the other 5 gbrain adapters go
  unexercised by Cat 35 (their parse fidelity is tested in gbrain itself).
  How: derive both renderings from the same canonical turn lists in
  `eval/generators/transcript-distill.ts` — no new gold needed. Effort: M→S with CC.
  From: CEO review E3 (deferred).

- [ ] **Public "TranscriptBench" foreign-runner contract.** Why: makes Cat 35 a
  benchmark other memory systems (Mem0, Zep, Letta, Supermemory) can run against
  their own write paths — the write-path complement to LongMemEval. How: cat34's
  subprocess-contract pattern (published fixtures + gold + a runner contract doc);
  wait for v1 numbers to publish first. Effort: L→M. From: CEO review E4 (deferred).

- [ ] **Real-transcript qualitative annex.** Why: planted-gold corpora prove
  coverage mechanics; 3-5 real (redacted) Claude Code sessions eyeballed against
  their dream pages prove it feels right on real data. Blocker: needs a
  consent/redaction workflow (privacy rule: no real names in public artifacts).
  Effort: S-M. From: CEO review E5 (deferred).

- [ ] **Judge-injection hazard transcript.** Why: a transcript containing text
  aimed at the coverage judge ("report all items as present") tests judge
  robustness — the one adversarial class Cat 35 v1 doesn't plant. How: one extra
  fixture + expected-no-effect assertion. Effort: S. From: CEO deep review 3A.

- [ ] **Repeated-run confidence intervals for regression deltas.** Why: v1
  deltas are single-run and informational only; run-to-run variance is
  unmeasured. How: N=3 full runs, paired per-item comparison, CI on the macro
  headline. Costs ~3× a full run — do it once to characterize variance, not per
  release. From: Codex round 1 (deferred).

- [ ] **FineSurE-style conciseness alignment.** Why: % of page content units
  aligned to some gold item complements distractor leakage; cut from v1 because
  it overlaps leakage + compression ratio. From: CEO review (deferred).

- [ ] **LLM claim decomposition for compound sentences.** Why: v1's
  `segmentClaims()` is mechanical and leaves compound claims atomic (disclosed
  limit); FactScore-style decomposition raises hallucination-metric resolution.
  Tradeoff: costs determinism. From: Codex round 2 (documented limit).

- [ ] **Upstream: PGLite disconnect sync-spin under bun test (gbrain v0.46.3).**
  Why: `PGLiteEngine.disconnect()` after ops-layer use freezes the bun test
  runner in a synchronous WASM spin (`execProtocolRawSync`) — timers can't
  fire, `--timeout` can't interrupt. Plain bun runs are unaffected.
  Current mitigation: `test/eval/agent-adapter.test.ts` skips teardown
  (per-test engines die with the process); the adapter keeps a bounded
  disconnect for real runs. How: check whether gbrain ≥0.47 fixes it; if not,
  file upstream with the repro (ops call → disconnect under `bun test`).
  Restore the test teardowns when the pin moves past the fix. Effort: S.
  From: Cat 35 implementation (2026-08-16).

## P3

- [ ] **Cross-family (non-Anthropic) coverage judge.** Why: judge and distiller
  are both Anthropic in v1 (G-Eval self-preference risk, disclosed in the report).
  OPENAI_API_KEY is already required for embeddings, so a GPT-class judge needs
  no new secret. From: CEO deep review (disclosed limit).
