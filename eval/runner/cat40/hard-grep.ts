/**
 * Cat 40 Hard grep off the main thread (plan 2026-10-05, ENG-F13).
 *
 * The Hard fs `grep` returns every match, so one call can scan a 50,000-file
 * corpus, and a catastrophic regular expression could run for minutes. It runs
 * in a Bun Worker that holds the base corpus (posted once, when the worker
 * starts); each call posts only the run's overlay. Calls to one worker run
 * one at a time, each with its own time limit; a call past the limit
 * terminates the worker, returns an error to the agent (the agent's problem,
 * not the harness's), and the next call starts a fresh worker. Workers are
 * unref'd, so they never keep a process alive.
 */
import { HarnessError } from './loop.ts';
import type { HardGrepRequest } from './hard-grep-worker.ts';

export type { HardGrepRequest } from './hard-grep-worker.ts';
/** Default per-call time limit for a Hard grep. */
export const HARD_GREP_TIMEOUT_MS = 20_000;
const WORKER_READY_TIMEOUT_MS = 300_000;

/** The agent-facing text for a grep that ran past its limit. */
export const grepTimeoutMessage = (ms: number) => `Error: grep timed out after ${ms / 1000} s; use a simpler pattern or a narrower path`;

interface Job { req: HardGrepRequest; timeoutMs: number; resolve: (s: string) => void; reject: (e: Error) => void }

/** One worker per base corpus; calls queue on the main thread and run one at a time. */
export class GrepWorker {
  private worker: Promise<Worker> | null = null;
  private live: Worker | null = null;
  private queue: Job[] = [];
  private busy = false;
  /** Workers started so far (1 unless a call timed out or a worker failed). */
  spawned = 0;
  constructor(private base: Map<string, string>) {}

  private spawn(): Promise<Worker> {
    const w = new Worker(new URL('./hard-grep-worker.ts', import.meta.url).href);
    (w as unknown as { unref(): void }).unref();
    this.live = w;
    this.spawned++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { done(); w.terminate(); reject(new HarnessError('grep worker did not start within 300 s')); }, WORKER_READY_TIMEOUT_MS);
      const onMsg = (e: MessageEvent) => { if ((e.data as { type?: string }).type === 'ready') { done(); resolve(w); } };
      const onErr = (e: ErrorEvent) => { done(); w.terminate(); reject(new HarnessError(`grep worker failed to start: ${e.message}`)); };
      const done = () => { clearTimeout(t); w.removeEventListener('message', onMsg); w.removeEventListener('error', onErr); };
      w.addEventListener('message', onMsg);
      w.addEventListener('error', onErr);
      w.postMessage({ type: 'init', files: this.base });
    });
  }

  private drop() { this.live?.terminate(); this.live = null; this.worker = null; }

  grep(req: HardGrepRequest, timeoutMs = HARD_GREP_TIMEOUT_MS): Promise<string> {
    return new Promise((resolve, reject) => { this.queue.push({ req, timeoutMs, resolve, reject }); void this.pump(); });
  }

  private async pump() {
    if (this.busy) return;
    const job = this.queue.shift();
    if (!job) return;
    this.busy = true;
    let w: Worker;
    try { w = await (this.worker ??= this.spawn()); }
    catch (e) { this.worker = null; this.live = null; this.busy = false; job.reject(e as Error); void this.pump(); return; }
    await new Promise<void>(settle => {
      const finish = (fn: () => void) => { clearTimeout(t); w.removeEventListener('message', onMsg); w.removeEventListener('error', onErr); fn(); settle(); };
      const t = setTimeout(() => { this.drop(); finish(() => job.resolve(grepTimeoutMessage(job.timeoutMs))); }, job.timeoutMs);
      const onMsg = (e: MessageEvent) => {
        const d = e.data as { type?: string; out?: string; error?: string };
        if (d.type !== 'result') return;
        finish(() => job.resolve(d.error !== undefined ? `Error: ${d.error}` : d.out!));
      };
      const onErr = (e: ErrorEvent) => { this.drop(); finish(() => job.reject(new HarnessError(`grep worker failed: ${e.message}`))); };
      w.addEventListener('message', onMsg);
      w.addEventListener('error', onErr);
      w.postMessage({ type: 'grep', req: job.req });
    });
    this.busy = false;
    void this.pump();
  }

  terminate() { this.drop(); }
}

const workers = new Map<Map<string, string>, GrepWorker>();

/** The shared worker for a base corpus (FileStores built from the same map share it). */
export function grepWorkerFor(base: Map<string, string>): GrepWorker {
  let w = workers.get(base);
  if (!w) workers.set(base, w = new GrepWorker(base));
  return w;
}

/** Terminate every Hard grep worker (end of a run or a test file). */
export function terminateGrepWorkers() {
  for (const w of workers.values()) w.terminate();
  workers.clear();
}
