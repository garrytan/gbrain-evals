/**
 * RS1's analysis (docs/benchmarks/2026-11-08-rs1-narrow-preregistration.md, "Estimand and verdict rules" and "Internal
 * pilot"). The rule itself is eval/runner/rs1/iut.ts; this file reads the receipts, checks them and reports.
 *
 *   bun eval/runner/rs1/verdict.ts verdict --receipts <out dir>... [--manifest <filled rs1-manifest.json>] [--set RS1|RS1-dev2] [--out <dir>]
 *   bun eval/runner/rs1/verdict.ts pilot   --receipts <out dir>... [--manifest <filled rs1-manifest.json>] [--out <dir>]
 *   bun eval/runner/rs1/verdict.ts aggregates --receipts <out dir>... [--manifest <filled rs1-manifest.json>] --out <dir>
 *
 * Each --receipts directory is a cell or re-read output (cell.ts --out, reread-cell.ts --out): every
 * cells/<cell id>/receipt.json under it is read, with the cell's run-config.json, rows, answers and judgments, and each
 * re-read's answers and judgments.
 *
 *   Receipts  for set RS1, a cell whose dataset revision is unfilled, whose RS1 manifest SHA-256 is neither the filled
 *             manifest's nor one of its earlier_fills, or whose loaded files' SHA-256 differ from the filled manifest is
 *             refused, and so is a conversation that two receipts of one cell both hold. A verdict needs the filled
 *             manifest's n_final and every row's receipts holding exactly the first n_final kept conversations; a unit
 *             run with --limit, a run config that differs from the committed rs1-cells.json definition, and an
 *             instrument other than the cell's canonical one are refused. Every system row and the floor needs
 *             particle-1's re-read (reread-cell.ts, under rereadCellId) covering each of its receipts' run configs; a
 *             missing re-read refuses the run, and so do a keyless or invalid re-read and a conversation two re-reads
 *             of one arm both hold.
 *   Values    readers claude-opus-5-5 and gpt-6.1-sol from the cell and particle-1 from its re-read, joined by question id,
 *             replicate 0, each answer scored only by its own receipt's judgments. A product failure scores 0 under
 *             both views; a harness failure, a missing row, a missing answer or a missing gating judgment is a drop, by
 *             reason and side; a missing bridge judgment leaves the gating view whole and is counted among the bridge
 *             view's own drops; a scheduled question with no row in any system row refuses the verdict. The gating view
 *             ('frontier') is the reader's per-reader judge (<instrument>@<judge>: gpt-6-astra for claude-opus-5-5,
 *             claude-opus-5-5 for gpt-6.1-sol and particle-1); the descriptive bridge view is the canonical instrument's.
 *   Judges    a gating judgment whose judge shares the reader's family or is not the reader's mapped judge, that does not
 *             record the gating view, that was not sent at the pinned settings, or that records no model version, refuses.
 *             Each gating judge's returned model versions are reported; a judge that returned more than one is flagged
 *             as a mixed-snapshot gating view, at the top of the report (a flag, not a refusal or a verdict change).
 *   Gate      a system row passes the delivered-context gate when its mean fill rate (rows.ndjson fill_rate, a failed
 *             retrieval's null counted as 0) is at least 0.90; a row that fails makes every comparison it enters
 *             descriptive (no verdict).
 *   Paired    every comparison (overall, per reader, per ability; each server; each view) as gbrain minus the server on the
 *             same questions: the mean paired difference over conversation means with its two-sided 95% t interval (and
 *             the 90% interval, whose lower end is the one-sided bound the verdict uses), the count of questions where
 *             gbrain scored lower, higher and tied (per question on the three-reader mean; per reader on that reader's
 *             score), and "no measurable difference" when the 95% interval includes zero. Subgroup rows are descriptive,
 *             with no multiplicity correction, and read "too few conversations" below MIN_SUBGROUP_CONVERSATIONS.
 *   Reported  iut.ts's decision, the worst-case sensitivity and a flag when it disagrees, the restricted wild cluster
 *             bootstrap-t on the question-weighted estimate (Webb weights, 9,999 draws, one-sided 95% lower bound),
 *             per-reader and per-ability means, the floor, each row's fill rate, drops by reason and side, and the first
 *             table (cost per correct answer, claude-opus-5-5 and particle-1 first, then gpt-6.1-sol; n/a where a unit's
 *             meters or a re-read's reader spend are missing).
 *   Pilot     wave A only (the first 20 kept conversations; a shorter kept list refuses): the two gating tests' SDs of the
 *             per-conversation differences and their correlation, no means; then power.ts's N_required and
 *             N_final = min(33, max(20, N_required)). Above 33 it exits 3 with RS1_PILOT_OVER_CAP, the margin reachable
 *             at 33 and the price of N_required.
 *   Aggregates the final custody run (set RS1, the final kept list only): verdict mode's analysis, unchanged, in
 *             aggregates.json and aggregates.md, with what it was computed from (the code commit, the SHA-256 of verdict.ts,
 *             iut.ts, rs1-cells.json and the filled manifest, and one SHA-256 over every receipt file read). Every key and
 *             string in the analysis must come from a closed vocabulary (rows, readers, judges, views, BEAM's ten abilities,
 *             outcome codes, the report's own templates, and model versions of each gating judge); anything else refuses
 *             without writing or echoing it. It prints only the verdict, counts and the file's SHA-256.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { HARNESS_FAILURES, OUTCOMES, PRODUCT_FAILURES, type Outcome } from '../memory-qa/outcomes.ts';
import { instrumentFor } from '../memory-qa/instruments.ts';
import { readRecords, type AnswerRecord, type JudgmentRecord } from '../memory-qa/records.ts';
import { RS1_MANIFEST, rs1Kept, type Rs1Manifest } from '../memory-qa/corpus.ts';
import { frontierInstrumentId, runConfigIdentity, runConfigText } from '../q1/cell.ts';
import { PER_READER_JUDGE_SETTINGS } from '../q1/cells/definitions.ts';
import { loadRS1Manifest, OPUS, PARTICLE, rs1JudgeOf, RS1_MANIFEST_PATH, RS1_WAVE_A, SOL } from '../q1/cells/rs1.ts';
import { rereadCellId } from '../q1/reread-cell.ts';
import { wildTest, type ClusterRow } from '../stats/wild-cluster.ts';
import { COMPARISONS, conversationDifferences, decide, dropValidity, GATING, inBridgeSet, inCommonSet, questionScores, RS1_MARGIN, SERVERS, tQuantile, viewValue, VIEWS, worstCase,
  type ComparisonKey, type Decision, type Drop, type QuestionInput, type ReaderValue, type Row, type Scored, type Server, type View } from './iut.ts';
import { N_CAP, pilotSize } from './power.ts';
import { priceAt } from './pricing.ts';

export const READERS = [OPUS, SOL, PARTICLE];
/** The first table's reader order: the primary models first (AGENTS.md), then gpt-6.1-sol. */
export const TABLE_READERS = [OPUS, PARTICLE, SOL];
export const FILL_GATE = 0.9;
export const DRAWS = 9999;
export const SEED = 20261108;
const BOOTSTRAP_METHOD = `restricted wild cluster bootstrap-t, Webb weights, ${DRAWS} draws, seed ${SEED}, one-sided 95% lower bound`;
export const ROLES: Record<string, Row | 'floor'> = { 'gbrain-defaults': 'gbrain', 'ext-memory-bank': 'memory-bank', 'ext-extract-first': 'extract-first', 'baseline-none': 'floor' };
/** Below this many conversations a per-reader or per-ability paired row reads "too few conversations". */
export const MIN_SUBGROUP_CONVERSATIONS = 5;
const TIE = 1e-9;

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
  /** Each gating judge's model versions, as the provider returned them, across every gating judgment read. */
  snapshots?: Record<string, string[]>;
}

