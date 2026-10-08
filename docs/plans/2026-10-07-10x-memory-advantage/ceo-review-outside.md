OUTSIDE REVIEW (GPT-6 Astra), input sha c50f17026e5d1d6e187304fb4833cb0c670d6146e74d847119ce377f854e120a

Do not approve the seven-wave program as a strategy for a 10x memory advantage. Approve the immediate instrument and reliability repairs, then require one customer-outcome experiment to choose the next product bet. The present plan can complete almost every exit gate without establishing that a user should choose gbrain over a simpler alternative.

I read the entire 374-line input, all five audits, the prior approved plan and its outside review. I checked committed reports and performed free recounts of public development receipts; I made no paid model calls and changed neither repository. This review identifies new strategic gaps and specific regressions against accepted amendments, rather than presenting those amendments as new advice.

Citation key:
- `P` = the supplied `ceo-implementation.md`, at the input hash above.
- `E` = `/workspace/gbrain-evals`; `G` = `/workspace/gbrain`.
- `A` = `E/docs/plans/2026-10-07-10x-memory-advantage/audit`.
- `Prior` = `E/docs/plans/2026-09-28-gbrain-10x/PLAN.md`.
- `S` = `E/docs/benchmarks/2026-10-06-oss-memory-shootout/results`, read from committed branch head `9c07b7e2f90715593b43d9bdc2a7652174636691`, not the checked-out main tree.
- `Pinned` = `G/docs/eval/decisions/c4-pinned-questions/README.md`, read at branch head `eb59ca84faa2ad77040067ec4cf78e6a9956e75d`; its measured product build is `1384a0db`.

## 1. The new “10x contract” quietly replaces the binding one

Severity: High.

Plan text at issue: “Following the 2026-09-28 plan's amendment 2” (`P:118`), followed by four different primary claims (`P:122-125`): 5x fewer confident-wrong answers, reader-token compression, cheaper ingest, and new capabilities.

Evidence: `Prior:19` binds 10x to one preregistered end-to-end task-failure outcome against a frozen previous release, under fixed resources. `P:41` substitutes “one ... per bet.” None of the wave exits requires the original outcome. The evidence-brief gate allows 3 points of accuracy loss in development and about 5 points on sealed v2 (`P:162,167,172`). At the historical 96% v2 baseline, a five-point tolerance reaches 91%: the boundary is 9% errors rather than 4%, or 2.25 times as many errors. A statistical test may require better observed performance, but that is still the loss the chosen estimand tolerates.

This is a regression against an accepted amendment, not a request for another scoreboard. It also makes “same accuracy” in D2 stronger than the actual contract. Choosing the tolerance after measuring pilot discordance lets available power influence how much user harm becomes acceptable.

Amendment: “The inherited program-level primary remains end-to-end memory-dependent task failures versus frozen release X. Bet-level metrics are secondary mechanisms, not interchangeable 10x claims. Before the pilot, freeze the target user, task distribution, maximum acceptable extra failures, and total resource envelope. Insufficient power changes sample size or yields inconclusive; it does not widen the user-loss tolerance.”

Make the first milestone choose that workload. A defensible candidate is cross-session meeting/reply preparation after a correction, where failure means an unsupported or stale answer/action or a missed commitment, not a missing benchmark point. Publish the measured factor even if it is 1.2x.

## 2. The proposed cost moat excludes the competitors most likely to commoditize it

Severity: High.

Plan text at issue: “Ingest $ ... at least 10x below every comparator's common configuration” (`P:124`); “comparators $32 to $109” (`P:64`); gbrain “loses today because of its harness adapter, not its retrieval” (`P:21`).

Evidence: the committed shootout receipts show gbrain ingest $1.5343, the Markdown-KB comparator $1.4511 across its two shards, and plain hybrid $1.2817. The expensive four cost $32.1107, $42.2648, $60.8812 and $108.6870. See `A/B-benchmark-scale-cost.md:163-171` and the corresponding `S/*/receipt.json` ingest fields, independently recounted below. The 21x–71x range describes the expensive subset, not all alternatives.

The adapter diagnosis is narrower than the plan claims. Rehydrating gbrain improves 0.59 to 0.78, but the memory-bank competitor's native arm is 0.89. Rehydrating that competitor lowers it to 0.76. That establishes a packaging issue; it does not establish that fixing gbrain's shipped adapter will beat the competitor's best legitimate presentation. Both have strict recall 0.979. Rehydration removes part of a competitor's actual product.

