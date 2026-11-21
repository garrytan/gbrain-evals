import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import {
  DEFAULT_MARGINS, buildDataset, hashEmbed, higherIsBetter, lowerIsBetter, marginsFromPrereg, medianRatio, missingMetric, pageMarkdown,
  ENGINES, parseArgs, quantileRatio, recordedCommand, speedVerdict, type MetricVerdict, type PairedRow, type Options,
} from '../../eval/runner/engine-bench/perf.ts';

const REPO = join(import.meta.dir, '../..');
const m = { ...DEFAULT_MARGINS, bootstrap_draws: 1000, quantile_draws: 400 };

describe('an external Postgres server', () => {
  const url = (scheme: string, secret: string, rest: string) => [scheme + '://bench', secret + '@' + rest].join(':');
  test('the arm asks the server for a scratch database and never hands the supplied database to the engine', async () => {
    const supplied = url('postgres', 'pw', '127.0.0.1:1/brain');
    const opened = ENGINES.postgres.prepare({ workDir: '/nonexistent', opts: { postgresUrl: supplied } as unknown as Options });
    await expect(opened).rejects.toThrow();
  });
  test('the recorded command hides the password of a connection URL', () => {
    const cmd = recordedCommand(['--engines', 'postgres', '--postgres-url', url('postgres', 's3cret', 'db.internal:5432/postgres'), '--dev']);
    expect(cmd).toBe('bun eval/runner/engine-bench/perf.ts --engines postgres --postgres-url ' + url('postgres', '***', 'db.internal:5432/postgres') + ' --dev');
    expect(cmd).not.toContain('s3cret');
    expect(recordedCommand(['--postgres-url=' + url('postgresql', 'p', 'h/db')])).toBe('bun eval/runner/engine-bench/perf.ts --postgres-url=' + url('postgresql', '***', 'h/db'));
  });
});

