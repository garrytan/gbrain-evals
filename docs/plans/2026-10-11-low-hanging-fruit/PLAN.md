# Low-hanging fruit for retrieval, latency and cost: plan

Date: 2026-10-11. Scope: gbrain master `da434385` (v0.60.175.0) and gbrain-evals main `a89535fc` (v0.10.77, pins
gbrain v0.60.169.0). Inputs: three read-only audits run on 2026-10-11 (cost, latency, retrieval), each re-checked
against code before use, plus the committed Cat 40 Hard confirmation receipts
(`docs/benchmarks/2026-10-10-model-ladder-hard-confirmation/main-cells`). Status: approved by Garry on 2026-10-12 ("Approve all": items 0 to 5, item 1b and the item 1 default flip under their gates, $30 cap; relayed by GBRA-40). Item 0 ships alone first (gbrain #6528); the wave starts after gbrain #6445 merges.

## Outcome (2026-10-13)

Every item is closed. Measured verdicts are in
[the wave report](../../benchmarks/2026-10-12-lhf-wave.md) (gbrain-evals v0.10.81, item 5 added in v0.10.87).

| Item | Result | Shipped in |
|---|---|---|
| 0. Batch `entity names[]` respects quarantine for remote callers | shipped alone | gbrain #6528, v0.60.178.0 |
| 1. `balanced` as the new-install default | **not shipped**: the Cat 40 Hard rerank-pool replay was inconclusive (-0.93 points, lower bound -1.55, margin -1.0), so `tokenmax` stays the default. The rest of item 1 shipped: init reads config-file keys, the Voyage-key branch, `--search-mode` and doc fixes | gbrain #6564, v0.60.188.0 |
| 1b. `query` expansion follows the mode | shipped: on `balanced`, `query` without expansion kept 451 vs 448 of 470 LongMemEval-S questions at about a sixth of the latency | gbrain #6564, v0.60.188.0 |
| 2. Leaner lean `search` rows | shipped on parity tests | gbrain #6564, v0.60.188.0 |
| 3. `degraded_recall` stops hiding a new transient failure | shipped | gbrain #6564, v0.60.188.0 |
| 4. `entity names[]` stops building cards it throws away | shipped on parity with item 0's output | gbrain #6564, v0.60.188.0 |
| 5. Per-stage search timings | shipped; 40 of 40 bench result digests identical, unclaimed time 0 | gbrain #6601, v0.60.205.0 |

Paid spend was $13.64 of the $30 cap. One validity note stands, disclosed in the report and approved by Garry on
2026-10-13: the Cat 40 world M slot's queued persistence effects were drained by a one-off keyless script before the
replay.

Follow-ups taken from "NOT in scope" (2026-10-13): measuring the query-embed share with item 5's timings before
deciding on starting the embed before the lexical arms, then the bounded keyword candidate set for broad terms on
large Postgres brains (gbrain #6495).

## URGENT, outside this plan

- Batch `entity names[]` returns quarantined pages' leads to remote callers (`src/core/verbs/entity-names.ts:51` omits
  the `omitQuarantined` that single-name `entity` passes at `src/core/verbs.ts:245-247`; identity siblings are
  unfiltered too). Found by the Eng outside voice, confirmed from code; added as item 0, shipping alone.

## Implementation plan

### Goal and decision rule

Find changes that are small (one fix-wave PR, mostly S effort), measurable with a keyless check or one capped paid run,
and that move a number a gbrain user feels:

- **Retrieval:** strict `recall_all@5` on LongMemEval (451/470 under `balanced`), agent task success on Cat 40 Hard,
  and confidently wrong answers there (gbrain 22 vs files 14 on world M, 16 vs 2 on S).
- **Latency:** agent-visible tool time (21% of Cat 40 Hard cell time; hybrid `search` p50 1,423 ms; `entity names[]`
  p95 14.2 s) and model calls per read.
- **Cost:** dollars per *successful* task, per model (Cat 40 Hard world M: Sonnet 5.5 $0.85 vs files $1.71, Opus 5.5
  $1.10 vs $2.40, GPT-6.1 Sol $0.32 vs $0.24, the one model where gbrain costs more).

Every behavior-changing item has a preregistered rule with a harm margin. A result whose interval admits more harm
than the margin is **inconclusive**, and an inconclusive item does not ship as a default. Items that must leave output
byte-identical ship on parity tests instead.

### What the audits ruled out

- **Tool descriptions:** `full` has +55% tokens but +9% cost over `starter`; the 7-verb surface saved nothing and lost
  3 tasks (`docs/benchmarks/2026-10-05-registration-surface.md`).
- **Reranker cost:** $0.0004 to $0.0007 per task (`2026-10-02-model-ladder.md`). gbrain #6445 is a latency change.
- **Facts-extraction model:** already Haiku 5.5 since v0.60.118.0 (`src/core/facts/extract.ts:66`).
- **Contributor PR #5654:** superseded; rescore uses binary `vector_send` since `e14eb5b0`.
- **The Cat 40 reranker outage:** fixed and re-measured (168/168 and 167/167 hybrid cells reranked on Hard).
- **Session-deduping the `[gbrain search]` and `[gbrain dates]` trailers:** they carry per-call counts, the next-page
  cursor and date provenance (`src/core/search/keyword-paging.ts:205-226`, `src/core/search/date-labels.ts:24-40`),
  so they stay on every call.

### Items

**0. Urgent, found in review: batch `entity names[]` leaks quarantined pages to remote callers. Effort S.**

- *Problem.* Single-name `entity` passes `omitQuarantined: ctx.remote !== false` (`src/core/verbs.ts:245-247`), but the
  batch resolver calls `buildEntityCard` without it (`src/core/verbs/entity-names.ts:51`), and the exact title / slug /
  suffix arm reads candidates with only the private-page predicate (`src/core/verbs/entity-card.ts:248-259`). A remote
  `entity names: ["crm/kite-co"]` therefore returns the lead of a quarantined page, which can hold instruction-like
  text withheld from agents. Identity siblings (`src/core/mentions/siblings.ts:75-88`) have no quarantine condition
  either. Established from code; the existing test covers only a batch alias.
- *Change.* Pass `omitQuarantined` for remote callers in the batch path and filter siblings the same way.
- *Gate (keyless).* Remote exact-slug, exact-title, suffix, alias, runner-up and sibling fixtures return no
  quarantined content; trusted-local visibility unchanged. Item 4's parity requirement is relative to this fixed
  output, not today's.
- *Ships alone* ahead of the wave, as the shipping rules allow for security fixes.


**1. `gbrain init` recommends `balanced`, not `tokenmax`. Effort S.**

- *What happens today.* `recommendModeFor` (`src/commands/init-mode-picker.ts:67-97`) returns `tokenmax` for every
  install with an Anthropic, OpenAI or Google key unless the subagent is Haiku, and `runModePicker` writes it without
  a prompt on JSON and non-TTY installs (`:219-236`), which is how agents install gbrain. With no chat key it returns
  `conservative` (reranker off) even when `VOYAGE_API_KEY` is set (`:76-81`), though the reranker needs only that key.
- *What the mode actually changes on agent reads.* `search` always passes `expansion: false`
  (`src/core/ops/search.ts:756-775`) and defaults to 20 results; `query` decides expansion per call (item 1b). So
  `tokenmax` vs `balanced` changes `query`'s result limit (50 vs 25) and token budget (none vs 12,000), the rerank
  pool (50 vs 25), and `contextual_retrieval` (`per_chunk_synopsis` vs `title`). Inline import demotes
  `per_chunk_synopsis` to `title` (`src/core/import-contextual-mode.ts:33`); synopses are generated only by the
  separate contextual-retrieval backfill, which is the paid write-side cost.
- *Evidence.* At gbrain `109b992`, direct-harness retrieval at top 5: `balanced` 451/470, `tokenmax` 442/470
  (gbrain-evals `docs/benchmarks/2026-10-04-longmemeval-opaque-followups.md:44-53`). gbrain-evals `docs/settings.md`
  already recommends `balanced`. The picker's own cost matrix prices `tokenmax` at twice `balanced`.
- *Change.* `balanced` by default and for Opus; `balanced` when a rerank-capable key exists without a chat key;
  `conservative` only for a Haiku subagent or when neither key exists. Keys are read through `mergedProviderEnv`
  (`src/core/ai/provider-env.ts`), not raw `process.env` (`init-mode-picker.ts:120`), so a Voyage key saved in
  `~/.gbrain/config.json` counts; inputs are renamed `hasChatKey` / `hasRerankKey`. Update every surface that states
  the recommendation or its prices from one shared source: the picker's reason strings and `[AGENT]` banner, the
  first-run decision (`src/commands/init-first-run.ts:38`), the upgrade banner, the narrowing copy in
  `src/core/search/mode-switch-ux.ts:145` (it promises a cache refill while semantic caching is off), the cost matrix's
  models and prices (it names Haiku 4.5 / Sonnet 4.6 / Opus 4.7; use `src/core/model-pricing.ts`),
  `INSTALL_FOR_AGENTS.md` Step 3.5 and `docs/guides/search-modes.md`, then `bun run build:llms`. Add
  `gbrain init --search-mode <mode>` so an agent that already knows the operator's choice records it as chosen
  (`auto: false`) instead of init-then-`config set`. Add a `BEHAVIOR_CHANGES` row (`src/core/behavior-change-notice.ts`)
  disclosing the new recommendation. `search.mode: tokenmax` also turns on the paid nightly conversation-parser probe
  (`src/core/conversation-parser/nightly-probe.ts:113`), so new `balanced` installs stop running it; this is disclosed
  in the row and the PR's behavior changes, and the coupling is kept (it is an opt-in cost). `init --search-mode` on an
  existing brain refuses with a message unless `--force`, and an explicit choice suppresses the first-run
  `search_mode` ask (`src/commands/init-first-run.ts:99`) and is recorded as `search.mode_source: operator`; picker
  choices record `auto`. The rerank branch uses reranker readiness (`rerankerReadinessForEngine`), not a key name.
- *Existing brains.* The picker is idempotent (`:205-211`); nothing changes on an existing brain. Brains whose
  `tokenmax` came from the picker (no `search.mode_source: operator`) get one `coaching` notice, shown to the owner only
  (stdio and CLI, never remote callers), delivered once per brain through the behavior-change per-brain marker files,
  with `fix.argv` `gbrain config set search.mode balanced`, `fix.verify` `gbrain search modes --json`, the evidence
  quoted as measured, and what switching changes: `query` returns 25 instead of 50 under a 12,000-token budget, the
  rerank pool is 25 instead of 50, new chunks are embedded with title context instead of synopses (existing vectors
  keep serving until replaced), and the nightly parser probe stops. No automatic change, no spend.
- *Gate (keyless).* Picker unit tests over every input combination (chat key yes/no, Voyage key yes/no, key only in
  the config file, Haiku/Opus/unknown model), the final `init --json` decision, the non-TTY and upgrade banners, the
  owner notice on a fresh and an upgraded brain across stdio, CLI and HTTP (HTTP never shows it), and a fresh-init
  receipt test of resolved settings and provider calls for one `search`, one `query` and one `put_page` per mode.
- *Gate (paid, inside the shared $30 cap).* The mode also changes ordinary `search` ranking through the rerank pool
  (25 vs 50, `src/core/search/hybrid/rank.ts:263`), and the 451 vs 442 comparison bundled expansion into `tokenmax`.
  Two pieces of evidence, both preregistered:
  1. In the LongMemEval run, `tokenmax` vs `balanced` through `search` and through `query` (expansion held off in
     both), same index, each operation's real default limit.
  2. A rerank-only replay of the recorded Cat 40 Hard world M hybrid `search` calls (about 1,000) on a regenerated
     world M brain, under a 25 and a 50 pool: top-20 overlap, how often pool rows 26 to 50 enter the top 20, and gold
     hit@5 where the task names a gold document. This covers large-haystack company search, which LongMemEval's small
     haystacks may understate.
  Ship the default flip only if both LongMemEval comparisons pass the Measurement rule and the Cat 40 replay shows
  gold hit@5 under the 25 pool no more than 1 point below the 50 pool; otherwise ship only the Voyage-key branch and
  the doc corrections, and report.
  Cat 40 Hard cannot detect this item (agents made 11 `query` calls of about 6,000; the 12,000-token budget never
  bound), so it gets no Cat 40 round.

**1b. `query` expands only when the mode says so. Effort S. Changes the agent read path; needs Garry's approval.**

- *What happens today.* `query` sets `expand = p.expand !== false` (`src/core/ops/search.ts:868`) and forwards it
  (`:989`), and a per-call value overrides the mode bundle (`src/core/search/hybrid/request.ts:103-106`). So every
  `query` call in every mode, `balanced` included, makes one LLM expansion call before retrieval.
- *Evidence.* The direct harness shows no measured gain from expansion (436 vs 434 of 470 without the reranker); that
  harness replayed recorded expansions, so it is not a `query`-path measurement.
- *Change.* `query`'s default follows `resolvedMode.expansion` (off in `balanced` and `conservative`, on in
  `tokenmax`); `expand: true` (CLI `--expand`) still forces it. `expandFn` stays wired whenever expansion can resolve
  true (`:990`), so `tokenmax` keeps expanding by default. This flips a documented, test-pinned contract, so every
  surface that says "query always expands" changes with it: the tool description (`:842`), the concept-search hint that
  sends agents to `query` for expansion (`:446-449`), `src/core/search/modes-report.ts:29,98-106`, the picker strings,
  `docs/guides/search-modes.md`, `INSTALL_FOR_AGENTS.md`, `docs/architecture/RETRIEVAL.md`, then `bun run build:llms`;
  `QUERY_DESCRIPTION` and `SEARCH_DESCRIPTION` (`src/core/operations-descriptions.ts:51`, reworded mode-neutrally,
  then the operation manifest, `docs/mcp/TOOL_REFERENCE.md` and the starter size-budget tests regenerated),
  `src/core/search/tune-recommendations.ts:87`, `top-help.ts:44`, and the stale expansion receipt comment in
  `src/core/search/mode.ts:128`. A guard test rejects "in every mode" / "always expands" phrasing in `src/` and
  `docs/`. CRAG's `callerExpanded` reads `expansion_applied` instead of the op-local flag (`src/core/ops/search.ts:1067`);
  eval capture records the raw `expand` param (null when unset) plus `expansion_applied`, and `eval-replay` maps null
  to the mode default (`eval-replay.ts:267`), each with a unit test.
  `test/search/operation-expansion-contract.serial.test.ts` is rewritten to pin the new contract (the mode decides the
  default, an explicit `expand` wins, `tokenmax` still expands). The `BEHAVIOR_CHANGES` row names both escapes
  (`expand: true`, `gbrain config set search.expansion true`) and warns that a previously inert `search.expansion`
  value now takes effect on `query`.