Amendment: “The 10x ingest-cost hypothesis applies only to the named extraction-heavy configurations. The product-choice comparison must include the cheapest competitive Markdown/file and plain-hybrid systems. Publish native whole-system frontiers as the purchasing comparison; rehydrated arms are component diagnostics. The adapter's causal contribution remains a hypothesis until the amended shipped-path arm runs.”

The six-month threat is not that an extraction-heavy system cuts its bill slightly. It is that a cheap file/index layer plus a better agent becomes sufficient. The plan needs a reason to choose gbrain that survives that outcome.

## 3. The evidence brief has not earned an additional model call

Severity: High.

Plan text at issue: “So the brief must be written by a model from intact evidence” (`P:20`); “never select lexically” (`P:155`); “Deterministic compression ... Every one has lost” (`P:279`).

Evidence: `G/docs/eval/ANSWER_PACKET_RESULTS.md:42-64` narrows its conclusion to a demonstrated omitted numeric detail, while explicitly warning that not all five losses were caused by selection. `E/docs/benchmarks/2026-09-30-evidence-delivery.md:45-59` shows windows improving over chunks but failing a chosen gap-closure target. These experiments reject those selectors and settings; they do not prove that a generative intermediary is necessary.

Audit A's own economics say total processed tokens do not fall and estimate only about 3.8x–4.1x lower dollar cost with a cheap builder (`A/A-evidence-brief.md:283-295`). Yet the grid omits the obvious challenger: let that same cheap model answer directly from intact evidence, escalating only when needed. It also omits cached full evidence and structured aggregation/targeted expansion for the multi-session failures. A builder that already discovers the answer may make the expensive second reader redundant.

Amendment: “Before implementing a new paid product operation, run a bounded architecture pilot: cheap direct reader; cheap answer with frontier fallback; cheap evidence brief plus frontier reader; frontier reader on raw evidence; and a cache-aware raw-evidence control where reuse is realistic. Compare supported task success, all model dollars, and interactive p95 latency. Promote the brief only if it improves the frontier over these simpler alternatives.”

Do not require rebuilding every failed selector. Remove the universal ban and let a narrow, mechanistically different alternative compete. A 2k downstream payload is not a durable advantage if model prices, caching or native harness compaction erase the saving.

## 4. The safety story mistakes quote provenance and cautious wording for correctness

Severity: High.

Plan text at issue: wrapping sessions “so a hijacked session cannot add or delete a claim” (`P:155`), reuse of `groundSource` (`P:159`), and confident-wrong defined as “judged wrong and no hedge” (`P:122`).

Evidence: `G/src/core/cycle/synthesize-verify.ts:569-584,685-715` builds source metadata and matches quote substrings. Those mechanisms cannot establish that a retained quote entails a surrounding claim, that omitted evidence was irrelevant, or that a source itself is trustworthy. More decisively, `G/docs/eval/decisions/p8/SEALED_VERDICTS.md:46-48` says the passed grounding run caught only 2 of 7 judge-labeled unsupported spans and kept 5; that gate measured false flags, not detection of fabricated content.

A source can contain a genuine quotation of a rejected proposal. The brief can cite it accurately while reversing its status or omitting a correction. Full-text fallback does not fire when the incorrect brief passes the mechanical check. Separately, a recognized hedge can move an unchanged wrong answer out of the primary confident-wrong bucket. Neither improvement necessarily reduces harm.

Amendment: “The brief's pointers establish provenance, not semantic truth or injection immunity. Require adversarial tests for omitted corrections, reversed negation, wrong attribution, malicious but literally quoted instructions, and false completeness. Preserve evidence trust tiers through the brief before enabling it by default. Count incorrect committed values/actions regardless of hedge; report hedging and risk–coverage separately.”

This is a new use of the verifier with a stronger safety claim than its measured guarantee, not a repeat of the old dequoting bug. W1 waits for trust tiers; the new Wave 1 synthesis boundary needs an explicit equivalent condition too.

## 5. Production freshness is the near-term product bet, not supporting instrumentation

Severity: High.

Plan text at issue: Wave 0 clears a backlog, while recurrence detection and write-findability land in Wave 2 behind surface-related merges (`P:145,185-192`). Wave 1 meanwhile adds an explicit “not in the brain” brief (`P:153`).

