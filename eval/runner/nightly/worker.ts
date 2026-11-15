/**
 * Child processes the nightly runner starts (adapters.ts) for work that changes process-wide state.
 *
 *   bun eval/runner/nightly/worker.ts agents --suite <id> --arm on|off --tasks 1001,1002 --k 3 --model <provider:id>|fake
 *     --gbrain-root <checkout> --out <dir> [--budget-run-id <id> --budget-ledger <path>]
 *   bun eval/runner/nightly/worker.ts smokes --tonight <root> [--previous <root>] [--old <root>] --out <dir> --result <file>
 *     [--pg <url>] [--pg15 <url>]
 *   bun eval/runner/nightly/worker.ts pg-template --gbrain-root <root> --pg-admin <url> --name <database>
 *
 * agents runs Part C episodes (refresh-barrier/agent.ts runEpisode) one at a time, since a brain's arm, home and keys are
 * process-wide, and scores each with the nightly write scorer (write-score.ts) from the brain as the episode left it. Each
 * episode is written as task-<id>-t<trial>.json; an existing one is kept unless it recorded a harness or provider failure,
 * so a resumed night reruns only those. A model's fetch is built once from its key, the key is removed from the
 * environment before the first brain opens, and the paid-request guard of the night's ledger run (joined with
 * --budget-run-id) meters every call. The records are marked smoke, so nothing mistakes them for counted Part C episodes.
 * Exit 3 is a cap stop.
 *
 * smokes imports eval/runner/nightly/smokes/index.ts and writes runSmokes' results to --result; exit 4 when that module
 * is not in the checkout.
 *
 * pg-template recreates <database> on the admin server and runs the root's own PostgresEngine.initSchema() on it, so the
 * Postgres trials clone brains with tonight's schema.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { budgetOptionsFrom, startPaidRun } from '../budget-ledger.ts';
import { ERRORED_STOPS, generateTask, keyedFetch, runEpisode, type EpisodeOptions } from '../refresh-barrier/agent.ts';
import { isCapStop } from '../refresh-barrier/ledger.ts';
import { PROVIDER_KEY_ENV, stripKeys } from './keyless.ts';
import { inspectWrites, scoreWrites, type Inspected } from './write-score.ts';

const argv = process.argv.slice(3);
const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const need = (name: string) => flag(name) ?? (() => { throw new Error(`${name} is required`); })();

/** Whether an existing episode file holds a finished episode (not a harness or provider failure). */
function episodeDone(path: string): boolean {
  if (!existsSync(path)) return false;
  const rec = JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
  return !rec.harness_error && !ERRORED_STOPS.has(rec.loop?.stop);
}

async function agents(): Promise<number> {
  const suite = need('--suite'), arm = need('--arm'), model = need('--model'), out = resolve(need('--out')), gbrainRoot = resolve(need('--gbrain-root'));
  if (arm !== 'on' && arm !== 'off') throw new Error('--arm must be on or off');
  const tasks = need('--tasks').split(',').map(Number), k = Number(flag('--k') ?? 1);
  let providerFetch: typeof fetch | undefined, paid: ReturnType<typeof startPaidRun> | null = null, budget: EpisodeOptions['budget'] = null;
  if (model !== 'fake') {
    const prov = model.slice(0, model.indexOf(':'));
    if (prov !== 'anthropic' && prov !== 'openai') throw new Error(`Part C's loop runs anthropic and openai models; got ${model}`);
    const key = process.env[PROVIDER_KEY_ENV[prov]];
    if (!key) throw new Error(`${PROVIDER_KEY_ENV[prov]} is not set`);
    if (!flag('--budget-run-id') || !flag('--budget-ledger')) throw new Error('a paid episode joins the night\'s ledger run: pass --budget-run-id and --budget-ledger');
    providerFetch = keyedFetch(prov, key);
    paid = startPaidRun(`nightly:${suite}`, { ...budgetOptionsFrom(argv), estimateUsd: null });
    budget = { runner: `nightly:${suite}`, cap_usd: paid.run.budgetUsd, run_id: paid.run.runId };
  }
  stripKeys();
  mkdirSync(out, { recursive: true });
  try {
    for (const id of tasks) {
      for (let trial = 1; trial <= k; trial++) {
        const path = join(out, `task-${id}-t${trial}.json`);
        if (episodeDone(path)) continue;
        let record: Record<string, any>;
        try {
          record = await runEpisode(generateTask(id), { arm, gbrainRoot, out, model, smoke: true, providerFetch, budget, attempt: trial, inspect: inspectWrites });
          const seen = record.inspect as Inspected;
          record.nightly_score = scoreWrites({ task: generateTask(id), seen, report: record.report, reissues: record.behavior.reissues, writeCalls: record.write_calls });
        } catch (error) {
          if (isCapStop(error)) {
            writeFileSync(join(out, 'cap-stop.json'), JSON.stringify({ at: new Date().toISOString(), task: id, trial, message: (error as Error).message }));
            console.error(`cap stop: ${(error as Error).message}`);
            return 3;
          }
          record = { task: id, attempt: trial, harness_error: String((error as Error).stack ?? error).slice(0, 2_000) };
        }
        writeFileSync(path, JSON.stringify(record));
        console.log(`task ${id} trial ${trial}: ${record.harness_error ? 'harness error' : `pass=${record.nightly_score.pass} stop=${record.loop.stop}`}`);
      }
    }
    return 0;
  } finally {
    if (paid) { paid.guard.uninstall(); paid.run.close(); }
  }
}

async function smokes(): Promise<number> {
  const index = join(import.meta.dir, 'smokes', 'index.ts');
  if (!existsSync(index)) { console.error('the system smokes are not built: eval/runner/nightly/smokes/index.ts is missing'); return 4; }
  const { runSmokes } = await import(index) as { runSmokes: (o: Record<string, unknown>) => Promise<unknown[]> };
  const results = await runSmokes({ tonightRoot: resolve(need('--tonight')), previousRoot: flag('--previous') ? resolve(flag('--previous')!) : null, oldRoot: flag('--old') ? resolve(flag('--old')!) : null,
    out: resolve(need('--out')), postgres: { current: flag('--pg'), pg15: flag('--pg15') } });
  writeFileSync(need('--result'), JSON.stringify(results, null, 1));
  return 0;
}

async function pgTemplate(): Promise<number> {
  const root = resolve(need('--gbrain-root')), admin = need('--pg-admin'), name = need('--name');
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`--name must be a plain database name (got ${name})`);
  const pg = (await import(join(root, 'vendor/postgres/src/index.js'))).default;
  const sql = pg(admin, { max: 1, prepare: false, onnotice: () => undefined });
  try {
    await sql.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await sql.unsafe(`CREATE DATABASE ${name}`);
  } finally { await sql.end(); }
  const url = new URL(admin); url.pathname = `/${name}`;
  const { PostgresEngine } = await import(join(root, 'src/core/postgres-engine.ts'));
  const engine = new PostgresEngine();
  await engine.connect({ database_url: url.toString(), poolSize: 1 });
  try { await engine.initSchema(); } finally { await engine.disconnect(); }
  return 0;
}

if (import.meta.main) {
  const job = process.argv[2];
  try {
    process.exit(job === 'agents' ? await agents() : job === 'smokes' ? await smokes() : job === 'pg-template' ? await pgTemplate()
      : (console.error('usage: worker.ts agents|smokes|pg-template ...'), 2));
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}
