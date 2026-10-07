# Model repair of malformed fences (Tier 3): every model passes the gates, but the default writes a wrong cell 4% of the time

**Measured October 6, 2026, on gbrain branch `capy/6188-t4-eval` at [`171a7e24`](https://github.com/garrytan/gbrain/commit/171a7e24663640987f8c1e773202aa296d196a89) (the [#6188](https://github.com/garrytan/gbrain/issues/6188) PR 4 work in progress plus this eval). Preregistered in [the preregistration](2026-10-06-fence-repair-tier3-preregistration.md) (commit `27d8fe5`) before any scored run. Raw results: [`2026-10-06-fence-repair-tier3/`](2026-10-06-fence-repair-tier3/).**

[gbrain](https://github.com/garrytan/gbrain) is a memory system for agents. It keeps typed facts and takes as Markdown tables between marker comments, called **fences**, so a person can read and edit them. A fence written by hand or by an agent is sometimes malformed: a row is missing cells, a stray empty cell shifts a row, the header is missing or sits below a row, or a header column has a name gbrain does not know. gbrain repairs these in tiers. **Tier 1** applies deterministic rules where the fix has one meaning. **Tier 3** sends the rows Tier 1 cannot place to the configured chat model, asks for them realigned under the canonical header, and writes the answer only if it passes seven validation gates: it compiles, no row is added, dropped or reordered, claims and row numbers are unchanged, no row becomes more visible, no cell text changes or leaves its column except by a named rule, and nothing hidden is exposed. A rejected answer gets one corrective re-ask.

## The finding

Tier 3 works mechanically on every model tested: 96.5% to 100% of repairs pass every gate. The question is how often a repair that passes is still wrong, because the gates check that text is preserved, not that each cell sits in the right column.

- **The current default fails the preregistered rule.** `anthropic:claude-opus-4-7`, which `models.fence_repair` resolves to on an install with an Anthropic key, passed the gates on 195 of 198 repairable fixture runs (98.5%), above the 80% bar. But 8 of 198 (4.0%, Wilson 95% interval 2.1% to 7.8%) were accepted with a cell in the wrong column, against a bar of at most 1%. All 8 moved a source note (`intro call`, `Q2 report`, `coffee chat`) into the context column.
- **Two models meet both bars.** `openai:gpt-6.1-sol` passed 198 of 198 with 1 false accept (0.5%), at $0.0023 per repair. `anthropic:claude-fable-5-1` passed 191 of 198 (96.5%) with no false accepts, at $0.0174 per repair. Under the preregistered model-choice clause, **`gpt-6.1-sol` is the recommended default**: it has the highest gate-pass rate and no cheaper model meets the rule.
- **Two qualifications travel with that recommendation.** gbrain's tier defaults are key-aware, so an install with only an Anthropic key cannot use `gpt-6.1-sol`; the Anthropic model that meets the rule is Fable 5.1, at 2.3 times Opus 4.7's cost per repair. And on the six ambiguous fences whose only correct outcome is to stay held, `gpt-6.1-sol` wrote a guess in 11 of 18 runs, the most of any model. Those fixtures do not enter the rule by design, but they show the prompt has no way to decline.

Two cheap code changes would remove most of the wrong writes measured here; they are described under [weaknesses](#weaknesses-found-and-proposed-changes). The prompt was not changed in this experiment.

## The concrete case

This invented row (fixture `f-mix-01`) has one stray empty cell after the claim:

```
| 2 | Bob-example is raising a seed round |  | event | 0.7 | private | medium | 2026-05-01 |  | coffee chat |  |
```

Deleting that one empty cell gives the correct row: `valid_from` is `2026-05-01`, `valid_until` is empty, `source` is `coffee chat`, `context` is empty. Opus 4.7 and Sonnet 5.5 returned this row, spacing aside, in all three runs each:

```
| 2 | Bob-example is raising a seed round | event | 0.7 | private | medium | 2026-05-01 |  |  | coffee chat |
```

Every word survived and every validated column holds a valid value, so the gates accept it. But `coffee chat` is now the context, not the source. The gates cannot tell a source from a context because both are free text, and in a misaligned row any cell may legitimately move. That is what a false accept is: a wrong write the gates were never built to catch.

## The experiment

**Fixtures.** `evals/fence-repair-tier3/` in gbrain, 78 synthetic pages with placeholder names, each with a hand-written repaired section (copied here as [`fixtures.jsonl`](2026-10-06-fence-repair-tier3/fixtures.jsonl), sha256 `769f7f04…`). The agent running the experiment (Capy) wrote the ground truths before any run; no person reviewed them.

| Set | Fences | Correct outcome |
|---|---|---|
| Repairable | 66 | The hand-written table. Short rows with trailing cells missing 15, short rows with a cell missing in the middle 7, no header 10, a row before the header 8, extra cells 11, an unknown header column 10, several problems at once 5 |
| Adversarial, ambiguous | 6 | Stay held: a row carries two confidences, two kinds, two notabilities, two holders, both `private` and `world`, or a column with no home in a facts table |
| Adversarial, unrecoverable | 3 | Stay held: a required value is missing |
| Gate-limited | 3 | A person would repair it, but the gates forbid the correct table (diagnostic) |

The repairable rows include links, struck-through claims, money with k and M suffixes, escaped pipes, world-visible pages, timeline fences and typed 14-column rows. A $0 oracle ran every fixture through the production path with a scripted model before any paid run: each repairable ground truth passes every gate byte for byte, each ambiguous probe (a plausible wrong guess) is accepted by the gates, and each unrecoverable and gate-limited case is rejected.

**Procedure.** Each model ran three times, each run on a fresh in-memory brain with an empty ledger and attempt memo. The harness sets `models.fence_repair`, then runs gbrain's own `analyzeFences` and `runTier3` with the brain's real daily ledger and attempt store: prompt version 1, at most one corrective re-ask, gates (a) to (g) and the Tier 1 fixed point. The per-page cap stayed at the production $0.05. `gpt-6.1-sol` was priced at its $2/$10 list rate through `pricing.overrides`, as `gbrain pricing set` would, because gbrain's price table lacks it. 1,170 fixture runs in all; no provider errors occurred.

**Models.** The newest Opus, Sonnet, GPT and Fable (`claude-opus-5-5`, `claude-sonnet-5-5`, `gpt-6.1-sol`, `claude-fable-5-1`) plus the shipped default, `claude-opus-4-7`, which is the subject of the rule.

## Results

Pooled over three runs: 198 repairable, 18 ambiguous and 9 unrecoverable fixture runs per model.

| Model | Gate-pass | False-accept | Byte-identical | Ambiguous held | Unrecoverable held | USD per repair | Latency p50 / p95 | Rule |
|---|---|---|---|---|---|---|---|---|
| `claude-opus-4-7` (default) | 195/198, **98.5%** [95.6, 99.5] | 8/198, **4.0%** [2.1, 7.8] | 117 | 14/18 | 9/9 | $0.0075 | 1.9 s / 5.0 s | fails |
| `claude-opus-5-5` | 195/198, 98.5% [95.6, 99.5] | 3/198, 1.5% [0.5, 4.4] | 165 | 18/18 | 9/9 | $0.0071 | 3.8 s / 10.9 s | fails |
| `claude-sonnet-5-5` | 195/198, 98.5% [95.6, 99.5] | 10/198, 5.1% [2.8, 9.0] | 77 | 15/18 | 9/9 | $0.0029 | 1.7 s / 3.7 s | fails |
| `gpt-6.1-sol` | 198/198, **100%** [98.1, 100] | 1/198, **0.5%** [0.1, 2.8] | 115 | 7/18 | 9/9 | $0.0023 | 3.3 s / 12.0 s | **meets** |
| `claude-fable-5-1` | 191/198, **96.5%** [92.9, 98.3] | 0/198, **0%** [0, 1.9] | 143 | 18/18 | 9/9 | $0.0174 | 5.7 s / 11.6 s | **meets** |

Brackets are Wilson 95% intervals in percent. Byte-identical counts repairs that matched the ground truth character for character; the rest matched cell for cell with different spacing. Per-run gate-pass rates were 65, 65 and 65 of 66 for the three models at 98.5%, 66 in every run for `gpt-6.1-sol`, and 64, 64 and 63 for Fable 5.1.

**Where the wrong writes came from.** False accepts concentrate in a few fixtures, and every one is a free-text cell in the wrong column of a misaligned row:

| Model | False accepts by fixture |
|---|---|
| `claude-opus-4-7` | `f-ex-06` 3, `f-mix-01` 3, `f-sg-01` 2: a source moved to context after an empty cell was deleted or inserted |
| `claude-opus-5-5` | `f-sg-03` 3: a date the claim calls an end date, written as `valid_from` |
| `claude-sonnet-5-5` | `f-ex-06` 3, `f-mix-01` 3, `f-ex-03` 2, `f-sg-03` 2 |
| `gpt-6.1-sol` | `f-sg-03` 1 |
| `claude-fable-5-1` | none |

By class, no model wrote a wrong cell on short rows with trailing cells missing (45 of 45 repaired), rows before the header (24 of 24) or unknown header columns (30 of 30). All wrong writes were on short rows with a gap in the middle, extra cells, or the mixed fixtures.

**Where repairs were held.** One fixture, `f-nh-03` (two typed 14-column rows with no header), was held for four of the five models in all three runs: by gate (f) for Opus 4.7 and Sonnet 5.5, and because the answer ran out of output tokens for Opus 5.5 and Fable 5.1. Only `gpt-6.1-sol` repaired it. The cause is a layout bug, described below. Fable 5.1's other four holds were also output-budget stops (`f-mix-01` twice, `f-ex-05`, `f-sg-03`).

**Ambiguous fences.** How each model kept them held matters as much as the count:

| Model | Accepted (wrong writes) | Held by a gate | Held because the output budget ran out |
|---|---|---|---|
| `claude-opus-4-7` | 4 (`f-adv-02` 3, `f-adv-01` 1) | 14 | 0 |
| `claude-opus-5-5` | 0 | 2 | 16 |
| `claude-sonnet-5-5` | 3 (`f-adv-03` 3) | 15 | 0 |
| `gpt-6.1-sol` | 11 (`f-adv-03` 3, `f-adv-05` 3, `f-adv-02` 2, `f-adv-04` 2, `f-adv-01` 1) | 1 | 6 |
| `claude-fable-5-1` | 0 | 3 | 15 |

Opus 5.5 and Fable 5.1 did not decline these rows; they spent the whole output budget thinking and returned nothing, which Tier 3 records as `llm_empty` or `llm_truncated`. No model made the `private`/`world` row world-visible: `gpt-6.1-sol`'s two accepted repairs of `f-adv-04` kept `private` and moved `world` into the context. The gate-limited split claim (`f-gl-02`, an unescaped pipe that cut the claim in two) was accepted with the claim still cut in 9 of 15 runs across models, because gate (b) compares against the already-cut claim.

**Cost.** Mean tokens per call ranged from 525 in and 153 out (`gpt-6.1-sol`) to 754 in and 128 out (Opus 4.7). Opus 5.5 and Fable 5.1 averaged 233 and 217 output tokens, most of it thinking. Unregistered, gbrain meters `gpt-6.1-sol` at its highest known chat rate, which would make it $0.0114 per repair instead of $0.0023.

## The verdict against the decision rule

1. **Primary.** The default, `claude-opus-4-7`, has gate-pass 98.5% (passes, bar 80%) and false-accept 4.0% (fails, bar 1%). It does not meet the rule.
2. **Fallback.** Two other models meet both thresholds: `gpt-6.1-sol` and `claude-fable-5-1`. So the rule recommends a different default model rather than turning Tier 3 off.
3. **Model choice.** `gpt-6.1-sol` has the highest gate-pass rate, and no cheaper model meets the rule, so it is the recommended default.

The rule does not know that defaults are key-aware. Read with that in mind: Tier 3 should stay on with `gpt-6.1-sol` where an OpenAI key is configured and with Fable 5.1 on Anthropic-only installs, or go off by default where neither is acceptable; keeping Opus 4.7 as the default does not meet the bar. Changing the default is gbrain's decision. Opus 5.5 missed the false-accept bar by two fixture runs, and all three of its false accepts are on one fixture with a meaning-dependent date (see limits).

## Weaknesses found and proposed changes

Nothing below was changed in this experiment. Each proposal needs its own run of this eval.

1. **Stray empty cells are realigned by the model, and wrongly.** Most false accepts (6 of Opus 4.7's 8, 8 of Sonnet 5.5's 10) are rows with an extra empty cell. A deterministic Tier 1 rule would handle them: try deleting empty cells until the row has the canonical width, and apply the deletion only if exactly one choice makes every validated column valid. Checked offline on these fixtures, it reproduces the ground truth for 12 of the 13 repairable extra-cell rows (all but `f-ex-05`, whose extra cell holds text) and finds no valid choice for every adversarial and gate-limited row, so those still go to the model or stay held.
2. **Headerless typed rows get the narrow header.** `wideLayout` in `src/core/fence-repair/llm.ts` only counts rows the strict parser accepts, and no row is accepted in a fence without a header. So for `f-nh-03` the prompt says the table "starts with this header, unchanged" and gives the 10-column header for 14-cell rows. A model that complies must drop the typed columns, and gate (f) rejects it. Proposed: decide the layout of a headerless fence from the rows' cell counts.
3. **The output budget does not allow for thinking.** `tier3TokenBudget` caps output at about 512 tokens for small fences, but thinking cannot be turned off for Claude 5-series models (the provider SDK warns and uses adaptive or minimal thinking instead) and `gpt-6.1-sol` reasons by default. Opus 5.5 hit the cap on 24 calls, Fable 5.1 on 25 and `gpt-6.1-sol` on 6, which cost Fable 7 repairs. Proposed: add a reasoning allowance for thinking models. At Fable's $50 per million output tokens, a 2,500-token budget estimates above the $0.05 per-page cap, so the cap and the budget need to be set together.
4. **The prompt has no way to decline.** Prompt v1 tells the model to place every cell and never invent one, but not what to do when a row has two readings. `gpt-6.1-sol` guessed on 11 of 18 ambiguous runs. Proposed: a rule such as "If a row has two values for one column, or a cell fits more than one column, return the single word HOLD", recorded as its own held reason, with a prompt version bump.
5. **The corrective re-ask steers toward whatever the gates allow.** On `f-adv-05`, `gpt-6.1-sol` first put the `owner` cell in context, which gate (f) rejects for an aligned row; after the re-ask named gate (f) it moved the cell to `valid_until`, the one free column the gates allow, and the wrong repair was accepted (3 of 3 runs). With a decline option, the re-ask should repeat it.
6. **A claim cut by an unescaped pipe is written cut.** Gate (b) protects the claim as read, which for `f-gl-02` is already the first half. A Tier 1 check that holds a row whose first extra cell directly follows the claim and holds text (reason such as `claim_split`) would stop these writes; it would also hold `f-ex-05`, a rarer pattern.
7. **`gpt-6.1-sol` is missing from gbrain's price table.** If it becomes a default, add it to `CANONICAL_PRICING`; unregistered, each call is metered at five times its list price and the per-page cap refuses larger fences.

## What to use and what to avoid

- **Keep the gates.** They held every unrecoverable fixture and every gate-limited fixture except the cut claim, and they rejected every answer that dropped or rewrote cell text.
- **Prefer a model that meets the bar.** `gpt-6.1-sol` is the most accurate and cheapest here; Fable 5.1 is the Anthropic option, slower and 7.5 times the cost of `gpt-6.1-sol` per repair.
- **Treat model-written rows on misaligned fences as reviewable.** Every wrong write measured was on a row with a cell missing in the middle or an extra cell. Rows with trailing cells missing, rows above the header and unknown header columns came out right on every model.
- **If Opus 4.7 stays the default,** expect about one wrong cell in 25 model repairs on fences like these, and turn the model tier off (`gbrain config set fences.repair.llm false`) where that is not acceptable.

## Limits of this result

- **Synthetic, hand-labeled fixtures.** The fences are invented and the ground truths were written by the agent running the experiment without human review. The mix of classes is a design choice; how often each malformation occurs in real brains is not measured here.
- **One meaning-dependent fixture.** In `f-sg-03` the claim says the pilot "ends on 2026-06-30", so the date belongs in `valid_until`. Writing it as `valid_from` is the only false accept for Opus 5.5 (3) and `gpt-6.1-sol` (1). Without that fixture, both have 0 false accepts in 195 runs; the preregistered result counts it.
- **Runs are not independent.** 198 repairable runs are 66 fixtures three times, and wrong writes repeat on the same fixtures, so the Wilson intervals are narrower than the evidence. Distinct fixtures with a false accept: Opus 4.7 3, Sonnet 5.5 4, Opus 5.5 1, `gpt-6.1-sol` 1, Fable 5.1 0.
- **Stops before the write.** The harness runs the free tiers and Tier 3 exactly as `gbrain repair fences` does, then compares the repaired page; it does not exercise the write, receipt or commit that follow.
- **Model settings are the production ones,** including thinking that cannot be turned off on Claude 5-series models. A different effort setting may change the output-budget stops.

## Reproduce and inspect

In a gbrain checkout at `171a7e24` with Bun 1.4.2 and the provider keys:

```bash
bun evals/fence-repair-tier3/harness.ts --oracle                                       # $0 label check
bun evals/fence-repair-tier3/harness.ts --model default --run 1 --out opus-4-7-default-run1.jsonl --max-usd 10
bun evals/fence-repair-tier3/harness.ts --model openai:gpt-6.1-sol --run 1 --out gpt-6.1-sol-run1.jsonl --max-usd 10
bun evals/fence-repair-tier3/harness.ts --score results/*.jsonl --json summary.json   # $0
```

Files in [`2026-10-06-fence-repair-tier3/`](2026-10-06-fence-repair-tier3/): `results/<model>-run<n>.jsonl` (one row per fixture run: outcome, gate or failure class, match, per-call tokens, USD, latency and the model's answer text) with a `.meta.json` per run (model, gbrain commit, prompt and fixture hashes, caps), `summary.json` (the scorer output), `verdict.json`, `fixtures.jsonl`, and `setup/` (the 3-fixture setup run on `claude-sonnet-5-5`, excluded from scoring). All 15 runs ran in parallel in about 10 minutes. Spend: $9.75 for the scored runs ($1.93 Opus 4.7, $1.99 Opus 5.5, $0.77 Sonnet 5.5, $0.68 `gpt-6.1-sol`, $4.37 Fable 5.1), $0.01 for the setup run and about $0.04 for the five gateway checks before the preregistration.
