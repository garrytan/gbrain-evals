/**
 * The frozen RS1 analysis (GST-1154 PR 2): the preregistration's "Estimands and statistics" and "Cost per correct
 * answer" (docs/benchmarks/2026-11-04-rs1-ranking-set-preregistration.md) as code, fixed before any RS1 conversation is
 * minted. The scoreboard's RS1 mode (eval/runner/scoreboard.ts, a campaign.json carrying an `rs1` block) reads the
 * receipt under Q1's outcome rules and hands this module every row's per-question, per-reader values; each step that
 * turns them into a verdict, a sentence or a table number lives here, so the sha256 of this one file pins the analysis
 * (review F19). The rs1 block records that hash, and scoreboard check and render refuse a file that differs unless the
 * block names a dated amendment with the new hash. Pure: no file, clock or network access.
 *
 * The rules, each fixed before minting:
 *   - Score: BEAM graded accuracy x 100 per answer. A reader's score for an answer is the mean of its planned judges'
 *     replicate-0 scores (q1/cells/judging.ts): Opus rows openai:gpt-4.1-mini (BEAM's canonical judge), Sol rows
 *     anthropic:claude-haiku-5-5, particle-1 rows both. No judge grades its own family's rows, and particle-1 never
 *     judges.
 *   - Missing data (review F17): a product failure scores 0 and stays in; a harness failure, a missing answer, an answer
 *     that did not fit, or a planned judge with no score gives that reader no value. A question enters a comparison only
 *     when both rows have a value from every reader of the family, so a particle-1 answer counts only when both its
 *     judges scored it. Every question left out is counted by reason.
 *   - Estimand: per question, the mean over the family's readers of each reader's score, subject minus comparison; the
 *     estimate is the question-weighted mean, with conversations as clusters.
 *   - Families: A, gbrain's 8,000-token read (arm P) minus each of the three memory servers; B, gbrain's whole-system
 *     think loop minus the file agent; readers Opus and Sol. The particle-1 family runs the same four comparisons with
 *     particle-1 alone (its packed rows re-read the same frozen contexts byte for byte), under the same rules, and is
 *     reported apart.
 *   - Test: the restricted wild cluster bootstrap-t (stats/wild-cluster.ts), Webb weights, 9,999 draws, seed 20261103.
 *     The decisive intervals are Bonferroni: 1 - 0.05/3 (98.33%) for each family A comparison, 95% for family B. Holm
 *     p-values at 0 are secondary; a comparison with no verdict enters Holm at p = 1, so its family keeps its size.
 *   - Verdict, in this precedence: ahead (lower bound > 0), behind (upper bound < 0), level (the interval holds 0 and
 *     lies within [-M, +M]), else inconclusive. M is 3.5 points (A) and 4.1 (B) at size N, 2.1 and 2.5 at size O.
 *   - Delivered-context gate: each 8k row's delivered context, in cl100k tokens per question, must have a mean and a
 *     nearest-rank p95 within 7,200 to 8,800 inclusive. A family A comparison whose subject or comparator misses is
 *     descriptive: estimate and interval, no verdict.
 *   - A comparison that does not run (a row not run or invalid, or fewer than two conversations with a paired question)
 *     keeps its place in its family, gets no verdict, and blocks the ranking claim.
 *   - Ranking: "gbrain ranks first among these memory servers" only when all three family A comparisons are ahead. The
 *     particle-1 family never enters it.
 *   - Judge sensitivity (review F18), descriptive: on the 30% of the conversation positions with the smallest
 *     sha256("rs1-sensitivity", NUL, position) (23 of 75 at size N; the sample rs1/judge.ts grades and rs1-cells.json
 *     records), each family A and B comparison's estimate and interval under the counted judges and under
 *     gemini:gemini-3.8-flash.
 *   - Cost per correct answer: (ingest dollars per conversation / R + read dollars per question) / graded accuracy, at R
 *     = 1, 20 and 200 reads per stored conversation. Dollars come from the receipt's metered cost file, which prices VM
 *     time at $0.05 per vCPU-hour.
 */
import { createHash } from 'node:crypto';
import { holmAdjusted } from '../stats/paired.ts';
import { estimate, prepare, wildRestrictedInterval, wildRestrictedP, type ClusterRow } from '../stats/wild-cluster.ts';

