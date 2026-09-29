# Outside review: the gbrain 10x plan

Date: 2026-09-28. Target: `PLAN.md`.

**Verdict: approve the safety fixes and measurement repairs, not the current claim that this program will demonstrate 10x better memory.** The plan is a useful remediation inventory. It still mistakes more categories for stronger evidence, tries to manufacture a holdout from an already-used test set, and assumes statistical machinery that does not exist. Its most important missing product work is preventing generated falsehoods from becoming durable memory and proving that real agent workflows improve after writes, corrections, failures, and restarts.

This is a fresh-context Astra review of an Opus-authored plan, with the different families checked in the recorded model metadata. I used the gstack engineering-review checks, without changing the plan, either repository, or consent settings. These are recommendations, not approved implementation decisions.

## Evidence notation and scope

- `P` = `PLAN.md`, SHA-256 `f465660b3163e8bb0ee4d543a903960d304d3c96b45805e944eeea49e4711b3b`.
- `G` = `gbrain`, commit `6bb88d128d70fef364444ec71f449f5a2cbd45ee`.
- `E` = `gbrain-evals`, commit `b439f127eefc9cbc0c7b2319dd55de47b75d8028`.
- `A/<file>` = `audit/<file>`.

I read the five audits and checked the consequential claims against implementation and saved evidence. I ran an independent dataset recount, the five existing comparator tests in the dependency-installed audit checkout, and a pure-function grounding reproduction. No paid calls or new quality benchmarks ran. Code findings below are current behavior; proposed failures are identified as risks rather than reported as observed outcomes.

## Top 10 amendments, ranked

### 1. Stop calling previously inspected data a holdout

**[P1, confidence 10/10]** `P:240-246` proposes a new “94-question tuning slice and a 376-question held-out slice.” But `P:21-23` already admits the configuration was chosen using all 470 questions. `A/evals-docs-infra.md:114-123` documents that selection. The same problem affects Cat13: `A/evals-correctness.md:601-605` records repeated use of its held-out concepts to choose defaults. Shuffling these examples now does not undo the information already used to design the system.

The suggested M confirmation also needs an overlap check, not an independence label. My recount found **all 28 selected IDs** in `E/eval/data/longmemeval-m-pilot-selection.json:1` in the S dataset. This establishes overlap for the existing pilot, not a full-content comparison of both datasets. Treat M as a distractor/scale stress test unless a manifest proves independent tasks. More distractors around previously seen questions are useful evidence, but answer a different question.

**Amendment:** label all historically inspected S/Cat13 data as development/regression data. Freeze a separately authored, access-controlled confirmation set before further tuning, split by source history, entity or concept, not just paraphrased question. Use development data in nightly CI; use the sealed set only at preregistered release decisions, then retire it from the untouched pool. Maintain a selection log including unsuccessful trials and who/what accessed the confirmation labels. New transcripts from the same generator test seed generalization, not necessarily real-world generalization; include independently authored tasks too.

**Acceptance:** the result manifest explains novelty and overlap at corpus, task, and label levels. No old example becomes “held out” through a new random seed. Disclose prior exposure rather than trying to repair it through terminology.

### 2. Replace the 10x scoreboards with a falsifiable user-outcome claim

**[P1, confidence 10/10]** `P:76-105` calls the following “10x”: 17 to 55 evidenced capabilities, 21 to at most 5 retrieval misses, 51 to at most 20 concept misses, eight winning changes, and zero synthetic invariant violations. Those are different quantities. The first three are approximately **3.24x, 4.2x, and 2.55x**, respectively. A count of winning commits is gameable by splitting changes or selecting whichever of many categories improves; listing losses does not make eight wins a net product gain.

