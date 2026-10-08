/**
 * T0 program primary: end-to-end failures on cross-session meeting or reply
 * preparation after a correction (plan 2026-10-07 section 3.1, wave 1 T0).
 *
 * One cell is one task, one reader, one arm and one repeat:
 *   1. the persona's brain is restored from its post-build snapshot and
 *      `gbrain serve --surface starter` starts over stdio;
 *   2. session 1: the SessionStart and UserPromptSubmit hooks of the build
 *      under test run (t0/delivery.ts) and their context is injected; the
 *      user tells the agent about a call (a commitment, a moved meeting and a
 *      correction) and asks it to update the brain; the agent uses gbrain's
 *      MCP tools;
 *   3. session break: a new serve process on the same brain (the arm can
 *      change this, see ARMS);
 *   4. session 2: hooks again, then the meeting-prep or reply request, which
 *      names none of the three facts; the deliverable is scored by
 *      t0/score.ts against the generator's gold.
 *
 * Arms (the mutants prove the primary detects both failure kinds):
 *   baseline                  the delivery contract as frozen;
 *   mutant-forced-drop        the item never arrives: session 1's writes are
 *                             rolled back and session 2's hook output is
 *                             dropped;
 *   mutant-stale-correction   the correction never lands: session 1's writes
 *                             are rolled back and the harness writes the
 *                             commitment and the moved meeting to the contact
 *                             page but not the correction, so memory (push
 *                             and pull) serves the pre-correction value;
 *   ablation-push-off         diagnostic: both sessions run with hook output
 *                             dropped and the brain intact (what push adds).
 *
 * Hermetic by default: without --paid the reader is scripted (an oracle
 * writer in session 1, a reader in session 2 that follows only the pushed
 * pointer) on a keyless brain, which proves the plumbing, the hooks and the
 * mutants at $0 and measures no model. Paid cells need
 * `--paid --budget-run-id <id>` (eval/runner/paid-arm.ts) and spend through
 * the budget ledger.
 *
 * Usage:
 *   bun eval/runner/t0-program-primary.ts --gbrain <checkout>@<ref> --output <dir> [--seeds a,b] [--tasks id,..]
 *     [--readers claude-opus-5-5,claude-sonnet-5-5,gpt-6.1-sol] [--arms baseline,...] [--repeat N] [--concurrency N]
 *     [--paid --budget-run-id <id>]
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { generateWorld, humanDate, PP_DEV_SEEDS, PP_SESSION2_DAY, PP_TODAY, renderPPDoc, solvabilityProblems, worldDigest, type PPPersona, type PPTask } from '../generators/program-primary-gen.ts';
import { GbrainSlot, MeteringProxy, type Meter } from './cat40/gbrain-arm.ts';
import { runAgent, provider, type AgentRun, type Arm, type ProviderAttempt, type ScriptedModel, type ToolSpec } from './cat40/loop.ts';
import { prepareBuild, type BuildInfo } from './lifecycle/builds.ts';
import { DELIVERY_CONTRACT, dropped, renderUserTurn, runHook, type HookResult } from './t0/delivery.ts';
import { matches, scoreAnswer, truthfulAnswer, T0_SCORER_VERSION, type T0Score } from './t0/score.ts';
import { normalizeFinish, normalizeUsage, receipt, usageSourceOf, type UsageReceipt } from './usage-receipt.ts';
import { requirePaidArm, paidRequested } from './paid-arm.ts';
import { budgetOptionsFrom, startPaidRun, receiptCost, type BudgetRun } from './budget-ledger.ts';
import { DECIDE_OFF, enterHermeticEnv, type HermeticEnv } from './hermetic-env.ts';
import { readCells, summarize } from './t0/analyze.ts';

export const T0_VERSION = 't0-program-primary-v1';
export const ARMS = ['baseline', 'mutant-forced-drop', 'mutant-stale-correction', 'ablation-push-off'] as const;
export type T0Arm = typeof ARMS[number];
export const COUNTED_READERS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-6.1-sol'] as const;
export const FROZEN_RELEASE = { version: '0.60.106.0', commit: '7aa2caa0aa2a9f031730cd351cd516cf4f9f5802' } as const;
export const MAX_TURNS = 20;
const SURFACE = 'starter';
const WRITE_TOOLS = new Set(['put_page', 'edit_page', 'remember', 'capture', 'add_timeline_entry', 'forget', 'synthesize']);

export const T0_SUBMIT: ToolSpec = {
  name: 'submit_answer',
  description: 'Finish your turn. Put your complete reply to the user in `answer` (for a brief or a draft, the full text).',
  input_schema: {
    type: 'object',
    properties: {
      answer: { type: 'string', description: 'Your complete reply to the user.' },
      sources: { type: 'array', items: { type: 'string' }, description: 'Brain pages you relied on (optional).' },
    },
    required: ['answer'],
  },
};

export function systemPrompt(p: PPPersona, day: string, instructions: string): string {
  return [
    `You are ${p.principal.first}'s AI assistant in their agent harness. ${p.principal.name} is the ${p.principal.role} of ${p.principal.company}, which builds a ${p.principal.product}. Today is ${humanDate(day)}, ${day.slice(0, 4)} (${day}).`,
    `${p.principal.first}'s personal brain (gbrain) is their long-term memory across sessions. You reach it through the MCP tools listed. The gbrain server's instructions follow.\n<mcp_server_instructions server="gbrain">\n${instructions}\n</mcp_server_instructions>`,
    'When you are done, call submit_answer with your complete reply in `answer`.',
  ].join('\n\n');
}

/** gbrain's MCP tools as the agent sees them (the server's own list and descriptions). */
class BrainArm implements Arm {
  readonly name = 'gbrain';
  constructor(private slot: GbrainSlot) {}
  private get client() { if (!this.slot.client) throw new Error('gbrain slot not started'); return this.slot.client; }
  systemHint() { return ''; }
  tools(): ToolSpec[] { return this.client.tools.map(t => ({ name: t.name, description: t.description ?? '', input_schema: (t.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown> })); }
  toolsVersion() { return this.client.toolsVersion; }
  writeTools() { return this.client.tools.filter(t => t.annotations?.readOnlyHint !== true).map(t => t.name); }
  call(name: string, args: Record<string, unknown>) { return this.client.call(name, args); }
}

// ─── Scripted (hermetic) reader ─────────────────────────────────────

/** The page revision a get_page result carries (put_page refuses an existing page without it); the result may carry a notice before its JSON. */
export function revisionOf(getPageResult: string): string | undefined {
  return getPageResult.match(/(?<![A-Za-z_])"revision"\s*:\s*"([^"]+)"/)?.[1];
}

