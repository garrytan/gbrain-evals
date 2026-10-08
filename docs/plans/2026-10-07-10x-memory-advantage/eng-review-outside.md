OUTSIDE ENG REVIEW (GPT-6 Astra), input sha 3945060500fe2af5e1c4c70e4f3956d03a1b0cbe70b9e9a33b4408c1f79ebd83

The plan is not implementation-ready. Several supposedly additive changes require new state contracts, and the proposed measurement gates can certify the wrong behavior.
I read the complete plan, including section 11, verified its SHA, inspected all five audits, and checked the implementation and live branches. The accepted CEO/DX obligations are requirements below, not new findings.
Code references use G = `/workspace/gbrain` at `7aa2caa0`; E = `/workspace/gbrain-evals` at `f1ce49fe`; S = evals `origin/capy/oss-memory-shootout` at `9c07b7e2`; Q = evals `origin/evals/q1-scoreboard` at `6d5d88c7`.
Review was static and read-only apart from the requested fetches and this output. No test suite, paid model call, or sealed data opening was performed. Repository working files were not edited.

1. E-C specifies a nonexistent migration and omits the state needed for its accepted contract.
Severity: Critical.
Plan text at issue: E-C, “one additive (`content_chunks.embedded_at`)”; “tracks the accepted write's revision through each requested projection”; three days / fourteen hours.
Evidence: `G/src/schema.sql:306-321` already defines both `embedded_at` and `created_at`. `G/src/core/engine-sql/chunks.ts:252-278` overwrites chunk content and embedding timestamps without replacing `created_at`.
An old chunk corrected today can therefore appear to have waited months for its new vector. One timestamp also cannot identify which revision, active embedding column, fact job, or graph projection completed.
`G/src/core/search/projection-readiness.ts:31-45,61-73` caches on a page-generation clock and source archive state; its actual predicate at `:96-111` checks only text revision. Vector-only completion need not move that clock.
Amendment: “Remove the proposed embedded_at migration. Design revision-keyed projection obligations and terminal outcomes before implementation: requested, disabled, pending, completed, superseded, failed, and unknown. Define clock origin, active-column identity, and cache invalidation for every projection.”
Add races where revision R+1 arrives while R embeds, identical text is re-embedded, the active vector column changes, and embedding completes without a page edit. Prove the accepted fresh-session gate on PGLite, Postgres, and PgBouncer. Re-estimate E-C after that design, not before.

2. A9's grant field is not an automatically enforced paid-read budget.
Severity: Critical.
Plan text at issue: A9, “the cap is the grant's existing `budget_usd_per_day`”; no migration; five agent-hours.
Evidence: `G/src/core/grants/profiles.ts:55` defaults that cap to null. The legacy-token `PrincipalGrant` at `G/src/core/grants/model.ts:160-177` has no budget field. `G/src/core/minions/budget-meter.ts:90-106,355-368` reads caps from OAuth client rows, not from every possible principal.
There is reusable atomic accounting, but it is explicitly wired: `G/src/core/minions/delegated-spend.ts:42-61` wraps delegated jobs; `G/src/core/ops/image.ts:93-113` separately reserves image-search spend. Adding a mode to `ops/search.ts` does not inherit either guard.
The missing scope is admission, reservation, settlement, and authority revalidation for synchronous brief reads, including unknown usage after timeout. A preflight sum alone permits concurrent calls to exceed the cap.
Amendment: “A9 explicitly reuses the reservation meter around every provider invocation. Specify OAuth, legacy-token, and stdio behavior; null-cap and opt-out semantics; maximum input/output liability; unknown prices; revocation; and retry identity before exposing the mode.”
Gate with simultaneous calls at the remaining cap, grant tightening during a call, UTC rollover, disconnect after provider acceptance, and restart before settlement. Sequential budget-exhausted agent cases cannot catch these failures.

