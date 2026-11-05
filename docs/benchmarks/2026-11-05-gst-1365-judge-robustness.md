# Do gbrain's BEAM comparisons hold under frontier judges? GST-1365 results

Measured 2026-11-05 on the custody host, with the runner at TODO(merge sha) and the
[preregistration](2026-11-04-gst-1365-judge-robustness-preregistration.md) frozen before any paid call.

gbrain is a memory system for agents. Two campaigns compare it with other memory systems on BEAM, a benchmark of long
chat histories with questions about them: F6 (gbrain `0ccf2bdd`, [scoreboard](2026-10-29-f6-current-master/scoreboard.md))
and Q1 (gbrain `f05943e6`, [scoreboard](2026-10-06-scoreboard/scoreboard.md)). Both scored every answer with BEAM's
protocol judge, gpt-4.1-mini. This check judged every answer behind those comparisons again with a frontier judge from
a family that grades none of its own readers' rows, then asked which judge was right where the two disagreed.

## What changed

One comparison changes. On BEAM-100K sealed (Q1's S2a set, 140 questions), the file agent scores above gbrain's
8,000-token component row by 5.1 points (95% interval 1.3 to 8.6) under BEAM's protocol judge, and by 3.4 points
(interval -1.2 to 8.3) under frontier judges. That gap is now judge-dependent: one judge separates the two systems and
the other cannot. The judge's shift on it, +1.7 points (-2.8 to +5.8), is itself within noise.

Every other comparison holds. F6's ten comparisons on BEAM-10M and BEAM-1M sealed, its three on D8, and Q1's other
seven keep their sign, their rank and their size under frontier judges. The family verdicts are F6 HOLDS, D8 HOLDS and
Q1 WEAKENED, the last only through that S2a row.

TODO(final): which judge is right, one paragraph from the referee and the controls.

## How BEAM scores an answer

[BEAM](https://arxiv.org/abs/2510.27246) ([code and data](https://github.com/mohammadtavakoli78/BEAM)) gives each question a gold answer and, for most questions, a list of rubric
items. A judge model scores the answer against each item as 0, 0.5 or 1. The answer's score is the mean, and it
passes at 0.5. A question with no rubric items is scored against its gold answer as one item.

An invented case shows where judges part. The question is "Which day did I move the dentist appointment to?" and the
rubric item is "States that the appointment moved to Thursday the 14th." The answer "You moved it to Thursday" can earn
1 from a judge that checks the day and 0.5 from one that also wants the date. Over thousands of answers, such
differences move a system's score by several points, and they can move two systems unevenly. That uneven move is what
this check measures.

## The experiment

- **Answers.** A census: each reader's first answer on every question in each comparison's published cohort, 15,382
  answers in all. 3,943 already had a family-clean frontier judgment that passed a reuse check; the rest were judged
  here. A product failure (for example the file agent stopping at its turn cap) scores 0 under every judge.
- **Readers.** The three answer models F6 and Q1 used: claude-opus-5-5, claude-sonnet-5-5 and gpt-6.1-sol. Each
  comparison is the three-reader mean, paired by question.
- **Frontier judges.** gpt-6.1-sol judges the Claude readers' answers, and claude-opus-5-5 judges gpt-6.1-sol's, so no
  judge grades its own family.
- **Referee.** gemini-4-argon judges, blind to the other verdicts, every answer where the protocol judge and the frontier
  judge disagree at the pass mark, plus a seeded sample of 600 answers where they agree.
- **Known-answer controls.** 150 questions with gold answers, 50 each from BEAM-10M (S1), BEAM-1M sealed (S2b) and D8,
  each written four ways with a known verdict: the gold answer (pass), another question's gold answer (fail), "I can't
  find that in our conversation history." (fail, or pass on an abstention question), and the gold answer inside a
  hedge (pass). All four judges judge every control.
- **Rule.** Fixed in the preregistration. A comparison is separated if its published interval excludes 0. A separated
  comparison HOLDS if, under frontier judges, it keeps its sign, its interval still excludes 0 and its size has not
  changed; a level one holds unless frontier judges separate it on the other side. The size has changed when δ (below)
  has an interval excluding 0 and is at least the larger of 3 points and half the published difference. A comparison is
  WEAKENED if a separated one's frontier interval includes 0, or if any one reader confidently reverses it, and REVERSED
  if the three-reader frontier interval excludes 0 on the other side. Intervals come from a conversation-cluster paired
  bootstrap with 10,000 draws.

## Results

### Comparisons

Δ is gbrain minus the other system, in points, with its 95% interval. "Frontier judges" is Δ_F, which the rule reads.
"BEAM protocol judge" is the published Δ, or the run's own where the comparison was never published as a paired
difference. δ is the frontier judges' Δ minus the protocol judge's on the same answers. "Two of three" is K: each
answer's verdict by at least two of the three judges.

TODO(final): table from summary.json.

### Absolute levels

TODO(final): levels table from summary.json. Absolute levels move with the judge and are reported, not ruled on.

### Which judge is right

TODO(final): referee validity, p_F pooled and per row, by direction and category; controls error rates and paired
differences; the verdict.

### Why the BEAM-100K file-agent gap weakened

Every one of the set's 140 questions was judged, so nothing is missing. The set is small: its three-reader comparison
detects only differences of about 7.2 points at the measured disagreement, above the 5.1-point published gap. The judge's
shift on this comparison is +1.7 points (-2.8 to +5.8), not separated from zero. By reader, under frontier judges, the
Opus reader still puts the file agent ahead (-6.6, -10.8 to -2.8), the Sol reader's interval crosses zero (-5.4, -13.9
to +2.1), and the Sonnet reader puts gbrain slightly ahead (+1.9, -4.0 to +8.1), as it did under the protocol judge
(+2.1). Two of three judges still separate the systems (-5.7, -11.2 to -0.5). So the call rests on the frontier judges'
three-reader interval crossing zero by a little over a point. It means BEAM-100K cannot rank these two systems without
naming the judge, not that gbrain caught up.

### Three runner fixes before the final numbers

The custody runs found three defects before any result was written. Each was fixed in
[#376](https://github.com/garrytan/gbrain-evals/pull/376) and its runs repeated where needed.

1. **D8 had no controls.** The control builder took only questions with rubric items, and D8's questions have none, so
   the first controls run held 356 answers from S1 and S2b only. The fixed builder takes any question with a gold
   answer, and a second run judged D8's controls; S1's and S2b's were reused.
2. **Two answers shared ids.** F6 reran Q1's BEAM-10M file agent under the same cell id, and the answer id does not name
   the campaign, so 577 of that cell's 600 first answers held different texts under ids both receipts use. Q1's
   frontier judgments scored F6's file-agent texts. With each answer keeping its own judgments, F6's BEAM-10M
   file-agent Δ_F is TODO(final) where the mismatched judgments gave -8.1, and the referee judged 123 more answers.
3. **The summary left out three outputs** the preregistration reports: p_F for each frontier judge's rows, absolute
   levels, and the control questions with no wrong-answer control.

## What to use and what to avoid

- Read F6's and Q1's comparisons as published. Under frontier judges they keep their sign, rank and size.
- Do not read the BEAM-100K file-agent row as ahead of gbrain without naming the judge.
- Compare systems under one judge. Absolute levels move with the judge, so a score under one judge is never compared
  with a score under another.
- TODO(final): which judge new BEAM work (RS1's revisit, any new ranking set) uses.

## What is restated

- The [F6 scoreboard](2026-10-29-f6-current-master/scoreboard.md) gains a "Frontier-judge sensitivity (GST-1365)"
  section with Δ under each judge and each outcome. No F6 number changes.
- README's comparison section and the docs index say the comparisons hold under frontier judges, and README names the
  BEAM-100K file-agent gap as judge-dependent with both intervals.
- Q1 published no sentence about the BEAM-100K file-agent gap: its README table shows the two rows (72.8% and 67.8%)
  and makes no claim between them, and its scoreboard's claim sentences and `publication.json` hold none. Those files
  are rendered from Q1's receipt in custody and change only when it is rendered again, so the judge-dependent statement
  sits beside the table instead.
- No comparison REVERSED, so [corrections](../corrections.md) lists nothing new.

## Spend

TODO(final): booked and list per stage, the Gemini row booked at its 2026-12-01 price with list spend beside it.

## Reproduce and inspect

TODO(final): commands, inputs, the committed summary.

## Not verified

- No person graded any answer. The referee is a third model, and models can share errors; the known-answer controls are
  the check that needs no model.
- The controls test what a judge does with texts of known quality. They do not test the hard middle cases where real
  answers differ.

## Disclosures

gbrain is Garry Tan's own project.

Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator. Garry Tan runs Y Combinator.
