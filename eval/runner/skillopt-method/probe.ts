/**
 * A1 headroom probe for the SkillOpt method benchmark (GST-799, plan decision
 * A; revision 3, decision A3: frontier targets).
 *
 * Before any optimizer adapter is built, measure whether gbrain's shipped
 * skills leave room for an optimizer to show anything. The probe reads
 * skillopt-method-v2's selection split (train too for the one-shot); the test
 * split is never read.
 *
 * Frontier probe (the default), per target (`opus`: claude-opus-5-5, `sol`:
 * gpt-6.1-sol), in two stages:
 *
 *   F0a  no skill (a one-line neutral prompt) at 1 run per task, and the
 *        shipped SKILL.md at 3 runs per task
 *   F0b  only for skills whose F0a seed is in [0.20, 0.80], read from F0a's
 *        receipt: the harness one-shot (one-shot.ts) with 2 repeats from one
 *        set of seed trajectories on train. Each rewrite is audited
 *        (audit.ts) before it is scored; a disqualified rewrite is recorded
 *        and not scored. A clean one is scored on selection at 3 runs per task
 *        and kept only if it beats the seed.
 *
 * `frontierGate` reads each target alone, after F0b (after F0a only when no
 * pair is in band): build (two or more skills qualify),
 * build-one-skill (exactly one), stop (every in-band skill fails only on the
 * one-shot ceiling), out-of-band (no skill in band) or incomplete (a pair that
 * should have run did not). A skill qualifies when its seed is in [0.20, 0.80]
 * and its kept one-shot is at least 0.15 below the solvability ceiling (1.00
 * on v2). A stop resting on a skill with a tool gap waits for its rerun (rule
 * 4). `countedSkills` picks at most two skills per target for the counted
 * study.
 *
 * Every pair is metered (rollouts.ts): mean cost per rollout, calls per
 * rollout, the cached share of input tokens and reasoning tokens. When a
 * pair's mean rollout cost passes `REPRICE_TRIGGER_USD`, the stage stops after
 * that pair and keeps it; the result records the trigger (reason
 * `reprice-trigger`) and marks each pair it did not run `reprice-trigger`.
 *
 * Retrieval is keyword only on both targets: the brain's `embedding_disabled`
 * is set (gbrain's own keyless-by-choice switch) and the gateway's embedding
 * model is Google's, whose key is never in the process, so the OpenAI key a
 * Sol run holds can never embed. Query expansion is off, so its default
 * model (claude-haiku-4-5) never runs. A live run records the settings gbrain
 * sends each target (`observeModelRequests`): at the pin, Sol gets no
 * `reasoning` field (OpenAI's default effort) and `max_output_tokens` 4096;
 * Opus gets `max_tokens` 32000 and no `thinking` field.
 *
 * `runSmoke` runs the seed once on one train task per target, so a live run
 * shows gbrain at the pin driving each target with tools before the probe.
 *
 * Historical: `runProbe` is the Haiku 5.5 probe (probes 1 and 2: gbrain's
 * `runSkillOpt` one-shot, the seed on Opus as a fifth arm, `probeGate` with
 * harden-and-reprobe), kept so both stay reproducible. Haiku is no longer a
 * target.
 *
 * Run it through the category runner: `bun eval/runner/n15-skillopt-method.ts
 * --probe --target opus|sol --stage f0a|f0b [--from <F0a receipt>] --paid
 * --budget-run-id <id>`. `fake: true` runs the same path end to end on a
 * deterministic in-process chat transport, keyless.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import { importFromContent } from 'gbrain/import-file';
import { configureGateway, __setChatTransportForTests, type ChatOpts, type ChatResult } from 'gbrain/ai/gateway';
import { runSkillOpt, type BenchmarkTask } from 'gbrain/core/skillopt';
import { operations } from 'gbrain/operations';
import { READ_ONLY_BRAIN_TOOLS } from '../../../node_modules/gbrain/src/core/skillopt/rollout.ts';
import { loadCorpora, type MethodTask } from '../../generators/skillopt-method/common.ts';
import { auditSkill, type AuditResult } from './audit.ts';
import { datasetName, DEFAULT_DATASET, frontmatterTools, readCriteria, readSeed, readTasks, type DatasetVersion } from './dataset.ts';
import { forbiddenMarkers, ONE_SHOT_SYSTEM, PROPOSER_MODEL, proposeRewrite, proposerInput, seedOnTrain, trainPages } from './one-shot.ts';
import { emptyMeter, scoreArm, summarizeMeter, type ArmScore, type MeterSummary } from './rollouts.ts';
import { evaluateJudge, SKILLS, type SkillName, type Trajectory } from './score.ts';

export type { ArmScore } from './rollouts.ts';

// ─── Models, runs and prices ─────────────────────────────────────────────────

export const FRONTIER_TARGETS = {
  opus: 'anthropic:claude-opus-5-5',
  sol: 'openai:gpt-6.1-sol',
} as const;
export type FrontierTarget = keyof typeof FRONTIER_TARGETS;
export const FRONTIER_TARGET_NAMES = Object.keys(FRONTIER_TARGETS) as FrontierTarget[];
/** The one chat key a target's rollouts need; the F0b proposer adds ANTHROPIC_API_KEY. */
export const TARGET_KEY: Readonly<Record<FrontierTarget, string>> = { opus: 'ANTHROPIC_API_KEY', sol: 'OPENAI_API_KEY' };
export const PROBE_STAGES = ['f0a', 'f0b'] as const;
export type ProbeStage = typeof PROBE_STAGES[number];
export const FRONTIER_RUNS = { no_skill: 1, seed: 3, train: 1, rewrite: 3 } as const;
export const FRONTIER_REWRITE_REPEATS = 2;
export const FRONTIER_ROLLOUTS_PER_PAIR: Readonly<Record<ProbeStage, number>> = {
  f0a: 24 * FRONTIER_RUNS.no_skill + 24 * FRONTIER_RUNS.seed,
  f0b: 24 * FRONTIER_RUNS.train + FRONTIER_REWRITE_REPEATS * 24 * FRONTIER_RUNS.rewrite,
};
/**
 * Planning prices and stage totals from plan revision 3, "Measured prices" and
 * decision A3 (handoffs/skillopt-bench/skillopt-method-plan-r3.md in the
 * GBrain-Evals Minder drive): an Opus 5.5 rollout at $0.26 (probes 1 and 2
 * metered $0.157 on query and $0.358 on briefing), a Sol rollout at $0.15
 * (half of Opus's list prices; unmeasured until the smoke) and an Opus
 * proposer call at $0.29. For three skills on both targets, F0a is about $118
 * and F0b at most $209.
 */