/** This file, whose sha256 the rs1 block records (review F19). */
export const RS1_VERDICT_PATH = 'eval/runner/rs1/verdict.ts';

export type Rs1Size = 'N' | 'O';
export type FamilyId = 'A' | 'B';
export type Verdict = 'ahead' | 'behind' | 'level' | 'inconclusive';
export type Rs1Outcome = Verdict | 'descriptive' | 'not-run';

export const DRAWS = 9999;
export const SEED = 20261103;
export const WEIGHTS = 'webb' as const;
const ALPHA = 0.05;
export const FAMILY_SIZE: Record<FamilyId, number> = { A: 3, B: 1 };
/** Bonferroni: each comparison's two-sided alpha is the family's 0.05 split over its comparisons. */
export const COMPARISON_ALPHA: Record<FamilyId, number> = { A: ALPHA / FAMILY_SIZE.A, B: ALPHA / FAMILY_SIZE.B };
export const INTERVAL_LEVEL: Record<FamilyId, number> = { A: 1 - COMPARISON_ALPHA.A, B: 1 - COMPARISON_ALPHA.B };
export const MARGIN_POINTS: Record<Rs1Size, Record<FamilyId, number>> = { N: { A: 3.5, B: 4.1 }, O: { A: 2.1, B: 2.5 } };
export const CONVERSATIONS: Record<Rs1Size, number> = { N: 75, O: 200 };

export const OPUS = 'anthropic:claude-opus-5-5';
export const SOL = 'openai:gpt-6.1-sol';
export const PARTICLE = 'particle:particle-1';
/** The family readers of A and B. The first table reports Opus and particle-1 first, then Sol. */
export const COUNTED_READERS = [OPUS, SOL];
export const JUDGES: Record<string, string[]> = { [OPUS]: ['openai:gpt-4.1-mini'], [SOL]: ['anthropic:claude-haiku-5-5'], [PARTICLE]: ['openai:gpt-4.1-mini', 'anthropic:claude-haiku-5-5'] };
export const ARMS = {
  gbrain8k: 'rs1.gbrain-defaults.rs1-master.p',
  servers: ['rs1.ext-extract-first.common.component-b8000', 'rs1.ext-memory-bank.recipe-1.1.component-b8000', 'rs1.ext-temporal-graph.shipped-0.31.component-b8000'],
  think: 'rs1.gbrain-defaults.rs1-master.whole-think',
  fileAgent: 'rs1.baseline-file-agent.baseline.whole-agent',
  descriptive: ['rs1.baseline-hybrid.baseline.component-b8000', 'rs1.baseline-none.baseline.component-b8000'],
} as const;
export const GATE = { budget: 8000, encoding: 'cl100k_base', low: 7200, high: 8800 };
export const SENSITIVITY_JUDGE = 'gemini:gemini-3.8-flash';
export const SENSITIVITY_SEED = 'rs1-sensitivity';
export const SENSITIVITY_SHARE = 0.3;
export const COST_READS = [1, 20, 200];
export const VCPU_HOUR_USD = 0.05;

/** particle-1's re-read of a packed arm (the rule q1/reread-cell.ts rereadCellId applies; test/eval/rs1-verdict.test.ts holds them equal). */
export const rereadId = (armCellId: string) => `${armCellId}.reread-${PARTICLE.replace(/[^a-z0-9.-]+/gi, '-')}`;
/** The conversation positions of a size: rs1-001 to rs1-075 at N. */
export const positions = (size: Rs1Size) => Array.from({ length: CONVERSATIONS[size] }, (_, i) => `rs1-${String(i + 1).padStart(3, '0')}`);

/** The judge-sensitivity sample: the 30% (rounded up) of the positions with the smallest sha256(SENSITIVITY_SEED, NUL, position), sorted. */
export function sensitivitySample(size: Rs1Size): string[] {
  const rank = (id: string) => createHash('sha256').update(`${SENSITIVITY_SEED}\u0000${id}`).digest('hex');
  return positions(size).sort((a, b) => (rank(a) < rank(b) ? -1 : 1)).slice(0, Math.ceil(SENSITIVITY_SHARE * CONVERSATIONS[size])).sort();
}

// ─── The rs1 block (publication.json, copied into campaign.json) ─────

