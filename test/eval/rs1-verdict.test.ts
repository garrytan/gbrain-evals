/**
 * The frozen RS1 analysis (eval/runner/rs1/verdict.ts): verdict boundaries, the delivered-context gate, the ranking
 * rule, the missing-data rule, Holm's family size, cost per correct answer and the judge-sensitivity block, on
 * synthetic per-question values. Every number here is invented.
 */
import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Publication } from '../../eval/runner/q1/publish.ts';
import { rereadCellId } from '../../eval/runner/q1/reread-cell.ts';
import { seededRandom } from '../../eval/runner/stats/paired.ts';
import {
  analysisSha256, analyze, ARMS, blockProblems, COMPARISON_ALPHA, costPerCorrect, deliveredGate, frozenBlock, INTERVAL_LEVEL, MARGIN_POINTS, OPUS, PARTICLE, positions, rankingClaimed, rereadId, RS1_VERDICT_PATH,
  sensitivitySample, SENSITIVITY_JUDGE, SOL, verdictOf, type ReaderValue, type Rs1Analysis, type Rs1Block, type Rs1CostRow, type Rs1Row,
} from '../../eval/runner/rs1/verdict.ts';

setDefaultTimeout(60_000);

const BLOCK: Rs1Block = { verdict_sha256: 'a'.repeat(64), amendments: [], ...frozenBlock('N') };
const MANIFEST = JSON.parse(readFileSync(resolve(import.meta.dir, '../../eval/runner/q1/cells/rs1-cells.json'), 'utf8')) as {
  judges: Record<string, string[]>; sets: Array<{ id: string; conversations: number }>; sensitivity_sample: { seed: string; share: number; conversations: string[] };
  cells: Array<{ id: string; set: string; arms: Array<{ id: string; judging: { by_reader: Record<string, string[]> } }> }>; reread_plans: Array<{ id: string; set: string; arm_cell_id: string }>;
};
const SAMPLE = new Set(sensitivitySample('N'));
const CONVS = [...positions('N').filter(p => SAMPLE.has(p)).slice(0, 6), ...positions('N').filter(p => !SAMPLE.has(p)).slice(0, 6)].sort();
const SCHEDULED = CONVS.flatMap(c => Array.from({ length: 5 }, (_, q) => ({ question_id: `${c}:q${q}`, conversation: c })));
const READERS = [OPUS, SOL, PARTICLE];
const PACKED = new Set<string>([ARMS.gbrain8k, ...ARMS.servers, ...ARMS.descriptive]);
const SYSTEM = (id: string) => id.split('.')[1];

type Score = (i: number, reader: string) => ReaderValue;
interface Spec { score: Score; particle?: Score; delivered?: number; not_run?: string; judge?: Score | null }

const jitter = (id: string) => { const rng = seededRandom([...id].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7)); const xs = SCHEDULED.map(() => rng()); return (i: number) => xs[i]; };
const around = (id: string, base: number, spread = 0.2): Score => { const j = jitter(id); return i => base + spread * (j(i) - 0.5); };
const valuesOf = (score: Score, readers: readonly string[]) => Object.fromEntries(SCHEDULED.map((q, i) => [q.question_id, Object.fromEntries(readers.map(r => [r, score(i, r)]))]));

/** Every row the block names (and each packed arm's particle-1 re-read), from per-arm specs over the defaults: gbrain well ahead of everything. */
function input(over: Partial<Record<string, Partial<Spec>>> = {}, cost: Rs1CostRow[] | null = null) {
  const base: Record<string, Spec> = {
    [ARMS.gbrain8k]: { score: around(ARMS.gbrain8k, 0.8) }, [ARMS.think]: { score: around(ARMS.think, 0.85) },
    ...Object.fromEntries([...ARMS.servers, ARMS.fileAgent, ...ARMS.descriptive].map(id => [id, { score: around(id, 0.35) }])),
  };
  const rows: Record<string, Rs1Row> = {};
  for (const [id, b] of Object.entries(base)) {
    const s: Spec = { ...b, ...over[id] };
    const packed = PACKED.has(id), readers = packed ? [OPUS, SOL] : READERS;
    const make = (cellId: string, rs: string[], score: Score): Rs1Row => s.not_run
      ? { cell_id: cellId, system: SYSTEM(id), not_run: s.not_run, values: {}, judge_values: null, delivered: [] }
      : { cell_id: cellId, system: SYSTEM(id), not_run: null, values: valuesOf(score, rs), judge_values: s.judge === null ? null : valuesOf(s.judge ?? ((i, r) => { const v = score(i, r); return typeof v === 'number' ? v - 0.1 : v; }), rs), delivered: packed ? SCHEDULED.map(() => s.delivered ?? 8000) : [] };
    rows[id] = make(id, readers, s.score);
    if (packed) rows[rereadId(id)] = make(rereadId(id), [PARTICLE], s.particle ?? s.score);
  }
  return { block: BLOCK, scheduled: SCHEDULED, rows, cost };
}

