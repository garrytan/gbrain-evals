/**
 * One writer process of the multi-writer behavior suite (eval/runner/multi-writer-behavior.ts).
 *
 *   bun eval/runner/multi-writer/worker.ts <plan.json>
 *
 * The plan names the gbrain under test (its root), the engine and store, and one or more lanes of operations. Every lane
 * runs its operations one after another; all lanes run at the same time, so one worker with several lanes is several
 * in-process writers on one engine, and several workers with one lane each are writers in separate processes.
 *
 * mode "engine" opens the brain once through gbrain's own engine factory (eval-engine.ts openEvalEngine, no schema
 * work) and dispatches each operation through gbrain's MCP dispatcher as a trusted local caller. mode "cli" runs each
 * operation as its own `gbrain call <op> <json>` process, the way an operator or a cron job writes.
 *
 * The worker talks JSON lines on stdout: one `ready` line (with the engine's own multi-user answer when `probe` is set),
 * then, after the parent writes `go` on stdin, one `op` line per operation as it finishes, and one `done` line. It
 * exits when stdin closes after `done`, or at once with `hold` lanes when the parent kills it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openEvalEngine, type EvalEngineKind } from '../eval-engine.ts';
import type { GbrainUnderTest } from '../gbrain-under-test.ts';

export interface WorkerOp {
  op: string;
  params: Record<string, unknown>;
  /** Free-form label the parent uses to find this operation's result. */
  tag: string;
}

export interface WorkerPlan {
  root: string;
  version: string;
  kind: EvalEngineKind;
  databasePath?: string;
  databaseUrl?: string;
  mode: 'engine' | 'cli';
  lanes: WorkerOp[][];
  /** Report the running engine's own multi-user answer in the ready line (engine mode only). */
  probe?: boolean;
  /** Stay open after the lanes finish until stdin closes or the parent kills the process (a store owner to take over from). */
  hold?: boolean;
  /** Wait for `go` on stdin before the first operation. Defaults to true. */
  barrier?: boolean;
  cliTimeoutMs?: number;
}

export interface OpLine {
  kind: 'op';
  lane: number;
  i: number;
  op: string;
  tag: string;
  ok: boolean;
  /** Epoch milliseconds when the call started and ended, from this process's clock. */
  t0: number;
  t1: number;
  ms: number;
  code?: string;
  message?: string;
  result?: unknown;
  /** The failure text names a multi-user lease or fence refusal (the Rust write-lock acquisition bug class). */
  lease_fence?: boolean;
  /** The write_pending receipt's request id, so the parent can poll whether the write ever commits. */
  request_id?: string;
  /** For a careful (compare-and-set) put: the revision it read, the revision its write produced, and the put's own time. */
  cas?: { base: string; revision: string | null; put_ms: number };
  /** Set by the parent when this write answered write_pending and its receipt later showed it committed. */
  settled_from_pending?: boolean;
}

/** A pseudo-operation: get_page, then put_page with expected_revision set to the revision just read. */
export const CAS_PUT = 'cas_put_page';

export const LEASE_FENCE_RE = /no longer fences|fence_missing|lease_lost|epoch_moved|claim_epoch_mismatch|write[- ]lock/i;

/** gbrain's typed error code in a tool result text or a CLI error envelope, if any. */
export function errorCodeOf(text: string): string | undefined {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const pick = (o: Record<string, unknown> | undefined): string | undefined => {
      if (!o) return undefined;
      for (const k of ['canonical', 'code', 'error']) if (typeof o[k] === 'string' && /^[a-z][a-z0-9_]+$/.test(o[k] as string)) return o[k] as string;
      return undefined;
    };
    return pick(j) ?? pick(j.error as Record<string, unknown> | undefined);
  } catch {
    return /"(?:canonical|code)"\s*:\s*"([a-z][a-z0-9_]+)"/.exec(text)?.[1] ?? /\b([a-z]+(?:_[a-z]+)+)\b/.exec(text)?.[1];
  }
}

