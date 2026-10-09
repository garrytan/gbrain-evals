# Preregistration: how `auto` should pack an explicit budget, E2 of the budgeted delivery plan (2026-10-09)

**Status: frozen on 2026-10-09,** before any paid call. The budgets `B_pseudo`, `B_native` and `B16_pseudo` stay open
until the label-free retrieval freeze and the $0 sizing run; amendment A1 fills them before any live call or reader
call. The phase 2 readers run on the frontier candidate that the phase 1 readings name by the rule below. Nothing else
changes after the first paid cell runs; a later change gets a new dated amendment, before any cell it affects.

Plan: [docs/plans/2026-10-08-gbrain-budgeted-delivery/PLAN.md](../plans/2026-10-08-gbrain-budgeted-delivery/PLAN.md)
(v3, approved by Garry on 2026-10-08 with all eight recommended defaults; E2 cap $270, E3 cap $10). E1's report:
[2026-10-08-gbrain-budgeted-delivery-e1.md](2026-10-08-gbrain-budgeted-delivery-e1.md). This file is the plan's E2
step: it fixes the arms, calls, settings, recipes, sizing rule, readers, the dev rule, guards 1 to 9, the references,
the C5 and sweep arms, E3, and the spending and drop order.

## The question

gbrain's `auto` evidence unit hands the reader whole conversations where it can. With an explicit 8,000-token budget
and the 25 hits `query` returns by default, E1 found that `auto` reserves a matching chunk for every hit first, grows
almost nothing into a whole conversation, and delivers the conversations that no longer fit as chunks outside the
budget: it overran on every LongMemEval-S slice and LoCoMo question. The same delivery on the first five hits read
best (82% on the slice with Sonnet 5.5). gbrain#6367 makes an explicit budget a hard cap under `auto` and offers three
ways to share it (`search.auto_packing`):

- `cap_only`: today's order (every hit's matching span first, then growth in rank order) with the cap.
- `breadth_capped`: keep the longest rank-order run of conversations whose title, matching span and target window fit,
  drop the rest, then grow the kept ones.
- `depth_first`: take conversations in rank order, each whole if it fits, else as much around its match as fits, else
  skip it.

`off` keeps the uncapped behavior. E2 asks which packing, if any, should go to the held-out decision (H1): each
against `off` (today's `auto`) and against `cap_only`, on the LongMemEval-S 500, read by the held-out reader. It is a
development verdict and sets no default.

## Code and data identity

- **gbrain under test:** `garrytan/gbrain` `ca2c447bd39b31beb142247de424c096eefc8525` (v0.60.124.0, the merge of
  gbrain#6367), loaded as a copied `--gbrain` overlay (`eval/runner/gbrain-under-test.ts`). The declared
  `package.json` pin stays `fc548317` (v0.60.122.0), which predates `search.auto_packing`; every receipt records both.
- **What gbrain#6367 changes:** an explicit `token_budget` under `auto` is a hard cap on the recount of each result's
  title plus text, unless the packing is `off`; rank one is protected and cut at a piece boundary if it alone exceeds
  the budget; nothing spills; `delivery.auto_packing` names the packing on every capped call; the frozen-hit path
  (`assembleEvidenceForHits`) now projects `effective_date`; the library call takes a per-call `auto_packing`; budgets
  below 32 tokens are refused. **Deviation from the plan, disclosed:** the plan said the key's default would stay
  `off` until H1 passes; gbrain#6367 ships `cap_only` as the default for explicit budgets (Garry's G1 answer made the
  cap the contract). E2 is unaffected: every frozen delivery names its packing per call, and the live checks write
  the key before each call. A call without an explicit budget is byte-identical under every packing (guard 1).
- **gbrain-evals:** branch `capy/budgeted-delivery-e2`, cut from main `c6288a98` (v0.10.58) with the plan branch
  (`capy/gbrain-budgeted-delivery-plan`, `d87e4361`) merged in. This file, the harness, the keyless gate receipts and
  the manifests are frozen in the commit that adds them.
- **Sets:** the LongMemEval-S 500 (all 500 questions, one haystack each, all development data; the primary set, each
  question its own cluster); the LongMemEval-S slice (`--limit 100 --seed 42`, 100 of the 500, the E1 and shootout
  link); LoCoMo dev (3 conversations, 587 questions) and BEAM-100K dev (6 conversations, 120 questions), descriptive,
  conversation clusters. Dataset revisions as `bun run eval:decide fetch` pins them.
- **Search:** embeddings `openai:text-embedding-3-large` at 1,536 dimensions; gbrain's `balanced` defaults with the
  Voyage reranker; the query-path pins of E1 (`search.cache.enabled=false`, `decide.provider=none`,
  `search.crag_escalation=false`, `search.crag_think=false`, `search.track_retrieval=false`), each checked against
  `KNOWN_CONFIG_KEYS` and read back.

## Cells and calls

All cells run through one campaign ledger and its leases
(`docs/benchmarks/2026-10-09-gbrain-budgeted-delivery-e2/manifests/campaign.json`, `eval/runner/shootout-cell.ts`).
VM cells run on Ubicloud with the lease's metering proxy; reader cells are local cells (the same lease, proxy and
settlement on this host). Shards are conversation shards run in parallel (`eval/runner/budgeted-delivery/e2-parallel.sh`).

