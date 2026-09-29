# Work that would strengthen the evidence

These items record unfinished work and its origin. An open box means the work has not been verified complete here. Historical cost estimates are planning context, not spending authorization.

The [August 31 audit](docs/audit/2026-08-31-eval-audit.md) explains the finding identifiers. The [September 9 retrieval refresh](docs/benchmarks/2026-09-09-retrieval-refresh.md) records the focused reruns accompanying the documentation rewrite. Do not treat that work as a rerun of every category below.

## Retrieval measurements

- [x] **Correct the May LongMemEval score** (`longmemeval-01`). Completed 2026-08-31 without new API calls. Rescoring the original rows produced 83.40% strict `recall_all@5`; the old scoring reconciled to 488/500 = 97.60%, and all 500 answer sets matched the reference dataset. Keep the corrected score and old metric identifiable in the [report](docs/benchmarks/2026-05-07-longmemeval-s.md).

- [x] **Fresh LongMemEval and session-diversity measurements** (fix-wave Phase 6, expanded 2026-09-01). The September 2 five-arm run and September 6 ranker-wave receipts now exist. They supersede the old note that a reranker successor was still needed: the measured reranker is Voyage `rerank-2.5`. A future run must name its own pin and settings. The local runner uses `--path` for the dataset file and `--top-k 5` for the published cutoff; `--dataset` takes a split name.

- [x] **Finish the post-audit Cat13/Cat13b comparison follow-up** (WS2). Completed September 9 with all six concept configurations and all five source-swamp adapters. The [fresh report](docs/benchmarks/2026-09-09-retrieval-refresh.md) includes explicit settings, execution observations, per-question rankings, and paired gains and losses. It keeps the vector-only source-swamp win and the one-question source-boost gain visible.

