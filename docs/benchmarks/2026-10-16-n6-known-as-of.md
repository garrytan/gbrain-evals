# N6 with gbrain's recorded-time reads (`known_as_of`, belief ledger W2): no leaks or oracles at the v0.60.267.0 release (2026-10-16)

gbrain [#6850](https://github.com/garrytan/gbrain/pull/6850) (W2, released in v0.60.267.0) adds `known_as_of` to `get_page` and `get_versions`: the page as the brain had recorded it at an instant, read from the belief ledger. N6 asks whether a remote caller can read anything the brain marks as not theirs. This run checks the new params through N6's own fuzz, in process on PGLite and over the real HTTP transport on Postgres.

## What N6 does with the new params

When an op has an optional `known_as_of` param, the runner adds two variants: `known_as_of` and `known_as_of+source_id=beta`. Each passes an instant taken after seeding, sets `diff` and `include_body`, and leaves out the widening flags except `include_deleted`. On a build with recorded-time reads, `seed` turns on the belief ledger for every source before any write, so the history being probed is real. The Postgres-over-HTTP runner seeds through the same function, so its ledger is on too.

Each `known_as_of` probe records two outcomes: what the trusted local caller got for the same arguments, and what the remote caller got. Each outcome is one of `history` (an answer with a recorded interval), `coverage_from`, `coverage_gap`, `unproven`, `invalid_params` or `refused`. A probe tests recorded-time reads only when the trusted caller read real history and the probe carries signal; the receipt counts these as `real_history_signal`. The HTTP verdict fails when a build exposes `known_as_of` and no probe reads real history.

## Results

| Run | gbrain | Callers | Content leaks | Existence leaks | Oracles | Verdict |
|---|---|---|---|---|---|---|
| N6 in process, PGLite | `cbaad1f0` | six remote | 0 | 0 | 0 | pass |
| N6 Postgres over HTTP | `d722ddf0` | none, invalid, expired, scoped, owner | 0 | 0 | **16** | **fail** |
| N6 Postgres over HTTP | v0.60.267.0 (`933a7677`) | same | 0 | 0 | 0 | pass |
| N6 in process, PGLite | v0.60.267.0 (`933a7677`) | six remote | 0 | 0 | 0 | pass |

The release rows ran from a clean checkout of the `v0.60.267.0` tag. Its tree differs from `4911c463`, the head the fix was measured at, only in version stamps and the changelog entry, and both runs gave the same counts at both commits. They come from the runner that breaks out `known_as_of` outcomes:

| Run | `known_as_of` probes | Real-history signal | Trusted: history / coverage_from / refused | Remote: history / coverage_from / refused |
|---|---|---|---|---|
| Postgres over HTTP | 136 | 56 | 72 / 0 / 64 | 32 / 0 / 104 |
| PGLite in process | 180 | 90 | 100 / 0 / 80 | 40 / 0 / 140 |

Every signal-bearing probe read real history, and none hit `coverage_from`. A remote `history` answer is a page that caller may see; the leak scan and the oracle check cover it like any other answer.

All 16 oracles at `d722ddf0` were `known_as_of` variants of `get_page` and `get_versions` for the owner principal, a remote OAuth client federated over two sources. A private page refused `page_not_found`, but a slug that was never written refused `coverage_from`. The read picked its source from the ledger rows that name the slug, so a private page's rows changed which source was chosen, and with it the error. gbrain `4911c463` (in v0.60.267.0) fixes this: a remote caller's source lookup counts only world-visible events of pages it can see now, and a coverage or proof refusal about a page it cannot see becomes `page_not_found`. A unit cell in gbrain fails without the fix.

The Postgres-over-HTTP run at v0.60.267.0 covers all 155 mandatory cells with at most 8 pooled connections.

Hermetic, no provider key, $0. Receipts: [PGLite cbaad1f0](2026-10-16-n6-known-as-of/n6-pglite-cbaad1f.json), [Postgres HTTP d722ddf0](2026-10-16-n6-known-as-of/n6-postgres-http-d722ddf.json), [Postgres HTTP v0.60.267.0](2026-10-16-n6-known-as-of/n6-postgres-http-933a767.json), [PGLite v0.60.267.0](2026-10-16-n6-known-as-of/n6-pglite-933a767.json).

## Reproduce

```bash
bun eval/runner/n6-visibility-fuzz.ts --gbrain <gbrain checkout>@<ref> --output <dir>
bun eval/runner/n6-postgres-http.ts --pg-url <admin url> --gbrain <gbrain checkout>@<ref> --output <dir>
```
