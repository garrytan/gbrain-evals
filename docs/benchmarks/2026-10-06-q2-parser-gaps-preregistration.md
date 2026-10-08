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
any cell), they form one joint unit `U34` with U4's primary metric, and the family has five units. Amendment 3 records
the final family (U1, U25, U34, U6).

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
| beam | BEAM-1M **sealed** conversations (24 per `eval/decisions/splits/beam-1m.json`, less the three amendment 1 excludes: 21), rendered as pages by the runner's BEAM loader. About 590,000 list lines projected. |
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

## Amendments (before the freeze; no cell has run)

1. **2026-10-06, N's beam stratum.** The beam stratum excludes BEAM-1M sealed conversations `1m-1`, `1m-6` and
   `1m-26`. GBRA-52's proof wave ran them end to end, and its per-question receipts are public on gbrain-evals branch
   `capy/mpw-harness`, so they are no longer unopened material. The stratum keeps the other 21 BEAM-1M sealed
   conversations, about 590,000 list lines projected, so N's 500,000-line floor still holds before the other strata
   are counted.
2. **2026-10-06, concurrent opening.** GBRA-52's QA-only proof wave may open the remaining BEAM-1M sealed conversations
   while Q2 runs. N's freshness is unaffected: those QA cells never parse list lines or produce line labels, and
   GBRA-52 keeps every BEAM-1M per-question row and conversation id in custody and publishes only pooled aggregates
   until Q2's decision is recorded. If GBRA-52 publishes per-conversation material for any of the 21 before Q2's G1
   cell opens, the custodian drops that conversation from the beam stratum, records the drop here, and checks that the
   500,000-line floor still holds.

3. **2026-10-06, dependency units (from the development trace; no cell has run).** The implementer's development trace
   (gbrain `docs/eval/decisions/q2-parser-gaps/dev-trace.md` and `dev-units.md`) shows two dependencies. (a) U4 depends
   on U3: on the board-director development phrasing, U4 alone lowers as-of exact from 0.946 to 0.783, while U3 alone
   and U3 with U4 both give 0.950. Under the clause above, U3 and U4 form the joint unit `U34`, with U4's primary metric.
   (b) U2 depends on U5 in the same way: a current employer that U2 newly types meets a former employer whose leave only
   U5 reads, so with U2 alone the general single-value pass closes that former employer at the new employer's start.
   That leaves one development wrong closure each on two phrasings, and adding U5 removes both. U2 and U5 therefore form
   the joint unit `U25`, with U2's primary metric (live-edge recall, up). The plan's rule that each unit is one
   dependency unit with no development wrong closure applies to the joint unit. The family is U1, U25, U34 and U6 (four
   units). Holm runs across these four, and the package order uses them. Every other bar is unchanged.

4. **2026-10-07, G6 model set (owner's evaluation rule; no cell has run).** On 2026-10-07 the owner made Claude Opus 5.5
   the top Anthropic model in counted runs and limited Claude Fable 5.1 to smoke tests: no paid counted cells, no
   practice rounds and no held-out runs. G6's models are therefore `claude-sonnet-5-5`, `gpt-6.1-sol` and
   `claude-opus-5-5`. The matrix becomes 2 corpora × 3 models × 2 arms × 3 independent ingests. "Pooled over models"
   means pooled over these three, and the per-model bar (lower bound of B − A above −3 points) applies to each of the
   three. G2's stratum (arm B's ingest brains, "every model and ingest") and its by-model stratification cover the same
   three models. The immediate-answer cell runs one ingest per model for the three. The development pilot's Fable 5.1
   cells, finished before the rule, stay in its receipts, but the power simulation and the G6 sizing exclude them. The
   judge (`gpt-6.1-sol`), the audit judge (`claude-opus-5-5`) and every bar's threshold are unchanged. No other gate
   names a model set: G1–G4 use the two judges, and G5 and the C-gates make no model calls.

