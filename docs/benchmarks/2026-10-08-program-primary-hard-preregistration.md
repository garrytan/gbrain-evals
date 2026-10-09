# Preregistration: the program primary, harder workload (T0b)

Frozen on October 8, 2026 (Pacific), in its own commit, after calibration and before any cell of the T0b
development baseline. It is the successor to the
[T0 preregistration](2026-10-08-program-primary-preregistration.md). T0's baseline showed that workload at its
ceiling: no counted reader failed a run on a human reading
([T0 baseline](2026-10-08-program-primary-baseline.md)). T0b keeps T0's target user, failure definition, carrier,
delivery contract, loss tolerance, resource envelope, statistics and decision rule. It replaces the workload.
Changes after this commit are amendments, appended at the bottom and committed before any cell they govern.

Code:
- `eval/generators/program-primary-hard-gen.ts` (`program-primary-hard-v1`, knobs `DEFAULT_KNOBS`);
- `eval/runner/t0b-program-primary.ts` (runner and mutant brains);
- `eval/runner/t0/score.ts` `scoreItems` (`t0b-score-v1`);
- registry entry `program-primary-hard` (T0b), which uses T0's rules (`PROGRAM_PRIMARY_RULES`).

## What T0b changes

The workload is still cross-session meeting or reply preparation after a correction. These are the levers the T0
report named:

| Lever | T0 | T0b |
|---|---|---|
| Cue to look | session 2 named the one contact | session 2 asks for a reply to the champion and "our procurement lead" (unnamed), or a prep brief, and never mentions the brain or names a page |
| Counterparties | one contact | the champion, the procurement contact and the company; the champion has a namesake at another company, the company has a namesake sharing its first word, notes use short codes ("YAR") and nicknames ("Elo") |
| Brain size | 73 pages | 919 pages per persona (25 customers, 8 investors and advisors, about 130 meeting notes, 460 mail threads, 150 daily notes) |
| Where corrections land | the user told the agent; the agent edited the pages | the meeting move is in a later mail thread, the corrected seat count or price in a later call note; person, deal and meeting pages keep the old values |
| Commitments | one, told in session 1 | two, both required: one the user asks to save in session 1, and one made in a technical review about the company that the champion did not attend (a hop: person, company, review) |
| Time | none | a dated mail says procurement moves from one person to another "starting <date>", which is before today; the old contact's page still says procurement lead |

A failure is still an unsupported or stale answer or action, or a missed commitment. Under `t0b-score-v1` a run
fails when any of these holds:
- either commitment is missing;
- the old meeting date appears without the new one, outside a change context;
- the old figure appears without the corrected one;
- the superseded procurement contact is named without the current one (for example, addressed in the reply);
- a namesake's value appears outside a line that tells the two apart;
- or session 2 ended in an error.

These are the `t0-score-v3` rules applied to every item. They were written after reading T0 outputs, and T0b
adopts them before any T0b baseline cell runs.

## Calibration (development seeds 20261109 to 20261114 only)

The goal was a baseline failure rate of roughly 20% to 50% across the three counted readers on the frozen release
(gbrain v0.60.106.0, `7aa2caa0`). Every round ran 2 personas x 3 tasks x 3 readers, baseline arm, one repeat. Rounds
were budget-ledger run `t0b-program-primary-2026-10-08T23-30-25-746Z-d7a1d492`; receipts are in
[`2026-10-08-program-primary-hard/calibration/`](2026-10-08-program-primary-hard/calibration/).

