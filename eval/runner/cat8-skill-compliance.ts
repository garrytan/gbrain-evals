/**
 * Cat 8 — Skill Behavior Compliance.
 *
 * FEATURE BOUNDARY (what is under test vs what is seeded/stubbed):
 *   - UNDER TEST: the agent's iron-law behavior when driving gbrain's real
 *     operations surface (tool-bridge → gbrain handlers → PGLite engine):
 *     brain-first ordering, back-link discipline, citation format, tier
 *     escalation.
 *   - SEEDED: the brain corpus + poison fixtures (via
 *     ClaudeSonnetWithToolsAdapter.init) and the probe catalog. The Sonnet
 *     driver is live in real runs and a stub in hermetic tests; scoring is
 *     deterministic from the transcript either way (no judge call in Cat 8).
 *
 * Replays inbound signals through the agent adapter (Sonnet + gbrain tools)
 * and measures four structural iron-laws:
 *
 *   - **brain_first_compliance** — did the agent call search/get_page
 *     BEFORE producing its final answer? Threshold (informational): >0.95.
 *   - **back_link_compliance** — every `dry_run_put_page` intent has
 *     at least one markdown back-link in its compiled_truth. Threshold: >0.90.
 *   - **citation_format** — timeline entries in dry_run writes follow the
 *     canonical `- **YYYY-MM-DD** | Source — Summary` pattern; final
 *     answers cite slugs in markdown or backticks. Threshold: >0.95.
 *   - **tier_escalation** — complex probes get tool calls (not just direct
 *     answers from general knowledge); simple probes stay light (≤2 brain
 *     reads, zero writes). Threshold: >0.80.
 *
 * No-answer policy (audit agentic-cats-08): a probe that never produced a
 * final answer (turn cap, malformed loop, empty end_turn text) counts as
 * NON-compliant on back_link_compliance and citation_format — vacuous passes
 * previously inflated both metrics.
 *
 * Error policy (WS0, via probe-accounting.ts): thrown agent-loop errors are
 * infra (dependency/harness) — excluded from metric denominators, recorded
 * in the receipt, capped at 10%. Probes that completed the loop are always
 * scored, including turn-capped ones (SUT misbehavior stays a miss in the
 * denominator). 'rate_limit_exhausted' runs are dependency errors.
 *
 * Every run writes a receipt (eval/reports/cat8-skill-compliance/receipt.json
 * by default) and a flight-recorder bundle with the full per-probe
 * transcripts (previously discarded — audit agentic-cats-17).
 *
 * v1 verdict is `baseline_only` — the 10-probe calibration that would
 * set thresholds requires real Opus runs against the Day 3b amara-life-v1
 * corpus. Once κ > 0.7 calibration lands, enableThreshold can flip on.
 */

import type { Anthropic } from '@anthropic-ai/sdk';
import {
  runAgentLoop,
  classifyAgentError,
  DEFAULT_AGENT_MODEL,
  type AgentAdapterState,
  type AgentRunConfig,
  type AgentRunResult,
} from './adapters/claude-sonnet-with-tools.ts';
import { ProbeAccounting, type ProbeSummary } from './probe-accounting.ts';
import {
  writeReceipt,
  receiptPath,
  BENCHMARK_VERSION,
  RECEIPT_SCHEMA_VERSION,
  type ProbeError,
  type ReceiptVerdict,
} from './receipt.ts';
import { gbrainVersion, gbrainPin } from './gbrain-version.ts';
import { emitBundle, type Transcript, type Scorecard } from './recorder.ts';

// ─── Types ────────────────────────────────────────────────────────────

export type ProbeTier = 'simple' | 'complex';

