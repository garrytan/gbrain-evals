# Reading notes before answering: matched gains, with grading and output-limit caveats

Published 2026-09-25. The study was frozen and run on 2026-09-24.
GBrain is a Markdown-first agent memory system. This experiment concerns how
an answer model reads already retrieved conversations, not how GBrain finds
them. [LongMemEval](https://arxiv.org/abs/2410.10813v2) tests whether an
assistant can answer questions about old conversations; its section 5.5 tests
extracting brief notes before an answer, using the original supporting
conversations rather than a lossy replacement summary.

**Keeping the evidence intact and asking for notes helped in both completed
comparisons.** We reproduced the paper's positive reading effect and measured
a smaller positive transfer to the existing GBrain reader. Source inspection
confirms real improvements, but grading artifacts and nine truncated GBrain
responses mean the historical result alone does not establish a production
default. A later, separately approved reader release defaults to notes with
a larger output limit; its selected-case completion smoke is reported below.

Both frozen experiments completed: 361 fresh GBrain comparisons and all 500
questions in the four-condition paper replication. The frozen protocol and
identities are below. Neither this experiment nor the earlier
[failed excerpt selector](https://github.com/garrytan/gbrain/blob/f69ff98fe2e365251dd88e46ab292dc9c2d463db/docs/eval/ANSWER_PACKET_RESULTS.md)
changed retrieval or production settings. The failed method removed some
evidence before reading; this one preserves it.

The [public paired-label receipt](2026-09-25-reading-notes/reading-notes-transfer.ndjson) contains all
361 original comparisons, 12 baseline repeats and 28 repeat-graded
discordances, without conversation or answer text. Its SHA-256 is
`fe54ecf5193aab80005d330fa9173961f6c62da31b374e3a75159fa2fa296a9d`.

## Experiment and reproduction boundary

The protocol and cohorts were frozen on 2026-09-24 at 21:01:05.530 UTC,
before the first follow-up call at 21:01:20.585 UTC. The transfer cohort
selected one question per fresh evidence group after excluding prior
development/holdout groups, the `dev40` split and shared supporting sessions
with the previous excerpt experiment. Seven questions ask for information
not available in the recorded evidence (abstentions). Of 361 questions,
345 had every labeled supporting session ID in the fixed retrieval and 16
did not. Both arms saw the same retrieved full sessions, same order, question,
date and untrusted-data framing. The Sonnet 4.6 direct answer reader's only
changed instruction was:

> First extract all the relevant information, then reason over the information
> to get the answer. Keep the notes brief and end with a concise final answer.

It replaced “Answer concisely with only the information needed to answer the
question.” Both arms used provider-default temperature and a 512-token output
limit. The complete response, notes included, was graded by the existing
GBrain data-boundary judge with `gpt-4o-2024-08-06`, a 16-token judge limit,
and no retry/fallback or second retrieval.

The oracle phase used the
[upstream LongMemEval code at `9e0b455f`](https://github.com/xiaowu0162/LongMemEval/tree/9e0b455f4ef0e2ab8f2e582289761153549043fc),
the published 500-question supporting-sessions-only corpus, and its original
`prepare_prompt` and `get_anscheck_prompt` functions. Supporting sessions
were sorted chronologically with both speakers and no `has_answer` labels.
Direct versus extract-and-reason (`--cot true`, *not* `--con true`) was crossed
with natural-language versus JSON history presentation. Reader and official
grader both used pinned `gpt-4o-2024-08-06` at temperature zero, with limits
of 800 and 10 output tokens respectively. The official lowercase
`yes`-substring rule graded the oracle responses. The published Figure 6
numbers are historical context, not outputs from these exact requests.

These corpora share question IDs, text, answers and types, but **all 500
question dates differ** and all 948 matched supporting-session dates differ;
the role/content turns match after ignoring gold annotations. We retained
each phase's own dates. The full oracle cohort overlaps the transfer sample,
so the two phases are not independent datasets and raw percentages cannot
be compared across their different readers and conditions. Primary contrasts
were predeclared: notes versus intact direct reading for transfer, and JSON
notes versus natural-language direct for the paper replication. Twelve
predetermined identical-prompt baseline repeats per phase and regrading both
saved responses for every primary discordance checked variability without
changing original scores. Paired 95% bootstrap intervals measure question
sampling only, not grader correctness or generation variance.

The private frozen manifest hashes to
`510a3eab1e6f3889b9732755a2c53c724f38745a8fef0744e34216cee78ae398`,
prepared requests to `621745fe5e8ea21b80bfd1277c0fb4eaf9fcdd3a54d4f702486798b934a420c8`,
the published oracle JSON to `821a2034d219ab45846873dd14c14f12cfe7776e73527a483f9dac095d38620c`,
the historical LongMemEval-S question corpus to
`d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`,
and the fixed retrieved-session receipt to
`65ffeaa8299586e5a1dd6a9e10f269bab33462ab5470a95e329fbf189a703140`.
The pinned upstream generation and grading source files hash to
`4f1eb3c69d7ad40f04065b9c0bc86f6582441018fc6ff751d162d66c95baf672`
and `ecce9c4c79dc89d99534ac17b383a5cbb5b9f0c69ee98adaf0684742e3d95251`.
The historical LongMemEval reader was GBrain commit `c8423e4`; its original
orchestration was private and used machine-absolute paths. This repository
keeps its existing `gbrain` dependency at
[`939232f`](https://github.com/garrytan/gbrain/tree/939232f1746381b4e932d620d6c709e29198f14c)
for the older benchmark runners and `gbrain` CLI. Only this new request/run
path imports the separately pinned `gbrain-reader` alias (currently
[`a9de062`](https://github.com/garrytan/gbrain/tree/a9de0624bd836d4c5ad64ea72526567e1529458a),
GBrain v0.59.0.0). The latter is a post-study reader release, not the code
that produced the original labels. Both aliases are distinct Git installs;
the alias's bundled `postgres@3.4.9` patch is mirrored at the repository
root because Bun resolves that transitive patch path there (SHA-256
`fc437766abb36d0bf78cd706acbd42c72e3421aa8dbaa84a643d105bf673ba9f`,
identical to the alias checkout's patch). Passing the
legacy suite does not validate the new reader globally.

From the repository root, `bun eval/runner/reading-notes-recount.ts` rechecks
all public label pairs, repeats and regrades without keys, network or paid
calls. `bun test test/eval/reading-notes-recount.test.ts` additionally
reprices aggregated token counts from the
[cost receipt](2026-09-25-reading-notes/cost-provenance.json). The raw requests,
responses, conversations and private per-call ledger are deliberately not
published, so neither command regenerates answers or independently audits
every usage event. The cost receipt pins the private journal hash and exposes
phase/model/role token aggregates plus the two primary reader arms; its
earlier failed-pilot cost is a declared
aggregate, not a per-call recount. Running an actual new comparison requires
the original LongMemEval inputs, explicit paid authorization, the relevant
provider keys, fresh request/response accounting and a new dated report.

An offline request-preparation command exercises the companion GBrain reader
seam without running a paid experiment:

```sh
bun eval/runner/reading-notes-requests.ts \
  --input <private-frozen-cases.json> \
  --output eval/reports/reading-notes/paired-requests.json \
  --model anthropic:claude-sonnet-4-6 --max-tokens 1024
```

The input is an array of `{ question_id, question, question_date?, sources }`,
where each ordered source has `{ session_id, slug, date?, body }`. It must be
an already-frozen retrieval, not a new search. The preparer calls GBrain's
actual `generateAnswer` evidence and sanitizer path for both modes, rejects
duplicate source IDs or any session cut by its 60,000-character safety cap,
preserves the source/question dates exactly as supplied, and asserts identical
user messages. The output contains both direct and
notes requests, the installed alias reader
and package hashes, declared alias pin, input hash, and prompt/config
hashes. It is private and ignored by Git. Preparation has no provider calls.
For an **explicitly authorized new run only**, use the separate capped lane:

```sh
bun eval/runner/reading-notes-run.ts --execute \
  --input <same-private-frozen-cases.json> \
  --requests eval/reports/reading-notes/paired-requests.json \
  --journal eval/reports/reading-notes/new-run.ndjson \
  --max-usd <approved-positive-cap> --approval-id <authorization-reference>
```

This needs `ANTHROPIC_API_KEY`. It uses GBrain's gateway, with a guarded
single physical attempt per request, a pre-admission worst-case reserve,
usage-priced settlement and an append-only private journal. Invalid or
unaccounted calls halt the run and remain recorded; a known valid usage
report over the request bounds is still priced, then rejected. Any returned
empty, refused or wrong-model response is retained privately as unaccepted
evidence before the run halts. A bounded `length` finish is an accepted
transport response and a reported cutoff, not a naturally completed answer;
the other arm continues. Failures remain in the planned denominator and
never become passing answers or trigger a silent retry. The returned report compares
natural finishes, cutoffs and reader spend, **not answer correctness**. The
runner regenerates the plan from the same frozen source bytes and rejects
source, request or installed-code drift before a provider admission.
Original conversation, request and generated answer text stay in ignored
`eval/reports/`; a new answer-accuracy claim needs independently graded
labels, an audited scorer and a dated report. Use equal 1,024-token
limits to compare the packaged modes. An explicit `direct` mode with its
historical 512-token limit reproduces the *prompt/limit*, not the original
stochastic answers, and is not an equal-limit packaged comparison.

## Published reading experiment: effect reproduced

Using only the published oracle supporting sessions, the authors' original
prompt builder and grader, and the pinned GPT-4o snapshot:

| Format and reading method | Published Figure 6 | This run | Correct / 500 |
|---|---:|---:|---:|
| Natural language, direct | 86.2% | 84.8% | 424 |
| JSON, direct | 82.2% | 85.0% | 425 |
| Natural language, notes | 91.0% | 92.2% | 461 |
| JSON, notes | 92.4% | 92.6% | 463 |

The primary combined contrast improved by **7.8 percentage points**, with
**49 judged wins and 10 losses**. Its paired 95% bootstrap interval was
**[+5.0, +10.8] percentage points**. This reproduces the direction and rough
size of the published effect, not every historical percentage or completion.

The factorial controls matter more than the best single cell:

| Matched contrast | Net answers | Difference | Paired 95% interval |
|---|---:|---:|---:|
| Notes versus direct, natural language | +37 | +7.4 points | [+4.4, +10.6] |
| Notes versus direct, JSON | +38 | +7.6 points | [+4.8, +10.4] |
| JSON versus natural language, direct | +1 | +0.2 points | [-1.4, +1.8] |
| JSON versus natural language, notes | +2 | +0.4 points | [-1.8, +2.6] |

**Notes helped in both formats; JSON alone did not demonstrate a benefit.**
There is no evidence here that GBrain needs a new JSON memory representation.
All intervals describe question sampling, not grader validity or generation
variability. The corpora and readers differ across phases, and the full
oracle set overlaps the fresh transfer cohort; these are not two independent
confirmation datasets.

All 2,000 primary oracle responses finished without hitting the 800-token
output limit. Regrading the 59 primary discordances changed **0/118 labels**.
The 12 identical-prompt baseline controls went **10/12 → 9/12**; nine outputs
were byte-identical, and the score-changing case had different output text.
Stable repeat grading still does not establish factual correctness.

The [oracle paired-label receipt](2026-09-25-reading-notes/reading-notes-oracle.ndjson) records all four
grades on every question, plus controls and repeat grading. Its SHA-256 is
`f411f222d003f71240d8fcccc6c1677baad67971dba9618a8789797bc0e70cb3`.

### Every initial oracle regression

The following observations retain all original labels. They distinguish real
reasoning problems from reference/rubric ambiguity, rather than discarding
unfavorable rows.

| Question ID | Source-aware observation |
|---|---|
| `c8090214_abs` | Notes assume an unmentioned tablet purchase occurred alongside a recorded phone purchase, then fabricate the requested interval. The baseline correctly says the date is unavailable. |
| `9a707b81` | Notes use the session date instead of “yesterday” and answer 20 rather than 21 days. That is an actual one-day reasoning error, but rejecting it conflicts with the official grader's stated off-by-one tolerance. |
| `00ca467f` | Notes add a physical-therapy visit to the count of doctor appointments. This changes the category rather than finding an omitted doctor appointment. |
| `ec81a493` | Both answers contain 500, but the source's limited-edition object is a poster, while the question asks about album copies. Notes expose that distinction and still infer the album count. This is a source/reference ambiguity, not a clean numeric regression. |
| `71017277` | The source names a chandelier, not jewelry. Notes reject the question's premise; the baseline gives the reference relative while describing the chandelier. A lower benchmark score does not establish a worse source-grounded answer. |
| `8077ef71` | Notes make a one-day calendar arithmetic error, 25 instead of 26. As with `9a707b81`, the negative grade is inconsistent with the stated off-by-one tolerance. |
| `gpt4_7bc6cf22` | Notes answer the interval between publication and reading, rather than between reading and the question date. This is a genuine wrong-interval failure. |
| `d24813b1` | Notes omit the previously successful cake that anchors the personalization rubric; the baseline includes a related option. Rubric sensitivity limits a binary interpretation. |
| `gpt4_15e38248` | Notes infer a recent sofa purchase merely from interest in matching cushions, inflating the count from four to five. |
| `46a3abf7` | Notes stop counting an older tank without evidence that it was disposed of. The reference retains all three tanks; “old” versus “currently have” leaves a wording caveat. |

Concrete oracle gains include recovering the two purchases totaling $300,
applying the update from 37 to 38 coins, using the correct audiobook start
date to total eight rather than nine weeks, and explicitly distinguishing
tennis from table tennis in `f685340e_abs`. That last case is a real oracle
improvement but a false-positive transfer grade: a shared question ID does
not make outputs from different reader conditions equivalent.

Not every oracle win is equally convincing. In `a2f3aa27`, both outputs say
the count is near 1,300, yet only notes receive credit; that is not a verified
information gain. In `37f165cf`, the page counts fit the reference, but notes
assign unrecorded completion months to the books. In `gpt4_d9af6064`, notes
treat a device-acquisition date as its setup date. The latter inference is
plausible, but not explicitly established. These findings remain caveats,
not a post-hoc replacement score.

## Completed GBrain comparison

| Metric | Full-session baseline | Same sessions, notes first |
|---|---:|---:|
| Judged correct | 308 / 361 (85.3%) | 324 / 361 (89.8%) |
| Answerable questions | 302 / 354 | 317 / 354 |
| Abstention questions, automated labels only | 6 / 7 | 7 / 7 |
| Output-limit finishes | 0 | 9 |
| Mean output tokens | 87.3 | 244.0 |
| Reader-only usage-priced cost | $17.220423 | $18.086391 |

There were **22 judged improvements and six judged regressions**, a net gain
of 16 answers, or **4.4 percentage points**. Both arms were right on 302
questions and wrong on 31. The paired 95% bootstrap interval was
**[+1.7, +7.2] percentage points**. It describes question-sampling uncertainty,
not reader/judge variability or the reliability of the reference answers.

The predeclared quantitative transfer gate passes under the original grader:
the interval is positive and the abstention score does not decrease. That is
not a production-readiness gate. In particular, the apparent abstention gain
is a grading artifact described below, not a verified improvement in refusal.

| Category, including abstention variants | Questions | Baseline correct | Notes correct | Net |
|---|---:|---:|---:|---:|
| Knowledge update | 52 | 45 | 50 | +5 |
| Multi-session | 96 | 76 | 79 | +3 |
| Single-session assistant | 40 | 40 | 40 | 0 |
| Single-session preference | 20 | 15 | 16 | +1 |
| Single-session user | 49 | 48 | 49 | +1 |
| Temporal reasoning | 104 | 84 | 90 | +6 |

The gain was concentrated where all recorded supporting sessions were
retrieved: **303 → 320 correct out of 345**. The 16 cases with incomplete
gold-session coverage went **5 → 4**. Notes do not repair missing retrieval;
gold-ID coverage also does not prove that every relevant fact is present.

## Concrete improvements checked against original turns

These are source-grounded examples, not just favorable grader votes. Both
arms received the same full source text.

| Question ID | Baseline failure | What notes got right |
|---|---|---|
| `ef9cf60a` | Counted only a $100 gift. | Combined the separately recorded $200 and $100 purchases into $300, excluding a still-planned purchase. |
| `69fee5aa` | Repeated the old count of 37 coins. | Applied the later purchase: 37 + 1 = 38. |
| `a9f6b44c` | Counted three service events as three bikes. | Deduplicated two visits for the same bike, giving two distinct bikes. |
| `d7c942c3` | Used an older paper-list preference. | Used the later explicit switch to the shared list app. |
| `59524333` | Used the earlier 7 p.m. schedule. | Preferred the later explicit 6 p.m. statement. |
| `aae3761f` | Included a suggested future trip in the driving total. | Added the three completed drives: 4 + 5 + 6 = 15 hours. |
| `gpt4_2312f94c` | Compared a preorder date with a purchase date. | Compared actual receipt dates, correctly putting the 20th before the 25th. |

The useful mechanism is visible: retain all the evidence, then reconcile
updates, distinguish plans from completed events, deduplicate entities, and
perform the calculation. This is different from selecting a smaller packet
and hoping the omitted text was irrelevant.
The comparison tests the complete notes instruction, not whether it beats an
equally verbose alternative instruction.

## Grading and variability audit

Rejudging both saved responses for all 28 discordant pairs changed **two of
56 labels**. The repeat grading retained **20 wins and six losses**; two
initial wins became ties. These are selected discordances, not an unbiased
estimate of overall grader accuracy. Initial benchmark labels remain intact.

The 12 predetermined identical-prompt baseline repeats went from **11/12 to
10/12**. Two repeated answers were byte-identical, and one score flipped.
These small controls demonstrate variability; they do not justify subtracting
a guessed noise allowance from the primary result.

Source inspection exposes limitations that repeat grading alone missed:

- `f685340e_abs`: both answers conflate tennis with table tennis and give a
  frequency, although the reference requires refusing that substitution.
  The longer notes answer received credit twice. Do **not** call the reported
  7/7 score verified abstention accuracy or this case a genuine win.
- `66f24dbb`: both answers correctly name the same gift. The initial baseline
  rejection disappears on regrade; this was not a reading improvement.
- `4d6b87c8`: both answers ultimately give 27 against a reference of 25.
  The notes answer's initial credit disappears on regrade. Its reasoning
  treats planned additions as completed, so the initial win is not evidence
  of better updating.
- `51c32626`: notes equate a conference deadline with the individual's actual
  submission date. The baseline correctly notices that the latter is not
  explicitly given. Matching the reference here does not establish a safer
  inference.
- `9aaed6a3`: the notes answer notices that “last Thursday” relative to the
  question date is a different day from “last Thursday” in the older source.
  It loses the benchmark point but identifies a genuine date mismatch.
- `81507db6`: the baseline counts a ceremony the source explicitly says was
  missed. Notes exclude it, but lose against the complete-history reference
  because some supporting sessions were not retrieved. This is not a clean
  example of notes destroying an otherwise supported answer.

These observations do not replace the original scores with hand-adjusted
ones. They narrow the claim: there are real improvements, but the automated
22/6 split is not a literal count of verified better/worse answers.

### Every initial judged regression

| Question ID | Source-aware observation |
|---|---|
| `gpt4_483dd43c` | Notes abstain about which show started first, overlooking an explicit 14-day viewing duration. The baseline matches the reference, although its rationale also expresses uncertainty. Season-versus-series wording limits a strong causal interpretation. |
| `afdc33df` | Notes offer fewer, less specific kitchen-maintenance suggestions and end by offering fresh advice instead. The reference is a personalized-advice rubric, so the binary grade is also a subjective boundary. |
| `9aaed6a3` | Notes correctly distinguish the question's “last Thursday” from the older source's Thursday; the fixed reference does not. |
| `gpt4_e05b82a6` | Notes extract an additional ride as at least one, then omit it from the final total of nine rather than ten. Unnecessary uncertainty discards useful evidence already identified. |
| `81507db6` | Notes correctly exclude a missed ceremony. The third attended ceremony is in an unretrieved supporting session; the baseline reaches the reference count by including the wrong event. |
| `6d550036` | Supporting sessions for an academic project are missing, while a non-gold retrieved session contributes work projects. The baseline reaches the reference number using those work projects; notes count three from the mixed context. Matching the number does not demonstrate the expected supporting reasoning. |

## Response quality and cost

Nine notes responses reached the unchanged 512-token limit, versus none for
the baseline. Their IDs are `95228167`, `0a34ad58`, `75832dbd`,
`gpt4_7fce9456`, `gpt4_a1b77f9c`, `gpt4_f420262c`, `06878be2`,
`a89d7624` and `1a1907b4`. Several end mid-sentence. Seven still received
rubric credit, including the property-count improvement whose explanation
contains the answer before its final list is cut off. A correct benchmark
label is not proof of a complete, usable response.

**Conservative cutoff sensitivity, not a replacement score:** If every
512-token output-limit finish is treated as incorrect, including the seven
cutoff answers that originally received credit, the same original labels
would give direct **308/361** versus notes **317/361**, with **21 wins and
12 losses**, a net **+9 answers (+2.493 percentage points)**. This is a
keyless counterfactual on the original receipt, not a new accuracy run or
hand-adjustment of the historical headline. It matters because the newer
reader rejects partial output rather than treating answer text before the
cutoff as a completed response.

A **separate release completion smoke**, not a rerun of the accuracy study,
replayed exactly those nine selected cutoff cases through the companion
GBrain default notes reader and gateway at 1,024 tokens. All nine responses
were nonempty and ended naturally, using at most 603 output tokens. The
[public-safe receipt](2026-09-25-reading-notes/completion-smoke.json) records
IDs, finish reasons, usage and request/journal hashes but no conversation
or answer text. These nine additional calls cost $0.562143, separate from
the $79.1460305 historical study total below. Selection on prior cutoffs
only checks this failure mode; it neither regrades correctness nor estimates
new accuracy or overall cost.

Notes used **2.8 times as many output tokens** and cost **5.03% more for the
reader calls**. The long, unchanged input accounts for most reader spending.
That extra generation is intended work, not evidence of a same-work latency
regression; no latency claim is made here.

| Experiment phase, including its grading and controls | Settled calls | Usage-priced USD |
|---|---:|---:|
| Earlier excerpt pilot | 348 | $8.0127305 |
| GBrain notes transfer | 1,524 | $36.6096000 |
| Full four-condition oracle replication | 4,142 | $34.5237000 |
| **Total** | **6,014** | **$79.1460305** |

All **5,666 follow-up calls** have exactly one admission, known-usage
settlement and accepted response, with no error events. The recorded physical
models are Sonnet 4.6 and the specified GPT-4o snapshot. The operator removed
the spending ceiling before the follow-up began. Prices are pinned canonical
accounting estimates, not provider invoices.

The final follow-up call journal hashes to
`effa6227e63abc1c07342cbd7f8e40f3c9e8cd6903dcfcfcf21e48d4b5b45680`;
the outcome journal hashes to
`1a43f83b4613c729120001e9603709cf20d60cf0c2e8b9f28cae51811dfcbd43`.

## Decision

Pursue intact-evidence reading, not another excerpt selector or a JSON memory
rewrite. The original selector still failed; notes now have positive matched
evidence and concrete source-verified wins. The experiment does not isolate
notes from extra deliberation, prove every automated label, or authorize a
production rollout.

A separate model audited every transfer discordance and cutoff without
inspecting oracle outcomes; its findings were checked against the stored
sources, not treated as replacement labels. A separate pass then audited all
59 oracle discordances. Public scores, repeat grades and source-aware
qualifications are kept separate. At the end of the historical study, the
direct-answer full-session reader remained unchanged. The subsequent GBrain
LongMemEval reader release makes notes the default **after** adding bounded
output handling,
with an explicit direct override; external agents' thinking behavior is not
evaluated or changed by this study. Its initial 1,024-token packaged limit is
not the 512-token treatment measured above. A fresh matched comparison of
both modes at the new limit is needed to measure that release, rather than
calling these inspected historical questions independent confirmation.
