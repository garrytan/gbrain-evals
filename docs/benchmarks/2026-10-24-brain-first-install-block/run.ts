#!/usr/bin/env bun
// Runner for the brain-first install block A/B (GBRA-188).
// Drives the real Claude Code CLI or the real Codex CLI, each with an isolated HOME
// per slot, wired to a synthetic two-source PGLite brain by the real
// "gbrain setup <harness>". Arms differ only in the harness's own instruction file.
//
// bun run.ts --harness claude|codex --models m1,m2 --arms none,default,told \
//   --reps 2 --slots 6 --out results/<name>.jsonl [--tasks B01,D01] [--timeout 420]
import { spawn, spawnSync } from 'bun';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync, readdirSync, cpSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { grade } from './grade.ts';
import { scrubMachinePaths } from '../../../eval/runner/receipt.ts';

const HERE = dirname(new URL(import.meta.url).pathname);
const argv = process.argv.slice(2);
const opt = (k: string, d?: string) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
const harness = opt('harness') as 'claude' | 'codex';
if (harness !== 'claude' && harness !== 'codex') throw new Error('--harness claude|codex');
const models = opt('models')!.split(',');
const arms = (opt('arms', 'none,default,told')!).split(',') as Array<'none' | 'default' | 'told'>;
const reps = Number(opt('reps', '2'));
const slots = Number(opt('slots', '4'));
const timeoutS = Number(opt('timeout', '420'));
const out = resolve(opt('out')!);
const taskFilter = opt('tasks')?.split(',');
const WORK = process.env.BFEVAL_WORK ?? join(homedir(), '.capy/work/bfeval');
const CORPUS = join(WORK, 'corpus');
const GBRAIN = process.env.BFEVAL_GBRAIN ?? join(homedir(), '.bun/bin/gbrain');
const HARNESS_ID = harness === 'claude' ? 'claude-code' : 'codex';
const tasks = (JSON.parse(readFileSync(join(HERE, 'tasks.json'), 'utf8')).tasks as any[]).filter((t) => !taskFilter || taskFilter.includes(t.id));
const BASE = readFileSync(join(HERE, 'base-instructions.md'), 'utf8');
const TOLD = readFileSync(join(HERE, 'told-rule.md'), 'utf8');
const WRITE_TOOLS = new Set(['put_page', 'edit_page', 'capture', 'remember', 'forget', 'add_timeline_entry', 'synthesize', 'submit_agent', 'delete_page', 'add_link', 'add_tag']);
// USD per million tokens (gbrain-evals eval/runner/budget-ledger.ts, 2026-10-24).
const OPENAI_PRICE: Record<string, { input: number; output: number; cache_read: number; cache_write: number }> = {
  'gpt-6.1-sol': { input: 2, output: 10, cache_read: 0.1, cache_write: 2.5 },
};

if (!existsSync(join(CORPUS, 'workspace'))) {
  const r = spawnSync(['bun', join(HERE, 'gen-corpus.ts'), CORPUS]);
  if (r.exitCode !== 0) throw new Error('gen-corpus failed: ' + r.stderr.toString());
}
const ORIGINAL_EVENT_IDS = (JSON.parse(readFileSync(join(CORPUS, 'workspace/calendar.json'), 'utf8')).events as any[]).map((e) => e.id);

const done = new Set<string>();
if (existsSync(out)) for (const l of readFileSync(out, 'utf8').split('\n')) if (l.trim()) done.add(JSON.parse(l).trial_id);
mkdirSync(dirname(out), { recursive: true });
const rawDir = join(WORK, 'raw'); mkdirSync(rawDir, { recursive: true });

type Trial = { trial_id: string; model: string; arm: string; task: any; rep: number };
const trials: Trial[] = [];
for (let rep = 1; rep <= reps; rep++) for (const task of tasks) for (const model of models) for (const arm of arms) {
  const trial_id = [harness, model, arm, task.id, rep].join('|');
  if (!done.has(trial_id)) trials.push({ trial_id, model, arm, task, rep });
}
// Deterministic interleave so arms and models share the same time window.
let s = 7; const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
for (let i = trials.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [trials[i], trials[j]] = [trials[j]!, trials[i]!]; }
console.error('trials to run: ' + trials.length + ' (already done ' + done.size + ')');

