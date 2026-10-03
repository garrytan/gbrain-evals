# Preregistration: the categories after gbrain fix wave 7 (2026-10-03)

Frozen on October 3, 2026, in its own commit, before any run at gbrain `48ed5e8`. Nothing below changes after a run; a later change gets a new dated file.

## The question

gbrain fix wave 7 ([garrytan/gbrain#5908](https://github.com/garrytan/gbrain/pull/5908), v0.60.32.0) merged to gbrain master as `48ed5e8233f617479df989998560840747af0425`. It says it fixes or closes these entries of the [bug ledger](2026-10-01-wave-bugs.md): N2 (judge prompt version 4 for undated and same-day conflicts), N7-2, N7-5, N7-6, N7-7, N9-5, N12-6, N13-8 and A4-2. Does a rerun here show each change, and what else moved?

**Before** is gbrain `d44296cf4d6481a10eb85562d3179e38cfd02c43` (v0.60.30.0), using the receipts of the [October 2 re-pin](2026-10-02-wave-repin.md) and the [October 2 CI slices](2026-10-02-ci-slices.md). **After** is gbrain `48ed5e8`, loaded the same way (a copied overlay, `--gbrain <checkout>@48ed5e8233f617479df989998560840747af0425`), on Bun 1.4.2.

## What runs, with which settings

Each runner uses the command in the October 2 re-pin report, with the new `--gbrain` value and nothing else changed: seeds, generators, world files, top-k, judge model, engines and transports.

| Category | Arms | Before receipt |
|---|---|---|
| N2 contradiction surfacing | hermetic; paid (judge prompt v4) | October 2 hermetic and paid receipts at `d44296c` |
| N7 open loops | hermetic | October 2 receipt |
| N9 multi-hop | hermetic; paid; one-hop `relational-ab` paid | October 2 receipts |
| N12 format fidelity | hermetic, seeds 12 and 7 | October 2 receipts |
| N13 code intelligence | hermetic | October 2 receipt |
| A4 abstention | hermetic and paid, at both `d44296c` and `48ed5e8` | none at `d44296c` (A4 was last run on October 1 at `3a284ae`), so this rerun measures both sides |
| N1 and N5 CI slices | `--slice ci` | October 2 CI-slice receipts |
| Ledger repros | every repro listed in `2026-10-02-wave-repin/repros-d44296c.txt` | that file |

N1, N5 full runs and N8 are not rerun: wave 7 changes no entry they own.

## The one setting that changes: the N2 probe budget

**Before:** `PROBE_BUDGET_USD = 6`, split over 4 concurrent probe runs, so each run stops after $1.50 of judge spend.

**After:** `PROBE_BUDGET_USD = 10`, so each run stops after $2.50. `PAID_ESTIMATE_USD` (the reservation estimate for the arm) moves from 4 to 8.

**Why, from evidence available before this run.** On October 2 the four probe runs judged 672, 665, 665 and 665 pairs, and the arm cost $6.24 for 2,761 judge calls, about $0.00226 per call. So each run needed about $1.50, and one hit its cap with 13 pairs unjudged. Prompt version 4 adds 777 characters (about 200 tokens) of instructions to every judge call, about $0.0002 more per call at Haiku 4.5's $1 per million input tokens. At $0.00246 a pair, a 672-pair run needs about $1.65, so a $1.50 cap would stop every run short and leave roughly 10% of each run's pairs unjudged. That would make the after numbers depend on where the cap fell. $2.50 a run leaves about 50% headroom.

**What this does not change.** The probe budget is a stop condition. The judge, its model, the offered pairs, the gold and the scorer are unchanged, and pairs a capped run never reaches would still count as misses in every end-to-end denominator, as before. No decision rule changes: recall on offered conflicts at least 0.80, false contradictions on offered dated changes at most 0.10 and on offered compatible negatives at most 0.10 ([N2 and A4 preregistration](2026-10-01-n2-a4-preregistration.md)).

**Repeat control.** Because the before receipt ran with the old cap, and because one Haiku sample per pair varies from run to run, the prompt version 3 arm is run once more at `d44296c` with the new $10 budget, after the version 4 arm and only if the spend allows (estimate $6.50). It is reported beside the before and after numbers as a measure of run-to-run variation. The preregistered before is still the October 2 receipt.

## Spending

All paid requests go through one budget-ledger run capped at $30, the task's limit. Estimates, from the October 1 and 2 receipts: N2 paid v4 about $7; N2 repeat control about $6.50; A4 paid about $1.15 per commit; N9 paid and `relational-ab` paid about $0.07 each. Total about $16. The repeat control runs last and is skipped if the remaining budget is below $8.

## Gates and the ledger

- No threshold moves. A gate changes only where a rule in `eval/registry.ts` or a frozen hold says so. Before any run, no row's frozen condition names a wave 7 entry: N7, N12, A4 and N2 already gate, N9 and N13 have no gating rule, and N8 needs a new preregistration that this release does not make.
- A bug that reruns clean becomes `fixed` with `fixing_pr` #5908 and `fixing_commit` `48ed5e8233f617479df989998560840747af0425`. A feature gap that gbrain closes on purpose becomes `closed`, never `fixed`, as `eval/runner/bug-ledger.ts` requires. An entry that still reproduces keeps its status with a dated review.
- A4-4's frozen scoring rule stays for this run; its alternative reading is reported as the same unregistered sensitivity number as on October 1.
