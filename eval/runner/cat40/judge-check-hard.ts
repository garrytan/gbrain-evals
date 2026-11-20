/**
 * Cat 40 Hard claims-judge check (R78), for the newest-build re-measure: preregistration
 * docs/benchmarks/2026-11-19-cat40-hard-newest-preregistration.md, "Readers and judges". It asks whether each claims
 * judge (gpt-6.1-sol for Claude and particle-1 rows, claude-opus-5-5 for gpt-6.2-sol rows) tells a good answer from a
 * bad one on public world M (seed 20261021, the nightly's development set) before any counted number.
 *
 *   bun eval/runner/cat40/judge-check-hard.ts plan   --world <world M world.json> --cells <M results.jsonl> --out <dir> [--seed 1]
 *   bun eval/runner/cat40/judge-check-hard.ts run    --world <...> --out <dir> --judges gpt-6.1-sol,claude-opus-5-5
 *                                                    --paid-window <unit> --window-cap-usd <n> --budget-usd <n> --budget-ledger <file>
 *   bun eval/runner/cat40/judge-check-hard.ts report --out <dir> --judges <a,b>
 *
 *   Items     (a) construction: 6 tasks per family, seeded; for each, a good answer (the task's accepted value, every
 *             H1 member, the count, or every item's accepted value, citing the deciding documents) and a bad one (a value
 *             the task lists as wrong, an extra account in an H1 set, a count off by 3, or a wrong value for one item).
 *             The deterministic scorer must pass the good answer and fail the bad one, else the task is skipped. (b) real:
 *             40 submitted answers from world M's committed cells, 4 per family for each of claude-opus-5-5 and
 *             gpt-6.1-sol, seeded, with the recorded judgment kept for comparison.
 *   Grading   each judge grades every item with the production prompt (judge-hard.ts, cat40-hard-claims-v1). A
 *             malformed output is asked again once. Grades append to grades.jsonl, so a rerun resumes.
 *   Gates     per judge, on construction items, reading "at least one unsupported or contradicted claim" as bad:
 *             Cohen's kappa against the labels at least 0.6, at least 15 graded items in each class, and at most 1% of
 *             outputs still malformed after the retry. Agreement on real items is descriptive. report exits 3
 *             (JUDGE_CHECK_STOP) when a gate fails and 0 when all pass; report.json carries no dollar field (R79).
 *   Window    run spends real keys only with --paid-window and --window-cap-usd, and --budget-usd never above the window
 *             cap; it exits 2 before any request otherwise. Tests pass a fake call and never reach a provider.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HardTask, HardWorld } from '../../generators/hard/schema.ts';
import { budgetOptionsFrom, startPaidRun } from '../budget-ledger.ts';
import { seededRandom } from '../stats/paired.ts';
import { hardJudgePrompt, parseHardClaims, type HardClaims } from './judge-hard.ts';
import { runAgentText } from './loop.ts';
import { scoreHardTask } from './score-hard.ts';

export const FAMILIES = ['H1', 'H2', 'H3', 'H4', 'H5'] as const;
export const CONSTRUCT_PER_FAMILY = 6;
export const REAL_PER_FAMILY_READER = 4;
export const REAL_READERS = ['claude-opus-5-5', 'gpt-6.1-sol'] as const;
export const GATE = { kappa: 0.6, minPerClass: 15, maxMalformedShare: 0.01 } as const;

type Final = { answer: unknown; notes?: string; sources?: string[] };
export interface CheckItem {
  id: string; kind: 'construct' | 'real'; task: string; family: string; final: Final; text?: string;
  label?: 'good' | 'bad'; reader?: string; recorded_bad?: boolean | null;
}
export interface Grade { item: string; judge: string; claims: HardClaims | null; retried: boolean }

function shuffle<T>(xs: T[], rand: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function goodAnswer(task: HardTask): unknown {
  const g = task.gold;
  if (task.answer_kind === 'set') return JSON.stringify((g.members ?? []).map(m => m.names[0]));
  if (task.answer_kind === 'count') return String(g.count);
  if (task.answer_kind === 'values') return JSON.stringify((g.items ?? []).map(i => i.answer[0]));
  return g.answer?.[0];
}

function badAnswer(world: HardWorld, task: HardTask, rand: () => number): unknown {
  const g = task.gold;
  if (task.answer_kind === 'set') {
    const members = new Set((g.members ?? []).map(m => m.id));
    const others = world.entities.filter(e => !members.has(e.id));
    if (!others.length) return undefined;
    return JSON.stringify([...(g.members ?? []).map(m => m.names[0]), others[Math.floor(rand() * others.length)].name]);
  }
  if (task.answer_kind === 'count') return g.count === undefined ? undefined : String(g.count + 3);
  if (task.answer_kind === 'values') {
    const items = g.items ?? [];
    if (!items.length || !items[0].wrong.length) return undefined;
    return JSON.stringify(items.map((i, n) => (n === 0 ? i.wrong[0] : i.answer[0])));
  }
  return g.wrong?.[0];
}

const scores = (world: HardWorld, task: HardTask, final: Final) => scoreHardTask(world, task, [{ final: final as never, stop: 'submitted' }]).success;

/** The construction items: a good and a bad answer for CONSTRUCT_PER_FAMILY tasks per family, each checked by the scorer. */
export function constructItems(world: HardWorld, seed: number): { items: CheckItem[]; skipped: string[] } {
  const rand = seededRandom(seed);
  const items: CheckItem[] = [], skipped: string[] = [];
  for (const family of FAMILIES) {
    const tasks = shuffle(world.tasks.filter(t => t.family === family).sort((a, b) => a.id.localeCompare(b.id)), rand);
    let taken = 0;
    for (const task of tasks) {
      if (taken === CONSTRUCT_PER_FAMILY) break;
      const notes = `Based on ${task.gold.evidence.join(', ')}.`;
      const good: Final = { answer: goodAnswer(task), notes, sources: task.gold.evidence };
      const badValue = badAnswer(world, task, rand);
      const bad: Final = { answer: badValue, notes, sources: task.gold.evidence };
      if (good.answer === undefined || badValue === undefined || !scores(world, task, good) || scores(world, task, bad)) { skipped.push(task.id); continue; }
      items.push({ id: `c-${task.id}-good`, kind: 'construct', task: task.id, family, final: good, label: 'good' });
      items.push({ id: `c-${task.id}-bad`, kind: 'construct', task: task.id, family, final: bad, label: 'bad' });
      taken++;
    }
  }
  return { items, skipped };
}

