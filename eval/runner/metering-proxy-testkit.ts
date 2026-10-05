/**
 * Test kit for the metering proxy: a throwaway metered cell (ledger, budget
 * run, stub upstream, proxy) and the zero-balance check every process in a
 * harness cell must pass.
 *
 * assertZeroBalanceBlocks runs a child process twice:
 *
 *   zero balance   the run's budget is fully committed. The child is spawned
 *                  with `proxy.envFor(label)`, `trigger` makes it attempt a
 *                  paid request, and the check requires that the proxy
 *                  refused at least one request from that label, that the
 *                  stub upstream received nothing and that the ledger shows
 *                  no new committed spend.
 *   positive       a fresh cell with budget. The same trigger must reach the
 *                  stub and settle in the ledger.
 *
 * It throws on any violation, so it works under any test runner. The
 * comparator server launcher uses it the same way the gbrain MCP child test
 * does:
 *
 *   await assertZeroBalanceBlocks({
 *     label: 'comparator',
 *     spawn: async (env, cell) => startComparatorServer({ env: { ...cleanEnv, ...env } }),
 *     trigger: async (server) => server.ingestOneDocument(),
 *     stop: async (server) => server.close(),
 *   });
 *
 * No real key is ever used: the proxy gets no real keys and every provider
 * points at the stub.
 */
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetRun, closeLedgers, initLedger, ledgerStatus } from './budget-ledger.ts';
import { startMeteringProxy, type MeteringProxy, type RequestLogLine } from './metering-proxy.ts';
import { startStubUpstream, type StubUpstream } from './stub-upstream.ts';

export interface MeteredTestCell {
  dir: string;
  ledgerPath: string;
  run: BudgetRun;
  stub: StubUpstream;
  proxy: MeteringProxy;
  requestLogPath: string;
  bodiesDir: string;
  /** Lines of the proxy's request log so far. */
  log(): RequestLogLine[];
  /** Committed spend of the cell's budget run, and of the whole ledger. */
  committed(): { run: number; program: number };
  close(): Promise<void>;
}

/**
 * A metered cell in a fresh temp directory. `drained` commits the whole run
 * budget first (a settled entry, as if earlier requests had spent it), which
 * is what a zero balance looks like to the proxy.
 */
