/**
 * BG1's runner wiring (eval/runner/q1/cell.ts and reread-cell.ts): `--manifest bg1` finds BG1's cells, a BG1 launch unit is
 * its kept worlds (corpus.ts bg1UnitConversations), every BG1 cell that can spend real keys refuses outside a granted
 * paid window (bg1CellWindow), a BG1 campaign carries its window in every unit's command and is refused without one
 * (bg1CampaignManifest), and a sealed-set re-read refuses while the BG1 manifest is unfilled. Keyless: every key
 * is blank, every refusal comes before any request, and the one upstream named is a dead local port.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BudgetRun, closeLedgers, initLedger } from '../../eval/runner/budget-ledger.ts';
import type { Bg1Manifest, Corpus } from '../../eval/runner/memory-qa/corpus.ts';
import { freePort } from '../../eval/runner/lifecycle/slice.ts';
import { keylessKeys, keylessUpstream, MeteringProxy } from '../../eval/runner/metering-proxy.ts';
import { bg1CampaignManifest, bg1CellWindow, bg1GeminiKey, bg1KeptUnit, campaignManifest, findCell, loadCellManifest } from '../../eval/runner/q1/cell.ts';
import { prepareReread, rereadArm } from '../../eval/runner/q1/reread-cell.ts';
import { ScoreboardError } from '../../eval/runner/q1/scoreboard-errors.ts';
import { runRemote } from '../../eval/runner/shootout-cell.ts';
import { BG1_CONVERSATIONS } from '../../eval/runner/bg1/types.ts';

const REPO = resolve(import.meta.dir, '../..');
const roots: string[] = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'bg1-window-')); roots.push(d); return d; };
afterAll(() => { closeLedgers(); for (const d of roots) rmSync(d, { recursive: true, force: true }); });

const refusal = (fn: () => unknown) => { try { fn(); } catch (e) { if (e instanceof ScoreboardError) return e.op; throw e; } return null; };
const refused = async (p: Promise<unknown>) => { try { await p; } catch (e) { if (e instanceof ScoreboardError) return e.op; throw e; } return null; };
const withEnv = <T,>(env: Record<string, string | undefined>, fn: () => T): T => {
  const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  try { return fn(); } finally { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
};
const dead = (async () => { throw new Error('no provider is reachable from this test'); }) as unknown as typeof fetch;
let leases = 0;
/** A started lease-mode proxy holding a lease of usd, with real upstreams it can never reach (its fetch always fails). */
function leaseProxy(usd: number) {
  const dir = scratch();
  const lease = BudgetRun.openLease({ runId: `bg1-window-lease-${++leases}`, leaseUsd: usd, ledgerPath: join(dir, 'ledger.sqlite') });
  const proxy = new MeteringProxy({ fetchImpl: dead, policy: { lease, usageLog: join(dir, 'usage.ndjson'), env: {} } });
  proxy.start();
  return proxy;
}
/** A ledger whose program cap and one open run's budget are the given amounts. */
function ledger(cap: number, budget: number) {
  const path = join(scratch(), 'ledger.sqlite');
  initLedger({ ledgerPath: path, programCapUsd: cap, reason: 'test', log: () => {} });
  return { path, id: BudgetRun.open({ runner: 'bg1-test', budgetUsd: budget, ledgerPath: path, log: () => {} }).runId };
}

