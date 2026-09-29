import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { REGISTRY, registryEntry, tiersFor } from '../../eval/registry.ts';
import { CATEGORIES, parseTier, selectCategories } from '../../eval/runner/all.ts';

const MATURITY = ['regression-only', 'synthetic-production-path', 'independently-labeled-held-out', 'externally-replicated'];

describe('category registry', () => {
  test('ids and legacy aliases are unique', () => {
    expect(new Set(REGISTRY.map(e => e.id)).size).toBe(REGISTRY.length);
    expect(new Set(REGISTRY.map(e => e.legacy_alias)).size).toBe(REGISTRY.length);
    for (const e of REGISTRY) expect(e.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  test('every entry carries the full contract', () => {
    for (const e of REGISTRY) {
      expect([e.id, existsSync(e.script)]).toEqual([e.id, true]);
      expect([e.id, e.contract.length > 80]).toEqual([e.id, true]);
      expect([e.id, e.headline.metric.length > 0 && e.headline.denominator.length > 0]).toEqual([e.id, true]);
      expect(MATURITY).toContain(e.evidence_maturity);
      expect(['gate', 'report-only']).toContain(e.gate);
      expect(e.cost_estimate.basis.length).toBeGreaterThan(0);
      expect(e.receipt_path.length).toBeGreaterThan(0);
    }
  });

  test('tiers agree with cost: H is free, K is measured under $1, a runnable entry has a tier', () => {
    for (const e of REGISTRY) {
      if (e.tier === 'H') expect([e.id, e.cost_estimate.usd]).toEqual([e.id, 0]);
      if (e.tier === 'K') expect([e.id, e.cost_estimate.usd !== null && e.cost_estimate.usd < 1]).toEqual([e.id, true]);
      if (e.run.kind === 'dispatched') expect([e.id, e.tier]).not.toEqual([e.id, 'none']);
    }
  });

  test('only hermetic dispatched entries gate CI; paid entries report', () => {
    for (const e of REGISTRY) {
      if (e.run.kind === 'dispatched' && e.tier !== 'H') expect([e.id, e.gate]).toEqual([e.id, 'report-only']);
    }
  });

  test('all.ts reads the registry one-to-one, keeping legacy aliases as display ids', () => {
    expect(CATEGORIES.map(c => c.id)).toEqual(REGISTRY.map(e => e.legacy_alias));
    expect(CATEGORIES.map(c => c.registryId)).toEqual(REGISTRY.map(e => e.id));
    expect(registryEntry('13b')?.id).toBe('source-swamp');
    expect(registryEntry('link-type-accuracy')?.legacy_alias).toBe('2');
  });

  test('registry tiers select categories; offline and paid stay aliases for H and K+P', () => {
    expect(parseTier(['--tier', 'H'])).toBe('H');
    expect(parseTier(['--tier', 'P'])).toBe('P');
    expect([...tiersFor('paid')].sort()).toEqual(['K', 'P']);
    expect(selectCategories('H').dispatch.map(c => c.id)).toEqual(selectCategories('offline').dispatch.map(c => c.id));
    const paid = selectCategories('paid').dispatch.map(c => c.id);
    expect([...selectCategories('K').dispatch, ...selectCategories('P').dispatch].map(c => c.id).sort()).toEqual([...paid].sort());
    expect(selectCategories('P').dispatch.map(c => c.id)).toContain('35');
  });
});
