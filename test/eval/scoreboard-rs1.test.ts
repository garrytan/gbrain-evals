/**
 * The scoreboard's RS1 mode (eval/runner/scoreboard.ts, header "RS1 mode"): a synthetic RS1 receipt renders the frozen
 * analysis's verdict lines and first table, and check refuses a receipt that loosens the rs1 block, the cells' readers
 * or judge plans, or that runs against a verdict.ts whose hash the block does not name. Every receipt here is synthetic.
 */
import { describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkReceipt, deriveAll, loadCampaign, renderAll, renderHeadline, RS1_COST_FILE, SCOREBOARD_SCHEMA_RS1, type CampaignManifest, type Scoreboard, type ScoreboardCode } from '../../eval/runner/scoreboard.ts';
import { ARMS, OPUS, PARTICLE, SENSITIVITY_JUDGE, SOL } from '../../eval/runner/rs1/verdict.ts';
import { rs1Cells, writeSyntheticRs1Receipt, type Rs1SyntheticOptions } from './fixtures/scoreboard/synthetic.ts';

const T = 120_000;

function fresh(o: Rs1SyntheticOptions = {}): { dir: string; sb: Scoreboard } {
  const dir = mkdtempSync(join(tmpdir(), 'scoreboard-rs1-'));
  writeSyntheticRs1Receipt(dir, o);
  const { campaign } = loadCampaign(dir);
  const d = deriveAll(dir);
  for (const f of renderAll(dir, d, campaign).files) { mkdirSync(dirname(f.path), { recursive: true }); writeFileSync(f.path, f.text); }
  return { dir, sb: d.scoreboard };
}

const family = (sb: Scoreboard, id: 'A' | 'B', group: 'counted' | 'particle-1' = 'counted') => sb.rs1!.families.find(f => f.id === id && f.group === group)!.comparisons;
const cells = (f: (c: ReturnType<typeof rs1Cells>[number]) => object) => rs1Cells().map(c => ({ ...c, ...f(c) }));

const base = fresh();

describe('RS1 render', () => {
  test('the verdict lines, then the first table (Opus and particle-1, with cost per correct answer), then Sol', () => {
    const { sb, dir } = base;
    expect(sb.schema).toBe(SCOREBOARD_SCHEMA_RS1);
    expect(sb.power).toBeNull();
    expect(sb.rs1!.ranking.claimed).toBe(true);
    expect(sb.verdict).toBe(sb.rs1!.ranking.sentence);
    const md = renderHeadline(sb, '.');
    const lines = md.split('\n');
    expect(lines).toContain(sb.rs1!.lines[0]);
    for (const l of sb.rs1!.lines.slice(1)) expect(lines).toContain(`- ${l}`);
    const [first, rest] = md.split(`Then ${SOL}:`);
    expect(rest).toBeDefined();
    expect(first).toContain('| Kind and configuration | Arm | Reader | Graded accuracy | Scored | Cost per correct answer, R = 1 | Cost per correct answer, R = 20 | Cost per correct answer, R = 200 |');
    expect(first).toContain(`| \`gbrain-defaults\` rs1-master | p | ${OPUS} |`);
    expect(first).toContain(`| \`gbrain-defaults\` rs1-master | whole-think | ${PARTICLE} |`);
    expect(first).toContain(`| \`ext-memory-bank\` recipe-1.1 | component-b8000 | ${OPUS} |`);
    expect(first).not.toContain(SOL + ' |');
    expect(rest).toContain(`| \`gbrain-defaults\` rs1-master | p | ${SOL} |`);
    expect(first.indexOf(sb.rs1!.lines[0])).toBeLessThan(first.indexOf('| Kind and configuration'));
    const report = readFileSync(join(dir, 'scoreboard.md'), 'utf8');
    for (const h of ['## RS1 verdicts', '### Family A', '### Family B', '### particle-1 family A, reported apart and never part of the ranking', '## Delivered context of the 8k rows', '## Judge sensitivity']) expect(report).toContain(h);
    expect(report).not.toContain('## Claim sentences');
    expect(checkReceipt(dir, {}).messages).toEqual([]);
  }, T);

  test('without re-reads, cost or sensitivity files: particle-1 rows not run, cost not measured, no judge comparison, the ranking unchanged', () => {
    const { sb, dir } = fresh({ rereads: false, cost: false, sensitivity: false });
    expect(family(sb, 'A', 'particle-1').map(c => c.outcome)).toEqual(['not-run', 'not-run', 'not-run']);
    expect(family(sb, 'A', 'particle-1')[0].why).toContain('has no particle-1 re-read in the receipt');
    expect(family(sb, 'B', 'particle-1')[0].outcome).toBe('ahead');
    expect(sb.rs1!.table.every(t => t.cost === null)).toBe(true);
    expect(renderHeadline(sb, '.')).toContain('| not measured | not measured | not measured |');
    expect(sb.rs1!.judge_sensitivity.comparisons[0].judge.why).toContain(`no ${SENSITIVITY_JUDGE} judgment`);
    expect(sb.rs1!.ranking).toEqual(base.sb.rs1!.ranking);
    expect(family(sb, 'A')).toEqual(family(base.sb, 'A'));
    expect(checkReceipt(dir, {}).messages).toEqual([]);
  }, T);

  test('missing data: a harness failure and an unjudged particle-1 answer leave their questions, counted by reason', () => {
    const { sb } = fresh({ cells: cells(c => (c.id === ARMS.gbrain8k ? { harnessFail: [[0, OPUS]], dropJudge: [[1, PARTICLE, 'anthropic:claude-haiku-5-5']] } : {})) });
    const a = family(sb, 'A')[0], p = family(sb, 'A', 'particle-1')[0];
    expect([a.paired, a.scheduled]).toEqual([59, 60]);
    expect(a.excluded).toEqual([{ reason: `gbrain-defaults: harness: reader_error (${OPUS})`, count: 1 }]);
    expect(p.paired).toBe(59);
    expect(p.excluded[0].reason).toContain('judge_error');
    expect(family(sb, 'B')[0].paired).toBe(60);
  }, T);

  test('a comparator not run or outside the gate blocks the ranking sentence', () => {
    const { sb, dir } = fresh({ cells: cells(c => (c.id === ARMS.servers[1] ? { status: 'not-run', not_run_reason: 'synthetic outage' } : c.id === ARMS.servers[2] ? { delivered: () => 9000 } : {})) });
    expect(family(sb, 'A').map(c => c.outcome)).toEqual(['ahead', 'not-run', 'descriptive']);
    expect(sb.rs1!.ranking.claimed).toBe(false);
    expect(sb.verdict).toContain('no ranking claim is made');
    expect(sb.rs1!.gate.find(g => g.cell_id === ARMS.servers[2])).toMatchObject({ mean: 9000, pass: false });
    expect(checkReceipt(dir, {}).messages).toEqual([]);
  }, T);
});