const familyOf = (a: Rs1Analysis, id: 'A' | 'B', group: 'counted' | 'particle-1' = 'counted') => a.families.find(f => f.id === id && f.group === group)!.comparisons;

describe('verdict boundaries (precedence: ahead, behind, level, else inconclusive)', () => {
  const M = MARGIN_POINTS.N.A;
  test('a lower bound of exactly 0 is not ahead', () => {
    expect(verdictOf([0, 2], M)).toBe('level');
    expect(verdictOf([0, M + 1], M)).toBe('inconclusive');
    expect(verdictOf([-2, 0], M)).toBe('level');
  });
  test('an interval inside (0, M) is ahead, and one inside (-M, 0) is behind', () => {
    expect(verdictOf([0.001, M - 0.001], M)).toBe('ahead');
    expect(verdictOf([-(M - 0.001), -0.001], M)).toBe('behind');
  });
  test('exactly ±M is level; M plus a hair either side is inconclusive', () => {
    expect(verdictOf([-M, M], M)).toBe('level');
    expect(verdictOf([-M - 1e-9, 1], M)).toBe('inconclusive');
    expect(verdictOf([-1, M + 1e-9], M)).toBe('inconclusive');
  });
  test('the frozen levels and margins', () => {
    expect(INTERVAL_LEVEL.A).toBe(1 - 0.05 / 3);
    expect(INTERVAL_LEVEL.A).toBeCloseTo(0.98333, 5);
    expect(INTERVAL_LEVEL.B).toBe(0.95);
    expect(COMPARISON_ALPHA).toEqual({ A: 0.05 / 3, B: 0.05 });
    expect(MARGIN_POINTS).toEqual({ N: { A: 3.5, B: 4.1 }, O: { A: 2.1, B: 2.5 } });
    expect(frozenBlock('O').families.map(f => f.margin_points)).toEqual([2.1, 2.5]);
  });
});

describe('delivered-context gate (cl100k, mean and nearest-rank p95 within 7,200 to 8,800 inclusive)', () => {
  const n = (x: number, k = 20) => Array(k).fill(x);
  test('7,200 and 8,800 pass; one token outside fails', () => {
    expect(deliveredGate(n(7200)).pass).toBe(true);
    expect(deliveredGate(n(8800)).pass).toBe(true);
    expect(deliveredGate(n(7199)).pass).toBe(false);
    expect(deliveredGate(n(8801)).pass).toBe(false);
    expect(deliveredGate([]).pass).toBe(false);
  });
  test('p95 is the ceil(0.95 n)-th smallest: one outlier in 20 passes, two fail', () => {
    expect(deliveredGate([...n(8000, 19), 9000])).toEqual({ rows: 20, mean: 8050, p95: 8000, pass: true });
    expect(deliveredGate([...n(8000, 18), 8801, 8801])).toMatchObject({ p95: 8801, pass: false });
  });
  test('a family A comparison whose comparator misses the gate is descriptive and blocks the ranking', () => {
    const a = analyze(input({ [ARMS.servers[2]]: { delivered: 8801 } }));
    const c = familyOf(a, 'A')[2];
    expect(c.outcome).toBe('descriptive');
    expect(c.why).toContain('8,801');
    expect(c.estimate).not.toBeNull();
    expect(a.ranking.claimed).toBe(false);
    expect(a.gate.find(g => g.cell_id === ARMS.servers[2])!.pass).toBe(false);
  });
});

