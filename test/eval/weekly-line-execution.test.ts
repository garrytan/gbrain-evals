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
 *   OV3  a weekly cell, its re-read and its merge open exactly the week's worlds, never the rest of the batch, and
 *        refuse another batch, unit scope, world end or week's sources.
 *   OV4  a weekly re-read is graded by its reader's preregistered gating judge alone (claude-opus-5-5 for particle-1).
 *   OV5  settle holds every re-read to its own records under the real re-read id, not its arm's.
 *   Dry run: the fixture week runs from plan to aggregates through the runner, the week's campaign, the real lease proxy
 *        in front of a scripted loopback upstream and the re-reads the launch hands over.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { bg1LaunchProblems } from '../../eval/runner/bg1/launch.ts';
import { BudgetRun } from '../../eval/runner/budget-ledger.ts';
import { freePort } from '../../eval/runner/lifecycle/slice.ts';
import { bgwBatchDataset } from '../../eval/runner/memory-qa/bg1-names.ts';
import { BG1_FIXTURES_ROOT, bg1Conversation, type Bg1Manifest, type Corpus } from '../../eval/runner/memory-qa/corpus.ts';
import type { ChatLike, ChatResult } from '../../eval/runner/memory-qa/qa-v2.ts';
import { DEFAULT_ROUTE_CAPS, keylessKeys, keylessUpstream, MeteringProxy } from '../../eval/runner/metering-proxy.ts';
import { sha256, WEEKLY_CELLS_ENV, WEEKLY_CELLS_SHA256_ENV, WEEKLY_RUN_ENV } from '../../eval/runner/memory-qa/records.ts';
import { findCell, runCell, windowedRunGuard } from '../../eval/runner/q1/cell.ts';
import { pinnedJudgeRouteCaps } from '../../eval/runner/q1/cells/definitions.ts';
import { generateWeeklyLineCells, WEEKLY_LINE_MODELS } from '../../eval/runner/q1/cells/weekly-line.ts';
import { prepareReread, rereadArm, rereadCellId, rereadKeys, rereadRouteCaps, runReread } from '../../eval/runner/q1/reread-cell.ts';
import { ScoreboardError } from '../../eval/runner/q1/scoreboard-errors.ts';
import { Campaign, DEFAULT_ROUTE_CLASSES, runRemote, weeklyCustodyPush, type CampaignManifest } from '../../eval/runner/shootout-cell.ts';
import { FakeMemorySystem } from '../../eval/runner/systems/fake.ts';
import type { AgentAnswer } from '../../eval/runner/systems/file-agent.ts';
import { main as aggregatesMain } from '../../eval/runner/weekly-line/aggregates.ts';
import { WL_ROWS } from '../../eval/runner/weekly-line/design.ts';
import { CAMPAIGN_FILE, CELLS_FILE, launchWeek, markStep, planWeek, settleWeek, weeklyLaunchCheck, WIRED_CELL_SET, type RunnerDeps } from '../../eval/runner/weekly-line/runner.ts';

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
    const cellsCap = w.order.cells_cap_usd!, rereadsCap = w.order.rereads_cap_usd!;
    expect([w.campaign.weekly_cells_sha256, w.campaign.bgw_manifest_sha256, w.order.campaign, w.order.cap_usd, w.campaign.cap_usd]).toEqual([sha, sha256(readFileSync(w.set.path)), CAMPAIGN_FILE, 500, cellsCap]);
    for (const c of w.campaign.cells) {
      expect(c.command.startsWith(`export ${WEEKLY_RUN_ENV}=${w.run.run_id}; export ${WEEKLY_CELLS_SHA256_ENV}=${sha}; export GBRAIN_EVALS_BG1_WORLD_END=${WEEK.world_end}; `)).toBe(true);
      expect(c.command).toContain(`--cell ${c.id} --manifest weekly `);
      expect(c.command).toContain(`--paid-window WL-T --window-cap-usd ${cellsCap} --out "$SHOOTOUT_OUT"`);
      expect([c.sealed, c.weekly_unit, c.benchmark, Number.isInteger(c.wave)]).toEqual([true, { batch: 'bgw-1001', worlds: WORLDS }, 'bgw', true]);
      expect([c.pass, c.providers, c.gemini_key_env]).toEqual([expect.not.arrayContaining(['GEMINI_API_KEY', 'BG1_GEMINI_API_KEY']), expect.not.arrayContaining(['gemini']), undefined]);
    }
    expect(w.order.rereads!.map(r => r.id)).toEqual(w.run.rereads);
    for (const r of w.order.rereads!) expect(r.argv).toEqual(expect.arrayContaining(['eval/runner/q1/reread-cell.ts', '--manifest', 'weekly', '--reader', 'particle:particle-1', '--paid-window', 'WL-T', '--window-cap-usd', String(rereadsCap)]));
    Object.assign(process.env, { [WEEKLY_CELLS_ENV]: w.cellsPath, [WEEKLY_CELLS_SHA256_ENV]: sha, [WEEKLY_RUN_ENV]: w.run.run_id });
    expect(bg1LaunchProblems(w.campaign)).toEqual([]);
    const edited = { ...w.campaign, cells: w.campaign.cells.map((c, i) => (i ? c : { ...c, lease_usd: c.lease_usd + 1 })) };
    expect(bg1LaunchProblems(edited)).toContain(`unit ${w.campaign.cells[0].id} leases ${w.campaign.cells[0].lease_usd + 1}, not the ${w.campaign.cells[0].lease_usd} the week's cells.json prices it at`);
    expect(message(() => launchWeek(w.dir, 'WL-T', runnerDeps()))).toMatch(/WEEKLY_NO_WINDOW: .*--window-cap-usd/);
  });

  // Value: protects=one granted window's cap is split once between the week's cells and its re-reads, so following the printed order can't approve more than the window; fails_when=launchWeek hands the full cap to both the campaign and every re-read command, so cell leases plus a re-read ledger cap set to the window cap approve up to about twice it (/ship review finding p1/red-team#2), or a cap too small for the re-reads leaves the cells a zero or negative campaign; why_new=PR #621's review; seam=runner.ts launchWeek; no_claim=the estimates themselves
  test("the window's cap is split once: the re-reads take their estimates and the cells' campaign the rest", () => {
    const w = launchedWeek();
    const plans = JSON.parse(readFileSync(w.cellsPath, 'utf8')).rereads as Array<{ estimate: { usd: number } }>;
    const rereadsCap = Math.ceil(plans.reduce((n, r) => n + r.estimate.usd, 0) * 100) / 100;
    expect([w.order.rereads_cap_usd, w.order.cells_cap_usd]).toEqual([rereadsCap, Math.floor((500 - rereadsCap) * 100) / 100]);
    expect(w.order.cells_cap_usd! + w.order.rereads_cap_usd!).toBeLessThanOrEqual(500);
    for (const r of w.order.rereads!) expect(r.argv[r.argv.indexOf('--window-cap-usd') + 1]).toBe(String(rereadsCap));
    for (const c of w.campaign.cells) expect(/--window-cap-usd (\S+)/.exec(c.command)![1]).toBe(String(w.campaign.cap_usd));
    expect(message(() => launchWeek(w.dir, 'WL-T', runnerDeps(), rereadsCap))).toMatch(/^WEEKLY_NO_WINDOW: .*leaves the cells nothing of the window's cap/);
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

  // Value: protects=on a cell VM, where the custody push names the cells.json as the literal ~/custody/weekly/cells.json (ubi-runner writes it with %q, so no shell expands it), cell.ts still resolves the unit; fails_when=loadWeeklyCells checks the literal '~/' path, so every weekly unit refuses after its VM boots (/ship review finding p1/red-team#1, QA captures 002 and 003); why_new=PR #621's review; seam=cell.ts main run with the push's own env value and HOME at a temporary VM home; no_claim=ubi-runner's push itself
  test("on a VM, cell.ts resolves the unit from the push's '~/custody/weekly/cells.json'", () => {
    const w = launchedWeek();
    const unit = w.order.stages[0].units[0];
    const home = scratch('vm-home');
    mkdirSync(join(home, 'custody', 'weekly'), { recursive: true });
    cpSync(w.cellsPath, join(home, 'custody', 'weekly', 'cells.json'));
    const pushed = weeklyCustodyPush({ GBRAIN_EVALS_BGW_SOURCE: w.set.root, GBRAIN_EVALS_BGW_MANIFEST: w.set.path, [WEEKLY_CELLS_ENV]: w.cellsPath }, 'c', { batch: 'bgw-1001', worlds: WORLDS }).env.find(e => e.startsWith(`${WEEKLY_CELLS_ENV}=`))!.split('=')[1];
    expect(pushed).toBe('~/custody/weekly/cells.json');
    const out = join(scratch('cli'), 'out');
    const r = spawnSync('bun', ['eval/runner/q1/cell.ts', 'run', '--cell', unit, '--manifest', 'weekly', '--out', out], { cwd: REPO, encoding: 'utf8', timeout: 60_000,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', PARTICLE_API_KEY: '', VOYAGE_API_KEY: '', ...w.order.env, [WEEKLY_CELLS_ENV]: pushed } });
    expect([r.status, existsSync(out), r.stderr.split('\n')[0]]).toEqual([2, false, expect.stringContaining(`[PAID_FLAGS_MISSING] Set W cell ${unit} spends real keys`)]);
  }, 60_000);
});


// ─── OV3 ─────────────────────────────────────────────────────────────

const NO_META = { finish: 'stop', usage: null, response_model: null, attempt_errors: [] as string[] };
const quiet = { probeIntervalMs: 5, probeTimeoutMs: 2000 };
const answerOf = (prompt: string) => { const q = /Question: (.*)\n/.exec(prompt)?.[1] ?? ''; return `${sha256(q)[0] === '0' ? 'WRONG' : 'RIGHT'} ${q}`; };
const verdictOf = (prompt: string) => JSON.stringify({ correct: /\nResponse: RIGHT/.test(prompt) ? 1 : 0 });
/** In-process reader and judge: no client, no network; the judge records the model each grade went to. */
const scripted = () => {
  const judged: string[] = [];
  const reader: ChatLike = { async chat(_m, prompt): Promise<ChatResult> { return { text: answerOf(prompt), input_tokens: 10, output_tokens: 8, cached: false, ...NO_META }; } };
  const judge: ChatLike = { async chat(model, prompt): Promise<ChatResult> { judged.push(model); return { text: verdictOf(prompt), input_tokens: 100, output_tokens: 4, cached: false, ...NO_META }; } };
  return { reader, judge, judged };
};
/** The committed template fixtures bg1-dev-01 to bg1-dev-0k under Set W ids. */
const fixtureFiles = (ids: readonly string[]) => ids.map((id, i) => {
  const dev = `bg1-dev-0${i + 1}`;
  const read = (f: string) => readFileSync(join(BG1_FIXTURES_ROOT, 'worlds', dev, f), 'utf8').replaceAll(dev, id);
  return { id, world: read('world.json'), questions: read('questions.json') };
});
const fixtureCorpus = (ids: readonly string[], worldEnd = WEEK.world_end): Corpus => {
  const parts = fixtureFiles(ids).map(f => bg1Conversation(f.id, f.world, f.questions, worldEnd));
  return { benchmark: 'bgw', conversations: parts.map(p => p.conversation), questions: parts.flatMap(p => p.questions), source: { name: bgwBatchDataset(1001), files: [], revision: 'synthetic-fill', license: 'test' } };
};
/**
 * A custody host for the fixture batch: three Set W worlds (the week's two and bgw-1003, a later week's) as template
 * fixtures under a root outside the repository, pinned by a filled manifest, with the access log and the week's run
 * named in process.env as the custody host's launch names them. No unit scope is set, as on the custody host.
 */
function custodyHost(launch = WEEK.launch, worldEnd = WEEK.world_end, kept = ['bgw-1001', 'bgw-1002', 'bgw-1003']) {
  const root = scratch('bgw-host');
  const files = fixtureFiles(kept).flatMap(f => (['world', 'questions'] as const).map(k => {
    const path = `worlds/${f.id}/${k}.json`;
    mkdirSync(join(root, 'worlds', f.id), { recursive: true });
    writeFileSync(join(root, path), f[k]);
    return { path, sha256: sha256(f[k]) };
  }));
  const manifest: Bg1Manifest = { dataset: bgwBatchDataset(1001), status: 'filled', layout: 'test', note: 'fixture', filled_at: '2026-12-01', kept: [...kept], n_final: kept.length, files };
  writeFileSync(join(root, 'bgw-1001-manifest.json'), JSON.stringify(manifest));
  const log = join(scratch('custody-log'), 'access.ndjson');
  Object.assign(process.env, { GBRAIN_EVALS_BGW_SOURCE: root, GBRAIN_EVALS_BGW_MANIFEST: join(root, 'bgw-1001-manifest.json'), GBRAIN_EVALS_BGW_BATCH: 'bgw-1001',
    GBRAIN_EVALS_BG1_WORLD_END: worldEnd, GBRAIN_EVALS_CUSTODY_LOG: log, [WEEKLY_RUN_ENV]: `wl-${launch}-${'a'.repeat(12)}` });
  delete process.env.GBRAIN_EVALS_BGW_UNIT;
  const opened = () => readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l).purpose as string).filter(p => /^bgw bgw-/.test(p)).map(p => p.split(' ')[1].replace(/:$/, ''));
  return { root, log, opened };
}
const memoryBank = cells.find(c => c.id === 'bgw.ext-memory-bank.recipe')!;
const OPUS = 'anthropic:claude-opus-5-5', ASTRA = 'openai:gpt-6-astra', PARTICLE = 'particle:particle-1';

describe("OV3: a weekly cell reads only its week's worlds", () => {
  // Value: protects=a weekly cell on the custody host opens, answers and scores exactly its week's worlds, never the rest of its batch; fails_when=runCell gives a weekly cell no unit scope (it has no kept_units), so the loader opens every world of the batch, a later week's included; why_new=#619's deferred finding at cell.ts:677 (the corpus loader is not given week.worlds); seam=runCell over the real Set W loader on template fixtures under a custody root, in-process reader and judge; no_claim=the system's or judge's quality
  test("on the custody host, a weekly cell opens and answers its week's two worlds and not the batch's third", async () => {
    const host = custodyHost();
    const out = join(scratch('cell'), 'out');
    const s = scripted();
    await runCell(memoryBank, { out, ...quiet }, { system: new FakeMemorySystem(), reader: s.reader, judge: s.judge });
    const arm = memoryBank.arms[0];
    const receipt = JSON.parse(readFileSync(join(out, 'cells', arm.cell_id, 'receipt.json'), 'utf8'));
    expect(receipt.realizations.map((r: { conversation: string }) => r.conversation)).toEqual(WORLDS);
    expect([...new Set(host.opened())].sort()).toEqual(WORLDS);
    expect([...new Set(s.judged)]).toEqual([ASTRA]);
  }, 120_000);

  // Value: protects=a weekly cell refuses, before its --out exists, an environment naming another batch, unit scope or world end than its week's, and any corpus holding a world outside its week or missing one of its worlds; fails_when=a VM's pushed unit, a re-planned launch's batch or a stale world end runs the cell on other worlds or dates, or a supplied corpus is answered whole; why_new=#619 OV3; seam=runCell's weekScope and weekCorpusProblems; no_claim=forged files, outside the crew's threat model
  test("a weekly cell refuses another batch, unit scope or world end, and a corpus that is not exactly its week", async () => {
    custodyHost();
    const s = scripted();
    const run = (name: string, corpus?: Corpus) => { const out = join(scratch(name), 'out'); return { out, p: runCell(memoryBank, { out, ...quiet }, { system: new FakeMemorySystem(), reader: s.reader, judge: s.judge, ...(corpus ? { corpus } : {}) }) }; };
    for (const [k, v] of [['GBRAIN_EVALS_BGW_UNIT', 'bgw-1001,bgw-1003'], ['GBRAIN_EVALS_BGW_BATCH', 'bgw-1035'], ['GBRAIN_EVALS_BG1_WORLD_END', '2026-12-13']] as const) {
      const was = process.env[k];
      process.env[k] = v;
      const r = run(k);
      expect(await refused(r.p)).toMatchObject({ code: 'PREFLIGHT_FAILED', message: expect.stringContaining(`${k} is ${v}`) });
      expect(existsSync(r.out)).toBe(false);
      if (was === undefined) delete process.env[k]; else process.env[k] = was;
    }
    process.env.GBRAIN_EVALS_BGW_UNIT = 'bgw-1002,bgw-1001';
    const extra = run('extra', fixtureCorpus(['bgw-1001', 'bgw-1002', 'bgw-1003']));
    expect((await refused(extra.p))?.message).toBe(`${memoryBank.id}'s corpus holds bgw-1003, outside week ${WEEK.launch}`);
    const short = run('short', fixtureCorpus(['bgw-1001']));
    expect((await refused(short.p))?.message).toBe(`${memoryBank.id}'s corpus is missing week ${WEEK.launch}'s bgw-1002`);
  }, 60_000);

  // Value: protects=a weekly re-read and merge load exactly the week's worlds, and a re-read refuses sources staging a world of another week, a corpus that isn't the week or an unfilled batch manifest; fails_when=prepareReread or cell.ts merge give a weekly cell no unit scope (they load the whole batch, or refuse under the launch's unit scope), a re-read takes another week's answers of the same cell id, or the filled-manifest check skips Set W; why_new=#619 OV3 applied to the re-read and merge; seam=prepareReread over the real Set W loader with the reader's gating judge named, and the cell.ts merge CLI with the launch's environment; no_claim=the re-read's grades (OV4 and the dry run)
  test("a weekly re-read loads its week's worlds, and refuses another week's answers of the same cell", async () => {
    const later = generateWeeklyLineCells({ week: { launch: '2026-12-15', world_end: '2026-12-13', batch: 'bgw-1001' }, worlds: ['bgw-1003'], gbrain: GBRAIN }).find(c => c.id === memoryBank.id)!;
    custodyHost('2026-12-15', '2026-12-13');
    const theirs = join(scratch('later'), 'out');
    const s = scripted();
    await runCell(later, { out: theirs, ...quiet }, { system: new FakeMemorySystem(), reader: s.reader, judge: s.judge });
    const host = custodyHost();
    const mine = join(scratch('mine'), 'out');
    await runCell(memoryBank, { out: mine, ...quiet }, { system: new FakeMemorySystem(), reader: s.reader, judge: s.judge });
    const arm = memoryBank.arms[0];
    const opts = (name: string, source: string) => ({ sources: [join(source, 'runs', memoryBank.id)], reader: PARTICLE, out: join(scratch(name), 'out'), gating: OPUS, manifest: 'weekly' as const });
    const wrong = opts('wrong', theirs);
    expect(refusal(() => prepareReread(memoryBank, arm, wrong))?.message).toBe(`the sources stage bgw-1003, outside week ${WEEK.launch}'s worlds (${WORLDS.join(', ')}) of ${memoryBank.id}`);
    expect(existsSync(wrong.out)).toBe(false);
    expect(refusal(() => prepareReread(memoryBank, arm, opts('extra', mine), { corpus: fixtureCorpus(['bgw-1001', 'bgw-1002', 'bgw-1003']) }))?.message).toBe(`${memoryBank.id}'s corpus holds bgw-1003, outside week ${WEEK.launch}`);
    expect(refusal(() => prepareReread(memoryBank, arm, opts('unfilled', mine), { corpus: { ...fixtureCorpus(WORLDS), source: { ...fixtureCorpus(WORLDS).source, revision: 'unfilled' } } }))?.message).toBe(`bgw: the Set W batch bgw-1001 manifest is unfilled, so ${arm.cell_id} cannot be re-read`);
    const before = host.opened().length;
    const p = prepareReread(memoryBank, arm, opts('right', mine));
    expect([p.verify.problems, p.gating, p.dataset.revision]).toEqual([[], OPUS, expect.stringMatching(/^[0-9a-f]{7}$/)]);
    expect([...new Set(host.opened().slice(before))].sort()).toEqual(WORLDS);

    const hostEnv = Object.fromEntries(['GBRAIN_EVALS_BGW_SOURCE', 'GBRAIN_EVALS_BGW_MANIFEST', 'GBRAIN_EVALS_CUSTODY_LOG'].map(k => [k, process.env[k]!]));
    const w = launchedWeek();
    const before2 = host.opened().length;
    const merged = join(scratch('merged'), 'out');
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', PARTICLE_API_KEY: '', VOYAGE_API_KEY: '',
      ...w.order.env, ...hostEnv };
    const r = spawnSync('bun', ['eval/runner/q1/cell.ts', 'merge', '--cell', memoryBank.id, '--manifest', 'weekly', '--from', mine, '--out', merged], { cwd: REPO, encoding: 'utf8', timeout: 60_000, env });
    expect([r.status, r.stderr.split('\n').filter(l => l.startsWith('['))]).toEqual([0, []]);
    expect([...new Set(host.opened().slice(before2))].sort()).toEqual(WORLDS);
  }, 120_000);
});


