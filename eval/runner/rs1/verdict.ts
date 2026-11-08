/**
 * RS1's analysis (docs/benchmarks/2026-11-08-rs1-narrow-preregistration.md, "Estimand and verdict rules" and "Internal
 * pilot"). The rule itself is eval/runner/rs1/iut.ts; this file reads the receipts, checks them and reports.
 *
 *   bun eval/runner/rs1/verdict.ts verdict --receipts <out dir>... [--manifest <filled rs1-manifest.json>] [--set RS1|RS1-dev2] [--out <dir>]
 *   bun eval/runner/rs1/verdict.ts pilot   --receipts <out dir>... [--manifest <filled rs1-manifest.json>] [--out <dir>]
 *
 * Each --receipts directory is a cell or re-read output (cell.ts --out, reread-cell.ts --out): every
 * cells/<cell id>/receipt.json under it is read, with the cell's run-config.json, rows, answers and judgments, and each
 * re-read's answers and judgments.
 *
 *   Receipts  for set RS1, a cell whose dataset revision is unfilled, whose RS1 manifest SHA-256 is neither the filled
 *             manifest's nor one of its earlier_fills, or whose loaded files' SHA-256 differ from the filled manifest is
 *             refused, and so is a conversation that two receipts of one cell both hold. Every system row and the floor
 *             needs particle-1's re-read (reread-cell.ts, under rereadCellId) covering each of its receipts' run
 *             configs; a missing re-read refuses the run.
 *   Values    readers claude-opus-5-5 and gpt-6.1-sol from the cell and particle-1 from its re-read, joined by question id,
 *             replicate 0. A product failure scores 0 under both views; a harness failure, a missing answer or a
 *             missing judgment is a drop, by reason and side. The bridge view is the canonical instrument's judgment,
 *             the frontier view the reader's frontier judge (<instrument>@<judge>).
 *   Gate      a system row passes the delivered-context gate when its mean fill rate (rows.ndjson fill_rate) is at
 *             least 0.90; a row that fails makes every comparison it enters descriptive (no verdict).
 *   Reported  iut.ts's decision, the worst-case sensitivity and a flag when it disagrees, the restricted wild cluster
 *             bootstrap-t on the question-weighted estimate (Webb weights, 9,999 draws, one-sided 95% lower bound),
 *             per-reader and per-ability means, the floor, each row's fill rate, drops by reason and side, and the first
 *             table (cost per correct answer, claude-opus-5-5 and particle-1 first, then gpt-6.1-sol).
 *   Pilot     wave A only (the first 20 kept conversations): the four SDs of the per-conversation differences and their
 *             4 x 4 correlation, no means; then power.ts's N_required and N_final = min(33, max(20, N_required)). Above
 *             33 it exits 3 with RS1_PILOT_OVER_CAP, the margin reachable at 33 and the price of N_required.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { HARNESS_FAILURES, PRODUCT_FAILURES, type Outcome } from '../memory-qa/outcomes.ts';
import { readRecords, type AnswerRecord, type JudgmentRecord } from '../memory-qa/records.ts';
import { RS1_MANIFEST, rs1Kept, type Rs1Manifest } from '../memory-qa/corpus.ts';
import { frontierInstrumentId } from '../q1/cell.ts';
import { frontierJudgeOf } from '../q1/cells/definitions.ts';
import { loadRS1Manifest, OPUS, PARTICLE, RS1_WAVE_A, SOL } from '../q1/cells/rs1.ts';
import { rereadCellId } from '../q1/reread-cell.ts';
import { wildTest, type ClusterRow } from '../stats/wild-cluster.ts';
import { COMPARISONS, conversationDifferences, decide, dropValidity, inCommonSet, questionScores, RS1_MARGIN, SERVERS, VIEWS, worstCase,
  type ComparisonKey, type Decision, type Drop, type QuestionInput, type ReaderValue, type Row, type Scored, type View } from './iut.ts';
import { N_CAP, pilotSize } from './power.ts';
import { priceAt } from './pricing.ts';

export const READERS = [OPUS, SOL, PARTICLE];
/** The first table's reader order: the primary models first (AGENTS.md), then gpt-6.1-sol. */
export const TABLE_READERS = [OPUS, PARTICLE, SOL];
export const FILL_GATE = 0.9;
export const DRAWS = 9999;
export const SEED = 20261108;
export const ROLES: Record<string, Row | 'floor'> = { 'gbrain-defaults': 'gbrain', 'ext-memory-bank': 'memory-bank', 'ext-extract-first': 'extract-first', 'baseline-none': 'floor' };

