# Cat 40 Hard calibration record

This file records every calibration round of the Hard generator: the knobs, the reason for each change, per-model and per-family results, stop kinds, oracle-failure classification and cost. The freeze-rule analyzer appends its table for each round (`bun eval/runner/cat40/analyze.ts <results.jsonl> --freeze-rule --round N --calibration-md docs/benchmarks/cat40-hard/calibration.md`). Rules: [RUNBOOK.md](RUNBOOK.md#calibration-rules).

Calibration uses seed 20261005, 10 tasks per family from a world generated at the held-out density of 20 per family (the first 10 of each family, the same indices every round), fs, pg and oracle, 1 repeat, `--judge gpt-6.1-sol`. gbrain never runs on this seed.

## Round plan

| Round | Knob file | Change from the previous round and why | Result |
|---|---|---|---|
| 1 | [knobs.round-1.json](knobs.round-1.json) (knobs.default.json) | starting values: 16 turns, 10 to 40 H1 members, 3 to 6 H2 changes, 1 to 3 H3 look-alikes, 3 to 5 H4 sources, one look-alike fact in each H5 chain | stopped at 189 of 300 cells on its $38 budget run; H2 and H3 at 100% on fs and pg; two H1 answer-key defects (below) |
| 2 | [knobs.round-2.json](knobs.round-2.json) | 2026-10-05: H2 and H3 far too easy (fs 20/20 each); record counts, history length and distractors for those two families raised; background accounts lowered to hold world size; H1, H4, H5, noise and the turn cap unchanged (details below) | not run |

## Round 1 (2026-10-05)

World: seed 20261005, knobs.round-1.json, generator at `19b36fe`. Models Sonnet 5.5 and GPT-6 Astra, arms fs, pg and oracle, `--judge gpt-6.1-sol`, 10 tasks per family. The run stopped at 189 of 300 cells when its $38 budget run was spent: $35.18, about 2.2 to 5 times the v1 cost per cell (fs $0.253, pg $0.217, oracle $0.057 pooled). Cells ran in task order, so H4 has only 2 to 4 cells per arm and H5 none; the freeze rule was not evaluated.

| Arm | H1 | H2 | H3 | H4 | H5 |
|---|---|---|---|---|---|
| fs | 15/20 | 20/20 | 20/20 | 2/2 | not run |
| pg | 17/20 | 20/20 | 20/20 | 3/3 | not run |
| oracle | 16/20 | 20/20 | 20/20 | 4/4 | not run |

Stops: 187 `submitted`, 2 `turn_cap` (GPT-6 Astra fs, Sonnet 5.5 pg); no `error`, `context_overflow` or `harness_error`. Cost per cell by family shows where the money goes: H1 fs cells cost $0.65 on average, H2 to H4 cells $0.04 to $0.08.

### Answer-key defect: a renamed account's later records used its old name

Both oracle models missed the same member on H1-05 (a set of 21) and gave 30 for H1-10 (key 31). Both questions ask for accounts with an open escalated ticket and a renewal within 90 or 120 days on 2026-09-15, and the missing account is the same one: an H3 "renamed" account (former name and code PRRL, renamed on 2026-06-06). Its renewal amendment named the new name. Its ticket opened on 2026-07-12, five weeks after the rename, still named the old name, because the generator rendered every timeline document with the name the account had when its timeline was drawn. The H1 oracle evidence held both documents but not the rename notice, so nothing in the evidence tied the two names to one account. The answer key, computed from the ledger, counted it. Two models agreeing on the same miss pointed at the generator, not the models.

Fix (generator, before any freeze):

1. Records an account's own timeline writes on or after its rename date use the new name and code, as the rename notice says ("records from now on use the new name"); earlier records keep the old ones.
2. H1 oracle evidence includes the rename or merger notice of every member and near miss whose names differ across its records.
3. A merged account's names map to the account it merged into, so its tickets count for that account in H1, and its contract carries that account's renewal date (its own renewal amendment is not written). The previous generator kept them apart: a second case of the same defect, which caused none of round 1's oracle failures.
4. H1 predicates whose answer turns on a boundary a reader can take either way are not drawn: an owner change or a ticket event dated exactly on the as-of date, or a renewal on the first or last day of the window (or one day past it), for an account that holds every other clause.

Regression tests in `test/eval/cat40-hard.test.ts`: "round-1 defect (H1-05, H1-10) ...", "a merged account's tickets count for the account it merged into ...", "no H1 member turns on a boundary ...". The fix changes the calibration world, so round 1's cells stay as recorded and are not resumed; round 2 runs on the fixed generator.

Unresolved answer-key defects after this fix: none known. Round 2's oracle failures are read before any further knob change.

## Round 2 knobs (2026-10-05)

Target: H2 and H3 well below their round-1 100%, pooled fs within 40-70%, H1 and H4 about where they are. Changes, in knob-priority order:

| Knob | Round 1 | Round 2 | Group | Reason |
|---|---|---|---|---|
| `h3_lookalikes_min` / `max` | 1 / 3 | 3 / 5 | record counts | every H3 answer took one lookup among one to three look-alikes; three to five accounts sharing the name or code prefix mean more contracts to read and more chances to take a look-alike's value |
| `h2_changes_min` / `max` | 3 / 6 | 6 / 10 | history length | three to six change orders were read without error; six to ten puts more intermediate values between the question date and today |
| `h2_correction_rate` | 0.4 | 0.7 | history length | most changes now have a backdated correction, so the value in effect has to be resolved against later documents |
| `h2_intermediate_notes` | 2 | 4 | distractor rate | more confident agent notes stating superseded values |
| `accounts` | 110 | 75 | noise (size) | the extra look-alike accounts and change orders add about 600 documents; 35 fewer background accounts keep the world at about 4,500 documents and the H1 population at about 260 accounts (256 in round 1), so H1 set sizes stay in the same range |

Unchanged: H1 member counts, H4 sources and long-document rate, H5 noise sessions, emails, meetings, transcripts, tickets, handoffs, wrong-note rate, team updates and the 16-turn cap. If round 2 still leaves H2 or H3 above 80% on fs, these families' knobs are at their useful range, and the next lever is a generator change to how the question is asked (for example, a disambiguating fact that itself needs a lookup), which is allowed before the freeze and is recorded here first.

## Notes after the freeze

Dated notes for runner or scorer fixes that leave every world digest unchanged (CEO-F17, ENG-F6).

## Analyzer output
