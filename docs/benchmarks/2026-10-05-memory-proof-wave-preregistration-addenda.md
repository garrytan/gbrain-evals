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

## The raw lane runs gbrain's conservative search mode (October 8, 2026)

**The raw secondary arm ran without gbrain's reranker, by gbrain's own mode default rather than by a failure.** gbrain picks a search mode when a brain is created. A brain with no chat-model key gets `conservative`, and the raw lane gives gbrain only its embedding key. The combined lane also holds the extraction model's key, so its brains get `tokenmax`. The config rows of all 108 sealed unit brains show this: 54 raw units are `conservative` and 54 combined units are `tokenmax`.

Both lanes set the token budget, the result limit and query expansion on every call, so those match. The mode still changes five retrieval settings that no call overrides:

| Setting | Raw lane (`conservative`) | Combined lane (`tokenmax`) |
|---|---|---|
| Cross-encoder reranker | off | on (`rerank-2.5`, top 50 in) |
| Graph signals | off | on |
| Relational retrieval and planner | off | on |
| Contextual retrieval | none | per-chunk synopsis |

The receipts agree. The raw cells sent 0 rerank requests at every size, and none of their 1,060 retrieved rows records a skipped or failed rerank. The combined cells reranked all 1,080 questions with HTTP 200. Every dev raw cell also sent 0 rerank requests, so the raw lane was tuned under the same settings.

So the raw arm measures gbrain pages-only with just an embedding key. It does not measure pages-only at the primary arm's search settings. The raw-against-combined gap mixes the facts block with this mode bundle. The arm stays as run, is reported as such, and decides nothing. No sealed cell is rerun. This was recorded before the joint re-judge finished and before any sealed raw analysis ran. The primary arm and the comparator are unaffected.

## Custody and receipts lost with the run machine (October 9, 2026)

**Every private and local file of this wave was lost on October 9, 2026, between 9:33 AM and 11:39 AM Pacific, when the cloud machine that held them was replaced.** Only what had been pushed to git survives. Lost:

- **Custody, never handed off.** The private grouping file, the access log, the validation and sealed id lists, the sealed specs, every validation and sealed cell receipt with its store, the joint re-judge outputs, the per-question analysis and cost rows, and the reranker receipt.
- **The budget ledgers.** `mpw-confirm-sealed`, `mpw-dev-local` and the sealed comparator VMs' ledgers.
- **The matched secondary cells then running or finished.** LongMemEval-S gbrain raw and comparator (finished), LongMemEval-S gbrain combined (part way, on a VM whose SSH key was on the lost disk; the VM was destroyed), and the three LoCoMo10 cells.

What was recorded before the loss stands. The sealed decision (`ahead`, +2.64 points, one-sided 95% bounds +0.90 and +4.41), every published aggregate and the nine sealed cell ids are in [the sealed results](2026-10-09-memory-proof-wave-sealed-results.md) (commit `f8444fe3`). The code that produced them is in `dee6d36c`, `f0aef0fe` and `33cba827`. The addenda above (`4116575f`, `3e5904dd`, `aa147f8c`) were also pushed before the loss.

Three things this preregistration promised are unrecoverable unless the salt or the private grouping file is found in the owner's custody. No copy exists on any Capy machine, including the custodian lane's two machines, which were checked by hash:

- the publication of the full sealed and validation receipts after scoring;
- the custody hand-off to the owner's machine;
- the Q1 export of frozen per-question contexts.

If the salt turns up, the split is deterministic and can be regenerated. Clusters are ordered per stratum by HMAC-SHA256(salt, "<stratum>/<cluster id>") over `inputs.json` (sha256 `1cbfed98…725d`) at harness commit `f618ed7b`, and the result is checked against the recorded file (2,018 bytes, sha256 `2229…0413`). Until then, the sealed and validation ids cannot be rebuilt, so the pre-merge equivalence check moves to the public dev conversations. It tests whether the two builds deliver the same contexts, which does not need sealed ids. The matched secondary cells are rerun from their pushed specs. Numbers from the lost runs are not published.

The BEAM 1M hold on per-question rows was released on October 9, once the parser-gap decision was recorded (gbrain-evals#88, `e31deacf`). Our 1M per-question rows were lost with custody, so nothing beyond the published aggregates can be released. BEAM 10M stays untouched, as before.

**Spend, reconstructed.** With the ledgers lost, spend is rebuilt from figures reported during the run. It is not read from a ledger.

| Part | Spend |
|---|---|
| Through the sealed primary | $936.97 |
| Lost matched cells | $94 to $219 (the upper end assumes every partial cell reached its cap) |
| **Wave total before the reruns** | **$1,031 to $1,156** |

The $936.97 is made of the dev phase ($649.35), the step-1 interaction check ($36.99), the harness lane ($4.16), `mpw-confirm-sealed` ($167.57) and the comparator VMs ($78.90). From here on, ledgers and public receipts are copied off the run machine after every cell.