describe('cell.ts --manifest bg1', () => {
  test('finds BG1 counted and stage 1 cells, and names bg1 in the manifest refusal', () => {
    const m = loadCellManifest('bg1');
    expect(m.cells.map(c => c.id)).toContain('bg1.gbrain-defaults.rs1-stable');
    expect(findCell('bg1-dev3.baseline-none.baseline', undefined, 'bg1').set).toBe('BG1-dev3');
    expect(refusal(() => loadCellManifest('bg2'))?.message).toContain('bg1 for BG1\'s');
  });

  test('a launch unit is its slice of the kept worlds, and the shard count must be the cell\'s', () => {
    const def = findCell('bg1.baseline-none.baseline', undefined, 'bg1');
    const kept = BG1_CONVERSATIONS.slice(0, 40);
    const manifest = { status: 'filled', kept, n_final: 40, files: kept.flatMap(id => ['world.json', 'questions.json'].map(f => ({ path: `worlds/${id}/${f}`, sha256: '0'.repeat(64) }))) } as unknown as Bg1Manifest;
    expect(bg1KeptUnit(def, { index: 0, count: 7 }, manifest)).toEqual(kept.slice(0, 6));
    expect(bg1KeptUnit(def, { index: 1, count: 7 }, manifest)).toEqual(kept.slice(6, 12));
    expect(bg1KeptUnit(def, { index: 6, count: 7 }, manifest)).toEqual(kept.slice(36, 40));
    const waveA = { ...manifest, kept: kept.slice(0, 12), n_final: undefined, files: manifest.files.filter(f => kept.slice(0, 12).some(id => f.path.startsWith(`worlds/${id}/`))) } as Bg1Manifest;
    expect(bg1KeptUnit(def, { index: 1, count: 7 }, waveA)).toEqual(kept.slice(6, 12));
    expect(() => bg1KeptUnit(def, { index: 2, count: 7 }, waveA)).toThrow('launch unit 2 needs kept worlds 13 to 18');
    expect(refusal(() => bg1KeptUnit(def, { index: 0, count: 3 }, manifest))?.message).toContain('--shard must be i/7');
  });
});

