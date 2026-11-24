/**
 * The weekly line's execution wiring (gbrain-evals#619's open notes OV1 to OV5, GBEV-3's rulings B and E): the weekly cells
 * #619 plans run through the q1 cell path. Keyless: every key is blank or a placeholder, fetch throws for the whole file
 * unless a test names a local loopback, and no test resolves a real tag or reaches a provider.
 *
 *   OV2  every gate that guards money or sealed data takes Set W (bgw) as it takes BG1: the paid-window guard, the BG1
 *        campaign protections, the campaign launch check, the re-read's Gemini key and the VM's custody wipe.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bg1LaunchProblems } from '../../eval/runner/bg1/launch.ts';
import { freePort } from '../../eval/runner/lifecycle/slice.ts';
import { windowedRunGuard } from '../../eval/runner/q1/cell.ts';
import { generateWeeklyLineCells } from '../../eval/runner/q1/cells/weekly-line.ts';
import { rereadKeys } from '../../eval/runner/q1/reread-cell.ts';
import { ScoreboardError } from '../../eval/runner/q1/scoreboard-errors.ts';
import { Campaign, runRemote, type CampaignManifest } from '../../eval/runner/shootout-cell.ts';

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

  // Value: protects=a campaign holding weekly units gets the BG1 campaign protections (leases.lock, the events hash, lease binding) and the window-cap launch check before any VM boots; fails_when=Campaign.bg1 or bg1LaunchProblems still look only at bg1, bg1c and bg1-dev, so a weekly campaign boots with no window-cap check; why_new=#619 OV2 (every gate that guards money must include bgw); seam=Campaign.bg1 and bg1/launch.ts bg1LaunchProblems; no_claim=the lease prices themselves (OV1's tests)
  test('a weekly campaign takes the BG1 campaign protections, and its launch check refuses a unit outside the window', () => {
    const m = campaignWith('bun eval/runner/q1/cell.ts run --cell x --out "$SHOOTOUT_OUT"');
    const dir = scratch('campaign');
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m));
    expect(new Campaign(join(dir, 'manifest.json'), join(dir, 'state')).bg1).toBe(true);
    expect(bg1LaunchProblems(m)).toContain(`unit ${cells[0].id} carries --window-cap-usd nowhere, not the campaign's cap_usd 50`);
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