describe('RS1 check refusals', () => {
  const mutated = (f: (c: CampaignManifest) => void, file = 'campaign.json') => {
    const dir = mkdtempSync(join(tmpdir(), 'scoreboard-rs1-check-'));
    cpSync(base.dir, dir, { recursive: true });
    const path = join(dir, file), x = JSON.parse(readFileSync(path, 'utf8'));
    f(x);
    writeFileSync(path, JSON.stringify(x, null, 2) + '\n');
    return checkReceipt(dir, {}).messages;
  };
  const refused = (f: (c: CampaignManifest) => void, code: ScoreboardCode, text: string) => {
    const m = mutated(f);
    expect(m.map(x => x.code)).toContain(code);
    expect(m.find(x => x.code === code)!.message).toContain(text);
  };
  test('a loosened margin', () => refused(c => { c.rs1!.families[0].margin_points = 5; }, 'RECEIPT_INVALID', 'family A margin is 5 points'), T);
  test('a loosened interval level', () => refused(c => { c.rs1!.families[0].interval_level = 0.95; }, 'RECEIPT_INVALID', 'family A interval level is 0.95'), T);
  test('a changed reader list', () => refused(c => { c.rs1!.readers.counted = [OPUS]; }, 'RECEIPT_INVALID', 'rs1 readers'), T);
  test('a changed judge plan in the block', () => refused(c => { c.rs1!.judges[OPUS] = ['gemini:gemini-3.8-flash']; }, 'RECEIPT_INVALID', 'rs1 judges'), T);
  test('a cell judged outside the frozen plan', () => refused(c => { c.cells[0].judging = { by_reader: { [OPUS]: ['gemini:gemini-3.8-flash'], [SOL]: ['anthropic:claude-haiku-5-5'] } }; }, 'RECEIPT_INVALID', 'judge'), T);
  test('a loosened gate', () => refused(c => { c.rs1!.gate.high = 9000; }, 'RECEIPT_INVALID', 'rs1 gate'), T);
  test('a verdict.ts hash the block does not name', () => refused(c => { c.rs1!.verdict_sha256 = 'f'.repeat(64); }, 'SCOREBOARD_STALE', 'eval/runner/rs1/verdict.ts hashes to'), T);
  test('a dated amendment naming the current hash is accepted', () => {
    const m = mutated(c => { const now = c.rs1!.verdict_sha256; c.rs1!.verdict_sha256 = 'f'.repeat(64); c.rs1!.amendments = [{ id: 'A1', date: '2026-11-05', verdict_sha256: now, reason: 'synthetic amendment' }]; });
    expect(m.map(x => x.code)).not.toContain('RECEIPT_INVALID');
    expect(m.filter(x => x.message.includes('hashes to'))).toEqual([]);
  }, T);
  test('a cost file at another VM rate', () => {
    const m = mutated(c => { (c as unknown as { vcpu_hour_usd: number }).vcpu_hour_usd = 0.04; }, RS1_COST_FILE);
    expect(m.map(x => x.code)).toContain('RECEIPT_INVALID');
    expect(m.find(x => x.code === 'RECEIPT_INVALID')!.message).toContain(RS1_COST_FILE);
  }, T);
});
