# What gbrain's `query` hands a reader at 8,000 tokens: E1 of the budgeted delivery plan (2026-10-08)

## The finding

gbrain is a memory system for agents: it stores conversations and notes as pages and finds evidence for a question
(see [gbrain](https://github.com/garrytan/gbrain)). In the
[open-source memory comparison](2026-10-06-oss-memory-shootout.md), gbrain found the right conversations as often as
any system but its reader answered fewer questions at an 8,000-token evidence budget. That adapter called gbrain's
internal ranking function and handed the reader undated chunks. E1 measures the same question sets through `query`,
the operation an agent calls, at the comparison's frozen gbrain build (`c5fb0201`, v0.60.95.0), and separates four
levers: dates, rendering, hit count and depth. It is exploratory triage on development data; it sets no default.

**Most of the comparison's gap was the adapter, and what remains at a small budget is how many conversations `auto`
tries to fit.**

- **Dates.** Adding one date line to each chunk the old adapter returned, with nothing else changed, lifts LoCoMo
  temporal questions from 28 to 78 of 100 (50 questions gained, none lost). Over all 587 LoCoMo questions it adds
  9.0 points (66.1% to 75.1%), which puts gbrain's old ranking beside the extract-first system (76.0% in the
  comparison). On the LongMemEval-S slice it adds 6 points (56% to 62%; interval −2 to +14).
- **The `query` path at 8,000 tokens** adds little on top of dated chunks: +4 points on the slice (interval −1 to +9),
  +0.5 on LoCoMo, +1 on BEAM. Today's `auto` overran its explicit budget on every slice and LoCoMo question (by about
  4,300 tokens on average). On the slice it delivered 18.4 blocks per question, of which 0.45 were whole
  conversations; the rest were cut conversations (10.3) and spilled chunks (7.6).
- **Hit count, not rendering or depth, is the lever.** With the same blocks and reader, rendering them as dated
  sessions instead of one-line items changes nothing (+1, interval −5 to +8). Delivering `auto` on the first five
  hits instead of 25 lifts the slice from 74% to 82% with Sonnet 5.5 (+8, interval +2 to +15), level with whole
  rehydrated sessions (80%). On LoCoMo the five-hit arm is the best E1 arm (77.2%).
- **gbrain as shipped** (`auto` with no budget, 24,000 tokens, read whole) answers 89% on the slice with the
  comparison's `gpt-4o` reader, using about 27,500 tokens of evidence.
- **Saved facts show no headroom** on LoCoMo: the existing facts lane answers 66.1% from about 1,270 tokens of facts,
  11 points below the best E1 arm.

So, by the plan's preregistered rules: the LoCoMo shortfall is mainly an adapter finding; `breadth_capped` (a budget
that holds whole conversations for the first few hits) leads the next experiment, E2; and C4's facts stage is not
funded yet. Every number below has its paired interval; with 100 slice questions and 3 LoCoMo conversations most
intervals are wide.

## The concrete case

An invented example of a LoCoMo temporal question: "When did Maria start her pottery class?" The answer sits in one
conversation whose date is in the page title and frontmatter. The comparison's adapter returned that conversation's
matching chunk, which reads "**Maria:** I signed up for the pottery class last week!", with no date. The reader cannot
answer from that. E1's dated arm gives the same chunk with one header line, `Conversation date: 2023-05-08`, and the
reader can count back a week.

`auto` is gbrain's default evidence unit: for a conversation hit it tries to hand over the whole conversation. Under a
budget it first reserves each hit's matching chunk for all 25 hits ("breadth"), then grows conversations toward whole
sessions in rank order, and delivers conversations that no longer fit as chunks outside the budget ("spill"). At 8,000
tokens the reservations use the budget, so most conversations stay a single chunk.

## The experiment and results

**Sets.** The comparison's development sets: the LongMemEval-S slice (100 questions, one haystack each; questions are
independent, so it is the inferential set), LoCoMo dev (3 conversations, 587 questions) and BEAM-100K dev
(6 conversations, 120 questions), both descriptive. Embeddings `text-embedding-3-large` at 1,536 dimensions; gbrain's
`balanced` search with the Voyage reranker.

