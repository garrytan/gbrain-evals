/**
 * BrainBench category registry: one row per category, read by
 * eval/runner/all.ts and by anything that needs to know what a category
 * measures, what it costs and how far its evidence goes.
 *
 * Ids are stable descriptive slugs. `legacy_alias` is the old category
 * label ("1", "13b", "multi-adapter"); all.ts still prints it as "Cat <alias>"
 * and receipts keep their existing directories. Broad renumbering is
 * deliberately deferred (plan amendment 10).
 *
 * Tiers:
 *   H  hermetic: no key, no network, runs in CI.
 *   K  keyed, under $1 per run from a measured receipt.
 *   P  paid publication run, or a keyed run whose cost is not yet measured.
 *   none  cannot run today; the reason says why.
 *
 * Promotion rules (eval-category wave amendment 1, 2026-10-01): every
 * dispatched entry declares, before its first counted run, what may gate it:
 *   safety_contracts    exact safety assertions ("zero leaks"); they gate
 *                       immediately;
 *   quality_thresholds  quality metrics with a preregistered threshold; they
 *                       gate only at that threshold;
 *   exploratory         metrics that never gate.
 * all.ts gates on safety contracts and quality thresholds only, never on the
 * runner's own verdict unless a rule names it (RUNNER_VERDICT, kept for
 * categories whose verdict was frozen in runner code before this wave). An
 * entry gates exactly when it has at least one gating rule. A candidate fix
 * never sets its own acceptance threshold: change a threshold only in a
 * reviewed commit that does not also change the code it measures.
 *
 * Evidence maturity is the strongest claim a result can support:
 *   regression-only                 detects change against itself only.
 *   synthetic-production-path       real gbrain code path on synthetic or
 *                                   inspected data with known answers.
 *   independently-labeled-held-out  labels written by someone else, on data
 *                                   no configuration was chosen on.
 *   externally-replicated           reproduced by an outside party.
 */

export type RegistryTier = 'H' | 'K' | 'P';
export type GateStatus = 'gate' | 'report-only';
export type EvidenceMaturity =
  | 'regression-only'
  | 'synthetic-production-path'
  | 'independently-labeled-held-out'
  | 'externally-replicated';
export type Family =
  | 'retrieval'
  | 'relationships'
  | 'extraction'
  | 'ingestion'
  | 'temporal'
  | 'safety'
  | 'performance'
  | 'reasoning'
  | 'agent'
  | 'maintenance'
  | 'optimization';

export type RunSpec =
  | {
    kind: 'dispatched';
    args?: string[];
    env?: Record<string, string>;
    /** Runner takes a fresh output directory via this flag; the receipt is read from there. */
    outputFlag?: string;
    /** Bounded timeout per category. Default 600s. */
    timeoutMs?: number;
    /** Latency benchmark: runs alone, never alongside another category. */
    exclusive?: boolean;
  }
  | { kind: 'listed'; reason: string; command?: string };

/**
 * One gating rule: a receipt field compared with a preregistered value.
 * `path` is a dotted path from the receipt root (`verdict`,
 * `data.metrics.content_leak_probes`). A missing or non-matching field fails.
 */
export interface PromotionCheck {
  id: string;
  path: string;
  op: '==' | '<=' | '>=';
  value: number | string | boolean;
  description: string;
}

export interface PromotionRules {
  /** ISO date the rules were frozen. */
  preregistered: string;
  /** Where the thresholds come from and who froze them. */
  basis: string;
  safety_contracts: readonly PromotionCheck[];
  quality_thresholds: readonly PromotionCheck[];
  /** Metrics reported for the reader that never gate. */
  exploratory: readonly string[];
}

export interface CategoryEntry {
  id: string;
  legacy_alias: string;
  name: string;
  family: Family;
  tier: RegistryTier | 'none';
  /** Entry script, relative to the repository root. */
  script: string;
  run: RunSpec;
  /** usd null means no receipt has measured it; basis says where the number comes from. */
  cost_estimate: { usd: number | null; basis: string };
  /** Where the receipt lands; <output> is the fresh directory all.ts passes. */
  receipt_path: string;
  headline: { metric: string; denominator: string };
  /** Derived from promotion: 'gate' exactly when a safety contract or quality threshold exists. */
  gate: GateStatus;
  /** Required for dispatched entries; see PromotionRules. */
  promotion?: PromotionRules;
  evidence_maturity: EvidenceMaturity;
  /** What the category claims to measure, what it does not, and what counts as an error. */
  contract: string;
}

const HOUR = 3_600_000;
const FREE = { usd: 0, basis: 'no provider calls' } as const;
const UNMEASURED = { usd: null, basis: 'unmeasured: no receipt records this runner\'s spend' } as const;
const receipt = (stem: string) => `eval/reports/${stem}/receipt.json`;

/** The runner's own verdict as one rule. Not allowed for categories built in the 2026-10-01 wave. */
export const RUNNER_VERDICT: PromotionCheck = {
  id: 'runner-verdict', path: 'verdict', op: '==', value: 'pass',
  description: 'the runner\'s verdict, whose thresholds were fixed in runner code and reviewed before 2026-10-01',
};
/** Gating categories from before the wave: their frozen runner verdict is the one quality threshold. */
const LEGACY_VERDICT_GATE: PromotionRules = {
  preregistered: '2026-10-01', basis: 'recorded on 2026-10-01 from the verdict each runner already enforced; thresholds unchanged',
  safety_contracts: [], quality_thresholds: [RUNNER_VERDICT], exploratory: [],
};
/** Report-only categories: nothing gates; the headline metric is exploratory. */
const REPORT_ONLY: PromotionRules = {
  preregistered: '2026-10-01', basis: 'report-only: no rule has been preregistered, so nothing gates',
  safety_contracts: [], quality_thresholds: [], exploratory: ['headline metric (see headline)'],
};
const zero = (id: string, path: string, description: string): PromotionCheck => ({ id, path, op: '==', value: 0, description });