export class VerdictError extends Error {}
const refuse = (m: string): never => { throw new VerdictError(m); };
const sha256 = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex');
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const r4n = (x: number | null) => (x === null ? null : r4(x));
const meanOf = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// ─── Analysis on loaded values ───────────────────────────────────────

export interface FloorQuestion { id: string; conversation: string; values: Record<string, number | { drop: string }> }
export interface CostRow { row: Row | 'floor'; reader: string; usd_per_question: number | null }
export interface VerdictInput {
  set: string;
  /** Every planned question with each system row's reader values. */
  questions: QuestionInput[];
  /** The floor row's bridge-view values per reader. */
  floor: FloorQuestion[];
  /** Each system row's mean fill rate (null when no row recorded one). */
  fill: Record<Row, number | null>;
  costs: CostRow[];
}

const ROWS: Row[] = ['gbrain', ...SERVERS];

/** The four tests' one-sided 95% bootstrap lower bounds (restricted wild cluster bootstrap-t, question-weighted). */
function bootstrap(scored: readonly Scored[]) {
  return COMPARISONS.map(key => {
    const [server, view] = key.split('/') as [Row, View];
    const byConv = new Map<string, { n: number; sum: number }>();
    for (const q of scored.filter(inCommonSet)) {
      const c = byConv.get(q.conversation) ?? { n: 0, sum: 0 };
      c.n++; c.sum += q.scores.gbrain![view] - q.scores[server]![view];
      byConv.set(q.conversation, c);
    }
    const rows: ClusterRow[] = [...byConv].map(([id, c]) => ({ id, stratum: 'all', n: c.n, sum: c.sum }));
    if (rows.length < 2) return { key, estimate: null, lower: null, agrees: null };
    const t = wildTest(rows, { draws: DRAWS, seed: SEED, weights: 'webb', alpha: 0.1 });
    return { key, estimate: r4(t.theta), lower: r4(t.ci95[0]), agrees: null as boolean | null };
  });
}

