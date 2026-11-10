/**
 * The nightly loop's budget ledger: one durable SQLite ledger (eval/runner/budget-ledger.ts), carried from night to night,
 * with one ledger run per night and ref. A night's run gets min(night cap, 30-night cap minus what nightly runs hold),
 * so the 30-night cap holds across nights even though each night runs on a fresh machine. An open nightly run holds the
 * larger of its budget and what it committed, whatever its age, because a resume or a bisect step can still spend it; a
 * closed run holds what it committed in the 30 days before. The ledger's own recorded program cap stays the lifetime
 * runaway stop on top.
 *
 *   bun eval/runner/nightly/ledger.ts open --budget-ledger <path> --night <YYYY-MM-DD> --ref <ref> --night-cap-usd <n> --month-cap-usd <n>
 *   bun eval/runner/nightly/ledger.ts close --budget-ledger <path> --budget-run-id <id>
 *   bun eval/runner/nightly/ledger.ts status --budget-ledger <path> [--month-cap-usd <n>]
 *   bun eval/runner/nightly/ledger.ts reconcile --budget-ledger <path> --budget-run-id <id>
 *
 * `open` prints the run id that run.ts takes as --budget-run-id. A night whose cap comes to zero refuses with
 * NIGHTLY_CAP_STOP. Only a run's opener closes it: run.ts closes a run it opened itself once the night ends without a
 * stop, and whoever ran `open` (a matrix night's master and stable, a paid bisect) runs `close` when its work ends.
 * `reconcile` settles a stopped night's open reservations at their reserved amount (the process that made them is gone,
 * so their usage will never arrive; the ledger never undercounts) before a retry joins the run.
 */
import { BudgetRun, closeRun, ledgerStatus, readLedger } from '../budget-ledger.ts';

export const NIGHTLY_RUNNER_PREFIX = 'nightly:';
const DAY_MS = 86_400_000;

export class NightlyCapStop extends Error {
  readonly code = 'NIGHTLY_CAP_STOP';
  constructor(message: string) { super(`NIGHTLY_CAP_STOP: ${message}`); this.name = 'NightlyCapStop'; }
}

/**
 * What nightly ledger runs hold against the 30-night cap at `at`: each open run the larger of its budget and what it
 * committed, whatever its age; each closed run what it committed (settled cost, or the reservation while unsettled) in
 * the 30 days before `at`.
 */
export function spentLast30(ledgerPath: string, at: Date): number {
  const snap = readLedger(ledgerPath);
  const from = at.getTime() - 30 * DAY_MS;
  const committed = (runId: string, windowed: boolean) => snap.entries
    .filter(e => e.run_id === runId && (!windowed || (Date.parse(e.created_at) >= from && Date.parse(e.created_at) <= at.getTime())))
    .reduce((n, e) => n + (e.actual_usd ?? e.reserved_usd), 0);
  return snap.runs.filter(r => r.runner.startsWith(NIGHTLY_RUNNER_PREFIX))
    .reduce((n, r) => n + (r.finished_at === null ? Math.max(r.budget_usd, committed(r.run_id, false)) : committed(r.run_id, true)), 0);
}

export const nightProgramCap = (o: { nightCapUsd: number; monthCapUsd: number; spentUsd: number }) => Math.max(0, Math.min(o.nightCapUsd, o.monthCapUsd - o.spentUsd));

export function openNightRun(o: { ledgerPath: string; night: string; ref: string; nightCapUsd: number; monthCapUsd: number; at?: Date }): { runId: string; budgetUsd: number; spentUsd: number } {
  for (const [name, v] of [['--night-cap-usd', o.nightCapUsd], ['--month-cap-usd', o.monthCapUsd]] as const) {
    if (!Number.isFinite(v) || v <= 0) throw new Error(`${name} must be a positive number of dollars`);
  }
  const spentUsd = spentLast30(o.ledgerPath, o.at ?? new Date());
  const budgetUsd = nightProgramCap({ nightCapUsd: o.nightCapUsd, monthCapUsd: o.monthCapUsd, spentUsd });
  if (budgetUsd < 0.01) throw new NightlyCapStop(`nightly runs hold $${spentUsd.toFixed(2)} of the last 30 nights (open runs at their budget), which leaves nothing of the $${o.monthCapUsd.toFixed(2)} 30-night cap for ${o.night}; no paid suite runs tonight`);
  const run = BudgetRun.open({ runner: `${NIGHTLY_RUNNER_PREFIX}${o.night}:${o.ref}`, budgetUsd, ledgerPath: o.ledgerPath });
  return { runId: run.runId, budgetUsd, spentUsd };
}

