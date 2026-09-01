# TODOS

Deferred work with enough context to pick up cold. Each item names its
audit-finding lineage (see `docs/audit/2026-08-31-eval-audit.md`).

## P1 — keyed re-runs (blocked on API keys, not on code)

The 2026-08-31 audit fixed metric definitions and eval harnesses; the runs
below re-measure published numbers with the corrected code. None can run in
a keyless environment. Each command works from a fresh clone after
`bun install --frozen-lockfile`.

- [x] **LongMemEval recall_all@5 re-measurement** (finding longmemeval-01) —
  **RESOLVED 2026-08-31 at $0**: the May run's archived NDJSON was rescored
  with the audited aggregator (exact reconciliation 488/500 = 97.60% under
  old semantics; gt validated 500/500 vs the canonical dataset). Corrected
  headline **83.40% `recall_all@5`** published in the report's erratum-
  resolution block + README + comparison-systems; committed artifacts under
  `docs/benchmarks/2026-05-07-longmemeval-s/`. NOTE the previously
  documented command here was broken (`--dataset` takes a split NAME, not a
  path, and the runner defaults to k=8) — correct form:
  `bun eval/runner/longmemeval.ts --path ~/datasets/longmemeval/longmemeval_s.json --top-k 5`.
  Remaining (2026-08 fix-wave Phase 6): fresh keyed re-measurement at the
  current gbrain pin (May ran v0.28.8) + SVG regeneration from the new
  aggregate via `bun eval/runner/longmemeval-chart.ts`.
- [ ] **cat13 / cat13b full adapter matrix** (crash-fixed in WS2; the
  configureGateway bug means no honest full run exists post-v0.40). Needs
  `OPENAI_API_KEY`: `bun eval/runner/cat13-conceptual.ts` and
  `bun eval/runner/cat13b-source-swamp.ts`.
- [ ] **cat18 / cat18b provider matrix with pinned cells** (WS5 fix removed
  the hidden zerank-2 reranker from embedder-only cells; published numbers
  predate the pin). Needs OPENAI + VOYAGE keys. Note: ZeroEntropy's hosted
  API sunsets 2026-09-04 — zerank-2 cells are historical-only after that.
- [ ] **API-dependent negative controls** (WS3): each judge-based eval's
  degraded-config control (threshold: degraded <= 0.5x real, fixed seeds)
  needs one keyed run to prove benchmark sensitivity end-to-end.
