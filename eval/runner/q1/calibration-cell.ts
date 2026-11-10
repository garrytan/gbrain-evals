/**
 * A reader tokenizer calibration cell (plan GST-605 Phase 2, item 1): one LoCoMo dev smoke cell's packed arm, read by
 * one reader, through Q1's lease proxy run in this process; then `calibrate.ts` over its packs. Dev data only: it
 * never runs a counted cell and writes no scoreboard number.
 *
 *   bun eval/runner/q1/calibration-cell.ts --reader particle:particle-1 --out <dir> --budget-ledger <file> --run-id <id> --lease-usd <n>
 *     [--cell s3-smoke.baseline-hybrid.baseline]
 *     (--keyless-upstream http://127.0.0.1:<fake_provider.py port> | --paid-window <unit> --window-cap-usd <n> --ledger-cap-usd <n>)
 *
 * A run without --keyless-upstream spends real keys, so it needs the granted paid window's unit and cap and a
 * --ledger-cap-usd within that cap (eval/runner/paid-arm.ts, the shared window guard); otherwise it exits 2 before any
 * lease or output. Its lease opens under that ceiling (reread-cell.ts openRereadLease): every lease on the ledger
 * shares it, so the leases of one window never pass the window cap.
 *
 * The proxy holds the provider keys from this environment and Q1's route caps and classes, and spends the lease; the
 * cell sees this run's cell token as its keys, and the proxy answers only that token and this run's control token. `--keyless-upstream` sends every provider to eval/systems/_shim/fake_provider.py instead
 * (Particle under its `/particle` prefix) with placeholder keys, for the $0 run before a paid one; the flag without
 * an http(s) URL is a usage error, never a paid run. The chat and
 * embedding caches live in --out, and `upstream.json` there records which kind of run it holds, so a paid run refuses
 * a keyless run's --out (it would resume from the fake answers) and the reverse. Frontier judges are
 * off; the canonical judge runs, as in any cell. `calibration.json` in --out holds the reader's factor and largest
 * per-pack error under its table encoding and under the other tiktoken encoding, and the lease's dollars.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BudgetRun } from '../budget-ledger.ts';
import { DEFAULT_ROUTE_CAPS, keylessKeys, keylessUpstream, MeteringProxy, usageSplit } from '../metering-proxy.ts';
import { requireRs1Window } from '../paid-arm.ts';
import { DEFAULT_ROUTE_CLASSES } from '../shootout-cell.ts';
import { measureCalibration, readerTokenizer } from '../systems/render-v2.ts';
import { calibrate, calibrationSamples } from './calibrate.ts';
import { findCell, runCell } from './cell.ts';
import type { CellDefinition } from './cells/definitions.ts';
import { openRereadLease } from './reread-cell.ts';
import { refuse } from './scoreboard-errors.ts';

/** The cell's packed arm read by `reader` alone, without frontier judges; a cell outside the dev split, or with no packed arm, is refused. */
export function calibrationCell(def: CellDefinition, reader: string): CellDefinition {
  if (def.split !== 'dev') throw new Error(`${def.id} reads split ${def.split}; a calibration cell reads dev data only`);
  const arm = def.arms.find(a => a.mode === 'packed');
  if (!arm) throw new Error(`${def.id} has no packed arm to calibrate on`);
  return { ...def, arms: [{ ...arm, readers: [reader], reader_replicates: {}, frontier: null }] };
}

/** Records in `out` whether it holds a keyless or a paid run, and refuses an `out` that holds the other kind. */
export function claimOut(out: string, keyless: boolean, kind = 'calibration'): void {
  const marker = join(out, 'upstream.json');
  if (existsSync(marker) && JSON.parse(readFileSync(marker, 'utf8')).keyless !== keyless) {
    throw refuse({ code: 'USAGE', message: `${out} holds a ${keyless ? 'paid' : 'keyless'} ${kind} run; give this run a fresh --out`,
      why: 'a keyless rehearsal and a paid run never share an --out, so a paid run\'s records are never mixed with a rehearsal\'s', fix: { next: 'run', argv: ['--out', '<a fresh directory>'] } });
  }
  writeFileSync(marker, JSON.stringify({ keyless }) + '\n');
}

/**
 * `--keyless-upstream <url>`: the fake upstream's http(s) URL without its trailing slash, or null without the flag. The
 * flag without a URL, or spelled `--keyless-upstream=<url>`, throws a usage error: read as written, the run would spend real keys.
 */
