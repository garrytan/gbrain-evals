# CEO review (Claude): gbrain budgeted evidence delivery plan

Phase: CEO (strategy and scope), gstack `/plan-ceo-review` under `/autoplan`, auto-decide mode. Reviewer:
`claude-opus-5-5` on Capy. Date: 2026-10-07 (America/Los_Angeles).

Reviewed: `docs/plans/2026-10-08-gbrain-budgeted-delivery/PLAN.md` at branch `capy/gbrain-budgeted-delivery-plan`
(`7afdf3b`), with its receipts. Checked against the shootout results and harness at `9c07b7e2`
(`capy/oss-memory-shootout`), gbrain at `c5fb0201` (the shootout's counted master) and `7aa2caa` (master), CLAUDE.md,
`docs/decisions.md`, the sealed v2 protocol and the sealed v2 decision 1 report. Paid calls made: none. Repo edits:
none, apart from adding this file.

Systems are named by kind only (memory-bank, extract-first, graph-pipeline, temporal-graph, markdown-notes,
plain-hybrid control).

## Verdict

The plan's diagnosis holds in direction and every code citation I checked is accurate, but it overstates how much of
the LongMemEval-S gap is "depth", because the rehydrated arm changes four things at once (dates, whole sessions,
date-order presentation and a different reader prompt with turn-by-turn layout) and E1 separates only the first.
E1 is the right first experiment, but as written its pre-spend gate cannot pass (today's `auto` overruns the budget
by design on every question) and it omits the two cheapest arms that decide what to build: `query` with 5 hits, and
`query` at the shipped 24,000-token default. The highest-leverage change for accuracy per token is not a pure
depth-first packer: it is budget-scaled breadth with a hard cap now, and compact dated facts as the breadth layer next,
because sealed v2 at 8,000 tokens rewards breadth (three or four gold chats of about 3,100 tokens each) and raw
sessions saturate near 78 to 86% on the slice whatever their volume.

## Findings

Severity scale: CRITICAL blocks the next paid step as written; HIGH changes what gets built or decided; MEDIUM changes
a measurement's validity; LOW is hygiene. Line numbers are PLAN.md unless another file is named.

1. **CRITICAL. E1, pre-spend gate.** The gate requires "`query-auto` delivered tokens never above 8,000 by the harness
   count on the keyless replay" (PLAN.md:339-341). The plan's own replay shows `auto` at an 8,000 budget and 25 hits
   over budget on 100 of 100 slice questions (mean 10,523 gbrain tokens, 12,086 harness) and 587 of 587 LoCoMo
   questions (PLAN.md:148-151, `receipts/keyless-delivery-summary.txt`). The overrun is the spill, which is uncounted
   on purpose (`src/core/search/evidence-delivery.ts:894-898`), so passing 6,900 instead of 8,000 does not remove it.
   The gate fails, or someone "fixes" the adapter by truncating, which would silently change what `query-auto`
   measures. **Fix:** replace it with an accounting gate: per question, record gbrain `budget_used`, spilled-block
   count, harness tokens and the items the harness packer cut; assert the record is complete and the packer cut
   is counted, not that no overrun happens. Keep the never-over-budget assertion for C2 only. *Mechanical.*

2. **HIGH. C2, product contract.** The spill is documented behavior, not a defect: "`auto` never returns less than
   `chunk` would. `budget_used` exceeds `budget_tokens` only by such unchanged chunks" (gbrain
   `docs/evidence-delivery.md:118-123`), pinned by `test/evidence-delivery.test.ts:272-287`. C2 step 4 reverses it
   (PLAN.md:238-239) without saying so. **Fix:** state the contract change and its owner decision. Recommended form:
   the budget is a hard cap whenever the caller passes `token_budget` explicitly (that number is the caller's cost
   promise), and the default-budget path keeps today's behavior, which the plan already requires to be byte-identical
   when nothing is cut. Update the doc paragraph and the test in the same gbrain PR, and name the change in
   CHANGELOG. *Taste, surfaced at the final gate: Garry decides whether `auto` may return less than `chunk`.*

3. **HIGH. E1, missing arm: `query-auto` at 5 hits.** `auto` was tuned and confirmed at five hits (sealed v2
   decision 1: top five, 24,000 budget, 192 of 200). In the keyless replay, `auto` at 8,000 and 5 hits stays inside
   the budget (max 8,000, over budget 0 of 100) and delivers 2.2 whole sessions plus matching windows for the rest
   (`keyless-delivery-summary.txt`, `auto8k_l5`). If this arm lands near `rehydrated`, the product fix is "scale the
   conversation hit count to the budget, then hard-cap", a few lines in front of `allocate`, instead of replacing
   `allocate` for `auto`. **Fix:** add `query-auto-l5` at the 6,900 budget, same retrieval call with `limit: 5`.
   About $4 across the three benchmarks. *Taste.*