/** Session 1 oracle writer: rewrites the contact page with the three facts (proves writes persist; measures no model). */
export function scriptedWriter(p: PPPersona, t: PPTask): ScriptedModel {
  const doc = p.docs.find(d => d.id === t.contact)!;
  const g = t.gold;
  const body = doc.body
    .replaceAll(humanDate(g.date.old_iso), humanDate(g.date.new_iso)).replaceAll(g.date.old_iso, g.date.new_iso)
    .replaceAll(g.correction.stale.label, g.correction.corrected.label)
    .replace('## Current\n\n', `## Current\n\n- Open commitment: I owe ${t.contact_name.split(' ')[0]} ${g.commitment.label}.\n`);
  return history => {
    if (history.length === 0) return { name: 'get_page', args: { slug: t.contact, include_content: true } };
    if (history.length === 1) return { name: 'put_page', args: { slug: t.contact, expected_revision: revisionOf(history[0].result), content: renderPPDoc({ ...doc, body }) } };
    return { name: 'submit_answer', args: { answer: 'Updated your brain.' } };
  };
}

/** Session 2 reader that follows only the pushed pointer: one get_page of the pointed page, then answers from what it saw. */
export function scriptedReader(t: PPTask, injected: string): ScriptedModel {
  const pointer = injected.match(/`((?:people|companies|deals|meetings)\/[a-z0-9-]+)`/)?.[1] ?? null;
  return history => {
    if (history.length === 0 && pointer) return { name: 'get_page', args: { slug: pointer } };
    const seen = [injected, ...history.map(h => h.result)].join('\n');
    const g = t.gold;
    const date = matches(g.date.new, seen) ? humanDate(g.date.new_iso) : matches(g.date.old, seen) ? humanDate(g.date.old_iso) : 'not in the brain';
    const correction = matches(g.correction.corrected, seen) ? g.correction.corrected.label : matches(g.correction.stale, seen) ? g.correction.stale.label : 'not in the brain';
    const answer = pointer ? truthfulAnswer(t, { date, correction, commitment: matches(g.commitment, seen) ? g.commitment.label : null }) : 'I could not find anything about this in your brain.';
    return { name: 'submit_answer', args: { answer } };
  };
}

