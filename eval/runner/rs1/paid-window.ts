/**
 * RS1's paid-window guard (GST-1886). Every RS1 entry point that can spend real keys (eval/custody/rs1/mint.sh and
 * rs1_mint.py, eval/custody/rs1/validate.ts, and `eval/runner/q1/cell.ts run --manifest rs1`) needs the granted window
 * on its command line, `--paid-window <unit> --window-cap-usd <n>`, unless it runs keyless or fake. Without them it
 * refuses (exit 2) before any provider client exists, and every cap the run would spend under (the ledger's program
 * cap, the run's budget, a campaign lease) must be known and at most the window cap. The re-read runner and the judge
 * check carry the same rule in their own CLIs.
 *
 *   bun eval/runner/rs1/paid-window.ts check --paid-window <unit> --window-cap-usd <n> --budget-ledger <file> --budget-run-id <id>
 *
 * checks a ledger run against a window for mint.sh, printing one line with no amounts and exiting 2 on a refusal.
 */
import { ledgerStatus } from '../budget-ledger.ts';

export class WindowRefusal extends Error {}

export interface PaidWindow { unit: string; cap_usd: number }
export interface SpendCap { label: string; usd: number | null }

const UNIT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const flag = (argv: readonly string[], name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

/** The granted window from argv, or null when neither flag is given; half a window or a malformed one refuses. */
export function paidWindowArgs(argv: readonly string[]): PaidWindow | null {
  const unit = flag(argv, '--paid-window'), cap = flag(argv, '--window-cap-usd');
  if (unit === undefined && cap === undefined) return null;
  if (!unit || !UNIT.test(unit)) throw new WindowRefusal('--paid-window needs the granted unit name (letters, digits, dot, dash and underscore)');
  if (cap === undefined || !(Number(cap) > 0) || !Number.isFinite(Number(cap))) throw new WindowRefusal('--window-cap-usd needs the granted window cap, a positive number');
  return { unit, cap_usd: Number(cap) };
}

/**
 * Refuses a run that is neither keyless nor inside a granted window, and one whose caps are unknown or above the
 * window cap. Returns the window, or null for a keyless run.
 */
export function requireRs1Window(argv: readonly string[], opts: { what: string; keyless: boolean; caps: () => SpendCap[] }): PaidWindow | null {
  if (opts.keyless) return null;
  const window = paidWindowArgs(argv);
  if (!window) throw new WindowRefusal(`${opts.what} spends real keys, so it needs --paid-window <unit> and --window-cap-usd <n> from the granted paid window`);
  for (const cap of opts.caps()) {
    if (cap.usd === null) throw new WindowRefusal(`${opts.what}: ${cap.label} is unknown, so it cannot be checked against paid window ${window.unit}`);
    if (cap.usd > window.cap_usd + 1e-9) throw new WindowRefusal(`${opts.what}: ${cap.label} is above paid window ${window.unit}'s cap; a run's cap never exceeds its window`);
  }
  return window;
}

/** The caps a ledger run spends under: the ledger's program cap and the run's budget (null when either is missing). */
export function ledgerCaps(ledgerPath: string, runId: string | undefined): SpendCap[] {
  const s = ledgerStatus({ ledgerPath, runId: runId ?? null });
  return [{ label: `the ledger's program cap (${ledgerPath})`, usd: s.state === 'sqlite' ? s.totals.program_cap_usd : null },
    { label: `budget run ${runId ?? '<none>'}`, usd: s.run && s.run.finished_at === null ? s.run.budget_usd : null }];
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  try {
    const ledger = flag(argv, '--budget-ledger'), run = flag(argv, '--budget-run-id');
    if (argv[0] !== 'check' || !ledger || !run) throw new WindowRefusal('usage: check --paid-window <unit> --window-cap-usd <n> --budget-ledger <file> --budget-run-id <id>');
    const w = requireRs1Window(argv, { what: 'this run', keyless: false, caps: () => ledgerCaps(ledger, run) })!;
    console.log(`rs1-window ok unit=${w.unit}`);
    process.exit(0);
  } catch (e) {
    process.stderr.write(`rs1-window refused: ${e instanceof WindowRefusal ? e.message : (e as Error).name}\n`);
    process.exit(2);
  }
}
