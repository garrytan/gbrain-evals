# CEO outside voice: budgeted evidence delivery

## Verdict

Revise before running E1: the plan establishes an adapter mismatch and a real budget-contract defect, but it does not establish the proposed attribution of the answer-quality gap or the superiority of depth-first packing. Its first experiment requires cap behavior its unchanged baseline does not implement, its promotion guardrails conflict with the proposed output changes, and its facts experiment cannot run as described on the cited harness. Keep the measurement-first sequence, repair those contracts, and compare the cheapest existing delivery options before spending a held-out opening on a new default.

## Review basis

Independent review by OpenAI GPT-6 Astra on Capy, not a Codex CLI review; no other reviewer's file was read. Mode: **SELECTIVE EXPANSION**, strategy and measurement readiness. This review makes no product edits, changes no preregistration, authorizes no paid calls, and applies no User Challenge.

`PLAN.md` below means `docs/plans/2026-10-08-gbrain-budgeted-delivery/PLAN.md` at gbrain-evals `7afdf3b4eaac9c11bd2a1de8f3bd45dd7a40e21c`. Harness citations refer to shootout commit `9c07b7e2f90715593b43d9bdc2a7652174636691`; `gbrain:` citations refer to master `7aa2caa0aa2a9f031730cd351cd516cf4f9f5802`. I confirmed the cited delivery, operation, deduplication, lean-row, and final-ranking files have no diff from the counted build `c5fb0201`.

I recomputed gbrain's native/rehydrated QA from the counted master rows: LongMemEval-S 59.0%/78.0%, LoCoMo dev 64.91%/72.74%, and BEAM dev 60.50%/59.39%. I also recomputed the committed keyless replay's overrun counts and token ratios. These checks support the reported observations, not a causal decomposition. No live paid reproduction, new model comparison, or sealed-label access occurred.

## Numbered findings

1. **High | E1 / C0: the unchanged baseline cannot promise a hard delivery cap.** `PLAN.md:205-206,339-341` requires today's `query-auto` to deliver no more than 8,000 harness tokens after passing a 6,900-token product budget. The same plan's replay shows that `auto` spills chunks outside its own budget; reducing the number passed to that allocator does not remove the spill path (`gbrain:src/core/search/evidence-delivery.ts:894-898,944-957`; `gbrain:test/evidence-delivery.test.ts:272-287`). The 1.15 conversion is also an average, not a bound: the committed LongMemEval replay's default-budget ratio reaches **1.226**, and 53/100 rows exceed 1.15. **Fix:** make baseline overruns a measured outcome, not an impossible precondition; retain raw delivered bytes, product-token count, harness count, and explicitly reported common-packer cuts. Put the strict serialized-context cap on the proposed cap-enforcing candidate, using the actual counting function rather than a mean conversion. Add a BEAM keyless budget check, which the listed replay artifacts do not contain. This prevents E1 from either blocking forever or silently fixing its own control.

2. **High | C0 / E1: the specified call is ambiguous about the operation it measures.** A numeric `query.token_budget` without explicit `return_unit` invokes legacy chunk budgeting, even if the configured/default unit is `auto`: `gbrain:src/core/ops/search.ts:129-140` passes `legacyBudget`, and `gbrain:src/core/search/evidence-delivery.ts:186-202` changes the implied unit to `chunk`. The keyless replay explicitly supplies `returnUnit: 'auto'`; C0 only spells out `expand: false` and `token_budget` (`PLAN.md:200-206`). Separately, E1's library arm requests 40 hits while the operation arm defaults to 25, and the operation uses `hybridSearchCached` plus operation-level behavior, not just the library call (`gbrain:src/core/ops/search.ts:919-978`). **Fix:** preregister exact parameter objects, including `return_unit: 'auto'`, local/remote context, limit, expansion, and resolved search settings. Distinguish a real product-path measurement from a delivery-only ablation on one frozen ranked hit list; prove their pre-delivery equivalence before describing their difference as delivery alone. If the intent is to measure an ordinary caller passing only a budget, retain that legacy-chunk call as a separately labeled case.

