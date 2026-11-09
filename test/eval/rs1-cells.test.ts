import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keptUnit, requiredJudges } from '../../eval/runner/q1/cell.ts';
import { definitionProblems, frontierJudgeOf, frontierJudgesFor, ingestRate, runsF6, type CellDefinition } from '../../eval/runner/q1/cells/definitions.ts';
import { buildRS1Manifest, OPUS, PARTICLE, RS1_MANIFEST_PATH, rs1ManifestText, SOL, stage1OverCap } from '../../eval/runner/q1/cells/rs1.ts';
import type { Rs1Manifest } from '../../eval/runner/memory-qa/corpus.ts';

const ROOT = join(import.meta.dir, '..', '..');
const KINDS = new Set((JSON.parse(readFileSync(join(ROOT, 'eval/systems/kinds.json'), 'utf8')) as { kinds: Array<{ id: string }> }).kinds.map(k => k.id));
const m = buildRS1Manifest();
const INSTRUMENT = { id: 'beam-rubric', canonical_judge: 'openai:gpt-4.1-mini' };
const gbrain = () => structuredClone(m.cells.find(c => c.system === 'gbrain-defaults')!) as CellDefinition;

describe('rs1-cells.json', () => {
  test('the committed manifest is what rs1.ts generates', () => {
    expect(readFileSync(RS1_MANIFEST_PATH, 'utf8')).toBe(rs1ManifestText(m));
  });

  test('four counted cells and four stage 1 cells, by role, with the preregistered readers, launch units and pins', () => {
    expect(m.cells.map(c => c.id)).toEqual(['rs1.gbrain-defaults.rs1-stable', 'rs1.ext-memory-bank.recipe', 'rs1.ext-extract-first.common', 'rs1.baseline-none.baseline']);
    expect(m.smoke_cells.map(c => c.arms[0].set)).toEqual(['RS1-dev2', 'RS1-dev2', 'RS1-dev2', 'RS1-dev2']);
    for (const c of [...m.cells, ...m.smoke_cells]) {
      expect(definitionProblems(c, KINDS)).toEqual([]);
      expect(c.arms.map(a => [a.mode, a.budget, a.readers])).toEqual([['packed', 8000, [OPUS, SOL]]]);
      expect(c.effort).toBe('medium');
    }
    for (const c of m.cells) expect([c.shards, c.kept_units]).toEqual([7, 5]);
    const g = gbrain();
    expect(g.arms[0].id).toBe('p');
    const f6 = JSON.parse(readFileSync(join(ROOT, 'eval/runner/q1/cells/f6-cells.json'), 'utf8')).cells.find((c: CellDefinition) => c.system === 'gbrain-defaults').arms.find((a: { id: string }) => a.id === 'p');
    expect([g.arms[0].retrieval, g.arms[0].policy]).toEqual([f6.retrieval, f6.policy]);
    expect(g.launch?.env.GBRAIN_F6).toBe('1');
    expect(g.launch?.env.GBRAIN_SHA).toBe('27f8b9d6287c2ba635532c7d3bc015c50e1d769b');
    expect(Number(g.launch?.env.GBRAIN_F6_EXTRACT_CAP_USD)).toBeGreaterThan(0);
    expect(m.waves.A.length).toBe(16);
  });

  test('system rows carry per-reader frontier judging; the floor carries the protocol judge only', () => {
    for (const c of m.cells) {
      const arm = c.arms[0];
      if (c.system === 'baseline-none') { expect(arm.frontier ?? null).toBeNull(); continue; }
      expect(arm.frontier?.per_reader).toBe(true);
      expect(frontierJudgesFor(arm, OPUS)).toEqual(['openai:gpt-6.1-sol']);
      expect(frontierJudgesFor(arm, SOL)).toEqual(['anthropic:claude-opus-5-5']);
    }
    const plans = m.reread_plans.filter(p => p.set === 'RS1');
    expect(plans.map(p => p.reader)).toEqual([PARTICLE, PARTICLE, PARTICLE, PARTICLE]);
    expect(plans.map(p => p.judges)).toEqual([...Array(3).fill(['openai:gpt-4.1-mini', 'openai:gpt-6.1-sol']), ['openai:gpt-4.1-mini']]);
  });

  test('stage 1 fits its $60 cap, and an estimate above it refuses with RS1_STAGE1_OVER_CAP', () => {
    expect(m.stage1_cap_usd).toBe(60);
    expect(stage1OverCap(m)).toBeNull();
    expect(stage1OverCap({ stage1_estimate_usd: 60.01, stage1_cap_usd: 60 })?.code).toBe('RS1_STAGE1_OVER_CAP');
  });

  test('the counted block caps at 1.5 times its cells\' own estimate; its re-reads spend from their own ledgers', () => {
    const counted = m.blocks.find(b => b.id === 'RS1')!;
    const cellsUsd = m.cells.reduce((s, c) => s + c.estimate.usd, 0);
    const leases = m.cells.reduce((s, c) => s + c.lease!.usd * c.shards, 0);
    expect(counted.cap_usd).toBe(Math.round(Math.max(cellsUsd * 1.5, leases) * 100) / 100);
    expect(counted.cap_usd).toBe(760.79);
    expect(m.cap_usd).toBe(counted.cap_usd);
    expect(counted.estimate_usd).toBe(Math.round((cellsUsd + m.reread_plans.filter(p => p.block === 'RS1').reduce((s, p) => s + p.estimate.usd, 0)) * 100) / 100);
  });

  test('stage 1\'s $60 covers the dry-run campaign and its re-reads together, and a larger stage 1 re-read ledger cap refuses', () => {
    const rereads = Math.round(m.reread_plans.filter(p => p.block === 'RS1-S1').reduce((s, p) => s + p.estimate.usd, 0) * 100) / 100;
    expect(m.stage1_reread_cap_usd).toBe(rereads);
    expect(m.stage1_reread_cap_usd).toBe(4.95);
    expect(m.dry_run_cap_usd).toBe(55.05);
    expect(m.dry_run_cap_usd + m.stage1_reread_cap_usd).toBe(m.stage1_cap_usd);
    expect(m.smoke_cells.reduce((s, c) => s + c.lease!.usd * c.shards, 0)).toBeLessThanOrEqual(m.dry_run_cap_usd);
    const out = mkdtempSync(join(tmpdir(), 'rs1-stage1-reread-'));
    const run = (cap: string) => Bun.spawnSync(['bun', 'eval/runner/q1/reread-cell.ts', '--cell', 'rs1-dev2.gbrain-defaults.rs1-stable', '--arm', 'p', '--source', join(out, 'missing'), '--reader', PARTICLE,
      '--out', join(out, `o${cap}`), '--budget-ledger', join(out, 'ledger'), '--run-id', `r${cap}`, '--lease-usd', '1', '--ledger-cap-usd', cap, '--manifest', 'rs1', '--keyless-upstream', 'http://127.0.0.1:9'], { cwd: ROOT }).stderr.toString();
    try {
      expect(run('5')).toContain('above the $4.95 stage 1 keeps for its re-reads');
      expect(run('4.95')).not.toContain('stage 1 keeps for its re-reads');
    } finally { rmSync(out, { recursive: true, force: true }); }
  }, 60_000);
});

