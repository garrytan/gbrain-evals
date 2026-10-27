# Cat 40 Hard fix wave: confirmation results

Written 2026-10-11, after every counted cell of the confirmation in [PREREG.md](PREREG.md) finished. PREREG.md is unchanged; this file reports what it preregistered, in its wording. Development results ([DEV-RECORD.md](DEV-RECORD.md)) are not pooled with these. The published report is gbrain-evals #76, `docs/benchmarks/2026-10-10-model-ladder-hard-confirmation.md`.

## Verdict

gbrain is **ahead** of plain files in both confirmation worlds, so the co-primary endpoint (UC2) passes, the kill criterion does not fire, and the general reliability claim the preregistration allows ("both worlds pass") is allowed.

| World | Δ_W (gbrain − fs, pooled over three models) | 95% interval | Preregistered wording |
|---|---|---|---|
| M (main generator, seed 20261021) | **+7.7 points** | [+2.7, +12.7] | ahead (lower bound above 0) |
| S (sealed generator, private seed) | **+13.0 points** | [+7.7, +18.3] | ahead (lower bound above 0) |

Δ_W is the mean over models of each model's gbrain rate minus its fs rate on the same 100 tasks; the interval is a task-clustered bootstrap (10,000 resamples of tasks, seed 1, all three models resampled together), as preregistered. Each world has 600 counted cells (3 models × 2 arms × 100 tasks, repeat 1), every cell has exactly one recorded attempt and it is harness-clean (the 10 cells in flight when M's first run stopped at its budget left no record and ran once in the resume), and every slot and cell record carries gbrain `3e4ff61ce1ac553581fb5c1eb905cf48541fe344`. An independent recomputation from the `results.jsonl` copies gave the same Δ_M and Δ_S and intervals, with 0 duplicate keys and 0 missing cells.

**Shipped build (2026-10-11).** The confirmed build `3e4ff61ce` is gbrain #6271's branch; #6271 has since merged as gbrain v0.60.174.0 (master `0df9f2ee7`). The shipped build derives identical aliases, mention links and card identity lines to `3e4ff61ce` on M, S, the calibration world and the v1 world ([DEV-RECORD.md](DEV-RECORD.md), alias precision check), so the result applies to it.

The claim this supports: on these two 50k-document worlds, with a 16-turn cap and starter-surface tools, agents using gbrain finished more hard company questions correctly than the same agents with plain files, for every model tested. It does not say the gap is the same size on other corpora or turn budgets; see the weaknesses below.

## Per model

Successes out of 100 tasks.

| Model | M gbrain | M fs | M Δ | S gbrain | S fs | S Δ |
|---|---|---|---|---|---|---|
| Claude Sonnet 5.5 | 69 | 60 | +9 | 47 | 41 | +6 |
| Claude Opus 5.5 | 79 | 73 | +6 | 70 | 51 | +19 |
| GPT-6.1 Sol | 88 | 80 | +8 | 81 | 67 | +14 |
| pooled | 236/300 (79%) | 213/300 (71%) | +7.7 | 198/300 (66%) | 159/300 (53%) | +13.0 |

No model is at a ceiling on either arm in either world, so every model can show a difference.

## Per family

Successes out of 60 (20 tasks × 3 models).

| Family | M gbrain | M fs | S gbrain | S fs |
|---|---|---|---|---|
| H1 | 18 | 11 | 4 | 0 |
| H2 | 54 | 46 | 46 | 38 |
| H3 | 57 | 48 | 37 | 12 |
| H4 | **47** | **56** | 52 | 49 |
| H5 | 60 | 52 | 59 | 60 |

## Weaknesses

- **M's H4 has gbrain behind fs, 47 vs 56 of 60** (−15 points pooled). It is the only family where gbrain trails by more than one task in either world. In S, H4 is 52 vs 49.
- **S's H1 is at the floor on both arms**: 4 of 60 with gbrain and 0 of 60 with fs, although the oracle answered all 60 H1 cells correctly. The H1 tasks are answerable from their evidence, but neither arm finds the full member set within 16 turns (53 of 60 gbrain H1 cells and 47 of 60 fs H1 cells hit the turn cap; 12 fs H1 cells overflowed the context). S's H1 result says almost nothing about either arm.
- **fs suffers more from corpus size at the fixed 16-turn cap.** On S, fs had 22 context overflows (Sonnet 8, Opus 14) and one provider 413 "request too large", against 0 for gbrain, and 116 turn-cap stops against 80. The S corpus is about 21% larger than M's. Part of gbrain's larger lead on S comes from fs running out of turns or context rather than from fs reading the wrong documents; a larger turn cap would probably narrow the gap. The preregistration fixed the cap at 16 for both arms.
- **gbrain gives more wrong answers.** It submits more often and is more often confidently wrong: 22 of 300 cells on M (fs 14) and 16 of 300 on S (fs 2). Most of these are Sonnet (15 on M, 13 on S). fs fails mostly by not answering in time.
- **Sonnet's gain is the smallest** (+9 on M, +6 on S), and Sonnet hits gbrain's turn cap 40 times on S. Per model, only Sol (both worlds) and Opus (S) have intervals above 0 on their own: Sonnet [−2, +20] on M and [−4, +16] on S, Opus [−2, +15] on M (`holdout_stats.py --hard-headline`); the pooled Δ is the preregistered endpoint.

