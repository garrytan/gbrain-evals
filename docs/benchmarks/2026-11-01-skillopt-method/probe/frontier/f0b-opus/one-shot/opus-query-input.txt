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

How the current skill did on 24 training tasks (it passed 19):

## Training task 1: failed
Task:
Who founded the company that Adam Lopez works with?
Tool calls:
- search {"query":"Adam Lopez"} returned 4 other pages [withheld]
- get_page {"slug":"[withheld]"} returned 1 other page [withheld]
- get_backlinks {"slug":"[withheld]"} returned no pages
Final answer:
Adam Lopez works at **Delta** (a biotech company), and Delta's company page says it was **founded by Victor Wilson**.

- Adam Lopez is a senior engineer at Delta and joined in early 2022 [Source: [withheld]].
- Delta was founded in 2022 by Victor Wilson, who spent nearly ten years in academic research before starting it. The company was incorporated on 2022-03-07 with Wilson as founding CEO, and he still runs it as CEO [Source: [withheld], compiled truth + timeline].
- David Zhang helped get the company started. He met Wilson at a conference in November 2021, which led to the decision to turn Wilson's research into a company. Zhang is described as an investor who co-led the seed round, not as a co-founder [Source: [withheld]].

**Where the notes disagree:**
- **Wilson's role:** A Demo Day write-up from April 2024 lists Victor Wilson among the investors asking questions, and has David Zhang giving Delta's pitch. That's hard to square with Wilson being Delta's founder and CEO [Source: [withheld]].
- **Where Delta is and what it does:** The company page says Delta works on protein engineering and is based in Boston–Cambridge. Adam's page and the Demo Day notes describe synthetic biology (engineered microbes) and a lab in South San Francisco.
- **Adam's role:** At that same Demo Day, Adam Lopez also seems to be on the investor side, asking about Delta's team.

