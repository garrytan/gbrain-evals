# Pinned questions: preregistration

Registered 2026-11-24 by GBEV-133 (issue GST-3682). Registry entry:
[preregistrations.d/pinned-questions.json](preregistrations.d/pinned-questions.json).

## Question

gbrain can pin a question (`gbrain questions pin`, MCP `questions_pin`): it keeps a cited answer, checks the
citations on every read, flags sentences whose evidence changed, and its `standing_questions` cycle phase refreshes the
answer. Nothing in this repository tests that loop. This experiment asks three things:

1. After a controlled change to the notes, does gbrain flag exactly the sentences whose evidence changed (keyless)?
2. Does it schedule the right questions for refresh, and how many simulated days pass before the answer is right again
   (keyless)?
3. When a real model refreshes the answer through gbrain's own refresh path, is the new answer correct, and is the
   low-cost particle-1 close enough to Opus 5.5 to recommend it for refreshes (paid)?

## Public lesson

- If gbrain flags and schedules well: "We learned that a pinned answer in gbrain tells you which sentence went stale
  and comes back corrected within a day. You should pin the questions you re-ask and trust its stale marker."
- If it doesn't: "We learned that gbrain's stale marker covers a whole page, so an unrelated edit flags correct
  sentences, and a contradiction written into an existing note never triggers a refresh. You should refresh a pinned
  answer by hand after you add contradicting notes, until the fix ships."
- Paid: "We learned that a refreshed pinned answer from <model> is right <x>% of the time after its notes change. You
  should use <model> for refreshes, because <cost per correct answer>."

## Evidence class