- *Harness (effort M, ships in the gbrain wave).* `gbrain eval longmemeval` calls the core library today
  (`src/commands/eval-longmemeval.ts`); add a via-operation mode that builds the agent's context (remote true, stdio,
  owner source id, recorded per arm) and runs `query` and `search` through the op layer, so receipts reproduce from a
  tagged gbrain. The `balanced`/expansion-off baseline is reproduced through it before any paired arm.
- *Gate (paid, inside the shared $30 cap).* LongMemEval-S through the real `query` operation, `balanced`, expansion on
  vs off, same index and embedding cache, 470 answerable questions, under the Measurement rule. Every expansion-arm
  question must record an expansion attempt and outcome; a failed, unavailable or budget-refused expansion invalidates
  that arm until a named repair (a throwing-provider fixture proves the check). Report model calls per query, p50 and
  p95 latency and the CRAG confidence-grade distribution per arm (escalation itself is off by default). Inconclusive
  keeps today's default.

**2. A leaner `search` row. Effort S.**

- *Problem.* `search` is 85% of gbrain tool-result characters on Hard (24.8k per call, p90 65k), and on Anthropic
  models about 80% of cost is cache writes of tool results. Lean rows (`src/core/search/lean-rows.ts:31`) keep `id` on
  every row: `base64([source_id, slug])` (`src/core/deep-research-id.ts`), a duplicate of two fields in the same row,
  9.5% of row characters. None of 6,266 gbrain calls on Hard passed an `id` back. `score` prints 17-digit floats.