```
freeze        query { query, limit: 25, expand: false, return_unit: 'chunk' }       (no token_budget; plan null; reranked)
size, deliver assembleEvidenceForHits({ hits: frozen list (or its first 5), return_unit, budget_tokens: B, auto_packing: P })
guard 1       assembleEvidenceForHits({ hits: frozen list, return_unit: 'auto', auto_packing: P })   (no budget, each P)
live          config search.auto_packing = P (written and read back), then
              query { query, limit: 25, expand: false, return_unit: 'auto', token_budget: B_pseudo, use_cache: false }
```

1. **Freeze** (paid; `e2-freeze-lme-s`, `e2-freeze-locomo-beam`). One chunk-unit `query` call per question at limit 25
   freezes the ranked hit list, as in E1. A list without rerank scores is retried up to three times, then kept and
   counted. Real embeddings and the reranker.
2. **Size** ($0; `e2-size-*`). The sessions are re-imported with hash vectors and the reranker off: delivery reads
   pages and chunks, never a vector, and every frozen chunk is re-resolved by page and chunk index and refused unless
   its text equals the frozen row's. On each frozen list the sizing deliveries run at every grid budget: on the
   LongMemEval-S 500 the four packings, `off` on the first five hits and `window`, from 4,000 to 7,000 in steps of 100;
   on the slice the four packings from 9,000 to 13,500 (the sweep); on LoCoMo and BEAM the four packings from 4,500 to
   7,500 (`size_set=primary`). Only token counts reach the rows.
3. **Deliver** ($0; `e2-deliver-*`). The same re-import; every variant below on the frozen list at the A1 budgets,
   with `auto_packing` per call, and the guard 1 record. LoCoMo and BEAM deliver the four packings at `B_pseudo` only
   (`deliver_set=primary`).
4. **Live** (paid; `e2-live-lme-s`). The slice, real embeddings and the reranker, one process on its own VM. Per
   question: a fresh frozen list; the assembled delivery of each packing at `B_pseudo` on the fresh list and on the
   frozen list; then three rounds of one live `query` per packing (order rotated each round) with
   `search.auto_packing` written and read back first. Each call records the handler's wall time, the reranker's
   network time and calls (every `fetch` to a `/rerank` route, timed in process), the packing gbrain reports, and
   parity with both assembled deliveries on every consumed field, dates included.
5. **Readers** (paid; local cells `e2-read-*`), replaying the deliver cells' frozen contexts.

The E2 delivery variants (`eval/runner/systems/gbrain-query/system.ts`, `E2_DELIVERY_VARIANTS`), on the 25-hit frozen
list unless noted:

