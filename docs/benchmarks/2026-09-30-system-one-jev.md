# System One v1: where a small decision model helps gbrain

**Measured September 30, 2026; mirrored into this repository October 1, 2026.**

[gbrain](https://github.com/garrytan/gbrain) is a memory system for agents. Its
System One work adds nine places where a small, fast decision model can make a
yes/no or ranking call that gbrain currently makes with a fixed rule or a
larger LLM. The model tested is TypeSafe's Jev (`typesafe:jev-1.13.0`; every
response reported `jev-1.13.0`). Each of the nine places is called a **slot**.

## The finding

Jev measurably helped in two slots. **Dream triage** (S7) stopped throwing away
conversations with something worth remembering buried in them, at the cost of
also sending more routine chats to the page writer. The **contradiction sweep**
(S9) found when a new fact replaces an old one, which the current rule never
did. **Reranking (S1), evidence trimming (S3) and abstention (S4) regressed**
against what gbrain does today. Query routing (S2) made no measurable
difference to retrieval, and know-to-ask (S6), claim grounding (S8) and the
injection signal (S5) were inconclusive on this data.

gbrain acted on this: on its System One branch (`feat/system-one-v1`, not yet
merged to master), `gbrain decide enable --recommended` turns on S7 and S9
only, and only when a Jev key is present. Every other slot stays off.

| Slot | What it decides | Verdict | Headline (eval half) |
|---|---|---|---|
| S7 triage | Is this conversation worth turning into memory pages? | **win, costs more** | Buried decisions and commitments missed: 10 of 18 today, **0 of 18** with Jev. Routine chats correctly skipped: 78 of 79 today, 52 of 79 with Jev. |
| S9 conflict | Does this new fact replace a stored one? | **win** | Updated facts found: 0 of 97 with today's cosine rule, **94 of 97** with Jev, one wrong proposal. |
| S1 rerank | Which retrieved passages come first? | **regression** | All needed conversations in the top five (`recall_all@5`, 233 answerable questions): 94.8% with today's Voyage reranker, 91.4% to 94.0% with Jev. |
| S3 evidence | Which retrieved conversations can be dropped before the reader sees them? | **regression** | The only setting that drops anything cut `recall_all@5` from 94.8% to 91.4% (1 win, 9 losses, p = 0.02). |
| S4 answerable | Should the agent say it does not know? | **regression** | At any threshold that abstains, at most about a third of abstentions are correct (13 of 38 at 0.20). |
| S2 intent | Should a query be treated as temporal, relational or general? | **no measurable change** | Routing labels matched more often (search 46.5% to 66.9%), but retrieval was identical on every question. |
| S6 recall_needed | Does this chat turn need memory at all? | **mixed** | Turns the reflex rules miss: failures 71.3% to 11.3%. On BrainBench, where the rules miss nothing, false fires rose from 0% to 8.5% and turn latency from 10 ms to 161 ms. |
| S8 grounding | Is a sentence on a memory page supported by its source conversation? | **inconclusive** | 25 quarantines on real page sentences, 22 of them unsupported by the LLM label; only 16 pages, too few to qualify. |
| S5 injection | Does a retrieved passage try to instruct the agent? | **inconclusive** | 3 of 4 attacks flagged, 0 of 32 clean candidates, from only 12 fixtures. |

