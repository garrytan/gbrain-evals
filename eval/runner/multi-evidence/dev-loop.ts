/**
 * The multi-evidence dev loop: one command that scores a gbrain build on questions whose answer needs two or more gold
 * items, the shape behind "partial evidence", the nightly check's top failure cause.
 *
 *   bun eval/runner/multi-evidence/dev-loop.ts --out <dir> [--gbrain <tag|sha|branch>] [--gbrain-clone <path>]
 *     [--arms base[,cap2x,batch]] [--readers claude-opus-5-5,gpt-6.1-sol] [--suites a,b] [--items x,y] [--k N]
 *     [--fake | --paid --budget-ledger <path> (--budget-run-id <id> | --budget-usd <n>)] [--cat40-slot-allowance-usd 4]
 *     [--slots-from <tag|sha|branch>] [--cat40-slots N]
 *     [--agent-noise 0.167]
 *   bun eval/runner/multi-evidence/dev-loop.ts --report <run dir> [--agent-noise 0.167]
 *
 * --gbrain defaults to gbrain's newest release: the highest vX.Y.Z tag on origin/master in the clone, after a tag fetch.
 * --slots-from builds the Cat 40 brains with another commit and serves the build under test on them (the runner's
 * --slot-ref), so two builds that change only how pages are read run on byte-identical brains and their cells pair on
 * the server code alone; the two commits must share a schema. --cat40-slots sets how many brains run cells at once (5).
 *
 * The dev set (eval/data/multi-evidence/devset-v1.json, select.ts) holds the nightly's Cat 40 Hard world M tasks,
 * LongMemEval-S dev questions and public BEAM-1M dev questions whose gold has at least two items, BEAM and LME items only
 * when the answerability check passes them. Each suite runs through the nightly adapter that already measures it
 * (eval/runner/nightly/adapters.ts): Cat 40 cells through the Cat 40 runner with Opus 5.5 and GPT-6.1 Sol as agents on
 * gbrain's MCP tools, and the QA suites through memory-qa, where gbrain's search ranks sessions and a reader answers from
 * the top ones, judged by a model of the other family (adapters.ts judgeFor).
 *
 * Arms:
 *   base   the nightly's settings: Cat 40's turn cap (16, the frozen knobs' max_turns), the reader's top 5 sessions.
 *   cap2x  twice the budget: a 32-turn cap; the reader's top 10 sessions, replayed from base's ranked lists
 *          (memory-qa --retrieved-from), so only the packing cut moves. Separates "gbrain can't find it" from "the agent
 *          ran out of turns" and "the reader never got it".
 *   batch  Cat 40 only, at the base cap, with gbrain's served instructions plus BATCH_HINT, which tells the agent to read
 *          several pages in one call with assemble_evidence or query's return_unit "page". Needs base in the same run
 *          directory, whose served-instructions.txt it extends.
 *
 * Output in <out>/<gbrain ref>/: per-arm work dirs, items.jsonl (one row per item, reader, arm and trial; score.ts says
 * what each field counts), why.jsonl (the missed items with every call and each gold item's fate), summary.json and
 * report.md. Children resume their own work, so rerunning the same command finishes a stopped run.
 *
 * Spend: --fake runs every suite's own keyless path; --paid needs a budget ledger run (opened here from --budget-usd and
 * closed at the end, or joined with --budget-run-id), which meters every provider call the children make.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { BudgetRun, budgetOptionsFrom, closeRun, ledgerStatus } from '../budget-ledger.ts';
import { canonicalCells, readRecords } from '../cat40/records.ts';
import { resolveGbrainUnderTest } from '../gbrain-under-test.ts';
import { loadCorpus } from '../memory-qa/corpus.ts';
import { cat40Commands, cat40Rows, envFor, judgeFor, latestRowPerItem, qaCommand, qaRows, runChild, type NightContext, type SuiteRun } from '../nightly/adapters.ts';
import { loadDevSet, suiteDigest, type Suite } from '../nightly/devset.ts';
import { NightlyCache } from '../nightly/judge-cache.ts';
import { keylessEnv, type Provider } from '../nightly/keyless.ts';
import { qualifiedModel, type Outcome } from '../nightly/outcome.ts';
import { PaidArmRefusal, requirePaidArm } from '../paid-arm.ts';
import { agentItem, agentWhy, minDetectable, missed, qaItem, qaWhy, slices, trialDiscordance, type ArmName, type Call, type ItemRow, type Slice, type WhyRow } from './score.ts';
import { loadMeDevSet, type MeDevSet } from './select.ts';

const REPO = resolve(import.meta.dir, '../../..');
export const BASE_TURN_CAP = (JSON.parse(readFileSync(join(REPO, 'docs/benchmarks/cat40-hard/knobs.frozen.json'), 'utf8')) as { max_turns: number }).max_turns;
export const BASE_QA_SESSIONS = 5;
export const READERS = ['claude-opus-5-5', 'gpt-6.1-sol'];
/** "All gold delivered" disagreement between trials of one build: Cat 40 world M, nightly 2026-11-16 master, k = 3, 144 trial pairs. */
export const AGENT_NOISE = 0.167;
/** A progress line this often, so a VM watchdog that kills silent commands (ubi-runner's 30 minutes) never fires on a long arm. */
const HEARTBEAT_MS = 5 * 60_000;

export const ARMS: Record<ArmName, { about: string; turnCap: number; qaSessions: number | null }> = {
  base: { about: `the nightly's settings: ${BASE_TURN_CAP}-turn cap, top ${BASE_QA_SESSIONS} sessions to the reader`, turnCap: BASE_TURN_CAP, qaSessions: BASE_QA_SESSIONS },
  cap2x: { about: `twice the budget: ${2 * BASE_TURN_CAP}-turn cap, top ${2 * BASE_QA_SESSIONS} sessions replayed from base's ranked lists`, turnCap: 2 * BASE_TURN_CAP, qaSessions: 2 * BASE_QA_SESSIONS },
  batch: { about: `${BASE_TURN_CAP}-turn cap, agent told to read several pages per call (Cat 40 only)`, turnCap: BASE_TURN_CAP, qaSessions: null },
};