- [ ] **Relational (Cats 1+2) re-measurement on the fixed metric helpers**
  (issue #24 finding 2): the 2026-04-23 scorecard's 97.9%/49.1% predates the
  shared-infra-02/03 metric fixes and the generators-06 corpus fix; the
  report now carries an erratum banner and the README qualifies the claim.
  Needs OPENAI_API_KEY: `BRAINBENCH_N=1 bun eval/runner/multi-adapter.ts`,
  then commit the receipt next to the report (none exists today).
- [ ] **LongMemEval fresh keyed re-run at the current pin + sessdiv rows**
  (2026-08 fix-wave Phase 6, expanded 2026-09-01): pass 1
  `--adapters hybrid,hybrid+expansion`, pass 2 the sessdiv adapters with
  `--overfetch-factor 3`; publish side by side with the May 83.40% row,
  never replacing it. Needs OPENAI_API_KEY (+ANTHROPIC for expansion);
  ~$2 cold, ~$0 on a warm embed cache. Rerank adapters additionally need a
  reranker provider key and are pending a successor to zerank-2 (hosted API
  sunset 2026-09-04).

## P2

- [ ] **Populate the remaining `eval/data/gold/` stubs** (critic finding:
  7 files were single-`_example` stubs while their _comments claimed real
  content; 4 have zero consumers). `contradictions.json` and
  `implicit-preferences.json` are now generated from planted fixtures;
  remaining: `backlinks.json`, `citations.json`, `entities.json`,
  `personalization-rubric.json`, `poison.json`, `qrels.json` — either
  populate from amara-life fixtures or delete the zero-consumer ones.
  `eval/runner/validate-data.ts` warns on every remaining stub.
- [ ] **PrecisionMemBench vendored-fixture byte-diff** (critic finding): the
  leaderboard-comparability claim rests on ATTRIBUTION.md's "byte-for-byte
  from upstream tenurehq/precisionmembench @ c9689ca6" — nobody has diffed
  it. `git clone` the upstream at that SHA and diff
  `eval/precisionmembench/fixtures/` + scorer files; record the result in
  ATTRIBUTION.md.
- [ ] **world-v1 regeneration with the fixed cache key** (finding
  generators-04): `eval/generators/gen.ts` now content-addresses its cache,
  but the committed 240-page world-v1 corpus predates the fix. Regeneration
  churns qrels/gold downstream, so batch it with the next intentional
  corpus change. Needs `ANTHROPIC_API_KEY` (Opus generation, ~$40 cold).

- [ ] **Cat 35: adopt the WS0 receipt conventions** (merged from main
  mid-remediation, predates them): on missing OPENAI_API_KEY it exits 2
  loudly but writes no receipt — should write run_status 'skipped' +
  skip_reason and honor --allow-skip / BRAINBENCH_ALLOW_SKIP like every
  other cat, so all.ts aggregates it from the receipt rather than the
  exit-code fallback. Its 135 tests and smoke pre-flight are already green
  against the v0.47.6.0 pin.

## P3

- [ ] **Upstream gbrain: search-config surface for `gbrain eval longmemeval`**
  (WS7): the CLI has no way to set a reranker for benchmark runs — the
  programmatic `searchConfigSnapshot` (v0.45 #3676) is not exported and no
  `--search-config KEY=VAL` flag exists. Until then,
  `scripts/run-shootout-phase1.sh` refuses reranker cells rather than
  running them unreranked under a reranked label. File a gbrain PR adding
  the flag, then re-enable cells A1/B1/C1/C2.
- [ ] **Upstream gbrain: export `./core/skillopt` subpath** (audit
  skillopt-cats-11): cat30-33 deep-import gbrain's skillopt orchestrator via
  node_modules paths that work on flat bun installs but break under isolated
  layouts. One export-map line upstream removes the last four deep imports.
- [ ] **Upstream gbrain: export a `gbrain/version` subpath** so eval repos
  don't need the resolve-and-walk helper in
  `eval/runner/gbrain-version.ts` (works fine, just inelegant).

---

## Cat 35 items (from the 2026-08-16 plan reviews, merged from main)
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
- [ ] **Held-out Cat 35 transcripts generated after the fix wave** (issue #24
  finding 7): the 61.5→88.1 story is disclosed honestly, but the verified-
  segment rescue admits exactly the four transcripts that failed, and no
  held-out set exists. Generate 5-10 fresh fixtures post-wave (same
  generator, new seed), score without touching the distiller, publish
  alongside the frozen-corpus number. ~$3 generation + judge costs.
- [ ] **Cat 35 hazard checks: `violated: null` on judge failure** (issue #24
  finding 8d): a judge outage can understate violation counts. Count
  null-verdict hazards separately in the receipt and fail the hazard gate
  when nulls exceed 0.
- [ ] **Template-blind relational variant** (issue #24 finding 6): paraphrase
  the four relational query templates (Haiku, seeded) and re-run
  multi-adapter to show how much of the graph-layer lift survives when the
  adapter can't pattern-match the generator's phrasing.
- [ ] **nDCG>1 latent guard** (issue #24 finding 8c, refuted-for-now
  cats26-29-04): if probes ever exceed the 300-word chunk threshold, nDCG
  over chunk slugs can exceed 1.0. Add a one-line clamp-or-throw guard in
  the nDCG helper so the hazard is tracked in code, not in memory.

- [ ] **FineSurE-style conciseness alignment.** Why: % of page content units
  aligned to some gold item complements distractor leakage; cut from v1 because
  it overlaps leakage + compression ratio. From: CEO review (deferred).

- [ ] **LLM claim decomposition for compound sentences.** Why: v1's
  `segmentClaims()` is mechanical and leaves compound claims atomic (disclosed
  limit); FactScore-style decomposition raises hallucination-metric resolution.
  Tradeoff: costs determinism. From: Codex round 2 (documented limit).

## P3

- [ ] **Cross-family (non-Anthropic) coverage judge.** Why: judge and distiller
  are both Anthropic in v1 (G-Eval self-preference risk, disclosed in the report).
  OPENAI_API_KEY is already required for embeddings, so a GPT-class judge needs
  no new secret. From: CEO deep review (disclosed limit).

## Completed

- [x] **Upstream: PGLite disconnect sync-spin under bun test (gbrain v0.46.3).**
  `PGLiteEngine.disconnect()` after ops-layer use froze the bun test runner in
  a synchronous WASM spin; `test/eval/agent-adapter.test.ts` skipped teardown
  as the mitigation, with "restore when the pin moves past the fix" as the
  exit condition. At the v0.47.8.0 pin the spin no longer reproduces (verified
  with a minimal engine repro AND the full adapter suite under `bun test`
  behind a kill-switch watchdog); all six skipped teardowns are restored. The
  adapter's bounded-disconnect race stays, as designed, for real runs.
  **Completed:** v0.4.0 (2026-08-31)