const ROWS: Row[] = ['gbrain', ...SERVERS];

/** The four bounds' one-sided 95% bootstrap lower bounds (restricted wild cluster bootstrap-t, question-weighted), each view on its own set. */
function bootstrap(scored: readonly Scored[]) {
  return COMPARISONS.map(key => {
    const [server, view] = key.split('/') as [Row, View];
    const byConv = new Map<string, { n: number; sum: number }>();
    for (const q of scored.filter(view === 'frontier' ? inCommonSet : inBridgeSet)) {
      const c = byConv.get(q.conversation) ?? { n: 0, sum: 0 };
      c.n++; c.sum += q.scores.gbrain![view]! - q.scores[server]![view]!;
      byConv.set(q.conversation, c);
    }
    const rows: ClusterRow[] = [...byConv].map(([id, c]) => ({ id, stratum: 'all', n: c.n, sum: c.sum }));
    if (rows.length < 2) return { key, estimate: null, lower: null, agrees: null };
    const t = wildTest(rows, { draws: DRAWS, seed: SEED, weights: 'webb', alpha: 0.1 });
    return { key, estimate: r4(t.theta), lower: r4(t.ci95[0]), agrees: null as boolean | null };
  });
}

export interface PairedRow {
  server: Server; view: View; subset: string; conversations: number; questions: number;
  mean: number | null; ci95: [number, number] | null; ci90: [number, number] | null;
  lower: number; higher: number; tied: number;
  reading: 'no measurable difference' | 'gbrain lower' | 'gbrain higher' | 'too few conversations';
}

/**
 * One paired comparison from per-question differences (gbrain minus server, points): conversation means, their mean and
 * two-sided t intervals on n - 1 df, and the lower, higher and tied counts over the questions.
 */
export function pairedRow(key: { server: Server; view: View; subset: string }, pairs: ReadonlyArray<{ conversation: string; d: number }>, minConversations = 2): PairedRow {
  const byConv = new Map<string, number[]>();
  for (const p of pairs) byConv.set(p.conversation, [...(byConv.get(p.conversation) ?? []), p.d]);
  const means = [...byConv.values()].map(xs => xs.reduce((a, b) => a + b, 0) / xs.length);
  const counts = { lower: pairs.filter(p => p.d < -TIE).length, higher: pairs.filter(p => p.d > TIE).length, tied: pairs.filter(p => Math.abs(p.d) <= TIE).length };
  const base = { ...key, conversations: means.length, questions: pairs.length, ...counts };
  if (means.length < Math.max(2, minConversations)) return { ...base, mean: means.length ? r4(meanOf(means)!) : null, ci95: null, ci90: null, reading: 'too few conversations' };
  const n = means.length, m = meanOf(means)!;
  const se = Math.sqrt(means.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1)) / Math.sqrt(n);
  const ci = (level: number): [number, number] => { const h = tQuantile(1 - (1 - level) / 2, n - 1) * se; return [r4(m - h), r4(m + h)]; };
  const ci95 = ci(0.95);
  return { ...base, mean: r4(m), ci95, ci90: ci(0.9), reading: ci95[0] <= 0 && ci95[1] >= 0 ? 'no measurable difference' : m < 0 ? 'gbrain lower' : 'gbrain higher' };
}

