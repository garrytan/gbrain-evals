/**
 * Q1 scoreboard generator (eval/runner/scoreboard.ts): the full derivation
 * chain on synthetic receipts, the four check mutations (raw score,
 * exclusion, missing cell, configuration identity), claim rules, pairwise
 * cohorts, explain, the pin table, the size budget, release assets and the
 * secret scan inside check. Every receipt here is synthetic.
 */
import { describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { checkPinTable, checkReceipt, checkSize, derive, explain, README_BEGIN, README_END, renderAll, loadCampaign, type CampaignManifest, type Scoreboard } from '../../eval/runner/scoreboard.ts';
import { defaultCells, fieldCells, READERS, writeSyntheticReceipt, type SyntheticOptions } from './fixtures/scoreboard/synthetic.ts';

const ROOT = resolve(import.meta.dir, '../..');

function fresh(o: SyntheticOptions = {}): { dir: string; sb: Scoreboard } {
  const dir = mkdtempSync(join(tmpdir(), 'scoreboard-'));
  writeSyntheticReceipt(dir, o);
  const { campaign } = loadCampaign(dir);
  const sb = derive(dir);
  for (const f of renderAll(dir, sb, campaign).files) writeFileSync(f.path, f.text);
  return { dir, sb };
}

const codes = (dir: string, env: Record<string, string> = {}) => checkReceipt(dir, env).messages.map(m => m.code);
const editJson = (path: string, f: (x: CampaignManifest) => void) => { const x = JSON.parse(readFileSync(path, 'utf8')); f(x); writeFileSync(path, JSON.stringify(x, null, 2) + '\n'); };

describe('does_not_fit is not applicable', () => {
  test('a history that did not fit a reader\'s window leaves that cell\'s denominator, is counted and shown, never a judge error', () => {
    const cells = defaultCells().map(c => (c.id === 's2a-full-context' ? { ...c, doesNotFit: { questions: [0, 1, 2, 3, 4, 5, 6], readers: ['claude-opus-5-5'] } } : c));
    const { dir, sb } = fresh({ cells });
    const fc = sb.cells.find(c => c.cell_id === 's2a-full-context')!;
    expect(fc.harness_failures).toBe(0);
    expect(fc.product_failures).toBe(0);
    expect(fc.not_applicable).toEqual({ 'claude-opus-5-5': 7 });
    expect(fc.valued).toBe(fc.scheduled - 7);
    expect(fc.complete).toBe(true);
    expect(fc.exclusions).toHaveLength(7);
    expect(fc.exclusions.every(e => e.reason === "not applicable: did not fit claude-opus-5-5's window")).toBe(true);
    expect(readFileSync(join(dir, 'scoreboard.md'), 'utf8')).toContain("complete; 7 did not fit claude-opus-5-5's window");
    expect(sb.cells.find(c => c.cell_id === 's2a-gbrain-8k')!.not_applicable).toEqual({});
    expect(checkReceipt(dir, {}).messages).toEqual([]);
    const plain = fresh().sb.cells.find(c => c.cell_id === 's2a-full-context')!;
    expect(plain.valued).toBe(plain.scheduled);
    rmSync(dir, { recursive: true });
  });

  test('a harness failure on the same question still reads as the harness failure', () => {
    const cells = defaultCells().map(c => (c.id === 's2a-full-context' ? { ...c, harnessFail: [0], doesNotFit: { questions: [0, 1], readers: ['claude-opus-5-5'] } } : c));
    const { dir, sb } = fresh({ cells });
    const fc = sb.cells.find(c => c.cell_id === 's2a-full-context')!;
    expect(fc.exclusions.find(e => e.question_id.endsWith(':q0'))!.reason).toStartWith('harness: reader_error');
    expect(fc.exclusions.find(e => e.question_id.endsWith(':q1'))!.reason).toBe("not applicable: did not fit claude-opus-5-5's window");
    expect(fc.complete).toBe(false);
    rmSync(dir, { recursive: true });
  });
});

describe('derivation chain and check', () => {
  test('a rendered receipt checks clean, and rendering twice is byte-identical', () => {
    const { dir } = fresh();
    expect(checkReceipt(dir, {}).messages).toEqual([]);
    const again = derive(dir);
    expect(readFileSync(join(dir, 'scoreboard.json'), 'utf8')).toBe(JSON.stringify(again, null, 2) + '\n');
    rmSync(dir, { recursive: true });
  });

  test('mutation: one raw judge score changes and check fails', () => {
    const { dir } = fresh();
    const path = join(dir, 'cells/s1-memory-bank-8k/judgments.ndjson');
    const lines = readFileSync(path, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const first = lines.find(j => j.judge_replicate === 0);
    first.score = first.score === 1 ? 0 : 1;
    writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    expect(codes(dir)).toContain('SCOREBOARD_STALE');
    rmSync(dir, { recursive: true });
  });

  test('mutation: a raw score inside a gzipped answers file changes and check fails', () => {
    const { dir } = fresh();
    const path = join(dir, 'cells/s1-extract-first-8k/answers.ndjson.gz');
    const lines = gunzipSync(readFileSync(path)).toString('utf8').trim().split('\n').map(l => JSON.parse(l));
    lines[3].outcome = 'retrieval_error';
    writeFileSync(path, gzipSync(lines.map(l => JSON.stringify(l)).join('\n') + '\n'));
    expect(codes(dir)).toContain('SCOREBOARD_STALE');
    rmSync(dir, { recursive: true });
  });

  test('mutation: an exclusion is added and check fails', () => {
    const { dir } = fresh();
    editJson(join(dir, 'campaign.json'), c => { c.sets[0].exclusions.push({ question_id: '10m-c2:q1', reason: 'mutation' }); });
    expect(codes(dir)).toContain('SCOREBOARD_STALE');
    rmSync(dir, { recursive: true });
  });

  test('mutation: a cell goes missing and check fails, whether its files or its manifest entry disappear', () => {
    const a = fresh();
    rmSync(join(a.dir, 'cells/s1-hybrid-8k/answers.ndjson'));
    expect(codes(a.dir)).toContain('RECEIPT_INVALID');
    const b = fresh();
    editJson(join(b.dir, 'campaign.json'), c => {
      c.cells = c.cells.filter(x => x.cell_id !== 's1-hybrid-8k');
      for (const f of c.families) f.comparators = f.comparators.filter(x => x !== 's1-hybrid-8k');
    });
    expect(codes(b.dir)).toContain('SCOREBOARD_STALE');
    rmSync(a.dir, { recursive: true }); rmSync(b.dir, { recursive: true });
  });

  test('mutation: a configuration identity changes and check fails, edited alone or with its recorded hash', () => {
    const a = fresh();
    const cfg = join(a.dir, 'cells/s1-gbrain-8k/run-config.json');
    writeFileSync(cfg, readFileSync(cfg, 'utf8').replace('"budget":8000', '"budget":7000'));
    expect(codes(a.dir)).toContain('RECEIPT_INVALID');
    const b = fresh();
    const cfgB = join(b.dir, 'cells/s1-gbrain-8k/run-config.json');
    const next = readFileSync(cfgB, 'utf8').replace('"budget":8000', '"budget":7000');
    writeFileSync(cfgB, next);
    editJson(join(b.dir, 'campaign.json'), c => { c.cells[0].config_sha256 = new Bun.CryptoHasher('sha256').update(next).digest('hex'); });
    expect(codes(b.dir)).toContain('SCOREBOARD_STALE');
    rmSync(a.dir, { recursive: true }); rmSync(b.dir, { recursive: true });
  });

  test('a stale scoreboard.json names the first differing field', () => {
    const { dir } = fresh();
    const path = join(dir, 'scoreboard.json');
    writeFileSync(path, readFileSync(path, 'utf8').replace('"verdict": "', '"verdict": "x'));
    const m = checkReceipt(dir, {}).messages.find(x => x.code === 'SCOREBOARD_STALE')!;
    expect(m.message).toContain('verdict');
    expect(m.fix.argv).toEqual(['bun', 'eval/runner/scoreboard.ts', 'render', '--receipt', expect.any(String)]);
    rmSync(dir, { recursive: true });
  });

  test('the README block regenerates inside its markers and check catches an edit to it', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'scoreboard-readme-'));
    const readme = join(tmp, 'README.md');
    writeFileSync(readme, `# Title\n\n${README_BEGIN}\nold\n${README_END}\n\nAfter.\n`);
    const { dir } = fresh({ renderTargets: [readme] });
    const text = readFileSync(readme, 'utf8');
    expect(text).toContain('| Kind and configuration | BEAM-10M accuracy at 8k, three-reader mean |');
    expect(text.endsWith(`${README_END}\n\nAfter.\n`)).toBe(true);
    expect(checkReceipt(dir, {}).messages).toEqual([]);
    writeFileSync(readme, text.replace('three-reader mean |', 'three-reader mean (edited) |'));
    expect(codes(dir)).toContain('SCOREBOARD_STALE');
    rmSync(dir, { recursive: true }); rmSync(tmp, { recursive: true });
  });
});

