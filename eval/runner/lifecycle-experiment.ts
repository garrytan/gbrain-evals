#!/usr/bin/env bun
/**
 * Memory lifecycle experiment (plan amendment 8; first slice of N14, N5, N6).
 *
 * Sequence per cell (build x engine x interface):
 *   ingest -> query -> embedding outage during an ingest -> correct ->
 *   reconcile -> forget -> restart -> query again
 *
 * Ground truth is the evaluator's own ledger (`lifecycle/scenario.ts`). gbrain's
 * doctor, integrity and invariant checks are never consulted. The embedding
 * provider is a local hash embedder, so the run is hermetic and costs $0; the
 * runner strips OPENAI_API_KEY and ANTHROPIC_API_KEY from every child process.
 *
 * Usage:
 *   bun eval/runner/lifecycle-experiment.ts --gbrain-repo ../gbrain \
 *     [--builds a=6bb88d128,b=origin/master] [--engines pglite,postgres] \
 *     [--interfaces cli,mcp-stdio,mcp-http] [--pg-url postgres://user@host:port/db] \
 *     [--concurrency 4] [--out docs/benchmarks/<dir>/receipt.json]
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { SQL } from 'bun';
import { assertBuildVerified, prepareBuild, type BuildInfo, type BuildSpec } from './lifecycle/builds.ts';
import { CliDriver, McpHttpDriver, McpStdioDriver, runCli, type Driver, type RunEnv } from './lifecycle/drivers.ts';
import { startFakeEmbedder } from './lifecycle/fake-embedder.ts';
import { observe, probeLeaks, type LeakProbe, type Snapshot } from './lifecycle/observe.ts';
import {
  HAZARD_IDS, FACTS, OLD_SLUGS, FORGET_KEY, IDENTITIES, OUTAGE_BODY_PHRASE, OUTAGE_IDS, PRIVATE_ID, SOURCES, expectedAt, filePhaseAt,
  renderFile, versionAt, type Checkpoint, type PhaseName, type SourceName,
} from './lifecycle/scenario.ts';
import { scoreCheckpoint, type CheckpointScore, type FactEvent } from './lifecycle/score.ts';

type Engine = 'pglite' | 'postgres';
type Iface = 'cli' | 'mcp-stdio' | 'mcp-http';

interface OperatorStep { step: string; args: string[]; code: number; ms: number; tail: string; errors: string[] }

interface CellResult {
  build: string;
  engine: Engine;
  interface: Iface;
  started_at: string;
  duration_ms: number;
  fatal?: string;
  operator: OperatorStep[];
  sync_exits: Record<string, Record<SourceName, number>>;
  server_version?: string;
  sessions: number;
  fact_events: FactEvent[];
  forget: { ok: boolean; error?: string; fact_id: string | null };
  checkpoints: Partial<Record<Checkpoint, { score: CheckpointScore; snapshot: Snapshot; leaks?: LeakProbe[] }>>;
  outage: {
    sync_exit: number | null;
    refused_inputs: number;
    text_persisted_during_outage: string[];
    embedded_after_recovery: string[];
    searchable_after_recovery: string[];
  };
  embedder: { ok_requests: number; failed_requests: number; ok_inputs: number; failed_inputs: number };
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  const eq = process.argv.find(a => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : fallback;
}

const DEFAULT_BUILDS = [
  'a=6bb88d128d70fef364444ec71f449f5a2cbd45ee',
  'b0=2ede415d74d50a98f836f451d0ab8fedc2ba0708',
  'b=b80cad61e4725e62531439c027053387c98e23f8',
  'c=merge:b80cad61e4725e62531439c027053387c98e23f8+origin/capy/v05970-fixmemory-subject-scoped',
].join(',');

const BUILD_DESCRIPTIONS: Record<string, string> = {
  a: 'v0.59.3.0, before the 2026-09 fix wave',
  b0: 'v0.59.11.0, master after #5668 (identity, collisions, replace-on-sync links and timeline)',
  b: 'v0.59.13.0, current master (#5668 and #5676)',
  c: 'current master plus unmerged #5666 (subject-scoped forget and related memory fixes)',
};

function git(dir: string, args: string[]) {
  execFileSync('git', ['-C', dir, '-c', 'user.name=lifecycle-eval', '-c', 'user.email=lifecycle-eval@example.invalid', ...args], { stdio: 'ignore' });
}

function writeVault(dirs: Record<SourceName, string>, phase: PhaseName, previous: PhaseName | null) {
  for (const identity of IDENTITIES) {
    const vault = dirs[identity.source ?? 'vault'];
    const before = previous ? versionAt(identity, previous) : null;
    const after = versionAt(identity, phase);
    if (before && !after) { git(vault, ['rm', '-q', before.path]); continue; }
    if (!after) continue;
    mkdirSync(dirname(join(vault, after.path)), { recursive: true });
    if (before && before.path !== after.path) git(vault, ['mv', before.path, after.path]);
    if (!before || before.canary !== after.canary) writeFileSync(join(vault, after.path), renderFile(after));
  }
}

function commitAll(dirs: Record<SourceName, string>, message: string) {
  for (const vault of Object.values(dirs)) {
    git(vault, ['add', '-A']);
    git(vault, ['commit', '-q', '--allow-empty', '-m', message]);
  }
}

async function runCell(build: BuildInfo, engine: Engine, iface: Iface, opts: { work: string; pgAdminUrl: string; port: number }): Promise<CellResult> {
  const t0 = Date.now();
  const cellId = `${build.label}-${engine}-${iface}`;
  const dir = join(opts.work, cellId);
  rmSync(dir, { recursive: true, force: true });
  const home = join(dir, 'gbrain-home');
  const dirs = Object.fromEntries(SOURCES.map(src => [src, join(dir, src === 'vault' ? 'vault' : `${src}-vault`)])) as Record<SourceName, string>;
  const userHome = join(dir, 'user-home');
  for (const d of [home, userHome, ...Object.values(dirs)]) mkdirSync(d, { recursive: true });

  const embedder = startFakeEmbedder({ dims: 64 });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: userHome, GBRAIN_HOME: home, LITELLM_BASE_URL: embedder.url,
    GBRAIN_SKIP_STARTUP_HOOKS: '1', TZ: 'UTC', LANG: 'C.UTF-8', NO_COLOR: '1',
  };
  const run: RunEnv = { buildDir: build.dir, env };
  const result: CellResult = {
    build: build.label, engine, interface: iface, started_at: new Date().toISOString(), duration_ms: 0,
    operator: [], sync_exits: {}, sessions: 0, fact_events: [], forget: { ok: false, fact_id: null }, checkpoints: {},
    outage: { sync_exit: null, refused_inputs: 0, text_persisted_during_outage: [], embedded_after_recovery: [], searchable_after_recovery: [] },
    embedder: embedder.stats(),
  };
  const op = async (step: string, args: string[], timeout = 600_000) => {
    const r = await runCli(run, args, timeout);
    const redact = (t: string) => t.replace(/gbrain_cs_[0-9a-f]+/g, 'gbrain_cs_<redacted>').replace(/(postgres(?:ql)?:\/\/[^:/@\s]+):[^@\s]+@/g, '$1:<redacted>@');
    const lines = redact(r.stdout + '\n' + r.stderr).split('\n').filter(l => l.trim());
    const tail = lines.slice(-12).join('\n');
    const errors = lines.filter(l => /error|code=|failed|refus|warning/i.test(l)).slice(0, 12);
    const shownArgs = args.map(redact);
    result.operator.push({ step, args: shownArgs, code: r.code, ms: r.ms, tail, errors });
    appendFileSync(join(dir, 'operator.log'), `\n===== ${step} (exit ${r.code}, ${r.ms}ms): gbrain ${shownArgs.join(' ')}\n${redact(r.stdout)}\n--- stderr ---\n${redact(r.stderr)}\n`);
    return r;
  };
  let driver: Driver | null = null;
  let pgDb: string | null = null;
  const acknowledged = new Map<string, string>();
  const acknowledge = (phase: PhaseName, source: SourceName) => {
    for (const identity of IDENTITIES) {
      if ((identity.source ?? 'vault') !== source) continue;
      const v = versionAt(identity, phase);
      if (v) acknowledged.set(identity.id, v.canary);
    }
  };
  const syncStep = async (step: string, phase: PhaseName, full = false) => {
    const codes = {} as Record<SourceName, number>;
    for (const source of SOURCES) {
      const s = await op(`${step}:${source}`, ['sync', '--source', source, '--no-pull', ...(full ? ['--full'] : [])]);
      codes[source] = s.code;
      if (s.code === 0) acknowledge(phase, source);
    }
    await op(`${step}:extract`, ['extract', '--stale']);
    return codes;
  };
  const forgotten = new Set<string>();
  const hiddenIds = iface === 'cli' ? [] : [PRIVATE_ID];
  const ignoreIds = iface === 'cli' ? [] : HAZARD_IDS;
  const observer: 'local' | 'remote' = iface === 'cli' ? 'local' : 'remote';
  const extraSources = iface === 'cli' ? SOURCES.filter(src => src !== 'vault') : [];
  // Search reads the default source, so only main-vault pages are probed; a remote caller is not expected to find the private page.
  const searchIds = IDENTITIES.filter(i => (i.source ?? 'vault') === 'vault' && !hiddenIds.includes(i.id)).map(i => i.id);
  const checkpoint = async (cp: Checkpoint, o: { search?: boolean; leaks?: boolean } = {}) => {
    const snap = await observe(driver!, { search: o.search, searchIds, extraSources, oldSlugs: filePhaseAt(cp) === 'correct' ? OLD_SLUGS : [] });
    const exp = expectedAt(filePhaseAt(cp), observer);
    const score = scoreCheckpoint({ snap, exp, hiddenIds, ignoreIds, acknowledgedCanaries: acknowledged, factEvents: result.fact_events, forgotten, forgetKey: FORGET_KEY });
    const leaks = o.leaks && driver!.remote ? await probeLeaks(driver!) : undefined;
    result.checkpoints[cp] = { score, snapshot: snap, ...(leaks ? { leaks } : {}) };
    return snap;
  };
  const remember = async (when: 'after_ingest' | 'after_forget') => {
    for (const spec of FACTS.filter(f => f.when === when)) {
      const r = await driver!.call('remember', { fact: spec.fact, provenance: 'lifecycle-eval ledger', entity: spec.entity });
      const d = (r.data && typeof r.data === 'object' ? r.data : {}) as Record<string, unknown>;
      const status = String(d.status ?? (r.ok ? 'unknown' : 'error'));
      result.fact_events.push({
        spec, acknowledged: r.ok && (status === 'inserted' || status === 'superseded'), status,
        fact_id: d.id == null ? null : String(d.id), entity_slug: d.entity_slug == null ? null : String(d.entity_slug),
        ...(r.ok ? {} : { error: r.error }),
      });
    }
  };

  try {
    const dbArgs: string[] = [];
    if (engine === 'pglite') dbArgs.push('--pglite', '--path', join(home, 'brain.pglite'));
    else {
      pgDb = `lc_${cellId.replace(/[^a-z0-9]/g, '_')}_${process.pid}`;
      const admin = new SQL(opts.pgAdminUrl);
      await admin.unsafe(`DROP DATABASE IF EXISTS ${pgDb}`);
      await admin.unsafe(`CREATE DATABASE ${pgDb}`);
      await admin.close();
      const u = new URL(opts.pgAdminUrl);
      u.pathname = `/${pgDb}`;
      dbArgs.push('--url', u.toString());
    }
    const init = await op('init', ['init', ...dbArgs, '--embedding-model', 'litellm:fake-embed', '--embedding-dimensions', '64']);
    if (init.code !== 0) throw new Error(`init failed: ${result.operator.at(-1)!.tail}`);

    for (const d of Object.values(dirs)) git(d, ['init', '-q']);
    writeVault(dirs, 'ingest', null);
    commitAll(dirs, 'ingest');
    for (const source of SOURCES) await op(`sources-add:${source}`, ['sources', 'add', source, '--path', dirs[source]]);
    await op('sources-default', ['sources', 'default', 'vault']);

    const client = { id: '', secret: '' };
    if (iface === 'mcp-http') {
      const t = await op('auth-register-client', ['auth', 'register-client', 'lifecycle-eval', '--grant-types', 'client_credentials', '--scopes', 'read write', '--source', 'vault']);
      client.id = (t.stdout.match(/gbrain_cl_[0-9a-f]+/) ?? [''])[0];
      client.secret = (t.stdout.match(/gbrain_cs_[0-9a-f]+/) ?? [''])[0];
      if (!client.id || !client.secret) throw new Error('could not register an OAuth client for the HTTP arm');
    }
    driver = iface === 'cli' ? new CliDriver(run) : iface === 'mcp-stdio' ? new McpStdioDriver(run) : new McpHttpDriver(run, opts.port, client);
    await driver.start();
    if (driver instanceof McpStdioDriver || driver instanceof McpHttpDriver) result.server_version = driver.serverVersion;

    // 1. ingest, then query.
    result.sync_exits.ingest = await syncStep('ingest-sync', 'ingest');
    await remember('after_ingest');
    await checkpoint('ingest', { leaks: true });

    // 2. an ingest during an embedding outage.
    writeVault(dirs, 'outage', 'ingest');
    commitAll(dirs, 'outage files');
    embedder.setOutage(true);
    result.sync_exits.outage = await syncStep('outage-sync', 'outage');
    result.outage.sync_exit = result.sync_exits.outage.vault;
    const outageSnap = await observe(driver, { facts: false, extraSources });
    embedder.setOutage(false);
    result.outage.refused_inputs = embedder.stats().failed_inputs;
    {
      const exp = expectedAt('outage', observer);
      const score = scoreCheckpoint({ snap: outageSnap, exp, hiddenIds, ignoreIds, acknowledgedCanaries: acknowledged, forgetKey: FORGET_KEY });
      result.checkpoints.outage = { score, snapshot: outageSnap };
      result.outage.text_persisted_during_outage = OUTAGE_IDS.filter(id => outageSnap.pages.some(p => p.canaries.includes(versionAt(IDENTITIES.find(i => i.id === id)!, 'outage')!.canary)));
    }

    // 3. correct: moves, renames, removed links, corrected bullets, deletions.
    writeVault(dirs, 'correct', 'outage');
    commitAll(dirs, 'corrections');
    result.sync_exits.correct = await syncStep('correct-sync', 'correct');
    await checkpoint('correct');

    // 4. reconcile: full sync, stale extraction and the embedding catch-up sweep.
    result.sync_exits.reconcile = await syncStep('reconcile-sync', 'correct', true);
    await op('reconcile-embed', ['embed', '--stale']);
    await checkpoint('reconcile', { search: true, leaks: true });
    const embeddedDocs = embedder.embeddedInputsWith(OUTAGE_BODY_PHRASE);
    result.outage.embedded_after_recovery = OUTAGE_IDS.filter(id => {
      const canary = versionAt(IDENTITIES.find(i => i.id === id)!, 'outage')!.canary;
      return embeddedDocs.some(t => t.includes(canary));
    });

    // 5. forget one entity's fact; the same claim text lives on another entity.
    const target = result.fact_events.find(e => e.spec.key === FORGET_KEY);
    if (target?.fact_id) {
      const r = await driver.call('forget', { id: target.fact_id, reason: 'lifecycle-eval withdrawal' });
      result.forget = { ok: r.ok, fact_id: target.fact_id, ...(r.ok ? {} : { error: r.error }) };
      if (r.ok) forgotten.add(FORGET_KEY);
    } else result.forget = { ok: false, fact_id: null, error: 'the fact to forget was never acknowledged' };
    await remember('after_forget');
    await checkpoint('forget', { search: true });

    // 6. restart, reimport, query again.
    commitAll(dirs, 'post-forget working tree');
    result.sync_exits.restart = await syncStep('restart-sync', 'correct', true);
    await driver.restart();
    await checkpoint('restart', { search: true, leaks: true });
    const finalSearch = result.checkpoints.restart!.snapshot.search ?? {};
    result.outage.searchable_after_recovery = OUTAGE_IDS.filter(id => finalSearch[id]?.found);
  } catch (e) {
    result.fatal = (e as Error).stack ?? String(e);
  } finally {
    result.sessions = driver?.sessions() ?? 0;
    if (driver instanceof McpStdioDriver || driver instanceof McpHttpDriver) {
      if (result.fatal) result.fatal += `\n[server stderr tail]\n${driver.stderrTail.slice(-20).join('\n')}`;
    }
    await driver?.close().catch(() => {});
    result.embedder = embedder.stats();
    embedder.stop();
    if (pgDb) {
      try { const admin = new SQL(opts.pgAdminUrl); await admin.unsafe(`DROP DATABASE IF EXISTS ${pgDb} WITH (FORCE)`); await admin.close(); } catch { /* keep going */ }
    }
    result.duration_ms = Date.now() - t0;
  }
  return result;
}