export const FRONTIER_PRICES_USD = { rollout: { opus: 0.26, sol: 0.15 }, proposer_call: 0.29 } as const;
export const FRONTIER_STAGE_ESTIMATE_USD: Readonly<Record<ProbeStage, number>> = { f0a: 118, f0b: 209 };
/** Plan revision 3 (decision A3, review correction 2): a pair whose mean rollout cost passes this stops its stage for a reprice. */
export const REPRICE_TRIGGER_USD: Readonly<Record<FrontierTarget, number>> = { opus: 0.40, sol: 0.20 };

const pairUsd = (target: FrontierTarget, stage: ProbeStage) =>
  FRONTIER_ROLLOUTS_PER_PAIR[stage] * FRONTIER_PRICES_USD.rollout[target] + (stage === 'f0b' ? FRONTIER_REWRITE_REPEATS * FRONTIER_PRICES_USD.proposer_call : 0);

/** A run's estimate: its pairs' share of the plan's stage total, split between the targets by the planning prices. */
export function frontierEstimateUsd(target: FrontierTarget, stage: ProbeStage, skills: number): number {
  const all = SKILLS.length * FRONTIER_TARGET_NAMES.reduce((n, t) => n + pairUsd(t, stage), 0);
  return FRONTIER_STAGE_ESTIMATE_USD[stage] * skills * pairUsd(target, stage) / all;
}
/** The smoke: one seed rollout per target. */
export const SMOKE_ESTIMATE_USD = FRONTIER_PRICES_USD.rollout.opus + FRONTIER_PRICES_USD.rollout.sol;

/** Historical (probes 1 and 2): the Haiku 5.5 target, kept so those probes stay reproducible. */
export const HISTORICAL_PROBE_MODELS = {
  target: 'anthropic:claude-haiku-5-5',
  proposer: PROPOSER_MODEL,
  frontier: FRONTIER_TARGETS.opus,
} as const;
export const PROBE_RUNS_PER_TASK = 3;
export const PROBE_FRONTIER_RUNS_PER_TASK = 1;
export const PROBE_REWRITE_REPEATS = 2;
export const PROBE_REWRITE_SPLIT: [number, number, number] = [1, 22, 1];
/**
 * Historical probe, three skills, at measured prices: probe 1 spent $19.82 on
 * all but fact-check's second rewrite and its Opus seed arm, $12.13 of it on
 * Opus rollouts that read long pages (PREREGISTRATION.md, amendment 1).
 */
export const PROBE_ESTIMATE_USD = 28;
/** Per one-shot repeat, passed to runSkillOpt as its own cap; the budget ledger enforces the probe total. */
export const PROBE_REWRITE_MAX_COST_USD = 3;
export const PROBE_REFLECT_MAX_TOKENS = 16_000;
export const PROBE_GATE = { seedLow: 0.2, seedHigh: 0.8, minRoomBelowCeiling: 0.15, minSkills: 2 } as const;
/** CLAUDE.md "Choose models": a run with no particle: route names particle-1 and why. */
export const MODELS_NOT_RUN = [
  { model: 'particle:particle-1', reason: 'the rollout runs through gbrain\'s gateway, which has no Particle recipe at the pinned gbrain (GBRA-268, plan decision D); particle-1 joins as a target once that recipe reaches the pin, under a crew paid window' },
] as const;
/** The no-skill control's whole system prompt. */
export const NO_SKILL_TEXT = 'You have read-only tools over the user\'s brain, a knowledge base of their pages. Complete the task.';
/**
 * Pinned before any rollout: no reranker and no query expansion (whose
 * default model is claude-haiku-4-5), and embeddings off by choice, so search
 * is keyword only whatever keys the process holds.
 */
export const PINNED_SEARCH_CONFIG: Readonly<Record<string, string>> = {
  'search.mode': 'balanced',
  'search.reranker.enabled': 'false',
  'search.expansion': 'false',
  embedding_disabled: 'true',
};
/** The gateway's embedding model: a provider whose key (GOOGLE_GENERATIVE_AI_API_KEY) the probe never puts in the process. */
export const PROBE_EMBEDDING = { model: 'google:gemini-embedding-001', dimensions: 1536 } as const;
export const RETRIEVAL = 'keyword only: pages imported with noEmbed, embedding_disabled set on the brain, the gateway\'s embedding model on a provider whose key is not in the process; reranker and query expansion off';

// ─── Tool coverage (keyless) ─────────────────────────────────────────────────

/** The brain operations a SkillOpt rollout serves to the target model at the installed gbrain. */
export function servedTools(): string[] {
  return operations.filter(op => READ_ONLY_BRAIN_TOOLS.has(op.name) && !op.mutating && !op.localOnly).map(op => op.name).sort();
}

export interface ToolCoverage { skill: SkillName; declared: string[]; missing: string[]; outside_brain: string[]; full: boolean }

/**
 * Each seed's frontmatter tools that are gbrain operations the rollout does not
 * serve: a harness limit the probe reports, and the gaps a stop must wait on.
 * Tools that are not gbrain operations (fact-check's web lane) are listed as
 * `outside_brain`: no gbrain rollout can serve them and no task needs them.
 */
export function toolCoverage(skills: readonly SkillName[] = SKILLS): ToolCoverage[] {
  const served = new Set(servedTools());
  const brainOps = new Set(operations.map(op => op.name));
  return skills.map(skill => {
    const declared = frontmatterTools(readSeed(skill));
    const missing = declared.filter(t => brainOps.has(t) && !served.has(t));
    const outside_brain = declared.filter(t => !brainOps.has(t));
    return { skill, declared, missing, outside_brain, full: missing.length === 0 };
  });
}

// ─── Gates ───────────────────────────────────────────────────────────────────

export interface SkillProbe {
  skill: SkillName;
  /** Share of selection tasks whose solvability control passes the scorer. */
  ceiling: number;
  no_skill: number | null;
  seed: number | null;
  /** Each repeat's rewrite scored on selection; null when the repeat produced no candidate or errored. */
  one_shot_repeats: Array<number | null>;
  /** The best repeat that beat the seed, else the seed's score. */
  one_shot_kept: number | null;
  seed_opus: number | null;
  tool_gaps: string[];
}

