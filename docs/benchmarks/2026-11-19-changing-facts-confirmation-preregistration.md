# Changing-facts confirmation preregistration (BG1-C): does gbrain's newest release now lead the two leading memory servers on changing facts?

Written 2026-11-19 for GBEV-3 (parent issue GST-2853), after a lean `/autoplan --kind feature` review (run
`autoplan-ydcypd-20261119035341`, one claude-opus-5-5 reviewer, 20 findings) whose gate GBEV-3 answered "do it" on
2026-11-19. This file freezes the plan only: no world has been minted and no cell has run. It is frozen by the commit
that adds it, pushed before any paid call. Every later change is a dated amendment under "Amendments", written before
the cells it governs. The harness it needs lands on this experiment's results branch before any paid call (see
"Harness"), and launch amendment A names that commit.

It is a confirmation of a development result, on worlds nobody has seen. It reuses the method of the
[changing-facts battleground (BG1)](2026-11-09-changing-facts-battleground-preregistration.md): its generator, custody,
judges, statistic and missing-data rules. Where this file is silent, BG1's preregistration governs.

## The question

On newly minted, sealed BG1 worlds, does gbrain's newest release, reading 8,000 tokens of memory, answer questions about
changing facts more accurately than the memory-bank server and the extract-first server, in each of two classes:

- **what is true now** (S1 to S5: updated, corrected, repeated stale, conflicting sources, withdrawn; 40 questions a
  world), and
- **questions about the past** (S6 to S8: as of a date, as known at a date, the history in order; 24 questions a world)?

A loss is reported the same way as a win.

## What each outcome changes (R97)

Each of the four comparisons gets one word from the verdict rules below: **ahead**, **behind**, **level within 3
points**, **not behind by 3 points or more**, or **no measurable difference**. `verdict.ts confirm` then picks the first
row of this table that matches, and prints the row and its sentences, so nobody chooses words after seeing the data.

| # | Result (first match wins) | What we publish | README's changing-facts line becomes | What happens next |
|---|---|---|---|---|
| 1 | **Incomplete:** any comparison over the 5% drop cap, or any row below the 0.90 fill gate | Each comparison's word, marked descriptive where it is. No class-level claim and no headline | "A confirmation on new sealed worlds (gbrain <release>) was incomplete: <reason>." BG1's rows stay as they are | The cause is named and repaired by dated amendment. A rerun is never used to change a verdict |
| 2 | **Any comparison behind** | The loss first, then every other comparison's word, "ahead" included | The class and server gbrain is behind, with its interval, labelled "gbrain <release>, BG1-C", above BG1's rows labelled "gbrain v0.60.593.0, BG1" | The losing class's kinds go to GBRA-108 as issues, each with exposure placing the loss in retrieval or in reading |
| 3 | **All four ahead** | "gbrain leads the two leading memory servers on changing facts", with each class's interval | That sentence and the four intervals, labelled "gbrain <release>, BG1-C", above BG1's rows labelled "gbrain v0.60.593.0, BG1" | GBRA-108 hears the lead held |
| 4 | **Both comparisons in one class ahead** | "gbrain leads both servers on <class>", then the other class's two words. No claim about changing facts as a whole | "Ahead of both servers on <class>" and the other class's two words, labelled as in row 3 | GBRA-108 gets the other class's per-kind rows and exposure |
| 5 | **At least one comparison ahead**, but neither class ahead on both | "gbrain is ahead of <server> on <class>", then the other three words. No class-level claim | The same, labelled as in row 3 | GBRA-108 gets the per-kind rows and exposure of every comparison that is not ahead |
| 6 | **None ahead, none behind** | "gbrain is level with the two leading memory servers on changing facts" when all four are level within 3 points; otherwise the four words | The same, labelled as in row 3. "Not behind by 3 points or more" on questions about the past replaces BG1's "behind" there for this release | GBRA-108 gets the per-kind rows and exposure of every comparison |

BG1's published rows stay published, labelled with the build they measured (v0.60.593.0), and this experiment's rows sit
beside them with theirs (R100). The scoreboard gets the same sentence as README.

