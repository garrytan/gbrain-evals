# Cat 40 next wave: F5 d1b gate on development data (World M, rounds 1+2)

Verdict: **F5 fails the d1b gate.** The share of needed owner-phrase documents that the agent sees does not rise
in the F5-only arm against the same-build all-off control: +0.2 pp [-3.3, +3.6], with 24 cells better and 23 worse
(sign test p = 1.0). That fails whatever the minimum effect is (see "Thresholds"). No family regresses for F5 or for
all-on under a significant-harm reading. Free; no cells were run for this record. M is in-sample.

## What the plan preregisters

PLAN.md (`docs/plans/2026-10-11-cat40-next-wave/PLAN.md` on `plan/cat40-next-wave`), F5:

- d1b (Garry, gate rev 2): "on development data, the share of needed owner-phrase documents that an agent sees in
  any tool result rises against the same-build all-off control, and no Cat 40 family regresses against that control."
- Eng rerun 2: "Rises" is a preregistered minimum effect with a paired test; "no family regresses" is a paired
  same-task, same-model per-family test with a stated margin. Needed owner-phrase documents are defined from gold
  evidence and reference forms (on M: H1 30, H2 13, H3 25, H4 19), H1-H3 are strata, the seen share comes from slug
  sets taken from full results, and the gate reads the F5-only vs all-off pair.

## Thresholds: not written down before the data

Neither the minimum effect nor the per-family margin has a number in PLAN.md, the d4b gate record, the
development arm table, gbrain `TODOS.md` or the review artifacts. Any number chosen now would be chosen after
seeing rounds 1 and 2, so this record states no threshold of its own. It shows the verdict across every
threshold that could apply:

- **Rises.** The F5 point estimate is +0.2 pp and its 95% interval is [-3.3, +3.6] (sign test 24/23, p = 1.0). This
  fails any positive minimum effect read on the point estimate, any reading that needs a significant paired increase,
  and any minimum effect above +3.6 pp read on the interval. No reading of "rises" passes.
- **No family regresses** (success, paired by round, model and task). F5's worst family is H4, -0.8 pp (100 vs 101)
  [-6.7, +5.0]. It passes a significant-harm reading, where a family fails only when its interval lies wholly below
  zero, and any point-estimate margin of 1 cell or more. It would fail a non-inferiority reading that needs the
  lower bound above -6.7 pp or tighter. all-on's worst family is H5, -0.8 pp (119 vs 120) [-2.5, 0.0]. It passes the
  significant-harm reading and any non-inferiority margin of 2.5 pp or wider, and fails only a literal "no family
  drops at all" reading. The plan itself rejects that reading, because it fails 91-99% of the time at one repeat
  when there is no effect.

## Method

`d1b_gate.py` → `d1b.json`.
- **Needed documents.** Gold evidence documents that reference an entity only in the owner (`manager`) form. The
  script reproduces and asserts the plan's H1 30, H2 13, H3 25, H4 19.
- **Seen.** The document's slug appears in any whole tool result of the cell. The dev harness writes whole results:
  the longest is 216,700 characters, 537 of 5,798 f5 round 1 results run past 40,000, and 0 calls were cut before the
  model saw them.
- **Cells.** Canonical cells pair by round, model and task. Both rounds use three models, so each arm has 600 cells,
  and 324 of them belong to tasks with needed documents (522 needed-document slots).
- **Statistics.** Differences come from a task-clustered percentile bootstrap (4,000 resamples; all cells of a task
  move together), plus an exact two-sided sign test on per-cell changes in the number of needed documents seen.

## Seen share of needed owner-phrase documents

Columns: needed-document slots, documents seen in the arm and in control (share in brackets), Δ pp with its 95%
interval, cells better / worse / tied, and the sign test p.

F5 only vs all-off control (the gate pair):

| Slice | Needed | F5 seen | Control seen | Δ pp [95%] | Cells better / worse / tied | Sign test p |
|---|---|---|---|---|---|---|
| All | 522 | 423 (81.0%) | 422 (80.8%) | +0.2 [-3.3, +3.6] | 24 / 23 / 277 | 1.0 |
| H1 | 180 | 111 (61.7%) | 114 (63.3%) | -1.7 [-10.3, +6.6] | 9 / 10 / 47 | 1.0 |
| H2 | 78 | 67 (85.9%) | 64 (82.1%) | +3.8 [-4.2, +11.9] | 7 / 5 / 54 | 0.77 |
| H3 | 150 | 142 (94.7%) | 138 (92.0%) | +2.7 [-0.7, +6.5] | 5 / 2 / 95 | 0.45 |
| H1-H3 | 408 | 320 (78.4%) | 316 (77.5%) | +1.0 [-3.2, +5.2] | 21 / 17 / 196 | 0.63 |
| H4 | 114 | 103 (90.4%) | 106 (93.0%) | -2.6 [-7.9, +2.2] | 3 / 6 / 81 | 0.51 |
| Opus 5.5 | 174 | 137 (78.7%) | 138 (79.3%) | -0.6 [-8.1, +7.0] | 7 / 7 / 94 | 1.0 |
| Sonnet 5.5 | 174 | 129 (74.1%) | 126 (72.4%) | +1.7 [-5.6, +9.5] | 15 / 13 / 80 | 0.85 |
| GPT-6.1 Sol | 174 | 157 (90.2%) | 158 (90.8%) | -0.6 [-1.9, 0.0] | 2 / 3 / 103 | 1.0 |
| Round 1 | 261 | 211 (80.8%) | 207 (79.3%) | +1.5 [-3.2, +6.0] | 11 / 9 / 142 | 0.82 |
| Round 2 | 261 | 212 (81.2%) | 215 (82.4%) | -1.1 [-6.0, +3.6] | 13 / 14 / 135 | 1.0 |

