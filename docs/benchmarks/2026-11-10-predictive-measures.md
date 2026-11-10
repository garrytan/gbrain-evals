# Do synthetic memory tests predict an agent's real failures? Results

- **We learned that a synthetic recall test ranks gbrain's search setups the way Garry's real brain does only when it
  carries the real brain's embedding gaps. You should build those gaps into a synthetic recall test (here, no synopsis
  vectors and 10% of chunks with no vector) and check its signs against real-brain contrasts before it gates anything.**
  With the gaps, G2 (recall under real conditions) reads PREDICTIVE: all 13 of the 13 real batch 2 contrasts whose
  interval excludes zero agree in sign with the synthetic brain, and so do all 5 of batch 3's. Without the gaps, the
  same brain reads NOT PREDICTIVE at both gbrain versions, because it misses the paraphrase gap of configured search:
  the real brain finds 40 points fewer paraphrased questions than exact ones (95% interval −56 to −24), and the clean
  synthetic brain shows no gap at all. The agreement is about direction, not size. The synthetic brain is far easier
  (configured search finds 90% of paraphrases against the real brain's 48%), and its configured paraphrase gap is 7
  points against the real 40. G4 (wrong entity) also reads PREDICTIVE, on all 3 of its real entity contrasts.
- **We learned that Opus and Sol never claimed a write had landed when it hadn't: 0 times in 960 write episodes.
  particle-1 did 7 times in 480. You should check a low-cost model's write claims against the brain before trusting
  them.** This is the failure Wintermute reported, "writes reported as done that never landed", reproduced in G3.
- **We learned that particle-1 is the model that breaks gbrain's answer contracts, and Opus and Sol keep them. You
  should validate a low-cost model's answer format, not only its content.** When gbrain hides the page an answer needs
  from a remote caller, Opus and Sol abstain in 311 of 312 such episodes and particle-1 in 118 of 156; its remote-caller
  success is 18.5 points below Opus (95% interval 11.5 to 25.5), under the 21.7 points this sample could detect. On
  entity questions, 50 of particle-1's 240 answers weren't the entity id the task asked for, putting it 20.8 points
  below Opus (12.9 to 29.6), just over the 19.8 points this sample could detect. None of those 50 named a different
  person: 43 named the right person in the wrong form.

What didn't work:

- **G3's scores, as designed, reward actions gbrain or the task told the agent not to take.** Every one of Opus's and
  Sol's G3 misses comes from two task types where they declined to act on purpose: they followed gbrain's refusal
  guidance on a pending import, which says the user needs to sync the source on its host, and on MCP they refused to
  guess a source id without the `--brain host` flag the task said every sources command needs. Leave out the
  pending-import tasks and the MCP sources task, and Opus and Sol each succeed in all 388 of their remaining episodes,
  where particle-1 succeeds in 370. particle-1's raw G3 lead on MCP (93% against Opus's 77%) comes entirely from taking
  those actions. This is a method problem in G3's scoring, recorded as FIX-METHOD.
