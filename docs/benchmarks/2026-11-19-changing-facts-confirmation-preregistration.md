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

### Amendment 1 (2026-11-19): one look at half the worlds, and a pilot for every row

Two rules Garry approved on 2026-11-19 apply here before any paid call. A counted run planned above $500 takes one
preregistered look at half its units, with stop bounds fixed in advance and no other look (R113), and every arm gets a
pilot before its counted run (R111). BG1-C is planned at about $990, so both apply. This amendment adds them, before any
paid call, mint or counted cell. Launch amendments A and B keep their letters.

**The look.**

- **When.** Once the first 20 kept worlds (launch units 1 to 4 of 8, five worlds each, in kept-slot order) have every
  row, both live readers and particle-1's re-read scored. particle-1 re-reads the first half before units 5 to 8 run.
- **Statistic.** Each of the four comparisons, with the same estimand, on those 20 worlds. Its z is the normal score with
  the same one-sided p as its paired t on 19 degrees of freedom.
- **Stop for a difference** (O'Brien-Fleming bounds): a comparison crosses when |z| is at least 2.80, as ahead when z is
  positive and behind when it is negative.
- **Futility.** A comparison that has not crossed is futile when its conditional power for "ahead" under the planned
  effect is below 10%. The planned effects are the development effects in the Power table's order: +2.6, +1.1, +1.5
  and +1.5 points. Conditional power assumes the last 20 worlds' mean difference is the planned effect, with the first
  20 worlds' SD, and asks for a final 40-world z of at least 1.98.
- **The run stops at the look only when every comparison has crossed or is futile.** Crossed comparisons then keep
  their word, and futile ones read "no measurable difference", with the 3-point readings from the 0.0125 bounds on the
  20 worlds. The outcome table picks the row as usual. The results say the run stopped at its planned look and that its
  estimates may be overstated.
- **Otherwise the look decides nothing.** Every row runs to 40 worlds. `verdict.ts confirm` prints "continue" with
  each comparison's z, conditional power and status, and it refuses a second look.

**The final analysis** at 40 worlds is the frozen rule (Holm at 0.05 in each direction, then the 3-point readings from
the 0.0125 bounds) with the final bound added. A comparison is ahead or behind only when Holm says so and its z, on 39
degrees of freedom, is at least 1.98 in that direction. A comparison that Holm calls ahead or behind with |z| below
1.98 takes its 3-point reading instead. No other look at the comparisons counts. The harness checks made during the run
(fill rates, drops, spend) compute no difference between rows.

**What the look costs.** These figures come from 200,000 simulated runs of the two-look design with per-world normal
differences, seed 20261119 (`eval/runner/bg1/confirm-power-sim.py`), using the Power section's SDs. The same script with
one look reproduces that section's table, with all four ahead at 13.8% and 2.8%. The bounds above are the ones R113 sets. The
final bound of 1.98 is stricter than Holm's last step under the frozen rule (one-sided 0.05, a z of 1.64), so the chance
that all four comparisons come out ahead roughly halves.

| If the development effects are the truth, N = 40 | Central SDs | Pessimistic SDs |
|---|---|---|
| The run stops at the look (every stop is for futility) | 0.5% | 1.4% |
| Row 3, all four ahead | 6.8% (13.8% with one look) | 1.1% (2.8%) |
| Row 4, one class ahead of both servers | 36.8% (30.7%) | 19.5% (18.1%) |
| Row 5, at least one ahead, neither class on both | 56.0% (55.2%) | 67.7% (67.3%) |
| Row 6, none ahead and none behind | 0.3% (0.3%) | 11.7% (11.7%) |
| "Ahead", by comparison, in the Power table's order | 0.99, 0.27, 0.41, 0.53 | 0.82, 0.19, 0.21, 0.20 |
| "Not behind by 3 points or more" at 40 worlds | 0.99 | 0.92 to 0.99 |

With no true difference, the run stops at the look 0.8% of the time under the central SDs and 8.7% under the
pessimistic ones. "Ahead" comes out in each comparison 1.3% of the time, and a "behind" anywhere 4.8% and 4.2% (4.9%
with one look). The expected number of worlds run is 39.9 and 39.7 under the development effects, so the budget does not
change.

**A pilot for every row (R111).** Each of the three rows is an arm. Its pilot is the existing smoke on public dev world
`bg1-dev-01` at the counted settings (run order step 6), with both live readers and particle-1's re-read. At the Budget
rates a row's smoke costs about $5.01 (gbrain), $4.72 (memory-bank server) and $8.21 (extract-first server). Each is
under a tenth of that row's planned spend at N = 40, which is about $200, $189 and $328. A row passes its pilot when its
own smoke outputs show three things:

1. **The part under test ran.** gbrain's kept brain holds facts tagged with the person or company they are about,
   slotted facts and changing slots (counts above 0, by the dev loop's free query). Each server stored memories for the
   world. Every row delivered a frozen context for all 64 questions, with a mean fill rate of at least 0.90.
2. **Its judges pass R78.** gpt-6-astra (Opus's answers) and claude-opus-5-5 (particle-1's) pass by BG1's judge check on
   this instrument. claude-opus-5-5 on gpt-6.2-sol's answers passes by this experiment's new judge check (run order step
   3), which must pass first.
3. **The units can be supplied at the planned rate.**
   - Each row's smoke spend is at most 1.5 times its Budget rate for one world, and its wall time sets the hours per
     launch unit that launch amendment B states.
   - For the sealed worlds themselves, the mint's first five slots use at most 1.5 times the dev mint's 336 Gemini
     requests per world (5,714 for 17 worlds), so 40 kept worlds fit the custody host's shared quota at the planned pace.
   - The existing mint stops cover the yield.

A row that fails its pilot is fixed and piloted again, or left out. A server row left out reports its two comparisons
as "not run (pilot failed: <reason>)", Holm runs over the remaining comparisons, and the results list the row as left
out. gbrain's row can't be left out, so its failure goes to GBEV-3, as a failed judge check does.

**Run order, as amended.** The steps stay those of "Run order", with step 8 split in two: units 1 to 4 and their
particle-1 re-reads, then the look, then, unless the run stopped, units 5 to 8 and their re-reads. Step 6's smoke is
each row's pilot, and no counted cell of a row launches until that row's pilot has passed.

GBEV-3 directed this amendment on 2026-11-19, passing on R111 and R113 as Garry approved them, before any paid call.

### Amendment 2 (2026-11-19): the look's bounds, scaled to each comparison's own alpha

Amendment 1 used 2.80 and 1.98. Those are the O'Brien-Fleming bounds for one two-sided test at 0.05 with two looks. But
BG1-C's comparisons are frozen at one-sided 0.05 in each direction, at Holm's step levels, so those bounds made the test
stricter than the plan. Under the central SDs, the chance that all four come out ahead fell from 13.8% to 6.8%. R113 is
there to keep a plan's alpha across one look, not to tighten it. So this amendment replaces Amendment 1's bounds with
O'Brien-Fleming two-look bounds computed at each Holm step's one-sided alpha.

Everything else in Amendment 1 stands: when the look happens, its statistic, the futility stop below 10% conditional
power, stopping only when every comparison has crossed or is futile, the wording after an early stop, the pilots, and
no other look counting.

**Bounds.** At Holm's k-th step the one-sided alpha is 0.05 divided by the number of comparisons still undecided, as
frozen. For that alpha the bounds are the O'Brien-Fleming pair with the look at half the worlds. The look bound is the square
root of 2 times the final bound, and the pair spends exactly that alpha (bivariate normal, correlation the square root
of 0.5).

| Holm step | One-sided alpha | Look bound | Final bound | One look, as frozen |
|---|---|---|---|---|
| 1 | 0.0125 | 3.183 | 2.250 | 2.241 |
| 2 | 0.0167 | 3.026 | 2.140 | 2.128 |
| 3 | 0.025 | 2.797 | 1.977 | 1.960 |
| 4 | 0.05 | 2.373 | 1.678 | 1.645 |

At one-sided 0.025 the same computation gives R113's 2.80 and 1.98.

- **At the look**, Holm steps down over the four z's in each direction using the look bounds. The largest z is compared
  with 3.183, the next with 3.026, and so on, stopping at the first that falls short. Each comparison it passes has
  crossed, as ahead, or as behind in the mirror test.
- **At the final**, Holm steps down the same way over the 40-world z's using the final bounds. These replace the frozen
  Holm thresholds (the last column) and Amendment 1's extra condition of 1.98. The 3-point readings keep the 0.0125
  bounds.
- **Futility** asks for a final z of at least 1.678, the last step's final bound. So a comparison is futile only when
  even the easiest final bound is out of reach.

**What the look costs.** These figures come from the same seed (20261119), with 200,000 simulated runs per scenario and
per-world normal differences (`eval/runner/bg1/confirm-power-sim.py`). The "one look" columns reproduce the Power
section's table.

| If the development effects are the truth, N = 40 | Central, one look | Central, with the look | Pessimistic, one look | Pessimistic, with the look |
|---|---|---|---|---|
| Row 3, all four ahead | 13.8% | 12.9% | 2.8% | 2.6% |
| Row 4, one class ahead of both servers | 30.7% | 30.6% | 18.1% | 17.8% |
| Row 5, at least one ahead, neither class on both | 55.2% | 56.1% | 67.3% | 67.6% |
| Row 6, none ahead and none behind | 0.3% | 0.3% | 11.7% | 12.0% |
| "Ahead", by comparison, in the Power table's order | 0.99, 0.30, 0.44, 0.55 | 0.99, 0.29, 0.43, 0.54 | 0.82, 0.20, 0.22, 0.20 | 0.82, 0.19, 0.21, 0.20 |
| "Not behind by 3 points or more" | 1.00 | 1.00 | 0.93 to 1.00 | 0.93 to 1.00 |
| The run stops at the look (every stop is for futility) | none | 0.1% | none | 0.2% |

With no true difference, the run stops at the look 0.1% of the time under the central SDs and 2.2% under the
pessimistic ones. "Ahead" comes out in each comparison 1.2% to 1.3% of the time, and a "behind" anywhere 4.7% and 4.5%
(4.9% with one look). The expected number of worlds run is 39.98 and 39.96 under the development effects, so the budget
does not change.

GBEV-3 decided this on 2026-11-19, before any paid call: "R113 exists to preserve the plan's alpha across one look, not
to make the test stricter."

### Amendment 3 (2026-11-19): two readings made explicit

Written before any paid call, after the harness for Amendments 1 and 2 was built and read. Neither change moves a
bound, a row, an arm or the budget.

- **A futile comparison at a stop** takes its 3-point reading on the 20 worlds, from the 0.0125 bounds: level within 3
  points, not behind by 3 points or more, or no measurable difference when neither holds. Amendment 1 named "no
  measurable difference" and the 3-point readings together, and this says which one applies.
- **The public lesson for rows 4 and 5.** "Public lesson" gave one sentence for a lead and one for a tie or a loss.
  Rows 4 and 5 are neither, so they get their own: "We learned that part of the lead gbrain showed on development
  worlds carried over to worlds nobody had seen. You should confirm a memory change on held-out data before you claim
  it." Row 3 keeps the lead sentence, rows 2 and 6 take the tie-or-loss sentence with "did not", and row 1 gets none.

### Amendment 4 (2026-11-19): launch amendment A, part 1: the build, the harness and the cell set

Written after the judge check (run order step 3), the only paid step so far, and before anything is minted. It moves no
bound, row, arm or budget line.

- **gbrain's build.** Every BG1-C gbrain cell now runs v0.60.745.0, commit `8ebb7980c35d1d05e75f4c9c8461b49b3c3b454b`,
  instead of v0.60.741.0 (`41e33807`). v0.60.745.0 is the newest release tag on gbrain's master as this is written
  (`eval/runner/q1/cells/bg1c.ts`, `BG1C_GBRAIN_BUILD`). Read by title, the 22 commits between the two releases change
  the secret store, page purges, iMessage sending, managed refresh, upgrades for brains with very long page titles,
  trust tiers on renamed pages, archived sources' visibility to API tokens, OpenClaw's skill resolver, the Rust engine
  (which can't be selected yet), and test and bench tooling. None of them names fact extraction, name tags or slot
  history, so the development result above, measured on v0.60.741.0 and left as measured, is also this build's
  expectation. If a newer release lands before the first counted gbrain cell, another dated amendment re-pins to it. The
  build freezes once counted gbrain cells start.
- **Harness commit.** `d21dd8209d61c5dd6d55fd7cee76f9ab494600d7` on this experiment's results branch. Since Amendment 3:
  - OpenAI reads no longer send `n`. gpt-6.2-sol refuses any request that carries it, and since it defaults to 1,
    other models' reads don't change.
  - The pilot passes judge checks only when they are paid and every gate passes. It needs every reader to answer, and
    be graded on, all 64 questions. `confirm` takes its gbrain release from the cell set and refuses one that differs,
    and it reads particle-1's re-reads by half: half 1 at the look and both at the final, each holding exactly its
    launch units' kept worlds.
  - The pilot takes BG1's judge check from BG1's published verdict, pinned by its SHA-256, because that is the only
    place the check survives.
  - `mint.sh` runs the supply check (Amendment 1, condition 3) once slot 35 resolves, and again before any run that
    starts past slot 35. When the check fails, the mint pauses for GBEV-3 until GBEV-3's approval is recorded for that
    check alone (`--supply-ack`).
- **Cell set.** `eval/runner/q1/cells/bg1c-cells.json`, SHA-256
  `6b346bbeb3e17e23b19929a9d8ae30c3a954ac0912a1c44146fc109111bc0a2a`.
- **Readers are plain API calls.** claude-opus-5-5 and gpt-6.2-sol each answer one question from one fixed context, in
  a single chat request through the metering proxy, as BG1's readers did. They don't run inside Claude Code or Codex
  CLI, because BG1-C measures memory servers, not agent harnesses. A CLI session would add its own prompt and tools to
  every read and break the pairing with BG1.
- **The judge check passed.** On 148 stratified public dev answers, gemini-3.8-flash and claude-opus-5-5 agreed on all
  148: kappa 1.0 against a line of 0.6, and 74 agreed in each class against a line of 15. So Opus's grades of
  gpt-6.2-sol's answers count.
- **From custody (2026-11-19, before the phrasing check, run order step 5).** The custody seed check passed on BG1's
  seed and private phrasing: all 30 of BG1's questions files re-derive to the SHA-256 its filled manifest lists, and all
  60 files the manifest lists match their bytes. The seed commitment, the SHA-256 of `gbrain-evals bg1-c seed commitment
  v1|<seed line>|nonce=<nonce>`, is `a3df666b1bb6ad9bc889f7e6c53112d07ad7b78d045ecec9a77378b37f8ce875`; the 32-byte
  nonce stays beside the seed in custody. The phrasing file's SHA-256 is
  `6f287faec771e51f29d4599304998fa8bda77d0c4844e8b72dd8c301ca415656`.

### Amendment 5 (2026-11-19): launch amendment A, part 2: control characters in rendered chats

Written before anything is minted, on GBEV-3's ruling of 2026-11-19. It moves no bound, row, arm or budget line, and the
kept set is still the first 40 worlds that pass BG1's validation.

- **What happened on the dev worlds.** In public dev world bg1-dev-20, gemini-3.8-flash wrote a U+0000 character inside
  a word in one turn of session s123. gbrain keeps pages in Postgres, which can't store that character, so gbrain's
  `put_page` refused the page and the session never reached gbrain. memory-bank and extract-first ingested all 152
  sessions. Every gbrain build the dev loop ran on bg1-dev-20 (v0.60.734.0, v0.60.735.0, v0.60.737.0 and v0.60.741.0)
  lost that session and missed the three questions that cite it, which both other servers answered. It is the only
  control character in the 20 public dev worlds.
- **The change.** `eval/custody/bg1/render.ts` now removes every control character except newline and tab from each
  rendered turn, before the checks run and before the world is written. The checks read the text the world keeps, and
  every server ingests that same text. The render record and line count what each world lost (`controls_dropped`), and
  `validate.ts` reports the count for each world and in total. The gates that keep or drop a world are unchanged.
- **Harness commit.** `a37af44a8f8a9444e02b7ff2d2d2d93249aec887` on this experiment's results branch, with keyless
  tests. The render test fails without the change.
- **A descriptive count for BG1.** BG1's published results don't record failed sessions, so whether its sealed gbrain
  row lost a session this way isn't known. In the custody step that adds Amendment 4's custody items, the custodian also
  runs `bg1c-checks.ts controls` over BG1's 30 sealed worlds. It counts U+0000 and the other control characters, the
  sessions and worlds that hold any, and the questions that cite those sessions, and it prints counts and world ids
  only. The counts go under this heading as a descriptive note. They don't change BG1's outputs or verdict, and they
  don't enter BG1-C's verdict.
- **BG1's count (2026-11-19, from custody).** `bg1c-checks.ts controls` over BG1's 30 sealed worlds found 5 U+0000
  characters and no other control character, in 2 sessions of 2 worlds (bg1-010 and bg1-025). No BG1 question cites
  either session. BG1's records don't say whether gbrain refused those two sessions; if it did, no scored question lost
  its evidence.

### Amendment 6 (2026-11-20): launch amendment A, part 3: gbrain v0.60.750.0

Written after 15 of the 40 worlds were minted and before any counted gbrain cell. It moves no bound, row, arm or budget
line.

- **gbrain's build.** Every BG1-C gbrain cell now runs v0.60.750.0, commit `104403ce1cde20f444eed2dc80b0024a552015b0`,
  instead of Amendment 4's v0.60.745.0 (`8ebb7980`). gbrain tagged v0.60.750.0 at 07:50:55Z on 2026-11-20, and it is
  the newest release tag on gbrain's master as this is written. The build freezes once counted gbrain cells start.
- **What changed since v0.60.745.0 that could move BG1-C's gbrain row.** Read from the release notes of v0.60.746.0,
  v0.60.747.0, v0.60.748.0 and v0.60.750.0 (there is no v0.60.749.0). BG1-C's gbrain cell writes each session with
  `put_page` over MCP stdio, runs gbrain's conversation fact extraction (`extract-conversation-facts`) over the saved
  pages, and reads with `query` and `recall`, with Voyage, OpenAI and Anthropic keys only.
  - #9849: recall, the entity card, hot memory, an entity's saved facts and search's saved-fact matches now end a slot
    value (employer, city, role) once a later value for the same slot is saved, as the query facts block already did.
    This bears directly on the changing-facts classes. It should help, or leave unchanged, the questions about current
    values, and it could move the questions about history and past dates either way.
  - #9833: newest-first fact reads no longer let a fact dated years ahead hold the top of the list. That can move any
    class in a world that holds a fact dated in the future. The same change gives extracted fundraising amounts one tag
    per deal, and stops a narrow tool surface passing a hidden `remember` parameter, a tool the shim doesn't call.
  - #9853: a conversation fact the speaker asked to keep quiet ("keep this quiet", "off the record", "between us") is
    now saved private. If a world says that and the shim's read doesn't see private rows, gbrain could lose that fact.
  - #9832: a page holding U+0000 is now saved with the character removed instead of refused. Amendment 5 already removes
    control characters before any server sees a world, so this changes nothing on BG1-C's worlds. On bg1-dev-20 it would
    have kept session s123.
  - Nothing else in the four releases names fact extraction, name tags, slot history, or `put_page`, `query` or
    `recall` on a local brain. v0.60.748.0's move of the `gemini` alias and the Google provider's default models to
    gemini-3.5-flash-lite doesn't reach this cell, which has no Google key. #9848's private history in `known_as_of`,
    and v0.60.747.0's private fact rows on remote `put_page` (#9760) and in get_page `as_of` reads (#9733), apply to
    remote MCP callers only. The rest change the Mac helper and iMessage pages, dedupe and company linking, purges, the
    secret store's restore (#9806), sharing and access, a `remember` parameter the shim doesn't send (#9802), dream
    synthesis, which the shim never starts (#9840), refresh's link-backlog lock, `check-resolvable`, OpenClaw's skill
    resolver, the Rust engine, cost estimates, and test and CI tooling.
- **What this build is expected to score.** Amendment 4 carried the v0.60.741.0 development result forward as
  v0.60.745.0's expectation, because nothing between them touched facts. That no longer holds: #9849, #9833 and #9853
  could move the changing-facts classes. A development run on the 20 public dev worlds at v0.60.750.0, from the same
  harness commit as the v0.60.741.0 result above (`be9caa1e`), scores S1 to S8 paired against that result. The paired
  score goes under this heading as a development reading when it lands, before the first counted gbrain cell. It changes
  no bound, row or verdict rule.
- **Harness commit.** `693c4136811d2641cc94803be6ee8e18c7d11f7b` on this experiment's results branch. It changes
  `BG1C_GBRAIN_BUILD` in `eval/runner/q1/cells/bg1c.ts`, regenerates the cell set and updates the tests that name the
  release.
- **Cell set.** `eval/runner/q1/cells/bg1c-cells.json`, SHA-256
  `2e4ccb54d26441f29c3d30983f5f5d8cbf496d6aeb665444687ae7cc1ba00242`.
- **Pilot.** gbrain's smoke on `bg1-dev-01` (run order step 6) runs on v0.60.750.0, so the pilot shows this build
  running in the harness before any counted cell.
- **The paired development reading (2026-11-20).** On the 20 public dev worlds, from harness commit `be9caa1e`, read by
  claude-opus-5-5 and graded by gpt-6-astra, gbrain v0.60.750.0 answered 97.2% of all 1,280 questions, against 97.4%
  for v0.60.741.0. The paired difference is -0.2 points (-1.1 to +0.6), inside the 1.9-point smallest visible change.
  On current values (S1 to S5) it moved +0.1 (-1.1 to +1.4), and on questions about the past (S6 to S8) -0.8 (-2.1 to
  +0.2). The largest class change is S8 (history), -1.9 (-5.0 to +1.3) to 94.4%, inside that class's 7.0-point smallest
  visible change. The gaps to the other servers barely moved: on current values +2.8 (+1.1 to +4.5) over memory-bank
  and +1.3 (-0.4 to +2.9) over extract-first, against +2.6 and +1.1 at v0.60.741.0; on questions about the past +0.6
  (-1.3 to +2.7) and +0.6 (-1.3 to +2.5), against +1.5 and +1.5. bg1-dev-20's three questions on session s123 are now
  answered right, because v0.60.750.0 saves the page that holds U+0000. BG1-C's worlds lose those characters before any
  server sees them, so that gain can't repeat there. Without those three questions the paired differences are -0.5
  overall, -1.0 on questions about the past and -2.5 on S8. Five worlds were rerun whole after their first runs stopped
  on their per-world spend lease, so every question is graded once. This build's expectation is therefore the
  v0.60.741.0 result above, within these intervals.

### Amendment 7 (2026-11-21): launch amendment B: the launch build, the world end, the manifest and the repricing

Written after the mint and the smoke and before any counted cell. It moves no bound, row, arm, cap or verdict rule.

- **gbrain's launch build.** Every BG1-C gbrain cell runs v0.60.753.0, commit
  `fbf608cf86ea7b2b912ce80151f856a1a47e9533`, instead of Amendment 6's v0.60.750.0. It was the newest release tag on
  gbrain's master when the build was fixed for launch, at 01:15Z on 2026-11-21. v0.60.754.0 and v0.60.755.0 were tagged
  later that day. On GBEV-3's ruling, v0.60.753.0 stays the one re-pin after Amendment 6: the paired development reading
  below and every counted gbrain cell use this build, and it freezes when the first counted gbrain cell starts.
- **What changed since v0.60.750.0.** Read from the release notes of v0.60.751.0, v0.60.752.0 and v0.60.753.0.
  - #9856: conversation fact extraction now retries a window the model declines as two halves instead of losing the
    whole page's facts, and it parses transcripts whose answers list `**Label:**` lines instead of skipping them as
    unparsed. The shim runs that extraction over pages in the `**Speaker** (date): text` shape and counts an unparsed
    page as a failed run, so this could move BG1-C's gbrain row. On the 20 dev worlds neither path fired: at both
    v0.60.750.0 and v0.60.753.0 every one of the 3,060 conversation pages finished extraction, with no declined window
    and no unparsed page.
  - #9881: API keys granted private-facts access no longer read held private fact text. It applies to remote API keys;
    the shim reads over MCP stdio with none.
  - #9857: conversation pages record which speaker is the brain's owner when a local importer can prove it. The shim
    writes every page through MCP `put_page`, not a local importer, so no BG1-C page gets the marker, and nothing in
    gbrain reads it yet.
  - The rest change the Apple Contacts source, which the cell doesn't configure (#9854, #9867), OpenClaw setup's
    timeouts (#9865), database-engine restructuring with no change in behavior (#9812), the Rust engine, which nothing
    selects (#9823, #9874), and CI only (#9879, #9884).
- **BG1-C's own launch.** On main, `rs1-stable`'s launch now follows RS1's build and adds
  `GBRAIN_F6_BUILD_PROBLEMS=record` and `GBRAIN_IDLE_UPKEEP=off`. BG1-C's gbrain cells no longer take that launch. Every
  one, counted and smoke, starts from `BG1C_GBRAIN_LAUNCH` in `eval/runner/q1/cells/bg1c.ts`: BG1's bun image, F6's
  build path and v0.60.753.0, with BG1-C's extraction cap. The cell set didn't change when this went in.
- **Harness commits.** On this experiment's results branch, each with a keyless test that fails without it:
  `57b319756a898b84c769d66a1b13069648003044` (the re-pin), `2b77dbbe7ab285592682cf4bed28c82839737356` (the launch) and
  `acdb0ececfc1999d1b7aff5609bd5393aa9849a9`, which lets `scripts/ubicloud/ubi-runner.sh up` create VMs from the macOS
  custody host again: its create lock needed util-linux `flock`, which macOS lacks, so the first smoke launch refused
  before any VM existed and spent nothing. It changes no cell, reader, judge or score. The same fix goes to main
  separately.
- **Cell set.** `eval/runner/q1/cells/bg1c-cells.json`, SHA-256
  `282a5353d3a1d9345dc9877c5535a54a1d461644556a81f40248f7af9c033af9`.
- **The paired development reading at the launch build.** Same 20 public dev worlds, harness commit (`be9caa1e`), reader
  and judge as Amendment 6's. v0.60.753.0 answered 97.6% of all 1,280 questions. Against v0.60.750.0 the paired
  difference is +0.4 (-0.5 to +1.3); no class's interval sits below zero, and S5 (withdrawn) moved +3.8 (+0.6 to +7.5).
  Against v0.60.741.0 it is +0.2 overall, +0.8 on current values, -0.8 on questions about the past and -2.5 on S8;
  without bg1-dev-20's three s123 questions, -0.1, -1.0 and -3.1. Its gaps to the other servers: on current values +3.4
  (+1.6 to +5.1) over memory-bank and +1.9 (+0.1 to +3.6) over extract-first; on questions about the past +0.6 (-1.3 to
  +2.5) over each. This build's expectation is the v0.60.741.0 result above, within these intervals.
- **World end.** `GBRAIN_EVALS_BG1_WORLD_END=2026-11-15`, the Sunday before the first counted cell, which starts after
  this amendment on 2026-11-21 or 2026-11-22. Questions are asked on 2026-11-16, and the runner refuses every BG1-C cell
  from 2026-11-30 (UTC) on. If the first counted cell can't start by 2026-11-22, a dated amendment moves the world end
  before it does.
- **The filled BG1-C manifest.** 40 kept worlds, `bg1-031` to `bg1-070` (slots 31 to 70: every slot minted was kept,
  none dropped), 80 files, SHA-256 `53927b30059a331fe546e9db3210931a5c827c8a7c58ca26cc13729c30fcfc96`. The custody
  validator passed all 40 (`checked=40 passed=40`), and the custody hash list over the sealed set (121 files) has
  SHA-256 `f8b788081fb3a565f3d2a744fdfeccc6166631798cfb157cb6363caa48b8a285`. The manifest stays in custody until the
  results; the counted campaign reads it there.
- **The pilot (Amendment 1, R111).** The smoke on `bg1-dev-01` ran from harness commit `acdb0ecec` on v0.60.753.0, all
  three rows in one campaign, and particle-1 then re-read each row's 64 frozen contexts in its own Particle window, for
  $0.84 in all. `verdict.ts pilot` read every condition from those outputs and passed all three rows and the mint (its
  `pilot.json`, kept in custody, has SHA-256 `4d42e9d0cdf8810eb0a0419277f428c7e1fb60c6a2534a3c12fd81f37a046c6d`).
  gbrain's kept brain held 1,889 facts, 299 of them tagged with a person or company, and 42 slotted facts in 20 slots, 8
  of which hold more than one value. The memory-bank and extract-first servers returned 904 and 1,329 distinct stored
  memories across the 64 retrievals, a lower bound on what each stored. Every row delivered a frozen context for all 64
  questions, with mean fill rates of 0.988 (gbrain), 0.983 (memory-bank) and 0.995 (extract-first), and claude-opus-5-5,
  gpt-6.2-sol and particle-1 each answered all 64, every answer graded by its reader's judge. Both judge checks, BG1's
  and this experiment's, are paid runs that passed. Each row's spend per world, from the metering proxies and including
  the re-read, was under its Budget rate: $4.82 against $5.01, $4.55 against $4.72 and $8.04 against $8.21, each well
  under the 1.5 times the pilot allows. The mint's first five slots used 330.4 Gemini requests per kept world, under the
  line of 504.
- **Hours per launch unit.** The smoke's VMs ran 51 minutes (gbrain), 43 minutes (memory-bank) and 1 hour 54 minutes
  (extract-first) for one world of 187,021 tokens, setup included: 4.53, 3.85 and 10.17 hours per million tokens. Those
  are under the BG1 rates that size the counted launch units (4.69, 4.63 and 13.1), so each unit of five kept worlds
  keeps its expected hours (5, 5 and 14) and its timeout (10, 10 and 23 hours), and the cell set doesn't change.
- **gpt-6.2-sol repricing.** The Budget's gpt-6.2-sol line used gpt-6.1-sol's token parameters. Measured, a read is
  about 5,450 input and 96 visible output tokens and costs $0.0146 as billed: $28.03 for the judge check's 1,920 reads,
  and $2.80 for the smoke's 192 (64 in each row). So the line is $2.80 a world for the three rows, not $3.34. Opus
  grading those answers measured about $0.0022 a grade in both, so its line is $0.42 a world, not $0.46. The per-world
  total becomes $21.70 instead of $22.28, and the counted estimate at N = 40 about $868 instead of $891. The $1,200
  ledger cap and the cell set's leases don't change, so the cap still covers the measured rates.

## Disclosures

- gbrain is Garry Tan's own project.
- Disclosure: Y Combinator, which Garry Tan runs, is an investor in Particle, which makes particle-1.
- Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator. Garry Tan runs Y Combinator.
