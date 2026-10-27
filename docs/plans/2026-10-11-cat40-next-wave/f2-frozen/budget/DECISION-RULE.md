# F2 scoped policy at the real per-call budget: decision rule (written and hashed before any F2 number)

Recorded 2026-10-12. The budget audit was done first (`paths.py` -> `paths.out`, `verify_widening.py`).

**Budget audit.** The M runs passed no `--gbrain-config`, so every `search.*` key is at its gbrain 3e4ff61c default:
`return_unit` unset (meaning `auto`), `return_budget_default` 6,000, `return_budget_conversation` 24,000, remote max
32,000. Each recorded call's path follows from its arguments and hit types (ops/search.ts `evidencePlanFor`,
`resolveEvidencePlan`, `effectivePlan`):
- implied auto, no `token_budget`: the chunk path, with no evidence budget when no conversation hit is present.
  With a conversation hit, the auto path at **24,000**.
- `search` with `token_budget`: the auto cap path at the caller's budget.
- `query` with `token_budget`: the legacy chunk path.
- explicit `return_unit`: that unit at 6,000.

The F2 activation path in the plan (implied auto, long non-conversation hit, no explicit budget) therefore runs at
24,000. F2 is inert on explicit-unit and legacy-query calls; on cap-path calls it runs at the caller's budget.

**Replay.** Every recorded gbrain agent `search`/`query` call, all families, on M (primary) and dev (check), not S.
Each call is replayed twice through `assembleEvidenceForHits` in the scratch copy at 3e4ff61c (`../scoped/gb-scoped`,
hooks in `../scoped/patch.diff`), on its own real path:
- today: the hooks off;
- F2(U): long non-conversation pages widened at U (window, section or page), with the rest unchanged.

Long means a rendered body of at least 20,000 characters, with no conversation signal.

**Coverage bars.** These use the same 277 M H4 (call, deciding page) pairs, each on its real path:
1. Long coverage is strictly greater than chunk's.
2. No short pair is lost against chunk, pair by pair.
3. Long coverage is above 48/53 (90.6%).

**Payload bar.** Over all recorded agent search/query calls in the F2 arm's cells (gbrain, H2-H4, all three models,
M), pooled: the sum of delivered characters added by F2 (F2(U) text minus today's text, replayed) divided by the sum of
recorded search/query result characters (attempts `chars`, the full serialized results), must be at most **X = 25%**.
Full-family and dev values are reported.

**Derivation of X** (`derive.ts` -> `derive.out`, from M records only, computed before any F2 number):
1. Headroom. The F2-only H2-H4 arm is priced at $107.89 and runs under a per-arm cap of 1.15 x price ($124.07). Its
   headroom is 15% of price. The ledger rate scales price and cap alike, so the share holds.
2. Search results' share of agent cost.
   - Chars per token: 3.195, measured with gbrain's cl100k counter over 33.7M characters of recorded search results.
   - Cost per input-side token: input, cache read and cache write, priced with the ledger table. Sonnet $0.585/M,
     Opus $1.047/M, Sol $0.593/M.
   - Re-reads: each search result is re-read by every later request in its session; calls are spread evenly over
     the session's requests.
   - The resulting re-read cost is 57.9% of agent cost in the arm's M cells. This overstates the share (Sol's
     estimate exceeds its input-side tokens), which makes X stricter.
3. Extra delivered characters raise agent cost by at most (relative rise) x 57.9%. Keeping the projected arm cost
   inside its cap needs a rise of at most 15% / 57.9% = 25.9%, rounded down to **25%**.

Sensitivity, reported and not deciding: the strictest bound treats all input-side cost (91.5%) as scaling with
search payload, which gives 16.4%.

**Pick.** Among U passing all four bars, take the highest long coverage. If two are within 2 points, take the lower
payload rise. If none passes, nothing is picked.

**Dev check** (can veto, 35 long pairs): the pick's dev long coverage is not below chunk's, no dev short pair is
lost, and dev's pooled payload rise is at most X.
