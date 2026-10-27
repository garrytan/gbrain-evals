# Memory proof wave 2 preregistration: addenda

The [preregistration](2026-10-10-memory-proof-wave-2-preregistration.md) was pushed at commit `442bb366` and verified by its SHA-256, `baf0ec0ee49f51062a17e5978d7206ead04d8bc55ca5805b4b7d8a13a922932a`. Later decisions are recorded here, dated, instead of editing that file. Each one is written before the cells it governs run.

## Every dev and confirmation cell sets its knobs explicitly (October 11, 2026)

**Decision (Garry, October 11).** From stage 2 on, every gbrain cell sets every read-time and ingest knob explicitly. No cell relies on the pinned build's defaults.

**Why.** Master's defaults changed when gbrain#6066 shipped with the query facts arm on. Before that merge, master had no facts arm and no temporal fact reserve; #6066 added both keys, with the facts arm on by default. Step 0's specs take those knobs from the build: the facts arm on, the reserve off, date grounding on, the voyage-4 supersession threshold 0.95. `search.mode` comes from the unit's keys. Those values match the wave-1 build `d7467d1cf` and the dev pin. A cell that names them keeps its meaning if a later build changes a default.

**Read-time knobs.** These go in `provider_config.search_config` and are set in each unit's brain before its server starts. They are not ingest inputs, so lanes that differ only here share a store.