3. **High | Diagnosis / E1: the causal conclusion is stronger than the experiment.** `PLAN.md:124-133,169-185` calls the gap's proportion known and says the temporal loss is dates rather than retrieval. Rehydration jointly changes item membership under the budget, passage coverage, chronological ordering, serialization, date visibility, and reader prompt: native uses `NATIVE_READER_TEMPLATE`, while rehydrated uses `READER_TEMPLATE` and JSON session turns (`eval/runner/systems/render.ts:36,79-123`; `eval/runner/memory-qa/qa.ts:35,45-47`). Even `chunk-dated` can change the last item that fits. **Fix:** describe the observed gain as a delivery-and-presentation bundle until isolated; freeze the selected IDs and reserve equal header overhead for a genuine date-only pair. Use the same prompt and rendering for an isolated chunk/window/page comparison, keeping the historical rehydrated arm as a separate reference. Do not call the gap to memory-bank or graph-pipeline an established benefit of fact extraction: those are different whole systems, not a gbrain extraction ablation. The strategic inference that depth first is the right default is a **User Challenge**, not an automatically applied reversal of the plan.

4. **High | C1 + C2 / promotion rule: two exact guardrails contradict the proposed change.** C1 adds a header to every dated block, including roomy default-budget responses, while `PLAN.md:369-373` requires byte identity when today's delivery cut nothing. C0 also exposes delivered blocks as adapter items; the harness computes recall from those returned items (`eval/runner/memory-qa/run.ts:667-673`), so C2 can correctly retain fewer than five sessions and fail the supposedly unchanged `recall_all@5` guardrail despite identical upstream ranking. **Fix:** state separately what must remain byte-identical for **C2-only**, what intentionally changes under **C1**, and what applies to the bundle. Capture upstream ranked hits for an exact retrieval-invariance check, then report delivered-source coverage after packing as a distinct metric. Scope the harness-token guarantee to the serialized reader context and the product-token guarantee to its documented product boundary. Do not relax one ambiguous invariant until a failing run happens.

5. **High | C2 / blast radius: conversation-only evidence cannot establish the promised global hard cap.** The first C2 step pays for non-conversation chunks “as today” (`PLAN.md:232-239`). Today those chunks are reserved without being bounded and later emitted unchanged; their sum can exceed B before any conversation is considered (`gbrain:src/core/search/evidence-delivery.ts:827-837,894-898,944-961`). Making conversation spills disappear does not fix this case. **Fix:** define a single final budget across dated titles, bodies, omission markers, and non-conversation chunks; specify what happens when even one minimum unit exceeds it. Add mixed note/chat, all-note, tiny-budget, missing-date, and redaction-growth cases, plus a source-swamp regression. Preserve the existing authorization-safe page fetch and protected-body projection. The mixed-corpus proof is in this change's blast radius, not an optional future benchmark.

6. **Medium | candidate selection: the cheapest plausible solutions are missing from the comparison.** C2 bundles two mechanisms, cap enforcement and depth-first allocation, while C3 changes ranking and C4 builds another retrieval path. The keyless replay already includes a five-hit configuration, and the product already supports `window`, `page`, and `return_window`; the plan does not compare these with a cap-only, floors-first control. Thus a positive C2 result would not show that depth first was necessary, and a small E1 gap does not justify jumping directly to facts (`PLAN.md:230-256,330-333`). **Fix:** on the shared freeze, compare cap-only floors-first, dated window delivery, a small explicit hit limit, and depth first under one renderer and exact budget. Existing knobs should be references, not newly tuned published shootout rows. Auto-select this as a provisional **Taste** decision under reuse and pragmatism; keep C3-C5 as conditional candidates rather than prerequisites for fixing the cap.

