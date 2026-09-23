# Situation-aware recall: evaluation protocol, 2026-09-23

This is an implementation and measurement protocol, not a benchmark result. It tests whether optional situation cues help [gbrain](https://github.com/garrytan/gbrain) find an old constraint when today's question uses different words. No live Cat36 capability scores, measured improvement, or all-category no-regression result are published here. The feature remains experimental and off by default.

gbrain keeps original notes as Markdown and builds an index for search and relationships. A situation cue is generated retrieval metadata that points back to an original passage. It can help find that passage, but it is not evidence for an answer. This separation is inspired by [T-Mem](https://arxiv.org/abs/2606.15405); this protocol does not reproduce or adopt that paper's reported scores.

## The concrete question

**Invented example:** a note says, “Our team cannot take calls before ten.” A later request asks an assistant to prepare an early planning session without mentioning the old rule. Retrieval succeeds only if it returns the original scheduling constraint. A generated phrase such as “choosing a morning meeting time” can help locate the note, but cannot replace it as the cited evidence.

The negative counterpart is an unrelated planning request for a different team. An association that sounds plausible is not enough. The experiment separately counts cases where the new cue arm fires without a relevant association.

## Corpus and primary measurement

The versioned corpus contract is [associative-recall-v1](../../eval/data/associative-recall-v1/), validated by [cat36-corpus.ts](../../eval/runner/cat36-corpus.ts). Its five domains are constraints, preferences, commitments, changing decisions, and causal context. A scenario family contains a related source history and four probes: two indirect questions, one direct-recall control, and one negative question. Related variants remain in the same split.

| Split | Independent families | Indirect positives | Direct controls | Negatives | Total probes |
|---|---:|---:|---:|---:|---:|
| Development | 40 | 80 | 40 | 40 | 160 |
| Holdout | 80 | 160 | 80 | 80 | 320 |
| Total | 120 | 240 | 120 | 120 | 480 |

Each domain has eight development and sixteen holdout families. The corpus includes distractors, questions requiring multiple passages, corrections, source collisions, and unavailable evidence. These are fictional fixtures, not personal notes. The initial corpus still requires independent relevance and source/query-leakage review. File hashes and a family split are necessary for reproducibility, but do not establish that the relevance labels are good. Do not tune on holdout or publish capability results before review approval is bound to the exact corpus hashes.

The primary metric is `all_evidence_in_top5_chunks`: an answerable probe scores one only when **every required original source span is covered by the five chunks actually returned by production retrieval**. A chunk is a stored section of an original page. Finding the correct page but the wrong section scores zero. Two returned fragments can jointly cover a required span if their verified source ranges leave no gap.

[cat36-scorer.ts](../../eval/runner/cat36-scorer.ts) matches stable fixture source IDs, slugs, and span IDs against original text and offsets. Text normalization is versioned as `nfc-lf-v1`. Numeric database IDs are recorded for validation, not used to join separate runs. A same-slug page from another source cannot earn credit. Ambiguous repeated text without a verified range cannot silently earn span credit.

The runner requests five raw production chunks, preserves their order and token budget, and rejects an oversized response. It does not use the general adapter's `limit * 3` fetch, collapse pages, then refill five results. Only after that cutoff does it derive secondary page-level scores.

| Measurement | Denominator and interpretation |
|---|---|
| `all_evidence_in_top5_chunks` | Answerable probes only. The preregistered improvement decision uses the 160 held-out indirect probes, clustered into 80 families. |
| `page_recall_at5` | Fraction of required source-qualified pages found among the returned chunks. This is weaker than exact span coverage. |
| `page_precision_at5` | Relevant unique pages divided by five, even when fewer than five are returned. |
| `page_mrr`, `page_ndcg_at5` | Secondary page-ranking measures using the same already-truncated results. |
| `associative_false_fire` | Negative probes on which at least one cue-derived candidate was admitted. Ordinary baseline search returning a document is not, by itself, a cue false fire. |
| `negative_result_count` | Number of final chunks returned for negative probes, reported separately from cue admission. |
| `returned_evidence_tokens` | Sum of the current `ceil(text.length / 4)` estimate over returned original chunks, not a provider tokenizer count. |
| `safety_violations` | Returned evidence from private, withdrawn, or unknown fixture sources. Required ceiling: zero. |

No-gold negative rows use a tagged not-applicable primary value. They are excluded from positive recall means, not assigned fabricated zero recall. Reports retain direct, indirect, negative, domain, and multiple-evidence breakdowns. Answer accuracy and grounding require a separately identified answer/judge experiment; these retrieval metrics are not answer accuracy.

## Comparisons and construction boundary

| Arm | Product and intervention |
|---|---|
| B | Fresh current-product baseline, cues off. |
| C0 | Candidate product, cues off. This detects implementation drift. |
| C1 | The same candidate, with production Scene and Horizon cue generation and recall enabled. |
| `scene` | Read only descriptive cues from the same frozen C1 index, without regenerating it. |
| `horizon` | Read only forward-looking cues from the same frozen C1 index, without regenerating it. |
| `scene-horizon-bridge` | Fresh isolated Scene/Horizon construction with experimental bridges enabled, never appended to C1. |
| `summary` | Real existing contextual-summary generation, with matched enrichment budget where feasible. |

The historical pinned product and old reports remain historical context, not substitutes for a fresh B run. Compare C0 with B, and C1 with both C0 and B, on matching sources, queries, models, dimensions, reranking, token limits, and frozen settings. Keep any unavoidable cost or token difference visible.

The runtime builder receives only pre-cutoff source content, source identity, visibility, and timestamps. It does not receive probe text, relevance labels, family roles, future turns, or gold spans. A source-only build receipt is frozen before queries are exposed to the search runtime. This is an explicit input boundary, not a claim that an arbitrary process cannot read files from the repository.

Live capability arms must use production import, generated cues, real embeddings, and the exported retrieval path. Receipts must show actual generation and read-arm observations. Requesting a setting without generating a usable index or attempting the recall arm is unexercised, not a successful capability run. An observed, functioning arm that finds no relevant cue is a measured outcome. The summary control must run the real background summary path; Cat26's inline title fallback is not an equal-budget enrichment control.

**Current integration boundary:** [cat36-production.ts](../../eval/runner/cat36-production.ts) uses public production import, durable cue construction, raw search, and real per-chunk synopsis services. The declared dependency now pins candidate `ca314d8af825308190cbe13dd08949d564a994a3` (v0.54.0.0), not the historical dependency that predates these exports. A separate clean consumer installed that archive from the frozen lockfile, without `bun link`, and imported both new public modules. Candidate-only tests exercise the paths with explicit provider stubs; they do not establish semantic quality. Missing support still blocks the corresponding live cell rather than substituting handcrafted cues or title summaries.

Fixture source IDs remain the cross-run evidence identity. The adapter maps each one to a distinct valid product source ID using `c36-` plus 28 SHA-256 hex characters, records both IDs in `build.json`, and maps raw chunks back for scoring. It does not merge sources to fit an enrollment bound or let a namesake earn another source's span. Only public fixture sources are enrolled for cue generation; private and withdrawn pages remain unavailable retrieval controls.

Live construction saves a closed, content-hashed PGLite snapshot under the run's `runtime/frozen-db/` before exposing queries. Scene/Horizon profiles must supply `reuse_build_dir` pointing to a complete C1 run and omit a new `build_max_usd`. They verify the same source/product/model/settings identities, copy that frozen database to a fresh private database, disable generation, and change only the read-family selection. Their query calls still need their own external provider allowance. C1 and the Bridge experiment must start with an empty cue index; the latter has a separate build and budget. Failed or partial live construction keeps its artifacts for inspection.

## Release decision, without averaging away losses

The approved target is at least a 10-percentage-point C1-over-B gain in held-out indirect `all_evidence_in_top5_chunks`, with the family-clustered 95% interval above zero. Freeze the primary encoder, thresholds, weights, prompts, budgets, and repetition plan before holdout. The sample size may still yield an inconclusive result; it is not a power guarantee.

Every preregistered existing category and slice must be non-worse in its metric's correct direction, retain native floors, and preserve critical known-correct cases. **Allowed observed decline is zero.** A gain elsewhere cannot compensate for a losing category. Uncertainty that includes a decline is inconclusive, not proof of no regression. Preserve SUT failures as misses and typed dependency, harness, or judge failures as errors; an incomplete comparison cannot satisfy the release gate.

A broader retrieval-improvement claim also requires a statistically supported win in at least one preregistered existing opportunity: Cat13, Cat13b, Cat26, or LongMemEval. The opportunity family uses Holm correction for multiple comparisons. A Cat36-only win supports, at most, a narrower associative-retrieval finding and does not authorize the broad claim or promotion.

The [category inventory](../../eval/regression/situation-recall-v1.json) covers actual Cats1–15 and 18–35, suffix categories13b/18b, Cat36, and applicable standalone retrieval suites. It records the absence of Cat16/17 rather than inventing runners. Cats5/8/9 need explicit real input catalogs through their existing programmatic functions. Cat34's official keyless memory tests remain distinct from a budgeted live associative-delivery replay. Cat35 needs its full release profile, not its default two-transcript smoke.

[situation-recall-regression.ts](../../eval/runner/situation-recall-regression.ts) requires a frozen registration and complete matched per-probe receipts. It rejects missing, duplicate, stale, partial, skipped, nonpublishable, or wrong-product cells, and a nonzero child exit cannot be excused by a pass receipt. Unsupported required profiles remain blocked, including a verified current NamedThingBench runner that is not yet registered in this eval checkout. The inventory is not itself a completed run manifest. Generic category receipts also do not automatically supply the stricter regression payload.

The orchestration API additionally requires isolated per-cell eval/product checkouts, HOME, configuration, database, and output paths, plus provider-budget enforcement for paid profiles. Readiness is checked before paid admission. Its strict category drivers and budget authority must be provided by the release operator; there is no ready-made CLI that turns the inventory into an authorized full sweep.

### A bounded existing-benchmark pilot

[situation-recall-cat13b.ts](../../eval/runner/situation-recall-cat13b.ts) adds a separate B/C0/C1 pilot over Cat13b's committed 20-page source-swamp corpus and 30 queries. It calls the existing scorer and retains the native gbrain adapter's 30-chunk request, five-page output, and 80% top-1 floor. That page-based protocol is deliberately different from Cat36's raw-five-chunk primary. In C1, the pilot builds production cues from the imported sources before the scorer receives queries and requires actual cue-arm observations.

The pilot is not full Cat13b release coverage: it runs the gbrain cohort, not all historical comparison adapters. Its receipt also discloses the native automatic recency behavior, an unfrozen wall clock, and the absence of a pilot-level embedding cache. Each B/C0/C1 profile needs the historical balanced `token_budget: 12000`, exact product identity, matching search settings, and its own externally enforced provider allowance. These are different profile files from Cat36's 4,096-token example.

```sh
# Validation only, no providers. A validated pilot is not a passing benchmark.
bun eval/runner/situation-recall-cat13b.ts \
  --profile /absolute/path/to/approved-cat13b-profile.json \
  --output /absolute/path/to/new-validation-output

# Only after explicit provider budget approval and verified hard limits:
bun eval/runner/situation-recall-cat13b.ts \
  --profile /absolute/path/to/approved-cat13b-profile.json \
  --output /absolute/path/to/new-live-output --execute
```

An initial six-cell pilot can compare B/C0/C1 on Cat36's 160 development probes and this 30-query cohort, without exposing holdout. It is a development diagnostic, not a substitute for repeated held-out comparisons, all required categories, ablations, or the corrected existing-benchmark improvement gate. A timeout or limited query count does not enforce a dollar cap, and Cat36 smoke still constructs all 277 source pages.

## Reproduce the keyless checks

Run these commands from the repository root. They do not establish model quality:

```sh
bun install --frozen-lockfile
bun run eval:cat36:smoke
bun run eval:cat36
bun test test/eval/cat36-associative-retrieval.test.ts \
  test/eval/cat36-grounded-answers.test.ts \
  test/eval/cat36-operation-conformance.test.ts \
  test/eval/situation-recall-programmatic.test.ts \
  test/eval/situation-recall-regression.test.ts
```

`eval:cat36:smoke` runs one development family's four probes. `eval:cat36` runs the 160 development probes. Both explicitly select offline keyword plumbing, use production import/search without live providers, and write nonpublishable receipts. The smoke still constructs the source corpus; it does not mean only four source pages are imported. CI bounds its smoke subprocess to 180 seconds. No paid time or cost has been measured for this protocol.

For a chosen new output directory:

```sh
bun eval/runner/cat36-associative-retrieval.ts \
  --offline --smoke --output eval/reports/cat36-associative-retrieval/my-offline-check
```

Use a new directory each time. The default is `eval/reports/cat36-associative-retrieval/<timestamp>-<pid>/`. Inspect `build.json`, `probes.ndjson`, and `receipt.json`; keep all three together. `build.json` includes resolved settings and source-to-engine mappings. Probe rows retain returned original chunks, source identities, cue observations, and failures. A plumbing receipt can have `verdict: pass` while `publishable: false`; that is not a live release pass.

The `all.ts` sweep adds Cat36 as an explicitly named offline smoke with a fresh output directory. Its other category entries keep their existing behavior, including paid defaults. **Do not run the whole sweep as a supposedly keyless Cat36 check.** The legacy aggregate is not the stricter all-category release gate.

Inspect required coverage without running benchmarks:

```sh
bun eval/runner/situation-recall-regression.ts inventory
```

Exit 2 with listed blockers is expected while required prerequisites are unavailable. Do not hide a blocker by dropping its category.

## Prepare an authorized live run

Do not start this phase until the corpus review, public runtime integration, explicit budget, credentials, and exact baseline/candidate identities are ready. The commands below describe execution of an already approved profile, not approval to spend.

[Cat36Profile](../../eval/runner/cat36-associative-retrieval.ts) requires these settings:

| Field | Required choice |
|---|---|
| `id`, `mode`, `arm`, `split` | Unique profile ID; `live`; a named comparison arm; `dev` or frozen `holdout`. |
| `expected_product_sha` | Full 40-character product commit SHA. Record the eval commit too. |
| `expected_package_sha256` | Verified content hash for an archive installation, whose package directory has no product Git metadata. Do not infer the loaded commit solely from `package.json`. |
| `embedding_model`, `embedding_dimensions` | Explicit provider-qualified encoder and dimensions. Match paired arms. |
| `token_budget`, `cue_weight` | Fixed output budget and bounded cue weight. Freeze before holdout. |
| `cue_min_similarity` | Explicit encoder-calibrated cosine threshold for cue-enabled arms. There is no portable threshold recommendation here. |
| `generation_model`, `build_max_usd` | Required for cue/summary construction; provider-qualified model and positive build allowance no larger than the approved provider cap. |
| `reuse_build_dir` | Required only for Scene/Horizon read-time ablations. Reuse verified C1 construction, name its original generation model, and omit a new build allowance. |
| `expansion_model` | Explicit model required for live native `query` conformance. Raw expansion-enabled quality profiles currently block before paid work because the public expander cannot distinguish a successful no-op from a swallowed provider failure. |
| `provider_budget` | `{ "kind": "isolated-provider-cap", "approval_id": "<real approval reference>", "max_usd": <approved amount> }`. This records an externally enforced allowance, not a budget created by writing JSON. |
| `search_config` | Explicit string values for `search.mode`, `search.reranker.enabled`, `search.reranker.model`, `search.expansion`, `search.autocut`, `search.cache.enabled`, `search.adaptive_return`, `search.contextual_retrieval`, and `search.recency_boost`. |

Configure only the approved providers through your secret manager. The selected encoder needs its provider key; cue/summary generation needs its selected model's key; reranking needs the configured reranker's key. Never save key values in profiles or receipts. The budget must cover construction, embeddings, reranking, judging, and agent subcalls where applicable. Neither `BRAINBENCH_N` nor the LLM semaphore is a global spending cap.

The cue build's `build_max_usd` is passed to the product's durable lifetime owner and is shared across its bounded passes. The summary service has no equivalent public durable-build cap, so its profile must set an external whole-cell ceiling equal to `build_max_usd` and explicitly select `search.contextual_retrieval: "per_chunk_synopsis"`. That external ceiling includes import and query work too; it is not a separate local synopsis meter or a claim of exactly equal realized spend. The runner rejects title fallback and records actual per-page generation outcomes. Timeouts bound waiting, not dollars.

Inspect a verified installation against the preregistered identity before execution. For example, with `EXPECTED_PRODUCT_SHA` and, for an archive, `EXPECTED_PACKAGE_SHA256` already set to the independently verified values:

```sh
bun -e 'import { resolveRegressionProduct } from "./eval/runner/situation-recall-provenance.ts";
console.log(JSON.stringify(resolveRegressionProduct({
  expectedProductSha: process.env.EXPECTED_PRODUCT_SHA,
  expectedPackageSha256: process.env.EXPECTED_PACKAGE_SHA256
}), null, 2));'
```

The code identities for this change are explicit:

| Identity | Product revision | Role |
|---|---|---|
| Historical H | `2efaaf8f8a817b5b82e023383618fdcdb1cc5f7d` | The previous declared dependency and preserved historical measurements. |
| Fresh baseline B | `b272cf23464007a3d9fdd9daaef93e76e2651546` | Current-product baseline before this feature; live measurements remain pending. |
| Declared candidate C0/C1 | `ca314d8af825308190cbe13dd08949d564a994a3`, v0.54.0.0 | Candidate-off/on comparison, linked to [product PR #5374](https://github.com/garrytan/gbrain/pull/5374). |

On September 23, a separate clean consumer ran `bun install --frozen-lockfile --ignore-scripts`, followed only by the inspected PGLite asset-link helper. The installed package was a normal archive directory, not a local link; its `regressionPackageHash` was `ad34debb686dfbe0f6276651a8eeedd492d7c75bad0433e6a91e3be185fde228`, and both `gbrain/memory-cues` and `gbrain/contextual-retrieval` imported successfully. This is package plumbing evidence, not a paid quality measurement. Earlier WIP snapshots are not the final pin and cannot supply release receipts.

On supported Bun 1.3.13, the final hermetic consumer suite passed 1,773 tests with no failures or skips, including identity fixture liveness and rejected-capture receipt preservation. All eight keyless CI runner commands also completed. These checks validate the harness and deterministic contracts; they are not live B/C0/C1 quality comparisons. Project-file and script type gates pass under the existing CI policy; raw repository typechecking still reports diagnostics inside the installed dependency.

The shared identity check separately records the resolved package path/version, available commit/tree and dirty state, and verified package content hash. It checks `GBRAIN_SRC` and `GBRAIN_REPO` bindings against that package. A local `bun link` must not silently change which product an arm runs. The final release gate still needs complete live measurements at these exact registered identities.

After authoring and approving the profile, run it directly rather than appending it to an offline package script:

```sh
bun eval/runner/cat36-associative-retrieval.ts \
  --profile /absolute/path/to/approved-C1-dev.json \
  --output /absolute/path/to/new-C1-dev-output
```

Use separate fresh outputs and databases for B, C0, C1, and every ablation. The live runtime uses a local embedding cache under `eval/reports/cat36-associative-retrieval/embed-cache/`, backed by the existing cache module and real provider transport. Its identity includes source content, encoder, dimensions, construction/context mode, and generation model; individual entries distinguish input side. B and C0 can reuse unchanged off-arm embeddings. Different construction arms have separate cache namespaces, so a candidate cue artifact cannot silently warm the baseline.

A fresh clone has no warm cache. Build and query observations record cache hit/miss information. Cache hits avoid only the corresponding embedding call: repeated generation, reranking, judging, and other uncached provider work can still cost money. Do not compare a development smoke with full holdout, or a different model/configuration with the frozen primary. A full holdout run omits `--smoke` and uses `split: "holdout"` in its approved profile.

## Replay grounded answers as a separate secondary check

[cat36-grounded-answers.ts](../../eval/runner/cat36-grounded-answers.ts) asks whether an answer is supported by the original evidence that retrieval actually returned. It consumes an existing run's immutable `receipt.json`, `build.json`, and `probes.ndjson`, and loads questions from the matching frozen corpus. It verifies hashes, source history, probe identity, and split before execution. It does not rerun retrieval, fetch more text, or replace `all_evidence_in_top5_chunks` with an answer judge's opinion.

Validate the inputs without any provider calls or new output files:

```sh
bun eval/runner/cat36-grounded-answers.ts \
  --input /absolute/path/to/existing-C1-dev-output
```

The default is validation only. It accepts a complete offline plumbing receipt for checking the replay contract, but live answer execution requires a production live retrieval receipt. Tests can inject answer and judge clients; their results are always nonpublishable.

The answer generator receives only the question and the actually returned, source-qualified original excerpts. It receives no relevance labels, tags, required span IDs, cue prose, or other text from the full source pages. Private, withdrawn, unknown, or altered excerpts are rejected before generation. The separate judge receives the required original evidence and the answer; negative probes instead use an explicit insufficient-evidence rubric. A positive answer cannot earn secondary success if any required evidence was absent from the returned chunks, even when the answer sounds correct.

Prepare and approve a separate [`GroundedProfile`](../../eval/runner/cat36-grounded-answers.ts):

| Field | Required choice |
|---|---|
| `mode` | `live` for CLI execution. |
| `answer_model` | An explicit `openai:`, `anthropic:`, or `google:` chat model supported by the public gateway. |
| `judge_model` | `claude-haiku-4-5-20251001`, the snapshot supported by the shared judge helper's pricing assumptions. |
| `answer_max_tokens`, `judge_max_tokens` | Separate integer output limits from 1 to 4096. They are not dollar limits. |
| `expected_product_sha`, `expected_package_sha256` | Exact loaded product identity matching the retrieval build; the package hash is required for archive installs. |
| `answer_budget`, `judge_budget` | Separate `{ "kind": "isolated-provider-cap", "approval_id": "<real approval reference>", "max_usd": <approved amount> }` records. Configure the external enforcement before execution. |

Use only the chosen answer provider's key and `ANTHROPIC_API_KEY` for judging. The driver checks the loaded product and ambient `GBRAIN_SRC`/`GBRAIN_REPO` bindings before removing ambient settings. Before importing the product gateway, it creates fresh HOME, gbrain configuration, XDG, and database paths under the new output's `runtime/` directory. It preserves only `PATH`, `LANG`, `TZ`, and the approved answer/judge keys. Other credentials, `DATABASE_URL`, and ambient `GBRAIN_*` settings are removed for the run. The receipt records paths and approved key names, never key values. The replay opens no retrieval database; the fresh database path also keeps gateway side effects away from an existing brain. The caller's environment is restored on exit. Run parallel replays in separate processes, not concurrent calls sharing one environment.

Only after approval and external budget enforcement are in place, explicitly confirm both approved amounts on the command line:

```sh
bun eval/runner/cat36-grounded-answers.ts \
  --execute \
  --input /absolute/path/to/existing-C1-dev-output \
  --profile /absolute/path/to/approved-grounded-profile.json \
  --output /absolute/path/to/new-grounded-output \
  --answer-max-usd "$APPROVED_ANSWER_MAX_USD" \
  --judge-max-usd "$APPROVED_JUDGE_MAX_USD"
```

Each amount must match its approved profile cap. These are operator attestations of externally enforced allowances, not a local dollar meter. Local provider readiness checks verify configuration and credentials are present; they do not make a paid request to prove that a credential or model will work. The answer lane records gateway model identity, response blocks, and token usage without inventing a dollar estimate. The judge lane preserves every raw response, retry, parsed score, and the shared helper's cost estimate. Usage may be unavailable for failed calls, so these records are not a complete billing ledger.

Keep the new `admission.json`, `answers.ndjson`, `receipt.json`, and recorded runtime namespace separate from the retrieval run. The new receipt category is `cat36-grounded-answers`, and its hashes identify the unchanged primary artifacts. Its `answer_success` mean includes positive and negative probes: a success requires full rubric scores and a normally completed answer, plus exact returned evidence coverage for positives. SUT answer failures count as misses. Judge failures are excluded, recorded, and subject to `ProbeAccounting`; an incomplete replay is nonpublishable. A failed but complete measurement is not hidden. Publication also requires that the primary receipt is publishable, including independent corpus review. No live grounded-answer result, provider cost, or timing measurement is published in this protocol.

## Retain LongMemEval evidence before answer replay

The existing LongMemEval runner remains a retrieval benchmark. Its opt-in `--retain-evidence` records the original returned chunks, verified source offsets/hashes, retrieval settings, and observed code identity in fresh NDJSON output. Default retrieval rows and formulas are unchanged. Historical ID-only rows cannot be upgraded by fetching whole sessions after the fact.

Capture is itself a retrieval run, not validation. Only after the dataset, credentials and externally enforced provider allowance are approved, use all required fresh paths:

```sh
bun eval/runner/longmemeval.ts \
  --path /absolute/path/to/longmemeval_s.json \
  --adapters hybrid --top-k 5 \
  --embedding-model openai:text-embedding-3-large --embedding-dims 1536 \
  --retain-evidence \
  --ndjson /absolute/path/to/new-run/retained.ndjson \
  --output /absolute/path/to/new-run/results.json \
  --reports-dir /absolute/path/to/new-run/reports
```

The NDJSON, `.json` output, derived `.md` output and `reports/longmemeval/receipt.json` must all be distinct and absent before the run. Retained-evidence capture is not resumable into old files. A rejected capture preserves an existing receipt rather than replacing it with an error receipt; the nonzero exit and diagnostic still record the failure.

[longmemeval-answers.ts](../../eval/runner/longmemeval-answers.ts) validates those new artifacts against the exact dataset and then offers a separate answer-grounding replay:

```sh
bun eval/runner/longmemeval-answers.ts \
  --dataset /absolute/path/to/longmemeval_s.json \
  --rows /absolute/path/to/retained.ndjson \
  --receipt /absolute/path/to/retrieval-receipt.json \
  --adapter hybrid
```

This command only validates. Paid execution additionally needs `--execute --profile <approved-LmeAnswerProfile.json> --output <new-dir>` and matching `--answer-max-usd`/`--judge-max-usd` confirmations of the separate external allowances. The profile pins dataset, raw-row, source-manifest and retrieval-config hashes as well as model identities. The generator sees only the question and selected original excerpts. Session-diversity adapters contribute only the first returned chunk for each already-selected session, not an expanded full conversation.

The replay retains original answers, usage, judge responses and retries. It is a **secondary shared-judge grounding check**, not official LongMemEval answer accuracy: this checkout lacks the upstream evaluator and full dataset, and the protocol does not silently substitute an internal scorer with different rules. The reference answer is judge-only material, never evidence sent to answer generation. Missing data, legacy rows, unverified model identity, excluded judge errors, or missing external caps remain blocking prerequisites.

## Check native search, query, and recall protocols separately

[cat36-operation-conformance.ts](../../eval/runner/cat36-operation-conformance.ts) replays the native `search`, `query`, and `recall` operations through the same production runtime. It freezes a source-only build before exposing probes, preserves the complete native JSON response, and does not truncate or remap it to five chunks. It does not compute the raw-five primary or score answer quality. Live `query` retains its native expansion behavior; offline `query` explicitly disables expansion to remain keyless.

```sh
bun eval/runner/cat36-operation-conformance.ts --offline --smoke
bun eval/runner/cat36-operation-conformance.ts \
  --offline --smoke --surfaces search,query
```

The default smoke makes twelve calls: four development probes through all three surfaces. The explicit two-surface diagnostic makes eight and cannot stand in for full three-surface coverage. The runner declares all requested operations before the build, so an unsupported operation or parameter contract blocks before paid source import. Whether legacy `recall` is available is detected from the loaded package, not assumed from its version label.

Outputs go to a new `eval/reports/cat36-operation-conformance/<timestamp>-<pid>/` directory, or a fresh explicit `--output`. Keep `build.json`, `operations.ndjson`, and `receipt.json`. The rows preserve failing responses as well as successful ones. Offline and injected-runtime results are nonpublishable. A live conformance replay accepts the same explicit approved `--profile` contract; this is a separate profile, not a substitute for retrieval-quality evidence.

Serialization checks reject explicit cue-prose fields, configured cue-only sentinel strings, private/withdrawn/unknown source references, ambiguous unqualified same-slug references, and `chunk_text` that is not original source text. They also detect complete private-only fixture passages copied into unqualified text. Safe cue counts/status metadata is allowed. These checks do not establish that every possible paraphrase or arbitrary native field is free of generated prose, and there is no answer judge here. Keep the product's own serialization/security tests and separately measured delivery gates; do not relabel this conformance pass as universal privacy or grounding proof.

For Cats5/8/9, validate a separately reviewed real catalog without spending:

```sh
bun eval/runner/situation-recall-programmatic.ts \
  --category cat5 --input /absolute/path/to/reviewed-claims.json \
  --output /absolute/path/to/new-cat5-validation
```

This validation-only command exits 2 because it did not execute a category. The driver rejects the committed example-only gold as a runtime catalog. Its `--help` describes the page/claim/probe/scenario contract and live authorization flags. Cats8/9 use real adapter state with cues off; Cat5 does not retrieve. Their native baseline-only verdicts cannot satisfy the full calibrated release gate.

Real programmatic execution uses fresh HOME/config/database paths, strips ambient source/database/provider settings, and retains only the approved Anthropic credential for its agent/judge calls. It records that namespace and restores the caller's environment afterward. An orchestrator may explicitly supply absolute paths through `--home`, `--config`, and `--database` together: configuration must be `<home>/.gbrain/config.json`, while home and database must not overlap. The driver verifies the product's actual resolver, not merely an environment-variable echo. Ambient `GBRAIN_*` paths are not implicitly trusted.

Once every strict cell has been executed and collected under a frozen `RegressionManifest`, compare the saved results:

```sh
bun eval/runner/situation-recall-regression.ts compare \
  /absolute/path/to/frozen-run-manifest.json \
  /absolute/path/to/collected-cell-results.json \
  > /absolute/path/to/new-comparison.json
```

Exit 0 means the complete registered decision passed, 1 means a regression, and 2 means blocked or inconclusive. Inspect the per-profile coverage and paired wins/losses, not just the exit code. A raw Cat36 receipt is not the complete all-category result file.

### Collect retained native observations

The native collector supports Cats2/4/6/18/18b/24/35. Give it the frozen [`RegressionProfile`](../../eval/runner/situation-recall-contract.ts) and the original native artifact, not a hand-written aggregate:

```sh
bun eval/runner/situation-recall-regression.ts collect \
  /absolute/path/to/frozen-category-profile.json \
  /absolute/path/to/native-artifact.json
```

It reconstructs stable per-item observations and native pooled denominators without changing the source artifact. Output always includes `release_eligible: false`: successful collection is not promotion. The final comparator still needs verified provenance, successful child termination, all required cells, matched identities and passing paired gates.

### Exercise separate associative development recipes

[`situation-recall-associative.ts`](../../eval/runner/situation-recall-associative.ts) supplies separate Cat22/23/27/34 development replays. Its `AssociativeProfile` names the category, a nested Cat36-style `sut` profile, and `fixture_review` with a reviewer and exact recipe hash. Every Cat34 profile requires `delivery_surface`; the supported value is `public-volunteer-context`. Cat34 C1 also requires an explicit `push_min_similarity`, including when only validating the profile. The replay uses only fixed development histories and retains native compatibility coverage separately.

```sh
bun eval/runner/situation-recall-associative.ts \
  --profile /absolute/path/to/associative-profile.json \
  --output /absolute/path/to/new-validation-output \
  --corpus eval/data/associative-recall-v1
```

The default validates without providers. Live execution additionally requires `--live --allow-paid`, ready credentials and an externally enforced allowance in the nested profile. Publication requires independent corpus approval and converted-recipe approval bound to its hash. Missing source attribution in the two Cat22 traversal cases remains blocked; attributable `getLinks` controls do not fill that gap. Cat34's `public-volunteer-context` surface does not establish IPC, harness-hook, OpenClaw, writeback or continuity coverage. Unsupported requested surfaces are explicit blockers, not empty passing responses.

## What remains before a recommendation

Independent corpus review, a supported profile for every required category, authorized live runs at exact product identities, and complete paired receipts remain prerequisites. Packaged-install and hermetic checks do not replace them. Real answer grounding and proactive memory delivery require their own measurements. No claim about privacy, retention, latency, or reminder quality follows from a keyword plumbing pass.

Keep failed and partial outputs. Before publishing real measurements, copy worthwhile raw artifacts out of ignored `eval/reports/` into a dated public-safe location, include model/configuration and code identities, and then add their actual hashes to the artifact manifest. This protocol does not add placeholder receipts or alter historical scores, prompts, labels, or charts.