## Freeze record

Appended before any cell runs: the frozen gbrain build SHA and baseline master SHA; unit commit SHAs and whether U3 and
U4 are joint; the harness commit; custody file hashes; judge prompt and rubric hashes; arm-B guidance hash; the final
model list; any power-simulation raise.

### Custody material (recorded 2026-10-06, before the freeze; no cell has run)

Minted by the second custodian for $23.09; the owner copy on Garry's Mac matches.

| File | SHA-256 |
|---|---|
| `custody-hashes.txt` (all 5,071 material files; replaces the earlier 5,070-entry list `aef53279…`, re-sorted by path in locale order rather than byte order, entries unchanged apart from the G5 seeds file) | `1f5932081e0acb3c067d1603004a2e02e0eca665f2bb9ec56810442761dc056e` |
| `g5/g5-seeds.json` (fresh generator seeds for G5's relation-line variants; values stay in custody) | `b739fecd2f19054f8fee76ed65de23b5c65f0bcc4d349e61677b5c52638a345d` |
| `n/n-manifest.json` | `d69787ff3aea3a8072d53f4eabf234af9f541ad4330807bc53f2f3b1cfa4a964` |
| `k/k-pages.jsonl` | `b53550175563bf63748778c0b65a447eaf9120014008204f84debd0dc795e1e2` |
| `w1/w1-manifest.json` | `c3b644d55716fd13e824108f9d6130b84abecb33595b2a925716f5275022779d` |
| `w2/w2-manifest.json` | `656ac7a9a9c9062254b27a97001ac762f1004a89ba14df30b98f62e97d073bb8` |
| `q/q-questions.json` | `08984d33574b0a130aea31e90e24eb916fa29d9d1175f1c6841cada1ecb4f2cc` |
| `q/career-corpus/career-manifest.json` | `95128151446679bc3eeba2444870b79e5f052c8632c10330a309a0d212bfb5ea` |
| `i/phrasing-i1a.json` | `08c2c0c2d57ab0434a4b1a346fcaf98adf6d859b1cdfa935e72050e0089a81b0` |
| `i/phrasing-i1b.json` | `dd5e755a59da70e7e9df560d66c22fcf8f2b677b0119e333e3fe35cf270fa1b6` |
| `i/phrasing-i1c.json` | `66e21867b2b104ae7143c01c694682503b3d023b4eda46a24157b0d88d2fcff3` |
| `i/phrasing-i2a.json` | `219888d54f691678ae9170bbc36eef3befdd771c749e1c2264c9496342bfc434` |
| `i/phrasing-i2b.json` | `1ba7cf8b0761d9cd510cfe82c29951bfeaef94f323401b870a0209cb17413c59` |
| `i/phrasing-i2c.json` | `a0f2165fde6f2e06feffbc67b96835ab3ae919559978d5975cc91d907709af7f` |

Aggregates:

- N: about 681,000 list lines. That is 21 BEAM-1M sealed conversations (642,826 lines; pins match; `1m-1`, `1m-6` and `1m-26` excluded), 3 vault repositories (2 CC0, 1 Unlicense; 26,300 lines), 3 MIT template repositories (6,928 lines), and a stress stratum of 139 documents (4,810 lines, about 3,575 of them template- or label-shaped).
- K: 355 pages, 511 relation and 418 fact candidates, and 47–52 candidates per decoy or near-miss class.
- I1 and I2: seeds 167, 173 and 179 (I1) and 181, 191 and 193 (I2); every file passes `validatePhrasing`, and the files share no word 3-grams.
- W1 and W2: 149 and 150 pages, with 389 and 372 gold edges, each confirmed by both judges.
- Q: 100 amara-life-v1 pairs and 100 career pairs (400 questions, 24 of them unanswerable), and 129 career documents.
- Overlap rule as applied: a document is dropped when it shares 3 or more word 8-grams, or a masked line skeleton, with excluded material. The rule dropped 27 documents and 3 amara pairs.
- Gold support: 56 K labels removed and 2 career pairs replaced. 10 of the amara pairs come from meeting pages and the calendar.

**Deviation.** The overlap check against sealed-confirmation-v1 was not run. That material sits in owner custody outside the repository, and the custodian does not hold it. The risk is low: v1 is personal life-arc chats and general-help filler, while Q2's material is people, companies, templates and public notes. sealed-confirmation-v2 was excluded by design.

### Clarification (recorded before any cell)

- C-gate selection applies Holm to one-sided p-values at a family-wise α of 0.025 (the stricter reading of "family-wise α = 0.05" together with "each test one-sided at α = 0.025").

### Custodian deviations during the C-gates (recorded 2026-10-07)

1. The C-gate baseline arms ran on the units-off comparator `2d95d01b0`, as this record's Builds section states. Runbook
   step 3 said `$BASE` (master); the record governs.
2. W1 and W2 runs read `--dir $K/w{1,2}/pages`. The runner expects a manifest keyed `files`, while the frozen
   manifests are keyed `pages`. The bytes read are the hashed bytes.

### G6 size raise from the power simulation (recorded 2026-10-07, before any cell)

The development pilot covered both corpora, three models (Fable 5.1 cells excluded under amendment 4), two ingests per
arm and 624 answers. `eval/runner/q2/power-sim.ts` (200 simulations per cell) gives:

| Pairs per corpus × ingests | Power, all G6 gates at a true +3 points | Pooled gate alone | Unanswerable gate | No true effect (any gate passing) |
|---|---|---|---|---|
| 100 × 3 (preregistered) | 0.65 | 0.82 | 0.77 | 0 |
| 100 × 5 | 0.84 | 0.89 | 0.93 | 0 |
| 150 × 3 | 0.875 | 0.91 | 0.95 | 0 |
| 200 × 3 | 0.935 | 0.94 | 0.99 | 0 |

At a true +5 points, the preregistered size has power 0.99. Ingest-to-ingest variance in the pilot is near zero, so
question pairs, not ingests, limit power. **The G6 matrix is raised to 150 question pairs per corpus × 3 ingests**
(the owner's coordinator approved it 2026-10-07). The custodian mints 50 more fresh pairs per corpus under the same
freshness, overlap and gold-support rules. If amara's distinct items cannot supply 50 more, the custodian reports the
mix, the power simulation is rerun on it, and the result is recorded here before the new question file is hashed.
No bar changes. Estimated cost: G6 about $650–930, Q2 program total about $1,200–1,480 (spent so far: development
pilot $466, minting $23.09), inside the approved $2,100.

### G6 question set, final mix (recorded 2026-10-07, before G6 ingest)

The 150-pairs-per-corpus raise could not be met for amara, so the final mix is **amara 105 + career 200 pairs**
(305 pairs, 610 questions, 40 of them unanswerable).

- **Amara.** Pairs 1–90 are byte-identical to the frozen set, in the same order. The 10 pairs drawn from meeting pages
  and calendar invites were dropped as likely development-exposed: the development question generator draws exactly
  that item type. 15 new pairs were added. Amara cannot reach 150 pairs under the rule that a temporal answer must be
  stated in a page body. The 106th candidate failed the overlap rule (an 8-gram run from amara-life-v1), and both of its
  rephrasings failed gold support.
- **Career.** The frozen 100 pairs plus 100 new pairs, with 36 new people and 143 new documents (272 documents in all).
- **Power** (`eval/runner/q2/power-sim.ts`, development pilot, three models, 3 ingests, 200 simulations, per-corpus
  pairs `amara=105,career=200`): all G6 gates pass with probability 1.00 at a true +3 points and 0.855 at +2; no gate
  set passes with no true effect (0). The development amara questions sit at ceiling (every model 1.000 in arm A), so
  career pairs carry almost all of the power; the G6 report calls out any ceiling.

| File | SHA-256 |
|---|---|
| `q/q-questions.json` (id `q2-q-v2`) | `805b16ecca2df13943b2c195db27c2a079567870fc77c700f508feb084ebe84c` |
| `q/career-corpus/career-manifest.json` (v2, 272 documents) | `d5c3720d14b05d904b5c60c1854afcfd7e2ebde836d10262ecdfbc6e24338b4c` |
| `custody-hashes.txt` (5,214 entries; replaces `1f593208…`; only these two files and the 143 new career documents changed) | `6268035ca9546aa791f5909a339ba13d20adf30368ae799a42c4ffe377e4cc0b` |

### Career manifest format fix and G2 seed (recorded 2026-10-07, before any career G6 cell and before G2)

- `q/career-corpus/career-manifest.json` is now `cb6a5e62615ac20c2137aeb48e03bffd8bded821925016fde465280a301cd29d`
  (replaces `d5c3720d…`). The key `documents` is renamed to `files`, the key the runner reads, and
  `"today": "2026-09-30"` is added, because current-employer gold depends on the ledger's "today". Without it the runner
  would tell the agent "Today is 2026-04-19". All 272 path and hash entries are identical, and no document bytes change.
- `g2/g2-seed.json` (G2's sample seed, drawn privately by the custodian; value in custody) =
  `d8aac1f2eec67ec90b3761016705cd956eb894e5e8d6ce889e51c895e531d037`.
- `custody-hashes.txt` (5,215 entries) = `1f1882c5c0a85ef9021be303817a75914fe2942d68632c9109e5390336607ca1`, replacing
  `6268035c…`.
- Amara keeps the runner's fixed `TODAY = 2026-04-19`. That fits the corpus (January to mid-April 2026), and no amara
  question depends on "now".
- Progress note: the amara G6 ingest is complete for both arms × 3 models × 3 ingests ($144).

### N manifest format fix and G2 receipt wrapper (recorded 2026-10-08, before G1–G4 continue)

- **N manifest format fix.** `n/n-manifest.json` is now `63d98b5e5ebd615363ee6ea2b61804a199e34ba0c9d797ba277b72b21b061a18`.
  The beam stratum's `conversations` key is renamed `conversation_ids`. The three vault repositories are merged into
  one `vault` stratum and the three template repositories into one `templates` stratum, keeping their license and
  source strings. The runner expects one stratum per id. All 4,616 path and hash entries are identical, and no
  document bytes change.
- `custody-hashes.txt` (5,215 entries) = `6c9912a1590009ec646cec8e9635618689f0128c551e1222cf611ec1845381db`, replacing
  `1f1882c5…`. Only the N manifest entry changed.
- **G2 receipt wrapper (harness defect).** `junk-audit.ts g2-sample` writes a ledger receipt with no `run_status`, so
  `grammar-label` refused to start. The custodian recorded a wrapper receipt with `run_status: completed` through
  `campaign.ts record`. Nothing was re-run. Sample summary
  `4cd4ac13c57a486bd10cbd7fb4b2f9b0677008a16c2ceae1522e959d45a39d67`; wrapper receipt
  `4100b6f963ca3f4e9ea4096e5777d2ec7e208b432cc3081970dd4cabd567a6da` (300 relation and 300 fact lines). The runner
  is fixed after the decision, not before.
- Progress: G5 passed (world-v1 any-type Δ0, invariance 240/240, variant recall 1.00, 0 decoys added). G6 ingest is
  complete for all four arms ($293.70). The K mint and the G2 sample are done.

### Two N template files dropped, N re-minted (recorded 2026-10-08, before any G1 label or score)

- gbrain's `put_page` refuses two template files for invalid YAML frontmatter (unquoted template-plugin
  placeholders), and any page error blocks every G1 gate. Both files are dropped from N's `templates` stratum, which
  goes from 1,408 to 1,406 files. N keeps about 664,930 list lines, above the 500,000 floor. The two files stay hashed
  in custody but are no longer part of N.
- `n/n-manifest.json` = `bdbd1e115a2d4de19c1dcbaec13de3748824a9f1c9c2082e23e90800559a4e6e`. `custody-hashes.txt`
  (5,215 entries) = `f30b31273dd4e597fb995211ae685fcdd8729881156c8eab120ef42e98da7cd9`, replacing `6c9912a1…`. Only the
  manifest entry changed.
- N is re-minted for both arms. The superseded baseline mint was moved to `work/superseded-N-v2/`; no labels or scores
  were produced from it, and only its 711-mint aggregate count was seen. N is not under the one-opening rule (I2, W2
  and the G6 question set are). The K mints and the G2 sample are unchanged.
- The custodian fetched and hash-verified the 21 BEAM-1M sealed conversations and their `probing_questions.json` onto
  the run machine, because the runner's loader requires them and does not download them. Nothing reads the questions.

### Builds, runners and models

- **Candidate (frozen Q2 build):** gbrain `4ec7fbbe4221bd353b88cf46292b44153c542bb2` on branch `capy/q2-parser-gaps`
  (master `5b5891069413b28b2fe3a50675116d67d5a1e145`, v0.60.102.0, merged in). Every typing unit is off in it (`ENABLED_TYPING_UNITS` empty).
- **Baseline for G1–G5 and the guardrails:** gbrain master `5b5891069413b28b2fe3a50675116d67d5a1e145` (the master merged into the candidate; an earlier version of this line abbreviated it wrongly as `5b5891066`).
- **C-gate comparator:** the units-off arm `2d95d01b0cf18045b03431b15e3389072d150a74`, the candidate with no typing
  unit. It types every development page exactly as master does: the world-v1 identity test, and digests computed on
  this build. Each unit arm is that build plus one unit, so a unit comparison measures only the unit. This clarifies
  "baseline plus that unit" and is recorded before any cell.
- **Unit arms** (built by `scripts/q2-typing-package.ts --base 4ec7fbbe4 --arm <unit>`, pushed as
  `capy/q2-freeze/arm-<unit>`): U1 `b1de456e3ed9283e71a3e437480eb2fc0b4b2d08`, U25
  `73e3061387355865f58938041abc8c8b6aa7cf20`, U34 `da7c6ca66c610820f61c49cac2f761baf5fad767`, U6
  `695a0af5dc8e74584e06892810e9227217eaf9a6`. Package arms are built after selection with `--units` in the
  selected order, from the same base.
- **Harness:** gbrain-evals `1dca732ae0376baedd528e78ad263bebad24c849` (this branch), the commit holding this record and the runbook.
- **Models:** G6 answerers `claude-sonnet-5-5`, `gpt-6.1-sol` and `claude-opus-5-5` (amendment 4); judges
  `claude-opus-5-5` and `gpt-6.1-sol` (G1–G4 labels, `q2-judge-v1`); G6 judge `gpt-6.1-sol` (`q2-wta-judge-v1`) with
  a 10% `claude-opus-5-5` audit.
- **Arm-B guidance:** `eval/data/p5-write-then-answer/guidance-b.md` at the harness commit; its SHA-256 is printed by
  preflight and recorded in each G6 receipt.
- **G6 question material:** see "G6 question set, final mix" below.

## Changelog

- 2026-10-07: amendment 4 (G6 models: Sonnet 5.5, GPT-6.1 Sol and Opus 5.5; Fable 5.1 smoke-test only), before the freeze.
- 2026-10-06: amendment 3 (dependency units U34 and U25 from the development trace), before the freeze.
- 2026-10-06: amendments 1 and 2 (beam stratum excludes three conversations GBRA-52 opened; concurrent QA-only opening), before the freeze.
- 2026-10-06: first version, before any material was minted.