Evidence: `G/src/core/cycle.ts:1633-1654` reports an embed phase as `ok` after checking for a stall but without inspecting blocked/failure counts. `G/src/commands/doctor/checks/schema-health.ts:372-385` reports `ok` at 90% coverage despite a backlog. `E/docs/benchmarks/2026-10-05-managed-sync-catchup.md:16,28,59` reports 152.8 pages/min on synthetic, no-embedding notes, not on real source failures. Audit E documents the separate production stall reports and explicitly says it did not inspect the actual brain (`A/E-scale-production.md:7,89-113`).

The strategy optimizes a few cents of reading while its reference deployment may omit recently written evidence for days. A polished absence statement on an incomplete index is worse than an obviously degraded search. A one-time drain is not an operational advantage users can rely on.

Amendment: “Move independent blocked/failure reporting and backlog-age warnings into the first repair batch. Before any default-on brief, distinguish not found in the searched evidence from not present in the brain, and surface per-source sync/visibility/index completeness. Demonstrate bounded write-to-usable time under normal load, a bad-item incident, and recovery; report operator interventions as well as API cost.”

Keep GBRA-59's root fix with its owner. Decouple the small independent protections from the tool-surface experiment rather than letting a distribution dependency delay reliability.

## 6. “Distribution” is still an internal tool-schema project without an adoption hypothesis

Severity: High.

Plan text at issue: derive an approximately eight-tool core from the maintainer's `mcp_request_log` (`P:182`), then use a 3/3 install test and at most one reply as evidence that the first ten minutes improve (`P:184,192`).

Evidence: P8's held-out loss is real (`G/docs/eval/decisions/p8/SEALED_VERDICTS.md:50-70`), and the empty-array discovery branch exists (`G/src/core/ops/request-tools.ts:298-316`). But `A/D-proactive-distribution.md:240-260,337-351` also establishes that grants and advertised surfaces censor which tools can be called. Frequency in one experienced owner's log is therefore not an unbiased measure of what new users need or of the value of rarely used safety tools.

The new core's gates only prohibit a large loss. They do not require fewer tokens, fewer failed calls, faster first useful recall or higher adoption. It can add another surface mode and pass without improving simplicity. Install automation is also bundled with that speculative surface, although most setup confusion can be fixed without it.

Amendment: “Ship idempotent setup, consistent registration and the empty-discovery fix independently of choosing a new core. Treat owner usage as one input, stratified by grant, harness and task. Freeze one adoption funnel: clean install → import useful data → correct recall in a new session → successful correction/withdrawal → retained use after seven days. Test with non-maintainer users; preserve privacy and opt-in capture.”

Specify a user-visible benefit bar for the new surface as well as non-inferiority. If it saves neither time nor cost, stop adding surface configurations. The unaddressed distribution risk is that users never acquire useful memory or never return, not that they can count 140 schema entries.

## 7. Proactive context can pass by making agents repeat facts rather than do better work

Severity: High.

Plan text at issue: default-on when “uptake ≥ 50% where relevant, false-push ≤ 5%, and no confident-wrong rise” (`P:253`); usage is detected by an item's id or value hash (`P:246`).

Evidence: D6 lists task-success delta (`P:247`), but that metric disappears from the default-on rule. `A/D-proactive-distribution.md:469-471` defines uptake as a value appearing in the answer. An agent can repeat a pushed detail without making a better decision, and a useful detail can influence an action without being copied. Restricting the denominator to relevant pushes also misses important items the trigger never found.

The reach problem is unresolved in the compact plan: `A/D-proactive-distribution.md:110-116,488-500` distinguishes local hook support from the missing thin-client route and flags Codex hook support as unverified. Adding `context_pack` parameters is pull, not proactive delivery. The flagship thin-client deployment is not in D8's named acceptance checks.

Amendment: “Default-on requires a preregistered improvement in end-to-end task success or user time saved, within attention, stale-action and privacy limits. Uptake is diagnostic. Report opportunity recall over all tasks needing a memory, false pushes per session/day, and repeat suppression. Include a new-session push test through Garry's OpenClaw's actual thin-client route; otherwise label that route unsupported.”

