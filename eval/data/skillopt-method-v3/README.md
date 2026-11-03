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
`3ec766c40`): none of the three changed between the two commits. This commit's `package.json` pins gbrain `62637c96a`
(v0.60.557.0), where the three seed skills are still byte-identical.

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
| `fact-check` | superseded | 6 / 6 / 5 / 12 | A term as of a date stated with a value another record holds (contradicted, with the value in force), or with the value in force while a later record holds another (supported) |
| | compound | 6 / 6 / 5 / 12 | Two or three terms of one account on one date, each part right or wrong |
| | not-founder | 6 / 6 / 4 / 12 | Per company, "P founded C" where P only works or worked at C (contradicted), and the real founder's claim (supported) |
| | absent | 6 / 6 / 4 / 12 | A claim about an entity no page carries; near-miss pages recorded |
| | role-on-date (held out) | 0 / 0 / 6 / 16 | "On D, P was C's chief executive" (or chief technology officer), right or wrong |
| | three-hop (held out) | 0 / 0 / 6 / 16 | A founding claim three hops out, right or naming the wrong hop's founder |
| | lookalike-founder (held out) | 0 / 0 / 6 / 16 | A founding claim about a company sharing a stem with another, or naming a near-name person |

Every fact-check family except absent makes claims right or wrong. Each fills each split by gold status in the
proportion of its confirmed candidates, and compound's false claims with a true part fill apart from those false
throughout, so true claims sit in every split and a report that calls everything false fails every task with a true
part. Fact-check tasks by gold status (supported / contradicted / not-supported) are 8 / 10 / 6 in train, 8 / 10 / 6 in
selection, 12 / 20 / 4 in gate and 32 / 52 / 12 in test; 11, 11, 15 and 38 of them have a true part. The oracle report
with every status set to FALSE passes substance on 13 of 24 train, 13 of 24 selection, 21 of 36 gate and 58 of 96 test
tasks, and with every status set to VERIFIED on 8, 8, 12 and 32. `gen.ts check` and the v3 test fail when train or
selection gives either report a larger share than gate (`statusSkewV3` in
[`common-v3.ts`](../../generators/skillopt-method/common-v3.ts)).

Every task has its own anchor. Tasks that share an anchor, a gold fact or a gold page form one connected group; a
group sits in one split with at most three tasks, and each task records its `group_id` for resampling. Abstention
tasks record their `near_miss` pages (the look-alikes and closest wrong entities) for the gate's reachability control.

## Gold and controls

The generators read the world model (people, companies, contract chains, mentions) for gold. An independent oracle in
[`common-v3.ts`](../../generators/skillopt-method/common-v3.ts) re-derives every gold value from the rendered page text
alone (contract dates and terms, a company's founding line and leadership list, a person's career list), and a
candidate whose two paths disagree is dropped. Each kept task then passes two keyless controls: its solvability control
(an answer in the contract's shape built from the deciding pages) passes every check, and every degenerate answer
(empty, "I don't know", every candidate value at once, a refusal where an answer exists, a fact-check report that calls
a false claim true, and one that calls every claim or part false when a part is true) fails substance.

| Skill | Candidates | Dropped by the oracle | By the solvability control | By a degenerate answer | Groups (largest) |
|---|---|---|---|---|---|
| `query` | 1,323 | 0 | 0 | 0 | 131 (3) |
| `briefing` | 309 | 6 | 0 | 0 | 75 (3) |
| `fact-check` | 1,755 | 0 | 0 | 0 | 136 (3) |

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
bold lines or prose passes substance and fails form. A query answer passes only when the first sentence naming a
candidate value states the gold value without negating or refusing it ("not 240" and "can't confirm 240" fail). In a
fact-check report with `CLAIM:` blocks, a block's status is what its `STATUS:` lines say (or, with none, the first word
after its `CLAIM:` label), and the parts it covers are the ones its `CLAIM:` line names, so status words and part words
in notes do not count. A block may not give a covered part any status outside the ones that part allows, `DISPUTED`
included.

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

- Calibration (train only) is the only paid read so far. It ran before #308's scorer and fact-check fixes, at MANIFEST.json
  `04f8f287…` and `3f416c5e…`: the seed scored 1.0 on query and briefing and 0.75 to 0.875 on fact-check, above the
  0.30 to 0.60 band it aimed for. It is read again at the final manifest before the headroom gate.
- The task files carry their judges' regexes inline, so v3 is about 11.0 MB (10,985,950 bytes over MANIFEST.json's
  files), mostly the briefing and fact-check judges.
- Pages are 178 to 318 words, short of the plan's 700-word ceiling: the generator pads each page to a seeded length
  from its bank's filler sentences.
- Briefing citation dates are not checked against the page.

## Changelog

### 2026-11-03: "I don't see the 240 seats changing" keeps its 240

The fix-check of #308 found the query negation guard reading "don't see" as a refusal, so a correct answer such as
"I don't see the 240 seats changing" failed substance. "See" now counts as a refusal only after cannot, can't,
couldn't, could not, unable to or not able to, so "I can't see 240 seats in the brain" still fails. Only the query
tasks' judge regexes changed; tasks and placement are unchanged. MANIFEST.json a6ddcbef -> 2ddc6270, data_sha256
225d18a1 -> 5107c033.

### 2026-11-03: The pin sentence names gbrain `62637c96a`

The repo's gbrain pin moved from `311a83bbe` (v0.60.553.0) to `62637c96a` (v0.60.557.0), so the pin sentence names the
new commit and says the seed skills are still byte-identical there. No data file or MANIFEST.json changed: `gen.ts check`
regenerates v3 byte for byte at the new pin.

### 2026-11-02: Trained fact-check families make true claims (GST-1150)

