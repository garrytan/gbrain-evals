# Cat 40 next wave: development round 1 (World M, in-sample)

Development round 1 of `docs/plans/2026-10-11-cat40-next-wave/PLAN.md` ("Development and confirmation"), run
after the d4b zero-provider gate passed (`../2026-10-13-cat40-dev-gate/`). M results are in-sample and diagnostic:
the F-items were designed from M's failures (plan, accepted CEO). Nothing here is a confirmation result.

## Setup

- gbrain build: `capy/cat40-next-part1` @ `a798de1f966dcce401546170b9c1882b1fb56904` (v0.60.189.0: Part 1 F1-F4,
  F5, master wave 16; merge base `09d21554d`). Fresh slots on this head under their own `--gbrain-root`.
- Harness: gbrain-evals `capy/cat40-dev-harness`. World M (world digest `6f08629e…`), 100 tasks (H1-H5, 20 each).
- Models: `claude-opus-5-5`, `claude-sonnet-5-5`, `gpt-6.1-sol` (newest per family, `scripts/model-freshness.ts`);
  judge `gpt-6.1-sol`; gbrain arm only; 1 repeat; concurrency 10; `--transcripts`.
- Slots: two families of 10 (`--no-pglite-analyze`), F5-off and F5-on (`--gbrain-build-config mentions.owner_phrases=true`,
  18,389 owner-phrase links per slot). Write, restore and rerank probes passed; 0 effects queued. Receipts in `slots/`.
  The plan priced 2 families per round at 5 slots ($54.72 for rounds 1-2); this round built both families at
  10 slots once (20 slot builds at $2.736, $54.72), and round 2 reuses them.
- No ANALYZE was added anywhere in the harness or slots (owner instruction): the slots carry what the product's own
  import and warm boot leave.
- Every arm ran with `--accept-freeze-drift` and the note recorded in each `experiment.json`.

Arm configs (all on the one build; per-item arms set every other key to its control value):

| Arm | Families | `--gbrain-config` beyond control | Slot family |
|---|---|---|---|
| control | full | `entity.names_references=false, entity.record_types=` (unset), `entity.row_page_status=false, search.long_page_unit=off, search.long_page_min_chars=20000, mcp.instructions_governing_rule=newest` | F5-off |
| all-on | full | F1 + F2 + F3 + F4 | F5-on |
| f5 | full | none | F5-on |
| f1 | H2-H4 | `entity.names_references=true, entity.record_types=contract,amendment` | F5-off |
| f1-no-names-row | H2-H4 | `entity.record_types=contract,amendment` | F5-off |
| f2 | H2-H4 | `search.long_page_unit=section` | F5-off |
| f4 | H2-H4 | `mcp.instructions_governing_rule=in_effect` | F5-off |

`entity.record_types=contract,amendment` was chosen from World M's schema (the two document types that carry
governing terms); F3 is `entity.row_page_status=true` in all-on only (the plan gives F3 no paid arm because
config-only worlds carry no `status`).

## Results

Canonical cells (last harness-clean attempt per model and task; 0 harness errors in every arm). `d ctrl` is the arm
minus control on the same tasks and models, percentile bootstrap over tasks (4,000 resamples), in percentage points.
`fs #93` is the recorded M fs cells (`2026-10-10-model-ladder-hard-confirmation/main-cells`) on the same tasks.