export function analyze(input: VerdictInput) {
  const scoredAll = input.questions.map(q => questionScores(q, READERS));
  const scored = scoredAll.map(s => s.scored);
  const drops: Drop[] = scoredAll.flatMap(s => s.drops);
  const validity = dropValidity(scored);
  const gate = ROWS.map(row => ({ row, fill_rate: r4n(input.fill[row]), pass: input.fill[row] !== null && input.fill[row]! >= FILL_GATE }));
  const invalid: Partial<Record<ComparisonKey, string[]>> = {};
  for (const key of COMPARISONS) {
    const server = key.split('/')[0] as Row;
    const reasons = [...(validity.invalid[key] ?? []), ...gate.filter(g => !g.pass && (g.row === 'gbrain' || g.row === server)).map(g => `descriptive: ${g.row} failed the delivered-context gate (mean fill rate ${g.fill_rate ?? 'not recorded'}, needs ${FILL_GATE})`)];
    if (reasons.length) invalid[key] = reasons;
  }
  const { conversations, diffs } = conversationDifferences(scored);
  if (conversations.length < 2) refuse(`fewer than two conversations have a common question (${conversations.length})`);
  const decision = decide(diffs, { invalid });
  const worst = decide(conversationDifferences(scored, worstCase).diffs, { invalid });
  const boot = bootstrap(scored).map(b => ({ ...b, agrees: b.lower === null ? null : (b.lower > -RS1_MARGIN) === decision.tests.find(t => t.key === b.key)!.pass }));
  const common = scored.filter(inCommonSet);
  const perReader = READERS.flatMap(reader => ROWS.flatMap(row => VIEWS.map(view => {
    const xs = input.questions.filter(q => common.some(c => c.id === q.id)).map(q => q.rows[row][reader]).filter((v): v is { frontier: number; bridge: number } => !!v && !('drop' in v)).map(v => 100 * v[view]);
    return { reader, row, view, questions: xs.length, mean: r4n(meanOf(xs)) };
  })));
  const abilities = [...new Set(common.map(q => q.id.split(':')[1] ?? 'unknown'))].sort();
  const perAbility = abilities.flatMap(ability => ROWS.flatMap(row => VIEWS.map(view => {
    const xs = common.filter(q => (q.id.split(':')[1] ?? 'unknown') === ability).map(q => q.scores[row]![view]);
    return { ability, row, view, questions: xs.length, mean: r4n(meanOf(xs)) };
  })));
  const floorScores = input.floor.map(f => { const vs = READERS.map(r => f.values[r]); return vs.every(v => typeof v === 'number') ? 100 * (vs as number[]).reduce((a, b) => a + b, 0) / vs.length : null; }).filter((x): x is number => x !== null);
  const floorMean = meanOf(floorScores);
  const rowBridge = (row: Row) => meanOf(scored.filter(s => s.scores[row]).map(s => s.scores[row]!.bridge));
  const floor = { questions: floorScores.length, mean_bridge: r4n(floorMean), below_every_system_row: floorMean !== null && ROWS.every(row => { const m = rowBridge(row); return m !== null && floorMean < m; }) };
  const dropCounts: Record<string, number> = {};
  for (const d of drops) dropCounts[`${d.side}|${d.reason}`] = (dropCounts[`${d.side}|${d.reason}`] ?? 0) + 1;
  const accuracy = (row: Row | 'floor', reader: string, view: View): number | null => {
    if (row === 'floor') return view === 'bridge' ? meanOf(input.floor.map(f => f.values[reader]).filter((v): v is number => typeof v === 'number').map(v => 100 * v)) : null;
    return meanOf(input.questions.map(q => q.rows[row][reader]).filter((v): v is { frontier: number; bridge: number } => !!v && !('drop' in v)).map(v => 100 * v[view]));
  };
  const table = TABLE_READERS.flatMap(reader => [...ROWS, 'floor' as const].map(row => {
    const usd = input.costs.find(c => c.row === row && c.reader === reader)?.usd_per_question ?? null;
    const view = (v: View) => { const a = accuracy(row, reader, v); return { accuracy: r4n(a), usd_per_correct: usd === null || !a ? null : r4(usd / (a / 100)) }; };
    return { reader, row, usd_per_question: r4n(usd), frontier: view('frontier'), bridge: view('bridge') };
  }));
  const disagrees = decision.verdict !== 'invalid' && worst.verdict !== decision.verdict;
  return {
    schema: 'gbrain-evals/rs1-verdict/v1', set: input.set, margin: RS1_MARGIN, readers: READERS, conversations: conversations.length,
    planned_questions: validity.planned, common_questions: validity.common, drop_share: r4(validity.share),
    verdict: decision.verdict, tests: roundTests(decision), secondaries: decision.secondaries.map(s => ({ id: s.id, status: s.status })),
    worst_case: { verdict: worst.verdict, tests: roundTests(worst), disagrees },
    bootstrap: { method: `restricted wild cluster bootstrap-t, Webb weights, ${DRAWS} draws, seed ${SEED}, one-sided 95% lower bound`, tests: boot },
    gate, drops: dropCounts, per_reader: perReader, per_ability: perAbility, floor, table,
  };
}
const roundTests = (d: Decision) => d.tests.map(t => ({ key: t.key, n: t.n, estimate: r4(t.mean), sd: r4(t.sd), lower: r4(t.lower), pass: t.pass, valid: t.valid, invalid_reasons: t.invalid_reasons }));
export type Analysis = ReturnType<typeof analyze>;

/** The pilot's output: the four SDs of the per-conversation differences and their correlation, no means. */
export function pilotStats(input: VerdictInput) {
  const scored = input.questions.map(q => questionScores(q, READERS).scored);
  const { conversations, diffs } = conversationDifferences(scored);
  const n = conversations.length;
  if (n < 3) refuse(`the pilot needs at least three conversations with common questions, got ${n}`);
  const centred = COMPARISONS.map(k => { const xs = diffs[k]; const m = xs.reduce((a, b) => a + b, 0) / n; return xs.map(x => x - m); });
  const cov = (i: number, j: number) => centred[i].reduce((s, x, c) => s + x * centred[j][c], 0) / (n - 1);
  const sds = COMPARISONS.map((_, i) => Math.sqrt(cov(i, i)));
  if (sds.some(sd => !(sd > 0))) refuse(`a test's per-conversation differences do not vary (SDs ${sds.map(sd => sd.toFixed(2)).join(', ')}), so no correlation can be estimated`);
  const corr = COMPARISONS.map((_, i) => COMPARISONS.map((_, j) => cov(i, j) / (sds[i] * sds[j])));
  return { conversations: n, sds, corr };
}

