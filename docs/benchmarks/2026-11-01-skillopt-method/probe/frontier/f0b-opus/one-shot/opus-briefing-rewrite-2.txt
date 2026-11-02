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

Compile a daily briefing from brain context. The briefing is read-only. Do not create or modify pages unless the user explicitly asks.

> **Filing rule:** When the briefing creates or updates brain pages,
> follow `skills/_brain-filing-rules.md`.

## Contract (what every briefing must get right)

1. **Every external meeting gets the fact the task asks for.** Examples are who a person is and which company they are with, or an account's seat count, discount, list price or support tier. State it plainly in that meeting's section.
2. **Every such fact carries an inline citation in exactly this form:**
   `[Source: <slug>, updated <YYYY-MM-DD>]`
   - The citation goes right after the fact. It names the page that actually holds the fact.
   - For a person, cite **the person's own page** (for example `people/<name>-<n>`). Company or meeting pages can be extra citations, but they never replace it.
   - For an account value, cite **the contract or record in force on the briefing date**. That is the signed document whose effective date has started and that has not been superseded.
3. **When a participant has no brain page**, write the literal sentence `No brain page for <Full Name>.` in that meeting's section. Then say the brain doesn't tell you who they are or which company they're with. Do not describe them from loose matches. Still cover every other meeting.

Scoring is all or nothing. One malformed citation or one missing "No brain page for" line fails the whole briefing.

## Citation format: strict rules

The bracket must contain only the slug, a comma, the word `updated`, and a full date that includes the year.

- ✅ `[Source: people/jane-doe-12, updated 2026-11-02]`
- ✅ `[Source: contracts/2025-01-20-abc-msa, updated 2025-01-20]`
- ❌ `dated 2025-03-28`, `signed 2026-02-24`, `undated`, `no reliable date`, `no document date`, `last dated entry 2025-04-08`, `latest entry ...`, `last real update ... (page imported ...)`
- ❌ A slug with no date: `[Source: people/jane-doe-12]`
- ❌ A date with no `updated` keyword: `[Source: slug, 2025-10-02]`
- ❌ Two slugs in one bracket: `[Source: a; b]`. Use one bracket per page.
- ❌ `[same source]`, or a bare `[slug, date]`

Which date to use:
- Use the page's `updated` value as the tool returns it, copied verbatim. Use it even if it looks like a bulk-import date or falls after the briefing date.
- If the page shows no updated value, use the document's own date in the same `updated YYYY-MM-DD` form.
- Never leave the date out.

Freshness caveats go **outside** the bracket. For example: `[Source: people/x-1, updated 2026-11-02]. Note: the newest dated entry on this page is from 2025-04.`

Before finishing, scan every `[Source:` in your answer and fix any that break these rules.

## Procedure

### 1. Resolve each external meeting (do this first; it is the priority)

For each external meeting on the calendar, skip internal blocks, focus time and plain "Lunch".

**For a person:**
- Run a keyword search on the exact full name, for example `search {"query":"\"First Last\"","match":"keyword"}`.
- `resolve_slugs` is unreliable with spaces. Don't conclude "no page" from it alone.
- If you find an exact title match under `people/`, open it with `get_page`.
- If there is no exact match, also search the first name and the surname separately, and try spelling variants.
- If nothing matches the full name, write `No brain page for <Full Name>.`
  - Never adopt a near-miss name, a nickname or a top fuzzy hit.
- State their role and company from their own page, and cite it.
- If other pages contradict the role, briefly flag the conflict. Still give the person page's answer as the primary one.

**For an account value (seats, discount, price, tier, and so on):**
1. Search the account name and list its contract pages (`list_pages` with the `contracts/` prefix, or deal type). Include amendments, renewals, order forms and affiliate amendments. The account may also have been renamed.
2. Open each candidate and note:
   - signed vs. draft/unsigned
   - effective date
   - term end
   - which terms it changes
3. Pick the record **in force on the briefing date**. That is the most recent *signed* document whose effective date is on or before the briefing date and that changes this term.
   - Ignore unsigned drafts and rejected proposals.
   - Ignore documents signed but not yet effective. Mention them as upcoming.
   - Ignore anything dated after the briefing date.
   - An amendment that doesn't touch this term leaves the earlier value in force. In that case cite the document that set the value.
   - On a boundary day, check carefully whether the old term's last day or the new term's first day is today.
4. State the value and cite that contract page, for example `[Source: contracts/<slug>, updated <date>]`.
   - Account pages, emails and notes can be extra context.
   - They must not be the only citation for the value.
   - They lose to a signed contract when they conflict.

### 2. Context pulls (best effort; never at the expense of step 1)

Run what the tools allow:
- `get_recent_salience`
- `find_anomalies`
- `query` for active deals and pending commitments
- `list_pages` for deals and recently updated people

CLI-only pulls may not be available as tools: `gbrain recall`, `recall --since-last-run`, `gbrain waiting`, and health checks. If so, say in one line that those sections are missing, not empty.

If every page shares the same `updated` timestamp, salience, anomalies and "recent changes" reflect a bulk import, not real activity. Say so briefly. Judge freshness from the dates inside each page. Still cite the `updated` value as shown.

When `gbrain waiting` is available but refuses because the data is stale, run the sync it names, then retry. Never build "waiting on you" from stale mail.

### 3. Compose

```
DAILY BRIEFING -- [date]

MEETINGS TODAY
- [time] [meeting]
  Answer: [requested fact] [Source: slug, updated YYYY-MM-DD]
  Context, conflicts, staleness (each fact cited the same way)
  -- or --
  No brain page for [Full Name]. The brain doesn't say who they are or which company they're with.

ACTIVE DEALS / ACTION ITEMS / RECENT CHANGES / PEOPLE IN PLAY (brief, cited)

NOT COVERED: sections whose tools or data weren't available
```

Put the requested fact first in each meeting section. Keep the extras short.

## When it fails

Follow the [agent operator protocol](../conventions/agent-operator-protocol.md) for gbrain errors.
- If one section's source fails, ship the rest of the briefing and name the missing section.
- If `recall` or `query` is degraded, say the brain is searching keywords only. Don't write "nothing happened".

## Anti-Patterns

- **Wrong citation form.** Using any citation form other than `[Source: slug, updated YYYY-MM-DD]`. This is the most common failure.
- **Wrong page for a person.** Citing only a company or meeting page for a person's role.
- **Wrong document for an account value.** Citing an account summary, email or note instead of the contract in force, or citing the original contract when a signed, effective amendment changed the term.
- **Draft or future values.** Reporting a draft, an unsigned figure, a not-yet-effective figure, or a figure dated after the briefing as current.
- **Describing a stranger.** Describing someone with no exact-name page, or omitting the `No brain page for <Full Name>.` line.
- **Briefing from memory.** Writing the briefing without brain queries, or modifying pages unprompted.
