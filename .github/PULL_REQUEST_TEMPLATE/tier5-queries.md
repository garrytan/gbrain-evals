## Tier 5.5 externally-authored queries

<!-- Thanks for contributing queries! Tier 5.5 exists precisely to
     neutralize the benchmark authors' blind spots — your phrasing is the
     value. See eval/CONTRIBUTING.md for the full flow. -->

**Handle:** <!-- matches eval/external-authors/<handle>/ -->
**Query count:**
**Validator output:** <!-- paste the tail of `bun run eval:query:validate eval/external-authors/<handle>/queries.json` -->

### Checklist

- [ ] Every query validated with `bun run eval:query:validate` (zero errors)
- [ ] Every slug in `gold.relevant` exists in `eval/data/world-v1/`
- [ ] Queries are my own natural phrasing (not adapted to "benchmark style")
- [ ] No real people, companies, or private data — placeholder world only
- [ ] `author` field set on every query
