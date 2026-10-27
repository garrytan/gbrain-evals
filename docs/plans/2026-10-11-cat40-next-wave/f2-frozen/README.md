# F2 frozen-hit steps (free, no model calls)

Three steps decided F2's delivery unit. Each wrote its `DECISION-RULE.md` and hashed it (`DECISION-RULE.sha256`) before computing. World M (#93 confirmation cells, gbrain 3e4ff61c) was primary and the calibration world (r3, dev-r5 cells) was the check. Nothing derived from S is here. The replay outputs (`*.jsonl`, `frozen.json`, `calls_all.json`) and the scratch gbrain copy the scoped and budget steps ran against are not committed. `scoped/patch.diff` is the complete set of emulation hooks applied to that copy, and the scripts regenerate everything else from the cells and world files.

| step | question | outcome |
|---|---|---|
| [global](REPORT.md) | one global `return_unit` (chunk, window, section or page) at 6,000 tokens | none picked: section and page reach 50/82 long pairs and lose one short pair |
| [scoped](scoped/REPORT.md) | the plan's scoped policy (widen only long non-conversation hits) at 6,000, with a 50% share-cap guard | none picked: 50/82, and the cap drops it to 22/82 |
| [budget](budget/REPORT.md) | the budget recorded calls actually got, then the scoped policy on every recorded call at that budget, with a payload bar | the F2 path runs at 24,000 (`search.return_budget_conversation`). Section is picked (page ties): 78/82 long pairs, no short loss, +8.2% payload against a 25% bar; dev 34/35, +8.3% |
