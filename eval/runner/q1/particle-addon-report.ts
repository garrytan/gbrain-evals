/**
 * The particle-1 add-on's report (GBEV-31): particle-1 beside claude-opus-5-5 and the cell's other readers on the same
 * questions, from published cells, in aggregates only.
 *
 *   bun eval/runner/q1/particle-addon-report.ts --root <cell output> [--root <cell output>...] --out <dir>
 *
 * Each --root is a cell output directory: its `cells/<cell id>/` answers.ndjson, judgments.ndjson and receipt.json, as
 * runCell and reread-cell.ts publish them (a sharded cell's shards are merged by answer id). A particle-1 cell pairs
 * with its frontier cell: a re-read (receipt schema q1-reread-receipt/v1) with the arm cell it re-read, and the
 * file-agent add-on (f6.ts F6_PARTICLE_ADDON) with F6's file-agent rerun, the cell whose run configuration is
 * F6_FILE_AGENT_CONFIG_SHA256.
 *
 * Per reader, replicate 0: the questions in its denominator, its mean canonical score with a 95% interval, its correct
 * answers (canonical score at least PASS_THRESHOLD), its reader dollars at list price from the answers' usage
 * (budget-ledger CHAT_PRICE_OVERRIDES base rates, no long-context tier, since an agent answer sums its turns) and its
 * dollars per correct answer. Then particle-1 minus each frontier reader, paired by question over the questions both
 * have in their denominators. Outcomes follow memory-qa/outcomes.ts: product failures score 0, while harness failures,
 * unjudged answers and not-applicable answers leave the denominator. Intervals are a bootstrap over conversations
 * (clusters), 10,000 resamples, seed `f6-p1` (the first 32 bits of its sha256); a mean's interval is the clustered
 * bootstrap of its difference from zero (stats/paired.ts clusteredPairedDelta).
 *
 * report.md and report.json in --out carry counts, means, intervals and dollars, never a question id, a question or an
 * answer; the report refuses to write when a question id of its inputs would appear in either.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { priceUsage } from '../cat40/loop.ts';
import { PASS_THRESHOLD } from '../memory-qa/instruments.ts';
import { HARNESS_FAILURES, NOT_APPLICABLE, PRODUCT_FAILURES, type Outcome } from '../memory-qa/outcomes.ts';
import { judgmentKey, readRecords, sha256, type AnswerRecord, type JudgmentRecord } from '../memory-qa/records.ts';
import { clusteredPairedDelta, type PairedDelta } from '../stats/paired.ts';
import { ALL_SETS, type SetId } from './cells/definitions.ts';
import { F6_PARTICLE_ADDON } from './cells/f6.ts';
import { REREAD_RECEIPT_SCHEMA } from './reread-cell.ts';

export const REPORT_SCHEMA = 'gbrain-evals/q1-particle-addon-report/v1';
export const SEED = 'f6-p1';
export const RESAMPLES = 10_000;
export const PARTICLE = 'particle:particle-1';
const OPUS = 'anthropic:claude-opus-5-5';
const SOL = 'openai:gpt-6.1-sol';
/** The frontier readers particle-1 is compared with, in table order after Opus and particle-1. */
const FRONTIER = [OPUS, SOL];
const DISCLOSURE = {
  particle: 'Disclosure: Y Combinator, which Garry Tan runs, is an investor in Particle, which makes particle-1.',
  gbrain: 'gbrain is Garry Tan\'s own project.',
  openai: 'Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator. Garry Tan runs Y Combinator.',
};

/**
 * The run-config sha256 of F6's published file-agent row, `s1.baseline-file-agent.baseline.whole-agent`, as F6's
 * scoreboard.md records it. F6's A4 campaign ran that cell without `--manifest f6`, so its receipt names block T1, as
 * Q1's own file-agent cell of the same id does; the run configuration tells the two apart.
 */
export const F6_FILE_AGENT_CONFIG_SHA256 = '07b938b47f0f71b3e70251da74f9cbfca5e6d666651bac9028b02874d6ca6e28';

/** The bootstrap seed: the first 32 bits of sha256(`seed`). */
export const seedNumber = (seed: string) => parseInt(sha256(seed).slice(0, 8), 16);

interface Receipt { schema?: string; cell_id: string; set?: string; block?: string; run_status?: string; config_sha256?: string | null; system: { kind: string }; instrument: { id: string; sha256: string; judge: string }; source?: { arm_cell_id: string; config_sha256?: string | null; config_sha256s?: string[] }; verify?: Record<string, number>; keyless?: boolean }
export interface PublishedCell { id: string; receipt: Receipt; answers: AnswerRecord[]; judgments: JudgmentRecord[] }