export interface Rs1Family { id: FamilyId; subject: string; comparators: string[]; interval_level: number; margin_points: number }
export interface Rs1Amendment { id: string; date: string; verdict_sha256: string; reason: string }
export interface Rs1Block {
  /** sha256 of this file at the freeze; `amendments` (dated, in order) replace it, the last one in force. */
  verdict_sha256: string; amendments: Rs1Amendment[];
  size: Rs1Size; set: string;
  statistics: { draws: number; seed: number; weights: typeof WEIGHTS };
  families: Rs1Family[];
  /** Packed 8k rows tabled and gated beside family A, never compared. */
  descriptive: string[];
  readers: { counted: string[]; particle: string };
  /** Judges by reader: a reader's answer scores the mean of these judges' replicate-0 scores. */
  judges: Record<string, string[]>;
  /** Each packed arm's particle-1 re-read cell. */
  reread: Record<string, string>;
  gate: typeof GATE;
  sensitivity: { judge: string; seed: string; share: number; conversations: string[] };
  cost: { reads: number[]; vcpu_hour_usd: number };
}

/** The block the frozen analysis expects at a size, apart from its hash and amendments. */
export function frozenBlock(size: Rs1Size): Omit<Rs1Block, 'verdict_sha256' | 'amendments'> {
  const packed = [ARMS.gbrain8k, ...ARMS.servers, ...ARMS.descriptive];
  return {
    size, set: 'RS1', statistics: { draws: DRAWS, seed: SEED, weights: WEIGHTS },
    families: [
      { id: 'A', subject: ARMS.gbrain8k, comparators: [...ARMS.servers], interval_level: INTERVAL_LEVEL.A, margin_points: MARGIN_POINTS[size].A },
      { id: 'B', subject: ARMS.think, comparators: [ARMS.fileAgent], interval_level: INTERVAL_LEVEL.B, margin_points: MARGIN_POINTS[size].B },
    ],
    descriptive: [...ARMS.descriptive], readers: { counted: [...COUNTED_READERS], particle: PARTICLE }, judges: structuredClone(JUDGES),
    reread: Object.fromEntries(packed.map(id => [id, rereadId(id)])), gate: { ...GATE },
    sensitivity: { judge: SENSITIVITY_JUDGE, seed: SENSITIVITY_SEED, share: SENSITIVITY_SHARE, conversations: sensitivitySample(size) }, cost: { reads: [...COST_READS], vcpu_hour_usd: VCPU_HOUR_USD },
  };
}

/** JSON with object keys sorted, so a block written in another key order compares equal. */
const canon = (x: unknown): string => JSON.stringify(x, (_, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v));
const SHA = /^[0-9a-f]{64}$/;

/** Every way a block differs from the frozen analysis (margins, interval levels, readers, judges, gate, ...); empty when it matches. */
export function blockProblems(b: Rs1Block): string[] {
  if (b.size !== 'N' && b.size !== 'O') return [`rs1 size is ${JSON.stringify(b.size ?? null)}, not N or O`];
  const want = frozenBlock(b.size), out: string[] = [];
  if (!SHA.test(b.verdict_sha256 ?? '')) out.push(`rs1 verdict_sha256 is ${JSON.stringify(b.verdict_sha256 ?? null)}, not a sha256`);
  if (!Array.isArray(b.amendments)) out.push('rs1 amendments is not a list');
  for (const a of Array.isArray(b.amendments) ? b.amendments : []) if (!a.id || !a.reason || !/^\d{4}-\d{2}-\d{2}$/.test(a.date ?? '') || !SHA.test(a.verdict_sha256 ?? '')) out.push(`rs1 amendment ${JSON.stringify(a.id ?? null)} needs an id, a YYYY-MM-DD date, a reason and the new verdict_sha256`);
  if (b.families?.length !== want.families.length) out.push(`rs1 lists ${b.families?.length ?? 0} families; the frozen analysis has ${want.families.length} (A and B)`);
  for (const [i, f] of want.families.entries()) {
    const g = b.families?.[i];
    if (!g || g.id !== f.id) { out.push(`rs1 families[${i}] is ${JSON.stringify(g?.id ?? null)}; the frozen analysis has family ${f.id} there`); continue; }
    if (g.margin_points !== f.margin_points) out.push(`rs1 family ${f.id} margin is ${g.margin_points} points; the frozen margin at size ${b.size} is ${f.margin_points}`);
    if (g.interval_level !== f.interval_level) out.push(`rs1 family ${f.id} interval level is ${g.interval_level}; the frozen level is ${f.interval_level}`);
    if (g.subject !== f.subject || canon(g.comparators) !== canon(f.comparators)) out.push(`rs1 family ${f.id} compares ${g.subject} with ${JSON.stringify(g.comparators)}; the frozen family compares ${f.subject} with ${JSON.stringify(f.comparators)}`);
  }
  for (const k of ['set', 'statistics', 'descriptive', 'readers', 'judges', 'reread', 'gate', 'sensitivity', 'cost'] as const) {
    if (canon(b[k]) !== canon(want[k])) out.push(`rs1 ${k} is ${JSON.stringify(b[k] ?? null)}; the frozen analysis has ${JSON.stringify(want[k])}`);
  }
  return out;
}