export function analyze(input: VerdictInput) {
  const scoredAll = input.questions.map(q => questionScores(q, READERS));
  const scored = scoredAll.map(s => s.scored);
  const drops: Drop[] = scoredAll.flatMap(s => s.drops);
  const bridgeDrops: Drop[] = scoredAll.flatMap(s => s.bridge_drops);
  const validity = dropValidity(scored);
  const gate = ROWS.map(row => ({ row, fill_rate: r4n(input.fill[row]), pass: input.fill[row] !== null && input.fill[row]! >= FILL_GATE }));
  const invalid: Partial<Record<ComparisonKey, string[]>> = {};
  for (const key of COMPARISONS) {
    const server = key.split('/')[0] as Row;
    const reasons = [...(validity.invalid[key] ?? []), ...gate.filter(g => !g.pass && (g.row === 'gbrain' || g.row === server)).map(g => `descriptive: ${g.row} failed the delivered-context gate (mean fill rate ${g.fill_rate ?? 'not recorded'}, needs ${FILL_GATE})`)];
    if (reasons.length) invalid[key] = reasons;
  }
  const { conversations, bridge_conversations, diffs } = conversationDifferences(scored);
  if (conversations.length < 2) refuse(`fewer than two conversations have a common question (${conversations.length})`);
  const reported = COMPARISONS.filter(k => GATING.includes(k) || bridge_conversations.length >= 2);
  const decision = decide(Object.fromEntries(reported.map(k => [k, diffs[k]])), { invalid });
  const worst = decide(conversationDifferences(scored, worstCase).diffs, { invalid });
  const boot = bootstrap(scored).map(b => ({ ...b, agrees: b.lower === null ? null : (b.lower > -RS1_MARGIN) === decision.tests.find(t => t.key === b.key)!.pass }));
  const common = scored.filter(inCommonSet);
  const perReader = READERS.flatMap(reader => ROWS.flatMap(row => VIEWS.map(view => {
    const xs = input.questions.filter(q => common.some(c => c.id === q.id)).map(q => q.rows[row][reader]).flatMap(v => (!v || 'drop' in v || v[view] === null ? [] : [100 * v[view]!]));
    return { reader, row, view, questions: xs.length, mean: r4n(meanOf(xs)) };
  })));
  const abilities = [...new Set(common.map(q => q.id.split(':')[1] ?? 'unknown'))].sort();
  const perAbility = abilities.flatMap(ability => ROWS.flatMap(row => VIEWS.map(view => {
    const xs = common.filter(q => (q.id.split(':')[1] ?? 'unknown') === ability).flatMap(q => (q.scores[row]![view] === null ? [] : [q.scores[row]![view]!]));
    return { ability, row, view, questions: xs.length, mean: r4n(meanOf(xs)) };
  })));
  const floorScores = input.floor.map(f => { const vs = READERS.map(r => f.values[r]); return vs.every(v => typeof v === 'number') ? 100 * (vs as number[]).reduce((a, b) => a + b, 0) / vs.length : null; }).filter((x): x is number => x !== null);
  const floorMean = meanOf(floorScores);
  const rowBridge = (row: Row) => meanOf(scored.flatMap(s => (s.scores[row]?.bridge == null ? [] : [s.scores[row]!.bridge!])));
  const floor = { questions: floorScores.length, mean_bridge: r4n(floorMean), below_every_system_row: floorMean !== null && ROWS.every(row => { const m = rowBridge(row); return m !== null && floorMean < m; }) };
  const counts = (ds: readonly Drop[]) => { const out: Record<string, number> = {}; for (const d of ds) out[`${d.side}|${d.reason}`] = (out[`${d.side}|${d.reason}`] ?? 0) + 1; return out; };
  const dropCounts = counts(drops);
  const accuracy = (row: Row | 'floor', reader: string, view: View): number | null => {
    if (row === 'floor') return view === 'bridge' ? meanOf(input.floor.map(f => f.values[reader]).filter((v): v is number => typeof v === 'number').map(v => 100 * v)) : null;
    return meanOf(input.questions.map(q => q.rows[row][reader]).flatMap(v => (!v || 'drop' in v || v[view] === null ? [] : [100 * v[view]!])));
  };
  const table = TABLE_READERS.flatMap(reader => [...ROWS, 'floor' as const].map(row => {
    const usd = input.costs.find(c => c.row === row && c.reader === reader)?.usd_per_question ?? null;
    const view = (v: View) => { const a = accuracy(row, reader, v); return { accuracy: r4n(a), usd_per_correct: usd === null || !a ? null : r4(usd / (a / 100)) }; };
    return { reader, row, usd_per_question: r4n(usd), frontier: view('frontier'), bridge: view('bridge') };
  }));
  const ability = (id: string) => id.split(':')[1] ?? 'unknown';
  const inView = (view: View) => (view === 'frontier' ? inCommonSet : inBridgeSet);
  const byKey = new Map(input.questions.map(q => [q.id, q]));
  const paired = SERVERS.flatMap(server => VIEWS.flatMap(view => {
    const qs = scored.filter(inView(view));
    const rowPairs = (sel: readonly Scored[]) => sel.map(s => ({ conversation: s.conversation, d: viewValue(s, 'gbrain', view)! - viewValue(s, server, view)! }));
    const readerPairs = (reader: string) => qs.flatMap(s => {
      const g = byKey.get(s.id)!.rows.gbrain[reader], x = byKey.get(s.id)!.rows[server][reader];
      return !g || !x || 'drop' in g || 'drop' in x || g[view] === null || x[view] === null ? [] : [{ conversation: s.conversation, d: 100 * (g[view]! - x[view]!) }];
    });
    return [
      pairedRow({ server, view, subset: 'overall' }, rowPairs(qs)),
      ...READERS.map(reader => pairedRow({ server, view, subset: `reader ${reader}` }, readerPairs(reader), MIN_SUBGROUP_CONVERSATIONS)),
      ...[...new Set(qs.map(s => ability(s.id)))].sort().map(a => pairedRow({ server, view, subset: `ability ${a}` }, rowPairs(qs.filter(s => ability(s.id) === a)), MIN_SUBGROUP_CONVERSATIONS)),
    ];
  }));
  const disagrees = decision.verdict !== 'invalid' && worst.verdict !== decision.verdict;
  return {
    schema: 'gbrain-evals/rs1-verdict/v1', set: input.set, margin: RS1_MARGIN, readers: READERS, conversations: conversations.length,
    planned_questions: validity.planned, common_questions: validity.common, drop_share: r4(validity.share),
    gating: GATING, bridge: { conversations: bridge_conversations.length, common_questions: validity.bridge_common, drop_share: r4(validity.bridge_share), drops: counts(bridgeDrops) },
    verdict: decision.verdict, tests: roundTests(decision), secondaries: decision.secondaries.map(s => ({ id: s.id, status: s.status })),
    worst_case: { verdict: worst.verdict, tests: roundTests(worst), disagrees },
    bootstrap: { method: BOOTSTRAP_METHOD, tests: boot },
    paired, gate, drops: dropCounts, per_reader: perReader, per_ability: perAbility, floor, table,
    judge_snapshots: Object.entries(input.snapshots ?? {}).map(([judge, versions]) => ({ judge, versions, mixed: versions.length > 1 })),
  };
}
const roundTests = (d: Decision) => d.tests.map(t => ({ key: t.key, gating: t.gating, n: t.n, estimate: r4(t.mean), sd: r4(t.sd), lower: r4(t.lower), pass: t.pass, valid: t.valid, invalid_reasons: t.invalid_reasons }));
export type Analysis = ReturnType<typeof analyze>;

