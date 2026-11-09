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
import { bg1CampaignManifest, bg1CellWindow, bg1KeptUnit, campaignManifest, findCell, loadCellManifest } from '../../eval/runner/q1/cell.ts';
import { prepareReread, rereadArm } from '../../eval/runner/q1/reread-cell.ts';
import { ScoreboardError } from '../../eval/runner/q1/scoreboard-errors.ts';
import { BG1_CONVERSATIONS } from '../../eval/runner/bg1/types.ts';

const REPO = resolve(import.meta.dir, '../..');
const roots: string[] = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'bg1-window-')); roots.push(d); return d; };
afterAll(() => { closeLedgers(); for (const d of roots) rmSync(d, { recursive: true, force: true }); });

const refusal = (fn: () => unknown) => { try { fn(); } catch (e) { if (e instanceof ScoreboardError) return e.op; throw e; } return null; };
const withEnv = <T,>(env: Record<string, string | undefined>, fn: () => T): T => {
  const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  try { return fn(); } finally { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
};
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
  test('refuses a run without the window, and a keyless lease proxy needs none', () => {
    const env = { SHOOTOUT_KEYLESS_UPSTREAM: undefined, SHOOTOUT_LEASE_USD: undefined, SHOOTOUT_PROXY: undefined };
    expect(refusal(() => bg1CellWindow([], def, env))).toMatchObject({ code: 'PAID_FLAGS_MISSING', message: expect.stringContaining('needs --paid-window <unit> and --window-cap-usd <n>'), fix: { next: 'run' } });
    expect(refusal(() => bg1CellWindow(['--provider-proxy', 'http://127.0.0.1:9'], def, env))?.code).toBe('PAID_FLAGS_MISSING');
    expect(refusal(() => bg1CellWindow(['--provider-proxy', 'http://127.0.0.1:9'], def, { ...env, SHOOTOUT_KEYLESS_UPSTREAM: 'http://127.0.0.1:9' }))).toBeNull();
    expect(refusal(() => bg1CellWindow([], def, { ...env, SHOOTOUT_KEYLESS_UPSTREAM: 'http://127.0.0.1:9' }))?.code).toBe('PAID_FLAGS_MISSING');
  });

  test('under a lease proxy the lease, and without one the ledger cap and run budget, may not exceed the window cap', () => {
    const proxy = ['--provider-proxy', 'http://127.0.0.1:9', ...window];
    expect(refusal(() => bg1CellWindow(proxy, def, { SHOOTOUT_LEASE_USD: '50' }))).toBeNull();
    expect(refusal(() => bg1CellWindow(proxy, def, { SHOOTOUT_LEASE_USD: '50.5' }))?.message).toContain('the campaign lease (SHOOTOUT_LEASE_USD) is above paid window BG1-S1-CELLS\'s cap');
    expect(refusal(() => bg1CellWindow(proxy, def, {}))?.message).toContain('the campaign lease (SHOOTOUT_LEASE_USD) is unknown');
    const ok = ledger(50, 40), over = ledger(60, 40);
    withEnv({ SHOOTOUT_PROXY: undefined }, () => {
      expect(refusal(() => bg1CellWindow([...window, '--budget-ledger', ok.path, '--budget-run-id', ok.id], def, {}))).toBeNull();
      expect(refusal(() => bg1CellWindow([...window, '--budget-ledger', over.path, '--budget-run-id', over.id], def, {}))?.message).toContain('the ledger\'s program cap');
    });
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

  test('every unit runs from bg1-cells.json inside the selection\'s paid window, at its cap', () => {
    const c = bg1CampaignManifest(m, { units: sel });
    expect(c.campaign_id).toBe('q1-scoreboard-bg1-wave-a');
    expect(c.cap_usd).toBe(400);
    expect(c.cells.map(x => x.id).sort()).toEqual([...sel.units].sort());
    for (const cell of c.cells) expect(cell.command).toMatch(new RegExp(`--manifest bg1 --shard ${cell.id.at(-1)}/7 (--system-url \\S+ )?--paid-window BG1-WA-CELLS --window-cap-usd 400 --out "\\$SHOOTOUT_OUT"`));
    const dev = bg1CampaignManifest(m, { smoke: true, units: { ...sel, campaign_id: 'q1-scoreboard-bg1-stage1', units: ['bg1-dev3.baseline-none.baseline'] } });
    expect(dev.cells.map(x => x.command)).toEqual([expect.stringContaining('--cell bg1-dev3.baseline-none.baseline --manifest bg1 --paid-window BG1-WA-CELLS --window-cap-usd 400 --out "$SHOOTOUT_OUT"')]);
  });

  // Value: protects=a BG1 unit's VM gets Gemini's key only as BG1_GEMINI_API_KEY, and no other campaign's units change; fails_when=a BG1 unit passes GEMINI_API_KEY or no Gemini key, or a q1, f6 or rs1 unit gains a provider, pass or key mapping; why_new=GBEV-3's key rule for BG1's canonical judge; seam=bg1CampaignManifest; no_claim=that the launch host holds the key
  test('every BG1 unit passes BG1_GEMINI_API_KEY and maps it to Gemini, never GEMINI_API_KEY; q1, f6 and rs1 units pass only their own providers\' keys', () => {
    const units = [...bg1CampaignManifest(m, { units: sel }).cells, ...bg1CampaignManifest(m, { smoke: true, units: { ...sel, campaign_id: 'q1-scoreboard-bg1-stage1', units: ['bg1-dev3.baseline-none.baseline'] } }).cells];
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
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', PARTICLE_API_KEY: '', VOYAGE_API_KEY: '' };
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
  });
});

describe('reread-cell.ts on BG1', () => {
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
