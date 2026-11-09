/**
 * The nightly system smokes (suite `system-smokes` in eval/data/nightly/devset-v1.json): keyless checks on a seeded
 * synthetic brain of the surfaces that need a cross-version upgrade, a seeded brain or a real Postgres version. Each
 * smoke is one deterministic pass or fail; a failing one names the refusal code or count that failed.
 *
 *   bun eval/runner/nightly/smokes/index.ts --tonight <root|checkout@ref> --previous <root|checkout@ref> --old <root|checkout@ref>
 *     --out <dir> [--pg <admin url>] [--pg15 <admin url>] [--only id,id] [--repeat n]
 *
 * A root is a gbrain directory with src/cli.ts (a verified overlay); `checkout@ref` builds and verifies a copied overlay
 * with lifecycle/builds.ts first. Results go to <out>/results.jsonl, one row per smoke and repeat. Provider keys are
 * removed from this process before anything starts, and every gbrain process runs with harness.ts's keyless allowlist.
 */
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { OVERLAY_ROOT } from '../../gbrain-under-test.ts';
import { assertBuildVerified, prepareBuild } from '../../lifecycle/builds.ts';
import { PROVIDER_KEYS, SmokeFail, rootVersion, smokeContext, type SmokeContext, type SmokeOptions, type SmokeResult } from './harness.ts';
import { ingestRetryAcrossUpgrade } from './ingest-retry-across-upgrade.ts';
import { queryContract } from './query-contract.ts';
import { upgradeFromPrevious } from './upgrade-from-previous.ts';

export type { SmokeOptions, SmokeResult } from './harness.ts';

type Smoke = (ctx: SmokeContext) => Promise<string>;

const REGISTRY: Array<[string, Smoke]> = [
  ['upgrade-from-previous', upgradeFromPrevious],
  ['ingest-retry-across-upgrade', ingestRetryAcrossUpgrade],
  ['query-contract', queryContract],
];

export const SMOKES: readonly string[] = REGISTRY.map(([id]) => id);

/** Longest a smoke may run before it counts as a hang. */
export const SMOKE_TIMEOUT_MS = 20 * 60_000;

/** Runs the smokes (all, or `only`) one after another and returns one result per smoke, in SMOKES order. */
export async function runSmokes(opts: SmokeOptions & { only?: readonly string[] }): Promise<SmokeResult[]> {
  for (const k of Object.keys(process.env)) if (PROVIDER_KEYS.test(k)) delete process.env[k];
  const unknown = (opts.only ?? []).filter(id => !SMOKES.includes(id));
  if (unknown.length) throw new Error(`unknown smoke ${unknown.join(', ')}; known: ${SMOKES.join(', ')}`);
  const results: SmokeResult[] = [];
  for (const [id, smoke] of REGISTRY) {
    if (opts.only && !opts.only.includes(id)) continue;
    const ctx = smokeContext(opts, id);
    const t0 = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new SmokeFail('smoke_timeout', `no verdict after ${SMOKE_TIMEOUT_MS / 60_000} minutes`)), SMOKE_TIMEOUT_MS); });
    let result: SmokeResult;
    try {
      const detail = await Promise.race([smoke(ctx), timeout]);
      result = { id, pass: true, code: 'ok', detail, ms: Date.now() - t0 };
    } catch (error) {
      const known = error instanceof SmokeFail;
      result = { id, pass: false, code: known ? error.code : 'harness_error', detail: known ? error.detail : String((error as Error)?.stack ?? error).slice(0, 2000), ms: Date.now() - t0 };
    } finally { clearTimeout(timer); }
    ctx.log(`verdict: ${JSON.stringify(result)}`);
    results.push(result);
  }
  return results;
}

/** A root directory as given, or a copied, verified overlay for `checkout@ref`. */
function resolveRoot(spec: string): string {
  const at = spec.lastIndexOf('@');
  if (at > 0 && existsSync(join(spec.slice(0, at), '.git'))) {
    const checkout = resolve(spec.slice(0, at)), ref = spec.slice(at + 1);
    const build = prepareBuild(checkout, { label: `smoke-${ref.replace(/[^A-Za-z0-9._-]+/g, '_')}`, ref, description: `nightly smoke build of ${ref}` }, OVERLAY_ROOT);
    assertBuildVerified(build);
    return build.dir;
  }
  if (!existsSync(join(spec, 'src/cli.ts'))) throw new Error(`${spec} is neither a gbrain root (src/cli.ts) nor <checkout>@<ref>`);
  return resolve(spec);
}

if (import.meta.main) {
  for (const k of Object.keys(process.env)) if (PROVIDER_KEYS.test(k)) delete process.env[k];
  const argv = process.argv.slice(2);
  const get = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const need = (k: string) => get(k) ?? (console.error(`missing ${k}`), process.exit(2));
  const out = resolve(need('--out'));
  mkdirSync(out, { recursive: true });
  const opts: SmokeOptions & { only?: string[] } = {
    tonightRoot: resolveRoot(need('--tonight')), previousRoot: resolveRoot(need('--previous')), oldRoot: resolveRoot(need('--old')), out,
    postgres: { current: get('--pg'), pg15: get('--pg15') }, only: get('--only')?.split(','),
  };
  console.log(`tonight ${rootVersion(opts.tonightRoot)}, previous ${rootVersion(opts.previousRoot)}, old ${rootVersion(opts.oldRoot)}`);
  let failed = 0;
  const repeats = Number(get('--repeat') ?? 1);
  for (let rep = 1; rep <= repeats; rep++) {
    for (const r of await runSmokes({ ...opts, out: repeats > 1 ? join(out, `rep-${rep}`) : out })) {
      appendFileSync(join(out, 'results.jsonl'), JSON.stringify({ rep, tonight: rootVersion(opts.tonightRoot), previous: rootVersion(opts.previousRoot), old: rootVersion(opts.oldRoot), ...r }) + '\n');
      console.log(`${rep}\t${r.pass ? 'PASS' : 'FAIL'}\t${r.id}\t${r.code}\t${Math.round(r.ms / 1000)}s\t${r.detail.split('\n')[0]!.slice(0, 200)}`);
      if (!r.pass) failed++;
    }
  }
  process.exit(failed ? 1 : 0);
}