const STATUS_RANK = ['complete', 'partial', 'invalid'];
/** Every published cell under the roots, shards merged by answer id and judgment key (the merged run_status is the worst shard's); shards of other instruments, run configurations, sources or keyless markers, or two different records under one key, refuse. */
export function loadCells(roots: string[]): Map<string, PublishedCell> {
  const cells = new Map<string, PublishedCell>();
  for (const root of roots) {
    const dir = join(resolve(root), 'cells');
    if (!existsSync(dir)) throw new Error(`--root ${root} has no cells/ directory`);
    for (const id of readdirSync(dir).sort()) {
      const at = join(dir, id);
      if (!existsSync(join(at, 'receipt.json')) || !existsSync(join(at, 'answers.ndjson'))) continue;
      const receipt = JSON.parse(readFileSync(join(at, 'receipt.json'), 'utf8')) as Receipt;
      const answers = readRecords(join(at, 'answers.ndjson'), 'answer');
      const judgments = readRecords(join(at, 'judgments.ndjson'), 'judgment');
      const prior = cells.get(id);
      if (!prior) { cells.set(id, { id, receipt, answers, judgments }); continue; }
      if (JSON.stringify(prior.receipt.instrument) !== JSON.stringify(receipt.instrument)) throw new Error(`cell ${id} is judged by different instruments in different roots`);
      const provenance = (r: Receipt) => JSON.stringify([r.config_sha256 ?? null, r.source?.arm_cell_id ?? null, r.source?.config_sha256 ?? null, r.keyless ?? null]);
      if (provenance(prior.receipt) !== provenance(receipt)) throw new Error(`cell ${id} comes from different run configurations, sources or keyless markers in different roots`);
      const merge = <T>(a: T[], b: T[], key: (x: T) => string, kind: string) => {
        const m = new Map(a.map(x => [key(x), JSON.stringify(x)]));
        for (const x of b) {
          const k = key(x), j = JSON.stringify(x);
          if (m.has(k) && m.get(k) !== j) throw new Error(`cell ${id}: two different ${kind} records share one key across roots`);
          m.set(k, j);
        }
        return [...m.values()].map(j => JSON.parse(j) as T);
      };
      const worst = [prior.receipt.run_status, receipt.run_status].sort((a, b) => STATUS_RANK.indexOf(b ?? '') - STATUS_RANK.indexOf(a ?? ''))[0];
      cells.set(id, { id, receipt: { ...prior.receipt, run_status: worst }, answers: merge(prior.answers, answers, a => a.answer_id, 'answer'), judgments: merge(prior.judgments, judgments, judgmentKey, 'judgment') });
    }
  }
  return cells;
}

export interface Unit { particle: PublishedCell; frontier: PublishedCell }

/**
 * Each particle-1 cell with the frontier cell it is compared with. A re-read pairs with the cell whose run configuration
 * it verified (source.config_sha256, or any of source.config_sha256s: shards that differ only in their launch fields
 * publish several), and the file-agent add-on only with F6's file-agent rerun (run configuration
 * F6_FILE_AGENT_CONFIG_SHA256), not Q1's cell of the same id; an invalid frontier never pairs.
 */
