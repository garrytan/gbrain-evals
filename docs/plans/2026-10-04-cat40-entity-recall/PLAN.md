<!-- /autoplan restore point: "/home/user/.gstack/projects/garrytan-gbrain-evals/plan-cat40-entity-recall-autoplan-restore-20261004-150754.md" -->
## Implementation plan
# Cat 40 next wave: gbrain finds everything about an account, and a clean gbrain-vs-files measurement

Status: draft for autoplan, 2026-10-04.
Context: the Cat 40 report and its 2026-10-04 correction (`docs/benchmarks/2026-10-02-model-ladder.md`), and the
cost wave (gbrain v0.60.44.0, gbrain-evals v0.10.16).

## Why

Two items are open.

1. **The headline is unconfirmed.** "gbrain beats grep" came from runs in which the old ledger stalled the harness,
   gbrain's embedding requests failed, and gbrain quietly ran keyword-only search. Since the fix, only gbrain arms have
   been measured. Nobody has compared gbrain with plain files, the memory tool or plain Postgres on the fixed harness.

2. **gbrain is weakest at account briefs (family E).** With vector search working, every gbrain build gets 4–5 of 30
   development-world renewal briefs right. The field-level misses on master `109b99217` (30 cells):

   | Field | Wrong |
   |---|---|
   | open support ticket | 23 |
   | main renewal blocker | 15 |
   | date of last email or meeting | 14 |
   | account owner | 5 |
   | renewal date | 5 |

   Missed evidence by folder: tickets 23, meetings 16, mail 5, contracts 5.

   **Mechanism, verified on a development brain at `abc3182e2`.** An account has about 9 tickets, dozens of emails and
   a handful of meetings. Its tickets say `Customer: Quormiro Capital` or `Customer: QUCO`, and its meetings are
   titled `Meeting: QUCO renewal prep`. The CRM record (`crm/quormiro-capital`, title `CRM record: Quormiro Capital`)
   declares `Account code: QUCO`. None of those mentions become links:
   - `entity` on "Quormiro Capital" returns `backlink_count: 0` and no edges.
   - `get_backlinks crm/quormiro-capital` returns `[]`.
   - A search for "Quormiro Capital open support ticket" returns short emails and one closed ticket, so the open one
     is never seen. Similarity search cannot tell 9 near-identical tickets apart by status. An agent needs the full
     list.

   **Why mention linking misses it.** gbrain's mention linker (`src/core/by-mention.ts`) only links to page types
   `person`, `company`, `organization` and `entity`; schema-pack-aware types are its TODO-1. It matches the whole page
   title, so `CRM record: Quormiro Capital` never matches "Quormiro Capital". It doesn't know declared aliases such as
   `Account code: QUCO`. `mentions` links are also left out of the backlink count.

   This is a general gap, not a quirk of the test world. Any brain where customers, deals or projects live in typed
   records (CRM rows, account pages), and other documents name them by name or code, has it.

## Goals

- **G1 (gbrain, one PR).** An agent can enumerate everything a brain says about a named entity: every page that
  mentions it by name or declared alias, with type, date and a first line. That includes the 9 tickets and their
  status, and the latest email or meeting. Family E success on the development world rises from 5/30 to at least
  15/30 (three models, gbrain arm). No family regresses beyond the harm screen, and there are no new leaks.
- **G2 (measurement).** A clean, contemporaneous comparison on the held-out world (seed 20261003, 6 models × 2
  repeats, fixed harness). Arms: oracle, fs, fs-acl, memory, pg, gbrain at v0.60.44.0 (already measured on the fixed
  harness, reused) and gbrain with this wave. The Cat 40 headline is replaced by whatever it says, with per-model and
  pooled paired CIs against the best simple arm.

Non-goals: changing Cat 40 tasks, scoring or arms; a new world generator. The held-out world uses the same templates,
so it tests tuning to 50 tasks, not to the generator's wording. The report says so.

## Item B: entity recall (gbrain)

- **B1. Pack-aware entity types for mention linking.** The gazetteer takes its entity types from the schema pack's
  page types that represent things: person, company, organization, entity, plus pack types marked as entities, such
  as `crm`/account/customer/deal/project in the base pack. This closes `by-mention.ts` TODO-1. Ambiguity guards stay:
  the generic-token reject list, maximal munch, the self-link guard, one link per page pair, and the cross-source
  guard.
