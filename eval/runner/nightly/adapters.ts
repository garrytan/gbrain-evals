/**
 * The nightly's suite adapters. Each runs one dev-set suite against the gbrain build under test through the runner that
 * already measures it, and turns that runner's records into nightly outcome rows (outcome.ts). None changes what a runner
 * counts: Cat 40 Hard and the concurrency trials run as their own CLIs, Part C's episode functions run in a nightly worker
 * (worker.ts) with the nightly write scorer beside the counted one, memory-qa runs as its CLI with an --ids filter, and
 * the tool-contract replay and the system smokes run as keyless children.
 *
 * Every suite runs in child processes. A child gets keylessEnv (no key-like variable, every provider base URL on a dead
 * loopback port) unless its suite calls models on a paid night: then it gets paidEnv with only the keys its providers need,
 * plus the night's ledger run id, so the child's own paid-request guard meters every call against that run.
 */
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { canonicalCells, readRecords } from '../cat40/records.ts';
import { cat40Calls, cat40Fields, namesSlug } from '../failure-causes/adapters/cat40.ts';
import type { Coverage, ToolCall } from '../failure-causes/types.ts';
import type { HardTask } from '../../generators/hard/schema.ts';
import { loadCorpus, type MemoryQuestion } from '../memory-qa/corpus.ts';
import { recallAllAtK, recallAnyAtK } from '../metrics.ts';
import { readResult } from '../refresh-barrier/agent.ts';
import { failureClasses } from '../refresh-barrier/analyze.ts';
import { isCapStop } from '../refresh-barrier/ledger.ts';
import type { Item, Suite } from './devset.ts';
import { contextDigest, NightlyCache, qaPromptVersion } from './judge-cache.ts';
import { keylessEnv, paidEnv, type Provider } from './keyless.ts';
import { harnessOf, OUTCOME_SCHEMA, providerCause, qualifiedModel, type HarnessCause, type Outcome, type ToolError } from './outcome.ts';
import type { DevSetRun } from './report.ts';
import type { WriteScore } from './write-score.ts';

const HERE = import.meta.dir;
const REPO = resolve(HERE, '../../..');

export type Tier = 'nightly' | 'matrix' | 'smoke' | 'bisect';

export interface NightContext {
  night: string; ref: string; sha: string; dir: string; tier: Tier; fake: boolean;
  /** The gbrain clone the ref resolves in. */
  clone: string;
  /** The verified overlay of the sha (gbrain-under-test.ts). */
  overlayRoot: string;
  /** A Git worktree of the sha with its dependencies, for the refresh-barrier harness, which reads the root's HEAD. */
  worktree: () => Promise<string>;
  /** A verified overlay of another commit (the system smokes' previous and old builds). */
  overlayFor: (sha: string) => Promise<string>;
  cache: NightlyCache;
  paid: { runId: string; ledger: string } | null;
  pg: { admin: string | null; template: string | null; pg15Admin: string | null };
  smokeRefs: { previous: string | null; old: string | null };
  cat40SlotAllowanceUsd: number | null;
  log: (line: string) => void;
  signal: AbortSignal;
}

export interface SuiteRun { suite: Suite; digest: string; items: Item[]; readers: Array<string | null>; k: number }
export interface AdapterResult { status: 'ran' | 'partial' | 'error' | 'not_built' | 'skipped'; reason?: string; capStop?: boolean; rows: Outcome[]; dev_set?: DevSetRun }
export type Adapter = (run: SuiteRun, ctx: NightContext) => Promise<AdapterResult>;

/** Suites whose items call a model: they need --fake, or --paid with the night's ledger run. */
export const callsModels = (s: Pick<Suite, 'kind'>) => s.kind === 'agent' || s.kind === 'qa';

/**
 * The QA judge for a reader's rows: GPT-6 Astra judges every family's but OpenAI's, which Claude Opus 5.5 judges, so no
 * judge grades its own family, and claude-opus-5-5 and particle-1 share a judge, so their agreement compares readers.
 */
export const judgeFor = (reader: string) => (qualifiedModel(reader).startsWith('openai:') ? 'anthropic:claude-opus-5-5' : 'openai:gpt-6-astra');

const providerOf = (model: string) => model.slice(0, model.indexOf(':')) as Provider;
const slug = (s: string) => s.replace(/[^A-Za-z0-9.-]+/g, '_');

/** A child's environment: keyless unless the night is paid and the suite calls models, then only the named providers' keys. */
export function envFor(ctx: Pick<NightContext, 'fake' | 'paid'>, suite: Pick<Suite, 'kind'>, providers: Provider[], extra: Record<string, string> = {}): Record<string, string> {
  const paid = !ctx.fake && ctx.paid !== null && callsModels(suite);
  return { ...(paid ? paidEnv([...new Set(providers)]) : keylessEnv()), ...extra };
}

const paidFlags = (ctx: NightContext, suite: Suite) => (!ctx.fake && ctx.paid && callsModels(suite) ? ['--budget-run-id', ctx.paid.runId, '--budget-ledger', ctx.paid.ledger] : []);

/** Run a child in its own process group, log to a file, and kill the group when the night is aborted; once aborted, start none. */
export async function runChild(o: { cmd: string[]; env: Record<string, string>; log: string; signal?: AbortSignal; cwd?: string }): Promise<{ code: number | null; signal: string | null; tail: string }> {
  if (o.signal?.aborted) return { code: null, signal: 'aborted', tail: 'not started: the night was aborted' };
  mkdirSync(dirname(o.log), { recursive: true });
  const fd = openSync(o.log, 'a');
  const proc = spawn(o.cmd[0]!, o.cmd.slice(1), { cwd: o.cwd ?? REPO, env: o.env, stdio: ['ignore', fd, fd], detached: true });
  const kill = () => { try { process.kill(-proc.pid!, 'SIGKILL'); } catch { proc.kill('SIGKILL'); } };
  o.signal?.addEventListener('abort', kill, { once: true });
  const [code, signal] = await new Promise<[number | null, string | null]>(res => proc.on('exit', (c, s) => res([c, s])));
  o.signal?.removeEventListener('abort', kill);
  closeSync(fd);
  const tail = readFileSync(o.log, 'utf8').split('\n').filter(Boolean).slice(-12).join('\n').slice(-1_500);
  return { code, signal, tail };
}

