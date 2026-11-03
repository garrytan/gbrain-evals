#!/usr/bin/env bun
// Runner for the spring-loaded skills A/B (GBRA-194). Adapted from the GBRA-188
// brain-first runner: drives the real Claude Code CLI or the real Codex CLI, each
// with an isolated HOME per slot, wired to a synthetic two-source PGLite brain by
// the real "gbrain setup <harness>". The brain-first block is on in every gbrain
// arm; arms differ only in how gbrain's bundled skills reach the agent.
//
//   bare    no gbrain at all (standing-token baseline only)
//   off     gbrain setup <harness> (today's default: no skill text reaches the agent)
//   native  off + all bundled skills copied into the harness's native skills dir
//   spring  gbrain setup <harness> --skill-loading spring (index block + load on demand)
//
// SKEVAL_CHECKOUT=<gbrain checkout> bun run.ts --harness claude|codex --models m1,m2 \
//   --arms off,native,spring --reps 2 --slots 4 --out results/<name>.jsonl \
//   [--tasks S01,C01] [--timeout 600] [--probe] [--cap 55]
import { spawn, spawnSync } from 'bun';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync, readdirSync, cpSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve, relative } from 'node:path';
import { homedir } from 'node:os';
import { grade, type Page } from './grade.ts';
import { detectSkillLoads, isMutation } from './detect.ts';
import { scrubMachinePaths } from '../../../eval/runner/receipt.ts';

const HERE = dirname(new URL(import.meta.url).pathname);
const argv = process.argv.slice(2);
const opt = (k: string, d?: string) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
const flag = (k: string) => argv.includes('--' + k);
const harness = opt('harness') as 'claude' | 'codex';
if (harness !== 'claude' && harness !== 'codex') throw new Error('--harness claude|codex');
const models = opt('models')!.split(',');
const probe = flag('probe');
const arms = (opt('arms', probe ? 'bare,off,native,spring' : 'off,native,spring')!).split(',');
const reps = Number(opt('reps', '2'));
const slots = Number(opt('slots', '4'));
const timeoutS = Number(opt('timeout', '600'));
const out = resolve(opt('out')!);
const taskFilter = opt('tasks')?.split(',');
const cap = Number(opt('cap', '55'));
const reserve = Number(opt('reserve', '0.6'));
// real: each harness runs in the permission mode gbrain setup leaves it in (Claude Code's default
// mode, Codex's default sandbox and approval policy); denials are recorded per trial. bypass: the
// GBRA-188 flags (--dangerously-skip-permissions / --dangerously-bypass-approvals-and-sandbox).
// mcp-allow: real, plus the bootstrap lane's Claude Code pre-approval (permissions.allow "mcp__gbrain"
// in ~/.claude/settings.json). A secondary configuration, reported separately.
const perm = opt('perm', 'real') as 'real' | 'mcp-allow' | 'bypass';
if (!['real', 'mcp-allow', 'bypass'].includes(perm)) throw new Error('--perm real|mcp-allow|bypass');
if (perm === 'mcp-allow' && harness !== 'claude') throw new Error('--perm mcp-allow is a Claude Code configuration');
const WORK = process.env.SKEVAL_WORK ?? join(homedir(), '.capy/work/skeval');
const CHECKOUT = resolve(process.env.SKEVAL_CHECKOUT ?? '');
if (!existsSync(join(CHECKOUT, 'src/cli.ts'))) throw new Error('SKEVAL_CHECKOUT must point at a gbrain checkout');
const GBRAIN_SHA = spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: CHECKOUT }).stdout.toString().trim();
const CORPUS = join(WORK, 'corpus');
const LEDGER = join(WORK, 'ledger.jsonl');
const HARNESS_ID = harness === 'claude' ? 'claude-code' : 'codex';
const PROBE_TASK = { id: 'PROBE', kind: 'probe', skill: null, prompt: 'Reply with the single word OK' };
const tasks = probe ? [PROBE_TASK] : (JSON.parse(readFileSync(join(HERE, 'tasks.json'), 'utf8')).tasks as any[]).filter((t) => !taskFilter || taskFilter.includes(t.id));
const BASE = readFileSync(join(HERE, 'base-instructions.md'), 'utf8');
const WRITE_TOOLS = new Set(['put_page', 'edit_page', 'capture', 'remember', 'forget', 'add_timeline_entry', 'synthesize', 'submit_agent', 'delete_page', 'add_link', 'add_tag', 'append_page']);
// USD per million tokens (gbrain-evals eval/runner/budget-ledger.ts, 2026-10-24).
const OPENAI_PRICE: Record<string, { input: number; output: number; cache_read: number; cache_write: number }> = {
  'gpt-6.1-sol': { input: 2, output: 10, cache_read: 0.1, cache_write: 2.5 },
};

