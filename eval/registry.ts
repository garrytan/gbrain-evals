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
  gate: GateStatus;
  evidence_maturity: EvidenceMaturity;
  /** What the category claims to measure, what it does not, and what counts as an error. */
  contract: string;
}

const HOUR = 3_600_000;
const FREE = { usd: 0, basis: 'no provider calls' } as const;
const UNMEASURED = { usd: null, basis: 'unmeasured: no receipt records this runner\'s spend' } as const;
const receipt = (stem: string) => `eval/reports/${stem}/receipt.json`;

export const REGISTRY: readonly CategoryEntry[] = [
  {
    id: 'relational-graph-first', legacy_alias: '1', name: 'Relational retrieval before/after graph traversal (world-v1)',
    family: 'relationships', tier: 'H', script: 'eval/runner/before-after.ts', run: { kind: 'dispatched' },
    cost_estimate: FREE, receipt_path: receipt('before-after'),
    headline: { metric: 'Recall@5 and Precision@5 of relational gold pages, graph-first vs text-only ordering', denominator: '145 relational questions; Precision@5 divides by 5 slots per question (725)' },
    gate: 'gate', evidence_maturity: 'regression-only',
    contract: 'Imports world-v1 into PGLite, answers "who works at / invested in / advises / attended" questions once with text search only and once with typed graph edges ranked first, and scores the top five pages against gold derived from the corpus _facts. It shows whether graph traversal moves correct pages up; set metrics are nearly identical by construction because graph hits are a subset of text hits. The gold comes from the same generator as the pages, so this is a regression check, not an independent quality claim.',
  },
  {
    id: 'link-type-accuracy', legacy_alias: '2', name: 'Link type accuracy (world-v1)',
    family: 'extraction', tier: 'H', script: 'eval/runner/type-accuracy.ts', run: { kind: 'dispatched' },
    cost_estimate: FREE, receipt_path: receipt('type-accuracy'),
    headline: { metric: 'type accuracy (correct / (correct + mistyped)) and strict (from, to, type) F1', denominator: '280 gold edges from world-v1 _facts; type accuracy counts only found edges (146 at b80cad6)' },
    gate: 'gate', evidence_maturity: 'regression-only',
    contract: 'Runs extractPageLinks on every world-v1 page and compares the typed edges with gold derived from _facts. Edges are oriented the way gbrain stores them (attendance person -> meeting). Every inferred type that differs from gold is charged as spurious, so emitting every type cannot score well. It measures extraction on generator-written prose; it says nothing about prose the generator did not write.',
  },
  {
    id: 'alias-keyword-lookup', legacy_alias: '3', name: 'Identity resolution through keyword search',
    family: 'retrieval', tier: 'H', script: 'eval/runner/identity.ts', run: { kind: 'dispatched' },
    cost_estimate: FREE, receipt_path: receipt('identity'),
    headline: { metric: 'documented and undocumented alias recall through searchKeyword', denominator: '800 alias lookups (400 undocumented)' },
    gate: 'gate', evidence_maturity: 'regression-only',
    contract: 'Looks people up by aliases (handles, nicknames, misspellings) through keyword search and checks the canonical page ranks first. An alias counts as documented when its text appears on the page. It measures lexical identity lookup only, not entity resolution or merging.',
  },
  {
    id: 'timeline-round-trip', legacy_alias: '4', name: 'Timeline storage round-trip',
    family: 'temporal', tier: 'H', script: 'eval/runner/temporal.ts', run: { kind: 'dispatched' },
    cost_estimate: FREE, receipt_path: receipt('temporal'),
    headline: { metric: 'pass rate of point, range, recency and as-of timeline checks', denominator: '114 timeline probes' },
    gate: 'gate', evidence_maturity: 'regression-only',
    contract: 'Writes timeline entries and reads them back by point, range, recency and as-of filters (the as-of filter is applied by the harness). It proves storage and retrieval of dated entries, not temporal reasoning over natural-language questions.',
  },
  {
    id: 'source-attribution', legacy_alias: '5', name: 'Source attribution / provenance',
    family: 'reasoning', tier: 'none', script: 'eval/runner/cat5-provenance.ts',
    run: { kind: 'listed', reason: 'not implemented: no reviewed claim catalog exists (the one-claim gold/citations.json template was removed in 0.10.7), and the runner has no gbrain in the loop' },
    cost_estimate: UNMEASURED, receipt_path: receipt('cat5-provenance'),
    headline: { metric: 'none until a reviewed claim catalog exists', denominator: 'none' },
    gate: 'report-only', evidence_maturity: 'regression-only',
    contract: 'Intended to check whether answers attribute claims to the right source. It cannot run: there is no reviewed claim catalog and no gbrain call in the loop.',
  },
  {
    id: 'prose-autolink-precision', legacy_alias: '6', name: 'Auto-link precision under prose',
    family: 'extraction', tier: 'H', script: 'eval/runner/cat6-prose-scale.ts', run: { kind: 'dispatched' },
    cost_estimate: FREE, receipt_path: receipt('cat6-prose-scale'),
    headline: { metric: 'extractor recall and labeled precision under injected prose traps', denominator: '250 injection probes (code fences, substring traps, ambiguous roles)' },
    gate: 'gate', evidence_maturity: 'regression-only',
    contract: 'Injects prose that should or should not create links (code fences, substring traps, ambiguous roles) and scores the extracted links. Precision is measured on labeled injections only, and one known capability-gap kind is excluded, so a pass is a regression result.',
  },
  {
    id: 'pglite-latency', legacy_alias: '7', name: 'Performance / latency',
    family: 'performance', tier: 'H', script: 'eval/runner/perf.ts', run: { kind: 'dispatched', exclusive: true },
    cost_estimate: FREE, receipt_path: receipt('perf'),
    headline: { metric: 'PGLite operation latency p50/p95/p99 and bulk throughput', denominator: '1K and 10K page brains; per-operation samples' },
    gate: 'gate', evidence_maturity: 'regression-only',
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
    gate: 'gate', evidence_maturity: 'regression-only',
    contract: 'Feeds malformed and hostile pages through import and read paths and fails on a crash, hang or corrupted read-back. It covers the listed cases only; it is not a fuzzing result.',
  },
  {
    id: 'text-ingestion-fidelity', legacy_alias: '11', name: 'Text ingestion fidelity (md/html; audio needs a key)',
    family: 'ingestion', tier: 'H', script: 'eval/runner/cat11-multimodal.ts', run: { kind: 'dispatched' },
    cost_estimate: FREE, receipt_path: receipt('cat11-multimodal'),
    headline: { metric: 'word recall of stored chunks against the source text', denominator: '5 fixtures; markdown floor 0.90, HTML floor 0.80' },
    gate: 'gate', evidence_maturity: 'regression-only',
    contract: 'Imports Markdown and HTML fixtures and checks how much of the source text survives into stored chunks. Audio and PDF are skipped without a key and are never counted as a pass. Recall only; it does not score extra or garbled text.',
  },
  {
    id: 'mcp-operation-contract', legacy_alias: '12', name: 'MCP operation contract',
    family: 'safety', tier: 'H', script: 'eval/runner/mcp-contract.ts', run: { kind: 'dispatched' },
    cost_estimate: FREE, receipt_path: receipt('mcp-contract'),
    headline: { metric: 'operation contract assertions passed (trust boundary, caps, injection)', denominator: '24 assertions' },
    gate: 'gate', evidence_maturity: 'regression-only',
    contract: 'Calls operations as trusted local and untrusted remote callers and asserts the trust boundary, result caps and injection handling. It covers the asserted operations, not every operation gbrain exposes.',
  },
  {
    id: 'concept-search', legacy_alias: '13', name: 'Conceptual search (live embeddings)',
    family: 'retrieval', tier: 'P', script: 'eval/runner/cat13-conceptual.ts', run: { kind: 'dispatched', timeoutMs: 2 * HOUR },
    cost_estimate: { usd: 3, basis: 'about $3 for Cat 13 in the 2026-09-09 retrieval refresh component estimate; cold embeddings' },
    receipt_path: receipt('cat13-conceptual'),
    headline: { metric: 'nDCG@5 and top-1 on conceptual probes, per adapter', denominator: '548 probes; 181 conceptual-only probes for the top-1 comparison' },
    gate: 'report-only', evidence_maturity: 'synthetic-production-path',
    contract: 'Asks paraphrased, concept-level questions over a synthetic corpus and compares gbrain, vectors, fusion and keyword search. The held-out concepts were reused to pick defaults, so it is development data (amendment 1). Embedding failures are errors, never misses.',
  },
  {
    id: 'source-swamp', legacy_alias: '13b', name: 'Source swamp: curated notes vs bulk chat (live embeddings)',
    family: 'retrieval', tier: 'P', script: 'eval/runner/cat13b-source-swamp.ts', run: { kind: 'dispatched', timeoutMs: HOUR },
    cost_estimate: UNMEASURED, receipt_path: receipt('cat13b-source-swamp'),
    headline: { metric: 'top-1 and top-3 curated-note hits with and without the source boost', denominator: '30 queries over 20 pages' },
    gate: 'report-only', evidence_maturity: 'synthetic-production-path',
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
    gate: 'report-only', evidence_maturity: 'regression-only',
    contract: 'Compares think answers with and without calibration context under a blind judge. The May 18 result is retracted because the judge saw the expected behavior; n=8 cannot support a quality claim.',
  },
  {
    id: 'propose-takes', legacy_alias: '15', name: 'propose_takes extraction (live model)',
    family: 'extraction', tier: 'P', script: 'eval/runner/cat15-propose-takes.ts', run: { kind: 'dispatched', timeoutMs: HOUR },
    cost_estimate: UNMEASURED, receipt_path: receipt('cat15-propose-takes'),
    headline: { metric: 'precision, recall and F1 of extracted takes', denominator: '48 labeled claims' },
    gate: 'report-only', evidence_maturity: 'regression-only',
    contract: 'Runs the product propose_takes prompt over labeled passages and scores extracted takes against the labels. Small and in-sample.',
  },
  {
    id: 'embedding-providers', legacy_alias: '18', name: 'Embedding providers',
    family: 'retrieval', tier: 'P', script: 'eval/runner/cat18-embedding-providers.ts', run: { kind: 'dispatched', timeoutMs: HOUR },
    cost_estimate: UNMEASURED, receipt_path: receipt('cat18-embedding-providers'),
    headline: { metric: 'Recall@10 and MRR per embedder through hybrid search, reranker off', denominator: 'synthetic-v1 derived queries per provider cell' },
    gate: 'report-only', evidence_maturity: 'synthetic-production-path',
    contract: 'Compares OpenAI and Voyage embedders through the same hybrid pipeline with the reranker pinned off. Cells with incomplete embedding coverage are invalid and every planned probe is recorded as a dependency error. ZeroEntropy was retired on 2026-09-04 and is no longer a cell.',
  },
  {
    id: 'embedder-reranker-matrix', legacy_alias: '18b', name: 'Embedder x reranker matrix',
    family: 'retrieval', tier: 'P', script: 'eval/runner/cat18b-embedding-rerank-matrix.ts', run: { kind: 'dispatched', timeoutMs: HOUR },
    cost_estimate: UNMEASURED, receipt_path: receipt('cat18b-embedding-rerank-matrix'),
    headline: { metric: 'Recall@10, MRR and top-1 deltas from adding voyage:rerank-2.5', denominator: '4 cells (OpenAI 1536d and Voyage 1024d, each with and without the reranker)' },
    gate: 'report-only', evidence_maturity: 'synthetic-production-path',
    contract: 'Isolates what the reranker adds on top of each embedder; only the reranker keys differ within a pair. A reranked query without a rerank score is a dependency failure, so a missing key cannot publish unreranked numbers under a reranked label.',
  },
  {
    id: 'doctor-remediation', legacy_alias: '19', name: 'Sick-brain remediation loop (hash embeddings)',
    family: 'maintenance', tier: 'H', script: 'eval/runner/cat19-doctor-remediate.ts', run: { kind: 'dispatched' },
    cost_estimate: FREE, receipt_path: receipt('cat19-doctor-remediate'),
    headline: { metric: 'remediation gates passed after extract and embed', denominator: '5 gates' },
    gate: 'gate', evidence_maturity: 'regression-only',
    contract: 'Builds a deliberately unhealthy brain, runs extraction and embedding, and checks the health recommendations converge. It does not run doctor --remediate itself and uses hash embeddings.',
  },
  {
    id: 'brainstorm-grounding', legacy_alias: '20', name: 'Brainstorm grounding (live model and judge)',
    family: 'reasoning', tier: 'P', script: 'eval/runner/cat20-brainstorm.ts', run: { kind: 'dispatched', timeoutMs: HOUR },
    cost_estimate: UNMEASURED, receipt_path: receipt('cat20-brainstorm'),
    headline: { metric: 'grounded idea rate and judged novelty', denominator: '3 prompts' },
    gate: 'report-only', evidence_maturity: 'regression-only',
    contract: 'Runs the brainstorm orchestrator and scores grounding and novelty with a judge. n=3 and partly vacuous grounding checks; not a quality claim.',
  },
  {
    id: 'code-retrieval', legacy_alias: '21', name: 'Code retrieval (live embeddings)',
    family: 'retrieval', tier: 'P', script: 'eval/runner/cat21-code-retrieval.ts', run: { kind: 'dispatched', timeoutMs: HOUR },
    cost_estimate: UNMEASURED, receipt_path: receipt('cat21-code-retrieval'),
    headline: { metric: 'top-1 and Recall@5 of the file defining a symbol', denominator: '12 symbol queries over gbrain src/core' },
    gate: 'report-only', evidence_maturity: 'regression-only',
    contract: 'Ingests gbrain source files as Markdown-wrapped code and looks up symbols by name. The corpus changes with the pin, so results are only comparable at one pin.',
  },
  {
    id: 'source-isolation', legacy_alias: '22', name: 'Source isolation',
    family: 'safety', tier: 'H', script: 'eval/runner/cat22-source-isolation.ts', run: { kind: 'dispatched' },
    cost_estimate: FREE, receipt_path: receipt('cat22-source-isolation'),
    headline: { metric: 'cross-source leaks across search, keyword, graph and get surfaces, with negative controls', denominator: '8 probes' },
    gate: 'gate', evidence_maturity: 'regression-only',
    contract: 'Seeds several sources and asserts a scoped read never returns another source, while negative controls prove the probes can detect a leak. Zero leaks here is a regression result for the probed surfaces.',
  },
  {
    id: 'phantom-redirect', legacy_alias: '23', name: 'Phantom to canonical redirect',
    family: 'maintenance', tier: 'H', script: 'eval/runner/cat23-phantom-redirect.ts', run: { kind: 'dispatched' },
    cost_estimate: FREE, receipt_path: receipt('cat23-phantom-redirect'),
    headline: { metric: 'phantom pages redirected to the right canonical page', denominator: '9 cases' },
    gate: 'gate', evidence_maturity: 'regression-only',
    contract: 'Creates stub (phantom) pages beside canonical ones and checks the redirect decision. It mirrors rather than calls one product function.',
  },
  {
    id: 'capture-provenance', legacy_alias: '24', name: 'Capture provenance',
    family: 'ingestion', tier: 'H', script: 'eval/runner/cat24-capture-provenance.ts', run: { kind: 'dispatched' },
    cost_estimate: FREE, receipt_path: receipt('cat24-capture-provenance'),
    headline: { metric: 'provenance fields written through each ingest path, plus dedup', denominator: '7 probes' },
    gate: 'gate', evidence_maturity: 'regression-only',
    contract: 'Imports through each capture path and checks source kind, URI and ingestion method are stored and preserved. The dedup probe is weak.',
  },
  {
    id: 'trajectory-routing', legacy_alias: '25', name: 'Trajectory routing in think (live model)',
    family: 'reasoning', tier: 'P', script: 'eval/runner/cat25-trajectory-routing.ts', run: { kind: 'dispatched', timeoutMs: HOUR },
    cost_estimate: UNMEASURED, receipt_path: receipt('cat25-trajectory-routing'),
    headline: { metric: 'think answers with vs without trajectory routing', denominator: 'synthetic-v1 temporal probes' },
    gate: 'report-only', evidence_maturity: 'regression-only',
    contract: 'Checks think routes temporal questions to trajectory data. The hermetic mode proves wiring only.',
  },
  {
    id: 'contextual-retrieval', legacy_alias: '26', name: 'Contextual retrieval modes (live embeddings)',
    family: 'retrieval', tier: 'P', script: 'eval/runner/cat26-contextual-retrieval.ts', run: { kind: 'dispatched', timeoutMs: HOUR },
    cost_estimate: UNMEASURED, receipt_path: receipt('cat26-contextual-retrieval'),
    headline: { metric: 'Recall@3 and MRR per contextual retrieval mode', denominator: 'synthetic-v1 derived queries per mode' },
    gate: 'report-only', evidence_maturity: 'regression-only',
    contract: 'Compares chunk-embedding modes (none, title prefix, synopsis). The stub contrast is tuned, so offline runs are plumbing checks.',
  },
  {
    id: 'graph-signals', legacy_alias: '27', name: 'Graph signals on/off',
    family: 'relationships', tier: 'H', script: 'eval/runner/cat27-graph-signals.ts', run: { kind: 'dispatched' },
    cost_estimate: FREE, receipt_path: receipt('cat27-graph-signals'),
    headline: { metric: 'nDCG@10 and top-1 with graph signals on vs off', denominator: '4 probes' },
    gate: 'gate', evidence_maturity: 'regression-only',
    contract: 'Runs the same queries with graph ranking signals on and off; only that knob differs. Four probes; a no-op can still pass.',
  },
  {
    id: 'federated-sync-latency', legacy_alias: '28', name: 'Federated sync latency',
    family: 'performance', tier: 'H', script: 'eval/runner/cat28-federated-sync-latency.ts', run: { kind: 'dispatched', exclusive: true },
    cost_estimate: FREE, receipt_path: receipt('cat28-federated-sync-latency'),
    headline: { metric: 'wall-clock of serial vs interleaved imports across sources', denominator: 'fixed import workload per mode' },
    gate: 'gate', evidence_maturity: 'regression-only',
    contract: 'A microbenchmark of the engine write path (no embeddings), run alone. It is not a sync-service latency claim.',
  },
  {
    id: 'think-vs-search', legacy_alias: '29', name: 'think vs raw search payload (live model and judge)',
    family: 'reasoning', tier: 'P', script: 'eval/runner/cat29-think-vs-search.ts', run: { kind: 'dispatched', timeoutMs: HOUR },
    cost_estimate: UNMEASURED, receipt_path: receipt('cat29-think-vs-search'),
    headline: { metric: 'judged answer quality of think vs a raw search payload', denominator: '5 questions' },
    gate: 'report-only', evidence_maturity: 'regression-only',
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
    gate: 'gate', evidence_maturity: 'regression-only',
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
    gate: 'report-only', evidence_maturity: 'synthetic-production-path',
    contract: 'Ingests synthetic transcripts through the product ingest, fact extraction and synthesis phases and checks which labeled facts survive with evidence and which claims are invented. The result is in-sample; judge-only retention overstates evidence-verified retention.',
  },
  {
    id: 'associative-retrieval-smoke', legacy_alias: '36', name: 'Associative retrieval (offline keyword plumbing only; not capability evidence)',
    family: 'retrieval', tier: 'H', script: 'eval/runner/cat36-associative-retrieval.ts',
    run: { kind: 'dispatched', args: ['--offline', '--smoke'], outputFlag: '--output', timeoutMs: 180_000 },
    cost_estimate: FREE, receipt_path: 'eval/reports/cat36-associative-retrieval/<output>/receipt.json',
    headline: { metric: 'required spans covered in the top five chunks (plumbing only)', denominator: 'smoke subset of associative probes' },
    gate: 'gate', evidence_maturity: 'regression-only',
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
    id: 'multi-adapter', legacy_alias: 'multi-adapter', name: 'Multi-adapter relational, fuzzy and external query families',
    family: 'relationships', tier: 'P', script: 'eval/runner/multi-adapter.ts', run: { kind: 'dispatched', timeoutMs: 2 * HOUR },
    cost_estimate: UNMEASURED, receipt_path: receipt('multi-adapter'),
    headline: { metric: 'Precision@5 and Recall@5 per adapter and query family', denominator: 'world-v1 relational, fuzzy and external query families' },
    gate: 'report-only', evidence_maturity: 'regression-only',
    contract: 'Compares adapters on world-v1 query families. The old "gbrain" row was a template parser and is invalid as a product score.',
  },
  {
    id: 'relational-ab', legacy_alias: 'relational-ab', name: 'Relational retrieval off vs on',
    family: 'relationships', tier: 'P', script: 'eval/runner/relational-ab.ts', run: { kind: 'dispatched', outputFlag: '--output-dir', timeoutMs: 2 * HOUR },
    cost_estimate: UNMEASURED, receipt_path: 'eval/reports/relational-ab/<output>/receipt.json',
    headline: { metric: 'Recall@5 and hit@1 with relational retrieval off vs on over one index', denominator: '145 questions x 3 seeds' },
    gate: 'report-only', evidence_maturity: 'synthetic-production-path',
    contract: 'Toggles only relational retrieval over a shared index and pairs outcomes per question. Report distinct-question gains beside pair gains.',
  },
  {
    id: 'precisionmembench', legacy_alias: 'precisionmembench', name: 'PrecisionMemBench',
    family: 'retrieval', tier: 'P', script: 'eval/runner/precisionmembench.ts', run: { kind: 'dispatched', timeoutMs: 2 * HOUR },
    cost_estimate: UNMEASURED, receipt_path: receipt('precisionmembench'),
    headline: { metric: 'precision per vendored category', denominator: 'vendored PrecisionMemBench items; see docs/benchmarks/2026-05-29-precisionmembench.md' },
    gate: 'report-only', evidence_maturity: 'synthetic-production-path',
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
