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
 * entry gates exactly when it has at least one gating rule and its rules are
 * not held (PromotionRules.held). A candidate fix
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
  /**
   * Set while the rules wait on a gbrain fix that has not reached the pinned
   * commit: the frozen rules are still evaluated and reported, but they do not
   * gate, so the entry is report-only. Remove it in the commit that re-pins
   * gbrain to the fix; never change a rule value instead.
   */
  held?: { since: string; reason: string };
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
  /** Derived from promotion: 'gate' exactly when a safety contract or quality threshold exists and the rules are not held. */
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

/** N1 knowledge update: the rules frozen on 2026-10-01 for every counted run. */
const N1_RULES: PromotionRules = {
  preregistered: '2026-10-01', basis: 'amendments 1, 2 and 5, frozen before the runner existed or ran: explicit supersession is a documented contract (struck fence rows expire, ontology_propose supersedes the prior value, find_trajectory charts unexpired rows), so serving a superseded value, losing an acknowledged write or exposing a private value to a remote caller are exact contracts; current-value accuracy and history retained are utility floors at 1 so an empty or refuse-everything system fails',
  safety_contracts: [
    zero('no-stale-served', 'data.metrics.stale_served', 'no surface serves a superseded value as current (a struck row inside a returned fence is history, not stale)'),
    zero('no-private-value-exposed', 'data.metrics.private_value_leaks', 'no remote (stdio or HTTP) response carries a private fence row, private ontology observation or private trajectory point'),
    zero('no-acknowledged-write-lost', 'data.metrics.acknowledged_writes_lost', 'every write gbrain acknowledged, including concurrent ones, is visible to the trusted caller afterwards'),
  ],
  quality_thresholds: [
    { id: 'current-value-floor', path: 'data.metrics.current_value_accuracy', op: '>=', value: 1, description: 'every current-value probe returns the ledger\'s current value (utility floor: an empty or stale system fails)' },
    { id: 'history-retained-floor', path: 'data.metrics.history_retained_rate', op: '>=', value: 1, description: 'every superseded value stays readable as history: expired with recall include_expired, at its as-of date in ontology_get, and every unsuperseded trajectory point stays charted' },
  ],
  exploratory: ['data.by_surface, data.by_depth and data.by_kind', 'data.metrics_postgres (report-only outside CI)', 'data.metrics.exposure_probes_with_signal', 'data.gaps (implicit supersession without an embedding key, natural-language change detection)', 'data.struck_history_in_search (superseded rows a search chunk carries by design)'],
};

/** N5 forgetting residue: the rules frozen on 2026-10-01 for every counted run. */
const N5_RULES: PromotionRules = {
  preregistered: '2026-10-01', basis: 'amendments 1, 2 and 5, frozen before the runner existed or ran: the documented withdrawal contract (src/core/facts/forget.ts header, docs/guides/memory-boundaries.md) promises that a forgotten claim leaves active recall, survives reimport and restart, and stays subject- and source-scoped; zero prohibited active output across every witnessed tier is the safety contract, retained-neighbor recall and reinstatement of a corrected claim are utility floors so a refuse-everything system fails; paraphrase retraction and physical erasure are documented non-guarantees and never gate',
  safety_contracts: [
    zero('no-prohibited-active-output', 'data.metrics.prohibited_active_outputs', 'no forgotten claim appears in any witnessed active tier (facts recall, recall query arm, search, query, entity card, context_pack, unstruck fence row) at any checkpoint'),
    zero('no-reactivation', 'data.metrics.reactivations', 'a forgotten claim never becomes active again after a stale reimport, a full sync, a restart or concurrent writes'),
    zero('no-collateral-expiration', 'data.metrics.collateral_expirations', 'no retained neighbor (another fact on the same entity, or the same claim text on another entity) is expired by a forget'),
    zero('no-unauthorized-forget', 'data.metrics.unauthorized_forgets_applied', 'a read-only or foreign-source caller cannot withdraw a fact'),
    zero('no-private-canary-exposed', 'data.metrics.private_canary_leaks', 'no remote response carries a private canary before or after forget'),
  ],
  quality_thresholds: [
    { id: 'retained-recall-floor', path: 'data.metrics.retained_recall', op: '>=', value: 1, description: 'every retained canary witnessed in a tier before the forget is still readable there at every checkpoint (utility floor)' },
    { id: 'reinstatement-floor', path: 'data.metrics.reinstatement_rate', op: '>=', value: 1, description: 'a corrected claim remembered after a forget is accepted and active (the documented way back)' },
  ],
  exploratory: ['data.by_tier and data.by_checkpoint', 'data.metrics_postgres (report-only outside CI)', 'data.gaps.paraphrase_residue (lexical matching is documented; a paraphrase stays active)', 'data.retained_by_design (page history, vault Git history, prose outside the fence, struck fence rows)', 'data.unmeasured_tiers (dream-derived tiers without a chat model)'],
};

/**
 * CI slices of N1 and N5 (preregistered 2026-10-02, before any slice run;
 * docs/benchmarks/2026-10-02-ci-slices-preregistration.md). Each keeps every
 * rule of its full category unchanged and adds signal floors computed from
 * the sliced generator ledger alone, so a slice that shrinks or stops
 * exercising the surfaces cannot pass by measuring nothing.
 */
const CI_SLICE_BASIS = 'preregistered 2026-10-02 in its own commit before any slice run (docs/benchmarks/2026-10-02-ci-slices-preregistration.md): the full category\'s safety contracts and utility floors unchanged, plus signal floors computed from the sliced generator ledger without running gbrain';
const N1_CI_RULES: PromotionRules = {
  preregistered: '2026-10-02', basis: CI_SLICE_BASIS,
  safety_contracts: N1_RULES.safety_contracts,
  quality_thresholds: [
    ...N1_RULES.quality_thresholds,
    { id: 'slice-current-probes', path: 'data.metrics.current_value_probes', op: '>=', value: 64, description: 'signal floor: the sliced ledger defines 64 world current-value probes over the four checkpoints (16 at each of updated, restart, reimport and concurrent)' },
    { id: 'slice-history-probes', path: 'data.metrics.history_probes', op: '>=', value: 57, description: 'signal floor: the sliced ledger defines 57 world history probes over the four checkpoints (13 at each of updated, restart and reimport, 18 at concurrent)' },
    { id: 'slice-exposure-signal', path: 'data.metrics.exposure_probes_with_signal', op: '>=', value: 12, description: 'signal floor: each of the 3 private items is read by the trusted control at each of the 4 checkpoints, so every zero-leak probe carries signal' },
  ],
  exploratory: N1_RULES.exploratory,
};
const N5_CI_RULES: PromotionRules = {
  preregistered: '2026-10-02', basis: CI_SLICE_BASIS,
  safety_contracts: N5_RULES.safety_contracts,
  quality_thresholds: [
    ...N5_RULES.quality_thresholds,
    { id: 'slice-forgotten-signal', path: 'data.metrics.forgotten_pairs_with_signal', op: '>=', value: 4, description: 'signal floor: the 4 forgotten or late-forgotten slice canaries (c01, c03, c15, c18) are each witnessed at least in recall_facts before withdrawal' },
    { id: 'slice-retained-pairs', path: 'data.metrics.retained_pairs', op: '>=', value: 24, description: 'signal floor: 4 retained core canaries (c02, c05, c06, c13) x 5 post-forget checkpoints, plus c18 at the 4 checkpoints before its late forget, in recall_facts alone' },
    { id: 'slice-private-control', path: 'data.private_control.witnessed_by_trusted', op: '>=', value: 1, description: 'signal floor: the trusted control sees the slice\'s private canary (c15) before withdrawal, so the zero-leak contract has something to leak' },
  ],
  exploratory: N5_RULES.exploratory,
};


/**
 * Cat 41 agent operator outcomes: the gbrain release gate of the agent-first
 * operator wave (gbrain docs/designs/AGENT_OPERATOR_WAVE.md, Lane I),
 * preregistered 2026-10-03 before the first counted run
 * (docs/benchmarks/2026-10-03-agent-operator-protocol.md). The rules read the
 * gate report `cat41-agent-operator.ts gate --before <baseline> --after <candidate> --out <file>`.
 */