4. **HIGH. E1, missing arm: gbrain as shipped.** No shootout row and no E1 arm measures `query` at its default
   24,000-token budget, which is what an agent gets out of the box and what passed sealed v2 (96%). The slice already
   hints where it lands: `gbrain-legacy` (top five sessions whole, 16,332 tokens) scored 86%. The comparison page needs
   this row more than any other, labeled as a different budget. C0 already supports it ("no budget under
   `vendor-default`", PLAN.md:206). **Fix:** add `query-auto-default` under `vendor-default` to E1. About $11 (most of
   it the slice at about 27,600 harness tokens per question). *Taste.*

5. **HIGH. C2 design, depth versus breadth.** C2 fills the budget depth-first (PLAN.md:232-240). Sealed v2, the H1
   material, has 46 chats of about 3,100 tokens per history; 80 multi-session and 40 knowledge-update questions need
   three or four gold chats and temporal needs two or three (sealed v2 protocol, "What changed from v1"). At 6,900
   gbrain tokens C2 holds two whole chats plus one window, so for most answerable questions it cannot hold all the
   gold. The slice points the same way: two whole sessions 78% (6,064 tokens), five whole sessions 86% (16,332), all
   retrieved sessions 80% (57,273 tokens, master `vendor-default.rehydrated` receipt). Breadth of about five with
   enough depth around each match is the sweet spot, and 8,000 tokens cannot hold five sessions whole. **Fix:** E2
   compares two packers with today: C2 as written (depth-first) and C2-breadth (today's floors-first `allocate`, fed
   only the top k conversation groups that fit with each floor plus a window, and hard-capped). Preregister the
   multi-session expectation for each and read it on LongMemEval-S multi-session (about 130 questions in the 500) before
   any held-out request. *Taste.*

6. **HIGH. E1 and E2, rendering confound and dev/held-out mismatch.** Native items are flattened to one line each
   (`renderItem`: `text.replace(/\s+/g, ' ')`, `eval/runner/systems/render.ts:46-48` at `9c07b7e2`) under
   `NATIVE_READER_TEMPLATE`, while `rehydrated` uses LongMemEval's reading prompt with dated, turn-by-turn sessions in
   date order (render.ts header and `packContext`). Sealed v2 decision 1 rendered each delivered block as a dated
   pseudo-session through LongMemEval's prompt. So "`rehydrated` minus `query-auto` is the product gap C2 targets"
   (PLAN.md:332) mixes product and harness layout, and an E2 dev verdict read through native rendering does not predict
   H1. **Fix:** add one E1 arm that renders `query-auto`'s exact delivered blocks as dated pseudo-sessions through the
   rehydrated template (the H1 shape), and make that rendering E2's primary. Native rendering stays as the link to
   the shootout and the comparison page. About $4. *Taste.*

7. **HIGH. Dev gate, power.** The 19-point rehydration gap includes the date effect, and `gbrain-query` already
   carries dates (PLAN.md:203), so C2's remaining effect over that baseline is smaller than the gap E2 was sized for
   (PLAN.md:405-406), while the slice detects only 12 to 18 points (PLAN.md:367). The likely outcome is
   `inconclusive` after $58. All 500 LongMemEval-S questions are development data (`docs/decisions.md`, splits table),
   and the plan prices two arms on the 500 at about $28 including ingest (PLAN.md:306), less than the $40 slice
   frontier replay. **Fix:** make the LongMemEval-S 500 the E2 primary (paired by question, detects roughly 5 to 7
   points); keep the slice as the link to E1. *Taste.*

8. **MEDIUM. Dev gate, reader.** Dev primary is `gpt-4o-2024-08-06` (PLAN.md:364); H1 primary is `claude-sonnet-5-5`
   (PLAN.md:392). CLAUDE.md "Choose models" allows an older model only as the single link to earlier results. **Fix:**
   E2 primary reader `claude-sonnet-5-5`, matching H1; `gpt-4o` only on the slice as the shootout link; the
   four-reader sign check stays. *Taste.*

9. **MEDIUM. H1, sealed v2 exposure.** The protocol's "Exposure (added 2026-10-05)" paragraph says session text from
   34 of 40 histories was imported into throwaway brains and sent to providers for P8 quote grounding, and "Future v2
   decisions must name this exposure in their preregistration." The H1 section (PLAN.md:381-385) does not. **Fix:**
   name it in H1 and the preregistration checklist, with why it does not bias a delivery decision (no labels or
   ledger read, nothing in delivery tuned on it). *Mechanical.*

10. **MEDIUM. H1 and E2, unpinned hit count and overrun handling.** Decision 1 used five hits; E1 uses the `query`
    default of 25; H1 says "candidate and current default at the budget dev chose" (PLAN.md:386-388) without a hit
    count, and does not say whether the baseline's spill is cut to the budget. An uncut baseline reads more tokens
    than the capped candidate, which breaks the accuracy-per-token comparison. **Fix:** pin `limit` in every arm
    (25 as the agent default; 5 reported as reference) and state that both arms pass through the same harness packer
    at the same harness-token budget, with overruns counted. *Mechanical.*

