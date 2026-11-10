/**
 * The nightly gbrain check: one gbrain ref per invocation, the dev set's suites for a tier, outcome rows appended to
 * <night dir>/outcomes.jsonl as each suite finishes, then the report (report.ts).
 *
 *   bun eval/runner/nightly/run.ts --ref master|stable|<sha> --tier nightly|matrix|smoke --out <dir> [--night YYYY-MM-DD]
 *     [--suites a,b] [--items x,y] [--readers m1,m2] [--k N] [--gbrain-clone <path>] [--devset <file>] [--cache <dir>]
 *     [--fake | --paid --budget-ledger <path> (--budget-run-id <id> | --night-cap-usd <n> --month-cap-usd <n>)]
 *     [--pg-admin <url> [--pg-template <database>]] [--pg15-admin <url>] [--previous-ref <ref>] [--old-ref <ref>]
 *     [--cat40-slot-allowance-usd <n>]
 *   bun eval/runner/nightly/run.ts --resume <night dir>
 *   bun eval/runner/nightly/run.ts --ref <sha> --tier bisect --suites <id> --items a,b [--readers m] --gbrain-clone <path> --night-dir <dir>
 *
 * The ref resolves to a commit in the gbrain clone (stable is the pinned release commit), which is built into a verified
 * overlay (gbrain-under-test.ts); the refresh-barrier harness gets a Git worktree of the same commit, because it reads the
 * root's HEAD. A suite whose requires.gbrain_commit is not an ancestor of the commit is skipped, and the report says why.
 *
 * Tiers:
 *   nightly  tool-contract-replay, concurrent-writers, system-smokes, refresh-barrier-agents and refused-write-agents;
 *            agent suites on gpt-6.1-sol at k = 3
 *   matrix   every suite; claude-opus-5-5 and gpt-6.1-sol; k = 3 on agent suites, 1 on QA
 *   smoke    every item once on master with both readers
 *   bisect   one suite's firing items on one commit (bisect.ts calls it)
 * Keyless suites (replay, trials, smokes) never call a model and run without keys on every tier. Suites that call models
 * need --fake (every runner's own keyless path: Cat 40's scripted agents on keyword-only slots, Part C's fake provider,
 * memory-qa's fake system) or --paid with the night's ledger run, which run.ts opens itself from --night-cap-usd and
 * --month-cap-usd (ledger.ts) when no --budget-run-id is given.
 *
 * The Postgres trials clone their brains from --pg-template, or from a template the night builds with the commit's own
 * schema. The system smokes upgrade from the previous master night's commit (else --previous-ref, else the commit's first parent)
 * and from the old release (--old-ref, default the smokes' OLD_RELEASE).
 *
 * Suites run in parallel, each in its own child processes (adapters.ts). The night directory is <out>/<night>/<ref>
 * (the first 12 characters of a sha), holding night.json, outcomes.jsonl, each suite's work under suites/, and the report.
 * --resume reruns what is missing or recorded as a harness failure on the gbrain commit the night started on (its ref
 * may have moved since), after settling the stopped run's open ledger reservations (ledger.ts reconcile), at most twice
 * per night. A stop exits with a code and the line to resume:
 *   3 NIGHTLY_CAP_STOP  the night's ledger run or the 30-night cap is spent; paid suites stopped where they were
 *   4 NIGHTLY_VM_LOST   the runner was signalled (the machine is going away); running children were killed
 *   5 NIGHTLY_HARNESS   a suite failed to run or recorded harness or provider failures; its rows are counted apart
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { resolveGbrainUnderTest } from '../gbrain-under-test.ts';
import { PaidArmRefusal, requirePaidArm } from '../paid-arm.ts';
import { ADAPTERS, callsModels, type NightContext, type SuiteRun, type Tier, worktreeAt } from './adapters.ts';
import { loadDevSet, suiteDigest, type DevSet } from './devset.ts';
import { NightlyCache } from './judge-cache.ts';
import { NightlyCapStop, openNightRun, reconcileNightRun } from './ledger.ts';
import { appendOutcome, outcomeKey, readOutcomes } from './outcome.ts';
import { findPreviousNight, writeReport, type NightManifest, type SuiteStatus } from './report.ts';
import { OLD_RELEASE } from './smokes/upgrade-from-old.ts';

const REPO = resolve(import.meta.dir, '../../..');
/** The stable pin: the peeled commit of gbrain's latest-stable release. */
export const STABLE_SHA = '98dda48fb9fd339609d6d4eef009811280ff648d';
export const EXIT = { NIGHTLY_CAP_STOP: 3, NIGHTLY_VM_LOST: 4, NIGHTLY_HARNESS: 5 } as const;
/** Retries of one night (resumes after the first invocation). */
export const MAX_RETRIES = 2;
const FRONTIER = ['claude-opus-5-5', 'gpt-6.1-sol'];

