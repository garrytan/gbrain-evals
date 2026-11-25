# Pinned questions results: gbrain refreshes an answer correctly after an edit, a deletion or an unrelated change, and misses contradictions

- **We learned that gbrain misses contradictions and over-flags sentences an unrelated edit left true. You should refresh
  a pinned answer by hand, and read it, after you add a note that contradicts an older one.** gbrain flagged 0 of the 60
  sentences a contradicting note made wrong. When the contradiction was written into an existing note, it never asked for
  a refresh (0 of 30). When it came as a new note, it scheduled a refresh, and it also made 23 other pinned questions due
  each time. It flagged 25.9% of the sentences whose claim did not change, and after an unrelated edit to a cited page
  it flagged 75% of that page's unchanged sentences (90 of 120).
- **We learned that when a note behind a pinned answer is edited, superseded or deleted, gbrain flags the affected
  sentence and a refreshed answer comes back right. You should pin the questions you re-ask and refresh them after
  ordinary edits.** On 240 counted questions per model, gbrain v0.60.769.0 flagged every sentence whose claim was edited,
  superseded or deleted (90 of 90). On those changes, and on changes that touched no claim, every refreshed answer from
  claude-opus-5-5, particle-1 and gpt-6.2-sol was right, apart from six gpt-6.2-sol answers that the analysis below
  shows its judge marked wrongly.
- **We learned that this test can't yet tell the three models apart, because every gap between them comes from how one
  judge scored answers that reported a contradiction.** On the preregistered labels, refreshed answers were right 217 of
  240 times for claude-opus-5-5, 199 for particle-1 and 233 for gpt-6.2-sol, so particle-1 is 7.5 points below Opus
  (95% interval 3.8 to 11.7 lower) and not shown within 10 points. But each of Opus's 23 misses and particle-1's 41 is
  a contradiction answer that gave the new city and the old one together, with every other claim right. The judge
  accepted 37 of Opus's 60 answers like that and rejected 23, with no wording difference we could find. Counted as
  correct, those answers give Opus and particle-1 240 of 240 each, and gpt-6.2-sol 233 (239 with the judge note below).

Settled call: don't move pinned-question refreshes to particle-1 on this result, and don't rule it out. The model gap
rests on one judge's inconsistent scoring of answers that report both values, so the next step is a rescoring of these
same answers, with a written rule for that case, preregistered before it runs. gbrain's own contradiction handling
needs a fix whichever way that lands: it should flag the contradicted sentence, signal a contradiction in an existing
note, and recompute the answer in full instead of editing the old one.

This is the results file of the [pinned-questions preregistration](2026-11-24-pinned-questions-preregistration.md),
including both of its 2026-11-24 amendments. Every number here comes from synthetic, fictional-company worlds generated
from a public generator, at one gbrain build (v0.60.769.0, `38831bb6`), on counted seeds 11 to 20, which no run had
touched before.

Refreshed answers fully correct, per model, with answer cost per correct answer relative to claude-opus-5-5. The
second and third columns are the preregistered result; the fourth counts the both-city contradiction answers as
correct:

| Model | Refreshed answers correct (of 240) | Paired difference from claude-opus-5-5 (95% interval) | Correct with both-city answers accepted | Answer cost per correct answer, Opus = 1 |
|---|---:|---|---:|---:|
| claude-opus-5-5 | 217 (90.4%) | reference | 240 | 1.00 |
| particle-1 | 199 (82.9%) | -7.5 points (-11.7 to -3.8); not non-inferior at the 10-point margin | 240 | 0.056 |
| gpt-6.2-sol | 233 (97.1%) | +6.7 points (+2.5 to +11.3) | 233 (239 with the judge note below) | 0.32 |