Run the narrow test on existing working hooks before coupling it to a four-harness setup expansion. State explicitly which silent tasks and unnamed counterparties remain out of scope; 0/240 associative recall does not become a solved need by redefining relevance around entity matches.

## 8. A vendor-runnable scoreboard is not yet a benchmark vendors must care about

Severity: High.

Plan text at issue: the scoreboard “becomes the benchmark others have to run” through personal worlds, columns, submissions and a powered headline (`P:257-269`).

Evidence: the proposed inferential headline moves to a generator owned by the product team, extending that team's N1/N3/N5/N6 worlds (`P:204,264`). The strong public-scale row becomes descriptive. `A/B-benchmark-scale-cost.md:304-330` chooses a task mixture around gbrain's existing temporal, contradiction and privacy features. Vendor verification checks execution and recountability; it does not make the workload representative or its owner neutral.

There is no external benchmark adopter, independent workload contributor, prospective customer decision or governance commitment in the exit gate. Seed-disjoint personas improve statistical discipline but do not provide another organization's task distribution. The competitive risk is a technically reproducible leaderboard dismissed as the sponsoring product's test suite.

Amendment: “Before expanding the benchmark, recruit two independent agent builders to freeze workload weights and contribute tasks without inspecting gbrain's answers. Obtain one independent operator's completed public-cell replication and one vendor-reviewed adapter. Publish capability applicability, defaults/tuned configurations and native baselines separately. The adoption gate is external use in a memory-system selection, not publication of another table.”

Keep the synthetic world for diagnosis and power; do not let it displace external validity. If no outside participant values the proposed decision, reframe the deliverable as gbrain's regression harness and stop promising an industry standard.

## 9. The scale budget and power plan do not cover the experiment being promised

Severity: High.

Plan text at issue: B6 runs five sizes, ten personas at each size and sixty at 1M for $700–$1,000 (`P:205`); Wave 3 cap $1,100 (`P:211`); the primary is a 3-point slope comparison against the best external system (`P:124`).

Evidence: the source estimate in `A/B-benchmark-scale-cost.md:373-380` prices reader calls for one system, although it lists multiple systems. Its own 10M ingest estimates, excluding the graph system, already sum to $15 + $270 + $540 + $350 = $1,175. That excludes smaller sizes, extra 1M personas, readers, generator calls and the cost-table work. Adding only its one-system reader estimate gives at least $1,525. These remain estimates, but their arithmetic cannot support the quoted cap.

The sixty personas at 1M do not create sixty paired observations at 10M. Only ten reach the larger size. B10's power promise at 1M (`P:264`) therefore does not establish power for the scale-slope claim. “Best external system” also needs a frozen selection rule or simultaneous inference. The controlled core mostly tests added distractors; it does not by itself test ten years of changing beliefs and ingestion incidents.

Amendment: “Before authorizing B3/B6, publish a cell manifest multiplying systems × configurations × sizes × personas × questions × readers × repeats, plus generation, ingest and infrastructure. Estimate from a measured smoke and name the exact Q1 cells displaced. Power the paired 1M-to-10M contrast using the personas present at both sizes. If the cap cannot power it, publish a descriptive curve and make no non-inferiority claim.”

The plan's task rows total about 117 human-days / 443 agent-hours before unpriced coordination and review. The scarce resource is also maintainer attention and seven serial release batches, not merely the $2,750 provider ledger.

## 10. Recorded-time history introduces a new system-of-record commitment, not merely an additive parameter

Severity: High.

Plan text at issue: an append-only `belief_events` “projection,” backfilled from page versions and git, with optional cross-import guarantees decided in D6 (`P:217,221,365`).

Evidence: `A/C-time-travel.md:21-35,199-210` says current fences do not preserve recorded time and projection rebuilds reset it. `G/docs/guides/memory-boundaries.md:92-97` already warns that Markdown is not a full backup. A ledger carrying knowledge-arrival history that cannot be reconstructed from the remaining authoritative input is itself durable audit state; calling it a projection obscures that obligation.

Git commit time proves when a source revision was committed, not when this brain observed it. A historical “what did I believe?” claim is even stronger: the owner's belief, a source's statement and the index's accepted state are different things. Backfill cannot infer those distinctions by timestamp alone. Purge deliberately removes some history, further limiting completeness.

