/**
 * Memory-verb conformance on any storage engine (gbrain RUST_ENGINE.md gate E2: "conformance 24/24").
 *
 * Drives gbrain's own MEMORY_VERBS v1 certifier, `runConformance` (src/core/verbs/conformance.ts), over its embedded
 * cases (`CONFORMANCE_CASES`, src/core/verbs/conformance-fixtures.ts) through `dispatchToolCall` (src/mcp/dispatch.ts),
 * the layer both MCP transports share, as a remote caller scoped to world takes and the default source. This is the
 * in-process client gbrain's test/memory-verbs-conformance.test.ts uses on PGLite, pointed at a brain from
 * eval-engine.ts's openGateEngine, so the same cases run on PGLite, Postgres and Rust. tools/list is the build's
 * `buildToolDefs(operations)`.
 *
 * Keyless: provider keys are removed from the process for the run, GBRAIN_HOME is an empty directory, the gateway is
 * configured with no keys, and the chat and embed transports are rigged to throw, so a case that tried to reach a
 * model fails instead of spending; the receipt counts those attempts (rigged_transport_calls). The two synthesize cases run (runConformance's synthesize option) and pass only
 * through the keyless `unavailable` arm, as gbrain's own keyless self-certification test does; recall's query arm
 * degrades to keyword search.
 *
 * Gate metric: CONFORMANCE_CASES passed over the number of cases (24 at gbrain b66e4077). A skipped case is not a
 * pass. The tools/list checks (each verb advertised, synthesize marked expensive) are reported beside it, and the
 * verdict is pass only when every case passes and no tools/list check fails.
 *
 * Receipt: eval/reports/memory-verb-conformance/receipt.json, or engine-<kind>/receipt.json under it when
 * GBRAIN_EVAL_ENGINE is set.
 *
 * Usage: bun run eval/runner/memory-verb-conformance.ts [--json] [--gbrain <checkout>[@ref]] [--pg-url <admin url>]
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as Gateway from 'gbrain/ai/gateway';
import type * as Operations from 'gbrain/operations';
import type * as Conformance from '../../node_modules/gbrain/src/core/verbs/conformance.ts';
import type * as ConformanceFixtures from '../../node_modules/gbrain/src/core/verbs/conformance-fixtures.ts';
import type * as Dispatch from '../../node_modules/gbrain/src/mcp/dispatch.ts';
import type * as ToolDefs from '../../node_modules/gbrain/src/mcp/tool-defs.ts';
import type * as UsageLog from '../../node_modules/gbrain/src/core/verbs/usage-log.ts';
import { importGbrain } from './gbrain-under-test.ts';
import {
  EvalEngineUnavailable, gateReceiptPath, gateRunnerContext, gateRunnerReceiptFields, openGateEngine, preflightGateEngine, refuseEvalEngine,
  type GateRunnerContext,
} from './eval-engine.ts';
import { ProbeAccounting } from './probe-accounting.ts';
import { BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION, writeReceipt, type Receipt, noModelSpend } from './receipt.ts';
import { gbrainPin, gbrainVersion } from './gbrain-version.ts';

export const MEMORY_VERB_CONFORMANCE_CATEGORY = 'memory-verb-conformance';

const PROVIDER_KEYS = [
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY', 'ZEROENTROPY_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY', 'PARTICLE_API_KEY', 'GROQ_API_KEY', 'TOGETHER_API_KEY', 'DEEPSEEK_API_KEY',
];

export interface ConformanceCaseRow {
  case_id: string;
  index: number;
  verb: string;
  status: 'pass' | 'fail' | 'skip' | 'missing';
  detail: string;
}

export interface ListCheckRow {
  check: string;
  verb: string;
  status: 'pass' | 'fail' | 'skip';
  detail: string;
}

export interface ConformanceSummary {
  cases_total: number;
  cases_passed: number;
  cases_failed: number;
  cases_skipped: number;
  list_checks_total: number;
  list_checks_failed: number;
  protocol_version: number;
}

/**
 * Split runConformance's results into the fixture cases (matched to CONFORMANCE_CASES by name, in fixture order) and
 * the tools/list checks. A fixture case with no result is `missing`, which counts as not passed.
 */