3. B1 can accidentally preserve the chunk bug while claiming shipped whole-session delivery.
Severity: High.
Plan text at issue: B1, “read through the shipped `query` evidence delivery (`auto`, `token_budget`)”; A5x reuses either #89 or Q1.
Evidence: `G/src/core/ops/search.ts:124-138` sets `legacyBudget` when query receives `token_budget`; `G/src/core/search/evidence-delivery.ts:186-202` changes an implicit/configured auto unit to chunk in that case. Only an explicit `return_unit` avoids that branch.
The adapters also differ: `S/eval/runner/systems/render.ts:79-87` repacks whole items with chars/4 and stops at the first overflow; `Q/eval/systems/gbrain-defaults/shim.py:593-596,740-752` forbids both delivery knobs in its shipped-default recipe. Q1's packer additionally cuts overflowing items.
Amendment: “Freeze exact wire requests: native-default `query` with neither override; separately named matched-budget `query {return_unit:'auto', token_budget:N}`. Record returned delivery metadata and actual final reader bytes. Never label a tuned budget arm shipped-default.”
Use a long-session fixture whose answer lies beyond the first chunk and another whose first item exceeds the outer budget. Assert API-to-reader parity, including any second packing loss. A paired accuracy result is not proof the intended delivery path ran.

4. R2's quality gate does not exercise the extraction model being changed.
Severity: High.
Plan text at issue: R2 gates the cheap default facts extractor on “N1 lifecycle (388/388) and takes-bootstrap per-kind precision.”
Evidence: `G/src/core/facts/extract.ts:48-72` resolves `facts.extraction_model`. `E/eval/runner/n1-knowledge-update.ts:6-13,32-35` instead writes explicit fence/ontology ledgers with provider keys stripped; it also makes Postgres report-only.
`E/eval/runner/takes-bootstrap/harness-overlay.mjs:23-29` runs `extractTakesFromPages`, a different production pipeline. Both proposed gates can remain green while background facts extraction returns zero useful facts.
Amendment: “Retain N1 and takes-bootstrap as regression gates, and add a paired facts-absorb quality gate through the real background job with the selected facts.extraction_model. Score recall as well as precision, attribution, correction handling, parse failures, and useful facts actually readable after restart.”
Require a disabled-extractor mutant and a drop-all-output mutant to fail the new gate. Record the resolved model at the facts invocation, not merely the requested runner model. This is additional wave-0 work before the Q1 default decision.

5. Q1's present finish barrier cannot close the shipped-default write-cost ledger.
Severity: High.
Plan text at issue: R2's default decision is expected to determine Q1's headline costs; B7 reuses Q1 receipts; complete per-projection findability waits until E-C/B9.
Evidence: `Q/eval/systems/gbrain-defaults/shim.py:288-309,698-725` makes the finish barrier depend on page presence, embeddings, and failing doctor checks. Warnings are collected but do not prevent readiness; there is no explicit facts-job drain condition.
`G/src/core/persistence/effect-facts.ts:147-152` marks the outbox effect complete when a facts-absorb job is only queued. `:50-64` distinguishes pending jobs from completed jobs. Vector readiness is not extraction completion.
`Q/eval/runner/q1/cell.ts:665-671` ends the background-meter phase after `finishIngest` and probes. Remaining work can fall outside ingest attribution or remain unfinished when the namespace is parked.
Amendment: “Before the Q1 freeze, define a background-cost closure independent of E-C's later product work. Include requested extraction jobs through a declared drain/horizon, record unfinished liabilities, and retain all tail spend under the originating ingest.”
Add a fake job that starts after vector readiness and a delayed retry after namespace switching. Neither may disappear from dollars or silently become read-phase cost. Do not equate an empty embedding backlog with zero remaining write cost.

