/**
 * Cat 40 Hard confirmation (docs/plans/2026-10-07-cat40-hard-fix/PREREG.md): the confirmation seed and program
 * steps, the per-world ledgers, the oracle gate (gate 2) and the frozen-world rule. Hermetic: no paid call.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HARD_SEEDS, type HardWorld } from '../../eval/generators/hard/schema.ts';
import { hardRefusals, requiresFreeze } from '../../eval/runner/cat40/hard.ts';
import { CONFIRM_CAP_USD, CONFIRM_LEDGERS, CONFIRM_STEPS, HARD_MODELS, STEPS, checkConfirmLedger, confirmOracleGate, isConfirmStep, project, loadCostBasis, stepPlan } from '../../eval/runner/cat40/hard-ops.ts';
import { closeLedgers, initLedger } from '../../eval/runner/budget-ledger.ts';

const ROOT = resolve(import.meta.dir, '../..');
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'cat40-confirm-')); dirs.push(d); return d; };
afterAll(() => { closeLedgers(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const sh = (args: string[], env: Record<string, string> = {}) => {
  const r = spawnSync('bash', ['scripts/cat40-hard.sh', ...args], { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
};

describe('confirmation seed and program steps', () => {
  test('seed 20261021 is registered; the four confirmation steps follow the held-out steps with the preregistered models, arms and tasks', () => {
    expect(HARD_SEEDS.confirmation).toBe(20261021);
    expect(new Set(Object.values(HARD_SEEDS)).size).toBe(Object.keys(HARD_SEEDS).length);
    expect(CONFIRM_STEPS.map(s => s.step)).toEqual(['confirm-world', 'confirm-slots', 'confirm-oracle', 'confirm-cells']);
    expect(CONFIRM_STEPS.every(s => isConfirmStep(s.step))).toBe(true);
    expect(Math.min(...CONFIRM_STEPS.map(s => s.order))).toBeGreaterThan(Math.max(...STEPS.map(s => s.order)));
    expect(stepPlan('confirm-slots').slotBuilds).toBe(5);
    expect(stepPlan('confirm-oracle')).toMatchObject({ models: HARD_MODELS, arms: ['oracle'], tasksPerFamily: 20, repeats: 1, scale: 'large' });
    expect(stepPlan('confirm-cells')).toMatchObject({ models: HARD_MODELS, arms: ['gbrain', 'fs'], tasksPerFamily: 20, repeats: 1, scale: 'large' });
    expect(HARD_MODELS.slice().sort()).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-6.1-sol']);
    expect(project(stepPlan('confirm-cells'), { basis: loadCostBasis() }).cells).toBe(600);
    expect(isConfirmStep('cells-50k')).toBe(false);
    expect(isConfirmStep('confirm-nope')).toBe(false);
  });
  test('gbrain-fs stays refused in every confirmation step', () => {
    for (const step of ['confirm-oracle', 'confirm-cells']) {
      expect(() => hardRefusals({ models: ['claude-opus-5-5'], judge: 'gpt-6.1-sol', arms: ['gbrain', 'fs', 'gbrain-fs'], scripted: false, seed: HARD_SEEDS.confirmation, step })).toThrow('HARD_ARM_EXPLORATORY');
      expect(() => hardRefusals({ models: ['claude-opus-5-5'], judge: 'gpt-6.1-sol', arms: ['gbrain', 'fs'], scripted: false, seed: HARD_SEEDS.confirmation, step })).not.toThrow();
    }
  });
  test('the confirmation world and every sealed world must use the frozen generator', () => {
    const w = (seed: number, version: string) => ({ seed, version }) as unknown as HardWorld;
    expect(requiresFreeze(w(HARD_SEEDS.confirmation, 'model-ladder-hard-v2'))).toBe(true);
    expect(requiresFreeze(w(424242, 'hard-sealed-v2'))).toBe(true);
    expect(requiresFreeze(w(HARD_SEEDS.calibration, 'model-ladder-hard-v2'))).toBe(false);
  });
  test('the operator script prints every confirmation step for both worlds and refuses without CONFIRM_WORLD', () => {
    for (const world of ['main', 'sealed']) for (const step of ['confirm-world', 'confirm-slots', 'confirm-oracle', 'confirm-cells']) {
      const r = sh(['step', step], { PRINT_ONLY: '1', GBRAIN_REF: 'abc', CONFIRM_WORLD: world });
      expect(r.code).toBe(0);
      if (step !== 'confirm-world') expect(r.out).toContain(`--budget-ledger ${CONFIRM_LEDGERS[world as 'main' | 'sealed']}`);
      if (step === 'confirm-oracle' || step === 'confirm-cells') expect(r.out).toContain(`--step ${step}`);
      if (step === 'confirm-cells') expect(r.out).toMatch(/--arms gbrain,fs .*--slots 5 --concurrency 10 --repeat 1 --judge gpt-6\.1-sol .*--transcripts/);
    }
    expect(sh(['step', 'confirm-world'], { PRINT_ONLY: '1', CONFIRM_WORLD: 'main' }).out).toContain('--seed 20261021 --knobs docs/benchmarks/cat40-hard/knobs.frozen.json --scale large');
    expect(sh(['step', 'confirm-oracle'], { PRINT_ONLY: '1' })).toMatchObject({ code: 3, out: expect.stringContaining('CONFIRM_WORLD must be main or sealed') });
  });
});

describe('confirmation ledgers', () => {
  test('each world spends only from its own ledger with the confirmation cap ($900 since Garry raised it on 2026-10-10)', () => {
    const d = tmp();
    expect(() => checkConfirmLedger(CONFIRM_LEDGERS.main, d)).toThrow('does not exist on this machine');
    expect(() => checkConfirmLedger('.budget/cat40-hard.sqlite', d)).toThrow('HARD_LEDGER_ROSTER');
    expect(() => checkConfirmLedger(undefined, d)).toThrow('no --budget-ledger');
    initLedger({ ledgerPath: join(d, CONFIRM_LEDGERS.main), programCapUsd: CONFIRM_CAP_USD, reason: 'test' });
    expect(CONFIRM_CAP_USD).toBe(900);
    expect(checkConfirmLedger(CONFIRM_LEDGERS.main, d)).toMatchObject({ capUsd: 900, committedUsd: 0, remainingUsd: 900 });
    initLedger({ ledgerPath: join(d, CONFIRM_LEDGERS.sealed), programCapUsd: 650, reason: 'test' });
    expect(() => checkConfirmLedger(CONFIRM_LEDGERS.sealed, d)).toThrow('records a cap of $650.00');
  });
});

describe('oracle gate (gate 2)', () => {
  const rec = (model: string, task: string, success: boolean, stop = 'submitted', attempt = 1) => ({
    schema: 'cat40-cell-v2', key: `${model}|oracle|${task}|0`, attempt_id: `${model}|${task}|${attempt}`, attempt, model, arm: 'oracle', task, family: task.slice(0, 2), repeat: 0,
    stop, score: { success }, total_usd: 0.01, judge_usd: 0, wall_ms: 1, sessions: [], experiment: { scale: 'large' },
  });
  const tasks = Array.from({ length: 100 }, (_, i) => `H${(i % 5) + 1}-${String(Math.floor(i / 5) + 1).padStart(2, '0')}`);
  const records = (failures: number) => HARD_MODELS.flatMap(m => tasks.map((t, i) => rec(m, t, !(m === HARD_MODELS[0] && i < failures))));
  test('passes at 95% pooled over all 300 cells and fails below it', () => {
    expect(confirmOracleGate(records(15))).toMatchObject({ cells: 300, successes: 285, pass: true });
    expect(confirmOracleGate(records(16))).toMatchObject({ cells: 300, successes: 284, pass: false });
    expect(confirmOracleGate(records(0)).by_model[HARD_MODELS[1]]).toEqual({ cells: 100, successes: 100 });
  });
  test('a missing cell or a cell with only harness-error attempts fails the gate; a clean retry counts', () => {
    expect(confirmOracleGate(records(0).slice(1)).pass).toBe(false);
    const errored = records(0);
    errored[0] = rec(HARD_MODELS[0], tasks[0], false, 'harness_error');
    expect(confirmOracleGate(errored)).toMatchObject({ incomplete: 1, pass: false });
    expect(confirmOracleGate([...errored, rec(HARD_MODELS[0], tasks[0], true, 'submitted', 2)])).toMatchObject({ cells: 300, successes: 300, pass: true });
  });
});