export const REGISTRY: readonly CategoryEntry[] = [
  {
    id: 'relational-graph-first', legacy_alias: '1', name: 'Relational retrieval before/after graph traversal (world-v1)',
    family: 'relationships', tier: 'H', script: 'eval/runner/before-after.ts', run: { kind: 'dispatched' },
    cost_estimate: FREE, receipt_path: receipt('before-after'),
    headline: { metric: 'Recall@5 and Precision@5 of relational gold pages, graph-first vs text-only ordering', denominator: '145 relational questions; Precision@5 divides by 5 slots per question (725)' },
    gate: 'gate', promotion: LEGACY_VERDICT_GATE, evidence_maturity: 'regression-only',
    contract: 'Imports world-v1 into PGLite, answers "who works at / invested in / advises / attended" questions once with text search only and once with typed graph edges ranked first, and scores the top five pages against gold derived from the corpus _facts. It shows whether graph traversal moves correct pages up; set metrics are nearly identical by construction because graph hits are a subset of text hits. The gold comes from the same generator as the pages, so this is a regression check, not an independent quality claim.',
  },
  {
    id: 'link-type-accuracy', legacy_alias: '2', name: 'Link type accuracy (world-v1)',
    family: 'extraction', tier: 'H', script: 'eval/runner/type-accuracy.ts', run: { kind: 'dispatched' },
    cost_estimate: FREE, receipt_path: receipt('type-accuracy'),
    headline: { metric: 'type accuracy (correct / (correct + mistyped)) and strict (from, to, type) F1', denominator: '280 gold edges from world-v1 _facts; type accuracy counts only found edges (146 at b80cad6)' },
    gate: 'gate', promotion: LEGACY_VERDICT_GATE, evidence_maturity: 'regression-only',
    contract: 'Runs extractPageLinks on every world-v1 page and compares the typed edges with gold derived from _facts. Edges are oriented the way gbrain stores them (attendance person -> meeting). Every inferred type that differs from gold is charged as spurious, so emitting every type cannot score well. It measures extraction on generator-written prose; it says nothing about prose the generator did not write.',
  },
  {
    id: 'alias-keyword-lookup', legacy_alias: '3', name: 'Alias lookup through keyword search',
    family: 'retrieval', tier: 'H', script: 'eval/runner/identity.ts', run: { kind: 'dispatched' },
    cost_estimate: FREE, receipt_path: receipt('identity'),
    headline: { metric: 'documented and undocumented alias recall through searchKeyword', denominator: '800 alias lookups (400 undocumented)' },
    gate: 'gate', promotion: LEGACY_VERDICT_GATE, evidence_maturity: 'regression-only',
    contract: 'Looks people up by aliases (handles, nicknames, misspellings) through keyword search and checks the canonical page ranks first. An alias counts as documented when its text appears on the page. It measures lexical lookup only. gbrain\'s entity resolver, write-time alias resolution and identity groups are not exercised.',
  },
  {
    id: 'timeline-round-trip', legacy_alias: '4', name: 'Timeline storage round-trip',
    family: 'temporal', tier: 'H', script: 'eval/runner/temporal.ts', run: { kind: 'dispatched' },
    cost_estimate: FREE, receipt_path: receipt('temporal'),
    headline: { metric: 'pass rate of point, range, recency and as-of timeline checks', denominator: '114 timeline probes' },
    gate: 'gate', promotion: LEGACY_VERDICT_GATE, evidence_maturity: 'regression-only',
    contract: 'Writes timeline entries and reads them back by point, range, recency and as-of filters (the as-of filter is applied by the harness). It proves storage and retrieval of dated entries. gbrain\'s own temporal features (chronicle operations, search date bounds, fact validity windows) are not exercised.',
  },
  {
    id: 'source-attribution', legacy_alias: '5', name: 'Source attribution / provenance',
    family: 'reasoning', tier: 'none', script: 'eval/runner/cat5-provenance.ts',
    run: { kind: 'listed', reason: 'not implemented: no reviewed claim catalog exists (the one-claim gold/citations.json template was removed in 0.10.1), and the runner has no gbrain in the loop' },
    cost_estimate: UNMEASURED, receipt_path: receipt('cat5-provenance'),
    headline: { metric: 'none until a reviewed claim catalog exists', denominator: 'none' },
    gate: 'report-only', evidence_maturity: 'regression-only',
    contract: 'Intended to check whether answers attribute claims to the right source. It cannot run: there is no reviewed claim catalog and no gbrain call in the loop.',
  },
  {
    id: 'prose-autolink-precision', legacy_alias: '6', name: 'Auto-link precision under prose',
    family: 'extraction', tier: 'H', script: 'eval/runner/cat6-prose-scale.ts', run: { kind: 'dispatched' },
    cost_estimate: FREE, receipt_path: receipt('cat6-prose-scale'),
    headline: { metric: 'extractor recall and labeled precision under injected prose traps', denominator: '250 injection probes (code fences, substring traps, ambiguous roles) plus 50 bare-name mentions in the gazetteer arm' },
    gate: 'gate', promotion: LEGACY_VERDICT_GATE, evidence_maturity: 'regression-only',
    contract: 'Injects prose that should or should not create links (code fences, substring traps, ambiguous roles) and scores the extracted links. Precision is measured on labeled injections only. Bare-name mentions are scored separately in a gazetteer arm that runs gbrain\'s by-mention extract pass over a PGLite brain. A pass is a regression result.',
  },
  {
    id: 'pglite-latency', legacy_alias: '7', name: 'Performance / latency',
    family: 'performance', tier: 'H', script: 'eval/runner/perf.ts', run: { kind: 'dispatched', exclusive: true },
    cost_estimate: FREE, receipt_path: receipt('perf'),
    headline: { metric: 'PGLite operation latency p50/p95/p99 and bulk throughput', denominator: '1K and 10K page brains; per-operation samples' },
    gate: 'gate', promotion: LEGACY_VERDICT_GATE, evidence_maturity: 'regression-only',
    contract: 'Times core PGLite operations and bulk import on synthetic brains, alone on the machine. It excludes hybrid search and embedding work, so it is a storage-layer latency check, not an end-to-end latency claim.',
  },
  {
    id: 'skill-compliance', legacy_alias: '8', name: 'Skill behavior compliance',
    family: 'agent', tier: 'none', script: 'eval/runner/cat8-skill-compliance.ts',
    run: { kind: 'listed', reason: 'not implemented: no reviewed probe catalog in the repository' },
    cost_estimate: UNMEASURED, receipt_path: receipt('cat8-skill-compliance'),
    headline: { metric: 'none until a reviewed probe catalog exists', denominator: 'none' },
    gate: 'report-only', evidence_maturity: 'regression-only',
    contract: 'Intended to judge whether an agent follows brain-first skills. It cannot run without a reviewed probe catalog.',
  },
  {
    id: 'end-to-end-workflows', legacy_alias: '9', name: 'End-to-end workflows',
    family: 'agent', tier: 'none', script: 'eval/runner/cat9-workflows.ts',
    run: { kind: 'listed', reason: 'not implemented: no reviewed scenario catalog in the repository' },
    cost_estimate: UNMEASURED, receipt_path: receipt('cat9-workflows'),
    headline: { metric: 'none until a reviewed scenario catalog exists', denominator: 'none' },
    gate: 'report-only', evidence_maturity: 'regression-only',
    contract: 'Intended to judge multi-step agent workflows over a brain. It cannot run without a reviewed scenario catalog.',
  },
  {
    id: 'adversarial-robustness', legacy_alias: '10', name: 'Robustness / adversarial input',
    family: 'safety', tier: 'H', script: 'eval/runner/adversarial.ts', run: { kind: 'dispatched' },
    cost_estimate: FREE, receipt_path: receipt('adversarial'),
    headline: { metric: 'edge-case pages processed without crash, hang or corruption', denominator: '22 edge-case pages' },
    gate: 'gate', promotion: LEGACY_VERDICT_GATE, evidence_maturity: 'regression-only',
    contract: 'Feeds malformed and hostile pages through import and read paths and fails on a crash, hang or corrupted read-back. It covers the listed cases only; it is not a fuzzing result.',
  },
  {
    id: 'text-ingestion-fidelity', legacy_alias: '11', name: 'Text ingestion fidelity (md/html; audio needs a key)',
    family: 'ingestion', tier: 'H', script: 'eval/runner/cat11-multimodal.ts', run: { kind: 'dispatched' },
    cost_estimate: FREE, receipt_path: receipt('cat11-multimodal'),
    headline: { metric: 'word recall of stored chunks against the source text', denominator: '5 fixtures; markdown floor 0.90, HTML floor 0.80' },
    gate: 'gate', promotion: LEGACY_VERDICT_GATE, evidence_maturity: 'regression-only',
    contract: 'Imports Markdown and HTML fixtures and checks how much of the source text survives into stored chunks. Audio and PDF are skipped without a key and are never counted as a pass. Recall only; it does not score extra or garbled text.',
  },
  {
    id: 'mcp-operation-contract', legacy_alias: '12', name: 'MCP operation contract',
    family: 'safety', tier: 'H', script: 'eval/runner/mcp-contract.ts', run: { kind: 'dispatched' },
    cost_estimate: FREE, receipt_path: receipt('mcp-contract'),
    headline: { metric: 'operation contract assertions passed (trust boundary, caps, injection)', denominator: '24 assertions' },
    gate: 'gate', promotion: LEGACY_VERDICT_GATE, evidence_maturity: 'regression-only',
    contract: 'Calls operations as trusted local and untrusted remote callers and asserts the trust boundary, result caps and injection handling. It covers the asserted operations, not every operation gbrain exposes.',
  },
  {
    id: 'concept-search', legacy_alias: '13', name: 'Conceptual search (live embeddings)',
    family: 'retrieval', tier: 'P', script: 'eval/runner/cat13-conceptual.ts', run: { kind: 'dispatched', timeoutMs: 2 * HOUR },
    cost_estimate: { usd: 3, basis: 'about $3 for Cat 13 in the 2026-09-09 retrieval refresh component estimate; cold embeddings' },
    receipt_path: receipt('cat13-conceptual'),
    headline: { metric: 'nDCG@5 and top-1 on conceptual probes, per adapter', denominator: '548 probes; 181 conceptual-only probes for the top-1 comparison' },
    gate: 'report-only', promotion: REPORT_ONLY, evidence_maturity: 'synthetic-production-path',
    contract: 'Asks paraphrased, concept-level questions over a synthetic corpus and compares gbrain, vectors, fusion and keyword search. The held-out concepts were reused to pick defaults, so it is development data (amendment 1). Embedding failures are errors, never misses.',
  },
  {
    id: 'source-swamp', legacy_alias: '13b', name: 'Source swamp: curated notes vs bulk chat (live embeddings)',
    family: 'retrieval', tier: 'P', script: 'eval/runner/cat13b-source-swamp.ts', run: { kind: 'dispatched', timeoutMs: HOUR },
    cost_estimate: UNMEASURED, receipt_path: receipt('cat13b-source-swamp'),
    headline: { metric: 'top-1 and top-3 curated-note hits with and without the source boost', denominator: '30 queries over 20 pages' },
    gate: 'report-only', promotion: REPORT_ONLY, evidence_maturity: 'synthetic-production-path',
    contract: 'Checks whether curated notes outrank bulk chat that repeats the same words, with a boost-off ablation. Keyword-only can clear the gate, so a pass does not isolate the boost.',
  },
  {
    id: 'source-swamp-situation-recall', legacy_alias: '13b-sit', name: 'Situation recall on Cat 13b (memory-cue arms)',
    family: 'retrieval', tier: 'P', script: 'eval/runner/situation-recall-cat13b.ts',
    run: { kind: 'listed', reason: 'release protocol run, not a sweep category; needs the memory-cue build (gbrain-cues) and an explicit protocol', command: 'bun eval/runner/situation-recall-cat13b.ts' },
    cost_estimate: UNMEASURED, receipt_path: 'eval/reports/situation-recall-cat13b/<output>/receipt.json',
    headline: { metric: 'top-1 curated-note hits for B, C0 and C1 arms', denominator: '30 queries over 20 pages per arm' },
    gate: 'report-only', evidence_maturity: 'synthetic-production-path',
    contract: 'Runs Cat 13b through the native adapter with memory-cue arms loaded from gbrain-cues. It is a preregistered development protocol, not a published capability result.',
  },
  {
    id: 'think-calibration', legacy_alias: '14', name: 'Calibration A/B of think (live model and judge)',
    family: 'reasoning', tier: 'P', script: 'eval/runner/cat14-calibration.ts', run: { kind: 'dispatched', timeoutMs: HOUR },
    cost_estimate: UNMEASURED, receipt_path: receipt('cat14-calibration'),
    headline: { metric: 'blind judge preference for think with vs without calibration', denominator: '8 probes' },
    gate: 'report-only', promotion: REPORT_ONLY, evidence_maturity: 'regression-only',
    contract: 'Compares think answers with and without calibration context under a blind judge. The May 18 result is retracted because the judge saw the expected behavior; n=8 cannot support a quality claim.',
  },
  {
    id: 'propose-takes', legacy_alias: '15', name: 'propose_takes extraction (live model)',
    family: 'extraction', tier: 'P', script: 'eval/runner/cat15-propose-takes.ts', run: { kind: 'dispatched', timeoutMs: HOUR },
    cost_estimate: UNMEASURED, receipt_path: receipt('cat15-propose-takes'),
    headline: { metric: 'precision, recall and F1 of extracted takes', denominator: '48 labeled claims' },
    gate: 'report-only', promotion: REPORT_ONLY, evidence_maturity: 'regression-only',
    contract: 'Runs the product propose_takes prompt over labeled passages and scores extracted takes against the labels. Small and in-sample.',
  },
  {
    id: 'embedding-providers', legacy_alias: '18', name: 'Embedding providers',
    family: 'retrieval', tier: 'P', script: 'eval/runner/cat18-embedding-providers.ts', run: { kind: 'dispatched', timeoutMs: HOUR },
    cost_estimate: UNMEASURED, receipt_path: receipt('cat18-embedding-providers'),
    headline: { metric: 'Recall@10 and MRR per embedder through hybrid search, reranker off', denominator: 'synthetic-v1 derived queries per provider cell' },
    gate: 'report-only', promotion: REPORT_ONLY, evidence_maturity: 'synthetic-production-path',
    contract: 'Compares OpenAI and Voyage embedders through the same hybrid pipeline with the reranker pinned off. Cells with incomplete embedding coverage are invalid and every planned probe is recorded as a dependency error. ZeroEntropy was retired on 2026-09-04 and is no longer a cell.',
  },
  {
    id: 'embedder-reranker-matrix', legacy_alias: '18b', name: 'Embedder x reranker matrix',
    family: 'retrieval', tier: 'P', script: 'eval/runner/cat18b-embedding-rerank-matrix.ts', run: { kind: 'dispatched', timeoutMs: HOUR },
    cost_estimate: UNMEASURED, receipt_path: receipt('cat18b-embedding-rerank-matrix'),
    headline: { metric: 'Recall@10, MRR and top-1 deltas from adding voyage:rerank-2.5', denominator: '4 cells (OpenAI 1536d and Voyage 1024d, each with and without the reranker)' },
    gate: 'report-only', promotion: REPORT_ONLY, evidence_maturity: 'synthetic-production-path',
    contract: 'Isolates what the reranker adds on top of each embedder; only the reranker keys differ within a pair. A reranked query without a rerank score is a dependency failure, so a missing key cannot publish unreranked numbers under a reranked label.',
  },
  {
    id: 'doctor-remediation', legacy_alias: '19', name: 'Sick-brain remediation loop (hash embeddings)',
    family: 'maintenance', tier: 'H', script: 'eval/runner/cat19-doctor-remediate.ts', run: { kind: 'dispatched' },
    cost_estimate: FREE, receipt_path: receipt('cat19-doctor-remediate'),
    headline: { metric: 'remediation gates passed after extract and embed', denominator: '5 gates' },
    gate: 'gate', promotion: LEGACY_VERDICT_GATE, evidence_maturity: 'regression-only',
    contract: 'Builds a deliberately unhealthy brain, runs extraction and embedding, and checks the health recommendations converge. It does not run doctor --remediate itself and uses hash embeddings.',
  },
  {
    id: 'brainstorm-grounding', legacy_alias: '20', name: 'Brainstorm grounding (live model and judge)',
    family: 'reasoning', tier: 'P', script: 'eval/runner/cat20-brainstorm.ts', run: { kind: 'dispatched', timeoutMs: HOUR },
    cost_estimate: UNMEASURED, receipt_path: receipt('cat20-brainstorm'),
    headline: { metric: 'grounded idea rate and judged novelty', denominator: '3 prompts' },
    gate: 'report-only', promotion: REPORT_ONLY, evidence_maturity: 'regression-only',
    contract: 'Runs the brainstorm orchestrator and scores grounding and novelty with a judge. n=3 and partly vacuous grounding checks; not a quality claim.',
  },
  {
    id: 'code-retrieval', legacy_alias: '21', name: 'Code retrieval (live embeddings)',
    family: 'retrieval', tier: 'P', script: 'eval/runner/cat21-code-retrieval.ts', run: { kind: 'dispatched', timeoutMs: HOUR },
    cost_estimate: UNMEASURED, receipt_path: receipt('cat21-code-retrieval'),
    headline: { metric: 'top-1 and Recall@5 of the file defining a symbol', denominator: '12 symbol queries over gbrain src/core' },
    gate: 'report-only', promotion: REPORT_ONLY, evidence_maturity: 'regression-only',
    contract: 'Ingests gbrain source files as Markdown-wrapped code and looks up symbols by name. The corpus changes with the pin, so results are only comparable at one pin.',
  },
  {
    id: 'source-isolation', legacy_alias: '22', name: 'Source isolation',
    family: 'safety', tier: 'H', script: 'eval/runner/cat22-source-isolation.ts', run: { kind: 'dispatched' },
    cost_estimate: FREE, receipt_path: receipt('cat22-source-isolation'),
    headline: { metric: 'cross-source leaks across search, keyword, graph and get surfaces, with negative controls', denominator: '8 probes' },
    gate: 'gate', promotion: LEGACY_VERDICT_GATE, evidence_maturity: 'regression-only',
    contract: 'Seeds several sources and asserts a scoped read never returns another source, while negative controls prove the probes can detect a leak. Zero leaks here is a regression result for the probed surfaces.',
  },
  {
    id: 'phantom-redirect', legacy_alias: '23', name: 'Phantom to canonical redirect',
    family: 'maintenance', tier: 'H', script: 'eval/runner/cat23-phantom-redirect.ts', run: { kind: 'dispatched' },
    cost_estimate: FREE, receipt_path: receipt('cat23-phantom-redirect'),
    headline: { metric: 'phantom pages redirected to the right canonical page', denominator: '9 cases' },
    gate: 'gate', promotion: LEGACY_VERDICT_GATE, evidence_maturity: 'regression-only',
    contract: 'Creates stub (phantom) pages beside canonical ones and checks the redirect decision. It mirrors rather than calls one product function.',
  },
  {
    id: 'capture-provenance', legacy_alias: '24', name: 'Capture provenance',
    family: 'ingestion', tier: 'H', script: 'eval/runner/cat24-capture-provenance.ts', run: { kind: 'dispatched' },
    cost_estimate: FREE, receipt_path: receipt('cat24-capture-provenance'),
    headline: { metric: 'provenance fields written through each ingest path, plus dedup', denominator: '7 probes' },
    gate: 'gate', promotion: LEGACY_VERDICT_GATE, evidence_maturity: 'regression-only',
    contract: 'Imports through each capture path and checks source kind, URI and ingestion method are stored and preserved. The dedup probe is weak.',
  },
  {
    id: 'trajectory-routing', legacy_alias: '25', name: 'Trajectory routing in think (live model)',
    family: 'reasoning', tier: 'P', script: 'eval/runner/cat25-trajectory-routing.ts', run: { kind: 'dispatched', timeoutMs: HOUR },
    cost_estimate: UNMEASURED, receipt_path: receipt('cat25-trajectory-routing'),
    headline: { metric: 'think answers with vs without trajectory routing', denominator: 'synthetic-v1 temporal probes' },
    gate: 'report-only', promotion: REPORT_ONLY, evidence_maturity: 'regression-only',
    contract: 'Checks think routes temporal questions to trajectory data. The hermetic mode proves wiring only.',
  },
  {
    id: 'contextual-retrieval', legacy_alias: '26', name: 'Contextual retrieval modes (live embeddings)',
    family: 'retrieval', tier: 'P', script: 'eval/runner/cat26-contextual-retrieval.ts', run: { kind: 'dispatched', timeoutMs: HOUR },
    cost_estimate: UNMEASURED, receipt_path: receipt('cat26-contextual-retrieval'),
    headline: { metric: 'Recall@3 and MRR per contextual retrieval mode', denominator: 'synthetic-v1 derived queries per mode' },
    gate: 'report-only', promotion: REPORT_ONLY, evidence_maturity: 'regression-only',
    contract: 'Compares chunk-embedding modes (none, title prefix, synopsis). The stub contrast is tuned, so offline runs are plumbing checks.',
  },
  {
    id: 'graph-signals', legacy_alias: '27', name: 'Graph signals on/off',
    family: 'relationships', tier: 'H', script: 'eval/runner/cat27-graph-signals.ts', run: { kind: 'dispatched' },
    cost_estimate: FREE, receipt_path: receipt('cat27-graph-signals'),
    headline: { metric: 'nDCG@10 and top-1 with graph signals on vs off', denominator: '4 probes' },
    gate: 'gate', promotion: LEGACY_VERDICT_GATE, evidence_maturity: 'regression-only',
    contract: 'Runs the same queries with graph ranking signals on and off; only that knob differs. Four probes; a no-op can still pass.',
  },
  {
    id: 'federated-sync-latency', legacy_alias: '28', name: 'Federated sync latency',
    family: 'performance', tier: 'H', script: 'eval/runner/cat28-federated-sync-latency.ts', run: { kind: 'dispatched', exclusive: true },
    cost_estimate: FREE, receipt_path: receipt('cat28-federated-sync-latency'),
    headline: { metric: 'wall-clock of serial vs interleaved imports across sources', denominator: 'fixed import workload per mode' },
    gate: 'gate', promotion: LEGACY_VERDICT_GATE, evidence_maturity: 'regression-only',
    contract: 'A microbenchmark of the engine write path (no embeddings), run alone. It is not a sync-service latency claim.',
  },
  {
    id: 'think-vs-search', legacy_alias: '29', name: 'think vs raw search payload (live model and judge)',
    family: 'reasoning', tier: 'P', script: 'eval/runner/cat29-think-vs-search.ts', run: { kind: 'dispatched', timeoutMs: HOUR },
    cost_estimate: UNMEASURED, receipt_path: receipt('cat29-think-vs-search'),
    headline: { metric: 'judged answer quality of think vs a raw search payload', denominator: '5 questions' },
    gate: 'report-only', promotion: REPORT_ONLY, evidence_maturity: 'regression-only',
    contract: 'Compares a synthesized think answer with raw search results under a judge. The search arm is a strawman and n=5; not a quality claim.',
  },
  {
    id: 'skillopt', legacy_alias: '30-33', name: 'SkillOpt improvement, ablation, reward hacking, transfer',
    family: 'optimization', tier: 'P', script: 'eval/runner/run-skillopt-cats.sh',
    run: { kind: 'listed', reason: 'multi-hour paid optimizer runs; dispatched by their own script', command: 'bash eval/runner/run-skillopt-cats.sh' },
    cost_estimate: UNMEASURED, receipt_path: 'eval/reports/cat30-skillopt-improvement/receipt.json (one per category 30-33)',
    headline: { metric: 'held-out reward lift, ablation deltas, gameable-judge gap, cross-model transfer', denominator: 'per-category seeds' },
    gate: 'report-only', evidence_maturity: 'regression-only',
    contract: 'Optimizes skills and scores them on held-out tasks. The held-out reward can be satisfied by fabricated citations, so results are not quality claims.',
  },
  {
    id: 'brainbench-memory-conformance', legacy_alias: '34', name: 'BrainBench memory conformance (external gbrain checkout)',
    family: 'agent', tier: 'H', script: 'eval/runner/cat34-brainbench-memory.ts', run: { kind: 'dispatched' },
    cost_estimate: FREE, receipt_path: receipt('cat34-brainbench-memory'),
    headline: { metric: 'know-to-ask, push, write-back and continuity pass matrix', denominator: '4 suites x 3 harnesses (12 cells)' },
    gate: 'gate', promotion: LEGACY_VERDICT_GATE, evidence_maturity: 'regression-only',
    contract: 'Runs gbrain\'s BrainBench memory suite from an external checkout with provider keys stripped. It records a skip without a checkout; the checkout is not pinned to the package pin.',
  },
  {
    id: 'transcript-distillation', legacy_alias: '35', name: 'Transcript to brain-page distillation fidelity (full mode)',
    family: 'extraction', tier: 'P', script: 'eval/runner/cat35-transcript-distill.ts',
    // Worst-case dream lane alone is 24 x 600s subagent cap / 2 concurrency.
    run: { kind: 'dispatched', env: { CAT35_FULL: '1' }, timeoutMs: 3 * HOUR },
    cost_estimate: { usd: 12, basis: 'measured $6.20-$6.36 per full run (2026-08-31 receipts) plus an estimated $2-$6 of dream synthesis the phase API does not report' },
    receipt_path: receipt('cat35-transcript-distill'),
    headline: { metric: 'evidence-verified fact retention and hallucination rate of distilled pages', denominator: 'labeled facts across the transcript fixtures; judge failures are errors, not misses' },
    gate: 'report-only', promotion: REPORT_ONLY, evidence_maturity: 'synthetic-production-path',
    contract: 'Ingests synthetic transcripts through the product ingest, fact extraction and synthesis phases and checks which labeled facts survive with evidence and which claims are invented. The result is in-sample; judge-only retention overstates evidence-verified retention.',
  },
  {
    id: 'associative-retrieval-smoke', legacy_alias: '36', name: 'Associative retrieval (offline keyword plumbing only; not capability evidence)',
    family: 'retrieval', tier: 'H', script: 'eval/runner/cat36-associative-retrieval.ts',
    run: { kind: 'dispatched', args: ['--offline', '--smoke'], outputFlag: '--output', timeoutMs: 180_000 },
    cost_estimate: FREE, receipt_path: 'eval/reports/cat36-associative-retrieval/<output>/receipt.json',
    headline: { metric: 'required spans covered in the top five chunks (plumbing only)', denominator: 'smoke subset of associative probes' },
    gate: 'gate', promotion: LEGACY_VERDICT_GATE, evidence_maturity: 'regression-only',
    contract: 'Runs the associative retrieval pipeline offline with keyword search to prove the harness, scorer and receipts work. Never publishable and never capability evidence.',
  },
  {
    id: 'associative-retrieval-live', legacy_alias: '36-live', name: 'Associative retrieval (live cue arms)',
    family: 'retrieval', tier: 'P', script: 'eval/runner/cat36-associative-retrieval.ts',
    run: { kind: 'listed', reason: 'needs an approved provider budget profile and the memory-cue build (gbrain-cues)', command: 'bun eval/runner/cat36-associative-retrieval.ts --profile <approved-profile.json>' },
    cost_estimate: UNMEASURED, receipt_path: 'eval/reports/cat36-associative-retrieval/<output>/receipt.json',
    headline: { metric: 'required spans covered in the top five chunks, per arm', denominator: 'associative probes in the profile split' },
    gate: 'report-only', evidence_maturity: 'synthetic-production-path',
    contract: 'Compares B, C0 and cue arms on indirect questions; cue and summary arms run on gbrain-cues. A preregistered protocol, not a published result.',
  },
  {
    id: 'temporal-asof', legacy_alias: 'N3', name: 'Temporal and as-of questions through gbrain\'s temporal features',
    family: 'temporal', tier: 'H', script: 'eval/runner/n3-temporal-asof.ts', run: { kind: 'dispatched' },
    cost_estimate: FREE, receipt_path: receipt('n3-temporal-asof'),
    headline: { metric: 'as-of accuracy (ontology_get over fact validity windows), range set-F1, last-seen MAE in days, per-feature pass rates', denominator: 'seed 3: 513 probes (492 from the ledger, 21 clock-relative): 104 as-of probes per arm, 179 range probes, 83 last-seen probes; 155 of the 513 are negative controls' },
    gate: 'gate', evidence_maturity: 'synthetic-production-path',
    promotion: {
      preregistered: '2026-10-01', basis: 'n3Verdict (exact conformance on every metric) became the gate on 2026-09-30 at 6c8373c; recorded here unchanged',
      safety_contracts: [],
      quality_thresholds: [{ ...RUNNER_VERDICT, description: 'n3Verdict: as-of, timeline as-of, range set-F1, last-seen exact rate, negative controls and every feature pass rate exactly 1, last-seen MAE 0' }],
      exploratory: ['data.summary.pagedate_asof (page-date filtering compared with valid-time and recorded-time gold)', 'data.summary.asof_by_scenario'],
    },
    contract: 'Writes a seeded ledger (job changes with separate valid and recorded dates, timestamped chronicle events, competing date signals, time-zone and DST edges, metric trajectories) through gbrain operation handlers on in-memory PGLite, then scores chronicle_day/since/on_this_day/last_seen, query since/until on the keyword path, effective-date precedence and recorded-time fallback, relative durations, ontology_get and get_timeline as-of, and find_trajectory against gold the generator derives from the ledger with independent oracles. Page-date filtering is scored as a filter and reported separately from true as-of state. It does not measure chronicle extraction from prose (a scripted judge feeds events), natural-language dates, a pinned "now", or think. A gbrain operation that throws where an answer is expected is a scored miss; a failed presence assertion is a harness error and voids the run.',
  },
  {
    id: 'entity-resolution', legacy_alias: 'N4', name: 'Entity resolution: variants, namesakes and cross-source identity',
    family: 'relationships', tier: 'H', script: 'eval/runner/n4-entity-resolution.ts', run: { kind: 'dispatched' },
    cost_estimate: FREE, receipt_path: receipt('n4-entity-resolution'),
    headline: { metric: 'B-cubed F1, wrong-merge rate, correct-refusal rate and exact-lookup floor of the read-time resolver, beside singleton, merge-everything and exact-only baselines', denominator: '136 single-source mentions (119 solvable, 17 refusals) at the default seed; recall adds 8 two-source-grant mentions' },
    gate: 'gate', evidence_maturity: 'synthetic-production-path',
    promotion: {
      preregistered: '2026-10-01', basis: 'amendment 1: the safety contracts gate immediately; they and the exact-lookup floors held at 6c8373c (2026-09-30 receipts) and at 3a284ae; recall stays exploratory because its misses are documented design limits',
      safety_contracts: [
        zero('no-identity-leak', 'data.identity.leaks', 'no identity-group member is returned outside the caller\'s source grant'),
        zero('no-wrong-merge-resolver', 'data.surfaces.resolver.wrong_merges', 'the resolver never maps a mention to another entity or resolves a mention that must be refused'),
        zero('no-wrong-merge-recall', 'data.surfaces.recall.wrong_merges', 'recall never answers with another entity\'s page'),
        zero('no-wrong-merge-remember', 'data.surfaces.remember.wrong_merges', 'remember never attaches a fact to another entity'),
        zero('no-wrong-merge-resolve-on-save', 'data.surfaces.resolve_on_save.wrong_merges', 'resolve-on-save never links a mention to another entity'),
      ],
      quality_thresholds: [
        { id: 'exact-lookup-floor', path: 'data.surfaces.resolver.floor.rate', op: '>=', value: 1, description: 'every exact slug or exact name mention resolves (utility floor: a system that refuses everything cannot pass)' },
        { id: 'search-exact-floor', path: 'data.search_floor.rate', op: '>=', value: 1, description: 'the search exact-lookup tier ranks the right page first for every exact mention' },
      ],
      exploratory: ['b3_f1, accuracy, unresolved and fragmentation rates per surface (the runner verdict)', 'data.identity.recall', 'data.baselines'],
    },
    contract: 'Seeds a generated world of people and companies (nicknames, typos, handles, initials, former names, namesakes, the same person in two sources linked by an identity group, and two different people sharing a slug across sources) into PGLite, then resolves mentions through gbrain\'s resolver cascade, the recall and remember operations, the resolve-on-save path, the search exact-lookup tier and the identity-group operations. Gold comes from an oracle over the written pages; ambiguous, unreadable and no-referent mentions must be refused. Metrics are B-cubed over mention clusters, wrong merges, fragmentation, unresolved and correct refusals. It does not test context-aware disambiguation, names declared only in prose as a gbrain feature, or LLM extraction. A product exception is a scored miss; a failed presence assertion is a harness error.',
  },
  {
    id: 'visibility-leak-fuzz', legacy_alias: 'N6', name: 'Visibility and access leak fuzz (every read op x caller x scope)',
    family: 'safety', tier: 'H', script: 'eval/runner/n6-visibility-fuzz.ts', run: { kind: 'dispatched' },
    cost_estimate: FREE, receipt_path: receipt('n6-visibility-fuzz'),
    headline: { metric: 'leaking probes (content, existence, existence-oracle; target 0), access-gate bypasses, and read-op coverage', denominator: 'every read op enumerated from gbrain operations at run time x 6 remote callers x targets and variants (3,854 exposed probes and 74 read ops at 0.60.13.0)' },
    gate: 'gate', evidence_maturity: 'synthetic-production-path',
    promotion: {
      preregistered: '2026-10-01', basis: 'amendment 1: zero leaks gate immediately (they held at 6c8373c and 3a284ae); the coverage floor follows the outside review (a safety gate needs an authorized-utility floor) and held at both commits',
      safety_contracts: [
        zero('no-content-leak', 'data.metrics.content_leak_probes', 'no protected marker in any remote response'),
        zero('no-existence-leak', 'data.metrics.existence_leak_probes', 'no protected slug or ungranted-source row the probe did not ask for'),
        zero('no-existence-oracle', 'data.metrics.oracle_probes', 'a protected target answers like a never-written ghost'),
        zero('no-gate-bypass', 'data.metrics.gate_bypasses', 'no access gate is bypassed'),
        zero('no-sealed-chunk-violation', 'data.metrics.sealed_chunk_violations', 'sealed chunks never carry fenced rows'),
        { ...RUNNER_VERDICT, description: 'n6 verdict: leak-free and the probe accounting is valid (not invalidated by harness errors)' },
      ],
      quality_thresholds: [
        { id: 'content-reachable-coverage', path: 'data.metrics.content_reachable_coverage', op: '>=', value: 1, description: 'every read op that returns protected content to the trusted caller has a signal-bearing remote probe (a system that refuses everything cannot pass)' },
      ],
      exploratory: ['data.metrics.op_coverage', 'data.metrics.probes_with_signal', 'data.by_caller'],
    },
    contract: 'Seeds a brain holding protected content (visibility: private pages with body, tag and timeline markers, held Takes rows, private Facts rows, derived atoms, an ungranted source) beside public twins, then calls every read op in gbrain operations as stdio, serve-http read/write/slug-bound clients and remote/local subagents scoped to one source. Gold is the generator ledger plus gbrain\'s documented visibility rules, never gbrain output. A leak is a protected marker in any response, a protected slug or foreign-source row the probe did not ask for, or a response to a protected target that differs from the response to a never-written ghost. Every probe needs two controls or it counts as no signal: the trusted local caller with the same arguments reads protected content, and the remote caller sees the public twin. Coverage counts read ops with at least one signal-bearing probe. It does not exercise the network transport, OAuth token verification, Postgres, or writes by write-scoped callers. Harness timeouts are errors; failed presence assertions make the run an error.',
  },
  {
    id: 'open-loops-email', legacy_alias: 'N7', name: 'Open loops on Gmail-shaped threads: turn-flip detection, closure, manual close and mute',
    family: 'agent', tier: 'H', script: 'eval/runner/n7-open-loops-email.ts', run: { kind: 'dispatched' },
    cost_estimate: FREE, receipt_path: receipt('n7-open-loops-email'),
    headline: { metric: 'planted-loop recall and precision of the turn-flip detector, closure accuracy, counterparty accuracy, and violations of the documented exclusion, close, mute and redaction rules', denominator: 'seeded Gmail-shaped threads (planted loops, closing replies, acknowledgements, nudges, noise, list, calendar, CC-only and self threads) plus the 25 amara-life-v1 threads, judged at a pinned now; multi-round store scenarios on PGLite' },
    gate: 'gate', evidence_maturity: 'synthetic-production-path',
    promotion: {
      preregistered: '2026-10-01',
      basis: 'amendment 1 and amendment 8, frozen before the first N7 run: safety contracts are the documented exclusion, close, mute and redaction rules (docs/guides/open-loops.md at 3a284ae); the recall floor is a utility floor so a detector that never opens a loop fails, not a value tuned to a run; closure and counterparty thresholds allow one documented-rule miss in twenty',
      safety_contracts: [
        zero('no-loop-from-excluded-mail', 'data.contracts.excluded_class_loops', 'noise senders, list mail, CC-only delivery, self-threads, calendar system mail, outbound without a question mark and mail inside the grace window never open a loop'),
        zero('calendar-never-closes', 'data.contracts.calendar_closes', 'a calendar notice after an open loop never closes it'),
        zero('manual-close-holds', 'data.contracts.manual_close_reverted', 'a loop closed with loops_close stays closed when the unchanged thread is applied again'),
        zero('mute-blocks-new-loops', 'data.contracts.muted_new_loops', 'a muted sender or thread opens no new loop'),
        zero('remote-evidence-redacted', 'data.contracts.remote_evidence_leaks', 'open_loops for a remote caller carries no quote, deep link, text digest or message body'),
      ],
      quality_thresholds: [
        { id: 'planted-loop-recall-floor', path: 'data.quality.planted_loop_recall', op: '>=', value: 0.8, description: 'utility floor: planted loops that the documented rules say are open are detected with the right loop type' },
        { id: 'closure-accuracy', path: 'data.quality.closure_accuracy', op: '>=', value: 0.95, description: 'a thread whose last substantive message flips the turn has no open loop of the answered type' },
        { id: 'counterparty-accuracy', path: 'data.quality.counterparty_accuracy', op: '>=', value: 0.95, description: 'detected planted loops name the counterparty the documented rule names (sender for inbound, first external To recipient for outbound)' },
      ],
      exploratory: [
        'data.quality.planted_loop_precision',
        'data.exploratory.backfill_nudge_recall (a nudge or follow-up inside the grace window on a thread first seen after the original became overdue)',
        'data.exploratory.acknowledgement_closes ("Thanks!" and other acknowledgements close a reply-owed loop)',
        'data.exploratory.still_owed_after_close (semantic label: the counterparty still waits although the loop closed)',
        'data.exploratory.url_question_mark_opens (FYI mail whose only question mark is inside a link)',
        'data.exploratory.ranking (order under a shifted wall clock, monotonicity in loop count, age measured from detection rather than from the message)',
        'data.exploratory.amara_background (loops on the 25 amara-life-v1 threads against the documented-rule oracle)',
        'data.semantic (promise fulfillment, separately labeled; the extractor arm is paid and never gates)',
      ],
    },
    contract: 'Renders a seeded ledger of Gmail threads (raw Gmail API JSON) through gbrain\'s own GmailClient.getThread parser with a stub fetch, then judges them with detectThreadLoop at a pinned now and replays multi-round scenarios through applyThreadLoopVerdict, loops_close, loops_mute and open_loops on in-memory PGLite. Mechanics gold is an independent implementation of the rules in docs/guides/open-loops.md applied to the ledger (unanswered inbound for 24 hours, unanswered outbound question for 72 hours, turn flip closes, exclusions); semantic labels (someone still waiting, promise made, promise fulfilled) come from the generator and are reported separately, never mapped onto reply closure. It does not measure Slack or calendar commitments (no product path), the LLM commitment extractor (a paid arm), real Google sync, or ranking quality (no independent priority labels; ranking is a conformance check). A gbrain exception where a verdict is expected is a scored miss; a failed presence assertion is a harness error.',
  },
  {
    id: 'proactive-recall', legacy_alias: 'N8', name: 'Unsolicited recall: volunteer_context and turn_context final delivery across sessions',
    family: 'agent', tier: 'H', script: 'eval/runner/n8-proactive-recall.ts', run: { kind: 'dispatched' },
    cost_estimate: FREE, receipt_path: receipt('n8-proactive-recall'),
    headline: { metric: 'proactive recall on trigger turns against false-alarm rate on negative turns at the default gate, with a min_confidence sweep, tokens per turn, redundant injections per session, and private or withdrawn deliveries', denominator: 'seeded entity sessions (trigger, matched innocuous, common-word collision, private, withdrawn and repeat turns) plus associative-recall-v1 probes as turns (240 indirect, 120 direct, 120 negatives with three adjudicated)' },
    gate: 'report-only', evidence_maturity: 'synthetic-production-path',
    promotion: {
      preregistered: '2026-10-01',
      basis: 'amendment 8 and the CEO requirement: report-only until associative-recall-v1 labels pass independent human review, so nothing gates; the targets below were frozen before the first N8 run and are reported as exploratory with their pass flags',
      safety_contracts: [],
      quality_thresholds: [],
      exploratory: [
        'data.contracts.private_pages_delivered_remote (target 0: volunteer_context for a remote caller never delivers a visibility: private page)',
        'data.contracts.private_pages_delivered_turn_context (target 0: the turn_context block injected into a model never carries a private page)',
        'data.contracts.withdrawn_pages_delivered (target 0: soft-deleted pages are never delivered)',
        'data.contracts.redelivered_with_prior_context (target 0: a page whose slug is in prior_context is not volunteered again)',
        'data.quality.mechanics.recall_default (target >= 0.8 on alias and exact-title trigger turns at the default gate)',
        'data.quality.mechanics.false_alarm_rate_default (target <= 0.05 on innocuous and no-mention turns)',
        'data.quality.mechanics.collision_false_alarm_rate (common-word turns)',
        'data.quality.sweep (recall and false-alarm rate per min_confidence; recall at a 5% false-alarm budget; PR-AUC)',
        'data.quality.tokens_per_turn and data.quality.latency_ms',
        'data.quality.session (redundant injections per session with and without prior_context)',
        'data.quality.associative (strict and adjudicated false-alarm rates; recall on indirect probes, a documented gap)',
        'data.quality.baselines (never-inject, always-inject, turn-text keyword search top 3)',
      ],
    },
    contract: 'Imports a seeded entity world (people, companies and projects with aliases; private and soft-deleted pages) and the associative-recall-v1 sources into in-memory PGLite, then replays conversation sessions turn by turn through the volunteer_context operation (trusted local and remote callers) and, locally only, assembleTurnContext, the builder behind the IPC-only turn_context. It scores the final delivered pages and bytes, not the candidate pool: a delivered target is a hit on a trigger turn, any delivered page not mentioned in the window is a false alarm, a re-delivery inside a session is redundant. Gold comes from the generator ledger and the associative-recall-v1 labels with the agent adjudication in eval/data/n8-proactive-recall/, never from gbrain. It does not measure general associative recall as a product capability (gbrain does not claim it), System One S6 (off keyless), agent use of the injected block, or a real hook trace. A gbrain exception where a delivery is expected is a scored miss; a failed presence assertion (direct alias mentions must fire) is a harness error.',
  },
  {
    id: 'system-one-jev-record', legacy_alias: 'SO', name: 'System One (Jev decision support) record: datasets, receipts and pair definitions',
    family: 'agent', tier: 'H', script: 'eval/runner/system-one-jev.ts', run: { kind: 'dispatched' },
    cost_estimate: FREE, receipt_path: receipt('system-one-jev'),
    headline: { metric: 'checks passing: dataset and split hashes, rebuilt S7/S8 inputs, recounts of the S7 pair and LongMemEval arms, verdict numbers against receipts, matched-pair definitions', denominator: '42 checks over 11 datasets, 77 upstream receipt files and 15 evaluation definitions' },
    gate: 'gate', promotion: LEGACY_VERDICT_GATE, evidence_maturity: 'regression-only',
    contract: 'Checks the committed record of gbrain\'s 2026-09-30 System One v1 eval without running gbrain: recomputes gbrain\'s dataset and split hashes for every committed dataset, rebuilds the S7 and S8 inputs from the Cat 35 corpus plus the committed synthetic files and compares tree hashes, recounts the S7 triage pair and the LongMemEval arm summaries from per-item rows, checks every number in verdicts.json against its receipt pointer, and checks that each on arm has an off arm with the same data and settings apart from the slot under test. It proves the record is internally consistent and unedited; it does not re-measure Jev.',
  },
  {
    id: 'system-one-jev', legacy_alias: 'SO-live', name: 'System One (Jev decision support) per-slot matched pairs, run against a gbrain checkout',
    family: 'agent', tier: 'P', script: 'eval/runner/system-one-jev.ts',
    run: { kind: 'listed', reason: 'needs a gbrain checkout with the --decide eval flags (feat/system-one-v1 or later) and a TypeSafe Jev key; most arms also need OpenAI, Voyage and Anthropic keys', command: 'bun eval/runner/system-one-jev.ts run --gbrain <checkout>@<ref> --eval <evaluation id or slot> --yes' },
    cost_estimate: { usd: 24.95, basis: 'measured: the 2026-09-30 run of every slot, including dataset building, spent $24.95 (docs/benchmarks/2026-09-30-system-one-jev ledgers)' },
    receipt_path: 'eval/reports/system-one-jev/<evaluation id>/run.json, summary.json and analyze-*.json',
    headline: { metric: 'per slot, the slot\'s own metric off vs on: S7 synthesis-worthy transcripts passed and routine rejected, S9 supersedes found and wrong proposals, S1-S3 strict recall_all@5 and R@1, S6 know-to-ask failures and false fires, S8 quarantine precision and unsupported caught', denominator: 'eval half of each frozen split: 109 transcripts (S7), 395 fact pairs (S9), 248 LongMemEval-S questions with 233 answerable (S1-S3), 343 turns (S6), 496 claim units (S8), 424 routing queries (S2)' },
    gate: 'report-only', evidence_maturity: 'synthetic-production-path',
    contract: 'Runs gbrain\'s nine System One decision slots as matched pairs through the gbrain commands they change (eval longmemeval, eval brainbench and decide judge-agreement with --decide, and the checkout\'s triage-pair and dataset runners), with the same commit, data and seed in both arms. Labels come from generators, benchmark annotations or an LLM; none is a human hand label, so S8 in particular is judge-vs-model agreement. Jev is a hosted model: the same request can return slightly different probabilities, which the retest arms measure. A run with --limit is a smoke and is not comparable with the published numbers.',
  },
  {
    id: 'multi-adapter', legacy_alias: 'multi-adapter', name: 'Multi-adapter relational, fuzzy and external query families',
    family: 'relationships', tier: 'P', script: 'eval/runner/multi-adapter.ts', run: { kind: 'dispatched', timeoutMs: 2 * HOUR },
    cost_estimate: UNMEASURED, receipt_path: receipt('multi-adapter'),
    headline: { metric: 'Precision@5 and Recall@5 per adapter and query family', denominator: 'world-v1 relational, fuzzy and external query families' },
    gate: 'report-only', promotion: REPORT_ONLY, evidence_maturity: 'regression-only',
    contract: 'Compares adapters on world-v1 query families. The old "gbrain" row was a template parser and is invalid as a product score.',
  },
  {
    id: 'relational-ab', legacy_alias: 'relational-ab', name: 'Relational retrieval off vs on',
    family: 'relationships', tier: 'K', script: 'eval/runner/relational-ab.ts', run: { kind: 'dispatched', outputFlag: '--output-dir', timeoutMs: 2 * HOUR },
    cost_estimate: { usd: 0.07, basis: 'measured 2026-09-29: $0.0645 of OpenAI embeddings in the budget ledger for 3 seeds x 2 splits (docs/benchmarks/2026-09-29-relational-paraphrase)' }, receipt_path: 'eval/reports/relational-ab/<output>/receipt.json',
    headline: { metric: 'Recall@5 and hit@1 with relational retrieval off vs on over one index, template vs paraphrase wording', denominator: '145 questions x 2 wordings x 3 seeds' },
    gate: 'report-only', promotion: REPORT_ONLY, evidence_maturity: 'synthetic-production-path',
    contract: 'Toggles only relational retrieval over a shared index and pairs outcomes per question, on the template questions (the parser\'s own verbs) and on a frozen paraphrase of each. Report distinct-question gains beside pair gains, and the paraphrase split beside the template split.',
  },
  {
    id: 'precisionmembench', legacy_alias: 'precisionmembench', name: 'PrecisionMemBench',
    family: 'retrieval', tier: 'P', script: 'eval/runner/precisionmembench.ts', run: { kind: 'dispatched', timeoutMs: 2 * HOUR },
    cost_estimate: UNMEASURED, receipt_path: receipt('precisionmembench'),
    headline: { metric: 'precision per vendored category', denominator: 'vendored PrecisionMemBench items; see docs/benchmarks/2026-05-29-precisionmembench.md' },
    gate: 'report-only', promotion: REPORT_ONLY, evidence_maturity: 'synthetic-production-path',
    contract: 'Runs the vendored PrecisionMemBench search categories through gbrain adapters and scores precision per category. The keyword adapter runs keyless; the other adapters need provider keys. The items are vendored from the outside benchmark, not written here.',
  },
  {
    id: 'longmemeval-retrieval', legacy_alias: 'longmemeval', name: 'LongMemEval retrieval',
    family: 'retrieval', tier: 'P', script: 'eval/runner/longmemeval.ts',
    run: { kind: 'listed', reason: 'needs the downloaded LongMemEval dataset path and a multi-hour batch', command: 'bash eval/runner/longmemeval-batch.sh --dataset <longmemeval_s_cleaned.json>' },
    cost_estimate: { usd: 2, basis: 'historical cold embedding cost about $2 for LongMemEval-S (docs/benchmarks/2026-09-09-retrieval-refresh.md); rerank arms add Voyage spend' },
    receipt_path: receipt('longmemeval'),
    headline: { metric: 'strict recall_all@5 of labeled evidence sessions', denominator: '470 answerable LongMemEval-S questions (30 abstention questions excluded)' },
    gate: 'report-only', evidence_maturity: 'synthetic-production-path',
    contract: 'Imports each question\'s haystack sessions and checks every labeled evidence session is in the top five. The configuration was chosen on the same 470 questions, so they are development data (amendment 1). Embedding and provider failures are errors, never misses.',
  },
  {
    id: 'longmemeval-answers', legacy_alias: 'longmemeval-answers', name: 'LongMemEval answer grounding check',
    family: 'reasoning', tier: 'P', script: 'eval/runner/longmemeval-answers.ts',
    run: { kind: 'listed', reason: 'needs a retained LongMemEval evidence stream from a retrieval run', command: 'bun eval/runner/longmemeval-answers.ts' },
    cost_estimate: UNMEASURED, receipt_path: receipt('longmemeval-answers'),
    headline: { metric: 'judged answer accuracy from retained evidence', denominator: 'questions in the retained evidence stream' },
    gate: 'report-only', evidence_maturity: 'synthetic-production-path',
    contract: 'Answers from the evidence a retrieval run retained and judges the answers. A secondary grounding check, not a matched QA comparison.',
  },
  {
    id: 'longmemeval-m-pilot', legacy_alias: 'longmemeval-m-pilot', name: 'LongMemEval-M paired pilot',
    family: 'retrieval', tier: 'P', script: 'eval/runner/longmemeval-m-pilot-live.ts',
    run: { kind: 'listed', reason: 'preregistered paid protocol with frozen package identities (gbrain-cues); run by its own scripts', command: 'bun eval/runner/longmemeval-m-pilot-live.ts' },
    cost_estimate: UNMEASURED, receipt_path: 'eval/reports/longmemeval-m-pilot/<stage>/stage-receipt.json',
    headline: { metric: 'paired B/C0/C1 evidence recall', denominator: '28 LongMemEval-M questions (all also in LongMemEval-S)' },
    gate: 'report-only', evidence_maturity: 'synthetic-production-path',
    contract: 'A distractor and scale stress test of memory cues; not an independent confirmation because every question also appears in LongMemEval-S.',
  },
  {
    id: 'reading-notes', legacy_alias: 'reading-notes', name: 'Reading notes reader A/B',
    family: 'reasoning', tier: 'P', script: 'eval/runner/reading-notes-run.ts',
    run: { kind: 'listed', reason: 'paid protocol with frozen request payloads; the offline recount runs in bun run test', command: 'bun eval/runner/reading-notes-run.ts' },
    cost_estimate: UNMEASURED, receipt_path: 'docs/benchmarks/2026-09-25-reading-notes/',
    headline: { metric: 'judged answer accuracy with vs without a notes step', denominator: '361 questions with complete evidence' },
    gate: 'report-only', evidence_maturity: 'synthetic-production-path',
    contract: 'Compares a direct reader with a notes-first reader on frozen request payloads. The reader saw labeled session ids, so the published result awaits a re-run.',
  },
  {
    id: 'memory-lifecycle', legacy_alias: 'lifecycle', name: 'Memory lifecycle across builds, engines and interfaces',
    family: 'maintenance', tier: 'H', script: 'eval/runner/lifecycle-experiment.ts',
    run: { kind: 'listed', reason: 'needs a gbrain checkout to build each compared revision, and Postgres for the postgres cells', command: 'bun eval/runner/lifecycle-experiment.ts --gbrain-repo <gbrain checkout>' },
    cost_estimate: { usd: 0, basis: 'local hash embedder; the runner strips provider keys from every child process' },
    receipt_path: 'docs/benchmarks/2026-09-29-lifecycle/primary/',
    headline: { metric: 'per-contract failure counts (acknowledged writes lost, forget scope, links and slugs after rename, private-page leaks)', denominator: '24 cells (4 builds x 2 engines x 3 interfaces), run twice' },
    gate: 'report-only', evidence_maturity: 'synthetic-production-path',
    contract: 'Follows one small vault through ingest, query, an embedding outage, corrections, reconcile, forget and restart, and scores what an agent can read at each checkpoint against the evaluator\'s own ledger. gbrain\'s doctor, integrity and invariant checks are never the answer key. It covers the scripted scenario only; timing-dependent counts can differ between repeat runs.',
  },
  {
    id: 'evidence-delivery', legacy_alias: 'evidence-delivery', name: 'Evidence delivery ablation (LongMemEval-S, frozen reranked hits)',
    family: 'reasoning', tier: 'P', script: 'eval/runner/evidence-delivery.ts',
    run: { kind: 'listed', reason: 'preregistered paid protocol on a frozen evidence manifest at a pinned gbrain commit; every paid step joins one campaign budget-ledger run', command: 'bun eval/runner/evidence-delivery.ts e1 --frozen-dir <dir> --dataset <longmemeval_s_cleaned.json> --out-dir <dir> --set pilot --arms <arms> --budget-run-id <campaign run>' },
    cost_estimate: { usd: 122, basis: 'bun eval/runner/evidence-delivery.ts costs: $122 at list prices for the whole program before retries ($153 with a 25% margin); the manifest caps the campaign at $400' },
    receipt_path: 'docs/benchmarks/2026-09-30-evidence-delivery/',
    headline: { metric: 'judged answer accuracy of each evidence-delivery policy against chunk and whole-page delivery, with provider-reported reader input tokens', denominator: '400 confirmatory LongMemEval-S questions (policies chosen on the 100-question pilot)' },
    gate: 'report-only', evidence_maturity: 'synthetic-production-path',
    contract: 'Freezes each question\'s reranked top-5 hits, their chunk text and every chunk of every hit page once at a pinned gbrain commit, then changes only the delivered evidence between arms (chunk, window, section, page, auto budgets, top-10 chunks, the harness page reader, and an agent that may fetch pages). The decision rule is an executable manifest committed before any paid run; LongMemEval-S is development data and the sealed set is the independent no-regression check.',
  },
  {
    id: 'sealed-confirmation', legacy_alias: 'sealed-confirmation', name: 'Sealed confirmation set (release decisions only)',
    family: 'retrieval', tier: 'P', script: 'eval/runner/sealed-confirmation.ts',
    run: { kind: 'listed', reason: 'private questions and labels; every run is a release decision that needs a committed preregistration', command: 'bun eval/runner/sealed-confirmation.ts run --questions <q.json> --out-dir <dir>' },
    cost_estimate: UNMEASURED, receipt_path: 'the score --out report path (aggregates only)',
    headline: { metric: 'recall of ledger gold sessions, optional official-prompt judged answer accuracy', denominator: '150 questions over 30 personas (120 answerable, 30 abstention)' },
    gate: 'report-only', evidence_maturity: 'independently-labeled-held-out',
    contract: 'Runs gbrain through the LongMemEval runner\'s code path on a separately written, frozen question set that no configuration was chosen on. Labels come from the generation ledger and open only at scoring time, after their bytes match the published SHA-256 commitment; every open is logged. It has not been opened yet, so no gbrain result exists.',
  },
  {
    id: 'situation-recall', legacy_alias: 'situation-recall', name: 'Situation-recall release comparator',
    family: 'retrieval', tier: 'P', script: 'eval/runner/situation-recall-orchestration.ts',
    run: { kind: 'listed', reason: 'release protocol, run against registered baselines rather than as a sweep category', command: 'bun eval/runner/situation-recall-orchestration.ts' },
    cost_estimate: UNMEASURED, receipt_path: 'eval/reports/situation-recall/<output>/',
    headline: { metric: 'paired clustered comparison of C1 vs C0 vs B with Holm correction', denominator: 'registered categories and probes in eval/regression/situation-recall-v1.json' },
    gate: 'report-only', evidence_maturity: 'regression-only',
    contract: 'Compares a memory-cue candidate with registered baselines across categories with clustered bootstrap intervals. Cue arms run on gbrain-cues.',
  },
  {
    id: 'shootout-cell', legacy_alias: 'shootout', name: 'Embedder x reranker shootout cell',
    family: 'retrieval', tier: 'P', script: 'eval/runner/shootout-driver.ts',
    run: { kind: 'listed', reason: 'single-cell driver parameterized per run', command: 'bun eval/runner/shootout-driver.ts' },
    cost_estimate: UNMEASURED, receipt_path: 'the --output path',
    headline: { metric: 'Precision@5 and Recall@5 for one embedder x reranker cell', denominator: 'the selected query subset' },
    gate: 'report-only', evidence_maturity: 'regression-only',
    contract: 'Scores one configuration cell; the shootout scripts assemble cells into a matrix.',
  },
  {
    id: 'qrels-regression', legacy_alias: 'qrels', name: 'qrels / baseline regression fixture',
    family: 'retrieval', tier: 'H', script: 'scripts/generate-v0.41-launch.ts',
    run: { kind: 'listed', reason: 'checked in CI; the corpus is synthesized from the queries, so it is a regression smoke only', command: 'bun scripts/generate-v0.41-launch.ts --check' },
    cost_estimate: FREE, receipt_path: 'baselines/ (compared, not written)',
    headline: { metric: 'mean Jaccard vs baseline and expected top-1 hit rate', denominator: '12 queries' },
    gate: 'gate', evidence_maturity: 'regression-only',
    contract: 'Keyword-only regression smoke against a committed baseline. The corpus is built from the queries, so it is never quality evidence.',
  },
];

