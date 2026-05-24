# Comparison Systems — published numbers we benchmark against

Living list of memory / agentic-retrieval systems that publish numbers on
benchmarks gbrain runs. Update when a system publishes a new result, even
if it's not on a benchmark we currently run — the data informs which
benchmark we should add.

## LongMemEval (`xiaowu0162/longmemeval` `_s` split, 500 questions)

Metric column key: **R@k** = retrieval recall (does any ground-truth
session land in top-k?). **QA-acc** = end-to-end answer accuracy via an
LLM judge. **Different metrics, not directly comparable.**

| System | Headline | Metric | k | n | LLM in loop | Source |
|---|---|---|---|---|---|---|
| MemPal hybrid v4 + Haiku rerank | 100% | R@5 | 5 | 500 | yes (Haiku) | [BENCHMARKS.md](https://github.com/MemPalace/mempalace/blob/main/benchmarks/BENCHMARKS.md) — tuned on 3 specific failing Qs |
| MemPal hybrid v4 + Haiku, held-out | 98.4% | R@5 | 5 | 450 | yes (Haiku) | held-out generalisable figure |
| MemPal raw (ChromaDB) | 96.6% | R@5 | 5 | 500 | none | their public-facing headline |
| Stella | ~85% | R@5 | 5 | 500 | none | academic dense retriever |
| Contriever | ~78% | R@5 | 5 | 500 | none | academic dense retriever |
| BM25 (sparse) | ~70% | R@5 | 5 | 500 | none | published baseline in the LongMemEval paper |
| Mastra | 94.87% | QA-acc (NOT R@k) | n/a | 500 | yes (GPT-5-mini) | [mastra.ai/research/observational-memory](https://mastra.ai/research/observational-memory) |
| Supermemory ASMR | ~99% | QA-acc (NOT R@k) | n/a | 500 | yes (Gemini-2/GPT-4o ensemble) | [their ASMR post](https://supermemory.ai/blog/we-broke-the-frontier-in-agent-memory-introducing-99-sota-memory-system/) — authors flag it as experimental, not production |

**Important reading note:** Mastra and Supermemory's numbers are end-to-end
QA accuracy (does the system produce the right answer string, judged by
gpt-4o or similar). MemPal and the gbrain numbers in this
table are retrieval recall (does the right session land in top-k). A
system can have 100% retrieval recall and 60% QA accuracy if its answer
model is bad, and vice versa. Don't compare them head-to-head without
naming the gap.

## ConvoMem (Salesforce, 75K+ QA pairs)

| System | Score | Notes |
|---|---|---|
| MemPal | 92.9% | verbatim text + semantic search |
| Gemini (long context) | 70-82% | full history in context window |
| Block extraction | 57-71% | LLM-processed blocks |

We don't run ConvoMem yet. Filed as a follow-up.

## LoCoMo (1,986 multi-hop QA pairs)

| System / mode | R@10 | Notes |
|---|---|---|
| MemPal hybrid v5 + Sonnet rerank | 100% | "structurally guaranteed (top-k > sessions)" — needs caveat |
| MemPal bge-large + Haiku rerank | 96.3% | top-15, R@10 |
| Memori | 81.95% | published baseline |
| MemPal hybrid v5 (no rerank) | 88.9% | top-10 |

We don't run LoCoMo yet. Filed as a follow-up.

## Sources we've checked (so we don't redo the lookup)

- [`MemPalace/mempalace/benchmarks/BENCHMARKS.md`](https://github.com/MemPalace/mempalace/blob/main/benchmarks/BENCHMARKS.md) — most thorough public benchmark page in this category. They credit competitors fairly and call out their own tuning caveats.
- [`mastra.ai/research/observational-memory`](https://mastra.ai/research/observational-memory) — observational-memory framework, QA accuracy.
- [`supermemory.ai/blog/we-broke-the-frontier-in-agent-memory-introducing-99-sota-memory-system/`](https://supermemory.ai/blog/we-broke-the-frontier-in-agent-memory-introducing-99-sota-memory-system/) — Supermemory ASMR. Experimental ensemble, not production.
- [LongMemEval HuggingFace](https://huggingface.co/datasets/xiaowu0162/longmemeval) — the dataset itself. Three splits: `_oracle` (15MB, ~3 sessions per Q), `_s` (278MB, ~50 sessions per Q), `_m` (2.7GB, more distractors).

## When you add a new comparison row

Cite the source page directly (link to the section + accessed-on date).
Note any caveats the source itself raises (tuning-on-failing-Qs,
experimental-not-production, metric-mismatch). Don't editorialize — keep
this page neutral so it can be cited from any of our reports.
