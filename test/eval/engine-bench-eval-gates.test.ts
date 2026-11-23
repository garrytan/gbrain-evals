import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildEvalGates, criterion8, EVAL_GATES_SCHEMA_VERSION, evalGates, main, MIN_PAIRS, outputPath, type EvalGatesInput } from '../../eval/runner/engine-bench/eval-gates.ts';
import { comparePair, LME_RECALL_SCHEMA, type QuestionRow } from '../../eval/runner/engine-bench/lme-recall.ts';
import { PAIRED_OPS } from '../../eval/runner/engine-bench/perf.ts';

const N = 470;
const ids = Array.from({ length: N }, (_, i) => 'q' + String(i).padStart(3, '0'));
const row = (engine: 'pglite' | 'postgres' | 'rust', id: string, retrieved: string[], recall: number, arm = 'keyword'): QuestionRow => ({
  engine, question_id: id, question_type: 't', is_abs: false, num_sessions: 10,
  arms: { [arm]: { retrieved, recall_all: recall, recall_any: recall, search_ms: 1 } }, timing_ms: { open: 1, import: 1, search: 1, total: 3 },
} as QuestionRow);
const recallOf = (i: number) => (i % 3 === 0 ? 0 : 1);

/** Stage-3 comparisons for every arm against both TypeScript engines; `rustLosses` questions Rust gets wrong on the keyword arm. */
function answers(rustLosses = 0) {
  const losers = new Set(ids.map((_, i) => i).filter(i => recallOf(i) === 1).slice(0, rustLosses));
  const comparisons = (['keyword', 'vector', 'hybrid'] as const).flatMap(arm => {
    const rows = ids.flatMap((id, i) => {
      const ts = (e: 'pglite' | 'postgres') => row(e, id, ['s' + i], recallOf(i), arm);
      const lose = arm === 'keyword' && losers.has(i);
      return [ts('pglite'), ts('postgres'), lose ? row('rust', id, ['other' + i], 0, arm) : row('rust', id, ['s' + i], recallOf(i), arm)];
    });
    return [comparePair(rows, arm, 'pglite', 'rust'), comparePair(rows, arm, 'rust', 'postgres')];
  });
  return { schema: LME_RECALL_SCHEMA, dataset: { sha256: 'lme-s', matches_published_sha256: true }, comparisons };
}

const identity = (o: { commit?: string; addon?: string | null; counted?: boolean; ref?: string; target?: string } = {}) => ({
  counted: o.counted ?? true,
  gbrain: { overlay: { commit: o.commit ?? 'c0ffee', ref: o.ref ?? 'v0.61.0.0' }, rust_addon: o.addon === null ? null : { sha256: o.addon ?? 'addon-sha', target: o.target ?? 'linux-x64-glibc' } },
});
const input = (role: EvalGatesInput['role'], json: unknown, path = role + '.json'): EvalGatesInput => ({ role, path, json, sha256: 'x' });
const opts = { provisional: false, evalsCommit: 'e1', engineFormatVersion: '3', generatedAt: '2026-11-28T00:00:00.000Z', ops: PAIRED_OPS };