function parseMaybe(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

const now = () => performance.timeOrigin + performance.now();
const emit = (line: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(line)}\n`);

async function waitForGo(): Promise<void> {
  const reader = Bun.stdin.stream().getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += new TextDecoder().decode(value);
    if (buf.includes('go')) { reader.releaseLock(); return; }
  }
}

/** The running engine's own multi-user answer: the store's open info and the session behaviour only a multi-user store has. */
async function probeEngine(plan: WorkerPlan, engine: unknown): Promise<Record<string, unknown>> {
  if (plan.kind !== 'rust') return { applies: false };
  const e = engine as { ownerRole?: unknown; openStoreIfOpen?: (m: string) => { multiuser?: unknown } | null };
  const role = e.ownerRole ?? null;
  let store: { multiuser?: unknown } | null = null;
  try { store = typeof e.openStoreIfOpen === 'function' ? e.openStoreIfOpen('multi_writer_probe') : null; } catch (err) { return { applies: true, role, store_error: String((err as Error)?.message ?? err).slice(0, 300) }; }
  const out: Record<string, unknown> = { applies: true, role, store_open: store !== null, store_multiuser: store ? store.multiuser === true : null };
  if (store) {
    try {
      const { openPrincipalSession } = await import(join(plan.root, 'src/core/rust-engine/principal-session.ts')) as { openPrincipalSession: (s: unknown, t: string) => Promise<unknown> };
      try {
        await openPrincipalSession(store, 'gbrain_at_multi_writer_probe_not_a_token');
        out.session_probe = 'opened';
      } catch (err) {
        const x = err as { code?: unknown; details?: unknown; detail?: unknown; message?: unknown };
        const detail = JSON.stringify(x.details ?? x.detail ?? null);
        out.session_probe = /multiuser_off/.test(detail + String(x.message)) ? 'refused_multiuser_off' : /reason=mint|reason=revalidate/.test(detail + String(x.message)) ? 'reached_store_mint' : `refused_${String(x.code ?? 'unknown')}`;
        out.session_probe_detail = detail.slice(0, 200);
      }
    } catch {
      out.session_probe = 'unavailable_in_build';
    }
  }
  return out;
}

async function main(): Promise<void> {
  const plan = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as WorkerPlan;
  const gut: GbrainUnderTest = { root: plan.root, version: plan.version, overlay: null };
  let call: (op: string, params: Record<string, unknown>) => Promise<{ ok: boolean; text: string; code?: string }>;
  let engine: { disconnect?: () => Promise<void> } | null = null;
  let ready: Record<string, unknown> = { kind: 'ready', pid: process.pid, mode: plan.mode };
  if (plan.mode === 'engine') {
    let opened;
    try {
      opened = await openEvalEngine({ gut, kind: plan.kind, databasePath: plan.databasePath, databaseUrl: plan.databaseUrl, initSchema: false });
    } catch (err) {
      const x = err as { code?: unknown; reason?: unknown; message?: unknown };
      emit({ kind: 'fatal', stage: 'open', code: String(x.code ?? x.reason ?? 'open_failed'), message: String(x.message ?? err).slice(0, 600) });
      process.exit(2);
    }
    engine = opened.engine as unknown as { disconnect?: () => Promise<void> };
    const { dispatchToolCall } = await import(join(plan.root, 'src/mcp/dispatch.ts')) as { dispatchToolCall: (e: unknown, n: string, p: unknown, o: unknown) => Promise<{ content?: Array<{ text?: string }>; isError?: boolean }> };
    call = async (op, params) => {
      try {
        const r = await dispatchToolCall(opened.engine, op, params, { remote: false });
        const text = (r.content ?? []).map(c => c.text ?? '').join('\n');
        return r.isError ? { ok: false, text, code: errorCodeOf(text) ?? 'error' } : { ok: true, text };
      } catch (err) {
        const x = err as { code?: unknown; canonical?: unknown; message?: unknown };
        return { ok: false, text: String(x.message ?? err), code: String(x.canonical ?? x.code ?? 'exception') };
      }
    };
    if (plan.probe) ready = { ...ready, probe: await probeEngine(plan, opened.engine) };
  } else {
    const cli = join(plan.root, 'src/cli.ts');
    call = async (op, params) => {
      const p = Bun.spawn([process.execPath, cli, 'call', op, JSON.stringify(params)], { env: process.env, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
      const timer = setTimeout(() => p.kill('SIGKILL'), plan.cliTimeoutMs ?? 120_000);
      const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      clearTimeout(timer);
      if (code === 0) return { ok: true, text: stdout.trim() };
      const text = `${stdout.trim()}\n${stderr.trim()}`.trim();
      return { ok: false, text, code: errorCodeOf(stdout.trim()) ?? errorCodeOf(stderr.trim()) ?? `exit_${code}` };
    };
  }
  emit(ready);
  if (plan.barrier !== false) await waitForGo();
  await Promise.all(plan.lanes.map(async (lane, li) => {
    for (const [i, o] of lane.entries()) {
      const t0 = now();
      let r: { ok: boolean; text: string; code?: string };
      let cas: OpLine['cas'];
      if (o.op === CAS_PUT) {
        // A careful writer: read the page's revision, then write with expected_revision, so a lost race is a typed conflict.
        const g = await call('get_page', { slug: o.params.slug });
        const base = g.ok ? String((parseMaybe(g.text) as Record<string, unknown>)?.knowledge_revision ?? '') : '';
        const p0 = now();
        r = g.ok ? await call('put_page', { ...o.params, expected_revision: base }) : g;
        const res = r.ok ? parseMaybe(r.text) as Record<string, unknown> : null;
        cas = { base, revision: res ? String(res.revision ?? '') : null, put_ms: Number((now() - p0).toFixed(3)) };
      } else r = await call(o.op, o.params);
      const t1 = now();
      const line: OpLine = { kind: 'op', lane: li, i, op: o.op, tag: o.tag, ok: r.ok, t0, t1, ms: Number((t1 - t0).toFixed(3)), ...(cas ? { cas } : {}) };
      if (r.ok) line.result = parseMaybe(r.text);
      else {
        line.code = r.code;
        line.message = r.text.replace(/\s+/g, ' ').slice(0, 800);
        if (LEASE_FENCE_RE.test(r.text)) line.lease_fence = true;
        const rid = /request[_ ]id"?:?\s*"?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(r.text)?.[1];
        if (rid) line.request_id = rid;
      }
      emit(line as unknown as Record<string, unknown>);
    }
  }));
  emit({ kind: 'done', pid: process.pid });
  if (plan.hold) await new Promise<void>(() => {});
  await engine?.disconnect?.().catch(() => {});
  process.exit(0);
}

if (import.meta.main) await main();
