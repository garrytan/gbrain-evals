/**
 * RS1's cell manifest (eval/runner/q1/cells/rs1.ts, rs1-cells.json; GST-1154 PR 2), keyless: the committed file is
 * current; every arm follows the model rules (claude-opus-5-5, gpt-6.1-sol and particle-1 read; no Sonnet, Haiku or
 * Fable reader; no gpt-5.4-mini anywhere) and carries a judging plan that keeps the family rule (GST-767: no judge
 * grades its own family's rows, particle-1 never judges); stage 1 fits its cap or cell.ts plan refuses; think answers
 * under arm P's overlay; and the re-read plans and the sensitivity sample match the tools that run them.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runConfigText, selectCellQuestions } from '../../eval/runner/q1/cell.ts';
import { answerOverlay, definitionProblems, RS1_ASSUMPTIONS, type CellDefinition } from '../../eval/runner/q1/cells/definitions.ts';
import { F6_ARMS } from '../../eval/runner/q1/cells/f6.ts';
import { buildRS1Manifest, loadRS1Manifest, OPUS, PARTICLE, RS1_JUDGES, RS1_MANIFEST_PATH, RS1_READERS, rs1ManifestText, SOL, stage1OverCap } from '../../eval/runner/q1/cells/rs1.ts';
import { modelFamily, planJudges } from '../../eval/runner/q1/cells/judging.ts';
import { rereadCellId } from '../../eval/runner/q1/reread-cell.ts';
import { sensitivitySample } from '../../eval/runner/rs1/judge.ts';
import { ASSUMPTIONS as PRICING } from '../../eval/runner/rs1/pricing.ts';
import { instrumentFor } from '../../eval/runner/memory-qa/instruments.ts';
import type { MemoryQuestion } from '../../eval/runner/memory-qa/corpus.ts';

const ROOT = resolve(import.meta.dir, '../..');
const kinds = new Set((JSON.parse(readFileSync(resolve(ROOT, 'eval/systems/kinds.json'), 'utf8')) as { kinds: Array<{ id: string }> }).kinds.map(k => k.id));
const m = loadRS1Manifest();
const all = [...m.cells, ...m.smoke_cells];
const arms = all.flatMap(c => c.arms.map(a => ({ c, a })));

describe('the RS1 cell manifest', () => {
  test('the committed rs1-cells.json is what rs1.ts generates', () => {
    expect(readFileSync(RS1_MANIFEST_PATH, 'utf8')).toBe(rs1ManifestText(buildRS1Manifest()));
  });

  test('every cell is a valid definition: seven counted cells on RS1 in five-conversation units, eight stage 1 cells on public dev data', () => {
    for (const c of all) expect([c.id, definitionProblems(c, kinds)]).toEqual([c.id, []]);
    expect(m.cells.map(c => c.id)).toEqual(['rs1.gbrain-defaults.rs1-master', 'rs1.ext-extract-first.common', 'rs1.ext-memory-bank.recipe-1.1', 'rs1.ext-temporal-graph.shipped-0.31',
      'rs1.baseline-file-agent.baseline', 'rs1.baseline-hybrid.baseline', 'rs1.baseline-none.baseline']);
    expect(m.cells.every(c => c.set === 'RS1' && c.benchmark === 'beam-rs1' && c.split === 'sealed' && c.shards === 15)).toBe(true);
    expect(m.smoke_cells.every(c => c.block === 'RS1-dry' && c.split === 'dev' && c.benchmark === 'beam-1m')).toBe(true);
    expect(instrumentFor(m.cells[0].canonical_instrument).canonical_judge).toBe('openai:gpt-4.1-mini');
  });

  test('model rules: the readers are claude-opus-5-5, gpt-6.1-sol and particle-1 (particle-1 only on the file agent and think); no Sonnet, Haiku or Fable reader; no gpt-5.4-mini or Fable anywhere', () => {
    expect(m.readers).toEqual(RS1_READERS);
    for (const { a } of arms) {
      expect(a.readers.every(r => RS1_READERS.includes(r))).toBe(true);
      expect(a.readers.some(r => /sonnet|haiku|fable/i.test(r))).toBe(false);
      expect(a.readers.includes(PARTICLE)).toBe(a.mode === 'agent' || a.mode === 'own-answer');
    }
    expect(readFileSync(RS1_MANIFEST_PATH, 'utf8')).not.toMatch(/gpt-5\.4-mini|fable/i);
  });

  test('family rule: every arm plans judges for each reader (and particle-1\'s re-reads of packed arms), none of the reader\'s family, never particle-1; particle-1 scores the mean of both counted judges', () => {
    expect(RS1_JUDGES).toEqual({ [OPUS]: ['openai:gpt-4.1-mini'], [SOL]: ['anthropic:claude-haiku-5-5'], [PARTICLE]: ['openai:gpt-4.1-mini', 'anthropic:claude-haiku-5-5'] });
    for (const { a } of arms) {
      const plan = a.judging!.by_reader;
      expect(Object.keys(plan).sort()).toEqual([...new Set([...a.readers, ...(a.mode === 'packed' ? [PARTICLE] : [])])].sort());
      for (const [r, judges] of Object.entries(plan)) {
        expect(judges).toEqual(RS1_JUDGES[r]);
        expect(judges.some(j => modelFamily(j) === modelFamily(r) || modelFamily(j) === 'particle')).toBe(false);
      }
    }
    expect(new Set(arms.flatMap(({ a }) => planJudges(a)))).toEqual(new Set(['anthropic:claude-haiku-5-5', 'openai:gpt-4.1-mini']));
  });

  test('a judge of its reader\'s family, an OpenAI-compatible judge, a judge with no route, a reader with no judge and a plan on a retrieval-only arm are refused', () => {
    const c = m.smoke_cells.find(x => x.id === 'rs1-dev.baseline-none.baseline')!;
    const withPlan = (by_reader: Record<string, string[]>, extra = {}): CellDefinition => ({ ...c, arms: [{ ...c.arms[0], judging: { by_reader }, ...extra }] });
    const problems = (by_reader: Record<string, string[]>, extra = {}) => definitionProblems(withPlan(by_reader, extra), kinds).join('; ');
    expect(problems({ [OPUS]: ['anthropic:claude-haiku-5-5'], [SOL]: ['anthropic:claude-haiku-5-5'] })).toContain('a reader of its own family (GST-767)');
    expect(problems({ [OPUS]: [PARTICLE], [SOL]: ['anthropic:claude-haiku-5-5'] })).toContain('OpenAI-compatible model, which never judges');
    expect(problems({ [OPUS]: ['gemini:gemini-3.8-flash'], [SOL]: ['anthropic:claude-haiku-5-5'] })).toContain('has no chat route');
    expect(problems({ [OPUS]: ['openai:gpt-4.1-mini'] })).toContain(`judging.by_reader.${SOL} must list at least one judge`);
    expect(problems({ [OPUS]: ['openai:gpt-4.1-mini'], [SOL]: ['anthropic:claude-haiku-5-5', 'anthropic:claude-haiku-5-5'] })).toContain('each once');
    expect(problems({}, { mode: 'retrieval-only', readers: [], budget: null })).toContain('carries no judging plan');
  });

  test('stage 1 (review d1): arm P at both pins, the three servers, hybrid and the floor on five dev conversations; think and the file agent on two; its estimate fits $220', () => {
    const s = (id: string) => m.smoke_cells.find(c => c.id === id)!;
    expect(m.sets.find(x => x.id === 'RS1-dev')!.only_conversations).toEqual(['1m-20', '1m-28', '1m-32', '1m-24', '1m-21']);
    expect(s('rs1-dev.gbrain-defaults.rs1-master').arms.map(a => [a.id, a.set])).toEqual([['p', 'RS1-dev'], ['whole-think', 'RS1-dev2']]);
    expect(s('rs1-dev.gbrain-defaults.rs1-master').arms[1].questions).toEqual({ kind: 'conversations', conversations: ['1m-20', '1m-28'] });
    expect(s('rs1-dev.gbrain-defaults.f6-master').arms[0].retrieval).toEqual(s('rs1-dev.gbrain-defaults.rs1-master').arms[0].retrieval);
    expect(s('rs1-dev.gbrain-defaults.f6-master').launch!.env.GBRAIN_SHA).not.toBe(s('rs1-dev.gbrain-defaults.rs1-master').launch!.env.GBRAIN_SHA);
    expect(s('rs1-dev2.baseline-file-agent.baseline').only_conversations).toEqual(['1m-20', '1m-28']);
    expect(m.stage1_estimate_usd).toBeLessThanOrEqual(m.stage1_cap_usd);
    expect(m.stage1_cap_usd).toBe(220);
    expect(m.blocks.find(b => b.id === 'RS1-dry')!.cap_usd).toBe(220);
    expect(RS1_ASSUMPTIONS.check_judge_usd_per_answer).toBe((PRICING.judge_per_answer as Record<string, number>)[m.stage1_judge_check.judge]);
    const qs = (conversation: string, n: number) => Array.from({ length: n }, (_, i) => ({ id: `${conversation}:q${i}`, conversation }) as MemoryQuestion);
    expect(selectCellQuestions([...qs('1m-20', 2), ...qs('1m-32', 2), ...qs('1m-28', 1)], { kind: 'conversations', conversations: ['1m-20', '1m-28'] }).map(q => q.id)).toEqual(['1m-20:q0', '1m-20:q1', '1m-28:q0']);
  });

  test('cell.ts plan --manifest rs1 refuses a stage 1 estimate above its cap with RS1_STAGE1_OVER_CAP (review d10)', () => {
    expect(stage1OverCap(m)).toBeNull();
    const over = stage1OverCap({ stage1_estimate_usd: 220.01, stage1_cap_usd: 220 })!;
    expect(over.code).toBe('RS1_STAGE1_OVER_CAP');
    expect(over.message).toContain('$220.01');
    expect(over.fix.next).toBe('ask_user');
    const r = Bun.spawnSync(['bun', 'eval/runner/q1/cell.ts', 'plan', '--manifest', 'rs1'], { cwd: ROOT });
    expect(r.exitCode).toBe(0);
    const out = r.stdout.toString();
    expect(out).toContain('rs1.gbrain-defaults.rs1-master');
    expect(out.split('\n')[0]).toStartWith('RS1 cell manifest: 7 cells');
    expect(out).toContain('stage 1 at $153.94 of its $220.00 cap');
    expect(out).toContain('eval/runner/q1/cells/rs1-cells.json');
    expect(out).not.toContain('Q1 cell manifest');
  });

  test('think answers under arm P\'s six search keys (review d6): one overlay per cell, recorded in its run config', () => {
    for (const c of all.filter(x => x.arms.some(a => a.mode === 'own-answer'))) {
      expect(answerOverlay(c)).toEqual(answerOverlay({ arms: [{ ...c.arms[0], id: 'p', retrieval: F6_ARMS.p.retrieval }] }));
      const think = c.arms.find(a => a.mode === 'own-answer')!;
      const config = JSON.parse(runConfigText(c, think, { instrument: instrumentFor('beam-1m'), dataset: { name: 'x', files: [], revision: 'x', license: 'x' }, scheduledSha: 'x', limit: null }));
      expect(config.answer_overlay).toEqual(answerOverlay(c));
      expect(config.arm.judging).toEqual(think.judging);
    }
    const c = m.cells[0];
    const second = { ...c.arms[0], id: 'c', cell_id: `${c.id}.c`, retrieval: F6_ARMS.c.retrieval };
    expect(definitionProblems({ ...c, arms: [...c.arms, second] }, kinds).join('; ')).toContain('names one overlay across its retrieval identities');
  });

  test('re-read plans: particle-1 re-reads every packed arm under reread-cell.ts\'s id, judged by its plan for particle-1, each priced', () => {
    const packed = arms.filter(({ a }) => a.mode === 'packed');
    expect(m.reread_plans.map(r => r.id)).toEqual(packed.map(({ a }) => rereadCellId(a.cell_id, PARTICLE)));
    for (const r of m.reread_plans) {
      expect(r.judges).toEqual(RS1_JUDGES[PARTICLE]);
      expect(r.estimate.usd).toBeGreaterThan(0);
    }
  });

  test('the sensitivity sample is judge.ts\'s: 23 of RS1\'s 75 conversations', () => {
    const ids = Array.from({ length: 75 }, (_, i) => `rs1-${String(i + 1).padStart(3, '0')}`);
    expect(m.sensitivity_sample.conversations).toHaveLength(23);
    expect(m.sensitivity_sample.conversations).toEqual([...sensitivitySample(ids)].sort());
  });
});
