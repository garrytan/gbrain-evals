import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RS1_MANIFEST } from '../../eval/runner/memory-qa/corpus.ts';
import { instrumentFor } from '../../eval/runner/memory-qa/instruments.ts';
import { answerId } from '../../eval/runner/memory-qa/records.ts';
import { runConfigText } from '../../eval/runner/q1/cell.ts';
import { loadRS1Manifest, OPUS, PARTICLE, SOL } from '../../eval/runner/q1/cells/rs1.ts';
import { rereadCellId } from '../../eval/runner/q1/reread-cell.ts';
import { analyze, gatingProblems, loadInput, markdown, pairedRow, readerValue, receiptManifestProblems, verdictMain, VerdictError, type VerdictInput } from '../../eval/runner/rs1/verdict.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const HEX = sha('x');
const INSTRUMENT = 'beam-rs1';
const INST = instrumentFor(INSTRUMENT);
const JUDGE = { [OPUS]: 'openai:gpt-6-astra', [PARTICLE]: 'anthropic:claude-opus-5-5', [SOL]: 'anthropic:claude-opus-5-5' } as Record<string, string>;
const tmp = mkdtempSync(join(tmpdir(), 'rs1-verdict-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const nd = (xs: unknown[]) => xs.map(x => JSON.stringify(x) + '\n').join('');
const conv = (i: number) => `rs1-${String(i + 1).padStart(3, '0')}`;
const cells = loadRS1Manifest().cells;
const cellOf = (system: string) => cells.find(c => c.system === system)!;

interface Opts {
  conversations?: number; perUnit?: number; questions?: number;
  /** Score for a row, reader, conversation index and question index (0..1), or an outcome string. */
  score?: (system: string, reader: string, c: number, q: number) => number | string;
  fill?: Record<string, number>;
  revision?: string; manifestSha?: string; dropReread?: string;
  /** n_final in the filled manifest; defaults to the conversation count when it is 20 to 33, else unset. */
  nFinal?: number | null;
  limit?: number;
  /** Leave a question's row, answers and judgments out of a row's unit while its receipt still schedules it. */
  noRow?: (system: string, c: number, q: number) => boolean;
  /** Edit a unit's run config or receipt before they are written. */
  patch?: (system: string, unit: number, config: Record<string, any>, receipt: Record<string, any>) => void;
  /** Edit a unit's particle-1 re-read receipt before it is written. */
  rereadPatch?: (system: string, unit: number, receipt: Record<string, any>) => void;
  /** Write the unit's meters.ndjson (a reader meter per live answer). */
  meters?: (system: string, unit: number) => boolean;
  /** A question whose retrieval failed: its row records fill_rate null, and its answers are written as cell.ts writes them (no context, zero usage, no reader meter). */
  failedRetrieval?: (system: string, c: number, q: number) => boolean;
  /** A question's ability name in its id (default `ability<q mod 2>`). */
  ability?: (q: number) => string;
}

/** A filled manifest pinning the kept conversations, and receipts for the four RS1 rows plus their particle-1 re-reads. */
function build(name: string, o: Opts = {}) {
  const root = join(tmp, name);
  const nConv = o.conversations ?? 20, perUnit = o.perUnit ?? 5, nQ = o.questions ?? 2;
  const files = Array.from({ length: nConv }, (_, i) => [`conversations/c${conv(i).slice(4)}/beam/1/chat.json`, `conversations/c${conv(i).slice(4)}/beam/1/probing_questions/probing_questions.json`]).flat().map(p => ({ path: p, sha256: sha(p) }));
  const manifest = { dataset: 'beam-rs1', status: 'filled', layout: 'x', note: 'x', files, filled_at: '2026-11-20T00:00:00Z', kept: Array.from({ length: nConv }, (_, i) => conv(i)), earlier_fills: ['e'.repeat(64)],
    ...((o.nFinal !== undefined ? o.nFinal : nConv >= 20 && nConv <= 33 ? nConv : null) !== null ? { n_final: o.nFinal ?? nConv } : {}) };
  const manifestText = JSON.stringify(manifest);
  mkdirSync(root, { recursive: true });
  const manifestPath = join(root, 'rs1-manifest.json');
  writeFileSync(manifestPath, manifestText);
  const score = o.score ?? ((system: string) => (system === 'baseline-none' ? 0.3 : 0.7));
  const qid = (c: number, q: number) => `${conv(c)}:${o.ability?.(q) ?? `ability${q % 2}`}:${q}`;
  const units = Math.ceil(nConv / perUnit);
  const dirs: string[] = [];
  for (const system of ['gbrain-defaults', 'ext-memory-bank', 'ext-extract-first', 'baseline-none']) {
    const def = cellOf(system);
    const armCell = def.arms[0].cell_id;
    const frontier = system !== 'baseline-none';
    for (let u = 0; u < units; u++) {
      const convs = Array.from({ length: perUnit }, (_, k) => u * perUnit + k).filter(i => i < nConv);
      const out = join(root, `${system}-u${u}`);
      const dir = join(out, 'cells', armCell);
      mkdirSync(dir, { recursive: true });
      dirs.push(out);
      const config = sha(`${armCell}|${u}`);
      const scheduledQids = convs.flatMap(c => Array.from({ length: nQ }, (_, q) => [c, q] as const));
      const qids = scheduledQids.filter(([c, q]) => !o.noRow?.(system, c, q));
      const rows = qids.map(([c, q]) => ({ id: qid(c, q), conversation: conv(c), cell_id: armCell, realization_id: 'r', fill_rate: o.failedRetrieval?.(system, c, q) ? null : o.fill?.[system] ?? 0.95, delivered_tokens: { cl100k_base: 7600 }, packing_loss: null, provenance_status: 'exact', fanout: { mean: 1, max: 1 } }));
      const answersFor = (cellId: string, readers: string[]) => readers.flatMap(reader => qids.map(([c, q]) => {
        const question_id = qid(c, q);
        if (o.failedRetrieval?.(system, c, q)) return { answer: { answer_id: answerId(cellId, question_id, reader, 0), cell_id: cellId, realization_id: 'r', question_id, conversation: conv(c), system, arm: 'b8000', reader, replicate: 0, effort: 'medium', context_sha256: sha('no-context|retrieval_error'), text: '', usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, provider_input_tokens: null, latency_ms: 0, outcome: 'retrieval_error' }, score: 'retrieval_error' as number | string };
        const s = score(system, reader, c, q);
        return { answer: { answer_id: answerId(cellId, question_id, reader, 0), cell_id: cellId, realization_id: 'r', question_id, conversation: conv(c), system, arm: 'b8000', reader, replicate: 0, effort: 'medium', context_sha256: HEX, text: 'a', usage: { input: 1, output: 1, cache_read: 0, cache_write: 0 }, provider_input_tokens: 1, latency_ms: 1, outcome: typeof s === 'string' ? s : 'scored' }, score: s };
      }));
      const judgmentsFor = (xs: ReturnType<typeof answersFor>) => xs.flatMap(({ answer, score: s }) => typeof s === 'string' ? [] : [
        { answer_id: answer.answer_id, instrument_id: INSTRUMENT, instrument_sha256: HEX, judge: 'openai:gpt-4.1-mini', judge_replicate: 0, temperature: 0, score: s, parse_ok: true, raw_sha256: HEX, outcome: 'scored' },
        ...(frontier ? [{ answer_id: answer.answer_id, instrument_id: `${INSTRUMENT}@${JUDGE[answer.reader]}`, instrument_sha256: HEX, judge: JUDGE[answer.reader], judge_replicate: 0, temperature: 0, score: Math.min(1, Math.max(0, s + (parseInt(answer.answer_id.slice(0, 4), 16) / 65535 - 0.5) * 0.04)), parse_ok: true, raw_sha256: HEX, outcome: 'scored', view: 'gating', settings: { effort: 'medium', max_tokens: 8000 }, judge_versions: [`${JUDGE[answer.reader].split(':')[1]}-2026-10-01`] }] : []),
      ]);
      const live = answersFor(armCell, [OPUS, SOL]);
      writeFileSync(join(dir, 'rows.ndjson'), nd(rows));
      writeFileSync(join(dir, 'answers.ndjson'), nd(live.map(x => x.answer)));
      writeFileSync(join(dir, 'judgments.ndjson'), nd(judgmentsFor(live)));
      const dataset = { revision: o.revision ?? 'abcdef0', files: [{ path: RS1_MANIFEST, sha256: o.manifestSha ?? sha(manifestText) }, ...files.filter(f => convs.some(c => f.path.includes(`c${conv(c).slice(4)}/`)))] };
      const runConfig = JSON.parse(runConfigText(def, def.arms[0], { instrument: INST, dataset: dataset as never, scheduledSha: sha(`${armCell}|${u}|scheduled`), limit: o.limit ?? null }));
      const receipt: Record<string, any> = { schema: 'cell', cell_id: armCell, run_cell: def.id, config_sha256: config, run_status: 'complete', instrument: { id: INST.id, sha256: INST.sha256 },
        selection: { questions: scheduledQids.length, conversations: convs.length, scheduled_sha256: HEX }, spend: { usd: { ingest: 1, retrieval: 0.1, reader: 2, judge: 1, background_tail: 0 } } };
      o.patch?.(system, u, runConfig, receipt);
      writeFileSync(join(dir, 'run-config.json'), JSON.stringify(runConfig, null, 2) + '\n');
      writeFileSync(join(dir, 'receipt.json'), JSON.stringify(receipt));
      if (o.meters?.(system, u)) {
        mkdirSync(join(out, 'runs', def.id), { recursive: true });
        writeFileSync(join(out, 'runs', def.id, 'meters.ndjson'), nd(live.filter(x => x.answer.context_sha256 === HEX).map(x => ({ phase: 'reader', key: `read:${x.answer.answer_id.slice(0, 16)}`, usd: 0.01 }))));
      }
      if (o.dropReread === system && u === 0) continue;
      const rid = rereadCellId(armCell, PARTICLE);
      const rdir = join(out, 'cells', rid);
      mkdirSync(rdir, { recursive: true });
      const reread = answersFor(rid, [PARTICLE]);
      writeFileSync(join(rdir, 'answers.ndjson'), nd(reread.map(x => x.answer)));
      writeFileSync(join(rdir, 'judgments.ndjson'), nd(judgmentsFor(reread)));
      const rereadReceipt: Record<string, any> = { schema: 'reread', cell_id: rid, run_status: 'complete', keyless: false, source: { arm_cell_id: armCell, config_sha256s: [config] }, dataset, instrument: { id: INST.id, sha256: INST.sha256 }, spend: { reader_usd: 0.5 } };
      o.rereadPatch?.(system, u, rereadReceipt);
      writeFileSync(join(rdir, 'receipt.json'), JSON.stringify(rereadReceipt));
    }
  }
  return { root, dirs, manifestPath, manifestText };
}
const load = (b: ReturnType<typeof build>, waveA = false) => loadInput(b.dirs, { set: 'RS1', manifestPath: b.manifestPath, waveA });

describe('verdict.ts reader values', () => {
  test('a missing bridge judgment keeps the gating value; a missing gating judgment drops; the floor needs its bridge judgment', () => {
    const a = { answer_id: 'a1', reader: SOL, outcome: 'scored' as const };
    const gating = `a1|${INSTRUMENT}@anthropic:claude-opus-5-5`;
    expect(readerValue(a, new Map([[gating, 0.5]]), INSTRUMENT)).toEqual({ frontier: 0.5, bridge: null });
    expect(readerValue(a, new Map([[gating, 0.5], [`a1|${INSTRUMENT}`, 1]]), INSTRUMENT)).toEqual({ frontier: 0.5, bridge: 1 });
    expect(readerValue(a, new Map([[`a1|${INSTRUMENT}`, 1]]), INSTRUMENT)).toEqual({ drop: 'judgment_missing:frontier' });
    expect(readerValue(a, new Map([[`a1|${INSTRUMENT}@openai:gpt-6.1-sol`, 1], [`a1|${INSTRUMENT}`, 1]]), INSTRUMENT)).toEqual({ drop: 'judgment_missing:frontier' });
    expect(readerValue(a, new Map([[gating, 0.5]]), INSTRUMENT, true)).toEqual({ drop: 'judgment_missing:bridge' });
  });
});

describe('verdict.ts gating judgments', () => {
  // Value: protects=a gating view graded by two snapshots of one judge is visible; fails_when=a provider rolls a judge's snapshot mid-campaign and the verdict reads both without a word; why_new=eng review F10 / scoped-review open item 7 (GST-1886), f5; seam=none; no_claim=a refusal (it flags and reports)
  test('each gating judge\'s returned versions are reported, and a judge that returned two snapshots is flagged at the top of the report', () => {
    const clean = analyze(load(build('snap-clean')));
    expect(clean.judge_snapshots).toEqual([
      { judge: 'anthropic:claude-opus-5-5', versions: ['claude-opus-5-5-2026-10-01'], mixed: false },
      { judge: 'openai:gpt-6-astra', versions: ['gpt-6-astra-2026-10-01'], mixed: false },
    ]);
    expect(markdown(clean)).not.toContain('Mixed judge snapshots');
    const b = build('snap-mixed');
    const file = join(b.root, 'gbrain-defaults-u0', 'cells', cellOf('gbrain-defaults').arms[0].cell_id, 'judgments.ndjson');
    const recs = readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    recs.find(j => j.judge === 'openai:gpt-6-astra').judge_versions = ['gpt-6-astra-2026-11-05'];
    writeFileSync(file, nd(recs));
    const mixed = analyze(load(b));
    expect(mixed.judge_snapshots.find(s => s.judge === 'openai:gpt-6-astra')).toEqual({ judge: 'openai:gpt-6-astra', versions: ['gpt-6-astra-2026-10-01', 'gpt-6-astra-2026-11-05'], mixed: true });
    expect(mixed.judge_snapshots.find(s => s.judge === 'anthropic:claude-opus-5-5')!.mixed).toBe(false);
    expect(mixed.verdict).toBe(clean.verdict);
    expect(markdown(mixed)).toContain('**Mixed judge snapshots in the gating view:** openai:gpt-6-astra returned gpt-6-astra-2026-10-01, gpt-6-astra-2026-11-05.');
  });

  const good = { answer_id: HEX, instrument_id: `${INSTRUMENT}@openai:gpt-6-astra`, judge: 'openai:gpt-6-astra', outcome: 'scored' as const, view: 'gating' as const, settings: { effort: 'medium', max_tokens: 8000 }, judge_versions: ['gpt-6-astra-2026-10-01'] };
  test('a gating judgment by the mapped judge, in the gating view, at the pinned settings, with a model version, counts', () => {
    expect(gatingProblems(good, OPUS, INSTRUMENT)).toEqual([]);
    expect(gatingProblems({ ...good, instrument_id: INSTRUMENT, judge: 'openai:gpt-4.1-mini', view: undefined, settings: undefined, judge_versions: undefined }, SOL, INSTRUMENT)).toEqual([]);
  });
  test('a same-family, unmapped, unrecorded or unpinned gating judgment refuses', () => {
    const sol = { ...good, instrument_id: `${INSTRUMENT}@openai:gpt-6.1-sol`, judge: 'openai:gpt-6.1-sol' };
    expect(gatingProblems(sol, OPUS, INSTRUMENT).join('\n')).toContain('not its mapped judge openai:gpt-6-astra');
    expect(gatingProblems(good, SOL, INSTRUMENT).join('\n')).toContain('a judge of its own family');
    expect(gatingProblems({ ...good, view: undefined }, OPUS, INSTRUMENT).join('\n')).toContain('does not record the gating view');
    expect(gatingProblems({ ...good, settings: { effort: 'high', max_tokens: 8000 } }, OPUS, INSTRUMENT).join('\n')).toContain('not the pinned');
    expect(gatingProblems({ ...good, judge_versions: [] }, OPUS, INSTRUMENT).join('\n')).toContain('no judge model version');
  });
});

describe('verdict.ts paired reporting', () => {
  test('a paired row gives the conversation-mean difference, hand-computed 95% and 90% t intervals and the lower, higher and tied counts', () => {
    const pairs = [{ conversation: 'c1', d: -2 }, { conversation: 'c1', d: 0 }, { conversation: 'c2', d: 4 }, { conversation: 'c3', d: 1 }, { conversation: 'c3', d: 3 }];
    const p = pairedRow({ server: 'memory-bank', view: 'frontier', subset: 'overall' }, pairs);
    // conversation means -1, 4, 2: mean 5/3, SD sqrt(19/3), SE sqrt(19/9); t(0.975, 2) = 4.3027, t(0.95, 2) = 2.9200
    expect([p.conversations, p.questions, p.lower, p.higher, p.tied]).toEqual([3, 5, 1, 3, 1]);
    expect(p.mean).toBeCloseTo(1.6667, 4);
    expect(p.ci95![0]).toBeCloseTo(5 / 3 - 4.3027 * Math.sqrt(19 / 9), 2);
    expect(p.ci95![1]).toBeCloseTo(5 / 3 + 4.3027 * Math.sqrt(19 / 9), 2);
    expect(p.ci90![0]).toBeCloseTo(5 / 3 - 2.92 * Math.sqrt(19 / 9), 2);
    expect(p.reading).toBe('no measurable difference');
    const low = pairedRow({ server: 'extract-first', view: 'bridge', subset: 'overall' }, [{ conversation: 'a', d: -5 }, { conversation: 'b', d: -6 }, { conversation: 'c', d: -4 }]);
    expect([low.reading, low.lower, low.higher]).toEqual(['gbrain lower', 3, 0]);
    expect(pairedRow({ server: 'memory-bank', view: 'frontier', subset: 'reader x' }, pairs, 5).reading).toBe('too few conversations');
  });

  test('every comparison is reported paired, overall, per reader and per ability, under both views, with "no measurable difference" in the table', () => {
    const v = (x: number) => ({ frontier: x, bridge: x });
    const questions: VerdictInput['questions'] = [];
    for (let c = 0; c < 6; c++) for (let i = 0; i < 4; i++) {
      const g = 0.5 + ((c + i) % 3) / 10, s = 0.5 + ((c * 2 + i) % 3) / 10;
      questions.push({ id: `c${c}:ab${i % 2}:${i}`, conversation: `c${c}`, rows: { gbrain: Object.fromEntries([OPUS, SOL, PARTICLE].map(r => [r, v(g)])), 'memory-bank': Object.fromEntries([OPUS, SOL, PARTICLE].map(r => [r, v(s)])), 'extract-first': Object.fromEntries([OPUS, SOL, PARTICLE].map(r => [r, v(s)])) } });
    }
    const a = analyze({ set: 'RS1', questions, floor: [], fill: { gbrain: 0.95, 'memory-bank': 0.95, 'extract-first': 0.95 }, costs: [] });
    const subsets = [...new Set(a.paired.map(p => p.subset))];
    expect(subsets).toEqual(['overall', `reader ${OPUS}`, `reader ${SOL}`, `reader ${PARTICLE}`, 'ability ab0', 'ability ab1']);
    expect(a.paired).toHaveLength(2 * 2 * 6);
    const overall = a.paired.find(p => p.server === 'memory-bank' && p.view === 'frontier' && p.subset === 'overall')!;
    expect(overall.lower + overall.higher + overall.tied).toBe(24);
    expect(overall.ci90).not.toBeNull();
    expect(markdown(a)).toContain('| memory-bank | gating | overall | 6 | 24 |');
    expect(markdown(a)).toContain('gbrain lower / higher / tied');
  });
});

describe('verdict.ts receipts', () => {
  test('reads every row, reader and judge view, and passes when gbrain matches both servers', () => {
    const a = analyze(load(build('ok')));
    expect(a.verdict).toBe('pass');
    expect(a.conversations).toBe(20);
    expect(a.planned_questions).toBe(40);
    expect(a.common_questions).toBe(40);
    expect(a.tests.map(t => t.key)).toEqual(['memory-bank/frontier', 'memory-bank/bridge', 'extract-first/frontier', 'extract-first/bridge']);
    expect(a.floor).toEqual({ questions: 40, mean_bridge: 30, below_every_system_row: true });
    expect([...new Set(a.table.map(t => t.reader))]).toEqual([OPUS, PARTICLE, SOL]);
    const opusGbrain = a.table.find(t => t.reader === OPUS && t.row === 'gbrain')!;
    expect(opusGbrain.bridge.accuracy).toBe(70);
    expect(a.per_ability.map(x => x.ability)).toContain('ability1');
  });

  test('refuses an unfilled manifest, an unfilled dataset revision and a foreign manifest SHA-256; accepts an earlier fill', () => {
    const b = build('unfilled-rev', { revision: 'unfilled' });
    expect(() => load(b)).toThrow(/dataset revision is unfilled/);
    expect(() => load(build('foreign', { manifestSha: 'f'.repeat(64) }))).toThrow(/not the filled manifest's/);
    expect(() => load(build('earlier', { manifestSha: 'e'.repeat(64) }))).not.toThrow();
    const ok = build('unfilled-manifest');
    writeFileSync(ok.manifestPath, JSON.stringify({ ...JSON.parse(ok.manifestText), status: 'unfilled' }));
    expect(() => load(ok)).toThrow(/unfilled/);
    const m = JSON.parse(ok.manifestText);
    expect(receiptManifestProblems({ dataset: { revision: 'x', files: [{ path: RS1_MANIFEST, sha256: 'a'.repeat(64) }, { path: 'conversations/c001/beam/1/chat.json', sha256: 'b'.repeat(64) }] } }, m, 'a'.repeat(64))).toEqual([expect.stringContaining('the manifest pins')]);
  });

  test('refuses a row with a missing particle-1 re-read', () => {
    expect(() => load(build('no-reread', { dropReread: 'ext-memory-bank' }))).toThrow(/missing particle-1 re-read/);
    expect(() => load(build('no-reread-floor', { dropReread: 'baseline-none' }))).toThrow(VerdictError);
  });

  test('a verdict refuses receipts that do not hold exactly the first n_final kept conversations, and a manifest with no n_final', () => {
    const b = build('kept-gap');
    expect(() => loadInput(b.dirs.filter(d => !d.endsWith('-u3')), { set: 'RS1', manifestPath: b.manifestPath })).toThrow(/exactly the first 20 kept conversations; missing rs1-016, rs1-017, rs1-018, rs1-019, rs1-020/);
    expect(() => load(build('no-n-final', { nFinal: null }))).toThrow(/kept list is not final \(n_final unset/);
    expect(() => load(build('short-kept', { conversations: 20, nFinal: 21 }))).toThrow(/kept list is not final \(n_final 21, 20 kept\)/);
  });

  test('refuses a unit run with --limit and a question no system row holds; a row missing in one row is a row_missing drop on its side', () => {
    expect(() => load(build('limit', { limit: 10 }))).toThrow(/ran with --limit 10/);
    expect(() => load(build('no-row-anywhere', { noRow: (s, c, q) => s !== 'baseline-none' && c === 0 && q === 0 }))).toThrow(/scheduled 40 questions and only 39 have a row in any system row/);
    const one = analyze(load(build('no-row-mb', { noRow: (s, c, q) => s === 'ext-memory-bank' && c < 2 && q === 0 })));
    expect(one.planned_questions).toBe(40);
    expect(one.common_questions).toBe(38);
    expect(one.drops).toEqual({ 'server|row_missing': 6 });
    expect(one.verdict).toBe('pass');
  });

  test('refuses two re-reads of one arm that hold the same conversation', () => {
    const b = build('reread-overlap');
    const rid = rereadCellId(cellOf('ext-extract-first').arms[0].cell_id, PARTICLE);
    const dup = join(b.root, 'reread-again');
    cpSync(join(b.root, 'ext-extract-first-u1', 'cells', rid), join(dup, 'cells', rid), { recursive: true });
    expect(() => loadInput([...b.dirs, dup], { set: 'RS1', manifestPath: b.manifestPath })).toThrow(/conversation rs1-006 is re-read in both/);
  });

  test('refuses receipts whose gating judgment was made under the pre-R78 mapping (gpt-6.1-sol on claude-opus-5-5 rows)', () => {
    const b = build('old-mapping');
    const fs = require('node:fs') as typeof import('node:fs');
    const file = b.dirs.flatMap(d => fs.readdirSync(join(d, 'cells')).sort().map(c => join(d, 'cells', c, 'judgments.ndjson')))
      .find(f => f.includes('gbrain-defaults') && fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes('"judge":"openai:gpt-6-astra"'))!;
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    const i = lines.findIndex(j => j.judge === 'openai:gpt-6-astra');
    expect(i).toBeGreaterThanOrEqual(0);
    lines[i] = { ...lines[i], judge: 'openai:gpt-6.1-sol', instrument_id: `${INSTRUMENT}@openai:gpt-6.1-sol` };
    fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    expect(() => load(b)).toThrow(/not its mapped judge openai:gpt-6-astra/);
  });

  test('refuses a unit whose run config or instrument differs from the committed definition; launch-control fields may differ', () => {
    const gbrainSha = (system: string, u: number, config: Record<string, any>) => { if (system === 'gbrain-defaults' && u === 1) config.cell.launch.env.GBRAIN_SHA = '0'.repeat(40); };
    expect(() => load(build('config-sha', { patch: gbrainSha }))).toThrow(/differs from rs1.gbrain-defaults.rs1-stable in the committed rs1-cells.json at cell.launch.env.GBRAIN_SHA/);
    const judged = (system: string, u: number, _c: Record<string, any>, receipt: Record<string, any>) => { if (system === 'ext-memory-bank' && u === 2) receipt.instrument.sha256 = 'f'.repeat(64); };
    expect(() => load(build('instrument', { patch: judged }))).toThrow(/judged under instrument beam-rs1 \(ffffffffffff\)/);
    const shards = (system: string, u: number, config: Record<string, any>) => { if (u === 0) config.cell.shards = 99; };
    expect(analyze(load(build('launch-control', { patch: shards }))).verdict).toBe('pass');
  });

  test('refuses a keyless or invalid particle-1 re-read', () => {
    expect(() => load(build('reread-keyless', { rereadPatch: (s, u, r) => { if (s === 'gbrain-defaults' && u === 2) r.keyless = true; } }))).toThrow(/is not a paid re-read \(keyless true\)/);
    expect(() => load(build('reread-unrecorded', { rereadPatch: (s, u, r) => { if (s === 'baseline-none' && u === 0) delete r.keyless; } }))).toThrow(/keyless unrecorded/);
    expect(() => load(build('reread-invalid', { rereadPatch: (s, u, r) => { if (s === 'ext-memory-bank' && u === 1) { r.run_status = 'invalid'; r.invalid_reasons = ['contexts changed']; } } }))).toThrow(/is invalid: contexts changed/);
  });

  test('pilot mode refuses a kept list shorter than wave A', () => {
    const short = build('pilot-short', { conversations: 15 });
    expect(() => load(short, true)).toThrow(/needs the first 20 kept conversations \(wave A\), and the kept list holds 15/);
  });

  test('a failed retrieval counts as 0 delivered tokens in the delivered-context gate', () => {
    const a = analyze(load(build('fill-failed', { failedRetrieval: (s, c, q) => s === 'gbrain-defaults' && c < 4 && q === 0 })));
    expect(a.gate.find(g => g.row === 'gbrain')).toEqual({ row: 'gbrain', fill_rate: 0.855, pass: false });
    expect(a.tests.every(t => !t.valid)).toBe(true);
  });

  test('a row whose units are not all metered reports n/a cost per question', () => {
    const all = analyze(load(build('meters-all', { meters: () => true })));
    expect(all.table.find(t => t.reader === OPUS && t.row === 'gbrain')!.usd_per_question).toBe(0.12);
    const part = analyze(load(build('meters-part', { meters: (s, u) => !(s === 'gbrain-defaults' && u > 0) })));
    const row = part.table.find(t => t.reader === OPUS && t.row === 'gbrain')!;
    expect(row.usd_per_question).toBeNull();
    expect(row.frontier.usd_per_correct).toBeNull();
    expect(part.table.find(t => t.reader === OPUS && t.row === 'memory-bank')!.usd_per_question).toBe(0.12);
    expect(markdown(part)).toContain('| anthropic:claude-opus-5-5 | gbrain | n/a |');
    const reread = analyze(load(build('meters-reread', { meters: () => true, rereadPatch: (s, u, r) => { if (s === 'gbrain-defaults' && u === 0) delete r.spend; } })));
    expect(reread.table.find(t => t.reader === PARTICLE && t.row === 'gbrain')!.usd_per_question).toBeNull();
  });

  test('a particle-1 re-read receipt is checked against the filled manifest like a unit receipt', () => {
    const refused = (name: string, edit: (r: Record<string, any>) => void) => { try { load(build(name, { rereadPatch: (s, u, r) => { if (s === 'ext-extract-first' && u === 1) edit(r); } })); } catch (e) { if (e instanceof VerdictError) return e.message; throw e; } return 'accepted'; };
    expect(refused('reread-no-dataset', r => { delete r.dataset; })).toContain('it records no dataset');
    expect(refused('reread-unfilled', r => { r.dataset = { ...r.dataset, revision: 'unfilled' }; })).toContain('its dataset revision is unfilled');
    expect(refused('reread-foreign', r => { r.dataset = { ...r.dataset, files: [{ path: RS1_MANIFEST, sha256: 'f'.repeat(64) }, ...r.dataset.files.slice(1)] }; })).toContain('is not the filled manifest');
    expect(refused('reread-bytes', r => { r.dataset = { ...r.dataset, files: [r.dataset.files[0], { ...r.dataset.files[1], sha256: 'f'.repeat(64) }] }; })).toContain('the manifest pins');
    expect(refused('reread-ok', () => {})).toBe('accepted');
  });

  test('a unit where every retrieval failed for a reader prices that reader\'s spend there at $0, not n/a', () => {
    const a = analyze(load(build('meters-failed-unit', { meters: () => true, failedRetrieval: (s, c) => s === 'ext-memory-bank' && c < 5 })));
    const row = a.table.find(t => t.reader === OPUS && t.row === 'memory-bank')!;
    expect(row.usd_per_question).toBe(0.1175);
    expect(markdown(a)).toContain('| anthropic:claude-opus-5-5 | memory-bank | 0.1175 |');
    const missing = analyze(load(build('meters-failed-missing', { meters: (s, u) => !(s === 'ext-memory-bank' && u === 1), failedRetrieval: (s, c) => s === 'ext-memory-bank' && c < 5 })));
    expect(missing.table.find(t => t.reader === OPUS && t.row === 'memory-bank')!.usd_per_question).toBeNull();
  });

  test('a product failure scores 0 and stays; harness drops over 5% make the gating comparisons invalid', () => {
    const product = analyze(load(build('product', { score: (s, r, c, q) => (s === 'gbrain-defaults' && c === 0 && q === 0 ? 'retrieval_error' : s === 'baseline-none' ? 0.3 : 0.7) })));
    expect(product.common_questions).toBe(40);
    expect(product.tests[0].estimate).toBeLessThan(0);
    const harness = analyze(load(build('harness', { score: (s, r, c, q) => (s === 'ext-extract-first' && r === SOL && c < 3 && q === 0 ? 'reader_error' : s === 'baseline-none' ? 0.3 : 0.7) })));
    expect(harness.common_questions).toBe(37);
    expect(harness.drops).toEqual({ 'server|reader_error': 3 });
    expect(harness.verdict).toBe('invalid');
    expect(harness.tests.map(t => [t.key, t.gating, t.valid])).toEqual([['memory-bank/frontier', true, false], ['memory-bank/bridge', false, true], ['extract-first/frontier', true, false], ['extract-first/bridge', false, true]]);
  });

  test('a row failing the delivered-context gate makes every comparison it enters descriptive', () => {
    const server = analyze(load(build('gate-mb', { fill: { 'ext-memory-bank': 0.85 } })));
    expect(server.verdict).toBe('invalid');
    expect(server.tests.map(t => t.valid)).toEqual([false, false, true, true]);
    expect(server.tests[0].invalid_reasons[0]).toContain('delivered-context gate');
    const gbrain = analyze(load(build('gate-gbrain', { fill: { 'gbrain-defaults': 0.89 } })));
    expect(gbrain.tests.every(t => !t.valid)).toBe(true);
  });

  test('flags a worst-case sensitivity that disagrees with the verdict', () => {
    const score = (s: string, r: string, c: number, q: number) => (s === 'gbrain-defaults' && r === PARTICLE && q === 1 ? 'judge_error' : s === 'baseline-none' ? 0.3 : 0.7);
    const a = analyze(load(build('worst', { score, questions: 20 })));
    expect(a.drop_share).toBe(0.05);
    expect(a.verdict).toBe('pass');
    expect(a.drops).toEqual({ 'gbrain|judge_error': 20 });
    expect(a.worst_case.verdict).toBe('fail');
    expect(a.worst_case.disagrees).toBe(true);
    expect(markdown(a)).toContain('worst-case sensitivity disagrees');
  });

  test('pilot mode emits SDs and correlations, no means, and N_final', () => {
    const b = build('pilot', { score: (s, r, c, q) => (s === 'baseline-none' ? 0.3 : 0.5 + ((c * 7 + q * 3 + ({ 'gbrain-defaults': 0, 'ext-memory-bank': 2, 'ext-extract-first': 3 } as Record<string, number>)[s]) % 5) / 100) });
    const out = join(tmp, 'pilot-out');
    expect(verdictMain(['pilot', '--receipts', ...b.dirs, '--manifest', b.manifestPath, '--out', out])).toBe(0);
    const report = JSON.parse(require('node:fs').readFileSync(join(out, 'pilot.json'), 'utf8'));
    const keys: string[] = [];
    const walk = (x: unknown) => { if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) { keys.push(k); walk(v); } };
    walk(report);
    expect(keys.filter(k => /mean|estimate|lower|accuracy/i.test(k))).toEqual([]);
    expect(report.comparisons).toEqual(['memory-bank/frontier', 'extract-first/frontier']);
    expect(report.sds).toHaveLength(2);
    expect(report.corr).toHaveLength(2);
    expect(report.n_final).toBe(20);
  }, 60_000);

  test('pilot mode exits 3 with RS1_PILOT_OVER_CAP when N_required is above 33', () => {
    const b = build('pilot-wide', { score: (s, r, c, q) => (s === 'baseline-none' ? 0.3 : s === 'gbrain-defaults' ? ((c * 13 + q * 5) % 7) / 6 : ((c * 11 + q * 3 + s.length) % 7) / 6) });
    const run = Bun.spawnSync(['bun', 'eval/runner/rs1/verdict.ts', 'pilot', '--receipts', ...b.dirs, '--manifest', b.manifestPath], { cwd: join(import.meta.dir, '..', '..') });
    expect(run.stderr.toString()).toContain('RS1_PILOT_OVER_CAP');
    expect(run.exitCode).toBe(3);
  }, 120_000);

  test('pilot mode reads wave A only and refuses a missing wave A conversation', () => {
    const more = build('pilot-25', { conversations: 25 });
    expect(new Set(load(more, true).questions.map(q => q.conversation)).size).toBe(20);
    const few = build('pilot-15', { conversations: 15 });
    writeFileSync(few.manifestPath, JSON.stringify({ ...JSON.parse(few.manifestText), kept: Array.from({ length: 20 }, (_, i) => conv(i)), files: [...JSON.parse(few.manifestText).files, ...Array.from({ length: 5 }, (_, i) => [`conversations/c${conv(15 + i).slice(4)}/beam/1/chat.json`, `conversations/c${conv(15 + i).slice(4)}/beam/1/probing_questions/probing_questions.json`]).flat().map(p => ({ path: p, sha256: sha(p) }))] }));
    expect(() => loadInput(few.dirs, { set: 'RS1', manifestPath: few.manifestPath, waveA: true })).toThrow();
  });
});

describe('verdict.ts aggregates mode (the final custody run)', () => {
  const ROOT = join(import.meta.dir, '..', '..');
  const ABILITIES = ['abstention', 'contradiction_resolution', 'event_ordering', 'information_extraction', 'instruction_following', 'knowledge_update', 'multi_session_reasoning', 'preference_following', 'summarization', 'temporal_reasoning'];
  const beam = (q: number) => ABILITIES[q % ABILITIES.length];
  const fileSha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
  /** verdictMain in-process, with what it printed. */
  const run = (argv: string[]) => {
    const out: string[] = [], err: string[] = [];
    const [o, e] = [process.stdout.write, process.stderr.write];
    process.stdout.write = ((s: string | Uint8Array) => { out.push(String(s)); return true; }) as typeof o;
    process.stderr.write = ((s: string | Uint8Array) => { err.push(String(s)); return true; }) as typeof e;
    try { return { code: verdictMain(argv), stdout: out.join(''), stderr: err.join('') }; } finally { process.stdout.write = o; process.stderr.write = e; }
  };

  test('writes verdict mode\'s analysis unchanged with what it was computed from, nothing per question or conversation, and prints only the verdict, counts and the file\'s SHA-256', () => {
    const b = build('agg', { ability: beam, questions: 3, meters: () => true });
    const vOut = join(tmp, 'agg-verdict'), aOut = join(tmp, 'agg-out');
    expect(run(['verdict', '--receipts', ...b.dirs, '--manifest', b.manifestPath, '--out', vOut]).code).toBe(0);
    const r = run(['aggregates', '--receipts', ...b.dirs, '--manifest', b.manifestPath, '--out', aOut]);
    expect(r.code).toBe(0);
    const text = readFileSync(join(aOut, 'aggregates.json'), 'utf8');
    const g = JSON.parse(text);
    expect(g.schema).toBe('gbrain-evals/rs1-aggregates/v1');
    expect(g.analysis).toEqual(JSON.parse(readFileSync(join(vOut, 'verdict.json'), 'utf8')));
    expect(g.analysis.verdict).toBe('pass');
    expect(r.stdout).toBe(`RS1 aggregates: verdict pass; 20 conversations; 60 of 60 planned questions in the common set; aggregates.json SHA-256 ${sha(text)}\n`);
    expect(r.stderr).toBe('');
    const digests = b.dirs.flatMap(d => (readdirSync(d, { recursive: true }) as string[]).filter(f => statSync(join(d, f)).isFile()).map(f => `${f}\t${fileSha(join(d, f))}`)).sort();
    expect(g.provenance).toEqual({
      code_commit: Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: ROOT }).stdout.toString().trim(), tracked_tree_clean: expect.any(Boolean),
      verdict_sha256: fileSha(join(ROOT, 'eval/runner/rs1/verdict.ts')), iut_sha256: fileSha(join(ROOT, 'eval/runner/rs1/iut.ts')), cells_sha256: fileSha(join(ROOT, 'eval/runner/q1/cells/rs1-cells.json')),
      manifest_sha256: sha(b.manifestText), receipt_files: digests.length, receipt_files_sha256: sha(digests.join('\n')),
    });
    expect(g.provenance.code_commit).toMatch(/^[0-9a-f]{40}$/);
    const strings: string[] = [], keys: string[] = [];
    const walk = (x: unknown) => { if (typeof x === 'string') strings.push(x); else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) { keys.push(k); walk(v); } };
    walk(g.analysis);
    expect(strings.filter(s => /rs1-\d{3}|[0-9a-f]{12}/.test(s))).toEqual([]);
    expect(keys.filter(k => /^(question|question_id|conversation|answer_id|text)$/.test(k))).toEqual([]);
    expect(new Set(g.analysis.per_ability.map((x: { ability: string }) => x.ability))).toEqual(new Set(ABILITIES.slice(0, 3)));
    expect(readFileSync(join(aOut, 'aggregates.md'), 'utf8')).toContain(`## Provenance\n\nCode ${g.provenance.code_commit}`);
  }, 60_000);

  const refused = (out: string, kind: string) => `verdict.ts aggregates refused (${kind}); the reason stays in custody in ${join(out, 'aggregates-refusal.txt')}\n`;
  const reason = (out: string) => readFileSync(join(out, 'aggregates-refusal.txt'), 'utf8');

  test('refuses an ability outside BEAM\'s ten and a version that is not its judge\'s, writing nothing, removing an earlier run\'s files and never echoing the value', () => {
    const odd = build('agg-ability', { ability: q => (q === 1 ? 'paris_is_the_capital' : beam(q)) });
    const out1 = join(tmp, 'agg-ability-out');
    mkdirSync(out1, { recursive: true });
    writeFileSync(join(out1, 'aggregates.json'), '{}');
    const r1 = run(['aggregates', '--receipts', ...odd.dirs, '--manifest', odd.manifestPath, '--out', out1]);
    expect(r1.code).toBe(1);
    expect(r1.stdout).toBe('');
    expect(r1.stderr).toBe(refused(out1, 'VerdictError'));
    expect(reason(out1)).toContain('outside the aggregate vocabulary');
    expect(reason(out1)).not.toContain('paris');
    expect(existsSync(join(out1, 'aggregates.json'))).toBe(false);
    const pv = build('agg-version', { ability: beam });
    const file = join(pv.root, 'gbrain-defaults-u0', 'cells', cellOf('gbrain-defaults').arms[0].cell_id, 'judgments.ndjson');
    const recs = readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    recs.find(j => j.view === 'gating').judge_versions = ['Paris'];
    writeFileSync(file, nd(recs));
    const out2 = join(tmp, 'agg-version-out');
    const r2 = run(['aggregates', '--receipts', ...pv.dirs, '--manifest', pv.manifestPath, '--out', out2]);
    expect(r2.code).toBe(1);
    expect(r2.stderr).toBe(refused(out2, 'VerdictError'));
    expect(reason(out2)).toContain('not a model version of its judge');
    expect(reason(out2)).not.toContain('Paris');
    expect(existsSync(join(out2, 'aggregates.json'))).toBe(false);
  }, 60_000);

  test('refuses before the kept list is final, outside set RS1 and without --out', () => {
    const early = build('agg-early', { ability: beam, nFinal: null });
    const out = join(tmp, 'agg-early-out');
    const r = run(['aggregates', '--receipts', ...early.dirs, '--manifest', early.manifestPath, '--out', out]);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(refused(out, 'VerdictError'));
    expect(reason(out)).toContain('kept list is not final');
    expect(run(['aggregates', '--receipts', ...early.dirs, '--manifest', early.manifestPath, '--set', 'RS1-dev2', '--out', out]).code).toBe(2);
    expect(run(['aggregates', '--receipts', ...early.dirs, '--manifest', early.manifestPath]).code).toBe(2);
    expect(existsSync(join(out, 'aggregates.json'))).toBe(false);
  }, 60_000);

  test('any other error, such as an unparseable answers line, prints one fixed line and never the text that broke it', () => {
    const b = build('agg-corrupt', { ability: beam });
    const file = join(b.root, 'gbrain-defaults-u0', 'cells', cellOf('gbrain-defaults').arms[0].cell_id, 'answers.ndjson');
    const lines = readFileSync(file, 'utf8').split('\n');
    lines[0] = '{"answer_id": sentinelword}';
    writeFileSync(file, lines.join('\n'));
    const out = join(tmp, 'agg-corrupt-out');
    const r = run(['aggregates', '--receipts', ...b.dirs, '--manifest', b.manifestPath, '--out', out]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe(refused(out, 'Error'));
    expect(r.stderr).not.toContain('sentinelword');
    expect(reason(out)).toStartWith('Error: ');
    expect(existsSync(join(out, 'aggregates.json'))).toBe(false);
  }, 60_000);
});