export interface SkillComplianceProbe {
  /** Stable id, e.g. "sig-0001". */
  id: string;
  /** The inbound signal text — what a user/agent would paste to the brain. */
  text: string;
  /**
   * Tier hint for the tier_escalation metric.
   *   - simple: direct fact lookup, expected to resolve in ≤2 tool calls
   *   - complex: multi-hop, synthesis, or dry_run writes expected
   */
  tier: ProbeTier;
  /**
   * If true, the probe expects the agent to perform at least one dry_run
   * write. Used by tier_escalation: a complex probe that never writes is a
   * failure.
   */
  expects_dry_run_write?: boolean;
}

export interface SkillCompliancePerProbe {
  probe_id: string;
  tier: ProbeTier;
  brain_first: AgentRunResult['brain_first_ordering'];
  brain_first_compliant: boolean;
  dry_run_writes: number;
  back_link_compliant: boolean;
  citation_format_compliant: boolean;
  tier_escalation_correct: boolean;
  stop_reason: AgentRunResult['stop_reason'];
  total_cost_usd: number;
}

export interface Cat8Report {
  schema_version: 1;
  ran_at: string;
  /** Planned probes (accounting n_total). */
  total_probes: number;
  /** Probes that completed the agent loop and were scored. */
  scored_probes: number;
  brain_first_compliance: number;
  back_link_compliance: number;
  citation_format: number;
  tier_escalation: number;
  per_probe: SkillCompliancePerProbe[];
  /** WS0 probe accounting: typed infra errors, cap state, publishability. */
  errors: ProbeError[];
  infra_error_rate: number;
  run_invalid: boolean;
  publishable: boolean;
  total_cost_usd: number;
  verdict: 'pass' | 'fail' | 'baseline_only';
}

export interface Cat8Config extends Omit<AgentRunConfig, 'client'> {
  /** Agent Sonnet client. Default uses ANTHROPIC_API_KEY lazy singleton. */
  client?: Anthropic;
  /** Thresholds override. Default: design-doc METRICS.md numbers. */
  thresholds?: {
    brain_first_compliance?: number;
    back_link_compliance?: number;
    citation_format?: number;
    tier_escalation?: number;
  };
  /** When false (default in v1), verdict is always baseline_only. */
  enableThreshold?: boolean;
  /** Bounded concurrency across probes. Default 4. */
  concurrency?: number;
  /** Root for receipt + flight-recorder bundle. Default eval/reports. Tests point this at a tmp dir. */
  reportsRoot?: string;
  /** Run id used in the flight-recorder bundle directory name. Default 'run'. */
  runId?: string;
  /** Corpus provenance hash recorded in the scorecard config card. */
  corpusSha?: string;
}

export interface RunCat8Options extends Cat8Config {
  probes: SkillComplianceProbe[];
  state: AgentAdapterState;
}

export const CAT8_CATEGORY = 'cat8-skill-compliance';

// ─── Compliance checks ───────────────────────────────────────────────

const MD_LINK_OR_BACKTICK_SLUG_RE = /(\[[^\]]+\]\(([a-z][a-z0-9-]*\/[a-z0-9][a-z0-9-]*)\)|`([a-z][a-z0-9-]*\/[a-z0-9][a-z0-9-]*)`)/i;

/** Documented budget for simple probes: "expected to resolve in ≤2 tool calls". */
const SIMPLE_TIER_MAX_BRAIN_CALLS = 2;

function finalAnswerCiteCount(text: string): number {
  const md = /\[[^\]]+\]\(([a-z][a-z0-9-]*\/[a-z0-9][a-z0-9-]*)\)/g;
  const bt = /`([a-z][a-z0-9-]*\/[a-z0-9][a-z0-9-]*)`/g;
  const slugs = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = md.exec(text)) !== null) slugs.add(m[1]);
  while ((m = bt.exec(text)) !== null) slugs.add(m[1]);
  return slugs.size;
}

/**
 * Did the run produce a real final answer? Gates the compliance metrics
 * that were previously vacuously true for no-output runs (audit
 * agentic-cats-08): a probe that burned its turn cap and emitted nothing
 * must not count as citation- or back-link-compliant.
 */
function producedFinalAnswer(result: AgentRunResult): boolean {
  return result.stop_reason === 'end_turn' && result.final_answer.trim().length > 0;
}

