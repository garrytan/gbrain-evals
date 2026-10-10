/**
 * Cat 40 Hard: runner-side support. Prompts, sessions, oracle evidence,
 * scripted agents, refusals, stop codes, the cell runner and the H5 write
 * diagnostic. The v1 path in cat40-model-ladder.ts does not call any of it.
 *
 * Plan: docs/plans/2026-10-05-cat40-hard/PLAN.md. Operator guide:
 * docs/benchmarks/cat40-hard/RUNBOOK.md.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runAgent, provider, type AgentRun, type Arm, type ScriptedModel } from './loop.ts';
import { FsArm, MemoryArm, OracleArm, FileStore, isWriteCall, callTargets, type ToolLimits } from './arms.ts';
import { PgArm, type PgStore } from './pg-arm.ts';
import { GbrainArm, GbrainFsArm, cellLabel, type CellArm, type GbrainPool, type GbrainSlot, type MeteringProxy } from './gbrain-arm.ts';
import { scoreHardTask, HARD_SCORER_VERSION } from './score-hard.ts';
import { judgeHardClaims, type JudgeRequestLog } from './judge-hard.ts';
import { CELL_SCHEMA_V2, HARD_MAX_RETRIES, type CellRecordV2, type SessionRecord, type StrippedRun } from './records.ts';
import { CHAT_PRICE_OVERRIDES } from '../budget-ledger.ts';
import { renderDoc } from '../../generators/model-ladder-gen.ts';
import { RECORDED, HARD_SEEDS, isHardWorld, type HardTask, type HardWorld, type HardStopKind } from '../../generators/hard/schema.ts';
import { hardWorldProblems } from '../../generators/hard/validate.ts';
import { generateHardWorld, hardWorldDigest } from '../../generators/model-ladder-hard.ts';
import { generateSealedWorld } from '../../generators/hard-sealed/generate.ts';

// ─── Stop codes ─────────────────────────────────────────────────────

/**
 * Every refusal and stop-for-Garry condition of a Hard run exits 3 with one
 * of these codes (DX-F7, DX-F8). RUNBOOK.md lists each with its fix; a test
 * keeps the two in step.
 */
export const HARD_STOP_CODES = {
  HARD_JUDGE_REQUIRED: 'a Hard run needs an explicit claims judge',
  HARD_MODEL_EXCLUDED: 'gpt-5.4-mini is excluded from Hard models and judges',
  HARD_MODEL_UNPRICED: 'a model has no registered price',
  HARD_ARM_NOT_APPLICABLE: 'an arm that Hard does not use (fs-acl) was requested',
  HARD_WORLD_INVALID: 'the world fails the Hard world invariants',
  HARD_WORLD_MISMATCH: 'the world does not match its generator, or the output directory holds another world identity',
  HARD_KNOBS_NOT_FROZEN: 'a smoke or held-out world was generated with knobs other than knobs.frozen.json',
  HARD_FREEZE_DRIFT: 'frozen code changed since freeze.json was written',
  HARD_ORACLE_TOO_LARGE: 'an oracle prompt exceeds a model input limit',
  HARD_SLOTS_QUARANTINED: 'fewer healthy gbrain slots remain than the step plans',
  HARD_CELLS_INCOMPLETE: 'cells still lack a harness-clean attempt',
  HARD_RETRIES_EXHAUSTED: 'a cell hit harness errors on every allowed attempt',
  HARD_BUDGET_SHORT: 'the ledger has less left than the step projection plus 15%',
  HARD_LEDGER_ROSTER: 'a program ledger is missing or its cap differs from the roster',
  HARD_PREDECESSOR_MISSING: 'a step ran before the step it depends on',
  HARD_BUDGET_DECISION_MISSING: 'the budget decision is not recorded',
  HARD_FREEZE_RULE_FAILED: 'the calibration round fails the freeze rule',
  HARD_SMOKE_FAILED: 'the gbrain smoke had harness errors',
  HARD_PREREG_MISSING: 'the preregistration lacks a field this step needs',
  HARD_STEP_RETIRED: 'amendment A2 retired the 4k held-out steps; the held-out run is 50k only',
  HARD_ARM_EXPLORATORY: 'the exploratory gbrain-fs arm runs only on the development (calibration-seed) world, outside any program step',
} as const;
export type HardStopCode = keyof typeof HARD_STOP_CODES;

