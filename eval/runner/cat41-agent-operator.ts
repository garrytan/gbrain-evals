#!/usr/bin/env bun
/**
 * Cat 41: Agent operator outcomes. Real Claude Code and Codex CLI sessions,
 * pinned in a container, drive gbrain through scripted user requests where an
 * agent operator commonly goes wrong: degraded recall, wrong parameters,
 * missing permissions, paid or destructive fixes, a locked or missing brain,
 * a fresh install. The scorer classifies every step (authorized execution,
 * required relay, correct refusal, successful recovery, consent violation,
 * false "no notes" answer) from the transcript, the container's gbrain call
 * log, a fake model provider's request log and file-system probes.
 *
 * Protocol: docs/benchmarks/2026-10-03-agent-operator-protocol.md.
 *
 * Usage:
 *   # one pass (paid: real harness sessions)
 *   bun eval/runner/cat41-agent-operator.ts run --gbrain <checkout>@<ref> --label baseline \
 *     [--harnesses claude,codex] [--scenarios all|id,id] [--repeat 3] [--concurrency 3] \
 *     [--claude-model claude-opus-5-5] [--codex-model gpt-6.1-sol] [--out eval/reports/cat41/<label>] \
 *     --paid (--budget-usd <n> | --budget-run-id <id>)
 *   # re-score a pass from its raw results ($0)
 *   bun eval/runner/cat41-agent-operator.ts score --out <dir>
 *   # token overhead of initialize instructions + tools/list per surface ($0)
 *   bun eval/runner/cat41-agent-operator.ts overhead --gbrain <checkout>@<ref> --out <dir>
 *   # the release gate
 *   bun eval/runner/cat41-agent-operator.ts gate --before <dir> --after <dir> [--out <file>]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { SCENARIOS, scenarioById, SEED_FACTS, SEED_PAGES, type Scenario } from './cat41/scenarios.ts';
import { classifyRun, gateMetrics, summarize, SCORER_VERSION, type CellSummary, type OverheadRow, type RunScore } from './cat41/classify.ts';
import { registryEntry } from '../registry.ts';
import { evaluatePromotion, describeOutcome } from './promotion.ts';
import { HARNESSES, type ContainerResult, type Harness } from './cat41/types.ts';
import { resolveGbrainUnderTest, overlaySummary } from './gbrain-under-test.ts';
import { scrubMachinePaths } from './receipt.ts';
import { BudgetRun, CHAT_PRICE_OVERRIDES, budgetOptionsFrom, receiptCost } from './budget-ledger.ts';
import { requirePaidArm } from './paid-arm.ts';
import { McpClient } from './cat40/gbrain-arm.ts';
import { runCli } from './lifecycle/drivers.ts';

export const CAT41_VERSION = 'cat41-v1';
export const IMAGE = 'gbrain-evals-cat41:v1';
export const PINS = { claude_code: '2.1.285', codex: '0.160.0', bun: '1.4.2', node: '24.18.0' } as const;
/** Each harness's own default model at the pinned version (recorded 2026-10-03), pinned explicitly. */
export const DEFAULT_MODELS: Record<Harness, string> = { claude: 'claude-opus-5-5', codex: 'gpt-6.1-sol' };
/** Reservation per container run before its actual cost is known. */
const RESERVE_USD: Record<Harness, number> = { claude: 2.5, codex: 1.5 };
/** Planning estimate per run, from the 2026-10-03 smoke runs. */
const ESTIMATE_USD: Record<Harness, number> = { claude: 0.5, codex: 0.2 };
/** A run whose harness crashed is retried up to this many extra times, then reported inconclusive. */
export const CRASH_RETRIES = 2;
const REPO = resolve(import.meta.dir, '../..');

function flag(argv: string[], name: string, fallback?: string): string | undefined {
  const eq = argv.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
}

function codexUsd(model: string, s: { input_tokens: number | null; cached_input_tokens: number | null; output_tokens: number | null }): number | null {
  const p = CHAT_PRICE_OVERRIDES[`openai:${model}`];
  if (!p || s.input_tokens == null) return null;
  const cached = s.cached_input_tokens ?? 0;
  return ((s.input_tokens - cached) * p.input + cached * (p.cache_read ?? p.input) + (s.output_tokens ?? 0) * p.output) / 1e6;
}

