# N2 and A4 paid arms: preregistration

Frozen on 2026-10-01, before the first N2 or A4 run (hermetic or paid), in the same commit as the promotion rules in `eval/registry.ts`. Nothing below changes after a run; a later change gets a new dated file.

Code under test: gbrain `3a284aea26889b77c633aebb4149c3016d834ee6` (v0.60.26.0), loaded as a copied overlay (`--gbrain <checkout>@3a284aea`). Worlds: `eval/generators/n2-contradiction-gen.ts` and `eval/generators/a4-abstention-gen.ts` at seed 20261001 (their ledger hashes go in every receipt). Paid arms run only with `--paid --budget-run-id <id>` through `eval/runner/paid-arm.ts` and the budget ledger. Paid numbers are report-only: they never gate.

System One stays off in every arm: the paid process gets exactly one provider key (`ANTHROPIC_API_KEY`), no TypeSafe key and a fresh `GBRAIN_HOME`, and retrieval stays keyword-only so the paid arm sees the same candidates as the hermetic arm.

## N2 contradiction surfacing, classification stage

**System under test.** gbrain's own contradiction judge, `judgeContradiction` (`src/core/eval-contradictions/judge.ts`, prompt version 2), called by `runContradictionProbe` with the model gbrain picks by default for an Anthropic key: `resolveTierDefault('utility')` = `anthropic:claude-haiku-4-5-20251001`. Top-K 5 (the default), deterministic sampling, cache off, probe budget $6 with `yesOverride` (the probe's own mid-run stop stays active; pairs it does not reach count as capped misses). The judge is the treatment, never the oracle.

