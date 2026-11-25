/**
 * Cat 40 Hard H4 section-delivery confirmation: the construction judge check
 * (docs/benchmarks/2026-11-24-cat40-h4-fix-confirmation-preregistration.md, "Readers and judges", as amended
 * 2026-11-25). Each claims judge grades its own 100 constructed answers on public world N1 before any counted cell.
 *
 *   bun eval/runner/cat40/h4fix-judge-check.ts plan   --world <N1 world.json> --out <dir> [--seed 1]
 *   bun eval/runner/cat40/h4fix-judge-check.ts run    --world <N1 world.json> --out <dir>
 *                                                     --paid-window <unit> --window-cap-usd <n> --budget-usd <n> --budget-ledger <file>
 *   bun eval/runner/cat40/h4fix-judge-check.ts report --out <dir>
 *
 *   Items   per judge, 10 seeded tasks per family, each as a good answer (the accepted value, every H1 member or the
 *           count) and a bad one (a value the task lists as wrong, a value attributed to the wrong account, an extra H1
 *           account or a count off by 3): 100 items, 50 of each class. The label is fixed by construction and checked
 *           by the deterministic scorer (good passes, bad fails); no model writes or labels an item. Answers are
 *           written in the answer style of the readers whose rows the judge counts: gpt-6.2-sol gets Opus-style
 *           answers (numbered notes naming each account); claude-opus-5-5 gets GPT-6.2 Sol-style answers (one terse
 *           note) and, for particle-1, answers with no notes, alternating by task.
 *   Gates   per judge, reading "at least one contradicted or unsupported claim" as bad: Cohen's kappa against the
 *           labels at least 0.6, every planned item graded, at least 40 graded in each class, and at most 1% of outputs
 *           malformed after one retry. Errors are reported per answer style. report exits 3 (JUDGE_CHECK_STOP) when a
 *           gate fails; report.json carries no dollar field (R79).
 *   Window  run spends real keys only with --paid-window and --window-cap-usd, and --budget-usd at or below the cap;
 *           it exits 2 before any request otherwise. Tests pass a fake call and never reach a provider.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HardTask, HardWorld } from '../../generators/hard/schema.ts';
import { budgetOptionsFrom, startPaidRun } from '../budget-ledger.ts';
import { seededRandom } from '../stats/paired.ts';
import { cohenKappa, gradeAll, type CheckItem, type Grade } from './judge-check-hard.ts';
import { runAgentText } from './loop.ts';
import { scoreHardTask } from './score-hard.ts';

export const N1_SEED = 20261141;
export const FAMILIES = ['H1', 'H2', 'H3', 'H4', 'H5'] as const;
export const TASKS_PER_FAMILY = 10;
export const GATE = { kappa: 0.6, items: 100, minPerClass: 40, maxMalformedShare: 0.01 } as const;
export type Style = 'opus' | 'sol' | 'particle';
/** The answer styles each judge is checked on: the styles of the readers whose rows it counts. */
export const STYLES_FOR: Record<string, readonly Style[]> = { 'gpt-6.2-sol': ['opus'], 'claude-opus-5-5': ['sol', 'particle'] };
export const JUDGES = Object.keys(STYLES_FOR);

type Final = { answer: unknown; notes?: string; sources?: string[] };
export type Item = CheckItem & { judge: string; style: Style; bad_kind?: string };