function scoreBrainFirst(result: AgentRunResult): boolean {
  return result.brain_first_ordering === 'brain_before_answer';
}

function scoreBackLinkCompliance(result: AgentRunResult): boolean {
  // No answer produced → non-compliant, never vacuous (agentic-cats-08).
  if (!producedFinalAnswer(result)) return false;
  const writes = result.tool_bridge_state.made_dry_run_writes;
  if (writes.length === 0) return true; // vacuous only for answering runs
  // Every dry_run_put_page write must have back-links. dry_run_add_link
  // and dry_run_add_timeline_entry are link writes themselves and always
  // satisfy this metric.
  for (const w of writes) {
    if (w.tool_name === 'dry_run_put_page' && w.has_back_links === false) return false;
  }
  return true;
}

function scoreCitationFormat(result: AgentRunResult): boolean {
  // No answer produced → non-compliant, never vacuous (agentic-cats-08).
  if (!producedFinalAnswer(result)) return false;

  // 1. Timeline entries in any dry_run write must match the canonical format.
  for (const w of result.tool_bridge_state.made_dry_run_writes) {
    if (w.citation_format_ok === false) return false;
  }

  // 2. If the final answer makes any factual claims (non-trivial length),
  //    it must cite at least one slug. Keep this permissive — a terse
  //    answer like "I don't know" shouldn't be penalized.
  const text = result.final_answer.trim();
  if (text.length >= 80) {
    if (!MD_LINK_OR_BACKTICK_SLUG_RE.test(text)) return false;
  }
  return true;
}

function scoreTierEscalation(probe: SkillComplianceProbe, result: AgentRunResult): boolean {
  const brainCalls = Object.entries(result.tool_bridge_state.count_by_tool)
    .filter(([name]) => BRAIN_READ_TOOLS.has(name))
    .reduce((sum, [, n]) => sum + n, 0);
  const writes = result.tool_bridge_state.made_dry_run_writes.length;

  if (probe.tier === 'simple') {
    // Simple probes must use the brain AND stay within the documented
    // budget ("expected to resolve in ≤2 tool calls", zero writes).
    // Previously `brainCalls >= 1` with no upper bound, so over-tooling
    // could never fail (audit agentic-cats-19).
    return brainCalls >= 1 && brainCalls <= SIMPLE_TIER_MAX_BRAIN_CALLS && writes === 0;
  }

  // Complex probes: must use brain + must satisfy expects_dry_run_write
  if (probe.expects_dry_run_write) {
    return brainCalls >= 1 && writes >= 1;
  }
  // Complex without explicit write expectation: ≥2 tool calls total
  // (multi-hop signal).
  return brainCalls >= 2;
}

const BRAIN_READ_TOOLS = new Set([
  'search',
  'query',
  'get_page',
  'list_pages',
  'get_backlinks',
  'get_links',
  'get_timeline',
  'get_tags',
  'traverse_graph',
  'resolve_slugs',
  'get_chunks',
  'get_stats',
]);

// ─── Runner ──────────────────────────────────────────────────────────

