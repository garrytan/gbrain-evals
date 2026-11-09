/**
 * BG1's judge check (R78; preregistration docs/benchmarks/2026-11-09-changing-facts-battleground-preregistration.md,
 * "Readers and judges", and review finding F3): are gpt-6-astra and claude-opus-5-5 good enough to gate BG1's verdict,
 * checked on public dev data only, before any counted number. Adapted from RS1's check to BG1's short-answer
 * instrument; it shares no code with it.
 *
 *   bun eval/runner/bg1/judge-check.ts plan   --stage1 <stage 1 out dir>... --out <dir> [--seed <n>]
 *   bun eval/runner/bg1/judge-check.ts run    --stage1 <dir>... --out <dir> --budget-ledger <file> --run-id <id> --lease-usd <n>
 *                                             --ledger-cap-usd <n> [--seed <n>] (--keyless-upstream <url> | --paid-window <unit> --window-cap-usd <n>)
 *   bun eval/runner/bg1/judge-check.ts report --out <dir>
 *
 *   Pool      (a) real answers: stage 1's scored replicate-0 answers on the three dev worlds (every row and particle-1's
 *             re-reads), a seeded sample stratified by row, reader and the canonical judge's verdict; (b) construction
 *             items from the plan's gold on the dev questions, labels neither judge made: a paraphrase of the gold (an
 *             accepted form in a sentence; an ordered question's whole list in order) is good; a stale value stated as
 *             current, a decoy entity's value, a withdrawn fact stated as current (s5), a value from another date (s6,
 *             s7) or an ordered list out of order (s8) is bad. Every good item states the gold and no stale or decoy
 *             value, and every bad item but an out-of-order list states no gold value (match.ts). Sizes are pricing.ts
 *             JUDGE_CHECK_PLAN's. The pool and every text stay in --out.
 *   Grading   gpt-6-astra and claude-opus-5-5 grade every item with the production request (the bg1-dev instrument
 *             through judgeAnswer at PER_READER_JUDGE_SETTINGS, gating view), through the judge cache and one lease.
 *             The deterministic matcher (match.ts) reads every item too, at no cost, descriptive. Every grade records the
 *             pool's SHA-256 and seed beside its item's text hash, and a plan, run or report whose pool, seed or item text
 *             differs from a grade already in --out exits 2 before it writes pool.json or opens a lease.
 *   Gates     (i) Astra-Opus Cohen's kappa over every item both graded, at least 0.6; (ii) each gating judge's kappa
 *             against the construction labels, at least 0.6; (iii) at least 40 items on which Astra and Opus agree,
 *             at least 15 in each class; (iv) each gating judge's truncation rate at most 1%. Any failure exits 3
 *             (JUDGE_CHECK_STOP) and every number goes to GBEV-3.
 *   Reported  for each gating judge and the matcher: the catch rate on bad construction items (overall and by kind),
 *             the false-fail rate on good ones and kappa, with Wilson 95% intervals for rates, and the agreement with
 *             each judge on the real answers. `report` exits 0 only for a paid check whose gates pass; a keyless rehearsal
 *             or an --out with no marker exits 4 (JUDGE_CHECK_NOT_PAID). report.json carries no dollar field (R79).
 *   Window    `run` spends real keys only inside a granted paid window: without --keyless-upstream it needs --paid-window
 *             and --window-cap-usd, its --ledger-cap-usd never exceeds the window cap, and it exits 2 before any lease,
 *             proxy or output otherwise. A keyless run blanks every provider key first.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadCorpus, type MemoryQuestion } from '../memory-qa/corpus.ts';
import { instrumentFor, type Instrument } from '../memory-qa/instruments.ts';
import { ChatClient, judgeAnswer, type ChatLike } from '../memory-qa/qa-v2.ts';
import { readRecords, sha256, type JudgmentRecord } from '../memory-qa/records.ts';
import { DEFAULT_ROUTE_CAPS, keylessKeys, keylessUpstream, MeteringProxy, usageSplit } from '../metering-proxy.ts';
import { DEFAULT_ROUTE_CLASSES } from '../shootout-cell.ts';
import { claimOut, keylessUpstreamArg } from '../q1/calibration-cell.ts';
import { metering, onSlot, type MeterLine } from '../q1/cell.ts';
import { PER_READER_JUDGE_SETTINGS } from '../q1/cells/definitions.ts';
import { openRereadLease } from '../q1/reread-cell.ts';
import { requireRs1Window, WindowRefusal } from '../paid-arm.ts';
import { seededRandom } from '../stats/paired.ts';
import { findValues, matchAnswer } from './match.ts';
import { JUDGE_CHECK_PLAN } from './pricing.ts';
import { BG1_BENCHMARK_DEV, BG1_DEV_CONVERSATIONS } from './types.ts';

export const JUDGE_CHECK_SCHEMA = 'gbrain-evals/bg1-judge-check/v1';
export const ASTRA = 'openai:gpt-6-astra';
export const OPUS_JUDGE = 'anthropic:claude-opus-5-5';
export const GATING_JUDGES = [ASTRA, OPUS_JUDGE] as const;
export const KAPPA_GATE = 0.6;
export const TRUNCATION_GATE = 0.01;
export const MIN_LABELLED = 40;
export const MIN_PER_CLASS = 15;
export const SEED = 20261109;
export const PROVIDER_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'PARTICLE_API_KEY', 'VOYAGE_API_KEY'];

export type BadKind = 'stale' | 'decoy' | 'withdrawn' | 'wrong_date' | 'wrong_order';
export interface Item {
  id: string; source: 'real' | 'construction'; question_id: string; conversation: string; text: string; text_sha256: string;
  /** Construction items only: 1 good, 0 bad. */
  label: 0 | 1 | null;
  kind: 'good' | BadKind | null;
  row?: string; reader?: string; canonical?: number | null;
}