7. **High | C4: the existing facts lane does not implement the proposed experiment.** The cited lane is restricted to `--system gbrain`, rejecting non-legacy adapters (`eval/runner/memory-qa/run.ts:397-405`). It takes all saved facts from the top retrieved sessions, not query-ranked facts, and its facts prompt bypasses the session budget packer; facts context tokens are not recorded (`run.ts:756-774`; `eval/runner/memory-qa/qa.ts:74-77`). It cannot establish “facts-only at 2,000” or “facts-then-sessions at 8,000” against C2 without harness work. **Fix:** separate a cheap saved-facts feasibility probe from the new production fact-search candidate. For the latter, require a bounded native-item adapter, query-based fact selection, exact token accounting, and a reusable frozen extraction artifact before its priced run. Carry over `recall`'s source/visibility and expiry rules rather than treating embeddings as a ready public search API (`gbrain:src/core/ops/facts.ts:232-244`; `gbrain:src/core/facts/similar-active.ts:57-65`). Require cross-source/private/deleted-fact tests and a minimum transcript allocation for assistant-side questions. This is a larger product and measurement change than an extra delivery enum.

8. **High | H1: the held-out justification cites the wrong baseline and omits a required exposure disclosure.** The advertised 66% score is the old **chunk** arm, not today's `auto` under the proposed budget and 25-hit limit (`PLAN.md:381-391`). Decision 1 used five hits at 24,000 product tokens; all blocks were whole and `auto` scored 96% (`docs/benchmarks/2026-10-02-sealed-v2-decision-1.md:23-29,54-56`). That result does not establish power for the new tight-budget pair. Also, the v2 protocol explicitly requires future preregistrations to disclose the P8 exposure of sessions from 34/40 histories (`docs/benchmarks/2026-10-01-sealed-confirmation-v2-protocol.md:86`). **Fix:** define the exact tight/default-budget pairs and candidate family before requesting custody; justify sample size using dev analogues and detectable effects, not the old chunk score. Include the mandated exposure and verified access-log state. Keep “inconclusive, remain opt-in” as a terminal result. Do not inspect sealed labels or tune a budget on that set to resolve these uncertainties.

9. **Medium | costs: the totals mix different token envelopes and omit the economic decision for facts.** E2 prices four LongMemEval arms at roughly four times the 8,000-token arm cost, although two run at the 24,000-product-token default (`PLAN.md:189-196,254-256`). Its own replay puts that default at 27,598 harness tokens on average. The exact dollar increment cannot be derived until those contexts are frozen; it should not be billed as four identical cheap arms. The raw counted native 8,000-token rows contain 663,800 reader input and 23,627 output tokens, or about **$1.896 before judges** at the historical reader's prices, which supports the tight-arm estimate only. **Fix:** price every distinct budget/model/arm from frozen serialized inputs, include output allowance, judges, extraction, embeddings, retries, and concurrency reservations, and distinguish cold-cache from reused work. For C4 preregister a lifecycle cost test: `extra ingest cost / per-query savings = break-even query count`, separately from QA and token reduction. A $1 ingest cost with an illustrative $0.015 saved per query needs about 67 queries before break-even; that is arithmetic, not a measured product claim. Keep caps as proposals for approval, not evidence that all planned cells fit.

10. **High | E1 / reader policy: “measurement, not product decision” is not the repository's model-rule exception.** `PLAN.md:335-337` excludes frontier replay, but E1 uses answer scores to deprioritize C2 and promote C4 (`PLAN.md:328-333`). `CLAUDE.md:82-97` requires the newest Opus, GPT, Sonnet, and Fable for answer-model benchmarks and separately protects already-preregistered historical gates. Keeping the frozen readers as a link is useful; using them alone for new candidate prioritization is not the same thing. **Fix:** preserve the old arms as historical reproduction, add the required frontier readers to the new decision-bearing frozen-context comparison, and revise the estimate before spending. If the requested $30 scope cannot cover that, record the unresolved budget/scope choice; do not invent a policy exemption or quietly increase the cap. No new paid run is approved by this review.

