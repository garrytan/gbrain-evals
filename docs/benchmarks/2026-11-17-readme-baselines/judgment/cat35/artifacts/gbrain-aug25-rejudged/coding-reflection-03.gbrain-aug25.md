A practical principle crystallized during a debugging session on [[concepts/fernpost]]: any identifier that must remain stable across deploys must be derived exclusively from data that is itself stable across deploys. Embedding build-time state (timestamps, random seeds, process IDs) in such identifiers silently introduces a whole class of "everything looks new" bugs that are difficult to diagnose because the symptom (duplicate items in a feed reader, cache misses, broken deduplication) appears far from the cause (a timestamp in a hash function).

## The Core Insight

> "The GUID needs to be deterministic based on something that does not change across deploys."

The corollary: if you ever find yourself hashing or concatenating a build-time value into a persistent identifier, that is a red flag. Build-time values — timestamps, CI job IDs, git SHAs of HEAD at build time — are fine for versioning artifacts, but they poison identity.

## The Pattern

For content identifiers (RSS GUIDs, database primary keys derived from content, cache keys):

- **Use**: slug, publish date, canonical URL, content hash of the *source* (not the rendered output if the renderer version changes)
- **Avoid**: build timestamp, deploy ID, server hostname, anything that varies per-invocation

> "If we derive the GUID from slug plus publish date and it stays stable, that should fix the core issue."

A SHA256 of `slug + publish_date` (or even a plain URN-style concatenation like `urn:fernpost:post:my-post-slug:2026-07-15`) satisfies the stability requirement while remaining unique enough for typical blog-scale content.

## Architectural Complement: Push Computation to Build Time

A related simplification: if an artifact is stable (doesn't vary by request), render it at build time.

> "Right now the feed is generated on every request. If we render the feed at build time, one less moving part to worry about. The feed XML just becomes a static file that gets deployed alongside everything else."

This is a general heuristic — move any computation whose output is a pure function of the current published content out of the request path and into the build. It reduces runtime complexity, speeds up responses, and makes the system easier to reason about.

## Diagnosis Heuristic

When feed readers or deduplication systems report "everything is new after every deploy," the first thing to check is whether any identifier incorporates runtime or build-time entropy. The symptom is always downstream; the cause is always upstream in the ID-generation code.

On 2026-08-02, a rainy afternoon debugging session on [[concepts/fernpost]] led to the diagnosis and fix of FP-2203 — a bug where every deploy regenerated RSS GUIDs from a build-time timestamp, causing feed readers to treat all existing posts as new. The fix was to derive GUIDs deterministically from slug plus publish date, and to move feed generation to build time. The session surfaced both a clean technical resolution and a genuine moment of reflection on what it means to maintain a small site with real readers.

## The Bug

The RSS feed was embedding a build-time timestamp in each item's GUID. Because the timestamp changed on every deploy, every feed reader treated every post as brand new after every deploy — the classic GUID churn pattern.

> "It looks like we are generating the GUID using some combination of a hash and a timestamp that includes the build time. So every time we deploy, the build time changes, and therefore every GUID changes. That would explain it perfectly."

Three readers emailed about the duplicates in a single week — notable signal for a small personal site, and taken seriously as a trust issue.

## The Fix

Two changes were decided and staged:

1. **Stable GUIDs** — derived from `slug + publish_date`, optionally hashed with SHA256. Neither value changes after a post is published, so the GUID stays constant across deploys.
2. **Build-time feed rendering** — the feed XML becomes a static file deployed alongside everything else, eliminating a runtime moving part.

> "If we derive the GUID from slug plus publish date and it stays stable, that should fix the core issue."

Staging confirmed: three successive rebuilds produced identical GUIDs. The feed stayed clean.

## The Feeling

The session closed with something more personal than a bug fix:

> "strangers actually read this thing, which still feels quietly amazing."

And on what solo maintenance gives that team projects sometimes don't:

> "Maintaining fernpost solo has its challenges, but moments like this make it worthwhile. Tracking down a bug, fixing it properly, and knowing readers will have a better experience. It is satisfying in a way that bigger team projects sometimes are not."

## Backlog item noted

A changelog page generated from git history came up as a potential future feature for [[concepts/fernpost]] — parsing git log to surface recent commits or releases.