- **B2. Name and alias extraction for the gazetteer.**
  - Each entity page contributes its title's subject: the text after the last `: ` when the title has a record
    prefix such as `CRM record: X`, plus the full title.
  - It also contributes aliases the page declares in the forms `aliasDeclarations` already reads (`account code`,
    `also known as`, `aka`, `short name`, `ticker`, `code name`), plus frontmatter `aliases`.
  - Aliases shorter than 3 characters, aliases that are generic tokens, and aliases claimed by two entities are
    dropped. Ambiguous first-word mentions (25 customer pairs in the world share a first word) are never matched
    alone.
- **B3. Entity recall surfaces.**
  - `entity` cards count `mentions` backlinks and list `mentioned_in`: pages grouped by type, newest first, each with
    slug, title, date and a first content line of up to 160 characters (the line that carries `Status: Open`). The
    list is capped per type, with a count and a `get_backlinks` follow-up hint.
  - `get_backlinks` returns type, date and title per row and takes `type` and `limit`.
  - The cost wave's schema budgets still hold.
- **B4. Extraction runs on existing brains.** The link-extractor version bump makes the next `gbrain extract --stale`
  or autopilot cycle add the new mention links. No migration. The CHANGELOG states how long that takes.
- **B5. Server instructions.** For a brief about an account, person or project, call `entity` first and walk
  `mentioned_in` or `get_backlinks` by type; search is for content, not enumeration. This stays within the
  instructions ceiling.
- **Tests:**
  - gazetteer types and alias extraction, including collision drops
  - mention links created by `extract --stale`
  - the entity card's `mentioned_in` shape and caps
  - `get_backlinks` filters
  - an ambiguity guard where two entities share a first word
  - schema-budget ceilings
  - remote visibility: private pages never appear in `mentioned_in` for remote callers

## Item A: the clean measurement (gbrain-evals)

- **A1, development rounds:** gbrain arm only; GPT-5.4-mini, GPT-5.4 and Sonnet 4.6; one repeat. Compared with
  `followups/dev2` (v0.60.44.0 at `ea851b39b`, same harness). Round 1 is B1–B3; round 2 adds B5. Harm screen as in the
  cost wave: drop a change whose paired difference is −5 points or worse, and stop for Garry if a rerun fails.
- **A2, held-out run** of every simple arm (oracle, fs, fs-acl, memory, pg) on the fixed harness. The argv matches
  the `followups/holdout` gbrain run: 6 models × 2 repeats, `--concurrency 10`.
- **A3, held-out run** of gbrain with this wave. Its comparisons:
  - against `followups/holdout`, v0.60.44.0 on the same harness: the ship rule (−5 margin, −3 beside it, no new
    leaks)
  - against the best simple arm per model and pooled: the new Cat 40 headline
- **A4, report and correction close-out.** Rewrite "The finding" with the fixed-harness numbers. Keep the earlier
  sections as history under the correction note.
- **Budget.** $57.34 is left of the $237 follow-up ledger (program total $1,943 of $2,000). Estimates at measured
  rates:

  | Run | Estimate |
  |---|---|
  | dev rounds | ~$30 |
  | held-out simple arms (memory about $78 of it) | ~$115 |
  | held-out gbrain | ~$55 |
  | slot builds | ~$2 |
  | **Total** | **~$200** |

  This needs Garry to raise the program authorization by $250 to $2,250, recorded with `set-cap` on the follow-up
  ledger. Nothing else spends against it.

## Order

1. B1–B3 in gbrain on `cat40-entity-wave`, with tests and `verify`.
2. A1 round 1, then B5, then A1 round 2.
3. A2 and A3.
4. One gbrain PR with the CHANGELOG numbers. The results and report rewrite go in a gbrain-evals PR.

## Risks

- **Over-linking.** Common words as aliases, or names that are prefixes of other names. Mitigated by the existing
  guards plus the alias length, generic-token and collision rules; tests cover them. Doctor's `junk_entity_hubs`
  check still applies.
- **Larger entity cards cost tokens.** Per-type caps and the 160-character first line bound them. The card is only
  sent when an agent calls `entity`.
- **Tuning to this world.** The fix is general (typed records, declared aliases), but the evidence comes from one
  generator. The report states it.
- **The headline may go against gbrain.** We publish it either way.
## Review record