export type ProbeVerdict = 'build' | 'harden-and-reprobe' | 'stop' | 'out-of-band' | 'incomplete';

export interface GateResult {
  verdict: ProbeVerdict;
  qualifying: SkillName[];
  reasons: Record<string, string[]>;
  /** Skills with a tool gap a stop would rest on; the stop waits for their rerun once the rollout serves those tools. */
  waits_for_rerun: SkillName[];
}

/**
 * Historical: the A1 gate as probes 1 and 2 read it. `afterHardening` marks
 * the second probe, after the tasks were hardened once because one-shot
 * reached the ceiling.
 */
export function probeGate(rows: readonly SkillProbe[], opts: { afterHardening?: boolean } = {}): GateResult {
  const reasons: Record<string, string[]> = {};
  const qualifying: SkillName[] = [];
  for (const r of rows) {
    const why: string[] = [];
    if (r.seed === null || r.one_shot_kept === null) why.push('incomplete');
    else {
      if (r.seed < PROBE_GATE.seedLow) why.push('seed-below-band');
      if (r.seed > PROBE_GATE.seedHigh) why.push('seed-above-band');
      if (r.ceiling - r.one_shot_kept < PROBE_GATE.minRoomBelowCeiling) why.push('one-shot-at-ceiling');
    }
    reasons[r.skill] = why;
    if (!why.length) qualifying.push(r.skill);
  }
  if (qualifying.length >= PROBE_GATE.minSkills) return { verdict: 'build', qualifying, reasons, waits_for_rerun: [] };
  const failing = rows.filter(r => reasons[r.skill]!.length);
  if (failing.some(r => reasons[r.skill]!.includes('incomplete'))) return { verdict: 'incomplete', qualifying, reasons, waits_for_rerun: [] };
  const atCeiling = failing.filter(r => reasons[r.skill]!.includes('one-shot-at-ceiling'));
  if (!atCeiling.length) return { verdict: 'out-of-band', qualifying, reasons, waits_for_rerun: [] };
  if (!opts.afterHardening) return { verdict: 'harden-and-reprobe', qualifying, reasons, waits_for_rerun: [] };
  return { verdict: 'stop', qualifying, reasons, waits_for_rerun: atCeiling.filter(r => r.tool_gaps.length).map(r => r.skill) };
}

/** What the frontier gate reads of a pair. */
export interface FrontierRow { skill: SkillName; ceiling: number; seed: number | null; one_shot_kept: number | null; tool_gaps: string[] }

export type FrontierVerdict = 'build' | 'build-one-skill' | 'stop' | 'out-of-band' | 'incomplete';
export interface FrontierGateResult { verdict: FrontierVerdict; qualifying: SkillName[]; reasons: Record<string, string[]>; waits_for_rerun: SkillName[] }

/** A seed outside [0.20, 0.80] cannot qualify, so F0b skips its pair and it never needs a one-shot. */
export function seedBand(seed: number): 'seed-below-band' | 'seed-above-band' | null {
  return seed < PROBE_GATE.seedLow ? 'seed-below-band' : seed > PROBE_GATE.seedHigh ? 'seed-above-band' : null;
}

/** Decision A3's gate for one target (see the header). Each skill gets one reason, or none when it qualifies. */
export function frontierGate(rows: readonly FrontierRow[]): FrontierGateResult {
  const reasons: Record<string, string[]> = {};
  for (const r of rows) {
    const band = r.seed === null ? null : seedBand(r.seed);
    reasons[r.skill] = r.seed === null ? ['incomplete']
      : band ? [band]
      : r.one_shot_kept === null ? ['incomplete']
      : r.ceiling - r.one_shot_kept < PROBE_GATE.minRoomBelowCeiling ? ['one-shot-at-ceiling'] : [];
  }
  const qualifying = rows.filter(r => !reasons[r.skill]!.length).map(r => r.skill);
  const result = (verdict: FrontierVerdict, waits_for_rerun: SkillName[] = []): FrontierGateResult => ({ verdict, qualifying, reasons, waits_for_rerun });
  if (qualifying.length >= PROBE_GATE.minSkills) return result('build');
  if (rows.some(r => reasons[r.skill]![0] === 'incomplete')) return result('incomplete');
  if (qualifying.length === 1) return result('build-one-skill');
  const inBand = rows.filter(r => reasons[r.skill]![0] === 'one-shot-at-ceiling');
  if (inBand.length) return result('stop', inBand.filter(r => r.tool_gaps.length).map(r => r.skill));
  return result('out-of-band');
}

export interface CountedSkills {
  /** Every skill that qualifies on a target read: those qualifying on both targets first, then by mean room below the ceiling. */
  order: SkillName[];
  /** At most two skills per target, in that order. */
  per_target: Partial<Record<FrontierTarget, SkillName[]>>;
  targets_read: FrontierTarget[];
}

/**
 * The counted study's skills. Skills that qualify on both targets come first;
 * ties and the rest go by the larger mean headroom (ceiling, 1.00 on v2, minus
 * the kept one-shot) over the targets where the skill qualifies; each target
 * takes at most two.
 */
export function countedSkills(byTarget: Partial<Record<FrontierTarget, readonly FrontierRow[]>>): CountedSkills {
  const targets = FRONTIER_TARGET_NAMES.filter(t => byTarget[t]);
  const qualifies = new Map(targets.map(t => [t, new Set(frontierGate(byTarget[t]!).qualifying)]));
  const room = (t: FrontierTarget, s: SkillName) => { const r = byTarget[t]!.find(x => x.skill === s)!; return r.ceiling - r.one_shot_kept!; };
  const ranked = SKILLS.map(s => {
    const where = targets.filter(t => qualifies.get(t)!.has(s));
    return { s, both: where.length === FRONTIER_TARGET_NAMES.length, headroom: where.length ? where.reduce((n, t) => n + room(t, s), 0) / where.length : -1 };
  }).filter(x => x.headroom >= 0);
  const order = ranked.sort((a, b) => Number(b.both) - Number(a.both) || b.headroom - a.headroom || SKILLS.indexOf(a.s) - SKILLS.indexOf(b.s)).map(x => x.s);
  return { order, per_target: Object.fromEntries(targets.map(t => [t, order.filter(s => qualifies.get(t)!.has(s)).slice(0, 2)])), targets_read: targets };
}