11. **MEDIUM. C0, budget conversion from a mean.** 6,900 is 8,000 divided by the mean ratio 1.15 (PLAN.md:205-206),
    but guardrail 2 is exact per question (PLAN.md:371-372). A mean ratio puts the questions with above-mean ratios
    over the line. **Fix:** freeze the budget per benchmark from the highest per-question ratio in the keyless replay
    (or its 99th percentile plus a stated margin), and record the ratio distribution in the preregistration. LoCoMo
    (about 1.02) and LongMemEval-S (1.15) get separate values, as the risks section already implies (PLAN.md:407-409).
    *Mechanical.*

12. **MEDIUM. E1, reproduction tolerance.** Two gbrain versions with the same adapter (0.60.46 and 0.60.95 cells at
    `9c07b7e2`) differ by 3 to 5 points on slice arms: `vendor-default` native 58% against 63%, `vendor-default`
    rehydrated 84% against 80%, `fixed-evidence` rehydrated 75% against 78%. "Reproduces 59.0%" (PLAN.md:317) needs a
    preregistered band and a stop rule. **Fix:** state the band (for example per-question agreement and absolute
    difference within 4 points on the slice) and that a miss stops E1 for a determinism check before any reading.
    *Mechanical.*

13. **MEDIUM. Sequencing, C4 ceiling.** Raw-session readouts on the slice sit between 78% and 86% at any volume
    (2 sessions 78%, full history 78%, all retrieved 80%, five whole 86%), while the memory-bank and graph-pipeline
    systems reach 89% and 83% with processed evidence, and the extract-first system reaches 76% on LoCoMo with about
    950 tokens. C2 can at best match `rehydrated`; only C4 aims above it. The plan runs C4 after E2 because its
    baseline is C2 (PLAN.md:348). **Fix:** run an exploratory C4 ceiling probe alongside E1 with the existing
    memory-qa facts lane (`"facts": "conversation"`, `qa.context: "facts"`, `docs/decisions.md`) on LoCoMo dev only,
    about $2 extraction plus $1 QA, no gbrain code. Disclose that it runs on a different runner and prompt. Gate C4
    stage 1 on the best E1 arm, not on C2 existing. *Taste.*

14. **MEDIUM. E1 readings, wrong comparator.** "If `rehydrated` minus `query-auto` is under 5 points, C2 is
    deprioritized" (PLAN.md:332-333) compares the depth reference with only one breadth arm. **Fix:** compare against
    the best dated breadth arm (`chunk-dated`, `query-auto`, `query-auto-l5`) under the same rendering, and read
    `chunk-dated` on the slice as well as LoCoMo temporal: if `chunk-dated` is close to `rehydrated` on the slice, dates
    were the lever and C2 drops down the list. *Mechanical, follows from 3 and 6.*

15. **LOW. Dev gate, Holm.** Holm across the dev family (PLAN.md:366) on 100 questions makes `inconclusive` nearly
    certain, and dev verdicts set nothing. **Fix:** report raw paired intervals in dev; apply multiplicity only where a
    decision is made (H1, if more than one candidate is opened). *Taste.*

16. **LOW. C0, semantic query cache.** `balanced` turns the result cache on at similarity 0.92
    (`src/core/search/mode.ts:494-498`) with a bigram text guard (`src/core/search/query-cache.ts:149`). LoCoMo asks
    many near-duplicate questions per conversation, and a hit changes delivery (`liveHits: false`,
    `src/core/ops/search.ts:152`). **Fix:** record cache status per question on both retrieval paths and pin
    `search.cache_enabled=false` through the existing search pins, or assert zero hits. *Mechanical.*

17. **LOW. Fairness symmetry.** Three of five vendor shims set `valid_from` (PLAN.md:116-117). If gbrain gets a dated
    adapter, check whether the other two products return dates their shims drop. **Fix:** a one-line audit in the E1
    preregistration; disclose the result; if a shim dropped a returned field, that is a harness bug fixed for every
    system alike, not vendor tuning. *Mechanical.*

18. **LOW. C1 versus C0 definition.** C0's `chunk-dated` sets `valid_from` and a title prefix (PLAN.md:208-209); C1's
    test uses a header in the text with `valid_from` unset (PLAN.md:224). **Fix:** make E1's `chunk-dated` the
    text-only header variant C1 would ship, so E1 doubles as C1's dev test and the separate C1 arms disappear. *Taste.*

19. **INFO. Citations verified.** At `c5fb0201`: the shootout adapter calls `hybridSearch` with only a limit and sets
    `valid_from: null` (`eval/runner/systems/gbrain.ts:178-188` at `9c07b7e2`); `balanced` has a 12,000-token search
    budget, limit 25 and the reranker on (`mode.ts:494-504`); `MAX_PER_PAGE = 2` (`dedup.ts:25`);
    `enforceTokenBudget` cuts the list (`hybrid/rank.ts:461`); lean rows keep `title` and `effective_date`
    (`lean-rows.ts:27`); `allocate` reserves floors first (`evidence-delivery.ts:680-735`) and `auto` spills
    (`:894-898`); delivery runs inside the operation (`ops/search.ts:152`, `:821`). The LoCoMo temporal flip
    (25 to 74 of 100, 95 with every gold session in the top five) is in `gbrain-rows-profile.txt`.

