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
  above, which proves the tasks are answerable from the evidence. The calibration freeze rule that operationalizes
  this goal is in the accepted requirements below (provisional, Taste CEO-T1).
- **G2.** A preregistered, held-out measurement of gbrain (current master) against the simple arms on Hard. It runs at
  two scales, about 4,000 and about 50,000 documents, with paired per-task CIs per model and pooled.
- **G3.** The existing Cat 40 tasks, worlds, scoring and baselines don't change. Hard is a new generator mode and a
  new registry row.

Non-goals: no change to gbrain in this plan (fixes come after the measurement), no puzzle-style difficulty, no
human-written tasks.

## The Hard tier

The ledger-first generator (`eval/generators/model-ladder-gen.ts`) gains a `hard` mode with five new task families (H1–H5) and one constraint on all of them (H6). The
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
- **H6. Tight budgets (a constraint on every family, not a family).** Every Hard session starts with 8 turns
  instead of 16 (each H5 session gets the same cap). The cap limits sequential depth: an agent can still issue several
  tool calls in one turn, so the report gives tool calls per task by family. The cap is a calibration knob and is
  frozen with the generator.

The Hard world also has more noise: more emails per account, long transcripts, and agent notes that are confidently
wrong.

## Difficulty calibration (paid, small)

1. **Calibration world.** A dev seed (20261005) for the 4k Hard world, generated at the held-out density of 20 tasks
   per family. Each round samples 10 tasks per family and runs fs, pg and oracle with Sonnet 5.5 and GPT-6 Astra, one
   repeat, at about $10–20 per round.
2. **Tuning.** Adjust only generator knobs (record counts, history length, distractor rate and noise first; the turn
   cap last) until the freeze rule in the accepted requirements passes, as printed by the freeze-rule analyzer. Record every knob change and its result in `docs/benchmarks/cat40-hard/
   calibration.md`. No task is hand-edited.
3. **Freeze.** Freeze the generator, then generate the held-out world from one preregistered seed at both scales.
   The 50k world is the 4k world plus appended distractor accounts and updates that never change a Hard answer key
   (rules in the accepted requirements below), so both scales share the same tasks and the scale effect is paired.
   Nobody opens the held-out worlds before the runs finish.

## Measurement (paid)

- **Arms:** oracle, fs, pg, memory and gbrain (current master), uncapped, on the fixed harness with the SQLite ledger.
  fs-acl doesn't apply, because Hard has no permissions family.
- **Models:** the five frontier models above. A newer frontier Opus, GPT, Sonnet or Fable released before the run
  replaces its predecessor (rules in the accepted requirements below). Tasks per family and repeats are fixed in the
  preregistration.
- **Scales:** the 4k Hard held-out world and the 50k Hard held-out world. gbrain slots for the 50k world use the
  runner's existing staged slot build (`STAGED_SOURCE_ADD_DOCS`).
- **Preregistration:** comparator rule (the best pooled simple arm on the 4k held-out world, chosen from the simple
  arms' results and committed before any gbrain held-out cell runs; fs at 50k), the gbrain commit and config, the
  decision sentences, analysis commands and argv. It is committed before any held-out cell runs.
- **Estimated cost.** Agent cost per cell is taken from the 2026-10-02 held-out world (Sonnet 5.5 and GPT-6.1 Sol),
  scaled by list price for Opus 5.5 (2×), Fable 5.1 (5×) and GPT-6 Astra (5×), and at 52k by 1.8× (fs) and 1.3×
  (gbrain) as measured in the scale tier. Hard's longer content and 5-session H5 tasks add an unmeasured factor,
  shown as a range from 1.0× to 1.8×; calibration replaces it with measured Hard costs. 100 task-repeats per scale:
  - calibration (at most 5 two-model rounds on Sonnet 5.5 and GPT-6 Astra, and at most 2 freeze checks on Opus 5.5,
    Fable 5.1 and GPT-6.1 Sol), $100–175
  - the paid gbrain smoke and slot builds (embeddings), about $35
  - the claims judge (GPT-6.1 Sol on every cell), $25–55, projected separately from calibration's measured prompts
  - 4k held-out, five arms on five models, $570–1,030 (the memory arm on Opus 5.5, Fable 5.1 and GPT-6 Astra is
    $280–510 of it)
  - 50k held-out (gbrain and fs, oracle on the H1 tasks, the only family whose oracle evidence changes at 50k),
    $290–515
  - turn-budget sensitivity check (comparator and gbrain at 16 turns, 4k, Sonnet 5.5 and GPT-6.1 Sol), $25–45
  - total $1,045–1,855 with every arm; $765–1,345 if the memory arm runs only on Sonnet 5.5 and GPT-6.1 Sol; $475–830
    for calibration and the 4k measurement alone, with the 50k step decided after the 4k result. About $500 remains of
    the $3,000 program authorization after the entity-recall wave, so this needs a budget decision from Garry before
    any paid step.

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
- **Cost.** Measured v1 cells range from $0.005 (GPT-6.1 Sol, oracle) to about $1.35 (Fable 5.1, memory, by price
  scaling), and Hard's per-cell cost is unmeasured until calibration. Each run has its own ledger budget, and each paid
  step checks its projection before launch.

## Accepted review requirements

The CEO, DX and Eng reviews added the requirements below. They are part of the plan.

<!-- autoplan-accepted:ceo -->
- **Sequencing (CEO-F2, CEO-F26).** The code may be built now on a branch stacked on `feat/cat40-entity-recall`
  (the generator mode, scorers and hermetic tests touch no pinned file); it lands on `main`, and paid steps start,
  only after the entity-recall wave and PR #63 ("Choose models" in `CLAUDE.md`) merge, so it inherits the Fable 5.1 price, `--gbrain-config`, the
  `holdout_stats` modes, the slot coverage preflight and the model rules. `eval/runner/cat40/score.ts` stays
  byte-identical (hash `8a448051…`, pinned by the entity-recall A3 preregistration); Hard scoring lives in a new
  module that may import `score.ts` helpers unchanged. The v1 and `large` worlds stay byte-identical:
  `bun eval/generators/model-ladder-gen.ts --check` passes and the `model-ladder-v1-large` manifest digest is unchanged.
  Every existing Cat 40 test passes unchanged, and `tsc` passes with any widened shared types.
- **Paid steps, in order (CEO-F16).** 1) calibration tuning rounds; 2) freeze check; 3) generator freeze (knobs
  committed); 4) gbrain smoke on seed 20261099 with the frozen generator; 5) held-out world generation (seed 20261006,
  both scales) and the preregistration commit; 6) 4k slot build; 7) 4k simple arms (fs, pg, memory) and the oracle
  reference; 8) comparator committed; 9) 4k gbrain cells; 10) 50k slot builds; 11) 50k cells, starting with a 5-cell
  smoke on the 50k slots that halts the step on any harness error. No paid step runs before Garry's budget decision at
  the Phase 4 gate, which picks the funded tier (Taste CEO-T3) before step 1; the 50k steps (10–11) run only if that
  tier funds them, and their projection uses the per-cell costs measured at 4k. Taste decisions CEO-T1, CEO-T2 and
  CEO-T4 are settled at the same gate. The turn-budget sensitivity check (CEO-F19) runs after step 9.
- **Defects found after the freeze (CEO-F17).** A runner or scorer fix that leaves every world digest unchanged
  proceeds with a dated note in the calibration record. A generator change after step 3 voids the freeze and reruns
  the freeze check (within the limit of 2). A generator change after step 5 stops for Garry.
- **Held-out reuse (CEO-F18).** This run is the Hard baseline. Each later measurement of a gbrain change on Hard uses a
  fresh preregistered seed with the frozen generator, because seed 20261006's tasks and transcripts are published.