// ─── Receipts ────────────────────────────────────────────────────────

interface CellFiles { dir: string; root: string; receipt: Record<string, any>; config: Record<string, any> | null }

function findReceipts(dirs: readonly string[]): CellFiles[] {
  return dirs.flatMap(root => {
    const cells = join(root, 'cells');
    if (!existsSync(cells)) refuse(`${root} has no cells/ directory`);
    return readdirSync(cells).sort().filter(d => existsSync(join(cells, d, 'receipt.json'))).map(d => {
      const dir = join(cells, d);
      const config = existsSync(join(dir, 'run-config.json')) ? JSON.parse(readFileSync(join(dir, 'run-config.json'), 'utf8')) : null;
      return { dir, root, receipt: JSON.parse(readFileSync(join(dir, 'receipt.json'), 'utf8')), config };
    });
  });
}

/** F10: a set-RS1 receipt must come from the filled manifest (or one of its earlier fills) and load only its pinned bytes. */
export function receiptManifestProblems(config: Record<string, any> | null, manifest: Rs1Manifest, manifestSha: string): string[] {
  const ds = config?.dataset;
  if (!ds) return ['its run-config.json has no dataset'];
  if (ds.revision === 'unfilled') return ['its dataset revision is unfilled'];
  const [head, ...files] = (ds.files ?? []) as Array<{ path: string; sha256: string }>;
  if (head?.path !== RS1_MANIFEST) return [`its dataset is not the RS1 manifest (${head?.path ?? 'no files'})`];
  const problems: string[] = [];
  if (![manifestSha, ...(manifest.earlier_fills ?? [])].includes(head.sha256)) problems.push(`its RS1 manifest SHA-256 ${head.sha256.slice(0, 12)} is not the filled manifest's (${manifestSha.slice(0, 12)}) or an earlier fill's`);
  for (const f of files) {
    const pinned = manifest.files.find(x => x.path === f.path);
    if (!pinned) problems.push(`it loaded ${f.path}, which the filled manifest does not pin`);
    else if (pinned.sha256 !== f.sha256) problems.push(`its ${f.path} has SHA-256 ${f.sha256.slice(0, 12)}, the manifest pins ${pinned.sha256.slice(0, 12)}`);
  }
  return problems;
}

export interface LoadOptions { set: 'RS1' | 'RS1-dev2'; manifestPath: string; waveA?: boolean }

