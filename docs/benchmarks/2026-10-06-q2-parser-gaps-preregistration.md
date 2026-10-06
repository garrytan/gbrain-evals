# Q2 parser gaps: preregistration

Decision id `q2-parser-gaps-2026-10`. This record fixes the held-out material, arms, metrics, bars and decision
procedures for the follow-up to gbrain's typed line grammar (P5) and its relationship-phrase typing. It was committed
on 2026-10-06, before any held-out material for it was minted. Sealed runs are executed by the custodian only. The
implementer never sees custodian text, and every receipt that leaves custody carries aggregates and hashes only.

The gbrain change under test lives on gbrain branch `capy/q2-parser-gaps`; this repository's harness changes live on
the branch of the same name. The frozen build SHA, the unit commit SHAs and the runner commit SHAs are appended to the
"Freeze record" section below before any cell runs. Nothing else in this file may change after a cell is opened.

## Background

- **P5 H3** (junk audit, frozen build `21befeb5b`) failed: 18 lines minted from 696,295 list lines, all fact lines,
  precision 0/18 (Wilson 95% [0.00, 0.18]). Every minted line's bracketed prefix was an unfilled template slot (15) or a
  dictionary usage label (3). The zero-tolerance classes passed. H6 (typed lines help answers) did not run.
- **P5 delta sets G and H** failed H10/H11. The post-freeze typing and temporal-lexicon changes were removed together
  under the delta's cycle limit (gbrain `780a4fc5`), although on set H the bundle beat master on as-of, now-precision,
  correction and two trap families and lost on live-edge recall.
- Records: [P5 program page](2026-10-05-heldout-program/p5.md),
  [H3 verdict](2026-10-05-heldout-verdicts/p5-h3-heldout-2026-10-06.json),
  [set H verdict](2026-10-05-heldout-verdicts/p5-delta-set-h-2026-10-05.json).

## What is decided

| Change | Setting | Default if its gates pass | If they fail |
|---|---|---|---|
| Typed relation lines (`- works_at [[companies/x]]`), with the Q2 guards, diagnostics and guidance | `line_grammar.enabled` | on (new and existing brains; opt-out) | off (opt-in, as today) |
| U1 adviser wording | none (extraction) | kept | reverted before landing |
| U2 ordinary job roles (post-pass on `mentions`) | none | kept | reverted |
| U3 board, observer and investor wording never types `works_at` | none | kept | reverted |
| U4 advisory, board and investor roles are not employment starts | none | kept | reverted |
| U5 leave idioms and exchange moves | none | kept | reverted |
| U6 onboarding and first-day start framings | none | kept | reverted |

Not decided here, and shipped regardless: the line-grammar guards (A1 bare template slot, A2 separator claim, A3
placeholder claim, A4 lexicographic usage label), the grammar diagnostics and advisory fields, and settings-bound link
extraction. They only remove junk, explain refusals or make a setting change converge. G1, G3 and G4 report their
effect. Fact lines (`- [category] claim`) carry no feature. They must pass the junk gates because they appear in the
write advisory once the grammar is on.

If U3 and U4 depend on each other (the implementer's development trace decides, recorded in the freeze record before
any cell), they form one joint unit `U34` with U4's primary metric, and the family has five units.

## Custody

- **Custodian:** GBRA-49's second custodian (Subagent 10 of GBRA-49), which has read none of the candidate code. It
  writes material only from this file and from the published, generic mechanism descriptions in the P5 records.
- **Where:** the custodian's machine, with a copy in owner custody on Garry's Mac. Never Capy Drive and never a git
  worktree. Runners refuse custody paths inside any git worktree, including through symlinks.
