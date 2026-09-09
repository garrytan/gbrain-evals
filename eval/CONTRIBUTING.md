# Contributing to BrainBench

Useful contributions make it easier to tell when gbrain helps. You can contribute naturally worded questions, a competing search implementation, or a reproduction of a published result.

Work from the repository root. Install with `bun install --frozen-lockfile`, and run `bun run test` for the tests under `test/eval/`.

## Write questions in your own words

The built-in “Tier 5.5” set contains 50 AI-authored placeholder questions. The name means externally authored questions; it does not mean those placeholders were submitted by independent researchers. Human submissions add wording the benchmark authors may not anticipate.

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

## Reproduce a result

A report identifies two pieces of code: this repository's runner and the gbrain dependency it tested. Use the corresponding gbrain-evals revision, then install its pinned dependency. If the report used a local gbrain checkout, select the specified revision in that separate checkout before linking it.

Run the report's exact command, including question family, top-k, model and settings. Current runner defaults may differ from the original run. Save the fresh receipt alongside the historical result under a new date.

A repeated deterministic result can match exactly. API-backed results can vary with model behavior, and measured latency varies by machine. Do not promise that a historical result without raw output can be recreated byte for byte.

When reporting a discrepancy, include Bun version, operating system, both code identities, resolved model/settings, the command and the receipt. Exclude API keys and private content.

## Documentation and credit

Explain a feature with a concrete case before using its internal name. Keep measurements, benchmark inputs, frozen prompts and generated results intact. Use plain English and avoid em dashes. Commit prefixes such as `docs(eval):`, `fix(eval):` and `test(eval):` make the history easier to scan.

See [CREDITS.md](CREDITS.md) for attribution. Contributions to external questions and adapters should add the author's credit and clearly identify which material is synthetic.