/** Settle the run's open reservations at their reserved amount; returns how many and the run's committed total after. */
export function reconcileNightRun(ledgerPath: string, runId: string): { settled: number; committed_usd: number; finished: boolean } {
  const status = ledgerStatus({ ledgerPath, runId });
  if (!status.run) throw new Error(`no budget run ${runId} in ${status.ledger}`);
  const open = readLedger(ledgerPath).entries.filter(e => e.run_id === runId && e.actual_usd === null);
  if (open.length && status.run.finished_at === null) {
    const run = BudgetRun.join({ runId, ledgerPath });
    for (const e of open) run.settle(e.id, null);
  }
  const after = ledgerStatus({ ledgerPath, runId }).run!;
  return { settled: status.run.finished_at === null ? open.length : 0, committed_usd: after.committed_usd, finished: after.finished_at !== null };
}

export function closeNightRun(ledgerPath: string, runId: string): void { closeRun(ledgerPath, runId); }

/** Close the night's run when the night opened it itself and ended without a stop; a run passed in belongs to its opener. */
export function closeOwnedNightRun(budget: { run_id: string; ledger: string; opened_by_night?: boolean } | null | undefined, stopped: boolean): boolean {
  if (!budget?.opened_by_night || stopped) return false;
  closeNightRun(budget.ledger, budget.run_id);
  return true;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const ledgerPath = flag('--budget-ledger');
  try {
    if (!ledgerPath) throw new Error('--budget-ledger <path> is required: the nightly ledger is the durable one carried from night to night');
    if (argv[0] === 'open') {
      const r = openNightRun({ ledgerPath, night: flag('--night') ?? new Date().toISOString().slice(0, 10), ref: flag('--ref') ?? 'master',
        nightCapUsd: Number(flag('--night-cap-usd')), monthCapUsd: Number(flag('--month-cap-usd')) });
      console.error(JSON.stringify({ budget_usd: r.budgetUsd, spent_last_30_usd: r.spentUsd }));
      console.log(r.runId);
    } else if (argv[0] === 'close' && flag('--budget-run-id')) {
      const runId = flag('--budget-run-id')!;
      const run = ledgerStatus({ ledgerPath, runId }).run;
      if (!run?.runner.startsWith(NIGHTLY_RUNNER_PREFIX)) throw new Error(`${runId} is not a nightly run in ${ledgerPath}`);
      closeNightRun(ledgerPath, runId);
      console.log(JSON.stringify({ run_id: runId, committed_usd: ledgerStatus({ ledgerPath, runId }).run!.committed_usd, closed: true }));
    } else if (argv[0] === 'status') {
      const spent = spentLast30(ledgerPath, new Date());
      const month = flag('--month-cap-usd');
      console.log(JSON.stringify({ spent_last_30_usd: spent, ...(month ? { left_of_30_night_cap_usd: Math.max(0, Number(month) - spent) } : {}) }, null, 2));
    } else if (argv[0] === 'reconcile' && flag('--budget-run-id')) {
      console.log(JSON.stringify(reconcileNightRun(ledgerPath, flag('--budget-run-id')!)));
    } else throw new Error('usage: ledger.ts open|close|status|reconcile --budget-ledger <path> ...');
  } catch (error) {
    console.error((error as Error).message);
    process.exit(error instanceof NightlyCapStop ? 3 : 1);
  }
}