describe('judges', () => {
  test('the frontier judge is picked by the reader family; other families are refused', () => {
    expect(frontierJudgeOf(OPUS)).toBe('openai:gpt-6.1-sol');
    expect(frontierJudgeOf(PARTICLE)).toBe('openai:gpt-6.1-sol');
    expect(frontierJudgeOf(SOL)).toBe('anthropic:claude-opus-5-5');
    expect(() => frontierJudgeOf('gemini:gemini-3.8-flash')).toThrow(/no per-reader frontier judge/);
  });

  test('completeness needs the canonical judge and, at replicate 0 on a per-reader arm, the frontier judge', () => {
    const arm = m.cells[1].arms[0];
    expect(requiredJudges(arm, { reader: SOL, replicate: 0 }, INSTRUMENT)).toEqual([
      { judge: 'openai:gpt-4.1-mini', instrument_id: 'beam-rubric', view: 'descriptive' }, { judge: 'anthropic:claude-opus-5-5', instrument_id: 'beam-rubric@anthropic:claude-opus-5-5', view: 'gating' }]);
    expect(requiredJudges(arm, { reader: SOL, replicate: 1 }, INSTRUMENT)).toHaveLength(1);
    expect(requiredJudges(m.cells[3].arms[0], { reader: OPUS, replicate: 0 }, INSTRUMENT)).toHaveLength(1);
  });

  test('a per-reader plan that breaks the family rule is refused', () => {
    const c = structuredClone(m.cells[1]) as CellDefinition;
    c.arms[0].readers = [OPUS, 'gemini:gemini-3.8-flash'];
    expect(definitionProblems(c, KINDS).join(' ')).toContain('no per-reader frontier judge');
  });
});