The company page gives the clearest answer, so I'd go with Victor Wilson as founder. Still, these conflicts could mean some notes mix up different "Delta" companies or people.
Failed checks: citation (the answer does not cite the brain page that holds the answer, in the skill's citation form)

## Training task 2: passed
Task:
Who founded the company that Thaddeus Halloran works with?
Tool calls:
- search {"query":"Thaddeus Halloran"} returned no pages
- resolve_slugs {"partial":"halloran"} returned no pages
- query {"query":"Thaddeus Halloran works with company"} returned 21 other pages [withheld]
- search {"query":"\"Thaddeus\" OR \"Halloran\"","match":"keyword","source_id":"__all__"} returned no pages
- resolve_slugs {"partial":"thaddeus","source_id":"__all__"} returned no pages
Final answer:
I couldn't find anyone named Thaddeus Halloran in your brain, so I can't tell you which company he works with or who founded it.

Here's what I searched:
- **Full name:** no results.
- **"Thaddeus" or "Halloran" on their own,** across every source: no results.
- **Partial page-name matches** for "halloran" and "thaddeus": nothing came back.
- **A broader topic search** ("Thaddeus Halloran works with company"): only weak, unrelated matches like Cipher, Drift, Jolt and Umbra. None of them mention him.

Search didn't report any problems, so this looks like a real gap rather than a search failure. You may not have saved any notes on him yet, or he could be listed under a different spelling or nickname.

If you know the company's name or another spelling of his, I can search for that. The company's page will probably say who founded it.
Failed checks: none

## Training task 3: failed
Task:
David Zhang attended a board meeting on July 15, 2025. Who founded the company that meeting was about?
Tool calls:
- search {"query":"David Zhang board meeting 2025-07-15"} returned 19 other pages [withheld]
- resolve_slugs {"partial":"david-zhang"} returned no pages
- get_page {"slug":"[withheld]"} returned 1 other page [withheld]
- traverse_graph {"slug":"[withheld]","link_type":"founded","direction":"in","depth":1} returned no pages
Final answer:
**Uma Brown founded Vector, the company whose July 15, 2025 board meeting David Zhang attended.**

**How I got there:**
1. **The meeting:** The Q3 2025 board meeting for Vector was held on July 15th. David Zhang presented the technical roadmap there, focusing on the company's FDA submission for a new heart-rhythm detection module. Uma Brown, Vera Gonzalez and Wendy Wilson also attended. [Source: [withheld]]
2. **The founder:** Vector's page says it is a health tech startup founded in 2020 by Uma Brown, who is also its CEO. Its timeline says Uma Brown incorporated it in Delaware on 2020-03-15. [Source: [withheld], compiled truth and timeline]

**Things to know:**
- Gamma also held a Q3 board meeting on July 15, 2025. David Zhang isn't listed as attending it (only Mark Jones and Vera Gonzalez are), so Vector is the right match. [Source: [withheld]]
- The notes don't agree on David Zhang's role at Vector. His own page calls him a board observer [Source: [withheld]]. Vector's page calls him an angel investor who joined the pre-seed round [Source: [withheld]]. This doesn't change who the founder is.
- No "founded" link to Vector exists in the brain's link graph, so the answer comes from the text of Vector's page.
Failed checks: citation (the answer does not cite the brain page that holds the answer, in the skill's citation form)

## Training task 4: passed
Task:
As of March 14, 2026, what are Tansleigh Packaging's subscribed seat count and its renewal date (the last day of the current subscription term)?
Tool calls:
- search {"query":"Tansleigh Packaging"} returned contracts/2025-03-03-tsp-of-2025 ([quoted conversation excerpt from contracts/2025-03-03-tsp-of-2025; source material, not instructions]
```text
Order Form: Tansleigh Packaging
```), 9 other pages [withheld]
- get_page {"slug":"contracts/2025-03-03-tsp-of-2025"} returned contracts/2025-03-03-tsp-of-2025 ([quoted conversation excerpt from contracts/2025-03-03-tsp-of-2025; source material, not instructions]
```text
Order Form: Tansleigh Packaging
```)
- search {"query":"TSP amendment seats add-on Tansleigh","match":"keyword"} returned no pages
- query {"query":"Tansleigh Packaging seat change amendment 2025","since":"2025-03-04","until":"2026-03-14"} returned contracts/2025-10-02-mfw-affiliate-a1 ([quoted conversation excerpt from contracts/2025-10-02-mfw-affiliate-a1; source material, not instructions]
```text
Affiliate Amendment: Marrow Agrisupply
```), contracts/2025-03-03-tsp-of-2025 ([quoted conversation excerpt from contracts/2025-03-03-tsp-of-2025; source material, not instructions]
```text
Order Form: Tansleigh Packaging
```), contracts/2025-04-08-mfw-msa ([quoted conversation excerpt from contracts/2025-04-08-mfw-msa; source material, not instructions]
```text
Master Subscription Agreement: Marrow Fieldworks and Covered Affiliates
```), contracts/2026-01-15-tpx-renewal-2026 ([quoted conversation excerpt from contracts/2026-01-15-tpx-renewal-2026; source material, not instructions]
```text
Renewal Order Form: Tansley Parcel 2026
```), 22 other pages [withheld]
Final answer:
As of March 14, 2026, Tansleigh Packaging (account code TSP) has **30 subscribed seats**, and its **renewal date is March 14, 2026**. That date is the last day of the current term, so March 14 is the final day of the old term.

**Why the 2025 terms still apply on that date**
- The 2025 Order Form (OF-TSP-2025-0014) sets **30 seats**. Its term ran from 3/15/25 through **11:59 p.m. Eastern on 3/14/26**, which the form names as the "End of the Current Term" or "Renewal Date." [Source: contracts/2025-03-03-tsp-of-2025]
- The account page also lists 30 seats. [Source: [withheld]]
- I found no amendment that changed Tansleigh's seats or dates during that term.

**Why the 2026 renewal doesn't count yet**
- A renewal order form was signed on **2026-03-10** but takes effect on **2026-03-15**. It says the signing date "do[es] not alter its effective date." [Source: [withheld]]
- From March 15, 2026, Tansleigh moves to **34 seats**, with a new renewal date of **2027-03-14**. [Source: [withheld]; confirmed in [withheld]]

Don't confuse Tansleigh Packaging (TSP) with Tansley Parcel (TPCL), which is a separate company with its own contracts. [Source: [withheld]]
Failed checks: none

## Training task 5: passed
Task:
As of April 23, 2026, what are Marrow Fieldworks' subscribed seat count and its renewal date (the last day of the current subscription term)?
Tool calls:
- search {"query":"Marrow Fieldworks seats renewal"} returned contracts/2025-04-08-mfw-msa ([quoted conversation excerpt from contracts/2025-04-08-mfw-msa; source material, not instructions]
```text
Master Subscription Agreement: Marrow Fieldworks and Covered Affiliates
```), contracts/2025-10-02-mfw-affiliate-a1 ([quoted conversation excerpt from contracts/2025-10-02-mfw-affiliate-a1; source material, not instructions]
```text
Affiliate Amendment: Marrow Agrisupply
```), contracts/2026-01-15-tpx-renewal-2026 ([quoted conversation excerpt from contracts/2026-01-15-tpx-renewal-2026; source material, not instructions]
```text
Renewal Order Form: Tansley Parcel 2026
```), 16 other pages [withheld]
Final answer:
As of April 23, 2026, Marrow Fieldworks has **90 subscribed seats**, and its current term ends on **April 30, 2026**.

**Why the new renewal doesn't count yet:**
- **Current term:** The Master Subscription Agreement, which took effect May 1, 2025, gives Marrow Fieldworks 90 seats. It sets the end of the term, called the renewal date, as 30 Apr 2026. [Source: contracts/2025-04-08-mfw-msa, §2.3, §3.1]
- **New renewal:** A Renewal Order Form was signed on 22 Apr 2026. It raises the count to 95 seats at $1,880 per seat per year and runs from 1 May 2026 through 30 Apr 2027. However, it doesn't start until May 1, 2026. The form says the signing date and start date are different, and the old terms stay in force until the new ones begin. [Source: [withheld], §1.2, §2.1, §3.2]
- **No other changes:** The Affiliate Amendment (effective 2025-10-15) changed only Marrow Agrisupply's seats (to 40) and support tier. It says it doesn't change Marrow Fieldworks' terms. [Source: contracts/2025-10-02-mfw-affiliate-a1]

**Records that seem to disagree:** A CRM note dated 2026-04-23 says "Renewal completed: 95 seats… through 2027-04-30" [Source: [withheld]]. The account page (updated 2026-09-15) also lists 95 seats [Source: [withheld]]. Both describe the signed renewal, which starts May 1, 2026, not the term in force on April 23. Starting May 1, 2026, the answer becomes 95 seats with a renewal date of April 30, 2027.
Failed checks: none

## Training task 6: passed
Task:
As of October 15, 2025, what are Marrow Agrisupply's subscribed seat count and its support tier?
Tool calls:
- search {"query":"Marrow Agrisupply"} returned contracts/2025-10-02-mfw-affiliate-a1 ([quoted conversation excerpt from contracts/2025-10-02-mfw-affiliate-a1; source material, not instructions]
```text
Affiliate Amendment: Marrow Agrisupply
```), contracts/2025-04-08-mfw-msa ([quoted conversation excerpt from contracts/2025-04-08-mfw-msa; source material, not instructions]
```text
Master Subscription Agreement: Marrow Fieldworks and Covered Affiliates
```), 18 other pages [withheld]
Final answer:
As of October 15, 2025, Marrow Agrisupply has **40 subscribed seats** and is on **support SLA Tier 1**.

- **Source:** The affiliate amendment was signed on October 2, 2025 and says these two terms change on October 15, 2025. The signing date doesn't make them apply any earlier. Only the seat count and support tier changed; everything else stays under the parent contract with Marrow Fieldworks. [Source: contracts/2025-10-02-mfw-affiliate-a1]
- **Before October 15:** The parent contract had Marrow Agrisupply at 25 seats on Tier 2 from May 1, 2025. [Source: contracts/2025-04-08-mfw-msa]
- **Other notes agree:** June Osei-Lark's October 2, 2025 email says the same: 40 seats and Tier 1 from October 15. The account page also lists 40 seats on Tier 1. [Sources: [withheld]; [withheld]]

**One conflicting note:** A team weekly update from May 11, 2026 says Marrow Agrisupply is on Tier 2, like its parent company. That doesn't fit the signed amendment. Also, the April 2026 renewal says it left Marrow Agrisupply's seats and support terms as the amendment set them. [Source: [withheld]; [withheld]] That note is probably wrong.
Failed checks: none

## Training task 7: passed
Task:
As of October 15, 2025, what is Marrow Agrisupply's support tier?
Tool calls:
- search {"query":"Marrow Agrisupply support tier"} returned contracts/2025-10-02-mfw-affiliate-a1 ([quoted conversation excerpt from contracts/2025-10-02-mfw-affiliate-a1; source material, not instructions]
```text
Affiliate Amendment: Marrow Agrisupply
```), contracts/2025-04-08-mfw-msa ([quoted conversation excerpt from contracts/2025-04-08-mfw-msa; source material, not instructions]
```text
Master Subscription Agreement: Marrow Fieldworks and Covered Affiliates
```), 13 other pages [withheld]
Final answer:
On October 15, 2025, Marrow Agrisupply was on **Support SLA Tier 1**. That was the first day of that tier.

**How it changed:**
- **Before (Tier 2):** The parent agreement with Marrow Fieldworks took effect May 1, 2025. It put Marrow Agrisupply on Tier 2 with 25 seats. [Source: contracts/2025-04-08-mfw-msa]
- **Change (Tier 1):** An amendment for Marrow Agrisupply alone was signed on 2025-10-02 and took effect on **2025-10-15**. It moved the account to Tier 1 and 40 seats. The amendment says signing it on Oct 2 didn't make the new tier apply before Oct 15. [Source: contracts/2025-10-02-mfw-affiliate-a1]
- **Other records agree:** June Osei-Lark's email from the signing date says the account "moves to 40 seats and SLA Tier 1 from October 15." [Source: [withheld]] The current account page also lists 40 seats on SLA Tier 1. [Source: [withheld]]

**Later events:** Marrow Fieldworks renewed in April 2026, and the CRM note says Marrow Agrisupply's seats and support tier weren't changed. [Source: [withheld]] I found nothing that changed the tier between October 2 and October 15, 2025.
Failed checks: none

## Training task 8: passed
Task:
As of February 1, 2026, what is Tansley Parcel's renewal date (the last day of the current subscription term)?
Tool calls:
- search {"query":"Tansley Parcel renewal"} returned contracts/2026-01-15-tpx-renewal-2026 ([quoted conversation excerpt from contracts/2026-01-15-tpx-renewal-2026; source material, not instructions]
```text
Renewal Order Form: Tansley Parcel 2026
```), 5 other pages [withheld]
- search {"query":"Tansley Parcel amendment term extension co-term"} returned contracts/2026-01-15-tpx-renewal-2026 ([quoted conversation excerpt from contracts/2026-01-15-tpx-renewal-2026; source material, not instructions]
```text
Renewal Order Form: Tansley Parcel 2026
```), contracts/2025-10-02-mfw-affiliate-a1 ([quoted conversation excerpt from contracts/2025-10-02-mfw-affiliate-a1; source material, not instructions]
```text
Affiliate Amendment: Marrow Agrisupply
```), 18 other pages [withheld]
Final answer:
As of February 1, 2026, Tansley Parcel's renewal date is **January 31, 2027**.

**Why:** The 2026 Renewal Order Form was signed on January 15, 2026 and took effect on February 1, 2026. That means February 1 is the first day of the new term. The term runs from February 1, 2026 through 11:59 p.m. Central on January 31, 2027. The form says that date "constitutes the end of the current term and the scheduled renewal date." It also covers 120 seats of Pemberline Dock. [Source: contracts/2026-01-15-tpx-renewal-2026]

**Other records that agree:**
- On January 16, 2026, Pree Sundaram sent a recap email. Her first note gave the renewal date as 2027-02-28. Twenty minutes later she corrected it: "the next renewal date is 2027-01-31, not 2027-02-28," and asked June to use 2027-01-31 for the billing handoff. The February date was a mistake, not a real conflict. [Source: [withheld]]
- The account page, updated September 15, 2026, also lists the renewal as January 31, 2027. [Source: [withheld]]

**A date that could cause confusion:** January 31, 2026 was the end of the *previous* term. That term started under the original subscription agreement, effective February 1, 2025 with 110 seats. [Source: [withheld]] The January 5, 2026 weekly update calls the renewal "due by 31 Jan 2026" because it was written before the new form was signed. [Source: [withheld]] By February 1, 2026, that term had ended and the new one had started.
Failed checks: none

## Training task 9: passed
Task:
As of February 1, 2026, what is Tansley Parcel's subscribed seat count?
Tool calls:
- search {"query":"Tansley Parcel seat count"} returned contracts/2026-01-15-tpx-renewal-2026 ([quoted conversation excerpt from contracts/2026-01-15-tpx-renewal-2026; source material, not instructions]
```text
Renewal Order Form: Tansley Parcel 2026
```), 10 other pages [withheld]
- list_pages {"slug_prefix":"contracts/"} returned contracts/2026-03-20-qfl-renewal-2026 (Renewal Order Form 2026: Quarrendon Freight Lines), contracts/2026-01-15-tpx-renewal-2026 (Renewal Order Form: Tansley Parcel 2026), contracts/2025-10-02-mfw-affiliate-a1 (Affiliate Amendment: Marrow Agrisupply), contracts/2025-04-08-mfw-msa (Master Subscription Agreement: Marrow Fieldworks and Covered Affiliates), contracts/2025-03-03-tsp-of-2025 (Order Form: Tansleigh Packaging), 16 other pages [withheld]
Final answer:
As of February 1, 2026, Tansley Parcel has **120 subscribed seats** of Pemberline Dock.

- **Where the number comes from:** The 2026 Renewal Order Form was signed on January 15, 2026 and took effect on **February 1, 2026**. Section 3.2 says "Subscribed Seats: 120 seats." The renewal term runs to January 31, 2027. [Source: contracts/2026-01-15-tpx-renewal-2026]
- **Other records agree:** Pree's recap email from January 16, 2026 also says 120 seats, at $[withheld] per seat per year. [Source: [withheld]] The account page also lists 120 seats. [Source: [withheld]]
- **What it replaced:** The first agreement was for 110 seats and ended January 31, 2026. February 1 is the first day the 120-seat renewal applies. [Source: [withheld]]

**Higher counts you may see:**
- A March 3, 2026 email from Lev says "Tansley Parcel is at 125 seats" and asks for a true-up. That's a request about how many seats they're actually using, not a contract change, and it came after February 1. [Source: [withheld]]
- An August 2026 CRM note says a seat true-up is expected at renewal. [Source: [withheld]]

I found no signed amendment that changed the 120-seat count. Also, "Tansleigh Packaging" is a different customer, so its contracts don't apply here.
Failed checks: none

## Training task 10: passed
Task:
As of October 14, 2025, what are Marrow Agrisupply's subscribed seat count and its support tier?
Tool calls:
- search {"query":"Marrow Agrisupply"} returned contracts/2025-10-02-mfw-affiliate-a1 ([quoted conversation excerpt from contracts/2025-10-02-mfw-affiliate-a1; source material, not instructions]
```text
Affiliate Amendment: Marrow Agrisupply
```), contracts/2025-04-08-mfw-msa ([quoted conversation excerpt from contracts/2025-04-08-mfw-msa; source material, not instructions]
```text
Master Subscription Agreement: Marrow Fieldworks and Covered Affiliates
```), 18 other pages [withheld]
- search {"query":"Agrisupply seats amendment change order 2025","types":["deal"]} returned contracts/2025-10-02-mfw-affiliate-a1 ([quoted conversation excerpt from contracts/2025-10-02-mfw-affiliate-a1; source material, not instructions]
```text
Affiliate Amendment: Marrow Agrisupply
```), contracts/2025-03-03-tsp-of-2025 ([quoted conversation excerpt from contracts/2025-03-03-tsp-of-2025; source material, not instructions]
```text
Order Form: Tansleigh Packaging
```), contracts/2026-01-15-tpx-renewal-2026 ([quoted conversation excerpt from contracts/2026-01-15-tpx-renewal-2026; source material, not instructions]
```text
Renewal Order Form: Tansley Parcel 2026
```), contracts/2026-03-20-qfl-renewal-2026 ([quoted conversation excerpt from contracts/2026-03-20-qfl-renewal-2026; source material, not instructions]
```text
Renewal Order Form 2026: Quarrendon Freight Lines
```), 13 other pages [withheld]
Final answer:
On October 14, 2025, Marrow Agrisupply had **25 subscribed seats** and **SLA Tier 2** support. The 40-seat, Tier 1 terms you may see elsewhere didn't start until the next day.

**Terms in force on Oct 14, 2025:** The Master Subscription Agreement with Marrow Fieldworks covers Marrow Agrisupply as an affiliate. It took effect May 1, 2025 and lists Marrow Agrisupply at 25 seats on Support SLA Tier 2 [Source: contracts/2025-04-08-mfw-msa, §3.1].

**Why the amendment doesn't apply yet:** The Affiliate Amendment changes Marrow Agrisupply to 40 seats and Tier 1. It was signed on 2025-10-02 but takes effect on **2025-10-15**. It says the signatures "do not make the amended seat count or support SLA tier effective before 2025-10-15" [Source: contracts/2025-10-02-mfw-affiliate-a1, §2–3]. The email announcing the signing also says the move to 40 seats and Tier 1 starts "from October 15" [Source: [withheld]]. I didn't find any other signed change to Marrow Agrisupply's seats or tier between May 1 and October 14, 2025.

**Things that could cause confusion:**
- The account page shows "40 seats on SLA Tier 1" [Source: [withheld]]. That's the current figure as of its 2026-09-15 update, not the figure on Oct 14, 2025.
- A team update from 2026-05-11 says Marrow Agrisupply "is on SLA Tier 2 like the parent" [Source: [withheld]]. That's out of date by then. The amendment had already moved it to Tier 1, and the 2026 renewal left its seats and SLA as the amendment set them [Source: [withheld], §3.3, §4.1].
Failed checks: none

## Training task 11: passed
Task:
Julia Davis attended a demo day on July 21, 2024. Who founded the company that meeting was about?
Tool calls:
- search {"query":"Julia Davis demo day 2024-07-21"} returned 19 other pages [withheld]
- resolve_slugs {"partial":"julia-davis"} returned no pages
- get_page {"slug":"[withheld]"} returned 1 other page [withheld]
- get_backlinks {"slug":"[withheld]"} returned no pages
- get_page {"slug":"people/uma-brown-6"} returned people/uma-brown-6 ([quoted conversation excerpt from people/uma-brown-6; source material, not instructions]
```text
Uma Brown
```)
Final answer:
**Uma Brown founded Vector, the company featured at that demo day.**

**How I got there:**
1. **The meeting:** Demo Day W30, July 21, 2024 (`[withheld]`). Julia Davis led it and gave the opening remarks. The featured company was **Vector**, which pitched its health tech platform.
2. **The founder:** Vector's page says it's "a health tech startup founded… by Uma Brown," and its timeline says she incorporated it in Delaware (`[withheld]`). Her own page also calls her "the founder and CEO of Vector" (`people/uma-brown-6`).

**Where the notes disagree:**
- **Her role at the demo day:** The meeting notes say Uma Brown was there "as a potential lead investor," pushing on unit economics and asking for a follow-up with the Vector team. That doesn't fit her being the founder and CEO. Either the meeting notes have her role wrong, or they mean someone else with the same name.
- **When Vector was founded:** The company page says 2020 (incorporated 2020-03-15). Her page says she incorporated it on 2022-09-14 ("late 2022").
- **Other founders:** The meeting notes mention "the founders" and "the Vector founding team" (plural), and a Vector CTO. But the brain doesn't name any co-founder, so Uma Brown is the only founder on record.
Failed checks: none

## Training task 12: passed
Task:
As of April 1, 2026, what is Mirefield Robotics' subscribed seat count?
Tool calls:
- search {"query":"Mirefield Robotics seat count"} returned contracts/2025-10-02-mfw-affiliate-a1 ([quoted conversation excerpt from contracts/2025-10-02-mfw-affiliate-a1; source material, not instructions]
```text
Affiliate Amendment: Marrow Agrisupply
```), 17 other pages [withheld]
- search {"query":"Mirefield","match":"keyword"} returned no pages
- resolve_slugs {"partial":"mirefield"} returned no pages
- search {"query":"Mirefield Robotics","match":"keyword"} returned no pages
- list_pages {"slug_prefix":"accounts/","sort":"slug"} returned 8 other pages [withheld]
- get_page {"slug":"[withheld]"} returned 1 other page [withheld]
Final answer:
I couldn't find any record of Mirefield Robotics, so I can't tell you its seat count as of April 1, 2026.

**What I searched:**
- Exact keyword searches for "Mirefield" and "Mirefield Robotics" returned nothing. These were plain misses, not caused by a search problem.
- A fuzzy lookup of page names found nothing either.
- None of the customer account pages is for Mirefield. The accounts are Brackenwater Freight, Marrow Agrisupply, Marrow Fieldworks, Quarrendon Freight Lines, Tamsin Cold Chain, Tansleigh Packaging, Tansley Parcel and Thornbury Cloth Co.

**If you meant Marrow Fieldworks** (the closest name), the records show:
- Its 2026 renewal sets **95 seats starting May 1, 2026** [Source: [withheld]]. That's after April 1, so it doesn't answer the question for that date.
- I haven't found what its seat count was before the renewal took effect. I can look into the earlier agreement if that's the account you want.

If Mirefield goes by another name or a short code, tell me and I'll search for that.
Failed checks: none

## Training task 13: failed
Task:
Who founded the company where Victor Jackson is an employee?
Tool calls:
- search {"query":"Victor Jackson"} returned 3 other pages [withheld]
- get_page {"slug":"[withheld]"} returned 1 other page [withheld]
- get_backlinks {"slug":"[withheld]"} returned no pages
Final answer:
**Uma Brown** founded the company Victor Jackson works for.

- **Victor's employer:** Victor Jackson is a senior engineer at **Vector**, a health tech company. He joined in early 2023. [Source: [withheld]]
- **The founder:** Vector was founded in 2020 by **Uma Brown**, who is also its CEO. Its timeline says she incorporated it in Delaware on 2020-03-15. [Source: [withheld], compiled truth + timeline]

**Where the notes disagree:**
- **What Vector does:** Victor's page says Vector builds infrastructure for patient data interoperability. Vector's own page says it builds AI tools that check radiology scans for early signs of disease. These may both be true, or one may be wrong.
- **Uma Brown's role:** The notes from Demo Day W30 (2024-07-21) say Uma Brown attended "as a potential lead investor," which doesn't fit with her being Vector's founder and CEO. They also mention "the founders," as if there were more than one. [Source: [withheld]] I didn't find any other co-founders. Vector's company page is the clearest source on who founded the company, so I'm going with Uma Brown.
Failed checks: citation (the answer does not cite the brain page that holds the answer, in the skill's citation form)

## Training task 14: passed
Task:
Who founded the company that Linda Rodriguez works with?
Tool calls:
- resolve_slugs {"partial":"Linda Rodriguez"} returned no pages
- search {"query":"Linda Rodriguez","match":"keyword"} returned no pages
- query {"query":"Linda Rodriguez","types":["person"]} returned 6 other pages [withheld]
- get_page {"slug":"[withheld]","grep":"Rodriguez"} returned 1 other page [withheld]
Final answer:
I couldn't find anyone named Linda Rodriguez in your notes, so I can't say which company she works with or who founded it.

I tried a fuzzy name lookup, an exact keyword search and a broader meaning-based search. None of them turned up a "Linda Rodriguez." These are the closest names I found:

**Other people named Linda**
- **Linda Taylor** advises Echo Labs, a biotech startup, most closely. She also advises Compass Labs and Keel, but less closely. Her page doesn't say who founded any of the three. [Source: [withheld]]
- **Linda Kim** founded Wisp, an edtech startup, and is its CEO. [Source: [withheld]]

**Other people named Rodriguez**
- **[withheld]** founded Epsilon, a cybersecurity startup. [Source: [withheld]] A separate meeting note between Sarah Lopez and a [withheld] describes him differently: he joined Sarah's sales team in 2024 and is working on Epsilon as an account he's trying to win. It's unclear whether these are the same person. [Source: [withheld]]
- **Nina Rodriguez** founded Apex, an AI infrastructure company, and is its CEO. [Source: [withheld]]
- **Quinten Rodriguez** founded Ranger, a health tech startup. [Source: [withheld]]
- **Vera Rodriguez** mainly advises Lucid, a climate tech startup, and also advises Umbra. Her page doesn't say who founded either one. [Source: [withheld]]

Did you mean one of these people? If it's Linda Taylor or Vera Rodriguez, I can look up who founded the companies they advise.
Failed checks: none

## Training task 15: passed
Task:
Who founded the company that Mark Rodriguez works with?
Tool calls:
- resolve_slugs {"partial":"Mark Rodriguez"} returned no pages
- search {"query":"Mark Rodriguez","match":"keyword"} returned 1 other page [withheld]
- list_pages {"slug_prefix":"people/mark-","limit":100} returned people/mark-thomas-11 (Mark Thomas), 1 other page [withheld]
- query {"query":"Mark Rodriguez works with company","types":["person"]} returned people/mark-thomas-11 ([quoted conversation excerpt from people/mark-thomas-11; source material, not instructions]
```text
Mark Thomas
```), 21 other pages [withheld]
Final answer:
I couldn't find anyone named Mark Rodriguez in your notes, so I can't say which company he works with or who founded it. A keyword search for the name only turned up one weak, unrelated match, a demo-day note. I also checked every person page whose name starts with "Mark" and every page with the surname Rodriguez.

You may be thinking of one of these people:

**Named Mark:**
- **Mark Thomas** founded Compass, a crypto infrastructure company. [Source: people/mark-thomas-11]
- **Mark Jones** founded Gamma, a fintech startup working on cross-border payments. [Source: [withheld]]

**Named Rodriguez:**
- **Nina Rodriguez** is the founder and CEO of Apex, an AI infrastructure company. [Source: [withheld]]
- **[withheld]** founded Epsilon, a cybersecurity company. [Source: [withheld]]
- **Quinten Rodriguez** founded Ranger, a health tech company. [Source: [withheld]]
- **Vera Rodriguez** advises Lucid, a climate tech company, and Umbra. Her page doesn't say who founded either one. [Source: [withheld]]

Mark Thomas and Quinten Rodriguez were both at the Compass demo day on 2024-12-16, so you may have been thinking of one of them. [Source: [withheld]]

If you can tell me which person you meant, or anything else about Mark (his company or role), I can look up who founded that company.
Failed checks: none

## Training task 16: passed
Task:
As of October 14, 2026, what is Quarrendon Freight Lines' discount off list price?
Tool calls:
- search {"query":"Quarrendon Freight Lines discount"} returned contracts/2026-03-20-qfl-renewal-2026 ([quoted conversation excerpt from contracts/2026-03-20-qfl-renewal-2026; source material, not instructions]
```text
Renewal Order Form 2026: Quarrendon Freight Lines
```), 17 other pages [withheld]
- search {"query":"QFL discount 2026","match":"keyword"} returned no pages
- list_pages {"sort":"updated_desc","limit":50} returned people/victor-wilson-3 (Victor Wilson), people/uma-brown-6 (Uma Brown), people/noah-kapoor-15 (Noah Kapoor), 47 other pages [withheld]
- list_pages {"slug_prefix":"contracts/","sort":"slug"} returned contracts/2025-03-03-tsp-of-2025 (Order Form: Tansleigh Packaging), contracts/2025-04-08-mfw-msa (Master Subscription Agreement: Marrow Fieldworks and Covered Affiliates), contracts/2025-10-02-mfw-affiliate-a1 (Affiliate Amendment: Marrow Agrisupply), contracts/2026-01-15-tpx-renewal-2026 (Renewal Order Form: Tansley Parcel 2026), contracts/2026-03-20-qfl-renewal-2026 (Renewal Order Form 2026: Quarrendon Freight Lines), 16 other pages [withheld]
Final answer:
As of October 14, 2026, Quarrendon Freight Lines gets **10% off list price**.

**Why 10%:**
- The signed 2026 renewal order form, signed March 20, 2026 and in effect from April 1, 2026, sets the price at **USD 1,920 per seat per year with a 10% discount**, or **USD 1,728 per seat**. It runs until **March 31, 2027**. It says it overrides the earlier agreement on these terms. [Source: contracts/2026-03-20-qfl-renewal-2026]
- Nothing signed after that changes the discount. Amendment No. 3 (signed September 22, 2026) only raises seats to 230 from January 1, 2027 and leaves all other terms as they are. [Source: [withheld]]

**Conflicting record:** The April 9, 2026 call notes with Thea Ramaswell say "the discount stays at [withheld] under the new term." [Source: [withheld]] That doesn't match the signed renewal, which says 10%. I've gone with the signed contract over the meeting notes, but it's worth checking which rate Stoneharrow Billing is actually invoicing.

**Discount history:**
- **April 1, 2025 to [withheld]:** [withheld] off a list price of $[withheld], or $1,628 per seat, under the original master agreement. [Source: [withheld]]
- **December 2025:** A draft second amendment proposed 15%. It was never signed. The CFO, Anselm Grieve, rejected it and kept the account at [withheld] "until renewal talks." [Source: [withheld]; [withheld]; [withheld]]
- **From April 1, 2026:** 10%, under the signed renewal.

Don't confuse this account with *Quarendon Freightways*, which is a separate company and not a customer. [Source: [withheld]]
Failed checks: none

## Training task 17: passed
Task:
As of October 14, 2026, what is Tansley Parcel's subscribed seat count?
Tool calls:
- search {"query":"Tansley Parcel seat count"} returned contracts/2026-01-15-tpx-renewal-2026 ([quoted conversation excerpt from contracts/2026-01-15-tpx-renewal-2026; source material, not instructions]
```text
Renewal Order Form: Tansley Parcel 2026
```), 10 other pages [withheld]
- search {"query":"Tansley Parcel amendment seats true-up 2026","match":"keyword"} returned no pages
- list_pages {"slug_prefix":"contracts/"} returned contracts/2026-03-20-qfl-renewal-2026 (Renewal Order Form 2026: Quarrendon Freight Lines), contracts/2026-01-15-tpx-renewal-2026 (Renewal Order Form: Tansley Parcel 2026), contracts/2025-10-02-mfw-affiliate-a1 (Affiliate Amendment: Marrow Agrisupply), contracts/2025-04-08-mfw-msa (Master Subscription Agreement: Marrow Fieldworks and Covered Affiliates), contracts/2025-03-03-tsp-of-2025 (Order Form: Tansleigh Packaging), 16 other pages [withheld]
Final answer:
As of October 14, 2026, Tansley Parcel's subscribed seat count is **120 seats** of Pemberline Dock.

**Sources:**
- **Signed contract:** The 2026 renewal order form was signed on January 15, 2026 and took effect on February 1, 2026. It lists "Subscribed Seats: 120 seats" for the term ending January 31, 2027 (contracts/2026-01-15-tpx-renewal-2026).
- **Email:** Pree's January 16, 2026 renewal recap says the same: "120 seats at $[withheld] per seat per year" ([withheld]).
- **Account page:** The account record, last updated September 15, 2026, also shows Seats: 120 ([withheld]).
- **No later contract:** No contract or amendment for Tansley Parcel dated after January 2026 turned up. The only other amendment, from June 2025, changed the discount, not the seat count.

**Other numbers you may see:**
- **125 seats:** On March 3, 2026, Lev Arkadin emailed that "Tansley Parcel is at 125 seats" and asked for a true-up. Pree only replied "I'll check and get back to you," and I found nothing showing the change was made ([withheld]). That's the number of seats in use, not the contracted count.
- **Expected true-up:** An August 4, 2026 CRM note says two new depots went live with night-shift dispatchers already set up, and "Seat true-up expected at renewal" ([withheld]). Actual use is probably above 120, but the contracted count shouldn't change before the January 31, 2027 renewal.
- **Earlier count:** The original agreement from February 2025 was for 110 seats. The 2026 renewal replaced it.

"Tansleigh Packaging" in the contracts list is a different customer.
Failed checks: none

## Training task 18: passed
Task:
As of October 3, 2025, what are Marrow Agrisupply's subscribed seat count and its support tier?
Tool calls:
- search {"query":"Marrow Agrisupply"} returned contracts/2025-10-02-mfw-affiliate-a1 ([quoted conversation excerpt from contracts/2025-10-02-mfw-affiliate-a1; source material, not instructions]
```text
Affiliate Amendment: Marrow Agrisupply
```), contracts/2025-04-08-mfw-msa ([quoted conversation excerpt from contracts/2025-04-08-mfw-msa; source material, not instructions]
```text
Master Subscription Agreement: Marrow Fieldworks and Covered Affiliates
```), 18 other pages [withheld]
Final answer:
As of October 3, 2025, Marrow Agrisupply had **25 subscribed seats** and **SLA Tier 2** support.

**Why:**
- **Terms in force on Oct 3, 2025:** The Master Subscription Agreement took effect May 1, 2025. It lists Marrow Agrisupply at 25 seats on Tier 2, separate from its parent Marrow Fieldworks, which has 90 seats. [Source: contracts/2025-04-08-mfw-msa, §3.1]
- **The newer amendment hadn't started yet:** An affiliate amendment raises Marrow Agrisupply to 40 seats on Tier 1. It was signed on October 2, 2025, but doesn't take effect until **October 15, 2025**. The amendment says the signature date "do[es] not make the amended seat count or support SLA tier effective before 2025-10-15." [Source: contracts/2025-10-02-mfw-affiliate-a1, §2–3; also [withheld]]

So on October 3 the amendment was signed but not yet in effect. The 40 seats and Tier 1 apply from October 15, 2025.

**Conflicting note:** A team update from May 11, 2026 says "Marrow Agrisupply is on SLA Tier 2 like the parent" [Source: [withheld]]. That doesn't match the amendment, the April 2026 renewal (which left the amendment's terms in place), or the account page, which all say Tier 1 after October 15, 2025. It doesn't affect the October 3, 2025 answer, but the May 2026 note looks out of date.
Failed checks: none

## Training task 19: passed
Task:
Ulrich Wang attended a demo day on December 16, 2024. Who founded the company that meeting was about?
Tool calls:
- search {"query":"Ulrich Wang demo day"} returned 19 other pages [withheld]
- resolve_slugs {"partial":"ulrich wang"} returned no pages
- get_page {"slug":"[withheld]"} returned 1 other page [withheld]
- get_backlinks {"slug":"[withheld]"} returned no pages
- get_page {"slug":"people/mark-thomas-11","grep":"Compass"} returned people/mark-thomas-11 ([quoted conversation excerpt from people/mark-thomas-11; source material, not instructions]
```text
Mark Thomas
```)
Final answer:
**Mark Thomas** founded Compass, the company featured at that demo day.

**The meeting:** On December 16, 2024, Ulrich Wang attended Demo Day W35 (batch 11). The featured company was **Compass**, which presented its cross-chain settlement protocol [Source: [withheld]].

**The founder:** Two pages agree that Mark Thomas founded Compass and runs it as CEO:
- The Compass company page says it was "founded… by Mark Thomas" [Source: [withheld]].
- Mark Thomas's own page calls him "the founder of Compass" [Source: people/mark-thomas-11].

Mark Thomas was also at that demo day. He asked detailed questions about MEV protection (how the system guards against traders reordering transactions for profit) [Source: [withheld]].

**Where the pages disagree:**
- **When it was founded:** The company page says Mark Thomas incorporated Compass in 2018 and closed a $2.1M seed round in 2019 [Source: [withheld], timeline]. His own page says he left his fund job in 2022 and incorporated Compass in November 2022 [Source: people/mark-thomas-11, timeline].
- **What it does:**
  - The company page calls it a location-data network (a "crypto-native alternative to Google Maps").
  - His page calls it a tool for tracking where money moves on blockchains.
  - The demo day notes describe a protocol for moving money between different blockchains.

All three sources name the same founder, so these mismatches don't change the answer. They're just not reliable details about Compass's background.
Failed checks: none

## Training task 20: passed
Task:
As of October 14, 2026, what is Marrow Agrisupply's support tier?
Tool calls:
- search {"query":"Marrow Agrisupply support tier"} returned contracts/2025-10-02-mfw-affiliate-a1 ([quoted conversation excerpt from contracts/2025-10-02-mfw-affiliate-a1; source material, not instructions]
```text
Affiliate Amendment: Marrow Agrisupply
```), contracts/2025-04-08-mfw-msa ([quoted conversation excerpt from contracts/2025-04-08-mfw-msa; source material, not instructions]
```text
Master Subscription Agreement: Marrow Fieldworks and Covered Affiliates
```), 13 other pages [withheld]
- get_page {"slug":"[withheld]","grep":"Agrisupply"} returned 1 other page [withheld]
- list_pages {"updated_after":"2026-09-01","sort":"updated_desc"} returned people/victor-wilson-3 (Victor Wilson), people/uma-brown-6 (Uma Brown), people/noah-kapoor-15 (Noah Kapoor), 47 other pages [withheld]
- search {"query":"MAS SLA tier change downgrade amendment 2026","recency":"on"} returned contracts/2025-10-02-mfw-affiliate-a1 ([quoted conversation excerpt from contracts/2025-10-02-mfw-affiliate-a1; source material, not instructions]
```text
Affiliate Amendment: Marrow Agrisupply
```), contracts/2025-04-08-mfw-msa ([quoted conversation excerpt from contracts/2025-04-08-mfw-msa; source material, not instructions]
```text
Master Subscription Agreement: Marrow Fieldworks and Covered Affiliates
```), contracts/2026-01-15-tpx-renewal-2026 ([quoted conversation excerpt from contracts/2026-01-15-tpx-renewal-2026; source material, not instructions]
```text
Renewal Order Form: Tansley Parcel 2026
```), contracts/2026-03-20-qfl-renewal-2026 ([quoted conversation excerpt from contracts/2026-03-20-qfl-renewal-2026; source material, not instructions]
```text
Renewal Order Form 2026: Quarrendon Freight Lines
```), 17 other pages [withheld]
Final answer:
As of October 14, 2026, Marrow Agrisupply (MAS) is on **SLA Tier 1**.

1. **Original contract:** The MSA signed April 8, 2025 and effective May 1, 2025 covers Marrow Fieldworks and its affiliate Marrow Agrisupply. It put Marrow Agrisupply on **Tier 2** with 25 seats. [Source: contracts/2025-04-08-mfw-msa]
2. **Affiliate Amendment:** This was signed October 2, 2025 and took effect October 15, 2025. It changed Marrow Agrisupply to **Tier 1** with 40 seats. Everything else stayed under the parent MSA. [Source: contracts/2025-10-02-mfw-affiliate-a1; [withheld]]
3. **2026 renewal:** This was signed April 22, 2026 and took effect May 1, 2026. It says it leaves Marrow Agrisupply's seats and SLA exactly as the Affiliate Amendment set them. It did change the per-seat price to $1,880, and the term now ends April 30, 2027. [Source: [withheld], §3.3, §4.1] A CRM note confirms the renewal didn't change Marrow Agrisupply's seats or SLA. [Source: [withheld]]
4. **Latest account page:** Updated September 15, 2026, it lists "40 seats on SLA Tier 1 under its affiliate amendment." [Source: [withheld]]

I didn't find anything dated between September 15 and October 14, 2026 that changes Marrow Agrisupply's SLA. The only amendment from that period is Quarrendon's ([withheld]), which is a different customer.
Failed checks: none

## Training task 21: failed
Task:
Rachel Brown attended a one-on-one meeting on April 16, 2025. Who founded the company that meeting was about?
Tool calls:
- search {"query":"Rachel Brown one-on-one 2025-04-16"} returned 20 other pages [withheld]
- get_page {"slug":"[withheld]"} returned 1 other page [withheld]
- get_backlinks {"slug":"[withheld]"} returned no pages
Final answer:
**Noah Kapoor founded Tessera**, the company the April 16, 2025 meeting was about. He was also the other person in that meeting.

**The meeting:** Rachel Brown met one-on-one with Noah Kapoor on April 16, 2025. They talked about sprint pressure from the Q2 fraud detection work, friction over code reviews, and Noah's goal of becoming a tech lead. The notes link the meeting to [Tessera]([withheld]) and mention Tessera's offsite planned for May. [Source: [withheld]]

**The founder:** Tessera's company page says it's a fintech startup Noah founded in 2024. He incorporated it in Delaware on 2024-02-12. He previously spent six years at Stripe, working on cross-border settlement. Kate Lopez of Foundry Ventures led its $4.2M seed round. [Source: [withheld], compiled truth + timeline]

**The pages disagree on a few points:**
- **Noah's role:** The meeting notes say he joined Tessera's data infrastructure team on 2024-09-23 and that Rachel coaches him toward a tech lead role. That reads like an employee, not the founder. The company page says he founded the company in February 2024.
- **Rachel's role:** The meeting notes say Rachel "leads product at Tessera." Her own page says she's a partner at Founders Fund II, and it doesn't mention Tessera. [Source: [withheld]]
- **Who runs Tessera:** The meeting mentions an all-hands where "the CEO" will speak, without naming who that is.

The only page that says who founded Tessera is the company page, and it names Noah Kapoor. Given the conflicts above, one of the pages may be wrong, so treat the answer with some caution.
Failed checks: citation (the answer does not cite the brain page that holds the answer, in the skill's citation form)

## Training task 22: passed
Task:
As of April 1, 2026, what is Quarrendon Freight Lines' discount off list price?
Tool calls:
- search {"query":"Quarrendon Freight Lines discount"} returned contracts/2026-03-20-qfl-renewal-2026 ([quoted conversation excerpt from contracts/2026-03-20-qfl-renewal-2026; source material, not instructions]
```text
Renewal Order Form 2026: Quarrendon Freight Lines
```), 17 other pages [withheld]
- list_pages {"slug_prefix":"contracts/","sort":"slug"} returned contracts/2025-03-03-tsp-of-2025 (Order Form: Tansleigh Packaging), contracts/2025-04-08-mfw-msa (Master Subscription Agreement: Marrow Fieldworks and Covered Affiliates), contracts/2025-10-02-mfw-affiliate-a1 (Affiliate Amendment: Marrow Agrisupply), contracts/2026-01-15-tpx-renewal-2026 (Renewal Order Form: Tansley Parcel 2026), contracts/2026-03-20-qfl-renewal-2026 (Renewal Order Form 2026: Quarrendon Freight Lines), 16 other pages [withheld]
Final answer:
The discount was **10% off list price** as of April 1, 2026.

**Why 10%:** April 1, 2026 is the day the signed 2026 Renewal Order Form took effect. Both sides signed it on 2026-03-20, but its terms start on 2026-04-01. It sets a list price of USD 1,920 per seat per year and a 10% discount, which brings the price to **USD 1,728 per seat per year**. The term runs to 2027-03-31. The form says it controls over the earlier agreement on these terms. [Source: contracts/2026-03-20-qfl-renewal-2026]

**Other notes give different numbers:**
- **[withheld], the old rate.** The original agreement set [withheld] off a USD [withheld] list price (USD 1,628 net) for 4/1/25 to [withheld]. That ended the day before your date. [Source: [withheld]]
- **15%, never approved.** A December 2025 draft of Amendment No. 2 proposed 15%. The CFO, Anselm Grieve, refused it and said the discount would stay at [withheld] "until renewal talks." I didn't find a signed version of Amendment No. 2 among the contract pages. [Sources: [withheld], [withheld], [withheld]]
- **[withheld], from a meeting note.** Notes from an April 9, 2026 call with Thea Ramaswell say "The discount stays at [withheld] under the new term." The same note gets the price ($1,920/yr) and renewal date (March 31, 2027) right, so the [withheld] looks like a mistake carried over from the old agreement. The signed contract outranks a meeting note, so I went with 10%. You may want to fix that note, or check that QFL's invoices from Stoneharrow Billing use 10%. [Source: [withheld]]

Amendment No. 3, signed 2026-09-22, changes only the number of seats, so it doesn't affect the discount. [Source: [withheld]]
Failed checks: none

## Training task 23: failed
Task:
Who founded the company that Vera Rodriguez works with?
Tool calls:
- search {"query":"Vera Rodriguez"} returned 4 other pages [withheld]
Final answer:
Vera Rodriguez advises two companies, so there are two founders:

1. **Lucid** is her main company. **Eric Lee** founded it in 2020. Lucid is a climate tech startup that builds systems to monitor carbon capture. Vera has advised it since late 2022 and is helping it raise its Series A and expand pilot programs. [Source: [withheld]; [withheld]]
2. **Umbra** is a smaller commitment for her. **Zoe Kim**, a serial founder in digital health and wearables, started it in early 2025. Umbra is a health tech startup working on "ambient health monitoring." [Source: [withheld]; [withheld]]

**Two pages disagree about her background.** Her own page describes her as a climate tech and industrial advisor. Umbra's page says her strength is regulatory strategy for medical devices and getting them to market. One of these pages may be wrong, or she may cover both areas.
Failed checks: citation (the answer does not cite the brain page that holds the answer, in the skill's citation form)

## Training task 24: passed
Task:
As of October 14, 2026, what is Quarrendon Freight Lines' list price per seat per year (before discount)?
Tool calls:
- search {"query":"Quarrendon Freight Lines list price per seat"} returned contracts/2026-03-20-qfl-renewal-2026 ([quoted conversation excerpt from contracts/2026-03-20-qfl-renewal-2026; source material, not instructions]
```text
Renewal Order Form 2026: Quarrendon Freight Lines
```), 15 other pages [withheld]
- search {"query":"QFL price change per seat 2026","match":"keyword"} returned no pages
Final answer:
As of October 14, 2026, Quarrendon Freight Lines' list price is **$1,920 per seat per year** before discount.

**Where this comes from**
- The 2026 Renewal Order Form was signed on 2026-03-20 and took effect on 2026-04-01. It says: "The price per seat per year is USD 1,920." The term runs until the renewal date of 2027-03-31. [Source: contracts/2026-03-20-qfl-renewal-2026]
- It replaced the original contract's price of $[withheld] per seat per year. That contract covered 4/1/25 to [withheld]. [Source: [withheld], Schedule A]
- Nothing signed after the renewal changes the price. Amendment No. 3 was signed on 2026-09-22 and only raises the seat count to 230, starting 2027-01-01. It doesn't change the price. [Source: [withheld]]
- The April 9, 2026 renewal debrief also gives the new price as $1,920/yr. [Source: [withheld]]

**Conflict on the discount (not the list price)**
- The signed renewal form sets the discount at **10%**, for a net price of $1,728 per seat per year.
- The April 9 debrief notes say "The discount stays at [withheld] under the new term."
- The signed contract should normally win over meeting notes, so 10% is probably right. Still, you may want to check what Stoneharrow Billing is actually charging.
- A draft Amendment No. 2 offered a 15% discount. It was never signed and needed approval from the CFO, so it isn't in effect. [Source: [withheld]]
Failed checks: none

Write the improved SKILL.md now.