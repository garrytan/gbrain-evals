# N1 knowledge update with gbrain's belief ledger on: unchanged at 388/388, 0 stale (2026-10-16)

gbrain's belief ledger ([#6806](https://github.com/garrytan/gbrain/pull/6806), W1, released in v0.60.265.0) records every change to what a brain asserts: a fact added, revised or withdrawn, a take, a link. It is off per source until `gbrain beliefs enable` runs. The ledger records changes and nothing reads it to answer a query, so turning it on must not change any answer gbrain gives. Probe 40 of the ledger design checks this: N1 must stay at 388/388 current values and 0 stale values served with the ledger on.

It does. On the v0.60.265.0 release commit `09943580e`, N1 gives the same result with the ledger off and on, on both engines and all three transports, with nothing failing, leaking or lost.

## The concrete case

N1 writes a fictional fact, for example a company's head count, then updates it. It then asks for the value after the update, after a server restart, after a full reimport from the Markdown vault and while writes run in parallel. A correct answer is the newest value. A stale answer is an older value served as current. N1 also asks for the history, which should keep the earlier value; for private values that a scoped caller must not see; and for negative controls, facts that were never written.

With the ledger on, every one of those writes also appends ledger events in the same transaction. A ledger bug that broke or slowed a write, changed what gets stored, or let a publication fail would show up as a wrong, stale or missing answer, a lost write or a system error.

## The experiment and results

- **gbrain:** the v0.60.265.0 release, tag `v0.60.265.0` at [`09943580e`](https://github.com/garrytan/gbrain/commit/09943580ecc57cfcf8f9800e70f48e37e8e1107b) (the merge of #6806), loaded as a `--gbrain` overlay from a clean checkout. The declared pin in `package.json` is still `77cf8e1116e9`; both receipts record the pin and the loaded head (`execution.product.loaded_git_head`).
- **Benchmark:** N1 0.5.0, generator `n1-knowledge-update-gen@1`, seed 11, 897 scored tasks per arm. Hermetic: no provider key, no embedding model, System One off, $0.
- **Cells:** PGLite and Postgres, each over the trusted local CLI, stdio MCP and HTTP MCP: three cells per engine, six per arm.
- **Arms:** ledger off (the default) and ledger on (`EVAL_BELIEF_LEDGER=1`). In the on arm each cell runs `gbrain beliefs enable --source vault` right after the vault becomes the default source and before any page is written. It exits 0 in all six cells ("0 page(s) baselined; certified (managed source)"), so the ledger records every write the cell makes. The off receipt has no `beliefs-enable` step.

| Measure (per engine, 3 cells) | Ledger off, PGLite | Ledger off, Postgres | Ledger on, PGLite | Ledger on, Postgres |
|---|---|---|---|---|
| Current value correct | 388 / 388 | 388 / 388 | 388 / 388 | 388 / 388 |
| Stale values served | 0 | 0 | 0 | 0 |
| History retained | 385 / 385 | 385 / 385 | 385 / 385 | 385 / 385 |
| Negative controls passed | 124 / 124 | 124 / 124 | 124 / 124 | 124 / 124 |
| Private value leaks | 0 | 0 | 0 | 0 |
| Acknowledged writes lost | 0 | 0 | 0 | 0 |
| System errors | 0 | 0 | 0 | 0 |

Both arms pass every preregistered N1 rule. Per-cell and per-checkpoint counts (updated, restart, reimport, concurrent) are identical between the arms.

Each arm ran once on one 4-core machine, the on arm first. Cell times were within 3% of each other in both directions, for example 216.1 s with the ledger on against 217.5 s off on the PGLite CLI cell, and 38.5 s against 37.5 s on the Postgres stdio cell. PGLite call latency was p50 45 ms / p95 1,089 ms on against 49 / 1,058 ms off. One run per arm can't separate a difference that small from run-to-run noise, so this is not a cost measurement. The ledger's write cost is measured in the ledger design, section 9.

The same experiment on the pre-release W1 head `b3db5af98` gave the same counts in every cell. Those receipts are replaced by these, measured on the released code.

## What to use and what to avoid

Turning the ledger on for a source does not change what N1 measures: current values, history, privacy and write durability. N1 doesn't test what the ledger adds (event history, coverage and drift). gbrain's own ledger tests cover those. This result is for the release named above.

## Reproduce and inspect

From the repository root, with Postgres at `--pg-url` and a gbrain checkout that has the `v0.60.265.0` tag:

```bash
bun eval/runner/n1-knowledge-update.ts --gbrain <gbrain checkout>@v0.60.265.0 --engines pglite,postgres --pg-url <url> --output off
EVAL_BELIEF_LEDGER=1 bun eval/runner/n1-knowledge-update.ts --gbrain <gbrain checkout>@v0.60.265.0 --engines pglite,postgres --pg-url <url> --output on
```

Each arm writes `<dir>/receipt.json`, takes about 4 minutes and costs $0. The hook is in `eval/runner/lifecycle/slice.ts`, and `test/eval/lifecycle-belief-ledger-arm.test.ts` checks it.

Receipts: [ledger off](2026-10-16-belief-ledger-n1/n1-receipt-ledger-off-0994358.json), [ledger on](2026-10-16-belief-ledger-n1/n1-receipt-ledger-on-0994358.json). The N1 runner scrubs home and temp paths before it writes a receipt, so these are byte for byte as the runner wrote them (sha256 `e3011f45065a8b14673796c226d537e702c8ae3d9c26ae77188e8af0d3114009` off, `cd5bd9367d87b9cf2e736b44b74d0e2a8f79eb2e2ec1f1136a30bcadcfc46cd7` on).