**One fix landed after the eval.** In this run, S1 with query expansion never
reranked: gbrain's per-query decision budget (`decide.query_budget_ms`, 1,500 ms)
started when the request started, and the expansion call used it up. All 248
LongMemEval-S questions and all 28 LongMemEval-M questions in the expansion arms
fell back to the fused order (`rerank:skipped:timeout`), so the "expansion +
Jev" rows measure fused order, not Jev. gbrain commit
[`9f7794ec`](https://github.com/garrytan/gbrain/commit/9f7794ec4a841f928e2c109d19b0d798ba4f91d4)
now starts the budget at the first decision stage after retrieval. **That arm
was not re-measured.**

Every number comes from the eval half of a frozen split; thresholds were chosen
on the other half. **No label is a human hand label**: labels come from a
generator's construction, a benchmark's own annotations, or an LLM (details per
dataset below). Total paid spend was **$24.95 against a $40 cap**.

## The concrete cases

**Dream triage (S7).** gbrain's dream cycle reads saved agent conversations and
writes memory pages from the ones worth keeping. A triage step decides which
conversations to send to the (expensive) page writer. Picture a long chat about
scheduling a call across three time zones, where halfway through the user says
they have decided to shut down a side project and why. Today's triage, a Haiku
4.5 judge, reads the chat as routine and drops it. Jev scores each window of the
chat and keeps the conversation if any window clears the threshold. (Invented
example; the test set's 50 buried-signal chats were generated this way.)

**Contradiction sweep (S9).** A brain stores "Example Corp uses Postgres" in
March. In June a new fact arrives: "Since June 2026, Example Corp runs on
MySQL." Today's rule compares embeddings and treats a near-identical pair as a
duplicate; an update with a new value is rarely similar enough, so it inserts
the new fact and both stand. S9 asks Jev whether the new fact duplicates,
supersedes or is independent of each candidate, and proposes a supersession for
a person to accept. (Invented example in the generator's style.)

**Know-to-ask (S6).** Before answering a turn, gbrain decides whether to fetch
memory. A reflex rule fires on capitalized names that match stored pages. It
misses "what did my cofounder say about pricing?" or a lowercase surname, and
it fires on "how do you spell Okonkwo-Bell?" where memory is not needed.

## The experiment

Each slot was run as a **matched pair**: the same gbrain commit, data, seed and
brain, with only the slot's mode different (`off` is today's path, `on` is the
slot acting at its calibrated threshold). Two ways a pair was run:

1. **Through the production path.** S7 called `runTriagePass`, the function
   `gbrain dream` uses. S1, S2, S3 and the S3+S5 arm ran
   `gbrain eval longmemeval --decide <slot>=on`. S6 ran
   `gbrain eval brainbench --suite know-to-ask --decide recall_needed=on`.
2. **Recorded answers plus the production reducer.** For S2, S4, S5, S6, S8
   and S9 the dataset was asked once through the slot's production request
   shape, then gbrain's own decision rule (the reducer) was applied at the
   calibrated threshold and compared with today's deterministic path. The
   same recorded answers give the retest flip rate.

**Splits and thresholds.** `gbrain decide dataset` assigns each family (one
conversation, transcript, question or fact) to a calibrate or eval half by a
stable hash and records a `split_hash`. `gbrain decide calibrate` chose each
threshold on the calibrate half. Slots that can remove something (prune,
reject, quarantine, suppress, abstain) must also pass `gbrain decide qualify`:
a 95% Wilson lower bound of at least 0.90 on the precision of that action,
counted by family on the eval half, with at least 35 families.

**Comparators.** S1: Voyage `rerank-2.5` at `top_n_in` 30, today's default, and
no reranker. S2: gbrain's regex classifiers. S3: no pruning. S4: no
abstention. S6: the reflex rules. S7: the Haiku 4.5 judge with its rescue
band. S8: the mechanical checks alone. S9: the cosine rule
(`decideSingleFact`) with OpenAI `text-embedding-3-large` at 1,536 dimensions.

### Datasets and where their labels come from

| Dataset | Slot | Items (families) | Eval half | Labels |
|---|---|---|---|---|
| `s7-triage` | S7 | 254 transcripts | 109 (30 worth keeping, 79 routine) | 24 Cat 35 transcripts: that corpus's `expected_triage` (benchmark annotation). 230 synthetic transcripts from gpt-5.6-luna: the generator's instruction (180 routine, 50 with one buried passage). Nobody read and labelled them. |
| `s9-conflict` | S9 | 786 pairs (408) | 395 (97 supersede) | 780 from a seeded template generator, labelled by construction; 6 from labelled gbrain tests. |
| `s6-recall-needed.combined` | S6 | 677 turns | 343 | 149 BrainBench know-to-ask turns (that corpus's sealed gold); 528 reflex-miss turns from a seeded generator, labelled by the designed intent. |
| `s8-grounding` | S8 | 750 claim units (16 pages) | 496 (11 pages) | `claude-sonnet-5` judged 567 sentences from Cat 35 dream pages; 183 perturbed negatives were written and blind-judged by the same model. LLM labels. |
| `s2-intent` | S2 | 866 queries | 424 | LongMemEval `question_type` and BrainBench relational fixtures, mapped by gbrain's builder. |
| `s5-injection` | S5 | 36 candidates (12) | 18 | gbrain's injection test fixtures, labelled by their author. |
| `s3-evidence` | S3 | 10,000 sessions (500 questions) | 248 questions | LongMemEval answer-session annotations. Rebuilt from the benchmark file, not committed (57 MB). |
| `s4-answerable` | S4 | 500 questions | 252 (19 abstention) | LongMemEval abstention annotations. Rebuilt, not committed. |

The S1 arms used LongMemEval-S cleaned (the 248 eval-half questions of the S3
split, 233 answerable), a 100-question judged subset, and the frozen
28-question LongMemEval-M pilot from this repository's
[pilot preregistration](2026-09-24-longmemeval-m-pilot-preregistration.md).

## Results by slot

### S7 dream triage: win, costs more

109 eval-half transcripts, run through `runTriagePass` with triage off (Haiku
4.5 judge plus rescue band) and on (Jev at the calibrated 0.77; answers in the
margin band go to the Haiku judge).

| | off (Haiku) | on (Jev) |
|---|---|---|
| Worth-keeping transcripts passed | 20/30 | **30/30** |
| Buried-signal (synthetic) passed | 8/18 | **18/18** |
| Cat 35 positives passed | 12/12 | 12/12 |
| Routine transcripts rejected | 78/79 | 52/79 |
| Sent to the page writer | 21 | 57 |
| Accuracy | 0.90 | 0.75 |
| Triage cost per transcript | $0.0046 | $0.0009 |
| Latency p50 / p95 / p99 | 2.24 / 6.22 / 7.66 s | 1.44 / 4.16 / 5.15 s |
| Decision flip rate across two runs | 1/109 | 5/109 |

The on arm decided 57 transcripts by Jev pass, 37 by Jev reject and 15 by
handing a margin case to Haiku. Accuracy favors off (McNemar on the discordant
pairs: 11 for on, 27 for off, p = 0.014) because the errors differ in kind: off
drops real signal, on writes pages for routine chats. Calibration reached
recall 1.0 on the calibrate half, and qualification passed with 39 of 39 correct
rejections (lower bound 0.910). Jev's probabilities are not calibrated in
absolute terms (expected calibration error 0.46; routine windows score 0.6 to
0.8), so the threshold carries the meaning, not the raw number.

**End to end.** On a fresh brain with `enable --recommended` (S7 and S9),
`gbrain dream --phase synthesize` over 29 eval-half transcripts:

| | all off | preset (S7 + S9) |
|---|---|---|
| Transcripts synthesized | 10 | 19 |
| Worth-keeping transcripts synthesized | 9/16 | **16/16** |
| Buried-signal transcripts synthesized | 3/10 | **10/10** |
| Routine transcripts synthesized | 1 (2 pages) | 3 (5 pages) |
| Pages written | 20 | 38 |
| Dream spend (triage + synthesis estimate) | $1.50 | $2.60 |
| Synthesize phase wall time | 733 s | 1,427 s |

S9 found no facts to sweep in this run because the synthesized pages carry no
facts block; its evidence is the labelled pairs below.

### S9 contradiction sweep: win

395 eval-half pairs: 97 supersede, 75 duplicate, 223 independent.

| | cosine rule (today) | S9 (duplicate 0.52, floor 0.65) | S9 (floor 0.50) |
|---|---|---|---|
| Supersedes found | 0/97 | **94/97** | 95/97 |
| Wrong supersede proposals | 10 of 10 | 1 of 95 | 1 of 96 |
| Agreement with the three-way label | 0.565 | 0.939 | 0.942 |

On the 88 pairs the sweep actually sees (embedding cosine at least 0.80), S9
found 29 of 30 supersedes with no wrong proposal. No decision flipped between
two runs; latency was 146 / 221 ms p50 / p95 per fact, at about $0.00002 per
fact. S9 only proposes, so it needs no qualification gate.

### S1 reranking: regression

| Arm | `recall_all@5` | R@1 | Jev rerank p50 / p95 | Cost per question |
|---|---|---|---|---|
| no reranker | 93.6% (218/233) | 91.8% | n/a | $0 |
| **Voyage, `top_n_in` 30 (today)** | **94.8% (221/233)** | **94.4%** | n/a | about $0.001 |
| Voyage, `top_n_in` 100 | 94.8% | 93.1% | n/a | about $0.0015 |
| Jev, `top_n_in` 30 | 94.0% | 91.8% | 381 / 521 ms | $0.0008 |
| Jev, `top_n_in` 50 | 91.4% (1 win, 9 losses, p = 0.02) | 91.4% | 512 / 750 ms | $0.0013 |
| Jev, `top_n_in` 100 | 92.7% | 91.4% | 515 / 716 ms | $0.0013 |
| Jev, `top_n_in` 100, retest | 92.3% | 91.8% | 494 / 649 ms | $0.0013 |
| expansion + Jev 100 | 93.6% | 91.8% | timed out on 248/248 | n/a |

R@1 counts a question when the first returned session is an answer session.
On LongMemEval-S the fused candidate pool holds the whole haystack (about 47
sessions), so every needed session was already in the pool at depth 30; the
reranker only reorders. Jev put an answer session first on 214 of 233
questions, Voyage on 220. On the LongMemEval-M pilot (about 500 sessions per
question, `text-embedding-3-small`), R@1 was 87.5% with Voyage, 75.0% with Jev
over 100 candidates and 70.8% over 300 (24 answerable questions; not
significant, but no arm beat today's). An earlier internal check that reported
134/134 first-place hits did not replicate. On 100 judged questions (Haiku 4.5
reader, gpt-4o judge), answers were correct 91% of the time with Voyage and 89%
with Jev (1 win, 3 losses).

### S3 evidence gate: regression

The calibration target (recall of needed sessions at least 0.98) picked 0.02,
which the 0.05 safety margin turns into "never prune." About 10% of real answer
sessions score at or below 0.06, because the 6,000-character candidate cap cuts
the answer out of long sessions. gbrain's production cap does the same, so any
threshold that acts prunes real evidence. Forced on at 0.08, the lowest acting
threshold (family lower bound 0.869, below the 0.90 gate; that qualify run is
not in a committed receipt), `recall_all@5` fell from 94.8% to 91.4% and the
reader saw 3.52 sessions instead of 4.89. With S5 on the same request it fell
to 91.4% (0 wins, 8 losses).

### S4 abstention: regression

500 LongMemEval questions, 30 of them unanswerable. Jev gives many answerable
questions a low probability (median 0.64, tenth percentile 0.13). gbrain reports
that at 0.20 it would abstain on 38 eval-half questions, 13 correctly; the
calibrated 0.05 never abstains, and qualification stopped at `insufficient_n`.
gbrain committed the recorded answers but no S4 analyzer, so this repository
does not recompute that count. Counting directly from the answers, questions
below 0.20 are 47 with 16 correct, and below 0.15 (the margin) 36 with 13
correct. Every reading is far below the 0.90 gate.

### S2 query routing: no measurable change

On 424 eval-half queries, Jev's routing matched the label more often (search
46.5% to 66.9%, with 41 helpful and 6 harmful overrides out of 51; think 58.7%
to 77.0%). The S2 arm on LongMemEval-S returned the same top five as today's on
every question. From a Capy machine, 39% to 41% of answers arrived after
150 ms, 7% to 8% after 200 ms and 1% to 3% after 250 ms, so gbrain raised
`decide.slots.intent.wait_ms` to 250 ms.

### S6 know-to-ask: mixed

| Eval half | reflex only | S6 on (0.74, suppress below 0.10) |
|---|---|---|
| Reflex-miss corpus (264 turns): know-to-ask failures | 71.3% | **11.3%** |
| Reflex-miss corpus: false fires | 55.7% | 49.7% |
| BrainBench (79 turns): failures | 0% | 0% |
| BrainBench: false fires | 0% | **8.5%** |
| Turn latency p50 / p95 (BrainBench) | 10 / 19 ms | 161 / 258 ms |

A failure is a turn that needed a stored page and did not get it; a false fire
injects memory into a turn that needed none. All 14 suppressions were correct,
but qualification needs 35. At the old 0.05 setting no turn was ever
suppressed, so gbrain's default is now 0.10. About 3% of S6 answers missed the
250 ms deadline, and the reflex result stood.

### S8 grounding: inconclusive

At the calibrated 0.29 (recall of supported sentences at least 0.95), on the
370 real eval-half sentences S8 quarantined 25, 22 of them unsupported by the
LLM label (88%), caught 13% of the LLM-unsupported sentences, and wrongly
quarantined 3 of 206 supported ones. It caught 63 of 126 perturbed negatives
with no false quarantine. With 16 pages, 11 in the eval half, qualification
cannot reach 35 families. The design plan's human-labelled sample is still
owed.

### S5 injection: inconclusive

Across three repeats, attack candidates scored 0.50 to 0.94 and clean ones 0.02
to 0.08, except a legitimate candidate that quotes an attack (0.56 to 0.60). At
0.65, S5 flags 3 of 4 attacks and no clean candidate. On LongMemEval, which has
no attacks, it demoted 93 of the 11,548 candidates it judged (0.8%; gbrain's
verdict page says 11,402, the receipt's kept-plus-demoted count is 11,548).

### Stability and judge agreement

`retest_sd` is the spread of Jev's answer when the same item is asked three
times; `repack_sd` is the spread when the item is packed with different
neighbours. Both come from `gbrain decide calibrate` on 50 families.

| Slot | Threshold | `retest_sd` | `repack_sd` | Flips across two eval-half runs |
|---|---|---|---|---|
| S7 | 0.77 | 0.0138 | 0.0127 | 5 / 109 transcripts |
| S9 | 0.52 | 0.0013 | 0.0046 | 0 / 395 pairs |
| S6 | 0.74 | 0.0065 | 0.0058 | 10 / 343 turns |
| S8 | 0.29 | 0.0148 | 0.0148 | 10 / 496 units |
| S3 | 0.02 | 0.0025 | 0.0022 | n/a (never acts) |
| S4 | 0.05 | 0.0123 | 0.0143 | n/a (never acts) |

`gbrain decide judge-agreement` runs Jev beside an existing LLM judge and
reports Cohen's kappa, a chance-corrected agreement score. On LongMemEval
answers, Jev agreed with gpt-4o's verdicts 95% of the time (kappa 0.73, 95% CI
0.51 to 0.96, n = 100). On S8 grounding labels it agreed with claude-sonnet-5
78.7% of the time (kappa 0.58, 0.52 to 0.64, n = 750). Both compare one model
judge with another, not with people.

## What to use and what to avoid

- **Turn on S7 if missing a buried decision costs more than extra pages.** It
  caught every buried signal here and made triage cheaper and faster, but it
  sent 57 of 109 transcripts to the page writer instead of 21, and the dream
  cycle cost about 75% more end to end. It reads conversation text, so it
  needs `decide.egress.private allow`.
- **Turn on S9 for brains that accumulate changing facts.** It proposes; a
  person accepts. It is cheap and stable, but it can only see pairs that clear
  the sweep's 0.80 embedding floor, which hides many updates with new names or
  numbers.
- **Keep Voyage for reranking, and leave S3 and S4 off.** All three made
  retrieval or answers worse on LongMemEval, and S3 cannot help while long
  candidates are truncated.
- **Treat S2, S5, S6 and S8 as open.** S6 helps exactly where the reflex is
  weak, but its suppressions are unproven and it costs about 150 ms per turn.
  S8 needs more pages and human labels. S5 needs a real attack set.
- **Limits.** LongMemEval-S is development data for gbrain. S7, S9 and the S6
  reflex-miss corpus are synthetic and in-sample for this experiment. Latency
  figures are wall clock from one Capy cloud machine (or a named Ubicloud VM)
  to TypeSafe, not production figures under load. S7 routed to a local `llm:`
  model was planned and not measured.

## Reproduce and inspect

All commands run from this repository's root after `bun install --frozen-lockfile`.

**Code identity.** The measurements ran on gbrain branch
`feat/system-one-v1-evals` (v0.60.17.0 plus the System One work) between
21:23 and 23:45 UTC on September 30: the eval flags landed in
[`afeab73c`](https://github.com/garrytan/gbrain/commit/afeab73cc37464f46a82b3bb8b35be720036b9a1)
and the receipts were committed in
[`57661631`](https://github.com/garrytan/gbrain/commit/57661631f9cb3b0fb11c6b36417387d8b7e8f595).
The receipts do not name a per-run commit. This copy comes from
`feat/system-one-v1` at
[`9196543d`](https://github.com/garrytan/gbrain/tree/9196543dffd8c6b918b232559956f4693874e67b)
(v0.60.26.0, [gbrain#5797](https://github.com/garrytan/gbrain/pull/5797)), which
also contains the S1 budget fix. It was first copied at `fc9a1d45` (v0.60.21.0);
between the two commits the receipts, ledgers, datasets, generators and
analyzers are byte-identical, and the only changed file in the record is the
Ubicloud setup script, which now installs a pinned Bun. The decision code
gained key-aware defaults (S7 and S9 on when a TypeSafe key is present), which
eval runs never receive and explicit slot modes override, so the matched-pair
arms are unchanged. `build` and `analyze` reproduced the record at both
commits. The declared gbrain
dependency of this repository (master `6c8373c`, v0.60.13.0) has none of the
System One commands, so every command that runs gbrain takes
`--gbrain <checkout>@<ref>`, which copies that commit into `.gbrain-overlays/`
and records it.

**Keyless checks.**

```sh
# The record: dataset and split hashes, S7/S8 inputs rebuilt from Cat 35,
# recounts of the S7 pair and LongMemEval arms, every verdict number. No gbrain.
bun run eval:system-one

# Rebuild the S7, S8, S3 and S4 datasets with gbrain and check their frozen hashes.
git clone https://github.com/garrytan/gbrain.git ../gbrain
bun eval/runner/system-one-jev.ts build --gbrain ../gbrain@9196543dffd8c6b918b232559956f4693874e67b \
  --longmemeval-s longmemeval_s_cleaned.json

# Re-apply gbrain's production reducers to the recorded Jev answers.
bun eval/runner/system-one-jev.ts analyze --gbrain ../gbrain@9196543dffd8c6b918b232559956f4693874e67b --eval s9-conflict-values
```

`analyze` takes `s2-intent-routing`, `s6-recall-needed-values`,
`s8-grounding-values` or `s9-conflict-values`. On October 1, at both
`fc9a1d45` and `9196543d`, all four reproduced the committed analysis files
exactly, and `build` reproduced all four rebuilt datasets' hashes
([reproduction record](2026-09-30-system-one-jev/reproduction-2026-10-01/9196543d/analyze.txt)).
LongMemEval-S cleaned comes from
[Hugging Face](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned)
(MIT, sha256 `d6f21ea9…c3a442`, checked before building).

**Paid runs, one per evaluation.** `plan` prints every command without running
anything; `run` executes them and needs `--yes`.

```sh
bun eval/runner/system-one-jev.ts plan --eval S7
bun eval/runner/system-one-jev.ts run --gbrain ../gbrain@9196543dffd8c6b918b232559956f4693874e67b \
  --eval s7-triage-pair --yes
```

| Evaluation | Slot | How it runs | Keys | Spent on Sept 30 |
|---|---|---|---|---|
| `s7-triage-pair` | S7 | four arms through `runTriagePass` (off, on, and a retest of each) | Jev, Anthropic | Jev $0.25, Haiku $1.16 (with calibrate and qualify) |
| `s9-conflict-values` | S9 | ask once (two repeats), apply the reducer | Jev | part of $3.88 Jev |
| `s1-rerank-lme-s` | S1 | eight `eval longmemeval` arms; pass `--longmemeval-s` | OpenAI, Voyage, Jev, Anthropic | embeddings $3.94, Jev $1.17, Voyage $0.60 |
| `s1-rerank-lme-m-pilot` | S1 | five arms on the 28-question M pilot; pass `--longmemeval-m` | same | embeddings $0.68, Jev $0.31 |
| `s1-rerank-judged` | S1 | two judged arms on 100 questions | same | reader $3.58, judge $0.25 |
| `s2-intent-lme`, `s3-evidence-lme` | S2, S3 | `eval longmemeval --decide intent=on` / `evidence=on` | OpenAI, Voyage, Jev | Jev $0.91 together |
| `s2-intent-routing`, `s4-answerable-values`, `s5-injection-values`, `s6-recall-needed-values`, `s8-grounding-values` | S2, S4, S5, S6, S8 | ask once, apply the reducer | Jev | $3.88 Jev for all recorded answers, calibrations and qualifications |
| `s6-recall-needed-brainbench` | S6 | `eval brainbench --suite know-to-ask --decide recall_needed=on`, BrainBench and reflex-miss fixtures | Jev | in the $3.88 |
| `judge-agreement-longmemeval`, `judge-agreement-grounding` | S1, S8 | `decide judge-agreement` | Jev | $0.003, $0.036 |

Outputs land in `eval/reports/system-one-jev/<evaluation>/` (`run.json`,
`summary.json`, per-arm rows and `analyze-*.json`). `--limit N` runs only the
first N families or questions as a smoke test. On October 1 (at `fc9a1d45`) a smoke of
`s7-triage-pair` (2 transcripts), `s9-conflict-values` (3 families) and two
`s1-rerank-lme-s` arms (2 questions) ran end to end for about $0.07; those
receipts are in
[`smoke-2026-10-01/`](2026-09-30-system-one-jev/smoke-2026-10-01/ledger.jsonl)
and are not comparable with the full-run numbers.

**Not ported.** The preset end-to-end dream run has receipts but no driver:
gbrain committed no script for the fresh-brain setup and session-corpus wiring,
so a definition here would be a reconstruction rather than the measured
procedure. Its numbers above come from `receipts/preset/`.

**Files.**

- [`verdicts.json`](2026-09-30-system-one-jev/verdicts.json): every number in
  this report, each with the receipt and JSON pointer it comes from.
- [`receipts/`](2026-09-30-system-one-jev/receipts/s7/summary.json): gbrain's
  calibrate and qualify output, recorded Jev answers, per-question LongMemEval
  rows, summaries, the preset run and judge agreement, copied byte for byte.
- [`ledger.jsonl`](2026-09-30-system-one-jev/ledger.jsonl) and
  [`ledger-datasets.jsonl`](2026-09-30-system-one-jev/ledger-datasets.jsonl):
  every paid call ($22.44 eval lane, $2.52 dataset building).
- [`provenance.json`](2026-09-30-system-one-jev/provenance.json): source commits,
  models and the sha256 of every copied file.
- [`upstream/`](2026-09-30-system-one-jev/upstream/runners/lme-arms.sh): gbrain's
  generators and runners as they produced these receipts.
- [`eval/data/system-one-v1/`](../../eval/data/system-one-v1/README.md): the
  datasets, inputs and `datasets.json`.
- gbrain's own write-up:
  [verdicts](https://github.com/garrytan/gbrain/blob/9196543dffd8c6b918b232559956f4693874e67b/docs/eval/system-one/README.md),
  [protocol](https://github.com/garrytan/gbrain/blob/9196543dffd8c6b918b232559956f4693874e67b/docs/eval/system-one/PROTOCOL.md),
  [design plan](https://github.com/garrytan/gbrain/blob/9196543dffd8c6b918b232559956f4693874e67b/docs/designs/SYSTEM_ONE_JEV_V1.md)
  and [user guide](https://github.com/garrytan/gbrain/blob/9196543dffd8c6b918b232559956f4693874e67b/docs/guides/system-one.md).
