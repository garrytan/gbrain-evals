# gbrain-evals

You may remember who said something without remembering their words. Or remember
an idea without remembering who said it. Those are different retrieval problems.
[gbrain](https://github.com/garrytan/gbrain) combines word search, meaning-based
search, and relationships between pages to help an agent find what it needs.

This repository explains why gbrain is worth evaluating for agent memory and
personal knowledge applications. It contains the experiments, the data, and the
code behind that case. You can reproduce our results, compare another system,
or add the questions your application needs to answer.

**Start with [what we learned about retrieval](docs/retrieval-lessons.md).**
For a working configuration, read [the settings guide](docs/settings.md).
For datasets, methods, and every report, use [the documentation index](docs/README.md).

## Where gbrain stands

gbrain's clearest comparative result is retrieval: finding every conversation a
question needs. On [LongMemEval](https://arxiv.org/abs/2410.10813)'s cleaned
small split, gbrain found all labeled evidence sessions for **449 of 470
answerable questions (95.53%)** in its first five returned chunks. That is
higher than every other system we can score on the same strict metric from
its saved per-question rankings.

| System | Strict `recall_all@5` | Where the number comes from |
|---|---|---|
| **gbrain v0.48.4.0**, `balanced` with Voyage reranker | **95.53% (449/470)** | our run, September 6 |
| gbrain v0.48.4.0, same without the reranker | 93.40% (439/470) | our run, September 6 |
| MemPalace hybrid v4 + LLM rerank | 90.0% (423/470) | our strict recount of their saved rankings |
| MemPalace hybrid v4, held-out subset | 88.7% (376/424) | our strict recount; different denominator |
| MemPalace raw (ChromaDB) | 85.7% (403/470) | our strict recount of their saved rankings |
| ContextFit + embedding fusion | 87.45% (411/470) All@5 | self-reported, their own harness |

A question counts only if every required session is found, so finding one of
two needed conversations earns nothing. Many published LongMemEval "R@5" scores
of 95% to 100% count a question as found when any one required session appears.
MemPalace's raw rankings find at least one required session for 454/470
questions (96.6%) but all of them for only 403/470 (85.7%). Three limits
apply. gbrain's five results are chunks, which can cover fewer than five
sessions, while MemPalace returns five whole sessions. The gbrain configuration
was chosen on these same 470 questions, with no held-out confirmation yet.
Embedders, chunking and ranking all differ, so this shows how the tested
pipelines compare, not why. Sources, dates and every row we could not match are
in [comparisons and their protocols](docs/comparison-systems.md).

**Answer accuracy is not yet a matched comparison.** In a leak-free re-run on
September 29, with session ids made opaque, gbrain's judged answers were
correct on **439 of 500 questions (87.8%)**. That run used the reranker off
and the notes reader (Sonnet 4.6, 1,024 output tokens), so it is not the
published configuration and does not measure how much the leak helped. The
historical 433/500 (86.6%) stays in the record as invalid: its answer model
could see session ids that mark the labeled evidence. On exactly the same
retrieved sessions, a GPT-4o reader with LongMemEval's official reading prompt
scored 430/500 (86.0%); paired, it won 21 questions and lost 30 (exact McNemar
p = 0.26), so the two readers are not demonstrably different. With the Voyage
reranker on and the same code, the notes reader scored **453/500 (90.6%)**
(+31/−17 against reranker off, p = 0.059, not yet a demonstrated gain), and the
published configuration with the leak removed scored 432/500 against the
invalid 433/500 (+15/−16), so hiding the gold ids made no measurable
difference there. Published results for other systems range from 81.6% to 96.1%, each with its own retrieval,
reader, judge and prompts. Retrieval, context size and judges still differ, so
we claim no ranking on answers in either direction.
[Read the re-run](docs/benchmarks/2026-09-29-longmemeval-opaque-qa.md).

**What the reader receives matters more than which chunks rank first.** On
September 30, with the Voyage reranker on and the top five hits frozen at
gbrain `732ee811`, giving the reader the whole page behind each hit answered
**361 of 400 held-out LongMemEval-S questions**, against 253 for the five
chunks alone (+114/−6, exact McNemar p = 6e-27). The cheaper option, one or two
neighbor chunks on each side, reached 285 and 292 at 44% of the whole-page
input tokens: better than chunks, but it closed only 30% to 36% of the gap,
short of the preregistered 60%. So gbrain v0.60.13.0 ships `return_unit: page`
as a documented opt-in and keeps `chunk` as the default. Use `page` when answer
quality matters more than reader tokens. LongMemEval-S is development data for
gbrain, so this is not an independent confirmation.
[Read the evidence-delivery study](docs/benchmarks/2026-09-30-evidence-delivery.md).
gbrain then made delivery automatic: `auto` v2 (v0.60.16.0) returns whole
conversation pages within a 16,000-token budget and leaves other hits as
chunks. Its preregistered release check on the sealed confirmation set came out
**`fail`**: 149 of 150 against 147 for chunks (+2/−0, p = 0.50), because chunks
already answer 98% of those short chats and no change could reach
significance there. On LongMemEval-S, as development data, `auto` scored 445 of
500 against 312 for chunks and 457 for uncapped pages; the budget cut 81
questions and cost about 4 answers.
[Read the auto v2 check](docs/benchmarks/2026-09-30-evidence-auto-v2.md).

## Why put gbrain on your shortlist?

**It finds evidence across long conversations.** In the September 6 LongMemEval
run, gbrain found every labeled conversation needed for **449 of 470 answerable
questions, or 95.53%**, within five returned text chunks. The answer model then
read the full sessions behind those chunks and answered 433 of 500 questions
correctly (86.6%), including questions whose correct response was to abstain.
Those are separate measurements with separate denominators. The release setting
(autocut off) was chosen by comparing arms on the same 470 questions, and the
pre-registered target of at least 92% answer accuracy was missed. On September
28 we found that the answer model saw the `answer_` prefix that LongMemEval
puts on every labeled evidence session id, so the 433/500 figure is historical
and invalid. A 30-question check found no effect of the prefix on retrieval.
[Read the experiment](docs/benchmarks/2026-09-06-longmemeval-ranker-wave.md).

**The reader needs whole conversations, not just matching passages.** The
September 29 leak-free re-run, with the reranker off, found all labeled
evidence for 435/470 answerable questions and answered **439/500 (87.8%)**
correctly with the full retrieved sessions. On a fixed random 100 questions,
the same reader given only the five retrieved chunks fell from 89/100 to
65/100. With those chunks held fixed, gbrain's reader prompt, a plain prompt
and `gbrain think`'s prompt tied at 65, 65 and 64 of 100. Delivering more of
the evidence mattered far more than the prompt wording.
[Read the re-run](docs/benchmarks/2026-09-29-longmemeval-opaque-qa.md).
The evidence-delivery study above measured the same effect with retrieval
held fixed.

**Keeping the conversations intact can help the answer model use them.** In a
separate September 24 matched reading study, asking Sonnet 4.6 to take brief
notes before answering raised judged correct answers from 308/361 to 324/361
on fixed retrieved sessions. Nine notes responses hit the output limit, and
manual review found grading artifacts. This measures answer reading, not a
retrieval gain. Both arms saw the same `answer_` session ids, so the
comparison is matched, but the result is pending a re-run with opaque ids. A
later reader release defaults to notes with a larger output limit; that new
default has only a selected-case completion check here, not a fresh accuracy
comparison. [Read the study](docs/benchmarks/2026-09-25-reading-notes.md).

**It can find an idea described in different words, with a reranker.** On our
held-out concept questions, gbrain with a reranker put an exact target first
on **130/181 questions**. A reranker reads candidate passages again together
with the question. Without it, gbrain scored 102/181, below vector search
alone at 118/181. We have not yet run vector search with the same reranker, so
the like-for-like comparison is 102 against 118 without reranking. The
reranker gained 37 questions and lost 9. For concept questions, test gbrain
with reranking and keep vector search as a serious alternative.
[Compare all six configurations](docs/benchmarks/2026-09-09-retrieval-refresh.md#concept-search-order-meaning-and-popularity).

**It has a way to use relationships as evidence.** Suppose you ask who invested
in Acme. Searching for “Acme” finds pages that mention the company. Following an
“invested in” connection finds its investor. In our controlled production test
over 145 relationship questions, enabling relationship retrieval raised
first-place hits from **14% to 24%** and recall at five from 0.663 to 0.724,
improving recall on 45 question runs and worsening none. The gain was
concentrated: investor questions rose from 9/39 to 21/39 first-place hits,
while attendance questions stayed at 0/50 because the fixture's link direction
did not match the parser's expectation. The calls shared their index and query
vectors. [Read the controlled comparison](docs/benchmarks/2026-09-09-retrieval-refresh.md#production-relationship-retrieval-one-switch).
Those questions use the exact verbs gbrain's relationship parser recognizes. On
September 29 (gbrain `b80cad6`) the same 145 questions, reworded by a fixed
paraphrase grammar, never triggered relationship retrieval, and recall at five
stayed at 0.411 in both arms, so the gain depended on that wording. gbrain
v0.60.6.0 widened the parser: at the previous pin `608a174` a keyless check
fires relationship retrieval on 33 of the 145 reworded questions (0 at
`b80cad6`). The paid run has not been repeated there, so the benefit on
reworded questions is not yet measured.
[Read the paraphrase check](docs/benchmarks/2026-09-29-relational-paraphrase.md).

**You can see what each setting buys you.** Returning fewer results saves reading,
but a question about two events may need two old conversations. On LongMemEval,
turning off the score-based trimming step raised complete retrieval from
**379/470 to 449/470**. Extra query rewrites, meanwhile, hurt retrieval at a
five-result limit. These experiments produced practical defaults:
[when to rerank, trim, expand, or favor a source](docs/settings.md).

**The system is inspectable.** gbrain keeps knowledge in Markdown files and builds
a database index for searching it. Its retrieval pipeline exposes configuration
and diagnostics. This suite keeps dated results and the records used to calculate
them. Hosted embedding and reranking services receive the text they process;
local storage does not make those API calls local. The retrieval results above
were measured at gbrain [`2efaaf8f`](https://github.com/garrytan/gbrain/tree/2efaaf8f8a817b5b82e023383618fdcdb1cc5f7d)
(v0.48.4.0). This repository currently installs gbrain master
[`6c8373c`](https://github.com/garrytan/gbrain/tree/6c8373c3de9bb321a3da0bfa2dc2140736aeafa5)
(v0.60.13.0), whose search mode definitions are identical. See
[how to reproduce a run](eval/README.md).

## What should you learn here?

| Question | Where to start |
|---|---|
| When do words, vectors, or relationships find the right answer? | [Retrieval lessons](docs/retrieval-lessons.md) |
| Which configuration should I try? | [Settings by workload](docs/settings.md) |
| What changed after fixing the benchmark adapters? | [September retrieval refresh](docs/benchmarks/2026-09-09-retrieval-refresh.md) |
| Does memory stay correct after edits, forgetting and restarts? | [Lifecycle experiment](docs/benchmarks/2026-09-29-lifecycle.md) |
| Where does a small decision model (Jev) beat gbrain's rules? | [System One report](docs/benchmarks/2026-09-30-system-one-jev.md) |
| How do retrieval scores differ from answer accuracy? | [What the scores mean](docs/retrieval-lessons.md#what-the-scores-mean) |
| How does gbrain compare with other memory systems? | [Comparisons and their protocols](docs/comparison-systems.md) |
| Can I reproduce a result or test my own system? | [Run the suite](eval/README.md), [contribute an adapter](eval/CONTRIBUTING.md) |

The useful question is which setup fits your questions. A copied phrase, a vague
recollection, and a relationship lookup exercise different parts of the system.
A good score on one is a reason to investigate that capability, not a promise
about every workload.

## Try a small experiment

Install [Bun](https://bun.sh/) and clone this repository:

```sh
git clone https://github.com/garrytan/gbrain-evals.git
cd gbrain-evals
bun install --frozen-lockfile

# No provider calls: rank the committed documents by matching words.
BRAINBENCH_N=1 bun eval/runner/multi-adapter.ts --adapter grep-only

# Check the committed corpus and question files.
bun eval/runner/validate-data.ts
bun run eval:query:validate
```

To compare all four existing adapters, set `OPENAI_API_KEY` in your environment:

```sh
BRAINBENCH_N=1 bun eval/runner/multi-adapter.ts --queries all
```

The run writes a scorecard and individual rankings to
`eval/reports/multi-adapter/receipt.json`. It uses the fictional corpus already in
the repository. The graph-template adapter only runs on the relationship questions
it understands. Vector and hybrid adapters make paid embedding calls; this runner
does not ship with a persistent warm embedding cache.

For the complete pinned configuration matrix, prerequisites, output paths, and
spending controls, follow the [refresh report](docs/benchmarks/2026-09-09-retrieval-refresh.md).
For a useful first evaluation of your own application, choose representative
questions and their relevant documents before comparing systems. The
[contributor guide](eval/CONTRIBUTING.md) explains the question and adapter formats.

## Memory has a write side too

Retrieval can only find information that was saved. Our
[transcript-distillation experiment](docs/benchmarks/2026-08-16-brainbench-cat35-transcript-distill.md)
measures how much useful material survives when an agent session becomes a memory
page. The recorded repair improved judged retention from **70.2% to 88.1%**,
and all 20 sessions expected to produce pages did so. When a retained item must
also have its quoted evidence present in the page, the scores are **58.2% to
74.9%**. The same run measured **7.0% claim hallucination**. These are in-sample
results: the repair was developed on this same 24-transcript corpus, from a
single run, and human calibration of the judge remains unfinished. They help
evaluate the write path without treating retention as correctness.

We also test [when memory should surface during a conversation](docs/benchmarks/2026-06-12-brainbench-memory.md),
source isolation, identities, dates, and other behaviors. The
[full index](docs/README.md) explains each benchmark in ordinary terms.

## Where a small decision model helps

gbrain's System One lets a small, fast model (TypeSafe's Jev, `jev-1.13.0`)
make nine yes/no or ranking calls that gbrain otherwise makes with a fixed rule
or a larger LLM. In matched pairs on September 30, **Jev measurably helped dream
triage and contradiction proposals; reranking, evidence trimming and abstention
regressed; the rest was inconclusive.** Dream triage missed 0 of 18 buried
decisions and commitments where today's triage missed 10, but sent 57 of 109
transcripts to the page writer instead of 21. The contradiction sweep found 94
of 97 updated facts where the current cosine rule found none. So on gbrain's
System One branch (`feat/system-one-v1`, not yet on master),
`gbrain decide enable --recommended` turns on those two slots only. One fix
landed after the eval: reranking with query expansion timed out on every
question because the decision budget started before expansion; the budget now
starts after retrieval, and that arm was not re-measured. Labels come from
generators, benchmark annotations or an LLM, never from people.
[Read the System One report](docs/benchmarks/2026-09-30-system-one-jev.md).

## Corrections

On September 28, 2026 an audit found several published numbers that were
invalid or overstated. Each report keeps its original figures, labeled, beside
a dated correction:

- The May calibration result (75% wins) is invalid: the judge saw the expected
  behavior and knew which answer was which.
  [Report](docs/benchmarks/2026-05-18-brainbench-cat14-cat15-calibration.md).
- The April relationship precision at five was 39.2% to 44.7% on a lenient
  denominator; divided by five slots it is 29.9% to 35.4%, against a best
  possible 36.0%. The same report's undocumented alias recall falls from 31.0%
  to 13.75%, and its link type accuracy of 70.7% to 88.5% came from a lenient
  scorer. A strict re-run gave 86.6% (240/277), but that count relied on
  attendance edges pointing the wrong way; with the direction corrected, both
  the old pin and gbrain master score 74.7% (109/146).
  [Report](docs/benchmarks/2026-04-18-brainbench-v1.md),
  [September 29 re-run](docs/benchmarks/2026-09-29-repin-cats-1-2-6.md).
- The April and May relationship tables' `gbrain` row (49.1% precision at
  five) came from a regular-expression parser of the four question templates,
  now named `graph-oracle-parse`; it is not a product score.
  [Report](docs/benchmarks/2026-04-19-brainbench-multi-adapter.md).
- The Cat 35 88.1% is judge-only; evidence-verified retention is 74.9%.
  [Report](docs/benchmarks/2026-08-16-brainbench-cat35-transcript-distill.md).
- The May snapshot's Category 18b to 29 rows came from runners written before
  the August audit; Cat 29's +4.00 synthesis lift also scored the same
  single-answer call twice. [Report](docs/benchmarks/2026-05-23-v0.40.6.0-snapshot.md).
- The LongMemEval answer accuracy (433/500) is invalid because the answer
  model saw `answer_` session ids. A leak-free re-run on September 29 scored
  439/500 (87.8%) with the reranker off and the notes reader, a different
  configuration. A September 30 run of the published configuration with the
  leak removed (direct 512 reader, reranker on) scored 432/500, paired +15/−16
  against 433/500, so the leak made no measurable difference; 433/500 stays
  invalid because it was measured with the gold ids visible.
  [Report](docs/benchmarks/2026-09-29-longmemeval-opaque-qa.md). The
  reading-notes result (308/361 to 324/361) is still pending a re-run for the
  same reason. Retrieval numbers are unaffected as far as a 30-question check
  can tell.

## Inspect or extend the work

- `eval/data/` contains public fixtures and answer keys. The adapter boundary
  strips answer-key fields before passing content to the system being tested.
- `eval/runner/` contains runners and the shared scoring functions.
- `eval/reports/` holds temporary output. Published records live beside their
  reports in `docs/benchmarks/`.
- `test/eval/` contains tests for the harness; `.github/workflows/ci.yml` runs the
  checks that do not require provider credentials.

This is gbrain's evaluation repository. External adapters and independently
written questions are welcome. The
[August audit](docs/audit/2026-08-31-eval-audit.md) explains earlier scoring and
harness errors; dated reports identify the results they affect. The
[receipt manifest](docs/receipts-manifest.json) maps published claims to saved
records and explicitly records missing evidence.

Code is MIT licensed. Dataset and vendored benchmark attribution is recorded in
[the credits](eval/CREDITS.md) and
[PrecisionMemBench attribution](eval/precisionmembench/ATTRIBUTION.md).
