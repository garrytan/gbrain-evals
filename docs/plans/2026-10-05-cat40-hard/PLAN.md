<!-- /autoplan restore point: "/home/user/.gstack/projects/garrytan-gbrain-evals/plan-cat40-hard-autoplan-restore-20261005-003735.md" -->
## Implementation plan
# Cat 40 Hard: tasks that measure the edge of frontier models

Status: draft for autoplan, 2026-10-05.
Context: the Cat 40 Model Ladder (`docs/benchmarks/2026-10-02-model-ladder.md`), the entity-recall wave
(`docs/plans/2026-10-04-cat40-entity-recall/PLAN.md`) and the model-selection rules in `CLAUDE.md` ("Choose models").

## Why

Cat 40 no longer separates the models people use most. On the development world, 2026-10-04, with five frontier
models, gbrain master finished 239 of 250 runs (95.6%):

| Model | Tasks finished (of 50) |
|---|---|
| GPT-6 Astra | 50 |
| Fable 5.1 | 49 |
| GPT-6.1 Sol | 49 |
| Opus 5.5 | 46 |
| Sonnet 5.5 | 45 |

GPT-6.1 Sol also scored 100% on every arm of the held-out world, and the oracle arm scores about 98%. At that ceiling
Cat 40 can still measure cost and leaks, but not whether a memory system raises what a frontier agent can do. The
next gbrain decisions need that answer: whether entity recall, typed fields or deeper retrieval help these models.

Difficulty has to come from the memory problem, not from puzzles. A harder reasoning question makes every arm fail
the same way, which measures the model, not the memory. Difficulty should come from what real company brains get
worse at as they grow.

## Goals

- **G1.** A new Cat 40 tier, "Hard", where the best simple arm (plain files with grep) finishes 40–70% of tasks on
  each frontier model (Sonnet 5.5, Opus 5.5, Fable 5.1, GPT-6.1 Sol, GPT-6 Astra). The oracle arm stays at 90% or
  above, which proves the tasks are answerable from the evidence.
- **G2.** A preregistered, held-out measurement of gbrain (current master) against the simple arms on Hard. It runs at
  two scales, about 4,000 and about 50,000 documents, with paired per-task CIs per model and pooled.
- **G3.** The existing Cat 40 tasks, worlds, scoring and baselines don't change. Hard is a new generator mode and a
  new registry row.

Non-goals: no change to gbrain in this plan (fixes come after the measurement), no puzzle-style difficulty, no
human-written tasks.

## The Hard tier

The ledger-first generator (`eval/generators/model-ladder-gen.ts`) gains a `hard` mode with new task families. The
answer key is computed from the ledger, never from reading the prose, as it is today.

- **H1. Many-record questions.** For example, "Which accounts have an open escalated ticket and a renewal in the next
  60 days?" or "How many accounts did Rania own on 2026-07-01?". The answer is a set or a count over 10–40 records.
  Scoring is exact set match, with partial credit reported but not counted as success.
- **H2. Long histories.** An attribute changes 3–6 times, with reversals, backdated corrections and effective dates
  that differ from when the change was written. Questions are asked as of a date. Distractors include notes that
  summarize an intermediate state.
- **H3. Look-alike entities.** Customers that share a first word or a code prefix, renamed accounts, and a merged
  account that keeps both names. Questions mention only the ambiguous name plus one disambiguating fact that has to
  be looked up.
- **H4. Conflicting sources by authority.** A signed contract beats an amendment draft, which beats an email
  summary, which beats an agent note. Conflicts span 3–5 documents, and some authoritative sources are long
  transcripts where the deciding line sits mid-document.
- **H5. Memory across many sessions.** Five sessions. Later sessions depend on corrections and decisions saved in
  earlier ones. Some saved facts are later superseded inside the session chain.
- **H6. Tight budgets.** Every Hard task gets 8 turns instead of 16, so an agent can't brute-force by reading
  everything.

The Hard world also has more noise: more emails per account, long transcripts, and agent notes that are confidently
wrong.

## Difficulty calibration (paid, small)

1. **Calibration world.** A dev seed for the 4k Hard world. Run 10 tasks per family on fs and oracle with Sonnet 5.5
   and GPT-6 Astra, one repeat, at about $40.
2. **Tuning.** Adjust only generator knobs (record counts, history length, distractor rate, turn cap) until fs lands
   in 40–70% and oracle at 90% or above. Record every knob change and its result in `docs/benchmarks/cat40-hard/
   calibration.md`. No task is hand-edited.
3. **Freeze.** Freeze the generator, then generate new held-out seeds for both scales. Nobody opens them before
   the runs finish.

## Measurement (paid)

- **Arms:** oracle, fs, pg, memory and gbrain (current master), uncapped, on the fixed harness with the SQLite ledger.
  fs-acl doesn't apply, because Hard has no permissions family.
- **Models:** the five frontier models above, plus any newer frontier Opus, GPT, Sonnet or Fable released before the
  run. Two repeats.
- **Scales:** the 4k Hard held-out world and the 50k Hard held-out world. The 50k world uses the staged build that
  already exists.
- **Preregistration:** comparator choice (the best pooled simple arm), the decision sentences, analysis commands and
  argv. It is committed before any held-out cell runs.
- **Estimated cost at the rates measured on 2026-10-04:**
  - calibration, about $40
  - 4k held-out, about $350
  - 50k held-out (gbrain and fs only, with oracle on a 20% sample), about $300
  - total about $700, which needs a budget decision from Garry, since about $500 will remain after the
    entity-recall wave

## Deliverables

- The generator `hard` mode and its tests: deterministic seeds, answer keys, and hermetic tests of each family's
  ledger logic.
- A registry row `model-ladder-hard`, tier P, report-only.
- The calibration record, the preregistration, and results with receipts, transcripts and the report section.
- One gbrain-evals PR.

## Risks

- **Too hard for every arm.** If the oracle drops below 90%, the tasks are unanswerable or badly worded.
  Calibration catches this before money is spent on held-out runs.
- **Difficulty that rewards a particular tool.** Families are designed from what grows with brain size and mess, and
  no family assumes gbrain features. The report states which families favor which arm.
- **Cost.** Frontier models at 8 turns over long documents cost about $0.25–0.50 per cell. Each run has its own
  ledger budget.
## Review record