/**
 * Plan ids of the 2026-10-01 eval-category wave. Their rows must carry
 * promotion rules from the first commit that adds them, and may not gate on
 * RUNNER_VERDICT (test/eval/registry.test.ts).
 */
export const WAVE_2026_10_ALIASES: readonly string[] = ['N1', 'N2', 'N5', 'A4', 'N7', 'N8', 'N9', 'N12', 'N13'];

/** Tier selection accepted by all.ts: registry tiers, plus the older offline/paid/all names. */
export type TierSelection = RegistryTier | 'offline' | 'paid' | 'all';

export function tiersFor(selection: TierSelection): ReadonlySet<RegistryTier> {
  if (selection === 'offline') return new Set(['H']);
  if (selection === 'paid') return new Set(['K', 'P']);
  if (selection === 'all') return new Set(['H', 'K', 'P']);
  return new Set([selection]);
}

export function registryEntry(idOrAlias: string): CategoryEntry | undefined {
  return REGISTRY.find(entry => entry.id === idOrAlias || entry.legacy_alias === idOrAlias);
}

/**
 * Every other file directly under eval/runner/ (tests excepted), with its
 * role. A file is either a registry entry's script or listed here;
 * test/eval/registry.test.ts fails on anything else, so a new runner cannot
 * land without a registry row or an explicit helper classification.
 * `part_of` names the registry entry the file belongs to, when it has one.
 */
