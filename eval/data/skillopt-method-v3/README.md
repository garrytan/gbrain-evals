# skillopt-method-v3

skillopt-method-v3 holds the task sets of the SkillOpt ceiling attempt (category `skillopt-method`, N15; issue GBEV-30,
plan sections 2 and 3). Its tasks test what a skill's procedure adds on a brain built to need it:

- reading a contract term as of a date across a record chain, where later records supersede earlier ones, renewals are
  signed before they take effect, rescissions reinstate an earlier value and informal notes contradict the signed record;
- following two or three hops (a person's company, its acquirer or only investor, that firm's founder) and a role
  holder on a date;
- telling look-alike people and companies apart, and saying when a name fits two of them or none;
- briefing three to six meetings at once, each fact and citation inside its own meeting's entry;
- fact-checking claims of two or three parts, each part with its own status.

The rollout brain is world-v3's 1,030 pages ([`world-v3.ts`](../../generators/skillopt-method/world-v3.ts)), and the seed
skills are the ones gbrain ships at `311a83bbe` (v0.60.553.0). They are byte-identical to v1's and v2's seeds (gbrain
`3ec766c40`): none of the three changed between the two commits. This commit's `package.json` pins gbrain `311a83bbe`
(v0.60.553.0), the same commit the seeds come from.

Every reader names v3 explicitly: [`dataset.ts`](../../runner/skillopt-method/dataset.ts) keeps v2 as the N15 default, and
[`dataset-context.ts`](../../runner/skillopt-method/dataset-context.ts) hands brain import, the audit and the proposer's
redaction v3's own pages and names, cached per sha256 of [`MANIFEST.json`](MANIFEST.json).

## Tasks

Each skill has 180 tasks: 24 train, 24 selection, 36 gate and 96 test. Gate and test are sealed: only
`readSealedTasks` reads them. Held-out families appear only in gate and test, so no optimizer sees them. Train is
ordered round-robin by family, so each of gbrain's batches of 8 covers every trained family.

