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
> evidence and a server-enforced token budget:
> - **`recall(query | entity, budget_tokens)`**: the budget-packed memory read.
> - **`entity(name)`**: a zero-LLM person/company/project card.
> - **`synthesize(question)`**: the expensive cross-page answer.
> Fall back to `search`/`query`/`get_page` when the verbs aren't available.

## Contract

This skill guarantees:
- Every answer is grounded in brain content (no hallucination).
- Every stated value has a citation, `[Source: <slug>]`, to **the page that decides it**.
- Gaps are flagged explicitly ("the brain doesn't have information on X"), and the flag names what was searched.
- Source precedence is respected: signed or in-force records and user statements come before compiled truth, then timeline, then external sources.
- Conflicting sources are noted with both citations.

## The citation rule (most common failure)

An answer is only correct if it cites, by slug, the page that **decides** each value it states:

1. **Every entity named in the answer needs its own page cited.** If the answer names a person, for example the founder, cite **that person's page**, such as `people/<name>`. If it names a company, cite **that company's page**. Citing only the intermediate page fails. Intermediate pages include a meeting note, an employee's page, or the company page that mentions the founder.
2. **Multi-hop questions** ("who founded the company X works with", "who founded the company that meeting was about"):
   - Hop 1: find the starting page (the person or meeting) and identify the company. Cite it.
   - Hop 2: open the company page and find the founder's name. Cite it.
   - **Hop 3 (mandatory): resolve and open the founder's own page.** Search the name, use `list_pages` with a `people/` prefix, or follow backlinks or links. Confirm the page says they founded this company, then cite its exact slug.
   - The final answer cites all three. Put the founder's person slug on the sentence that names the founder.
   - If several companies or founders qualify, do hop 3 for **each** founder named.
   - If the founder's page truly does not exist after searching, say so explicitly and cite the company page.
3. Use the exact slug returned by the tool, such as `people/jane-doe-3`. Never use a guessed slug or a bare title. Write citations as `[Source: <slug>]`.
4. For a value **as of a date**, cite the record **in force on that date**. Do not cite a record it superseded. Do not cite one that was signed but has not yet taken effect. Other pages may also be cited, but the deciding one must be present.

## Phases

1. **Decompose the question.** Identify each value requested, any "as of" date, and the chain of entities to traverse.
2. **Execute searches:**
   - Use `search` (keyword) for exact names and terms, and `query` (hybrid) for concepts.
   - Use `list_pages` with slug prefixes (`contracts/`, `accounts/`, `people/`, `companies/`) for structural sweeps.
   - Use `get_backlinks` and `traverse_graph` for relationships.
   - Narrow with filters (`types`, `match: keyword`, `since`/`until`, `source_id`).
3. **Read the deciding pages in full** with `get_page`. Read every entity page you will name.
4. **Synthesize** the answer with a citation per claim.
5. **Flag gaps** honestly (see below).

## As-of-date questions (contracts, seats, tiers, prices, renewal dates)

- List every agreement, order form, amendment and renewal for the account. A `contracts/` prefix sweep is useful here.
- For each one, note the **effective date** and the **signing date**. Signing does not make terms effective. Pick the latest record whose effective date is on or before the asked date, and check later amendments that changed only some terms.
- "Renewal date / last day of term" means the end date of the term in force on that date.
- Signed contracts outrank CRM notes, emails, meeting notes and account pages. Mention conflicting notes with their citations, but answer from the in-force record.
- Watch for look-alike names: similarly named companies, or affiliate versus parent. Confirm the record covers the exact entity asked about.

## Gaps

- If the named entity cannot be found, say "the brain doesn't have information on X" and list what you tried. Try an exact keyword search, a fuzzy or partial slug match, a semantic search, and a prefix listing.
- Do not substitute a similar-named entity's value as the answer. You may offer near matches as suggestions, clearly labelled.
- Check notices first. `empty_retrieval kind=degraded` or `search_degraded` means the search ran on keywords only, so an empty result is not proof the brain has no notes. Say so and retry with exact names. `listing_truncated` or `budget_truncated` means you must page further before claiming absence. `page_not_found` means you should search by title before reporting the page missing.

## Source precedence

1. User's direct statements, and signed in-force records for contractual facts
2. Compiled truth
3. Timeline entries
4. External sources

When sources conflict, note the contradiction with both citations. Do not silently pick one. Conflicts do not remove the requirement to cite the deciding page, such as the founder's own page.

## Graph traversal

For relationship questions, use `traverse_graph` or `get_backlinks`:
- Link types: `attended`, `works_at`, `invested_in`, `founded`, `advises`, `mentions`, `source`.
- Use `direction: in` for "who points to X" (for example, who founded or works at X). Use `out` for "what does X point to".
- Graph links are often missing. When they are, fall back to page text and name search, and still open the entity's own page.

## Token-budget awareness

- Search returns chunks. Use them to locate pages, then use `get_page` on the pages that decide the answer.
- Use `return_unit: "page"` when the answer depends on surrounding text.
- For "did anyone mention Y", search excerpts may suffice. For "who/what is the value", open the deciding page.

## Output format

- Start with a direct answer that states every requested value.
- Cite each value inline with `[Source: <slug>]`. For chain answers, cite each hop, including the final entity's own page.
- Add conflict notes with citations.
- Add gap flags where relevant.

## Final check before answering

- Is every requested value stated?
- Does every person or company I name have its own page slug cited?
- For as-of questions, is the cited record the one in force on that date?
- If the answer is a gap, did I say so and name what I searched?
