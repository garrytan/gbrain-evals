# skillopt-method-v1

skillopt-method-v1 holds the task sets for the SkillOpt method benchmark (category `skillopt-method`, N15; issue
GST-799). They measure gbrain's three shipped skills `query`, `briefing` and `fact-check` on a brain of 355 pages:
messy-company-v1's 115 public dev pages and world-v1's 240 pages. Each skill has 84 tasks: 24 train, 24 selection and
36 test. [Probe 1](../../../docs/benchmarks/2026-11-01-skillopt-method/probe/probe1/summary.json) ran on these tasks
and found them saturated, so [skillopt-method-v2](../skillopt-method-v2/README.md) hardens them once and is the
dataset the runner and probe read; this version stays frozen, regenerable and checked. The test split is sealed: only
`readSealedTestTasks` in
[`eval/runner/skillopt-method/dataset.ts`](../../runner/skillopt-method/dataset.ts) reads it, at a stage's final
scoring. The data is frozen: [`MANIFEST.json`](MANIFEST.json) lists the sha256 of every data file, and
`bun eval/runner/validate-data.ts` fails if any of them changes.

## Tasks

| Skill | Family | Train / sel / test | What the task asks |
|---|---|---|---|
| `query` | gov-value | 10 / 10 / 15 | An account's value for one attribute as of a date (seats, list price, discount, renewal date, support tier, notice, payment terms) |
| | founder | 5 / 5 / 8 | Who founded a world-v1 company |
| | affiliation | 5 / 5 / 7 | Which company a world-v1 person works with |
| | negative | 4 / 4 / 6 | The same questions about a name no page carries; the answer says the brain has nothing on it |
| `briefing` | meeting-account | 10 / 10 / 15 | A day's calendar with one customer meeting on a governing record's date; the briefing states the account's current value for one attribute |
| | meeting-person | 10 / 10 / 15 | A day's calendar with one meeting with a world-v1 person; the briefing says which company they are with |
| | negative | 4 / 4 / 6 | A meeting with a person no page names; the briefing says there is no brain page |
| `fact-check` | gov-supported | 5 / 5 / 7 | A correct account claim as of a date |
| | gov-contradicted | 5 / 5 / 7 | The same claim with a nearby wrong value; the report states the right one |
| | founder-supported | 4 / 4 / 6 | "P founded C" where P is C's founder |
| | not-founder | 6 / 6 / 10 | "P founded C" where P is only an investor, employee or advisor of C (affiliation, not authorship) |
| | negative | 4 / 4 / 6 | A claim naming an invented or look-alike person, or an invented company |

Every task has one anchor (a gold page, entity or claim). Tasks that share an anchor, a gold fact or a gold page fall
into one connected group, a group sits in one split, and at most three tasks come from one group. Briefing tasks list
the day's meetings in the task text.

## Gold and controls

Gold comes from committed structure, never from gbrain output. messy-company-v1's governing-records dev labels give
an account's value as of a date, its governing page and the deciding passage; world-v1's `_facts` give founders,
role lists and primary affiliations. An independent oracle confirms each gold value along a second path before a task
is kept:

- governing records: the paragraph that holds the labelled deciding passage is on the governing page, and the gold
  value reads out of it through the scorer's own pattern;
- founders: the company lists one founder, the founder's own facts say founder of that company, and the company's page
  prose names them;
- affiliations: the company's facts or page prose name the person, and the person's page prose names the company;
- not-founder claims: neither page's facts say founder, and no sentence linking the two pages has a "found" word;
- negative controls: the name, and its surname or stem, occurs in no page of either corpus, held-out and private pages
  included.

A solvability control (an answer built from the gold page's wording, or the right abstention) must pass the scorer, or
the task is dropped. Every kept task passes. `<skill>/generation-report.json` counts the candidates per family and
lists every dropped one with its reason.

| Skill | Candidates | Dropped by the oracle | Dropped by the solvability control |
|---|---|---|---|
| `query` | 341 | 79 | 0 |
| `briefing` | 259 | 39 | 0 |
| `fact-check` | 473 | 53 | 0 |

## Scoring

The counted score is binary
([`eval/runner/skillopt-method/score.ts`](../../runner/skillopt-method/score.ts)): every gold value matches a tolerant
pattern (separators, units and "k" for numbers, any common date format with the year, any case for names), a gold page
is cited in the skill's own form (`briefing`: `[Source: slug, updated DATE]`; `query` and `fact-check`: the slug),
`fact-check` gives a `STATUS:` line its scale allows and none the evidence rules out, and a negative control
abstains while naming what was asked about. Each task's `judge` is a gbrain rule judge holding the same regexes, so
gbrain's own optimizer can read the files. Citation nDCG over the cited slugs is a diagnostic and never counted.

`<skill>/criteria.md` is the one criteria text each skill's arms get. It is the same for every task and every arm and
names no gold value or page.

## Files

| Path | What it holds |
|---|---|
| `<skill>/train.jsonl`, `sel.jsonl`, `test.jsonl` | One task per line: `task_id`, `task`, `judge`, `family`, `anchor`, `fact_keys`, `gold`, `distractors`, `source`, `oracle` and `oracle_answer` |
| `<skill>/criteria.md` | The criteria text |
| `<skill>/generation-report.json` | Candidates, drops and their reasons, group counts, quota fill |
| `seeds/<skill>/SKILL.md` | The seed skill, verbatim from gbrain `3ec766c40` (v0.60.531.0), pinned by sha256 in `dataset.ts` |

## Regenerating

```sh
bun eval/generators/skillopt-method/gen.ts check v1   # regeneration reproduces every file, and the manifest matches
bun eval/generators/skillopt-method/gen.ts write v1   # rewrite the task files and MANIFEST.json (a new dataset version)
```

The generators (`eval/generators/skillopt-method/{query,briefing,fact-check}.ts`) are seeded (15001, 15002 and 15003)
and call no model. `write` copies a seed skill only when it is missing, and only if its sha256 matches the pin.

## Known limits

- messy-company-v1 has 18 governing pages, so the governing-record families draw at most three tasks from each of a
  few contracts per split, and their results are correlated within a contract.
- The rollout brain holds no embeddings, so retrieval is keyword only.
- Each seed declares a tool the rollout does not serve: `recall` and `get_timeline` for `query`, `get_timeline` for
  `briefing`, `web_search` and `web_fetch` for `fact-check` (its web lane, which no task uses).
- Citation dates in `briefing` are not checked against the page: a page's `updated` date in the rollout brain is its
  import time.

## Changelog

### 2026-11-01: v2 becomes the default

Probe 1 found these tasks saturated: the seed and one rewrite reached the ceiling. skillopt-method-v2 hardens them,
and the runner and probe now read it. No file of this version changed; `gen.ts check v1` and `write v1` now name the
version.

### 2026-11-01: Dataset created and frozen

First version: 252 tasks over three skills, gold from messy-company-v1 governing-records dev labels and world-v1 facts,
generated at gbrain `3ec766c40`.
