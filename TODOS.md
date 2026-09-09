# Work that would strengthen the evidence

These items record unfinished work and its origin. An open box means the work has not been verified complete here. Historical cost estimates are planning context, not spending authorization.

The [August 31 audit](docs/audit/2026-08-31-eval-audit.md) explains the finding identifiers. The [September 9 retrieval refresh](docs/benchmarks/2026-09-09-retrieval-refresh.md) records the focused reruns accompanying the documentation rewrite. Do not treat that work as a rerun of every category below.

## Retrieval measurements

- [x] **Correct the May LongMemEval score** (`longmemeval-01`). Completed 2026-08-31 without new API calls. Rescoring the original rows produced 83.40% strict `recall_all@5`; the old scoring reconciled to 488/500 = 97.60%, and all 500 answer sets matched the reference dataset. Keep the corrected score and old metric identifiable in the [report](docs/benchmarks/2026-05-07-longmemeval-s.md).

- [x] **Fresh LongMemEval and session-diversity measurements** (fix-wave Phase 6, expanded 2026-09-01). The September 2 five-arm run and September 6 ranker-wave receipts now exist. They supersede the old note that a reranker successor was still needed: the measured reranker is Voyage `rerank-2.5`. A future run must name its own pin and settings. The local runner uses `--path` for the dataset file and `--top-k 5` for the published cutoff; `--dataset` takes a split name.

- [x] **Finish the post-audit Cat13/Cat13b comparison follow-up** (WS2). Completed September 9 with all six concept configurations and all five source-swamp adapters. The [fresh report](docs/benchmarks/2026-09-09-retrieval-refresh.md) includes explicit settings, execution observations, per-question rankings, and paired gains and losses. It keeps the vector-only source-swamp win and the one-question source-boost gain visible.

