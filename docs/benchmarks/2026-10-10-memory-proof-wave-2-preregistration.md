# Memory proof wave 2: preregistration, 2026-10-10

This file fixes memory proof wave 2's rules before any counted cell runs. It covers the claim, the builds and lanes, the data and its reuse, the gates and statistics, the models, custody, the budget stages and the runbook. Step 0 is exploratory and decides scope only, so it may run before this file is committed; every other cell waits for it. A change after commit is an amendment, written here with its date and reason before any cell it affects runs.

Wave 1 measured gbrain against an extract-first memory server, the comparator: a memory-bank server with background extraction and reflection ([sealed results](2026-10-09-memory-proof-wave-sealed-results.md)). On LongMemEval-S, gbrain's combined lane trailed gbrain's own pages-only lane by 10.5 points. The likely cause is the facts block the harness packs ahead of the pages: `recall` without an entity, session or `since` returns the newest facts, not the ones that answer the question. Wave 2 tests question-ranked `recall` (W1) as the fix, checks that it costs nothing on BEAM and LoCoMo10, and measures whether a confidence gate can skip the reranker (W3). It also moves the counted extractor to the one gbrain ships by default.

## Decisions this file records

Garry decided these on 2026-10-10. They override the reviewed plan where the two conflict.

| # | Decision |
|---|---|
| UC1 | W2, the adaptive facts share in `query`, is cut. Its lane, key and gate are gone. The facts arm and the temporal fact reserve stay as they are. |
| UC2 | The counted extractor is gbrain's measured default: `extraction_model` unset, which resolves to `anthropic:claude-haiku-5-5` (receipt source `measured default`). `openai:gpt-6-luna`, wave 1's extractor, is a descriptive row. |
| UC3 | BEAM gates 2 and 3 are the confirmatory pair. LongMemEval-S gate 1 is secondary: a tuned-on row, disclosed as such. |
| TC2 | If the shadow probe fails its floor, W3 ships as the shadow grade only. |
| TC3 | The counted lane is the two-call, harness-packed read: the agent calls `recall(question)`, then `query`. |
| TC4 | The cap is $650, released in stages. |
| TC5 | BEAM confirmation uses all 72 non-dev conversations. |
| TC6 | The per-kind release floor for the rerank gate is −3 points. |
| TC7 | An agent that passes `query` without `question` gets a `recall_hint` notice. |
| TC8 | W1's code, CLI and docs ship first in their own PR (PR-A). The `question` guidance and W3 stage 2 ship later in PR-B, after the gates. |
| Custody | "Just do it in cloud don't worry about my mac." Private rows stay on cloud machines and are mirrored after every cell to the integrator's primary machine. No step waits on Garry's Mac. |

## GBRA-49's ruling, verbatim

GBRA-49 holds the BEAM sealed lists for the program. Its ruling on wave 2's use of them, 2026-10-10, as received:

> 1. Reopening: yes. Wave 2 may ingest, answer and judge the 54 P0-sealed BEAM-100K, 500K and 1M conversations for both gbrain and the comparator. These conversations are no longer held out from gbrain's development. P4's gates used BEAM-500K sealed and the BEAM-100K preference and instruction questions. Q2's junk audit used 21 BEAM-1M sealed conversations. Q1's preregistration records that the proof wave's groups cover every BEAM 100K/500K/1M conversation and that its sealed run set gbrain defaults. So wave 2's BEAM rows on them are regression and descriptive evidence, not held-out confirmation, which is the same status the 18-conversation fallback would have. Reopening adds power. It doesn't add held-out status, and the preregistration must say so.
> 2. Per-question rows:
>    - BEAM-500K: you may release them now. P4 E1's decision is recorded and Q1 doesn't use 500K.
>    - BEAM-100K and BEAM-1M: keep them aggregates-only in git and docs until Q1's sealed waves S2a (all 14 BEAM-100K sealed) and S2b (all 24 BEAM-1M sealed) have run. They're frozen and still waiting on the owner's machine. After that, you may release them, and Q1 publishes its own S2b rows under D2 at the same point.
>    - In every case, never put sealed text or rows on Capy Drive. BEAM-10M stays untouched, as you said.
> 3. P4 reservations: none are still active. Both P4 decisions they served are recorded on gbrain-evals main: the pressure gate (E1, BEAM-500K sealed) passed and the core-memory gate (BEAM-100K preference and instruction) failed, in v0.10.32 (e43fdd5e), with the core-gate remainder in v0.10.35. So those reservations are spent.
>
> If wave 2 needs a genuinely held-out confirmation, the program holds a freshly minted reserve set (D8) in owner custody. Using it needs a separate request routed through me, and the owner's approval.

