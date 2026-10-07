# Memory proof wave preregistration: addenda after the sealed open

The [preregistration](2026-10-05-memory-proof-wave-preregistration.md) was frozen when the sealed BEAM strata were opened. The sealed-open line in the access log records its SHA-256, `6544b2014fbc63331641b5794c106a231d242e4fc8291051f12bdb46f33e5e17`. Later decisions that don't change the analysis are recorded here, dated, instead of editing that file.

## BEAM 10M is reserved for another campaign (October 6, 2026)

BEAM 10M is another campaign's held-out set. This wave never opens, ingests or answers any BEAM 10M conversation. Its ledger line (line 7) was dropped and the budget was not reallocated. Before that decision, the wave had touched the 10M split only through two free input scans, both run programmatically:

- `mpw.ledger_inputs`: counted questions, rubric items and cl100k document tokens for the cell ledger.
- `mpw.timestamp_manifest`: read session time fields. No 10M document carries one.

Only counts and a row hash were committed: `eval/harness-provider/ledger/inputs.json` and `eval/harness-provider/timestamp-manifests/beam-10m.json`. No BEAM 10M question, rubric, gold answer or document text was viewed, printed or committed. No BEAM 10M cell was planned, ingested or answered. The power inputs never read the comparator's committed BEAM 10M rows, which ship inside the pinned harness checkout. The two scans no longer list BEAM 10M.

## LongMemEval-M dropped from ledger line 8 (October 6, 2026)

The harness pin does not load LongMemEval-M. Line 8 keeps only the extra frontier points on sealed BEAM.
