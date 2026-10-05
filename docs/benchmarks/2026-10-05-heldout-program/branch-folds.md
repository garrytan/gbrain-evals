# Plan evaluation branches folded into main

Each plan's evaluation branch is folded into main by content, through gbrain-evals#71, which carried P0's harness branch `p0-heldout-harness`. The folded branches are deleted. `capy/p2-preregistration` stays open for P2's preregistration amendments until P2's records are published. "Ancestor" means the branch head is already in the history, so every commit on it is included. "Patch-identical" means the commit was rebased onto P0's branch under a new hash; `git patch-id` gives the same id for both, so the change is the same.

| Branch | Head | How it is folded | Commits |
|---|---|---|---|
| `p1-temporal-edges-dev` | `7323f2f` | Patch-identical. Recorded with a merge commit that changes no file. | `7323f2f` = `01d2831` (temporal-edges category, P1 dev split, phrasing set A) |
| `p1-temporal-edges-dev-a2` | `a257cab` | Ancestor, through P0 merge `5dbb27f` | `a257cab` (phrasing sets A2 and A3) and the P0 harness commits under it |
| `capy/p7-preregistration` | `75b8d74` | Patch-identical. Recorded with a merge commit that changes no file. | `76c722f` = `e69a626` (feature-arm search pins); `7560577` = `cd120c2` (preregistration, dev probes and outputs); `8771f76` = `af94f3c` (rebased build `5319b19b`); `75b8d74` = `69fafef` (build `94bd52e0`) |
| `capy/p2-preregistration` | `b9d9367` | Ancestor, last through P0 merge `e19a2d9` | `ea5d898` = `1fc746e` (preregistration), `81d535f` and `9dc8bdd` (Amendment 1), `64b48c3` (metric correction), `898de50`, `88ff314` and `b9d9367` (Amendment 2) |
| `capy/p2-facts-lane` | `3475930` | Patch-identical. Recorded with a merge commit that changes no file. | `f9fb315` = `ee8127d` (audit rows excluded); `c7cfbe8` = `54bc438` (partial extraction scored); `3475930` = `c172e7b` (stored `attributed_to`); earlier `4171288` and `b200b0f` are ancestors |
| `capy/p2-hub-world-arms` | `20ac5fd` | Ancestor, through P0 merge `cdb3311` | `162e1c5` (hub-heavy world generator and runner), `20ac5fd` (hub-world-arms runner) |
| `p3-e2-e4-feedback-evals` | `64776b7` | Ancestor, through P0 merge `c83f5f5` | `847ef5c` (feedback replay, dev and sealed splits), `64776b7` (E2 citation replay, E4 constrained-relational category) |
| `p8-dev-evals` | `519e3b4` | Ancestor, through P0 merge `1b98953` | `5fd62ee`, `d50017c`, `1a825d9`, `6d7204e`, `519e3b4` (advertised-surface arms, write cost, withdrawal review, quote grounding, dev receipts) |
| `capy/p4-streaming-harness` | `8cfae29` | Ancestor, last through P0 merge `5eb82f3` | `5d60a21` through `8cfae29` (streaming harness, BEAM support, power analysis, reply-cap reissue, BEAM-100K core-gate reservation) |

On 2026-10-05, after #71 merged, `git rev-list --count origin/main..origin/<branch>` was 0 for every branch above except `capy/p2-preregistration`, whose amendment 3 (`f95b1ff`) is held with P2's other records for their follow-up change.

## Changelog

- 2026-10-05: The nine branches are folded into main through gbrain-evals#71; eight are deleted.
