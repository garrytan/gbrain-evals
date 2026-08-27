# TODOS

Deferred work with enough context to pick up cold. Filed by the Cat 35 plan
reviews (2026-08-16); each entry names its origin.

## P1 — publication gate

- [ ] **Cat 35 judge-calibration hand-scoring (the open publication gate).**
  Why: the published report's §11 kappa line is `[pending]` until a human fills
  the `human_verdict` column for the 24 judge-filled coverage pairs in
  `docs/benchmarks/2026-08-16-brainbench-cat35-transcript-distill/judge-calibration-2026-08-25.json`
  (~45 min; each pair = gold statement vs the lane's artifact in `artifacts/`).
  Then `--judge-calibration` (parse fixed for the object-wrapped sample this
  ship) computes raw agreement + linearly weighted kappa; drop both into
  report §11 and remove the status banner. Deferred from plan step 6b by the
  explicit ship command; the report discloses the pending state. From: /ship
  plan-completion audit (2026-08-26).

## P2 — Cat 35 v1.1 candidates

- [ ] **Runner wall-clock bundle: parallelize the scoring loop + facts workers +
  lane overlap.** Why: the scoring phase is a fully serial await chain (~130
  judge calls one at a time — the llm-budget semaphore never holds more than 1
  slot), the facts lane pins `workers: 1`, and the dream lane waits for Engine A
  to finish; together plausibly half of the 29-minute full run. How: wrap
  per-(fixture, lane) scoring blocks in the existing `makeLimiter` (merge into
  perItem in deterministic order post-await), raise facts workers to 2-4,
  Promise.all Engine A with the dream lane. Deferred from ship: restructuring
  the pipeline that produced the committed baseline mid-ship risks subtle
  accounting drift; do it with a fresh BPRE + delta check. Also swap the
  `perItem.find()` linear re-scan in jointFallback for a keyed Map first —
  it becomes load-bearing under parallelism. From: /ship performance
  specialist (2026-08-26).
- [ ] **Judge prompt-cache layout.** Why: `cache_control: ephemeral` on the
  small judge system prompts is below Anthropic's minimum cacheable prefix
  (1024+ tokens), so nothing caches, while the large transcript/document is
  re-sent per call. How: move the shared transcript into a cacheable system
  block reused across the 2-4 calls per transcript. Bundle with the wall-clock
  item (same re-baseline). From: /ship performance specialist.
- [ ] **Judge delimiter neutralization (needs judge_prompt_version bump +
  re-run).** Why: judged documents are embedded in pseudo-XML judge prompts
  without escaping closing tags; distiller output containing `</document>`
  could steer verdicts (benchmark-integrity on synthetic corpora, disclosed in
  report §9). How: neutralize `</document>`/`</transcript>` in embedded
  bodies or use per-call random tag names; bump CAT35_JUDGE_PROMPT_VERSION;
  re-run and re-baseline. From: /ship security specialist.
- [ ] **Wire the mechanical page-shape checks into the receipt.** Why:
  `hasWikilink` / `selfContainedOpening` / `slugDisciplineOk` are unit-tested
  but nothing in production calls them (imports removed from the runner this
  ship); the usability checklist is judge-only for page shape. How: compute a
  `usability_mechanical` cross-check per dream page-set and record
  judge-vs-mechanical disagreements. Also give `seededSample` a caller or
  drop it. From: /ship testing + maintainability specialists.
- [ ] **Generator helper unit tests + export.** Why: `checkTranscript`
  (tolerance band that killed the first full run), `parseTurns`, and
  `buildCalibrationSample` are deterministic and $0-testable but unexported
  and untested; a regression surfaces as a failed multi-dollar generation run
  instead of a red test. How: export the helpers, add
  test/eval/transcript-distill-gen.test.ts; dedupe the copy-pasted Mulberry32 +
  BANNED_RE into exports from transcript-distill.ts while there. From: /ship
  testing + maintainability specialists.

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

## Completed

(none yet — items move here with **Completed:** vX.Y.Z (YYYY-MM-DD))
