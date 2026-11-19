# BEAM-10M on gbrain's newest release: preregistration

Written on 2026-11-19 for GST-3139, the first of two pull requests (R77: this preregistration, then one results pull
request). Nothing in this experiment has run: no dry run, no judge check and no counted cell. This file is frozen by
its merge commit. Any later change is a dated amendment under "Amendments", committed on the results branch before the
cells it governs.

It re-measures the two README rows about BEAM-10M, "Right answers about very long chat histories" and "The same
questions, against an agent with list, grep and read tools", on gbrain's newest release. Both rows were last measured
at gbrain `f05943e6` (v0.60.138.0) in the [Q1 scoreboard](2026-10-06-scoreboard/scoreboard.md). The component arm was
re-measured once more, descriptively, at `0ccf2bdd` (v0.60.493.0) by
[F6](2026-10-29-f6-current-master-preregistration.md). The whole-system arm has not been measured since `f05943e6`.

## The question

At gbrain's newest release, reading 8,000 tokens of memory about BEAM-10M conversations of about 10 million tokens
each, does gbrain answer as well as it did at `0ccf2bdd`? And how far does gbrain's whole system, reading its own
default amount, now sit from an agent with list, grep and read tools over the same Markdown files?

## The public lesson

Several changes since `0ccf2bdd` reach this benchmark's code path, and they push in opposite directions. People
building agents on long chat histories want to know which way the net effect goes at a fixed reader budget:

- **Quote fences on chat text.** Every chat excerpt, chat-derived fact and, for remote readers, page title is now
  wrapped in a quote fence that counts against gbrain's own token budget (gbrain #7601 in v0.60.507.0, #8066 in
  v0.60.521.0, #8367 in v0.60.536.0, #8404 in v0.60.539.0). Less chat text fits in 8,000 tokens. Expected: **down**.
