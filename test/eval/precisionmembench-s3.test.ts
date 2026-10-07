/**
 * Family S3 analysis (eval/runner/precisionmembench-s3.ts) on synthetic PrecisionMemBench rows: pairing on the 43
 * search-only cases, harness-failure and undefined-metric exclusions, the incomplete rule, the not-measurable rule
 * leaving the Holm family, Holm across the family, both baselines, structural categories without tests, the refusal
 * of mixed fixtures, and the CLI on real runner output. Keyless.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { analyzeS3, loadRun, noProvenanceShare, renderMarkdown, S3_DRAWS, S3_SEED, type PmbRun } from '../../eval/runner/precisionmembench-s3.ts';
import { familyOf, FIXTURE_CASES, parsePmbArgs, runPmb, type PmbRow } from '../../eval/runner/precisionmembench-system.ts';
import { holmAdjusted } from '../../eval/runner/stats/paired.ts';
import type { RetrievalCase } from '../../eval/precisionmembench/scorer/runCases.ts';
import type { Outcome } from '../../eval/runner/memory-qa/outcomes.ts';

const ROOT = resolve(import.meta.dir, '../..');
const tmp = mkdtempSync(join(tmpdir(), 'pmb-s3-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const cases = JSON.parse(readFileSync(FIXTURE_CASES, 'utf8')) as RetrievalCase[];
const searchOnly = cases.filter(c => familyOf(c.category) === 'search-only');
const SHA = { fixture: { 'fixtures/retrieval.cases.json': 'f' }, scorer: { 'scorer/runCases.ts': 's' } };

type Cell = { precision?: number | null; recall?: number | null; outcome?: Outcome; items?: number; cited?: number; measurable?: boolean };
/** A synthetic run: every case scored with precision 0.5 and recall 0.5 unless `cell` says otherwise. */
function synth(name: string, cell: (c: RetrievalCase, i: number) => Cell = () => ({}), over: Partial<PmbRun> = {}): PmbRun {
  const rows = cases.map((c, i) => {
    const x = { precision: 0.5, recall: 0.5, outcome: 'scored' as Outcome, items: 4, cited: 4, measurable: true, ...cell(c, i) };
    return { id: c.caseId, case_id: c.caseId, category: c.category, family: familyOf(c.category), outcome: x.outcome, precision: x.precision, recall: x.recall, passed: false,
      system_called: true, items_returned: x.items, items_cited: x.cited, provenance_measurable: x.measurable } as unknown as PmbRow;
  });
  return { dir: `/runs/${name}`, name, config: 'common', build: null, run_status: 'complete', fixture_sha256: SHA.fixture, scorer_sha256: SHA.scorer, rows, ...over };
}
const gbrainRun = (build: string, cell?: (c: RetrievalCase, i: number) => Cell) => synth('gbrain-shootout', cell, { config: 'gbrain-shootout openai:text-embedding-3-large@1536', build });
const comparison = (v: ReturnType<typeof analyzeS3>, baseline: string, id: string) => v.families.find(f => f.baseline === baseline)!.comparisons.find(c => c.id === id)!;

