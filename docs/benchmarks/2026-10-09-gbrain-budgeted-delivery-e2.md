# How gbrain should pack an explicit token budget: E2 of the budgeted delivery plan (2026-10-09)

## The finding

gbrain is a memory system for agents: it stores conversations and notes as pages and hands an agent evidence for a
question through its `query` operation (see [gbrain](https://github.com/garrytan/gbrain)). When the agent passes a
token budget, gbrain's default evidence unit, `auto`, decides how much of each matching conversation to hand over.
[E1](2026-10-08-gbrain-budgeted-delivery-e1.md) found that at 8,000 tokens and the 25 hits `query` returns, `auto`
spends the budget on a matching chunk from every hit, overruns the budget on every question, and leaves the reader
fragments. gbrain [#6367](https://github.com/garrytan/gbrain/pull/6367) (v0.60.124.0, `ca2c447bd`) makes an explicit
budget a hard cap and adds three ways to share it, `search.auto_packing`. E2 compares them on development data,
read by the held-out reader, and picks which one goes to the held-out decision (H1). It sets no default.

**Packing for depth wins by about 10 points, and the cap alone does not help.** On all 500 LongMemEval-S questions,
read by Claude Sonnet 5.5 at an 8,000-token reader budget:

| Packing (what `auto` does with an explicit budget) | Score | Against today's `auto` (`off`) | Against `cap_only` |
|---|---:|---|---|
| `off`: today's behavior, budget not a cap | 69.0% | | |
| `cap_only`: today's order, budget enforced | 67.4% | −1.6 (−3.8 to +0.4) | |
| `breadth_capped`: the first few conversations with room around each match, then grow them | 77.8% | **+8.8 (+5.2 to +12.2)** | +10.4 (+6.8 to +13.8) |
| `depth_first`: conversations in rank order, each whole if it fits | **79.4%** | **+10.4 (+6.4 to +14.4)** | +12.0 (+8.2 to +15.8) |
| reference: `off` on the first five hits (today's knob) | 75.2% | +6.2 (+3.2 to +9.2) | +7.8 (+4.8 to +10.8) |

Intervals are paired 95% cluster-bootstrap intervals in points. `depth_first` passes every preregistered guard,
loses nothing measurable on LoCoMo or BEAM, and keeps its gain under all three frontier readers (Sonnet 5.5 +16,
Opus 5.5 +13, gpt-6.1-sol +13 points on the slice). **By the preregistered rule, `depth_first` goes to H1.** The
central caveat: `depth_first` buys its gain on single-conversation and date questions, and on multi-session questions
it trails `breadth_capped` by 10.5 points (−18.0 to −3.0). The held-out set is mostly multi-session, so H1's
preregistration should weigh that (see [What to use and what to avoid](#what-to-use-and-what-to-avoid)).

## The concrete case

An invented example of a LongMemEval-S question: "How many days passed between my visit to the dentist and my first
pottery class?" The answer needs one date from each of two conversations among about 50 in the user's history.
gbrain's search returns about 18 matching chunks from about 18 conversations. With a budget of 5,500 gbrain tokens
(the reader sees about 8,000 of its own):

- `off` reserves a chunk from each of the 18 conversations, grows almost none, then appends the conversations that no
  longer fit as chunks outside the budget: about 10,500 tokens, cut back to 8,000 by the reader's packer.
- `cap_only` keeps today's order but stops at the budget: chunks from about 9 conversations.
- `breadth_capped` keeps about 3.5 conversations, each with a window around its match, then grows them.
- `depth_first` hands over the top conversations whole while they fit: about 2.4 per question.

## The experiment and results

**Sets.** LongMemEval-S, all 500 questions (one roughly 115,000-token history each; development data; the primary
set, each question its own cluster); its 100-question slice (the E1 and comparison link); LoCoMo dev (3 conversations,
587 questions) and BEAM-100K dev (6 conversations, 120 questions), descriptive.

**Construction** ([preregistration](2026-10-09-gbrain-budgeted-delivery-e2-preregistration.md), amendments A1 to A4).
One `query` call per question freezes the ranked hit list (25 hits, chunk unit, no budget, reranked, real
embeddings). Every packing is delivered on that same list through gbrain's `assembleEvidenceForHits` with a per-call
`auto_packing`, so the packings differ in delivery only. The reader sees each delivered block as a dated session under
LongMemEval's reading prompt (the "pseudo-session" rendering E1 and H1 use), packed to 8,000 harness tokens
(characters divided by four). gbrain counts tokens differently, so its budget was sized on the frozen lists at $0:
5,500 gbrain tokens on LongMemEval-S, 6,400 on LoCoMo and 6,000 on BEAM. Judge: `gpt-4o-2024-08-06` (`gpt-4.1-mini` on
BEAM), as in the comparison. Scores are QA service quality; no row failed.

### What each packing delivered (LongMemEval-S 500)

| Packing | gbrain tokens (mean) | Over budget | Blocks | Conversations | All gold sessions delivered (of 470) | Reader tokens before / after packing |
|---|---:|---:|---:|---:|---:|---|
| `off` | 10,503 | 500 of 500 | 18.3 (8.8 spilled chunks) | 18.3 | 468 | 12,583 / 7,660 (cut on 500) |
| `cap_only` | 5,493 | 0 | 9.5 | 9.5 | 462 | 6,571, no cut |
| `breadth_capped` | 5,481 | 0 | 3.5 | 3.5 | 422 | 6,476, no cut |
| `depth_first` | 5,467 | 0 | 2.4 | 2.4 | 365 | 6,452, no cut |
| `off`, first five hits | 5,492 | 0 | 4.9 | 4.9 | 449 | 6,509, no cut |

`depth_first` delivers every gold session less often than any other packing and still answers the most questions:
two or three whole conversations read better than nine to eighteen fragments.

### By question kind (LongMemEval-S 500, questions correct)

| Kind (n) | `off` | `cap_only` | `breadth_capped` | `depth_first` | first five hits |
|---|---:|---:|---:|---:|---:|
| single-session user (70) | 55 | 56 | 64 | **70** | 67 |
| single-session assistant (56) | 51 | 51 | 55 | **56** | 55 |
| single-session preference (30) | 27 | 25 | 27 | **28** | 28 |
| knowledge update (78) | 56 | 55 | 65 | **69** | 58 |
| temporal reasoning (133) | 79 | 76 | 85 | **95** | 81 |
| multi-session (133) | 77 | 74 | **93** | 79 | 87 |

On multi-session questions `breadth_capped` gains 12.0 points over `off` (+3.8 to +20.3) and `depth_first` 1.5
(−8.3 to +11.3); `depth_first` minus `breadth_capped` is −10.5 (−18.0 to −3.0). Overall, `depth_first` minus
`breadth_capped` is +1.6 (−1.8 to +5.0), not distinguishable.

### Guards

| Guard | `cap_only` | `breadth_capped` | `depth_first` |
|---|---|---|---|
| 1 No budget, bytes identical to `off` (500, 587, 120 questions) | pass | pass | pass |
| 3 Within the explicit budget, packing reported (500 of 500) | pass | pass | pass |
| 4 Reader context fits 8,000 with no cut | pass | pass | pass |
| 5 Same frozen hit list | pass (by construction) | pass | pass |
| 6 Default budget | exact by guard 1 | exact | exact |
| 7 No kind down more than max(1, 2%) | **fail** (multi-session −3, temporal −3, preference −2) | pass (multi-session +16) | pass (multi-session +2) |
| 8 Abstention not worse | pass (28 of 30 both) | pass | pass |
| 9 Handler p95 within +20% | pass (0.90×) | pass (1.00×) | pass (1.04×) |

Guard 9 comes from 1,200 live `query` calls on the slice (100 questions, three interleaved rounds per packing, one
VM). Handler p95: `off` 734 ms, `cap_only` 664, `breadth_capped` 734, `depth_first` 762. The reranker's network time
dominates (p95 about 480 to 575 ms, one call per query); without it the p95 ratios are 1.16, 1.09 and 1.23, so the
packing itself adds about 15 to 45 ms at p95. Every live call read back and reported the packing it was given, and no
capped call exceeded its budget.

### LoCoMo and BEAM (descriptive)

| Set (Sonnet 5.5) | `off` | `cap_only` | `breadth_capped` | `depth_first` |
|---|---:|---:|---:|---:|
| LoCoMo dev (587) | 88.8% | 87.9% (−0.9, −3.2 to +1.3) | 87.2% (−1.5, −4.7 to +0.8) | 88.4% (−0.3, −3.7 to +1.9) |
| BEAM-100K dev (120) | 59.5% | 57.8% (−1.7, −3.7 to +0.1) | 59.2% (−0.3, −4.8 to +3.2) | 63.4% (+4.0, −0.3 to +8.4) |

LoCoMo's conversations are short, so with Sonnet 5.5 every packing is near its ceiling; no packing loses more than
3 points on either set, so none is stopped for review. With three and six conversation clusters these intervals
understate uncertainty.

### Frontier reader check (slice, 100 questions)

| Reader | `off` | `depth_first` | Difference |
|---|---:|---:|---|
| Claude Sonnet 5.5 (primary) | 72% | 88% | +16 (+8 to +24) |
| Claude Opus 5.5 | 73% | 86% | +13 (+6 to +21) |
| gpt-6.1-sol | 73% | 86% | +13 (+5 to +21) |
| `gpt-4o-2024-08-06`, native rendering (the E1 link) | 66% | 84% | +18 (+10 to +27) |

No counted reader changes sign. The `gpt-4o` `off` arm reproduces E1's `query-auto` (66%) exactly. Claude Fable 5.1
ran a six-question smoke check only (Garry's rule: Fable is never counted): 5 of 6 for `off` and 4 of 6 for
`depth_first`, which says nothing at that size.

### Exploratory arms (slice)

- **16,000 tokens.** At a 16,000-token reader budget (11,700 gbrain tokens): `off` 76%, `cap_only` 76%,
  `breadth_capped` 82%, `depth_first` 95%. `depth_first` gains 19 points over `off` there (+11 to +28) against 16 at
  8,000 tokens; the difference is under the preregistered 5 points, so E2 recommends H1 keep the 8,000-token budget.
  Doubling the budget adds 7 points to `depth_first` (+2 to +13).
- **Rank order (C5).** The same `depth_first` blocks shown best-first instead of in date order: 86% against 88%
  (−2, −5 to 0). Date order stays.
- **`window` unit** at the same budget: 73% against `off`'s 72% (+1, −3 to +5).

### E3: session-level fusion (the C3 retrieval gate)

On the same frozen lists, scoring each session from all its hits (best hit plus half the second, and so on) changes
the session order on 21 of 500 LongMemEval-S lists, 19 of 587 LoCoMo and 11 of 120 BEAM, and recall of every gold
session in the top five on none: 95.7%, 87.5% and 57.4% before and after. `query`'s lists rarely hold two chunks of one
session (55 of 500), so there is little to fuse. The slice is non-inferior, BEAM is not superior: **the gate fails, C3
stays parked**, and no QA follow-up is earned. E3 made no provider call of its own.

## What to use and what to avoid

- **For H1, the rule picks `depth_first`.** It is the only reading E2 was preregistered to make, and it passes.
  Two facts the H1 preregistration should weigh before custody is requested: sealed confirmation set v2 is 80
  multi-session, 40 temporal, 40 knowledge-update and 40 abstention questions, with three to four gold chats per
  multi-session question; and on LongMemEval-S multi-session `depth_first` trails `breadth_capped` by 10.5 points.
  Reweighting the LongMemEval-S per-kind gains to that mix (arithmetic, not a measurement) gives `breadth_capped`
  about +16 questions of 200 and `depth_first` about +13. If one opening should go to the packing most likely to pass
  on that set, `breadth_capped` is the stronger case; switching would be a recorded decision against the dev rule,
  which is Garry's call with the custodian.
- **Do not ship the cap alone.** `cap_only` enforces the budget but scores no better than today's overrun (−1.6) and
  fails the question-kind guard. The cap is worth having only with a packing that spends it on depth.
- **At small budgets today**, before any default changes, `auto` on five hits (`limit: 5`) remains a reasonable knob
  (+6.2 over 25 hits), but `depth_first` beats it by 4.2 points (+0.8 to +7.6).
- **Limits.** Development data only; LongMemEval-S guided gbrain's earlier tuning. One reader family is primary.
  LoCoMo is near ceiling with Sonnet 5.5. The adapter is a trusted local caller, not the remote MCP path. Live
  `query` equalled the assembled delivery on 1,143 of 1,200 calls; the rest returned different pages in the live
  call's own retrieval (reranker run-to-run variation, most often for the 18-block `off` deliveries), not a packing
  difference.

## Deviations, disclosed

Each is recorded in the preregistration before the cells it affects.

- **Default packing.** gbrain #6367 ships `cap_only` as the default for explicit budgets (the plan expected `off`
  until H1); every E2 call names its packing, so this changes no measurement.
- **Reader check with three readers.** The plan's four-reader check counted Fable; under Garry's rule it counts
  Opus 5.5, Sonnet 5.5 and gpt-6.1-sol, with Fable as a smoke check.
- **Out of memory and a restart (A1, A3).** Three LongMemEval-S sizing shards were killed for memory and rerun on the
  host with the same command. Later, 16 local reader processes (about 2.5 GB each) exhausted the host's memory before
  any reader call; the restart ended the first live cell's VM runner, so that lease was charged in full ($8) and the
  cell rerun. Local readers then ran four at a time.
- **Redacted chunk text (A1).** Three frozen chunks held gbrain's output-redaction tokens; the re-import check now
  allows differences only inside those tokens.
- **BEAM readers (A4)** ran locally after the VM cell's BEAM half started before its copy finished and sent no call.
- **Caps (A2).** Garry raised E2's cap to $600, E3's to $25 and the program's to $1,500 mid-run, so evals don't stop
  on a cap; the spend-triggered drop order was withdrawn. Nothing was dropped.

## Reproduce and inspect

From the repository root, with Bun 1.4.2, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY` and
`UBICLOUD_API_KEY`:

    bash eval/runner/budgeted-delivery/e2-keyless-gate.sh <out> ~/gbrain-master@ca2c447bd39b31beb142247de424c096eefc8525   # $0 gate
    bun eval/runner/shootout-cell.ts init    --campaign docs/benchmarks/2026-10-09-gbrain-budgeted-delivery-e2/manifests/campaign.json --state <dir>
    bun eval/runner/shootout-cell.ts reserve --campaign <same> --state <dir> --cell e2-freeze-lme-s    # then launch; likewise each cell in order
    bun eval/runner/budgeted-delivery/budget-sizing.ts --e2 --rows <size cell shards>/retrievals/rows.ndjson --budgets b_pseudo,b_native --benchmark lme-s
    bun eval/runner/budgeted-delivery/e2-readings.ts --config docs/benchmarks/2026-10-09-gbrain-budgeted-delivery-e2/results/readings-config.json
    bun eval/runner/budgeted-delivery/e3-retrieval-gate.ts --config docs/benchmarks/2026-10-09-gbrain-budgeted-delivery-e2/results/e3-config.json

The last two recompute every number above from the committed receipts. Identities: gbrain `ca2c447bd` (v0.60.124.0)
loaded as a copied overlay; the declared pin at the time of the run was `fc548317` (v0.60.122.0) and is `8a3eedeac`
(v0.60.126.0) after the merge; datasets at the revisions `eval:decide fetch` pins. Every Ubicloud VM ran Bun 1.4.2
(owner `GBRA-1`, at most 46 vCPU at once, every VM destroyed).

**Cost.** The campaign ledger committed **$178.46** of the $600 cap: freeze $9.01; sizing and delivery $0; live
checks $2.51 plus the $8.00 lease charged in full after the restart; phase 1 readers $73.95 (estimate $71); LoCoMo
readers $49.41 ($54); BEAM readers $13.33 ($12); phase 2 frontier readers $22.24 ($27). No cell ran past twice its
estimate. The plan's estimate for E2 was about $110; the sweep, the live cell's three rounds and the native link
account for most of the difference. Wall time was about four and a half hours of cells.

**Receipts** (no dataset text; ids, hashes, token counts, delivery records and scores kept):
[`results/`](2026-10-09-gbrain-budgeted-delivery-e2/results/) per benchmark and stage, the lease summaries,
`readings.json` and `e3.json`; the [sizing runs](2026-10-09-gbrain-budgeted-delivery-e2/receipts/sizing/) and the
[keyless gate](2026-10-09-gbrain-budgeted-delivery-e2/receipts/keyless-gate/). Plan:
[budgeted delivery, v3](../plans/2026-10-08-gbrain-budgeted-delivery/PLAN.md).