function shuffle<T>(xs: T[], rand: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/** The answer as a list of labelled values, good or bad by construction; undefined when the task can't be built. */
function values(world: HardWorld, task: HardTask, bad: boolean, n: number, rand: () => number): { parts: Array<[string, string]>; kind?: string } | undefined {
  const g = task.gold;
  const name = (id: string) => world.entities.find(e => e.id === id)?.name ?? id;
  if (task.answer_kind === 'set') {
    const members = (g.members ?? []).map(m => m.names[0]);
    if (!bad) return members.length ? { parts: members.map(m => ['', m]) } : undefined;
    const inSet = new Set((g.members ?? []).map(m => m.id));
    const others = world.entities.filter(e => !inSet.has(e.id)).sort((a, b) => a.id.localeCompare(b.id));
    if (!others.length) return undefined;
    return { parts: [...members, others[Math.floor(rand() * others.length)].name].map(m => ['', m]), kind: 'extra_account' };
  }
  if (task.answer_kind === 'count') return g.count === undefined ? undefined : { parts: [['', String(bad ? g.count + 3 : g.count)]], kind: bad ? 'count_changed' : undefined };
  if (task.answer_kind === 'values') {
    const items = g.items ?? [];
    if (!items.length) return undefined;
    const good = items.map(i => [name(i.account), i.answer[0]] as [string, string]);
    if (!bad) return { parts: good };
    const swappable = items.length > 1 && items[0].answer[0] !== items[1].answer[0];
    if (n % 2 === 1 && swappable) return { parts: good.map(([a], k) => [a, k === 0 ? good[1][1] : k === 1 ? good[0][1] : good[k][1]]), kind: 'wrong_account' };
    if (!items[0].wrong.length) return undefined;
    return { parts: good.map(([a, v], k) => [a, k === 0 ? items[0].wrong[0] : v]), kind: 'listed_wrong' };
  }
  if (!g.answer?.length) return undefined;
  if (!bad) return { parts: [['', g.answer[0]]] };
  return g.wrong?.length ? { parts: [['', g.wrong[0]]], kind: 'listed_wrong' } : undefined;
}

/** One answer in a reader's style. Only the values and account names come from the task; nothing else is claimed. */
export function render(task: HardTask, parts: Array<[string, string]>, style: Style): Final {
  const vals = parts.map(([, v]) => v);
  const answer = task.answer_kind === 'set' || task.answer_kind === 'values' ? JSON.stringify(vals) : vals[0];
  if (style === 'particle') return { answer, sources: task.gold.evidence };
  if (style === 'sol') return { answer, notes: `Answers in order: ${vals.join('; ')}.`, sources: task.gold.evidence };
  const notes = task.answer_kind === 'set' ? `Accounts: ${vals.join(', ')}.`
    : task.answer_kind === 'count' ? `Count: ${vals[0]}.`
    : parts.map(([a, v], k) => `${k + 1}) ${a ? `${a}: ` : ''}${v}.`).join(' ');
  return { answer, notes, sources: [...new Set([...task.gold.evidence, ...(task.relevant ?? [])])] };
}

const passes = (world: HardWorld, task: HardTask, final: Final) => scoreHardTask(world, task, [{ final: final as never, stop: 'submitted' }]).success;

/** Each judge's 100 construction items: TASKS_PER_FAMILY tasks per family, a good and a bad answer each. */
export function planItems(world: HardWorld, seed: number): { items: Item[]; skipped: string[] } {
  if (world.seed !== N1_SEED) throw new Error(`the judge check runs on public world N1 (seed ${N1_SEED}), got seed ${world.seed}`);
  const items: Item[] = [], skipped = new Set<string>();
  JUDGES.forEach((judge, j) => {
    const rand = seededRandom(seed * 10 + j);
    for (const family of FAMILIES) {
      let taken = 0;
      for (const task of shuffle(world.tasks.filter(t => t.family === family).sort((a, b) => a.id.localeCompare(b.id)), rand)) {
        if (taken === TASKS_PER_FAMILY) break;
        const styles = STYLES_FOR[judge], style = styles[taken % styles.length];
        const good = values(world, task, false, taken, rand), bad = values(world, task, true, taken, rand);
        const gf = good && render(task, good.parts, style), bf = bad && render(task, bad.parts, style);
        if (!gf || !bf || !passes(world, task, gf) || passes(world, task, bf)) { skipped.add(task.id); continue; }
        const base = { kind: 'construct' as const, task: task.id, family, judge, style };
        items.push({ ...base, id: `${judge}-${task.id}-good`, final: gf, label: 'good' });
        items.push({ ...base, id: `${judge}-${task.id}-bad`, final: bf, label: 'bad', bad_kind: bad!.kind });
        taken++;
      }
      if (taken < TASKS_PER_FAMILY) throw new Error(`${judge}: only ${taken} buildable ${family} tasks on N1; the check needs ${TASKS_PER_FAMILY}`);
    }
  });
  return { items, skipped: [...skipped].sort() };
}

/** Grade each judge's own items, resuming from grades.jsonl. */
export async function gradeItems(world: HardWorld, items: Item[], out: string,
  call: (model: string, system: string, user: string) => Promise<{ text: string }> = runAgentText): Promise<number> {
  let n = 0;
  for (const judge of JUDGES) n += await gradeAll(world, items.filter(i => i.judge === judge), [judge], out, call);
  return n;
}

const isBad = (g: Grade) => g.claims!.unsupported + g.claims!.contradicted > 0;

export function checkReport(items: Item[], grades: Grade[]) {
  const judges = JUDGES.map(judge => {
    const mine = new Map(items.filter(i => i.judge === judge).map(i => [i.id, i]));
    const graded = grades.filter(g => g.judge === judge && mine.has(g.item));
    const parsed = graded.filter(g => g.claims);
    const pairs = parsed.map(g => [mine.get(g.item)!.label === 'bad', isBad(g)] as [boolean, boolean]);
    const good = pairs.filter(([l]) => !l), bad = pairs.filter(([l]) => l);
    const malformed = graded.length - parsed.length;
    const kappa = cohenKappa(pairs);
    const byStyle = Object.fromEntries(STYLES_FOR[judge].map(style => {
      const s = parsed.filter(g => mine.get(g.item)!.style === style).map(g => [mine.get(g.item)!.label === 'bad', isBad(g)]);
      return [style, { graded: s.length, missed_bad: s.filter(([l, j]) => l && !j).length, flagged_good: s.filter(([l, j]) => !l && j).length }];
    }));
    const failures: string[] = [];
    if (mine.size !== GATE.items) failures.push(`planned ${mine.size} items; the check needs ${GATE.items}`);
    if (new Set(graded.map(g => g.item)).size < mine.size) failures.push(`graded ${new Set(graded.map(g => g.item)).size} of ${mine.size} items`);
    if (kappa === null || kappa < GATE.kappa) failures.push(`kappa ${kappa === null ? 'n/a' : kappa.toFixed(3)} < ${GATE.kappa}`);
    if (good.length < GATE.minPerClass || bad.length < GATE.minPerClass) failures.push(`graded good ${good.length}, bad ${bad.length}; each needs ${GATE.minPerClass}`);
    if (!graded.length || malformed / graded.length > GATE.maxMalformedShare) failures.push(`${malformed} of ${graded.length} outputs malformed after retry`);
    return { judge, styles: STYLES_FOR[judge], graded: graded.length, good_graded: good.length, bad_graded: bad.length, malformed,
      retried: graded.filter(g => g.retried).length, kappa, catch_rate: bad.length ? bad.filter(([, j]) => j).length / bad.length : null,
      false_fail_rate: good.length ? good.filter(([, j]) => j).length / good.length : null, by_style: byStyle, passes: !failures.length, failures };
  });
  return { labels: 'construction-labelled', judges, passes: judges.every(j => j.passes) };
}

const readJsonl = <T>(p: string): T[] => (existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as T) : []);