- *Who it reaches.* New registrations pin the `full` surface (`src/core/mcp-registration.ts:24`), where `fetch` is
  callable, so `id` stays for them; the `id` saving reaches `starter` and `verbs` registrations (harnesses that cap
  tool counts, and the Cat 40 measurements). Score rounding reaches everyone.
- *Change.* Lean rows include `id` only when `fetch` is callable on the caller's surface at call time or the caller
  passes `fields: "full"`. One `isCallable(op)` predicate, built from the dispatch predicate (stdio session after
  `request_tools`, HTTP client surface, ceiling), is threaded into `OperationContext`; rounding happens only in
  `leanRow`, so trusted local callers are unchanged; `score` rounds to 4 significant digits (RRF-scale
  scores are small, so fixed decimals would collapse them). `trust_tier`, `origin` and both trailers stay on every
  row. `fetch`'s refusal text (`src/core/ops/pages.ts:239`) names both routes: re-run `search` once `fetch` is
  callable, or pass the row's slug (accepted when unambiguous). The `BEHAVIOR_CHANGES` row names `fields: "full"`,
  `mcp.result_rows: full`, and that local CLI and the thin client are unchanged.
- *Gate (keyless only).* A replay over the committed Hard transcripts recomputes search characters on the `starter`
  and the `full` surface separately and reports both; unit tests prove `id` returns with `fields: "full"`, with
  `fetch` on the registered surface, after `request_tools` adds it mid-session, and for callable-full/advertised-starter
  and HTTP starter clients; a tie test proves rounding never
  makes two different scores print equal unless they agree to 4 significant digits; thin-client `content[0]` contract
  tests pass. The only content removed is a field no agent used (0 of 6,266 calls) and float digits, so no paid
  round.

