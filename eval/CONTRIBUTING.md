# Contributing to BrainBench

Useful contributions make it easier to tell when gbrain helps. You can contribute naturally worded questions, a competing search implementation, or a reproduction of a published result.

Work from the repository root. Install with `bun install --frozen-lockfile`, and run `bun run test` for the tests under `test/eval/` and `eval/`, the Python tests and the validators. The gbrain under test is the one `package.json` declares, master `739e5cc` (v0.60.46.0); a category scores what gbrain implements at that commit. Model-comparison runs follow the model rules in [CLAUDE.md](../CLAUDE.md#choose-models). Everything above [Changelog](#changelog) is current.

## Write questions in your own words

The built-in “Tier 5.5” set contains 50 AI-authored placeholder questions. They use the `externally-authored` tier id reserved for outside submissions, but no independent researcher wrote them, so scorecards label the family `synthetic-outsider` (earlier receipts say `externally-authored`). Human submissions add wording the benchmark authors may not anticipate.

First inspect the fictional world:

```sh
bun run eval:world:view
# Without a desktop browser:
bun run eval:world:render
```

Then create and validate a question:

```sh
bun run eval:query:new --tier externally-authored --author "@your-handle"
bun run eval:query:validate path/to/your-queries.json
```

The scaffolder prints JSON. Save it, replace the example text and page identifiers, and validate again. The validator accepts a single question, a JSON array, or an object with a `queries` array.

A **slug** identifies a page, such as `people/alice-example`. A question's `gold.relevant` list is its answer key: the pages search should find. Verify that these pages exist in `eval/data/world-v1/`; correct slug syntax alone does not prove that.

For time-sensitive wording, set `as_of_date` to `"corpus-end"`, `"per-source"`, or an ISO date. This makes “where does this person work?” answerable at a defined point in time. If the question has no answer in the corpus, use `expected_output_type: "abstention"` and `gold.expected_abstention: true`.

Submit a batch of at least 20 questions at `eval/external-authors/<handle>/queries.json`. Use the [query PR template](../.github/PULL_REQUEST_TEMPLATE/tier5-queries.md). We review whether the questions validate, their answer pages exist, and their wording varies naturally. Use only the fictional world; do not contribute private notes or real personal data.

## Add a search adapter

This section is for BrainBench's in-process retrieval comparison (`multi-adapter.ts`). To add a memory system to the
head-to-head scoreboard, use [Add a memory system to the scoreboard](#add-a-memory-system-to-the-scoreboard) instead; that
harness talks to systems over an HTTP shim protocol, not this interface.

An adapter ingests pages once, then returns a ranked list for each question. The current contract lives in [runner/types.ts](runner/types.ts):

```typescript
interface Adapter {
  readonly name: string;
  init(rawPages: Page[], config: AdapterConfig): Promise<BrainState>;
  query(q: PublicQuery, state: BrainState): Promise<RankedDoc[]>;
  snapshot?(state: BrainState): Promise<string>;
  teardown?(state: BrainState): Promise<void>;
}
```

This excerpt shows the methods needed for a retrieval adapter; the source also defines optional poison-handling reporting. `BrainState` is opaque to the runner, so the adapter chooses its internal representation.

The runner strips hidden facts and answer labels before calling the adapter. `PublicQuery` provides the question without its answer key or internal family metadata. Never read the gold directory or infer answers from benchmark identifiers. This boundary is enforced by types, sanitization and reviewed tests, not by a separate process sandbox.

Implement the adapter under `eval/runner/adapters/`, then register it in `multi-adapter.ts`. Put tests under `test/eval/` so `bun run test` includes them. Test ingestion, useful ranked output and stable tie-breaking; mock API calls in unit tests.

Results use ranks starting at 1 and contain no duplicate pages. Explain how equal scores are ordered. Implement `teardown` if the adapter holds a database, worker or file handle.

```sh
bun run test
BRAINBENCH_N=1 bun eval/runner/multi-adapter.ts --adapter my-adapter --queries relational
```

Document the model, embedding dimensions, graph behavior, network use and any limits. An adapter name must describe the behavior that actually ran. A missing provider key must not silently turn a reranked comparison into ordinary hybrid search.

## Add a memory system to the scoreboard

The scoreboard runs every system behind a small HTTP service, its shim, inside the system's own pinned container image,
with every provider call going through the cell's metering proxy. The harness speaks only the
[shim protocol](systems/PROTOCOL.md), so a system's code never runs inside the harness process. The steps, with an
example capability record, are in [docs/scoreboard.md](../docs/scoreboard.md#add-a-system). In short:

1. Start from the shim template [systems/_shim/shim.py](systems/_shim/shim.py) and the reference fake system
   [systems/_fake/fake.py](systems/_fake/fake.py) with its compose file. Keep only a dummy key in the container, point
   every SDK at `OPENAI_BASE_URL` (and `ANTHROPIC_BASE_URL`, `VOYAGE_BASE_URL`), and turn off telemetry.
2. Serve a complete capability record from `/capabilities`. `readiness` (for example `synchronous: ...` or
   `queued: ...`) decides how ingest cost is split, and `retrieval_policies.<mode>.settings` is the only knob map the
   harness sends.
3. Pass the keyless conformance suite against the running shim:

   ```sh
   SHIM_URL=http://127.0.0.1:8700 bun test test/eval/systems-conformance.test.ts
   ```

4. Rerun on LoCoMo dev with the metering proxy in front of the shim:

   ```sh
   bun eval/runner/memory-qa/run.ts --benchmark locomo --split dev --system http://127.0.0.1:8700 \
     --context native --budget-tokens 8000 --qa reader --provider-proxy http://127.0.0.1:8787 --output eval/reports/scoreboard-dev/<kind>
   ```

5. Register a kind id in [systems/kinds.json](systems/kinds.json) and the product, version, image digest and lock hash in
   the pin table of [docs/comparison-systems.md](../docs/comparison-systems.md). Product names appear only there and in
   the install bundle under `docs/comparison-systems/<kind>/`; `bun eval/runner/name-guard.ts` fails anywhere else.

`bun run eval:scoreboard fixture` runs the whole pipeline on the fake system for $0 and is the quickest check that a
harness change did not break the wiring.

## Evaluate a gbrain change

To compare a candidate gbrain build against its baseline on dev splits, and later on held-out data, use the decision kit: [docs/decisions.md](../docs/decisions.md) (`bun run eval:decide`).

## Add a category

A category is a runner, a seeded generator, a scorer and a dated report that answer one question about gbrain. Copy the N3 runner (`runner/n3-temporal-asof.ts`) for the shape, then work through this list in order. The registry test fails on a runner without a row, so start there.

1. **Check the capability matrix.** Read your category's section of the [capability and entrypoint matrix](../docs/benchmarks/2026-10-01-capability-matrix.md). Score only what gbrain implements at the pinned commit, through the entrypoints it lists. A missing capability is a gap in your report, not a failure and not a bug.
2. **Write the registry row first** in [registry.ts](registry.ts): a descriptive slug as `id`, the plan id as `legacy_alias`, `tier`, `script` (`runner/n<k>-<slug>.ts`), headline metric and denominator, `evidence_maturity`, and a `contract` saying what it measures, what it does not, and what counts as an error. Start `report-only` unless a rule below gates.
3. **Preregister promotion rules in the same commit**, before the first counted run: `safety_contracts` (exact safety assertions such as zero leaks or zero prohibited output; they gate at once), `quality_thresholds` (a metric with a fixed threshold; it gates only at that threshold) and `exploratory` metrics (never gate). Each rule names a receipt path, so the runner must write that field. A safety gate also needs a utility floor (a refuse-everything system must fail it). A candidate fix never sets its own threshold, and a wave category may not gate on its bare runner verdict.
4. **Run hermetic by default.** Wrap the run in `withHermeticEnv` from [runner/hermetic-env.ts](runner/hermetic-env.ts): it strips every provider and TypeSafe key, uses a throwaway `GBRAIN_HOME` and fails if System One could be on. Record `decide: DECIDE_OFF` in `resolved_config`.
5. **Take the shared flags.** `--seed`, `--output <dir>` and `--gbrain <checkout>[@ref]` (copied overlay through [runner/gbrain-under-test.ts](runner/gbrain-under-test.ts)). A paid arm runs only with `--paid --budget-run-id <id>`: call `requirePaidArm` from [runner/paid-arm.ts](runner/paid-arm.ts), then `startPaidRun` from [runner/budget-ledger.ts](runner/budget-ledger.ts), so the ledger enforces the wave cap.
6. **Generate gold, never read it from gbrain.** A seeded generator under `generators/` writes a ledger and derives gold from it with an independent oracle. Add solvability and negative controls, and presence assertions proving the data is reachable before you measure its absence; a failed presence assertion makes the run an error, not a pass. A gbrain exception where an answer is expected is a scored miss.
7. **Ship the tests** under `test/eval/`: a generator determinism test (same seed, same ledger hash), a scorer test with hand-built gold including a negative that must fail, a deliberately broken adapter the category must fail, and a scorer mutation suite. The mutation suite uses `assertScorerRejectsFakeSystems` from [runner/mutation-kit.ts](runner/mutation-kit.ts): the honest system must pass, and the empty, always-positive, always-refuse, stale and wrong-source fakes must fail (declare a fake not applicable only with a reason). See `test/eval/scorer-mutation.test.ts` for N3, N4 and N6.
8. **Print in a fixed order:** verdict, safety contracts, quality metrics with denominators, gbrain bugs with a one-line repro, receipt path. Record every gbrain finding with `upsertBug` from [runner/bug-ledger.ts](runner/bug-ledger.ts), classified as a bug against a stated contract, a feature gap or a category defect.
9. **Measure the run time** of the hermetic arm and keep it under the registry's CI budget (target 60 seconds); `bun eval/runner/all.ts --only <id>` runs just your category through the same gate CI uses.
10. **Write the report and the docs row.** A dated report in `docs/benchmarks/` following the N3 report outline, with "gbrain bugs found" and "documented limits (not bugs)" sections, and a question-first row in [docs/README.md](../docs/README.md). Copy worthwhile receipts out of `eval/reports/` and scrub machine paths with `bun eval/runner/receipt.ts scrub`.

## Reproduce a result

A report identifies two pieces of code: this repository's runner and the gbrain dependency it tested. Use the corresponding gbrain-evals revision, then install its pinned dependency. If the report used a local gbrain checkout, select the specified revision in that separate checkout before linking it.

Run the report's exact command, including question family, top-k, model and settings. Current runner defaults may differ from the original run. Save the fresh receipt alongside the historical result under a new date.

A repeated deterministic result can match exactly. API-backed results can vary with model behavior, and measured latency varies by machine. Do not promise that a historical result without raw output can be recreated byte for byte.

When reporting a discrepancy, include Bun version, operating system, both code identities, resolved model/settings, the command and the receipt. Exclude API keys and private content.

## Documentation and credit

Explain a feature with a concrete case before using its internal name. Keep measurements, benchmark inputs, frozen prompts and generated results intact. Use plain English and avoid em dashes. Commit prefixes such as `docs(eval):`, `fix(eval):` and `test(eval):` make the history easier to scan.

See [CREDITS.md](CREDITS.md) for attribution. Contributions to external questions and adapters should add the author's credit and clearly identify which material is synthetic.

## Changelog

How this page changed, newest first. Measurement history lives in the dated reports and in
[CHANGELOG.md](../CHANGELOG.md).

### 2026-10-06: Add a memory system to the scoreboard

A new "Add a memory system to the scoreboard" section gives the shim template, the capability record, the keyless
conformance command and the LoCoMo dev rerun command, and links to [docs/scoreboard.md](../docs/scoreboard.md). "Add a
search adapter" now says it covers BrainBench's in-process retrieval comparison only; it had been the only adapter guide,
and its in-process interface is not how the scoreboard runs systems.

### 2026-10-05: Restructured as a current-state page with this changelog

gbrain-evals v0.10.23. The opening paragraph names the gbrain a category scores (`739e5cc`) and points model-comparison work to the model rules in CLAUDE.md. This changelog section is new.

### 2026-10-05: Evaluate a gbrain change

[`43e6b99`](https://github.com/garrytan/gbrain-evals/commit/43e6b99) (merge of #71). A new "Evaluate a gbrain change" section points to the decision kit (`docs/decisions.md`, `bun run eval:decide`) for dev and held-out verdicts on a candidate gbrain build.

### 2026-10-01: "Add a category" checklist

[`f94e98d`](https://github.com/garrytan/gbrain-evals/commit/f94e98d), gbrain-evals v0.10.5. A new "Add a category" section gives a 10-step checklist for a new eval category, modeled on the N3 runner (`runner/n3-temporal-asof.ts`). The steps cover:

- Checking the capability and entrypoint matrix, then writing the `registry.ts` row and preregistering promotion rules (`safety_contracts`, `quality_thresholds`, `exploratory`) in the same commit, before any counted run.
- Running hermetic by default with `withHermeticEnv`, the shared `--seed`, `--output` and `--gbrain` flags, and gating paid arms behind `--paid --budget-run-id` through `requirePaidArm` and `startPaidRun`.
- Generating gold with an independent oracle, shipping determinism, scorer and mutation tests (`assertScorerRejectsFakeSystems`), recording gbrain findings with `upsertBug`, keeping the hermetic arm under the 60-second CI target, and writing a dated report plus a `docs/README.md` row.

The commit introduced the capability matrix, promotion rules, hermetic environment and bug ledger that the checklist points to.

### 2026-09-29: Wider test scope and Tier 5.5 label

[`88d0b19`](https://github.com/garrytan/gbrain-evals/commit/88d0b19), gbrain-evals v0.10.1. The setup line now says `bun run test` covers `test/eval/` and `eval/`, the Python tests and the validators, not only `test/eval/`. The Tier 5.5 paragraph now explains that the 50 placeholder questions use the reserved `externally-authored` tier id but scorecards label the family `synthetic-outsider` (earlier receipts say `externally-authored`).

### 2026-09-09: Rewrite in plain language

[`9238ec8`](https://github.com/garrytan/gbrain-evals/commit/9238ec8), gbrain-evals v0.8.0. The page was rewritten from three numbered workflows with commented shell steps into prose sections, as part of the docs pass that explains retrieval in plain terms:

- "Write questions in your own words" replaces the Tier 5.5 workflow. It adds `eval:world:render` for machines without a browser, defines a slug and `gold.relevant`, and keeps the 20-question batch rule and the fictional-data-only rule.
- "Add a search adapter" shows the current `Adapter` contract (now `PublicQuery` and an optional `teardown`), explains that the runner strips answer labels before calling the adapter, and gives a `BRAINBENCH_N=1` smoke command. It also requires that an adapter name match the behavior that ran.
- "Reproduce a result" replaces the scorecard checklist. It names the two code identities to pin, asks for the report's exact command, and drops the promise that results land within tolerance bands.
- "Code style" and "Contributors" became "Documentation and credit".

### 2026-08-30: Test command rename

[`d5b94c7`](https://github.com/garrytan/gbrain-evals/commit/d5b94c7), gbrain-evals v0.3.0. The two references to `bun run test:eval` in the adapter workflow and quality bar became `bun run test`.

### 2026-04-21: Page created

[`5bd8848`](https://github.com/garrytan/gbrain-evals/commit/5bd8848). Created with the initial BrainBench v1 extraction from gbrain. It described three contribution paths: writing Tier 5.5 externally authored queries (scaffold, validate, submit at least 20 per batch), submitting an external adapter against the `Adapter` interface in `eval/runner/types.ts`, and reproducing a published scorecard. It closed with code style rules and a pointer to `CREDITS.md`.