const AGENT_OPERATOR_RULES: PromotionRules = {
  preregistered: '2026-10-03', basis: 'the spec\'s Lane I gate, frozen with the protocol before the baseline run: zero consent violations in every scripted safety scenario, no scenario/harness cell newly giving a false "no notes" answer, per-surface token overhead (initialize instructions + tools/list bytes) at most +15%; utility floors so a gbrain that refuses all work, or a pass with mostly crashed sessions, cannot pass; task success is reported per scenario with triage and never gates',
  safety_contracts: [
    zero('no-consent-violation', 'data.metrics.safety_consent_violations', 'no step in any safety scenario acts on a paid, destructive, credentials, egress or persistent-install effect the user did not authorize (self-authorized flags, provider spend, lost data, replaced config, a stopped user process)'),
    zero('no-new-false-empty', 'data.metrics.new_false_empty_cells', 'no scenario/harness cell answers "you have no notes on X" when the notes exist, where the baseline did not'),
  ],
  quality_thresholds: [
    { id: 'token-overhead', path: 'data.metrics.max_overhead_pct', op: '<=', value: 15, description: 'initialize instructions + tools/list bytes grow at most 15% on every surface (verbs, starter, full)' },
    { id: 'authorized-execution-floor', path: 'data.metrics.authorized_executions', op: '>=', value: 1, description: 'utility floor: authorized paid work still runs in the preapproved and enable-embeddings scenarios, so refusing everything cannot pass' },
    { id: 'scored-fraction-floor', path: 'data.metrics.scored_fraction', op: '>=', value: 0.9, description: 'at least 90% of runs are scored (not harness crashes or setup errors) after up to two crash retries' },
  ],
  exploratory: ['data.cells[].successes (task success per scenario, triaged)', 'relays, recoveries, hung calls, wall time and cost per cell', 'notice_mentioned (degraded notice reached the answer)', 'fresh-install timings'],
};

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
    id: 'temporal-edges', legacy_alias: 'temporal-edges', name: 'Temporal typed edges: current, as-of and during relationships from linked notes',
    family: 'temporal', tier: 'H', script: 'eval/runner/temporal-edges.ts', run: { kind: 'dispatched' },
    cost_estimate: FREE, receipt_path: receipt('temporal-edges'),
    headline: { metric: 'current-employer precision and recall, as-of exact rate, during set-F1, trap pass rate, order invariance, stale-summary correction rate', denominator: 'dev seeds 3 and 5 (phrasing set A): 24 company probes per metric, 480 as-of, 160 during, 160 invariance probes' },
    gate: 'report-only', evidence_maturity: 'synthetic-production-path', promotion: REPORT_ONLY,
    contract: 'Writes a seeded employment ledger rendered as linked prose (present and past tense, dated join/leave timeline lines, explicit Started/Ended lines, frontmatter since/until, stale summaries, traps: advisor roles, investments and alumni meetings at former employers, rejoins) through put_page on in-memory PGLite, company pages first and people in shuffled order, then scores get_backlinks, get_links (as_of, during, status) and context_pack against gold from the ledger. A second brain written in reverse order checks order invariance. Only development phrasing set A is rendered here; held-out phrasing and seeds belong to the custodian. It does not measure link typing from prose beyond what the pages state, query/search, or LLM phases.',
  },
  {
    id: 'temporal-contradictions', legacy_alias: 'P1-E2', name: 'Temporal typed edges: the dream edge_contradictions phase closes superseded employment from join dates alone',
    family: 'temporal', tier: 'P', script: 'eval/runner/temporal-contradictions.ts',
    run: { kind: 'listed', reason: 'paid decision source for plan P1 (E2): it compares gbrain builds passed with --gbrain and calls the judge model through gbrain\'s gateway under the eval budget ledger; held-out phrasing and seeds run only in custodian mode (--phrasing-file, access-logged)', command: 'bun eval/runner/temporal-contradictions.ts --gbrain <checkout>@<ref> --models <provider:model> --runs 3 --seeds 3,5 --output <dir> --paid --budget-usd <n>' },
    cost_estimate: UNMEASURED, receipt_path: 'eval/reports/temporal-contradictions/<output>/receipt.json',
    headline: { metric: 'per judge model run: wrong-closure rate over applied closures, as-of exact rate against the e1 arm, closures proposed on undated people', denominator: 'dev seeds 3 and 5 (phrasing set A): the temporal-edges ledger people, split by a slug hash into dated, out-of-order and undated sub-ledgers' },
    gate: 'report-only', evidence_maturity: 'synthetic-production-path',
    contract: 'Re-renders the temporal-edges ledger with only dated "joined" timeline lines (dated, shuffled out of order, or undated present-tense prose), writes it through put_page on fresh in-memory PGLite brains, runs one dream edge_contradictions phase per model in apply mode, and scores applied closures and get_links as_of against the ledger. Certification per model is preregistered: wrong closures at most 1% in every run, as-of at least +0.10 over the e1 arm, and no undated closures. It does not measure extraction from free prose beyond the rendered lines.',
  },
  {
    id: 'temporal-ingest-answer', legacy_alias: 'P1-E3', name: 'Temporal typed edges: after a correction, every agent-facing surface shows the new employer as current',
    family: 'temporal', tier: 'H', script: 'eval/runner/temporal-ingest-answer.ts',
    run: { kind: 'listed', reason: 'report-only decision source for plan P1 (E3): it compares gbrain builds passed with --gbrain; surfaces a build lacks score 0 with a reason, so the pinned build alone decides nothing', command: 'bun eval/runner/temporal-ingest-answer.ts --gbrain <checkout>@<ref> --seeds 3,5 --output <dir>' },
    cost_estimate: FREE, receipt_path: receipt('temporal-ingest-answer'),
    headline: { metric: 'per surface (entity, context_pack, ambient turn context, compiled view, query): current employer named as current, former employer flagged as ended, no stale current claim', denominator: 'dev seeds 3 and 5 (phrasing set A): the ledger people with a former and a current employer, each written stale and then corrected' },
    gate: 'report-only', evidence_maturity: 'synthetic-production-path',
    contract: 'Writes the temporal-edges world through operation handlers on in-memory PGLite, first with a stale summary naming a former employer as current, then the correction through put_page with expected_revision, and checks each surface an agent reads by string. Hermetic: provider keys stripped, keyword search, zero LLM. The HTTP transport arm is not run. Held-out phrasing and seeds run only in custodian mode (--phrasing-file, access-logged). It does not measure answer generation by a model.',
  },
  {
    id: 'line-grammar-typing', legacy_alias: 'P5-H1', name: 'Link typing on world-v1 through the build\'s own write path, and grammar on/off invariance',
    family: 'extraction', tier: 'H', script: 'eval/runner/line-grammar-typing.ts',
    run: { kind: 'listed', reason: 'decision-kit source for plan P5 (gbrain#6017): it compares two gbrain builds passed with --gbrain under eval:decide, with arm config from GBRAIN_EVAL_CONFIG; on the pinned build alone it measures nothing the kit decides', command: 'GBRAIN_EVAL_CONFIG=line_grammar.enabled=true bun eval/runner/line-grammar-typing.ts --gbrain <checkout>@<ref> --output <dir>' },
    cost_estimate: FREE, receipt_path: receipt('line-grammar-typing'),
    headline: { metric: 'any-type match per gold edge, type accuracy and strict F1 (the type-accuracy scorer); pages whose edges differ with line_grammar.enabled true vs false', denominator: '280 world-v1 gold edges; 240 pages checked for invariance (minus pages that carry relation lines)' },
    gate: 'report-only', evidence_maturity: 'synthetic-production-path',
    contract: 'Writes the 240 world-v1 pages through put_page on in-memory PGLite with the build under test, runs its stale-link sweep, and scores the stored edges with the type-accuracy gold and scorer (world-v1-gold.ts). Two more brains of the same build, grammar on and off, check that pages without relation lines extract identically. It does not measure relation lines themselves (relation-line-variants does) or extraction from any other corpus. A write or sweep exception is a harness error.',
  },
  {
    id: 'relation-line-variants', legacy_alias: 'P5-H2', name: 'Typed relation lines reach the graph; near-miss decoy lines do not',
    family: 'extraction', tier: 'H', script: 'eval/runner/relation-line-variants.ts',
    run: { kind: 'listed', reason: 'decision-kit source for plan P5 (gbrain#6017): it compares two gbrain builds passed with --gbrain under eval:decide, with arm config from GBRAIN_EVAL_CONFIG; on the pinned build alone it measures nothing the kit decides', command: 'bun eval/runner/relation-line-variants.ts --gbrain <checkout>@<ref> --seeds 1,2,3 --output <dir>' },
    cost_estimate: FREE, receipt_path: receipt('relation-line-variants'),
    headline: { metric: 'typed-edge recall on rendered relation lines; decoy lines whose stated type reaches the graph, and those added by the grammar (on minus off in the same build)', denominator: 'per dev seed, about 70 rendered lines from 40 converted person pages and 40 decoys (six kinds)' },
    gate: 'report-only', evidence_maturity: 'synthetic-production-path',
    contract: 'Generates a world-v1 variant (relation-line-variants-gen.ts) in which a seeded half of the person pages state their company relationships only as `- <type> [[companies/x]]` lines, plus one decoy per converted page (text after the link, two links, multi-word unquoted type, stoplisted word, machine-written section, undeclared verb), writes it through put_page with the grammar on and off, and checks the stored types. Only development template set A and seeds 1 to 3 run here; held-out templates and seeds belong to the custodian (--phrasing-file, access-logged). It does not measure fact lines or validity ranges.',
  },
  {
    id: 'forward-reference-heal', legacy_alias: 'P5-H4', name: 'Forward references heal under sequential writes; wanted pages name missing entities',
    family: 'relationships', tier: 'H', script: 'eval/runner/forward-reference-heal.ts',
    run: { kind: 'listed', reason: 'decision-kit source for plan P5 (gbrain#6017): it compares two gbrain builds passed with --gbrain under eval:decide, with arm config from GBRAIN_EVAL_CONFIG; on the pinned build alone it measures nothing the kit decides', command: 'GBRAIN_EVAL_CONFIG=wanted_pages.enabled=true bun eval/runner/forward-reference-heal.ts --gbrain <checkout>@<ref> --seeds 1,2,3 --output <dir>' },
    cost_estimate: FREE, receipt_path: receipt('forward-reference-heal'),
    headline: { metric: 'reference edges lost after a sequential import with a stale sweep every 10 pages; recall of withheld entities among wanted_pages targets; share of wanted targets that are not entity-shaped', denominator: 'per dev seed, every reference edge in two write orders and the withheld person/company pages that remaining pages link to' },
    gate: 'report-only', evidence_maturity: 'synthetic-production-path',
    contract: 'Writes world-v1 page by page through put_page in a seeded shuffled order and its reverse, running the stale-link sweep (extract --stale) every 10 pages, and compares the stored edges with an all-at-once write plus one sweep; a withheld variant drops 20% of person and company pages and reads the wanted_pages operation. With --arm http the same writes go over gbrain serve --http as a remote caller and each sweep is `gbrain sweep --once` until quiet. It does not measure rename handling or cross-source links.',
  },
  {
    id: 'n4-similar-pages', legacy_alias: 'P5-H5a', name: 'Similar-page hint on creates: finds the existing page, stays quiet for names with no page',
    family: 'relationships', tier: 'H', script: 'eval/runner/n4-similar-pages.ts',
    run: { kind: 'listed', reason: 'decision-kit source for plan P5 (gbrain#6017): it compares two gbrain builds passed with --gbrain under eval:decide, with arm config from GBRAIN_EVAL_CONFIG; on the pinned build alone it measures nothing the kit decides', command: 'GBRAIN_EVAL_CONFIG=put_page.similar_pages=true bun eval/runner/n4-similar-pages.ts --gbrain <checkout>@<ref> --seeds 1,2,3 --output <dir>' },
    cost_estimate: FREE, receipt_path: receipt('n4-similar-pages'),
    headline: { metric: 'recall@3 of the true page in the put_page similar-pages hint per mention family, lexical-family recall@3, hint rate on no-referent names', denominator: 'per dev seed, about 120 solvable single-source mentions from the N4 ledger and 64 no-referent names (60 generated, 4 from the ledger)' },
    gate: 'report-only', evidence_maturity: 'synthetic-production-path',
    contract: 'Imports an N4 entity ledger (n4-entity-gen.ts) as the N4 runner does, then creates one page per solvable mention and per no-referent name (no-referent-names-gen.ts, each checked against the N4 oracle) through put_page, reads the similar_pages advisory and deletes the page. Gold pages come from the N4 oracle. It does not measure merges, the resolver cascade (n4-entity-resolution does) or agent behavior after the hint.',
  },
  {
    id: 'line-grammar-junk-audit', legacy_alias: 'P5-H3', name: 'Typed line grammar stays out of ordinary list lines in chat transcripts and a public notes vault',
    family: 'extraction', tier: 'P', script: 'eval/runner/line-grammar-junk-audit.ts',
    run: { kind: 'listed', reason: 'P5 (gbrain#6017) H3 audit of the candidate build; the minting pass is hermetic, the precision labels are paid judge calls, and the held-out part is read only by the custodian', command: 'bun eval/runner/line-grammar-junk-audit.ts --gbrain <checkout>@<ref> --output <dir> [--paid --budget-usd <n>]' },
    cost_estimate: { usd: 1, basis: 'about $0.003 per labeled minted line with two judges (2026-10-05 smoke); the dev part minted no line, so the sealed 300-line frame costs at most about $1' },
    receipt_path: receipt('line-grammar-junk-audit'),
    headline: { metric: 'grammar lines minted per 1,000 list lines (relation and fact lines), zero-tolerance violations (timecode, task marker, citation, date, machine-written section), precision = both judges correct / minted lines in the sample', denominator: 'dev part: about 2,070 pages and 74,600 list lines (LongMemEval-S sessions, LoCoMo sessions, blue-book notes); held-out part about nine times that' },
    gate: 'report-only', evidence_maturity: 'synthetic-production-path',
    contract: 'Writes every page with a list line through put_page on the build under test with line_grammar.enabled=true, takes counts from the line_grammar advisory and line detail from the build parseLineGrammar over the stored text (they must agree), and runs deterministic zero-tolerance detectors on every minted line. A positive-control page must mint one relation and one fact line. Precision labels come from two judge models with a human adjudication queue for disagreements. Dev runs read only the dev part (LoCoMo dev conversations; a tenth of LongMemEval-S sessions and vault files by hash). It does not measure whether minted relations are useful.',
  },
  {
    id: 'save-notes-dedup', legacy_alias: 'P5-H5b', name: 'Agents saving notes: duplicate pages and wrong merges with and without the similar-page hint',
    family: 'agent', tier: 'P', script: 'eval/runner/save-notes-dedup.ts',
    run: { kind: 'listed', reason: 'P5 (gbrain#6017) H5b paid agent loop: one invocation per arm (build and GBRAIN_EVAL_CONFIG); arms compare with its compare subcommand or eval:decide', command: 'GBRAIN_EVAL_CONFIG=put_page.similar_pages=true bun eval/runner/save-notes-dedup.ts --gbrain <checkout>@<ref> --output <dir> --paid --budget-usd <n>' },
    cost_estimate: { usd: 0.2, basis: 'per (model, task) cell, 2026-10-05 dev smoke: $0.13 to $0.24 with claude-sonnet-5-5 and gpt-6.1-sol' },
    receipt_path: receipt('save-notes-dedup'),
    headline: { metric: 'duplicate-page rate over mentions of entities that already have a page; wrong-merge rate over similar-but-different entities; paired task-cluster bootstrap between arms', denominator: 'per model, 3 existing and 2 similar mentions per task; 20 tasks per dev seed' },
    gate: 'report-only', evidence_maturity: 'synthetic-production-path',
    contract: 'Builds a seeded brain of person and company pages, gives an agent a note mentioning 3 existing entities under variant names, 2 similar-but-different entities and 5 new ones, lets it write through gbrain serve over stdio with the fixed P5 tool list and no tool-result cap, then classifies every mention by where its unique marker and names landed on person and company pages. It does not measure page quality beyond placement.',
  },
  {
    id: 'write-then-answer', legacy_alias: 'P5-H6', name: 'Agents write a brain from a week of records, then answer relational and temporal questions from it',
    family: 'agent', tier: 'P', script: 'eval/runner/write-then-answer.ts',
    run: { kind: 'listed', reason: 'P5 (gbrain#6017) H6 paid agent loop: arm A (baseline, guidance-a.md) and arm B (candidate with line_grammar.enabled, guidance-b.md) are separate invocations; the sealed questions come from the custodian', command: 'GBRAIN_EVAL_CONFIG=line_grammar.enabled=true bun eval/runner/write-then-answer.ts --gbrain <checkout>@<ref> --arm-label B --guidance eval/data/p5-write-then-answer/guidance-b.md --output <dir> --paid --budget-usd <n>' },
    cost_estimate: { usd: null, basis: '2026-10-05 dev smoke: $0.47 to $0.61 per ingest batch (9 batches for the full world) and $0.016 to $0.037 per judged answer replicate' },
    receipt_path: receipt('write-then-answer'),
    headline: { metric: 'judged answer correctness per question (mean over replicates, with SD), arm B minus arm A with a paired cluster bootstrap 95% CI', denominator: 'per model, every question times --replicates; dev: 8 seeded pairs from calendar invites and meeting pages' },
    gate: 'report-only', evidence_maturity: 'synthetic-production-path',
    contract: 'An agent ingests amara-life-v1 (chronicle-lift renderCorpus) in fixed batches through gbrain serve with the arm guidance, the links it wrote are reconciled with extract --stale after each batch, then fresh read-only sessions answer each question and one judge grades every replicate against the reference. It does not measure write cost or retrieval outside the questions.',
  },
  {
    id: 'quote-grounding', legacy_alias: 'P8-quotes', name: 'Quote grounding: think keeps supported quotes and flags unsupported ones',
    family: 'reasoning', tier: 'P', script: 'eval/runner/p8-quote-grounding.ts',
    run: { kind: 'listed', reason: 'paid decision source for plan P8 (gbrain#6027) section 6: gbrain think on a build passed with --gbrain, an independent judge model, real embeddings; held-out questions and the sealed-confirmation corpus run only in custodian mode (--heldout-questions, --corpus-dir, access-logged)', command: 'bun eval/runner/p8-quote-grounding.ts --gbrain <checkout>@<ref> --questions eval/data/p8-quote-grounding/dev-questions.json --out eval/reports/p8-quote-grounding/<name>' },
    cost_estimate: UNMEASURED, receipt_path: 'eval/reports/p8-quote-grounding/<name>/summary.json',
    headline: { metric: 'supported quote spans wrongly flagged by think.quote_verify (rate and Wilson 95% upper bound, span level and clustered by question); unsupported spans kept', denominator: 'quoted spans of at least three words in think answers, labelled by the judge against the exact evidence the model was given; dev: 50 amara-life-v1 questions (seed 1)' },
    gate: 'report-only', evidence_maturity: 'synthetic-production-path',
    contract: 'Imports a corpus (amara-life-v1, or a sealed-confirmation set\'s haystacks one brain per haystack) into in-memory PGLite with text-embedding-3-large, runs runThink with think.quote_verify on for each question, captures the prompt the model saw, and has an independent judge label each quoted span verbatim, close or unsupported against that evidence; gbrain\'s verdict is flagged when the span is in unverified_quotes. --replay grounds recorded answers again on another build. It does not measure answer correctness or quotes the model did not mark with quotation marks.',
  },
  {
    id: 'write-cost', legacy_alias: 'P8-write-cost', name: 'Write cost: what an agent\'s memory writes cost with fact extraction on and off',
    family: 'performance', tier: 'P', script: 'eval/runner/p8-write-cost.ts',
    run: { kind: 'listed', reason: 'paid publication run for plan P8 (gbrain#6027) section 2: LongMemEval-S sessions written through gbrain serve over stdio MCP on a build passed with --gbrain, metered under the eval budget ledger', command: 'bun eval/runner/p8-write-cost.ts --gbrain <checkout>@<ref> --sessions 1000 --arms on,off --budget-usd <n> --out eval/reports/p8-write-cost/<name>' },
    cost_estimate: { usd: 12.28, basis: 'P8 dev write-cost receipt (gbrain#6027 docs/eval/decisions/p8/DEV_RESULTS.md): 1,000 pages per arm, extraction on and off, $12.28 actual' },
    receipt_path: 'eval/reports/p8-write-cost/<name>/receipt.json',
    headline: { metric: 'generative attempts on the commit path (must be 0); generative and embedding calls, tokens and dollars by model; put_page and remember latency p50/p95; drain time and jobs outstanding, per arm', denominator: 'per arm: pages written (one LongMemEval-S session each) and their messages, also reported per 1,000 pages and per 1,000 messages' },
    gate: 'report-only', evidence_maturity: 'synthetic-production-path',
    contract: 'Each arm is a fresh PGLite brain behind gbrain serve (stdio MCP). The agent writes sessions as note pages with put_page and remembers one fact per page; every provider request goes through a metering proxy and gbrain\'s GBRAIN_AI_CALL_LOG. After in-session work settles, the background queue is drained with gbrain jobs work and what remains is reported. It does not measure retrieval quality or the HTTP transport.',
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
    headline: { metric: 'leaking probes (content, existence, existence-oracle; target 0), access-gate bypasses, and read-op coverage', denominator: 'every read op enumerated from gbrain operations at run time x 6 remote callers x targets and variants (3,854 exposed probes and 74 read ops at 0.60.13.0; generator v2 at d44296c: 5,984 exposed probes, 30 of 74 read ops covered)' },
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
    contract: 'Seeds a brain holding protected content (visibility: private pages with body, tag and timeline markers, held Takes rows, private Facts rows, derived atoms, an ungranted source; since generator v2, a private ontology observation, raw data on a private page and a private orphan page) beside public twins, then calls every read op in gbrain operations as stdio, serve-http read/write/slug-bound clients and remote/local subagents scoped to one source. Gold is the generator ledger plus gbrain\'s documented visibility rules, never gbrain output. A leak is a protected marker in any response, a protected slug or foreign-source row the probe did not ask for, or a response to a protected target that differs from the response to a never-written ghost. Every probe needs two controls or it counts as no signal: the trusted local caller with the same arguments reads protected content, and the remote caller sees the public twin. Coverage counts read ops with at least one signal-bearing probe. It does not exercise the network transport, OAuth token verification, Postgres, or writes by write-scoped callers. Harness timeouts are errors; failed presence assertions make the run an error.',
  },
  {
    id: 'format-fidelity', legacy_alias: 'N12', name: 'Ingestion format fidelity: transcript adapters, conversation-parser patterns and attendance',
    family: 'ingestion', tier: 'H', script: 'eval/runner/n12-format-fidelity.ts', run: { kind: 'dispatched' },
    cost_estimate: FREE, receipt_path: receipt('n12-format-fidelity'),
    headline: { metric: 'speaker attribution accuracy, timestamp exact match, turn-count error, honesty on non-conversation input, format coverage; attended-vs-mentioned F1 as a separate attendance stage', denominator: 'canonical turns rendered into every format enumerated at run time from transcriptAdapters() and BUILTIN_PATTERNS (7 adapters and 20 patterns at 3a284ae); negative pages and files; seeded meeting pages for attendance' },
    gate: 'gate', evidence_maturity: 'synthetic-production-path',
    promotion: {
      preregistered: '2026-10-01',
      basis: 'amendment 1 and 9, frozen before the first run of this runner: the four safety contracts restate gbrain\'s own documented contracts (src/core/transcripts/types.ts: timestamps are real source timestamps, never invented, and skipped record kinds never reach the archive; conversation-parser no_match on non-conversation bodies; attended links need attendance evidence, src/core/link-extraction.ts). The two utility floors make a refuse-everything system fail: the plain control conversation must come back whole in every registered format, and the meeting-ingestion `## Attendees` form must be read. Every other metric is exploratory',
      safety_contracts: [
        zero('no-fabricated-turns', 'data.honesty.fabricated', 'a non-conversation page or file (prose, generic JSON, notes with bold labels, a code doc, garbage, a noise-only session) yields zero turns'),
        zero('no-noise-leak', 'data.adapters.noise_leaks', 'text from a record kind the adapter\'s spec target documents as skipped (system prompt, tool call or result, reasoning, sidechain, abandoned branch) never appears in an imported message'),
        zero('no-invented-timestamp', 'data.adapters.invented_timestamps', 'every imported message timestamp is an instant written in the source file or its documented sidecar (adapters never invent timestamps)'),
        zero('no-false-attendance', 'data.attendance.false_attended', 'a person only mentioned on a meeting page, with no attendance evidence, is never typed attended'),
      ],
      quality_thresholds: [
        { id: 'control-turn-floor', path: 'data.floor.control_recovered_rate', op: '>=', value: 1, description: 'utility floor: every turn of the plain control conversation comes back with the right speaker or role in every rendered registered format' },
        { id: 'attendance-control-floor', path: 'data.attendance.control_recall', op: '>=', value: 1, description: 'utility floor: every attendee listed in a `## Attendees` section of wikilinks (the meeting-ingestion template) is typed attended' },
      ],
      exploratory: [
        'data.adapters (role accuracy, timestamp exact match, turn-count error, detection accuracy, skipped-line honesty, per format)',
        'data.parser (pattern detection, speaker accuracy, timestamp exact match against what the rendered text carries and against the true time, turn-count error, 1970-01-01 date fallback, seconds lost, per pattern)',
        'data.roundtrip (adapter output rendered to a conversation page and re-parsed)',
        'data.honesty breakdown and silent mis-parses',
        'data.attendance precision, recall and F1 per evidence form',
        'data.coverage (formats with and without a renderer) and data.gaps',
      ],
    },
    contract: 'Renders the same seeded canonical conversations (speakers, roles, UTC times with seconds, multi-line turns, midnight and noon edges, anchor-shaped text inside turns) into every transcript format gbrain registers (transcriptAdapters(), enumerated at run time) and every conversation-parser built-in pattern (BUILTIN_PATTERNS), then parses them with gbrain\'s own adapters and parseConversation, in process, keyless, LLM fallback off. Gold is the generator ledger, never gbrain output; each renderer writes only what its host format can carry, so timestamps are scored against what the rendered text carries and, separately, against the true time. Scores speaker or role attribution, timestamp exact match, turn-count error, format detection, noise leaks and invented timestamps, and honesty on non-conversation input (no_match and zero-session diagnostics, never fabricated turns). Attendance is a separate stage: seeded meeting pages written through put_page on in-memory PGLite, attended edges read back through get_links and get_backlinks, scored per evidence form against generator truth with mentioned-only people as negatives. A registered format with no renderer is a reported coverage miss; a format gbrain does not register (generic JSON) and the documented 1970-01-01 fallback for date-less time-only formats are recorded as gaps, not failures. It does not measure the LLM fallback or polish, transcript discovery roots, or redaction. A gbrain exception where an answer is expected is a scored miss; a failed presence assertion is a harness error and voids the run.',
  },
  {
    id: 'code-intelligence', legacy_alias: 'N13', name: 'Code intelligence readiness scout (six code_* ops, one pinned TypeScript repo)',
    family: 'retrieval', tier: 'H', script: 'eval/runner/n13-code-intelligence.ts', run: { kind: 'dispatched' },
    cost_estimate: FREE, receipt_path: receipt('n13-code-intelligence'),
    headline: { metric: 'capability and readiness per op (trusted local call works, remote refused, non-empty answer on a known symbol, latency), with narrow sanity checks against TypeScript compiler definitions and references', denominator: 'six code_* ops; the vendored pathe snapshot (5 TypeScript files) at a pinned upstream commit' },
    gate: 'report-only', evidence_maturity: 'synthetic-production-path',
    promotion: {
      preregistered: '2026-10-01',
      basis: 'amendment 9: a capability and readiness scout only. No quality metric gates until independent call and flow gold exists (SCIP or equivalent, committed with hashes); lexical references are not semantic references, so nothing here is a quality claim',
      safety_contracts: [],
      quality_thresholds: [],
      exploratory: [
        'data.readiness (per op: trusted local call, CLI name, remote refusal, non-empty answer, latency)',
        'data.import (files, code pages, chunks, symbols, edges, import time)',
        'data.def_check (code_def top-1 file and line against TypeScript compiler declarations)',
        'data.refs_check (code_refs substring hits against TypeScript language-service references)',
        'data.callers_check (same-file vs cross-file callers against TypeScript call references)',
        'data.walks (code_blast and code_flow envelopes and language gating)',
      ],
    },
    contract: 'Imports a vendored, hash-checked snapshot of one small MIT-licensed TypeScript repository (unjs/pathe at a pinned commit) into in-memory PGLite with gbrain\'s importCodeFile, keyless, then calls code_def, code_refs, code_callers, code_callees, code_blast and code_flow through the trusted local operation path (remote code reads are suspended at the pinned commit, so remote callers are checked only for refusal). It reports what each op returns, how fast, and whether it is ready, with narrow sanity checks against definitions and references from the TypeScript compiler (pinned devDependency), which is independent of gbrain. It records the documented limits: code_refs is a substring match, symbol resolution stays within one file, blast and flow cover TypeScript, TSX, JavaScript and Python only. It is not a quality study: no metric gates, and broad caller, blast and flow quality waits for independent call and flow gold. A gbrain exception is recorded per op; a failed hash check or an empty import is a harness error.',
  },
  {
    id: 'open-loops-email', legacy_alias: 'N7', name: 'Open loops on Gmail-shaped threads: turn-flip detection, closure, manual close and mute',
    family: 'agent', tier: 'H', script: 'eval/runner/n7-open-loops-email.ts', run: { kind: 'dispatched' },
    cost_estimate: FREE, receipt_path: receipt('n7-open-loops-email'),
    headline: { metric: 'planted-loop recall and precision of the turn-flip detector, closure accuracy, counterparty accuracy, and violations of the documented exclusion, close, mute and redaction rules', denominator: 'seed 7: 136 Gmail-shaped threads judged at a pinned now (45 planted loops, 40 closures and no-loop threads with 31 closure cases under the rules documented before gbrain 0.60.32.0; 53 planted loops and 26 closure cases under the rules since, 37 excluded-mail threads, 14 contested), 32 multi-round store scenarios (8 closure rounds), 16 open_loops groups for the redaction check, plus the 25 amara-life-v1 threads as background' },
    gate: 'gate', evidence_maturity: 'synthetic-production-path',
    promotion: {
      preregistered: '2026-10-01',
      basis: 'amendment 1 and amendment 8, frozen before the first N7 run: safety contracts are the documented exclusion, close, mute and redaction rules (docs/guides/open-loops.md at 3a284ae); the recall floor is a utility floor so a detector that never opens a loop fails, not a value tuned to a run; closure and counterparty thresholds allow one documented-rule miss in twenty. Amendment 2026-10-03 (docs/benchmarks/2026-10-03-n7-oracle-amendment.md): the oracle applies the open-loop rules documented by the gbrain version under test (n7RulesFor); from 0.60.32.0 an acknowledgement-only reply to their question is not a reply. No threshold or contract changed',
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
    headline: { metric: 'proactive recall on trigger turns against false-alarm rate on negative turns at the default gate, with a min_confidence sweep, tokens per turn, redundant injections per session, and private or withdrawn deliveries', denominator: 'seed 8: 186 user turns in 52 sessions (60 triggers, 42 of them alias or exact title; 80 negatives, 68 innocuous or no-mention and 12 common-word; 8 private and 8 soft-deleted mentions; 30 repeats) plus 480 associative-recall-v1 probes as one-turn windows (240 indirect, 120 direct, 120 negatives with three adjudicated)' },
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
    id: 'contradiction-surfacing', legacy_alias: 'N2', name: 'Contradiction surfacing: candidate discovery, classification and resolution proposals',
    family: 'reasoning', tier: 'H', script: 'eval/runner/n2-contradiction-surfacing.ts', run: { kind: 'dispatched' },
    cost_estimate: FREE, receipt_path: receipt('n2-contradiction-surfacing'),
    headline: { metric: 'candidate-stage recall of planted same-time conflicts (pair offered to the judge), oracle-judge end-to-end ceiling, resolution-proposal acceptability; the paid arm adds judged-pair precision and recall, false-contradiction rates and end-to-end recall', denominator: 'seed 20261001: 270 planted pairs, one supplied query each (150 same-time conflicts, 60 dated changes, 60 compatible hard negatives), plus 15 adjudicated amara-life pairs as development data' },
    gate: 'gate', evidence_maturity: 'synthetic-production-path',
    promotion: {
      preregistered: '2026-10-01', basis: 'amendments 1 and 6, frozen before the first N2 run: the two safety contracts restate documented gbrain promises (docs/contradictions.md "Probe never mutates the brain"; runner.ts records a judge exception as an error, never as no_contradiction); the utility floor is set from the design (every planted conflict has a supplied query naming its company and attribute), not from a run. Paid-arm decision rules: docs/benchmarks/2026-10-01-n2-a4-preregistration.md; paid arms never gate',
      safety_contracts: [
        zero('probe-never-mutates', 'data.safety.applied_mutations', 'no page changes during any probe run or proposal rendering (docs/contradictions.md: the probe never mutates the brain; resolutions are proposals)'),
        zero('judge-error-not-a-verdict', 'data.safety.judge_errors_counted_as_verdicts', 'with a judge that throws, every offered pair is an error row and none becomes a verdict (runner.ts judge_errors are first-class)'),
      ],
      quality_thresholds: [
        { id: 'candidate-recall-floor', path: 'data.candidate.conflict_recall', op: '>=', value: 0.5, description: 'at least half of the 150 planted same-time conflicts reach the judge under the supplied queries (utility floor: a probe that offers nothing cannot pass)' },
      ],
      exploratory: ['data.candidate.by_variant and negatives offered', 'data.oracle (oracle-judge end-to-end ceiling)', 'data.resolution_oracle (proposal acceptability with gold verdicts)', 'data.date_signal (dates the judge sees; date pre-filter skips)', 'data.find_contradictions (read-back by caller scope)', 'data.amara (adjudicated development pairs)', 'data.paid.* (paid receipt only: classification, judged-pair precision and recall, false-contradiction rates, end-to-end recall with missed and capped pairs)'],
    },
    contract: 'Seeds a generated world of fictional companies into PGLite through put_page: planted pairs stating the same fact on two notes (same-time conflicts with both pages dated the same day, both undated, or one dated and one undated with the date in its text; dated changes with dates in frontmatter, dates only in text, or a falling metric; and compatible hard negatives: different holders\' opinions, the same value in other words, two companies sharing a name word, a negation beside a positive claim), one profile per company and one supplied query per item. It then runs gbrain\'s runContradictionProbe (src/core/eval-contradictions/runner.ts) with gbrain\'s default hybrid search (keyword only, no key) and injected judges: a recording judge (candidate discovery), an oracle judge from the ledger (end-to-end ceiling and resolution proposals) and a throwing judge (error accounting). Gold for every pair comes from the ledger with independent claim spans. Three stages are scored separately: candidate discovery, classification (gbrain\'s LLM judge is the system under test, paid arm only) and resolution (paste-ready proposals, never applied). Missed and capped pairs stay in the end-to-end denominator. It does not measure corpus-wide discovery (gbrain has none; a gap), takes pairs, applied resolutions, or System One S9. A gbrain exception where an answer is expected is a scored miss; a failed presence assertion voids the run.',
  },
  {
    id: 'abstention', legacy_alias: 'A4', name: 'Abstention: the CRAG grade against evidence sufficiency, and a fixed answerer against answerability',
    family: 'retrieval', tier: 'H', script: 'eval/runner/a4-abstention.ts', run: { kind: 'dispatched' },
    cost_estimate: FREE, receipt_path: receipt('a4-abstention'),
    headline: { metric: 'CRAG grade operating points against evidence sufficiency (hermetic); the paid arm adds the house reader\'s correct useful answers, false refusals, unanswerable-answer rate and risk at its coverage, on retrieved and matched oracle evidence', denominator: 'seed 20261001: 240 questions (120 answerable: 60 profile, 60 note; 120 unanswerable: 50 missing attribute, 40 sibling attribute, 30 absent company); balanced, so abstain precision is not deployment precision' },
    gate: 'gate', evidence_maturity: 'synthetic-production-path',
    promotion: {
      preregistered: '2026-10-01', basis: 'amendments 1 and 7, frozen before the first A4 run: CRAG makes no abstention promise (capability matrix), so nothing here is a safety contract; the query op promises a crag block on every call (src/core/ops/search.ts), and the utility floor is set from the design (every answerable question names its company and attribute), not from a run. Paid-arm decision rules: docs/benchmarks/2026-10-01-n2-a4-preregistration.md; paid arms never gate',
      safety_contracts: [],
      quality_thresholds: [
        { id: 'crag-meta-every-call', path: 'data.crag.meta_coverage', op: '>=', value: 1, description: 'every query call returns a retrieval.crag grade in its response meta' },
        { id: 'answerable-evidence-floor', path: 'data.crag.answerable_evidence_rate', op: '>=', value: 0.8, description: 'for at least 80% of answerable questions the top five query results carry the answer text (utility floor: a retrieval that returns nothing cannot pass)' },
      ],
      exploratory: ['data.crag.by_class (grade by question class)', 'data.crag.operating_points (risk and coverage of the grade used as an abstention gate)', 'data.crag.strong_on_unanswerable', 'data.s4 (where S4 could not abstain even when on: identity hit or strong deterministic grade)', 'data.paid.* (paid receipt only: house reader on retrieved and oracle evidence, CRAG-gated reader)'],
    },
    contract: 'Seeds fictional companies (profile pages and diligence notes, every attribute value unique) into PGLite through put_page and asks 240 questions through the query operation (keyword only, no key, expansion off, top five). Hermetic: scores the zero-LLM CRAG grade attached to each response against evidence sufficiency (answer text present in the top five) and against answerability from the ledger, reported as coarse operating points, not a calibrated curve; and computes, with gbrain\'s own reducer inputs, where System One S4 could never abstain (identity hit or strong grade). Paid: the answerer is defined explicitly as gbrain\'s house reader (src/eval/longmemeval/reader.ts notes-mode system text, claude-sonnet-4-6, 1,024 output tokens, temperature 0) over the top five results, and over matched oracle evidence as a control; answers are scored deterministically against the ledger (correct, wrong, wrong-source, abstain). gbrain has no keyless answerer, so the keyless path cannot abstain; that is a gap, not a failure. S4 on is a separate arm that needs a TypeSafe key, explicit enabling and a budget guard that can price TypeSafe requests. Safety refusals are out of scope. A gbrain exception where an answer is expected is a scored miss; a failed presence assertion voids the run.',
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
    cost_estimate: { usd: 0.07, basis: 'measured 2026-09-29 and again 2026-10-01 at 3a284ae: $0.0645 of OpenAI embeddings in the budget ledger for 3 seeds x 2 splits (docs/benchmarks/2026-10-01-n9-multi-hop)' }, receipt_path: 'eval/reports/relational-ab/<output>/receipt.json',
    headline: { metric: 'Recall@5 and hit@1 with relational retrieval off vs on over one index, template vs paraphrase wording', denominator: '145 questions x 2 wordings x 3 seeds' },
    gate: 'report-only', promotion: REPORT_ONLY, evidence_maturity: 'synthetic-production-path',
    contract: 'Toggles only relational retrieval over a shared index and pairs outcomes per question, on the template questions (the parser\'s own verbs) and on a frozen paraphrase of each. Report distinct-question gains beside pair gains, and the paraphrase split beside the template split.',
  },
  {
    id: 'constrained-relational', legacy_alias: 'constrained-relational', name: 'Constrained relational questions: one seed, one relation, one attribute constraint',
    family: 'relationships', tier: 'K', script: 'eval/runner/constrained-relational.ts', run: { kind: 'dispatched', outputFlag: '--output', timeoutMs: HOUR },
    cost_estimate: { usd: 0.05, basis: 'measured 2026-10-04: two dev seeds of about 190 pages each, OpenAI embeddings through the budget ledger, under $0.05' }, receipt_path: 'eval/reports/constrained-relational/<output>/receipt.json',
    headline: { metric: 'NDCG@10, hit@1, hit@3 and Recall@5 over distinct pages, relational-arm fire rate', denominator: 'dev seeds 11 and 13 (phrasing set A): 142 questions (60 who-at-topic, 48 portfolio-by-sector, 34 attendees-by-role)' },
    gate: 'report-only', promotion: REPORT_ONLY, evidence_maturity: 'synthetic-production-path',
    contract: 'Generates seeded worlds of investors, companies, employees and meetings as linked notes (eval/generators/constrained-relational-gen.ts), indexes them with extraction and real embeddings on in-memory PGLite, and runs each question through hybrid search with the arm config from GBRAIN_EVAL_SEARCH_PINS. Every question names one seed entity, one typed relation and one attribute constraint that selects 1 to 4 of 8 to 14 neighbors; gold comes from the world model. Built for plan P3 E4 (relational triplet scoring); the fire rate must stay at or above 80%. Only development phrasing set A and seeds 11 and 13 run here; held-out phrasing and seeds belong to the custodian (--phrasing-file, access-logged). It does not measure answer synthesis or multi-hop composition.',
  },
  {
    id: 'multi-hop-paraphrase', legacy_alias: 'N9', name: 'Multi-hop with held-out wording: composed 2-3-hop questions, relational retrieval off vs on',
    family: 'relationships', tier: 'H', script: 'eval/runner/n9-multi-hop-paraphrase.ts', run: { kind: 'dispatched', outputFlag: '--output', timeoutMs: 600_000 },
    cost_estimate: FREE, receipt_path: 'eval/reports/n9-multi-hop-paraphrase/<output>/receipt.json',
    headline: { metric: 'strict supporting-fact all-hit@10 (every support page and every answer page among the first 10 result rows), relational retrieval off vs on, canonical vs paraphrase wording; parse, seed, firing and delivery funnel', denominator: '125 composed questions (94 two-hop, 31 three-hop) x 2 wordings x 3 ingestion seeds per arm, keyword path, keys stripped' },
    gate: 'report-only', evidence_maturity: 'synthetic-production-path',
    promotion: {
      preregistered: '2026-10-01',
      basis: 'amendments 1 and 9, frozen before the first run: nothing gates, because composed multi-relation query plans are a documented feature gap at 3a284ae (capability matrix, N9) and no earlier measurement exists to set a threshold from. Report decision rules and void conditions: docs/benchmarks/2026-10-01-n9-multi-hop-preregistration.md',
      safety_contracts: [],
      quality_thresholds: [],
      exploratory: [
        'data.composed.by_split.<split>.<arm>.strict_all_hit (headline), with answer_all_hit, support_all_hit, answer_recall and strict_all_hit_at_5',
        'data.composed.paired.<split> (on vs off gains, losses, ties per run and per distinct question; exact sign test)',
        'data.composed.funnel.<split> (parsed, seed resolved, fired, all support delivered; failures stay in the denominator)',
        'data.capability (composed-plan check of parseRelationalQuery on every wording)',
        'data.controls (solvability, single-page shortcut subset, gold-shuffle negative control, anchor-lookup presence)',
        'data.composed.by_hops and data.composed.by_family',
      ],
    },
    contract: 'Builds one PGLite index per ingestion seed from world-v1 through relational-ab, then asks 125 composed two- and three-hop questions (gold from the generator-written _facts chains, hash-committed before any scoring) in a canonical and a paraphrase wording, with relational retrieval off and on over the same index. Scores strict supporting-fact all-hit@10 and reports the parse, seed, firing and delivery stages separately. It does not claim composed multi-relation retrieval exists: gbrain parses one relation per question, so composed questions are a recorded feature gap and the score is what the system returns anyway. The hermetic arm runs keyword search with provider keys stripped; a paid arm adds OpenAI embeddings. A product exception is a scored miss; a failed presence assertion, overlay mismatch or harness error voids the run.',
  },
  {
    id: 'multi-hop-paraphrase-paid', legacy_alias: 'N9-paid', name: 'Multi-hop with held-out wording, hybrid arm with OpenAI embeddings',
    family: 'relationships', tier: 'P', script: 'eval/runner/n9-multi-hop-paraphrase.ts',
    run: { kind: 'listed', reason: 'spends money: needs --paid and --budget-run-id naming an open budget run', command: 'bun eval/runner/n9-multi-hop-paraphrase.ts --paid --budget-run-id <id>' },
    cost_estimate: { usd: 0.07, basis: 'measured 2026-10-01 at 3a284ae: $0.0647 of OpenAI embeddings for 3 seeds (docs/benchmarks/2026-10-01-n9-multi-hop/n9-paid.receipt.json)' },
    receipt_path: 'eval/reports/n9-multi-hop-paraphrase/<output>/receipt.json',
    headline: { metric: 'strict supporting-fact all-hit@10, relational retrieval off vs on, canonical vs paraphrase wording, on hybrid search', denominator: '125 composed questions x 2 wordings x 3 ingestion seeds per arm' },
    gate: 'report-only', evidence_maturity: 'synthetic-production-path',
    contract: 'The paid arm of multi-hop-paraphrase: the same questions, gold and scorer over hybrid search with OpenAI text-embedding-3-large (1536 dimensions) and the relational-ab pins. Paid arms never gate. Decision rules are preregistered in docs/benchmarks/2026-10-01-n9-multi-hop-preregistration.md.',
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
    id: 'model-ladder', legacy_alias: '40', name: 'Model Ladder: agent tasks over a company knowledge base, by memory system and model generation',
    family: 'reasoning', tier: 'P', script: 'eval/runner/cat40-model-ladder.ts',
    run: { kind: 'listed', reason: 'paid model calls across many models, and a gbrain checkout for the gbrain arm', command: 'bun eval/runner/cat40-model-ladder.ts --models <list> --arms oracle,fs,fs-acl,memory,pg,gbrain --gbrain-repo <gbrain checkout> --budget-usd <n>' },
    cost_estimate: { usd: 800, basis: 'the uncapped 11-model, 6-arm ladder on 2026-10-02 cost $777 for 7,624 cells; one model and repeat costs $10-$80' },
    receipt_path: 'docs/benchmarks/2026-10-02-model-ladder/',
    headline: { metric: 'agent task success per memory arm and model, gbrain advantage over the best simple arm, and its slope on model capability', denominator: '50 tasks (authority, true-now, permissions, evidence briefs, write-back) per model and repeat' },
    gate: 'report-only', evidence_maturity: 'synthetic-production-path',
    contract: 'Runs one agent loop per arm (files, memory tool, plain Postgres, gbrain MCP, and handed-over evidence) on a fictional company corpus generated from a ledger, scores answers deterministically and counts finance-only leaks. Capability is the oracle arm; the 4k-document world is development data, the seed-20261003 world is held out.',
  },
  {
    id: 'agent-operator', legacy_alias: '41', name: 'Agent operator outcomes: real Claude Code and Codex sessions operating gbrain through errors, consent gates and setup',
    family: 'agent', tier: 'P', script: 'eval/runner/cat41-agent-operator.ts',
    run: { kind: 'listed', reason: 'paid sessions of two pinned agent CLIs in Docker, a gbrain checkout and a before/after pair of passes', command: 'eval/runner/cat41/after-pass.sh <gbrain checkout> <commit> (or: bun eval/runner/cat41-agent-operator.ts run --gbrain <checkout>@<ref> --label <label> --repeat 3 --paid --budget-run-id <id>; then overhead and gate --before <dir> --after <dir> --out <file>)' },
    cost_estimate: { usd: 17, basis: 'baseline pass 2026-10-03 (102 runs, 17 scenarios x 2 harnesses x 3) cost $16.38 at harness-reported and list prices; the Cat 40 F1/F10 check in the protocol adds about $32' },
    receipt_path: 'docs/benchmarks/2026-10-03-agent-operator/',
    headline: { metric: 'consent violations in safety scenarios, newly introduced false "no notes" answers, token overhead per surface; task success per scenario (reported, not gated)', denominator: '17 scenarios x 2 harnesses (Claude Code, Codex CLI) x 3 repeats per pass' },
    gate: 'gate', promotion: AGENT_OPERATOR_RULES, evidence_maturity: 'synthetic-production-path',
    contract: 'Runs pinned Claude Code and Codex CLI sessions in a container against a fictional seeded brain and scores each step from the transcript, a logging gbrain wrapper, a fake model provider and file-system probes: authorized execution, required relay, correct refusal, successful recovery, consent violation, false "no notes" answer. It measures what agents do with gbrain\'s errors, refusals and setup, not retrieval quality. Model behavior varies between repeats; a scenario failing on the baseline too is reported as baseline-zero, a harness crash is retried twice and then reported inconclusive. The silent-stdin scenario emulates a host whose shell leaves stdin open (both pinned harnesses give /dev/null).',
  },
  {
    id: 'knowledge-update', legacy_alias: 'N1', name: 'Knowledge update and supersession through the lifecycle harness (explicit fence supersession, ontology as-of, trajectories)',
    family: 'temporal', tier: 'H', script: 'eval/runner/n1-knowledge-update.ts',
    run: { kind: 'listed', reason: 'a lifecycle slice: it spawns real gbrain CLI, stdio and HTTP servers per cell for minutes, above the 60-second CI budget, and its Postgres cells need Docker; rules apply to every counted run; CI runs the preregistered slice instead (registry entry knowledge-update-ci)', command: 'bun eval/runner/n1-knowledge-update.ts [--gbrain <checkout>@<ref>] [--engines pglite,postgres] [--interfaces cli,mcp-stdio,mcp-http] [--pg-url <url>]' },
    cost_estimate: FREE, receipt_path: receipt('n1-knowledge-update'),
    headline: { metric: 'current-value accuracy, stale-served count and rate, history retained, by surface, update depth (1 to 4) and update kind; private-value exposure and acknowledged writes lost', denominator: 'per cell: every current-value, history and exposure probe the seeded ledger defines; data.metrics aggregates the PGLite cells over the three transports, data.metrics_postgres the Postgres cells (report-only outside CI)' },
    gate: 'gate', evidence_maturity: 'synthetic-production-path',
    promotion: N1_RULES,
    contract: 'Writes a seeded value-change ledger (fictional people and companies; update depth 1 to 4; explicit fence supersession with struck "superseded by #N" rows, reverts to an earlier value, dated and late-recorded updates, ontology observations with valid-time dates including reverts and backdated conflicts, and typed metric trajectories with corrected points) through gbrain operations over the real transports of the lifecycle harness (trusted local CLI, stdio MCP, HTTP MCP with an OAuth client) on PGLite and Postgres, then restarts, reimports the vault with a full sync, applies a round of concurrent writes and probes again. Reads go through recall, search, ontology_get (now and as-of, the N3 valid-time semantics) and find_trajectory. Gold is an independent oracle over the generator ledger, never gbrain output. Exposure controls follow N6: every private value has a trusted local control that must see it and a public twin the remote caller must see, or the probe carries no signal. It does not score implicit supersession (it needs an embedding key; recorded as a gap), natural-language change detection, think, or entity pages written only as prose. A gbrain error where an answer is expected is a scored miss; a failed presence assertion is a harness error and voids the run.',
  },
  {
    id: 'forget-residue', legacy_alias: 'N5', name: 'Forgetting and withdrawal residue through the lifecycle harness',
    family: 'safety', tier: 'H', script: 'eval/runner/n5-forget-residue.ts',
    run: { kind: 'listed', reason: 'a lifecycle slice: it spawns real gbrain CLI, stdio and HTTP servers per cell for minutes, above the 60-second CI budget, and its Postgres cells need Docker; rules apply to every counted run; CI runs the preregistered slice instead (registry entry forget-residue-ci)', command: 'bun eval/runner/n5-forget-residue.ts [--gbrain <checkout>@<ref>] [--engines pglite,postgres] [--interfaces cli,mcp-stdio,mcp-http] [--pg-url <url>]' },
    cost_estimate: FREE, receipt_path: receipt('n5-forget-residue'),
    headline: { metric: 'prohibited active outputs after forget per tier and checkpoint (target 0), reactivations, collateral expirations, unauthorized forgets applied, retained-neighbor recall and reinstatement; paraphrase residue and retained history reported as documented non-guarantees', denominator: 'per cell: forgotten canaries x witnessed active tiers x checkpoints (immediately after forget, after a stale reimport, after restart, after concurrent writes); data.metrics aggregates the PGLite cells over the three transports, data.metrics_postgres the Postgres cells (report-only outside CI)' },
    gate: 'gate', evidence_maturity: 'synthetic-production-path',
    promotion: N5_RULES,
    contract: 'Remembers seeded canary claims for fictional entities through the remember verb and Facts fences over the real transports of the lifecycle harness (trusted local CLI, stdio MCP, HTTP MCP with an OAuth client) on PGLite and Postgres, witnesses each canary in every active tier before withdrawal, forgets half, then probes each tier immediately, after a stale-file reimport and full sync, after a restart and after concurrent writes. Hard negatives are the same claim text on other entities and other facts on the forgotten entity; private canaries carry N6-style exposure controls; authority is tested with a read-only and a foreign-source HTTP client; reinstatement is a corrected claim (repeating the exact claim is documented as refused). Gold is the generator ledger and the documented withdrawal contract, never gbrain output. Paraphrase retraction and physical erasure of history, files and backups are documented non-guarantees, reported as gaps, never as failures. Tiers a hermetic run cannot reach (dream synthesis and consolidation without a chat model, think synthesis) are reported as unmeasured. A gbrain error where an answer is expected is a scored miss; a canary not witnessed in a tier before withdrawal makes that pair no-signal, and a failed presence assertion voids the run.',
  },
  {
    id: 'knowledge-update-ci', legacy_alias: 'N1-ci', name: 'Knowledge update CI slice: four ledger entities on one PGLite stdio MCP cell',
    family: 'temporal', tier: 'H', script: 'eval/runner/n1-knowledge-update.ts',
    run: { kind: 'dispatched', args: ['--slice', 'ci'], outputFlag: '--output', timeoutMs: 300_000 },
    cost_estimate: FREE, receipt_path: 'eval/reports/n1-knowledge-update-ci/<output>/receipt.json',
    headline: { metric: 'the N1 contracts and floors on the slice: stale served, private values in remote responses, acknowledged writes lost, current-value accuracy, history retained', denominator: 'seed 11, entities alder, birch, ember and kappa: 64 current-value, 57 history and 12 exposure probes over four checkpoints on one PGLite cell (stdio MCP served by the gbrain CLI; trusted controls through `gbrain call`)' },
    gate: 'gate', promotion: N1_CI_RULES, evidence_maturity: 'synthetic-production-path',
    contract: 'The N1 lifecycle run restricted to a preregistered subset of the same seeded ledger (every fence, ontology and trajectory chain on four of the nine entities, unchanged) and one cell: PGLite with the gbrain CLI serving stdio MCP, trusted controls through `gbrain call`, restart, full reimport and a concurrent round as in the full run. It covers explicit and revert fence supersession at depths 1 to 4, a private fence value, forward, backdated, same-source revert and private ontology chains, and a corrected trajectory with a private twin. It omits the CLI and HTTP transports, Postgres, the distinct-source ontology revert and the appended trajectory; the full run keeps them. A failed presence assertion voids the run.',
  },
  {
    id: 'forget-residue-ci', legacy_alias: 'N5-ci', name: 'Forgetting residue CI slice: two ledger entities on one PGLite stdio MCP cell',
    family: 'safety', tier: 'H', script: 'eval/runner/n5-forget-residue.ts',
    run: { kind: 'dispatched', args: ['--slice', 'ci'], outputFlag: '--output', timeoutMs: 300_000 },
    cost_estimate: FREE, receipt_path: 'eval/reports/n5-forget-residue-ci/<output>/receipt.json',
    headline: { metric: 'the N5 contracts and floors on the slice: prohibited active outputs, reactivations, collateral expirations, private canaries in remote responses, retained recall and reinstatement', denominator: 'seed 5, entities hazel and ivy: 13 canaries x 7 active tiers x 6 checkpoints on one PGLite cell (stdio MCP served by the gbrain CLI; private canaries through `gbrain call`)' },
    gate: 'gate', promotion: N5_CI_RULES, evidence_maturity: 'synthetic-production-path',
    contract: 'The N5 lifecycle run restricted to a preregistered subset of the same seeded ledger (the 13 canaries on two of the four entities whose sources are also kept) and one cell: PGLite with the gbrain CLI serving stdio MCP, private canaries remembered, forgotten and read through `gbrain call`, every checkpoint of the full run (witness, immediate, settled, stale reimport, restart, concurrent) and every active tier. It covers remembered and fence-authored forgets, a same-text twin on another entity, a private forgotten canary, a late forget during concurrent writes, a corrected claim and the refused exact repeat. It omits the prose canary, the private retained canary, the concurrent same-text twin, the CLI and HTTP transports (so the read-only and foreign-source forget attempts, which need HTTP, do not run) and Postgres; the full run keeps them. A failed presence assertion voids the run.',
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
  'chronicle-lift.ts': { role: 'auto_chronicle off-versus-on experiment (docs/benchmarks/2026-10-04-auto-chronicle-lift-preregistration.md); paid, not dispatched' },
  'budget-ledger.ts': { role: 'shared paid-run reservation ledger' },
  'bug-ledger.ts': { role: 'shared gbrain bug ledger: validated entries and the Markdown view' },
  'eval-config.ts': { role: 'GBRAIN_EVAL_CONFIG: any gbrain config key for a category arm, applied before the first write and read back' },
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
  'feedback-replay-locomo.ts': { role: 'use-attributed feedback replay on LoCoMo (off, frozen, online, noisy, frequency arms); dev or custodian sealed split' },
  'feedback-replay-world.ts': { role: 'use-attributed feedback replay on world-v1 relational questions; dev or custodian sealed half' },
  'feedback-think-replay.ts': { role: 'use-attributed feedback from the implicit citation signal: LoCoMo answers through the think operation (off, frozen, sparse, online arms), judged N times; dev or custodian sealed split' },
  'hub-world.ts': { role: 'hub-heavy world-v1 variant probes (hub-as-answer, bridge, one-hop guard) on the shared-index harness; corpus from eval/generators/hub-world-gen.ts' },
  'hub-world-arms.ts': { role: 'several read-time arms (hub dampening half degrees, graph signals off) over one shared hub-world index per build; Cat 13 concept, hub-as-answer, bridge and one-hop families (P2 E1)' },
  'decide.ts': { role: 'held-out decision kit CLI (bun run eval:decide): decision specs, dev runs of baseline vs candidate gbrain builds, paired verdicts' },
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
  'n2-3-prompt-ab.ts': { role: 'matched before/after of the gbrain contradiction-judge prompt (N2-3) on a fresh N2 seed, development data', part_of: 'contradiction-surfacing' },
  'p5-agent.ts': { role: 'P5 agent runners (H5b, H6) and judges (H3, H6): keyless brain served over MCP stdio with in-place snapshots, the fixed P5 tool lists, judge calls, paid-run joining, per-unit checkpoints, pilot subsets and paired receipt comparison' },
  'p8-withdraw-retrieval.ts': { role: 'P8 withdrawal-review neighbour retrieval: cosine of each withdrawn claim and candidate (text-embedding-3-large, 1536 dims) against the review lane\'s 0.80 floor, by slice; the classifier half runs in gbrain decide' },
  'p5-brain.ts': { role: 'P5 runners: in-memory brain on the build under test (put_page, stale-link sweep, stored edges), world-v1 rendering, custodian-mode input and the shared receipt' },
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
  'world-v1-gold.ts': { role: 'world-v1 link-typing gold and scorer without a gbrain import, shared by type-accuracy and line-grammar-typing', part_of: 'link-type-accuracy' },
};

/** Subdirectories of eval/runner/ holding helper modules only. */
export const RUNNER_HELPER_DIRS: readonly string[] = ['adapters', 'cat40', 'cat41', 'decisions', 'evaluator', 'evidence-delivery', 'lifecycle', 'memory-qa', 'p4-stream', 'queries', 'stats', 'system-one'];
