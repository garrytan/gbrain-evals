# Cat 40 next wave: development round 3 (`all-on-no-f5`), results

Diagnostic, in-sample (World M), one round. The comparisons were fixed in `DECLARATION.md` (2d764342) before any
cell ran; this README reports exactly those and nothing chosen after looking. `analyze_r3.py` produced every number
below from `all-on-no-f5/attempts.jsonl` and the pooled round 1+2 cells; its output is `r3-analysis.json`.

**Verdict.** The confirmation configuration (all-on keys, F5 removed) is indistinguishable from the pooled control and
**clearly worse than pooled all-on** under the declared rule: success −5.3 pp [−9.5, −1.3] and wrong values +4.8 pp
[+1.5, +8.5], both intervals excluding 0. Almost all of the gap is H4. Per the owner decision, the confirmation's wave
arm stays all-on without F5; the preregistration records this as a known limitation.

## What ran

- **Build.** gbrain `capy/cat40-next-part1` @ `a3384b989a85f1f5fbb582c596e47af798a6157d` (v0.60.189.0), the Part 1
  head with F5's commits removed. It descends from the round 1–2 build `a798de1f` (3 commits). `git diff --stat
  a798de1f a3384b989 -- src`: 23 files, +21/−1,829, every path F5's (`src/core/mentions/owner-phrase/*`, the v243
  owner-phrase migration and its generated registry/schema stamps, the owner-phrase hooks in `mentions/pass.ts`,
  `ops/backlinks-paged.ts`, `link-ranking-policy.ts`, `verbs/entity-card.ts`, `config.ts`, the deletion and graduation
  inventories). `src/schema.sql` is byte-identical to the baseline `09d21554d`. The head and diff were recorded in the
  preregistration (31c73953) before cells; this README was written after cells.
- **Arm.** `all-on-no-f5`: the all-on restore-time keys from `dev-arms.ts --round 3`, no build config, full family,
  World M, models `claude-opus-5-5`, `claude-sonnet-5-5`, `gpt-6.1-sol`, judge `gpt-6.1-sol`. Concurrency, flags and
  order as in rounds 1 and 2. Harness `evals_commit` 2d764342, clean.
- **Slots.** A fresh F5-off family of 10 slots on a3384b989, `--no-pglite-analyze`, under its own `--gbrain-root`.
  Receipts are in `slots/`. Every write/restore/rerank probe passed and 0 owner-phrase links exist in any slot.
  `build-off-7_8_9` exited 1 after writing a complete receipt; the only error was one transient `ECONNRESET` on a
  slot 7 embedding request, which was retried. Those slots were accepted (`slots/build-off-7_8_9/OVERRIDE.txt`). An
  earlier build attempt aborted before building because the synced checkout was not a git repository; it reserved $4.

## Crash and resume

The first run (`cat40-model-ladder-2026-10-13T17-27-42-075Z-e349245f`) stopped after 194 cells: an H5 cell asked the
gbrain slot for its write-tool list after the pool had handed the slot on, and a slot restart cleared the client
("gbrain slot not started"), which crashed the run. The fix is 3cb5aaaf on this branch (with a forced-probe test). The
run was resumed under a new budget run (`cat40-model-ladder-2026-10-13T18-06-13-246Z-f41f415a`, `--budget-usd 126.21`,
the remaining cap) for the 106 cells left, still on harness 2d764342; it completed without a repeat. Both receipts are
in `all-on-no-f5/`. Final state: 300 canonical cells, 300 attempts, 0 harness errors.

## Results

Δ is arm minus reference in pp; each reference cell is the mean of its round 1 and round 2 results. 95% intervals are
task-resampled percentile bootstraps (4,000, seed 11).

### Against pooled control

| | n | success Δ | wrong values Δ | not submitted Δ |
|---|---:|---:|---:|---:|
| all | 300 | −0.5 [−3.8, +2.8] | +0.3 [−2.5, +3.2] | −0.3 [−2.2, +1.5] |
| H1 | 60 | +2.5 [−4.2, +10.0] | 0.0 | −5.0 [−13.3, +2.5] |
| H2 | 60 | −0.8 [−10.0, +7.5] | −1.7 [−10.0, +6.7] | +2.5 [0.0, +6.7] |
| H3 | 60 | 0.0 [−5.0, +4.2] | −0.8 [−4.2, +2.5] | +0.8 [−2.5, +5.0] |
| H4 | 60 | −4.2 [−15.8, +7.5] | +4.2 [−7.5, +15.8] | 0.0 |
| H4 +long | 48 | −5.2 [−18.8, +8.3] | +5.2 [−8.3, +18.8] | 0.0 |
| H4 not long | 12 | 0.0 | 0.0 | 0.0 |
| H5 | 60 | 0.0 | 0.0 | 0.0 |
| claude-opus-5-5 | 100 | +1.0 [−4.0, +6.0] | −1.5 [−5.0, +2.0] | −1.0 [−5.0, +3.0] |
| claude-sonnet-5-5 | 100 | +2.0 [−5.0, +8.5] | 0.0 [−6.0, +6.0] | −1.0 [−3.5, +1.5] |
| gpt-6.1-sol | 100 | −4.5 [−9.5, 0.0] | +2.5 [−0.5, +6.0] | +1.0 [−1.0, +3.5] |

Counts: success 236 vs 237.5, wrong values 22 vs 21.0.

### Against pooled all-on (F5 on)

| | n | success Δ | wrong values Δ | not submitted Δ |
|---|---:|---:|---:|---:|
| all | 300 | **−5.3 [−9.5, −1.3]** | **+4.8 [+1.5, +8.5]** | −0.3 [−3.0, +2.0] |
| H1 | 60 | +0.8 [−9.2, +10.8] | 0.0 | −5.0 [−17.5, +5.0] |
| H2 | 60 | −6.7 [−15.8, +1.7] | +3.3 [−5.0, +13.3] | +3.3 [0.0, +8.3] |
| H3 | 60 | −1.7 [−7.5, +2.5] | +1.7 [0.0, +5.0] | 0.0 [−3.3, +4.2] |
| H4 | 60 | **−20.0 [−33.3, −8.3]** | **+20.0 [+8.3, +33.3]** | 0.0 |
| H4 +long | 48 | −22.9 [−37.5, −8.3] | +22.9 [+8.3, +37.5] | 0.0 |
| H4 not long | 12 | −8.3 [−25.0, 0.0] | +8.3 [0.0, +25.0] | 0.0 |
| H5 | 60 | +0.8 [0.0, +2.5] | −0.8 [−2.5, 0.0] | 0.0 |
| claude-opus-5-5 | 100 | −3.0 [−8.0, +2.0] | +3.0 [0.0, +6.0] | −0.5 [−5.0, +4.0] |
| claude-sonnet-5-5 | 100 | **−10.5 [−18.0, −4.0]** | **+10.5 [+4.0, +17.5]** | +1.0 [−1.5, +4.0] |
| gpt-6.1-sol | 100 | −2.5 [−8.0, +2.5] | +1.0 [−3.0, +5.5] | −1.5 [−5.0, +1.0] |

Counts: success 236 vs 252.0, wrong values 22 vs 7.5; H4 success 48 vs 60.0 and wrong values 12 vs 0.0.

**Declared rule:** "clearly worse than all-on" holds (the overall success interval is wholly below 0 and the overall
wrong-values interval wholly above 0).

Ceilings: H5 is at 60/60 under this arm and both references, and H3 is near it, so neither can show a difference.
Sonnet is the model that carries the loss; Opus and GPT-6.1 Sol move in the same direction without excluding 0.

### Draft-first (settled definition, `draft_first.py`)

Firing: 230 names rows with records, 68 with a draft, 58 draft-first; 30 cells were served a draft-first row, all on
draft-led tasks. Harm on the 15 draft-led tasks (45 cells):

| reference | wrong values Δ | success Δ |
|---|---:|---:|
| pooled control, all 45 cells | +8.9 [−3.3, +21.1] | −8.9 [−21.1, +3.3] |
| pooled control, 30 served cells | +3.3 [−10.0, +16.7] | −3.3 [−16.7, +10.0] |
| pooled all-on, all 45 cells | +22.2 [+8.9, +40.0] | −22.2 [−40.0, −8.9] |
| pooled all-on, 30 served cells | +23.3 [+6.7, +43.3] | −23.3 [−43.3, −6.7] |

Against control the draft-led tasks show no detectable harm; against all-on they carry the H4 loss.

## Firing counters (`firing.ts`, `all-on-no-f5/firing.json`)

| | r1 all-on | r2 all-on | r3 all-on-no-f5 |
|---|---:|---:|---:|
| cells | 300 | 300 | 300 |
| names rows | 3,160 | 3,263 | 3,350 |
| names rows with records | 2,589 | 2,673 | 2,024 |
| record rows | 2,920 | 2,934 | 2,333 |
| delivered units (section / chunk / page) | 150 / 245 / 1 | 140 / 173 / 0 | 197 / 264 / 3 |
| page_status rows | 0 | 0 | 0 |
| known_as rows | 87 | 70 | 0 |
| owner-phrase referrer rows | 3,968 | 4,052 | none (feature absent) |
| names-call p50 / p99 (ms) | 349 / 2,154 | 357 / 2,201 | 247 / 1,312 |
| served instructions sha256 | 3bb1d6aafd23… | 3bb1d6aafd23… | 3bb1d6aafd23… |

The served instructions are identical. The differences are F5's: known_as and owner-phrase rows go to 0, the share of
names rows carrying records falls from about 82% to 60%, and the names call gets about 110 ms faster at p50.

## Spend

| item | committed |
|---|---:|
| aborted build attempt (reservation) | $4.00 |
| slot builds (3 runs) | $27.37 |
| arm, run 1 (194 cells) | $101.98 |
| arm, run 2 (106 cells) | $53.85 |
| **round 3 total** | **$187.20** (cap $228.19) |

Agent plus judge cost recorded on the 300 attempts is $148.52; the ledger's arm total is $155.83. I did not trace the
$7.31 difference; the ledger figure is the one the caps bind on. Development program committed after round 3: $1,518.50 of $1,777.15
(`ledger-program.json`, `ledger-runs.json`).

## Files

- `DECLARATION.md`: comparisons fixed before cells.
- `analyze_r3.py`, `r3-analysis.json`: the declared analysis and its output.
- `all-on-no-f5/`: experiment, both receipts, results, attempts, served instructions and tools, firing counters,
  transcripts (gzipped).
- `slots/`: the three F5-off slot build receipts and the 7–9 override note.