// ─── Cells ──────────────────────────────────────────────────────────

export interface SessionRecord {
  session: 1 | 2;
  session_id: string;
  hooks: HookResult[];
  injected_chars: number;
  injected_tokens_cl100k: number | null;
  stop: AgentRun['stop'];
  error?: string;
  turns: number;
  usd: number;
  wall_ms: number;
  model_ms: number;
  tool_ms: number;
  tool_calls: Array<{ name: string; ms: number; chars: number; error?: string; args_excerpt?: string; result_excerpt?: string }>;
  answer: string;
}

export interface CellRecord {
  key: string;
  version: typeof T0_VERSION;
  persona: string;
  task: string;
  kind: PPTask['kind'];
  correction_kind: PPTask['correction_kind'];
  reader: string;
  arm: T0Arm;
  repeat: number;
  sessions: SessionRecord[];
  /** Which of the three facts session 1's write calls carried (capture diagnostics; not scored). */
  capture: { writes: number; commitment: boolean; new_date: boolean; corrected: boolean };
  score: T0Score;
  usd: { reader: number; gbrain_internal: number; total: number };
  tokens: { input_total: number; output_total: number };
  gbrain_internal?: Meter;
  wall_ms: number;
  budget_run_id: string | null;
  started_at: string;
}

interface Ctx {
  build: BuildInfo;
  proxy: MeteringProxy;
  slots: Map<string, GbrainSlot>;
  out: string;
  scripted: boolean;
  budgetRunId: string | null;
  workspaceRoot: string;
  countTokens: ((s: string) => number) | null;
}

export const cellKey = (task: string, reader: string, arm: string, repeat: number) => `${task}|${reader}|${arm}|${repeat}`;

async function settle(ms: number) { await new Promise(r => setTimeout(r, ms)); }

