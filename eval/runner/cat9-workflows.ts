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
 * rubric travels in the caller's reviewed scenario catalog alongside
 * ground-truth slugs (no catalog is committed; the one-probe
 * `gold/personalization-rubric.json` template was removed in 0.10.1). The runner resolves slugs to full
 * GroundTruthPage[] before handing evidence to the judge.
 *
 * Gold-resolution policy (audit agentic-cats-09): a ground_truth_slug that
 * does not resolve in pagesBySlug is a HARNESS error and fails loudly —
 * silently shrinking the judge's world-of-facts made the judge score
 * correct answers as hallucinations.
 *
 * Pricing: the judge and agent models are looked up in the budget ledger's
 * price table before the first scenario, so an unpriced judge stops the run
 * before any agent turn is paid for, not after each one (#219).
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
 *
 * Free checks (no agent, no judge): a scenario may also carry `setup` and
 * `checks` (eval/runner/cat9-checks.ts). `--checks` builds fresh keyword-only
 * PGLite brains from each scenario's setup, runs its checks with the gbrain
 * CLI and writes eval/reports/cat9-workflows-checks/receipt.json. The judged
 * path above ignores both fields. The committed catalog is
 * eval/data/cat9-workflows-v1/scenarios.json.
 *
 * Usage: bun eval/runner/cat9-workflows.ts --checks [--gbrain <checkout>[@ref]] [--scenarios <file>] [--only id,id] [--output <dir>] [--keep] [--json]
 */

import type { Anthropic } from '@anthropic-ai/sdk';
import {
  runAgentLoop,
  classifyAgentError,
  DEFAULT_AGENT_MODEL,
  AGENT_TEMPERATURE,
  type AgentAdapterState,
  type AgentRunConfig,
  type AgentRunResult,
} from './adapters/claude-sonnet-with-tools.ts';
import {
  JUDGE_PROMPT_VERSION,
  JUDGE_TEMPERATURE,
  judgePrice,
  scoreAnswer,
  type JudgeEvidence,
  type JudgeResult,
  type JudgeConfig,
  type RubricCriterion,
  type GroundTruthPage,
} from './judge.ts';
import { temperatureSent, toolChoiceSent } from './anthropic-request.ts';
import { ProbeAccounting, type ProbeSummary } from './probe-accounting.ts';
import {
  writeReceipt,
  receiptPath,
  BENCHMARK_VERSION,
  RECEIPT_SCHEMA_VERSION,
  noModelSpend,
  sourceTreeIdentity,
  type ProbeError,
  type ReceiptVerdict,
} from './receipt.ts';
import { gbrainVersion, gbrainPin } from './gbrain-version.ts';
import { gbrainSpecFrom, overlaySummary, productIdentityFor, resolveGbrainUnderTest, type GbrainUnderTest } from './gbrain-under-test.ts';
import { emitBundle, type Transcript, type Scorecard, type JudgeNote } from './recorder.ts';
import {
  cliExec,
  runScenarioChecks,
  scenarioStatus,
  summarizeChecks,
  validateChecks,
  type Cat9Check,
  type Cat9CheckRow,
  type Cat9Requirement,
  type Cat9SetupStep,
  type GbrainExec,
} from './cat9-checks.ts';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

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
  /** Where the scenario came from (an audit finding or guard). Informational. */
  origin?: string;
  /** Free path only: CLI steps that build the brain (cat9-checks.ts). The judged path ignores it. */
  setup?: Cat9SetupStep[];
  /** Free path only: CLI checks with fixed expectations, no judge. The judged path ignores it. */
  checks?: Cat9Check[];
  /** Free path only: what the whole scenario needs that a free run lacks. */
  requires?: Cat9Requirement[];
}

export interface Cat9Catalog {
  version: 1;
  status: string;
  judge_prompt_version?: string;
  fixture: { corpus_dir: string; [k: string]: unknown };
  scenarios: WorkflowScenario[];
  [k: string]: unknown;
}

export const DEFAULT_CAT9_CATALOG = resolve(import.meta.dir, '../data/cat9-workflows-v1/scenarios.json');

