# Verdict: D5 brief Cat 40 re-smoke (Amendment 1, 2026-10-14)

Preregistration: [2026-10-14-d5-brief-smoke-preregistration.md](../../2026-10-14-d5-brief-smoke-preregistration.md)
(sha256 `434850c2…f384d`, commit `2fc29c11`), unchanged. Amendment:
[2026-10-14-d5-brief-smoke-amendment-1.md](../../2026-10-14-d5-brief-smoke-amendment-1.md) (sha256 `7c123429…6be3`,
commit `9fe26b5d`), pushed before any re-smoke spend. Every receipt names `evals_commit` `9fe26b5d`, and both N6
receipts attest the preregistration at `2fc29c11`.

**Verdict: passes.** R1, R2, M, L1, L2 and the exercised check all hold. The first run's verdict ("regresses, on L1
only", [VERDICT](../VERDICT.md)) stands as the record of that run.

## Builds

- `master`: gbrain `3961bf165cb212308dcccb1ae8a610041fcd06d6` (v0.60.232.0, Merge #6708, the
  `list_write_conflicts` scope fix).
- `d5`: gbrain `f127b1b5a028c3723d07e2358bef2dfb9960ce65` (v0.60.232.0, garrytan/gbrain#6703's head; it merges that
  master).

The arm, world (digest `79094a8a2cbb`), tasks, flags and models are as preregistered.

## Exercised

All three checks used callable `full`, advertised `starter`, 35 tools:

- **Before the amendment** (on worktrees of both commits): `--tools-json` differs only in `context_pack`'s
  `counterparty` and `intent`, and the listing probe shows them on `d5` and on neither on master
  ([listing-probe-pre-amendment.txt](listing-probe-pre-amendment.txt)).
- **In every cell:** each `served-tools.json` lists 35 tools. On the three `d5` runs, `context_pack` has both
  parameters; on the three master runs it has neither.
- **On the built slot builds:** the probe ran after the cells, not before cell 1 as the amendment says, and found the
  same ([listing-probe-slots.txt](listing-probe-slots.txt)).

## Cat 40: 60 cells

| Model | Build | Success | Tool calls (all 10) | Tool calls (9 without E01) | `context_pack` calls | Brief-parameter calls |
|---|---|---|---|---|---|---|
| claude-opus-5-5 | master | 10/10 | 52 | 41 | 0 | 0 |
| claude-opus-5-5 | d5 | 10/10 | 52 | 41 | 0 | 0 |
| claude-sonnet-5-5 | master | 10/10 | 56 | 43 | 0 | 0 |
| claude-sonnet-5-5 | d5 | 10/10 | 49 | 39 | 1 | 0 |
| gpt-6.1-sol | master | 9/10 | 51 | 43 | 12 | 0 |
| gpt-6.1-sol | d5 | 8/10 | 47 | 40 | 12 | 0 |

- **R1 holds.** Each model's `d5` success is at least its master success minus 1: Opus 10 vs 10, Sonnet 10 vs 10,
  Sol 8 vs 9. The totals are 28/30 on `d5` against 29/30 on master, so the limit of 28 is met exactly. Two Sol cells
  succeed on master and fail on `d5`:
  - **B01:** Sol answered Elodie Udeh from the 2026-03-11 handoff. It didn't find the 2026-05-07 account review that
    moved ownership to Arjun Lindqvist; the master cell found it.
  - **F01:** Sol answered Suki Fairbourne from the billing email and declined the saved correction to Selma Brandt.

  Sol F02 flipped the other way: it failed on master by declining the correction and succeeded on `d5` by accepting
  it. None of these cells passed a brief parameter, and Sol's `context_pack` calls carry only `entities` and
  `budget_tokens` on both builds. The flips are Sol's search depth and its trust in an agent-written correction, not
  the new text.
- **R2 holds.** `d5` tool calls on the nine tasks without E01 stay under the limit for every model, at or below
  master:
  - Opus: 41 calls, limit 53.25.
  - Sonnet: 39 calls, limit 55.75.
  - Sol: 40 calls, limit 55.75.
- **M holds.** No cell passed `counterparty` or `intent`, E01 included.
- **L2 holds.** `d5` has 0 output leaks and 0 unsafe writes; master has 0 of each too.
- **Ceilings.** Opus is 10/10 on both builds and Sonnet is 10/10 on both builds.

[score.py](score.py) (unchanged from the first run) rebuilds [measures.json](measures.json).

## N6 visibility fuzz (hermetic, $0)

| | master | d5 |
|---|---|---|
| Read ops fuzzed, with signal | 78, 32 | 78, 32 |
| Probes exposed | 10,776 | 10,884 |
| `context_pack` probes | 378, 0 leaks | 540, 0 leaks (includes the `counterparty` variant that reaches the pulled brief) |
| `list_write_conflicts` | 18 probes, 0 leaks | 18 probes, 0 leaks |
| Content leaks | 0 | 0 |
| Existence leaks | 0 | 0 |
| Oracles | 0 | 0 |
| Gate bypasses | 0 | 0 |
| Presence | ok | ok |
| Receipt verdict | pass | pass |

**L1 holds:** 0 findings on `d5` and 0 on master. #6708 cleared the 4 `list_write_conflicts` existence findings the
first run counted on both builds.

## Spend

Ledger `.budget/d5-brief-resmoke.sqlite`, new, program cap $10: **$6.78** committed and reconciled, 435 requests,
$0 overshoot. No pair was skipped.

| Run | Ledger run id | Cost |
|---|---|---|
| Slot build, master | `cat40-slot-build-2026-10-14T23-52-07-879Z-3745c0d0` | $0.21 |
| Slot build, d5 | `cat40-slot-build-2026-10-15T00-01-30-460Z-f215693f` | $0.21 |
| Sol master | `cat40-model-ladder-2026-10-15T00-09-44-438Z-259d38e7` | $0.53 |
| Sol d5 | `…00-12-35-221Z-f3d3f801` | $0.40 |
| Sonnet master | `…00-15-35-591Z-acbe9379` | $1.03 |
| Sonnet d5 | `…00-17-33-766Z-1d6a7d3e` | $0.93 |
| Opus master | `…00-19-31-035Z-d4d1b608` | $1.76 |
| Opus d5 | `…00-22-48-470Z-c66012bd` | $1.72 |

## Files

The Cat 40 runner wrote these files already scrubbed (`gbrain@<sha>`, `<slots>/…`, repo-relative), with no hand edits.

## What this does not show

These limits are the same as the first run's:

- No Cat 40 cell could get a non-empty brief.
- The push path is not exercised.
- The brief's open-loop arm is not exercised.
- A starter-callable install sees neither parameter.