// ─── OV4 ─────────────────────────────────────────────────────────────

describe("OV4: a weekly re-read is graded by its reader's gating judge", () => {
  // Value: protects=particle-1's re-read of a weekly arm is graded by claude-opus-5-5 (bg1JudgeOf), its preregistered gating judge, alone, with no flag naming it, and a run naming another judge refuses; fails_when=prepareReread takes the arm's judge map, which names only claude-opus-5-5's judge, so the re-read refuses for want of a particle-1 judge or is graded by another judge; why_new=#619 OV4 and its deferred finding at reread-cell.ts:446 (the gating judge is not passed); seam=prepareReread and runReread over the real Set W loader, in-process reader and judge; no_claim=the grades themselves
  test("particle-1's re-read of a weekly arm is graded by claude-opus-5-5 alone, and another judge is refused", async () => {
    custodyHost();
    const mine = join(scratch('cell'), 'out');
    const live = scripted();
    await runCell(memoryBank, { out: mine, ...quiet }, { system: new FakeMemorySystem(), reader: live.reader, judge: live.judge });
    const arm = memoryBank.arms[0];
    const opts = (name: string, extra: { gating?: string; reader?: string } = {}) => ({ sources: [join(mine, 'runs', memoryBank.id)], reader: extra.reader ?? PARTICLE, out: join(scratch(name), 'out'), manifest: 'weekly' as const, ...(extra.gating ? { gating: extra.gating } : {}) });
    expect(refusal(() => prepareReread(memoryBank, arm, opts('astra', { gating: ASTRA })))?.message).toBe(`${arm.cell_id} is a weekly-line arm, so ${PARTICLE}'s re-read is graded by its preregistered gating judge ${OPUS}, not ${ASTRA}`);
    expect(refusal(() => prepareReread(memoryBank, arm, opts('gemini', { reader: 'gemini:gemini-3-pro' })))?.message).toMatch(/is a weekly-line arm, and no BG1 gating judge is preregistered for gemini:gemini-3-pro/);
    const p = prepareReread(memoryBank, arm, opts('particle'));
    expect([p.gating, p.cell_id]).toEqual([OPUS, `${arm.cell_id}.reread-particle-particle-1`]);
    const s = scripted();
    const res = await runReread(p, {}, { reader: s.reader, judge: s.judge });
    expect(res.status).toBe('complete');
    expect(res.receipt).toMatchObject({ instrument: { judge: null }, counts: { unjudged: 0 } });
    expect([...new Set(s.judged)]).toEqual([OPUS]);
    expect(s.judged.length).toBe((res.receipt as { counts: { answers: number } }).counts.answers);
  }, 120_000);
});


