# Do gbrain's BEAM comparisons hold under frontier judges? GST-1365 results

Measured 2026-11-05 on the custody host, with the final summary rendered by the runner at
[f61894b9](https://github.com/garrytan/gbrain-evals/commit/f61894b95ac0df4d540efe44b36ac77e24f3bb94) (gbrain-evals
0.10.164) under the [preregistration](2026-11-04-gst-1365-judge-robustness-preregistration.md), frozen before any paid
call.

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

Every other comparison holds: F6's ten comparisons on BEAM-10M and BEAM-1M sealed, its three on D8, and Q1's other
seven. Under frontier judges the 14 that separated the two systems keep their sign, their rank and their size, and the
6 that were level stay level. The family verdicts are F6 HOLDS, D8 HOLDS and Q1 WEAKENED, the last only through that
BEAM-100K row.

By the preregistered rule the frontier judges are the right ones where the judges disagree, pooled and for each judge's
rows. A third model, gemini-4-argon, sided with the frontier judge on 73.2% of 2,280 disagreements (71.3% to 75.0%).
On 554 control answers whose correct verdict is known, gpt-4.1-mini was not more accurate than either frontier judge.
New BEAM work should therefore judge with the frontier judges, as canonical or co-primary.

## How BEAM scores an answer

[BEAM](https://arxiv.org/abs/2510.27246) ([code and data](https://github.com/mohammadtavakoli78/BEAM)) gives each
question a gold answer and, for most questions, a list of rubric items. A judge model scores the answer against each
item as 0, 0.5 or 1. The answer's score is the mean, and it passes at 0.5. A question with no rubric items is scored
against its gold answer as one item.

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
  each written up to four ways with a known verdict: the gold answer (pass), another question's gold answer (fail), "I
  can't find that in our conversation history." (fail, or pass on an abstention question), and the gold answer inside a
  hedge (pass). All four judges judge every control.
- **Rule.** Fixed in the preregistration. A comparison is separated if its published interval excludes 0. A separated
  comparison HOLDS if, under frontier judges, it keeps its sign, its interval still excludes 0 and its size has not
  changed; a level one holds unless frontier judges separate it on the other side. The size has changed when δ (below)
  has an interval excluding 0 and is at least the larger of 3 points and half the published difference. A comparison is
  WEAKENED if a separated one's frontier interval includes 0, or if any one reader confidently reverses it, and REVERSED
  if the three-reader frontier interval excludes 0 on the other side. Intervals come from a conversation-cluster paired
  bootstrap with 10,000 draws; the referee's shares use Wilson intervals.

## Results

### Comparisons

Δ is gbrain minus the other system, in points, with its 95% interval, on the comparison's published cohort; every
question in every cohort was judged by every judge the view needs. "Frontier judges" is Δ_F, which the rule reads. "BEAM
protocol judge" is the published Δ, or the run's own where the campaign published the two rows but no paired difference
(F6's BEAM-10M file agent and Q1's BEAM-1M and BEAM-100K file agent). δ is the frontier judges' Δ minus the protocol
judge's on the same answers. "Two of three" is K, each answer's verdict by at least two of the three judges, reported
beside the rule.

| Family | Set | Comparator | Questions | Frontier judges, Δ_F | BEAM protocol judge, Δ | Judge shift, δ | Two of three, K | Outcome |
|---|---|---|---:|---|---|---|---|---|
| F6 | BEAM-10M | `ext-extract-first` | 199 | -0.3 (-3.6 to +2.6) | +2.2 (-1.9 to +6.1) | -2.7 (-5.1 to +0.7) | +0.2 (-4.4 to +5.0) | HOLDS |
| F6 | BEAM-10M | `ext-memory-bank` | 199 | +4.9 (+2.8 to +7.2) | +5.7 (+1.6 to +9.7) | -0.5 (-3.1 to +2.9) | +5.5 (+1.7 to +9.4) | HOLDS |
| F6 | BEAM-10M | `ext-verbatim-session` | 199 | +10.6 (+4.5 to +16.6) | +10.2 (+3.4 to +16.8) | +0.7 (-3.1 to +5.3) | +13.9 (+7.2 to +20.2) | HOLDS |
| F6 | BEAM-10M | `ext-temporal-graph` 0.31 | 199 | +13.9 (+9.4 to +17.9) | +12.4 (+7.1 to +17.4) | +1.5 (-1.8 to +5.3) | +16.9 (+11.9 to +22.1) | HOLDS |
| F6 | BEAM-10M | `baseline-file-agent` (whole system) | 199 | -9.2 (-12.8 to -5.7) | -7.1 (-11.1 to -3.4) | -2.1 (-5.2 to +1.5) | -12.1 (-17.8 to -7.0) | HOLDS |
| F6 | BEAM-1M sealed | `ext-extract-first` | 240 | +3.5 (+0.4 to +6.5) | +4.8 (+2.6 to +7.1) | -1.3 (-3.3 to +0.9) | +4.3 (+0.7 to +7.9) | HOLDS |
| F6 | BEAM-1M sealed | `ext-memory-bank` | 240 | +2.0 (-1.4 to +5.4) | +1.3 (-0.9 to +3.7) | +0.7 (-1.6 to +3.2) | -0.4 (-4.9 to +4.0) | HOLDS |
| F6 | BEAM-1M sealed | `ext-graph-pipeline` | 240 | +4.6 (+0.6 to +8.8) | +3.7 (+0.3 to +7.4) | +0.9 (-0.5 to +2.4) | +7.4 (+2.9 to +11.9) | HOLDS |
| F6 | BEAM-1M sealed | `ext-verbatim-session` | 240 | +10.0 (+6.2 to +13.8) | +6.9 (+4.1 to +9.9) | +3.1 (+0.8 to +5.3) | +13.5 (+9.9 to +16.9) | HOLDS |
| F6 | BEAM-1M sealed | `ext-temporal-graph` 0.31 | 240 | +10.8 (+6.7 to +15.1) | +9.3 (+5.2 to +13.3) | +1.6 (-1.4 to +4.5) | +13.1 (+8.1 to +17.9) | HOLDS |
| D8 | D8 long-history reserve | `ext-memory-bank` | 300 | +2.9 (+1.0 to +5.0) | +3.8 (+1.0 to +6.7) | -0.9 (-3.1 to +2.2) | +3.7 (+2.2 to +5.2) | HOLDS |
| D8 | D8 long-history reserve | `ext-graph-pipeline` | 300 | +4.1 (+2.2 to +6.3) | +3.8 (+1.6 to +6.1) | +0.3 (-2.0 to +2.8) | +4.7 (+1.1 to +8.6) | HOLDS |
| D8 | D8 long-history reserve | `baseline-hybrid` | 300 | +5.3 (+2.1 to +8.4) | +4.3 (+2.3 to +6.5) | +1.0 (-2.0 to +4.2) | +5.0 (+1.4 to +8.6) | HOLDS |
| Q1 | BEAM-10M | `ext-extract-first` | 197 | -3.3 (-8.4 to +1.5) | -3.0 (-8.1 to +1.8) | -0.5 (-2.2 to +1.1) | -5.4 (-11.1 to +0.2) | HOLDS |
| Q1 | BEAM-10M | `ext-memory-bank` | 197 | +2.1 (-2.5 to +6.0) | +0.6 (-4.5 to +5.2) | +1.7 (-0.2 to +3.4) | +0.3 (-5.0 to +5.1) | HOLDS |
| Q1 | BEAM-10M | `ext-verbatim-session` | 197 | +7.5 (+3.2 to +11.9) | +5.1 (+0.5 to +9.2) | +2.8 (-0.1 to +5.6) | +8.3 (+2.7 to +13.8) | HOLDS |
| Q1 | BEAM-10M | `baseline-file-agent` (whole system) | 198 | -7.3 (-11.8 to -3.1) | -8.7 (-16.4 to -1.4) | +1.3 (-2.8 to +5.5) | -11.8 (-18.7 to -5.2) | HOLDS |
| Q1 | BEAM-1M sealed | `ext-extract-first` | 240 | -0.4 (-4.1 to +3.0) | -0.3 (-3.7 to +3.5) | -0.2 (-2.5 to +2.2) | +0.1 (-4.4 to +4.7) | HOLDS |
| Q1 | BEAM-1M sealed | `baseline-file-agent` (whole system) | 240 | -8.2 (-12.1 to -4.6) | -8.0 (-12.2 to -4.0) | -0.2 (-1.8 to +1.4) | -9.7 (-15.3 to -4.3) | HOLDS |
| Q1 | BEAM-100K sealed | `ext-extract-first` | 140 | -0.4 (-6.7 to +5.3) | -1.8 (-6.9 to +3.1) | +1.4 (-3.7 to +6.5) | -3.6 (-11.0 to +3.8) | HOLDS |
| Q1 | BEAM-100K sealed | `baseline-file-agent` (whole system) | 140 | -3.4 (-8.3 to +1.2) | -5.1 (-8.6 to -1.3) | +1.7 (-2.8 to +5.8) | -5.7 (-11.2 to -0.5) | WEAKENED |

Two rows are worth reading closely. F6's BEAM-10M extract-first comparison flips sign under frontier judges (-0.3) but
was level before and stays level, so it holds. F6's BEAM-1M verbatim-session comparison grows by 3.1 points (0.8 to
5.3); its interval excludes 0, but 3.1 is under half the published 6.9, so its size has not changed by the rule.

