# Eval-category wave, lane N9 (branch `capy/wave-n9`)

Amendment 9 of the [eval-category wave plan](../plans/2026-10-01-eval-category-wave/README.md): multi-hop with held-out wording, built by extending relational-ab rather than adding a harness. Based on `capy/eval-wave-step0` (`8eb51d3`). VERSION and CHANGELOG are untouched; the integrator writes the wave entry.

## Commit order (what was frozen before what)

1. `9a0603a` grammar: `eval/generators/n9-multihop-paraphrase-gen.ts`, `eval/data/n9-multihop-paraphrase-v1/questions.json` (SHA-256 `1a2bdd9c00dbb1c106d117dae1005a8a903a9f9a4a299546d3edea2bb0def396`) and a determinism test, pushed before any scoring.
2. `5127c56` preregistration: registry rows `multi-hop-paraphrase` (N9, H, report-only) and `multi-hop-paraphrase-paid` (listed, P), promotion rules (no safety contract, no quality threshold, named exploratory metrics) and `docs/benchmarks/2026-10-01-n9-multi-hop-preregistration.md` (metrics, denominators, controls, void conditions, decision rules, budget). The runner at that commit was a placeholder that refused to run.
3. Runner, tests, runs, report, ledger entries.

Disclosure: before step 1, a throwaway plumbing check ran three hand-typed queries through keyword search to confirm the keyless path works. One of them, "Who founded the companies that Chris Jackson invested in?", has the same wording as a canonical question the grammar later produced; its outcome (no parse, the arm did not fire, top five from keyword search) was seen before the frames were written. No other grammar question was run before the hash commit.

## What changed

- `eval/runner/relational-ab.ts`: the per-seed loop is now `runSharedIndexPairs` (one index per seed, off/on pairs, telemetry checks), used by relational-ab and N9. New: `--gbrain <checkout>[@ref]` (every gbrain module, including the gateway, loads from the copied overlay through `loadRelationalProduct`), a keyword-only cell (`vector = null`: no embedding provider, vector arm must stay off, keyless degradations are expected), a per-query row limit, and `--paid --budget-run-id` through `requirePaidArm`. The old `--budget-usd` path and default behavior are unchanged; its 12 tests pass.
- `eval/runner/adapters/gbrain-inline.ts`: `productRoot` (load from an overlay by path) and `embed: false` (`noEmbed` imports).
- `eval/runner/n9-multi-hop-paraphrase.ts`: composed splits, strict supporting-fact all-hit at 10, stage funnel, parser capability check, presence (void) and solvability, shortcut and gold-shuffle controls, the one-hop splits on the keyword path, receipts v2 with overlay identity, `--record-bugs` for N9-1. Hermetic by default via `withHermeticEnv`; the paid arm keeps only `OPENAI_API_KEY`.
- Tests (`test/eval/n9-multi-hop-gen.test.ts`, `test/eval/n9-multi-hop.test.ts`): generator determinism and gold derivation, scorer with negatives, mutation suite (honest passes; empty, always-positive, always-refuse and wrong-source fail; stale not applicable because world-v1 relations carry no history), capability classifier, paired summary, paid refusal, an honest and a broken-search run on a world-v1 slice.
- Docs: dated report, preregistration, receipts, repro script and findings recorder under `docs/benchmarks/2026-10-01-n9-multi-hop/`, the wave bug ledger (`docs/benchmarks/2026-10-01-wave-bugs.json` and `.md`, created here), a docs index row, an update line in the 2026-09-29 report, two TODOS closed, measured costs in the registry.

## Results (gbrain `3a284ae` through the copied overlay)

- Composed, 375 runs per wording and arm: strict all-hit at 10 was 10/375 and 5/375 (keyword, canonical and paraphrase) and 3/375 and 3/375 (hybrid), identical off and on because the arm fired 0 times; no demonstrated benefit under the preregistered rule. 0 of 250 wordings produced a composed plan.
- One-hop paid rerun: paraphrase recall at five 0.411 to 0.537 (19 distinct questions better, 0 worse, p = 0.000004), first-place hits 4.8% to 16.6%; template unchanged from 2026-09-29. Development data.
- Bug ledger: N9-1 feature gap (no composed plans), N9-2 bug (pack frontmatter mappings forced outgoing), N9-3 bug (meeting-body attendance stored meeting to person under the default pack), N9-4 bug (attended seed never resolves), N9-5 feature gap (bare one-word seed collisions, documented).
- Cost: $0.129 of the lane's $5 (budget run `eval-category-wave-n9-2026-10-01T19-35-59-895Z-7aff6df7` in this machine's local ledger).

## Notes for the integrator and the fix wave

- `docs/benchmarks/2026-10-01-wave-bugs.json` and its Markdown view are created by this lane; other lanes add their own ids, so merge by entry and re-render with `bun eval/runner/bug-ledger.ts render --out docs/benchmarks/2026-10-01-wave-bugs.md`.
- Fix lanes for N9-2 to N9-4 can use `repro-relational-edges.ts`, which uses fictional pages only. They should not read `eval/data/n9-multihop-paraphrase-v1/questions.json` if they also change the relational parser.
- The hermetic N9 arm takes about 134 seconds, over the 60-second target; it is report-only, so it does not gate. Trimming options: drop the one-hop splits from the hermetic arm or run one seed in CI.
- The `multi-hop-paraphrase-paid` row is `listed` because a child dispatched by `all.ts` gets the run id only through the environment, and `requirePaidArm` deliberately refuses that.
- Observed but not ledgered (no stated contract found): prose links on a company page typed `invested_in` are stored company to investor, so only the investor-page edges feed "Who invested in X?".