describe('bg1CellWindow', () => {
  const def = findCell('bg1.baseline-none.baseline', undefined, 'bg1');
  const window = ['--paid-window', 'BG1-S1-CELLS', '--window-cap-usd', '50'];
  test('refuses a run without the window, and a lease proxy that cannot be asked is not keyless', async () => {
    const env = { SHOOTOUT_KEYLESS_UPSTREAM: undefined, SHOOTOUT_LEASE_USD: undefined, SHOOTOUT_PROXY: undefined };
    expect(await refused(bg1CellWindow([], def, env))).toMatchObject({ code: 'PAID_FLAGS_MISSING', message: expect.stringContaining('needs --paid-window <unit> and --window-cap-usd <n>'), fix: { next: 'run' } });
    expect((await refused(bg1CellWindow(['--provider-proxy', 'http://127.0.0.1:9'], def, env)))?.code).toBe('PAID_FLAGS_MISSING');
    expect((await refused(bg1CellWindow(['--provider-proxy', 'http://127.0.0.1:9'], def, { ...env, SHOOTOUT_KEYLESS_UPSTREAM: 'http://127.0.0.1:9' })))?.code).toBe('PAID_FLAGS_MISSING');
    expect((await refused(bg1CellWindow([], def, { ...env, SHOOTOUT_KEYLESS_UPSTREAM: 'http://127.0.0.1:9' })))?.code).toBe('PAID_FLAGS_MISSING');
  });

  // Value: protects=BG1's keyless exemption rests on what the lease proxy itself reports; fails_when=bg1CellWindow trusts an inherited SHOOTOUT_KEYLESS_UPSTREAM beside a proxy with real upstreams, or ignores a keyless proxy's report; why_new=specialist review of #398 round 2 (a stale variable skipped the window)
  test('a stale SHOOTOUT_KEYLESS_UPSTREAM beside a proxy with real upstreams refuses; only a proxy reporting keyless upstreams needs no window', async () => {
    const real = new MeteringProxy({ fetchImpl: dead }), keyless = new MeteringProxy({ fetchImpl: dead, upstream: keylessUpstream('http://127.0.0.1:9') });
    real.start(); keyless.start();
    try {
      const stale = { SHOOTOUT_KEYLESS_UPSTREAM: 'http://127.0.0.1:9', SHOOTOUT_LEASE_USD: undefined, SHOOTOUT_PROXY: undefined };
      expect((await refused(bg1CellWindow(['--provider-proxy', `http://127.0.0.1:${real.port}`], def, stale)))?.code).toBe('PAID_FLAGS_MISSING');
      expect(await refused(bg1CellWindow(['--provider-proxy', `http://127.0.0.1:${keyless.port}`], def, { ...stale, SHOOTOUT_KEYLESS_UPSTREAM: undefined }))).toBeNull();
    } finally { real.stop(); keyless.stop(); }
  });

  // Value: protects=a proxy reports keyless only when no route can reach a real provider with a real key; fails_when=status reports keyless for a keyless-shaped proxy aimed at a real host, or for one holding a key other than the placeholder; why_new=fix-check of #398 (keyless checked only the shape of the upstreams)
  test('a proxy reports keyless only with loopback upstreams and placeholder keys; one aimed at a real host, or holding another key, needs the window', async () => {
    const dir = scratch();
    const lease = BudgetRun.openLease({ runId: 'bg1-window-keyless', leaseUsd: 1, ledgerPath: join(dir, 'ledger.sqlite') });
    const policy = (env: Record<string, string>) => ({ lease, usageLog: join(dir, 'usage.ndjson'), env });
    const realHost = new MeteringProxy({ fetchImpl: dead, upstream: keylessUpstream('https://api.openai.com'), policy: policy(keylessKeys()) });
    const otherKey = new MeteringProxy({ fetchImpl: dead, upstream: keylessUpstream('http://127.0.0.1:9'), policy: policy({ ...keylessKeys(), OPENAI_API_KEY: 'not-the-keyless-placeholder' }) });
    const keyless = new MeteringProxy({ fetchImpl: dead, upstream: keylessUpstream('http://127.0.0.1:9'), policy: policy(keylessKeys()) });
    const all = [realHost, otherKey, keyless];
    for (const p of all) p.start();
    try {
      expect(all.map(p => p.status().keyless)).toEqual([false, false, true]);
      for (const p of [realHost, otherKey]) expect((await refused(bg1CellWindow(['--provider-proxy', `http://127.0.0.1:${p.port}`], def, {})))?.code).toBe('PAID_FLAGS_MISSING');
      expect(await refused(bg1CellWindow(['--provider-proxy', `http://127.0.0.1:${keyless.port}`], def, {}))).toBeNull();
    } finally { for (const p of all) p.stop(); }
  });

  // Value: protects=a proxy reports keyless only when every route goes to the one keyless fake; fails_when=a loopback proxy in another upstream shape (a provider on its own port, Particle off /particle) holding placeholder keys reports keyless and skips the window; why_new=#398 open note 9 (13a29f44 replaced the shape check instead of adding to it); seam=lease-mode proxies over a dead upstream; no_claim=what listens on those ports
  test('a loopback proxy with placeholder keys in another upstream shape does not report keyless and needs the window', async () => {
    const dir = scratch();
    const lease = BudgetRun.openLease({ runId: 'bg1-window-keyless-shape', leaseUsd: 1, ledgerPath: join(dir, 'ledger.sqlite') });
    const at = (upstream: Record<string, string>) => new MeteringProxy({ fetchImpl: dead, upstream: upstream as ReturnType<typeof keylessUpstream>, policy: { lease, usageLog: join(dir, 'usage.ndjson'), env: keylessKeys() } });
    const fake = keylessUpstream('http://127.0.0.1:9');
    const shapes = [at({ ...fake, anthropic: 'http://127.0.0.1:8443' }), at({ ...fake, particle: 'http://127.0.0.1:9' }), at({ ...fake, gemini: 'http://localhost:9' })];
    for (const p of shapes) p.start();
    try {
      expect(shapes.map(p => p.status().keyless)).toEqual([false, false, false]);
      for (const p of shapes) expect((await refused(bg1CellWindow(['--provider-proxy', `http://127.0.0.1:${p.port}`], def, {})))?.code).toBe('PAID_FLAGS_MISSING');
    } finally { for (const p of shapes) p.stop(); }
  });

  // Value: protects=under a lease proxy the window caps the lease the proxy itself holds; fails_when=bg1CellWindow takes the lease from SHOOTOUT_LEASE_USD, accepts a proxy that reports no lease, or lets a differing SHOOTOUT_LEASE_USD stand; why_new=fix-check of #398 (a small exported value passed against a larger lease)
  test('under a lease proxy the lease its status reports, and without one the ledger cap and run budget, may not exceed the window cap', async () => {
    const p50 = leaseProxy(50), p200 = leaseProxy(200), inProcess = new MeteringProxy({ fetchImpl: dead });
    inProcess.start();
    const at = (p: MeteringProxy) => ['--provider-proxy', `http://127.0.0.1:${p.port}`, ...window];
    try {
      expect(await refused(bg1CellWindow(at(p50), def, {}))).toBeNull();
      expect(await refused(bg1CellWindow(at(p50), def, { SHOOTOUT_LEASE_USD: '50' }))).toBeNull();
      expect((await refused(bg1CellWindow(at(p50), def, { SHOOTOUT_LEASE_USD: '49' })))?.message).toContain('its status reports 50, SHOOTOUT_LEASE_USD names 49) is unknown');
      expect((await refused(bg1CellWindow(at(p200), def, {})))?.message).toContain("the lease proxy's lease (GET /__proxy/status in lease mode) is above paid window BG1-S1-CELLS's cap");
      expect((await refused(bg1CellWindow(at(p200), def, { SHOOTOUT_LEASE_USD: '40' })))?.code).toBe('PAID_FLAGS_MISSING');
      expect((await refused(bg1CellWindow(at(inProcess), def, { SHOOTOUT_LEASE_USD: '40' })))?.message).toContain('is unknown');
      expect((await refused(bg1CellWindow(['--provider-proxy', 'http://127.0.0.1:9', ...window], def, { SHOOTOUT_LEASE_USD: '40' })))?.message).toContain('is unknown');
    } finally { p50.stop(); p200.stop(); inProcess.stop(); }
    const ok = ledger(50, 40), over = ledger(60, 40);
    const [within, above] = withEnv({ SHOOTOUT_PROXY: undefined }, () => [
      refused(bg1CellWindow([...window, '--budget-ledger', ok.path, '--budget-run-id', ok.id], def, {})),
      refused(bg1CellWindow([...window, '--budget-ledger', over.path, '--budget-run-id', over.id], def, {}))]);
    expect(await within).toBeNull();
    expect((await above)?.message).toContain('the ledger\'s program cap');
  });

  // Value: protects=under a lease proxy only a SHOOTOUT_LEASE_USD naming the proxy's own lease stands; fails_when=a value that is not a number compares as not differing and the unit passes; why_new=#398 open note 7 (the follow-up to targeted#1, which 13a29f44 fixed); seam=a lease proxy over a dead upstream; no_claim=the lease's value
  test('a SHOOTOUT_LEASE_USD that is not a number differs from the proxy\'s lease and refuses', async () => {
    const p50 = leaseProxy(50);
    try {
      for (const named of ['fifty', '50usd', 'NaN']) {
        expect((await refused(bg1CellWindow(['--provider-proxy', `http://127.0.0.1:${p50.port}`, ...window], def, { SHOOTOUT_LEASE_USD: named })))?.message).toContain(`its status reports 50, SHOOTOUT_LEASE_USD names ${named}) is unknown`);
      }
    } finally { p50.stop(); }
  });

  test('the CLI exits 2 with the refusal before any output, for sealed and dev BG1 cells alike', () => {
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', PARTICLE_API_KEY: '', VOYAGE_API_KEY: '', BRAINBENCH_BUDGET_LEDGER: join(scratch(), 'ledger.sqlite') };
    for (const [cell, shard] of [['bg1.baseline-none.baseline', ['--shard', '0/7']], ['bg1-dev3.baseline-none.baseline', []]] as const) {
      const out = join(scratch(), 'out');
      const r = spawnSync('bun', ['eval/runner/q1/cell.ts', 'run', '--cell', cell, '--manifest', 'bg1', ...shard, '--out', out], { cwd: REPO, encoding: 'utf8', env, timeout: 60_000 });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('PAID_FLAGS_MISSING');
      expect(r.stderr).toContain('--paid-window');
      expect(existsSync(out)).toBe(false);
    }
  });
});

