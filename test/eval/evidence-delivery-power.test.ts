/**
 * Power-analysis simulation for the evidence-delivery decision rule: small,
 * seeded runs that check the simulator behaves (the committed report uses
 * the full simulation counts).
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadDecisionManifest } from '../../eval/runner/evidence-delivery/decision.ts';
import { CONFIRMATORY_STRATA, PILOT_STRATA, chunkRates, confirmatoryPower, e2Power, selectionPower } from '../../eval/runner/evidence-delivery/power.ts';

const { manifest } = loadDecisionManifest();

describe('power simulation', () => {
  test('strata match the real pilot and confirmatory sizes', () => {
    expect(CONFIRMATORY_STRATA.reduce((s, x) => s + x.n, 0)).toBe(400);
    expect(PILOT_STRATA.reduce((s, x) => s + x.n, 0)).toBe(100);
    expect(CONFIRMATORY_STRATA.map(x => x.type).sort()).toEqual([...manifest.data.strata].sort());
  });

  test('per-stratum chunk rates reproduce the requested overall chunk accuracy', () => {
    const rates = chunkRates(CONFIRMATORY_STRATA, 0.72);
    const overall = CONFIRMATORY_STRATA.reduce((s, x, i) => s + x.n * rates[i], 0) / 400;
    expect(overall).toBeCloseTo(0.72, 6);
    rates.forEach((r, i) => expect(r).toBeLessThanOrEqual(CONFIRMATORY_STRATA[i].page));
  });

  test('a candidate with no closure never succeeds; a full-closure candidate usually does', () => {
    expect(confirmatoryPower(manifest, { chunkAcc: 0.65, closure: 0, sims: 20, seed: 1, draws: 1000 }).success).toBe(0);
    const full = confirmatoryPower(manifest, { chunkAcc: 0.65, closure: 1, sims: 20, seed: 2, draws: 1000 });
    expect(full.gap_established).toBe(1);
    expect(full.success).toBeGreaterThan(0.5);
  });

  test('selection keeps a clearly best candidate most of the time', () => {
    expect(selectionPower(manifest, { chunkAcc: 0.65, closures: [0.1, 0.1, 0.1, 0.1, 0.1, 0.9], sims: 100, seed: 3 }).best_advanced).toBeGreaterThan(0.9);
  });

  test('E2 rejects a large regression and passes a large gain most of the time', () => {
    expect(e2Power(manifest, { chunkAcc: 0.8, trueDelta: -0.1, personaSd: 0.8, noise: 0.01, sims: 60, seed: 4, draws: 1000 }).reject).toBeGreaterThan(0.8);
    expect(e2Power(manifest, { chunkAcc: 0.8, trueDelta: 0.1, personaSd: 0.8, noise: 0.01, sims: 60, seed: 5, draws: 1000 }).pass).toBeGreaterThan(0.8);
  });

  test('the committed power report was computed from the committed decision manifest', () => {
    const path = join(import.meta.dir, '../../docs/benchmarks/2026-09-30-evidence-delivery/power-analysis.json');
    expect(existsSync(path)).toBe(true);
    const report = JSON.parse(readFileSync(path, 'utf8'));
    expect(report.decision_manifest_sha256).toBe(loadDecisionManifest().sha256);
    expect(report.confirmatory).toHaveLength(21);
    expect(report.e2).toHaveLength(20);
  });
});
