/**
 * Q1 scoreboard generator (eval/runner/scoreboard.ts): the full derivation
 * chain on synthetic receipts, the four check mutations (raw score,
 * exclusion, missing cell, configuration identity), claim rules, pairwise
 * cohorts, explain, the pin table, the size budget, release assets and the
 * secret scan inside check. Every receipt here is synthetic.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { checkPinTable, checkReceipt, checkSize, checkSums, derive, deriveAll, explain, FRONTIER_REDO_FILE, README_BEGIN, README_END, receiptAtCommit, renderAll, renderHeadline, loadCampaign, SUMS_FILE, type CampaignManifest, type Scoreboard } from '../../eval/runner/scoreboard.ts';
import { classify, classifyV3, CLASSIFIER_VERSION, CLASSIFIER_VERSION_V3, RULES_SHA256, RULES_SHA256_V3 } from '../../eval/runner/q1/hedge.ts';
import { defaultCells, fieldCells, READERS, writeSyntheticReceipt, type SyntheticOptions } from './fixtures/scoreboard/synthetic.ts';

const ROOT = resolve(import.meta.dir, '../..');

function fresh(o: SyntheticOptions = {}): { dir: string; sb: Scoreboard } {
  const dir = mkdtempSync(join(tmpdir(), 'scoreboard-'));
  writeSyntheticReceipt(dir, o);
  const { campaign } = loadCampaign(dir);
  const d = deriveAll(dir);
  for (const f of renderAll(dir, d, campaign).files) { mkdirSync(dirname(f.path), { recursive: true }); writeFileSync(f.path, f.text); }
  return { dir, sb: d.scoreboard };
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
    const md = readFileSync(join(dir, 'scoreboard.md'), 'utf8');
    expect(md).toContain('- BEAM-10M, preregistered (1): 1 gold entered an agent context (exposure record)');
    expect(md).not.toContain('10m-c1:q0');
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

  test('a sentence that cannot separate two rows names its evidence and the questions both were scored on', () => {
    const { dir, sb } = fresh();
    const bank = sb.comparisons.find(c => c.id === 's1-memory-bank-8k')!;
    expect(bank.outcome).toBe('not-separated');
    expect(bank.sentence).toStartWith("On BEAM-10M, with the same three answer models and 8,000 tokens of each system's own evidence, we could not tell `ext-memory-bank` and gbrain-defaults apart");
    expect(bank.sentence).toContain(`on the ${bank.cohort!.paired} of ${bank.cohort!.scheduled} questions scored for both)`);
    expect(bank.sentence).toContain(`about ${bank.mdd_points!.toFixed(1)} points would not have been detected in this comparison`);
    rmSync(dir, { recursive: true });
  });

  test('the verdict prints the preregistered detectable difference to one decimal', () => {
    const { dir, sb } = fresh({ detectableDifference: 13.58 });
    expect(sb.verdict).toContain('(detectable difference about 13.6 points)');
    expect(sb.verdict).not.toContain('13.58');
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
  test('every GBrain row carries its version: the headline and size-curve rows name the build, and a GBrain cell or appendix row without one is refused', () => {
    const { dir, sb } = fresh();
    const label = 'GBrain 0.60.95.0 (c5fb0201, 2026-10-01)';
    expect(sb.headline.find(r => r.system === 'gbrain-defaults')!.label).toContain(label);
    expect(sb.size_curve.rows.find(r => r.system === 'gbrain-defaults')!.label).toContain(label);
    expect(sb.cells.filter(c => c.system === 'gbrain-defaults').every(c => c.pin === label)).toBe(true);
    for (const pin of [undefined, 'gbrain f05943e6 (0.60.138.0)']) {
      editJson(join(dir, 'campaign.json'), c => { const cell = c.cells.find(x => x.system === 'gbrain-defaults')!; if (pin === undefined) delete cell.pin; else cell.pin = pin; });
      expect(() => loadCampaign(dir)).toThrow(/GBrain cell s1-gbrain-8k carries no version/);
    }
    editJson(join(dir, 'campaign.json'), c => {
      const cell = c.cells.find(x => x.system === 'gbrain-defaults')!;
      cell.pin = label;
      c.appendix = [{ ...cell, pin: 'gbrain old-build', dir: 'appendix/old-build/s1-gbrain-8k', appendix: 'found and fixed', reason: 'measured before a fix' }];
    });
    expect(() => loadCampaign(dir)).toThrow(/GBrain appendix cell s1-gbrain-8k carries no version/);
    rmSync(dir, { recursive: true });
  });
});

describe('appendix rows and sensitivity views (v6)', () => {
  test('an appendix cell is tabled with its build and reason but never compared; a sensitivity view reports every cell on its set without its questions', () => {
    const { dir, sb: before } = fresh();
    const s2a = before.cells.find(c => c.cell_id === 's2a-gbrain-8k')!;
    cpSync(join(dir, 'cells', 's2a-gbrain-8k'), join(dir, 'appendix', 'old-build', 's2a-gbrain-8k'), { recursive: true });
    const { campaign } = loadCampaign(dir);
    const set = campaign.sets.find(s => s.id === 'S2a')!;
    const out = set.scheduled.slice(0, 3).map(q => q.question_id);
    editJson(join(dir, 'campaign.json'), c => {
      const cell = c.cells.find(x => x.cell_id === 's2a-gbrain-8k')!;
      cell.pin = 'GBrain 0.60.96.0 (d1e2f3a4, 2026-10-02)';
      c.appendix = [{ ...cell, pin: 'GBrain 0.60.95.0 (c5fb0201, 2026-10-01)', dir: 'appendix/old-build/s2a-gbrain-8k', appendix: 'found and fixed', reason: 'measured before a fix; reported for the record' }];
      c.sets.find(s => s.id === 'S2a')!.sensitivity = [{ id: 'repeats', label: 'without repeated sessions', reason: 'these haystacks repeat a session.', question_ids: out }];
    });
    const d = deriveAll(dir);
    for (const f of renderAll(dir, d, loadCampaign(dir).campaign).files) { mkdirSync(dirname(f.path), { recursive: true }); writeFileSync(f.path, f.text); }
    const sb = d.scoreboard;
    expect(sb.schema).toBe('gbrain-evals/scoreboard/v8');
    expect(sb.appendix).toHaveLength(1);
    expect(sb.appendix[0]).toMatchObject({ cell_id: 's2a-gbrain-8k', pin: 'GBrain 0.60.95.0 (c5fb0201, 2026-10-01)', mean: s2a.mean, valued: s2a.valued, appendix: 'found and fixed' });
    expect(sb.comparisons.filter(c => c.set === 'S2a').map(c => c.anchor)).toEqual(before.comparisons.filter(c => c.set === 'S2a').map(c => c.anchor));
    expect(sb.comparisons.map(c => ({ id: c.id, delta: c.delta }))).toEqual(before.comparisons.map(c => ({ id: c.id, delta: c.delta })));
    const main = sb.cells.find(c => c.cell_id === 's2a-gbrain-8k')!;
    expect(main.pin).toBe('GBrain 0.60.96.0 (d1e2f3a4, 2026-10-02)');
    const view = main.sensitivity[0];
    expect(view).toMatchObject({ id: 'repeats', scheduled: main.scheduled - 3 });
    expect(view.valued).toBeLessThanOrEqual(main.valued);
    expect(view.valued).toBeGreaterThanOrEqual(main.valued - 3);
    expect(sb.cells.filter(c => c.set === 'S2a').every(c => c.sensitivity.length === 1)).toBe(true);
    expect(sb.cells.filter(c => c.set !== 'S2a').every(c => c.sensitivity.length === 0)).toBe(true);
    expect(sb.sensitivity_notes).toEqual([{ set: 'S2a', id: 'repeats', label: 'without repeated sessions', reason: 'these haystacks repeat a session.', question_ids: out }]);
    const md = readFileSync(join(dir, 'scoreboard.md'), 'utf8');
    expect(md).toContain('## Sensitivity views');
    expect(md).toContain(`Excluded: ${out.length} questions.`);
    for (const q of out) expect(md).not.toContain(q);
    expect(md).toContain('## Appendix: found and fixed');
    expect(md).toContain('| `s2a-gbrain-8k` | S2a | `gbrain-defaults` | GBrain 0.60.95.0 (c5fb0201, 2026-10-01) |');
    expect(checkReceipt(dir, {}).messages).toEqual([]);
    editJson(join(dir, 'campaign.json'), c => { c.sets.find(s => s.id === 'S2a')!.sensitivity![0].question_ids.push('not-a-question'); });
    expect(() => deriveAll(dir)).toThrow(/sensitivity repeats names not-a-question/);
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

describe('derived columns: confident errors and the "I don\'t know" column', () => {
  /** i % 6 === 5 is the abstention question (gold_count 0); the others have gold evidence. */
  const R0 = READERS[0], R1 = READERS[1];
  const text = (i: number, reader: string) => {
    if (i % 6 === 5) return reader === R0 ? "I don't know." : reader === R1 ? 'It was probably March.' : 'It was March 3.';
    return ['Not mentioned in the conversation.', 'I think it was Tuesday.', 'It was Tuesday.', 'It was Tuesday.', 'It was Tuesday.'][i % 6];
  };
  const score = (i: number, reader: string) => (i % 6 === 5 ? (reader === R0 ? 1 : 0) : i % 6 >= 3 ? 1 : 0);
  const scripted = () => defaultCells().map(c => (c.id === 's1-gbrain-8k' || c.id === 's2a-gbrain-8k' ? { ...c, answerText: text, scoreOf: score } : c));

  test('per cell, per system and set, and pooled over sets, from replicate-0 answers with a scored canonical judgment', () => {
    const { dir, sb } = fresh({ cells: scripted() });
    expect(sb.schema).toBe('gbrain-evals/scoreboard/v8');
    const s1 = sb.cells.find(c => c.cell_id === 's1-gbrain-8k')!.derived;
    expect(s1).toEqual({ answers: 177, wrong: 107, confident_wrong: 40, abstention_answers: 30, correct_abstentions: 10, answerable_answers: 147, false_abstentions: 27, confident_error_rate: Number((40 / 107).toFixed(6)), correct_abstention_rate: Number((10 / 30).toFixed(6)), false_abstention_rate: Number((27 / 147).toFixed(6)) });
    const s2a = sb.cells.find(c => c.cell_id === 's2a-gbrain-8k')!.derived;
    expect([s2a.answers, s2a.wrong, s2a.confident_wrong, s2a.abstention_answers, s2a.correct_abstentions, s2a.answerable_answers, s2a.false_abstentions]).toEqual([72, 44, 16, 12, 4, 60, 12]);
    const gb = sb.derived.systems.find(s => s.system === 'gbrain-defaults')!;
    expect(gb.sets.map(s => [s.set, s.cell])).toEqual([['S1', 's1-gbrain-8k'], ['S2a', 's2a-gbrain-8k']]);
    expect([gb.pooled.abstention_answers, gb.pooled.correct_abstentions, gb.pooled.correct_abstention_rate]).toEqual([42, 14, Number((14 / 42).toFixed(6))]);
    expect([gb.pooled.wrong, gb.pooled.confident_wrong, gb.pooled.answerable_answers, gb.pooled.false_abstentions]).toEqual([151, 56, 207, 39]);
    expect(sb.derived.classifier).toEqual({ file: 'eval/runner/q1/hedge.ts', version: CLASSIFIER_VERSION_V3, rules_sha256: RULES_SHA256_V3, source: 'campaign.json hedge_classifier, computed at render time', per_answer: 'cells/<cell_id>/derived/hedge.ndjson' });
    expect(sb.derived.withheld).toBeNull();
    expect(sb.cells.find(c => c.cell_id === 's1-temporal-graph-8k')!.derived.confident_error_rate).toBeNull();
    expect(checkReceipt(dir, {}).messages).toEqual([]);
    rmSync(dir, { recursive: true });
  });

  test('a harness failure or an unjudged answer is not counted; the preregistered exclusion is not counted', () => {
    const cells = scripted().map(c => (c.id === 's1-gbrain-8k' ? { ...c, harnessFail: [5] } : c));
    const { dir, sb } = fresh({ cells });
    const d = sb.cells.find(c => c.cell_id === 's1-gbrain-8k')!.derived;
    expect([d.abstention_answers, d.correct_abstentions]).toEqual([27, 9]);
    rmSync(dir, { recursive: true });
  });

  test('the report carries both columns per cell and per system and set; the README keeps six columns with one line under it', () => {
    const { dir, sb } = fresh({ cells: scripted() });
    const md = readFileSync(join(dir, 'scoreboard.md'), 'utf8');
    expect(md).toContain('| Confident-error rate | Correct abstention | False abstention | Status |');
    expect(md).toContain('## Derived columns by system and set');
    expect(md).toContain('| `gbrain-defaults` | S1 | `s1-gbrain-8k` | 37.4% (40/107) | 33.3% (10/30) | 18.4% (27/147) |');
    expect(md).toContain('| `gbrain-defaults` | all sets, pooled | | 37.1% (56/151) | 33.3% (14/42) | 18.8% (39/207) |');
    const block = renderHeadline(sb, '.');
    const header = block.split('\n').find(l => l.startsWith('| Kind and configuration'))!;
    expect(header.split('|').length - 2).toBe(6);
    expect(header).not.toContain('abstention');
    const line = block.split('\n').find(l => l.startsWith('Descriptive, not tested:'))!;
    expect(line).toContain('on BEAM-10M: `gbrain-defaults` 37.4% / 33.3%; `ext-extract-first`');
    expect(line).not.toContain('ext-temporal-graph');
    expect(sb.families.map(f => f.id)).toEqual(['F1', 'F2', 'F3']);
    rmSync(dir, { recursive: true });
  });

  const lines = (path: string) => readFileSync(path, 'utf8').trim().split('\n').map(l => JSON.parse(l));

  test('derived/hedge.ndjson: one line per judged answer, in answers.ndjson order, with verdict, version, rules sha and delivered tokens', () => {
    const cells = scripted().map(c => (c.id === 's1-gbrain-8k' ? { ...c, harnessFail: [0] } : c));
    const { dir } = fresh({ cells });
    const answers = lines(join(dir, 'cells/s1-gbrain-8k/answers.ndjson'));
    const hedge = lines(join(dir, 'cells/s1-gbrain-8k/derived/hedge.ndjson'));
    const judged = answers.filter(a => a.outcome === 'scored');
    expect(judged.length).toBe(answers.length - READERS.length);
    expect(hedge).toEqual(judged.map(a => ({ answer_id: a.answer_id, verdict: classifyV3(a.text), classifier_version: CLASSIFIER_VERSION_V3, rules_sha256: RULES_SHA256_V3, delivered_tokens: a.delivered_tokens })));
    expect(new Set(hedge.map(h => h.verdict))).toEqual(new Set(['abstain', 'hedged', 'confident']));
    expect(() => readFileSync(join(dir, 'cells/s1-temporal-graph-8k/derived/hedge.ndjson'))).toThrow();
    expect(checkReceipt(dir, {}).messages).toEqual([]);
    rmSync(dir, { recursive: true });
  });

  test('mutation: an edited or missing derived/hedge.ndjson fails check, and so does answer text edited after render', () => {
    const a = fresh({ cells: scripted() });
    const path = join(a.dir, 'cells/s1-gbrain-8k/derived/hedge.ndjson');
    const text = readFileSync(path, 'utf8');
    writeFileSync(path, text.replace('"verdict":"confident"', '"verdict":"hedged"'));
    const m = checkReceipt(a.dir, {}).messages;
    expect(m.map(x => x.code)).toEqual(['SCOREBOARD_STALE']);
    expect(m[0].message).toContain('cells/s1-gbrain-8k/derived/hedge.ndjson differs from the regenerated text at line');
    rmSync(path);
    expect(checkReceipt(a.dir, {}).messages[0].message).toContain('derived/hedge.ndjson is missing');
    const b = fresh({ cells: scripted() });
    const pathB = join(b.dir, 'cells/s1-gbrain-8k/answers.ndjson');
    writeFileSync(pathB, readFileSync(pathB, 'utf8').replace('"text":"It was Tuesday."', '"text":"It was probably Tuesday."'));
    const stale = checkReceipt(b.dir, {}).messages.filter(x => x.code === 'SCOREBOARD_STALE').map(x => x.message);
    expect(stale.some(x => x.includes('cells/s1-gbrain-8k/derived/hedge.ndjson'))).toBe(true);
    expect(stale.some(x => x.includes('scoreboard.json'))).toBe(true);
    rmSync(a.dir, { recursive: true }); rmSync(b.dir, { recursive: true });
  });

  test('campaign.json hedge_classifier picks the version; a version change re-renders; an unknown or missing version is refused', () => {
    const texts = (i: number, reader: string) => (i % 6 === 2 && reader === READERS[2] ? "**Answer:** It was Tuesday.\n\nThe chats don't say whether it was the first or second Tuesday." : text(i, reader));
    const cells = scripted().map(c => (c.answerText ? { ...c, answerText: texts } : c));
    const v1 = fresh({ cells, hedgeClassifier: CLASSIFIER_VERSION });
    const v2 = fresh({ cells });
    const h1 = lines(join(v1.dir, 'cells/s1-gbrain-8k/derived/hedge.ndjson')), h2 = lines(join(v2.dir, 'cells/s1-gbrain-8k/derived/hedge.ndjson'));
    expect(h1.every(h => h.classifier_version === CLASSIFIER_VERSION && h.rules_sha256 === RULES_SHA256)).toBe(true);
    const long = lines(join(v2.dir, 'cells/s1-gbrain-8k/answers.ndjson')).filter(a => a.text.startsWith('**Answer:**')).map(a => a.answer_id);
    expect(long.length).toBeGreaterThan(0);
    expect(long.map(id => h1.find(h => h.answer_id === id).verdict)).toEqual(long.map(() => classify(texts(2, READERS[2]))));
    expect(classify(texts(2, READERS[2]))).toBe('abstain');
    expect(long.map(id => h2.find(h => h.answer_id === id).verdict)).toEqual(long.map(() => 'confident'));
    expect(v1.sb.derived.classifier!.version).toBe(CLASSIFIER_VERSION);
    expect(v1.sb.cells.find(c => c.cell_id === 's1-gbrain-8k')!.derived.false_abstentions!).toBeGreaterThan(v2.sb.cells.find(c => c.cell_id === 's1-gbrain-8k')!.derived.false_abstentions!);
    expect(checkReceipt(v1.dir, {}).messages).toEqual([]);
    editJson(join(v1.dir, 'campaign.json'), x => { x.hedge_classifier = CLASSIFIER_VERSION_V3; });
    expect(codes(v1.dir)).toContain('SCOREBOARD_STALE');
    editJson(join(v1.dir, 'campaign.json'), x => { x.hedge_classifier = 'hedge-v0'; });
    expect(checkReceipt(v1.dir, {}).messages.find(x => x.code === 'RECEIPT_INVALID')!.message).toContain('campaign.json hedge_classifier is "hedge-v0", not one of hedge-v1, hedge-v2, hedge-v3, none');
    editJson(join(v1.dir, 'campaign.json'), x => { delete (x as Partial<CampaignManifest>).hedge_classifier; });
    expect(checkReceipt(v1.dir, {}).messages.find(x => x.code === 'RECEIPT_INVALID')!.message).toContain('hedge_classifier is null');
    rmSync(v1.dir, { recursive: true }); rmSync(v2.dir, { recursive: true });
  });

  test('a hedge stamp on an older answer record is ignored: verdicts come from the text', () => {
    const cells = scripted().map(c => ({ ...c, legacyStamp: { verdict: 'hedged' as const, classifier_version: 'hedge-v0' } }));
    const { dir, sb } = fresh({ cells });
    expect(sb.cells.find(c => c.cell_id === 's1-gbrain-8k')!.derived.confident_wrong).toBe(40);
    expect(lines(join(dir, 'cells/s1-gbrain-8k/answers.ndjson'))[0].hedge).toEqual({ verdict: 'hedged', classifier_version: 'hedge-v0' });
    expect(checkReceipt(dir, {}).messages).toEqual([]);
    rmSync(dir, { recursive: true });
  });

  test('hedge_classifier "none": no derived/hedge.ndjson, only correct abstention published with the reason, delivered_tokens kept, check clean', () => {
    const { dir, sb } = fresh({ cells: scripted(), hedgeClassifier: 'none' });
    const reason = 'the hedge classifier did not meet its preregistered validation bar; see the receipt';
    expect(sb.derived.classifier).toBeNull();
    expect(sb.derived.withheld).toBe(`confident-error and false-abstention rates not published: ${reason}`);
    expect(sb.derived.rule).not.toContain('confident');
    const s1 = sb.cells.find(c => c.cell_id === 's1-gbrain-8k')!.derived;
    expect(s1).toEqual({ answers: 177, abstention_answers: 30, correct_abstentions: 10, correct_abstention_rate: Number((10 / 30).toFixed(6)) });
    const gb = sb.derived.systems.find(s => s.system === 'gbrain-defaults')!;
    expect(gb.pooled).toEqual({ answers: 249, abstention_answers: 42, correct_abstentions: 14, correct_abstention_rate: Number((14 / 42).toFixed(6)) });
    expect(Object.keys(gb.sets[0]).sort()).toEqual(['abstention_answers', 'answers', 'cell', 'correct_abstention_rate', 'correct_abstentions', 'set']);
    for (const c of sb.cells) expect(() => readFileSync(join(dir, 'cells', c.cell_id, 'derived', 'hedge.ndjson'))).toThrow();
    expect(lines(join(dir, 'cells/s1-gbrain-8k/answers.ndjson')).filter(a => a.outcome === 'scored').every(a => a.delivered_tokens && !a.hedge)).toBe(true);
    const json = readFileSync(join(dir, 'scoreboard.json'), 'utf8'), md = readFileSync(join(dir, 'scoreboard.md'), 'utf8');
    expect(json).not.toMatch(/confident_error|false_abstention|confident_wrong/);
    expect(md).not.toMatch(/Confident-error rate|False abstention/);
    expect(md).toContain('| Fill rate | Correct abstention | Status |');
    expect(md).toContain('| `gbrain-defaults` | S1 | `s1-gbrain-8k` | 33.3% (10/30) |');
    expect(md).toContain(`The confident-error and false-abstention columns are not published: ${reason}.`);
    const line = renderHeadline(sb, '.').split('\n').find(l => l.startsWith('Descriptive, not tested:'))!;
    expect(line).toStartWith("Descriptive, not tested: correct-abstention rate (abstention-question answers the benchmark's own judgment passes) on BEAM-10M: `gbrain-defaults` 33.3%;");
    expect(line).not.toContain('confident');
    expect(explain(dir, 'gbrain-defaults', 'confident-error')).toMatchObject({ value: { withheld: sb.derived.withheld } });
    expect((explain(dir, 'gbrain-defaults', 'abstention') as Record<string, any>).value).toMatchObject({ correct_abstentions: 10, classifier: null, withheld: sb.derived.withheld });
    expect(checkReceipt(dir, {}).messages).toEqual([]);
    rmSync(dir, { recursive: true });
  });

  test('switching a rendered receipt to "none" leaves stale verdict files that check refuses and render removes; switching back re-renders them', () => {
    const { dir } = fresh({ cells: scripted() });
    const path = join(dir, 'cells/s1-gbrain-8k/derived/hedge.ndjson');
    expect(readFileSync(path, 'utf8').length).toBeGreaterThan(0);
    editJson(join(dir, 'campaign.json'), x => { x.hedge_classifier = 'none'; });
    const m = checkReceipt(dir, {}).messages;
    expect(m.some(x => x.code === 'SCOREBOARD_STALE' && x.message.includes('cells/s1-gbrain-8k/derived/hedge.ndjson should not exist: campaign.json hedge_classifier is "none"'))).toBe(true);
    const render = Bun.spawnSync(['bun', 'eval/runner/scoreboard.ts', 'render', '--receipt', dir], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
    expect(render.exitCode).toBe(0);
    expect(() => readFileSync(path)).toThrow();
    expect(checkReceipt(dir, {}).messages).toEqual([]);
    editJson(join(dir, 'campaign.json'), x => { x.hedge_classifier = CLASSIFIER_VERSION_V3; });
    expect(checkReceipt(dir, {}).messages.some(x => x.message.includes('derived/hedge.ndjson is missing'))).toBe(true);
    rmSync(dir, { recursive: true });
  });

  test('explain traces both derived columns', () => {
    const { dir } = fresh({ cells: scripted() });
    const out = explain(dir, 'gbrain-defaults', 'confident-error') as Record<string, any>;
    expect(out.cell).toBe('s1-gbrain-8k');
    expect(out.value.confident_wrong).toBe(40);
    expect(out.value.classifier.version).toBe(CLASSIFIER_VERSION_V3);
    expect(out.value.per_answer).toBe('cells/s1-gbrain-8k/derived/hedge.ndjson');
    expect((explain(dir, 'gbrain-defaults', 'abstention') as Record<string, any>).value.correct_abstention_rate).toBeCloseTo(1 / 3, 5);
    rmSync(dir, { recursive: true });
  });
});