// ─── OV5 ─────────────────────────────────────────────────────────────

describe("OV5: settle covers every re-read by its own records", () => {
  // Value: protects=settle refuses a week whose particle-1 re-reads are marked done while their own answer and judgment files are missing, under the real re-read ids (<arm cell id>.reread-particle-particle-1, the cell id the re-read writes); fails_when=settle maps a re-read id to its arm's records because the id starts with the arm's id, so a week settles with no re-read record at all; why_new=#619 OV5 (GBEV-3 ruling E: no settle on real custody data until fixed, with a test on the real id shape); seam=runner.ts settleWeek over the wired cell set's real ids; no_claim=the records' contents (the dry run)
  test("a done re-read with no records of its own refuses settle, under the real re-read id", () => {
    const dir = scratch('settle');
    const { run, steps } = planWeek({ dir, launch: WEEK.launch, batch: { first: 1001, week1: WEEK.launch, manifest: custodyBatch().manifest } }, runnerDeps());
    const packed = cells.flatMap(c => c.arms.filter(a => a.mode === 'packed').map(a => a.cell_id));
    expect(run.rereads).toEqual(packed.map(id => rereadCellId(id, PARTICLE)));
    expect(run.rereads[0]).toMatch(/^bgw\.[a-z-]+\.[a-z0-9-]+\.[a-z0-9-]+\.reread-particle-particle-1$/);
    for (const s of steps) if (s.stage !== 'aggregates') markStep(dir, s.id, 'done');
    const touch = (ids: readonly string[]) => { for (const id of ids) { mkdirSync(join(dir, 'cells', id), { recursive: true }); for (const f of ['answers.ndjson', 'judgments.ndjson']) writeFileSync(join(dir, 'cells', id, f), ''); } };
    const costs = WL_ROWS.flatMap(row => (['claude-opus-5-5', 'particle-1'] as const).flatMap(reader => WORLDS.map(world => ({ row, reader, world, usd: 0.25 }))));
    touch(run.cells);
    const rereadSteps = steps.filter(s => s.target.includes('.reread-')).length, first = steps.find(s => s.stage === 'reread')!.target;
    expect(message(() => settleWeek(dir, { costs }))).toBe(`WEEKLY_RECORDS: ${rereadSteps} done steps have no record file in the run directory, so nothing is settled (first cells/${first}/answers.ndjson)`);
    expect(existsSync(join(dir, 'settled.json'))).toBe(false);
    touch(run.rereads.filter(id => id !== first));
    expect(message(() => settleWeek(dir, { costs }))).toBe(`WEEKLY_RECORDS: 2 done steps have no record file in the run directory, so nothing is settled (first cells/${first}/answers.ndjson)`);
    touch([first]);
    expect(settleWeek(dir, { costs }).steps).toMatchObject({ rereads: run.rereads.length });
  });
});


