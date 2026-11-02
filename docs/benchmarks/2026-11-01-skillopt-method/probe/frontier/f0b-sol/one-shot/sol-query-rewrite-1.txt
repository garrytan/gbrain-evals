---
name: query
version: 1.0.0
description: |
  Answer questions using the brain's knowledge with 3-layer search, synthesis,
  and citation propagation. Use when the user asks a question, wants a lookup,
  or needs information from the brain.
triggers:
  - "what do we know about"
  - "tell me about"
  - "who is"
  - "what happened"
  - "search for"
  - "look up"
  - "background on"
  - "notes on"
  - "who knows who"
  - "relationship between"
  - "connections"
  - "graph query"
tools:
  - recall
  - search
  - query
  - get_page
  - list_pages
  - get_backlinks
  - traverse_graph
  - get_timeline
mutating: false
---

# Query Skill

Answer questions from the brain's knowledge using search, page reads and synthesis. Every stated value must cite the page that decides it.

> **Memory verbs (MEMORY_VERBS v1, gbrain ≥ 0.43).** When connected to a brain
> over MCP, prefer the memory verbs when they are available:
> - **`recall(query | entity, budget_tokens)`** is the budget-packed memory read.
> - **`entity(name)`** returns a person, company or project card.
> - **`synthesize(question)`** is the expensive cross-page answer.
>
> Fall back to `search`, `query` and `get_page` when these verbs aren't on the surface.

## Contract

- Every answer is grounded in brain content. Never answer from general knowledge.
- Every stated value carries a citation to the page that decides it, in the form `[Source: <slug>]`.
- Gaps are flagged explicitly, and the answer names what was searched for.
- Source precedence is respected.
- Conflicts are noted, with both citations.

## The deciding-page rule (most important)

A citation only counts if it is the page that actually holds the answer. Citing only an intermediate page fails, even if the stated value is correct.

**Entity answers.** When your answer names a person or company as the answer, you must find that entity's own page and cite its slug.
- Person pages look like `people/<name>` or `people/<name>-N`.
- Company pages look like `companies/<name>`.
- Bridging pages (meeting, company, employee) do not substitute for it. Cite them too, but they are not enough on their own.

**Dated values.** For a value "as of" a date, cite the record in force on that date.
- Do not cite only a record it superseded.
- Do not cite only a record that was signed but not yet effective.

**Rule of thumb.** Before finalizing, list each value in your answer and write next to it the slug of the page that states it. If any value lacks a slug you actually saw returned by a tool, keep searching.

## Multi-hop questions

Examples: "who founded the company X works with", or "who founded the company that meeting was about". Resolve one hop at a time and record a slug for each hop.

1. **Find the starting entity's page.** Search the person, or the meeting by attendee plus date.
   - Read the page or snippet to identify the next entity, such as the company, the meeting's subject, or the employer.
   - Note which relationship the question asks about: works at, works with, advises, or the subject of the meeting.
2. **Find the intermediate entity's page** (for example `companies/<name>`). Read who founded or leads it.
3. **Find the final entity's own page.** Search the founder's name, for example with `search {"query":"\"<Name>\"","types":["person"]}`.
   - Confirm that page says they founded or are connected to that company.
   - Names can be duplicated, with slugs differing by a numeric suffix. Pick the page whose content matches the company.
4. **Answer with the final entity's page slug.** Cite the intermediate pages as supporting evidence: `**<Founder>** founded **<Company>** … [Source: people/<founder-slug>; companies/<company>; <meeting-slug>]`.

`traverse_graph` often errors. If it does, don't retry repeatedly. Fall back to keyword search on the names found in the pages.

If the starting person or meeting is not in the brain, do not guess. Say so: "the brain doesn't have information on <name>". Mention any near-matches you found, but don't present them as the answer.

## "As of a date" questions (contracts, subscriptions, terms)

1. **Gather every record for the entity.** Keyword-search the entity name and collect all of them: order forms, MSAs, amendments, affiliate amendments and renewals.
   - A parent agreement may cover affiliates by name.
   - Search both the affiliate and the parent.
2. **Find each record's effective dates.** For each one, determine:
   - the effective date (not the signing date);
   - the term end;
   - what it changes or preserves.
3. **Pick the record in force on the asked date.** That is the latest record whose effective date is on or before that date and whose term covers it.
   - A renewal signed before the date but effective after it does not apply yet.
   - The term end of the current term is the "renewal date".
4. **Cite that record's slug for each value.** If a later record only "preserves" a value set earlier, cite both.
5. **Optionally mention the superseded or pending records,** with their citations, so the timeline is clear.

## Phases

1. **Decompose the question.** Identify the entities, the hops, any as-of date, and every value requested.
2. **Search.**
   - Use `search` with `match: "keyword"` and quoted names for exact names.
   - Use `query` for concepts.
   - Use `list_pages` with `slug_prefix` or a type for structural sweeps.
   - Use `return_unit: "page"` to get whole-page evidence in one call.
3. **Read.**
   - Use snippets when they are sufficient.
   - Use `get_page` with minimal arguments (just `slug`) when you need more. If it errors, re-fetch via `search` with `return_unit: "page"` instead.
4. **Synthesize** with citations per the deciding-page rule.
5. **Flag gaps.** Check retrieval notices first: a degraded or truncated result is not a gap.

## When it fails

- **Degraded retrieval.** This shows as an `empty_retrieval` notice with `kind=degraded`, or as `search_degraded`. An empty result is not proof of absence.
  - Try exact names and synonyms with keyword search.
  - Tell the user that search is keyword-only right now.
- **Clean miss.** Say "the brain doesn't have information on X" and name what you looked for.
- **`listing_truncated` / `budget_truncated`.** Page through the results or narrow the query before claiming something is absent.
- **`page_not_found`.** Search by title, or use `resolve_slugs`, before reporting the page missing.

## Source precedence

1. The user's direct statements
2. Compiled truth
3. Timeline entries
4. External sources

When sources conflict, show both, with citations.

## Graph traversal

- Use `traverse_graph` or `get_backlinks` for relationship questions.
- Link types: `attended`, `works_at`, `invested_in`, `founded`, `advises`, `mentions`, `source`.
- Direction:
  - `in` answers "who points to X".
  - `out` answers "what X points to".
- If graph calls error or return nothing, fall back to search and page reading.
- Even when the graph gives you the answer, you still need to cite the answer entity's own page.

## Output format

- Give a direct answer stating every requested value. Include the year in any date.
- Add inline citations, for example `[Source: people/jane-doe]` or `[Source: contracts/<slug>, §3]`.
- Add gap flags and conflict notes where needed.
- Before sending, check:
  - Does every value have the deciding page's slug?
  - For a named person or company, is their own page cited?

## Anti-patterns

- Citing only the meeting or company page when the answer is a person (or vice versa).
- Using a signed-but-not-yet-effective record, or a superseded record, for an as-of value.
- Hallucinating, or answering for a different similarly named entity.
- Silently picking one source among conflicting ones.
- Retrying an erroring tool call with the same arguments instead of falling back.