**Gold.** The generator ledger: a judged pair is a planted item only when its two slugs are the item's pages and each chunk carries its side's claim span. Every other pair is compatible by construction. Classes: `contradiction` (same-time conflict), `temporal` (dated change; gbrain's `temporal_supersession`, `temporal_regression` and `temporal_evolution` all count as temporal), `compatible` (holder opinions, agreement, namesakes, negation, and every unplanted pair). gbrain's `negation_artifact` and `no_contradiction` count as "not a contradiction".

**Metrics and denominators.**

| Metric | Numerator | Denominator |
|---|---|---|
| End-to-end conflict recall (headline) | planted same-time conflicts judged `contradiction` under any query | all 150 planted same-time conflicts (missed and capped stay in) |
| Classification recall on offered conflicts | offered conflicts judged `contradiction` | planted conflicts offered to the judge |
| False-contradiction rate, dated changes | offered dated changes judged `contradiction` | dated changes offered |
| False-contradiction rate, compatible negatives | offered compatible items judged `contradiction` | compatible items offered |
| False-contradiction rate, unplanted pairs | distinct unplanted pairs judged `contradiction` at least once | distinct unplanted pairs judged |
| Judged-pair precision | planted conflicts judged `contradiction` | all distinct pairs judged `contradiction` |
| Temporal recognition | offered dated changes judged any temporal verdict | dated changes offered |
| Judge errors | error rows | pairs offered |
| Resolution acceptability | findings whose proposal is acceptable (below) | findings on planted conflicts and dated changes |

An acceptable proposal is non-destructive and matches the gold class: for a same-time conflict, `manual_review` or `dream_synthesize` (a proposal that picks a winner, such as `temporal_supersede` or `takes_supersede`, is not acceptable, because nothing in the text says which value is right); for a dated change, `temporal_supersede` naming the older page as the superseded side, `log_timeline_change` or `flag_for_review`. Proposals are never applied; the hermetic safety contract checks that.

**Decision rules (report wording only).** gbrain's judge "separates same-time conflicts from dated changes" on this world only if classification recall on offered conflicts is at least 0.80, the false-contradiction rate on offered dated changes is at most 0.10 and on offered compatible negatives at most 0.10. Otherwise the report says which rule failed. End-to-end recall is always reported beside candidate recall so a judge result is never read without the retrieval loss in front of it. Each rate is reported per variant (dated, undated and mixed same-time conflicts; frontmatter, text-only and falling dated changes), because undated pages are expected to behave differently.

**Amara-life development arm.** The 15 pairs of `eval/data/gold/contradictions.json`, imported with the rest of the amara-life notes, meetings and emails, one supplied query per pair (`eval/data/gold/contradictions-n2-queries.json`, written before any run). Scored twice: against the original labels and against `eval/data/gold/contradictions-adjudication.json`. Development data, never a headline.

**Cost estimate.** At most 285 queries times 10 cross-page pairs = 2,850 judge calls; about 700 input and 100 output tokens per synthetic pair, about 1,100 input for amara chunks; at $1 and $5 per million tokens that is about $4. Arm cap: $8.

## A4 abstention, answer stage

**The answerer, defined explicitly.** gbrain has no keyless answerer (think without a chat model returns its gather without an answer), so A4's answerer is gbrain's house reader used as a fixed harness reader: system text `READER_NOTES_SYSTEM_TEXT` and user text `buildReaderUserText` from `src/eval/longmemeval/reader.ts`, retrieved results rendered with `renderChatBlock` (one block per result, the page slug as its id), model `anthropic:claude-sonnet-4-6`, 1,024 output tokens, temperature 0, through gbrain's gateway `chat`. This is not think and not S4-enabled think. The reader's prompt frames evidence as chat history; the notes here are not chats, a disclosed mismatch.

**Arms.**
1. Retrieved: the top five results of the `query` operation (keyword only, expansion off).
2. Matched oracle evidence: the ledger's oracle pages for the same question (the answer-bearing page; for unanswerable questions the company's own profile, plus the sibling's page carrying the attribute, or for an absent company the profile of a company that has the attribute).
3. CRAG-gated: arm 1's answers, replaced by an abstention when the CRAG grade is below a level (strong; strong or moderate); computed from arms 1's answers, no extra calls.
4. S4 on: runs only if the budget guard can price TypeSafe requests. At this commit `eval/runner/budget-ledger.ts` prices OpenAI, Anthropic, Voyage and OpenRouter only, so a TypeSafe call would spend outside the guard; the arm is then recorded as not run, with that reason. S4 off is arm 1.

**Scoring (deterministic, from the ledger).** The final answer is the text after the last "final answer" marker, else the last paragraph. It is `correct` when it contains the gold value; `wrong_source` when it contains another company's value for the same attribute (the sibling's value counts here); `wrong` when it contains any other number or attribute value; `abstain` when it says the information is unavailable and states no value; otherwise `unscorable` (counted as an attempted, not correct, answer). A hedged answer that names a value counts as an answer.

**Metrics** (each per arm and per question class):

| Metric | Numerator | Denominator |
|---|---|---|
| Correct useful answer rate | correct | answerable questions (120) |
| False refusal rate | abstain | answerable questions |
| Unanswerable-answer rate | any attempted answer | unanswerable questions (120) |
| Abstain recall | abstain | unanswerable questions |
| Abstain precision | abstain on unanswerable | all abstentions (null when none) |
| Coverage | attempted answers | all 240 |
| Risk | wrong, wrong-source and unscorable answers | attempted answers (null at zero coverage) |
| Utility, lambda 1 and 4 | +1 correct, 0 abstain, minus lambda per wrong answer | all 240 |
| False-refusal cost | answerable questions refused in arm 1 that arm 2 answered correctly | answerable questions |

**Decision rules (report wording only).** The house reader "abstains usefully" on retrieved evidence only if abstain recall is at least 0.80 and the false refusal rate is at most 0.10. The CRAG grade "adds value as a gate" only if some gate level raises utility at lambda 1 over the ungated reader. The balanced 50/50 mix means abstain precision is not deployment precision, and the report says so.

**Cost estimate.** 240 questions times two arms = 480 reader calls; about 600 input and 250 output tokens each at $3 and $15 per million tokens, about $3. Arm cap: $6.

## Lane cap

Both arms together stay under the lane's $25 share of the $150 wave cap, enforced by one budget-ledger run opened for this lane.