interface CellRow { model: string; arm?: string; task: string; family: string; stop: string; run?: { final?: Final | null; text?: string }; claims?: HardClaims | null }

/** The real items: submitted answers from committed cells, REAL_PER_FAMILY_READER per family and reader, seeded. */
export function realItems(rows: CellRow[], seed: number): CheckItem[] {
  const rand = seededRandom(seed + 1);
  const out: CheckItem[] = [];
  for (const family of FAMILIES) for (const reader of REAL_READERS) {
    const pool = rows.filter(r => r.family === family && r.model === reader && r.stop !== 'harness_error' && r.run?.final)
      .sort((a, b) => a.task.localeCompare(b.task));
    for (const r of shuffle(pool, rand).slice(0, REAL_PER_FAMILY_READER)) {
      out.push({ id: `r-${reader}-${r.arm ?? 'arm'}-${r.task}`, kind: 'real', task: r.task, family, final: r.run!.final!, text: r.run!.text, reader,
        recorded_bad: r.claims ? r.claims.unsupported + r.claims.contradicted > 0 : null });
    }
  }
  const dup = out.find((item, i) => out.findIndex(o => o.id === item.id) !== i);
  if (dup) throw new Error(`real item id ${dup.id} is drawn twice; every real item needs its own id`);
  return out;
}

const readJsonl = <T>(p: string): T[] => (existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as T) : []);

