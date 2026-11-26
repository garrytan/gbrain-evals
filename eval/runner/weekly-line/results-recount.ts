/**
 * Recounts every number the weekly held-out line's stop-and-publish results page
 * (docs/benchmarks/2026-11-23-weekly-outcome-line.md) prints, from the committed per-question records under
 * docs/benchmarks/2026-11-23-weekly-outcome-line/pilot/. Keyless and offline: it reads files only.
 *
 *   bun eval/runner/weekly-line/results-recount.ts [--dir <pilot dir>] [--json]
 *
 * An answer is right when its gating judgment (view "gating") scored 1; an answer with no gating judgment (a turn-cap
 * stop) counts as wrong. Each folder holds a cell's final answers and judgments, which carry every earlier lease's
 * records forward, and leases/ holds every lease's summary, so a cell's spend is the sum over its leases.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BG1_DEV_ALIAS_MISSPELLING_QUESTIONS } from '../memory-qa/bg1-names.ts';

export const PILOT_DIR = resolve(import.meta.dir, '../../../docs/benchmarks/2026-11-23-weekly-outcome-line/pilot');
export const OPUS = 'anthropic:claude-opus-5-5', PARTICLE = 'particle:particle-1';

interface Answer { answer_id: string; question_id: string; conversation: string; reader: string; usd?: number | null; text: string }
interface Judgment { answer_id: string; view?: string; judge: string; score: number }
export interface Scored extends Answer { right: boolean }

const lines = <T>(path: string): T[] => readFileSync(path, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as T);

/** One cell folder's answers, each marked right or wrong by its gating judgment, with the cell's spend over every lease. */
export function readCell(dir: string): { answers: Scored[]; spend_usd: number; gbrain: string | null } {
  const verdicts = new Map(lines<Judgment>(join(dir, 'judgments.ndjson')).filter(j => j.view === 'gating').map(j => [j.answer_id, j.score]));
  const answers = lines<Answer>(join(dir, 'answers.ndjson')).map(a => ({ ...a, right: verdicts.get(a.answer_id) === 1 }));
  const spend = readdirSync(join(dir, 'leases')).reduce((s, f) => s + (JSON.parse(readFileSync(join(dir, 'leases', f), 'utf8')) as { committed_usd: number }).committed_usd, 0);
  const pkg = (JSON.parse(readFileSync(join(dir, 'receipt.json'), 'utf8')) as { system: { versions?: { package?: string } } }).system.versions?.package ?? '';
  const m = /gbrain#([0-9a-f]{40}), ([0-9.]+)\)/.exec(pkg);
  return { answers, spend_usd: spend, gbrain: m ? `v${m[2]} (${m[1]})` : null };
}

const right = (xs: Scored[]) => xs.filter(x => x.right).length;
const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

/** One reader's score on a set of answers: right of n, per world, and agent-call dollars per right answer. */
function score(xs: Scored[]) {
  const worlds: Record<string, string> = {};
  for (const w of [...new Set(xs.map(x => x.conversation))].sort()) { const ws = xs.filter(x => x.conversation === w); worlds[w] = `${right(ws)}/${ws.length}`; }
  const usd = xs.reduce((s, x) => s + (x.usd ?? 0), 0);
  return { right: right(xs), n: xs.length, accuracy: round(right(xs) / xs.length, 4), worlds, usd_per_right: round(usd / right(xs), 4) };
}

/** Two-sided exact McNemar p on b and c discordant pairs. */
export function mcnemar(b: number, c: number): number {
  const n = b + c, k = Math.min(b, c);
  let tail = 0, coef = 1;
  for (let i = 0; i <= k; i++) { if (i > 0) coef = coef * (n - i + 1) / i; tail += coef; }
  return Math.min(1, 2 * tail / 2 ** n);
}