**Not held-out.** Every BEAM row in this wave is regression and descriptive evidence on reused data. No wave-2 result is held-out confirmation. In this wave, "confirmatory" means a gate preregistered here and evaluated on reused data, disclosed as reused. The D8 reserve is not part of this wave.

## The claim

The counted claim is about one read: **an agent calls `recall(question)`, then `query`, and the harness packs both under one delivered-context total** (TC3, label "harness-packed"). gbrain's single-call packing inside `recall` is measured on dev only (lane `recall-one-call`) and is not the counted claim. Whatever the gates find, W1's code ships, because it fixes a user-visible recency bug. The agent guidance that tells agents to pass `question` ships only if gate 2 holds on the pinned build; otherwise the skill and guide recommendations are removed before merge and the parameter keeps a neutral description. No public efficacy claim goes beyond the gates that pass.

## Builds

- **Step 0** runs on gbrain#6066's head at the time it runs, `59782b95912abb7fe174e3d251d650a3aac15154`, because W1 does not exist yet. It needs only harness packing and `search.mode`.
- **Dev** runs on the head of the W1 PR (PR-A, stacked on #6066's branch `capy/mpw-integration`), recorded per cell.
- **Counted cells** run on one measured gbrain SHA, the head of PR-B, recorded here in an amendment after the stage-2 decision and before any counted cell. If master is merged into the PR after the counted cells, the merged build gets the wave-1 equivalence replay: a same-build noise baseline, then re-answering only the changed contexts. Its score must stay within the noise baseline and gate 2's margin, or the release waits. The PR merges only after gates 2 and 3 have been read on the pinned build.
- **Harness.** The public agent-memory benchmark harness at `f618ed7b1f0eb9cad7b42e876f91a42f0eadb150`, wrapped as in wave 1. The wave-2 wrapper is gbrain-evals `capy/memory-proof-wave-2`; each cell's `cell.json` records its prompt, scorer and wrapper revisions.
- **Comparator.** Its pinned release 0.10.2 ([`comparator.lock.json`](../../eval/harness-provider/comparator.lock.json)), in its best supported mode (extracted facts plus raw chunks) with the dev-fitted knobs from the [wave-1 preregistration](2026-10-05-memory-proof-wave-preregistration.md). Its BEAM per-question rows and sealed specs were lost on 2026-10-09, so its BEAM non-dev cells are regenerated from the pushed generator `mpw-sealed-specs.py`, with new cell ids. Its LongMemEval-S and LoCoMo10 answers are reused from the wave-1 matched receipts in the joint re-judges.

## Lanes

Each dataset has one gbrain ingest store per extractor. A lane changes only read-time behavior, so every gbrain lane on a dataset reads the same store.

| Lane | Read | Datasets | Role |
|---|---|---|---|
| `combined-v2` | `recall(question, limit: 100)` packed first, the block capped at the dataset's wave-1 `facts_tokens` (1,800 on LongMemEval-S and LoCoMo10, 600 on BEAM). Then `query` with `token_budget` = 8,100 minus the block. Facts-arm rows in `query` that repeat a block fact are dropped and not refilled. `saved_facts` are not used. | all | counted |
| `combined-v1@pin` | Wave-1 packing on the pinned build: `query`, then the newest `recall` facts, at the dataset's wave-1 `facts_tokens` and `token_budget` | all | counted reference |
| `raw@pin` | Pages only, its own store with no extraction, `conservative` mode (no chat key), `token_budget` 8,100 | LongMemEval-S, LoCoMo10 | counted reference for gate 1 |
| `filler-removed@pin` | Step 0's arm (b): the combined store's page query with no facts block, `token_budget` 8,100 | LongMemEval-S | counted reference: separates question ranking from returned page space |
| `combined-v2+gate` | `combined-v2` with `search.reranker.gate: on` | BEAM | counted only if W3 stage 2 is built (A15) |
| `filler-removed`, `recall-one-call`, `cost-matched` | Arm (b) on dev; gbrain's one-call `recall(question=q, query=q, limit=100, budget_tokens=8100, budget_policy="facts_first", return_unit="page")`; `combined-v2` at the comparator's mean delivered total (about 7,700 tokens) | dev only | decision lanes, not counted |

Packing rules for every facts lane:

- The facts block is priced on its rendered text, as the answer prompt shows it: each group's date and `Saved facts:` headers and its `## Memory N` wrapper. Wave 1 counted only the fact lines. So `combined-v1@pin` is "wave-1 packing with rendered counting".
- The receipt records the block's tokens, the page budget, the page-side facts-arm rows and their tokens, the dropped repeats, `facts_order`, `facts_degraded`, and the total recomputed on the final rendered context.
- A `recall` that returns `facts_order` other than `relevance`, any `facts_degraded`, or `unavailable` fails the row. The harness never packs a zero-fact block in its place.
- `combined-v2+gate` runs as a retrieval-only replay of `combined-v2`'s store with a config override. A same-build, same-config replay runs first as the noise baseline. Only changed contexts are re-answered and re-judged. A replay row classed `failed` or `no_baseline` fails qualification until it is resolved, and only `same` rows keep the baseline answer.

### The extractor

The counted stores use gbrain's measured default (UC2). The cell sets `extraction_source: "measured_default"` and leaves `extraction_model` unset. Its `gbrain_credentials` are `voyage` and `anthropic`, with no OpenAI key. Before any ingest spend, the harness asserts that `gbrain models --json` reports `source: "measured default"` and `resolved: "anthropic:claude-haiku-5-5"` for `facts.extraction_model`. A unit that writes no facts fails. `extraction_source` is an ingest key, so a measured-default store can never share an identity with a raw store or an explicit-model store.

`openai:gpt-6-luna` is the descriptive continuity row. It is `combined-v1@pin` on a gpt-6-luna store, on the dev sets, beside the wave-1 receipts. It decides nothing.

## Data and its reuse

**Dev (tuning allowed)**

- LongMemEval-S dev: the 100 questions of wave 1's dev subset.
- LoCoMo10 dev: wave 1's 2 dev conversations, `conv-42` and `conv-44` (322 questions).
- BEAM dev: wave 1's dev conversations minus the 8 that GBRA-49's P0 and Q2 work holds (100k 12 and 15; 500k 8, 9 and 35; 1M 1, 6 and 26). That leaves 10 conversations and 200 questions: 100k {3, 11}, 500k {12, 21, 28, 31}, 1M {16, 21, 22, 25}.
- Dev stores are rebuilt, because wave 1's were lost.

**Confirmation (no tuning)**

- **BEAM non-dev, 72 conversations (16 / 28 / 28; 1,440 questions).** This is the confirmatory data for gates 2 and 3, and it is reused:
  - It holds wave 1's 18 validation conversations, which informed wave-1 decisions, and its 54 sealed conversations, which set gbrain's wave-1 defaults.
  - Wave 1's split is unrecoverable (custody was lost on 2026-10-09), so wave 2 pools all non-dev conversations.
  - 54 of the 72 are on P0's sealed lists. GBRA-49's ruling above reopens them as regression and descriptive evidence.
  - P4 used BEAM-500K sealed and the BEAM-100K preference and instruction questions, and Q2's junk audit used 21 BEAM-1M sealed conversations.
- **LongMemEval-S, the 400 questions outside the dev subset.** `eval/decisions/splits/lme-s.json` marks all 500 questions as dev, because gbrain's release configuration was chosen on them. Wave 1 also diagnosed the facts-block gap on this aggregate, and its post hoc `facts_tokens=0` check ran on 100 of these questions. Gate 1 on this set is a tuned-on, secondary row.
- **LoCoMo10, the 8 conversations outside the dev subset (1,218 questions, 8 clusters).** Wave 1 reported only aggregates here and tuned nothing on them. A 2-point non-inferiority test on 8 clusters is likely inconclusive, and an inconclusive LoCoMo10 result is recorded as descriptive.

**Excluded.** The 8 BEAM dev conversations named above, from every wave-2 cell. BEAM-10M is never opened. PersonaMem 32k and LifeBench stay unopened for a later wave.

## Gates

Scores are graded accuracy per question, from 0 to 1, times 100 in points. Every gate compares lanes on the same questions with one joint blinded re-judge per dataset. That re-judge covers every wave-2 lane, the same-build references and the comparator.

1. **LongMemEval-S, secondary (UC3), tuned-on.**
   - Claim: `combined-v2` beats `combined-v1@pin`, and is non-inferior to `raw@pin` at a 2-point margin.
   - Statistic: each history is its own brain, so questions are the independent unit. The paired difference has a one-sided 95% bound from a paired bootstrap-t over questions, 9,999 draws, seed `20261010`. "Beats" means the lower bound is above 0. Non-inferior means the lower bound is above −2.
   - Breakdown: `combined-v2` against `filler-removed@pin` is reported as the ranking effect, with the same statistic, and decides nothing.
2. **No regression (confirmatory).** `combined-v2` is non-inferior to `combined-v1@pin` at a 2-point margin.
   - BEAM pooled: clusters are conversations, stratified by size, with wave 1's restricted wild cluster bootstrap-t (Webb six-point weights, 9,999 draws, seed `20261010`, [`ni-stats.ts`](../../eval/runner/memory-proof-wave/ni-stats.ts)).
   - LoCoMo10: the same statistic over 8 conversation clusters, unstratified. An inconclusive result is descriptive.
3. **Against the comparator (confirmatory).**
   - BEAM pooled: `combined-v2` is non-inferior at 3.5 points, wave 1's margin, with gate 2's statistic.
   - LongMemEval-S and LoCoMo10: reported against the comparator, with the comparator's delivered-context gate misses from wave 1 stated beside them.
4. **Rerank gate (W3 stage 2), only if stage 2 is built.** `combined-v2+gate` must meet all four conditions:
   - non-inferior to `combined-v2` on BEAM pooled at a 1-point margin, with gate 2's statistic;
   - no question kind's two-sided 95% interval lies entirely below −3 points (TC6), across multi-session, contradiction, temporal, event ordering and abstention. This is release-blocking;
   - at least 25% fewer reranker calls;
   - a mean saving of at least 100 ms per skipped query on the whole `recall` plus `query` path, with no p95 increase over all queries, from the dedicated paired latency runner. The runner has controlled concurrency, warm-up, counterbalanced arm order and timing after the provider lock is taken. Cell `retrieve_ms` is never used for this gate.

   Only then does `search.reranker.gate` default to `on`. Skip reasons that BEAM cannot exercise (title and alias) stay shadow-only.
5. **Cost.** Cost per correct answer at R = 1, 20 and 200 reads per stored conversation, with wave 1's cost formula. The R = 200 result is stated plainly whichever way it lands. Rerank, query embedding and answer model are reported as separate shares of read cost.

Every counted cell must pass the delivered-context gate: mean and p95 within ±10% of 8,000 tokens, counted with `cl100k_base` on the text inserted into the prompt. A failing cell is reported as failing, not rerun at another setting.

Under the recorded GBRA-49 answer and the $650 cap, every gate above is counted, and nothing falls back to the reduced designs in the plan.

## Step 0: the decomposition (exploratory)

Step 0 runs before any build spend. It uses the LongMemEval-S dev subset only (100 questions), never the other 400. It decides scope only.

| Arm | Store | Mode | Facts block | Page tokens | Spec |
|---|---|---|---:|---:|---|
| comb (wave-1 combined) | combined | tokenmax | 1,800 | 6,300 | `cells/mpw2/step0/lme-s-dev-comb.json` |
| a: block removed | combined | tokenmax | 0 | 6,300 | `lme-s-dev-a.json` |
| b: block removed, space returned | combined | tokenmax | 0 | 8,100 | `lme-s-dev-b.json` |
| d: mode isolated | combined | `conservative` (read-time `search.mode`) | 0 | 8,100 | `lme-s-dev-d.json` |
| raw (wave-1 raw) | raw | conservative | 0 | 8,100 | `lme-s-dev-raw.json` |

The combined store uses wave 1's extractor (gpt-6-luna), because step 0 decomposes wave 1's gap. Arm comb counts the block on rendered text, as above.

gap = raw − comb = (raw − d) + (d − b) + (b − a) + (a − comb):

- (raw − d) is the store: extraction rows and the facts arm;
- (d − b) is the search mode;
- (b − a) is page space;
- (a − comb) is the facts block.

Decision rules, in this order:

1. **Mode dominates.** If (d − b) is positive and larger than (b − comb), `tokenmax` is costing keyed installs. The wave pauses, and Garry decides whether to re-scope it around mode defaults.
2. **Proceed.** Otherwise, if (b − comb) is at least half the gap, W1 proceeds.
3. **Filler removal is the fix.** Read later, on the dev `filler-removed` lane against `combined-v2` on the W1 build. If the paired 90% interval of (b − W1) lies inside ±3 points, removing the filler is the fix. The harness lane changes, W1 ships as a product fix without a counted efficacy claim, and the counted lanes shrink to no-regression.

All five arms are judged in-cell and then by one joint blinded re-judge.

## Shadow probe (A15)

After W3 stage-1 code exists and the dev stores are rebuilt, and before any counted cell, a dev retrieval-only replay runs with `search.reranker.gate: shadow` on every dev question.

It reports:
- the would-skip rate, overall and per question kind;
- shadow rank-1 against reranked rank-1;
- the context-change rate against the same-build noise baseline;
- the token-weighted overlap between the delivered context with and without the reranker on would-skip questions. This is the decision metric; rank-1 agreement decides nothing.

Stage 2 (the skip path) is built only if the would-skip rate is at least 25%, both pooled and on BEAM dev alone. Otherwise W3 ships as the shadow grade and its numbers (TC2).

## Models

| Role | Model | Note |
|---|---|---|
| Answer | `gemini-3.8-flash` | both systems, every cell; no fallback model |
| Judge | `gemini-3.5-flash` | **Named exception (F19).** It is older than the answer model. It is allowed only because it is BEAM's harness-forced judge and the one shared link to wave 1's results. The same judge serves LongMemEval-S and LoCoMo10 so one joint re-judge per dataset is comparable with wave 1. |
| Extractor, counted | `anthropic:claude-haiku-5-5` | gbrain's measured default, through the sentinel |
| Extractor, descriptive | `openai:gpt-6-luna` | wave 1's extractor; step 0 and the continuity row |
| Comparator extraction | its documented default | unchanged from wave 1 |
| Agent smoke (A12) | a smoke-allowed model | 5 fresh Claude Code sessions with only the shipped tool descriptions; pass rule 4 of 5 |

Fable runs only in smoke tests, never in counted cells. No cell runs gpt-5.4-mini or an older generation. This wave compares memory reads, not answer models, so it runs one answer model and adds no model ladder.

## Custody

- **Public data** (LongMemEval-S, LoCoMo10): each cell's receipt is pushed to `capy/memory-proof-wave-2` as soon as the cell finishes. The receipt holds the JSON files, ledger status and a tarball of stage records and the request log without bodies.
- **BEAM-500K**: per-question rows may be published (GBRA-49).
- **BEAM-100K and BEAM-1M non-dev**: git and the docs get aggregates only (`summary.json`, `spend.json`) until GBRA-49 says Q1's S2a and S2b have run. The runner publishes nothing else for those cells.
- **Private material**: per-question rows of aggregates-only cells, ledgers and VM keys stay on cloud machines. After every cell they are copied to the integrator's primary machine at `~/.capy/work/mpw-ledgers/wave2/`, with SHA-256 checked on both sides. They are never written to Capy Drive or git. No step waits on Garry's Mac.
- Every VM is recorded in the stage's `VMS.md` when it is created and when it is destroyed.

## Budget

Wave 2 has its own cap: **$650**, metered per cell at the ledger's list prices, on stage ledgers separate from wave 1's. Every cell has its own cap and stops when it reaches it. Spend is released in three stages:

| Stage | Released | Covers |
|---|---:|---|
| 1. Step 0 | approved at about $6 | the five step-0 arms and their joint re-judge |
| 2. Dev | about $104, once W1 code exists | rebuilt dev stores (measured default and gpt-6-luna), dev tuning, the dev decision lanes, the descriptive extractor row, the shadow probe |
| 3. Confirmation | the remainder, released only after the step-0 rules and the shadow probe set scope | LongMemEval-S, LoCoMo10 and BEAM non-dev cells, the comparator's BEAM regeneration, the joint re-judges, `filler-removed@pin` |

**Step 0's estimate is about $18, not $6.** The plan's $6 is below its own rates: $0.08 per LongMemEval-S history puts the combined store alone at $8, and wave 1's matched receipts agree ($7.27 of OpenAI extraction in a $9.52 shard of 100 histories). Five reads at about $1.40 each, the raw store and the joint re-judge bring it to about $18. Step 0 runs only after the integrator approves the revised figure.

The reviewed plan's estimate for all stages is about $570, from wave-1 per-question rates (read $0.031 / $0.013 / $0.014 per question on BEAM / LongMemEval-S / LoCoMo10; ingest $0.43 per BEAM conversation and $0.08 per LongMemEval-S history; joint re-judge $0.014 / $0.0037 / $0.0033 per answer). Each stage's actual spend is recorded here before the next stage is released.

## Runbook

Every cell runs with [`mpw2-cell-vm.sh`](../../eval/harness-provider/mpw2-cell-vm.sh). The script runs one cell on its stage's VM under the stage ledger, pushes the cell's receipt and copies the stage ledger for mirroring.

| Stage | Specs | Command | Cap | Expected receipt fields | Custody copy |
|---|---|---|---|---|---|
| 1 | `cells/mpw2/step0/lme-s-dev-{comb,a,b,d,raw}.json`, in that order | `STAGE_CAP_USD=<released> GBRAIN_SHA=59782b95… bash eval/harness-provider/mpw2-cell-vm.sh step0 <spec>` | stage as released; cells $12 / $3 / $3 / $3 / $5 | `facts.counting: rendered`, `facts.tokens`, `timing.service_ms`, `pages.requested.token_budget`; for arm d, 0 rerank requests in the proxy log | `~/.capy/work/mpw2/step0/ledger.sqlite` → `~/.capy/work/mpw-ledgers/wave2/step0.sqlite` |
| 2 | `cells/mpw2/dev/…`, committed with the W1 head before the stage starts | as stage 1, `GBRAIN_SHA=<PR-A head>` | per spec | as stage 1, plus `facts.facts_order: relevance`, `facts.ids`, `pages.repeated_fact_rows_dropped`, `gbrain.extractor.source: measured default` | `…/wave2/dev.sqlite` |
| 3 | `cells/mpw2/confirm/…`, committed with the pin amendment | as stage 1, `GBRAIN_SHA=<PR-B head>` | per spec | as stage 2, plus `meta.rerank_gate` on gate cells | `…/wave2/confirm.sqlite`; aggregates-only cells' rows to `…/wave2/rows/` |

## Changelog

### 2026-10-10: First version

Written before any counted cell. It records Garry's decisions, GBRA-49's ruling verbatim with the not-held-out disclosure, the lanes, the data reuse, the gates as amended (W2's gate removed under UC1, LongMemEval-S secondary under UC3), step 0 and its rules, the shadow probe, the models with the judge exception, cloud custody, the staged $650 budget with step 0's revised estimate, and the runbook.
