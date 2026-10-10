# gbrain's memory proof wave: five product decisions and the measurements behind them

**Measured by gbrain on October 5-6, 2026, and mirrored here. This mirror reruns nothing; the fifth record's gates 1 and 1b ran this repository's B2 corrections bench.**

[gbrain](https://github.com/garrytan/gbrain) is a memory system for agents. Each time gbrain tries a new idea, it
writes down what it tested, what counted as a win, and what happened. Five ideas from its memory proof wave were
tested this way:

- Search two ways for an old fact a new one should replace.
- Pick the cutoff for "same fact, new value" separately for each embedding model.
- Keep standing answers to pinned questions.
- Look up the newest notes about the one thing a question is about.
- Hand the reader the saved facts that match a question, next to the notes.

The first idea did not help, so it stays off. The cutoff check showed the default model's setting was already
right and another model needed its own, so gbrain now stores the cutoff per model. Pinned answers were no more
accurate than handing a reader the same well-chosen notes, so they stay something an owner turns on. The fourth
idea fixed a real mistake in the test workload and is waiting for broader tests before it turns on. The fifth
puts saved corrections in front of the reader. Its first test failed because of how the test was built: each
correction was dated the day it was saved, after the question's date. Once corrections carried the date they were
made, it answered every corrected question right, so it is now on.

All five records ship in [garrytan/gbrain#6066](https://github.com/garrytan/gbrain/pull/6066) (branch
`capy/mpw-integration`). Each record names the gbrain commit it measured. The `decision.json` (what would be
tested and how) and `verdict.json` (what happened) files are copied byte for byte from gbrain's
`docs/eval/decisions/` into [`2026-10-05-memory-proof-wave-gbrain-verdicts/`](2026-10-05-memory-proof-wave-gbrain-verdicts/).

| Decision | Verdict | gbrain commit measured | Key numbers |
|---|---|---|---|
| [Interleaved supersession candidates](#interleaved-supersession-candidates) | No benefit; `facts.candidate_fusion` stays `rrf_free` | `91081f319b724bd1ca1a82d4636d0cc7eadae208` | Twin recall@5 99.6% → 98.9% at 0.85 and 0.90 (0 wins, 2 losses of 280); false supersession and preserved claims identical at every threshold |
| [Supersession threshold per embedding model](#supersession-threshold-per-embedding-model) | voyage-4 keeps 0.95; models without a calibrated threshold never supersede by cosine | `7d2cc1c7049ae6820131b91d146d2c950714583d` | voyage-4 at 0.95: 46.7% corrections missed, 0.75% false supersession, 99.8% distinct claims kept; 3-large at 0.95 wrongly replaces 53.75% of coexisting claims |
| [Pinned questions](#pinned-questions) | Opt-in; anchored retrieval is the measured win | run 3: `1384a0dbf8cc89d7c01b4576a9a346525893bdd0` | Pinned 0.981 accuracy vs anchored reader 0.968 at equal tokens; pinned loses seed 42; 0 leaks in 144 probes |
| [Entity-anchored query retrieval](#entity-anchored-query-retrieval) | Gates 1 and 2 pass; `search.entity_anchoring` stays off until the harness-lane gate 3 passes | `2fa44f149a352788421aed510a25ce3d574e81f4` | `query` + reader at equal tokens: 0.884 → 1.000 accuracy, 11.6% → 0% stale-wrong; no recall loss on existing `query` evals |
| [Facts arm in query](#facts-arm-in-query) | Gates 1b and revised 2 pass; `search.query_facts_arm` is on by default (gate 1 failed on a test-design flaw) | gate 1b: `947536f4c7e60623515e639727a80c380eee42dd`; gate 1: `16288b95ca700de1f4930d77196e6f49829b17c7` | B2 forget-then-remember, correction-dated: 92% → 100% correct, 8% → 0% stale; 0 recall@10 losses in all five `query` sets |

All five are dev-stage verdicts on synthetic, seeded fixtures. None was confirmed on a held-out set.

## Interleaved supersession candidates

**Measured at gbrain `91081f319b724bd1ca1a82d4636d0cc7eadae208`** (clean tree). Record:
[`c2-interleave-dev/`](2026-10-05-memory-proof-wave-gbrain-verdicts/c2-interleave-dev/).

When gbrain saves a fact, it looks for an older fact the new one should replace. The baseline (`rrf_free`) takes
candidates from one cosine-similarity list. The candidate (`interleave`) merges in a keyword list. The fixture has
40 synthetic companies, 1,148 seeded rows and 400 probes: corrections, restatements, back-to-back corrections,
private corrections, new members of coexisting claims and new claims. Every probe's expected twin is known by
construction. The fixture was replayed through gbrain's own `listSupersessionCandidates` with a local embedding
model, and statistics were paired by probe and clustered by company.

| Threshold | Twin recall@5 (rrf_free → interleave) | False supersession | Preserved distinct claims |
|---|---|---|---|
| 0.85 | 99.6% → 98.9% (CI −1.8 to 0 pts) | 19.5% → 19.5% | 93.3% → 93.3% |
| 0.90 | 99.6% → 98.9% (CI −1.8 to 0 pts) | 9.8% → 9.8% | 96.7% → 96.7% |
| 0.95 (product) | 99.3% → 98.9% (CI −1.1 to 0 pts) | 0.75% → 0.75% | 99.75% → 99.75% |

The cosine list already found 99.3% to 99.6% of twins, so the keyword list had almost nothing to add. Cutting the
merged list back to five dropped 1 to 2 twins. No decision changed. The overall kit result is `inconclusive`: the
superiority gate neither passed nor failed, and both guards passed. The default stays `rrf_free`. A follow-up with
production embeddings (next section) found the same.

## Supersession threshold per embedding model

**Measured at gbrain `7d2cc1c7049ae6820131b91d146d2c950714583d`** (clean tree). Record:
[`supersession-threshold-dev/`](2026-10-05-memory-proof-wave-gbrain-verdicts/supersession-threshold-dev/).

The same fixture was re-embedded with two production models and swept over cosine thresholds from 0.80 to 0.97.
The selection rule was fixed before the runs: the lowest correction miss rate with false supersession at most 1%
of probes and at least 99.5% of distinct claims preserved.

| Model | Threshold | Corrections missed | Coexisting claims wrongly replaced | All false supersessions | Distinct claims preserved |
|---|---|---|---|---|---|
| `voyage:voyage-4` (default) | 0.94 (balanced) | 37.1% | 7.5% | 1.5% | 99.5% |
| `voyage:voyage-4` | **0.95** (product; rule's pick) | 46.7% | 3.75% | 0.75% | 99.8% |
| `openai:text-embedding-3-large` | 0.95 (product) | 63.3% | 53.75% | 10.75% | 96.6% |
| `openai:text-embedding-3-large` | 0.97 (balanced) | 81.7% | 18.75% | 3.75% | 98.8% |

For voyage-4, a correction usually sits closer to its old value than a new coexisting claim sits to its siblings
(median cosine 0.949 against 0.924), so a window near 0.95 exists. For 3-large the order reverses, and no threshold
meets the rule. gbrain applied a per-model table in the same wave. `voyage:voyage-4@1024` keeps 0.95. A model with no
calibrated entry never supersedes by cosine: the new fact is inserted, and exact-text duplicates still collapse.
Even at the best setting, about half of corrections on the default model are not replaced by cosine alone. Fixing
that needs slot-aware supersession, which is proposed in the record but not built.

## Pinned questions

**Deciding run measured at gbrain `1384a0dbf8cc89d7c01b4576a9a346525893bdd0`.** Record:
[`c4-pinned-questions/`](2026-10-05-memory-proof-wave-gbrain-verdicts/c4-pinned-questions/). `verdict.json` carries all
three runs and the diagnostic attempt.

A pinned question is one gbrain keeps answered from the owner's notes, with a citation behind every sentence. The
answer is refreshed when its evidence changes, and a sentence goes stale the moment its evidence changes. The
safety gate passed on every run: 33 of 33 scenarios on PGLite and on Postgres, with zero leakage to restricted
grants on any read surface. The benefit gate took three runs.

**Run 1** (gbrain `a4267eed7bb6f9478df73fef6266b8a111a3891a`): when corrections rewrote the evidence page, every
arm answered every read correctly, so the run could only compare cost. Pinned matched query plus a reader only
after about 240 reads per pin. Verdict at the time: opt-in. Spend: $2.34.

**Diagnostic attempt** (gbrain `183fee7f3c3998109e0c96f0535b331c68d21306`): this used a harder workload, where
corrections arrive as new dated notes and the old notes stay as written. Pinned was no better than query plus a
reader (0.528 and 0.542 accuracy against 0.514). The cause was a bug: pinned refresh retrieval missed each entity's
newest note once notes piled up. The attempt was not a decision input. Spend: $2.93.

**Run 2** (gbrain `baadfc04064826e8c60dd8e67e0a55bf96f95c3f`, with the retrieval fixed to anchor on the pin's
entity, newest first): pinned 0.986 accuracy against 0.514 for query plus a reader and 0.792 for running `think`
on every read. Freshness lag was 0.017 write batches against 0.583. The record named the open question: pinned
retrieval was anchored and the other arms' retrieval was not. Spend: $2.98.

**Run 3** (gbrain `1384a0dbf8cc89d7c01b4576a9a346525893bdd0`, the deciding run) closed that question. Its rule was
pushed before any cell ran (gbrain `e17258eb52ea976effdee365efd405c892b92be7`). The setup:
- A control arm hands the exact evidence pinned refresh retrieves to the same reader at the same token budget.
- `voyage:voyage-4` embeddings are on for every arm.
- Three seeds: 42, 7 and 1234.

The rule: pinned stays default-on only if it beats the control in every seed on accuracy or freshness, with zero
leaks.

| Arm (mean across 3 seeds) | Accuracy | Stale-wrong | Freshness lag (batches) |
|---|---|---|---|
| Pinned, default refresh model (`anthropic:claude-opus-4-7`) | 0.981 [0.972, 1.000] | 0.000 | 0.022 |
| Pinned, `anthropic:claude-sonnet-5-5` refresh | 0.995 [0.986, 1.000] | 0.000 | 0.006 |
| **Anchored retrieval + reader, equal tokens (control)** | 0.968 [0.944, 0.986] | 0.000 | 0.039 |
| Anchored retrieval + reader, full evidence | 1.000 | 0.000 | 0.000 |
| Query + reader, equal tokens | 0.884 [0.875, 0.903] | 0.116 | 0.139 |
| Query + reader, full evidence | 0.991 | 0.009 | 0.011 |
| `think` on every read | 1.000 | 0.000 | 0.000 |

Pinned beat the control in seeds 7 and 1234 but lost seed 42 (0.972 against 0.986 accuracy). That is a tie, so
pinned questions ship opt-in, and the anchored retrieval is the measured win. There were 0 leaks in 144
restricted-grant probes. Pinning is still the cheapest way to serve an entity question that is read often. At 100
reads per write, a correct pinned answer costs $0.00057, against $0.00152 for the anchored reader at equal tokens.
Pinned overtakes that reader after about 110 reads per pin. The reader for all pinned and query arms was the
B-suite fixed reader, `anthropic:claude-sonnet-5-5`. Spend: $11.81, including a one-entity smoke run and a replay
that tried to reproduce a malformed-reply failure.

The same wave fixed that failure mode. gbrain's refresh parser now tries every balanced JSON object in a reply, and
retries once with a JSON-only reminder before failing. Run 3 had no refresh failures in 432 attempts.

## Entity-anchored query retrieval

**Measured at gbrain `2fa44f149a352788421aed510a25ce3d574e81f4`.** `c4add4176e5fc178e5a77c4d8c6f0debfb2952e4`
moves the op seam with no change in behavior. Record:
[`entity-anchoring-query/`](2026-10-05-memory-proof-wave-gbrain-verdicts/entity-anchoring-query/). The gates were
preregistered at gbrain `9a8cfb9f76063c69765c884217ef4d1e3a83f618`.

Some questions name one entity and ask for its current state, such as "which city does it build widgets in now?".
With `search.entity_anchoring` on, gbrain's `query` and `search` answer those with the entity's page first, then
the pages that link to it or name it, newest first. The row count and token budget stay the same. Detection uses
fixed rules and makes no model call. Every added row is re-checked against the caller's read permissions.

**Gate 1, seeded workload (pass).** This is the run-3 workload, read through the real `query` op with the key on
and off, by the same reader at 200 tokens. Anchoring fired on all 216 states.

| Arm (mean across seeds 42, 7, 1234) | Accuracy | Stale-wrong | Freshness lag (batches) | $ per correct |
|---|---|---|---|---|
| Key on, equal tokens | 1.000 | 0.000 | 0.000 | 0.00127 |
| Key off, equal tokens | 0.884 [0.875, 0.903] | 0.116 | 0.139 | 0.00133 |
| Key on, full evidence | 1.000 | 0.000 | 0.000 | 0.00230 |
| Key off, full evidence | 0.981 | 0.009 | 0.022 | 0.00235 |

**Gate 2, existing `query` evals (pass).** NamedThingBench, the relational retrieval-quality fixture and the
LongMemEval nightly fixture were run with the key on and off. No question lost recall@10. On their questions as
written, anchoring never fired, so this shows that nothing else moves, not that anchoring helps there. As a
diagnostic, appending " now" made it fire on 24 of 38 relational questions, with 8 recall gains and 0 losses.
With the key off, results match the build without the change, apart from fields that differ between any two runs.

**Gate 3** is the harness lane's job: LongMemEval knowledge-update, PersonaMem and BEAM dev slices, then
validation. The key stays off until it passes. Spend for gates 1 and 2: $1.52.

## Facts arm in query

**Measured at gbrain `947536f4c7e60623515e639727a80c380eee42dd` (gates 1b and revised 2) and
`16288b95ca700de1f4930d77196e6f49829b17c7` (gates 1 and 2).** Record:
[`query-facts-arm/`](2026-10-05-memory-proof-wave-gbrain-verdicts/query-facts-arm/). Gates 1 and 2 were preregistered
at gbrain `a87c3e2afa4e7abb1972dbdc01beb9cf28d25947`. Gates 1b and revised 2 were preregistered at gbrain
`c672352d4480ea605754aaa2b7659a085bf83ebc`, and that text is in
[`preregistration-gate-1b.md`](2026-10-05-memory-proof-wave-gbrain-verdicts/query-facts-arm/preregistration-gate-1b.md).

gbrain's `query` adds up to three active saved facts that match the question as rows next to the notes. They only
use spare room: free slots under the caller's row count and what the notes leave of the token budget. A note is
never pushed out, and it makes no model call. It is on by default, and `search.query_facts_arm=false` turns it off.

**Gate 1b, B2 corrections with correction-dated writes (pass).** This repository's corrections bench
(`corrections-v1`, seed 20261006, 100 items, reader `claude-sonnet-5-5`) ran with `--remember-valid-from`. Each
saved correction carried the date it was made.

| Arm | Key | After 1 write: correct / stale | After 5 writes: correct / stale |
|---|---|---|---|
| forget-then-remember | off | 92% / 8% | 92% / 8% |
| forget-then-remember | on | 100% / 0% | 100% / 0% |
| edit-sync | off and on | 100% / 0% | 100% / 0% |
| append | off and on | 100% / 0% | 100% / 0% |

The fact row was in context for all 200 answers after the correction. Edit-sync and append save no facts, so the
arm never fired there. They sit at 100% either way and show no loss.

**Revised gate 2, existing `query` evals (pass).** NamedThingBench, the relational fixture and the LongMemEval
nightly fixture were run, plus copies of the first two with one saved fact per question. No question lost
recall@10 in any of the five. The arm fired on 11 of 12 and 38 of 38 questions in the copies. At the earlier
build, which let a fact row take a full page slot, the relational copy lost recall@10 on 2 questions.

**Gate 1, as first built (fail).** Without correction dates, every saved correction looked newer than the
question. Key off answered 0% correct and 92% stale. Key on answered 0-1% correct and 4-6% stale. The reader named
the correction in 158 of 200 answers but treated it as not yet in effect. Gate 1b fixed the bench, not the product.

Spend: $26.05 for gates 1 and 2 (cap $40) and $18.05 for gates 1b and revised 2 (cap $30). The bench flags
(`--gbrain-search-config`, `--remember-valid-from`) are in this repository since `d01d3bc`. The patch the gate 1
runs used is kept as
[`bench-flags.patch`](2026-10-05-memory-proof-wave-gbrain-verdicts/query-facts-arm/bench-flags.patch).

## Limits of these results

- **Dev stage, synthetic fixtures.** Every number above comes from seeded, templated workloads built to stress
  one mechanism. The entity-anchoring workload in particular was built around the failure mode it fixes.
- **Mirrored, not re-measured.** This repository copies gbrain's records. The facts-arm gate 1 ran this
  repository's bench with a local patch; its numbers, and gate 1b's, are gbrain's record, copied byte for byte. The pinned-questions and
  entity-anchoring harnesses are in gbrain (`evals/pinned-questions/`, `evals/entity-anchoring/`), and the C2 and
  threshold sweeps are in `scripts/eval-c2-candidate-fusion.ts`. Each record's `reproduce` field gives the
  command.
- **Unmetered embedding calls.** The harness spend guards metered model calls. Voyage embedding and rerank calls
  were not metered; they were small.

## Changelog

- 2026-10-05: First version, mirroring the four records from gbrain#6066.
- 2026-10-06: Added the facts arm in query record (gate 1 fails, gate 2 passes; stays off).
- 2026-10-06: Facts arm gates 1b and revised 2 pass; the key is on by default.
