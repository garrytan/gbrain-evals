# Preregistration: does model repair of malformed fences (Tier 3) earn its default? (2026-10-06)

Frozen on October 6, 2026, in its own commit, before any scored run. Nothing here changes after a run; a later change gets a new dated file.

## The question

gbrain keeps typed facts and takes as Markdown tables between marker comments (a **fence**). A fence an agent or a person writes by hand is sometimes malformed: a row is missing cells, a stray empty cell shifts the row, the header is missing or sits below a row, or the header uses a column name gbrain does not know. Since gbrain [#6188](https://github.com/garrytan/gbrain/issues/6188) a malformed fence is held instead of blocking a sync, and repaired in tiers:

- **Tier 1** applies deterministic rules where the fix has one meaning (header aliases, enum synonyms, numbering, closing a fence).
- **Tier 3** handles what Tier 1 leaves for these five reasons: `short_row`, `no_header`, `row_before_header`, `extra_cells` and `header_unmapped`. It sends only the header and the affected rows (the whole fence for a fence-level reason) to the configured chat model with a fixed prompt (version 1) and asks for the same rows realigned under the canonical header. Every answer must pass validation gates (a) to (g): it compiles, no row is added, dropped or reordered, every claim and row number is unchanged, no row becomes more visible, no cell text changes or leaves its column except by a named rule, and nothing hidden is exposed. It must also be a Tier 1 fixed point. A rejected answer gets one corrective re-ask naming the failed gate and rows.

Tier 3 is on by default (`fences.repair.llm`), with `models.fence_repair` resolving to `anthropic:claude-opus-4-7` on an install with an Anthropic key. Its behavior-change notice says how often the model's rewrites are accepted is not yet measured. Taste decision T4 in the #6188 plan requires this measurement before ship.

This experiment asks:

1. How often does the default model's repair pass every gate (**gate-pass rate**)?
2. How often does a repair pass every gate but differ from the correct table (**false-accept rate**)? Those are wrong writes the gates did not catch.
3. Do fences whose only correct outcome is to stay held stay held?
4. Does a current frontier model do better, and at what cost and latency?

## The fixtures

`evals/fence-repair-tier3/` in gbrain at commit [`171a7e24`](https://github.com/garrytan/gbrain/commit/171a7e24663640987f8c1e773202aa296d196a89) on branch `capy/6188-t4-eval` (the #6188 PR 4 work in progress, `85694d06`, plus the eval). `fixtures.jsonl` sha256 `769f7f04cda52128144383a95b1940228b684b80ed2743b81e7db05784799896`, generated from the hand-written `cases.ts`. 78 synthetic pages with placeholder names only. Each page holds one malformed fence (one page holds a facts and a takes fence). The ground truth for each is the whole repaired section, written by hand by the agent running this experiment (Capy) before any run; no person reviewed it.

| Set | Count | What the correct outcome is |
|---|---|---|
| Repairable | 66 | The hand-written repaired table |
| Adversarial, ambiguous | 6 | Stay held: the row has two readings (two confidences, two kinds, two notabilities, two holders, `private` and `world` on a world page, a column with no home in a facts table) |
| Adversarial, unrecoverable | 3 | Stay held: a required value (confidence, visibility and notability, weight) is missing |
| Gate-limited | 3 | A person would repair it, but the gates forbid the correct table; diagnostic only |

Repairable fences by residual class: short rows with trailing cells missing 15 (10 facts, 5 takes), short rows with a cell missing in the middle 7, no header 10, a row before the header 8, extra cells 11, an unknown header column 10, several problems in one fence 5. 44 pages hold a facts fence, 21 a takes fence and one holds both. Tricky content inside them: links (10), struck-through claims (9), money and counts with k/M suffixes (7), escaped pipes (4), world-visible pages (5), timeline-section fences (3), typed 14-column rows (2), a `<br>` (1), rows without row numbers (2), and two cases where Tier 1 finishes the job after the model (a `85%` confidence and a kind synonym).

**The oracle check** (`bun evals/fence-repair-tier3/harness.ts --oracle`, also the keyless test `test/eval-fence-repair-tier3.test.ts`) ran every fixture through the production path with a scripted model at $0, with 0 violations: every fixture reaches Tier 3 with its class's residual reason; each repairable ground truth passes every gate and comes out byte-identical (the two rows-without-numbers cases also with the `#` cells left empty, as the prompt asks); each gate-limited ground truth is rejected (gates b, b, d); each ambiguous probe, a plausible wrong guess, is **accepted** by the gates, so only the model can keep those pages held; each unrecoverable probe, which invents a value, is rejected (gate f).

## The arms

| Model | Why it runs |
|---|---|
| `anthropic:claude-opus-4-7` | gbrain's current default for `models.fence_repair` (deep tier, `TIER_DEFAULTS.deep`, with an Anthropic key and no config; checked with `resolveFenceRepairModel` on an empty brain). It is the subject of the decision rule, run as the shipped default, not as a link to an older result. |
| `anthropic:claude-opus-5-5` | Newest Opus (Anthropic models API, created 2026-09-21) |
| `anthropic:claude-sonnet-5-5` | Newest Sonnet (2026-09-28) |
| `openai:gpt-6.1-sol` | Newest GPT (OpenAI models API, created 2026-09-27). `gpt-6-astra` is an earlier GPT-6 release (2026-08-27), so under "Choose models" it does not run; the 2026-10-05 registration-surface preregistration made the same choice. |
| `anthropic:claude-fable-5-1` | Newest Fable (2026-08-28) |

No `gpt-5.4-mini`, no other older generation. No earlier Tier 3 result exists, so no link model is needed.

Before this file was written, the five models each answered one ad-hoc single-row fence (not a fixture) through `callTier3` to confirm the gateway reaches them. No fixture was sent to any model.

## The procedure

`bun evals/fence-repair-tier3/harness.ts --model <id> --run <n> --out <file> --max-usd 10`, Bun 1.4.2, per model and run:

1. A fresh in-memory PGLite brain, so the daily ledger and the attempt memo start empty.
2. `models.fence_repair` is set to the model, through gbrain's own resolution. `pricing.overrides` registers `openai:gpt-6.1-sol` at $2 input and $10 output per million tokens (the list price in this repository's `eval/runner/budget-ledger.ts`), because gbrain's price table lacks it. Unregistered, gbrain meters an unpriced model at its highest chat rate.
3. `fences.repair.max_usd_per_day` is set to $10, a hard ceiling per run that the daily ledger enforces. `fences.repair.max_usd_per_page` stays at the production default of $0.05, so a corrective re-ask the per-page cap cannot cover is refused, as in production. Per-call timeout 90 seconds (the production default).
4. Each fixture becomes a stored-page target. `analyzeFences` runs the free tiers and `runTier3` makes the calls with the brain's real ledger and attempt store, exactly as `gbrain repair fences` does before writing. Nothing in the harness re-implements a tier or a gate, and the prompt is unchanged.
5. A provider error (`llm_unavailable`, which production retries on the next run) is retried up to twice after a pause. Every other outcome stands.

Three runs per model, each on a fresh brain: 5 models × 3 runs × 78 fixtures = 1,170 fixture runs. A setup run of 3 fixtures on `claude-sonnet-5-5` checks the live harness first; it is reported and excluded from scoring. Expected spend is about $15; the program cap is $60.

## Measurements

Per fixture run: the outcome (repaired, or held with its gate letter or failure class: `llm_malformed`, `llm_truncated`, `llm_refused`, `llm_empty`, `llm_unavailable`, `budget_exhausted`), whether a re-ask ran, the match against the ground truth, input and output tokens per call, ledger-priced USD, wall time and the model's answer text.

- **Gate-pass rate**: repairable fixture runs repaired, over repairable fixture runs.
- **False-accept rate**: repairable fixture runs repaired whose table does not match the ground truth, over repairable fixture runs. A match means every fence has the same non-empty cell text in the same columns (spacing ignored, `\|` read as `|`) and the text outside the fences is identical. A byte-identical rate is reported beside it.
- **Held correctly**: adversarial fixture runs that stayed held, over adversarial fixture runs, split into ambiguous and unrecoverable.
- **USD per repair**: ledger-priced spend on repairable fixture runs over repairs, plus USD per fixture run.
- **Latency**: wall time of the Tier 3 step per fixture run that made a call, p50 and p95.

Rates pool the three runs (198 repairable fixture runs per model) and carry Wilson 95% intervals; per-run gate-pass rates are reported to show run-to-run spread. Exploratory, never decisive: rates by class and tag, failure classes, re-asks that rescued a repair, gate-limited outcomes, and gpt-6.1-sol's cost if its price were not registered.

## Decision rule

**Primary.** Tier 3 stays on by default with the current default model if `anthropic:claude-opus-4-7`, pooled over its three runs, has a gate-pass rate of at least 80% **and** a false-accept rate of at most 1%.

**If it fails**, recommend another run model as the default if one meets both thresholds; if none does, recommend Tier 3 off by default (`fences.repair.llm` false), still available as an opt-in.

**Model choice** (applies whether or not the default passes). Among the models that meet both thresholds, the recommended default is the one with the highest pooled gate-pass rate, unless its Wilson interval overlaps that of a cheaper model that also meets both thresholds; then the cheapest such model (lowest USD per repair) is recommended. If the current default meets the rule and a newer model is recommended under this clause, the report says so; changing gbrain's default is gbrain's decision.

**Adversarial fixtures do not enter the rule.** Their count is set by this design, not by how often such fences occur. Any accepted ambiguous fixture is reported with the model's answer and a proposed prompt or gate change. An accepted repair of the `private`/`world` fixture that makes the row world-visible is reported as a privacy finding with a proposed gate (d) change.

A model at 100% on every measure is reported as a ceiling, not a win. Models are reported in this order: the current default, then Opus 5.5, Sonnet 5.5, GPT-6.1 Sol and Fable 5.1.

## What this does not change

The gates are not weakened and the prompt is not edited in this experiment; weaknesses found are proposed with evidence. The fixtures are not regenerated after a run.
