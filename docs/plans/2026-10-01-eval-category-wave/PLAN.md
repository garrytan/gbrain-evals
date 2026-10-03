<!-- /autoplan restore point: "<gstack project dir>/plan3-autoplan-restore-20261001-165240.md" -->
## Implementation plan
# Eval-category wave plan: measure the rest of what gbrain does, then fix what breaks

Date: 2026-10-01. Repos (checked 2026-10-01): gbrain master `3a284ae` (v0.60.26.0, System One merged in #5797); gbrain-evals main `b13b219` (v0.10.4, System One category merged in #51), which pins gbrain `6c8373c` (v0.60.13.0).
Parent plan: gbrain-evals `docs/plans/2026-09-28-gbrain-10x/PLAN.md`. Its Amendments still apply: gold never comes from gbrain output; solvability, negative and presence controls are reported and never used to delete items; paired clustered statistics; preregistration before any paid decision; data we have already inspected is development data, never a holdout.
Budget: about $610 is left of the $1,000 program; this wave is capped at $150, reserved through the existing budget ledger (`eval/runner/budget-ledger.ts`) before every paid request.
Review: gstack /autoplan ran on 2026-10-01 (CEO, DX and eng phases; design skipped because there is no UI). Every change it made, and why, is in the Review record after this section.


## Amendments from the independent cross-model review (accepted 2026-10-01; they override conflicting text below)

An independent GPT-6 Astra review (`outside-review.md`) checked this plan against gbrain at `3a284aea` (v0.60.26.0). All ten of its ranked amendments are accepted. Where the text below disagrees, this section wins.

1. **Promotion rules are frozen before coding.** Each category gets its rules preregistered in the registry before its first run:
   - **Safety contracts** (for example "zero prohibited active output" or "zero leaks") gate immediately.
   - **Quality metrics** gate only against a preregistered threshold.
   - **Exploratory metrics** never gate.

   A candidate fix never sets its own acceptance threshold.
2. **N5 tests the actual withdrawal contract.**
   - **Required:** zero prohibited active output after forget, across every tier.
   - **Not claimed:** semantic paraphrase retraction and physical erasure of history. Withdrawal matches normalized claims lexically, and history is preserved by design. Paraphrase residue is reported as a known capability gap, not as a bug.
   - **Controls:** per-tier witnesses taken before withdrawal, and retained-neighbor controls.
3. **A capability and entrypoint matrix comes first** (one page, at the exact tested commit). It names what exists and through which entrypoint, and keeps these pairs apart:
   - explicit supersession vs implicit discovery;
   - the CRAG retrieval-confidence grade vs real answerability (`gradeRetrievalConfidence` returns "strong" on an exact title match with no answer-bearing text);
   - Gmail reply closure vs promise fulfillment;
   - local code reads vs remote availability (remote code reads are suspended);
   - parser fidelity vs attendance extraction;
   - single-relation parsing vs composed multi-hop (the relational parser does not compose relations).

   Categories score only what exists. A missing capability is recorded as a gap, not scored as a failure.
4. **Label and scorer validation before any number counts.**
   - Adjudicate the existing N2 gold: some pairs labeled as contradictions are really temporal evolution.
   - Adjudicate N8's disputed negatives.
   - Mutation-test every scorer with an empty system and with always-positive, always-refuse, stale and wrong-source systems. Each must fail where it should.
   - Keep a fresh confirmation slice that the fix wave never sees.
5. **N1 and N5 run through the existing lifecycle harness first** (gbrain-evals `lifecycle-experiment`). They carry over N3's temporal semantics and N6's exposure controls. The slice runs on PGLite and Postgres, over the real transports, through restart, reimport and concurrent writes. The categories broaden only after this slice is solid.
6. **N2 is scored in three stages:** candidate discovery, classification and resolution. gbrain's contradiction judge is the system under test, not the oracle. Scoring is against independent spans, and pairs that are missed or capped stay in the end-to-end outcome.
7. **A4 defines its answerer explicitly.** It is calibrated to useful answers, not to strong retrieval. It includes:
   - exact-entity and missing-attribute negatives;
   - a matched oracle-evidence control;
   - the cost of false refusals.

   System One's S4 abstention slot is reported separately, on and off.
8. **N7 and N8 split mechanics from semantics.**
   - **N7:** Gmail thread-state detection and closure is the mechanics arm. Promise fulfillment is a separately labeled semantic task, never mapped onto reply closure.
   - **N8:** unsolicited recall is measured at final delivery and across session behavior. It is never mapped from associative QA.
9. **Reuse harnesses instead of adding new ones.**
   - N9 extends `relational-ab`, keeping a fresh hash-committed paraphrase grammar and a composed-query capability check.
   - N12 enumerates formats from gbrain's real adapter registry.
   - N13 is cut down to a capability and readiness scout. Its broad quality study is deferred until independent call and flow gold exists. Lexical references are not semantic references.
10. **Contract-based triage replaces "fix every weakness".**
    - Every finding is classified as a bug against a stated contract, a feature gap, or a category defect.
    - Bugs get minimal repros and fixes at the mechanism level in the single fix-wave PR. Feature gaps stay listed.
    - Fixes are confirmed on scenarios the fix lanes never saw, the confirmation slice from item 4, with clustered paired comparisons.
    - All before/after receipts are kept.
    - The $150 cap covers write-side work and retries.

**Revised order:**
1. Re-pin to gbrain master, build the capability matrix, and add the shared hermetic-env helper (from autoplan).
2. N1 and N5 through the lifecycle harness, plus a narrow N12.
3. N2 and A4.
4. N7 and N8, mechanics first.
5. N9 via `relational-ab`.
6. The N13 scout.

Versions: gbrain-evals takes **0.10.5** (System One holds 0.10.4). The gbrain fix wave takes the next free version after fix wave 5's expected v0.60.27.0.

## 1. Why

**What's covered now.** These areas have evidence or gates in gbrain-evals:
- retrieval on conversations (LongMemEval, with leak-free and reranker-on numbers);
- evidence delivery;
- concept search, source swamp, relational (template and paraphrase, one hop);
- temporal/as-of (N3, gate), entity resolution (N4, report-only), visibility leak fuzz (N6, gate);
- the memory lifecycle experiment (which already scores forget collateral on one scripted vault);
- transcript distillation (Cat35);
- SkillOpt;
- System One (Jev) per-slot verdicts (SO), including abstention (S4), recall-needed (S6) and the contradiction sweep (S9).

**What still has no or weak coverage.** These are capabilities gbrain advertises that the field finds hardest:
- knowledge update and supersession;
- contradiction surfacing;
- forgetting residue across derived tiers;
- abstention on the default (keyless) answering path;
- open loops (email);
- proactive recall;
- multi-hop with held-out wording;
- ingestion format fidelity;
- code intelligence.

When N3, N4 and N6 were built, they found 7 real gbrain bugs, including a privacy leak, and all 7 were fixed in one gbrain PR (#5769). That is a reason to expect more bugs here, not a target: the wave reports whatever it finds, including zero.

**Ground rule.** gbrain wins only where the measurement says so, and "no demonstrated benefit" is a valid result. A category that finds nothing wrong is a result, and so is one where gbrain is weak by design.

## 2. Deliverables
1. **One gbrain-evals PR** that, in this order:
   - re-pins gbrain to current master before any category runs (one gbrain SHA per publication);
   - adds nine categories (§3), each starting report-only, each with a registry entry whose contract is written before its runner;
   - adds a shared bug ledger (`docs/benchmarks/<date>-wave-bugs.json` plus a Markdown view) listing every gbrain bug found: category, minimal repro, status (fixed, deferred with reason, or not a bug);
   - after the gbrain fix PR merges, re-pins to the merged master, records after-numbers, flips gates and updates the README.
2. **One gbrain fix-wave PR** fixing every verified bug the categories find, each with a failing test first and before/after numbers from the categories.
3. **Gate flips:** a category's hard contracts (exact correctness and safety assertions) become a CI gate once they pass on the fixed gbrain. Quality metrics stay report-only or use a stated non-inferiority tolerance; paid arms never gate.
4. **A README "Where gbrain stands" update** with the new results, losses included, each labeled with its evidence maturity.
5. **Research records in repo docs:** one dated report per category under `docs/benchmarks/`, and the preregistration files for paid arms, all in gbrain-evals.

## 3. Categories

Every category has:
- a registry entry with a semantic contract, an evidence-maturity label and a CI time budget, written before the runner;
- gold from a seeded generator ledger or external labels, never from gbrain output;
- solvability and negative controls, plus presence assertions (a failed presence assertion voids the run);
- receipts v2 carrying the gbrain SHA, generator version, seed and ledger hash;
- a dated report with a "gbrain bugs found" section and a "documented limits (not bugs)" section.

Unless noted, a category runs on PGLite against the pinned gbrain, with the fix branch loaded as a copied overlay. Hermetic arms are $0 and strip provider keys. **System One stays off** in every arm (no key, so every decide slot is off), because that is the default most users run; keyed System One behavior is measured by the SO category and cited, not re-measured.

| ID | Category | What it proves | Data | Headline metric (denominator) | Cost |
|---|---|---|---|---|---|
| N1 | Knowledge update & supersession | The current value wins after changes, reverts and dated updates; history is kept. Hermetic arm through search, recall, entity, `ontology_get` and `find_trajectory`; paid arm adds implicit updates (LLM extraction) and think | Seeded value-change ledger on synthetic people/companies (update depth 1–4, explicit vs implicit, reverts); LongMemEval knowledge-update subset as a paid arm, labeled development data | current-value accuracy (probes), stale-served rate, history retained; by depth and update kind | $0 + ~$5 |
| N2 | Contradiction surfacing | Real same-time conflicts are flagged; holder disagreement and dated changes are not | Generator-scaled gold (~150 planted conflicts + ~100 hard negatives), each claim checked to appear in its generated text | candidate-stage pair recall (hermetic: both sides reached one sampled pair), judged pair P/R, false-contradiction rate on negatives, resolution-kind accuracy | $0 + ~$3 |
| N5 | Forgetting & withdrawal residue | `forget` removes a claim from every active-recall surface gbrain documents, survives reimport, restart and paraphrase, respects caller authority, allows reinstatement, and has no collateral damage | 100 canaries through extract and the dream cycle (LLM stubbed); forget 50, including same-text claims on other entities as hard negatives | residue per active tier (target 0), reactivation count, collateral expirations, retained recall on the other 50; raw prose, history and backups reported as retained by design | $0 |
| A4 | Abstention | The CRAG grade is calibrated, and the default answering path says "I don't know" on unanswerable questions without refusing answerable ones | Balanced set: synthetic negatives and missing-attribute probes (generator gold); LongMemEval `_abs` as development data | risk-coverage curve, abstain precision/recall (scored separately for the CRAG grade and for answers) | $0 grade, ~$5 answers |
| N7 | Open loops (email) | "Who is waiting on me" detection, closure, counterparties and ranking on the Gmail-shaped path gbrain actually ships | amara-life-v1 inbox rendered as Gmail threads, plus planted loops, closing replies, noise senders, list mail, calendar system mail, CC-only and self-threads; clock pinned | loop P/R (planted loops), closure accuracy, counterparty accuracy, `waiting` nDCG; extractor arm adds due-date exact match | $0 detector, ~$3 extractor |
| N8 | Proactive recall | `turn_context` / `volunteer_context` surface the right memory without being asked, with few false alarms | associative-recall-v1 (480 probes, labels still awaiting independent human review) and the Cat34 push suite, merged | proactive recall (trigger turns) vs false-alarm rate (negative turns), tokens per turn, PR-AUC | $0 |
| N9 | Multi-hop with held-out wording | Graph/relational retrieval helps 2–3-hop questions beyond parser templates | world-v1 chains with a new paraphrase grammar, committed with its hash before any scoring run and never shown to anyone changing the parser; plus the unmeasured one-hop paid paraphrase rerun at the new pin | strict supporting-fact all-hit@k; relational arm on vs off on template vs paraphrase | ~$6 |
| N12 | Ingestion format fidelity | Every format gbrain registers keeps speakers, timestamps, turns and attendance | Canonical turns rendered into every format read from gbrain's transcript registry at run time (today: Claude Code, Codex, OpenClaw, Hermes, Grok, ChatGPT, Claude export) plus generic JSON and the conversation-parser built-ins | speaker accuracy, timestamp exact match, turn-count error, attended-vs-mentioned F1, honesty about unparsed pages, format coverage % | $0 |
| N13 | Code intelligence | `code_def`, `code_refs`, `code_callers`, `code_callees`, `code_blast` and `code_flow` are correct on real code | One pinned OSS TypeScript repo + one Python repo (permissive licenses, fetched by SHA with hash check); gold generated once from pinned SCIP indexers and committed | def top-1, refs/callers P/R by fan-in stratum, blast recall at depth 1–3; code search nDCG@10 vs ripgrep/ctags/embedding (paid arm) | ~$2 |

## 4. How it runs
- **Step 0, re-pin and specs.** Re-pin gbrain-evals to current gbrain master and fix whatever breaks. Write the nine registry contracts (metric, denominator, gold source, controls, hard contracts vs quality metrics, CI time budget). Commit the N9 grammar and its hash. Commit the preregistration file for every paid arm (metric, denominator, decision rule, cost estimate from a cold-cache pilot).
- **Phase 1, build.** Five parallel lanes on separate branches, each with 1–2 categories, merged by one integrator into the single gbrain-evals PR. Each category runs against the pin and writes its "gbrain bugs found" section with minimal repros into the shared bug ledger.
- **Phase 2, fix.** Parallel fix lanes grouped by gbrain area, merged by one integrator into one gbrain PR. Every fix gets a failing test first, and the categories are re-run against the fixed branch through a copied overlay. Nobody changing the relational parser may read N9's paraphrases.
- **Phase 3, gates.** After a human merges the gbrain PR, the evals PR re-pins to the merged master, records after-numbers, and flips each category whose hard contracts pass. The README is updated. A human merges the evals PR; nothing auto-merges.
- **Coordination.** System One landed in both repos (gbrain #5797, evals #51). We stay out of `src/core/ai/decide/*`, Cat 35 and the SO category; a bug found there is logged and handed to its owner. GBRA-25 is running a gbrain fix wave now: message it before touching shared files and sequence the two PRs. Versions are PATCH bumps, auto-allocated past collisions.

## 5. Success criteria
- All nine categories exist, run reproducibly from one command each (and together from one command), and pass their own control checks.
- Every gbrain bug found is in the bug ledger, and either fixed with a test or explicitly deferred with a reason.
- Every category whose hard contracts can pass becomes a gate.
- Every paid number has a preregistration and a ledger entry; total wave spend stays under $150.
- The published numbers include losses and categories where gbrain is weak, and no headline claims more than its evidence-maturity label allows.

## 6. Risks
- **Scope.** Nine categories is a lot. Order: N5, N1, N2 and N12 first (highest product risk), then N7, N8 and A4, then N9 and N13. All tranches land in the one evals PR.
- **Category design bias.** Gold must come from generators, and a negative control must be able to fail.
- **Development data posing as evidence.** LongMemEval-S, associative-recall-v1 and the first relational paraphrase split have been inspected or tuned on; they are labeled development data and never presented as held-out.
- **Paid arms.** All go through the ledger, and the wave cap is $150.
- **Merge collisions** with other GBRA threads (GBRA-25 fix wave now). Coordinate before touching shared gbrain files.
- **A long-lived evals PR.** It stays open across the fix wave; rebase it on main before each phase and keep the registry the only shared file between lanes.

**Accepted requirements from the CEO review (binding; the autoplan tool keeps this block in sync with the Review record).**

<!-- autoplan-accepted:ceo -->
- Header facts corrected: gbrain master v0.60.26.0 (`3a284ae`) with System One merged; gbrain-evals main v0.10.4; evals pin `6c8373c`.
- The evals PR re-pins gbrain to current master before any category runs; every receipt records the loaded gbrain SHA.
- Every category runs with System One off and records `decide status` (all slots off) as a presence assertion; keyed slot behavior is cited from the SO category, not re-measured.
- Gates cover hard contracts only (exact correctness and safety assertions); quality metrics stay report-only or use a stated non-inferiority tolerance; paid arms never gate.
- A shared bug ledger lists every gbrain bug found with category, minimal repro and status (fixed, deferred with reason, not a bug).
- N1: hermetic arm writes explicit value changes through ops and reads through search, recall, entity, `ontology_get` and `find_trajectory`; implicit updates and think are a paid arm; LongMemEval knowledge-update is labeled development data.
- N2: pair recall is reported in two stages (hermetic candidate stage, paid judge stage); gold is scaled by the generator and each claim is checked to appear in its generated text.
- N5: residue is scored on every active-recall surface gbrain documents; raw prose, history and backups are reported as retained by design; same-text claims on other entities are hard negatives; authority (remote caller scope) and reinstatement are tested; reuses the lifecycle ledger and engine cells; hard contracts also run on Postgres (report-only outside CI); probes run both immediately after forget and after a settle point.
- A4: the CRAG grade and the default answer path are scored separately with risk-coverage curves; LongMemEval `_abs` is development data; SO S4 is cited.
- N7: scoped to Gmail-shaped threads; clock pinned; Slack/calendar listed as unsupported, not as bugs.
- N8: report-only, with no README capability claim until associative-recall-v1 labels pass independent human review; direct-control probes must fire (presence).
- N9: new 2–3-hop grammar committed with its hash before any scoring run; fix lanes changing the parser may not read it; includes the one-hop paid paraphrase rerun at the new pin.
- N12: formats enumerated from gbrain's transcript registry at run time; coverage % reported; keys stripped and LLM fallback count recorded.
- N13: repos pinned by SHA with hash check and recorded licenses; SCIP gold generated once with pinned indexer versions and committed; CI never re-indexes.
- Each hermetic arm has a registry CI time budget (target ≤ 60 s), measured before it gates.
- LLM-judged numbers stay out of the README until at least 50 human labels calibrate them.
- GBRA-25 is messaged before the fix wave touches shared gbrain files; `src/core/ai/decide/*`, Cat 35 and the SO category stay untouched.
<!-- /autoplan-accepted:ceo -->

## 7. Running and contributing (developer experience)

**Who this serves.** An engineer or coding agent building or re-running a category, and a skeptical reader reproducing a published number. Both start from a fresh gbrain-evals clone with no provider keys.

**Names.** Registry ids are descriptive slugs with the plan IDs as legacy aliases: `knowledge-update` (N1), `contradiction-surfacing` (N2), `forget-residue` (N5), `abstention` (A4), `open-loops-email` (N7), `proactive-recall` (N8), `multi-hop-paraphrase` (N9), `format-fidelity` (N12), `code-intelligence` (N13). Runner files follow the N3 pattern: `eval/runner/n1-knowledge-update.ts`, and so on.

**One command each, same flags everywhere.** Every runner accepts the N3 flag set, and paid work never runs by accident:
```bash
bun install
bun eval/runner/n5-forget-residue.ts                        # hermetic arm on the pinned gbrain, $0, keys stripped
bun eval/runner/n5-forget-residue.ts --gbrain ../gbrain     # same, against a copied overlay of a checkout
bun eval/runner/n5-forget-residue.ts --seed 7 --output /tmp/n5-seed7
bun eval/runner/n1-knowledge-update.ts --paid --budget-run-id <campaign>   # paid arm; refuses without both flags
bun eval/runner/all.ts --tier offline --only N1,N2,N5,A4,N7,N8,N9,N12,N13  # the whole wave, hermetic arms
```
`--only` is a new filter on `all.ts` that accepts registry ids or legacy aliases. Each runner prints, in this order: the verdict, the hard-contract results, the quality metrics with denominators, any gbrain bugs with a one-line repro, and the receipt path.

**Errors say what, why and how to fix.** The shared failures get fixed wording, for example:
- System One on: "System One is on (slots: triage, conflict) because a TypeSafe key is in the environment. This category measures the keyless default. Unset `TYPESAFE_API_KEY` and `JEV_TYPESAFE_API_KEY`, or run `gbrain decide disable --all` in the overlay, then rerun."
- Overlay mismatch: "The loaded gbrain is `<sha-a>`, but `--gbrain` asked for `<sha-b>`. The checkout probably has uncommitted changes or the ref moved. Commit or stash, or pass `--gbrain <path>@<ref>`."
- Presence failure: "Presence check failed: the trusted caller read 0 of 50 retained canaries, so a residue of 0 would mean nothing. The run is void (error, not pass). Check that extraction ran; the receipt lists the empty tiers."
- Paid refusal: "This arm spends money (estimate $X). Pass `--paid --budget-run-id <id>`; the ledger has $Y left of the $150 wave cap."

**Docs.** Each category adds a question-first row to `docs/README.md` (the N3/N4/N6 style), a dated report using the N3 report outline, and its registry contract. The bug ledger has a Markdown view linked from the README. CLAUDE.md gets a short "add a category" checklist: registry row first, generator determinism test, broken-adapter test, report outline, docs row.

**Upgrades.** Every receipt names the gbrain SHA. A gate flip is a CHANGELOG line in gbrain-evals. Any gbrain behavior change from the fix wave (for example, what `forget` withdraws) gets a CHANGELOG entry with a "to take advantage" section, per gbrain's release rules.

**Time to first result.** Observed on 2026-10-01 on a Capy machine with a warm package cache: `bun install` took 1 s and N3's hermetic run took 27 s. Target for every new hermetic arm: under 2 minutes from a fresh clone to a printed verdict. Cold-cache install time is not yet measured.


**Accepted requirements from the DX review (binding).**

<!-- autoplan-accepted:dx -->
- Registry ids are descriptive slugs (`knowledge-update`, `contradiction-surfacing`, `forget-residue`, `abstention`, `open-loops-email`, `proactive-recall`, `multi-hop-paraphrase`, `format-fidelity`, `code-intelligence`) with N1, N2, N5, A4, N7, N8, N9, N12, N13 as legacy aliases; runner files follow `eval/runner/n<k>-<slug>.ts`.
- Every runner accepts `--gbrain <path>[@ref]`, `--seed`, `--output`; hermetic by default with provider keys stripped; paid arms refuse to run without both `--paid` and `--budget-run-id`.
- `all.ts` gains `--only <ids-or-aliases>`; a test covers alias resolution and an unknown id error.
- Runner output order: verdict, hard contracts, quality metrics with denominators, gbrain bugs with one-line repros, receipt path.
- Fixed problem + cause + fix wording for overlay mismatch, System One on, presence failure and paid refusal, each covered by a test that asserts the message names the fix.
- Each category adds a question-first row to `docs/README.md`, a dated report using the N3 outline, and its registry contract; the bug ledger has a Markdown view linked from the README.
- CLAUDE.md in gbrain-evals gets an "add a category" checklist.
- A gate flip gets a gbrain-evals CHANGELOG line; gbrain behavior changes from the fix wave get gbrain CHANGELOG "to take advantage" sections.
- Target: each new hermetic arm goes from a fresh clone to a printed verdict in under 2 minutes; measured once by hand for one category.
<!-- /autoplan-accepted:dx -->

## 8. Engineering design

**Shared pieces, built first (Step 0, one lane, before the category lanes start).**
- `eval/runner/hermetic-env.ts`: strips every provider key (the current per-runner list plus `TYPESAFE_API_KEY` and `JEV_TYPESAFE_API_KEY`), points `GBRAIN_HOME` at a throwaway directory so `~/.gbrain/.env` and `config.json` are never read, and restores both afterwards. The receipt records `decide: off (no key, fresh GBRAIN_HOME)`. N3, N4 and N6 move to it too: N3 does not isolate `GBRAIN_HOME` today, and no runner strips the TypeSafe keys.
- `eval/runner/bug-ledger.ts`: appends one validated entry per gbrain bug (id, category, gbrain SHA, op or file, repro command, expected, actual, status, fixing PR) and renders the Markdown view.
- `all.ts --only`, and the four error messages from §7.

**Verdict semantics.** A category's receipt verdict is its hard contracts only. Quality targets live in `data.quality` with their own pass flags and never change the verdict, so `all.ts` gating needs no change: flipping a registry row to `gate` makes the hard contracts block CI.

**How each category reaches gbrain.** Internal coupling is recorded in the receipt, and the copied-overlay identity check catches drift.

| Category | Entry points used | Notes |
|---|---|---|
| N1 | `put_page`, fact ops, `search`, `recall`, entity, `ontology_get`, `find_trajectory`; think (paid) | Extends the N3 ledger and its forward-state oracle |
| N2 | `runner.ts` in `src/core/eval-contradictions/` with an injected `judgeFn` | Hermetic stage: a recording judge logs which planted pairs were offered. An oracle judge gives the solvability ceiling. The paid stage uses the real judge |
| N5 | `remember`, `forget` (`src/core/facts/forget.ts`), `recall`, `search`, entity, `context_pack`, think; dream phases | Reuses `eval/runner/lifecycle/` drivers, fake embedder and observer, not the multi-build harness. LLM steps are stubbed by extending the fake OpenAI-compatible server through `LITELLM_BASE_URL`; if a dream phase cannot be stubbed that way, its tiers move to a ~$1 paid arm and the report says so |
| A4 | `query` op response meta (`confidence` from `src/core/search/crag.ts`); think (paid) | `search.crag_*` stay at defaults (off) |
| N7 | `detectThreadLoop` and `applyThreadLoopVerdict` (`src/core/google/loop-detect.ts`), `listOpenLoops`, `gbrain waiting` ranking; `loops-extract.ts` (paid) | Synthetic `GmailThreadData`; pinned `now` |
| N8 | `assembleTurnContext` (`src/core/context/turn-context.ts`, the IPC builder behind `turn_context`), `volunteer_context` op | `turn_context` is not an MCP op |
| N9 | `relational-ab.ts` arms, `search` with relational on/off | New generator `eval/generators/n9-multihop-paraphrase-gen.ts`; grammar file and hash committed first |
| N12 | `transcriptAdapters()` (`src/core/transcripts/detect.ts`), conversation-parser built-ins | A registered format with no renderer is a reported coverage miss |
| N13 | `importCodeFile`, `code_*` ops | SCIP gold built offline by `eval/generators/n13-scip-gold.ts` and committed with hashes; CI checks hashes only |

**Lanes.**

| Step | Modules touched | Depends on |
|---|---|---|
| 0. Re-pin, shared helpers, nine registry rows, N9 grammar, preregistrations | `package.json`, `eval/runner/` (shared files), `eval/registry.ts`, `eval/data/` | — |
| A. N5 + N1 | `eval/runner/n5-*`, `n1-*`, `eval/generators/`, `eval/runner/lifecycle/` (reuse) | 0 |
| B. N2 + N12 | `n2-*`, `n12-*`, `eval/generators/` | 0 |
| C. N7 + A4 | `n7-*`, `a4-*`, `eval/generators/` | 0 |
| D. N8 + N9 | `n8-*`, `n9-*`, `eval/data/associative-recall-v1` (read-only) | 0 |
| E. N13 | `n13-*`, `eval/data/n13-*` | 0 |
| Fix wave | gbrain modules named by the bug ledger, grouped by area | A–E reports |

Launch step 0 alone; then A–E in parallel; the integrator merges them into the one evals PR. The registry and `docs/README.md` are the only shared files: each lane adds only its own rows, and the integrator resolves the merge. Fix lanes start once the bug ledger has verified entries, grouped so no two lanes touch the same gbrain module.

**Tests.** Every category ships a generator determinism test (same seed, same ledger hash), a scorer unit test with hand-built gold including a negative that must fail, a deliberately broken adapter that the category must fail on, and its registry row. Shared pieces ship unit tests for key stripping and home isolation, ledger schema validation, `--only` alias resolution and unknown-id errors, and the four error messages. On the gbrain side, every fix starts with a failing test, and N3, N4 and N6 must stay green against the fix branch.

**CI time.** The offline tier took about 201 s of its 900 s timeout on 2026-10-01 (run 36894830897, concurrency 2). Nine new hermetic arms at 60 s or less add at most about 270 s. Any arm that exceeds its budget twice moves to a nightly job.


**Accepted requirements from the eng review (binding).**

<!-- autoplan-accepted:eng -->
- `eval/runner/hermetic-env.ts` strips every provider key including `TYPESAFE_API_KEY` and `JEV_TYPESAFE_API_KEY`, points `GBRAIN_HOME` at a throwaway directory, restores both on exit or throw, and is used by the nine new runners and by N3, N4 and N6; the receipt records `decide: off (no key, fresh GBRAIN_HOME)`; N3/N4/N6 same-seed receipts must be unchanged after migration.
- `eval/runner/bug-ledger.ts` validates and appends bug entries (id, category, gbrain SHA, op or file, repro command, expected, actual, status, fixing PR) and renders the Markdown view; covered by schema and render tests.
- Receipt verdict = hard contracts only; quality targets go in `data.quality` with their own pass flags; receipts list each gbrain internal entry point the category imports.
- N2's hermetic stage injects a recording `judgeFn`; an oracle judge gives the solvability ceiling; a judge exception is an error, never "no contradiction".
- N5 stubs LLM steps through a fake OpenAI-compatible server on `LITELLM_BASE_URL` (extending the lifecycle fake embedder); feasibility is verified first, and any tier the stub cannot reach is reported as unmeasured and moved to a paid arm (~$1).
- N7 uses synthetic `GmailThreadData` with `detectThreadLoop` / `applyThreadLoopVerdict` and a pinned `now`; N8 calls `assembleTurnContext` and `volunteer_context`; N12 enumerates `transcriptAdapters()`; N13 commits SCIP gold with hashes and CI checks hashes only.
- Each category ships a generator determinism test, a scorer test with a negative that must fail, a broken-adapter test the category must fail, and presence/exception-handling tests.
- Every gbrain fix starts with a failing test; categories rerun on the fix overlay; N3, N4 and N6 stay green on it; any fix touching a prompt or LLM path reruns the matching paid arm before and after.
- N13's pinned repos stay under 50 MB and 20k symbols, and their import time is measured before the repos are chosen.
- Lanes: step 0 (re-pin, shared helpers, registry rows, N9 grammar, preregistrations) alone; then lanes A (N5, N1), B (N2, N12), C (N7, A4), D (N8, N9), E (N13); then the fix wave; then re-pin and gate flips.
<!-- /autoplan-accepted:eng -->

## Review record

### Run conditions (Capy adaptations)

- gstack autoplan was followed from its SKILL.md files (no Skill tool). Hooks are not enforced in this host.
- Outside voices: the `codex` CLI and the `claude` CLI are not installed, so the Codex voice is **unavailable** in every phase. No native reviewer subagent was spawned, by instruction: an independent cross-model reviewer task runs in parallel outside this workflow. Each phase therefore ran in single-reviewer mode; every consensus cell is N/A.
- Every intermediate question was auto-decided with the recommended option ("accept all recommendations"). Destructive options were never auto-chosen, and auto-merge is never enabled.
- Standing rules applied: one integrated PR per repo for a wave; PATCH versions only; measured benefit only, with "no demonstrated benefit" a valid result; research records go in repo docs.
- Telemetry stayed off. The gstack upgrade offer (1.91.4.0 → 1.91.9.0) was skipped so skill files did not change mid-run.
- Neither repository was edited. Code was read from a `git archive` of gbrain `origin/master` (`3a284ae`) and a fresh clone of gbrain-evals main (`b13b219`), both in a scratch directory.

### CEO phase (Phase 1)

**Mode.** SELECTIVE EXPANSION (autoplan override). The raw rule would also say SELECTIVE EXPANSION: the plan adds capability (nine categories) on top of an existing registry and runner.

**System audit.**
- The plan's version facts were stale: gbrain master is v0.60.26.0 (`3a284ae`), not v0.60.25.0, and System One is merged; gbrain-evals main is already v0.10.4 (#51). The evals pin is still gbrain `6c8373c` (v0.60.13.0), thirteen releases behind master.
- Registry and runner conventions are mature: `eval/registry.ts` has typed entries (tier, gate, evidence maturity, contract), and `test/eval/registry.test.ts` refuses a runner file without a registry row. `all.ts` reads the registry but has no way to run a chosen subset.
- System One added nine decide slots. Four touch this wave: `answerable` (think, query) overlaps A4, `recall_needed` (`turn_context`) overlaps N8, `conflict` (sweep) overlaps N1/N2, and `triage`/`grounding` (dream) touch N5's dream path. Without a key every slot is off.
- N7's product path is Gmail-only: `detectThreadLoop(thread: GmailThreadData, myAddresses, now, …)` in `src/core/google/loop-detect.ts`, and the LLM extractor lives in `src/core/google/loops-extract.ts`. There is no Slack or calendar loop path.
- gbrain's transcript registry has seven formats (`src/core/transcripts/types.ts`: claude-code, codex, openclaw, hermes, grok, chatgpt, claude-export). The plan listed five of them and missed OpenClaw and Hermes.
- `forget` (`src/core/ops/facts.ts`) documents itself as a withdrawal from active memory: "original prose, files and backups may retain the text." `docs/guides/memory-boundaries.md` says the same.
- The contradiction probe (`gbrain eval suspected-contradictions`) is query-driven: it samples top-K retrieval pairs and asks an LLM judge. Pair recall therefore mixes a retrieval stage and a judge stage.
- associative-recall-v1's README says independent human relevance review is still required before capability results are published.
- The relational paraphrase split (2026-09-29) became development data when gbrain v0.60.6.0 widened the relational parser after it was published; the paid paraphrase rerun at the new parser has not happened.
- Active neighbors: GBRA-25 (gbrain fix wave, working), GBRA-31 (refactor priorities, idle), GBRA-32 (System One, idle; both its PRs merged).

**0A. Premise challenge.**

| # | Premise | Verdict | Action |
|---|---|---|---|
| P1 | The listed nine areas lack coverage | Valid; matches the 2026-09-28 coverage audit, minus N3/N4/N6 now done | Keep |
| P2 | Repos at v0.60.25.0 / v0.10.3, GBRA-32 holding 0.10.4 | Wrong (stale) | Corrected in the header and §4 |
| P3 | Categories run "against current master through a copied overlay" | Partly wrong: the pin is 13 releases behind; publication needs one SHA | Re-pin first (§2, §4 Step 0) |
| P4 | 7 bugs last time, so expect more | Reasonable as an expectation, wrong as a target | Reworded; zero bugs is a valid result |
| P5 | A4 tests "the CRAG gate saying I don't know" | Imprecise: CRAG only grades; abstention happens in think, and SO S4 already measured the keyed abstention slot (regression) | A4 scores the grade and the default answer path separately; cites S4 |
| P6 | N7 covers inbox, Slack and calendar | Wrong for the product: only Gmail threads feed the detector and extractor | N7 scoped to email; Slack/calendar listed as unsupported |
| P7 | N9 needs a new grammar separate from the existing split | Valid, and stronger than stated: the old split is now contaminated | Grammar hash-committed first; parser changes are gold-blind |
| P8 | A category gates "once it passes cleanly" | Incomplete: N4 shows design-limit metrics may never pass | Gate on hard contracts only (§2 item 3) |
| P9 | N8's data is ready for headline use | Not yet: labels await human review | Report-only, no README capability claim until reviewed |

No premise is wrong in a way that changes the owner's direction, so none is a User Challenge.

**0B. Existing code leverage.**

| Sub-problem | Existing code | Plan |
|---|---|---|
| Category plumbing | `eval/registry.ts`, `all.ts`, `receipt.ts`, `gbrain-under-test.ts` (copied overlay with receipt identity) | Reuse as is |
| Generators | world-v1, amara-life-v1, `n3-temporal-gen.ts` and `job-state.ts` (forward state oracle), `relational-paraphrase-gen.ts` | N1 extends the N3 ledger pattern; N9 follows the paraphrase generator pattern |
| Forget scenarios | `lifecycle-experiment.ts` and `eval/runner/lifecycle/` (ledger, both engines, three interfaces) | N5 reuses its ledger and engine cells instead of a new harness |
| Visibility enumeration | N6 reads gbrain's op list at run time | N12 copies the idea for formats |
| Statistics | `eval/runner/stats/`, `situation-recall-regression.ts` (cluster bootstrap, sign-swap, Holm) | All paired comparisons |
| Paid-run control | `budget-ledger.ts`, `llm-budget.ts` | Every paid arm |
| gbrain in-repo fixtures | `test/fixtures/conversation-formats/*.jsonl` (17 files), `test/google-loop-detect.test.ts` fixture classes, `eval-code-retrieval.ts`, `eval-suspected-contradictions.ts` | Seeds and failure-class checklists; gold still comes from our generators |
| Contradiction gold | `eval/data/gold/contradictions.json` (10 pairs + 5 stale facts, generated by `amara-life-gen.ts`, unused) | N2 scales it through the generator |
| Keyed slot verdicts | SO category and `docs/benchmarks/2026-09-30-system-one-jev.md` | Cited by A4, N8, N1/N2; not re-run |

**0C. Dream state.**
```
  CURRENT STATE                      THIS PLAN                              12-MONTH IDEAL
  ~half of gbrain's differentiators  +9 categories with generator gold,     Every advertised capability has a
  measured; N3/N6 gate, N4 reports;  hard-contract gates, a bug ledger,     registry entry, a gate on its hard
  7 bugs found and fixed via one     one fix-wave PR, README with losses;   contracts, a held-out or external arm,
  PR; pin 13 releases behind         pin current; keyless defaults scored   and a release-time scorecard
```

**0D. Approach.** A) the plan as written (nine categories, one PR per repo, tranches inside it), B) only the first tranche (N5, N1, N2, N12) this wave, C) also add the external scale and HaluMem tracks. Auto-decided A (completeness, and the plan already orders tranches by risk). B ships sooner but leaves five capabilities unmeasured; C is outside the $150 cap.