async function runSession(ctx: Ctx, slot: GbrainSlot, p: PPPersona, t: PPTask, reader: string, arm: T0Arm, repeat: number, n: 1 | 2, receipts: UsageReceipt[]): Promise<{ rec: SessionRecord; run: AgentRun }> {
  const sessionId = createHash('sha256').update(`${cellKey(t.id, reader, arm, repeat)}|s${n}|${Date.now()}`).digest('hex').slice(0, 32);
  const ws = join(ctx.workspaceRoot, `${p.id}-${sessionId.slice(0, 8)}`);
  const prompt = n === 1 ? t.session1 : t.session2;
  await settle(DELIVERY_CONTRACT.timing.settle_ms_after_initialize);
  const env = slot.run.env as Record<string, string | undefined>;
  const drop = arm === 'ablation-push-off' || (arm === 'mutant-forced-drop' && n === 2);
  const raw = [
    await runHook(ctx.build.dir, env, ws, 'session-start', { session_id: sessionId, cwd: ws, source: 'startup', hook_event_name: 'SessionStart' }),
    await runHook(ctx.build.dir, env, ws, 'user-prompt', { session_id: sessionId, cwd: ws, prompt, hook_event_name: 'UserPromptSubmit' }),
  ];
  const hooks = drop ? raw.map(dropped) : raw;
  const user = renderUserTurn(prompt, hooks);
  const injected = hooks.map(h => h.text).join('\n');
  const day = n === 1 ? PP_TODAY : PP_SESSION2_DAY;
  const brainArm = new BrainArm(slot);
  let attempt = 0;
  const onAttempt = (a: ProviderAttempt) => {
    const r = a.response ?? {};
    const isAnthropic = provider(reader) === 'anthropic';
    const content = (isAnthropic ? r.content : r.output) as Array<Record<string, unknown>> | undefined;
    const text = (content ?? []).flatMap(c => (isAnthropic ? (c.type === 'text' ? [String(c.text)] : c.type === 'tool_use' ? [`[tool_use ${String(c.name)}] ${JSON.stringify(c.input)}`] : [])
      : c.type === 'message' ? ((c.content as Array<Record<string, unknown>>) ?? []).map(x => String(x.text ?? '')) : c.type === 'function_call' ? [`[tool_use ${String(c.name)}] ${String(c.arguments)}`] : [])).join('\n');
    const finishRaw = isAnthropic ? (r.stop_reason as string | undefined) ?? null : (r.status as string | undefined) ?? null;
    receipts.push(receipt({
      lane: 't0-program-primary', role: 'reader', question_id: `${t.id}:${arm}:s${n}`, replicate: repeat, attempt: attempt++,
      model: `${provider(reader)}:${reader}`, response_model: (r.model as string | undefined) ?? null, status: a.status, error: a.error, from_cache: false,
      finish: normalizeFinish(finishRaw), finish_raw: finishRaw, answer: text, usage: a.response ? normalizeUsage(usageSourceOf(reader), r.usage) : null,
      usage_raw: (r.usage as Record<string, unknown> | undefined) ?? null,
      delivered: attempt === 1 && ctx.countTokens ? { tokenizer: 'cl100k', tokens: ctx.countTokens(user) } : null,
    }));
  };
  const t0 = Date.now();
  const run = await runAgent({
    model: ctx.scripted ? 'scripted' : reader, arm: brainArm, system: systemPrompt(p, day, slot.client!.instructions), user, maxTurns: MAX_TURNS, submitTool: T0_SUBMIT, onAttempt,
    scripted: ctx.scripted ? (n === 1 ? scriptedWriter(p, t) : scriptedReader(t, injected)) : undefined,
  });
  const answer = run.final?.answer ?? run.text ?? '';
  return {
    run,
    rec: {
      session: n, session_id: sessionId, hooks, injected_chars: injected.length, injected_tokens_cl100k: ctx.countTokens && injected ? ctx.countTokens(injected) : injected ? null : 0,
      stop: run.stop, ...(run.error ? { error: run.error } : {}), turns: run.turns, usd: run.usd, wall_ms: Date.now() - t0, model_ms: run.model_ms, tool_ms: run.tool_ms,
      tool_calls: run.tools.map(c => ({ name: c.name, ms: c.ms, chars: c.chars, ...(c.error ? { error: c.error } : {}), ...(WRITE_TOOLS.has(c.name) ? { args_excerpt: JSON.stringify(c.args).slice(0, 4000), result_excerpt: c.result.slice(0, 600) } : {}) })),
      answer,
    },
  };
}

/** Rolls session 1 back and writes the commitment and the moved meeting, but not the correction, to the contact page. */
async function writeStaleCorrection(slot: GbrainSlot, p: PPPersona, t: PPTask) {
  const doc = p.docs.find(d => d.id === t.contact)!;
  const g = t.gold;
  const body = doc.body
    .replaceAll(humanDate(g.date.old_iso), humanDate(g.date.new_iso)).replaceAll(g.date.old_iso, g.date.new_iso)
    .replace('## Current\n\n', `## Current\n\n- Open commitment: I owe ${t.contact_name.split(' ')[0]} ${g.commitment.label}.\n`);
  const current = await slot.client!.call('get_page', { slug: t.contact, include_content: true });
  const r = await slot.client!.call('put_page', { slug: t.contact, expected_revision: revisionOf(current), content: renderPPDoc({ ...doc, body }) });
  if (r.startsWith('Error')) throw new Error(`stale-correction mutant write failed: ${r.slice(0, 300)}`);
}