/** Read and check every receipt, then build the analysis input. */
export function loadInput(dirs: readonly string[], o: LoadOptions): VerdictInput {
  const cells = loadRS1Manifest();
  const defs = (o.set === 'RS1' ? cells.cells : cells.smoke_cells).filter(c => c.arms[0].set === o.set);
  let manifest: Rs1Manifest | null = null, manifestSha = '', wave: Set<string> | null = null;
  if (o.set === 'RS1') {
    const bytes = readFileSync(o.manifestPath);
    manifest = JSON.parse(bytes.toString('utf8')) as Rs1Manifest;
    if (manifest.status !== 'filled') refuse(`the RS1 manifest ${o.manifestPath} is unfilled; verdict.ts reads receipts only against the filled manifest`);
    manifestSha = sha256(bytes);
    if (o.waveA) wave = new Set(rs1Kept(manifest).kept.slice(0, RS1_WAVE_A));
  } else if (o.waveA) refuse('the pilot reads set RS1 only');
  const found = findReceipts(dirs);
  const values = new Map<Row | 'floor', Map<string, Record<string, ReaderValue>>>();
  const planned = new Map<string, string>();
  const fill: Record<Row, number | null> = { gbrain: null, 'memory-bank': null, 'extract-first': null };
  const costs: CostRow[] = [];
  for (const def of defs) {
    const role = ROLES[def.system] ?? refuse(`cell ${def.id} has no RS1 role (system ${def.system})`);
    const armCell = def.arms[0].cell_id;
    const units = found.filter(f => f.receipt.cell_id === armCell);
    if (!units.length) refuse(`no receipt for ${armCell} under the given directories`);
    const held = new Map<string, string>();
    const answers: AnswerRecord[] = [], judgments: JudgmentRecord[] = [], fills: number[] = [];
    let shared = 0, sharedKnown = true;
    const readerUsd = new Map<string, number>();
    let questionsInRow = 0;
    for (const u of units) {
      if (u.receipt.run_status === 'invalid') refuse(`${u.dir} is invalid: ${(u.receipt.invalid_reasons ?? []).join('; ')}`);
      if (manifest) { const p = receiptManifestProblems(u.config, manifest, manifestSha); if (p.length) refuse(`${u.dir}: ${p.join('; ')}`); }
      const rows = readRecordsLoose(join(u.dir, 'rows.ndjson')).filter(r => !wave || wave.has(String(r.conversation)));
      for (const conv of new Set(rows.map(r => String(r.conversation)))) { if (held.has(conv)) refuse(`${armCell}: conversation ${conv} is in both ${held.get(conv)} and ${u.dir}`); held.set(conv, u.dir); }
      for (const r of rows) { if (role !== 'floor') planned.set(String(r.id), String(r.conversation)); if (typeof r.fill_rate === 'number') fills.push(r.fill_rate); }
      questionsInRow += rows.length;
      const ans = readRecords(join(u.dir, 'answers.ndjson'), 'answer').filter(a => !wave || wave.has(a.conversation));
      answers.push(...ans);
      judgments.push(...readRecords(join(u.dir, 'judgments.ndjson'), 'judgment'));
      const spend = u.receipt.spend?.usd as Record<string, number> | undefined;
      if (spend) shared += (spend.ingest ?? 0) + (spend.retrieval ?? 0) + (spend.background_tail ?? 0); else sharedKnown = false;
      const meters = join(u.root, 'runs', String(u.receipt.run_cell), 'meters.ndjson');
      if (existsSync(meters)) {
        const byKey = new Map(ans.map(a => [`read:${a.answer_id.slice(0, 16)}`, a.reader]));
        for (const m of readRecordsLoose(meters)) { const reader = m.phase === 'reader' ? byKey.get(String(m.key)) : undefined; if (reader) readerUsd.set(reader, (readerUsd.get(reader) ?? 0) + Number(m.usd)); }
      }
    }
    const rereadId = rereadCellId(armCell, PARTICLE);
    const rereads = found.filter(f => f.receipt.cell_id === rereadId);
    const configs = new Set(units.map(u => String(u.receipt.config_sha256)));
    const covered = new Set(rereads.flatMap(r => (r.receipt.source?.config_sha256s ?? []) as string[]));
    const uncovered = [...configs].filter(c => !covered.has(c));
    if (!rereads.length || uncovered.length) refuse(`missing particle-1 re-read: ${armCell} has ${uncovered.length || configs.size} receipt(s) no ${rereadId} covers`);
    for (const r of rereads) {
      answers.push(...readRecords(join(r.dir, 'answers.ndjson'), 'answer').filter(a => !wave || wave.has(a.conversation)));
      judgments.push(...readRecords(join(r.dir, 'judgments.ndjson'), 'judgment'));
      const usd = r.receipt.spend?.reader_usd;
      if (typeof usd === 'number') readerUsd.set(PARTICLE, (readerUsd.get(PARTICLE) ?? 0) + usd);
    }
    const instrument = String(units[0].receipt.instrument.id);
    const score = new Map(judgments.filter(j => j.judge_replicate === 0).map(j => [`${j.answer_id}|${j.instrument_id}`, j.score]));
    const byQuestion = new Map<string, Record<string, ReaderValue>>();
    for (const a of answers.filter(x => x.replicate === 0 && READERS.includes(x.reader))) {
      const v = readerValue(a, score, instrument, role === 'floor');
      byQuestion.set(a.question_id, { ...(byQuestion.get(a.question_id) ?? {}), [a.reader]: v });
    }
    values.set(role, byQuestion);
    if (role !== 'floor') fill[role] = meanOf(fills);
    for (const reader of READERS) {
      const n = answers.filter(a => a.reader === reader && a.replicate === 0).length;
      costs.push({ row: role, reader, usd_per_question: !sharedKnown || !readerUsd.has(reader) || !n || !questionsInRow ? null : shared / questionsInRow + readerUsd.get(reader)! / n });
    }
  }
  const missing = (reader: string): ReaderValue => ({ drop: reader === PARTICLE ? 'reread_answer_missing' : 'answer_missing' });
  const questions: QuestionInput[] = [...planned].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, conversation]) => ({
    id, conversation, rows: Object.fromEntries(ROWS.map(row => [row, Object.fromEntries(READERS.map(r => [r, values.get(row)?.get(id)?.[r] ?? missing(r)]))])) as QuestionInput['rows'],
  }));
  const floorValues = values.get('floor') ?? new Map();
  const floor: FloorQuestion[] = questions.map(q => ({ id: q.id, conversation: q.conversation, values: Object.fromEntries(READERS.map(r => {
    const v = floorValues.get(q.id)?.[r];
    return [r, v === undefined ? missing(r) : 'drop' in v ? v : v.bridge];
  })) }));
  if (wave) { const seen = new Set(questions.map(q => q.conversation)); const absent = [...wave].filter(c => !seen.has(c)); if (absent.length) refuse(`the pilot needs every wave A conversation; ${absent.join(', ')} has no rows`); }
  return { set: o.set, questions, floor, fill, costs };
}