## Secondary measures

Computed from the copied records with [`confirm_secondary.py`](confirm_secondary.py) (stops, wrong answers, seconds, rerank, DX) and `eval/runner/cat40/analyze.ts` (cost per success). Both print counts only.

### Stops and wrong answers

A wrong answer is a cell whose submitted answer asserts a wrong value (`score.said_wrong`); the denominator is all 100 cells.

| World | Model | Arm | wrong answers | turn_cap | context_overflow | provider error |
|---|---|---|---|---|---|---|
| M | Sonnet 5.5 | gbrain | 15 | 14 | 0 | 0 |
| M | Sonnet 5.5 | fs | 7 | 32 | 0 | 0 |
| M | Opus 5.5 | gbrain | 7 | 11 | 0 | 0 |
| M | Opus 5.5 | fs | 1 | 21 | 4 | 0 |
| M | Sol | gbrain | 0 | 7 | 0 | 0 |
| M | Sol | fs | 6 | 13 | 0 | 0 |
| S | Sonnet 5.5 | gbrain | 13 | 40 | 0 | 0 |
| S | Sonnet 5.5 | fs | 2 | 48 | 8 | 1 (413) |
| S | Opus 5.5 | gbrain | 3 | 27 | 0 | 0 |
| S | Opus 5.5 | fs | 0 | 35 | 14 | 0 |
| S | Sol | gbrain | 0 | 13 | 0 | 0 |
| S | Sol | fs | 0 | 33 | 0 | 0 |

Totals: M gbrain 22 wrong, 32 turn-cap; M fs 14 wrong, 66 turn-cap, 4 overflow. S gbrain 16 wrong, 80 turn-cap; S fs 2 wrong, 116 turn-cap, 22 overflow, 1 error.

### Cost per successful task and seconds per cell

Cost is agent, embedding and gbrain provider dollars over every attempt (judge excluded), divided by successful cells. Seconds are medians per cell: agent time (slot restore excluded) and wall time (restore and judge included).

| World | Model | gbrain $/success | fs $/success | gbrain agent p50 s | fs agent p50 s | gbrain wall p50 s | fs wall p50 s |
|---|---|---|---|---|---|---|---|
| M | Sonnet 5.5 | $0.85 | $1.71 | 63.7 | 56.5 | 81.5 | 63.0 |
| M | Opus 5.5 | $1.10 | $2.40 | 68.0 | 72.7 | 87.6 | 80.3 |
| M | Sol | $0.32 | $0.24 | 36.9 | 35.3 | 49.5 | 39.3 |
| S | Sonnet 5.5 | $1.41 | $2.22 | 70.2 | 52.9 | 99.2 | 55.2 |
| S | Opus 5.5 | $1.58 | $3.05 | 84.7 | 79.3 | 110.0 | 83.9 |
| S | Sol | $0.46 | $0.32 | 42.9 | 52.9 | 78.6 | 54.9 |

Pooled: M gbrain $0.74 vs fs $1.39 per success; S gbrain $1.08 vs fs $1.68. gbrain is cheaper per success for both Claude models and slightly dearer for Sol, whose fs runs are cheap. gbrain cells take longer end to end, partly from the 5 s slot restore (median 4.9–5.2 s) that fs cells do not have.

### Rerank check

Every gbrain cell that made a hybrid search (a `search` call not in keyword mode) shows `voyage:rerank-2.5` in its metering: 168 of 168 on M and 167 of 167 on S. Rerank degradation markers: 0 cells on M, 1 cell on S (one `degraded_recall` notice). Other notices on tool results were informational (`first_run_decisions`, `onboard_no_takes`, `empty_retrieval`, `listing_truncated`, `mention_index`, `alias_fanout`, `unknown_param`).

### DX measures

Per the plan: the share of account-cells (H2–H4, the first four accounts of each task) where the agent saw the account's nickname in a tool result and where it queried it, and the tool calls from the question to the first alias query (a tool argument containing a nickname or account code of a task account; H2–H4 cells).

| World | Arm | nickname seen | nickname queried | account-cells | cells with an alias query | tool calls to first alias query (median, p75) |
|---|---|---|---|---|---|---|
| M | gbrain | 100% | 93% | 624 | 180/180 | 4, 5 |
| M | fs | 99% | 98% | 624 | 180/180 | 5, 7 |
| S | gbrain | 82% | 69% | 651 | 180/180 | 2, 5 |
| S | fs | 77% | 73% | 651 | 176/180 | 3, 6 |

M's world was regenerated from its seed for this count (digest `6f08629e…` and file SHA-256 `99c53db0…`, equal to the recorded values). S's were computed on Garry's Mac, where the sealed world stays, with the same script; only these counts left it. With gbrain the agent reaches its first alias query about one call sooner than with fs in both worlds. On M both arms see nearly every nickname and fs queries it a little more often (98% vs 93%); on S the sealed wording hides nicknames from both arms more often, gbrain sees more of them (82% vs 77%) and fs queries a little more of those it sees (73% vs 69%).

