#!/usr/bin/env bun
/**
 * The weekly held-out line's judge check (preregistration docs/benchmarks/2026-11-23-weekly-outcome-line-preregistration.md,
 * "Readers and judges", R78): each gating judge is checked against at least 100 labelled grep-agent answers from public
 * dev worlds before its numbers count, at a kappa of 0.6 or more. The answers come from the grep-agent cells the weekly
 * generator builds for public worlds: the judge-check cell on bg1-dev-02 and bg1-dev-03 and the pilot's on bg1-dev-01, or
 * at the long length the judge-check cell on bg1-dev-long-02 and -03 and the pilot's on bg1-dev-long-01
 * (eval/runner/q1/cells/weekly-line.ts generateWeeklyLineJudgeCheckCells and generateWeeklyLinePilotCells). The sample, the
 * labels and the gates are the same at either length; the answers' worlds pick the dev worlds loaded. Every --cell must be
 * a cell of the length given by --length, or else GBRAIN_EVALS_WEEKLY_PILOT_LENGTH (standard when neither is set), so one
 * judge check never pools standard and long answers.
 *
 *   bun eval/runner/weekly-line/judge-check.ts label  [--length standard|long] --cell <grep-agent cell out dir>... --dry-run [--keyless-upstream <url>]
 *                                                     [--world-end <Sunday>] [--seed <n>]
 *   bun eval/runner/weekly-line/judge-check.ts label  [--length standard|long] --cell <dir>... --out <dir> --budget-ledger <file> --run-id <id>
 *                                                     --lease-usd <n> --ledger-cap-usd <n> [--world-end <Sunday>] [--seed <n>]
 *                                                     (--keyless-upstream <url> | --paid-window <unit> --window-cap-usd <n>)
 *   bun eval/runner/weekly-line/judge-check.ts report [--length standard|long] --cell <dir>... --out <dir> [--json]
 *
 * Sample. The judge of an answer is its reader's gating judge (definitions.ts bg1JudgeOf), so each judge's sample is drawn
 * from its reader's answers that carry that judge's parsed verdict: at least 100 per judge, at least 40% of them judged
 * wrong, stratified by the judge's verdict and by the answer's kind (the agent answered without a tool call, the answer
 * hedged or abstained, or neither), drawn round-robin over the kinds in a seeded order so the rare kinds are in. A judge
 * short of 100 answers, or of 40 judged wrong, refuses. Answers the turn cap or the context window cut off carry no
 * verdict (cell.ts JUDGED): they score 0 by rule, so they are counted beside the sample and stay outside kappa.
 *
 * Labels. Each sampled answer is matched against its question's gold, stale and decoy values (eval/runner/bg1/match.ts):
 * a confident answer that names the gold is labelled right and one that names a stale or decoy value wrong, both
 * "gold-settled". Every other answer (hedged or abstaining, naming none or several) is labelled by gemini-3.8-flash with the
 * instrument's own request (BG1_CANONICAL_JUDGE, descriptive view), and the report calls those labels "model-labelled".
 *
 * Money. label --dry-run prints the sample and the labelling estimate and sends nothing: no lease, no proxy, no file. A
 * real label run spends only inside a granted paid window (paid-arm.ts requireRs1Window), neither its lease nor its
 * ledger's cap passes the labelling cap (weekly-line.ts WEEKLY_LINE_LABEL_CAP_USD), and every call goes through the metering proxy under that
 * lease. A keyless run (--keyless-upstream) blanks every provider key first.
 *
 * report gives each judge's kappa against the labels with its 95% interval, the gates (kappa 0.6 or more on at least
 * 100 labelled answers), and the source of every label. It exits 3 when a gate fails and 4 for a keyless rehearsal.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DecideError } from '../decisions/errors.ts';
import { loadBg1Dev, type MemoryQuestion } from '../memory-qa/corpus.ts';
import { BG1_CANONICAL_JUDGE, instrumentFor, type Instrument } from '../memory-qa/instruments.ts';
import { ChatClient, judgeAnswer } from '../memory-qa/qa-v2.ts';
import { readRecords, sha256, type AnswerRecord } from '../memory-qa/records.ts';
import { DEFAULT_ROUTE_CAPS, keylessKeys, keylessUpstream, MeteringProxy, usageSplit } from '../metering-proxy.ts';
import { requireRs1Window, WindowRefusal } from '../paid-arm.ts';
import { claimOut, keylessUpstreamArg } from '../q1/calibration-cell.ts';
import { JUDGED, metering, onSlot, type MeterLine } from '../q1/cell.ts';
import { BG1_MEASURED, bg1JudgeOf } from '../q1/cells/definitions.ts';
import { generateWeeklyLineJudgeCheckCells, WEEKLY_LINE_JUDGE_CHECK_PER_JUDGE, WEEKLY_LINE_LABEL_CAP_USD, WEEKLY_LINE_LABELLER, WEEKLY_PILOT_LENGTH_ENV, WEEKLY_PILOT_SETS, weeklyPilotLength, type WeeklyPilotLength } from '../q1/cells/weekly-line.ts';
import { classifyV3 } from '../q1/hedge.ts';
import { exitCodeOf, renderMessage, ScoreboardError } from '../q1/scoreboard-errors.ts';
import { openRereadLease } from '../q1/reread-cell.ts';
import { DEFAULT_ROUTE_CLASSES } from '../shootout-cell.ts';
import { seededRandom } from '../stats/paired.ts';
import { cohenKappa, gradeOf, KAPPA_GATE, PROVIDER_KEYS, r4, shuffle } from '../bg1/judge-check.ts';
import { matchAnswer, type MatchClass } from '../bg1/match.ts';

export const WEEKLY_JUDGE_CHECK_SCHEMA = 'gbrain-evals/weekly-judge-check/v1';
export const WEEKLY_JUDGE_CHECK_SEED = 20261124;
/** At least this share of each judge's sample is answers the judge called wrong. */
export const MIN_WRONG_SHARE = 0.4;
/** The answer kinds the sample is stratified by, in drawing order. */
export const ANSWER_KINDS = ['no_tool_call', 'hedged', 'other'] as const;
export type AnswerKind = typeof ANSWER_KINDS[number];
/** Where a label came from: the question's gold values, or the labelling model. */
export type LabelSource = 'gold-settled' | 'gemini-3.8-flash';
export const MODEL_LABEL_SOURCE: LabelSource = 'gemini-3.8-flash';
const KAPPA_SLACK = 1e-9;