// ─── Dry run ─────────────────────────────────────────────────────────

/** A loopback upstream: readers answer RIGHT or WRONG by the question's hash, judges grade by that word, and a Gemini request fails; every request is logged. */
function scriptedUpstream() {
  const log: Array<{ path: string; model: string; judging: boolean; max: unknown }> = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const path = new URL(req.url).pathname, body = await req.json() as Record<string, any>;
    const prompt = (body.messages as Array<{ content: unknown }>).map(x => (typeof x.content === 'string' ? x.content : (x.content as Array<{ text?: string }>).map(c => c.text ?? '').join(''))).join('\n');
    const judging = /\nResponse: [\s\S]*?\n\nThe response is correct/.test(prompt);
    log.push({ path, model: String(body.model), judging, max: body.max_tokens ?? body.max_completion_tokens });
    if (String(body.model).startsWith('gemini')) return Response.json({ error: { message: 'no weekly answer is graded by Gemini' } }, { status: 500 });
    const text = judging ? verdictOf(prompt) : answerOf(prompt);
    if (path.endsWith('/v1/messages')) return Response.json({ id: 'msg_1', type: 'message', role: 'assistant', model: body.model, stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 100, output_tokens: 5 } });
    if (path.endsWith('/chat/completions')) return Response.json({ id: 'chatcmpl-1', object: 'chat.completion', created: 0, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } });
    return Response.json({ error: { message: `no route ${path}` } }, { status: 404 });
  } });
  return { url: `http://127.0.0.1:${server.port}`, log, stop: () => server.stop(true) };
}