export function unitsOf(cells: Map<string, PublishedCell>): Unit[] {
  const units: Unit[] = [];
  for (const c of cells.values()) {
    const source = c.receipt.schema === REREAD_RECEIPT_SCHEMA ? c.receipt.source!.arm_cell_id
      : c.id.startsWith(`${F6_PARTICLE_ADDON.id}.`) ? `${F6_PARTICLE_ADDON.source}${c.id.slice(F6_PARTICLE_ADDON.id.length)}` : null;
    if (!source) continue;
    const readers = [...new Set(c.answers.map(a => a.reader))];
    if (readers.length !== 1 || readers[0] !== PARTICLE) throw new Error(`${c.id} holds answers by ${readers.join(', ') || 'no reader'}, and a particle-1 cell holds particle-1's alone`);
    if (c.receipt.schema === REREAD_RECEIPT_SCHEMA && c.receipt.keyless !== false) throw new Error(`${c.id} is ${c.receipt.keyless ? 'a keyless rehearsal' : 'a re-read with no keyless marker'}, so it holds no particle-1 results`);
    const frontier = cells.get(source);
    if (!frontier) throw new Error(`particle-1 cell ${c.id} pairs with ${source}, which no --root publishes`);
    if (c.receipt.instrument.id !== frontier.receipt.instrument.id || c.receipt.instrument.sha256 !== frontier.receipt.instrument.sha256) throw new Error(`${c.id} and ${source} are judged by different instruments`);
    if (frontier.receipt.run_status === 'invalid') throw new Error(`${source} is published as invalid, so ${c.id} has nothing to be compared with`);
    if (c.receipt.schema === REREAD_RECEIPT_SCHEMA && !(c.receipt.source!.config_sha256s ?? [c.receipt.source!.config_sha256]).includes(frontier.receipt.config_sha256)) throw new Error(`${c.id} re-read a run configuration other than the one ${source} publishes`);
    if (c.receipt.schema !== REREAD_RECEIPT_SCHEMA && frontier.receipt.config_sha256 !== F6_FILE_AGENT_CONFIG_SHA256) throw new Error(`${c.id} pairs only with F6's file-agent rerun (run configuration ${F6_FILE_AGENT_CONFIG_SHA256.slice(0, 12)}), and ${source} here has run configuration ${frontier.receipt.config_sha256?.slice(0, 12) ?? 'none'}`);
    if (!frontier.receipt.set || !Object.hasOwn(ALL_SETS, frontier.receipt.set)) throw new Error(`${source} names no known set, so its preregistered exclusions are unknown`);
    units.push({ particle: c, frontier });
  }
  if (!units.length) throw new Error('no particle-1 cell under the roots: give the root of a re-read (reread-cell.ts --out) or of s1.baseline-file-agent.particle');
  return units.sort((a, b) => (a.frontier.id < b.frontier.id ? -1 : 1));
}

interface Value { conversation: string; context: string; outcome: Outcome; value: number | null; correct: boolean; usd: number }

/** Each reader's replicate-0 answers by question, leaving out the set's preregistered exclusions: the canonical score, 0 for a product failure, or null outside the denominator. */
function valuesOf(cell: PublishedCell, excluded: ReadonlySet<string>): Map<string, Map<string, Value>> {
  const { id, sha256: isha, judge } = cell.receipt.instrument;
  const canonical = new Map(cell.judgments.filter(j => j.instrument_id === id && j.instrument_sha256 === isha && j.judge === judge && j.judge_replicate === 0).map(j => [j.answer_id, j]));
  const out = new Map<string, Map<string, Value>>();
  for (const a of cell.answers.filter(x => x.replicate === 0 && !excluded.has(x.question_id))) {
    const j = canonical.get(a.answer_id);
    const value = NOT_APPLICABLE.has(a.outcome) || HARNESS_FAILURES.has(a.outcome) ? null : PRODUCT_FAILURES.has(a.outcome) ? 0
      : j && j.parse_ok && j.outcome === 'scored' && typeof j.score === 'number' ? j.score : null;
    const byQ = out.get(a.reader) ?? new Map<string, Value>();
    byQ.set(a.question_id, { conversation: a.conversation, context: a.context_sha256, outcome: a.outcome, value, correct: value !== null && value >= PASS_THRESHOLD, usd: priceUsage(a.reader.slice(a.reader.indexOf(':') + 1), a.usage) });
    out.set(a.reader, byQ);
  }
  return out;
}

const round = (x: number, d = 4) => Math.round(x * 10 ** d) / 10 ** d;
const interval = (d: PairedDelta) => (d.ci95 ? [round(d.ci95[0]), round(d.ci95[1])] as [number, number] : null);

export interface ReaderRow { reader: string; answers: number; scored: number; mean: number | null; ci95: [number, number] | null; correct: number; reader_usd: number; usd_per_correct: number | null; not_scored: Record<string, number> }
export interface DeltaRow { minus: string; pairs: number; clusters: number; frontier_mean: number; particle_mean: number; delta: number; ci95: [number, number] | null; p_two_sided: number }
export interface UnitReport { frontier_cell: string; particle_cell: string; system: string; kind: 're-read' | 'file agent'; run_status: { frontier: string | null; particle: string | null }; excluded: number; verify: Record<string, number> | null; readers: ReaderRow[]; particle_minus: DeltaRow[] }

/**
 * One unit's reader rows (Opus and particle-1 first) and particle-1's paired differences from each frontier reader. A
 * re-read refuses when particle-1 and a frontier reader read different contexts for one question.
 */