6. The sibling harness already double-counts OpenAI cached input; A1 needs a shared usage contract.
Severity: High.
Plan text at issue: A1 adds provider usage to reader rows; A5 compares CACHE with all tokens counted; Q1 supplies derived token columns.
Evidence: `Q/eval/runner/memory-qa/qa.ts:189-190` sets `input_tokens` to OpenAI `prompt_tokens`, which already includes cached prompt tokens, and separately retains `cached_tokens`.
`Q/eval/runner/q1/cell.ts:825-827` then computes provider input as `input_tokens + cache_read_tokens + cache_write_tokens`. That is correct for Anthropic's separate usage buckets, but double-counts the OpenAI cached subset. A 100-token prompt with 60 cached becomes 160.
The main runner additionally averages replicate scores but keeps only the final replicate's answer, truncated to 2,000 characters (`E/eval/runner/memory-qa/run.ts:377-393`), so later committed-wrong rescoring cannot faithfully reproduce what was judged.
Amendment: “Create one provider-normalized usage and answer receipt shared by all lanes: total input, uncached input, cache-read/write subsets, output/reasoning usage, full answer, finish reason, and one record per replicate and attempted invocation.”
Use recorded synthetic provider responses to test both accounting conventions, truncation, and retry totals. A1's proposed mean-token reproduction is necessary but cannot catch either of these defects.

7. A5's interactive p95 cannot come from the proposed batch replay and response cache.
Severity: High.
Plan text at issue: A4 reuses `batch/w10.ts` and `memory-qa/qa.ts`; A5 ranks designs on “interactive p95 latency”; CACHE means provider prompt caching.
Evidence: `E/eval/runner/batch/w10.ts:3-16,44` is an asynchronous batch lane with a preregistered 0.5 price factor. `E/eval/runner/memory-qa/qa.ts:118-125` returns a cached answer from disk before making a provider call.
In the main memory-QA lane, `latency_ms` measures retrieval only (`run.ts:360-369`), and think then performs its own retrieval again (`:378-381`). In Q1, the reader timer also surrounds a cache-capable ChatClient (`Q/eval/runner/q1/cell.ts:817-827`).
Amendment: “Separate quality replay from interactive performance. Run a randomized synchronous timing cohort with answer caching disabled, end-to-end retrieval/builder/reader/fallback timers, and cold versus provider-cache-hit strata. Batch prices remain a separate cost column.”
Define CACHE's reusable prefix, hit rate, TTL, and writes/reads schedule, and DIGEST's amortization and invalidation schedule. A local answer-cache hit is not evidence of a provider prompt-cache win. Add this cohort to the paid manifest before promising the $400 total.

8. Reusing scoreAnswerV2 would violate the newly binding committed-wrong definition.
Severity: High.
Plan text at issue: A10 “reuses A4's `scoreAnswerV2`” while counting wrong committed values regardless of hedge wording.
Evidence: `E/eval/runner/a4-abstention.ts:143-150` explicitly turns a recognized wrong/sibling value into `abstain` whenever its abstention regex matches. `:166-171` removes errors from quality denominators.
This is not just a classifier accuracy concern: the existing branch contradicts the required definition. “I don't know for sure, but the owner is [wrong value]” can improve the apparent wrong-answer rate by adding an abstention phrase.
Amendment: “Version a new outcome instrument rather than reusing scoreAnswerV2 unchanged. Store commitment, correctness, abstention, hedge, and execution-error labels on separate axes; derive the reporting categories from those axes.”
Mutation tests must show that adding a hedge cannot improve a wrong committed answer, appending a wrong action cannot preserve a pure abstention, and errors cannot improve the program-primary failure rate. Keep historical scorer versions immutable.