- **Access log:** every read of a custody file appends a line to `access-log.jsonl` beside it.
- **Overlap check** before hashing: no document, template line or masked template skeleton (entity names, dates and
  numbers masked) shared with sets B–H, N9 v1, H3's frame (LongMemEval-S haystack sessions, LoCoMo transcripts and the
  CC0 notes vault, all parts), sealed-confirmation-v1, or development material (gbrain docs and skills, amara-life-v1
  text, world-v1, transcript-distill-v1, temporal-edges phrasing sets A, A2 and A3, the P5 dev seeds). Near-duplicates
  are checked by skeleton hash and word 8-gram overlap. Ordinary language ("is an advisor") is allowed.
  **sealed-confirmation-v2 is excluded and is not opened for the check** (reserved for release decisions).
- **Gold support:** for generated material (K, W1, W2, the career corpus and its questions), two judges,
  `claude-sonnet-5-5` and `gpt-6.1-sol`, confirm each gold label is supported by the rendered text. Unsupported labels are
  removed before hashing. Ambiguous, contradictory and unanswerable items are kept as explicit categories.
- **Hashes:** the SHA-256 of every custody file is appended to the freeze record before the build is frozen.
- **Minting budget:** about $60–120 (generation plus gold-support judging).

## Material

### N, natural text (G1, G4)

| Stratum | Source |
|---|---|
| beam | BEAM-1M **sealed** conversations (24 per `eval/decisions/splits/beam-1m.json`), rendered as pages by the runner's BEAM loader. About 680,000 list lines projected. This spends the last unopened BEAM sealed set. |
| vault | Permissively licensed public markdown notes vaults never used by this program, pinned to a commit with per-file blob hashes |
| templates | A permissively licensed public collection of markdown templates (meeting, schedule, form and journal templates), pinned the same way |
| stress | Custodian-generated assistant chats and notes in the shapes behind H3's failures and their neighbors: schedules and itineraries with unfilled slots, glossaries, dictionary and usage-label entries, checklists, forms, changelogs, wiki exports. At least 2,000 template- or label-shaped list lines |

Floor: 500,000 list lines over all strata. Custody format: `n-manifest.json`,
`{ "id", "strata": [{ "id": "beam"|"vault"|"templates"|"stress", "license", "source", "commit"?, "files": [{ "path", "sha256" }] }] }`.
The beam stratum lists conversation ids instead of files.

### K, conformance pages (G3, G4)

About 300 realistic pages. Each line candidate is minted per class. The valid or decoy label is assigned **by the
frozen grammar at run time** (the runner records which near-miss shapes the frozen build accepts), so the custodian only
mints candidates. Classes and minimums:

| Class | Candidates |
|---|---|
| `relation` (the published shape, base-pack verbs, with `@effective` ranges and trailing context where natural) | ≥ 400 |
| `fact` (the published shape, open categories, tags, context, claims containing links and negative numbers) | ≥ 300 |
| H2 decoys: `prose_tail`, `two_links`, `multiword_unquoted_type`, `stoplist_type`, `machine_section`, `undeclared_type` | ≥ 40 each |
| Guard decoys: `template_slot`, `separator_claim`, `placeholder_claim`, `usage_label` | ≥ 40 each |
| Near-miss shapes: `colon_type` (`- works_at: [[x]]`), `bold_type`, `backtick_type` | ≥ 40 each |

Format: `k-pages.jsonl`, one page per line:
`{ "id", "slug", "content", "lines": [{ "line", "class", "kind": "relation"|"fact", "expected": { "type"? , "category"? , "target"? } }] }`.

### I1 and I2, temporal phrasing sets (C-gates)

Six fresh `temporal-edges` phrasing files (the `PhrasingTemplates` format checked by `validatePhrasing` in
`eval/generators/temporal-edges-gen.ts`), three for I1 and three for I2, each with its own seed outside every seed used
so far (3, 5, 11–17, 29–163 and the P5 dev seeds 1–3). The custodian writes them from the published mechanism
descriptions: role-bearing employment phrasings (a role followed by "for <company>", a join described as a new chapter,
a move with the role in parentheses, "signed on with … as <role>"), adviser wording, board, observer and investor
wording, idiomatic leaves (including split-object and quitting idioms), first-day and onboarding starts, exchange moves,
and their event look-alikes. Runs use the E5 probe people (`--e5-probe`) and the single-value pass (`--pack`
`--single-value-pass`).

