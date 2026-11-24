/**
 * The weekly line's execution wiring (gbrain-evals#619's open notes OV1 to OV5, GBEV-3's rulings B and E): the weekly cells
 * #619 plans run through the q1 cell path. Keyless: every key is blank or a placeholder, fetch throws for the whole file
 * unless a test names a local loopback, and no test resolves a real tag or reaches a provider.
 *
 *   OV2  every gate that guards money or sealed data takes Set W (bgw) as it takes BG1: the paid-window guard, the BG1
 *        campaign protections, the campaign launch check, the re-read's Gemini key and the VM's custody wipe.
 *   OV1  a weekly unit resolves from its week's cells.json (`--manifest weekly`) under the run id and hash its launch
 *        recorded; the launch writes a campaign whose units run in the window, export the run and week, and push only
 *        the week's worlds and the cells.json to their VMs.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { bg1LaunchProblems } from '../../eval/runner/bg1/launch.ts';
import { freePort } from '../../eval/runner/lifecycle/slice.ts';
import { bgwBatchDataset } from '../../eval/runner/memory-qa/bg1-names.ts';
import type { Bg1Manifest } from '../../eval/runner/memory-qa/corpus.ts';
import { sha256, WEEKLY_CELLS_ENV, WEEKLY_CELLS_SHA256_ENV, WEEKLY_RUN_ENV } from '../../eval/runner/memory-qa/records.ts';
import { findCell, windowedRunGuard } from '../../eval/runner/q1/cell.ts';
import { generateWeeklyLineCells, WEEKLY_LINE_MODELS } from '../../eval/runner/q1/cells/weekly-line.ts';
import { rereadKeys } from '../../eval/runner/q1/reread-cell.ts';
import { ScoreboardError } from '../../eval/runner/q1/scoreboard-errors.ts';
import { Campaign, runRemote, weeklyCustodyPush, type CampaignManifest } from '../../eval/runner/shootout-cell.ts';
import { CAMPAIGN_FILE, CELLS_FILE, launchWeek, planWeek, weeklyLaunchCheck, WIRED_CELL_SET, type RunnerDeps } from '../../eval/runner/weekly-line/runner.ts';

const tmp = mkdtempSync(join(tmpdir(), 'weekly-line-execution-'));
let n = 0;
const scratch = (name: string) => { const d = join(tmp, `${name}-${++n}`); mkdirSync(d, { recursive: true }); return d; };
const realFetch = globalThis.fetch;
beforeAll(() => { globalThis.fetch = (() => { throw new Error('the weekly execution tests are offline'); }) as unknown as typeof fetch; });
afterAll(() => { globalThis.fetch = realFetch; rmSync(tmp, { recursive: true, force: true }); });
let saved: NodeJS.ProcessEnv = {};
beforeEach(() => { saved = { ...process.env }; for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'BG1_GEMINI_API_KEY', 'PARTICLE_API_KEY', 'VOYAGE_API_KEY', 'SHOOTOUT_PROXY', 'SHOOTOUT_KEYLESS_UPSTREAM']) process.env[k] = ''; });
afterEach(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); });

/** Every provider at a dead local port, so a proxy started here can reach none of them. */
const DEAD_UPSTREAMS = Object.fromEntries(['anthropic', 'openai', 'voyage', 'particle', 'gemini'].map(p => [p, 'http://127.0.0.1:9']));
const refused = async (p: Promise<unknown>) => { try { await p; } catch (e) { if (e instanceof ScoreboardError) return e.op; throw e; } return null; };
const refusal = (f: () => unknown) => { try { f(); } catch (e) { if (e instanceof ScoreboardError) return e.op; throw e; } return null; };
const message = (f: () => unknown) => { try { f(); } catch (e) { return (e as Error).message; } return null; };
const REPO = resolve(import.meta.dir, '../..');

/** A fixture week: two Set W worlds of the first batch, launched on Tuesday 2026-12-08, at a made-up gbrain build. */
const WEEK = { launch: '2026-12-08', world_end: '2026-12-06', batch: 'bgw-1001' };
const WORLDS = ['bgw-1001', 'bgw-1002'];
const GBRAIN = { release: 'v0.61.10.0', commit: '2'.repeat(40) };
const cells = generateWeeklyLineCells({ week: WEEK, worlds: WORLDS, gbrain: GBRAIN });

