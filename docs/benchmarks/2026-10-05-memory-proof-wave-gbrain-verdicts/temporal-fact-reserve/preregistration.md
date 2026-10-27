# Temporal fact reserve in query: preregistration

Copied from garrytan/gbrain `docs/eval/decisions/temporal-fact-reserve/README.md` (#6066) when it was written, before any code or gated run.


Not built and not measured. The gates below are written before any code or gated run. The change sits behind
`search.temporal_fact_reserve`, which is off by default. With the key off, and for every query without a temporal
cue, `query` returns exactly what it returns today.

## Why

On BEAM's temporal-reasoning and event-ordering questions, the harness lane's combined arm (pages through `query`
plus `recall`'s facts) scores 0.49, against 0.72 for the comparator. Date grounding (#6020) did not move it, because
dated facts rarely reach the prompt:

- `recall` returns the newest 100 facts, and only 3-6% of those carry a real date.
- The `query` facts arm only uses spare rows, and a `limit: 50` page query leaves none.

## The change

With the key on, a `query` whose text carries a temporal cue gives saved facts a bounded share of the token budget.

- **Temporal cue.** Deterministic, no model call. The query matches, case-insensitively, one of: the words `when`,
  `before`, `after`, `since`, `until`, `till`, `during`, `ago`, `earlier`, `later`, `earliest`, `latest`,
  `first`, `last`, `previous`, `next`, `date`, `dates`, `day`, `week`, `month`, `year`, `order`, `sequence`; the
  phrases `how long`, `how many days`, `how many weeks`, `how many months`, `how many years`, `what time`; an ISO date
  (`YYYY-MM-DD`); or a month name.
- **Budget.** The reserve applies only when the call has a token budget: the caller's `token_budget`, or the budget
  evidence delivery resolves for `return_unit`. Without one, `query` behaves as today (the facts arm's spare-capacity
  rows).
- **Share.** Facts take at most 15% of that budget, counted with the search token estimator, and at most 20 rows.
  Pages fill the rest. The row count never grows: a fact row takes a free row, else the lowest page row.
- **Candidates.** Active facts only, under the same read policy as the facts arm (source scope, world facts only for
  remote callers, audit rows excluded): the 50 nearest by the query embedding `query` already computed, plus the 50
  best keyword matches, plus the named entity's facts.
- **Ranking by the question.** Each candidate scores its cosine similarity to the query (0 without an embedding) plus
  the share of query terms its text contains, plus 0.1 when it carries a real date. A real date means `valid_from`
  differs from `created_at` by more than a day, which is true when the writer supplied the date. A candidate is kept
  when its cosine is at least 0.5 or its term share at least 0.34. The best-scoring facts fill the reserve.
- **Rendering.** Reserved facts are fact rows (`result_type: "fact"`), each with its date header (`[observed
  unknown; valid FROM ...]`), placed after the page rows in date order, oldest first.
- **No model call** is added on the read path.

## Gates

1. **Harness lane, BEAM dev, combined lane, 8k token budget** (gbrain-evals harness provider). The same build, the
   same cells and seeds, `search.temporal_fact_reserve` on vs off.
   - **Rule:** paired over the same questions, the key-on arm scores higher on temporal reasoning and higher on event
     ordering, and its pooled score over all BEAM dev categories is not lower.
2. **No recall loss on the evals that cover `query`** (`evals/entity-anchoring/regression.ts`): NamedThingBench, the
   relational retrieval-quality fixture, the LongMemEval nightly fixture, and the one-saved-fact-per-question copies
   of the first two. Each runs with the key on and off, once without a token budget and once with `token_budget:
   8000`.
   - Recall@10 is computed over page rows only.
   - **Rule:** no question's recall@10 is lower with the key on, in any set or budget setting. Each set reports how
     often the reserve fired.

**Decision.** The key becomes default-on only if both gates pass. Until then it stays off. The lane that runs gate 1
owns its spend. The spend cap for this lane's own runs is $10.

## Changelog

- 2026-10-06: gates preregistered before any code or gated run.