// ─── Fake transport (keyless end-to-end) ─────────────────────────────────────

export type ChatTransport = (opts: ChatOpts) => Promise<ChatResult>;
export const FAKE_REWRITE_MARKER = '<!-- n15 fake one-shot rewrite -->';

export function lastUserText(opts: ChatOpts): string {
  const last = [...opts.messages].reverse().find(m => m.role === 'user');
  if (!last) return '';
  if (typeof last.content === 'string') return last.content;
  return (last.content as unknown[]).map(b => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : '')).join('\n');
}

/** A text reply in the gateway's shape, with the usage a test sets. */
export function fakeReply(opts: ChatOpts, text: string, usage: Partial<ChatResult['usage']> = {}): ChatResult {
  return {
    text, blocks: [{ type: 'text', text }] as ChatResult['blocks'], stopReason: 'end',
    usage: { input_tokens: 40, output_tokens: 40, cache_read_tokens: 0, cache_creation_tokens: 0, ...usage },
    model: opts.model ?? 'fake:model', providerId: 'fake',
  } as ChatResult;
}

/**
 * Deterministic stand-in for every model the probe calls. A proposer (gbrain's
 * optimizer or the harness one-shot) returns a body carrying
 * FAKE_REWRITE_MARKER; the target answers with the task's solvability-control
 * answer when its system prompt carries the marker, answers half the tasks
 * that way under the seed (task ids ending in an even digit), and says "I
 * don't know" otherwise. It never calls a tool.
 */
export function fakeTransport(tasks: readonly MethodTask[]): ChatTransport {
  return async opts => {
    const system = opts.system ?? '';
    if (system.includes("SkillOpt's optimizer") || system === ONE_SHOT_SYSTEM) return fakeReply(opts, `# Rewritten skill\n\n${FAKE_REWRITE_MARKER}\n\nAnswer from the brain and cite the page that holds the answer.`);
    const user = lastUserText(opts);
    const task = tasks.find(t => user.includes(t.task));
    if (!task) return fakeReply(opts, "I don't know.");
    if (system.includes(FAKE_REWRITE_MARKER)) return fakeReply(opts, task.oracle_answer);
    if (system.includes(NO_SKILL_TEXT)) return fakeReply(opts, "I don't know.");
    return fakeReply(opts, Number(task.task_id.slice(-1)) % 2 === 0 ? task.oracle_answer : "I don't know.");
  };
}

// ─── Brain, gateway and request settings ─────────────────────────────────────

const sha8 = (s: string) => new Bun.CryptoHasher('sha256').update(s).digest('hex').slice(0, 8);
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function configureProbeGateway(chatModel: string): void {
  configureGateway({ embedding_model: PROBE_EMBEDDING.model, embedding_dimensions: PROBE_EMBEDDING.dimensions, chat_model: chatModel, env: process.env as Record<string, string | undefined> });
}

/** The rollout brain: both corpora imported without embeddings, under PINNED_SEARCH_CONFIG. The caller disconnects it. */
export async function openBrain(): Promise<PGLiteEngine> {
  configureProbeGateway(FRONTIER_TARGETS.opus);
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const [key, value] of Object.entries(PINNED_SEARCH_CONFIG)) await engine.setConfig(key, value);
  for (const [slug, content] of loadCorpora().pages) await importFromContent(engine, slug, content, { noEmbed: true });
  return engine;
}

/**
 * Run `fn` with the gateway pointed at `chatModel` and OpenAI model discovery
 * off. A fake run installs its transport and puts a dummy value in each of
 * `keys` the process lacks, so the fake sees the environment a live run has
 * (a Sol run holds an OpenAI key); everything is undone afterwards. A live
 * run's caller owns the keys.
 */
async function withProbeGateway<T>(o: { chatModel: string; fake: boolean; transport?: ChatTransport; keys?: readonly string[] }, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.GBRAIN_MODEL_DISCOVERY;
  const dummies = o.fake ? (o.keys ?? []).filter(k => !process.env[k]) : [];
  process.env.GBRAIN_MODEL_DISCOVERY = 'off';
  for (const k of dummies) process.env[k] = 'dummy-fake-transport';
  if (o.fake) __setChatTransportForTests(o.transport ?? null);
  configureProbeGateway(o.chatModel);
  try {
    return await fn();
  } finally {
    if (o.fake) __setChatTransportForTests(null);
    for (const k of dummies) delete process.env[k];
    if (saved === undefined) delete process.env.GBRAIN_MODEL_DISCOVERY;
    else process.env.GBRAIN_MODEL_DISCOVERY = saved;
  }
}

/** The settings one provider request carried; a null `reasoning` or `thinking` means the field was not sent and the provider's default applies. */
export interface RequestSettings {
  host: string;
  model: string;
  sent: Record<string, unknown>;
  /** OpenAI echoes the reasoning effort it applied in each response. */
  applied_reasoning_effort?: string | null;
  requests: number;
}

const OPENAI_SETTINGS = ['reasoning', 'max_output_tokens', 'temperature', 'top_p', 'tool_choice', 'parallel_tool_calls', 'store', 'service_tier', 'truncation', 'text'] as const;
const ANTHROPIC_SETTINGS = ['thinking', 'max_tokens', 'temperature', 'top_p', 'top_k', 'tool_choice'] as const;

/** The model settings in a provider request body (never its headers, prompt or tool schemas). */
export function requestSettings(host: string, body: Record<string, unknown>): Pick<RequestSettings, 'model' | 'sent'> {
  const keys = host === 'api.openai.com' ? OPENAI_SETTINGS : ANTHROPIC_SETTINGS;
  const sent: Record<string, unknown> = Object.fromEntries(keys.map(k => [k, body[k] ?? null]));
  sent.tools = Array.isArray(body.tools) ? body.tools.length : 0;
  if (host === 'api.openai.com' && Array.isArray(body.input)) sent.instructions_role = (body.input[0] as { role?: unknown } | undefined)?.role ?? null;
  return { model: String(body.model ?? ''), sent };
}

/**
 * Record the settings of every request gbrain sends to OpenAI's Responses API
 * or Anthropic's Messages API while installed, grouped by distinct settings.
 * It wraps globalThis.fetch above whatever is there (the budget ledger's
 * guard in a live run), reads only request bodies and response JSON, and
 * stop() puts the previous fetch back.
 */