/** Fill Codex session costs from token usage at list prices (Claude Code reports its own). */
export function fillCosts(r: ContainerResult): ContainerResult {
  if (r.harness === 'codex') for (const s of r.sessions) if (s.cost_usd == null) s.cost_usd = codexUsd(r.model, s);
  return r;
}

function dockerRun(args: { scenario: string; harness: Harness; model: string; repeat: number; buildDir: string; out: string; docsBase: string; installSpec: string; gbrainRef: string; timeoutMs: number }): Promise<{ code: number; stderr: string }> {
  mkdirSync(args.out, { recursive: true });
  const name = `cat41-${args.scenario}-${args.harness}-${args.repeat}-${process.pid}`.replace(/_/g, '-');
  const uid = process.getuid?.() ?? 1000;
  const argv = ['run', '--rm', '--name', name, '--memory', '6g',
    '-e', 'ANTHROPIC_API_KEY', '-e', 'OPENAI_API_KEY',
    '-v', `${args.buildDir}:/opt/gbrain:ro`, '-v', `${join(REPO, 'eval/runner')}:/opt/runner:ro`, '-v', `${args.out}:/out`,
    IMAGE, 'bun', '/opt/runner/cat41/in-container.ts',
    '--scenario', args.scenario, '--harness', args.harness, '--model', args.model, '--repeat', String(args.repeat),
    '--docs-base', args.docsBase, '--install-spec', args.installSpec, '--gbrain-ref', args.gbrainRef, '--host-uid', String(uid)];
  return new Promise(resolvePromise => {
    const p = spawn('docker', argv, { stdio: ['ignore', 'ignore', 'pipe'], env: process.env });
    let stderr = '';
    p.stderr!.on('data', c => { stderr += c; if (stderr.length > 50_000) stderr = stderr.slice(-20_000); });
    const t = setTimeout(() => { spawn('docker', ['kill', name]); }, args.timeoutMs + 600_000);
    p.on('close', code => { clearTimeout(t); resolvePromise({ code: code ?? -1, stderr }); });
  });
}

function loadResult(dir: string): { result: ContainerResult; transcripts: string[] } | null {
  const f = join(dir, 'result.json');
  if (!existsSync(f)) return null;
  const result = fillCosts(JSON.parse(readFileSync(f, 'utf8')) as ContainerResult);
  const transcripts = result.sessions.map(s => existsSync(join(dir, s.raw_path)) ? readFileSync(join(dir, s.raw_path), 'utf8') : '');
  return { result, transcripts };
}

function runDirs(out: string): string[] {
  const root = join(out, 'runs');
  if (!existsSync(root)) return [];
  return readdirSync(root).filter(d => existsSync(join(root, d, 'result.json'))).sort().map(d => join(root, d));
}

/** Score every run directory; for crash-retried runs keep the last attempt. */
export function scoreDir(out: string): { scores: RunScore[]; cells: CellSummary[] } {
  const latest = new Map<string, { score: RunScore; attempt: number }>();
  for (const dir of runDirs(out)) {
    const loaded = loadResult(dir);
    if (!loaded) continue;
    const s = scenarioById(loaded.result.scenario);
    const score = classifyRun(s, loaded.result, loaded.transcripts);
    const attempt = Number(dir.match(/-a(\d+)$/)?.[1] ?? 0);
    const key = `${loaded.result.scenario}|${loaded.result.harness}|${loaded.result.repeat}`;
    const prev = latest.get(key);
    if (!prev || attempt > prev.attempt) latest.set(key, { score, attempt });
  }
  const scores = [...latest.values()].map(x => x.score).sort((a, b) => a.scenario.localeCompare(b.scenario) || a.harness.localeCompare(b.harness) || a.repeat - b.repeat);
  return { scores, cells: summarize(SCENARIOS, scores) };
}

function table(cells: CellSummary[]): string {
  const head = '| Scenario | Harness | Safety | Scored | Success | Violations (runs) | False-empty | Relay | Hung | Recovery | Mean wall s | Cost $ | Triage |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|';
  const rows = cells.map(c => `| ${c.scenario} | ${c.harness} | ${c.safety ? 'yes' : ''} | ${c.scored}/${c.runs} | ${c.successes}/${c.scored} | ${c.consent_violations} (${c.runs_with_violation}) | ${c.false_empty_runs} | ${c.relays} | ${c.hung_runs} | ${c.recoveries} | ${c.mean_wall_s ?? ''} | ${c.cost_usd.toFixed(2)} | ${c.triage} |`);
  return [head, ...rows].join('\n');
}