const shuffle = <T,>(xs: readonly T[], rand: () => number): T[] => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const GOOD = ['{v}.', 'It is {v}.', 'The current answer is {v}.', 'From the history, {v}.'];
const BAD = ['{v}.', 'It is {v}.', 'The current answer is {v}.', 'From the history, {v}, as it stands now.'];
const fill = (t: string, v: string) => t.replace('{v}', v);

/** One good and one bad construction item for a question, or null where the question cannot make the bad kind it is due. */
export function constructItems(q: MemoryQuestion, turn: number, rand: () => number): { good: string; bad: string; kind: BadKind } | null {
  const f = q.bg1;
  if (!f || !f.gold_values.length) return null;
  const pick = (xs: readonly string[]) => xs[Math.floor(rand() * xs.length)];
  const good = fill(GOOD[turn % GOOD.length], f.ordered ? f.gold_values.join(', then ') : pick(f.gold_values));
  const useDecoy = turn % 3 === 2 && f.decoy_values.length > 0;
  let kind: BadKind, bad: string;
  if (f.ordered && !useDecoy) {
    if (f.gold_values.length < 2) return null;
    kind = 'wrong_order';
    bad = fill(BAD[turn % BAD.length], [...f.gold_values].reverse().join(', then '));
  } else if (useDecoy) {
    kind = 'decoy';
    bad = fill(BAD[turn % BAD.length], pick(f.decoy_values));
  } else {
    if (!f.stale_values.length) return null;
    kind = f.stratum === 's5_withdrawn' ? 'withdrawn' : f.stratum === 's6_as_of' || f.stratum === 's7_as_known' ? 'wrong_date' : 'stale';
    bad = fill(BAD[turn % BAD.length], pick(f.stale_values));
  }
  const values = { gold: f.gold_values, stale: f.stale_values, decoy: f.decoy_values };
  const goodHits = findValues(good, values), badHits = findValues(bad, values);
  if (matchAnswer(q, good) !== 'correct' || goodHits.some(h => h.kind !== 'gold')) return null;
  if (matchAnswer(q, bad) === 'correct' || (kind !== 'wrong_order' && badHits.some(h => h.kind === 'gold'))) return null;
  return { good, bad, kind };
}