| Key | Value | Notes |
|---|---|---|
| `search.mode` | `tokenmax` on every facts-store lane; `conservative` on `raw@pin` | wave 1's modes, which came from the unit's keys |
| `search.reranker.enabled` | `true` with `tokenmax`, `false` with `conservative` | the mode bundles' values |
| `search.reranker.model` | `voyage:rerank-2.5` | the bundle default |
| `search.reranker.gate` | `off` | `on` only on `combined-v2+gate`, `shadow` only on the A15 replay |
| `search.reranker.gate_min_gap` | `0.05` | the build default; inert with the gate off; A15 picks δ from {0, 0.05} |
| `search.query_facts_arm` | `true` | on in wave 1 and at the pin |
| `search.temporal_fact_reserve` | `false` | failed validation in wave 1 ([addendum](2026-10-05-memory-proof-wave-preregistration-addenda.md#temporal-fact-reserve-validation-verdict-october-7-2026)) |
| `search.evidence_date_header` | `false` | the harness writes its own date header on each page |
| `search.entity_anchoring` | `false` | off in wave 1 |
| `recall.question_admission` | `reserve`, except the `facts_arm` tuning lane | W1's admission rule (below) |

**Ingest knobs.** These go in `provider_config.gbrain_config` and are set on the store template before ingest. They are ingest keys, so they are part of each store's identity.

| Key | Value |
|---|---|
| `extraction.date_grounding` | `true` |
| `facts.attribution` | `true` |
| `facts.supersession_thresholds` | `{"voyage:voyage-4@1024": 0.95}` |

The raw store sets the same keys. With no extraction, they have no effect there.

**Per call.** The harness already sends `expand: false` on every page query. Every lane's `query` call passes `token_budget` without `return_unit: "auto"`, so `search.auto_packing` never applies and is not set.

**Enforcement.** [`tests/test_mpw2_dev_specs.py`](../../eval/harness-provider/tests/test_mpw2_dev_specs.py) fails if any spec under `cells/mpw2/dev/` or `cells/mpw2/confirm/` lacks a key above, uses another mode or reranker setting for its lane, or fails the provider's config validation. The specs are written by [`mpw2-dev-specs.py`](../../eval/harness-provider/mpw2-dev-specs.py).

Step 0 keeps its specs as they ran, and stays exploratory.

## Dev pin: #6445 merged with master v0.60.169.0 (October 11, 2026)

**Decision (Garry, October 11).** Every dev cell runs on gbrain `8d4f6ab6e589df8b59bedd791cffb8092540b646`. This replaces the preregistration's "head of the W1 PR (PR-A)" and the earlier pin, `f44a0947808334d4187fd0842af265c6c31d9fb5`.

**Why.** W1 merged to master as v0.60.169.0 (merge `77cf8e111`, migration v237, with concurrent index builds), so dev measures the build that ships. `8d4f6ab6e` is gbrain#6445 (W3) with that master merged in. It holds:

- the shipped W1;
- the wave-1 defaults;
- W3 stage 1, with `search.reranker.gate` defaulting to `off`.

The A15 shadow probe needs W3 stage 1, so it can replay these stores with `search.reranker.gate: shadow` without a second build. Verified: `8d4f6ab6e` contains both `77cf8e111` and #6445's previous head `a2a08a15`, and its `VERSION` is `0.60.169.0`. Its local suites passed. GitHub CI on #6445 was queued when this was written. Dev does not wait for it. The record for this pin reads "GitHub CI: queued at pin time; local suites passed".

The counted pin (PR-B's head) is still recorded in its own addendum, before any counted cell.

## Dev cells and their caps (October 11, 2026)

Dev runs in five groups. Each group has its own VM and its own ledger, so groups run in parallel. In each group, the cell that builds a store runs first.

| Group | Questions | Cells, in run order | Ledger cap |
|---|---|---|---:|
| `dev-lme` | LongMemEval-S dev, 100 | `combined-v2` (builds the measured-default store), `raw@pin` (builds the raw store), `combined-v2` with `facts_arm` admission, `combined-v1@pin`, `filler-removed`, `recall-one-call` | $20 |
| `dev-locomo` | LoCoMo10 `conv-42`, `conv-44`, 322 | `combined-v2`, `raw@pin`, `combined-v2` with `facts_arm`, `combined-v1@pin`, `recall-one-call`, gpt-6-luna `combined-v1@pin` | $32 |
| `dev-beam-100k` | BEAM 100k {3, 11}, 40 | `combined-v2`, `combined-v2` with `facts_arm`, `combined-v1@pin`, `recall-one-call`, `cost-matched` (7,560 tokens), gpt-6-luna `combined-v1@pin` | $10 |
| `dev-beam-500k` | BEAM 500k {12, 21, 28, 31}, 80 | as 100k; `cost-matched` at 7,665 | $20 |
| `dev-beam-1m` | BEAM 1M {16, 21, 22, 25}, 80 | as 100k; `cost-matched` at 7,846 | $21 |

The ledger caps total $103. The A15 shadow probe's Voyage-only replay, about $1, takes the stage to about $104.

- **Delivered totals.** Each lane delivers 8,100 tokens: `combined-v2` packs the facts block (1,800 on LongMemEval-S and LoCoMo10, 600 on BEAM) and the pages under 8,100; `combined-v1@pin` gives pages 8,100 minus the block; `filler-removed`, `raw@pin` and `recall-one-call` give 8,100 to pages or to gbrain's packer. `cost-matched` is `combined-v2` at the comparator's mean delivered total on that BEAM split in wave 1's sealed cells.
- **Admission rule.** W1 shipped `recall.question_admission` with two rules: `reserve` (the default) and `facts_arm`. Dev picks the rule with the higher `combined-v2` mean over all 422 LongMemEval-S and LoCoMo10 dev questions plus the 200 BEAM dev questions, each question weighted equally. A tie keeps `reserve`, the shipped default. The pick is recorded here before any counted cell. The decision lanes (`recall-one-call`, `cost-matched`) run at `reserve`.
- **The gpt-6-luna continuity row** on LongMemEval-S is step 0's arm comb, which is `combined-v1` on a gpt-6-luna store (build `59782b95`). It is not rerun at the pin, which saves about $10. It is descriptive and decides nothing.
- **Judging.** Dev lanes are judged in-cell by the preregistered judge. Dev decides tuning, not gates, so there is no joint re-judge in stage 2.
- **Refusal.** A cell whose cap exceeds what is left on its group's ledger is refused and reported, not shrunk.
- **Custody.** Each group's ledger is copied to `~/.capy/work/mpw-ledgers/wave2/<group>.sqlite` on the integrator's primary machine after every cell, with SHA-256 checked on both sides.

## Step 0 result: mode dominates, so the wave pauses (October 11, 2026)

**Rule 1 fires, so the wave pauses for Garry's decision.** On the 100 LongMemEval-S dev questions, switching the combined store's search mode from `tokenmax` to `conservative` gains 13 points. Removing the facts block, and returning its space to pages, changes the score by −1 and 0 points. This result is exploratory: step 0 ran on #6066's head, `59782b95`, with the knobs listed in its specs, and it decides scope only. No dev cell has run.

The figures below come from the joint blinded re-judge of all five arms. The judge was `gemini-3.5-flash`. The in-cell judges gave 79, 81, 81, 93 and 90 in the table's order. The re-judge moves comb up 2 and arms a and b down 1 each, so rule 1 fires on either set.

| Arm | Correct | Abstentions | Delivered tokens (mean / p95) | Cell |
|---|---:|---:|---|---|
| comb | 81 | 22 | 8,128 / 8,156 | `longmemeval-s-gbrain-rag-95369ca39b74` |
| a: block removed | 80 | 21 | 6,335 / 6,363 (below the context gate, by design) | `longmemeval-s-gbrain-rag-0c561a6a744f` |
| b: space returned | 80 | 20 | 8,142 / 8,175 | `longmemeval-s-gbrain-rag-77c9ebfbf567` |
| d: `conservative` | 93 | 12 | 8,058 / 8,105 | `longmemeval-s-gbrain-rag-a1bbbca4a86b` |
| raw | 90 | 14 | 8,052 / 8,098 | `longmemeval-s-gbrain-rag-367592ede32e` |

The gap is raw − comb = 9 points. It splits into four parts. The intervals are paired bootstrap 95% intervals over questions, 9,999 draws, seed `20261010`.

| Part | Points | 95% interval |
|---|---:|---|
| store (raw − d) | −3 | −7 to 0 |
| mode (d − b) | +13 | +6 to +21 |
| page space (b − a) | 0 | −3 to +3 |
| facts block (a − comb) | −1 | −5 to +2 |

- **Rule 1 (mode dominates): fires.** (d − b) = +13 is positive and larger than (b − comb) = −1.
- **Rule 2 (proceed): not reached.** It would fail anyway, because (b − comb) = −1 is below half the gap.
- **Where the gain is.** Multi-session questions account for most of it: 19 of 22 correct under `conservative` against 11 of 22 under `tokenmax`, with the same store and the same 8,100-token page budget. Temporal reasoning goes from 21 to 23 of 27. Every other question type is within one question.
- **What the mode switch changes.** The harness already sends `expand: false`, so query expansion is not part of the difference. The page budget is also the same in both arms, because the caller's `token_budget` overrides each bundle's own budget. Under `tokenmax`, the bundle also turns on these, each of which `conservative` leaves off:
  - the cross-encoder reranker, `voyage:rerank-2.5`, over the top 50;
  - a search limit of 50 instead of 10;
  - graph signals;
  - relational retrieval and its planner;
  - `per_chunk_synopsis` contextual retrieval.

  Step 0 does not isolate which of these costs the points.
- **The facts store helps a little.** With the mode held at `conservative`, the combined store scores 3 points above the raw store. The interval reaches 0, so this is not established.

**Spend.** Step 0 committed $15.14 on its ledger and the joint re-judge $1.30, for a total of $16.44 of the $18 released. Receipts:

- the cells under [`2026-10-10-memory-proof-wave-2/step0/cells/`](2026-10-10-memory-proof-wave-2/step0/cells/);
- the re-judge, with its analysis, under [`step0/rejudge/`](2026-10-10-memory-proof-wave-2/step0/rejudge/).

The ledgers are mirrored to the integrator's primary machine with matching SHA-256:

- `step0.sqlite`: `aa646c6b…`;
- `step0-rejudge.sqlite`: `a4366da6…`.

The step-0 VM is destroyed and recorded in `VMS.md`.

## The wave pauses for re-scope; a mode isolation runs first (October 11, 2026)

**Decision (Garry, through the integrator, October 11).** Step 0's mode-dominates rule fired, so the wave is paused for re-scope. Stage 2 as written above (the dev groups and their caps) does not start. Before the re-scope, one exploratory isolation runs to find which part of `tokenmax` costs the 13 points. It is diagnosis, not a gate, and its result goes to Garry with the re-scope decision.

**Scope.** LongMemEval-S dev only, the same 100 questions. No BEAM, LoCoMo10 or other dev cell runs.

**Build and store.**
- Build: the dev pin, `8d4f6ab6e589df8b59bedd791cffb8092540b646`.
- Store: one measured-default store (Claude Haiku 5.5 extraction, credentials `voyage` and `anthropic`), with the ingest knobs of the explicit-knob addendum. All arms read this one store.
- The first arm, `b`, runs under `tokenmax` and builds the store. A markdown import embeds pages under the inline contextual-retrieval tier of the mode active at ingest, with `per_chunk_synopsis` demoted to `title`. So this store, like step 0's combined store, is embedded at the `title` tier.

**Arms.** Each arm starts from the explicit read-knob set above, with the facts block removed and 8,100 page tokens, unless noted. Specs: `cells/mpw2/iso/`, written by [`mpw2-iso-specs.py`](../../eval/harness-provider/mpw2-iso-specs.py).

| Arm | Mode | Change |
|---|---|---|
| `b` | `tokenmax` | none (step 0's arm b, at the pin) |
| `d` | `conservative` | none (step 0's arm d, at the pin) |
| `comb` | `tokenmax` | wave-1 combined packing: 1,800-token block plus 6,300 page tokens |
| `t-rerank-off` | `tokenmax` | `search.reranker.enabled: false` |
| `t-limit-10` | `tokenmax` | `search.searchLimit: 10` (from 50) |
| `t-relational-off` | `tokenmax` | `search.relational_retrieval: false`, `search.relational_planner: false` |
| `t-graph-off` | `tokenmax` | `search.graph_signals: false` |
| `t-cr-none` | `tokenmax` | `search.contextual_retrieval: none` |
| `c-rerank-on` | `conservative` | `search.reranker.enabled: true` |

`search.contextual_retrieval` is read only at embed time, and no read path consults it. So `t-cr-none` is expected to match `b`, and it doubles as a same-configuration noise check. `c-rerank-on` separates the reranker on its own from the reranker over tokenmax's larger candidate set.

**Analysis.** One joint blinded re-judge covers all nine arms, with the preregistered judge. For each arm, the analysis reports:
- the paired difference from `b`;
- the paired difference from `d`;
- the share of (d − b) that the arm recovers.

The intervals are paired bootstrap 95% intervals over questions, 9,999 draws, seed `20261010`. Results are broken out by question type, with multi-session and temporal reasoning first. Nothing here is a gate.

**Budget.** The cells run on their own ledger, capped at $23: the store about $9.50, plus eight reads at about $1.30. The re-judge is capped at $2.50. Both come out of the dev release. Ledgers are mirrored to the integrator's primary machine with SHA-256 checked, and the VM is recorded in `iso/VMS.md` and destroyed afterwards.

## Isolation finding, and a two-way `tokenBudget` test (October 11, 2026)

**Finding.** None of the five tokenmax components accounts for the mode gap when it is switched off on its own. The default that does is a sixth one, which the isolation did not switch: the mode bundle's `tokenBudget`, which is 4,000 in `conservative` and unset in `tokenmax`. The in-cell judge (`gemini-3.5-flash`, complete on all 900 answers) gives these scores on the isolation store. The comparisons are paired 95% intervals against `b`.

| Arm | Correct | Change vs `b` | Multi-session (22) | Temporal reasoning (27) |
|---|---:|---|---:|---:|
| `b` tokenmax | 83 | — | 11 | 22 |
| `d` conservative | 91 | +8 (0 to +16) | 19 | 22 |
| `comb` | 82 | −1 (−4 to +2) | 12 | 21 |
| `t-rerank-off` | 82 | −1 (−3 to 0) | 11 | 22 |
| `t-limit-10` | 83 | 0 (−3 to +3) | 11 | 22 |
| `t-relational-off` | 83 | 0 | 11 | 22 |
| `t-graph-off` | 83 | 0 | 11 | 22 |
| `t-cr-none` | 84 | +1 (0 to +3) | 12 | 22 |
| `c-rerank-on` | 87 | +4 (−1 to +10) | 15 | 22 |

**Mechanism, from the code at `8d4f6ab6e` and the retrieval receipts.**

- The harness asks for `return_unit: "page"`. With an evidence plan like that, `query` does not pass the call's `token_budget` down to ranking (`src/core/ops/search.ts:981`: `tokenBudget: !plan && … ? p.token_budget : undefined`). The call's budget applies only later, when pages are packed for delivery.
- So ranking cuts its hits to the mode's own `tokenBudget` (`src/core/search/hybrid/rank.ts:487`, `enforceTokenBudget(sliced, resolvedMode.tokenBudget)`). That cut decides how many pages reach delivery.
- Under `conservative`, the cut is 4,000 tokens of hits, and 8.4 pages per question reach delivery on average. Each page is delivered whole within the 8,100-token budget; one session ran to 19,199 characters.
- Under `tokenmax`, nothing is cut, and 47.6 pages per question compete for the same 8,100 tokens. About 16 are delivered as fragments of roughly 600 tokens each, and 31.6 are dropped.
- So `tokenmax` gives the answer model slivers of many sessions instead of whole sessions. Multi-session questions lose the most: 11 against 19 of 22.
- The receipts agree on every arm. `d` and `c-rerank-on` deliver 8.4 and 8.2 pages per question. `b` and every tokenmax single-flip arm deliver 47.6 candidates.
- The harness sends `limit: 50` on every call, so `search.searchLimit` cannot change the candidate count. That is why `t-limit-10` was a no-op.
- Graph signals, relational retrieval and the contextual-retrieval read knob leave 85 to 92 of 100 contexts identical to `b`. A known no-op (`t-cr-none`) leaves 86, so those three are within noise. Turning the reranker off changes all 100 contexts but not the score.
- Within `conservative`, adding the reranker changes which 8 pages survive the cut and costs about 4 points: `c-rerank-on` −4 against `d`, interval −10 to +2.

**Two-way test (Garry, through the integrator, October 11).** The claim is tested in both directions on one rebuilt store of the same identity, `gbrain-longmemeval-s-e1c9dfc782e7`, at `8d4f6ab6e`.

| Arm | Mode | Change | Expected |
|---|---|---|---|
| `b` | `tokenmax` | none (builds the store) | reference |
| `d` | `conservative` | none | reference |
| `t-tb-4000` | `tokenmax` | `search.tokenBudget: 4000` | recovers toward `d` |
| `c-tb-unset` | `conservative` | `search.tokenBudget: 10000000` | falls toward `b` |

`search.tokenBudget` accepts only a positive integer. So "unset" is a budget that no ranked list reaches, which matches `tokenmax`'s undefined budget.

The four arms get their own joint blinded re-judge. The scope is LongMemEval-S dev only, and the result is exploratory. The cells run on their own ledger, capped at $16: the store about $11, plus three reads at about $1.30. The re-judge cap is $2.00, sized for the $0.59 per-call reservation; its actual spend is about $1.10. Specs are in `cells/mpw2/iso2/`, written by `mpw2-iso-specs.py`. Ledgers are mirrored, and the VM is recorded in `iso2/VMS.md` and destroyed afterwards.

**Isolation re-judge cap.** The isolation's joint re-judge refused 107 of its 900 answers at $1.91 committed of its $2.50 cap. Each judge call reserves a worst case of $0.59, against an actual cost of about $0.003. With Garry's approval, the cap was raised to $3.00 for reservation headroom only. The reason is recorded in that ledger's cap change. Actual spend stays near $2.21.

## Two-way `tokenBudget` result: the ranking cut explains the mode gap (October 11, 2026)

**The mode's `tokenBudget` cut explains the gap in both directions.** Giving `tokenmax` the 4,000-token cut recovers 6 of the 10 points. Removing the cut from `conservative` loses 8 of them. Multi-session follows the cut exactly when it is removed. The result is exploratory, LongMemEval-S dev only, on one rebuilt store at `8d4f6ab6e`.

The scores come from the joint blinded re-judge of the four arms. Intervals are paired bootstrap 95% intervals over questions, 9,999 draws, seed `20261010`.

| Arm | Score | vs `b` | vs `d` | Multi-session (22) | Temporal reasoning (27) | Pages reaching delivery per question |
|---|---:|---|---|---:|---:|---:|
| `b` tokenmax | 80 | — | −10 (−19 to −2) | 11 | 20 | 47.6 (16.0 delivered, 31.6 dropped) |
| `d` conservative | 90 | +10 (+2 to +19) | — | 18 | 22 | 8.3 |
| `t-tb-4000` tokenmax, cut 4,000 | 86 | +6 (0 to +13) | −4 (−10 to +1) | 14 | 22 | 8.2 |
| `c-tb-unset` conservative, no cut | 82 | +2 (0 to +5) | −8 (−16 to 0) | 11 | 21 | 47.6 (16.2 delivered, 31.4 dropped) |

- **The knob alone sets how many pages reach delivery.** `t-tb-4000` delivers the same 8.2 pages per question as `d`. `c-tb-unset` has the same 47.6 candidates as `b`. Everything else about each mode is unchanged.
- **Removing the cut from `conservative` drops multi-session to exactly `b`'s 11 of 22.** Adding the cut to `tokenmax` lifts it from 11 to 14.
- **The rest of the gap is the reranker.** Under the cut, the reranker picks which 8 pages survive, and that costs about 4 points. `t-tb-4000` scores −4 against `d`, and in the isolation `c-rerank-on` also scored −4 against `d` (87 against 91).
- **The isolation's joint re-judge, now complete on all 900 answers, gives the same picture as its in-cell judge.** `b` 83, `d` 91, `c-rerank-on` 87, and every single tokenmax flip 80 to 83.

**Spend on the wave-2 ledgers (dev release).**

| Item | Spend |
|---|---:|
| Isolation cells | $21.57 |
| Isolation re-judge | $2.23 |
| Two-way cells (store $11.0) | $14.73 |
| Two-way re-judge | $1.05 |
| **Total** | **$39.58** |

Receipts are under `2026-10-10-memory-proof-wave-2/iso/` and `iso2/`. Ledgers are mirrored to the integrator's primary machine with matching SHA-256: `iso.sqlite` `206d2e2f…`, `iso-rejudge.sqlite` `1a5057b5…`, `iso2.sqlite` `ddb723f9…`, `iso2-rejudge.sqlite` `3f37128a…`. Both VMs are destroyed and recorded.

## Re-scope: W5 honors the caller's budget in page mode (October 11, 2026)

**Decision (Garry, through the integrator, October 11).** Step 0's mode-dominates rule fired, and the wave paused for re-scope. The isolation and the two-way test (both above) traced the 10-point mode gap to one cause. Under `return_unit: "page"`, ranking cuts candidates to the mode's `tokenBudget` instead of the caller's budget. Garry chose option 1: make page-mode ranking honor the caller's budget.

**W5** is that change. It is built on gbrain#6445's branch beside W3. It adds one `search.*` key, off by default. When the key is on, page-unit ranking candidates are capped at `min(mode cut, ratio × caller token_budget)`, and the applied cut is reported in `_meta`. The wave now covers:

- W1, shipped in v0.60.169.0;
- W3, the rerank gate, stage 1, with its shadow probe pending;
- W5.

The dev pin moves to the head of #6445 once W5 is on it. The next addendum records the SHA and the W5 key's exact name before any W5 cell runs.

### W5 dev tuning (exploratory, LongMemEval-S dev only)

**Store.** One measured-default LongMemEval-S dev store at the new pin, with the explicit knobs below.

**Arms.** Six arms, all `filler-removed` (no facts block, 8,100 page tokens):

| Arm | Mode | W5 | `search.tokenBudget` |
|---|---|---|---|
| `b` | `tokenmax` | off | unset (`10000000`) |
| `d` | `conservative` | off | `4000` |
| `w5-0.40` | `tokenmax` | on, ratio 0.40 (cap 3,240 tokens) | unset |
| `w5-0.50` | `tokenmax` | on, ratio 0.50 (cap 4,050) | unset |
| `w5-0.75` | `tokenmax` | on, ratio 0.75 (cap 6,075) | unset |
| `w5-1.00` | `tokenmax` | on, ratio 1.00 (cap 8,100) | unset |

`b` builds the store. All six arms get one joint blinded re-judge with the preregistered judge.

**Ratio rule, fixed before the run.** Among the four W5 arms, pick the one with the most multi-session questions correct (of 22) on the joint re-judge. The choice is subject to all of the following:

1. its overall score is at least `b`'s;
2. in every other question type, it is within 1 question of `b`;
3. it beats `b` on multi-session by at least 2 questions.

Ties go to the higher overall score, then to the larger ratio, which is the smaller change from the caller's budget. If no ratio passes, W5 does not go to the counted gates, and Garry decides. The chosen ratio is recorded here before any counted W5 cell runs.

**Budget.** About $20: the store about $11, five reads at about $1.30, and the re-judge about $1.60 (cap $2.50, sized for the $0.59 per-call reservation).

### W5 gate on BEAM

The BEAM data is the 72 non-dev conversations. Under GBRA-49's ruling, it is regression and descriptive evidence, reused, not held-out confirmation.

- **Lanes.** `combined-v2` with W5 off, and `combined-v2+w5` with W5 on at the dev-chosen ratio. Both use the same pin and the same store; only the read differs.
- **Statistic.** Gate 2's: wave 1's restricted wild cluster bootstrap-t, stratified by size, with conversations as clusters (Webb six-point weights, 9,999 draws, seed `20261010`), on the joint BEAM re-judge.
- **Pass.** Both conditions must hold:
  - the one-sided 95% lower bound of (W5-on − W5-off), pooled, is above −3 points;
  - no question kind's two-sided 95% interval lies entirely below −3 points (TC6), across multi-session, contradiction, temporal, event ordering and abstention.
- **A pass flips the default.** The W5 key ships on, at the dev-chosen ratio. A failure keeps it off, and the result is reported as measured.
- The pooled point estimate and the multi-session difference are reported beside the gate, whichever way it lands.

### Knob table for every stage-2 and stage-3 arm

Every arm sets these keys explicitly in `search_config`, on top of the ingest keys in the explicit-knob addendum. This replaces that addendum's read-time table.

| Key | Value |
|---|---|
| `search.mode` | `tokenmax` on facts-store lanes; `conservative` on `raw@pin` |
| `search.tokenBudget` | `10000000` with `tokenmax` (the bundle's unset budget; the key takes only a positive integer); `4000` with `conservative` |
| W5's key | off, except on `combined-v2+w5` and the W5 tuning arms |
| `search.reranker.enabled`, `search.reranker.model` | `true` with `tokenmax` and `false` with `conservative`; `voyage:rerank-2.5` |
| `search.reranker.gate`, `search.reranker.gate_min_gap` | `off`, `0.05` (`shadow` only on the A15 replay, `on` only on `combined-v2+gate`) |
| `search.query_facts_arm`, `search.temporal_fact_reserve` | `true`, `false` |
| `search.evidence_date_header`, `search.entity_anchoring` | `false`, `false` |
| `recall.question_admission` | `reserve`, except dev's `facts_arm` tuning lane |

`tests/test_mpw2_dev_specs.py` is extended to require `search.tokenBudget` and W5's key once the pin addendum names it. The dev specs are regenerated at the new pin.

### Dev and confirmation, re-planned

**Dev changes from the dev-cells addendum.**

- The dev groups run at the new pin with the table above.
- The LongMemEval-S dev group reuses the W5 tuning store, so it does not build a store of its own.
- The gpt-6-luna continuity rows on BEAM and LoCoMo10 are dropped. Step 0's arm comb remains the gpt-6-luna continuity row.
- A `combined-v2+w5` lane runs on each BEAM dev split at the chosen ratio, as a dev check before the BEAM gate.
- The A15 shadow probe runs on the rebuilt BEAM dev stores, as before.

**Confirmation changes.**

- `filler-removed@pin` is dropped: step 0 showed that removing the facts block changes nothing at this budget (a − comb −1, b − a 0).
- LoCoMo10's `raw@pin` is dropped. Gate 1 reads LongMemEval-S only, so LoCoMo10's raw lane was descriptive.
- `combined-v2+w5` is added on BEAM non-dev for the W5 gate.

**Budget within the $650 cap.**

| Line | Status | USD |
|---|---|---:|
| Step 0, five arms and re-judge | spent | 16.44 |
| Mode isolation, nine arms and re-judge | spent | 23.80 |
| Two-way `tokenBudget` test, four arms and re-judge | spent | 15.78 |
| W5 dev tuning, LongMemEval-S | next, released by this amendment | 20 |
| Dev at the new pin: BEAM 100k / 500k / 1M and LoCoMo10 groups, the LongMemEval-S group on the tuning store, `combined-v2+w5` BEAM dev checks, A15 probe | released after the W5 pick | 92 |
| Confirmation: LongMemEval-S (ingest, `combined-v1@pin`, `combined-v2`, `raw@pin`) | behind Garry's go | 50 |
| Confirmation: LoCoMo10 (ingest, `combined-v1@pin`, `combined-v2`) | behind Garry's go | 33 |
| Confirmation: BEAM non-dev (ingest, `combined-v1@pin`, `combined-v2`) | behind Garry's go | 120 |
| Confirmation: BEAM `combined-v2+w5` | behind Garry's go | 45 |
| Confirmation: the comparator's BEAM regeneration | behind Garry's go | 105 |
| Confirmation: joint re-judges (BEAM $89 with the W5 lane, LoCoMo10 $12, LongMemEval-S $6) | behind Garry's go | 107 |
| **Subtotal** | | **628** |
| Reserve | | 22 |
| W3 `combined-v2+gate` replay, only if A15 shows a would-skip rate of at least 25% | contingent | 35 |

The contingent W3 replay exceeds the reserve by $13. If A15 calls for it, it needs either a trim recorded here or Garry's decision on the cap before it runs. Confirmation stays behind Garry's explicit go.

## W5 pin, key and receipt check (October 11, 2026)

**Pin.** W5 dev tuning runs at gbrain `fe9e0397b7e523b8db3b83e1202fb297337e71b3`, the head of #6445's branch. Its parent is the previous dev pin `8d4f6ab6e`, so the pin is that tree plus W5 and nothing else. Every W5 tuning cell runs with `GBRAIN_SHA` set to this SHA, and the pin does not change mid-run.

**Key.** `search.page_rank_budget_ratio`, registered in `KNOWN_CONFIG_KEYS` and read by `src/core/search/page-rank-cut.ts`. It is off when unset, empty, zero, negative, non-numeric or not finite (`Infinity` included); the specs write `0` for off.

**Where it applies.** Only page-unit calls that carry a caller `token_budget`: `query`, `search` and recall's hybrid page arm. Chunk-unit calls and calls without a caller budget never engage it. When on, ranking cuts its hits to `min(mode search.tokenBudget, max(1, floor(ratio × caller budget)))`, using the caller budget after any remote clamp. Under `tokenmax` with `search.tokenBudget` `10000000`, the ratio sets the cut.

**What it reports.** `page_rank_cut {ratio, caller_budget, mode_cut, applied_cut, candidates, kept}`, in `_meta` on `query` and `search`, and top level on `recall`. It is absent when the key is off.

**Tests at the pin.** A local smoke run against the pin, through the wave-2 provider with `token_budget` 1,500, reported `{ratio 0.5, caller_budget 1500, mode_cut 10000000, applied_cut 750}` with the ratio at `0.5`, and no `page_rank_cut` with it at `0`. The provider suites (`test_gbrain_facts`, `test_page_rank_cut`, `test_mpw2_dev_specs`) pass against the pin. GitHub Test run 38189090777 was dispatched by hand, because #6445 conflicts with master while it is held as the pin. Its shard 4 fails one gbrain test: `test/config-search-registry.test.ts`, "every registered search.* key has a reader", which expects the new key in that test's own list of directly read keys. It reproduces locally. The missing entry is in the test, not the code path, so the measurement is unaffected. The fix is a one-line test change on #6445, and it does not move the W5 tuning pin.

**Receipt check.** On every query-path row, the provider checks the reported cut against the arm's spec before keeping the row:

- with the ratio off, a reported `page_rank_cut` fails the row;
- with it on, `ratio` must equal the spec's ratio, `caller_budget` must equal the spec's `token_budget`, and `applied_cut` must equal `min(search.tokenBudget, floor(ratio × token_budget))`; a missing or different cut fails the row.

The checked object is kept in each row's metadata as `page_rank_cut`. The one-call recall path records the object but does not check it, and no W5 tuning arm uses that path.

**Specs.** Six arms in `eval/harness-provider/cells/mpw2/w5/` (`lme-b`, `lme-d`, `lme-w5-0.40`, `lme-w5-0.50`, `lme-w5-0.75`, `lme-w5-1.00`), with `order.json` putting `b` first to build the store. The stage cap is $18, `b`'s cell cap is $12 and the other cells' caps are $2 each. All six are `filler-removed` at `token_budget` 8,100 and set every key in the re-scope knob table, including `search.tokenBudget` and `search.page_rank_budget_ratio`. `mpw2-iso-specs.py` generates them, and `tests/test_mpw2_dev_specs.py` checks each arm's mode and ratio. The dev specs are regenerated with both new keys, with the ratio `0` (off), and with `search.tokenBudget` `4000` on `raw` and `10000000` elsewhere.

## W5 dev tuning result: ratio 0.40 is picked (October 12, 2026)

**The preregistered ratio rule picks `w5-0.40`.** All four W5 ratios pass the rule's three conditions. `w5-0.40` has the most multi-session questions correct, 16 of 22 against `b`'s 11, and scores 90 against `b`'s 82. The result is exploratory, LongMemEval-S dev only, on one store at `fe9e0397b`. The rule is applied with the full six-arm set, as preregistered.

The scores come from the joint blinded re-judge of the six arms. Intervals are paired bootstrap 95% intervals over questions, 9,999 draws, seed `20261010`.

| Arm | Score | vs `b` | vs `d` | Multi-session (22) | Temporal reasoning (27) | Pages kept by the W5 cut per question |
|---|---:|---|---|---:|---:|---:|
| `b` tokenmax, W5 off | 82 | — | −9 (−17 to −2) | 11 | 22 | — |
| `d` conservative, W5 off | 91 | +9 (+2 to +17) | — | 19 | 22 | — |
| `w5-0.40`, cut 3,240 | 90 | +8 (+2 to +14) | −1 (−7 to +5) | 16 | 24 | 5.9 |
| `w5-0.50`, cut 4,050 | 88 | +6 (+1 to +12) | −3 (−9 to +3) | 15 | 22 | 7.2 |
| `w5-0.75`, cut 6,075 | 88 | +6 (+2 to +11) | −3 (−10 to +3) | 14 | 23 | 10.3 |
| `w5-1.00`, cut 8,100 | 88 | +6 (+2 to +11) | −3 (−9 to +3) | 14 | 23 | 13.5 |

**Rule check, question counts against `b`.**

| Arm | Overall ≥ `b` | Multi-session vs `b` (needs +2) | Other types vs `b` (each needs ≥ −1) | Passes |
|---|---|---:|---|---|
| `w5-0.40` | yes, 90 | +5 | temporal reasoning +2, single-session user +1, all others 0 | yes |
| `w5-0.50` | yes, 88 | +4 | single-session preference +1, single-session user +1, all others 0 | yes |
| `w5-0.75` | yes, 88 | +3 | temporal reasoning +1, single-session preference +1, single-session user +1, all others 0 | yes |
| `w5-1.00` | yes, 88 | +3 | temporal reasoning +1, single-session preference +1, single-session user +1, all others 0 | yes |

Condition 2, "within 1 question of `b`", is read as a floor: no other type loses more than one question. No arm loses a question in any type. A two-sided reading would exclude `w5-0.40`, which gains two temporal-reasoning questions, and would pick `w5-0.50` instead. The floor reading is applied because the condition guards against regressions. `analysis.json` records both readings for each arm.

- **The cut closes most of the mode gap.** `w5-0.40` recovers 89% of `d − b` (8 of 9 points) and sits 1 point below `d`, with an interval that includes zero. The other ratios recover 67%.
- **Multi-session rises as the cut tightens.** 14, 14, 15 and 16 of 22 from ratio 1.00 down to 0.40, against `b`'s 11 and `d`'s 19. `d` still leads on multi-session by 3. That matches the two-way finding that the reranker's choice of surviving pages costs some multi-session questions under `tokenmax`.
- **Abstentions fall.** `b` abstains on 19 questions. The W5 arms abstain on 11 to 14, and `d` on 10.
- **The receipt check holds on every row.** All 100 rows of each W5 arm report `applied_cut` 3,240, 4,050, 6,075 and 8,100 respectively. The ratio-off arms report no cut. Every cell passes all four gates, with no answer or retrieval failures.

**Stage cap raise.** Arm `w5-1.00` was refused before it spent anything, because its $2.00 run budget exceeded the $1.80 left under the $18.00 stage cap. With Garry's approval, the stage cap was raised to $19.50, inside the re-scope's roughly $20 W5 tuning line. The reason is recorded in the stage ledger's cap change.

**Spend.**

| Item | Spend |
|---|---:|
| Store and arm `b` | $10.92 |
| Arms `d`, `w5-0.40`, `w5-0.50`, `w5-0.75`, `w5-1.00` | $6.66 |
| Joint re-judge (cap $2.50) | $1.53 |
| **Total** | **$19.10** |

Wave-2 spend to date is $75.12.

**Next.** `combined-v2+w5` uses `search.page_rank_budget_ratio` `0.40` in the dev checks and the W5 BEAM gate. Dev at the new pin is released under the re-scope amendment. Confirmation stays behind Garry's go.

Receipts are under `2026-10-10-memory-proof-wave-2/w5/`, with the re-judge in `w5/rejudge/`. Ledgers are mirrored to the integrator's primary machine with matching SHA-256: `w5.sqlite` `362e22ff…`, `w5-rejudge.sqlite` `39f7e345…`. A compressed copy of the store, `gbrain-longmemeval-s-165df707838f` (sha256 `0a136a61…`), is kept beside them, so the dev group can reuse it. The VM is destroyed and recorded.

## Dev at the W5 pin (October 12, 2026)

Garry confirmed the floor reading of the ratio rule and the pick of 0.40, and released dev at the W5 pin, the $92 line. Dev is exploratory: it tunes nothing that the confirmation reads, except where this addendum says so.

**Pin and knobs.** Every dev cell runs at gbrain `fe9e0397b7e523b8db3b83e1202fb297337e71b3` and sets the re-scope knob table explicitly. W5 is off (`search.page_rank_budget_ratio` `0`) on every arm except `v2-w5`, which sets it to `0.4`. The receipt check from the W5 pin addendum applies to every query-path row.

**Groups and arms.** Each group runs on its own VM under its own stage ledger, in this order. The first cell of each group builds its store, except on LongMemEval-S.

| Group | Arms, in run order | Stage cap |
|---|---|---:|
| `dev-lme` | `v2`, `raw`, `v2-facts-arm`, `v1`, `filler`, `one-call` | $12 |
| `dev-locomo` | `v2`, `raw`, `v2-facts-arm`, `v1`, `one-call` | $26 |
| `dev-beam-100k` | `v2`, `v2-w5`, `v2-facts-arm`, `v1`, `one-call`, `cost-matched` | $10 |
| `dev-beam-500k` | `v2`, `v2-w5`, `v2-facts-arm`, `v1`, `one-call`, `cost-matched` | $19 |
| `dev-beam-1m` | `v2`, `v2-w5`, `v2-facts-arm`, `v1`, `one-call`, `cost-matched` | $20 |

The caps total $87, which leaves $5 of the $92 line for the A15 shadow probe.

- **`v2-w5`** is `combined-v2` with W5 at ratio 0.40. Its page arm receives `delivered_tokens` minus the packed facts, so W5 cuts ranking to 0.40 of that per-question page budget.
- **The gpt-6-luna rows are gone.** `luna-v1` on LoCoMo10 and the three BEAM splits is dropped, as the re-scope planned.
- **LongMemEval-S reuses the W5 tuning store.** `gbrain-longmemeval-s-165df707838f` is restored from its mirrored copy (sha256 `0a136a61…`) onto the `dev-lme` VM before the first cell runs. The store id is derived from the ingest config, the harness lock and the gbrain build. All three are unchanged since the tuning run, so the dev cells resolve to the same store, and `v2`'s cap drops to $2. If the store did not resolve, `v2` would start an ingest and stop at that $2 cap.
- **Store paths go to the A15 shadow probe and the gate-4 latency run** as each store exists. Both read the stores and never write to them.

`mpw2-dev-specs.py` generates the specs. `tests/test_mpw2_dev_specs.py` checks the 29 dev specs: every knob is set, the ratio is `0.4` only on `v2-w5`, and every facts arm uses the measured-default extractor.

## Dev cell budgets were sized below the proxy's reservations (October 12, 2026)

**The error.** The metering proxy reserves each call's worst case before it forwards the call, about $0.37 for a judge call. The proxy refuses a call when the cell's remaining budget is smaller than the reservations already open. BEAM's rubric judge and LoCoMo10's 300-odd questions keep several calls in flight at once. With the dev budgets of $2 to $5, cells therefore ran out of reservation room while their actual spend was a fraction of the budget. Refused calls are never forwarded, so the spend figures are real. The runner treated any cell with a summary as finished, so it went on to the next arm. It now stops the stage when a cell's summary is not `ok` (ec877ee0).

**The incomplete cells.** Each is published as measured, with `ok: false`, and none is used for any comparison:

| Group | Arm | Cell | Spend | Missing of scheduled |
|---|---|---|---:|---|
| BEAM-100K | `v2` | `beam-100k-gbrain-rag-ca55ad8fdcd8` | $1.17 | 4 of 40 |
| BEAM-100K | `v2-w5` | `beam-100k-gbrain-rag-c6c9cd82a32a` | $0.24 | 31 of 40 |
| BEAM-100K | `v2-facts-arm` | `beam-100k-gbrain-rag-3cf5cfb62931` | $0.40 | 25 of 40 |
| BEAM-100K | `v1` | `beam-100k-gbrain-rag-ac6117f19c29` | $0.53 | 20 of 40 |
| BEAM-100K | `one-call` | `beam-100k-gbrain-rag-a77f47084127` | $0.18 | 34 of 40 |
| BEAM-100K | `cost-matched` | `beam-100k-gbrain-rag-31fb20a0840a` | $0.07 | 35 of 40 |
| BEAM-500K | `v2` | `beam-500k-gbrain-rag-030c1e27016e` | $3.20 | 16 of 80 |
| BEAM-500K | `v2-w5` | `beam-500k-gbrain-rag-3952b0ffc5ef` | $1.73 | 8 of 80 |
| BEAM-500K | `v2-facts-arm` | `beam-500k-gbrain-rag-b8fb2482f62e` | $1.61 | 21 of 80 |
| BEAM-1M | `v2` | `beam-1m-gbrain-rag-4f0bcbdf6ffa` | $2.68 | 40 of 80; units 22 and 25 not ingested |
| BEAM-1M | `v2-w5` | `beam-1m-gbrain-rag-78d3fc4cfd94` | $1.74 | stopped by hand, no summary |
| LoCoMo10 | `v2-facts-arm` | `locomo-locomo10-gbrain-rag-76c3e4da451a` | $4.07 | 0 missing; 1 judge failure |
| LoCoMo10 | `v1` | `locomo-locomo10-gbrain-rag-ac535fd2f1e0` | $4.02 | 33 of 322 |
| LoCoMo10 | `one-call` | `locomo-locomo10-gbrain-rag-795502576479` | $0.84 | stopped by hand, no summary |

The BEAM-100K and BEAM-500K stores, and the LoCoMo10 store, are complete. BEAM-1M's store has units 16 and 21. The rerun's first cell ingests 22 and 25 into the same store.

**The new budgets.** These are reservation headroom only; actual spend per arm is expected near the measured costs.

| Group | Cell budgets | Stage cap |
|---|---|---|
| BEAM-100K | every arm $4 | $10 → $14 |
| BEAM-500K | every arm $7 | $19 → $28 |
| BEAM-1M | `v2` $10, the other arms $7 | $20 → $34 |
| LoCoMo10 | `v2-facts-arm`, `v1`, `one-call` $9; `v2` and `raw` unchanged | $26 → $39 |
| LongMemEval-S | unchanged | $12 |

Garry approved the caps on 2026-10-12, taking about $6 from the reserve, which goes from $22 to about $16. Each stage ledger records its cap change and the reason. A larger budget is a new cell, so every rerun arm gets a new cell id. LoCoMo10's `v2` and `raw` keep their passing cells.

**LongMemEval-S finished at $8.64.** `v2`, `raw`, `v2-facts-arm`, `v1` and `filler` pass every gate. `one-call` (`longmemeval-s-gbrain-rag-c193e6a772dd`, W5 off) is complete but fails the delivered-context gate: it delivers a mean of 6,753 tokens (p95 7,217) against the 8,000 target. The facts section is small and accounts for none of the shortfall: 2.8 facts and 97 tokens per question. The loss is in the pages section. gbrain packs pages until its own estimate reaches 7,673 tokens of the 8,100 budget, leaving 357 unused, and those pages measure 6,657 tokens in cl100k. So gbrain's page estimate runs 13% above cl100k, and page granularity leaves the rest of the budget unused. The cell is published as measured and not rerun, because a larger budget would not change it.

## A15 fails its floor: W3 ships as the shadow grade only (October 12, 2026)

**Result.** The A15 shadow probe replayed every dev question with `search.reranker.gate: shadow` at pin `fe9e0397b`, on the LongMemEval-S, BEAM-100K, BEAM-500K and LoCoMo10 dev stores. Every question was eligible, and every one graded `not_strong` for `cosine_below_floor`. The would-skip rate is 0 of 542, against the 25% the prereg requires both pooled and on BEAM dev alone. voyage-4's top cosine never reaches the 0.80 floor; the highest on any question is 0.781.

| Store | Questions | Would-skip | Top cosine p50 / max | Rank-1 fused = reranked | Context change, shadow vs shadow (noise) | Context change, reranked vs no reranker |
|---|---:|---:|---|---:|---:|---:|
| LongMemEval-S | 100 | 0 | 0.457 / 0.781 | 71% | 5.0% | 100% |
| BEAM-100K | 40 | 0 | 0.549 / 0.753 | 27.5% | 0% | 100% |
| BEAM-500K | 80 | 0 | 0.567 / 0.732 | 27.5% | 2.5% | 100% |
| LoCoMo10 | 322 | 0 | 0.527 / 0.700 | 59.6% | 1.9% | 97.8% |
| Pooled | 542 | 0 | 0.522 / 0.781 | 54.6% | 2.4% | 98.7% |

With no would-skip question, the decision metric, the token-weighted overlap on would-skip questions, has nothing to measure. The reranker changes the delivered context on nearly every question: mean token overlap with and without it is 0.526 (0.662 at page level).

**Consequences, under TC2.**

- **W3 ships as the shadow grade only.** Stage 2, the skip path, is not built, and the stage-2 work is reverted. `search.reranker.gate` stays `off` by default, with `shadow` available.
- **Gate 4 is recorded as failed.** Stage 2 is not built, so `combined-v2+gate` has no cell, and the gate cannot default to `on`. The paired latency run has no skipped query to save time on: query p50 is 464 ms with the gate in shadow and 469 ms with it on, against 71 ms with no reranker.
- **The W3 `combined-v2+gate` replay is dropped,** and with it the $35 contingent line.
- **Confirmation drops every W3-on arm.** It keeps the `combined-v2` comparisons (gates 1 to 3 and 5) and the W5 BEAM gate.

**Files.** The aggregate report, the probe and the analysis script are under `2026-10-10-memory-proof-wave-2/a15/` (`a15-report.txt` sha256 `a7d26768…`). The per-question rows stay private. They are mirrored to the integrator's primary machine under `wave2/a15/`: `lme.ndjson` `1ea2506f…`, `beam100k.ndjson` `c226f240…`, `beam500k.ndjson` `de9e674f…`, `locomo.ndjson` `767b6008…`, plus the two latency sample files.

### Budget within the $650 cap, without W3

| Line | Status | USD |
|---|---|---:|
| Step 0, mode isolation, two-way test | spent | 56.02 |
| W5 dev tuning, LongMemEval-S | spent | 19.10 |
| Dev at the W5 pin, with the sizing reruns and A15 | running; caps $127, expected actual about $98 | 98 |
| Confirmation: LongMemEval-S (ingest, `combined-v1@pin`, `combined-v2`, `raw@pin`) | behind Garry's go | 50 |
| Confirmation: LoCoMo10 (ingest, `combined-v1@pin`, `combined-v2`) | behind Garry's go | 33 |
| Confirmation: BEAM non-dev (ingest, `combined-v1@pin`, `combined-v2`) | behind Garry's go | 120 |
| Confirmation: BEAM `combined-v2+w5` | behind Garry's go | 45 |
| Confirmation: the comparator's BEAM regeneration | behind Garry's go | 105 |
| Confirmation: joint re-judges (BEAM $89 with the W5 lane, LoCoMo10 $12, LongMemEval-S $6) | behind Garry's go | 107 |
| **Subtotal** | | **633** |
| Reserve | | 17 |

Confirmation cells are sized with reservation headroom, as dev now is. That headroom raises the cell budgets, not the expected spend.

**Open before confirmation: W5 at 0.40 under-fills on BEAM.** On the dev reruns, `combined-v2+w5` delivers a mean of 6,395 tokens on BEAM-100K and 5,516 on BEAM-500K (p95 8,072 and 7,117). Both are outside the delivered-context gate. `combined-v2` on the same stores is inside it. Every counted cell must pass that gate, and a failing cell is reported as failing, not rerun at another setting. So the W5 BEAM lane at ratio 0.40 would very likely fail as preregistered. The dev results addendum reports the figures. The lane's design needs Garry's decision before any confirmation cell runs.

## Dev results at the W5 pin (October 12, 2026)

Dev is finished at pin `fe9e0397b`. It is exploratory: the scores come from each cell's own judge, with no joint re-judge, and they decide nothing counted. Each count is questions correct out of scheduled. Every cell listed is complete with no failures. "Delivered" is the mean and p95 of cl100k tokens inserted into the prompt, and a ✗ marks a cell outside the ±10% delivered-context gate. The cell ids are the final cells. The undersized first attempts are listed in the sizing addendum.

| Arm | LongMemEval-S (100) | LoCoMo10 (322) | BEAM-100K (40) | BEAM-500K (80) | BEAM-1M (80) |
|---|---|---|---|---|---|
| `v2` | 89 · 8,109 / 8,168 | 294 · 7,996 / 8,110 | 28 · 8,088 / 8,241 | 63 · 8,079 / 8,117 | 61 · 8,055 / 8,086 |
| `v2-w5` (ratio 0.40) | — | — | 26 · 6,395 / 8,072 ✗ | 63 · 5,516 / 7,117 ✗ | 62 · 5,731 / 7,813 ✗ |
| `v2-facts-arm` | 84 · 8,108 / 8,166 | 291 · 8,003 / 8,109 | 28 · 8,090 / 8,255 | 59 · 8,078 / 8,112 | 64 · 8,053 / 8,087 |
| `v1` | 84 · 8,129 / 8,163 | 288 · 8,098 / 8,141 | 25 · 8,087 / 8,252 | 58 · 8,077 / 8,111 | 63 · 8,053 / 8,088 |
| `one-call` | 88 · 6,753 / 7,217 ✗ | 290 · 8,811 / 9,541 ✗ | 28 · 6,977 / 7,846 ✗ | 66 · 7,195 / 8,052 ✗ | 64 · 6,934 / 7,826 ✗ |
| `cost-matched` | — | — | 29 · 7,550 / 7,688 | 65 · 7,644 / 7,670 | 64 · 7,802 / 7,836 |
| `filler` | 83 · 8,142 / 8,175 | — | — | — | — |
| `raw` | 89 · 8,051 / 8,097 | 261 · 7,936 / 8,111 | — | — | — |

Cell ids:

- **LongMemEval-S:** `v2` `f02883e4aecc`, `v2-facts-arm` `5a7efee7d191`, `v1` `c0da1a55e3e7`, `one-call` `c193e6a772dd`, `filler` `eef394954ce4`, `raw` `7c5334de0c07`.
- **LoCoMo10:** `v2` `2f62795d5cba`, `v2-facts-arm` `7d060e25504b`, `v1` `e2e5a72d7606`, `one-call` `a9624ac36941`, `raw` `25f128e66c28`.
- **BEAM-100K:** `v2` `8e7808d33768`, `v2-w5` `f43e2ca16da4`, `v2-facts-arm` `4004773b0080`, `v1` `8dc1c0b754ee`, `one-call` `c54dc1722bfb`, `cost-matched` `a66844e70a7a`.
- **BEAM-500K:** `v2` `ad97e7360014`, `v2-w5` `0e927a150ca8`, `v2-facts-arm` `2a61b1906667`, `v1` `02f7bddfc3a7`, `one-call` `7d8b5dd18eac`, `cost-matched` `c7c3eb9581d1`.
- **BEAM-1M:** `v2` `7fd28dd638b5`, `v2-w5` `4c08e5d3af99`, `v2-facts-arm` `8ba7376f9367`, `v1` `781f92c45ca8`, `one-call` `1b400bf5c2f1`, `cost-matched` `067e482cd0e1`.

Each id carries its dataset prefix: `longmemeval-s-`, `locomo-locomo10-` or `beam-<size>-`, then `gbrain-rag-`.

- **W5 at 0.40 under-fills on every BEAM split.** It delivers 5,516 to 6,395 tokens on average. Its correct counts track `v2`: 26 against 28, 63 against 63, and 62 against 61. As the A15 addendum notes, the W5 BEAM lane at this ratio would fail the delivered-context gate as preregistered, and its design waits on Garry's decision.
- **`one-call` misses the delivered-context gate everywhere.** It under-fills on LongMemEval-S and BEAM and over-fills on LoCoMo10. The cause, from the recall packer analysis, is that recall re-counts delivered blocks at four characters per token instead of with delivery's tokenizer, and sizes delivery to the whole budget before the facts take their share. The fix lands after the pin. The dev rows stay as measured at `fe9e0397b`.
- **`v2` against `v1`, in-cell and exploratory:** +5 on LongMemEval-S, +6 on LoCoMo10, +3 on BEAM-100K, +5 on BEAM-500K, −2 on BEAM-1M.

**Spend.**

| Stage | Spend | Cap |
|---|---:|---:|
| `dev-lme` | $8.64 | $12 |
| `dev-locomo` | $29.41 | $39 |
| `dev-beam-100k` | $9.15 | $14 |
| `dev-beam-500k` | $20.51 | $28 |
| `dev-beam-1m` | $21.99 | $34 |
| **Total** | **$89.70** | |

The A15 probe's own spend is reported with A15. Wave-2 spend to date, without A15, is $164.82.

**Custody.** All five dev VMs are destroyed and recorded in each stage's `VMS.md`. The stores are snapshotted to the integrator's primary machine under `wave2/stores/`:

| Store | sha256 |
|---|---|
| `gbrain-longmemeval-s-165df707838f` | `0a136a61…` |
| `gbrain-locomo-locomo10-f974c95acfa8` | `f07919c4…` |
| `gbrain-locomo-locomo10-ce690034b506` (raw) | `629cf5f5…` |
| `gbrain-beam-100k-6824b3680877` | `854adb7d…` |
| `gbrain-beam-500k-8222a93c39c3` | `4cbd1f9d…` |
| `gbrain-beam-1m-5f98c3307942` (4 units) | `890bbd16…` |

The stage ledgers are mirrored with matching SHA-256:

| Ledger | sha256 |
|---|---|
| `dev-lme.sqlite` | `c317dffc…` |
| `dev-locomo.sqlite` | `98556d3b…` |
| `dev-beam-100k.sqlite` | `a2f09a47…` |
| `dev-beam-500k.sqlite` | `4373a588…` |
| `dev-beam-1m.sqlite` | `9ccc9a19…` |

## Garry's go: adaptive W5, a dev re-tune, then confirmation on BEAM and LongMemEval-S (October 12, 2026)

Garry approved the following through GBRA-40; the binding text is in the wave's decisions file. This addendum fixes the re-tune grid, its pick rule and the confirmation plan before the new pin exists and before any of this spend.

**Why W5 changes.** The fixed ratio failed on BEAM dev. At 0.40, `combined-v2+w5` delivered a mean of 6,395, 5,516 and 5,731 tokens on BEAM-100K, BEAM-500K and BEAM-1M, all outside the delivered-context gate. BEAM's exchange-split pages are small, so 0.40 of the page budget leaves too few pages to fill it. The counted W5 gate never ran. The dev results addendum has the full dev table.

**The redesign.** W5 becomes adaptive. Page-unit ranking stops adding candidates once their whole pages would fill the caller's budget times an overfill factor. That replaces the fixed ratio, which was a proxy for the same thing. It is built as `search.page_rank_cut: whole_pages`, with the factor as a second key. The pin addendum records both exact key names, their off values and what `_meta` reports, before any re-tune cell runs. W5 stays off by default until the counted W5 gate passes.

**W3** ships as the shadow grade only (TC2; A15 0 of 542). No W3-on arm runs. The one-call recall fill fix ships on the same build, PR-B.

### Re-tune (exploratory, dev only)

**Pin.** PR-B's head with adaptive W5 and the one-call fix. The pin addendum records the SHA.

**Arms.** These run on LongMemEval-S dev (100 questions) and on BEAM-100K, BEAM-500K and BEAM-1M dev (40, 80 and 80 questions). Every arm is the `combined-v2` lane, the lane the W5 gate reads, and every arm sets the full knob table.

| Arm | W5 |
|---|---|
| `ref` | off (the reference: `v2`, re-run at the new pin) |
| `f1.00` | adaptive, factor 1.00 |
| `f1.25` | adaptive, factor 1.25 |
| `f1.50` | adaptive, factor 1.50 |

That is 16 cells. `ref` is dev's `v2` arm at the new pin.

**Scores.**

- **LongMemEval-S.** One joint blinded re-judge of the four LongMemEval-S cells with the preregistered judge. The score is mean points over the 100 questions. Multi-session is the number correct among the 22 `multi-session` questions without the `_abs` suffix.
- **BEAM.** Each cell's own judge. The BEAM score is the question-weighted mean of `mean_score` over the 200 BEAM dev questions, pooled across the three splits.

**Pick rule, fixed now.** A factor is eligible only if every one of these holds:

1. All four of its cells pass the delivered-context gate: mean and p95 both within 7,200 to 8,800 cl100k tokens. The four are LongMemEval-S, BEAM-100K, BEAM-500K and BEAM-1M.
2. All four of its cells are complete, with no answer, retrieval or judge failures, and the receipt check of the reported cut holds on every row.
3. Its LongMemEval-S score is at least `ref`'s.
4. Its pooled BEAM score is at least `ref`'s.
5. Its LongMemEval-S multi-session count is at least `ref`'s plus 2.

Among eligible factors, the pick is the one with the most LongMemEval-S multi-session correct. Ties go to the higher pooled BEAM score, then the higher LongMemEval-S score, then the smaller factor. The `ref` cells must themselves pass conditions 1 and 2. If one does not, the run is fixed and that cell rerun before the rule is applied. If no factor is eligible, W5 does not run in confirmation and stays off by default, and Garry decides what follows. The pick is recorded here before any confirmation cell runs.

**Stores and cell ids.**

- **Store ids.** A store's id commits to the gbrain build that loaded it, so a new pin gives every store a new id. The dev stores are snapshots from `fe9e0397b`.
- **Reusing the dev stores.** The re-tune reuses them only if `git diff fe9e0397b <pin>` in gbrain touches no ingest, extraction, embedding, schema or migration code. W5 and the one-call fix are read-time only. The pin addendum records that check.
- **How reuse works.** A reusing cell sets `reuse_store` with the store id and the reason (harness: `reuse_store`). The harness reads the snapshot only if its identity differs from this build's in the gbrain pin alone. Every other field must match: dataset, split, ingest revision, ingest config, credentials and harness pins. The reuse and its reason are part of the cell id.
- **Cell ids.** Every re-tune and confirmation cell has a new id, because the pin changed.
- **If the diff touches ingest,** the dev stores are rebuilt at the pin. That adds about $15 and about 4 hours.

**Budget.** The expected actual spend is about $29:

| Item | Expected |
|---|---:|
| Four LongMemEval-S reads | $5.40 |
| Twelve BEAM reads | $22.40 |
| LongMemEval-S re-judge | $1 |

Cell budgets carry reservation headroom: $2 for LongMemEval-S cells, $4 for BEAM-100K and $7 for BEAM-500K and BEAM-1M. The stage caps are $10, $10, $16 and $18, and the re-judge cap is $2.50. That runs about $9 above the decision's $20 estimate. The difference is the BEAM `ref` arm and the three BEAM splits at dev cost, and it comes out of the reserve below.

### Confirmation (counted), BEAM and LongMemEval-S

**Data.** BEAM non-dev, 72 conversations and 1,440 questions. LongMemEval-S, the 400 questions outside the dev subset. LoCoMo10 confirmation is not in this go, so gate 2's LoCoMo10 test and gate 3's LoCoMo10 report are recorded as not run.

| Lane | Datasets | Role |
|---|---|---|
| `combined-v2` | BEAM, LongMemEval-S | counted |
| `combined-v1@pin` | BEAM, LongMemEval-S | counted reference, gate 2 |
| `raw@pin` | LongMemEval-S | counted reference, gate 1 |
| `combined-v2+w5`, at the picked factor | BEAM | counted, W5 gate; dropped if no factor is eligible |
| `recall-one-call`, at the fixed build | LongMemEval-S | descriptive, decides nothing |
| The comparator, regenerated | BEAM | counted, gate 3 |

**Gates.**

| Gate | Result |
|---|---|
| 1 | LongMemEval-S, `combined-v2` against `raw@pin` |
| 2 | BEAM pooled, `combined-v2` against `combined-v1@pin` at 2 points |
| 3 | BEAM pooled, against the comparator at 3.5 points. LongMemEval-S is reported against the comparator's wave-1 answers in the joint re-judge |
| W5 | BEAM pooled, as preregistered in the re-scope addendum. A pass flips the default on, at the picked factor |
| 4 | Recorded as failed (A15) |
| 5 | Cost |

Every counted cell must pass the delivered-context gate, and a failing cell is reported as failing.

**Budget inside the remaining $485.**

| Line | Expected USD |
|---|---:|
| Re-tune: 16 cells and the LongMemEval-S re-judge | 29 |
| LongMemEval-S: ingest (about $38), `combined-v1@pin`, `combined-v2`, `recall-one-call`, `raw@pin` with its own store | 62 |
| BEAM non-dev: ingest (about $30), `combined-v1@pin`, `combined-v2`, `combined-v2+w5`, about $40 per lane | 151 |
| The comparator's BEAM regeneration | 105 |
| BEAM joint re-judge: `combined-v1@pin`, `combined-v2`, `combined-v2+w5`, the comparator | 89 |
| LongMemEval-S joint re-judge: four gbrain lanes and the comparator's wave-1 answers | 7 |
| **Subtotal** | **443** |
| Reserve | 42 |

`recall-one-call` on BEAM would cost about $62 more with its re-judge share. That doesn't fit with a reserve, so it runs on LongMemEval-S only. Confirmation cells carry reservation headroom like dev's: each stage cap is its expected spend plus the largest cell budget. A stage that would need more than its line stops and reports. Ledgers are mirrored to the integrator's primary machine after each cell.

## Adaptive W5 pin, keys, receipt check and store reuse (October 12, 2026)

This addendum is written before any re-tune cell runs.

**Pin.** The re-tune and confirmation run at gbrain `71b6d85bce8bf80aacec2dffe96e29cf0202c8d2` on PR-B (#6445). It descends from the dev pin `fe9e0397b`, and the five commits between them are:

- `3acce16c4`: a test entry for the fixed-ratio key;
- `8a1810008` and `8ab065eee`: the one-call recall fill fix and its behavior note;
- `7c206f0ca` and `1f0223694`: reverts of the W3 gate-4 latency runner and of W3 stage 2;
- `71b6d85bc`: adaptive W5.

Cells pin this SHA, not the branch head. Every cell runs with `GBRAIN_SHA` set to it, and the pin does not change mid-run.

**Keys.** `search.page_rank_cut` is `off` or `whole_pages`. Unset, empty and every other value read as off; the specs write `off`. `search.page_rank_cut_factor` sets the overfill factor. It is read only under `whole_pages`, and a value that is unset or not a positive finite number reads as `1.0`. Both keys are registered in `KNOWN_CONFIG_KEYS` and read in `src/core/search/page-rank-cut.ts`. The fixed-ratio key `search.page_rank_budget_ratio` is gone from this build.

**Behavior.** The cut engages only on page-unit calls that carry a caller budget: `query`, `search` and recall's page arm. On those calls ranking lifts the mode's chunk-token cut (`search.tokenBudget`) and returns its full limit. Delivery then makes the cut with its own page sizes. It keeps rank-order pages while their whole delivered cost (text, title, date header) fits `target = max(1, floor(factor × budget))`, where the budget is the caller budget after any remote clamp and less any saved-fact rows. The page that crosses the target stays only if its allocation floor still fits what the earlier pages leave of the budget. Rank one always stays.

**Report.** `page_rank_cut {mode, factor, caller_budget, target, applied_cost, candidates, kept}`. It sits in `_meta.retrieval.delivery` on `query` and `search` and in `delivery` on `recall`, and it is absent when the cut is off.

**Receipt check.** The provider (`_check_page_rank_cut`, `eval/harness-provider/mpw/gbrain_provider.py`) checks every row before keeping it:

- With the cut off, any reported `page_rank_cut` fails the row.
- With `whole_pages` on a page-unit call that has a budget, a missing cut fails the row. So do any of these:
  - `mode` is not `whole_pages`;
  - `factor` is not the arm's factor, resolved as gbrain resolves it;
  - `caller_budget` differs from the call's `token_budget`, or is above recall's `budget_tokens` (recall packs its facts first, and a remote clamp also lowers the budget);
  - `target` is above `floor(factor × caller_budget)`;
  - `kept` is above `candidates`.
- A spec that still carries `search.page_rank_budget_ratio` fails every row, because this build ignores that key and the arm would run with no cut.

The one-call recall path is now checked as well. The checked object is kept in each row's metadata as `page_rank_cut`.

**Smoke at the pin.** A local run through the wave-2 provider used the stub upstream with a budget of 1,500. It covered the `filler-removed`, `combined-v2` and `recall-one-call` lanes. With the cut off, each lane reported no cut. With `whole_pages`, each lane reported `{mode whole_pages, factor 1, caller_budget 1500, target 1500}` at the default factor and `{factor 1.25, target 1875}` at 1.25. All 9 lane-and-arm pairs passed the check. gbrain's own `test/config-search-registry.test.ts` and `test/search/page-rank-cut.test.ts` pass at the pin: 16 tests. The provider suites pass against the pin: `test_gbrain_facts`, `test_gbrain_provider`, `test_page_rank_cut` and `test_mpw2_dev_specs`.

`test_facts_extraction_and_lanes` is flaky under the stub, at the dev pin and at this pin alike. The stub returns the same fact for every extraction window, so the window that inserts first owns the fact and the others count as duplicates. The fact's source page then varies from run to run (d-a0, d-a1 and d-a2 were all seen at both pins), and the test's `d-a1` lookup fails when it lands elsewhere. This is a test-fixture race. It does not affect what the receipt check measures.

**Ingest diff.** `git diff fe9e0397b 71b6d85b` changes 25 files outside tests and docs.

- `src/core/search/*`: delivery, ranking, the cut, the rerank gate, the mode and the telemetry.
- `src/core/ops/search.ts` and `src/commands/search.ts`.
- `src/core/ops/facts.ts`: only the `recall` op and its packing.
- `src/core/config.ts`: the key registry.
- `src/core/types.ts`: a removed meta field.
- `src/core/behavior-change-notice.ts`.
- `src/eval/rerank-gate-latency.ts` and `scripts/`: the removed runner and size baselines.

No file under import, extraction, embedding, chunking, sync, schema or migration code changes, and no migration is added. The diff is read-time only, so **the dev stores are reused**.

**Store reuse.** Each re-tune cell sets `reuse_store` to its group's dev store:

- `gbrain-longmemeval-s-165df707838f`;
- `gbrain-beam-100k-6824b3680877`;
- `gbrain-beam-500k-8222a93c39c3`;
- `gbrain-beam-1m-5f98c3307942`.

The cell reads the store's mirrored snapshot, which is restored onto its VM. The store ids built at this pin would be `401ed80f84ff`, `8cb8837fc59e`, `6f436863f40b` and `8e8247cbea63`. Against each snapshot's `store.json`, all 16 specs resolve through `reusedStoreIdentity`: the identities differ in `pins.gbrain` alone. The harness pins, ingest revision `gbrain-ingest-2`, ingest config and credentials are all unchanged. A cell whose store did not resolve would fail before ingesting, rather than re-ingest.

**Specs.** The 16 re-tune specs are in `eval/harness-provider/cells/mpw2/retune/`, written by `mpw2-retune-specs.py`. Each one is dev's `v2` spec for its group with two changes. First, W5's keys replace the fixed-ratio key: `ref` sets `search.page_rank_cut: off`, and `f1.00`, `f1.25` and `f1.50` set `whole_pages` with factor `1`, `1.25` and `1.5`. Second, each spec sets `reuse_store` and the go addendum's cell budget. `tests/test_mpw2_dev_specs.py` checks that every re-tune spec is otherwise identical to its dev `v2` spec. The dev and W5 tuning specs stay as they ran at `fe9e0397b`.

## Confirmation specs (October 12, 2026)

This addendum is written before any confirmation cell runs. `eval/harness-provider/mpw2-confirm-specs.py` writes the specs to `cells/mpw2/confirm/`. Every gbrain arm is its dev spec at the adaptive W5 pin, with the re-tune's knob table and `search.page_rank_cut: off`. `combined-v2+w5` (`v2-w5`) is the exception: it runs `whole_pages` at the re-tune's picked factor. Its specs are written only once the pick is recorded, and none are written if no factor is eligible. `tests/test_mpw2_dev_specs.py` checks three things: that every arm matches its dev spec apart from W5's keys and the data; that LongMemEval-S covers the 400 non-dev questions once; and that BEAM covers the 16, 28 and 28 non-dev conversations once, none of them in wave 2's dev units.

**Groups.** Each group runs on one VM with one ledger, and its first cell builds the store that the group's other gbrain cells share. `raw` builds a store of its own.

| Group | Data | Arms, in order |
|---|---|---|
| `lme-1` to `lme-4` | LongMemEval-S, wave 1's four shards of 100 histories (the comparator's wave-1 400 questions, in order) | `v2`, `v1`, `one-call`, `raw` |
| `beam-100k` | BEAM-100K non-dev, 16 conversations | `v2`, `v1`, then `v2-w5` |
| `beam-500k-1`, `beam-500k-2` | BEAM-500K non-dev, 14 conversations each | `v2`, `v1`, then `v2-w5` |
| `beam-1m-1`, `beam-1m-2` | BEAM-1M non-dev, 14 conversations each | `v2`, `v1`, then `v2-w5` |
| `comparator-beam-*` | The same five BEAM groups, from `mpw-sealed-specs.py`'s comparator spec (facts plus chunks at its dev-fitted knobs) | `comparator` |

The groups split the larger datasets so ingest runs in parallel. Each LongMemEval-S history is its own brain and each BEAM conversation is its own unit, so the split changes what no question sees. The pooled scores concatenate the groups. BEAM cells use seal `sealed`, so BEAM-100K and BEAM-1M publish aggregates only. LongMemEval-S cells use `public`, as in wave 1.

**Budgets.** Cell budgets are expected spend plus reservation headroom. The first gbrain cell of each store pays its ingest.

| Group kind | `v2` | `v1` | `v2-w5` | `one-call` | `raw` | Comparator | Expected per group |
|---|---:|---:|---:|---:|---:|---:|---:|
| LongMemEval-S shard | $18 | $6 | | $6 | $8 | | $15.50 |
| BEAM-100K | $16 | $15 | $15 | | | $20 | $25, comparator $8 |
| BEAM-500K, per 14 | $20 | $14 | $14 | | | $35 | $27, comparator $17 |
| BEAM-1M, per 14 | $24 | $15 | $15 | | | $55 | $32.50, comparator $34 |

The expected totals are:

- LongMemEval-S, $62;
- gbrain BEAM, $144 with `v2-w5`;
- the comparator's BEAM regeneration, about $108 (the harness's own estimate is $100).

These match the go addendum's lines. Each stage cap is its expected spend plus its largest cell budget, as the go addendum sets. Those caps add up to more than the confirmation budget, so the run script also keeps a running total across confirmation ledgers. A cell starts only if the confirmation spend so far plus that cell's budget stays within $485 less the re-tune's actual spend.

## Adaptive W5 re-tune result: no factor is eligible (October 12, 2026)

All 16 re-tune cells ran at gbrain `71b6d85` on the dev stores through `reuse_store`, and all 16 pass every in-cell gate. Every row of the three factor arms carries a checked `page_rank_cut`, and no `ref` row carries one. Both `ref` cells' groups pass conditions 1 and 2, so the rule applies as written.

| Arm | LongMemEval-S points | Multi-session (of 22) | BEAM-100K | BEAM-500K | BEAM-1M | BEAM pooled (200) | Delivered context, LongMemEval-S / BEAM, mean range |
|---|---:|---:|---:|---:|---:|---:|---|
| `ref` (W5 off) | 89.0 | 16 | 63.29 | 73.12 | 70.84 | 70.24 | 8,108 / 8,054–8,088 |
| `f1.00` | 92.0 | 17 | 71.85 | 76.58 | 72.27 | 73.91 | 7,922 / 7,777–7,870 |
| `f1.25` | 91.0 | 17 | 71.08 | 77.15 | 71.50 | 73.68 | 7,947 / 7,979–8,029 |
| `f1.50` | 92.0 | 17 | 68.10 | 76.59 | 75.36 | 74.40 | 7,982 / 8,005–8,047 |

LongMemEval-S scores come from the joint blinded re-judge of the four cells. BEAM scores are each cell's own `mean_score`, times 100. Every p95 lies between 8,013 and 8,241.

**Rule.** Each factor passes conditions 1 to 4: delivered context, completeness with the cut checked, LongMemEval-S at least `ref`, and pooled BEAM at least `ref`. Each fails condition 5, because its multi-session count of 17 is below `ref`'s 16 plus 2. **No factor is eligible.** As the go addendum fixes, W5 does not run in confirmation, it stays off by default, and Garry decides what follows. No `v2-w5` confirmation spec is written.

**Descriptive, decides nothing.** All three factors score above `ref` on LongMemEval-S (+2 to +3 points) and on pooled BEAM (+3.4 to +4.2 points). The LongMemEval-S gain is in temporal reasoning (26 against 24) and one multi-session question. The adaptive cut fills the budget on BEAM's small pages, where the fixed 0.40 ratio left a mean of 5,516 to 6,395 tokens. These are dev numbers on 100 and 200 questions, not a gate.

**Run notes.**

- The runner script was edited while three groups' watchers were running. Bash reads a script as it runs, so those watchers stopped with a syntax error. They were `beam-100k` `f1.00`, `beam-500k` `f1.00` and `beam-1m` `ref`. Their cells kept running on their VMs and finished, but each group's next arm started while the previous cell was still finishing. The three cells were collected afterwards, unchanged, and all pass every gate. The LongMemEval-S watcher, also started before the edit, was stopped by hand, and its four cells ran in order.
- The comparator's keyless smoke (`confirm-smoke/`, BEAM-100K dev conversation 3, the stub upstream) installed the pinned release and ran ingest, retrieval, answers and judging. The first run had a budget of $1, which left the proxy's reservations too little room, so two answers were refused. The rerun at $10 of stub budget completed all 20 questions with no failure. Its delivered context, 11,717 tokens, comes from the stub: the stub returns the same fact for every extraction, and each copy renders with its own chunk quote. At these knobs the comparator delivered 7,560 / 8,401 on BEAM-100K in wave 1. So the comparator's BEAM-100K cell runs first, and its delivered-context gate is read before the BEAM-500K and BEAM-1M comparator cells start.

**Receipts and spend.** Receipts are in `2026-10-10-memory-proof-wave-2/retune-{lme,beam-100k,beam-500k,beam-1m}/`, with the re-judge in `retune-lme/rejudge/` (its `analysis.json` holds the rule's output). Ledgers are mirrored to the integrator's primary machine with matching SHA-256:

| Ledger | SHA-256 |
|---|---|
| `retune-lme` | `ddb822d6…` |
| `retune-beam-100k` | `a1266e1c…` |
| `retune-beam-500k` | `354832c1…` |
| `retune-beam-1m` | `f6e3c778…` |
| `retune-rejudge` | `4ef8301e…` |

The re-tune cost $27.44 for the 16 cells and $1.05 for the re-judge, $28.49 in all against the $29 line. That leaves $456.51 of the $485 for confirmation. The four VMs and the smoke VM are destroyed and recorded.

## Amendment after the re-tune: W5 confirms at factor 1.50 (October 12, 2026)

**The rule changed after the results were seen.** This amendment came after the dev re-tune results were seen, so it is a post-hoc change to the preregistered eligibility rule, not part of it. Garry approved it through GBRA-40 on October 12, 2026; the binding text is in the wave's decisions file.

**What happened.** Under the go addendum's rule, every factor passed conditions 1 to 4. Each missed condition 5, LongMemEval-S multi-session at least `ref` plus 2, by exactly one question: 17 correct against the 18 required (`ref` had 16). No factor was eligible, and the rule sent W5 to Garry ([re-tune result](#adaptive-w5-re-tune-result-no-factor-is-eligible-october-12-2026)).

**The choice.** W5 runs in confirmation at factor 1.50. That is the rule's own tie-break pick: the three factors tie on multi-session at 17, and 1.50 has the highest pooled BEAM score (74.40, against 73.91 and 73.68). Condition 5 is set aside for this one pick. Nothing else about the rule or the gates changes.

**What it governs.** BEAM non-dev confirmation adds `combined-v2+w5` (`v2-w5`) as the last arm of each BEAM group. It is dev's `v2` spec with `search.page_rank_cut: whole_pages` and `search.page_rank_cut_factor: 1.5`, at gbrain `71b6d85bce8bf80aacec2dffe96e29cf0202c8d2`, reading its group's store. The cell budgets are $15 for BEAM-100K, $14 per BEAM-500K group and $15 per BEAM-1M group, as the confirmation specs addendum set. The W5 gate reads BEAM pooled, as preregistered in the re-scope addendum. A pass flips the default on at factor 1.50. If W5 fails, it ships off. Because the rule was changed after the results were seen, the W5 gate's result is reported with this amendment beside it.

**Budget.** The confirmation expectation is about $442, which includes `v2-w5`'s roughly $43 and the BEAM joint re-judge with the W5 lane. The run script's guard holds total confirmation spend, plus the budget of each cell before it starts, within the $456.51 that remains after the re-tune.

## The comparator's BEAM-100K cell runs a second time (October 12, 2026)

Auto-approved under Garry's standing rule, 2026-10-12.

**What happened.** The joint BEAM re-judge reads every lane's per-question answers. BEAM-100K and BEAM-1M non-dev cells publish aggregates only, so their answers have to come from the operator's custody copy. The runner gained that copy step (commit `4d3b19e1`) after the comparator's BEAM-100K cell (`beam-100k-comparator-rag-e02a541ef80d`) had started. That cell finished at 21:12 UTC. It passed every gate, delivering a mean of 7,525 tokens with a p95 of 8,320. Its VM was then destroyed, and its per-question answers went with it. Its aggregates stay published as measured. They can't enter the joint re-judge.

Of the gbrain cells that started before the change, the three BEAM-100K and BEAM-1M `v2` cells were copied by hand from their VMs, which outlive their first cell.

**The choice.** The comparator's BEAM-100K group runs once more, as `comparator-beam-100k-r2`. It uses the same spec with a $21 budget, which gives it a new cell id. The joint BEAM-100K re-judge uses this second cell whatever its result, and both cells' in-cell scores are reported. The expected cost is about $11, inside the $456.51.

## Confirmation results (October 13, 2026)

Every counted cell ran at gbrain `71b6d85bce8bf80aacec2dffe96e29cf0202c8d2`, and every one passes the delivered-context gate. The scores come from one joint blinded re-judge per group: four LongMemEval-S shards and five BEAM groups. The [results page](2026-10-13-memory-proof-wave-2-results.md) has the full tables. The gate output is in `2026-10-10-memory-proof-wave-2/confirm-analysis/gates.json` (`eval/runner/memory-proof-wave-2-confirm-analysis.ts`), and the cost output is in `confirm-analysis/cost.json`.

| Gate | Result |
|---|---|
| 1, LongMemEval-S (400) | **Pass.** `combined-v2` beats `combined-v1@pin`, +14.00 points with a one-sided 95% lower bound of +10.96. It is non-inferior to `raw@pin`: +2.75, lower bound −0.87 against the −2 margin. |
| 2, BEAM pooled (1,440 questions, 72 conversations) | **Pass, ahead.** `combined-v2` − `combined-v1@pin` is +1.62, with bounds +0.49 to +2.79 and a 2-point margin. |
| 3, BEAM pooled against the comparator | **Pass, ahead.** +3.97, with bounds +2.63 to +5.33 and a 3.5-point margin. On LongMemEval-S, against the comparator's wave-1 answers, `combined-v2` is −3.25 (one-sided lower bound −6.97). That comparator cell missed its delivered-context gate in wave 1, with a p95 of 9,373. This row is reported and decides nothing. |
| W5, BEAM pooled | **Pass.** `combined-v2+w5` (factor 1.50) − `combined-v2` is −0.25, with bounds −1.00 to +0.49, so the lower bound clears −3. No TC6 kind's two-sided 95% interval lies entirely below −3. The upper bounds are +3.28 for multi-session, +2.09 contradiction, +3.25 temporal, +1.49 event ordering and +6.20 abstention. Multi-session is −0.12. **The default flips on at factor 1.50.** That factor was chosen under the amendment after the re-tune, which set condition 5 aside. |
| 4 | Recorded as failed (A15). |
| 5, cost | Cost per correct answer, gbrain ÷ comparator: 0.750 at R = 20 (95% interval 0.727 to 0.773), so the cost claim holds. At R = 1 it is 0.664 (0.646 to 0.683), and at R = 200 it is 0.896 (0.863 to 0.930). |

**Cost notes.** Gate 5 uses wave 1's formula and tool (`mpw_tools/sealed_cost.py`), with strata merged by BEAM size and the bootstrap seed `20261010`. gbrain's read cost is $23.03, of which $21.22 is the answer model, $1.81 rerank, and under $0.01 query embedding. The comparator's read cost is the answer model alone, $22.95. Receipts don't carry request bodies, so the tool can't tell query embeddings from ingest embeddings. They are counted as ingest. That moves under $0.01 of the $57 total, and inside the question phase there are no other read-time requests.

**Descriptive.**

- `recall-one-call` scores 83.00 on LongMemEval-S, against 82.50 for `combined-v2` (+0.50, lower bound −0.70). With the fill fix it now passes the delivered-context gate at every shard: means 8,163 to 8,170, p95 at most 8,223.
- One `combined-v1@pin` row (`lme-4`) is an answer failure: the answer model returned an unparseable response after six retries. It is scored 0 as preregistered.
- LoCoMo10 confirmation was not run, as the go decided. Gate 2's LoCoMo10 test and gate 3's LoCoMo10 report are recorded as not run.

**Run notes.**

- The run operation reached its six-hour limit while `lme-1`'s and `lme-2`'s `raw` cells were finishing. Their cells were collected unchanged by `confirm-recover.sh`.
- Four BEAM re-judges reached their two-hour limit. They resumed from their judge caches inside the same ledgers. Each of those ledgers keeps an open reservation of about $0.59 from the stopped run, which was never spent.

**Spend.** Confirmation cost $398.04: $316.69 for cells and $81.35 for the re-judges, with $2.37 of reservations never spent. That is inside the $456.51. Wave 2's spend is $591.35 in total, before A15's own spend.

**Custody and VMs.**

- Every ledger is mirrored to the integrator's primary machine under `mpw-ledgers/wave2/confirm/`, along with the BEAM-100K and BEAM-1M custody copies, those groups' re-judge outputs and the analysis. All 43 files' SHA-256 values match. BEAM-100K and BEAM-1M publish aggregates only.
- All 20 VMs of the re-tune, the smoke and the confirmation are destroyed and recorded in their stages' `VMS.md`, and none of the owner's VMs remain.

## Main merged after confirmation (October 13, 2026)

`main` was merged into this branch after every confirmation cell and re-judge had finished.

- **Ids.** The merge moves `package.json`'s declared gbrain pin to `77cf8e111`. Every cell id and store id records that pin under `pins.gbrain.declared_pin`, so re-planning any wave-2 spec on the merged tree gives new ids. The published cells keep the ids they ran under, and each receipt records its harness commit.
- **Flaky test fixed.** The merge brings #130's deterministic extraction order for `test_facts_extraction_and_lanes`. That fixes the stub race noted in the adaptive W5 pin addendum.
- **No measured row changes.**
