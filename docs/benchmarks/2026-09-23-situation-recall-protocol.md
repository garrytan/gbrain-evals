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

**Current integration boundary:** [cat36-production.ts](../../eval/runner/cat36-production.ts) uses public production import, durable cue construction, raw search, and real per-chunk synopsis services. The declared dependency now pins candidate `f3249d1703772573006141224a4d06d9b8df7b41` (v0.55.0.0), integrating upstream `31f257a0a7b218b40e03d302bc6913c99f26f0ec` (v0.54.1.1). The code-identity section preserves earlier candidate/baseline pairings rather than assigning their evidence to this revision. Candidate-only tests exercise the paths with explicit provider stubs; they do not establish semantic quality. Missing support still blocks the corresponding live cell rather than substituting handcrafted cues or title summaries.

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

For publishable comparisons, do not start this phase until the corpus review, public runtime integration, explicit budget, credentials, and exact baseline/candidate identities are ready. The commands below describe execution of an already approved profile, not approval to spend. The narrower development-only pilot below does not require completion of the 49-profile release gate.

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
| `provider_chat_options` | Optional, narrowly validated non-thinking options for an allowlisted OpenRouter model. Required for the operator-authorized development variant below; request-field overrides are forbidden. |
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
| Integrated upstream base | `31f257a0a7b218b40e03d302bc6913c99f26f0ec`, v0.54.1.1 | Upstream code merged into f324; this identity is not a new benchmark measurement. |
| Declared candidate C0/C1 | `f3249d1703772573006141224a4d06d9b8df7b41`, v0.55.0.0 | Published v4 source-reference checkpoint, linked to [product PR #5374](https://github.com/garrytan/gbrain/pull/5374). |
| Earlier registered baseline B | `6040075c6cb95be5881cc2e1b76ef7d71f4e5d29`, v0.54.1.0 | Baseline paired with the earlier 470 candidate; its evidence is not relabeled. |
| Earlier candidate checkpoint | `470ccc49c33b44c4a4be4e60bc606c0ad04a4427`, v0.55.0.0 | The preserved Git-install and hermetic evidence below belongs to this checkpoint. |
| Earlier refreshed baseline | `c008902313b334b8a827dd9046b704d090d0197e`, v0.53.0.0 | Baseline associated with the preserved e51 verification below. |
| Earlier refreshed candidate | `e51e21c076dd63e6e5948303eb2c355ddba21da4`, v0.54.0.0 | The earlier clean Git-package evidence below remains attached to this revision. |
| Intermediate archive checkpoint | `0ccb47ba5e6b7058a5aeeedf590753268d931276`, v0.55.0.0 | Separately verified archive before the format-only parser fix; not the current declared pin. |
| Earlier baseline reference | `b272cf23464007a3d9fdd9daaef93e76e2651546` | Baseline reference before the master refresh; no live score is reassigned to the new baseline. |
| Earlier candidate verification | `ca314d8af825308190cbe13dd08949d564a994a3`, v0.54.0.0 | The dated clean-package and hermetic evidence below applies to this earlier candidate. |

### Earlier verification before the master refresh

The following September 23 evidence belongs to `ca314d8`, not the refreshed candidate. It remains historical plumbing evidence rather than being relabeled as a new run.

On September 23, a separate clean consumer ran `bun install --frozen-lockfile --ignore-scripts`, followed only by the inspected PGLite asset-link helper. The installed package was a normal archive directory, not a local link; its `regressionPackageHash` was `ad34debb686dfbe0f6276651a8eeedd492d7c75bad0433e6a91e3be185fde228`, and both `gbrain/memory-cues` and `gbrain/contextual-retrieval` imported successfully. This is package plumbing evidence, not a paid quality measurement. Earlier WIP snapshots are not the final pin and cannot supply release receipts.

On supported Bun 1.3.13, the final hermetic consumer suite passed 1,773 tests with no failures or skips, including identity fixture liveness and rejected-capture receipt preservation. All eight keyless CI runner commands also completed. These checks validate the harness and deterministic contracts; they are not live B/C0/C1 quality comparisons. Project-file and script type gates pass under the existing CI policy; raw repository typechecking still reports diagnostics inside the installed dependency.

### Earlier e51 refresh verification

After integrating master `c0089023`, a new clean Bun 1.3.13 consumer installed `e51e21c` with `--frozen-lockfile --ignore-scripts`, followed only by the inspected PGLite asset-link helper. The archive is not locally linked, reports gbrain v0.54.0.0, and imports both public feature modules. Its independently computed `regressionPackageHash` is `dd91c8739cb72b3435196671e65c29c33c133fb5967054822746d2db87e2230e`. The fresh schema initializes through version 165, preserving the shared-skills migration at 164. This verification is separate from the earlier archive and does not establish a live retrieval gain or no-regression result.

The refreshed package passed 1,773 hermetic tests across 87 files, with no failures or skips, on Bun 1.3.13. All eight keyless CI runner commands completed, and the unchanged keyword guard retained Jaccard 1.0000 and top-1 1.0000. Data, documentation and redacted diff secret checks passed. Project-file and script type gates passed under the existing CI policy; raw repository typechecking reported 45 diagnostics inside the installed dependency and none in project files. No paid call was made for this refresh.

### Published 470 Git-package verification

On September 24, a new Bun 1.3.13 consumer installed the declared `470ccc49` dependency directly with `bun install --frozen-lockfile --ignore-scripts`, followed only by the inspected PGLite asset-link helper. This was not an archive replacement or `bun link`. The loaded package reports v0.55.0.0, imports both feature modules, and has `regressionPackageHash` `b302290974571ae846e26587cd37ecf6299b74c3bfe0d401aa22935ca3a84c97`.

The earlier immutable 470 archive checkpoint has package hash `d8cb6ef017ba85a4ffa3d6194cc42ab2f31557f434c4821adb281efe06d725bb`. Every source-file byte matched; the Git installation adds only Bun's `.bun-tag` metadata. Keep these package identities distinct rather than disabling that check or reusing an archive hash for a Git install. The intermediate 0ccb archive, with hash `bb3177608bff9ccf5949b13eab394637b745a62c4437c2acb4f931b22ba663cf`, remains an earlier checkpoint rather than evidence for the parser-fixed pin.

The clean Git consumer passed 1,822 hermetic tests across 90 files with no failures or skips. All eight keyless CI commands completed, and the keyword guard retained Jaccard and top-1 1.0000. Project and script type gates passed under the existing policy; raw repository typechecking retained 45 installed-dependency diagnostics and none in project files. These are consumer and harness checks with provider credentials removed, not retrieval-gain measurements or a full semantic no-regression result. Source-only v3 positive-path tests use synthetic registered-v3 modules; they do not establish compatibility with a future product build.

### Published f324 v4 Git-package verification

On September 24, a separate clean Bun 1.3.13 consumer installed `f3249d1703772573006141224a4d06d9b8df7b41` directly from the frozen Git dependency, with lifecycle scripts disabled except the inspected PGLite asset-link helper. The normal installed package reports v0.55.0.0 and content hash `7fc21cee0cc08169c2bbbbb05e137b5b26e885beb24fd9f6275808d2cf162e67`. Its registered pipeline is `situation-v4`, and the exact exported system-prompt SHA-256 is `2756e59d6cd2979f248a98b0bdd48547c2893a86130bca9b3807ca8af619d0ad`.

Keyless actual-package integration sends the real formatter's `.content` through the production provider, SDK and closed v2 guard, with the network intercepted and responses explicitly synthetic. A selected evidence reference resolves to the original source quote and position; internal formatter metadata does not become wire input. The actual formatter's tested 8,192-byte escaped and Unicode cases remain within the existing wire cap: control characters produced the largest request, 59,226 bytes. This verifies the formatter/guard interface and bounded serialization, not paid retrieval or model quality. Earlier 470 and 0ccb receipts remain attached to their own code identities.

The clean f324 Git consumer passed 1,847 tests across 91 files with no failures or skips. All eight keyless CI commands completed; keyword Jaccard and top-1 remained 1.0000. Project and script type gates passed under the existing policy, with 45 installed-dependency diagnostics and no project diagnostics in raw repository typechecking. Current-provider fixtures emit numbered evidence references, while the historical v3 prompt fixture retains its original bytes and assertions. These checks do not establish a paid quality result or approve new source-only datasets and drivers.

The shared identity check separately records the resolved package path/version, available commit/tree and dirty state, and verified package content hash. It checks `GBRAIN_SRC` and `GBRAIN_REPO` bindings against that package. A local `bun link` must not silently change which product an arm runs. The final release gate still needs complete live measurements at these exact registered identities.

After authoring and approving the profile, run it directly rather than appending it to an offline package script:

```sh
bun eval/runner/cat36-associative-retrieval.ts \
  --profile /absolute/path/to/approved-C1-dev.json \
  --output /absolute/path/to/new-C1-dev-output
```

Use separate fresh outputs and databases for B, C0, C1, and every ablation. The live runtime uses a local embedding cache under `eval/reports/cat36-associative-retrieval/embed-cache/`, backed by the existing cache module and real provider transport. Its identity includes source content, encoder, dimensions, construction/context mode, and generation model; individual entries distinguish input side. B and C0 can reuse unchanged off-arm embeddings. Different construction arms have separate cache namespaces, so a candidate cue artifact cannot silently warm the baseline.

A fresh clone has no warm cache. Build and query observations record cache hit/miss information. Cache hits avoid only the corresponding embedding call: repeated generation, reranking, judging, and other uncached provider work can still cost money. Do not compare a development smoke with full holdout, or a different model/configuration with the frozen primary. A full holdout run omits `--smoke` and uses `split: "holdout"` in its approved profile.

### OpenRouter development-only pilot

The embedding route is `openrouter:openai/text-embedding-3-large` at 1536 dimensions. The primary pilot generator is `openrouter:anthropic/claude-sonnet-4.6`; the explicit control allowlist also includes `openrouter:qwen/qwen3.7-flash` and `openrouter:openai/gpt-4o-mini`. Freeze the selection after a source-only liveness check using the unchanged production prompt; transport compatibility or an empty cue array does not show useful cue generation. All routes use `OPENROUTER_API_KEY`; a native OpenAI key does not satisfy them. Reranking, expansion, answer generation and judging stay off. The isolated runners preserve the OpenRouter credential only for live execution, discard ambient endpoint overrides, and use the product's public gateway. They do not print or save credentials.

On September 23, the unauthenticated [OpenRouter embedding catalogue](https://openrouter.ai/api/v1/embeddings/models) listed `openai/text-embedding-3-large` at $0.13 per million input tokens. This matches the product's nested embedding-price lookup. The [chat catalogue](https://openrouter.ai/api/v1/models) listed Qwen at $0.03/M input and $0.13/M output below the 32,000-token prompt tier, GPT-4o-mini at $0.15/M input and $0.60/M output, and Sonnet 4.6 at $3/M input and $15/M output. Operator-admitted C1 runs check that the verified installed product has an exact OpenRouter canonical price matching the selected route before source ingestion. The f324 pin has exact rows for Qwen and Sonnet; GPT-4o-mini remains an explicit control route whose cue construction blocks without its own canonical price. This protocol does not alias router chat prices to native vendors. The pinned v4 cue pipeline uses at most 8,192 UTF-8 source bytes and a 1,200-token output limit; the legacy operator wire limits below are not automatically enlarged. Prices and model availability must be rechecked before spending.

Keyless wire tests exercise both production runners with synthetic credentials and intercepted HTTP requests. They check the OpenRouter hostname, authorization isolation, exact model IDs, `dimensions: 1536`, durable cue construction, package provenance, and positive bounded cost previews. A native-provider decoy credential cannot replace a missing OpenRouter key. These checks do not establish live availability or actual returned dimensions. The embedding catalogue does not establish dimension support either. After explicit spending approval, verify a single real embedding response has 1536 finite values and a tiny generation call uses the selected model before starting corpus ingestion. Keep successful and failed smoke responses with their usage records.

An externally capped run continues to use `isolated-provider-cap`. An uncapped key must never carry that label. For an explicitly authorized diagnostic pilot only, `operator-authorized-development` instead records the operator's approval and per-cell allocation, plus locally enforced request-count, body-byte and output-token bounds. It is restricted to dev B/C0/C1 on the explicit embedding and generation allowlists, with no expansion, reranker, summary, operation replay or holdout. Its receipts are always nonpublishable, and its cue snapshots cannot supply release ablations. Holdout and release collection still require external-cap admission.

The scoped request guard counts every dispatched attempt, including retries and failed responses, rejects other hosts/models and redirects, and admits no request after its count is exhausted. Limits may be no larger than 1,500 requests, 65,536 bytes per request and 1,200 output tokens per chat request; chat request bodies also stay below 8,192 bytes. Before dispatch it reserves against a per-cell allocation of at most $100 using request bytes as a conservative input-token bound and the explicit model prices above. Known charges settle that reservation; missing accounting, a changed response model or a charge above the priced reservation retains the reservation and stops further dispatch. Cue construction also has its own durable allowance of at most $10. These controls are not a provider credit cap or an invoice guarantee. The operator owns the shared total across cells, failures and retries, and must not reset that total with each profile.

Freeze `build_timeout_ms` and `cell_timeout_ms` as well. Development builds may use up to 30 minutes, and the whole cell up to 60 minutes, without changing the lifetime build allowance or request limits. The guard aborts in-flight inference at the cell deadline and retains uncertain reservations. The operator's process launcher must use the same cell timeout to cover non-network stalls, retaining partial artifacts on termination. External-cap release builds keep the existing ten-minute build deadline; a longer diagnostic budget does not pass a native performance gate.

Use a separate process for each cell. Normal completion restores the previous transport. A rejected, uncertain or still-pending request leaves a closed transport until process exit so delayed SDK work cannot escape the guard after cleanup; do not reuse that process for another cell.

The frozen model-specific options disable reasoning and fallback routing and set the selected endpoint's advertised price ceilings. For Sonnet: `provider_chat_options["openrouter:anthropic/claude-sonnet-4.6"] = { reasoning: { enabled: false }, provider: { allow_fallbacks: false, max_price: { prompt: 3, completion: 15, request: 0 } } }`. `developmentChatOptions(model)` supplies the allowlisted model's own prices. Validators reject extra fields such as `model`, `messages` or `max_tokens`; the request guard checks the actual wire values as well. Profiles, effective configuration and cache identities record these options.

`development_usage` retains per-request status and available token/cost fields without prompts or credentials. It reports router charges and BYOK upstream charges separately. BYOK means OpenRouter used an upstream credential: router cost zero does not imply free work. `known_attributed_usd` adds upstream cost only when `usage.is_byok` is true, so a non-BYOK upstream price is not double-counted. Missing usage, unknown BYOK status and missing BYOK upstream cost remain explicit unknowns, not zero-cost claims. This is partial accounting for the operator, not an invoice or a spending guarantee.

Keep `development-requests.ndjson` and `development-http/` with the run. Cat36 writes them under `runtime/`; Cat13b writes them at the output root. Each reservation is appended and fsynced before network dispatch, followed by a sanitized settlement or uncertainty record. A process killed before settlement leaves its reservation unresolved rather than losing that possible charge. Per-request JSON artifacts preserve request bodies, response bodies and errors with hashes, removing headers, credential fields and known secret values; hashes identify the sanitized bytes, not an unredacted wire capture. This keeps invalid cue output inspectable without saving authorization. Embedding responses explicitly accept and record either `openai/text-embedding-3-large` or the provider's equivalent bare `text-embedding-3-large`; chat response IDs must match exactly.

Prepare diagnostic profiles without making provider calls. Set `EXPECTED_PRODUCT_SHA` and `EXPECTED_PACKAGE_SHA256` to independently verified candidate identities, `APPROVED_CELL_USD` and `OPERATOR_APPROVAL_ID` to the operator's per-cell allocation and approval reference, and `APPROVED_CUE_BUILD_USD` to the approved construction sub-budget. Set `GENERATION_MODEL` to the selected allowlisted route, `DEV_MAX_REQUESTS` to the chosen per-cell request ceiling and `DEV_CUE_MIN_SIMILARITY` to an explicitly recorded development hypothesis, not a claimed calibrated threshold. `PILOT_PROFILE_DIR` must name a new directory. None of these variables contains a credential. Six cells allocated $100 each reserve $600 of the operator's total, not six independent spending authorizations.

```sh
bun --no-env-file -e '
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { offlineCat36Profile, validateCat36Profile } from "./eval/runner/cat36-associative-retrieval.ts";
import { validateCat13bPilotProfile } from "./eval/runner/situation-recall-cat13b.ts";
import { resolveRegressionProduct } from "./eval/runner/situation-recall-provenance.ts";
import { developmentChatOptions } from "./eval/runner/situation-recall-development.ts";
const required = ["EXPECTED_PRODUCT_SHA", "EXPECTED_PACKAGE_SHA256", "APPROVED_CELL_USD", "OPERATOR_APPROVAL_ID", "APPROVED_CUE_BUILD_USD", "GENERATION_MODEL", "DEV_MAX_REQUESTS", "DEV_CUE_MIN_SIMILARITY", "PILOT_PROFILE_DIR"];
if (required.some(k => !process.env[k])) throw new Error("explicit verified identity, allowance and development settings required");
const e = process.env;
if (!["B", "C0,C1"].includes(e.PILOT_ARMS ?? "C0,C1")) throw new Error("choose baseline B or candidate C0,C1");
resolveRegressionProduct({ expectedProductSha: e.EXPECTED_PRODUCT_SHA, expectedPackageSha256: e.EXPECTED_PACKAGE_SHA256 });
const profiles = [];
for (const category of ["cat36", "cat13b"]) for (const arm of (e.PILOT_ARMS ?? "C0,C1").split(",")) {
  const p = { ...offlineCat36Profile(), id: `dev-openrouter-${category}-${arm}`, mode: "live", arm, split: "dev",
    embedding_model: "openrouter:openai/text-embedding-3-large", embedding_dimensions: 1536,
    generation_model: e.GENERATION_MODEL, token_budget: category === "cat13b" ? 12000 : 4096,
    provider_chat_options: developmentChatOptions(e.GENERATION_MODEL),
    expected_product_sha: e.EXPECTED_PRODUCT_SHA, expected_package_sha256: e.EXPECTED_PACKAGE_SHA256,
    provider_budget: { kind: "operator-authorized-development", approval_id: e.OPERATOR_APPROVAL_ID, max_usd: Number(e.APPROVED_CELL_USD),
      max_requests: Number(e.DEV_MAX_REQUESTS), max_request_bytes: 65536, max_output_tokens: 1200, build_timeout_ms: 1800000, cell_timeout_ms: 3600000 },
    ...(arm === "C1" ? { cue_min_similarity: Number(e.DEV_CUE_MIN_SIMILARITY), build_max_usd: Number(e.APPROVED_CUE_BUILD_USD) } : {}) };
  validateCat36Profile(p);
  if (category === "cat13b") validateCat13bPilotProfile(p);
  profiles.push(p);
}
mkdirSync(e.PILOT_PROFILE_DIR);
for (const p of profiles) writeFileSync(join(e.PILOT_PROFILE_DIR, p.id + ".json"), JSON.stringify(p, null, 2) + "\n", { flag: "wx" });
'
```

After approval and the tiny route smoke, run one cell at a time, substituting `C1` only after inspecting `C0` and confirming remaining authorization:

```sh
bun --no-env-file eval/runner/cat36-associative-retrieval.ts \
  --profile "$PILOT_PROFILE_DIR/dev-openrouter-cat36-C0.json" --smoke \
  --output /absolute/path/to/new-cat36-C0-dev
bun --no-env-file eval/runner/situation-recall-cat13b.ts \
  --profile "$PILOT_PROFILE_DIR/dev-openrouter-cat13b-C0.json" --execute \
  --output /absolute/path/to/new-cat13b-C0-dev
```

Cat36 `--smoke` scores four development probes but still builds the source corpus; it is not a cheap four-document ingestion. Omit `--smoke` only for an approved 160-probe development run. Cat13b always retains its native 20 pages and 30 questions; `split: "dev"` does not partition that catalog. Its CLI retains exit 2 for a nonpublishable diagnostic, so inspect the receipt rather than relabeling the run as release-ready. No pilot command uses held-out probes, changes labels, or runs a judge. C0/C1 share the candidate installation. For B, run the generator in the separate verified baseline consumer with its own SHA/hash, a fresh profile directory and `PILOT_ARMS=B`; never relabel a candidate run as the baseline.

Unreviewed Cat36 labels and exploratory cue thresholds permit diagnostic plumbing, error analysis and development calibration, not publishable retrieval-gain claims. The independent human relevance review remains pending, including the ink-smear, library-fines and concert-recording negatives. Both runners force operator-authorized receipts nonpublishable even when all probes complete. A separately externally capped Cat13b component receipt still does not establish a full release pass. Preserve all failures, freeze threshold/weight/model choices after development, and obtain independent label approval before a new held-out evaluation. Missing audio assets, other categories' attribution/IPC coverage, full LongMemEval data and the other release-gate profiles are separate release prerequisites, not blockers for this narrow development pilot.

### Source-only development policy

[situation-recall-experiment-policy.ts](../../eval/runner/situation-recall-experiment-policy.ts) defines two separate closed registrations for source-only development: historical `longmemeval-m-source-only-dev-v1` requires `situation-v3`, while `longmemeval-m-source-only-dev-v2` requires `situation-v4`. Neither is a dataset, runner, source-provenance approval or authorization to spend. The current f324 pin supplies v4, and a v1/v3 C1 registration must still fail preflight on it. Old receipts keep their original experiment and product identities. The existing Cat36/Cat13b protocols and both policies' financial, request, timeout and output limits remain unchanged.

The typed `SourceOnlyDevelopmentProfile` binds an opaque question ID, arm, attempt, immutable stage, registration/source hashes, exact product SHA/package hash, and a root-provided leaf allocation. Replay also records the successful construction receipt hash. The guard verifies package resolution and prices, but the caller must verify source-history membership, effective cues-off configuration for B/C0, construction completion and the linked receipt before admitting replay. The source builder must not receive question artifacts; query replay runs in a separate process.

| Arm | Stage | Maximum allocation | Requests including retries | Stage timeout |
|---|---|---:|---:|---:|
| B/C0 | Construction | $9 | 1,968 | 55 minutes |
| B/C0 | Replay | $1 | 32 | 5 minutes |
| C1 | Construction | $95 | 5,968 | 90 minutes |
| C1 | Replay | $5 | 32 | 30 minutes |

These ceilings sum to $10/2,000 requests/60 minutes per B/C0 question and $100/6,000 requests/120 minutes per C1 question. The orchestrator records two distinct leaf allocations, does not reserve the parent amount again, and enforces the outer paired-process deadline. Failed or uncertain construction blocks replay; a retry gets a new recorded attempt without erasing earlier charges. A supplied leaf allocation may tighten its stage's dollar ceiling, but caller-defined request, body, token and timeout ceilings are rejected.

All stages allow at most a 1 MiB embedding request. B/C0 and every replay stage reject all chat. C1 construction permits only Sonnet 4.6 with the exact production cue system prompt and SDK payload shape, temperature zero, `includeBridge: false`, and at most 8,192 UTF-8 evidence bytes. Its 64 KiB chat-wire limit accounts for JSON escaping, not larger evidence; output remains capped at 1,200 tokens. Reader, answer, judge, tool and alternate-model requests are not admitted. The hard-corpus experiment is not an allowed policy ID.

V1 retains its canonical source-text payload. V2 requires `{includeBridge:false,evidence:[{id:1,text:"exact excerpt"},...]}`, with source-order integer IDs, at most 64 excerpts and at most 640 UTF-16 units per excerpt. The concatenated text must fit the unchanged 8,192-byte source limit. The guard deep-imports `formatCueEvidence` from the verified package's `src/core/memory-cues/evidence.ts`, calls it with the concatenated text and explicit `false`, and compares the returned canonical `.content` string with the actual user message. It does not serialize or compare internal `.excerpts` metadata, nor trust a caller-supplied formatter. The exact registered system-prompt hash remains mandatory.

The v4 model selects `evidence_ref`; trusted product code derives the quote and its original position. Distinct cues may refer to the same excerpt. The financial guard does not reinterpret model output or waive schema, grounding or source-role checks. This is a versioned construction-reliability contract, not a measured retrieval improvement or a change to frozen relevance labels.

The entrypoint is `startSourceOnlyDevelopmentGuard(profile, { journalPath, verifiedPackagePath })` in [situation-recall-development.ts](../../eval/runner/situation-recall-development.ts). It returns `sealConstruction()`, `snapshot()` and `restore()`. Sealing irreversibly disables construction chat without changing the stage or resetting counters; it is not a continuation into another process. Use a fresh directory and journal for each stage. The existing accounting implementation supplies fsynced reservations, sanitized artifacts, BYOK attribution and uncertain-charge retention. Snapshots explicitly remain nonpublishable, outside release coverage, and do not claim verified authorization or a provider hard cap.

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