export class HardStop extends Error {
  constructor(readonly code: HardStopCode, readonly what: string, readonly fix: string, readonly decision?: string) {
    super(`${code}: ${what}`);
    this.name = 'HardStop';
  }
  render(): string {
    return [`[cat40-hard] STOP ${this.code}: ${this.what}`, `  why: ${HARD_STOP_CODES[this.code]}`, `  fix: ${this.fix}`, ...(this.decision ? [`  decision needed: ${this.decision}`] : [])].join('\n');
  }
}

// ─── Refusals ───────────────────────────────────────────────────────

export const EXCLUDED_MODELS = ['gpt-5.4-mini'];

/** Where prices are registered, for the unpriced-model refusal. */
export function priceTableLocation(): string {
  const path = join(import.meta.dir, '../budget-ledger.ts');
  const line = readFileSync(path, 'utf8').split('\n').findIndex(l => l.startsWith('export const CHAT_PRICE_OVERRIDES')) + 1;
  return `eval/runner/budget-ledger.ts:${line}`;
}

/**
 * The judge, model and arm refusals of a Hard run (CEO-F3). `scripted` runs are exempt from the judge rule.
 * `gbrain-fs` is exploratory (plan 2026-10-07-cat40-hard-fix C16): it runs only on the calibration seed, the
 * development world, and never in a program step (`--step`: calibration, freeze, smoke, held-out or confirmation).
 */
export function hardRefusals(o: { models: string[]; judge: string | undefined; arms: string[]; scripted: boolean; seed?: number; step?: string }): void {
  if (o.arms.includes('gbrain-fs') && (o.seed !== HARD_SEEDS.calibration || o.step !== undefined)) {
    throw new HardStop('HARD_ARM_EXPLORATORY', o.step !== undefined ? `--arms includes gbrain-fs in program step ${o.step}` : `--arms includes gbrain-fs on seed ${o.seed}, which is not the development world (calibration seed ${HARD_SEEDS.calibration})`,
      'run gbrain-fs only on the calibration-seed world without --step; preregistered, smoke and held-out runs use oracle, fs, pg, memory, gbrain');
  }
  if (!o.scripted && (o.judge === undefined || o.judge === 'none')) {
    throw new HardStop('HARD_JUDGE_REQUIRED', o.judge === 'none' ? '--judge none does not satisfy the Hard judge rule' : 'no --judge was given',
      'pass --judge gpt-6.1-sol (every Hard command uses it, calibration included)');
  }
  const named = [...o.models, ...(o.judge && o.judge !== 'none' ? [o.judge] : [])];
  const excluded = named.filter(m => EXCLUDED_MODELS.includes(m));
  if (excluded.length) throw new HardStop('HARD_MODEL_EXCLUDED', `${excluded.join(', ')} is in --models or --judge`, 'remove it; Hard runs only the newest frontier Opus, GPT, Sonnet and Fable models, and the judge is gpt-6.1-sol');
  if (o.scripted) return;
  const unpriced = named.filter(m => { try { return !CHAT_PRICE_OVERRIDES[`${provider(m)}:${m}`]; } catch { return true; } });
  if (unpriced.length) throw new HardStop('HARD_MODEL_UNPRICED', `no registered price for ${unpriced.join(', ')}`,
    `look up the provider's list price and add it to CHAT_PRICE_OVERRIDES at ${priceTableLocation()} (with the source and date), then rerun`);
  if (o.arms.includes('fs-acl')) throw new HardStop('HARD_ARM_NOT_APPLICABLE', '--arms includes fs-acl', 'drop fs-acl: Hard has no permissions family; use oracle,fs,pg,memory,gbrain');
}

/** Regenerators by world version; the sealed validation variant registers its own version here. */
export const HARD_WORLD_GENERATORS: Record<string, (seed: number, knobs: HardWorld['knobs'], scale: 'v1' | 'large') => HardWorld> = {
  'model-ladder-hard-v1': (seed, knobs, scale) => generateHardWorld(seed, knobs, { scale }),
  'model-ladder-hard-v2': (seed, knobs, scale) => generateHardWorld(seed, knobs, { scale }),
  'hard-sealed': (seed, knobs, scale) => generateSealedWorld(seed, knobs, scale),
  'hard-sealed-v2': (seed, knobs, scale) => generateSealedWorld(seed, knobs, scale),
};