11. **Medium | decision rules: low-powered point thresholds can choose the next project almost at random.** The plan acknowledges that 100 questions detect roughly 12-18 points, then uses an observed gap below 5 points to move from C2 to C4 and a 3-point LoCoMo change to advance C4 (`PLAN.md:288-289,330-333,364-377`). LoCoMo has only three conversation clusters; neither threshold establishes the claimed mechanism. C4's “cost” verdict also sits under an otherwise quality-superiority primary rule. **Fix:** mark these as exploratory triage rules with an explicit uncertain outcome, preregister a separate cost/non-inferiority rule, and define the candidate family, budget sweep, and frontier-reader ceiling treatment before results arrive. Require uncertainty intervals beside point estimates; reserve held-out promotion for one frozen decision rather than whichever interpretation looks strongest after E1-E5.

## The five changes that most improve the plan

1. **Write an executable measurement contract before E1.** Pin `return_unit`, limit, expansion, transport context, both token units, raw-overrun accounting, and final serialized bytes. This removes the immediate implementation trap without changing gbrain.
2. **Replace the claimed causal split with a shared-freeze ablation.** One ranked hit list, matched renderer, fixed selections for the date comparison, and recorded post-pack source IDs turn the date/coverage/order story into something the experiment can actually decide.
3. **Separate the cap fix from the allocation hypothesis.** Compare cap-only, existing windows/small limits, and depth first, with mixed-corpus contract tests. Fixing a broken advertised bound does not need to await proof that one allocation policy wins QA.
4. **Make promotion requirements internally satisfiable.** Separate C1's intentional byte change from C2 compatibility, upstream recall from delivered coverage, quality from cost, and old-reader reproduction from the required frontier decision. A green result should mean the proposed behavior worked, not that a contradictory gate was weakened.
5. **Treat fact search and held-out access as conditional investments.** Prove the bounded facts adapter and lifecycle economics first; freeze the candidate family and disclose v2 exposure before spending one of the remaining release decisions. This preserves both money and scarce independent evidence.

## Decisions table

Auto-decide applies to this review's recommendations only. The plan and its approved scope remain unchanged. Principles: P1 completeness, P2 fix the blast radius, P3 pragmatism, P4 reuse, P5 explicit over clever, P6 bias to action.

| ID | Classification | Decision and owner | Principle | Disposition |
|---|---|---|---|---|
| D1 | Mechanical | Measurement owner separates baseline overrun reporting from candidate cap assertions, F1. | P1, P5 | Recommend correction before E1. |
| D2 | Mechanical | Adapter owner pins explicit operation arguments and verifies the pre-delivery boundary, F2. | P1, P5 | Recommend correction before E1. |
| D3 | User Challenge | Product owner decides whether depth first remains the preferred default once causal attribution is unproven, F3. | P3, P6 | **Not applied.** Preserve proposed direction pending the parent/user gate. |
| D4 | Mechanical | Decision owner separates header compatibility, ranking invariance, delivered coverage, and token units, F4. | P1, P5 | Recommend correction before preregistration. |
| D5 | Mechanical | Delivery owner includes non-conversation output and mixed-source regressions in the hard-cap proof, F5. | P1, P2 | Recommend in-scope repair. |
| D6 | Taste | Measurement owner adds inexpensive cap-only/window/limited-hit controls rather than jumping directly to fact search, F6. | P3, P4 | Provisional recommendation; no candidate removed. |
| D7 | Mechanical | Facts owner distinguishes the existing session-facts probe from a bounded query-ranked fact adapter, F7. | P1, P4 | Recommend correcting implementation and cost scope. |
| D8 | Mechanical | Custodian/decision owner freezes H1's actual comparison and records exposure, F8. | P1, P5 | Recommend before any custody request. |
| D9 | Mechanical | Experiment owner produces arm-specific and lifecycle cost accounting, F9. | P1, P5 | Recommend before budget approval. |
| D10 | Mechanical | Experiment owner follows frontier-model policy for new decisions while preserving historical reproduction, F10. | P1 | Recommend correction; no automatic spending increase. |
| D11 | Taste | Decision owner uses uncertain/inconclusive triage instead of treating tiny observed gaps as established effects, F11. | P3, P5 | Provisional recommendation; original thresholds not edited. |

