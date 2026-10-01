# Eval-category wave, lane N2 + A4 (branch `capy/wave-n2-a4`)

Scope: amendments 4 (N2 label adjudication, scorer mutation tests), 6 (N2 in three stages) and 7 (A4 with an explicit answerer). Based on `capy/eval-wave-step0` (`8eb51d3`). VERSION and CHANGELOG are untouched; the integrator writes the wave entry.

## Commits, in order

1. Generators and the N2 gold adjudication, no runs: `eval/generators/n2-contradiction-gen.ts`, `eval/generators/a4-abstention-gen.ts`, `eval/data/gold/contradictions-adjudication.json`, determinism tests.
2. Preregistration, frozen before any run: registry rows `contradiction-surfacing` (N2) and `abstention` (A4) with their promotion rules, placeholder runners, `docs/benchmarks/2026-10-01-n2-a4-preregistration.md`, and the amara-life query file.
3. Runners and tests (scorer tests with negatives, mutation-kit suites, broken systems, small PGLite runs).
4. Receipts, reports, bug ledger entries, docs rows, these notes.

Development runs used seed 7 only; every counted run used the default seed 20261001 on gbrain `3a284ae` through the copied overlay (`--gbrain <checkout>@3a284aea…`, `loaded_git_head` in every receipt). Bun stayed at 1.3.14: the Bun 1.4 requirement landed in gbrain v0.60.27.0, after the pin.

## Results

- **N2 hermetic:** pass. Safety contracts 0 and 0; candidate recall 150 of 150 (floor 0.50). Discovery without a company name: 4 of 150.
- **N2 paid (gbrain's judge, haiku-4-5):** end-to-end recall 105 of 150; false contradiction 0 of 60 dated changes, 2 of 51 compatible, 109 of 1,977 unplanted pairs; judged-pair precision 105 of 216. Preregistered decision: does not separate conflicts from dated changes (recall below 0.80).
- **A4 hermetic:** pass. A grade on 240 of 240 calls; answer text in the top five for 120 of 120 answerable. Every natural question graded `moderate`.
- **A4 paid (house reader, sonnet-4-6):** retrieved evidence 120 of 120 correct, 0 refused, 119 of 120 unanswerable abstained; oracle evidence 107 of 120 abstained under the frozen rule (12 of the misses are refusals that name another company's value).
- **S4 on:** not run (budget guard cannot price TypeSafe requests); recorded as A4-3.

## Bug ledger entries (`docs/benchmarks/2026-10-01-wave-bugs.json`)

Bugs: N2-1 (undated pages reach the contradiction judge with the fallback date; kills the date pre-filter and text-dated supersede proposals), N2-2 (`gbrain find-contradictions` with no flags returns nothing, against `skills/correction-pipeline/SKILL.md:214`), N2-3 (judge quality against its own prompt rules). Feature gaps: N2-4, N2-5, A4-1, A4-2. Category defects: N2-6 (amara-life gold labels), A4-3 (ledger cannot price TypeSafe), A4-4 (frozen A4 scorer counts named-other-value refusals as answers; one refusal pattern missed). N2-1 and N2-2 have keyless repros under `docs/benchmarks/2026-10-01-n2-contradiction-surfacing/repro/`.

## Cost

$9.62 of the lane's $25, all through one budget-ledger run (`eval-category-wave-lane-n2-a4-…`): N2 judge $5.74, A4 reader $1.12, and $2.76 from a first sequential N2 attempt that a tool time limit stopped with no receipt. The N2 paid arm now runs its queries in 4 concurrent probe runs.

## For the integrator and the fix wave

- The registry rows gate: N2 on two safety contracts and a candidate-recall floor, A4 on two quality thresholds. All held at `3a284ae`.
- The N2 hermetic arm takes about 76 s (51 s of page writes) and A4 about 33 s on a Capy machine; N2 is over the 60 s CI target.
- N2-1 fix sketch: carry `effective_date_source` into `PairMember` and pass null to the judge and the date filter when the source is `fallback`; rerun the N2 paid arm before and after, since it changes judge input.
- The ledger's PAID_HOSTS (A4-3) is a shared step-0 file; I did not change it.
- `docs/benchmarks/2026-10-01-wave-bugs.{json,md}` is shared across lanes; my entries are the N2-* and A4-* ids.
