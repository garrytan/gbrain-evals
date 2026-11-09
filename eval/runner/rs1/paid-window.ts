/**
 * The command line of RS1's paid-window guard (GST-1886; the guard itself is in eval/runner/paid-arm.ts): checks a
 * ledger run against a granted window for mint.sh, printing one line with no amounts and exiting 2 on a refusal.
 *
 *   bun eval/runner/rs1/paid-window.ts check --paid-window <unit> --window-cap-usd <n> --budget-ledger <file> --budget-run-id <id>
 */
import { ledgerCaps, requireRs1Window, WindowRefusal } from '../paid-arm.ts';

export { ledgerCaps, paidWindowArgs, requireRs1Window, WindowRefusal, type PaidWindow, type SpendCap } from '../paid-arm.ts';

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  try {
    const ledger = flag('--budget-ledger'), run = flag('--budget-run-id');
    if (argv[0] !== 'check' || !ledger || !run) throw new WindowRefusal('usage: check --paid-window <unit> --window-cap-usd <n> --budget-ledger <file> --budget-run-id <id>');
    const w = requireRs1Window(argv, { what: 'this run', keyless: false, caps: () => ledgerCaps(ledger, run) })!;
    console.log(`rs1-window ok unit=${w.unit}`);
    process.exit(0);
  } catch (e) {
    process.stderr.write(`rs1-window refused: ${e instanceof WindowRefusal ? e.message : (e as Error).name}\n`);
    process.exit(2);
  }
}