describe('E1 from the answers stage', () => {
  test('every LongMemEval-S row passes on identical answers, yet E1 is NOT_RUN because engine-bench runs no Cat 13, 13b, 10 or 12', () => {
    const g = evalGates(answers());
    const lme = g.E1.rows.filter(r => r.id.startsWith('lme-s/'));
    expect(lme.map(r => r.id)).toEqual(['keyword', 'vector', 'hybrid'].flatMap(a => [`lme-s/${a}/vs-pglite`, `lme-s/${a}/vs-postgres`]));
    expect(lme.every(r => r.verdict === 'PASS')).toBe(true);
    expect(lme[0].measured).toMatchObject({ point_estimate: 0, lower_bound_95: 0, n: N, exact_ties: N, rust_errors: 0 });
    expect(g.E1.verdict).toBe('NOT_RUN');
    expect(g.E1.rows.find(r => r.id === 'cat10')).toMatchObject({ verdict: 'NOT_RUN', reason: 'engine-bench does not run this benchmark' });
    expect(g.E1.rows.find(r => r.id === 'cat7')!.gating).toBe(false);
    expect(g.E2.verdict).toBe('NOT_RUN');
    expect(g.E3.verdict).toBe('NOT_RUN');
    expect(g.E1.threshold).toContain('at least -0.018 (N = 470)');
    expect(g.E3.threshold).toBe('Cat 22 zero leaks; others within 0.5 points or equal counts');
  });

  test('a measured loss fails E1 whatever else is NOT_RUN, names the row and its lower bound, whichever side Rust was on', () => {
    const g = evalGates(answers(20));
    expect(g.E1.verdict).toBe('FAIL');
    expect(g.E1.losses.map(l => l.id)).toEqual(['lme-s/keyword/vs-pglite', 'lme-s/keyword/vs-postgres']);
    const [vsPglite, vsPostgres] = g.E1.rows.slice(0, 2);
    expect(vsPglite.measured!.point_estimate).toBeCloseTo(-20 / N, 10);
    expect(vsPostgres.measured!.point_estimate).toBeCloseTo(-20 / N, 10);
    expect(vsPglite.measured!.lower_bound_95 as number).toBeLessThan(-0.018);
    expect(vsPostgres.measured!.lower_bound_95 as number).toBeLessThan(-0.018);
    expect(g.E1.losses[0].reason).toMatch(/^95% lower bound -0\.\d{4} is below -0\.018$/);
  });

  test('a sample short of N = 470 is NOT_RUN with its N, whatever its interval says; a Rust error still fails it', () => {
    const subset = (rustErr: boolean) => {
      const rows = ids.slice(0, 96).flatMap((id, i) => [row('pglite', id, ['s' + i], recallOf(i)), rustErr && i === 1 ? { ...row('rust', id, [], 0), error: 'boom', arms: {} } as QuestionRow : row('rust', id, ['s' + i], recallOf(i))]);
      return { comparisons: [comparePair(rows, 'keyword', 'pglite', 'rust')] };
    };
    expect(evalGates(subset(false)).E1.rows[0]).toMatchObject({ verdict: 'NOT_RUN', reason: 'measured on 96 scored questions; the gate is defined at N = 470', measured: { n: 96, point_estimate: 0 } });
    expect(evalGates(subset(true)).E1.rows[0]).toMatchObject({ verdict: 'FAIL', reason: 'Rust errored on 1 question(s) pglite answered' });
  });

  test('no answers receipt, or no Rust comparison in it, leaves every LongMemEval-S row NOT_RUN with the reason', () => {
    expect(evalGates(null).E1.rows[0]).toMatchObject({ verdict: 'NOT_RUN', reason: 'no answers-stage receipt was given' });
    expect(evalGates({ comparisons: [] }).E1.rows[0].reason).toBe('the answers stage has no Rust comparison against pglite on the keyword arm');
  });
});

describe('criterion 8 from the speed stage', () => {
  const ratio = (ci95: [number, number] | null, r = 1) => ({ ratio: r, ci95 });
  const lat = (p50: [number, number] | null, p99: [number, number] | null, n = 2000) => ({ n, p50_ratio: ratio(p50), p99_ratio: ratio(p99) });
  const speed = {
    speed: { verdict: 'slower' },
    pairs: {
      'rust-vs-pglite': { reference: 'pglite', other: 'rust', latency: { get_page: lat([1.02, 1.05], [0.9, 1.1]), put_page: lat([0.5, 0.6], [0.4, 0.7]), search_vector: lat([0.9, 1.1], [0.9, 1.1], MIN_PAIRS - 1) } },
      'rust-vs-postgres': { reference: 'postgres', other: 'rust', latency: { get_page: lat([0.8, 0.9], [0.8, 0.9]) } },
      'pglite-vs-postgres': { reference: 'postgres', other: 'pglite', latency: { get_page: lat([5, 6], [5, 6]) } },
    },
  };
  test('a class is worse only when its whole interval lies above 1, and every losing or unmeasured class is named', () => {
    const c = criterion8(speed, ['get_page', 'put_page', 'search_vector']);
    const s = (op: string, q: string, against: string) => c.rows.find(r => r.op === op && r.quantile === q && r.against === against)!.status;
    expect(s('get_page', 'p50', 'pglite')).toBe('worse');
    expect(s('get_page', 'p99', 'pglite')).toBe('not_shown');
    expect(s('put_page', 'p50', 'pglite')).toBe('better');
    expect(s('search_vector', 'p50', 'pglite')).toBe('too_few_pairs');
    expect(s('put_page', 'p50', 'postgres')).toBe('missing');
    expect(c.rows.some(r => r.against === 'postgres' && r.op === 'get_page' && r.status === 'better')).toBe(true);
    expect(c.rows.every(r => r.against !== 'postgres' || r.op !== 'get_page' || r.status === 'better')).toBe(true);
    expect(c.losing_classes).toEqual(['get_page p50 vs pglite']);
    expect(c.unmeasured_classes).toContain('search_vector p50 vs pglite');
    expect(c.unmeasured_classes).toContain('put_page p99 vs postgres');
    expect(c).toMatchObject({ gating: false, verdict: 'some_class_worse', speed_stage_verdict: 'slower' });
  });
  test('a speed receipt without a Rust pair, or none at all, is not_run', () => {
    expect(criterion8(null, PAIRED_OPS).verdict).toBe('not_run');
    expect(criterion8({ pairs: { x: speed.pairs['pglite-vs-postgres'] } }, PAIRED_OPS)).toMatchObject({ verdict: 'not_run', reason: 'the speed stage has no Rust pair' });
  });
  test('a missing Rust pair against one engine leaves every class against it unmeasured, never no worse', () => {
    const c = criterion8({ pairs: { 'rust-vs-pglite': { reference: 'pglite', other: 'rust', latency: { get_page: lat([0.8, 0.9], [0.8, 0.9]) } } } }, ['get_page']);
    expect(c).toMatchObject({ verdict: 'incomplete', losing_classes: [], unmeasured_classes: ['get_page p50 vs postgres', 'get_page p99 vs postgres'] });
  });
});

