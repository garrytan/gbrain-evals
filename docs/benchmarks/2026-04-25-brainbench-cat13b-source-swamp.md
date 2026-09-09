# Keeping a useful note above a large chat archive

**Historical run: April 25, 2026.** Thirty queries, top five results, about fifty seconds for four adapters. The original corpus had ten short `originals/` pages and ten long `wintermute/chat/` pages. Estimated additional API cost was about $0 with warm embeddings.

A chat archive can mention the same topic many more times than a short, carefully written note. Search then faces a practical choice: return the page with more matching text, or prefer the source where the user keeps their considered answer. This fixture deliberately makes those two pages compete.

**The original scores below are historical.** They do not isolate source weighting from the rest of the search pipeline. The old chat prefix was renamed to `openclaw/chat/` in gbrain v0.24.0, which stopped the old fixture from exercising chat demotion. The corrected runner uses the matching prefix and compares the same search with source weighting on and off. See the [retrieval refresh](2026-09-09-retrieval-refresh.md).

## The original version comparison

| gbrain version           | Top-1 hit | Top-3 hit | Swamp@top (lower=better) |
|--------------------------|-----------|-----------|--------------------------|
| **v0.22.0** (this branch — source-boost) | **93.3%** | **100.0%** | **6.7%** |
| v0.21.0 master (two-pass retrieval)      | 90.0%     | 100.0%    | 10.0%                    |
| v0.20.4 master (pre-two-pass)            | 90.0%     | 100.0%    | 10.0%                    |

The recorded change from either v0.20.4 or v0.21.0 to v0.22.0 was 3.3 points at rank one, and 3.3 fewer points of chat-before-target results. This was one additional correct first result out of thirty. It should not be presented as a large or isolated causal effect.

The v0.21 two-pass work concerned code relationships and parent-scope chunks. This test concerns a different signal: a page's source directory.

## The original adapter comparison

| Adapter                | Top-1 hit | Top-3 hit | Swamp@top | Notes                                     |
|------------------------|-----------|-----------|-----------|-------------------------------------------|
| **gbrain** (v0.22.0)   | **93.3%** | **100.0%** | **6.7%**  | Source-aware ranking + hybrid pipeline   |
| vector-grep-rrf-fusion | 93.3%     | 100.0%    | 6.7%      | Same as gbrain ... boost shows up here too |
| vector                 | 96.7%     | 100.0%    | 3.3%      | Vector wins on conceptual recall as expected |
| grep-only              | 80.0%     | 96.7%     | 20.0%     | Source-blind ... 20% of queries return chat at #1 |

Both gbrain-backed adapters used source weighting, so their agreement does not tell us what happens when that weighting is removed. Bare vector search actually had the highest rank-one hit rate here: 96.7% versus gbrain's 93.3%. Grep's 80.0% shows that exact words alone sometimes preferred the chat, but the comparison also changes more than source weighting.

“Swamp@top” counts a question when at least one chat page appears before the intended curated page. It is a failure measure for this fixture's chosen target, not a claim that chat archives are inherently irrelevant.

## The two misses

Twenty-eight of thirty questions put the curated page first. These two put it third:

| Query | Phrase | Why it missed |
|-------|--------|---------------|
| q12 | "founder default-mode organizational drag" | Chat 04-10 has the most direct per-byte discussion of "organizational drag" as a phrase. Curated page mentions it once. Target ranks #3 (still in top-3). |
| q27 | "foundation models substitutability vendor diversification" | Chat 04-17 explicitly debates "vendor diversification". Curated page mentions it once. Target ranks #3. |

The chats discussed the phrases more directly. The target note remained in the first three results, so a reader willing to inspect three pages could still find it. This is why a source preference should be treated as a useful prior, not proof that a particular page answers the question.

## What source weighting means

At publication, the default factors were `originals/` ×1.5 and `wintermute/chat/` ×0.5. A factor adjusts the search score based on the longest matching page-path prefix. The current pinned implementation uses `openclaw/chat/` for the latter. A factor below one lowers a source's rank; it does not remove it from search.

The twenty-page fixture used approximately 1KB curated notes and 3–5KB chats. Each of the thirty hand-written phrases occurred in both a target note and at least one distractor. The answer key gave the target grade 3 and chats grade 0. That is an intentional product preference in the test, not an independently established judgment about which prose is better.

## Historical reproduction

These commands belong to the old versions and fixture. The second block changes a dependency and deletes a lockfile; it is retained as historical procedure, not a recommended current setup command.

```sh
# In gbrain-evals/
bun link gbrain                        # link a local gbrain checkout
bun eval/runner/cat13b-source-swamp.ts
```

```sh
# Pin gbrain to a specific commit hash in package.json:
#   "gbrain": "github:garrytan/gbrain#11abb24"
rm -rf node_modules/gbrain bun.lock && bun install
bun eval/runner/cat13b-source-swamp.ts
```

The original report did not test a 10,000-page store, per-deployment `GBRAIN_SOURCE_BOOST` tuning, or the date/detail behavior that can allow archive material to rank normally for temporal questions. Its fixtures were committed rather than regenerated. The corrected on/off comparison is the appropriate evidence for a present-day source-weighting recommendation.