export async function runCell(ctx: Ctx, p: PPPersona, t: PPTask, reader: string, arm: T0Arm, repeat: number): Promise<CellRecord> {
  const started = new Date();
  const key = cellKey(t.id, reader, arm, repeat);
  const slot = ctx.slots.get(p.id)!;
  const receipts: UsageReceipt[] = [];
  ctx.proxy.bind(slot.id, key);
  const sessions: SessionRecord[] = [];
  try {
    await slot.restore();
    const s1 = await runSession(ctx, slot, p, t, reader, arm, repeat, 1, receipts);
    sessions.push(s1.rec);
    if (arm === 'mutant-forced-drop' || arm === 'mutant-stale-correction') {
      await slot.restore();
      if (arm === 'mutant-stale-correction') await writeStaleCorrection(slot, p, t);
      await slot.newSession();
    } else await slot.newSession();
    const s2 = await runSession(ctx, slot, p, t, reader, arm, repeat, 2, receipts);
    sessions.push(s2.rec);
  } finally {
    await slot.stop();
    ctx.proxy.unbind(slot.id);
  }
  const gbrain_internal = await ctx.proxy.finalize(key);
  for (const r of receipts) appendFileSync(join(ctx.out, 'usage.jsonl'), JSON.stringify({ cell: key, ...r }) + '\n');
  const [s1, s2] = sessions;
  const writes = s1.tool_calls.filter(c => WRITE_TOOLS.has(c.name));
  const written = writes.map(c => c.args_excerpt ?? '').join('\n');
  const g = t.gold;
  const executionError = s2.stop === 'error' ? s2.error ?? 'provider error' : s2.stop === 'turn_cap' && !s2.answer ? 'turn cap without a deliverable' : null;
  const readerUsd = sessions.reduce((s, x) => s + x.usd, 0);
  const tokens = receipts.filter(r => r.usage).reduce((acc, r) => ({ input_total: acc.input_total + r.usage!.input_total, output_total: acc.output_total + r.usage!.output_total }), { input_total: 0, output_total: 0 });
  return {
    key, version: T0_VERSION, persona: p.id, task: t.id, kind: t.kind, correction_kind: t.correction_kind, reader, arm, repeat, sessions,
    capture: { writes: writes.length, commitment: matches(g.commitment, written), new_date: matches(g.date.new, written), corrected: matches(g.correction.corrected, written) },
    score: scoreAnswer(t, s2.answer, { executionError }),
    usd: { reader: readerUsd, gbrain_internal: gbrain_internal.usd, total: readerUsd + gbrain_internal.usd },
    tokens, gbrain_internal, wall_ms: Date.now() - started.getTime(), budget_run_id: ctx.budgetRunId, started_at: started.toISOString(),
  };
}

// ─── Main ───────────────────────────────────────────────────────────

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Per-cell cost estimate for the ledger's preflight, from the measured smoke (docs/benchmarks/2026-10-08-program-primary-preregistration.md). */
export const EST_USD_PER_CELL: Record<string, number> = { 'claude-opus-5-5': 0.45, 'claude-sonnet-5-5': 0.25, 'gpt-6.1-sol': 0.25 };