export class JudgeCheckRefusal extends Error {}
const refuse = (m: string): never => { throw new JudgeCheckRefusal(m); };

/** One grep-agent answer with its reader's gating verdict (null when the outcome carries none). */
export interface PoolAnswer { answer_id: string; cell: string; reader: string; judge: string; question_id: string; conversation: string; text: string; outcome: AnswerRecord['outcome']; stop_reason: string | null; verdict: 0 | 1 | null }
export interface SampleItem {
  id: string; judge: string; reader: string; cell: string; answer_id: string; question_id: string; conversation: string; text_sha256: string;
  kind: AnswerKind; judged: 0 | 1; match: MatchClass;
  /** The gold-settled label, or null when gemini-3.8-flash labels it. */
  gold: 0 | 1 | null;
}

/** The grep-agent cells a judge check reads: each cell out dir's one arm, from a pilot or judge-check cell of that pilot length. */
export function poolAnswers(dirs: readonly string[], length: WeeklyPilotLength = 'standard'): PoolAnswer[] {
  const sets = WEEKLY_PILOT_SETS[length], prefixes = [sets.pilot, sets.judge].map(s => `${s.toLowerCase()}.`);
  const pool = dirs.flatMap(out => {
    const cells = join(out, 'cells');
    const arms = existsSync(cells) ? readdirSync(cells).sort().filter(d => existsSync(join(cells, d, 'receipt.json'))) : [];
    if (!arms.length) refuse(`${out} holds no cell receipt under cells/`);
    return arms.flatMap(arm => {
      const dir = join(cells, arm), receipt = JSON.parse(readFileSync(join(dir, 'receipt.json'), 'utf8'));
      if (!['BGW-pilot', 'BGW-judge'].includes(receipt.block) || receipt.system?.kind !== 'baseline-file-agent') refuse(`${dir} is not a weekly grep-agent pilot or judge-check cell (block ${receipt.block}, system ${receipt.system?.kind})`);
      if (!prefixes.some(x => String(receipt.run_cell).startsWith(x))) refuse(`${dir} is cell ${receipt.run_cell}, not a cell of the ${length} pilot (${sets.pilot} or ${sets.judge}); pass the --length its campaigns were written with`);
      const verdicts = new Map(readRecords(join(dir, 'judgments.ndjson'), 'judgment').filter(j => j.judge_replicate === 0).map(j => [`${j.answer_id}|${j.judge}`, gradeOf(j).score]));
      return readRecords(join(dir, 'answers.ndjson'), 'answer').map((a: AnswerRecord): PoolAnswer => {
        const judge = bg1JudgeOf(a.reader), score = JUDGED.has(a.outcome) ? verdicts.get(`${a.answer_id}|${judge}`) ?? null : null;
        return { answer_id: a.answer_id, cell: String(receipt.run_cell), reader: a.reader, judge, question_id: a.question_id, conversation: a.conversation, text: a.text, outcome: a.outcome, stop_reason: a.stop_reason ?? null, verdict: score === null ? null : score >= 1 ? 1 : 0 };
      });
    });
  });
  const seen = new Set<string>();
  for (const a of pool) { if (seen.has(a.answer_id)) refuse(`answer ${a.answer_id} appears twice across the --cell directories; pass each cell out dir once`); seen.add(a.answer_id); }
  return pool;
}