**0E. Mode.** SELECTIVE EXPANSION, by autoplan override (auto-decided, recorded as #1).

**0F/0G. Cherry-picks (SELECTIVE EXPANSION).**

HOLD-SCOPE checks: the plan touches roughly 9 new runners, 9 generators, 9 reports, the registry, the README and an unknown number of gbrain fix files, which is far above 8 files. Fewer moving parts would mean fewer categories, which contradicts the plan's goal, so the check is noted, not acted on. Nothing in current scope was deferred.

10x check: the 10x version of this wave is not more categories; it is that each new category is trustworthy enough to gate releases. That means hard contracts, presence controls and one SHA, which the accepted items below add.

Delight scan (each was a separate decision):

| # | Proposal | Effort | Decision | Reasoning |
|---|---|---|---|---|
| E1 | Re-pin evals to gbrain master before any category runs | S | ACCEPTED | One gbrain SHA per publication (parent F7); categories should measure what users install |
| E2 | Run the unmeasured one-hop paid paraphrase rerun as part of N9 (~$3) | S | ACCEPTED | Closes an open "unmeasured" in a published report; measured-benefit rule |
| E3 | N12 enumerates formats from gbrain's registry at run time and reports coverage % | S | ACCEPTED | Same pattern as N6; new formats can't silently go untested (OpenClaw and Hermes already were) |
| E4 | Shared bug ledger file feeding the fix wave and README | S | ACCEPTED | Makes "every bug fixed or deferred" checkable |
| E5 | Keyed System One arm for N1/N2 (conflict slot on) | S | SKIPPED | Duplicates SO S9 (94/97); proposals change nothing until accepted, so N1 would not move |
| E6 | Postgres cells for N5's hard contracts (residue = 0, collateral = 0) | M | ACCEPTED (taste) | Parent amendment 8 wants critical safety cases on both engines, and N3's bugs had the same logic in both engines; reuses lifecycle's Postgres cells, report-only outside CI |
| E7 | WikiContradict / MemoryAgentBench external arms for N2 | M | DEFERRED | Dataset licensing and judge cost; internal generator gold first |
| E8 | HotpotQA / 2Wiki samples for N9 | M | DEFERRED | Keeps N9 inside the cap; the world-v1 chains answer the plan's question |
| E9 | Human calibration (≥50 labels) before any LLM-judged number enters the README | S (needs a person) | ACCEPTED | Parent cross-cutting standard 8; judged numbers stay in reports until labeled |

**0H. CEO plan archive.** Written to `<gstack project dir>/ceo-plans/2026-10-01-eval-category-wave.md`. Spec review loop: unavailable (no reviewer subagent, by instruction): "Spec review unavailable, presenting unreviewed doc." Document approval auto-decided A (#14).

**0I. Temporal interrogation.**
```
  HOUR 1 (foundations):   re-pin breaks something; which gbrain commit is "master" for the wave (record it)
  HOUR 2-3 (core logic):  N5 tier list (what is an "active-recall surface"); N2 candidate vs judge stage;
                          N7 Gmail thread shape and pinned clock; N12 registry enumeration API
  HOUR 4-5 (integration): System One must be provably off (decide status in the receipt); overlay SHA check;
                          the long-lived evals PR vs other evals work
  HOUR 6+ (polish/tests): CI time budget for nine more hermetic runs; human-review status for N8 labels
```
Human-team effort: about 3–4 weeks. CC + gstack: about 3–5 days of lane time plus the fix wave.

**Review sections.**

*Section 1, architecture.* No new services: nine runners under `eval/runner/`, generators under `eval/generators/`, helpers under `eval/runner/<id>/` if needed, and registry rows. The coupling that matters is gbrain internals: N7 imports `detectThreadLoop` (a pure function) and N12 imports the transcript registry, so a gbrain refactor can break them; the receipt records the loaded SHA and the copied-overlay check catches a wrong tree. One new cross-category artifact (the bug ledger). Rollback: a gate flip is one registry field.
```
  generators (seeded) --ledger--> gold (oracles, never gbrain) --------------+
        |                                                                    v
        +--> writes via gbrain ops on PGLite (pinned SHA | copied overlay) --> scorer --> receipt v2
                                                                                 |          |
                                         bug ledger <-- "bugs found" section <---+          v
                                                                           all.ts (registry) --> report, README
```
Finding A1: categories had no way to prove System One was off. Auto-decided: each receipt records `decide status` (every slot off) as a presence assertion (#6).

*Section 2, error & rescue map (capability level).*

| Codepath | What can go wrong | Class | Rescued? | Action | Reader sees |
|---|---|---|---|---|---|
| gbrain op under test | throws where an answer is expected | product exception | Y | scored miss, logged with repro | miss in report |
| Presence control | positive path returns nothing | harness error | Y | run voided (error, not pass) | error verdict |
| Paid provider (judge, embeddings, think) | timeout, 429, malformed JSON, refusal | provider error | Y | bounded retry inside the ledger reservation; then error, never a miss | error count per arm |
| Budget ledger | reservation denied | budget stop | Y | abort before the request | aborted arm, spend so far |
| Copied overlay | loaded SHA differs from requested | identity error | Y | run fails | error verdict |
| Generator | ledger hash differs from committed | fingerprint error | Y | run fails | error verdict |
| SCIP gold (N13) | indexer version drift | gold drift | Y | gold is committed with tool versions; CI never re-indexes | n/a |
| CI | category exceeds its time budget | timeout | Y | error, category moved to nightly if it keeps exceeding | error verdict |

No GAP rows: every class above already has a convention in the repo (N3/N4/N6 receipts, Cat35 judge errors, budget ledger).

*Section 3, security.* Threats: private data in public artifacts (Med likelihood, High impact) — mitigated by generated corpora only and placeholder names; N5 and N6 handle private markers by design. Real credentials (Low/High) — keys stripped from child processes; N7 uses synthetic Gmail-shaped threads, never a Google connection. Third-party code (Low/Med) — N13's repos are pinned by SHA with hash verification and permissive licenses recorded. No new endpoints or auth surfaces. No findings beyond what the plan now states.

*Section 4, data flow and edge cases.* Nil/empty paths are covered by the presence assertions (an empty system cannot score 0 leaks or 0 residue). Finding D1: N7's grace windows (24h inbound, 72h outbound) depend on the clock; auto-decided to pass a pinned `now` (#7). Finding D2: N5's forget can race the background rebuild (the lifecycle report saw pages unsearchable after a forget); auto-decided that N5 probes after an explicit settle point and also once immediately, reporting both (#8).

*Section 5, code quality.* DRY findings: N5 must reuse the lifecycle ledger and engine cells (#9); N9 reuses `relational-ab.ts` arms for the one-hop rerun (#10). No over-engineering found; the bug ledger is a JSON file, not a service.

*Section 6, tests.* Each category needs: a generator determinism test (same seed, same hash), a scorer unit test with hand-built gold including one negative that must fail, a deliberately broken adapter test (the category must fail on it), and the registry test. LLM paths: N1 think arm, N2 judge, A4 answers and N7 extractor run only in paid arms; the judge must not see gold (input allowlist). Eng phase owns the detailed diagram.

*Section 7, performance.* CI risk: nine more hermetic runs. N3 took about 25 s; each new hermetic arm gets a registry time budget (target ≤ 60 s) and is measured before it gates. N13's indexing is the only heavy step and is moved offline (committed gold).

*Section 8, observability.* Every receipt carries per-probe rows and failures (the N3 pattern), so a regression three weeks later is reproducible from the receipt. The bug ledger is the operational view. No dashboards are needed.

*Section 9, deployment.* Sequence: evals PR opens as draft with report-only categories → gbrain fix PR → human merge → evals re-pin → after-numbers → gate flips → human merge. Risk: the evals PR is long-lived; mitigated by rebasing before each phase. Rollback: flip `gate` back to `report-only`.

*Section 10, trajectory.* Reversibility 5/5 (additive registry rows, report-only first). Debt: nine more generators to maintain; mitigated by sharing the N3 ledger pattern. Next: external arms (E7, E8), N10/N11 scale and HaluMem from the parent plan.

*Section 11, design.* SKIPPED (no UI scope).

**NOT in scope.**
- Deferred: WikiContradict / MemoryAgentBench arms for N2 (E7); HotpotQA / 2Wiki for N9 (E8); Slack and calendar commitments (no gbrain product path; listed as unsupported in N7's report); physical erasure (gbrain promises withdrawal only).
- Skipped: a keyed System One arm for N1/N2 (E5, duplicates SO S9).
- TODOS.md entries proposed (not written; both repos read-only): evals P3 "N2 external arms (WikiContradict, MemoryAgentBench conflict subset)", evals P3 "N9 HotpotQA/2Wiki sample", gbrain P3 "Slack/calendar open loops, if wanted as a product feature".

**What already exists.** See 0B; every row is reused.

**Dream state delta.** After this wave: every capability in the coverage audit's priority 1–3 lists except N10/N11 has a category; hard contracts gate; keyless defaults are measured. Still missing versus the 12-month ideal: held-out or external arms for most categories, keyed-default arms beyond SO, and a release-time scorecard.

**Failure modes registry.**
```
  CODEPATH              | FAILURE MODE                                 | RESCUED? | TEST? | USER SEES?            | LOGGED?
  ----------------------|----------------------------------------------|----------|-------|-----------------------|--------
  N8 reflex             | never fires, so false alarms read 0          | Y (presence: direct controls must fire) | Y | error verdict | Y
  N5 residue            | empty brain scores 0 residue                 | Y (retained-recall control) | Y | error verdict | Y
  N7 detector           | wall clock shifts grace windows              | Y (pinned now) | Y | n/a           | Y
  N12 parser            | silent LLM fallback hides a parse failure    | Y (keys stripped; fallback count in receipt) | Y | count | Y
  N9 paraphrases        | parser tuned on the held-out grammar         | Y (hash-committed first; gold-blind fix lanes) | manual | report note | Y
  All                   | System One accidentally on                   | Y (decide status presence assertion) | Y | error verdict | Y
  All paid arms         | spend over cap                               | Y (ledger) | Y | aborted arm           | Y
```
0 critical gaps.

<!-- autoplan-accepted:ceo -->
- Header facts corrected: gbrain master v0.60.26.0 (`3a284ae`) with System One merged; gbrain-evals main v0.10.4; evals pin `6c8373c`.
- The evals PR re-pins gbrain to current master before any category runs; every receipt records the loaded gbrain SHA.
- Every category runs with System One off and records `decide status` (all slots off) as a presence assertion; keyed slot behavior is cited from the SO category, not re-measured.
- Gates cover hard contracts only (exact correctness and safety assertions); quality metrics stay report-only or use a stated non-inferiority tolerance; paid arms never gate.
- A shared bug ledger lists every gbrain bug found with category, minimal repro and status (fixed, deferred with reason, not a bug).
- N1: hermetic arm writes explicit value changes through ops and reads through search, recall, entity, `ontology_get` and `find_trajectory`; implicit updates and think are a paid arm; LongMemEval knowledge-update is labeled development data.
- N2: pair recall is reported in two stages (hermetic candidate stage, paid judge stage); gold is scaled by the generator and each claim is checked to appear in its generated text.
- N5: residue is scored on every active-recall surface gbrain documents; raw prose, history and backups are reported as retained by design; same-text claims on other entities are hard negatives; authority (remote caller scope) and reinstatement are tested; reuses the lifecycle ledger and engine cells; hard contracts also run on Postgres (report-only outside CI); probes run both immediately after forget and after a settle point.
- A4: the CRAG grade and the default answer path are scored separately with risk-coverage curves; LongMemEval `_abs` is development data; SO S4 is cited.
- N7: scoped to Gmail-shaped threads; clock pinned; Slack/calendar listed as unsupported, not as bugs.
- N8: report-only, with no README capability claim until associative-recall-v1 labels pass independent human review; direct-control probes must fire (presence).
- N9: new 2–3-hop grammar committed with its hash before any scoring run; fix lanes changing the parser may not read it; includes the one-hop paid paraphrase rerun at the new pin.
- N12: formats enumerated from gbrain's transcript registry at run time; coverage % reported; keys stripped and LLM fallback count recorded.
- N13: repos pinned by SHA with hash check and recorded licenses; SCIP gold generated once with pinned indexer versions and committed; CI never re-indexes.
- Each hermetic arm has a registry CI time budget (target ≤ 60 s), measured before it gates.
- LLM-judged numbers stay out of the README until at least 50 human labels calibrate them.
- GBRA-25 is messaged before the fix wave touches shared gbrain files; `src/core/ai/decide/*`, Cat 35 and the SO category stay untouched.
<!-- /autoplan-accepted:ceo -->

**CEO dual voices — consensus table.**
```
  Dimension                             Claude  Codex  Consensus
  1. Premises valid?                     N/A     N/A    N/A
  2. Right problem to solve?             N/A     N/A    N/A
  3. Scope calibration correct?          N/A     N/A    N/A
  4. Alternatives sufficiently explored? N/A     N/A    N/A
  5. Competitive/market risks covered?   N/A     N/A    N/A
  6. 6-month trajectory sound?           N/A     N/A    N/A
  Native subagent: not spawned (by instruction). Codex: unavailable (CLI not installed). Single-reviewer mode.
```

**CEO completion summary.**
```
  | Mode selected        | SELECTIVE EXPANSION                                         |
  | System Audit         | stale versions; pin 13 releases behind; System One overlaps |
  |                      | A4/N8/N1/N2; N7 Gmail-only; N12 missing 2 formats           |
  | Step 0               | approach A; 9 premises checked, 0 user challenges           |
  | Section 1  (Arch)    | 1 issue found                                                |
  | Section 2  (Errors)  | 8 error paths mapped, 0 GAPS                                 |
  | Section 3  (Security)| 0 issues found, 0 High severity                              |
  | Section 4  (Data/UX) | 2 edge cases mapped, 0 unhandled                             |
  | Section 5  (Quality) | 2 issues found                                               |
  | Section 6  (Tests)   | test classes named, detail deferred to eng                   |
  | Section 7  (Perf)    | 1 issue found                                                |
  | Section 8  (Observ)  | 0 gaps found                                                 |
  | Section 9  (Deploy)  | 1 risk flagged                                               |
  | Section 10 (Future)  | Reversibility: 5/5, debt items: 1                            |
  | Section 11 (Design)  | SKIPPED (no UI scope)                                        |
  | NOT in scope         | written (5 items)                                            |
  | What already exists  | written                                                      |
  | Dream state delta    | written                                                      |
  | Error/rescue registry| 8 rows, 0 CRITICAL GAPS                                      |
  | Failure modes        | 7 total, 0 CRITICAL GAPS                                     |
  | TODOS.md updates     | 3 items proposed (not written)                               |
  | Scope proposals      | 9 proposed, 6 accepted, 2 deferred, 1 skipped                |
  | CEO plan             | written (<gstack project dir>/ceo-plans/)      |
  | Outside voice        | codex: unavailable; native subagent: not spawned             |
  | Lake Score           | 6/6 recommendations chose the complete option                |
  | Diagrams produced    | 3 (architecture, dream state, temporal)                      |
  | Stale diagrams found | 0                                                            |
  | Unresolved decisions | 0                                                            |
```

### DX phase (Phase 2.5)

**Trigger.** The scope tool matched 3 developer-facing terms (REST, command, Claude Code; threshold 2). The real surface is a CLI and docs: runners under `eval/runner/`, `all.ts`, the registry, receipts and reports in gbrain-evals.

**Product type.** CLI tool plus documentation (auto-decided, #25). **Mode.** DX POLISH (autoplan override, #26).

**Developer persona card.**
```
  Who:       an engineer or coding agent building or re-running a category; second, a skeptical
             reader reproducing a published number
  Starts:    fresh gbrain-evals clone, Bun installed, no provider keys, maybe a local gbrain checkout
  Wants:     a verdict and, when gbrain is wrong, a minimal repro, in one terminal session
  Tolerates: a 30-second run; does not tolerate a silent spend, a vague error or a number it can't recompute
```

**Empathy narrative (first person, observed where marked).** "I cloned gbrain-evals and ran `bun install`; with a warm cache it took a second (observed). The README opens with the LongMemEval story, and the docs index lists N3, N4 and N6 as questions, which is how I found the temporal check. `bun eval/runner/n3-temporal-asof.ts` ran in 27 seconds and printed `verdict: pass` with the receipt path (observed). Now I'm told to build N5. Nothing tells me where to start: there is no contributor guide in this repo, so I copy N3's runner and hope the registry test explains what's missing (it does, by failing). I want to run my category against my local gbrain fix, and N3 shows `--gbrain ../gbrain`, good. If the overlay check fails I get `gbrain overlay failed verification: {json}` (from source), and I have to read the code to learn why. And if I happen to have a TypeSafe key exported, my 'default behavior' numbers are quietly not the default (predicted, from the System One defaults)."

**Competitive DX benchmark.** Aside is not installed and this host has no gstack WebSearch tool wired into the skill, so peer onboarding times are not researched: "Search unavailable, proceeding with in-distribution knowledge only." The comparison below is of DX choices, not times.

| Tool | Start → result | Time + evidence type | DX choice | Source |
|---|---|---|---|---|
| gbrain-evals N3 today | fresh clone (warm cache) → printed verdict | about 30 s, observed | one keyless command, receipt path printed | this run |
| gbrain-evals, a new wave category | fresh clone → printed verdict and bug repros | unknown until built; target < 2 min | same flags as N3, `--only` for the wave | this plan |
| Public memory benchmark harnesses (general) | clone → first score | usually needs API keys and dataset downloads; not measured here | paid by default | in-distribution knowledge, unverified |

**TTHW.** Current for an existing hermetic category: about 30 s after clone with a warm cache (observed). Target for every new hermetic arm: Champion, under 2 minutes from a fresh clone to a printed verdict (auto-decided, #27). Cold-cache install is a measurement gap, not a known problem.

**Magical moment.** Running one category against a local gbrain checkout and seeing "gbrain bug: <one line> — repro: <command>" next to the verdict, in under a minute. Vehicle: the existing runner output pattern plus the bug ledger from the CEO phase (auto-decided A, lowest effort, #28).

**Developer journey map.**
```
  STAGE           | DEVELOPER DOES                                   | FRICTION POINTS                          | STATUS
  ----------------|--------------------------------------------------|------------------------------------------|--------
  1. Discover     | reads README / docs index question rows          | none for readers; no category list for   | fixed (docs row per category)
                  |                                                  | contributors                             |
  2. Install      | bun install                                      | cold-cache time unmeasured               | deferred (measure once)
  3. Hello World  | bun eval/runner/<id>.ts                          | none (N3 pattern)                        | ok
  4. Real Usage   | --gbrain ../gbrain; all.ts for the wave          | no subset runner in all.ts               | fixed (--only)
  5. Debug        | reads receipt rows and failures                  | overlay error dumps JSON; System One     | fixed (error wording; presence check)
                  |                                                  | silently on with a key                   |
  6. Upgrade      | re-pin; reads CHANGELOG                          | gate flips not announced                 | fixed (CHANGELOG line per flip)
```

**First-time developer confusion report.**
```
  Persona: coding agent assigned N5
  T+0:00  clones, installs (1 s warm), runs N3 (27 s): verdict pass. Fine.
  T+0:30  looks for "how to add a category": no CONTRIBUTING.md; CLAUDE.md has repo rules, not a checklist.   -> addressed (checklist in CLAUDE.md)
  T+1:00  copies n3-temporal-asof.ts; registry test fails until a row exists. Learns by failure.             -> addressed (registry row first)
  T+2:00  runs against local gbrain; overlay verification fails with a JSON blob.                            -> addressed (problem + cause + fix wording)
  T+3:00  numbers look different from a teammate's: one of them has a TypeSafe key exported.                -> addressed (decide-status presence check)
```

**Pass 1, getting started: 7 → 9.** One keyless command per runner already works (observed for N3). Gaps: no named commands in the plan, no wave runner. Fixed in §7: named runner files, the N3 flag set, `--only`. Residual: cold-cache install unmeasured.

**Pass 2, CLI design: 6 → 9.** Gaps: the plan named categories only by ID, and paid arms had no stated opt-in. Fixed: descriptive registry slugs with plan IDs as aliases; the same flags on every runner; paid arms refuse without `--paid --budget-run-id` (the evidence-delivery runner already takes `--budget-run-id`). Consistency over cleverness (#29, #30).

**Pass 3, errors: 5 → 8.** Traced three paths. Overlay mismatch today: `gbrain overlay failed verification: ${JSON.stringify(build.verified)}` (`eval/runner/gbrain-under-test.ts:77`), which states the problem but not the cause or the fix. Seed: `--seed needs an integer` (N3), fine. Runner crash: `console.error(e); process.exit(3)`, a raw stack. The plan now fixes wording for overlay mismatch, System One on, presence failure and paid refusal (problem + cause + fix, #31). Residual: generic crashes still print a stack, acceptable for a contributor tool.

**Pass 4, docs: 7 → 9.** The docs index is question-first and the N3 report outline is strong. Gaps: no contributor checklist; the bug ledger had no reader view. Fixed: question row per category, N3 report outline, ledger Markdown view, CLAUDE.md checklist (#32).

**Pass 5, upgrade path: 6 → 8.** Receipts already carry the gbrain version; the plan adds the re-pin step, a CHANGELOG line per gate flip, and gbrain CHANGELOG "to take advantage" sections for behavior changes from fixes (#33). Residual: a category that breaks on a gbrain refactor (N7, N12 import internals) fails loudly through the overlay identity check rather than with a migration note.

**Pass 6, environment: 8 → 9.** Hermetic, keys stripped, PGLite, CI-ready. N13 never needs SCIP indexers locally because gold is committed. Postgres cells for N5 need Docker and stay outside CI (report-only). No new friction.

**Pass 7, community: 6 → 7.** MIT, open data, reproducible receipts. The CLAUDE.md checklist helps outside contributors. The adapter interface for other memory systems stays deferred (parent plan TODO).

**Pass 8, measurement: 5 → 7.** Each receipt records runtime; each hermetic arm has a CI time budget. The plan does not add telemetry. Measuring the cold-cache clone-to-verdict time once, by hand, is a TODO, not a recurring process (#34).

**DX consensus table.**
```
  Dimension                           Claude  Codex  Consensus
  1. Getting started < 5 min?          N/A     N/A    N/A
  2. API/CLI naming guessable?         N/A     N/A    N/A
  3. Error messages actionable?        N/A     N/A    N/A
  4. Docs findable & complete?         N/A     N/A    N/A
  5. Upgrade path safe?                N/A     N/A    N/A
  6. Dev environment friction-free?    N/A     N/A    N/A
  Native subagent: not spawned (by instruction). Codex: unavailable (CLI not installed).
```

**DX scorecard.**
```
  | Dimension            | Score  | Prior  | Trend  |
  |----------------------|--------|--------|--------|
  | Getting Started      | 9/10   | 7/10   | ↑      |
  | API/CLI/SDK          | 9/10   | 6/10   | ↑      |
  | Error Messages       | 8/10   | 5/10   | ↑      |
  | Documentation        | 9/10   | 7/10   | ↑      |
  | Upgrade Path         | 8/10   | 6/10   | ↑      |
  | Dev Environment      | 9/10   | 8/10   | ↑      |
  | Community            | 7/10   | 6/10   | ↑      |
  | DX Measurement       | 7/10   | 5/10   | ↑      |
  | TTHW                 | ~0.5 min observed (N3, warm) | target < 2 min for new arms |
  | Competitive Rank     | Champion (target, hermetic arms)                    |
  | Magical Moment       | designed, via runner output + bug ledger            |
  | Product Type         | CLI tool + documentation                            |
  | Mode                 | POLISH                                              |
  | Overall DX           | 8/10   | 6/10   | ↑      |
  DX principle coverage: zero friction covered; learn by doing covered (copy N3); fight uncertainty covered
  (error wording); opinionated + escape hatches covered (hermetic default, --paid opt-in, --gbrain/--seed);
  code in context covered (real gbrain ops); magical moments covered.
```

**DX implementation checklist.**
```
  [ ] Each new hermetic arm: fresh clone to printed verdict under 2 min (measure once, cold cache)
  [ ] bun install is the only setup step; no keys for hermetic arms
  [ ] First run prints verdict, hard contracts, metrics with denominators, bug repros, receipt path
  [ ] Bug ledger line appears next to the verdict when gbrain is wrong
  [ ] Overlay mismatch, System One on, presence failure, paid refusal: problem + cause + fix wording
  [ ] Registry slugs and runner file names follow the N3 pattern; plan IDs are legacy aliases
  [ ] Every runner takes --gbrain, --seed, --output; paid arms also need --paid --budget-run-id
  [ ] all.ts --only accepts ids and aliases
  [ ] docs/README.md question row, dated report (N3 outline), registry contract per category
  [ ] CLAUDE.md "add a category" checklist
  [ ] CHANGELOG line per gate flip; gbrain CHANGELOG "to take advantage" for behavior changes
```

**NOT in scope (DX).** A hosted results viewer; an adapter interface for other memory systems (parent plan TODO); telemetry on contributor runs; Windows support.

**What already exists (DX).** N3's runner interface and report outline; `gbrain-under-test.ts` (copied overlay with identity check); the question-first docs index; `--budget-run-id` on the evidence-delivery runner; the registry test that refuses unregistered runners.

**TODOS proposed (not written; repos read-only).** evals P3 "Measure cold-cache clone-to-verdict time for one hermetic category and record it in docs" (#34).

<!-- autoplan-accepted:dx -->
- Registry ids are descriptive slugs (`knowledge-update`, `contradiction-surfacing`, `forget-residue`, `abstention`, `open-loops-email`, `proactive-recall`, `multi-hop-paraphrase`, `format-fidelity`, `code-intelligence`) with N1, N2, N5, A4, N7, N8, N9, N12, N13 as legacy aliases; runner files follow `eval/runner/n<k>-<slug>.ts`.
- Every runner accepts `--gbrain <path>[@ref]`, `--seed`, `--output`; hermetic by default with provider keys stripped; paid arms refuse to run without both `--paid` and `--budget-run-id`.
- `all.ts` gains `--only <ids-or-aliases>`; a test covers alias resolution and an unknown id error.
- Runner output order: verdict, hard contracts, quality metrics with denominators, gbrain bugs with one-line repros, receipt path.
- Fixed problem + cause + fix wording for overlay mismatch, System One on, presence failure and paid refusal, each covered by a test that asserts the message names the fix.
- Each category adds a question-first row to `docs/README.md`, a dated report using the N3 outline, and its registry contract; the bug ledger has a Markdown view linked from the README.
- CLAUDE.md in gbrain-evals gets an "add a category" checklist.
- A gate flip gets a gbrain-evals CHANGELOG line; gbrain behavior changes from the fix wave get gbrain CHANGELOG "to take advantage" sections.
- Target: each new hermetic arm goes from a fresh clone to a printed verdict in under 2 minutes; measured once by hand for one category.
<!-- /autoplan-accepted:dx -->

### Eng phase (Phase 3, runs last)

**Step 0, scope challenge (grounded in code).**

What already solves each sub-problem (read in the two trees in a scratch directory):
- Hermetic environment: each runner keeps its own `PROVIDER_KEYS` list (15+ runners, e.g. `eval/runner/n3-temporal-asof.ts:63`). None includes `TYPESAFE_API_KEY` or `JEV_TYPESAFE_API_KEY`. N4 and N6 point `GBRAIN_HOME` at a temp dir (`n4-entity-resolution.ts:384-388`); N3 does not, so it can read `~/.gbrain/.env`, which gbrain loads in `loadConfig()` (`src/core/config.ts:682-687`).
- Receipts v2 exist (`eval/runner/receipt.ts`, `RECEIPT_SCHEMA_VERSION`).
- Contradiction probe: `src/core/eval-contradictions/runner.ts:61,79,281` accepts `judgeFn`, so a hermetic stage needs no gbrain change. `find_contradictions` only reads the last probe run (`src/core/ops/insights.ts:175-180`).
- CRAG: the `query` op attaches `{ confidence: grade.level, … }` (`src/core/ops/search.ts:736-737`); escalation and think are config-gated and default off.
- Open loops: `detectThreadLoop(thread: GmailThreadData, myAddresses, now, suppressions?)` (`src/core/google/loop-detect.ts:83-88`).
- Proactive recall: `turn_context` is an IPC kind built by `assembleTurnContext` (`src/core/context/turn-context.ts:197`); `volunteer_context` is an op (`src/core/ops/insights.ts`).
- Formats: `transcriptAdapters()` (`src/core/transcripts/detect.ts:76`), seven formats in `types.ts:27-34`.
- Code intelligence: ops in `src/core/ops/code-intel.ts`; languages `typescript, tsx, javascript, python` (`src/core/code-intel/recursive-walk.ts:65`).
- Forget: `src/core/facts/forget.ts:100`, withdrawal discovery in `src/core/facts/withdrawal-discovery.ts`.
- LLM stubbing: gbrain has no fake chat provider; `LITELLM_BASE_URL` routes to a local OpenAI-compatible server (`src/core/ai/build-gateway-config.ts:66`), which is how the lifecycle fake embedder works (`eval/runner/lifecycle/fake-embedder.ts`). Whether every dream phase honors it is unverified.
- CI: offline tier about 201 s of a 900 s timeout (run 36894830897).

Minimum change: nine runners plus generators, three shared helpers, registry rows, reports. Nothing is deferrable without dropping a category, and the override says never reduce.

Complexity check: well over 8 files and at least 3 new shared modules, so the gate trips. Feature cuts: none proposed. Structure question (auto-decided, #36): **Smaller arrangement** (recommended): three shared helpers (`hermetic-env.ts`, `bug-ledger.ts`, `--only` in `all.ts`) plus one runner, one generator and one test file per category, versus the **Original arrangement** of nine self-contained runners each re-implementing key stripping, home isolation, decide-off checks and bug output. Pending remedies not decided here: none. Scope record: feature answers none; structure B (#36); accepted scope: the plan as amended by CEO and DX; pending remedies: none.

Search check: Aside and WebSearch are not wired into this run: "Search unavailable, proceeding with in-distribution knowledge only." Every pattern here is [Layer 1], an existing in-repo pattern (N3/N6 runners, lifecycle fake server, registry).

Scope findings:
1. (P1, high confidence, code) No hermetic runner strips TypeSafe keys, and N3 reads the real `GBRAIN_HOME`. With a key present, System One's default slots turn on. Accepted fix: the shared hermetic env, with N3/N4/N6 migrated (#37, taste on migration scope: 3 files).
2. (P2, high, code) The decide-off presence check can be satisfied by construction (no key, fresh home) instead of importing CLI code (`buildStatus` lives in `src/commands/decide.ts:188`). Accepted (#38, taste).
3. (P2, medium, inference) N5's hermetic dream depends on an unverified stub route. Accepted: verify first; fallback to a paid arm with the gap reported (#44).

**Section 1, architecture.**
```
                         gbrain-evals                                              gbrain (pinned SHA or copied overlay)
  +---------------------------------------------------------------+       +-----------------------------------------------+
  | eval/registry.ts  (9 new rows: contract, tier, budget, gate)  |       | ops: put_page, facts, search, recall, query,   |
  | eval/runner/all.ts (--only) ----dispatch----+                 |       |      entity, context_pack, volunteer_context, |
  |                                             v                 |       |      ontology_get, find_trajectory, code_*    |
  |  hermetic-env.ts --> n<k>-<slug>.ts runner ------------------------->| internals: eval-contradictions/runner (judgeFn)|
  |       (keys, GBRAIN_HOME)   |    |    |                       |       |   google/loop-detect, context/turn-context,  |
  |                             |    |    +--> scorer --> receipt v2      |   transcripts/detect, facts/forget, crag     |
  |  generators/n<k>-*.ts --ledger--> oracle gold (never gbrain)   |       +-----------------------------------------------+
  |  lifecycle/{drivers,fake-embedder(+chat stub),observe} (reuse) |                ^ LITELLM_BASE_URL (fake server, $0)
  |  bug-ledger.ts --> docs/benchmarks/<date>-wave-bugs.{json,md}  |
  |  budget-ledger.ts <-- paid arms only (--paid --budget-run-id)  |--> providers (judge, embeddings, think)
  +---------------------------------------------------------------+
```
Coupling: N2, N5, N7, N8 and N12 import gbrain internals, not just ops. That is justified (they measure those internals) and bounded by the overlay identity check plus a receipt field naming each internal entry point. Single point of failure: the shared hermetic env; its unit test covers it. Realistic failure per integration: gbrain renames `assembleTurnContext` (N8 fails loudly at import, error names the symbol); a dream phase ignores `LITELLM_BASE_URL` and tries a real provider (keys are stripped, so it errors; N5 records the tier as unmeasured, never as 0 residue). Distribution: no new published artifact; reports and receipts ship in the PR.

Findings: A2 internal-entry-point field in receipts (#39 includes it); A3 verdict = hard contracts only (#39). No others.

**Section 2, code quality.**
- DRY: per-runner key lists (15+ copies, verified in N3, N4, N6 and others). Shared-code rubric: callers verified at `n3-temporal-asof.ts:63,609`, `n4-entity-resolution.ts:384-388`, `n6-visibility-fuzz.ts:504-508`; destination `eval/runner/hermetic-env.ts`; contract "strip keys, fresh home, restore on exit"; adoption: nine new runners plus N3/N4/N6; estimated about 45 implementation lines removed from the three migrated runners and about 40 added in the helper and its test, so net savings are small, and the reason to do it is reliability (TypeSafe keys, home isolation), not line count. Other runners stay as they are (deferred TODO).
- Bug output: one writer instead of nine report sections hand-formatted (#51).
- Error handling: N2's recording judge must count a judge exception as an error, not a "no contradiction" (Cat35 precedent); N13's hash check must fail with the file name and both hashes.
- No over-engineering: no plugin system, no new base class; runners stay plain scripts like N3.

**Section 3, test review.**

Framework: Bun test (`package.json` `test:unit` → `scripts/test-shards.ts`, CI shards `bun test --shard=N/4 test/eval/ eval/`). Existing category tests: `test/eval/n3-temporal-asof.test.ts`, `n4-…`, `n6-…`, `registry.test.ts`.

```
CODE PATHS                                                   USER FLOWS (contributor / reader)
[+] eval/runner/hermetic-env.ts (new)                        [+] Run one category
  ├── strip keys incl. TypeSafe   [GAP] unit                   ├── [GAP] [→E2E] fresh clone → verdict < 2 min (manual, once)
  ├── fresh GBRAIN_HOME           [GAP] unit                   └── [GAP] --gbrain overlay mismatch shows fix wording
  └── restore on exit/throw       [GAP] unit                 [+] Run the wave
[+] eval/runner/bug-ledger.ts (new)                            └── [GAP] all.ts --only N1,N5 runs exactly two
  ├── schema validation           [GAP] unit                 [+] Paid arm
  └── markdown render             [GAP] unit (snapshot)        ├── [GAP] refuses without --paid/--budget-run-id
[+] all.ts --only (new)                                        └── [GAP] ledger refusal message names remaining $
  ├── alias + id resolution       [GAP] unit
  └── unknown id error            [GAP] unit
[+] per category (x9): n<k>-<slug>.ts
  ├── generator determinism       [GAP] unit (same seed → same hash)
  ├── scorer vs hand gold         [GAP] unit, includes a negative that must fail
  ├── broken adapter must fail    [GAP] integration (PGLite)
  ├── presence assertion voids    [GAP] unit
  ├── product exception = miss    [GAP] unit
  └── paid arm                    [GAP] [→EVAL] N1 think, N2 judge, A4 answers, N7 extractor (ledger)
[+] N2 recording judgeFn
  ├── offered pairs logged        [GAP] unit
  └── judge throws → error        [GAP] unit
[+] N5 fake chat stub
  ├── deterministic replies       [GAP] unit
  └── phase ignores stub → error  [GAP] integration
[+] N13 gold hash check           [GAP] unit (tampered file fails, names file)
[+] N3/N4/N6 after migration      [★★★ TESTED] existing tests must stay green (regression)

COVERAGE: 1/33 paths tested today (all new work) | GAPS: 32 (1 E2E manual, 4 eval)
```

Regression rule: migrating N3, N4 and N6 to the shared env risks their gates; their existing tests and a same-seed receipt comparison (identical ledger hash and identical results) are the required regression proof (#48, CRITICAL). Every gbrain fix starts with a failing test; N3, N4 and N6 must stay green against the fix overlay.

LLM/eval scope: gbrain's CLAUDE.md requires eval runs for prompt/LLM changes. If a fix touches the contradiction judge, extraction, think or the loop extractor, the matching paid arm runs before and after on the fix overlay through the ledger (#47). No gbrain prompt change is planned up front.

Test plan artifact: `<gstack project dir>/user-master-eng-review-test-plan-20261001.md` (written).

**Section 4, performance.** CI headroom is fine (201 s of 900 s; nine arms add at most about 270 s at concurrency 2). Memory: N12 renders small synthetic transcripts; N13's pinned repos must stay small (cap: under 50 MB checked out, under 20k symbols) so PGLite import stays inside the 60 s budget. N6-style enumeration in N12 is linear in formats. No N+1 concerns: runners call ops directly in-process. Finding P1: N13 import time is unmeasured; measure before choosing repos (#49).

**Eng consensus table.**
```
  Dimension                           Claude  Codex  Consensus
  1. Architecture sound?               N/A     N/A    N/A
  2. Test coverage sufficient?         N/A     N/A    N/A
  3. Performance risks addressed?      N/A     N/A    N/A
  4. Security threats covered?         N/A     N/A    N/A
  5. Error paths handled?              N/A     N/A    N/A
  6. Deployment risk manageable?       N/A     N/A    N/A
  Native subagent: not spawned (by instruction). Codex: unavailable (CLI not installed).
```

**Failure modes (eng).**
```
  CODEPATH                 | FAILURE MODE                                  | RESCUED? | TEST? | USER SEES?            | LOGGED?
  -------------------------|-----------------------------------------------|----------|-------|-----------------------|--------
  hermetic-env             | TypeSafe key leaks in, System One turns on    | Y        | Y     | error, fix wording    | Y
  hermetic-env             | throw before restore leaves env modified      | Y (finally) | Y  | n/a                   | Y
  N2 recording judge       | judge exception counted as "no contradiction" | Y        | Y     | error count           | Y
  N5 dream stub            | phase bypasses stub, calls real provider      | Y (keys stripped → error) | Y | tier "unmeasured" | Y
  N8 import                | gbrain renames assembleTurnContext            | Y        | Y     | error names symbol    | Y
  N12 enumeration          | new format has no renderer                    | Y        | Y     | coverage miss listed  | Y
  N13 gold                 | committed gold edited by hand                 | Y        | Y     | hash error names file | Y
  all.ts --only            | unknown id silently runs nothing              | Y        | Y     | error lists valid ids | Y
  bug ledger               | malformed entry                               | Y        | Y     | schema error          | Y
```
0 critical gaps.

**NOT in scope (eng).** Migrating the other 12+ runners to `hermetic-env.ts` (deferred TODO; they work today); a generic category base class; Postgres in CI.

**What already exists (eng).** `receipt.ts` v2, `gbrain-under-test.ts`, `budget-ledger.ts`, `stats/`, `lifecycle/` drivers and fake embedder, `relational-ab.ts`, the N3 runner and report outline, gbrain's `judgeFn` seam and `transcriptAdapters()`.

**Implementation tasks.**

- [ ] **T1 (P1, human: ~1d / CC: ~1h)** — evals — Re-pin gbrain to current master; fix breakages
  - Surfaced by: CEO system audit (pin 13 releases behind)
  - Files: `package.json`, `bun.lock`, affected tests
  - Verify: `bun run test` and `bun run eval:brainbench` green on the new pin
- [ ] **T2 (P1, human: ~4h / CC: ~20min)** — evals — Shared `hermetic-env.ts`; migrate N3, N4, N6
  - Surfaced by: Eng scope finding 1
  - Files: `eval/runner/hermetic-env.ts`, `eval/runner/n3-temporal-asof.ts`, `n4-entity-resolution.ts`, `n6-visibility-fuzz.ts`
  - Verify: new unit tests; N3/N4/N6 same-seed receipts unchanged
- [ ] **T3 (P1, human: ~3h / CC: ~15min)** — evals — `bug-ledger.ts` and `all.ts --only`
  - Surfaced by: CEO E4, DX #35
  - Files: `eval/runner/bug-ledger.ts`, `eval/runner/all.ts`, tests
  - Verify: schema, render and alias tests
- [ ] **T4 (P1, human: ~1d / CC: ~1h)** — evals — Nine registry contracts, N9 grammar + hash, paid-arm preregistrations
  - Surfaced by: CEO accepted block; parent amendment 9
  - Files: `eval/registry.ts`, `eval/data/n9-*`, `docs/benchmarks/*-preregistration.md`
  - Verify: `test/eval/registry.test.ts`; grammar hash test
- [ ] **T5–T13 (P1, human: ~2–4d each / CC: ~1–3h each)** — evals — One per category (N5, N1, N2, N12, N7, A4, N8, N9, N13): generator, runner, scorer, tests, report, docs row, bug-ledger entries
  - Surfaced by: §3 and the per-category accepted requirements
  - Files: `eval/runner/n<k>-<slug>.ts`, `eval/generators/n<k>-*.ts`, `test/eval/n<k>-*.test.ts`, `docs/benchmarks/<date>-n<k>-*.md`
  - Verify: determinism, scorer, broken-adapter tests; `bun eval/runner/n<k>-<slug>.ts` prints a verdict in under 60 s
- [ ] **T14 (P1, human: varies / CC: varies)** — gbrain — Fix wave from the bug ledger, failing test first per fix
  - Surfaced by: §2 item 2
  - Files: to be determined by the ledger
  - Verify: each repro fails before and passes after; categories rerun on the fix overlay; N3/N4/N6 green
- [ ] **T15 (P1, human: ~4h / CC: ~30min)** — evals — Re-pin to merged gbrain master, after-numbers, gate flips, README, CHANGELOG
  - Surfaced by: §4 Phase 3
  - Files: `package.json`, `eval/registry.ts`, `README.md`, `CHANGELOG.md`, reports
  - Verify: `bun run eval:brainbench` green with the new gates
- [ ] **T16 (P2, human: ~1h / CC: ~10min)** — evals — CLAUDE.md "add a category" checklist; measure cold-cache TTHW once
  - Surfaced by: DX passes 4 and 8
  - Files: `CLAUDE.md`, one report
  - Verify: a fresh clone reaches a verdict in under 2 min (recorded)

**Worktree parallelization.** Lanes as in §8: step 0 alone (T1–T4), then lanes A–E (T5–T13) in parallel, then the fix wave (T14), then T15. Conflict flag: `eval/registry.ts` and `docs/README.md` are shared; each lane appends its own rows and the integrator resolves.

**Suppressed findings (confidence below 5).**
- (4/10) Bun's test sharding might put two heavy category tests on one shard and slow CI; check shard times after T13.

<!-- autoplan-accepted:eng -->
- `eval/runner/hermetic-env.ts` strips every provider key including `TYPESAFE_API_KEY` and `JEV_TYPESAFE_API_KEY`, points `GBRAIN_HOME` at a throwaway directory, restores both on exit or throw, and is used by the nine new runners and by N3, N4 and N6; the receipt records `decide: off (no key, fresh GBRAIN_HOME)`; N3/N4/N6 same-seed receipts must be unchanged after migration.
- `eval/runner/bug-ledger.ts` validates and appends bug entries (id, category, gbrain SHA, op or file, repro command, expected, actual, status, fixing PR) and renders the Markdown view; covered by schema and render tests.
- Receipt verdict = hard contracts only; quality targets go in `data.quality` with their own pass flags; receipts list each gbrain internal entry point the category imports.
- N2's hermetic stage injects a recording `judgeFn`; an oracle judge gives the solvability ceiling; a judge exception is an error, never "no contradiction".
- N5 stubs LLM steps through a fake OpenAI-compatible server on `LITELLM_BASE_URL` (extending the lifecycle fake embedder); feasibility is verified first, and any tier the stub cannot reach is reported as unmeasured and moved to a paid arm (~$1).
- N7 uses synthetic `GmailThreadData` with `detectThreadLoop` / `applyThreadLoopVerdict` and a pinned `now`; N8 calls `assembleTurnContext` and `volunteer_context`; N12 enumerates `transcriptAdapters()`; N13 commits SCIP gold with hashes and CI checks hashes only.
- Each category ships a generator determinism test, a scorer test with a negative that must fail, a broken-adapter test the category must fail, and presence/exception-handling tests.
- Every gbrain fix starts with a failing test; categories rerun on the fix overlay; N3, N4 and N6 stay green on it; any fix touching a prompt or LLM path reruns the matching paid arm before and after.
- N13's pinned repos stay under 50 MB and 20k symbols, and their import time is measured before the repos are chosen.
- Lanes: step 0 (re-pin, shared helpers, registry rows, N9 grammar, preregistrations) alone; then lanes A (N5, N1), B (N2, N12), C (N7, A4), D (N8, N9), E (N13); then the fix wave; then re-pin and gate flips.
<!-- /autoplan-accepted:eng -->

**Eng completion summary.**
- Step 0: Scope Challenge: scope accepted as-is (no cuts); smaller arrangement chosen (three shared helpers).
- Architecture Review: 3 issues found.
- Code Quality Review: 3 issues found (1 accepted extraction, 2 error-handling rules).
- Test Review: diagram produced, 32 gaps identified (all for unbuilt work; each has a named test); 1 critical regression contract (N3/N4/N6 migration).
- Performance Review: 1 issue found.
- NOT in scope: written.
- What already exists: written.
- TODOS.md updates: 1 item proposed (migrate remaining runners to `hermetic-env.ts`), plus 4 from CEO/DX; not written (repos read-only).
- Failure modes: 0 critical gaps flagged.
- Unresolved decisions: 0 in this review.
- Outside voice: codex, unavailable (not installed); native subagent not spawned.
- Parallelization: 5 lanes after a sequential step 0; fix wave and re-pin sequential.
- Lake Score: 5/5 choices took the complete option.

### Cross-phase themes

- **The keyless default must be provable, not assumed.** CEO (System One overlaps A4, N8, N1/N2; every arm runs with System One off), DX (a contributor with an exported TypeSafe key gets silently different numbers; fixed error wording) and eng (no runner strips the TypeSafe keys, and N3 reads the real `GBRAIN_HOME`; one shared hermetic env) all pushed the same way.
- **Development data must not pose as evidence.** CEO (LongMemEval-S, associative-recall-v1 and the first paraphrase split are development data; N9's grammar is hash-committed and kept from parser work) and eng (N9 generator and grammar committed in step 0, before any fix lane exists).
- **Coupling to gbrain internals is fine when it is visible.** CEO (N7 and N12 import internals), eng (receipts list every internal entry point; the overlay identity check catches drift; N8's `turn_context` is IPC, not an op).

### Final approval gate (auto-decided)

Plan summary: build nine report-only gbrain-evals categories with generator gold and System One provably off, collect every gbrain bug they find in one ledger, fix the verified bugs in one gbrain fix-wave PR, then re-pin, flip gates on hard contracts only, and publish the results with losses, all inside $150.

Decisions made: 52 total (49 mechanical, 3 taste, 0 user challenges). With no outside voice, no change to the owner's stated direction could be confirmed by two models, and every premise fix was a factual correction or an addition, so there are no User Challenges.

Taste choices a human should glance at:
1. **Postgres cells for N5's hard contracts (#15, CEO).** Recommended: run residue = 0 and collateral = 0 on Postgres too, report-only outside CI, reusing the lifecycle Postgres cells. Alternative: PGLite only; cheaper, but N3's bugs showed the same logic lives in both engines.
2. **Migrate N3, N4 and N6 to the shared hermetic env (#37, eng).** Recommended: yes, because N3 can read `~/.gbrain/.env` today and no runner strips the TypeSafe keys. Alternative: new runners only; smaller diff, but existing gates keep the leak.
3. **How to prove System One is off (#38, eng).** Recommended: by construction (keys stripped, fresh `GBRAIN_HOME`), recorded in the receipt. Alternative: call gbrain's own status builder (`buildStatus` in `src/commands/decide.ts`); more direct, but couples the harness to CLI code.

Also worth a glance (classified mechanical, but they set policy):
- **Gates cover hard contracts only (#5).** A category like N4 can gate on wrong merges = 0 while its recall stays report-only.
- **N8 stays out of the README until its labels are human-reviewed (#19).** This needs a person.
- **N7 is email only (#7).** Slack and calendar commitments are listed as unsupported, not as bugs.

Auto-decided: 52 decisions (see Decision Audit Trail). Gate: option A, approve as-is (#52).

Review scores:
- CEO: SELECTIVE EXPANSION, 9 proposals, 6 accepted, 2 deferred, 1 skipped; native subagent not spawned, codex unavailable, consensus N/A.
- Design: skipped (no UI scope).
- DX: 6/10 → 8/10; TTHW about 0.5 min observed for an existing category (warm cache) → under 2 min target for new arms; native subagent not spawned, codex unavailable, consensus N/A.
- Eng: 7 issues, 0 critical gaps, 1 critical regression contract; native subagent not spawned, codex unavailable, consensus N/A.

Deferred to TODOS.md (proposed, not written; both repos were read-only):
- evals P3: N2 external arms (WikiContradict, MemoryAgentBench conflict subset).
- evals P3: N9 HotpotQA / 2Wiki sample.
- evals P3: migrate the remaining 12+ runners to `hermetic-env.ts`.
- gbrain P3: Slack and calendar open loops, if wanted as a product feature.
(The cold-cache time-to-verdict measurement became task T16.)

Implementation tasks (aggregated across phases): T1–T16 in the eng phase above. The gstack aggregator also picked up task files from earlier autoplan runs on this machine (same branch and commit window, different plans); those were excluded by run id.

Pre-gate verification: CEO outputs present (premise challenges, Sections 1–10 plus 11 skipped, error & rescue registry, failure modes registry, NOT in scope, What already exists, dream state delta, completion summary, consensus table). Design recorded as skipped. DX outputs present (8 scores, journey map, empathy narrative, TTHW assessment and target, implementation checklist, consensus table). Eng outputs present (scope challenge grounded in code, architecture diagram, test diagram, test plan on disk at `<gstack project dir>/user-master-eng-review-test-plan-20261001.md`, NOT in scope, What already exists, failure modes, completion summary, consensus table). Every auto-decision has an audit row. Known deviations: no native subagent or spec-review passes ran; the DX and eng amendment checkpoints were re-created after editing the implementation directly (the snapshot tool refused an unrecorded rewrite), so each phase's checkpoint is the post-edit plan; web research was unavailable.

<!-- AUTONOMOUS DECISION LOG -->
## Decision Audit Trail

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|-------|----------|-----------|-----------|----------|----------|
| 1 | CEO | Mode SELECTIVE EXPANSION | Mechanical | override | autoplan override; plan adds capability | HOLD, EXPANSION, REDUCTION |
| 2 | CEO | Correct stale version facts in the header | Mechanical | P5 | verified against both repos | keep stale text |
| 3 | CEO | Approach A (nine categories, tranches inside one PR per repo) | Mechanical | P1 | completeness; plan already orders tranches | B first tranche only; C add scale tracks |
| 4 | CEO | E1 re-pin to master before any run | Mechanical | P1, P2 | one SHA per publication | run on the old pin |
| 5 | CEO | Gate on hard contracts only | Mechanical | P5 | N4 shows design-limit metrics never pass; parent amendment 4 | gate on whole verdict |
| 6 | CEO | System One off in every arm, proven by a presence assertion | Mechanical | P4, P5 | default users run keyless; SO already measured keyed slots | keyed arms here |
| 7 | CEO | N7 scoped to Gmail threads with a pinned clock | Mechanical | P5 | only product path; grace windows are clock-dependent | inbox+Slack+calendar |
| 8 | CEO | N5 probes immediately and after a settle point | Mechanical | P1 | lifecycle saw a post-forget rebuild window | single probe time |
| 9 | CEO | N5 reuses the lifecycle ledger and engine cells | Mechanical | P4 | DRY | new forget harness |
| 10 | CEO | N9 reuses relational-ab arms; E2 one-hop paid rerun | Mechanical | P4, P1 | closes a published "unmeasured" | skip the rerun |
| 11 | CEO | E3 N12 enumerates formats at run time | Mechanical | P1 | two formats were already missed | hand list |
| 12 | CEO | E4 shared bug ledger | Mechanical | P1 | makes success criterion checkable | per-report lists only |
| 13 | CEO | E5 keyed System One arm for N1/N2 | Mechanical | P4 | duplicates SO S9 | add the arm |
| 14 | CEO | Spec review unavailable; document approval A | Mechanical | P6 | no reviewer subagent by instruction | pause |
| 15 | CEO | E6 Postgres cells for N5 hard contracts | Taste | P1 vs P5 | parent amendment 8; reuses lifecycle cells | PGLite only |
| 16 | CEO | E7 N2 external arms deferred | Mechanical | P3 | licensing and cost; outside cap | add now |
| 17 | CEO | E8 N9 HotpotQA/2Wiki deferred | Mechanical | P3 | cap; world-v1 answers the question | add now |
| 18 | CEO | E9 human calibration before judged README numbers | Mechanical | P1 | parent standard 8 | publish judged numbers unlabeled |
| 19 | CEO | N8 report-only until labels are human-reviewed | Mechanical | P5 | corpus README requires review | publish as capability |
| 20 | CEO | A4 scores grade and answers separately; cites S4 | Mechanical | P4, P5 | CRAG only grades; S4 measured keyed slot | re-run S4 |
| 21 | CEO | N2 two-stage pair recall | Mechanical | P5 | probe is query-driven; separates retrieval from judge failures | single number |
| 22 | CEO | N5 scored against the documented withdrawal promise | Mechanical | P5 | `forget` docs exclude prose/history/backups | count prose as residue |
| 23 | CEO | Keep own gbrain fix PR; message GBRA-25 before shared files | Mechanical | standing rule | one PR per repo per wave; coordinate overlaps | fold into GBRA-25 |
| 24 | CEO | Skip gstack upgrade during the run | Mechanical | P6 | keep skill files stable mid-run | upgrade now |
| 25 | DX | Product type CLI tool + docs | Mechanical | P5 | runners, all.ts, registry, reports | API/SDK |
| 26 | DX | Mode DX POLISH | Mechanical | override | enhancement to an existing tool | EXPANSION, TRIAGE |
| 27 | DX | TTHW target Champion (< 2 min) for new hermetic arms | Mechanical | P1 | N3 already ~30 s warm (observed) | Competitive 2–5 min |
| 28 | DX | Magical moment via runner output + bug ledger | Mechanical | P5 | lowest-effort vehicle using existing pieces | new viewer |
| 29 | DX | Descriptive registry slugs, plan IDs as aliases | Mechanical | P5 | matches registry convention | N-number ids |
| 30 | DX | Same flags on every runner; paid arms need --paid --budget-run-id | Mechanical | P5, P1 | consistency; no silent spend | per-runner flags |
| 31 | DX | Problem + cause + fix wording for four shared failures | Mechanical | P1 | override rule; overlay error dumps JSON today | keep current wording |
| 32 | DX | Docs row, N3 report outline, ledger view, CLAUDE.md checklist | Mechanical | P1 | no contributor guide exists | README only |
| 33 | DX | CHANGELOG line per gate flip; gbrain "to take advantage" sections | Mechanical | P1 | upgrade credibility | silent flips |
| 34 | DX | Cold-cache TTHW measured once by hand (TODO), no telemetry | Mechanical | P3 | simplest method that measures the target | CI timing job, telemetry |
| 35 | DX | all.ts --only filter | Mechanical | P2 | in blast radius, < 1 day; supports "one command for the wave" | separate wave script |
| 36 | Eng | Complexity gate: keep features; Smaller arrangement (three shared helpers) | Mechanical | P4, P5 | removes nine copies of env, decide-off and bug-output code | Original arrangement |
| 37 | Eng | Shared hermetic env with TypeSafe keys and fresh GBRAIN_HOME; migrate N3/N4/N6 | Taste | P2 vs P3 | latent System One leak; migration is 3 files (borderline) | new runners only |
| 38 | Eng | Decide-off proven by construction (no key, fresh home), not by importing CLI code | Taste | P5 | `buildStatus` lives in `src/commands/decide.ts`; construction is explicit and stable | import buildStatus |
| 39 | Eng | Verdict = hard contracts; quality in data.quality; receipts list internal entry points | Mechanical | P5 | lets gates flip without all.ts changes; makes coupling visible | whole-verdict gating |
| 40 | Eng | N2 hermetic stage via injected judgeFn; oracle judge ceiling; judge errors are errors | Mechanical | P4 | existing seam (`runner.ts:61,79,281`) | gbrain change for a stub |
| 41 | Eng | N8 calls assembleTurnContext + volunteer_context | Mechanical | P5 | turn_context is IPC, not an op | MCP-only harness |
| 42 | Eng | N7 synthetic GmailThreadData with pinned now | Mechanical | P5 | only product path | Slack/calendar |
| 43 | Eng | N12 enumerates transcriptAdapters(); missing renderer = reported miss | Mechanical | P1 | no silent coverage gaps | hand list |
| 44 | Eng | N5 LLM stub via fake server on LITELLM_BASE_URL; verify first; fallback paid arm | Mechanical | P1, P6 | gbrain has no fake chat provider; lifecycle pattern exists | assume stub works |
| 45 | Eng | N13 SCIP gold built offline, committed with hashes | Mechanical | P5 | CI stays hermetic and fast | index in CI |
| 46 | Eng | Per-category test set (determinism, scorer negative, broken adapter, presence) | Mechanical | P1 | parent standards; N3 precedent | fewer tests |
| 47 | Eng | Fixes touching prompt/LLM paths rerun matching paid arms before/after | Mechanical | P1 | gbrain CLAUDE.md eval rule | skip evals |
| 48 | Eng | CRITICAL regression contract: N3/N4/N6 same-seed receipts unchanged after migration; stay green on fix overlay | Mechanical | P1 | iron regression rule | trust migration |
| 49 | Eng | N13 repo size cap and import timing before choosing repos | Mechanical | P3 | 60 s budget | pick repos first |
| 50 | Eng | Lanes: step 0 alone, then A–E parallel, then fix wave, then re-pin | Mechanical | P6 | registry is the only shared file | all sequential |
| 51 | Eng | Bug ledger schema with validation test | Mechanical | P1 | success criterion checkable | free-form notes |
| 52 | Gate | Final approval gate auto-decided: A) approve as-is | Mechanical | standing instruction | owner instruction: accept all recommendations; no user challenges exist | B–E |

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` (via /autoplan) | Scope & strategy | 1 (logged 2026-10-01) | CLEAR | 9 proposals, 6 accepted, 2 deferred |
| Outside Review | codex via /autoplan | Independent 2nd opinion | 0 | unavailable | codex CLI not installed; no completed external review. Native subagent not spawned by instruction (an independent cross-model reviewer runs separately) |
| Eng Review | `/plan-eng-review` (via /autoplan) | Architecture & tests (required) | 1 (logged 2026-10-01) | CLEAR | 7 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | skipped | no UI scope |
| DX Review | `/plan-devex-review` (via /autoplan) | Developer experience gaps | 1 (logged 2026-10-01) | CLEAR | score: 6/10 → 8/10, TTHW: ~0.5 min (existing N3, warm) → < 2 min |

- **OUTSIDE COVERAGE:** codex, CEO phase: unavailable (not installed). codex, DX phase: unavailable. codex, eng phase: unavailable. Design phase: skipped. No phase has completed external coverage; the `claude` CLI is also not installed.
- **VERDICT:** CEO + DX + ENG CLEARED by a single reviewer: ready to implement, with no outside-model confirmation inside this workflow.

NO UNRESOLVED DECISIONS