export function observeModelRequests(): { settings(): RequestSettings[]; stop(): void } {
  const previous = globalThis.fetch;
  const seen = new Map<string, RequestSettings>();
  const observed = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const watched = (url.hostname === 'api.openai.com' && url.pathname.endsWith('/responses')) || (url.hostname === 'api.anthropic.com' && url.pathname.endsWith('/messages'));
    let body: Record<string, unknown> | null = null;
    if (watched && typeof init?.body === 'string') { try { body = JSON.parse(init.body); } catch { body = null; } }
    const response = await previous(input, init);
    if (!body) return response;
    const { model, sent } = requestSettings(url.hostname, body);
    let applied: string | null | undefined;
    if (url.hostname === 'api.openai.com' && (response.headers.get('content-type') ?? '').includes('json')) {
      try { applied = ((await response.clone().json()) as { reasoning?: { effort?: string | null } }).reasoning?.effort ?? null; } catch { applied = undefined; }
    }
    const key = JSON.stringify([url.hostname, model, sent, applied]);
    const row = seen.get(key) ?? { host: url.hostname, model, sent, ...(applied !== undefined ? { applied_reasoning_effort: applied } : {}), requests: 0 };
    row.requests++;
    seen.set(key, row);
    return response;
  }, { preconnect: previous.preconnect?.bind(previous) }) as typeof fetch;
  globalThis.fetch = observed;
  return {
    settings: () => [...seen.values()],
    stop() { if (globalThis.fetch === observed) globalThis.fetch = previous; },
  };
}

// ─── Historical probe (Haiku 5.5; probes 1 and 2) ────────────────────────────

export interface ProbeSkillResult extends SkillProbe {
  arms: {
    no_skill: ArmScore;
    seed: ArmScore;
    one_shot: Array<ArmScore & { outcome: string; rewrite_error?: string; text_sha8?: string; kept: boolean; cost_usd: number | null }>;
    seed_opus: ArmScore;
  };
  /** Proposed skill texts, for the audit (eval/runner/skillopt-method/audit.ts). */
  rewrites: string[];
}

export interface ProbeOptions {
  fake: boolean;
  skills?: readonly SkillName[];
  afterHardening?: boolean;
  /** v1 reproduces probe 1, v2 probe 2. */
  dataset?: DatasetVersion;
  log?: (line: string) => void;
  /** Called with each skill's result as soon as it is scored, so a later budget stop or crash keeps it. */
  onSkill?: (result: ProbeSkillResult) => void;
}

export interface ProbeResult {
  mode: 'fake' | 'live';
  historical: string;
  models: typeof HISTORICAL_PROBE_MODELS;
  models_not_run: typeof MODELS_NOT_RUN;
  served_tools: string[];
  coverage: ToolCoverage[];
  skills: ProbeSkillResult[];
  gate: GateResult;
  /** Every task file the probe read (the test split must never appear). */
  files_read: string[];
  retrieval: string;
}

export const HISTORICAL_NOTE = 'historical: Haiku 5.5 is no longer a target (frontier first, plan revision 3); this path reproduces probes 1 (--dataset v1) and 2 (--after-hardening)';

const benchTask = (t: MethodTask): BenchmarkTask => ({ task_id: t.task_id, task: t.task, judge: t.judge });

/**
 * Run the historical probe. The caller owns the environment: a live run needs
 * ANTHROPIC_API_KEY set and nothing else (the runner does this inside
 * withHermeticEnv after the paid-arm guard); a fake run installs the fake
 * transport itself and removes it afterwards.
 */