9. A11 requires a new runner contract, not merely a new manifest argument.
Severity: High.
Plan text at issue: A11 invokes `sealed-confirmation.ts --manifest ...v2...`, uses current counted readers, and gates “non-inferior to 192/200.”
Evidence: `E/eval/runner/sealed-confirmation.ts:47-49` hardcodes Sonnet 4.6 and a GPT-4o judge. Its evidence-answer path at `:413-442` joins frozen hit blocks and writes that fixed reader into metadata; changing the dataset manifest does not change the reader.
The historical 192/200 score is the old reader/release outcome, not a paired control for today's models, evidence policy, and trust filtering. Section 11 requires current counted readers and does not authorize importing that score as the new control.
Amendment: “Before custody transfer, extend the sealed runner and receipt identity for the preregistered reader set, builder, policy, full prompt, and model settings. Run candidate and auto control contemporaneously on the identical sealed questions; 192/200 is historical context only.”
Prove resume rejects changed readers/builders and joins only identical control/candidate cohorts. Run a non-sealed miniature through freeze, answer, score, and decide first. Reprice this explicit cell matrix rather than inheriting the old $25 estimate.

10. The required power calculations are not implemented by the named power.ts.
Severity: High.
Plan text at issue: T0 and bet (a) use `power.ts` for a tenfold/5x failure ratio; B-man uses it for the paired size slope; B10 asks for a 2x wrong-answer ratio.
Evidence: `Q/eval/runner/q1/power.ts:165-176` defines conversation-size designs and additive `deltas_points`; `:209-254` resamples score pools, adds normal arm effects, and tests mean differences. It does not model a binary failure-risk ratio or a repeated-persona size interaction.
A minimum detectable percentage-point difference is not power for 10x when the baseline has a small number of failures. The latter also needs defined behavior at zero candidate failures and correlated repeats.
Amendment: “Add a separately tested power work item for the actual estimands: clustered paired failure-risk ratio for T0/A10, and within-persona system-by-size contrast for B-man. Freeze its data-generating assumptions, missingness, zero-event handling, and decision rule.”
Validate coverage and false-positive rates under null, sparse-event, ceiling, and heterogeneous-cluster simulations before using the output to authorize paid cells. Relabel existing Q1 power output as supporting mean-difference claims only.

11. D4 cannot infer “predates N operations” from the stored grant alone.
Severity: High.
Plan text at issue: D4 requires a caller-safe stale-grant diagnosis that distinguishes old snapshots from deliberate restrictions, with no migration.
Evidence: `G/src/core/grants/model.ts:15-40,74-94` stores an operation list, profile, and grant revision, but no operation-catalog version at mint or reason each operation was excluded. `G/src/core/grants/profiles.ts:41-48` snapshots every eligible operation when applying the profile.
An old profile snapshot and a newly restricted snapshot can have the same effective list. A current-set difference proves exclusion, not that the grant predates those operations. The plan also names the wrong whoami module: its handler is `G/src/core/ops/sources.ts:31-95`, not `ops/admin.ts`.
Amendment: “Separate proven blockers from inferred grant age. Legacy grants without catalog provenance report 'snapshot excludes currently eligible operations; original intent unknown'. If 'predates' must be asserted, persist catalog/version provenance for new grants and never synthesize it for old ones.”
A pair of identically shaped grants created for different reasons must receive the same uncertainty, not an automatic recommendation to broaden one. Put the diagnosis in the shared capabilities resolver and use the verifier's principal identity, not a display name.

12. Wave 0 already enters the live collisions deferred to wave 2, and two predecessors claim v220.
Severity: High.
Plan text at issue: only wave 2 branches after #6271/#6066; E-D follows the sync branch; “seven serial merge slots.”
Evidence: live #6271 is draft at `016997b1`, editing `src/mcp/dispatch.ts`, `src/core/interop-notices.ts`, `src/core/behavior-change-notice.ts`, and search/registry files. Those intersect wave-0 D4/S0, not just D2/D3.
Live #6066 is draft and CONFLICTING at `eb59ca84`, editing `src/core/cycle.ts` (E-A), search delivery, config, and temporal context. Both PRs add different `v220` migrations (`v220-persistence-client-request-id.ts:12-17`; `v220-pinned-questions.ts:9-14`).
The sync branch changes `engine-sql/chunks.ts` and `persistence/canonical-projections.ts` as well as `sync-drain.ts`, so E-C and W1 also depend on its final semantics. The fetched master has moved to `dcd0207a` while the review checkout remains the frozen baseline.
Amendment: “Register a predecessor DAG with GBRA-40 before wave 0: separate portable eval instrumentation from colliding product work; freeze the exact integration heads; renumber and regenerate both predecessor migrations at their slots; revalidate affected behavioral receipts after code-changing merges.”
Count 4a and 4b separately, plus any separately landed fixed-slot D8 slice and paired evals PRs, instead of assuming seven product gates. Preserve the frozen T0 baseline; it is the candidate tree and gate provenance that must follow actual integration.