The ranks hold on every set but BEAM-100K, where the file agent moves from ahead of gbrain to level with it. A rank change
on S2a cannot fail a family, which takes a REVERSED comparison or a rank change on S1 or S2b, so with its WEAKENED row Q1 is WEAKENED.

### Absolute levels

Each cell's three-reader mean on the comparison's cohort, under the protocol judge on the same first answers and under
frontier judges. Levels move with the judge and are reported, not ruled on.

| Family | Set | Comparator | gbrain, protocol judge | gbrain, frontier judges | Comparator, protocol judge | Comparator, frontier judges |
|---|---|---|---:|---:|---:|---:|
| F6 | BEAM-10M | `ext-extract-first` | 61.0% | 55.1% | 58.6% | 55.4% |
| F6 | BEAM-10M | `ext-memory-bank` | 61.0% | 55.1% | 55.6% | 50.1% |
| F6 | BEAM-10M | `ext-verbatim-session` | 61.0% | 55.1% | 51.1% | 44.5% |
| F6 | BEAM-10M | `ext-temporal-graph` 0.31 | 61.0% | 55.1% | 48.7% | 41.2% |
| F6 | BEAM-10M | `baseline-file-agent` (whole system) | 61.0% | 55.1% | 68.2% | 64.3% |
| F6 | BEAM-1M sealed | `ext-extract-first` | 68.2% | 67.6% | 63.4% | 64.1% |
| F6 | BEAM-1M sealed | `ext-memory-bank` | 68.2% | 67.6% | 66.8% | 65.6% |
| F6 | BEAM-1M sealed | `ext-graph-pipeline` | 68.2% | 67.6% | 64.5% | 63.0% |
| F6 | BEAM-1M sealed | `ext-verbatim-session` | 68.2% | 67.6% | 61.3% | 57.6% |
| F6 | BEAM-1M sealed | `ext-temporal-graph` 0.31 | 68.2% | 67.6% | 58.9% | 56.8% |
| D8 | D8 long-history reserve | `ext-memory-bank` | 85.9% | 73.0% | 82.1% | 70.1% |
| D8 | D8 long-history reserve | `ext-graph-pipeline` | 85.9% | 73.0% | 82.0% | 68.9% |
| D8 | D8 long-history reserve | `baseline-hybrid` | 85.9% | 73.0% | 81.6% | 67.7% |
| Q1 | BEAM-10M | `ext-extract-first` | 56.3% | 52.4% | 59.1% | 55.7% |
| Q1 | BEAM-10M | `ext-memory-bank` | 56.3% | 52.4% | 55.9% | 50.3% |
| Q1 | BEAM-10M | `ext-verbatim-session` | 56.3% | 52.4% | 51.6% | 44.8% |
| Q1 | BEAM-10M | `baseline-file-agent` (whole system) | 58.9% | 55.9% | 67.6% | 63.2% |
| Q1 | BEAM-1M sealed | `ext-extract-first` | 63.1% | 63.7% | 63.4% | 64.1% |
| Q1 | BEAM-1M sealed | `baseline-file-agent` (whole system) | 63.1% | 63.7% | 71.1% | 71.9% |
| Q1 | BEAM-100K sealed | `ext-extract-first` | 67.8% | 68.3% | 69.5% | 68.7% |
| Q1 | BEAM-100K sealed | `baseline-file-agent` (whole system) | 67.8% | 68.3% | 72.8% | 71.7% |