/** The pilot's output: the two gating tests' SDs of the per-conversation differences and their correlation, no means. */
export function pilotStats(input: VerdictInput) {
  const scored = input.questions.map(q => questionScores(q, READERS).scored);
  const { conversations, diffs } = conversationDifferences(scored);
  const n = conversations.length;
  if (n < 3) refuse(`the pilot needs at least three conversations with common questions, got ${n}`);
  const centred = GATING.map(k => { const xs = diffs[k]; const m = xs.reduce((a, b) => a + b, 0) / n; return xs.map(x => x - m); });
  const cov = (i: number, j: number) => centred[i].reduce((s, x, c) => s + x * centred[j][c], 0) / (n - 1);
  const sds = GATING.map((_, i) => Math.sqrt(cov(i, i)));
  if (sds.some(sd => !(sd > 0))) refuse(`a test's per-conversation differences do not vary (SDs ${sds.map(sd => sd.toFixed(2)).join(', ')}), so no correlation can be estimated`);
  const corr = GATING.map((_, i) => GATING.map((_, j) => cov(i, j) / (sds[i] * sds[j])));
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
  if (!ds) return ['it records no dataset'];
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

/** A run config with the fields one launch unit may differ in left out: its dataset files, its scheduled questions and its limit (refused separately). */
const unitIdentity = (config: Record<string, any>): Record<string, any> => { const { dataset: _d, scheduled_sha256: _s, limit: _l, ...rest } = config; return JSON.parse(runConfigIdentity(JSON.stringify(rest))); };
/** The dotted keys where two run-config identities differ. */
const differing = (a: Record<string, any>, b: Record<string, any>, at = ''): string[] => [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap(k =>
  JSON.stringify(a[k]) === JSON.stringify(b[k]) ? [] : a[k] && b[k] && typeof a[k] === 'object' && typeof b[k] === 'object' && !Array.isArray(a[k]) ? differing(a[k], b[k], `${at}${k}.`) : [`${at}${k}`]);

/** Read and check every receipt, then build the analysis input. */
export function loadInput(dirs: readonly string[], o: LoadOptions): VerdictInput {
  const cells = loadRS1Manifest();
  const defs = (o.set === 'RS1' ? cells.cells : cells.smoke_cells).filter(c => c.arms[0].set === o.set);
  let manifest: Rs1Manifest | null = null, manifestSha = '', wave: Set<string> | null = null, finalSet: string[] | null = null;
  if (o.set === 'RS1') {
    const bytes = readFileSync(o.manifestPath);
    manifest = JSON.parse(bytes.toString('utf8')) as Rs1Manifest;
    if (manifest.status !== 'filled') refuse(`the RS1 manifest ${o.manifestPath} is unfilled; verdict.ts reads receipts only against the filled manifest`);
    manifestSha = sha256(bytes);
    const { kept, n_final } = rs1Kept(manifest);
    if (o.waveA) {
      if (kept.length < RS1_WAVE_A) refuse(`the pilot needs the first ${RS1_WAVE_A} kept conversations (wave A), and the kept list holds ${kept.length}`);
      wave = new Set(kept.slice(0, RS1_WAVE_A));
    }
    else if (n_final === null || kept.length < n_final) refuse(`the filled manifest's kept list is not final (n_final ${n_final ?? 'unset'}, ${kept.length} kept); a verdict reads exactly the first N_final kept conversations`);
    else finalSet = kept.slice(0, n_final);
  } else if (o.waveA) refuse('the pilot reads set RS1 only');
  const found = findReceipts(dirs);
  const values = new Map<Row | 'floor', Map<string, Record<string, ReaderValue>>>();
  const rowIds = new Map<Row | 'floor', Set<string>>();
  const scheduled = new Map<Row, number>();
  const planned = new Map<string, string>();
  const fill: Record<Row, number | null> = { gbrain: null, 'memory-bank': null, 'extract-first': null };
  const costs: CostRow[] = [];
  const snapshots = new Map<string, Set<string>>();
  for (const def of defs) {
    const role = ROLES[def.system] ?? refuse(`cell ${def.id} has no RS1 role (system ${def.system})`);
    const armCell = def.arms[0].cell_id;
    const instrument = instrumentFor(def.canonical_instrument);
    const wrongInstrument = (f: CellFiles) => f.receipt.instrument?.id !== instrument.id || f.receipt.instrument?.sha256 !== instrument.sha256;
    const expected = unitIdentity(JSON.parse(runConfigText(def, def.arms[0], { instrument, dataset: null as never, scheduledSha: '', limit: null })));
    const units = found.filter(f => f.receipt.cell_id === armCell);
    if (!units.length) refuse(`no receipt for ${armCell} under the given directories`);
    const held = new Map<string, string>();
    const ids = new Set<string>();
    const byQuestion = new Map<string, Record<string, ReaderValue>>();
    const answered = new Map<string, number>();
    const take = (dir: string, ans: AnswerRecord[]) => {
      const records = readRecords(join(dir, 'judgments.ndjson'), 'judgment').filter(j => j.judge_replicate === 0);
      const readerOf = new Map(ans.map(a => [a.answer_id, a.reader]));
      const problems = records.flatMap(j => gatingProblems(j, readerOf.get(j.answer_id), instrument.id));
      if (problems.length) refuse(`${dir}: ${problems.slice(0, 3).join('; ')}${problems.length > 3 ? ` (and ${problems.length - 3} more)` : ''}`);
      for (const j of records.filter(r => r.view === 'gating')) for (const v of j.judge_versions ?? []) snapshots.set(j.judge, new Set([...(snapshots.get(j.judge) ?? []), v]));
      const score = new Map(records.map(j => [`${j.answer_id}|${j.instrument_id}`, j.score]));
      for (const a of ans.filter(x => x.replicate === 0 && READERS.includes(x.reader))) {
        byQuestion.set(a.question_id, { ...(byQuestion.get(a.question_id) ?? {}), [a.reader]: readerValue(a, score, instrument.id, role === 'floor') });
        answered.set(a.reader, (answered.get(a.reader) ?? 0) + 1);
      }
    };
    const fills: number[] = [];
    let shared = 0, sharedKnown = true, scheduledInRow = 0;
    const readerUsd = new Map<string, number>();
    const unmetered = new Set<string>();
    let questionsInRow = 0;
    for (const u of units) {
      if (u.receipt.run_status === 'invalid') refuse(`${u.dir} is invalid: ${(u.receipt.invalid_reasons ?? []).join('; ')}`);
      if (manifest) { const p = receiptManifestProblems(u.config, manifest, manifestSha); if (p.length) refuse(`${u.dir}: ${p.join('; ')}`); }
      const config = u.config ?? refuse(`${u.dir} has no run-config.json`);
      if ((config.limit ?? null) !== null) refuse(`${u.dir} ran with --limit ${config.limit}; a verdict reads whole launch units, every scheduled question`);
      const diff = differing(unitIdentity(config), expected);
      if (diff.length) refuse(`${u.dir}: its run config differs from ${def.id} in the committed rs1-cells.json at ${diff.join(', ')}`);
      if (wrongInstrument(u)) refuse(`${u.dir} was judged under instrument ${u.receipt.instrument?.id} (${String(u.receipt.instrument?.sha256 ?? 'no sha256').slice(0, 12)}), not ${instrument.id} (${instrument.sha256.slice(0, 12)})`);
      const allRows = readRecordsLoose(join(u.dir, 'rows.ndjson'));
      const rows = allRows.filter(r => !wave || wave.has(String(r.conversation)));
      const convs = new Set([...allRows.map(r => String(r.conversation)), ...((u.receipt.realizations ?? []) as Array<{ conversation: string }>).map(r => String(r.conversation))]);
      for (const conv of [...convs].filter(c => !wave || wave.has(c))) { if (held.has(conv)) refuse(`${armCell}: conversation ${conv} is in both ${held.get(conv)} and ${u.dir}`); held.set(conv, u.dir); }
      for (const r of rows) { ids.add(String(r.id)); if (role !== 'floor') planned.set(String(r.id), String(r.conversation)); fills.push(typeof r.fill_rate === 'number' ? r.fill_rate : 0); }
      questionsInRow += rows.length;
      scheduledInRow += Number(u.receipt.selection?.questions);
      const ans = readRecords(join(u.dir, 'answers.ndjson'), 'answer').filter(a => !wave || wave.has(a.conversation));
      take(u.dir, ans);
      const spend = u.receipt.spend?.usd as Record<string, number> | undefined;
      if (spend) shared += (spend.ingest ?? 0) + (spend.retrieval ?? 0) + (spend.background_tail ?? 0); else sharedKnown = false;
      const meters = join(u.root, 'runs', String(u.receipt.run_cell), 'meters.ndjson');
      const metered = new Set<string>();
      if (existsSync(meters)) {
        const byKey = new Map(ans.map(a => [`read:${a.answer_id.slice(0, 16)}`, a.reader]));
        for (const m of readRecordsLoose(meters)) { const reader = m.phase === 'reader' ? byKey.get(String(m.key)) : undefined; if (reader) { readerUsd.set(reader, (readerUsd.get(reader) ?? 0) + Number(m.usd)); metered.add(reader); } }
      }
      for (const a of ans) if (a.context_sha256 !== sha256(`no-context|${a.outcome}`) && !metered.has(a.reader)) unmetered.add(a.reader);
    }
    if (finalSet) {
      const absent = finalSet.filter(c => !held.has(c)), extra = [...held.keys()].filter(c => !finalSet!.includes(c)).sort();
      if (absent.length || extra.length) refuse(`${armCell}: the receipts must hold exactly the first ${finalSet.length} kept conversations${absent.length ? `; missing ${absent.join(', ')}` : ''}${extra.length ? `; not in that set ${extra.join(', ')}` : ''}`);
      if (role !== 'floor') {
        if (!Number.isInteger(scheduledInRow)) refuse(`${armCell}: a receipt has no selection.questions count, so its scheduled questions cannot be checked against its rows`);
        scheduled.set(role, scheduledInRow);
      }
    }
    const rereadId = rereadCellId(armCell, PARTICLE);
    const rereads = found.filter(f => f.receipt.cell_id === rereadId);
    const configs = new Set(units.map(u => String(u.receipt.config_sha256)));
    const covered = new Set(rereads.flatMap(r => (r.receipt.source?.config_sha256s ?? []) as string[]));
    const uncovered = [...configs].filter(c => !covered.has(c));
    if (!rereads.length || uncovered.length) refuse(`missing particle-1 re-read: ${armCell} has ${uncovered.length || configs.size} receipt(s) no ${rereadId} covers`);
    const reheld = new Map<string, string>();
    for (const r of rereads) {
      if (r.receipt.keyless !== false) refuse(`${r.dir} is not a paid re-read (keyless ${r.receipt.keyless ?? 'unrecorded'}); a verdict reads only re-reads whose receipt says keyless: false`);
      if (r.receipt.run_status === 'invalid') refuse(`${r.dir} is invalid: ${(r.receipt.invalid_reasons ?? []).join('; ')}`);
      if (manifest) { const p = receiptManifestProblems(r.receipt, manifest, manifestSha); if (p.length) refuse(`${r.dir}: ${p.join('; ')}`); }
      if (wrongInstrument(r)) refuse(`${r.dir} was judged under instrument ${r.receipt.instrument?.id}, not ${instrument.id} (${instrument.sha256.slice(0, 12)})`);
      const ans = readRecords(join(r.dir, 'answers.ndjson'), 'answer');
      for (const conv of new Set(ans.map(a => a.conversation))) { if (reheld.has(conv)) refuse(`${rereadId}: conversation ${conv} is re-read in both ${reheld.get(conv)} and ${r.dir}`); reheld.set(conv, r.dir); }
      take(r.dir, ans.filter(a => !wave || wave.has(a.conversation)));
      const usd = r.receipt.spend?.reader_usd;
      if (typeof usd === 'number') readerUsd.set(PARTICLE, (readerUsd.get(PARTICLE) ?? 0) + usd); else unmetered.add(PARTICLE);
    }
    values.set(role, byQuestion);
    rowIds.set(role, ids);
    if (role !== 'floor') fill[role] = meanOf(fills);
    for (const reader of READERS) {
      const n = answered.get(reader) ?? 0;
      costs.push({ row: role, reader, usd_per_question: !sharedKnown || unmetered.has(reader) || !n || !questionsInRow ? null : shared / questionsInRow + (readerUsd.get(reader) ?? 0) / n });
    }
  }
  for (const [row, n] of scheduled) if (n > planned.size) refuse(`${row} scheduled ${n} questions and only ${planned.size} have a row in any system row, so ${n - planned.size} would leave the planned set unseen; resume the launch units that are missing rows`);
  const value = (row: Row | 'floor', id: string, reader: string): ReaderValue => values.get(row)?.get(id)?.[reader] ?? (!rowIds.get(row)?.has(id) ? { drop: 'row_missing' } : { drop: reader === PARTICLE ? 'reread_answer_missing' : 'answer_missing' });
  const questions: QuestionInput[] = [...planned].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, conversation]) => ({
    id, conversation, rows: Object.fromEntries(ROWS.map(row => [row, Object.fromEntries(READERS.map(r => [r, value(row, id, r)]))])) as QuestionInput['rows'],
  }));
  const floor: FloorQuestion[] = questions.map(q => ({ id: q.id, conversation: q.conversation, values: Object.fromEntries(READERS.map(r => {
    const v = value('floor', q.id, r);
    return [r, 'drop' in v ? v : v.bridge ?? { drop: 'judgment_missing:bridge' }];
  })) }));
  if (wave) { const seen = new Set(questions.map(q => q.conversation)); const absent = [...wave].filter(c => !seen.has(c)); if (absent.length) refuse(`the pilot needs every wave A conversation; ${absent.join(', ')} has no rows`); }
  return { set: o.set, questions, floor, fill, costs, snapshots: Object.fromEntries([...snapshots].sort(([a], [b]) => (a < b ? -1 : 1)).map(([j, vs]) => [j, [...vs].sort()])) };
}

