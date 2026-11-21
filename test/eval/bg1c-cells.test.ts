/**
 * BG1-C's cell set (eval/runner/q1/cells/bg1c.ts and bg1c-cells.json; docs/benchmarks/2026-11-19-changing-facts-confirmation-preregistration.md,
 * harness item 2) and its definitions.ts and pricing.ts wiring: the committed manifest is fresh and its hash is the one
 * launch amendment A records, the three rows with both live readers and their gating judges and no Gemini view, units of
 * five kept worlds split into halves, particle-1's re-reads by half, the per-world money against the preregistration's
 * table, and each row's pilot on the smoke within a tenth of the row's planned spend. Keyless and offline.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ALL_SETS, ASSUMPTIONS, BG1_JUDGE_BY_READER, BG1_MEASURED, BG1C_JUDGE_BY_READER, BG1C_SETS, bg1ReadUsd, bg1Rates, definitionProblems, frontierJudgesFor, isBg1Benchmark, PER_READER_JUDGE_SETTINGS,
  READER_TOKENS_EXTRA, readerTokens, type CellDefinition, type ReaderTokenTable,
} from '../../eval/runner/q1/cells/definitions.ts';
import { BG1C_GBRAIN_BUILD, BG1C_MANIFEST_PATH, BG1C_RATES, BG1C_SOL, bg1cManifestText, buildBG1CManifest } from '../../eval/runner/q1/cells/bg1c.ts';
import { OPUS, PARTICLE, SOL, stage1SmokeLeaseUsd } from '../../eval/runner/q1/cells/bg1.ts';
import { F6_ARMS } from '../../eval/runner/q1/cells/f6.ts';
import { bg1cPerWorld } from '../../eval/runner/bg1/pricing.ts';
import { BG1_DEV_CONVERSATIONS, BG1_QUESTIONS_PER_WORLD, BG1C_FIRST_HALF_UNITS, BG1C_KEPT_UNITS, BG1C_N_FINAL } from '../../eval/runner/bg1/types.ts';

const ROOT = join(import.meta.dir, '..', '..');
const KINDS = new Set((JSON.parse(readFileSync(join(ROOT, 'eval/systems/kinds.json'), 'utf8')) as { kinds: Array<{ id: string }> }).kinds.map(k => k.id));
const m = buildBG1CManifest();
const ASTRA = 'openai:gpt-6-astra';
const ROWS = ['gbrain-defaults.rs1-stable', 'ext-memory-bank.recipe', 'ext-extract-first.common'];
const rowKey = (c: CellDefinition) => `${c.system}:${c.configuration}`;
/** The cell set's hash as launch amendment A records it; it changes only with a dated amendment (a gbrain re-pin moves it). */
const CELL_SET_SHA256 = '282a5353d3a1d9345dc9877c5535a54a1d461644556a81f40248f7af9c033af9';