- [x] **Re-measure the historical relational result** (issue #24 finding 2). Completed September 9 with all four existing adapters and three ingestion orders. The specialized adapter measured 97.91% mean recall and 34.21% fixed-denominator precision at five. The [fresh report](docs/benchmarks/2026-09-09-retrieval-refresh.md#keep-the-historical-relationship-adapter-separate) preserves the rankings and separates this comparison from the controlled production relationship experiment. The April 23 97.9% recall / 49.1% precision table remains historical; its original per-query receipt is still missing.

- [x] **Test relational wording the parser did not help design** (issue #24 finding 6, September 28 audit B-RAB-01). Done 2026-09-29: a seeded paraphrase grammar, frozen before scoring, rewords the 145 questions. At `b80cad6` relationship retrieval fired on 174/435 template runs and 0/435 paraphrase runs, and paraphrase metrics were identical in both arms (recall at five 0.411). [Report](docs/benchmarks/2026-09-29-relational-paraphrase.md).

- [ ] **Make relationship retrieval work on reworded questions.** The paraphrase split in `relational-ab.ts` is the test: a parser or intent step that accepts ordinary wording should move its recall and first-place hits, which were flat on 2026-09-29.

- [x] **Repeat the ZeroEntropy cells of the embedding-provider matrix** (Cat18/18b, WS5). Closed as obsolete on 2026-09-28: ZeroEntropy's hosted API was retired on 2026-09-04 and gbrain master no longer ships its recipe, so the `zembed-1` and `zerank-2` cells cannot be re-run. The May numbers stay historical and are marked invalid in the [May snapshot](docs/benchmarks/2026-05-23-v0.40.6.0-snapshot.md).

- [ ] **Rebuild the embedding-provider matrix on supported providers** (Cat18/18b, WS5). Use cells such as `voyage-4`, OpenAI `text-embedding-3-large` and a local embedder, with and without the Voyage reranker, and record each cell's real configuration. The older runs counted chunk rows and could inherit an unintended reranker; `eval/runner/cat18b-embedding-rerank-matrix.ts` still hard-codes ZeroEntropy cells.

- [ ] **Run live negative controls** (WS3). For model-backed categories, confirm that deliberately degraded configurations score at most half as well as the real ones under the fixed-seed rule. Scripted-model tests show that the checks can fail; live runs test whether they detect actual model-quality differences.

- [ ] **Re-run LongMemEval answers with opaque session ids** (September 28 audit, C-01). Every labeled evidence session id starts with `answer_`, and the answer model saw those ids. v0.10.1 maps ids to opaque values in this repository's runners, with a test that no system or reader input contains `answer_`. Still to do: the paid re-run of the judged answers (433/500, which came from gbrain's own evaluator) and the reading-notes transfer (308/361 to 324/361). Retrieval was unaffected in a 30-question check, but the full retrieval arms should be recounted with opaque ids too.

- [ ] **Confirm the LongMemEval release configuration on held-out data** (September 28 audit, B4). Autocut off was chosen by comparing arms on the same 470 questions. Complete the preregistered [LongMemEval-M pilot](docs/benchmarks/2026-09-24-longmemeval-m-pilot-preregistration.md) (4 of 28 B cases done; C0/C1 not run) or score a fresh split. Since v0.10.6 the fresh set exists: the [sealed confirmation set](docs/benchmarks/2026-09-29-sealed-confirmation-protocol.md) (150 questions, 30 personas) is frozen and unopened; LongMemEval-S and M count as development data (plan amendment 1).

- [ ] **Preregister the first sealed-set release decision** (plan amendment 1). The [sealed confirmation set](docs/benchmarks/2026-09-29-sealed-confirmation-protocol.md) may be opened at most three times, each after a committed preregistration naming the candidate, the frozen comparison release, the metric and the decision rule. Its runner still lacks a paired, persona-clustered comparator; add one (reusing the cluster bootstrap in `situation-recall-regression.ts`) before the first decision.

- [ ] **Author a second, independently generated confirmation set** (plan amendment 1). v1 has one generator family, narrow temporal questions (29 of 30 ask for days between two events) and no assistant-said or preference questions. A v2 from a different model family, with a human-reviewed sample, would test whether v1's results depend on its author.

- [ ] **Run matched-reader answer accuracy** (September 28 audit, B6). Run gbrain retrieval with a GPT-4o reader and a frontier reader, notes first, so answer accuracy can be compared with published results that used the same reader. Until then README claims no answer-accuracy ranking.

- [ ] **Add a vector-plus-reranker concept cell** (September 28 audit, B2). The README concept comparison is 102/181 for gbrain against 118/181 for vectors without reranking; gbrain with reranking scored 130/181, but vectors with the same reranker were never run.

- [x] **Fix the attendance link direction in the relationship fixture** (September 28 audit, B3). Done in 0.10.3 for the Cat 2 answer key (now `person → meeting`, gbrain's stored orientation).

- [ ] **Find out why relationship retrieval never fires on "who attended" questions.** At `b80cad6` the keyless smoke (`relational-ab.ts --stub-embed --seeds 1`) still fires on 0/50 attendance questions against 13/40, 31/39 and 14/16 for the other templates. World-v1 meetings name attendees in prose, which current gbrain does not type as attendance.

- [ ] **Re-run Cat14 with the current blind runner** (September 28 audit, A-01). The May 75% result is retracted. The current runner is blind, judges both orders at temperature 0 and calls `runThink`; the historical cost was about $0.05.

- [ ] **Re-run the May snapshot categories with current runners** (September 28 audit, A-09 and Part B). Cats 19, 20 and 21 have hermetic or cheap live modes. Until receipts exist, the May rows stay marked invalid.

- [x] **Re-pin gbrain to a master commit or release tag** (September 28 audit, C1/C2). Done in 0.10.3: `gbrain` pins master `b80cad6`, the cue experiments use the `gbrain-cues` alias at `939232f`, and pins are read from `package.json`. `gbrain-reader` moved in 0.10.7 from `a9de062` (on no branch) to master `e78f1c3`, whose `src/` tree is byte-identical.

- [x] **Give the LongMemEval batch wrapper one shared budget.** Done in 0.10.7: `longmemeval-batch.sh` opens one budget-ledger run and passes its id to every worker as `--budget-run-id`, so `--budget-usd` caps all workers and restarted batches together.

## Memory lifecycle experiment (plan amendment 8)

The [September 29 lifecycle report](docs/benchmarks/2026-09-29-lifecycle.md) is the first slice. These items extend it.

- [ ] **Run the lifecycle on the library write path.** The published run uses a fresh `gbrain init` brain (managed persistence). The September 28 audit reproduced moved-page deletion, stale edges and stale timeline rows on the library path without the coordinator; none appeared on the managed path, even at v0.59.3.0. Add a cell that drives the same ledger through that path so #5668's replace-on-sync fixes get their own before/after.

- [ ] **Add the remaining amendment 8 injections.** Kill-9 between the database, file and projection steps; duplicate delivery; concurrent edit, sync and forget; stale checkpoint replay; migration and full backup/restore; grant revocation on the HTTP client; same-slug data across sources.

- [ ] **Give the near-name edge test a working control.** No tested build resolves `[[Exa Cheng]]` title links, so zero wrong near-name edges carries no signal. Use a link form the build resolves (slug links with a near-name slug, or frontmatter entity fields) and keep the title pair as a documented control.

- [ ] **Speed up the local-CLI arm.** Each read is a new process, so a CLI cell takes 8 to 14 minutes against about 1 minute over MCP. A batched read path (one process per checkpoint) would let the matrix run on every gbrain PR.

## Data and benchmark fidelity

- [x] **Finish the answer-label stubs.** Done in 0.10.7. `poison.json` is now generated from the planted skeleton fixtures, like `contradictions.json` and `implicit-preferences.json`, and a test holds all three byte-identical to the generator. `backlinks.json`, `citations.json`, `entities.json`, `personalization-rubric.json` and `qrels.json` had no generator and no runnable consumer and were removed rather than filled by hand. `validate-data.ts` now fails on a template row.

- [ ] **Score contradiction surfacing (N2) on the planted amara-life fixtures** (coverage audit F6). `gold/contradictions.json` (10 contradiction pairs, 5 stale facts) is generated but no runner reads it; its comment now says it is reserved for N2. Check each premise first: on 2026-09-29 both claims appeared verbatim in their generated source text for 9 of 15 fixtures (22 of 30 source sides); the other six may be paraphrased or missing.

- [ ] **Compare copied PrecisionMemBench files with upstream.** Check the fixtures and scorer against tenurehq/precisionmembench commit `c9689ca6`, accounting for the documented wrapper and path changes. Record the result in [ATTRIBUTION.md](eval/precisionmembench/ATTRIBUTION.md). Scorer parity tests and an upstream byte comparison answer different questions.

- [ ] **Regenerate world-v1 only with an intentional corpus revision** (`generators-04`). The generator's cache key is fixed, but the committed 240-page corpus predates it. Regeneration also changes downstream labels, so it should not be bundled into an ordinary docs or ranking change. The historical cold Opus estimate was about $40 and needs `ANTHROPIC_API_KEY`.

- [x] **Guard a possible nDCG overflow** (issue #24 finding 8c, September 28 audit C-16). Done in 0.10.1 (`7f3f276`): `dcgAtK` credits each id once, so nDCG cannot exceed 1, and `test/eval/metrics.test.ts` holds it with a duplicate-id case.

## Integration maintenance

- [ ] **Bring Cat35 missing-prerequisite receipts into the common contract** (WS0). The recorded issue is that missing `OPENAI_API_KEY` exits 2 without a skipped receipt, and the runner writes `<stamp>-cat35[-bpre].json` rather than `receipt.json`, so `all.ts` records its smoke run through the exit-code fallback. Add a skip reason, the common receipt name and the acknowledgment behavior. (A historical note recorded 135 passing tests at v0.47.6.0; that predates the current pin.)

- [ ] **Retire or repair the historical shootout wrapper** (WS7). The wrapper still refuses reranker cells and Phase 2 lacks its driver. Newer gbrain experiments provide configuration controls, so the old task “add any search-config surface” is no longer an accurate description of all upstream capability. Decide how to update the wrapper against a tested CLI and supported providers before re-enabling cells. See [its operating notes](scripts/RUNBOOK_SHOOTOUT.md).

- [x] **Export a public SkillOpt import path** (`skillopt-cats-11`). Completed upstream: gbrain exports `./core/skillopt` (`runSkillOpt`, `scoreSkillOnTasks`, `loadHeldOut`) at the current pin and on master. Cat30–33 switched from deep source imports to that export on 2026-09-28.

- [ ] **Move the gold store out of the product's process** (plan amendment 6). Since 0.10.7 the input allowlist covers LongMemEval retrieval and answers, Cat13, the reading-notes reader, Cat29's question and pairwise judge, and Cat35's system-under-test sources and coverage, leak and usability judges. The separation is still in-process: a product in the same process could open dataset files. Move the gold store out of process before calling any holdout sealed.

- [ ] **Preregister comparison families before the next paired runs** (plan amendment 4). `eval/runner/compare.ts --family` gates only when the family file predates the runs; commit each family with its run plan, including tolerances and cluster ids.

- [ ] **Export gbrain's version.** A `gbrain/version` subpath would replace the path-resolution helper in `eval/runner/gbrain-version.ts`. The helper currently works; this is maintenance work.

- [x] **Add score gates to Cat 2 and Cat 3** (September 28 audit, C-06/C7). Completed in v0.10.1: both runners write receipts and gate on regression floors, and CI runs them through `all.ts --tier offline`.

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

- [x] **Run every hermetic check in CI** (September 28 audit, C5 to C9). CI now runs the unit tests under `eval/`, the Python orchestrator tests, the LongMemEval recount, documentation and query validators, and an unfiltered `tsc`. The unit suite reuses a pre-migrated PGLite snapshot per embedding shape and runs as four concurrent shards, locally and in CI. The inert `postgres@3.4.9` patch and the unneeded PGLite postinstall link were removed. Completed in gbrain-evals v0.10.2, 2026-09-28.

- [x] **PGLite teardown freeze under Bun tests** (gbrain v0.46.3). The synchronous WASM loop stopped reproducing at v0.47.8.0. A minimal reproduction and the adapter suite were checked with an external watchdog, and all six skipped teardowns were restored. The bounded disconnect handling for real runs remains. Completed in gbrain-evals v0.4.0, 2026-08-31.