Development evidence for the keyless arm on dev seeds 1 to 3 (already run while building the category; the dev
numbers went to gbrain's maintainers as a patch, see the hill-climb section). Counted results come only from seeds 11
to 20, which no run has touched. The generator is public, so these are synthetic-production-path results, not held-out
confirmation.

## Build and data

- **gbrain:** the newest release tag on gbrain's master at launch, today v0.60.769.0 (`38831bb6`). Counted runs load
  it with `--gbrain <checkout>@<tag>` (a copied overlay the receipt records), or through `package.json` if a pin bump
  to that release has merged by then. If a newer release lands before the first counted run, a dated amendment names
  it before that run. The build freezes once counted runs start, and the results record it.
- **Hill-climb build:** the release that ships GBRA-108's fix for the scheduling problem (below). Its keyless rerun is a
  second, separately labelled measurement on the same seeds, run when it ships, and it is compared with the frozen
  baseline. Running the baseline build next to it is allowed because the question is about that change.
- **Worlds:** `eval/generators/pinned-questions-gen.ts` (`pinned-questions-gen/1`), 24 fictional companies per seed,
  3 per change class. Counted seeds 11 to 20 (240 questions, 960 answer sentences per arm). Pilot seed 21
  (`--stage pilot`); judge-check seeds 21 to 23 (`--stage judge-check`). The receipt records each seed's ledger fingerprint.
- **gbrain-evals:** the merge commit of this preregistration, recorded in each receipt.

## Arms

**K: keyless flags and scheduling.** `bun eval/runner/pinned-questions.ts --seeds 11,...,20 --citation all`. In-memory
PGLite, gbrain's operation handlers and `src/core/questions/service.ts` as the local owner. The pinned-question model
is a scripted oracle that answers each claim with one sentence citing every evidence line that states the ledger value
and names the company. Changes run one at a time. Settings: `--cycles 6`, gbrain's default scheduler settings
(cooldown 1 day, 5 refreshes per run). A secondary run with `--citation one` (one citation per sentence, a fact row
first) checks that the flag results do not depend on the oracle citing every line.

**P: paid refresh correctness.** `bun eval/runner/pinned-questions-paid.ts` on the same worlds. Each question is pinned
and, after its change, refreshed with `questions_refresh` through gbrain's own gateway and prompt, with the model under
test set as `models.standing_questions`. Gbrain chooses incremental or full refresh itself; the receipt records which.
Models under test, called by gbrain's gateway (the product path, not an agent harness):

| Model | Role | Notes |
|---|---|---|
| `claude-opus-5-5` | under test (primary, comparator) | gbrain's deep tier |
| `particle:particle-1` | under test (primary, low cost) | gbrain's `particle` recipe; the receipt records the reasoning effort sent and the output limit |
| `gpt-6.2-sol` | under test (frontier GPT) | |
| `gpt-6.2-astra` | judge of the Claude and particle-1 rows | |
| `claude-opus-5-5` | judge of the gpt-6.2-sol rows | |

The judge prompt is frozen in the runner (`PINNED_QUESTIONS_JUDGE_PROMPT`, hash in the receipt). Output limits are
gbrain's defaults (`cycle.standing_questions.max_output_tokens` 2,000), so a model that thinks inside that limit is
measured as shipped; a reply cut off at the cap is gbrain's `answer_too_long` and counts as an incorrect answer,
reported per model in its own column (pin and refresh calls cut off, and their share of the model's calls).

**P, raised cap (secondary, conditional).** If the pilot shows more than 5% of any model's pin and refresh calls cut off
at the cap (`data.summary.truncation`), the cap is reported to GBRA-108 as a gbrain finding, and P runs a second time
on the counted seeds with `--max-output-tokens 8000` (`cycle.standing_questions.max_output_tokens` 8,000) for every
model, with the same judges and analysis. It is labelled as a raised-cap arm, never merged with the default-cap
numbers, and the particle-1 decision below reads it. Two settings differ from the product default and are recorded in the receipt: pin and refresh
wait up to 300 seconds (`wait_ms`, the maximum, so a slow answer is graded rather than timed out), and particle-1 is
sent `reasoning_effort: high` (its default) through gbrain's `provider_chat_options`.

## Metric and denominator

**K (primary):** per-sentence flag precision and recall over the 960 counted sentences, by change class, against the
ledger: a sentence is gold-affected when its claim's value changed (edit, supersession, deletion, contradiction). The
analysis unit is the sentence, clustered by question for intervals (cluster bootstrap over questions, 10,000 draws).
**K (secondary):** question-level signal recall and false alarms (stale or `new_evidence_since_watermark`), spillover
(other pins made due by one change), share of affected questions corrected within 6 simulated days and the median
days, and scheduler refreshes spent after changes that touched no claim. A status read that throws is a scored error;
a missing sentence counts as flagged.

**P (primary):** refreshed answer fully correct, per model, over the 240 counted questions: every claim states the
ledger's value after the change, and a removed claim is not asserted. Judged per claim (correct, stale, wrong,
missing). A failed or blocked refresh, a provider safety stop, or a reply cut at the output cap counts as not correct
and is reported in its own column. A provider error before any answer (a 5xx, a timeout, a dropped connection) is not a
model outcome: the unit is retried once in a resumed run, and a unit that still fails is reported as an error and left
out of the denominator, with the count per model. A provider safety stop is its own reported outcome and counts as not
correct; gbrain's error code does not tell it from a provider error, so the runner reads the provider's message that
gbrain logs (a content-filter, safety or refusal message is a safety stop). A failed refresh leaves the pin-time answer
in place, so a refresh that did not publish is scored not correct whatever the judge says of that old text. **P (secondary):** correctness by change class and by refresh mode, first-answer
correctness, and cost per correct answer from the ledger's usage fields.

## Decision rule

- **K:** descriptive per class. The counted baseline supports a failure-mode claim only when the class's 95% interval
  excludes the opposite (for example a false-flag rate whose lower bound is above 10%).
- **K, fix build:** paired by sentence and by question against the baseline on the same seeds; the fix is confirmed
  when spillover falls to zero, contradiction-in-an-existing-note correction within 6 days rises to at least 90%, and
  recall on edits, supersessions and deletions does not fall (McNemar, two-sided 0.05).
- **P:** two primary comparisons, each paired by question against `claude-opus-5-5`: particle-1 and gpt-6.2-sol,
  Holm-corrected at 0.05. particle-1 is non-inferior when the lower bound of the paired 95% interval of
  (particle-1 minus Opus) is above -10 points. When the raised-cap arm runs, the same two comparisons run on it as a
  separate, labelled family (Holm within it), and the particle-1 recommendation names the cap at which non-inferiority
  holds: at the default cap, only at the raised cap (then the cap change is part of the recommendation), or at neither. Smallest detectable difference: about 8 points at 80% power with 240
  paired questions and 20% discordance. A smaller difference is reported as "no measurable difference at this sample
  size", never as equal.

## What each outcome changes

| Measurement | If it shows the problem | If it doesn't | If inconclusive |
|---|---|---|---|
| K: spillover and missed signals (the dev finding) | GBRA-108 ships the scheduling fix it has accepted; we rerun K on that release | We withdraw the fix request and correct the handoff | Rerun K with 20 seeds before asking GBRA-108 to change anything |
| K: false-flag rate on unrelated edits to cited pages | The paragraph-level evidence design note goes to GBRA-108 as a plan to build | We close the design note | The note stays parked |
| P: particle-1 non-inferior to Opus | We ask GBRA-108 to document particle-1 as the low-cost choice for `models.standing_questions` | We document that refreshes should stay on the deep tier | We say no measurable difference at this size and recommend nothing |
| P: a model's pilot calls more than 5% cut off at the output cap | We report the cap to GBRA-108 as a gbrain finding and run the raised-cap arm, which the particle-1 decision also reads | The default-cap arm stands alone | Not applicable: the bar is a count |
| P: Opus correctness after a contradiction at least 15 points below after a direct edit | Design note to GBRA-108: recompute in full when new in-scope evidence arrives, instead of editing the old answer | No change | No change |

## Pilot per arm

- **K:** none needed beyond the dev runs: it is keyless, and the dev seeds already showed the part under test ran (every
  claim answered at pin, zero baseline flags, deletions flagged on the first read).
- **P:** seed 21 (`--stage pilot`), all three models, 24 questions each: 72 pins and 72 refreshes, a tenth of the
  counted seeds and so at most a tenth of P's budget. It must show, on each model's own outputs, that refresh ran
  through gbrain's gateway with that model (the receipt's `answer_model` and the ledger's request rows) and that every
  question could be pinned and refreshed. It also reads the truncation bar: at most 5% of each model's pin and refresh
  calls cut off at the output cap; a model above it triggers the raised-cap arm. A model that fails the other checks is
  fixed or left out and reported as left out. A tenth can't buy the judge check's 100 labelled outputs per judge (seed
  21 gives the Opus judge 48), so, as the template allows, the judge check runs in its own stage before any counted
  unit: `--stage judge-check` into the pilot's `--output` resumes seed 21 from its checkpoint without re-asking it
  and adds seeds 22 and 23 (below). The truncation bar is read again on all three seeds.

## Judge check

Two judges: `gpt-6.2-astra` grades `claude-opus-5-5` and particle-1 rows, `claude-opus-5-5` grades `gpt-6.2-sol`
rows. No judge grades its own family, and particle-1 never judges. Each judge is checked on the real outputs of the
rows it grades in the judge-check stage (seeds 21 to 23), before any counted unit runs: `gpt-6.2-astra` on 288 (first
and refreshed answers of the 144 Opus and particle-1 questions) and `claude-opus-5-5` on 144 (first and refreshed
answers of the 72 Sol questions). The check needs at least 100 labelled outputs per judge after exclusions, and the
runner enforces it (`judgeCheckPasses`, `JUDGE_MIN_LABELS` 100): a judge with fewer fails. If exclusions leave a judge
under 100, a dated amendment adds judge-check seed 24 before any counted unit runs. Labels: the claim values are unique
synthetic tokens, so each output gets a rule label (new value present and old value absent is correct; old present and
new absent is stale; neither is missing); an output whose rule label is ambiguous (both values present) is left out of
the agreement set and counted, so the labels are rule labels, not model labels. Each judge must
reach Cohen's kappa of at least 0.6 on answer correctness, and its disagreements are read per model, not pooled. A
judge that fails is replaced by a stated alternative from another family in a dated amendment before the counted run.

## Interim look

None: the paid run is planned under $500, so no look is planned.

## Budget

Ledger `.budget/ledger.sqlite` through `startPaidRun`; every request is reserved against the ledger before it is sent.
A cap is set in the ledger run; reaching it pauses the run at the unit boundary until the cap is extended, and a rerun
with the same arguments resumes from `checkpoint.ndjson` without re-asking finished units. Paid calls run only inside a
granted paid window, on a Ubicloud VM, detached, with that VM's ledger as the single writer; the VM is destroyed when
the run ends. Amounts stay in the tracking issue.

## The hill-climb round

The brief asks for one honest round: name the biggest failure mode, send gbrain a concrete patch or design note, and
rerun the keyless arm on the fix build. Ranked by mis-scored units on the dev seeds (sentence flags plus question
signals, spillover included), the biggest is scheduling: one new note made 23 unrelated pins due, and a contradiction
written into an existing note was never refreshed. The patch went to GBRA-108 on 2026-11-24
(org drive `handoffs/gbrain/gbev133/`), which accepted it. Page-granularity false flags went as a design note. The
counted ranking on seeds 11 to 20 decides which one the results lead with.

The fix-build rerun is keyless. If the fix release ships before the results PR is ready, the rerun is in it. Otherwise
the results PR reports the baseline alone, and the rerun is published later as its own keyless follow-up with its own
registry entry.

## Amendments

### 2026-11-24: enforcement and scoring fixes before the pilot

Made before any paid call or counted run, from the preregistration PR's review. None changes an arm, a seed, a
metric, a model, a judge or a bar; each makes the runner do what this plan already says, or closes a case it got wrong.

- **Judge check.** A counted launch refuses unless `--judge-check` names the judge-check stage's receipt, on the same
  gbrain build, judge prompt and runner source, that ran every counted model and whose rows pass the check for every judge the
  counted models need. A judge with an undefined kappa (unanimous labels) or no rows fails. When a claim was removed
  and the answer still states that claim (for the CEO, words such as "chief executive" or "led by") without the old
  value, its rule label is ambiguous, since token presence cannot tell a correct non-answer from a wrong replacement;
  for the CEO that needs a capitalised name after the phrase, so "no chief executive is named" stays correct.
  Agreement is also reported per model under test.
- **Outcomes.** A provider's structured refusal or content-filter finish reason counts as a safety stop, read from
  gbrain's gateway result, since gbrain's question adapter keeps only the length signal. A refused connection is a
  provider error, not a safety stop. A question gbrain blocks for a setup reason (no key, consent, worker or gbrain's
  own spend limit), or one another model answered, is a harness error, never a scored answer, and a paid launch
  refuses unless every model and judge has its provider key. Each row records `answer_model` from gbrain's gateway
  usage record, which names the model gbrain requested (`provider:modelId`), not the id the provider served, so the
  wrong-model check catches gbrain routing a call to another model; a dated snapshot of the model under test (an id
  that begins with its bare id) counts as that model.
- **Runs and receipts.** A run with a unit still owed its retry is incomplete and unpublishable. A torn final
  checkpoint line is cut off and the run resumes. Each stage writes `receipt.<stage>.json`, so the judge-check stage no
  longer replaces the pilot's receipt, and a launch refuses an output directory that holds another stage's seeds; a
  receipt sums the spend of every process that asked a unit behind its rows, never another stage's; the preflight
  estimates only the units still to ask and prices the judge at its worst case until graded rows under the same
  checkpoint key measure it.
  Provider failure text and judge errors are kept with keys and credentials redacted.
- **Keyless arm.** A gbrain error partway through a change keeps the question's row, marked, records none of its
  sentences, leaves it out of every rate and fails exact conformance; a failed presence check voids the seed.
- **Analysis.** The receipts compute the intervals and tests this plan registers (cluster bootstrap over questions,
  McNemar, Holm, the paired non-inferiority interval, every interval resampling whole questions); the sentence-level
  Wilson interval is exploratory only.

### 2026-11-24: stale probes for the judge check, after the judge-check stage

Made after the pilot and judge-check stages (seeds 21 to 23) and before any counted unit. It changes how the judge
check is measured. It changes no arm, seed, metric, model, judge, bar or threshold: each judge still needs at least
100 labelled outputs and Cohen's kappa of at least 0.6, `gpt-6.2-astra` still grades the `claude-opus-5-5` and
particle-1 rows, `claude-opus-5-5` still grades the `gpt-6.2-sol` rows, and particle-1 judges nothing.

**What happened.** The judge-check stage completed with every question scored, no harness error and no model over the
truncation bar, and its judge check failed. Nearly every answer was correct, so the rule labels held almost no
negatives, and kappa can't measure agreement without them. `claude-opus-5-5` agreed with the rule on 143 of its 144
labelled outputs, with no rule negative among them. The one disagreement is a `gpt-6.2-sol` refreshed answer that
correctly left out a removed chief executive, which the judge labelled missing although its prompt calls that correct.
The judge was wrong there. With no negatives, its kappa was 0, below the bar. `gpt-6.2-astra` reached kappa 1 on 248
outputs, but only one of them was a rule negative. Any judge, including a perfect one, gets an undefined or near-zero
kappa on rows like these, so replacing the judge would not fix the check.

**The change.** The judge check adds labelled negatives, called stale probes. For each judge-check row whose change
altered a claim (five of the eight change classes, so 135 of the 216 rows), the row's first answer is judged again by
the row's own judge. The judge uses the frozen prompt and the answer key from after the change, the same key format a
refreshed answer is graded against. No model under test is asked anything, and only judges are called. The rule label
comes from the same rule as before: an answer that still states a changed claim's old value is labelled stale, and an
answer that names a removed holder is labelled stale.

**Why these are valid agreement items.** These negatives are first answers, not refreshed ones. A first answer was
written before the change, so it normally states the old value of every changed claim. One judge-check first answer
does not match by token: particle-1 wrote the old chief executive's name with a Cyrillic letter, so its rule label is
missing and its probe's is correct. That probe is a rule error and stays in the set as it is. The judge sees an answer and a key, with
nothing that says when the answer was written. To the judge, a stale probe looks exactly like a refreshed answer that
kept the old value, which is the failure this experiment exists to catch. Because the claim values are unique
synthetic tokens, the stale rule label rests on token presence alone (old value present, new value absent). It is not
a model label.

The probes don't cover everything. They test whether the judge recognises a stale value, and they don't test the
"wrong" label (a third value). They are probably easier than the hardest natural disagreements. A row whose change
altered no claim gets no probe, because against an unchanged key its probe would repeat the first answer's own judge
item. An answer whose rule label is ambiguous is left out, as before, and is not sent to the judge.

**What counts.** Each judge's kappa is computed over its judge-check outputs and its stale probes together, and every
existing output stays in the set, including `claude-opus-5-5`'s missed removed-CEO answer. Agreement is also
reported for the probes alone and per model under test.

**Enforcement.**

- `--stage stale-probes --judge-check <receipt.judge-check.json>` judges the probes once and writes
  `receipt.stale-probes.json`.
- That receipt names the judge-check receipt by its sha256.
- A directory where a stale-probes run has already started is refused, so the probes can't be paid for twice by
  accident.
- A counted launch needs both receipts (`--judge-check` and `--stale-probes`). It recomputes the judge check from
  both, and it checks two things:
  - every probe is its row's first answer, judged by that row's judge against the key from after the change;
  - every stored rule label in the judge-check receipt equals the one the runner computes from the regenerated worlds.

The judge-check receipt was written by the runner source from before this change (sha256 `209ca793…`). That one
earlier source is accepted, because the code changed after it only to add the probes, and the rule-label recomputation
shows that its grading is unchanged.

If a judge still fails with the probes, no counted unit runs until a further dated amendment decides what to do.

### 2026-11-24: rescore under a rule for answers that give both values, after the counted run

**We wrote this rule after the counted run's results were published (gbrain-evals#639) and after we had read its
labels.** It doesn't change any published number. The preregistered numbers stay primary and every decision in this
plan still reads them. The rescore adds one column beside them. It changes no arm, seed, model, judge, metric, bar or
threshold.

**What happened.** The frozen judge prompt labels a claim correct when the answer "states the key's current value ...
and does not also give a different value as current", and wrong when it "gives the current value and a conflicting
value together". It doesn't say what to do with an answer that names both values and says which one is current, such
as "builds its valves in Y, having moved production there from X". In the counted run, 141 of the 720 refreshed
answers named both a changed claim's old and new values. That is a city after a contradiction in 112 of them and a
founding year after a fact was superseded in 29. Their rule label is ambiguous, so they were left out of the judge
check, and the judges split on them. `gpt-6.2-astra` called the city or year correct in 71 of the 135 answers it
judged from `claude-opus-5-5` and particle-1, and wrong in 64. `claude-opus-5-5` called all 6 of its `gpt-6.2-sol`
answers correct. Reading them, the split mostly follows one line: whether the answer says, in its own words, which
value is current, or only reports what each source says.

**The rule.** A claim is correct only if the answer, in its own words, gives the current value as current. It may name
the previous value, but only as former or superseded ("moved there from X", "previously X", "X is out of date"). An
ordering it hedges, such as "which the note appears to supersede", still says which value is current. A claim is wrong
when the answer names both values without saying which is current. Reporting what each source says ("a press note says
Y; the company page still says X"), even with words like "later" or "still", doesn't say which is current, and
neither does saying it's unclear. An answer that keeps the old value as current is stale, as before.

Two worked examples, both phrasings that appear in counted answers:

- **Wrong: sources only.** "A press note says Trobe moved all production of its bicycles to Brastirford and builds
  bicycles there from this month. The Trobe company page still states that Trobe builds bicycles in Reinorford." The
  answer reports two sources and never says, in its own words, which city is current. "Still" describes the page, not
  the company.
- **Correct: hedged ordering.** "A press note says Sanond moved all production of its turbines to Stopaiford ... The
  Sanond company page still says Sanond builds turbines in Rusexford, which the press note appears to supersede." The
  answer itself says the new city replaces the old one. The hedge ("appears to") doesn't undo that ordering.

The rescore prompt is the frozen prompt with only its "correct" and "wrong" lines replaced by these words
(`PINNED_QUESTIONS_RESCORE_PROMPT` in `eval/runner/pinned-questions-rescore.ts`).

**The agreement gate.** A new prompt is a new judge, so it is checked before it grades any counted answer:

- **Both-value set.** 144 answers on the judge-check seeds (21 to 23). Every company whose change moved its city (27)
  or its founding year (9) gets four answers. Each answer states the other claims' current values and gives both
  values of the changed claim, using templates. Two of the four are correct under the rule and two are not: no
  ordering, "unclear", both given as current, or the old value kept. The labels come from the templates, not from a
  model. We wrote the templates after reading real counted answers, so they copy phrasings that appeared there, and
  they may be easier than real answers.
- **Recheck.** Every judge-check output and stale probe with an unambiguous rule label (527) is graded again by its own
  judge with the new prompt, against its rule label, so the new wording can't quietly break what the old prompt got
  right.
- **Bar.** Both judges grade every both-value answer. Each judge needs Cohen's kappa of at least 0.6 on at least 100
  labels, on each set separately. If either judge fails either set, no counted answer is re-judged, and the
  correction reports the failed gate instead of a rescored column.

**What is re-judged.** All 720 counted refreshed answers, because every counted refresh published and was scored.
Each goes to the judge that graded it (`gpt-6.2-astra` for the `claude-opus-5-5` and particle-1 rows,
`claude-opus-5-5` for the `gpt-6.2-sol` rows), so no judge grades its own family, and particle-1 judges nothing. No
model under test is asked anything. A row the counted run scored as not published or left out keeps that result; none
is in this run. The receipt reports, per model and per change class, the preregistered and rescored correctness side
by side, the answers that flipped each way, and the paired comparisons against `claude-opus-5-5` under both labelings.

**How it's published.** One correction PR adds the rescored column beside the preregistered numbers on the results
page and replaces nothing. If the rescored column would come out on the other side of a decision in this plan, the
page says so in plain words, and that decision goes back to its owner instead of changing on its own.

**Enforcement.** `eval/runner/pinned-questions-rescore.ts` reads the three published receipts (counted, judge-check,
stale probes) only when each matches the sha256 recorded in `docs/benchmarks/pinned-questions/manifest.json`, and
only when it is paid, completed and publishable, on the same gbrain build, with every world regenerating to its
fingerprint and every row judged by its family's judge. It runs the gate first and stops before the counted answers if
the gate fails. Every graded call is written to a journal as it comes in. A directory where a rescore has started is
refused unless `--resume` is passed. A resume asks only the calls the journal doesn't hold, or whose judge call
failed, so a crash or the budget ledger's cap pauses the stage instead of ending it. The receipt sums the spend of
every process behind it. A test ties the three sha256 values in the runner to the manifest. The stage runs as one
judge-only paid window under the eval budget ledger, and amounts stay in the tracking issue.

The gate has limits. Its labels come from templates and token rules, and the recheck items never name both values,
so it can't show that a judge applies the rule to the real counted answers that name both. The correction reports the
flips on those 141 answers apart from the flips on the other 579, where a flip is judge noise rather than the rule.
It also reports agreement per template, including the two a careful reader could dispute: the hedged ordering labelled
correct, and "a later note says" labelled not correct. Nine of the 27 city companies changed by an edit to the
company page, where no counted answer named both values, so the set is not shaped exactly like the counted answers.

Before this stage, the five runner notes from the results PR were fixed, each with a keyless test that fails without
the fix:

- counted seeds run only in the counted stage;
- a counted launch needs a publishable stale-probes receipt in which every probe with an unambiguous rule label carries
  the judge's labels;
- a paid process records its ledger link before it asks anything, so a receipt with unrecorded spend is not
  publishable;
- a unit with a harness error is never reused;
- the keyless runner restores the brain after a gbrain error that follows a change.

## Disclosures

- gbrain is Garry Tan's own project.
- Disclosure: Y Combinator, which Garry Tan runs, is an investor in Particle, which makes particle-1.
- Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator.
  Garry Tan runs Y Combinator.