export async function main(argv: string[]) {
  const scripted = !paidRequested(argv);
  const spec = flag(argv, '--gbrain');
  if (!spec || !spec.includes('@')) throw new Error('--gbrain <checkout>@<ref> is required: the program primary pins the release explicitly (the frozen baseline is v0.60.106.0, 7aa2caa0)');
  const [checkout, ref] = [spec.slice(0, spec.lastIndexOf('@')), spec.slice(spec.lastIndexOf('@') + 1)];
  const out = resolve(flag(argv, '--output') ?? `eval/reports/t0-program-primary/${scripted ? 'hermetic' : 'paid'}`);
  const seeds = flag(argv, '--seeds')?.split(',').map(Number) ?? (scripted ? [PP_DEV_SEEDS[0]] : [...PP_DEV_SEEDS]);
  const bad = seeds.filter(s => !PP_DEV_SEEDS.includes(s));
  if (bad.length) throw new Error(`only development seeds run here (${PP_DEV_SEEDS.join(', ')}); a sealed seed runs in custodian mode only. Got ${bad.join(', ')}`);
  const readers = scripted ? ['scripted'] : (flag(argv, '--readers')?.split(',') ?? [...COUNTED_READERS]);
  if (readers.includes('gpt-5.4-mini')) throw new Error('gpt-5.4-mini never runs (model rules)');
  const arms = (flag(argv, '--arms')?.split(',') ?? (scripted ? [...ARMS] : ['baseline'])) as T0Arm[];
  for (const a of arms) if (!ARMS.includes(a)) throw new Error(`unknown arm ${a}`);
  const repeat = Number(flag(argv, '--repeat') ?? 1);
  const concurrency = Number(flag(argv, '--concurrency') ?? 3);
  const onlyTasks = flag(argv, '--tasks')?.split(',');

  const world = generateWorld(seeds);
  const problems = world.personas.flatMap(solvabilityProblems);
  if (problems.length) throw new Error(`generator presence/solvability check failed (a harness error, not a result): ${problems.join('; ')}`);
  const cells: Array<{ p: PPPersona; t: PPTask; reader: string; arm: T0Arm; r: number }> = [];
  for (const p of world.personas) for (const t of p.tasks) {
    if (onlyTasks && !onlyTasks.includes(t.id)) continue;
    for (const reader of readers) for (const arm of arms) for (let r = 1; r <= repeat; r++) cells.push({ p, t, reader, arm, r });
  }

  mkdirSync(out, { recursive: true });
  const resultsPath = join(out, 'results.jsonl');
  const done = new Set(existsSync(resultsPath) ? readFileSync(resultsPath, 'utf8').split('\n').filter(Boolean).map(l => (JSON.parse(l) as CellRecord).key) : []);
  const todo = cells.filter(c => !done.has(cellKey(c.t.id, c.reader, c.arm, c.r)));
  const estimate = scripted ? 0 : todo.reduce((s, c) => s + (EST_USD_PER_CELL[c.reader] ?? 0.5), 0);
  console.error(`[t0] ${cells.length} cells (${todo.length} to run), ${world.personas.length} personas, readers ${readers.join(',')}, arms ${arms.join(',')}, estimate $${estimate.toFixed(2)}`);

  let hermetic: HermeticEnv | null = null;
  let budget: { run: BudgetRun } | null = null;
  let budgetRunId: string | null = null;
  if (scripted) hermetic = enterHermeticEnv('t0-program-primary');
  else {
    budgetRunId = requirePaidArm(argv, { arm: 't0-program-primary', estimateUsd: estimate }).budgetRunId;
    budget = startPaidRun('t0-program-primary', { ...budgetOptionsFrom(argv), estimateUsd: estimate });
  }
  // Hermetic: gbrain's provider requests are answered locally with a 401 and never leave the machine (counted in gbrain_internal.requests).
  const proxy = new MeteringProxy(scripted ? { fetchImpl: (async () => new Response(JSON.stringify({ error: { message: 'hermetic run: no provider calls' } }), { status: 401, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch } : {});
  proxy.start();
  const root = join(out, 'work');
  const slots = new Map<string, GbrainSlot>();
  try {
    const build = prepareBuild(resolve(checkout), { label: `t0-${ref}`, ref, description: 'gbrain under test (program primary)' }, join(root, 'builds'));
    if (!build.verified.tree_matches || !build.verified.cli_version_matches) throw new Error(`gbrain overlay for ${ref} failed verification`);
    let countTokens: ((s: string) => number) | null = null;
    try {
      const te = await import(join(build.dir, 'src/core/chunkers/token-estimate.ts')) as { estimateTokens: (s: string) => number; cl100kAvailable: () => boolean };
      countTokens = te.cl100kAvailable() ? te.estimateTokens : null;
    } catch { countTokens = null; }
    const builds: Record<string, unknown> = {};
    for (const p of world.personas) {
      const slot = new GbrainSlot(p.id, join(root, 'slots'), build.dir, proxy.port, SURFACE);
      if (scripted) for (const k of Object.keys(slot.run.env)) if (slot.run.env[k] === undefined) delete slot.run.env[k];
      slots.set(p.id, slot);
      const stamp = join(root, 'slots', `${p.id}.build.json`);
      const want = { persona: worldDigest(p), build: build.tree, embed: !scripted };
      if (slot.hasSnapshot() && existsSync(stamp) && JSON.stringify(JSON.parse(readFileSync(stamp, 'utf8')).want) === JSON.stringify(want)) continue;
      proxy.bind(p.id, `build:${p.id}`);
      const b = await slot.build({ docs: p.docs }, proxy, false, { render: renderPPDoc, embed: !scripted });
      builds[p.id] = { steps: b.steps.map(s => ({ step: s.step, code: s.code, ms: s.ms })), usd: b.meter.usd, ms: b.ms };
      writeFileSync(stamp, JSON.stringify({ want, build: builds[p.id] }, null, 2));
    }
    const ctx: Ctx = { build, proxy, slots, out, scripted, budgetRunId, workspaceRoot: join(root, 'ws'), countTokens };
    writeFileSync(join(out, 'experiment.json'), JSON.stringify({
      version: T0_VERSION, scorer: T0_SCORER_VERSION, delivery: DELIVERY_CONTRACT, world_digest: worldDigest(world), seeds, readers, arms, repeat,
      gbrain: { requested: spec, commit: build.commit, tree: build.tree, version: build.version, verified: build.verified, frozen_release: build.commit === FROZEN_RELEASE.commit },
      surface: SURFACE, max_turns: MAX_TURNS, reader_settings: 'provider defaults (no extended thinking requested; OpenAI reasoning effort default); max output 8192 (Anthropic) / 16000 (OpenAI) tokens per call',
      resolved_config: { decide: scripted ? DECIDE_OFF : 'provider keys present (paid arm)', hermetic: scripted, stripped_keys: hermetic?.stripped ?? [] },
      bun: Bun.version, builds,
    }, null, 2));

    // One slot per persona: cells of a persona run in order, personas run in parallel.
    const byPersona = new Map<string, typeof todo>();
    for (const c of todo) { const l = byPersona.get(c.p.id) ?? []; l.push(c); byPersona.set(c.p.id, l); }
    const queues = [...byPersona.values()];
    let failure: unknown = null;
    await Promise.all(Array.from({ length: Math.min(concurrency, queues.length) }, async () => {
      while (queues.length && !failure) {
        const q = queues.shift()!;
        for (const c of q) {
          if (failure) break;
          try {
            const rec = await runCell(ctx, c.p, c.t, c.reader, c.arm, c.r);
            appendFileSync(resultsPath, JSON.stringify(rec) + '\n');
            console.error(`[t0] ${rec.key}: ${rec.score.failed ? `FAIL ${rec.score.kinds.join('+')}` : rec.score.complete ? 'ok (complete)' : 'ok'} $${rec.usd.total.toFixed(3)} ${Math.round(rec.wall_ms / 1000)}s`);
          } catch (e) {
            if ((e as Error).name === 'BudgetExceededError') { failure = e; break; }
            console.error(`[t0] ${cellKey(c.t.id, c.reader, c.arm, c.r)}: harness error ${(e as Error).message}`);
            appendFileSync(join(out, 'harness-errors.jsonl'), JSON.stringify({ key: cellKey(c.t.id, c.reader, c.arm, c.r), error: (e as Error).message, at: new Date().toISOString() }) + '\n');
          }
        }
      }
    }));
    if (failure) throw failure;
  } finally {
    for (const s of slots.values()) await s.stop().catch(() => {});
    proxy.stop();
    if (budget) {
      const summary = budget.run.close();
      writeFileSync(join(out, `cost-${summary.run_id}.json`), JSON.stringify(receiptCost(summary), null, 2));
    }
    hermetic?.restore();
  }
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const errors = existsSync(join(out, 'harness-errors.jsonl')) ? readFileSync(join(out, 'harness-errors.jsonl'), 'utf8').split('\n').filter(Boolean).length : 0;
  const summary = summarize(readCells([resultsPath]));
  const detected = (arm: string) => summary.mutants.filter(m => m.arm === arm).length > 0 && summary.mutants.filter(m => m.arm === arm).every(m => m.detected);
  writeFileSync(join(out, 'receipt.json'), JSON.stringify({
    schema: 't0-receipt/v1', runner: T0_VERSION, verdict: 'report-only', gbrain_evals_head: head, finished_at: new Date().toISOString(),
    data: {
      metrics: {
        forced_drop_detected: arms.includes('mutant-forced-drop') ? detected('mutant-forced-drop') : null,
        stale_correction_detected: arms.includes('mutant-stale-correction') ? detected('mutant-stale-correction') : null,
        scored_fraction: summary.cells / Math.max(1, summary.cells + errors),
        harness_errors: errors,
      },
      summary,
    },
  }, null, 1) + '\n');
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch(e => { console.error(e instanceof Error ? e.stack ?? e.message : e); process.exit(1); });
}