if (import.meta.main) {
  const [cmd, ...argv] = process.argv.slice(2);
  const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const usage = (msg: string): never => { console.error(`h4fix-judge-check: ${msg}`); process.exit(2); };
  const out = flag('--out') ?? usage('--out is required');
  const worldOf = () => JSON.parse(readFileSync(flag('--world') ?? usage('--world is required'), 'utf8')) as HardWorld;
  const planned = () => JSON.parse(readFileSync(join(out, 'items.json'), 'utf8')) as { items: Item[] };
  if (cmd === 'plan') {
    const seed = Number(flag('--seed') ?? 1);
    const { items, skipped } = planItems(worldOf(), seed);
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'items.json'), JSON.stringify({ seed, world_seed: N1_SEED, skipped, items }, null, 1) + '\n');
    console.log(`planned ${items.length} construction items (${skipped.length} tasks skipped) in ${join(out, 'items.json')}`);
  } else if (cmd === 'run') {
    const window = flag('--paid-window'), cap = Number(flag('--window-cap-usd')), budget = Number(flag('--budget-usd'));
    if (!window) usage('run needs --paid-window <unit>: judge calls are paid and run only inside a granted window');
    if (!(cap > 0) || !(budget > 0) || budget > cap) usage('run needs --window-cap-usd and --budget-usd, with the budget at or below the window cap');
    const world = worldOf();
    if (world.seed !== N1_SEED) usage(`--world must be N1 (seed ${N1_SEED})`);
    const { run, guard } = startPaidRun('cat40-h4fix-judge-check', { ...budgetOptionsFrom(argv), estimateUsd: null });
    let complete = false;
    try { console.log(`graded ${await gradeItems(world, planned().items, out)} items (window ${window})`); complete = true; }
    finally { run.close({ finish: complete }); guard.uninstall(); }
  } else if (cmd === 'report') {
    const r = checkReport(planned().items, readJsonl<Grade>(join(out, 'grades.jsonl')));
    writeFileSync(join(out, 'report.json'), JSON.stringify(r, null, 1) + '\n');
    console.log(JSON.stringify(r, null, 1));
    if (!r.passes) { console.error('STOP JUDGE_CHECK_STOP: a judge failed a gate; no counted cell runs'); process.exit(3); }
  } else usage('command must be plan, run or report');
}