function readRecordsLoose(path: string): Array<Record<string, any>> {
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l)) : [];
}

/**
 * Why a gating judgment (<instrument>@<judge>) cannot count: its judge shares the reader's family or is not the reader's
 * mapped judge (rs1.ts rs1JudgeOf), it does not record the gating view, it was not sent at the pinned
 * settings, or a scored judgment records no model version. Other judgments, and answers outside the set read, pass.
 */
export function gatingProblems(j: Pick<JudgmentRecord, 'answer_id' | 'instrument_id' | 'judge' | 'outcome' | 'view' | 'settings' | 'judge_versions'>, reader: string | undefined, instrument: string): string[] {
  if (!reader || !j.instrument_id.startsWith(`${instrument}@`)) return [];
  const mapped = rs1JudgeOf(reader);
  const who = `answer ${j.answer_id.slice(0, 12)} (${reader})`;
  const p: string[] = [];
  if (j.judge.split(':')[0] === reader.split(':')[0]) p.push(`${who} has a gating judgment by ${j.judge}, a judge of its own family (GST-767)`);
  if (j.judge !== mapped || j.instrument_id !== frontierInstrumentId(instrument, mapped)) p.push(`${who} has a gating judgment by ${j.judge} under ${j.instrument_id}, not its mapped judge ${mapped}`);
  if (j.view !== 'gating') p.push(`${who} has a gating judgment that does not record the gating view`);
  if (JSON.stringify(j.settings ?? null) !== JSON.stringify(PER_READER_JUDGE_SETTINGS)) p.push(`${who} has a gating judgment sent at ${JSON.stringify(j.settings ?? null)}, not the pinned ${JSON.stringify(PER_READER_JUDGE_SETTINGS)}`);
  if (j.outcome === 'scored' && !j.judge_versions?.length) p.push(`${who} has a gating judgment that records no judge model version`);
  return p;
}

