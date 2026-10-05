/**
 * P4 streaming compaction harness: LongMemEval as a live conversation with a
 * small context window, run through gbrain's real Claude Code lanes.
 *
 *   bun eval/runner/p4-stream/run.ts --arms Aprime,B,C --models claude-sonnet-5-5
 *     --build A=<gbrain>@<sha> --build Aprime=<gbrain>@<sha> --build cand=<gbrain>@<sha>
 *     [--benchmark lme-s] [--limit N] [--offset K] [--seed 42] [--window 32000]
 *     [--tag <label for arm ids, e.g. a dev variant>] [--concurrency 4] [--reply-tokens 700] [--judge-runs 10] [--judge-model openai:gpt-4o-2024-08-06]
 *     [--profile-model openai:gpt-4.1-mini] [--effort low] [--work <dir outside any git repo>]
 *     --paid --budget-usd <cap> --output <dir>
 *
 * One cell = one question x one arm x one model, each with a fresh PGLite brain
 * built by that arm's gbrain, served over stdio (`gbrain serve --surface
 * starter`) the way a harness connects. The agent sees the starter tools and
 * the first 2,048 characters of the server instructions (Claude Code's
 * per-server cap).
 *
 * The question's haystack sessions stream in date order. Each session's turns
 * up to its last user message are replayed as history; the last user message
 * is a live turn: gbrain's UserPromptSubmit hook runs first (its
 * additionalContext is injected as a system reminder, which is where the
 * context-pressure notice arrives), then the model answers and may call tools.
 * When the next session would overflow the window, PreCompact runs, the model
 * summarizes the conversation, a compact boundary is written, the history is
 * replaced by the summary, and SessionStart (source=compact) re-injects
 * gbrain's session context (core memory first). At the end the question is a
 * final live turn; its answer is judged with the LongMemEval judge.
 *
 * Every arm gets the same question-blind profile page, written from the first
 * session only. Arms C and D mark it as core.
 */
import '../budget-ledger.ts';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { budgetOptionsFrom, startPaidRun, CHAT_PRICE_OVERRIDES } from '../budget-ledger.ts';
import { resolveGbrainUnderTest } from '../gbrain-under-test.ts';
import { McpClient, MeteringProxy, directGitPath, GBRAIN_EMBED_MODEL } from '../cat40/gbrain-arm.ts';
import { provider } from '../cat40/loop.ts';
import { runCli, type RunEnv } from '../lifecycle/drivers.ts';
import { loadCorpus, type MemoryQuestion, type Session } from '../memory-qa/corpus.ts';
import { ChatClient, judgeResponse } from '../memory-qa/qa.ts';
import { ClaudeTranscript } from './transcript.ts';
import { additionalContext, runHook, type HookEnv } from './hooks.ts';
import { callModel, textOf, type Block, type CallUsage, type Msg, type ToolDef } from './model.ts';

export const INSTRUCTIONS_CAP = 2048;
export const ARM_IDS = ['A', 'Aprime', 'B', 'C', 'D'] as const;
export type ArmId = typeof ARM_IDS[number];

export interface ArmSpec { id: ArmId; build: 'A' | 'Aprime' | 'cand'; config: (w: number) => Record<string, string>; core: boolean }

/** Preregistered arms (docs/eval/CORE_MEMORY_PREREGISTRATION.md in gbrain). */
export const ARMS: Record<ArmId, ArmSpec> = {
  A: { id: 'A', build: 'A', config: () => ({}), core: false },
  Aprime: { id: 'Aprime', build: 'Aprime', config: () => ({}), core: false },
  B: { id: 'B', build: 'cand', core: false, config: w => ({ 'memory.core.enabled': 'false', 'memory.pressure.enabled': 'true', 'memory.pressure.context_window': String(w) }) },
  C: { id: 'C', build: 'cand', core: true, config: () => ({ 'memory.core.enabled': 'true', 'memory.pressure.enabled': 'false' }) },
  D: { id: 'D', build: 'cand', core: true, config: w => ({ 'memory.core.enabled': 'true', 'memory.pressure.enabled': 'true', 'memory.pressure.context_window': String(w), 'memory.core.remote_edit': 'notify' }) },
};

export const SYSTEM_FRAME = `You are a helpful assistant in one long-running conversation with a user. The conversation spans many days. When it grows too long it is compacted: older turns are replaced by a summary. Reply to the user naturally and concisely. You are connected to the user's gbrain memory through the tools listed; use them as you judge useful.`;