**Two cells per benchmark.** Cell A is the comparison's adapter, unchanged: `hybridSearch` at limit 40. Cell B is the
new `gbrain-query` adapter ([module and README](../../eval/runner/systems/gbrain-query/README.md)): one chunk-unit
`query` call per question freezes the ranked list (25 hits, `expand: false`, no evidence plan), every delivery variant
runs on that list through gbrain's `assembleEvidenceForHits`, and one live `query` call per question checks that the
frozen delivery equals the product's. Query-path settings are pinned and checked (`search.cache.enabled=false`,
`decide.provider=none`, CRAG off, `search.track_retrieval=false`). Dates always come from the harness's session table,
because at `c5fb0201` the frozen-hit path drops gbrain's `effective_date` (a keyless fixture pins this).

**Arms.** The [preregistration](2026-10-08-gbrain-budgeted-delivery-e1-preregistration.md) defines each one. Native
means one line per item under the comparison's item prompt; pseudo-session means each delivered block rebuilt as a
dated session under LongMemEval's history prompt (the rehydrated arm's renderer). Every arm is packed to 8,000 harness
tokens (characters divided by four) and counts what the packer cut.

**Budgets.** gbrain counts tokens differently from the harness, so the `query` budget is sized per benchmark and
rendering from the highest ratio on the real frozen lists (amendment A1): `B_native` 6,200 / 7,300 / 6,400 and
`B_pseudo` 5,500 / 6,400 / 6,000 tokens for the slice, LoCoMo and BEAM.

**Readers.** The comparison's frozen readers keep the link to its rows: `gpt-4o-2024-08-06` on the slice,
`gpt-4o-mini` on LoCoMo, `gpt-4.1-mini` on BEAM. Readings that steer the next build use `claude-sonnet-5-5` on the
slice (decision G8: Sonnet only in E1; Fable runs no counted reader). Judges as in the comparison.

**Scores** are QA service quality: product failures count as wrong. No row failed for a product or harness reason.

### Reproduction

Both reproduction arms land inside the preregistered band, so the readings stand.

| Set | `shootout-chunk` now (frozen) | `rehydrated` now (frozen) | Band | Per-question agreement |
|---|---:|---:|---:|---:|
| LongMemEval-S slice | 55.0% (59.0%) | 77.0% (78.0%) | ±4 | 86% / 93% |
| LoCoMo dev | 65.4% (64.9%) | 73.4% (72.7%) | ±3 | 91% / 92% |
| BEAM-100K dev | 58.2% (60.5%) | 55.4% (59.4%) | ±5 | 82% / 80% |

No frozen list in either cell lacked rerank scores (0 of 807).

### Every arm

| Arm | What the reader gets | Slice | LoCoMo | BEAM |
|---|---|---:|---:|---:|
| `shootout-chunk` | the comparison's chunks, undated | 55.0 | 65.4 | 58.2 |
| `chunk-undated-twin` | `chunk-dated`'s exact selection, undated | 56.0 | 66.1 | 58.4 |
| `chunk-dated` | the same chunks, each with a date line | 62.0 | 75.1 | 58.2 |
| `query-auto` | `auto` on 25 hits at `B_native`, dated, native | 66.0 | 75.6 | 59.3 |
| `query-auto-default` | `auto` with no budget, first blocks that fit 8,000 | 81.0 | 74.4 | |
| `query-auto-default-whole` | `auto` with no budget, read whole (27,488 / 16,031 tokens) | 89.0 | 74.8 | |
| `rehydrated` | whole sessions behind Cell A's hits | 77.0 | 73.4 | 55.4 |
| `chunk-dated-pseudo` | dated chunks as sessions | 72.0 (S) | 74.4 | |
| `query-auto-pseudo` | `auto` at `B_pseudo` as sessions | 74.0 (S) | 71.6 | |
| `query-auto-pseudo-as-native` | the same blocks, native | 73.0 (S) | | |
| `query-auto-l5-pseudo` | `auto` on the first 5 hits at `B_pseudo` as sessions | 82.0 (S) | 77.2 | |
| `query-rehydrated` | whole sessions behind the frozen 25-hit list | 80.0 (S) | | |
| `rehydrated`, Sonnet | as `rehydrated` | 80.0 (S) | | |
| saved-facts probe | all saved facts of the top sessions (about 1,270 tokens) | | 66.1 | |

