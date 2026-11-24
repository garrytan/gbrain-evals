/**
 * Write-to-queryable probes for the cost-and-speed experiment
 * (docs/benchmarks/2026-11-24-cost-speed-preregistration.md, amendment of 2026-11-24): how one probe's polls become a
 * record, when a system counts as idle before the next probe, and the summary that feeds the results.
 *
 * - A poll either returns (with or without an item naming the session) or errors. A probe is `found` at its first
 *   returned poll that names the session, `missed` when every poll returned and none named it by the horizon, and
 *   `errored` when it never found the session and at least one poll errored: an outage, a configuration error or a
 *   refused lease is not a slow index, so errored probes stay out of the percentiles and the miss rate.
 * - A probe window (one world's counted probes) is void when more than a tenth of its probes errored or started
 *   without the system idle; a void window contributes no counted probe.
 * - Idle: the system reports no pending background work (or cannot say) and its provider slot has been quiet for
 *   `quietMs`, checked every `intervalMs` up to `maxMs`. The check only watches; it never drains or stops the
 *   system's own scheduler. A shim's /finish that says ready while its background liabilities are not drained is not
 *   idle.
 */

export type Poll = { at_ms: number; found: boolean; unattributed?: number } | { at_ms: number; error: string };
export type ProbeStatus = 'found' | 'missed' | 'errored';
export interface ProbeRecord {
  source_id: string;
  status: ProbeStatus;
  write_to_queryable_ms: number | null;
  polls: number;
  errored_polls: number;
  /** Returned items with no session id, summed over the probe's polls. */
  unattributed_returns: number;
  /** Whether the idle check before this probe found the system idle. */
  started_idle: boolean;
}

export function probeRecord(sourceId: string, polls: Poll[], startedIdle: boolean): ProbeRecord {
  const hit = polls.find(p => 'found' in p && p.found);
  const errored = polls.filter(p => 'error' in p).length;
  const unattributed = polls.reduce((n, p) => n + ('unattributed' in p ? p.unattributed ?? 0 : 0), 0);
  const status: ProbeStatus = hit ? 'found' : errored ? 'errored' : 'missed';
  return { source_id: sourceId, status, write_to_queryable_ms: hit ? hit.at_ms : null, polls: polls.length, errored_polls: errored, unattributed_returns: unattributed, started_idle: startedIdle };
}

export const VOID_SHARE = 0.1;

/** A world's probe window is void when more than a tenth of its probes errored or started without the system idle. */
export function windowVoid(records: ProbeRecord[]): boolean {
  const bad = records.filter(r => r.status === 'errored' || !r.started_idle).length;
  return records.length === 0 || bad / records.length > VOID_SHARE;
}

const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
};

/**
 * Counted probes are the found and missed probes that started idle, from windows that are not void. Misses rank above
 * the horizon, so a percentile that lands on one is null ("more than the horizon").
 */
export function probeSummary(windows: ProbeRecord[][], horizonMs: number) {
  const kept = windows.filter(w => !windowVoid(w));
  const counted = kept.flat().filter(r => r.started_idle && r.status !== 'errored');
  const ranked = counted.map(r => r.status === 'found' ? r.write_to_queryable_ms! : Infinity);
  const at = (q: number) => { if (!ranked.length) return null; const v = quantile(ranked, q); return Number.isFinite(v) && v <= horizonMs ? v : null; };
  const all = windows.flat();
  return {
    counted: counted.length, found: counted.filter(r => r.status === 'found').length, missed: counted.filter(r => r.status === 'missed').length,
    miss_share: counted.length ? counted.filter(r => r.status === 'missed').length / counted.length : null,
    p50_ms: at(0.5), p95_ms: at(0.95),
    errored: all.filter(r => r.status === 'errored').length, not_idle: all.filter(r => !r.started_idle).length,
    void_windows: windows.length - kept.length, unattributed_returns: all.reduce((n, r) => n + r.unattributed_returns, 0),
  };
}

/** A shim's /finish result counts as drained only when it says ready and does not report undrained background liabilities. */
export function finishDrained(f: { ready: boolean; raw?: { background_liabilities?: { drained?: boolean } } | null }): boolean {
  return f.ready && f.raw?.background_liabilities?.drained !== false;
}

export interface IdleCheck {
  /** Pending background jobs the system reports, or null when it cannot say. */
  pending: () => Promise<number | null>;
  /** When the system's provider slot last sent a request (epoch ms), or null when it never has. */
  lastRequestAt: () => number | null;
  quietMs?: number;
  maxMs?: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Wait until the system is idle, or give up at `maxMs`; never drains or stops anything. */
export async function awaitIdle(c: IdleCheck): Promise<{ idle: boolean; waited_ms: number }> {
  const now = c.now ?? Date.now, sleep = c.sleep ?? ((ms: number) => Bun.sleep(ms));
  const quiet = c.quietMs ?? 60_000, max = c.maxMs ?? 600_000, step = c.intervalMs ?? 1_000;
  const t0 = now();
  while (true) {
    const pending = await c.pending().catch(() => null);
    const last = c.lastRequestAt();
    if ((pending === null || pending === 0) && (last === null || now() - last >= quiet)) return { idle: true, waited_ms: now() - t0 };
    if (now() - t0 >= max) return { idle: false, waited_ms: now() - t0 };
    await sleep(step);
  }
}