export interface RealAnswer { answer_id: string; question_id: string; conversation: string; row: string; reader: string; text: string; canonical: number | null }

/** The pool: a stratified sample of real answers and the construction items, both seeded. */
export function buildPool(questions: readonly MemoryQuestion[], real: readonly RealAnswer[], seed = SEED, sizes: { dev_answers: number; construction_items: number } = JUDGE_CHECK_PLAN): Item[] {
  const rand = seededRandom(seed);
  const strata = new Map<string, RealAnswer[]>();
  for (const a of real) { const k = `${a.row}|${a.reader}|${a.canonical === null ? 'none' : a.canonical >= 1 ? 'pass' : 'fail'}`; strata.set(k, [...(strata.get(k) ?? []), a]); }
  const queues = [...strata.keys()].sort().map(k => shuffle(strata.get(k)!, rand));
  const picked: RealAnswer[] = [];
  while (picked.length < sizes.dev_answers && queues.some(q => q.length)) for (const q of queues) if (q.length && picked.length < sizes.dev_answers) picked.push(q.shift()!);
  const items: Item[] = picked.map(a => ({ id: `real-${a.answer_id}`, source: 'real', question_id: a.question_id, conversation: a.conversation, text: a.text, text_sha256: sha256(a.text), label: null, kind: null, row: a.row, reader: a.reader, canonical: a.canonical }));
  const half = Math.floor(sizes.construction_items / 2);
  let turn = 0, made = 0;
  for (const q of shuffle(questions.filter(x => x.bg1), rand)) {
    if (made >= half) break;
    const c = constructItems(q, turn++, rand);
    if (!c) continue;
    for (const [text, label, kind] of [[c.good, 1, 'good'], [c.bad, 0, c.kind]] as const) items.push({ id: `con-${q.id}-${kind}`, source: 'construction', question_id: q.id, conversation: q.conversation, text, text_sha256: sha256(text), label, kind });
    made++;
  }
  return items;
}

/** Cohen's kappa of two binary raters, with the large-sample 95% interval. */
export function cohenKappa(a: readonly boolean[], b: readonly boolean[]): { kappa: number | null; n: number; ci95: [number, number] | null } {
  const n = a.length;
  if (!n || n !== b.length) return { kappa: null, n, ci95: null };
  const po = a.filter((x, i) => x === b[i]).length / n;
  const pa = a.filter(Boolean).length / n, pb = b.filter(Boolean).length / n;
  const pe = pa * pb + (1 - pa) * (1 - pb);
  if (pe === 1) return { kappa: null, n, ci95: null };
  const kappa = (po - pe) / (1 - pe), se = Math.sqrt((po * (1 - po)) / (n * (1 - pe) ** 2));
  return { kappa, n, ci95: [kappa - 1.96 * se, kappa + 1.96 * se] };
}

/** Wilson's 95% interval for k of n. */
export function wilson(k: number, n: number): [number, number] | null {
  if (!n) return null;
  const z = 1.96, p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [(c - h) / d, (c + h) / d];
}

export interface Grade { score: number | null; truncated: boolean }
export type Grades = Record<string, Record<string, Grade>>;
export const gradeOf = (j: Pick<JudgmentRecord, 'score' | 'detail'>): Grade => ({ score: typeof j.score === 'number' ? j.score : null, truncated: j.detail?.truncated === true });

const r4 = (x: number | null) => (x === null ? null : Math.round(x * 1e4) / 1e4);
const rate = (k: number, n: number) => ({ k, n, rate: n ? r4(k / n) : null, ci95: wilson(k, n)?.map(x => r4(x)!) ?? null });