/** Validate a Hard world and check it against its generator. */
export function checkHardWorld(world: HardWorld, worldPath: string): void {
  const problems = hardWorldProblems(world);
  if (problems.length) throw new HardStop('HARD_WORLD_INVALID', `${worldPath}: ${problems.length} problems: ${problems.join('; ')}`, 'regenerate the world with its generator; never edit a world by hand');
  const regen = HARD_WORLD_GENERATORS[world.version];
  if (!regen) throw new HardStop('HARD_WORLD_MISMATCH', `${worldPath} has version ${world.version}, which no registered generator writes`, 'register its generator in HARD_WORLD_GENERATORS (eval/runner/cat40/hard.ts), as WORLD_SCHEMA.md describes');
  const fresh = regen(world.seed, world.knobs, world.scale ?? 'v1');
  if (hardWorldDigest(fresh) !== hardWorldDigest(world)) {
    throw new HardStop('HARD_WORLD_MISMATCH', `${worldPath} does not match its generator for seed ${world.seed}, scale ${world.scale ?? 'v1'} and its recorded knobs`,
      `regenerate it: bun eval/generators/model-ladder-gen.ts --mode hard --seed ${world.seed} --knobs <the knob file>${world.scale ? ' --scale large --base-world <4k world.json>' : ''} --out <dir>`);
  }
}

/** World identity fields recorded in experiment.json; a resume must match each (DX-F7). */
export function identityOf(world: HardWorld) {
  return { seed: world.seed, scale: world.scale ?? 'v1', mode: 'hard' as const, version: world.version, knob_digest: world.knob_digest };
}

export function identityRefusal(recorded: Record<string, unknown> | undefined, now: ReturnType<typeof identityOf>, out: string): void {
  if (!recorded) return;
  for (const k of ['seed', 'scale', 'mode', 'version', 'knob_digest'] as const) {
    if (JSON.stringify(recorded[k]) !== JSON.stringify(now[k])) {
      throw new HardStop('HARD_WORLD_MISMATCH', `${out} was started on a world with ${k === 'knob_digest' ? 'knobs' : k} ${JSON.stringify(recorded[k])}; this world has ${JSON.stringify(now[k])}`,
        'repeat the original command (same --world), or give this world a new --out');
    }
  }
}

/** Worlds that must use the frozen generator: the smoke, held-out and confirmation seeds, and every sealed world (the confirmation's world S). */
export function requiresFreeze(world: HardWorld): boolean {
  return world.seed === HARD_SEEDS.smoke || world.seed === HARD_SEEDS.heldout || world.seed === HARD_SEEDS.confirmation || world.version.startsWith('hard-sealed');
}

// ─── Prompts and sessions ───────────────────────────────────────────

/** The Hard rules, identical for every arm, the oracle included (CEO-F12, ENG-F4). */
export const HARD_RULES = [
  'How to decide between documents and dates:',
  '- Authority: an executed contract or executed amendment outranks a draft amendment, which outranks an email summary, which outranks an agent note. Between two executed documents, the one with the later effective date wins. A change whose effective date is still in the future does not apply yet.',
  '- Effective dates: a change takes effect on its stated effective date, not on the date it was written or signed.',
  '- "On a date" or "as of a date" means the value in effect on that date, using every document, including documents written after that date (for example a later correction or a belated handoff note).',
  '- A correction replaces the corrected value from that value\'s effective date. Two changes with the same effective date resolve to the one recorded later.',
  '- What the user tells you in this session or an earlier session outranks documents, and a later statement outranks an earlier one.',
  '- An account may be named by its name, its account code, a former name or the name of an account merged into it; each refers to the same account.',
].join('\n');

/** Generator v2 worlds add how records refer to accounts (amendment A1). */
export const HARD_RULES_REFERENCES = '- Records may instead refer to an account by its nickname, or as "<manager>\'s <region> <industry> account", meaning the one account with that region and industry whose account manager (account owner) was that person on the record\'s date. Account sheets give each account\'s nickname, region and industry; the CRM record gives its code and first owner; handoff notes give later owner changes.';