export async function runProbe(opts: ProbeOptions): Promise<ProbeResult> {
  const log = opts.log ?? (() => {});
  const skills = opts.skills ?? SKILLS;
  const dataset = opts.dataset ?? DEFAULT_DATASET;
  const models = HISTORICAL_PROBE_MODELS;
  const filesRead: string[] = [];
  const load = (skill: SkillName, split: 'train' | 'sel') => {
    filesRead.push(`eval/data/${datasetName(dataset)}/${skill}/${split}.jsonl`);
    return readTasks(skill, split, dataset);
  };
  const data = new Map(skills.map(s => [s, { train: load(s, 'train'), sel: load(s, 'sel') }]));
  const coverage = toolCoverage(skills);
  const transport = opts.fake ? fakeTransport([...data.values()].flatMap(d => [...d.train, ...d.sel])) : undefined;

  const results: ProbeSkillResult[] = [];
  const engine = await openBrain();
  try {
    await withProbeGateway({ chatModel: models.target, fake: opts.fake, transport, keys: ['ANTHROPIC_API_KEY'] }, async () => {
      const arm = (skillText: string, tasks: readonly MethodTask[], model: string, runs: number) => scoreArm({ engine, skillText, tasks, model, runs });
      for (const skill of skills) {
        const { train, sel } = data.get(skill)!;
        const seedText = readSeed(skill, dataset);
        log(`[n15 probe] ${skill}: ${sel.length} selection tasks, ${train.length} train tasks (${HISTORICAL_NOTE})`);
        const ceiling = sel.filter(t => evaluateJudge(t.oracle_answer, t.judge).correct).length / sel.length;
        const noSkill = await arm(NO_SKILL_TEXT, sel, models.target, PROBE_RUNS_PER_TASK);
        const seed = await arm(seedText, sel, models.target, PROBE_RUNS_PER_TASK);
        log(`[n15 probe]   no-skill ${noSkill.score ?? 'error'}, seed ${seed.score ?? 'error'}`);

        const oneShot: ProbeSkillResult['arms']['one_shot'] = [];
        const rewrites: string[] = [];
        for (let repeat = 0; repeat < PROBE_REWRITE_REPEATS; repeat++) {
          const dir = mkdtempSync(join(tmpdir(), `n15-oneshot-${skill}-`));
          try {
            mkdirSync(join(dir, 'skills', skill), { recursive: true });
            writeFileSync(join(dir, 'skills', skill, 'SKILL.md'), seedText);
            const benchmarkPath = join(dir, 'train.jsonl');
            writeFileSync(benchmarkPath, train.map(t => JSON.stringify(benchTask(t))).join('\n') + '\n');
            const r = await runSkillOpt({
              engine, skillName: skill, skillsDir: join(dir, 'skills'), benchmarkPath,
              epochs: 1, batchSize: 1, lr: 4, lrSchedule: 'constant', split: PROBE_REWRITE_SPLIT,
              optimizerModel: models.proposer, targetModel: models.target, judgeModel: models.target,
              reflectMaxTokens: PROBE_REFLECT_MAX_TOKENS, optimizerMode: 'one-shot-rewrite',
              mode: 'patch', dryRun: false, noMutate: true, allowMutateBundled: false, bootstrapReviewed: false, json: true,
              maxCostUsd: PROBE_REWRITE_MAX_COST_USD, maxCostSource: 'user', maxRuntimeMin: 30, force: true,
            });
            const cost = r.receipt?.final_cost_usd ?? null;
            if (r.outcome === 'errored' || r.finalText === seedText) {
              oneShot.push({ score: null, per_task: {}, outcome: r.outcome, rewrite_error: r.outcome === 'errored' ? 'runSkillOpt outcome errored' : 'no candidate (the rewrite was refused or empty)', kept: false, cost_usd: cost });
              continue;
            }
            rewrites.push(r.finalText);
            const scored = await arm(r.finalText, sel, models.target, PROBE_RUNS_PER_TASK);
            oneShot.push({ ...scored, outcome: r.outcome, text_sha8: sha8(r.finalText), kept: false, cost_usd: cost });
          } catch (e) {
            oneShot.push({ score: null, per_task: {}, outcome: 'threw', rewrite_error: errMsg(e), kept: false, cost_usd: null });
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        }
        const beat = oneShot.filter(x => x.score !== null && seed.score !== null && x.score > seed.score).sort((a, b) => b.score! - a.score!)[0];
        if (beat) beat.kept = true;
        const seedOpus = await arm(seedText, sel, models.frontier, PROBE_FRONTIER_RUNS_PER_TASK);
        log(`[n15 probe]   one-shot ${oneShot.map(x => x.score ?? 'none').join(', ')} (kept ${beat ? beat.score : 'seed'}), seed on Opus ${seedOpus.score ?? 'error'}`);
        const result: ProbeSkillResult = {
          skill, ceiling,
          no_skill: noSkill.score, seed: seed.score,
          one_shot_repeats: oneShot.map(x => x.score), one_shot_kept: beat ? beat.score : seed.score,
          seed_opus: seedOpus.score,
          tool_gaps: coverage.find(c => c.skill === skill)!.missing,
          arms: { no_skill: noSkill, seed, one_shot: oneShot, seed_opus: seedOpus },
          rewrites,
        };
        results.push(result);
        opts.onSkill?.(result);
      }
    });
  } finally {
    await engine.disconnect().catch(() => {});
  }
  return {
    mode: opts.fake ? 'fake' : 'live',
    historical: HISTORICAL_NOTE,
    models,
    models_not_run: MODELS_NOT_RUN,
    served_tools: servedTools(),
    coverage,
    skills: results,
    gate: probeGate(results, { afterHardening: opts.afterHardening }),
    files_read: filesRead,
    retrieval: RETRIEVAL,
  };
}

// ─── Frontier probe ──────────────────────────────────────────────────────────

export interface RewriteArm extends ArmScore {
  outcome: 'scored' | 'no-rewrite' | 'audit-disqualified' | 'proposer-error' | 'no-train-trajectories';
  error?: string;
  text_sha8?: string;
  audit?: AuditResult;
  kept: boolean;
  cost_usd: number | null;
}

export interface FrontierSkillResult extends FrontierRow {
  target: FrontierTarget;
  stage: ProbeStage;
  no_skill: number | null;
  one_shot_repeats: Array<number | null>;
  /** Why this stage did not run the pair: its seed is outside the band, F0a left it unscored, or a reprice trigger stopped the stage first. */
  skipped?: 'seed-above-band' | 'seed-below-band' | 'f0a-unscored' | 'reprice-trigger';
  arms: { no_skill?: ArmScore; seed?: ArmScore; seed_train?: ArmScore; one_shot?: RewriteArm[] };
  /** This stage's rollouts for the pair; null when it did not run. */
  cost: MeterSummary | null;
  proposer_usd?: number | null;
  /** Forbidden markers withheld from the proposer input. */
  proposer_withheld?: number;
  /** In memory only (the runner writes them beside the receipt): each rewrite's text and the proposer input. */
  rewrites: string[];
  proposer_input?: string;
}

export interface RepriceTrigger { reason: 'reprice-trigger'; skill: SkillName; target: FrontierTarget; mean_rollout_usd: number; threshold_usd: number }

export interface FrontierResult {
  mode: 'fake' | 'live';
  stage: ProbeStage;
  target: FrontierTarget;
  models: { target: string; proposer: string | null };
  dataset: string;
  runs: typeof FRONTIER_RUNS;
  models_not_run: typeof MODELS_NOT_RUN;
  served_tools: string[];
  coverage: ToolCoverage[];
  skills: FrontierSkillResult[];
  /** The pairs F0b runs: seed in [0.20, 0.80]. */
  f0b_skills: SkillName[];
  /** Null after F0a while F0b has pairs to run: the gate reads the kept one-shot. */
  gate: FrontierGateResult | null;
  reprice_trigger: RepriceTrigger | null;
  /** Every task file the probe read (the test split must never appear). */
  files_read: string[];
  retrieval: string;
  /** Live runs: the settings gbrain sent each provider, grouped. */
  request_settings: RequestSettings[] | null;
}

export interface FrontierOptions {
  target: FrontierTarget;
  stage: ProbeStage;
  fake: boolean;
  skills?: readonly SkillName[];
  /** F0b: the F0a result of the same target (its receipt's data.probe). */
  from?: FrontierResult;
  /** A brain the caller opened with openBrain() and disconnects; default: one per run. */
  engine?: PGLiteEngine;
  log?: (line: string) => void;
  /** Called with each pair's result as soon as it is scored, so a later budget stop or crash keeps it. */
  onSkill?: (result: FrontierSkillResult) => void;
  /** Fake runs only: the chat transport (default fakeTransport). */
  transport?: (tasks: readonly MethodTask[]) => ChatTransport;
}

/** The pairs F0b runs: those whose F0a seed is in the band. */
export const f0bSkillsOf = (rows: readonly FrontierRow[]): SkillName[] => rows.filter(r => r.seed !== null && seedBand(r.seed) === null).map(r => r.skill);

function checkedF0a(o: FrontierOptions): FrontierResult {
  const from = o.from;
  if (!from) throw new Error('stage f0b reads the F0a result (--from <F0a receipt>)');
  const problems = [
    from.stage !== 'f0a' && `it is stage ${from.stage}`,
    from.target !== o.target && `it is for target ${from.target}`,
    from.mode !== (o.fake ? 'fake' : 'live') && `it is a ${from.mode} run`,
    from.dataset !== datasetName(DEFAULT_DATASET) && `it read ${from.dataset}`,
  ].filter(Boolean);
  if (problems.length) throw new Error(`stage f0b for ${o.target}${o.fake ? ' (fake)' : ''} needs that target's ${o.fake ? 'fake' : 'live'} F0a result on ${datasetName(DEFAULT_DATASET)}, but ${problems.join(', ')}`);
  return from;
}

/**
 * Run one frontier stage for one target (see the header). The caller owns the
 * environment of a live run: the target's key, plus ANTHROPIC_API_KEY for
 * F0b's proposer, and nothing else.
 */
export async function runFrontierProbe(o: FrontierOptions): Promise<FrontierResult> {
  const log = o.log ?? (() => {});
  const model = FRONTIER_TARGETS[o.target];
  const from = o.stage === 'f0b' ? checkedF0a(o) : null;
  const scope = (o.skills ?? (from ? from.skills.map(s => s.skill) : SKILLS)).filter(s => !from || from.skills.some(r => r.skill === s));
  const runs = from ? scope.filter(s => f0bSkillsOf(from.skills).includes(s)) : scope;
  const filesRead: string[] = [];
  const load = (skill: SkillName, split: 'train' | 'sel') => {
    filesRead.push(`eval/data/${datasetName(DEFAULT_DATASET)}/${skill}/${split}.jsonl`);
    return readTasks(skill, split);
  };
  const data = new Map(runs.map(s => [s, { train: o.stage === 'f0b' ? load(s, 'train') : [], sel: load(s, 'sel') }]));
  const coverage = toolCoverage(scope);
  const keys = o.stage === 'f0b' ? [...new Set([TARGET_KEY[o.target], 'ANTHROPIC_API_KEY'])] : [TARGET_KEY[o.target]];
  const transport = o.fake ? (o.transport ?? fakeTransport)([...data.values()].flatMap(d => [...d.train, ...d.sel])) : undefined;

  const results: FrontierSkillResult[] = [];
  let trigger: RepriceTrigger | null = null;
  const engine = o.engine ?? await openBrain();
  const observer = o.fake ? null : observeModelRequests();
  try {
    await withProbeGateway({ chatModel: model, fake: o.fake, transport, keys }, async () => {
      for (const skill of scope) {
        const prior = from?.skills.find(r => r.skill === skill);
        const d = data.get(skill);
        const ceiling = d ? d.sel.filter(t => evaluateJudge(t.oracle_answer, t.judge).correct).length / d.sel.length : prior?.ceiling ?? 1;
        const base = {
          skill, target: o.target, stage: o.stage, ceiling, tool_gaps: coverage.find(c => c.skill === skill)!.missing,
          no_skill: prior?.no_skill ?? null, seed: prior?.seed ?? null, one_shot_repeats: [] as Array<number | null>, one_shot_kept: null,
          arms: {}, cost: null, rewrites: [] as string[],
        };
        if (!d || trigger) {
          const skipped = trigger ? 'reprice-trigger' as const : (prior?.seed == null ? 'f0a-unscored' as const : seedBand(prior.seed) ?? 'f0a-unscored' as const);
          results.push({ ...base, skipped });
          continue;
        }
        const meter = emptyMeter();
        const seedText = readSeed(skill);
        let result: FrontierSkillResult;
        if (o.stage === 'f0a') {
          log(`[n15 probe] ${o.target} F0a ${skill}: no skill x${FRONTIER_RUNS.no_skill}, seed x${FRONTIER_RUNS.seed} on ${d.sel.length} selection tasks`);
          const noSkill = await scoreArm({ engine, skillText: NO_SKILL_TEXT, tasks: d.sel, model, runs: FRONTIER_RUNS.no_skill, meter });
          const seed = await scoreArm({ engine, skillText: seedText, tasks: d.sel, model, runs: FRONTIER_RUNS.seed, meter });
          result = { ...base, no_skill: noSkill.score, seed: seed.score, arms: { no_skill: noSkill, seed }, cost: summarizeMeter(meter) };
          log(`[n15 probe]   no-skill ${noSkill.score ?? 'error'}, seed ${seed.score ?? 'error'}`);
        } else {
          result = await oneShotPair({ ...base, engine, model, seedText, train: d.train, sel: d.sel, meter, log });
        }
        results.push(result);
        o.onSkill?.(result);
        const mean = result.cost?.mean_rollout_usd ?? null;
        if (mean !== null && mean > REPRICE_TRIGGER_USD[o.target]) {
          trigger = { reason: 'reprice-trigger', skill, target: o.target, mean_rollout_usd: mean, threshold_usd: REPRICE_TRIGGER_USD[o.target] };
          log(`[n15 probe] reprice trigger: ${o.target} ${skill} mean rollout $${mean.toFixed(4)} is above $${trigger.threshold_usd.toFixed(2)}; the stage stops here`);
        }
      }
    });
  } finally {
    observer?.stop();
    if (!o.engine) await engine.disconnect().catch(() => {});
  }
  return {
    mode: o.fake ? 'fake' : 'live',
    stage: o.stage,
    target: o.target,
    models: { target: model, proposer: o.stage === 'f0b' ? PROPOSER_MODEL : null },
    dataset: datasetName(DEFAULT_DATASET),
    runs: FRONTIER_RUNS,
    models_not_run: MODELS_NOT_RUN,
    served_tools: servedTools(),
    coverage,
    skills: results,
    f0b_skills: o.stage === 'f0a' ? f0bSkillsOf(results) : runs,
    gate: o.stage === 'f0a' && f0bSkillsOf(results).length ? null : frontierGate(results),
    reprice_trigger: trigger,
    files_read: filesRead,
    retrieval: RETRIEVAL,
    request_settings: observer ? observer.settings() : null,
  };
}

type PairBase = Omit<FrontierSkillResult, 'skipped'>;

/**
 * F0b for one pair: the seed's train trajectories once, then each repeat
 * proposes, audits and, when clean, scores its rewrite. The kept score is the
 * best scored repeat that beat the F0a seed, else the seed's; it is left
 * unscored (null) when a repeat that did not run could still move it to the
 * ceiling.
 */
async function oneShotPair(p: PairBase & { engine: PGLiteEngine; model: string; seedText: string; train: MethodTask[]; sel: MethodTask[]; meter: ReturnType<typeof emptyMeter>; log: (line: string) => void }): Promise<FrontierSkillResult> {
  const { engine, model, seedText, train, sel, meter, log, ...base } = p;
  log(`[n15 probe] ${base.target} F0b ${base.skill}: seed x${FRONTIER_RUNS.train} on ${train.length} train tasks, ${FRONTIER_REWRITE_REPEATS} rewrites scored x${FRONTIER_RUNS.rewrite} on selection`);
  const { arm: seedTrain, trajectories } = await seedOnTrain({ engine, seedText, train, model, meter });
  const arms: RewriteArm[] = [];
  const rewrites: string[] = [];
  let input: { text: string; withheld: number } | null = null;
  let inputError = seedTrain.score === null ? `the seed's train pass failed: ${seedTrain.error ?? 'unscored'}` : null;
  if (!inputError) {
    try { input = proposerInput({ seedText, criteria: readCriteria(base.skill), trajectories, markers: forbiddenMarkers(sel, train), pages: { visible: trainPages(train), corpus: new Set(loadCorpora().pages.keys()) } }); } catch (e) { inputError = errMsg(e); }
  }
  for (let repeat = 0; repeat < FRONTIER_REWRITE_REPEATS; repeat++) {
    if (!input) { arms.push({ score: null, per_task: {}, outcome: 'no-train-trajectories', error: inputError ?? undefined, kept: false, cost_usd: null }); continue; }
    let proposed;
    try { proposed = await proposeRewrite(input.text, seedText); } catch (e) { arms.push({ score: null, per_task: {}, outcome: 'proposer-error', error: errMsg(e), kept: false, cost_usd: null }); continue; }
    if (!proposed.text) { arms.push({ score: null, per_task: {}, outcome: 'no-rewrite', error: proposed.error, kept: false, cost_usd: proposed.cost_usd }); continue; }
    rewrites.push(proposed.text);
    const audit = auditSkill(base.skill, proposed.text, seedText);
    const id = { text_sha8: sha8(proposed.text), audit, kept: false, cost_usd: proposed.cost_usd };
    if (audit.disqualified) { arms.push({ score: null, per_task: {}, outcome: 'audit-disqualified', ...id }); continue; }
    arms.push({ ...await scoreArm({ engine, skillText: proposed.text, tasks: sel, model, runs: FRONTIER_RUNS.rewrite, meter }), outcome: 'scored', ...id });
  }
  const seed = base.seed!;
  const beat = arms.filter(a => a.score !== null && a.score > seed).sort((a, b) => b.score! - a.score!)[0];
  if (beat) beat.kept = true;
  const kept = beat ? beat.score! : seed;
  const missing = arms.some(a => a.outcome === 'proposer-error' || a.outcome === 'no-train-trajectories' || (a.outcome === 'scored' && a.score === null));
  const proposerCosts = arms.map(a => a.cost_usd).filter((c): c is number => c !== null);
  log(`[n15 probe]   train ${seedTrain.score ?? 'error'}; rewrites ${arms.map(a => a.score ?? a.outcome).join(', ')} (kept ${beat ? beat.score : 'seed'})`);
  return {
    ...base,
    one_shot_repeats: arms.map(a => a.score),
    one_shot_kept: missing && base.ceiling - kept >= PROBE_GATE.minRoomBelowCeiling ? null : kept,
    arms: { seed_train: seedTrain, one_shot: arms },
    cost: summarizeMeter(meter),
    proposer_usd: proposerCosts.length ? proposerCosts.reduce((a, b) => a + b, 0) : null,
    ...(input ? { proposer_withheld: input.withheld, proposer_input: input.text } : {}),
    rewrites,
  };
}

// ─── Smoke ───────────────────────────────────────────────────────────────────

export interface SmokeResult {
  target: FrontierTarget;
  model: string;
  skill: SkillName;
  task_id: string;
  turns: number | null;
  stop_reason: string | null;
  tool_calls: string[];
  correct: boolean | null;
  usage: Trajectory['usage'] | null;
  cost: MeterSummary;
  request_settings: RequestSettings[] | null;
  files_read: string[];
  error?: string;
}

/**
 * One rollout of the seed on the first train task of `skill`, on one target:
 * turns, tools, stop reason, tokens and cost per rollout. The caller owns a
 * live run's environment (only that target's key) and its ledger.
 */
export async function runSmoke(o: { target: FrontierTarget; fake: boolean; skill?: SkillName; engine?: PGLiteEngine; transport?: (tasks: readonly MethodTask[]) => ChatTransport }): Promise<SmokeResult> {
  const skill = o.skill ?? 'query';
  const model = FRONTIER_TARGETS[o.target];
  const task = readTasks(skill, 'train')[0]!;
  const meter = emptyMeter();
  let trajectory: Trajectory | null = null;
  let correct: boolean | null = null;
  let error: string | undefined;
  const engine = o.engine ?? await openBrain();
  const observer = o.fake ? null : observeModelRequests();
  try {
    await withProbeGateway({ chatModel: model, fake: o.fake, transport: o.fake ? (o.transport ?? fakeTransport)([task]) : undefined, keys: [TARGET_KEY[o.target]] }, async () => {
      const arm = await scoreArm({ engine, skillText: readSeed(skill), tasks: [task], model, runs: 1, meter, onRollout: (t, r) => { trajectory = t; correct = r.correct; } });
      error = arm.error;
    });
  } finally {
    observer?.stop();
    if (!o.engine) await engine.disconnect().catch(() => {});
  }
  const t = trajectory as Trajectory | null;
  return {
    target: o.target, model, skill, task_id: task.task_id,
    turns: t?.turns ?? null, stop_reason: t?.stop_reason ?? null, tool_calls: t?.tool_calls.map(c => c.name) ?? [], correct,
    usage: t?.usage ?? null, cost: summarizeMeter(meter),
    request_settings: observer ? observer.settings() : null,
    files_read: [`eval/data/${datasetName(DEFAULT_DATASET)}/${skill}/train.jsonl`],
    ...(error ? { error } : {}),
  };
}