(S) marks `claude-sonnet-5-5`; every other cell uses the set's frozen reader.

### What `auto` delivered

| Set, variant | Budget | gbrain's `budget_used` (mean) | Over budget | Blocks | Spilled chunks |
|---|---:|---:|---:|---:|---:|
| Slice, 25 hits | 6,200 | 10,490 | 100 of 100 | 18.4 (0.45 whole) | 7.6 |
| Slice, 5 hits | 5,500 | 5,492 | 0 of 100 | 4.9 | 0 |
| Slice, no budget | 24,000 | 23,998 | 0 of 100 | 18.4 | 0 |
| LoCoMo, 25 hits | 7,300 | 11,727 | 587 of 587 | 21.4 (5.7 whole) | 8.3 |
| LoCoMo, 5 hits | 6,400 | 3,793 | 0 of 587 | 5.0 | 0 |
| BEAM, 25 hits | 6,400 | 11,082 | 119 of 120 | 18.3 | 7.7 |

The live `query` call equalled the frozen delivery on every consumed field for 89 of 100 slice questions, 505 of 587
LoCoMo questions and 116 of 120 BEAM questions. The rest differ in which pages the live retrieval returned, so those
questions count as product path, not delivery, in reading 2.

### The preregistered readings

Each is the paired difference with a cluster-bootstrap 95% interval (10,000 draws). Slice clusters are questions;
LoCoMo has only 3 conversation clusters, so its intervals understate uncertainty and its sign-flip p-values cannot go
below 0.25; the win and loss counts are the sturdier evidence there.

1. **Date effect** (`chunk-dated` minus `chunk-undated-twin`, frozen reader). LoCoMo temporal **+50.0 points**
   (28.0% to 78.0%; interval +45.2 to +55.9; 50 wins, 0 losses), against the 24.5-point threshold: **the LoCoMo
   shortfall is mainly an adapter finding.** All LoCoMo +9.0 (+5.7 to +11.6). Slice +6.0 (−2.0 to +14.0); slice
   temporal +25.0 on 16 questions (+6.2 to +50.0). BEAM −0.1 (−3.1 to +2.8), temporal +8.3 on 12 questions. The twin
   reused the undated arm's scored row on 86, 481 and 98 questions, where the prompts were byte-identical.
2. **Product path at 8,000** (`query-auto` minus `chunk-dated`). Slice +4.0 (−1.0 to +9.0); on the 79 questions where
   the frozen `query` list equals Cell A's prefix and live parity held (a pure delivery effect) +3.8 (−2.5 to +10.1).
   LoCoMo +0.5 (0.0 to +1.3), BEAM +1.0 (−1.4 to +3.0). Both arms carry dates the same way, so this is what `query`'s
   delivery adds at today's settings: little.
3. **Depth at matched rendering, reader and retrieval** (Sonnet, slice).
   (a) `query-rehydrated` minus the better breadth arm, `query-auto-l5-pseudo`: **−2.0** (−10.0 to +6.0). Five hits
   are within 3 points of whole sessions: **hit count is the lever, so `breadth_capped` leads E2.**
   (b) `rehydrated` minus `chunk-dated-pseudo`: +8.0 (−1.0 to +18.0), not within 3, so dates and layout alone are not
   the whole story on the slice. The 25-hit `auto` at `B_pseudo` trails the 5-hit one by 8.0 points (+2.0 to +15.0;
   LoCoMo 5.6, +3.8 to +7.9).
4. **Rendering** (`query-auto-pseudo` minus `query-auto-pseudo-as-native`, same blocks, same reader): +1.0 (−5.0 to
   +8.0). Layout and prompt were not a lever.
