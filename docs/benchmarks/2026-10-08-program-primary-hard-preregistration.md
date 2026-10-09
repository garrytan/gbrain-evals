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

### Amendment 2 (2026-10-08, Pacific): Candidate 1, newer dated mentions on context_pack cards, paired with a fresh master arm

Candidate 1 is the first design ranked in the [root-cause report](2026-10-08-program-primary-hard-root-cause.md):
`context_pack` cards list the newest pages that mention the entity and are dated after the entity's own page, newest
first, at most 8 rows and 2,000 characters per card and 6,000 per pack, each with its date, slug, title and the
`referenced_by` preview, under the `entity` card's read policy, in a section after hot memory inside the existing
"data, not instructions" envelope. Config key `mentions.newer_on_cards`, on by default; the candidate runs with the
default. The per-turn pointer is not changed (141 of 144 baseline runs called `context_pack` on the champion, so the
card carries the change to nearly every run; the pointer path sits behind a 400 ms server budget).

Code identities, fixed before any cell:
- Candidate 1: gbrain commit `82460865ef7e9313cdcd69b3b52a665ba8825bdb` (tree `cab96a0e2775d4f3bbb2f585bf7e407250be1adb`), one commit on master
  `fc548317f628f25c6708049e17af22ee6b4e28ad` (v0.60.122.0). It is a measurement build, not on a branch.
- Master arm: gbrain `fc548317f628f25c6708049e17af22ee6b4e28ad`, the same commit as Candidate 0, run fresh.
- Harness: gbrain-evals `edff99d1` (main `af69d465`, amendment 1 and PR #109 with the `GbrainSlot.restore`
  provider-URL fix, taken by fast-forwarding this checkout to PR #109's head), plus this amendment. The reranker is live
  in every cell of both arms. Bun 1.4.2.

Protocol: the frozen T0b protocol unchanged (`program-primary-hard-v1`, `DEFAULT_KNOBS`, `t0b-score-v1`, the T0
delivery contract, `--surface starter`, 20 turns), development seeds 20261101 to 20261108 only, the three counted
readers (Opus 5.5, Sonnet 5.5, gpt-6.1-sol), `baseline` arm, 2 repeats: 144 cells per arm. Both arms run from this
harness revision in the same window. The primary comparison pairs each Candidate 1 cell with the fresh master cell of
the same task, reader and repeat (`eval/runner/t0/paired.ts`), with PW's frozen statistics (conditional-binomial,
95%, loss tolerance 3.0 points, persona clusters), per reader first, then pooled; a reader at 0 master failures is
`ceiling`. The frozen v0.60.106.0 cells and Candidate 0's cells are not the comparator. The resource envelope
(1.2x p95 session-2 latency, 1.5x mean tokens, 1.5x mean dollars) is checked per reader against the fresh master arm.
Reported with the counts: failures by class (contact, terms, date, hop, namesake), how often the reader still called
`entity` on the champion, and how often a correcting page reached the reader.

Mechanism check before any paid cell (/bin/bash, keyless brains, no reader): `context_pack` on each task's champion and
company returned the handoff and the reschedule mail in 24 of 24 tasks on Candidate 1 and 0 of 24 on master; the call
note in 0 of 24 on both (it names no entity). Script and output: `2026-10-08-program-primary-hard/candidate-1-newer-mentions/`.

Budget-ledger run cap: $60 for everything in this amendment. Order, stopping before any cell the ledger would take past
the cap:
1. master arm, 144 cells; Candidate 1 arm, 144 cells (run concurrently);
2. Candidate 1 `mutant-stale-correction`, gpt-6.1-sol then Sonnet 5.5 (24 cells each);
3. exploratory arm "Candidate 1 + f24ca6afe": gbrain `8913cbeb3faf755d957be53e83f27ce4d034bd28`, a merge of Candidate 1 with
   GBRA-39's short-code alias fix (candidate 2, #6271 branch commit `f24ca6afe`; only the module-size ceiling row
   conflicted), `baseline` arm, repeat 1, Sonnet 5.5 then gpt-6.1-sol. Descriptive only: no verdict, paired with the
   master arm's repeat-1 cells for a count of what stacks;