const bun = (script: string, ...args: string[]) => ['bun', '--no-env-file', script, ...args];
/** Whether a child's log tail records a ledger cap stop (refresh-barrier/ledger.ts isCapStop, line by line). */
export const capStopIn = (tail: string) => tail.split('\n').some(line => isCapStop(line) || (line.includes('budget: ') && isCapStop(line.slice(line.indexOf('budget: ')))));

/**
 * Each suite's fixed facts, stamped on every row it writes: natural for the headroom QA and agent-QA suites, forced for the
 * fault-injection suites (the write-agent episodes run against injected refreshes and refusals, the trials, smokes and replay); public for LongMemEval and BEAM, synthetic for the generated ones.
 */
export const SUITE_FACTS: Record<string, Pick<Outcome, 'condition' | 'visibility' | 'agent_loop'>> = {
  'cat40-hard-m': { condition: 'natural', visibility: 'synthetic', agent_loop: true },
  'refresh-barrier-agents': { condition: 'forced', visibility: 'synthetic', agent_loop: true },
  'refused-write-agents': { condition: 'forced', visibility: 'synthetic', agent_loop: true },
  'concurrent-writers': { condition: 'forced', visibility: 'synthetic', agent_loop: false },
  'system-smokes': { condition: 'forced', visibility: 'synthetic', agent_loop: false },
  'lme-s-hard': { condition: 'natural', visibility: 'public', agent_loop: false },
  'beam-1m-hard': { condition: 'natural', visibility: 'public', agent_loop: false },
  'tool-contract-replay': { condition: 'forced', visibility: 'synthetic', agent_loop: false },
};

export function outcome(run: SuiteRun, ctx: Pick<NightContext, 'night' | 'ref' | 'sha'>, o: Partial<Outcome> & Pick<Outcome, 'item' | 'pass'>): Outcome {
  const role = run.items.find(i => i.id === o.item || o.item.endsWith(`:${i.id}`))?.role ?? 'headroom';
  const facts = SUITE_FACTS[run.suite.id];
  if (!facts) throw new Error(`suite ${run.suite.id} has no row in SUITE_FACTS`);
  const row: Outcome = { schema: OUTCOME_SCHEMA, night: ctx.night, suite: run.suite.id, suite_digest: run.digest, role, reader: null, ref: ctx.ref, sha: ctx.sha, trial: 1,
    score: null, cost_usd: null, stop: null, tool_errors: [], evidence: {}, harness: null, finish_reason: null,
    system: 'gbrain', arm: `${run.suite.id}@${ctx.ref}`, arm_role: ctx.ref === 'master' ? 'gbrain_default' : 'gbrain_variant', ...facts, ...o };
  return { ...row, harness: harnessOf(row) };
}

/** Rows for items a child never reported on: harness rows, so the report counts them apart and a resume reruns them. */
const missingRows = (run: SuiteRun, ctx: NightContext, reader: string | null, have: Outcome[], why: string, items = run.items.map(i => i.id)) =>
  items.flatMap(item => Array.from({ length: run.k }, (_, t) => t + 1)
    .filter(trial => !have.some(r => r.item === item && r.reader === reader && r.trial === trial))
    .map(trial => outcome(run, ctx, { item, reader, trial, pass: false, harness: { error: why } })));

/** Rows for items the night scheduled and did not run (a suite it skipped or could not build, an engine it had no server for), with the reason. */
export const skippedRows = (run: SuiteRun, ctx: Pick<NightContext, 'night' | 'ref' | 'sha' | 'fake'>, why: string, items = run.items.map(i => i.id)) =>
  (ctx.fake && callsModels(run.suite) ? ['fake'] : run.readers).flatMap(reader => items.flatMap(item => Array.from({ length: run.k }, (_, t) =>
    outcome(run, ctx, { item, reader, trial: t + 1, pass: false, skipped: why }))));

/** gbrain's answer to a call, read from the text the agent saw: a refusal (a coded error the caller can act on) or a crash. */
export function toolErrorFromText(tool: string, text: string): ToolError | null {
  const { isError, body } = readResult(text);
  if (!isError) return null;
  const code = typeof body.code === 'string' ? body.code : typeof body.error === 'string' ? body.error : null;
  const crashed = code === null || /internal|timeout|unavailable|server_error/.test(code);
  return { tool, code, refused: !crashed, message: String(body.message ?? text.slice(7, 207)) };
}

// ─── Cat 40 Hard, world M ───────────────────────────────────────────

export const CAT40 = {
  runner: join(REPO, 'eval/runner/cat40-model-ladder.ts'), generator: join(REPO, 'eval/generators/model-ladder-gen.ts'),
  knobs: join(REPO, 'docs/benchmarks/cat40-hard/knobs.frozen.json'), seed: 20261021, label: 'gbrain-hard', judge: 'gpt-6.1-sol', slots: 5, concurrency: 10,
};

/** The Cat 40 runner's commands for one night: the world (free), one slot build per slot (run side by side), and the cells, scripted on a fake night. */
export function cat40Commands(run: SuiteRun, ctx: NightContext, world: string, dirs: { root: string; slots: string; cells: string }) {
  // World M is a dev set (gate decision A, 2026-11-09), so the night runs it on the current harness and records any drift from the Hard freeze.
  const build = ['--dev-set', '--world', world, '--gbrain-repo', ctx.clone, '--gbrain-ref', ctx.sha, '--gbrain-root', dirs.root, '--slots', String(CAT40.slots)];
  const keyless = ctx.fake ? ['--scripted', '--keyless-slots'] : [];
  if (!ctx.fake && ctx.cat40SlotAllowanceUsd === null) throw new Error('a paid Cat 40 night builds embedded slots; pass --cat40-slot-allowance-usd <dollars>');
  const paid = paidFlags(ctx, run.suite);
  return {
    world: [bun(CAT40.generator, '--mode', 'hard', '--seed', String(CAT40.seed), '--knobs', CAT40.knobs, '--out', join(dirname(dirname(world)), 'base-4k')),
      bun(CAT40.generator, '--mode', 'hard', '--seed', String(CAT40.seed), '--knobs', CAT40.knobs, '--scale', 'large', '--base-world', join(dirname(dirname(world)), 'base-4k', 'world.json'), '--out', dirname(world))],
    slots: Array.from({ length: CAT40.slots }, (_, i) => bun(CAT40.runner, '--build-slots', ...build, '--build-slot-ids', String(i), ...keyless,
      ...(ctx.fake ? [] : ['--slot-build-allowance-usd', String(ctx.cat40SlotAllowanceUsd)]), ...paid, '--out', join(dirs.slots, `slot${i}`))),
    cells: bun(CAT40.runner, ...build, '--arms', 'gbrain', '--gbrain-label', CAT40.label, '--tasks', run.items.map(i => i.id).join(','), '--repeat', String(run.k),
      '--concurrency', String(CAT40.concurrency), '--transcripts', ...keyless,
      ...(ctx.fake ? [] : ['--models', run.readers.filter((r): r is string => r !== null).join(','), '--judge', CAT40.judge]), ...paid, '--out', dirs.cells),
  };
}