- **Runner work (CEO-F12).** Deliverables include, each with hermetic tests: world identity `(seed, scale, mode,
  knobs)` in generation, the runner's regeneration check and `experiment.json`, with the knob set recorded in the world
  and passed on regeneration; a per-world turn cap read from the world (8 for Hard, 16 for v1 unchanged); N-session
  tasks (session k's user message, a fresh session between sessions on every arm, each session capped separately);
  dispatch of each Hard task to its scorer; Hard oracle evidence; a Hard system prompt section, identical for every arm
  including the oracle, that states the authority order (executed contract or executed amendment, then draft
  amendment, then email summary, then agent note; between two executed documents the later effective date wins) and
  the effective-date rule (a change takes effect on its stated effective date, not when it was written); and
  `scriptedAgent` support for N sessions and set answers. `--scripted` Hard runs are exempt from the judge refusal.
  An H5 chain continues whatever sessions 1–4 submit or however they stop; stop kinds are reported per session; an
  `error` in any session fails the whole cell, and a resume reruns the 5-session chain as one unit. Tasks per family
  is a recorded generation parameter: the calibration world is generated at the held-out density (20 per family) and
  each round samples 10 per family. A failed H5 cell's `error` field names the failing session (CEO-F28).
- **Scoring by family (CEO-F14).** H2, H3 and H4 ask for one value and score with `score.ts`'s `valueVerdict` and
  `answerHead`, imported unchanged. H5 asks for one value in its final session, which alone is scored; sessions 1–4
  must submit `RECORDED`, as family F's session 1 does. H1 asks for a set or a count. The H1 task prompt states the
  format; the shared `submit_answer` description is unchanged. A set is a JSON array of names, sent either as a
  JSON-encoded string in `answer` or as a native array; a count is the integer at the start of `answer` ("12" and
  "12 accounts" pass; "As of 2026-07-01, 12" fails). Each set element matches by exact `normalizeValue` equality with
  the entity's canonical name or a declared alias or former name (H3 renames and merges), never by substring;
  elements naming the same entity count once. Success is exact set equality; precision, recall and Jaccard are
  reported, never counted as success. A count succeeds only when the integer equals the key. Every H2–H5 task fills
  `gold.wrong`: the intermediate or superseded values (H2), the look-alike's value (H3), the lower-authority values
  (H4) and the superseded saved facts (H5); a generator invariant asserts that accepted and wrong values are pairwise
  distinct and never substrings of each other after normalization. The scorer mutation suite
  (`assertScorerRejectsFakeSystems`) covers, for H1, empty, everything, off-by-one, a namesake substituted, a stale
  member, prose instead of an array and date digits before a count, and for H2–H5, a stale value, a look-alike's value
  and a hedged answer naming both values.
- **Oracle evidence (CEO-F13).** The oracle gets every document that decides the answer, from the ledger: for H1, the
  deciding records of every member and of every near-miss entity (one that matches at least one predicate clause),
  capped by a generator knob; for H2, the full dated history of the attribute; for H3, the disambiguating record and
  both look-alikes' records; for H4, every conflicting source; for H5, the oracle runs only the final session, with one
  synthesized "ideal store" note holding the corrections and decisions in force then (as family F's note does today).
  Oracle failures in calibration are read to classify them as wording or answer-key defects before any knob changes,
  and the generator is frozen only with zero unresolved answer-key defects.
- **Models and judge (CEO-F3).** Every Hard cell runs only the newest frontier Opus, GPT, Sonnet and Fable models
  (today Sonnet 5.5, Opus 5.5, Fable 5.1, GPT-6.1 Sol, GPT-6 Astra). Every Hard command passes
  `--judge gpt-6.1-sol`, calibration included; the runner's default judge is not changed. On a Hard world the runner
  refuses to start without `--judge <model>` (`none` does not satisfy it), with gpt-5.4-mini anywhere in its models or
  judge, or with a model that has no registered price, and the refusal names the file and line to register the price;
  a unit test covers each refusal. The model set is fixed in the preregistration. A frontier release replaces its
  predecessor in the same family and tier (a new Sol replaces GPT-6.1 Sol; a new Astra replaces GPT-6 Astra; Opus,
  Sonnet and Fable by family) through a dated preregistration amendment, with its price registered, before any cell of
  the next step runs. Before step 5 it gets the freeze check on the calibration seed without retuning (G1 is claimed
  for it only if it passes). Between steps 5 and 9 it is added at both scales, including its 4k simple-arm cells, so
  the scales stay paired. After step 9 starts, Garry decides, and the decision is recorded in the preregistration.
- **Budget (CEO-F4, CEO-F11).** Hard uses its own ledger, `.budget/cat40-hard.sqlite`. It opens with a cap of $3,000 (the
  current program authorization) minus the sum of every other ledger's recorded program cap; if that is below the
  projection for steps 1–4, stop for Garry. After Garry's budget decision the cap is raised with `set-cap`, which the
  ledger allows only on the user's authorization, to the new authorization minus the same sum, so all ledgers together
  never exceed the authorization. Before each paid step the operator projects its cost and stops for Garry if the
  ledger's remaining dollars are below the projection plus 15%. Calibration round 1 is projected from v1 measured
  per-cell costs × 1.8; every later step uses the latest measured Hard per-cell costs, judge and embeddings included; slot
  builds are projected from the world's token count;
  the 50k step uses the 4k step's measured per-cell cost × 1.8 (fs) and × 1.3 (gbrain), the scale-tier ratios.
- **Calibration loop (CEO-F5, CEO-F6).** Calibration uses seed 20261005 and 10 tasks per family (50 tasks). Each
  tuning round regenerates the world from that seed with the round's knob values and runs fs and oracle on Sonnet 5.5
  and GPT-6 Astra, 1 repeat. When a round meets the freeze rule on those two models, the freeze check runs fs and
  oracle on Opus 5.5, Fable 5.1 and GPT-6.1 Sol on the same world and reuses that round's Sonnet 5.5 and GPT-6 Astra
  cells. The freeze rule, on point estimates (provisional, Taste CEO-T1; the draft's per-model 40–70% band is the
  alternative): pooled fs success within 40–70%; every model's fs success between 20% and 80% (10 to 40 of 50); every
  model's oracle success at least 90% (45 of 50); every family's oracle success at least 80% pooled over the models in
  that round. Calibration rounds and the freeze check run fs, pg and oracle, and the fs rules apply to the better of
  fs and pg for each model (CEO-F20). At most 50% of that arm's failures, pooled, may be `turn_cap` stops; otherwise
  the round fails, so difficulty comes from content rather than truncation (CEO-F20). Knob priority: record counts,
  history length, distractor rate and noise first; the turn cap moves only with a dated reason in the calibration
  record. There are at most 5 tuning rounds and at most 2 freeze checks; a
  passing round 5 may still trigger its freeze check. Without a passing freeze check, stop for Garry with the
  calibration table. Every round's knobs, per-model and per-family results, stop kinds and cost are recorded in
  `docs/benchmarks/cat40-hard/calibration.md`. World size: about 4,000 and about 50,000 documents (±25%) are held;
  the number of accounts is a knob.
- **gbrain stays out of tuning (CEO-F7).** No gbrain cell runs on the calibration seed. A paid gbrain smoke runs on
  its own seed, 20261099, never used for tuning, with the frozen generator: one task per family on Sonnet 5.5 (a 4k
  slot build plus 5 cells, about $5), checked only for harness errors (slot build, every session completing, restore,
  scorer dispatch), not for difficulty. The 50k slot builds run as their own step before any 50k cell: 5 slots, about
  86 minutes each when built one at a time (scale tier), recording build time and mention coverage only. The 50k cells
  run on 5 slots; restores take 75–100 s each, so the 50k step plans for about 12 hours of wall-clock.
- **Scale invariance (CEO-F1).** The 50k extension is its own pattern. Appended accounts have account names,
  aliases and codes disjoint from every 4k account; staff and attribute values come from the shared pools, so appended
  records can share any single predicate value (an owner on another date, an escalated ticket with no renewal in the
  window) and are near misses, but never satisfy a full Hard predicate. Appended H3 look-alikes share a first word or
  code prefix with 4k task accounts and fail the disambiguating fact. Appended documents and updates concern only
  appended accounts and never name a 4k account. A hermetic test on the calibration and smoke seeds recomputes every
  Hard answer key by evaluating the task's predicate over the full 50k ledger, asserts it equals the 4k key, and
  asserts every H3 disambiguation is still unique; the generator makes the same assertions when it writes any 50k Hard
  world, so the held-out world is checked without anyone reading it. The scale effect is expected mostly where queries
  hit shared values (H1, staff, terms) and H3 look-alikes; the report says so. Held-out worlds are written under
  `eval/reports/cat40/hard-holdout/` (ignored by Git) during the runs; after the results, the 4k world and the 50k
  manifest are committed, as for `model-ladder-v1-large`.
- **Endpoint, comparator and held-out misses (CEO-F10, CEO-F15).** The simple arms are fs, pg and memory; the oracle
  is a reference, never a comparator. The comparator is the best pooled simple arm on the 4k held-out results, among
  simple arms run on every model, committed before any 4k gbrain cell runs; fs is the comparator at 50k. The primary
  endpoint is the pooled 4k paired difference, gbrain minus the comparator, with a task-clustered bootstrap (a
  resampled task carries all its models and repeats) through a named `holdout_stats` mode; per-model and 50k results
  are secondary. The step-5 preregistration carries a planning minimum detectable difference computed from the
  freeze check's fs success under a stated discordance assumption, with a worst-case bound; the step-8 commit reports
  the same figure for the chosen comparator. The decision sentences use the freeze rule as the
  held-out bar: a model whose held-out comparator success is above 80% or below 20%, or whose oracle is below 90%, has
  its comparison reported with that miss beside it; a model at ceiling on both arms is uninformative, not a tie.
- **Turn-budget sensitivity (CEO-F19).** After step 9, the comparator and gbrain rerun the 4k held-out tasks at 16
  turns on Sonnet 5.5 and GPT-6.1 Sol, 1 repeat; the report shows how much of the gap the cap creates, and
  turns-to-success per arm and family.
- **Hard tool options (provisional, Taste CEO-T4).** On Hard worlds only, the fs `grep` returns every match with full
  lines and always reports the total (the agent may still pass `max_results`), and pg searches accept a limit up to
  100; v1 worlds keep today's 200-match, 300-character and 25-row limits, with a test for each. The alternative is
  today's limits on Hard too.
- **Decisions this run informs (CEO-F21).** The preregistration states, before step 5, the action each primary
  outcome triggers: gbrain ahead of the comparator by at least the planning MDD → the next gbrain wave targets the
  family where gbrain trails most and is measured on a fresh Hard seed; within the MDD → the next wave is chosen by
  per-family mechanism evidence (failure-mode mix from transcripts), not by this endpoint; behind → retrieval on the
  worst family is the next wave's target. Each sentence names the family-level evidence it uses.
- **50k composition (CEO-F22).** Besides appended accounts, the 50k world appends material about existing 4k accounts
  that decides no answer (meeting logistics, routine correspondence, closed tickets on unrelated topics), under the
  same key-equality assertions. The report states which kinds of growth the 50k world models (more accounts, more
  material per account, more look-alikes) and which it does not (answers that change as the company grows).
- **All comparisons (CEO-F23).** Besides the primary endpoint, the report gives paired comparisons of gbrain against
  every simple arm run on every model, names any missing comparison, and reports gbrain minus fs at both scales so the
  scale effect uses the same arm.
- **H5 design (CEO-F24).** Each H5 final question depends on facts from at least two earlier sessions, one of them
  superseded later in the chain. A write diagnostic, from tool calls and the store after the chain, reports per arm
  whether each session's fact was saved, updated or lost; it is reported, not scored. The oracle is described as an
  ideal-state reference.
- **Claim scope (CEO-F25).** Hard has no permissions family, so its claims are limited to unrestricted information;
  any gbrain fix wave chosen from Hard also passes the unchanged Cat 40 permission family (C) and ships as one PR.
- **Single predicate evaluator (CEO-F29).** One function evaluates H1 predicates over a ledger; key generation and the
  50k key-equality assertion both call it.
- **Reporting (CEO-F8, CEO-F27).** The Hard report lists the models people use most first and calls out any model at ceiling.
  Per arm and family it gives success; tool calls per task; stops by kind (`turn_cap`, `no_tool_call`, `error`), reported separately; cost
  per task and per successful task; incremental cost per extra success against the comparator; agent latency without
  slot-restore time; and a family-by-arm table stating which families favor which arm.
- **Seeds (CEO-F9).** Calibration seed 20261005, smoke seed 20261099 and held-out seed 20261006 are fixed now. The
  held-out seed is written in the preregistration before the held-out world is generated and is used for both scales.
- **Statistical design (CEO-T2).** The preregistration fixes tasks per family, repeats, the gbrain commit and
  `--gbrain-config`, the decision sentences and the 50k oracle sample (the H1 tasks, whose oracle evidence gains
  near-miss records at 50k). Provisional (Taste CEO-T2): 20 tasks per family and one repeat at each
  scale (100 tasks, the same cell count as 50 × 2); the alternative is the draft's 10 tasks per family and two repeats.
<!-- /autoplan-accepted:ceo -->

<!-- autoplan-accepted:dx -->
- **Hello world (DX-F1).** `scripts/cat40-hard.sh hello` generates a calibration-seed Hard world and runs it
  `--scripted` on fs, memory and oracle at $0, covering every family (a five-session H5 chain and a scored H1 set
  answer), and prints per-family rows and the freeze-rule table in under 2 minutes from a checkout with dependencies
  installed. A hermetic test runs exactly that command. `--scripted` without `--arms` selects only arms that support it.
- **CLI contract (DX-F2, DX-F3).** The generator takes `--mode hard`, `--knobs <file.json>` (default: the committed
  `docs/benchmarks/cat40-hard/knobs.frozen.json` once it exists; calibration rounds use `knobs.round-N.json`) and
  `--scale large` for the 50k append, which refuses unless it matches the 4k world's digest. Unknown or missing knob
  keys are refused with the list of valid keys. The runner takes `--max-turns <n>`, which overrides the world's cap and
  is recorded in `experiment.json` as part of the experiment's flags. The generator and runner reject unknown flags,
  non-numeric values and empty task or family selections before writing anything, and print usage on `--help`.
- **Errors and stops (DX-F7, DX-F8, DX-F12).** Every refusal names what failed, why and the exact fix (the judge
  refusal prints `--judge gpt-6.1-sol`; the world-identity refusal names the differing field among seed, scale, mode,
  knobs and the fix: repeat the original argv or use a new `--out`). Every stop-for-Garry condition exits 3 with a
  stable code, the numbers that triggered it and the decision asked; the runbook lists every code. Generator
  assertions on a held-out world print only counts, family and task index. On Hard runs, cells whose run stopped with
  `error` are retried on resume (each attempt's cost kept), a run with incomplete required cells exits non-zero and
  prints the resume command, and claims-judge failures can be re-judged without rerunning the agent.
- **Runbook and campaign script (DX-F4, DX-F5).** Before step 1, `docs/benchmarks/cat40-hard/RUNBOOK.md` gives every
  paid step's exact command, `--out` path, ledger, projection command, expected wall-clock, stop codes and next step;
  `scripts/cat40-hard.sh` runs the steps by name, verifies predecessor artifacts and the recorded budget decision, and
  has print-only and `status` modes, modelled on `scripts/cat40-followups.sh`. One Hard operator guide is linked from
  `README.md`, `eval/RUNBOOK.md`, `eval/CONTRIBUTING.md` and the registry row; v1 examples that Hard refuses are
  labelled as v1. Output paths: `docs/benchmarks/cat40-hard/{calibration.md, PREREGISTRATION.md, RUNBOOK.md,
  knobs.*.json}`, receipts under `docs/benchmarks/cat40-hard/<step>/`, and a dated report
  `docs/benchmarks/<date>-model-ladder-hard.md`, linked from the Cat 40 report.
- **Freeze-rule analyzer (DX-F6).** `bun eval/runner/cat40/analyze.ts <results.jsonl> --freeze-rule --round N` prints
  every freeze condition as PASS or FAIL with its measured value and threshold, names the knob family the priority
  order says to adjust next, appends the table to `calibration.md`, and exits non-zero on failure; hermetic tests
  cover each condition.
- **Registry (DX-F9).** The `model-ladder-hard` row's `run.command` is the step-9 command with `--judge gpt-6.1-sol`,
  the Hard world path and the Hard arm set (no fs-acl).
- **Hard tool descriptions and selector (DX-F10, DX-F11).** On Hard worlds the fs and pg tool descriptions state the
  Hard behavior (all matches, full lines, total; pg limit up to 100); `--hard-tool-limits v1|hard` selects the CEO-T4
  alternative and is recorded in `experiment.json`; a test checks each description against the behavior on each world
  type.
- **Preflight (DX-F13).** `--preflight` makes no paid call and prints the required environment variable names per arm
  (for example pg needs `OPENAI_API_KEY` for embeddings), the resolved models and their prices, the world identity,
  the cell count, slot coverage, the Hard ledger's cap computed from every ledger's recorded cap, and the step's
  projection.
- **Upgrade path (DX-F14).** Hard worlds carry `model-ladder-hard-v1` and a knob schema version; `experiment.json`
  records the runner commit and the hashes of the Hard scorer and oracle modules. A resume with a changed evaluator is
  refused; a scorer-only change is handled by an offline rescoring command that rewrites scores beside the originals;
  `analyze.ts` reads N-session records and costs every session.
- **Report entrypoint (DX-F15).** The Hard report links each headline comparison to its family table, receipts and
  representative transcripts, gives one offline command that reproduces every table from committed results, and shows
  setup cost and end-to-end latency beside agent-only latency.
- **H1 answer format (provisional, Taste DX-T1).** H1 answers are one JSON-encoded string in `answer`; the H1 prompt
  shows literal examples (`["Quorvane Systems","Telmiro Labs"]`, `12`); native arrays from a provider are accepted
  but not documented. The oracle's H1 success in calibration is the format check. The alternative is a Hard-only tool
  schema accepting string arrays.
<!-- /autoplan-accepted:dx -->

<!-- autoplan-accepted:eng -->
- **Attempts and stop kinds (ENG-F1, ENG-F2).** Hard runs append to `attempts.jsonl` with unique attempt ids; a
  canonical cell is the last harness-clean attempt per key, and analysis sums cost over every attempt and validates
  the expected cell grid and experiment identity (scale, turn cap, tool limits). Stop kinds: `submitted`, `turn_cap`,
  `no_tool_call`, `context_overflow` (a provider context-length 400, scored as a failure, never retried), `error`
  (agent-side malformed tool use, scored as a failure) and `harness_error` (provider 5xx or 429 after backoff, slot,
  server, restore or MCP transport failure, including failures a tool would otherwise return as text). Only
  `harness_error` is retried, at most 2 times per cell; retry counts are reported per arm and model. Records use a v2
  schema with `sessions[]` and `attempt`; `analyze.ts`, `rescore.ts`, `latency-replay.ts` and `holdout_stats.py` read
  v1 and v2 records, each with a hermetic test on duplicated-key and 5-session fixtures.
- **Hard judge (ENG-F3).** `judge-hard.ts` has its own `JUDGE_PROMPT_VERSION`; for H5 it includes the chain's user
  messages as trusted evidence (never agent-written notes); for H1 it caps and summarizes near-miss documents; it
  persists each judge request for re-judging and treats malformed judge output as a judge failure. Judge cost is
  projected from calibration's measured prompt tokens at each scale.
- **Temporal and entity semantics (ENG-F4).** Every entity has a stable id; every attribute value has an effective
  time and a recorded time. "As of D" means the value in effect on D using every document, including those written
  after D (valid time with hindsight), and the Hard system prompt says so. A correction replaces the corrected value
  from that value's effective date; two changes with the same effective date resolve to the later recorded one. A
  user statement in the H5 session chain outranks documents, and a later user statement outranks an earlier one; the
  prompt states this beside the authority order. Aliases and former names resolve at the query date; the alias
  namespace is injective across all entities at both scales, and a merged account's names map to one entity id.
  Generator invariants and small hand-specified fixtures test each rule before any prose is rendered.
- **Hard answer decoder (ENG-F5, ENG-F19).** Before calling imported `score.ts` helpers, the Hard scorer coerces
  `answer` (array → JSON string; other non-strings → string; null → empty), rejects an answer that names any
  `gold.wrong` value anywhere in the full answer (not only its head), and classifies an H1 answer that is not a JSON
  array or a leading integer as `unparseable_set`, reported per arm separately from wrong sets. Mutation cases add an
  array answer for H2–H5, `answer: null` and "X (or Y)".
- **Freeze contract (ENG-F6, replaces CEO-F17's first sentence).** The freeze covers the generator, knobs, Hard
  prompts, tool schemas and behavior, session transitions, scorer and judge, recorded as code hashes and an effective
  settings digest in the preregistration. A held-out run refuses unless the world's knob digest equals the committed
  `knobs.frozen.json` digest. A scorer-only change after the freeze is applied by offline rescoring of every affected
  result; a behavior change reruns the affected calibration and reference cells before the next step.
- **H1 oracle evidence and 50k append classes (ENG-F7, ENG-F8, replaces CEO-F1's sentence "Appended documents and
  updates concern only appended accounts and never name a 4k account").** The near-miss knob bounds the generated
  near-miss population, and the oracle gets the complete evidence for it; a token preflight refuses oracle cells that
  exceed a model's input limit. H3 oracle evidence stays the 4k set at 50k, and near-miss ordering is seeded so 4k and
  50k oracle inputs are reproducible. The 50k world has two append classes: appended-account documents, which never
  name a 4k account, and non-deciding documents about 4k accounts (CEO-F22) drawn from templates that set no
  predicate value; both are covered by the key-equality assertions.
- **Program ledger roster (ENG-F9).** The preregistration and runbook commit the list of program ledgers and their
  allocations; other allocations are frozen for this campaign; `--preflight` refuses when a listed ledger is missing
  or its cap differs.
- **Slot quarantine (ENG-F10).** A slot whose restore or health check fails is quarantined, never released to another
  cell; the step halts when fewer than the planned slots remain; a test covers a failed restore with a waiting cell.
- **pg chunked embeddings on Hard (ENG-F11, ENG-F12).** On Hard worlds the pg arm embeds documents in chunks (full
  document still returned by `get_document`), with the chunking identity in the embedding cache key; a test finds a
  deciding line past 24,000 characters. Every paid request is attributed to setup or to a cell attempt and session,
  for every arm (pg query and note embeddings included), and reconciled with the ledger before costs are published.
- **Non-blocking hot paths (ENG-F13).** Hard grep runs in a Worker with a time limit that returns an error to the
  agent; slot restores run as asynchronous subprocesses; the report times queueing, session start, agent execution and
  restore separately, and agent latency comes from those timers.
- **H5 dependency proof (ENG-F14).** Generator counterfactual tests show that removing each required earlier fact
  changes or voids the final answer; per-session store changes are captured before restore for the write diagnostic.
- **Paired tuning rounds (ENG-F15).** The Hard generator derives sub-seeds per family and task index and a separate
  noise stream, so a knob change perturbs only what it controls; rounds sample the same task indices; the freeze-rule
  analyzer prints Wilson intervals beside point estimates.
- **Weakest-family rule (ENG-F16).** A decision sentence that picks "the family where gbrain trails most" requires that
  family's paired difference to have a bootstrap CI excluding 0; otherwise the choice falls back to mechanism evidence.
- **Fast invariance test (ENG-F17).** The 50k key-equality test runs on the ledger without rendering prose.
- **Held-out audit (ENG-F18).** The preregistration records the held-out world files' SHA-256 at generation;
  `scripts/cat40-hard.sh status` prints hashes, never content.
- **Regression contract (ENG-F20).** v1 `--check`, the large manifest digest, `score.ts` hash `8a448051…`, a v1
  scripted run whose scores match a recorded fixture byte for byte, and v1 tool limits (grep 50 default, 200 max,
  300-character lines; pg 25) stay unchanged, each with a test; `hello` runs under a 2-minute test timeout; `--max-turns`
  changes the experiment identity; gbrain gets `newSession()` between sessions and `restore()` only after the chain.
- **Comparator inference (provisional, Taste ENG-T1).** The primary inference adds simultaneous paired intervals (max-T
  task-clustered bootstrap) for gbrain against every eligible simple arm, alongside the preregistered comparator; the
  alternative is the single-comparator interval with the all-comparisons table as context.
- **Hard tool options (Taste CEO-T4, recommendation updated).** The recommended Hard configuration is uncapped grep
  plus pg offset pagination with totals and an exhaustion flag; capped configurations are not used for the primary
  Hard measurement unless Garry picks the alternative.
<!-- /autoplan-accepted:eng -->
## Review record

### Phase 0 intake

- SOURCE_PLAN = ACTIVE_PLAN = `docs/plans/2026-10-05-cat40-hard/PLAN.md` (worktree `~/.capy/work/evals-hard`, branch
  `plan/cat40-hard`, base `main` at `9517616`). RESTORE_PATH =
  `~/.gstack/projects/garrytan-gbrain-evals/plan-cat40-hard-autoplan-restore-20261005-003735.md` (sha256 `1755fec0…`).
- Scope (`scope --developer-tool`, input sha256 `1755fec0…`): UI terms 0 matches, so Phase 2 (design) is skipped. DX
  terms: `agent` ×4, `dxRequired: true`; the product is also a developer tool (engineers run the runner and read the
  report), so `--developer-tool` was passed. Phases run CEO, DX, Eng.
- Outside voice: Codex CLI 0.160.0, OpenAI API key, model `gpt-6-astra` (CODEX_MODE ready per the parent's preflight).
- Capy adaptations: each phase's native reviewer is a Capy subagent on the shared machine sent the snapshot's
  `nativeDispatchPrompt` verbatim; AskUserQuestion is unavailable, so every intermediate question is auto-decided with
  its recommended option (user instruction); onboarding, telemetry and upgrade prompts are skipped.
- Context read: `CLAUDE.md` (main; the "Choose models" rules are on `docs/eval-model-selection`, PR #63, which is still
  OPEN, so they are not on `main` yet; the same rules are in the gbrain project scope instructions), `TODOS.md`,
  `eval/CONTRIBUTING.md` "Add a category", `git log -30`, the generator, the runner and `cat40/*`, the Cat 40 report and
  protocol, and the in-flight entity-recall wave (`plan/cat40-entity-recall`, `feat/cat40-entity-recall`).

### CEO phase (Phase 1), Step 0

Methodology: `autoplan-ceo-methodology-i14kHk/methodology.md` (sha256 `8f6b4fc5…`, 2,550 lines) read at offsets 1, 601,
1201, 1801 and 2401 through EOF (5 of 5 ranges). Mode: **SELECTIVE EXPANSION** (autoplan override). Review depth:
implementation-ready.

#### Pre-review system audit

- `main` is at `9517616` (v0.10.20). This branch adds only the draft plan. No stashes.
- **In-flight work this plan depends on.** The entity-recall wave (`feat/cat40-entity-recall`, 8 commits ahead of
  `main`, unmerged; paid A3 runs in progress in `/workspace/gbrain-evals`) adds things Hard needs: the Fable 5.1 price
  (`claude-fable-5-1`, `budget-ledger.ts:1028` on that branch), `--gbrain-config`, preregistered `holdout_stats` modes,
  the slot coverage preflight and Amendment 1's frontier model set. Its preregistration pins `score.ts` to hash
  `8a448051…`: if `score.ts` changes before A3 is analyzed, the simple-arm rescoring must be rerun.
- Model rules: PR #63 ("Choose models" in `CLAUDE.md`) is OPEN. `main`'s `budget-ledger.ts` prices Sonnet 5.5,
  Opus 5.5, GPT-6.1 Sol and GPT-6 Astra; Fable 5.1 is priced only on the entity-recall branch.
- The runner's claims judge defaults to `gpt-5.4-mini` (`cat40-model-ladder.ts:363`). The model rules forbid running
  gpt-5.4-mini, so every Hard run must pass `--judge` explicitly.
- The agent loop's turn cap is `DEFAULT_MAX_TURNS = 16` (`cat40/loop.ts:95`), one constant for every task.
- Two-session tasks exist only for family F (`cat40-model-ladder.ts:186`); the oracle's family-F "ideal store" note is
  hard-coded in `OracleArm.evidence` (`arms.ts:204`).
- Scoring knows `answer_kind: 'value' | 'fields'` only (`score.ts`); there is no set or count scorer.
- The runner re-derives every world from `(seed, scale)` and refuses a mismatch (`cat40-model-ladder.ts:350`); a Hard
  world needs its mode in that identity.
- TODOS.md: "Cat 40 follow-ups (2026-10-03 plan, deferred)" lists the `gbrain-verbs` cost-floor arm and a priced dry
  run; the report's "next steps" name a harder world, real harnesses (Claude Code, Codex) and the failure family D.
- Retrospective: the last two Cat 40 waves both hit harness artifacts that changed conclusions (the ledger stall that
  silently turned off gbrain's vector search; a 40,000-character tool-result cut). Recurring lesson: preflight the
  harness on the new world before paid cells, and record every knob in the receipt.
- Taste calibration. Good patterns: the ledger-first generator (`generateLadderWorld`: answer keys never read back from
  prose; the `large` scale keeps v1 byte-identical and only appends), and the entity-recall preregistration (exact argv,
  comparator chosen before the scored run, launch-time cost projection). Pattern to avoid: estimates written before
  pricing new models (the cost wave's estimate missed by 18%), and one-constant harness settings applied to a new tier.
- Landscape check: web search is available, but the question is internal (which synthetic tasks separate frontier
  agents' memory tools); public long-horizon memory benchmarks are already tracked in `docs/comparison-systems.md`.
  Layer 1: harder benchmarks usually add more of the same items at greater length. Layer 3: for a memory benchmark,
  difficulty that grows with corpus size and mess (aggregation, history, aliasing, authority) is what separates
  retrieval tools, which is the plan's thesis. No new external evidence changes the plan.
- Prior learnings: none recorded for this project (`gstack-learnings-search` returned nothing).

#### 0A. Premise challenge

The real problem: the next gbrain decisions (entity recall, typed fields, deeper retrieval) need a measurement that can
move for the models people use, and Cat 40 is at its ceiling for them. Doing nothing means every future gbrain change
is judged on a test where plain files already score 91–100% on frontier models, so a real gain reads as a tie.

| # | Premise | Verdict | Evidence |
|---|---|---|---|
| P1 | Cat 40 no longer separates frontier models | Valid | v1 held-out (2026-10-02): fs 91/100 Sonnet 5.5, 100/100 GPT-6.1 Sol; oracle 96 and 100; gbrain master 239/250 on dev (plan) |
| P2 | Difficulty should come from what grows with brain size and mess | Valid | Matches the report's next steps; puzzles would move every arm together |
| P3 | An 8-turn cap (H6) adds memory difficulty | Partly | At v1, fs on frontier models used 4.9 turns on average and only 12 of 200 runs went past 8. The cap only bites once the content is hard; it is a harness constraint, so cap hits must be reported per arm |
| P4 | One generator can put fs in 40–70% on each of five models | Unproven | Models already differ by 10 points on v1; the band needs a termination rule if all five can't land in it |
| P5 | The held-out run costs about $700 | Low | Measured per-cell costs on v1 held-out, scaled by list prices, give about $570 for 4k with five arms before Hard's longer content and 5-session tasks (see 0B cost model) |
| P6 | The runner can run Hard as-is | No | No set scorer, one global turn cap, 2-session max, judge defaults to gpt-5.4-mini, Fable unpriced on `main` |
| P7 | Hard can ship independently of the entity-recall wave | No | Shares `score.ts` (hash pinned by A3), the ledger, the model price table and `holdout_stats` |

No premise is clearly wrong enough to queue as a User Challenge at this point; P3–P7 become accepted fixes below.

#### 0B. Existing code leverage

| Sub-problem | Existing code | Reuse |
|---|---|---|
| Seeded world, ledger-first answer keys | `generateLadderWorld`, `Rng`, `draw`, `unique`, `accountRecords`, `transcript`, `ref` (`model-ladder-gen.ts`) | Reuse; helpers are closures today, so they move to module scope with v1 and `large` byte-identical (`--check` and the large manifest digest prove it) |
| Look-alike names (H3) | `NAMESAKE_PAIRS = 25`, first-word refs in routine docs | Extend |
| Authority ladder (H4) | Family A (contract, executed amendment, draft, email, agent note) and the "which document governs" policy | Extend to 3–5-document conflicts |
| History (H2) | Family B (handoff, future-dated change, stale note, reversal) | Extend to 3–6 changes with backdated corrections |
| Long transcripts with mid-document facts | `transcript(…, planted, 60–200 lines)` | Reuse |
| Multi-session (H5) | Family F session 1 + session 2, `slot.newSession()` | Generalize to N sessions |
| Two scales, paired tasks | `--scale large` (v1 world untouched, distractors appended) | Reuse the pattern for Hard |
| Staged 50k gbrain build | `STAGED_SOURCE_ADD_DOCS`, `--build-slots`, slot snapshots | Reuse |
| Budget, cost projection | SQLite ledger, `startPaidRun`, `set-cap`, receipts | Reuse |
| Paired CIs | `analyze.ts` (task bootstrap), `holdout_stats.py` | Reuse |
| Set/count scoring | none | New, in a new file so `score.ts` stays byte-identical |

**Cost model (measured, 2026-10-02 v1 held-out, 16-turn cap):** mean $/cell, Sonnet 5.5: oracle 0.010, fs 0.055, pg
0.035, memory 0.270, gbrain 0.122 (a714410a5); GPT-6.1 Sol: 0.005, 0.022, 0.018, 0.187, 0.065. List prices make Opus 5.5
about 2× Sonnet 5.5 and Fable 5.1 about 5×; GPT-6 Astra about 5× GPT-6.1 Sol. Per task and repeat over all five models
and five arms that is about $5.70, so 50 tasks × 2 repeats is about $570 before Hard's longer content and 5-session
tasks. The memory arm is 58% of it.

#### 0C. Dream state

```
  CURRENT STATE                    THIS PLAN                           12-MONTH IDEAL
  Cat 40 v1 at ceiling for    ---> A Hard tier (H1-H5 + turn budget), ---> A maintained difficulty ladder (v1, Hard,
  frontier models; gbrain vs       calibrated on fs/oracle only,           next) re-calibrated each model generation,
  files a tie on held-out;         frozen, run once held-out at 4k         run on real harnesses too, with the failure
  no aggregation, deep-history     and 50k on 5 frontier models            family; each gbrain change gated on the
  or 5-session tasks                                                       tier where frontier models have headroom
```

The plan moves toward the ideal: it adds the tier and the calibration procedure that the ladder needs. It does not add
real harnesses or family D (deferred below).

#### 0D. Approach

Alternatives considered: **A)** the plan (a new `hard` generator mode with families H1–H5 and a turn budget);
**B)** only raise the knobs of existing families A/B/E/F (more distractors, longer histories) with no new family;
**C)** replace the synthetic world with real harness runs on a real corpus. B cannot produce aggregation questions (H1),
the family most tied to what grows with brain size, and C cannot publish private data or compute answer keys from a
ledger. A is the most complete (P1). Not close, so no Taste decision. No new approach decision was needed.

#### 0E. Mode

Auto-decided review mode → SELECTIVE EXPANSION (autoplan override). The plan adds a capability to an existing benchmark
(a new tier), so hold its scope and cherry-pick expansions that make the measurement trustworthy.

#### 0F/0G. HOLD checks and cherry-picks (auto-decided, P1/P2 in blast radius)

HOLD checks: the work touches more than 8 files (generator module, runner, loop, a new scorer, registry, tests,
calibration record, preregistration, report, receipts). Fewer moving parts would drop a family, which defeats G1, so
complexity is accepted. The minimum change set is the generator mode, the set scorer, per-world turn cap and N-session
support, and the registry row. Nothing in current scope is deferrable without blocking G1 or G2.

| ID | Proposal | Effort | Decision | Reason |
|---|---|---|---|---|
| CEO-F1 | 50k Hard = the 4k Hard world plus appended distractors from one held-out seed (the `large` pattern), so both scales share tasks and the scale effect is paired | S | ACCEPTED | P1; makes G2's two scales comparable task by task |
| CEO-F2 | Dependency and sequencing: implement on top of the merged entity-recall wave; keep `score.ts` byte-identical (Hard scoring in a new module) and v1/large worlds byte-identical | S | ACCEPTED | P7; A3's pinned hash and G3 |
| CEO-F3 | Model rules applied in the plan: explicit `--judge gpt-6.1-sol` on every Hard run (never the gpt-5.4-mini default); Fable 5.1 priced before any cell; a newer frontier model released before the run is added by a preregistration amendment with its price | S | ACCEPTED | P6; "Choose models" |
| CEO-F4 | Corrected cost model and a launch-time projection check before each paid step (stop for Garry if the ledger's remaining dollars are below the projection + 15%) | S | ACCEPTED | P5; entity-recall precedent |
| CEO-F5 | Calibration freeze check: after tuning, one fs + oracle round on all five models (1 repeat) on the calibration seed, so G1 is checked on every model before freeze | S | ACCEPTED | P4; G1 names all five models |
| CEO-F6 | Calibration termination rule: freeze when pooled fs is in 40–70%, every model's fs is at most 80% and every model's oracle is at least 90%; stop for Garry after 4 tuning rounds without that | S | ACCEPTED provisional (Taste CEO-T1) | P4; the per-model band may be unattainable |
| CEO-F7 | gbrain never runs on calibration seeds; before held-out, a scripted ($0) gbrain smoke on a calibration world at 4k and a 50k slot build check | S | ACCEPTED | Avoids tuning to gbrain; catches harness breakage (retrospective) |
| CEO-F8 | Report per arm and family: turn-cap hits (`stop` not `submitted`), cost per task and per success, and which families favor which arm | S | ACCEPTED | P3; the plan's own risk "difficulty that rewards a tool" |
| CEO-F9 | Held-out seed rule committed in the preregistration before generation (fixed seeds 20261006 for Hard held-out; calibration uses 20261005 and successors) | S | ACCEPTED | Prevents seed shopping |
| CEO-F10 | Statistical design in the preregistration: tasks per family, repeats, the minimum detectable paired difference at that size, and the decision sentences | S | ACCEPTED | G2 asks for per-model CIs; power must be known before money is spent |
| CEO-F11 | Budget: separate ledger `.budget/cat40-hard.sqlite` opened with the cap Garry approves; projection per step | S | ACCEPTED | Rules: each run has its own ledger budget |
| CEO-T2 | 100 tasks × 1 repeat instead of 50 × 2 for held-out (same cost; task variance dominates paired CIs) | S | ACCEPTED provisional (Taste) | More power per dollar; repeat noise still visible at 50k? see Section 6 |
| CEO-E1 | Drop the memory arm for the three new models (entity-recall Amendment 1 precedent) | S | NOT APPLIED; offered as a budget option at the gate (Taste CEO-T3) | User's arm list stands; memory is 58% of the 4k cost |
| CEO-E2 | Family D (surviving tool failure) in Hard | M | DEFERRED to TODOS.md | Not a size/mess difficulty; separate design |
| CEO-E3 | Real-harness arms (Claude Code, Codex) on Hard | L | DEFERRED to TODOS.md | Different harness; needs its own plan and budget |
| CEO-E4 | A "Hard" scale above 50k (500k) | M | SKIPPED | No evidence 50k is insufficient; staged build already slow |

Delight scan (adjacent 30-minute wins, each folded into an accepted row or skipped): per-family example task in the
report (F8), a `--print-plan` cost preview from the projection (F4), calibration table auto-written by the runner
(Section 8), knob values in the world manifest (Section 5), a family-by-arm heat table (F8).

Platform potential: the Hard generator's knobs (record counts, history length, distractor rate, sessions, turn cap)
become a difficulty dial for the next model generation. That is the 12-month ideal's "re-calibrated each generation".

#### 0H. Amendment checkpoint and accepted CEO requirements

Checkpoint (`<CEO_STEP0_CHECKPOINT>`): `autoplan-ceo-A0pqgs/ceo-implementation.md` (sha256 `1755fec0…`). Baseline
replacements (factual corrections: the paired-scale freeze, repeats moved to the preregistration, the measured cost
model, the per-cell cost range):

<!-- autoplan-baseline-edits:ceo {"sourceSha256":"1755fec02e6680d31e4cb0b5b9dc5c441c16b1eb8f30b88d355ae36601d35639","replacements":[{"oldText":"3. **Freeze.** Freeze the generator, then generate new held-out seeds for both scales. Nobody opens them before\n   the runs finish.","newText":"3. **Freeze.** Freeze the generator, then generate the held-out world from one preregistered seed at both scales.\n   The 50k world is the 4k world plus appended distractor accounts and updates that never change a Hard answer key\n   (rules in the accepted requirements below), so both scales share the same tasks and the scale effect is paired.\n   Nobody opens the held-out worlds before the runs finish."},{"oldText":"- **Models:** the five frontier models above, plus any newer frontier Opus, GPT, Sonnet or Fable released before the\n  run. Two repeats.","newText":"- **Models:** the five frontier models above. A newer frontier Opus, GPT, Sonnet or Fable released before the run\n  replaces its predecessor (rules in the accepted requirements below). Tasks per family and repeats are fixed in the\n  preregistration."},{"oldText":"- **Estimated cost at the rates measured on 2026-10-04:**\n  - calibration, about $40\n  - 4k held-out, about $350\n  - 50k held-out (gbrain and fs only, with oracle on a 20% sample), about $300\n  - total about $700, which needs a budget decision from Garry, since about $500 will remain after the\n    entity-recall wave","newText":"- **Estimated cost.** Agent cost per cell is taken from the 2026-10-02 held-out world (Sonnet 5.5 and GPT-6.1 Sol),\n  scaled by list price for Opus 5.5 (2×), Fable 5.1 (5×) and GPT-6 Astra (5×), and at 52k by 1.8× (fs) and 1.3×\n  (gbrain) as measured in the scale tier. Hard's longer content and 5-session H5 tasks add an unmeasured factor,\n  shown as a range from 1.0× to 1.8×; calibration replaces it with measured Hard costs. 100 task-repeats per scale:\n  - calibration (at most 5 two-model rounds on Sonnet 5.5 and GPT-6 Astra, and at most 2 freeze checks on Opus 5.5,\n    Fable 5.1 and GPT-6.1 Sol), $100–175\n  - the paid gbrain smoke and slot builds (embeddings), about $35\n  - the claims judge (GPT-6.1 Sol on every cell), $25–55, projected separately from calibration's measured prompts\n  - 4k held-out, five arms on five models, $570–1,030 (the memory arm on Opus 5.5, Fable 5.1 and GPT-6 Astra is\n    $280–510 of it)\n  - 50k held-out (gbrain and fs, oracle on the H1 tasks, the only family whose oracle evidence changes at 50k),\n    $290–515\n  - turn-budget sensitivity check (comparator and gbrain at 16 turns, 4k, Sonnet 5.5 and GPT-6.1 Sol), $25–45\n  - total $1,045–1,855 with every arm; $765–1,345 if the memory arm runs only on Sonnet 5.5 and GPT-6.1 Sol; $475–830\n    for calibration and the 4k measurement alone, with the 50k step decided after the 4k result. About $500 remains of\n    the $3,000 program authorization after the entity-recall wave, so this needs a budget decision from Garry before\n    any paid step."},{"oldText":"- **Cost.** Frontier models at 8 turns over long documents cost about $0.25–0.50 per cell. Each run has its own\n  ledger budget.","newText":"- **Cost.** Measured v1 cells range from $0.005 (GPT-6.1 Sol, oracle) to about $1.35 (Fable 5.1, memory, by price\n  scaling), and Hard's per-cell cost is unmeasured until calibration. Each run has its own ledger budget, and each paid\n  step checks its projection before launch.\n\n## Accepted review requirements\n\nThe CEO, DX and Eng reviews added the requirements below. They are part of the plan."},{"oldText":"  each frontier model (Sonnet 5.5, Opus 5.5, Fable 5.1, GPT-6.1 Sol, GPT-6 Astra). The oracle arm stays at 90% or\n  above, which proves the tasks are answerable from the evidence.","newText":"  each frontier model (Sonnet 5.5, Opus 5.5, Fable 5.1, GPT-6.1 Sol, GPT-6 Astra). The oracle arm stays at 90% or\n  above, which proves the tasks are answerable from the evidence. The calibration freeze rule that operationalizes\n  this goal is in the accepted requirements below (provisional, Taste CEO-T1)."},{"oldText":"- **H6. Tight budgets.** Every Hard task gets 8 turns instead of 16, so an agent can't brute-force by reading\n  everything.","newText":"- **H6. Tight budgets (a constraint on every family, not a family).** Every Hard session starts with 8 turns\n  instead of 16 (each H5 session gets the same cap). The cap limits sequential depth: an agent can still issue several\n  tool calls in one turn, so the report gives tool calls per task by family. The cap is a calibration knob and is\n  frozen with the generator."},{"oldText":"   and GPT-6 Astra, one repeat, at about $40.","newText":"   and GPT-6 Astra, one repeat, at about $10–18 per round (pg joins fs and oracle in every round; see the accepted\n   requirements below)."},{"oldText":"- **Preregistration:** comparator choice (the best pooled simple arm), the decision sentences, analysis commands and\n  argv. It is committed before any held-out cell runs.","newText":"- **Preregistration:** comparator rule (the best pooled simple arm on the 4k held-out world, chosen from the simple\n  arms' results and committed before any gbrain held-out cell runs; fs at 50k), the gbrain commit and config, the\n  decision sentences, analysis commands and argv. It is committed before any held-out cell runs."},{"oldText":"- **Scales:** the 4k Hard held-out world and the 50k Hard held-out world. The 50k world uses the staged build that\n  already exists.","newText":"- **Scales:** the 4k Hard held-out world and the 50k Hard held-out world. gbrain slots for the 50k world use the\n  runner's existing staged slot build (`STAGED_SOURCE_ADD_DOCS`)."},{"oldText":"gains a `hard` mode with new task families.","newText":"gains a `hard` mode with five new task families (H1–H5) and one constraint on all of them (H6)."}]} -->

<!-- autoplan-accepted:ceo -->
- **Sequencing (CEO-F2, CEO-F26).** The code may be built now on a branch stacked on `feat/cat40-entity-recall`
  (the generator mode, scorers and hermetic tests touch no pinned file); it lands on `main`, and paid steps start,
  only after the entity-recall wave and PR #63 ("Choose models" in `CLAUDE.md`) merge, so it inherits the Fable 5.1 price, `--gbrain-config`, the
  `holdout_stats` modes, the slot coverage preflight and the model rules. `eval/runner/cat40/score.ts` stays
  byte-identical (hash `8a448051…`, pinned by the entity-recall A3 preregistration); Hard scoring lives in a new
  module that may import `score.ts` helpers unchanged. The v1 and `large` worlds stay byte-identical:
  `bun eval/generators/model-ladder-gen.ts --check` passes and the `model-ladder-v1-large` manifest digest is unchanged.
  Every existing Cat 40 test passes unchanged, and `tsc` passes with any widened shared types.
- **Paid steps, in order (CEO-F16).** 1) calibration tuning rounds; 2) freeze check; 3) generator freeze (knobs
  committed); 4) gbrain smoke on seed 20261099 with the frozen generator; 5) held-out world generation (seed 20261006,
  both scales) and the preregistration commit; 6) 4k slot build; 7) 4k simple arms (fs, pg, memory) and the oracle
  reference; 8) comparator committed; 9) 4k gbrain cells; 10) 50k slot builds; 11) 50k cells, starting with a 5-cell
  smoke on the 50k slots that halts the step on any harness error. No paid step runs before Garry's budget decision at
  the Phase 4 gate, which picks the funded tier (Taste CEO-T3) before step 1; the 50k steps (10–11) run only if that
  tier funds them, and their projection uses the per-cell costs measured at 4k. Taste decisions CEO-T1, CEO-T2 and
  CEO-T4 are settled at the same gate. The turn-budget sensitivity check (CEO-F19) runs after step 9.