/**
 * Publishable JSON: the gbrain checkout path becomes `<gbrain>`, the container's agent home `~/` and its /tmp
 * `<tmp>/` (fictional container paths, but they read as machine-local), then host prefixes are scrubbed.
 */
export function publishable<T>(value: T): T {
  const text = JSON.stringify(value, (_k, v) => typeof v === 'string'
    ? v.replace(/^\/[^"@]*?\/gbrain(?=@|$)/, '<gbrain>').replace(/\/home\/agent\//g, '~/').replace(/(^|[^\w.])\/tmp\//g, '$1<tmp>/')
    : v);
  return scrubMachinePaths(JSON.parse(text) as T);
}

function writeSummary(out: string, meta: Record<string, unknown>) {
  const { scores, cells } = scoreDir(out);
  writeFileSync(join(out, 'scores.jsonl'), scores.map(s => JSON.stringify(publishable(s))).join('\n') + '\n');
  const totalCost = scores.reduce((a, s) => a + (s.cost_usd ?? 0), 0);
  const safety = cells.filter(c => c.safety);
  const summary = {
    version: CAT41_VERSION, scorer: SCORER_VERSION, ...meta,
    totals: {
      runs: scores.length, scored: scores.filter(s => s.status === 'scored').length,
      inconclusive: scores.filter(s => s.status === 'harness_crash').length, setup_errors: scores.filter(s => s.status === 'setup_error').length,
      successes: scores.filter(s => s.success).length, consent_violations: scores.reduce((a, s) => a + s.consent_violations, 0),
      safety_runs_with_violation: safety.reduce((a, c) => a + c.runs_with_violation, 0),
      false_empty_runs: scores.filter(s => s.false_empty).length, harness_cost_usd: Number(totalCost.toFixed(4)),
    },
    cells,
  };
  writeFileSync(join(out, 'summary.json'), JSON.stringify(publishable(summary), null, 2) + '\n');
  writeFileSync(join(out, 'summary.md'), `# Cat 41 ${meta.label ?? ''}\n\n${table(cells)}\n`);
  return summary;
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  const q = [...items];
  await Promise.all(Array.from({ length: Math.max(1, n) }, async () => { while (q.length) await fn(q.shift()!); }));
}

async function cmdRun(argv: string[]) {
  const spec = flag(argv, 'gbrain');
  if (!spec) throw new Error('--gbrain <checkout>@<ref> is required');
  const label = flag(argv, 'label', 'run')!;
  const harnesses = (flag(argv, 'harnesses', HARNESSES.join(','))!).split(',') as Harness[];
  const scenarioIds = flag(argv, 'scenarios', 'all') === 'all' ? SCENARIOS.map(s => s.id) : flag(argv, 'scenarios')!.split(',');
  const scenarios = scenarioIds.map(scenarioById);
  const repeat = Number(flag(argv, 'repeat', '3'));
  const concurrency = Number(flag(argv, 'concurrency', '3'));
  const models: Record<Harness, string> = { claude: flag(argv, 'claude-model', DEFAULT_MODELS.claude)!, codex: flag(argv, 'codex-model', DEFAULT_MODELS.codex)! };
  const out = resolve(flag(argv, 'out', join(REPO, 'eval/reports/cat41', label))!);
  mkdirSync(join(out, 'runs'), { recursive: true });

  const gut = resolveGbrainUnderTest(spec);
  const commit = gut.overlay!.build.commit;
  const docsBase = flag(argv, 'docs-base', `https://raw.githubusercontent.com/garrytan/gbrain/${commit}`)!;
  const installSpec = flag(argv, 'install-spec', `github:garrytan/gbrain#${commit}`)!;

  const jobs: Array<{ s: Scenario; h: Harness; r: number }> = [];
  for (const s of scenarios) for (const h of harnesses) for (let r = 1; r <= repeat; r++) jobs.push({ s, h, r });
  const estimate = jobs.reduce((a, j) => a + ESTIMATE_USD[j.h], 0);
  requirePaidArm(argv, { arm: 'cat41 agent sessions', estimateUsd: estimate, ledgerPath: budgetOptionsFrom(argv).ledgerPath });
  const opts = budgetOptionsFrom(argv);
  const budget = opts.runId ? BudgetRun.join({ runId: opts.runId, ledgerPath: opts.ledgerPath, programCapUsd: opts.programCapUsd }) : BudgetRun.open({ runner: 'cat41-agent-operator', budgetUsd: opts.budgetUsd!, estimateUsd: estimate, ledgerPath: opts.ledgerPath, programCapUsd: opts.programCapUsd });

  const meta = {
    label, gbrain: overlaySummary(gut), image: IMAGE, pins: PINS, models, repeat, harnesses, scenarios: scenarioIds,
    docs_base: docsBase, install_spec: installSpec, budget_run_id: budget.runId, tool_result_cap: 'none (harness defaults; the evaluator adds no per-tool-result cap)',
    seed: { pages: Object.keys(SEED_PAGES).length, facts: SEED_FACTS.length },
  };
  writeFileSync(join(out, 'meta.json'), JSON.stringify(publishable({ ...meta, started_at: new Date().toISOString() }), null, 2));
  console.log(`[cat41] ${jobs.length} runs (${scenarios.length} scenarios x ${harnesses.join('+')} x ${repeat}) against gbrain ${gut.version} @ ${commit.slice(0, 12)} -> ${out}`);

  await pool(jobs, concurrency, async ({ s, h, r }) => {
    for (let attempt = 0; attempt <= CRASH_RETRIES; attempt++) {
      const dir = join(out, 'runs', `${s.id}--${h}--r${r}-a${attempt}`);
      if (existsSync(join(dir, 'result.json'))) {
        const prev = loadResult(dir)!;
        const sc = classifyRun(s, prev.result, prev.transcripts);
        if (sc.status !== 'harness_crash') return;
        continue;
      }
      rmSync(dir, { recursive: true, force: true });
      const resId = budget.reserve(RESERVE_USD[h], `cat41 ${s.id} ${h} r${r} a${attempt}`);
      const t0 = Date.now();
      const d = await dockerRun({ scenario: s.id, harness: h, model: models[h], repeat: r, buildDir: gut.root, out: dir, docsBase, installSpec, gbrainRef: commit, timeoutMs: s.timeoutMs * 3 });
      const loaded = loadResult(dir);
      const cost = loaded ? loaded.result.sessions.reduce((a, x) => a + (x.cost_usd ?? 0), 0) : null;
      budget.settle(resId, loaded && loaded.result.sessions.every(x => x.cost_usd != null) ? { usd: cost!, input_tokens: loaded.result.sessions.reduce((a, x) => a + (x.input_tokens ?? 0), 0), output_tokens: loaded.result.sessions.reduce((a, x) => a + (x.output_tokens ?? 0), 0) } : null);
      if (!loaded) { writeFileSync(join(dir, 'docker-stderr.log'), d.stderr); console.log(`[cat41] ${s.id} ${h} r${r}: container failed (exit ${d.code})`); continue; }
      const sc = classifyRun(s, loaded.result, loaded.transcripts);
      console.log(`[cat41] ${s.id} ${h} r${r}${attempt ? ` attempt ${attempt}` : ''}: ${sc.status} success=${sc.success} violations=${sc.consent_violations} false_empty=${sc.false_empty} ${Math.round((Date.now() - t0) / 1000)}s $${(cost ?? 0).toFixed(3)} (${sc.success_why})`);
      if (sc.status !== 'harness_crash') return;
    }
  });
  const summary = writeSummary(out, { ...meta, finished_at: new Date().toISOString(), budget: receiptCost(budget.summary()) });
  if (!opts.runId) budget.close();
  console.log(readFileSync(join(out, 'summary.md'), 'utf8'));
  console.log(JSON.stringify(summary.totals));
}

/** Initialize instructions + tools/list bytes per MCP surface, on a keyless seeded brain. */
export async function measureOverhead(buildDir: string): Promise<OverheadRow[]> {
  const root = mkdtempSync(join(tmpdir(), 'cat41-overhead-'));
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: join(root, 'h'), GBRAIN_HOME: join(root, 'h'), LANG: 'C.UTF-8', TZ: 'UTC', NO_COLOR: '1', GBRAIN_SKIP_STARTUP_HOOKS: '1' };
  mkdirSync(env.HOME!, { recursive: true });
  const run = { buildDir, env };
  const must = async (args: string[]) => { const r = await runCli(run, args); if (r.code !== 0) throw new Error(`overhead setup: gbrain ${args.join(' ')} exited ${r.code}: ${r.stderr.slice(-400)}`); };
  await must(['init', '--pglite', '--no-embedding', '--json']);
  const vault = join(root, 'notes');
  for (const [rel, body] of Object.entries(SEED_PAGES)) { mkdirSync(join(vault, rel, '..'), { recursive: true }); writeFileSync(join(vault, rel), body); }
  await must(['import', vault, '--no-embed']);
  const rows: OverheadRow[] = [];
  for (const surface of ['verbs', 'starter', 'full']) {
    const c = new McpClient(run, ['--surface', surface]);
    await c.start();
    const instructions = Buffer.byteLength(c.instructions);
    const tools = Buffer.byteLength(JSON.stringify({ tools: c.tools }));
    rows.push({ surface, instructions_bytes: instructions, tools_list_bytes: tools, total_bytes: instructions + tools, tools: c.tools.length });
    await c.close();
  }
  rmSync(root, { recursive: true, force: true });
  return rows;
}

async function cmdOverhead(argv: string[]) {
  const spec = flag(argv, 'gbrain');
  if (!spec) throw new Error('--gbrain <checkout>@<ref> is required');
  const gut = resolveGbrainUnderTest(spec);
  const out = resolve(flag(argv, 'out', join(REPO, 'eval/reports/cat41/overhead'))!);
  mkdirSync(out, { recursive: true });
  const rows = await measureOverhead(gut.root);
  writeFileSync(join(out, 'overhead.json'), JSON.stringify(publishable({ version: CAT41_VERSION, gbrain: overlaySummary(gut), measured_at: new Date().toISOString(), rows }), null, 2) + '\n');
  console.table(rows);
}

/** Evaluate the registry's preregistered rules on a before/after pair of passes. */
export function gateReport(beforeDir: string | null, afterDir: string) {
  const before = beforeDir ? scoreDir(beforeDir).cells : null;
  const after = scoreDir(afterDir).cells;
  const ov = (d: string | null) => d && existsSync(join(d, 'overhead.json')) ? (JSON.parse(readFileSync(join(d, 'overhead.json'), 'utf8')).rows as OverheadRow[]) : null;
  const ob = ov(beforeDir), oa = ov(afterDir);
  const { metrics, checks } = gateMetrics(before, after, ob && oa ? { before: ob, after: oa } : undefined);
  const report = { version: CAT41_VERSION, scorer: SCORER_VERSION, before: beforeDir, after: afterDir, generated_at: new Date().toISOString(), data: { metrics, checks, cells_after: after, cells_before: before, overhead: { before: ob, after: oa } } };
  const outcome = evaluatePromotion(registryEntry('agent-operator')!.promotion!, report);
  return { report: { ...report, promotion: outcome }, outcome };
}

function cmdGate(argv: string[]) {
  const afterDir = flag(argv, 'after');
  if (!afterDir) throw new Error('--after <dir> is required');
  const beforeDir = flag(argv, 'before');
  const { report, outcome } = gateReport(beforeDir ? resolve(beforeDir) : null, resolve(afterDir));
  const outFile = flag(argv, 'out');
  if (outFile) writeFileSync(outFile, JSON.stringify(publishable(report), null, 2) + '\n');
  console.log(`GATE ${outcome.pass ? 'PASS' : 'FAIL'}: ${describeOutcome(outcome)}`);
  for (const c of report.data.checks) console.log(`  ${c.pass ? 'ok  ' : 'FAIL'} ${c.id}: ${c.detail}`);
  if (report.data.metrics.max_overhead_pct === undefined) console.log('  token overhead not compared: run `overhead --out <dir>` for both passes (the threshold fails closed)');
  process.exitCode = outcome.pass ? 0 : 1;
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'run') await cmdRun(rest);
  else if (cmd === 'score') { const out = resolve(flag(rest, 'out')!); const meta = existsSync(join(out, 'meta.json')) ? JSON.parse(readFileSync(join(out, 'meta.json'), 'utf8')) : {}; const s = writeSummary(out, meta); console.log(readFileSync(join(out, 'summary.md'), 'utf8')); console.log(JSON.stringify(s.totals)); }
  else if (cmd === 'overhead') await cmdOverhead(rest);
  else if (cmd === 'gate') cmdGate(rest);
  else { console.error('usage: cat41-agent-operator.ts run|score|overhead|gate (see the file header)'); process.exitCode = 2; }
}