/** The dev-set label and drifted files from the newest Cat 40 cells receipt, which every row of the suite carries into the report. */
export function cat40DevSet(cellsDir: string): DevSetRun | null {
  const receipts = existsSync(cellsDir) ? readdirSync(cellsDir).filter(f => /^receipt-\d+\.json$/.test(f)).sort((a, b) => Number(a.slice(8, -5)) - Number(b.slice(8, -5))) : [];
  if (!receipts.length) return null;
  return (JSON.parse(readFileSync(join(cellsDir, receipts.at(-1)!), 'utf8')) as { dev_set?: DevSetRun }).dev_set ?? null;
}

/**
 * Outcome rows from a Cat 40 cells directory: the canonical cell per key, its transcript's refused calls, and harness rows for
 * keys left incomplete. The gold is the cell's evidence_cited and missed_evidence: opened from those, searched_gold the gold
 * ids any tool result names (the transcript holds each result as the agent saw it, so delivered is the same coverage). Every
 * call comes from the cell's tool calls lined up with the transcript, a refusal read from the result text, and recovered as
 * the failure-cause Cat 40 adapter computes it; without a transcript that lines up call for call, calls is null. The question
 * and its expected answer come from the world's task when tasks holds it.
 */
export function cat40Rows(run: SuiteRun, ctx: NightContext, cellsDir: string, tasks: ReadonlyMap<string, HardTask> = new Map()): Outcome[] {
  const files = ['attempts.jsonl', 'results.jsonl'].map(f => join(cellsDir, f)).filter(existsSync);
  const { cells, incomplete } = canonicalCells(readRecords(files));
  const transcripts = new Map<string, Array<{ name: string; args?: Record<string, unknown>; result: string }>>();
  if (existsSync(join(cellsDir, 'transcripts.jsonl'))) {
    for (const line of readFileSync(join(cellsDir, 'transcripts.jsonl'), 'utf8').split('\n').filter(Boolean)) {
      const t = JSON.parse(line) as { key: string; attempt_id?: string; tools: Array<{ name: string; args?: Record<string, unknown>; result: string }> };
      transcripts.set(t.attempt_id ?? t.key, t.tools);
    }
  }
  const reader = (model: string) => (ctx.fake ? 'fake' : model);
  const rows = cells.filter(c => run.items.some(i => i.id === c.task)).map(c => {
    const raw = c.raw as Record<string, any>;
    const thrown: ToolError[] = (raw.sessions ?? []).flatMap((s: any) => (s.run?.tool_calls ?? []).filter((t: any) => t.error).map((t: any) => ({ tool: t.name, code: null, refused: false, message: String(t.error).slice(0, 200) })));
    const tools = transcripts.get(c.attempt_id) ?? transcripts.get(c.key);
    const answered = (tools ?? []).map(t => toolErrorFromText(t.name, t.result)).filter((e): e is ToolError => e !== null);
    const harness = c.stop === 'harness_error' || c.stop === 'error' ? { error: `${c.stop}: ${String(raw.error ?? '').slice(0, 300)}` } : null;
    const fields = cat40Fields(raw);
    const calls = fields && tools && tools.length === fields.calls.length ? cat40Calls(fields.calls.map((x, i) => {
      const refusal = toolErrorFromText(x.name, tools[i]!.result);
      return { ...x, error: x.error ?? (refusal ? refusal.code ?? refusal.message ?? 'error' : null) };
    }), tools) : null;
    const cited: string[] = raw.score?.evidence_cited ?? [], missed: string[] = raw.score?.missed_evidence ?? [];
    const gold = [...new Set([...cited, ...missed])];
    const results = (tools ?? []).map(t => String(t.result ?? '')).join('\n');
    const searched = tools && gold.length ? gold.filter(g => namesSlug(results, g)) : null;
    const retrieved: Coverage | null = searched === null ? null : !searched.length ? 'none' : searched.length === gold.length ? 'all' : 'partial';
    const submitted = (fields?.final as { answer?: unknown } | null)?.answer;
    const answer = typeof submitted === 'string' ? submitted : submitted == null ? null : JSON.stringify(submitted);
    const task = tasks.get(c.task), g = task?.gold;
    return outcome(run, ctx, {
      item: c.task, reader: reader(c.model), trial: c.repeat + 1, pass: c.success, score: c.success ? 1 : 0, cost_usd: c.total_usd + c.judge_usd, stop: c.stop,
      tool_errors: [...thrown, ...answered], harness, category: c.family, gold_count: gold.length,
      retrieved, delivered: retrieved, opened: !gold.length ? null : !cited.length ? 'none' : !missed.length ? 'all' : 'partial', searched_gold: searched, calls,
      answered: raw.score?.submitted === true && !!answer?.trim(), answer,
      question: task?.question ?? null,
      expected: !g ? null : g.answer?.join(' | ') ?? (g.members ? JSON.stringify(g.members.map(m => m.names[0])) : g.count !== undefined ? String(g.count) : g.items ? JSON.stringify(g.items.map(i => i.answer)) : null),
      evidence: { kind: 'agent-qa', family: c.family, submitted: raw.score?.submitted ?? null, said_wrong: raw.score?.said_wrong ?? null, evidence_cited: raw.score?.evidence_cited ?? [],
        missed_evidence: raw.score?.missed_evidence ?? [], wrote: raw.score?.wrote ?? null, claims: raw.claims ? { unsupported: raw.claims.unsupported, contradicted: raw.claims.contradicted, total: raw.claims.total } : null },
    });
  });
  const lost = incomplete.map(key => { const [model, , task, repeat] = key.split('|'); return outcome(run, ctx, { item: task!, reader: reader(model!), trial: Number(repeat) + 1, pass: false, harness: { error: 'every attempt was a harness error' } }); });
  return [...rows, ...lost];
}