/** Construction-label numbers for one rater (a judge's scores or the matcher's reading). */
function againstLabels(items: readonly Item[], verdict: (i: Item) => boolean | null) {
  const graded = items.filter(i => i.source === 'construction' && verdict(i) !== null);
  const bad = graded.filter(i => i.label === 0), good = graded.filter(i => i.label === 1);
  const kinds = [...new Set(bad.map(i => i.kind!))].sort();
  const k = cohenKappa(graded.map(i => i.label === 1), graded.map(i => verdict(i)!));
  return {
    catch: rate(bad.filter(i => verdict(i) === false).length, bad.length),
    catch_by_kind: Object.fromEntries(kinds.map(kind => { const b = bad.filter(i => i.kind === kind); return [kind, rate(b.filter(i => verdict(i) === false).length, b.length)]; })),
    false_fail: rate(good.filter(i => verdict(i) === false).length, good.length),
    kappa: r4(k.kappa), kappa_ci95: k.ci95?.map(x => r4(x)!) ?? null, n: k.n,
  };
}

export function analyzeCheck(pool: readonly Item[], grades: Grades, questions: ReadonlyMap<string, MemoryQuestion>) {
  const judged = (judge: string) => (i: Item) => { const g = grades[judge]?.[i.id]; return g && g.score !== null ? g.score >= 1 : null; };
  const matcher = (i: Item) => { const q = questions.get(i.question_id); if (!q) return null; const m = matchAnswer(q, i.text); return m === 'unclear' ? null : m === 'correct'; };
  const both = pool.filter(i => judged(ASTRA)(i) !== null && judged(OPUS_JUDGE)(i) !== null);
  const inter = cohenKappa(both.map(i => judged(ASTRA)(i)!), both.map(i => judged(OPUS_JUDGE)(i)!));
  const agreed = both.filter(i => judged(ASTRA)(i) === judged(OPUS_JUDGE)(i));
  const pass = agreed.filter(i => judged(ASTRA)(i)).length, fail = agreed.length - pass;
  const judges = Object.fromEntries(GATING_JUDGES.map(j => {
    const graded = pool.filter(i => grades[j]?.[i.id]);
    const truncated = graded.filter(i => grades[j][i.id].truncated).length;
    return [j, { graded: graded.length, truncation: rate(truncated, graded.length), construction: againstLabels(pool, judged(j)) }];
  }));
  const real = pool.filter(i => i.source === 'real');
  const matcherReal = Object.fromEntries(GATING_JUDGES.map(j => { const xs = real.filter(i => matcher(i) !== null && judged(j)(i) !== null); const k = cohenKappa(xs.map(i => matcher(i)!), xs.map(i => judged(j)(i)!)); return [j, { n: xs.length, agreement: xs.length ? r4(xs.filter(i => matcher(i) === judged(j)(i)).length / xs.length) : null, kappa: r4(k.kappa) }]; }));
  const gates = [
    { gate: 'astra_opus_kappa', value: r4(inter.kappa), line: KAPPA_GATE, pass: inter.kappa !== null && inter.kappa >= KAPPA_GATE },
    ...GATING_JUDGES.map(j => ({ gate: `construction_kappa:${j}`, value: judges[j].construction.kappa, line: KAPPA_GATE, pass: judges[j].construction.kappa !== null && judges[j].construction.kappa >= KAPPA_GATE })),
    { gate: 'labelled_items', value: agreed.length, line: MIN_LABELLED, pass: agreed.length >= MIN_LABELLED },
    { gate: 'labelled_per_class', value: Math.min(pass, fail), line: MIN_PER_CLASS, pass: pass >= MIN_PER_CLASS && fail >= MIN_PER_CLASS },
    ...GATING_JUDGES.map(j => ({ gate: `truncation:${j}`, value: judges[j].truncation.rate, line: TRUNCATION_GATE, pass: judges[j].truncation.rate !== null && judges[j].truncation.rate <= TRUNCATION_GATE })),
  ];
  return {
    schema: JUDGE_CHECK_SCHEMA, items: { real: real.length, construction: pool.length - real.length },
    inter_judge: { kappa: r4(inter.kappa), ci95: inter.ci95?.map(x => r4(x)!) ?? null, n: inter.n },
    labelled: { items: agreed.length, pass, fail },
    judges, matcher: { construction: againstLabels(pool, matcher), real_agreement: matcherReal, note: 'descriptive; an unclear reading is left out' },
    gates, stop: gates.some(g => !g.pass),
  };
}
export type CheckReport = ReturnType<typeof analyzeCheck>;