function readRecordsLoose(path: string): Array<Record<string, any>> {
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l)) : [];
}

/** One answer's value: product failures 0, harness failures and missing judgments dropped by reason. */
export function readerValue(a: Pick<AnswerRecord, 'answer_id' | 'reader' | 'outcome'>, score: ReadonlyMap<string, number | null>, instrument: string, bridgeOnly = false): ReaderValue {
  const outcome = a.outcome as Outcome;
  if (PRODUCT_FAILURES.has(outcome)) return { frontier: 0, bridge: 0 };
  if (HARNESS_FAILURES.has(outcome) || (outcome !== 'scored' && outcome !== 'ingest_degraded')) return { drop: outcome };
  const bridge = score.get(`${a.answer_id}|${instrument}`);
  if (typeof bridge !== 'number') return { drop: 'judgment_missing:bridge' };
  if (bridgeOnly) return { frontier: bridge, bridge };
  const frontier = score.get(`${a.answer_id}|${frontierInstrumentId(instrument, frontierJudgeOf(a.reader))}`);
  if (typeof frontier !== 'number') return { drop: 'judgment_missing:frontier' };
  return { frontier, bridge };
}

// ─── Reports ─────────────────────────────────────────────────────────

const fmt = (x: number | null, d = 2) => (x === null ? 'n/a' : x.toFixed(d));
export function markdown(a: Analysis): string {
  const lines = [`# RS1 verdict (set ${a.set})`, ''];
  if (a.worst_case.disagrees) lines.push(`**The worst-case sensitivity disagrees with the verdict:** ${a.worst_case.verdict} against ${a.verdict}.`, '');
  lines.push(`Verdict: **${a.verdict}** (all four one-sided 95% t lower bounds above -${a.margin}). ${a.conversations} conversations, ${a.common_questions} of ${a.planned_questions} planned questions in the common set.`, '');
  lines.push('| Test | n | Estimate | SD | Lower bound | Pass | Bootstrap lower | Worst-case lower | Validity |', '|---|---:|---:|---:|---:|---|---:|---:|---|');
  for (const t of a.tests) {
    const b = a.bootstrap.tests.find(x => x.key === t.key)!, w = a.worst_case.tests.find(x => x.key === t.key)!;
    lines.push(`| gbrain minus ${t.key.replace('/', ', ')} | ${t.n} | ${fmt(t.estimate)} | ${fmt(t.sd)} | ${fmt(t.lower)} | ${t.pass ? 'yes' : 'no'} | ${fmt(b.lower)} | ${fmt(w.lower)} | ${t.valid ? 'valid' : t.invalid_reasons.join('; ')} |`);
  }
  lines.push('', `Secondaries: ${a.secondaries.length ? a.secondaries.map(s => `${s.id} ${s.status}`).join(', ') : 'not tested (the primary did not pass)'}.`, '');
  lines.push('| Reader | Row | Cost per question | Accuracy, frontier | Cost per correct, frontier | Accuracy, bridge | Cost per correct, bridge |', '|---|---|---:|---:|---:|---:|---:|');
  for (const t of a.table) lines.push(`| ${t.reader} | ${t.row} | ${fmt(t.usd_per_question, 4)} | ${fmt(t.frontier.accuracy)} | ${fmt(t.frontier.usd_per_correct, 4)} | ${fmt(t.bridge.accuracy)} | ${fmt(t.bridge.usd_per_correct, 4)} |`);
  lines.push('', '| Row | Mean fill rate | Gate |', '|---|---:|---|', ...a.gate.map(g => `| ${g.row} | ${fmt(g.fill_rate, 3)} | ${g.pass ? 'pass' : 'fail'} |`));
  lines.push('', `Floor (bridge view): ${fmt(a.floor.mean_bridge)} over ${a.floor.questions} questions; below every system row: ${a.floor.below_every_system_row ? 'yes' : 'no'}.`, '');
  lines.push('| Side and reason | Drops |', '|---|---:|', ...Object.entries(a.drops).sort().map(([k, n]) => `| ${k.replace('|', ', ')} | ${n} |`));
  return lines.join('\n') + '\n';
}

