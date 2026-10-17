INPUT: ceo c50f17026e5d1d6e187304fb4833cb0c670d6146e74d847119ce377f854e120a

# CEO review: "Build the 10x memory advantage: the wave plan" (GBRA-60, 2026-10-07)

Reviewer: independent CEO phase, read-only. I read the full prompt (390 lines), the five audits under `gbrain-evals/docs/plans/2026-10-07-10x-memory-advantage/audit/`, gbrain `src/core/facts/extract.ts`, `src/core/model-config.ts`, gbrain `CLAUDE.md` (privacy rule), gbrain-evals `CLAUDE.md` "Choose models", the W10c report, and, read-only through a scratch clone, the `capy/oss-memory-shootout` branch (#89, head `9c07b7e`) and the `evals/q1-scoreboard` preregistration. Arithmetic marked [mine] is my recount, not a published number.

## Verdict

The audits are excellent and most of the plan's corrections to the brief are right. But the plan doesn't pick a 10x: it is a seven-wave portfolio of four bets, and two time-boxed events decide more than any wave does. **Phase 7 of #89 is about to open sealed LoCoMo and BEAM-100K with the chunk-returning gbrain adapter.** The **Q1 scoreboard freezes gbrain master on Oct 13 to 15 and publishes `gbrain-defaults` as its headline row on Oct 22 to 24.** Under shipped defaults gbrain's write cost is in the same range as the extract-first and memory-bank systems (not 10x below them), and the plan proposes to keep that default. Its read-path premise also hides that `ext-memory-bank`'s native 8k packaging beats every system's raw sessions by about 11 points. So as written, the most visible result of the next three weeks would be a public table where gbrain-defaults loses on both read packaging and write cost.

## Critical findings

**C1. Phase 7 sealed cells are queued with the defective gbrain adapter, and B1 is not a hard hold (critical).**
- Plan: line 34 says sealed LoCoMo "has been opened four times (... and the open-source shootout's Phase 7)". Line 360 says "Phase 7 sealed next". B1 says "named amendment before #89's sealed cells", scheduled "Oct 8 to 9 ... agreed with GBRA-1 and run".
- Evidence: on #89 head `9c07b7e`, `docs/benchmarks/2026-10-06-oss-memory-shootout/manifests/cells/sealed.json` lists `gbrain-shootout-common-locomo-sealed`, `gbrain-shootout-master-common-locomo-sealed` and the two BEAM-100K equivalents. The file notes "Garry approved all four arms on 2026-10-07 ... runs after Phases 4 to 6", and Phase 4 is complete (commit `f85a496`). `eval/runner/systems/gbrain.ts` `retrieve()` still returns `type: 'chunk', text: r.chunk_text` from `hybridSearch`. No sealed results are committed. So Phase 7 has not run yet: the "four openings" count is three openings plus one pending (audit A misread the "A5 completed" commit as a run).
- Why it matters: a sealed run of the known-misstated arm gives a permanent, sealed-grade number for gbrain at 0.59-style packaging. Fixing the adapter after Phase 4 competitor numbers are visible also hands vendors a "post-hoc tuning" objection (audit B §4 risk 2).
- Fix: add wave 0 item **B0, before anything else**: ask the maintainer and GBRA-1 to hold Phase 7's gbrain cells, or all of Phase 7, until B1 lands. Write B1 as the "shipped read path" correction, decided before any new comparator data. Report the rehydrated arm for every system next to it, and offer each comparator its own shipped-delivery arm on the same terms. Correct line 34 to "three openings; Phase 7 pending". This is a User Challenge, because it delays a sealed batch the maintainer approved.

**C2. The shipped write default erases bet (c) on the row Q1 will publish (critical).**
- Plan: D3 (line 377) says "keep the default and publish both cost rows (proposed, lowest risk)". Line 118 says "Cost table shows both rows; the default is a maintainer decision".
- Evidence:
  - P8 sealed write cost is $9.94 per 1,000 pages with extraction on (audit B §2.4).
  - The #89 ingest recount, over the same LME-S data (~4,800 sessions), is `ext-memory-bank` $32.11, `ext-extract-first` $42.27 and `ext-graph-pipeline` $60.88 (audit B §2.3). Per 1,000 sessions that is $6.7, $8.8 and $12.7 [mine].
  - So with defaults on, gbrain sits between those systems, roughly 0.7x to 1.5x of them, not 21x to 71x below.
  - The Q1 preregistration (q1 branch, `2026-10-06-scoreboard-preregistration.md:31,46`) makes `gbrain-defaults` "with its shipped defaults" the headline row, frozen at "gbrain master on the freeze date".
  - The extraction model falls back to `anthropic:claude-sonnet-4-6` (`src/core/facts/extract.ts:67`, `src/core/model-config.ts:93` `reasoning: 'anthropic:claude-sonnet-4-6'`). That is an older generation. Comparators' common config uses `gpt-4.1-mini` extraction.
- Fix: D3 is not "lowest risk". It has to be decided **before Q1's Oct 13 to 15 freeze**, and the plan omits the obvious third option. Move the extraction default to a current cheap model. At `gpt-6-luna` list price the P8 token volumes (2.17M in, 0.21M out) cost about $0.32 per 1,000 pages, or about $0.64 including embeddings [mine]. That is 10x to 35x below the comparators with extraction still on. Gate it with an extraction-quality check (N1 lifecycle plus the takes-bootstrap per-kind precision) on the cheap model. Add it as wave 0 item R2. This is a User Challenge.

## High findings

**H1. Premise 3 overstates the fix: B1 makes gbrain honest, not first (high).**
- Plan, line 36: "gbrain loses today because of its harness adapter, not its retrieval ... gbrain has the best strict recall (0.979) and comes first (0.78) when ... rehydrated". Line 36 also says fixing it is "the cheapest, biggest change in this plan".
- Evidence (audit B §2.3):
  - On LME-S, `ext-memory-bank` native 8k scores 0.89 at 8,739 tokens and `ext-graph-pipeline` 0.83, both above gbrain's best case of 0.78 rehydrated. The 0.78 vs 0.76 lead is 2 points on n=100.
  - The 0.979 strict@5 ties `ext-memory-bank`; it is not the best.
  - On LoCoMo dev, gbrain rehydrated scores 0.727, below `ext-extract-first` (0.760) and `ext-memory-bank` (0.756).
- Fix: restate the premise as "gbrain's ranking is competitive; its evidence packaging is the gap; the leading comparator's extracted items at 8k beat everyone's raw sessions." Preregister the expected B1 result (about 0.78 on LME-S, still behind two systems) so nobody is surprised. Make `ext-memory-bank` native at 8k the bar for bet (b), not gbrain's own A0.

**H2. Bet (b) compares gbrain only to itself, and the plan never names write-time distillation as an alternative (high).**
- Plan, line 138: "The brief at 2k ... non-inferior (3 points) to today's whole-conversation delivery". Line 291: "Adding model calls to the write path by default" is in "stop doing".
- Evidence:
  - Audit A §8 proposed "A brief arm could be a new `context mode` there [#89]"; the plan drops it.
  - The comparator that wins at 8k does its distillation at write time, once per session.
  - The per-question builder adds one serial call before every answer. Its latency is unmeasured (audit A §6.4).
  - It cuts dollars only about 4x, because the builder reads everything.
- Fix:
  - Add a **DIGEST@budget** arm to the A5 pilot: a question-independent per-session digest, written once by a cheap model, cached and opt-in. If it ties the question-conditioned brief, it is cheaper per read, adds no latency and is cacheable.
  - Add a `brief` context mode to #89 (or the Q1 follow-up) so the claim is cross-system at a matched budget.
  - Keep "no default write calls", but allow an opt-in digest with its cost in the table.

**H3. Bet (a) has neither a lever nor statistical power (high).**
- Plan, line 137: "Confident-wrong rate ... falls at least 5x at equal accuracy ... preregistered on LongMemEval-S 400-question confirm split, then one sealed v2 opening".
- Evidence:
  - The baseline is 25 events out of 470 (Sonnet 5.5) and 19 (Opus 5.5), counted with a regex hedge detector (audit A §2.4).
  - On the 400-question split there are about 20 events, and a 5x claim means 4 or fewer. A ratio CI on 4 events spans most of the range.
  - Sealed v2 at 192/200 has 8 wrong answers in total.
  - No wave item builds a mechanism that reduces confident errors. S4 ships no calibrated threshold (audit A §8, TODOS:144), and the brief's "not in the brain" is not shown to change it.
  - A model that hedges everything meets "5x fewer confident wrong" at equal accuracy.
- Fix:
  - Add a lever: a calibrated answerability threshold (S4) plus the read policy for knowledge-update and abstention, ranked fifth in audit E §5.3.
  - Measure where the events are: BEAM-1M dev has about 56 of 220 events (audit E §2.4); add LoCoMo adversarial dev and personal-world traps.
  - Add a guard on the hedge rate among correct answers, and report risk-coverage (AURC) and selective risk.
  - Run power.ts on the ratio before preregistering "5x".

**H4. The scale premise "gbrain should look best at the high end" is contradicted and goes unchallenged (high).**
- Plan, line 211: "turn 'gbrain should look best at the high end' into measured curves". Section 2 never lists this premise.
- Evidence: audit B §0.6 and §2.6. gbrain trails grep over plain files by 16 points at 52,028 docs (Cat 40 scale tier) and by 11.3 points at 55,235 docs (Cat 40 Hard, #76). On BEAM-100K dev, full context ties the retrieval systems.
- Fix: add the premise row with this evidence. Make B6's comparison set "best external system **including `baseline-file-agent` and plain hybrid**". Make #6271's Cat 40 Hard verdict a wave 3 entry criterion.

**H5. The "scale" being measured is far below the flagship brain (high).**
- Plan: B3 (line 219) uses "nested sizes 100k to 10M tokens", and B7 reports up to 50M.
- Evidence: audit E §2.1 derives about 1.28M chunks on Garry's OpenClaw (unverified). At the about 430 tokens per chunk that audit E §5.4 uses, that is roughly 0.5B tokens [mine]. Audit E §4 also says "a bench that never sees production failure shapes" is how 152.8 pages per minute on the bench became 0.8 in production.
- Fix: add a production-shape row. That means read-only metrics from Garry's OpenClaw (write-to-findable p95, query p95, planted-probe recall) under the existing device-consent rule, plus a synthetic world seeded with images, fences and held files. Label the 10M curve "below production scale".

**H6. The 1M-to-10M slope claim cannot be powered as designed (high).**
- Plan, line 220: "10 personas per size (60 at 1M) ... slope 1M to 10M non-inferior within 3 points".
- Evidence: 10 clusters give a minimum detectable difference of about 16 points (audit B §0.7, q1 `power.json`). B10 powers only the 1M point.
- Fix: simulate the paired slope contrast with `eval/runner/q1/power.ts` before the Q1 follow-up freezes. If it misses 3 points, make the slope descriptive and keep inference at 1M.

**H7. Wave 1's off-ramp is too lax, and its margin is fixed twice (high).**
- Plan: line 314 says "If the wave 1 pilot shows the brief losing to truncation at every budget ... stops". Line 138 says "margin frozen after the 100-question pilot measures discordance", but A6 (line 177) hard-codes "non-inferior at 3.0 points".
- Evidence: TRUNC@2k drops whole sessions, so beating it is easy. A brief can beat truncation and still lose 8 points to A0. With n=400, a 3-point margin needs discordance of 0.08 or less. At 0.15 the margin needed is about 4.8 [mine, audit A §6.8 formula]. Chunk vs page discordance was 30%.
- Fix: stop before A6 ($120) and before A8 and A9 when the pilot point estimate for BRIEF@2k sits below A0 by more than the frozen margin for every builder. Delete "3.0" from A6 and point it at the frozen value.

## Medium findings

**M1. A11's token gate compares across tokenizers, the error premise 2 corrects (medium-high).**
- Plan, line 182: "Claude tokens ≤ one fifth of 12,982".
- Evidence: 12,982 is Sonnet 4.6 on sealed v2, with 11,526 cl100k, a ratio of 1.13. Sonnet 5.5 runs at 1.61 (22,167 / 13,800) (audit A §2.1). Audit A's own estimate for BRIEF@2k is about 3.5k Claude tokens, above the 2,596 cap.
- Fix: state the gate as cl100k delivered (2,305 or fewer) plus provider tokens re-measured on the A11 reader.

**M2. The `core` surface contradicts the plan's own evidence, and its premise is unsourced (medium-high; User Challenge).**
- Plan: line 232 says "because P8 measured that a larger advertised surface wins". Yet D3 builds an advertised surface of about 8 tools at $250 sealed plus $60 dev, 3 human-days and 14 agent-hours. Line 127 says the "September 21 review" was not found.
- Evidence (audit D §2.4): sealed P8 saved no money ($236.75 vs $233.56). The narrowing hurt only through hidden tools; non-H starter was −0.2.
- Fix: ship D1 and D2 with advertised `full`, P8's winner, and spend the simplicity effort on D8 (`gbrain setup`), which is the complexity users actually see. Run `core` only if the maintainer has a measured adoption reason.

**M3. Every default registration today is worse off than P8's tested arm, and the fix waits for wave 2 (medium-high).**
- Plan: D1 and D4 sit in wave 2, "after #6271 and #6066 merge" (line 48).
- Evidence: registrations pin callable `starter`, and grants are operator-pinned with frozen snapshots, so hidden tools cannot be widened at all (audit D §2.2, §2.4 last bullet). D1 (`request-tools.ts`) and D4 (`profiles.ts`, `mcp-provision.ts`, `doctor.ts`) are not in #6271's file list (`search.ts`, `page-batch.ts`, `persistence.ts`, `dispatch.ts`, `operations-descriptions.ts`; audit D Part 5).
- Fix: move D1 and D4 to wave 0, with D4's `BEHAVIOR_CHANGES` row and `ask_user` doctor fix.

**M4. Silent-failure fixes wait while the flagship brain is stale (medium).**
- Plan: E-A and E-B are in wave 2.
- Evidence: they touch `cycle.ts:1621-1666` and `schema-health.ts:339-393`, neither contested. They cost $0 and about 1 day, and they are how 136k chunks sat unnoticed (audit E §3.3).
- Fix: move them to wave 0.

**M5. Wave 5 never reaches the maintainer's own agent (medium).**
- Plan, line 266: "the hooks and `setup` command carry the push to Codex and the thin client".
- Evidence: Garry's OpenClaw runs the thin CLI, where "every push channel is dead" (audit D §1.1 table; TODOS "P3 thin-client remote push route"). D8's row has no remote push route.
- Fix: add item D8b (thin-client remote push route) and a Cat 41 OpenClaw thin-CLI scenario.

**M6. Recorded time is parity, not "nobody else has" (medium).**
- Plan: line 140 bet (d) is "capabilities nobody else has: `known_as_of` ...". Line 121 itself says "parity".
- Evidence: the Q1 preregistration (line 36) describes `ext-temporal-graph` as "bi-temporal edges".
- Fix: claim uniqueness only for Markdown-durable, holder-attributed belief history with reviewable diffs, and present `known_as_of` as parity.

**M7. The track record carries high reputational risk on a weak base (medium; User Challenge).**
- Evidence: takes precision is below 0.80 for every model, holder/subject confusion is the documented top error, and grading has never been measured (audit C G6 and G8).
- Fix: keep W6 as a measurement. Defer W7 and W8 until holder attribution reaches precision of 0.9 or better, and keep everything trusted-local.

**M8. W2's new parameters break the starter schema budget (medium).**
- Evidence: starter sits at 24,925 of 25,000 characters after #6271 (audit D §2.1). W2 adds `known_as_of` to `recall`, `entity` and others in starter.
- Fix: add schema-budget work, or scope the new parameters by surface, inside W2.

**M9. The schedule rests on draft PRs (medium).**
- Plan: wave 1 "builds on its [#6066] merged head", and A8 is scheduled Oct 14 to 17.
- Evidence: #6066 stays a draft until its sealed results land (audit A §8).
- Fix: build A3 to A7 eval-only off master, and let only A8 and A9 wait for #6066.

**M10. Wave 4 as one batched PR is too big (medium).**
- Evidence: two migrations and about 35 human-days in one PR. The batching rule is meant for small fixes.
- Fix: split it into 4a (W1 to W5, the ledger) and 4b (W6 to W12).

**M11. The personal-world generator gives gbrain home-field advantage (medium).**
- Evidence: B3 is authored by the gbrain team, uses template prose that favors lexical arms, and has no independence rule. A12 has one ("authored by a non-OpenAI family").
- Fix: open a vendor review window on the generator before freeze, paraphrase with a non-OpenAI, non-builder family, and publish the generator and solvability tables.

## Low findings

- **L1.** Line 37 says `gpt-4.1-mini` is a reader "that the eval model rules forbid". gbrain-evals `CLAUDE.md:91-92` allows one bridge model, and audit E §4 names it the only link. Fix: "allowed only as the bridge; no product claim".
- **L2.** Line 115 names "Basic Memory" despite the kind-id convention on line 26. Fix: use `ext-markdown-kb`.
- **L3.** A7's target "29 of 36 → ≥ 33" uses the W10c LME-S subset as the baseline for an LME-M run, at n=36. Fix: give each set its own baseline and call it descriptive.
- **L4.** Line 65 and line 68 carry 2026-10-08 dates on a plan dated 2026-10-07. They are UTC. Fix: state the timezone.

## Premises in section 2, one by one

1. **Saturated on LME-S.** Holds (468/500; knowledge-update 71/72). But bets (a) and (b) are still "confirmed" on LME-S dev, so call those development results.
2. **Dates lifted LoCoMo.** The correction holds (172 of 196 net gains are temporal; audit A §4.2).
3. **The "bad prompt costs 10 points" claim.** The correction holds: prompt effects shrink with newer readers.
4. **Session titles 4 to 40 of 63.** Rightly dropped as unsourced.
5. **22k vs 7k tokens.** The correction holds, and is stronger than stated: `ext-extract-first`'s default is about 1,262 tokens, while `ext-memory-bank` wins at 8.7k (H1). The real comparator is accuracy at 8k, not 7k.
6. **Use sealed LoCoMo.** Correctly rejected. The opening count is wrong (C1).
7. **Zero-LLM moat.** Partly true. The plan names the gap, then proposes to keep it in the published row (C2).
8. **BEAM-1M 53.5%.** The correction holds (floor 0.278, 49 infeasible questions). The 25% confident-wrong rate there is where bet (a) can actually be measured (H3).
9. **Backlog.** Holds. The fixes belong in wave 0 (M4).
10. **Belief-history parity.** Holds, but contradicts bet (d)'s "nobody else has" (M6).
11. **Who has been right.** The gate is right; defer the rest (M7).
12. **Living pages.** Right to judge them on stale-wrong rate rather than accuracy (pinned questions tied anchored retrieval, M17 in audit C).
13. **7 verbs plus discover.** The correction is right, but the replacement still narrows the surface against the evidence (M2).
14. **`put_pages` grant.** Holds. The fix is a wave 0 item (M3).
15. **Sept 21 simplicity review.** Not found, so it should not drive $310 of sealed spend (M2).
16. **Missing premise: "best at the high end".** Contradicted (H4, H5).

## Alternatives dismissed without analysis

1. **Cheap-model extraction default** instead of the binary on/off choice in D3 (C2).
2. **Write-time per-session digest**, the approach `ext-memory-bank` takes, instead of a per-question builder (H2).
3. **Brief as a cross-system #89 context mode** instead of a comparison against gbrain itself (H2).
4. **Advertised `full` plus fixed discovery, grants and install** instead of a new `core` surface (M2, M3).
5. **Production-shape replay** instead of synthetic-only scale (H5).
6. **One headline metric** instead of four 10x bets. B7 already computes $ per correct answer at 1x and 10x reads per write under shipped defaults. Making that the single number joins bets (b) and (c) and penalizes stale brains. That is the reframing that could produce a defensible 10x, because ingest is the one measured factor that is already above 10x.

## Competitive risk

`ext-memory-bank` already ships the compression the plan wants: 0.89 at 8.7k tokens on LME-S with a gpt-4o reader. It also self-reports 73.9% on BEAM-1M and 64.1% on BEAM-10M (audit E §2.3, different protocol). Its write-time cost is about $6.7 per 1,000 sessions, below gbrain-defaults' $9.94. The Q1 scoreboard and wave 6's vendor submissions invite exactly this system to post tuned rows on gbrain's own benchmark. If gbrain arrives at Oct 22 with the chunk adapter in a sealed cell and Sonnet 4.6 extraction in its headline row, the market's first matched comparison will show gbrain behind on read accuracy and level on write cost. That is hard to walk back.

## The 6-month regret

It is April 2027. The Q1 scoreboard and Phase 7 sealed rows show gbrain-defaults behind `ext-memory-bank` on the 8k read, and level with it on ingest cost. Every 10x bet came back "inconclusive" or "3x" because the event counts were too small. The evidence brief shipped as a paid op that adds a serial call. `known_as_of`, living pages and the track record shipped off by default and nobody turned them on. The proactive brief never ran on the founder's own thin-client agent. Meanwhile the flagship brain was stale for weeks, again, before the silent-failure checks merged in wave 2. In hindsight the right three weeks were: hold Phase 7, fix the adapter, move extraction to a cheap current model before the freeze, ship the grant and discovery fixes, and make the founder's brain fresh and measured.

## Recommendation

Recommendation: approve wave 0 now with C1 (Phase 7 hold), C2 (decide the extraction default before Q1's Oct 13 to 15 freeze), M3 (D1 and D4 with advertised `full`) and M4 (E-A and E-B) added. Approve wave 1 only through the A5 pilot, with the H7 off-ramp and the H2 DIGEST and cross-system arms. Send waves 2 to 6 back for re-scoping around one headline metric: $ per correct answer under shipped defaults at production scale. The reason is that the plan's highest-leverage moves are time-boxed by Phase 7's sealed run and Q1's freeze, and as written the first public matched comparison would show gbrain-defaults losing on both read packaging and write cost.

## User Challenges (where I would change the maintainer's stated direction)

1. **Hold the approved Phase 7 sealed batch** until B1's shipped-path arm lands (C1).
2. **Change the write default before Q1's freeze.** Use a current cheap extraction model, or make extraction opt-in, rather than "keep and publish both rows" (C2).
3. **Don't narrow the advertised surface.** Drop "7 verbs + discover" and the derived `core`; ship advertised `full` with fixed discovery, grants and `gbrain setup` (M2).
4. **Reframe the 10x headline.** Use one metric ($ per correct answer under shipped defaults), and make the token bet a matched-budget comparison against `ext-memory-bank` rather than gbrain's own 14k (H1, H2).
5. **Define "scale" at production size**, including the file-agent baseline gbrain currently loses to, not a 10M synthetic world (H4, H5).
6. **Defer the "who has been right" ranking** about real people until holder attribution reaches precision of 0.9 or better (M7).
7. **Present recorded-time history as parity**, not as a capability nobody else has (M6).