| Arm | Scope | Success | Control, same cells | d ctrl pp [95%] | Wrong value (arm / control) | Not submitted | H4 `+long` (arm / control) | fs #93, same cells | d fs pp [95%] | Agent + judge USD |
|---|---|---|---|---|---|---|---|---|---|---|
| control | full | 238/300 | | | 21 / 21 | 34 | 40/48 / 40/48 | 213/300 | +8.3 [+3.3, +13.3] | 155.23 |
| all-on | full | 255/300 | 238/300 | +5.7 [+2.3, +9.3] | 6 / 21 | 33 | 48/48 / 40/48 | 213/300 | +14.0 [+10.0, +18.0] | 126.03 |
| f5 | full | 243/300 | 238/300 | +1.7 [-2.0, +5.3] | 15 / 21 | 33 | 39/48 / 40/48 | 213/300 | +10.0 [+5.3, +14.7] | 144.90 |
| f1 | H2-H4 | 160/180 | 158/180 | +1.1 [-3.9, +6.1] | 15 / 21 | 5 | 41/48 / 40/48 | 150/180 | +5.6 [-0.6, +11.7] | 74.84 |
| f1-no-names-row | H2-H4 | 159/180 | 158/180 | +0.6 [-4.4, +5.6] | 21 / 21 | 0 | 37/48 / 40/48 | 150/180 | +5.0 [-2.2, +12.2] | 71.56 |
| f2 | H2-H4 | 165/180 | 158/180 | +3.9 [-1.1, +8.9] | 14 / 21 | 1 | 43/48 / 40/48 | 150/180 | +8.3 [+2.8, +13.9] | 85.47 |
| f4 | H2-H4 | 158/180 | 158/180 | 0.0 [-4.4, +4.4] | 19 / 21 | 3 | 39/48 / 40/48 | 150/180 | +4.4 [-1.7, +10.6] | 81.07 |

For H2-H4 arms the wrong-value control column is control's count on the same H2-H4 cells (21; control has none on
H1, H5). Control's 34 non-submissions sit mostly in H1/H5; the H2-H4 arms' counts are on H2-H4 only.

By model (success, wrong value):

| Arm | Opus 5.5 | Sonnet 5.5 | GPT-6.1 Sol |
|---|---|---|---|
| control | 84/100, 3 | 65/100, 17 | 89/100, 1 |
| all-on | 85/100, 0 | 82/100, 5 | 88/100, 1 |
| f5 | 78/100, 4 | 75/100, 11 | 90/100, 0 |
| f1 | 56/60, 1 | 44/60, 14 | 60/60, 0 |
| f1-no-names-row | 55/60, 5 | 45/60, 15 | 59/60, 1 |
| f2 | 59/60, 0 | 46/60, 14 | 60/60, 0 |
| f4 | 56/60, 1 | 42/60, 18 | 60/60, 0 |

Sonnet carries the effect: all-on is +17 cells on Sonnet, +1 on Opus, -1 on Sol. Sol is at or near ceiling on
H2-H4 (60/60 in three per-item arms) and at 0-1 wrong-value cells everywhere, so it cannot show a wrong-value
difference. Control's 60/60 on H5 is also a ceiling in every full arm.

By family (success, wrong value):

| Arm | H1 | H2 | H3 | H4 | H5 |
|---|---|---|---|---|---|
| control | 20/60, 0 | 49/60, 10 | 58/60, 2 | 51/60, 9 | 60/60, 0 |
| all-on | 23/60, 0 | 55/60, 5 | 57/60, 1 | 60/60, 0 | 60/60, 0 |
| f5 | 20/60, 0 | 55/60, 5 | 57/60, 1 | 51/60, 9 | 60/60, 0 |
| f1 | | 52/60, 6 | 56/60, 1 | 52/60, 8 | |
| f1-no-names-row | | 52/60, 8 | 59/60, 1 | 48/60, 12 | |
| f2 | | 53/60, 7 | 58/60, 1 | 54/60, 6 | |
| f4 | | 52/60, 7 | 56/60, 2 | 50/60, 10 | |