- **Four of the six tests can't reach a verdict yet.** G3's real reference arm had no write tools, so it could never
  produce the write refusals G3 compares against. G6's real reference was never published. G5 needs a later real
  latency measurement at two gbrain versions that doesn't exist. G1 (freshness) has 2 qualifying real contrasts of the
  3 it needs, because the third sits at the real brain's ceiling on exact questions and its floor on paraphrases, so
  it had no room to qualify. Each reads NO REFERENCE YET, and the reason for each is in the [verdict table](#verdicts).
- **G1's and G4's agent tasks don't separate frontier models.** Opus and Sol answer 1,438 of their 1,440 episodes
  correctly. No model gave a stale fact in G1's 1,440 episodes, and no model picked the wrong person in G4's 720, so
  the failures those tests were built from didn't occur at the agent level.

The [preregistration](2026-11-09-predictive-measures-preregistration.md) froze on 2026-11-09. It asks one question of
six synthetic memory tests built from failures that Wintermute, the agent that runs Garry Tan's gbrain brain every day,
described: does each test rank gbrain configurations and versions the same way the real brain does? A test that does is
**PREDICTIVE** and may gate gbrain's nightly loop. One that doesn't is **NOT PREDICTIVE**. One with no real-brain
contrast to check against reads **NO REFERENCE YET**. Every counted run below is finished, and these are the
experiment's final verdicts.

gbrain is a personal knowledge brain: Markdown pages in Postgres, found with keyword, vector and hybrid search, and
written through `remember`, `put` and sync. The models under test are Claude Opus 5.5 (`claude-opus-5-5`), GPT-6.1
Sol (`gpt-6.1-sol`) and particle-1, the low-cost primary.

- G3 (write landing) and G6 (gold out of view) ran on 2026-11-09 at gbrain 0.60.557.0 (`62637c96`), from runner
  [a1cfff13](https://github.com/garrytan/gbrain-evals/commit/a1cfff13fbabc2eb9cd019638b4d3a967a71cbc9),
  attested against the preregistration. 1,440 and 1,200 episodes, none errored.
- G2's counted batch 2 scorecard ran on 2026-11-10 from runner
  [e0c55bb0](https://github.com/garrytan/gbrain-evals/commit/e0c55bb005010c8a046fc7e6f547f496bb6a0b04) at gbrain
  0.60.593.0 (`27f8b9d6`), the version the real batch 2 ran.
- Batch 3 of live recall ran on Garry's box on 2026-11-10 from runner
  [40235f35](https://github.com/garrytan/gbrain-evals/commit/40235f3586f3dbbae751323b79e64c1b93376683) at gbrain
  0.60.641.0 (`2560ffdd`): 51 questions, 99 eligible question forms. Its aggregates give the real side of G2's batch 3
  layer and of G1's and G4's retrieval layers.
- G5 (latency at scale) ran on 2026-11-10 from runner
  [1f606786](https://github.com/garrytan/gbrain-evals/commit/1f606786650ea5706e5247945482fbd3ab023c28) under the dated amendment at
  [a5634d00](https://github.com/garrytan/gbrain-evals/commit/a5634d006eee26b6a887c2add678e2016da6bfea), at gbrain
  0.60.549.0 and 0.60.570.0.
- G1's and G4's agent cells ran on 2026-11-10 at gbrain 0.60.557.0 (`62637c96`), from runner
  [023012e1](https://github.com/garrytan/gbrain-evals/commit/023012e11805ea9ba4cc848885b7697ed3f3a362), attested against
  the preregistration at a5634d00. 1,440 and 720 episodes, none errored.

This repository pinned gbrain 0.60.557.0 while these runs were made; the results pull request moves the pin to main's
`d253ec0f` (0.60.623.0). Every number here names the version it ran.

## Results by model

Every agent test ran each task four times per model (k = 4). Success is the share of episodes scored correct by a fixed
answer schema; no model judge scores any counted cell. Cost per correct answer divides every dollar a model's episodes
cost, as the providers' usage fields reported it, by its correct answers.

| Test and surface | Model | Success | pass^4 | Cost per correct answer |
|---|---|---|---|---|
| G1, gbrain CLI | Claude Opus 5.5 | 100% (480/480) | 1.000 | $0.018 |
| | particle-1 | 98.3% (472/480) | 0.942 | $0.0038 |
| | GPT-6.1 Sol | 99.6% (478/480) | 0.983 | $0.010 |
| G3, gbrain CLI | Claude Opus 5.5 | 86.7% (208/240) | 0.867 | $0.035 |
| | particle-1 | 90.8% (218/240) | 0.683 | $0.011 |
| | GPT-6.1 Sol | 87.1% (209/240) | 0.867 | $0.015 |
| G3, gbrain MCP | Claude Opus 5.5 | 76.7% (184/240) | 0.750 | $0.075 |
| | particle-1 | 92.9% (223/240) | 0.833 | $0.025 |
| | GPT-6.1 Sol | 75.0% (180/240) | 0.750 | $0.034 |
| G4, gbrain CLI | Claude Opus 5.5 | 100% (240/240) | 1.000 | $0.013 |
| | particle-1 | 79.2% (190/240) | 0.650 | $0.0043 |
| | GPT-6.1 Sol | 100% (240/240) | 1.000 | $0.0068 |
| G6, local caller | Claude Opus 5.5 | 99.5% (199/200) | 0.98 (both callers) | $0.042 (both callers) |
| | particle-1 | 97.0% (194/200) | 0.73 (both callers) | $0.016 (both callers) |
| | GPT-6.1 Sol | 100% (200/200) | 1.00 (both callers) | $0.017 (both callers) |
| G6, remote caller | Claude Opus 5.5 | 99.5% (199/200) | | |
| | particle-1 | 81.0% (162/200) | | |
| | GPT-6.1 Sol | 100% (200/200) | | |

pass^4 is the chance that all four trials of a task succeed, averaged over tasks; it falls when a model is right on
some trials of a task and wrong on others.

**Paired comparisons.** Each difference is the mean over tasks of the per-task success difference (four trials each),
with a 95% percentile bootstrap interval over tasks. The binding minimum detectable differences (MDDs) were fixed
before any counted cell: 14.0 points for G1, 19.8 for G3 per surface, 19.8 for G4 and 21.7 for G6 per caller. A
difference smaller than its MDD reads "no measurable difference", whatever its interval.

| Comparison | Difference (points) | 95% interval | Tasks worse / better | Reading |
|---|---|---|---|---|
| G1, Opus − particle-1 | +1.7 | +0.6 to +2.9 | 0 / 7 | No measurable difference (below 14.0) |
| G1, Opus − Sol | +0.4 | 0.0 to +1.0 | 0 / 2 | No measurable difference |
| G3 CLI, Opus − particle-1 | −4.2 | −12.9 to +3.8 | 8 / 13 | No measurable difference |
| G3 CLI, Opus − Sol | −0.4 | −1.3 to 0.0 | 1 / 0 | No measurable difference |
| G3 MCP, Opus − particle-1 | −16.3 | −25.0 to −7.9 | 15 / 3 | No measurable difference (below 19.8) |
| G3 MCP, Opus − Sol | +1.7 | 0.0 to +3.8 | 0 / 3 | No measurable difference |
| G4, Opus − particle-1 | +20.8 | +12.9 to +29.6 | 0 / 21 | Measurable difference (above 19.8) |
| G4, Opus − Sol | 0.0 | 0.0 to 0.0 | 0 / 0 | No measurable difference |
| G6 local, Opus − particle-1 | +2.5 | 0.0 to +5.5 | 1 / 5 | No measurable difference |
| G6 remote, Opus − particle-1 | +18.5 | +11.5 to +25.5 | 1 / 22 | No measurable difference (below 21.7) |
| G6 remote, Opus − Sol | −0.5 | −1.5 to 0.0 | 1 / 0 | No measurable difference |

"Tasks worse / better" counts the tasks on which Opus did worse and better than the other model. Four differences have
intervals that exclude zero, all of them Opus against particle-1. Three (G1, G3 MCP and G6 remote) are smaller than
their binding MDDs, so they read as no measurable difference under the rule fixed in advance; the G3 one comes from the
scoring problem described [under G3](#g3-write-landing-and-call-contract). The fourth, G4, is just above its MDD (20.8
points against 19.8, with an interval reaching down to 12.9), and it comes from particle-1's answer form rather than
from choosing the wrong person, as [the G1 and G4 agent cells](#g1-and-g4-agent-cells) show.

## Verdicts

| Measure | Verdict | R48 call | Why |
|---|---|---|---|
| G1 freshness across pages | **NO REFERENCE YET** (retrieval layer: 2 of 3 real contrasts qualify, all 3 signs agree) | KEEP, report-only | A missing reference, not a null: the third contrast sits at the real brain's ceiling and floor |
| G2 recall under real conditions | **PREDICTIVE** (batch 2 layer 13 of 13 agree; batch 3 layer 5 of 5) | KEEP | May gate the nightly loop, on direction only |
| G3 write landing and call contract | **NO REFERENCE YET** | FIX-METHOD | Its reference can't exist as designed, and its scoring counts honest pending reports as failures |
| G4 wrong entity | **PREDICTIVE** (retrieval layer: 3 of 3 agree) | KEEP | May gate the nightly loop, on direction only |
| G5 latency at scale | **NO REFERENCE YET** | KEEP, report-only | Needs a later real p95 at both versions |
| G6 gold out of view | **NO REFERENCE YET** | KEEP, report-only | Its reference was never published |

R48 is this team's rule that a measure that doesn't show its worth gets one "Why null?" cycle and then a call of KEEP,
FIX-METHOD or CUT-CANDIDATE. G1's and G4's verdicts come from their retrieval layers only. Their agent layers map
contrasts from the phase 2 agent run that G1 and G4 can't produce (they have no no-retrieval arm, and phase 2 published
no Opus-against-particle-1 arm B contrast), so their agent episodes are reported as descriptive results and change no
verdict.

## The concrete case

A synthetic test is a fictional brain built to copy a real failure. For recall, that's a few hundred invented pages,
each with a question in two forms: one that uses the page's own words (exact) and one that doesn't (paraphrase). The
real reference is live-recall [batch 2](2026-11-07-live-recall-batch2.md): 50 questions Wintermute wrote about Garry's
brain, run against six search setups.

On the real brain, configured search (hybrid search with Voyage's rerank-2.5 reranker, the brain's own setting) finds
the answer page in its top five for 88% of exact questions and 48% of paraphrases. That 40-point drop is a *contrast*,
and its 95% interval (−56 to −24) excludes zero, so it *qualifies*. The synthetic brain is predictive for that contrast
if its own estimate has the same sign. The test reads PREDICTIVE only if every qualifying contrast agrees, and no
synthetic contrast with an interval clear of zero points the other way.

## The experiment and results

### G3: write landing and call contract

G3 has 60 tasks on two surfaces, the gbrain CLI and gbrain's MCP server. Each task asks the agent to save a fact or a
page, and stages one of the eight refusal causes Wintermute counted on the real brain (a page file with an unimported
Git change, a missing provenance, two entities with one name, a sources command without `--brain`, and so on). A
landing ledger compares the brain before and after, so a write counts only if it is really there.

| Model, surface | Refusals per 100 calls | Recovered after a refusal | Refusals never retried | Reported done, not landed |
|---|---|---|---|---|
| Opus, CLI | 7.96 | 1.6% | 61 | 0 |
| Opus, MCP | 12.63 | 0% | 61 | 0 |
| Sol, CLI | 7.22 | 1.6% | 63 | 0 |
| Sol, MCP | 11.08 | 29.7% | 72 | 0 |
| particle-1, CLI | 18.73 | 56.6% | 119 | 6 |
| particle-1, MCP | 9.05 | 54.2% | 52 | 1 |

**Where the frontier models "failed".** All 64 of Opus's pending-import episodes and 63 of Sol's 64 end with an honest
report that the write is held and not landed. gbrain's refusal says the fact is queued for one automatic replay and
that the user needs to sync the source on its host. The task asks the agent to "make sure it actually lands", and the
scorer accepts an honest pending report only for the uncommitted-edit task, so these score as failures. particle-1 ran
the sync itself in most of these episodes and landed the write. On MCP, the sources task says every sources command
needs `--brain host`, which MCP's `sources_list` can't pass. Opus (24 of 28 episodes) and Sol (all 28) saved nothing
rather than a source id they couldn't confirm. particle-1 saved the only id the tool listed, which happened to be right on a
one-brain test machine. Which behaviour is right is a product question for gbrain's owners; the scorer shouldn't
settle it by counting one side as a failure.

**The two-window read.** Under the preregistration's amendment, G3's `two_range_read` tasks are reported outside the
verdict. No model hit that refusal: 0 refused episodes of 28 exposed, for every model and surface.

### G6: gold out of view

G6 has 50 tasks, each answered by a local caller that sees every page and a remote caller from which gbrain hides
some pages: by a direct privacy flag, by inheriting an alias's privacy, or by a derived page's default. When a page the
answer needs is hidden, the right answer is to abstain. 44 of the 200 remote-caller episodes per model have every gold
page in view; the other 156 don't.

| Model | Remote, gold in view: correct | Remote, gold hidden: abstained | Answered anyway | Both answered and abstained | Invalid |
|---|---|---|---|---|---|
| Opus | 44 / 44 | 155 / 156 | 0 | 1 | 0 |
| Sol | 44 / 44 | 156 / 156 | 0 | 0 | 0 |
| particle-1 | 44 / 44 | 118 / 156 | 5 | 31 | 2 |

In 31 hidden-gold episodes particle-1 set both flags at once, answering from the page it could see while also saying
it abstained; the fixed schema scores that wrong. Three of those cited a decoy page from another project.

### G2: recall under real conditions, batch 2 layer

The synthetic brain has 180 invented pages and 100 questions (20 each of identifier, error string, time window,
cross-source and topic questions), each in an exact form and an Opus-written paraphrase. Four conditions copy measured
conditions of the real brain: **clean**; **embedding** (no synopsis vectors and 10% of chunks with no vector, as on the
real brain); **shells** (half the pages that aren't gold turned into empty shells, as with about half of sampled media
pages); and **real** (both). Each condition ran at two gbrain versions on Voyage embeddings and reranking. The counted
verdict reads the real condition at 0.60.593.0; the other seven scorecards are secondary.

Success@5 by arm, exact / paraphrase:

| Arm | Real brain (batch 2) | Synthetic, clean | Synthetic, embedding | Synthetic, real (counted) |
|---|---|---|---|---|
| keyword | 64% / 0% | 77% / 0% | 77% / 0% | 77% / 0% |
| vector | 56% / 32% | 100% / 99% | 90% / 89% | 90% / 89% |
| hybrid_lexical | 80% / 16% | 100% / 58% | 100% / 58% | 100% / 58% |
| hybrid | 74% / 34% | 100% / 99% | 91% / 89% | 91% / 89% |
| configured | 88% / 48% | 100% / 100% | 97% / 90% | 97% / 90% |

The shells condition matches clean at every arm and form, so shells alone change nothing at this size.

**The 16 mapped contrasts** (success@5 difference; real estimate and 95% interval, then the synthetic real-condition
brain at 0.60.593.0):

| Contrast | Real | Synthetic | Counts as |
|---|---|---|---|
| P1: hybrid − hybrid_lexical, paraphrase | +0.18 (0.04 to 0.32) | +0.31 (0.20 to 0.42) | agree |
| P2: configured − hybrid_lexical, paraphrase | +0.32 (0.16 to 0.48) | +0.32 (0.21 to 0.43) | agree |
| batch 1's P1: hybrid − hybrid_lexical | +0.06 (−0.04 to 0.16) | +0.11 (0.035 to 0.18) | real doesn't qualify |
| hybrid_lexical − keyword | +0.16 (0.07 to 0.26) | +0.405 (0.345 to 0.465) | agree |
| hybrid − keyword | +0.22 (0.13 to 0.31) | +0.515 (0.445 to 0.585) | agree |
| configured − keyword, paraphrase | +0.48 (0.34 to 0.62) | +0.90 (0.84 to 0.95) | agree |
| configured − hybrid | +0.14 (0.06 to 0.22) | +0.035 (0.015 to 0.06) | agree |
| vector − keyword | +0.12 (0.00 to 0.23) | +0.51 (0.435 to 0.58) | real doesn't qualify |
| configured − keyword, exact | +0.24 (0.10 to 0.38) | +0.20 (0.13 to 0.28) | agree |
| hybrid − keyword, paraphrase | +0.34 (0.22 to 0.48) | +0.89 (0.83 to 0.95) | agree |
| configured_window − configured | +0.05 (0.00 to 0.15) | 0.00 (0 to 0) | real doesn't qualify |
| paraphrase − exact, keyword | −0.64 (−0.76 to −0.50) | −0.77 (−0.85 to −0.69) | agree |
| paraphrase − exact, vector | −0.24 (−0.38 to −0.10) | −0.01 (−0.03 to 0.00) | agree |
| paraphrase − exact, hybrid_lexical | −0.64 (−0.78 to −0.50) | −0.42 (−0.52 to −0.32) | agree |
| paraphrase − exact, hybrid | −0.40 (−0.54 to −0.26) | −0.02 (−0.05 to 0.00) | agree |
| paraphrase − exact, configured | −0.40 (−0.56 to −0.24) | −0.07 (−0.12 to −0.03) | agree |

13 of 16 real contrasts qualify, and all 13 agree in sign. Kendall's tau over the arm order is 0.60 on exact forms and
0.80 on paraphrases; it is reported and never gates. Two of the agreeing contrasts (vector's and hybrid's paraphrase
gaps) have synthetic estimates of one or two points with intervals that touch zero. The rule counts their sign, so they
agree, but they carry almost no information.

**Secondary readings** (never gate):

| Condition | 0.60.557.0 | 0.60.593.0 | Contrast that fails |
|---|---|---|---|
| clean | NOT PREDICTIVE | NOT PREDICTIVE | paraphrase − exact, configured (synthetic 0.00) |
| embedding | PREDICTIVE | PREDICTIVE | none |
| shells | NOT PREDICTIVE | NOT PREDICTIVE | paraphrase − exact, configured (synthetic 0.00) |
| real | PREDICTIVE | PREDICTIVE (counted) | none |

The whole difference between the passing and failing conditions is that one contrast. Without missing vectors,
configured search finds every synthetic paraphrase, so there is no paraphrase gap to predict. With 10% of chunks
unembedded, paraphrases whose answer sits in an unembedded chunk can only be found by keyword search, which doesn't
match a paraphrase, and a gap opens. The gap is real in direction and much too small in size.

### Batch 3: G2's batch 3 layer and G1's and G4's retrieval layers

Batch 3 of live recall asked 51 frozen questions about Garry's brain: 25 about freshness (the newer of two pages on the
same subject is the answer) and 26 about entities (the page about the right one of two similar names is the answer),
each in an exact and a paraphrased form. It ran on 2026-11-10 from 11:07:02Z to 11:17:40Z on Garry's box, from runner
[40235f35](https://github.com/garrytan/gbrain-evals/commit/40235f3586f3dbbae751323b79e64c1b93376683) at gbrain
0.60.641.0 (`2560ffdd`), schema 297, through a role that could only read (`no_write_privilege`). 99 of the 102
question forms were eligible: two forms were dropped because hybrid_lexical ran degraded, and one because keyword
search errored. A first attempt at 10:59Z stopped before it read any question, because the database pooler refused the
read-only role's password (a role of the same name had been dropped and made again earlier that day). It left no
scorecard. The run here, made with a new role name, is batch 3's one counted run. The
[scorecard](2026-11-10-live-recall-batch3/b3-641-scorecard.md) is published as the `live-recall-b3` reference.

| Arm | success@5, all forms (n = 99) | Freshness, exact / paraphrase | Entity, exact / paraphrase |
|---|---|---|---|
| keyword | 49.5% | 100% / 0.0% | 92.0% / 3.9% |
| vector | 57.6% | 84.0% / 8.7% | 88.0% / 46.2% |
| hybrid_lexical | 55.6% | 96.0% / 4.3% | 100% / 19.2% |
| hybrid | 64.6% | 100% / 8.7% | 100% / 46.2% |
| configured | 78.8% | 100% / 39.1% | 100% / 73.1% |

Exact forms have 25 questions per type. Paraphrases have 23 for freshness and 26 for entities.

The synthetic side is the batch-3 synthetic brain (60 questions) at the same gbrain version, built with the same
embedding gaps as G2's batch 2 layer. Each contrast is a difference in success@5, in points, with its 95% interval.

| Contrast | Real brain | Qualifies | Synthetic brain | Sign |
|---|---|---|---|---|
| Freshness: configured − hybrid_lexical (P1) | +18.8 (8.7 to 28.6) | yes | +3.3 (0.0 to 8.3) | agrees |
| Freshness: hybrid − hybrid_lexical | +4.2 (−4.1 to 12.5) | no | +3.3 (0.0 to 8.3) | agrees |
| Freshness: configured − keyword | +18.8 (8.9 to 28.6) | yes | +50.0 (50.0 to 50.0) | agrees |
| Entity: configured − hybrid_lexical (P2) | +27.5 (17.3 to 37.5) | yes | +5.0 (0.0 to 10.0) | agrees |
| Entity: hybrid − hybrid_lexical | +13.7 (3.8 to 24.5) | yes | +3.3 (−3.3 to 10.0) | agrees |
| Entity: configured − keyword | +39.2 (27.5 to 51.0) | yes | +50.0 (50.0 to 50.0) | agrees |

- **G2's batch 3 layer reads PREDICTIVE.** All 5 of its 6 contrasts that qualify agree in sign, and no synthetic
  contrast clear of zero points the other way. With the batch 2 layer also PREDICTIVE, G2 reads **PREDICTIVE**.
- **G4's retrieval layer reads PREDICTIVE**, with all 3 of its entity contrasts qualifying and agreeing.
- **G1's retrieval layer reads NO REFERENCE YET.** Only 2 of its 3 freshness contrasts qualify, one short of the minimum
  of 3. Both of those agree in sign, as does the one that doesn't qualify. The contrast that misses, hybrid against
  hybrid_lexical, has no room to move on the real brain: on exact questions both arms are at or near the ceiling (100%
  and 96%), and on paraphrases both are near the floor (8.7% and 4.3%).

The agreement is about direction, not size. For configured against hybrid_lexical, the synthetic differences are a
quarter or less of the real ones (3.3 and 5.0 points against 18.8 and 27.5). For configured against keyword, they are
larger (50 points against 18.8 and 39.2). Each synthetic configured-against-keyword interval is a single point, because
every synthetic question in those two types splits the same way between the two arms.

**The relabelling.** Batch 3 read the brain partway through a relabelling of its page-visibility labels. Window 1, of
about 49, had been applied (961 pages relabelled and 39 declined), and window 2 had not. Batch 2 read the brain before
any of it. A label the relabelling hasn't reached yet can hide a page from the read-only role. If it hid a gold page,
every arm would miss that question alike, which pulls every contrast toward zero and can leave a layer short of three
qualifying contrasts. That didn't happen here: every one of the 51 questions' gold pages was visible to the role
(`gold_missing` is 0). The relabelling could still have hidden or exposed some pages that aren't gold, and we didn't
measure that. So the relabelling is not why G1 reads NO REFERENCE YET. The ceiling and floor above are. A batch 3 read
after the last window would be descriptive only, and it is never pooled with this one.

G1's and G4's agent cells ran only after these aggregates existed, as the preregistration requires. Their episodes
are descriptive, and the verdicts above don't change with them.

### G1 and G4: agent cells

G1 has 120 tasks in five patterns of 24: an entity page that lags a newer meeting page, a compiled summary that
contradicts its timeline, a decision reversed in another thread, a shared date against a published one, and "last
week" asked across time zones. Each task's answer is a value that only the fresher page holds. G4 has 60 tasks in four
patterns of 15: two people with one name, one of whom moved; a family sharing a surname; a company named like its
founder's handle; and a father and son with one name. Each G4 task's answer is the right person's entity id, such as
`people/kai-adeyemi-18` (all names here are invented). Both ran through the gbrain CLI at 0.60.557.0, four trials per task and
model, scored by a fixed schema.

Where the misses fall (correct episodes of 96 per G1 pattern and 60 per G4 pattern; patterns not shown are perfect for
every model):

| Test, pattern | Opus | Sol | particle-1 |
|---|---|---|---|
| G1, "last week" across time zones | 96 | 96 | 89 |
| G1, entity page lags a meeting | 96 | 96 | 95 |
| G1, decision reversed elsewhere | 96 | 94 | 96 |
| G4, family sharing a surname | 60 | 60 | 17 |
| G4, company named like a handle | 60 | 60 | 54 |
| G4, father and son | 60 | 60 | 59 |

- **G1.** particle-1's 8 misses are 7 wrong answers to "last week" across time zones and 1 answer outside the schema.
  Sol's 2 misses answered a reversed decision without opening the page that reverses it. No model gave the stale value
  in any episode. Opus answered 48 of its 96 "last week" episodes from search results without opening a page, and all
  48 were right.
- **G4.** No model's answer named a different person (`wrong_entity` is 0 for all three). Every one of particle-1's 50
  misses is an answer that isn't an entity id: in 27 the right id sits inside longer text, such as
  `Kai Adeyemi — people/kai-adeyemi-18`; 16 give the right person's name with no id; 4 are empty; and 3 are a bare
  number. 43 of the 50 are in the surname pattern, where particle-1 is right in 17 of 60.
- **An exploratory rescoring** that also accepts an answer containing the right id gives particle-1 217 of 240 (90.4%)
  on G4 and puts Opus 9.6 points ahead (95% interval 5.4 to 14.2), under the MDD. It is not the preregistered scoring,
  and the counted reading stays 190 of 240.

### G5: latency at scale

G5 built one synthetic brain of 300,034 pages (320,959 chunks, seed 55) on Postgres 16 with pgvector, at gbrain
0.60.549.0 (`a131fb20`), on one Ubicloud standard-16 VM (16 vCPUs, 64 GB). It then timed seven operations at
0.60.549.0, at 0.60.570.0 (`241cef5a`) and at 0.60.549.0 again, each probe on its own fresh copy of the brain, with
200 timed calls per operation after 3 warm-up calls, and 30 syncs. All three probes used the real brain's search setting,
mode `tokenmax` with the `voyage:rerank-2.5` reranker, and every scorecard records that gbrain resolved it. Embedding
and rerank calls are answered in-process, so no provider time is in any number here. G5 compares gbrain versions on
local compute only, and it can't predict the latency a user feels.

| Operation | 0.60.549.0 p50 / p95 (ms) | 0.60.570.0 p50 / p95 | 0.60.549.0 again p50 / p95 |
|---|---|---|---|
| query | 1,107 / 3,126 | 1,103 / 3,216 | 1,105 / 3,194 |
| search | 540 / 1,701 | 552 / 1,768 | 557 / 1,753 |
| get | 4.5 / 6.2 | 4.6 / 8.1 | 4.5 / 8.4 |
| entity | 2,274 / 2,446 | 2,322 / 2,560 | 2,331 / 2,535 |
| recall | 2,244 / 2,482 | 2,271 / 2,494 | 2,273 / 2,486 |
| remember | 89 / 112 | 91 / 113 | 88 / 108 |
| sync (30 calls) | 360 / 386 | 392 / 428 | 348 / 377 |

No call errored, no keyword statement hit its timeout (0 fall-opens in each probe), and each probe recorded 285
`keyword_candidates_incomplete` stages.

The three preregistered contrasts are p95 at 0.60.570.0 against 0.60.549.0:

| Operation | 0.60.570.0 − 0.60.549.0, p95 | The two 0.60.549.0 probes differ by | Reading |
|---|---|---|---|
| query | +89 ms (+2.9%) | 68 ms | 0.60.570.0 slower, outside run-to-run noise |
| search | +66 ms (+3.9%) | 51 ms | 0.60.570.0 slower, outside run-to-run noise |
| get | +1.9 ms | 2.2 ms | no difference, within run-to-run noise |

Under the rule fixed before the run, query and search read as 0.60.570.0 being about 3 to 4% slower at p95. That
reading is weak. The repeat 0.60.549.0 probe, which ran last, is within 22 ms (query) and 15 ms (search) of 0.60.570.0.
So the drift between the first and the later probes is about as large as the gap between versions, and a design with
more repeats might not separate the two. Against Wintermute's counted latencies, the synthetic p95s are about a tenth for
query and search (3.1 s and 1.7 s against 30.1 s and 30.4 s), and the calibration check reads outside its factor of 2.
That gap is expected, because the provider time missing here is most of what a user waits for. G5 reads **NO REFERENCE
YET**, as preregistered, until a later real p95 measurement at these two versions exists.

## What to use and what to avoid

- **Use a synthetic recall test to check direction, after you've matched its embedding gaps to your brain's.** It
  ranked six search setups in the same direction as the real brain on every contrast that qualified. Don't read its
  sizes: on the contrasts that qualify, it puts the gain of meaning-based search over keyword search at about two to
  two and a half times the real one, and the paraphrase gap of configured search at a sixth of the real one (about a
  twentieth for vector and hybrid search).
- **Don't trust a clean synthetic brain for paraphrase recall.** Clean pages make configured search look perfect on
  paraphrases, and the real brain loses 40 points there.
- **Verify writes against the brain, not the agent's report, when a low-cost model writes.** particle-1 claimed 7
  writes that never landed; Opus and Sol claimed none.
- **Parse a low-cost model's answer before you score or act on it.** Every G4 answer of particle-1's that held a name or an
  id named the right person, and it still failed 43 episodes by wrapping the id in text or leaving it out.
- **Expect Opus and Sol to stop when gbrain refuses or hides something, and decide whether you want that.** They
  followed gbrain's refusal guidance and abstained on hidden pages almost every time. particle-1 pushed on more often,
  which landed more G3 writes and gave more wrong answers in G6.
- **Don't use G1's or G4's agent tasks to rank frontier models.** Opus and Sol are at the ceiling on both.

## Calls written before results

These R48 calls were written on 2026-11-10, before any G1, G2 or G4 counted output and before batch 3's aggregates,
from the design alone:

- **G3: FIX-METHOD.** Its phase 2 layer compares refusal rates for seven write causes with phase 2's arm B, whose tools
  were query, search and get_page only, so arm B's exposure to every write cause is zero and the reference can't exist.
  Its replay layer maps one contrast, and the rule needs three. The fix is a real reference with write exposure, such as
  the real brain's own write refusals by cause on either side of a gbrain release, collected independently of the
  counts that seeded G3's tasks, with at least three contrasts. The counted results add a second method problem, the
  scoring of honest pending reports described above.
- **G6: KEEP, report-only.** Its reference, phase 2's out-of-view counts by privacy sub-cause, was never published, and
  phase 2 dropped 1 of 100 tasks as unreachable, which can't give three qualifying sub-cause contrasts. It stays
  report-only until a real out-of-view count by sub-cause exists.
- **G1 and G4 agent layers: a method gap.** Their verdicts come from their retrieval layers only.
- **G5: KEEP, report-only.** No later real p95 measurement at 0.60.549.0 and 0.60.570.0 exists.
- **G2 and the G1 and G4 retrieval layers: decided by the counted runs.** A NOT PREDICTIVE layer gets one "Why null?"
  cycle and one honest generator fix before any CUT-CANDIDATE.

No layer read NOT PREDICTIVE, so no "Why null?" cycle ran and no measure is a CUT-CANDIDATE. G1's NO REFERENCE YET is a
missing reference, not a null: its retrieval layer fell one qualifying contrast short because the real brain left that
contrast no room, as the batch 3 section shows.

## Caveats

- G2's verdict reads signs. A synthetic brain that gets every direction right and every size wrong reads PREDICTIVE,
  and this one does both.
- Each G2 pair compares the synthetic brain on PGLite with the real brain on Postgres. The keyword candidate bound
  batch 1 recorded on 57 of 100 lexical-hybrid forms can't occur on PGLite, so the synthetic brain doesn't copy it.
- The shells and real conditions turn non-gold pages into shells whatever their kind, which overstates shells on pages
  that aren't media.
- Batch 2 is 50 questions written by one agent from a seeded sample of pages, none of them a real question that once
  failed. Batch 3 is 51 such questions.
- G1, G3, G4 and G6 ran at gbrain 0.60.557.0, this repository's pin at the time, not at the version Garry's box runs.
- G3's task mix was seeded from Wintermute's refusal counts, so G3's cause mix can't be checked against those counts.
- The agents ran through this repository's own tool loop on direct API calls, not through Claude Code or Codex.
- G4's schema asks for the entity id alone. A looser parser would have scored particle-1 higher, as the exploratory
  rescoring shows.

## Reproduce and inspect

- **Agent tests (G1, G3, G4, G6).** `bun eval/runner/predictive/run.ts <g1|g3|g4|g6> --paid --budget-run-id <id>
  --preregistration docs/benchmarks/2026-11-09-predictive-measures-preregistration.md`. Keys: `ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `PARTICLE_API_KEY`. Plan digests `51589efd…` (G1), `aa5989c8…` (G3), `5a7c2583…` (G4) and
  `e701fa48…` (G6). The counted runs ran on Ubicloud VMs through `eval/runner/predictive/ubicloud/run.sh`; G1 took
  about four hours and G4 about two.
- **G2.** The synthetic brains come from `eval/generators/conditions-recall-gen.ts` (seed 20261109) and run through
  `eval/runner/live-recall/run.ts` with `--gbrain <checkout>@27f8b9d6`. Counted question file sha256
  `077569d7…`; directory digest `6b3791fe…`. The counted scorecard took 4 minutes 24 seconds.
- **Batch 3's synthetic side.** `eval/generators/batch3-synthetic-gen.ts` builds the brain, and the live-recall runner
  scores it under `--protocol batch3` at 0.60.641.0.
- **G5.** `eval/runner/predictive/scale-latency/` builds the 300,034-page brain and times the probes; the counted run took
  about two hours on a 16-vCPU VM.
- **Verdicts.** `bun eval/runner/predictive/verdict.ts --measure <G1|G2|G4> --synthetic <scorecard.json> --out
  <verdict.json>` refuses any scorecard other than the counted one unless `--secondary` labels it. Run on the published
  scorecards, it reproduces every verdict here.
- **Paired intervals.** Percentile bootstrap over tasks, 10,000 resamples, seed 2005.
- **Raw files**, under [`predictive-measures/`](predictive-measures/):
  - `g1/`, `g3/`, `g4/` and `g6/`: each run's `scorecard.json` (the runner's summary without its spending ledger) and
    `episodes.jsonl.gz` (every episode, with its answer, cause and usage). Temporary directory paths inside agent
    answers read `<tmp>/`, as in every receipt this repository publishes.
  - `g2/real-593/`: the counted batch 2 scorecard; `g2/secondary/`: the seven secondary scorecards.
  - `batch3-synthetic-641/`: the synthetic batch 3 scorecard. The real one is the
    [`live-recall-b3` reference](2026-11-10-live-recall-batch3/b3-641-scorecard.md).
  - `g5/`: the three latency scorecards, in run order 549, 570, 549b.
  - `verdicts/`: the counted verdict files for G1, G2 and G4, and the secondary G2 verdicts.

## Not verified

- That particle-1's sync in the pending-import tasks would be safe on a brain with a running sync owner; the test
  machine had none.
- Provider-side billing for the runs; cost per correct answer comes from the usage fields each response reported.
- Why Sol recovered after 29.7% of its MCP refusals but 1.6% of its CLI refusals.
- Why particle-1 wrapped or dropped the id on surname tasks far more than on the other G4 patterns.

## Disclosures

gbrain is Garry Tan's own project.

Disclosure: Y Combinator, which Garry Tan runs, is an investor in Particle, which makes particle-1.

Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator. Garry Tan runs Y Combinator.