- **Defects found after the freeze (CEO-F17).** A runner or scorer fix that leaves every world digest unchanged
  proceeds with a dated note in the calibration record. A generator change after step 3 voids the freeze and reruns
  the freeze check (within the limit of 2). A generator change after step 5 stops for Garry.
- **Held-out reuse (CEO-F18).** This run is the Hard baseline. Each later measurement of a gbrain change on Hard uses a
  fresh preregistered seed with the frozen generator, because seed 20261006's tasks and transcripts are published.
- **Runner work (CEO-F12).** Deliverables include, each with hermetic tests: world identity `(seed, scale, mode,
  knobs)` in generation, the runner's regeneration check and `experiment.json`, with the knob set recorded in the world
  and passed on regeneration; a per-world turn cap read from the world (8 for Hard, 16 for v1 unchanged); N-session
  tasks (session k's user message, a fresh session between sessions on every arm, each session capped separately);
  dispatch of each Hard task to its scorer; Hard oracle evidence; a Hard system prompt section, identical for every arm
  including the oracle, that states the authority order (executed contract or executed amendment, then draft
  amendment, then email summary, then agent note; between two executed documents the later effective date wins) and
  the effective-date rule (a change takes effect on its stated effective date, not when it was written); and
  `scriptedAgent` support for N sessions and set answers. `--scripted` Hard runs are exempt from the judge refusal.
  An H5 chain continues whatever sessions 1–4 submit or however they stop; stop kinds are reported per session; an
  `error` in any session fails the whole cell, and a resume reruns the 5-session chain as one unit. Tasks per family
  is a recorded generation parameter: the calibration world is generated at the held-out density (20 per family) and
  each round samples 10 per family. A failed H5 cell's `error` field names the failing session (CEO-F28).
- **Scoring by family (CEO-F14).** H2, H3 and H4 ask for one value and score with `score.ts`'s `valueVerdict` and
  `answerHead`, imported unchanged. H5 asks for one value in its final session, which alone is scored; sessions 1–4
  must submit `RECORDED`, as family F's session 1 does. H1 asks for a set or a count. The H1 task prompt states the
  format; the shared `submit_answer` description is unchanged. A set is a JSON array of names, sent either as a
  JSON-encoded string in `answer` or as a native array; a count is the integer at the start of `answer` ("12" and
  "12 accounts" pass; "As of 2026-07-01, 12" fails). Each set element matches by exact `normalizeValue` equality with
  the entity's canonical name or a declared alias or former name (H3 renames and merges), never by substring;
  elements naming the same entity count once. Success is exact set equality; precision, recall and Jaccard are
  reported, never counted as success. A count succeeds only when the integer equals the key. Every H2–H5 task fills
  `gold.wrong`: the intermediate or superseded values (H2), the look-alike's value (H3), the lower-authority values
  (H4) and the superseded saved facts (H5); a generator invariant asserts that accepted and wrong values are pairwise
  distinct and never substrings of each other after normalization. The scorer mutation suite
  (`assertScorerRejectsFakeSystems`) covers, for H1, empty, everything, off-by-one, a namesake substituted, a stale
  member, prose instead of an array and date digits before a count, and for H2–H5, a stale value, a look-alike's value
  and a hedged answer naming both values.
- **Oracle evidence (CEO-F13).** The oracle gets every document that decides the answer, from the ledger: for H1, the
  deciding records of every member and of every near-miss entity (one that matches at least one predicate clause),
  capped by a generator knob; for H2, the full dated history of the attribute; for H3, the disambiguating record and
  both look-alikes' records; for H4, every conflicting source; for H5, the oracle runs only the final session, with one
  synthesized "ideal store" note holding the corrections and decisions in force then (as family F's note does today).
  Oracle failures in calibration are read to classify them as wording or answer-key defects before any knob changes,
  and the generator is frozen only with zero unresolved answer-key defects.
- **Models and judge (CEO-F3).** Every Hard cell runs only the newest frontier Opus, GPT, Sonnet and Fable models
  (today Sonnet 5.5, Opus 5.5, Fable 5.1, GPT-6.1 Sol, GPT-6 Astra). Every Hard command passes
  `--judge gpt-6.1-sol`, calibration included; the runner's default judge is not changed. On a Hard world the runner
  refuses to start without `--judge <model>` (`none` does not satisfy it), with gpt-5.4-mini anywhere in its models or
  judge, or with a model that has no registered price, and the refusal names the file and line to register the price;
  a unit test covers each refusal. The model set is fixed in the preregistration. A frontier release replaces its
  predecessor in the same family and tier (a new Sol replaces GPT-6.1 Sol; a new Astra replaces GPT-6 Astra; Opus,
  Sonnet and Fable by family) through a dated preregistration amendment, with its price registered, before any cell of
  the next step runs. Before step 5 it gets the freeze check on the calibration seed without retuning (G1 is claimed
  for it only if it passes). Between steps 5 and 9 it is added at both scales, including its 4k simple-arm cells, so
  the scales stay paired. After step 9 starts, Garry decides, and the decision is recorded in the preregistration.
- **Budget (CEO-F4, CEO-F11).** Hard uses its own ledger, `.budget/cat40-hard.sqlite`. It opens with a cap of $3,000 (the
  current program authorization) minus the sum of every other ledger's recorded program cap; if that is below the
  projection for steps 1–4, stop for Garry. After Garry's budget decision the cap is raised with `set-cap`, which the
  ledger allows only on the user's authorization, to the new authorization minus the same sum, so all ledgers together
  never exceed the authorization. Before each paid step the operator projects its cost and stops for Garry if the
  ledger's remaining dollars are below the projection plus 15%. Calibration round 1 is projected from v1 measured
  per-cell costs × 1.8; every later step uses the latest measured Hard per-cell costs, judge and embeddings included; slot
  builds are projected from the world's token count;
  the 50k step uses the 4k step's measured per-cell cost × 1.8 (fs) and × 1.3 (gbrain), the scale-tier ratios.
- **Calibration loop (CEO-F5, CEO-F6).** Calibration uses seed 20261005 and 10 tasks per family (50 tasks). Each
  tuning round regenerates the world from that seed with the round's knob values and runs fs and oracle on Sonnet 5.5
  and GPT-6 Astra, 1 repeat. When a round meets the freeze rule on those two models, the freeze check runs fs and
  oracle on Opus 5.5, Fable 5.1 and GPT-6.1 Sol on the same world and reuses that round's Sonnet 5.5 and GPT-6 Astra
  cells. The freeze rule, on point estimates (provisional, Taste CEO-T1; the draft's per-model 40–70% band is the
  alternative): pooled fs success within 40–70%; every model's fs success between 20% and 80% (10 to 40 of 50); every
  model's oracle success at least 90% (45 of 50); every family's oracle success at least 80% pooled over the models in
  that round. Calibration rounds and the freeze check run fs, pg and oracle, and the fs rules apply to the better of
  fs and pg for each model (CEO-F20). At most 50% of that arm's failures, pooled, may be `turn_cap` stops; otherwise
  the round fails, so difficulty comes from content rather than truncation (CEO-F20). Knob priority: record counts,
  history length, distractor rate and noise first; the turn cap moves only with a dated reason in the calibration
  record. There are at most 5 tuning rounds and at most 2 freeze checks; a
  passing round 5 may still trigger its freeze check. Without a passing freeze check, stop for Garry with the
  calibration table. Every round's knobs, per-model and per-family results, stop kinds and cost are recorded in
  `docs/benchmarks/cat40-hard/calibration.md`. World size: about 4,000 and about 50,000 documents (±25%) are held;
  the number of accounts is a knob.
- **gbrain stays out of tuning (CEO-F7).** No gbrain cell runs on the calibration seed. A paid gbrain smoke runs on
  its own seed, 20261099, never used for tuning, with the frozen generator: one task per family on Sonnet 5.5 (a 4k
  slot build plus 5 cells, about $5), checked only for harness errors (slot build, every session completing, restore,
  scorer dispatch), not for difficulty. The 50k slot builds run as their own step before any 50k cell: 5 slots, about
  86 minutes each when built one at a time (scale tier), recording build time and mention coverage only. The 50k cells
  run on 5 slots; restores take 75–100 s each, so the 50k step plans for about 12 hours of wall-clock.
- **Scale invariance (CEO-F1).** The 50k extension is its own pattern. Appended accounts have account names,
  aliases and codes disjoint from every 4k account; staff and attribute values come from the shared pools, so appended
  records can share any single predicate value (an owner on another date, an escalated ticket with no renewal in the
  window) and are near misses, but never satisfy a full Hard predicate. Appended H3 look-alikes share a first word or
  code prefix with 4k task accounts and fail the disambiguating fact. Appended documents and updates concern only
  appended accounts and never name a 4k account. A hermetic test on the calibration and smoke seeds recomputes every
  Hard answer key by evaluating the task's predicate over the full 50k ledger, asserts it equals the 4k key, and
  asserts every H3 disambiguation is still unique; the generator makes the same assertions when it writes any 50k Hard
  world, so the held-out world is checked without anyone reading it. The scale effect is expected mostly where queries
  hit shared values (H1, staff, terms) and H3 look-alikes; the report says so. Held-out worlds are written under
  `eval/reports/cat40/hard-holdout/` (ignored by Git) during the runs; after the results, the 4k world and the 50k
  manifest are committed, as for `model-ladder-v1-large`.
- **Endpoint, comparator and held-out misses (CEO-F10, CEO-F15).** The simple arms are fs, pg and memory; the oracle
  is a reference, never a comparator. The comparator is the best pooled simple arm on the 4k held-out results, among
  simple arms run on every model, committed before any 4k gbrain cell runs; fs is the comparator at 50k. The primary
  endpoint is the pooled 4k paired difference, gbrain minus the comparator, with a task-clustered bootstrap (a
  resampled task carries all its models and repeats) through a named `holdout_stats` mode; per-model and 50k results
  are secondary. The step-5 preregistration carries a planning minimum detectable difference computed from the
  freeze check's fs success under a stated discordance assumption, with a worst-case bound; the step-8 commit reports
  the same figure for the chosen comparator. The decision sentences use the freeze rule as the
  held-out bar: a model whose held-out comparator success is above 80% or below 20%, or whose oracle is below 90%, has
  its comparison reported with that miss beside it; a model at ceiling on both arms is uninformative, not a tie.
- **Turn-budget sensitivity (CEO-F19).** After step 9, the comparator and gbrain rerun the 4k held-out tasks at 16
  turns on Sonnet 5.5 and GPT-6.1 Sol, 1 repeat; the report shows how much of the gap the cap creates, and
  turns-to-success per arm and family.
- **Hard tool options (provisional, Taste CEO-T4).** On Hard worlds only, the fs `grep` returns every match with full
  lines and always reports the total (the agent may still pass `max_results`), and pg searches accept a limit up to
  100; v1 worlds keep today's 200-match, 300-character and 25-row limits, with a test for each. The alternative is
  today's limits on Hard too.
- **Decisions this run informs (CEO-F21).** The preregistration states, before step 5, the action each primary
  outcome triggers: gbrain ahead of the comparator by at least the planning MDD → the next gbrain wave targets the
  family where gbrain trails most and is measured on a fresh Hard seed; within the MDD → the next wave is chosen by
  per-family mechanism evidence (failure-mode mix from transcripts), not by this endpoint; behind → retrieval on the
  worst family is the next wave's target. Each sentence names the family-level evidence it uses.
- **50k composition (CEO-F22).** Besides appended accounts, the 50k world appends material about existing 4k accounts
  that decides no answer (meeting logistics, routine correspondence, closed tickets on unrelated topics), under the
  same key-equality assertions. The report states which kinds of growth the 50k world models (more accounts, more
  material per account, more look-alikes) and which it does not (answers that change as the company grows).
- **All comparisons (CEO-F23).** Besides the primary endpoint, the report gives paired comparisons of gbrain against
  every simple arm run on every model, names any missing comparison, and reports gbrain minus fs at both scales so the
  scale effect uses the same arm.
- **H5 design (CEO-F24).** Each H5 final question depends on facts from at least two earlier sessions, one of them
  superseded later in the chain. A write diagnostic, from tool calls and the store after the chain, reports per arm
  whether each session's fact was saved, updated or lost; it is reported, not scored. The oracle is described as an
  ideal-state reference.
- **Claim scope (CEO-F25).** Hard has no permissions family, so its claims are limited to unrestricted information;
  any gbrain fix wave chosen from Hard also passes the unchanged Cat 40 permission family (C) and ships as one PR.
- **Single predicate evaluator (CEO-F29).** One function evaluates H1 predicates over a ledger; key generation and the
  50k key-equality assertion both call it.
- **Reporting (CEO-F8, CEO-F27).** The Hard report lists the models people use most first and calls out any model at ceiling.
  Per arm and family it gives success; tool calls per task; stops by kind (`turn_cap`, `no_tool_call`, `error`), reported separately; cost
  per task and per successful task; incremental cost per extra success against the comparator; agent latency without
  slot-restore time; and a family-by-arm table stating which families favor which arm.
- **Seeds (CEO-F9).** Calibration seed 20261005, smoke seed 20261099 and held-out seed 20261006 are fixed now. The
  held-out seed is written in the preregistration before the held-out world is generated and is used for both scales.
- **Statistical design (CEO-T2).** The preregistration fixes tasks per family, repeats, the gbrain commit and
  `--gbrain-config`, the decision sentences and the 50k oracle sample (the H1 tasks, whose oracle evidence gains
  near-miss records at 50k). Provisional (Taste CEO-T2): 20 tasks per family and one repeat at each
  scale (100 tasks, the same cell count as 50 × 2); the alternative is the draft's 10 tasks per family and two repeats.
<!-- /autoplan-accepted:ceo -->

#### 0H. Spec Review Loop

**Round 1** (Capy subagent on the shared machine, read both inputs in full): score 6/10, FAIL on all five dimensions,
29 numbered issues. Every issue was accepted and auto-decided (P1/P5), no new User Challenge:
- Completeness: runner deliverables named (CEO-F12); oracle evidence per family (CEO-F13); held-out miss sentences
  (CEO-F15); post-freeze models get the freeze check without retuning (CEO-F3); judge, slot-build and smoke costs added
  to the estimate; reporting order and ceilings (CEO-F8).
- Consistency: G1 now points at the provisional freeze rule; comparator rule changed from "best pooled simple arm"
  chosen after results to the same rule applied to the 4k simple-arm held-out results and committed before any gbrain
  held-out cell (keeps the user's rule, removes the post-hoc choice; fs at 50k); power computed from the freeze check's
  fs rate with a discordance assumption; calibration step cost corrected; 8 turns is a starting value and frozen knob,
  per session for H5; stop kinds reported separately; the gbrain smoke moved to its own seed.
- Clarity: calibration loop written with counts and the point-estimate rule; gbrain commit and config preregistered;
  the 50k build check is the held-out 50k build, counts only; seed retirement removed (one calibration seed); set and
  count scoring specified (CEO-F14); the "command template" test became a runner refusal with tests; 50k projection
  factors stated.
- Scope: the refusal test is recorded in CEO-F3; the Hard cap is carved out of the program authorization.
- Feasibility: the runner refuses `--scripted` for gbrain (`cat40-model-ladder.ts:389`), so the smoke is paid (about
  $5) on seed 20261099; H1 answer keys are made scale-invariant with exclusive pools and a 50k-equals-4k key test; `tsc`
  gate added.
- Cost model updated: the Hard factor is now a range (1.0×–1.8×; H5 alone can be about 1.8×), giving $1,000–1,760 with
  every arm and $720–1,250 with memory on two models.

**Round 2:** score 7/10, FAIL (Scope PASS), 27 issues. All accepted and auto-decided (P1/P5); none changes the user's
direction:
- Scoring by family (H2–H4 values via unchanged `valueVerdict`; H5 final session only, sessions 1–4 submit
  `RECORDED`; H1 JSON-array or bare-integer formats in the prompt; two more mutation cases) (CEO-F14).
- A per-model fs floor (20%) in the freeze rule; the held-out miss bar now equals the freeze rule (CEO-F6, CEO-F15).
- One ordered list of paid steps; steps 1–4 (about $110–190) may run inside the remaining authorization, steps 5–11
  wait for Garry's budget decision (CEO-F16).
- Comparator: still the user's "best pooled simple arm", restricted to arms run on every model, chosen from the 4k
  simple-arm held-out results and committed with the minimum detectable difference before any gbrain cell (CEO-F10).
- Calibration limits (5 rounds, 2 freeze checks; the freeze check reuses the passing round's two-model cells); the
  cost line is resized to $100–175 and the judge gets its own line.
- New releases replace predecessors only before held-out generation; afterwards the set is frozen so scales stay
  paired (CEO-F3, matching "Preregistered gates keep their model list").
- The 50k extension is its own pattern with near-miss distractors (shared single predicate values, never a full
  predicate) and a generation-time key-equality assertion, so 50k H1 is harder rather than hollow (CEO-F1).
- World identity includes knobs; PR #63 joins the sequencing prerequisites; 50k slots and wall-clock stated; ledger
  cap defined against other ledgers' recorded caps; `--judge none` does not satisfy the refusal; the three newer models
  named; world size held at ±25% with account count a knob; accepted requirements get their own heading.

**Round 3** (last allowed launch): score 7/10, FAIL, 26 issues (Completeness 9, Consistency 7, Clarity 5, Scope 1,
Feasibility 4). The loop stops at its three-launch cap. Every issue was accepted and applied after the round (P1/P5),
so these fixes are not reviewer-confirmed:
- H5 session failures (chain continues; `error` fails the cell; per-session stop kinds); H1 encodings and exact
  element matching (no substring), duplicates once, shared tool description unchanged; `gold.wrong` lists and the
  accepted/wrong invariant with H2–H5 mutations; authority order and effective-date rule stated to every arm in a Hard
  system prompt section; post-freeze defect rule (CEO-F17); `--scripted` exempt from the judge refusal; held-out reuse
  policy (CEO-F18); primary endpoint (pooled 4k, task-clustered bootstrap); per-family oracle floor and zero answer-key
  defects at freeze.
- Scale invariance rewritten: only account names, aliases and codes are disjoint; staff and values are shared, so
  near misses are real; appended H3 look-alikes; keys recomputed from predicates over the 50k ledger.
- Release rule: replace within family and tier; between steps 5 and 9 add at both scales; after step 9 Garry decides.
- Planning power at step 5, reported figure at step 8; oracle is a reference, not a simple arm; the Hard ledger opens at
  $3,000 minus other ledgers' caps and is raised with `set-cap` only after Garry's decision; T1 and T2 settle at the
  Phase 4 gate; calibration generated at held-out density; H6 relabelled a constraint with the sequential-depth
  rationale and tool calls per task reported; 50k storage and commit policy; the 50k oracle sample is the H1 tasks;
  50k step opens with a 5-cell smoke; builds projected from token counts; the step-5 budget decision uses measured
  calibration costs (the 1.8× top may be low).

Spec-review metrics appended to `~/.gstack/analytics/spec-review.jsonl`: iterations 3, issues found 82, fixed 56
(round 1 and 2 issues confirmed fixed by the next round), remaining 26 (applied after round 3, not re-reviewed),
quality score 7.

**0H document approval:** auto-decided A (approve these documents and continue to 0I), the recommended option; both
inputs reflect the decisions above. Reviewer Concerns in the CEO summary list the unreviewed round-3 fixes.

#### 0I. Temporal interrogation

```
  HOUR 1 (foundations):  the Hard module boundary (shared helpers lifted to module scope with v1/large byte-identical),
                         world identity (seed, scale, mode, knobs), knob schema, Family union widening under tsc.
  HOUR 2-3 (core logic): H1 predicates and near-miss generation; H2 effective-dated histories; H3 renames/merges;
                         H4 authority chains; H5 session scripts and the ideal-store note; gold.wrong invariants.
  HOUR 4-5 (integration): N-session loop, per-world turn cap, Hard scorer dispatch, oracle evidence, judge refusals,
                         50k pattern with key-equality assertions, scriptedAgent for N sessions and sets.
  HOUR 6+ (polish/tests): mutation suites, determinism tests, calibration record writer, preregistration template,
                         registry row, report section skeleton, receipts manifest entries.
```

Effort: human team about 2 weeks; CC + gstack about 1–2 days of implementation before the paid steps. Feasibility
blockers: the entity-recall merge and PR #63 (sequencing). Pending choices: CEO-T1, CEO-T2, CEO-T3 (gate).

### CEO phase: dual voices

Voice snapshot `<CEO_INPUT>`: `autoplan-ceo-nMeuyv/ceo-implementation.md` (sha256 `7029604c…`, 254 lines).

**Native CEO voice** (Capy subagent 4 on the shared machine, sent the snapshot's `nativeDispatchPrompt` verbatim;
reported model claude-opus-5-5; `INPUT: ceo 7029604c…` matches the snapshot). Verdict: approve with changes.
- F1 critical: calibration tunes until fs fails, which selects grep-hostile task shapes; calibrate on the best of fs
  and pg, cap the share of fs failures that are `turn_cap` stops at 50%, report the failure-mode mix.
- F2 high: the 8-turn cap is a puzzle-style knob; make it the last-resort knob, report turns-to-success, add a 16-turn
  rerun of the comparator and gbrain on Sonnet 5.5.
- F3 high: the run doesn't answer the decisions it cites; add an entity-recall-off ablation, a cheap standing decision
  panel, and write decision consequences now.
- F4 high: the 50k world never grows material about existing accounts; append non-deciding documents about 4k
  accounts and state which kinds of growth are modeled.
- F5 medium: families' real-world fit is assumed; compare with captured queries. F6 medium: alternatives (public
  long-memory splits, 200k, cost at fixed success) not weighed. F7 medium: self-built benchmark credibility; keep a
  private canary seed or variant; show pg and memory first. F8 medium: put the budget tiers to Garry before step 1.
  F9 medium: MDD about 10 points at 100 tasks; settle T2 on 20×1; put the planning MDD at the gate. F10 low-medium:
  build the code now stacked on the entity-recall branch; gate only paid steps on the merges.

**Codex CEO voice** (Codex CLI 0.160.0, `gpt-6-astra`, reasoning high, read-only; 67,165 tokens;
`OUTSIDE_STATUS: completed provider=codex host=claude`). Output, verbatim:

```tool-output
1. **Critical — The plan defines success as making the benchmark harder, without establishing the investment decision.** Getting fs into a 40–70% band demonstrates calibration. It does not establish that the failures matter to users or justify building entity recall, typed fields, or deeper retrieval. Comparing current master with other arms cannot identify which proposed feature would help.
   
   **Fix:** Name one consequential user workflow, the minimum improvement worth funding, and the decisions attached to positive, negative, and inconclusive results. Keep the first experiment diagnostic; require mechanism-specific evidence before choosing the subsequent fix wave.

2. **High — Difficulty can come from handicapped interfaces.** “Uncapped” leaves substantial tool limits intact: [fs grep](/home/user/.capy/work/evals-hard/eval/runner/cat40/arms.ts:85) returns at most 200 matching lines, truncates individual lines, and offers no pagination. [pg](/home/user/.capy/work/evals-hard/eval/runner/cat40/pg-arm.ts:101) returns at most 25 search results. H1 increases enumeration requirements while H6 halves sequential opportunities. An oracle pass cannot distinguish genuine memory difficulty from these restrictions.
   
   **Fix:** Preserve existing baselines, but add a separately named Hard diagnostic with exhaustive enumeration and a turn-budget sensitivity check. Require the claimed advantage to survive—or explicitly attribute it to—the interface restrictions.

3. **High — H1 ignores an obvious alternative architecture.** Accounts, renewal windows, ownership dates, and ticket status invite extraction followed by deterministic filtering and aggregation. The existing `pg` arm exposes document search, not SQL aggregation. Beating it would leave unanswered whether a small extraction pipeline solves the valuable part of this problem more cheaply.
   
   **Fix:** Before funding broad H1 coverage, test a narrow Hard-only extraction-and-query comparator built solely from public corpus evidence. Include extraction cost and errors. Use its outcome to decide whether H1 should drive memory investment or ordinary data engineering.

4. **High — Fresh seeds do not establish generalization beyond the authored world.** The [current report](/home/user/.capy/work/evals-hard/docs/benchmarks/2026-10-02-model-ladder.md:355) already identifies template dependence, including alias declarations matching a feature’s parsing pattern. CEO-F18 renews entity names and values while preserving that underlying exposure. Six months of improvements against fresh seeds could still optimize one document grammar.
   
   **Fix:** Reserve independently specified renderers, alias conventions, and document organizations before tuning. Ground their distributions in observed workflows while retaining generated tasks and ledger-derived answers. Keep that validation content sealed until its evaluation completes.

5. **High — The 50k experiment measures distractor robustness, with most meaningful growth excluded.** Appended accounts cannot change an answer, and appended updates cannot concern existing task accounts. This excludes increasing answer cardinality, accumulating history on important customers, and changes that invalidate stored knowledge. Those are central reasons a growing company might need memory infrastructure.
   
   **Fix:** Make distractor robustness the explicit scope of this experiment. Defer the expensive 50k run unless that result changes a decision; otherwise prioritize a separate generated longitudinal condition where updates legitimately change ledger answers. Preserve the existing paired condition unchanged.

6. **High — H5 provides weak evidence for dependable memory across sessions.** Four sessions acknowledge `RECORDED`; one final value determines success. That can miss lost decisions, collateral overwrites, and stale facts that the final question never probes. The oracle receives an already reconciled “ideal store,” so its score establishes final-answer readability without validating the storage-and-correction process.
   
   **Fix:** Add Hard-specific checks for retained, superseded, and unrelated facts across the chain. Require final probes to depend on multiple earlier sessions. Describe the oracle as an ideal-state reference, and use separate diagnostics to distinguish failures to save, update, retrieve, and interpret.

7. **High — The endpoint does not represent a clear deployment choice.** One pooled comparator across five models can conceal a better simple arm for a particular model. Excluding `memory` from comparator eligibility when its expensive models are omitted makes the comparator depend on spending choices. Switching to fs at 50k further narrows the claim.
   
   **Fix:** Define the deployment decision and weighting before running. Report paired comparisons against every measured simple arm, name missing comparisons, and use the same arm when estimating scale effects. A pooled win should not override a loss on the model selected for deployment.

8. **High — Accuracy can improve while the product remains economically unattractive.** Cost per successful task is descriptive; there is no acceptance threshold for incremental cost, latency, ingestion, or ongoing maintenance. The [report](/home/user/.capy/work/evals-hard/docs/benchmarks/2026-10-02-model-ladder.md:301) already documents a separate cost problem. A harder benchmark can create accuracy separation without making gbrain worth adopting.
   
   **Fix:** Preregister an economically meaningful threshold: additional successful tasks per incremental dollar, a latency limit, and ingestion costs amortized over a stated workload. Separate harness restoration overhead from user-facing latency. Evaluate all of this using the permitted frontier models.

9. **High — The authorized preliminary work has no funded path to a conclusive result.** Even the reduced estimate starts at $740 against roughly $500 remaining. Steps 1–4 can consume money producing a calibrated benchmark whose principal measurement still requires another authorization. Moreover, fs/oracle calibration and a five-cell Sonnet gbrain smoke provide thin evidence for expensive gbrain cells across models and scales. The old scale ratios also come from runs affected by the [documented search degradation](/home/user/.capy/work/evals-hard/docs/benchmarks/2026-10-02-model-ladder.md:6).
   
   **Fix:** Specify a complete, smaller experiment and its decision before spending on calibration. Reduce families, scales, or redundant comparisons while preserving the required model policy and adequate task coverage. If that complete experiment cannot fit the remaining authorization, obtain the incremental budget first.

10. **Medium — Dropping permissions removes a demonstrated reason to adopt the system.** The report identifies permission handling as a material distinction. Hard excludes it while presenting questions about whether memory raises agent capability. Retrieval gains on unrestricted information do not establish usefulness in a company where access boundaries and derived information matter.
    
    **Fix:** Keep Hard’s claims explicitly limited to its unrestricted workload. Any later adoption or fix-wave decision should also pass the unchanged Cat 40 permission evaluation. Ship that fix wave as one PR with both capability and permission evidence.

Recommendation: Re-scope before paid calibration because the current plan can exhaust the remaining authorization without establishing a generalizable, economically worthwhile reason to choose gbrain.
```

Verification of outside claims: `FsArm` grep returns at most 200 matches and cuts lines at 300 characters
(`arms.ts:90,98`, confirmed); `PgArm` searches return at most 25 rows (`pg-arm.ts:104`, confirmed); the scale-tier
gbrain ratio (1.3×) came from the release build under the ledger stall (confirmed by the report's correction), the fs
ratio (1.8×) did not (fs makes no proxy calls).

```
CEO DUAL VOICES — CONSENSUS TABLE:
  Dimension                            Claude  Codex  Consensus
  1. Premises valid?                    Partly  Partly CONFIRMED: ceiling premise holds; "fs failing = memory difficulty" is assumed
  2. Right problem to solve?            Yes*    Yes*   CONFIRMED with condition: tie the run to named decisions (native F3, Codex 1)
  3. Scope calibration correct?         No      No     CONFIRMED: 50k misses growth about existing entities (F4 / 5); budget before calibration (F8 / 9)
  4. Alternatives sufficiently explored? No     No     CONFIRMED: native F6 (public splits, 200k); Codex 3 (extraction + SQL for H1)
  5. Competitive/market risks covered?  No      No     CONFIRMED: self-built generator overfitting (F7 / 4)
  6. 6-month trajectory sound?          No      No     CONFIRMED: turn cap and interface limits can manufacture the gap (F1–F2 / 2)
CONFIRMED = completed subagent + outside; primary cannot replace outside.
```

Single-voice criticals: native F1 (critical) is echoed by Codex 2 (high), so it is not single-voice. Codex 1 (critical)
is echoed by native F3 (high).

**Classification of every voice finding (auto-decided unless a User Challenge):**

| Finding | Voices | Disposition |
|---|---|---|
| Turn cap as the main difficulty source; make it a last-resort knob starting at 16 | native F2, Codex 2 | **User Challenge CEO-UC1** (changes the user's H6); the original 8 stays |
| Turn-budget sensitivity check and turns-to-success | native F2, Codex 2 | ACCEPTED CEO-F19 (works with 8 turns) |
| Calibrate on the better of fs and pg; at most 50% of the comparator's failures may be `turn_cap` | native F1 | ACCEPTED into CEO-F20, provisional within Taste CEO-T1 |
| Interface limits (grep 200 matches, 300-character lines, pg 25 rows) create difficulty | Codex 2 | **Taste CEO-T4**: lift them on Hard worlds only (v1 unchanged), provisional |
| Name the decisions and their consequences now | native F3, Codex 1 | ACCEPTED CEO-F21 |
| Entity-recall-off ablation arm | native F3 | **Taste CEO-T5**: recommend defer (no verified config switch; keep this run the baseline) |
| Standing cheap decision panel for later changes | native F3 | DEFERRED to TODOS.md |
| 50k adds non-deciding material about 4k accounts; scope stated | native F4, Codex 5 | ACCEPTED CEO-F22 |
| Defer the 50k run until the 4k result | Codex 5, 9 | **Taste CEO-T3** budget tiers (tier C defers 50k) |
| Budget decision before any paid step | native F8, Codex 9 | ACCEPTED: CEO-F16 revised (no paid step before Garry's decision at the gate) |
| Sealed validation variant (independent renderers, alias conventions, private seed) | native F7, Codex 4 | **User Challenge CEO-UC2** (adds a deliverable) |
| Ground families in observed failures | native F5, Codex 4 | DEFERRED to TODOS.md with UC2 |
| Extraction + SQL comparator for H1 | Codex 3 | **Taste CEO-T7**: recommend defer to TODOS.md |
| Public long-memory splits, 200k scale, cost at fixed success | native F6 | Recorded: public splits are tracked separately (LongMemEval, Cat 13); 200k skipped (CEO-E4); cost at fixed success is reported via CEO-F27 |
| Report against every simple arm; same arm across scales | Codex 7 | ACCEPTED CEO-F23 |
| H5 checks retained, superseded and unrelated facts; final question depends on 2+ sessions | Codex 6 | ACCEPTED CEO-F24 |
| Economic threshold | Codex 8 | **Taste CEO-T8**: recommend report-only (CEO-F27), no gate |
| Claims limited to unrestricted workloads; fix waves also pass Cat 40 permissions | Codex 10 | ACCEPTED CEO-F25 |
| Build code now, stacked on entity-recall; gate paid steps on merges | native F10 | ACCEPTED CEO-F26 (revises CEO-F2) |
| Settle T2 on 20×1; planning MDD at the gate | native F9 | Gate content (T2 recommendation unchanged; planning MDD about 10 points) |

### CEO phase: review sections

Current scope: mode SELECTIVE EXPANSION (autoplan override). Accepted: CEO-F1 to CEO-F27 as recorded. Provisional
Taste: CEO-T1 (freeze rule incl. F20), CEO-T2 (20×1), CEO-T4 (Hard-only uncapped tools). Pending at the gate: CEO-T3,
CEO-T5, CEO-T7, CEO-T8, CEO-UC1, CEO-UC2. Deferred: CEO-E2, CEO-E3, decision panel, real-failure grounding. Skipped:
CEO-E4.

**Section 1: Architecture.**

```
  model-ladder-gen.ts ──(shared helpers lifted, v1/large byte-identical)──┐
        │                                                                 ▼
        │                                        model-ladder-hard.ts (H1–H5, knobs, 50k pattern,
        │                                          key-equality assertions) ──► world.json {seed, scale,
        ▼                                                                         mode:'hard', knobs, turn_cap}
  cat40-model-ladder.ts ──► regenerate(seed, scale, mode, knobs) == digest? ──► refuse on mismatch
        │   Hard guards: --judge required, no gpt-5.4-mini, priced models
        ├─► cat40/loop.ts (maxTurns from world; N sessions)
        ├─► cat40/arms.ts (Hard tool options: uncapped grep/pg, Taste T4) ; OracleArm.evidence(hard)
        ├─► cat40/score-hard.ts (H1 set/count) ──imports──► score.ts (unchanged, hash 8a448051…)
        └─► budget-ledger.ts (.budget/cat40-hard.sqlite) ; analyze.ts / holdout_stats (clustered bootstrap)
```

Coupling: the Hard module imports v1 helpers; v1 imports nothing from Hard, so v1 cannot change through Hard. The
runner gains a mode switch; every Hard-only behavior keys off `world.mode === 'hard'`, so a v1 world takes exactly
today's path. Data flows: happy (world regenerates, cells run, scorer dispatches); nil (a v1 world has no `mode`, so
it defaults to v1); empty (an H1 key that is the empty set is rejected at generation, since "none" answers are not a
Hard family); error (regeneration mismatch refuses before any spend). Scaling: the 50k step is the hot path (12 hours
of restores on 5 slots, CEO-F7). Rollback: generator and runner changes ship in one PR; reverting it restores v1
exactly, and `--check` proves it. Security architecture: no new endpoint; the trust boundary is unchanged (the runner
is a trusted local CLI). Findings: the architecture needs the shared helpers moved out of the
`generateLadderWorld` closure (Eng owns the refactor; `--check` and the large digest are the guard, already in CEO-F2).
No new decision.

**Section 2: Error & Rescue Map.**

```
  CODEPATH                         | WHAT CAN GO WRONG                          | FAILURE CLASS
  ---------------------------------|--------------------------------------------|----------------------------
  Hard generator                   | draw() exhausts a pool (MAX_DRAWS)         | Error('ran out of …')
                                   | 50k key differs from 4k key                | Error (generation assertion)
                                   | accepted value is a substring of a wrong   | Error (generator invariant)
  Runner world load                | digest mismatch (knobs omitted)            | Error, refuse before spend
  Runner Hard guards               | missing --judge / gpt-5.4-mini / unpriced  | Error, refuse with fix line
  N-session loop                   | session k turn_cap / no_tool_call          | recorded stop kind, chain continues
                                   | session k provider error                   | cell error, rerun as one unit
  gbrain slot (Hard docs)          | slot build fails / coverage incomplete     | Error, step halts
                                   | restore stalls                             | restore_ms recorded; step halts on error
  Hard scorer                      | answer not parseable as array / integer    | scored miss (not an error)
  Judge (GPT-6.1 Sol)              | provider error / unparseable JSON          | judge_error, claims null, cell kept
  Ledger                           | remaining < projection + 15%               | stop for Garry
```

```
  FAILURE CLASS               | RESCUED? | RESCUE ACTION                         | OPERATOR SEES
  ----------------------------|----------|---------------------------------------|------------------------------
  draw() exhaustion           | N (by design) | knob change, rerun generation    | thrown message naming the pool
  50k key mismatch            | N (by design) | generator bug fix before step 5  | thrown message naming the task
  digest mismatch             | Y        | refuse; print the regeneration command | refusal with exact command
  guard refusal               | Y        | refuse; print the fix                  | refusal naming file and line
  session error               | Y        | cell error; resume reruns the chain    | error count in receipt
  slot build failure          | Y        | step halts                             | build log + coverage record
  unparseable answer          | Y        | scored miss                            | per-task field in results
  judge error                 | Y        | claims null, run kept                  | judge_error field
  budget shortfall            | Y        | stop for Garry                         | projection vs remaining
```

No silent failure: each class ends in a refusal, a recorded field or a halt. **GAP (accepted as CEO-F28):** the runner
has no record of which session in an H5 chain failed; per-session stop kinds are already in CEO-F12, so the gap is
closed by adding the failing session index to the cell's `error` field. Auto-decided (P1, in blast radius, S).

**Section 3: Security & Threat Model.** No new endpoint, credential or dependency. Inputs are generator knobs and
CLI flags from a trusted local operator. The relevant threats are evaluation integrity, not attack: (a) held-out
leakage through an operator or agent reading the held-out world (likelihood Med, impact High; mitigated by writing it
under an ignored path, the generation-time assertions, and CEO-F18 fresh seeds for later work); (b) prompt injection
from corpus documents into the agent (Low/Low: the corpus is generated, and "confidently wrong agent notes" are
deliberate and identical across arms); (c) API keys in receipts (Low/High: existing `receipt.ts scrub` applies). No
new issue beyond those already mitigated.

**Section 4: Data flow & interaction edge cases.**

```
  knobs+seed ─► VALIDATE (knob ranges, pool sizes) ─► GENERATE (ledger first) ─► ASSERT (keys, invariants)
      │ nil: defaults recorded       │ out of range: refuse   │ pool exhausted: throw  │ mismatch: throw
      ▼
  world.json ─► RUNNER (regenerate == digest) ─► CELLS (N sessions) ─► SCORE (set/count/value) ─► results.jsonl
                 │ mismatch: refuse              │ error: rerun chain   │ unparseable: miss      │ resume by key
```

Async ordering: cells share the ledger (SQLite, already serialized and tested) and gbrain slots (pool acquire/release,
restore after every cell, unchanged). An H5 chain holds one slot for all five sessions; a resume after a crash
mid-chain must not keep the earlier sessions' writes. Invariant: every H5 cell starts from a restored slot. The pool
already restores in `finally`, so a crash between sessions still restores before release; the regression test runs
a scripted chain that fails in session 3 and checks the slot digest after restore (Eng test plan). Interaction edge
cases (operator): rerunning a step with a changed knob set is refused by `experiment.json`; zero tasks in a family
(knob error) is refused at generation; a world with 50k docs and 5 slots is the largest case and is covered by the
50k smoke (CEO-F16 step 11).

**Section 5: Code quality.** Fits existing patterns: a generator module beside `model-ladder-gen.ts`, a scorer module
beside `score.ts`, mode-keyed branches in the runner. DRY risk: H2–H4 must reuse `accountRecords`, `transcript`,
`ref` and the authority ladder from family A rather than copy them; the plan already lifts these helpers. Naming:
`score-hard.ts`, `model-ladder-hard.ts`, `mode: 'hard'`. Over-engineering risk: a general "difficulty DSL" for knobs
is not needed; a typed `HardKnobs` object is enough. Complexity: the H1 predicate evaluator should be one small
function shared by key generation and the 50k key-equality test, so the test cannot drift from the generator. That
sharing is a finding: **accepted CEO-F29**, the predicate evaluator is the single source for keys and for the
invariance test (P4).

**Section 6: Tests.**

```
  NEW THING                         | TEST TYPE    | HAPPY                        | FAILURE                         | EDGE
  ----------------------------------|--------------|------------------------------|---------------------------------|-----------------------------
  Hard generator determinism        | unit         | same seed+knobs = same digest| different knobs = new digest    | knobs omitted = defaults
  v1/large unchanged                | unit + check | --check passes, large digest | any byte change fails           | lifted helpers only
  H1 keys / near misses             | unit         | key = predicate over ledger  | 50k member added -> fail        | 10 and 40 members
  H2–H5 gold.wrong invariant        | unit         | pairwise distinct            | substring collision -> throw    | normalized dates
  50k key equality + H3 uniqueness  | unit         | calibration/smoke seeds      | injected collision -> throw     | appended look-alike
  Runner identity (mode, knobs)     | unit         | regenerates                  | knob drift -> refuse            | v1 world w/o mode
  Per-world turn cap                | unit         | Hard 8, v1 16                | -                               | H5 per session
  N-session chain (scripted)        | integration  | 5 sessions, final scored     | error in s3 -> cell error       | turn_cap in s2 continues
  Hard guards                       | unit         | --judge gpt-6.1-sol passes   | none / mini / unpriced refuse   | --scripted exempt
  Set/count scorer                  | unit+mutation| exact set, alias match       | empty, all, off-by-one, namesake| prose, date-before-count
  Value families scorer             | mutation     | correct value                | stale, look-alike, hedged       | -
  Oracle evidence                   | unit         | contains deciding docs       | missing doc -> fail             | H1 near-miss cap
  Hard tool options (T4)            | unit         | Hard grep uncapped           | v1 grep still 200/300           | total always reported
```

Ship-at-2am test: the scripted hermetic Hard run end to end (`--scripted --arms fs,memory,oracle` on a calibration
world) with the v1 `--check` in the same CI job. Hostile-QA test: an answer listing a namesake's former name as a
member. Chaos test: kill the runner mid-H5 chain and resume. Flakiness: none of these depend on time or providers.
No LLM prompt file changes beyond the new Hard system-prompt section, which the oracle and every arm share.

**Section 7: Performance.** The generator builds about 50k documents in memory (v1-large already does, about 52k).
Hot paths: the 50k slot builds (86 min each, serial) and restores (75–100 s). Projected from token counts (CEO-F4).
The uncapped grep on 50k (Taste CEO-T4) can return thousands of lines per call; cost is measured in the 50k smoke and
projected before the 50k step. No new database queries in the runner.

**Section 8: Observability.** The calibration record (CEO-F6) is the dashboard for tuning; receipts carry knobs, world
digest, stop kinds by session, tool calls per task and cost; the ledger records every reservation. Debuggability:
transcripts (`--transcripts`) are kept for every Hard cell, so a failure three weeks later is reconstructable. Runbook:
each stop-for-Garry condition (projection shortfall, freeze not reached, generator change after step 5, 50k smoke
error) names the command that resumes. No gaps beyond CEO-F28.

**Section 9: Deployment & rollout.** No production deploy. "Rollout" is the paid-step sequence (CEO-F16) with a halt at
each step. Rollback: a failed step leaves earlier receipts intact; the experiment binding refuses mismatched resumes.
Partial-deploy risk: entity-recall merging mid-implementation (CEO-F26 handles it by stacking and rebasing before any
paid step). Post-step verification: each step's receipt is checked against its projection and its cell count.

**Section 10: Long-term trajectory.** Debt: one more generator mode and a mode switch in the runner (small). Path
dependency: the Hard knobs become the difficulty dial for later tiers. Reversibility: 4/5 (code reverts cleanly;
money spent does not). Knowledge: the calibration record and preregistration explain every choice. The 1-year
question: an engineer reading `model-ladder-hard.ts` sees families, knobs and invariants in one file. Phase 2 is the
deferred decision panel and family D; the platform is the knob dial. Retrospective on cherry-picks: the 50k pattern
(CEO-F1/F22) and the comparator rule (CEO-F10/F23) were load-bearing and are accepted.

**Section 11: Design.** SKIPPED (no UI scope).

#### CEO required outputs

**NOT in scope.**
- Deferred (TODOS.md, "Cat 40 Hard follow-ups"): family D on Hard (CEO-E2); real-harness arms (CEO-E3); a cheap
  standing decision panel for later gbrain changes (native F3); grounding families in observed failures (native F5,
  Codex 4); an extraction + SQL comparator for H1 if Garry takes the Taste CEO-T7 recommendation.
- Rejected: a 500k scale (CEO-E4, no evidence 50k is insufficient).
- Held for the gate: CEO-UC1, CEO-UC2, CEO-T3, CEO-T5, CEO-T7, CEO-T8.

**What already exists.** Covered in 0B: the ledger-first generator and its helpers, families A/B/E/F (lite versions of
H4/H2/H3/H5), `--scale large`, the staged slot build, the SQLite ledger, `analyze.ts` and `holdout_stats`. The plan
reuses all of them; only the set/count scorer, N sessions, the per-world turn cap and the 50k Hard pattern are new.

**Dream state delta.** After this plan, Cat 40 has a calibrated Hard tier with one held-out baseline at 4k (and 50k
if funded) on the five frontier models. Still missing against the 12-month ideal: real harnesses, family D, a cheap
decision panel for each gbrain change, and grounding in observed failures.

**Error & Rescue Registry.** The two Section 2 tables are the registry: 11 failure classes, every one rescued or
refused with an operator-visible message; 0 critical gaps (CEO-F28 closes the one gap found).

**Failure Modes Registry.**

```
  CODEPATH              | FAILURE MODE                        | RESCUED? | TEST? | USER SEES?          | LOGGED?
  ----------------------|-------------------------------------|----------|-------|---------------------|--------
  calibration           | band unreachable in 5 rounds        | Y (stop) | n/a   | calibration table   | Y
  calibration           | difficulty from turn cap only       | Y (F20)  | Y     | stop-kind mix       | Y
  generator             | 50k changes an answer key           | Y (throw)| Y     | thrown message      | Y
  generator             | accepted/wrong value collision      | Y (throw)| Y     | thrown message      | Y
  runner                | world/knob drift                    | Y        | Y     | refusal             | Y
  runner                | gpt-5.4-mini or unpriced model      | Y        | Y     | refusal + fix line  | Y
  H5 chain              | mid-chain crash                     | Y        | Y     | error + session idx | Y
  gbrain slot           | build or restore failure            | Y        | smoke | step halts          | Y
  scorer                | substring false positive (H1)       | Y        | Y     | n/a (exact match)   | -
  ledger                | projection above remaining          | Y        | Y     | stop for Garry      | Y
  report                | ceiling read as tie                 | Y (F15)  | n/a   | "uninformative"     | Y
```

0 CRITICAL GAPS.

**Approval readiness:** PASS. Checked rows CEO-F1 to CEO-F29 and CEO-T1, CEO-T2, CEO-T4 (provisional), each by an
autoplan auto-decision under the user's instruction to auto-decide every intermediate question; User Challenges
CEO-UC1 and CEO-UC2 and Taste CEO-T3, T5, T7, T8 stay pending for the gate and are not in accepted work.

```
  +====================================================================+
  |            MEGA PLAN REVIEW — COMPLETION SUMMARY                   |
  +====================================================================+
  | Mode selected        | SELECTIVE EXPANSION                         |
  | System Audit         | entity-recall + PR #63 unmerged; judge      |
  |                      | default gpt-5.4-mini; one global turn cap;  |
  |                      | no set scorer; Fable unpriced on main       |
  | Step 0               | 29 accepted rows, 3 provisional Taste, 3    |
  |                      | spec-review rounds (6, 7, 7 of 10)          |
  | Section 1  (Arch)    | 1 issue (helper lift; guarded by CEO-F2)    |
  | Section 2  (Errors)  | 11 error paths mapped, 1 GAP (closed F28)   |
  | Section 3  (Security)| 3 issues found, 0 High severity unmitigated |
  | Section 4  (Data/UX) | 6 edge cases mapped, 0 unhandled            |
  | Section 5  (Quality) | 1 issue found (shared evaluator, F29)       |
  | Section 6  (Tests)   | Diagram produced, 0 gaps                    |
  | Section 7  (Perf)    | 1 issue found (uncapped grep at 50k cost)   |
  | Section 8  (Observ)  | 0 gaps found beyond F28                     |
  | Section 9  (Deploy)  | 1 risk flagged (merge order, F26)           |
  | Section 10 (Future)  | Reversibility: 4/5, debt items: 1           |
  | Section 11 (Design)  | SKIPPED (no UI scope)                       |
  +--------------------------------------------------------------------+
  | NOT in scope         | written (6 items)                           |
  | What already exists  | written                                     |
  | Dream state delta    | written                                     |
  | Error/rescue registry| 11 rows, 0 CRITICAL GAPS                    |
  | Failure modes        | 11 total, 0 CRITICAL GAPS                   |
  | TODOS.md updates     | 4 items proposed (written at commit)        |
  | Scope proposals      | 33 proposed, 29 accepted (EXP + SEL)        |
  | CEO plan             | written (ceo-plans/2026-10-05-cat40-hard.md)|
  | Outside voice        | codex completed (gpt-6-astra)               |
  | Lake Score           | 6/6 recommendations chose complete option   |
  | Diagrams produced    | architecture, data flow, error tables, test |
  | Stale diagrams found | 0                                           |
  | Unresolved decisions | 9 (gate: UC1, UC2, T1–T5, T7, T8)           |
  +====================================================================+
```

Unresolved decisions (all for the Phase 4 gate): CEO-UC1, CEO-UC2, CEO-T1, CEO-T2, CEO-T3, CEO-T4, CEO-T5, CEO-T7,
CEO-T8. (There is no CEO-T6.)

CEO close: packet `autoplan-ceo-N8lfjL/close-packet.md` (337 lines) read in full and verified against the accepted
decisions; phase report published.

### Phase 2 (Design): skipped, no UI scope detected. Not a completed review.

### DX phase (Phase 2.5)

Methodology: `autoplan-dx-methodology-z0zDlz/methodology.md` (2,175 lines) read at offsets 1, 504, 1104 and 1674 through
EOF (all ranges). Mode: **DX POLISH** (autoplan override). DX snapshot and amendment checkpoint `<DX_INPUT>`:
`autoplan-dx-so7FvC/dx-implementation.md` (sha256 `8a3becc6…`).

#### Step 0

**Product type** (auto-decided): a benchmark CLI and documentation product. The surfaces are the generator CLI
(`model-ladder-gen.ts`), the runner CLI (`cat40-model-ladder.ts`, `analyze.ts`), the registry row, the runbook, the
preregistration and the published report.

**Persona** (auto-decided from `AGENTS.md`, "GBrain assumes an agent operator", and `CLAUDE.md`):

```
TARGET DEVELOPER PERSONA
========================
Who:       an AI coding agent (Capy, Claude Code, Codex) operating gbrain-evals for Garry, sometimes a human engineer
Context:   told "run Cat 40 Hard step N" in a fresh checkout, with keys in the environment and a dollar authorization
Tolerance: zero tolerance for ambiguity that costs money; will follow exact argv, will improvise when none exists
Expects:   copy-paste commands per step, a $0 path to prove the plumbing, refusals that say what to run next
Secondary: an engineer reading the Hard report to decide whether to try gbrain (CLAUDE.md's reader)
```

**Empathy narrative (predicted from the plan and current code, not observed).** "I'm told to start Hard calibration
round 1. The plan says the generator 'gains a hard mode', but `model-ladder-gen.ts --help` doesn't exist and the CLI
takes `--seed`, `--scale large`, `--out`, `--check`; there's no `--mode` or knob flag to pass. I guess at one. For the
runner I copy the registry's Cat 40 command; it has no `--judge`, so on a Hard world it would refuse, and on v1 it
would silently use gpt-5.4-mini. To prove the plumbing I try `--scripted`, but the default arms include gbrain and the
runner refuses scripted gbrain. The freeze rule has seven conditions; I compute them by hand from `results.jsonl`. A
provider hiccup writes an `error` record that my resume treats as done. Before step 5 I'm supposed to compute the
ledger cap from every other ledger's recorded cap, by hand. I would finish, but I'd improvise at every step, and
improvisation in a paid campaign is how the last two waves ended up with harness artifacts in their results."

**Competitive DX benchmark** (internal tooling; web research does not apply; references are this repository's own
paths):

| Tool | Start → result | Time + evidence type | DX choice | Source |
|---|---|---|---|---|
| Cat 40 v1 | checkout → scripted cells | ~1 min, estimated from the documented 3-command reproduce block | `--check`, `--scripted` | `2026-10-02-model-ladder.md` "Reproduce" |
| Cat 40 follow-ups campaign | checkout → step list | ~1 min, estimated | `scripts/cat40-followups.sh` with `PRINT_ONLY=1` | `scripts/cat40-followups.sh` |
| `bun eval/runner/all.ts --only <id>` | checkout → hermetic category verdict | < 60 s target, registry CI budget | one command per category | `eval/CONTRIBUTING.md` step 9 |
| Cat 40 Hard (draft) | checkout → anything runnable | undefined: no commands named, > 10 min of code reading | none | this plan |

**TTHW:** current undefined (Red Flag, > 10 min). Target (auto-decided, recommended): **Champion, < 2 minutes** from a
checkout with dependencies installed to a $0 scripted Hard run covering H1–H5 with a per-family table. Feasible: the
scripted path exists and runs in seconds.

**Magical moment** (auto-decided, lowest-effort vehicle using existing capabilities): one command,
`scripts/cat40-hard.sh hello`, generates a calibration-seed Hard world and runs it `--scripted` on fs, memory and
oracle, printing per-family rows, a five-session H5 chain and an H1 set answer scored, plus the freeze-rule table, at
$0 in under a minute.

**Journey map (0F)** and **first-time confusion report (0G)**:

```
STAGE           | DEVELOPER DOES                                  | FRICTION POINTS                         | STATUS
----------------|-------------------------------------------------|-----------------------------------------|--------
1. Discover     | finds Hard in registry / README / RUNBOOK        | no row, no guide, v1 examples refuse    | fixed (DX-F5, F9)
2. Install      | bun install in the checkout                     | pg arm needs OPENAI key, not stated     | fixed (DX-F13 preflight)
3. Hello World  | scripted Hard run                               | no command; default arms refuse         | fixed (DX-F1)
4. Real Usage   | 11 paid steps                                   | no argv; manual projection and caps     | fixed (DX-F4, F6, F13)
5. Debug        | a step fails or a stop fires                    | errors counted done; stops unparsed     | fixed (DX-F7, F12)
6. Upgrade      | runner or scorer changes mid-campaign            | resume mixes evaluator versions         | fixed (DX-F14)
```

```
FIRST-TIME DEVELOPER REPORT
============================
Persona: agent operator
Attempting: Cat 40 Hard calibration round 1
T+0:00  Reads the plan; finds no command. Opens model-ladder-gen.ts usage line (seed/scale/out/check only).
T+0:30  Tries --mode hard; the generator ignores unknown flags and writes a v1 world.
T+1:00  Runs the runner --scripted with default arms; refused for gbrain.
T+2:00  Copies the registry Cat 40 command; no --judge; plans to compute the freeze rule by hand.
T+3:00  Gives up on a clean path and improvises; the campaign starts without a $0 proof.
```

#### Dual voices

**Claude SUBAGENT (DX — independent review)** (Capy subagent 5, shared machine, `nativeDispatchPrompt` verbatim;
reported model claude-opus-5-5; `INPUT: dx 8a3becc6…` matches the snapshot). It read the plan and checked claims
against `/workspace/gbrain-evals` on `feat/cat40-entity-recall` (read-only). Findings: no free scripted first run
(high); registry row lacks a runnable Hard command (medium); `--max-turns` override missing for the 16-turn check
(high); no knob interface, `--knobs` with a frozen file (high); 4k/50k vocabulary vs `--scale large` (medium); judge
default still gpt-5.4-mini, refusal must print the exact flag (medium); tool descriptions must state Hard defaults
(medium); H1 answer must be schema-conformant, one JSON-encoded string with literal examples (high); freeze rule needs
an analyzer that prints PASS/FAIL per condition (high); held-out assertion failures must not print held-out content
(high); stop-for-Garry points need exit 3 and stable codes (medium); world-identity mismatch message (medium); no
operator runbook with argv before step 1 (high); body text contradicts accepted requirements (medium); output paths
unnamed (medium); ledger cap computed by hand (medium); per-cell resume confirmation (medium); no flag to select the
CEO-T4 alternative (medium).

**Codex SAYS (DX — developer experience challenge)** (gpt-6-astra, high reasoning, read-only, 93,788 tokens,
`OUTSIDE_STATUS: completed provider=codex host=claude`), verbatim:

```tool-output
The plan has strong experimental controls, but the operator workflow is underspecified. These findings use the supplied plan and repository code; onboarding time was not measured.

1. **[high] The under-five-minute hello world is not established.** From a bare machine, the implied path has at least six actions: install Bun, clone, install dependencies, generate a Hard world, run scripted cells, and inspect results. There is no complete Hard example or expected output. Moreover, `--scripted` alone inherits arms including gbrain and then refuses to run ([runner defaults](/home/user/.capy/work/evals-hard/eval/runner/cat40-model-ladder.ts:345)). **Fix:** provide a timed, copy-paste walkthrough with explicit prerequisites and a free smoke covering H1–H5, including all five H5 sessions. Print the receipt location and distinguish successful plumbing from benchmark accuracy. Make scripted defaults select supported hermetic arms.

2. **[high] CLI mistakes can silently select the wrong experiment.** Both entrypoints use permissive argument parsing without a help branch. Unknown options are ignored; misspelled task/family selections can produce “nothing to run” and return successfully. The contribution guide advertises `--output`, while Cat40 uses `--out` ([generator CLI](/home/user/.capy/work/evals-hard/eval/generators/model-ladder-gen.ts:551), [shared conventions](/home/user/.capy/work/evals-hard/eval/CONTRIBUTING.md:71)). **Fix:** specify Hard’s exact mode, scale, knob-file and task-density flags; reject unknown options, invalid numbers and empty selections before writes. Add side-effect-free `--help` and compatibility aliases. Define a recorded per-run turn-cap override for sensitivity checks so operators need not edit frozen worlds.

3. **[high] Failed-cell recovery contradicts the promised H5 resume behavior.** Provider exceptions become `stop: error`, but those records are written and subsequently treated as done. Separately, some exceptions that prevent a record are logged without making the process exit unsuccessfully ([error conversion](/home/user/.capy/work/evals-hard/eval/runner/cat40/loop.ts:169), [resume bookkeeping](/home/user/.capy/work/evals-hard/eval/runner/cat40-model-ladder.ts:374), [completion handling](/home/user/.capy/work/evals-hard/eval/runner/cat40-model-ladder.ts:452)). Naming the failed H5 session does not fix this. **Fix:** define retryable infrastructure errors separately from scored failures, return nonzero for incomplete required work, and print an exact resume command. Retry an H5 chain atomically, preserve attempt costs, prevent duplicate counted cells, and permit judge-only recovery without repeating successful agent work.

4. **[high] The accepted refusals do not provide a complete prerequisite check.** Explicit judge and price validation are useful, but operators also need to know which credentials and resources the selected arms require. The pg arm performs OpenAI embeddings; a Sonnet calibration therefore needs more than an Anthropic key. Missing credentials currently surface through provider errors ([embedding setup](/home/user/.capy/work/evals-hard/eval/runner/cat40/pg-arm.ts:41)); the [runbook prerequisite table](/home/user/.capy/work/evals-hard/eval/RUNBOOK.md:20) omits Cat40. **Fix:** add a no-charge preflight listing required environment-variable names, resolved models, world identity, cell count, slot coverage, ledger and projection. Every refusal should identify what failed, why, and the corrective command, without exposing secrets.

5. **[high] Eleven ordered steps still require operators to assemble the campaign manually.** The accepted sequence prevents conceptual ambiguity, but does not specify executable commands or durable progress tracking. An agent must reconstruct round sampling, output directories, comparator commits, funded scales and budget headroom. The repository already has a [step-oriented campaign script](/home/user/.capy/work/evals-hard/scripts/cat40-followups.sh:8). **Fix:** deliver an equivalent Hard entrypoint with print-only planning and status. Each step should derive its command from the approved configuration, verify predecessor artifacts and the existing budget decision, and report completed versus outstanding work. This implements the accepted gate without adding another approval ceremony.

6. **[high] Documentation discovery currently leads to incompatible instructions.** The linked Cat40 protocol demonstrates models and `--judge none` that Hard will reject ([existing examples](/home/user/.capy/work/evals-hard/docs/benchmarks/2026-10-02-model-ladder-protocol.md:144)). The plan also retains superseded descriptions: fs/oracle calibration versus the accepted pg addition, and appended-account-only growth versus accepted material about existing accounts. **Fix:** add one canonical Hard operator guide, linked from the README, runbook, contribution guide and registry. Preserve historical v1 examples with explicit labels. Consolidate accepted requirements into the main workflow; after the pending decisions, publish one resolved configuration and complete commands for each funded step.

7. **[high] Byte-identical v1 worlds do not establish a safe upgrade path.** Experiment identity binds the world, gbrain commit and flags, but not the evaluator/scorer revision ([manifest contract](/home/user/.capy/work/evals-hard/eval/runner/cat40-model-ladder.ts:280)). A resume after an evaluator update can therefore combine different behavior. H5 also changes result shape: existing analysis reads only `run` and `session1` for cost breakdowns ([analysis assumptions](/home/user/.capy/work/evals-hard/eval/runner/cat40/analyze.ts:94)). **Fix:** version Hard artifacts and record evaluator, scorer and effective configuration identities. Define which upgrades permit resume, require offline rescoring, or require a new run. Keep readers for historical records and document compatibility errors with exact recovery instructions.

8. **[high] H1’s answer contract needs an explicit schema change.** The plan accepts native arrays, while both `SubmitPayload.answer` and the advertised tool schema currently require strings ([submission contract](/home/user/.capy/work/evals-hard/eval/runner/cat40/loop.ts:35)). Updating the scorer alone leaves compliant clients unable to express an advertised valid answer. **Fix:** explicitly require a Hard-specific schema accepting strings and string arrays, with matching types and provider serialization checks, while preserving v1 behavior. Include complete set/count examples and explain format failures separately from incorrect answers.

9. **[medium] The report specifies many metrics without a quick path to verification or adoption.** Engineers comparing alternatives need to find the relevant workload, inspect a failure, and reproduce a table without rerunning paid models. The plan promises analysis commands but not a discoverable, tested reproduction package. Agent latency excluding restores also needs operational context when restores take 75–100 seconds. **Fix:** publish a report entrypoint linking headline comparisons to family results, receipts and representative transcripts, plus one offline table-reproduction command. Show setup cost and end-to-end latency beside the accepted agent-only metrics, and prominently state synthetic-data, permissions and turn-cap limitations.

Recommendation: revise the plan before implementation because its free onboarding path, CLI contract and failed-run recovery are not yet reliable enough for unattended paid operation.
```

Verification of outside claims: a provider exception becomes `run.stop = 'error'` (`loop.ts:169–172`) and the record is
written; resume treats every recorded key as done (`cat40-model-ladder.ts:374`), confirmed. `SubmitPayload.answer` is a
string (`loop.ts:35`), confirmed. The pg arm embeds with OpenAI (`pg-arm.ts:41`), confirmed. A campaign script exists
(`scripts/cat40-followups.sh`), confirmed.

```
DX DUAL VOICES — CONSENSUS TABLE:
  Dimension                           Claude  Codex  Consensus
  1. Getting started < 5 min?          No      No     CONFIRMED gap (no scripted Hard hello world)
  2. API/CLI naming guessable?         No      No     CONFIRMED gap (no --mode/--knobs/--max-turns; lax parsing)
  3. Error messages actionable?        Partly  No     CONFIRMED gap (errors resumed as done; stops not machine-readable)
  4. Docs findable & complete?         No      No     CONFIRMED gap (no runbook/guide; v1 examples refuse)
  5. Upgrade path safe?                Partly  No     CONFIRMED gap (identity lacks evaluator version; knob identity)
  6. Dev environment friction-free?    No      No     CONFIRMED gap (credentials and arms not preflighted)
CONFIRMED = native + outside agree.
```

Disagreement → Taste: the H1 answer encoding (native: one JSON-encoded string; Codex: a Hard-only schema accepting
string arrays) is **Taste DX-T1**, recommended: JSON-encoded string with literal examples, native arrays tolerated but
undocumented (P5, works under strict tool schemas, no per-world schema branch). No User Challenge: no finding changes
the user's stated direction.

#### Passes (DX POLISH; each issue auto-decided, recommended option)

| Pass | Before | After | Findings and decisions |
|---|---|---|---|
| 1 Getting started | 1/10 | 9/10 | No $0 path → DX-F1 `scripts/cat40-hard.sh hello` + hermetic test running exactly it; Champion < 2 min |
| 2 API/CLI | 3/10 | 8/10 | `--mode hard`, `--knobs`, frozen knobs default, `--max-turns`, strict flags and `--help`, one scale vocabulary (`--scale large` = 50k append) (DX-F2, F3); registry command (DX-F9) |
| 3 Errors | 5/10 | 8/10 | Refusals print the exact fix (`--judge gpt-6.1-sol`); exit 3 + stable codes for every stop (DX-F7); identity-mismatch message names the differing field; held-out failures print counts only (DX-F8); error cells retried, nonzero exit with resume command (DX-F12) |
| 4 Docs | 2/10 | 8/10 | Canonical Hard operator guide and per-step runbook before step 1, linked from README, `eval/RUNBOOK.md`, CONTRIBUTING and the registry; output paths named; body text reconciled (DX-F4, F5) |
| 5 Upgrade | 4/10 | 8/10 | `model-ladder-hard-v1` version string, knob schema version, evaluator and scorer hashes in `experiment.json`; resume refused on evaluator change, offline rescoring command for scorer-only changes (DX-F14) |
| 6 Dev env | 3/10 | 8/10 | `--preflight` prints required key names per arm, models and prices, world identity, cell count, ledger cap computed from all ledgers, projection, at $0 (DX-F13); hermetic Hard path in `bun eval/runner/all.ts --only model-ladder-hard` under 60 s |
| 7 Community | 6/10 | 7/10 | Report entrypoint with offline table reproduction from committed results and representative transcripts (DX-F15); docs README row (CONTRIBUTING step 10). No new channels needed |
| 8 Measurement | 2/10 | 8/10 | The hello-world test is the TTHW measurement (fails CI if the scripted run breaks); campaign `status` reports step progress; freeze-rule analyzer appends to the calibration record (DX-F6) |

Hard tool descriptions state the Hard behavior (DX-F10), and `--hard-tool-limits v1|hard` selects the CEO-T4
alternative without a code change, recorded in `experiment.json` (DX-F11).

```
+====================================================================+
|              DX PLAN REVIEW — SCORECARD                             |
+====================================================================+
| Dimension            | Score  | Prior  | Trend  |
|----------------------|--------|--------|--------|
| Getting Started      |  9/10  |  1/10  |  ↑     |
| API/CLI/SDK          |  8/10  |  3/10  |  ↑     |
| Error Messages       |  8/10  |  5/10  |  ↑     |
| Documentation        |  8/10  |  2/10  |  ↑     |
| Upgrade Path         |  8/10  |  4/10  |  ↑     |
| Dev Environment      |  8/10  |  3/10  |  ↑     |
| Community            |  7/10  |  6/10  |  ↑     |
| DX Measurement       |  8/10  |  2/10  |  ↑     |
+--------------------------------------------------------------------+
| TTHW                 | <2 min | undefined (>10) | ↑ |
| Competitive Rank     | Champion (target)                             |
| Magical Moment       | designed via scripts/cat40-hard.sh hello      |
| Product Type         | CLI tool + documentation (benchmark)          |
| Mode                 | POLISH                                        |
| Overall DX           |  8/10  |  3/10  |  ↑     |
+====================================================================+
| DX PRINCIPLE COVERAGE                                               |
| Zero Friction      | covered (hello, preflight)                     |
| Learn by Doing     | covered (scripted Hard run)                    |
| Fight Uncertainty  | covered (exit 3 codes, freeze analyzer)        |
| Opinionated + Escape Hatches | covered (frozen knobs; --max-turns, --hard-tool-limits) |
| Code in Context    | covered (runbook argv per step)                |
| Magical Moments    | covered                                        |
+====================================================================+
```

```
DX IMPLEMENTATION CHECKLIST
============================
[ ] Time to hello world < 2 min (scripts/cat40-hard.sh hello, hermetic test runs exactly it)
[ ] Installation is one command (bun install; no new dependency)
[ ] First run produces meaningful output (per-family table, H5 chain, H1 set scored, freeze table)
[ ] Magical moment delivered via scripts/cat40-hard.sh hello
[ ] Every error message has problem + cause + fix (refusals, stops with exit 3 and codes)
[ ] CLI naming guessable (--mode hard, --knobs, --max-turns, --scale large, --preflight)
[ ] Every parameter has a sensible default (frozen knobs; Hard judge must be explicit by design)
[ ] Docs have copy-paste commands that work (runbook per step; registry command)
[ ] Upgrade path documented (version strings, evaluator hashes, resume/rescore rules)
[ ] Works in CI without special configuration (all.ts --only model-ladder-hard, < 60 s)
[ ] Changelog entry (CHANGELOG.md, declarative)
```

**NOT in scope (DX).** A web dashboard for campaign status (the shell `status` is enough); changing the v1 runner's
default judge (G3; recorded as a follow-up in TODOS.md); a hosted playground.

**What already exists (DX).** `--scripted`, `--check`, `experiment.json` binding, `scripts/cat40-followups.sh`
(`PRINT_ONLY=1`), `bun eval/runner/all.ts --only`, `budget-ledger.ts` status and `set-cap`, `analyze.ts`, the
registry's `run.command` field, `eval/RUNBOOK.md`.

#### DX amendments

<!-- autoplan-baseline-edits:dx {"sourceSha256":"850de605f6050c9f943fa65bcec299298fdc2d4b0e7c4278d5bcd2013c7cbea8","replacements":[{"oldText":"1. **Calibration world.** A dev seed for the 4k Hard world. Run 10 tasks per family on fs and oracle with Sonnet 5.5\n   and GPT-6 Astra, one repeat, at about $10–18 per round (pg joins fs and oracle in every round; see the accepted\n   requirements below).","newText":"1. **Calibration world.** A dev seed (20261005) for the 4k Hard world, generated at the held-out density of 20 tasks\n   per family. Each round samples 10 tasks per family and runs fs, pg and oracle with Sonnet 5.5 and GPT-6 Astra, one\n   repeat, at about $10–20 per round."},{"oldText":"2. **Tuning.** Adjust only generator knobs (record counts, history length, distractor rate, turn cap) until fs lands\n   in 40–70% and oracle at 90% or above.","newText":"2. **Tuning.** Adjust only generator knobs (record counts, history length, distractor rate and noise first; the turn\n   cap last) until the freeze rule in the accepted requirements passes, as printed by the freeze-rule analyzer."}]} -->

<!-- autoplan-accepted:dx -->
- **Hello world (DX-F1).** `scripts/cat40-hard.sh hello` generates a calibration-seed Hard world and runs it
  `--scripted` on fs, memory and oracle at $0, covering every family (a five-session H5 chain and a scored H1 set
  answer), and prints per-family rows and the freeze-rule table in under 2 minutes from a checkout with dependencies
  installed. A hermetic test runs exactly that command. `--scripted` without `--arms` selects only arms that support it.
- **CLI contract (DX-F2, DX-F3).** The generator takes `--mode hard`, `--knobs <file.json>` (default: the committed
  `docs/benchmarks/cat40-hard/knobs.frozen.json` once it exists; calibration rounds use `knobs.round-N.json`) and
  `--scale large` for the 50k append, which refuses unless it matches the 4k world's digest. Unknown or missing knob
  keys are refused with the list of valid keys. The runner takes `--max-turns <n>`, which overrides the world's cap and
  is recorded in `experiment.json` as part of the experiment's flags. The generator and runner reject unknown flags,
  non-numeric values and empty task or family selections before writing anything, and print usage on `--help`.
- **Errors and stops (DX-F7, DX-F8, DX-F12).** Every refusal names what failed, why and the exact fix (the judge
  refusal prints `--judge gpt-6.1-sol`; the world-identity refusal names the differing field among seed, scale, mode,
  knobs and the fix: repeat the original argv or use a new `--out`). Every stop-for-Garry condition exits 3 with a
  stable code, the numbers that triggered it and the decision asked; the runbook lists every code. Generator
  assertions on a held-out world print only counts, family and task index. On Hard runs, cells whose run stopped with
  `error` are retried on resume (each attempt's cost kept), a run with incomplete required cells exits non-zero and
  prints the resume command, and claims-judge failures can be re-judged without rerunning the agent.
- **Runbook and campaign script (DX-F4, DX-F5).** Before step 1, `docs/benchmarks/cat40-hard/RUNBOOK.md` gives every
  paid step's exact command, `--out` path, ledger, projection command, expected wall-clock, stop codes and next step;
  `scripts/cat40-hard.sh` runs the steps by name, verifies predecessor artifacts and the recorded budget decision, and
  has print-only and `status` modes, modelled on `scripts/cat40-followups.sh`. One Hard operator guide is linked from
  `README.md`, `eval/RUNBOOK.md`, `eval/CONTRIBUTING.md` and the registry row; v1 examples that Hard refuses are
  labelled as v1. Output paths: `docs/benchmarks/cat40-hard/{calibration.md, PREREGISTRATION.md, RUNBOOK.md,
  knobs.*.json}`, receipts under `docs/benchmarks/cat40-hard/<step>/`, and a dated report
  `docs/benchmarks/<date>-model-ladder-hard.md`, linked from the Cat 40 report.
- **Freeze-rule analyzer (DX-F6).** `bun eval/runner/cat40/analyze.ts <results.jsonl> --freeze-rule --round N` prints
  every freeze condition as PASS or FAIL with its measured value and threshold, names the knob family the priority
  order says to adjust next, appends the table to `calibration.md`, and exits non-zero on failure; hermetic tests
  cover each condition.
- **Registry (DX-F9).** The `model-ladder-hard` row's `run.command` is the step-9 command with `--judge gpt-6.1-sol`,
  the Hard world path and the Hard arm set (no fs-acl).
- **Hard tool descriptions and selector (DX-F10, DX-F11).** On Hard worlds the fs and pg tool descriptions state the
  Hard behavior (all matches, full lines, total; pg limit up to 100); `--hard-tool-limits v1|hard` selects the CEO-T4
  alternative and is recorded in `experiment.json`; a test checks each description against the behavior on each world
  type.
- **Preflight (DX-F13).** `--preflight` makes no paid call and prints the required environment variable names per arm
  (for example pg needs `OPENAI_API_KEY` for embeddings), the resolved models and their prices, the world identity,
  the cell count, slot coverage, the Hard ledger's cap computed from every ledger's recorded cap, and the step's
  projection.
- **Upgrade path (DX-F14).** Hard worlds carry `model-ladder-hard-v1` and a knob schema version; `experiment.json`
  records the runner commit and the hashes of the Hard scorer and oracle modules. A resume with a changed evaluator is
  refused; a scorer-only change is handled by an offline rescoring command that rewrites scores beside the originals;
  `analyze.ts` reads N-session records and costs every session.
- **Report entrypoint (DX-F15).** The Hard report links each headline comparison to its family table, receipts and
  representative transcripts, gives one offline command that reproduces every table from committed results, and shows
  setup cost and end-to-end latency beside agent-only latency.
- **H1 answer format (provisional, Taste DX-T1).** H1 answers are one JSON-encoded string in `answer`; the H1 prompt
  shows literal examples (`["Quorvane Systems","Telmiro Labs"]`, `12`); native arrays from a provider are accepted
  but not documented. The oracle's H1 success in calibration is the format check. The alternative is a Hard-only tool
  schema accepting string arrays.
<!-- /autoplan-accepted:dx -->

DX close: packet `autoplan-dx-tjCKH6/close-packet.md` (389 lines) read in full and verified; phase report published.

### Eng phase (Phase 3, last)

Methodology: `autoplan-eng-methodology-x0W1RH/methodology.md` (2,261 lines) read at offsets 1, 483, 1083, 1641 and
2230 through EOF. Target: this plan (scope gate auto-selected B, the plan named by the user). Eng snapshot and
amendment checkpoint `<ENG_INPUT>`: `autoplan-eng-osoPxc/eng-implementation.md` (sha256 `ff9f0387…`).

#### Step 0: Scope Challenge

What already solves each sub-problem: see the CEO "What already exists" map; verified again in code for this phase:
`generateLadderWorld` (closures over `rng`, `add`, `unique`, `accountRecords`, `transcript`, `ref`), `scheduleCells` and
the `done` set (`cat40-model-ladder.ts:374`), `runAgent` (`loop.ts`, one `maxTurns`), `OracleArm.evidence`
(`arms.ts:198`), `scoreTask`/`valueVerdict`/`answerHead` (`score.ts`), `judgePrompt` (`score.ts:118`), the pg embedder
(`pg-arm.ts:41`, first 24,000 characters only), `GbrainSlot.restore` (`gbrain-arm.ts:326`), the ledger
(`budget-ledger.ts`, per-ledger caps).

Complexity check (estimates): about 16 changed or new files (generator module, generator CLI, runner, loop, arms, pg
arm, gbrain arm restore path, Hard scorer, Hard judge, oracle evidence, analyze, rescore, latency-replay,
holdout_stats, registry, campaign script) plus docs and tests; new modules: Hard generator, Hard scorer, Hard judge.
Gate tripped (8+ files, 2+ new modules). Feature cuts proposed: none (P2, scope challenge never reduces). Structure
question auto-decided: **Original arrangement** (Hard generator in `eval/generators/model-ladder-hard.ts` importing
lifted helpers; `eval/runner/cat40/score-hard.ts`; `eval/runner/cat40/judge-hard.ts`; runner branches keyed on
`world.mode`), because no smaller arrangement keeps `score.ts` byte-identical and v1 untouched. Scope record: feature
answers: none (no cuts); structure: A (auto-decided, P5); accepted scope: as accepted by CEO and DX; pending remedies:
ENG rows below. Result: **scope accepted as-is**. TODOS cross-reference: the "priced dry run for paid scripts" TODO
is superseded for Hard by DX-F13 `--preflight`. Search check: no new infrastructure pattern beyond worker threads for
grep (Bun supports `Worker`; Layer 1).

Scope Challenge findings (auto-decided with the recommended remedy unless noted):
1. [P1] (9/10) `cat40-model-ladder.ts:374`: `done` includes `error` records, so DX-F12's retry needs an attempt model,
   not a filter. → ENG-F2.
2. [P1] (9/10) `pg-arm.ts:44`: `input: batch.map(t => t.slice(0, 24_000))`: pg embeds only the first 24,000
   characters; H4 puts deciding lines mid-transcript. → ENG-F11.
3. [P2] (8/10) CEO-F1 ("appended documents … never name a 4k account") contradicts CEO-F22 (append non-deciding
   material about 4k accounts). → ENG-F8 replaces the CEO-F1 sentence.

#### Dual voices

**Claude SUBAGENT (eng — independent review)** (Capy subagent 6, shared machine, `nativeDispatchPrompt` verbatim;
reported model claude-opus-5-5; `INPUT: eng ff9f0387…` matches the snapshot; it also read `/workspace/gbrain-evals`
read-only). Findings: E1 critical (error retries bias outcomes; uncapped grep turns context overflow into `error`;
add `context_overflow` stop kind, retry only harness errors, cap 2); E2 high (resume and two-session record shape
hardcoded across analyze, rescore, latency-replay; `sessions[]` v2 schema with `attempt`); E3 high (H5 user
corrections vs H4 authority order; user statements outrank documents); E4 high ("as of D" ambiguity; choose
valid-time-with-hindsight); E5 high (claims judge marks H5 recall unsupported; Hard judge prompt); E6 medium
(non-string answers crash imported helpers; coerce); E7 medium (knob changes reshuffle tasks; per-family/task
sub-seeds, Wilson intervals); E8 medium (world identity proves self-consistency, not freeze; check frozen knob
digest); E9 medium (alias namespace injective); E10 medium (H3 oracle evidence at 50k; seeded near-miss order); E11
medium (ledger arithmetic needs a committed roster); E12 medium (`unparseable_set` failure kind); E13 medium
(weakest-family choice needs CI excluding 0); E14 low (sync grep blocks the loop; worker with time limit); E15 low
(ledger-only 50k key test); E16 low (comparator selection is conservative, keep all-comparisons table); E17 low
(record held-out world SHA; status prints hashes only); plus test gaps (H5 session-3 error, `newSession` between
sessions, v1 limits unchanged, `--max-turns` identity, `hello` timeout).

**Codex SAYS (eng — architecture challenge)** (gpt-6-astra, high reasoning, read-only, 123,785 tokens,
`OUTSIDE_STATUS: completed provider=codex host=claude`), verbatim:

```tool-output
The plan is not ready to implement unchanged. The accepted DX fixes help, but several underlying execution and measurement contracts remain undefined.

1. **Critical — A failed restore can contaminate subsequent cells.**  
   The runner releases a gbrain slot in `finally`, even when `slot.restore()` fails. Another cell can acquire a partially restored or unhealthy brain. A successful five-cell smoke cannot protect later runs from this. See [cat40-model-ladder.ts:205](/home/user/.capy/work/evals-hard/eval/runner/cat40-model-ladder.ts:205). **Fix:** quarantine failed slots; release them only after restoration and health verification succeed. Test a restore failure with another cell waiting, and verify that retries start from the baseline snapshot.

2. **High — The proposed `error` policy misses infrastructure failures hidden inside tools.**  
   [loop.ts:145](/home/user/.capy/work/evals-hard/eval/runner/cat40/loop.ts:145) converts every thrown tool exception—including budget exceptions—into tool text. [gbrain-arm.ts:178](/home/user/.capy/work/evals-hard/eval/runner/cat40/gbrain-arm.ts:178) similarly converts MCP failures into strings. The agent can subsequently submit, so neither “error in any session fails the cell” nor “halt smoke on any harness error” is reliable. **Fix:** distinguish recoverable tool errors, infrastructure failures and budget refusal. Propagate the latter two to cell/campaign status; test failures during searches, writes, session restart and restore.

3. **High — Retrying cells requires an attempt model, not just a different `done` filter.**  
   The runner appends records, while [analyze.ts:37](/home/user/.capy/work/evals-hard/eval/runner/cat40/analyze.ts:37) loads every row and averages them. Keeping failed attempts alongside successful retries would change success rates; the Python coverage checker instead rejects duplicates. Task IDs also repeat across scales and turn-budget experiments. **Fix:** separate immutable attempts from canonical scored cells. Give attempts unique IDs, retain every attempt’s cost, and define which completed attempt supplies the outcome. Analysis must validate the expected cell grid and experiment identity, including scale and turn settings. Specify finite retry rules so persistent errors cannot be silently excluded.

4. **High — “World digest unchanged” is insufficient grounds to preserve the freeze.**  
   CEO-F17 allows runner/scorer fixes with a dated note, but a prompt, tool behavior, session transition or scorer change can invalidate calibration without changing any document. DX-F14 protects resume within one directory; it does not prevent combining earlier calibration and baseline results with a changed evaluator. **Fix:** freeze the relevant runner code, shared helpers, prompts, tool schemas and effective settings. Scorer changes require consistent offline rescoring and reevaluation of dependent decisions; behavior changes require rerunning affected calibration/reference cells before proceeding.

5. **High — The tool-limit alternatives still violate the stated constraint.**  
   Retaining v1 truncation on Hard is incompatible with “no tool-result caps as a standing rule.” Raising pg’s limit from 25 to 100 also leaves a retrieval ceiling with no pagination; H1 needs exhaustive enumeration. The current limits are in [arms.ts:90](/home/user/.capy/work/evals-hard/eval/runner/cat40/arms.ts:90) and [pg-arm.ts:112](/home/user/.capy/work/evals-hard/eval/runner/cat40/pg-arm.ts:112). **Fix:** remove permanent truncation from official Hard configurations. Support agent-selected result sizes and deterministic pagination where appropriate, with totals and exhaustion indicators. Preserve v1 behavior separately, and reject capped configurations for the primary Hard measurement.

6. **High — Long transcripts expose an existing pg ingestion bias.**  
   [pg-arm.ts:44](/home/user/.capy/work/evals-hard/eval/runner/cat40/pg-arm.ts:44) silently embeds only the first 24,000 characters of each document. H4 deliberately places deciding evidence inside long documents; vector search can therefore miss content that was never embedded. This is independent of tool-result limits. **Fix:** explicitly design Hard’s document/chunk representation and token-aware embedding batches. Preserve full document retrieval, include chunking identity in caches, and test a deciding passage beyond the current prefix. Do not discover this during paid calibration.

7. **High — The promised scorer mutation tests conflict with the pinned helpers.**  
   I reproduced `valueVerdict("Rania Thorne (or Anouk Yilmaz)", …)` returning `correct: true`; the semicolon equivalent also passes. [answerHead discards those alternatives](/home/user/.capy/work/evals-hard/eval/runner/cat40/score.ts:38). Directly widening `SubmitPayload.answer` to accept arrays would also make existing string-only calls in pinned `score.ts` incompatible with the shared type. **Fix:** introduce a Hard-specific payload decoder and ambiguity validation before invoking unchanged helpers. Explicitly reject unresolved/ambiguous H1 names and malformed count tokens. Keep native arrays away from the v1 scorer rather than widening its contract indiscriminately.

8. **High — H5’s claims judge will lack the authoritative session evidence.**  
   [judgePrompt](/home/user/.capy/work/evals-hard/eval/runner/cat40/score.ts:118) reads original world documents, not session updates or newly saved documents. An offline probe on existing F01 confirmed that its judge documents contain the superseded value but omit the correct session update. Extending this path to H5 invalidates the claims metric even when deterministic scoring succeeds. **Fix:** create a Hard judge module using trusted session updates and the specified temporal/authority rules. Persist the complete judge request for independent retries, and treat malformed judge output as a judge failure. Agent-written notes must not become their own unquestioned ground truth.

9. **High — Temporal and entity semantics are underspecified for the proposed ledger.**  
   “Effective date wins” does not resolve two corrections with the same effective date, distinguish retrospective truth from what was known at the queried time, or define historical counting across merges. Accepting former names globally can also collapse historically distinct entities. The current [document/task types](/home/user/.capy/work/evals-hard/eval/generators/model-ladder-gen.ts:66) do not represent these distinctions. **Fix:** specify stable entity IDs, effective time, recorded time, explicit supersession and deterministic tie rules. Define alias/merge resolution at the query date and date-window boundaries. Require small, independently specified fixtures before generating prose.

10. **High — H1’s oracle contract is internally inconsistent and may exceed context.**  
    “Every member and every near miss” conflicts with evidence “capped by a generator knob.” At 50k, near misses can dominate evidence size. Omitting them changes the oracle task; including them all may exceed a model’s input capacity. **Fix:** state whether the knob constrains generated populations or selects evidence. Require complete evidence under the chosen contract, and preflight its token size before paid calls. Also reconcile CEO-F1’s prohibition on new documents naming existing accounts with CEO-F22’s requirement to add exactly that material; encode separate append classes and their invariants.

11. **High — Committing the winning comparator does not remove selection bias.**  
    Selecting the best simple arm on held-out outcomes and then treating it as an independently fixed comparator ignores the uncertainty introduced by that selection. Committing before gbrain runs does not undo selection on the same tasks. Existing [analysis also selects baselines per model](/home/user/.capy/work/evals-hard/eval/runner/cat40/analyze.ts:170), whereas this plan specifies one pooled comparator. **Fix:** either choose the primary comparator independently, or preregister inference that accounts for selection—for example, simultaneous paired intervals against all eligible simple arms. Implement one authoritative Hard analysis path with explicit tie-breaking and complete coverage requirements.

12. **High — The global budget guarantee has no enforcement mechanism.**  
    [setProgramCap](/home/user/.capy/work/evals-hard/eval/runner/budget-ledger.ts:524) and reservations transact against one ledger. Scanning other ledgers and subtracting their caps cannot guarantee a program-wide bound if another operator creates a ledger or changes a cap concurrently. “Every other ledger” also lacks an authoritative roster, including remote ledgers and copies. **Fix:** register program ledger identities and allocations, then serialize allocation changes—or explicitly freeze all other allocations for this campaign. The budget decision must establish that allocation before any paid step.

13. **Medium — Per-cell costs omit pg’s own provider calls.**  
    pg performs paid embeddings during vector queries and saved-note writes in [pg-arm.ts:120](/home/user/.capy/work/evals-hard/eval/runner/cat40/pg-arm.ts:120). The runner’s cell total adds agent usage and gbrain internal usage only. These charges can appear in the ledger without appearing in pg’s cost-per-success comparison, especially for H5. **Fix:** attribute every paid request to setup or to a cell attempt/session, regardless of arm. Reconcile those categories before publishing costs, including failed requests, judge retries and restore/setup activity.

14. **Medium — Subtracting restore time will not produce valid agent latency at 50k.**  
    [GbrainSlot.restore](/home/user/.capy/work/evals-hard/eval/runner/cat40/gbrain-arm.ts:326) uses synchronous git, deletion and tar operations in the runner process. One slot’s restore blocks other cells and the metering proxy; their latency includes somebody else’s restoration. **Fix:** move blocking restore work into asynchronous subprocesses or workers. Record queueing, session startup, agent execution and restoration separately. Validate responsiveness under concurrent restores before relying on the projected runtime or latency comparisons.

15. **Medium — H5 needs proof of dependency and observable persistence.**  
    A final value can appear to depend on two earlier sessions while actually being recoverable from one later message that repeats everything. A final store inspection also cannot distinguish “never saved” from “saved, then lost,” and the current runner restores immediately after processing the cell. **Fix:** add counterfactual generator tests showing that removing each required earlier fact makes the final answer indeterminate or different. Capture per-session persistence evidence and store changes before restoration so the promised saved/updated/lost diagnostic has a defensible basis.

Validation was read-only, with successful offline scorer and judge-evidence probes. Broader runner probes were blocked by the checkout’s missing `gbrain/core/model-pricing` dependency.

Recommendation: Revise before implementation because cell isolation, retry accounting, evaluator freezing and evidence semantics can currently invalidate the paid measurement.
```

Verification of outside claims: `slot.restore()` sits in `try … finally { release(slot) }`
(`cat40-model-ladder.ts:205`), so a failed restore releases the slot (confirmed); tool exceptions become tool text
(`loop.ts:145`, confirmed); pg embeds `t.slice(0, 24_000)` (`pg-arm.ts:44`, confirmed); pg query embeddings are paid
inside the runner (`pg-arm.ts:120`, confirmed); `answerHead` cuts at ` (` so a hedged "X (or Y)" scores on X
(`score.ts:38`, confirmed by reading).

```
ENG DUAL VOICES — CONSENSUS TABLE:
  Dimension                           Claude  Codex  Consensus
  1. Architecture sound?               Yes*    No*    CONFIRMED: module structure sound; execution contracts (attempts, isolation, freeze) need fixes
  2. Test coverage sufficient?         No      No     CONFIRMED gap (N-session, retry, restore failure, scorer coercion)
  3. Performance risks addressed?      No      No     CONFIRMED gap (sync grep, sync restore, judge prompt size)
  4. Security threats covered?         Partly  N/A    Native only (held-out secrecy by discipline; hash audit added)
  5. Error paths handled?              No      No     CONFIRMED gap (error retries, tool-level infra errors, overflow)
  6. Deployment risk manageable?       No      No     CONFIRMED gap (ledger roster, evaluator freeze)
CONFIRMED = native + outside agree.
```

Disagreement → Taste: comparator selection. Native E16 calls the best-simple-arm rule conservative and sufficient with
the all-comparisons table; Codex 11 wants inference that accounts for the selection. **Taste ENG-T1**, recommended:
keep the user's comparator rule and add simultaneous paired intervals (max-T task-clustered bootstrap) against every
eligible simple arm as the primary inference; the alternative is the single-comparator interval with the
all-comparisons table as context. Codex 5 vs the CEO-T4 alternative ("today's limits on Hard") is folded into
**Taste CEO-T4**: the recommendation becomes uncapped grep plus pg offset pagination with totals for every official
Hard run. No User Challenge in this phase.

#### Section 1: Architecture

```
                         ┌──────────────────────── knobs.frozen.json (digest in PREREGISTRATION)
                         ▼
  model-ladder-gen.ts ──► model-ladder-hard.ts ──► ledger (entity IDs, valid/recorded time, aliases, sessions)
   (helpers lifted;          │   predicate evaluator (one function)  ──► keys + 50k key-equality assertions
    v1/large unchanged)      └──► renderers ──► world.json {version, seed, scale, mode, knobs, knobDigest, turn_cap}
                                                     │
  scripts/cat40-hard.sh (hello | preflight | step N | status)
                                                     ▼
  cat40-model-ladder.ts ── identity check (seed, scale, mode, knobs, frozen digest on held-out) ── refusals (exit 3)
     │  attempts.jsonl (append-only, attempt ids) ──► canonical cell = last harness-clean attempt
     ├── loop.ts: maxTurns = --max-turns ?? world.turn_cap ; sessions[1..N]; stop kinds incl. context_overflow
     ├── arms.ts: Hard tool options (T4); grep in a Worker with a time limit
     ├── pg-arm.ts: Hard chunked embeddings (full document retrievable); cost attributed to the cell
     ├── gbrain-arm.ts: newSession between sessions; restore after chain; quarantine on failed restore
     ├── OracleArm.evidence(hard): complete evidence per family; token preflight
     ├── score-hard.ts ──imports──► score.ts (unchanged, 8a448051…)   ── decoder: coerce/ambiguity/unparseable_set
     └── judge-hard.ts (own JUDGE_PROMPT_VERSION; session messages for H5; request persisted)
  analyze.ts / rescore.ts / latency-replay.ts / holdout_stats.py ── read v1 and v2 (sessions[], attempts)
  budget-ledger.ts ── .budget/cat40-hard.sqlite ; program roster (committed) checked by --preflight
```

Findings and dispositions: (a) restore failure contaminates the pool → ENG-F10 quarantine; (b) tool-level infra
errors hidden as text → ENG-F1; (c) evaluator freeze too weak → ENG-F6; (d) budget roster → ENG-F9. Realistic
production failures per new path are in the failure-modes registry below. Distribution: no new published artifact;
CI runs the hermetic Hard tests in the existing unit shards.

#### Section 2: Code quality

Shared code: the predicate evaluator is shared by key generation and the 50k assertion (CEO-F29; callers: two
proposed, labelled). The Hard scorer reuses `valueVerdict`, `answerHead` and `normalizeValue` behind a decoder rather
than copying them (ENG-F5). Error handling gaps: non-string answers would throw inside imported helpers (ENG-F5);
`unparseable_set` needs its own kind (ENG-F19). Naming: `score-hard.ts`, `judge-hard.ts`, `model-ladder-hard.ts`,
`world.mode`. Stale diagrams: none in touched files today; the runner header comment must list the new flags.

#### Section 3: Test review

Framework: Bun test (`bun run test`, unit tests colocated under `eval/` and in `test/eval/`; CLAUDE.md "Repository
map"). Coverage diagram (proposed code; all GAP until built):

```
CODE PATHS                                                     USER (OPERATOR) FLOWS
[+] model-ladder-hard.ts                                       [+] hello (scripted, $0)
  ├── determinism (seed+knobs → digest)            [GAP] unit    ├── [GAP] [→E2E] scripts/cat40-hard.sh hello < 2 min
  ├── v1/large byte-identity after helper lift     [GAP] check   [+] preflight
  ├── H1 keys = predicate(ledger); near misses     [GAP] unit    ├── [GAP] missing key / ledger / unpriced → exit 3
  ├── 50k key equality + H3 uniqueness (ledger-only)[GAP] unit   [+] calibration round
  ├── alias namespace injective                    [GAP] unit    ├── [GAP] freeze analyzer PASS/FAIL per condition
  ├── accepted/wrong distinct, no substrings       [GAP] unit    [+] held-out step
  ├── H5 counterfactual dependency                 [GAP] unit    ├── [GAP] frozen-digest mismatch refused
  └── valid-time-with-hindsight keys; tie rule     [GAP] unit    └── [GAP] [→E2E] resume after kill mid-H5 chain
[+] cat40-model-ladder.ts
  ├── identity incl. knobs, --max-turns            [GAP] unit
  ├── Hard refusals (judge, mini, unpriced)        [GAP] unit
  ├── attempts: retry harness errors ≤ 2, not outcomes [GAP] unit
  └── restore failure quarantines slot             [GAP] unit (fake slot)
[+] loop.ts: per-world cap; N sessions; context_overflow  [GAP] unit (scripted + fetch stub)
[+] arms.ts: Hard grep uncapped + total; v1 unchanged     [GAP] unit
[+] pg-arm.ts: chunked embedding finds a line past 24k    [GAP] unit (stub embedder)
[+] score-hard.ts: decoder + mutation suite               [GAP] unit+mutation
[+] judge-hard.ts: H5 session evidence; version           [GAP] unit
[+] analyze/rescore/latency-replay/holdout_stats: v2 records, duplicates [GAP] unit
LLM integration: [→EVAL] Hard system-prompt section and H1 prompt format — covered by calibration oracle success
COVERAGE: 0/27 built (plan stage) | every path has a planned test | GAPS: 27 (2 E2E, 1 eval)
```

Regression rule: the helper lift in `model-ladder-gen.ts`, the runner's `done`/attempt change, the restore change and
the tool-description change put v1 behavior at risk. CRITICAL regression contract (auto-decided, P1): v1 `--check`,
the large manifest digest, `score.ts` hash `8a448051…`, a v1 scripted run producing byte-identical `results.jsonl`
scores to a recorded fixture, and v1 tool limits (50 default, 200 max, 300 characters, pg 25) all stay as they are.
Test plan artifact: written to `~/.gstack/projects/garrytan-gbrain-evals/user-plan-cat40-hard-eng-review-test-plan-*.md`.

#### Section 4: Performance

Sync grep over 50k documents blocks concurrent cells (ENG-F13, Worker with a time limit); sync restores block the
loop and the metering proxy (ENG-F13, subprocess restore); judge prompts for H1 near misses grow with scale (ENG-F3
caps and summarizes, cost projected from calibration); the 50k key-equality test uses the ledger-only path (ENG-F17).
Memory: a 50k world in memory is about the size of v1-large (52k docs), which already runs.

#### Failure modes registry (Eng)

```
  CODEPATH               | FAILURE MODE                               | TEST? | HANDLING              | SILENT?
  -----------------------|--------------------------------------------|-------|-----------------------|--------
  runner resume          | error attempt retried until it succeeds    | Y     | cap 2, harness-only   | N
  loop                   | 400 context length on uncapped grep        | Y     | context_overflow stop | N
  gbrain slot            | restore fails, next cell gets dirty brain  | Y     | quarantine            | N
  gbrain tool            | MCP failure returned as tool text          | Y     | harness error         | N
  pg arm                 | deciding line past 24k never embedded      | Y     | chunked embeddings    | N
  scorer                 | array answer crashes imported helper       | Y     | decoder coercion      | N
  scorer                 | hedged "X (or Y)" passes                   | Y     | full-answer wrong check| N
  judge                  | H5 recall marked unsupported               | Y     | Hard judge            | N
  generator              | alias collision merges two entities        | Y     | injectivity assert    | N
  freeze                 | world built with stray knobs passes        | Y     | frozen digest check   | N
  ledger                 | unlisted ledger overspends program         | Y     | roster + preflight    | N
```

0 critical gaps (every row has a test and visible handling once the accepted rows are built).

**Worktree parallelization:** Lane A: generator module + generator tests (`eval/generators/`). Lane B: runner, loop,
arms, pg, gbrain restore, attempts (`eval/runner/`). Lane C: Hard scorer and judge (`eval/runner/cat40/score-hard`,
`judge-hard`). Lane D: analysis readers (`analyze`, `rescore`, `latency-replay`, `holdout_stats`). Lane E: script,
docs, registry. A and C run in parallel; B depends on A's world shape; D depends on B's record schema; E last. Conflict
flag: B and C both touch `cat40-model-ladder.ts` dispatch; sequence C's dispatch hook after B. One PR (fix-wave
convention).

#### Eng amendments

<!-- autoplan-accepted:eng -->
- **Attempts and stop kinds (ENG-F1, ENG-F2).** Hard runs append to `attempts.jsonl` with unique attempt ids; a
  canonical cell is the last harness-clean attempt per key, and analysis sums cost over every attempt and validates
  the expected cell grid and experiment identity (scale, turn cap, tool limits). Stop kinds: `submitted`, `turn_cap`,
  `no_tool_call`, `context_overflow` (a provider context-length 400, scored as a failure, never retried), `error`
  (agent-side malformed tool use, scored as a failure) and `harness_error` (provider 5xx or 429 after backoff, slot,
  server, restore or MCP transport failure, including failures a tool would otherwise return as text). Only
  `harness_error` is retried, at most 2 times per cell; retry counts are reported per arm and model. Records use a v2
  schema with `sessions[]` and `attempt`; `analyze.ts`, `rescore.ts`, `latency-replay.ts` and `holdout_stats.py` read
  v1 and v2 records, each with a hermetic test on duplicated-key and 5-session fixtures.
- **Hard judge (ENG-F3).** `judge-hard.ts` has its own `JUDGE_PROMPT_VERSION`; for H5 it includes the chain's user
  messages as trusted evidence (never agent-written notes); for H1 it caps and summarizes near-miss documents; it
  persists each judge request for re-judging and treats malformed judge output as a judge failure. Judge cost is
  projected from calibration's measured prompt tokens at each scale.
- **Temporal and entity semantics (ENG-F4).** Every entity has a stable id; every attribute value has an effective
  time and a recorded time. "As of D" means the value in effect on D using every document, including those written
  after D (valid time with hindsight), and the Hard system prompt says so. A correction replaces the corrected value
  from that value's effective date; two changes with the same effective date resolve to the later recorded one. A
  user statement in the H5 session chain outranks documents, and a later user statement outranks an earlier one; the
  prompt states this beside the authority order. Aliases and former names resolve at the query date; the alias
  namespace is injective across all entities at both scales, and a merged account's names map to one entity id.
  Generator invariants and small hand-specified fixtures test each rule before any prose is rendered.
- **Hard answer decoder (ENG-F5, ENG-F19).** Before calling imported `score.ts` helpers, the Hard scorer coerces
  `answer` (array → JSON string; other non-strings → string; null → empty), rejects an answer that names any
  `gold.wrong` value anywhere in the full answer (not only its head), and classifies an H1 answer that is not a JSON
  array or a leading integer as `unparseable_set`, reported per arm separately from wrong sets. Mutation cases add an
  array answer for H2–H5, `answer: null` and "X (or Y)".
- **Freeze contract (ENG-F6, replaces CEO-F17's first sentence).** The freeze covers the generator, knobs, Hard
  prompts, tool schemas and behavior, session transitions, scorer and judge, recorded as code hashes and an effective
  settings digest in the preregistration. A held-out run refuses unless the world's knob digest equals the committed
  `knobs.frozen.json` digest. A scorer-only change after the freeze is applied by offline rescoring of every affected
  result; a behavior change reruns the affected calibration and reference cells before the next step.
- **H1 oracle evidence and 50k append classes (ENG-F7, ENG-F8, replaces CEO-F1's sentence "Appended documents and
  updates concern only appended accounts and never name a 4k account").** The near-miss knob bounds the generated
  near-miss population, and the oracle gets the complete evidence for it; a token preflight refuses oracle cells that
  exceed a model's input limit. H3 oracle evidence stays the 4k set at 50k, and near-miss ordering is seeded so 4k and
  50k oracle inputs are reproducible. The 50k world has two append classes: appended-account documents, which never
  name a 4k account, and non-deciding documents about 4k accounts (CEO-F22) drawn from templates that set no
  predicate value; both are covered by the key-equality assertions.
- **Program ledger roster (ENG-F9).** The preregistration and runbook commit the list of program ledgers and their
  allocations; other allocations are frozen for this campaign; `--preflight` refuses when a listed ledger is missing
  or its cap differs.
- **Slot quarantine (ENG-F10).** A slot whose restore or health check fails is quarantined, never released to another
  cell; the step halts when fewer than the planned slots remain; a test covers a failed restore with a waiting cell.
- **pg chunked embeddings on Hard (ENG-F11, ENG-F12).** On Hard worlds the pg arm embeds documents in chunks (full
  document still returned by `get_document`), with the chunking identity in the embedding cache key; a test finds a
  deciding line past 24,000 characters. Every paid request is attributed to setup or to a cell attempt and session,
  for every arm (pg query and note embeddings included), and reconciled with the ledger before costs are published.
- **Non-blocking hot paths (ENG-F13).** Hard grep runs in a Worker with a time limit that returns an error to the
  agent; slot restores run as asynchronous subprocesses; the report times queueing, session start, agent execution and
  restore separately, and agent latency comes from those timers.
- **H5 dependency proof (ENG-F14).** Generator counterfactual tests show that removing each required earlier fact
  changes or voids the final answer; per-session store changes are captured before restore for the write diagnostic.
- **Paired tuning rounds (ENG-F15).** The Hard generator derives sub-seeds per family and task index and a separate
  noise stream, so a knob change perturbs only what it controls; rounds sample the same task indices; the freeze-rule
  analyzer prints Wilson intervals beside point estimates.
- **Weakest-family rule (ENG-F16).** A decision sentence that picks "the family where gbrain trails most" requires that
  family's paired difference to have a bootstrap CI excluding 0; otherwise the choice falls back to mechanism evidence.
- **Fast invariance test (ENG-F17).** The 50k key-equality test runs on the ledger without rendering prose.
- **Held-out audit (ENG-F18).** The preregistration records the held-out world files' SHA-256 at generation;
  `scripts/cat40-hard.sh status` prints hashes, never content.
- **Regression contract (ENG-F20).** v1 `--check`, the large manifest digest, `score.ts` hash `8a448051…`, a v1
  scripted run whose scores match a recorded fixture byte for byte, and v1 tool limits (grep 50 default, 200 max,
  300-character lines; pg 25) stay unchanged, each with a test; `hello` runs under a 2-minute test timeout; `--max-turns`
  changes the experiment identity; gbrain gets `newSession()` between sessions and `restore()` only after the chain.
- **Comparator inference (provisional, Taste ENG-T1).** The primary inference adds simultaneous paired intervals (max-T
  task-clustered bootstrap) for gbrain against every eligible simple arm, alongside the preregistered comparator; the
  alternative is the single-comparator interval with the all-comparisons table as context.
- **Hard tool options (Taste CEO-T4, recommendation updated).** The recommended Hard configuration is uncapped grep
  plus pg offset pagination with totals and an exhaustion flag; capped configurations are not used for the primary
  Hard measurement unless Garry picks the alternative.
<!-- /autoplan-accepted:eng -->

#### Eng required outputs

**NOT in scope (Eng).** Changing the v1 runner's default judge (G3; TODOS.md); a multi-machine ledger service (the
committed roster is enough for one campaign); rewriting the gbrain slot mechanism beyond quarantine and async restore;
an extraction + SQL comparator for H1 (Taste CEO-T7, recommended defer).

**What already exists (Eng).** Reused as-is: `Rng`/`draw`/`unique` and the authority, history, namesake and transcript
helpers (lifted, behavior unchanged), `scheduleCells`, `experiment.json` binding, `GbrainPool`, the metering proxy,
`valueVerdict`/`answerHead`/`normalizeValue`, `analyze.ts` bootstrap, `holdout_stats.py` modes, the SQLite ledger.
Rebuilt for Hard only: oracle evidence, judge prompt, scorer dispatch, pg chunking (each because the v1 version is
pinned or cannot express Hard's semantics).

**TODOS.md updates** (auto-decided A, add): family D on Hard; real-harness arms on Hard; a cheap standing decision
panel; grounding Hard families in observed failures (with CEO-UC2); entity-recall-off ablation on Hard (Taste CEO-T5,
if deferred); extraction + SQL comparator for H1 (Taste CEO-T7, if deferred); the v1 runner's default claims judge
(`gpt-5.4-mini`, against the model rules, unchanged under G3). Written to `TODOS.md` under "Cat 40 Hard follow-ups".

**Implementation Tasks** (26 tasks; JSONL in `~/.gstack/projects/garrytan-gbrain-evals/tasks-{ceo,devex,eng}-review-20261005-013407.jsonl`;
aggregated at the gate below).

**Approval readiness: PASS.** Checked ENG-F1 to ENG-F20 (autoplan auto-decisions under the user's instruction),
ENG-T1 and the updated CEO-T4 recommendation (provisional Taste, pending at the gate). No User Challenge in Eng.

Completion summary (Eng):
- Step 0: Scope Challenge — scope accepted as-is (original arrangement, auto-decided)
- Architecture Review: 4 issues found (restore isolation, tool-level infra errors, freeze contract, ledger roster)
- Code Quality Review: 3 issues found (scorer coercion, unparseable_set, shared evaluator)
- Test Review: diagram produced, 27 gaps identified (all planned; 0 built at plan stage)
- Performance Review: 4 issues found (sync grep, sync restore, judge prompt size, slow 50k test)
- NOT in scope: written
- What already exists: written
- TODOS.md updates: 7 items proposed, 7 added
- Failure modes: 0 critical gaps flagged
- Unresolved decisions: 2 in this review (ENG-T1, CEO-T4 recommendation update; both for the gate)
- Outside voice: codex (gpt-6-astra) completed, 15 findings
- Parallelization: 5 lanes, 2 parallel (A, C) / 3 sequential (B, D, E)
- Lake Score: 20/20 (every auto-decided coverage choice took the complete option)

Eng close: packet `autoplan-eng-cuHuu3/close-packet.md` (459 lines) read in full and verified; phase report published.

### Pre-gate verification

| Phase | Required outputs | Status |
|---|---|---|
| CEO | premise challenges (0A), sections 1–10 with findings or examination, Section 11 skip, Error & Rescue and Failure Modes registries, NOT in scope, What already exists, dream state delta, Completion Summary, consensus table | present |
| Design | skipped, no UI scope | recorded as skipped |
| DX | 8 dimension scores, journey map, empathy narrative, TTHW assessment and target, DX checklist, consensus table | present |
| Eng | scope challenge in code, architecture diagram, test diagram, test plan on disk, NOT in scope, What already exists, failure modes, Completion Summary, consensus table | present |

Voices: native and Codex completed in every applicable phase. Cross-phase themes and the Decision Audit Trail are below.

### Phase 4: Final approval gate (stopped here for Garry)

**ELI10.** Cat 40 is a test where AI agents answer questions about a made-up company's documents, with and without
gbrain. The newest models now ace it even with plain text search, so it can't tell whether gbrain helps them. This plan
builds a harder version: questions that need many records, long change histories, look-alike customers, conflicting
sources and memory across five conversations, tuned on plain files only until they get about half right. Then it
freezes the test, makes a fresh unseen copy, and measures gbrain against the simple setups on all five frontier models,
first at 4,000 documents and then, if funded, at 50,000. Nothing runs until Garry picks a budget, and every paid step
checks its cost first.

**Decisions made: 75 total (64 auto-decided, 9 taste choices, 2 user challenges).**

#### User Challenges (both models disagree with the stated direction)

**Challenge CEO-UC1: the 8-turn cap (H6)** (from CEO). You said: every Hard task gets 8 turns instead of 16. Both
models recommend: start at 16 turns and lower the cap only as a last-resort calibration knob, so difficulty comes from
the content. Why: at v1, frontier agents on plain files averaged 4.9 turns and only 12 of 200 runs went past 8, so the
cap is the cheapest way to push files into the 40–70% band, and it favors tools that return more per call; "gbrain
wins Hard" could then mean "gbrain needs fewer round trips". What we might be missing: you may want Hard to measure
efficiency under a budget on purpose, which real agents face as cost and latency. If wrong: the headline gap is partly
a turn-budget artifact (the accepted 16-turn sensitivity check, CEO-F19, measures how much either way). Your original
direction stands unless you change it: the plan keeps 8, with the cap moved last in knob priority and at most half of
the comparator's failures allowed to be turn-cap stops.

**Challenge CEO-UC2: a sealed validation variant** (from CEO). You said: Hard is a new generator mode, measured on a
fresh seed. Both models recommend: before tuning, reserve an independently written variant (different renderers, alias
conventions and document organization) plus a private seed, kept sealed, so later gbrain work can be checked against
templates it was never tuned on. Why: the report already admits template dependence (alias declarations match a
parsing pattern gbrain reads), and fresh seeds reuse the same grammar, so six months of improvements could overfit one
document style. What we might be missing: it adds generator work (medium effort) and a second held-out run later; a
synthetic benchmark may be good enough for internal decisions. If wrong: published Hard gains may not transfer to real
brains. Your original direction stands unless you change it; the item is in TODOS.md either way.

#### Your choices (taste decisions; 9, grouped by phase)

CEO:
1. **CEO-T1 freeze rule.** Recommend: pooled fs 40–70%, each model's best simple arm (fs or pg) 20–80%, oracle ≥ 90%
   per model and ≥ 80% per family, at most 50% turn-cap failures (P1, terminates and keeps difficulty in content).
   Alternative: the draft's per-model 40–70% band on fs, which may never be reachable across five models that already
   differ by 10 points.
2. **CEO-T2 tasks and repeats.** Recommend: 20 tasks per family × 1 repeat (same cost as 10 × 2, tighter task-level
   CIs; planning MDD about 10 points pooled). Alternative: the draft's 10 × 2, which matches earlier Cat 40 runs.
3. **CEO-T3 budget tier.** Recommend: tier C, calibration plus the 4k measurement now ($475–830), with the 50k step
   decided after the 4k result from measured costs (P6; the primary endpoint is 4k). Alternatives: tier B, both scales
   with the memory arm on Sonnet 5.5 and GPT-6.1 Sol only ($765–1,345); tier A, every arm on every model at both scales
   ($1,045–1,855).
4. **CEO-T4 Hard tool limits.** Recommend: on Hard only, grep returns every match with full lines and a total, and pg
   pages with offsets and totals (no-cap rule; H1 needs enumeration). Alternative: today's 200-match / 300-character /
   25-row limits on Hard too, which keeps Hard comparable with v1 but builds difficulty into the tools.
5. **CEO-T5 entity-recall-off ablation.** Recommend: defer (no verified config switch; keep this run the baseline).
   Alternative: add it at 4k on two models for about $20–35, which ties a gap to a feature.
6. **CEO-T7 extraction + SQL comparator for H1.** Recommend: defer to TODOS.md. Alternative: build it now, which tells
   whether aggregation questions need memory infrastructure at all, at the cost of a new arm.
7. **CEO-T8 economic threshold.** Recommend: report incremental cost per extra success and latency, no gate (the tier
   is report-only). Alternative: preregister a dollars-per-extra-success threshold now.

DX:
8. **DX-T1 H1 answer encoding.** Recommend: one JSON-encoded string in `answer` with literal examples (works under
   strict tool schemas; no per-world schema). Alternative: a Hard-only tool schema accepting string arrays.

Eng:
9. **ENG-T1 comparator inference.** Recommend: keep your "best pooled simple arm" rule and add simultaneous paired
   intervals against every eligible simple arm (accounts for picking the best arm on the same tasks). Alternative: the
   single-comparator interval with the all-comparisons table as context (simpler; slightly optimistic for the
   comparator, which is conservative for gbrain).

#### Budget ask

About $500 remains of the $3,000 authorization after the entity-recall wave. Estimates (measured v1 per-cell costs
scaled by list price, with a 1.0×–1.8× Hard factor that calibration replaces):

| Tier | Scope | Estimate | Program authorization needed |
|---|---|---|---|
| C (recommended) | calibration, smoke, 4k held-out with all five arms but memory on two models, judge, 16-turn check; 50k decided later | $475–830 | about $3,350 (Hard ledger cap about $850) |
| B | tier C plus the 50k step | $765–1,345 | about $3,850 (cap about $1,350) |
| A | every arm on every model at both scales | $1,045–1,855 | about $4,350 (cap about $1,850) |

Every step projects its cost from measured costs and stops below projection + 15%, so the cap is a ceiling, not a
spend target. No paid step runs before this decision.

#### Cross-phase themes

- **Difficulty must come from content, not the harness** (CEO: turn cap and tool limits; DX: tool descriptions and
  `--max-turns`; Eng: context overflow as an outcome, uncapped tools, retry bias).
- **The run must be executable and auditable without improvisation** (CEO: ordered paid steps, freeze rule; DX:
  runbook, script, preflight, analyzer; Eng: attempts model, freeze contract, ledger roster).
- **Paired, unbiased comparison** (CEO: comparator chosen before gbrain cells, scale invariance; Eng: selection-aware
  intervals, frozen digest, quarantine).

#### Deferred to TODOS.md

Family D on Hard; real-harness arms; a cheap decision panel; grounding families in observed failures (with UC2);
entity-recall-off ablation (if T5 stays deferred); extraction + SQL comparator (if T7 stays deferred); the v1 runner's
default judge.

#### Implementation tasks (aggregated across phases)

- [ ] **T5 (P1, human: ~4h / CC: ~20min) — budget** — Open the Hard ledger with a carved-out cap and per-step projection checks
  - Surfaced by: ceo-review — CEO-F4, F11, F16
  - Files: 
- [ ] **T1 (P1, human: ~4d / CC: ~3h) — generator** — Build the Hard generator mode: H1-H5, knobs, predicate evaluator, 50k append pattern with key-equality assertions
  - Surfaced by: ceo-review — CEO-F1, F12, F22, F29; 0B leverage map
  - Files: eval/generators/model-ladder-hard.ts, eval/generators/model-ladder-gen.ts
- [ ] **T4 (P1, human: ~1d / CC: ~30min) — preregistration** — Write the preregistration template: seeds, model set, comparator rule, decision sentences, planning MDD, budget roster
  - Surfaced by: ceo-review — CEO-F9, F10, F15, F21, T2
  - Files: docs/benchmarks/cat40-hard/PREREGISTRATION.md
- [ ] **T7 (P1, human: ~1h / CC: ~5min) — registry** — Add the model-ladder-hard registry row (tier P, report-only) with a runnable command
  - Surfaced by: ceo-review — Deliverables; DX-F9
  - Files: eval/registry.ts
- [ ] **T2 (P1, human: ~2d / CC: ~1.5h) — runner** — Add Hard world identity, per-world turn cap, N-session tasks and Hard refusals (judge, gpt-5.4-mini, unpriced)
  - Surfaced by: ceo-review — CEO-F3, F12; system audit (judge default gpt-5.4-mini, one global turn cap)
  - Files: eval/runner/cat40-model-ladder.ts, eval/runner/cat40/loop.ts
- [ ] **T3 (P1, human: ~2d / CC: ~1h) — scoring** — Add Hard scoring by family, oracle evidence per family and the Hard system-prompt rules
  - Surfaced by: ceo-review — CEO-F13, F14
  - Files: eval/runner/cat40/score-hard.ts, eval/runner/cat40/arms.ts
- [ ] **T2 (P1, human: ~1d / CC: ~45min) — analysis** — Read v2 records (sessions[], attempts) in analyze, rescore, latency-replay and holdout_stats
  - Surfaced by: eng-review — ENG-F2
  - Files: eval/runner/cat40/analyze.ts, eval/runner/cat40/latency-replay.ts
- [ ] **T6 (P1, human: ~4h / CC: ~20min) — freeze** — Record code hashes and settings digest; refuse held-out worlds whose knob digest differs from the frozen file
  - Surfaced by: eng-review — ENG-F6
  - Files: eval/runner/cat40-model-ladder.ts
- [ ] **T4 (P1, human: ~1d / CC: ~45min) — generator** — Encode valid-time-with-hindsight, correction and tie rules, user-statement precedence, injective aliases, with fixtures
  - Surfaced by: eng-review — ENG-F4
  - Files: eval/generators/model-ladder-hard.ts
- [ ] **T7 (P1, human: ~4h / CC: ~20min) — isolation** — Quarantine slots whose restore or health check fails
  - Surfaced by: eng-review — ENG-F10; cat40-model-ladder.ts:205
  - Files: eval/runner/cat40-model-ladder.ts, eval/runner/cat40/gbrain-arm.ts
- [ ] **T3 (P1, human: ~4h / CC: ~30min) — judge** — Add judge-hard.ts with H5 session evidence and capped H1 near misses
  - Surfaced by: eng-review — ENG-F3; score.ts:118 judgePrompt
  - Files: eval/runner/cat40/judge-hard.ts
- [ ] **T8 (P1, human: ~1d / CC: ~40min) — pg** — Chunk pg embeddings on Hard and attribute every paid request to a cell attempt or setup
  - Surfaced by: eng-review — ENG-F11, F12; pg-arm.ts:44
  - Files: eval/runner/cat40/pg-arm.ts
- [ ] **T10 (P1, human: ~4h / CC: ~30min) — regression** — Add the v1 regression contract tests (fixture scores, digests, score.ts hash, tool limits)
  - Surfaced by: eng-review — ENG-F20
  - Files: 
- [ ] **T1 (P1, human: ~1.5d / CC: ~1h) — runner** — Add attempts.jsonl, stop kinds (context_overflow, harness_error) and bounded harness-only retries
  - Surfaced by: eng-review — ENG-F1, F2; cat40-model-ladder.ts:374 done set
  - Files: eval/runner/cat40-model-ladder.ts, eval/runner/cat40/loop.ts
- [ ] **T5 (P1, human: ~4h / CC: ~30min) — scoring** — Add the Hard answer decoder (coercion, full-answer wrong check, unparseable_set) and mutation cases
  - Surfaced by: eng-review — ENG-F5, F19; score.ts:38 answerHead
  - Files: eval/runner/cat40/score-hard.ts
- [ ] **T3 (P1, human: ~4h / CC: ~30min) — analyzer** — Add the freeze-rule analyzer with PASS/FAIL per condition and Wilson intervals
  - Surfaced by: devex-review — DX-F6; ENG-F15
  - Files: eval/runner/cat40/analyze.ts
- [ ] **T2 (P1, human: ~1d / CC: ~40min) — cli** — Add --mode hard, --knobs, --max-turns, strict flag parsing and --help to the generator and runner
  - Surfaced by: devex-review — DX-F2, F3
  - Files: eval/generators/model-ladder-gen.ts, eval/runner/cat40-model-ladder.ts
- [ ] **T4 (P1, human: ~4h / CC: ~30min) — docs** — Write the Hard runbook and operator guide and link them from README, eval/RUNBOOK.md, CONTRIBUTING and the registry
  - Surfaced by: devex-review — DX-F4, F5
  - Files: docs/benchmarks/cat40-hard/RUNBOOK.md, README.md, eval/RUNBOOK.md, eval/CONTRIBUTING.md
- [ ] **T1 (P1, human: ~1d / CC: ~40min) — operator-script** — Add scripts/cat40-hard.sh with hello, preflight, step and status, and a hermetic test running hello
  - Surfaced by: devex-review — DX-F1, F4, F13
  - Files: scripts/cat40-hard.sh
- [ ] **T6 (P2, human: ~4h / CC: ~20min) — report** — Template the Hard report: models-first order, ceilings, stop kinds, all comparisons, cost per extra success, claim scope
  - Surfaced by: ceo-review — CEO-F8, F23, F25, F27
  - Files: 
- [ ] **T8 (P2, human: ~2h / CC: ~10min) — sensitivity** — Run and report the 16-turn sensitivity check after step 9
  - Surfaced by: ceo-review — CEO-F19
  - Files: 
- [ ] **T11 (P2, human: ~4h / CC: ~20min) — budget** — Commit the program ledger roster and make --preflight check it
  - Surfaced by: eng-review — ENG-F9
  - Files: 
- [ ] **T9 (P2, human: ~1d / CC: ~45min) — performance** — Run grep in a Worker with a time limit and restores as async subprocesses; split latency timers
  - Surfaced by: eng-review — ENG-F13
  - Files: eval/runner/cat40/arms.ts, eval/runner/cat40/gbrain-arm.ts
- [ ] **T5 (P2, human: ~4h / CC: ~20min) — errors** — Exit 3 with stable codes for every stop; refusals name the exact fix; held-out failures print counts only
  - Surfaced by: devex-review — DX-F7, F8
  - Files: 
- [ ] **T7 (P2, human: ~4h / CC: ~20min) — report** — Report entrypoint with offline table reproduction and setup/end-to-end latency
  - Surfaced by: devex-review — DX-F15
  - Files: 
- [ ] **T6 (P2, human: ~4h / CC: ~20min) — tools** — State Hard tool behavior in tool descriptions and add --hard-tool-limits
  - Surfaced by: devex-review — DX-F10, F11
  - Files: eval/runner/cat40/arms.ts, eval/runner/cat40/pg-arm.ts

#### What changed from the draft

- Cost: $700 became $475–830 (tier C) to $1,045–1,855 (tier A) from measured costs; the judge, smoke, builds and the
  16-turn check are priced; no paid step before the budget decision.
- Sequencing: Hard lands after the entity-recall wave and PR #63; `score.ts` and v1/large stay byte-identical.
- Models: an explicit `--judge gpt-6.1-sol` on every Hard run (the runner's default judge is gpt-5.4-mini) and refusals
  for gpt-5.4-mini and unpriced models; new releases replace predecessors by preregistration amendment.
- Calibration: a terminating freeze rule, fs and pg both calibrated, a five-model freeze check, paired rounds, and
  gbrain kept out of tuning (paid smoke on its own seed).
- Scales: one held-out seed; the 50k world appends near misses and non-deciding material and never changes an answer.
- Scoring: per-family scoring, a set/count scorer, `gold.wrong` invariants, a Hard answer decoder, a Hard judge, and
  stated authority, effective-date and user-statement rules.
- Harness: attempts with bounded harness-only retries, `context_overflow`, N sessions, slot quarantine, pg chunking,
  non-blocking grep and restores, cost attribution.
- Operator experience: `scripts/cat40-hard.sh hello|preflight|step|status`, CLI flags, runbook, freeze analyzer,
  exit-3 stop codes.
- Inference: a primary endpoint (pooled 4k), comparator committed before gbrain cells, decision sentences, held-out
  reuse policy.

<!-- AUTONOMOUS DECISION LOG -->
## Decision Audit Trail

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|---|---|---|---|---|---|
| 1 | Intake | Skip design; run DX with `--developer-tool` | Mechanical | P1 | 0 UI terms; operators and readers are developers | Running design |
| 2 | CEO | Mode SELECTIVE EXPANSION | Mechanical | override | autoplan override | other modes |
| 3 | CEO | Approach A (new `hard` mode) | Mechanical | P1 | only option with aggregation tasks | knobs-only; real corpus |
| 4 | CEO | CEO-F1 to F11 cherry-picks | Mechanical | P1/P2 | in blast radius, small | — |
| 5 | CEO | CEO-T1 freeze rule (provisional) | Taste | P1/P5 | terminating rule | per-model 40–70% band |
| 6 | CEO | CEO-T2 20×1 (provisional) | Taste | P1 | more power per dollar | 10×2 |
| 7 | CEO | CEO-E1 memory arm narrowing → budget tier | Taste (T3) | P6 | user's arm list stands | silent cut |
| 8 | CEO | Defer family D, real harnesses; skip 500k | Mechanical | P3 | outside blast radius | — |
| 9 | CEO | Spec rounds 1–3: accept all 82 issues | Mechanical | P1/P5 | correctness and clarity | — |
| 10 | CEO | 0H document approval A | Mechanical | P6 | recommended | revise; pause |
| 11 | CEO | Voices: UC1 turn cap, UC2 sealed variant | User Challenge | — | both models change direction | — |
| 12 | CEO | CEO-F16 revised: no paid step before budget decision | Mechanical | P1 | both voices | steps 1–4 first |
| 13 | CEO | CEO-F19 to F29 voice-derived additions | Mechanical | P1/P2 | evidence-backed | — |
| 14 | CEO | CEO-T4 Hard tool limits; T5 ablation defer; T7 SQL arm defer; T8 report-only | Taste | P3/P5 | single-voice items | — |
| 15 | DX | Mode DX POLISH; persona agent operator; TTHW target Champion | Mechanical | override/P1 | existing product enhancement | expansion; triage |
| 16 | DX | DX-F1 to F15 | Mechanical | P1/P5 | both voices confirmed gaps | — |
| 17 | DX | DX-T1 JSON-encoded string | Taste | P5 | strict-schema safe | array schema |
| 18 | Eng | Scope accepted as-is; original arrangement | Mechanical | P2/P5 | no smaller arrangement keeps G3 | smaller arrangement |
| 19 | Eng | ENG-F1 to F20 | Mechanical | P1/P5 | both voices; code-verified | — |
| 20 | Eng | ENG-T1 simultaneous intervals | Taste | P1 | voices disagree | single comparator only |
| 21 | Eng | TODOS.md: add 7 items | Mechanical | P3 | deferred scope | skip |

(Rows 4, 9, 13, 16 and 19 each cover the numbered findings listed in the phase sections; 64 auto-decisions in all.)

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | ISSUES OPEN | 33 proposals, 29 accepted, 4 deferred |
| Outside Review | Codex `gpt-6-astra` via `/autoplan` (CEO, DX, Eng) | Independent 2nd opinion | 3 | completed | 34 findings; 26 accepted into the plan; 8 routed to the gate |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | ISSUES OPEN | 11 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | skipped | no UI scope |
| DX Review | `/plan-devex-review` | Developer experience gaps | 1 | ISSUES OPEN | score: 3/10 → 8/10, TTHW: undefined → under 2 min |

- **OUTSIDE COVERAGE:** codex, CEO, completed, 10 findings; codex, DX, completed, 9 findings; codex, Eng, completed,
  15 findings; design skipped (no UI scope). Native subagents completed in CEO, DX and Eng; the CEO spec review ran
  three subagent rounds (6, 7, 7 of 10).
- **CROSS-MODEL:** native (Capy subagents, claude-opus-5-5) and codex (gpt-6-astra) agreed on 6/6 CEO dimensions, 6/6
  DX dimensions and 5/6 Eng dimensions; disagreements went to the gate as DX-T1 and ENG-T1.
- **VERDICT:** no review is CLEAR; every phase has open gate decisions. eng review required (re-run is not needed
  unless the gate changes scope).

**UNRESOLVED DECISIONS:**
- CEO-UC1 the 8-turn cap (user challenge)
- CEO-UC2 a sealed validation variant (user challenge)
- CEO-T1 freeze rule
- CEO-T2 tasks per family and repeats
- CEO-T3 budget tier and authorization
- CEO-T4 Hard tool limits
- CEO-T5 entity-recall-off ablation
- CEO-T7 extraction + SQL comparator for H1
- CEO-T8 economic threshold
- DX-T1 H1 answer encoding
- ENG-T1 comparator inference