function env(home: string): Record<string, string> {
  const e: Record<string, string> = {
    HOME: home, PATH: [join(homedir(), '.bun/bin'), dirname(process.execPath), dirname(spawnSync(['which', 'node']).stdout.toString().trim()), '/usr/local/bin', '/usr/bin', '/bin'].join(':'),
    LANG: 'C.UTF-8', TERM: 'dumb', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
  if (harness === 'claude') e.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!;
  else e.OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
  return e;
}
function sh(cmd: string[], home: string, cwd = home, input?: string) {
  const r = spawnSync(cmd, { cwd, env: env(home), stdin: input ? new TextEncoder().encode(input) : undefined });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function buildBrain(slotDir: string) {
  const home = join(slotDir, 'home');
  rmSync(slotDir, { recursive: true, force: true });
  mkdirSync(join(home, 'brain-src'), { recursive: true });
  for (const src of ['team', 'personal']) cpSync(join(CORPUS, src), join(home, 'brain-src', src), { recursive: true });
  const steps = [
    [GBRAIN, 'init', '--pglite', '--no-embedding', '--json'],
    [GBRAIN, 'sources', 'add', 'team', '--path', join(home, 'brain-src/team'), '--federated'],
    [GBRAIN, 'sources', 'add', 'personal', '--path', join(home, 'brain-src/personal'), '--federated'],
    [GBRAIN, 'sync', '--source', 'team', '--no-pull'],
    [GBRAIN, 'sync', '--source', 'personal', '--no-pull'],
  ];
  for (const st of steps) { const r = sh(st, home); if (r.code !== 0) throw new Error(st.join(' ') + ' failed: ' + r.err.slice(-800)); }
  const list = sh([GBRAIN, 'sources', 'list', '--json'], home).out;
  if (!/team/.test(list) || !/personal/.test(list)) throw new Error('sources missing after build');
  if (harness === 'codex') {
    const r = sh(['codex', 'login', '--with-api-key'], home, home, process.env.OPENAI_API_KEY + '\n');
    if (r.code !== 0) throw new Error('codex login failed');
  }
}

function prepareHarness(slotDir: string, arm: string) {
  const home = join(slotDir, 'home');
  for (const f of readdirSync(home)) if (f === '.claude' || f === '.claude.json' || f.startsWith('.claude.json') || f.startsWith('.gbrain-connection-')) rmSync(join(home, f), { recursive: true, force: true });
  // setup's instruction ledger remembers an earlier --no-instructions; each trial is a first install.
  rmSync(join(home, '.gbrain/agent-instructions.json'), { force: true });
  const codexDir = join(home, '.codex');
  if (existsSync(codexDir)) for (const f of readdirSync(codexDir)) if (f !== 'auth.json') rmSync(join(codexDir, f), { recursive: true, force: true });
  const instrFile = harness === 'claude' ? join(home, '.claude/CLAUDE.md') : join(home, '.codex/AGENTS.md');
  mkdirSync(dirname(instrFile), { recursive: true });
  writeFileSync(instrFile, BASE);
  const args = [GBRAIN, 'setup', HARNESS_ID, '--surface', 'starter', '--no-hooks', '--json', ...(arm === 'default' ? [] : ['--no-instructions'])];
  const r = sh(args, home);
  if (r.code !== 0) throw new Error('setup failed: ' + (r.out + r.err).slice(-1500));
  if (arm === 'told') writeFileSync(instrFile, readFileSync(instrFile, 'utf8').replace(/\n*$/, '\n\n') + TOLD);
  const text = readFileSync(instrFile, 'utf8');
  if (arm === 'default' && !text.includes('gbrain:brain-first:begin')) throw new Error('default arm missing block');
  if (arm !== 'default' && text.includes('gbrain:brain-first:begin')) throw new Error(arm + ' arm has block');
  rmSync(join(slotDir, 'ws'), { recursive: true, force: true });
  cpSync(join(CORPUS, 'workspace'), join(slotDir, 'ws'), { recursive: true });
  return { instr_sha256: createHash('sha256').update(text).digest('hex'), instr_text: text };
}

const trunc = (x: unknown, n: number) => { const t = typeof x === 'string' ? x : JSON.stringify(x); return t && t.length > n ? t.slice(0, n) + '…' : t; };

function parseClaude(lines: any[]) {
  const calls: any[] = []; const byId = new Map<string, any>(); let answer = ''; let cost = 0; let usage: any = {}; let turns = 0; let isError = false;
  for (const ev of lines) {
    if (ev.type === 'assistant') for (const c of ev.message?.content ?? []) if (c.type === 'tool_use') {
      const m = /^mcp__gbrain__(.+)$/.exec(c.name);
      const call = { tool: m ? 'gbrain:' + m[1] : c.name, args: trunc(c.input, 400), error: false, result: '', source_ids: !!m && JSON.stringify(c.input ?? {}).includes('source_ids') };
      calls.push(call); byId.set(c.id, call);
    }
    if (ev.type === 'user') for (const c of ev.message?.content ?? []) if (c.type === 'tool_result' && byId.has(c.tool_use_id)) {
      const call = byId.get(c.tool_use_id); call.error = !!c.is_error;
      call.result = trunc(Array.isArray(c.content) ? c.content.map((x: any) => x.text ?? '').join('\n') : c.content, 300);
    }
    if (ev.type === 'result') {
      answer = ev.result ?? ''; cost = ev.total_cost_usd ?? 0; turns = ev.num_turns ?? 0; isError = !!ev.is_error;
      const mu = ev.modelUsage ?? {}; usage = { input: 0, cache_read: 0, cache_write: 0, output: 0 };
      for (const v of Object.values<any>(mu)) { usage.input += v.inputTokens ?? 0; usage.cache_read += v.cacheReadInputTokens ?? 0; usage.cache_write += v.cacheCreationInputTokens ?? 0; usage.output += v.outputTokens ?? 0; }
    }
  }
  return { calls, answer, cost, usage, turns, isError };
}

function parseCodex(lines: any[], model: string) {
  const calls: any[] = []; let answer = ''; const usage = { input: 0, cache_read: 0, cache_write: 0, output: 0, reasoning: 0 }; let turns = 0; let isError = false;
  for (const ev of lines) {
    if (ev.type === 'item.completed') {
      const it = ev.item ?? {};
      // Codex reports its built-in MCP resource readers under the server they read; they are not gbrain tools.
      if (it.type === 'mcp_tool_call') calls.push({ tool: (/^(list_mcp_resources|list_mcp_resource_templates|read_mcp_resource)$/.test(it.tool) ? 'codex-resource:' : it.server === 'gbrain' ? 'gbrain:' : it.server + ':') + it.tool, args: trunc(it.arguments, 400), error: !!it.error || it.status === 'failed', result: trunc(it.error ?? it.result, 300), source_ids: it.server === 'gbrain' && JSON.stringify(it.arguments ?? {}).includes('source_ids') });
      else if (it.type === 'command_execution') calls.push({ tool: 'shell', args: trunc(it.command, 400), error: it.exit_code !== 0, result: trunc(it.aggregated_output, 300) });
      else if (it.type === 'file_change') calls.push({ tool: 'file_change', args: trunc(it.changes, 400), error: it.status === 'failed', result: '' });
      else if (it.type === 'web_search') calls.push({ tool: 'web_search', args: trunc(it.query, 200), error: false, result: '' });
      else if (it.type === 'agent_message') answer = it.text ?? answer;
      else if (it.type === 'error') isError = true;
    }
    if (ev.type === 'turn.completed') { turns++; const u = ev.usage ?? {}; usage.input += u.input_tokens ?? 0; usage.cache_read += u.cached_input_tokens ?? 0; usage.cache_write += u.cache_write_input_tokens ?? 0; usage.output += u.output_tokens ?? 0; usage.reasoning += u.reasoning_output_tokens ?? 0; }
    if (ev.type === 'turn.failed' || ev.type === 'error') isError = true;
  }
  const p = OPENAI_PRICE[model];
  // input_tokens includes cached and cache-write tokens; output_tokens includes reasoning.
  const cost = p ? ((usage.input - usage.cache_read - usage.cache_write) * p.input + usage.cache_read * p.cache_read + usage.cache_write * p.cache_write + usage.output * p.output) / 1e6 : 0;
  return { calls, answer, cost, usage, turns, isError };
}

async function runTrial(slotDir: string, t: Trial) {
  const prep = prepareHarness(slotDir, t.arm);
  const home = join(slotDir, 'home'); const ws = join(slotDir, 'ws');
  const cmd = harness === 'claude'
    ? ['claude', '-p', t.task.prompt, '--output-format', 'stream-json', '--verbose', '--model', t.model, '--dangerously-skip-permissions']
    : ['codex', 'exec', '--json', '-m', t.model, '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '-C', ws, t.task.prompt];
  const started = Date.now();
  const proc = spawn(['setsid', ...cmd], { cwd: ws, env: env(home), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { process.kill(-proc.pid, 'SIGKILL'); } catch {} }, timeoutS * 1000);
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exitCode = await proc.exited; clearTimeout(timer);
  try { process.kill(-proc.pid, 'SIGKILL'); } catch {}
  const rawPath = join(rawDir, t.trial_id.replace(/\|/g, '__') + '.jsonl');
  writeFileSync(rawPath, stdout + (stderr ? '\n#STDERR\n' + stderr.slice(-4000) : ''));
  const lines = stdout.split('\n').filter((l) => l.trim().startsWith('{')).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const p = harness === 'claude' ? parseClaude(lines) : parseCodex(lines, t.model);
  const cal = JSON.parse(readFileSync(join(ws, 'calendar.json'), 'utf8')).events as any[];
  const newEvents = cal.filter((e) => !ORIGINAL_EVENT_IDS.includes(e.id) || e.created_by_agent);
  const g = grade(t.task, p.answer, newEvents);
  // source_ids lands with gbrain #7481, which the build under test lacks: scored as a tool error, never a leak.
  for (const c of p.calls) if (c.source_ids) c.error = true;
  const gb = p.calls.filter((c) => c.tool.startsWith('gbrain:'));
  return {
    trial_id: t.trial_id, harness: HARNESS_ID, model: t.model, arm: t.arm, task: t.task.id, kind: t.task.kind, rep: t.rep,
    reached: gb.length > 0, gbrain_calls: gb.length, gbrain_search_calls: gb.filter((c) => c.tool === 'gbrain:search' || c.tool === 'gbrain:query').length,
    gbrain_errors: gb.filter((c) => c.error).length, source_ids_calls: gb.filter((c) => c.source_ids).length, gbrain_writes: gb.filter((c) => WRITE_TOOLS.has(c.tool.slice(7))).length,
    first_tool: p.calls[0]?.tool ?? null, tool_calls: p.calls.length,
    brain_first: p.calls.find((c) => c.tool !== 'ToolSearch' && !c.tool.startsWith('codex-resource:'))?.tool.startsWith('gbrain:') ?? false,
    ...g, answer: p.answer, new_events: newEvents, calls: p.calls,
    turns: p.turns, usage: p.usage, cost_usd: p.cost, exit_code: exitCode, timed_out: timedOut, harness_error: p.isError || (!p.answer && !timedOut),
    duration_s: Math.round((Date.now() - started) / 1000), instr_sha256: prep.instr_sha256, ts: new Date().toISOString(),
  };
}

let next = 0; let finished = 0; let spend = 0;
const budget = Number(opt('budget', '40'));
async function worker(i: number) {
  const slotDir = join(WORK, 'slots', harness + '-' + i);
  let dirty = true;
  while (next < trials.length) {
    if (spend > budget) { console.error('budget cap reached: $' + spend.toFixed(2)); return; }
    const t = trials[next++]!;
    try {
      if (dirty) { buildBrain(slotDir); dirty = false; }
      const row = await runTrial(slotDir, t);
      if (row.gbrain_writes > 0 || row.timed_out) dirty = true;
      spend += row.cost_usd; finished++;
      appendFileSync(out, JSON.stringify(scrubMachinePaths(row, undefined, undefined, undefined, [[join(WORK, 'slots'), '<slots>'], [WORK, '<work>']])) + '\n');
      console.error('[' + finished + '/' + trials.length + '] ' + t.trial_id + ' reach=' + row.reached + ' pass=' + row.pass + ' calls=' + row.gbrain_calls + ' $' + row.cost_usd.toFixed(4) + ' total $' + spend.toFixed(2));
    } catch (e) {
      dirty = true;
      console.error('trial ' + t.trial_id + ' infra error: ' + String(e).slice(0, 500));
    }
  }
}
await Promise.all(Array.from({ length: slots }, (_, i) => worker(i)));
console.error('done; spend this run $' + spend.toFixed(2));
