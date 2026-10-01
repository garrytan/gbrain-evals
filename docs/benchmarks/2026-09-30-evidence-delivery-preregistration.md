# Evidence delivery: preregistration, power analysis and paid-run plan

**Status, 2026-09-30: preregistered, then run the same day.** Results and the verdict (`page_only`) are in the [report](2026-09-30-evidence-delivery.md). Everything below was written before any paid arm ran, except this status line, the gbrain pin (step 0) and the recomputed power-report hash; a plumbing smoke test ($0.97) ran before the pin. This document fixes the question, the arms, the decision rule and the budget before any measurement. The executable rule is [decision-manifest.json](2026-09-30-evidence-delivery/decision-manifest.json); the code that applies it is `eval/runner/evidence-delivery/decision.ts`. Where this prose and the manifest differ, the manifest wins.

## The question

[gbrain](https://github.com/garrytan/gbrain) search returns ranked text chunks. On [LongMemEval](https://arxiv.org/abs/2410.10813), a reader that saw the whole conversations behind the top five chunks answered 89 of a fixed 100 questions; the same reader given only the five chunks answered 65 ([2026-09-29 report](2026-09-29-longmemeval-opaque-qa.md), reranker off). gbrain is adding an opt-in evidence-delivery stage (`return_unit`: `chunk`, `window`, `section`, `page` or `auto`) so an agent can get the surrounding evidence in one call.

This study asks: with the reranker on and retrieval held fixed, which delivery policy recovers most of the difference between chunks and whole pages, at no more than half the reader input tokens of whole pages?

An invented example: *"Did I return the blue widget before or after I bought the second one?"* The answer needs two conversations and their dates. A chunk may hold the purchase sentence but not the return, or the return without its date.

## What is held fixed and what changes

Retrieval is frozen once at a pinned gbrain commit with R1's settings (reranker `voyage:rerank-2.5`, top five, balanced mode, no autocut, no query expansion, `text-embedding-3-large` at 1,536 dimensions). The frozen manifest stores, for every question, the ordered top-5 and top-10 hits with chunk text and index, every chunk of every hit page, the harness reader's page text, and each arm's delivered evidence with gbrain's own fingerprint. Everything is content-addressed by SHA-256. Agreement with R1's lists is reported; no question is dropped for differing.

Every arm then uses one reader request builder: the house notes reader (`anthropic:claude-sonnet-4-6`, the R1 system text with SHA-256 `3db7ccbb…`, 1,024 output tokens, provider-default temperature), gbrain's `renderChatBlock` (one `<chat_session>` block per delivered block, opaque session id and date), and both judges. Only the delivered evidence differs. A test proves the request is identical across arms apart from the evidence section.

| Arm | Role | Evidence |
|---|---|---|
| `chunk` | baseline | the five ranked chunks, one block each |
| `window1`, `window2` | candidates | hit chunk plus 1 or 2 neighbors each side, 6,000-token budget (the product default) |
| `section` | candidate | enclosing section or conversation round, 6,000 tokens |
| `auto4k`, `auto6k`, `auto7_5k` | candidates | the product's `auto` rule at 4,000, 6,000 and 7,500 tokens |
| `page` | reference | the product's whole-page unit (only the 60,000-character block cap binds) |
| `k10` | comparator | top-10 chunks packed to 6,000 tokens; cannot win |
| `page_legacy` | control | the harness reader's own page text, byte-identical to R1's requests |
| `agent_fetch` | agent arm | the chunk request plus a `get_page` tool (5 fetches, 6 turns); reported separately |

Product arms come from gbrain's shipped `assembleEvidenceForHits`, called as a trusted local caller on the frozen hits. The study never re-implements a policy.

## Decision rule (summary of the manifest)

- **Sets.** The fixed 100-question pilot (`subset100_seed20260929.txt`) is used only to choose candidates. The other 400 questions are the confirmatory set. LongMemEval-S is development data, so even a significant result here is development evidence.
- **Judges.** gbrain's framed judge is primary. The verbatim official LongMemEval judge must not reverse a success; it never rescues a failure.
- **Pilot selection.** Candidates whose mean provider-reported input tokens exceed half of `page`'s are ineligible. The two eligible candidates with the most correct answers advance (ties: fewer tokens, then list order).
- **Gap.** `gap = correct(page) - correct(chunk)` on the 400. If the gap is not positive with exact McNemar p < 0.05, the outcome is *no demonstrated benefit*.
- **Success** for a candidate P, all on the 400: `correct(P) >= correct(chunk) + 0.6 x gap` (point estimate); mean provider input tokens of P at most 0.5 x `page`'s; P beats chunk with both the Holm-adjusted exact McNemar p and the Holm-adjusted cluster sign-flip p below 0.05, Holm over all six candidates with the untested ones at p = 1; and no question type loses more than two questions net against chunk.
- **Outcomes.** *success* (one winner), *page_only* (gap real, no candidate succeeds: page ships opt-in), *no_demonstrated_benefit*, or *inconclusive* (missing rows, more than 2% reader errors in an arm, or the confirmation judge reversing a success).
- **Errors.** Reader errors after resume passes count as incorrect for both judges; a judge error counts as incorrect for that judge; truncated answers are judged as written.
- **Clusters.** Questions whose gold evidence sessions overlap form one cluster ([cluster-map.json](2026-09-30-evidence-delivery/cluster-map.json): 490 singletons and 5 pairs).
- **E2, sealed set.** Only after a success and a passing E3. Chunk against the winner on the 150 sealed questions (30 personas). Pass: winner - chunk >= -2 questions and the persona-clustered 95% interval's upper bound >= 0, and the confirmation judge's difference also >= -2. The labels open once, with a non-empty decision id, through the access-logged runner.
- **Scope of any flip.** Transcript and chat sources only, with an opt-out and a tested kill switch.

The keyless suite `test/eval/evidence-delivery-decision.test.ts` exercises close wins at the hurdle, zero and negative gaps, a sparse stratum, judge disagreement, selection among six policies, tie-breaks, and failed provider calls.

## Power analysis

`bun eval/runner/evidence-delivery.ts power` runs the exact decision code on seeded simulations ([power-analysis.json](2026-09-30-evidence-delivery/power-analysis.json); 400 simulations per confirmatory cell). Page accuracy per question type comes from R1; the gap is spread across types like the 2026-09-29 chunk losses; 3% of concordant answers flip as reader noise. Chunk accuracy on reranker-on lists has never been measured, so it is a scenario axis.

Probability that a candidate succeeds, by its true share of the gap closed:

| Chunk accuracy | Mean gap (of 400) | closes 50% | closes 60% | closes 70% | closes 80% | closes 100% |
|---|---|---|---|---|---|---|
| 0.65 | 106 | 0.06 | 0.46 | 0.82 | 0.86 | 0.88 |
| 0.72 | 77 | 0.09 | 0.47 | 0.76 | 0.85 | 0.87 |
| 0.80 | 45 | 0.16 | 0.39 | 0.65 | 0.76 | 0.76 |

What this means:

- The page - chunk gap is established in essentially every scenario.
- The 60% hurdle is a point estimate, so a policy that truly closes exactly 60% passes about half the time. A policy closing 70% or more passes 65% to 82% of the time.
- **The per-type rule costs power.** Even a policy as good as `page` fails the "at most two net losses in every type" rule in 12% to 24% of simulations, because reader noise alone produces net losses in types with no gap to win back (single-session assistant and preference questions). The rule is kept as preregistered; the owner may want to revisit it before the confirmatory run.
- Pilot selection keeps a candidate that closes at least 60% in 92% to 100% of simulations when candidates are spread out, but only 50% to 77% when one good candidate hides among five similar ones.
- **E2 is a weak and strict check.** With a truly equal winner, E2 passes 72% to 84% of the time and rejects 6% to 20% of the time, because two questions is small against reader noise on 150 questions. It rejects a true 5-point regression 88% to 96% of the time. The floor is kept as preregistered and flagged for the owner.

## The paid runs, in order

Every step joins one campaign run in the budget ledger (`campaign-open --budget-usd 400`), so the $400 plan cap binds across all of them, including gbrain's own subprocess requests during E3. Estimates are at list prices from measured token counts (`bun eval/runner/evidence-delivery.ts costs`).

| Step | What runs | Estimate |
|---|---|---|
| 0 | Pin `candidate_commits.gbrain` to the gbrain PR head in its own commit | $0 |
| 1 | Freeze all 500 questions at that commit; parity check against R1's logged requests | $8.24 |
| 2 | E1 pilot: 10 arms x 100 questions, both judges | $30.47 |
| 3 | E1b agent_fetch on the pilot | $10.22 |
| 4 | Pilot selection (keyless), then E3: 100 pilot questions through MCP stdio for `page` and the two advanced arms, scored from the serialized product evidence | $5.50 |
| 5 | E1 confirmatory: chunk, page and the two advanced candidates x 400 | $48.92 |
| 6 | gpt-4o reader: chunk and the winner (or the better advanced candidate) x 400 | $13.46 |
| 7 | E2 sealed confirmation, only after a success | $5.24 |
| | **Total** | **$122.05** ($152.57 with a 25% retry margin; cap $400) |

## Smoke test (plumbing only)

On 2026-09-30 the whole chain ran against the WIP gbrain branch `capy/evidence-delivery` at `51144975b` (not the candidate) for $0.97 through the ledger ([smoke-2026-09-30.json](2026-09-30-evidence-delivery/smoke-2026-09-30.json)):

- Froze 5 pilot questions with all 10 arms. 4 of 5 top-five lists were identical to R1's.
- The harness `page_legacy` request was byte-identical to R1's logged request on all 4 identical-list questions.
- The product `page` text is not byte-identical to the harness text. All 24 blocks drop the page frontmatter, which is expected because chunks exclude it, and 9 of 24 lose a paragraph break (`\n\n` becomes `\n`) where two chunks are stitched. That is why `page_legacy` stays in the pilot as a control.
- Over MCP stdio as a remote caller, `assemble_evidence` reproduced the frozen local fingerprints and delivered-token counts for `page` and `window1`, `query` matched `assemble_evidence` over the same hits, and no delivered segment was absent from its page. One of two questions showed live retrieval drift because the product `query` path runs LLM query expansion by default.
- Three questions per arm answered and judged with all three token counts recorded; the agent arm fetched 1 to 3 pages per question. Three questions say nothing about any policy.

## Reproduce

From the repository root, with `GBRAIN_DIR` pointing at the pinned gbrain checkout, the dataset from [LongMemEval](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned) (SHA-256 `d6f21ea9…`), and `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `VOYAGE_API_KEY` set:

```bash
bun eval/runner/evidence-delivery.ts power                        # keyless
RUN=$(bun eval/runner/evidence-delivery.ts campaign-open --budget-usd 400)
bun eval/runner/evidence-delivery.ts freeze --dataset data/longmemeval_s_cleaned.json --out-dir eval/reports/evidence-delivery/frozen --set all --budget-run-id $RUN
bun eval/runner/evidence-delivery.ts parity --frozen-dir eval/reports/evidence-delivery/frozen --dataset data/longmemeval_s_cleaned.json
bun eval/runner/evidence-delivery.ts e1 --frozen-dir eval/reports/evidence-delivery/frozen --dataset data/longmemeval_s_cleaned.json --out-dir eval/reports/evidence-delivery/e1 --set pilot --arms chunk,window1,window2,section,page,auto4k,auto6k,auto7_5k,k10,page_legacy,agent_fetch --budget-run-id $RUN
bun eval/runner/evidence-delivery.ts analyze --rows-dir eval/reports/evidence-delivery/e1 --stage pilot --frozen-dir eval/reports/evidence-delivery/frozen
```

The runner refuses a paid step when the decision manifest is uncommitted, when the frozen evidence was made at another gbrain commit, when the reader system text differs from the pin, when `page_legacy` does not reproduce R1's bytes, or when a confirmatory run lists arms the pilot did not advance.