## Public lesson

- **If gbrain leads:** "We learned that gbrain's newest release, whose main changes since BG1 tag each fact with the
  person or company it is about, now answers questions about changing facts more accurately than two leading memory
  servers on worlds nobody had seen. You should confirm a memory change on held-out data before you claim it."
- **If it ties or loses:** "We learned that the lead gbrain showed on development worlds <did / did not> carry over to
  worlds nobody had seen. You should confirm a memory change on held-out data before you claim it."

The design compares one gbrain release with two servers. It does not test which gbrain change caused any difference,
and the findings say so.

## Why we are asking, and why the answer is not known

**BG1's sealed result** (30 worlds, gbrain v0.60.593.0, three readers): level with both servers on what is true now
(-0.4 points, 95% interval -2.4 to +1.5, and -1.8, -3.9 to +0.3) and behind both on questions about the past (-10.3,
-13.0 to -7.7, and -8.1, -10.8 to -5.3). The history kind (S8) was the worst: -15.8 and -10.6.

**The development result** (gbrain v0.60.741.0, 20 public dev worlds, 1,280 questions, claude-opus-5-5 reading and
gpt-6-astra grading, by BG1's dev loop). gbrain#9674, which gives conversation facts a name tag for a person or company
that has no page, shipped on by default in v0.60.738.0. v0.60.741.0 is the newest release and the first we scored after
it. Between v0.60.737.0 and v0.60.741.0, on the same worlds, S8 rose from 84.4% to 96.3% (+11.9, +6.9 to +17.5). That
span also carries gbrain#9707, #9710, #9694, #9591 and #9623, so the dev runs don't isolate one change. Against the
servers, per world (mean, with the per-world SD):

| v0.60.741.0 minus | What is true now | Questions about the past | All 64 |
|---|---|---|---|
| memory-bank server | +2.6 (SD 3.5) | +1.5 (SD 5.1) | +2.2 (SD 3.1) |
| extract-first server | +1.1 (SD 4.8) | +1.5 (SD 4.3) | +1.3 (SD 4.0) |

Four reasons that development lead may not hold:

1. **The dev worlds were used to build the change.** gbrain's team and this crew's dev loop worked on them, with their
   public phrasing.
2. **One reader.** The dev loop reads with claude-opus-5-5 only. In BG1, Opus was the reader least favourable to gbrain
   (on what is true now, -2.2 and -3.8 with Opus against -0.4 and -1.8 over all three readers), so the three-reader
   effect may differ either way.
3. **Small effects.** Three of the four development differences are 1.1 to 1.5 points, with world-level intervals that
   include 0.
4. **The servers' dev rows came from separate runs** read at BG1 stage 1's settings, not from one campaign with
   gbrain's.

## The worlds

**Held-out BG1 slots, never minted.** BG1's sealed set has a custody seed, fixed on 2026-11-10 by BG1's Amendment 6,
and a private phrasing set. A slot's world is a deterministic function of the seed and the slot number
(HMAC-SHA256 of the seed line and `bg1/world/<slot>`, `eval/generators/changing-facts-gen.ts`). BG1 minted slots 1 to 30
and stopped. BG1's custody phrasing check planned slots 31 to 48 in memory, and never wrote or showed them; slots 49 and
up have never been planned. No world from slot 31 onward has been rendered or seen by anyone, and the private phrasing
never appeared in gbrain's development or in this crew's dev loop.

- **Kept set.** The custodian mints slots in order from 31, and the kept set is the first 40 that pass BG1's validation
  (deterministic checks, the Gemini claim check and the claude-haiku-5-5 second validator, three renders per session).
  Minting stops at the 40th kept world. Slots are capped at 96.
- **Mint stops.** Two dropped worlds among slots 31 to 35, or three dropped worlds in all, pause minting (exit 3) and go
  to GBEV-3. Both stops are new code for this set (see "Harness").
- **Generator.** `changing-facts-gen@1` with BG1's Amendment 4 sealed fixes (no S8 question on a slot with a change
  scheduled after the world end; every retract template says the plan is not happening). Before minting, the custodian
  runs the generator's phrasing check with the private phrasing over slots 31 to 96.
