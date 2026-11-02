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

Answer questions using the brain's knowledge with 3-layer search and synthesis.

> **Memory verbs (MEMORY_VERBS v1, gbrain ≥ 0.43).** When connected to a brain
> over MCP, prefer the memory verbs for memory work. They carry provenance,
> evidence, and a server-enforced token budget:
> - **`recall(query | entity, budget_tokens)`** is the budget-packed memory read.
>   Use it instead of bare `search` for "what do we know that we SAVED about X".
> - **`entity(name)`** is a zero-LLM person/company/project card.
> - **`synthesize(question)`** is the expensive cross-page answer. Use it only
>   when the answer must combine evidence across pages.
>
> Fall back to `search`/`query`/`get_page` when the verbs aren't available.

## Contract

This skill guarantees:
- Every answer is grounded in brain content (no hallucination).
- Every stated value is cited as `[Source: <slug>]`, and the cited slug is the page that **decides** that value.
- Gaps are flagged explicitly ("the brain doesn't have information on X"), and the answer names what was searched.
- Source precedence is respected (user statements > signed/compiled records > timeline > notes/external).
- Conflicting sources are noted with both citations.

## The decisive-page rule (most important)

Scoring checks that you cite the page that decides each value you state. Citing only an intermediate page fails, even if that page states the fact.

- **Multi-hop entity questions** ("who founded the company X works with", "who runs the company that meeting was about", "where does X's advisor work"): chain through the pages (person → company, meeting → company → founder). Then **open the final named entity's own page** and cite it. If the answer names a person, cite that person's page (`people/...`). If it names a company, cite the company's page. Also cite the intermediate pages that justify each hop.
  - Example shape: "Founder is Jane Doe [Source: people/jane-doe-3]. The company page also says so [Source: companies/acme]. X works at Acme [Source: people/x-1]."
  - Find the named entity's slug with `search`, `resolve_slugs`, `list_pages --slug_prefix people/<first>-`, or the links on the company page, then `get_page` it. Slugs often have numeric suffixes (`people/name-6`), so don't guess. Look them up.
  - If the answer names several entities (for example, the person works with two companies and each has a founder), open and cite **each** named person's or company's page.
  - If the named entity has no page of its own, say so and cite the page that names them.
- **As-of-date questions** (seats, prices, tiers, renewal dates, roles on a date): cite the record **in force on that date**. That is the one whose effective date is on or before the date and that has not been superseded by a later effective record. A record that was signed but is not yet effective does not count. A superseded record does not count. Check amendments and renewals, and compare effective dates to signing dates. Account pages, CRM notes, emails and meeting notes are supporting evidence only. Signed contract terms win.
- Always write citations literally as `[Source: <full-slug>]`. Don't use bare backticks or prose descriptions as citations.

## Phases

1. **Decompose the question.** Identify each hop and each value the question asks for. Note any "as of" date.
2. **Execute searches:**
   - Keyword search (`search`) for exact names, codes and terms.
   - Hybrid search (`query`) for conceptual questions. Filter with `types`, `since`/`until` and `source_id`.
   - Use `list_pages` (by slug prefix or type), `get_backlinks` or `traverse_graph` for structural and relational hops.
   - Watch for near-duplicate names (similar company or person names). Confirm you have the right entity.
3. **Read the decisive pages.** Read the top pages for each hop, and always open the final named entity's own page (see the decisive-page rule).
4. **Synthesize.** Give a direct answer with every requested value. Cite the decisive page for each value, plus the supporting pages.
5. **Flag gaps.** If the entity or value isn't in the brain, say "the brain doesn't have information on X". List what you searched (exact name, name parts, fuzzy slug lookup, semantic search). Offer near matches if you found any, but don't present them as the answer. Read the result notices first: a degraded or truncated result is not a gap.

## When it fails

- Check each result for notices (MCP text blocks like `[gbrain notice empty_retrieval kind=degraded]`, `_meta.gbrain_notices`; on the CLI, `[AGENT]` blocks or `search_degraded`).
- **Degraded empty retrieval:** an empty result is not proof the brain has no notes. Say that search is keyword-only. Retry with exact names and synonyms.
- **Clean miss:** say "the brain doesn't have information on X".
- **`listing_truncated` / `budget_truncated`:** say "showing the first N", then page or narrow the query before claiming something is absent.
- **`page_not_found`:** the slug is wrong or in another source. Search by title before reporting the page missing.

## Conflicts and precedence

1. User's direct statements
2. Signed or effective records and compiled truth
3. Timeline entries
4. Meeting notes, emails, CRM notes, external sources

When sources conflict, give the answer from the highest-precedence decisive page. Note the conflict with both citations, and keep the note brief. Conflicts never excuse omitting the decisive citation.

## Graph traversal

For relationship questions, use `traverse_graph` / `get_backlinks` with link types (`works_at`, `founded`, `attended`, `advises`, `invested_in`, `mentions`). Use direction `in` for "who points to X". Graph links are often missing. When they are, fall back to the text of the company or person pages, and still open the named entity's page.

## Token-budget awareness

- Search returns chunks. Read excerpts first, and load full pages when you need compiled truth or timeline details, or when a page is the decisive page to cite.
- For "when did X change" questions, use `return_unit: "page"` or `"window"` to get the surrounding text.
- `recall` with `budget_policy: "query_first"` is available for tight-budget page-evidence questions.

## Output format

- A one-line direct answer with every requested value, each followed by `[Source: <decisive-slug>]`.
- Short supporting bullets: the hops, the effective dates, and the other pages that agree, all cited.
- Conflict notes, if any, with both citations.
- Gap statements that name what was looked for.

## Anti-patterns

- Naming a founder, employee or other person but citing only the company or meeting page. Open and cite the person's page.
- Citing a superseded or not-yet-effective record for an as-of question.
- Answering from general knowledge or guessing slugs.
- Silently picking one source when sources conflict.
- Declaring a gap from a degraded or truncated search.
