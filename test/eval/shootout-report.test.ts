/**
 * Phase 4 analysis (eval/runner/shootout-report.ts) on synthetic results directories: attempt selection from the
 * results README's Status table, shard and split-cell joins, QA and recall per question, the primary family with
 * crossSystemExclusion, the incomplete, ceiling, pending and not-measurable rules, Holm, the preregistered sentences,
 * the descriptive conversation-clustered pairs, and a smoke run on the committed results. Keyless.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildReport, descriptiveSentence, failedAttempts, loadUnits, PRIMARY_ARM, qaValue, recallValue, renderMarkdown, runFamily, selectAttempt, summarizeUnit, VENDORS, type Row } from '../../eval/runner/shootout-report.ts';
import type { CellSpec } from '../../eval/runner/shootout-cell.ts';
import { holmAdjusted } from '../../eval/runner/stats/paired.ts';

const ROOT = resolve(import.meta.dir, '../..');
const tmp = mkdtempSync(join(tmpdir(), 'shootout-report-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;

const ARMS = ['fixed-evidence.native.b8000.main', 'fixed-evidence.rehydrated.b8000.main', 'vendor-default.native.bnone.main', 'vendor-default.rehydrated.bnone.main'];
type Q = { qa?: number; outcome?: string; recall?: number | null; abstention?: boolean };
/** 100 LME-S-style questions; `f(i)` overrides one question. */
const questions = (f: (i: number) => Q = () => ({}), count = 100, conversations?: number): Row[] => Array.from({ length: count }, (_, i) => {
  const q = { qa: 0.5, outcome: 'scored', recall: 1, abstention: i < 4, ...f(i) };
  return { id: `q${String(i).padStart(3, '0')}`, conversation: conversations ? `c${i % conversations}` : `q${i}`, category: 'x', abstention: q.abstention, gold_count: q.abstention ? 0 : 1, outcome: q.outcome,
    ...(q.outcome === 'scored' || q.outcome === 'ingest_degraded' ? { qa_score: q.qa, qa_input_tokens: 1000, qa_output_tokens: 20, qa_context_tokens: 900, latency_ms: 100 + i, provider: { usd: 0.0001 } } : {}),
    ...(q.recall === null ? { recall_measurable: false } : q.abstention ? {} : { recall_all_at_5: q.recall, recall_all_at_10: q.recall }) };
});

interface Source { rows: Row[] | Record<string, Row[]>; provenance?: string; ingestUsd?: number; armStatus?: string }
function writeAttempt(results: string, cell: string, lease: string, sources: Source[], committed = 1, settled = true) {
  const dir = join(results, cell, `${cell}-${lease}`);
  const write = (src: string, s: Source) => {
    const byArm = Array.isArray(s.rows) ? Object.fromEntries(ARMS.map(a => [a, s.rows as Row[]])) : s.rows;
    for (const [arm, rows] of Object.entries(byArm)) {
      mkdirSync(join(src, 'arms', arm), { recursive: true });
      writeFileSync(join(src, 'arms', arm, 'rows.ndjson.gz'), gzipSync(rows.map(r => JSON.stringify({ ...r, arm })).join('\n') + '\n'));
      writeFileSync(join(src, 'arms', arm, 'receipt.json'), JSON.stringify({ run_status: s.armStatus ?? 'complete' }));
    }
    writeFileSync(join(src, 'receipt.json'), JSON.stringify({ run_status: 'complete', started_at: '2026-10-07T00:00:00Z', finished_at: '2026-10-07T00:30:00Z',
      system: { capabilities: { provenance: { status: s.provenance ?? 'exact' } } }, ingest: { usd: s.ingestUsd ?? 0.5, conversations: 2, degraded_conversations: 0 } }));
  };
  mkdirSync(dir, { recursive: true });
  if (sources.length > 1) sources.forEach((s, i) => { mkdirSync(join(dir, `shard-${i}`), { recursive: true }); write(join(dir, `shard-${i}`), s); });
  else write(dir, sources[0]);
  if (settled) writeFileSync(join(dir, 'lease-summary.json'), JSON.stringify({ lease_usd: 10, committed_usd: committed }));
}