export const COMPACT_PROMPT = `Your task is to create a detailed summary of the conversation so far, so it can continue in a new context window. Capture what the user said about themselves, their plans, preferences, decisions, dates and requests, and what you told them. Write the summary only; no tool calls.`;

export const FINAL_INSTRUCTION = `Answer the user's question above as directly as you can. If you are not sure, say what you know and that you are not sure.`;

const PROFILE_PROMPT = `Below is the first conversation between an assistant and a user. Write a short profile of the user as a Markdown bullet list (at most 6 bullets, under 600 characters): who they are, what they do, stable preferences, ongoing projects. Use only what this conversation states. If it states nothing about the user, write "- No details yet."\n\nConversation:\n{conversation}`;

function flag(argv: string[], name: string): string | undefined { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; }
function flags(argv: string[], name: string): string[] { const out: string[] = []; argv.forEach((a, i) => { if (a === name && argv[i + 1]) out.push(argv[i + 1]); }); return out; }

/** LME dates look like "2023/05/20 (Sat) 02:21". */
export function sessionTime(date: string | undefined): number {
  const m = /(\d{4})\/(\d{2})\/(\d{2})[^\d]*(\d{2}):(\d{2})/.exec(date ?? '');
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : 0;
}
export const approxTokens = (s: string) => Math.ceil(s.length / 3.6);

export function priceUsage(model: string, u: CallUsage): number {
  const p = CHAT_PRICE_OVERRIDES[`${provider(model)}:${model}`];
  if (!p) throw new Error(`no verified price for ${model}; add it to CHAT_PRICE_OVERRIDES`);
  return (u.input * p.input + u.cache_read * (p.cache_read ?? p.input) + u.cache_write * (p.cache_write ?? p.input) + u.output * p.output) / 1e6;
}

/** Question order fixed by seed alone (sha256 of seed + id), so a limit is a reproducible slice. */
export function orderQuestions(qs: MemoryQuestion[], seed: number): MemoryQuestion[] {
  const key = (q: MemoryQuestion) => createHash('sha256').update(`${seed}:${q.id}`).digest('hex');
  return [...qs].sort((a, b) => key(a).localeCompare(key(b)));
}

/** A live turn's user text plus any hook context, Claude Code style. */
const withReminder = (text: string, reminder: string) => reminder.trim() ? `${text}\n\n<system-reminder>\n${reminder.trim()}\n</system-reminder>` : text;

const FACT_ID = /"(?:fact_id|id)"\s*:\s*"?([0-9a-zA-Z_-]{1,64})"?/g;
const factIds = (text: string) => [...text.matchAll(FACT_ID)].map(m => m[1]);

export interface CellRow {
  id: string; question_id: string; category: string; abstention: boolean; arm: string; model: string; window: number;
  answer: string; qa_scores: number[]; qa_score: number;
  sessions: number; live_turns: number; compactions: number; notices: number; notice_segments: number; missed_segments: number;
  remember_calls: number; remember_batched: number; remember_items: number; facts_saved: number; evidence_saved: boolean; evidence_recall5: boolean | null;
  core_chars: number | null; tool_calls: Record<string, number>; errors: string[];
  usage: CallUsage; usd_agent: number; usd_gbrain: number; usd_profile: number; ms: number;
  builds: Record<string, string>;
}

interface Ctx {
  benchmark: string; tag?: string; window: number; replyTokens: number; judgeRuns: number; judgeModel: string; profileModel: string; effort?: string;
  builds: Record<string, string>; buildDirs: Record<string, string>; work: string; proxy: MeteringProxy; chat: ChatClient;
}

function brainEnv(dir: string, buildDir: string, proxyPort: number, slot: string): RunEnv {
  const base = `http://127.0.0.1:${proxyPort}/${slot}`;
  return {
    buildDir,
    env: {
      PATH: directGitPath(dir), HOME: join(dir, 'uh'), GBRAIN_HOME: join(dir, 'home'), CLAUDE_CONFIG_DIR: join(dir, 'claude'),
      GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_BACKUP_CHECK: 'off', GBRAIN_SERVE_BOOT_TIMEOUT_SECONDS: '0', TZ: 'UTC', LANG: 'C.UTF-8', NO_COLOR: '1',
      OPENAI_API_KEY: process.env.OPENAI_API_KEY, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, VOYAGE_API_KEY: process.env.VOYAGE_API_KEY,
      ANTHROPIC_BASE_URL: `${base}/anthropic`, OPENAI_BASE_URL: `${base}/openai`,
    },
  };
}

