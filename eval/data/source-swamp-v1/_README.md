# Cat13b: can a short useful note beat a long chat dump?

A personal knowledge base may contain one careful explanation of a topic and many chat messages that mention it. Ordinary keyword frequency can favor the chat simply because it repeats the topic more often.

This corpus makes that problem small enough to inspect: ten short articles compete with ten longer chat pages. Cat13b tests whether gbrain's source weights help the intended article rank first.

## The twenty pages

The `originals/` pages are about 1 KB each and explain one topic. Their titles and main phrases appear once or twice. The `openclaw/chat/YYYY-MM-DD` pages are about 3–5 KB each, mention three or four topics, and repeat phrases three to eight times.

There are 30 hand-written questions. Each phrase occurs in the intended article and at least one competing chat page. The article is the strict answer, with relevance grade 3; the plausible chat distractors have grade 0.

That answer policy is specific to this experiment. A question asking what someone said on a particular date could reasonably prefer a chat page.

## What the comparison isolates

A source weight multiplies relevance according to where a page came from. The v0.47.6.0 defaults gave `originals/` a 1.5 weight and `openclaw/chat/` a 0.5 weight.

The runner compares normal gbrain search with `gbrain-no-source-boost`, which uses the same hybrid pipeline but sets source weights to 1.0 through `GBRAIN_SOURCE_BOOST`. Reranking and expansion are explicitly disabled for this comparison. The paired difference asks whether source weights helped on these questions.

The primary score is **top1_hit_rate**: the fraction of questions whose intended article ranks first. The runner also records whether the article appears in the top three and whether a chat page outranks it. The normal gbrain arm must reach 80% first-place hits to pass.

The runner rejects a result if the two source-weight arms return identical rankings on every question, because that would not demonstrate that the intended comparison took effect.

## Why the directory name matters

The old corpus used `wintermute/chat/`. gbrain renamed that demoted prefix to `openclaw/chat/` at v0.24.0, leaving the old test at a neutral source weight and preventing it from exercising the intended feature.

The runner now checks that its chat prefix resolves to a weight below 1.0. A later prefix change should produce an explicit failure instead of an apparently valid test of nothing.

## Run it

From the repository root:

```sh
# Real retrieval; requires OPENAI_API_KEY.
bun eval/runner/cat13b-source-swamp.ts

# Free setup check with deterministic fake vectors.
bun eval/runner/cat13b-source-swamp.ts --stub-embed
```

Fake-vector scores test the plumbing and are not publication results. The full live run writes per-question results and a receipt under `eval/reports/cat13b-source-swamp/`.

The corpus is committed JSON and has no regeneration script. Preserve it when rewriting documentation; intentional content changes alter the benchmark and need their own reviewed revision.