describe('S3 pairing and tests', () => {
  test('a system better on every search-only case reads higher after Holm; equal recall is not distinguishable', () => {
    const v = analyzeS3({ master: gbrainRun('c5fb020'), systems: [synth('mem0', () => ({ precision: 1 }))] });
    const p = comparison(v, 'master', 'mem0:precision');
    expect(searchOnly).toHaveLength(43);
    expect(p).toMatchObject({ status: 'tested', n_pairs: 43, n_clusters: 43, mean_system: 1, mean_gbrain: 0.5, delta: 0.5, reading: 'system higher', p_method: 'monte-carlo-sign-flip' });
    expect(p.p_two_sided).toBeCloseTo(1 / (S3_DRAWS + 1), 10);
    expect(comparison(v, 'master', 'mem0:recall')).toMatchObject({ delta: 0, p_two_sided: 1, reading: 'not distinguishable' });
    expect(v.method.test).toContain(String(S3_SEED));
  });

  test('as in the primary family, a harness failure on any run excludes that case from every pair of the family', () => {
    const failsIn = (ids: string[]) => (c: RetrievalCase) => ids.includes(c.caseId) ? { outcome: 'harness_invalid' as Outcome } : { precision: 1 };
    const [x, y] = searchOnly.map(c => c.caseId);
    const v = analyzeS3({ master: gbrainRun('m'), systems: [synth('hindsight', failsIn([x])), synth('cognee', failsIn([y]))] });
    expect(v.families[0].excluded_cases).toEqual([x, y].sort());
    expect(v.families[0].exclusion_runs).toEqual(['gbrain-shootout', 'hindsight', 'cognee']);
    for (const id of ['hindsight:precision', 'cognee:precision', 'hindsight:recall']) expect(comparison(v, 'master', id)).toMatchObject({ n_pairs: 41, excluded: { cross_system: 2 }, reading: id.endsWith('recall') ? 'not distinguishable' : 'system higher' });
    const md = renderMarkdown(v);
    expect(md).toContain('Cases excluded from every pair for harness failures on any run in this family: 2');
  });

  test('3 or more of 43 excluded, or a run invalid or incomplete, reads incomplete with its numbers, no direction, and stays in Holm', () => {
    const three = new Set(searchOnly.slice(0, 3).map(c => c.caseId));
    const v = analyzeS3({ master: gbrainRun('m', c => three.has(c.caseId) ? { outcome: 'budget_not_run' } : {}), systems: [synth('mem0', () => ({ precision: 1 }))] });
    const c = comparison(v, 'master', 'mem0:precision');
    expect(c).toMatchObject({ n_pairs: 40, excluded: { cross_system: 3 }, reading: 'incomplete', delta: 0.5 });
    expect(c.reasons[0]).toContain('3 of 43');
    expect(v.families[0].holm_family).toContain('mem0:precision');
    expect(c.p_holm).toBeDefined();
    const partial = analyzeS3({ master: gbrainRun('m'), systems: [synth('mem0', () => ({ precision: 1 }), { run_status: 'invalid' })] });
    expect(comparison(partial, 'master', 'mem0:precision')).toMatchObject({ reading: 'incomplete', reasons: ['mem0 run is invalid'] });
    expect(partial.families[0].holm_family).toContain('mem0:precision');
  });

  test('a missing row counts as a harness failure in the join; a not-measurable system stays out of it', () => {
    const blind = synth('cognee', c => c.caseId === searchOnly[1].caseId ? { outcome: 'harness_invalid', items: 0, cited: 0 } : { precision: null, recall: null, cited: 0, measurable: false });
    const short = synth('mem0');
    short.rows = short.rows.filter(r => r.case_id !== searchOnly[0].caseId);
    const v = analyzeS3({ master: gbrainRun('m'), systems: [short, blind] });
    expect(v.families[0].excluded_cases).toEqual([searchOnly[0].caseId]);
    expect(v.families[0].exclusion_runs).toEqual(['gbrain-shootout', 'mem0']);
  });

  test('an undefined metric on either side drops that case from that metric and is counted per side', () => {
    const [a, b, c] = searchOnly.map(x => x.caseId);
    const v = analyzeS3({ master: gbrainRun('m', x => x.caseId === a || x.caseId === c ? { precision: null } : {}), systems: [synth('graphiti', x => x.caseId === b || x.caseId === c ? { precision: null } : {})] });
    expect(comparison(v, 'master', 'graphiti:precision')).toMatchObject({ n_pairs: 40, excluded: { undefined_gbrain: 1, undefined_system: 1, undefined_both: 1 } });
    expect(comparison(v, 'master', 'graphiti:recall').n_pairs).toBe(43);
  });

  test('a system whose items all lack provenance is not measurable and leaves the Holm family; Holm runs over the rest', () => {
    const blind = synth('cognee', () => ({ precision: null, recall: null, cited: 0, measurable: false }));
    const v = analyzeS3({ master: gbrainRun('m'), systems: [synth('mem0', (_c, i) => ({ precision: i % 3 ? 0.6 : 0.5 })), synth('graphiti', (_c, i) => ({ recall: i % 2 ? 0.7 : 0.4 })), blind] });
    const f = v.families[0];
    expect(f.holm_family).toEqual(['mem0:precision', 'mem0:recall', 'graphiti:precision', 'graphiti:recall']);
    expect(comparison(v, 'master', 'cognee:precision')).toMatchObject({ status: 'not-measurable', reading: 'not measurable', no_provenance_share: 1 });
    const tested = f.comparisons.filter(c => c.status === 'tested');
    expect(tested.map(c => c.p_holm)).toEqual(holmAdjusted(tested.map(c => c.p_two_sided!)));
    expect(v.runs.find(r => r.name === 'cognee')!.provenance).toBe('not measurable');
  });

  test('pin and master are separate families with their own Holm; master is the preregistered one', () => {
    const v = analyzeS3({ master: gbrainRun('c5fb020', () => ({ precision: 0.2 })), pin: gbrainRun('739e5cc', () => ({ precision: 0.9 })), systems: [synth('mem0')] });
    expect(v.families.map(f => [f.baseline, f.gbrain.build, f.holm_family.length])).toEqual([['master', 'c5fb020', 2], ['pin', '739e5cc', 2]]);
    expect(v.families[0].role).toContain('preregistered family S3');
    expect(comparison(v, 'master', 'mem0:precision').reading).toBe('system higher');
    expect(comparison(v, 'pin', 'mem0:precision').reading).toBe('gbrain higher');
  });

  test('structural categories are summarized without tests; uncited share is reported beside precision', () => {
    const v = analyzeS3({ master: gbrainRun('m'), systems: [synth('graphiti', () => ({ items: 10, cited: 7 }))] });
    const s = v.structural.find(x => x.system === 'graphiti')!;
    expect(s.all.cases).toBe(34);
    expect(JSON.stringify(s)).not.toContain('p_');
    expect(comparison(v, 'master', 'graphiti:precision').no_provenance_share).toBe(0.3);
    expect(noProvenanceShare([])).toEqual({ items: 0, uncited: 0, share: null });
    const md = renderMarkdown(v);
    expect(md).toContain('| graphiti | precision | 43 |');
    expect(md).toContain('30.0%');
    expect(md).toContain('## Structural categories (no tests)');
    expect(md).not.toContain('\u2014');
  });

  test('runs on a different fixture or scorer are refused; a non-common config is a warning', () => {
    expect(() => analyzeS3({ master: gbrainRun('m'), systems: [synth('mem0', undefined, { fixture_sha256: { x: 'y' } })] })).toThrow(/different fixture or scorer/);
    expect(() => analyzeS3({ master: gbrainRun('m'), systems: [synth('mem0'), synth('mem0')] })).toThrow(/more than once/);
    expect(analyzeS3({ master: gbrainRun('m'), systems: [synth('mem0', undefined, { config: 'recipe' })] }).warnings).toEqual(['mem0 ran config recipe; S3 compares common configurations']);
  });
});