## Decisions

| # | Decision | Class | Auto-decision | Principle |
|---|---|---|---|---|
| D1 | Replace E1's "never over 8,000" gate with an accounting gate (finding 1) | Mechanical | Apply | 1 completeness, 5 explicit |
| D2 | Hard cap only for an explicit `token_budget`, keep spill at default, update doc and test (finding 2) | Taste | Recommend; Garry decides at the final gate | 2 blast radius |
| D3 | Add `query-auto-l5` to E1 (finding 3) | Taste | Accept | 3 pragmatic, 4 reuse |
| D4 | Add `query-auto-default` (24,000) to E1 (finding 4) | Taste | Accept | 1 completeness |
| D5 | E2 tests C2-breadth beside C2 depth-first (finding 5) | Taste | Accept | 6 bias to action |
| D6 | Add the pseudo-session rendering arm; use it as E2 primary (finding 6) | Taste | Accept | 5 explicit |
| D7 | E2 primary on LongMemEval-S 500 (finding 7) | Taste | Accept | 1 completeness |
| D8 | E2 primary reader `claude-sonnet-5-5` (finding 8) | Taste | Accept | CLAUDE.md model rule |
| D9 | Name sealed v2 exposure in H1 (finding 9) | Mechanical | Apply | protocol requirement |
| D10 | Pin hit count and shared packer in E2 and H1 (finding 10) | Mechanical | Apply | 5 explicit |
| D11 | Freeze budget from max per-question ratio, per benchmark (finding 11) | Mechanical | Apply | 5 explicit |
| D12 | Preregister reproduction band and stop rule (finding 12) | Mechanical | Apply | 1 completeness |
| D13 | C4 facts-lane ceiling probe on LoCoMo dev alongside E1 (finding 13) | Taste | Accept as exploratory | 6 bias to action |
| D14 | E1 readings use the best breadth arm and read `chunk-dated` on the slice (finding 14) | Mechanical | Apply | 5 explicit |
| D15 | Drop Holm in dev (finding 15) | Taste | Accept | 3 pragmatic |
| D16 | Pin query cache off or assert zero hits (finding 16) | Mechanical | Apply | 1 completeness |
| D17 | Fairness audit of the two non-dating shims (finding 17) | Mechanical | Apply | CLAUDE.md fairness |
| D18 | E1 `chunk-dated` uses the C1 text header (finding 18) | Taste | Accept | 4 reuse |
| D19 | Raise E1 cap from $30 to $50 (follows D3, D4, D6, D13) | Taste | Recommend; budget owner approves | 3 pragmatic |

No User Challenge: nothing here reverses a direction Garry stated. D2 and D19 are owner decisions and are listed as
unresolved below.

## Step 0

### 0A. Premise challenges

1. **"The gap is mostly adapter on LoCoMo and partly on LongMemEval-S."** Supported on LoCoMo: temporal goes from 25
   to 74 of 100 with the same sessions and 95 of them had every gold session in the top five; the temporal loss is
   about three quarters of the distance to the extract-first system. On LongMemEval-S the split is unproven: the +25
   / −6 rehydrated wins spread over five categories, and rehydration changes dates, depth, order and prompt layout at
   once. E1 needs the rendering arm (finding 6) to apportion it.
2. **"The rest is a real product gap."** Half right. The overrun and the breadth-first spend at 25 hits are real
   behaviors at 8,000 tokens, but the spill is a documented contract (finding 2), and the plan never measures `auto`
   at the settings it was tuned for (5 hits, finding 3) or at its shipped default (finding 4). Whether the gap is "the
   algorithm" or "the hit count" is open.
3. **"Whole sessions are not the ceiling."** Correct and under-used. This premise argues for compact dated evidence
   (C4) as the long-run lever, yet the plan sequences C4 last.
4. **"8,000 tokens is the budget that matters."** It is the shootout's budget, not the product's. It matters for the
   comparison page and for agents that pass small budgets; the product default is 24,000, where gbrain answered 192 of
   200 held-out questions. The plan should report both, and not spend a held-out opening on 8,000 behavior without a
   dev signal on the question kinds sealed v2 is built from.
5. **Real problem and do-nothing cost.** The real problem is that gbrain finds the right conversations most often but
   loses on answers at a matched budget, and the public comparison shows it at 59% and 64.9%. Doing nothing leaves
   a comparison row that measured an internal function, and leaves `token_budget` meaning "about this much" for
   agents that budget their context. The plan solves the pain directly (through `query`), not a proxy.

### 0B. Existing code leverage