13. W1's ledger must record canonical transitions, not differences in disposable projections.
Severity: Critical.
Plan text at issue: W1 adds “one additive (table, 3 indexes, RLS)” and records events “at projection time ... keyed on their existing stable identities.”
Evidence: `G/src/core/persistence/canonical-projections.ts:373-400` expires/detaches replaced facts from their row positions, deletes removed takes, and restores resolution fields during canonical reverts. `G/src/core/link-relationships.ts:101-107,133-164` maintains two materializations (`all`, `world`), overwrites them, and deletes them when evidence disappears.
Consequently a projection refresh, a real assertion, visibility-only recomputation, row reuse, and source/page identity change are not interchangeable ledger events. GBRA-58's rejected lower-trust replacement can occur before projection and cannot be discovered by a post-projection diff.
Amendment: “Write a ledger design before W1: logical identity independent of disposable row IDs, event taxonomy, canonical publication ownership, idempotency key, tie ordering, and backfill/live cutover. Enumerate every fact/take/edge mutation entry point and blocked-write event producer.”
Use fault injection after durable publication but before acknowledgement, concurrent relationship refreshes, no-op reimport, rename/source move, row reuse, and purge followed by replay. Assert exact semantic events and reconstruction, not just event counts. The existing backup obligation remains necessary but does not establish these invariants.

14. Page-at-time cannot use page_versions as an ordinary timestamped snapshot table.
Severity: High.
Plan text at issue: W2 treats page-at-time as its first straightforward slice; W1 backfills from page_versions.
Evidence: `G/src/core/page-state/versions.ts:5-17` stores the preimage during the replacing write; `G/src/schema.sql:608-613` defaults `snapshot_at` to transaction `now()`. `G/src/core/engine-sql/pages.ts:829-846` orders these preimages newest first.
Selecting the latest `snapshot_at <= T` therefore returns the wrong side of an edit. Page creation may have no preimage; same-transaction timestamps tie; a transaction beginning before T but committing after T was not observable at T. A migration that copies rows faithfully preserves these ambiguities.
Amendment: “Define page validity intervals from publication events, including initial creation, live head, deletion, restore, and tied timestamps. Distinguish historical source dates from observable recording/publication time; disclose or refuse intervals whose boundary cannot be proved.”
Test immediately before/at/after creation and two edits, a stalled transaction straddling T, a rollback, delete/recreate of the same slug, and a version-ID tie. Backfill quality must remain explicit even when T is later than a global coverage watermark.

15. W3 needs historical candidate generation, not a filter on today's search hits.
Severity: High.
Plan text at issue: W3, “evidence filtered to what was recorded by T,” names think/gather/temporal-context and estimates seven agent-hours.
Evidence: `G/src/core/think/gather.ts:144-150,160-198` searches current pages and current takes. `G/src/core/think/index.ts:526-542` then hydrates current page evidence. None of these paths retrieves old content that no longer matches the current index.
Filtering current candidates by recorded time loses deleted/replaced terms. Hydrating an old hit with current text leaks hindsight. Current graph expansion, entity aliases, summaries, trajectory facts, and calibration context also require an explicit temporal policy; filtering only page timestamps is insufficient.
Amendment: “Either keep V1 to addressed page-at-time and cited deltas, or add a historical retrieval design and estimate before W3. Every evidence-producing branch must read a T-bounded view or be disabled for known_as_of.”
Require an invariance test: after fixing history through T, arbitrarily change later text, aliases, graph edges, takes, and summaries; the T-bounded evidence must not change. Include a question answerable only by a phrase removed after T. A generic 200-question accuracy set will not establish that property.

