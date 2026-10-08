/**
 * T0 native-harness parity slice: the same tasks as the injected-context
 * carrier, run through a real Claude Code process (the version Cat 41 pins)
 * with gbrain's SessionStart and UserPromptSubmit hooks registered in its
 * settings and gbrain's stdio MCP server in its MCP config, the way
 * `gbrain bootstrap` wires a Claude Code install.
 *
 * Per task: the persona's brain is restored from its snapshot; session 1 is
 * `claude -p <session-1 message>`, session 2 a second `claude -p` (a new
 * session and a new MCP server process on the same brain). The deliverable is
 * Claude Code's final result text, scored by t0/score.ts. The persona line of
 * the carrier's system prompt (who the user is, today's date) is passed with
 * --append-system-prompt, as a user's CLAUDE.md would; the carrier's MCP
 * instructions are not, because Claude Code reads them from the server.
 *
 * Claude Code's and gbrain's provider requests both go through the metering
 * proxy, so the budget ledger reserves and settles every one (streamed
 * responses settle from their usage events). The usage receipt is one
 * `usage-receipt/v1` record per session from Claude Code's result usage
 * (per-request usage stays inside Claude Code).
 *
 *   bun eval/runner/t0/parity.ts --gbrain <checkout>@<ref> --output <dir> --tasks <id,...> [--model claude-sonnet-5-5]
 *     --paid --budget-run-id <id>
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { generateWorld, humanDate, PP_DEV_SEEDS, PP_SESSION2_DAY, PP_TODAY, renderPPDoc, type PPPersona, type PPTask } from '../../generators/program-primary-gen.ts';
import { GbrainSlot, MeteringProxy } from '../cat40/gbrain-arm.ts';
import { prepareBuild } from '../lifecycle/builds.ts';
import { requirePaidArm } from '../paid-arm.ts';
import { budgetOptionsFrom, receiptCost, startPaidRun } from '../budget-ledger.ts';
import { normalizeUsage, receipt } from '../usage-receipt.ts';
import { DELIVERY_CONTRACT } from './delivery.ts';
import { scoreAnswer } from './score.ts';

export const PARITY_VERSION = 't0-parity-v1';
export const CLAUDE_CODE_VERSION = '2.1.285';

function flag(argv: string[], name: string) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; }

export function personaLine(p: PPPersona, day: string): string {
  return `You are ${p.principal.first}'s AI assistant. ${p.principal.name} is the ${p.principal.role} of ${p.principal.company}, which builds a ${p.principal.product}. Today is ${humanDate(day)}, ${day.slice(0, 4)} (${day}). ${p.principal.first}'s personal brain (gbrain) is their long-term memory across sessions; you reach it through the gbrain MCP tools.`;
}

/** Claude Code settings that register gbrain's two context hooks with the release's default timeouts. */
export function hookSettings(buildDir: string) {
  const cmd = (event: string) => `bun ${join(buildDir, 'src/cli.ts')} hook ${event}`;
  return {
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: cmd('session-start'), timeout: DELIVERY_CONTRACT.timing.harness_timeout_ms.session_start / 1000 }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: cmd('user-prompt'), timeout: DELIVERY_CONTRACT.timing.harness_timeout_ms.user_prompt_submit / 1000 }] }],
    },
  };
}

interface ClaudeResult { text: string; is_error: boolean; num_turns: number | null; total_cost_usd: number | null; usage: Record<string, unknown> | null; session_id: string | null; ms: number; exit: number | null; tools: string[]; stderr_tail: string }

function runClaude(prompt: string, opts: { env: Record<string, string>; cwd: string; model: string; mcpConfig: string; system: string; timeoutMs: number }): Promise<ClaudeResult> {
  const argv = ['-p', prompt, '--model', opts.model, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--mcp-config', opts.mcpConfig, '--strict-mcp-config', '--append-system-prompt', opts.system];
  const t0 = Date.now();
  return new Promise(res => {
    const p = spawn('claude', argv, { env: opts.env, cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8');
    p.stdout.on('data', (c: string) => { out += c; });
    p.stderr.on('data', (c: string) => { err += c; });
    const timer = setTimeout(() => p.kill('SIGKILL'), opts.timeoutMs);
    p.on('close', code => {
      clearTimeout(timer);
      const events = out.split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l) as Record<string, unknown>]; } catch { return []; } });
      const result = events.findLast(e => e.type === 'result') ?? {};
      const tools = events.filter(e => e.type === 'assistant').flatMap(e => (((e.message as Record<string, unknown>)?.content ?? []) as Array<Record<string, unknown>>).filter(c => c.type === 'tool_use').map(c => String(c.name)));
      res({
        text: String(result.result ?? ''), is_error: Boolean(result.is_error ?? code !== 0), num_turns: (result.num_turns as number | undefined) ?? null,
        total_cost_usd: (result.total_cost_usd as number | undefined) ?? null, usage: (result.usage as Record<string, unknown> | undefined) ?? null,
        session_id: (result.session_id as string | undefined) ?? null, ms: Date.now() - t0, exit: code, tools, stderr_tail: err.slice(-400),
      });
    });
  });
}

/** Whether Claude Code recorded gbrain's hook context in the session transcript (the delivered-push check). */
function pushRecorded(home: string, sessionId: string | null): boolean {
  if (!sessionId) return false;
  const root = join(home, '.claude', 'projects');
  if (!existsSync(root)) return false;
  for (const dir of readdirSync(root)) {
    const f = join(root, dir, `${sessionId}.jsonl`);
    if (existsSync(f)) return readFileSync(f, 'utf8').includes('retrieved brain context');
  }
  return false;
}