/** The hash of the analysis in force: the last amendment's, else the freeze's. */
export const analysisSha256 = (b: Pick<Rs1Block, 'verdict_sha256' | 'amendments'>) => b.amendments.at(-1)?.verdict_sha256 ?? b.verdict_sha256;

export interface Rs1CellShape { cell_id: string; set: string; arm: string; budget: number | null; readers: string[]; judging?: { by_reader: Record<string, string[]> } }

/** Every way the campaign's cells differ from what a matching block's analysis reads: their set, arm, readers and judge plans. */
export function cellProblems(b: Rs1Block, cells: readonly Rs1CellShape[]): string[] {
  const out: string[] = [];
  const [A, B] = b.families;
  const packed = [A.subject, ...A.comparators, ...b.descriptive], whole = [B.subject, ...B.comparators];
  const sorted = (xs: readonly string[] | null | undefined) => (xs ? canon([...xs].sort()) : 'null');
  for (const id of [...packed, ...whole]) {
    const c = cells.find(x => x.cell_id === id);
    if (!c) { out.push(`rs1 names cell ${id}, which campaign.json does not list`); continue; }
    const isPacked = packed.includes(id);
    if (c.set !== b.set) out.push(`rs1 cell ${id} is on set ${c.set}, not ${b.set}`);
    if (isPacked ? c.arm !== 'component' || c.budget !== b.gate.budget : c.arm !== 'whole-system') out.push(`rs1 cell ${id} is a ${c.arm} row at ${c.budget ?? 'its own default'} tokens; the frozen analysis reads it as ${isPacked ? `a component row at ${b.gate.budget.toLocaleString('en-US')} tokens` : 'a whole-system row'}`);
    const readers = isPacked ? b.readers.counted : [...b.readers.counted, b.readers.particle];
    if (sorted(c.readers) !== sorted(readers)) out.push(`rs1 cell ${id} promises readers ${c.readers.join(', ')}; the frozen readers are ${readers.join(', ')}`);
    for (const [reader, judges] of Object.entries(c.judging?.by_reader ?? {})) if (sorted(judges) !== sorted(b.judges[reader])) out.push(`rs1 cell ${id} judges ${reader}'s answers with ${judges.join(', ') || 'no judge'}; the frozen judge plan is ${b.judges[reader]?.join(', ') ?? 'no such reader'}`);
    for (const reader of c.readers) if (!c.judging?.by_reader[reader]) out.push(`rs1 cell ${id} has no judge plan for ${reader}; the frozen judge plan is ${b.judges[reader]?.join(', ') ?? 'no such reader'}`);
  }
  return out;
}

// ─── Rules ───────────────────────────────────────────────────────────

/** The verdict an interval in points earns against margin M, in precedence order. */
export function verdictOf([lower, upper]: readonly [number, number], margin: number): Verdict {
  if (lower > 0) return 'ahead';
  if (upper < 0) return 'behind';
  if (lower >= -margin && upper <= margin) return 'level';
  return 'inconclusive';
}

export interface GateResult { rows: number; mean: number | null; p95: number | null; pass: boolean }