Amendment: “V1 answers what this brain had recorded since an explicit coverage watermark, not what its owner privately believed. Treat the ledger as canonical audit state with a tested backup/migration contract. Mark imported source timestamps separately from observed-at timestamps; backfill never silently certifies historical observation. Historical answers disclose coverage gaps and purge effects.”

Start with page-at-time and a weekly cited change diff for a concrete review workflow. Require evidence that users need cross-holder historical reconstruction before committing to the full multi-operation ledger surface. Otherwise six months of migrations will have purchased a rarely used forensic feature while live freshness remains the daily failure.

## 11. A grading-precision gate cannot justify ranking real people's judgment

Severity: High.

Plan text at issue: W6 gates grading at ≤1% wrong applied resolutions, then W7 ranks holders using shrinkage, Brier skill, decay and synthetic Spearman ≥0.8 at n≥10 (`P:225-234`).

Evidence: `E/docs/benchmarks/2026-10-06-takes-bootstrap-frontier.md:3,34-46,61-65` explicitly calls the sub-0.80 fact/bet precision provisional because labels are incomplete. The plan drops that caveat when diagnosing real-world attribution risk (`P:25,107`). `G/src/core/cycle/grade-takes.ts:23-31,61-75` retrieves outcome evidence from the same brain and asks for self-reported confidence. Neither extraction precision nor correct resolution makes the observed predictions a representative sample of a holder's judgment.

Different holders make predictions in different domains, at different horizons and difficulty levels; people record successes selectively, and unresolved or partial predictions disappear from a binary accuracy score. Beta shrinkage and time decay cannot repair that selection. Thirty human-graded predictions are also insufficient to substantiate a 1% real-case error ceiling: even zero errors gives a one-sided 95% upper bound of about 9.5%, before clustering.

Amendment: “Ship a private forecast journal before a people ranking. Preserve prediction time, exact proposition, horizon, evidence provenance, resolution policy and unresolved denominator. Complete extraction labels and require confirmation of attribution for ranked records. Report domain/cohort-specific uncertainty; do not claim general holder skill from a synthetic n≥10 correlation. Public ranking and ranking-weighted answers remain deferred until an end-to-end, independently adjudicated gate supports them.”

Trust tiers govern authority, not statistical validity. Waiting for GBRA-58 does not solve this reputational product risk, and W6 passing on clean synthetic propositions does not graduate the noisy extraction-to-ranking pipeline.

## 12. Living pages are being justified against a stale baseline their dependency already fixes

Severity: High.

Plan text at issue: living pages' primary is stale-wrong summaries, with 11.6% as the baseline (`P:108,125`), while W9 reuses entity-anchored `retrieveEvidence` (`P:229`).

Evidence: `Pinned:3-12,63-71,98-107` reports that the same anchored retrieval already reduces stale-wrong answers from 11.6% to zero. At equal tokens its accuracy is 96.8%, versus 98.1% for the default-model maintained answer; the maintained answer failed its across-seed superiority rule. The cost advantage depends on repetition: at one read/write, pinned is $0.00966 per correct answer versus $0.00152 for the anchored control; at 100 reads/write it is $0.00057. Plan row 71 pairs that 96.8% control with $0.00284, which belongs to the full-evidence control instead.

The plan acknowledges the tie, then still proposes a gate that can credit living pages with a freshness improvement supplied by anchoring. It does not establish how often a personal entity summary is read per write, or price the human review burden of fifty proposals. A new proposal queue, summary store and refresh cycle may worsen the operational cost that zero-LLM ingest is supposed to avoid.

Amendment: “Compare living pages against current entity-anchored retrieval, with the same triggers and evidence, not the pre-anchoring 11.6% baseline. Primary benefit is total cost or user review time per correct fresh task at observed read/write ratios. Include proposal rejection, review minutes, invalidation lag and a no-refresh control. Do not build a second maintained-answer mechanism until reuse of pinned questions or on-demand anchored summaries loses this comparison.”

If frequently reread summaries are the real user need, scope the feature to that cohort. Otherwise the cheaper product is to retrieve fresh evidence when asked.

## 13. Several “premise corrections” are stronger than the records permit

Severity: Medium.

Plan text at issue: “On matched units the gap is about 2x” (`P:20,101`); BEAM-1M's “no-memory floor about 0.28” (`P:66`); “400-question confirm split” (`P:122,162`); fixing the adapter “before #89's sealed cells” (`P:143,345`).

