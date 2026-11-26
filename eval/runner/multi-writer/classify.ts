/**
 * How the multi-writer behavior suite turns writer results into a verdict (eval/runner/multi-writer-behavior.ts).
 *
 * Four outcomes, in this order of precedence:
 *
 *   invalid        a switch-on run whose running engine did not prove multi-user mode is on (the whole run, every check)
 *   fail           wrong data: an acknowledged write is missing, a page is duplicated, a deleted page or a forgotten fact
 *                  comes back, a privacy rule leaks, times go backward, or a write failed with an error that is not a
 *                  typed refusal (including an accepted write that never commits)
 *   not_supported  the engine refused a step with a typed refusal (gbrain's engine_capability_missing, a store or data
 *                  directory lock it reports by name); the expected fail-closed answer on Rust until its lanes land
 *   pass           every step ran, every write was acknowledged and every invariant held
 *
 * Failures whose text names a multi-user lease or fence refusal (the known Rust write-lock acquisition bug) are
 * still failures, and are counted apart in `write_lock_bug` so a reader can tell them from other wrong answers.
 */
import type { OpLine } from './worker.ts';

/** `held` marks a phase run on purpose but not counted (its lane's fixes have not landed); a check is never held. */
export type Status = 'pass' | 'fail' | 'not_supported' | 'invalid' | 'held';

/** Typed refusals: the engine says it cannot do this, and writes nothing. */
export const REFUSAL_CODES = new Set([
  'engine_capability_missing', 'pglite_busy', 'pglite_locked', 'rust_store_locked', 'store_locked', 'owner_busy',
  'engine_not_supported_by_runner', 'access_control_unsupported',
]);

export interface OpTally {
  total: number;
  acked: number;
  refused: Record<string, number>;
  /** Errors that are neither a refusal nor an expected answer, by code, with one sample message each. */
  errors: Record<string, { count: number; sample: string }>;
  /** Accepted writes (write_pending) that had not committed when the phase settled. */
  pending_never_applied: number;
  write_lock_bug: number;
  /** Typed concurrency answers (a lost compare-and-set race, a create of a page that now exists). Not wrong data. */
  conflicts: Record<string, number>;
  /**
   * Typed answers that a store owner went away mid-call (the CLI process that owned a Rust brain exited, or was killed)
   * or refused a second process. The engine says the outcome is unknown or the step cannot run from this process, so
   * these count with the refusals (not_supported), are kept apart here, and the write may or may not have landed.
   */
  handoff: Record<string, number>;
}

/** An owner hand-off or second-process refusal: the caller is told it failed or that the outcome is unknown. */
export function isHandoff(code: string | undefined, message = ''): boolean {
  return code === 'owner_unavailable' || code === 'outcome_unknown' || (code === 'unavailable' && /owner|second process|closing/i.test(message));
}

/**
 * gbrain's typed answers to a writer that lost a race; the write did nothing and the caller is told so. Judged by code,
 * never by free text, except gbrain's one fixed sentence for a write whose page moved under it, which arrives as
 * invalid_params (a concurrent remember on one entity gets it).
 */
export const CONFLICT_CODES = new Set(['revision_conflict', 'revision_required']);
export const MOVED_UNDER_WRITE = 'The accepted page identity or revision no longer matches.';

export function isConflict(code: string | undefined, message = ''): boolean {
  if (CONFLICT_CODES.has(code ?? '')) return true;
  return code === 'invalid_params' && message.includes(MOVED_UNDER_WRITE);
}

export function emptyTally(): OpTally {
  return { total: 0, acked: 0, refused: {}, errors: {}, pending_never_applied: 0, write_lock_bug: 0, conflicts: {}, handoff: {} };
}

/**
 * Count op lines. `expectedError(line)` marks an error that is the right answer for that step (a write to a deleted page
 * answering page_not_found, say), which counts as neither acked nor an error. `applied` holds the request ids of
 * write_pending receipts that committed later; those count as acknowledged.
 */