- **Ids.** BG1-C keeps BG1's world ids (`bg1-031` onward), so the seed derivation stays as it is. BG1's own set is
  redefined as its kept list, `bg1-001` to `bg1-030`, by a dated note in BG1's split file, and slots 31 to 96 belong to
  this experiment.
- **The seed is BG1's, and stays fixed.** Before minting, the custodian re-derives `questions.json` for `bg1-001` to
  `bg1-030` from the seed and phrasing and checks every file against BG1's filled manifest, printing counts only. Launch
  amendment A then publishes the SHA-256 of `gbrain-evals bg1-c seed commitment v1|<seed line>|nonce=<32 random bytes,
  hex>`, the form the entity-dedupe head-to-head uses, and the SHA-256 of the phrasing file. The nonce stays in custody
  with the seed.
- **BG1's 30 kept worlds are not reused.** Their dates are offset tokens, so they could be re-dated without
  re-rendering. But BG1 named gbrain's failure kinds on exactly those worlds, and a release built after that and
  confirmed on the same worlds would be a weaker test.
- **Dates.** As in BG1, every date in a world is an offset from the world end, resolved at load from
  `GBRAIN_EVALS_BG1_WORLD_END`, so minting doesn't depend on it. Launch amendment B sets the world end to the Sunday
  before the first counted cell. Questions are asked the day after it, and the runner refuses once the clock passes the
  world end by 14 days.

## Custody and exposure

BG1's custody program applies unchanged: the custody lane on the owner's Mac renders, holds and runs the sealed worlds;
the set exists at rest only as an encrypted archive plus an encrypted off-host copy; custody scripts print only counts
and hashes; counted cells launch from the custody host with hash-checked copies of one launch unit's worlds, deleted at
teardown; and any per-question or "Why null?" work runs in custody. The custody folder keeps BG1's `bg1-custody` name
prefix and every file keeps BG1's answer marker, so the repository's sealed-path checks cover it. A separate filled
manifest (`eval/decisions/datasets/bg1c-manifest.json`) pins every BG1-C file, and BG1's manifest is not touched.
What leaves custody is `verdict.ts`'s aggregates: per comparison, class, kind and reader, with exposure and fill rates.

Provider data use is BG1's table, with one change: Google receives this experiment's sealed text only for rendering and
the Gemini claim check. The descriptive Gemini judge view is dropped, and the new judge check runs on public answers.

## Systems

| Row | Configuration | Role |
|---|---|---|
| gbrain | the newest release tag on gbrain's master at launch (today v0.60.741.0, `41e33807`), configuration `rs1-stable` as BG1 ran it: default fact extraction, the quiesce barrier and the fact index, with `query` limit 50, token budget 5,500 and the facts block on, packed to 8,000 cl100k tokens. The harness sets nothing for name tags, which are on by default | subject |
| memory-bank server | `recipe`, bundle lock `f54d89df`, capabilities `23a033f4`, 8,000 tokens | comparator |
| extract-first server | `common`, bundle lock `9777b7a8`, capabilities `0acaff3a`, 8,000 tokens | comparator |

- **The servers are BG1's and the dev loop's**, at the same bundle locks and with their internal models as BG1 ran them
  (gpt-4o-mini for the memory-bank server, gpt-4.1-mini for the extract-first server).
- **Not run, and why.** The temporal-graph library (BG1: gbrain +20.9 on what is true now), hybrid search (gbrain +73.7)
  and the no-memory floor (0%) don't bear on this decision. On 10 of BG1's worlds from the same generator, the
  whole-history reference answered 99.4% of questions with Opus and 99.7% with Sol, which is the headroom check a tie
  needs.
- **No tuning on these worlds**, by anyone. gbrain's build is whatever release is newest at launch.
- **Build.** If a newer gbrain release lands before the first counted gbrain cell, a dated amendment re-pins it. Once
  counted gbrain cells start, the build is frozen for this experiment.

## Readers and judges