| Sub-problem | Existing code | Plan reuses it? |
|---|---|---|
| Measuring through the agent path | `query` handler (`ops/search.ts:812`), MCP stdio path used by the evidence-delivery study's E3 | Yes |
| Budgeted delivery | `resolveEvidencePlan`, `effectivePlan`, `deliverEvidence`, `allocate` | Yes; C2 replaces `allocate` for `auto`, where a budget-scaled group count in front of it may suffice (finding 3) |
| Dates | `effective_date` and `title` in lean rows; `think`'s date frame (P6 R1) | Yes |
| Event-time presentation | `presentation: event-time` in `render.ts` | Yes (C5) |
| Config arms | `search.*` pins, `GBRAIN_EVAL_SEARCH_PINS`, `--search-pin` | Implicitly; name it for `search.auto_packing` and the cache pin |
| Dev and held-out gates | `eval:decide dev`, custodian flow, sealed runner, budget ledger | Yes |
| Facts as evidence | memory-qa facts lane, production extractor, `recall` facts-first packing | Partly; usable now for a ceiling probe (finding 13) |
| Keyless delivery replay | `receipts/keyless-delivery-replay.ts` | Yes; extend for the ratio distribution and the l5 arm |

### 0C. Dream state

```
  CURRENT STATE                      THIS PLAN (with D1-D19)                 12-MONTH IDEAL
  shootout row measures an    --->   gbrain-query adapter; E1 apportions --->  `query` takes a budget and returns the
  internal function; auto            dates / depth / rendering / hit count;    most answer-dense evidence that fits:
  overruns small budgets and         C2 or C2-breadth with a hard cap for      dated facts for breadth, windows or
  spends them on breadth;            explicit budgets; facts ceiling probed    sessions for depth, never over budget;
  no "as shipped" row                early; one held-out opening               a published budget-to-accuracy curve
                                                                               per benchmark; comparison page shows
                                                                               gbrain as shipped and at matched budgets
```

The plan moves toward the ideal. With the decisions above it also produces the first two points of the
budget-to-accuracy curve (6,900 and 24,000) as a side effect of E1.

### 0D. Alternatives considered

- **A. Plan as written.** E1 ($18), then C2 depth-first, then C4. Risk: E1's gate fails; E2 reads inconclusive on 100
  questions; C2 may lose sealed v2 multi-session at 8,000.
- **B. Smallest scoped alternative (recommended).** E1 with five more arms (l5, default, rendering, plus fixes), about
  $37 with a $50 cap; then the cheapest product change E1 supports (budget-scaled hit count plus hard cap, or C2) on
  the LongMemEval-S 500; C4 probe in parallel.
- **C. Larger.** Skip C2 and go straight to C4's mixed unit. Rejected for now: query-ranked fact search does not exist
  (`facts/similar-active.ts:57-65` is write-time dedup only), extraction costs about $1 per slice haystack, and the
  facts-lane probe can tell us cheaply whether C4 is worth it.

### 0E. Mode

Auto-decided review mode: SELECTIVE EXPANSION (the `/autoplan` CEO default). Rationale: the plan adds a capability
(budgeted delivery) to an existing system, so the useful posture is to hold its core and cherry-pick additions. No
new approach decision beyond 0D was needed.

### 0G. Cherry-pick candidates (selective expansion)

| Candidate | Effort | Risk | Disposition |
|---|---|---|---|
| `query-auto-l5` arm | S | low | Accepted (D3) |
| `query-auto-default` arm | S | low | Accepted (D4) |
| Pseudo-session rendering arm | S | low | Accepted (D6) |
| C2-breadth packer | M | medium | Accepted into E2 (D5) |
| C4 facts-lane ceiling probe | S | low | Accepted, exploratory (D13) |
| Published budget-to-accuracy curve (6,900 / 16,000 / 24,000) | M | low | Deferred: E2's sweep covers 8,000 and 16,000; publish after E2 |
| Session fusion ahead of C2 | S | low | Kept as planned (E3, retrieval-only) |
| LongMemEval-S 500 for C5 ordering | S | low | Kept as a separate approval |

Delight scan (30-minute items): `delivery.budget_used` and `spilled` printed by `--explain`; a `budget_mode` echo in
the response; harness row field for packer-cut items; ratio histogram in the keyless replay; comparison-page footnote
template for "adapter revised after results".

### 0I. Temporal interrogation

- **Hour 1:** the implementer needs the documented spill contract, the per-benchmark token ratio, and which rendering
  is primary.
- **Hours 2-3:** ambiguity in what C2 does when rank one's window alone exceeds the budget (today `allocate` cuts rank
  one to fit, `evidence-delivery.ts:696-726`; C2 must keep that floor or return nothing).
- **Hours 4-5:** surprise when `query` serves a cached result (finding 16) or falls back to chunks on `fetch_failed`.
- **Hour 6+:** they will wish the harness rows stored packed item ids (PLAN.md:108-109 estimates them instead).

Effort: human team about 3 days for C0 adapters plus tests and the E1 run; Capy with gstack about half a day.

## Pressure tests requested

**Is the adapter-versus-product diagnosis right?** Yes for LoCoMo (dates), partly for LongMemEval-S, where rendering
and prompt layout are an unmeasured third cause (finding 6), and where "product" may mean the hit count rather than
the packing algorithm (finding 3).

**Is E1 the right first experiment?** Yes. It is the cheapest run that changes what gets built, and it needs no gbrain
code. As written it cannot start (finding 1) and cannot tell C2 from a hit-count change (finding 3) or product from
rendering (finding 6). With D1 to D18 it costs about $37 and answers all three.

