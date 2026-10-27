# The proactive brief on Cat 40 family P: development phase v2 (wave 5 D6 redesign)

The proactive brief did not save the preregistered amount of agent work, so the label is **no time-saved signal
(development evidence only)**. With the brief on, agents made 6% fewer session-2 tool calls (ratio 0.940, 95%
interval 0.856 to 1.032), short of the required 20% with an upper bound below 1. Session-2 input tokens fell 8%
(ratio 0.918, upper bound 0.971). Success did not suffer: both arms finished 72 of 72 paired tasks, so non-inferiority
at −5 points holds. Every other check holds as well.

- The hot-memory control held: hot memory carried no needed fact in any of the 144 cells.
- The brief fired in 72 of 72 brief-on cells, including all 10 whose session 1 saved only by editing pages.
- The brief was silent in 72 of 72 brief-off cells.
- There were no false pushes and no confident-wrong cells.

This is development evidence only. It does not decide whether the brief ships on by default.

The rules were frozen in the [preregistration](2026-10-15-proactive-brief-dev-v2-preregistration.md) at commit
`3952fb33`. That commit pinned gbrain v0.60.247.0 (`47f052af`, tag `v0.60.247.0`, gbrain #6751, the brief's page-edit
source) before any paid cell. This design is a redesign after the [first development run](2026-10-14-proactive-brief-dev.md),
whose verdict stands. It was approved on October 15 before any v2 data existed. The primary moved to time saved with
non-inferiority on success, because the plan's exit allows "task success or user time saved". The approval came under
the standing rule.

The run had six new personas (seeds 20261211 and 20261213 to 20261217). Each persona's first reply and first prep task
were aged, and its other two tasks were crowded:

- **Aged:** session 1's facts were backdated 72 hours, to October 12. The run happened on October 15, earlier than the
  world's session-1 day plus 72 hours, so the 72-hour floor applied.
- **Crowded:** 40 newer, unrelated facts were saved after session 1. All 40 were saved in every crowded cell.

Opus 5.5, Sonnet 5.5 and gpt-6.1-sol each ran every task once per arm. That makes 144 cells, all scored, with no harness
errors. The run directory is [`2026-10-15-proactive-brief-dev-v2/development/`](2026-10-15-proactive-brief-dev-v2/development/),
and `brief-summary.json` there holds every number below (`summarizeBriefV2` in `eval/runner/t0/brief.ts`).

## Decision rule

| Check | Result | Passes |
|---|---|---|
| 1. Time saved: pooled session-2 tool-call ratio ≤ 0.80 with 95% upper bound < 1, and input-token ratio upper bound < 1 | tool calls 437 vs 465, ratio 0.940 (0.856 to 1.032); tokens ratio 0.918 (0.868 to 0.971) | no |
| 2. Success non-inferior: pooled paired difference, 95% lower bound ≥ −5 points | 72/72 vs 72/72, difference 0 (0 to 0) | yes |
| 3. Hot-memory control: at most 10% of cells per condition carry a needed fact in hot memory | aged 0 of 72, crowded 0 of 72 | yes |
| 4. Paid-arm guard: no brief in brief-off; at most 10% misses among brief-on cells whose session 1 saved something | 72 of 72 brief-off silent; 0 misses in 72 | yes |
| 5. Attention: every brief block ≤ 1,800 characters | 955 at most, 419 on average | yes |
| 6. False pushes ≤ 0.05 per brief-on session | 0 of 76 items | yes |
| 7. No rise in confident-wrong cells | 0 in each arm | yes |

All three readers are at the ceiling on success: 24 of 24 in both arms. So success could only show harm, and it
showed none.

## Primary part 1: time saved

| Slice | Session-2 tool calls, off → on | Tool-call ratio (95% interval) | Input-token ratio (95% interval) | Wall-time ratio |
|---|---|---|---|---|
| All three readers | 465 → 437 | 0.940 (0.856 to 1.032) | 0.918 (0.868 to 0.971) | 0.976 |
| Aged | 230 → 215 | 0.935 (0.841 to 1.039) | 0.891 (upper 0.978) | 0.986 |
| Crowded | 235 → 222 | 0.945 (0.822 to 1.086) | 0.944 (upper 0.998) | 0.967 |
| Opus 5.5 | 160 → 138 | 0.863 (0.764 to 0.975) | 0.914 (upper 1.046) | 0.956 |
| Sonnet 5.5 | 110 → 115 | 1.045 (0.921 to 1.186) | 0.902 (upper 0.966) | 0.998 |
| gpt-6.1-sol | 195 → 184 | 0.944 (0.868 to 1.026) | 0.951 (upper 0.995) | 0.982 |

