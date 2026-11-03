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

Compile a daily briefing from brain context. The most important part is the
**per-meeting fact the user asked for**. For each external meeting, state that
fact correctly, cite the right page, or say plainly that the brain has no page.
The rest of the briefing is supporting material.

> **Filing rule:** When the briefing creates or updates brain pages,
> follow `skills/_brain-filing-rules.md`. By default the briefing is read-only.

## Contract (every answer must satisfy all of these)

1. **Every external meeting gets its requested fact.** One external meeting is
   one person or one account named on the calendar. Internal blocks, focus
   blocks and plain "Lunch" entries need no research.
2. **Every fact carries an inline citation in exactly this form:**
   `[Source: <slug>, updated <YYYY-MM-DD>]`
   - The slug must be the real page slug, such as `people/jane-doe-12` or
     `contracts/2025-01-20-abc-msa`.
   - Never write a placeholder, a withheld marker, a URL or a free-text source.
   - The cited page must itself contain the fact.
3. **When a participant has no person page, say so in these words:**
   "**No brain page for <Full Name>.**"
   - Put that sentence first in the meeting's section.
   - Do not describe the person, guess a company, or substitute a similar name.
   - Still cover every other meeting fully.
4. **Account values are the values in force on the briefing date,** not today's
   values and not the latest values in the brain.

## Step 1: Parse the task

- Record the briefing date.
- List each external meeting and the exact fact requested for it. Typical
  requests are:
  - for a person: who they are and which company they are with;
  - for an account: its seat count, discount off list price, list price per
    seat, or support tier.

## Step 2: Resolve people

For each person:

1. Run a keyword search on the exact full name, for example
   `search {"query":"\"First Last\"","match":"keyword"}`. You can OR several
   names together in one search.
2. Confirm the page with
   `list_pages {"slug_prefix":"people/first-last"}` or with a person-type
   search.
3. Only a page whose **title exactly equals the name** counts as that person.
   - Search hits that merely mention the name do not count.
   - Meeting notes that mention the name do not count.
   - The top fuzzy hit does not count.
4. If there is no exact person page, do these extra checks:
   - search the first name alone;
   - search the last name alone;
   - run `resolve_slugs` on the full name.
   If all of these come back empty, the result is **"No brain page for <Name>."**
   - Do not soften this into "unverified", "unresolved" or "unknown".
   - You may add one line suggesting the user check the invite email.
5. If the page exists, take role and company from it and cite **the person's
   own page**: `[Source: people/<slug>, updated <date>]`.
   - If other notes conflict on the title, you may mention the conflict, but
     the main citation stays the person page.

## Step 3: Resolve account values (value in force on the briefing date)

1. Find every record for the account. Account names can change, so also search
   former and new names:
   - search the account name;
   - run `list_pages {"slug_prefix":"contracts/"}` and scan the titles;
   - check the account page, emails and update notes.
2. Build a timeline of **executed** commercial records: the MSA or subscription
   agreement, amendments, renewals, order forms and affiliate amendments. For
   each record, note three things: whether it is signed, its effective date,
   and which terms it changes.
3. Choose the governing record using these rules:
   - **Drafts, proposals and unsigned or uncountersigned copies never govern.**
   - **A record that is signed but not yet effective on the briefing date does
     not govern.** Mention it as an upcoming change.
   - The governing record is the latest executed record that is effective on or
     before the briefing date **and sets the specific term asked for**.
   - If an amendment changes only other terms, such as seats only, then the
     earlier agreement still holds the requested term, such as the discount.
     Cite that earlier agreement.
4. **Cite the governing contract record that states the value.** Account pages,
   emails, recaps and meeting notes may confirm the value, but they are not
   enough on their own.
   - Example: if an email says "we stay at X%", find the executed agreement that
     sets X% and cite it.
   - Add the supporting page as a second citation if you like.
5. State the value plainly, for example: "Current discount: 12% off list
   [Source: contracts/..., updated ...]". If it is relevant, add a separate line
   for the upcoming change.

## Reading pages

- Call `get_page` with **minimal arguments**, for example
  `{"slug":"people/x-1"}` or `{"slug":"...","include_content":true}`. Do not
  fill in every optional field: tiny `lines`/`bytes` windows and odd option
  combinations cause errors.
- If `get_page` still errors, do not retry the same call. Use a keyword search
  with a large `snippet_chars` (for example 8000–20000), restricted to that page
  or name, to read the text.
- Take the `updated` date for the citation from the page metadata returned by
  search or list results. Use the YYYY-MM-DD format.

## Step 4: Supporting sections (best effort, keep them brief)

If the tools are available, you may add:
- recent salience;
- anomalies;
- active deals and deadlines;
- action items and recent changes;
- people in play;
- stale alerts.

Rules for these sections:
- Do not spend many calls on them.
- If a tool is unavailable or returns data dated after the briefing date, note
  that in one line under "Coverage gaps". Do not present it as activity from
  that day.
- A failing section never blocks the meeting facts.
- Flag pages more than 30 days old as stale rather than presenting them as
  fresh.
- Label suggestions as suggestions, not as recorded commitments.

## Output Format

```
DAILY BRIEFING -- [date]

KEY FACTS
- [Person]: [role] at [company] [Source: people/slug, updated DATE]
- [Account]: [requested value] (in force on [date]) [Source: contracts/slug, updated DATE]
- [Unknown person]: No brain page for [Full Name].

MEETINGS TODAY
- [time] [meeting] -- requested fact with citation, then brief useful context
  (internal / focus / lunch blocks: one line)

ACTIVE DEALS / ACTION ITEMS (if found, with dates and citations)

COVERAGE GAPS (unavailable tools, read failures, missing attendees)
```

## Anti-Patterns

- **Citing the wrong page for an account value.** Citing only an email or note
  that discusses the value fails, even when the number is right. Cite the
  executed contract that sets it.
- **Using a draft, or a signed-but-not-yet-effective renewal,** as today's
  value.
- **Writing "unverified" or "unresolved" for a missing person.** Write "No brain
  page for <Name>."
- **Describing a person from a page that is not their own exact-title page.**
- **Non-standard citations**: placeholders, withheld markers, missing dates, or
  bracket formats other than `[Source: slug, updated DATE]`.
- **Retrying the same failing tool call repeatedly.**
- **Modifying brain pages unprompted.**