/** One answer's value: product failures 0, harness failures and missing gating judgments dropped by reason, a missing bridge judgment null. */
export function readerValue(a: Pick<AnswerRecord, 'answer_id' | 'reader' | 'outcome'>, score: ReadonlyMap<string, number | null>, instrument: string, bridgeOnly = false): ReaderValue {
  const outcome = a.outcome as Outcome;
  if (PRODUCT_FAILURES.has(outcome)) return { frontier: 0, bridge: 0 };
  if (HARNESS_FAILURES.has(outcome) || (outcome !== 'scored' && outcome !== 'ingest_degraded')) return { drop: outcome };
  const bridge = score.get(`${a.answer_id}|${instrument}`);
  if (bridgeOnly) return typeof bridge === 'number' ? { frontier: bridge, bridge } : { drop: 'judgment_missing:bridge' };
  const frontier = score.get(`${a.answer_id}|${frontierInstrumentId(instrument, rs1JudgeOf(a.reader))}`);
  if (typeof frontier !== 'number') return { drop: 'judgment_missing:frontier' };
  return { frontier, bridge: typeof bridge === 'number' ? bridge : null };
}

// ─── Aggregates (the final custody run's output) ─────────────────────

/** BEAM's ten probing abilities, as the mint writes them (eval/custody/rs1/rs1_mint.py ABILITIES). */
export const BEAM_ABILITIES = ['abstention', 'contradiction_resolution', 'event_ordering', 'information_extraction', 'instruction_following', 'knowledge_update', 'multi_session_reasoning', 'preference_following', 'summarization', 'temporal_reasoning'];
const DROP_REASONS = [...OUTCOMES.filter(o => o !== 'scored'), 'row_missing', 'answer_missing', 'reread_answer_missing', 'judgment_missing:frontier', 'judgment_missing:bridge'];
const AGGREGATE_WORDS = new Set<string>([
  'gbrain-evals/rs1-verdict/v1', 'RS1', BOOTSTRAP_METHOD, ...READERS, ...READERS.map(rs1JudgeOf), ...ROWS, 'floor', ...VIEWS, ...COMPARISONS, 'pass', 'fail', 'invalid', 'not_tested',
  ...SERVERS.map(s => `superiority/${s}`), 'no measurable difference', 'gbrain lower', 'gbrain higher', 'too few conversations', 'overall', ...READERS.map(r => `reader ${r}`),
  ...BEAM_ABILITIES, ...BEAM_ABILITIES.map(a => `ability ${a}`),
]);
const DROP_KEYS = new Set(['gbrain', 'server'].flatMap(side => DROP_REASONS.map(r => `${side}|${r}`)));
/** The two invalid-reason templates analyze writes (iut.ts dropValidity and the delivered-context gate). */
const REASON_TEMPLATES = [/^\d+ of \d+ planned questions dropped \(\d+\.\d%, above the 5% cap\)$/, /^descriptive: (gbrain|memory-bank|extract-first) failed the delivered-context gate \(mean fill rate (\d+(\.\d+)?|not recorded), needs 0\.9\)$/];
/** A model version a gating judge returned: its model id, or its model id and a dated suffix. */
const isVersionOf = (judge: unknown, v: unknown) => { const model = String(judge).split(':')[1] ?? ''; return typeof v === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(v) && !!model && (v === model || v.startsWith(`${model}-`)); };