No additional user questions were asked. D3 is the sole User Challenge; it is recorded, not implemented. Whether to authorize any revised paid-run scope remains outside this review.

## What already exists

| Sub-problem | Existing implementation | Reuse judgment |
|---|---|---|
| Agent read path | `gbrain:src/core/ops/search.ts:129-160,919-978` | Exercise the real handler; do not call a partial stage sequence identical without checking options and serialization. |
| Scoped evidence assembly | `gbrain:src/core/search/evidence-delivery.ts:814-899` | Preserve batched authorized page fetch, live/cache fallback distinction, and protected-body handling. Change allocation, not the security boundary. |
| Existing allocation options | `return_unit` and `return_window`, `gbrain:src/core/ops/search.ts:113-121,779-788` | Use these as cheap controls before adding a retrieval subsystem. |
| Common packer and exact prompt freeze | `eval/runner/systems/render.ts:66-123`; `eval/runner/memory-qa/run.ts:684-696` | Reuse packed item/source IDs and prompt bytes; carry those fields into durable receipts instead of estimating membership from mean token size. |
| Fact extraction and access rules | `eval/runner/memory-qa/run.ts:496-497,633-639`; `gbrain:src/core/ops/facts.ts:232-244` | Reuse extraction artifacts and scope rules. The existing facts reader is not a query-ranked or budgeted substitute. |
| Spend reservations | `eval/runner/budget-ledger.ts` | Use its shared caps and reservation accounting; a spreadsheet estimate is not a spending boundary. |
| Held-out access policy | v2 protocol, access policy and exposure sections | Reuse the custodian workflow; do not create a new notion of a “free” opening. |

## NOT in scope

**Deferred, not rejected:** a new default budget; BEAM-1M product optimization; an expansion/reranker redesign; a general-purpose fact-index redesign beyond C4's proven need. The first two are explicit plan non-goals, and the latter two are not needed to diagnose the delivery boundary. No TODO file was edited; these dispositions live only in this requested review artifact.

**Rejected for this review:** rewriting frozen shootout rows; rerunning other systems with post-result tuning to manufacture a ranking; opening sealed labels to choose a policy; silently raising a paid cap. These would compromise the experiment or exceed authorization rather than improve delivery.

## Dream state delta

```text
CURRENT                         PLAN, AFTER REPAIRS             12-MONTH IDEAL
Excellent source recall;   -->   A measured cap contract;   -->  One documented evidence contract
adapter loses metadata;         matched delivery controls;     across local/remote readers;
auto can exceed budget.         an opt-in proven winner.       quality/cost frontier per workload.
```

The 10x opportunity is not another ranking formula. It is making every consumer receive dated, scoped, inspectable evidence within a trustworthy bound, with enough provenance to distinguish “not retrieved” from “retrieved but not delivered.” This plan can supply that foundation; it does not yet supply adaptive policy selection or a general claim of best answer quality. Reversibility is **4/5** for an opt-in allocator and **2/5** for spending a held-out opening, which cannot be undone.

Five small improvements worth including inside the measurement blast radius are exact packed IDs, separate upstream/delivered coverage, explicit overrun reasons, a printed resolved-call receipt, and per-arm cold/warm cost estimates. These are report fields and checks, not five new services.

## Section review

### 1. Architecture

