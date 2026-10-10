# Packing for depth loses on held-out questions: H1 of the budgeted delivery plan fails (2026-10-10)

## The finding

[gbrain](https://github.com/garrytan/gbrain) is a memory system for agents. When an agent searches its memory with a
token budget, gbrain ranks short passages (chunks) and then decides how much of each matching conversation to hand
back inside that budget. That step is packing, set by `search.auto_packing`. Since gbrain
[#6367](https://github.com/garrytan/gbrain/pull/6367), an explicit budget is a hard cap and the shipped packing is
`cap_only`: today's order, stopped at the budget. [E2](2026-10-09-gbrain-budgeted-delivery-e2.md) found on
development data that `depth_first` (the top conversations handed over whole, in rank order, while they fit) answered
12 points more LongMemEval-S questions than `cap_only`, and sent it to this held-out test.

**On the 200 held-out questions of sealed confirmation v2, `depth_first` answered 122 and `cap_only` 145.** That is
−11.5 points, with a persona-clustered 95% interval of −18.0 to −4.5; `depth_first` won 14 questions and lost 37
(exact McNemar p = 0.0018). The loss is concentrated in multi-session questions, which need three or four chats months
apart: 15 of 80 against 40 of 80. **By the preregistered rule the verdict is `fail`,** on two counts: the whole
interval is below zero, and guard 7 finds a clear loss in multi-session (5 wins, 30 losses, one-sided McNemar
p = 1.1e-5). All three readers agree.

`cap_only` stays gbrain's default for explicit budgets. `depth_first` stays opt-in, is not tested again on this set,
and nothing is tuned on it. Callers that pass no budget are unaffected: without a budget every packing delivered the
same bytes on all 200 questions (guard 1).

Tested configuration: gbrain `8a3eedeacb6e52da5b413502019692db80c5cc5d` (v0.60.126.0, the `package.json` pin), loaded
as a copied overlay of a checkout at that commit; budget 5,500 gbrain tokens for an 8,000-token reader budget; one
frozen 25-hit ranked list per question shared by every arm; E2's pseudo-session rendering; reader `claude-sonnet-5-5`;
judge `gpt-4o-2024-08-06` with LongMemEval's per-kind prompts. The rule was committed before custody
([preregistration](2026-10-10-gbrain-budgeted-delivery-h1-preregistration.md), merged to main as `9b200886`, v0.10.70);
the run used that commit, and the decision file it read hashes to `3c2e8c20…`, the committed file.

## The concrete case

[Sealed confirmation set v2](2026-10-01-sealed-confirmation-v2-protocol.md) is 200 questions written for 40 invented
personas. Each history holds 46 chats and about 143,000 tokens. There are 80 multi-session questions needing three or
four chats, 40 temporal questions needing two or three, 40 knowledge-update questions needing three or four, and 40
abstention questions, where the right answer is that the detail never came up. Nobody has tuned against it.

**Invented example, not from the set:** over a year a user mentions three pottery studios, each in a different chat,
among dozens of unrelated chats, then asks how many studios they have tried. Search finds about 25 matching passages.
With 5,500 gbrain tokens:

- `cap_only` hands over a matching piece of about 10 conversations, so the reader sees a mention from each studio's
  chat, often enough to count them.
- `depth_first` hands over about 3 whole conversations in rank order. If the top three include one studio chat and two
  near misses, the reader never sees the other two studios.

## The experiment and results

**Construction** (fixed in [`decision.json`](2026-10-10-gbrain-budgeted-delivery-h1/decision.json)). One `query` call
per question froze the ranked list: 25 hits, chunk unit, no budget, real `text-embedding-3-large` embeddings at 1,536
dimensions and gbrain's default reranker. Every arm was then delivered from that same list through
`assembleEvidenceForHits` with a per-call `auto_packing`, so the arms differ in delivery only. The reader saw each
delivered block as a dated session under LongMemEval's reading prompt, packed to 8,000 harness tokens (characters
divided by four), with cuts counted. Arms: `depth_first` (candidate) and `cap_only` (control), both at 5,500 gbrain
tokens; references `off` (the budget is not a cap, the behavior before #6367) at the same budget and `off` on the
first five hits. Readers: Sonnet 5.5 decides; Opus 5.5 and gpt-6.1-sol replay the candidate and control contexts and
decide nothing. A reader error or an empty answer counts as wrong.

### What each arm delivered (200 questions)

| Arm | gbrain tokens (mean) | Over budget | Blocks | Conversations | Reader tokens (mean) | Reader packer cuts |
|---|---:|---:|---:|---:|---:|---|
| `off` | 10,323 | 200 of 200 | 18.7 (8.8 spilled) | 18.7 | 7,590 | 1,578 blocks cut, on every question |
| `cap_only` | 5,491 | 0 | 9.9 | 9.9 | 6,730 | none |
| `depth_first` | 5,466 | 0 | 3.0, all whole conversations | 3.0 | 6,697 | none |
| `off`, first five hits | 5,489 | 0 | 4.9 | 4.9 | 6,723 | none |

Source: [`results/gate.json`](2026-10-10-gbrain-budgeted-delivery-h1/results/gate.json). Every context carried E2's
recipe hash and renderer and re-rendered to the exact bytes the reader got (1,600 of 1,600).

### Answer accuracy, judged correct (Sonnet 5.5, paired)

| Question kind | n | `off` | `cap_only` | `depth_first` | first five hits | `depth_first` won / lost against `cap_only` |
|---|---:|---:|---:|---:|---:|---|
| Multi-session | 80 | 38 | 40 | **15** | 40 | 5 / 30 |
| Temporal reasoning | 40 | 25 | 26 | **32** | 30 | 8 / 2 |
| Knowledge update | 40 | 39 | 39 | **35** | 40 | 1 / 5 |
| Abstention | 40 | 40 | 40 | 40 | 40 | 0 / 0 |
| **All (primary)** | **200** | **142 (71.0%)** | **145 (72.5%)** | **122 (61.0%)** | **150 (75.0%)** | **14 / 37** |

### The preregistered decision

| Test | Result |
|---|---|
| `depth_first − cap_only`, 200 questions, 40 persona clusters | −11.5 points, 95% cluster-bootstrap interval −18.0 to −4.5 |
| Exact two-sided McNemar | 14 wins, 37 losses, p = 0.0018 (persona sign-flip p = 0.0036) |
| Superiority (interval above zero and McNemar p < 0.05) | not shown; the whole interval is below zero, which is a `fail` |
| Guard 7 (no kind with a clear loss, exact one-sided McNemar p < 0.05) | **fails** on multi-session: 5 wins, 30 losses, p = 1.1e-5. Temporal (8 / 2), knowledge update (1 / 5, p = 0.11) and abstention (0 / 0) pass |
| Guard 8 (abstention not worse) | passes: 40 of 40 in both arms |
| Reader errors | 0 in every arm; empty answers 1 (`depth_first`), 2 (`cap_only`), 1 (`off`), judged wrong |
| **Verdict** | **`fail`** |

Receipts: [`decision-outcome.json`](2026-10-10-gbrain-budgeted-delivery-h1/results/decision-outcome.json) (the rule as
`h1.ts decide` applied it), [`compare/primary.json`](2026-10-10-gbrain-budgeted-delivery-h1/results/compare/primary.json)
(the `compare.ts` output under the committed family) and the per-arm score aggregates in
[`results/scores/`](2026-10-10-gbrain-budgeted-delivery-h1/results/scores/). The guard 7 entries also carry a
`threshold` field, the plan's old point limit that E2's kind helper still reports; the rule did not use it.

### Three readers (decide nothing)

| Reader | `cap_only` | `depth_first` | Difference (95% interval) | Won / lost | Multi-session, `cap_only` → `depth_first` |
|---|---:|---:|---|---|---|
| `claude-sonnet-5-5` (decides) | 145 | 122 | −11.5 (−18.0 to −4.5) | 14 / 37 | 40 → 15 |
| `claude-opus-5-5` | 138 | 122 | −8.0 (−15.0 to −1.0) | 21 / 37 | 36 → 15 |
| `gpt-6.1-sol` | 144 | 121 | −11.5 (−18.0 to −5.0) | 15 / 38 | 40 → 14 |

Every reader gains on temporal questions with `depth_first` (26 → 32, 23 → 32, 25 → 32) and loses on multi-session
and knowledge-update questions. The loss is in what was delivered, not in how one model read it.

### Descriptive arms (Sonnet 5.5, decide nothing)

| Comparison | Difference (95% interval) | Won / lost | McNemar p |
|---|---|---|---:|
| `depth_first − off` | −10.0 (−17.0 to −3.0) | 18 / 38 | 0.010 |
| first five hits − `cap_only` | +2.5 (−1.0 to +6.5) | 10 / 5 | 0.30 |
| `depth_first` − first five hits | −14.0 (−20.0 to −7.5) | 11 / 39 | 9.0e-5 |

`off` on the first five hits scored highest (150), but its difference from `cap_only` is not distinguishable from
zero, and these comparisons have no multiplicity correction because they decide nothing.

### Guards

| Guard | Result |
|---|---|
| 1. No budget: every packing's evidence bytes equal `off`'s | 200 of 200 questions |
| 3. Every `depth_first` delivery within 5,500 and reporting its packing | 200 of 200 (`cap_only` and the five-hit arm too; `off` over budget on all 200, as expected) |
| 4. Every `depth_first` reader context within 8,000 harness tokens, no cuts | 200 of 200 (the control also had no cuts) |
| 5. One frozen list per question, every arm delivered | 200 of 200 |
| 6. Default budget | exact by guard 1 |
| 7. No kind with a clear loss | **fails**: multi-session |
| 8. Abstention not worse | passes, 40 = 40 |
| 9. Latency | carried from E2's dev reading (p95 1.04 times `off`'s); no live sealed call |

Both evidence gates ([`gate-deliver.json`](2026-10-10-gbrain-budgeted-delivery-h1/results/gate-deliver.json) before any
reader call, [`gate.json`](2026-10-10-gbrain-budgeted-delivery-h1/results/gate.json) after the readers) passed before
any label was read.

### Why depth lost

Packed recall counts the answerable questions whose every gold chat appears, at least in part, in what the reader saw:

| Kind (answerable n) | `off` | `cap_only` | `depth_first` | first five hits |
|---|---:|---:|---:|---:|
| Multi-session (80) | 79 | 79 | **16** | 76 |
| Temporal reasoning (40) | 40 | 40 | 34 | 40 |
| Knowledge update (40) | 40 | 40 | **26** | 40 |
| **All answerable (160)** | **159** | **159** | **76** | **156** |

Every arm put at least one gold chat in front of the reader on all 160 answerable questions; the difference is whether
it put all of them there. With 5,500 gbrain tokens `depth_first` fits about 3 whole conversations, and the top three
of the 25 ranked hits held every gold chat for only 16 of the 80 multi-session questions and 26 of the 40
knowledge-update questions. `cap_only` reached pieces of about 10 conversations and touched every gold chat on 159 of
160. On sealed v2 the answer to a multi-session question is spread over three or four chats months apart, so breadth
matters more than reading any one chat whole. Temporal questions, which need two or three chats and often hinge on the
date context around one mention, are the one kind where whole conversations helped (26 → 32).

Packed recall is descriptive: a chat counts as delivered when any of its text reached the reader, which for `cap_only`
can be a passage that does not hold the answer. It decides nothing.

For context only: release decision 1 on this set ([report](2026-10-02-sealed-v2-decision-1.md)) delivered whole
conversations for five hits within a 24,000-token default budget and answered 76 of 80 multi-session questions. Whole
conversations help when the budget holds enough of them. That decision used a different renderer, reader and hit
count, so its numbers are not comparable with these.

## What E2 predicted and what happened

E2's report named the risk: on LongMemEval-S multi-session questions `depth_first` gained only 4 points over `cap_only`
and trailed `breadth_capped` by 10.5, and "the held-out set is mostly multi-session". The preregistration's power
estimate, simulated from E2's paired rows before custody, gave:

| Scenario | P(pass) | P(fail) | What sealed v2 showed |
|---|---:|---:|---|
| E2's effects carry over (multi-session +4.1) | 68.7% | 0.4% | no |
| Multi-session gains nothing | 39.1% | 4.6% | no |
| Multi-session truly loses about 5 points | 26.3% | 15.5% | no, the loss was larger |
| Multi-session behaves as E2's `breadth_capped` pairs (−11.6) | 5.5% | 60.8% | **yes, and worse** |
| No effect anywhere | 1.3% | 10.8% | no |

The run landed in the scenario where multi-session rewards breadth, and beyond it: multi-session fell 31.3 points
(40 → 15 of 80) against the scenario's 11.6. Two things none of the scenarios modeled: knowledge update reversed
(+19.4 points on LongMemEval-S, −10.0 here; sealed v2's knowledge-update questions need three or four chats), and
temporal transferred exactly (+15.0 on LongMemEval-S, +15.0 here). The delivery numbers point to why the development
win did not transfer: on LongMemEval-S `depth_first`'s 2.4 conversations held every gold session for 365 of 470
answerable questions, and here its 3.0 conversations held every gold chat for 76 of 160. Sealed v2 asks for more
chats per question than its 5,500-token budget can hold whole.

## What to use and what to avoid

- **Explicit budgets:** keep `cap_only`, gbrain's default. It answered 145 of 200 here and was not beaten by any
  packing with a confirmed difference.
- **Avoid `depth_first` for histories where answers span several chats** at tight budgets. It remains available as
  an opt-in packing; this result is about 5,500 gbrain tokens and the 25-hit list, and E2's single-conversation and
  date gains on LongMemEval-S still stand as development evidence.
- **No budget:** nothing changes. Every packing delivered the same bytes without a budget on all 200 questions.
- **The sealed set:** `depth_first` is not tested on it again and nothing is tuned on it. This was opening 2 of the 3
  the protocol allows; the third stays in reserve, and any candidate for it needs its own development evidence and
  preregistration.

## Deviations and notes

- **One freeze resume.** In the first freeze attempt, shard 2 of 4 failed at startup with `SQLiteError: database is
  locked` while switching the embedding cache to write-ahead logging (`eval/runner/longmemeval-cache.ts:68`). Under
  the sealed profile all four shards share the one embedding cache inside the custody root, and the shards contended
  for it despite its 10-second busy timeout. That lease settled at $0.64. `h1-run.sh all` was rerun unchanged and
  resumed: finished shards were kept and shard 2 completed. This is one of the three resume passes the
  preregistration allows. No label had been read. Both freeze leases are in the ledger: $0.86 over 2 leases
  ([`ledger/summary.json`](2026-10-10-gbrain-budgeted-delivery-h1/results/ledger/summary.json)).
- **Connection drop.** The custodian Mac dropped its Capy connection around 22:04 UTC. The process kept running, and
  the chain exited 0 with the verdict at 22:10 UTC.
- **Access log.** The owner's log went from 6 to 35 lines. The first 6 are unchanged (the custody check matched them
  to the decision file before anything ran), and all 29 new lines are under decision id
  `sealed-v2-decision-2-2026-10-10:depth-first-vs-cap-only`. The gates recorded 19 lines at the delivery gate and 27
  at the final gate, so 21 of the new lines are opens written before the final gate and the last 8 are the label
  reads. Labels were read 8 times, as expected, all after the final gate. The log was
  returned to the owner's directory, and `labels.json` is mode 000 in the custody root.
- **Guard 7 changed before custody.** The plan's point rule was replaced with the clear-loss test on Garry's decision
  of 2026-10-10, before any sealed file was copied (preregistration, "Guard 7 was changed before custody"). Under the
  old rule the verdict would also have been `fail`: multi-session fell 25 questions and knowledge update 4, both past
  their limits of 1.6 and 1.
- **Control and pin**, both disclosed in the preregistration: the control is the shipped `cap_only`, not the plan's
  `off`, and the run measured the pin rather than E2's `ca2c447bd` because gbrain's token estimator changed between
  them.
- **Export.** `h1.ts export` wrote the aggregates and scanned them against every question, chat and persona id of the
  sealed corpus before the custodian copied them out. This repository holds its 56 JSON files unchanged; 65 macOS
  `._` metadata files that came with the copy were left out. A second scan here found no path, key or per-question
  list; `question_id` and `haystack_id` appear only as the family's field names.

## Reproduce and inspect

Run on the custodian's Mac under `~/gbrain-heldout-custody/h1-sealed-v2/`, with gbrain-evals and gbrain checked out
under `~/gbrain-heldout-custody/h1-work/` and Bun 1.4.2 pinned inside the root:

```bash
git checkout 9b200886 && bun install --frozen-lockfile        # gbrain-evals v0.10.70
git -C <gbrain checkout> fetch origin 8a3eedeacb6e52da5b413502019692db80c5cc5d
# ANTHROPIC_API_KEY (readers), OPENAI_API_KEY (embeddings, gpt-6.1-sol, judge), VOYAGE_API_KEY (reranker)
H1_SEALED_SRC=<owner's private directory> \
  bash eval/runner/budgeted-delivery/h1-run.sh all ~/gbrain-heldout-custody/h1-sealed-v2 <gbrain checkout>
```

The chain and every step are described in the preregistration's "Custody" section. The aggregates are in
[`results/`](2026-10-10-gbrain-budgeted-delivery-h1/results/): the custody check, both gates, the decision outcome,
the per-arm score aggregates (answers by kind and packed recall), the `compare.ts` outputs, the answers summary, the
ledger summary and the memory-qa per-arm aggregates. The sealed files, answers and per-question scores stay with the
owner. Wall time from the custody check (21:05 UTC) to the verdict (22:10 UTC) was about 65 minutes, including the
freeze resume.

### Cost

| Step | Estimate | Spent | Lease cap |
|---|---:|---:|---:|
| Freeze (2 leases) | $1.50 | $0.86 | $5 per lease |
| Deliver | $0 | $0 | $0.50 |
| Sonnet 5.5 readers, 800 calls | $19 | $18.56 | $57 |
| Opus 5.5 and gpt-6.1-sol readers, 800 calls | $24.50 | $25.95 | $74.50 |
| Judge, 1,600 calls | $2 | $1.52 | $8 |
| **Total** | **$47** | **$46.89** | **$145** |

Spend is the lease proxies' settled total from reported usage at list prices. No step passed twice its estimate. The
budgeted delivery program has now spent about $50 on E1, $178.46 on E2 and $46.89 on H1, against its $1,500 cap.

## Changelog

### 2026-10-10: published

First version, from the custody export of the run on main `9b200886`.