/**
 * Where an analysis holds a key or value outside the aggregate vocabulary, by path. A problem never quotes the value, so a
 * refusal cannot carry sealed text out of custody.
 */
export function aggregateProblems(analysis: Analysis): string[] {
  const problems: string[] = [];
  const walk = (x: unknown, at: string): void => {
    if (x === null || typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x))) return;
    if (Array.isArray(x)) { x.forEach((v, i) => walk(v, `${at}[${i}]`)); return; }
    if (typeof x === 'object') {
      for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
        if (!/^[a-z0-9_]+$/.test(k) && !DROP_KEYS.has(k)) { problems.push(`${at || 'top level'}: a key outside the aggregate vocabulary (${k.length} characters)`); continue; }
        if (k === 'versions' && /^judge_snapshots\[\d+\]$/.test(at)) {
          (Array.isArray(v) ? v : [v]).forEach((s, i) => { if (!isVersionOf((x as Record<string, unknown>).judge, s)) problems.push(`${at}.versions[${i}]: not a model version of its judge`); });
          continue;
        }
        walk(v, at ? `${at}.${k}` : k);
      }
      return;
    }
    if (typeof x === 'string' && (AGGREGATE_WORDS.has(x) || REASON_TEMPLATES.some(re => re.test(x)))) return;
    problems.push(`${at}: a ${typeof x} outside the aggregate vocabulary${typeof x === 'string' ? ` (${x.length} characters)` : ''}`);
  };
  walk(analysis, '');
  return problems;
}

/** The files verdict.ts reads from each receipt directory, for the receipts digest. */
const RECEIPT_FILES = ['receipt.json', 'run-config.json', 'rows.ndjson', 'answers.ndjson', 'judgments.ndjson'];

/** The final custody run: verdict mode's analysis of the final kept list, checked against the aggregate vocabulary, with what it was computed from. */
export function aggregatesOf(dirs: readonly string[], manifestPath: string) {
  const analysis = analyze(loadInput(dirs, { set: 'RS1', manifestPath }));
  const problems = aggregateProblems(analysis);
  if (problems.length) refuse(`the analysis holds values outside the aggregate vocabulary, so no aggregates were written: ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? ` (and ${problems.length - 5} more)` : ''}`);
  const root = resolve(import.meta.dir, '../../..');
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  let commit = '';
  try { commit = git('rev-parse', 'HEAD'); } catch { refuse(`aggregates record the checkout's commit, and git rev-parse HEAD failed in ${root}`); }
  const fileSha = (p: string) => sha256(readFileSync(p));
  const files = new Set(findReceipts(dirs).flatMap(f => [...RECEIPT_FILES.map(n => join(f.dir, n)), ...(f.receipt.run_cell ? [join(f.root, 'runs', String(f.receipt.run_cell), 'meters.ndjson')] : [])]).filter(p => existsSync(p)));
  const digests = [...files].map(fileSha).sort();
  return {
    schema: 'gbrain-evals/rs1-aggregates/v1',
    provenance: {
      code_commit: commit, tracked_tree_clean: git('status', '--porcelain', '--untracked-files=no') === '',
      verdict_sha256: fileSha(join(import.meta.dir, 'verdict.ts')), iut_sha256: fileSha(join(import.meta.dir, 'iut.ts')), cells_sha256: fileSha(RS1_MANIFEST_PATH),
      manifest_sha256: fileSha(manifestPath), receipt_files: digests.length, receipt_files_sha256: sha256(digests.join('\n')),
    },
    analysis,
  };
}
export type Aggregates = ReturnType<typeof aggregatesOf>;

// ─── Reports ─────────────────────────────────────────────────────────

