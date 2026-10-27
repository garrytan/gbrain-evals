# N6 with gbrain's weekly belief diff (`delta {beliefs: true}`, belief ledger W4): 12 leaks found and fixed before release, 0 at v0.60.273.0 (2026-10-16)

gbrain's wave 4a ([#6866](https://github.com/garrytan/gbrain/pull/6866), released in v0.60.273.0) adds `beliefs: true` to `delta`: each belief that changed in the window, with its value before and after, the event that caused the change and a pointer to the evidence, read from the belief ledger. `gbrain beliefs changes` is its CLI twin and calls the same op on a remote brain. N6 asks whether a remote caller can read anything the brain marks as not theirs. This run checks the new param through N6's own fuzz, in process on PGLite and over the real HTTP transport on Postgres.

## What N6 does with the new param

When `delta` exposes `beliefs`, the runner adds a `beliefs` variant that sets `beliefs: true` with a `since` before seeding, so the window holds the whole seeded history. Seeding turns the belief ledger on for every source before any write, so the history probed is real. Each probe records what the trusted local caller and the remote caller got: `history` (at least one change) or `empty`. A probe tests the diff only when the trusted caller read changes and the probe carries signal; the receipt counts these as `real_history_signal`. The HTTP verdict fails when a build exposes `beliefs` and no probe reads real history. The oracle view masks `beliefs.until`, which is the request instant and differs on every call by design.

## Results

| Run | gbrain | Callers | Content leaks | Existence leaks | Oracles | Verdict |
|---|---|---|---|---|---|---|
| N6 in process, PGLite | `41e2900f` | six remote | **12** | 0 | **20** | **fail** |
| N6 Postgres over HTTP | `41e2900f` | none, invalid, expired, scoped, owner | **12** | 0 | **18** | **fail** |
| N6 in process, PGLite | `378f0e73` | six remote | 0 | 0 | 0 | pass |
| N6 Postgres over HTTP | `378f0e73` | same | 0 | 0 | 0 | pass |
| N6 in process, PGLite | v0.60.273.0 (`6c3e6fe0`) | six remote | 0 | 0 | 0 | pass |
| N6 Postgres over HTTP | v0.60.273.0 (`6c3e6fe0`) | same | 0 | 0 | 0 | pass |

| Run | `beliefs` probes | Real-history signal | Trusted: history / empty | Remote: history / empty |
|---|---|---|---|---|
| PGLite in process | 36 | 28 | 32 / 4 | 16 / 20 |
| Postgres over HTTP | 34 | 28 | 32 / 2 | 16 / 18 |

The `beliefs` counts are the same at all three commits. The leaks at `41e2900f` were held Takes: `delta {beliefs: true}` passed every world-visibility Take to remote callers, both as a revised take and in the creation body of a page created in the window, while the Takes surfaces show remote callers only the holders they may read. gbrain `1d7ce5b3` applies that holder rule to the history reader and to the creation body. A unit cell in gbrain fails with either filter reverted. The oracles were `beliefs.until` timestamps alone; the runner now masks it.

The final head `378f0e73` also carries the fixes from gstack `/review` of the branch, several of them privacy fixes on the same surface: remote reads page on the rows each history page scanned (a remote page is filtered after its SQL `LIMIT`), a creation or earlier body never shows a claim made private later, remote creation entries no longer carry counts of beliefs the caller cannot read, the event cap counts only rows the caller may read (so private events cannot change `truncated` or which changes are listed), and relationship-note upper bounds count only the evidence the caller's scope counts. Each has a gbrain unit cell that fails without it.

The Postgres-over-HTTP run at `378f0e73` covers all 155 mandatory cells with at most 8 pooled connections. In process, N6 covers 33 of 79 read ops. The release rows ran from a clean checkout of the `v0.60.273.0` tag (tree `6d4ed0eb`). That tree differs from `378f0e73`, because the release also carries a merged belief write-overhead lane and current master, so both runs were repeated there; the Postgres-over-HTTP run again covers all 155 mandatory cells. All runs read the gbrain tree through `--gbrain`; each receipt records the overlay commit and tree, and the package pin is unchanged.

Hermetic, no provider key, $0. Receipts: [PGLite 41e2900f](2026-10-16-n6-delta-beliefs/n6-pglite-41e2900.json), [Postgres HTTP 41e2900f](2026-10-16-n6-delta-beliefs/n6-postgres-http-41e2900.json), [PGLite 378f0e73](2026-10-16-n6-delta-beliefs/n6-pglite-378f0e7.json), [Postgres HTTP 378f0e73](2026-10-16-n6-delta-beliefs/n6-postgres-http-378f0e7.json), [PGLite v0.60.273.0](2026-10-16-n6-delta-beliefs/n6-pglite-6c3e6fe.json), [Postgres HTTP v0.60.273.0](2026-10-16-n6-delta-beliefs/n6-postgres-http-6c3e6fe.json).

## Reproduce

```bash
bun eval/runner/n6-visibility-fuzz.ts --gbrain <gbrain checkout>@<ref> --output <dir>
bun eval/runner/n6-postgres-http.ts --pg-url <admin url> --gbrain <gbrain checkout>@<ref> --output <dir>
```