export function hardSystemPrompt(world: HardWorld, arm: Arm): string {
  const p = world.principal;
  return [
    `You are an AI assistant working for ${p.name}, an ${p.role} at Acme Example Inc. Today is ${world.today}.`,
    'Answer using the company knowledge base available through your tools. Do not guess.',
    arm.systemHint(),
    world.references ? `${HARD_RULES}\n${HARD_RULES_REFERENCES}` : HARD_RULES,
    'When you are done, call submit_answer with the value only in `answer`, the ids or paths of the documents you relied on in `sources`, and any caveats in `notes`. Write dates as YYYY-MM-DD.',
    'If the knowledge base does not contain the answer, answer UNKNOWN.',
  ].join('\n\n');
}

/** Oracle evidence: the task's deciding documents, plus synthesized notes (H5: the ideal store after sessions 1 to 4). */
export function hardOracleEvidence(world: HardWorld, task: HardTask): string {
  const byId = new Map(world.docs.map(d => [d.id, d]));
  const parts = task.relevant.map(id => `<document id="${id}">\n${renderDoc(byId.get(id)!)}</document>`);
  for (const n of task.oracle_notes ?? []) parts.push(`<document id="${n.id}">\n---\ntitle: ${JSON.stringify(n.title)}\ntype: note\ndate: ${world.today}\nauthor: ${JSON.stringify(world.principal.name)}\n---\n${n.body}\n</document>`);
  return parts.join('\n\n');
}

/** User messages of a cell, in order. The oracle runs only the final session (CEO-F13). */
export function hardSessions(world: HardWorld, task: HardTask, armName: string): string[] {
  const final = armName === 'oracle' ? `${task.question}\n\nRelevant documents:\n\n${hardOracleEvidence(world, task)}` : task.question;
  return armName === 'oracle' ? [final] : [...(task.sessions ?? []), final];
}

/** A conservative input limit per model family, for the oracle token preflight (ENG-F7). Estimated as characters / 3.5. */
export const MODEL_INPUT_TOKENS: Array<[RegExp, number]> = [[/^claude-/, 200_000], [/^gpt-/, 272_000]];

export function oracleOversize(world: HardWorld, tasks: HardTask[], models: string[]): Array<{ task: string; model: string; tokens: number; limit: number }> {
  const out: Array<{ task: string; model: string; tokens: number; limit: number }> = [];
  for (const t of tasks) {
    const tokens = Math.ceil((hardSessions(world, t, 'oracle')[0].length + 4000) / 3.5);
    for (const m of models) {
      const limit = MODEL_INPUT_TOKENS.find(([re]) => re.test(m))?.[1] ?? 200_000;
      if (tokens > limit) out.push({ task: t.id, model: m, tokens, limit });
    }
  }
  return out;
}

// ─── Scripted agent ($0 plumbing check) ─────────────────────────────

/**
 * Hermetic scripted agent for Hard. Recording sessions save the statement as
 * a note and submit RECORDED; the final session looks once and submits an
 * empty set, 0 or UNKNOWN. The scripted oracle submits the answer key, so the
 * success path through the scorer is exercised. It proves plumbing, not quality.
 */
export function scriptedHardAgent(task: HardTask, armName: string, session: number, total: number): ScriptedModel {
  const recording = session < total - 1;
  const gold = task.answer_kind === 'set' ? JSON.stringify((task.gold.members ?? []).map(m => m.names[0])) : task.answer_kind === 'count' ? String(task.gold.count)
    : task.answer_kind === 'values' ? JSON.stringify(task.gold.items!.map(it => it.answer[0])) : task.gold.answer![0];
  const blank = task.answer_kind === 'set' || task.answer_kind === 'values' ? '[]' : task.answer_kind === 'count' ? '0' : 'UNKNOWN';
  return history => {
    if (armName === 'oracle') return { name: 'submit_answer', args: { answer: gold, sources: task.gold.evidence } };
    if (history.length === 0) {
      if (recording) {
        const text = task.sessions![session];
        if (armName === 'gbrain-fs') return { name: 'put_page', args: { slug: `notes/session-${session + 1}`, content: text } };
        return armName === 'memory' ? { name: 'memory', args: { command: 'create', path: `/memories/notes/session-${session + 1}.md`, file_text: text } } : { name: 'write_file', args: { path: `notes/session-${session + 1}.md`, content: text } };
      }
      return armName === 'memory' ? { name: 'memory', args: { command: 'view', path: '/memories/notes' } } : { name: 'list_dir', args: { path: 'notes' } };
    }
    return { name: 'submit_answer', args: { answer: recording ? RECORDED : blank, sources: [] } };
  };
}