describe('ranking', () => {
  test('all three family A comparisons ahead claim the ranking', () => {
    const a = analyze(input());
    expect(familyOf(a, 'A').map(c => c.outcome)).toEqual(['ahead', 'ahead', 'ahead']);
    expect(a.ranking.claimed).toBe(true);
    expect(a.ranking.sentence).toStartWith('On RS1, gbrain ranks first among these memory servers');
    expect(a.lines[0]).toBe(a.ranking.sentence);
    expect(a.lines).toHaveLength(1 + 2 * (3 + 1));
  });
  test('a not-run comparison blocks it, keeps its place, and Holm keeps the family size', () => {
    const a = analyze(input({ [ARMS.servers[1]]: { not_run: 'did not run: synthetic outage' } }));
    const fam = familyOf(a, 'A');
    expect(fam.map(c => c.outcome)).toEqual(['ahead', 'not-run', 'ahead']);
    expect(fam[1].sentence).toContain('keeps its place in family A');
    expect(fam[1].p_holm).toBeNull();
    const ran = fam.filter(c => c.p !== null);
    expect(Math.min(...ran.map(c => c.p_holm!))).toBeCloseTo(3 * Math.min(...ran.map(c => c.p!)), 6);
    expect(a.ranking.claimed).toBe(false);
    expect(a.ranking.sentence).toContain('it is ahead of 2');
  });
  test('a level comparison blocks it', () => {
    const subject = around(ARMS.gbrain8k, 0.6), j = jitter('level');
    const a = analyze(input({ [ARMS.gbrain8k]: { score: subject }, [ARMS.servers[0]]: { score: (i, r) => Number(subject(i, r)) + 0.02 * (j(i) - 0.5) } }));
    expect(familyOf(a, 'A')[0].outcome).toBe('level');
    expect(a.ranking.claimed).toBe(false);
  });
  test('particle-1 is never part of it: its family is reported apart either way', () => {
    const low = around('p1-low', 0.05);
    const a = analyze(input({ [ARMS.gbrain8k]: { particle: low } }));
    expect(familyOf(a, 'A', 'particle-1').map(c => c.outcome)).toEqual(['behind', 'behind', 'behind']);
    expect(a.ranking.claimed).toBe(true);
    expect(a.ranking.sentence).not.toContain('particle');
    const subject = around(ARMS.gbrain8k, 0.6), j = jitter('level');
    const b = analyze(input({ [ARMS.gbrain8k]: { score: subject, particle: around('p1-high', 0.95, 0.05) }, [ARMS.servers[0]]: { score: (i, r) => Number(subject(i, r)) + 0.02 * (j(i) - 0.5), particle: around('p1-low', 0.1) } }));
    expect(familyOf(b, 'A', 'particle-1').map(c => c.outcome)).toEqual(['ahead', 'ahead', 'ahead']);
    expect(b.ranking.claimed).toBe(false);
    expect(rankingClaimed([{ outcome: 'ahead' }, { outcome: 'ahead' }])).toBe(false);
  });
});

describe('missing data (review F17)', () => {
  test('a product failure (0) stays in; a harness failure or missing answer drops that question from both rows, counted by reason', () => {
    const s = around(ARMS.gbrain8k, 0.8), o = around(ARMS.servers[0], 0.35);
    const a = analyze(input({
      [ARMS.gbrain8k]: { score: (i, r) => (i === 0 && r === OPUS ? 'harness: reader_error (anthropic:claude-opus-5-5)' : i === 1 && r === SOL ? 'missing answer (openai:gpt-6.1-sol)' : i === 2 && r === OPUS ? 0 : s(i, r)) },
      [ARMS.servers[0]]: { score: (i, r) => (i === 3 && r === SOL ? 'harness: judge_error (openai:gpt-6.1-sol)' : o(i, r)) },
    }));
    const [first, second] = familyOf(a, 'A');
    expect(first.scheduled).toBe(60);
    expect(first.paired).toBe(57);
    expect(first.excluded).toEqual([
      { reason: 'ext-extract-first: harness: judge_error (openai:gpt-6.1-sol)', count: 1 },
      { reason: 'gbrain-defaults: harness: reader_error (anthropic:claude-opus-5-5)', count: 1 },
      { reason: 'gbrain-defaults: missing answer (openai:gpt-6.1-sol)', count: 1 },
    ]);
    expect(second.paired).toBe(58);
    expect(familyOf(a, 'A', 'particle-1')[0].paired).toBe(60);
  });
  test('a particle-1 value missing from the re-read leaves only that family', () => {
    const s = around(ARMS.gbrain8k, 0.8);
    const a = analyze(input({ [ARMS.gbrain8k]: { particle: (i, r) => (i < 4 ? 'harness: judge_error (particle:particle-1)' : s(i, r)) } }));
    expect(familyOf(a, 'A', 'particle-1')[0].paired).toBe(56);
    expect(familyOf(a, 'A')[0].paired).toBe(60);
  });
  test('a re-read missing from the receipt makes the particle-1 comparison not run, never the counted one', () => {
    const i = input();
    delete i.rows[rereadId(ARMS.gbrain8k)];
    const a = analyze(i);
    expect(familyOf(a, 'A', 'particle-1').map(c => c.outcome)).toEqual(['not-run', 'not-run', 'not-run']);
    expect(familyOf(a, 'A')[0].outcome).toBe('ahead');
    expect(a.ranking.claimed).toBe(true);
  });
  test('fewer than two conversations with a paired question runs no test', () => {
    const s = around(ARMS.gbrain8k, 0.8);
    const a = analyze(input({ [ARMS.servers[0]]: { score: (i, r) => (SCHEDULED[i].conversation === CONVS[0] ? s(i, r) : 'missing answer (x)') } }));
    expect(familyOf(a, 'A')[0]).toMatchObject({ outcome: 'not-run', conversations: 1, estimate: null });
    expect(a.ranking.claimed).toBe(false);
  });
});