Among the trained fact-check families only compound made true claims, so train and selection held 4 and 6 tasks with a
true part against 13 in gate and 31 in test. The oracle report with every status set to FALSE passed substance on 20 of
24 train, 18 of 24 selection, 23 of 36 gate and 65 of 96 test tasks, so a rewrite that rejected too much lost little
where it was trained and selected. Two trained families now make true claims too:

- superseded states, for about half its claims, the value in force on the claim's date while a later record holds
  another value (supported);
- not-founder makes, per company, the real founder's claim (supported) and one claim naming a person who works or
  worked there, the chief executive when one is not the founder (contradicted). It made one per such person before.

Compound's false claims with a true part now fill apart from those false throughout, so its mix holds in every split.
Train and selection now hold 11 tasks with a true part each, against 15 in gate and 38 in test, and the every-FALSE
report passes on 13, 13, 21 and 58 of them. A new guard (`statusSkewV3`, run by `gen.ts check` and the v3 test) fails
when train or selection gives the every-FALSE or every-VERIFIED oracle report a larger share of passes than gate. The
controls table now gives each skill's counts at the frozen knobs, which it had kept from the registered ones.

Quotas, seeds, knobs, the family hold-out and the world are unchanged; query and briefing are byte-identical. Fact-check
candidates went from 1,798 to 1,755 and groups from 124 to 136. MANIFEST.json's sha256 went from `a677090b` to
`a6ddcbef` and `data_sha256` from `582347c5` to `225d18a1`; the dataset grew from 10,976,191 to 10,985,950 bytes.

### 2026-11-02: Calibration froze harder knobs

Calibration round 2 raised every knob: chain depth 4 to 5 (was 3 to 5), 20 look-alike company pairs (was 15), 24
look-alike person pairs (was 20) and 6 distractors per account (was 2). Opus scored the same at both settings, and the
harder set is frozen for the gate. The world grew from 999 to 1,030 pages and every split was regenerated, with the
fact-check and scorer fixes below; the task counts per family did not change. MANIFEST.json sha256 is now
`a677090b…` (it was `eebc02ff…` at the registered knobs after those fixes).

### 2026-11-02: Query refusals with "can't", "won't" and common refusal verbs fail

Pass-2 review of #308 found the query negation guard still let refusals of the gold value pass. It built "can't" as
"cann't" and had no "won't", so "I can't confirm 240 seats" passed substance with a straight or curly apostrophe, and
"could not find 240", "doesn't show 240", "no record of 240" and "not able to confirm 240" passed too. All of them now
fail. The status paragraph now says a report calling everything false fails each task with a true part, where it said
such a report fails the true claims; Known limits gives how few of those tasks train and selection hold and what an
all-FALSE report scores on each split.

The query judges changed with the scorer; query tasks and their placement did not, and briefing and fact-check are
byte-identical. MANIFEST.json's sha256 went from `e944b2d8` to `eebc02ff` and `data_sha256` from `eba61eb6` to
`10a0a282`; the dataset grew from 10,733,381 to 10,763,777 bytes.

### 2026-11-02: Fact-check places true claims; the fact-check and query scorers read status and negation as meant

Round-1 review of #308 found four scorer and dataset defects, fixed together with a regenerated v3:

- Fact-check assembly sorted true claims behind false ones, so no placed task was supported (train 0 / 18 / 6, selection
  0 / 18 / 6, gate 0 / 32 / 4, test 0 / 84 / 12 by supported / contradicted / not-supported) and a report calling
  everything false passed every absent task. Each family that makes claims right or wrong now fills its quotas by
  status in its candidates' proportion: 2 / 16 / 6, 2 / 16 / 6, 10 / 22 / 4 and 27 / 57 / 12. Quotas, seeds and knobs
  are unchanged; fact-check groups went from 130 to 131. A new degenerate answer (every claim or part FALSE) must fail
  substance on every task with a true part; it dropped no candidate.
- The fact-check scorer read a status word anywhere in a block and counted a part covered when its key word appeared
  anywhere in it, so a correct report failed for "was correct before the amendment", "Amendment status: confirmed",
  per-part lines under a whole-claim block or "USD 1,175/seat/year" in a price block. Status now comes from the
  `STATUS:` lines and coverage from the `CLAIM:` line; "/seat", "per-seat" and "before discount" no longer name a part.
- A second block giving `DISPUTED` for a contradicted or unsupported claim passed; it now fails.
- A query answer that negated or refused the gold value ("Not 240 seats", "I cannot confirm 240 seats") passed; it now
  fails, while "240 seats, not the 200 the MSA set" still passes.

The query judges changed with the scorer; query tasks and their placement did not, and briefing is byte-identical.
MANIFEST.json's sha256 went from `04f8f287` to `e944b2d8` and `data_sha256` from `7167655f` to `eba61eb6`; the
dataset grew from 10,056,321 to 10,733,381 bytes (the "about 9.7 MB" line now reads about 10.7 MB).

### 2026-11-02: The pin sentence names gbrain `311a83bbe`

The main merge of #306 ([`5df3b68a`](https://github.com/garrytan/gbrain-evals/commit/5df3b68a)) moved `package.json`'s
gbrain pin from `a131fb20` (v0.60.549.0) to `311a83bbe` (v0.60.553.0), so the sentence on the pin now names
`311a83bbe`, the same commit the seeds come from. No data file or MANIFEST.json changed.

### 2026-11-02: Dataset created

First version, for the SkillOpt ceiling attempt (GBEV-30): world-v3's 999 pages, 540 tasks over three skills in four
splits, a contract per skill and layered checks, generated at gbrain `a131fb20` with seeds from gbrain `311a83bbe`.
