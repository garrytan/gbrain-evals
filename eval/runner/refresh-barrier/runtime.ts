/**
 * The two actors of a refresh-barrier trial, shared by the multi-process Postgres runner (child.ts) and the in-process
 * PGLite runner (trial.ts):
 *
 * - an agent's MCP session (`runWriter`): it issues the schedule's remember and put_page calls through gbrain's MCP
 *   dispatcher, exactly as `gbrain serve` receives them (remote, stdio, interactive admission); a blind put (`put_blind`)
 *   is a local script's read-modify-write through the CLI write path (`gbrain put` with force, no expected_revision),
 *   the only caller allowed to replace an existing page without a revision. Every caller follows gbrain's
 *   documented client contract (the "spec client"): a retryable refusal is retried with the same request_id after
 *   retry_after_ms (at most MAX_ATTEMPTS calls), and a pending receipt is polled with get_write_request until it is final;
 * - a scheduled refresh tick (`runTick`): another machine pushes upstream, then `refreshWorktree` runs with a pause at
 *   one boundary (the seam gbrain's own barrier tests use) standing in for a slow fetch, merge or member sync.
 *
 * Every observation is appended to a JSONL event log; verify.ts reads the database and Git afterwards for ground truth.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GbrainModules, BrainIds, BrainPaths } from './fixture.ts';
import { git, insertTopLine, notePage, pushUpstream, seedPage } from './fixture.ts';
import { PARAMS, type ScheduledOp, type TickPlan, type ForeignCommit } from './schedule.ts';

export const MAX_ATTEMPTS = 8;
export const CALL_TIMEOUT_MS = 60_000;
export const POLL_LIMIT_MS = 180_000;
export const RETRY_FLOOR_MS = 250;
export const RETRY_CEIL_MS = 5_000;

export type Logger = (event: Record<string, unknown>) => void;
export const jsonlLogger = (path: string): Logger => event => appendFileSync(path, `${JSON.stringify({ t: Date.now(), ...event })}\n`);

export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, Math.max(0, ms)));

export type FirstClass = 'committed' | 'pending' | 'refused_retryable' | 'refused' | 'timeout' | 'harness_error';
export interface Classified { cls: FirstClass; code: string | null; state: string | null; retry_after_ms: number | null; deferred: boolean; body: Record<string, any> }

export const FROZEN_VERB_CODES = new Set(['scope_denied', 'invalid_params', 'unavailable']);

/** How the spec client reads one MCP result. */
export function classifyResult(isError: boolean, body: Record<string, any>): Classified {
  const receipt = body.receipt ?? body.write_request ?? body;
  const retryAfter = Number(body.retry_after_ms ?? receipt?.retry_after_ms ?? body.next?.retry_after_ms ?? /retry_after_ms=(\d+)/.exec(String(body.detail ?? ''))?.[1]);
  const deferred = Boolean(body.deferred ?? receipt?.deferred);
  const base = { retry_after_ms: Number.isFinite(retryAfter) ? retryAfter : null, deferred, body };
  if (!isError) {
    const state = String(body.state ?? receipt?.state ?? '');
    if (state === 'committed') return { cls: 'committed', code: null, state, ...base };
    if (body.status === 'pending' || ['queued', 'running', 'deferred', 'recovering'].includes(state)) return { cls: 'pending', code: null, state: state || 'queued', ...base };
    return { cls: 'harness_error', code: `unexpected_ok:${String(body.status ?? state)}`, state: state || null, ...base };
  }
  if (body.code == null && body.error == null) return { cls: 'harness_error', code: 'unrecognised_error', state: null, ...base };
  // gbrain's frozen MEMORY_VERBS v1 codes (verb-errors.ts) never widen: remember answers a source_changed conflict as
  // scope_denied, with the real reason in write_error, so the spec client classifies by write_error when one rides along.
  const frozen = FROZEN_VERB_CODES.has(String(body.code)) && typeof body.write_error === 'string' && body.write_error !== 'write_pending';
  const code = String(frozen ? body.write_error : body.code ?? body.error);
  // gbrain's admittedPendingReceipt (persistence/types.ts): frozen memory verbs answer an accepted write still in flight as
  // error `unavailable` with write_error `write_pending` and a non-terminal receipt.
  // Like gbrain's own reader, only with a receipt that is not final.
  if ((code === 'write_pending' || body.error === 'write_pending' || body.write_error === 'write_pending') && typeof body.write_request?.state === 'string') {
    const state = String(body.write_request.state);
    if (!['committed', 'conflict', 'failed', 'cancelled'].includes(state)) return { cls: 'pending', code: 'write_pending', state, ...base };
  }
  const retryable = body.retryable === true || body.class === 'retryable';
  return { cls: retryable ? 'refused_retryable' : 'refused', code, state: body.write_request?.state ?? null, ...base };
}