**3. `degraded_recall` shows on every affected call. Effort S.**

- *Problem.* `PER_CALL_NOTICE_CODES` (`src/core/notice-ledger.ts:24`) omits `degraded_recall`, so stdio and CLI dedupe
  it per session; after one `embed_timeout`, a later rerank failure returns fused-order results with no notice.
  AGENT_OPERATOR_v1 says stdio shows it on every affected call; HTTP already does (gbrain `TODOS.md` P2).
- *Change.* Split by stage. Transient degradations (`rerank_failed`, `embed_timeout`, keyword or title arm failures)
  show on every affected call; only the configuration-persistent `embed_unavailable` (the documented keyless
  `--no-embedding` install degrades every search with it, `src/core/search/hybrid/keyword-only.ts:96-99`, about 600
  characters) stays deduped per session. The notice carries an unrendered `dedupe_key` built from its sorted unique
  stage/reason pairs, which the ledger reads and the wire never shows. Reconcile `docs/protocol/AGENT_OPERATOR_v1.md`
  (its stdio and dedupe paragraphs disagree) and add a `BEHAVIOR_CHANGES` row.
- *Gate.* Keyless forced probes on stdio: `embed_timeout` then a rerank failure shows two notices (fails before,
  passes after); failure, recovery, the same failure shows twice; two keyless searches show one; HTTP stays per call.

**4. `entity names[]` stops assembling cards it throws away. Effort S to M.**

- *Problem.* `src/core/verbs/entity-names.ts:51` calls `buildEntityCard` per name (facts, timeline, links,
  backlinks, loops), then keeps slug, title, type, aka and a lead. On PGLite (one connection) `CONCURRENCY = 8` is
  serial in effect: n=10 p50 3.9 s, n=20 7.0 s, n=50 13.4 s (p95 14.2 s) on Hard; `entity` was 911 s of 4,343 s of
  gbrain tool time.
