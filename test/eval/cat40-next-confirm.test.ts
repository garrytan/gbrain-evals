import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HARD_SEEDS, type HardWorld } from '../../eval/generators/hard/schema.ts';
import { generateHardWorld } from '../../eval/generators/model-ladder-hard.ts';
import { requiresFreeze } from '../../eval/runner/cat40/hard.ts';
import { DEV_ROUNDS, SLOT_BUILD_CONFIG } from '../../eval/runner/cat40/dev-arms.ts';
import { NEXT_BUILDS, NEXT_CAPS_USD, NEXT_LEDGERS, NEXT_WORLDS, WAVE_BUILD_CONFIG, WAVE_CONFIG, checkWorld, driftNote, worldPlan } from '../../eval/runner/cat40/next-confirm.ts';

const flag = (argv: string[], k: string) => argv[argv.indexOf(k) + 1];

describe('Cat 40 next wave confirmation program (PREREG.md)', () => {
  test('the public confirmation seeds require the frozen generator', () => {
    for (const seed of HARD_SEEDS.next_confirmation) expect(requiresFreeze({ seed, version: 'model-ladder-hard-v2' } as HardWorld)).toBe(true);
    expect([...HARD_SEEDS.next_confirmation] as number[]).toEqual([NEXT_WORLDS.p1.seed!, NEXT_WORLDS.p2.seed!]);
    expect(requiresFreeze({ seed: 20261234, version: 'model-ladder-hard-v2' } as HardWorld)).toBe(false);
  });

  test('the wave recipe is development all-on, F5 on at slot build; the baseline gets no wave keys', () => {
    const allOnArm = DEV_ROUNDS[1].find(a => a.id === 'all-on')!;
    const allOn = allOnArm.config;
    expect(Object.fromEntries(WAVE_BUILD_CONFIG.split(',').map(p => p.split('=')))).toEqual(SLOT_BUILD_CONFIG[allOnArm.slots]);
    expect(allOnArm.slots).toBe('f5-on');
    expect(Object.fromEntries(WAVE_CONFIG.replace('record_types=contract,amendment', 'record_types=contract;amendment').split(',').map(p => p.replace(';', ',').split('=')))).toEqual(allOn);
    for (const world of Object.keys(NEXT_WORLDS) as Array<keyof typeof NEXT_WORLDS>) {
      const steps = worldPlan(world, 'abc1234', '2026-10-14');
      expect(steps.map(s => s.id)).toEqual(['ledger', 'check-world', 'freshness', 'slots-wave', 'slots-baseline', 'oracle', 'oracle-gate', 'cells-baseline', 'cells-wave', 'cells-fs']);
      const by = Object.fromEntries(steps.map(s => [s.id, s.argv]));
      expect(flag(by['cells-wave']!, '--gbrain-config')).toBe(WAVE_CONFIG);
      expect(flag(by['cells-wave']!, '--gbrain-ref')).toBe(NEXT_BUILDS.wave);
      expect(by['cells-baseline']!.includes('--gbrain-config')).toBe(false);
      expect(flag(by['cells-baseline']!, '--gbrain-ref')).toBe(NEXT_BUILDS.baseline);
      expect(flag(by['slots-wave']!, '--gbrain-build-config')).toBe(WAVE_BUILD_CONFIG);
      expect(flag(by['cells-wave']!, '--gbrain-build-config')).toBe(WAVE_BUILD_CONFIG);
      for (const id of ['slots-baseline', 'oracle', 'cells-baseline', 'cells-fs']) expect(by[id]!.includes('--gbrain-build-config')).toBe(false);
      expect(flag(by['cells-wave']!, '--budget-usd')).toBe(String(NEXT_CAPS_USD.gbrain));
      expect(flag(by['cells-fs']!, '--budget-usd')).toBe(String(NEXT_CAPS_USD.fs));
      expect(flag(by['oracle']!, '--budget-usd')).toBe(String(NEXT_CAPS_USD.oracle));
      expect(flag(by['cells-fs']!, '--budget-ledger')).toBe(NEXT_LEDGERS[NEXT_WORLDS[world].machine]);
      expect(flag(by['cells-wave']!, '--accept-freeze-drift')).toBe(driftNote('abc1234', '2026-10-14'));
      expect(flag(by['cells-wave']!, '--models')).toBe('claude-opus-5-5,claude-sonnet-5-5,gpt-6.1-sol');
    }
  });

  test('check-world refuses a world that is not the recorded one', () => {
    const w = generateHardWorld(HARD_SEEDS.smoke);
    expect(() => checkWorld('p1', w, 'smoke')).toThrow('is not the recorded');
    expect(() => checkWorld('s1', w, 'smoke')).toThrow('no recorded digest');
  }, 120_000);

  test('the analysis reproduces #93 M and keeps every draw inside its seed', () => {
    const m93 = 'docs/benchmarks/2026-10-10-model-ladder-hard-confirmation/main-cells/results.jsonl';
    const out = execFileSync('python3', ['eval/runner/cat40/next_confirm_analysis.py', '--world', `P1=${m93}`, '--wave', 'gbrain-hard', '--resamples', '2000'], { encoding: 'utf8' });
    expect(out).toContain('wave - fs +7.67 pp');
    const dir = mkdtempSync(join(tmpdir(), 'next-confirm-'));
    const cell = (arm: string, model: string, task: string, success: boolean) => JSON.stringify({ arm, model, task, family: 'H2', variant: 'x', stop: 'submitted', score: { success, submitted: true, said_wrong: false } });
    const rows = (wave: boolean) => ['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-6.1-sol'].flatMap(m => Array.from({ length: 10 }, (_, i) => [cell('gbrain-next-wave', m, `H2-${i}`, wave), cell('fs', m, `H2-${i}`, false)]).flat());
    writeFileSync(join(dir, 'a.jsonl'), rows(true).join('\n'));
    writeFileSync(join(dir, 'b.jsonl'), rows(false).join('\n'));
    execFileSync('python3', ['eval/runner/cat40/next_confirm_analysis.py', '--world', `P1=${join(dir, 'a.jsonl')}`, '--world', `P2=${join(dir, 'b.jsonl')}`, '--resamples', '500', '--json', join(dir, 'out.json')]);
    const res = JSON.parse(require('node:fs').readFileSync(join(dir, 'out.json'), 'utf8'));
    expect(res.primary.public.delta_pp).toBe(50);
    expect(res.primary.public.ci95).toEqual([50, 50]);
  }, 120_000);
});
