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
import { loadCorpus } from '../memory-qa/corpus.ts';
import { readResult } from '../refresh-barrier/agent.ts';
import { failureClasses } from '../refresh-barrier/analyze.ts';
import { isCapStop } from '../refresh-barrier/ledger.ts';
import type { Item, Suite } from './devset.ts';
import { contextDigest, NightlyCache, qaPromptVersion } from './judge-cache.ts';
import { keylessEnv, paidEnv, type Provider } from './keyless.ts';
import { OUTCOME_SCHEMA, type Outcome, type ToolError } from './outcome.ts';
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
export interface AdapterResult { status: 'ran' | 'partial' | 'error' | 'not_built' | 'skipped'; reason?: string; capStop?: boolean; rows: Outcome[] }
export type Adapter = (run: SuiteRun, ctx: NightContext) => Promise<AdapterResult>;

/** Suites whose items call a model: they need --fake, or --paid with the night's ledger run. */
export const callsModels = (s: Pick<Suite, 'kind'>) => s.kind === 'agent' || s.kind === 'qa';

export function qualifiedModel(reader: string): string {
  if (reader.includes(':')) return reader;
  if (reader.startsWith('claude-')) return `anthropic:${reader}`;
  if (reader.startsWith('gpt-') || /^o\d/.test(reader)) return `openai:${reader}`;
  if (reader.startsWith('particle-')) return `particle:${reader}`;
  throw new Error(`no provider for reader ${reader}`);
}

/** The QA judge for a reader's rows: GPT-6 Astra judges Claude rows and Claude Opus 5.5 judges every other family's, so no judge grades its own family. */
export const judgeFor = (reader: string) => (qualifiedModel(reader).startsWith('anthropic:') ? 'openai:gpt-6-astra' : 'anthropic:claude-opus-5-5');

const providerOf = (model: string) => model.slice(0, model.indexOf(':')) as Provider;
const slug = (s: string) => s.replace(/[^A-Za-z0-9.-]+/g, '_');

/** A child's environment: keyless unless the night is paid and the suite calls models, then only the named providers' keys. */
export function envFor(ctx: Pick<NightContext, 'fake' | 'paid'>, suite: Pick<Suite, 'kind'>, providers: Provider[], extra: Record<string, string> = {}): Record<string, string> {
  const paid = !ctx.fake && ctx.paid !== null && callsModels(suite);
  return { ...(paid ? paidEnv([...new Set(providers)]) : keylessEnv()), ...extra };
}

const paidFlags = (ctx: NightContext, suite: Suite) => (!ctx.fake && ctx.paid && callsModels(suite) ? ['--budget-run-id', ctx.paid.runId, '--budget-ledger', ctx.paid.ledger] : []);