There is also a hard ceiling. On the same S dataset used by the audit, the answerable-question distribution by number of distinct gold sessions is `{1:170, 2:229, 3:39, 4:18, 5:11, 6:3}`. **Three questions cannot pass strict all-hit@5 at all.** The published analysis already flags a six-session question at `E/docs/benchmarks/2026-09-06-longmemeval-ranker-wave.md:164-168`. Thus reducing 21 total misses tenfold is impossible without changing the metric, gold, or budget. The proposed five-miss target leaves just two avoidable misses; it is far more aggressive than its phrasing suggests.

**Amendment:** make coverage and experiment count operational indicators, not definitions of 10x. Choose a primary workload and claim before running: for example, a tenfold reduction in memory-caused task failures versus a frozen installed release, with fixed resource limits and hard safety guardrails. If that is not achieved, publish the measured factor. Keep the original strict metric unchanged and add a separately labeled feasible-subset diagnostic rather than quietly excluding impossible cases.

**Acceptance:** a stable baseline, deployment configuration, task population, denominator, resource envelope, and uncertainty interval exist before the target is evaluated. “No demonstrated gain” and “inconclusive” remain valid project outcomes, not reasons to search for another headline. Section “A defensible 10x definition” below gives the contract.

### 3. Make the first fusion result an experiment, not a promised win

**[P1, confidence 10/10]** `P:146-151` promises the “First measured win” from page-grain fusion. Yet G1 includes reranker order, entity-intent filtering, title boosts, dedup, filter parity, and other changes (`P:115`). A before/after SHA pair containing all of those cannot attribute a gain to fusion. Opaque IDs and scorer repairs also change the measuring instrument; comparing old contaminated receipts with corrected new receipts adds another confound.

The root defect is real: `G/src/core/search/hybrid.ts:2942-2954` keys fusion by chunk; `A/gbrain-read-path.md:39-67` reproduces split votes. But fixing it need not make hybrid beat vectors on every workload. Worse, page-grain scoring can win a session-ID metric while choosing a worse evidence snippet. The dedup path currently swaps in compiled-truth chunks (`G/src/core/search/dedup.ts:181-224`), and the benchmark reader expands a hit into the whole session (`G/src/eval/longmemeval/reader.ts:157-171`). That can conceal lost answer-bearing chunks from ordinary consumers.

**Amendment:** compare old ranking with corrected evaluation against **fusion-only**, then evaluate the full fix wave separately. This can use isolated commits or a temporary experiment toggle; it does not require retaining a permanent feature flag. Hold data, embeddings, candidate budgets, output units, and reranker treatment fixed. Record source-qualified page identity and the selected chunk IDs. Measure strict session hits, evidence-span recall within returned tokens, and downstream answer quality. Add single-chunk, multi-chunk, timeline-only, duplicate-content and same-slug/different-source cases.

**Acceptance:** the experiment can legitimately conclude “fusion is mechanically corrected, but aggregate quality is flat or worse.” Keep old qrels and thresholds immutable during the comparison; separately approve any justified baseline migration. Do not let regenerating the baselines in `P:115,677-678` redefine a regression away.

### 4. Implement real statistics, and never use statistical significance to waive correctness failures

**[P1, confidence 10/10]** The reuse claim in `P:216-219,450` is factually wrong. `gbrain eval compare` does **not** calculate paired bootstrap statistics. `G/src/commands/eval-compare.ts:85-96` takes aggregate metrics, `:134-145` picks the latest row by suite and mode, and `:176-194` prints those numbers. `:243` merely emits a methodology string claiming bootstrap. Its existing test at `G/test/eval-compare.test.ts:82-94` checks that the string contains “bootstrap”; the five tests pass without testing a bootstrap calculation.

The planned universal rule “p < 0.05 AND beyond tolerance” is also unsafe. A deterministic leak or three newly broken cases should fail immediately; three losses and no gains yield two-sided exact McNemar p = 0.25. Conversely, repeatedly testing many categories nightly without a multiplicity/sequential policy produces false alarms. Query-level resampling can exaggerate certainty when many paraphrases share a concept or source history. The existing relationship report explicitly says its 435 question/seed pairs are not independent (`E/docs/benchmarks/2026-09-09-retrieval-refresh.md:197-200`).