describe('cohorts, estimand and claim rules', () => {
  test('pairwise cohorts: an adapter failing 6.7% of questions makes only its own comparison incomplete', () => {
    const cells = defaultCells().map(c => (c.id === 's1-extract-first-8k' ? { ...c, harnessFail: [2, 9, 14, 21] } : c));
    const { dir, sb } = fresh({ cells });
    const ef = sb.comparisons.find(c => c.id === 's1-extract-first-8k')!;
    const mb = sb.comparisons.find(c => c.id === 's1-memory-bank-8k')!;
    expect(ef.cohort!.scheduled).toBe(59);
    expect(ef.cohort!.paired).toBe(55);
    expect(ef.claim_eligible).toBe(false);
    expect(ef.outcome).toBe('incomplete');
    expect(ef.sentence).toContain('incomplete');
    expect(ef.cohort!.excluded.map(e => e.question_id)).toContain('10m-c0:q2');
    expect(ef.sensitivity!.worst).toBeLessThan(ef.delta!);
    expect(ef.sensitivity!.best).toBeGreaterThan(ef.delta!);
    expect(mb.cohort!.paired).toBe(59);
    expect(mb.claim_eligible).toBe(true);
    expect(mb.sensitivity!.joint_cohort_n).toBe(55);
    rmSync(dir, { recursive: true });
  });

  test('the preregistered exclusion leaves the scheduled cohort and is published', () => {
    const { dir, sb } = fresh();
    expect(sb.sets[0].preregistered_exclusions).toEqual([{ question_id: '10m-c1:q0', reason: 'gold entered an agent context (exposure record)' }]);
    expect(sb.cells.find(c => c.cell_id === 's1-gbrain-8k')!.scheduled).toBe(59);
    expect(readFileSync(join(dir, 'scoreboard.md'), 'utf8')).toContain('10m-c1:q0 (gold entered an agent context (exposure record))');
    rmSync(dir, { recursive: true });
  });

  test('the estimand is the per-question three-reader mean, and a missing promised reader is never averaged away', () => {
    const cells = defaultCells().map(c => (c.id === 's1-hybrid-8k' ? { ...c, dropReaders: ['gpt-6.1-sol'] } : c));
    const { dir, sb } = fresh({ cells });
    const gb = sb.cells.find(c => c.cell_id === 's1-gbrain-8k')!;
    expect(Object.keys(gb.per_reader)).toEqual(READERS);
    const readerMean = READERS.reduce((s, r) => s + gb.per_reader[r]!, 0) / READERS.length;
    expect(gb.mean!).toBeCloseTo(readerMean, 5);
    const hy = sb.cells.find(c => c.cell_id === 's1-hybrid-8k')!;
    expect(hy.missing_readers).toEqual(['gpt-6.1-sol']);
    expect(hy.valued).toBe(0);
    expect(hy.complete).toBe(false);
    const cmp = sb.comparisons.find(c => c.id === 's1-hybrid-8k')!;
    expect(cmp.claim_eligible).toBe(false);
    expect(cmp.outcome).toBe('incomplete');
    expect(sb.headline.find(h => h.system === 'baseline-hybrid')!.accuracy).toMatch(/^no scored questions|^incomplete/);
    rmSync(dir, { recursive: true });
  });

  test('families stay separate, Holm runs within each, and a non-claiming comparison enters Holm at p = 1', () => {
    const { dir, sb } = fresh();
    expect(sb.families.map(f => [f.id, f.metric])).toEqual([['F1', 'answer'], ['F2', 'answer'], ['F3', 'recall_all_at_10']]);
    const f1 = sb.comparisons.filter(c => c.family === 'F1');
    expect(f1.map(c => c.other)).toEqual(['s1-extract-first-8k', 's1-memory-bank-8k', 's1-temporal-graph-8k', 's1-hybrid-8k', 's1-none-8k']);
    expect(f1.find(c => c.other === 's1-temporal-graph-8k')!.outcome).toBe('not-run');
    for (const c of f1.filter(x => x.p !== null)) expect(c.p_holm!).toBeGreaterThanOrEqual(c.p!);
    expect(sb.comparisons.filter(c => c.family === 'F2').map(c => c.other)).toEqual(['s1-full-context', 's1-file-agent']);
    expect(sb.comparisons.some(c => c.other === 's1-gbrain-think')).toBe(false);
    expect(sb.comparisons.filter(c => c.family === 'F3').every(c => c.sentence.includes('strict recall of all gold sessions at 10') || c.outcome === 'not-run')).toBe(true);
    expect(sb.families.find(f => f.id === 'F1')!.verdict_stability).not.toBeNull();
    rmSync(dir, { recursive: true });
  });

  test('a significant gap uses the preregistered sentence; public sets are only described', () => {
    const { dir, sb } = fresh({ draws: 999 });
    const none = sb.comparisons.find(c => c.id === 's1-none-8k')!;
    expect(none.outcome).toBe('gbrain-ahead');
    expect(none.sentence).toMatch(/^On BEAM-10M, with the same three answer models and 8,000 tokens of each system's own evidence, gbrain-defaults answered more questions correctly than `baseline-none`/);
    const pub = sb.comparisons.find(c => c.id === 's2a-memory-bank-8k')!;
    expect(pub.outcome).toBe('descriptive');
    expect(pub.sentence).toContain('they cannot rank them');
    rmSync(dir, { recursive: true });
  });

  test('a missing external kind blocks every field-wide claim and the table says incomplete', () => {
    const { dir, sb } = fresh();
    expect(sb.field.complete).toBe(false);
    expect(sb.field.missing).toEqual(['ext-graph-pipeline', 'ext-temporal-graph', 'ext-markdown-kb', 'ext-verbatim-session']);
    expect(sb.verdict).toContain('The table is incomplete');
    expect(sb.verdict).not.toContain('beat the field');
    expect(sb.headline.find(h => h.system === 'ext-graph-pipeline')!.accuracy).toBe('not run on BEAM-10M');
    rmSync(dir, { recursive: true });
  });

  test('"beats the field" appears only when every external kind ran and every Family 1 comparison favors gbrain', () => {
    const { dir, sb } = fresh({ cells: fieldCells(), draws: 1999 });
    expect(sb.field.complete).toBe(true);
    expect(sb.comparisons.filter(c => c.family === 'F1').every(c => c.outcome === 'gbrain-ahead')).toBe(true);
    expect(sb.verdict).toContain('gbrain-defaults beat the field');
    rmSync(dir, { recursive: true });
  });

  test('a descriptive power decision removes every superiority claim', () => {
    const { dir, sb } = fresh({ cells: fieldCells(), draws: 999, family1: 'descriptive' });
    expect(sb.comparisons.filter(c => c.family === 'F1').every(c => c.outcome === 'descriptive')).toBe(true);
    expect(sb.verdict).toContain('the component comparison is descriptive');
    expect(sb.verdict).not.toContain('beat the field');
    rmSync(dir, { recursive: true });
  });

  test('a shrunk power decision must match Family 1\'s comparators', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scoreboard-'));
    writeSyntheticReceipt(dir, { family1: 'shrunk', shrunkComparators: ['ext-memory-bank', 'ext-extract-first', 'baseline-hybrid', 'ext-graph-pipeline'] });
    expect(() => derive(dir)).toThrow(/shrink rule kept/);
    rmSync(dir, { recursive: true });
  });

  test('README headline: six columns, plain-word exposure, staleness with a newer release, receipt links', () => {
    const { dir, sb } = fresh();
    const md = readFileSync(join(dir, 'scoreboard.md'), 'utf8');
    const header = md.split('\n').find(l => l.startsWith('| Kind and configuration'))!;
    expect(header.split('|').length - 2).toBe(6);
    expect(md).toContain('- BEAM-10M: never used to tune gbrain.');
    expect(md).toContain('- BEAM-100K sealed: used to choose gbrain settings.');
    expect(sb.staleness).toContain('`ext-memory-bank` 0.10.2 (newer release available: 0.10.3)');
    expect(md).toContain('[cell](./cells/s1-gbrain-8k/receipt.json)');
    expect(md).toContain('| System | BEAM-100K sealed | BEAM-10M |');
    expect(sb.headline[0].label).toContain('shipped defaults, hybrid search');
    rmSync(dir, { recursive: true });
  });
});

