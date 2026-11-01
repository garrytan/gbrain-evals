# particle-1 reader tokenizer calibration (2026-11-01)

**This is a calibration run on development data, not a result.** It measures how many input tokens Particle bills
for a packed Q1 prompt compared with the local tiktoken count, so the packer can budget particle-1's prompts. It ran
one LoCoMo dev cell of 20 questions and gives no scoreboard number. The calibration is unit U5 of the particle-1 plan
(plan GST-605, Phase 2, item 1; build issue GST-646).

## The finding

**particle-1's prompt tokens track `o200k_base` with a factor of 1.0488 and a largest per-pack error of 0.50% over
20 packs, inside the 3% bar.** A local count is good enough to pack particle-1's prompts of this size, so the plan's
tokenizer fallback (a pinned DeepSeek tokenizer or a wider fit margin) is not needed for them. Every sample was a
packed prompt of 8,064 to 8,113 `o200k_base` tokens from one conversation, so the run cannot tell a ratio from a fixed
per-request overhead: adding 403 tokens fits the same samples with a largest error of 0.43%. The two readings differ
by about 15% on a 2,000-token pack and 2% on a 16,000-token pack, so Q1's 2,000- and 16,000-token arms and the
full-context fit check need samples at those sizes before particle-1 reads a counted arm.
`cl100k_base` fits even more closely (factor 1.0118, largest error 0.11%), but the table keeps `o200k_base`, its encoding before the run, because both are far
inside the bar. The factor is in `READER_TOKENIZERS['particle:particle-1']`
([render-v2.ts](../../../eval/runner/systems/render-v2.ts)).

## How it ran

- **Command.** `bun eval/runner/q1/calibration-cell.ts --reader particle:particle-1 --out <dir> --budget-ledger
  <ledger> --run-id u5-calibration-2026-11-01 --lease-usd 1.45 --cell s3-smoke.baseline-hybrid.baseline` at branch
  head `5a907478`, from 06:00 to 06:06 UTC. A one-request preflight (ledger run `u5-preflight-2026-11-01`,
  $0.00002525) ran first. A keyless run of the same cell against `eval/systems/_shim/fake_provider.py` passed before
  the paid one.
- **Cell.** The packed 8k arm of `s3-smoke.baseline-hybrid.baseline` (LoCoMo dev `conv-44`, 20 questions, the same
  questions as the [2026-10-07 dev smokes](../2026-10-06-scoreboard/dev-smokes/README.md)), read by
  `particle:particle-1` alone at effort medium, with no frontier judges. The canonical LoCoMo judge
  (`gpt-4o-2024-08-06`) judged each answer, as in any cell.
- **Metering.** Every request went through Q1's lease proxy, run in the same process: particle-1 on
  `/harness/particle/v1` under the `reader@particle:particle-1` cap of 16,000 output tokens, the judge on the
  2,048-token judge cap, embeddings on the extraction cap.
- **Answers.** All 20 were scored, none was truncated, and each took one attempt. Every request was sent at effort
  `medium`, which Particle runs at `high`, so each attempt records `effort_effective` `high`; that value comes from the
  provider module's effort table, not from the response. Three answers used more than 2,048 output tokens (the largest
  8,456), so they would have been cut off at the reader class cap that every other reader keeps.

## Spend

The lease proxy's usage fields recorded $0.0862, inside the unit's $1.50 share.

| Provider | Requests | Dollars |
|---|---:|---:|
| Particle, particle-1 readings | 20 | 0.069455 |
| Particle, preflight | 1 | 0.000025 |
| OpenAI, gpt-4o judge | 20 | 0.013815 |
| OpenAI, text-embedding-3-large | 70 | 0.002878 |

## Files

- [`calibration.json`](calibration.json): what `calibration-cell.ts` wrote: the factor and largest error under the
  table encoding and the other tiktoken encoding, and the lease's billed dollars.
- [`samples.ndjson`](samples.ndjson): one line per pack: the question, the context hash, Particle's
  `prompt_tokens`, and the local `o200k_base` and `cl100k_base` counts of the exact prompt.
- [`answers.ndjson`](answers.ndjson): each answer record without its text (a `text_sha256` stands in), with its
  provider attempts and the judge's score. Answer and context text stay outside the repository.
- [`receipt.json`](receipt.json) and [`run-config.json`](run-config.json): the cell's receipt and run config. The run
  config records particle-1's raised output limit as `reader.max_tokens_by_reader`.
- [`usage.ndjson`](usage.ndjson): the lease proxy's line for every request, with its route, cap and dollars.

To recompute the calibration from a cell output directory, run `bun eval/runner/q1/calibrate.ts <dir>`.