**Amendment:** reuse the actual cluster bootstrap/sign-swap and Holm implementation in `E/eval/runner/situation-recall-regression.ts:467-518,647-656`, after checking its applicability to each metric. Require unique paired IDs, identical eligibility, cluster IDs, absolute deltas, confidence intervals, power/minimum detectable effect, and a preregistered family of comparisons. Separate three gates: exact correctness/safety assertions; noisy quality non-inferiority; and exploratory dashboards. Repeated confirmation looks need a stated policy. Failure to reject a difference is not proof of equivalence.

**Acceptance:** known paired datasets test the numerical results, missing pairs block comparison, duplicated paraphrases do not multiply effective sample size, and one unauthorized disclosure blocks release regardless of p-value. Failed provider calls seen by users count in operational success even when conditional answer-quality statistics exclude them.

### 5. Match the whole comparison, not just the reader model

**[P1, confidence 10/10]** `P:308-321` treats a shared reader/judge and official prompts as sufficient for comparable QA and “neutral” external results. They are necessary controls, not sufficient ones. The historical reader sees full sessions selected by five chunks, capped at **60,000 characters per session** (`G/src/eval/longmemeval/reader.ts:157-171`; `E/docs/benchmarks/2026-09-06-longmemeval-ranker-wave.md:187-197`). A returned-chunk token count can dramatically understate reader context. The historical artifacts also omit the full hypotheses and reader inputs needed to rejudge the result.

A named audit problem remains insufficiently resolved: Cat29's baseline is five 200-character snippets, while the other arm writes a full answer (`G` is invoked from `E/eval/runner/cat29-think-vs-search.ts:537-559`). Raising n to 60 (`P:360-361`) does not fix the strawman. `P:118` says “Cat29” without making replacement of this baseline an explicit acceptance criterion. The code still measures answer formatting as well as reasoning.

**Amendment:** publish two separate experiments: a component ablation with identical reader, prompt, evidence budget and index, and a whole-system accuracy/cost/latency frontier under equal resource caps. Include strong lexical, vector-plus-reranker, and simple single-shot RAG baselines; use the same full-context reader where feasible. Share exact embedding caches for ranking ablations, or disclose measured embedding variation. Match retrieval depth/candidate pool, context construction, model snapshot, decoding, ingestion/enrichment work and allowed tools. An external harness run is independently specified, not independently operated unless another party actually ran it. Historical unmatched rows remain contextual, not a leaderboard.

**Acceptance:** show tokens actually delivered to every model, tokens used to build memory, storage, indexing and update time, cold/warm query p50/p95, and provider failures. State the lifetime query volume used to amortize write costs. Do not put a five-snippet bill next to five-full-session accuracy.

### 6. Keep one product adapter, but preserve an independent evaluator and replayable evidence

**[P1, confidence 9/10]** Unifying the duplicated runner is sensible (`P:161-168`). Moving rendering, reset **and scoring** behind a product-owned export, then checking that the wrapper agrees with the same implementation, is not an independent correctness check. Both paths can agree on the same leakage or denominator error. Existing audits show why that distinction matters (`A/evals-correctness.md:182-198`).

Receipts v2 add useful provenance (`P:179-194`), but “completed” plus SHA does not define a reproducible experiment. Current receipt hashes are optional (`E/eval/runner/receipt.ts:58-67`), and the accounting permits up to 10% infrastructure/judge errors without invalidation (`E/eval/runner/probe-accounting.ts:79-94`). A completed loop need not mean every preregistered case was judged. The offline verifier can currently recount saved booleans, not independently reconstruct the truth of all judgments; the historical report explicitly discloses missing hypotheses, raw judge responses and candidate pools (`E/docs/benchmarks/2026-09-06-longmemeval-ranker-wave.md:193-197`).

