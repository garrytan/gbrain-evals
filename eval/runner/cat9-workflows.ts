/**
 * Cat 9 — End-to-End Workflows.
 *
 * FEATURE BOUNDARY (what is under test vs what is seeded/stubbed):
 *   - UNDER TEST: the full agent workflow over gbrain's real operations
 *     surface (tool-bridge → gbrain handlers → PGLite engine) and the
 *     quality of the final answer against a per-scenario rubric.
 *   - SEEDED: the brain corpus + poison fixtures, the scenario catalog, and
 *     the gold ground-truth pages handed to the judge. The Sonnet agent and
 *     Haiku judge are live in real runs and stubs in hermetic tests.
 *
 * Replays ~50 scripted scenarios across 5 workflows through the agent
 * adapter, then scores each answer via judge.ts's rubric. Threshold
 * (informational): >80% pass rate per workflow.
 *
 * Workflows (canonical per TODOS.md and design-doc):
 *   - meeting_ingestion
 *   - email_to_brain
 *   - daily_task_prep
 *   - briefing
 *   - sync
 *
 * Each scenario carries its own rubric (3-5 criteria, weights 1-2). The
 * rubric lives in `eval/data/gold/personalization-rubric.json` alongside
 * ground-truth slugs. The runner resolves slugs to full
 * GroundTruthPage[] before handing evidence to the judge.
 *
 * Gold-resolution policy (audit agentic-cats-09): a ground_truth_slug that
 * does not resolve in pagesBySlug is a HARNESS error and fails loudly —
 * silently shrinking the judge's world-of-facts made the judge score
 * correct answers as hallucinations.
 *
 * Error policy (WS0, via probe-accounting.ts): judge_failed verdicts are
 * 'judge' errors (excluded from pass rates, capped) — never averaged in as
 * fails. Thrown agent-loop errors are dependency/harness. Turn-capped runs
 * with empty answers stay in the denominator (the judge fails them on the
 * rubric — that is the SUT miss).
 *
 * Every run writes a receipt (eval/reports/cat9-workflows/receipt.json by
 * default) and a flight-recorder bundle with per-scenario transcripts +
 * judge notes (previously discarded — audit agentic-cats-17).
 *
 * v1 verdict is baseline_only. Thresholds flip on after the 10-probe
 * Haiku-vs-hand-score calibration (κ > 0.7) lands alongside Day 3b corpus.
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
import {
  scoreAnswer,
  type JudgeEvidence,
  type JudgeResult,
  type JudgeConfig,
  type RubricCriterion,
  type GroundTruthPage,
} from './judge.ts';
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
import { emitBundle, type Transcript, type Scorecard, type JudgeNote } from './recorder.ts';

// ─── Types ────────────────────────────────────────────────────────────

export type WorkflowId =
  | 'meeting_ingestion'
  | 'email_to_brain'
  | 'daily_task_prep'
  | 'briefing'
  | 'sync';

export const ALL_WORKFLOWS: readonly WorkflowId[] = [
  'meeting_ingestion',
  'email_to_brain',
  'daily_task_prep',
  'briefing',
  'sync',
] as const;

export interface WorkflowScenario {
  id: string;
  workflow: WorkflowId;
  text: string;
  /** Slugs that resolve to GroundTruthPage objects for the judge. */
  ground_truth_slugs: string[];
  rubric: RubricCriterion[];
}

export interface Cat9PerScenario {
  scenario_id: string;
  workflow: WorkflowId;
  judge_result: JudgeResult;
  pass: boolean;
  agent_stop_reason: AgentRunResult['stop_reason'];
  agent_cost_usd: number;
}

export interface WorkflowRollup {
  workflow: WorkflowId;
  total: number;
  passed: number;
  pass_rate: number;
}

export interface Cat9Report {
  schema_version: 1;
  ran_at: string;
  /** Planned scenarios (accounting n_total). */
  total_scenarios: number;
  /** Scenarios that were agent-run AND judge-scored. */
  scored_scenarios: number;
  overall_pass_rate: number;
  per_workflow: WorkflowRollup[];
  per_scenario: Cat9PerScenario[];
  /** WS0 probe accounting: typed infra/judge errors, cap state, publishability. */
  errors: ProbeError[];
  infra_error_rate: number;
  run_invalid: boolean;
  publishable: boolean;
  total_cost_usd: number;
  verdict: 'pass' | 'fail' | 'baseline_only';
}