**Readers.** claude-opus-5-5 and gpt-6.2-sol read every row live, at effort medium with a 2,048-token output limit, each
reading the same frozen 8,000-token context for a given system and question. particle-1 re-reads every frozen context
byte for byte at effort medium with its 16,000-token output floor. gpt-6.2-sol replaces BG1's gpt-6.1-sol as the newest
frontier GPT (AGENTS.md).

**Gating judges**, as BG1: gpt-6-astra grades Opus's answers, and claude-opus-5-5 grades gpt-6.2-sol's and particle-1's.
No judge grades its own family's answers, and particle-1 never judges. The instrument is BG1's `bg1` short-answer check;
an S8 answer is correct only when the whole list is in the right order. The deterministic matcher's agreement with the
gating judges is reported and never sets a verdict.

- **BG1's judge check stands** for both judges on this instrument: each matched all 160 construction labels (kappa 1.0),
  and they agreed with each other at kappa 0.95 over 320 items. The judges, the instrument, its pinned settings and the
  generator are unchanged.
- **One new check, because one reader is new, on public answers before any sealed spend.** gpt-6.2-sol re-reads the
  dev loop's frozen public contexts of all three rows on `bg1-dev-04` to `bg1-dev-13` (1,920 contexts), and
  claude-opus-5-5 grades the answers as it would a counted gpt-6.2-sol row. A pool stratified by that gating grade and by
  row takes every answer Opus graded wrong (at least 40 if there are that many) and as many graded right.
  gemini-3.8-flash grades the pool. A class is the gating grade. The check passes when Cohen's kappa between Gemini and
  Opus is at least 0.6, with at least 40 items they agree on and at least 15 of each class. No counted cell launches
  until it passes. A failure goes to GBEV-3 with the numbers.
- **No descriptive Gemini view on the counted rows.** BG1 graded every answer a third time with gemini-3.8-flash. The
  custody host's Gemini project allows 10,000 requests a day, shared with RS1, and a third view on 23,040 answers would
  take more than two of those days without changing any verdict.

## Estimand and verdict rules

1. **Question score.** For each question and row, the mean over the three readers of that reader's 0 or 1 under its
   gating judge.
2. **World difference.** For each class, a world's difference is the mean over that class's questions of gbrain minus
   the server, in points.
3. **Four comparisons:** gbrain minus the memory-bank server and minus the extract-first server, on what is true now and
   on questions about the past.
4. **Statistic.** For each comparison, a one-sided paired t test on the mean of the 40 world differences, with 39
   degrees of freedom.
5. **Ahead and behind**, from BG1's `decideFamily` (`eval/runner/bg1/rule.ts`), called once with the four comparisons.
   Holm's step-down procedure runs across the four at 0.05 in each direction: "ahead" when the Holm-adjusted one-sided p
   for gbrain above the server is at most 0.05, and "behind" when the mirror test's Holm-adjusted p is at most 0.05.
   That is BG1's frozen rule. Because the two directions are adjusted separately, the chance of any wrong directional
   word when every true difference is 0 is up to 0.10.
6. **Words for the other comparisons**, from the simultaneous one-sided bounds `decideFamily` already reports (alpha
   0.05 / 4 = 0.0125 on each side):
   - **level within 3 points:** the lower bound is above -3 and the upper bound is below +3;
   - **not behind by 3 points or more:** the lower bound is above -3, and the comparison is not level;
   - **no measurable difference:** neither holds.

   Three points is the size of the judge shifts GST-1365 measured on F6's comparisons (-2.7 to +3.1). These words never
   turn a tie into a lead or a loss.

**Missing data, the drop cap, worst-case sensitivity, the delivered-context gate and receipts are BG1's rules**: one
common question set across every row and reader; product failures score 0 and stay in; harness failures drop the
question and are counted by reason and side; a comparison with more than 5% of its planned questions dropped gives no
verdict; the worst case (every gbrain drop 0, every server drop 1) is rerun and any disagreement is said first; a row
whose mean fill rate is below 0.90 makes its comparisons descriptive; and `verdict.ts` refuses receipts that don't
match the filled BG1-C manifest or the kept list.

### Reported beside the verdict, not part of it