16. W9/W10 promise a remote review path while specifying a gate that forbids it, and undo is broader than a summary block.
Severity: High.
Plan text at issue: W9 makes accept/reject/undo reachable by a thin-CLI owner; section 5 simultaneously requires a “trusted-local write gate”; W10 reuses `revert_version`.
Evidence: `G/src/core/ops/sources.ts:40-55` explicitly states stdio is remote/untrusted and only `remote === false` is trusted local; `G/src/mcp/dispatch.ts:763-767` preserves local/CLI boundaries. A remote owner's ordinary MCP grant cannot become trusted-local merely because the human owns the brain.
`G/src/core/persistence/page-prepare.ts:306-322` restores a page version, not a revision-guarded inverse of just the refreshed summary. Undo after an unrelated human edit can revert more than the accepted proposal.
Amendment: “Route hosted owner approvals through an explicitly authorized owner-admin preview/apply path, as D4 does, without relaxing remote trust. Specify proposal revision, evidence revisions, idempotent decision, stale rejection, and per-block inverse patch semantics.”
Test proposal→human edit→accept, accept→human edit→undo, revoked approval, and evidence purge before acceptance. Keep ordinary page-version revert separately named if the owner deliberately chooses a whole-page rollback.

17. D8's reuse assumption does not satisfy its unchanged-owned-configuration removal promise.
Severity: Medium.
Plan text at issue: D8 reuses ownership checks and receipts; `--remove` removes only unchanged owned configuration and resumes interrupted wiring.
Evidence: `G/src/core/bootstrap/hooks.ts:451-474` removes a hook immediately when its ownership marker matches, before checking its command identity. A user-edited marked hook is still removed by that helper. `G/src/commands/bootstrap.ts:1414-1429` treats plugin enablement as ownership while explicitly warning it is not a health signal.
`G/src/core/bootstrap/codex-hooks.ts:8-23` spans both hooks.json and trusted hashes in config.toml. This is a multi-file adoption/rollback problem, not one wrapper command.
Amendment: “Record exact installed configuration hashes in the existing receipt schema and compare-and-swap owned entries on resume/removal; preserve and report edited entries. Define a crash-recoverable order for MCP, hook, consent, and native trust-file writes.”
Add interrupted-between-files, edited-marker, changed Codex hook index, and two-install ownership tests. Budget this work within D8 explicitly; do not count a second run on an untouched install as idempotence coverage.

18. T0 cannot freeze a hook-based primary on an unextended Cat 40 execution loop.
Severity: High.
Plan text at issue: T0 uses Cat 40 family P/Cat 41 carriers, while D6 adds the family and its scorer in wave 5; the baseline is due before the architecture pilot.
Evidence: `E/eval/runner/cat40-model-ladder.ts:198-205` starts two sessions only for family F, then calls a custom runAgent loop. Defining a family-P row does not fire SessionStart/UserPromptSubmit or inject the product's hook output.
`G/src/core/context/resolve-ipc.ts:84-101` gives actual context injection bounded client/server deadlines. `E/eval/runner/cat41/scenarios.ts:6-10,69-70` instead uses native container sessions and explicit follow-ups. These are different experimental treatments.
Amendment: “Move the family-P execution and scoring plumbing needed by T0 into wave 1. Freeze the native-event delivery contract before baselining: context source, timing, byte cap, session reset, persistence between sessions, and startup maintenance.”
Use a forced-drop push mutant and a stale-correction mutant to prove the primary detects both failures. Validate one native-harness parity slice; otherwise call Cat 40's result an injected-context component test, not the end-to-end program primary. Re-estimate T0's six hours with this prerequisite included.

