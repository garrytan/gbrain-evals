#!/usr/bin/env bun
// GBRA-156 A/B runner: multi-source scope arms (S0/S1/S2 over gbrain serve --http with bearer
// tokens) and the starter tools/list arms (base vs PR, gbrain serve over stdio). One minimal tool
// loop (eval/runner/cat40/loop.ts): the MCP tools/list mapped to function tools, results fed back.
// Every tool call and full result is written to JSONL. Paid requests go through the budget ledger.
//
//   bun docs/benchmarks/2026-10-24-multi-source-scope-tools-list/run.ts --suite scope \
//     --checkout <gbrain> --brain <dir> --corpus <dir> --budget-usd 40 [--models a,b] [--arms S0,S1,S2]
//   bun .../run.ts --suite starter --base-checkout <gbrain@base> --base-brain <dir> \
//     --pr-checkout <gbrain@pr> --pr-brain <dir> --budget-usd 40
import { BudgetRun, budgetOptionsFrom, installPaidRequestGuard, receiptCost } from '../../../eval/runner/budget-ledger.ts';
import { runAgent, type Arm, type ToolSpec } from '../../../eval/runner/cat40/loop.ts';
import { execSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { HttpMcp, StdioMcp, type McpClient } from './mcp.ts';
import { SCOPE_TASKS, STARTER_TASKS, MEMBER_SOURCE, allowedSources, type Member } from './tasks.ts';
import { gradeScope, gradeStarter, type ToolCall } from './grade.ts';

const argv = process.argv.slice(2);
const flag = (n: string, d?: string) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const suite = flag('suite') as 'scope' | 'starter';
if (suite !== 'scope' && suite !== 'starter') throw new Error('--suite scope|starter');
const HERE = import.meta.dir;
const models = flag('models', 'claude-opus-5-5,claude-sonnet-5-5,gpt-6.1-sol')!.split(',');
const arms = flag('arms', suite === 'scope' ? 'S0,S1,S2' : 'base,pr')!.split(',');
const taskFilter = flag('tasks')?.split(',');
const reps = Number(flag('reps', '1'));
const concurrency = Number(flag('concurrency', '6'));
const out = resolve(flag('out', join(HERE, 'results', suite + '.jsonl'))!);
const MAX_TURNS = 10, MAX_TOOL_CHARS = 20_000;
mkdirSync(dirname(out), { recursive: true });

const SUBMIT: ToolSpec = {
  name: 'submit_answer',
  description: 'Send your final reply to the person. Call this exactly once, when you are done.',
  input_schema: { type: 'object', properties: { answer: { type: 'string', description: 'Your complete reply to the person.' } }, required: ['answer'] },
};
const TEAM = 'You are the team assistant for acme-example. Team members ask you questions in chat, and you can use the team\'s gbrain memory tools to answer. ';
const scopeSystem = (m: Member, arm: string) => TEAM + 'The person asking now is ' + m + '. When you are done, call submit_answer with your complete reply to them.'
  + (arm === 'S1' ? '\n\nAccess policy: ' + m + ' may read only these gbrain sources: ' + allowedSources(m).join(', ') + '. Pass source_ids: ' + JSON.stringify(allowedSources(m))
    + ' on every search and query call, pass source_id when you read a page with get_page, and never reveal another member\'s private notes.' : '');
const STARTER_SYSTEM = TEAM + 'When you are done, call submit_answer with your complete reply.';

async function waitHealthy(url: string, proc: ReturnType<typeof spawn>, log: () => string) {
  for (let i = 0; i < 120; i++) {
    if (proc.exitCode !== null) throw new Error('server exited: ' + log().slice(-1500));
    try { if ((await fetch(url + '/health')).ok) return; } catch { /* starting */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('server not healthy: ' + log().slice(-1500));
}

interface Cell { arm: string; model: string; task: any; rep: number; client: McpClient; specs: ToolSpec[]; system: string; listBytes: number }
const cleanup: Array<() => Promise<void> | void> = [];
const cells: Cell[] = [];
const identity: Record<string, unknown> = {};
const gitHead = (dir: string) => { try { return execSync('git -C ' + JSON.stringify(dir) + ' rev-parse HEAD').toString().trim(); } catch { return null; } };
const toSpecs = (tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>) =>
  tools.map(t => ({ name: t.name, description: t.description ?? '', input_schema: { type: 'object', properties: {}, ...t.inputSchema } }));

if (suite === 'scope') {
  const checkout = resolve(flag('checkout')!), brain = resolve(flag('brain')!), port = Number(flag('port', '3151'));
  const tokens = JSON.parse(readFileSync(join(brain, 'tokens.json'), 'utf8')) as Record<string, string>;
  let log = '';
  const proc = spawn('bun', ['run', join(checkout, 'src/cli.ts'), 'serve', '--http', '--port', String(port), '--surface', 'starter'], { env: { ...process.env, GBRAIN_HOME: brain }, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout!.on('data', d => { log += d; }); proc.stderr!.on('data', d => { log += d; });
  cleanup.push(() => { proc.kill('SIGTERM'); });
  const base = 'http://127.0.0.1:' + port;
  await waitHealthy(base, proc, () => log);
  identity.gbrain = { checkout, head: gitHead(checkout), transport: 'http', surface: 'starter' };
  const clients: Record<string, { client: McpClient; specs: ToolSpec[]; bytes: number }> = {};
  for (const [who, tok] of Object.entries(tokens)) {
    const client = new HttpMcp(base, tok);
    const { tools, bytes } = await client.listTools();
    clients[who] = { client, specs: toSpecs(tools), bytes };
  }
  identity.tools_list = Object.fromEntries(Object.entries(clients).map(([k, v]) => [k, { tools: v.specs.length, bytes: v.bytes }]));
  for (const task of SCOPE_TASKS.filter(t => !taskFilter || taskFilter.includes(t.id))) for (const arm of arms) for (const model of models) for (let rep = 0; rep < reps; rep++) {
    const c = clients[arm === 'S2' ? task.member : 'all'];
    cells.push({ arm, model, task, rep, client: c.client, specs: c.specs, system: scopeSystem(task.member, arm), listBytes: c.bytes });
  }
} else {
  const servers: Record<string, { client: McpClient; specs: ToolSpec[]; bytes: number }> = {};
  for (const arm of arms) {
    const checkout = resolve(flag(arm + '-checkout')!), brain = resolve(flag(arm + '-brain')!);
    const client = new StdioMcp(join(checkout, 'src/cli.ts'), { GBRAIN_HOME: brain, GBRAIN_SURFACE: 'starter' });
    cleanup.push(() => client.close());
    const { tools, bytes } = await client.listTools();
    servers[arm] = { client, specs: toSpecs(tools), bytes };
    identity[arm] = { checkout, head: gitHead(checkout), transport: 'stdio', surface: 'starter', tools: tools.length, tools_list_bytes: bytes };
  }
  for (const task of STARTER_TASKS.filter(t => !taskFilter || taskFilter.includes(t.id))) for (const arm of arms) for (const model of models) for (let rep = 0; rep < reps; rep++) {
    const s = servers[arm];
    cells.push({ arm, model, task, rep, client: s.client, specs: s.specs, system: STARTER_SYSTEM, listBytes: s.bytes });
  }
}

// Receipts name machine paths relative to the home directory.
const redact = (text: string) => process.env.HOME ? text.split(process.env.HOME).join('~') : text;
const key = (c: { arm: string; model: string; task_id: string; rep: number }) => [suite, c.arm, c.model, c.task_id, c.rep].join('|');
const done = new Set<string>();
if (existsSync(out)) for (const line of readFileSync(out, 'utf8').split('\n').filter(Boolean)) {
  const r = JSON.parse(line);
  if (r.stop !== 'error') done.add(key(r));
}
const todo = cells.filter(c => !done.has(key({ arm: c.arm, model: c.model, task_id: c.task.id, rep: c.rep })));
console.error('[gbra156] ' + suite + ': ' + cells.length + ' cells, ' + todo.length + ' to run; ' + JSON.stringify(identity));

const opts = budgetOptionsFrom(argv);
const budget = BudgetRun.open({ runner: 'gbra156-scope-tools-list-' + suite, budgetUsd: opts.budgetUsd ?? 40, ledgerPath: opts.ledgerPath, programCapUsd: opts.programCapUsd });
const guard = installPaidRequestGuard(budget);

let next = 0, finished = 0;
async function worker() {
  while (next < todo.length && !guard.exhausted) {
    const c = todo[next++];
    const calls: ToolCall[] = [];
    const arm: Arm = {
      name: c.arm,
      systemHint: () => '',
      tools: () => c.specs,
      writeTools: () => [],
      call: async (name, args) => {
        const t0 = Date.now();
        const r = await c.client.call(name, args);
        calls.push({ name, args, is_error: r.isError, ms: Date.now() - t0, result: r.text });
        return r.text;
      },
    };
    const started = new Date().toISOString();
    const agent = await runAgent({ model: c.model, system: c.system, user: c.task.prompt, arm, maxTurns: MAX_TURNS, maxToolChars: MAX_TOOL_CHARS, submitTool: SUBMIT });
    const answer = String((agent.final as { answer?: string } | null)?.answer ?? agent.text ?? '');
    const grade = suite === 'scope' ? gradeScope(c.task, c.arm, calls, answer) : gradeStarter(c.task, calls, answer);
    const rec = {
      suite, arm: c.arm, model: c.model, task_id: c.task.id, rep: c.rep, started,
      member: c.task.member ?? null, kind: c.task.kind ?? (c.task.hidden_param ? 'hidden_param' : 'reach'),
      system: c.system, prompt: c.task.prompt, tools_list_bytes: c.listBytes, tools_offered: c.specs.length,
      stop: agent.stop, error: agent.error ?? null, turns: agent.turns, usage: agent.usage, usd: agent.usd, ms: agent.ms,
      answer, grade, tool_calls: calls,
    };
    appendFileSync(out, redact(JSON.stringify(rec)) + '\n');
    finished++;
    console.error('[gbra156] ' + finished + '/' + todo.length + ' ' + c.arm + ' ' + c.model + ' ' + c.task.id + ' stop=' + agent.stop + ' $' + agent.usd.toFixed(4) + ' ' + JSON.stringify(grade.summary));
  }
}
try {
  await Promise.all(Array.from({ length: concurrency }, worker));
} finally {
  const summary = receiptCost(budget.summary());
  console.error('[gbra156] budget ' + JSON.stringify(summary));
  appendFileSync(join(dirname(out), 'runs.jsonl'), redact(JSON.stringify({ suite, finished_at: new Date().toISOString(), cells: cells.length, ran: finished, identity, models, arms, max_turns: MAX_TURNS, max_tool_chars: MAX_TOOL_CHARS, budget: summary })) + '\n');
  guard.uninstall();
  budget.close();
  for (const f of cleanup) await f();
  process.exit(0);
}
