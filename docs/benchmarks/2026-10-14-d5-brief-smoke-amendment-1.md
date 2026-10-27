# Amendment 1 to the D5 brief Cat 40 smoke preregistration (sha256 434850c2…f384d)

Written 2026-10-14, before any re-smoke cell. Nothing in the frozen file changes except what is listed here.

1. **Why a re-smoke.** The first run (gbrain-evals v0.10.101,
   [VERDICT](2026-10-14-d5-brief-smoke/VERDICT.md)) failed L1 only, on 4 existence findings in `list_write_conflicts`
   that master `14ea3e2e` also had. That op's fix (garrytan/gbrain#6708) has since landed on master. The first run's verdict
   stands; this re-smoke is a new run under the same rules.
2. **Builds.** `master` is now gbrain `3961bf165cb212308dcccb1ae8a610041fcd06d6` (v0.60.232.0, Merge #6708), which contains the fix. `d5` is now
   garrytan/gbrain#6703's head `f127b1b5a028c3723d07e2358bef2dfb9960ce65` (v0.60.232.0), which merges that master. Before the first cell,
   `gbrain --tools-json` must still differ only in `context_pack`'s `counterparty` and `intent`, and the listing probe
   must pass on both slots. Otherwise no cell runs.

   Measured before this amendment was committed (no spend): `--tools-json` lists 171 operations on both builds, and
   the only difference is `context_pack`'s `counterparty` and `intent`, with the same descriptions as in the
   preregistration. Its description and its other parameters are byte-identical. sha256: master `9f6aab59…`,
   `d5` `dc6134f0…`. A stdio `tools/list` on a fresh brain, callable `full` and advertised `starter`, lists 35 tools on
   both builds. `context_pack` shows both parameters on `d5` and neither on master. The two builds differ by the same
   18 files as the first run.
3. **Ledger.** A new ledger, `.budget/d5-brief-resmoke.sqlite`, with a program cap of $10. The first run's ledger keeps
   its own record.
4. **Record and harness.** Results go under `docs/benchmarks/2026-10-14-d5-brief-smoke/resmoke-1/`. Cells run from
   gbrain-evals branch `capy/d5-brief-resmoke` (runner fix `c9c23c18`; each receipt records the exact `evals_commit`). Its only harness change since `2fc29c11` is
   that the Cat 40 runner now scrubs every file it writes under `--out` (`gbrain@<sha>`, `<slots>/…`, repo-relative
   paths). That changes what the files record, not what any cell measures.
5. **Unchanged.** Tasks, models, flags, arm, world, checks R1, R2, M, L1, L2 and exercised, the verdict rule, the pair
   order and the per-pair budget stop are all unchanged. So is the N6 harness, including the `counterparty` variant.