The two boundaries that matter are retrieval-to-delivery and delivery-to-reader. F2 and F7 identify two architecture gaps: C0 conflates a product call with a frozen-hit experiment, and C4 conflates extraction reuse with a new search path. Keep both experiments explicit rather than adding a universal abstraction around them.

```text
corpus + scoped import -> ranked hits -> frozen hit artifact
                                          |-> unchanged auto -> raw-overrun receipt
                                          |-> cap-only/window/depth-first candidates
                                          v
                                  common bounded renderer -> frozen prompts -> readers -> judges
extraction artifact -> scoped fact selection --^                           -> paired decision
```

### 2. Errors and rescue

Five capability-level error paths are mapped below. Rescue behavior exists for some current product failures, but the new adapter/allocator contract is not specified well enough to treat failures as validated; the implementation owner must close those gaps before the first paid run.

### 3. Security

One High design gap is identified in F7: query-ranked facts need the same visibility, source, and expiry boundaries as existing fact reads. This is not an observed data leak. C2 must preserve authorized page fetch and redaction ordering; a local synthetic corpus cannot prove remote isolation.

### 4. Data flow and consumer behavior

Four unproven edge cases matter: notes alone exceed B; no minimum evidence block fits; the date is absent; and a cached hit references a page that is no longer readable. Distinguish zero evidence from upstream failure, never invent dates, and test both “read then permission changes” and “permission changes then read” at the existing authorization boundary.

### 5. Code quality and reuse

Two issues are the unnecessary leap past existing delivery knobs, F6, and the misleading reuse claim for the facts lane, F7. Refactor the current allocator and reuse the current renderer; do not build a second independent packing implementation with a different token contract.

### 6. Tests and measurement

Four test-design gaps are F1's baseline cap, F2's exact caller path, F4's incompatible invariants, and F7's facts budget. Keyless fixtures should establish those contracts before paid QA. Paid QA should estimate usefulness, not serve as the first place an adapter's shape is tested.

```text
op parameter tests ------> implicit budget / explicit auto / local / remote
allocator tests ---------> note-only / mixed / too-small / redaction / stale permission
freeze integration ------> same hits + recorded selections + same prompt frame
reader experiment -------> dated chunks / cap-only / windows / depth first / bounded facts
decision tests ----------> product error stays wrong; incomplete run cannot pass; inconclusive stays opt-in
```

### 7. Performance and cost

Two issues need resolution: default-budget arm costs are not the tight-arm costs, and fact extraction's ingest expense needs a query-volume break-even, F9. The existing +20% p95 guardrail is sensible but must specify whether it times the operation, the adapter, or the whole reader path. No new latency measurements were made in this review.

### 8. Observability

Two observability gaps explain the current uncertainty: durable packed membership is missing from the published rows, and the baseline raw overrun is conflated with the harness's final cap. Retain raw/delivered/packed counts, dropped reasons, resolved operation settings, code identities, and prompt hashes. Never log private body text merely to make these receipts easier to debug.

### 9. Deployment and rollback

Two risks are the bundled C1 compatibility change and enabling a global allocator from conversation-only evidence. Keep candidate configuration off by default, retain the old path, and exercise both engine implementations before release. Roll back the flag without deleting extraction artifacts or rewriting historical decisions.

### 10. Long-term trajectory

The plan should leave a stable evidence contract, not a budget-specific 6,900-token special case. Three debt risks are an unexplained conversion constant, a second facts packer, and ambiguous recall semantics. A repaired measurement boundary reduces all three without committing to an adaptive retrieval platform now.

### 11. Design

**SKIPPED (no UI scope).** The user-visible contract is API evidence and evaluation reporting; no screens, components, or frontend interactions are proposed.

## Error & Rescue Registry

These are capability-level obligations, not invented exception names or claims of tested implementation.

