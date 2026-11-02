---
name: briefing
version: 1.3.0
description: Compile daily briefing with meeting context, active deals, and citation tracking
triggers:
  - "daily briefing"
  - "morning briefing"
  - "what's happening today"
  - "brain pulse"
  - "pre-briefing pull"
tools:
  - search
  - query
  - get_page
  - list_pages
  - get_timeline
mutating: false
upstream: briefing@fc834ee
---

# Briefing Skill

Compile a daily briefing from brain context. The most important part is getting each external meeting's requested fact right and citing it in the exact required form. Everything else is secondary.

> **Filing rule:** When the briefing creates or updates brain pages,
> follow `skills/_brain-filing-rules.md`.

## Contract

- Every fact in the briefing carries an inline citation in exactly this form: `[Source: <slug>, updated <YYYY-MM-DD>]`.
- Each external meeting answers the fact the task asks for, such as who a person is and their company, or an account's seat count, discount, list price or support tier.
- An account value is the one **in force on the briefing date**. It is cited to the record that sets that value.
- A person fact is cited to **the person's own page** (`people/...`).
- A participant with no brain page is stated as such: "No brain page for <Full Name>". You then still cover every other meeting.
- The briefing is read-only. You create or modify no pages unless the user explicitly asks.

## Citation format (strict; most failures come from this)

The checker accepts only this literal shape:

```
[Source: people/jane-doe-12, updated 2026-11-02]
```

Rules:
1. **Use the word `updated`.** Never write `dated`, `signed`, `latest entry`, `last dated entry`, `last real update`, `undated`, `no reliable date` or `no document date`. Never leave the date out.
2. **The date is YYYY-MM-DD and nothing else follows it inside the brackets.** Use the page's `updated` value as the tool shows it, even if it looks like an import date or falls after the briefing date. For a contract you may instead use its document date. Either way, write it as `updated <date>`.
3. **One slug per bracket.** Never write `[Source: a; b]` or `[Source: a, b]`. To cite two pages, write two brackets back to back: `[Source: a, updated X] [Source: b, updated Y]`.
4. **No commentary inside the brackets.** Put caveats in a separate sentence outside them, for example: "Note: the updated dates reflect a bulk import."
5. **Put the citation on the same line as the answer fact.** Cite the page that actually holds the fact:
   - for a person's role and company, cite `people/<slug>`, even if you also cite the company page;
   - for an account value, cite the governing contract or amendment page.
6. Before finishing, scan every `[Source:` in your answer and fix any that break rules 1–4.

## Answering the requested facts

### People: "who they are and which company"

1. Resolve the person by exact name.
   - Run `search` with `match: keyword` on the quoted full name, or `resolve_slugs`.
   - `resolve_slugs` often returns nothing even when a page exists. Always also run a keyword search.
2. Open the matching `people/...` page with `get_page`.
3. State the role and company from that page and cite it: `[Source: people/<slug>, updated <date>]`.
4. If other pages contradict it, mention that briefly. The primary answer still comes from, and cites, the person's own page.
5. If there is no exact-name match after a full-name keyword search and a first-name/surname search, write exactly:
   - "**No brain page for <Full Name>.** The brain doesn't say who they are or which company they're with."
   - Do not describe them from loose matches or similar names.
   - Repeat the full name in this sentence. Don't just write "not found".

### Accounts: the value in force on the briefing date

1. Find every record for the account, using a `search` on the account name and `list_pages` with slug prefix `contracts/`:
   - the original agreement;
   - amendments;
   - renewal order forms;
   - unsigned drafts.

   Also watch for renamed companies, such as a former name in a contract title.
2. Read the relevant clause with `get_page` (use `grep` on "seat", "discount", "price" or "tier"). Note each record's signature date and **effective date**.
3. Pick the governing record using these rules:
   - It must be **signed** and **effective on or before the briefing date**. Ignore drafts, rejected proposals and unsigned forms.
   - A renewal or amendment signed before today but effective after today is not yet in force. The prior record still governs. Mention the upcoming change.
   - An amendment that changes only some terms governs only those terms. For other terms, the earlier record still governs.
   - Ignore anything dated after the briefing date as a source for "current" values.
   - Account summary pages, CRM notes and emails are context only. Contracts take precedence over them.
4. State the value and cite the governing contract page in the strict form, for example: "Current discount: 12% [Source: contracts/<slug>, updated <date>]."
5. If the governing record's slug is withheld or unknown to you, re-open it so you have the exact slug to cite.

## Procedure

1. **Parse the calendar.**
   - Mark meetings as internal (internal, standup, focus, lunch with no name, inbox) or external (a named person or company).
   - Note the requested fact for each external meeting.
2. **Resolve and answer each external meeting first**, using the rules above.
3. **Optional context pulls**, kept brief:
   - `get_recent_salience` and `find_anomalies`;
   - active deals (`list_pages` with type deal), filtered to records effective on or before the briefing date;
   - pending follow-ups (`query`).

   If CLI-only pulls are not available as tools (recall, waiting, supersessions, health), list them in one line as "not run". Do not let them crowd out the answers.
4. **Flag staleness and conflicts outside citations.** For example: "content's newest entry is from 2025". Bulk-import `updated` dates are common. Mention this once, and still use them inside citations.
5. **Compose and run the citation check** (rule 6).

## Output Format

```
DAILY BRIEFING -- [date]

Short answers
- [Meeting/person]: [requested fact] [Source: slug, updated YYYY-MM-DD]
- [Unknown person]: No brain page for [Full Name].

MEETINGS TODAY
- [time] [meeting] (internal: no prep / external: details)
  - [fact] [Source: slug, updated YYYY-MM-DD]
  - Conflicts / staleness notes (outside the brackets)

ACTIVE DEALS / ACTION ITEMS / RECENT CHANGES / PEOPLE IN PLAY (brief)

Not covered: [pulls that couldn't run]
```

## When it fails

- If a tool errors or is unavailable, name the missing section and continue. Never drop a meeting.
- If an empty or degraded search result happens for a named person, retry with a keyword search before declaring "No brain page for <name>".

## Anti-Patterns

- Citing with `dated`, `signed` or `undated`, or with free text inside the brackets.
- Citing two slugs in one bracket.
- Citing only a company page, account page or meeting note for a person's role, instead of their `people/` page.
- Citing an account summary page or a later-dated record for an account value, instead of the contract in force on the briefing date.
- Quoting a draft, an unsigned value or a not-yet-effective value as current.
- Describing an unknown participant from a near-name match.
- Modifying brain pages unprompted.