async function main() {
  const repo = resolve(arg('gbrain-repo', '../gbrain')!);
  const builds = (arg('builds', DEFAULT_BUILDS)!).split(',').map((s): BuildSpec => {
    const [label, ref] = s.split('=');
    return { label, ref, description: BUILD_DESCRIPTIONS[label] ?? ref };
  });
  const engines = arg('engines', 'pglite,postgres')!.split(',') as Engine[];
  const ifaces = arg('interfaces', 'cli,mcp-stdio,mcp-http')!.split(',') as Iface[];
  const pgAdminUrl = arg('pg-url', process.env.LIFECYCLE_PG_URL ?? 'postgres://postgres@127.0.0.1:55432/postgres')!;
  const concurrency = Number(arg('concurrency', '4'));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const work = resolve(arg('work', join('eval/reports/lifecycle', stamp))!);
  const buildRoot = resolve(arg('build-root', 'eval/reports/lifecycle/builds')!);
  const out = resolve(arg('out', join(work, 'receipt.json'))!);
  mkdirSync(work, { recursive: true });

  for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY']) delete process.env[k];
  const prepared: BuildInfo[] = [];
  for (const spec of builds) {
    const b = prepareBuild(repo, spec, buildRoot);
    assertBuildVerified(b);
    prepared.push(b);
    console.error(`[lifecycle] build ${b.label}: ${b.commit.slice(0, 9)} v${b.version} tree ${b.tree.slice(0, 9)} verified`);
  }
  const cells: Array<[BuildInfo, Engine, Iface]> = [];
  for (const b of prepared) for (const e of engines) for (const i of ifaces) cells.push([b, e, i]);
  const results: CellResult[] = [];
  let next = 0;
  let port = 47100;
  const worker = async () => {
    while (next < cells.length) {
      const [b, e, i] = cells[next++];
      const cellPort = port++;
      console.error(`[lifecycle] start ${b.label}/${e}/${i}`);
      const r = await runCell(b, e, i, { work, pgAdminUrl, port: cellPort });
      console.error(`[lifecycle] done ${b.label}/${e}/${i} in ${Math.round(r.duration_ms / 1000)}s${r.fatal ? ` FATAL ${r.fatal.split('\n')[0]}` : ''}`);
      results.push(r);
      writeFileSync(join(work, `${b.label}-${e}-${i}.json`), JSON.stringify(r, null, 1));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, cells.length) }, worker));
  const order = (r: CellResult) => cells.findIndex(([b, e, i]) => b.label === r.build && e === r.engine && i === r.interface);
  results.sort((x, y) => order(x) - order(y));
  const evalsHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const evalsDirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  const receipt = {
    schema: 'gbrain-evals/lifecycle-experiment@1',
    generated_at: new Date().toISOString(),
    cost_usd: 0,
    hermetic: { embedder: 'local hash embedder (litellm recipe, 64 dims)', keys_stripped: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY'] },
    evals: { head: evalsHead, dirty_files: evalsDirty },
    runtime: { bun: Bun.version, platform: `${process.platform}-${process.arch}` },
    builds: prepared,
    engines, interfaces: ifaces,
    cells: results,
  };
  mkdirSync(dirname(out), { recursive: true });
  const tmp = `${out}.tmp`;
  writeFileSync(tmp, JSON.stringify(receipt, null, 1) + '\n');
  renameSync(tmp, out);
  console.error(`[lifecycle] receipt ${out}`);
}

if (import.meta.main) {
  main().catch(e => { console.error(e); process.exit(1); });
}
