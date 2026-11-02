The current skill (SKILL.md):

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
> over MCP, prefer the seven frozen memory verbs for memory work — they carry
> provenance, evidence, and a server-enforced token budget:
> - **`recall(query | entity, budget_tokens)`** — the budget-packed memory read.
>   Use it instead of bare `search` for "what do we know that we SAVED about X".
> - **`entity(name)`** — a zero-LLM person/company/project card (aliases,
>   last-touched, open threads, top edges). Use it instead of `get_page` +
>   `get_backlinks` when you just need the card.
> - **`synthesize(question)`** — the explicitly-expensive cross-page answer; the
>   heavy version of `query`. Reach for it only when the answer must combine
>   evidence across pages.
> Fall back to `search`/`query`/`get_page` when the verbs aren't on the surface
> (pre-0.43 servers; `--surface full` includes the verbs alongside every other
> op). See `docs/protocol/MEMORY_VERBS_v1.md`.

## Contract

This skill guarantees:
- Every answer is grounded in brain content (no hallucination)
- Every claim has a citation tracing back to a specific page slug
- Gaps are flagged explicitly ("the brain doesn't have information on X")
- Source precedence is respected (user statements > compiled truth > timeline > external)
- Conflicting sources are noted with both citations

## Phases

1. **Decompose the question** into search strategies:
   - Keyword search for specific names, dates, terms
   - Semantic query for conceptual questions
   - Structured queries (list by type, backlinks) for relational questions
2. **Execute searches:**
   - Cheap-hybrid search gbrain for exact tokens / known names (search)
   - Full-hybrid search gbrain for concept questions (query; `--expand` adds multi-query expansion)
   - List pages in gbrain by type or check backlinks for structural queries
   - Narrow with filters instead of grepping the brain checkout: `--types '["meeting"]'`,
     `--match keyword`, `gbrain query "<q>" --since 2026-09-01 --until 2026-09-30`, `--source <id>`.
     Copyable examples: "Retrieval: gbrain first" in `skills/conventions/brain-first.md`.
3. **Read top results.** Read the top 3-5 pages from gbrain to get full context.
4. **Synthesize answer** with citations. Every claim traces back to a specific page slug.
5. **Flag gaps.** If the brain doesn't have info, say "the brain doesn't have information on X" rather than hallucinating. Read the result's notices first (see "When it fails"): a degraded or truncated result is not a gap.

## When it fails

Follow the [agent operator protocol](../conventions/agent-operator-protocol.md) for any gbrain error `code`, exit code, `[AGENT]` block or notice block. Specific to this skill:

- Check each retrieval result for notices before answering: on MCP, extra text blocks whose first line looks like [gbrain notice empty_retrieval kind=degraded], mirrored in `_meta.gbrain_notices`; on the CLI, the `[AGENT]` block, `search_degraded`, or a `note: search degraded` line.
- `empty_retrieval` with `kind=degraded` (or `search_degraded: keyword_only_no_embedding_provider`): an empty result is NOT proof the user has no notes. Tell the user "your brain is searching keywords only right now, so I may be missing notes on X", try exact names and synonyms with `gbrain search`, and point to the notice's fix (usually enabling embeddings).
- `empty_retrieval` with "no retrieval degradation — this is a clean miss": then say "the brain doesn't have information on X".
- `listing_truncated` or `budget_truncated`: the list was cut off. Say "showing the first N", and page or narrow the query before claiming something is absent.
- `page_not_found` from `get_page`: the slug is wrong or in another source; search by title (and check `--source`) before reporting the page missing.

## Anti-Patterns

- Answering from general knowledge when the brain has relevant content
- Hallucinating facts not in the brain
- Silently picking one source when sources conflict
- Loading full pages when search chunks are sufficient
- Ignoring source precedence (user statements are highest authority)

## Output Format

Answers should include:
- Direct response to the question
- Citations: "According to [Source: people/jane-doe, compiled truth]..."
- Gap flags: "The brain doesn't have information on X"
- Conflict notes when sources disagree

## Quality Rules

- Never hallucinate. Only answer from brain content.
- Cite sources: "According to concepts/do-things-that-dont-scale..."
- Flag stale results: if a search result shows [STALE], note that the info may be outdated
- For "who" questions, use backlinks and typed links to find connections
- For "what happened" questions, use timeline entries
- For "what do we know" questions, read compiled_truth directly

## Token-Budget Awareness

Search returns **chunks**, not full pages. Read the excerpts first before deciding
whether to load a full page.