describe('a BG1 campaign', () => {
  const m = loadCellManifest('bg1');
  const sel = { campaign_id: 'q1-scoreboard-bg1-wave-a', cap_usd: 400, units: ['bg1.baseline-none.baseline.c0', 'bg1.gbrain-defaults.rs1-stable.c1'], paid_window: 'BG1-WA-CELLS' };
  const WORLD_END = '2026-11-15';

  test('every unit runs from bg1-cells.json inside the selection\'s paid window, at its cap', () => {
    const c = bg1CampaignManifest(m, { units: sel, worldEnd: WORLD_END });
    expect(c.campaign_id).toBe('q1-scoreboard-bg1-wave-a');
    expect(c.cap_usd).toBe(400);
    expect(c.cells.map(x => x.id).sort()).toEqual([...sel.units].sort());
    for (const cell of c.cells) expect(cell.command).toMatch(new RegExp(`--manifest bg1 --shard ${cell.id.at(-1)}/7 (--system-url \\S+ )?--paid-window BG1-WA-CELLS --window-cap-usd 400 --out "\\$SHOOTOUT_OUT"`));
    const dev = bg1CampaignManifest(m, { smoke: true, worldEnd: WORLD_END, units: { ...sel, campaign_id: 'q1-scoreboard-bg1-stage1', units: ['bg1-dev3.baseline-none.baseline'] } });
    expect(dev.cells.map(x => x.command)).toEqual([expect.stringContaining('--cell bg1-dev3.baseline-none.baseline --manifest bg1 --paid-window BG1-WA-CELLS --window-cap-usd 400 --out "$SHOOTOUT_OUT"')]);
  });

  // Value: protects=every BG1 unit's VM resolves dates from the campaign's one world end; fails_when=a unit command lacks GBRAIN_EVALS_BG1_WORLD_END, or a campaign plans without a Sunday world end; why_new=red team of #398 round 2 (every remote unit refused SPEC_MISSING)
  test('every unit exports the campaign\'s world end before it runs, and a campaign without a Sunday world end is refused', () => {
    for (const cell of bg1CampaignManifest(m, { units: sel, worldEnd: WORLD_END }).cells) expect(cell.command.startsWith('export GBRAIN_EVALS_BG1_WORLD_END=' + WORLD_END + '; ')).toBe(true);
    expect(withEnv({ GBRAIN_EVALS_BG1_WORLD_END: '2026-11-22' }, () => bg1CampaignManifest(m, { units: sel }).cells.map(c => c.command.split(';')[0]))).toEqual(sel.units.map(() => 'export GBRAIN_EVALS_BG1_WORLD_END=2026-11-22'));
    expect(() => withEnv({ GBRAIN_EVALS_BG1_WORLD_END: undefined }, () => bg1CampaignManifest(m, { units: sel }))).toThrow('GBRAIN_EVALS_BG1_WORLD_END is not set');
    expect(() => bg1CampaignManifest(m, { units: sel, worldEnd: '2026-11-16' })).toThrow('not a Sunday');
  });

  // Value: protects=a paid BG1 unit passes its window guard on its VM, against the lease its proxy holds; fails_when=runRemote sets no SHOOTOUT_LEASE_USD, or an inherited value wins; why_new=red team of #398 round 2 (every paid unit refused PAID_FLAGS_MISSING)
  test('runRemote gives the unit its own lease as SHOOTOUT_LEASE_USD over an inherited one, and a campaign unit passes its window guard with it', async () => {
    const cell = bg1CampaignManifest(m, { units: sel, worldEnd: WORLD_END }).cells.find(c => c.id === 'bg1.gbrain-defaults.rs1-stable.c1')!;
    const out = join(scratch(), 'out');
    const saved = process.env.SHOOTOUT_LEASE_USD;
    process.env.SHOOTOUT_LEASE_USD = '9999';
    try { expect(await runRemote({ lease_id: 'bg1-lease-usd', lease_usd: cell.lease_usd, out, command: 'printf %s "$SHOOTOUT_LEASE_USD" > "$SHOOTOUT_OUT/lease.txt"' }, { port: await freePort(0), upstream: keylessUpstream('http://127.0.0.1:9') })).toBe(0); }
    finally { if (saved === undefined) delete process.env.SHOOTOUT_LEASE_USD; else process.env.SHOOTOUT_LEASE_USD = saved; }
    const lease = readFileSync(join(out, 'lease.txt'), 'utf8');
    expect(lease).toBe(String(cell.lease_usd));
    const argv = cell.command.slice(cell.command.indexOf(' run ') + 5).split(' ');
    const def = findCell('bg1.gbrain-defaults.rs1-stable', m, 'bg1');
    const proxy = leaseProxy(cell.lease_usd);
    try {
      const env = { SHOOTOUT_PROXY: `http://127.0.0.1:${proxy.port}`, SHOOTOUT_LEASE_ID: 'bg1-lease-usd', SHOOTOUT_KEYLESS_UPSTREAM: undefined };
      expect(await refused(bg1CellWindow(argv, def, { ...env, SHOOTOUT_LEASE_USD: lease }))).toBeNull();
      expect((await refused(bg1CellWindow(argv, def, { ...env, SHOOTOUT_LEASE_USD: '9999' })))?.code).toBe('PAID_FLAGS_MISSING');
    } finally { proxy.stop(); }
  });

  // Value: protects=a BG1 unit's VM gets Gemini's key only as BG1_GEMINI_API_KEY, and no other campaign's units change; fails_when=a BG1 unit passes GEMINI_API_KEY or no Gemini key, or a q1, f6 or rs1 unit gains a provider, pass or key mapping; why_new=GBEV-3's key rule for BG1's canonical judge; seam=bg1CampaignManifest; no_claim=that the launch host holds the key
  test('every BG1 unit passes BG1_GEMINI_API_KEY and maps it to Gemini, never GEMINI_API_KEY; q1, f6 and rs1 units pass only their own providers\' keys', () => {
    const units = [...bg1CampaignManifest(m, { units: sel, worldEnd: WORLD_END }).cells, ...bg1CampaignManifest(m, { smoke: true, worldEnd: WORLD_END, units: { ...sel, campaign_id: 'q1-scoreboard-bg1-stage1', units: ['bg1-dev3.baseline-none.baseline'] } }).cells];
    expect(units).toHaveLength(3);
    for (const cell of units) {
      expect(cell.providers).toContain('gemini');
      expect(cell.pass).toContain('BG1_GEMINI_API_KEY');
      expect(cell.pass).not.toContain('GEMINI_API_KEY');
      expect(cell.gemini_key_env).toBe('BG1_GEMINI_API_KEY');
    }
    const KEYS: Record<string, string> = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', voyage: 'VOYAGE_API_KEY', particle: 'PARTICLE_API_KEY' };
    for (const id of ['q1', 'f6', 'rs1']) for (const cell of campaignManifest(loadCellManifest(id), { smoke: true }).cells) {
      expect(cell.providers!.every(p => p in KEYS)).toBe(true);
      expect(cell.pass).toEqual(cell.providers!.map(p => KEYS[p]));
      expect(cell.gemini_key_env).toBeUndefined();
    }
  });

  test('a BG1 campaign without a selection naming a well-formed window, or without a positive cap, is refused', () => {
    for (const units of [undefined, { ...sel, paid_window: undefined }, { ...sel, paid_window: 'a b' }, { ...sel, cap_usd: 0 }]) {
      expect(refusal(() => bg1CampaignManifest(m, { units }))).toMatchObject({ code: 'PAID_FLAGS_MISSING', message: expect.stringContaining('naming its granted paid window') });
    }
  });

  test('the CLI writes a BG1 campaign only from a selection naming its window', () => {
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', PARTICLE_API_KEY: '', VOYAGE_API_KEY: '', GBRAIN_EVALS_BG1_WORLD_END: '2026-11-15' };
    const dir = scratch(), bare = join(dir, 'bare.json'), named = join(dir, 'named.json'), units = join(dir, 'units.json');
    const plan = (...args: string[]) => spawnSync('bun', ['eval/runner/q1/cell.ts', 'plan', '--manifest', 'bg1', ...args], { cwd: REPO, encoding: 'utf8', env, timeout: 60_000 });
    const r = plan('--campaign-out', bare);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('PAID_FLAGS_MISSING');
    expect(existsSync(bare)).toBe(false);
    writeFileSync(units, JSON.stringify(sel));
    expect(plan('--units', units, '--campaign-out', named).status).toBe(0);
    const c = JSON.parse(readFileSync(named, 'utf8'));
    expect(c.cells.every((x: { command: string }) => x.command.includes('--paid-window BG1-WA-CELLS --window-cap-usd 400 --out'))).toBe(true);
    expect(c.cells.every((x: { command: string }) => x.command.startsWith('export GBRAIN_EVALS_BG1_WORLD_END=2026-11-15; '))).toBe(true);
  });
});