| Variant | Unit | Budget | Packing | Read by |
|---|---|---|---|---|
| `off-b_pseudo`, `cap_only-b_pseudo`, `breadth_capped-b_pseudo`, `depth_first-b_pseudo` | auto | `B_pseudo` | as named (`off` passed explicitly) | primary, LoCoMo, BEAM |
| `off-l5-b_pseudo` | auto, first 5 hits | `B_pseudo` | `off` | reference (E1's best arm) |
| `window-b_pseudo` | window | `B_pseudo` | none | reference on the slice |
| `off-b_native`, `<packing>-b_native` | auto | `B_native` | as named | the native link on the slice |
| `off-b16_pseudo`, `<packing>-b16_pseudo` | auto | `B16_pseudo` | as named | the 16,000-token sweep on the slice |

## Recipes, renderers and readers

Pseudo-session rendering is E1's: memory-qa's `READER_TEMPLATE` with `renderHistory` over sessions rebuilt from
delivered blocks by the specified parser, in date order, each with the session table's date, packed whole in rank
order while the exact serialized history fits the harness budget. `pseudo-session-rank` (C5) renders the same packed
blocks in delivery (rank) order; its packed selection and token count equal `pseudo-session`'s, because the serialized
length does not depend on the order. Native-dated rendering is E1's (`renderItem` with the C1 header line under
`NATIVE_READER_TEMPLATE`). Arms files: `docs/benchmarks/2026-10-09-gbrain-budgeted-delivery-e2/manifests/arms/`.

| Recipe | Items | Render | Harness budget | Recipe hash (first 16) |
|---|---|---|---:|---|
| `pseudo-off` | `off-b_pseudo` | pseudo-session | 8,000 | `ad213143f75194cb` |
| `pseudo-cap_only` | `cap_only-b_pseudo` | pseudo-session | 8,000 | `3edcd166ea40a243` |
| `pseudo-breadth_capped` | `breadth_capped-b_pseudo` | pseudo-session | 8,000 | `485ac2d9f07513b8` |
| `pseudo-depth_first` | `depth_first-b_pseudo` | pseudo-session | 8,000 | `b1e6c55cca4d2754` |
| `pseudo-off-l5` | `off-l5-b_pseudo` | pseudo-session | 8,000 | `689c5565649ee1da` |
| `pseudo-window` | `window-b_pseudo` | pseudo-session | 8,000 | `415b12d6eddd252d` |
| `sweep16-off` / `-cap_only` / `-breadth_capped` / `-depth_first` | `<packing>-b16_pseudo` | pseudo-session | 16,000 | `c7c1dfba92395c82` / `8ea2368e7a2957bb` / `cdebf248b0d7fa51` / `e4c56965ab7b0281` |
| `rank-cap_only` / `-breadth_capped` / `-depth_first` | `<packing>-b_pseudo` | pseudo-session-rank | 8,000 | `edd5058a64f5ff14` / `62ca36961d7e7842` / `4300846978904c1a` |
| `native-off` / `-cap_only` / `-breadth_capped` / `-depth_first` | `<packing>-b_native` | native-dated | 8,000 | `2069df9499894d6e` / `9d36d14fabd849fe` / `15258aa8ce74105f` / `43b198bdb111fd58` |

**Readers and judges.** The primary reader is `claude-sonnet-5-5`, matched to H1. The frontier reader check counts
`claude-opus-5-5`, `claude-sonnet-5-5` and `gpt-6.1-sol` (`bun scripts/model-freshness.ts` lists them as the newest
Opus, Sonnet and GPT on 2026-10-09). `claude-fable-5-1` runs a smoke check only (Garry, 2026-10-07): six slice
questions (`slice: { limit: 6, seed: 42 }`, one per question kind), never counted. **Deviation from the plan,
recorded before any cell:** the plan's reader check named four readers including Fable; under the Fable rule it counts
three, and the rule below says "two or more of the three". The native link uses `gpt-4o-2024-08-06`, the shootout's
and E1's slice reader, under CLAUDE.md's bridge exception (it is the only link to those rows). Judges are the
benchmarks' frozen judges: `gpt-4o-2024-08-06` on LongMemEval-S and LoCoMo, `gpt-4.1-mini` on BEAM. The reader sends
no `temperature` to Claude 5-family or GPT-6 models (`sendsTemperature`), and both the ledger guard and the metering
proxy settle a refused 4xx answer at $0. Each reader cell gets its own empty answer cache.