**Amendment:** share ingestion and product invocation, while retaining an evaluator-side reference scorer and gold store that the product cannot access. Test known rankings, label permutations, metadata removal, duplicate IDs, empty systems, wrong answers and deliberately broken adapters. Use an input allowlist, not just a test for the substring `answer_`; keep opaque-ID mappings scorer-side. Require dataset/split/scorer/prompt identities, the executed source-tree or package-content hash including dirty files, model/config identities, planned/attempted/scored/error counts, arm pairing, cache identities, output representation and all evaluated candidates. Save replayable prompts/answers/judgments and sanitized public evidence where licensing permits; hashes alone cannot be rejudged.

**Acceptance:** `verify` distinguishes artifact-integrity check, deterministic metric recount, and semantic rejudging. It does not claim that a matching hash proves quality. Preserve SUT failures as zero-success outcomes, with separate failure-origin diagnostics; missing judge outcomes produce explicit incomplete/inconclusive results rather than an easier denominator. Historical records stay immutable and labeled legacy/incomplete where appropriate.

### 7. Promote grounding and provenance preservation into the first product milestone

**[P1, confidence 10/10]** The plan covers non-destructive writes and dream idempotence (`P:374-380`) but defers consolidation/drift quality (`P:462-463`). These do not address a more direct quality defect: **unsupported generated claims can be preserved as ordinary prose.** `G/src/core/cycle/synthesize-verify.ts:441-444` explicitly removes only quotation marks when grounding fails. `:487-491` excludes pages without the transcript hash from whole-page verification. `A/gbrain-write-path.md:1119-1160` documents speaker contamination and the verification gap.

I reproduced it without a model call. Given source text `Speaker A: deployment remains unapproved.` and generated text `The notes confirm "the paid launch has full approval".`, `repairBody` returned `The notes confirm the paid launch has full approval.` with `stripped: 1`. That is not a harmless quotation repair. It leaves the false claim available to downstream memory.

**Amendment:** do not certify content as grounded by dequoting it. Preserve the original, quarantine unsupported derived assertions or mark them unverified and exclude them from authoritative recall. Track claim-to-source-span and speaker provenance through extraction, synthesis, updates and withdrawal. For edits to existing pages, verify the newly written claims against their actual supporting sources rather than exempting the page. Add a repeated-consolidation experiment measuring invented claims, lost valid facts, incorrect attribution, and source-supported retention after multiple cycles.

**Acceptance:** the reproduced false approval cannot become active supported memory; a verified claim stays retrievable with a valid citation; speaker swaps and invented numeric claims fail. A retention score cannot improve by copying unsupported material into memory. This work precedes large paid hallucination benchmarks and any new consolidation automation.

### 8. Add a production lifecycle matrix, not only a clean in-memory edit fuzzer

**[P1, confidence 9/10]** N14's 200 commits are useful (`P:237-239,296`) but do not establish durability or production behavior. The write audit says explicitly that its repros ran on in-memory PGLite with `persistence_brain.enabled = false` (`A/gbrain-write-path.md:8-14,157-161`). The read audit already found an engine parity failure (`A/gbrain-read-path.md:197-212`). The repository requires both engines to move together (`G/CLAUDE.md:94-97`, “Engine parity” invariant).

The user-visible transport also changes behavior: trusted local writes extract links inline, remote writes do not; stdio has best-effort sweeps, HTTP has none (`G/docs/guides/memory-boundaries.md:29-43`). A local helper call cannot prove a hosted agent remembers a write, and a clean transaction test cannot prove recovery after a crash. The docs require a new-conversation harness check (`:76-82`) and explain why a Markdown export is not a complete backup (`:69-74`). These are not represented as first-class acceptance journeys in the plan.