Reading (diagnostic, single round, one repeat): all-on is the only arm whose interval against control excludes
zero, and it clears H4 completely (60/60, 0 wrong values, 48/48 `+long`). No single per-item arm reproduces that:
F1 alone and F4 alone are flat on H4, F2 alone is +3 on H4, so the H4 gain comes from the items together. F5's gain
sits in H2 (the same +6 H2 cells and -5 wrong values as all-on's H2), not H4. Dropping the names-row key
(f1-no-names-row) cost 4 H4 cells against f1 and added 6 wrong-value cells (4 of them on H4). Round 2 repeats control, all-on and f5.

## Firing counters

From `eval/runner/cat40/firing.ts` over each arm's transcripts (`<arm>/firing.json`; owner-phrase referrer rows
counted against an F5-on slot's links).

| Arm | Names rows | with `referenced_by_count` | with records | Record rows | Delivered units | `page_status` rows | `known_as` rows | Owner-phrase referrer rows | Instructions sha256 |
|---|---|---|---|---|---|---|---|---|---|
| control | 2,716 | 0 | 0 | 0 | none | 0 | 0 | n/a | `202e24831d66` |
| all-on | 3,160 | 3,160 | 2,589 | 2,920 | section 150, chunk 245, page 1 | 0 | 87 | 3,968 | `3bb1d6aafd23` |
| f5 | 2,960 | 0 | 0 | 0 | chunk 8, page 2 | 0 | 24 | 671 | `202e24831d66` |
| f1 | 427 | 427 | 354 | 852 | none | 0 | 0 | n/a | `e9c664a95b9a` |
| f1-no-names-row | 411 | 0 | 349 | 877 | none | 0 | 0 | n/a | `cc9213b2cd6c` |
| f2 | 288 | 0 | 0 | 0 | section 140, chunk 25 | 0 | 0 | n/a | `202e24831d66` |
| f4 | 375 | 0 | 0 | 0 | none | 0 | 0 | n/a | `3a10b0f4cee8` |

Every item fired where configured and nowhere else: records only with `entity.record_types`, the count only with the
names-row key, section units only with F2, owner-phrase referrers and `known_as` only on F5-on slots, and F4 changes
the served instructions (f2 and f5 serve control's hash). `page_status` rows are 0 in all-on, as expected for a
config-only world (no `status` field), so F3 did not fire on M. Tool-call mixes per arm are in `firing.json`.

## Draft-first (preregistered firing and harm metric)

Script `draft_first.py` (`python3 draft_first.py r1`), output `r1-draft-first.json`. Firing counts `entity` names rows served in H4 cells whose
record list holds a draft amendment row; draft-first means a draft row precedes every executed record row (the
d4b rule's definition). Expected sign (d4b `DECISION-RULE.md`): positive, since F1 lists records newest first and a
config-only draft carries no `page_status`.

| Arm | H4 names rows with records | with a draft | draft-first | H4 cells served a draft-first row | draft-first by model (Opus / Sonnet / Sol) | `+long` cells / other |
|---|---|---|---|---|---|---|
| all-on | 274 | 78 | 68 | 35/60 | 32 / 32 / 4 | 57 / 11 |
| f1 | 220 | 65 | 55 | 28/60 | 29 / 24 / 2 | 46 / 9 |
| f1-no-names-row | 239 | 69 | 59 | 30/60 | 30 / 29 / 0 | 49 / 10 |
| control, f5, f2, f4 | 0 | 0 | 0 | 0/60 | 0 | 0 |

The expected positive sign holds: draft-first rows appear only where F1 records are served. Harm, on the H4 cells
where the arm served a draft-first row, against control on the same model and task:

| Arm | Cells | Wrong value (arm / control) | Success (arm / control) |
|---|---|---|---|
| all-on | 35 | 0 / 6 | 35 / 29 |
| f1 | 28 | 7 / 6 | 21 / 22 |
| f1-no-names-row | 30 | 7 / 6 | 23 / 24 |

With F1 alone the draft-first lists come with one more wrong-value cell than control (Opus, +1) and one fewer
success; with all four items on (F4's in-effect governing rule served alongside the records) the same exposure
comes with 0 wrong values.

World-side definition, settled for rounds 1 and 2: an H4 item is draft-led when the account's contract and amendment
documents that reference it by name, code or nickname (account page plus identity sibling, from the world's
`references`), ordered newest document date first with ties by id, lead with a `DRAFT` amendment. This is the
definition behind the plan's "21 of 70" (autoplan Eng rerun; re-derived in the nextwave eng-check, section 3b), and
the script asserts 21 of 70 items (15 of 20 tasks). An earlier draft of this record matched accounts by title only,
found 15 and left 18 items unmatched; that matcher is replaced. Served draft-first rows fall on the draft-led tasks:
all-on 33 of its 35 served cells, f1 28 of 28, f1-no-names-row 30 of 30. On the 45 cells of draft-led tasks
(15 tasks × 3 models): control 6 wrong values and 39 successes; all-on 0 and 45; f1 7 and 38; f1-no-names-row 8
and 37; f5 6 and 39; f2 5 and 40; f4 7 and 38.

## `entity` names-call latency

`latency_ms` reported by the server on every `entity` names call (nearest-rank percentiles):

| Arm | n | p50 ms | p99 ms |
|---|---|---|---|
| control | 324 | 300 | 1,789 |
| all-on | 417 | 349 | 2,154 |
| f5 | 338 | 293 | 1,976 |
| f1 | 116 | 287 | 502 |
| f1-no-names-row | 117 | 292 | 644 |
| f2 | 80 | 211 | 337 |
| f4 | 106 | 206 | 301 |

The full arms' p99 comes from H1/H5 cells, where names calls carry up to 50 names (median 5-6): split by family,
control's H2-H4 calls are p50 188 / p99 404 ms (n 82, at most 6 names) and its H1/H5 calls p50 304 / p99 1,768 ms
(n 233); all-on 262 / 408 and 399 / 2,295; f5 186 / 273 and 309 / 1,978 (this split uses a separate parse and
counts a few calls fewer than `firing.json`). So the per-item H2-H4 arms are not faster than control on the same
families; the gap in the table is call size.

## Do the restored slots carry `pages` statistics?

Yes. Checked on slot0 and slot7 of both families (stopped snapshots, read through the build's PGlite):

| Family | `pg_stats` columns (pages / links / content_chunks) | `pg_class.reltuples` pages / links | `pg_stat_user_tables` n_live_tup, last_analyze, last_autoanalyze |
|---|---|---|---|
| F5-off (slot0, slot7) | 42 / 12 / 26 | 55,838 / 44,804 | 0, null, null |
| F5-on (slot0, slot7) | 42 / 12 / 26 | 55,838 / 63,193 | 0, null, null |

F5-on's links estimate is F5-off's plus the 18,389 owner-phrase links. The slots were built with
`--no-pglite-analyze` and the harness ran no ANALYZE, so these statistics were written by gbrain itself during
import or warm boot (most likely its first-read statistics refresh; not traced to the exact call). The
cumulative-statistics counters (n_live_tup, last_analyze) read zero and null in every snapshot, so they do not say
whether or when an ANALYZE ran. Whether restored cells still hit the GBRA-81 cached no-statistics plan (fix gbrain
#6577, not in this build) is not measured here; every arm ran on slots from the same build with the same statistics,
so any such cost falls on all arms alike.

## Spend and the stop rule

From the ledger (`ledger-runs.json`, `ledger-program.json`; program cap $1,800 against the $1,777.15 approved):

| Arm | Committed USD | Cap (1.15 × price) | Priced |
|---|---|---|---|
| control | 166.69 | 228.19 | 198.43 |
| all-on | 136.66 | 228.19 | 198.43 |
| f5 | 156.62 | 228.19 | 198.43 |
| f1 | 84.04 | 124.07 | 107.89 |
| f1-no-names-row | 80.15 | 124.07 | 107.89 |
| f2 | 93.44 | 124.07 | 107.89 |
| f4 | 88.94 | 124.07 | 107.89 |
| Round 1 arms | 806.54 | | 1,026.85 |
| Slot builds (both families, rounds 1-2) | 54.72 | | 54.72 |
| Program committed | 861.26 | | |

Every arm finished under its cap; the program's recorded overshoot is $0.006. Round 1 came in $220.31 under its
priced total, so the stop rule does not trigger: round 2 (control, all-on, f5, full family, priced $595.29) fits
with $916 left under the approved total, and its all-on arm stays full-family. Round 2: `../2026-10-13-cat40-dev-round-2/`.

## Seed 20261031

The plan's Development section names the calibration world (seed 20261005) and World M as the development worlds;
it does not make development decisions on an unseen seed. Following the owner's instruction (spend there only if the
plan requires it), nothing was spent on seed 20261031 in this round; its world was used only by the free d4b gate.

## Files

- `<arm>/`: `experiment.json`, budget receipt, `results.jsonl`, `attempts.jsonl`, served instructions and tools,
  `firing.json`, `transcripts.jsonl.gz`.
- `slots/`: slot-build receipts and experiments for the three parallel build groups of each family.
- `summarize_round.py r1` → `r1-summary.json` (results tables); `draft_first.py r1` → `r1-draft-first.json`. Both
  read the pulled run directory and World M from local paths named at the top of each script.
