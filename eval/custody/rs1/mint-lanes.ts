/**
 * RS1's parallel mint driver (GST-1886, amendment of 2026-11-12). It runs mint.sh's first pass (everything up to the
 * probe step) for a range of slots, up to --lanes slots at a time, one mint.sh per slot. The topic steps stay in slot
 * order: a slot's topic, topic check and plan run alone, as `mint.sh --start <k> --count 1 --until plan`, after the
 * slot before it has finished its own, so each topic check reads the same earlier topics a one-at-a-time mint would.
 * The rest of the slot then runs in a lane as `mint.sh --start <k> --count 1 --until probe`, while the next slot's
 * topic runs. Every mint.sh is the unchanged sequential one, so its outputs, manifest checks, metering proxy and ledger
 * reservations are the same as a one-at-a-time mint's, and the second and third passes (validate-candidates.ts, then
 * mint.sh --candidates) and validate.ts run as before.
 *
 *   bun eval/custody/rs1/mint-lanes.ts --first <i> --last <j> --still-needed <n> [--lanes 4] [--retries 2] -- <mint.sh args>
 *
 * <mint.sh args> are mint.sh's own (--out and --seed-file, and --fake --beam-dir, --stub-model, or the real mode's
 * ledger and window flags); the driver adds --start, --count, --until and --no-usage, so they may not hold those or
 * --candidates or --regenerate. --mint-sh <path> replaces mint.sh, for tests, and only with --fake.
 *
 * Guarantees:
 *   - It never starts more slots than are still needed: it refuses (exit 2) before anything runs when --last - --first
 *     + 1 is more than --still-needed, the kept conversations the run still lacks (until N_final is known, 20, wave A's
 *     size and N_final's floor, less those already kept).
 *   - At most --lanes (1 to 8) mint.sh processes run at once, the topic pass included.
 *   - A refusal stops it: a ProviderRefusal (an HTTP 4xx other than 408 and 429, the metering proxy's 402 included,
 *     whether the step raised it or one of its parts did, as the step's traceback shows) or a mint.sh exit 2 starts no
 *     new slot, no retry and no lane; the lanes already running finish, and it exits 3.
 *     stop=http_402 names a 402. A slot whose topic pass was running when the stop came is counted as held: its
 *     topic and plan are done, and a rerun picks it up.
 *   - A StepFailure or PartFailure is retried in its lane, at most --retries more times; finished steps are verified
 *     and skipped, never bought again. A slot that still fails, or fails any other way, starts no new slot and exits 1.
 *   - usage.json is written once, after every lane has ended (mint.sh --no-usage leaves it to the driver, since
 *     concurrent runs would race on the one file).
 *   - Output is counts only: one "rs1-mint-lanes key=value ..." line per mint.sh start and end, and a summary. Each
 *     mint.sh's own counts-only output goes to <out>/lanes/<cid>-<until>-<attempt>.log, inside custody.
 *   - One driver per --out: <out>/lanes/.lock names the driver and its mint.sh process groups, and a second driver
 *     refuses while any of them is alive. SIGINT, SIGTERM and SIGHUP are passed to every mint.sh it runs.
 * A rerun over the same range resumes: slots already past the probe step are verified and skipped.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const HERE = import.meta.dir;
const RETRYABLE = new Set(['StepFailure', 'PartFailure']);
const OWN_FLAGS = ['--start', '--count', '--until', '--no-usage', '--candidates', '--regenerate'];

class LanesRefusal extends Error {}

interface Outcome { status: 'done' | 'dropped' | 'retry' | 'failed' | 'refused'; code: number; errorClass: string | null; http: string | null }

function parse(argv: string[]) {
  const split = argv.indexOf('--');
  if (split < 0) throw new LanesRefusal('pass mint.sh\'s arguments after --');
  const own = argv.slice(0, split), mintArgs = argv.slice(split + 1);
  const flag = (name: string) => { const i = own.indexOf(name); return i >= 0 ? own[i + 1] : undefined; };
  const whole = (name: string, fallback?: number) => {
    const v = flag(name);
    if (v === undefined && fallback !== undefined) return fallback;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw new LanesRefusal(`${name} must be a whole number`);
    return n;
  };
  for (const name of own.filter(a => a.startsWith('--'))) {
    if (!['--first', '--last', '--still-needed', '--lanes', '--retries', '--mint-sh'].includes(name)) throw new LanesRefusal(`unknown argument ${name}`);
  }
  const first = whole('--first'), last = whole('--last'), stillNeeded = whole('--still-needed'), lanes = whole('--lanes', 4), retries = whole('--retries', 2);
  if (first < 1 || last < first) throw new LanesRefusal('--first must be at least 1 and --last at least --first');
  if (lanes < 1 || lanes > 8) throw new LanesRefusal('--lanes must be 1 to 8');
  if (last - first + 1 > stillNeeded) throw new LanesRefusal(`slots ${first} to ${last} are ${last - first + 1}, more than the ${stillNeeded} still needed; mint no slot past them`);
  const taken = mintArgs.filter(a => OWN_FLAGS.includes(a));
  if (taken.length) throw new LanesRefusal(`mint.sh's ${taken.join(', ')} is the driver's to set`);
  const fake = mintArgs.includes('--fake');
  const mintSh = flag('--mint-sh');
  if (mintSh && !fake) throw new LanesRefusal('--mint-sh replaces mint.sh in tests only, with --fake');
  const outAt = mintArgs.indexOf('--out');
  if (outAt < 0 || !mintArgs[outAt + 1]) throw new LanesRefusal('mint.sh needs --out');
  if (!basename(mintArgs[outAt + 1].replace(/\/+$/, '')).startsWith('rs1-custody')) throw new LanesRefusal('--out must be a directory whose name starts with rs1-custody');
  let near = resolve(mintArgs[outAt + 1]);
  while (!existsSync(near)) near = dirname(near);
  if (spawnSync('git', ['-C', near, 'rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' }).status === 0) throw new LanesRefusal('--out must sit outside any git checkout');
  return { first, last, lanes, retries, mintArgs, fake, mintSh: resolve(mintSh ?? join(HERE, 'mint.sh')), out: resolve(mintArgs[outAt + 1]) };
}

export async function runLanes(argv: string[], print: (line: string) => void = line => console.log(line)): Promise<number> {
  const o = parse(argv);
  const say = (fields: Record<string, string | number>) => print(`rs1-mint-lanes ${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  const lanesDir = join(o.out, 'lanes');
  mkdirSync(lanesDir, { recursive: true, mode: 0o700 });
  const children = new Set<ChildProcess>();
  // One driver per --out: the lock names this process and every mint.sh process group it runs, so a rerun refuses
  // while any of them is alive, even after this process was killed.
  const lock = join(lanesDir, '.lock');
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } };
  const writeLock = () => writeFileSync(lock, JSON.stringify({ pid: process.pid, groups: [...children].map(c => c.pid) }));
  try { closeSync(openSync(lock, 'wx', 0o600)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let held: { pid?: number; groups?: number[] } = {};
    try { held = JSON.parse(readFileSync(lock, 'utf8')); } catch {}
    if ((held.pid && alive(held.pid)) || (held.groups ?? []).some(g => alive(-g))) {
      throw new LanesRefusal(`another mint-lanes run on this --out, or a mint.sh it started, is still running (lock ${lock}); let it finish or stop its process groups first`);
    }
    unlinkSync(lock);
    closeSync(openSync(lock, 'wx', 0o600));
  }
  writeLock();
  let inFlight = 0, maxInFlight = 0, retried = 0;
  let stop: string | null = null;
  const counts = { done: 0, dropped: 0, failed: 0, refused: 0, held: 0 };

  const forward = (signal: NodeJS.Signals) => {
    stop ??= `signal_${signal.toLowerCase()}`;
    for (const child of children) if (child.pid) try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  };
  process.on('SIGINT', forward);
  process.on('SIGTERM', forward);
  process.on('SIGHUP', forward);

  const mint = (slot: number, until: 'plan' | 'probe', attempt: number) => new Promise<Outcome>(done => {
    const cid = `c${String(slot).padStart(3, '0')}`;
    const log = join(lanesDir, `${cid}-${until}-${attempt}.log`);
    const offset = existsSync(log) ? statSync(log).size : 0;
    const startedAt = Date.now();
    const fd = openSync(log, 'a', 0o600);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    say({ event: 'start', slot, phase: until, attempt, in_flight: inFlight });
    const child = spawn('bash', [o.mintSh, ...o.mintArgs, '--start', String(slot), '--count', '1', '--until', until, '--no-usage'], { stdio: ['ignore', fd, fd], detached: true });
    children.add(child);
    writeLock();
    const settle = (code: number) => {
      children.delete(child);
      writeLock();
      closeSync(fd);
      inFlight--;
      const text = readFileSync(log).subarray(offset).toString('utf8');
      const failed = [...text.matchAll(/ step=(\w+) status=error error_class=(\w+)/g)].pop();
      const errorClass = failed?.[2] ?? null;
      const http = /^rs1-mint refused: HTTP (\d{3})\b/m.exec(text)?.[1] ?? (failed && code !== 0 ? refusalIn(cid, failed[1], startedAt) : null);
      const status: Outcome['status'] = code === 0
        ? (/ dropped=1 /.test(text) ? 'dropped' : 'done')
        : code === 2 || errorClass === 'ProviderRefusal' || http ? 'refused'
          : errorClass && RETRYABLE.has(errorClass) ? 'retry' : 'failed';
      say({ event: 'end', slot, phase: until, attempt, exit: code, status, error_class: errorClass ?? 'none', http: http ?? 'none', in_flight: inFlight });
      done({ status, code, errorClass, http });
    };
    child.on('error', () => settle(127));
    child.on('close', (code, signal) => settle(code ?? (signal ? 128 : 1)));
  });

  /**
   * A refusal inside a step's traceback, written by this attempt: a ProviderRefusal a part of the step raised (the
   * step then fails as PartFailure) or an HTTP 4xx other than 408 and 429 from urllib. Only the status is read.
   */
  const refusalIn = (cid: string, step: string, since: number): string | null => {
    const path = join(o.out, 'set', 'conversations', cid, 'errors', `${step}.traceback`);
    if (!existsSync(path) || statSync(path).mtimeMs < since - 1000) return null;
    const text = readFileSync(path, 'utf8');
    const status = Number((/ProviderRefusal: HTTP (\d{3})\b/.exec(text) ?? /HTTPError: HTTP Error (\d{3})\b/.exec(text))?.[1]);
    return status >= 400 && status < 500 && status !== 408 && status !== 429 ? String(status) : null;
  };

  /** One slot's pass up to until, with its retries; records why it stopped. */
  const pass = async (slot: number, until: 'plan' | 'probe'): Promise<Outcome> => {
    for (let attempt = 1; ; attempt++) {
      const outcome = await mint(slot, until, attempt);
      if (outcome.status === 'retry' && attempt <= o.retries && !stop) { retried++; continue; }
      if (outcome.status === 'refused') stop ??= outcome.http ? `http_${outcome.http}` : 'refusal';
      if (outcome.status === 'retry' || outcome.status === 'failed') { stop ??= 'failed'; return { ...outcome, status: 'failed' }; }
      return outcome;
    }
  };
  const tally = (outcome: Outcome) => {
    if (outcome.status === 'done') counts.done++;
    else if (outcome.status === 'dropped') counts.dropped++;
    else if (outcome.status === 'refused') counts.refused++;
    else counts.failed++;
  };

  const running = new Set<Promise<void>>();
  let started = 0;
  for (let slot = o.first; slot <= o.last && !stop; slot++) {
    while (inFlight >= o.lanes) await Promise.race(running);
    if (stop) break;
    started++;
    const topic = await pass(slot, 'plan');
    if (topic.status !== 'done') { tally(topic); continue; }
    if (stop) { counts.held++; break; }
    const lane: Promise<void> = pass(slot, 'probe').then(tally).finally(() => running.delete(lane));
    running.add(lane);
  }
  await Promise.all(running);
  process.off('SIGINT', forward);
  process.off('SIGTERM', forward);
  process.off('SIGHUP', forward);
  unlinkSync(lock);

  const py = o.fake ? 'python3' : join(o.out, 'tooling', 'venv', 'bin', 'python');
  const usage = await new Promise<number>(done => {
    const child = spawn(py, [join(HERE, 'rs1_mint.py'), 'usage', '--out', o.out], { stdio: ['ignore', 'pipe', 'inherit'], env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', PYTHONDONTWRITEBYTECODE: '1' } });
    child.stdout.on('data', chunk => process.stdout.write(chunk));
    child.on('error', () => done(127));
    child.on('close', code => done(code ?? 1));
  });
  say({
    summary: 'lanes', first: o.first, last: o.last, lanes: o.lanes, slots: o.last - o.first + 1, started, ...counts,
    not_started: o.last - o.first + 1 - started, retries: retried, max_in_flight: maxInFlight, usage_exit: usage, stop: stop ?? 'none',
  });
  if (stop && stop !== 'failed') return 3;
  return stop || usage !== 0 ? 1 : 0;
}

if (import.meta.main) {
  runLanes(process.argv.slice(2)).then(code => process.exit(code), (error: Error) => {
    process.stderr.write(error instanceof LanesRefusal ? `rs1-mint-lanes refused: ${error.message}\n` : `rs1-mint-lanes error class=${error.name}\n`);
    process.exit(2);
  });
}