## Code claims I checked

Each verdict compares the plan's claim to the inspected implementation, not to an executed product test.

| Claim | File:line | Match/mismatch |
|---|---|---|
| LongMemEval expands retrieved slugs to whole sessions | `G/src/eval/longmemeval/reader.ts:157-171` | Match; 60k/session safety cap at :45. |
| That reader discards provider usage | `G/src/eval/longmemeval/reader.ts:179-184` | Match. |
| Memory-QA think counts question tokens | `E/eval/runner/memory-qa/run.ts:378-381` | Match. |
| Think has its own per-call evidence budget parameter | `G/src/core/think/index.ts:526-529` | Absent, matching the plan's stated gap. |
| #89's native gbrain adapter returns chunks | `S/eval/runner/systems/gbrain.ts:178-187` | Match. |
| Auto plus an implicit query token budget preserves whole-session delivery | `G/src/core/ops/search.ts:124-138`; `search/evidence-delivery.ts:186-202` | Mismatch unless return_unit is explicit. |
| #89 and Q1 are interchangeable matched-budget carriers | `S/eval/runner/systems/render.ts:79-87`; `Q/eval/runner/systems/render.ts:28-37,193-203` | Mismatch: packing and units differ. |
| Empty/unknown-only request_tools returns no descriptors | `G/src/core/ops/request-tools.ts:298-316` | Match. |
| Hidden-tool instruction is appended after the contract | `G/src/mcp/instructions.ts:109-115` | Match. |
| Grant profiles snapshot operations and pin starter | `G/src/core/grants/profiles.ts:41-48` | Match. |
| whoami lives in ops/admin.ts | `G/src/core/ops/sources.ts:31-95` | Mismatch; named file list is stale. |
| Registration constant is starter | `G/src/core/mcp-registration.ts:17-23` | Match. |
| Full lists all supplied operations; starter hides full-only parameters | `G/src/mcp/surface.ts:217-228` | Match. |
| Revealing descriptors widens dispatch authority | `G/src/mcp/surface.ts:365-380`; `mcp/dispatch.ts:739-744` | False; plan correctly distinguishes these. |
| Embed phase ignores blocked/failed counts after its stall check | `G/src/core/cycle.ts:1633-1654` | Match. |
| Doctor accepts ≥90% coverage despite absolute backlog | `G/src/commands/doctor/checks/schema-health.ts:372-385` | Match. |
| embedded_at needs adding | `G/src/schema.sql:306-321` | Mismatch; already present. |
| Current projection readiness is scoped and revision-aware | `G/src/core/search/projection-readiness.ts:80-115` | Match for text only. |
| Facts extraction defaults on, with Sonnet 4.6 fallback | `G/src/core/facts/extract.ts:48-72`; `model-config.ts:91-95` | Match. |
| N1 measures the quality of that extractor | `E/eval/runner/n1-knowledge-update.ts:6-13,32-35` | Mismatch; explicit hermetic ledger writes. |
| page_versions contains write-time preimages | `G/src/core/page-state/versions.ts:5-17` | Match; this matters to as-of interval direction. |
| migrate-engine currently copies page_versions | `G/src/commands/migrate-engine.ts:958,1069,1099-1105` | No copy step found; plan correctly calls for one. |
| Relationships preserve every prior recorded state | `G/src/core/link-relationships.ts:133-164` | False; current materializations overwrite/delete, as the audit warns. |
| groundSource establishes entailment | `G/src/core/cycle/synthesize-verify.ts:569-580` | False; plan correctly limits it to grounding/provenance. |
| W5 still needs takes_update to honor since_supplied | `G/src/core/persistence/takes-prepare.ts:121-124`; `takes-write.ts:681` | Already honored in the inspected paths; require a failing probe before retaining this fix. |
| Existing takes_scorecard is read-scoped and holder-filtered | `G/src/core/ops/takes.ts:91-121` | Match; W7 must gate new private fields without accidentally removing existing authorized output. |
| get_brain_identity.last_sync_iso is always null | `G/src/core/ops/admin.ts:103-104,139` | Match. |
| Codex writer proves push hooks | `G/src/core/bootstrap/codex-hooks.ts:2-23` | No; SessionEnd capture only, matching the accepted DX qualification. |
| New volunteer channel strings alone require SQL enum migration | `G/src/schema.sql:837-845`; `context/volunteer-events.ts:32-36` | No; SQL uses TEXT, but wire guards must change. |
| Hybrid pool work is confined to hybrid.ts | `G/src/core/search/hybrid.ts:47-52,57-64` | Incomplete; request/arms/rank modules own the extracted stages. |
| power.ts already supports failure ratios and size slopes | `Q/eval/runner/q1/power.ts:176,209-254` | Mismatch; mean-difference simulation. |