| Arm (context, reader) | Set | Phase |
|---|---|---|
| `pseudo-off`, `pseudo-cap_only`, `pseudo-breadth_capped`, `pseudo-depth_first`, Sonnet | LongMemEval-S 500 | 1 (primary) |
| `pseudo-off-l5`, Sonnet | LongMemEval-S 500 | 1 (reference) |
| `pseudo-window`, Sonnet | slice | 1 (reference) |
| `sweep16-<packing>` ×4, Sonnet | slice | 1 (exploratory) |
| `pseudo-<packing>` ×4, Sonnet | LoCoMo dev, BEAM-100K dev | 1 (descriptive) |
| `pseudo-off`, `pseudo-F`, Opus 5.5 and gpt-6.1-sol | slice | 2 (reader check) |
| `pseudo-off`, `pseudo-F`, Fable 5.1 | six slice questions | 2 (smoke) |
| `native-off`, `native-F`, gpt-4o | slice | 2 (link to E1 and the shootout) |
| `rank-F`, Sonnet | slice | 2 (C5, exploratory) |

F is the frontier candidate (below). Sonnet's slice rows for the reader check are the primary rows of the slice
questions.

## Budget sizing (values in amendment A1)

For each budget, `B = floor_100(H / (r_max × 1.02))`, where `H` is the harness budget (8,000, or 16,000 for the sweep)
and `r_max` is the highest per-question ratio of the rendering's serialized harness tokens to gbrain's `budget_used`,
across every delivery read at that budget, measured on the real frozen lists at $0
(`eval/runner/budgeted-delivery/budget-sizing.ts --e2`). The iteration starts at the grid's top and runs until `B` is
stable; a fixed point outside the grid refuses the sizing (the grid is widened and the $0 size cell rerun).

| Budget | Set | Rendering | Deliveries read at it | Grid |
|---|---|---|---|---|
| `B_pseudo` | LongMemEval-S 500 | pseudo-session | the four packings, `off-l5`, `window` | 4,000 to 7,000 |
| `B_native` | LongMemEval-S 500 | native-dated | the four packings | 4,000 to 7,000 |
| `B16_pseudo` | slice | pseudo-session, H = 16,000 | the four packings | 9,000 to 13,500 |
| `B_pseudo` (LoCoMo), `B_pseudo` (BEAM) | each set | pseudo-session | the four packings | 4,500 to 7,500 |

Verification at the chosen `B`: no serialized delivery exceeds its harness budget unless gbrain itself delivered more
than `B` (only `off` and `window` can). `B_native` is sized on the 500 although only the slice reads it.

## The primary measurement and the dev rule

**Primary.** On the LongMemEval-S 500, QA service quality (product failures count as wrong) with `claude-sonnet-5-5`,
each candidate packing minus `off`, rows paired by question after the cross-arm harness-exclusion join, question
clusters, cluster bootstrap with 10,000 draws (seed 20261008), two-sided sign-flip p (`eval/runner/stats/paired.ts`).
Every packing is also reported against `cap_only`. Raw paired intervals, no multiplicity correction: dev sets nothing.

**Which packing goes to H1.** The packing with the highest primary point estimate among those whose 95% interval
against `off` is above zero, that pass guards 1 to 9, that lose no more than 3 points against `off` on LoCoMo dev or
BEAM-100K dev, and that pass the reader check. If none qualifies, the dev verdict is `inconclusive` and E2 recommends
no H1 candidate.