export const TIERS: Record<Tier, { suites: string[] | null; readers: string[] | null; k: number | null }> = {
  nightly: { suites: ['tool-contract-replay', 'concurrent-writers', 'system-smokes', 'refresh-barrier-agents', 'refused-write-agents'], readers: ['gpt-6.1-sol'], k: null },
  matrix: { suites: null, readers: FRONTIER, k: null },
  smoke: { suites: null, readers: FRONTIER, k: 1 },
  bisect: { suites: null, readers: null, k: null },
};

export interface NightArgs {
  ref: string; tier: Tier; out: string | null; night: string; nightDir: string | null; clone: string; devset: string | null; cache: string | null;
  suites: string[] | null; items: string[] | null; readers: string[] | null; k: number | null;
  fake: boolean; paid: boolean; budgetRunId: string | null; budgetLedger: string | null; nightCapUsd: number | null; monthCapUsd: number | null;
  pgAdmin: string | null; pgTemplate: string | null; pg15Admin: string | null; previousRef: string | null; oldRef: string; cat40SlotAllowanceUsd: number | null;
}

export function parseArgs(argv: readonly string[]): NightArgs {
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--') ? argv[i + 1] : undefined; };
  const list = (name: string) => flag(name)?.split(',').map(s => s.trim()).filter(Boolean) ?? null;
  const num = (name: string) => { const v = flag(name); if (v === undefined) return null; const n = Number(v); if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`); return n; };
  const tier = (flag('--tier') ?? 'nightly') as Tier;
  if (!(tier in TIERS)) throw new Error(`--tier must be nightly, matrix, smoke or bisect (got ${tier})`);
  const ref = flag('--ref') ?? 'master';
  if (tier === 'smoke' && ref !== 'master') throw new Error('the smoke tier runs on master; pass --ref master');
  const nightDir = flag('--night-dir') ? resolve(flag('--night-dir')!) : null;
  const out = flag('--out') ? resolve(flag('--out')!) : null;
  if (!out && !nightDir) throw new Error('--out <dir> is required (or --night-dir <dir> for one bisect step)');
  if (tier === 'bisect' && (!nightDir || list('--suites')?.length !== 1 || !list('--items'))) throw new Error('--tier bisect takes one --suites id, --items and --night-dir');
  const fake = argv.includes('--fake');
  return {
    ref, tier, out, nightDir, night: flag('--night') ?? new Date().toISOString().slice(0, 10),
    clone: resolve(flag('--gbrain-clone') ?? process.env.GBRAIN_REPO ?? join(REPO, '../gbrain')), devset: flag('--devset') ? resolve(flag('--devset')!) : null,
    cache: flag('--cache') ? resolve(flag('--cache')!) : null,
    suites: list('--suites'), items: list('--items'), readers: list('--readers'), k: num('--k'),
    fake, paid: argv.includes('--paid'), budgetRunId: flag('--budget-run-id') ?? null, budgetLedger: flag('--budget-ledger') ? resolve(flag('--budget-ledger')!) : null,
    nightCapUsd: num('--night-cap-usd'), monthCapUsd: num('--month-cap-usd'),
    pgAdmin: flag('--pg-admin') ?? null, pgTemplate: flag('--pg-template') ?? null, pg15Admin: flag('--pg15-admin') ?? null,
    previousRef: flag('--previous-ref') ?? null, oldRef: flag('--old-ref') ?? OLD_RELEASE, cat40SlotAllowanceUsd: num('--cat40-slot-allowance-usd'),
  };
}

/** The suites a night runs, with their items, readers and k. */
export function planSuites(devset: DevSet, a: Pick<NightArgs, 'tier' | 'suites' | 'items' | 'readers' | 'k'>): SuiteRun[] {
  const tier = TIERS[a.tier];
  const known = new Set(devset.suites.map(s => s.id));
  const unknown = (a.suites ?? []).filter(id => !known.has(id));
  if (unknown.length) throw new Error(`unknown suites ${unknown.join(', ')}; the dev set has ${[...known].join(', ')}`);
  return devset.suites
    .filter(s => (tier.suites === null || tier.suites.includes(s.id)) && (a.suites === null || a.suites.includes(s.id)))
    .map(s => ({ suite: s, digest: suiteDigest(s), items: s.items.filter(i => a.items === null || a.items.some(x => x === i.id || x.endsWith(`:${i.id}`))),
      readers: callsModels(s) ? a.readers ?? tier.readers ?? devset.readers : [null], k: a.k ?? tier.k ?? devset.k[s.kind] }))
    .filter(r => r.items.length > 0);
}

/**
 * The night's ledger run, or null when it calls no model. Refuses a night with model-calling suites that is neither
 * --fake nor --paid with a ledger run, and any paid flag without one (the paid-arm guard's rule: environment variables
 * never turn on spending).
 */
export function paidGate(a: NightArgs, plan: SuiteRun[]): { runId: string; ledger: string } | null {
  const calling = plan.filter(r => callsModels(r.suite)).map(r => r.suite.id);
  if (a.fake) {
    if (a.paid || a.budgetRunId) throw new PaidArmRefusal('--fake makes no paid call; drop --paid and --budget-run-id');
    return null;
  }
  if (!calling.length && !a.paid && !a.budgetRunId) return null;
  if (!a.paid || !a.budgetLedger) {
    throw new PaidArmRefusal(`${calling.join(', ') || 'this night'} calls models: pass --fake for a keyless run, or --paid --budget-ledger <path> with --budget-run-id <id> (or --night-cap-usd and --month-cap-usd to open the night's run)`);
  }
  let runId = a.budgetRunId;
  if (!runId) {
    if (a.nightCapUsd === null || a.monthCapUsd === null) throw new PaidArmRefusal('--paid needs the night\'s ledger run: --budget-run-id <id>, or --night-cap-usd and --month-cap-usd to open it');
    runId = openNightRun({ ledgerPath: a.budgetLedger, night: a.night, ref: a.ref, nightCapUsd: a.nightCapUsd, monthCapUsd: a.monthCapUsd }).runId;
  }
  requirePaidArm(['--paid', '--budget-run-id', runId], { arm: 'the nightly run', estimateUsd: null, ledgerPath: a.budgetLedger });
  return { runId, ledger: a.budgetLedger };
}

const git = (clone: string, ...args: string[]) => execFileSync('git', ['-C', clone, ...args], { encoding: 'utf8' }).trim();

export function resolveRef(clone: string, ref: string): string {
  return git(clone, 'rev-parse', `${ref === 'stable' ? STABLE_SHA : ref}^{commit}`);
}

/** Why a suite cannot run on sha, or null: its required gbrain commit is missing from the clone or not an ancestor. */
export function requirementGap(clone: string, sha: string, required: string | undefined): string | null {
  if (!required) return null;
  const r = spawnSync('git', ['-C', clone, 'merge-base', '--is-ancestor', required, sha]);
  if (r.status === 0) return null;
  return r.status === 1 ? `gbrain ${sha.slice(0, 12)} predates ${required.slice(0, 12)}, which this suite needs` : `the clone does not have ${required.slice(0, 12)}, which this suite needs`;
}

const refLabel = (ref: string, sha: string) => (ref === 'master' || ref === 'stable' ? ref : sha.slice(0, 12));

function fixLine(code: keyof typeof EXIT, what: string, dir: string, partial: string[]): void {
  console.error(`${code}: ${what}`);
  if (partial.length) console.error(`partial: ${partial.join('; ')}`);
  console.error(`fix: bun eval/runner/nightly/run.ts --resume ${dir}`);
}

export async function main(argv: readonly string[]): Promise<number> {
  const resumeAt = argv.indexOf('--resume');
  let saved: NightManifest | null = null;
  let a: NightArgs;
  if (resumeAt >= 0) {
    const dir = resolve(argv[resumeAt + 1] ?? '');
    if (!existsSync(join(dir, 'night.json'))) throw new Error(`--resume ${dir}: no night.json there`);
    saved = JSON.parse(readFileSync(join(dir, 'night.json'), 'utf8')) as NightManifest;
    if ((saved.attempts ?? 1) > MAX_RETRIES) throw new Error(`${dir} has been retried ${MAX_RETRIES} times; it stays partial, and the report says what is missing`);
    a = { ...parseArgs(saved.argv ?? []), nightDir: dir };
    if (saved.budget) a.budgetRunId = saved.budget.run_id;
  } else a = parseArgs(argv);

  const sha = resolveRef(a.clone, saved?.sha ?? a.ref);
  const devset = a.devset ? loadDevSet(dirname(a.devset), basename(a.devset)) : loadDevSet();
  const plan = planSuites(devset, a);
  if (!plan.length) throw new Error('no suite and item matches the tier, --suites and --items');
  const dir = a.nightDir ?? join(a.out!, a.night, refLabel(a.ref, sha));
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, 'run.lock');
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, 'utf8'));
    try { process.kill(pid, 0); throw new Error(`another run.ts (pid ${pid}) is running ${dir}`); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
  }
  writeFileSync(lock, String(process.pid));
  try {
    if (saved?.budget) {
      const r = reconcileNightRun(saved.budget.ledger, saved.budget.run_id);
      if (r.finished) throw new NightlyCapStop(`the night's ledger run ${saved.budget.run_id} is finished, so no paid suite reruns`);
      console.error(`ledger: settled ${r.settled} open reservations of the stopped run before the retry`);
    }
    const paid = paidGate(a, plan);
    const gut = resolveGbrainUnderTest(`${a.clone}@${sha}`);
    const outRoot = a.out ?? dirname(dir);
    const cacheRoot = a.cache ?? join(a.out ?? dirname(dir), 'cache');
    const previousDir = a.tier === 'bisect' || a.ref !== 'master' || !a.out ? null : findPreviousNight(outRoot, a.night, 'master');
    const previousSha = a.previousRef ? resolveRef(a.clone, a.previousRef) : previousDir ? (JSON.parse(readFileSync(join(previousDir, 'night.json'), 'utf8')) as NightManifest).sha : resolveRef(a.clone, `${sha}^`);
    const statuses: SuiteStatus[] = plan.map(r => {
      const gap = requirementGap(a.clone, sha, r.suite.requires?.gbrain_commit);
      const before = saved?.suites.find(s => s.id === r.suite.id);
      return gap ? { id: r.suite.id, digest: r.digest, k: r.k, readers: r.readers, status: 'skipped', reason: gap }
        : { id: r.suite.id, digest: r.digest, k: r.k, readers: a.fake && callsModels(r.suite) ? ['fake'] : r.readers, status: before?.status === 'not_built' ? 'not_built' : 'pending' };
    });
    const manifest: NightManifest = {
      schema: 'nightly-night/1', night: a.night, ref: a.ref, sha, version: gut.version, tier: a.tier, fake: a.fake,
      devset: { path: a.devset ?? 'eval/data/nightly/devset-v1.json', digest: devset.digest }, suites: statuses, started_at: saved?.started_at ?? new Date().toISOString(),
      budget: paid ? { run_id: paid.runId, ledger: paid.ledger } : null, argv: saved?.argv ?? [...argv], attempts: (saved?.attempts ?? 0) + 1,
    };
    const writeManifest = () => writeFileSync(join(dir, 'night.json'), JSON.stringify(manifest, null, 2) + '\n');
    writeManifest();

    const outcomesPath = join(dir, 'outcomes.jsonl');
    const have = new Map(readOutcomes(outcomesPath).map(o => [outcomeKey(o), o]));
    const abort = new AbortController();
    let signalled: string | null = null;
    const onSignal = (s: string) => () => { signalled = s; abort.abort(); };
    const handlers = (['SIGTERM', 'SIGHUP', 'SIGINT'] as const).map(s => [s, onSignal(s)] as const);
    for (const [s, h] of handlers) process.on(s, h);
    const memo = new Map<string, Promise<string>>();
    const once = (key: string, make: () => string) => { if (!memo.has(key)) memo.set(key, Promise.resolve().then(make)); return memo.get(key)!; };
    const ctx: NightContext = {
      night: a.night, ref: a.ref, sha, dir, tier: a.tier, fake: a.fake, clone: a.clone, overlayRoot: gut.root,
      worktree: () => once(`worktree:${sha}`, () => worktreeAt(a.clone, sha, cacheRoot)),
      overlayFor: s => once(`overlay:${s}`, () => resolveGbrainUnderTest(`${a.clone}@${s}`).root),
      cache: new NightlyCache(cacheRoot), paid,
      pg: { admin: a.pgAdmin, template: a.pgTemplate, pg15Admin: a.pg15Admin },
      smokeRefs: { previous: previousSha, old: (() => { try { return resolveRef(a.clone, a.oldRef); } catch { return null; } })() }, cat40SlotAllowanceUsd: a.cat40SlotAllowanceUsd,
      log: line => console.error(`[nightly] ${line}`), signal: abort.signal,
    };
    let capStop = false;
    await Promise.all(plan.map(async run => {
      const status = statuses.find(s => s.id === run.suite.id)!;
      if (status.status === 'skipped') return;
      ctx.log(`${run.suite.id}: ${run.items.length} items, k ${run.k}, ${a.fake && callsModels(run.suite) ? 'fake' : run.readers.map(r => r ?? 'keyless').join(', ')}`);
      const adapter = ADAPTERS[run.suite.id];
      if (!adapter) { Object.assign(status, { status: 'not_built', reason: 'no nightly adapter runs this suite yet' }); writeManifest(); return; }
      try {
        const r = await adapter(run, ctx);
        for (const o of r.rows) {
          const before = have.get(outcomeKey(o));
          if (before && !before.harness) continue;
          appendOutcome(outcomesPath, o);
          have.set(outcomeKey(o), o);
        }
        Object.assign(status, { status: r.status, ...(r.reason ? { reason: r.reason } : {}), ...(r.dev_set ? { dev_set: r.dev_set } : {}) });
        capStop ||= r.capStop === true;
      } catch (error) {
        Object.assign(status, { status: 'error', reason: (error as Error).message.split('\n')[0]!.slice(0, 300) });
      }
      ctx.log(`${run.suite.id}: ${status.status}${status.reason ? ` (${status.reason})` : ''}`);
      writeManifest();
    }));
    for (const [s, h] of handlers) process.off(s, h);
    for (const s of statuses) if (s.status === 'pending') Object.assign(s, { status: 'error', reason: 'did not finish' });
    manifest.finished_at = new Date().toISOString();
    const harnessRows = [...have.values()].filter(o => o.harness).length;
    const partial = [...statuses.filter(s => s.status === 'partial' || s.status === 'error').map(s => `${s.id} ${s.status}${s.reason ? `: ${s.reason}` : ''}`),
      ...(harnessRows ? [`${harnessRows} harness rows`] : [])];
    const exit = signalled ? 'NIGHTLY_VM_LOST' : capStop ? 'NIGHTLY_CAP_STOP' : partial.length ? 'NIGHTLY_HARNESS' : null;
    manifest.exit = exit;
    writeManifest();
    const stableDir = a.tier === 'matrix' && a.ref === 'master' && a.out ? join(a.out, a.night, 'stable') : null;
    const summary = writeReport({ dir, previous: previousDir, stable: stableDir, gbrainClone: a.clone });
    console.log(JSON.stringify({ night: dir, sha, exit, flags: (summary.flags as unknown[]).length, report: join(dir, 'report.md') }));
    if (!exit) return 0;
    const what = exit === 'NIGHTLY_VM_LOST' ? `stopped by ${signalled}; running suites were killed`
      : exit === 'NIGHTLY_CAP_STOP' ? 'the night\'s ledger run or the 30-night cap is spent; paid suites stopped where they were'
        : 'some suites did not finish or recorded harness or provider failures';
    fixLine(exit, what, dir, partial);
    return EXIT[exit];
  } finally {
    rmSync(lock, { force: true });
  }
}

if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (error) {
    console.error((error as Error).message);
    if (error instanceof NightlyCapStop) process.exit(EXIT.NIGHTLY_CAP_STOP);
    process.exit(error instanceof PaidArmRefusal ? 2 : 1);
  }
}