- Every comparison's two-sided 95% interval and the number of questions where gbrain did better, worse and the same.
- The restricted wild cluster bootstrap (`eval/runner/stats/wild-cluster.ts`) as a sensitivity check.
- Per kind (S1 to S8) and per reader, each labelled unadjusted. The claude-opus-5-5 rows are the bridge to the dev loop.
- All 64 questions pooled, against each server, unadjusted.
- Exposure: for every frozen context, whether the needed gold values and the stale values reached the reader. S5 uses
  BG1's corrected, entity-scoped count (`eval/runner/bg1/scoped-exposure.ts`, 2026-11-16). In custody, its list of
  call-off words gains this set's own rewordings in the rendered chats, as BG1's did, and only counts leave.
- Each row's fill rate, and dropped questions by reason and side.
- Cost per correct answer, in a table showing claude-opus-5-5 and particle-1 first, then gpt-6.2-sol, from the metering
  proxies' usage fields, as BG1 computes it.
- In custody, aggregate counts from gbrain's kept brains: facts with a name tag, with a slot, and changing slots. They
  answer "did gbrain use the design?" for a tie's "Why null?" cycle (R48).

## Predictions, recorded before any data

From the development result, with the caveats above: gbrain ahead of the memory-bank server on what is true now, and not
behind by 3 points or more in the other three comparisons. Descriptively, S8's two-sided 95% interval against each
server includes 0.

## Power

The minimum detectable difference (MDD) below is for one comparison at the strictest Holm step (one-sided alpha
0.05 / 4 = 0.0125) with 80% power, by `rule.ts`'s `mdd`: (t(1 - alpha) + t(0.8)) × SD / sqrt(N), on N - 1 degrees of
freedom. Later Holm steps are looser, so these are conservative. The two right-hand columns come from 200,000 simulated
runs of the frozen rule (Holm over the four comparisons, treated as independent, seed 20261119). Two SD scenarios per
comparison: **central**, the development per-world SD (v0.60.741.0, one reader); and **pessimistic**,
BG1's sealed per-world SD (v0.60.593.0, three readers).

| Comparison | SD central / pessimistic | MDD at N = 30 | **MDD at N = 40** | MDD at N = 48 | Power for "ahead" at the dev effect, N = 40 | Chance of "not behind by 3" at the dev effect, N = 40 |
|---|---|---|---|---|---|---|
| now, memory-bank | 3.49 / 5.15 | 2.05 / 3.03 | **1.76 / 2.59** | 1.59 / 2.35 | 0.99 / 0.82 (dev +2.6) | 1.00 / 1.00 |
| now, extract-first | 4.83 / 5.59 | 2.84 / 3.28 | **2.43 / 2.81** | 2.21 / 2.55 | 0.30 / 0.20 (dev +1.1) | 1.00 / 0.99 |
| past, memory-bank | 5.11 / 7.13 | 3.00 / 4.19 | **2.57 / 3.59** | 2.33 / 3.26 | 0.43 / 0.22 (dev +1.5) | 1.00 / 0.95 |
| past, extract-first | 4.33 / 7.42 | 2.54 / 4.36 | **2.18 / 3.73** | 1.98 / 3.39 | 0.55 / 0.20 (dev +1.5) | 1.00 / 0.93 |

**What this means, said before any data.**