**The frontier candidate F** (who phase 2 reads): the packing the rule above picks without the reader check. If none
qualifies before the reader check, F is the packing with the highest primary point estimate, read descriptively, and
the verdict is already `inconclusive`. If F then fails the reader check and another packing qualified before it, phase
2 reruns on that packing (a second phase 2 cell, within the cap).

**Reader check.** For each of the three counted readers, the paired difference F minus `off` on the slice questions.
A reader's gain changes sign when its difference is below zero while the primary difference is above zero. A packing
whose gain changes sign under two or more of the three readers does not go to H1. A zero difference is reported and
does not count as a change of sign.

## Guards, as the plan defines them

Each guard is read on the LongMemEval-S 500 against `off` unless it says otherwise
(`eval/runner/budgeted-delivery/e2-readings.ts`).

1. **Compatibility (exact, structural).** Without an explicit budget, every packing's delivered evidence bytes and
   fingerprint equal `off`'s, on every question of the 500, LoCoMo dev and BEAM dev (the deliver cell's `guard1`
   record). gbrain#6367's keyless property test covers random corpora.
2. **C1 change.** Not applicable: gbrain#6367 carries no date header (C1 is its own PR). Dates reach the reader through
   the session table, as in E1.
3. **Product-token cap (exact, candidates).** Every candidate delivery's `budget_used` (gbrain's recount of the final
   evidence fields) is at most its explicit budget, on every question, and the delivery reports its packing in
   `delivery.auto_packing` (`off` reports none). `off`'s overrun is recorded.
4. **Reader-context cap (exact, candidates).** Every candidate's serialized reader context fits 8,000 harness tokens
   with zero packer cuts, on every question. `off` goes through the same packer and its cuts are counted.
5. **Retrieval invariance (exact).** Every arm reads the same frozen hit list per question. Delivered and packed gold
   coverage (the share of gold sessions among the delivered blocks and among the packed ones) are reported per arm,
   not gated: a correct cap can deliver fewer sessions.
6. **Non-inferiority at the default budget.** Exact by guard 1, so no reader calls; 3 points if guard 1 ever fails.
7. **Question kinds.** No LongMemEval-S question kind is down by more than one question or 2% of that kind, whichever
   is larger, counted as the paired sum of score differences. Multi-session (133 questions) carries the plan's
   expectation: `breadth_capped` at or above `off`; `depth_first` may fall below it; either way the guard applies.
8. **Abstention.** On the 30 abstention questions, the candidate's mean score is not below `off`'s.
9. **Latency.** The p95 of the `query` handler's wall time (excluding reader and judge) for the candidate is within
   +20% of `off`'s, over the live cell's calls (100 questions × 3 rounds per packing, interleaved on one VM). The
   reranker's network time is recorded separately and the p95 without it is reported beside the ratio.

## Descriptive and exploratory readings

- **LoCoMo dev and BEAM-100K dev**, Sonnet: each packing's score, each candidate against `off` and against `cap_only`
  (conversation clusters; three and six clusters, so the intervals understate uncertainty), guards 1, 3 and 4, and the
  per-kind table. A loss of more than 3 points against `off` stops the candidate for review before any H1 request.
- **References on the slice and the 500.** `off-l5` (today's knob: `auto` on five hits, E1's best arm) against `off`
  and `cap_only` on the 500; `window` against `off` on the slice. They decide nothing.
- **The native link.** `native-off` and `native-F` with `gpt-4o` on the slice, the link to E1's `query-auto` (66%)
  and the shootout.
- **The 16,000-token sweep** (exploratory, slice). Each packing at `B16_pseudo` under a 16,000-token harness budget:
  scores, against `off` at 16,000, and against itself at 8,000. It informs H1's budget: E2 recommends H1 keep the
  8,000-token budget the cap exists for, unless F's gain over `off` at 16,000 exceeds its gain at 8,000 by 5 points or
  more, in which case H1's preregistration weighs 16,000.