// ─── Write diagnostic (CEO-F24) ─────────────────────────────────────

export interface WriteDiagnostic { session: number; key: string; value: string; required: boolean; superseded_by?: number; outcome: 'saved' | 'updated' | 'lost' | 'saved_then_kept_stale' }

/**
 * Whether each recording session's fact reached the store, from the write
 * calls' arguments (captured before any restore). Reported, never scored.
 *   saved     the session wrote the value
 *   updated   a superseded fact was saved and the superseding value was written later
 *   saved_then_kept_stale  a superseded fact was saved but the superseding value never was
 *   lost      the session did not write the value
 */
export function writeDiagnostic(task: HardTask, sessions: Array<{ tools: AgentRun['tools'] }>, isWrite: (name: string, args: Record<string, unknown>) => boolean): WriteDiagnostic[] {
  const written = sessions.map(s => s.tools.filter(t => isWrite(t.name, t.args)).map(t => JSON.stringify(t.args)).join('\n'));
  return (task.session_facts ?? []).map(f => {
    const savedIn = (v: string, from: number) => written.slice(from).some(w => w.includes(v));
    const saved = (written[f.session - 1] ?? '').includes(f.value);
    if (!saved) return { ...f, outcome: 'lost' };
    if (f.superseded_by === undefined) return { ...f, outcome: 'saved' };
    const next = task.session_facts!.find(x => x.session === f.superseded_by && x.key === f.key)!;
    return { ...f, outcome: savedIn(next.value, f.superseded_by - 1) ? 'updated' : 'saved_then_kept_stale' };
  });
}

// ─── Cell runner ────────────────────────────────────────────────────

export interface HardCtx {
  world: HardWorld;
  worldDigest: string;
  files: { all: Map<string, string> };
  pg?: PgStore;
  pool?: GbrainPool;
  proxy?: MeteringProxy;
  scripted: boolean;
  judge: string | null;
  gbrainLabel: string;
  maxToolChars: number | null;
  maxTurns: number;
  toolLimits: ToolLimits;
  budgetRunId: string | null;
  /** Persist one judge request (for re-judging without rerunning the agent). */
  logJudge: (entry: JudgeRequestLog) => void;
}

function strip(r: AgentRun): StrippedRun {
  const { tools, ...rest } = r;
  return { ...rest, stop: r.stop as HardStopKind, tool_calls: tools.map(t => ({ name: t.name, ms: t.ms, chars: t.chars, truncated: t.truncated, ...(t.error ? { error: t.error } : {}) })) };
}

/** Tool calls with results per attempt, for --transcripts. */
export const hardTranscripts = new Map<string, Array<{ session: number; name: string; args: Record<string, unknown>; result: string }>>();

