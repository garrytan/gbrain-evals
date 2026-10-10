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

### Amendment 4 (2026-10-09, Pacific): does the short-code alias fix stack on Candidate 1? "master (candidate 1)" vs "master + alias fix"

Candidate 1 now ships on master (gbrain v0.60.126.0, #6362). This amendment measures whether GBRA-39's short-code alias
fix (garrytan/gbrain#6271, a draft) lowers failures further when added to current master. Amendment 2's exploratory arm
(18 Sonnet cells, 10 to 6 to 1) is the reason to run it; it is descriptive and is not part of this comparison.

Code identities, fixed before any cell:
- **"master (candidate 1)"**: gbrain master `dda603ac9e152be45afd6f4edd3789bc11e000b8` (v0.60.130.0, tree
  `4d3f4292cb9dc69586c6b3ed8d31be6c78383cc2`), which carries Candidate 1 on by default.
- **"master + alias fix"**: gbrain `9ac26bea780e15cb660b2f29691613fcad5d0bf6` (tree
  `41f95308fc901fbafd95e4f53c14d709d9fdac60`), a merge commit on no branch: first parent `dda603ac`, second parent
  `f24ca6afe3f60fd5c4aaf2b475f36417cf74a14f`, the commit on #6271's branch `capy/cat40-hard-fix` that adds the short-code
  rule (a 2 or 3 character code an entity page declares for itself, "Also called JOF in my notes", becomes one of its
  names and links case-sensitively as a whole token). Merging that commit brings all of #6271 up to it (27 commits:
  the declared-name grammar, identity siblings, `match: "keyword"` paging and counts, generated-page demotion, date
  labels on search rows, opaque `request_id`s and the rest), so this arm measures #6271's content at `f24ca6afe`, not
  the short-code commit alone. The branch's later head `9bba4da4` (`entity` `names[]`, which changes the starter
  surface's `entity` schema) is excluded, so readers see the same tool list as on the alias commit. Conflicts were
  resolved without behaviour changes: #6271's migration v223 (`persistence_client_request_id`) is renumbered v225 after
  master's v223 and v224, generated registry and goldens regenerated, module-size ceilings raised to the merged sizes,
  both sides' behaviour-change rows and CHANGELOG entries kept. Typecheck passes on the merge.
- Harness: this commit (gbrain-evals main `8cbc61f7` plus this amendment, the fresh seeds below in
  `PPH_FRESH_SEEDS_ALIAS` and `PPH_RUNNABLE_SEEDS`, a test that they are new and solvable, and the $0 probe script
  `2026-10-08-program-primary-hard/alias-stack/alias-probe.ts`). Bun 1.4.2. The runner's fail-closed rerank probe
  (from #109) runs on every slot before any cell of every invocation; reranking is live in both arms.

Mechanism check before any paid cell ($0, keyless brains of the eight development personas, no reader), with
`alias-probe.ts`: `context_pack` on each task's champion and company carries the call note with the corrected terms in
21 of 24 tasks on "master + alias fix" and 0 of 24 on master; the handoff and the reschedule mail in 24 of 24 on both.
The 200 company pages declare 200 codes; 197 became names of the page that declared them, and no 2 or 3 character
name landed on a page that did not declare it. The 3 codes not derived are `ONE` and `THE` (twice), on the short-code
stoplist. The 3 tasks whose call note stays unlinked are one company coded `THE` and two whose code a second company
in the same brain also declares (`BRL`, `PRF`); a code two pages declare links to neither.

**Protocol.** The frozen T0b protocol unchanged (`program-primary-hard-v1`, `DEFAULT_KNOBS`, `t0b-score-v1`, the T0
delivery contract, `--surface starter`, 20 turns), `baseline` arm only, the three counted readers (Opus 5.5,
Sonnet 5.5, gpt-6.1-sol). Each "master + alias fix" cell is paired with the "master (candidate 1)" cell of the same
task, reader and repeat (`eval/runner/t0/paired.ts`), both arms run from this harness revision in the same window.
Statistics: T0b's frozen ones (PW's conditional-binomial interval for the failure-risk ratio R, alias over master,
95%, persona clusters, loss tolerance 3.0 points, decision rule `ceiling`, `10x`, `improvement`, `worse`,
`inconclusive`), per reader first, then pooled; a reader at 0 master failures is `ceiling`. Two comparisons, reported
separately:
1. **Development**: seeds 20261101 to 20261108, every pair run (repeat 1 for all eight personas; repeat 2 for the
   leading personas the budget admits, step 3 below).
2. **Fresh seeds**: eight new personas, seeds 124371926, 196299785, 253035751, 446884266, 500901660, 560317357,
   746355681, 868827636, drawn at random on 2026-10-09 at 13:44 UTC after the measurement build above was frozen, never
   used before (none appears in this repository as a seed). Repeat 1, 72 pairs. They are public development seeds,
   not a custodian-sealed set, and support no held-out claim.

The alias fix "stacks" if the development pooled verdict is `improvement` and the fresh-seed pooled point estimate
of R is below 1. Reported with the counts: failures by class (contact, terms, date, hop, namesake), the resource
envelope per reader (1.2x p95 session-2 latency, 1.5x mean tokens, 1.5x mean dollars, alias over master), how often
the call note with the corrected terms reached the reader through a `context_pack` result (each session-2
`context_pack` call re-executed on keyless rebuilds of that arm's brains, $0) and through an opened page, and the
probe's alias table on the fresh brains.

**Budget and order.** New budget-ledger run, cap $70. Stop before any invocation the ledger or the runner's preflight
(calibration estimates: Opus 5.5 $0.60, Sonnet 5.5 $0.30, gpt-6.1-sol $0.20 per cell) would take past the cap:
1. development, repeat 1, both arms concurrently (72 cells each);
2. fresh seeds, repeat 1, both arms concurrently, in batches of two personas in seed order, so a stop leaves complete
   persona pairs;
3. development repeat 2, both arms concurrently, in batches of two personas in seed order, as far as the budget admits.
No validity mutants run (Candidate 1's were all detected on this harness under amendments 2 and 3). The report names
every step not run or run partially.

Amendment 4, note before further cells (2026-10-09, Pacific): steps 1 and 2 ran in full and step 3 ran on seeds
20261101 and 20261102 before the $70 run stopped (ledger run `t0b-program-primary-2026-10-09T13-52-11-329Z-b10c88bb`,
$61.78). Garry's standing rule for development rounds is that planned repeats are not left unrun for budget, so a
second budget-ledger run, cap $60 (reallocated inside the approved $420 from candidate 3's unused slot), runs the rest.
Code identities, harness revision, protocol, statistics and the "stacks" criterion are unchanged. Order, stopping
before any invocation the ledger or the runner's preflight would take past $60:
4. development repeat 2 on seeds 20261103 to 20261108, both arms concurrently, in batches of two personas in seed
   order; the development comparison then covers all 144 pairs;
5. validity mutants on "master + alias fix", development seeds, repeat 1, one invocation per mutant and reader:
   `mutant-stale-correction` for gpt-6.1-sol, Sonnet 5.5 and Opus 5.5, then `mutant-forced-drop` in the same reader
   order. Detection follows the frozen rule against the alias arm's own repeat-1 cells (`eval/runner/t0/analyze.ts`:
   persona-clustered risk difference, 95% lower bound above 0; the stale-correction mutant must also raise
   `stale_correction` above the baseline's).
The rerank probe runs on every slot of every invocation. The report names any step not run or run partially.

### Amendment 5 (2026-10-10, Pacific): generator version 2 and the custodian-sealed confirmation, shipped stack vs the frozen release

This amendment is written before any version 2 world is run by a reader, before any sealed seed exists and before the
stack build exists. It fixes the held-out comparison this preregistration promised ("A held-out seed is minted later
by the custodian"). The executor appends values that do not exist yet (stack SHA, commitment, world digest, VM name,
ledger run ids, the run-day model check) under "Recorded before sealed cells" and changes nothing else. Any other
change before the verdict gets a dated note with its reason.

**Generator version 2.** Version 1 builds each company's short code from its name alone and never checks codes against
each other, so across the 16 development and fresh-seed brains 20 codes are declared by two or three companies
(alias-stack report, 2026-10-09). A note about either company then names neither, for a person reading it as much as for gbrain: the
workload, not memory, made those notes ambiguous. Version 2 (`program-primary-hard-v2`, `V2_KNOBS` =
`DEFAULT_KNOBS` plus `unique_codes: true`) draws company names so that every code is unique within a brain and never
one of 32 reachable codes that are English words, common names or business abbreviations (`CODE_STOPWORDS`, for
example `THE`, `CAR`, `CAC`). It keys the reschedule and handoff mail ids by company as well as last name, because two
champions can share a last name under the new draw. Nothing else changes: task kinds, facts, traps, knobs and the
scorer (`t0b-score-v1`) are version 1's. Version 1 worlds are byte-identical (the baseline digest `dccafc6f…` is
pinned in a test). Version 2 is chosen for the sealed set because the comparison is meant to measure memory; a brain
where one code means two customers is tested separately later, in its own item with a known right answer.

**Arms.**
- `frozen`: gbrain v0.60.106.0, `7aa2caa0`, the program's scope pin.
- `stack`: gbrain master at the merge commit of garrytan/gbrain#6271, which carries Candidate 1
  (`mentions.newer_on_cards`, #6362, default on) and #6271's short-code alias rule. If #6271 merges without the
  short-code rule, or with it off by default, no sealed cell runs and this amendment gets a note first.

**Protocol.** Unchanged from this preregistration: `t0b-score-v1`, the T0 delivery contract, `--surface starter`,
20 turns, `baseline` arm, readers Opus 5.5, Sonnet 5.5 and gpt-6.1-sol. On run day the newest frontier model of each
family is checked; a newer one replaces its predecessor and is recorded below before any cell. Fable never runs.

**Size.** This preregistration's rule recomputes the persona count at the measured baseline rate (74 of 144,
51.4%) for a candidate whose true factor is 20, with 3 tasks per persona, 3 readers and 2 repeats. PW's simulation
(`risk-ratio.ts` `simulate`, conditional-binomial, scenario `null-central` at that rate, 600 simulations, seed
20261010) gives P(`10x`) = 0.45 at 16 personas, 0.67 at 24 and 0.82 at 32, so the sealed set has **32 personas**
(96 tasks, 576 pairs). For a true factor of 15 the same design gives 0.38, and for 12 it gives 0.09; P(`improvement`
or better) is 1.00 at every size and factor in that table. A `10x` verdict therefore needs both a large true effect
and this sample. The factor is published whatever it is.

**Statistics and claims.** Each `stack` cell is paired with the `frozen` cell of the same task, reader and repeat
(`eval/runner/t0/paired.ts`): R = stack failures over frozen failures, PW's conditional-binomial 95% interval, persona
clusters, loss tolerance 3.0 points, decision rule `ceiling`, `10x`, `improvement`, `worse`, `inconclusive`, per reader
first and then pooled. The pooled verdict is the program primary's held-out verdict. The resource envelope is checked
per reader (stack over frozen: p95 session-2 latency at most 1.2x, mean tokens and mean dollars at most 1.5x). Claims,
frozen here:
- "10x fewer end-to-end memory failures than v0.60.106.0" only if the pooled verdict is `10x`, the envelope holds for
  every reader and the run is valid (below).
- Otherwise the factor and its interval are published as measured ("N-fold, 95% interval L to U"), with the verdict.
- `worse`, or a pooled point estimate of R at 1 or more, is published as a reversal of the development results.
- gpt-6.1-sol failed 1 of 48 frozen development runs, so it is expected near `ceiling`; it is reported, not dropped.

**Validity.** The two frozen mutants run on the `stack` arm for personas `sealed-01` to `sealed-08`, repeat 1, all
three readers. Detection uses the frozen rule against the `stack` arm's own repeat-1 cells of those personas. The run
is valid when both mutants are detected for every reader and at least 90% of counted cells are scored; an invalid run
supports no claim and is reported as invalid.

**Gates before sealed cells.**
1. `$0` scripted smoke of both builds on a version 2 development world (`--knobs '{"unique_codes":true}'`): every arm
   scored, no harness error, the scripted oracle passing.
2. Paid development smoke on the `stack` build only: version 2 development seeds 20261101 to 20261108, repeat 1, the
   three readers (72 cells, own ledger run, cap $15). It checks the paid path end to end on the exact build (rerank
   probe on every slot, at least 90% of cells scored, no harness error). Its failure counts are descriptive and stop
   nothing.
3. The world regenerated on the custody VM from the copied file has the digest recorded below, and its commitment
   matches the one recorded at minting.
4. The runner's fail-closed rerank probe passes on every slot of every invocation.

**Custody.** The custodian is Garry. On his Mac (`machine_01M2K118ET0PN09PQ9R8CNJ5Z3`), at this repository's commit
recorded below: `bun eval/generators/program-primary-hard-gen.ts --mint-sealed --personas 32 --custodian-out
<custody dir outside the repository>` writes 32 random seeds to a 0600 file and prints only their commitment, then
`--custodian-seeds <that file> --out <dir outside the repository>` renders the world (personas `sealed-01` to
`sealed-32`, no seed in it) and prints its digest. Both values are recorded below before the world leaves the Mac. The
world file goes to one Ubicloud VM owned by `gbra60` (the custody VM, named below), crossing one Capy cloud machine in
transit, and is deleted there once the VM holds it. It never touches Capy Drive or git. Every sealed cell runs on the
custody VM; the runner reads the world with `--world <file> --expect-digest <digest>` and refuses a world inside the
repository. The seed file never leaves the Mac. After the verdict, the outputs (results, receipts, experiment records,
paired statistics and transcripts) are copied to the report and the VM is destroyed; the 32 seeds are then spent and
support no later held-out claim. No gbrain change is tuned on sealed tasks.

**Budget and order.** Inside the approved $420 round, $125.55 is spent (alias stack $111.46, Cat 41 re-baseline
$14.09). The development smoke takes its own ledger run (cap $15). The sealed run takes a new ledger,
`.budget/t0b-sealed-confirm.sqlite`, cap $265: the $180 sealed slot plus $85 of candidate 3's unused slot. From the
alias-stack cells (Opus 5.5 $0.29, Sonnet 5.5 $0.17, gpt-6.1-sol $0.09 per counted cell; mutant cells slightly more),
576 cells per arm cost about $200 and the mutants about $28, so about $230 expected. Order, stopping before any
invocation the ledger or the runner's preflight would take past the cap:
1. personas `sealed-01` to `sealed-08`: both arms concurrently, repeats 1 and 2, then the two mutants;
2. personas `sealed-09` to `sealed-32` in batches of eight, both arms concurrently, repeats 1 and 2.
A stop leaves complete personas in both arms; the verdict is then computed on the complete personas and the report
says how many ran.

**Recorded before sealed cells.** (Appended by the executor.)