| Skill | Family | Train / sel / gate / test | What the task asks |
|---|---|---|---|
| `query` | as-of | 7 / 7 / 5 / 14 | An account's term as of a date, over its record chain. Superseded, rescinded and not-yet-in-force values are distractors |
| | two-hop | 6 / 6 / 5 / 12 | "Who founded the company that P works with?" (GST-955's template) |
| | lookalike | 6 / 6 / 4 / 12 | A look-alike person or company: resolvable from the question, or ambiguous (name every candidate) |
| | absent | 5 / 5 / 4 / 10 | An entity no page carries, built from real ones; near-miss pages recorded |
| | three-hop (held out) | 0 / 0 / 6 / 16 | The founder of the firm that acquired, or alone backed, the company P works with |
| | role-on-date (held out) | 0 / 0 / 6 / 16 | Who held a company's chief executive or technology role on a date |
| | note-contradicts (held out) | 0 / 0 / 6 / 16 | An as-of term where an informal note states another value than the signed record |
| `briefing` | meetings-3-4 | 10 / 10 / 8 / 20 | Three or four external meetings, each asking an account's term on the day or a person's company |
| | unknown-attendee | 7 / 7 / 5 / 14 | The same with one attendee no page carries ("No brain page for <name>") |
| | lookalike-attendee | 7 / 7 / 5 / 14 | The same with an attendee who has a look-alike |
| | changed-companies (held out) | 0 / 0 / 6 / 16 | An attendee who changed companies; the current one counts |
| | renewal-pending (held out) | 0 / 0 / 6 / 16 | An account with a renewal signed but not yet in force on the day |
| | meetings-5-6 (held out) | 0 / 0 / 6 / 16 | Five or six external meetings |
| `fact-check` | superseded | 6 / 6 / 5 / 12 | A term as of a date stated with a value another record holds; contradicted, with the value in force |
| | compound | 6 / 6 / 5 / 12 | Two or three terms of one account on one date, each part right or wrong |
| | not-founder | 6 / 6 / 4 / 12 | "P founded C" where P only works or worked at C |
| | absent | 6 / 6 / 4 / 12 | A claim about an entity no page carries; near-miss pages recorded |
| | role-on-date (held out) | 0 / 0 / 6 / 16 | "On D, P was C's chief executive" (or chief technology officer), right or wrong |
| | three-hop (held out) | 0 / 0 / 6 / 16 | A founding claim three hops out, right or naming the wrong hop's founder |
| | lookalike-founder (held out) | 0 / 0 / 6 / 16 | A founding claim about a company sharing a stem with another, or naming a near-name person |

Every task has its own anchor. Tasks that share an anchor, a gold fact or a gold page form one connected group; a
group sits in one split with at most three tasks, and each task records its `group_id` for resampling. Abstention
tasks record their `near_miss` pages (the look-alikes and closest wrong entities) for the gate's reachability control.

## Gold and controls

The generators read the world model (people, companies, contract chains, mentions) for gold. An independent oracle in
[`common-v3.ts`](../../generators/skillopt-method/common-v3.ts) re-derives every gold value from the rendered page text
alone (contract dates and terms, a company's founding line and leadership list, a person's career list), and a
candidate whose two paths disagree is dropped. Each kept task then passes two keyless controls: its solvability control
(an answer in the contract's shape built from the deciding pages) passes every check, and every degenerate answer
(empty, "I don't know", every candidate value at once, a refusal where an answer exists) fails substance.

| Skill | Candidates | Dropped by the oracle | By the solvability control | By a degenerate answer | Groups (largest) |
|---|---|---|---|---|---|
| `query` | 1,298 | 0 | 0 | 0 | 135 (3) |
| `briefing` | 309 | 7 | 0 | 0 | 76 (3) |
| `fact-check` | 1,594 | 0 | 0 | 0 | 130 (3) |

`<skill>/generation-report.json` holds the capacity report: per family, the confirmed candidates and the tasks placed in
each split against the quota. Generation fails when any count is short; every family and split is met.

## Contract and scorer

Every arm's prompt is the task followed by `<skill>/contract.md` ([`contract.ts`](../../runner/skillopt-method/contract.ts)),
except the bare no-skill arm. Each contract adopts the seed's own documented output (the query seed's direct answer and
`[Source: ...]` citations, the briefing seed's MEETINGS TODAY list, the fact-check seed's `[N] CLAIM:` blocks) and adds
only what binds facts.

Each task's judge is a gbrain rule judge of m-flag regexes ([`score-v3.ts`](../../runner/skillopt-method/score-v3.ts)),
each tagged `substance` (the value concluded, the deciding page, the abstention, each part's status) or `form` (the
contract's markup). A task scores a full pass (every check) and a substance pass (substance checks only); gbrain's own
rule score is the fraction of the same checks. Substance loci do not depend on layout, so correct content in a table,
bold lines or prose passes substance and fails form.

## Files

| Path | What it holds |
|---|---|
| `world/pages.jsonl` | The rollout brain: one `{ "slug", "content" }` per line, in slug order |
| `<skill>/train.jsonl`, `sel.jsonl`, `gate.jsonl`, `test.jsonl` | One task per line: `task_id`, `task`, `judge`, `family`, `held_out`, `group_id`, `anchor`, `fact_keys`, `gold` (with its `spec`), `distractors`, `near_miss` where it applies, `source`, `oracle` and `oracle_answer` |
| `<skill>/contract.md` | The output contract appended to every arm's prompt but the bare no-skill arm's |
| `<skill>/criteria.md` | The criteria text |
| `<skill>/generation-report.json` | Knobs, candidates, drops and their reasons, the capacity report, group counts and the assembly attempt |
| `seeds/<skill>/SKILL.md` | The seed skill, verbatim from gbrain `311a83bbe`, pinned by sha256 in `dataset.ts` |

## Regenerating

```sh
bun eval/generators/skillopt-method/gen.ts check      # every version: regeneration reproduces every file, and each manifest matches
bun eval/generators/skillopt-method/gen.ts write v3   # rewrite v3's files and MANIFEST.json
```

The world and the three generators are seeded (world 30001, generators 30011 to 30013) and call no model. The
calibration knobs are explicit (`V3Knobs` in `world-v3.ts`). Calibration (plan section 4) froze them at contract chain
depth 4 to 5 records, 20 look-alike company pairs, 24 look-alike person pairs and 6 distractors per account. The
preregistered first set (3 to 5, 15, 20 and 2) scored the same on Opus; its amendment in
[PREREGISTRATION.md](../../../docs/benchmarks/2026-11-02-skillopt-ceiling/PREREGISTRATION.md#amendments) has both rounds.

## Known limits

- Calibration (train only) is the only paid read so far: the seed scored 1.0 on query and briefing and 0.75 to 0.875 on
  fact-check, above the 0.30 to 0.60 band it aimed for. The headroom gate is next.
- The task files carry their judges' regexes inline, so v3 is about 10.3 MB, mostly the briefing and fact-check judges.
- Pages are 178 to 318 words, short of the plan's 700-word ceiling: the generator pads each page to a seeded length
  from its bank's filler sentences.
- Briefing citation dates are not checked against the page.

## Changelog

### 2026-11-02: Calibration froze harder knobs

Calibration round 2 raised every knob: chain depth 4 to 5 (was 3 to 5), 20 look-alike company pairs (was 15), 24
look-alike person pairs (was 20) and 6 distractors per account (was 2). The world grew from 999 to 1,030 pages and every
split was regenerated; the task counts per family did not change. MANIFEST.json sha256 is now `3f416c5e…` (was
`04f8f287…`). Opus scored the same at both settings, and the harder set is frozen for the gate.

### 2026-11-02: The pin sentence names gbrain `311a83bbe`

The main merge of #306 ([`5df3b68a`](https://github.com/garrytan/gbrain-evals/commit/5df3b68a)) moved `package.json`'s
gbrain pin from `a131fb20` (v0.60.549.0) to `311a83bbe` (v0.60.553.0), so the sentence on the pin now names
`311a83bbe`, the same commit the seeds come from. No data file or MANIFEST.json changed.

### 2026-11-02: Dataset created

First version, for the SkillOpt ceiling attempt (GBEV-30): world-v3's 999 pages, 540 tasks over three skills in four
splits, a contract per skill and layered checks, generated at gbrain `a131fb20` with seeds from gbrain `311a83bbe`.