describe('OV2: Set W spends only inside a granted window', () => {
  // Value: protects=a weekly cell's `run` refuses before any provider client, corpus or output exists when no paid window is granted; fails_when=the guard in front of `cell.ts run` still covers only isBg1Benchmark, which leaves bgw out, so a weekly cell runs on the shell's keys with no window; why_new=#619 OV2 (GBEV-3 ruling B: no weekly cell executes until this guard is on main); seam=cell.ts windowedRunGuard, the code `run` calls before anything else; no_claim=the window's cap arithmetic (bg1-window.test.ts)
  test('every weekly cell refuses to run without a granted paid window, and its refusal names the weekly manifest', async () => {
    for (const def of cells) {
      const op = await refused(windowedRunGuard([], def, { GBRAIN_EVALS_BG1_WORLD_END: WEEK.world_end }));
      expect(op).toMatchObject({ code: 'PAID_FLAGS_MISSING', message: expect.stringContaining(`Set W cell ${def.id}`) });
      expect(op!.fix.argv).toEqual(expect.arrayContaining(['--manifest', 'weekly', '--paid-window']));
    }
  });

  // Value: protects=a weekly re-read's lease proxy never holds a Gemini key, since no weekly answer gets the Gemini view; fails_when=rereadKeys hands a bgw re-read the shell's GEMINI_API_KEY as it would a non-BG1 cell; why_new=#615's note that isBg1Benchmark leaves bgw out, applied to the re-read's keys; seam=reread-cell.ts rereadKeys; no_claim=the other providers' keys, which a paid re-read reads by name
  test("a weekly re-read's provider keys carry no Gemini key", () => {
    const keys = rereadKeys(cells[0], false, { GEMINI_API_KEY: 'decoy-not-a-key', ANTHROPIC_API_KEY: 'placeholder' });
    expect(keys.GEMINI_API_KEY).toBeUndefined();
    expect(keys.ANTHROPIC_API_KEY).toBe('placeholder');
  });

  /** A Q1 campaign manifest holding one weekly unit, as a launch would write it. */
  const campaignWith = (command: string): CampaignManifest => ({ kind: 'q1-scoreboard-campaign', schema_version: 1, campaign_id: 'q1-scoreboard-wl-test', cap_usd: 50, ledger: join(scratch('campaign'), 'campaign.sqlite'), executes: ['bun.lock'], images: {},
    blocks: { BGW: { estimate_usd: 20, cap_usd: 50 } }, cells: [{ id: cells[0].id, system: cells[0].system, benchmark: 'bgw', config: cells[0].configuration, lease_usd: 5, command, block: 'BGW', sealed: true, vm: { size: 'standard-4' } }] });

  // Value: protects=a campaign holding weekly units gets the BG1 campaign protections (leases.lock, the events hash, lease binding) and the launch check before any VM boots, which refuses where the week's cells can't be read; fails_when=Campaign.bg1 or bg1LaunchProblems still look only at bg1, bg1c and bg1-dev, so a weekly campaign boots with no lease or window-cap check; why_new=#619 OV2 (every gate that guards money must include bgw); seam=Campaign.bg1 and bg1/launch.ts bg1LaunchProblems; no_claim=the lease prices themselves (OV1's tests)
  test('a weekly campaign takes the BG1 campaign protections, and its launch check refuses a unit outside the window', () => {
    const m = campaignWith('bun eval/runner/q1/cell.ts run --cell x --out "$SHOOTOUT_OUT"');
    const dir = scratch('campaign');
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m));
    expect(new Campaign(join(dir, 'manifest.json'), join(dir, 'state')).bg1).toBe(true);
    expect(() => bg1LaunchProblems(m)).toThrow(/--manifest weekly reads the week's cells.json from GBRAIN_EVALS_WEEKLY_CELLS, which is not set/);
  });

  // Value: protects=a weekly unit's VM deletes its Set W worlds and the week's cell file at teardown; fails_when=runRemote's teardown list omits bgw and weekly, so sealed worlds stay on the VM; why_new=the custody lane's step 1 (the VMs delete their copies at teardown); seam=shootout-cell.ts runRemote teardown; no_claim=ubi-runner's push itself
  test("a weekly unit's VM wipes its custody copies at teardown", async () => {
    const base = scratch('vm');
    for (const d of ['bgw', 'weekly']) { mkdirSync(join(base, d), { recursive: true }); writeFileSync(join(base, d, 'f'), 'x'); }
    globalThis.fetch = realFetch;
    let exit: number;
    try {
      exit = await runRemote({ lease_id: 'lease-w', lease_usd: 0.1, out: join(base, 'out', 'w', 'lease-w'), cell: 'w', sealed: true, command: '[ -f "$SHOOTOUT_CUSTODY/../bgw/f" ] && [ -f "$SHOOTOUT_CUSTODY/../weekly/f" ] || exit 9' },
        { port: await freePort(0), custodyBase: base, upstream: DEAD_UPSTREAMS });
    } finally { globalThis.fetch = (() => { throw new Error('the weekly execution tests are offline'); }) as unknown as typeof fetch; }
    expect(exit).toBe(0);
    expect([existsSync(join(base, 'bgw')), existsSync(join(base, 'weekly'))]).toEqual([false, false]);
  }, 30_000);
});

