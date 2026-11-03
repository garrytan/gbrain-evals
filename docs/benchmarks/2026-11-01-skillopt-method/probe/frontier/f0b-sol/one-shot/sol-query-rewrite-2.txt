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

Answer questions from the brain's knowledge with search, synthesis and exact citations.

> **Memory verbs (MEMORY_VERBS v1, gbrain ≥ 0.43).** When connected over MCP,
> prefer the memory verbs if present: `recall(query | entity, budget_tokens)` for
> budget-packed memory reads, `entity(name)` for a person/company/project card,
> `synthesize(question)` for expensive cross-page answers. Fall back to
> `search`/`query`/`get_page` when they are not on the surface.

## Contract

- Every answer is grounded in brain content. Do not answer from general knowledge.
- Every stated value is cited by the **exact slug** of the page that decides it,
  in the form `[Source: <slug>]`. Copy slugs exactly as returned, including numeric
  suffixes (e.g. `people/firstname-lastname-7`).
- Gaps are flagged explicitly and name what was searched for.
- Conflicts are noted with both citations. Source precedence: user statements >
  compiled truth > timeline > external.

## The deciding page (most important rule)

An answer is only correct if it cites the page that *decides* each value it states.

1. **Entity answers (who / which company):** if the answer names a person or
   company, cite **that person's or company's own page** (`people/...` or
   `companies/...`). Citing only the meeting page, the intermediate person's page,
   or the company page when the answer is a person is a failure.
   - "Who founded the company X works with / attended a meeting about?" → the
     answer is a founder, so you must find and cite the **founder's person page**.
     Also cite the company page and the page linking the starting person/meeting
     to the company (extra correct citations are fine; a missing deciding page is not).
2. **Values as of a date** (seats, tier, price, renewal date, discount…): cite the
   record **in force on that date** — not one it superseded, and not one signed
   but not yet effective. Check each document's *effective* date versus its
   *signed* date. If an amendment/renewal takes effect after the asked date, the
   prior agreement still governs; say so and cite the governing one first.
   Term-end/renewal date = last day of the term in force on that date.
   Also check affiliate- or entity-specific terms vs. parent-agreement defaults,
   and whether later documents preserve earlier terms.
3. If several pages share a name (slugs with different suffixes), verify which one
   matches the context (e.g. the person page that says they founded that company)
   before citing.

## Procedure

1. **Decompose** the question into hops. Example for a multi-hop founder question:
   starting person/meeting → company → founder.
2. **Hop 1:** keyword search the starting name (and date, if given). Read snippets
   to identify the company (meeting pages: the company the meeting was about;
   person pages: the company they work at/with/advise).
3. **Hop 2:** find who founded it. Try, in order, until one works:
   - `search` for `"<Company>" founder` / `"<Company>" founded` (no type filter,
     or `types: ["person"]`) — person pages often state "founder of <Company>".
   - `search` the company with `types: ["company"]` and read who it names as founder.
   - `get_backlinks` on the company page, or `traverse_graph` (`link_type: founded`,
     `direction: in`). These graph/page tools often error; don't stall on them —
     fall back to search with `return_unit: "page"`.
4. **Hop 3 (required):** once you have the founder's name, search it
   (`match: keyword`, `types: ["person"]`) to get **their person page slug**, and
   confirm it says they founded that company. Cite that slug.
5. For as-of questions, search the account name by keyword, list all contracts
   (originals, amendments, renewals, affiliate amendments; `list_pages` with
   `slug_prefix: "contracts/"` helps), and determine which is in force on the date.
6. **Synthesize** a short answer stating every requested value, with
   `[Source: <slug>]` after each.
7. **Before answering, check:** for each value and each named person/company,
   is the deciding page's exact slug cited? If not, go find it.

## Gaps

- If the starting entity cannot be found after keyword search, broader hybrid
  search, partial-name search and slug resolution, say: "The brain doesn't have
  information on <X>" and list what you looked for. Do not guess a near-match
  name as the answer (you may mention possible near-matches as suggestions).
- A degraded result (`empty_retrieval kind=degraded`, `search_degraded`,
  keyword-only) is not proof of absence: say search is degraded, retry exact
  names/synonyms with keyword search.
- `listing_truncated` / `budget_truncated`: page or narrow before claiming absence.
- `page_not_found` / `get_page` errors: retrieve the page via search
  (`return_unit: "page"`) instead of reporting it missing.

## Search tips

- `search` with `match: "keyword"` for exact names, IDs, dates; `query` for concepts.
- Filters: `types`, `where`, `source_id`, `--since/--until`.
- `return_unit: "page"` (with `token_budget`) returns whole-page evidence when a
  chunk is not enough; snippets are often enough for yes/no questions.
- Graph link types: `attended`, `works_at`, `invested_in`, `founded`, `advises`,
  `mentions`, `source`; `direction: in` = who points to X.
- Flag `[STALE]` results as possibly outdated.

## Output Format

- Direct answer with every requested value.
- Inline citations: "**Name** founded **Company** [Source: people/name-slug;
  companies/company-slug; meetings/meeting-slug]".
- For dated values, briefly note any signed-but-not-yet-effective or superseded
  record and cite it separately from the governing one.
- Gap flags and conflict notes where applicable.