- If the development effects are the truth, all four "ahead" (row 3's headline) has about a 14% chance at N = 40 under
  the central SDs and about 3% under the pessimistic SDs, treating the four as independent. The positive correlation
  between the two servers' comparisons raises that a little. At the strictest Holm step, a lead in a comparison needs a
  true difference of about 2 to 4 points, larger than three of the four development effects.
- The most likely result is row 5 (55% central, 67% pessimistic): ahead of the memory-bank server on what is true now,
  and not behind by 3 points or more elsewhere. Row 4, one class ahead of both servers, comes next (31%, 18%).
- "Not behind by 3 points or more" is the well-powered reading: 0.93 to 1.00 in every comparison at the development
  effects. It is what can retire BG1's "behind on questions about the past" for this release. If the true difference is
  0, its chance is 0.59 to 1.00, and "level within 3 points" is 0.20 to 1.00.

## Budget

Every paid call runs in a GBEV-3 paid window, behind the metering proxy and the budget ledger, which reserves each
request before it is sent. The ledger cap is a runaway stop: reaching it pauses the run at a cell boundary until GBEV-3
extends it. Rates per world, in US dollars, from the providers' usage fields:

| Item | Source of the rate | Per world |
|---|---|---:|
| Mint a sealed world | BG1 MINT-A ($51.37, 12 kept) and MINT-B ($78.69, 18 kept), GST-2010's paid-window reports | 4.34 |
| gbrain: ingest, Opus reads, Astra grading | the v0.60.741.0 dev run: $70.65 for 20 worlds, less its Gemini view ($0.61); v0.60.737.0: $70.35 | 3.50 |
| memory-bank server: the same | the dev loop's comparator run: $55.10 for 17 worlds, less its Gemini view | 3.21 |
| extract-first server: the same | the dev loop's comparator run: $114.44 for 17 worlds, less its Gemini view | 6.70 |
| gpt-6.2-sol reads, three rows | BG1's token model (`eval/runner/q1/cells/definitions.ts`) with gpt-6.1-sol's token parameters, at gpt-6.2-sol's list price, which equals gpt-6.1-sol's | 3.34 |
| Opus grading gpt-6.2-sol, three rows | BG1's measured $0.002411 a call | 0.46 |
| particle-1 re-reads and Opus grading, three rows | BG1 wave B's re-read: $26.13 for 6,912 answers (particle-1 $12.10, Opus grading $14.03) | 0.73 |
| **All of it** | | **22.28** |

At N = 40 that is about $891. Adding the rest:

- a one-world smoke on public dev world `bg1-dev-01` at the counted settings, about $18;
- the new judge check on public answers, about $38 (1,920 gpt-6.2-sol reads and their Opus grades);
- Ubicloud machines, about $40, the extract-first server's ingest taking about two hours a world;
- drops refilled from later slots.

The estimate is **about $990**, and the ledger cap is **$1,200**. The gpt-6.2-sol line uses gpt-6.1-sol's token
parameters, so launch amendment B reprices it from the judge check's and the smoke's measured usage before the counted
cells. Crew threads' own Capy credits are on top. Amounts as spent are kept on the paid-window reports, not here.

## Harness

These land on this experiment's results branch as dated commits after this file freezes and before any paid call, each
with a keyless test that fails without it, followed by one Opus reader on exactly those commits. No paid window opens
until that reader is clean.

1. **Slots, mint and loader.** BG1's split and `BG1_CONVERSATIONS` keep `bg1-001` to `bg1-030`, with a dated note
   releasing 31 to 48. A BG1-C list holds slots 31 to 96 (`eval/runner/memory-qa/bg1-names.ts`). `mint.sh` accepts
   slots 31 to 96 only for this set, refuses a range that mixes the two sets, bases its yield gate on the first BG1-C
   slot, and stops on a third dropped world. A `bg1c` loader reads only the BG1-C manifest and refuses `bg1-001` to
   `bg1-030`, and BG1's loader refuses BG1-C worlds. Drills with `--fake-break` cover each stop, and a test checks that
   the sealed pregate refuses a file under the custody folder and a file carrying the answer marker.
2. **Cells.** A BG1-C cell set (`eval/runner/q1/cells/`): the three rows above, claude-opus-5-5 and gpt-6.2-sol live,
   gating judges by `bg1JudgeOf`, no Gemini view, in launch units of the kept worlds, plus particle-1 re-read cells.
   gpt-6.2-sol gets its own keys in the reader token model, and the BG1 judge map and `pricing.ts` name it. A test
   checks the per-world estimate against the rates above and that the cell set's hash is stable.
3. **Verdict.** A `confirm` mode in `eval/runner/bg1/verdict.ts`: `decideFamily` over the four comparisons, the two
   3-point readings, the outcome table's row and sentences emitted from code, and the reports above. A test runs it over
   every combination of the four comparisons' words and both descriptive states, and checks that each maps to exactly
   one row. It refuses any receipt that doesn't match the filled BG1-C manifest. A test reruns the power simulation above
   from its seed through `decideFamily` and checks the table's numbers.
4. **Judge check.** The public gpt-6.2-sol re-reads and the stratified Gemini agreement check
   (`eval/runner/q1/reread-cell.ts`, `eval/runner/bg1/judge-check.ts`), with a test that the pool is stratified and the
   gates hold.

## Run order

1. The harness commits and their Opus reader, on the results branch.
2. GBEV-3's paid window.
3. The judge check on public answers. It needs no custody host.
4. **Launch amendment A:** the gbrain release and commit, the harness commit, the cell set's hash, the seed commitment,
   the phrasing file's hash, and the custody seed check's result (counts only).
5. With GBEV-3's go for the custody lane: the phrasing check over slots 31 to 96, then minting from slot 31 until 40
   are kept, at the pace the shared Gemini quota allows. The custodian fills the BG1-C manifest.
6. The smoke on `bg1-dev-01`.
7. **Launch amendment B:** the world end (the Sunday before the first counted cell), the filled BG1-C manifest's hash,
   and the gpt-6.2-sol repricing.
8. The counted cells, then particle-1's re-reads.
9. `verdict.ts confirm` in custody, then the results pull request.

## Risks

- **Custody capacity.** The custody host is running RS1, which shares its Gemini project (10,000 requests a day). The
  dev mint made 5,714 Gemini requests for 17 worlds, so 40 worlds need about 13,500, more than one day of that quota.
  Minting doesn't depend on the world end, so a slow mint delays the result but doesn't break the clock. If the custody
  host becomes unavailable, the fallback is fresh worlds from BG1's public generator and phrasing under a counted seed
  published only as a commitment, minted and run from a cloud thread. That fallback is weaker, because gbrain's
  development used the public phrasing, so it needs a dated amendment and GBEV-3's go, and its results would say so.
- **SD.** The central SDs come from one reader on 20 dev worlds; BG1's sealed SDs are the pessimistic case.
- **A newer gbrain release mid-run.** The build freezes once counted gbrain cells start, as above.
- **gpt-6.2-sol's answers and the judge.** The new judge check guards it, before any sealed spend.

## What it can and can't claim

**If gbrain leads (row 3):** "On synthetic histories in which facts are updated, corrected, repeated stale, contradicted,
withdrawn and asked about at past dates, gbrain <release>, reading 8,000 tokens, answers more accurately than the
memory-bank server and the extract-first server, both about what is true now and about the past, read by Opus 5.5,
GPT-6.2 Sol and particle-1." The per-kind rows sit beside it.

**It does not say** which gbrain change caused a difference; anything about brains whose pages carry access flags,
about agent mode, about histories much longer than 200,000 tokens, other token budgets or other gbrain builds; anything
about the temporal-graph library; or how the two servers rank against each other. The claims read "on synthetic
histories". A result favourable to particle-1 keeps its gap to Opus and the interval in the headline.

## Freeze

- **Freeze commit:** the commit that adds this file.
- **Fixed now:** the question, the four comparisons and their test, Holm over four in each direction, the two 3-point
  readings, the outcome table, N = 40, the slots, kept rule and mint stops, the rows and configurations, the readers,
  judges and the new judge check, the missing-data rules, and the ledger cap.
- **By dated amendment, before the first counted cell:** A, before the mint: the gbrain release and commit, the harness
  commit, the cell set's hash, the seed commitment, the phrasing file's hash and the seed check. B, after the mint and
  smoke: the world end, the filled BG1-C manifest's hash and the gpt-6.2-sol repricing.
- **Results:** `docs/benchmarks/2026-11-19-changing-facts-confirmation-results.md` and
  `docs/benchmarks/2026-11-19-changing-facts-confirmation-results/`.

## Amendments

None yet.

## Disclosures

- gbrain is Garry Tan's own project.
- Disclosure: Y Combinator, which Garry Tan runs, is an investor in Particle, which makes particle-1.
- Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator. Garry Tan runs Y Combinator.
