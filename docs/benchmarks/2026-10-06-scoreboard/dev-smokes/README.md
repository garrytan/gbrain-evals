# Q1 scoreboard: paid dev smokes (2026-10-07)

**These are dev smokes, not results.** They ran on development data only, to test the harness end to end, measure the
token, cost and speed assumptions the cell manifest is priced from, calibrate the reader tokenizers and rank the dev
strength of each system for the shrink rule. Each 8k row is 20 questions on one conversation, so a difference of a few
points between systems is noise (one question is 5 points). Nothing here is a scoreboard number.

- **Data.** Lane L8 used LoCoMo dev `conv-44` (20 questions, stratified by category, seed `q1-smoke`; 28 sessions,
  20,474 cl100k tokens) and BEAM-1M dev `1m-16` (928 sessions, 926,773 tokens). LoCoMo is one file, `locomo10.json`;
  the loader now drops every conversation outside the cell's dev list right after parsing, so no sealed conversation
  reaches the harness. Only `1m-16`'s two files were downloaded for BEAM (`eval:decide fetch --conversations`). No
  sealed BEAM conversation and no BEAM-10M file was fetched or read.
- **Cells.** Lane L8 used the `smoke_cells` in [`q1-cells.json`](../../../../eval/runner/q1/cells/q1-cells.json): set
  `S3-smoke` (component 8k with the three readers and the canonical judge, gbrain synthesize, the file agent, full
  context), `S3-smoke-default` (each system's own default amount, read by `claude-sonnet-5-5` only) and `S2b-ingest`
  (retrieval-only ingest probes). Each cell ran through the front door (`bun run eval:scoreboard smoke`), in its own
  lease and metering proxy: in-process baselines and gbrain-defaults ran on the Capy machine, the external systems on
  Ubicloud `standard-4` VMs (owner `gbra49`, torn down after each cell).
- **Readers and judge.** The readers were `anthropic:claude-opus-5-5`, `openai:gpt-6.1-sol` and
  `anthropic:claude-sonnet-5-5` at effort medium, and the judge was `gpt-4o-2024-08-06` (the canonical LoCoMo
  instrument). Fable was not used.
- **Files.** [`aggregates.json`](aggregates.json) holds the allowlisted receipt fields of every arm (counts, per-reader
  means, timings, spend, ingest), with no answer or context text. [`calibration.json`](calibration.json) and
  [`dev-strength.json`](dev-strength.json) hold the calibration and power inputs.
  The hedge classifiers' aggregate numbers on three blind, hand-labeled 200-answer samples of these answers, each
  drawn fresh and labeled by a different labeler (labels and answer text stay outside the repository; each file
  carries its sample design and label counts): [`hedge-v1-validation.json`](hedge-v1-validation.json),
  [`hedge-v2-validation.json`](hedge-v2-validation.json) and [`hedge-v3-validation.json`](hedge-v3-validation.json).
  None met the 0.90 abstain-precision bar (0.42, 0.881, 0.893), so under amendment A6 the confident-error and
  false-abstention columns are not published (`hedge_classifier: none`). The development numbers are
  [`hedge-v2-dev.json`](hedge-v2-dev.json) (first sample) and [`hedge-v3-dev.json`](hedge-v3-dev.json) (first two
  samples, 400 answers).

## Spend

The ledgers recorded about $53.75 in total, inside the lane's $150 cap. For the two runs stopped mid-flight, the figure
is the proxy's last billed total. Ubicloud VM time is billed outside the ledgers.

| Run | Dollars |
|---|---:|
| 8k component smokes: 3 baselines, 5 externals, gbrain-defaults (with synthesize) | 24.39 |
| File agent ($1.80) and full context ($1.04 complete; $1.91 for a first run that hit its lease at 57 of 60) | 4.75 |
| Own-default-amount cells (7 systems, `claude-sonnet-5-5` only) | 5.12 |
| BEAM-1M ingest probes (5) | 6.32 |
| Superseded runs: extract-first LoCoMo ($1.60) and BEAM ($0.44) runs degraded by the 600 s /finish bug; temporal-graph lease-exhausted ($3.82) and tripwire-invalid ($1.99) runs; the whole-conversation graph-pipeline probe, stopped at $1.27; a first no-memory run ($0.03) | 9.15 |
| Extract-first LoCoMo rerun (57 of 60 answers; its lease ran out) | 3.99 |

## Smoke outcomes (8k component, three readers)

| System (kind) | Configuration | Outcome | Opus 5.5 | GPT-6.1 Sol | Sonnet 5.5 | Three-reader mean |
|---|---|---|---:|---:|---:|---:|
| `gbrain-defaults` | shipped defaults | worked | 0.80 | 0.70 | 0.85 | 0.783 |
| `ext-extract-first` | recipe | worked on rerun (57/60: lease ran out after a 2.25 h queue drain) | 0.89 | 0.68 | 0.84 | 0.807 |
| `ext-memory-bank` | recipe | worked | 0.85 | 0.65 | 0.70 | 0.733 |
| `ext-graph-pipeline` | recipe | worked | 0.90 | 0.65 | 0.75 | 0.767 |
| `ext-temporal-graph` | recipe | worked on the third run (lease, then tripwire bug) | 0.85 | 0.65 | 0.90 | 0.800 |
| `ext-markdown-kb` | recipe | worked | 0.85 | 0.75 | 0.80 | 0.800 |
| `ext-verbatim-session` | recipe | worked | 0.65 | 0.55 | 0.55 | 0.583 |
| `baseline-recency` | baseline | worked | 0.65 | 0.50 | 0.55 | 0.567 |
| `baseline-hybrid` | baseline | worked | 0.80 | 0.70 | 0.75 | 0.750 |
| `baseline-none` | baseline | worked | 0.30 | 0.30 | 0.30 | 0.300 |

The whole-system rows on the same 20 questions:

- **File agent.** Opus 0.85, GPT 0.70 and Sonnet 0.80, $1.80. It worked after the agent route class fix.
- **gbrain `synthesize`.** It answered as `own:anthropic:claude-opus-4-7` and scored 0.85, at 34,700 input and 850
  output tokens per answer.
- **Full context.** 0.75 for every reader, at about 24,700 cl100k tokens of history per question (about 38,000
  Claude tokens), read from the prompt cache.

Own default amount (`claude-sonnet-5-5`, delivered cl100k tokens):

| System | Delivered | Score |
|---|---:|---:|
| `gbrain-defaults` | 23,800 | 0.72 (18 of 20; lease) |
| `ext-memory-bank` | 10,400 | 0.60 |
| `ext-verbatim-session` | 8,000 | 0.60 |
| `baseline-hybrid` | 7,100 | 0.70 |
| `ext-markdown-kb` | 2,300 | 0.75 |
| `ext-graph-pipeline` | 2,200 | 0.75 |
| `ext-extract-first` | 1,200 | 0.40 (degraded store: run before the /finish fix) |

## Failures and the harness fixes they led to

Every product ran once the harness was fixed. No product failure was recorded. These harness bugs surfaced and are fixed,
with tests:

1. Smoke units were `--limit 20` copies of counted cells, so an S3 or S2 smoke would have opened sealed data. Smoke
   cells are now dev-only `smoke_cells`: dev cells load only their conversations, `eval:decide fetch --conversations`
   and `bootstrap.sh setup --conversations` fetch only those files, and doctor checks only the named cells' datasets.
2. Anthropic refuses `temperature` on Claude 5 models ("deprecated"). Every Opus and Sonnet read failed until the chat
   client and full-context reads stopped sending it to them.
3. Ubicloud cells got no provider keys (the campaign never set `pass`), so every remote proxy refused every request.
4. The 2,048-token reader cap refused every file-agent turn (8,192 or 16,000 stated). The agent loop now runs on an
   `agent` slot with a 16,000 cap.
5. `/finish` waited only 600 s. A queued system (`ext-extract-first`) was read as degraded mid-drain on both LoCoMo and
   BEAM. The wait now defaults to 1.5 times the cell's expected hours, and expected hours come from measured per-system
   rates.
6. The leak tripwire refused every `ext-temporal-graph` retrieval: the category marker `temporal` sits inside the
   system's own policy name, which only shows once a corpus is cut down to one dev conversation. The HTTP client now
   scans the system name out first.
7. Probes that missed kept polling for 15 minutes after `/finish` reported ready. That was most of gbrain's ingest spend
   (732 polls, $1.29) and wall time on the smoke. Now a probe's next miss after the drain is final.
8. VMs installed Bun 1.3.14; they now install 1.4.2, like CI. The power test still expected four readers.

## Ingest projection for BEAM-10M (about 11M tokens per conversation)

Rates exclude probe polling. The rule: past 48 hours per conversation, or past 1.5 times the system's line, the system
runs common or is reported not run.

| System | Configuration | Probe | $/Mtok | h/Mtok | Per BEAM-10M conversation | S1 cell vs its line |
|---|---|---|---:|---:|---|---|
| `ext-extract-first` | common | whole `1m-16` | 2.80 | 1.74 | $31, 19 h | $375 vs $295 (1.27x) |
| `ext-memory-bank` | recipe | whole `1m-16` | 1.72 | 2.32 | $19, 26 h | $276 vs $240 (1.15x) |
| `ext-graph-pipeline` | recipe | first 93 sessions | 3.52 | 4.93 | $39, **54 h** | ~$454 vs $240 (**1.9x**) |
| `ext-graph-pipeline` | common | first 93 sessions | 3.98 | 3.09 | $44, 34 h | $507 vs $240 (**2.1x**) |
| `ext-temporal-graph` | common | first 93 sessions | 17.5 | 3.53 | $193, 39 h | $2,008 vs $1,406 (1.43x) |

The graph pipeline's recipe is over both limits on S1, so its S1 cell now runs `common`. The recipe stays on BEAM-1M
and BEAM-100K, where it fits. Its common configuration fits the 48 hours, but at 2.1 times the recipe's planned line it
is "reported not run" if the line is read per system. It runs if the line is read as the T1 block. That reading is the
owner's call. On LoCoMo the recipes measured $95/Mtok and 110 h/Mtok (extract-first), $90/Mtok and 6.6 h/Mtok
(temporal graph), $18.4/Mtok and 5.6 h/Mtok (graph pipeline) and $1.7/Mtok and 2.9 h/Mtok (memory bank).

## Token calibration

`bun eval/runner/q1/calibrate.ts` fits each reader's factor: provider input tokens per local token of the same packed
prompt, over every packed answer except the first no-memory run. The factors are in `READER_TOKENIZERS`
(`eval/runner/systems/render.ts`).

| Reader | Encoding | Factor | Max error | Packs |
|---|---|---:|---:|---:|
| `anthropic:claude-opus-5-5` | cl100k_base | 1.4708 | 10.1% | 199 |
| `anthropic:claude-sonnet-5-5` | cl100k_base | 1.4524 | 9.8% | 317 |
| `openai:gpt-6.1-sol` | o200k_base | 1.0009 | 4.7% (0% on full packs) | 199 |

The Claude errors are above the 3% the preregistration accepts for a local count, so the Claude readers need the
provider's count-tokens route (or a stated tolerance). The calibrated packer binds on the Claude count, so an 8,000-token
pack is about 5,450 cl100k tokens of evidence and about 5,300 GPT-6.1 tokens.

## Power

`bun eval/runner/q1/power.ts --sims 1000 --draws 1999 --seed 20261006 --dev-strength dev-strength.json` reran on the
three-reader means above. The detectable difference is 16.0 points for the nine-comparison family and 13.6 points after
the shrink. Family 1 stays descriptive. The shrink rule names `ext-extract-first`, `ext-markdown-kb`,
`ext-temporal-graph` and `ext-graph-pipeline`. By `claude-sonnet-5-5` alone (the preregistration's wording) the fourth
place is a tie between `ext-graph-pipeline` and `baseline-hybrid` at 0.75. No BEAM-1M dev reader row was run.

## Re-priced manifest

The estimate is now $7,133.52 in cells, under the $8,500 cap; the A1 re-cost was $5,417.59.

| Block | PLAN §7 line | Estimate | Hard cap |
|---|---:|---:|---:|
| T1 S1 headline | $3,995 | $4,068.78 | $6,103.17 |
| T2 S2a BEAM-100K | $585 | $456.27 | $684.41 |
| T2 S2b BEAM-1M | $1,720 | $1,424.89 | $2,137.34 |
| T2 S3 LoCoMo | $730 | $519.00 | $778.50 |
| T2 S4, S5 | $420 | **$664.58** | $996.87 |

**Over its line.** T2 S4/S5 comes to 1.58 times its PLAN §7 line. gbrain's readiness probes on 600 LongMemEval
haystacks account for $374 (S4) and $130 (S5): every haystack probes 21 sessions through gbrain's paid query path.
Probing a sample of haystacks would bring the block back under its line, but the preregistration asks for 20 sessions
per conversation, so it needs a decision. T1 is 1.02 times its line, driven by the temporal graph's $1,925 S1 ingest.

**Cells over 1.5 times their earlier estimate.**

- `s2b.ext-graph-pipeline.recipe`: 1.63x.
- `s3.ext-temporal-graph.recipe`: 1.58x.
- `s2b.gbrain-defaults.common-embedder`: 2.0x, from probes.
- The S3 second-ingest replicates of the LLM-extracting systems: large ratios, up to $24 (the temporal graph's).

What the measurements changed:

- **Readers.** Overhead fell from 1,000 to 180 tokens (Claude) and 130 (GPT). Output went from 400 to 720 (Opus) and
  395 (Sonnet), and from 1,000 to 155 (GPT).
- **Default amounts.** Each system's own default amount is now measured.
- **gbrain.** A query costs $0.00176, and synthesize reads 34.7k tokens in and writes 850 out.
- **Judge.** A canonical judge call is 370 tokens in and 2 out.
- **File agent.** S3 file-agent tokens are measured and cache-weighted.
- **Ingest.** Ingest dollars and hours per Mtok are measured per system, with probe spend per conversation added.
- **Not measured.** BEAM judges, `think`, the agent runtime, and the file agent on S1/S2 keep their assumptions.