describe('reread-cell.ts on BG1', () => {
  // Value: protects=a paid BG1 re-read and a proxy-less BG1 run bill Gemini to BG1_GEMINI_API_KEY alone; fails_when=either falls back to GEMINI_API_KEY or runs with no BG1 key; why_new=red team of #398 round 2
  test('bg1GeminiKey takes BG1_GEMINI_API_KEY over GEMINI_API_KEY, and a paid re-read without it refuses before its --out is claimed', () => {
    expect(bg1GeminiKey({ BG1_GEMINI_API_KEY: 'placeholder-bg1', GEMINI_API_KEY: 'placeholder-decoy' })).toBe('placeholder-bg1');
    expect(refusal(() => bg1GeminiKey({ GEMINI_API_KEY: 'placeholder-decoy' }))).toMatchObject({ code: 'KEY_MISSING', message: 'BG1_GEMINI_API_KEY is not set' });
    const tmp = scratch();
    const reread = (extra: Record<string, string>, out: string) => spawnSync('bun', ['eval/runner/q1/reread-cell.ts', '--cell', 'bg1.ext-memory-bank.recipe', '--manifest', 'bg1', '--arm', 'component-b8000', '--source', join(tmp, 'none'), '--reader', 'particle:particle-1',
      '--out', out, '--budget-ledger', join(tmp, 'ledger.sqlite'), '--run-id', 'bg1-rr', '--lease-usd', '1', '--ledger-cap-usd', '1', '--paid-window', 'BG1-RR', '--window-cap-usd', '5'],
      { cwd: REPO, encoding: 'utf8', timeout: 60_000, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', GEMINI_API_KEY: 'placeholder-decoy', ...extra } });
    const bare = reread({}, join(tmp, 'a'));
    expect(bare.status).not.toBe(0);
    expect(bare.stderr).toContain('BG1_GEMINI_API_KEY is not set');
    expect(existsSync(join(tmp, 'a'))).toBe(false);
    const keyed = reread({ BG1_GEMINI_API_KEY: 'placeholder-bg1' }, join(tmp, 'b'));
    expect(keyed.status).not.toBe(0);
    expect(keyed.stderr).not.toContain('BG1_GEMINI_API_KEY is not set');
    expect(keyed.stderr).toContain('the BG1 manifest is unfilled');
  });

  test('a sealed-set re-read is refused while the BG1 manifest is unfilled, before custody or any source is read', () => {
    const def = findCell('bg1.ext-memory-bank.recipe', undefined, 'bg1');
    const arm = rereadArm(def, 'component-b8000');
    const corpus = (revision: string): Corpus => ({ benchmark: 'bg1', conversations: [], questions: [], source: { name: 'BG1 fixture', files: [], revision, license: 'custodian-held' } });
    const tmp = scratch();
    const unfilled = refusal(() => prepareReread(def, arm, { sources: [join(tmp, 'none', 'runs', def.id)], reader: 'particle:particle-1', out: join(tmp, 'a'), env: {} }, { corpus: corpus('unfilled') }));
    expect(unfilled).toMatchObject({ code: 'PREFLIGHT_FAILED', message: expect.stringContaining('the BG1 manifest is unfilled') });
    expect(refusal(() => prepareReread(def, arm, { sources: [join(tmp, 'none', 'runs', def.id)], reader: 'particle:particle-1', out: join(tmp, 'b'), env: {} }, { corpus: corpus('abcdef0') }))?.message ?? '').not.toContain('unfilled');
  });
});