export interface Session { g: GbrainModules; engine: any; ids: BrainIds; paths: BrainPaths; log: Logger; stopped: () => boolean }

type Surface = 'mcp' | 'cli';

/** A local CLI write: the receipt, or the refusal flattened into the MCP error body's fields. */
async function cliPut(s: Session, sourceId: string, params: Record<string, unknown>): Promise<{ isError: boolean; body: Record<string, any> }> {
  const ctx = { engine: s.engine, sourceId, remote: false, dryRun: false, admissionOrigin: 'interactive',
    config: { engine: s.engine.kind, embedding_disabled: true }, logger: { info() {}, warn() {}, error() {} } };
  try {
    const receipt = await s.g.pageMutations.submitPageMutation(ctx, { operation: 'put_page', params }) as Record<string, any>;
    return { isError: false, body: receipt };
  } catch (error) {
    const e = error as Record<string, any>;
    const receipt = e.writeRequest as Record<string, any> | undefined;
    return { isError: true, body: { code: e.code ?? null, message: String(e.message ?? error), detail: e.detail, retryable: e.retryable === true || e.class === 'retryable' || undefined,
      retry_after_ms: receipt?.retry_after_ms, write_request: receipt, deferred: receipt?.deferred } };
  }
}

async function call(s: Session, sourceId: string, name: string, params: Record<string, unknown>, surface: Surface = 'mcp'): Promise<{ isError: boolean; body: Record<string, any>; ms: number } | 'timeout'> {
  const started = performance.now();
  const work = (surface === 'cli' && name === 'put_page' ? cliPut(s, sourceId, params)
    : s.g.dispatch.dispatchToolCall(s.engine, name, params, surface === 'cli' ? { remote: false, sourceId, admissionOrigin: 'interactive' } : { remote: true, transport: 'stdio', sourceId, admissionOrigin: 'interactive' })
      .then((r: any) => ({ isError: r.isError === true, body: JSON.parse(r.content?.[0]?.text ?? '{}') })))
    .then((r: { isError: boolean; body: Record<string, any> }) => ({ ...r, ms: performance.now() - started }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), CALL_TIMEOUT_MS); });
  try { return await Promise.race([work, timeout]); } finally { clearTimeout(timer); }
}

function opParams(op: ScheduledOp, content: string | null, revision: string | null): [string, Record<string, unknown>] {
  if (op.kind === 'put_blind') return ['put_page', { slug: op.slug, content: `${(content ?? seedPage(op.slug!)).trimEnd()}\n\nBlind update ${op.marker}.\n`, force: true, request_id: op.request_id }];
  const fact = `Observed by the refresh-barrier eval: ${op.marker}.`;
  switch (op.kind) {
    case 'remember_entity': return ['remember', { fact, entity: op.slug, provenance: 'refresh-barrier eval, synthetic', request_id: op.request_id }];
    case 'remember_unattributed': return ['remember', { fact, provenance: 'refresh-barrier eval, synthetic', request_id: op.request_id }];
    case 'put_create': return ['put_page', { slug: op.slug, content: notePage(`Note ${op.index}`, `Created by the refresh-barrier eval. ${op.marker}`), request_id: op.request_id }];
    case 'put_update': return ['put_page', { slug: op.slug, content: `${(content ?? seedPage(op.slug!)).trimEnd()}\n\nUpdate ${op.marker}.\n`, expected_revision: revision, request_id: op.request_id }];
  }
}

/** Polls a pending receipt until it is final, the session is stopped, or POLL_LIMIT_MS passes. */
async function poll(s: Session, sourceId: string, op: ScheduledOp, writer: number, firstAt: number, hintMs: number | null, surface: Surface): Promise<void> {
  let wait = Math.min(Math.max(hintMs ?? 500, RETRY_FLOOR_MS), 2_000);
  while (!s.stopped() && Date.now() - firstAt < POLL_LIMIT_MS) {
    await sleep(wait);
    const res = await call(s, sourceId, 'get_write_request', { request_id: op.request_id }, surface);
    if (res === 'timeout') { s.log({ ev: 'poll_timeout', writer, op: op.index, request_id: op.request_id }); return; }
    const state = String(res.body.state ?? res.body.write_request?.state ?? '');
    if (!res.isError && ['committed', 'conflict', 'failed', 'cancelled'].includes(state)) {
      s.log({ ev: 'final', writer, op: op.index, request_id: op.request_id, state, code: res.body.write_error ?? res.body.write_error_reason ?? null, after_ms: Date.now() - firstAt });
      return;
    }
    if (res.isError) { s.log({ ev: 'poll_error', writer, op: op.index, request_id: op.request_id, code: res.body.code ?? res.body.error ?? null }); }
    wait = Math.min(Math.max(Number(res.body.retry_after_ms ?? wait), RETRY_FLOOR_MS), 2_000);
  }
  s.log({ ev: 'poll_gave_up', writer, op: op.index, request_id: op.request_id });
}