Per task, that is 6.46 session-2 tool calls with the brief off and 6.07 with it on. Session-2 input tokens were 55,595
off and 51,053 on, and cells cost $0.208 off and $0.192 on. Opus 5.5 saved the most, at 14% fewer tool calls with an
interval that excludes no change. Sonnet 5.5 made slightly more calls with the brief on but used fewer tokens. No
slice reaches the preregistered 20%. Wall time is a diagnostic only, because it includes provider latency.

## Primary part 2: success

Both arms finished all 72 paired tasks (36 prep, 36 reply), with no discordant pair, so the difference is 0 with an
interval of 0 to 0. Complete deliverables (commitment, new date and corrected value all stated) were 71 with the brief
off and 68 with it on. Under the secondary scorer `t0-score-v2`, 9 cells fail, all `unsupported`: 6 with the brief
off and 3 with it on. These are the namesake disambiguations that v3 excuses.

## Save path and the page-edit source

| Session-1 save path | Cells (both arms) | Brief-on cells | Brief fired |
|---|---|---|---|
| `remember` | 122 (Opus 48, gpt-6.1-sol 48, Sonnet 26) | 62 | 62 (100%) |
| page edit only | 22 (all Sonnet) | 10 | 10 (100%) |
| nothing saved | 0 | 0 | n/a |

In v1 on v0.60.240.0, all 14 brief misses were Sonnet sessions that saved only by editing pages. On v0.60.247.0, every
page-only brief-on session got an edit item (`Ev…`) carrying the facts session 1 wrote into the page. Across the 72 brief-on sessions the
brief pushed 76 items: 62 fact items (`F…`) and 14 page-edit items (`Ev…`). They carried 139 needed facts, 64.4% of
the 216 the tasks needed. Every one of those 139 facts appears in the brief-on deliverable, and also in the paired
brief-off deliverable.

## The hot-memory control

Hot memory carried no needed fact in any of the 144 cells. In brief-off cells, session 2's injected context carried
3 of 216 needed facts (1.4%): one corrected value in each reader's cell for task p20261213-t4, outside hot memory. In
v1 it carried 78.2%. So in this run the brief was the only push channel for those facts, and readers still found
them by searching or opening pages in both arms, as the preregistration predicted.

## Smoke and hermetic slice on the pinned release

Before the paid cells, a free scripted smoke ran on v0.60.247.0 (`smoke/smoke-1.txt` to `smoke-4.txt`). It covered
one persona, its 4 tasks, both save paths and both arms, repeated 4 times:

- Hot memory carried no needed fact in 64 of 64 checks.
- The brief was silent in 32 of 32 brief-off checks.
- The brief fired in 31 of 32 brief-on checks: a fact item after `remember`, and an edit item carrying all three facts
  after a page edit.

The one miss was a page-edit check that fired in the other three repeats. gbrain drops a brief that misses its 300 ms
turn deadline (`TURN_BRIEF_CUTOFF_MS`), which is a likely cause on a busy machine, but this was not verified. The paid
run had no miss. The hermetic slice
of the runner on the same release (`hermetic/`) held the control in 8 of 8 cells. The brief fired in 4 of 4 brief-on
cells and was silent in 4 of 4 brief-off cells.

## What the result means

Once hot memory no longer carries the facts, the brief puts one or two of them in front of the agent. That saves some
work: about 8% of session-2 input tokens and 6% of tool calls, and 14% of tool calls for Opus. It costs nothing in
success, and it caused no false or stale pushes. The page-edit source closes v1's gap for page-only savers. The saving
is well below the preregistered 20%, so the design does not support going to the sealed phase on time saved. Readers
still open the contact's page, which holds every saved fact in both arms, so the brief replaces only part of their
search.

## Spend

The new ledger (cap $35) committed $29.60 over 8,804 paid requests. Ledger run:
`d6-proactive-brief-dev-v2-2026-10-15T15-45-02-043Z-6ee2ffec`, now closed. Cells cost $28.78: $28.58 for readers and
$0.20 for gbrain's internal calls. The rest is the persona builds and the reranker probes.

## Records

- `development/experiment.json`: build verification, seeds, arms and the preregistration attestation (`3952fb33`).
- `development/results.jsonl.gz`: one record per cell, with its condition, save path, hot-memory facts, setup record,
  brief block, item classes and both scores.
- `development/usage.jsonl.gz`, `development/receipt.json`, `development/brief-summary.json` and the ledger cost receipt.
- `hermetic/`: the scripted slice on the pinned release.
- `smoke/`: the four free smoke runs on the pinned release.

To rerun the analysis:
`bun eval/runner/t0/brief.ts <(gunzip -c docs/benchmarks/2026-10-15-proactive-brief-dev-v2/development/results.jsonl.gz)`.