const cell = (id: string, system: string, config: string, benchmark: string): CellSpec => ({ id, system, config, benchmark, lease_usd: 1, command: 'bun eval/runner/memory-qa/run.ts' });
const README = (rows: string[]) => `# results\n\n## Status\n\n| Cell | Lease | Status |\n|---|---|---|\n${rows.join('\n')}\n\n## Changelog\n\n| \`not-a-status\` | \`a1-0\` | x |\n`;

/** A synthetic LME-S campaign: master, pin, five vendors, three controls. */
function lmeCampaign(over: Partial<Record<string, Source[] | null>> = {}, readmeRows: string[] = []) {
  const results = join(tmp, `results-${++n}`);
  const systems: Array<[string, string]> = [['gbrain-shootout-master', 'common'], ['gbrain-shootout', 'common'], ...VENDORS.map(v => [v, 'common'] as [string, string]), ['full-context', 'control'], ['plain-hybrid', 'control'], ['no-memory', 'control']];
  const cells: CellSpec[] = [];
  for (const [system, config] of systems) {
    const id = `${system}-${config}-lme-s`;
    cells.push(cell(id, system, config, 'lme-s'));
    const src = over[system] === undefined ? [{ rows: questions() }] : over[system];
    if (src) writeAttempt(results, id, 'a1-00000001', src);
  }
  writeFileSync(join(results, 'README.md'), README(readmeRows));
  return { results, cells, ...loadUnits(results, cells, README(readmeRows)) };
}
const report = (c: ReturnType<typeof lmeCampaign>) => buildReport(c.units, c.attempts, { resultsDir: c.results, campaignSha: 'f'.repeat(64) });
const pair = (r: ReturnType<typeof report>, family: string, system: string) => r.families.find(f => f.id === family)!.pairs.find(p => p.system.startsWith(system))!;

describe('attempt selection', () => {
  test('the Status table lists failed attempts (full lease ids or attempt prefixes); the latest unlisted settled attempt is used, else pending', () => {
    const results = join(tmp, 'attempts');
    writeAttempt(results, 'extract-first-common-locomo-r1', 'a1-757e7284', [{ rows: questions() }]);
    writeAttempt(results, 'extract-first-common-locomo-r1', 'a2-7c50fc54', [{ rows: questions() }]);
    writeAttempt(results, 'memory-bank-common-lme-s', 'a2-18ab0d18', [{ rows: questions() }]);
    writeAttempt(results, 'graph-pipeline-common-lme-s', 'a1-11111111', [{ rows: questions() }], 1, false);
    const failed = failedAttempts(README(['| `extract-first-common-locomo-r1` | `a1-757e7284` | harness failure: finish timeouts |', '| `memory-bank-common-lme-s` | `a2` | 340 of 400 rows retrieval_error |']));
    expect([...failed.keys()]).toEqual(['extract-first-common-locomo-r1', 'memory-bank-common-lme-s']);
    expect(selectAttempt(results, 'extract-first-common-locomo-r1', failed)).toMatchObject({ used: { lease: 'extract-first-common-locomo-r1-a2-7c50fc54' }, failed: [{ lease: 'a1-757e7284' }] });
    expect(selectAttempt(results, 'memory-bank-common-lme-s', failed)).toMatchObject({ used: null, failed: [{ lease: 'a2' }] });
    expect(selectAttempt(results, 'graph-pipeline-common-lme-s', failed)).toMatchObject({ used: null, unlisted_unsettled: ['graph-pipeline-common-lme-s-a1-11111111'] });
    expect(selectAttempt(results, 'never-ran', failed).used).toBeNull();
  });
});

describe('per-question values', () => {
  test('product failures score 0, ingest_degraded keeps its score, harness failures and missing rows are excluded; recall needs gold', () => {
    const r = (over: Partial<Row>) => ({ id: 'x', abstention: false, gold_count: 1, qa_score: 0.7, recall_all_at_5: 1, ...over }) as Row;
    expect([qaValue(r({ outcome: 'scored' })).value, qaValue(r({ outcome: 'ingest_degraded' })).value, qaValue(r({ outcome: 'retrieval_error', qa_score: undefined })).value, qaValue(r({ outcome: 'unsupported' })).value]).toEqual([0.7, 0.7, 0, 0]);
    expect(qaValue(r({ outcome: 'reader_error' }))).toEqual({ value: null, reason: 'harness error: reader_error' });
    expect(qaValue(undefined)).toEqual({ value: null, reason: 'harness error: no row' });
    expect(recallValue(r({ outcome: 'scored', abstention: true, gold_count: 0 })).reason).toBe('no gold sessions');
    expect(recallValue(r({ outcome: 'retrieval_error' })).value).toBe(0);
    expect(recallValue(r({ outcome: 'scored', recall_measurable: false })).reason).toBe('recall not measurable');
  });
});