**Amendment:** extend N14/N5/N6 around a small end-to-end lifecycle: ingest → query → correct → reconcile → forget → restart → query. Run critical cases on both engines, coordinated/uncoordinated write paths where supported, local CLI, stdio and HTTP; deliberately test a new harness session. Inject provider outages, interruption between DB/file/projection steps, duplicate delivery, concurrent edit/sync/forget, stale checkpoint replay, migration and full backup/restore. Exercise authorization revocation, same-slug cross-source data, and metadata/cached outputs through the real remote boundary. Start with critical interactions rather than an unbounded Cartesian product.

**Acceptance:** no acknowledged write is silently lost, unrelated memory survives withdrawal, stale data does not reactivate after recovery, and remote answers stay within current grants. Report bounded freshness/recovery latency and residual failures. Zero failures on 200 dependent edits is a regression result, not a universal reliability rate.

### 9. Correct category semantics before calling them capability evidence

**[P1, confidence 10/10 for the mismatches; 8/10 for the proposed contracts]** Several new category descriptions promise more than the invoked subsystem provides:

- **A4:** `P:304` says the CRAG gate says “I don't know.” It grades retrieval strength, not answerability. `G/src/core/search/crag.ts:74-85` marks an exact entity lookup strong even if the requested attribute is absent. `G/src/core/ops/search.ts:724-745,790-798` returns results with confidence/escalation metadata; it does not automatically abstain. Testing only the 30 unanswerable rows cannot estimate the cost of refusing answerable questions.
- **N3:** `P:292,383-384` combines date-range retrieval, current state and as-of answers. Filtering event dates is not historical state reconstruction. `G/src/core/postgres-engine/facts.ts:539-548` filters `expired_at IS NULL` and `valid_from`; it can omit a superseded value needed for an earlier as-of answer. Specify event/valid time versus the time the system learned the fact, late arrivals, corrections, timezones and withdrawal precedence before choosing gold.
- **N5:** `P:299` promises reimport resistance while `P:600-603` promises “re-remembering works.” Existing code explicitly says “Explicit remember is not an implicit restore operation” (`G/src/core/facts/withdrawal.ts:85-89`). These are competing product policies until accidental replay, explicit restoration and a genuinely new fact with similar words are distinguished. Paraphrase-aware suppression additionally needs a false-suppression budget.

**Amendment:** write those semantic contracts first. Score CRAG calibration separately from actual answer abstention, using balanced answerable/unanswerable and missing-attribute cases plus risk-versus-coverage curves. Use an independent temporal ledger and explicit as-of semantics. Specify withdrawal identity, authority and reinstatement policy; evaluate semantically close retained claims as hard negatives. For entity resolution, report fragmentation/unresolved rates alongside wrong merges so “refuse everything” cannot win.

**Acceptance:** no hermetic stub is presented as learned-model quality. Oracle/no-memory controls are measured and reported, not used to delete every case the no-memory model happens to solve (`P:187`). Retain a representative workload and separately report the subset that demonstrably needs memory; otherwise the control itself selects a favorable benchmark.

### 10. Cut the first milestone, make spend limits enforceable, and sequence by evidence dependencies

**[P1, confidence 9/10]** The eight-week plan contains 16 product improvements, a cross-repository evaluation platform, about 13 new categories, and multiple external benchmark programs (`P:285-336,344-385,433-440`). The estimates invoke fixed 30x/50x productivity multipliers (`P:653-655`) without evidence. External benchmark integration, labeling, tuning independence and provider capacity are not compressed by code-generation speed.

The dependencies contradict the calendar. Five fixes are called parallel (`P:109`) although G3 depends on G2 and E2 on E1 (`P:627-637`). A “before G2/G3” write baseline is scheduled in Phase 1 after Phase 0 is already in flight (`P:237-239`). Zero unmeasured capabilities is incompatible with explicitly deferred multilingual, multimodal and consolidation work (`P:81-85,458-485`; `A/coverage-and-categories.md:117,171-175,186`). Categories cover multiple subfeatures, so adding one category cannot automatically promote every mapped capability to “solid.”