export const cat40Adapter: Adapter = async (run, ctx) => {
  const base = join(ctx.dir, 'suites', run.suite.id);
  const world = join(ctx.cache.root, 'cat40', 'world-m', 'world', 'world.json');
  const dirs = { root: join(ctx.cache.root, 'cat40', 'gbrain'), slots: join(base, 'slots'), cells: join(base, 'cells') };
  const cmds = cat40Commands(run, ctx, world, dirs);
  const env = envFor(ctx, run.suite, ['anthropic', 'openai', 'voyage']);
  const step = async (name: string, cmd: string[], childEnv: Record<string, string>) => {
    const r = await runChild({ cmd, env: childEnv, log: join(base, `${name}.log`), signal: ctx.signal });
    return r.code === 0 ? null : { capStop: capStopIn(r.tail), why: `${name} exited ${r.code ?? r.signal}: ${r.tail.split('\n').slice(-3).join(' ')}` };
  };
  if (!existsSync(world)) for (const cmd of cmds.world) { const f = await step('world', cmd, keylessEnv()); if (f) return { status: 'error', reason: f.why, rows: [] }; }
  const built = await Promise.all(cmds.slots.map((cmd, i) => step(`slots-${i}`, cmd, env)));
  const failed = built.filter((f): f is NonNullable<typeof f> => f !== null);
  if (failed.length) return { status: 'error', reason: failed.map(f => f.why).join('; '), capStop: failed.some(f => f.capStop), rows: [] };
  const cells = await step('cells', cmds.cells, env);
  const tasks = (JSON.parse(readFileSync(world, 'utf8')) as { tasks: HardTask[] }).tasks.filter(t => run.items.some(i => i.id === t.id));
  const rows = cat40Rows(run, ctx, dirs.cells, new Map(tasks.map(t => [t.id, t])));
  const readers = ctx.fake ? ['fake'] : run.readers.filter((r): r is string => r !== null);
  const all = [...rows, ...readers.flatMap(r => missingRows(run, ctx, r, rows, cells?.why ?? 'no cell recorded'))];
  const devSet = cat40DevSet(dirs.cells);
  return { status: cells ? 'partial' : 'ran', reason: cells?.why, capStop: cells?.capStop, rows: all, ...(devSet ? { dev_set: devSet } : {}) };
};

// ─── Part C write tasks: refresh-barrier-agents and refused-write-agents ─

/**
 * Outcome rows from the worker's episode records (worker.ts agents), each scored by the nightly write scorer. Every logged
 * call is a call: a refused write, a thrown call or a read gbrain answered with an error is an error. An error on a call that
 * carried facts is recovered only when none of those facts was resent under a new request id, never landed or went
 * unreported (as the failure-cause refresh-barrier adapter reads Part C); any other error is recovered when a later call of
 * the same tool on the same subject succeeded, and unknown when the transcript does not line up call for call. writes holds
 * what the nightly scorer measures: lost (acknowledged and missing) and duplicated facts; stuck and overwritten are not
 * measured, so null. answered is whether the episode's report could be read from a submit_answer call or the final text.
 */
export function episodeRows(run: SuiteRun, ctx: NightContext, reader: string, dir: string): Outcome[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().filter(f => /^task-\d+-t\d+\.json$/.test(f)).map(f => {
    const rec = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, any>;
    const [, id, trial] = /^task-(\d+)-t(\d+)\.json$/.exec(f)!;
    if (rec.harness_error) return outcome(run, ctx, { item: id!, reader, trial: Number(trial), pass: false, harness: { error: String(rec.harness_error).slice(0, 300) } });
    const s = rec.nightly_score as WriteScore;
    const stop = String(rec.loop?.stop ?? '');
    const tool_errors: ToolError[] = (rec.calls ?? []).flatMap((c: any) => c.harness_error ? [{ tool: c.name, code: null, refused: false, message: String(c.harness_error).slice(0, 200) }]
      : String(c.cls ?? '').startsWith('refused') ? [{ tool: c.name, code: c.code ?? null, refused: true }] : []);
    const logged: Array<Record<string, any>> = rec.calls ?? [];
    const failed = new Set<string>([...s.resent, ...s.missing, ...s.unreported]);
    const errorOf = (c: Record<string, any>) => c.harness_error ? String(c.harness_error).slice(0, 200)
      : String(c.cls ?? '').startsWith('refused') ? `${c.cls}${c.code ? `/${c.code}` : ''}` : !c.write && c.is_error ? String(c.code ?? 'error') : null;
    const subject = (i: number) => (rec.transcript?.length === logged.length ? JSON.stringify(rec.transcript[i].args?.slug ?? rec.transcript[i].args ?? null) : null);
    const calls = logged.map((c, i) => {
      const error = errorOf(c);
      const recovered = error === null ? null : (c.tokens ?? []).length ? !c.tokens.some((t: string) => failed.has(t))
        : subject(i) === null ? null : logged.slice(i + 1).some((d, j) => d.name === c.name && subject(i + 1 + j) === subject(i) && errorOf(d) === null);
      return { name: String(c.name), error, recovered, ms: typeof c.ms === 'number' ? c.ms : null, memory: true };
    });
    return outcome(run, ctx, {
      item: id!, reader, trial: Number(trial), pass: s.pass, score: s.pass ? 1 : 0, cost_usd: typeof rec.usd === 'number' ? rec.usd : null, stop,
      harness: stop === 'error' || stop === 'harness_error' ? { error: `${stop}: ${String(rec.loop?.error ?? '').slice(0, 300)}` } : null, tool_errors, calls,
      writes: { lost: s.acknowledged_missing, stuck: null, overwritten: null, duplicated: s.duplicated },
      answered: rec.report ? rec.report.source != null : null,
      evidence: { kind: 'write', tokens_once: s.tokens_once, report_correct: s.report_correct, no_resend: s.no_resend, duplicated: s.duplicated, missing: s.missing,
        acknowledged_missing: s.acknowledged_missing, resent: s.resent, misreports: s.misreports, unreported: s.unreported,
        refusal_outcomes: (rec.behavior?.refusals ?? []).map((r: any) => r.outcome), counted_scorer_success: rec.score?.success ?? null },
    });
  });
}

