# Scoring messy-company-v1

Each lane has a deterministic scorer in [`eval/runner/messy-company/`](../../runner/messy-company/). A scorer reads
one JSON file with the system's answers for one split and prints counts and rates, each with a 95% Wilson interval.
Add `--json` for a machine-readable report. No scorer calls a model.

```bash
bun eval/runner/messy-company/score-<lane>.ts --split dev|heldout --system answers.json [--view full|public] [--json]
```

`--view public` exists for the lanes where access matters (owner-phrases, ownership, agent-tasks). It scores
against what can be known with `visibility: private` pages hidden; load the brain with `load.ts --public-only` for
that view. Ids for people and accounts are the ids in `plan/world.json` (`dana-okafor`, `quarrendon`, `team-central`).

Rates need their denominators. Several subsets are small (6 deep-clause rows across both splits, one corrected
announcement per split), so report the interval and the count, never a bare percentage.

## owner-phrases

Gold row: `id`, `slug`, `surface`, `lines`, `page_date`, `body_date`, `date_basis` (`frontmatter`, `body` or
`undated`), `visibility`, `owner`, `form`, `intended_accounts`, `should_link`, `should_link_public`, `reason`,
`window_relation`, `stints`, `verifier_agreed`, and `adjudication` with `adjudication_note` when one was made.

System output:

```json
{ "links": [{ "slug": "updates/2026-03-02-north-weekly", "surface": "Dana's renewal", "accounts": ["quarrendon"] }] }
```

An entry matches a gold mention by slug and surface (case and apostrophe style ignored), or by slug and `line` when
the surface is omitted. A candidate with no entry, or with empty `accounts`, counts as "no link".

| Metric | Meaning |
|---|---|
| link recall | should-link mentions linked to exactly the gold accounts |
| link precision | emitted links on candidates that are right |
| false links | should-not-link mentions that got a link (lower is better) |
| wrong-account links | should-link mentions linked to the wrong accounts (lower is better) |

Broken down by `reason` and `window_relation`. A phrase resolves on the date the page is about: the body date when
the body gives one, otherwise the frontmatter date. An undated page resolves only if one account fits across all
time.

## entity-mentions

Gold row: `slug`, `line`, `surface`, `occurrence` (1-based ordinal of that surface on that line), `entity` (an
account or other-company id, or `null`), `surface_candidates`, `ambiguous_surface`, `lookalike_surface`,
`gold_source`, `verifier_agreed`.

```json
{ "mentions": [{ "slug": "chats/2026-01-13-thornbury-rename", "line": 10, "surface": "TCC", "occurrence": 1, "entity": "orrin" }] }
```

`entity: null` means the occurrence names no single company: the code discussed as a string, or a reference to a
whole family. Metrics: accuracy over all mentions, on colliding surfaces and on look-alike names, plus the share
answered. Report the colliding and look-alike subsets; unique surfaces are easy.

## aliases

Gold row: `surface`, `entity`, `valid`, `kind` (`canonical`, `short`, `code`, `nickname`, `former_name`, `new_name`,
`ticker`, `misspelling`, or for false rows `lookalike_negative` and `typo_in_corpus`), `valid_from`, `valid_to`,
`collides_with`, `evidence_slugs`, `note`.

```json
{ "aliases": [{ "surface": "TCC", "entity": "tamsin" }] }
```

Metrics: valid-alias recall, precision over pairs the gold knows, and false aliases asserted. A surface that two
entities share is valid for both, and `collides_with` says so; an alias system must keep it ambiguous, not merge the
entities. Pairs the gold doesn't list are counted separately and never scored as wrong.

## ownership

Stint rows: `account`, `owner`, `owner_kind`, `role` (`primary`, `team`, `acting`, `overlap`), `start` (null when
never recorded, with `start_bound`), `end`, `evidence_visibility`, `evidence` (pages that state the stint),
`corrections`, `note`. Corrected-announcement rows: `kind: "corrected_announcement"`, `announced`, `corrected`,
`announced_slug`, `correction_slug`, `governing_stints`.

```json
{ "windows": [{ "account": "quarrendon", "owner": "dana-okafor", "role": "primary", "start": "2025-06-02", "end": null }] }
```