describe('families', () => {
  test('primary: a better vendor reads higher after Holm, sentences follow the preregistered templates, and the pin family runs the same pairs', () => {
    const c = lmeCampaign({ 'extract-first': [{ rows: questions(i => ({ qa: i % 10 < 8 ? 1 : 0.5 })) }], 'graph-pipeline': [{ rows: questions(() => ({ qa: 0.5 })) }] });
    const r = report(c);
    const primary = r.families[0];
    expect(primary.holm_family).toEqual(VENDORS.map(v => `${v}:lme-s`));
    expect(primary.pairs.map(p => p.p_holm)).toEqual(holmAdjusted(primary.pairs.map(p => p.p_two_sided!)));
    expect(pair(r, 'primary', 'extract-first')).toMatchObject({ reading: 'system higher', mean_system: 0.9, mean_gbrain: 0.5, delta: 0.4, n_pairs: 100 });
    expect(pair(r, 'primary', 'graph-pipeline')).toMatchObject({ reading: 'not distinguishable', delta: 0, p_two_sided: 1 });
    expect(r.sentences.primary[1]).toMatch(/^On the LongMemEval-S slice, with the same reader and 8,000 tokens of each system's own evidence, extract-first common answered more questions correctly than gbrain \(90\.0% vs 50\.0%, difference 40\.0 points, 95% interval /);
    expect(r.sentences.primary[4]).toMatch(/^On this slice we could not tell graph-pipeline common and gbrain apart \(50\.0% vs 50\.0%\); a difference smaller than about /);
    expect(r.families[1].id).toBe('pin');
    expect(r.sentences.pin[1]).toContain('gbrain at the pin (739e5cc)');
    expect(r.sentences.overall).toBe('A workload-by-workload finding, not a leaderboard: no system is favored on every primary comparison.');
  });

  test('a harness failure on any run excludes the question from every pair; past 5% the pair is incomplete, keeps its numbers and stays in Holm', () => {
    const c = lmeCampaign({ 'extract-first': [{ rows: questions(i => (i >= 90 ? { outcome: 'reader_error' } : { qa: 1 })) }], 'memory-bank': [{ rows: questions(i => (i === 50 ? { outcome: 'judge_error' } : {})) }] });
    const r = report(c);
    expect(r.families[0].excluded_questions).toBe(11);
    for (const v of VENDORS) expect(pair(r, 'primary', v)).toMatchObject({ n_pairs: 89, excluded_family: 11, reading: 'incomplete' });
    expect(pair(r, 'primary', 'extract-first').delta).toBe(0.5);
    expect(r.families[0].holm_family).toHaveLength(5);
    expect(r.sentences.primary[1]).toBe('The comparison of extract-first common and gbrain is incomplete: 11 of 100 questions excluded for harness failures in the family (more than 5%).');
  });

  test('a pending vendor makes the family provisional (Holm over the rest), a failed attempt never counts, and both at 95% or more is a ceiling', () => {
    const c = lmeCampaign({ 'memory-bank': [{ rows: questions(() => ({ qa: 0 })) }], 'gbrain-shootout-master': [{ rows: questions(() => ({ qa: 1 })) }], 'temporal-graph': [{ rows: questions(() => ({ qa: 0.96 })) }] },
      ['| `memory-bank-common-lme-s` | `a1-00000001` | harness failure |']);
    const r = report(c);
    expect(pair(r, 'primary', 'memory-bank')).toMatchObject({ status: 'pending', reading: 'pending' });
    expect(r.families[0]).toMatchObject({ provisional: true, holm_family: ['markdown-notes:lme-s', 'extract-first:lme-s', 'temporal-graph:lme-s', 'graph-pipeline:lme-s'] });
    expect(pair(r, 'primary', 'temporal-graph').reading).toBe('ceiling');
    expect(r.sentences.primary[2]).toBe('Both answered nearly every question on this slice; it cannot separate temporal-graph common and gbrain.');
    expect(r.sentences.overall).toMatch(/^Provisional/);
    expect(r.attempts.find(a => a.cell === 'memory-bank-common-lme-s')).toMatchObject({ used: null, failed: [{ lease: 'a1-00000001' }] });
  });

  test('S1: product failures count 0 recall; a system with no measurable recall leaves the family; abstentions never pair', () => {
    const c = lmeCampaign({ 'graph-pipeline': [{ rows: questions(() => ({ recall: null })) }], 'extract-first': [{ rows: questions(i => (i === 10 ? { outcome: 'retrieval_error' } : {})) }] });
    const r = report(c);
    const s1 = r.families.find(f => f.id === 'S1')!;
    expect(pair(r, 'S1', 'graph-pipeline')).toMatchObject({ status: 'not-measurable', reading: 'not measurable' });
    expect(s1.holm_family).not.toContain('graph-pipeline:lme-s');
    expect(pair(r, 'S1', 'extract-first')).toMatchObject({ n_pairs: 96, mean_system: round4(95 / 96), mean_gbrain: 1 });
    expect(r.sentences.s1.find(s => s.includes('graph-pipeline'))).toContain('not measurable');
  });

  test('S2 pairs each control arm with the gbrain rehydrated arm; the delta is control minus gbrain', () => {
    const c = lmeCampaign({ 'no-memory': [{ rows: { 'vendor-default.native.bnone.main': questions(() => ({ qa: 0 })) } }], 'full-context': [{ rows: { 'fixed-evidence.rehydrated.b8000.main': questions(() => ({ qa: 0.5 })), 'vendor-default.rehydrated.bnone.main': questions(() => ({ qa: 0.5 })) } }] });
    const s2 = report(c).families.find(f => f.id === 'S2')!;
    expect(s2.pairs.map(p => [p.arm_system, p.arm_gbrain])).toEqual([
      ['fixed-evidence.rehydrated.b8000.main', 'fixed-evidence.rehydrated.b8000.main'], ['vendor-default.rehydrated.bnone.main', 'vendor-default.rehydrated.bnone.main'],
      ['fixed-evidence.rehydrated.b8000.main', 'fixed-evidence.rehydrated.b8000.main'], ['vendor-default.rehydrated.bnone.main', 'vendor-default.rehydrated.bnone.main'], ['vendor-default.native.bnone.main', 'fixed-evidence.rehydrated.b8000.main']]);
    expect(s2.pairs[4]).toMatchObject({ delta: -0.5, reading: 'gbrain higher' });
  });
});

const round4 = (x: number) => Math.round(x * 10000) / 10000;

describe('system rows', () => {
  test('shards inside a cell and split shard cells join into one row; a missing shard cell makes the row pending', () => {
    const results = join(tmp, 'shards');
    const half = (from: number) => questions().slice(from, from + 50);
    writeAttempt(results, 'graph-pipeline-common-lme-s-shard0of2', 'a1-00000001', [{ rows: half(0), ingestUsd: 1 }], 2);
    writeAttempt(results, 'graph-pipeline-common-lme-s-shard1of2', 'a1-00000002', [{ rows: half(50), ingestUsd: 2 }], 3);
    writeAttempt(results, 'extract-first-common-lme-s', 'a1-00000003', [{ rows: half(0), ingestUsd: 0.25 }, { rows: half(50), ingestUsd: 0.25 }], 4);
    const cells = [cell('graph-pipeline-common-lme-s-shard0of2', 'graph-pipeline', 'common', 'lme-s'), cell('graph-pipeline-common-lme-s-shard1of2', 'graph-pipeline', 'common', 'lme-s'), cell('extract-first-common-lme-s', 'extract-first', 'common', 'lme-s'),
      cell('markdown-notes-common-lme-s-shard0of2', 'markdown-notes', 'common', 'lme-s'), cell('markdown-notes-common-lme-s-shard1of2', 'markdown-notes', 'common', 'lme-s')];
    writeAttempt(results, 'markdown-notes-common-lme-s-shard0of2', 'a1-00000004', [{ rows: half(0) }]);
    const { units } = loadUnits(results, cells, README([]));
    const graphPipeline = summarizeUnit(units.get('graph-pipeline|common|lme-s|r1')!), extractFirst = summarizeUnit(units.get('extract-first|common|lme-s|r1')!);
    expect([graphPipeline.status, graphPipeline.ingest_usd, graphPipeline.cell_usd, graphPipeline.cell_wall_minutes, graphPipeline.arms[0].rows]).toEqual(['settled', 3, 5, 60, 100]);
    expect([extractFirst.ingest_usd, extractFirst.cell_usd, extractFirst.cell_wall_minutes, extractFirst.arms[0].rows, extractFirst.arms[0].qa_service, extractFirst.arms[0].latency_p50_ms]).toEqual([0.5, 4, 30, 100, 0.5, 149.5]);
    expect(summarizeUnit(units.get('markdown-notes|common|lme-s|r1')!)).toMatchObject({ status: 'pending', pending_cells: ['markdown-notes-common-lme-s-shard1of2'] });
  });

  test('the Markdown names pending rows and failed attempts', () => {
    const c = lmeCampaign({ 'temporal-graph': null }, ['| `extract-first-common-lme-s` | `a0-deadbeef` | an earlier lost launch |']);
    const md = renderMarkdown(report(c));
    expect(md).toContain('| lme-s | temporal-graph | common | 1 | | pending (temporal-graph-common-lme-s) |');
    expect(md).toContain('`a0-deadbeef`: an earlier lost launch');
    expect(md).not.toContain('\u2014');
  });
});

describe('descriptive', () => {
  test('LoCoMo and BEAM pairs cluster by conversation, with no test, and use the preregistered sentence', () => {
    const results = join(tmp, 'desc');
    const cells = [cell('extract-first-common-locomo-r1', 'extract-first', 'common', 'locomo'), cell('gbrain-shootout-master-common-locomo-r1', 'gbrain-shootout-master', 'common', 'locomo')];
    writeAttempt(results, cells[0].id, 'a1-00000001', [{ rows: questions(() => ({ qa: 0.75 }), 30, 3) }]);
    writeAttempt(results, cells[1].id, 'a1-00000002', [{ rows: questions(() => ({ qa: 0.5 }), 30, 3) }]);
    const { units, attempts } = loadUnits(results, cells, README([]));
    const r = buildReport(units, attempts, { resultsDir: results, campaignSha: '0'.repeat(64) });
    const d = r.descriptive.find(x => x.system === 'extract-first')!;
    expect(d).toMatchObject({ conversations: 3, a: 0.75, b: 0.5, arm: PRIMARY_ARM });
    expect(d.paired).toMatchObject({ n_clusters: 3, delta: 0.25 });
    expect(d.paired!.p_holm).toBeUndefined();
    expect(d.sentence).toBe('On LoCoMo dev (three conversations), extract-first common scored 75.0% and gbrain 50.0%. Three conversations describe these systems on these conversations; they cannot rank them.');
    expect(descriptiveSentence('beam-100k', 6, 'x common', null, null)).toBe('On BEAM-100K dev (six conversations), x common: pending.');
    const fam = runFamily({ id: 't', role: 't', benchmark: 'locomo', metric: 'qa_service', cluster: 'conversation', holm: false, pairs: [] });
    expect(fam.pairs).toEqual([]);
  });
});

describe('committed results (smoke)', () => {
  test('the CLI reads the committed Phase 4 results and writes the JSON and Markdown', async () => {
    const out = join(tmp, 'cli');
    const proc = Bun.spawn([process.execPath, 'eval/runner/shootout-report.ts', '--output', out], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
    const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(code, err).toBe(0);
    const r = JSON.parse(readFileSync(join(out, 'shootout-report.json'), 'utf8'));
    expect(r.families.map((f: { id: string }) => f.id)).toEqual(['primary', 'pin', 'S1', 'S2']);
    expect(r.families[0].pairs).toHaveLength(5);
    expect(r.attempts.find((a: { cell: string }) => a.cell === 'extract-first-common-locomo-r1').used.lease).toBe('extract-first-common-locomo-r1-a2-7c50fc54');
    expect(readFileSync(join(out, 'shootout-report.md'), 'utf8')).toContain('## What the report may say');
  }, 120_000);
});