- **Dated facts.** Fact rows say when they were stated, and copies collapse into one row (#9524, v0.60.734.0). History
  questions add earlier values (#9573, v0.60.735.0). Retractions appear right after the fact they cancel (#9627,
  v0.60.736.0). Corrected facts always appear with their corrector (#7938, v0.60.710.0). Role, employer and city
  updates get a slot-history view (#9623 and #9674, v0.60.738.0). Expected: **up** on knowledge update, temporal
  reasoning, event ordering and contradiction resolution.
- **At most 3 meaning-only pages per remote query** that passes no `limit` (#7598, v0.60.506.0). This reaches only
  the whole-system arm. Expected: either way, likely down.
- **Smaller keyword changes:** rare words first in OR retries and an identifier probe (#8148, v0.60.575.0), and long
  questions scored on 12 content terms (#8471, v0.60.595.0). Expected: either way, small.

We can't predict which effect wins. The reasons each other change since `0ccf2bdd` can't move this benchmark are in
the survey behind this plan (GST-3136), and the reranker, embeddings, evidence packing, token budgets and conversation
parser are unchanged from `0ccf2bdd` to v0.60.742.0. v0.60.742.0, the newest release when this file was written,
adds nothing on the path: its changes are page purges, renames keeping trust tiers, PostgreSQL test sharding and a Rust
engine that can't be selected yet.

## What the result decides

Each outcome changes something (R97):

1. **Arm P falls by at least the smallest detectable difference** against F6's arm P (below): it's a regression. It is
   published plainly. gbrain's maintainers get the failure classes and the per-ability split (aggregates only), with
   the quote fences as the first suspect and the measured fence share of each context as the evidence.
2. **Otherwise** no regression is claimed, and the result says what the interval allows. A drop whose 95% interval
   lies below 0 but whose size is smaller than the smallest detectable difference is reported as a measured drop,
   smaller than this test was sized to detect, and gbrain's maintainers get it as a note with the same aggregates.
3. **In every case** README's two BEAM-10M rows and the scoreboard block move to the newest measurement, each labelled
   with its gbrain build and measurement date, and a regression is published plainly. The stored rows stay in the Q1
   and F6 reports.
   - **"Right answers about very long chat histories"** shows arm P, gbrain as it ships with an 8,000-token budget:
     the mean of the three readers (claude-opus-5-5, gpt-6.2-sol and particle-1) under the frontier view, with the
     readers named in the label, and beside it the Opus-paired change against F6's arm P with its interval. Arm A0
     is reported in the results, not in README.
   - **"The same questions, against an agent with list, grep and read tools"** shows the whole arm's three-reader mean
     beside the file agent's stored 67.6%, each labelled with its build or date and its readers, and the comparison
     between them is the Opus-paired difference (the one reader both rows share), with its interval.
4. **The whole-system arm against the file agent** sets README's "where gbrain loses" bullet from the Opus-paired
   difference. If the whole 95% interval lies below 0, the bullet stays under "where gbrain loses" with the new
   numbers. If the interval includes 0, the bullet says we could not tell the two apart at this sample size, and names
   the smallest detectable difference. If the interval lies above 0, the bullet leaves "where gbrain loses". No ranking
   word is written in any case, because 10 conversations cannot rank two systems.

## System under test

gbrain at **the newest release on gbrain's master when the first counted cell starts**. Today that is v0.60.742.0,
`ae8201041c21101dc8c5127afc1be4a047049483`. The tags are read again before the first counted cell
(`git ls-remote --tags https://github.com/garrytan/gbrain.git`). If a newer release exists then, the pin moves to it in
a dated amendment, with a note on whether it touches this path. The build freezes once the first counted gbrain cell
starts, and the results name it.

### Brain build, one brain per conversation

F6's brain build, unchanged (F6 preregistration, "Brain build"): the Q1 install recipe with
`facts.default_visibility world`, every session as a `type: conversation` page with its date, gbrain's own
`extract-conversation-facts` pass under a recorded per-conversation runaway cap, `repair safe-chunks`, Q1's quiesce
barrier, the fact index, and `gbrain serve --surface full`. The model gbrain uses for fact extraction (and, since
v0.60.738.0, for slot tagging) is its own default at the pin, part of the system under test and not a reader. The dry
run records which model that is.

F6's rule for brains that fail their final readiness check stays: on F6's S1 build, conversations c8 and c9 failed it
because 2 and 3 pages parsed to zero messages. The conversation parser is unchanged since, so the same is expected.
Such conversations are scored, and every result is also shown without them as a sensitivity view.

### Arms

All three arms read the same brain over MCP, which gbrain treats as a remote caller. Every arm writes F6's six search
keys before it reads, as F6 did, so no arm inherits another's settings: the shim stops serve, sets each key, reads each
key back, and starts serve again, and a key that reads back wrong invalidates the cell, which is never scored. Each
retrieval record carries its arm's settings hash, and the results count records whose hash differs from their arm's
(expected 0).

| Arm | Call | Search keys | Pairs with |
|---|---|---|---|
| P, the headline | `query {limit: 50, token_budget: 5500}`, packed to 8,000 cl100k tokens | facts block on, chunk budget unit, date header off, titles off, fact source pages off, saved facts supersede on | F6 arm P (61.0%) and its particle-1 re-read |
| A0 | `query {limit: 50}`, gbrain's auto delivery, packed to 8,000 | as P with the facts block off | Q1's 8,000-token row (56.3%) and F6 arm A0 (53.8%) |
| Whole | a bare `query`, gbrain's own default amount | P's keys | Q1's whole-system row (58.9%) and the file agent |

The survey behind this plan found that P's six keys equal gbrain's shipped defaults at v0.60.741.0, so P is gbrain as
it ships with an 8,000-token budget. The keyless prep checks the same at the pinned release. If any default differs there, P keeps F6's keys, the whole arm
takes the shipped defaults, and an amendment records the difference before any counted cell.

### The file agent

The file agent is not re-run (Garry's decision Z, 2026-11-19). It reads the raw Markdown files and nothing gbrain
produces, so gbrain changes can't move its score. README keeps its stored row, 67.6% on the 198 questions it shares
with gbrain's whole-system row, labelled with its measurement date and harness. The repository's reuse gate
(`eval/runner/q1/reuse-check.ts`) refuses to call that row reused, because the agent loop's code changed since, so it
is shown as a stored row, never as a new measurement.

## Set

S1, BEAM-10M sealed: 10 conversations and Q1's selection of 200 questions, with Q1's exclusion (199 scored). S1 has
never been used to tune gbrain. Packing, tokenizer, reader prompt and output limit are Q1's.

## Readers

| Reader | How it reads | Effort |
|---|---|---|
| claude-opus-5-5 | live, every arm | medium |
| gpt-6.2-sol | live, every arm | medium |
| particle-1 | re-reads each arm's frozen contexts byte for byte (`eval/runner/q1/reread-cell.ts`), each checked against its recorded SHA-256 | medium, with its 16,000-token output floor |

Every reader reads the same frozen context for a given arm and question. Effort is medium for every reader, as F6
fixed it.

**Why these readers.** The repository's model rules replace Sonnet 5.5 with the newest frontier GPT and particle-1, so
F6's and Q1's three-reader means can't be compared with this run's. **claude-opus-5-5 is the clean pair:** it is the
only reader in every published row (F6 P 60.7%, Q1 component 55.3%, Q1 whole system 56.0%). particle-1 also pairs, under the
bridge view, with F6's particle-1 re-read of P's contexts (56.4%, [F6 add-on](../findings/2026-11-04-particle-1-f6-addon.md)). The
runner's `FRONTIER_READERS` still names gpt-6.1-sol; the keyless prep moves it to gpt-6.2-sol in its own commit.
`bun scripts/model-freshness.ts` runs again before the first counted cell, and a newer frontier model goes in by
amendment.

## Judges

Every answer gets two judges, scored apart and never averaged:

| Reader | Protocol judge (the bridge) | Frontier judge |
|---|---|---|
| claude-opus-5-5 | gpt-4.1-mini | gpt-6.1-sol |
| particle-1 | gpt-4.1-mini | gpt-6.1-sol |
| gpt-6.2-sol | gpt-4.1-mini | claude-opus-5-5 |

- **gpt-4.1-mini** is BEAM's canonical judge and the judge of every published BEAM-10M row, so it is the bridge to
  them. AGENTS.md allows it only as that bridge.
- **The frontier judges** follow the crew's BEAM rule (`frontierJudgeOf`, `eval/runner/q1/cells/definitions.ts`):
  gpt-6.1-sol judges the claude-opus-5-5 and particle-1 rows, and claude-opus-5-5 judges the gpt-6.2-sol rows,
  because no model judges its own family's rows and particle-1 never judges. They are the judges
  [GST-1365](2026-11-05-gst-1365-judge-robustness.md) used to re-judge F6's and Q1's answers. GST-1365 found the
  frontier judges right more often where the two views disagree and recommended them for new BEAM work.
- The frontier judges run at the crew's pinned settings (`PER_READER_JUDGE_SETTINGS`: medium effort, 8,000 output
  tokens). GST-1365 judged at each judge's default effort, so its stored judgments are not used for any pair; the
  stored answers a pair needs are judged again (below). A missing judgment counts as unjudged, so a cell is complete
  only when both judges have graded every answer.

### Stored answers judged again, in custody

The frontier view pairs this run's answers with stored answers judged by the same judge at the same settings. Four
stored S1 answer sets are judged again in custody by gpt-6.1-sol at the pinned settings, in a paid window, before the
pairing report runs:

1. F6's arm P, claude-opus-5-5 answers (the primary and its smallest detectable difference).
2. F6's arm A, claude-opus-5-5 answers (the smallest detectable difference).
3. Q1's whole-system arm, claude-opus-5-5 answers (whole against Q1, and the second smallest detectable difference).
4. Q1's file agent, claude-opus-5-5 answers (whole against the file agent, and the second smallest detectable
   difference).

Every other pair with a stored row (A0 against Q1's 8,000-token row and F6's A0, particle-1 against F6's particle-1
re-read, and the file agent's F6 rerun) is reported under the bridge view only. Only aggregates of these judgments
leave custody.

### Judge agreement check (R78), before any number counts

On public data only, before any counted cell:

1. **Items.** GST-1365's known-answer control builder (`buildControls` in `eval/runner/q1/rejudge-systems.ts`)
   writes up to four controls with a known verdict for each of 50 rubric-scored questions of public BEAM-1M dev
   conversations: the gold answer (pass), another question's gold answer (fail), a fixed "I can't find that in our
   conversation history." (fail, or pass on an abstention question) and the gold answer inside a hedge (pass). That
   gives more than 40 labelled items, with at least 15 in each class.
2. **Grading.** Every judge whose numbers count grades every item: gpt-6.1-sol (Opus and particle-1 rows),
   claude-opus-5-5 (gpt-6.2-sol rows) and gpt-4.1-mini (the bridge). Each grades through the production judge request
   (BEAM's rubric instrument, the settings above), pass at a score of 0.5.
3. **Gate.** A judge's view counts only if its Cohen's kappa against the known verdicts is at least 0.6 on at least 40
   items, and at most 1% of its calls hit the output limit. A frontier judge that fails stops the experiment before any
   counted cell, and its numbers go to GBEV-3. If gpt-4.1-mini fails, the bridge view is reported as descriptive only.
4. **Reported.** Each judge's kappa, error rate per control kind with Wilson 95% intervals, and the pairwise agreement of
   the three judges on the dry run's real answers (descriptive).

The check's item texts stay out of the repository. Its report carries counts, rates and kappas.

## Statistics

### Primary: arm P against F6's arm P, on claude-opus-5-5

- **Pair.** For each S1 question scored in both runs, this run's Opus score on arm P minus F6's Opus score on arm P,
  under the same judge. BEAM's graded score (0, 0.5 or 1 per rubric item, averaged) times 100.
- **Estimate.** The mean paired difference, with a 95% interval from a conversation-cluster bootstrap (10,000
  resamples, seed `beam10m-newest`). A question-level bootstrap interval is a sensitivity view.
- **Views.** The frontier view (gpt-6.1-sol on this run's Opus answers against gpt-6.1-sol's new judgments of F6's
  stored Opus answers, both at the pinned settings) decides outcome 1. The bridge view (gpt-4.1-mini against F6's published judgments) is reported beside it, and if the two views
  disagree on outcome 1, the findings' first lines say so.
- **Regression (outcome 1).** The mean paired difference is at or below minus the smallest detectable difference.
- **Smallest detectable difference.** At 80% power and two-sided alpha 0.05, 2.80 times the standard error of a
  paired Opus difference on S1. The standard error is estimated in custody before the freeze from F6's stored S1
  per-question Opus scores, using F6's arm P minus arm A as the stand-in for a same-system pair, clustered by
  conversation as above, under each judge view (the frontier view from the judgments made again above). The planning estimate is about 6 points (from F6's S1 paired
  intervals, which have half-widths of about 4). Only the resulting figures leave custody, and they are recorded in the
  freeze amendment before any counted cell.

### Secondary comparisons, descriptive

- **Whole system against the file agent.** This run's Opus whole-arm scores minus the file agent's stored Opus scores
  (Q1's run, the row README shows), paired by question, under both views, with the same interval. The file agent's F6
  rerun (68.2%, Opus 72.2%) is a bridge-view sensitivity view. Its smallest detectable difference is computed the same
  way from Q1's stored whole-arm and file-agent Opus rows and recorded in the freeze amendment. Q1's three-reader figure
  was 12.4 points.
- **A0 against Q1's 8,000-token row and F6's A0,** on Opus, paired, under the bridge view. This sizes the net change
  on Q1's call shape.
- **Whole against Q1's whole-system row,** on Opus, paired, under both views. This sizes the 3-page cap and the fences
  together.
- **particle-1 against F6's particle-1 re-read of arm P,** paired, under the bridge view.
- **Per reader and per arm:** each reader's score with its clustered interval, and the Opus plus gpt-6.2-sol mean.
  The three-reader mean of this run is reported but never compared with F6's or Q1's, whose readers differ.
- **Per ability:** P minus F6 P on Opus for each of BEAM's ten abilities, with intervals. The predicted directions are
  up for knowledge update, temporal reasoning, event ordering and contradiction resolution, and down for multi-session
  reasoning and summarization. About 20 questions per ability make these descriptions, not tests.
- **Fence share.** For arm P's delivered contexts: mean rows per context, mean fence tokens per context and their share
  of gbrain's 5,500-token budget, measured by the shim's delivered rows (cl100k). This tests the first change's
  mechanism directly. The dry run measures it on public data first.

### Missing data and completeness

Q1's rules apply. Product failures (`retrieval_error`, `unsupported`, `turn_cap`, `context_overflow`) score 0 and
stay in. Harness failures (`reader_error`, `judge_error`, `harness_invalid`, `budget_not_run`, or a missing row)
drop the question from that pair, and every drop is counted by reason. A claim needs at least 9 of 10 conversations and
at least 95% of the scheduled questions scored in both members of the pair. Excluded ids are published as counts, with
best-case and worst-case bounds.

### First table and cost per correct answer

The results' first table shows claude-opus-5-5 and particle-1 on each arm, with each reader's cost per correct answer.
For a reader and arm it is the reader's own dollars on that arm plus the arm's gbrain query dollars, divided by the
number of that reader's answers that score at least 0.5 under the frontier view. The brain build (ingest, extraction
and embeddings) is shared by every arm and reader, so it is given once, per conversation and per question, beside the
table, as F6's add-on did. Judge dollars are left out, because they buy the measurement, not the answer. gpt-6.2-sol
follows. Dollars come from the metering proxy's usage fields at list price.

## Dry run (public BEAM-1M), before any sealed cell

Through the real launch path (a Ubicloud VM, the metering proxy, one ledger), on public BEAM-1M dev conversation
`1m-16` with 10 questions (F6's dry-run conversation, so its ingest rate compares directly with F6's at `0ccf2bdd`):
all three arms, both live readers, particle-1's re-reads in a paid window, both judges. It checks that the stack runs at
the pin, measures ingest and extraction rates and hours per million tokens at the pin, measures the fence share, and
feeds the judge check's real-answer agreement. Its receipt goes under `docs/benchmarks/2026-11-19-beam10m-newest/dry-run/`.
A stack that does not run, or an ingest rate far from F6's, comes to GBEV-3 before any sealed cell.

## Custody and exposure

S1 lives with the custody program on its host (`~/Private/gbrain-heldout-custody/`). GBRA-108 agreed on 2026-11-19
that this crew runs S1's cells there, under seven conditions, which this experiment follows:

1. **Sealed text stays in custody.** S1 text stays inside the custody directory on the custody host, and its layout is
   unchanged. The one exception is the hash-checked copies on cell VMs under condition 4, as GBRA-108's conditions
   allow. No sealed text and no per-question S1 row goes to a Capy drive, a transcript, a pull request or a message.
   Only aggregates leave custody.
2. **Contexts are checked before any counted cell.** The S1 files are re-read byte for byte against the campaign's
   recorded hashes before any counted cell, and particle-1's re-reads check every frozen context against its SHA-256.
3. **gbrain runs in the run directory.** Every gbrain install for this experiment lives inside its run directory with
   its own `GBRAIN_HOME`, so the host's own gbrain and brain are never opened.
4. **Sealed text on VMs.** The S1 cells run on Ubicloud VMs, as F6's did, so sealed text does reach VMs. Each VM gets
   hash-checked copies of its one conversation outside the checkout. At teardown the copies are deleted and the VM is
   destroyed, never reused. VMs are named `ubirun-<owner>-<epoch>-<suffix>-t<hours>` (F6 amendment A3), and the
   close checks that `ubi-runner.sh list --mine` prints nothing.
5. **No prompts on the host's screen.** Every step on the custody host runs non-interactively over a shell. A step
   that would raise a prompt on its screen stops, and GBRA-108 is told.
6. Spend is this crew's, and Garry saw the total before the first wave (plan X, approved on 2026-11-19). Figures stay
   in the tracking issue, not here.
7. GBRA-108 gets one line at the start (campaign hash, release, who runs it) and one at the close (aggregates written,
   VMs destroyed, custody check passing).

Before any counted cell: this preregistration merged, a fresh clone of the freeze commit on the custody host with its
campaign hash (`bun eval/runner/shootout-cell.ts hash --campaign <manifest>`) matching the one computed off the host,
`bun run eval:scoreboard doctor --for sealed` passing there, one campaign ledger in the run's state directory, and
paid windows for the paid calls.

### Provider data use

| Provider | Receives S1 text for | Data use |
|---|---|---|
| Anthropic | Opus reads, Opus judging of gpt-6.2-sol's answers, gbrain's fact extraction | no training on API data by default |
| OpenAI | gpt-6.2-sol reads, gpt-4.1-mini and gpt-6.1-sol judging | no training on API data by default |
| Particle | particle-1 re-reads | zero data retention |
| Voyage | gbrain's embeddings and reranking | before any sealed text reaches Voyage, the runner confirms that the Voyage key the cell VMs receive belongs to the organization that opted out on 2026-11-03 |

These are the providers S1 already reached in Q1 and F6, plus Particle, which F6's add-on used.

## Harness (keyless prep, on the results branch before any paid call)

Each item is a dated commit on the results branch with a keyless test, before any paid call:

- The cell manifest for this experiment, built with Q1's tooling and F6's and RS1's lease helpers: the S1 gbrain cell
  with arms P, A0 and whole, per-reader frontier judging, particle-1 re-read plans, and the `1m-16` dry-run cell.
- The gbrain pin moved to the newest release (`bun eval/runner/gbrain-pin.ts bump`) and kept on this branch.
- `FRONTIER_READERS` moved to gpt-6.2-sol.
- The judge check, from `buildControls`, on public BEAM-1M dev questions, refusing to spend outside a paid window.
- The re-judging of the four stored answer sets above, refusing to spend outside a paid window.
- The pairing report: it reads this run's receipts, F6's and Q1's stored rows and the new judgments in custody, and
  writes only aggregates.
- The fence-share measurement in the shim's delivered-row record.

Tests reach no real provider: they use the dead keyless upstream with blanked keys.

## Freeze

Recorded in a dated amendment on the results branch before the first counted cell:

- gbrain's newest release at launch, by sha and version.
- The campaign manifest and its hash, computed on and off the custody host.
- The two smallest detectable differences, under each judge view.
- The judge check's result.
- The dry run's measured rates and fence share.

Nothing above changes after the first counted cell except by a dated amendment.

## What it can and can't claim

**It can say:** how gbrain's newest release reads BEAM-10M at 8,000 tokens next to `0ccf2bdd`, on the same questions
and the same Opus reader, with an interval; whether that falls by more than the smallest detectable difference; and how
far gbrain's whole system sits from the file agent's stored row.

**It can't say:** which change caused a difference (the fence share is evidence, not proof), anything about other
budgets, benchmarks or builds, or a ranking against the file agent or any other system.

## Amendments

None yet.

## Disclosures

- gbrain is Garry Tan's own project.
- Disclosure: Y Combinator, which Garry Tan runs, is an investor in Particle, which makes particle-1.
- Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator. Garry Tan runs Y Combinator.