export const answerKind = (a: Pick<PoolAnswer, 'stop_reason' | 'text'>): AnswerKind =>
  a.stop_reason === 'no_tool_call' ? 'no_tool_call' : ['hedged', 'abstain'].includes(classifyV3(a.text)) ? 'hedged' : 'other';

/** The gold-settled label of a confident answer that names the gold, or a stale or decoy value; null otherwise. */
export function goldLabel(q: Pick<MemoryQuestion, 'id' | 'bg1'>, a: Pick<PoolAnswer, 'stop_reason' | 'text'>): { match: MatchClass; gold: 0 | 1 | null } {
  const match = matchAnswer(q, a.text);
  if (answerKind(a) === 'hedged') return { match, gold: null };
  return { match, gold: match === 'correct' ? 1 : match === 'stale' || match === 'decoy' ? 0 : null };
}

/** Draw `n` round-robin over the kinds, each kind's answers in a seeded order. */
function drawByKind(xs: readonly PoolAnswer[], n: number, rand: () => number): PoolAnswer[] {
  const queues = ANSWER_KINDS.map(k => shuffle(xs.filter(a => answerKind(a) === k), rand));
  const out: PoolAnswer[] = [];
  while (out.length < n && queues.some(q => q.length)) for (const q of queues) if (q.length && out.length < n) out.push(q.shift()!);
  return out;
}

/**
 * Each judge's sample: `perJudge` of its reader's answers with a verdict, half judged wrong where there are enough and never
 * under 40%, drawn by kind. Refuses a judge short of answers or of answers judged wrong.
 */
export function buildSample(answers: readonly PoolAnswer[], questions: ReadonlyMap<string, Pick<MemoryQuestion, 'id' | 'bg1'>>, seed = WEEKLY_JUDGE_CHECK_SEED, perJudge = WEEKLY_LINE_JUDGE_CHECK_PER_JUDGE): SampleItem[] {
  const rand = seededRandom(seed), minWrong = Math.ceil(perJudge * MIN_WRONG_SHARE);
  const verdicted = answers.filter(a => a.verdict !== null).sort((a, b) => (a.answer_id < b.answer_id ? -1 : a.answer_id > b.answer_id ? 1 : 0));
  return [...new Set(verdicted.map(a => a.judge))].sort().flatMap(judge => {
    const mine = verdicted.filter(a => a.judge === judge), wrong = mine.filter(a => a.verdict === 0), right = mine.filter(a => a.verdict === 1);
    const takeWrong = Math.min(wrong.length, Math.max(Math.ceil(perJudge / 2), perJudge - right.length));
    if (mine.length < perJudge || takeWrong < minWrong) refuse(`JUDGE_CHECK_SHORT: ${judge} has ${mine.length} answers with a verdict, ${wrong.length} judged wrong; the check needs ${perJudge}, at least ${minWrong} judged wrong`);
    return [...drawByKind(wrong, takeWrong, rand), ...drawByKind(right, perJudge - takeWrong, rand)].map(a => {
      const q = questions.get(a.question_id) ?? refuse(`question ${a.question_id} of ${a.answer_id} is not in the loaded dev worlds`);
      return { id: `wjc-${a.answer_id}`, judge, reader: a.reader, cell: a.cell, answer_id: a.answer_id, question_id: a.question_id, conversation: a.conversation, text_sha256: sha256(a.text), kind: answerKind(a), judged: a.verdict!, ...goldLabel(q, a) };
    });
  });
}