export interface Cat9Config extends Omit<AgentRunConfig, 'client'> {
  agentClient?: Anthropic;
  judgeClient?: Anthropic;
  judge?: Omit<JudgeConfig, 'client'>;
  /** Pass-rate threshold per workflow. Default 0.80. */
  passRateThreshold?: number;
  /** When false (default in v1), verdict is baseline_only. */
  enableThreshold?: boolean;
  concurrency?: number;
  /** Root for receipt + flight-recorder bundle. Default eval/reports. Tests point this at a tmp dir. */
  reportsRoot?: string;
  /** Run id used in the flight-recorder bundle directory name. Default 'run'. */
  runId?: string;
  /** Corpus provenance hash recorded in the scorecard config card. */
  corpusSha?: string;
}

export interface RunCat9Options extends Cat9Config {
  scenarios: WorkflowScenario[];
  state: AgentAdapterState;
  pagesBySlug: Map<string, GroundTruthPage>;
}

export const CAT9_CATEGORY = 'cat9-workflows';
const DEFAULT_JUDGE_MODEL = 'claude-haiku-4-5-20251001';

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

/**
 * Thrown when gold data references a slug that does not resolve. The Cat 9
 * runner records this as a 'harness' probe error — it must never silently
 * shrink the judge's world-of-facts (audit agentic-cats-09).
 */
export class GroundTruthResolutionError extends Error {
  constructor(
    public readonly scenarioId: string,
    public readonly missingSlugs: string[],
  ) {
    super(
      `Cat 9 gold drift: scenario ${scenarioId} references ground_truth_slugs that do not resolve: ` +
        `${missingSlugs.join(', ')}. The judge would score correct answers as hallucinations. ` +
        `Fix the gold data or the pagesBySlug map.`,
    );
    this.name = 'GroundTruthResolutionError';
  }
}

/**
 * Build a JudgeEvidence object for a scenario given the agent's run result.
 * Exported for tests — they verify the contract assembly in isolation.
 * Throws GroundTruthResolutionError when any gold slug fails to resolve.
 */
export function buildEvidence(
  scenario: WorkflowScenario,
  runResult: AgentRunResult,
  pagesBySlug: Map<string, GroundTruthPage>,
): JudgeEvidence {
  const ground_truth_pages: GroundTruthPage[] = [];
  const missing: string[] = [];
  for (const slug of scenario.ground_truth_slugs) {
    const page = pagesBySlug.get(slug);
    if (page) ground_truth_pages.push(page);
    else missing.push(slug);
  }
  if (missing.length > 0) {
    throw new GroundTruthResolutionError(scenario.id, missing);
  }

  // judge.ts's ToolCallSummary enum predates the 'no_answer' ordering label;
  // for no-answer runs we omit the field — the empty final_answer_text is
  // the honest signal (never map 'no_answer' onto 'answer_before_brain').
  const ordering = runResult.brain_first_ordering;
  const judgeOrdering = ordering === 'no_answer' ? undefined : ordering;

  return {
    schema_version: 1,
    probe: {
      id: scenario.id,
      text: scenario.text,
      category: 9,
    },
    final_answer_text: runResult.final_answer,
    evidence_refs: runResult.evidence_refs,
    tool_call_summary: {
      count_by_tool: runResult.tool_bridge_state.count_by_tool,
      saw_poison_items: runResult.tool_bridge_state.saw_poison_items,
      brain_first_ordering: judgeOrdering,
      made_dry_run_writes: runResult.tool_bridge_state.made_dry_run_writes.map(w => ({
        slug: w.slug,
        has_back_links: w.has_back_links,
        citation_format_ok: w.citation_format_ok,
        tool_name: w.tool_name,
      })),
    },
    ground_truth_pages,
    rubric: scenario.rubric,
  };
}

type ScenarioOutcome =
  | { kind: 'scored'; row: Cat9PerScenario; transcript: Transcript; judgeNote: JudgeNote }
  | { kind: 'errored'; transcript?: Transcript; judgeCost?: number };