export async function main(argv: string[]) {
  const spec = flag(argv, '--gbrain');
  if (!spec?.includes('@')) throw new Error('--gbrain <checkout>@<ref> is required');
  const [checkout, ref] = [spec.slice(0, spec.lastIndexOf('@')), spec.slice(spec.lastIndexOf('@') + 1)];
  const out = resolve(flag(argv, '--output') ?? 'eval/reports/t0-program-primary/parity');
  const model = flag(argv, '--model') ?? 'claude-sonnet-5-5';
  const taskIds = (flag(argv, '--tasks') ?? '').split(',').filter(Boolean);
  const world = generateWorld(PP_DEV_SEEDS);
  const tasks = world.personas.flatMap(p => p.tasks.filter(t => taskIds.includes(t.id)).map(t => ({ p, t })));
  if (!tasks.length) throw new Error('--tasks names no development task');
  const budgetRunId = requirePaidArm(argv, { arm: 't0-parity', estimateUsd: tasks.length * 0.6 }).budgetRunId;
  const budget = startPaidRun('t0-parity', { ...budgetOptionsFrom(argv), estimateUsd: tasks.length * 0.6 });
  mkdirSync(out, { recursive: true });
  const proxy = new MeteringProxy();
  proxy.start();
  const root = join(out, 'work');
  const resultsPath = join(out, 'results.jsonl');
  const done = new Set(existsSync(resultsPath) ? readFileSync(resultsPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).task as string) : []);
  try {
    const build = prepareBuild(resolve(checkout), { label: `t0-${ref}`, ref, description: 'gbrain under test (parity slice)' }, join(root, 'builds'));
    for (const { p, t } of tasks) {
      if (done.has(t.id)) continue;
      const slot = new GbrainSlot(p.id, join(root, 'slots'), build.dir, proxy.port, 'starter');
      if (!slot.hasSnapshot()) { proxy.bind(p.id, `build:${p.id}`); await slot.build({ docs: p.docs }, proxy, false, { render: renderPPDoc }); await proxy.finalize(`build:${p.id}`); }
      await slot.restore();
      await slot.stop();
      const env = Object.fromEntries(Object.entries({ ...slot.run.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', ANTHROPIC_SMALL_FAST_MODEL: model, CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8192' }).filter(([, v]) => v !== undefined)) as Record<string, string>;
      mkdirSync(join(env.HOME, '.claude'), { recursive: true });
      writeFileSync(join(env.HOME, '.claude', 'settings.json'), JSON.stringify(hookSettings(build.dir), null, 2));
      const mcpConfig = join(slot.dir, 'mcp.json');
      writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { gbrain: { command: 'bun', args: [join(build.dir, 'src/cli.ts'), 'serve', '--surface', 'starter'], env } } }, null, 2));
      const key = `${t.id}|claude-code:${model}|native|1`;
      proxy.bind(p.id, key);
      const sessions: Array<ClaudeResult & { session: number; push_recorded: boolean }> = [];
      for (const [n, prompt, day] of [[1, t.session1, PP_TODAY], [2, t.session2, PP_SESSION2_DAY]] as const) {
        const ws = join(root, 'ws', `${p.id}-${t.id}-s${n}`);
        mkdirSync(ws, { recursive: true });
        const r = await runClaude(prompt, { env, cwd: ws, model, mcpConfig, system: personaLine(p, day), timeoutMs: 600_000 });
        sessions.push({ ...r, session: n, push_recorded: pushRecorded(env.HOME, r.session_id) });
        appendFileSync(join(out, 'usage.jsonl'), JSON.stringify({ cell: key, ...receipt({
          lane: 't0-parity', role: 'reader', question_id: `${t.id}:native:s${n}`, replicate: 1, attempt: 0, model: `anthropic:${model}`, response_model: null,
          status: r.is_error ? 'error' : 'ok', error: r.is_error ? r.stderr_tail || 'claude reported an error' : null, from_cache: false, finish: null, finish_raw: null,
          answer: r.text, usage: normalizeUsage('anthropic', r.usage), usage_raw: r.usage, delivered: null,
        }) }) + '\n');
      }
      proxy.unbind(p.id);
      const meter = await proxy.finalize(key);
      const s2 = sessions[1];
      const score = scoreAnswer(t, s2.text, { executionError: s2.is_error ? s2.stderr_tail || 'claude error' : null });
      appendFileSync(resultsPath, JSON.stringify({ version: PARITY_VERSION, claude_code: CLAUDE_CODE_VERSION, key, persona: p.id, task: t.id, kind: t.kind, correction_kind: t.correction_kind, model, sessions, score, score_v1: scoreAnswer(t, s2.text, { version: 't0-score-v1' }), usd_metered: meter.usd, meter, gbrain: { commit: build.commit, version: build.version } }) + '\n');
      console.error(`[t0-parity] ${key}: ${score.failed ? `FAIL ${score.kinds.join('+')}` : score.complete ? 'ok (complete)' : 'ok'} push ${sessions.map(s => s.push_recorded).join('/')} $${meter.usd.toFixed(3)}`);
    }
  } finally {
    proxy.stop();
    const summary = budget.run.close();
    writeFileSync(join(out, `cost-${summary.run_id}-${Date.now()}.json`), JSON.stringify(receiptCost(summary), null, 2));
  }
}

if (import.meta.main) main(process.argv.slice(2)).catch(e => { console.error(e instanceof Error ? e.stack ?? e.message : e); process.exit(1); });