- *Change.* First profile one n=20 call with a hit/miss split (misses run a full keyword search per name,
  `entity-card.ts:595`). Then extract candidate selection (`entity-card.ts:207-318`) into one exported
  function that `buildEntityCard` calls, and call it directly from `entity-names.ts`. If the lookup itself dominates,
  add the index it needs instead. Hoist per-batch invariants (linkable types, the private-page setting) out of the
  per-name loop and reuse `compiled_truth` from the candidate row instead of re-querying. Still one resolver, with a
  typed result.
- *Gate (keyless).* Output byte-identical on both engines over the Hard generator's names plus adversarial cases:
  colliding aliases and titles, explicit namespaced slugs, the same slug in two sources, private and deleted
  candidates, identity siblings. Ship if parity holds and n=20 p50 on a PGLite brain built with `--no-embed` drops by
  at least half on all-hit and mixed batches; report all-miss batches and the hit/miss mix beside each p50.

**5. Per-stage search timings. Effort S.**

- *Problem.* Search meta has no stage timing, so the 1.4 s hybrid p50 cannot be split between embed, vector, rerank
  and post-fusion, and any latency change after this one is guesswork.
- *Change.* Stage timings at the operation level, so op-layer work is counted (alias fan-out, anchoring, keyword
  count, lexical, relational, expansion, embed, vector, fuse, post-fusion, rerank, response assembly). Stages are
  critical-path blocked wall-clock spans; overlapping work (the keyword count, parallel lexical arms) is reported as
  `overlapped_ms`; nested fan-out hybrid calls aggregate once; retries and discarded escalations accumulate; `total`
  is an independent monotonic measure taken after response assembly, distinct from hybrid time. Integer milliseconds
  in `_meta.retrieval` and `--explain` only (never in content blocks), present on degraded and empty responses. Eval
  capture is out of scope (its table has fixed columns and would need a migration).
- *Gate (keyless plus one sample).* On every refactor-wave-1 bench query (`scripts/bench-refactor-wave-1.ts`),
  `0 <= total - sum(stages) <= 10%` of total, with a delayed-overlapping-stages test that proves timing does not
  serialize execution; result sets unchanged; degraded and empty responses carry the fields; one real-provider sample
  recorded beside the stub bench.

### Measurement

One LongMemEval-S run on a single index serves items 1 and 1b, through the new via-operation harness: `balanced` and
`tokenmax` via `search`; `balanced` and `tokenmax` via `query` with expansion off; `balanced` via `query` with
expansion on. Each comparison is single-treatment with recorded tree identity, resolved settings and operation
context. Plus item 1's rerank-only Cat 40 world M replay.

Preregistered rule for every LongMemEval comparison: the estimate is treatment minus control in strict
`recall_all@5` over the same 470 answerable questions (paired); the interval is a one-sided 95% lower bound from a
paired bootstrap over questions (10,000 resamples, seed 1); the margin is -0.01 (4.7 questions); a pair with either
side missing invalidates the comparison; an arm with any `rerank_failed` or embedding failure is invalid until a
named-repair rerun. Boundary cases are unit-tested before any paid cell. Items 0 and 2 to 5 are keyless. Cat 40's
runner records the resolved `search.mode` in `experiment.json` and pins it through `--gbrain-config`; each future
round states its pinned value in its preregistration. Carrying retrieval meta (stage timings) into Cat 40 receipts is
the next wave's work.

### Budget and sequencing

Program cap **$30** in the SQLite budget ledger, expected about $20: LongMemEval index and five arms about $15,
world M regeneration and the rerank replay about $5.

0. Item 0 ships now as its own PR.
1. Wait for gbrain #6445 to merge (it touches `hybrid.ts` and search meta, the same files as items 2 and 5).
2. Build a measurement branch with items 1 to 5. Keyless gates run in that branch's CI.
3. Build the via-operation harness, reproduce the baseline, then run the four-arm LongMemEval run against
   measurement-branch overlays.
4. Open the fix-wave PR with only the items whose gates passed; the full Ubicloud gate runs on that final tree.
5. Merge through GBRA-40, PATCH stamped at the merge slot. Each item's verdict, null results included, is mirrored as a
   short report in gbrain-evals `docs/benchmarks/`.

### NOT in scope

- Facts extraction with reasoning off: worth about $0.37 per 1,000 pages written, and a sound gate needs a new
  preregistered paired arm with Cat 35 natural-transcript coverage. Deferred to a gbrain TODO.
- Starting the query embed before the lexical arms: waits for item 5's stage timings to show the embed share.
- `query`'s default hit count under an explicit budget (5 vs 25): +7.8 points on development data, +2.5 with an
  interval crossing zero held out; the sealed v2 set is spent for it. Needs a fresh sealed set.
- Confidently wrong answers on Cat 40 Hard (H4 on world M, 47 vs 56 of 60, all 13 misses wrong answers): the next
  wave, with its own plan and its own Cat 40 round, which then also reports cost per success per model (Sol first).
- A paid Cat 40 round for item 2: the only removed content is an unused field and float digits; the next wave's round
  will carry item 2 as part of its baseline.