Frontier judges score every system lower on BEAM-10M (gbrain's F6 row 61.0% to 55.1%) and on D8 (85.9% to 73.0%), and
about the same on the sealed BEAM-1M and BEAM-100K sets. The systems move together, which is why the differences
hold. Compare systems under one judge; never compare a score under one judge with a score under another.

### Which judge is right

**The referee.** gemini-4-argon matched the shared verdict on 94.8% of the 600 sampled answers where the two judges
agree (92.8% to 96.3%), above the preregistered 85% bar, so it counts. On the 2,280 answers where they disagree, it
sided with the frontier judge on 73.2% (71.3% to 75.0%).

| Disagreements | Referee sides with the frontier judge |
|---|---|
| All 2,280 | 73.2% (71.3% to 75.0%) |
| Claude readers' rows, frontier judge gpt-6.1-sol | 75.3% (73.0% to 77.4%) |
| gpt-6.1-sol's rows, frontier judge claude-opus-5-5 | 69.3% (66.0% to 72.4%) |
| Frontier judge stricter than the protocol judge | 67.3% (64.7% to 69.8%) |
| Frontier judge more lenient | 80.9% (78.3% to 83.2%) |

By BEAM category the referee favors the frontier judge most on temporal reasoning (92.1%, 86.0% to 95.6%) and does not
settle two categories, where the interval includes one half: abstention (54.2%, 48.8% to 59.4%) and knowledge update
(54.4%, 46.0% to 62.5%). Of the 24 reader-and-system groups, one has its share below one half: gpt-6.1-sol's rows on
`baseline-hybrid`, which only D8's comparisons hold (42.6%, 29.5% to 56.7%). The full breakdown is in
[summary.json](2026-11-05-gst-1365-judge-robustness/summary.json).

**The known-answer controls.** Error rate of each judge, where an error is a verdict other than the known one:

| Control | Answers | Correct verdict | gpt-4.1-mini | gpt-6.1-sol | claude-opus-5-5 | gemini-4-argon |
|---|---:|---|---:|---:|---:|---:|
| C1, the gold answer as written | 150 | pass | 14.0% | 13.3% | 18.7% | 10.0% |
| C2, another question's gold answer | 104 | fail | 14.4% | 12.5% | 9.6% | 11.5% |
| C3, a fixed abstention | 150 | fail, pass on abstention questions | 0.7% | 0.7% | 0.7% | 0.0% |
| C4, the gold answer in a hedge | 150 | pass | 19.3% | 16.0% | 20.7% | 13.3% |
| All | 554 | | 11.9% | 10.5% | 12.6% | 8.5% |

A judge counts as more accurate on known answers only if its total error rate is at least 3 points lower with a paired
95% interval, clustered by question, that excludes 0. No pair of gpt-4.1-mini and a frontier judge meets that:
gpt-4.1-mini minus gpt-6.1-sol is +1.4 points (-0.7 to +3.6), and claude-opus-5-5 minus gpt-4.1-mini is +0.7 (-1.4 to
+2.9). gemini-4-argon, the referee, is more accurate than gpt-4.1-mini (3.4 points fewer errors, 0.9 to 6.1) and than
claude-opus-5-5 (4.2, 2.2 to 6.4), which supports using it as the referee.

The 150 questions give 554 control answers, not 600. 46 questions have no other non-abstention question of the same
category in their conversation whose gold answer differs from theirs, so they have no C2: 44 in BEAM-1M sealed and 2 in
D8. BEAM-1M sealed's 6 C2 answers all sit on abstention questions, which draw from any non-abstention question in their
conversation; in all, 18 of the 104 C2 answers sit on abstention questions.

Every judge fails BEAM's own gold answer as written on 10% to 19% of questions. That includes D8, where the gold answer
is the question's only rubric item: 6 to 11 of D8's 50, by judge. This breakdown was not preregistered, and the check
did not examine why. It means part of what C1 and C4 measure is how BEAM's
instrument treats its own gold answers, which no judge here escapes. The rule reads the paired differences, which
compare judges on the same texts.

**The verdict.** The referee is valid, its p_F interval lies entirely above one half, and the controls do not show
gpt-4.1-mini more accurate than the frontier judge. So the frontier judges are right, pooled, on the Claude readers' rows
and on gpt-6.1-sol's rows.

### Why the BEAM-100K file-agent gap weakened

Every one of the set's 140 questions was judged, so nothing is missing. The set is small: its three-reader comparison
detects only judge shifts of about 7.2 points at the measured disagreement, more than the 5.1-point published gap. The judge's
shift on this comparison is +1.7 points (-2.8 to +5.8), not separated from zero. By reader, under frontier judges, the
Opus reader still puts the file agent ahead (-6.6, -10.8 to -2.8), the Sol reader's interval crosses zero (-5.4, -13.9
to +2.1), and the Sonnet reader puts gbrain slightly ahead (+1.9, -4.0 to +8.1), as it did under the protocol judge
(+2.1). Two of three judges still separate the systems (-5.7, -11.2 to -0.5). So the call rests on the frontier judges'
three-reader interval crossing zero by a little over a point. BEAM-100K cannot rank these two systems without naming the
judge; it does not show that gbrain caught up.