5. **As shipped.** `auto` with no budget, read whole, answers 89.0% on the slice (about 27,500 harness tokens) and
   74.8% on LoCoMo (about 16,000). Read through the 8,000-token packer, which keeps the first whole conversations in
   rank order (2.1 on the slice, 9.9 of LoCoMo's shorter ones), the same delivery answers 81.0% and 74.4%: 15 points above `query-auto` on the slice
   (+5 to +25). A small budget with depth for the top hits beats the same budget spread across 25 hits.
6. **Facts headroom.** The saved-facts probe answers 66.1% on LoCoMo, −11.1 points against the best E1 arm
   (`query-auto-l5-pseudo`, 77.2%; interval −12.0 to −10.5) and −9.5 against `query-auto`. **No headroom**, so C4
   stage 1 does not earn its harness work now (decision G6's gate). The probe is a different runner (memory-qa's legacy
   adapter, reranker off, recall_all@5 75.6% against 87.5% for Cell A), a different prompt and an unbounded context.
   Its extraction model was `claude-sonnet-4-6`, the default of gbrain `c5fb0201` when no extraction model is set
   (102 extraction requests, recorded from the cell's metering proxy in
   [`models.json`](2026-10-08-gbrain-budgeted-delivery-e1/results/locomo/facts-probe/models.json)). gbrain master now
   defaults to Claude Haiku 5.5 for extraction; this reading is pinned to Sonnet 4.6 extraction and was not rerun.
   Flipping it would need a cheaper extractor to gain 11 points, which nothing here suggests, but it is unmeasured.

### Adapter or product

Both, and E1 now says how much of each. On LoCoMo the date line alone moves gbrain's old ranking from 65% to 75%,
level with the extract-first system; `query` adds nothing measurable at 8,000 tokens. On the slice, dates add about
6 points and `query`'s delivery about 4, which leaves gbrain at 66% with the comparison's reader. The rest is
`auto`'s behavior at a small explicit budget: it spends the budget on 25 matching chunks, overruns on every question,
and leaves the reader fragments. The same build reaches 81 to 89% when it hands over whole conversations for the top
hits, whether by delivering on 5 hits, by a large budget, or by the harness keeping only the first whole
conversations. That is the case for a budget that caps the hit count and keeps depth (`breadth_capped`), plus the cap
itself (`cap_only`), in E2.

## What to use and what to avoid

- **Pass dates to the reader.** Any consumer that renders gbrain evidence as text should keep the conversation date.
  `query` returns it as `effective_date` and in the title; a renderer that prints only `chunk_text` loses it, as the
  comparison's adapter did. gbrain's own C1 change would put it in the text.
- **At small budgets today, ask for fewer hits.** `auto` on the first five hits with a budget around 6,000 tokens (what
  `limit: 5` returns; a keyless test checks the prefix) stayed within budget on every question and read best. With the default 25 hits, an explicit budget is
  exceeded on every question.
- **Do not read `auto` at 8,000 tokens as a cap.** It is documented as not one; decision G1 makes an explicit budget a
  hard cap in gbrain PR 1.
- **Limits.** Development data only. 100 slice questions detect only large effects; LoCoMo and BEAM are descriptive
  and LoCoMo has three clusters. The adapter is a local trusted caller, not the remote MCP path. Readers differ by
  set, as in the comparison. Vendor systems were not rerun; any comparison page must show the frozen and the revised
  gbrain rows side by side, labeled as an adapter revised after seeing the results.

## Deviations, disclosed

Amendment A2 in the preregistration records each, before this report.

- **Base.** The branch was cut from PR #89's head `4493e440` (the plan named `9c07b7e2`; the four later commits touch
  results and arms parsing). PR #89 later merged to main; the branch merged main twice, and E1's harness changes moved
  with the runner into `eval/runner/memory-qa/run-systems.ts`.
- **`query-auto-default`** was preregistered as the shipped delivery "labeled as a different budget", but its arm ran
  under the 8,000-token packer, which cut it to the first whole conversations. After seeing that result we added
  `query-auto-default-whole` (the same delivery read whole) on the slice and LoCoMo. Both are reported; reading 5
  decides nothing.
