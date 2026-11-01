# Contributing to BrainBench

Useful contributions make it easier to tell when gbrain helps. You can contribute naturally worded questions, a competing search implementation, another system's notes scored on Cat 35, or a reproduction of a published result.

Work from the repository root. Install with `bun install --frozen-lockfile`, and run `bun run test` for the tests under `test/eval/` and `eval/`, the Python tests and the validators. The gbrain under test is the one `package.json` declares, master `3ec766c40` (v0.60.531.0); a category scores what gbrain implements at that commit. Model-comparison runs follow the model rules in [CLAUDE.md](../CLAUDE.md#choose-models). Everything above [Changelog](#changelog) is current.

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

## Score another system's Cat 35 documents

Cat 35 plants facts, decisions and distractors in 24 fictional agent conversations, then asks a judge how many of
the planted facts survive into the notes gbrain writes from each conversation. If your system also turns a conversation
into Markdown notes, the runner can score those notes with the same judge, on the same items, in the same run as gbrain's
lanes.

1. Run your system on the conversations in `eval/data/transcript-distill-v1/transcripts/` (Claude Code JSONL; plain-text
   renderings are in `transcripts-txt/`). Do not read `gold/`: it holds the answer keys.
2. Write one file per conversation into one folder, named `<transcript_id>.md` (for example `coding-reflection-01.md`).
   An empty file is a valid answer. A missing file is a lane error for that conversation and scores zero.
3. Score the folder next to the verbatim lane:

   ```sh
   CAT35_FULL=1 bun eval/runner/cat35-transcript-distill.ts --budget-usd 10 \
     --lanes verbatim --external-lane ext-notes --external-dir path/to/folder
   ```

   Without `CAT35_FULL=1` the runner scores the two-conversation smoke set. `--lanes none` scores only your folder. A run
   needs `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` like any Cat 35 run, and the runner prints its pre-flight cost
   projection before the first judge call.

Your lane is judged the way gbrain's dream lane is, on recall of the planted facts with an evidence check that the quote
the judge cites is in your document and in the conversation, plus claim grounding, distractor leakage, the usability
checklist, attribution hazards and quote fidelity. Claim grounding grades the sentences of five or more words outside
code fences, headings and quote lines, as it does for dream, so don't wrap a document in a code fence. A lane with no
gradable claim gets no hallucination rate, and one with no quotes gets no quote-fidelity rate, rather than a perfect
score. Read your recall next to the verbatim lane from the same run. Verbatim keeps the whole conversation, so its score
is the judge's ceiling.

The receipt's `external_lane` block records the lane name, the folder's real path, the size limit, each file's bytes and
sha256, how many claims the grounding judge grades in each file, the conversations with no file, and a note that the
harness has no record of how the documents were made. Your lane's scores sit under its name in the per-lane maps.
`lanes`, `mode`, the prior-run deltas, the blended usability, the judge-failure gate and the WS0 counters describe the
built-in lanes only, and the runner scores every built-in lane before your lane, so your lane's spend and provider
errors cannot reach gbrain's numbers. Your lane gets its own `external_judge_failed_rate` gate, which the run's exit
code includes, and a run with an external lane is never publishable as the benchmark. Scrub machine paths with
`bun eval/runner/receipt.ts scrub` before you share a receipt.

The runner treats the folder as untrusted. It opens only the `<transcript_id>.md` names it expects, and before any
provider call it refuses the whole run on a symlink, anything that is not a regular file, a hard-linked file, a file
over 64 KiB, a file with more than 80 claims (what the grounding judge grades in one call), invalid UTF-8, a document
that contains one of the corpus's answer-key ids (a sign the system read `gold/`), or a folder that was replaced or
swapped for a link after the run resolved its path. On Linux the runner holds the folder open and reads every file
through that handle. A lane name is lowercase letters, digits and dashes, up to 32 characters, and cannot reuse a
built-in lane name. Name the lane by what the system does, such as `ext-notes`; product names belong only in
[docs/comparison-systems.md](../docs/comparison-systems.md).

Know the limits before you compare numbers. Your documents go to the judge's provider, so keep private data out of them.
A document can carry text aimed at the judge; the judge prompts fence every document as untrusted data, label it
`external` rather than with your lane name, and each call sees one lane's document, so such text can only move that
lane's own numbers. The harness cannot tell whether your system saw the answer keys.

## Evaluate a gbrain change

To compare a candidate gbrain build against its baseline on dev splits, and later on held-out data, use the decision kit: [docs/decisions.md](../docs/decisions.md) (`bun run eval:decide`).

## Add a category

A category is a runner, a seeded generator, a scorer and a dated report that answer one question about gbrain. Copy the N3 runner (`runner/n3-temporal-asof.ts`) for the shape, then work through this list in order. The registry test fails on a runner without a row, so start there.

1. **Check the capability matrix.** Read your category's section of the [capability and entrypoint matrix](../docs/benchmarks/2026-10-01-capability-matrix.md). Score only what gbrain implements at the pinned commit, through the entrypoints it lists. A missing capability is a gap in your report, not a failure and not a bug.
2. **Write the registry row first** in [registry.ts](registry.ts): a descriptive slug as `id`, the plan id as `legacy_alias`, `tier`, `script` (`runner/n<k>-<slug>.ts`), headline metric and denominator, `evidence_maturity`, and a `contract` saying what it measures, what it does not, and what counts as an error. Start `report-only` unless a rule below gates.
3. **Preregister promotion rules in the same commit**, before the first counted run: `safety_contracts` (exact safety assertions such as zero leaks or zero prohibited output; they gate at once), `quality_thresholds` (a metric with a fixed threshold; it gates only at that threshold) and `exploratory` metrics (never gate). Each rule names a receipt path, so the runner must write that field. A safety gate also needs a utility floor (a refuse-everything system must fail it). A candidate fix never sets its own threshold, and a wave category may not gate on its bare runner verdict.
4. **Run hermetic by default.** Wrap the run in `withHermeticEnv` from [runner/hermetic-env.ts](runner/hermetic-env.ts): it strips every provider and TypeSafe key, uses a throwaway `GBRAIN_HOME` and fails if System One could be on. Record `decide: DECIDE_OFF` in `resolved_config`.
5. **Take the shared flags.** `--seed`, `--output <dir>` and `--gbrain <checkout>[@ref]` (copied overlay through [runner/gbrain-under-test.ts](runner/gbrain-under-test.ts)). A paid arm runs only with `--paid --budget-run-id <id>`: call `requirePaidArm` from [runner/paid-arm.ts](runner/paid-arm.ts), then `startPaidRun` from [runner/budget-ledger.ts](runner/budget-ledger.ts), so the ledger enforces the wave cap. If `all.ts` dispatches the runner, set `paidFlags: true` on its registry row so `all.ts` passes both flags. Pass every Anthropic Messages request through `fitAnthropicRequest` from [runner/anthropic-request.ts](runner/anthropic-request.ts), so a Claude 5-family model gets no temperature and no forced tool choice, which it rejects. Export each default model the runner picks and register it in `DEFAULTS` in [test/eval/model-defaults.test.ts](../test/eval/model-defaults.test.ts), which fails unless it is a current-generation model or a named exception with its reason in [runner/model-defaults.ts](runner/model-defaults.ts).
6. **Generate gold, never read it from gbrain.** A seeded generator under `generators/` writes a ledger and derives gold from it with an independent oracle. Add solvability and negative controls, and presence assertions proving the data is reachable before you measure its absence; a failed presence assertion makes the run an error, not a pass. A gbrain exception where an answer is expected is a scored miss.
7. **Ship the tests** under `test/eval/`: a generator determinism test (same seed, same ledger hash), a scorer test with hand-built gold including a negative that must fail, a deliberately broken adapter the category must fail, and a scorer mutation suite. The mutation suite uses `assertScorerRejectsFakeSystems` from [runner/mutation-kit.ts](runner/mutation-kit.ts): the honest system must pass, and the empty, always-positive, always-refuse, stale and wrong-source fakes must fail (declare a fake not applicable only with a reason). See `test/eval/scorer-mutation.test.ts` for N3, N4 and N6.
8. **Print in a fixed order:** verdict, safety contracts, quality metrics with denominators, gbrain bugs with a one-line repro, receipt path. Record every gbrain finding with `upsertBug` from [runner/bug-ledger.ts](runner/bug-ledger.ts), classified as a bug against a stated contract, a feature gap or a category defect.
9. **Measure the run time** of the hermetic arm and keep it under the registry's CI budget (target 60 seconds); `bun eval/runner/all.ts --only <id>` runs just your category through the same gate CI uses.
10. **Write the report and the docs row.** A dated report in `docs/benchmarks/` following the N3 report outline, with "gbrain bugs found" and "documented limits (not bugs)" sections, and a question-first row in [docs/README.md](../docs/README.md). Copy worthwhile receipts out of `eval/reports/` and scrub machine paths with `bun eval/runner/receipt.ts scrub`. The receipt guards read tarball and gzip receipts member by member: `test/eval/receipt-machine-paths.test.ts` fails on a machine path inside one (other than the harness VM overlay path it declares) and `scripts/scan-receipts.sh` on a key, unless the file is reviewed and listed with its hash in `test/eval/fixtures/reviewed-compressed-receipts.json`. Both fail on a compressed format they cannot open (`.zip`, `.xz`, `.zst`, `.bz2`, `.7z`) and on an archive or database inside a tarball, so unpack those before committing.

A category with more than one tier keeps one operator guide per tier. Cat 40 Hard is the example: its generator mode, world contract ([WORLD_SCHEMA.md](../docs/benchmarks/cat40-hard/WORLD_SCHEMA.md)), runner path, scorer and paid steps are documented in the [Cat 40 Hard runbook](../docs/benchmarks/cat40-hard/RUNBOOK.md), and its registry row is `model-ladder-hard`.

## Cut the cost of a preregistered run

Two tools lower the cost of a Cat 40 confirmation without changing what it can decide. They apply only to preregistrations written after they shipped (2026-10-28). A preregistration that uses either one declares it before any cell runs; an existing or sealed preregistration keeps its design unless an amendment written before its next cell says otherwise.

- **Reuse an arm that doesn't depend on the build.** The files-only, oracle, memory and Postgres arms never load gbrain, so a new gbrain build on a world that already ran them can use those cells as they are. Run the new experiment's first counted arm to the end (its receipt records the runner checkout), then check before the reused arm would have run:

  ```sh
  bun eval/runner/cat40/reuse-check.ts --prior <earlier fs dir> --planned <new wave dir> --arm fs --preregistration <prereg.md>
  ```

  It refuses on any difference in world digest, Hard identity, turn and tool limits, judge, scorer, judge prompt, settings or evaluator code hashes, or in any flag that reaches a cell; when the earlier run did not finish, has fewer cells than it planned or ended a cell in a harness error; when either run recorded a dirty checkout; when the world is not a Hard world; and when the two runner commits differ in any file the runner imports (an installed package by its pinned `package.json` version) or an import git cannot resolve, so run the new arms from the commit the reused arm ran at or one with the same cell code. A gbrain arm is reusable only from the same gbrain and slot commits with every gbrain flag and recorded override content equal. The preregistration must name the earlier directory's budget run id and the arm on one line, each as a whole word, and the check refuses without it. Reuse is all of an arm's cells or none, chosen before any new result is seen.
- **Size each arm by simulation.** Before preregistering sample sizes, rerun the preregistered endpoints on cells that already ran, with one arm on fewer tasks:

  ```sh
  python3 eval/runner/cat40/arm_power.py --world P1=<cells>.jsonl --world P2=<cells>.jsonl --arm fs --fractions 0.33,0.5,0.67
  ```

  For each fraction it reports how many seeded draws keep each full-data verdict the arm takes part in (the primary wording per generator for fs, D3 for the baseline, both for the wave arm), the weakest primary lower bound and the spend on the tasks left out. That is how stable a verdict stays on fewer of the same tasks, not power against a smaller true effect, so run it on cells whose effect the preregistration expects. It sizes single-repeat runs only, and gives each world's files in one `--world`. The preregistration names the command, its input cells and its output, and draws the arm's task subset with a recorded seed before the run. On the October public confirmation, fs on half the tasks kept the primary "ahead" in 20 of 20 draws ([audit](../docs/audit/2026-10-28-eval-cost-audit.md)).

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

### 2026-11-01: Compressed receipts are checked member by member

Step 10 of "Add a category" now says the machine-path test and the receipt secret scan read tarball and gzip receipts
member by member, that a compressed receipt either passes both or is reviewed and listed by hash in
`test/eval/fixtures/reviewed-compressed-receipts.json`, and that both fail on a format or nested archive they cannot
open. Before #221 neither guard opened a compressed receipt.

### 2026-11-01: Register a new category's default models

Step 5 of "Add a category" now says to export each default model a runner picks and register it in
`test/eval/model-defaults.test.ts`, which fails on a default that is neither a current-generation model nor a named
exception in `eval/runner/model-defaults.ts`. The test's own header asks a new category to do this, and CLAUDE.md's
model rules now cover defaults.

### 2026-10-31: The opening names the new pin

The opening names gbrain master `3ec766c40` (v0.60.531.0), the new pin (was `7a6bdd357`, v0.60.454.0).
`scripts/verify-documentation-refresh.py` now checks this sentence against `package.json`, so a re-pin that misses it fails
`bun run validate`.

### 2026-10-31: Anthropic requests go through fitAnthropicRequest

Step 5 of "Add a category" now says to build every Anthropic Messages request through `fitAnthropicRequest`. Claude
5-family models reject `temperature` and a forced `tool_choice` with HTTP 400, and the helper leaves requests to older
models unchanged. Step 5 also says to set `paidFlags: true` on the registry row of a paid runner that `all.ts`
dispatches, so `all.ts` passes it `--paid --budget-run-id <id>`.

### 2026-10-31: Score another system's Cat 35 documents

A new section explains `--external-lane NAME --external-dir DIR`, which scores another system's Markdown notes beside
gbrain's Cat 35 lanes under the same judge: the folder layout, the commands, what the receipt's `external_lane` block
records, how claim grounding counts claims, which fields stay built-in only, the refusals for a hostile folder and the
limits. The opening now lists this as a way to contribute. The feature was rebuilt on main from Khaled Aly's design in
[#32](https://github.com/garrytan/gbrain-evals/pull/32).

### 2026-10-31: The opening names the current pin again

The opening names gbrain master `7a6bdd357` (v0.60.454.0) as the gbrain under test, matching `package.json`. It still
named `77cf8e111` (v0.60.169.0), which stopped being the pin on October 18; the later re-pins had not updated this page.

### 2026-10-29: The cost tools refuse more inputs

The section on cutting a preregistered run's cost now says `reuse-check.ts` also refuses an import git cannot resolve (an
installed package is compared by its pinned `package.json` version) and wants the budget run id and the arm each as a
whole word. It says `arm_power.py` sizes single-repeat runs only and takes each world's files in one `--world`.

### 2026-10-28: Cut the cost of a preregistered run

A new section names the two cost tools for Cat 40 confirmations, `reuse-check.ts` (reuse an arm that doesn't load
gbrain) and `arm_power.py` (size an arm by simulation), and what a preregistration must declare before using them
([audit](../docs/audit/2026-10-28-eval-cost-audit.md)).

### 2026-10-11: The opening names the current pin

gbrain-evals v0.10.76. The gbrain under test is named as master `77cf8e111` (v0.60.169.0). The page still named
`739e5cc` (v0.60.46.0), the pin until October 6 ([re-pin report](../docs/benchmarks/2026-10-11-wave14-repin.md)).

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