describe('bg1c-cells.json', () => {
  test('the committed manifest is what bg1c.ts generates', () => {
    expect(readFileSync(BG1C_MANIFEST_PATH, 'utf8')).toBe(bg1cManifestText(m));
  });

  // Value: protects=launch amendment A names one cell set, and the counted cells run that set; fails_when=any byte of the cell set moves (a rate, a row, a judge, a unit, the gbrain build) without the pin moving with it in a dated amendment; why_new=BG1-C harness item 2 ("a test checks that the cell set's hash is stable"); seam=bg1c-cells.json as committed; no_claim=that the cell set is right, which the other tests check
  test('the cell set\'s hash is pinned', () => {
    expect(createHash('sha256').update(readFileSync(BG1C_MANIFEST_PATH)).digest('hex')).toBe(CELL_SET_SHA256);
  });

  test('three rows on the sealed confirmation set and the same three on the smoke world, every one runnable', () => {
    expect(m.cells.map(c => c.id)).toEqual(ROWS.map(r => `bg1c.${r}`));
    expect(m.smoke_cells.map(c => c.id)).toEqual(ROWS.map(r => `bg1c-dev1.${r}`));
    for (const c of m.cells) expect([c.set, c.block, c.benchmark, c.split, c.canonical_instrument, c.effort]).toEqual(['BG1C', 'BG1C', 'bg1c', 'sealed', 'bg1', 'medium']);
    for (const c of m.smoke_cells) expect([c.set, c.block, c.benchmark, c.split, c.canonical_instrument, c.only_conversations]).toEqual(['BG1C-dev1', 'BG1C-smoke', 'bg1-dev', 'dev', 'bg1-dev', [BG1_DEV_CONVERSATIONS[0]]]);
    for (const c of [...m.cells, ...m.smoke_cells]) expect(definitionProblems(c, KINDS)).toEqual([]);
    expect(m.campaign_id).toBe('q1-scoreboard-bg1c-changing-facts-confirmation');
  });

  test('the sets: the first 40 kept worlds at BG1\'s size per world, and one public dev world for the smoke', () => {
    expect(BG1C_SETS.BG1C).toMatchObject({ benchmark: 'bg1c', split: 'sealed', conversations: BG1C_N_FINAL, questions: BG1C_N_FINAL * BG1_QUESTIONS_PER_WORLD, corpus_tokens: BG1C_N_FINAL * 200_000, role: 'headline', exposure: 'E0' });
    expect(BG1C_SETS['BG1C-dev1']).toMatchObject({ benchmark: 'bg1-dev', split: 'dev', conversations: 1, questions: BG1_QUESTIONS_PER_WORLD, role: 'smoke', only_conversations: ['bg1-dev-01'] });
    for (const id of ['BG1C', 'BG1C-dev1'] as const) expect(ALL_SETS[id]).toBe(BG1C_SETS[id]);
    expect(isBg1Benchmark('bg1c')).toBe(true);
    expect(bg1Rates('bg1c')).toBe(BG1_MEASURED);
  });

  test('every arm is 8,000 tokens read live by claude-opus-5-5 and gpt-6.2-sol; gbrain runs arm P at the pinned build', () => {
    for (const c of [...m.cells, ...m.smoke_cells]) {
      expect(c.arms).toHaveLength(1);
      const a = c.arms[0];
      expect([a.mode, a.budget, a.readers]).toEqual(['packed', 8000, [OPUS, BG1C_SOL]]);
      if (c.system !== 'gbrain-defaults') { expect(a.id).toBe('component-b8000'); continue; }
      expect([a.id, a.retrieval]).toEqual(['p', F6_ARMS.p.retrieval]);
      expect(c.launch!.env).toMatchObject({ GBRAIN_F6: '1', GBRAIN_SHA: BG1C_GBRAIN_BUILD.commit, GBRAIN_F6_EXTRACT_CAP_USD: '1' });
    }
    expect(BG1C_SOL).toBe('openai:gpt-6.2-sol');
    expect(m.gbrain_build).toEqual({ release: 'v0.60.753.0', commit: 'fbf608cf86ea7b2b912ce80151f856a1a47e9533' });
  });
});

describe('judging', () => {
  test('gating judges by bg1JudgeOf with gpt-6.2-sol named, and BG1\'s own map unchanged', () => {
    expect(BG1C_JUDGE_BY_READER).toEqual({ [OPUS]: ASTRA, [BG1C_SOL]: OPUS, [PARTICLE]: OPUS });
    expect(BG1_JUDGE_BY_READER).toEqual({ [OPUS]: ASTRA, [SOL]: OPUS, [PARTICLE]: OPUS });
    expect(m.frontier_judges).toEqual(BG1C_JUDGE_BY_READER);
    for (const c of [...m.cells, ...m.smoke_cells]) for (const a of c.arms) {
      expect(a.frontier).toEqual({ judges: [OPUS, ASTRA], readers: null, sample: null, per_reader: true, judge_by_reader: BG1C_JUDGE_BY_READER, settings: PER_READER_JUDGE_SETTINGS });
      expect(frontierJudgesFor(a, OPUS)).toEqual([ASTRA]);
      expect(frontierJudgesFor(a, BG1C_SOL)).toEqual([OPUS]);
    }
  });

  // Value: protects=the preregistration's "no Gemini view": BG1-C's answers get their gating judge only; fails_when=a cell drops descriptive_view false, a Gemini judge or price enters the cell set, or the check lets the canonical judge go without a per-reader judge on every answer; why_new=BG1-C harness item 2; seam=definitions.ts definitionProblems and the generated manifest; no_claim=that the runner skips the canonical judge, which cell.ts must honour
  test('no Gemini view: every cell sets descriptive_view false, and the cell set names no Gemini model', () => {
    for (const c of [...m.cells, ...m.smoke_cells]) expect(c.descriptive_view).toBe(false);
    expect(bg1cManifestText(m)).not.toContain('gemini');
    for (const r of m.reread_plans) expect(r.judges).toEqual([OPUS]);
    const c = m.cells[0];
    expect(definitionProblems({ ...c, arms: c.arms.map(a => ({ ...a, frontier: null })) }, KINDS).join('\n')).toContain('descriptive_view is false or absent');
    expect(definitionProblems({ ...c, arms: c.arms.map(a => ({ ...a, frontier: { ...a.frontier!, sample: 20 } })) }, KINDS).join('\n')).toContain('descriptive_view is false or absent');
    expect(definitionProblems({ ...c, descriptive_view: true } as unknown as CellDefinition, KINDS).join('\n')).toContain('descriptive_view is false or absent');
  });
});