describe('cost per correct answer', () => {
  test('(ingest per conversation / R + read per question) / accuracy at R = 1, 20, 200', () => {
    const c = { ingest_usd_per_conversation: 3, read_usd_per_question: 0.03 };
    expect([1, 20, 200].map(r => costPerCorrect(c, 0.6, r))).toEqual([(3 + 0.03) / 0.6, (0.15 + 0.03) / 0.6, (0.015 + 0.03) / 0.6]);
    expect(costPerCorrect(c, 0, 1)).toBeNull();
  });
  test('the table: Opus, then particle-1, then Sol, each over every row, with cost where the receipt meters it', () => {
    const a = analyze(input({ [ARMS.gbrain8k]: { score: () => 0.75 } }, [{ cell_id: ARMS.gbrain8k, reader: OPUS, ingest_usd_per_conversation: 3, read_usd_per_question: 0.03 }]));
    expect(a.table.map(t => t.reader)).toEqual([...Array(8).fill(OPUS), ...Array(8).fill(PARTICLE), ...Array(8).fill(SOL)]);
    expect(a.table[0]).toMatchObject({ cell_id: ARMS.gbrain8k, accuracy: 0.75, scored: 60, scheduled: 60, cost: [{ reads: 1, usd: 4.04 }, { reads: 20, usd: 0.24 }, { reads: 200, usd: 0.06 }] });
    expect(a.table[1].cost).toBeNull();
    expect(a.table.find(t => t.reader === PARTICLE && t.cell_id === ARMS.gbrain8k)!.accuracy).toBe(0.75);
  });
});

describe('judge sensitivity (review F18), descriptive', () => {
  test('the seeded 30% sample of positions, the one rs1-cells.json records and rs1/judge.ts grades', () => {
    expect(sensitivitySample('N')).toEqual(MANIFEST.sensitivity_sample.conversations);
    expect(MANIFEST.sensitivity_sample).toMatchObject({ seed: BLOCK.sensitivity.seed, share: BLOCK.sensitivity.share });
    expect(sensitivitySample('N')).toHaveLength(23);
    expect(sensitivitySample('O')).toHaveLength(60);
    expect(sensitivitySample('N')).toEqual([...sensitivitySample('N')].sort());
    expect(sensitivitySample('N').every(p => positions('N').includes(p))).toBe(true);
  });
  test('each family A and B comparison on the sample under both judge sets; it never moves a verdict', () => {
    const a = analyze(input());
    const s = a.judge_sensitivity;
    expect(s).toMatchObject({ judge: SENSITIVITY_JUDGE, conversations: 23 });
    expect(s.comparisons.map(c => c.id)).toEqual([...ARMS.servers.map(x => `A: ${x}`), `B: ${ARMS.fileAgent}`]);
    for (const c of s.comparisons) { expect(c.counted.paired).toBe(30); expect(c.judge.paired).toBe(30); expect(c.judge.estimate).not.toBeNull(); }
    const b = analyze(input({ [ARMS.servers[0]]: { judge: null } }));
    expect(b.judge_sensitivity.comparisons[0].judge).toMatchObject({ estimate: null, why: `ext-extract-first: no ${SENSITIVITY_JUDGE} judgments` });
    expect(b.families).toEqual(a.families);
    expect(b.lines).toEqual(a.lines);
  });
});

