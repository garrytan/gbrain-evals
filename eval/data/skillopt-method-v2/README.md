# skillopt-method-v2

skillopt-method-v2 holds the task sets the SkillOpt method benchmark (category `skillopt-method`, N15; issue GST-799)
uses by default. Its tasks need the skill's procedure, not only its output format:

- finding the record that governs a value on a date when a later record superseded an earlier one;
- answering two values at once, each from its own source;
- following a second hop to the page that holds the answer;
- covering every meeting on a calendar, including one the brain knows nothing about.

It is the one hardening round the preregistration allows. [Probe 1](../../../docs/benchmarks/2026-11-01-skillopt-method/probe/probe1/summary.json)
ran on [skillopt-method-v1](../skillopt-method-v1/README.md) and found it saturated:

- **query:** the shipped seed scored 1.00 on the selection split with Haiku 5.5;
- **briefing:** the seed scored 0.96;
- **fact-check:** the seed scored 0.58;
- **all three skills:** one one-shot rewrite reached the 1.00 ceiling.

The runner and the A1 probe read v2 ([`dataset.ts`](../../runner/skillopt-method/dataset.ts), `DEFAULT_DATASET`).
v1 stays frozen, regenerable and checked.

The brain is the same as v1's, 355 pages: messy-company-v1's 115 public dev pages and world-v1's 240 pages. Each
skill has 84 tasks: 24 train, 24 selection and 36 test. The test split is sealed: only `readSealedTestTasks` reads it,
at a stage's final scoring. [`MANIFEST.json`](MANIFEST.json) lists the sha256 of every data file, and
`bun eval/runner/validate-data.ts` fails if any of them changes.

## Tasks

| Skill | Family | Train / sel / test | What the task asks |
|---|---|---|---|
| `query` | gov-superseded | 8 / 8 / 12 | An account's value for one attribute as of a date. The record in force on that date superseded an earlier record that held another value, and on some dates a newer record is signed but not yet in force. Only the governing page counts as a citation; the superseded value and page are kept as distractors |
| | gov-pair | 5 / 5 / 7 | Two attributes of one account as of one date: both values, each cited by its governing record (one citation check per record) |
| | multi-hop | 7 / 7 / 11 | Who founded the company a person works with, is employed by or advises, or the company a dated meeting was about. The founder's own page must be cited |
| | negative | 4 / 4 / 6 | The same question forms about a person or company no page carries; the answer says the brain has nothing on it |
| `briefing` | multi-meeting | 13 / 13 / 20 | A calendar with two external meetings: a customer account and a person, or two people at different companies. The briefing states each meeting's fact (the account's value in force that day, the person's company) and cites each in briefing form |
| | multi-meeting-absent | 7 / 7 / 10 | The same two meetings plus a third with a person no page carries. That meeting needs "no brain page", naming the person, while the other two are answered |
| | negative | 4 / 4 / 6 | One external meeting, with a person no page carries |
| `fact-check` | superseded | 6 / 6 / 9 | A claim that states, as of a date, the value of a record the governing one superseded. The report says contradicted, states the governing value and cites the governing page |
| | compound-supported | 3 / 3 / 4 | Two attribute values for one account as of one date, both right. The report cites each governing page |
| | compound-contradicted | 3 / 3 / 5 | The same with one part wrong (a superseded value where the account has one, else a nearby value no record holds). The report states both governing values and cites each governing page |
| | founder-supported | 3 / 3 / 5 | "P founded C" where P is C's founder |
| | not-founder | 5 / 5 / 7 | "P founded C" where P is only an investor, employee or advisor of C (affiliation, not authorship) |
| | negative | 4 / 4 / 6 | A claim naming an invented or look-alike person, or an invented company |

Every task has its own anchor: a governing-records row, a pair of rows, a person, a meeting page, a calendar or a
claim. Tasks that share an anchor, a gold fact or a gold page form one group, and a group sits in one split with at
most three tasks.

## Gold and controls

Gold comes from committed structure, never from gbrain output. An independent oracle confirms each gold value along a
second path before a task is kept:

- **Governing records**, as in v1: the paragraph holding the labelled deciding passage is on the governing page, and the
  gold value reads out of it through the scorer's own pattern.
- **Superseded records**: the superseded value also reads out of the superseded record's own deciding paragraph, so
  the brain really holds the stale value. The labels' effective dates put that record in force first and the governing
  one in force on the task's date.
- **Pairs**: both rows are confirmed, and neither value reads as the other.
- **Second hops**: the company's founder is confirmed as in v1, and the founder's own page has a sentence naming the
  company with a founding word, so the page the answer must cite holds the answer.
- **First hops**:
  - a primary affiliation is confirmed as in v1;
  - an employee or advisor tie needs exactly one company to list the person in that role, and a sentence on either page
    naming the other;
  - a meeting's topic company must be named in the meeting page's prose, and the question identifies the meeting by
    type, date and one attendee who is not the founder.
- **Negative controls and absent meeting subjects**: the name, and an invented name's surname, occurs in no page of
  either corpus, held-out and private pages included.

