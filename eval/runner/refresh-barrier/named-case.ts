/**
 * GBRA-108's named case for the refresh-barrier validation, run deterministically (GBRA-347's TLA+ finding 1 on #8705,
 * CommitsInAdmissionOrder): write A, a blind put to page P, is held for an import (a plain-git commit changed P's file); a
 * one-page managed sync slice imports P and yields before its checkpoint; write B to P follows; the rest of the sync stamps
 * the checkpoint and releases A. A may not land over B. The slice is the window GBRA-347's repro test uses.
 *
 *   bun eval/runner/refresh-barrier/named-case.ts --b put_update|remember_entity|put_blind --rep <n>
 *     --arm on|off --engine postgres|pglite --out <dir> --gbrain-root <copy> [--pg-admin <url> --template <db>] [--keep]
 *
 * Writes <out>/named/<engine>/<arm>/order-<b>-<rep>.json: verify.ts's records for A and B, with what the case observed.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { countedRunIn, git, gitHead, harnessDigest, insertTopLine, notePage } from './fixture.ts';
import { failureClasses } from './analyze.ts';
import { jsonlLogger, logSwitch, runWriter, sleep, type Session } from './runtime.ts';
import { B_KINDS, type Engine, type OpKind, type ScheduledOp, type TrialSchedule } from './schedule.ts';
import { checkCommonArgs, integerArg, openBrain, quiesce } from './trial.ts';
import { readEvents, verifyTrial } from './verify.ts';

export interface NamedArgs { b: OpKind; rep: number; arm: 'off' | 'on'; engine: Engine; out: string; gbrainRoot: string; pgAdmin?: string; template?: string; keep?: boolean }

export { B_KINDS };
export const NAMED = { page: 'people/alice-example', later_pages: 6, wait_ms: 180_000 };

const waitFor = async (pred: () => boolean, ms: number) => { const end = Date.now() + ms; while (!pred() && Date.now() < end) await sleep(100); return pred(); };

export async function runNamedCase(a: NamedArgs): Promise<Record<string, unknown>> {
  const name = `order-${a.b}-${a.rep}`;
  const dir = join(a.out, 'work', `named-${a.engine}-${a.arm}-${name}`);
  const { g, engine, paths, ids, dropDb } = await openBrain(a, dir, `n_${a.arm}_${a.rep}`);
  const log = jsonlLogger(join(dir, 'events-parent.jsonl'));
  const session = (tag: string): Session => ({ g, engine, ids, paths, log: jsonlLogger(join(dir, `events-${tag}.jsonl`)), stopped: () => false });
  await logSwitch(session('parent'), 'parent');
  const tag = `${900_000 + a.rep}n${a.b.replace(/[^a-z]/g, '').slice(0, 6)}`;
  const opA: ScheduledOp = { index: 0, at_ms: 0, kind: 'put_blind', source: 'alpha', slug: NAMED.page, marker: `RBM${tag}aq`, request_id: randomUUID() };
  const opB: ScheduledOp = { index: 0, at_ms: 0, kind: a.b, source: 'alpha', slug: NAMED.page, marker: `RBM${tag}bq`, request_id: randomUUID() };

  // Another process commits P's file (and pages that sort after it) with plain git; nothing imports it yet.
  const foreignMarker = `FCM${tag}q`;
  insertTopLine(paths.root, `alpha/${NAMED.page}.md`, `Cron note ${foreignMarker}.`, () => notePage('Cron note', foreignMarker));
  const later = Array.from({ length: NAMED.later_pages }, (_, i) => `alpha/people/zz-${tag}-${i}.md`);
  for (const p of later) { mkdirSync(join(paths.root, 'alpha/people'), { recursive: true }); writeFileSync(join(paths.root, p), notePage('Cron batch', `Batch page ${p}.`)); }
  git(paths.root, 'add', '--', `alpha/${NAMED.page}.md`, ...later); git(paths.root, 'commit', '-qm', `cron ${foreignMarker}`);

  const events = () => readEvents(dir);
  const responded = (op: ScheduledOp) => events().some(e => e.request_id === op.request_id && e.ev === 'response');
  const finished = (op: ScheduledOp) => events().some(e => e.request_id === op.request_id && (e.ev === 'final' || (e.ev === 'response' && (e.cls === 'committed' || e.cls === 'refused'))));
  const runA = runWriter(session('w0'), 0, [opA], Date.now());
  const observed: Record<string, unknown> = { a_responded: await waitFor(() => responded(opA), 15_000) };
  const heldRow = async () => (await engine.executeRaw('SELECT state, deferred_import_from FROM persistence_requests WHERE request_id=$1::uuid', [opA.request_id]))[0] ?? null;
  for (const end = Date.now() + 5_000; Date.now() < end; await sleep(100)) {
    const row = await heldRow();
    if (row?.deferred_import_from != null || ['committed', 'conflict', 'failed', 'cancelled'].includes(row?.state)) { observed.a_held = row?.deferred_import_from != null; observed.a_state_before_sync = row?.state; break; }
  }

  const sync = async (slice?: { maxPages: number; maxMs: number }) => {
    const started = Date.now();
    try {
      const r = await g.syncRun.performManagedSync(engine, { sourceId: ids.alpha, noPull: true, noEmbed: true }, slice);
      log({ ev: 'sync_result', status: (r as { status?: string }).status ?? null, slice: Boolean(slice), ms: Date.now() - started });
      return (r as { status?: string }).status ?? null;
    } catch (error) {
      log({ ev: 'child_error', role: 'sync', code: (error as { code?: string })?.code ?? null, message: String((error as Error)?.message ?? error).slice(0, 400) });
      return `error:${(error as { code?: string })?.code ?? 'unknown'}`;
    }
  };
  observed.slice_status = await sync({ maxPages: 1, maxMs: 60_000 });
  const page = (await engine.executeRaw('SELECT compiled_truth FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [ids.alpha, NAMED.page]))[0];
  observed.p_imported_before_b = String(page?.compiled_truth ?? '').includes(foreignMarker);
  const headNow = git(paths.root, 'rev-parse', 'HEAD');
  const checkpoint = (await engine.executeRaw('SELECT last_commit FROM sources WHERE id=$1', [ids.alpha]))[0]?.last_commit ?? null;
  observed.checkpoint_pending_at_b = checkpoint !== headNow;
  const runB = runWriter(session('w1'), 1, [opB], Date.now());
  observed.b_finished_before_checkpoint = await waitFor(() => finished(opB), 10_000);
  for (let i = 0; i < 20; i++) { const st = await sync(); observed.final_sync_status = st; if (st !== 'partial') break; }
  observed.window_hit = observed.a_held === true && observed.p_imported_before_b === true && observed.checkpoint_pending_at_b === true;
  const done = await Promise.race([Promise.all([runA, runB]).then(() => 'done' as const), sleep(NAMED.wait_ms).then(() => 'deadline' as const)]);
  const flags: Record<string, unknown> = { writers_done: done === 'done', quiesce: await quiesce(engine) };
  const schedule: TrialSchedule = { version: 0, seed: a.rep, engine: a.engine, writers: [{ index: 0, ops: [opA], kill_after_op: null }, { index: 1, ops: [opB], kill_after_op: null }],
    ticks: [], foreign: [], max_wait_ms: null, ops_window_ms: 0,
    strata: { foreign: true, import_sequence: true, crash: false, writer_kill: false, expiry: false } };
  const verdict = await verifyTrial(engine, schedule, paths, ids, dir);
  const deadlocks = a.engine === 'postgres' ? Number((await engine.executeRaw('SELECT deadlocks::int AS n FROM pg_stat_database WHERE datname=current_database()'))[0]?.n ?? 0) : 0;
  const result = { case: 'order', b: a.b, rep: a.rep, arm: a.arm, engine: a.engine, provenance: { gbrain_sha: gitHead(a.gbrainRoot), harness_digest: harnessDigest() },
    observed, flags: { ...flags, deadlocks },
    switches: events().filter(e => e.ev === 'switch').map(e => ({ role: e.role, refresh_barrier: e.refresh_barrier })),
    child_errors: events().filter(e => e.ev === 'child_error').map(e => ({ role: e.role, code: e.code, message: String(e.message ?? '').slice(0, 300) })), ledger_present: verdict.ledger_present, ops: verdict.ops };
  if (a.engine === 'postgres') { await engine.disconnect(); if (!a.keep) await dropDb?.(); }
  else { await g.service.disposePersistenceConsumer(engine); await engine.disconnect(); }
  return result;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const get = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const example = 'bun eval/runner/refresh-barrier/named-case.ts --b put_update --rep 101 --arm on --engine postgres --out <dir> --gbrain-root <G> --pg-admin <url> --template <db>';
  const c = checkCommonArgs('named-case', argv, example);
  const b = get('--b');
  if (!B_KINDS.includes(b as typeof B_KINDS[number])) { process.stderr.write(`named-case: --b must be one of ${B_KINDS.join(', ')} (got ${JSON.stringify(b ?? null)})\nexample: ${example}\n`); process.exit(2); }
  const a: NamedArgs = { b: b as OpKind, rep: integerArg('named-case', '--rep', get('--rep'), example), arm: c.arm, engine: c.engine, out: c.out, gbrainRoot: c.gbrainRoot,
    pgAdmin: get('--pg-admin'), template: get('--template'), keep: argv.includes('--keep') };
  const outDir = join(a.out, 'named', a.engine, a.arm);
  const resultPath = join(outDir, `order-${a.b}-${a.rep}.json`);
  if (argv.includes('--replace') && countedRunIn(a.out)) {
    process.stderr.write(`named-case: --replace refuses inside ${a.out}, which holds a counted run; replay into another --out\n`);
    process.exit(2);
  }
  if (existsSync(resultPath) && !argv.includes('--replace')) {
    process.stderr.write(`named-case: ${resultPath} already holds a result, which a replay must not overwrite; use another --out (or --replace in a development directory)\n`);
    process.exit(2);
  }
  const result = await runNamedCase(a);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resultPath, JSON.stringify(result), { flag: argv.includes('--replace') ? 'w' : 'wx' });
  if (!a.keep && failureClasses(result, 'named').length === 0) rmSync(join(a.out, 'work', `named-${a.engine}-${a.arm}-order-${a.b}-${a.rep}`), { recursive: true, force: true });
  process.exit(0);
}