// The gbrain binary: a launcher that runs the checkout's CLI. gbrain itself runs keyless
// (the documented default install), so every paid call in a trial is the harness's own.
const BIN = join(WORK, 'bin'); const GBRAIN = join(BIN, 'gbrain');
mkdirSync(BIN, { recursive: true });
writeFileSync(GBRAIN, '#!/usr/bin/env bash\nunset ANTHROPIC_API_KEY OPENAI_API_KEY\nexec bun ' + join(CHECKOUT, 'src/cli.ts') + ' "$@"\n'); chmodSync(GBRAIN, 0o755);

if (!existsSync(join(CORPUS, 'workspace'))) {
  const r = spawnSync(['bun', join(HERE, 'gen-fixtures.ts'), CORPUS]);
  if (r.exitCode !== 0) throw new Error('gen-fixtures failed: ' + r.stderr.toString());
}
// Native arm: every bundled skill plus the shared files they reference, at their relative paths.
const NATIVE = join(WORK, 'native-skills', GBRAIN_SHA);
if (!existsSync(NATIVE)) {
  const r = spawnSync(['bun', join(HERE, 'export-bundled.ts'), GBRAIN, NATIVE]);
  if (r.exitCode !== 0) throw new Error('export-bundled failed: ' + r.stderr.toString());
}
const ORIGINAL_EVENT_IDS = (JSON.parse(readFileSync(join(CORPUS, 'workspace/calendar.json'), 'utf8')).events as any[]).map((e) => e.id);

const done = new Set<string>();
if (existsSync(out)) for (const l of readFileSync(out, 'utf8').split('\n')) if (l.trim()) done.add(JSON.parse(l).trial_id);
mkdirSync(dirname(out), { recursive: true });
const rawDir = join(WORK, 'raw'); mkdirSync(rawDir, { recursive: true });

type Trial = { trial_id: string; model: string; arm: string; task: any; rep: number };
const trials: Trial[] = [];
for (let rep = 1; rep <= reps; rep++) for (const task of tasks) for (const model of models) for (const arm of arms) {
  const trial_id = [harness, model, perm === 'real' ? arm : arm + '+' + perm, task.id, rep].join('|');
  if (!done.has(trial_id)) trials.push({ trial_id, model, arm, task, rep });
}
let s = 194; const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
for (let i = trials.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [trials[i], trials[j]] = [trials[j]!, trials[i]!]; }
console.error('trials to run: ' + trials.length + ' (already done ' + done.size + ') gbrain ' + GBRAIN_SHA.slice(0, 8));

function env(home: string): Record<string, string> {
  const e: Record<string, string> = {
    HOME: home, PATH: [BIN, join(homedir(), '.bun/bin'), dirname(process.execPath), dirname(spawnSync(['which', 'node']).stdout.toString().trim()), '/usr/local/bin', '/usr/bin', '/bin'].join(':'),
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
    // A local stdio connection writes to one source (the resolved default); Pat's agent writes to the team brain.
    [GBRAIN, 'config', 'set', 'sources.default', 'team'],
    // Every trial is a first session; the first-run ask would repeat in each one. Muted in every arm.
    [GBRAIN, 'notices', 'mute', 'first_run_decisions'],
  ];
  for (const st of steps) { const r = sh(st, home); if (r.code !== 0) throw new Error(st.join(' ') + ' failed: ' + (r.out + r.err).slice(-800)); }
  const list = sh([GBRAIN, 'sources', 'list', '--json'], home).out;
  if (!/"team"/.test(list) || !/"personal"/.test(list)) throw new Error('sources missing after build');
  if (harness === 'codex') {
    const r = sh(['codex', 'login', '--with-api-key'], home, home, process.env.OPENAI_API_KEY + '\n');
    if (r.code !== 0) throw new Error('codex login failed');
  }
}

