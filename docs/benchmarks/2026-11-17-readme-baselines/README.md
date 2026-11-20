# What gbrain adds over the alternatives developers would use: twelve measured baselines

Measured 2026-11-17 under [the preregistration](../../plans/2026-11-17-readme-baselines/PREREG.md). README's results
table asks whether an agent gets more right with gbrain than without it, and twelve of its rows had no measured
alternative. This folder runs, for each, what a developer would build instead (plain Postgres full-text plus pgvector
search fused by rank, a BM25 keyword ranker, the whole history in the prompt, a plain prompt to the same model, or an
agent with a plain Postgres memory) on the same tasks, scorer, reader and judge, and pairs it question by question with
gbrain's published records. No gbrain arm ran again; each gbrain number keeps the commit it was measured at.

## Takeaways

- **We learned that gbrain beats plain Postgres hybrid search wherever finding the evidence is the hard part. You
  should use it instead of hand-rolling full-text plus pgvector for an agent's memory.** On LongMemEval it found every
  needed conversation in the top five for 451 of 470 questions against 414 (p = 2.4e-7), and readers answered more from
  its results: 468 against 445 of 500 with Sonnet 5.5, 474 against 445 with Opus 5.5. On "who attended" questions it
  found 80.3% of attendees in the top five against 24.7%. Its trust labels cut planted false claims an agent adopts
  from 10.2% to 2.8% of sessions.
- **We learned that gbrain's prompts and pipelines matter most for cheaper models. You should keep them on with Haiku-
  or Luna-class models.** With a plain prompt, Haiku 4.5 called 24 of 40 dated changes contradictions (gbrain's prompt:
  0), and GPT-6 Luna flagged 27 of 251 compatible pairs (gbrain: 0). GPT-6.1 Sol and Opus 5.5 got this test's easy
  synthetic world right either way.
- **We learned where a simpler setup does as well. You should test these before choosing.** The whole history pasted
  into the prompt answered 471 of 500 LongMemEval questions against gbrain's 468, at about 7.4 times the reader cost per
  question. A BM25 keyword ranker matched gbrain on reworded relationship questions that name their entities (0.616
  against 0.537, p = 0.07). Plain hybrid cut to one result matched gbrain's tight mode on PrecisionMemBench, so that
  gain comes from returning less.

## All twelve rows

"Ahead" and "behind" mean the preregistered paired test rejects at 0.05; "level" means it doesn't, which is not a claim
that the two are equal.

| README row | gbrain | Baseline | Result | Details |
|---|---|---|---|---|
| Every needed conversation in the top five, LongMemEval | 451 of 470 | plain hybrid: 414 | ahead (45 vs 8, p = 2.4e-7) | [longmemeval](longmemeval/results.md) |
| Right answers, LongMemEval, Sonnet 5.5 reader | 468 of 500 | whole history: 471; plain hybrid top five: 445; no memory: 58 | level with the whole history (p = 0.72); ahead of plain hybrid (p = 0.004) and no memory | [longmemeval](longmemeval/results.md) |
| Right answers, LongMemEval, Opus 5.5 reader | 474 of 500 | plain hybrid top five: 445 | ahead (43 vs 14, p = 0.0002) | [longmemeval](longmemeval/results.md) |
| A search quoting a saved message | 500 of 500 found | plain hybrid: 491 first, 499 in the top ten | level (ceiling) | [longmemeval](longmemeval/results.md) |
| Reworded one-hop relationship questions, recall at five | 0.537 | BM25: 0.616; vector-only: 0.438; plain hybrid: 0.467 | level with BM25 (19 vs 33, p = 0.07); ahead of the other two | [retrieval](retrieval/results.md) |
| "Who attended" recall at five | 0.803 | BM25: 0.182; plain hybrid: 0.247 | ahead (48 and 44 of 50 meetings, 0 behind) | [retrieval](retrieval/results.md) |
| PrecisionMemBench precision, tight mode | 0.586 | plain hybrid at one result: 0.563 | level (Holm p = 0.76) | [retrieval](retrieval/results.md) |
| Attacker's claim adopted in a later session | 1.5% to 5.0% | plain Postgres memory: 6.6% to 12.1% | ahead on all three models | [memory-trust](memory-trust/results.md) |
| Contradiction finding, Haiku 4.5 | 146/150; 0/40 and 4/51 flagged | plain prompt: 150/150; 24/40 and 29/51 flagged | ahead (49 vs 4, p = 7e-11) | [judgment](judgment/results.md) |
| Contradiction judging, four current models | 150/150, 0/251 each | plain prompt: Luna 27/251, Sonnet 13/251, Sol 0, Opus 0 flagged | ahead for Luna and Sonnet; level for Sol and Opus (ceiling) | [judgment](judgment/results.md) |
| Timeline events, Sonnet 4.6 | 37 and 38 of 38; 0.04 wrong per page | plain prompt: 33 and 36; 0.54 and 0.36 wrong per page | level by the page test (p = 0.06) | [judgment](judgment/results.md) |
| Memory page from a session, Sonnet 4.6 | 88.1% judged | plain prompt: 80.3% | ahead on judged recall (p = 0.005); level with quoted evidence | [judgment](judgment/results.md) |

Sonnet 5.5, Sonnet 4.6 and Haiku 4.5 are not models we test today. They run here only where the gbrain row used them,
so each pair matches. Every page above lists what it could not verify and how to reproduce it.

## Disclosures

gbrain is Garry Tan's own project.

Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator. Garry Tan runs Y Combinator.