/** Grade every item with every judge, skipping grades already in grades.jsonl. */
export async function gradeAll(world: HardWorld, items: CheckItem[], judges: string[], out: string,
  call: (model: string, system: string, user: string) => Promise<{ text: string }> = runAgentText): Promise<number> {
  const gradesPath = join(out, 'grades.jsonl');
  const done = new Set(readJsonl<Grade>(gradesPath).map(g => `${g.judge}|${g.item}`));
  const byId = new Map(world.tasks.map(t => [t.id, t]));
  let n = 0;
  for (const judge of judges) for (const item of items) {
    if (done.has(`${judge}|${item.id}`)) continue;
    const task = byId.get(item.task);
    if (!task) throw new Error(`item ${item.id} names task ${item.task}, which the world lacks`);
    const prompt = hardJudgePrompt(world, task, { final: item.final as never, text: item.text });
    if (!prompt) throw new Error(`item ${item.id} has no answer text to judge`);
    let claims = parseHardClaims((await call(judge, prompt.system, prompt.user)).text), retried = false;
    if (!claims) { retried = true; claims = parseHardClaims((await call(judge, prompt.system, prompt.user)).text); }
    appendFileSync(gradesPath, JSON.stringify({ item: item.id, judge, claims, retried } satisfies Grade) + '\n');
    n++;
  }
  return n;
}

export function cohenKappa(pairs: Array<[boolean, boolean]>): number | null {
  const n = pairs.length;
  if (!n) return null;
  const po = pairs.filter(([a, b]) => a === b).length / n;
  const pa = pairs.filter(([a]) => a).length / n, pb = pairs.filter(([, b]) => b).length / n;
  const pe = pa * pb + (1 - pa) * (1 - pb);
  return pe === 1 ? (po === 1 ? 1 : 0) : (po - pe) / (1 - pe);
}

const isBad = (c: HardClaims) => c.unsupported + c.contradicted > 0;

export interface JudgeReport {
  judge: string; construct_graded: number; good_graded: number; bad_graded: number; malformed: number; retried: number;
  kappa: number | null; catch_rate: number | null; false_fail_rate: number | null;
  real_graded: number; real_agreement_with_recorded: number | null; passes: boolean; failures: string[];
}

export function report(items: CheckItem[], grades: Grade[], judges: string[]): { judges: JudgeReport[]; real_pairwise_agreement: number | null; passes: boolean } {
  const byId = new Map(items.map(i => [i.id, i]));
  const reports = judges.map(judge => {
    const mine = grades.filter(g => g.judge === judge && byId.has(g.item));
    const gradedItems = new Set(mine.map(g => g.item)).size;
    const construct = mine.filter(g => byId.get(g.item)!.kind === 'construct');
    const parsed = construct.filter(g => g.claims);
    const pairs = parsed.map(g => [byId.get(g.item)!.label === 'bad', isBad(g.claims!)] as [boolean, boolean]);
    const good = pairs.filter(([l]) => !l), bad = pairs.filter(([l]) => l);
    const malformed = mine.filter(g => !g.claims).length;
    const real = mine.filter(g => byId.get(g.item)!.kind === 'real' && g.claims && byId.get(g.item)!.recorded_bad !== null);
    const kappa = cohenKappa(pairs);
    const failures: string[] = [];
    if (kappa === null || kappa < GATE.kappa) failures.push(`kappa ${kappa === null ? 'n/a' : kappa.toFixed(3)} < ${GATE.kappa}`);
    if (good.length < GATE.minPerClass || bad.length < GATE.minPerClass) failures.push(`graded good ${good.length}, bad ${bad.length}; each needs ${GATE.minPerClass}`);
    if (gradedItems < byId.size) failures.push(`graded ${gradedItems} of ${byId.size} items`);
    if (!mine.length || malformed / mine.length > GATE.maxMalformedShare) failures.push(`${malformed} of ${mine.length} outputs malformed after retry`);
    return {
      judge, construct_graded: pairs.length, good_graded: good.length, bad_graded: bad.length, malformed, retried: mine.filter(g => g.retried).length,
      kappa, catch_rate: bad.length ? bad.filter(([, j]) => j).length / bad.length : null,
      false_fail_rate: good.length ? good.filter(([, j]) => j).length / good.length : null,
      real_graded: real.length, real_agreement_with_recorded: real.length ? real.filter(g => isBad(g.claims!) === byId.get(g.item)!.recorded_bad).length / real.length : null,
      passes: failures.length === 0, failures,
    } satisfies JudgeReport;
  });
  let pairwise: number | null = null;
  if (judges.length === 2) {
    const [a, b] = judges.map(j => new Map(grades.filter(g => g.judge === j && g.claims && byId.get(g.item)?.kind === 'real').map(g => [g.item, isBad(g.claims!)])));
    const common = [...a.keys()].filter(k => b.has(k));
    pairwise = common.length ? common.filter(k => a.get(k) === b.get(k)).length / common.length : null;
  }
  return { judges: reports, real_pairwise_agreement: pairwise, passes: reports.length > 0 && reports.every(r => r.passes) };
}