/** Problems with a catalog's shape; empty when valid. Covers the judged fields and the free-check fields. */
export function validateCatalog(cat: Cat9Catalog): string[] {
  const out: string[] = [];
  if (cat.version !== 1) out.push('catalog version must be 1');
  if (!cat.fixture || typeof cat.fixture.corpus_dir !== 'string') out.push('fixture.corpus_dir missing');
  if (!Array.isArray(cat.scenarios) || cat.scenarios.length === 0) return [...out, 'scenarios missing or empty'];
  const ids = new Set<string>();
  for (const s of cat.scenarios) {
    if (!s.id || ids.has(s.id)) out.push(`scenario id ${JSON.stringify(s.id)} missing or repeated`);
    ids.add(s.id);
    if (!ALL_WORKFLOWS.includes(s.workflow)) out.push(`${s.id}: workflow ${JSON.stringify(s.workflow)} is not one of ${ALL_WORKFLOWS.join(', ')}`);
    if (typeof s.text !== 'string' || s.text === '') out.push(`${s.id}: text missing`);
    if (!Array.isArray(s.ground_truth_slugs)) out.push(`${s.id}: ground_truth_slugs must be an array`);
    if (!Array.isArray(s.rubric) || s.rubric.length === 0) out.push(`${s.id}: rubric missing`);
    else for (const r of s.rubric) {
      if (!r.id || !r.criterion) out.push(`${s.id}: rubric entry needs id and criterion`);
      if (r.weight !== 1 && r.weight !== 2) out.push(`${s.id}/${r.id}: rubric weight must be 1 or 2`);
    }
    out.push(...validateChecks(s));
  }
  return out;
}

function walkMarkdown(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walkMarkdown(full, out);
    else if (e.name.endsWith('.md')) out.push(full);
  }
  return out;
}

function pageFromMarkdown(slug: string, text: string): GroundTruthPage {
  const title = /^title:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? slug;
  return { slug, title, content: text.replace(/^---\n[\s\S]*?\n---\n/, '').trim() };
}

/**
 * Gold pages for the judged path: every page under corpus/default and
 * corpus/work (slug = path without .md), plus each page a scenario saves with
 * `put <slug>` from a corpus/puts file. A slug saved from two different files
 * keeps the last one in catalog order (the newest version a scenario writes);
 * a check that expects its put to be refused (exit nonzero) writes nothing.
 */
export function corpusPagesForCatalog(cat: Cat9Catalog, catalogPath: string): Map<string, GroundTruthPage> {
  const corpus = resolve(dirname(catalogPath), cat.fixture.corpus_dir);
  const pages = new Map<string, GroundTruthPage>();
  for (const src of ['default', 'work']) {
    const root = join(corpus, src);
    if (!existsSync(root)) continue;
    for (const f of walkMarkdown(root)) {
      const slug = relative(root, f).replace(/\.md$/, '');
      pages.set(slug, pageFromMarkdown(slug, readFileSync(f, 'utf8')));
    }
  }
  for (const s of cat.scenarios) {
    for (const step of [...(s.setup ?? []), ...(s.checks ?? [])]) {
      const run = (step as { run?: string[] }).run;
      const stdin = (step as { stdin?: string }).stdin;
      if ((step as Cat9Check).expect?.exit === 'nonzero') continue;
      if (run && run[0] === 'put' && run[1] && stdin) pages.set(run[1], pageFromMarkdown(run[1], readFileSync(join(corpus, stdin), 'utf8')));
    }
  }
  return pages;
}