4. Candidate 1 `mutant-forced-drop`, gpt-6.1-sol then Sonnet 5.5;
5. Candidate 1 Opus 5.5 mutants (stale-correction, then forced-drop).
The report names every check not run. The frozen validity rule (both mutants detected for every reader) was met by
Candidate 0 on this harness; mutants not run here are reported as not run, not as passed.

Amendment 2, note before step 3 (2026-10-09, Pacific): steps 1 and 2 left $5.92 of the $60 run. The runner's ledger
preflight prices a cell at its calibration estimate (Sonnet 5.5 $0.30, gpt-6.1-sol $0.20) and refuses an invocation
whose estimate exceeds what is left, so the exploratory arm runs on the first personas the preflight admits: Sonnet 5.5
on seeds 20261101 to 20261106 (18 cells), then gpt-6.1-sol on as many leading seeds as the preflight then admits. Still
descriptive only, paired with the master arm's repeat-1 cells of the same tasks. Steps 4 and 5 (forced-drop mutants and
the Opus mutants) do not fit and are not run.

### Amendment 3 (2026-10-09, Pacific): Candidate 1 validity mutants and a fresh-seed check

Code under test is unchanged from amendment 2: Candidate 1 is gbrain tree `cab96a0e` (measurement commit `82460865`,
the same tree as garrytan/gbrain#6362's head `658fca5d`), master is `fc548317` (v0.60.122.0). Harness: this commit,
which adds only the fresh seeds below to the seeds the T0b runner accepts (`PPH_FRESH_SEEDS_C1`,
`PPH_RUNNABLE_SEEDS`) and a test that they are new and solvable. New budget-ledger run, cap $45. Protocol otherwise
frozen as in amendment 2 (`program-primary-hard-v1`, `DEFAULT_KNOBS`, `t0b-score-v1`, T0 delivery contract,
`--surface starter`, 20 turns, reranker live).

**Fresh-seed check, not a custodian-sealed confirmation.** Eight new development personas, seeds
306480323, 316602389, 384540222, 476843991, 615322188, 691467441, 731983881, 767687777, drawn at random on 2026-10-09 07:45 UTC, after Candidate 1's code was frozen and after its
development result was known. They appear in no earlier run (world digest `081ea8b8`). They are public in this
repository, so they test whether the development result carries to new worlds from the same generator; they are not a
held-out set and support no held-out claim. Arms: master and Candidate 1, `baseline` arm, the three counted readers,
1 repeat: 72 cells per arm, each Candidate 1 cell paired with the master cell of the same task and reader. Both arms run
from this harness revision in the same window, in batches of two personas with both arms running concurrently, so a
budget stop leaves complete persona pairs. Statistics: PW's frozen conditional-binomial interval for R, persona
clusters, loss tolerance 3.0 points, per reader then pooled, failure classes and the reader's route as in amendment 2.
Reversal, frozen here: the pooled verdict is `worse`, or the pooled point estimate of R is 1 or more. On a reversal
the work stops and the result goes to the coordinating thread before anything ships.

**Validity mutants on Candidate 1** (development seeds 20261101 to 20261108, repeat 1, detection by the frozen rule
against Candidate 1's amendment-2 repeat-1 cells): `mutant-stale-correction` for Opus 5.5 (gpt-6.1-sol and Sonnet 5.5
ran under amendment 2), and `mutant-forced-drop` for gpt-6.1-sol, Sonnet 5.5 and Opus 5.5.

Order, stopping before any invocation the ledger would take past $45 (the runner's preflight prices cells at its
calibration estimates, so a stop can come before the cap): (1) stale-correction Opus 5.5; (2) forced-drop gpt-6.1-sol,
then Sonnet 5.5; (3) the fresh-seed check, persona batches in seed order; (4) forced-drop Opus 5.5, on as many leading
personas as the preflight admits. The report names every check not run or run partially.