A solvability control (an answer built from the gold pages' wording, or the right abstention) must pass the scorer, or
the task is dropped. Every kept task passes. `<skill>/generation-report.json` counts the candidates per family,
lists every dropped one with its reason, records the seeded assembly attempt that filled the quotas, and notes where
the corpora bound a family.

| Skill | Candidates | Dropped by the oracle | Dropped by the solvability control |
|---|---|---|---|
| `query` | 406 | 62 | 0 |
| `briefing` | 249 | 39 | 0 |
| `fact-check` | 650 | 53 | 0 |

Pairs and compound claims are counted once per pair of rows and per variant, so the candidate counts run high. The
drops:

- **`query`:** all 62 are multi-hop first or second hops. 15 people are not named by their company's facts or
  prose, 14 meeting pages do not name their topic company, 10 people have no primary affiliation page, and 7 meetings
  have no attendee who identifies them without the founder. The other 16 are people two or three companies list as an
  advisor (6), companies whose founder page is missing (4) and ties no page's prose states (6).
- **`briefing`:** all 39 are person meetings, for the same three affiliation reasons as v1 (15, 14 and 10). No
  account meeting was dropped.
- **`fact-check`:** 40 are founder claims (20 with no single founder in `_facts`, 20 whose founder page is
  missing), and 13 are not-founder claims, as in v1.

The governing-record oracles dropped nothing.

## Scoring

Scoring is v1's, with the same check kinds ([`score.ts`](../../runner/skillopt-method/score.ts)), plus two
additions that only v2's gold uses:

- `gold.cite` lists citation groups, and each group gets its own citation check, passed by citing any page in it.
  A two-record pair, a compound claim across two records and a two-meeting calendar each need one citation per
  source.
- A `briefing` task whose gold has both pages and a `subject` checks the answered meetings and an abstention that
  names the subject within 300 characters.

Without `cite` or a `subject` beside gold pages, a v1 task compiles to the same judge as before; a test
regenerates v1 byte for byte.

`<skill>/criteria.md` is the one criteria text each skill's arms get. v2's texts
(`CRITERIA_V2` in [`score.ts`](../../runner/skillopt-method/score.ts)) add what v2 asks:

- the record in force on the date, not a superseded one or one not yet in force;
- a citation for each value;
- for a person reached through other pages, that person's page;
- every meeting covered.

They name no gold value or page.

## Files

| Path | What it holds |
|---|---|
| `<skill>/train.jsonl`, `sel.jsonl`, `test.jsonl` | One task per line: `task_id`, `task`, `judge`, `family`, `anchor`, `fact_keys`, `gold` (with `cite` and `subject` where they apply), `distractors`, `source`, `oracle` and `oracle_answer` |
| `<skill>/criteria.md` | The criteria text |
| `<skill>/generation-report.json` | Candidates, drops and their reasons, group counts, quota fill, the assembly attempt and notes |
| `seeds/<skill>/SKILL.md` | The seed skill, verbatim from gbrain `3ec766c40` (v0.60.531.0), the same bytes as v1's, pinned by sha256 in `dataset.ts` |

## Regenerating

```sh
bun eval/generators/skillopt-method/gen.ts check      # both versions: regeneration reproduces every file, and each manifest matches
bun eval/generators/skillopt-method/gen.ts write v2   # rewrite v2's task files and MANIFEST.json (a new dataset version)
```

The v2 generators (`eval/generators/skillopt-method/{query,briefing,fact-check}-v2.ts`) are seeded (15011, 15012 and
15013) and call no model. Their candidates overlap on pages, so `assembleGrouped` in `common.ts` places them one
at a time. A task joins a group only while the group stays in one split with at most three tasks. Families are placed
scarcest first, and within a family the candidates with the most traps go first. Each seeded attempt either fills
every quota exactly or the next seed is tried.

## Known limits

- No model has run on v2. Whether the seed lands in the gate's band, and whether a rewrite that only fixes the output
  format stays below the ceiling, is what the second probe measures.
- messy-company-v1 has 18 governing pages, 11 of them later records (amendments, renewals, an affiliate override). The
  53 rows that superseded another value sit on those 11. `gov-superseded` (a third of the query set) uses 10 of them at
  up to three tasks each. That leaves no room for a `query` pair across two records, so every `gov-pair` is
  governed by one record, and all 17 carry a trap on at least one row. Seven of fact-check's compound claims cross two
  records.
- Person meetings and multi-hop questions draw on the 41 world-v1 people whose affiliation the oracle confirms. A
  world-only calendar repeats its two people on up to three days.
- Tasks from one contract or one founder are correlated, as in v1.
- The rollout brain holds no embeddings, so retrieval is keyword only. `query` declares `recall` and
  `get_timeline`, and `briefing` declares `get_timeline`; the rollout serves neither. `fact-check`'s web tools are
  outside the brain, and no task needs them.
- The longest gold page is `contracts/2025-03-28-qfl-msa`, 12,395 cl100k tokens (58 KB). It is gold in `query` and
  `fact-check` selection tasks and in `briefing` training tasks. The next longest, `contracts/2026-02-24-orm-renewal-2026`,
  is 2,244.
- Citation dates in `briefing` are not checked against the page.

## Changelog

### 2026-11-01: Dataset created and frozen

First version: the one hardening round after probe 1 found v1 saturated. It has 252 tasks over three skills, the same
corpora and seed skills as v1, and generator seeds 15011 to 15013, and was generated at gbrain `3ec766c40`.