export function recount(dir = PILOT_DIR) {
  const grep = (stage: string) => [...readCell(join(dir, stage, 'grep-agent-pilot')).answers, ...readCell(join(dir, stage, 'grep-agent-judge-check')).answers];
  const misspelled = new Set<string>(BG1_DEV_ALIAS_MISSPELLING_QUESTIONS);
  const grepAgent: Record<string, Record<string, ReturnType<typeof score>>> = {};
  for (const stage of ['named-200k', 'named-1m', 'alias-stage1']) {
    const xs = grep(stage);
    grepAgent[stage] = { [OPUS]: score(xs.filter(x => x.reader === OPUS)), [PARTICLE]: score(xs.filter(x => x.reader === PARTICLE)) };
  }
  const alias = grep('alias-stage1');
  const aliasSplit = Object.fromEntries([OPUS, PARTICLE].map(r => {
    const xs = alias.filter(x => x.reader === r);
    const mis = xs.filter(x => misspelled.has(x.question_id)), plain = xs.filter(x => !misspelled.has(x.question_id));
    return [r, { misspelling: `${right(mis)}/${mis.length}`, plain: `${right(plain)}/${plain.length}`, plain_accuracy: round(right(plain) / plain.length, 3) }];
  }));
  const rows = Object.fromEntries(['named-200k', 'named-1m'].map(stage => [stage, Object.fromEntries(['grep-agent-pilot', 'gbrain', 'extract-first', 'memory-bank'].map(row => {
    const c = readCell(join(dir, stage, row)), xs = c.answers.filter(x => x.reader === OPUS);
    return [row, { right: right(xs), n: xs.length, accuracy: round(right(xs) / xs.length, 4), cell_usd_per_right: row === 'grep-agent-pilot' ? null : round(c.spend_usd / right(xs), 3), gbrain: c.gbrain }];
  }))]));
  const grepMis = new Map(alias.filter(x => x.reader === OPUS && misspelled.has(x.question_id)).map(x => [x.question_id, x.right]));
  const stage2Row = (row: string) => {
    const c = readCell(join(dir, 'alias-stage2', row));
    const mine = new Map(c.answers.map(x => [x.question_id, x.right]));
    if (mine.size !== 34 || c.answers.length !== 34 || [...mine.keys()].some(q => !misspelled.has(q))) throw new Error(`${row}: stage 2 must answer exactly the 34 misspelling questions once each`);
    const ok = right(c.answers), worlds: Record<string, number> = {};
    for (const x of c.answers) worlds[x.conversation] = (worlds[x.conversation] ?? 0) + (x.right ? 1 : 0);
    const rowOnly = [...mine].filter(([q, r]) => r && !grepMis.get(q)).map(([q]) => q).sort();
    const grepOnly = [...mine].filter(([q, r]) => !r && grepMis.get(q)).map(([q]) => q).sort();
    const d = (ok - right([...grepMis.values()].map(r => ({ right: r }) as Scored))) / 34;
    const se = Math.sqrt(((rowOnly.length + grepOnly.length) / 34 - d * d) / 34);
    return { right: ok, n: 34, worlds, row_right_grep_wrong: rowOnly, grep_right_row_wrong: grepOnly, diff_pp: round(d * 100, 1), wald95_pp: [round((d - 1.96 * se) * 100, 1), round((d + 1.96 * se) * 100, 1)],
      mcnemar_p: Number(mcnemar(rowOnly.length, grepOnly.length).toPrecision(3)), cell_usd_per_right: round(c.spend_usd / ok, 3), gbrain: c.gbrain };
  };
  const stage2 = { 'extract-first': stage2Row('extract-first'), 'memory-bank': stage2Row('memory-bank'), gbrain: stage2Row('gbrain') };
  const judgedWrong = Object.fromEntries(['named-200k', 'named-1m', 'alias-stage1'].map(stage => {
    const js = ['grep-agent-pilot', 'grep-agent-judge-check'].flatMap(c => lines<Judgment>(join(dir, stage, c, 'judgments.ndjson')).filter(j => j.view === 'gating'));
    const by: Record<string, string> = {};
    for (const judge of [...new Set(js.map(j => j.judge))].sort()) { const mine = js.filter(j => j.judge === judge); by[judge] = `${mine.filter(j => j.score !== 1).length} wrong of ${mine.length}`; }
    return [stage, by];
  }));
  const resumes = Object.fromEntries(['gbrain', 'memory-bank'].map(row => {
    const leases = readdirSync(join(dir, 'alias-stage2', row, 'leases')).map(f => JSON.parse(readFileSync(join(dir, 'alias-stage2', row, 'leases', f), 'utf8')) as { checkpoint_rows: number; realization_id?: string; restored_from?: string });
    const first = leases.find(l => l.realization_id), second = leases.find(l => l.restored_from);
    return [row, { first_lease_answers: first?.checkpoint_rows ?? null, resumed_from_its_snapshot: !!first && second?.restored_from === first.realization_id }];
  }));
  return { grep_agent: grepAgent, alias_split: aliasSplit, judged_wrong: judgedWrong, rows, stage2: { grep: `${[...grepMis.values()].filter(Boolean).length}/${grepMis.size}`, ...stage2 }, stage2_resumes: resumes };
}

if (import.meta.main) {
  const argv = process.argv.slice(2), i = argv.indexOf('--dir');
  const r = recount(i >= 0 ? resolve(argv[i + 1]) : PILOT_DIR);
  if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); process.exit(0); }
  for (const [stage, readers] of Object.entries(r.grep_agent)) for (const [rd, s] of Object.entries(readers))
    console.log(`grep agent  ${stage.padEnd(12)} ${rd.padEnd(26)} ${s.right}/${s.n} = ${s.accuracy}  $${s.usd_per_right}/right (agent calls)  ${Object.values(s.worlds).join(' ')}`);
  for (const [rd, s] of Object.entries(r.alias_split)) console.log(`alias split ${rd.padEnd(26)} plain aliases ${s.plain} = ${s.plain_accuracy}  misspellings ${s.misspelling}`);
  for (const [stage, rows] of Object.entries(r.rows)) for (const [row, s] of Object.entries(rows))
    console.log(`one world   ${stage.padEnd(12)} ${row.padEnd(17)} ${s.right}/${s.n} = ${s.accuracy}${s.cell_usd_per_right === null ? '' : `  $${s.cell_usd_per_right}/right (whole cell)`}${s.gbrain ? `  gbrain ${s.gbrain}` : ''}`);
  for (const [stage, by] of Object.entries(r.judged_wrong)) console.log(`judged      ${stage.padEnd(12)} ${Object.entries(by).map(([j, v]) => `${j}: ${v}`).join('; ')}`);
  const { grep, ...rows } = r.stage2;
  console.log(`stage 2     grep agent (stage 1, same ids) ${grep}`);
  for (const [row, s] of Object.entries(rows)) console.log(`stage 2     ${row.padEnd(14)} ${s.right}/34 ${JSON.stringify(s.worlds)}  row-only ${s.row_right_grep_wrong.length}  grep-only ${s.grep_right_row_wrong.length}  p ${s.mcnemar_p}  ${s.diff_pp} pp [${s.wald95_pp.join(', ')}]  $${s.cell_usd_per_right}/right${s.gbrain ? `  gbrain ${s.gbrain}` : ''}`);
  for (const [row, v] of Object.entries(r.stage2_resumes)) console.log(`resume      ${row.padEnd(14)} first lease answered ${v.first_lease_answers}; second lease restored its snapshot: ${v.resumed_from_its_snapshot}`);
}
