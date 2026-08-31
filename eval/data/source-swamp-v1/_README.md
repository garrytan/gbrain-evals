# source-swamp-v1 — corpus for BrainBench Cat 13b

A 20-page corpus engineered to expose the **source-swamp** failure mode that
real personal brains suffer from but `world-v1` does not.

**The shape:**
- **10 short, opinionated `originals/` pages** ... ~1KB each. The author's own
  writing on a specific topic. Title and lead phrase appear once or twice.
- **10 long, dense `openclaw/chat/YYYY-MM-DD` pages** ... 3-5KB each.
  Synthesized chat-dump style: each chat page name-drops 3-4 of the
  curated topics in passing, repeating each phrase 3-8x with discussion
  filler around it.

**Why `openclaw/chat/`:** the corpus swamp prefix MUST be a prefix the
CURRENT gbrain `DEFAULT_SOURCE_BOOSTS` map actually demotes, or the eval
silently tests nothing (audit finding retrieval-cats-07: the original
`wintermute/chat/` key was renamed to `openclaw/chat/` in gbrain v0.24.0
and every swamp page ranked at the neutral 1.0 factor for months). The
runner asserts at startup that the swamp prefix resolves to a < 1.0
factor in `node_modules/gbrain/src/core/search/source-boost.ts`, so the
next rename fails loudly instead of silently.

**Why this corpus exists:**
`world-v1` has zero `openclaw/chat/`, `daily/`, or `media/x/` content.
The default boost map in `gbrain` dampens those bulk directories,
but `world-v1` can't measure the effect. This corpus has the swamp shape
embedded so Cat 13b can score it.

**Without source-aware ranking:** chat pages dominate multi-word topic queries
because they have higher per-byte keyword density than the curated articles
that should win.

**With source-aware ranking:** the curated `originals/` pages get
a 1.5x boost; chat pages get a 0.5x dampener (gbrain v0.47.6.0 defaults).
The curated page that actually wrote the topic up rises to #1 while chat
references stay findable for date-framed queries (`detail=high` bypasses
the gate).

**What Cat 13b measures:** 30 hand-curated source-swamp queries, each
pairing a curated page with >=1 competing chat page that shares the same
multi-word phrase. Qrel: curated page is the strict target (grade 3),
chat pages are wrong-but-plausible distractors (grade 0). Pass criterion:
top-1 is the curated page. A paired `gbrain-no-source-boost` ablation arm
(same pipeline, boost map neutralized to 1.0 via `GBRAIN_SOURCE_BOOST`)
isolates the source-boost effect.

**Reproducibility:** all content is committed JSON. No regeneration script
... if you change anything, edit the JSON directly.