describe('the F6 build predicate (F1)', () => {
  test('runsF6 keys on GBRAIN_F6=1, not on a configuration name', () => {
    const g = gbrain();
    expect(runsF6(g)).toBe(true);
    expect(g.estimate.lines.extraction).toBeGreaterThan(0);
    expect(runsF6({ launch: { ...g.launch!, env: { ...g.launch!.env, GBRAIN_F6: '0' } } })).toBe(false);
    expect(runsF6({ launch: undefined })).toBe(false);
  });

  test('definitionProblems refuses an F6-mode gbrain cell with no extract cap or a zero ingest rate', () => {
    const noCap = gbrain();
    delete noCap.launch!.env.GBRAIN_F6_EXTRACT_CAP_USD;
    expect(definitionProblems(noCap, KINDS).join(' ')).toContain('GBRAIN_F6_EXTRACT_CAP_USD');
    const noRate = gbrain();
    noRate.configuration = 'unpriced';
    expect(ingestRate(noRate)).toBe(0);
    expect(definitionProblems(noRate, KINDS).join(' ')).toContain('positive ingest rate');
  });
});

describe('launch units (kept list)', () => {
  const files = (ids: string[]) => ids.flatMap(id => [`conversations/c${id.slice(4)}/beam/1/chat.json`, `conversations/c${id.slice(4)}/beam/1/probing_questions/probing_questions.json`]).map(path => ({ path, sha256: 'a'.repeat(64) }));
  const kept = Array.from({ length: 10 }, (_, i) => `rs1-${String(i + 2).padStart(3, '0')}`);
  const manifest: Rs1Manifest = { dataset: 'beam-rs1', status: 'filled', layout: 'x', note: 'x', files: files(kept), filled_at: '2026-11-20T00:00:00Z', kept };
  const def = m.cells[0];

  test('a unit runs its five kept conversations in kept order', () => {
    expect(keptUnit(def, { index: 1, count: 7 }, manifest)).toEqual(kept.slice(5, 10));
  });

  test('refuses a shard count other than the cell units, a unit past the kept list and an unfilled manifest', () => {
    expect(() => keptUnit(def, { index: 0, count: 3 }, manifest)).toThrow(/--shard must be i\/7/);
    expect(() => keptUnit(def, { index: 2, count: 7 }, manifest)).toThrow(/launch unit 2/);
    expect(() => keptUnit(def, { index: 0, count: 7 }, { ...manifest, status: 'unfilled' })).toThrow(/unfilled/);
    expect(() => keptUnit(def, { index: 0, count: 7 }, { ...manifest, kept: ['rs1-049', ...kept] })).toThrow(/48 mint slots/);
  });
});
