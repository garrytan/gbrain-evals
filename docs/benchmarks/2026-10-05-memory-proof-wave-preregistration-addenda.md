# Memory proof wave preregistration: addenda after the sealed open

The [preregistration](2026-10-05-memory-proof-wave-preregistration.md) was frozen when the sealed BEAM strata were opened. The sealed-open line in the access log records its SHA-256, `6544b2014fbc63331641b5794c106a231d242e4fc8291051f12bdb46f33e5e17`. Later decisions that don't change the analysis are recorded here, dated, instead of editing that file.

## BEAM 10M is reserved for another campaign (October 6, 2026)

BEAM 10M is another campaign's held-out set. This wave never opens, ingests or answers any BEAM 10M conversation. Its ledger line (line 7) was dropped and the budget was not reallocated. Before that decision, the wave had touched the 10M split only through two free input scans, both run programmatically:

- `mpw.ledger_inputs`: counted questions, rubric items and cl100k document tokens for the cell ledger.
- `mpw.timestamp_manifest`: read session time fields. No 10M document carries one.

Only counts and a row hash were committed: `eval/harness-provider/ledger/inputs.json` and `eval/harness-provider/timestamp-manifests/beam-10m.json`. No BEAM 10M question, rubric, gold answer or document text was viewed, printed or committed. No BEAM 10M cell was planned, ingested or answered. The power inputs never read the comparator's committed BEAM 10M rows, which ship inside the pinned harness checkout. The two scans no longer list BEAM 10M.

## LongMemEval-M dropped from ledger line 8 (October 6, 2026)

The harness pin does not load LongMemEval-M. Line 8 keeps only the extra frontier points on sealed BEAM.

## Eval model rule: Fable is smoke-test only (October 7, 2026)

Garry ruled that Opus 5.5 is the top Anthropic model in counted runs, and that Fable runs only in small smoke tests. No counted cell this wave still has to run uses Fable:

- The sealed primary and its validation use `gemini-3.8-flash` as the reader and `gemini-3.5-flash` as the judge.
- The secondary rows (LongMemEval-S, LoCoMo10, PersonaMem, LifeBench) and the extra sealed frontier points (ledger line 8) use `gemini-3.8-flash`.

The only Fable reader in the plan was the B-suite frontier sweep (ledger line 4, a quarter of questions across Opus 5.5, gpt-6-astra and Fable 5.1). That sweep has already run and stays as recorded. No gate's model set changes, and nothing is saved in the remaining cells.