Evidence: the competing ~7k tokenizer is explicitly unknown (`A/A-evidence-brief.md:162-168,190`), so correcting gbrain's token units does not produce a matched external ratio. The 0.2775 no-memory score comes from 120 BEAM-100K questions, not the 220-question 1M run (`A/B-benchmark-scale-cost.md:175-188`, independently recounted). The 49 infeasible cases concern strict retrieval recall, not directly the answer rubric's 53.5%; that rubric's partial-credit floor raises scores rather than explaining a low score away.

The 100/400 split is an internal development split under `Prior:18`, not restored independent confirmation. Finally, the plan says LoCoMo Phase 7 has already opened the material (`P:19,79`), while B1 and the overlap table call that phase future. The committed shootout preregistration at `9c07b7e`, `docs/benchmarks/2026-10-06-oss-memory-shootout-preregistration.md:372-407`, records completed A5 and its sealed protocol; the new work must not imply it repairs the original pre-opening state.

Amendment: “Use unverified cross-report token ratio; BEAM-100K no-memory floor, with 1M floor not yet measured; and development validation split. Report strict-recall feasibility separately from answer accuracy. Confirm the campaign's actual execution status with its owner and register adapter repair as a new diagnostic or new independently confirmed decision, preserving all original outcomes.”

These are evidence-label corrections, not arguments against repairing the harness. The strategic issue is that the plan sometimes turns uncertainty into an exculpatory explanation before the proposed experiment has run.

## Numbers I checked

These are source checks or free receipt recounts, not new model measurements. For shootout quality I counted non-`scored` product outcomes as zero; some receipt summaries omit that distinction, so using their aggregate fields alone changes the result.