/** Answers outside kappa: an outcome with no verdict (turn cap, context overflow and the rest), by judge and outcome. */
export function ruleZero(answers: readonly PoolAnswer[]): Record<string, Record<string, number>> {
  const m: Record<string, Record<string, number>> = {};
  for (const a of answers.filter(x => !JUDGED.has(x.outcome))) (m[a.judge] ??= {})[a.outcome] = (m[a.judge]?.[a.outcome] ?? 0) + 1;
  return m;
}

/** What labelling the sample costs at BG1's measured dollars a call of gemini-3.8-flash, and its cap. */
export function labelEstimate(sample: readonly SampleItem[]) {
  const calls = sample.filter(i => i.gold === null).length;
  return { calls, usd: r4(calls * BG1_MEASURED.canonical_judge_usd_per_call)!, cap_usd: WEEKLY_LINE_LABEL_CAP_USD, basis: `${BG1_CANONICAL_JUDGE} at BG1's measured $${BG1_MEASURED.canonical_judge_usd_per_call} a call` };
}

export interface ModelLabel { item: string; text_sha256: string; label: 0 | 1 | null }
const readLabels = (file: string): ModelLabel[] => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);

/** Each judge's kappa against the labels, its gates, and every item's label and source. */
export function analyze(sample: readonly SampleItem[], modelLabels: readonly ModelLabel[], zero: Record<string, Record<string, number>>) {
  const byItem = new Map(modelLabels.map(l => [l.item, l]));
  const items = sample.map(i => {
    const m = byItem.get(i.id), fromModel = i.gold === null;
    const label = fromModel ? (m && m.text_sha256 === i.text_sha256 ? m.label : null) : i.gold;
    return { ...i, label, label_source: (fromModel ? MODEL_LABEL_SOURCE : 'gold-settled') as LabelSource };
  });
  const judges = Object.fromEntries([...new Set(items.map(i => i.judge))].sort().map(judge => {
    const mine = items.filter(i => i.judge === judge), labelled = mine.filter(i => i.label !== null);
    const k = cohenKappa(labelled.map(i => i.judged === 1), labelled.map(i => i.label === 1));
    const sources = { 'gold-settled': labelled.filter(i => i.label_source === 'gold-settled').length, [MODEL_LABEL_SOURCE]: labelled.filter(i => i.label_source === MODEL_LABEL_SOURCE).length };
    const gates = [
      { gate: 'kappa', value: r4(k.kappa), line: KAPPA_GATE, pass: k.kappa !== null && k.kappa >= KAPPA_GATE - KAPPA_SLACK },
      { gate: 'labelled', value: labelled.length, line: WEEKLY_LINE_JUDGE_CHECK_PER_JUDGE, pass: labelled.length >= WEEKLY_LINE_JUDGE_CHECK_PER_JUDGE },
    ];
    const count = (f: (i: (typeof mine)[number]) => string) => mine.reduce<Record<string, number>>((m, i) => ({ ...m, [f(i)]: (m[f(i)] ?? 0) + 1 }), {});
    return [judge, {
      reader: mine[0].reader, sampled: mine.length, labelled: labelled.length, unlabelled: mine.length - labelled.length,
      judged_wrong: mine.filter(i => i.judged === 0).length, strata: count(i => `${i.kind}/${i.judged ? 'right' : 'wrong'}`),
      kappa: r4(k.kappa), ci95: k.ci95?.map(x => r4(x)!) ?? null, agreement: labelled.length ? r4(labelled.filter(i => (i.judged === 1) === (i.label === 1)).length / labelled.length) : null,
      label_sources: sources, model_labelled: sources[MODEL_LABEL_SOURCE] > 0, rule_zero_outside_kappa: zero[judge] ?? {}, gates, pass: gates.every(g => g.pass),
    }];
  }));
  return { schema: WEEKLY_JUDGE_CHECK_SCHEMA, labeller: WEEKLY_LINE_LABELLER, judges, items: items.map(({ id, judge, question_id, kind, judged, match, label, label_source }) => ({ id, judge, question_id, kind, judged, match, label, label_source })), stop: Object.values(judges).some(j => !j.pass) };
}
export type WeeklyJudgeCheckReport = ReturnType<typeof analyze>;