describe('units and halves', () => {
  test('launch units of five kept worlds, eight a counted cell; the smoke is one unit', () => {
    expect([BG1C_KEPT_UNITS, BG1C_FIRST_HALF_UNITS]).toEqual([5, 4]);
    for (const c of m.cells) expect([c.kept_units, c.shards]).toEqual([5, 8]);
    for (const c of m.smoke_cells) expect([c.kept_units ?? null, c.shards]).toEqual([null, 1]);
  });

  // Value: protects=R113's one look at half the units: the runner and verdict.ts can tell a unit's half from the cell set; fails_when=a unit sits in both halves or neither, the first half is not units 0 to 3 (kept worlds 1 to 20), or particle-1's re-read of a half covers other units; why_new=R113, as GBEV-3 set it for BG1-C on 2026-11-19; seam=bg1c.ts halves and bg1cRereadPlans; no_claim=when the look runs or what it decides
  test('halves: units 0 to 3 of each counted cell (kept worlds 1 to 20) are the first half, 4 to 7 the second, and each re-read plan covers one half', () => {
    expect(m.halves.first).toEqual(m.cells.flatMap(c => [0, 1, 2, 3].map(i => `${c.id}.c${i}`)));
    expect(m.halves.second).toEqual(m.cells.flatMap(c => [4, 5, 6, 7].map(i => `${c.id}.c${i}`)));
    const counted = m.reread_plans.filter(r => r.block === 'BG1C');
    expect(counted.map(r => [r.arm_cell_id, r.half, r.units])).toEqual(m.cells.flatMap(c => [[c.arms[0].cell_id, 1, [0, 1, 2, 3]], [c.arms[0].cell_id, 2, [4, 5, 6, 7]]]));
    expect(counted.map(r => r.id)).toEqual(m.cells.flatMap(c => [1, 2].map(h => `${c.arms[0].cell_id}.reread-particle-particle-1.h${h}`)));
    const smoke = m.reread_plans.filter(r => r.block === 'BG1C-smoke');
    expect(smoke.map(r => [r.id, r.half, r.units])).toEqual(m.smoke_cells.map(c => [`${c.arms[0].cell_id}.reread-particle-particle-1`, null, [0]]));
    for (const r of m.reread_plans) expect([r.reader, r.set]).toEqual([PARTICLE, r.block === 'BG1C' ? 'BG1C' : 'BG1C-dev1']);
    for (const r of counted) expect(r.estimate.usd).toBeCloseTo(20 * BG1_QUESTIONS_PER_WORLD * 26.13 / 6912, 2);
  });
});