describe('dataset', () => {
  test('builds exactly the requested number of pages, deterministically', () => {
    const a = buildDataset(300, 1337);
    const b = buildDataset(300, 1337);
    expect(a.counts.pages).toBe(300);
    expect(a.counts.base_pages + a.counts.filler_pages).toBe(300);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(buildDataset(300, 7).fingerprint).not.toBe(a.fingerprint);
    expect(a.walkSlugs.length).toBeGreaterThan(0);
    expect(a.linkedSlugs.length).toBeGreaterThan(0);
  });
  test('renders gbrain markdown with the timeline after its sentinel', () => {
    const md = pageMarkdown({ slug: 'people/x', type: 'person', title: 'A "quoted" name', compiled_truth: 'Body.', timeline: '- **2024-01-02** | Met.', base: false });
    expect(md).toContain('title: "A \\"quoted\\" name"');
    expect(md).toMatch(/Body\.\n\n---\n\n## Timeline\n\n- \*\*2024-01-02\*\* \| Met\./);
  });
  test('the embedder is deterministic and unit length', () => {
    const v = hashEmbed('founder raised a seed round');
    expect(Array.from(v)).toEqual(Array.from(hashEmbed('founder raised a seed round')));
    expect(Math.abs(v.reduce((s, x) => s + x * x, 0) - 1)).toBeLessThan(1e-5);
  });
});

describe('ratios', () => {
  const rows = (f: (i: number) => [number, number]): PairedRow[] => Array.from({ length: 500 }, (_, i) => { const [a, b] = f(i); return { q: i, ref_ms: a, other_ms: b, other_first: i % 2 === 0 }; });
  test('p99 ratio of identical engines is 1 with an interval around it', () => {
    const r = quantileRatio(rows((i) => [1 + (i % 50) / 10, 1 + (i % 50) / 10]), 99, 1, 400);
    expect(r.ratio).toBeCloseTo(1, 6);
    expect(r.ci95![0]).toBeLessThanOrEqual(1);
    expect(r.ci95![1]).toBeGreaterThanOrEqual(1);
  });
  test('a uniformly 2x slower engine has a p50 ratio near 2', () => {
    const r = quantileRatio(rows((i) => [1 + (i % 50) / 10, 2 * (1 + (i % 50) / 10)]), 50, 1, 400);
    expect(r.ratio).toBeCloseTo(2, 6);
    expect(r.ci95![0]).toBeGreaterThan(1.5);
  });
  test('median ratio of independent samples', () => {
    const r = medianRatio([10, 11, 12, 13, 14], [20, 22, 24, 26, 28], 1, 1000);
    expect(r.ratio).toBeCloseTo(2, 6);
  });
});

describe('speed rule', () => {
  const lat = (name: string, ratio: number, ci: [number, number], core: boolean) => lowerIsBetter(name, 'pglite', { ratio, ci95: ci }, m.latency_ratio, core);
  const tp = (name: string, ratio: number, ci: [number, number]) => higherIsBetter(name, 'pglite', { ratio, ci95: ci }, m.throughput_ratio, false);
  test('statuses follow the interval against the margin', () => {
    expect(lat('a', 0.8, [0.7, 0.9], true).status).toBe('pass');
    expect(lat('a', 1.3, [1.2, 1.4], true).status).toBe('fail');
    expect(lat('a', 1.05, [0.95, 1.2], true).status).toBe('inconclusive');
    expect(tp('t', 1.2, [1.0, 1.4]).status).toBe('pass');
    expect(tp('t', 0.5, [0.4, 0.6]).status).toBe('fail');
  });
  test('all pass is no_slower', () => {
    expect(speedVerdict([lat('get_page p50', 0.5, [0.4, 0.6], true), tp('read', 3, [2, 4])], m).verdict).toBe('no_slower');
  });
  test('a non-core loss within the exception ratio is a named exception', () => {
    const v = speedVerdict([lat('get_page p50', 0.5, [0.4, 0.6], true), lat('graph_walk_d3 p99', 1.3, [1.2, 1.4], false)], m);
    expect(v.verdict).toBe('no_slower_with_exceptions');
    expect(v.exceptions.map((x) => x.metric)).toEqual(['graph_walk_d3 p99']);
  });
  test('a non-core loss beyond the exception ratio is slower', () => {
    expect(speedVerdict([lat('graph_walk_d3 p99', 1.8, [1.6, 2], false)], m).verdict).toBe('slower');
    expect(speedVerdict([tp('write at 16', 0.5, [0.4, 0.6])], m).verdict).toBe('slower');
  });
  test('a core loss is slower, a core inconclusive is not_shown', () => {
    expect(speedVerdict([lat('search_hybrid p99', 1.15, [1.12, 1.2], true)], m).verdict).toBe('slower');
    const v = speedVerdict([lat('search_hybrid p99', 1.05, [0.98, 1.15], true)], m);
    expect(v.verdict).toBe('not_shown');
    expect(v.unresolved.length).toBe(1);
  });
  test('a missing core operation is slower; a missing other operation is a named exception', () => {
    expect(speedVerdict([missingMetric('search_vector p50', 'pglite', 'lower_is_better', true)], m).verdict).toBe('slower');
    const v = speedVerdict([lat('get_page p50', 0.5, [0.4, 0.6], true), missingMetric('graph_walk_d2 p99', 'pglite', 'lower_is_better', false)], m);
    expect(v.verdict).toBe('no_slower_with_exceptions');
    expect(v.exceptions.map((x) => x.status)).toEqual(['missing']);
  });
  test('the verdict never counts a metric twice', () => {
    const ms: MetricVerdict[] = [lat('a', 1.3, [1.2, 1.4], false), lat('b', 1.05, [0.9, 1.2], true)];
    const v = speedVerdict(ms, m);
    expect(v.exceptions.length + v.blockers.length + v.unresolved.length).toBe(2);
  });
});

describe('margins and arguments', () => {
  test('margins come from the preregistration block and every field is required', () => {
    const block = (o: object) => 'x\n```json engine-bench-margins\n' + JSON.stringify(o) + '\n```\n';
    expect(marginsFromPrereg(block({ ...DEFAULT_MARGINS, latency_ratio: 1.05 })).latency_ratio).toBe(1.05);
    expect(() => marginsFromPrereg(block({ latency_ratio: 1.05 }))).toThrow(/missing a number/);
    expect(() => marginsFromPrereg('no block')).toThrow(/no/);
  });
  test('a counted run needs a preregistration', () => {
    expect(() => parseArgs(['--scale', '1000'])).toThrow(/--prereg/);
    expect(parseArgs(['--dev']).engines).toEqual(['pglite', 'postgres', 'rust']);
    expect(() => parseArgs(['--dev', '--engines', 'sqlite'])).toThrow(/Unknown engine/);
  });
  test('the rust arm refuses with exit code 3 until the gbrain build carries the engine', () => {
    const r = spawnSync(process.execPath, ['eval/runner/engine-bench/perf.ts', '--dev', '--engines', 'pglite,rust', '--scale', '20'], { cwd: REPO, encoding: 'utf-8', env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }, timeout: 60_000 });
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/rust_kind_unsupported/);
  }, 90_000);
});