describe('S3 CLI on real runner output', () => {
  test('loads precisionmembench-system run directories and writes the verdict and the table', async () => {
    const dirs = ['baseline', 'system'].map(n => join(tmp, n));
    for (const d of dirs) await runPmb(parsePmbArgs(['--system', 'fake', '--output', d]));
    const run = loadRun(dirs[1]);
    expect([run.name, run.rows.length, run.run_status]).toEqual(['fake', 77, 'complete']);
    const renamed = join(tmp, 'system-b');
    mkdirSync(renamed, { recursive: true });
    const receipt = JSON.parse(readFileSync(join(dirs[1], 'receipt.json'), 'utf8'));
    receipt.system.capability_system = 'fake-b';
    writeFileSync(join(renamed, 'receipt.json'), JSON.stringify(receipt));
    writeFileSync(join(renamed, 'rows.ndjson'), readFileSync(join(dirs[1], 'rows.ndjson')));
    const out = join(tmp, 's3');
    const proc = Bun.spawn([process.execPath, 'eval/runner/precisionmembench-s3.ts', '--master', dirs[0], '--pin', dirs[0], '--system', dirs[1], '--system', renamed, '--output', out], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
    const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(code, err).toBe(0);
    const v = JSON.parse(readFileSync(join(out, 's3-verdict.json'), 'utf8'));
    expect(v.families.map((f: any) => f.holm_family.length)).toEqual([4, 4]);
    expect(v.families[0].comparisons.every((c: any) => c.delta === 0 && c.reading === 'not distinguishable')).toBe(true);
    expect(readFileSync(join(out, 's3-table.md'), 'utf8')).toContain('# PrecisionMemBench, family S3');
  }, 60_000);
});