Windows are `[start, end)`. The scorer probes owner-on-date at each stint's start, the day before, the last day,
the end and the midpoint. An `acting` window answers acting-cover probes, and `overlap` windows are ignored for the
owner of record. Metrics: owner-on-date probes, acting-cover probes, and exact window recall and precision on stints
with a known start. The probes are broken down by trap (corrected announcement, unknown start, belated overlap).
In the public view, dates where the owner is known only from a private page are skipped.

## governing-records

Gold row id: `<account>:<attribute>:<as_of>`, for `seats`, `price_per_seat` (list price before discount),
`discount_pct`, `renewal_date` (last day of the current term), `sla_tier`, `notice_days` and `payment_terms_days`.
Fields: `value`, `governing_record`, `governing_slug`, `signed`, `effective`, `deciding_passage` (`slug`, `line`,
`quote`), `traps`, `distractor_slugs`.

```json
{ "answers": [{ "id": "quarrendon:seats:2026-10-14", "value": 185, "record_slug": "contracts/2025-08-19-qfl-a1", "passage": { "slug": "contracts/2025-08-19-qfl-a1", "line": 21 } }] }
```

A record governs from its effective date, not its signing date. A draft or unsigned document never governs. A
later record that doesn't set the attribute leaves the older value in force. Metrics: value correct, governing
record correct, and deciding passage hit (same slug, within 3 lines), broken down by trap and attribute.

## document-status

Gold row: `slug`, `record`, `kind`, `status` (`signed`, `unsigned`, `draft`), `frontmatter_status`,
`status_in_frontmatter`, `drafted`, `signed`, `effective`, `governs`.

```json
{ "status": [{ "slug": "contracts/2026-02-10-orm-unsigned-2026", "status": "unsigned" }] }
```

Metrics: status correct, status correct on the 11 pages with no status in the frontmatter, and signed-versus-not
correct. A confusion count is included.

## timeline

Event rows: `date`, `type` (`signing`, `handoff`, `meeting`, `escalation`, `incident`, `rebrand`, `leave`),
`accounts`, `participants`, `summary`, `evidence`. Negative rows: `negative: true`, `negative_date`, `accounts`; an
announced handoff that the correction says never happened on that date.

```json
{ "events": [{ "date": "2025-11-04", "accounts": ["quarrendon"], "type": "escalation" }] }
```

A gold event is found when an output event has the same date and shares an account. Metrics: event recall, event
precision, and events placed on a corrected announcement's date (lower is better).

## changes

Pair rows: `relation` (`contradiction`, `change`, `compatible`), `account`, `a` and `b` (claim, slug, line, value,
as_of, correct), `note`. When one side is the governing contract rather than a page claim, its line is null.
Retraction rows: `slug`, `attribute`, `retracted_value`, `final_value`, `lines`.

```json
{ "pairs": [{ "id": "cp-qfl-discount", "relation": "contradiction" }], "retractions": [{ "id": "rt-qfl-seats", "value": 185 }] }
```

A contradiction is two sources disagreeing about the same thing at the same time. A change is a value that moved
between dates. Compatible pairs agree, or describe different things. Metrics: relation correct, contradiction recall
and precision, and the retraction's final value.

## agent-tasks

Gold row: `question`, `answer_type`, `answer`, optional `answer_public_only` and `accept`, `evidence_slugs`,
`traps`, and `oracle_check` (the oracle call that reproduces the answer; the test suite runs it).

```json
{ "answers": [{ "id": "dev-own-1", "answer": "Dana Okafor", "evidence_slugs": ["emails/2025-10-03-correction-north-moves"] }] }
```

Answers are compared by type:

| Answer type | How it's compared |
|---|---|
| person, account | id or any accepted name, by normalized containment |
| number | by value |
| date | by calendar day |
| set | as a set |
| boolean | yes or no |
| `ambiguous`, `unknown` | by keyword |

In the public view, three tasks whose evidence is private expect `unknown`. A hedged answer that says the date
isn't recorded passes; repeating a months-old public owner as fact does not. Metrics: answers correct and the share
of gold evidence slugs cited, broken down by lane.

## Changelog

### 2026-10-14: First version

Scorers for all 9 lanes, with the formats above.