| Capability / owner | Failure mechanism | Current safeguard | Required rescue and observable result |
|---|---|---|---|
| Query adapter / harness owner | Wrong implicit unit or differing hit limit invalidates the intended comparison. | Resolved operation logic exists; C0 conformance test is unspecified. | Refuse the experimental cell as harness-invalid; print the exact resolved call and mismatch. |
| Bounded evidence / delivery owner | Spill or non-conversation chunks exceed the requested bound. | Current auto deliberately spills; planned hard-cap handling is incomplete. | Baseline reports overrun; candidate accounts for every block and produces explicit dropped reasons, including empty evidence. |
| Scoped page fetch / delivery owner | Timeout, deleted page, or revoked scope after hits were obtained. | Existing authorized batch fetch and live/cache fallback distinction. | Preserve that behavior; candidate never revives unreadable cached text and still respects the cap. |
| Fact candidate / facts owner | Missing embeddings, extraction failure, stale/expired or unauthorized facts. | Extraction and recall rules exist; new query-ranked route is unspecified. | Report coverage/readiness and product failure as appropriate; retain an authorized transcript fallback without claiming facts were complete. |
| Paid experiment / experiment owner | Provider error, reservation refusal, incomplete family, or missing custody. | Shared budget ledger and existing outcome accounting. | Preserve failures and partial receipts; no pass or default flip; stop spending at the cap and never substitute a different held-out set. |

## Failure Modes Registry

Unknown coverage is a verification obligation, not a test pass. Five rows below have incomplete proposed-contract proof; none is asserted to be an already observed privacy breach.

| Codepath | Failure mode | Rescued? | Test? | User sees? | Logged? |
|---|---|---|---|---|---|
| C0 operation invocation | A supplied budget selects legacy chunk mode. | Not specified for C0. | Exact-call test needed. | Mislabelled experiment unless detected. | Resolved args required. |
| C2 mixed delivery | Non-conversation output alone exceeds B. | Not specified by C2. | Mixed/all-note boundary tests needed. | Oversized response. | Raw and final counts required. |
| C1+C2 decision | Legitimate headers or fewer delivered sessions fail an “exact” guard. | No; contract conflicts. | Test the corrected separate invariants. | False no-go or ad hoc gate changes. | Decision reason required. |
| C4 facts lane | Unbounded top-session facts masquerade as 2,000-token query-ranked facts. | Existing lane is a different experiment. | Bounded adapter test needed. | Invalid cost/quality conclusion. | IDs, sources, tokens required. |
| H1 release choice | Wrong baseline/power story spends an opening without a decisive comparison. | Custodian policy exists; comparison needs repair. | Preregistration audit required. | Inconclusive, not a default approval. | Access log and exposure disclosure required. |

## Execution, state, and rollback diagrams

```text
INPUT -> validate arguments + corpus identity -> freeze hits -> render + count -> persist receipt
 nil/invalid --------> harness-invalid, no reader call
 empty hits ---------> explicit empty evidence, reader outcome stays in the denominator
 oversized ----------> baseline overrun receipt / candidate explicit drops
 fetch failure ------> existing scoped fallback or product error, never invented evidence
```

```text
draft -> keyless contract proven -> preregistered -> approved budget -> dev freeze -> scored
             ^                                                    |                 |
             |---- invalid/incomplete: repair new attempt ---------|                 v
                                                          fail/inconclusive -> stay opt-in
                                                          pass -> freeze H1 -> custodian run
                                                                            -> pass or remain off
Forbidden transitions: incomplete -> pass; dev winner -> default; unavailable custody -> substitute set.
```

```text
deploy additive code with flag off -> verify both engines + scoped reads -> held-out decision
    -> enable only the approved candidate/configuration -> check cap, failure rate, p95
regression -> disable candidate flag -> verify old path -> retain receipts -> diagnose on dev
```