// ─── OV1 ─────────────────────────────────────────────────────────────

const TAGS = `${GBRAIN.commit}\trefs/tags/${GBRAIN.release}`;
const runnerDeps = (): RunnerDeps => ({ now: () => new Date('2026-12-08T12:00:00Z'), lsRemote: () => TAGS, cellSet: WIRED_CELL_SET, launchCheck: weeklyLaunchCheck({ ripgrep: () => 'ripgrep 14.1.1', registry: WEEKLY_LINE_MODELS }) });

/** A custodian's Set W batch root for the fixture week: placeholder world files and a filled manifest pinning them (no world is read through it). */
function custodyBatch(kept = WORLDS) {
  const root = scratch('bgw-set');
  const files = kept.flatMap(id => ['world.json', 'questions.json'].map(f => {
    mkdirSync(join(root, 'worlds', id), { recursive: true });
    writeFileSync(join(root, 'worlds', id, f), `${id} ${f}`);
    return { path: `worlds/${id}/${f}`, sha256: sha256(`${id} ${f}`) };
  }));
  const manifest: Bg1Manifest = { dataset: bgwBatchDataset(1001), status: 'filled', layout: 'test', note: 'fixture', filled_at: '2026-12-01', kept: [...kept], n_final: kept.length, files };
  const path = join(root, 'bgw-1001-manifest.json');
  writeFileSync(path, JSON.stringify(manifest));
  return { root, path, manifest };
}

/** The fixture week planned and launched by the real runner, with the wired cell set, inside the window WL-T at cap 500. */
function launchedWeek() {
  const dir = scratch('run');
  const set = custodyBatch();
  const { run } = planWeek({ dir, launch: WEEK.launch, batch: { first: 1001, week1: WEEK.launch, manifest: set.manifest } }, runnerDeps());
  process.env.GBRAIN_EVALS_BGW_MANIFEST = set.path;
  const order = launchWeek(dir, 'WL-T', runnerDeps(), 500);
  const cellsPath = join(dir, CELLS_FILE);
  return { dir, run, order, set, cellsPath, campaign: JSON.parse(readFileSync(join(dir, CAMPAIGN_FILE), 'utf8')) as CampaignManifest };
}