function prepareHarness(slotDir: string, arm: string) {
  const home = join(slotDir, 'home');
  for (const f of readdirSync(home)) if (f === '.claude' || f === '.agents' || f === '.claude.json' || f.startsWith('.claude.json') || f.startsWith('.gbrain-connection-')) rmSync(join(home, f), { recursive: true, force: true });
  for (const f of ['agent-instructions.json', 'skill-loading.json']) rmSync(join(home, '.gbrain', f), { force: true });
  const codexDir = join(home, '.codex');
  if (existsSync(codexDir)) for (const f of readdirSync(codexDir)) if (f !== 'auth.json') rmSync(join(codexDir, f), { recursive: true, force: true });
  const instrFile = harness === 'claude' ? join(home, '.claude/CLAUDE.md') : join(home, '.codex/AGENTS.md');
  mkdirSync(dirname(instrFile), { recursive: true });
  writeFileSync(instrFile, BASE);
  if (arm !== 'bare') {
    const args = [GBRAIN, 'setup', HARNESS_ID, '--surface', 'starter', '--no-hooks', '--json', ...(arm === 'spring' ? ['--skill-loading', 'spring', '--gbrain-bin', GBRAIN] : [])];
    const r = sh(args, home);
    if (r.code !== 0) throw new Error('setup failed: ' + (r.out + r.err).slice(-1500));
  }
  const settingsPath = join(home, '.claude/settings.json');
  if (perm === 'mcp-allow') {
    const st = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
    st.permissions ??= {}; st.permissions.allow = [...new Set([...(st.permissions.allow ?? []), 'mcp__gbrain'])];
    mkdirSync(dirname(settingsPath), { recursive: true }); writeFileSync(settingsPath, JSON.stringify(st, null, 2) + '\n');
  }
  const allowRules = harness === 'claude' && existsSync(settingsPath) ? (JSON.parse(readFileSync(settingsPath, 'utf8')).permissions?.allow ?? []) : [];
  let skillsDir: string | null = null;
  if (arm === 'native') {
    skillsDir = harness === 'claude' ? join(home, '.claude/skills') : join(home, '.agents/skills');
    cpSync(NATIVE, skillsDir, { recursive: true });
  }
  const text = readFileSync(instrFile, 'utf8');
  const hasBF = text.includes('gbrain:brain-first:begin'); const hasIdx = text.includes('gbrain:skills:begin');
  if (arm !== 'bare' && !hasBF) throw new Error(arm + ' arm missing brain-first block');
  if (arm === 'bare' && hasBF) throw new Error('bare arm has brain-first block');
  if (arm === 'spring' && !hasIdx) throw new Error('spring arm missing skills index');
  if (arm !== 'spring' && hasIdx) throw new Error(arm + ' arm has skills index');
  rmSync(join(slotDir, 'ws'), { recursive: true, force: true });
  cpSync(join(CORPUS, 'workspace'), join(slotDir, 'ws'), { recursive: true });
  return { allow_rules: allowRules, instr_sha256: createHash('sha256').update(text).digest('hex'), instr_bytes: Buffer.byteLength(text), index_bytes: hasIdx ? Buffer.byteLength(text.slice(text.indexOf('gbrain:skills:begin'), text.indexOf('gbrain:skills:end'))) : 0, instr_text: text };
}

async function snapshotBrain(home: string): Promise<Record<string, Page>> {
  const r = spawnSync(['bun', join(HERE, 'dbdump.ts'), CHECKOUT, join(home, '.gbrain/brain.pglite')], { env: env(home) });
  if (r.exitCode !== 0) throw new Error('dbdump failed: ' + r.stderr.toString().slice(-500));
  const m: Record<string, Page> = {};
  for (const p of JSON.parse(r.stdout.toString()) as Page[]) m[p.source_id + ':' + p.slug] = p;
  return m;
}
function hashTree(root: string, skip: (rel: string) => boolean = () => false): Record<string, string> {
  const m: Record<string, string> = {};
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); const rel = relative(root, p); if (skip(rel)) continue; if (e.isDirectory()) walk(p); else if (e.isFile()) m[rel] = createHash('sha256').update(readFileSync(p)).digest('hex'); } };
  if (existsSync(root)) walk(root);
  return m;
}
const srcSkip = (rel: string) => rel === '.git' || rel.startsWith('.git/');

const trunc = (x: unknown, n: number) => { const t = typeof x === 'string' ? x : JSON.stringify(x); return t && t.length > n ? t.slice(0, n) + '…' : t; };