## Gates and oracle

Every preregistered gate passed before counted cells in both worlds.

| Gate | M | S |
|---|---|---|
| 1. World validates; S digest equals the committed one | yes | yes (`61870796…`) |
| 2. Oracle pooled success ≥ 95% | 299/300 (99.7%): Opus 100, Sonnet 99, Sol 100 | 286/300 (95.3%): Opus 99, Sonnet 94, Sol 93 |
| 3. Write and rerank probes pass; 0 queued effects at snapshot | 5/5 slots, 0 queued effects each | 5/5 slots, 0 queued effects each |
| 4. Projection + 15% fits the ledger | yes (first run under the $650 cap, resume under $900) | yes (one run under $900) |

Oracle by family (of 60): M H1 60, H2 60, H3 59, H4 60, H5 60; S H1 60, H2 60, H3 55, H4 60, H5 51.

## Cost

| World | Step | Ledger $ | Note |
|---|---|---|---|
| M | slots (5 × $2.74) | 13.68 | |
| M | oracle | 26.70 | $24.96 in the cell records |
| M | counted cells | 531.95 | $419.27 (stopped at its $420 run budget after 464 cells) + $112.68 resume; includes $37.67 overstated (below) |
| M | **total** | **572.34** | cap $900 |
| S | oracle (first custody VM) | 25.77 | ledger lost with the VM; from the cell records |
| S | slot build lost with the first VM | ≤ 8.00 | two slot allowances |
| S | slot build, first attempt on the new VM | 4.00 | stopped at the $4 per-slot allowance; no snapshot |
| S | slots (5 × $4.18) | 20.88 | `slots-b`, $6 allowance |
| S | counted cells | 716.98 | one $835 run; includes $212.05 overstated (below) |
| S | **total** | **775.63** | cap $900 ($741.86 on the replacement ledger + $33.77 lost) |

Both worlds: $1,347.97 booked against the preregistered estimate of about $980. Without the overstatement below, about $1,098.

**The ledger overstates the counted steps.** A model request the provider rejects before generating (a 413 "request too large", or a prompt longer than the context window) settles at its whole reservation instead of the provider's reported usage. The ledger shows these as `charged-reservation` entries: on M, 6 Opus requests ($37.67); on S, 9 Sonnet requests ($152.12), 14 Opus requests ($59.92) and one rerank ($0.00). They match the fs context overflows and the 413. Rejected requests are normally not billed, so actual spend is probably about $250 lower than booked. Without them, the ledger's reconciled spend on the counted steps is $494.28 on M (the cell records hold $480.24; the rest is the 10 cells in flight when the first run stopped at its budget) and $504.93 on S (cell records $487.50). The harness fix lands in gbrain-evals #76.

## Deviations from the preregistration

Each was recorded under "Recorded before cells" in PREREG.md before the cells it affects ran.

1. **Custody VM lost** (2026-10-10, about 17:30 UTC). Another lane's VM cleanup destroyed `ubirun-gbra39-1791649874-6fc77e3a`, which held world S, its first ledger and a slot build in progress. The S oracle had already finished; its records survived in the copy made after that step. No counted cell had run.
2. **Replacement ledger.** A new `.budget/cat40-hard-confirm-sealed.sqlite` with the same name, cap and reason was opened on the new custody VM `ubirun-gbra39seal-1791657729-cdfa7ddf` (approved after the fact). The $33.77 lost with the first VM is counted against S's cap.
3. **Slot allowance $6 for S.** The first slot build on the new VM stopped at the $4 per-slot allowance (the S corpus is about 21% larger than M's). It was rerun with `--slot-build-allowance-usd 6`; no slot or arm setting changed.
4. **Caps raised to $900.** Garry Tan raised both confirmation caps from $650 to $900 ("Go ahead and raise the limit now"), because the preregistered projection underestimated fs cost per cell. Harness commit `f761757e74fd40b89ef90efca339e74e77c39555` changes only `CONFIRM_CAP_USD` to 900 (plus its test and the runbook note). Endpoints, arms, models, tasks and the decision rule did not change.
5. **Runner commits per step** (from the receipts; `evals_commit` is the checkout the step ran from):

| Step | M | S |
|---|---|---|
| world | `d0057206` | `d0057206` (Mac and custody VM) |
| oracle | `d0057206` | `d0057206` |
| slots | `d0057206` | `d0057206` (first attempt), `f761757e` (`slots-b`) |
| counted cells | `d0057206` (first 464 cells), `f761757e` (resume) | `f761757e` |

`d0057206` and `f761757e` differ only in the cap constant, so no step's behavior changed between them.

## Custody and hygiene

No agent read sealed task text, sealed documents or the sealed seed; sealed outputs were copied with the seed redacted, and this file reports sealed results as counts only. Both confirmation VMs were destroyed on 2026-10-11 after their results, transcripts, receipts, experiment records and ledgers were copied (no world documents). The sealed world and seed remain only on Garry's Mac.