export async function createMeteredTestCell(options: {
  labels: string[];
  budgetUsd?: number;
  drained?: boolean;
  programCapUsd?: number;
  cellId?: string;
  dirPrefix?: string;
} ): Promise<MeteredTestCell> {
  const dir = mkdtempSync(join(tmpdir(), options.dirPrefix ?? 'metered-cell-'));
  const ledgerPath = join(dir, 'ledger.sqlite');
  initLedger({ ledgerPath, programCapUsd: options.programCapUsd ?? 500, reason: 'metering proxy test' });
  const budgetUsd = options.budgetUsd ?? 1;
  const run = BudgetRun.open({ runner: 'metering-proxy-test', budgetUsd, ledgerPath });
  if (options.drained) run.settle(run.reserve(budgetUsd, 'earlier spend (test fixture)'), { usd: budgetUsd, input_tokens: 0, output_tokens: 0 });
  const stub = await startStubUpstream();
  const requestLogPath = join(dir, 'proxy-requests.jsonl');
  const bodiesDir = join(dir, 'proxy-bodies');
  const proxy = await startMeteringProxy({
    run, cellId: options.cellId ?? 'test-cell', requestLogPath, bodiesDir, labels: options.labels, upstreams: stub.upstreams, realKeys: {},
  });
  return {
    dir, ledgerPath, run, stub, proxy, requestLogPath, bodiesDir,
    log: () => (existsSync(requestLogPath) ? readFileSync(requestLogPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as RequestLogLine) : []),
    committed: () => {
      const status = ledgerStatus({ ledgerPath, runId: run.runId });
      return { run: status.run?.committed_usd ?? NaN, program: status.totals.committed_usd };
    },
    async close() {
      await proxy.close();
      stub.close();
      closeLedgers();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Poll `check` every 100 ms until it returns true or `timeoutMs` passes. */
export async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return true;
    if (Date.now() > deadline) return false;
    await Bun.sleep(100);
  }
}

export interface ZeroBalanceCheck<C> {
  /** The proxy label the child runs under (its token and env). */
  label: string;
  /** Start the child with the proxy env for `label` merged into its own clean env. */
  spawn: (env: Record<string, string>, cell: MeteredTestCell) => Promise<C>;
  /** Make the child attempt at least one paid request. May reject (a refused child often errors). */
  trigger: (child: C, cell: MeteredTestCell) => Promise<unknown>;
  stop?: (child: C, cell: MeteredTestCell) => Promise<void>;
  /** How long to wait for the attempt to appear in the proxy log (default 30 s). */
  timeoutMs?: number;
  /** Other labels the cell should issue tokens for. */
  extraLabels?: string[];
}

export interface ZeroBalancePhase {
  stubHits: number;
  refused: number;
  settled: number;
  committedBefore: { run: number; program: number };
  committedAfter: { run: number; program: number };
  triggerError: string | null;
  log: RequestLogLine[];
}

async function phase<C>(check: ZeroBalanceCheck<C>, drained: boolean): Promise<ZeroBalancePhase> {
  const cell = await createMeteredTestCell({ labels: [check.label, ...(check.extraLabels ?? [])], drained, dirPrefix: `zero-balance-${check.label}-` });
  let child: C | undefined;
  try {
    const committedBefore = cell.committed();
    child = await check.spawn(cell.proxy.envFor(check.label), cell);
    let triggerError: string | null = null;
    try { await check.trigger(child, cell); } catch (error) { triggerError = (error as Error).message ?? String(error); }
    const mine = () => cell.log().filter(l => l.label === check.label);
    const done = drained ? () => mine().some(l => l.refused) : () => mine().some(l => l.settlement === 'reconciled' || l.settlement === 'charged-reservation');
    await waitFor(done, check.timeoutMs ?? 30_000);
    const log = mine();
    return {
      stubHits: cell.stub.hits.total, refused: log.filter(l => l.refused).length,
      settled: log.filter(l => l.settlement === 'reconciled' || l.settlement === 'charged-reservation').length,
      committedBefore, committedAfter: cell.committed(), triggerError, log,
    };
  } finally {
    if (child !== undefined) await check.stop?.(child, cell);
    await cell.close();
  }
}

/** See the module comment. Returns both phases for further assertions; throws on a violation. */
export async function assertZeroBalanceBlocks<C>(check: ZeroBalanceCheck<C>): Promise<{ zero: ZeroBalancePhase; positive: ZeroBalancePhase }> {
  const zero = await phase(check, true);
  const problems: string[] = [];
  if (zero.refused === 0) problems.push(`at zero balance the proxy saw no refused request from ${check.label} (did the trigger attempt a paid request? trigger error: ${zero.triggerError ?? 'none'})`);
  if (zero.stubHits !== 0) problems.push(`at zero balance the stub upstream received ${zero.stubHits} request(s)`);
  if (Math.abs(zero.committedAfter.run - zero.committedBefore.run) > 1e-12 || Math.abs(zero.committedAfter.program - zero.committedBefore.program) > 1e-12) {
    problems.push(`at zero balance committed spend moved from ${JSON.stringify(zero.committedBefore)} to ${JSON.stringify(zero.committedAfter)}`);
  }
  const positive = await phase(check, false);
  if (positive.stubHits === 0) problems.push(`with budget the stub upstream received nothing from ${check.label} (trigger error: ${positive.triggerError ?? 'none'})`);
  if (positive.settled === 0) problems.push(`with budget no request from ${check.label} settled in the ledger`);
  if (!(positive.committedAfter.run > positive.committedBefore.run)) problems.push(`with budget committed spend did not grow (${JSON.stringify(positive.committedBefore)} -> ${JSON.stringify(positive.committedAfter)})`);
  if (problems.length) throw new Error(`zero-balance check failed for ${check.label}:\n- ${problems.join('\n- ')}`);
  return { zero, positive };
}