export function unitReport(u: Unit, seed = SEED): UnitReport {
  const excluded = new Set(ALL_SETS[u.frontier.receipt.set as SetId].exclusions.map(e => e.question_id));
  const values = new Map([...valuesOf(u.frontier, excluded), ...valuesOf(u.particle, excluded)]);
  const rereading = u.particle.receipt.schema === REREAD_RECEIPT_SCHEMA;
  if (rereading) for (const [q, v] of values.get(PARTICLE) ?? []) for (const f of FRONTIER) {
    const theirs = values.get(f)?.get(q);
    if (theirs && theirs.context !== v.context) throw new Error(`${u.particle.id}: particle-1 and ${f} read different contexts for one question`);
  }
  const rank = (r: string) => { const i = [OPUS, PARTICLE, SOL].indexOf(r); return i < 0 ? 3 : i; };
  const readers = [...values.keys()].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1));
  const opts = { seed: seedNumber(seed), draws: RESAMPLES };
  const rows = readers.map((reader): ReaderRow => {
    const xs = [...values.get(reader)!.entries()];
    const scored = xs.filter(([, v]) => v.value !== null);
    const d = scored.length ? clusteredPairedDelta(scored.map(([q, v]) => ({ id: q, cluster: v.conversation, a: 0, b: v.value! })), opts) : null;
    const correct = scored.filter(([, v]) => v.correct).length;
    const usd = xs.reduce((s, [, v]) => s + v.usd, 0);
    const notScored: Record<string, number> = {};
    for (const [, v] of xs) {
      const why = v.value === null ? (NOT_APPLICABLE.has(v.outcome) || HARNESS_FAILURES.has(v.outcome) ? v.outcome : 'unjudged') : PRODUCT_FAILURES.has(v.outcome) ? v.outcome : null;
      if (why) notScored[why] = (notScored[why] ?? 0) + 1;
    }
    return { reader, answers: xs.length, scored: scored.length, mean: d ? round(d.delta) : null, ci95: d ? interval(d) : null, correct, reader_usd: round(usd), usd_per_correct: correct ? round(usd / correct) : null,
      not_scored: Object.fromEntries(Object.entries(notScored).sort(([a], [b]) => (a < b ? -1 : 1))) };
  });
  const mine = values.get(PARTICLE) ?? new Map<string, Value>();
  const deltas = FRONTIER.filter(f => values.has(f)).flatMap((f): DeltaRow[] => {
    const theirs = values.get(f)!;
    const pairs = [...mine.entries()].filter(([q, v]) => v.value !== null && theirs.get(q)?.value != null).map(([q, v]) => ({ id: q, cluster: v.conversation, a: theirs.get(q)!.value!, b: v.value! }));
    if (!pairs.length) return [];
    const d = clusteredPairedDelta(pairs, opts);
    const mean = (xs: number[]) => round(xs.reduce((s, x) => s + x, 0) / xs.length);
    return [{ minus: f, pairs: d.n_pairs, clusters: d.n_clusters, frontier_mean: mean(pairs.map(x => x.a)), particle_mean: mean(pairs.map(x => x.b)), delta: round(d.delta), ci95: interval(d), p_two_sided: round(d.p_two_sided) }];
  });
  const present = new Set([...u.frontier.answers, ...u.particle.answers].map(a => a.question_id));
  return { frontier_cell: u.frontier.id, particle_cell: u.particle.id, system: u.frontier.receipt.system.kind, kind: rereading ? 're-read' : 'file agent',
    run_status: { frontier: u.frontier.receipt.run_status ?? null, particle: u.particle.receipt.run_status ?? null }, excluded: [...excluded].filter(q => present.has(q)).length,
    verify: u.particle.receipt.verify ?? null, readers: rows, particle_minus: deltas };
}