/** Run a child in its own process group, log to a file, and kill the group when the night is aborted. */
export async function runChild(o: { cmd: string[]; env: Record<string, string>; log: string; signal?: AbortSignal; cwd?: string }): Promise<{ code: number | null; signal: string | null; tail: string }> {
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

export function outcome(run: SuiteRun, ctx: Pick<NightContext, 'night' | 'ref' | 'sha'>, o: Partial<Outcome> & Pick<Outcome, 'item' | 'pass'>): Outcome {
  const role = run.items.find(i => i.id === o.item || o.item.endsWith(`:${i.id}`))?.role ?? 'headroom';
  return { schema: OUTCOME_SCHEMA, night: ctx.night, suite: run.suite.id, suite_digest: run.digest, role, reader: null, ref: ctx.ref, sha: ctx.sha, trial: 1,
    score: null, cost_usd: null, stop: null, tool_errors: [], evidence: {}, harness: null, ...o };
}

/** Rows for items a child never reported on: harness rows, so the report counts them apart and a resume reruns them. */
const missingRows = (run: SuiteRun, ctx: NightContext, reader: string | null, have: Outcome[], why: string, items = run.items.map(i => i.id)) =>
  items.flatMap(item => Array.from({ length: run.k }, (_, t) => t + 1)
    .filter(trial => !have.some(r => r.item === item && r.reader === reader && r.trial === trial))
    .map(trial => outcome(run, ctx, { item, reader, trial, pass: false, harness: { error: why } })));

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

/** The Cat 40 runner's commands for one night: the world (free), the slot build and the cells, scripted on a fake night. */
export function cat40Commands(run: SuiteRun, ctx: NightContext, world: string, dirs: { root: string; slots: string; cells: string }) {
  const build = ['--world', world, '--gbrain-repo', ctx.clone, '--gbrain-ref', ctx.sha, '--gbrain-root', dirs.root, '--slots', String(CAT40.slots)];
  const keyless = ctx.fake ? ['--scripted', '--keyless-slots'] : [];
  if (!ctx.fake && ctx.cat40SlotAllowanceUsd === null) throw new Error('a paid Cat 40 night builds embedded slots; pass --cat40-slot-allowance-usd <dollars>');
  const paid = paidFlags(ctx, run.suite);
  return {
    world: [bun(CAT40.generator, '--mode', 'hard', '--seed', String(CAT40.seed), '--knobs', CAT40.knobs, '--out', join(dirname(dirname(world)), 'base-4k')),
      bun(CAT40.generator, '--mode', 'hard', '--seed', String(CAT40.seed), '--knobs', CAT40.knobs, '--scale', 'large', '--base-world', join(dirname(dirname(world)), 'base-4k', 'world.json'), '--out', dirname(world))],
    slots: bun(CAT40.runner, '--build-slots', ...build, ...keyless, ...(ctx.fake ? [] : ['--slot-build-allowance-usd', String(ctx.cat40SlotAllowanceUsd)]), ...paid, '--out', dirs.slots),
    cells: bun(CAT40.runner, ...build, '--arms', 'gbrain', '--gbrain-label', CAT40.label, '--tasks', run.items.map(i => i.id).join(','), '--repeat', String(run.k),
      '--concurrency', String(CAT40.concurrency), '--transcripts', ...keyless,
      ...(ctx.fake ? [] : ['--models', run.readers.filter((r): r is string => r !== null).join(','), '--judge', CAT40.judge]), ...paid, '--out', dirs.cells),
  };
}

/** Outcome rows from a Cat 40 cells directory: the canonical cell per key, its transcript's refused calls, and harness rows for keys left incomplete. */
export function cat40Rows(run: SuiteRun, ctx: NightContext, cellsDir: string): Outcome[] {
  const files = ['attempts.jsonl', 'results.jsonl'].map(f => join(cellsDir, f)).filter(existsSync);
  const { cells, incomplete } = canonicalCells(readRecords(files));
  const transcripts = new Map<string, Array<{ name: string; result: string }>>();
  if (existsSync(join(cellsDir, 'transcripts.jsonl'))) {
    for (const line of readFileSync(join(cellsDir, 'transcripts.jsonl'), 'utf8').split('\n').filter(Boolean)) {
      const t = JSON.parse(line) as { key: string; attempt_id?: string; tools: Array<{ name: string; result: string }> };
      transcripts.set(t.attempt_id ?? t.key, t.tools);
    }
  }
  const reader = (model: string) => (ctx.fake ? 'fake' : model);
  const rows = cells.filter(c => run.items.some(i => i.id === c.task)).map(c => {
    const raw = c.raw as Record<string, any>;
    const thrown: ToolError[] = (raw.sessions ?? []).flatMap((s: any) => (s.run?.tool_calls ?? []).filter((t: any) => t.error).map((t: any) => ({ tool: t.name, code: null, refused: false, message: String(t.error).slice(0, 200) })));
    const answered = (transcripts.get(c.attempt_id) ?? transcripts.get(c.key) ?? []).map(t => toolErrorFromText(t.name, t.result)).filter((e): e is ToolError => e !== null);
    const harness = c.stop === 'harness_error' || c.stop === 'error' ? { error: `${c.stop}: ${String(raw.error ?? '').slice(0, 300)}` } : null;
    return outcome(run, ctx, {
      item: c.task, reader: reader(c.model), trial: c.repeat + 1, pass: c.success, score: c.success ? 1 : 0, cost_usd: c.total_usd + c.judge_usd, stop: c.stop,
      tool_errors: [...thrown, ...answered], harness,
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
  const slots = await step('slots', cmds.slots, env);
  if (slots) return { status: 'error', reason: slots.why, capStop: slots.capStop, rows: [] };
  const cells = await step('cells', cmds.cells, env);
  const rows = cat40Rows(run, ctx, dirs.cells);
  const readers = ctx.fake ? ['fake'] : run.readers.filter((r): r is string => r !== null);
  const all = [...rows, ...readers.flatMap(r => missingRows(run, ctx, r, rows, cells?.why ?? 'no cell recorded'))];
  return { status: cells ? 'partial' : 'ran', reason: cells?.why, capStop: cells?.capStop, rows: all };
};

// ─── Part C write tasks: refresh-barrier-agents and refused-write-agents ─

/** Outcome rows from the worker's episode records (worker.ts agents), each scored by the nightly write scorer. */
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
    return outcome(run, ctx, {
      item: id!, reader, trial: Number(trial), pass: s.pass, score: s.pass ? 1 : 0, cost_usd: typeof rec.usd === 'number' ? rec.usd : null, stop,
      harness: stop === 'error' || stop === 'harness_error' ? { error: `${stop}: ${String(rec.loop?.error ?? '').slice(0, 300)}` } : null, tool_errors,
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
    return outcome(run, ctx, { item: `${engine}:${f.slice(0, -5)}`, pass: classes.length === 0, score: classes.length === 0 ? 1 : 0, stop: classes.join(',') || 'ok', harness,
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
    if (engine === 'postgres' && !ctx.pg.admin) { skipped.push('postgres trials need --pg-admin <url>'); return { rows: [] as Outcome[], failed: false }; }
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

export function qaCommand(run: SuiteRun, ctx: NightContext, reader: string, idsFile: string, out: string): string[] {
  const benchmark = String(run.suite.config?.benchmark);
  const script = join(REPO, 'eval/runner/memory-qa/run.ts');
  if (ctx.fake) return bun(script, '--benchmark', benchmark, '--system', 'fake', '--ids', idsFile, '--output', out);
  return bun(script, '--benchmark', benchmark, '--split', String(run.suite.config?.split ?? 'dev'), '--gbrain', `${ctx.clone}@${ctx.sha}`, '--gbrain-defaults', '--embed', 'real',
    '--qa', 'reader', '--reader', qualifiedModel(reader), '--judge', judgeFor(reader), '--ids', idsFile, '--paid', ...paidFlags(ctx, run.suite), '--output', out);
}

const QA_PASS = 0.5;

/** Outcome rows from memory-qa rows. A judged row passes at a judge score of at least 0.5 (LongMemEval's judge scores 0 or 1, BEAM's the share of rubric items met); a fake night's retrieval-only row passes when every gold session is in the top five. */
export function qaRows(run: SuiteRun, ctx: NightContext, reader: string, out: string, judge: string | null): Outcome[] {
  const rowsFile = join(out, 'rows.ndjson');
  if (!existsSync(rowsFile)) return [];
  const rows = readFileSync(rowsFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, any>);
  const receipt = existsSync(join(out, 'receipt.json')) ? JSON.parse(readFileSync(join(out, 'receipt.json'), 'utf8')) as Record<string, any> : {};
  const perRow = typeof receipt.cost_usd_all_attempts === 'number' && rows.length ? receipt.cost_usd_all_attempts / rows.length : null;
  return rows.filter(r => run.items.some(i => i.id === r.id)).map(r => {
    const judged = judge !== null;
    const harnessError = r.qa_error ?? (r.error && r.error_origin !== 'sut' ? r.error : null);
    const readerReceipts = (r.qa_receipts ?? []).filter((x: any) => x.role !== 'judge');
    return outcome(run, ctx, {
      item: r.id, reader, pass: judged ? (r.qa_score ?? 0) >= QA_PASS : r.abstention === true || r.recall_all_at_5 === 1,
      score: judged ? r.qa_score ?? null : r.recall_all_at_5 ?? null, cost_usd: perRow, stop: harnessError ? 'error' : 'answered',
      harness: harnessError ? { error: String(harnessError).slice(0, 300) } : null,
      tool_errors: r.error && r.error_origin === 'sut' ? [{ tool: 'search', code: null, refused: false, message: String(r.error).slice(0, 200) }] : [],
      evidence: { kind: 'qa', judge, abstention: r.abstention ?? false, recall_any_at_5: r.recall_any_at_5 ?? null, recall_all_at_5: r.recall_all_at_5 ?? null,
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

function goldAnswers(benchmark: string, items: string[]): Map<string, unknown> | null {
  try {
    const want = new Set(items);
    return new Map(loadCorpus(benchmark).questions.filter(q => want.has(q.id)).map(q => [q.id, { answer: q.answer ?? null, rubric: q.rubric ?? null }]));
  } catch { return null; }
}

export const qaAdapter: Adapter = async (run, ctx) => {
  const readers = ctx.fake ? ['fake'] : run.readers.filter((r): r is string => r !== null);
  const results = await Promise.all(readers.map(async reader => {
    const dir = join(ctx.dir, 'suites', run.suite.id, slug(reader));
    const out = join(dir, 'out');
    mkdirSync(dir, { recursive: true });
    const ids = join(dir, 'ids.txt');
    writeFileSync(ids, run.items.map(i => i.id).join('\n') + '\n');
    const judge = ctx.fake ? null : judgeFor(reader);
    const providers: Provider[] = ctx.fake ? [] : [providerOf(qualifiedModel(reader)), providerOf(judge!), 'openai', 'voyage'];
    const r = await runChild({ cmd: qaCommand(run, ctx, reader, ids, out), env: envFor(ctx, run.suite, providers, { GBRAIN_EVALS_QA_CACHE: ctx.cache.chatDir }), log: join(dir, 'run.log'), signal: ctx.signal });
    const rows = qaRows(run, ctx, reader, out, judge);
    if (judge) recordQaCaches(rows, ctx, reader, judge, goldAnswers(String(run.suite.config?.benchmark), run.items.map(i => i.id)));
    const receipt = existsSync(join(out, 'receipt.json')) ? JSON.parse(readFileSync(join(out, 'receipt.json'), 'utf8')) as Record<string, any> : null;
    const capStop = receipt?.summary?.stopped === 'budget';
    const all = run.items.map(i => i.id).flatMap(id => rows.filter(x => x.item === id).slice(0, 1));
    return { rows: [...all, ...missingRows(run, ctx, reader, all, r.code === 0 ? 'no row recorded' : `memory-qa exited ${r.code ?? r.signal}: ${r.tail.split('\n').at(-1)}`)], ok: r.code === 0, capStop, tail: r.tail };
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
    paths: Record<string, { ok: number; refused: Record<string, Record<string, number>> }> }>;
  return { status: 'ran', rows: replays.map(x => {
    const tool_errors = Object.entries(x.paths).flatMap(([path, p]) => Object.entries(p.refused).flatMap(([tool, codes]) =>
      Object.entries(codes).flatMap(([code, n]) => Array.from({ length: n }, () => ({ tool, code, refused: true, message: path })))));
    const answered = Object.values(x.paths).reduce((n, p) => n + p.ok, 0);
    return outcome(run, ctx, { item: x.item, pass: x.refusals === 0, score: answered + x.refusals ? answered / (answered + x.refusals) : null, stop: 'replayed', tool_errors,
      evidence: { kind: 'replay', family: x.family, skill: x.skill, calls: x.calls, unparseable: x.unparseable, paths: x.paths } });
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
  const results = JSON.parse(readFileSync(result, 'utf8')) as Array<{ id: string; pass: boolean; code: string | null; detail: string; ms: number }>;
  const rows = results.filter(s => run.items.some(i => i.id === s.id)).map(s => outcome(run, ctx, { item: s.id, pass: s.pass, score: s.pass ? 1 : 0, stop: s.code ?? (s.pass ? 'pass' : 'fail'),
    evidence: { kind: 'smoke', code: s.code, detail: s.detail, ms: s.ms } }));
  return { status: 'ran', rows: [...rows, ...missingRows(run, ctx, null, rows, 'the smoke did not report')] };
};

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