/** The labelling instrument: the judge-check cells' own, so gemini-3.8-flash sees the request the gating judges saw. */
export const labelInstrument = (): Instrument => instrumentFor(generateWeeklyLineJudgeCheckCells()[0].canonical_instrument);

/** judgeAnswer's attempts at one grade (its default); a resumed item asks this many more, past the attempts its cache already holds. */
const JUDGE_ATTEMPTS = 3;

/**
 * gemini-3.8-flash labels every item without a gold-settled label that has no parsed label yet. A resume retries an
 * unparsed one with attempt numbers past those already cached, so the provider is asked again; a failed call stops the pass.
 */
export async function labelWithGemini(sample: readonly SampleItem[], answers: ReadonlyMap<string, PoolAnswer>, questions: ReadonlyMap<string, MemoryQuestion>, client: Parameters<typeof judgeAnswer>[0], meter: ReturnType<typeof metering>, instrument: Instrument, file: string): Promise<string | null> {
  const saved = readLabels(file), done = new Set(saved.filter(l => l.label !== null).map(l => l.item));
  for (const i of sample.filter(x => x.gold === null && !done.has(x.id))) {
    const maxAttempts = JUDGE_ATTEMPTS * (1 + saved.filter(l => l.item === i.id).length);
    const r = await meter.around('judge', `judge:${i.id.slice(0, 21)}:${BG1_CANONICAL_JUDGE}`, 'judge', () => judgeAnswer(client, instrument, questions.get(i.question_id)!, answers.get(i.answer_id)!.text, { judge: BG1_CANONICAL_JUDGE, judgeReplicate: 0, view: 'descriptive', maxAttempts }));
    if (r.error !== undefined) return `${BG1_CANONICAL_JUDGE} on ${i.id}: ${String((r.error as Error).message).slice(0, 200)}`;
    const score = gradeOf(r.value!).score;
    appendFileSync(file, JSON.stringify({ item: i.id, text_sha256: i.text_sha256, label: score === null ? null : score >= 1 ? 1 : 0, judgment: r.value } satisfies ModelLabel & { judgment: unknown }) + '\n');
  }
  return null;
}

// ─── Command line ────────────────────────────────────────────────────

const usage = 'usage: judge-check.ts label --cell <dir>... (--dry-run | --out <dir> --budget-ledger <file> --run-id <id> --lease-usd <n> --ledger-cap-usd <n> (--keyless-upstream <url> | --paid-window <unit> --window-cap-usd <n>)) [--world-end <Sunday>] [--seed <n>] | report --cell <dir>... --out <dir> [--json]';