/** The delivered-context gate on one row's per-question cl100k counts: mean and nearest-rank p95 (the ceil(0.95 n)-th smallest), both within [low, high]. */
export function deliveredGate(tokens: readonly number[]): GateResult {
  if (!tokens.length) return { rows: 0, mean: null, p95: null, pass: false };
  const s = [...tokens].sort((a, b) => a - b);
  const mean = s.reduce((x, y) => x + y, 0) / s.length, p95 = s[Math.ceil(0.95 * s.length) - 1];
  const inside = (x: number) => x >= GATE.low && x <= GATE.high;
  return { rows: s.length, mean, p95, pass: inside(mean) && inside(p95) };
}

/** Dollars per correct answer at `reads` reads per stored conversation; null when nothing was answered correctly. */
export function costPerCorrect(c: { ingest_usd_per_conversation: number; read_usd_per_question: number }, accuracy: number, reads: number): number | null {
  return accuracy > 0 ? (c.ingest_usd_per_conversation / reads + c.read_usd_per_question) / accuracy : null;
}

/** The ranking sentence's condition: every family A comparison ahead (a descriptive or not-run one is never ahead). */
export const rankingClaimed = (familyA: ReadonlyArray<{ outcome: Rs1Outcome }>) => familyA.length === FAMILY_SIZE.A && familyA.every(c => c.outcome === 'ahead');

// ─── The analysis ────────────────────────────────────────────────────

/** A reader's value for one question: a score in [0, 1] (a product failure scores 0), or why the reader has none. */
export type ReaderValue = number | string;
export interface Rs1Row {
  cell_id: string; system: string;
  /** Why the row has no measurement (not run, invalid, re-read missing), else null. */
  not_run: string | null;
  /** Question id, then reader, under the counted judges. */
  values: Record<string, Record<string, ReaderValue>>;
  /** The same under SENSITIVITY_JUDGE, or null when the row carries no sensitivity judgments. */
  judge_values: Record<string, Record<string, ReaderValue>> | null;
  /** Delivered cl100k tokens per scheduled question (packed rows). */
  delivered: number[];
}
export interface Rs1CostRow { cell_id: string; reader: string; ingest_usd_per_conversation: number; read_usd_per_question: number }
export interface Rs1Input {
  block: Rs1Block;
  /** The set's scheduled questions without its preregistered exclusions. */
  scheduled: Array<{ question_id: string; conversation: string }>;
  /** Every row the block names, by cell id, re-reads under their own ids. */
  rows: Record<string, Rs1Row>;
  /** The metered cost file's rows (by arm cell id and reader), or null when the receipt has none. */
  cost: Rs1CostRow[] | null;
}

export type Rs1Group = 'counted' | 'particle-1';
export interface Rs1Comparison {
  id: string; family: FamilyId; group: Rs1Group; readers: string[]; subject: string; other: string; system: string;
  level: number; margin: number; scheduled: number; paired: number; conversations: number;
  excluded: Array<{ reason: string; count: number }>;
  estimate: number | null; interval: [number, number] | null; p: number | null; p_holm: number | null;
  gate: { subject: GateResult; other: GateResult } | null;
  outcome: Rs1Outcome; why: string | null; sentence: string;
}
export interface Rs1FamilyResult { id: FamilyId; group: Rs1Group; readers: string[]; level: number; margin: number; comparisons: Rs1Comparison[] }
export interface Rs1Estimate { paired: number; conversations: number; estimate: number | null; interval: [number, number] | null; why: string | null }
export interface Rs1TableRow { cell_id: string; system: string; reader: string; not_run: string | null; scheduled: number; scored: number; accuracy: number | null; cost: Array<{ reads: number; usd: number | null }> | null }
export interface Rs1Analysis {
  size: Rs1Size; set: string; verdict_sha256: string; amendments: number; method: string;
  ranking: { claimed: boolean; sentence: string };
  families: Rs1FamilyResult[];
  gate: Array<{ cell_id: string; system: string; not_run: string | null } & GateResult>;
  judge_sensitivity: { judge: string; conversations: number; comparisons: Array<{ id: string; family: FamilyId; system: string; counted: Rs1Estimate; judge: Rs1Estimate }> };
  /** Graded accuracy and cost per correct answer per row and reader: Opus, particle-1, then Sol. */
  table: Rs1TableRow[];
  /** The verdict lines: the ranking sentence, then one per comparison (family A, B, then the particle-1 family). */
  lines: string[];
}