describe('the file', () => {
  test('carries the build identity every receipt agrees on', () => {
    const f = buildEvalGates([input('answers', { ...answers(), ...identity() }), input('speed', identity())], opts);
    expect(f).toMatchObject({ schema_version: EVAL_GATES_SCHEMA_VERSION, status: 'FINAL', provisional: false, gbrain_commit: 'c0ffee', gbrain_tag: 'v0.61.0.0', target: 'linux-x64-glibc', rust_addon_sha256: 'addon-sha', engine_format_version: '3', evals_commit: 'e1' });
    expect(Object.keys(f.gates)).toEqual(['E1', 'E2', 'E3']);
    expect(f.receipt_links.map(l => l.role)).toEqual(['answers', 'speed']);
  });
  test('refuses receipts from two builds or two addons, development receipts unless provisional, and an answers schema before D24', () => {
    const a = input('answers', { ...answers(), ...identity() });
    expect(() => buildEvalGates([a, input('speed', identity({ commit: 'other' }))], opts)).toThrow(/disagree on the gbrain commit/);
    expect(() => buildEvalGates([a, input('speed', identity({ addon: 'other' }))], opts)).toThrow(/disagree on the gbrain Rust addon digest/);
    const dev = input('correctness', identity({ counted: false }));
    expect(() => buildEvalGates([a, dev], opts)).toThrow(/not counted: correctness\.json/);
    const p = buildEvalGates([a, dev], { ...opts, provisional: true });
    expect(p).toMatchObject({ status: 'PROVISIONAL', provisional: true });
    expect('gbrain_tag' in p).toBe(false);
    expect(() => buildEvalGates([input('answers', { ...answers(), ...identity({ ref: 'v0.61.0.0-rc.1' }) })], opts)).toThrow(/release candidate or branch build is --provisional/);
    expect(() => buildEvalGates([input('answers', { ...answers(), ...identity({ ref: 'b66e4077' }) })], opts)).toThrow(/--provisional/);
    expect(() => buildEvalGates([input('answers', { ...answers(), ...identity({ target: 'darwin-arm64' }) })], opts)).toThrow(/covers linux-x64-glibc only/);
    expect(() => buildEvalGates([input('answers', { ...answers(), ...identity({ addon: null }) })], opts)).toThrow(/Rust addon digest/);
    expect(() => buildEvalGates([input('answers', { ...answers(), schema: 'engine-bench.lme-recall/2', ...identity() })], opts)).toThrow(/reads engine-bench\.lme-recall\/3/);
  });
  test('FINAL takes its build only from counted stage receipts, from one answers and one speed receipt, a clean checkout and the published dataset', () => {
    const a = input('answers', { ...answers(), ...identity() });
    const s = input('speed', identity());
    expect(() => buildEvalGates([input('receipt', identity({ counted: false }))], opts)).toThrow(/at least one stage receipt/);
    expect(() => buildEvalGates([a, input('receipt', identity({ commit: 'other' }))], opts)).not.toThrow();
    expect(() => buildEvalGates([a, input('answers', { ...answers(), ...identity() }, 'answers-2.json')], opts)).toThrow(/more than one --answers/);
    expect(() => buildEvalGates([a, s, input('speed', identity(), 'speed-2.json')], opts)).toThrow(/more than one --speed/);
    const dirty = identity();
    (dirty.gbrain.overlay as Record<string, unknown>).checkout_dirty = true;
    expect(() => buildEvalGates([a, input('speed', dirty)], opts)).toThrow(/uncommitted changes: speed\.json/);
    expect(() => buildEvalGates([input('answers', { ...answers(), dataset: { sha256: 'other', matches_published_sha256: false }, ...identity() })], opts)).toThrow(/published LongMemEval-S dataset digest/);
    const noTarget = identity();
    (noTarget.gbrain.rust_addon as Record<string, unknown>).target = undefined;
    expect(() => buildEvalGates([a, input('speed', noTarget)], opts)).toThrow(/missing in speed\.json/);
  });
  test('FINAL refuses a counted receipt that names no build of its own, such as an aggregate without one or a failed addon read', () => {
    const a = input('answers', { ...answers(), ...identity() });
    const bareAggregate = input('answers', { ...answers(), counted: true });
    expect(() => buildEvalGates([bareAggregate, input('speed', identity())], opts)).toThrow(/must name its own gbrain commit and Rust addon digest for linux-x64-glibc; missing in answers\.json/);
    const unread = input('speed', { counted: true, gbrain: { overlay: { commit: 'c0ffee', ref: 'v0.61.0.0' }, rust_addon: { sha256: null, read_error: 'ENOENT' } } });
    expect(() => buildEvalGates([a, unread], opts)).toThrow(/missing in speed\.json/);
    expect(buildEvalGates([bareAggregate, input('speed', identity())], { ...opts, provisional: true }).status).toBe('PROVISIONAL');
  });
  test('the command writes a provisional file with each receipt\'s digest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-gates-'));
    const src = join(dir, 'answers.json');
    const body = JSON.stringify({ ...answers(), ...identity({ counted: false, ref: 'b66e4077' }) });
    writeFileSync(src, body);
    const out = join(dir, 'eval-gates.json');
    expect(main(['--provisional', '--answers', src, '--out', out])).toBe(0);
    const f = JSON.parse(readFileSync(out, 'utf8'));
    expect(f.status).toBe('PROVISIONAL');
    expect(f.receipt_links[0].sha256).toBe(createHash('sha256').update(body).digest('hex'));
    expect(f.gates.E1.verdict).toBe('NOT_RUN');
    expect(main([])).toBe(2);
  });
  test('a FINAL file goes only to its tag and evals-commit path and is never rewritten; a PROVISIONAL one never under eval/results', () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-gates-root-'));
    const sha = 'abc123'.padEnd(40, '0');
    const final = { status: 'FINAL' as const, gbrain_tag: 'v0.61.0.0', evals_commit: sha };
    const path = join(root, `eval/results/engine-bench/eval-gates/v0.61.0.0/${sha}.json`);
    expect(outputPath(final, undefined, root)).toBe(path);
    expect(() => outputPath({ ...final, evals_commit: '' }, undefined, root)).toThrow(/not a full git commit/);
    expect(() => outputPath(final, join(root, 'elsewhere.json'), root)).toThrow(/a FINAL file goes to eval\/results\/engine-bench\/eval-gates\/v0\.61\.0\.0\/abc1230+\.json/);
    mkdirSync(join(root, 'eval/results/engine-bench/eval-gates/v0.61.0.0'), { recursive: true });
    writeFileSync(path, '{}');
    expect(() => outputPath(final, undefined, root)).toThrow(/never rewritten/);
    const provisional = { status: 'PROVISIONAL' as const, evals_commit: 'abc123' };
    expect(() => outputPath(provisional, join(root, 'eval/results/x.json'), root)).toThrow(/never go on main/);
    expect(() => outputPath(provisional, undefined, root)).toThrow(/needs --out/);
    expect(outputPath(provisional, join(root, 'out.json'), root)).toBe(join(root, 'out.json'));
  });
});