describe('the frozen block', () => {
  test('names the arms, re-reads and judges eval/runner/q1/cells/rs1-cells.json runs', () => {
    const arms = new Map(MANIFEST.cells.filter(c => c.set === BLOCK.set).flatMap(c => c.arms.map(a => [`${c.id}.${a.id}` as string, a] as const)));
    for (const f of BLOCK.families) for (const id of [f.subject, ...f.comparators]) expect(arms.has(id)).toBe(true);
    for (const id of BLOCK.descriptive) expect(arms.has(id)).toBe(true);
    for (const [id, a] of arms) expect(a.judging.by_reader).toEqual(Object.fromEntries(Object.keys(a.judging.by_reader).map(r => [r, BLOCK.judges[r]])));
    expect(MANIFEST.judges).toEqual(BLOCK.judges);
    expect(Object.fromEntries(MANIFEST.reread_plans.filter(p => p.set === BLOCK.set).map(p => [p.arm_cell_id, p.id]))).toEqual(BLOCK.reread);
    expect(MANIFEST.sets.find(s => s.id === BLOCK.set)!.conversations).toBe(75);
  });
  test('re-read ids match q1/reread-cell.ts', () => {
    for (const id of [ARMS.gbrain8k, ...ARMS.servers, ...ARMS.descriptive]) expect(BLOCK.reread[id]).toBe(rereadCellId(id, PARTICLE));
    expect(BLOCK.reread[ARMS.gbrain8k]).toBe('rs1.gbrain-defaults.rs1-master.p.reread-particle-particle-1');
  });
  test('the frozen block has no problems; a loosened margin, level, reader list, judge plan or gate each has one', () => {
    expect(blockProblems(BLOCK)).toEqual([]);
    const loosen = (f: (b: Rs1Block) => void) => { const b = structuredClone(BLOCK); f(b); return blockProblems(b); };
    expect(loosen(b => { b.families[0].margin_points = 5; })).toEqual([expect.stringContaining('family A margin is 5 points')]);
    expect(loosen(b => { b.families[0].interval_level = 0.95; })).toEqual([expect.stringContaining('family A interval level is 0.95')]);
    expect(loosen(b => { b.readers.counted = [OPUS]; })).toEqual([expect.stringContaining('rs1 readers')]);
    expect(loosen(b => { b.judges[OPUS] = ['anthropic:claude-haiku-5-5']; })).toEqual([expect.stringContaining('rs1 judges')]);
    expect(loosen(b => { b.gate.low = 7000; })).toEqual([expect.stringContaining('rs1 gate')]);
    expect(loosen(b => { b.amendments.push({ id: 'A1', date: 'soon', verdict_sha256: 'b'.repeat(64), reason: 'x' }); })).toEqual([expect.stringContaining('YYYY-MM-DD')]);
  });
});

describe('RS1 publication.json', () => {
  const pub = JSON.parse(readFileSync(resolve(import.meta.dir, '../../docs/benchmarks/2026-11-04-rs1-ranking-set/publication.json'), 'utf8')) as Publication;
  test('freezes this verdict.ts by hash, with the frozen block at size N', () => {
    expect(blockProblems(pub.rs1!)).toEqual([]);
    expect(pub.rs1!.size).toBe('N');
    expect(analysisSha256(pub.rs1!)).toBe(createHash('sha256').update(readFileSync(resolve(import.meta.dir, '../..', RS1_VERDICT_PATH))).digest('hex'));
  });
  test('draws on rs1-cells.json only, aggregates only, every arm pending', () => {
    expect(pub.cells).toEqual(['eval/runner/q1/cells/rs1-cells.json']);
    expect(pub.published.aggregates_only).toBe(true);
    expect(pub).toMatchObject({ headline_set: 'RS1', sources: [], pending: [], not_run: {}, anchors: [ARMS.gbrain8k] });
    expect(pub.not_run_reason).toStartWith('pending:');
    expect(pub.gbrain).toMatchObject({ commit: '62637c96a5a5c2e9d55594f87a33d79c2f30b54f', version: '0.60.557.0' });
  });
  test('labels the two configurations with their own build from the configuration pin table', () => {
    const md = readFileSync(resolve(import.meta.dir, '../../docs/comparison-systems.md'), 'utf8');
    const table = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(md.slice(md.indexOf('### Configurations with their own build')))![1]) as Array<{ kind: string; config: string; lock_sha256: string; capability_sha256: string }>;
    for (const id of ARMS.servers.slice(1)) {
      const [, kind, ...rest] = id.split('.'), config = rest.slice(0, -1).join('.');
      const e = table.find(x => x.kind === kind && x.config === config)!;
      expect(pub.pins[kind]).toBe(`bundle ${config}, lock ${e.lock_sha256.slice(0, 8)}, capabilities ${e.capability_sha256.slice(0, 8)}`);
    }
  });
  test('carries exactly the three standing disclosures', () => {
    expect(pub.disclosures).toEqual([
      "gbrain is Garry Tan's own project.",
      'Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator. Garry Tan runs Y Combinator.',
      'Disclosure: Y Combinator, which Garry Tan runs, is an investor in Particle, which makes particle-1.',
    ]);
  });
});