describe('OV1: the weekly units resolve and run under their week', () => {
  // Value: protects=a unit id the week's launch hands over resolves at execution to the definition in that week's cells.json, and only under the run id and cells.json the launch recorded; fails_when=--manifest weekly is refused (findCell knows only the committed manifests), or a unit resolves from another run's or an edited cells.json; why_new=#619 OV1; seam=cell.ts findCell and loadWeeklyCells; no_claim=forged files with a recomputed hash, outside the crew's threat model
  test("every launch unit resolves from the week's cells.json, and only under the launch's record of it", () => {
    const w = launchedWeek();
    const env = w.order.env;
    expect(env).toMatchObject({ [WEEKLY_RUN_ENV]: w.run.run_id, [WEEKLY_CELLS_ENV]: w.cellsPath, [WEEKLY_CELLS_SHA256_ENV]: sha256(readFileSync(w.cellsPath)), GBRAIN_EVALS_BG1_WORLD_END: WEEK.world_end, GBRAIN_EVALS_BGW_BATCH: 'bgw-1001', GBRAIN_EVALS_BGW_UNIT: WORLDS.join(',') });
    const defs = JSON.parse(readFileSync(w.cellsPath, 'utf8')).cells;
    for (const unit of w.order.stages[0].units) expect(findCell(unit, undefined, 'weekly', env)).toEqual(defs.find((d: { id: string }) => d.id === unit));
    const unit = w.order.stages[0].units[0];
    expect(refusal(() => findCell(unit, undefined, 'weekly', { ...env, [WEEKLY_CELLS_SHA256_ENV]: 'a'.repeat(64) }))?.message).toMatch(/hashes to .*, not the aaaaaaaaaaaa the week's launch recorded/);
    expect(refusal(() => findCell(unit, undefined, 'weekly', { ...env, [WEEKLY_RUN_ENV]: `wl-2026-12-08-${'0'.repeat(12)}` }))?.message).toMatch(/holds run wl-2026-12-08-[0-9a-f]{12}'s cells, and GBRAIN_EVALS_WEEKLY_RUN names wl-2026-12-08-000000000000/);
    expect(refusal(() => findCell(unit, undefined, 'weekly', { ...env, [WEEKLY_CELLS_ENV]: undefined }))?.message).toMatch(/GBRAIN_EVALS_WEEKLY_CELLS, which is not set/);
    expect(refusal(() => findCell(unit, undefined, 'weekly', { ...env, [WEEKLY_CELLS_SHA256_ENV]: undefined }))?.message).toMatch(/has no launch record/);
  });

  // Value: protects=the week's launch writes a campaign whose every unit runs from the week's cells.json inside the window and exports its run id, cells.json hash and world end, so each VM's run, loader and records name that week; fails_when=a VM unit spec lacks the run id (the #619 note: the cell refuses after its VM boots), runs another manifest, runs outside the window, or isn't sealed to its week's worlds; why_new=#619 OV1 (forward the run id and week to the cell VMs); seam=runner.ts launchWeek and cell.ts weeklyCampaignManifest over campaignCells; no_claim=ubi-runner itself
  test("the week's campaign runs every unit from its cells.json in the window, exporting the run and week", () => {
    const w = launchedWeek();
    const sha = sha256(readFileSync(w.cellsPath));
    expect(w.campaign.cells.map(c => c.id).sort()).toEqual([...w.order.stages[0].units].sort());
    expect([w.campaign.weekly_cells_sha256, w.campaign.bgw_manifest_sha256, w.order.campaign, w.order.cap_usd]).toEqual([sha, sha256(readFileSync(w.set.path)), CAMPAIGN_FILE, 500]);
    for (const c of w.campaign.cells) {
      expect(c.command.startsWith(`export ${WEEKLY_RUN_ENV}=${w.run.run_id}; export ${WEEKLY_CELLS_SHA256_ENV}=${sha}; export GBRAIN_EVALS_BG1_WORLD_END=${WEEK.world_end}; `)).toBe(true);
      expect(c.command).toContain(`--cell ${c.id} --manifest weekly `);
      expect(c.command).toContain('--paid-window WL-T --window-cap-usd 500 --out "$SHOOTOUT_OUT"');
      expect([c.sealed, c.weekly_unit, c.benchmark, Number.isInteger(c.wave)]).toEqual([true, { batch: 'bgw-1001', worlds: WORLDS }, 'bgw', true]);
      expect([c.pass, c.providers, c.gemini_key_env]).toEqual([expect.not.arrayContaining(['GEMINI_API_KEY', 'BG1_GEMINI_API_KEY']), expect.not.arrayContaining(['gemini']), undefined]);
    }
    expect(w.order.rereads!.map(r => r.id)).toEqual(w.run.rereads);
    for (const r of w.order.rereads!) expect(r.argv).toEqual(expect.arrayContaining(['eval/runner/q1/reread-cell.ts', '--manifest', 'weekly', '--reader', 'particle:particle-1', '--paid-window', 'WL-T', '--window-cap-usd', '500']));
    Object.assign(process.env, { [WEEKLY_CELLS_ENV]: w.cellsPath, [WEEKLY_CELLS_SHA256_ENV]: sha, [WEEKLY_RUN_ENV]: w.run.run_id });
    expect(bg1LaunchProblems(w.campaign)).toEqual([]);
    const edited = { ...w.campaign, cells: w.campaign.cells.map((c, i) => (i ? c : { ...c, lease_usd: c.lease_usd + 1 })) };
    expect(bg1LaunchProblems(edited)).toContain(`unit ${w.campaign.cells[0].id} leases ${w.campaign.cells[0].lease_usd + 1}, not the ${w.campaign.cells[0].lease_usd} the week's cells.json prices it at`);
    expect(message(() => launchWeek(w.dir, 'WL-T', runnerDeps()))).toMatch(/WEEKLY_NO_WINDOW: .*--window-cap-usd/);
  });

  // Value: protects=a weekly unit's VM receives exactly its week's pinned Set W worlds and the week's cells.json, both held to the hashes its campaign recorded; fails_when=Campaign.custodyPush has no bgw branch (the VM gets no worlds and no cells.json), pushes another week's or an unkept world, or accepts a cells.json or batch manifest the campaign did not record; why_new=#619 OV1 and the custody lane's step 1 (copy one week's worlds to each cell VM); seam=shootout-cell.ts weeklyCustodyPush, Campaign.custodyPush and launchArgv; no_claim=ubi-runner's push itself
  test("a weekly unit pushes only its week's worlds and the cells.json, against the campaign's recorded hashes", () => {
    const w = launchedWeek();
    const env = { GBRAIN_EVALS_BGW_SOURCE: w.set.root, GBRAIN_EVALS_BGW_MANIFEST: w.set.path, [WEEKLY_CELLS_ENV]: w.cellsPath };
    const push = weeklyCustodyPush(env, 'c', { batch: 'bgw-1001', worlds: WORLDS });
    expect(push).toEqual({ source: w.set.root, dest: 'custody/bgw', list: [...WORLDS.flatMap(id => [`worlds/${id}/world.json`, `worlds/${id}/questions.json`]), 'bgw-1001-manifest.json'],
      env: ['GBRAIN_EVALS_BGW_SOURCE=~/custody/bgw', 'GBRAIN_EVALS_BGW_MANIFEST=~/custody/bgw/bgw-1001-manifest.json', `GBRAIN_EVALS_BGW_UNIT=${WORLDS.join(',')}`, 'GBRAIN_EVALS_BGW_BATCH=bgw-1001', `${WEEKLY_CELLS_ENV}=~/custody/weekly/cells.json`],
      also: [{ source: w.dir, dest: 'custody/weekly', list: ['cells.json'] }] });
    expect(refusal(() => weeklyCustodyPush(env, 'c', { batch: 'bgw-1001', worlds: ['bgw-1001', 'bgw-1003'] }))?.message).toMatch(/1 of the unit's worlds \(first bgw-1003\) are not on the Set W batch bgw-1001 manifest's kept list/);
    expect(refusal(() => weeklyCustodyPush({ ...env, [WEEKLY_CELLS_ENV]: undefined }, 'c', { batch: 'bgw-1001', worlds: WORLDS }))?.message).toMatch(/needs the week's cells.json/);
    const dir = scratch('campaign');
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(w.campaign));
    const c = new Campaign(join(dir, 'manifest.json'), join(dir, 'state'));
    const id = w.campaign.cells[0].id;
    expect(c.custodyPush(id, env)).toEqual(push);
    Object.assign(process.env, env);
    const argv = c.launchArgv({ lease_id: `${id}-a1-e`, cell: id, attempt: 1, usd: w.campaign.cells[0].lease_usd, entry_id: 'e', max_output_tokens: null, status: 'reserved' }, { vm: 'vm' });
    expect(argv.filter((a, i) => argv[i - 1] === '--push').map(a => a.split(':').slice(0, 2).join(':'))).toEqual([`${w.set.root}:custody/bgw`, `${w.dir}:custody/weekly`]);
    const edited = join(scratch('edited'), 'cells.json');
    writeFileSync(edited, readFileSync(w.cellsPath, 'utf8') + ' ');
    expect(refusal(() => c.custodyPush(id, { ...env, [WEEKLY_CELLS_ENV]: edited }))?.message).toMatch(/the week's cells.json is not the one campaign .* recorded/);
  });

  // Value: protects=`cell.ts run --manifest weekly` on a weekly unit refuses before writing anything when no window is granted, end to end through the CLI; fails_when=the CLI can't resolve a weekly unit, or resolves one and runs it outside a window; why_new=#619 OV1 with OV2 (GBEV-3 ruling B); seam=cell.ts main run, blank keys, no proxy; no_claim=a run inside a window (the dry run below)
  test('cell.ts run --manifest weekly resolves a unit and refuses it outside a window', () => {
    const w = launchedWeek();
    const unit = w.order.stages[0].units[0];
    const out = join(scratch('cli'), 'out');
    const r = spawnSync('bun', ['eval/runner/q1/cell.ts', 'run', '--cell', unit, '--manifest', 'weekly', '--out', out], { cwd: REPO, encoding: 'utf8', timeout: 60_000,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', PARTICLE_API_KEY: '', VOYAGE_API_KEY: '', ...w.order.env } });
    expect([r.status, existsSync(out)]).toEqual([2, false]);
    expect(r.stderr).toContain(`[PAID_FLAGS_MISSING] Set W cell ${unit} spends real keys`);
  }, 60_000);
});