export const BATCH_HINT = [
  'Reading several pages: when a search or query names more pages than you can read one at a time, read them in one call.',
  'Call assemble_evidence with the hits you want, best first (up to 50, each {source_id, slug, chunk_id} from a search or query result) and return_unit "page";',
  'or call query with return_unit "page" and a token_budget, which returns whole pages instead of excerpts.',
  'One assemble_evidence call replaces a get_page call per page.',
].join(' ');

const slug = (s: string) => s.replace(/[^A-Za-z0-9.-]+/g, '_');
const git = (clone: string, ...args: string[]) => execFileSync('git', ['-C', clone, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const versionParts = (tag: string) => tag.slice(1).split('.').map(Number);
export function compareVersions(a: string, b: string): number {
  const x = versionParts(a), y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

/** gbrain's newest release: the highest vX.Y.Z tag that origin/master contains. */
export function newestRelease(clone: string, fetch = true): { tag: string; sha: string } {
  if (fetch) git(clone, 'fetch', '-q', '--tags', 'origin', '+refs/heads/master:refs/remotes/origin/master');
  const tags = git(clone, 'tag', '-l', 'v*').split('\n').filter(t => /^v\d+(\.\d+)+$/.test(t)).sort(compareVersions).reverse();
  for (const tag of tags) {
    if (spawnSync('git', ['-C', clone, 'merge-base', '--is-ancestor', tag, 'origin/master']).status === 0) return { tag, sha: git(clone, 'rev-parse', `${tag}^{commit}`) };
  }
  throw new Error(`no vX.Y.Z release tag on origin/master in ${clone}`);
}

/** A tag, sha or branch (origin/<branch> first) as a commit. */
export function resolveGbrainRef(clone: string, ref: string): string {
  for (const cand of [`refs/tags/${ref}`, `origin/${ref}`, ref]) {
    const r = spawnSync('git', ['-C', clone, 'rev-parse', '--verify', '-q', `${cand}^{commit}`], { encoding: 'utf8' });
    if (r.status === 0) return r.stdout.trim();
  }
  throw new Error(`${ref} is not a tag, branch or commit in ${clone}; fetch it first`);
}

export interface LoopArgs {
  out: string | null; report: string | null; gbrain: string | null; clone: string; arms: ArmName[]; readers: string[]; suites: string[] | null; items: string[] | null; k: number;
  fake: boolean; paid: boolean; budgetLedger: string | null; budgetRunId: string | null; budgetUsd: number | null; slotAllowanceUsd: number; agentNoise: number; fetch: boolean;
  slotsFrom: string | null; cat40Slots: number | null;
}

export function parseArgs(argv: readonly string[]): LoopArgs {
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--') ? argv[i + 1] : undefined; };
  const list = (name: string) => flag(name)?.split(',').map(s => s.trim()).filter(Boolean) ?? null;
  const num = (name: string, dflt: number) => { const v = flag(name); if (v === undefined) return dflt; const n = Number(v); if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number`); return n; };
  const arms = (list('--arms') ?? ['base']) as ArmName[];
  const bad = arms.filter(a => !(a in ARMS));
  if (bad.length) throw new Error(`--arms takes base, cap2x and batch (got ${bad.join(', ')})`);
  if (arms.includes('batch') && !arms.includes('base')) throw new Error('--arms batch extends base\'s served instructions: run it with base (--arms base,batch)');
  const report = flag('--report') ? resolve(flag('--report')!) : null;
  const out = flag('--out') ? resolve(flag('--out')!) : null;
  if (!out && !report) throw new Error('--out <dir> is required (or --report <run dir> to re-score one)');
  const fake = argv.includes('--fake'), paid = argv.includes('--paid');
  if (fake && paid) throw new PaidArmRefusal('--fake makes no paid call; drop --paid');
  if (!report && !fake && !paid) throw new PaidArmRefusal('the dev loop calls models: pass --fake for a keyless run, or --paid --budget-ledger <path> with --budget-usd <n> (or --budget-run-id <id>)');
  const usd = flag('--budget-usd');
  return {
    out, report, gbrain: flag('--gbrain') ?? null, clone: resolve(flag('--gbrain-clone') ?? process.env.GBRAIN_REPO ?? join(REPO, '../gbrain')),
    arms: (['base', 'cap2x', 'batch'] as ArmName[]).filter(a => arms.includes(a)), readers: list('--readers') ?? READERS, suites: list('--suites'), items: list('--items'),
    k: Math.max(1, Math.floor(num('--k', 1))), fake, paid, budgetLedger: flag('--budget-ledger') ? resolve(flag('--budget-ledger')!) : null, budgetRunId: flag('--budget-run-id') ?? null,
    budgetUsd: usd === undefined ? null : Number(usd), slotAllowanceUsd: num('--cat40-slot-allowance-usd', 4), agentNoise: num('--agent-noise', AGENT_NOISE), fetch: !argv.includes('--no-fetch'),
    slotsFrom: flag('--slots-from') ?? null, cat40Slots: flag('--cat40-slots') === undefined ? null : Math.max(1, Math.floor(num('--cat40-slots', 5))),
  };
}

/** The dev set's suites as nightly SuiteRuns (the nightly suite's id and config, the dev set's items). */
export function planRuns(me: MeDevSet, a: Pick<LoopArgs, 'suites' | 'items' | 'readers' | 'k'>): SuiteRun[] {
  const nightly = new Map((loadDevSet().suites as Suite[]).map(s => [s.id, s]));
  return me.suites.filter(s => a.suites === null || a.suites.includes(s.id)).map(s => {
    const base = nightly.get(s.id);
    if (!base) throw new Error(`the nightly dev set has no suite ${s.id}`);
    const items = s.items.filter(i => a.items === null || a.items.includes(i.id)).map(i => ({ id: i.id, role: 'headroom' as const }));
    const suite: Suite = { ...base, items };
    return { suite, digest: suiteDigest(suite), items, readers: a.readers, k: s.kind === 'agent' ? a.k : 1 };
  }).filter(r => r.items.length > 0);
}

interface Ctx extends NightContext { label: string; slots: { sha?: string; n?: number } }

// ─── Cat 40 ─────────────────────────────────────────────────────────

interface Cat40Dirs { world: string; root: string; slots: string }

/** A paid Cat 40 child spends against this dev loop's ledger run, never the closed run a resumed output dir recorded. */
const ownRun = (ctx: Pick<NightContext, 'paid'>) => (ctx.paid ? ['--new-budget-run'] : []);

async function buildCat40(run: SuiteRun, ctx: Ctx, d: Cat40Dirs): Promise<string | null> {
  const cmds = cat40Commands(run, ctx, d.world, { ...d, cells: '' }, ctx.slots);
  if (!existsSync(d.world)) {
    for (const cmd of cmds.world) {
      const r = await runChild({ cmd, env: keylessEnv(), log: join(d.slots, 'world.log'), signal: ctx.signal });
      if (r.code !== 0) return `world build exited ${r.code ?? r.signal}: ${r.tail.split('\n').at(-1)}`;
    }
  }
  const marker = join(d.slots, `.built-${ctx.slots.sha ?? ctx.sha}${ctx.fake ? '-keyless' : ''}`);
  if (existsSync(marker)) return null;
  const env = envFor(ctx, run.suite, ['anthropic', 'openai', 'voyage']);
  const build = (i: number) => runChild({ cmd: [...cmds.slots[i], ...ownRun(ctx)], env, log: join(d.slots, `slots-${i}.log`), signal: ctx.signal });
  const built = await Promise.all(cmds.slots.map((_, i) => build(i)));
  const again = built.flatMap((r, i) => (r.code !== 0 && !ctx.signal?.aborted ? [i] : []));
  if (again.length) {
    ctx.log(`${run.suite.id}: slot build ${again.join(', ')} exited non-zero; rerunning once (a slot with a snapshot is not rebuilt)`);
    await Promise.all(again.map(async i => { built[i] = await build(i); }));
  }
  const failed = built.filter(r => r.code !== 0);
  if (failed.length) return failed.map(r => `slot build exited ${r.code ?? r.signal}: ${r.tail.split('\n').at(-1)}`).join('; ');
  writeFileSync(marker, new Date().toISOString() + '\n');
  return null;
}

export function cat40ArmFlags(arm: ArmName, hintFile: string | null): string[] {
  if (arm === 'cap2x') return ['--max-turns', String(ARMS.cap2x.turnCap)];
  if (arm === 'batch') return ['--gbrain-instructions-file', hintFile!];
  return [];
}

/**
 * Cat 40's follow-up arms (cap2x, batch) rerun only the items base missed for either agent (some gold not delivered, or
 * a wrong answer). The turn-cap test asks what more turns or batch reads recover; the items base already answered
 * would cost about half of each arm and can only show a follow-up arm doing worse, which this loop does not measure.
 */
/** Why a run dir can't take this run: it holds another build's rows, or rows from the other mode (keyless or paid). */
export function resumeRefusal(recorded: { sha?: string; fake?: boolean; slots_from?: { sha: string } | null } | null, now: { sha: string; fake: boolean; slotsSha?: string | null }, dir: string, label: string): string | null {
  if (!recorded) return null;
  if ((recorded.slots_from?.sha ?? null) !== (now.slotsSha ?? null)) return `${dir} holds cells served on brains built by ${recorded.slots_from?.sha.slice(0, 12) ?? 'the build itself'}, and this run's brains come from ${now.slotsSha?.slice(0, 12) ?? 'the build itself'}; pass a new --out`;
  if (recorded.sha && recorded.sha !== now.sha) return `${dir} holds a run of ${label} at ${recorded.sha.slice(0, 12)}, but ${label} is now ${now.sha.slice(0, 12)}; pass a new --out so the old rows aren't scored as the new build`;
  if (recorded.fake !== now.fake) return `${dir} holds a ${recorded.fake ? 'keyless (--fake)' : 'paid'} run, and this run is ${now.fake ? 'keyless' : 'paid'}; pass a new --out, because keyless and paid rows must not share a run dir`;
  return null;
}

export function followUpRun(run: SuiteRun, base: ItemRow[]): SuiteRun {
  const ids = new Set(base.filter(missed).map(r => r.item));
  return { ...run, items: run.items.filter(i => ids.has(i.id)) };
}

export function cat40FollowUp(run: SuiteRun, ctx: Pick<Ctx, 'night' | 'ref' | 'sha' | 'fake' | 'label' | 'dir'>, world: string): SuiteRun {
  return followUpRun(run, cat40Items(run, ctx, 'base', join(ctx.dir, 'base', run.suite.id, 'cells'), world).items);
}

async function runCat40Arm(full: SuiteRun, ctx: Ctx, arm: ArmName, d: Cat40Dirs, armDir: string): Promise<string | null> {
  const run = arm === 'base' ? full : cat40FollowUp(full, ctx, d.world);
  ctx.log(`${run.suite.id} ${arm}: ${run.items.length} items x ${run.readers.length} agents x k ${run.k}${arm === 'base' ? '' : ` (the items base missed, of ${full.items.length})`}`);
  if (!run.items.length) return null;
  const cells = join(armDir, run.suite.id, 'cells');
  mkdirSync(cells, { recursive: true });
  let hint: string | null = null;
  if (arm === 'batch') {
    const served = join(ctx.dir, 'base', run.suite.id, 'cells', 'served-instructions.txt');
    if (!existsSync(served)) return `batch needs base's served instructions at ${served}; run base first`;
    hint = join(cells, 'instructions-batch.txt');
    writeFileSync(hint, `${readFileSync(served, 'utf8').replace(/\n+$/, '')}\n\n${BATCH_HINT}\n`);
  }
  const cmd = [...cat40Commands(run, ctx, d.world, { ...d, cells }, ctx.slots).cells, ...cat40ArmFlags(arm, hint), ...ownRun(ctx)];
  const r = await runChild({ cmd, env: envFor(ctx, run.suite, ['anthropic', 'openai', 'voyage']), log: join(cells, '..', 'cells.log'), signal: ctx.signal });
  return r.code === 0 ? null : `cells exited ${r.code ?? r.signal}: ${r.tail.split('\n').slice(-3).join(' ')}`;
}

/** Flags that never reach a cell, or that differ between two builds by design (the build and its brains are named by gbrain_commit and slot_commit). */
const SETUP_IGNORED_FLAGS = new Set(['--out', '--world', '--arms', '--models', '--budget-ledger', '--concurrency', '--transcripts', '--order', '--accept-freeze-drift',
  '--tasks', '--gbrain-ref', '--gbrain-repo', '--gbrain-root', '--slot-ref', '--slots']);

/**
 * A digest of what a Cat 40 cells dir's cells ran under, apart from the gbrain build itself: the world, the commit that
 * built the brains, the Hard identity, turn and tool limits, judge, scorer and evaluator code (experiment.json), the
 * served instructions, the served tool names and every flag that reaches a cell. Null when experiment.json is missing.
 */
export function cat40Setup(cellsDir: string): string | null {
  const exp = join(cellsDir, 'experiment.json');
  if (!existsSync(exp)) return null;
  const e = JSON.parse(readFileSync(exp, 'utf8')) as { world_digest?: string; slot_commit?: string; hard?: Record<string, unknown>; flags?: Record<string, unknown> };
  const file = (f: string) => (existsSync(join(cellsDir, f)) ? readFileSync(join(cellsDir, f), 'utf8') : null);
  const instructions = file('served-instructions.txt'), tools = file('served-tools.json');
  const setup = {
    world_digest: e.world_digest ?? null, slot_commit: e.slot_commit ?? null, hard: e.hard ? { ...e.hard, runner_commit: null } : null,
    flags: Object.fromEntries(Object.entries(e.flags ?? {}).filter(([k]) => !SETUP_IGNORED_FLAGS.has(k)).sort(([a], [b]) => a.localeCompare(b))),
    instructions: instructions === null ? null : createHash('sha256').update(instructions).digest('hex'),
    tools: tools === null ? null : (JSON.parse(tools) as Array<{ name: string }>).map(t => t.name).sort(),
  };
  return createHash('sha256').update(JSON.stringify(setup)).digest('hex');
}

/** Items from a Cat 40 arm's cells: the nightly outcome row, plus each cell's transcript and turns. */
export function cat40Items(run: SuiteRun, ctx: Pick<Ctx, 'night' | 'ref' | 'sha' | 'fake' | 'label' | 'dir'> & Partial<NightContext>, arm: ArmName, cellsDir: string, world: string): { items: ItemRow[]; why: WhyRow[] } {
  const tasks = existsSync(world) ? new Map(((JSON.parse(readFileSync(world, 'utf8')) as { tasks: any[] }).tasks).filter(t => run.items.some(i => i.id === t.id)).map(t => [t.id, t])) : new Map();
  const rows = cat40Rows(run, ctx as NightContext, cellsDir, tasks);
  const files = ['attempts.jsonl', 'results.jsonl'].map(f => join(cellsDir, f)).filter(existsSync);
  const cells = canonicalCells(readRecords(files)).cells;
  const transcripts = new Map<string, Call[]>();
  const tp = join(cellsDir, 'transcripts.jsonl');
  if (existsSync(tp)) for (const line of readFileSync(tp, 'utf8').split('\n').filter(Boolean)) { const t = JSON.parse(line); transcripts.set(t.attempt_id ?? t.key, t.tools ?? []); }
  const items: ItemRow[] = [], why: WhyRow[] = [];
  const setup = cat40Setup(cellsDir);
  for (const o of rows) {
    const cell = cells.find(c => c.task === o.item && (ctx.fake ? true : c.model === o.reader) && c.repeat + 1 === o.trial);
    const raw = (cell?.raw ?? {}) as Record<string, any>;
    const calls = cell ? transcripts.get(cell.attempt_id) ?? transcripts.get(cell.key) ?? null : null;
    const turns = Array.isArray(raw.sessions) ? raw.sessions.reduce((n: number, s: any) => n + (s.run?.turns ?? 0), 0) : raw.run?.turns ?? null;
    const gold = [...((o.evidence.evidence_cited as string[]) ?? []), ...((o.evidence.missed_evidence as string[]) ?? [])];
    const row = agentItem(o, { arm, ref: ctx.label, gold, calls, turns, turnCap: raw.experiment?.max_turns ?? ARMS[arm].turnCap, setup });
    items.push(row);
    if (missed(row) && calls) why.push(agentWhy(row, calls));
  }
  return { items, why };
}

// ─── QA ─────────────────────────────────────────────────────────────

const providerOf = (model: string) => model.slice(0, model.indexOf(':')) as Provider;

export function qaArmCommand(run: SuiteRun, ctx: NightContext, reader: string, ids: string, out: string, arm: ArmName, baseOut: string): string[] {
  const cmd = qaCommand(run, ctx, reader, ids, out);
  return arm === 'cap2x' && !ctx.fake ? [...cmd, '--retrieved-from', baseOut, '--qa-sessions', String(ARMS.cap2x.qaSessions)] : cmd;
}

/** A rerank timeout stops memory-qa without a row for that question (RERANKER_INACTIVE); rerunning resumes it. */
export const QA_RERANK_ATTEMPTS = 3;
export function rerankTimedOut(out: string): boolean {
  const p = join(out, 'receipt.json');
  if (!existsSync(p)) return false;
  const refusal = (JSON.parse(readFileSync(p, 'utf8')) as { refusal?: { code?: string; message?: string } }).refusal;
  return refusal?.code === 'RERANKER_INACTIVE' && /rerank_failed: timeout/.test(refusal.message ?? '');
}

async function runQaArm(run: SuiteRun, ctx: Ctx, arm: ArmName, armDir: string): Promise<string[]> {
  const errors = await Promise.all((ctx.fake ? ['fake'] : run.readers as string[]).map(async reader => {
    const dir = join(armDir, run.suite.id, slug(reader));
    mkdirSync(dir, { recursive: true });
    const ids = join(dir, 'ids.txt');
    writeFileSync(ids, run.items.map(i => i.id).join('\n') + '\n');
    const baseOut = join(ctx.dir, 'base', run.suite.id, slug(reader), 'out');
    if (arm === 'cap2x' && !ctx.fake && !existsSync(join(baseOut, 'rows.ndjson'))) return `${reader}: cap2x replays base's ranked lists from ${baseOut}; run base first`;
    const judge = ctx.fake ? null : judgeFor(reader);
    const providers: Provider[] = ctx.fake ? [] : [providerOf(qualifiedModel(reader)), providerOf(judge!), 'openai', 'voyage'];
    let r: Awaited<ReturnType<typeof runChild>>;
    for (let attempt = 1; ; attempt++) {
      r = await runChild({ cmd: qaArmCommand(run, ctx, reader, ids, join(dir, 'out'), arm, baseOut), env: envFor(ctx, run.suite, providers, { GBRAIN_EVALS_QA_CACHE: ctx.cache.chatDir }), log: join(dir, 'run.log'), signal: ctx.signal });
      if (r.code === 0 || attempt >= QA_RERANK_ATTEMPTS || ctx.signal?.aborted || !rerankTimedOut(join(dir, 'out'))) break;
      ctx.log(`${run.suite.id} ${arm} ${reader}: a rerank request timed out; resuming (attempt ${attempt + 1} of ${QA_RERANK_ATTEMPTS})`);
    }
    return r.code === 0 ? null : `${reader}: memory-qa exited ${r.code ?? r.signal}: ${r.tail.split('\n').at(-1)}`;
  }));
  return errors.filter((e): e is string => e !== null);
}

/** Items from a QA arm: the nightly outcome rows, with the ranked list and how many sessions the reader got. */
export function qaItems(run: SuiteRun, ctx: Pick<Ctx, 'night' | 'ref' | 'sha' | 'fake' | 'label' | 'dir'> & Partial<NightContext>, arm: ArmName, armDir: string): { items: ItemRow[]; why: WhyRow[] } {
  const benchmark = String(run.suite.config?.benchmark);
  const want = new Set(run.items.map(i => i.id));
  const questions = new Map(loadCorpus(benchmark).questions.filter(q => want.has(q.id)).map(q => [q.id, q]));
  const items: ItemRow[] = [], why: WhyRow[] = [];
  for (const reader of ctx.fake ? ['fake'] : run.readers as string[]) {
    const out = join(armDir, run.suite.id, slug(reader), 'out');
    const raw = existsSync(join(out, 'rows.ndjson')) ? readFileSync(join(out, 'rows.ndjson'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, any>) : [];
    const sessions = new Map(raw.map(r => [String(r.id), typeof r.qa_sessions === 'number' ? r.qa_sessions : null]));
    const rows: Outcome[] = latestRowPerItem(qaRows(run, ctx as NightContext, reader, out, ctx.fake ? null : judgeFor(reader), questions), run.items.map(i => i.id));
    for (const o of rows) {
      const ranked = Array.isArray(o.evidence.retrieved) ? (o.evidence.retrieved as string[]) : null;
      const n = sessions.get(o.item) ?? ARMS[arm].qaSessions;
      const row = qaItem(o, { arm, ref: ctx.label, gold: questions.get(o.item)?.gold ?? [], ranked, sessions: n });
      items.push(row);
      if (missed(row) && ranked) why.push(qaWhy(row, ranked, n));
    }
  }
  return { items, why };
}

// ─── Report ─────────────────────────────────────────────────────────

const p = (x: number | null) => (x === null ? 'n/a' : `${(100 * x).toFixed(1)}%`);
const f1 = (x: number | null) => (x === null ? 'n/a' : x.toFixed(1));
const usd = (x: number | null) => (x === null ? 'n/a' : `$${x.toFixed(2)}`);

export interface Power { suite: string; rows: number; noise: number; noise_source: string; min_detectable: number }

export function powerTable(items: ItemRow[], agentNoise: number): Power[] {
  const base = items.filter(r => r.arm === 'base' && r.harness === null);
  const measured = trialDiscordance(base.filter(r => r.kind === 'agent'));
  const agentD0 = measured && measured.pairs >= 20 ? measured.share : agentNoise;
  const agentSrc = measured && measured.pairs >= 20 ? `measured here, ${measured.pairs} trial pairs` : 'nightly 2026-11-16, Cat 40 world M, k = 3 (144 trial pairs)';
  const out: Power[] = [];
  const suites = [...new Set(base.map(r => r.suite))];
  for (const s of suites) {
    const rows = base.filter(r => r.suite === s);
    const agent = rows[0]!.kind === 'agent';
    // QA delivery is the reader-independent ranked list, so one row per item counts; agent rows are per reader and trial.
    const n = agent ? rows.length : new Set(rows.map(r => r.item)).size;
    out.push({ suite: s, rows: n, noise: agent ? agentD0 : 0, noise_source: agent ? agentSrc : 'deterministic retrieval (same build, same ranked list)', min_detectable: minDetectable(n, agent ? agentD0 : 0) });
  }
  const total = out.reduce((n, x) => n + x.rows, 0);
  const pooledNoise = total ? out.reduce((n, x) => n + x.rows * x.noise, 0) / total : 0;
  out.push({ suite: 'pooled', rows: total, noise: pooledNoise, noise_source: 'row-weighted mean of the suites', min_detectable: minDetectable(total, pooledNoise) });
  return out;
}

export function renderReport(o: { label: string; sha: string; version: string | null; arms: ArmName[]; slices: Slice[]; power: Power[]; items: ItemRow[]; why: WhyRow[]; errors: string[]; spend: Record<string, unknown> | null; fake: boolean; slotsFrom?: { ref: string; sha: string } | null }): string {
  const L: string[] = [];
  L.push(`# Multi-evidence dev loop: gbrain ${o.label} (${o.sha.slice(0, 12)}${o.version ? `, version ${o.version}` : ''})`, '');
  if (o.slotsFrom) L.push(`Cat 40 cells ran this build's server on brains built by ${o.slotsFrom.ref} (${o.slotsFrom.sha.slice(0, 12)}).`, '');
  if (o.fake) L.push('**Keyless run (--fake): scripted agents and a fake QA system. These numbers test the plumbing, never gbrain.**', '');
  L.push('Questions whose answer needs two or more gold items. "Delivered" is gold gbrain put in front of the model: for an agent, gold that any tool result names; for a reader, gold in the sessions it was given.', '');
  L.push('## Arms', '', ...o.arms.map(a => `- **${a}**: ${ARMS[a].about}`), '');
  L.push('## Results', '', '| Suite | Reader | Arm | n | All gold delivered | Some | None | Gold delivered | Cut by packing | Hit turn cap | Turns | Calls | Correct | Cost | Cost per correct |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  const followUps = o.slices.filter(s => s.arm !== 'base' && o.items.some(r => r.suite === s.suite && r.kind === 'agent'));
  for (const s of o.slices.filter(x => !followUps.includes(x))) L.push(`| ${s.suite} | ${s.reader} | ${s.arm} | ${s.n}${s.harness ? ` (+${s.harness} harness)` : ''} | ${p(s.all_delivered)} | ${p(s.some_delivered)} | ${p(s.none_delivered)} | ${p(s.gold_delivered_share)} | ${p(s.cut_share)} | ${p(s.hit_cap)} | ${f1(s.mean_turns)} | ${f1(s.mean_calls)} | ${p(s.correct)} | ${usd(s.cost_usd)} | ${usd(s.cost_per_correct)} |`);
  L.push('');
  if (followUps.length) L.push(`Cat 40's ${[...new Set(followUps.map(s => s.arm))].join(' and ')} rows ran only on the items base missed, so they appear below as recovery among base misses and never as an arm's accuracy.`, '');
  if (o.arms.length > 1) {
    L.push('## Turn-cap and breadth test', '', 'Items base missed (wrong answer, or some gold not delivered), and how many of them each other arm recovered for the same item and reader. Cat 40 ran cap2x and batch only on these items, so losses on items base got right were not measured: read each cell as recovered among base misses, never as accuracy or a difference against base.', '', '| Suite | Reader | Base misses (n) | At base, hit the cap | cap2x: all gold delivered | cap2x: correct | batch: all gold delivered | batch: correct |', '|---|---|---|---|---|---|---|---|');
    const key = (r: ItemRow) => `${r.suite}|${r.item}|${r.reader}|${r.trial}`;
    const by = (arm: ArmName) => new Map(o.items.filter(r => r.arm === arm && r.harness === null).map(r => [key(r), r]));
    const base = by('base'), cap = by('cap2x'), batch = by('batch');
    const groups = new Map<string, ItemRow[]>();
    for (const r of base.values()) if (missed(r)) { const k = `${r.suite}|${r.reader}`; if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(r); }
    for (const [k, rows] of groups) {
      const [suite, reader] = k.split('|');
      const frac = (m: Map<string, ItemRow>, pick: (r: ItemRow) => boolean) => { const had = rows.filter(r => m.has(key(r))); return had.length ? `${had.filter(r => pick(m.get(key(r))!)).length}/${had.length}` : 'n/a'; };
      const capped = rows[0]!.kind === 'agent' ? `${rows.filter(r => r.hit_cap).length}/${rows.length}` : 'n/a';
      L.push(`| ${suite} | ${reader} | ${rows.length} | ${capped} | ${frac(cap, r => r.coverage === 'all')} | ${frac(cap, r => r.correct === true)} | ${frac(batch, r => r.coverage === 'all')} | ${frac(batch, r => r.correct === true)} |`);
    }
    const used = (arm: ArmName) => {
      const cells = o.items.filter(r => r.arm === arm && r.kind === 'agent' && r.harness === null && r.assemble_calls !== null);
      return `${arm} ${cells.filter(r => r.assemble_calls! > 0).length} of ${cells.length} cells (${cells.reduce((n, r) => n + r.assemble_calls!, 0)} calls)`;
    };
    if (o.arms.includes('batch')) L.push('', `Cells that called assemble_evidence at least once: ${used('base')}; ${used('batch')}.`);
    L.push('');
  }
  const agentRows = o.items.filter(r => r.kind === 'agent' && r.harness === null && r.result_chars !== null);
  if (agentRows.length) {
    L.push('## Tool results and batch reads', '', 'Characters of every tool result the agent received, and get_page calls that read several pages with `slugs`.', '', '| Suite | Reader | Arm | Cells | Mean tool-result characters | Cells using slugs | Slugs calls | Slugs calls that read 2+ pages | Cells with omitted |', '|---|---|---|---|---|---|---|---|---|');
    const groups = new Map<string, ItemRow[]>();
    for (const r of agentRows) { const k = `${r.suite}|${r.reader}|${r.arm}`; if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(r); }
    for (const [k, rows] of groups) {
      const [suite, reader, arm] = k.split('|');
      const sum = (pick: (r: ItemRow) => number | null) => rows.reduce((n, r) => n + (pick(r) ?? 0), 0);
      L.push(`| ${suite} | ${reader} | ${arm} | ${rows.length} | ${Math.round(sum(r => r.result_chars) / rows.length)} | ${rows.filter(r => (r.slugs_calls ?? 0) > 0).length} | ${sum(r => r.slugs_calls)} | ${sum(r => r.slugs_multi)} | ${rows.filter(r => (r.omitted_calls ?? 0) > 0).length} |`);
    }
    L.push('');
  }
  L.push('## What the set can detect', '', 'The smallest paired change in "all gold delivered" between two gbrain builds that this set detects at 80% power (two-sided, 5%), given how often two runs of one build disagree.', '', '| Suite | Rows | Same-build disagreement | Source | Smallest detectable change |', '|---|---|---|---|---|');
  for (const x of o.power) L.push(`| ${x.suite} | ${x.rows} | ${p(x.noise)} | ${x.noise_source} | ${p(x.min_detectable)} |`);
  L.push('', `A 5-point change is ${o.power.at(-1) && o.power.at(-1)!.min_detectable <= 0.05 ? 'within' : 'beyond'} what the pooled set detects.`, '');
  L.push('## Missed items', '', `${o.why.length} missed rows (wrong answer or some gold not delivered) are in why.jsonl, each with every call, what it returned and each gold item's fate.`, '');
  const fates = new Map<string, number>();
  for (const w of o.why) for (const g of w.gold) fates.set(`${w.suite}|${w.arm}|${g.fate}`, (fates.get(`${w.suite}|${w.arm}|${g.fate}`) ?? 0) + 1);
  if (fates.size) { L.push('| Suite | Arm | Gold fate | Gold items |', '|---|---|---|---|'); for (const [k, n] of [...fates].sort()) { const [s, a, f] = k.split('|'); L.push(`| ${s} | ${a} | ${f} | ${n} |`); } L.push(''); }
  if (o.spend) L.push('## Spend', '', '```json', JSON.stringify(o.spend, null, 2), '```', '');
  if (o.errors.length) L.push('## Errors', '', ...o.errors.map(e => `- ${e}`), '');
  return L.join('\n');
}

// ─── Main ───────────────────────────────────────────────────────────

function score(dir: string, runs: SuiteRun[], ctx: Pick<Ctx, 'night' | 'ref' | 'sha' | 'fake' | 'label' | 'dir'>, arms: ArmName[], world: string): { items: ItemRow[]; why: WhyRow[] } {
  const items: ItemRow[] = [], why: WhyRow[] = [];
  for (const arm of arms) for (const run of runs) {
    const armDir = join(dir, arm);
    if (run.suite.kind === 'agent') { const r = cat40Items(run, ctx, arm, join(armDir, run.suite.id, 'cells'), world); items.push(...r.items); why.push(...r.why); }
    else if (ARMS[arm].qaSessions !== null) { const r = qaItems(run, ctx, arm, armDir); items.push(...r.items); why.push(...r.why); }
  }
  return { items, why };
}

function writeOutputs(dir: string, o: Parameters<typeof renderReport>[0]): void {
  writeFileSync(join(dir, 'items.jsonl'), o.items.map(r => JSON.stringify(r)).join('\n') + (o.items.length ? '\n' : ''));
  writeFileSync(join(dir, 'why.jsonl'), o.why.map(r => JSON.stringify(r)).join('\n') + (o.why.length ? '\n' : ''));
  writeFileSync(join(dir, 'summary.json'), JSON.stringify({ schema: 'multi-evidence-summary/1', gbrain: { ref: o.label, sha: o.sha, version: o.version, slots_from: o.slotsFrom ?? null }, arms: o.arms, fake: o.fake, slices: o.slices, power: o.power, spend: o.spend, errors: o.errors }, null, 2) + '\n');
  writeFileSync(join(dir, 'report.md'), renderReport(o));
}

export async function main(argv: readonly string[]): Promise<number> {
  const a = parseArgs(argv);
  const me = loadMeDevSet();
  if (a.report) {
    const run = JSON.parse(readFileSync(join(a.report, 'run.json'), 'utf8'));
    const runs = planRuns(me, run.args);
    const ctx = { night: run.night, ref: run.label, sha: run.sha, fake: run.fake, label: run.label, dir: a.report };
    const { items, why } = score(a.report, runs, ctx, run.args.arms, run.world);
    const o = { label: run.label, sha: run.sha, version: run.version, arms: run.args.arms, slices: slices(items), power: powerTable(items, a.agentNoise), items, why, errors: run.errors ?? [], spend: run.spend ?? null, fake: run.fake, slotsFrom: run.slots_from ?? null };
    writeOutputs(a.report, o);
    console.log(JSON.stringify({ dir: a.report, items: items.length, missed: why.length }));
    return 0;
  }
  const release = a.gbrain ? null : newestRelease(a.clone, a.fetch);
  const label = a.gbrain ?? release!.tag;
  const sha = release?.sha ?? resolveGbrainRef(a.clone, a.gbrain!);
  const slotsFrom = a.slotsFrom ? { ref: a.slotsFrom, sha: resolveGbrainRef(a.clone, a.slotsFrom) } : null;
  const runs = planRuns(me, a);
  if (!runs.length) throw new Error('no suite and item matches --suites and --items');
  const dir = join(a.out!, slug(label));
  const refusal = resumeRefusal(existsSync(join(dir, 'run.json')) ? JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) : null, { sha, fake: a.fake, slotsSha: slotsFrom?.sha ?? null }, dir, label);
  if (refusal) throw new Error(refusal);
  mkdirSync(dir, { recursive: true });
  const gut = resolveGbrainUnderTest(`${a.clone}@${sha}`);
  let paid: { runId: string; ledger: string } | null = null, opened = false;
  if (!a.fake) {
    if (!a.budgetLedger) throw new PaidArmRefusal('--paid needs --budget-ledger <path>');
    let runId = a.budgetRunId;
    if (!runId) {
      if (a.budgetUsd === null) throw new PaidArmRefusal('--paid needs --budget-usd <n> to open a ledger run, or --budget-run-id <id> to join one');
      const o = budgetOptionsFrom(argv);
      runId = BudgetRun.open({ runner: `multi-evidence:${label}`, budgetUsd: a.budgetUsd, ledgerPath: a.budgetLedger, programCapUsd: o.programCapUsd, programCapSource: o.programCapSource }).runId;
      opened = true;
    }
    requirePaidArm(['--paid', '--budget-run-id', runId], { arm: 'the multi-evidence dev loop', estimateUsd: null, ledgerPath: a.budgetLedger });
    paid = { runId, ledger: a.budgetLedger };
  }
  const cacheRoot = join(a.out!, 'cache');
  const world = join(cacheRoot, 'cat40', 'world-m', 'world', 'world.json');
  const abort = new AbortController();
  for (const s of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) process.on(s, () => abort.abort());
  const ctx: Ctx = {
    label, night: new Date().toISOString().slice(0, 10), ref: label, sha, dir, tier: 'matrix', fake: a.fake, clone: a.clone, overlayRoot: gut.root,
    worktree: () => Promise.reject(new Error('the dev loop runs no refresh-barrier suite')), overlayFor: () => Promise.reject(new Error('the dev loop runs no smoke suite')),
    cache: new NightlyCache(cacheRoot), paid, pg: { admin: null, template: null, pg15Admin: null }, smokeRefs: { previous: null, old: null },
    cat40SlotAllowanceUsd: a.fake ? null : a.slotAllowanceUsd, log: line => console.error(`[multi-evidence] ${line}`), signal: abort.signal,
    slots: { ...(slotsFrom ? { sha: slotsFrom.sha } : {}), ...(a.cat40Slots !== null ? { n: a.cat40Slots } : {}) },
  };
  const runInfo = { schema: 'multi-evidence-run/1', label, sha, version: gut.version, night: ctx.night, fake: a.fake, world, devset_digest: me.digest, budget: paid, slots_from: slotsFrom,
    args: { arms: a.arms, readers: a.readers, suites: a.suites, items: a.items, k: a.k, cat40_slots: a.cat40Slots }, started_at: new Date().toISOString() } as Record<string, any>;
  writeFileSync(join(dir, 'run.json'), JSON.stringify(runInfo, null, 2) + '\n');
  ctx.log(`gbrain ${label} ${sha.slice(0, 12)} (${gut.version})${slotsFrom ? ` on brains built by ${slotsFrom.ref} ${slotsFrom.sha.slice(0, 12)}` : ''}; arms ${a.arms.join(', ')}; ${runs.map(r => `${r.suite.id} ${r.items.length}`).join(', ')}; ${a.fake ? 'keyless' : `ledger run ${paid!.runId}`}`);

  const errors: string[] = [];
  const agentRuns = runs.filter(r => r.suite.kind === 'agent'), qaRuns = runs.filter(r => r.suite.kind === 'qa');
  const cat40 = async () => {
    for (const run of agentRuns) {
      const d: Cat40Dirs = { world, root: join(cacheRoot, 'cat40', 'gbrain'), slots: join(dir, 'slots', run.suite.id) };
      mkdirSync(d.slots, { recursive: true });
      const built = await buildCat40(run, ctx, d);
      if (built) { errors.push(`${run.suite.id}: ${built}`); continue; }
      let baseError: string | null = null;
      for (const arm of a.arms) {
        if (arm !== 'base' && baseError) { errors.push(`${run.suite.id} ${arm}: not run, because base did not finish (the follow-up items come from a complete base; rerun to finish base first)`); continue; }
        const e = await runCat40Arm(run, ctx, arm, d, join(dir, arm));
        if (e) errors.push(`${run.suite.id} ${arm}: ${e}`);
        if (arm === 'base') baseError = e;
      }
    }
  };
  const qa = async () => {
    for (const arm of a.arms.filter(x => ARMS[x].qaSessions !== null)) {
      const e = await Promise.all(qaRuns.map(run => { ctx.log(`${run.suite.id} ${arm}: ${run.items.length} items x ${run.readers.length} readers`); return runQaArm(run, ctx, arm, join(dir, arm)); }));
      errors.push(...e.flat());
    }
  };
  const started = Date.now();
  const heartbeat = setInterval(() => {
    const spent = paid ? ledgerStatus({ ledgerPath: paid.ledger, runId: paid.runId }).run?.committed_usd : null;
    ctx.log(`still running: ${Math.round((Date.now() - started) / 60_000)} min${typeof spent === 'number' ? `, $${spent.toFixed(2)} committed` : ''}`);
  }, HEARTBEAT_MS);
  try {
    await Promise.all([cat40(), qa()]);
  } finally {
    clearInterval(heartbeat);
    if (paid && opened) closeRun(paid.ledger, paid.runId);
  }

  let spend: Record<string, unknown> | null = null;
  if (paid) {
    const st = ledgerStatus({ ledgerPath: paid.ledger, runId: paid.runId });
    spend = { ledger_run: paid.runId, committed_usd: st.run?.committed_usd ?? null, budget_usd: st.run?.budget_usd ?? null, closed: opened };
  }
  runInfo.finished_at = new Date().toISOString(); runInfo.errors = errors; runInfo.spend = spend;
  writeFileSync(join(dir, 'run.json'), JSON.stringify(runInfo, null, 2) + '\n');
  const { items, why } = score(dir, runs, ctx, a.arms, world);
  writeOutputs(dir, { label, sha, version: gut.version, arms: a.arms, slices: slices(items), power: powerTable(items, a.agentNoise), items, why, errors, spend, fake: a.fake, slotsFrom });
  console.log(JSON.stringify({ dir, items: items.length, missed: why.length, errors: errors.length, report: join(dir, 'report.md') }));
  return abort.signal.aborted ? 4 : errors.length ? 5 : 0;
}

if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (error) {
    console.error((error as Error).message);
    process.exit(error instanceof PaidArmRefusal ? 2 : 1);
  }
}