function parseClaude(lines: any[], model: string) {
  const calls: any[] = []; const byId = new Map<string, any>(); let answer = ''; let cost = 0; let usage: any = {}; let turns = 0; let isError = false; let perModel: any = {}; let denials: any[] = [];
  for (const ev of lines) {
    if (ev.type === 'assistant') for (const c of ev.message?.content ?? []) if (c.type === 'tool_use') {
      const m = /^mcp__gbrain__(.+)$/.exec(c.name);
      const call = { tool: m ? 'gbrain:' + m[1] : c.name, input: c.input ?? {}, args: trunc(c.input, 400), error: false, result: '' };
      calls.push(call); byId.set(c.id, call);
    }
    if (ev.type === 'user') for (const c of ev.message?.content ?? []) if (c.type === 'tool_result' && byId.has(c.tool_use_id)) {
      const call = byId.get(c.tool_use_id); call.error = !!c.is_error;
      call.result = trunc(Array.isArray(c.content) ? c.content.map((x: any) => x.text ?? '').join('\n') : c.content, 300);
    }
    if (ev.type === 'result') {
      answer = ev.result ?? ''; cost = ev.total_cost_usd ?? 0; turns = ev.num_turns ?? 0; isError = !!ev.is_error;
      denials = (ev.permission_denials ?? []).map((d: any) => ({ tool: /^mcp__gbrain__/.test(d.tool_name) ? 'gbrain:' + d.tool_name.slice(13) : d.tool_name, args: trunc(d.tool_input, 300) }));
      const mu = ev.modelUsage ?? {}; usage = { input: 0, cache_read: 0, cache_write: 0, output: 0 };
      for (const [k, v] of Object.entries<any>(mu)) {
        usage.input += v.inputTokens ?? 0; usage.cache_read += v.cacheReadInputTokens ?? 0; usage.cache_write += v.cacheCreationInputTokens ?? 0; usage.output += v.outputTokens ?? 0;
        perModel[k] = { input: v.inputTokens ?? 0, cache_read: v.cacheReadInputTokens ?? 0, cache_write: v.cacheCreationInputTokens ?? 0, output: v.outputTokens ?? 0, cost_usd: v.costUSD ?? null };
      }
    }
  }
  usage.input_total = usage.input + usage.cache_read + usage.cache_write;
  const main = Object.entries<any>(perModel).find(([k]) => k.startsWith(model))?.[1];
  usage.main_input_total = main ? main.input + main.cache_read + main.cache_write : null;
  usage.per_model = perModel;
  // A denied call comes back to the model as an errored tool result; it never ran.
  for (const c of calls) if (c.error && /permission|requested permissions|haven't granted|not allowed|denied/i.test(c.result ?? '')) c.denied = true;
  return { calls, answer, cost, usage, turns, isError, denials };
}

function parseCodex(lines: any[], model: string) {
  const calls: any[] = []; let answer = ''; const usage: any = { input: 0, cache_read: 0, cache_write: 0, output: 0, reasoning: 0 }; let turns = 0; let isError = false;
  for (const ev of lines) {
    if (ev.type === 'item.completed') {
      const it = ev.item ?? {};
      if (it.type === 'mcp_tool_call') calls.push({ tool: (/^(list_mcp_resources|list_mcp_resource_templates|read_mcp_resource)$/.test(it.tool) ? 'codex-resource:' : it.server === 'gbrain' ? 'gbrain:' : it.server + ':') + it.tool, input: it.arguments ?? {}, args: trunc(it.arguments, 400), error: !!it.error || it.status === 'failed', result: trunc(it.error ?? it.result, 300) });
      else if (it.type === 'command_execution') calls.push({ tool: 'shell', input: { command: it.command }, args: trunc(it.command, 400), error: it.exit_code !== 0, result: trunc(it.aggregated_output, 300) });
      else if (it.type === 'file_change') calls.push({ tool: 'file_change', input: { changes: it.changes }, args: trunc(it.changes, 400), error: it.status === 'failed', result: '' });
      else if (it.type === 'web_search') calls.push({ tool: 'web_search', input: { query: it.query }, args: trunc(it.query, 200), error: false, result: '' });
      else if (it.type === 'agent_message') answer = it.text ?? answer;
      else if (it.type === 'error') isError = true;
      else if (it.type !== 'reasoning' && it.type !== 'todo_list') calls.push({ tool: 'codex-item:' + it.type, input: it, args: trunc(it, 400), error: it.status === 'failed', result: '' });
    }
    if (ev.type === 'turn.completed') { turns++; const u = ev.usage ?? {}; usage.input += u.input_tokens ?? 0; usage.cache_read += u.cached_input_tokens ?? 0; usage.cache_write += u.cache_write_input_tokens ?? 0; usage.output += u.output_tokens ?? 0; usage.reasoning += u.reasoning_output_tokens ?? 0; }
    if (ev.type === 'turn.failed' || ev.type === 'error') isError = true;
  }
  const p = OPENAI_PRICE[model];
  // input_tokens includes cached and cache-write tokens; output_tokens includes reasoning.
  const cost = p ? ((usage.input - usage.cache_read - usage.cache_write) * p.input + usage.cache_read * p.cache_read + usage.cache_write * p.cache_write + usage.output * p.output) / 1e6 : 0;
  usage.input_total = usage.input; usage.main_input_total = usage.input;
  // Codex exec never prompts: a sandbox or approval refusal comes back as a failed call.
  const DENY = /sandbox|read-only file system|operation not permitted|permission denied|approval|rejected by|declined|not permitted/i;
  for (const c of calls) if (c.error && DENY.test(String(c.result ?? ''))) c.denied = true;
  const denials = calls.filter((c) => c.denied).map((c) => ({ tool: c.tool, args: trunc(c.args, 300) }));
  return { calls, answer, cost, usage, turns, isError, denials };
}

async function runTrial(slotDir: string, t: Trial) {
  const prep = prepareHarness(slotDir, t.arm);
  const home = join(slotDir, 'home'); const ws = join(slotDir, 'ws');
  const before = await snapshotBrain(home);
  const srcBefore = hashTree(join(home, 'brain-src'), srcSkip);
  const wsBefore = hashTree(ws);
  const cmd = harness === 'claude'
    ? ['claude', '-p', t.task.prompt, '--output-format', 'stream-json', '--verbose', '--model', t.model, ...(perm === 'bypass' ? ['--dangerously-skip-permissions'] : [])]
    : ['codex', 'exec', '--json', '-m', t.model, ...(perm === 'bypass' ? ['--dangerously-bypass-approvals-and-sandbox'] : []), '--skip-git-repo-check', '-C', ws, t.task.prompt];
  const started = Date.now();
  const proc = spawn(['setsid', ...cmd], { cwd: ws, env: env(home), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { process.kill(-proc.pid, 'SIGKILL'); } catch {} }, timeoutS * 1000);
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exitCode = await proc.exited; clearTimeout(timer);
  try { process.kill(-proc.pid, 'SIGKILL'); } catch {}
  await Bun.sleep(500);
  const rawPath = join(rawDir, t.trial_id.replace(/\|/g, '__') + '.jsonl');
  writeFileSync(rawPath, stdout + (stderr ? '\n#STDERR\n' + stderr.slice(-4000) : ''));
  const lines = stdout.split('\n').filter((l) => l.trim().startsWith('{')).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const p = harness === 'claude' ? parseClaude(lines, t.model) : parseCodex(lines, t.model);
  const after = await snapshotBrain(home);
  const srcAfter = hashTree(join(home, 'brain-src'), srcSkip);
  const wsAfter = hashTree(ws);
  const cal = JSON.parse(readFileSync(join(ws, 'calendar.json'), 'utf8')).events as any[];
  const newEvents = cal.filter((e) => !ORIGINAL_EVENT_IDS.includes(e.id) || e.created_by_agent);
  const loads = detectSkillLoads(p.calls);
  const firstMutation = p.calls.findIndex((c) => isMutation(c, WRITE_TOOLS));
  const expected: string[] = t.task.skill ? [t.task.skill, ...(t.task.accept ?? [])] : [];
  const expLoad = loads.find((l) => expected.includes(l.skill));
  const g = t.task.kind === 'probe' ? { pass: /\bOK\b/.test(p.answer), checks: {} } : grade(t.task, { answer: p.answer, before, after, wsBefore, wsAfter, newEvents });
  const changedPages = Object.keys(after).filter((k) => !before[k] || before[k]!.body !== after[k]!.body || before[k]!.deleted !== after[k]!.deleted);
  const srcChanged = Object.keys({ ...srcBefore, ...srcAfter }).filter((k) => srcBefore[k] !== srcAfter[k]);
  const skillsLoaded = [...new Set(loads.map((l) => l.skill))];
  return {
    row: {
      trial_id: t.trial_id, harness: HARNESS_ID, model: t.model, arm: t.arm, task: t.task.id, kind: t.task.kind, rep: t.rep, expected_skill: t.task.skill ?? null,
      skills_loaded: skillsLoaded, skill_loads: loads.map((l) => ({ skill: l.skill, via: l.via, at: l.index })),
      right_skill_used: !!expLoad && (firstMutation < 0 || expLoad.index < firstMutation),
      expected_loaded_anytime: !!expLoad,
      wrong_skill_only: t.task.kind === 'skill' && skillsLoaded.length > 0 && !expLoad,
      over_fetch: t.task.kind === 'control' ? skillsLoaded.length > 0 : null,
      first_mutation_at: firstMutation,
      perm_mode: perm, allow_rules: prep.allow_rules, permission_denials: p.denials.length, denials: p.denials, denied_skill_loads: p.calls.filter((c: any) => c.denied && /bundled-skill|SKILL\.md/.test(String(c.args)) || (c.denied && c.tool === 'Skill')).length,
      pass: g.pass, checks: g.checks,
      brain_pages_changed: changedPages.map((k) => k), brain_src_files_changed: srcChanged, workspace_files_changed: Object.keys({ ...wsBefore, ...wsAfter }).filter((k) => wsBefore[k] !== wsAfter[k]),
      answer: p.answer, new_events: newEvents, calls: p.calls.map(({ input, ...c }) => c), tool_calls: p.calls.length,
      turns: p.turns, usage: p.usage, cost_usd: p.cost, exit_code: exitCode, timed_out: timedOut, harness_error: p.isError || (!p.answer && !timedOut),
      duration_s: Math.round((Date.now() - started) / 1000), instr_sha256: prep.instr_sha256, instr_bytes: prep.instr_bytes, index_bytes: prep.index_bytes,
      gbrain_sha: GBRAIN_SHA, ts: new Date().toISOString(),
    },
    dirty: changedPages.length > 0 || srcChanged.length > 0 || p.calls.some((c) => c.tool.startsWith('gbrain:') && WRITE_TOOLS.has(c.tool.slice(7))) || timedOut,
  };
}

const ledgerTotal = () => existsSync(LEDGER) ? readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).reduce((a, l) => a + (JSON.parse(l).cost_usd ?? 0), 0) : 0;
let next = 0; let finished = 0; let spend = 0; let inflight = 0;
async function worker(i: number) {
  const slotDir = join(WORK, 'slots', harness + '-' + i);
  let dirty = true;
  while (next < trials.length) {
    if (ledgerTotal() + (inflight + 1) * reserve > cap) { console.error('budget cap: ledger $' + ledgerTotal().toFixed(2) + ' + reserve would pass $' + cap); return; }
    const t = trials[next++]!; inflight++;
    try {
      if (dirty) { buildBrain(slotDir); dirty = false; }
      const { row, dirty: d } = await runTrial(slotDir, t);
      dirty = d;
      spend += row.cost_usd; finished++;
      appendFileSync(LEDGER, JSON.stringify({ ts: row.ts, trial_id: t.trial_id, out: relative(HERE, out), cost_usd: row.cost_usd }) + '\n');
      appendFileSync(out, JSON.stringify(scrubMachinePaths(row, undefined, undefined, undefined, [[CHECKOUT, '<gbrain>'], [join(WORK, 'slots'), '<slots>'], [WORK, '<work>']])) + '\n');
      console.error('[' + finished + '/' + trials.length + '] ' + t.trial_id + ' skills=' + row.skills_loaded.join(',') + ' right=' + row.right_skill_used + ' pass=' + row.pass + ' denied=' + row.permission_denials + ' in=' + row.usage.input_total + ' $' + row.cost_usd.toFixed(4) + ' run $' + spend.toFixed(2) + ' ledger $' + ledgerTotal().toFixed(2));
    } catch (e) {
      dirty = true;
      console.error('trial ' + t.trial_id + ' infra error: ' + String(e).slice(0, 800));
    } finally { inflight--; }
  }
}
await Promise.all(Array.from({ length: slots }, (_, i) => worker(i)));
console.error('done; spend this run $' + spend.toFixed(2) + '; ledger total $' + ledgerTotal().toFixed(2));