export async function runCat9(opts: RunCat9Options): Promise<Cat9Report> {
  const startedAt = new Date().toISOString();
  const concurrency = opts.concurrency ?? 4;
  const passRateThreshold = opts.passRateThreshold ?? 0.8;

  const acc = new ProbeAccounting(opts.scenarios.length);

  const outcomes = await runConcurrently(opts.scenarios, concurrency, async (scenario): Promise<ScenarioOutcome> => {
    // Step 1: run the agent loop.
    let agentResult: AgentRunResult;
    try {
      agentResult = await runAgentLoop(scenario.id, scenario.text, opts.state, {
        client: opts.agentClient,
        model: opts.model,
        maxTokens: opts.maxTokens,
        turnCap: opts.turnCap,
        systemPrompt: opts.systemPrompt,
        maxRetries: opts.maxRetries,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      acc.error(scenario.id, classifyAgentError(err), msg);
      return { kind: 'errored' };
    }

    if (agentResult.stop_reason === 'rate_limit_exhausted') {
      acc.error(scenario.id, 'dependency', 'Anthropic rate limit exhausted after retries — scenario not scored');
      return { kind: 'errored', transcript: agentResult.transcript };
    }

    // Step 2: build evidence (fails loudly on gold drift), score with judge.
    let evidence: JudgeEvidence;
    try {
      evidence = buildEvidence(scenario, agentResult, opts.pagesBySlug);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[cat9] HARNESS ERROR: ${msg}`);
      acc.error(scenario.id, 'harness', msg);
      return { kind: 'errored', transcript: agentResult.transcript };
    }

    let judgeResult: JudgeResult;
    try {
      judgeResult = await scoreAnswer(evidence, {
        ...opts.judge,
        client: opts.judgeClient,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      acc.error(scenario.id, 'judge', msg);
      return { kind: 'errored', transcript: agentResult.transcript };
    }

    if (judgeResult.verdict === 'judge_failed') {
      // WS0: judge failures are excluded + capped, never scored as 0.
      acc.error(scenario.id, 'judge', `judge_failed: ${judgeResult.overall_rationale}`);
      return { kind: 'errored', transcript: agentResult.transcript, judgeCost: judgeResult.cost_usd };
    }

    const row: Cat9PerScenario = {
      scenario_id: scenario.id,
      workflow: scenario.workflow,
      judge_result: judgeResult,
      pass: judgeResult.verdict === 'pass',
      agent_stop_reason: agentResult.stop_reason,
      agent_cost_usd: agentResult.total_cost_usd,
    };
    acc.score(scenario.id, row.pass ? 1 : 0);
    const judgeNote: JudgeNote = {
      probe_id: scenario.id,
      rubric_id: judgeResult.rubric_id,
      verdict: judgeResult.verdict,
      scores: judgeResult.scores,
      overall_rationale: judgeResult.overall_rationale,
    };
    return { kind: 'scored', row, transcript: agentResult.transcript, judgeNote };
  });

  const perScenario = outcomes
    .filter((o): o is Extract<ScenarioOutcome, { kind: 'scored' }> => o.kind === 'scored')
    .map(o => o.row);
  const transcripts = outcomes
    .map(o => o.transcript)
    .filter((t): t is Transcript => t !== undefined)
    .sort((a, b) => a.probe_id.localeCompare(b.probe_id));
  const judgeNotes = outcomes
    .filter((o): o is Extract<ScenarioOutcome, { kind: 'scored' }> => o.kind === 'scored')
    .map(o => o.judgeNote)
    .sort((a, b) => a.probe_id.localeCompare(b.probe_id));

  // Per-workflow rollup (over scored scenarios only — infra/judge errors are
  // excluded from denominators per WS0, recorded in errors[]).
  const byWorkflow = new Map<WorkflowId, Cat9PerScenario[]>();
  for (const w of ALL_WORKFLOWS) byWorkflow.set(w, []);
  for (const s of perScenario) byWorkflow.get(s.workflow)!.push(s);

  const per_workflow: WorkflowRollup[] = [];
  for (const [workflow, scenarios] of byWorkflow) {
    const total = scenarios.length;
    const passed = scenarios.filter(s => s.pass).length;
    per_workflow.push({
      workflow,
      total,
      passed,
      pass_rate: total === 0 ? 0 : passed / total,
    });
  }

  const totalPassed = perScenario.filter(s => s.pass).length;
  const overallPassRate = perScenario.length === 0 ? 0 : totalPassed / perScenario.length;

  let verdict: 'pass' | 'fail' | 'baseline_only';
  if (!opts.enableThreshold) {
    verdict = 'baseline_only';
  } else {
    const allWorkflowsPass = per_workflow
      .filter(w => w.total > 0) // ignore empty workflows
      .every(w => w.pass_rate >= passRateThreshold);
    verdict = allWorkflowsPass ? 'pass' : 'fail';
  }

  const totalCost =
    perScenario.reduce((sum, s) => sum + s.agent_cost_usd + s.judge_result.cost_usd, 0);

  const summary = acc.summary();
  const report: Cat9Report = {
    schema_version: 1,
    ran_at: new Date().toISOString(),
    total_scenarios: summary.n_total,
    scored_scenarios: summary.n_scored,
    overall_pass_rate: overallPassRate,
    per_workflow,
    per_scenario: perScenario,
    errors: summary.errors,
    infra_error_rate: summary.infra_error_rate,
    run_invalid: summary.run_invalid,
    publishable: summary.publishable,
    total_cost_usd: totalCost,
    verdict,
  };

  writeCat9Artifacts(opts, report, summary, transcripts, judgeNotes, startedAt);
  return report;
}

// ─── Receipt + flight-recorder ────────────────────────────────────────

function writeCat9Artifacts(
  opts: RunCat9Options,
  report: Cat9Report,
  summary: ProbeSummary,
  transcripts: Transcript[],
  judgeNotes: JudgeNote[],
  startedAt: string,
): void {
  const reportsRoot = opts.reportsRoot ?? undefined;
  const agentModel = opts.model ?? DEFAULT_AGENT_MODEL;
  const judgeModel = opts.judge?.model ?? DEFAULT_JUDGE_MODEL;
  const resolvedConfig: Record<string, unknown> = {
    agent_model: agentModel,
    judge_model: judgeModel,
    turn_cap: opts.turnCap ?? 10,
    max_retries: opts.maxRetries ?? 3,
    pass_rate_threshold: opts.passRateThreshold ?? 0.8,
    // WS5: search mode + reranker state the adapter pinned before ingest.
    search_config:
      opts.state.resolved_search_config ??
      'not_pinned (state constructed outside ClaudeSonnetWithToolsAdapter.init)',
    thresholds_enabled: opts.enableThreshold ?? false,
  };

  const base = {
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: CAT9_CATEGORY,
    n_total: summary.n_total,
    n_scored: summary.n_scored,
    completion_rate: summary.completion_rate,
    errors: summary.errors,
    gbrain_version: gbrainVersion(),
    gbrain_pin: gbrainPin(),
    resolved_config: resolvedConfig,
    judge: { model: judgeModel, temperature: 0 },
    started_at: startedAt,
    finished_at: new Date().toISOString(),
  } as const;

  const path = reportsRoot ? receiptPath(CAT9_CATEGORY, reportsRoot) : receiptPath(CAT9_CATEGORY);
  if (summary.n_total === 0) {
    writeReceipt(path, {
      ...base,
      run_status: 'skipped',
      skip_reason: 'no scenarios provided to runCat9',
      publishable: false,
    });
  } else if (summary.run_invalid) {
    writeReceipt(path, { ...base, run_status: 'error', publishable: false });
  } else {
    const receiptVerdict: ReceiptVerdict =
      report.verdict === 'baseline_only' ? 'partial' : report.verdict;
    writeReceipt(path, {
      ...base,
      run_status: 'completed',
      verdict: receiptVerdict,
      publishable: summary.publishable,
    });
  }

  // Flight-recorder bundle (audit agentic-cats-17): transcripts + judge notes.
  if (transcripts.length > 0) {
    const scorecard: Scorecard = {
      schema_version: 1,
      config_card: {
        brainbench_version: BENCHMARK_VERSION,
        adapter: { name: 'claude-sonnet-with-tools', stack_id: 'gbrain', gbrain_commit: gbrainVersion() },
        driver_model: { model_id: agentModel, provider: 'anthropic' },
        judge_model: { model_id: judgeModel, provider: 'anthropic' },
        corpus_sha: opts.corpusSha ?? 'unknown',
        seed: 0,
      },
      cat: 9,
      N: 1,
      metrics: {
        overall_pass_rate: { mean: report.overall_pass_rate },
      },
      probes_total: summary.n_total,
      probes_passed: report.per_scenario.filter(s => s.pass).length,
      probes_failed: report.per_scenario.filter(s => !s.pass).length,
      verdict: report.verdict,
      total_cost_usd: report.total_cost_usd,
    };
    emitBundle(
      {
        runId: opts.runId ?? 'run',
        cat: 9,
        adapter: { name: 'claude-sonnet-with-tools', stack_id: 'gbrain' },
        N: 1,
        transcripts,
        scorecard,
        judgeNotes: judgeNotes.length > 0 ? judgeNotes : undefined,
      },
      reportsRoot ? { reportsRoot } : {},
    );
  }
}