### W1 and W2, natural typing pages (C-gates)

Two disjoint sets of about 150 pages each, in world-v1's page format (`{ slug, type, title, compiled_truth, timeline,
_facts }`; company `_facts` carry `founders`, `employees`, `investors` and `advisors` as in
`eval/runner/world-v1-gold.ts`). They are written by a frontier model in five styles: bio, meeting notes, email digest,
dated timeline and investor memo. They include employment changes, concurrent roles, advisory, investor and founder
relations, board and observer wording that entails none of them, third-party mentions, negations and look-alikes. Each
set needs at least 300 gold edges. W1 is used for selection and W2 for confirmation.

### Q, write-then-answer (G6)

| Corpus | Questions |
|---|---|
| amara | 100 fresh question pairs (relational and temporal) over amara-life-v1. Fresh questions over a familiar corpus, reported separately |
| career | A fresh career-chronicle corpus (raw emails, notes and bios rendered from a ledger the implementer never sees: employment changes, advisory and investor relations, concurrent roles), with 100 question pairs on current employer, advisor, investor and "where did X work on date D", including unanswerable items (at least 20 questions) |

Format: `q-questions.json`,
`{ "id", "templates": { "questions": [{ "id", "pair", "corpus": "amara"|"career", "type": "relational"|"temporal", "answerable": true|false, "question", "answer" }] } }`,
plus `career-corpus/` (one markdown or text file per raw document, with `career-manifest.json` listing paths and hashes).

## Builds and arms

- **Baseline:** gbrain master at the freeze point (recorded in the freeze record).
- **Candidate:** the frozen Q2 build. Unit refs are committed refs built from the frozen unit commits. Package refs are
  built after I1 by the committed package script from those commits, in the order the selection procedure gives. Every
  subset of units builds and passes unit tests before the freeze.
- **Grammar runs (G1–G5):** candidate and baseline both with `line_grammar.enabled=true`
  (`GBRAIN_EVAL_CONFIG`), written through `put_page` on in-memory PGLite with the active pack's declared verbs.
- **Typing runs:** one arm per unit (baseline plus that unit) on I1 and W1, then the nested package arms on I2 and W2.
- **Write-then-answer (G6):** both arms are the final Q2 build with the confirmed typing package. Arm A sets
  `line_grammar.enabled=false` and uses `eval/data/p5-write-then-answer/guidance-a.md`. Arm B sets it true and uses the
  guidance that would ship (hashed in the freeze record). Tool results are never capped.
- **Equivalence after the verdict:** the head that merges must be behavior-identical to the evaluated arms. The
  implementer checks this deterministically on dev corpora. The custodian compares row hashes on I2 and W2 for the
  final head; this is a verification, not a new decision. A rebase that changes extraction or grammar code voids that
  part's evidence.

## Statistics conventions

Intervals are two-sided 95%: Wilson for proportions, cluster bootstrap with 10,000 resamples otherwise, with the seed
recorded. "Superior" means the lower bound is above 0. "Noninferior at m" means the lower bound is above −m. Each test
is one-sided at α = 0.025. An interval that is neither superior nor clearly inferior counts as a failure for a gate that
requires superiority or noninferiority. "Exact" bars compare counts with no interval.

## Gates

### G1, natural junk (set N)

Every line the candidate mints on N is labeled (not sampled) by `claude-opus-5-5` and `gpt-6.1-sol` with judge prompt
`q2-judge-v1` (frozen in the freeze record). The judges answer whether the author meant the line to state the typed
relation or fact the parser read. A disagreement counts as wrong, and there is no adjudication.

- Zero-tolerance classes minted = 0, exact. The classes are timecode, task marker, citation, date, machine-written
  section, **template slot** (a bracket token followed in the same item by a bare bracketed slot, or by a separator, with
  links, escapes and code excepted) and **usage label** (a bracket token from the published label list). The runner's
  own deterministic checker defines all seven, independently of the parser.
- Stress stratum: wrong mints = 0, exact.
- All of N: the Wilson upper bound of wrong mints ≤ 2 per 100,000 list lines.
- Reported: affected-page rate, counts by failure class and stratum, and precision on N's mints if at least 30 mint.

### G2, relation-line precision where it is used

The stratum is the relation lines the candidate minted in arm B's ingest brains (G6, every model and ingest). Up to 300
are sampled with a frozen seed, stratified by model (all are used if there are fewer), and labeled as in G1.

- Bar: Wilson lower bound ≥ 0.95. Fewer than 150 lines is "insufficient", which fails.
- Reported: fact-line precision in the same stratum, precision on K's and N's mints, and a by-brain cluster interval.

### G3, conformance (set K)

- Relation candidates the frozen grammar defines as valid: recall ≥ 0.98, with a Wilson lower bound ≥ 0.95.
- Every decoy class: minted = 0, exact. That includes near-miss shapes the frozen grammar does not accept.
- Fact recall is reported.

### G4, guard loss

On N and K, consider every line the baseline mints that both judges call correct. Every baseline-only mint is labeled.
The share the candidate still mints must be ≥ 0.99.

### G5, carry-over of P5 H1 and H2

- world-v1 `anyTypeMatch` is noninferior at 0.01, and 240/240 pages type identically with the grammar on and off.
- Relation-line variants, on fresh generator seeds chosen by the custodian: typed recall ≥ 0.98 and decoy types added = 0.

### G6, write-then-answer (set Q)

**Models:** `claude-sonnet-5-5`, `gpt-6.1-sol`, `claude-opus-5-5` and `claude-fable-5-1`, the newest model of each frontier
family on 2026-10-06. The custodian checks for newer models and records the final list in the freeze record before any
G6 cell. Changing it afterwards needs a written amendment before any new cell.

**Matrix:** 2 corpora × 4 models × 2 arms × 3 independent ingests. Each question is answered once on each ingested brain
of its corpus. Each answer is judged once by `gpt-6.1-sol` with frozen rubric `q2-wta-judge-v1`, which scores answerable
and unanswerable items separately. A 10% second-judge audit by `claude-opus-5-5` reports agreement.

**Inference:** a crossed bootstrap. It resamples question pairs within corpus strata, with the draws shared across models
and arms. Independently, it resamples whole ingest brains within each corpus × model × arm cell, carrying all their
answers together.

**Size:** the counts above are floors. A power simulation over every G6 gate, from a development pilot with two ingests
per model on development questions, may raise them before the freeze. A raise is recorded in the freeze record with its
cost and needs the owner's approval when the total passes the $2,800 alert. Sizes never fall.

**Bars:**

- Pooled over models and corpora: B − A ≥ +3 points, with the lower bound above 0.
- Per model: the lower bound of B − A is above −3 points.
- Per question type (relational, temporal): the lower bound of B − A is above −2 points.
- Unanswerable items: the upper bound of the false-answer rate difference (B − A) is below +2 points.

**Reported, not gated:**

- An immediate-answer cell: 25% of questions, one ingest per model, both arms, with automatic serve sweeps off and
  extraction state recorded before and after answering, plus one HTTP-writer journey.
- Adoption recall: of list lines both judges say the agent meant as typed relation lines, the share minted, with misses
  by reason code.
- Grammar lines and diagnostics per page.
- Cost per question and per correct answer.
- The amara and career corpora separately.

### C-gates, typing units

**Primary metrics** (one per unit, oriented, measured on the temporal-edges set unless noted):

| Unit | Primary metric | Direction |
|---|---|---|
| U1 | advisor-trap accuracy | up |
| U2 | live-edge recall | up |
| U3 | investment-trap accuracy | up |
| U4 (or U34) | false employment starts per E5 probe person, by transition identity (subject, target, type, kind, date) | down |
| U5 | recall of correct end transitions, by identity | up |
| U6 | recall of correct start transitions, by identity | up |

**Safety conditions** (all required; an intersection-union test, so no further correction):

- Every temporal-edges gate is noninferior at 0.01: now-precision, now-recall, as-of exact, during-F1, live-edge recall,
  correction, and each trap family.
- Trap counts are not below the comparator in any family.
- Write-order invariance is 240/240.
- New wrong transitions by identity = 0, exact. This is the set difference from the comparator, and it includes
  single-value closures on the E5 probe and in the general single-value pass.
- Missing correct transitions are not above the comparator.
- W: typed recall per gold type is noninferior at 0.01, and spurious specific types (a typed edge whose gold is another
  type or no edge) are not above the comparator by more than 0.5 points.
- world-v1 `anyTypeMatch` is noninferior at 0.01.

**Selection, on I1 and W1** (comparator: baseline). A unit is selected when its primary metric is superior after Holm
correction across the units (family-wise α = 0.05) and every safety condition holds.

**Order:** the selected units are ordered by their I1 standardized effect (effect divided by its bootstrap standard
error), with ties broken by unit id. This gives nested packages P1 ⊂ P2 ⊂ … ⊂ Pk.

**Confirmation, on I2 and W2, opened once.** All packages are run in that single opening, and they are evaluated in
fixed sequence. Pj is evaluated only if Pj−1 passed (P0 is the baseline). Pj passes when all of the following hold:

- The added unit's primary metric is superior against Pj−1.
- Every earlier unit's primary metric is noninferior at 0.01 against Pj−1.
- Every safety condition holds against the baseline.

The longest passing prefix ships, and no unit after the first failure ships. I2 and W2 are never reopened for this
decision.

### Guardrails

- LongMemEval-S `recall_all@5` is noninferior at 0.01. It runs once, on the final candidate.
- N4 resolver: no item that resolved correctly on the baseline merges wrongly (exact).
- relational-ab one-hop: 0 questions worse.
- Reported only: P1 E3 correction visibility and P7's world-v1 composed-hop development probe.

## Default rule

- `line_grammar.enabled` defaults on only if G1–G6 and the guardrails pass. Existing brains then get it at upgrade as an
  opt-out, with a behavior notice and one zero-LLM link re-extraction.
- A typing unit ships only if it is in the longest passing prefix. Every other unit is reverted before landing, and its
  verdict is recorded.
- There is one cycle. No amendment may change a bar, corpus, gate, tail, model list or procedure after any cell is
  opened. A failure is final for this decision, and a retry needs a new preregistration and new material.

## Order of runs

1. C-gates: selection on I1 and W1, then the package script, then confirmation on I2 and W2 (one opening).
2. Build both G6 arms from the final Q2 build with the confirmed package.
3. G6 ingest. G2's stratum is arm B's brains, and no earlier ingest artifact is reused.
4. G1, G3, G4, G5 and G2.
5. The G6 answer phase, only if G1–G5 pass.

A campaign manifest in the runbook enforces this order: a step refuses to start without its predecessors' receipts.

## Budget

| Item | Estimate |
|---|---|
| Minting and gold support (custodian) | $60–120 |
| G1–G4 judging | ≈ $30 |
| Typing runs (deterministic) | ≈ $5 compute |
| Development pilot and power simulation | ≈ $150 |
| G6 ingest (48 ingests) | ≈ $450 |
| G6 answers (9,600 sessions plus about 800 immediate), judging and audit | ≈ $1,280 |
| LongMemEval-S guardrail embeddings | ≈ $10 |
| **Total** | **≈ $2,100; alert at $2,800** |

Exceeding the alert needs the owner's decision and never changes a bar. If G1–G5 fail, the answer phase is not run.

## Freeze record

Appended before any cell runs: the frozen gbrain build SHA and baseline master SHA; unit commit SHAs and whether U3 and
U4 are joint; the harness commit; custody file hashes; judge prompt and rubric hashes; arm-B guidance hash; the final
model list; any power-simulation raise.

(empty)

## Changelog

- 2026-10-06: first version, before any material was minted.