export async function runHardCell(ctx: HardCtx, model: string, armName: CellArm, task: HardTask, repeat: number, attempt: number): Promise<CellRecordV2 & { write_diagnostic?: WriteDiagnostic[] }> {
  const started = new Date();
  const label = cellLabel(armName, ctx.gbrainLabel);
  const key = `${model}|${label}|${task.id}|${repeat}`;
  const attemptId = `${key}#${attempt}`;
  const timings = { queue_ms: 0, session_start_ms: 0, agent_ms: 0, restore_ms: 0, judge_ms: 0 };
  let arm: Arm;
  let slot: GbrainSlot | null = null;
  const q0 = Date.now();
  if (armName === 'fs') arm = new FsArm('fs', new FileStore(ctx.files.all), { limits: ctx.toolLimits });
  else if (armName === 'memory') arm = new MemoryArm(new FileStore(ctx.files.all));
  else if (armName === 'oracle') arm = new OracleArm();
  else if (armName === 'pg') arm = new PgArm(ctx.pg!, attemptId, { limits: ctx.toolLimits });
  else if (armName === 'gbrain' || armName === 'gbrain-fs') {
    slot = await ctx.pool!.acquire();
    timings.queue_ms = Date.now() - q0;
    ctx.proxy!.bind(slot.id, attemptId);
    arm = armName === 'gbrain' ? new GbrainArm(slot) : new GbrainFsArm(slot, new FileStore(ctx.files.all), { limits: ctx.toolLimits });
  } else throw new HardStop('HARD_ARM_NOT_APPLICABLE', `arm ${armName}`, 'use oracle,fs,pg,memory,gbrain');
  const messages = hardSessions(ctx.world, task, armName);
  const runs: AgentRun[] = [];
  const sessions: SessionRecord[] = [];
  let embedUsd = 0;
  let failure: { stop: HardStopKind; error: string } | null = null;
  try {
    for (let k = 0; k < messages.length; k++) {
      if (k > 0 && slot) { const t = Date.now(); await slot.newSession(); timings.session_start_ms += Date.now() - t; }
      const run = await runAgent({
        model, arm, system: hardSystemPrompt(ctx.world, arm), user: messages[k], maxTurns: ctx.maxTurns, maxToolChars: ctx.maxToolChars, classifyStops: true,
        scripted: ctx.scripted ? scriptedHardAgent(task, armName, armName === 'oracle' ? 0 : k, messages.length) : undefined,
      });
      timings.agent_ms += run.ms;
      const e = (arm as { takeEmbedUsage?: () => { usd: number } }).takeEmbedUsage?.().usd ?? 0;
      embedUsd += e;
      runs.push(run);
      sessions.push({ index: k + 1, role: k < messages.length - 1 ? 'record' : 'question', stop: run.stop as HardStopKind, run: strip(run), usd: run.usd,
        writes: run.tools.filter(t => isWriteCall(arm, t.name, t.args)).flatMap(t => callTargets(t.name, t.args)) });
      if (run.stop === 'harness_error') { failure = { stop: 'harness_error', error: `session ${k + 1}: ${run.error}` }; break; }
      if (run.stop === 'error' && !failure) failure = { stop: 'error', error: `session ${k + 1}: ${run.error}` };
    }
  } catch (e) {
    if ((e as Error).name === 'BudgetExceededError' || (e as Error).name === 'SlotQuarantineError') throw e;
    failure = { stop: 'harness_error', error: `session ${sessions.length + 1}: ${(e as Error).message}` };
  } finally {
    if (slot) {
      const t = Date.now();
      try { await ctx.pool!.restoreOrQuarantine(slot); }
      finally { timings.restore_ms = Date.now() - t; ctx.proxy!.unbind(slot.id, attemptId); }
    }
  }
  hardTranscripts.set(attemptId, runs.flatMap((r, k) => r.tools.map(t => ({ session: k + 1, name: t.name, args: t.args, result: t.result.slice(0, 40_000) }))));
  const isWrite = (name: string, args: Record<string, unknown>) => isWriteCall(arm, name, args);
  const wrote = runs.some(r => r.tools.some(t => isWrite(t.name, t.args)));
  const scored = runs.length === messages.length ? scoreHardTask(ctx.world, task, runs, { wrote }) : scoreHardTask(ctx.world, task, [{ final: null, stop: 'harness_error' } as unknown as AgentRun], { wrote });
  const stop: HardStopKind = failure?.stop ?? (runs.at(-1)!.stop as HardStopKind);
  const score = stop === 'error' || stop === 'harness_error' ? { ...scored, success: false } : scored;
  let claims: CellRecordV2['claims'] = null, judgeUsd = 0, judgeError: string | undefined;
  if (stop !== 'harness_error' && ctx.judge && !ctx.scripted) {
    const t = Date.now();
    try {
      const j = await judgeHardClaims(ctx.world, task, runs.at(-1)!, ctx.judge, entry => ctx.logJudge({ ...entry, key, attempt_id: attemptId }));
      claims = j.claims; judgeUsd = j.usd; judgeError = j.error;
    } catch (e) {
      if ((e as Error).name === 'BudgetExceededError') throw e;
      judgeError = (e as Error).message;
    }
    timings.judge_ms = Date.now() - t;
  }
  const gbrain_internal = slot ? await ctx.proxy!.finalize(attemptId) : undefined;
  const agentUsd = runs.reduce((s, r) => s + r.usd, 0);
  const rec: CellRecordV2 & { write_diagnostic?: WriteDiagnostic[] } = {
    schema: CELL_SCHEMA_V2, key, attempt_id: attemptId, attempt, model, provider: ctx.scripted ? 'scripted' : provider(model), arm: label, task: task.id, family: task.family, variant: task.variant, repeat,
    stop, ...(failure ? { error: failure.error } : {}), score, claims, ...(judgeError ? { judge_error: judgeError } : {}),
    sessions, run: sessions.at(-1)?.run ?? strip({ model, final: null, stop: 'harness_error', turns: 0, tools: [], usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, requests: 0 }, usd: 0, ms: 0, model_ms: 0, tool_ms: 0 }),
    ...(gbrain_internal ? { gbrain_internal } : {}),
    cost: { agent_usd: agentUsd, embed_usd: embedUsd, gbrain_usd: gbrain_internal?.usd ?? 0, judge_usd: judgeUsd },
    total_usd: agentUsd + embedUsd + (gbrain_internal?.usd ?? 0), judge_usd: judgeUsd, timings, ...(slot ? { restore_ms: timings.restore_ms } : {}),
    budget_run_id: ctx.budgetRunId,
    experiment: { world_digest: ctx.worldDigest, scale: ctx.world.scale ?? 'v1', max_turns: ctx.maxTurns, tool_limits: ctx.toolLimits, judge: ctx.judge },
    wall_ms: Date.now() - started.getTime(), started_at: started.toISOString(),
    ...(task.family === 'H5' && armName !== 'oracle' ? { write_diagnostic: writeDiagnostic(task, runs, isWrite) } : {}),
  };
  return rec;
}