if (import.meta.main) {
  const [cmd, ...argv] = process.argv.slice(2);
  const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const usage = (msg: string) => { console.error(`judge-check-hard: ${msg}`); process.exit(2); };
  const out = flag('--out') ?? usage('--out is required');
  const worldOf = () => JSON.parse(readFileSync(flag('--world') ?? usage('--world is required'), 'utf8')) as HardWorld;
  if (cmd === 'plan') {
    const world = worldOf(), seed = Number(flag('--seed') ?? 1);
    if (world.seed !== 20261021) usage(`--world must be world M (seed 20261021), got seed ${world.seed}`);
    const { items, skipped } = constructItems(world, seed);
    const real = realItems(readJsonl<CellRow>(flag('--cells') ?? usage('--cells is required')), seed);
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'items.json'), JSON.stringify({ seed, world_seed: world.seed, skipped, items: [...items, ...real] }, null, 1) + '\n');
    console.log(`planned ${items.length} construction items (${skipped.length} tasks skipped) and ${real.length} real items in ${join(out, 'items.json')}`);
  } else if (cmd === 'run') {
    const window = flag('--paid-window'), cap = Number(flag('--window-cap-usd')), budget = Number(flag('--budget-usd'));
    if (!window) usage('run needs --paid-window <unit>: judge calls are paid and run only inside a granted window');
    if (!(cap > 0) || !(budget > 0) || budget > cap) usage('run needs --window-cap-usd and --budget-usd, with the budget at or below the window cap');
    const judges = (flag('--judges') ?? usage('--judges is required')).split(',');
    if (judges.some(j => j.startsWith('particle'))) usage('particle-1 never judges');
    const world = worldOf();
    const { items } = JSON.parse(readFileSync(join(out, 'items.json'), 'utf8')) as { items: CheckItem[] };
    const { run, guard } = startPaidRun('cat40-hard-judge-check', { ...budgetOptionsFrom(argv), estimateUsd: null });
    let complete = false;
    try { console.log(`graded ${await gradeAll(world, items, judges, out)} items (window ${window})`); complete = true; }
    finally { run.close({ finish: complete }); guard.uninstall(); }
  } else if (cmd === 'report') {
    const { items } = JSON.parse(readFileSync(join(out, 'items.json'), 'utf8')) as { items: CheckItem[] };
    const grades = readJsonl<Grade>(join(out, 'grades.jsonl'));
    const judges = (flag('--judges') ?? usage('report needs --judges, the judges that must each have graded every item')).split(',');
    const r = report(items, grades, judges);
    writeFileSync(join(out, 'report.json'), JSON.stringify(r, null, 1) + '\n');
    console.log(JSON.stringify(r, null, 1));
    if (!r.passes) { console.error('STOP JUDGE_CHECK_STOP: a judge failed a gate; report every number to the Captain'); process.exit(3); }
  } else usage('command must be plan, run or report');
}