export const agentsAdapter: Adapter = async (run, ctx) => {
  const arm = String(run.suite.config?.arm);
  if (arm !== 'on' && arm !== 'off') return { status: 'error', reason: `suite ${run.suite.id} names no arm`, rows: [] };
  const root = await ctx.worktree();
  const readers = ctx.fake ? ['fake'] : run.readers.filter((r): r is string => r !== null);
  const results = await Promise.all(readers.map(async reader => {
    const model = ctx.fake ? 'fake' : qualifiedModel(reader);
    const dir = join(ctx.dir, 'suites', run.suite.id, slug(reader));
    const r = await runChild({ cmd: bun(join(HERE, 'worker.ts'), 'agents', '--suite', run.suite.id, '--arm', arm, '--tasks', run.items.map(i => i.id).join(','), '--k', String(run.k),
      '--model', model, '--gbrain-root', root, '--out', dir, ...paidFlags(ctx, run.suite)),
      env: envFor(ctx, run.suite, ctx.fake ? [] : [providerOf(model)]), log: join(dir, 'worker.log'), signal: ctx.signal });
    const rows = episodeRows(run, ctx, reader, dir);
    return { rows: [...rows, ...missingRows(run, ctx, reader, rows, r.code === 0 ? 'no episode recorded' : `worker exited ${r.code ?? r.signal}: ${r.tail.split('\n').at(-1)}`)], code: r.code, tail: r.tail };
  }));
  const failed = results.filter(r => r.code !== 0);
  return { status: failed.length ? 'partial' : 'ran', reason: failed.map(r => r.tail.split('\n').at(-1)).join('; ') || undefined, capStop: results.some(r => r.code === 3), rows: results.flatMap(r => r.rows) };
};

// ─── Concurrent writers: Part A trials, dry ─────────────────────────

/** Contiguous seed ranges (refresh-barrier/run.ts takes --seeds <from>-<to>). */
export function seedRanges(seeds: number[]): string[] {
  const sorted = [...new Set(seeds)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    out.push(`${sorted[i]}-${sorted[j]}`);
    i = j + 1;
  }
  return out;
}

export function trialRows(run: SuiteRun, ctx: NightContext, engine: string, dir: string): Outcome[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().filter(f => /^\d+\.json$/.test(f) && run.items.some(i => `${i.id}.json` === f)).map(f => {
    const t = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, any>;
    const classes = failureClasses(t, 'trial');
    const harness = classes.includes('harness_error') || t.placeholder ? { error: t.harness_error ? JSON.stringify(t.harness_error).slice(0, 300) : 'harness_error' } : null;
    const ops: Array<Record<string, any>> = t.ops ?? [];
    const ids = (cls: string) => ops.filter(o => o[cls] === true).map(o => String(o.request_id ?? `w${o.writer}.${o.op}`));
    return outcome(run, ctx, { item: `${engine}:${f.slice(0, -5)}`, pass: classes.length === 0, score: classes.length === 0 ? 1 : 0, stop: classes.join(',') || 'ok', harness,
      writes: { lost: ids('lost'), stuck: ids('stuck'), overwritten: ids('overwritten'), duplicated: ids('duplicated') },
      evidence: { kind: 'trials', engine, failure_classes: classes.filter(c => c !== 'harness_error') } });
  });
}

/** A template database with root's schema (worker.ts pg-template), named for tonight's commit; null when it did not build. */
async function buildPgTemplate(root: string, ctx: NightContext, log: string): Promise<string | null> {
  const name = `nightly_tpl_${ctx.sha.slice(0, 12)}`;
  const r = await runChild({ cmd: bun(join(HERE, 'worker.ts'), 'pg-template', '--gbrain-root', root, '--pg-admin', ctx.pg.admin!, '--name', name), env: keylessEnv(), log, signal: ctx.signal });
  return r.code === 0 ? name : null;
}

export const trialsAdapter: Adapter = async (run, ctx) => {
  const engines = (run.suite.config?.engines as string[] | undefined) ?? ['pglite'];
  const root = await ctx.worktree();
  const seeds = run.items.map(i => Number(i.id));
  const skipped: string[] = [];
  const results = await Promise.all(engines.map(async engine => {
    if (engine === 'postgres' && !ctx.pg.admin) {
      const why = 'postgres trials need --pg-admin <url>';
      skipped.push(why);
      return { rows: skippedRows(run, ctx, why, run.items.map(i => `${engine}:${i.id}`)), failed: false };
    }
    const out = join(ctx.dir, 'suites', run.suite.id, engine);
    const template = engine === 'postgres' ? ctx.pg.template ?? await buildPgTemplate(root, ctx, join(out, 'template.log')) : null;
    if (engine === 'postgres' && !template) {
      return { rows: run.items.map(i => outcome(run, ctx, { item: `${engine}:${i.id}`, pass: false, harness: { error: 'the Postgres template with tonight\'s schema did not build; see template.log' } })), failed: true };
    }
    let failed = false;
    for (const range of seedRanges(seeds)) {
      const r = await runChild({ cmd: bun(join(REPO, 'eval/runner/refresh-barrier/run.ts'), '--block', 'trials', '--engine', engine, '--gbrain-root', root, '--out', out, '--seeds', range,
        '--arms', String(run.suite.config?.arm ?? 'on'), '--dry', ...(engine === 'postgres' ? ['--pg-admin', ctx.pg.admin!, '--template', template!] : [])),
        env: keylessEnv(), log: join(out, 'run.log'), signal: ctx.signal });
      failed ||= r.code !== 0;
    }
    const rows = trialRows(run, ctx, engine, join(out, 'trials', engine, String(run.suite.config?.arm ?? 'on')));
    const missing = run.items.filter(i => !rows.some(r => r.item === `${engine}:${i.id}`)).map(i => outcome(run, ctx, { item: `${engine}:${i.id}`, pass: false, harness: { error: 'the trial left no result' } }));
    return { rows: [...rows, ...missing], failed };
  }));
  const failed = results.some(r => r.failed);
  return { status: skipped.length || failed ? 'partial' : 'ran', reason: [...skipped, ...(failed ? ['a trials block exited non-zero; see its run.log'] : [])].join('; ') || undefined, rows: results.flatMap(r => r.rows) };
};