export function tallyOps(lines: readonly OpLine[], o: { expectedError?: (l: OpLine) => boolean; applied?: ReadonlySet<string>; leaseLog?: boolean; conflictIsError?: boolean } = {}): OpTally {
  const t = emptyTally();
  for (const l of lines) {
    t.total += 1;
    if (l.ok) { t.acked += 1; continue; }
    if (l.code === 'write_pending' && l.request_id && o.applied?.has(l.request_id)) { t.acked += 1; continue; }
    if (o.expectedError?.(l)) continue;
    const code = l.code ?? 'error';
    if (REFUSAL_CODES.has(code)) { t.refused[code] = (t.refused[code] ?? 0) + 1; continue; }
    if (isHandoff(code, l.message)) { t.handoff[code] = (t.handoff[code] ?? 0) + 1; continue; }
    if (isConflict(code, l.message) && !o.conflictIsError) { t.conflicts[code] = (t.conflicts[code] ?? 0) + 1; continue; }
    if (code === 'write_pending') t.pending_never_applied += 1;
    if (l.lease_fence || (code === 'write_pending' && o.leaseLog) || code === 'lease_lost') t.write_lock_bug += 1;
    const e = t.errors[code] ?? (t.errors[code] = { count: 0, sample: (l.message ?? '').slice(0, 300) });
    e.count += 1;
  }
  return t;
}

/** Add `b` into `a`, every field. */
export function mergeTally(a: OpTally, b: OpTally): OpTally {
  a.total += b.total; a.acked += b.acked; a.pending_never_applied += b.pending_never_applied; a.write_lock_bug += b.write_lock_bug;
  for (const k of ['refused', 'conflicts', 'handoff'] as const) for (const [c, n] of Object.entries(b[k])) a[k][c] = (a[k][c] ?? 0) + n;
  for (const [c, e] of Object.entries(b.errors)) { const x = a.errors[c]; if (x) x.count += e.count; else a.errors[c] = { ...e }; }
  return a;
}

/**
 * Record a failed verification read (the operator reading the brain back). A not-found answer the check expects is
 * fine; a refusal or owner hand-off means the check could not verify (not_supported); anything else is an error, so a
 * read that fails can never stand in for "the data is gone".
 */
export function recordReadFailure(t: OpTally, l: Pick<OpLine, 'ok' | 'code' | 'message' | 'op'>, notFoundOk: boolean): void {
  if (l.ok) return;
  const code = l.code ?? 'error';
  if (notFoundOk && /(^|_)not_found$/.test(code)) return;
  if (REFUSAL_CODES.has(code)) { t.refused[`read_${code}`] = (t.refused[`read_${code}`] ?? 0) + 1; return; }
  if (isHandoff(code, l.message)) { t.handoff[`read_${code}`] = (t.handoff[`read_${code}`] ?? 0) + 1; return; }
  const k = `read_${l.op}_${code}`;
  const e = t.errors[k] ?? (t.errors[k] = { count: 0, sample: (l.message ?? '').slice(0, 300) });
  e.count += 1;
}

/** A phase verdict from its tally and its invariant findings (each finding is one plain sentence of wrong data). */
export function phaseStatus(t: OpTally, findings: readonly string[]): Status {
  if (findings.length > 0 || Object.keys(t.errors).length > 0) return 'fail';
  if (Object.keys(t.refused).length > 0 || Object.keys(t.handoff ?? {}).length > 0) return 'not_supported';
  return 'pass';
}

/** A check's verdict from its phases: any fail fails it, then any refusal; a run that failed its switch proof is invalid. */
export function combineStatus(all: readonly Status[], runInvalid = false): Status {
  if (runInvalid) return 'invalid';
  const phases = all.filter(p => p !== 'held');
  if (phases.includes('fail')) return 'fail';
  if (phases.includes('invalid')) return 'invalid';
  if (phases.includes('not_supported')) return 'not_supported';
  return phases.length ? 'pass' : 'not_supported';
}