export interface RunnerHelper { role: string; part_of?: string }

export const RUNNER_HELPERS: Readonly<Record<string, RunnerHelper>> = {
  'README-cat13-phase-e0.md': { role: 'protocol notes for the Cat13 ranker-wave phases', part_of: 'concept-search' },
  'adversarial-injections.ts': { role: 'injection generator and scorer used by Cat6', part_of: 'prose-autolink-precision' },
  'all.ts': { role: 'umbrella runner that dispatches registry entries' },
  'budget-ledger.ts': { role: 'shared paid-run reservation ledger' },
  'bug-ledger.ts': { role: 'shared gbrain bug ledger: validated entries and the Markdown view' },
  'evidence-auto-v2.ts': { role: 'auto v2 follow-up to the evidence-delivery study (decision manifest v2: LongMemEval sanity check and sealed E2)', part_of: 'evidence-delivery' },
  'cat13-gap-localize.ts': { role: 'Phase E1 diagnostic over Cat13 hybrid stages', part_of: 'concept-search' },
  'cat13-kacf-calibrate.ts': { role: 'Phase E2 keyword-floor calibration over Cat13', part_of: 'concept-search' },
  'cat30-skillopt-improvement.ts': { role: 'Cat30 runner, driven by run-skillopt-cats.sh', part_of: 'skillopt' },
  'cat31-skillopt-ablation.ts': { role: 'Cat31 runner, driven by run-skillopt-cats.sh', part_of: 'skillopt' },
  'cat32-skillopt-reward-hacking.ts': { role: 'Cat32 runner, driven by run-skillopt-cats.sh', part_of: 'skillopt' },
  'cat33-skillopt-transfer.ts': { role: 'Cat33 runner, driven by run-skillopt-cats.sh', part_of: 'skillopt' },
  'cat35-checks.ts': { role: 'mechanical Cat35 checks', part_of: 'transcript-distillation' },
  'cat35-judges.ts': { role: 'Cat35 judge prompts and calls', part_of: 'transcript-distillation' },
  'cat35-transcript-distill-chart.ts': { role: 'Cat35 chart renderer', part_of: 'transcript-distillation' },
  'cat36-corpus.ts': { role: 'Cat36 corpus loader', part_of: 'associative-retrieval-smoke' },
  'cat36-grounded-answers.ts': { role: 'Cat36 grounded-answer lane', part_of: 'associative-retrieval-live' },
  'cat36-operation-conformance.ts': { role: 'Cat36 operation-surface replay', part_of: 'associative-retrieval-live' },
  'cat36-production.ts': { role: 'Cat36 production runtime', part_of: 'associative-retrieval-smoke' },
  'cat36-scorer.ts': { role: 'Cat36 span-coverage scorer', part_of: 'associative-retrieval-smoke' },
  'cat36-snapshot.ts': { role: 'Cat36 index snapshot hashing', part_of: 'associative-retrieval-live' },
  'compare.ts': { role: 'paired run comparator CLI' },
  'eval-adapter-config.ts': { role: 'typed adapter config for matrix cells' },
  'gbrain-under-test.ts': { role: 'pinned gbrain or a copied --gbrain overlay, with receipt identity' },
  'gbrain-version.ts': { role: 'resolves the loaded gbrain version' },
  'hermetic-env.ts': { role: 'shared keyless environment: strips provider and TypeSafe keys, fresh GBRAIN_HOME, proves System One off' },
  'import-embedded.ts': { role: 'embedding-required import wrapper' },
  'judge.ts': { role: 'shared rubric judge' },
  'lifecycle-report.ts': { role: 'Markdown summary of lifecycle receipts', part_of: 'memory-lifecycle' },
  'llm-budget.ts': { role: 'shared LLM concurrency bucket' },
  'longmemeval-aggregate.ts': { role: 'LongMemEval receipt aggregator', part_of: 'longmemeval-retrieval' },
  'longmemeval-batch.sh': { role: 'LongMemEval multi-worker batch wrapper', part_of: 'longmemeval-retrieval' },
  'longmemeval-cache.ts': { role: 'LongMemEval embedding cache', part_of: 'longmemeval-retrieval' },
  'longmemeval-chart.ts': { role: 'LongMemEval chart renderer', part_of: 'longmemeval-retrieval' },
  'longmemeval-m-pilot-batch-payload.ts': { role: 'LongMemEval-M pilot batch payload builder', part_of: 'longmemeval-m-pilot' },
  'longmemeval-m-pilot-build.ts': { role: 'LongMemEval-M pilot index build', part_of: 'longmemeval-m-pilot' },
  'longmemeval-m-pilot-feasibility.ts': { role: 'LongMemEval-M pilot feasibility check', part_of: 'longmemeval-m-pilot' },
  'longmemeval-m-pilot-hypothetical-cost.ts': { role: 'LongMemEval-M pilot cost estimate', part_of: 'longmemeval-m-pilot' },
  'longmemeval-m-pilot-import-check.ts': { role: 'LongMemEval-M pilot import check', part_of: 'longmemeval-m-pilot' },
  'longmemeval-m-pilot-manifest.py': { role: 'LongMemEval-M pilot selection manifest', part_of: 'longmemeval-m-pilot' },
  'longmemeval-m-pilot-offset-audit.ts': { role: 'LongMemEval-M pilot offset audit', part_of: 'longmemeval-m-pilot' },
  'longmemeval-m-pilot-outcomes.ts': { role: 'LongMemEval-M pilot outcome recorder', part_of: 'longmemeval-m-pilot' },
  'longmemeval-m-pilot-replay.ts': { role: 'LongMemEval-M pilot replay', part_of: 'longmemeval-m-pilot' },
  'longmemeval-session-ids.ts': { role: 'opaque LongMemEval session ids', part_of: 'longmemeval-retrieval' },
  'longmemeval-validate-ndjson.ts': { role: 'LongMemEval NDJSON validator', part_of: 'longmemeval-retrieval' },
  'metrics.ts': { role: 'shared retrieval metrics' },
  'mutation-kit.ts': { role: 'scorer mutation kit: fake systems every category scorer must fail' },
  'paid-arm.ts': { role: 'paid-arm guard: --paid and --budget-run-id against the budget ledger' },
  'pins.ts': { role: 'declared gbrain pins from package.json' },
  'precisionmembench-instrument.ts': { role: 'PrecisionMemBench instrumentation sweep', part_of: 'precisionmembench' },
  'probe-accounting.ts': { role: 'shared probe accounting' },
  'promotion.ts': { role: 'evaluates preregistered promotion rules against a receipt' },
  'reading-notes-recount.ts': { role: 'keyless recount of the reading-notes artifacts', part_of: 'reading-notes' },
  'reading-notes-requests.ts': { role: 'offline reading-notes request builder', part_of: 'reading-notes' },
  'receipt.ts': { role: 'receipt schema, writer and validator' },
  'recorder.ts': { role: 'flight-recorder bundle emitter' },
  'retrieval-pins.ts': { role: 'pinned retrieval config' },
  'sealed-confirmation-lib.ts': { role: 'sealed-set contracts, commitments, access log and spend ledger', part_of: 'sealed-confirmation' },
  'situation-recall-associative.ts': { role: 'situation-recall associative lane', part_of: 'situation-recall' },
  'situation-recall-cat36.ts': { role: 'situation-recall Cat36 lane', part_of: 'situation-recall' },
  'situation-recall-contract.ts': { role: 'situation-recall contract', part_of: 'situation-recall' },
  'situation-recall-development.ts': { role: 'situation-recall development profile', part_of: 'situation-recall' },
  'situation-recall-experiment-policy.ts': { role: 'situation-recall experiment policy', part_of: 'situation-recall' },
  'situation-recall-native-18-24.ts': { role: 'situation-recall native collectors for Cats 18-24', part_of: 'situation-recall' },
  'situation-recall-native-2-4-6.ts': { role: 'situation-recall native collectors for Cats 2, 4, 6', part_of: 'situation-recall' },
  'situation-recall-native-35.ts': { role: 'situation-recall native collector for Cat35', part_of: 'situation-recall' },
  'situation-recall-native.ts': { role: 'situation-recall native observation types', part_of: 'situation-recall' },
  'situation-recall-observations.ts': { role: 'situation-recall observation helpers', part_of: 'situation-recall' },
  'situation-recall-programmatic.ts': { role: 'programmatic driver for Cats 5, 8 and 9', part_of: 'situation-recall' },
  'situation-recall-provenance.ts': { role: 'situation-recall provenance hashing', part_of: 'situation-recall' },
  'situation-recall-regression.ts': { role: 'situation-recall regression comparator', part_of: 'situation-recall' },
  'smoke.ts': { role: 'embedder-shootout pre-flight smoke', part_of: 'shootout-cell' },
  'synthetic-corpus-loader.ts': { role: 'synthetic-v1 corpus loader' },
  'tool-bridge.ts': { role: 'agent tool bridge' },
  'types.ts': { role: 'shared types' },
  'validate-data.ts': { role: 'committed data integrity validator' },
};

/** Subdirectories of eval/runner/ holding helper modules only. */
export const RUNNER_HELPER_DIRS: readonly string[] = ['adapters', 'evaluator', 'evidence-delivery', 'lifecycle', 'queries', 'stats', 'system-one'];