/** Why a stage 1 root is not a paid run: a keyless marker or campaign lease, or neither marker; null when it is paid. */
export function stage1Unpaid(root: string): string | null {
  const read = (f: string) => (existsSync(join(root, f)) ? JSON.parse(readFileSync(join(root, f), 'utf8')) as Record<string, unknown> : null);
  const marker = read('upstream.json'), lease = read('lease-summary.json');
  if (marker?.keyless === true) return `${root} holds a keyless run (upstream.json)`;
  if (lease?.keyless_upstream === true) return `${root} holds a keyless campaign lease (lease-summary.json keyless_upstream)`;
  if (marker?.keyless === false || (!marker && lease)) return null;
  return `${root} has neither an upstream.json marking a paid run nor a campaign lease-summary.json`;
}

/** Stage 1's scored, replicate-0 answers in each root's cells/, with the canonical judge's score for strata. */
export function loadRealAnswers(roots: readonly string[], instrument: string): RealAnswer[] {
  return roots.flatMap(root => {
    const cells = join(root, 'cells');
    if (!existsSync(cells)) throw new Error(`${root} has no cells/ directory`);
    return readdirSync(cells).sort().filter(d => existsSync(join(cells, d, 'answers.ndjson'))).flatMap(d => {
      const jf = join(cells, d, 'judgments.ndjson');
      const canonical = new Map(existsSync(jf) ? readRecords(jf, 'judgment').filter(j => j.instrument_id === instrument && j.judge_replicate === 0).map(j => [j.answer_id, j.score]) : []);
      return readRecords(join(cells, d, 'answers.ndjson'), 'answer').filter(a => a.replicate === 0 && a.outcome === 'scored' && a.text.trim())
        .map(a => ({ answer_id: a.answer_id, question_id: a.question_id, conversation: a.conversation, row: d.split('.')[1] ?? d, reader: a.reader, text: a.text, canonical: canonical.get(a.answer_id) ?? null }));
    });
  });
}

type Graded = JudgmentRecord & { item: string; pool_sha256?: string; seed?: number };
const readGraded = (file: string): Graded[] => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
export const gradesFrom = (records: readonly Graded[]): Grades => {
  const grades: Grades = Object.fromEntries(GATING_JUDGES.map(j => [j, {}]));
  for (const r of records) if (grades[r.judge]) grades[r.judge][r.item] = gradeOf(r);
  return grades;
};

export const poolSha256 = (pool: readonly Item[], seed: number) => sha256(JSON.stringify({ seed, pool }));

/** Why the grades in a judgments file were not all made on this pool at this seed for each item's text; null when they were. */
export function staleGrades(file: string, pool: readonly Item[], seed: number): string | null {
  const key = poolSha256(pool, seed), items = new Map(pool.map(i => [i.id, i]));
  const stale = readGraded(file).flatMap(r => {
    const i = items.get(r.item);
    const why = r.pool_sha256 !== key || r.seed !== seed ? `pool ${r.pool_sha256?.slice(0, 12) ?? 'unrecorded'} at seed ${r.seed ?? 'unrecorded'}` : !i ? 'an item outside this pool' : r.answer_id !== i.text_sha256 ? `text ${r.answer_id.slice(0, 12)}` : null;
    return why ? [`${r.item} by ${r.judge} was graded on ${why}`] : [];
  });
  if (!stale.length) return null;
  return `${file} holds grades not made on pool ${key.slice(0, 12)} at seed ${seed}: ${stale.slice(0, 3).join('; ')}${stale.length > 3 ? ` (and ${stale.length - 3} more)` : ''}; give this pool a fresh --out`;
}