- [x] **Re-measure the historical relational result** (issue #24 finding 2). Completed September 9 with all four existing adapters and three ingestion orders. The specialized adapter measured 97.91% mean recall and 34.21% fixed-denominator precision at five. The [fresh report](docs/benchmarks/2026-09-09-retrieval-refresh.md#keep-the-historical-relationship-adapter-separate) preserves the rankings and separates this comparison from the controlled production relationship experiment. The April 23 97.9% recall / 49.1% precision table remains historical; its original per-query receipt is still missing.

- [ ] **Test relational wording the parser did not help design** (issue #24 finding 6). Paraphrase the four relational templates, using a fixed generated set, and test how much benefit remains when wording changes. The existing graph adapter recognizes the original templates. A fresh run of those same templates cannot close this gap.

- [ ] **Repeat the embedding-provider matrix with explicit settings** (Cat18/18b, WS5). The older runs could inherit an unintended reranker. Use supported provider cells and record their real configuration. The historical plan recorded ZeroEntropy's hosted API sunset as 2026-09-04; its old `zerank-2` cells cannot be treated as a current reproduction recipe.

- [ ] **Run live negative controls** (WS3). For model-backed categories, confirm that deliberately degraded configurations score at most half as well as the real ones under the fixed-seed rule. Scripted-model tests show that the checks can fail; live runs test whether they detect actual model-quality differences.

## Data and benchmark fidelity

- [ ] **Finish the answer-label stubs.** The audit identified seven single-example placeholders, four without consumers. `contradictions.json` and `implicit-preferences.json` are now generated from planted data. Review `backlinks.json`, `citations.json`, `entities.json`, `personalization-rubric.json`, `poison.json` and `qrels.json`; populate useful files or deliberately remove unused ones. The data validator reports remaining stubs.

- [ ] **Compare copied PrecisionMemBench files with upstream.** Check the fixtures and scorer against tenurehq/precisionmembench commit `c9689ca6`, accounting for the documented wrapper and path changes. Record the result in [ATTRIBUTION.md](eval/precisionmembench/ATTRIBUTION.md). Scorer parity tests and an upstream byte comparison answer different questions.

- [ ] **Regenerate world-v1 only with an intentional corpus revision** (`generators-04`). The generator's cache key is fixed, but the committed 240-page corpus predates it. Regeneration also changes downstream labels, so it should not be bundled into an ordinary docs or ranking change. The historical cold Opus estimate was about $40 and needs `ANTHROPIC_API_KEY`.

- [ ] **Guard a possible nDCG overflow** (issue #24 finding 8c; `cats26-29-04` was refuted for the tested corpus). If future inputs exceed the 300-word chunk threshold, repeated chunk slugs may allow a document-ranking score above 1.0. Add a meaningful check before expanding that corpus; do not describe the suspected case as an already demonstrated bug.

## Integration maintenance

- [ ] **Bring Cat35 missing-prerequisite receipts into the common contract** (WS0). The recorded issue is that missing `OPENAI_API_KEY` exits 2 without a skipped receipt. Add a skip reason and the common acknowledgment behavior so `all.ts` does not need its exit-code fallback. The original note recorded 135 passing tests and preflight checks at v0.47.6.0; that is not a new verification.

- [ ] **Retire or repair the historical shootout wrapper** (WS7). The wrapper still refuses reranker cells and Phase 2 lacks its driver. Newer gbrain experiments provide configuration controls, so the old task “add any search-config surface” is no longer an accurate description of all upstream capability. Decide how to update the wrapper against a tested CLI and supported providers before re-enabling cells. See [its operating notes](scripts/RUNBOOK_SHOOTOUT.md).

- [ ] **Export a public SkillOpt import path** (`skillopt-cats-11`). Cat30–33 use deep imports into gbrain's source. They work in the pinned flat installation but can break with isolated package layouts. An upstream `./core/skillopt` export would provide a stable contract.

- [ ] **Export gbrain's version.** A `gbrain/version` subpath would replace the path-resolution helper in `eval/runner/gbrain-version.ts`. The helper currently works; this is maintenance work.

## Cat35 publication and measurement

These items came from the August 16 plan reviews and the August 26 publication review.

- [ ] **Complete human judge calibration** (publication review, plan step 6b). A person must fill `human_verdict` for the 24 coverage pairs in `docs/benchmarks/2026-08-16-brainbench-cat35-transcript-distill/judge-calibration-2026-08-25.json`. The estimate is about 45 minutes. Then compute agreement and linearly weighted kappa with `--judge-calibration`, publish them and remove the pending banner. Do not use an agent's annotations as the missing human check.

- [ ] **Measure repeated-run variation** (Codex round 1). Run three full repetitions and compute paired per-item intervals for the headline. Current single-run deltas do not measure run-to-run variation. This costs roughly three full runs and is separate from the focused retrieval refresh.

- [ ] **Add held-out transcripts generated after the fix wave** (issue #24 finding 7). The 61.5% to 88.1% story includes rescue of the four transcripts that failed before the change. Generate 5–10 fresh cases with a new seed, freeze them, and score without changing the distiller. The old estimate was about $3 for generation plus judging.

- [ ] **Count missing hazard verdicts explicitly** (issue #24 finding 8d). A judge failure can leave `violated: null`, understating known violations. Record unknown verdicts separately and fail the hazard gate when any remain.

- [ ] **Try a coverage judge from another model family** (CEO review). The original distiller and judge both use Anthropic models, which may share preferences. An OpenAI judge can test that dependence; it requires a separately identified comparison.

## Cat35 implementation follow-ups

- [ ] **Reduce serial waiting** (performance review, 2026-08-26). The original full run took 29 minutes with about 130 judge calls processed serially, facts workers set to 1, and separate ingestion and dream phases. Try bounded parallel scoring, 2–4 facts workers and overlapping independent lanes. Merge outputs deterministically, replace repeated `perItem.find()` scans with a map, and recheck accounting and results.

- [ ] **Improve judge prompt caching** (performance review). Small system prompts were below the documented 1024-token caching threshold, while the same transcript was sent two to four times. Test a cacheable shared prefix and verify actual cache hits and cost. Bundle measurement with the scheduling change.

- [ ] **Prevent input text from closing judge delimiters** (security review). Documents containing `</document>` or `</transcript>` can interfere with the judge prompt. Escape or change the delimiters, bump `CAT35_JUDGE_PROMPT_VERSION`, and rerun before comparing scores.

- [ ] **Record mechanical page-shape checks** (testing review). `hasWikilink`, `selfContainedOpening` and `slugDisciplineOk` are tested but not part of the production receipt. Add a `usability_mechanical` cross-check and report disagreements with the model judge. Give `seededSample` a real caller or remove it.

- [ ] **Test generator helpers directly** (testing review). Export and test `checkTranscript`, `parseTurns` and `buildCalibrationSample`; share the duplicated Mulberry32 generator and `BANNED_RE` definitions. These deterministic checks should fail before a paid generation run.

- [ ] **Add more transcript formats** (CEO review E3). Derive Codex JSONL and ChatGPT export renderings from the same canonical turns. The original Cat35 corpus exercises Claude Code JSONL, leaving five other gbrain adapters outside this test. Existing labels can be reused.

- [ ] **Define an external TranscriptBench runner contract** (CEO review E4). Publish fixtures, labels and an input/output contract so other memory systems can test their write paths. Cat34's subprocess contract is a useful starting point.

- [ ] **Add a real-transcript qualitative appendix** (CEO review E5). Inspect three to five consented, redacted working sessions beside their generated notes. This requires a consent and redaction process; public synthetic results do not provide that permission.

- [ ] **Add an input aimed at manipulating the judge** (CEO review 3A). Include a transcript telling the judge to report everything as present, with a labeled expectation that this instruction has no effect.

- [ ] **Measure unnecessary content directly** (CEO review). A FineSurE-style measure would count how much of each generated page corresponds to a labeled useful item. It overlaps with leakage and compression metrics but could clarify why a page feels too long.

- [ ] **Split compound claims more carefully** (Codex round 2). Mechanical `segmentClaims` treats some compound sentences as one claim. Model-based decomposition could sharpen hallucination measurement while adding cost and nondeterminism.

## Completed infrastructure work

- [x] **PGLite teardown freeze under Bun tests** (gbrain v0.46.3). The synchronous WASM loop stopped reproducing at v0.47.8.0. A minimal reproduction and the adapter suite were checked with an external watchdog, and all six skipped teardowns were restored. The bounded disconnect handling for real runs remains. Completed in gbrain-evals v0.4.0, 2026-08-31.