// ─── QA: lme-s-hard and beam-1m-hard through memory-qa ──────────────

/**
 * memory-qa's command for one reader. The reader's output limit is the suite's qa_max_tokens, so the suite digest and
 * memory-qa's receipt (reading.max_output_tokens, reader_max_tokens_sent) record it; a paid suite without one is refused.
 */
export function qaCommand(run: SuiteRun, ctx: NightContext, reader: string, idsFile: string, out: string): string[] {
  const benchmark = String(run.suite.config?.benchmark);
  const script = join(REPO, 'eval/runner/memory-qa/run.ts');
  if (ctx.fake) return bun(script, '--benchmark', benchmark, '--system', 'fake', '--ids', idsFile, '--output', out);
  const maxTokens = run.suite.config?.qa_max_tokens;
  if (!Number.isInteger(maxTokens)) throw new Error(`suite ${run.suite.id} names no qa_max_tokens, so its reader would get memory-qa's 1,024-token default, which cuts frontier answers`);
  return bun(script, '--benchmark', benchmark, '--split', String(run.suite.config?.split ?? 'dev'), '--gbrain', `${ctx.clone}@${ctx.sha}`, '--gbrain-defaults', '--embed', 'real',
    '--qa', 'reader', '--reader', qualifiedModel(reader), '--judge', judgeFor(reader), '--ids', idsFile, '--paid', ...paidFlags(ctx, run.suite), '--qa-max-tokens', String(maxTokens), '--output', out);
}

const QA_PASS = 0.5;

/**
 * Outcome rows from memory-qa rows. A judged row passes at a judge score of at least 0.5 (LongMemEval's judge scores 0 or 1, BEAM's the share of rubric items met); a fake night's retrieval-only row passes when every gold session is in the top five.
 * Gold coverage comes from the runner's ranked sessions: recall_any_at_10 is computed from that list and the question's gold
 * sessions beside the runner's recall_all_at_10, and retrieved is the coverage at 10 (at 5 when the question is not in
 * questions). A reader given the top sessions (--qa reader, --qa-context sessions) read the first qa_sessions of that list,
 * so delivered is that prefix's coverage; under any other reading it is null. A gbrain error (error_origin sut) is a
 * search tool error, never a harness row, and carries the shared stage whose provider caused it with a 429 or 5xx
 * (outcome.ts providerCause) as its cause, which only the agreement check reads.
 */
export function qaRows(run: SuiteRun, ctx: NightContext, reader: string, out: string, judge: string | null, questions: ReadonlyMap<string, MemoryQuestion> = new Map()): Outcome[] {
  const rowsFile = join(out, 'rows.ndjson');
  if (!existsSync(rowsFile)) return [];
  const rows = readFileSync(rowsFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, any>);
  const receipt = existsSync(join(out, 'receipt.json')) ? JSON.parse(readFileSync(join(out, 'receipt.json'), 'utf8')) as Record<string, any> : {};
  const perRow = typeof receipt.cost_usd_all_attempts === 'number' && rows.length ? receipt.cost_usd_all_attempts / rows.length : null;
  const packed = receipt.qa?.mode === 'reader' && receipt.qa?.context === 'sessions';
  const cover = (any: unknown, all: unknown): Coverage | null => (typeof any !== 'number' || typeof all !== 'number' ? null : any <= 0 ? 'none' : all >= 1 ? 'all' : 'partial');
  return rows.filter(r => run.items.some(i => i.id === r.id)).map(r => {
    const judged = judge !== null;
    const harnessError = r.qa_error ?? (r.error && r.error_origin !== 'sut' ? r.error : null);
    const gbrainError = r.error && r.error_origin === 'sut' ? String(r.error) : null;
    const provider = gbrainError ? providerCause(gbrainError) : null;
    const lastCall = r.qa_error ? (r.qa_receipts ?? []).at(-1) : undefined;
    const readerReceipts = (r.qa_receipts ?? []).filter((x: any) => x.role !== 'judge');
    const q = questions.get(r.id);
    const ranked: string[] | null = Array.isArray(r.retrieved) ? r.retrieved : null;
    const gold = q?.gold.length ? new Set(q.gold) : null;
    const any10 = gold && ranked ? recallAnyAtK(ranked, gold, 10) : null;
    const top = packed && gold && ranked && typeof r.qa_sessions === 'number' ? ranked.slice(0, r.qa_sessions) : null;
    return outcome(run, ctx, {
      item: r.id, reader, pass: judged ? (r.qa_score ?? 0) >= QA_PASS : r.abstention === true || r.recall_all_at_5 === 1,
      score: judged ? r.qa_score ?? null : r.recall_all_at_5 ?? null, cost_usd: perRow, stop: harnessError ? 'error' : 'answered',
      harness: harnessError ? { error: String(harnessError).slice(0, 300), ...(lastCall ? { cause: lastCall.role === 'judge' ? 'judge' as const : 'reader' as const } : {}) } : null,
      tool_errors: gbrainError ? [{ tool: 'search', code: null, refused: false, message: gbrainError.slice(0, 200), ...(provider ? { cause: provider } : {}) }] : [],
      category: r.category ?? null, gold_count: typeof r.gold_count === 'number' ? r.gold_count : null,
      retrieved: r.gold_count === 0 ? null : gold ? cover(any10, r.recall_all_at_10) : cover(r.recall_any_at_5, r.recall_all_at_5),
      delivered: top ? cover(recallAnyAtK(top, gold!, top.length), recallAllAtK(top, gold!, top.length)) : null,
      answered: typeof r.qa_answer === 'string' ? r.qa_answer.trim() !== '' : null, finish_reason: readerReceipts.at(-1)?.finish ?? null,
      question: q?.question ?? null, expected: q ? q.answer ?? (q.rubric?.length ? q.rubric.join(' | ') : null) : null, answer: r.qa_answer ?? null,
      evidence: { kind: 'qa', judge, abstention: r.abstention ?? false, recall_any_at_5: r.recall_any_at_5 ?? null, recall_all_at_5: r.recall_all_at_5 ?? null,
        recall_any_at_10: any10, recall_all_at_10: r.recall_all_at_10 ?? null,
        answer: r.qa_answer ?? null, retrieved: r.retrieved ?? null, reader_from_cache: readerReceipts.length > 0 && readerReceipts.every((x: any) => x.from_cache === true) },
    });
  });
}

