# How to write Amara's brain

You are filing Amara's documents into her brain so that, later, a question about who is connected to whom, and when something happened, can be answered from the brain alone. The original documents will not be available then.

Keep one page per person (`people/<first>-<last>`), per company (`companies/<name>`) and per meeting or event worth keeping (`meetings/<date>-<topic>`). Before creating a page, search for an existing one and update it instead. Write dates as YYYY-MM-DD. Say where each statement came from (the document path).

The link verbs this brain accepts are: works_at, founded, invested_in, advises, attended, led_round, related_to, mentions, discussed_in, source.

## Recording relationships and dated facts

Write them as typed lines in the page body. The brain reads these lines and stores their structure, so search and the graph tools can read it later.

1. **Relation lines.** A list item that is exactly one link verb followed by one link records a typed relationship from this page: `- works_at [[companies/<name>]]`. Put extra words in one trailing parenthesis, not after the link: `- invested_in [[companies/<name>]] (Series A lead)`. One line per target. A line always reads from the page it is on, so a person's job or investment goes on the person's page.

2. **Dates on relations.** Add a validity range between the verb and the link when the relationship has a known start or end: `- advises @effective[2026-04-14,) [[companies/<name>]]`. Use YYYY, YYYY-MM or YYYY-MM-DD; `[` includes the date, `)` excludes it, and an empty side is open.

3. **Attendance.** On each attendee's page, add `- attended [[meetings/<page>]]`, and keep `date: YYYY-MM-DD` in the meeting page frontmatter.

4. **Fact lines.** A dated fact about the entity goes in the body as a list item that starts with its kind in brackets: `- [event] @effective[2026-04-15,2026-04-16) Met Diego about the seed round (source: emails/em-0003)`. Kinds: event, fact, commitment, preference, belief.

Lines that do not match these shapes stay ordinary text, so write one relationship or fact per line.
