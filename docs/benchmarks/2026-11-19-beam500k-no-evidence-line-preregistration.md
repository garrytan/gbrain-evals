# Preregistration: does a perfect "no evidence found" line stop gbrain's readers from making up answers on BEAM-500K? (oracle stub, newest build)

Written 2026-11-19. The file freezes when its pull request merges, before the first paid request. Values that don't exist yet (the gbrain release and commit at launch, the harness commit, the judge check's result, the ledger run ids) are appended under "Recorded before cells" before the first counted cell. Any other change after that is a dated amendment at the end, never an edit.

## Question

BEAM's conversations come with questions about things the user never said (BEAM's `abstention` ability). The right answer is to say the history doesn't contain it. In the memory proof wave 2 confirmation cells, gbrain's combined lane (cells `a49df98da16d` and `d2dec41f62dd`, `gemini-3.8-flash` reader, BEAM's rubric judge) stated an answer instead on 18 of 56 such questions (32%). The memory-bank server compared there did so on 21 of 56. Those 28 conversations mostly sit in this repository's sealed split, so this run doesn't reuse them.

gbrain's maintainers are deciding whether to build an "evidence not found" signal into a release: gbrain would tell the reader, in what it returns, that it found nothing that answers the question. Two existing pieces could carry it: System One's `answerable` slot (diagnostic only, on `query`, off by default; gbrain's docs/guides/system-one.md, "abstention") and the retrieval grade in gbrain's src/core/search/crag.ts. Their rule: if even a perfect version of that line doesn't cut made-up answers materially, a real signal won't either, and they don't build it. If it does, the plan sizes the real signal against that ceiling.

**The question:** at gbrain's newest release, on BEAM-500K's public dev conversations, how often do frontier readers make up an answer to an unanswerable question (the before row), and how much does one plain line, `gbrain found no evidence for this question`, appended to gbrain's retrieved context exactly when the question is unanswerable, cut that rate? And when the same line is shown on a question that does have an answer (a false alarm), how many correct answers does it cost? The first number is the ceiling a real signal can reach; the second prices its mistakes.

## Public lesson

- If the line cuts made-up answers materially: "We learned that telling the model 'memory found nothing for this' cut made-up answers from X% to Y%, and that a false alarm costs Z correct answers in 100. You should give your agent's memory tool an explicit 'no evidence' result, and build it only as precise as Z says it must be."
- If it doesn't: "We learned that even a perfect 'no evidence' line cut made-up answers by only X points: frontier readers answer from what memory returns whether or not memory says it found nothing. You should look elsewhere than a memory-side signal (the reader's prompt, or not returning loose matches) to stop made-up answers."
- If there is no headroom: "We learned that at gbrain's newest release frontier readers already decline on almost all of BEAM-500K's unanswerable questions (X%). The 32% we measured in October came from an older build and a smaller reader, and this run can't say which of the two made the difference."

## Evidence class

Development evidence on public data: BEAM's 500K conversations at the pinned revision, this repository's dev split only (`eval/decisions/splits/beam-500k.json`). Nothing comes from the sealed split or from custody. The dev conversations are public and gbrain's maintainers could have tuned against them, so the before row compares in kind with other dev rows, not with the sealed confirmation.

## Build and data

- **gbrain build.** The newest release on gbrain's master at launch: the highest version tag, read with `git ls-remote --tags https://github.com/garrytan/gbrain.git` (v0.60.742.0, commit `ae8201041c21`, when this file was written). It is pinned with `bun eval/runner/gbrain-pin.ts bump` in a dated commit on the results branch. The tags are re-read immediately before the first ingest, and a newer release moves the pin by dated amendment before that ingest. The ingest is the first counted gbrain run, so the build freezes there for this experiment. Each conversation is ingested once into one store, which the three readers' `B` cells all read. The results record the release and its commit.
- **Data.** BEAM at `b2da22e` (`eval/decisions/datasets/beam-b2da22e.json`), 500K size, the 11 dev conversations: `500k-10`, `500k-12`, `500k-18`, `500k-20`, `500k-21`, `500k-24`, `500k-25`, `500k-28`, `500k-29`, `500k-31`, `500k-33`. Each has 20 questions, 2 per ability: 220 questions, of which **22 are unanswerable** (`abstention`) and **198 are answerable** (the other nine abilities, the matched answerable set: same conversations, same stores, same retrieval). Only question counts per ability were read before this file was written; no question, answer or conversation text was opened.
- **Harness.** The memory proof wave harness (`eval/harness-provider`, pinned harness commit `f618ed7b` in `harness.lock.json`), `rag` mode, provider `gbrain`, combined lane, with the provider settings of the confirmation cell `a49df98da16d` (Voyage `voyage-4` embeddings and `rerank-2.5` reranking, exchange pages, 600 facts tokens, an 8,000-token delivered-context target). A setting the newest build refuses is dropped, and a setting it renamed is mapped, by dated amendment before the first ingest. The delivered-context gate of the harness (mean within 10% of the target) applies; if it fails, the retrieval-only tuning pass of `eval/runner/harness-dev.ts` (no reader, no judge) picks the setting, recorded before the first answer.
- **Bridge to the October number, descriptive only.** 7 of the 11 dev conversations (`10`, `18`, `20`, `24`, `25`, `29`, `33`) were among the confirmation cells' 28. On their 14 unanswerable questions, the October combined lane stated an answer on 5 (cells above). That row is shown beside this run's rows on the same 14 questions, unpaired in build and reader.

## Arms

| Arm | What the reader gets | Questions | Samples per reader |
|---|---|---|---|
| `B` (before, no line) | gbrain's retrieved context, rendered by the harness | all 220 | 3 on the 22 unanswerable, 1 on the 198 answerable |
| `O` (oracle line) | `B`'s recorded context, byte-identical, with the line appended | the 22 unanswerable | 3 |
| `F` (false-alarm line) | `B`'s recorded context, byte-identical, with the line appended | the 198 answerable | 1 |

- **The line.** `gbrain found no evidence for this question`, on its own line after the last retrieved memory, separated by one blank line. It is keyed on BEAM's gold ability label (`abstention`), never on anything gbrain returns, so `O` is a perfect signal by construction: it fires on every unanswerable question and on no answerable one. Under that perfect signal the answerable questions see no line, so their `B` rows stand for `O`, and `O` loses no correct answer by construction. `F` measures what each false alarm of a real signal would cost.
- **Same evidence.** `O` and `F` start no memory system. They replay `B`'s recorded retrievals through `python -m mpw.reanswer`, which rebuilds each answer prompt and refuses to run when the rebuilt prompt differs from the recorded one. The only change between `B` and `O` or `F` is the appended line, so every difference is the line's effect plus resampling noise, which the paired analysis carries.
- **Harness change.** `mpw.reanswer` gains one option that appends a given line to the rendered context of the questions a file lists, compares the rebuilt prompt against the recorded prompt with that line, and records the line, its SHA-256 and the id list in the cell. Unlike the current replay, which compares prompts after the answer request returns, the option rebuilds and compares each prompt before any request is sent, and refuses a question with no recorded prompt. It lands as a dated commit on the results branch with a keyless test (the stub reader) that fails without it, before any paid request, and one Opus reader reads that commit. No gbrain change is involved.
- **Fixed for every arm:** the answer prompt of the pinned harness's BEAM `rag` mode, the rendered context format, the 8,000-token target, and every setting not named here.

## Readers and judges

- **Readers:** `claude-opus-5-5` and `particle-1` (the primary models), and `gpt-6.2-sol` (the newest frontier GPT). Opus 5.5 and GPT-6.2 Sol run at their provider default effort. particle-1 is sent `reasoning_effort: high` with a 16,000-token output limit, and the receipt records the effort and limit sent. Sonnet and Haiku are not run. The October reader, `gemini-3.8-flash`, is not rerun: the bridge above uses its published rows. A reader the pinned harness can't drive is fixed by a dated commit and amendment before the first counted answer, after a search for a known fix; a provider safety-filter stop is a result, reported on its own line. Model freshness (`bun scripts/model-freshness.ts`) runs on the day of the first counted answer, and a newer frontier Opus or GPT stops the run until a dated amendment names it.
- **Correctness judge: BEAM's rubric judge** (`BEAMDataset.score_result` through the harness's strict scorer), on `gemini-3.5-flash`, which the pinned harness fixes for BEAM and which produced the October 32%. It is from a different family than every reader. A row is correct when the scorer marks it `correct` (the harness's rubric score of at least 0.5). On an unanswerable question the rubric has one item, that the answer says the history holds no such information, so a row judged not correct there is a **made-up answer**.
- **Answer-type judge (the three-way label):** every row is also labelled `declined` (says the history doesn't hold the answer and gives none), `hedged` (gives a specific answer and says it is unsure) or `committed` (gives a specific answer without saying it is unsure). The prompt, `beam-answer-type-v1`, shows the question and the answer only, never the gold or the context; it is committed on the results branch before the judge check and not changed after. `gpt-6-astra` labels the Opus 5.5 and particle-1 rows; `claude-opus-5-5` labels the GPT-6.2 Sol rows, so no family labels its own rows. particle-1 never judges.
- **Judge check (R78, before any counted judgment).** On public material only, from the 220 dev questions, written from each question's gold (BEAM's ideal response and rubric) before any counted answer exists, with labels by construction:
  - for the correctness judge, 48 items: on unanswerable questions 12 declining answers (good) and 12 answers that state an invented detail, 6 of them hedged (bad); on answerable questions 12 answers that state the ideal response in other words, 4 of them hedged (good) and 12 that state a wrong value or leave out a rubric item, 4 of them hedged (bad);
  - for the answer-type judges, 48 items, 16 per class, over both kinds of question.

  The items are written by hand in this thread from the public gold, with no model call. BEAM is published under CC BY-SA 4.0: the item texts stay on the run's VM and in the private run record, and the repository holds only their SHA-256 hashes, labels and counts. After `B` is answered, 40 real `B` answers (20 on unanswerable questions), sampled with `random.Random(1)` stratified by reader, are labelled by hand before their judgments are read; agreement with both judges is reported, descriptive only.

  A judge passes when its Cohen's kappa against the construction labels is at least 0.6 (for the type judges, on the three classes and on declined against not declined), with at least 15 items of each class graded (for the type judges, at least 12 per class) and at most 1% of its outputs unparseable. Both type judges grade all 48 type items, and their agreement is reported. If the correctness judge fails, Δ_O uses the type judges' declined-against-not-declined label instead (made-up = hedged or committed on an unanswerable question), and says so; L has no such fallback, because a type label can't tell a correct answer from a wrong one, so L is reported as unavailable; a type judge that fails makes the endpoints it labels descriptive, not counted. If both fail, no verdict is printed and the numbers are reported as descriptive.

## Metric and denominator

- **Unit and pairing.** A question and reader: on unanswerable questions, the made-up rate of a question and reader is the mean over its 3 samples in each arm; on answerable questions, one sample per arm. Denominators are fixed by the schedule: 22 unanswerable and 198 answerable questions per reader. A row that failed for a harness reason (a provider 5xx or 429 after backoff, a store or transport failure) is resumed by the same command, never counted as a failure, and the analysis refuses to compute an endpoint while any scheduled row is missing. A context-length error, an empty answer, a truncated answer or a refusal counts as answered and is judged. Such rows are also reported on their own line per arm and reader, and Δ_O is printed a second time without them, so a line that only causes empty answers can't pass as fewer made-up ones.
- **Primary 1, the ceiling: Δ_O** = made-up rate in `B` minus made-up rate in `O` on the 22 unanswerable questions, pooled over the three readers (equal weight), paired by question and reader.
- **Primary 2, the cost of a false alarm: L** = correct rate in `B` minus correct rate in `F` on the 198 answerable questions, pooled over the three readers, paired by question and reader; also split into answers that turned into declines and answers that turned wrong.
- **Intervals.** A question bootstrap: 10,000 resamples from one `random.Random(1)` stream; each resample draws the question ids of the endpoint with replacement (`rng.choice` over the ids sorted as strings), and a drawn question brings every reader's rows of both arms; the interval is the 2.5th and 97.5th percentiles. Questions share conversations, and there are only 11 conversations, so the interval is conditional on them (see limitations).
- **Before row (the confident-wrong measures), per reader and pooled, on `B`:** accuracy on all 220 questions; the made-up rate on the 22 unanswerable; the wrong-answer rate on the 198 answerable; the share of wrong answers labelled `committed` (confident when wrong) and `hedged`; the share of answerable questions declined (over-caution); and the delivered context in tokens. The first table shows `claude-opus-5-5` and `particle-1` with cost per correct answer.
- **Secondary, same bootstrap, without multiplicity correction and labelled as secondary:** Δ_O per reader; Δ_O for committed made-up answers alone (a line that turns confident inventions into hedged ones is a smaller win than one that turns them into declines); Δ_O from the type judges' label; L per reader and per ability; and the bridge on the 14 shared questions.

## Decision rule

- **Smallest detectable difference** (two-sided α 0.05, 80% power, 2.8 standard errors), estimated before any cell by simulation, since no frontier-reader rows exist on these questions: per-question made-up probabilities drawn from a beta distribution with mean 0.32 (the October rate) and concentration 2, each reader's probability that plus normal noise with standard deviation 0.10, three samples per arm on unanswerable questions and one on answerable questions with a 0.55 correct rate, 3,000 simulated runs per row. For Δ_O the standard error is taken at a 50% cut; for L, at no effect. The script that prints this table and the power table below, `sdd.py`, is committed with the results unchanged and rerun there with the same seed.

| Comparison | Detectable difference |
|---|---:|
| Δ_O, three readers pooled, 22 questions × 3 samples | 12.8 points |
| Δ_O, one reader | 19.3 points |
| L, three readers pooled, 198 questions | 6.5 points |
| L, one reader | 11.2 points |

- **Materially**, stated now: the line cuts the pooled made-up rate materially when **Δ_O is at least M = the larger of 13 points and half of `B`'s pooled made-up rate**. Half the rate is the smallest cut worth a release; 13 points is the detectable difference rounded up, so a smaller cut can't be told from noise at this size. The 13-point floor applies only to calling a cut material, never to calling it not material.
- **Outcomes, decided in this order.** D = Δ_O − M and D_half = Δ_O − (half of `B`'s pooled made-up rate) are computed inside each bootstrap resample, with `B`'s rate from that resample, so their intervals carry the uncertainty in M.
  1. **No headroom:** `B`'s pooled made-up rate is below 13%. Even removing every made-up answer couldn't be detected here.
  2. **Material:** D is at least 0 and Δ_O's interval's lower bound is above 0.
  3. **Not material:** D_half's interval's upper bound is below 0 (the cut is reliably smaller than half the before rate).
  4. **Not distinguishable:** anything else, printed with the point estimate and both intervals.
- **How often each outcome comes out** under the simulation above (normal intervals from per-question paired differences, 3,000 runs each). M sits at the cut a true halving gives, so a true halving is called material only about half the time and almost never not material; the rule prefers "not distinguishable" to a wrong call either way:

| True cut of the made-up rate | Before rate 32%: material / not material / not distinguishable | Before rate 20%: material / not material / not distinguishable (no headroom 4%) |
|---|---|---|
| none | 0% / 99% / 1% | 0% / 86% / 10% |
| 30% | 2% / 36% / 63% | 2% / 20% / 74% |
| 50% | 49% / 1% / 50% | 26% / 0% / 69% |
| 60% | 87% / 0% / 13% | 48% / 0% / 48% |
| 70% | 98% / 0% / 2% | 68% / 0% / 28% |
| 90% | 100% / 0% / 0% | 91% / 0% / 4% |
- **L is not a gate.** It is printed with its interval in every outcome and used in the sizing below.

## What each outcome changes

| Result | Then |
|---|---|
| No headroom | gbrain's maintainers get the before row: their plan gets no "evidence not found" section from this evidence. Public text says the October 32% belongs to that build and that reader, with the newest build's rate beside it |
| Material | The maintainers build the signal, and their plan sizes it against this ceiling: for a signal that flags a share r of unanswerable questions and a share f of answerable ones, the expected cut in made-up answers is about r × Δ_O, and the expected loss of correct answers is about f × L. The plan states the r and f the signal must reach for a net gain, and that signal gets its own preregistered test on these questions before any release carries it |
| Not material | The maintainers don't build it, by their own rule, and get the per-reader rows and the committed-versus-hedged split. A one-line "Why null?" goes with it: did readers see the line (the recorded prompts), and did the line move committed answers to hedged ones |
| Not distinguishable | Published as not distinguishable at 22 questions. The next step is a separately approved, preregistered extension to the unanswerable questions of BEAM-100K's and BEAM-1M's public dev conversations (12 and 22 more), not part of this run |
| Readers disagree (one reader's Δ_O interval above M, another's below 0) | Reported per reader; the decision follows the pooled outcome, and the maintainers hear which readers the signal would help |

## Gates before counted cells

1. The harness commit (the reanswer option), the answer-type prompt and the judge-check script are on the results branch, their keyless tests pass in CI, and one Opus reader read them clean.
2. The tags are re-read and the pin names the newest release.
3. The judge check has run, and its result is recorded below.
4. All 11 conversations ingest with no page saved without vectors, and the delivered-context gate passes.
5. A one-question smoke per reader through the harness halts on any harness error.
6. Model freshness passes on the day of the first counted answer.

## Budget

The run goes on one Ubicloud VM, detached, with one budget ledger and one writer. Every paid step, the judge check, the retrieval tuning pass and the smokes included, runs against that ledger, and every request is reserved against it before it is sent (`eval/runner/budget-ledger.ts`) through the harness's metering proxy, and every cell passes its own budget. Reaching a cap pauses the run at the cell boundary until the cap is extended, and the same command resumes it; it never ends the test incomplete. Every particle-1 request, smoke and counted, runs inside one granted paid window after the other readers' cells, so Particle's spend reconciles against one ledger with no other traffic on its key. The VM is destroyed when the run ends.

## Known limitations

- 22 unanswerable questions across 11 conversations. The pooled design can detect a cut of about 13 points, not a smaller one, and the interval doesn't cover variation between conversations.
- The detectable differences come from a simulation with stated assumptions, not from rows of these readers.
- BEAM's unanswerable questions are of one kind: details of something the user discussed but never stated. Other kinds (a person never mentioned, a question about the future) aren't covered.
- The line names gbrain and is phrased one way; another wording, or a signal shown as a tool field instead of a sentence, could move readers differently.
- The run measures context pasted into the prompt (`rag` mode), as the October 32% did, not an agent that calls gbrain's tools. In a tool loop the line would sit in a tool result.
- A perfect signal is an upper bound for this wording only; a real signal also changes what gbrain retrieves, which this run holds fixed.
- The answer-type labels come from two judges of different families, so type shares compare across readers only as far as the judge check's agreement allows.
- The bridge to October is unpaired in build and reader.
- The answer-type judge for Claude and particle-1 rows is `gpt-6-astra`, the judge R78 names and the one the budget ledger prices; it is one generation behind the newest Astra.
- BEAM is used under CC BY-SA 4.0 at the pinned revision; the results credit it, and no BEAM text beyond short quoted questions in examples is committed.

## Recorded before cells

To be appended before the first counted cell: the gbrain release and commit; the harness commit and the reanswer option's commit; the answer-type prompt's SHA-256; the judge check's result; model freshness; the delivered-context gate and any tuned setting; the VM name and ledger run ids.

## Amendments

### Amendment 1 (2026-11-19, before any paid request): the approved build condition, pilots, the newest release

This adds a second verdict, read the way gbrain's maintainers read the owner's approval of their release plan. It is their reading, not the owner's words. The preregistered "material" verdict above is unchanged, and the results report both verdicts.

- **Build:** the perfect line cuts the pooled made-up rate on the 22 unanswerable questions by at least 44% of `B`'s rate (8 of 18, taken as a ratio), with 3 samples per reader, paired, and Δ_O's 95% interval excluding 0.
- **No build:** the relative cut's point estimate is under 25%.
- **Borderline:** a relative cut from 25% to 44%, or 44% or more with an interval that reaches 0. This run then decides nothing. The decision goes to a separate, separately approved step on held-out data, which this run does not include.
- **Ship conditions** (the line misfires on at most 5% of answerable questions, and costs at most 1 point of correct answers) are measured later on the real signal, not in this test. Arm `F` shows the line on every answerable question, so it can't measure a misfire rate. What it measures is L, the correct answers lost per misfire. The results print L with its interval, and beside it the cost at a 5% misfire rate (0.05 × L) and the highest misfire rate that keeps the cost at 1 point (1 point ÷ L), each with an interval. When an interval is wider than the bar it is compared with, the same sentence says so.
- The relative cut is Δ_O divided by `B`'s pooled made-up rate, both computed inside each bootstrap resample.
- **Pilot (R111).** Each arm's pilot comes before its counted run and stays under a tenth of that arm's budget. For `B`, the one-question smoke per reader goes through the harness: it shows the store answers and the question is supplied with the delivered-context gate met. For `O` and `F`, a two-question replay per reader, one unanswerable for `O` and one answerable for `F`, shows in the recorded final prompt that the appended line is present and the rest of the prompt is byte-identical. Both judges' check (R78) must pass before any pilot output is judged. The pilot rows are judged, reported, and not counted. An arm whose pilot fails is fixed by dated amendment or left out, and is reported as left out.

- **Named open notes from #527's review, settled here.** (1) When the correctness judge fails, L is unavailable. The "Material" row then sizes the signal with the made-up cut alone, says the false-alarm cost is unmeasured, and the build condition's ship readings print "unavailable". (2) When the correctness judge fails, the before row's accuracy and wrong-answer rates are printed as descriptive, not counted. When a type judge also fails, Δ_O for that judge's rows is descriptive, and the verdict uses only the readers whose judges passed, saying so.
- **gbrain build.** The newest release on gbrain's master is now v0.60.743.0 (commit `16124807cb78`, read with `git ls-remote` at 2026-11-19T07:42Z). The pin moves to it in the next commit on this branch, before any ingest. The tags are read again immediately before the first ingest.

### Amendment 2 (2026-11-19, before any paid request): exact thresholds and edge cases

This settles the open notes from the reader of the results-branch commits. Nothing in it changes an arm, a sample count, a judge or the preregistered "material" verdict.

- **Build threshold, exactly.** Build needs a relative cut of at least 8/18 (0.4444…), compared as a ratio, never as a rounded percentage. Borderline is a relative cut of at least 0.25 and below 8/18, or at least 8/18 with an interval that reaches 0. No build is a point estimate below 0.25. When `B`'s pooled made-up rate is 0 in a bootstrap resample, that resample's relative cut is undefined and is dropped from the relative cut's interval, and the results say how many were dropped; when it is 0 in the full data, the outcome is "no headroom" and no build verdict is printed.
- **The highest misfire rate when L ≤ 0.** "1 point ÷ L" is capped at 100%: when L is 0 or negative (the line cost no correct answers), the highest misfire rate that keeps the cost at 1 point is printed as 100%, in the point estimate and inside each bootstrap resample, so the interval is always defined. 0.05 × L is printed as computed, negative values included.
- **Per-reader readings are descriptive.** The build verdict and the "material" verdict are pooled over the three readers. Per-reader relative cuts and Δ_O are secondary: the detectable difference for one reader is 19.3 points (the table above), and no per-reader build or material verdict is printed. When a reader's judge fails its check, that reader's numbers are labelled descriptive and the pooled verdict uses the readers whose judges passed, as amendment 1 says.
- **Unparseable or missing answer-type labels.** A counted row whose type label is still unparseable after the label run is not relabelled by hand. It is reported per arm and reader, and left out of the endpoints that use the type label (the committed and hedged shares, Δ_O from the type label, committed made-up answers), whose denominators then say how many rows they hold. The rubric judge's endpoints (Δ_O, L) are unaffected.
- **Reader refusals in the replay arms.** A `B` row whose reader refused records the prompt it was sent, and `O` and `F` replay it with the same check as any other row. If a `B` row has no recorded prompt, the replay refuses it by design; that question and reader is then left out of both arms of the paired endpoint it belongs to, and reported with its reason. This is the only case where a scheduled row may be missing when an endpoint is computed.

### Amendment 3 (2026-11-19, before any paid request): particle-1 through the harness

The pinned harness had no client for particle-1, which this preregistration's readers section says is fixed by a dated commit and amendment before the first counted answer. The results branch now registers one (`mpw/particle_llm.py`). It sends particle-1 an OpenAI Chat Completions request through the metering proxy with `reasoning_effort: high` and a 16,000-token output limit, never `temperature` or `seed`, and asks for the harness's JSON answer in the prompt, parsing it from the reply the way the Anthropic reader's fallback does. A request is sent again only when the proxy reports that it never reached Particle; any other failure is a failed row, resumed only inside a paid window. A reply with no JSON answer is a failed row, the same as for the Anthropic reader. particle-1 still never judges, and the cell spec now refuses it as a judge. Its pilot (amendment 1) also shows, from the proxy's recorded request, that the effort and limit were sent. particle-1 runs only after its own approval, after the Opus 5.5 and GPT-6.2 Sol cells.

### Amendment 4 (2026-11-19, after arm `B` for Opus 5.5, before any `O` or `F` answer): the Anthropic reader's replies

Arm `B` for Opus 5.5 ended with 21 of 220 rows (3 of them unanswerable) failed as harness errors: 13 replies came back as plain text without the answer tool call the pinned client expects, and 8 came back with a tool call missing the answer field. The 21 request bodies, resent unchanged, showed why. Some replies stop for a refusal partway through the tool call. The client returned that partial call instead of reporting a refusal, so the row failed later on the missing field. Other replies answer in plain text with no tool call. Both are client bugs in how replies are read, not in what is sent: the request is unchanged.

- **The client now reads replies this way** (`mpw/anthropic_llm.py`, with a keyless test). A reply that stopped for a refusal is a reader refusal, which this preregistration counts as answered and judges, including one that holds a complete tool call, which the old client took as the answer. A tool call missing a required field is not taken as the answer. A plain text reply that ended normally, with no tool call, is taken as the answer, for the answer schema only; a reply cut off by the output limit is still a failure.
- **Failed rows keep their prompt.** An answer failure now records the prompt it was sent, as a refusal does, so a later replay can check it.
- **The 21 rows are asked again** as this preregistration says for harness failures. `mpw.reanswer` re-asks a failed row that has no recorded prompt, without the line, and records the prompt it sends. It still refuses to add the line to any row whose prompt was never recorded. The repaired answers replace the failed receipts in the `B` cell. The failed receipts are kept beside them with a manifest of their hashes and errors, and the results list the 21 rows. Before the repaired answers go back, each repaired prompt is checked against the request body the failed row recorded, byte for byte. The 8 rows with a missing field may first have been refusals; their first reply wasn't kept, so asking again gives them a second draw. For that reason the paired endpoints are also printed without the 21 rows, as a sensitivity check.
- Every Opus row in `O`, `F` and the extra `B` samples is answered by the fixed client. The GPT-6.2 Sol and particle-1 clients are unchanged by this.

### Amendment 5 (2026-11-20, during arm `B` for particle-1): a list in the particle-1 answer

particle-1's first arm `B` cell (`beam-500k-gbrain-rag-edd57c6d3c92`) stopped at its 69th answer. For an event-ordering question it replied with the requested JSON object, but its `answer` was a list of strings (one dated step per item) rather than one string. The scorer's abstention check failed on the list. The 68 rows before it had already been answered and judged.

- **The client now reads such a reply as its lines** (`mpw/particle_llm.py`, with a keyless test that fails without it). A string field that holds a list of strings is joined with newlines. Any other non-string value is no structured response, which is a failed row as amendment 3 says. The request is unchanged.
- **Arm `B` for particle-1 was answered again from the start.** The fix changed the harness commit, so the same command started a new cell (`beam-500k-gbrain-rag-354daaed3f56`), and every particle-1 row in `B`, `O` and `F` goes through the fixed client. The first cell, with 69 answers, is not counted and is kept as it is. In it the list row was converted to its lines, with the original's hash in `answer-coerce.json`, before the new cell started.
- One Opus reader read this commit and found no blocking issue.

## Disclosures

gbrain is Garry Tan's own project. Disclosure: Y Combinator, which Garry Tan runs, is an investor in Particle, which makes particle-1. Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator. Garry Tan runs Y Combinator.