For a question about saved **page evidence** with a tight budget, explicitly choose
`recall` with `budget_policy: "query_first"`. It gives the existing ranked page
results first use of the budget, then packs recent/filtered facts into what remains.
This is an opt-in packing choice, not a new relevance model: an irrelevant page can
displace a useful fact. Keep entity-first, session/event-filtered and fact-focused
questions on their existing facts-first route. Do not change `context_pack` or
existing third-party calls.

```bash
gbrain recall --query 'zebra telescope' --budget-tokens 75 --budget-policy query_first --json
```

Equivalent MCP request:

```json
{"name":"recall","arguments":{"query":"zebra telescope","budget_tokens":75,"budget_policy":"query_first"}}
```

**Say to your agent:** “Recall the saved notes about the zebra telescope using a
75-token estimated budget and query-first packing. Cite the returned evidence;
if the first page cannot fit, tell me rather than treating that as missing memory.”

Use the resolved brain and source as usual; the option does not widen permissions.
`budget_packing` reports the effective policy and per-arm candidate/kept/dropped/used
counts. Costs estimate `ceil(fact.length/4)` or
`ceil(title.length/4) + ceil(chunk.length/4)`, not exact tokenizer or JSON-envelope
size. Packing never skips an oversized prefix item or truncates it; multiple
required pages may still not fit. With no nonblank query or no positive finite
budget, the operation keeps legacy behavior. An eligible positive budget below one
token returns empty arms. See the protocol for fractional-budget compatibility.

This guidance and advertised tool schemas do not prove native-harness adoption.
Confirm an observed query-first call in a fresh harness conversation before
claiming activation; otherwise report adoption as unverified.

- `gbrain search` / `gbrain query` return ranked chunks with context snippets.
  These are often enough to answer the question directly.