/**
 * Run a cell until it has a harness-clean attempt, retrying only
 * `harness_error`, at most HARD_MAX_RETRIES times over the cell's life
 * (`prior` attempts already recorded count). Every attempt goes to
 * `onAttempt`; the clean one is returned, or null when the retries are spent.
 */
export async function runWithRetries(prior: number, runOnce: (attempt: number) => Promise<CellRecordV2>, onAttempt: (rec: CellRecordV2) => void): Promise<CellRecordV2 | null> {
  for (let attempt = prior + 1; attempt <= 1 + HARD_MAX_RETRIES; attempt++) {
    const rec = await runOnce(attempt);
    onAttempt(rec);
    if (rec.stop !== 'harness_error') return rec;
  }
  return null;
}

// ─── Freeze and identity hashes ─────────────────────────────────────

/** Code whose behavior the freeze covers (ENG-F6): generator, knobs schema, prompts and sessions, tools, scorer, judge. */
export const FROZEN_FILES = [
  'eval/generators/model-ladder-hard.ts', 'eval/generators/hard/schema.ts', 'eval/generators/hard/semantics.ts', 'eval/generators/hard/render.ts', 'eval/generators/hard/rng.ts', 'eval/generators/hard/validate.ts',
  'eval/runner/cat40/hard.ts', 'eval/runner/cat40/score-hard.ts', 'eval/runner/cat40/judge-hard.ts', 'eval/runner/cat40/score.ts', 'eval/runner/cat40/loop.ts',
  'eval/runner/cat40/arms.ts', 'eval/runner/cat40/hard-grep.ts', 'eval/runner/cat40/hard-grep-worker.ts', 'eval/runner/cat40/pg-arm.ts',
];

export function codeHashes(root: string): Record<string, string> {
  return Object.fromEntries(FROZEN_FILES.map(f => [f, existsSync(join(root, f)) ? createHash('sha256').update(readFileSync(join(root, f))).digest('hex') : 'missing']));
}

/** The settings that change behavior beside the code: knobs, turn cap, tool limits, judge, scorer version. */
export function settingsDigest(o: { knob_digest: string; max_turns: number; tool_limits: ToolLimits; judge: string | null }): string {
  return createHash('sha256').update(JSON.stringify({ ...o, scorer: HARD_SCORER_VERSION })).digest('hex');
}

export { isHardWorld };