export function splitConformanceResults(
  cases: ReadonlyArray<{ name: string; verb: string }>,
  results: ReadonlyArray<Conformance.CaseResult>,
): { rows: ConformanceCaseRow[]; listChecks: ListCheckRow[] } {
  const byName = new Map(results.map(r => [r.name, r]));
  const caseNames = new Set(cases.map(c => c.name));
  const rows = cases.map((c, index): ConformanceCaseRow => {
    const r = byName.get(c.name);
    return { case_id: c.name, index, verb: c.verb, status: r?.status ?? 'missing', detail: r?.detail ?? 'runConformance returned no result for this case' };
  });
  const listChecks = results.filter(r => !caseNames.has(r.name)).map(r => ({ check: r.name, verb: r.verb, status: r.status, detail: r.detail }));
  return { rows, listChecks };
}

export function summarizeConformance(rows: readonly ConformanceCaseRow[], listChecks: readonly ListCheckRow[], protocolVersion: number): ConformanceSummary {
  return {
    cases_total: rows.length,
    cases_passed: rows.filter(r => r.status === 'pass').length,
    cases_failed: rows.filter(r => r.status === 'fail' || r.status === 'missing').length,
    cases_skipped: rows.filter(r => r.status === 'skip').length,
    list_checks_total: listChecks.length,
    list_checks_failed: listChecks.filter(r => r.status === 'fail').length,
    protocol_version: protocolVersion,
  };
}

/** Pass only when every fixture case passed and no tools/list check failed. */
export function conformanceVerdict(s: ConformanceSummary): 'pass' | 'fail' {
  return s.cases_total > 0 && s.cases_passed === s.cases_total && s.list_checks_failed === 0 ? 'pass' : 'fail';
}

export interface MemoryVerbConformanceOptions {
  reportsDir?: string;
  quiet?: boolean;
  /** The gbrain build and engine (eval-engine.ts gateRunnerContext); defaults to the one process.argv and the environment name. */
  ctx?: GateRunnerContext;
  /** Test hook: rewrite each successful verb response before the certifier reads it. A lying server must fail the run. */
  corruptResponse?: (verb: string, body: Record<string, unknown>) => Record<string, unknown>;
}

export interface MemoryVerbConformanceResult {
  receipt: Receipt;
  receiptFile: string;
  exitCode: number;
}