/**
 * One agent session. Calls are issued one at a time, each no earlier than its scheduled offset from t0; a pending receipt
 * is polled in the background so the session moves on, as an agent would. Returns once every poll has finished.
 */
export async function runWriter(s: Session, writer: number, ops: ScheduledOp[], t0: number, onOpDone?: (opIndex: number) => void): Promise<void> {
  const polls: Promise<void>[] = [];
  for (const op of ops) {
    await sleep(t0 + op.at_ms - Date.now());
    const sourceId = s.ids[op.source];
    let content: string | null = null, revision: string | null = null;
    const surface: Surface = op.kind === 'put_blind' ? 'cli' : 'mcp';
    if (op.kind === 'put_blind') {
      const file = join(s.paths.root, op.source, `${op.slug}.md`);
      content = existsSync(file) ? readFileSync(file, 'utf8') : null;
    }
    if (op.kind === 'put_update') {
      const read = await call(s, sourceId, 'get_page', { slug: op.slug, include_content: true });
      if (read === 'timeout') { s.log({ ev: 'call_timeout', writer, op: op.index, request_id: op.request_id, name: 'get_page' }); onOpDone?.(op.index); continue; }
      if (read.isError) { s.log({ ev: 'read_failed', writer, op: op.index, request_id: op.request_id, code: read.body.code ?? read.body.error ?? null }); onOpDone?.(op.index); continue; }
      content = typeof read.body.content === 'string' ? read.body.content : null;
      revision = String(read.body.revision ?? read.body.knowledge_revision ?? '');
    }
    const [name, params] = opParams(op, content, revision);
    const firstAt = Date.now();
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const res = await call(s, sourceId, name, params, surface);
      if (res === 'timeout') { s.log({ ev: 'call_timeout', writer, op: op.index, request_id: op.request_id, name, attempt }); break; }
      const c = classifyResult(res.isError, res.body);
      s.log({ ev: 'response', writer, op: op.index, request_id: op.request_id, kind: op.kind, name, attempt, cls: c.cls, code: c.code, state: c.state,
        retry_after_ms: c.retry_after_ms, deferred: c.deferred, ms: Math.round(res.ms), message: res.isError ? String(res.body.message ?? '').slice(0, 400) : undefined,
        wire_code: res.isError ? res.body.code ?? res.body.error ?? null : undefined,
        ...(attempt === 1 ? { slip_ms: firstAt - (t0 + op.at_ms) } : {}) });
      if (c.cls === 'committed' || c.cls === 'refused' || c.cls === 'harness_error') break;
      if (c.cls === 'pending') { polls.push(poll(s, sourceId, op, writer, firstAt, c.retry_after_ms, surface)); break; }
      if (attempt === MAX_ATTEMPTS) { s.log({ ev: 'retries_exhausted', writer, op: op.index, request_id: op.request_id }); break; }
      await sleep(Math.min(Math.max(c.retry_after_ms ?? 1_000, RETRY_FLOOR_MS), RETRY_CEIL_MS));
    }
    onOpDone?.(op.index);
  }
  await Promise.all(polls);
}

/** Pushes the tick's upstream files from "another machine". */
export function pushTick(paths: BrainPaths, tick: TickPlan): string {
  return pushUpstream(paths, tick.pushes.map(({ path, marker }) => ({ path, line: `Upstream note ${marker}.`, create: () => notePage('Upstream note', `Pushed by another machine. ${marker}`) })),
    `upstream tick ${tick.index}`);
}

/**
 * One refresh tick. `onPaused` fires once the tick sits at its boundary; a crash tick then waits forever for the parent's
 * SIGKILL. A resume tick runs the `--resume` path instead.
 */
/** Refusals a cron meets and retries on its next run: the checkout or the remote moved, or a refresh or fetch was already busy. */
/** Every status refreshWorktree and performManagedSync can return at G; any other status is a harness_error (the harness no longer understands G). */
export const KNOWN_TICK_STATUSES = new Set(['already_current', 'completed', 'sync_blocked', 'sync_deferred', 'syncing', 'abandoned', 'nothing_to_resume']);
export const KNOWN_SYNC_STATUSES = new Set(['up_to_date', 'synced', 'first_sync', 'partial', 'blocked_by_failures']);

export const TICK_RETRY_CODES = new Set(['refresh_diverged', 'refresh_source_changed', 'refresh_dirty', 'refresh_in_progress', 'refresh_drain_timeout', 'fetch_failed', 'worktree_refreshing']);

