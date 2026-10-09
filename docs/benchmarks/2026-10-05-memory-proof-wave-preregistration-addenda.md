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

## Scorer revision on the sealed and validation cells (October 7, 2026)

The preregistration's table names the audited scorer by revision `7619a08c…`. That value was read from a comparator dev cell planned on a VM checkout that predated one harness fix (commit `793fce73`, October 5). The fix gives ids that need replacing a hash suffix in stage-file names, so two LifeBench users never share a file, and makes `read_record` check a record's owner. It changes `records.py`, which is part of the scorer revision. It does not change how anything is scored. Every sealed and validation cell, for both systems, ran the same revisions: scorer `a424debb…`, prompt `9c547715…` and wrapper `3cdc54a5…`.

## Retrieval-only replay for the pre-merge equivalence check (October 7, 2026)

Before #6066 merges, the gbrain sealed cells are replayed retrieval-only on the merged build at its shipped defaults. Wave 11's HNSW `iterative_scan` default changed from strict to relaxed order. The replay uses a copy of each cell's store (the stores stay untouched), and `harness:cell replay` writes the replayed contexts and a per-question diff to custody. Only questions whose context changed are re-answered (`mpw.reanswer --retrievals … --questions …`) and re-judged. The shipped-default score is then reported beside the sealed one, and it decides nothing.

Retrieval is not bit-for-bit repeatable even on one build and one store. A replay of a 20-question dev cell on the freeze build matched that build's earlier retrieval on 18 of 20 questions, the other two being near-tied pages in a different order. So the check also replays each cell on the freeze build, as a noise baseline, and reports changed-context counts for both builds.

## Temporal fact reserve: validation verdict (October 7, 2026)

**The reserve fails its preregistered win rule on validation, so the sealed primary gbrain arm runs with the reserve off.** That rule requires temporal reasoning and event ordering to improve (paired mean difference above 0) and the pooled score not to fall (paired mean difference at least 0). The confirmation ran the combined lane on the freeze build `d7467d1cf`, BEAM validation 100k + 500k + 1M (18 conversations, 360 questions), with date grounding at its default. All six cells passed every gate, and the verdict is recorded here before any sealed gbrain cell runs.

| Validation | Reserve off | Reserve on |
|---|---:|---:|
| 100k | 0.652 | 0.689 |
| 500k | 0.665 | 0.670 |
| 1M | 0.708 | 0.677 |
| Pooled | 0.679 | 0.677 |

Paired results, reserve on against off:

| Questions | Mean difference | Wins / losses / ties |
|---|---:|---|
| Temporal reasoning | +0.090 | 5 / 3 / 28 |
| Event ordering | +0.011 | 11 / 12 / 13 |
| Pooled | −0.002 | 35 / 49 / 276 |

The pooled clause fails. Contradiction resolution (−0.035, 3/9) and abstention (−0.056) fall the most.

One fact about the 1M pair, recorded without changing the verdict: its two cells did not share one extraction store. The reserve-on cell was planned after a repository merge changed `package.json`'s declared gbrain pin (`739e5cc` to `a865f8f`), which is part of the store identity. The loaded build was `d7467d1cf` for both cells, but the reserve-on cell ran its own fact extraction. At 100k and 500k both arms read one store. So the 1M difference includes extraction-to-extraction variation as well as the reserve. The rule is applied as preregistered.

The sealed gbrain cells run with `--reserve off`. Their identity records the declared pin `a865f8f` and the loaded head `d7467d1cf`; the loaded head is what runs.

## LoCoMo10 question date fixed before the matched cells (October 8, 2026)

**Every LoCoMo10 question was dated to its conversation's ninth session, not its last, so the wrapper now orders LoCoMo sessions by number before any matched LoCoMo10 cell runs.** The pinned harness's LoCoMo loader sorts session keys as strings, which puts `session_9` after `session_19`, and it takes the last parseable session date as the question's `query_timestamp`. All 10 LoCoMo10 conversations have 19 to 32 sessions, so all 1,540 scored questions were asked three to six months too early. The reader prompt shows this date to both systems. The comparator's recall request also carries it; gbrain's retrieval does not read the question date.

The fix, in `register.install()`, replaces the loader's session ordering with the numeric ordering the pinned LifeBench loader already uses. Each question is now dated to the latest session that has turns. One conversation (`conv-26`) carries date stamps for sessions 20 to 35 that hold no turns; those dates are not used. Both systems read queries through the same loader and projection, so they receive the same date. The test `test_locomo_query_date.py` pins a 12-session conversation to session 12's date. It fails without the fix (session 9's date) and passes with it.

No matched LoCoMo10 secondary cell had run when this was recorded, so no matched outcome had been seen. The dev-phase LoCoMo10 cells (322-question dev subset) ran with the wrong date. Their scores in the dev report stand as recorded, as development measurements under this defect, and are not comparable with the matched cells. The other loaders were checked: LongMemEval-S reads each item's own `question_date`; LifeBench already orders sessions by number; PersonaMem's date is a stated date that the wrapper withholds from both systems; and BEAM passes no question date.