**Is the decision rule and use of sealed v2 sound?** The structure is sound: dev guides, held-out decides, a custodian
opens once, preregistration first, the default-budget pair checked for byte identity before any label is read. Five
repairs: power (finding 7), reader (finding 8), rendering (finding 6), exposure disclosure (finding 9), and pinned hit
count and shared packer (finding 10). Sealed v2 is the right material because it is the only eligible held-out set
with at least ten clusters, but at 8,000 tokens it is built to reward breadth, so the plan should expect C2 depth-first
to be at risk there and test C2-breadth on dev before spending one of the two remaining openings.

**Highest-leverage change for answer accuracy per token.** In order: (1) dates on every delivered block, near free and
already available as fields; (2) budget-scaled breadth with a hard cap for explicit budgets, a small diff that E1's
l5 arm previews for $4; (3) compact dated facts as the breadth layer with sessions or windows as depth (C4), the only
path above the raw-session ceiling and the only one that could cut tokens several times over. C2 depth-first ranks
below (2) until E1 says otherwise.

## Review sections

### Section 1: Architecture

Current scope: SELECTIVE EXPANSION, auto-decided; accepted D1 to D18, pending owner decisions D2 and D19; deferred
the published curve.

```
  gbrain-evals harness                                   gbrain (c5fb0201, later a feature branch)
  ------------------------------------------------       -----------------------------------------
  shootout runner --> GbrainShootoutSystem (frozen) -->  hybridSearch ----------------------------+
               \                                                                                 |
                +-> chunk-dated (new) -------------->  hybridSearch + title/date mapping          |
                +-> gbrain-query (new) ------------->  query op --> resolveEvidencePlan           |
                |      limit 25 | limit 5 | default        --> effectivePlan --> deliverEvidence   |
                |                                              (allocate | C2 | C2-breadth,      |
                |                                               behind search.auto_packing)      |
                v                                                                                 |
  render.ts packer (chars/4) --> native | rehydrated | pseudo-session (new) --> reader --> judge  |
  rows.ndjson + budget_used / spilled / packer_cut / cache_status (new fields) <------------------+
```

Coupling: the new adapter depends on `query`'s public response shape (lean rows plus `delivered`), which is the right
coupling, unlike today's call into an internal function. Single point of failure: the reranker provider (two
requests per question); a Voyage outage must fail the arm, not degrade it silently. Rollback: the gbrain change sits
behind `search.auto_packing`; revert is a config value, and the default path is byte-identical. Issues: findings 2, 3,
5.

### Section 2: Error and rescue map

See the registry below. Gaps: delivery fallbacks (`fetch_failed`, `fetch_timeout`, `page_missing`) degrade blocks to
chunks inside `deliverEvidence` and are reported only in `delivery.fallbacks`; the adapter must carry them per row or
they are silent.

### Section 3: Security and threat model

The plan keeps sealed data away from the implementer and uses only public datasets and fictional corpora. One gap:
the sealed v2 exposure disclosure (finding 9). No new endpoints. No secrets in receipts.

### Section 4: Data flow and edge cases

