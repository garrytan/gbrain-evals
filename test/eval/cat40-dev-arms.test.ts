import { describe, expect, test } from 'bun:test';
import { CONTROL_CONFIG, DEV_ROUNDS, capUsd, devArmFlags, priceUsd } from '../../eval/runner/cat40/dev-arms.ts';
import { parseConfigPairs } from '../../eval/runner/cat40/gbrain-arm.ts';

describe('Cat 40 next-wave development arms (PLAN.md, development schedule)', () => {
  test('round totals and caps match the cost table', () => {
    const total = (r: 1 | 2 | 3) => Math.round(DEV_ROUNDS[r].reduce((n, a) => n + priceUsd(a), 0) * 100) / 100;
    expect(total(1)).toBe(1026.85);
    expect(total(2)).toBe(595.29);
    expect(DEV_ROUNDS[1].map(a => [a.id, capUsd(a)])).toEqual([['control', 228.19], ['all-on', 228.19], ['f5', 228.19], ['f1', 124.07], ['f1-no-names-row', 124.07], ['f2', 124.07], ['f4', 124.07]]);
    expect(DEV_ROUNDS[2].map(a => a.id)).toEqual(['control', 'all-on', 'f5']);
    expect(total(3)).toBe(198.43);
    expect(DEV_ROUNDS[3].map(a => [a.id, a.slots, capUsd(a)])).toEqual([['all-on-no-f5', 'f5-off', 228.19]]);
    expect(DEV_ROUNDS[3][0].config).toEqual(DEV_ROUNDS[1].find(a => a.id === 'all-on')!.config);
  });
  test('every arm sets every wave key, and its flags parse back to its config', () => {
    for (const [round, arms] of Object.entries(DEV_ROUNDS)) for (const a of arms) {
      expect(Object.keys(a.config).sort()).toEqual(Object.keys(CONTROL_CONFIG).sort());
      const flags = devArmFlags(Number(round) as 1 | 2 | 3, a);
      expect(Object.fromEntries(parseConfigPairs('--gbrain-config', flags[flags.indexOf('--gbrain-config') + 1]))).toEqual(a.config);
      expect(flags.includes('--gbrain-build-config')).toBe(a.slots === 'f5-on');
      expect(flags.includes('--families')).toBe(a.scope === 'H2-H4');
    }
  });
  test('each per-item arm differs from the control only in its own keys', () => {
    const diff = (id: string) => Object.keys(DEV_ROUNDS[1].find(a => a.id === id)!.config).filter(k => DEV_ROUNDS[1].find(a => a.id === id)!.config[k] !== CONTROL_CONFIG[k]).sort();
    expect(diff('control')).toEqual([]);
    expect(diff('f5')).toEqual([]);
    expect(diff('f1')).toEqual(['entity.names_references', 'entity.record_types']);
    expect(diff('f1-no-names-row')).toEqual(['entity.record_types']);
    expect(diff('f2')).toEqual(['search.long_page_unit']);
    expect(diff('f4')).toEqual(['mcp.instructions_governing_rule']);
    expect(diff('all-on')).toEqual(['entity.names_references', 'entity.record_types', 'entity.row_page_status', 'mcp.instructions_governing_rule', 'search.long_page_unit']);
  });
});