/** The real lease proxy, keyless: every provider at the scripted upstream, placeholder keys, the given output caps. */
function leaseProxy(name: string, upstream: string, caps: Record<string, number>) {
  const lease = BudgetRun.openLease({ runId: `wl-dry-${name}`, leaseUsd: 25, ledgerPath: join(scratch('ledger'), 'lease.sqlite') });
  const proxy = new MeteringProxy({ upstream: keylessUpstream(upstream), policy: { lease, usageLog: join(scratch('usage'), 'usage.ndjson'), env: keylessKeys(), routeCaps: { caps, slots: { ...DEFAULT_ROUTE_CLASSES }, defaultClass: 'extraction' } } });
  proxy.start();
  return { url: `http://127.0.0.1:${proxy.port}`, stop: () => { proxy.stop(); lease.close(); } };
}

/** The grep agent's stand-in: the in-memory fake, answering each question as the scripted reader would, with no model call. */
class FakeAgent extends FakeMemorySystem {
  async answer(_ns: string, q: { text: string }): Promise<AgentAnswer> {
    return { text: answerOf(`Question: ${q.text}\n`), stop_reason: 'submitted', outcome: 'scored', usage: { input: 1, output: 1, cache_read: 0, cache_write: 0 }, provider_input_tokens: 1, latency_ms: 1, turns: 1, usd: 0, opened_source_ids: [] };
  }
}