const name = (r: string) => r.slice(r.indexOf(':') + 1);
const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const pts = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}`;
const usdText = (x: number | null) => (x === null ? 'n/a' : `$${x.toFixed(4)}`);
const ci = (c: [number, number] | null, f: (x: number) => string) => (c ? `${f(c[0])} to ${f(c[1])}` : 'n/a');

export function renderReport(units: UnitReport[]): string {
  const lines = ['# particle-1 add-on: F6 cells read by particle-1', ''];
  lines.push(DISCLOSURE.particle);
  if (units.some(u => u.system === 'gbrain-defaults')) lines.push('', DISCLOSURE.gbrain);
  if (units.some(u => u.readers.some(r => r.reader.startsWith('openai:') && r.scored))) lines.push('', DISCLOSURE.openai);
  lines.push('', '## claude-opus-5-5 and particle-1', '', 'Both means are over the questions both readers have in their denominators.', '',
    '| Cell | How particle-1 read it | particle-1 run | Questions paired | Opus mean | particle-1 mean | particle-1 minus Opus (95% CI) | Opus $ per correct | particle-1 $ per correct |', '|---|---|---|---:|---:|---:|---:|---:|---:|');
  for (const u of units) {
    const opus = u.readers.find(r => r.reader === OPUS), p = u.readers.find(r => r.reader === PARTICLE), d = u.particle_minus.find(x => x.minus === OPUS);
    lines.push(`| ${u.frontier_cell} | ${u.kind} | ${u.run_status.particle ?? 'n/a'} | ${d?.pairs ?? 0} | ${pct(d?.frontier_mean ?? null)} | ${pct(d?.particle_mean ?? null)} | ${d ? `${pts(d.delta)} points (${ci(d.ci95, pts)})` : 'n/a'} | ${usdText(opus?.usd_per_correct ?? null)} | ${usdText(p?.usd_per_correct ?? null)} |`);
  }
  for (const u of units) {
    lines.push('', `## ${u.frontier_cell}`, '', `particle-1 cell \`${u.particle_cell}\` (${u.kind === 're-read' ? 'the frozen contexts the frontier readers read, sent byte for byte' : 'the file agent, run again with particle-1 as its model'}). Run status: frontier ${u.run_status.frontier ?? 'n/a'}, particle-1 ${u.run_status.particle ?? 'n/a'}. Preregistered exclusions left out: ${u.excluded}.`, '');
    lines.push('| Reader | Answers | In the denominator | Mean score (95% CI) | Correct | Reader $ (list price) | $ per correct | Not scored, by outcome |', '|---|---:|---:|---:|---:|---:|---:|---|');
    for (const r of u.readers) lines.push(`| ${name(r.reader)} | ${r.answers} | ${r.scored} | ${pct(r.mean)} (${ci(r.ci95, x => pct(x))}) | ${r.correct} | ${usdText(r.reader_usd)} | ${usdText(r.usd_per_correct)} | ${Object.entries(r.not_scored).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'} |`);
    for (const d of u.particle_minus) lines.push('', `particle-1 minus ${name(d.minus)}: ${pts(d.delta)} points (95% CI ${ci(d.ci95, pts)}), ${d.pairs} questions in ${d.clusters} conversations, two-sided sign-flip p ${d.p_two_sided}.`);
    if (u.verify) lines.push('', `Verified before any request: ${Object.entries(u.verify).map(([k, v]) => `${k.replaceAll('_', ' ')} ${v}`).join(', ')}.`);
  }
  lines.push('', '## Method', '', `Replicate 0 of each reader, without the questions the set's preregistration excludes. A product failure (${[...PRODUCT_FAILURES].join(', ')}) scores 0; a harness failure (${[...HARNESS_FAILURES].join(', ')}), an answer without a scored canonical judgment (counted as unjudged) and a not-applicable answer (${[...NOT_APPLICABLE].join(', ')}) leave the denominator. A correct answer has a canonical score of at least ${PASS_THRESHOLD}. Reader dollars price each answer's usage at the budget ledger's base list rates; failed tries are not priced, since only OpenAI-compatible readers record their usage, and each cell's metered spend is in its receipt. Intervals are a bootstrap over conversations, ${RESAMPLES.toLocaleString('en-US')} resamples, seed \`${SEED}\` (${seedNumber(SEED)}); paired differences use the questions both readers have in their denominators.`, '');
  return lines.join('\n');
}

/** Build, check and write report.md and report.json; refuses when a question id of the inputs would appear in either. */
export function writeReport(roots: string[], out: string, seed = SEED): { units: UnitReport[]; files: string[] } {
  const cells = loadCells(roots);
  const units = unitsOf(cells).map(u => unitReport(u, seed));
  const json = JSON.stringify({ schema: REPORT_SCHEMA, seed, seed_number: seedNumber(seed), resamples: RESAMPLES, clusters: 'conversation', units }, null, 2) + '\n';
  const md = renderReport(units);
  const ids = new Set([...cells.values()].flatMap(c => c.answers.map(a => a.question_id)));
  const leaked = [...ids].filter(id => json.includes(id) || md.includes(id)).length;
  if (leaked) throw new Error(`the report would carry ${leaked} question id(s); nothing was written`);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'report.json'), json);
  writeFileSync(join(out, 'report.md'), md);
  return { units, files: [join(out, 'report.md'), join(out, 'report.json')] };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const roots = argv.flatMap((a, i) => (a === '--root' && argv[i + 1] ? [argv[i + 1]] : []));
  const out = argv[argv.indexOf('--out') + 1];
  if (!roots.length || !argv.includes('--out') || !out) {
    console.error('usage: bun eval/runner/q1/particle-addon-report.ts --root <cell output> [--root <cell output>...] --out <dir>');
    process.exit(2);
  }
  try {
    const r = writeReport(roots, resolve(out));
    console.log(JSON.stringify({ units: r.units.length, files: r.files }, null, 2));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
}
