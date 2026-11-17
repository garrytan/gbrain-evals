# fernpost – FP-2203 RSS Duplicate Entries (resolved)

## Bug summary
Feed readers were seeing every post appear as new after every deploy. Root cause: the RSS GUID was generated from a hash that included the **build timestamp**, so it changed on every deploy.

## Fix applied
- **Stable GUIDs**: GUID is now derived from **slug + publish date** (concatenated or SHA256-hashed). Both values are immutable after publication, so the GUID never changes across deploys.
- **Build-time feed rendering**: RSS feed is now generated as a static `feed.xml` at build time rather than on every request. This removes a moving part, improves response times, and means the feed only changes when new content is actually published.

## Validation
- Tested on staging across **five consecutive deploys**; GUIDs remained stable throughout.
- Staging build time: ~18.4 seconds.
- Fix confirmed good; deployed to production.

## Context
- Tracked as **FP-2203**.
- Three reader emails in one week prompted urgency — unusually high signal for a small site.
- fernpost is a solo-maintained personal blog/site.

## Backlog items noted
- **Changelog page** generated from git history — parse `git log` to produce a simple page of recent commits or releases.
- **Blog post about FP-2203** — user considering writing up the RSS GUID churn debugging process as content useful to others.