function main(argv: string[]): number {
  const [mode, ...args] = argv;
  if (mode !== 'verdict' && mode !== 'pilot') { process.stderr.write('usage: bun eval/runner/rs1/verdict.ts verdict|pilot --receipts <dir>... [--manifest <file>] [--set RS1|RS1-dev2] [--out <dir>]\n'); return 2; }
  const receipts: string[] = [];
  let manifestPath = resolve(import.meta.dir, '../../..', RS1_MANIFEST), set: 'RS1' | 'RS1-dev2' = 'RS1', out: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--receipts') { while (args[i + 1] && !args[i + 1].startsWith('--')) receipts.push(resolve(args[++i])); }
    else if (args[i] === '--manifest') manifestPath = resolve(args[++i]);
    else if (args[i] === '--set') { const s = args[++i]; if (s !== 'RS1' && s !== 'RS1-dev2') { process.stderr.write(`--set takes RS1 or RS1-dev2, not ${s}\n`); return 2; } set = s; }
    else if (args[i] === '--out') out = resolve(args[++i]);
    else { process.stderr.write(`unknown argument ${args[i]}\n`); return 2; }
  }
  if (!receipts.length) { process.stderr.write('--receipts needs at least one directory\n'); return 2; }
  const write = (name: string, json: unknown, md: string) => { if (out) { mkdirSync(out, { recursive: true }); writeFileSync(join(out, `${name}.json`), JSON.stringify(json, null, 2) + '\n'); writeFileSync(join(out, `${name}.md`), md); } process.stdout.write(md); };
  try {
    if (mode === 'verdict') { const a = analyze(loadInput(receipts, { set, manifestPath })); write('verdict', a, markdown(a)); return 0; }
    const stats = pilotStats(loadInput(receipts, { set: 'RS1', manifestPath, waveA: true }));
    const size = pilotSize(stats.sds, stats.corr);
    const price = size.n_required === null ? null : priceAt(size.n_required);
    const report = { schema: 'gbrain-evals/rs1-pilot/v1', conversations: stats.conversations, comparisons: COMPARISONS, sds: stats.sds.map(r4), corr: stats.corr.map(row => row.map(r4)), ...size, price_at_required: price };
    const md = [`# RS1 pilot (wave A, ${stats.conversations} conversations)`, '', '| Test | SD |', '|---|---:|', ...COMPARISONS.map((k, i) => `| ${k} | ${fmt(stats.sds[i])} |`),
      '', `N_required: ${size.n_required ?? 'above 400'}; N_final: ${size.n_final ?? 'none (over the cap)'}.`, ''].join('\n');
    write('pilot', report, md);
    if (size.over_cap) { process.stderr.write(`RS1_PILOT_OVER_CAP: N_required ${size.n_required ?? '> 400'} is above ${N_CAP}; the margin reachable at ${N_CAP} is ${size.margin_at_cap} points; N_required would cost ${price ? `$${price.projection} (projection), $${price.expected_all_in} expected all-in` : 'more than the model prices'}. GBEV-3 decides.\n`); return 3; }
    return 0;
  } catch (e) {
    if (e instanceof VerdictError) { process.stderr.write(`verdict.ts refused: ${e.message}\n`); return 1; }
    throw e;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
export { main as verdictMain };