- Re-measuring Cat 40 Family E with the reranker working (about $10): a gbrain-evals TODO.
- PGLite type-filter vector plans, parallel post-fusion reads, a deeper rerank pool, owner-phrase and H5 merge-chain
  recall (filed P1s), migrating existing `tokenmax` brains automatically.

### What already exists

- Mode bundles and the picker: `src/core/search/mode.ts`, `src/commands/init-mode-picker.ts`,
  `src/commands/init-first-run.ts`; the `search_mode` doctor check (`src/commands/doctor/checks/search-eval.ts`).
- `query` and `search` operations: `src/core/ops/search.ts`; mode resolution `src/core/search/hybrid/request.ts`.
- Lean rows and notices: `src/core/search/lean-rows.ts`, `src/core/notice-ledger.ts`,
  `src/core/behavior-change-notice.ts`.
- Card resolution: `src/core/verbs/entity-names.ts`, `src/core/verbs/entity-card.ts`.
- Measurement: the Cat 40 Hard runner and receipts, the LongMemEval runner (`src/commands/eval-longmemeval.ts`), the
  SQLite budget ledger, the refactor-wave-1 perf bench (`scripts/bench-refactor-wave-1.ts`).
- Notices: `src/core/error-registry.ts`, `src/core/search/mode-switch-ux.ts`, `src/core/search/modes-report.ts`.

## Review record

The gstack /autoplan record for this plan is appended below.

### CEO phase (Claude Opus 5.5 native, GPT-6 Astra outside via host subagent)

Both voices completed. Native 14 findings, outside 8. Decisions applied to the implementation plan above:

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|---|---|---|---|---|---|
| 1 | ceo | Add item 1b: `query` expansion follows the mode | User challenge | P1 | Both voices found `query` expands in every mode (`ops/search.ts:868`), so item 1 alone removes no expansion call | Keep item 1 as written |
| 2 | ceo | Drop the Cat 40 round for item 1; gate it keyless with fresh-init receipts | Mechanical | P5 | `query` is 11 of ~6,000 Cat 40 calls; the round cannot detect item 1 | $25-40 Cat 40 round |
| 3 | ceo | Restate item 1's real treatments (limit, budget, rerank pool, synopsis backfill) | Mechanical | P5 | Inline import demotes synopsis to title (`import-contextual-mode.ts:33`) | "one call per chunk written" |
| 4 | ceo | Remove trailer dedupe from item 2 | Mechanical | P1 | Trailers carry per-call counts, cursor and date provenance | Session dedupe |
| 5 | ceo | Pin and record `search.mode` in every Cat 40 arm | Mechanical | P1 | The runner sets mode through the picker item 1 edits | Unpinned arms |
| 6 | ceo | Single-treatment guardrail round, three current models, repriced from receipts | Mechanical | P1 | Bundled heads cannot justify selective reverts; Opus is required; $0.08/cell was wrong | 150-cell bundled round |
| 7 | ceo | Preregistered harm margins and a wrong-answer guardrail | Mechanical | P1 | Underpowered rounds must read as inconclusive, not as passes | "not lower beyond the interval" |
| 8 | ceo | Defer facts reasoning-off | Taste | P3 | ~$0.37 per 1,000 pages; a sound gate needs a new paired arm | Ship with a rerun of the old gate |
| 9 | ceo | Item 4 (entity names) reuses candidate selection via `identityOnly`; profile first; adversarial parity on both engines | Mechanical | P4 | A second resolver risks identity drift | Set-based new resolver |
| 10 | ceo | Ship stage timings first; defer parallel embed until they show the embed share | Mechanical | P6 | 6b's gain depends on an unmeasured share | Ship 6b now |
| 11 | ceo | Existing `tokenmax` brains get a one-time `ask_user` notice, no auto-change | Taste | P1 | Two populations otherwise persist silently | Doctor info line only |
| 12 | ceo | Sequence the wave after #6445 | Mechanical | P3 | Same files (`hybrid.ts`, search meta) | Parallel |
| 13 | ceo | Report cost per success per model, Sol first; name H4 as the next wave | Mechanical | P1 | The real cost loss and the wrong-answer loss must stay visible | Pooled only |

