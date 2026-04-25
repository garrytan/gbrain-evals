# source-swamp-v1 — corpus for BrainBench Cat 13b

A 20-page corpus engineered to expose the **source-swamp** failure mode that
real personal brains suffer from but `world-v1` does not.

**The shape:**
- **10 short, opinionated `originals/` pages** ... ~1KB each. The author's own
  writing on a specific topic. Title and lead phrase appear once or twice.
- **10 long, dense `wintermute/chat/YYYY-MM-DD` pages** ... 3-5KB each.
  Synthesized chat-dump style: each chat page name-drops 3-4 of the
  curated topics in passing, repeating each phrase 3-8x with discussion
  filler around it.

**Why this corpus exists:**
`world-v1` has zero `wintermute/chat/`, `daily/`, or `media/x/` content.
The default boost map in `gbrain` v0.22.0+ dampens those bulk directories,
but `world-v1` can't measure the effect. This corpus has the swamp shape
embedded so Cat 13b can score it.

**Without source-aware ranking:** chat pages dominate multi-word topic queries
because they have higher per-byte keyword density than the curated articles
that should win.

**With source-aware ranking (v0.22.0+):** the curated `originals/` pages get
a 1.5x boost; chat pages get a 0.5x dampener. The curated page that
actually wrote the topic up rises to #1 while chat references stay
findable for date-framed queries (`detail=high` bypasses the gate).

**What Cat 13b measures:** 30 hand-curated source-swamp queries, each
pairing a curated page with >=1 competing chat page that shares the same
multi-word phrase. Qrel: curated page is the strict target (grade 3),
chat pages are wrong-but-plausible distractors (grade 0). Pass criterion:
top-1 is the curated page.

**Reproducibility:** all content is committed JSON. No regeneration script
... if you change anything, edit the JSON directly.