## Merge collisions I checked

- `gh pr view 6271 --repo garrytan/gbrain`: OPEN, draft, head `016997b1d743b0992abb947de1999c71ae961838`; mergeable at inspection. Its fetched three-dot diff contains 138 files. Dispatch, notice, behavior-change, search, config, and registry overlap is real; wave 0 is affected.
- `gh pr view 6066 --repo garrytan/gbrain`: OPEN, draft, head `eb59ca84faa2ad77040067ec4cf78e6a9956e75d`; CONFLICTING at inspection. Its fetched three-dot diff contains 238 files. Cycle, evidence-delivery, temporal-context, config, and search overlap is real.
- #6271/#6066 have 20 common `src/` paths, including both engines, engine/types interfaces, canonical memory mutations, page batches, facts writers, gateway, search, and the migration registry. The overlap is substantially wider than surface and think files.
- Both branches currently claim migration 220. This is a confirmed registry/number collision, not a predicted text conflict. Follow `G/CONTRIBUTING.md:405-427`: renumber at the merge slot and regenerate registry/schema/goldens rather than hand-merging generated output.
- Fetched `origin/capy/sync-feeder-fast-writes` exists at `112a3fcb2bd158daff552eff1ccd3ef7a73426b3`. `git diff --stat origin/master...origin/capy/sync-feeder-fast-writes` reports 115 files, 5,146 insertions, 933 deletions. E-D's sync-drain overlap is confirmed; E-C's chunks and W1's canonical-projection overlap must also enter the dependency map.
- Issue #5575 is OPEN and remains a trust-tier/write-gate/purge specification. Its I2/I3/I4 obligations cover derived taint, rejected supersession, and every context surface. I did not find a landed implementation pin from the issue query; “after GBRA-58” is a contract dependency, not proof that its schema or event API is ready.
- Evals branches differ materially: S supplies chunk-native packing; Q supplies a separate installed-default MCP shim and reader-calibrated packing. B1/A1/A5x changes need an explicit owner and integration base across both branches; a fix on S alone does not fix Q.
- Fetched master is `dcd0207a5bc7154690f179c3c64e8ab5f04028d6`, after #6284; the review checkout stays `7aa2caa0`. These are point-in-time observations, not guarantees about the queue tomorrow.
- Full-gate requirements are not replaced by these inspections: `G/CONTRIBUTING.md:405-411` requires verify plus full unit/E2E on PGLite, direct Postgres, and PgBouncer; `G/docs/TESTING.md:1742-1759` names the authority regression suites. The integrator must rerun on the actual integrated candidate tree.

Recommendation: amend the implementation contracts and complete a keyless harness-repair phase before authorizing the wave-1 paid pilot, because the current plan can meter the wrong tokens, exercise the wrong extractor or delivery path, and declare temporal/readiness guarantees that its proposed data model cannot represent.
