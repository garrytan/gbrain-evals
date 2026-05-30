# PrecisionMemBench — vendored upstream artifacts

This directory vendors the benchmark fixtures and scoring code from
**PrecisionMemBench** so gbrain's retrieval can be scored against the exact
same harness every other system on the leaderboard uses.

- **Upstream:** https://github.com/tenurehq/precisionmembench
- **Author:** tenurehq (Jeffrey Flynt)
- **License:** MIT
- **Pinned commit:** `c9689ca63d83f8979b235fd2c0a6ddf2d28ca850` (2026-05-29)

## Vendored verbatim (byte-for-byte from upstream)

| Local path | Upstream path |
|---|---|
| `fixtures/beliefs.seed.json` | `fixtures/beliefs.seed.json` |
| `fixtures/retrieval.cases.json` | `fixtures/retrieval.cases.json` |
| `fixtures/session-retrieval.cases.json` | `fixtures/session-retrieval.cases.json` |
| `scorer/belief.ts` | `src/types/belief.ts` |
| `scorer/buildRetrievalReport.ts` | `src/utils/buildRetrievalReport.ts` |
| `scorer/baseAdapter.ts` | `src/adapters/baseAdapter.ts` (one path edit, below) |

## Intentional edits to vendored code

1. **`scorer/baseAdapter.ts` — two layout-only path edits, no logic change.**
   (a) `CONFIG_PATH`: upstream resolves `providers.config.json` at repo root
   (`../../` from `src/adapters/`). The vendored copy lives at `scorer/`, so the
   path is `../providers.config.json` (co-located at
   `eval/precisionmembench/providers.config.json`).
   (b) The `Belief` type import: upstream is `../types/belief.ts` (from
   `src/adapters/` → `src/types/`). In the vendored layout `belief.ts` is
   co-located in `scorer/`, so the import is `./belief.js`. (It's a type-only
   import that Bun erases at runtime, but the upstream path resolved to nothing
   in this layout and `tsc --noEmit` flagged it — fixed for correctness.)
   No logic change. The scoring-relevant methods (`buildContext`,
   `listPinnedFacts`, `listPinnedOpenQuestions`, `expandRelationParticipants`,
   `seed`, `searchText`) are byte-identical to upstream.

2. **`scorer/runCases.ts` — NEW (not upstream).** The per-case assertion +
   precision/recall computation is lifted **verbatim** out of upstream's
   `src/retrieval.external.eval.test.ts` `test.serial(...)` body into a plain
   `scoreCases(...)` function (de-ava'd). The logic — `mustInclude`,
   `mustExclude`, `shouldOnlyInclude`, `maxCount`/`minCount`, `orderedBefore`,
   precision/recall/pinnedCoverage math — is unchanged. Only the test-runner
   wrapper (`test`, `t.is`, `test.before`/`test.after`) is removed.

## Faithfulness invariant

gbrain's reported numbers are produced by this vendored scorer. The invariant
we hold is **semantic parity** with upstream: identical case pass/fail,
identical returned-ID sets, identical precision/recall/summary metrics — with
wall-clock latencies normalized out (de-ava'ing changes execution timing, not
verdicts). A cross-check fixture pins this.

`providers.config.json` here contains only a `gbrain` entry; gbrain's adapter
overrides `seed()` + `searchText()` to talk to an in-memory PGLite brain
instead of the HTTP `/add`/`/search`/`/reset` contract, so `defaultUrl` is
never dialed.