/**
 * Records each judged row in the nightly caches. The reader and judge calls themselves are reused through memory-qa's
 * provider-call cache (GBRAIN_EVALS_QA_CACHE, pointed at the nightly cache), which keys on the model and the exact prompt,
 * so a question whose retrieved context is byte-identical to an earlier night's gets that night's answer and judgment.
 * Here each row's context digest (its ranked sessions and the tokens the reader got) and its judgment are recorded, so
 * the row says which night it reused, and a changed verdict for the same judge key is flagged as judge drift.
 */
export function recordQaCaches(rows: Outcome[], ctx: NightContext, reader: string, judge: string, gold: Map<string, unknown> | null): void {
  const promptVersion = qaPromptVersion();
  for (const o of rows) {
    if (o.harness || o.score === null) continue;
    const e = o.evidence;
    const key = { reader, judge, promptVersion, questionId: o.item, contextDigest: contextDigest(JSON.stringify(e.retrieved ?? null)) };
    const prior = ctx.cache.getContext(key);
    if (prior && prior.night !== ctx.night) Object.assign(e, { context_seen_on: prior.night, context_score_changed: prior.score !== o.score });
    ctx.cache.putContext(key, { answer: String(e.answer ?? ''), score: o.score, night: ctx.night, row: { item: o.item, pass: o.pass } });
    if (gold && gold.has(o.item) && typeof e.answer === 'string') {
      const drift = ctx.cache.putJudgment({ judge, promptVersion, questionId: o.item, gold: gold.get(o.item), answer: e.answer }, { score: o.score, night: ctx.night });
      if (drift) Object.assign(e, { judge_drift: { earlier_night: drift.night, earlier_score: drift.score } });
    }
  }
}

function corpusQuestions(benchmark: string, items: string[]): Map<string, MemoryQuestion> | null {
  try {
    const want = new Set(items);
    return new Map(loadCorpus(benchmark).questions.filter(q => want.has(q.id)).map(q => [q.id, q]));
  } catch { return null; }
}

/** One row per item: memory-qa appends a retry's row after the failed one, so the newest non-harness row is current. */
export const latestRowPerItem = (rows: Outcome[], ids: readonly string[]): Outcome[] => ids.flatMap(id => {
  const mine = rows.filter(r => r.item === id);
  const pick = mine.filter(r => !r.harness).at(-1) ?? mine.at(-1);
  return pick ? [pick] : [];
});

export const qaAdapter: Adapter = async (run, ctx) => {
  const readers = ctx.fake ? ['fake'] : run.readers.filter((r): r is string => r !== null);
  const questions = corpusQuestions(String(run.suite.config?.benchmark), run.items.map(i => i.id));
  const gold = questions && new Map([...questions].map(([id, q]) => [id, { answer: q.answer ?? null, rubric: q.rubric ?? null }]));
  const results = await Promise.all(readers.map(async reader => {
    const dir = join(ctx.dir, 'suites', run.suite.id, slug(reader));
    const out = join(dir, 'out');
    mkdirSync(dir, { recursive: true });
    const ids = join(dir, 'ids.txt');
    writeFileSync(ids, run.items.map(i => i.id).join('\n') + '\n');
    const judge = ctx.fake ? null : judgeFor(reader);
    const providers: Provider[] = ctx.fake ? [] : [providerOf(qualifiedModel(reader)), providerOf(judge!), 'openai', 'voyage'];
    const r = await runChild({ cmd: qaCommand(run, ctx, reader, ids, out), env: envFor(ctx, run.suite, providers, { GBRAIN_EVALS_QA_CACHE: ctx.cache.chatDir }), log: join(dir, 'run.log'), signal: ctx.signal });
    const rows = qaRows(run, ctx, reader, out, judge, questions ?? new Map());
    if (judge) recordQaCaches(rows, ctx, reader, judge, gold);
    const receipt = existsSync(join(out, 'receipt.json')) ? JSON.parse(readFileSync(join(out, 'receipt.json'), 'utf8')) as Record<string, any> : null;
    const capStop = receipt?.summary?.stopped === 'budget';
    const all = latestRowPerItem(rows, run.items.map(i => i.id));
    const cause: HarnessCause | null = receipt?.refusal?.code === 'RERANKER_INACTIVE' ? 'rerank' : capStop || ctx.signal?.aborted ? 'run' : null;
    const missing = missingRows(run, ctx, reader, all, r.code === 0 ? 'no row recorded' : `memory-qa exited ${r.code ?? r.signal}: ${r.tail.split('\n').at(-1)}`);
    return { rows: [...all, ...missing.map(o => (cause ? { ...o, harness: { ...o.harness!, cause } } : o))], ok: r.code === 0, capStop, tail: r.tail };
  }));
  const bad = results.filter(r => !r.ok);
  return { status: bad.length ? 'partial' : 'ran', reason: bad.map(r => r.tail.split('\n').at(-1)).join('; ') || undefined, capStop: results.some(r => r.capStop), rows: results.flatMap(r => r.rows) };
};

// ─── Tool-contract replay ───────────────────────────────────────────