<!-- autoplan-accepted:ceo -->
- Item 1: picker returns `balanced` by default and for Opus, `balanced` with a rerank key and no chat key, `conservative` only for Haiku or no keys; banner, cost matrix, INSTALL_FOR_AGENTS Step 3.5, search-modes guide and a BEHAVIOR_CHANGES row updated; keyless picker tests over every input combination and a fresh-init receipt test of resolved settings and provider calls for `search`, `query`, `put_page`.
- Existing `tokenmax` brains: one `ask_user` notice per brain, no automatic change, no spend.
- Item 1b (pending Garry's approval): `query` expansion default follows the resolved mode; ships only if a LongMemEval-S `query`-path replay (470 questions, same index and cache) shows a paired strict `recall_all@5` lower bound above -1.0 point; calls, p50/p95 latency and CRAG escalations reported.
- Item 2: drop `id` from lean rows unless `fetch` is callable at call time or `fields: "full"`; round `score` to 4 decimals; keep `trust_tier`, `origin` and both trailers on every call; tests for `fields: "full"`, registered `fetch`, and `request_tools` widening; BEHAVIOR_CHANGES row.
- Item 3: `degraded_recall` in `PER_CALL_NOTICE_CODES`, with a stdio forced probe that fails before and passes after.
- Item 4: profile n=20 first; `identityOnly` on `buildEntityCard`, no second resolver; byte-identical on both engines including adversarial collision, namespaced slug, cross-source, private/deleted and sibling cases; ships only if n=20 p50 halves.
- Item 5: per-stage timings in `onMeta` and `--explain`, summing within 5% of total; results unchanged.
- Guardrail round: master vs master+item 2, mode pinned and recorded, world M dev, 20 tasks x Opus 5.5, Sonnet 5.5, GPT-6.1 Sol, cap $90; primary cost per success per model (Sol first); guardrails: success lower bound above -5 points, wrong answers at most +2 pooled, no family down more than 2 of 12; inconclusive reported as such.
- Program cap $105; wave after #6445; only passed items enter the final tree, which gets the full gate.
<!-- /autoplan-accepted:ceo -->

### DX phase (Claude Opus 5.5 native, GPT-6 Astra outside via host subagent)

Both voices completed. Native 15 findings (one informational: every cited line verified), outside 6.

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|---|---|---|---|---|---|
| 14 | dx | 1b updates every surface stating "query always expands", rewrites the contract test, keeps `expandFn` wired for `tokenmax`, and names escapes | Mechanical | P1 | A documented, test-pinned contract flips | Tool-description-only change |
| 15 | dx | Item 3 dedupes `degraded_recall` by stage-and-reason signature instead of per call | Mechanical | P1 | Keyless installs degrade every search; per-call would add ~600 chars each | Per-call code |
| 16 | dx | Existing-brain recommendation is a registered owner-only `ask` notice, separate from `BEHAVIOR_CHANGES` | Mechanical | P5 | BEHAVIOR_CHANGES rows are disclosure-only and unconditional | ask_user via behavior row |
| 17 | dx | Picker reads keys through `mergedProviderEnv`; all banners share one source | Mechanical | P4 | Config-file keys were missed; prices stale in several places | Picker-only edits |
| 18 | dx | Add `gbrain init --search-mode` | Taste | P2 | Small, in blast radius; avoids init-then-set | TODO only |
| 19 | dx | Item 1 gets a paid `tokenmax`-via-`search` vs `balanced`-via-`search` arm in the shared LongMemEval run | Mechanical | P1 | Mode changes ordinary search through the rerank pool; prior comparison bundled expansion | Keyless only |
| 20 | dx | Item 2 reaches starter/verbs for `id`; everyone for score rounding (4 significant digits); fetch refusal names both routes | Mechanical | P5 | Default registration is `full`, where `fetch` is callable | Claim default-install savings |
| 21 | dx | Drop item 2's $90 Cat 40 round; keyless gates only (replaces the CEO block's guardrail-round obligation) | Taste | P3 | Removed content is an unused field and float digits; $90 buys a ~5% non-default-surface number | Keep the round |
| 22 | dx | Item 4 extracts candidate selection as one exported function | Mechanical | P5 | A card-shaped object without card fields is a trap | `identityOnly` flag |
| 23 | dx | Item 5 times at the operation level with `other` and op `total`, surfaced in meta, `--explain`, eval capture | Mechanical | P1 | Hybrid-only timing misses op-layer work | onMeta only |
| 24 | dx | Build and cost a via-operation LongMemEval harness; reproduce baseline first | Mechanical | P1 | The gate needs it | Uncosted |

<!-- autoplan-accepted:dx -->
- Replaces from the CEO block: the guardrail round (Cat 40, $90) and the $105 program cap. New program cap $20 for one four-arm LongMemEval-S run through a new via-operation harness whose baseline is reproduced first.
- Item 1: keys via `mergedProviderEnv`; shared source for picker, first-run, upgrade and mode-switch copy; `build:llms`; `gbrain init --search-mode`; owner-only, once-per-brain, muteable registered `ask` notice for `tokenmax` brains with fix.argv and fix.verify, never shown to HTTP callers; tests for config-file keys, final `init --json`, banners, and notice behavior on fresh and upgraded brains across stdio, CLI, HTTP; paid arm `tokenmax`-via-search vs `balanced`-via-search with lower bound above -1.0 point, else ship only the Voyage branch and docs.
- Item 1b: mode decides `query`'s default, explicit `expand` wins, `tokenmax` still expands; every "query always expands" surface and the concept hint updated; contract test rewritten; BEHAVIOR_CHANGES row names escapes and the newly live `search.expansion`.
- Item 2: keyless only; starter and full savings reported separately; 4 significant digits with a tie test; fetch refusal names both routes; BEHAVIOR_CHANGES row.
- Item 3: signature-keyed dedupe; probes for two different degradations (two notices) and two keyless searches (one notice); AGENT_OPERATOR_v1 reconciled; BEHAVIOR_CHANGES row.
- Item 4: exported candidate-selection function, no second resolver.
- Item 5: op-level stages plus `other` equal op `total`; present on degraded and empty responses; in meta, `--explain`, eval capture; one real-provider sample.
- Cat 40 runner records and pins resolved `search.mode`.
<!-- /autoplan-accepted:dx -->