const r6 = (x: number) => { const v = Number(x.toFixed(6)); return Object.is(v, -0) ? 0 : v; };
const r6n = (x: number | null) => (x === null ? null : r6(x));
const VERDICTS = new Set<Rs1Outcome>(['ahead', 'behind', 'level', 'inconclusive']);
const NO_ROWS = 'has no rows in the receipt';

/** The row holding a reader's answers for an arm: particle-1's packed answers are its re-read of the arm's contexts. */
function rowFor(input: Rs1Input, cellId: string, reader: string): Rs1Row {
  const id = reader === input.block.readers.particle ? input.block.reread[cellId] ?? cellId : cellId;
  return input.rows[id] ?? { cell_id: id, system: input.rows[cellId]?.system ?? id, not_run: NO_ROWS, values: {}, judge_values: null, delivered: [] };
}

/** Pairs two rows' questions under the missing-data rule, as cluster rows in points (subject minus other), counting every question left out by reason. */
function pairUp(input: Rs1Input, subject: string, other: string, readers: readonly string[], judge: boolean, sample: ReadonlySet<string> | null) {
  const sides = [subject, other].map(id => readers.map(reader => ({ reader, row: rowFor(input, id, reader) })));
  const clusters = new Map<string, { n: number; sum: number }>(), excluded = new Map<string, number>();
  let scheduled = 0, paired = 0;
  for (const q of input.scheduled) {
    if (sample && !sample.has(q.conversation)) continue;
    scheduled++;
    let why: string | null = null;
    const means = sides.map(side => side.reduce((s, { reader, row }) => {
      const table = judge ? row.judge_values : row.values;
      const v = table?.[q.question_id]?.[reader] ?? (table ? `missing answer (${reader})` : `no ${SENSITIVITY_JUDGE} judgments`);
      if (typeof v === 'number') return s + v / readers.length;
      why ??= `${row.system}: ${v}`;
      return s;
    }, 0));
    if (why) { excluded.set(why, (excluded.get(why) ?? 0) + 1); continue; }
    paired++;
    const c = clusters.get(q.conversation) ?? { n: 0, sum: 0 };
    c.n++; c.sum += 100 * (means[0] - means[1]);
    clusters.set(q.conversation, c);
  }
  const rows: ClusterRow[] = [...clusters.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, c]) => ({ id, stratum: 'all', ...c }));
  return { rows, scheduled, paired, excluded: [...excluded].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([reason, count]) => ({ reason, count })) };
}

/** Estimate, decisive interval and two-sided p at 0, from one seed, Webb weights and 9,999 draws. */
function bootstrap(rows: ClusterRow[], alpha: number): { estimate: number; interval: [number, number]; p: number } {
  const p = prepare(rows), o = { draws: DRAWS, seed: SEED, weights: WEIGHTS };
  return { estimate: estimate(p).theta, interval: wildRestrictedInterval(p, { ...o, alpha }), p: wildRestrictedP(p, [0], { ...o, alternative: 'two-sided' })[0] };
}

const TOO_FEW = 'fewer than two conversations have a question both rows scored';
const notRunOf = (input: Rs1Input, ids: readonly string[], readers: readonly string[]) => {
  const r = ids.flatMap(id => readers.map(reader => rowFor(input, id, reader))).find(x => x.not_run);
  return r ? `\`${r.system}\` ${r.not_run}` : null;
};
const gateText = (g: GateResult) => (g.mean === null ? 'no measured contexts' : `mean ${Math.round(g.mean).toLocaleString('en-US')}, p95 ${g.p95!.toLocaleString('en-US')}`);