export async function main(argv: string[], log: (s: string) => void = s => console.log(s)): Promise<number> {
  const mode = argv[0], dryRun = argv.includes('--dry-run');
  const one = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const dirs = [...new Set(argv.flatMap((a, i) => (a === '--cell' && argv[i + 1] ? [resolve(argv[i + 1])] : [])))];
  const out = one('--out') ? resolve(one('--out')!) : null;
  if (!['label', 'report'].includes(mode) || !dirs.length || (!out && !(mode === 'label' && dryRun))) { console.error(usage); return 2; }
  const seed = one('--seed') ? Number(one('--seed')) : WEEKLY_JUDGE_CHECK_SEED;
  if (!Number.isInteger(seed)) { console.error('--seed takes an integer'); return 2; }
  let keyless: string | null = null;
  try { keyless = mode === 'label' ? keylessUpstreamArg(argv) : null; } catch (e) { console.error((e as Error).message); return 2; }
  const paid = mode === 'label' && !dryRun && !keyless;
  if (!paid) for (const k of PROVIDER_KEYS) delete process.env[k];
  const [ledger, runId, leaseUsd, cap] = [one('--budget-ledger'), one('--run-id'), Number(one('--lease-usd')), Number(one('--ledger-cap-usd'))];
  if (mode === 'label' && !dryRun) {
    if (!ledger || !runId || !(leaseUsd > 0) || !(cap > 0)) { console.error('label needs --budget-ledger, --run-id, --lease-usd and --ledger-cap-usd, or --dry-run'); return 2; }
    if (leaseUsd > WEEKLY_LINE_LABEL_CAP_USD + 1e-9 || cap > WEEKLY_LINE_LABEL_CAP_USD + 1e-9) { console.error(`--lease-usd ${leaseUsd} and --ledger-cap-usd ${cap} may not pass the labelling cap of $${WEEKLY_LINE_LABEL_CAP_USD}, which bounds the labelling ledger across resumes`); return 2; }
    try { requireRs1Window(argv, { what: 'the weekly judge check\'s labelling without --keyless-upstream', keyless: !!keyless, caps: () => [{ label: '--ledger-cap-usd', usd: cap }, { label: '--lease-usd', usd: leaseUsd }] }); }
    catch (e) { if (!(e instanceof WindowRefusal)) throw e; console.error(e.message); return 2; }
  }
  const marker = out ? join(out, 'upstream.json') : null;
  const savedFile = out ? join(out, 'sample.json') : null;
  const saved = savedFile && existsSync(savedFile) ? JSON.parse(readFileSync(savedFile, 'utf8')) as { seed: number; world_end: string; keyless: boolean; sample: SampleItem[] } : null;
  const loadKeyless = mode === 'label' ? !!keyless : (marker && existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')).keyless === true : false);
  let length: WeeklyPilotLength;
  try { length = weeklyPilotLength(one('--length') === undefined ? process.env : { [WEEKLY_PILOT_LENGTH_ENV]: one('--length') }); } catch (e) { console.error((e as Error).message); return 2; }
  let answers: PoolAnswer[], questions: Map<string, MemoryQuestion>, sample: SampleItem[], worldEnd: string;
  try {
    answers = poolAnswers(dirs, length);
    worldEnd = one('--world-end') ?? (mode === 'report' ? saved?.world_end : undefined) ?? process.env.GBRAIN_EVALS_BG1_WORLD_END ?? refuse('pass --world-end <Sunday>, the world end the cells ran at (GBRAIN_EVALS_BG1_WORLD_END)');
    const corpus = loadBg1Dev({ only: new Set(answers.map(a => a.conversation)), worldEnd, keyless: loadKeyless });
    questions = new Map(corpus.questions.map(q => [q.id, q]));
    sample = buildSample(answers, questions, mode === 'report' && saved ? saved.seed : seed);
  } catch (e) {
    if (e instanceof JudgeCheckRefusal || e instanceof DecideError) { console.error(e.message); return 2; }
    if (e instanceof ScoreboardError) { process.stderr.write(renderMessage(e.op) + '\n'); return exitCodeOf(e.op); }
    throw e;
  }
  const zero = ruleZero(answers);

  if (mode === 'label' && dryRun) {
    log(JSON.stringify({ dry_run: true, sends: 'nothing', labeller: WEEKLY_LINE_LABELLER, seed, world_end: worldEnd, answers: answers.length,
      sample: analyze(sample, [], zero).judges, gold_settled: sample.filter(i => i.gold !== null).length, model_labelled: sample.filter(i => i.gold === null).length,
      estimate: labelEstimate(sample), items: sample.map(i => ({ id: i.id, judge: i.judge, kind: i.kind, judged: i.judged, match: i.match, label_source: i.gold === null ? MODEL_LABEL_SOURCE : 'gold-settled' })) }, null, 2));
    return 0;
  }

  if (mode === 'label') {
    if (saved && JSON.stringify(saved.sample) !== JSON.stringify(sample)) { console.error(`${savedFile} holds another sample than these cells give at seed ${seed}; give this run a fresh --out`); return 2; }
    mkdirSync(out!, { recursive: true });
    let stopped: string | null = null;
    try {
      claimOut(out!, !!keyless, 'weekly judge-check');
      writeFileSync(savedFile!, JSON.stringify({ seed, world_end: worldEnd, keyless: !!keyless, cells: dirs, sample }, null, 2) + '\n');
      const [cellToken, controlToken] = [randomUUID(), randomUUID()];
      Object.assign(process.env, { SHOOTOUT_CELL_TOKEN: cellToken, SHOOTOUT_PROXY_CONTROL_TOKEN: controlToken });
      const lease = openRereadLease({ runId: runId!, leaseUsd, ledgerPath: resolve(ledger!), capUsd: cap, runner: 'weekly-judge-check' });
      const usageLog = join(out!, 'usage.ndjson');
      const proxy = new MeteringProxy({ ...(keyless ? { upstream: keylessUpstream(keyless) } : {}), cellToken, controlToken,
        policy: { lease, usageLog, env: keyless ? keylessKeys() : { ...process.env }, routeCaps: { caps: { ...DEFAULT_ROUTE_CAPS }, slots: { ...DEFAULT_ROUTE_CLASSES }, defaultClass: 'extraction' } } });
      proxy.start();
      try {
        const url = `http://127.0.0.1:${proxy.port}`;
        const meter = metering(url, { meter: (m: MeterLine) => appendFileSync(join(out!, 'meters.ndjson'), JSON.stringify(m) + '\n') }, process.env);
        stopped = await labelWithGemini(sample, new Map(answers.map(a => [a.answer_id, a])), questions, onSlot(new ChatClient(join(out!, 'cache', 'qa')), meter, 'judge'), meter, labelInstrument(), join(out!, 'labels.ndjson'));
      } finally { proxy.stop(); lease.close(); }
    } catch (e) {
      if (e instanceof ScoreboardError) { process.stderr.write(renderMessage(e.op) + '\n'); return exitCodeOf(e.op); }
      throw e;
    }
    if (stopped) { process.stderr.write(`WEEKLY_JUDGE_CHECK_PARTIAL: ${stopped}; rerun on the same --out with a fresh --run-id to resume\n`); return 4; }
  }

  if (!saved && mode === 'report') { console.error(`${out} holds no sample.json; run label first`); return 2; }
  const current = mode === 'report' ? saved! : JSON.parse(readFileSync(savedFile!, 'utf8'));
  if (JSON.stringify(current.sample) !== JSON.stringify(sample)) { console.error(`${savedFile} is not the sample these cells give at seed ${current.seed}`); return 2; }
  const report = analyze(sample, readLabels(join(out!, 'labels.ndjson')), zero);
  writeFileSync(join(out!, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  if (existsSync(join(out!, 'usage.ndjson'))) log(JSON.stringify({ spend: usageSplit(join(out!, 'usage.ndjson')), source: 'metering proxy usage log (provider usage fields)' }));
  log(argv.includes('--json') ? JSON.stringify(report, null, 2) : Object.entries(report.judges).map(([judge, j]) =>
    `${judge} (reader ${j.reader}): kappa ${j.kappa ?? 'n/a'} on ${j.labelled} labelled (${j.label_sources['gold-settled']} gold-settled, ${j.label_sources[MODEL_LABEL_SOURCE]} ${MODEL_LABEL_SOURCE}${j.model_labelled ? ', model-labelled' : ''}); ${j.gates.map(g => `${g.gate} ${g.pass ? 'pass' : 'FAIL'}`).join(', ')}; outside kappa by rule: ${JSON.stringify(j.rule_zero_outside_kappa)}`).join('\n'));
  if (report.stop) { process.stderr.write(`JUDGE_CHECK_STOP: ${Object.entries(report.judges).filter(([, j]) => !j.pass).map(([k]) => k).join(', ')}; that judge's weekly numbers do not count\n`); return 3; }
  if (current.keyless !== false) { process.stderr.write('JUDGE_CHECK_NOT_PAID: a keyless rehearsal; only a paid check\'s report passes\n'); return 4; }
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