async function cli(run: RunEnv, args: string[], step: string): Promise<string> {
  const r = await runCli(run, args, 600_000);
  if (r.code !== 0) throw new Error(`gbrain ${step} failed (exit ${r.code}): ${(r.stdout + r.stderr).split('\n').filter(Boolean).slice(-14).join(' | ')}`);
  return r.stdout;
}

async function profileFor(ctx: Ctx, first: Session): Promise<{ text: string; usd: number }> {
  const conv = first.turns.map(t => `${t.speaker}: ${t.content}`).join('\n').slice(0, 40_000);
  const r = await ctx.chat.chat(ctx.profileModel, PROFILE_PROMPT.replace('{conversation}', conv), { maxTokens: 400, replicate: 0 });
  const [prov, name] = ctx.profileModel.split(':');
  const p = CHAT_PRICE_OVERRIDES[`${prov}:${name}`];
  return { text: r.text.trim(), usd: r.cached || !p ? 0 : (r.input_tokens * p.input + r.output_tokens * p.output) / 1e6 };
}

async function waitForIpc(home: string, timeoutMs = 60_000): Promise<void> {
  const t0 = Date.now();
  const data = join(home, 'brain.pglite');
  while (Date.now() - t0 < timeoutMs) {
    if (existsSync(join(data, '.gbrain-ipc-secret'))) { await Bun.sleep(500); return; }
    await Bun.sleep(250);
  }
}