/** Grade every item with both gating judges at the pinned settings (resumable: a graded pair in --out is skipped). */
export async function gradePool(pool: readonly Item[], questions: ReadonlyMap<string, MemoryQuestion>, client: ChatLike, instrument: Instrument, out: string, seed = SEED): Promise<Grades> {
  const file = join(out, 'judgments.ndjson');
  const stale = staleGrades(file, pool, seed);
  if (stale) throw new Error(stale);
  const key = poolSha256(pool, seed);
  const done = new Set(readGraded(file).map(r => `${r.item}|${r.judge}`));
  for (const i of pool) for (const judge of GATING_JUDGES) {
    if (done.has(`${i.id}|${judge}`)) continue;
    const r = await judgeAnswer(client, instrument, questions.get(i.question_id)!, i.text, { judge, judgeReplicate: 0, view: 'gating', settings: { ...PER_READER_JUDGE_SETTINGS } });
    appendFileSync(file, JSON.stringify({ item: i.id, answer_id: i.text_sha256, pool_sha256: key, seed, ...r }) + '\n');
  }
  return gradesFrom(readGraded(file));
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const mode = argv[0];
  const one = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const stage1 = argv.flatMap((a, i) => (a === '--stage1' && argv[i + 1] ? [resolve(argv[i + 1])] : []));
  const out = one('--out') ? resolve(one('--out')!) : null;
  const seed = one('--seed') ? Number(one('--seed')) : SEED;
  if (!['plan', 'run', 'report'].includes(mode) || !out || (mode !== 'report' && !stage1.length)) { console.error('usage: bun eval/runner/bg1/judge-check.ts plan|run|report --stage1 <stage 1 out dir>... --out <dir> (see the header for run\'s flags)'); process.exit(2); }
  const [ledger, runId, leaseUsd, cap] = [one('--budget-ledger'), one('--run-id'), Number(one('--lease-usd')), Number(one('--ledger-cap-usd'))];
  let keyless: string | null = null;
  try { keyless = mode === 'run' ? keylessUpstreamArg(argv) : null; } catch (e) { console.error((e as Error).message); process.exit(2); }
  if (keyless || mode !== 'run') for (const k of PROVIDER_KEYS) delete process.env[k];
  if (mode === 'run') {
    if (!ledger || !runId || !(leaseUsd > 0) || !(cap > 0)) { console.error('run needs --budget-ledger, --run-id, --lease-usd and --ledger-cap-usd'); process.exit(2); }
    try { requireRs1Window(argv, { what: 'a BG1 judge check without --keyless-upstream', keyless: !!keyless, caps: () => [{ label: '--ledger-cap-usd', usd: cap }, { label: '--lease-usd', usd: leaseUsd }] }); }
    catch (e) { if (!(e instanceof WindowRefusal)) throw e; console.error((e as Error).message); process.exit(2); }
  }
  const unpaid = mode === 'report' ? [] : stage1.flatMap(r => stage1Unpaid(r) ?? []);
  if (unpaid.length) { console.error(`--stage1 takes paid stage 1 outputs only: ${unpaid.join('; ')}`); process.exit(2); }
  mkdirSync(out, { recursive: true });
  const instrument = instrumentFor(BG1_BENCHMARK_DEV);
  const questions = loadCorpus(BG1_BENCHMARK_DEV, undefined, new Set(BG1_DEV_CONVERSATIONS)).questions;
  const byId = new Map(questions.map(q => [q.id, q]));
  if (mode !== 'report') {
    if (mode === 'run') {
      if (!existsSync(join(out, 'upstream.json')) && ['judgments.ndjson', 'cache'].some(f => existsSync(join(out, f)))) { console.error(`${out} holds judgments or a cache but no keyless/paid marker; give this run a fresh --out`); process.exit(2); }
      try { claimOut(out, !!keyless, 'judge-check'); } catch (e) { console.error((e as Error).message); process.exit(2); }
    }
    const pool = buildPool(questions, loadRealAnswers(stage1, instrument.id), seed);
    const stale = staleGrades(join(out, 'judgments.ndjson'), pool, seed);
    if (stale) { console.error(stale); process.exit(2); }
    writeFileSync(join(out, 'pool.json'), JSON.stringify({ seed, pool }, null, 2) + '\n');
    console.log(JSON.stringify({ seed, items: pool.length, real: pool.filter(i => i.source === 'real').length, construction: pool.filter(i => i.source === 'construction').length, calls: pool.length * GATING_JUDGES.length }, null, 2));
    if (mode === 'plan') process.exit(0);
    const [cellToken, controlToken] = [randomUUID(), randomUUID()];
    Object.assign(process.env, { SHOOTOUT_CELL_TOKEN: cellToken, SHOOTOUT_PROXY_CONTROL_TOKEN: controlToken });
    const lease = openRereadLease({ runId: runId!, leaseUsd, ledgerPath: resolve(ledger!), capUsd: cap, runner: 'bg1-judge-check' });
    const usageLog = join(out, 'usage.ndjson');
    const proxy = new MeteringProxy({ ...(keyless ? { upstream: keylessUpstream(keyless) } : {}), cellToken, controlToken,
      policy: { lease, usageLog, env: keyless ? keylessKeys() : { ...process.env },
        routeCaps: { caps: { ...DEFAULT_ROUTE_CAPS, ...Object.fromEntries(GATING_JUDGES.map(j => [`judge@${j}`, PER_READER_JUDGE_SETTINGS.max_tokens])) }, slots: { ...DEFAULT_ROUTE_CLASSES }, defaultClass: 'extraction' } } });
    proxy.start();
    try {
      const meter = metering(`http://127.0.0.1:${proxy.port}`, { meter: (m: MeterLine) => appendFileSync(join(out, 'meters.ndjson'), JSON.stringify(m) + '\n') }, process.env);
      await gradePool(pool, byId, onSlot(new ChatClient(join(out, 'cache', 'qa')), meter, 'judge'), instrument, out, seed);
    } finally { proxy.stop(); lease.close(); }
  }
  const saved = JSON.parse(readFileSync(join(out, 'pool.json'), 'utf8')) as { seed: number; pool: Item[] };
  const stale = staleGrades(join(out, 'judgments.ndjson'), saved.pool, saved.seed);
  if (stale) { console.error(stale); process.exit(2); }
  const report = analyzeCheck(saved.pool, gradesFrom(readGraded(join(out, 'judgments.ndjson'))), byId);
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  const marker = join(out, 'upstream.json');
  const keylessRun = existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')).keyless === true : null;
  if (existsSync(join(out, 'usage.ndjson'))) console.log(JSON.stringify({ spend: usageSplit(join(out, 'usage.ndjson')), source: 'metering proxy usage log (provider usage fields)' }));
  console.log(report.gates.map(g => `${g.gate} ${g.value ?? 'n/a'} (line ${g.line}) ${g.pass ? 'pass' : 'FAIL'}`).join('\n'));
  if (report.stop) { process.stderr.write(`JUDGE_CHECK_STOP: ${report.gates.filter(g => !g.pass).map(g => g.gate).join(', ')}; wave A waits and every number goes to GBEV-3\n`); process.exit(3); }
  if (keylessRun !== false) { process.stderr.write(`JUDGE_CHECK_NOT_PAID: ${keylessRun ? 'a keyless rehearsal' : 'no keyless/paid marker in --out'}; only a paid check's report passes\n`); process.exit(4); }
}