function compare(input: Rs1Input, f: Rs1Family, group: Rs1Group, other: string): Rs1Comparison {
  const b = input.block, readers = group === 'counted' ? b.readers.counted : [b.readers.particle];
  const sys = (id: string) => input.rows[id]?.system ?? id;
  const base: Rs1Comparison = {
    id: `${group === 'counted' ? '' : 'particle-1 '}${f.id}: ${other}`, family: f.id, group, readers, subject: f.subject, other, system: sys(other),
    level: f.interval_level, margin: f.margin_points, scheduled: input.scheduled.length, paired: 0, conversations: 0, excluded: [],
    estimate: null, interval: null, p: null, p_holm: null, gate: null, outcome: 'not-run', why: null, sentence: '',
  };
  const notRun = notRunOf(input, [f.subject, other], readers);
  if (notRun) return { ...base, why: notRun };
  const pairs = pairUp(input, f.subject, other, readers, false, null);
  const counts = { scheduled: pairs.scheduled, paired: pairs.paired, conversations: pairs.rows.length, excluded: pairs.excluded };
  if (pairs.rows.length < 2) return { ...base, ...counts, why: TOO_FEW };
  const t = bootstrap(pairs.rows, COMPARISON_ALPHA[f.id]);
  const gate = f.id === 'A' ? { subject: deliveredGate(input.rows[f.subject]?.delivered ?? []), other: deliveredGate(input.rows[other]?.delivered ?? []) } : null;
  const missed = gate ? ([[f.subject, gate.subject], [other, gate.other]] as const).filter(([, g]) => !g.pass).map(([id, g]) => `\`${sys(id)}\` ${gateText(g)}`) : [];
  const why = missed.length ? `its delivered context is outside ${GATE.low.toLocaleString('en-US')} to ${GATE.high.toLocaleString('en-US')} cl100k tokens (${missed.join('; ')})` : null;
  return { ...base, ...counts, estimate: t.estimate, interval: t.interval, p: t.p, gate, outcome: why ? 'descriptive' : verdictOf(t.interval, f.margin_points), why };
}

const signed = (x: number) => `${x < 0 ? '-' : '+'}${Math.abs(x).toFixed(1)}`;
const levelText = (level: number) => `${Number((100 * level).toFixed(2))}%`;
const SUBJECT: Record<FamilyId, string> = { A: "gbrain's 8,000-token read (arm P)", B: "gbrain's whole-system think loop" };

function sentenceOf(c: Rs1Comparison): string {
  const who = `${c.group === 'particle-1' ? 'With particle-1 as the only reader (reported apart, never part of the ranking), ' : ''}${SUBJECT[c.family]}`, sys = `\`${c.system}\``;
  if (c.outcome === 'not-run') return `${who} versus ${sys} did not run: ${c.why}. It keeps its place in family ${c.family} and has no verdict.`;
  const nums = `${signed(c.estimate!)} points (${levelText(c.level)} interval ${signed(c.interval![0])} to ${signed(c.interval![1])}; ${c.paired} of ${c.scheduled} questions paired over ${c.conversations} conversations)`;
  if (c.outcome === 'ahead') return `${who} answered more questions correctly than ${sys}: ${nums}.`;
  if (c.outcome === 'behind') return `${who} answered fewer questions correctly than ${sys}: ${nums}.`;
  if (c.outcome === 'level') return `${who} and ${sys} are level: ${nums}, inside ±${c.margin} points.`;
  if (c.outcome === 'inconclusive') return `${who} versus ${sys} is inconclusive: ${nums}; the interval neither excludes zero nor stays inside ±${c.margin} points.`;
  return `${who} versus ${sys} is descriptive only, because ${c.why}: ${nums}.`;
}

function sensitivityEstimate(input: Rs1Input, f: Rs1Family, other: string, judge: boolean, sample: ReadonlySet<string>): Rs1Estimate {
  const none = { paired: 0, conversations: 0, estimate: null, interval: null };
  const notRun = notRunOf(input, [f.subject, other], input.block.readers.counted);
  if (notRun) return { ...none, why: notRun };
  const pairs = pairUp(input, f.subject, other, input.block.readers.counted, judge, sample);
  if (pairs.rows.length < 2) return { ...none, paired: pairs.paired, conversations: pairs.rows.length, why: pairs.excluded[0]?.reason ?? TOO_FEW };
  const t = bootstrap(pairs.rows, COMPARISON_ALPHA[f.id]);
  return { paired: pairs.paired, conversations: pairs.rows.length, estimate: r6(t.estimate), interval: [r6(t.interval[0]), r6(t.interval[1])], why: null };
}

const roundGate = (g: GateResult): GateResult => ({ rows: g.rows, mean: r6n(g.mean), p95: g.p95, pass: g.pass });

