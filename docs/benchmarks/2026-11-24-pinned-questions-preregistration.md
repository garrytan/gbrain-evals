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
  3 per change class. Counted seeds 11 to 20 (240 questions, 960 answer sentences per arm). Pilot seed 21. The
  receipt records each seed's ledger fingerprint.
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
reported separately. Two settings differ from the product default and are recorded in the receipt: pin and refresh
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
correct. **P (secondary):** correctness by change class and by refresh mode, first-answer
correctness, and cost per correct answer from the ledger's usage fields.

## Decision rule

- **K:** descriptive per class. The counted baseline supports a failure-mode claim only when the class's 95% interval
  excludes the opposite (for example a false-flag rate whose lower bound is above 10%).
- **K, fix build:** paired by sentence and by question against the baseline on the same seeds; the fix is confirmed
  when spillover falls to zero, contradiction-in-an-existing-note correction within 6 days rises to at least 90%, and
  recall on edits, supersessions and deletions does not fall (McNemar, two-sided 0.05).
- **P:** two primary comparisons, each paired by question against `claude-opus-5-5`: particle-1 and gpt-6.2-sol,
  Holm-corrected at 0.05. particle-1 is non-inferior when the lower bound of the paired 95% interval of
  (particle-1 minus Opus) is above -10 points. Smallest detectable difference: about 8 points at 80% power with 240
  paired questions and 20% discordance. A smaller difference is reported as "no measurable difference at this sample
  size", never as equal.

## What each outcome changes

| Measurement | If it shows the problem | If it doesn't | If inconclusive |
|---|---|---|---|
| K: spillover and missed signals (the dev finding) | GBRA-108 ships the scheduling fix it has accepted; we rerun K on that release | We withdraw the fix request and correct the handoff | Rerun K with 20 seeds before asking GBRA-108 to change anything |
| K: false-flag rate on unrelated edits to cited pages | The paragraph-level evidence design note goes to GBRA-108 as a plan to build | We close the design note | The note stays parked |
| P: particle-1 non-inferior to Opus | We ask GBRA-108 to document particle-1 as the low-cost choice for `models.standing_questions` | We document that refreshes should stay on the deep tier | We say no measurable difference at this size and recommend nothing |
| P: Opus correctness after a contradiction at least 15 points below after a direct edit | Design note to GBRA-108: recompute in full when new in-scope evidence arrives, instead of editing the old answer | No change | No change |

## Pilot per arm

- **K:** none needed beyond the dev runs: it is keyless, and the dev seeds already showed the part under test ran (every
  claim answered at pin, zero baseline flags, deletions flagged on the first read).
- **P:** seed 21, all three models, 24 questions each: 72 pins and 72 refreshes, at most a tenth of P's budget. It
  must show, on each model's own outputs, that refresh ran through gbrain's gateway with that model (the receipt's
  `answer_model` and the ledger's request rows), that every question could be pinned and refreshed, and that the judges
  pass the check below on these outputs. A model that fails is fixed or left out and reported as left out.

## Judge check

Two judges: `gpt-6.2-astra` grades `claude-opus-5-5` and particle-1 rows, `claude-opus-5-5` grades `gpt-6.2-sol`
rows. No judge grades its own family, and particle-1 never judges. Each judge is checked on all 144 pilot outputs (72
first answers and 72 refreshed answers), at least 100 labelled outputs, before any counted unit runs. Labels: the claim
values are unique synthetic tokens, so each output gets a rule label (new value present and old value absent is
correct; old present and new absent is stale; neither is missing); an output whose rule label is ambiguous (both values present) is left out of
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

## Disclosures

- gbrain is Garry Tan's own project.
- Disclosure: Y Combinator, which Garry Tan runs, is an investor in Particle, which makes particle-1.
- Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator.
  Garry Tan runs Y Combinator.
