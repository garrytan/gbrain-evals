/**
 * The nightly ledger (eval/runner/nightly/ledger.ts): one ledger run per night, sized min(night cap, 30-night cap minus
 * what nightly runs hold: open runs at their budget, closed runs at what they committed in the 30 days before), so a
 * night refuses once the 30-night cap is spent; only a run's opener closes it; and the reconcile a retry runs first,
 * which settles a stopped night's open reservations.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetRun, initLedger, ledgerStatus } from '../../eval/runner/budget-ledger.ts';
import { closeNightRun, closeOwnedNightRun, NightlyCapStop, nightProgramCap, openNightRun, reconcileNightRun, spentLast30 } from '../../eval/runner/nightly/ledger.ts';

const ledger = () => {
  const path = join(mkdtempSync(join(tmpdir(), 'nightly-ledger-')), 'ledger.sqlite');
  initLedger({ ledgerPath: path, programCapUsd: 100, reason: 'nightly ledger test' });
  return path;
};
const spend = (ledgerPath: string, runId: string, usd: number) => {
  const run = BudgetRun.join({ runId, ledgerPath });
  run.settle(run.reserve(usd, 'fixture call'), { usd });
};
const DAY = 86_400_000;

describe('the nightly ledger', () => {
  test('the night cap is the smaller of the night cap and what is left of the 30-night cap', () => {
    expect(nightProgramCap({ nightCapUsd: 3, monthCapUsd: 5, spentUsd: 0 })).toBe(3);
    expect(nightProgramCap({ nightCapUsd: 3, monthCapUsd: 5, spentUsd: 4 })).toBe(1);
    expect(nightProgramCap({ nightCapUsd: 3, monthCapUsd: 5, spentUsd: 6 })).toBe(0);
  });

  test('a second fixture night gets what is left, a third refuses once the 30-night cap is spent, and 30 days later the cap is whole again', () => {
    const path = ledger();
    const caps = { ledgerPath: path, ref: 'master', nightCapUsd: 3, monthCapUsd: 5 };
    const first = openNightRun({ ...caps, night: '2026-11-08' });
    expect(first).toMatchObject({ budgetUsd: 3, spentUsd: 0 });
    spend(path, first.runId, 3);
    const second = openNightRun({ ...caps, night: '2026-11-09' });
    expect(second.budgetUsd).toBeCloseTo(2, 10);
    spend(path, second.runId, 2);
    expect(spentLast30(path, new Date())).toBeCloseTo(5, 10);
    expect(() => openNightRun({ ...caps, night: '2026-11-10' })).toThrow(NightlyCapStop);
    expect(() => openNightRun({ ...caps, night: '2026-11-10' })).toThrow(/NIGHTLY_CAP_STOP/);
    closeNightRun(path, first.runId);
    closeNightRun(path, second.runId);
    expect(openNightRun({ ...caps, night: '2026-12-10', at: new Date(Date.now() + 31 * DAY) }).budgetUsd).toBe(3);
  });

  test('two runs opened on one night (master and stable) cannot add up past the 30-night cap', () => {
    const path = ledger();
    const caps = { ledgerPath: path, night: '2026-11-09', nightCapUsd: 3, monthCapUsd: 5 };
    const master = openNightRun({ ...caps, ref: 'master' });
    const stable = openNightRun({ ...caps, ref: 'stable' });
    expect(master.budgetUsd).toBe(3);
    expect(stable.budgetUsd).toBeCloseTo(2, 10);
    expect(() => openNightRun({ ...caps, ref: 'a-third-ref' })).toThrow(NightlyCapStop);
  });

  test('an open run counts at its full budget, whatever its age, until it is closed', () => {
    const path = ledger();
    const { runId } = openNightRun({ ledgerPath: path, ref: 'master', night: '2026-11-08', nightCapUsd: 3, monthCapUsd: 5 });
    spend(path, runId, 1);
    expect(spentLast30(path, new Date())).toBeCloseTo(3, 10);
    expect(spentLast30(path, new Date(Date.now() + 31 * DAY))).toBeCloseTo(3, 10);
    closeNightRun(path, runId);
    expect(spentLast30(path, new Date())).toBeCloseTo(1, 10);
    expect(spentLast30(path, new Date(Date.now() + 31 * DAY))).toBe(0);
  });

  const finished = (ledgerPath: string, runId: string) => ledgerStatus({ ledgerPath, runId }).run!.finished_at !== null;

  test('a run passed in with --budget-run-id survives a clean night: its opener closes it', () => {
    const path = ledger();
    const passed = openNightRun({ ledgerPath: path, ref: 'matrix', night: '2026-11-09', nightCapUsd: 1, monthCapUsd: 5 }).runId;
    expect(closeOwnedNightRun({ run_id: passed, ledger: path, opened_by_night: false }, false)).toBe(false);
    expect(closeOwnedNightRun({ run_id: passed, ledger: path }, false)).toBe(false);
    expect(finished(path, passed)).toBe(false);
  });

  test('a run the night opened itself closes once the night ends without a stop, and stays open after a stop', () => {
    const path = ledger();
    const own = openNightRun({ ledgerPath: path, ref: 'master', night: '2026-11-09', nightCapUsd: 1, monthCapUsd: 5 }).runId;
    expect(closeOwnedNightRun({ run_id: own, ledger: path, opened_by_night: true }, true)).toBe(false);
    expect(finished(path, own)).toBe(false);
    expect(closeOwnedNightRun({ run_id: own, ledger: path, opened_by_night: true }, false)).toBe(true);
    expect(finished(path, own)).toBe(true);
  });

  test('other runners in the same ledger do not count against the nightly cap', () => {
    const path = ledger();
    const other = BudgetRun.open({ runner: 'another-eval', budgetUsd: 10, ledgerPath: path });
    other.settle(other.reserve(9, 'fixture call'), { usd: 9 });
    expect(openNightRun({ ledgerPath: path, ref: 'master', night: '2026-11-09', nightCapUsd: 3, monthCapUsd: 5 }).budgetUsd).toBe(3);
  });

  test('reconcile settles a stopped night\'s open reservations at their reserved amount, and a closed run settles nothing', () => {
    const path = ledger();
    const { runId } = openNightRun({ ledgerPath: path, ref: 'master', night: '2026-11-09', nightCapUsd: 3, monthCapUsd: 5 });
    const worker = BudgetRun.join({ runId, ledgerPath: path });
    worker.reserve(0.25, 'in flight when the machine went away');
    worker.reserve(0.5, 'in flight when the machine went away');
    expect(reconcileNightRun(path, runId)).toMatchObject({ settled: 2, finished: false });
    expect(ledgerStatus({ ledgerPath: path, runId }).run!.committed_usd).toBeCloseTo(0.75, 10);
    expect(reconcileNightRun(path, runId).settled).toBe(0);
  });

  test('a cap that is not a positive number is refused', () => {
    expect(() => openNightRun({ ledgerPath: ledger(), ref: 'master', night: '2026-11-09', nightCapUsd: 0, monthCapUsd: 5 })).toThrow('--night-cap-usd must be a positive number');
  });
});