/** Nearest-rank percentile of `values` (milliseconds), or null when there are none. */
export function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return Number(s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!.toFixed(2));
}

export interface SwitchProof {
  requested: 'on' | 'off';
  /** What each engine-mode probe process saw: its role, the store's own multi-user answer and the session behaviour. */
  probes: Array<Record<string, unknown>>;
  verdict: 'on_proven' | 'off_proven' | 'not_applicable' | 'invalid';
  reason: string;
}

/**
 * Judge the switch from the running engines' own answers, never from the environment variable. On: at least one probe
 * opened the store as its owner, the store reported multiuser true, and the session probe reached the store's token
 * check (a store in single-writer mode refuses before that with reason multiuser_off); no probe may contradict it.
 * Off: every owner probe reported multiuser false. Anything else is invalid.
 */
export function judgeSwitch(kind: string, requested: 'on' | 'off', probes: Array<Record<string, unknown>>): SwitchProof {
  if (kind !== 'rust') return { requested, probes, verdict: 'not_applicable', reason: `${kind} has no multi-user switch` };
  const owners = probes.filter(p => p && p.store_open === true);
  if (!owners.length) return { requested, probes, verdict: 'invalid', reason: 'no probe process opened the store as its owner, so the running engine never answered' };
  if (requested === 'on') {
    const bad = owners.filter(p => p.store_multiuser !== true || p.session_probe !== 'reached_store_mint');
    if (bad.length) return { requested, probes, verdict: 'invalid', reason: `the switch was requested on, but ${bad.length} of ${owners.length} owner probes saw multiuser=${String(bad[0]!.store_multiuser)} session=${String(bad[0]!.session_probe)}` };
    return { requested, probes, verdict: 'on_proven', reason: `${owners.length} owner probes: store multiuser=true and the session probe reached the store's token check (reason=mint)` };
  }
  const bad = owners.filter(p => p.store_multiuser !== false);
  if (bad.length) return { requested, probes, verdict: 'invalid', reason: `the switch was requested off, but ${bad.length} owner probes saw multiuser=${String(bad[0]!.store_multiuser)}` };
  return { requested, probes, verdict: 'off_proven', reason: `${owners.length} owner probes: store multiuser=false${owners.some(p => p.session_probe === 'refused_multiuser_off') ? ', session refused with reason=multiuser_off' : ''}` };
}

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})/g;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const VOLATILE_KEYS = /^(ms|t0|t1|pid|elapsed_ms|duration_ms|latency_ms|took_ms|age_ms|loop_lag_ms|timings?|embedding_ms|wall_ms)$/;

/**
 * A result with what legitimately differs between two runs of the same serial script taken out: timestamps, UUIDs
 * (revisions, request ids), timing fields and scratch paths. What is left must be byte-identical on two builds that
 * behave the same.
 */
export function normalizeForParity(value: unknown, paths: readonly string[] = []): unknown {
  if (typeof value === 'string') {
    let s = value.replace(ISO, '<ts>').replace(UUID, '<uuid>');
    for (const p of paths) if (p) s = s.split(p).join('<work>');
    return s;
  }
  if (Array.isArray(value)) return value.map(v => normalizeForParity(v, paths));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) out[k] = VOLATILE_KEYS.test(k) ? '<volatile>' : normalizeForParity((value as Record<string, unknown>)[k], paths);
    return out;
  }
  return value;
}

/** The outcome class of one call, for comparing engines on the same input: ok with a count, or the error code. */
export function outcomeClass(l: Pick<OpLine, 'ok' | 'code' | 'result'>): string {
  if (!l.ok) return `refused:${l.code ?? 'error'}`;
  const r = l.result as unknown;
  const rows = Array.isArray(r) ? r : Array.isArray((r as { results?: unknown })?.results) ? (r as { results: unknown[] }).results : Array.isArray((r as { pages?: unknown })?.pages) ? (r as { pages: unknown[] }).pages : null;
  return rows ? `ok:${rows.length}` : 'ok';
}