async function runConcurrently<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]);
    }
  }
  const workerCount = Math.min(concurrency, items.length);
  const workers: Promise<void>[] = [];
  for (let i = 0; i < workerCount; i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

type ProbeOutcome =
  | { kind: 'scored'; row: SkillCompliancePerProbe; transcript: Transcript }
  | { kind: 'errored'; transcript?: Transcript };

export async function runCat8(opts: RunCat8Options): Promise<Cat8Report> {
  const startedAt = new Date().toISOString();
  const concurrency = opts.concurrency ?? 4;
  const thresholds = {
    brain_first_compliance: 0.95,
    back_link_compliance: 0.9,
    citation_format: 0.95,
    tier_escalation: 0.8,
    ...opts.thresholds,
  };

  const acc = new ProbeAccounting(opts.probes.length);

  const outcomes = await runConcurrently(opts.probes, concurrency, async (probe): Promise<ProbeOutcome> => {
    let result: AgentRunResult;
    try {
      result = await runAgentLoop(probe.id, probe.text, opts.state, {
        client: opts.client,
        model: opts.model,
        maxTokens: opts.maxTokens,
        turnCap: opts.turnCap,
        systemPrompt: opts.systemPrompt,
        maxRetries: opts.maxRetries,
      });
    } catch (err) {
      // WS0: thrown loop errors are infra (SUT misbehavior no longer throws
      // — it becomes is_error tool_results or a graceful stop_reason).
      const msg = err instanceof Error ? err.message : String(err);
      acc.error(probe.id, classifyAgentError(err), msg);
      return { kind: 'errored' };
    }

    if (result.stop_reason === 'rate_limit_exhausted') {
      // Anthropic outage, not the SUT's fault: excluded from denominators, capped.
      acc.error(probe.id, 'dependency', 'Anthropic rate limit exhausted after retries — probe not scored');
      return { kind: 'errored', transcript: result.transcript };
    }

    const row: SkillCompliancePerProbe = {
      probe_id: probe.id,
      tier: probe.tier,
      brain_first: result.brain_first_ordering,
      brain_first_compliant: scoreBrainFirst(result),
      dry_run_writes: result.tool_bridge_state.made_dry_run_writes.length,
      back_link_compliant: scoreBackLinkCompliance(result),
      citation_format_compliant: scoreCitationFormat(result),
      tier_escalation_correct: scoreTierEscalation(probe, result),
      stop_reason: result.stop_reason,
      total_cost_usd: result.total_cost_usd,
    };
    const fractionPassed =
      (Number(row.brain_first_compliant) +
        Number(row.back_link_compliant) +
        Number(row.citation_format_compliant) +
        Number(row.tier_escalation_correct)) / 4;
    acc.score(probe.id, fractionPassed);
    return { kind: 'scored', row, transcript: result.transcript };
  });

  const perProbe = outcomes.filter(o => o.kind === 'scored').map(o => (o as Extract<ProbeOutcome, { kind: 'scored' }>).row);
  const transcripts = outcomes
    .map(o => o.transcript)
    .filter((t): t is Transcript => t !== undefined)
    .sort((a, b) => a.probe_id.localeCompare(b.probe_id));

  const total = perProbe.length;
  const brain = perProbe.filter(p => p.brain_first_compliant).length;
  const back = perProbe.filter(p => p.back_link_compliant).length;
  const cite = perProbe.filter(p => p.citation_format_compliant).length;
  const tier = perProbe.filter(p => p.tier_escalation_correct).length;
  const metrics = {
    brain_first_compliance: total === 0 ? 0 : brain / total,
    back_link_compliance: total === 0 ? 0 : back / total,
    citation_format: total === 0 ? 0 : cite / total,
    tier_escalation: total === 0 ? 0 : tier / total,
  };

  let verdict: 'pass' | 'fail' | 'baseline_only';
  if (!opts.enableThreshold) {
    verdict = 'baseline_only';
  } else {
    const allPass =
      metrics.brain_first_compliance >= thresholds.brain_first_compliance &&
      metrics.back_link_compliance >= thresholds.back_link_compliance &&
      metrics.citation_format >= thresholds.citation_format &&
      metrics.tier_escalation >= thresholds.tier_escalation;
    verdict = allPass ? 'pass' : 'fail';
  }

  const summary = acc.summary();
  const report: Cat8Report = {
    schema_version: 1,
    ran_at: new Date().toISOString(),
    total_probes: summary.n_total,
    scored_probes: summary.n_scored,
    brain_first_compliance: metrics.brain_first_compliance,
    back_link_compliance: metrics.back_link_compliance,
    citation_format: metrics.citation_format,
    tier_escalation: metrics.tier_escalation,
    per_probe: perProbe,
    errors: summary.errors,
    infra_error_rate: summary.infra_error_rate,
    run_invalid: summary.run_invalid,
    publishable: summary.publishable,
    total_cost_usd: perProbe.reduce((sum, p) => sum + p.total_cost_usd, 0),
    verdict,
  };

  writeCat8Artifacts(opts, report, summary, transcripts, startedAt);
  return report;
}

// ─── Receipt + flight-recorder ────────────────────────────────────────

function writeCat8Artifacts(
  opts: RunCat8Options,
  report: Cat8Report,
  summary: ProbeSummary,
  transcripts: Transcript[],
  startedAt: string,
): void {
  const reportsRoot = opts.reportsRoot ?? undefined;
  const model = opts.model ?? DEFAULT_AGENT_MODEL;
  const resolvedConfig: Record<string, unknown> = {
    agent_model: model,
    turn_cap: opts.turnCap ?? 10,
    max_retries: opts.maxRetries ?? 3,
    // WS5: search mode + reranker state the adapter pinned before ingest.
    search_config:
      opts.state.resolved_search_config ??
      'not_pinned (state constructed outside ClaudeSonnetWithToolsAdapter.init)',
    thresholds_enabled: opts.enableThreshold ?? false,
  };

  const base = {
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: CAT8_CATEGORY,
    n_total: summary.n_total,
    n_scored: summary.n_scored,
    completion_rate: summary.completion_rate,
    errors: summary.errors,
    gbrain_version: gbrainVersion(),
    gbrain_pin: gbrainPin(),
    resolved_config: resolvedConfig,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
  } as const;

  const path = reportsRoot ? receiptPath(CAT8_CATEGORY, reportsRoot) : receiptPath(CAT8_CATEGORY);
  if (summary.n_total === 0) {
    writeReceipt(path, {
      ...base,
      run_status: 'skipped',
      skip_reason: 'no probes provided to runCat8',
      publishable: false,
    });
  } else if (summary.run_invalid) {
    // Infra error rate over the cap: no trustworthy verdict was produced.
    writeReceipt(path, { ...base, run_status: 'error', publishable: false });
  } else {
    // baseline_only executed without a real gate → receipt 'partial'.
    const receiptVerdict: ReceiptVerdict =
      report.verdict === 'baseline_only' ? 'partial' : report.verdict;
    writeReceipt(path, {
      ...base,
      run_status: 'completed',
      verdict: receiptVerdict,
      publishable: summary.publishable,
    });
  }

  // Flight-recorder bundle (audit agentic-cats-17): full per-probe
  // transcripts + scorecard so failed probes can be audited.
  if (transcripts.length > 0) {
    const scorecard: Scorecard = {
      schema_version: 1,
      config_card: {
        brainbench_version: BENCHMARK_VERSION,
        adapter: { name: 'claude-sonnet-with-tools', stack_id: 'gbrain', gbrain_commit: gbrainVersion() },
        driver_model: { model_id: model, provider: 'anthropic' },
        corpus_sha: opts.corpusSha ?? 'unknown',
        seed: 0,
      },
      cat: 8,
      N: 1,
      metrics: {
        brain_first_compliance: { mean: report.brain_first_compliance },
        back_link_compliance: { mean: report.back_link_compliance },
        citation_format: { mean: report.citation_format },
        tier_escalation: { mean: report.tier_escalation },
      },
      probes_total: summary.n_total,
      verdict: report.verdict,
      total_cost_usd: report.total_cost_usd,
    };
    emitBundle(
      {
        runId: opts.runId ?? 'run',
        cat: 8,
        adapter: { name: 'claude-sonnet-with-tools', stack_id: 'gbrain' },
        N: 1,
        transcripts,
        scorecard,
      },
      reportsRoot ? { reportsRoot } : {},
    );
  }
}

// Exports for tests
export {
  scoreBrainFirst,
  scoreBackLinkCompliance,
  scoreCitationFormat,
  scoreTierEscalation,
  finalAnswerCiteCount,
  producedFinalAnswer,
};
