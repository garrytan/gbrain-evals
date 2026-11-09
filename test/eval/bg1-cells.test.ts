/**
 * BG1's cell definitions (eval/runner/q1/cells/bg1.ts and bg1-cells.json) and their definitions.ts wiring: the
 * committed manifest is fresh, the six rows and the full-context reference on the sealed set and on the three dev
 * worlds, readers, budgets, kept units and shards, the per-reader judge map and its pinned settings, per-call judge
 * pricing, leases from the peak reservation, particle-1's re-read plans, waves, and the stage 1 cap and its refusal.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ALL_SETS, BG1_ASSUMPTIONS, BG1_JUDGE_BY_READER, BG1_SETS, bg1JudgeOf, definitionProblems, frontierJudgesFor, isBg1Benchmark, PER_READER_JUDGE_SETTINGS,
} from '../../eval/runner/q1/cells/definitions.ts';
import { BG1_FC_UNITS, BG1_MANIFEST_PATH, bg1ManifestText, bg1Stage1OverCap, buildBG1Manifest, canonicalJudgeUsd, OPUS, PARTICLE, SOL, stage1CapUsd } from '../../eval/runner/q1/cells/bg1.ts';
import { BG1_DEV_CONVERSATIONS, BG1_KEPT_UNITS, BG1_N_CAP, BG1_QUESTIONS_PER_WORLD } from '../../eval/runner/bg1/types.ts';
import { campaignCells } from '../../eval/runner/q1/cell.ts';

const ROOT = join(import.meta.dir, '..', '..');
const KINDS = new Set((JSON.parse(readFileSync(join(ROOT, 'eval/systems/kinds.json'), 'utf8')) as { kinds: Array<{ id: string }> }).kinds.map(k => k.id));
const m = buildBG1Manifest();
const smokeLeases = Math.round(campaignCells(m, { smoke: true }).filter(c => c.smoke && c.block === 'BG1-S1').reduce((s, c) => s + c.lease_usd, 0) * 100) / 100;
const ASTRA = 'openai:gpt-6-astra';
const ROWS = ['gbrain-defaults.rs1-stable', 'ext-memory-bank.recipe', 'ext-extract-first.common', 'ext-temporal-graph.shipped-0.31', 'baseline-hybrid.baseline', 'baseline-none.baseline'];

describe('bg1-cells.json', () => {
  test('the committed manifest is what bg1.ts generates', () => {
    expect(readFileSync(BG1_MANIFEST_PATH, 'utf8')).toBe(bg1ManifestText(m));
  });

  test('six rows on the sealed set plus the full-context reference on BG1-fc10, and the same seven cells on the three dev worlds in stage 1', () => {
    expect(m.cells.map(c => c.id)).toEqual([...ROWS.map(r => `bg1.${r}`), 'bg1-fc10.baseline-full-context.baseline']);
    expect(m.smoke_cells.map(c => c.id)).toEqual([...ROWS, 'baseline-full-context.baseline'].map(r => `bg1-dev3.${r}`));
    for (const c of m.cells) expect([c.block, c.benchmark, c.split, c.canonical_instrument, c.effort]).toEqual(['BG1', 'bg1', 'sealed', 'bg1', 'medium']);
    for (const c of m.smoke_cells) expect([c.block, c.benchmark, c.split, c.set]).toEqual(['BG1-S1', 'bg1-dev', 'dev', 'BG1-dev3']);
    for (const c of [...m.cells, ...m.smoke_cells]) expect(definitionProblems(c, KINDS)).toEqual([]);
  });

  test('the sets: the sealed headline at the cap of 40 kept worlds, ten worlds for the reference and the three public dev worlds', () => {
    expect(BG1_SETS.BG1).toMatchObject({ benchmark: 'bg1', conversations: BG1_N_CAP, questions: BG1_N_CAP * BG1_QUESTIONS_PER_WORLD, role: 'headline' });
    expect(BG1_SETS['BG1-fc10']).toMatchObject({ benchmark: 'bg1', conversations: 10, questions: 10 * BG1_QUESTIONS_PER_WORLD });
    expect(BG1_SETS['BG1-dev3']).toMatchObject({ benchmark: 'bg1-dev', split: 'dev', role: 'smoke', only_conversations: [...BG1_DEV_CONVERSATIONS] });
    for (const id of ['BG1', 'BG1-fc10', 'BG1-dev3'] as const) expect(ALL_SETS[id]).toBe(BG1_SETS[id]);
    expect(isBg1Benchmark('bg1')).toBe(true);
    expect(isBg1Benchmark('bg1-dev')).toBe(true);
    expect(isBg1Benchmark('beam-rs1')).toBe(false);
  });

  test('every packed arm is 8,000 tokens read by Opus and Sol; gbrain runs arm P; the reference is a full-context arm', () => {
    for (const c of [...m.cells, ...m.smoke_cells]) for (const a of c.arms) {
      expect(a.readers).toEqual([OPUS, SOL]);
      if (c.system === 'baseline-full-context') expect([a.id, a.mode]).toEqual(['whole-full-context', 'full-context']);
      else expect([a.id, a.mode, a.budget]).toEqual([c.system === 'gbrain-defaults' ? 'p' : 'component-b8000', 'packed', 8000]);
    }
  });

  test('launch units: six kept worlds per unit on BG1 (seven shards to the cap), five on the reference (two shards), none on the dev worlds', () => {
    for (const c of m.cells.slice(0, 6)) expect([c.kept_units, c.shards]).toEqual([BG1_KEPT_UNITS, Math.ceil(BG1_N_CAP / BG1_KEPT_UNITS)]);
    expect([m.cells[6].kept_units, m.cells[6].shards]).toEqual([BG1_FC_UNITS, 2]);
    for (const c of m.smoke_cells) expect([c.kept_units ?? null, c.shards]).toEqual([null, 1]);
  });

  test('waves: A holds units 0 and 1 of each row and both reference units, B the rest', () => {
    expect(m.waves.A).toHaveLength(6 * 2 + 2);
    expect(m.waves.B).toHaveLength(6 * 5);
    expect(m.waves.A).toContain('bg1-fc10.baseline-full-context.baseline.c1');
    expect(m.waves.B).not.toContain('bg1.gbrain-defaults.rs1-stable.c1');
    expect(m.waves.B).toContain('bg1.gbrain-defaults.rs1-stable.c2');
  });
});

describe('judging', () => {
  test('the judge map: Astra for Anthropic readers, Opus for OpenAI and particle readers, and any other family refused', () => {
    expect(bg1JudgeOf(OPUS)).toBe(ASTRA);
    expect(bg1JudgeOf(SOL)).toBe(OPUS);
    expect(bg1JudgeOf(PARTICLE)).toBe(OPUS);
    expect(() => bg1JudgeOf('gemini:gemini-3.8-flash')).toThrow();
    expect(BG1_JUDGE_BY_READER).toEqual({ [OPUS]: ASTRA, [SOL]: OPUS, [PARTICLE]: OPUS });
    for (const [reader, judge] of Object.entries(BG1_JUDGE_BY_READER)) expect(judge.split(':')[0]).not.toBe(reader.split(':')[0]);
  });

  test('five system rows and the reference get one gating judge per reader at the pinned settings; the floor gets the canonical judge only', () => {
    for (const c of [...m.cells, ...m.smoke_cells]) for (const a of c.arms) {
      if (c.system === 'baseline-none') { expect(a.frontier).toBeNull(); continue; }
      expect(a.frontier).toMatchObject({ per_reader: true, judges: [OPUS, ASTRA], judge_by_reader: BG1_JUDGE_BY_READER, settings: PER_READER_JUDGE_SETTINGS });
      expect(frontierJudgesFor(a, OPUS)).toEqual([ASTRA]);
      expect(frontierJudgesFor(a, SOL)).toEqual([OPUS]);
    }
  });

  test('judge lines are priced per call: the canonical judge on every answer, and the mapped gating judge per reader', () => {
    for (const c of m.cells) {
      const n = ALL_SETS[c.set].questions;
      expect(c.estimate.lines.judges).toBeCloseTo(n * 2 * canonicalJudgeUsd(), 1);
      if (c.system === 'baseline-none') expect(c.estimate.lines.frontier_judges).toBeUndefined();
      else expect(c.estimate.lines.frontier_judges).toBeCloseTo(n * (BG1_ASSUMPTIONS.judge_usd_per_call[ASTRA] + BG1_ASSUMPTIONS.judge_usd_per_call[OPUS]), 1);
      expect(c.estimate.usd).toBeCloseTo(Object.values(c.estimate.lines).reduce((s, v) => s + v, 0), 1);
    }
  });

  test('every lease holds twice the peak reservation over its largest shard, a pinned judge for the rows and a whole-history read for the reference', () => {
    for (const c of [...m.cells, ...m.smoke_cells]) {
      expect(c.lease!.basis).toStartWith('BG1: ');
      expect(c.lease!.usd).toBeGreaterThan(0);
    }
    expect(m.cells[0].lease!.basis).toContain('judge openai:gpt-6-astra at 8000 output tokens');
    expect(m.cells[6].lease!.basis).toContain('whole-history read anthropic:claude-opus-5-5');
  });
});

describe('re-reads and stage 1', () => {
  test('particle-1 re-reads every packed row once, on the sealed set and in stage 1, with its gating judge on the system rows only', () => {
    expect(m.reread_plans).toHaveLength(12);
    for (const r of m.reread_plans) {
      expect(r.reader).toBe(PARTICLE);
      expect(r.judges).toEqual(r.cell.includes('baseline-none') ? ['gemini:gemini-3.8-flash'] : ['gemini:gemini-3.8-flash', OPUS]);
      expect(r.estimate.usd).toBeGreaterThan(0);
    }
    expect(m.reread_plans.filter(r => r.block === 'BG1-S1')).toHaveLength(6);
    expect(m.reread_plans.some(r => r.cell.includes('full-context'))).toBe(false);
  });

  test('stage 1 is its cells, its re-reads and the judge check, capped at min(300, the larger of the estimate / 0.75 and the smoke leases, rounded up)', () => {
    const cells = m.smoke_cells.reduce((s, c) => s + c.estimate.usd, 0);
    const rereads = m.reread_plans.filter(r => r.block === 'BG1-S1').reduce((s, r) => s + r.estimate.usd, 0);
    expect(m.stage1_estimate_usd).toBeCloseTo(cells + rereads + m.judge_check.estimate_usd, 1);
    expect(m.stage1_cap_usd).toBe(stage1CapUsd(m.stage1_estimate_usd, smokeLeases));
    expect(m.blocks.find(b => b.id === 'BG1-S1')!.cap_usd).toBe(m.stage1_cap_usd);
    expect(m.judge_check).toMatchObject({ dev_answers: 160, construction_items: 160 });
  });

  // Value: protects=stage 1's cap holds every lease the launch check sums for it; fails_when=the cap falls below the smoke units' leases, so BG1's launch check refuses stage 1 before any unit boots; why_new=the preregistration's Amendment 1 (each smoke unit leases twice its estimate, above the estimate / 0.75 the cap allowed); seam=campaignCells' smoke leases from the generated manifest; no_claim=what stage 1 spends
  test('stage 1\'s cap is at or above its smoke units\' summed leases, as campaignCells prices them', () => {
    expect(smokeLeases).toBeGreaterThan(0);
    expect(m.stage1_cap_usd).toBeGreaterThanOrEqual(smokeLeases);
    expect(m.blocks.find(b => b.id === 'BG1-S1')!.cap_usd).toBeGreaterThanOrEqual(smokeLeases);
  });

  test('the stage 1 refusal fires only above the cap, and writes nothing', () => {
    expect(bg1Stage1OverCap(m)).toBeNull();
    const over = bg1Stage1OverCap({ stage1_estimate_usd: 301, stage1_cap_usd: 300 })!;
    expect(over.code).toBe('BG1_STAGE1_OVER_CAP');
    expect(over.fix.next).toBe('ask_user');
    expect(over.state).toMatchObject({ side_effects: 'none: no campaign manifest written, nothing reserved' });
  });
});