| Plan number or claim | Committed file checked | Match/mismatch |
|---|---|---|
| W10a 468/500 = 93.6% | `E/docs/benchmarks/2026-10-07-longmemeval-w10a-current-pin.md:3,9,31-34` | Match; benchmark notes reader, development data, not production `think`. |
| W10a knowledge-update 71/72 | Same report, `:47-55` | Match. |
| W10a mean input 22,167 | `E/docs/benchmarks/2026-10-07-longmemeval-w10a-current-pin/arms/w10a-sonnet55-notes/rows.ndjson`, all 500 `usage` rows | Match: independent mean 22,167.076. |
| Whole history 144 vs gbrain 139 of 150 | `E/docs/benchmarks/2026-10-07-longmemeval-w10c-full-context.md:35-40` | Match; not equal accuracy, and not the 500-question population. |
| 171,596 vs 22,242 Claude tokens; 13,794 GPT tokens | Same report, `:35-40` | Match; the provider units differ. |
| Multi-session 34 vs 29 of 36 | Same report, `:53-61` | Match. |
| Sealed v2 192 vs 132 of 200 | `E/docs/benchmarks/2026-10-02-sealed-v2-decision-1.md:23-30` | Match. |
| Sealed v2 input 12,982 vs 3,280 | Same report, `:58-61` | Match; measured reader was Sonnet 4.6 (`:7`). |
| Sealed v2 abstention 40/40 | Same report, `:28,63` | Match in both historical arms, not evidence for a new brief. |
| Windows recover about 30%–36% of page gain | `E/docs/benchmarks/2026-09-30-evidence-delivery.md:45-59` | Match: 29.6% and 36.1%. |
| Excerpt packet 48 vs 53 of 60 | `G/docs/eval/ANSWER_PACKET_RESULTS.md:3-6,42-47` | Match; attributing all five losses to selection would mismatch the report. |
| P8 $9.94 on vs $0.32 off per 1,000 pages | `E/docs/benchmarks/2026-10-05-heldout-verdicts/p8-write-cost-2026-10-05.json:70,89,129,144` | Match after rounding: $9.942 and $0.3152. |
| P8 commit-path generative calls zero | Same JSON, `:44,113` | Match; does not mean background calls are zero. |
| P8 surface losses −8.5/−9.9 points; hidden −50/−21.2 | `G/docs/eval/decisions/p8/SEALED_VERDICTS.md:56-66` | Match. |
| P4 pressure +11.35 [+8.3,+14.4] | `E/docs/benchmarks/2026-10-05-heldout-program/p4.md:33,38` | Match; 460 paired questions in 23 conversations, not all 480 planned questions. |
| P4 core GPT/Fable −2.4 points | Same report, `:34-35` | Match; Fable is historical evidence, not a new counted arm. |
| N8 associative 0/240 | `E/docs/benchmarks/2026-10-01-n8-proactive-recall.md:14,64-73` | Match; labels pending independent human review. |
| Takes 123 cases, zero forbidden attribution; fact/bet precision <0.80 | `E/docs/benchmarks/2026-10-06-takes-bootstrap-frontier.md:26-46` | Numbers match; omission of provisional/incomplete-label qualification mismatches the report. |
| BEAM-1M answer score 53.5% | `E/docs/benchmarks/2026-10-06-beam-1m-dates.md:11-18`; its `qa/baseline/shard-*/rows.ndjson.gz` | Match: recounted 0.5348214 over 220 rows. |
| BEAM 49/194 need >5 gold groups; feasible 36/145 = 24.8% | Same committed QA rows, all shards | Match; 198 answerable, 194 with positive gold, 145 feasible. |
| BEAM-1M no-memory floor about 0.28 | `S/no-memory-control-beam-100k/no-memory-control-beam-100k-a1-ea8997df/arms/vendor-default.native.bnone.main/rows.ndjson.gz` | Mismatch of population: 0.2775 is the 100K floor, 120 rows. |
| gbrain native 0.59, rehydrated 0.78; memory-bank native 0.89 | `S/gbrain-shootout-master-common-lme-s/gbrain-shootout-master-common-lme-s-a1-9a428a1a/arms/*/rows.ndjson.gz`; `S/hindsight-common-lme-s/hindsight-common-lme-s-a3-7c90ca22/shard-*/arms/*/rows.ndjson.gz` | Match from 100 rows per arm, with product failures zeroed. |
| gbrain strict recall 0.979 “best” | Same native rows | Match, but tied with the memory-bank competitor, not uniquely first. |
| Extract-first default about 1,262 reader tokens | `S/mem0-common-lme-s/mem0-common-lme-s-a1-c05f5e45/shard-*/arms/vendor-default.native.bnone.main/rows.ndjson.gz` | Match: independent mean 1,262.16. |
| gbrain ingest $1.53 vs expensive comparators $32–$109 | `S/gbrain-shootout-master-common-lme-s/.../receipt.json:85`; competitor root/shard `receipt.json` ingest fields (`:64`) | Match for that subset: $1.5343 vs $32.1107–$108.6870. |
| At least 10x cheaper than every comparator | `S/basic-memory-common-lme-s-shard{0,1}of2/.../receipt.json:64`; `S/plain-hybrid-control-lme-s/plain-hybrid-control-lme-s-a1-6928a781/receipt.json:64` | Unsupported generalization: these cost $1.4511 and $1.2817, below gbrain. |
| Pinned 98.1% vs anchored 96.8%; costs $0.00057 vs $0.00284 | `Pinned:5-12,63-71,98-107` | Accuracy matches; cost pairing mismatches. Equal-token anchored cost is $0.00152; $0.00284 is full evidence. |
| Managed throughput 152.8 pages/min | `E/docs/benchmarks/2026-10-05-managed-sync-catchup.md:16,28,59` | Match: steady synthetic/no-embedding throughput; whole-run rate 137.4. |
| Total paid caps about $2,750 | `P:307-313` | Match: seven caps sum to $2,750, before vendor reruns. |
| B6 scale experiment fits $700–$1,000 | `A/B-benchmark-scale-cost.md:373-380`, checked against `P:205-211` | Mismatch in estimate arithmetic: listed 10M ingest alone totals $1,175 excluding the graph system. |

## Severity and decision

There are no Critical findings because this is an unapproved plan, not an observed catastrophic production change; I have not established an exploit or irreversible loss introduced by implementing it. The High findings block the strategy and default-on claims. There are no Low findings because editorial cleanup would not change the investment decision.

Approve Wave 0's bounded repairs and a smaller decision pilot, not automatic progression through all seven waves. Keep the five bets as hypotheses; select their order from one cross-session user outcome, with strong cheap baselines, production freshness and independent task evidence. Defer people rankings, the full history surface and large synthetic benchmark expansion until that pilot identifies a reason users should switch.

Recommendation: revise before approval because the current exits can deliver seven release waves and many measurements while missing the binding end-to-end 10x outcome, underestimating the scale experiment, and failing to beat the simplest credible alternatives.
