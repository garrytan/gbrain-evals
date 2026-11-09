/**
 * Child-process entry points of a multi-process refresh-barrier trial (Postgres). Each role is a separate OS process,
 * like production: every agent's `gbrain serve` session is a resident process with its own persistence consumer, and every
 * refresh tick or scheduled sync is a one-shot cron command.
 *
 *   bun eval/runner/refresh-barrier/child.ts writer <index>
 *   bun eval/runner/refresh-barrier/child.ts tick <index> tick|resume
 *   bun eval/runner/refresh-barrier/child.ts sync <alpha|beta>
 *   bun eval/runner/refresh-barrier/child.ts converge
 *
 * The trial directory (RB_DIR) holds schedule.json and brain.json; RB_GBRAIN_ROOT names the gbrain copy under test and
 * RB_DB_URL the trial's database. Events go to RB_DIR/events-<role>.jsonl.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadGbrain, type BrainIds, type BrainPaths } from './fixture.ts';
import { jsonlLogger, logSwitch, runConverge, runSync, runTick, runWriter, sleep, type Session } from './runtime.ts';
import { PROVIDER_KEYS } from './fixture.ts';
import type { TrialSchedule } from './schedule.ts';

const [role, arg, mode] = process.argv.slice(2);
const dir = process.env.RB_DIR!;
const leaked = Object.keys(process.env).filter(k => PROVIDER_KEYS.test(k));
if (leaked.length) { writeFileSync(join(dir, `env-leak-${process.pid}.json`), JSON.stringify(leaked)); process.exit(3); }
const schedule = JSON.parse(readFileSync(join(dir, 'schedule.json'), 'utf8')) as TrialSchedule;
const brain = JSON.parse(readFileSync(join(dir, 'brain.json'), 'utf8')) as { paths: BrainPaths; ids: BrainIds };
const g = await loadGbrain(process.env.RB_GBRAIN_ROOT!);
g.switches.resetWriteSwitches();
const { PostgresEngine } = await import(join(process.env.RB_GBRAIN_ROOT!, 'src/core/postgres-engine.ts'));
const engine = new PostgresEngine();
await engine.connect({ database_url: process.env.RB_DB_URL!, poolSize: Number(process.env.RB_POOL ?? 3) });
const tag = role === 'writer' ? `w${arg}` : role === 'tick' ? `tick${arg}-${mode}` : role === 'converge' ? 'converge' : `sync-${arg}`;
const log = jsonlLogger(join(dir, `events-${tag}.jsonl`));
const stopFile = join(dir, 'stop');
const session: Session = { g, engine, ids: brain.ids, paths: brain.paths, log, stopped: () => existsSync(stopFile) };
await logSwitch(session, tag);

async function finish(code: number): Promise<never> {
  await g.service.disposePersistenceConsumer(engine).catch((error: unknown) => log({ ev: 'dispose_error', message: String(error) }));
  await engine.disconnect().catch(() => undefined);
  process.exit(code);
}

try {
  if (role === 'writer') {
    const plan = schedule.writers[Number(arg)]!;
    g.service.startPersistenceConsumer(engine, { engine: engine.kind });
    // The parent sets t0 once every writer has loaded gbrain and connected (t0.json), so cold starts do not shift the schedule.
    writeFileSync(join(dir, `${tag}.ready`), '');
    while (!existsSync(join(dir, 't0.json'))) await sleep(50);
    const t0 = JSON.parse(readFileSync(join(dir, 't0.json'), 'utf8')).t0 as number;
    await runWriter(session, plan.index, plan.ops, t0, opIndex => {
      if (plan.kill_after_op === opIndex) { log({ ev: 'writer_killed', writer: plan.index, after_op: opIndex }); process.kill(process.pid, 'SIGKILL'); }
      if (opIndex === plan.ops[plan.ops.length - 1]!.index) writeFileSync(join(dir, `${tag}.ops-done`), '');
    });
    log({ ev: 'writer_polls_done', writer: plan.index });
    while (!existsSync(stopFile)) await sleep(250);
    await finish(0);
  } else if (role === 'tick') {
    const tick = schedule.ticks[Number(arg)]!;
    const started = Date.now();
    const result = await runTick(session, tick, mode === 'resume' ? 'resume' : 'tick', () => {
      if (tick.crash && mode !== 'resume') setTimeout(() => { log({ ev: 'tick_killed', tick: tick.index }); process.kill(process.pid, 'SIGKILL'); }, tick.pause_ms);
    });
    log({ ev: 'tick_result', tick: tick.index, mode, status: result.status ?? null, ms: Date.now() - started, attempts: (result as any).attempts ?? 1, paused: (result as any).paused ?? false });
    await finish(0);
  } else if (role === 'sync') {
    const started = Date.now();
    const result = await runSync(session, arg as 'alpha' | 'beta');
    log({ ev: 'sync_result', source: arg, status: (result as any).status ?? null, ms: Date.now() - started });
    await finish(0);
  } else if (role === 'converge') {
    const started = Date.now();
    const result = await runConverge(session);
    log({ ev: 'converge_result', ...result, ms: Date.now() - started });
    await finish(0);
  } else {
    throw new Error(`unknown role ${role}`);
  }
} catch (error) {
  const e = error as { code?: string; message?: string };
  log({ ev: 'child_error', role, arg, mode, code: e?.code ?? null, attempts: (e as any)?.attempts ?? null, paused: (e as any)?.paused ?? null, message: String(e?.message ?? error).slice(0, 800) });
  await finish(role === 'writer' ? 2 : 0);
}