describe('retired systems (A24 option 1)', () => {
  const RETIRED = 'pinned config calls a model its provider retired';
  const KEPT = Array.from({ length: 8 }, (_, i) => `10m-c${i}`);
  const subset = { conversations: KEPT, label: 'the 8 conversations A17 measured validly (c0-c7)', reason: 'c8 and c9 not run: pinned config calls a model its provider retired' };
  const retiredReceipt = () => {
    const cells = [
      ...defaultCells().map(c => (c.id === 's1-temporal-graph-8k' ? { ...c, quality: 0.3, status: undefined, not_run_reason: undefined } : c)),
      { id: 's2a-temporal-graph-8k', set: 'S2a' as const, system: 'ext-temporal-graph', arm: 'component' as const, budget: 8000, quality: 0, status: 'not-run' as const, not_run_reason: RETIRED },
    ];
    const { dir } = fresh({ cells });
    editJson(join(dir, 'campaign.json'), c => {
      c.retired = [{ system: 'ext-temporal-graph', reason: RETIRED, subset: { ...subset, sets: ['S1'] } }];
      c.cells.find(x => x.cell_id === 's1-temporal-graph-8k')!.subset = subset;
      c.sets.find(s => s.id === 'S1')!.sensitivity = [{ id: 'tg-subset', label: 'on the 8 conversations temporal-graph measured', reason: 'temporal-graph ran validly only on these.', question_ids: [], conversations: KEPT }];
    });
    return dir;
  };
  const render = (dir: string) => { const d = deriveAll(dir); for (const f of renderAll(dir, d, loadCampaign(dir).campaign).files) { mkdirSync(dirname(f.path), { recursive: true }); writeFileSync(f.path, f.text); } return d.scoreboard; };

  test('the S1 row is shown on its subset and never claims, every system gets the subset view, and its other cells say why they did not run', () => {
    const dir = retiredReceipt();
    const sb = render(dir);
    const tg = sb.cells.find(c => c.cell_id === 's1-temporal-graph-8k')!;
    expect(tg.subset).toEqual(subset);
    expect(tg.scheduled).toBe(8 * 6 - 1);
    expect(tg.valued).toBeLessThanOrEqual(tg.scheduled);
    expect(tg.complete).toBe(true);
    expect(tg.exclusions.every(e => !e.reason.startsWith('outside'))).toBe(true);
    const cmp = sb.comparisons.find(c => c.id === 's1-temporal-graph-8k')!;
    expect(cmp.cohort).toMatchObject({ clusters_scheduled: 8 });
    expect(cmp.claim_eligible).toBe(false);
    expect(cmp.eligibility).toContain(`s1-temporal-graph-8k is measured only on ${subset.label}`);
    expect(sb.headline.find(h => h.system === 'ext-temporal-graph')!.accuracy).toEndWith(`, on ${subset.label}`);
    for (const c of sb.cells.filter(x => x.set === 'S1' && x.status !== 'not-run')) expect(c.sensitivity).toEqual([expect.objectContaining({ id: 'tg-subset', scheduled: 8 * 6 - 1 })]);
    expect(sb.cells.find(c => c.cell_id === 's1-gbrain-8k')!.scheduled).toBe(10 * 6 - 1);
    const md = readFileSync(join(dir, 'scoreboard.md'), 'utf8');
    expect(md).toContain(`Conversations kept: ${KEPT.join(', ')}.`);
    expect(md).toContain('| `s2a-temporal-graph-8k` | S2a | `ext-temporal-graph` |');
    expect(md).toContain(`not run: ${RETIRED} |`);
    expect(md).toContain(`complete; on ${subset.label}: ${subset.reason} |`);
    expect(checkReceipt(dir, {}).messages).toEqual([]);
    rmSync(dir, { recursive: true });
  });

  test('a temporal-graph cell off its subset, a not-run one without the reason, or a set without the subset view is refused', () => {
    const dir = retiredReceipt();
    editJson(join(dir, 'campaign.json'), c => { delete c.cells.find(x => x.cell_id === 's1-temporal-graph-8k')!.subset; });
    expect(() => loadCampaign(dir)).toThrow(/ext-temporal-graph cell s1-temporal-graph-8k is not on its subset/);
    editJson(join(dir, 'campaign.json'), c => { c.cells.find(x => x.cell_id === 's1-temporal-graph-8k')!.subset = { ...subset, conversations: [...KEPT, '10m-c8'] }; });
    expect(() => loadCampaign(dir)).toThrow(/is not on its subset/);
    editJson(join(dir, 'campaign.json'), c => { c.cells.find(x => x.cell_id === 's1-temporal-graph-8k')!.subset = subset; });
    expect(() => loadCampaign(dir)).not.toThrow();
    for (const reason of ['sealed campaign, pending', undefined]) {
      editJson(join(dir, 'campaign.json'), c => { const x = c.cells.find(y => y.cell_id === 's2a-temporal-graph-8k')!; if (reason) x.not_run_reason = reason; else delete x.not_run_reason; });
      expect(() => loadCampaign(dir)).toThrow(reason ? /s2a-temporal-graph-8k is not run without the retirement reason/ : /s2a-temporal-graph-8k is not-run without a reason/);
    }
    editJson(join(dir, 'campaign.json'), c => { c.cells.find(y => y.cell_id === 's2a-temporal-graph-8k')!.not_run_reason = RETIRED; delete c.sets.find(s => s.id === 'S1')!.sensitivity; });
    expect(() => loadCampaign(dir)).toThrow(/set S1 has no sensitivity view on ext-temporal-graph's subset/);
    rmSync(dir, { recursive: true });
  });
});

describe('A24 render: product outcomes, frontier agreement, SHA256SUMS and the receipt by commit', () => {
  const ndjson = (p: string) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const write = (p: string, xs: unknown[]) => writeFileSync(p, xs.map(x => JSON.stringify(x) + '\n').join(''));
  const render = (dir: string) => { const d = deriveAll(dir); for (const f of renderAll(dir, d, loadCampaign(dir).campaign).files) { mkdirSync(dirname(f.path), { recursive: true }); writeFileSync(f.path, f.text); } return d.scoreboard; };
  const THINK = 's1-gbrain-think';
  const REASON = "gbrain think's own 4,000-token output limit for this model, flagged by its own path as output_truncated";
  const truncated = (dir: string, n: number) => {
    const cdir = join(dir, 'cells', THINK);
    const answers = ndjson(join(cdir, 'answers.ndjson'));
    const hit = answers.filter(a => a.reader === 'gpt-6.1-sol' && !a.question_id.startsWith('10m-c1:')).slice(0, n);
    const ids = new Set(hit.map(a => a.answer_id));
    write(join(cdir, 'answers.ndjson'), answers.map(a => (ids.has(a.answer_id) ? { ...a, outcome: 'harness_invalid' } : a)));
    write(join(cdir, 'judgments.ndjson'), ndjson(join(cdir, 'judgments.ndjson')).filter(j => !ids.has(j.answer_id)));
  };

  test('a reader outcome the system flagged as its own limit counts as a product failure, scored 0, by exact count', () => {
    const { dir } = fresh();
    truncated(dir, 2);
    const before = render(dir).cells.find(c => c.cell_id === THINK)!;
    expect(before.harness_failures).toBe(2);
    expect(before.product_failures).toBe(0);
    editJson(join(dir, 'campaign.json'), c => { c.cells.find(x => x.cell_id === THINK)!.product_outcomes = [{ reader: 'gpt-6.1-sol', outcome: 'harness_invalid', count: 2, reason: REASON }]; });
    const after = render(dir).cells.find(c => c.cell_id === THINK)!;
    expect(after.harness_failures).toBe(0);
    expect(after.product_failures).toBe(2);
    expect(after.valued).toBe(before.valued + 2);
    expect(after.mean!).toBeLessThan(before.mean!);
    expect(after.product_outcomes).toEqual([{ reader: 'gpt-6.1-sol', outcome: 'harness_invalid', count: 2, reason: REASON }]);
    expect(readFileSync(join(dir, 'scoreboard.md'), 'utf8')).toContain('; 2 gpt-6.1-sol harness_invalid answers counted as product failures: ' + REASON);
    expect(checkReceipt(dir, {}).messages).toEqual([]);
    editJson(join(dir, 'campaign.json'), c => { c.cells.find(x => x.cell_id === THINK)!.product_outcomes![0].count = 3; });
    expect(() => deriveAll(dir)).toThrow(/2 gpt-6\.1-sol answers are recorded harness_invalid on scheduled questions, campaign\.json counts 3/);
    rmSync(dir, { recursive: true });
  });

  test('frontier agreement is reported on the covered set with coverage, and an A19 redo replaces the logged record under its key', () => {
    const { dir } = fresh();
    const cell = 's1-gbrain-8k';
    const cdir = join(dir, 'cells', cell);
    const judgments = ndjson(join(cdir, 'judgments.ndjson'));
    const canonical = judgments.filter(j => j.judge_replicate === 0);
    const frontier = canonical.map((j, i) => ({ ...j, instrument_id: j.instrument_id + '@claude-opus-5-5', judge: 'claude-opus-5-5', raw_sha256: 'f' + i,
      ...(i < 2 ? { score: null, parse_ok: false, outcome: 'judge_error' } : i < 30 ? { score: j.score >= 0.5 ? 0 : 1 } : {}) }));
    write(join(cdir, 'judgments.ndjson'), [...judgments, ...frontier]);
    const n = canonical.length;
    const before = render(dir);
    expect(before.cells.find(c => c.cell_id === cell)!.frontier).toEqual([{ judge: 'claude-opus-5-5', scope: n, judged: n - 2, compared: n - 2, agree: n - 30, agreement: Math.round(((n - 30) / (n - 2)) * 1e6) / 1e6 }]);
    const pooled = before.frontier.find(f => f.system === 'gbrain-defaults' && f.judge === 'claude-opus-5-5')!;
    expect(pooled).toMatchObject({ scope: n, judged: n - 2, flagged: true });
    expect(pooled.coverage).toBe(Math.round(((n - 2) / n) * 1e6) / 1e6);
    const md = readFileSync(join(dir, 'scoreboard.md'), 'utf8');
    expect(md).toContain('## Frontier-judge agreement');
    expect(md).toContain('| ' + String.fromCharCode(96) + 'gbrain-defaults' + String.fromCharCode(96) + ' | ' + String.fromCharCode(96) + 'claude-opus-5-5' + String.fromCharCode(96) + ' | ');
    expect(md).toContain('under 90%: flagged');
    write(join(cdir, FRONTIER_REDO_FILE), frontier.slice(0, 2).map((f, i) => ({ ...f, score: canonical[i].score, parse_ok: true, outcome: 'scored', raw_sha256: 'redo' + i })));
    const redone = render(dir).cells.find(c => c.cell_id === cell)!.frontier[0];
    expect(redone).toMatchObject({ scope: n, judged: n, compared: n, agree: n - 28 });
    expect(checkReceipt(dir, {}).messages).toEqual([]);
    write(join(cdir, FRONTIER_REDO_FILE), [{ ...canonical[0], raw_sha256: 'bad' }]);
    expect(() => deriveAll(dir)).toThrow(/frontier-redo\.ndjson holds a canonical judgment/);
    rmSync(dir, { recursive: true });
  });

  test('every render writes SHA256SUMS over the receipt at its rendered bytes, never listing itself', () => {
    const { dir } = fresh();
    const sums = readFileSync(join(dir, SUMS_FILE), 'utf8').trimEnd().split('\n').map(l => l.split('  '));
    const paths = sums.map(s => s[1]);
    expect(paths).toEqual([...paths].sort());
    expect(paths).toContain('scoreboard.json');
    expect(paths).toContain('campaign.json');
    expect(paths).toContain('cells/s1-gbrain-8k/answers.ndjson');
    expect(paths).not.toContain(SUMS_FILE);
    for (const [hash, p] of sums) expect(createHash('sha256').update(readFileSync(join(dir, p))).digest('hex')).toBe(hash);
    expect(checkReceipt(dir, {}).messages).toEqual([]);
    rmSync(dir, { recursive: true });
  });

  test('receiptAtCommit reads the published path at that commit and refuses a commit or SHA256SUMS publication.json does not record', () => {
    const { dir } = fresh();
    const work = mkdtempSync(join(tmpdir(), 'receipt-tree-'));
    cpSync(dir, join(work, 'published', 'q1-scoreboard'), { recursive: true });
    const env = { ...process.env, GIT_INDEX_FILE: join(work, 'index') };
    const gitDir = spawnSync('git', ['-C', ROOT, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).stdout.trim();
    const git = (args: string[]) => { const r = spawnSync('git', ['--git-dir', gitDir, '--work-tree', work, ...args], { cwd: work, env, encoding: 'utf8' }); expect(r.stderr).toBe(''); expect(r.status).toBe(0); return r.stdout.trim(); };
    git(['add', '-f', 'published']);
    const tree = git(['write-tree']);
    const sums = createHash('sha256').update(readFileSync(join(dir, SUMS_FILE))).digest('hex');
    const pub = join(work, 'publication.json');
    const published = (commit: string | null, sha256: string | null) => writeFileSync(pub, JSON.stringify({ published: { branch: 'no-such-results-branch', path: 'published/q1-scoreboard', url: 'https://example.invalid/receipt', commit, sha256 } }));
    published(tree, sums);
    const got = receiptAtCommit(tree, pub);
    expect(readFileSync(join(got, 'scoreboard.json'), 'utf8')).toBe(readFileSync(join(dir, 'scoreboard.json'), 'utf8'));
    expect(checkReceipt(got, {}).messages).toEqual([]);
    published(tree, '0'.repeat(64));
    expect(() => receiptAtCommit(tree, pub)).toThrow(/SHA256SUMS at .* hashes to .*, publication\.json records 0{64}/);
    published('1'.repeat(40), sums);
    expect(() => receiptAtCommit(tree, pub)).toThrow(/publication\.json records results commit 1{40}, not /);
    rmSync(dir, { recursive: true });
    rmSync(work, { recursive: true });
  });
});

describe('sealed ids never reach a public file; aggregate publication', () => {
  const sealedReceipt = (renderTargets: string[] = []) => {
    const cells = defaultCells().map(c => (c.id === 's1-file-agent' ? { ...c, harnessFail: [2, 3, 7] } : c.id === 's1-hybrid-8k' ? { ...c, doesNotFit: { questions: [4], readers: ['claude-opus-5-5'] } } : c));
    const dir = mkdtempSync(join(tmpdir(), 'scoreboard-sealed-'));
    writeSyntheticReceipt(dir, { cells, renderTargets });
    editJson(join(dir, 'campaign.json'), c => {
      const s1 = c.sets.find(s => s.id === 'S1')!;
      s1.sealed = true;
      s1.sensitivity = [{ id: 'held', label: 'without three questions', reason: 'a view by question.', question_ids: [s1.scheduled[5].question_id, s1.scheduled[11].question_id, s1.scheduled[17].question_id] }];
    });
    return dir;
  };
  const render = (dir: string) => { const d = deriveAll(dir); const files = renderAll(dir, d, loadCampaign(dir).campaign).files; for (const f of files) { mkdirSync(dirname(f.path), { recursive: true }); writeFileSync(f.path, f.text); } return files; };

  test('exclusion, preregistered and view lists print counts by reason, and no sealed question id appears in any public file', () => {
    const readme = join(mkdtempSync(join(tmpdir(), 'readme-')), 'README.md');
    writeFileSync(readme, 'x\n' + README_BEGIN + '\n' + README_END + '\n');
    const dir = sealedReceipt([readme]);
    const files = render(dir);
    const ids = loadCampaign(dir).campaign.sets.find(s => s.id === 'S1')!.scheduled.map(q => q.question_id);
    const pub = files.filter(f => f.path.endsWith('.md'));
    expect(pub.map(f => f.path).sort()).toEqual([readme, join(dir, 'scoreboard.md')].sort());
    for (const f of pub) for (const id of ids) expect(f.text).not.toContain(id);
    const md = readFileSync(join(dir, 'scoreboard.md'), 'utf8');
    expect(md).toContain('Counts by reason; question ids stay in the receipt.');
    expect(md).toContain('- BEAM-10M, preregistered (1): 1 gold entered an agent context (exposure record)');
    expect(md).toContain('Excluded: 3 questions.');
    expect(md).toMatch(/- .s1-file-agent. \(\d+\): \d+ baseline-file-agent: harness: reader_error/);
    expect(readFileSync(join(dir, 'scoreboard.json'), 'utf8')).toContain(ids[2]);
    expect(checkReceipt(dir, {}).messages).toEqual([]);
    rmSync(dir, { recursive: true });
  });

  test('a render that would print a sealed id is refused without naming it, and nothing is written', () => {
    const dir = sealedReceipt();
    const id = loadCampaign(dir).campaign.sets.find(s => s.id === 'S1')!.scheduled[3].question_id;
    editJson(join(dir, 'campaign.json'), c => { c.disclosures = [...c.disclosures, 'see ' + id]; });
    let err: unknown;
    try { renderAll(dir, deriveAll(dir), loadCampaign(dir).campaign); } catch (e) { err = e; }
    expect((err as { op: { code: string; message: string } }).op.code).toBe('SEALED_ID_IN_PUBLIC_FILE');
    expect((err as { op: { message: string } }).op.message).toMatch(/scoreboard\.md would print 1 question id of a sealed set/);
    expect((err as { op: { message: string } }).op.message).not.toContain(id);
    editJson(join(dir, 'campaign.json'), c => { c.sets.find(s => s.id === 'S1')!.sealed = false; });
    expect(() => renderAll(dir, deriveAll(dir), loadCampaign(dir).campaign)).not.toThrow();
    rmSync(dir, { recursive: true });
  });

  test('SHA256SUMS commits the public render targets, check --sums verifies them without the receipt, and a custody check skips only the size budget', () => {
    const work = mkdtempSync(join(tmpdir(), 'public-'));
    const readme = join(work, 'README.md');
    const tables = join(work, 'bench', 'scoreboard.md');
    writeFileSync(readme, 'intro\n' + README_BEGIN + '\n' + README_END + '\nrest\n');
    const dir = sealedReceipt([readme, tables]);
    editJson(join(dir, 'campaign.json'), c => { c.receipt_base = 'https://example.invalid/receipt'; });
    render(dir);
    const sums = readFileSync(join(dir, SUMS_FILE), 'utf8');
    const lines = sums.trimEnd().split('\n').map(l => l.split('  '));
    const sha = (x: string | Buffer) => createHash('sha256').update(x).digest('hex');
    const block = readFileSync(readme, 'utf8').split(README_BEGIN + '\n')[1].split(README_END)[0];
    expect(lines).toContainEqual([sha(block), 'render/' + readme + '#scoreboard:headline']);
    expect(lines).toContainEqual([sha(readFileSync(tables)), 'render/' + tables]);
    expect(readFileSync(tables, 'utf8')).toContain('[the receipt](https://example.invalid/receipt)');
    const pub = join(work, 'publication.json');
    const published = (sha256: string) => writeFileSync(pub, JSON.stringify({ published: { branch: 'b', path: 'p', url: 'u', commit: null, sha256 } }));
    const copy = join(work, SUMS_FILE);
    writeFileSync(copy, sums);
    published(sha(sums));
    expect(checkSums(copy, pub)).toMatchObject({ ok: true, messages: [], notes: ['2 rendered public file(s) match SHA256SUMS'] });
    writeFileSync(readme, readFileSync(readme, 'utf8').replace('intro', 'edited intro'));
    expect(checkSums(copy, pub).ok).toBe(true);
    writeFileSync(tables, readFileSync(tables, 'utf8') + 'hand edit\n');
    expect(checkSums(copy, pub).messages.map(m => [m.code, m.message])).toEqual([['SCOREBOARD_STALE', tables + ' does not match the published SHA256SUMS']]);
    published('0'.repeat(64));
    expect(checkSums(copy, pub).messages.map(m => m.code)).toEqual(['RECEIPT_INVALID', 'SCOREBOARD_STALE']);
    render(dir);
    writeFileSync(join(dir, 'big.bin'), '');
    truncateSync(join(dir, 'big.bin'), 61 * 1024 * 1024);
    render(dir);
    expect(codes(dir)).toEqual(['RECEIPT_TOO_LARGE', 'RECEIPT_TOO_LARGE']);
    const custody = checkReceipt(dir, {}, { custody: true });
    expect(custody.messages).toEqual([]);
    expect(custody.notes[0]).toStartWith('size budget not applied');
    rmSync(dir, { recursive: true });
    rmSync(work, { recursive: true });
  });
});

describe('aggregates-only links', () => {
  test('with campaign.tables, README and the public tables link to the tables on main, never to a receipt path, and the header says the receipt stays in custody', () => {
    const work = mkdtempSync(join(tmpdir(), 'agg-'));
    const readme = join(work, 'README.md');
    const tables = join(work, 'docs', 'scoreboard.md');
    writeFileSync(readme, 'intro\n' + README_BEGIN + '\n' + README_END + '\n');
    const dir = mkdtempSync(join(tmpdir(), 'scoreboard-agg-'));
    writeSyntheticReceipt(dir, { renderTargets: [readme, tables] });
    editJson(join(dir, 'campaign.json'), c => { c.receipt_base = 'https://example.invalid/receipt'; c.tables = tables; });
    const files = renderAll(dir, deriveAll(dir), loadCampaign(dir).campaign).files;
    for (const f of files) { mkdirSync(dirname(f.path), { recursive: true }); writeFileSync(f.path, f.text); }
    const block = readFileSync(readme, 'utf8');
    expect(block).toContain('[cell](docs/scoreboard.md#cells)');
    expect(block).toContain('[scoreboard report](docs/scoreboard.md).');
    expect(block).not.toContain('example.invalid');
    expect(block).not.toContain('/cells/');
    const md = readFileSync(tables, 'utf8');
    expect(md).toContain("in custody from the sealed receipt's rows, answers and judgments, which stay in custody");
    expect(md).toContain('[cell](scoreboard.md#cells)');
    expect(md).toContain('\n## Cells\n');
    expect(md).not.toContain('example.invalid');
    expect(readFileSync(join(dir, 'scoreboard.md'), 'utf8')).toContain("from this directory's rows");
    expect(checkReceipt(dir, {}).messages).toEqual([]);
    rmSync(dir, { recursive: true });
    rmSync(work, { recursive: true });
  });
});