export async function runMemoryVerbConformance(options: MemoryVerbConformanceOptions = {}): Promise<MemoryVerbConformanceResult> {
  const startedAt = new Date().toISOString();
  const ctx = options.ctx ?? gateRunnerContext(process.argv);
  const receiptFile = gateReceiptPath(ctx, MEMORY_VERB_CONFORMANCE_CATEGORY, options.reportsDir ?? join(process.cwd(), 'eval/reports'));
  const log = options.quiet ? (_: string) => {} : (s: string) => console.log(s);

  const { runConformance } = await importGbrain<typeof Conformance>(ctx.gut, 'src/core/verbs/conformance.ts');
  const { CONFORMANCE_CASES } = await importGbrain<typeof ConformanceFixtures>(ctx.gut, 'src/core/verbs/conformance-fixtures.ts');
  const { dispatchToolCall } = await importGbrain<typeof Dispatch>(ctx.gut, 'src/mcp/dispatch.ts');
  const { buildToolDefs } = await importGbrain<typeof ToolDefs>(ctx.gut, 'src/mcp/tool-defs.ts');
  const { operations } = await importGbrain<typeof Operations>(ctx.gut, 'src/core/operations.ts');
  const { __setUsageLogPathForTests } = await importGbrain<typeof UsageLog>(ctx.gut, 'src/core/verbs/usage-log.ts');
  const { configureGateway, resetGateway, __setChatTransportForTests, __setEmbedTransportForTests } = await importGbrain<typeof Gateway>(ctx.gut, 'src/core/ai/gateway.ts');

  const home = mkdtempSync(join(tmpdir(), 'memory-verb-conformance-home-'));
  const savedEnv = Object.fromEntries([...PROVIDER_KEYS, 'GBRAIN_HOME'].map(k => [k, process.env[k]]));
  for (const k of PROVIDER_KEYS) delete process.env[k];
  process.env.GBRAIN_HOME = home;
  __setUsageLogPathForTests(join(home, 'usage.jsonl'));
  resetGateway();
  configureGateway({ env: {} });
  const transportCalls = { chat: 0, embed: 0 };
  __setChatTransportForTests(() => { transportCalls.chat++; throw new Error('memory-verb conformance is keyless: no chat model may be called'); });
  __setEmbedTransportForTests((() => { transportCalls.embed++; throw new Error('memory-verb conformance is keyless: no embedding model may be called'); }) as never);

  const cases = CONFORMANCE_CASES as ReadonlyArray<{ name: string; verb: string }>;
  const acc = new ProbeAccounting(cases.length);
  let report: Conformance.ConformanceReport | null = null;
  let runError: string | null = null;
  try {
    const scratch = await openGateEngine(ctx, 'verbconf');
    try {
      const client: Conformance.ConformanceClient = {
        listTools: async () => buildToolDefs(operations).map(t => ({ name: t.name, description: t.description, annotations: t.annotations })),
        callTool: async (name, params) => {
          const res = await dispatchToolCall(scratch.engine, name, params, { remote: true, takesHoldersAllowList: ['world'], sourceId: 'default' });
          const text = res.content[0]?.text ?? '';
          if (!options.corruptResponse || res.isError) return { isError: res.isError, text };
          return { isError: res.isError, text: JSON.stringify(options.corruptResponse(name, JSON.parse(text))) };
        },
      };
      report = await runConformance(client, { marker: `gate-${ctx.kind}-${Date.now().toString(36)}`, synthesize: true });
    } finally {
      await scratch.close();
    }
  } catch (e) {
    runError = e instanceof Error ? e.message : String(e);
  } finally {
    resetGateway();
    __setChatTransportForTests(null);
    __setEmbedTransportForTests(null);
    __setUsageLogPathForTests(null);
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
  }

  const { rows, listChecks } = report ? splitConformanceResults(cases, report.results) : { rows: [], listChecks: [] };
  for (const r of rows) {
    if (r.status === 'pass') acc.score(r.case_id, 1);
    else acc.error(r.case_id, 'sut', `${r.case_id}: ${r.status}${r.detail ? ` (${r.detail})` : ''}`);
  }
  if (runError) acc.error('run', 'sut', runError);
  const summary = summarizeConformance(rows, listChecks, report?.protocol_version ?? 0);
  const verdict = conformanceVerdict(summary);
  const a = acc.summary();

  const receipt: Receipt = {
    ...noModelSpend('hermetic: provider keys removed, chat and embed transports rigged to throw'),
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: MEMORY_VERB_CONFORMANCE_CATEGORY,
    run_status: runError ? 'error' : 'completed',
    ...(runError ? {} : { verdict }),
    n_total: a.n_total,
    n_scored: a.n_scored,
    completion_rate: a.completion_rate,
    errors: a.errors,
    publishable: !runError && a.publishable,
    gbrain_version: ctx.gut.overlay ? ctx.gut.version : gbrainVersion(),
    gbrain_pin: gbrainPin(),
    resolved_config: {
      engine: ctx.requested ?? 'pglite-in-memory',
      client: 'in-process dispatchToolCall, remote: true, takes holders [world], source default',
      tools_list: 'buildToolDefs(operations)',
      synthesize_cases: 'run keyless; pass only through the unavailable error arm',
      embed_transport: 'none (keys removed; transports rigged to throw)',
    },
    ...gateRunnerReceiptFields(ctx),
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    data: { summary, cases: rows, list_checks: listChecks, rigged_transport_calls: transportCalls, ...(runError ? { run_error: runError } : {}) },
  };
  writeReceipt(receiptFile, receipt);

  log(`# Memory-verb conformance (MEMORY_VERBS v${summary.protocol_version}) on ${ctx.kind}\n`);
  for (const r of rows) log(`  ${r.status === 'pass' ? '✓' : '✗'} [${r.verb}] ${r.case_id}${r.detail ? ` — ${r.detail}` : ''}`);
  for (const c of listChecks) log(`  ${c.status === 'pass' ? '✓' : c.status === 'skip' ? '−' : '✗'} ${c.check}${c.detail ? ` — ${c.detail}` : ''}`);
  log(`\nCases: ${summary.cases_passed}/${summary.cases_total} passed; tools/list checks failed: ${summary.list_checks_failed}/${summary.list_checks_total}`);
  if (runError) log(`Run error: ${runError}`);
  log(`Verdict: ${receipt.verdict ?? 'n/a (run error)'}\nReceipt: ${receiptFile}`);

  return { receipt, receiptFile, exitCode: !runError && verdict === 'pass' ? 0 : 1 };
}

if (import.meta.main) {
  const ctx = gateRunnerContext(process.argv);
  try { await preflightGateEngine(ctx); } catch (e) {
    if (e instanceof EvalEngineUnavailable) refuseEvalEngine(e, 'memory-verb conformance');
    throw e;
  }
  const json = process.argv.includes('--json');
  const result = await runMemoryVerbConformance({ ctx, quiet: json });
  if (json) process.stdout.write(JSON.stringify(result.receipt.data, null, 2) + '\n');
  process.exit(result.exitCode);
}