**Amendment:** deliver a narrow first milestone: urgent safety fixes; measurement/claim repair; one controlled retrieval experiment; one end-to-end memory-lifecycle experiment; and a cheap, genuinely independent confirmation pilot. Keep a minimal registry and receipt contract, but defer broad category renumbering, scaffold generation, release dispatch/automatic receipt PRs, every-release scorecard automation, full code-intelligence benchmarking, the frontier-reader showcase and the 10M-token sweep until the first outcome is measured. Retain diagnostic miss traces now rather than deferring `--why` (`P:487`). Preserve an old-SHA checkout for retrospective baseline measurement instead of delaying emergency fixes.

The $500 cap (`P:399-407`) is only credible with a durable shared reservation ledger that checks before every paid request, includes retries and write-side work, and reconciles failed runs. A required `--budget-usd` flag and a post-run spend report (`P:262-264`) do not by themselves enforce a program-wide cap. Estimate from a measured cold-cache pilot, include infrastructure/labeling time separately, and reserve capacity for reruns. Fifty labels per judged headline plus multiple ambiguous cases is not justified by a blanket two-hour allowance. Use blinded, stratified calibration including failures/disagreements, with adjudication and confidence intervals; temperature zero is not a determinism guarantee.

**Acceptance:** the first milestone has named owners, explicit dependencies and evidence-based cost/time estimates. A negative result does not trigger an unbudgeted benchmark shopping trip. Add the next benchmark because it resolves a remaining decision, not because it fills a row.

## High-leverage work missing from the current quality story

The amendments above are the priority order. Three outcome gaps deserve explicit ownership, rather than disappearing inside infrastructure tasks:

1. **Actual agent usefulness after retrieval.** The historical evidence has 53 complete-evidence/wrong-answer cases versus 13 incomplete-evidence/wrong-answer cases (`E/docs/benchmarks/2026-09-06-longmemeval-ranker-wave.md:172-176`). Those numbers are tainted by the known reader-label exposure, so they are a diagnostic priority, not a clean causal estimate. Re-run a small clean matched reader/plain-RAG/production-think study now. Include actual actions or preference use in a new agent session. Perfect session recall does not show that the agent remembered the right instruction or acted correctly.
2. **Memory quality over its lifetime.** Stable identity, provenance-preserving correction, grounded consolidation and bounded visibility/freshness are one chain. Measure unsupported-claim amplification, stale-served duration, unrelated-data survival, recovery and replay across that chain. The plan currently measures too many isolated helpers and defers the compounding failure mode.
3. **Representative default deployment.** Keep explicit keyless, keyed-default and opt-in enriched profiles. Report both engines and real remote behavior where the claim applies. The historical receipt's tuned balanced configuration, a synthetic hash-embedding CI run, and the fresh installed product are different systems. A green proxy does not establish quality for all three.

## Revised sequencing

| Order | Work | Exit condition |
|---|---|---|
| Immediately | Preserve old code/data/receipts; retract or qualify misleading claims; repair P0 data loss and obvious trust violations with targeted repro tests. | Safety repros fail on the old version and pass on the fix; no emergency patch waits for a registry or leaderboard. |
| Before any new quality claim | Fix leakage and scoring on both comparison arms; establish loaded-content identity, pair matching, frozen populations and a real comparator; freeze independent confirmation tasks. | Deliberately broken adapters fail; the baseline can be independently scored; no gold reaches the SUT. |
| First bounded experiment | Fusion-only versus unchanged ranking, plus full-wave regression; clean reader/plain-RAG pilot; current-versus-fixed lifecycle run. | Publish gains, losses, errors, contexts, costs and limits, even if there is no win. |
| Next product work | Grounding/provenance, crash/retry/durability, withdrawal, remote lifecycle and temporal/abstention contracts; follow the largest measured error class. | User-facing task success improves without a safety or resource regression. |
| Then independent confirmation | One outside-protocol pilot and fresh transcript/lifecycle tasks; scale only where it tests a chosen deployment envelope. | Matched and held-out evidence agrees sufficiently to support the scoped claim, or the discrepancy is investigated. |
| Only after that | Expand useful categories, automate publication, complete larger scale runs and add release dashboards. | Automation publishes sound evidence; it does not automate a weak methodology. |