/** The whole analysis: families A, B and particle-1's, the ranking sentence, the gate, the judge-sensitivity block and the first table. */
export function analyze(input: Rs1Input): Rs1Analysis {
  const b = input.block;
  const families: Rs1FamilyResult[] = (['counted', 'particle-1'] as const).flatMap(group => b.families.map(f => {
    const cs = f.comparators.map(o => compare(input, f, group, o));
    const holm = holmAdjusted(cs.map(c => (VERDICTS.has(c.outcome) ? c.p! : 1)));
    const comparisons = cs.map((c, i) => {
      const done = { ...c, p_holm: VERDICTS.has(c.outcome) ? holm[i] : null };
      return { ...done, sentence: sentenceOf(done), estimate: r6n(c.estimate), interval: c.interval && [r6(c.interval[0]), r6(c.interval[1])] as [number, number], p: r6n(c.p), p_holm: r6n(done.p_holm),
        gate: c.gate && { subject: roundGate(c.gate.subject), other: roundGate(c.gate.other) } };
    });
    return { id: f.id, group, readers: group === 'counted' ? b.readers.counted : [b.readers.particle], level: f.interval_level, margin: f.margin_points, comparisons };
  }));
  const familyA = families.find(f => f.group === 'counted' && f.id === 'A')!.comparisons;
  const claimed = rankingClaimed(familyA);
  const servers = familyA.map(c => `\`${c.system}\``);
  const listed = `${servers.slice(0, -1).join(', ')} and ${servers.at(-1)}`;
  const ranking = claimed
    ? `On ${b.set}, gbrain ranks first among these memory servers: its 8,000-token read answered more questions correctly than ${listed}, each with its ${levelText(b.families[0].interval_level)} interval above zero.`
    : `On ${b.set}, no ranking claim is made: it needs gbrain's 8,000-token read ahead of all three memory servers (${listed}), and it is ahead of ${familyA.filter(c => c.outcome === 'ahead').length} (${familyA.filter(c => c.outcome !== 'ahead').map(c => `\`${c.system}\`: ${c.outcome}`).join('; ')}).`;
  const packed = [b.families[0].subject, ...b.families[0].comparators, ...b.descriptive];
  const gate = packed.map(id => ({ cell_id: id, system: input.rows[id]?.system ?? id, not_run: input.rows[id] ? input.rows[id].not_run : NO_ROWS, ...roundGate(deliveredGate(input.rows[id]?.delivered ?? [])) }));
  const sample = new Set(b.sensitivity.conversations);
  const judge_sensitivity = {
    judge: b.sensitivity.judge, conversations: sample.size,
    comparisons: b.families.flatMap(f => f.comparators.map(o => ({ id: `${f.id}: ${o}`, family: f.id, system: input.rows[o]?.system ?? o, counted: sensitivityEstimate(input, f, o, false, sample), judge: sensitivityEstimate(input, f, o, true, sample) }))),
  };
  const order = [...b.families.flatMap(f => [f.subject, ...f.comparators]), ...b.descriptive];
  const readers = [b.readers.counted[0], b.readers.particle, ...b.readers.counted.slice(1)];
  const table = readers.flatMap(reader => order.map((id): Rs1TableRow => {
    const row = rowFor(input, id, reader);
    const xs = row.not_run ? [] : input.scheduled.map(q => row.values[q.question_id]?.[reader]).filter((v): v is number => typeof v === 'number');
    const accuracy = xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
    const c = input.cost?.find(x => x.cell_id === id && x.reader === reader);
    return {
      cell_id: id, system: input.rows[id]?.system ?? id, reader, not_run: row.not_run, scheduled: input.scheduled.length, scored: xs.length, accuracy: r6n(accuracy),
      cost: c && accuracy !== null ? b.cost.reads.map(reads => ({ reads, usd: r6n(costPerCorrect(c, accuracy, reads)) })) : null,
    };
  }));
  return {
    size: b.size, set: b.set, verdict_sha256: analysisSha256(b), amendments: b.amendments.length,
    method: `restricted wild cluster bootstrap-t, Webb weights, ${DRAWS.toLocaleString('en-US')} draws, seed ${SEED}; Bonferroni intervals, ${levelText(INTERVAL_LEVEL.A)} for each family A comparison and ${levelText(INTERVAL_LEVEL.B)} for family B; Holm p-values secondary; margins ${b.families.map(f => `${f.id} ±${f.margin_points}`).join(', ')} points at size ${b.size}`,
    ranking: { claimed, sentence: ranking }, families, gate, judge_sensitivity, table,
    lines: [ranking, ...families.flatMap(f => f.comparisons.map(c => c.sentence))],
  };
}