- **BEAM dates.** The header's date parser first missed BEAM's `March-15-2024` form, so the first BEAM dated arms
  carried no header and equalled the undated ones. The parser now reads every form the sanitizer's event time reads.
  We checked that this changes no header on the slice or LoCoMo (0 of 24,139 sessions differ) and reread the BEAM
  arms into fresh outputs. The first run's receipts are kept under `results/beam-100k/superseded-undated-headers/`.
  Rereading the same prompts with the same frozen reader moved BEAM `rehydrated` from 57.9% to 55.4%. That is reader
  run-to-run variation, and both values are inside the band.
- **Sonnet 5.5 and `temperature`.** The pre-merge reader sent `temperature: 0`, which Anthropic now refuses for
  Sonnet 5.5. 574 calls were refused with HTTP 400 and retried on main's reader, which omits it. Thirteen slice
  questions in `rehydrated` and `query-rehydrated` (byte-identical prompts in both arms) were read with
  `temperature: 0` before the refusals began.
- **Drop order.** Nothing was dropped; every arm ran within the cap.

## Reproduce and inspect

From the repository root, with `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY` and `UBICLOUD_API_KEY`:

    bash eval/runner/budgeted-delivery/keyless-gate.sh locomo <out> ~/gbrain-master@c5fb0201d1960a0a5a81c35d77718311b03154b7   # $0 accounting gate
    bun eval/runner/shootout-cell.ts init    --campaign docs/benchmarks/2026-10-08-gbrain-budgeted-delivery-e1/manifests/campaign.json --state <dir>
    bun eval/runner/shootout-cell.ts reserve --campaign <same> --state <dir> --cell e1-freeze-locomo      # then launch; likewise e1-deliver-*, e1-facts-locomo
    bun eval/runner/budgeted-delivery/budget-sizing.ts --rows <freeze cell>/cell-b-freeze/retrievals/rows.ndjson --benchmark locomo
    bun eval/runner/memory-qa/run.ts --benchmark locomo --split dev --system gbrain-query ... --arms docs/benchmarks/2026-10-08-gbrain-budgeted-delivery-e1/manifests/arms/locomo-cell-b.json --replay --paid ...
    bun eval/runner/budgeted-delivery/e1-readings.ts --config <readings config> --out readings.json

The deliver cells read the freeze cell's frozen lists and embedding cache from `.e1-transfer/<benchmark>/`
(untracked, synced to the VM). Identities: gbrain `c5fb0201` loaded as an overlay; declared pin `a865f8f8`; datasets
at the pinned revisions `eval:decide fetch` verifies.

**Cost.** The campaign ledger committed $66.42 of the $100 cap: freeze cells $2.90, deliver cells $0.62, facts probe
$2.59, readers and judges $60.31 (Sonnet 5.5 $28.59, `gpt-4o` $21.73, `gpt-4o-mini` $6.71, `gpt-4.1-mini` $3.29).
$16.65 of the Sonnet total is the ledger's reservation charged for the 574 refused requests. The provider returned
HTTP 400 and billed nothing for them, so the estimated provider spend is $49.77. Wall time was about seven hours,
mostly LoCoMo reader replays.

**Receipts** (no dataset text: item, block, question and answer text removed; ids, hashes, token counts, scores and
delivery records kept): [`results/`](2026-10-08-gbrain-budgeted-delivery-e1/results/) per benchmark and cell, the
lease summaries, `readings.json` (every reading above), the
[accounting gate](2026-10-08-gbrain-budgeted-delivery-e1/receipts/keyless-gate/) and the
[sizing runs](2026-10-08-gbrain-budgeted-delivery-e1/receipts/sizing/). Plan:
[budgeted delivery, v3, approved](https://github.com/garrytan/gbrain-evals/blob/capy/gbrain-budgeted-delivery-plan/docs/plans/2026-10-08-gbrain-budgeted-delivery/PLAN.md).