/** Read and validate a catalog; throws with every problem listed. */
export function loadCat9Catalog(path = DEFAULT_CAT9_CATALOG): Cat9Catalog {
  const cat = JSON.parse(readFileSync(path, 'utf8')) as Cat9Catalog;
  const problems = validateCatalog(cat);
  if (problems.length > 0) throw new Error(`Cat 9 catalog ${path} is invalid:\n  ${problems.join('\n  ')}`);
  return cat;
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
export const DEFAULT_JUDGE_MODEL = 'claude-haiku-5-5';

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

  // 'no_answer' is a first-class ordering label (judge.ts ToolCallSummary +
  // evidence-contract schema both carry it) — pass it straight through so
  // the judge sees that the run produced no final answer at all.
  const judgeOrdering = runResult.brain_first_ordering;

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
  judgePrice(opts.judge?.model ?? DEFAULT_JUDGE_MODEL);
  judgePrice(opts.model ?? DEFAULT_AGENT_MODEL);
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
    agent_temperature: AGENT_TEMPERATURE,
    judge_model: judgeModel,
    judge_temperature: JUDGE_TEMPERATURE,
    temperature_sent: { agent: temperatureSent(agentModel, AGENT_TEMPERATURE), judge: temperatureSent(judgeModel, JUDGE_TEMPERATURE) },
    tool_choice_sent: { judge: toolChoiceSent(judgeModel) },
    judge_prompt_version: JUDGE_PROMPT_VERSION,
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
    judge: { model: judgeModel, temperature: temperatureSent(judgeModel, JUDGE_TEMPERATURE) },
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


// ─── Free checks (no agent, no judge) ─────────────────────────────────

export const CAT9_CHECKS_CATEGORY = 'cat9-workflows-checks';

export interface Cat9ChecksScenarioRow {
  scenario_id: string;
  workflow: WorkflowId;
  status: ReturnType<typeof scenarioStatus>;
  checks: Cat9CheckRow[];
}

export interface Cat9ChecksReport {
  ran_at: string;
  gbrain_version: string;
  /** The commit actually run: the overlay's commit, or the declared pin. */
  gbrain_commit: string;
  engine: 'pglite';
  summary: ReturnType<typeof summarizeChecks>;
  scenarios: Cat9ChecksScenarioRow[];
}

export interface RunCat9ChecksOptions {
  catalog: Cat9Catalog;
  catalogPath: string;
  exec: GbrainExec;
  gbrain: { version: string; commit: string };
  only?: string[];
  tmpRoot?: string;
  keep?: boolean;
  log?: (line: string) => void;
}

/** Run every scenario's free checks in catalog order, one scenario at a time. */
export function runCat9Checks(o: RunCat9ChecksOptions): Cat9ChecksReport {
  const corpusDir = resolve(dirname(o.catalogPath), o.catalog.fixture.corpus_dir);
  if (!existsSync(corpusDir)) throw new Error(`Cat 9 corpus ${corpusDir} not found`);
  const picked = o.only && o.only.length > 0 ? o.catalog.scenarios.filter(s => o.only!.includes(s.id)) : o.catalog.scenarios;
  if (o.only && picked.length !== o.only.length) {
    const known = new Set(o.catalog.scenarios.map(s => s.id));
    throw new Error(`unknown scenario id(s): ${o.only.filter(id => !known.has(id)).join(', ')}`);
  }
  const scenarios: Cat9ChecksScenarioRow[] = [];
  for (const s of picked) {
    const rows = runScenarioChecks(s, { exec: o.exec, corpusDir, tmpRoot: o.tmpRoot, keep: o.keep });
    const status = scenarioStatus(rows);
    o.log?.(`[cat9 checks] ${s.id}: ${status}${rows.length ? ` (${rows.map(r => `${r.check_id}=${r.status}`).join(', ')})` : ''}`);
    scenarios.push({ scenario_id: s.id, workflow: s.workflow, status, checks: rows });
  }
  return {
    ran_at: new Date().toISOString(),
    gbrain_version: o.gbrain.version,
    gbrain_commit: o.gbrain.commit,
    engine: 'pglite',
    summary: summarizeChecks(scenarios.flatMap(s => s.checks)),
    scenarios,
  };
}

/** Markdown table of a checks report: one row per check. */
export function renderChecksTable(r: Cat9ChecksReport): string {
  const lines = [
    `gbrain ${r.gbrain_version} (${r.gbrain_commit.slice(0, 10)}), PGLite, keyword-only, no judge`,
    '',
    '| Scenario | Check | Result | Finding |',
    '|---|---|---|---|',
  ];
  for (const s of r.scenarios) {
    if (s.checks.length === 0) { lines.push(`| ${s.scenario_id} | (judged only) | no free checks | |`); continue; }
    for (const c of s.checks) lines.push(`| ${s.scenario_id} | ${c.check_id} | ${c.status} | ${c.finding ?? ''} |`);
  }
  return lines.join('\n');
}

function argValue(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  if (at >= 0) return argv[at + 1];
  const inline = argv.find(a => a.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) : undefined;
}

/** A portable name for the catalog: its path inside this repository, else its file name and content hash. */
export function catalogIdentity(catalogPath: string): string {
  const repo = resolve(import.meta.dir, '../..');
  const rel = relative(repo, catalogPath);
  if (!rel.startsWith('..') && !rel.startsWith('/')) return rel;
  return `${catalogPath.split('/').pop()} sha256:${createHash('sha256').update(readFileSync(catalogPath)).digest('hex')}`;
}

async function mainChecks(argv: string[]): Promise<number> {
  const catalogPath = resolve(argValue(argv, '--scenarios') ?? DEFAULT_CAT9_CATALOG);
  const catalog = loadCat9Catalog(catalogPath);
  const gut: GbrainUnderTest = resolveGbrainUnderTest(gbrainSpecFrom(argv));
  const commit = gut.overlay?.build.commit ?? gbrainPin();
  const log = (l: string) => console.error(l);
  log(`# Cat 9 free checks: gbrain ${gut.version} (${gut.overlay ? `overlay ${commit.slice(0, 10)}` : 'pinned'}), PGLite, no judge`);
  const startedAt = new Date().toISOString();
  const only = argValue(argv, '--only')?.split(',').filter(Boolean);
  const report = runCat9Checks({
    catalog, catalogPath, exec: cliExec(gut.root), gbrain: { version: gut.version, commit }, only, keep: argv.includes('--keep'), log,
  });
  const errorRows = report.scenarios.flatMap(s => s.checks.filter(c => c.status === 'error'));
  const ran = report.scenarios.flatMap(s => s.checks).filter(c => c.status !== 'not_run');
  const errors: ProbeError[] = errorRows.map(c => ({ probe_id: `${c.scenario_id}/${c.check_id}`, origin: 'harness', message: c.reasons.join('; ') }));
  const anyFail = ran.some(c => c.status === 'fail' || c.status === 'unexpected_pass');
  const output = argValue(argv, '--output');
  const path = output ? join(output, 'receipt.json') : receiptPath(CAT9_CHECKS_CATEGORY);
  writeReceipt(path, {
    ...noModelSpend('hermetic: provider keys stripped, keyword-only PGLite brains, gbrain CLI only; no model and no judge'),
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: CAT9_CHECKS_CATEGORY,
    run_status: 'completed',
    // Report-only: a known failure is a fail with a label, so the run is partial
    // until every check passes; an unlabelled fail or a known failure that now
    // passes makes it a fail so a reader looks.
    verdict: anyFail ? 'fail' : ran.every(c => c.status === 'pass') && ran.length > 0 ? 'pass' : 'partial',
    n_total: ran.length,
    n_scored: ran.length - errorRows.length,
    completion_rate: ran.length === 0 ? 0 : (ran.length - errorRows.length) / ran.length,
    errors,
    publishable: false,
    gbrain_version: gut.version,
    gbrain_pin: gbrainPin(),
    execution: { source_tree: sourceTreeIdentity(), product: productIdentityFor(gut) },
    resolved_config: {
      engine: 'pglite (gbrain init --pglite, one fresh brain per scenario and brain name)',
      embeddings: 'none: keyword-only brain, provider keys stripped from the child environment',
      catalog: catalogIdentity(catalogPath),
      only: only ?? null,
      gbrain_overlay: overlaySummary(gut),
      verdict_rule: 'pass = every check that ran passed; partial = every failure is a labelled known failure; fail = an unlabelled failure or a known failure that now passes',
    },
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    data: { report },
  });
  if (argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else console.log(renderChecksTable(report));
  log(`[cat9 checks] receipt: ${path}`);
  return errorRows.length > 0 ? 1 : 0;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (!argv.includes('--checks')) {
    console.error('Cat 9: only the free checks run from the command line: bun eval/runner/cat9-workflows.ts --checks [--gbrain <checkout>[@ref]]. The judged path is called through runCat9().');
    process.exit(2);
  }
  mainChecks(argv).then(code => process.exit(code), err => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
}