Paths for the `gbrain-query` adapter: happy (blocks within budget); nil (`effective_date` missing: render no date,
count it); empty (zero hits: empty item list, a scored wrong answer, not an error); error (query throws, reranker
fails: product error per the runner's accounting). Edge cases: a session longer than the budget (BEAM), a cache hit
(finding 16), redaction changing a block and re-counting it (`evidence-delivery.ts` redaction pass), and the harness
packer cutting a spilled tail (finding 1).

### Section 5: Code quality

C2 as specified replaces `allocate` for one unit; C2-breadth reuses `allocate` and adds a group limit plus a cap,
which is the smaller diff. Keep the depth-first variant as a parameter of the same function, not a second allocator.

### Section 6: Tests

| New behavior | Test | Happy | Failure | Edge |
|---|---|---|---|---|
| `shootout-chunk` reproduction | keyless golden | byte-identical retrieval | mismatch stops E1 | reranker off |
| `chunk-dated` mapping | unit | title and date present | null date rendered as none | empty chunk text |
| `gbrain-query` accounting | keyless replay | budget_used, spilled, packer_cut recorded | missing field fails | cache hit recorded |
| C2 / C2-breadth cap | gbrain unit | never over explicit budget | rank one larger than budget is cut, not dropped | zero conversation hits |
| Default-budget identity | keyless, slice and LoCoMo | byte-identical when nothing cut | any diff fails | non-conversation hits first |
| Token ratio | keyless | per-question max under frozen budget | any overrun by harness count fails | LoCoMo and slice separately |

The 2am test: the default-budget byte-identity check on both corpora. The hostile test: a hit list whose rank-one
session alone exceeds the budget. Flakiness: reader non-determinism at temperature zero (finding 12).

### Section 7: Performance

C2 fetches whole sessions through `getChunkWindows` (capped at `MAX_ROWS = 1024`, `evidence-delivery.ts:59`), well
above a session. The p95 latency guardrail (+20%) is in the plan. No new indexes.

### Section 8: Observability

New per-row fields: `budget_used`, `budget_tokens`, `spilled_blocks`, `packer_cut_items`, `delivery.fallbacks`,
`cache_status`, `auto_packing`. Without them a three-weeks-later question ("why did this arm overrun?") cannot be
answered from receipts.

### Section 9: Deployment and rollout

gbrain change behind `search.auto_packing=depth_first` (or `breadth_capped`); default unchanged until H1. Rollout
order: adapters and keyless tests, preregistration, E1, gbrain branch, E2, custodian request. Rollback: flip the
config key.

### Section 10: Long-term trajectory

Reversibility 4 of 5 (config-gated; the contract change in D2 is the one-way part for callers who come to rely on a
hard cap). Debt: two named adapters to maintain beside the frozen one. Platform potential: a budget-respecting
`query` is the base for C4's mixed unit and for a published budget curve.

### Section 11: Design and UX

SKIPPED (no UI scope).

## Error and rescue registry

Strategy-level capability rows; the implementation owner must verify each unknown.

| Capability | Failure mechanism | User impact | Known safeguard | Owner must prove |
|---|---|---|---|---|
| `gbrain-query` adapter | `query` throws or times out | arm row is a product error | runner accounting | error counted, never dropped |
| Evidence fetch | `fetch_failed` / `fetch_timeout` falls back to chunks | silently weaker arm | `delivery.fallbacks` in response | fallbacks copied to every row |
| Reranker | provider 429 or outage | ranking changes silently if reranker skipped | gbrain pinned-reranker check (`invalid` verdict) | arm fails on unscored results |
| Budget conversion | ratio above frozen value | candidate overruns, guardrail 2 fails | none today | per-question max ratio frozen |
| Harness packer | cuts `query-auto` tail | reader sees a rank prefix | packer is deterministic | cut items counted per row |
| Semantic cache | near-duplicate question served cached hits | wrong evidence | text guard | zero hits or cache pinned off |
| C2 packing | rank-one session exceeds budget | empty delivery | today's `allocate` cuts rank one | C2 keeps the cut-to-fit floor |
| Held-out runner | custody or prereg missing | no verdict | `CUSTODY_MISSING`, `PREREG_UNCOMMITTED` | exposure named in prereg |

## Failure modes registry

```
  CODEPATH              | FAILURE MODE                     | RESCUED? | TEST?   | USER SEES?        | LOGGED?
  ----------------------|----------------------------------|----------|---------|-------------------|--------
  E1 pre-spend gate     | gate cannot pass (finding 1)     | N        | N       | blocked run       | N
  query-auto delivery   | spill cut by harness packer      | N        | N       | Silent            | N      CRITICAL GAP
  deliverEvidence       | fetch fallback to chunks         | Y        | Y (gb)  | Silent in harness | N      CRITICAL GAP
  query cache           | cached hits for another question | N        | N       | Silent            | N      CRITICAL GAP
  C2 cap                | overrun from ratio variance      | N        | planned | guardrail fail    | Y
  C2 rank-one cut       | empty delivery                   | unknown  | N       | wrong answer      | unknown
  E1 reproduction       | run differs from frozen rows     | N        | N       | misread effect    | N
  H1 baseline           | uncut spill gives more tokens    | N        | N       | biased verdict    | N
```

All three critical gaps close with the per-row accounting fields in Section 8 plus D1 and D16.

## NOT in scope

Deferred (to the plan's follow-up list; no TODOS.md write was permitted in this review):

- Publishing a budget-to-accuracy curve as a hub-page table. Reason: needs E2's sweep first.
- C4 slice stage ($110) and the LongMemEval-S 500 runs for C5. Reason: the plan already makes them separate approvals.

Rejected:

- Skipping C2 and building C4's mixed unit now. Reason: query-ranked fact search does not exist, and the facts-lane
  probe answers whether it is worth building for about $3.
- Re-running vendor rows with tuned settings. Reason: tuning; only a harness bug fixed symmetrically is allowed
  (finding 17).
- Changing the 24,000 default budget. Reason: the plan already excludes it.

## What already exists

The `query` operation and its evidence stage; `effective_date` in lean rows; the facts lane in memory-qa with the
production extractor; `recall`'s facts-first packing; event-time presentation in `render.ts`; search pins for
config arms; the decision kit (`eval:decide dev`), custodian flow and sealed runner; the budget ledger; the keyless
delivery replay in this plan's receipts. The plan reuses all of these except the facts lane before E4, which finding
13 brings forward.

## Dream state delta

After this plan, gbrain has a budget-respecting `query` for explicit budgets, one held-out verdict on tight-budget
packing, and two measured budget points. Still missing against the 12-month ideal: query-ranked fact retrieval and a
mixed facts-plus-sessions unit (C4), a published budget curve, and a dev proxy for sealed v2 beyond LongMemEval-S
multi-session.

## Scope expansion decisions

- Accepted: `query-auto-l5`, `query-auto-default`, pseudo-session rendering arm, C2-breadth in E2, C4 facts-lane
  ceiling probe.
- Deferred: published budget-to-accuracy curve.
- Skipped: building C4 ahead of the probe.

## Diagrams

1. System architecture: Section 1.
2. Data flow with shadow paths: Section 4 (prose) and the registry rows.
3. Decision flow for E1 readings:

```
  E1 rows
    |
    +-- reproduction within band? -- no --> stop, determinism check
    |
    +-- chunk-dated ~ rehydrated on slice (same rendering)? -- yes --> dates were the lever; C1 first, C2 down
    |
    +-- query-auto-l5 ~ rehydrated? -- yes --> budget-scaled hit count + hard cap (smallest diff)
    |
    +-- rehydrated - best breadth arm >= 5 points? -- yes --> E2: C2 vs C2-breadth on LME-S 500
    |                                               -- no  --> C4 moves up (facts probe already in hand)
```

4. Rollback: flip `search.auto_packing` to unset; default path is byte-identical.

Stale diagram audit: PLAN.md has no ASCII diagrams. None stale.

## Implementation tasks (strategy level)

| Task | Priority | Owner | From finding |
|---|---|---|---|
| T1 Rewrite E1 gate as an accounting gate; add per-row delivery fields | P1 | gbrain-evals adapter author | 1, Section 8 |
| T2 Add `query-auto-l5`, `query-auto-default`, pseudo-session arms to the E1 table and cost | P1 | plan author | 3, 4, 6 |
| T3 Freeze per-benchmark budget from the per-question max ratio | P1 | plan author | 11 |
| T4 Preregister reproduction band, cache pin, shim audit, readings against best breadth arm | P1 | plan author | 12, 14, 16, 17 |
| T5 Get Garry's call on the spill contract (D2) and the E1 cap (D19) | P1 | plan author | 2 |
| T6 Respecify E2: LME-S 500 primary, `claude-sonnet-5-5`, pseudo-session rendering, C2 and C2-breadth | P2 | plan author | 5, 6, 7, 8 |
| T7 Add sealed v2 exposure, pinned hit count and shared packer to H1 | P2 | plan author | 9, 10 |
| T8 Run the C4 facts-lane probe on LoCoMo dev beside E1 | P2 | runner owner | 13 |

## Completion summary

```
  +====================================================================+
  |            MEGA PLAN REVIEW - COMPLETION SUMMARY                   |
  +====================================================================+
  | Mode selected        | SELECTIVE EXPANSION (auto-decided)          |
  | System Audit         | citations verified; spill is documented;    |
  |                      | sealed v2 exposure unnamed                  |
  | Step 0               | 5 premises challenged; 0D option B          |
  | Section 1  (Arch)    | 3 issues found                              |
  | Section 2  (Errors)  | 8 capability paths mapped, 2 GAPS           |
  | Section 3  (Security)| 1 issue found, 0 High severity              |
  | Section 4  (Data/UX) | 8 edge cases mapped, 3 unhandled            |
  | Section 5  (Quality) | 1 issue found                               |
  | Section 6  (Tests)   | Diagram produced, 4 gaps                    |
  | Section 7  (Perf)    | 0 issues found                              |
  | Section 8  (Observ)  | 7 gaps found                                |
  | Section 9  (Deploy)  | 1 risk flagged                              |
  | Section 10 (Future)  | Reversibility: 4/5, debt items: 2           |
  | Section 11 (Design)  | SKIPPED (no UI scope)                       |
  +--------------------------------------------------------------------+
  | NOT in scope         | written (5 items)                           |
  | What already exists  | written                                     |
  | Dream state delta    | written                                     |
  | Error/rescue registry| 8 rows, 2 CRITICAL GAPS                     |
  | Failure modes        | 8 total, 3 CRITICAL GAPS                    |
  | TODOS.md updates     | 2 items proposed, not persisted             |
  | Scope proposals      | 8 proposed, 5 accepted                      |
  | CEO plan             | not persisted (single output file rule)     |
  | Outside voice        | skipped (autoplan runs separate voices)     |
  | Lake Score           | N/A (auto-decided, no scored questions)     |
  | Diagrams produced    | 3 (architecture, E1 decision flow, rollback)|
  | Stale diagrams found | 0                                           |
  | Unresolved decisions | 2 (listed below)                            |
  +====================================================================+
```

Review log and dashboard: not persisted (this run may write only this file).

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 (not persisted to log) | ISSUES OPEN | 8 proposals, 5 accepted, 1 deferred; 19 findings, 1 critical |
| Outside Review | not run in this file | Independent 2nd opinion | 0 | skipped | no completed external review |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 0 | not run | not run |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | skipped | no UI scope |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | not run | not run |

- **OUTSIDE COVERAGE:** none in this file; the `/autoplan` run collects other voices separately, and this reviewer did
  not read them.
- **VERDICT:** CEO review has open issues (finding 1 blocks E1 as written); eng review required.

**UNRESOLVED DECISIONS:**
- D2: may `auto` return less than `chunk` under an explicit `token_budget` (hard cap), changing the documented contract in gbrain `docs/evidence-delivery.md:118-123`? Recommended: yes for explicit budgets only.
- D19: raise the E1 cap from $30 to $50 to cover the added arms and the facts probe (about $37 expected).
