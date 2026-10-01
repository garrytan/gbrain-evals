# System One v1 datasets

Labelled inputs for gbrain's System One v1 eval (Jev decision support,
measured 2026-09-30). The [report](../../../docs/benchmarks/2026-09-30-system-one-jev.md)
explains the slots and results. Files were copied byte for byte from
garrytan/gbrain `feat/system-one-v1` at `fc9a1d45`
(`docs/eval/system-one/datasets/`), except where noted below.

Every line uses gbrain's dataset schema (`id`, `family`, `slot`, `split`,
`state`, `inputs`, `label`), written by `gbrain decide dataset`, which assigns
each family to the calibrate or eval half by a stable hash. Most lines also
carry `label_source`. Do not edit these files: the dataset hash and split hash
are what gbrain's calibrations and this repository's tests check.

## Where each label comes from

None of these labels was written by a person reviewing the item.

| Dataset | Slot | Label source | How the label was made |
|---|---|---|---|
| `s7-triage` (rebuilt) | S7 triage | benchmark annotation (24) and generator construction (230) | Cat 35 transcripts keep that corpus's `expected_triage`. The synthetic transcripts were written by `openai:gpt-5.6-luna` from a seeded spec list; the label is the spec's instruction (routine, or one buried decision, commitment or reflection). |
| `s9-conflict.jsonl`, `s9-conflict.sweep-eligible.jsonl` | S9 conflict | generator construction (780) and labelled gbrain tests (6) | A seeded template generator (Mulberry32, seed 90909) writes duplicate, supersede and independent pairs over invented people and companies. |
| `s6-recall-needed.brainbench.jsonl` | S6 know-to-ask | benchmark annotation | gbrain's BrainBench know-to-ask sealed gold. |
| `s6-recall-needed.extra.jsonl` | S6 know-to-ask | generator construction | The reflex-miss corpus in `know-to-ask-extra/` (Mulberry32, seed 60601); `_design.json` records each turn's designed intent. |
| `s6-recall-needed.combined.jsonl` | S6 know-to-ask | both of the above | The two files concatenated. |
| `s8-grounding` (rebuilt) | S8 grounding | LLM (`claude-sonnet-5`) | 567 sentences from Cat 35 dream pages judged supported or unsupported, plus 183 perturbed negatives written and blind-judged by the same model. |
| `s2-intent.jsonl` | S2 intent | benchmark annotation | LongMemEval `question_type` and BrainBench relational fixtures. |
| `s5-injection.jsonl` | S5 injection | fixture author | gbrain's `test/fixtures/decide/injection-cases.jsonl`, 12 cases. |
| `s3-evidence` (external) | S3 evidence | benchmark annotation | LongMemEval answer sessions. |
| `s4-answerable` (external) | S4 answerable | benchmark annotation | LongMemEval abstention questions. |

`datasets.json` holds the same information in machine-readable form, with each
dataset's hash, split hash, item, family and split counts.
[`HASHES.md`](HASHES.md) is gbrain's own hash table, copied unchanged.

## What is stored here and what is rebuilt

- **Committed as built:** S2, S5, the three S6 files and the two S9 files.
- **Rebuilt from committed inputs (S7, S8).** Both embed Cat 35 transcripts,
  which already live in [`../transcript-distill-v1/`](../transcript-distill-v1/).
  This directory keeps only what that corpus lacks: the 230 synthetic S7
  transcripts with their gold (`s7-triage-synthetic/`) and the S8 labels
  (`s8-grounding/labels.jsonl`). `eval/runner/system-one/datasets.ts` restages
  the layout gbrain's builder read, and `system-one-jev.ts build` runs
  `gbrain decide dataset` and checks the frozen hashes.
- **Rebuilt from LongMemEval-S (S3, S4).** The S3 file is 57 MB, so only its
  hash and the builder command are recorded. `build --longmemeval-s <file>`
  checks the download's sha256 before building.
- **Question lists.** `longmemeval/s-eval-half.txt` (the 248 eval-half
  questions of the S3 split) and `longmemeval/s-eval-judged-100.txt` (85
  answerable plus all 15 eval-half abstention questions). The 28-question M
  pilot list is derived from [`../longmemeval-m-pilot-selection.json`](../longmemeval-m-pilot-selection.json).
- `preset-dream-29.txt`: the 29 eval-half transcripts of the preset
  end-to-end dream run.

The generators that produced these files are in
`docs/benchmarks/2026-09-30-system-one-jev/upstream/generators/`. They import
gbrain internals and run from a gbrain checkout.

## Names

All people, companies and projects in these files are invented by the
generators or by the Cat 35 corpus. The routine synthetic chats mention common
software products (spreadsheets, calendars, printer drivers) as part of
ordinary tasks; no file contains personal brain content.