### Eng phase (Claude Opus 5.5 native, GPT-6 Astra outside via host subagent)

Both voices completed. Native 18 findings (one informational), outside 9 (one urgent).

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|---|---|---|---|---|---|
| 25 | eng | Add item 0: quarantine filter on batch `entity names[]` and siblings, shipping alone | Mechanical (urgent) | P1 | Remote callers can read quarantined leads | Leave to a later wave |
| 26 | eng | 1b also rewords QUERY/SEARCH descriptions, manifest, TOOL_REFERENCE, tune hints, top help; guard test on phrasing | Mechanical | P1 | Routing text would contradict behavior | Param string only |
| 27 | eng | CRAG reads `expansion_applied`; capture records raw `expand`; replay maps null to mode | Mechanical | P1 | Three consumers read the op-local flag | Ignore |
| 28 | eng | Disclose the nightly parser probe coupling; keep it | Taste | P3 | `tokenmax` enables a paid probe; new installs stop running it | Decouple now |
| 29 | eng | Item 1 needs `tokenmax`-vs-`balanced` through `query` too, plus a Cat 40 world M rerank-pool replay | User challenge | P1 | Small LME haystacks may understate a 25 vs 50 rerank pool on company-scale search | LME `search` arm only |
| 30 | eng | Preregister sign, one-sided 95% paired bootstrap, -0.01 margin, invalid-arm rules, expansion validity check | Mechanical | P1 | Gate was underspecified | Loose rule |
| 31 | eng | Item 3: transient degradations per call, persistent `embed_unavailable` deduped, unrendered `dedupe_key` | Mechanical | P1 | Signature dedupe still hid recurrences | Signature-only dedupe |
| 32 | eng | Existing-brain notice is owner-only coaching via behavior-change marker files; skip operator-chosen `tokenmax`; correct synopsis wording | Mechanical | P5 | Keeps the one-muteable-ask invariant; vectors keep serving | New muteable ask |
| 33 | eng | Item 2 threads one `isCallable(op)` predicate; rounding only in `leanRow` | Mechanical | P5 | Surface decided at dispatch | Per-handler guess |
| 34 | eng | Item 5: critical-path spans, `overlapped_ms`, independent total, 0 to 10% residual gate; drop eval capture | Mechanical | P5 | Additive sums are wrong under concurrency; capture needs a migration | Additive stages in capture |
| 35 | eng | Item 4 profiles hit/miss, hoists invariants, gates all-hit and mixed batches | Mechanical | P1 | Misses run keyword search per name | Single p50 |
| 36 | eng | Via-operation harness ships in gbrain, agent-shaped context recorded | Mechanical | P1 | Receipts must reproduce from a tag | evals-only harness |
| 37 | eng | `init --search-mode` refuses on existing brains without `--force`; explicit choice suppresses the first-run ask; rerank via readiness | Mechanical | P5 | Undefined semantics | Silent no-op |
| 38 | eng | Defer Cat 40 retrieval-meta side channel to the next wave | Taste | P3 | No Cat 40 round in this wave | Build now |
| 39 | eng | Program cap $30 (replaces $20) | Mechanical | P1 | Extra arms and the replay | $20 |

<!-- autoplan-accepted:eng -->
- Replaces from earlier blocks: program cap $30; item 1's paid evidence is two LongMemEval comparisons (`search` and `query`, expansion off) plus a Cat 40 world M rerank-pool replay with gold hit@5 under 25 no more than 1 point below 50.
- Item 0: remote batch `entity names[]` and identity siblings honor quarantine; fixtures for exact slug, exact title, suffix, alias, runner-up, sibling; local unchanged; ships alone first.
- Measurement rule: treatment minus control, paired, one-sided 95% lower bound by bootstrap (10,000, seed 1), margin -0.01, missing pairs invalidate, any rerank or embed failure invalidates the arm, expansion arm validity checked with a throwing-provider fixture, boundary cases unit-tested first, operation context recorded per arm.
- Item 1b: all routing surfaces reworded and regenerated with a phrasing guard test; CRAG, capture and replay consumers fixed with unit tests.
- Item 1: probe coupling disclosed; `search.mode_source`; `init --search-mode` refuse-or-force; explicit choice suppresses first-run ask; rerank readiness; owner-only coaching notice once per brain via marker files, skipping operator choices, with corrected wording.
- Item 2: `isCallable(op)` in `OperationContext`; rounding only in `leanRow`; callable/advertised and HTTP starter tests.
- Item 3: per-call transient degradations, deduped `embed_unavailable`, unrendered `dedupe_key`; failure-recovery-failure probe.
- Item 4: hit/miss profiling, hoisted invariants, parity relative to item 0's fixed output, all-hit and mixed batch gate.
- Item 5: critical-path spans with `overlapped_ms` and independent total; residual 0 to 10% on every bench query; non-serializing test; meta and `--explain` only.
<!-- /autoplan-accepted:eng -->