export function keylessUpstreamArg(argv: string[]): string | null {
  const joined = argv.find(a => a.startsWith('--keyless-upstream='));
  if (joined) throw new Error(`--keyless-upstream takes the fake upstream's URL as its own argument (--keyless-upstream <url>), got ${JSON.stringify(joined)}; read as written, the run would spend real keys`);
  if (!argv.includes('--keyless-upstream')) return null;
  const url = argv[argv.indexOf('--keyless-upstream') + 1] ?? '';
  if (!/^https?:\/\/\S+$/.test(url)) throw new Error(`--keyless-upstream needs the fake upstream's http(s) URL, got ${JSON.stringify(url)}; without one the run would spend real keys`);
  return url.replace(/\/$/, '');
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const one = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const [reader, outArg, ledger, runId, leaseUsd] = [one('--reader'), one('--out'), one('--budget-ledger'), one('--run-id'), Number(one('--lease-usd'))];
  if (!reader || !outArg || !ledger || !runId || !(leaseUsd > 0)) {
    console.error('usage: bun eval/runner/q1/calibration-cell.ts --reader <provider:model> --out <dir> --budget-ledger <file> --run-id <id> --lease-usd <n> [--cell <dev smoke cell>] (--keyless-upstream <url> | --paid-window <unit> --window-cap-usd <n> --ledger-cap-usd <n>)');
    process.exit(2);
  }
  let keyless: string | null;
  const ledgerCap = Number(one('--ledger-cap-usd'));
  try {
    keyless = keylessUpstreamArg(argv);
    requireRs1Window(argv, { what: 'a calibration cell without --keyless-upstream', keyless: !!keyless, caps: () => [{ label: '--ledger-cap-usd', usd: ledgerCap > 0 ? ledgerCap : null }, { label: '--lease-usd', usd: leaseUsd }] });
  } catch (e) { console.error((e as Error).message); process.exit(2); }
  const out = resolve(outArg);
  mkdirSync(out, { recursive: true });
  try { claimOut(out, !!keyless); }
  catch (e) { console.error((e as Error).message); process.exit(2); }
  const def = calibrationCell(findCell(one('--cell') ?? 's3-smoke.baseline-hybrid.baseline'), reader);
  const keys = keyless ? keylessKeys() : { ...process.env };
  const [cellToken, controlToken] = [randomUUID(), randomUUID()];
  Object.assign(process.env, { GBRAIN_EVALS_QA_CACHE: join(out, 'qa-cache'), GBRAIN_EVALS_EMBED_CACHE: join(out, 'embed-cache'), SHOOTOUT_CELL_TOKEN: cellToken, SHOOTOUT_PROXY_CONTROL_TOKEN: controlToken });
  const lease = keyless ? BudgetRun.openLease({ runId, leaseUsd, ledgerPath: resolve(ledger), runner: 'q1-calibration-cell' })
    : openRereadLease({ runId, leaseUsd, ledgerPath: resolve(ledger), capUsd: ledgerCap, runner: 'q1-calibration-cell' });
  const usageLog = join(out, 'usage.ndjson');
  const proxy = new MeteringProxy({ ...(keyless ? { upstream: keylessUpstream(keyless) } : {}), cellToken, controlToken,
    policy: { lease, usageLog, env: keys, routeCaps: { caps: { ...DEFAULT_ROUTE_CAPS }, slots: { ...DEFAULT_ROUTE_CLASSES }, defaultClass: 'extraction' } } });
  proxy.start();
  try {
    const result = await runCell(def, { out, providerProxy: `http://127.0.0.1:${proxy.port}`, frontier: false });
    const table = readerTokenizer(reader).encoding;
    const other = table === 'o200k_base' ? 'cl100k_base' : 'o200k_base';
    const alt = calibrationSamples(out, { encoding: other }).filter(s => s.reader === reader);
    const m = alt.length ? measureCalibration(alt) : null;
    const record = {
      run_id: runId, cell: def.id, arm: def.arms[0].cell_id, reader, effort: def.effort, keyless: !!keyless, status: result.status, stopped: result.stopped,
      calibration: calibrate(calibrationSamples(out)),
      other_encoding: m ? { encoding: other, factor: Math.round(m.factor * 10_000) / 10_000, max_error: Math.round(m.max_error * 10_000) / 10_000, needs_provider_count: m.needs_provider_count, samples: alt.length } : null,
      lease: { usd: leaseUsd, ...usageSplit(usageLog) },
    };
    writeFileSync(join(out, 'calibration.json'), JSON.stringify(record, null, 2) + '\n');
    console.log(JSON.stringify(record, null, 2));
  } finally {
    proxy.stop();
    lease.close();
  }
}