H and K development runs can be continuous. They must not repeatedly expose the sealed confirmation set. Do not wait until week 3 to discover that the first headline's judge cannot distinguish a plausible false answer from a supported one.

## A defensible 10x definition

There is no honest single arithmetic factor combining search accuracy, retention, safety and capability count. Keep a dashboard, but attach “10x” only to a preregistered outcome with a real denominator.

**Proposed primary claim:** on a fixed distribution of memory-dependent agent tasks, the new release reduces end-to-end task failures by a factor of ten versus a frozen previous release, within fixed limits on latency, tokens and amortized cost, with no observed violation of the critical safety contracts. Alternatively, claim tenfold lower cost at matched task success. Choose one before results exist; do not choose whichever ratio later looks largest.

Define `failure_rate = unsuccessful planned tasks / all planned tasks`, including product errors and timeouts. For a clean matched baseline with nonzero failure rate, the improvement factor is `baseline_failure_rate / candidate_failure_rate`. Publish the numerator, denominator, clustered interval and paired gains/losses. If the baseline is already too near a structural ceiling, use another meaningful outcome or retire the 10x target. Do not change k, eligible cases or scoring after seeing the result. Zero observed failures does not mean infinite improvement; use an appropriate upper bound and disclose limited coverage.

Supporting scoreboards should remain separate:

- **Task quality:** supported answer/action correctness, stale answers, refusal tradeoffs and fresh-session recall on independent tasks.
- **Lifecycle safety:** data loss, wrong-entity writes, unauthorized disclosure, withdrawal residue/collateral and recovery. These are hard constraints, not tradeable points.
- **Efficiency:** real end-to-end latency, provider tokens, indexing/update costs, storage, and cost per successful task at a stated usage volume.
- **Evidence maturity:** regression-only, synthetic production-path, independently labeled held-out, or externally replicated. Category count alone proves none of these.

The existing numerical targets can remain stretch goals under their own names. They cannot be presented as already constituting a 10x definition. In particular, 17 to 55 “solid” capabilities needs an evidence-quality rubric and an honest unmeasured/deferred column, not a coverage count obtained by mapping many capability IDs to a single stubbed category.

## Verification record and limits

- The gstack installation/browser check passed. No repository files were edited by this review. `E/bun.lock` was already modified before this work, as also recorded by `A/evals-correctness.md:12`.
- The first comparator test command in `G` could not load the missing `ai` dependency. I reran the unchanged five tests in `audit/scratch-readpath/gb`, the audit's dependency-installed archive: **5 passed, 0 failed, 20 assertions**. The directory has no `.git`, so its existing root lookup printed fallback warnings. These tests establish formatter behavior, not valid statistical inference.
- The pure grounding reproduction ran in the same archive and produced the unsupported-claim retention shown above. No model, network, or paid request was used.
- The independent S recount read `audit/scratch-correctness/data/longmemeval_s_cleaned.json`, the dataset identified in `A/evals-correctness.md:170-174`. It found 500 questions, 470 answerable, three with six distinct gold sessions, and all 28 M-pilot IDs overlapping S. I did not fetch and compare the full M dataset; that remains a required overlap audit before any independence claim.
- I did not rerun the full benchmark suite, establish the actual fusion delta, measure a new failure-rate baseline, or verify proposed external-run cost estimates. The review rejects unsupported promises; it does not substitute new promises for them.

**Bottom line:** fix the dangerous bugs now, prove one controlled product improvement and one real memory lifecycle improvement next, then expand the evidence platform around those results. The plan should earn the word “10x” from outcomes, not build a scorecard that guarantees it.