### Three runner fixes before the final numbers

The custody runs found three defects before any result was written. Each was fixed in
[#376](https://github.com/garrytan/gbrain-evals/pull/376), and its runs were repeated where needed. The preregistration
records each in a dated note.

1. **D8 had no controls.** The control builder took only questions with rubric items, and D8's questions have none, so
   the first controls run held 356 answers from S1 and S2b only. The fixed builder takes any question with a gold
   answer, and a second run judged D8's 198 control answers; S1's and S2b's were reused.
2. **Two campaigns' answers shared ids.** F6 reran Q1's BEAM-10M file agent under the same cell id, and the answer id does not name
   the campaign, so 577 of that cell's 600 first answers held different texts under ids both receipts use. Q1's
   frontier judgments had scored F6's file-agent texts. With each answer keeping its own judgments, F6's BEAM-10M
   file-agent Δ_F is -9.2 points (-12.8 to -5.7), where the mismatched judgments gave -8.1. The referee's population was
   refrozen with the fix (2,280 disagreements, 2,177 of the earlier 2,230 kept, and a 600-answer agreement sample, 576
   kept) and its 123 unjudged answers judged. The reuse checks, read again, agree on 97 (gpt-6.1-sol) and 99
   (claude-opus-5-5) of 100, where they recorded 96 and 96, so both still clear their 95% bar.
3. **The summary left out three outputs** the preregistration reports: p_F for each frontier judge's rows, absolute
   levels, and the control counts. `summary.json` now holds `referee.by_row`, a `levels` entry per comparison and
   `controls.counts` per set.

## What to use and what to avoid

- Read F6's and Q1's comparisons as published. Under frontier judges the separated ones keep their sign, rank and size,
  and the level ones stay level.
- Do not read the BEAM-100K file-agent row as ahead of gbrain without naming the judge.
- Compare systems under one judge. Absolute levels move with the judge.
- For new BEAM work, RS1's revisit or any new ranking set, make the per-row frontier judges canonical or co-primary
  under the family rule: gpt-6.1-sol on Claude readers' rows and claude-opus-5-5 on gpt-6.1-sol's. Keep gpt-4.1-mini
  as the bridge to earlier BEAM results. F6's and Q1's published numbers stay as they are, read as BEAM protocol judge
  numbers.

## What is restated

- README's comparison section gains a paragraph under the Q1 block: the comparisons hold under frontier judges, and the
  BEAM-100K file-agent gap depends on the judge, with both intervals. The [docs index](../README.md) moves this check
  from its preregistrations table to its retrieval experiments, with the verdicts.
- The F6 and Q1 scoreboards, their `publication.json` and README's rendered Q1 block are generated from the campaign
  receipts in custody, with their hashes pinned, and none of them makes a claim about the BEAM-100K file-agent gap:
  Q1's table shows the two rows (72.8% and 67.8%) and draws no comparison. They stay as they are, and the
  judge-dependent statement sits beside them.
- No comparison REVERSED, so [corrections](../corrections.md) lists nothing new.

## Spend

The ledger books gemini-4-argon at its 2026-12-01 price ($4 in, $20 out and $0.20 cache read per million tokens), twice
its list price before then, so a reservation is never short. List spend, from each request's usage, is beside it.

| Stage | Answers judged | Booked | List |
|---|---:|---:|---:|
| Smoke and reuse checks | 20 census, 20 referee, 200 reuse re-judgments | $9.68 | $8.58 |
| Census A, F6 BEAM-10M | 2,110 | $73.12 | $73.12 |
| Census B, F6 BEAM-1M sealed | 3,301 | $113.31 | $113.31 |
| Census C, Q1's rows | 2,408 | $70.60 | $70.60 |
| Census D, D8 | 3,600 | $31.30 | $31.30 |
| Referee | 2,826 | $274.08 | $137.04 |
| Referee top-up after the shared-id fix | 123 | $17.04 | $8.52 |
| Controls, S1 and S2b | 356 x 4 judges | $20.62 | $15.69 |
| Controls, D8 | 198 x 4 judges | $5.12 | $3.98 |
| **Total** | | **$614.87** | **$462.15** |

gemini-4-argon's share is $305.44 booked and $152.72 at list. The census judged 11,439 answers, 20 of them in the smoke:
6,933 by gpt-6.1-sol and 4,506 by claude-opus-5-5, as Stage 0 counted. No stage had a request error or a held request.
The API ceiling was $850 and the $250 reserve was not used.

## Reproduce and inspect

The answers are sealed, so the paid stages run only on the custody host, through cell.ts's custody gate, and every output
is counts, means, intervals and dollars; `summary` refuses to write a report that holds a question id. From the
repository root at f61894b9, with `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` and `GEMINI_API_KEY` set and the custody
environment (`GBRAIN_EVALS_DATASETS`, `GBRAIN_EVALS_BEAM10M_SOURCE`, `GBRAIN_EVALS_D8_SOURCE`,
`GBRAIN_EVALS_D8_MANIFEST`, `GBRAIN_EVALS_CUSTODY_LOG`):

```bash
ROOTS="--root f6=<F6 receipt> --root q1=<Q1 receipt> --root second-judge=<each paid particle-1 add-on second-judge out>"
PAID="--out <out> --budget-ledger <ledger> --concurrency 16"
bun eval/runner/q1/rejudge-systems.ts plan $ROOTS --out <out>                                # free: coverage, projection
bun eval/runner/q1/rejudge-systems.ts reuse-check --judge openai:gpt-6.1-sol --n 100 $ROOTS $PAID --run-id <id> --lease-usd <usd>
bun eval/runner/q1/rejudge-systems.ts reuse-check --judge anthropic:claude-opus-5-5 --n 100 $ROOTS $PAID --run-id <id> --lease-usd <usd>
bun eval/runner/q1/rejudge-systems.ts judge --stratum A $ROOTS $PAID --run-id <id> --lease-usd <usd>   # then B, C and D
bun eval/runner/q1/rejudge-systems.ts referee $ROOTS $PAID --run-id <id> --lease-usd <usd>
bun eval/runner/q1/rejudge-systems.ts controls $ROOTS $PAID --run-id <id> --lease-usd <usd>
bun eval/runner/q1/rejudge-systems.ts summary $ROOTS --out <out> --report <dir>              # free: reproduction check, then the report
```

Every paid stage first reproduces the published canonical contrasts and cells from each receipt (REPRODUCTION_FAILED
otherwise), attests the preregistration, and checks each judge's key. A stop leaves a receipt; a rerun with a new lease
resumes and skips judged answers. Observed time on the custody host at concurrency 16: the census 3.9 hours across its
four strata, the referee 5.8 hours plus a 39-minute top-up, the controls 21 minutes.

The final summary, copied byte for byte from custody (sha256 `dcc34704` and `c5e49d6e`):
[summary.json](2026-11-05-gst-1365-judge-robustness/summary.json) and
[summary.md](2026-11-05-gst-1365-judge-robustness/summary.md). The decision rule is
`eval/runner/q1/rejudge-rule.ts`; its tests are `test/eval/q1-rejudge-rule.test.ts` and
`test/eval/q1-rejudge-systems.test.ts`.

## Not verified

- No person graded any answer. The referee is a third model, and models can share errors; the known-answer controls are
  the check that needs no model, and they do not separate gpt-4.1-mini from the frontier judges.
- The controls test what a judge does with texts of known quality. They do not test the hard middle cases where real
  answers differ.
- Why every judge fails 10% to 19% of BEAM's gold answers as written was not examined.

## Disclosures

gbrain is Garry Tan's own project.

Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator. Garry Tan runs Y Combinator.