export async function runTick(s: Session, tick: TickPlan, mode: 'tick' | 'resume', onPaused?: () => void): Promise<Record<string, unknown>> {
  const sourceId = s.ids[tick.source];
  if (mode === 'resume') return s.g.refresh.refreshWorktree(s.engine, sourceId, { resume: true });
  let paused = false;
  const hooks = tick.boundary === 'none' ? undefined : {
    boundary: async (point: string) => {
      if (point !== tick.boundary || paused) return;
      paused = true;
      s.log({ ev: 'tick_paused', tick: tick.index, point, pause_ms: tick.pause_ms });
      onPaused?.();
      if (tick.crash) await new Promise(() => undefined);
      await sleep(tick.pause_ms);
    },
  };
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await s.g.refresh.refreshWorktree(s.engine, sourceId, { hooks });
      return { ...result, attempts: attempt, paused };
    } catch (error) {
      const code = (error as { code?: string })?.code ?? '';
      if (attempt >= PARAMS.tick_attempts || !TICK_RETRY_CODES.has(code)) throw Object.assign(error as object, { attempts: attempt, paused });
      s.log({ ev: 'tick_retry', tick: tick.index, attempt, code });
      await sleep(PARAMS.tick_retry_ms);
    }
  }
}

/**
 * After the load stops, refresh every source until it reaches its upstream: a checkout that never converges once writes
 * have stopped is a hang. Each source gets PARAMS.converge_attempts plain refreshes, PARAMS.tick_retry_ms apart.
 */
export async function runConverge(s: Session): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  let consented = false;
  for (const source of ['alpha', 'beta'] as const) {
    for (let attempt = 1; ; attempt++) {
      try {
        const result = await s.g.refresh.refreshWorktree(s.engine, s.ids[source], {});
        out[source] = { ok: true, status: (result as { status?: string }).status ?? null, attempts: attempt, consented_publish: consented };
        break;
      } catch (error) {
        const code = (error as { code?: string })?.code ?? '';
        // gbrain asks the user before it publishes a diverged checkout's local commits. When the divergence holds the
        // cron's plain-git commit (synced, never pushed, while the remote moved), the harness gives gbrain's standing consent
        // (sources.refresh_publish_diverged) once, as a user answering that prompt would. Divergence made only of gbrain's
        // own commits gets no consent, so a publication fault still shows as no_converge and unpublished.
        if (code === 'refresh_diverged' && !consented && /^cron FCM/m.test(git(s.paths.root, 'log', '--format=%s', 'origin/main..HEAD'))) {
          await s.engine.executeRaw(`INSERT INTO config(key,value) VALUES ('sources.refresh_publish_diverged','true') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`);
          consented = true;
          s.log({ ev: 'publish_consent', source });
          continue;
        }
        if (attempt >= PARAMS.converge_attempts || !TICK_RETRY_CODES.has(code)) {
          out[source] = { ok: false, code, attempts: attempt, message: String((error as Error)?.message ?? error).slice(0, 300) };
          break;
        }
        await sleep(PARAMS.tick_retry_ms);
      }
    }
  }
  return { ok: Object.values(out).every(v => (v as { ok: boolean }).ok), sources: out };
}

/** Logs the refresh_barrier switch this process resolved, so analysis can check each process ran the arm it was given. */
export async function logSwitch(s: Session, role: string): Promise<void> {
  const switches = await s.g.switches.readWriteSwitches(s.g.switches.viewedEngine(s.engine));
  s.log({ ev: 'switch', role, refresh_barrier: switches.refresh_barrier === true });
}

/** A plain-git commit straight into the managed checkout (a cron that bypasses gbrain), then later a scheduled sync. */
export function foreignCommit(paths: BrainPaths, f: ForeignCommit): string {
  insertTopLine(paths.root, f.path, `Cron note ${f.marker}.`, () => notePage('Cron note', `Committed by a cron with plain git. ${f.marker}`));
  git(paths.root, 'add', '--', f.path); git(paths.root, 'commit', '-qm', `cron ${f.marker}`);
  return git(paths.root, 'rev-parse', 'HEAD');
}

export async function runSync(s: Session, source: 'alpha' | 'beta'): Promise<Record<string, unknown>> {
  for (let attempt = 1; ; attempt++) {
    try { return { ...await s.g.syncRun.performManagedSync(s.engine, { sourceId: s.ids[source], noPull: true, noEmbed: true }), attempts: attempt }; }
    catch (error) {
      const code = (error as { code?: string })?.code ?? '';
      if (attempt >= PARAMS.tick_attempts || !TICK_RETRY_CODES.has(code)) throw Object.assign(error as object, { attempts: attempt });
      s.log({ ev: 'sync_retry', attempt, code });
      await sleep(PARAMS.tick_retry_ms);
    }
  }
}