export async function runCell(ctx: Ctx, q: MemoryQuestion, sessions: Session[], arm: ArmSpec, model: string): Promise<CellRow> {
  const t0 = Date.now();
  const armLabel = ctx.tag ? `${arm.id}@${ctx.tag}` : arm.id;
  const cellId = `${q.id}__${armLabel}__${model}`;
  const slot = createHash('sha256').update(cellId).digest('hex').slice(0, 12);
  const dir = join(ctx.work, slot);
  rmSync(dir, { recursive: true, force: true });
  for (const d of ['home', 'uh', 'claude', 'cwd']) mkdirSync(join(dir, d), { recursive: true });
  const buildDir = ctx.buildDirs[arm.build];
  const run = brainEnv(dir, buildDir, ctx.proxy.port, slot);
  ctx.proxy.bind(slot, cellId);
  const errors: string[] = [];
  const usage: CallUsage = { input: 0, cache_write: 0, cache_read: 0, output: 0 };
  const toolCalls: Record<string, number> = {};
  let client: McpClient | null = null;
  const ordered = [...sessions].sort((a, b) => sessionTime(a.date) - sessionTime(b.date));
  const profile = await profileFor(ctx, ordered[0]);
  const row: CellRow = {
    id: cellId, question_id: q.id, category: q.category, abstention: q.abstention, arm: armLabel, model, window: ctx.window,
    answer: '', qa_scores: [], qa_score: 0, sessions: ordered.length, live_turns: 0, compactions: 0, notices: 0, notice_segments: 0, missed_segments: 0,
    remember_calls: 0, remember_batched: 0, remember_items: 0, facts_saved: 0, evidence_saved: false, evidence_recall5: null, core_chars: null, tool_calls: toolCalls, errors,
    usage, usd_agent: 0, usd_gbrain: 0, usd_profile: profile.usd, ms: 0, builds: ctx.builds,
  };
  try {
    // Brain: init, arm config, the shared profile page, core marking for C/D.
    await cli(run, ['init', '--pglite', '--path', join(dir, 'home', 'brain.pglite'), '--embedding-model', GBRAIN_EMBED_MODEL, '--non-interactive'], 'init');
    for (const [k, v] of Object.entries(arm.config(ctx.window))) await cli(run, ['config', 'set', k, v], `config set ${k}`);
    const page = `---\ntitle: About the user\ntype: note\n---\n\n${profile.text}\n`;
    await cli(run, ['call', 'put_page', JSON.stringify({ slug: 'core/about-the-user', content: page })], 'put profile');
    if (arm.core) await cli(run, ['core', 'add', 'core/about-the-user', '--priority', '10'], 'core add');

    client = new McpClient(run, ['--surface', 'starter']);
    await client.start();
    await waitForIpc(join(dir, 'home'));
    const instructions = client.instructions.slice(0, INSTRUCTIONS_CAP);
    const tools: ToolDef[] = client.tools.map(t => ({ name: t.name, description: t.description ?? '', input_schema: (t.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown> }));
    const system = `${SYSTEM_FRAME}\n\n<mcp_server_instructions server="gbrain">\n${instructions}\n</mcp_server_instructions>`;

    const sessionId = randomUUID();
    const cwd = join(dir, 'cwd');
    const transcript = new ClaudeTranscript(join(dir, 'claude', 'projects', 'p4', `${sessionId}.jsonl`), sessionId, cwd);
    const hook: HookEnv = { buildDir, env: run.env, cwd };
    const hookPayload = (extra: Record<string, unknown>) => ({ session_id: sessionId, transcript_path: transcript.path, cwd, ...extra });

    let history: Msg[] = [];
    let contextTokens = 0;
    const savedBy = new Map<string, string>(); // fact id -> session id
    let currentSession = '';
    let segmentNotice = false;

    const pushUser = (blocks: Block[]) => {
      const last = history[history.length - 1];
      if (last && last.role === 'user' && !last.blocks.some(b => b.type === 'tool_result')) last.blocks.push(...blocks);
      else history.push({ role: 'user', blocks });
    };
    const pushAssistant = (text: string) => {
      const last = history[history.length - 1];
      if (!last || last.role !== 'user') pushUser([{ type: 'text', text: '(continued)' }]);
      history.push({ role: 'assistant', blocks: [{ type: 'text', text }] });
    };
    const startReminder = async (source: 'startup' | 'compact') => {
      const r = await runHook(hook, 'session-start', hookPayload({ hook_event_name: 'SessionStart', source }));
      if (r.code !== 0) errors.push(`session-start ${r.code}`);
      const m = /Core memory \(always loaded\) — ([\d,]+)\//.exec(r.stdout);
      if (m) row.core_chars = Number(m[1].replace(/,/g, ''));
      return r.stdout.trim();
    };

    const liveTurn = async (userText: string, maxSteps: number, maxOutput: number): Promise<string> => {
      transcript.user(userText);
      const up = await runHook(hook, 'user-prompt', hookPayload({ hook_event_name: 'UserPromptSubmit', prompt: userText }));
      const extra = additionalContext(up.stdout);
      if (/context is about \d+% full/.test(extra)) { row.notices++; segmentNotice = true; }
      pushUser([{ type: 'text', text: withReminder(userText, extra) }]);
      row.live_turns++;
      let finalText = '';
      for (let step = 0; step < maxSteps; step++) {
        const reply = await callModel({ model, system, tools, messages: history, maxOutput, effort: ctx.effort });
        for (const k of Object.keys(usage) as Array<keyof CallUsage>) usage[k] += reply.usage[k];
        contextTokens = reply.contextTokens;
        history.push({ role: 'assistant', blocks: reply.blocks.length ? reply.blocks : [{ type: 'text', text: '(no reply)' }], ...(reply.raw ? { raw: reply.raw } : {}) });
        const text = textOf(reply.blocks);
        transcript.assistant(text || '(tool use)', model, { input_tokens: reply.usage.input, cache_creation_input_tokens: reply.usage.cache_write, cache_read_input_tokens: reply.usage.cache_read, output_tokens: reply.usage.output });
        if (text) finalText = text;
        const calls = reply.blocks.filter((b): b is Extract<Block, { type: 'tool_call' }> => b.type === 'tool_call');
        if (!calls.length) break;
        const results: Block[] = [];
        for (const c of calls) {
          toolCalls[c.name] = (toolCalls[c.name] ?? 0) + 1;
          let out: string;
          try { out = await client!.call(c.name, c.args); } catch (e) { out = `Error: ${(e as Error).message}`; }
          if (c.name === 'remember') {
            row.remember_calls++;
            if (Array.isArray(c.args.items)) { row.remember_batched++; row.remember_items += c.args.items.length; }
            for (const id of new Set(factIds(out))) { savedBy.set(id, currentSession); }
          }
          results.push({ type: 'tool_result', id: c.id, text: out });
        }
        history.push({ role: 'user', blocks: results });
      }
      return finalText;
    };

    const compact = async () => {
      await runHook(hook, 'compact', hookPayload({ hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: null }));
      pushUser([{ type: 'text', text: COMPACT_PROMPT }]);
      const reply = await callModel({ model, system, tools, messages: history, maxOutput: 2500, noTools: true, effort: ctx.effort });
      for (const k of Object.keys(usage) as Array<keyof CallUsage>) usage[k] += reply.usage[k];
      const summary = textOf(reply.blocks);
      row.compactions++;
      if (segmentNotice) row.notice_segments++; else row.missed_segments++;
      segmentNotice = false;
      transcript.compactBoundary('auto');
      const start = await startReminder('compact');
      history = [];
      pushUser([{ type: 'text', text: withReminder(`This session is being continued from a previous conversation that ran out of context. The conversation is summarized below:\n${summary}`, start) }]);
      transcript.user(`(compacted summary)\n${summary}`);
      contextTokens = approxTokens(system) + approxTokens(summary) + approxTokens(start);
    };

    pushUser([{ type: 'text', text: withReminder('(conversation start)', await startReminder('startup')) }]);
    for (const s of ordered) {
      currentSession = s.id;
      const lastUser = s.turns.map(t => t.speaker).lastIndexOf('user');
      if (lastUser < 0) continue;
      const sessionText = s.turns.map(t => t.content).join('\n');
      if (contextTokens + approxTokens(sessionText) > ctx.window * 0.95) await compact();
      const header = `[Conversation on ${s.date ?? 'an unknown date'}]`;
      s.turns.slice(0, lastUser).forEach((t, i) => {
        const text = i === 0 ? `${header}\n${t.content}` : t.content;
        if (t.speaker === 'user') { pushUser([{ type: 'text', text }]); transcript.user(text); }
        else { pushAssistant(text); transcript.assistant(text, model); }
      });
      const live = lastUser === 0 ? `${header}\n${s.turns[lastUser].content}` : s.turns[lastUser].content;
      await liveTurn(live, 6, ctx.replyTokens);
    }
    if (contextTokens + 2000 > ctx.window * 0.95) await compact();
    row.answer = await liveTurn(`[Now: ${q.question_date ?? 'today'}] ${q.question}\n\n${FINAL_INSTRUCTION}`, 10, 2000);

    // Evidence: did the agent save a fact while a gold session was live, and does recall surface it in its top five?
    const goldSaved = [...savedBy.entries()].filter(([, s]) => q.gold.includes(s)).map(([id]) => id);
    row.facts_saved = savedBy.size;
    row.evidence_saved = goldSaved.length > 0;
    if (!q.abstention) {
      try {
        const rec = await client.call('recall', { query: q.question, limit: 5 });
        const top = new Set(factIds(rec).slice(0, 10));
        row.evidence_recall5 = goldSaved.some(id => top.has(id));
      } catch (e) { errors.push(`recall: ${(e as Error).message}`); }
    }
  } catch (e) {
    if ((e as Error).name === 'BudgetExceededError') throw e;
    errors.push((e as Error).message.slice(-1500));
  } finally {
    await client?.close();
    ctx.proxy.unbind(slot);
    row.usd_gbrain = (await ctx.proxy.finalize(cellId)).usd;
  }
  row.usd_agent = priceUsage(model, usage);
  if (!errors.length || row.answer) {
    for (let r = 0; r < ctx.judgeRuns; r++) row.qa_scores.push(await judgeResponse(ctx.chat, ctx.benchmark, ctx.judgeModel, q, row.answer, r));
    row.qa_score = row.qa_scores.length ? row.qa_scores.reduce((a, b) => a + b, 0) / row.qa_scores.length : 0;
  }
  row.ms = Date.now() - t0;
  if (!errors.length) rmSync(dir, { recursive: true, force: true });
  return row;
}

async function main(argv: string[]) {
  const out = resolve(flag(argv, '--output') ?? 'eval/reports/p4-stream/run');
  mkdirSync(out, { recursive: true });
  const benchmark = flag(argv, '--benchmark') ?? 'lme-s';
  const arms = (flag(argv, '--arms') ?? 'Aprime,B,C').split(',').map(a => { const s = ARMS[a as ArmId]; if (!s) throw new Error(`unknown arm ${a}`); return s; });
  const models = (flag(argv, '--models') ?? 'claude-sonnet-5-5').split(',');
  for (const m of models) if (!CHAT_PRICE_OVERRIDES[`${provider(m)}:${m}`]) throw new Error(`no verified price for ${m}`);
  const builds: Record<string, string> = Object.fromEntries(flags(argv, '--build').map(b => [b.slice(0, b.indexOf('=')), b.slice(b.indexOf('=') + 1)]));
  for (const a of arms) if (!builds[a.build]) throw new Error(`arm ${a.id} needs --build ${a.build}=<gbrain>@<sha>`);
  const window = Number(flag(argv, '--window') ?? 32000);
  const limit = flag(argv, '--limit') ? Number(flag(argv, '--limit')) : null;
  const offset = Number(flag(argv, '--offset') ?? 0);
  const seed = Number(flag(argv, '--seed') ?? 42);
  const concurrency = Number(flag(argv, '--concurrency') ?? 4);
  const only = flag(argv, '--questions')?.split(',');

  const corpus = loadCorpus(benchmark);
  const conv = new Map(corpus.conversations.map(c => [c.id, c.sessions]));
  let questions = orderQuestions(corpus.questions, seed);
  if (only) questions = questions.filter(q => only.includes(q.id));
  questions = questions.slice(offset, limit === null ? undefined : offset + limit);

  const buildDirs: Record<string, string> = {};
  const resolvedBuilds: Record<string, string> = {};
  for (const [k, spec] of Object.entries(builds)) {
    const gut = resolveGbrainUnderTest(spec);
    buildDirs[k] = gut.root;
    resolvedBuilds[k] = `${gut.overlay?.build.commit ?? spec} (v${gut.version})`;
  }

  const rowsPath = join(out, 'rows.ndjson');
  const done = new Set(existsSync(rowsPath) ? readFileSync(rowsPath, 'utf8').split('\n').filter(Boolean).map(l => (JSON.parse(l) as CellRow).id) : []);
  const cells: Array<{ q: MemoryQuestion; arm: ArmSpec; model: string }> = [];
  for (const q of questions) for (const model of models) for (const arm of arms) if (!done.has(`${q.id}__${flag(argv, '--tag') ? `${arm.id}@${flag(argv, '--tag')}` : arm.id}__${model}`)) cells.push({ q, arm, model });

  const budget = budgetOptionsFrom(argv);
  if (!argv.includes('--paid')) throw new Error('p4-stream makes paid model calls; pass --paid --budget-usd <cap>');
  const paid = startPaidRun('p4-stream', { ...budget, estimateUsd: null });
  const proxy = new MeteringProxy();
  proxy.start();
  const ctx: Ctx = {
    benchmark, tag: flag(argv, '--tag'), window, replyTokens: Number(flag(argv, '--reply-tokens') ?? 700), judgeRuns: Number(flag(argv, '--judge-runs') ?? 10), judgeModel: flag(argv, '--judge-model') ?? 'openai:gpt-4o-2024-08-06',
    profileModel: flag(argv, '--profile-model') ?? 'openai:gpt-4.1-mini', effort: flag(argv, '--effort'),
    builds: resolvedBuilds, buildDirs, work: resolve(flag(argv, '--work') ?? join(homedir(), 'p4-stream-work', createHash('sha256').update(out).digest('hex').slice(0, 10))), proxy, chat: new ChatClient(join(out, 'chat-cache')),
  };
  writeFileSync(join(out, 'run.json'), JSON.stringify({ started_at: new Date().toISOString(), argv, builds: resolvedBuilds, window, seed, offset, limit, questions: questions.map(q => q.id), arms: arms.map(a => a.id), models, instructions_cap: INSTRUCTIONS_CAP, budget_run_id: paid.run.runId }, null, 2));
  process.stderr.write(`[p4-stream] ${cells.length} cell(s) to run (${done.size} done) → ${rowsPath}\n`);

  let next = 0;
  let stop = false;
  const worker = async () => {
    while (!stop && next < cells.length) {
      const c = cells[next++];
      try {
        const row = await runCell(ctx, c.q, conv.get(c.q.conversation) ?? [], c.arm, c.model);
        appendFileSync(rowsPath, `${JSON.stringify(row)}\n`);
        process.stderr.write(`[p4-stream] ${row.id}: score ${row.qa_score.toFixed(2)} compactions ${row.compactions} notices ${row.notices} saved ${row.facts_saved} $${(row.usd_agent + row.usd_gbrain).toFixed(3)} ${row.errors.length ? `errors ${row.errors.join('; ').slice(0, 200)}` : ''}\n`);
      } catch (e) {
        if ((e as Error).name === 'BudgetExceededError') { stop = true; process.stderr.write(`[p4-stream] budget cap reached: ${(e as Error).message}\n`); return; }
        process.stderr.write(`[p4-stream] ${c.q.id} ${c.arm.id} ${c.model} failed: ${(e as Error).message}\n`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  proxy.stop();
  const summary = paid.run.close();
  process.stderr.write(`[p4-stream] done; ledger: ${JSON.stringify(summary)}\n`);
}

if (import.meta.main) main(process.argv.slice(2)).catch(e => { console.error(e); process.exit(1); });