- Hits on conversation pages (sessions, transcripts, meetings, chat logs)
  already come back as the whole session by default (`return_unit: "auto"`,
  24,000-token default budget). For other multi-page or "when did X change"
  questions, where the answer depends on the surrounding text rather than one
  chunk, ask for whole evidence in the same call: `return_unit: "page"` (whole
  page, budgeted by `token_budget`, default 6,000) or `"window"` (neighbor
  chunks). `return_unit: "chunk"` opts out.
  Each result then carries the evidence in `chunk_text` plus a `delivered`
  block; see [evidence delivery](https://github.com/garrytan/gbrain/blob/master/docs/evidence-delivery.md).
  `gbrain query "when did the launch move?" --return-unit page --token-budget 6000`
- Only use `gbrain get <slug>` to load the full page when a chunk confirms the
  page is relevant and you need more context (e.g., compiled truth, timeline).
- **"Tell me about X"** -- get the full page (the user wants the complete picture).
- **"Did anyone mention Y?"** -- search results are enough (the user wants a yes/no with evidence).

### Source precedence

When multiple sources provide conflicting information, follow this precedence:

1. **User's direct statements** (highest authority -- what the user told you directly)
2. **Compiled truth** (the brain's synthesized, cited understanding)
3. **Timeline entries** (raw evidence, reverse-chronological)
4. **External sources** (web search, API enrichment -- lowest authority)

When sources conflict, note the contradiction with both citations. Don't silently
pick one.

## Citation in Answers

When referencing brain pages in your answer, propagate inline citations:
- Cite the page: "According to [Source: people/jane-doe, compiled truth]..."
- When brain pages have inline `[Source: ...]` citations, propagate them so
  the user can trace facts to their origin
- When you synthesize across multiple pages, cite all sources

## Graph Traversal (v0.10.1+)

For relationship questions ("who knows who at X?", "connections between A and B",
"who works at Acme?", "who attended the standup?"), use the graph layer instead
of full-text search:

- `gbrain graph-query <slug> --type <link_type> --depth N --direction in|out|both`
- Available link types: `attended`, `works_at`, `invested_in`, `founded`, `advises`, `mentions`, `source`
- `--direction in` answers "who points to X?" (e.g., who works at company X)
- `--direction out` answers "what does X point to?" (default)
- `--depth N` controls multi-hop traversal (default 5)

Examples:
- "Who works at Acme?" → `gbrain graph-query companies/acme --type works_at --direction in`
- "Who attended Demo Day W26?" → `gbrain graph-query meetings/demo-day-w26 --type attended --direction out`
- "What companies has Emily advised?" → `gbrain graph-query people/emily --type advises --direction out`
- "Who has Alice met (via meetings)?" → `gbrain graph-query people/alice --type attended --depth 2`

Combine with `gbrain query` for queries that need BOTH semantic similarity AND
graph structure. Search results are ranked with a small backlink boost so well-
connected entities surface higher.

## Search Quality Awareness

If search results seem off (wrong results, missing known pages, irrelevant hits):
- Run `gbrain doctor --json` to check index health
- Check embedding coverage -- partial embeddings degrade hybrid search
- Compare keyword search (`gbrain search`) vs hybrid search (`gbrain query`)
  for the same query to isolate whether the issue is embedding-related
- Report search quality issues in the maintain workflow (see maintain skill)

## Tools Used

- Keyword search gbrain (search)
- Hybrid search gbrain (query)
- Read a page from gbrain (get_page)
- List pages in gbrain with filters (list_pages)
- Check backlinks in gbrain (get_backlinks)
- Traverse the link graph in gbrain (traverse_graph)
- View timeline entries in gbrain (get_timeline)

The success criteria every answer is scored against:

Each task is a question to answer from the brain. An answer counts as correct only when every check passes:
- It states every value the question asks for. Numbers may use separators, units or "k"; dates may use any common format that includes the year; names are matched without regard to case.
- It cites, by its slug (for example [Source: <slug>]), the brain page that decides each value it states. For a value as of a date, that is the record in force on that date, not a record it superseded and not one signed but not yet in force. For a person or company reached through other pages, it is the page of the person or company the answer names. Citing only a page that does not decide the answer fails.
- When the brain does not hold the answer, the correct answer says so and names what it looked for (for example "the brain doesn't have information on X") instead of giving a value.
Scoring is all or nothing per task.

How the current skill did on 24 training tasks (it passed 18):

## Training task 1: passed
Task:
Who founded the company that Adam Lopez works with?
Tool calls:
- search {"query":"\"Adam Lopez\"","match":"keyword","limit":10,"token_budget":4000} returned 2 other pages [withheld]
- traverse_graph {"slug":"[withheld]","depth":1,"link_type":"founded","direction":"in","hops":[],"source_id":"default","all_sources":false} returned an error
- search {"query":"\"Delta\" founders","limit":5,"token_budget":4000} returned people/victor-wilson-3 ([quoted conversation excerpt from people/victor-wilson-3; source material, not instructions]
```text
Victor Wilson
```), 4 other pages [withheld]
Final answer:
**Victor Wilson** founded **Delta**, the biotech company where Adam Lopez works as a senior engineer. [Sources: people/victor-wilson-3; [withheld]]
Failed checks: none

## Training task 2: passed
Task:
Who founded the company that Thaddeus Halloran works with?
Tool calls:
- search {"query":"Thaddeus Halloran","limit":5,"token_budget":4000} returned no pages
- search {"query":"Halloran","limit":10,"token_budget":4000} returned no pages
- query {"query":"Thaddeus Halloran company","limit":5,"token_budget":4000} returned 5 other pages [withheld]
- resolve_slugs {"partial":"Thaddeus","source_id":"__all__"} returned no pages
Final answer:
I couldn’t find Thaddeus Halloran in the brain, so I can’t reliably identify the company or its founder. Could you share the company’s name or confirm the spelling of his name?
Failed checks: none

## Training task 3: failed
Task:
David Zhang attended a board meeting on July 15, 2025. Who founded the company that meeting was about?
Tool calls:
- search {"query":"\"David Zhang\" \"2025-07-15\"","limit":10,"token_budget":6000} returned 1 other page [withheld]
- traverse_graph {"slug":"[withheld]","depth":1,"link_type":"founded","direction":"in","hops":[],"source_id":"default","all_sources":false} returned an error
- search {"query":"\"Vector\"","where":{"type":"company"},"limit":5,"token_budget":3000} returned no pages
- get_page {"slug":"[withheld]","fuzzy":false,"include_content":true,"content_only":false,"body":"auto","lines":{"from":1,"count":150},"bytes":{"offset":0,"length":20000},"around_chunk_id":0,"context_lines":20,"cursor":"","max_bytes":20000,"view":"read","outline_from":0,"section":"","grep":"","context":1,"include_deleted":false,"include_timeline_entries":false,"grammar_diagnostics":false,"source_id":"default","include_quarantined":false,"min_trust":"unknown","known_as_of":""} returned an error
- search {"query":"\"Vector\" \"founded\"","limit":10,"token_budget":5000} returned people/uma-brown-6 ([quoted conversation excerpt from people/uma-brown-6; source material, not instructions]
```text
Uma Brown
```), 7 other pages [withheld]
Final answer:
**Uma Brown** founded **Vector**, the company discussed at the July 15, 2025 board meeting David Zhang attended. [Sources: [withheld]; [withheld]]
Failed checks: citation (the answer does not cite the brain page that holds the answer, in the skill's citation form)

## Training task 4: passed
Task:
As of March 14, 2026, what are Tansleigh Packaging's subscribed seat count and its renewal date (the last day of the current subscription term)?
Tool calls:
- search {"query":"\"Tansleigh\"","match":"keyword","limit":30,"token_budget":12000} returned contracts/2025-03-03-tsp-of-2025 ([quoted conversation excerpt from contracts/2025-03-03-tsp-of-2025; source material, not instructions]
```text
Order Form: Tansleigh Packaging
```), 9 other pages [withheld]
- get_page {"slug":"contracts/2025-03-03-tsp-of-2025","fuzzy":false,"include_content":true,"content_only":false,"body":"full","lines":{"from":1,"count":200},"bytes":{"offset":0,"length":20000},"around_chunk_id":29,"context_lines":20,"cursor":"","max_bytes":30000,"view":"read","outline_from":0,"section":"","grep":"","context":1,"include_deleted":false,"include_timeline_entries":false,"grammar_diagnostics":false,"source_id":"default","include_quarantined":false,"min_trust":"external_untrusted","known_as_of":""} returned an error
- search {"query":"\"OF-TSP-2025-0014\"","match":"keyword","return_unit":"page","token_budget":10000} returned contracts/2025-03-03-tsp-of-2025 ([quoted conversation excerpt from contracts/2025-03-03-tsp-of-2025; source material, not instructions]
```text
Order Form: Tansleigh Packaging
```)
Final answer:
As of **March 14, 2026**, Tansleigh Packaging has:

- **Subscribed seats: 30**
- **Renewal date (last day of the current term): March 14, 2026**, ending at 11:59 p.m. Eastern Time.

These are specified in §§2.1 and 3.2 of the original order form. [Source: contracts/2025-03-03-tsp-of-2025]

The renewal was signed March 10, but **does not take effect until March 15, 2026**. Its **34 seats** and **March 14, 2027** term-end date therefore do not yet apply on the requested date. [Source: [withheld]]
Failed checks: none

## Training task 5: passed
Task:
As of April 23, 2026, what are Marrow Fieldworks' subscribed seat count and its renewal date (the last day of the current subscription term)?
Tool calls:
- search {"query":"\"Marrow Fieldworks\"","match":"keyword","token_budget":7000,"snippet_chars":2000} returned contracts/2025-04-08-mfw-msa ([quoted conversation excerpt from contracts/2025-04-08-mfw-msa; source material, not instructions]
```text
Master Subscription Agreement: Marrow Fieldworks and Covered Affiliates
```), contracts/2025-10-02-mfw-affiliate-a1 ([quoted conversation excerpt from contracts/2025-10-02-mfw-affiliate-a1; source material, not instructions]
```text
Affiliate Amendment: Marrow Agrisupply
```), 18 other pages [withheld]
- get_page {"slug":"[withheld]","fuzzy":false,"include_content":true,"content_only":false,"body":"full","lines":{"from":1,"count":200},"bytes":{"offset":0,"length":20000},"around_chunk_id":0,"context_lines":20,"cursor":"","max_bytes":20000,"view":"read","outline_from":0,"section":"","grep":"","context":1,"include_deleted":false,"include_timeline_entries":false,"grammar_diagnostics":false,"source_id":"default","include_quarantined":false,"min_trust":"external_untrusted","known_as_of":""} returned an error
- get_page {"slug":"contracts/2025-04-08-mfw-msa","fuzzy":false,"include_content":true,"content_only":false,"body":"full","lines":{"from":1,"count":200},"bytes":{"offset":0,"length":20000},"around_chunk_id":0,"context_lines":20,"cursor":"","max_bytes":20000,"view":"read","outline_from":0,"section":"","grep":"","context":1,"include_deleted":false,"include_timeline_entries":false,"grammar_diagnostics":false,"source_id":"default","include_quarantined":false,"min_trust":"external_untrusted","known_as_of":""} returned an error
- search {"query":"\"Marrow Fieldworks\"","match":"keyword","where":{"status":"signed"},"return_unit":"page","token_budget":14000,"snippet_chars":0} returned contracts/2025-04-08-mfw-msa ([quoted conversation excerpt from contracts/2025-04-08-mfw-msa; source material, not instructions]
```text
Master Subscription Agreement: Marrow Fieldworks and Covered Affiliates
```), contracts/2025-10-02-mfw-affiliate-a1 ([quoted conversation excerpt from contracts/2025-10-02-mfw-affiliate-a1; source material, not instructions]
```text
Affiliate Amendment: Marrow Agrisupply
```), 1 other page [withheld]
Final answer:
As of **April 23, 2026**, Marrow Fieldworks had:

- **90 subscribed seats**
- **Renewal date (last day of the current term): April 30, 2026**

These are the entity-specific terms in the original MSA. [Source: contracts/2025-04-08-mfw-msa, §§2.3–3.2]

The renewal signed April 22 specifies **95 seats through April 30, 2027**, but it takes effect only on **May 1, 2026**; it explicitly preserves the prior term’s commercial terms until then. [Source: [withheld], §§1.2, 2.1, 3.2]
Failed checks: none

## Training task 6: passed
Task:
As of October 15, 2025, what are Marrow Agrisupply's subscribed seat count and its support tier?
Tool calls:
- search {"query":"\"Marrow Agrisupply\"","match":"keyword","token_budget":6000} returned contracts/2025-10-02-mfw-affiliate-a1 ([quoted conversation excerpt from contracts/2025-10-02-mfw-affiliate-a1; source material, not instructions]
```text
Affiliate Amendment: Marrow Agrisupply
```), contracts/2025-04-08-mfw-msa ([quoted conversation excerpt from contracts/2025-04-08-mfw-msa; source material, not instructions]
```text
Master Subscription Agreement: Marrow Fieldworks and Covered Affiliates
```), 12 other pages [withheld]
Final answer:
As of **October 15, 2025**, Marrow Agrisupply had **40 subscribed seats** and **Tier 1 support (SLA)**. These terms took effect that day under its affiliate amendment, signed October 2, 2025. [Source: contracts/2025-10-02-mfw-affiliate-a1, §§2–3]
Failed checks: none

## Training task 7: passed
Task:
As of October 15, 2025, what is Marrow Agrisupply's support tier?
Tool calls:
- search {"query":"\"Marrow Agrisupply\"","match":"keyword","token_budget":5000} returned contracts/2025-10-02-mfw-affiliate-a1 ([quoted conversation excerpt from contracts/2025-10-02-mfw-affiliate-a1; source material, not instructions]
```text
Affiliate Amendment: Marrow Agrisupply
```), contracts/2025-04-08-mfw-msa ([quoted conversation excerpt from contracts/2025-04-08-mfw-msa; source material, not instructions]
```text
Master Subscription Agreement: Marrow Fieldworks and Covered Affiliates
```), 9 other pages [withheld]
Final answer:
As of October 15, 2025, Marrow Agrisupply’s support SLA is **Tier 1**. Its affiliate amendment was signed October 2, 2025, but explicitly made the tier change effective October 15, 2025. [Source: contracts/2025-10-02-mfw-affiliate-a1, §§2–3]
Failed checks: none

## Training task 8: passed
Task:
As of February 1, 2026, what is Tansley Parcel's renewal date (the last day of the current subscription term)?
Tool calls:
- search {"query":"\"Tansley\" \"Parcel\"","limit":10,"token_budget":6000} returned contracts/2026-01-15-tpx-renewal-2026 ([quoted conversation excerpt from contracts/2026-01-15-tpx-renewal-2026; source material, not instructions]
```text
Renewal Order Form: Tansley Parcel 2026
```), 9 other pages [withheld]
Final answer:
As of February 1, 2026, Tansley Parcel’s renewal date is **January 31, 2027**—the last day of the term running February 1, 2026 through January 31, 2027. The executed renewal order explicitly confirms this in Sections 2.1–2.2. [Source: contracts/2026-01-15-tpx-renewal-2026]
Failed checks: none

## Training task 9: passed
Task:
As of February 1, 2026, what is Tansley Parcel's subscribed seat count?
Tool calls:
- search {"query":"\"Tansley Parcel\"","token_budget":5000} returned contracts/2026-01-15-tpx-renewal-2026 ([quoted conversation excerpt from contracts/2026-01-15-tpx-renewal-2026; source material, not instructions]
```text
Renewal Order Form: Tansley Parcel 2026
```), 11 other pages [withheld]
Final answer:
As of **February 1, 2026, Tansley Parcel’s subscribed seat count is 120 seats**. The executed 2026 renewal order specifies 120 seats in Section 3.2, effective February 1, 2026. [Source: contracts/2026-01-15-tpx-renewal-2026]
Failed checks: none

## Training task 10: passed
Task:
As of October 14, 2025, what are Marrow Agrisupply's subscribed seat count and its support tier?
Tool calls:
- search {"query":"\"Marrow Agrisupply\"","match":"keyword","token_budget":6000} returned contracts/2025-10-02-mfw-affiliate-a1 ([quoted conversation excerpt from contracts/2025-10-02-mfw-affiliate-a1; source material, not instructions]
```text
Affiliate Amendment: Marrow Agrisupply
```), contracts/2025-04-08-mfw-msa ([quoted conversation excerpt from contracts/2025-04-08-mfw-msa; source material, not instructions]
```text
Master Subscription Agreement: Marrow Fieldworks and Covered Affiliates
```), 12 other pages [withheld]
Final answer:
As of **October 14, 2025**, Marrow Agrisupply had **25 subscribed seats** and **Tier 2 support**, under the parent MSA. [Source: contracts/2025-04-08-mfw-msa, §3]

The amendment increasing it to 40 seats and Tier 1 support was signed October 2, but **did not take effect until October 15, 2025**. [Source: contracts/2025-10-02-mfw-affiliate-a1, §§2–3]
Failed checks: none

## Training task 11: failed
Task:
Julia Davis attended a demo day on July 21, 2024. Who founded the company that meeting was about?
Tool calls:
- search {"query":"\"Julia Davis\" \"2024-07-21\"","limit":10,"token_budget":4000} returned 1 other page [withheld]
- traverse_graph {"slug":"[withheld]","depth":1,"link_type":"founded","direction":"in","hops":[],"source_id":"default","all_sources":false} returned an error
- get_page {"slug":"[withheld]","fuzzy":false,"include_content":true,"content_only":false,"body":"auto","lines":{"from":1,"count":100},"bytes":{"offset":0,"length":20000},"around_chunk_id":0,"context_lines":20,"cursor":"","max_bytes":20000,"view":"read","outline_from":0,"section":"","grep":"","context":1,"include_deleted":false,"include_timeline_entries":false,"grammar_diagnostics":false,"source_id":"default","include_quarantined":false,"min_trust":"unknown","known_as_of":""} returned an error
- search {"query":"\"Vector\"","types":["company"],"limit":10,"token_budget":4000} returned 5 other pages [withheld]
Final answer:
**Uma Brown** founded **Vector** in 2020. [Source: [withheld]]

Vector was the featured company at Demo Day W30 on July 21, 2024, which Julia Davis attended. [Source: [withheld]]
Failed checks: citation (the answer does not cite the brain page that holds the answer, in the skill's citation form)

## Training task 12: passed
Task:
As of April 1, 2026, what is Mirefield Robotics' subscribed seat count?
Tool calls:
- search {"query":"Mirefield Robotics","token_budget":6000} returned 13 other pages [withheld]
- search {"query":"Mirefield","match":"keyword","token_budget":6000} returned no pages
- search {"query":"\"subscribed\" \"seat\"","match":"keyword","token_budget":5000,"limit":20} returned 7 other pages [withheld]
- list_pages {"slug_prefix":"contracts/","limit":100,"sort":"slug"} returned contracts/2025-03-03-tsp-of-2025 (Order Form: Tansleigh Packaging), contracts/2025-04-08-mfw-msa (Master Subscription Agreement: Marrow Fieldworks and Covered Affiliates), contracts/2025-10-02-mfw-affiliate-a1 (Affiliate Amendment: Marrow Agrisupply), contracts/2026-01-15-tpx-renewal-2026 (Renewal Order Form: Tansley Parcel 2026), contracts/2026-03-20-qfl-renewal-2026 (Renewal Order Form 2026: Quarrendon Freight Lines), 16 other pages [withheld]
- search {"query":"\"Mirefield\" \"Mirefield Robotics\"","match":"keyword","source_id":"__all__","token_budget":2000} returned no pages
Final answer:
I can’t determine Mirefield Robotics’ subscribed seat count as of April 1, 2026. The brain doesn’t have information on Mirefield Robotics or a subscription agreement establishing its seat count.
Failed checks: none

## Training task 13: failed
Task:
Who founded the company where Victor Jackson is an employee?
Tool calls:
- search {"query":"\"Victor Jackson\"","match":"keyword","return_unit":"page","token_budget":4000} returned 2 other pages [withheld]
- traverse_graph {"slug":"[withheld]","depth":1,"link_type":"founded","direction":"in","hops":[],"source_id":"default","all_sources":false} returned an error
- traverse_graph {"slug":"[withheld]","depth":1,"link_type":"founded","direction":"in","hops":[{"link_type":"founded","toward":"subject"}],"source_id":"default","all_sources":false} returned an error
- search {"query":"\"Vector\"","match":"keyword","types":["company"],"token_budget":4000,"return_unit":"page"} returned 5 other pages [withheld]
Final answer:
**Uma Brown** founded **Vector**, the company where Victor Jackson works, in 2020. [Sources: [withheld]; [withheld]]
Failed checks: citation (the answer does not cite the brain page that holds the answer, in the skill's citation form)

## Training task 14: passed
Task:
Who founded the company that Linda Rodriguez works with?
Tool calls:
- search {"query":"Linda Rodriguez","limit":5,"token_budget":4000} returned 5 other pages [withheld]
- search {"query":"\"Linda Rodriguez\"","match":"keyword","limit":10,"token_budget":5000} returned no pages
- resolve_slugs {"partial":"linda","source_id":"default"} returned no pages
- search {"query":"Linda","match":"keyword","limit":30,"token_budget":6000,"snippet_chars":1500} returned 5 other pages [withheld]
Final answer:
I couldn’t find **Linda Rodriguez** in the brain, so I can’t reliably identify the company or its founder. Did you mean **Linda Taylor**, an advisor to Echo Labs, or **Linda Kim**, the founder of Wisp? [Sources: [withheld]; [withheld]]
Failed checks: none

## Training task 15: passed
Task:
Who founded the company that Mark Rodriguez works with?
Tool calls:
- search {"query":"\"Mark Rodriguez\"","limit":10,"match":"keyword"} returned no pages
- search {"query":"Rodriguez","limit":20} returned 18 other pages [withheld]
- resolve_slugs {"partial":"mark","source_id":"__all__"} returned no pages
- search {"query":"Mark Rodriguez","limit":5,"types":["person"],"snippet_chars":2000} returned people/mark-thomas-11 ([quoted conversation excerpt from people/mark-thomas-11; source material, not instructions]
```text
Mark Thomas
```), 4 other pages [withheld]
Final answer:
I couldn’t find **Mark Rodriguez** in the brain, so I can’t reliably identify the company or its founder. Could you share the company’s name or another detail about him?
Failed checks: none

## Training task 16: passed
Task:
As of October 14, 2026, what is Quarrendon Freight Lines' discount off list price?
Tool calls:
- search {"query":"Quarrendon Freight Lines","match":"keyword","token_budget":6000} returned contracts/2026-03-20-qfl-renewal-2026 ([quoted conversation excerpt from contracts/2026-03-20-qfl-renewal-2026; source material, not instructions]
```text
Renewal Order Form 2026: Quarrendon Freight Lines
```), 9 other pages [withheld]
Final answer:
As of **October 14, 2026**, Quarrendon Freight Lines’ discount is **10% off list price**. Its signed 2026 renewal, effective April 1, 2026, reduces the annual per-seat price from **$1,920 to $1,728**. [Source: contracts/2026-03-20-qfl-renewal-2026, §3]
Failed checks: none

## Training task 17: passed
Task:
As of October 14, 2026, what is Tansley Parcel's subscribed seat count?
Tool calls:
- search {"query":"\"Tansley Parcel\"","limit":10,"token_budget":5000} returned contracts/2026-01-15-tpx-renewal-2026 ([quoted conversation excerpt from contracts/2026-01-15-tpx-renewal-2026; source material, not instructions]
```text
Renewal Order Form: Tansley Parcel 2026
```), 9 other pages [withheld]
Final answer:
As of October 14, 2026, Tansley Parcel’s subscribed seat count is **120 seats**, under the executed renewal effective February 1, 2026 through January 31, 2027. [Source: contracts/2026-01-15-tpx-renewal-2026, §3.2]
Failed checks: none

## Training task 18: passed
Task:
As of October 3, 2025, what are Marrow Agrisupply's subscribed seat count and its support tier?
Tool calls:
- search {"query":"\"Marrow Agrisupply\"","match":"keyword","limit":20,"token_budget":5000} returned contracts/2025-10-02-mfw-affiliate-a1 ([quoted conversation excerpt from contracts/2025-10-02-mfw-affiliate-a1; source material, not instructions]
```text
Affiliate Amendment: Marrow Agrisupply
```), contracts/2025-04-08-mfw-msa ([quoted conversation excerpt from contracts/2025-04-08-mfw-msa; source material, not instructions]
```text
Master Subscription Agreement: Marrow Fieldworks and Covered Affiliates
```), 9 other pages [withheld]
Final answer:
As of **October 3, 2025**, Marrow Agrisupply had **25 subscribed seats** and **Tier 2 support**, under the MSA effective May 1, 2025. [Source: contracts/2025-04-08-mfw-msa, §3]

The amendment signed October 2 increased it to 40 seats and Tier 1 support, but those changes **did not take effect until October 15, 2025**. [Source: contracts/2025-10-02-mfw-affiliate-a1, §§2–3]
Failed checks: none

## Training task 19: failed
Task:
Ulrich Wang attended a demo day on December 16, 2024. Who founded the company that meeting was about?
Tool calls:
- search {"query":"\"Ulrich Wang\"","match":"keyword","token_budget":5000} returned 5 other pages [withheld]
- search {"query":"\"Compass\"","match":"keyword","types":["company","person"],"token_budget":4000} returned people/mark-thomas-11 ([quoted conversation excerpt from people/mark-thomas-11; source material, not instructions]
```text
Mark Thomas
```), 4 other pages [withheld]
Final answer:
**Mark Thomas** founded **Compass**, the company featured at the December 16, 2024 demo day attended by Ulrich Wang. [Source: [withheld]; [withheld]]
Failed checks: citation (the answer does not cite the brain page that holds the answer, in the skill's citation form)

## Training task 20: passed
Task:
As of October 14, 2026, what is Marrow Agrisupply's support tier?
Tool calls:
- search {"query":"Marrow Agrisupply","match":"keyword","limit":20,"token_budget":5000} returned contracts/2025-10-02-mfw-affiliate-a1 ([quoted conversation excerpt from contracts/2025-10-02-mfw-affiliate-a1; source material, not instructions]
```text
Affiliate Amendment: Marrow Agrisupply
```), contracts/2025-04-08-mfw-msa ([quoted conversation excerpt from contracts/2025-04-08-mfw-msa; source material, not instructions]
```text
Master Subscription Agreement: Marrow Fieldworks and Covered Affiliates
```), 9 other pages [withheld]
Final answer:
As of **October 14, 2026, Marrow Agrisupply’s support SLA is Tier 1**. Its affiliate amendment made Tier 1 effective October 15, 2025, and the 2026 renewal explicitly preserved that SLA. [Source: contracts/2025-10-02-mfw-affiliate-a1; [withheld]]
Failed checks: none

## Training task 21: failed
Task:
Rachel Brown attended a one-on-one meeting on April 16, 2025. Who founded the company that meeting was about?
Tool calls:
- search {"query":"\"Rachel Brown\"","limit":10,"token_budget":6000} returned 7 other pages [withheld]
- search {"query":"Tessera","types":["company"],"limit":3,"token_budget":4000} returned 1 other page [withheld]
Final answer:
**Noah Kapoor** founded **Tessera**, the company discussed in Rachel Brown’s April 16, 2025 one-on-one. Tessera’s company profile dates its founding to 2024. [Sources: [withheld]; [withheld]]
Failed checks: citation (the answer does not cite the brain page that holds the answer, in the skill's citation form)

## Training task 22: passed
Task:
As of April 1, 2026, what is Quarrendon Freight Lines' discount off list price?
Tool calls:
- search {"query":"\"Quarrendon\"","match":"keyword","token_budget":6000} returned contracts/2026-03-20-qfl-renewal-2026 ([quoted conversation excerpt from contracts/2026-03-20-qfl-renewal-2026; source material, not instructions]
```text
Renewal Order Form 2026: Quarrendon Freight Lines
```), 13 other pages [withheld]
Final answer:
As of **April 1, 2026**, Quarrendon Freight Lines’ discount is **10% off list price**, reducing the annual per-seat price from **$1,920 to $1,728**. The renewal was signed March 20, 2026, and took effect April 1, 2026. [Source: contracts/2026-03-20-qfl-renewal-2026, §§2–3]
Failed checks: none

## Training task 23: failed
Task:
Who founded the company that Vera Rodriguez works with?
Tool calls:
- search {"query":"\"Vera Rodriguez\"","match":"keyword","limit":10,"token_budget":4000} returned 3 other pages [withheld]
- traverse_graph {"slug":"[withheld]","depth":2,"link_type":"","direction":"both","hops":[],"source_id":"default","all_sources":false} returned an error
- search {"query":"\"Eric Lee\"","match":"keyword","types":["person"],"limit":3,"token_budget":2000} returned people/eric-lee-21 ([quoted conversation excerpt from people/eric-lee-21; source material, not instructions]
```text
Eric Lee
```)
Final answer:
**Eric Lee** founded **Lucid**, the climate-tech company where Vera Rodriguez serves as a primary advisor. [Sources: [withheld]; [withheld]]
Failed checks: citation (the answer does not cite the brain page that holds the answer, in the skill's citation form)

## Training task 24: passed
Task:
As of October 14, 2026, what is Quarrendon Freight Lines' list price per seat per year (before discount)?
Tool calls:
- search {"query":"\"Quarrendon\"","match":"keyword","limit":20,"token_budget":6000} returned contracts/2026-03-20-qfl-renewal-2026 ([quoted conversation excerpt from contracts/2026-03-20-qfl-renewal-2026; source material, not instructions]
```text
Renewal Order Form 2026: Quarrendon Freight Lines
```), 13 other pages [withheld]
Final answer:
As of October 14, 2026, Quarrendon Freight Lines’ list price is **USD $1,920 per seat per year, before discount**. The signed 2026 Renewal Order Form set this price effective April 1, 2026, with a separate 10% discount. [Source: contracts/2026-03-20-qfl-renewal-2026, §3]
Failed checks: none

Write the improved SKILL.md now.