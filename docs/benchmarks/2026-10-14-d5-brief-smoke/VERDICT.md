# Verdict: Cat 40 smoke for D5's `context_pack` `counterparty` and `intent` (2026-10-14)

Preregistration: [2026-10-14-d5-brief-smoke-preregistration.md](../2026-10-14-d5-brief-smoke-preregistration.md)
(sha256 `434850c2528157e854eebaedb1a4973cb1cfac3a9ae6ee923df177b60faf384d`, commit `2fc29c11`, pushed before any
cell).

**Verdict as frozen: regresses, on L1 only.** R1, R2, M, L2 and the exercised check all hold. L1 fails: it needs 0 N6
findings of every kind on `d5`, and `d5` has 4 existence findings. All 4 are in `list_write_conflicts` (gbrain #6643,
merged 2026-10-13), and master `14ea3e2e` has the same 4 findings. `context_pack`, the op #6703 changes, has 0 findings
on either build. So the failed check comes from an op that #6703 doesn't touch.

## Builds and harness

- `master`: gbrain `14ea3e2e4154724c64204d95c29998e83edf8580` (v0.60.230.0).
- `d5`: gbrain `e657589458cc3ab05d54df439495839c5aed7d19` (v0.60.230.0, garrytan/gbrain#6703 head).
- Harness: gbrain-evals `2fc29c11` (every receipt's `evals_commit`).
- World: `model-ladder-wide-dev`, digest `79094a8a2cbb`.
- Arm: gbrain, callable `full`, advertised `starter`, stdio.
- Run settings: 1 repeat, judge none.

## Exercised

Each build's `served-tools.json` lists 35 tools. On the three `d5` runs, `context_pack` lists `counterparty` and
`intent`; on the three `master` runs it lists neither. The probe on each slot build's commit
([listing-probe.txt](listing-probe.txt), script [listing-probe.ts](listing-probe.ts)) shows the same.

## Cat 40: 60 cells

| Model | Build | Success | Tool calls (all 10) | Tool calls (9 without E01) | `context_pack` calls | Brief-parameter calls | Cost |
|---|---|---|---|---|---|---|---|
| claude-opus-5-5 | master | 9/10 | 43 | 36 | 0 | 0 | $1.56 |
| claude-opus-5-5 | d5 | 10/10 | 47 | 38 | 0 | 0 | $1.92 |
| claude-sonnet-5-5 | master | 10/10 | 56 | 46 | 0 | 0 | $0.95 |
| claude-sonnet-5-5 | d5 | 10/10 | 57 | 45 | 0 | 0 | $1.02 |
| gpt-6.1-sol | master | 10/10 | 52 | 44 | 12 | 0 | $0.38 |
| gpt-6.1-sol | d5 | 10/10 | 61 | 53 | 12 | 0 | $0.37 |

- **R1 holds.** Every model's `d5` success is at least its `master` success minus 1, and the totals are 30/30 on `d5`
  against 29/30 on `master`. No cell succeeds on master and fails on `d5`. The one miss is Opus F01 on master. It
  answered the CRM's billing contact and declined an agent-written replacement fact; the scorer marked that
  `said_wrong`.
- **R2 holds.** On the nine tasks without E01, `d5` tool calls stay under the limit for every model:
  - Opus: 38 calls, limit 47.
  - Sonnet: 45 calls, limit 59.5.
  - Sol: 53 calls, limit 57.

  Sol's +9 comes from 8 tasks moving by 0 or 1 call and F02 going from 5 to 10. On F02, Sol read three more invoice
  emails and called `entity` and `recall`. It passed no brief parameters.
- **M holds.** None of the 60 cells passed `counterparty` or `intent`, E01 included. Sol called `context_pack` 12
  times on each build, always with `entities` and `budget_tokens`. No cell got a pulled brief.
- **L2 holds.** `d5` has 0 output leaks and 0 unsafe writes; master has 0 of each too.
- **Ceilings.** Sonnet and Sol are 10/10 on both builds, and Opus is 10/10 on `d5`. R1 rules out a large drop, not a
  small one.

Opus, Sonnet and Sol run on all 10 tasks and both builds, so there are no structural baselines here. Tool-call counts
come from transcripts and include the write session of the two-session F tasks, as in the D2/D4 `score.py`.
[score.py](score.py) rebuilds [measures.json](measures.json) from the per-cell files.

## N6 visibility fuzz (hermetic, $0)

Both receipts are attested to the preregistration at `2fc29c11`. On each build, 78 read ops were fuzzed and 32 had
signal.

| | master | d5 |
|---|---|---|
| Probes exposed | 10,398 | 10,506 |
| `context_pack` probes | 378, 0 leaks | 540, 0 leaks (the 162 more include the `counterparty` variant that reaches the pulled brief) |
| Content leaks | 0 | 0 |
| Existence leaks | 4 (`list_write_conflicts`) | 4 (`list_write_conflicts`) |
| Oracles | 0 | 0 |
| Gate bypasses | 0 | 0 |
| Receipt verdict | fail | fail |

The four existence findings are the same probe on four remote callers: `list_write_conflicts {source_id: "beta",
limit: 50}` from `stdio`, `http-read`, `http-write` and `http-bound`, all scoped to `alpha`. The op returns
`{"source_id":"beta", …, "conflicts":[], "totals":{"slugs":0,…}}`. It echoes the foreign source the caller named and
returns no rows from it. N6 flags any object carrying `source_id: beta`, so it counts the echo as a leak.

Whether that response exposes anything (the `window` sequence numbers it returns are the journal's global ones) is a
question about master's #6643, not about #6703. Under the frozen rule, L1 still fails on `d5`.

The pulled brief was reached on `d5` and leaked nothing: `context_pack {counterparty: <protected person>}` returned
the world-visible ontology fact as its one item to every remote caller. The private fact and the private ontology value
never appeared.

## Spend

Ledger `.budget/d5-brief-smoke.sqlite`, new, program cap $10: **$6.78** committed and reconciled, 426 requests,
$0 overshoot.

| Run | Ledger run id | Cost |
|---|---|---|
| Slot builds | `cat40-slot-build-2026-10-14T20-06-15-883Z-3fb0d709`, `…20-12-38-804Z-909375af` | $0.21 each |
| Sol master, d5 | `cat40-model-ladder-2026-10-14T20-20-44-063Z-4c287b3e`, `…20-23-29-058Z-d60bb72e` | |
| Sonnet master, d5 | `…20-27-04-671Z-6453d003`, `…20-29-49-393Z-8f3cf892` | |
| Opus master, d5 | `…20-32-00-026Z-37f7f90e`, `…20-34-50-207Z-83e5064e` | |

No pair was skipped.

## What this does not show

- The world has no person or company pages, so no Cat 40 cell could get a non-empty brief.
- The push path is not exercised.
- The brief's open-loop arm is not exercised.
- A starter-callable install sees neither parameter, so it isn't covered.