- **C5, rank order** (exploratory, slice). `rank-F` against `pseudo-F`, Sonnet: the same blocks, shown in rank order
  instead of date order. About 12 to 18 points are detectable on 100 questions, so it decides nothing.
- **Delivery statistics** per variant: `budget_used`, over-budget count, blocks, whole conversations, distinct
  sessions delivered and the drop reasons (`budget_floor`, `breadth_cap`, `budget_note`).
- **Live checks** per packing: the share of calls whose packing read back and was reported, parity with the assembled
  delivery on the fresh list and on the frozen list, and how often the fresh list equals the frozen one.

## E3: the C3 retrieval gate

On the E2 freeze cells' frozen ranked lists (no extra provider call), session fusion against today's ranking
(`eval/runner/budgeted-delivery/e3-retrieval-gate.ts`):

- **Today:** distinct sessions in first-appearance order of the frozen list.
- **Fused:** each session scored from all its hits in the list, `S = h1 + 0.5·h2 + 0.25·h3 + …` over the session's hit
  scores, largest first; the scores are gbrain's rerank scores when every hit of the list has one, else its fused
  search scores; ties keep first-appearance order.
- **Metric:** strict recall of every gold session in the top 5 and top 10 sessions (questions without gold skipped),
  paired per question.
- **Gate:** on the slice, fused recall_all@5 non-inferior within 1 point (95% interval of fused minus today above
  −1 point), and on BEAM-100K dev superior (interval above 0). LoCoMo dev and the 500 are reported. A pass earns the
  QA follow-up (one arm per benchmark under the leading packing, about $12), which needs its own approval because it
  exceeds E3's $10 cap; a miss leaves C3 parked.

The plan priced E3 at about $1.20 for its own retrieval runs. E2's freeze already pays for frozen lists of the slice,
LoCoMo and BEAM at the same build, so E3 adds no provider call.

## Accounting gate (passed before any spend)

`eval/runner/budgeted-delivery/e2-keyless-gate.sh` ran every stage at gbrain `ca2c447bd` (overlay) with hash vectors,
the reranker off and the stub proxy answering readers and judges: freeze, size, sizing, deliver, live, every phase 1
arm, the phase 2 arms for `cap_only`, the LoCoMo and BEAM arms, the readings and E3, on 6 slice, 12 LoCoMo and 8 BEAM
questions. `e2-gate-check.ts` passed: guard 1 held on every deliver row; every candidate delivery stayed within its
budget and reported its packing; every candidate context fit with zero cuts; every live call read its packing back,
reported it and equalled the assembled delivery on the fresh and the frozen list. Receipts:
`docs/benchmarks/2026-10-09-gbrain-budgeted-delivery-e2/receipts/keyless-gate/`. The keyless tests
(`test/eval/budgeted-delivery-e2.test.ts`) run their real-PGLite block against gbrain `ca2c447bd` with
`GBRAIN_E2_OVERLAY` set; the pinned dependency predates `search.auto_packing`, so CI skips that block.

## Budget, spending order and drop order

Cap $270 (approved; this file expects about $185). One campaign ledger; every lease reserves from it before its cell
starts and settles to its proxy ledger's committed total. Spending order: (1) the keyless gate ($0, done); (2) the
freeze cells; (3) the $0 size cells and amendment A1; (4) the deliver cells ($0) and the live cell; (5) the phase 1
reader cells; (6) the phase 1 readings, which name F; (7) the phase 2 cell for F. If the ledger cannot hold the next
lease, arms are dropped in this order until it can: the 16,000-token sweep, `pseudo-window`, `off-l5` beyond the
slice, the Fable smoke, C5. The four primary arms, the LoCoMo and BEAM descriptive arms, the reader check and the
native link are never dropped; if they alone do not fit, E2 stops and reports.

Ubicloud: owner `GBRA-1`, at most about 64 vCPU at once, every VM destroyed by `ubi-runner` when its cell ends.

## Amendments

None yet.

## Changelog

### 2026-10-09: frozen

First version, frozen before any paid call; budgets pending (A1).