describe('explain', () => {
  test('prints the chain behind one number', () => {
    const { dir } = fresh();
    const out = explain(dir, 'ext-memory-bank', 'accuracy') as Record<string, any>;
    expect(out.cell).toBe('s1-memory-bank-8k');
    expect(out.readers).toEqual(READERS);
    expect(out.judge_instrument).toBe('beam-rubric-synthetic-v1');
    expect(out.cohort.paired).toBe(59);
    expect(out.inputs.map((i: { path: string }) => i.path)).toContain('cells/s1-memory-bank-8k/judgments.ndjson');
    expect(out.verify.slice(0, 3)).toEqual(['bun', 'eval/runner/scoreboard.ts', 'check']);
    expect((explain(dir, 'gbrain-defaults', 'size-100k') as Record<string, any>).cell).toBe('s2a-gbrain-8k');
    expect(() => explain(dir, 'nobody', 'accuracy')).toThrow(/unknown row/);
    expect(() => explain(dir, 'gbrain-defaults', 'vibes')).toThrow(/unknown column/);
    rmSync(dir, { recursive: true });
  });
});

describe('receipt guards inside check', () => {
  test('a run-time key value planted in a gzipped receipt fails check without printing it', () => {
    const { dir } = fresh();
    const value = Array.from({ length: 48 }, (_, i) => 'abcdefghijkLMNOPQRSTUV0123456789'[(i * 7 + 3) % 32]).join('');
    const path = join(dir, 'cells/s1-gbrain-8k/notices.ndjson.gz');
    writeFileSync(path, gzipSync(`{"notice":"config ${value} end"}\n`));
    const result = checkReceipt(dir, { OPENAI_API_KEY: value });
    const m = result.messages.find(x => x.code === 'SECRET_IN_RECEIPT')!;
    expect(m.fix.next).toBe('ask_user');
    expect(JSON.stringify(result)).not.toContain(value);
    expect(JSON.stringify(result)).not.toContain(value.slice(0, 12));
    rmSync(dir, { recursive: true });
  });

  test('size budget: a file over 50 MB or a tree over 60 MB fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scoreboard-size-'));
    writeFileSync(join(dir, 'a.bin'), '');
    truncateSync(join(dir, 'a.bin'), 51 * 1024 * 1024);
    expect(checkSize(dir).map(m => m.message)).toEqual([expect.stringContaining('over the 50 MB file limit')]);
    truncateSync(join(dir, 'a.bin'), 40 * 1024 * 1024);
    writeFileSync(join(dir, 'b.bin'), '');
    truncateSync(join(dir, 'b.bin'), 30 * 1024 * 1024);
    expect(checkSize(dir).map(m => m.message)).toEqual([expect.stringContaining('over the 60 MB receipt budget')]);
    mkdirSync(join(dir, 'release-assets'));
    cpSync(join(dir, 'b.bin'), join(dir, 'release-assets/b.bin'));
    rmSync(join(dir, 'b.bin'));
    expect(checkSize(dir)).toEqual([]);
    rmSync(dir, { recursive: true });
  });

  test('release assets are verified when present and skipped when absent', () => {
    const body = 'contexts';
    const digest = new Bun.CryptoHasher('sha256').update(body).digest('hex');
    const { dir } = fresh({ releaseAssets: [{ name: 'contexts.ndjson.gz', sha256: digest, bytes: body.length }] });
    expect(checkReceipt(dir, {}).notes).toContain('release assets: 0 verified, 1 not present locally');
    mkdirSync(join(dir, 'release-assets'));
    writeFileSync(join(dir, 'release-assets/contexts.ndjson.gz'), body);
    expect(checkReceipt(dir, {}).notes).toContain('release assets: 1 verified, 0 not present locally');
    writeFileSync(join(dir, 'release-assets/contexts.ndjson.gz'), 'tampered');
    expect(codes(dir)).toContain('ASSET_HASH_MISMATCH');
    rmSync(dir, { recursive: true });
  });

  test('the committed pin table matches the bundles, and a changed lockfile breaks it', () => {
    expect(checkPinTable(ROOT)).toEqual([]);
    const tmp = mkdtempSync(join(tmpdir(), 'scoreboard-pins-'));
    mkdirSync(join(tmp, 'docs'));
    cpSync(join(ROOT, 'docs/comparison-systems.md'), join(tmp, 'docs/comparison-systems.md'));
    cpSync(join(ROOT, 'docs/comparison-systems'), join(tmp, 'docs/comparison-systems'), { recursive: true });
    writeFileSync(join(tmp, 'docs/comparison-systems/ext-markdown-kb/uv.lock'), 'changed\n');
    const msgs = checkPinTable(tmp);
    expect(msgs.map(m => m.code)).toEqual(['PIN_TABLE_MISMATCH']);
    expect(msgs[0].message).toContain('ext-markdown-kb');
    rmSync(tmp, { recursive: true });
  });
});