| Round | Seeds | Knobs changed | Opus 5.5 | Sonnet 5.5 | gpt-6.1-sol | Pooled | Cost |
|---|---|---|---:|---:|---:|---:|---:|
| 1 | 20261109, 20261110 | session 1 mentions the second promise in passing, with no request to save it | 6/6 | 6/6 | 6/6 | 18/18 | $4.05 |
| 2 | 20261111, 20261112 | session 1 asks to note the promise in the brain | 4/6 | 4/6 | 0/6 | 8/18 | $3.49 |
| 3 | 20261113, 20261114 | none (round 2's knobs on new seeds) | 3/6 | 3/6 | 0/6 | 6/18 | $3.30 |

**Round 1** failed every run on the missed session-1 promise. No reader wrote it down when the user mentioned it in
passing: 0 of 18 session-1 runs made a write call. That is a real product finding about unprompted capture at this
release, but it makes the workload all-or-nothing. **Rounds 2 and 3** capture the promise in 36 of 36 runs. Their
failures are stale procurement contacts (the reply greets the person who handed procurement off), stale terms from
the deal page, and stale meeting dates. We read every round-2 failure and each is a real error under the definition.
gpt-6.1-sol failed 0 of 12 in rounds 2 and 3, so it may sit at its own ceiling here; it is reported, not excluded.

**Frozen knobs** (`DEFAULT_KNOBS`): 3 tasks per persona, session 1 `explicit`, scale 1, hop on, supersession on.
Generator `program-primary-hard-v1`. The calibrated pooled rate is 14 of 36 (38.9%).

## Workload and task distribution (frozen)

The development baseline runs on seeds 20261101 to 20261108 (`PPH_BASELINE_SEEDS`), disjoint from the calibration
seeds. That is 8 personas x 3 tasks = 24 tasks: 16 reply (10 price corrections, 6 seat corrections) and 8 prep
(4 price, 4 seats). World digest `dccafc6f7cc28c44ce5f255713762739359f1f76ab526d99975707fedfe8504a`. A held-out
seed is minted later by the custodian, as for T0. Calibrating on development seeds is not tuning on test data.

## Arms (frozen)

| Arm | Brain and hooks | Readers |
|---|---|---|
| `baseline` | base brain; hooks as in the T0 delivery contract | Opus 5.5, Sonnet 5.5, gpt-6.1-sol, 2 repeats |
| `mutant-forced-drop` | session 1 on the base brain; session 2 on a fresh brain without any item doc (move thread, call note, handoff, review note), hook output dropped: no item arrives and session 1's writes are gone | all three, 1 repeat |
| `mutant-stale-correction` | both sessions on a brain without the correction docs (move thread, call note, handoff): the corrections never land; the commitments do | all three, 1 repeat |
| `ablation-push-off` | base brain, hook output dropped in both sessions | all three, 1 repeat |

Mutant detection uses T0's rule per reader: the persona-clustered risk difference against the same reader's
baseline repeat-1 cells, with a 95% lower bound above 0. The stale-correction mutant must also raise
`stale_correction` or `stale_date` above the baseline's. A run counts when both mutants are detected for every reader
and at least 90% of cells are scored.

## Statistics, tolerance and envelope (unchanged from T0)

The loss tolerance stays 3.0 points and is never widened. The envelope stays 1.2x p95 session-2 latency, 1.5x mean
tokens and 1.5x mean dollars against this baseline. The statistics are unchanged: PW's conditional-binomial interval
for the pooled failure-risk ratio, with the decision rule `ceiling`, `10x`, `improvement`, `worse`, `inconclusive`.
The factor is published whatever it is.

**Sample size.** PW's helper at the calibrated rate (38.9%), with 3 tasks per persona, 3 readers and 2 repeats, puts
P(`10x`) at 0.80 or more, for a candidate whose true factor is 20, at 40 personas (0.82; 32 personas give 0.70).
The rule for the candidate comparison, frozen here: recompute that number at the rate this baseline measures. The
held-out comparison then runs at that persona count, or at the largest the custodian can mint if that is smaller,
and its verdict may be `inconclusive` by design.

## Budget

The ledger run above is capped at $110. Calibration spent $10.84. The baseline plan is 144 baseline cells, 72
cells per mutant and 72 ablation cells. Measured calibration costs (Opus about $0.32, Sonnet $0.16, gpt-6.1-sol
$0.08 per cell) put it near $60. If the ledger would cross the cap, cells drop in this order: the ablation's
gpt-6.1-sol and Opus cells, then the baseline's second repeat.

## Amendments

### Amendment 1 (2026-10-08, Pacific): Candidate 0, a measurement of current gbrain master

Candidate 0 is gbrain master at `fc548317f628f25c6708049e17af22ee6b4e28ad` (v0.60.122.0), measured as it ships. It is
a measurement of current master, not a tuned candidate: nothing in gbrain or in this harness is changed for it, and it
carries no claim that a change was made to fix T0b. It runs the frozen protocol unchanged (`program-primary-hard-v1`,
`DEFAULT_KNOBS`, `t0b-score-v1`, the T0 delivery contract, `--surface starter`, 20 turns) on the same development
seeds 20261101 to 20261108, with the three counted readers (Opus 5.5, Sonnet 5.5, gpt-6.1-sol), the `baseline` arm,
2 repeats: 144 cells. Each candidate cell is paired with the v0.60.106.0 baseline cell of the same task, reader and
repeat. The statistics are PW's frozen ones (`eval/runner/power/risk-ratio.ts` `decide`, conditional-binomial, 95%,
loss tolerance 3.0 points, persona clusters), reported per reader first, because gpt-6.1-sol sits near its ceiling
(1 of 48), then pooled over the three readers; a reader at 0 baseline failures is reported as `ceiling`. The
resource envelope (1.2x p95 session-2 latency, 1.5x mean tokens, 1.5x mean dollars) is checked per reader. After the
baseline arm, with whatever budget remains, both mutants run once on master as the validity check; if the ledger
would cross its cap, mutant cells drop in this order: forced-drop Opus, forced-drop Sonnet, stale-correction Opus,
then the rest, and the report names any check not run. Budget-ledger program cap: $60, shared with the $0-intent
replay of recorded tool calls used for the root-cause report. Dev seeds only; no sealed seed is opened.
