# PrecisionMemBench attribution and local adaptations

This directory contains a copy of [PrecisionMemBench](https://github.com/tenurehq/precisionmembench), an external benchmark for precise memory retrieval. Using its fixtures and scoring rules lets us inspect how gbrain behaves on questions chosen by another project.

- **Author:** tenurehq (Jeffrey Flynt)
- **License:** MIT
- **Pinned upstream commit:** `c9689ca63d83f8979b235fd2c0a6ddf2d28ca850` (2026-05-29)

## Where the files came from

| Local path | Upstream path |
|---|---|
| `fixtures/beliefs.seed.json` | `fixtures/beliefs.seed.json` |
| `fixtures/retrieval.cases.json` | `fixtures/retrieval.cases.json` |
| `fixtures/session-retrieval.cases.json` | `fixtures/session-retrieval.cases.json` |
| `scorer/belief.ts` | `src/types/belief.ts` |
| `scorer/buildRetrievalReport.ts` | `src/utils/buildRetrievalReport.ts` |
| `scorer/baseAdapter.ts` | `src/adapters/baseAdapter.ts` |

The fixtures and the first two scorer files are recorded as copied from that revision. The original attribution claimed byte-for-byte identity; a separate upstream byte-diff remains listed in [TODOS.md](../../TODOS.md). That claim should not be treated as an independent verification already completed.

## Changes for this repository's layout

`scorer/baseAdapter.ts` has two documented path changes:

1. `CONFIG_PATH` points to `../providers.config.json`, because the copied file lives in `scorer/` rather than upstream's `src/adapters/`.
2. The type-only `Belief` import uses the neighboring `./belief.js` rather than upstream's `../types/belief.ts`.

These changes are intended to affect file lookup, not scoring. The scoring-relevant methods are `buildContext`, `listPinnedFacts`, `listPinnedOpenQuestions`, `expandRelationParticipants`, `seed` and `searchText`.

`scorer/runCases.ts` is a local file. It extracts the case checks from upstream's `src/retrieval.external.eval.test.ts` into `scoreCases`, removing the Ava test-runner wrapper. The intended behavior preserves `mustInclude`, `mustExclude`, `shouldOnlyInclude`, count limits, ordering checks, and precision/recall/pinned-coverage calculations.

## What comparability requires

The target is identical case decisions, returned-ID sets and summary metrics for identical inputs. Wall-clock timing is considered separately because the local runner wrapper changes execution timing.

The scorer parity fixture checks this behavior. It does not establish that every provider used the same model, seed policy or configuration. Published comparisons must identify those conditions too.

The local `providers.config.json` contains a gbrain entry. Its adapter uses an in-memory PGLite database rather than sending HTTP `/add`, `/search` and `/reset` requests, so the configured `defaultUrl` is not contacted.

The [benchmark report](../../docs/benchmarks/2026-05-29-precisionmembench.md) records the separate correction to gbrain's seed behavior: superseded beliefs must be loaded as live inputs when the upstream contract does not provide a supersession label. Keeping the scorer faithful is necessary, but the adapter must also avoid learning the answer during setup.