const fmt = (x: number | null, d = 2) => (x === null ? 'n/a' : x.toFixed(d));
export function markdown(a: Analysis): string {
  const lines = [`# RS1 verdict (set ${a.set})`, ''];
  if (a.worst_case.disagrees) lines.push(`**The worst-case sensitivity disagrees with the verdict:** ${a.worst_case.verdict} against ${a.verdict}.`, '');
  for (const s of a.judge_snapshots.filter(x => x.mixed)) lines.push(`**Mixed judge snapshots in the gating view:** ${s.judge} returned ${s.versions.join(', ')}.`, '');
  if (a.judge_snapshots.length) lines.push(`Gating judge versions: ${a.judge_snapshots.map(s => `${s.judge} ${s.versions.join(', ') || 'none'}`).join('; ')}.`, '');
  lines.push(`Verdict: **${a.verdict}** (both gating one-sided 95% t lower bounds, Astra/Opus view, above -${a.margin}; the bridge view is descriptive). ${a.conversations} conversations, ${a.common_questions} of ${a.planned_questions} planned questions in the common set; the bridge view has ${a.bridge.common_questions} questions over ${a.bridge.conversations} conversations.`, '');
  lines.push('| Test | Role | n | Estimate | SD | Lower bound | Pass | Bootstrap lower | Worst-case lower | Validity |', '|---|---|---:|---:|---:|---:|---|---:|---:|---|');
  for (const t of a.tests) {
    const b = a.bootstrap.tests.find(x => x.key === t.key)!, w = a.worst_case.tests.find(x => x.key === t.key)!;
    lines.push(`| gbrain minus ${t.key.replace('/', ', ')} | ${t.gating ? 'gating' : 'descriptive'} | ${t.n} | ${fmt(t.estimate)} | ${fmt(t.sd)} | ${fmt(t.lower)} | ${t.pass ? 'yes' : 'no'} | ${fmt(b.lower)} | ${fmt(w.lower)} | ${t.valid ? 'valid' : t.invalid_reasons.join('; ')} |`);
  }
  lines.push('', `Secondaries: ${a.secondaries.length ? a.secondaries.map(s => `${s.id} ${s.status}`).join(', ') : 'not tested (the primary did not pass)'}.`, '');
  const ci = (c: [number, number] | null) => (c ? `${fmt(c[0])} to ${fmt(c[1])}` : 'n/a');
  lines.push('Paired comparisons, gbrain minus the server on the same questions, in points. The gating view is gpt-6-astra on claude-opus-5-5 rows and claude-opus-5-5 on gpt-6.1-sol and particle-1 rows; the bridge view (gpt-4.1-mini) is descriptive and breaks the family rule on gpt-6.1-sol rows. Reader and ability rows are descriptive, with no multiplicity correction. The 90% interval\'s lower end is the one-sided bound the verdict uses.', '');
  lines.push('| Server | View | Subset | Conversations | Questions | Mean difference | 95% interval | 90% interval | gbrain lower / higher / tied | Reading |', '|---|---|---|---:|---:|---:|---|---|---|---|');
  for (const p of a.paired) lines.push(`| ${p.server} | ${p.view === 'frontier' ? 'gating' : 'bridge'} | ${p.subset} | ${p.conversations} | ${p.questions} | ${fmt(p.mean)} | ${ci(p.ci95)} | ${ci(p.ci90)} | ${p.lower} / ${p.higher} / ${p.tied} | ${p.reading} |`);
  lines.push('');
  lines.push('| Reader | Row | Cost per question | Accuracy, frontier | Cost per correct, frontier | Accuracy, bridge | Cost per correct, bridge |', '|---|---|---:|---:|---:|---:|---:|');
  for (const t of a.table) lines.push(`| ${t.reader} | ${t.row} | ${fmt(t.usd_per_question, 4)} | ${fmt(t.frontier.accuracy)} | ${fmt(t.frontier.usd_per_correct, 4)} | ${fmt(t.bridge.accuracy)} | ${fmt(t.bridge.usd_per_correct, 4)} |`);
  lines.push('', '| Row | Mean fill rate | Gate |', '|---|---:|---|', ...a.gate.map(g => `| ${g.row} | ${fmt(g.fill_rate, 3)} | ${g.pass ? 'pass' : 'fail'} |`));
  lines.push('', `Floor (bridge view): ${fmt(a.floor.mean_bridge)} over ${a.floor.questions} questions; below every system row: ${a.floor.below_every_system_row ? 'yes' : 'no'}.`, '');
  lines.push('| Side and reason | Drops |', '|---|---:|', ...Object.entries(a.drops).sort().map(([k, n]) => `| ${k.replace('|', ', ')} | ${n} |`));
  lines.push('', '| Bridge view only: side and reason | Drops |', '|---|---:|', ...Object.entries(a.bridge.drops).sort().map(([k, n]) => `| ${k.replace('|', ', ')} | ${n} |`));
  return lines.join('\n') + '\n';
}

export function aggregatesMarkdown(g: Aggregates): string {
  const p = g.provenance;
  return markdown(g.analysis) + ['', '## Provenance', '', `Code ${p.code_commit}${p.tracked_tree_clean ? '' : ' (tracked files modified)'}. SHA-256: verdict.ts ${p.verdict_sha256}, iut.ts ${p.iut_sha256}, rs1-cells.json ${p.cells_sha256}, filled manifest ${p.manifest_sha256}, ${p.receipt_files} receipt files ${p.receipt_files_sha256}.`, ''].join('\n');
}

function main(argv: string[]): number {
  const [mode, ...args] = argv;
  if (mode !== 'verdict' && mode !== 'pilot' && mode !== 'aggregates') { process.stderr.write('usage: bun eval/runner/rs1/verdict.ts verdict|pilot|aggregates --receipts <dir>... [--manifest <file>] [--set RS1|RS1-dev2] [--out <dir>]\n'); return 2; }
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
  if (mode === 'aggregates' && set !== 'RS1') { process.stderr.write('aggregates reads set RS1 only\n'); return 2; }
  if (mode === 'aggregates' && !out) { process.stderr.write('aggregates needs --out <custody directory>\n'); return 2; }
  const write = (name: string, json: unknown, md: string) => { if (out) { mkdirSync(out, { recursive: true }); writeFileSync(join(out, `${name}.json`), JSON.stringify(json, null, 2) + '\n'); writeFileSync(join(out, `${name}.md`), md); } process.stdout.write(md); };
  try {
    if (mode === 'verdict') { const a = analyze(loadInput(receipts, { set, manifestPath })); write('verdict', a, markdown(a)); return 0; }
    if (mode === 'aggregates') {
      const g = aggregatesOf(receipts, manifestPath), json = JSON.stringify(g, null, 2) + '\n';
      mkdirSync(out!, { recursive: true });
      writeFileSync(join(out!, 'aggregates.json'), json);
      writeFileSync(join(out!, 'aggregates.md'), aggregatesMarkdown(g));
      process.stdout.write(`RS1 aggregates: verdict ${g.analysis.verdict}; ${g.analysis.conversations} conversations; ${g.analysis.common_questions} of ${g.analysis.planned_questions} planned questions in the common set; aggregates.json SHA-256 ${sha256(json)}\n`);
      return 0;
    }
    const stats = pilotStats(loadInput(receipts, { set: 'RS1', manifestPath, waveA: true }));
    const size = pilotSize(stats.sds, stats.corr);
    const price = size.n_required === null ? null : priceAt(size.n_required);
    const report = { schema: 'gbrain-evals/rs1-pilot/v1', conversations: stats.conversations, comparisons: GATING, sds: stats.sds.map(r4), corr: stats.corr.map(row => row.map(r4)), ...size, price_at_required: price };
    const md = [`# RS1 pilot (wave A, ${stats.conversations} conversations)`, '', '| Gating test | SD |', '|---|---:|', ...GATING.map((k, i) => `| ${k} | ${fmt(stats.sds[i])} |`),
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
