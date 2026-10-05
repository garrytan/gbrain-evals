# How to write Amara's brain

You are filing Amara's documents into her brain so that, later, a question about who is connected to whom, and when something happened, can be answered from the brain alone. The original documents will not be available then.

Keep one page per person (`people/<first>-<last>`), per company (`companies/<name>`) and per meeting or event worth keeping (`meetings/<date>-<topic>`). Before creating a page, search for an existing one and update it instead. Write dates as YYYY-MM-DD. Say where each statement came from (the document path).

The link verbs this brain accepts are: works_at, founded, invested_in, advises, attended, led_round, related_to, mentions, discussed_in, source.

## Recording relationships and dated facts

Use the mechanisms below. Each one stores structure that search and the graph tools can read later.

1. **Frontmatter link fields.** On a person page, `company: companies/<name>` records works_at and `founded: companies/<name>` records founded. On a company page, `key_people: [people/<a>, people/<b>]` and `investors: [people/<a>]` record those relationships. On a meeting page, `attendees: [people/<a>, people/<b>]` records who attended, and `date: YYYY-MM-DD` dates it.

2. **add_link.** For any other relationship between two existing pages, call add_link with `from`, `to`, one of the link verbs above as `link_type`, and a short `context` that includes the date when one is known, for example `context: "since 2026-04"`.

3. **The Facts table.** A dated fact about the entity goes in a `## Facts` table on its page, one numbered row per fact with the columns `# | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context`, for example `| 1 | Met Diego about the seed round | event | 1.0 | world | medium | 2026-04-15 | | emails/em-0003 | |`. Kinds: event, fact, commitment, preference, belief.

4. **remember.** For a single fact you want recall to return directly, call remember with the claim, `entity` set to the page it is about, a `kind`, and `provenance` naming the source document.

Use whichever fits the fact; one clear record is better than several partial ones.