all-on vs all-off control (reported; not the gate pair):

| Slice | Needed | all-on seen | Control seen | Δ pp [95%] | Cells better / worse / tied | Sign test p |
|---|---|---|---|---|---|---|
| All | 522 | 448 (85.8%) | 422 (80.8%) | +5.0 [0.0, +10.4] | 38 / 15 / 271 | 0.002 |
| H1 | 180 | 120 (66.7%) | 114 (63.3%) | +3.3 [-10.0, +17.9] | 12 / 10 / 44 | 0.83 |
| H2 | 78 | 72 (92.3%) | 64 (82.1%) | +10.3 [-1.9, +23.3] | 11 / 2 / 53 | 0.02 |
| H3 | 150 | 142 (94.7%) | 138 (92.0%) | +2.7 [0.0, +6.0] | 7 / 3 / 92 | 0.34 |
| H1-H3 | 408 | 334 (81.9%) | 316 (77.5%) | +4.4 [-1.8, +11.3] | 30 / 15 / 189 | 0.04 |
| H4 | 114 | 114 (100%) | 106 (93.0%) | +7.0 [+2.5, +12.2] | 8 / 0 / 82 | 0.008 |
| Opus 5.5 | 174 | 147 (84.5%) | 138 (79.3%) | +5.2 [-3.9, +14.7] | 10 / 6 / 92 | 0.45 |
| Sonnet 5.5 | 174 | 141 (81.0%) | 126 (72.4%) | +8.6 [+1.1, +16.9] | 26 / 7 / 75 | 0.001 |
| GPT-6.1 Sol | 174 | 160 (92.0%) | 158 (90.8%) | +1.1 [-3.5, +6.9] | 2 / 2 / 104 | 1.0 |

## No family regresses (success, paired)

| Family | Cells | F5 vs control | Δ pp [95%] | Wrong values | all-on vs control | Δ pp [95%] | Wrong values |
|---|---|---|---|---|---|---|---|
| H1 | 120 | 40 vs 39 | +0.8 [-2.5, +4.2] | 0 vs 0 | 41 vs 39 | +1.7 [-4.2, +7.5] | 0 vs 0 |
| H2 | 120 | 104 vs 101 | +2.5 [-4.2, +9.2] | 14 vs 18 | 108 vs 101 | +5.8 [-2.5, +15.0] | 12 vs 18 |
| H3 | 120 | 115 vs 114 | +0.8 [-4.2, +5.8] | 1 vs 5 | 116 vs 114 | +1.7 [-0.8, +5.0] | 2 vs 5 |
| H4 | 120 | 100 vs 101 | -0.8 [-6.7, +5.0] | 19 vs 19 | 120 vs 101 | +15.8 [+8.3, +24.2] | 0 vs 19 |
| H5 | 120 | 120 vs 120 | 0.0 | 0 vs 0 | 119 vs 120 | -0.8 [-2.5, 0.0] | 1 vs 0 |
| All | 600 | 479 vs 475 | +0.7 [-1.5, +2.8] | 34 vs 42 | 504 vs 475 | +4.8 [+2.0, +7.8] | 15 vs 42 |

## Why F5 alone does not move the seen share, and what all-on shows

The all-off control already sees 81% of the needed owner-phrase documents, almost all of them through `search`
(422 of 422 seen documents appear in a search result). With F5 alone, the derived links reach the agent only through
`get_backlinks` referrer rows: needed documents appear there 45 times, but agents call `get_backlinks` in only 58 of
324 cells, and those documents were mostly already found through search.

With F1's record lists on, F5's links do reach the agent. Needed owner-phrase documents appear as `entity` record
rows 79 times in round 1 all-on's H2-H4 cells, and 0 times in f1 and f1-no-names-row, which run F1 on F5-off slots.
Without F5 links a document that names the account only by an owner phrase cannot be one of the account's records.
On H2-H4 in round 1 (`r1-h2h4-seen-by-arm.json`) the seen share is 97.7% for all-on and 91.8% for f5. The arms
without F5 links are lower: control 90.6%, f2 90.1%, f4 88.3%, f1 86.0% and f1-no-names-row 82.5%. So F5 looks like
it pays off through F1's records. The plan sends that interaction to a free replay rather than a paid arm, and no
paid arm ran all-on with F5 off. These numbers don't show how much of all-on's gain needs F5, and they don't change
the gate, which reads the F5-only pair.

## Consequence under the plan

The plan's F5 fallback applies: F5 fails its gate, so the confirmation wave arm runs with `mentions.owner_phrases`
off, unless the owner decides otherwise before any confirmation cell. Then:

- **The wave config isn't the one measured.** Confirmation's wave arm would be all-on without F5. No development
  arm measured that config.
- **Pulling F5 commits would move the tested head.** The plan's packaging fallback takes F5's commits out of the
  Part 1 branch before merge, which changes the build away from the head development measured.

The preregistration (`docs/plans/2026-10-11-cat40-next-wave/PREREG.md` on `capy/cat40-next-prereg`) records this
decision point.

## Decision (2026-10-13)

Auto-approved under Garry's standing rule (2026-10-12) and relayed by GBRA-39's parent: **F5 is off in the
confirmation, and d1b is not overridden.** Overriding a preregistered gate after seeing its result would be a one-way
door, so the verdict stands. This record notes again that the plan never put numbers on the minimum effect or the
per-family margin, and that the verdict doesn't depend on them.

The remaining gap is that no development arm ran the exact confirmation config. One diagnostic arm fills it,
`all-on-no-f5`, on the Part 1 head with F5's commits removed. Its comparisons are declared before cells in
`../2026-10-13-cat40-dev-round-3/DECLARATION.md`. Whatever it shows, the confirmation's wave arm is all-on without F5.