describe('money', () => {
  // Value: protects=the preregistration's budget: the cell set prices BG1-C at the table's per-world rates; fails_when=a rate, a row, the gpt-6.2-sol token model or a line moves off the table (4.34, 3.50 + 3.21 + 6.70, 3.34, 0.46, 0.73; 22.28 a world), or the cells and re-reads stop adding up to it; why_new=BG1-C harness item 2 ("a test checks the per-world estimate against the rates above"); seam=pricing.ts bg1cPerWorld, bg1c.ts BG1C_RATES and the generated estimates; no_claim=what BG1-C spends
  test('per world: the preregistration\'s table, and the cells and re-reads plus the mint add up to it', () => {
    const w = bg1cPerWorld();
    expect(w.lines.mint).toBeCloseTo(4.34, 2);
    expect(w.lines.rows).toBeCloseTo(3.5 + 3.21 + 6.7, 2);
    expect(w.lines.sol_reads).toBeCloseTo(3.34, 2);
    expect(w.lines.sol_grading).toBeCloseTo(0.46, 2);
    expect(w.lines.particle_rereads).toBeCloseTo(0.73, 2);
    expect(w.total).toBeCloseTo(22.28, 2);
    const cells = m.cells.reduce((s, c) => s + c.estimate.usd, 0), rereads = m.reread_plans.filter(r => r.block === 'BG1C').reduce((s, r) => s + r.estimate.usd, 0);
    expect((cells + rereads) / BG1C_N_FINAL + BG1C_RATES.mint_usd_per_world).toBeCloseTo(22.28, 2);
    for (const c of m.cells) {
      expect(c.estimate.lines).toEqual({ row_dev_rate: Math.round(BG1C_N_FINAL * BG1C_RATES.row_usd_per_world[rowKey(c)] * 100) / 100, sol_gating_judges: 6.17, sol_reads: 44.57 });
      expect(c.estimate.usd).toBeCloseTo(Object.values(c.estimate.lines).reduce((s, v) => s + v, 0), 1);
    }
    expect(m.blocks.find(b => b.id === 'BG1C-smoke')!.estimate_usd).toBeCloseTo(18, 0);
  });

  test('gpt-6.2-sol has its own keys in the reader token model, at gpt-6.1-sol\'s parameters, and ASSUMPTIONS keeps its bytes', () => {
    const tables: ReaderTokenTable[] = ['reader_input_overhead_tokens', 'reader_tokens_per_budget_token', 'reader_tokens_per_cl100k', 'reader_output_tokens'];
    for (const t of tables) {
      expect(readerTokens(t, BG1C_SOL)).toBe(ASSUMPTIONS[t][SOL]);
      expect(READER_TOKENS_EXTRA[t]).toEqual({ [BG1C_SOL]: ASSUMPTIONS[t][SOL] });
      expect(ASSUMPTIONS[t][BG1C_SOL]).toBeUndefined();
      for (const r of [OPUS, SOL, 'anthropic:claude-sonnet-5-5']) expect(readerTokens(t, r)).toBe(ASSUMPTIONS[t][r] ?? ASSUMPTIONS[t].default);
    }
    expect(readerTokens('reader_output_tokens', BG1C_SOL)).toBe(155);
    expect(BG1C_RATES.sol_read_usd_per_answer).toBe(bg1ReadUsd(BG1C_SOL, 8000));
    expect(BG1C_RATES.sol_read_usd_per_answer).toBeCloseTo(((8000 * 0.975 + 130) * 2 + 155 * 10) / 1e6, 8);
    expect(m.reader_tokens_extra).toEqual(READER_TOKENS_EXTRA);
  });

  // Value: protects=R111: each row's pilot (the smoke on bg1-dev-01 at the counted settings) costs at most a tenth of the row's planned spend at N = 40; fails_when=a smoke row, with its re-read, prices above planned / 10, or a row's planned spend drifts from its rates (gbrain about 40 x (3.50 + (3.34 + 0.46 + 0.73) / 3)); why_new=R111, as GBEV-3 set it for BG1-C on 2026-11-19; seam=the generated smoke cells and re-read plans against pricing.ts bg1cPerWorld rows; no_claim=what the smoke spends
  test('each row\'s pilot on the smoke is at most a tenth of its planned spend at N = 40', () => {
    const planned = (c: CellDefinition) => BG1C_N_FINAL * bg1cPerWorld().rows[rowKey(c)];
    const [gbrain, bank, extract] = m.smoke_cells;
    expect(planned(gbrain)).toBeCloseTo(40 * (3.5 + (3.34 + 0.46 + 0.73) / 3), 0);
    expect(planned(bank)).toBeCloseTo(40 * (3.21 + (3.34 + 0.46 + 0.73) / 3), 0);
    expect(planned(extract)).toBeCloseTo(40 * (6.7 + (3.34 + 0.46 + 0.73) / 3), 0);
    for (const c of m.smoke_cells) {
      const pilot = c.estimate.usd + m.reread_plans.filter(r => r.cell === c.id).reduce((s, r) => s + r.estimate.usd, 0);
      expect(pilot).toBeGreaterThan(0);
      expect(pilot).toBeLessThanOrEqual(planned(c) / 10);
    }
    for (const c of m.cells) expect(c.estimate.usd + m.reread_plans.filter(r => r.cell === c.id).reduce((s, r) => s + r.estimate.usd, 0)).toBeCloseTo(planned(c), 0);
  });

  test('leases, hours and caps: the largest world at BG1\'s ratio, and both blocks inside the $1,200 ledger cap', () => {
    for (const c of [...m.cells, ...m.smoke_cells]) {
      expect(c.lease!.basis).toStartWith('BG1-C: ');
      expect(c.lease!.usd).toBeGreaterThan(c.estimate.usd / c.shards);
    }
    expect(m.cells[0].lease!.basis).toContain('judge openai:gpt-6-astra at 8000 output tokens');
    expect([...m.cells, ...m.smoke_cells].map(c => c.expected_hours)).toEqual([5, 5, 14, 2, 2, 4]);
    const smoke = m.blocks.find(b => b.id === 'BG1C-smoke')!, counted = m.blocks.find(b => b.id === 'BG1C')!;
    expect(smoke.cap_usd).toBeGreaterThanOrEqual(stage1SmokeLeaseUsd(m.smoke_cells));
    expect(counted.cap_usd).toBeGreaterThanOrEqual(m.cells.reduce((s, c) => s + c.lease!.usd * c.shards, 0));
    expect(counted.cap_usd).toBeGreaterThanOrEqual(1.5 * m.cells.reduce((s, c) => s + c.estimate.usd, 0) - 0.01);
    expect([m.total_usd, m.cap_usd]).toEqual([counted.estimate_usd, counted.cap_usd]);
    expect(smoke.cap_usd + counted.cap_usd + m.reread_plans.reduce((s, r) => s + r.estimate.usd, 0)).toBeLessThanOrEqual(1200);
  });
});