export const replayAdapter: Adapter = async (run, ctx) => {
  const dir = join(ctx.dir, 'suites', run.suite.id);
  const out = join(dir, 'replay.json');
  if (!existsSync(out)) {
    const r = await runChild({ cmd: bun(join(HERE, 'tool-contract.ts'), '--gbrain-root', ctx.overlayRoot, '--out', out, '--items', run.items.map(i => i.id).join(',')),
      env: keylessEnv(), log: join(dir, 'replay.log'), signal: ctx.signal });
    if (r.code !== 0 || !existsSync(out)) return { status: 'error', reason: `the replay exited ${r.code ?? r.signal}: ${r.tail.split('\n').at(-1)}`, rows: missingRows(run, ctx, null, [], 'the replay did not finish') };
  }
  const replays = JSON.parse(readFileSync(out, 'utf8')) as Array<{ item: string; family: string; skill: string; calls: number; unparseable: number; refusals: number;
    paths: Record<string, { ok: number; ok_by_tool?: Record<string, number>; refused: Record<string, Record<string, number>> }> }>;
  const repeat = (n: number, call: ToolCall) => Array.from({ length: n }, () => call);
  return { status: 'ran', rows: replays.map(x => {
    const tool_errors = Object.entries(x.paths).flatMap(([path, p]) => Object.entries(p.refused).flatMap(([tool, codes]) =>
      Object.entries(codes).flatMap(([code, n]) => Array.from({ length: n }, () => ({ tool, code, refused: true, message: path })))));
    const answered = Object.values(x.paths).reduce((n, p) => n + p.ok, 0);
    const calls = Object.values(x.paths).every(p => p.ok_by_tool) ? Object.values(x.paths).flatMap(p => [
      ...Object.entries(p.ok_by_tool!).flatMap(([name, n]) => repeat(n, { name, error: null, recovered: null, ms: null, memory: true })),
      ...Object.entries(p.refused).flatMap(([name, codes]) => Object.entries(codes).flatMap(([code, n]) => repeat(n, { name, error: code, recovered: false, ms: null, memory: true }))),
    ]) : null;
    return outcome(run, ctx, { item: x.item, pass: x.refusals === 0, score: answered + x.refusals ? answered / (answered + x.refusals) : null, stop: 'replayed', tool_errors,
      category: x.skill, calls, evidence: { kind: 'replay', family: x.family, skill: x.skill, calls: x.calls, unparseable: x.unparseable, paths: x.paths } });
  }) };
};

// ─── System smokes ──────────────────────────────────────────────────

export const SMOKES_INDEX = join(HERE, 'smokes', 'index.ts');

export const smokesAdapter: Adapter = async (run, ctx) => {
  if (!existsSync(SMOKES_INDEX)) return { status: 'not_built', reason: 'eval/runner/nightly/smokes/index.ts is not in this checkout', rows: [] };
  const dir = join(ctx.dir, 'suites', run.suite.id);
  const result = join(dir, 'results.json');
  const [previous, old] = await Promise.all([ctx.smokeRefs.previous, ctx.smokeRefs.old].map(sha => (sha ? ctx.overlayFor(sha) : Promise.resolve(null))));
  const r = await runChild({ cmd: bun(join(HERE, 'worker.ts'), 'smokes', '--tonight', ctx.overlayRoot, ...(previous ? ['--previous', previous] : []), ...(old ? ['--old', old] : []),
    '--out', join(dir, 'work'), '--result', result, ...(ctx.pg.admin ? ['--pg', ctx.pg.admin] : []), ...(ctx.pg.pg15Admin ? ['--pg15', ctx.pg.pg15Admin] : [])),
    env: keylessEnv(), log: join(dir, 'smokes.log'), signal: ctx.signal });
  if (r.code === 4) return { status: 'not_built', reason: r.tail.split('\n').at(-1), rows: [] };
  if (r.code !== 0 || !existsSync(result)) return { status: 'error', reason: `the smokes exited ${r.code ?? r.signal}: ${r.tail.split('\n').at(-1)}`, rows: missingRows(run, ctx, null, [], 'the smokes did not finish') };
  const rows = smokeRows(run, ctx, JSON.parse(readFileSync(result, 'utf8')) as SmokeResult[]);
  return { status: 'ran', rows: [...rows, ...missingRows(run, ctx, null, rows, 'the smoke did not report')] };
};

export interface SmokeResult { id: string; pass: boolean; code: string | null; detail: string; ms: number }

/**
 * Outcome rows from the smokes' results. A `harness_*` code (or none) means the smoke could not run, so its row is a harness
 * row and never a gbrain failure; any other failed smoke is the operation it checks failing with its code.
 */
export function smokeRows(run: SuiteRun, ctx: Pick<NightContext, 'night' | 'ref' | 'sha'>, results: SmokeResult[]): Outcome[] {
  return results.filter(s => run.items.some(i => i.id === s.id)).map(s => {
    const harness = !s.pass && (s.code === null || s.code.startsWith('harness_')) ? { error: `${s.code ?? 'no code'}: ${s.detail}`.slice(0, 300) } : null;
    return outcome(run, ctx, { item: s.id, pass: s.pass, score: s.pass ? 1 : 0, stop: s.code ?? (s.pass ? 'pass' : 'fail'), harness,
      operation: s.pass || harness ? null : { step: s.id, error: s.code! }, evidence: { kind: 'smoke', code: s.code, detail: s.detail, ms: s.ms } });
  });
}

export const ADAPTERS: Record<string, Adapter> = {
  'cat40-hard-m': cat40Adapter, 'refresh-barrier-agents': agentsAdapter, 'refused-write-agents': agentsAdapter, 'concurrent-writers': trialsAdapter,
  'system-smokes': smokesAdapter, 'lme-s-hard': qaAdapter, 'beam-1m-hard': qaAdapter, 'tool-contract-replay': replayAdapter,
};

/** A Git worktree of sha under root with its dependencies installed, made once and reused. */
export function worktreeAt(clone: string, sha: string, root: string): string {
  const dir = join(root, 'worktrees', sha);
  if (existsSync(join(dir, '.nightly-ready'))) return dir;
  execFileSync('git', ['-C', clone, 'worktree', 'prune']);
  if (!existsSync(dir)) execFileSync('git', ['-C', clone, 'worktree', 'add', '--detach', '--force', dir, sha], { stdio: 'ignore' });
  execFileSync('bun', ['install', '--frozen-lockfile'], { cwd: dir, stdio: 'ignore', env: keylessEnv() });
  writeFileSync(join(dir, '.nightly-ready'), sha + '\n');
  return dir;
}