Both preregistered differences are significant after Holm's correction (McNemar, Holm p 0.001 for particle-1 and
0.005 for gpt-6.2-sol). With both-city answers accepted, particle-1 and Opus are level, and gpt-6.2-sol is 2.9 points
below Opus (0.4 points below with the judge note's six rows relabelled). Cost per correct answer counts only the pin
and refresh calls that gbrain reported for each model, not the judge; the judge's cost is the same for every row it grades. The ratios are in
[paid-counted.json](pinned-questions/paid-counted.json) under `relative_answer_cost`.

## The test

Each counted seed builds 24 fictional companies in an in-memory gbrain brain, through gbrain's own operation
handlers: pages, facts, and one pinned question per company asking where it builds its product, what its flagship
product is, who runs it and when it was founded. Each company then gets one controlled change, three companies per
change class:

| Change class | What changes |
|---|---|
| `edit_claim_page` | the company page's city is edited |
| `edit_claim_fact` | the founding-year fact is superseded |
| `remove_source_page` | the page naming the chief executive is deleted, so no one is named any more |
| `contradict_new_page` | a new press note says production moved to another city |
| `contradict_existing_page` | an existing note is edited to say production moved |
| `unrelated_edit_cited_page`, `unrelated_edit_uncited_page`, `unrelated_new_page` | text that touches no claim |

The **keyless arm** answers with a scripted oracle that cites every line stating a value, and measures which
sentences gbrain flags as stale and which questions it makes due over six simulated days. The **paid arm** pins and
refreshes every question through gbrain's own gateway and refresh path, with the model under test set as
`models.standing_questions`; gbrain chooses an incremental or a full refresh itself. A judge from another family grades
every first and refreshed answer per claim: gpt-6.2-astra grades the claude-opus-5-5 and particle-1 rows, and
claude-opus-5-5 grades the gpt-6.2-sol rows. A refreshed answer is correct only when every claim states the value
after the change, and a removed chief executive is not named.

## Paid arm, by change class

Refreshed answers correct, out of 30 per class (60 for the two edit classes and the two contradiction classes
together):

| Change | claude-opus-5-5 | particle-1 | gpt-6.2-sol |
|---|---:|---:|---:|
| Edits (page edit and superseded fact) | 60 / 60 | 60 / 60 | 60 / 60 |
| Deleted source page (chief executive removed) | 30 / 30 | 30 / 30 | 24 / 30 (see the judge note below) |
| Contradiction in a new note | 12 / 30 | 4 / 30 | 30 / 30 |
| Contradiction written into an existing note | 25 / 30 | 15 / 30 | 29 / 30 |
| Unrelated changes (three classes) | 90 / 90 | 90 / 90 | 90 / 90 |

Every one of the 720 refreshes published an answer. None was cut off at gbrain's 2,000-token output cap, none hit a
provider safety stop, and there were no provider errors. Every row was answered by the model it names. Every first
answer, from before the change, was right for all three models.

**Contradictions.** Every contradiction refresh ran in gbrain's incremental mode. All 60 of claude-opus-5-5's
contradiction answers named both the new city and the old one, and so did all 41 of particle-1's misses and 5 of its
hits. gpt-6.2-sol named the old city 6 times, each time only as the place production moved from, and was right on all
6; its one miss left the city out. The frozen judge prompt labels an answer wrong when it gives the current value
together with a conflicting one. gpt-6.2-astra, which judged the Opus and particle-1 rows, accepted 37 of Opus's 60
both-city answers and 5 of particle-1's 46, and rejected the other 64, every one of which had all its other claims
right. We found no wording difference between the two groups. It accepted "A press note says Lidrem moved all
production of its valves to Grezendford and builds valves there from this month, although the Lidrem company page
still lists Mobemford", and rejected "A press note says Brumis moved all production of its turbines to Koudrathford
and builds turbines there from this month, while the Brumis company page still says it builds turbines in Vumaford."
So the contradiction scores below measure how one judge treated answers that report the conflict, more than whether a
model found the new city. Opus was right after a contradiction 61.7% of the time (37 of 60) and after a direct edit
100% of the time (60 of 60), 38.3 points apart. That is past the preregistered 15-point line, so the design note in the
next section goes to gbrain's maintainers, with this caveat attached.

**Judge note for gpt-6.2-sol's six deleted-source misses.** After the chief executive's page was deleted, all three
models left the chief executive out of the refreshed answer, all 90 times. gpt-6.2-astra labelled all 60 of those
answers from Opus and particle-1 correct. claude-opus-5-5, judging gpt-6.2-sol, labelled 6 of its 30 identical
omissions "missing", although the frozen prompt says an answer that names no one for a removed claim is correct. The
same disagreement happened once in the judge check. These six are the only counted rows where a judge and the rule
labels disagree. The preregistered score keeps the judge's label, so gpt-6.2-sol has 233 of 240. With those six labels
replaced by the rule's, it has 239 of 240 (+9.2 points over Opus, 95% interval +5.4 to +12.9). Either way gpt-6.2-sol
is ahead of Opus. Scores never use the rule labels; the rule labels feed only the judge agreement check.

## Keyless arm

Per-sentence stale flags over the 960 counted answer sentences (oracle citing every evidence line; 95% intervals from
the cluster bootstrap over questions):

| Measure | Value |
|---|---|
| Precision | 30.0% (26.1% to 34.3%) |
| Recall | 60.0% (52.2% to 67.9%) |
| False-flag rate on sentences whose claim did not change | 25.9% (21.7% to 30.3%) |
| Recall on edits, supersessions and deletions | 100% (90 of 90) |
| Recall on contradictions | 0% (0 of 60) |
| False flags after an unrelated edit to a cited page | 75% of that page's unchanged sentences (90 of 120) |

At question level, gbrain signalled 120 of the 150 questions whose answer changed. The 30 it missed are the
contradictions written into an existing note: none was ever signalled or corrected. Contradictions in a new note were
signalled and corrected (median 3 simulated days), but each one, like each unrelated new page, made 23 other pinned
questions due. Over the run that came to 180 refreshes after changes that touched no claim. A rerun with one citation
per sentence (`--citation one`) gives the same recall and question results. Its false-flag rate is lower (18.5%, 15.3%
to 21.7%), because fewer sentences share a cited line with an unrelated edit.

## What each outcome changes

| Measurement | Result | What happens |
|---|---|---|
| Keyless: spillover and missed signals | Shown: 23 pins made due per new page, and contradictions in existing notes never signalled | gbrain's maintainers ship the scheduling fix they accepted, and the keyless arm reruns on that release |
| Keyless: false flags after unrelated edits to cited pages | Shown: 75%, lower bound above the 10% line | The paragraph-level evidence design note goes to gbrain's maintainers as a plan to build |
| Paid: particle-1 within 10 points of Opus | Not shown on the preregistered labels (interval's lower end -11.7 points); level with Opus when both-city answers are accepted | No recommendation at this sample: particle-1 is not documented as the low-cost refresh model, and a preregistered rescoring with a written rule for both-value answers comes next |
| Paid: more than 5% of a model's pilot calls cut off | No: 0 cut off for every model | The default-cap arm stands alone |
| Paid: Opus after a contradiction at least 15 points below after a direct edit | Yes: 38.3 points below, all of it both-city answers the judge rejected | Design note to gbrain's maintainers: recompute the answer in full when new in-scope evidence arrives, instead of editing the old answer |

## Judge check

The judge check needs at least 100 labelled outputs per judge and Cohen's kappa of at least 0.6 against labels from a
rule, before any counted unit runs. The rule labels come from the unique synthetic tokens in each answer key, not from a
model. The first judge-check stage (seeds 21 to 23) failed. Nearly every answer was right, so the rule labels held
almost no negatives, and claude-opus-5-5's kappa on the gpt-6.2-sol rows was 0 on 144 outputs, with its only
disagreement the removed-chief-executive case above. The plan's second amendment added stale probes: each judge-check
first answer, written before its change, was judged again against the answer key from after it, where it states the
old value. The probes call only the judges. With them:

| Judge | Grades | Labelled outputs | Agreement | Kappa |
|---|---|---:|---:|---:|
| gpt-6.2-astra | claude-opus-5-5 and particle-1 rows | 338 | 99.7% | 0.992 |
| claude-opus-5-5 | gpt-6.2-sol rows | 189 | 99.5% | 0.986 |

claude-opus-5-5 labelled all 45 of its probes stale. gpt-6.2-astra's one disagreement is a rule error, not a judge
error: a particle-1 first answer wrote the old chief executive's name with a Cyrillic letter, so the token rule missed
it, and Astra rightly called that answer stale. In the counted rows, no answer contains a word that mixes Latin letters
with lookalike characters from another alphabet. The only character outside ASCII is a typographic apostrophe, which
appears in 363 of the 1,440 counted answers, and the token rule treats it as a word boundary. No counted score depends
on the token rule.

The judge check excluded all 141 answers that give both an old and a new value, so the preregistered judges were never
validated on the class of answers that decides the model comparison. The rule labels a claim "ambiguous" when
an answer names both, and the agreement check leaves ambiguous labels out. In the counted rows that excludes 141
answers: all 112 both-city contradiction answers (106 judged by gpt-6.2-astra, 6 by claude-opus-5-5) and 29 of
claude-opus-5-5's 30 superseded-fact answers, which give the new founding year with the old one ("founded in 1994, a
record that superseded an earlier entry of 1991"). gpt-6.2-astra accepted all 29 of those, and they read as correct,
but neither judge's handling of both-value answers was compared with a reference.

## Runs and build

| Run | Seeds | Questions | Result file |
|---|---|---:|---|
| Paid pilot | 21 | 72 | [paid-pilot.json](pinned-questions/paid-pilot.json) |
| Paid judge check | 21 to 23 | 216 | [paid-judge-check.json](pinned-questions/paid-judge-check.json), [rows](pinned-questions/paid-judge-check-rows.ndjson) |
| Stale probes (judges only) | 21 to 23 | 135 probes | [paid-stale-probes.json](pinned-questions/paid-stale-probes.json) |
| Paid counted | 11 to 20 | 720 | [paid-counted.json](pinned-questions/paid-counted.json), [rows](pinned-questions/paid-counted-rows.ndjson) |
| Keyless, one citation per claim line | 11 to 20 | 240 | [keyless-citation-all.json](pinned-questions/keyless-citation-all.json) |
| Keyless, one citation per sentence | 11 to 20 | 240 | [keyless-citation-one.json](pinned-questions/keyless-citation-one.json) |

All paid runs and both keyless runs used gbrain v0.60.769.0 (`38831bb6`), the newest release on gbrain's master at
each launch. The pilot and judge check ran from gbrain-evals `6646f4db`, and the stale probes, the counted paid run and
the keyless runs from `0c7c4dbb`. Each file is a summary of the full receipt, whose sha256 is in
[manifest.json](pinned-questions/manifest.json). The counted receipt's own `verdict` field reads "fail" because it
recomputes the judge check from the counted rows alone, without probes. On those rows alone, claude-opus-5-5's kappa on
the gpt-6.2-sol rows is 0.247 (474 labelled outputs: the judge marked 7 not correct, 6 of them the
removed-chief-executive answers the rule marked correct, and the rule marked 1), and gpt-6.2-astra's is undefined, because its 825 labelled counted outputs hold no rule negative.
The judge check that gates a counted launch is the one above.

## Limits

- The worlds are synthetic and the generator is public. These are synthetic-production-path results at one build, not
  held-out confirmation.
- The contradiction scores, and with them every difference between the models, depend on one judge's call on answers
  that report both the old and the new city, a call it made inconsistently and that the judge check never tested. The
  same judge accepted all 29 of claude-opus-5-5's superseded-fact answers that gave both years, so Opus's edit score,
  and the 38.3-point gap between edits and contradictions, rest on that call too.
- The stale probes test whether a judge recognises a stale value. They don't test the "wrong" label.
- One judge grades each model, so judge differences between the families can move a model's score. The removed
  chief executive case is the one we found.

## Disclosures

- gbrain is Garry Tan's own project.
- Disclosure: Y Combinator, which Garry Tan runs, is an investor in Particle, which makes particle-1.
- Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator.
  Garry Tan runs Y Combinator.
