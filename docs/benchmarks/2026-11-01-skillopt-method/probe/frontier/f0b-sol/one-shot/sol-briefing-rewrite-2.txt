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

Compile a daily briefing from brain context. The briefing is for a specific
date, which may be in the past. Every claim must be grounded in brain pages and
dated to that day.

> **Filing rule:** When the briefing creates or updates brain pages,
> follow `skills/_brain-filing-rules.md`.

## Contract (what makes a briefing correct)

A briefing passes only if all of these hold for every external meeting:

1. **The requested fact is stated.** The task asks for a specific fact for each
   external meeting, such as who a person is and their company, or an account's
   seat count, discount, list price or support tier. State it plainly in that
   meeting's section.
2. **The fact is cited inline in exactly this form:** `[Source: <slug>, updated <YYYY-MM-DD>]`.
   - For a **person**, cite the person's own page (for example `people/<name-NN>`).
   - For an **account value**, cite the record that *sets the value in force on
     the briefing date*. That is normally the executed contract, amendment or
     renewal whose effective date is on or before the briefing date and has not
     yet been superseded.
   - Emails, meeting notes, account summaries and drafts may be added as
     supporting citations. They never replace the governing record.
   - Never put `[withheld]` or a placeholder in the slug. Cite the real slug
     returned by your tools.
3. **A missing participant is flagged in fixed wording.** If an external person
   has no brain page, write the literal sentence **"No brain page for <Full Name>."**
   in that meeting's section.
   - Do not describe them or guess a company.
   - Do not substitute a similarly named contact.
   - Still cover every other meeting fully.
   - Weaker wording such as "unverified", "unresolved" or "no matching record
     found" is not enough on its own. Always include the exact sentence.

Scoring is all or nothing, so check all three for every external meeting before
you answer.

## Procedure

### Step 1 — Parse the task
- Record the briefing date.
- List the meetings and mark each one as external or internal.
- For each external meeting, note the exact fact requested.
- Internal meetings, focus blocks and lunches without a named person need only a
  one-line mention.

### Step 2 — Resolve each external person
1. Run a keyword search for the exact full name in quotes. You may combine names
   with OR in one search.
2. A hit counts only if a `people/...` page has the exact matching title. Exactly
   one such page counts as the attendee. A search's top hit is not automatically
   the attendee.
3. If there is no exact match:
   - Also search the first name and surname separately. You can also try
     `list_pages` with `slug_prefix: "people/<first>-<last>"`.
   - If still nothing matches, the result is **"No brain page for <Full Name>."**
4. Take role and company from the person page's compiled truth, read through
   search snippets or `get_page`. Cite the person page itself.
5. If other notes conflict on the person's role, mention the conflict briefly.
   Still state the person page's role and company, cited to the person page.

### Step 3 — Resolve each account value as of the briefing date
1. Search for the account name. Also search for any former or alternate names,
   since accounts get renamed.
2. List the contract pages with `list_pages` and `slug_prefix: "contracts/"`. Slugs
   usually start with the signing date.
3. Build a timeline of all candidate records for the account. Include the master
   agreement, amendments and renewals, and keep each record's signing date and
   **effective date**.
4. Choose the record in force on the briefing date:
   - **Signed is not the same as effective.** A record signed before the
     briefing date but effective after it does not apply yet.
   - **Drafts, unsigned copies and rejected proposals never apply.**
   - **A record dated after the briefing date never applies.**
   - **If an amendment leaves a term unchanged, the earlier record still governs
     that term.** For example, an amendment that changes only seats leaves the
     discount set by the master agreement. Cite the record that actually holds
     the value.
5. State the value. Cite the governing record by its real slug. Optionally add a
   note on upcoming changes, citing the record that makes them.
6. When an email or note confirms the value, such as "stays at X%", treat it as
   support only. Locate the contract that sets X and cite that contract.

### Step 4 — Tool hygiene
- Call `get_page` with just `slug`, adding only minimal options if needed.
- If `get_page` errors, **do not retry the same call repeatedly**. Fall back to:
  - `search` with `match: "keyword"`, a large `snippet_chars` and
    `return_unit: "page"`, or
  - `query`, or
  - targeted keyword searches for the value or a document ID.
- Use the page's stored updated date in the citation, even if it is later than
  the briefing date. Flag that freshness caveat in one line at most.

### Step 5 — Optional context (only after Steps 2–3 are done)
These are nice to have, and none of them affect correctness:
- active deals
- pending commitments
- recent changes
- salience
- anomalies

Exclude anything dated after the briefing date. If a tool is unavailable, name
the gap in one line instead of dropping the section silently.

## Output Format

```
DAILY BRIEFING -- [date]

MEETINGS TODAY
- [time] [meeting] (external)
  [Requested fact stated plainly] [Source: slug, updated YYYY-MM-DD]
  [Optional context, each fact cited]
- [time] [meeting with unknown person]
  No brain page for [Full Name]. Confirm identity and company from the invite.
- [time] [internal meeting] -- internal

ACTION ITEMS / DEALS (optional, cited)

COVERAGE NOTES (brief)
```

## Anti-Patterns

- Answering an account fact with a citation only to an email, note or draft
  instead of the governing contract.
- Applying a signed-but-not-yet-effective change, or a rejected proposal.
- Writing "unverified" or "unresolved" for a missing person without the exact
  sentence "No brain page for <Full Name>."
- Describing or guessing at a person with no page.
- Citing in any form other than `[Source: slug, updated DATE]`, or with a
  placeholder slug.
- Retrying a failing `get_page` many times instead of falling back to search.
- Modifying brain pages; the briefing is read-only unless the user asks.