**Temporal interrogation:** Hour 1 settles the call and metric contracts. Hours 2-3 implement and test only C0/freeze plumbing. Hours 4-5 freeze the arm-specific cost sheet and preregistration, without launching unapproved work. Later phases implement a candidate only after the controlled comparison; fact search is a separate conditional step, not spare work squeezed into the adapter change. These are sequencing buckets, not verified engineering-duration estimates.

**Stale diagram audit:** the reviewed plan contains no ASCII implementation diagrams to update. The six diagrams in this review describe the desired trajectory, proposed boundaries, and verification, not an implemented system.

## Completion Summary

| Field | Result |
|---|---|
| Mode selected | SELECTIVE EXPANSION, independent CEO outside voice. |
| System audit | Raw master QA and replay aggregates checked; delivery and operation source inspected; paid/held-out runs not performed. |
| Step 0 | Preserve measurement first; challenge attribution; compare reused delivery options. |
| Section 1, architecture | 2 gaps: controlled boundary and fact-search scope. |
| Section 2, errors | 5 capability paths mapped; new-path proof incomplete. |
| Section 3, security | 1 High design gap; no observed leak alleged. |
| Section 4, data/consumer | 4 edge cases mapped; candidate handling unproven. |
| Section 5, quality | 2 reuse/scope issues. |
| Section 6, tests | Diagram produced; 4 contract-design gaps. |
| Section 7, performance | 2 cost issues; latency boundary needs definition. |
| Section 8, observability | 2 missing evidence boundaries. |
| Section 9, deployment | 2 risks; flag rollback specified as a recommendation. |
| Section 10, future | Allocator reversibility 4/5; held-out opening 2/5; 3 debt risks. |
| Section 11, design | SKIPPED, no UI scope. |
| NOT in scope | Written: 4 deferrals and 4 rejected actions. |
| What already exists | Written: 7 reuse mappings. |
| Dream state delta | Written. |
| Error/rescue registry | 5 capability rows; incomplete proof explicitly assigned to owners. |
| Failure modes | 5 rows; proposed-contract gaps are visible, not reported as silent tested failures. |
| TODO updates | No TODO file edited; deferrals recorded here only. |
| Scope proposals | 5 small evidence/reporting improvements recommended; 0 product edits applied. |
| CEO plan | Original untouched; this requested report is the only review deliverable. |
| Outside voice | OpenAI GPT-6 Astra on Capy completed; no claim about another voice or consensus. |
| Lake Score | N/A: no scored coverage-choice questionnaire was run. |
| Diagrams produced | 6: dream-state delta, architecture, test map, error/data flow, state machine, deployment/rollback. |
| Stale diagrams found | 0 in the reviewed plan. |
| Unresolved decisions | 1 User Challenge, D3; 2 provisional Taste choices, D6/D11; paid-scope approval remains external. |

## GSTACK REVIEW REPORT

| Runs | Status | Findings |
|---|---|---|
| One independent source-and-evidence review | DONE_WITH_CONCERNS; issues_open | 11 findings: 8 High, 3 Medium. No paid calls or sealed reads. |

**VERDICT:** Revise before E1; the diagnosis warrants measurement and a budget-contract fix, not yet a depth-first default or a fact-search investment.

**OUTSIDE COVERAGE:** Completed in Capy by GPT-6 Astra. **CROSS-MODEL:** No consensus claimed; other reviewers were not read. Historical/log artifacts outside this requested file were not written under the task's output-only constraint.

**Recommendation:** Repair the measurement and promotion contracts, run the approved controlled comparison, and keep all default-changing conclusions behind the existing held-out gate because the current evidence does not isolate the proposed winning mechanism.

**UNRESOLVED DECISIONS:**
- D3: User Challenge to the preferred depth-first default, recorded and not applied.
- D6 and D11: provisional Taste choices for the parent to reconcile; the source plan remains unchanged.
- Any expanded paid-model matrix or revised cap still needs the existing budget-approval path; this review grants none.