describe('the fixture week, end to end and keyless', () => {
  // Value: protects=a week runs from plan to aggregates through the wired path: the runner plans and launches it, every campaign unit resolves from cells.json under the exports its command carries and runs through the real lease proxy, every re-read the launch hands over runs under its id and is graded by its gating judge, and settle and the aggregates read the week; fails_when=any link the OV1 to OV5 fixes wire breaks (a unit doesn't resolve or runs off-week, a re-read refuses for want of a judge or is capped out by its proxy, settle misses a re-read, the aggregates refuse the records); why_new=GBEV-3 ruling B's execution-wiring PR (a keyless end-to-end dry run before any weekly cell spends); seam=runner.ts plan, launch and settle, cell.ts findCell and runCell, reread-cell.ts prepareReread, rereadRouteCaps and runReread, aggregates.ts week, over template fixtures in a custody root and a scripted loopback upstream; no_claim=the systems under test (in-memory fakes, and the grep agent answers with no model call), ubi-runner and the VM push, and any spend figure
  test('plan, launch, cells, re-reads, judgments, settle and the aggregates run on the fixture week', async () => {
    custodyHost(WEEK.launch, WEEK.world_end, WORLDS);
    const manifest = JSON.parse(readFileSync(process.env.GBRAIN_EVALS_BGW_MANIFEST!, 'utf8')) as Bg1Manifest;
    const dir = scratch('week');
    const { run, steps } = planWeek({ dir, launch: WEEK.launch, batch: { first: 1001, week1: WEEK.launch, manifest } }, runnerDeps());
    const order = launchWeek(dir, 'WL-T', runnerDeps(), 500);
    const campaign = JSON.parse(readFileSync(join(dir, CAMPAIGN_FILE), 'utf8')) as CampaignManifest;
    const up = scriptedUpstream();
    const outs = new Map<string, string>();
    const offline = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.hostname !== '127.0.0.1') throw new Error(`the dry run reached ${url.hostname}`);
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      Object.assign(process.env, order.env);
      for (const unit of order.stages[0].units) {
        const c = campaign.cells.find(x => x.id === unit)!;
        Object.assign(process.env, Object.fromEntries([...c.command.matchAll(/export (\w+)=([^;]+); /g)].map(m => [m[1], m[2]])));
        const def = findCell(unit, undefined, 'weekly', process.env);
        const out = join(scratch('unit'), 'out');
        const proxy = leaseProxy(unit, up.url, { ...DEFAULT_ROUTE_CAPS, ...pinnedJudgeRouteCaps(def.arms) });
        try {
          const res = await runCell(def, { out, providerProxy: proxy.url, keyless: true, ...quiet }, { system: def.arms.some(a => a.mode === 'agent') ? new FakeAgent() : new FakeMemorySystem() });
          expect([unit, res.status, res.stopped, res.invalid_reasons]).toEqual([unit, 'complete', null, []]);
        } finally { proxy.stop(); }
        outs.set(unit, out);
        for (const a of def.arms) cpSync(join(out, 'cells', a.cell_id), join(dir, 'cells', a.cell_id), { recursive: true });
      }
      for (const r of order.rereads!) {
        const arg = (name: string) => r.argv[r.argv.indexOf(name) + 1];
        const def = findCell(arg('--cell'), undefined, 'weekly', process.env);
        const p = prepareReread(def, rereadArm(def, arg('--arm')), { sources: [join(outs.get(def.id)!, 'runs', def.id)], reader: arg('--reader'), out: join(scratch('reread'), 'out'), keyless: true, manifest: 'weekly' });
        expect([p.cell_id, p.gating]).toEqual([r.id, OPUS]);
        const proxy = leaseProxy(r.id, up.url, rereadRouteCaps(p));
        try { expect((await runReread(p, { providerProxy: proxy.url })).status).toBe('complete'); } finally { proxy.stop(); }
        cpSync(join(p.out, 'cells', p.cell_id), join(dir, 'cells', p.cell_id), { recursive: true });
      }
    } finally { globalThis.fetch = offline; up.stop(); }

    for (const s of steps) if (s.stage !== 'aggregates') markStep(dir, s.id, 'done');
    const costs = WL_ROWS.flatMap(row => (['claude-opus-5-5', 'particle-1'] as const).flatMap(reader => WORLDS.map(world => ({ row, reader, world, usd: 0.25 }))));
    const marker = settleWeek(dir, { costs });
    expect(marker.steps).toEqual({ cells: run.cells.length + 1, rereads: run.rereads.length, judgments: run.cells.length + 1 + run.rereads.length, harness_failures: 0 });
    const aggregates = scratch('aggregates');
    expect(aggregatesMain(['week', '--meta', join(dir, 'meta.json'), '--records', dir, '--out', aggregates])).toBe(0);
    const week = JSON.parse(readFileSync(join(aggregates, `week-${WEEK.launch}.json`), 'utf8'));
    expect([week.run_id, week.worlds.length]).toEqual([run.run_id, WORLDS.length]);
    for (const [cls, c] of Object.entries(week.classes as Record<string, { means: Record<string, { readers: Record<string, number> }>; differences: Record<string, { lost: number }> }>)) {
      expect([cls, Object.keys(c.means).sort()]).toEqual([cls, [...WL_ROWS].sort()]);
      for (const m of Object.values(c.means)) expect(Object.keys(m.readers).sort()).toEqual(['claude-opus-5-5', 'particle-1']);
      for (const d of Object.values(c.differences)) expect(d.lost).toBe(0);
    }
    const sent = [...new Set(up.log.map(l => `${l.judging ? 'judge' : 'read'} ${l.model}`))].sort();
    expect(sent).toEqual(['judge claude-opus-5-5', 'judge gpt-6-astra', 'read claude-opus-5-5', 'read particle-1']);
  }, 300_000);
});

