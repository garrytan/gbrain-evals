/**
 * The weekly line's three long public dev worlds and its long pilot and judge check (GBEV-128): bg1-dev-long-01 to -03 in
 * eval/generators/changing-facts-gen.ts and eval/runner/memory-qa/bg1-names.ts, their render, validation and mint in
 * eval/custody/bg1, their loader and split, and the long pilot and judge-check cells in eval/runner/q1/cells/weekly-line.ts
 * that eval/runner/weekly-line/pilot.ts plans and the launch check prices. Keyless: child processes run with only PATH and
 * HOME and every provider key blanked (the mint's key-route test passes a placeholder to a bun stub that runs nothing),
 * renders are --fake, and nothing builds a client.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BG1_CUSTODY_MARKER, BG1_DATA_DIR, BG1_DEV_SEEDS, BG1_PROFILES, checkPlan, devFiles, devWorldPlan, PUBLIC_PHRASING } from '../../eval/generators/changing-facts-gen.ts';
import { BG1_DEV_CONVERSATIONS, BG1_DEV_EXTRA_CONVERSATIONS, BG1_DEV_LONG_CONVERSATIONS, bgwWorldId } from '../../eval/runner/memory-qa/bg1-names.ts';
import { BG1_FIXTURES_ROOT, loadBg1Dev } from '../../eval/runner/memory-qa/corpus.ts';
import { bg1LaunchProblems } from '../../eval/runner/bg1/launch.ts';
import { devOnly, finishTimeoutFor, loadWeeklyPilotManifest, scheduledQuestions, windowedRunGuard } from '../../eval/runner/q1/cell.ts';
import { CELL_VM_MAX_HOURS, cellVmHours, isWeeklyLineCell } from '../../eval/runner/q1/cells/definitions.ts';
import {
  buildWeeklyPilotManifest, generateWeeklyLineCells, generateWeeklyLineJudgeCheckCells, generateWeeklyLinePilotCells, WEEKLY_LINE_JUDGE_CHECK_PAUSE_USD, WEEKLY_LINE_LABEL_CAP_USD,
  WEEKLY_PILOT_GBRAIN_ENV, WEEKLY_PILOT_LENGTH_ENV, weeklyLinePilotCaps,
} from '../../eval/runner/q1/cells/weekly-line.ts';
import { ScoreboardError } from '../../eval/runner/q1/scoreboard-errors.ts';
import { main as pilotMain, pilotPlan, writePilotCampaigns } from '../../eval/runner/weekly-line/pilot.ts';

const REPO = resolve(import.meta.dir, '../..');
const RENDER = join(REPO, 'eval/custody/bg1/render.ts');
const VALIDATE = join(REPO, 'eval/custody/bg1/validate.ts');
const MINT = join(REPO, 'eval/custody/bg1/mint.sh');
const LONG = ['bg1-dev-long-01', 'bg1-dev-long-02', 'bg1-dev-long-03'];
const GBRAIN = { release: 'v0.61.10.0', commit: '2'.repeat(40) };
const GBRAIN_ENV = { [WEEKLY_PILOT_GBRAIN_ENV]: `${GBRAIN.release}@${GBRAIN.commit}` };
const WORLD_END = '2026-11-22';

const roots: string[] = [];
const scratch = (name: string) => { const d = mkdtempSync(join(tmpdir(), `bg1-dev-long-${name}-`)); roots.push(d); return d; };
afterAll(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });

/** A child process with only PATH and HOME, the provider keys blanked. */
function run(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { cwd: REPO, encoding: 'utf8', timeout: 240_000,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', GEMINI_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', BG1_GEMINI_API_KEY: '' } });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}
const refusal = (f: () => unknown) => { try { f(); } catch (e) { if (e instanceof ScoreboardError) return e.op; throw e; } return null; };
const record = (set: string, id: string) => JSON.parse(readFileSync(join(set, 'render', `${id}.validation.json`), 'utf8'));

describe('the long public dev worlds', () => {
  // Value: protects=the three long dev worlds are public plans at the long profile with the gold-audit fixes, committed as a fresh generation, while every earlier dev world's seed and plan stay as they were; fails_when=a long dev world plans at the standard profile, shares a seed with another world, drops the gold audit, carries the custody marker, or the committed files drift from the generator; why_new=GBEV-3's ruling A moves the judge check onto three public long dev worlds; seam=changing-facts-gen.ts devWorldPlan and devFiles against eval/data/changing-facts-v1; no_claim=the Gemini-rendered worlds, which come in their own change after a privacy read
  test('they are changing-facts-gen@2 plans from public seeds, committed as generated, and the earlier dev worlds are untouched', () => {
    expect(BG1_DEV_LONG_CONVERSATIONS).toEqual(LONG);
    const files = devFiles();
    for (const id of LONG) {
      const plan = devWorldPlan(id);
      expect([plan.generator, plan.seed, plan.gold_audit, 'custody' in plan]).toEqual([BG1_PROFILES.long.generator, `bg1-dev-long-seed-v1:${id}`, true, false]);
      expect(plan.sessions.length).toBeGreaterThanOrEqual(BG1_PROFILES.long.sessions.min);
      expect(plan.sessions.length).toBeLessThanOrEqual(BG1_PROFILES.long.sessions.max);
      expect(() => checkPlan(plan)).not.toThrow();
      for (const rel of [`dev/worlds/${id}/plan.json`, `dev/worlds/${id}/questions.json`, `fixtures/worlds/${id}/world.json`, `fixtures/worlds/${id}/questions.json`]) {
        expect(readFileSync(join(BG1_DATA_DIR, rel), 'utf8')).toBe(files.get(rel)!);
        expect(files.get(rel)!).not.toContain(BG1_CUSTODY_MARKER);
      }
      expect(JSON.parse(files.get(`dev/worlds/${id}/questions.json`)!)).toHaveLength(64);
      expect(existsSync(join(BG1_DATA_DIR, 'dev', 'worlds', id, 'world.json'))).toBe(false);
    }
    expect(new Set(Object.values(BG1_DEV_SEEDS)).size).toBe(Object.keys(BG1_DEV_SEEDS).length);
    for (const id of [...BG1_DEV_CONVERSATIONS, ...BG1_DEV_EXTRA_CONVERSATIONS]) {
      expect(BG1_DEV_SEEDS[id]).toBe(`bg1-dev-seed-v1:${id}`);
      expect(devWorldPlan(id).generator).toBe(BG1_PROFILES.standard.generator);
    }
  });

  // Value: protects=a long dev world renders and validates at its own length unless told otherwise, as a public world with no custody marker; fails_when=render.ts or validate.ts --dev defaults a long world to 200,000 tokens, validate.ts passes a world with the custody marker, a template-rendered world outside a drill, or a world whose plan isn't the committed one; why_new=the 1M window mints these worlds with render.ts --dev and checks them with validate.ts, which had no dev mode; seam=render.ts and validate.ts --dev in child processes with --fake; no_claim=Gemini's render or the length a real world reaches
  test('render.ts and validate.ts --dev take a long world at its own length and check it as a public world', () => {
    const dir = scratch('render'), set = join(dir, 'set');
    const r = run('bun', [RENDER, '--dev', 'bg1-dev-long-01', '--fake', '--set', set, '--target-tokens', '200000']);
    expect([r.code, r.err]).toEqual([0, '']);
    expect(r.out).toContain('bg1-render world=bg1-dev-long-01 status=written sessions=');
    const pass = run('bun', [VALIDATE, '--dev', 'bg1-dev-long-01', '--set', set, '--fake', '--target-tokens', '200000']);
    expect(pass.code).toBe(0);
    expect(pass.out).toContain('bg1-validate world=bg1-dev-long-01 status=pass gates=none');
    expect(record(set, 'bg1-dev-long-01')).toMatchObject({ status: 'pass', target_tokens: 200_000, mode: 'drill' });
    const atProfile = run('bun', [VALIDATE, '--dev', 'bg1-dev-long-01', '--set', set, '--fake']);
    expect(atProfile.code).toBe(12);
    expect(record(set, 'bg1-dev-long-01')).toMatchObject({ status: 'fail', target_tokens: 1_000_000 });
    const real = run('bun', [VALIDATE, '--dev', 'bg1-dev-long-01', '--set', set, '--target-tokens', '200000']);
    expect(real.code).toBe(12);
    expect(record(set, 'bg1-dev-long-01').failed).toEqual(['renderer']);
    const world = join(set, 'worlds', 'bg1-dev-long-01', 'world.json');
    writeFileSync(world, readFileSync(world, 'utf8').replace('"renderer"', `"note": "${BG1_CUSTODY_MARKER}", "renderer"`));
    expect(run('bun', [VALIDATE, '--dev', 'bg1-dev-long-01', '--set', set, '--fake', '--target-tokens', '200000']).code).toBe(12);
    expect(record(set, 'bg1-dev-long-01').failed).toContain('files');
    const std = join(dir, 'std');
    expect(run('bun', [RENDER, '--dev', 'bg1-dev-01', '--fake', '--set', std, '--target-tokens', '4000']).code).toBe(0);
    expect(run('bun', [VALIDATE, '--dev', 'bg1-dev-01', '--set', std, '--fake']).code).toBe(12);
    expect(record(std, 'bg1-dev-01').target_tokens).toBe(200_000);
    expect(run('bun', [VALIDATE, '--dev', 'bg1-dev-long-04', '--set', set]).err).toContain('bg1-validate refused: usage: --dev <bg1-dev-01 to bg1-dev-20> (or bg1-dev-long-01 to -03)');
    expect(run('bun', [VALIDATE, '--dev', 'bg1-dev-long-01', '--set', set, '--seed-file', 'x']).err).toContain('takes no --seed-file');
    expect(run('bun', [RENDER, '--dev', 'bg1-dev-long-04', '--fake', '--set', join(dir, 'x')]).err).toContain('usage: --dev <bg1-dev-01 to bg1-dev-20> (or bg1-dev-long-01 to -03)');
  }, 120_000);

  // Value: protects=mint.sh --dev renders a long world at its own length, takes Gemini's key for a public dev mint from its own environment so a VM needs no key file, hands that key to the Gemini proxy alone, and leaves a sealed mint on the key file; fails_when=mint.sh passes 200,000 tokens to every dev world, refuses the long ids, gives the key to render.ts or the Anthropic proxy, or lets a sealed mint read GEMINI_API_KEY; why_new=the approved key route for the 1M window (GEMINI_API_KEY through the VM's environment, no key file); seam=a bun stub on PATH that records each call's arguments and whether it saw a Gemini key, and runs nothing; no_claim=the proxies' or render.ts's own behaviour
  test('mint.sh --dev takes the long ids at their own length and a dev mint\'s Gemini key from its environment, for the Gemini proxy only', () => {
    const dir = scratch('mint'), home = scratch('home'), bin = join(dir, 'bin'), log = join(dir, 'bun-calls.log');
    mkdirSync(bin); mkdirSync(join(dir, 'ledgers'));
    writeFileSync(join(bin, 'bun'), ['#!/usr/bin/env bash', `printf '%s\\t%s\\n' "\${GEMINI_API_KEY:+gemini-key}" "$*" >> ${JSON.stringify(log)}`,
      'case "$1" in', '  *harness-metering-proxy.ts) while [ $# -gt 1 ]; do [ "$1" = --ready-file ] && printf "{}" > "$2"; shift; done ;;', '  *render.ts) echo "bg1-render world=x status=written" ;;', 'esac', 'exit 0', ''].join('\n'));
    chmodSync(join(bin, 'bun'), 0o755);
    const mint = (args: string[], gemini: string) => {
      rmSync(log, { force: true });
      const r = spawnSync('bash', [MINT, ...args], { cwd: dir, encoding: 'utf8', timeout: 60_000,
        env: { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: home, ANTHROPIC_API_KEY: 'test-anthropic-key-not-real', GEMINI_API_KEY: gemini, OPENAI_API_KEY: '', BG1_GEMINI_API_KEY: '' } });
      const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(l => l.split('\t')) : [];
      return { code: r.status, all: (r.stdout ?? '') + (r.stderr ?? ''), calls };
    };
    const window = ['--paid-window', 'weekly-line-pilot-1m', '--window-cap-usd', '5', '--budget-ledger', 'ledgers/ledger.sqlite', '--budget-run-id', 'r1'];
    const r = mint(['--dev', '--out', 'dev-out', '--worlds', 'bg1-dev-long-01,bg1-dev-02', ...window], 'test-gemini-env-key-not-real');
    expect(r.code).toBe(0);
    expect(r.all).toContain('summary=dev mode=real worlds=2 written=2');
    const [, gemini, anthropic, render] = r.calls;
    expect(gemini[0]).toBe('gemini-key');
    expect(gemini[1]).toContain('--cell-id bg1-bg1-dev-long-01-gemini ');
    expect([anthropic[0], render[0]]).toEqual(['', '']);
    expect(render[1]).toContain(`--dev bg1-dev-long-01 --set ${join(realpathSync(dir), 'dev-out', 'set')} `);
    expect(r.calls.filter(([, a]) => a.split(' ')[0].endsWith('render.ts') && a.includes('--dev ')).map(([, a]) => /--target-tokens/.test(a))).toEqual([false, false]);
    expect(r.all).not.toContain('not-real');
    const fixed = mint(['--dev', '--out', 'dev-out2', '--worlds', 'bg1-dev-long-02', '--target-tokens', '300000', ...window], 'test-gemini-env-key-not-real');
    expect(fixed.calls.find(([, a]) => a.includes('--dev bg1-dev-long-02 '))![1]).toContain('--target-tokens 300000');
    expect(mint(['--dev', '--out', 'dev-out3', ...window], '').all).toContain('only from BG1_GEMINI_API_KEY in ~/.config/gbrain-evals/bg1.env (or, for --dev, from GEMINI_API_KEY)');
    expect(mint(['--dev', '--fake', '--out', 'dev-out4', '--worlds', 'bg1-dev-long-04'], '').all).toContain('--worlds takes bg1-dev-01 to bg1-dev-20 and bg1-dev-long-01 to -03, not bg1-dev-long-04');
    const seed = join(dir, 'test.bg1-seed'), phrasing = join(dir, 'test.bg1-phrasing.json');
    writeFileSync(seed, `${['bg1', 'seed', 'v1'].join('-')}:${'ab'.repeat(32)}\n`);
    writeFileSync(phrasing, JSON.stringify({ ...PUBLIC_PHRASING, custody: BG1_CUSTODY_MARKER }));
    chmodSync(seed, 0o600); chmodSync(phrasing, 0o600);
    const sealed = mint(['--out', join(dir, 'bg1-custody-k'), '--seed-file', seed, '--phrasing', phrasing, '--count', '1', ...window], 'test-gemini-env-key-not-real');
    expect(sealed.code).toBe(2);
    expect(sealed.all).toContain('only from BG1_GEMINI_API_KEY in ~/.config/gbrain-evals/bg1.env');
    expect(sealed.calls.some(([, a]) => a.includes('harness-metering-proxy.ts'))).toBe(false);
  }, 120_000);

  // Value: protects=the long dev worlds load as bg1-dev worlds, so the pilot's cells and the judge check's labelling can read them; fails_when=the loader refuses their ids, or a paid load accepts their template fixtures; why_new=the long pilot runs on bg1-dev; seam=corpus.ts loadBg1Dev on the committed fixtures; no_claim=the rendered worlds, or memory-qa run.ts's bg1-dev split, which keeps its 20 worlds
  test('the bg1-dev loader takes the long worlds', () => {
    const corpus = loadBg1Dev({ root: BG1_FIXTURES_ROOT, only: new Set(LONG), worldEnd: WORLD_END, keyless: true });
    expect(corpus.conversations.map(c => c.id)).toEqual(LONG);
    expect(corpus.questions).toHaveLength(192);
    expect(() => loadBg1Dev({ root: BG1_FIXTURES_ROOT, only: new Set(['bg1-dev-long-01']), worldEnd: WORLD_END })).toThrow('template fixtures');
  });
});

describe('the long pilot and judge check', () => {
  const [w1, w2] = [2001, 2002].map(bgwWorldId);
  const longWeek = generateWeeklyLineCells({ week: { launch: '2026-12-15', world_end: '2026-12-13', batch: w1 }, worlds: [w1, w2], gbrain: GBRAIN });
  const pilot = generateWeeklyLinePilotCells(GBRAIN, 'BGW-long', 'long');
  const judge = generateWeeklyLineJudgeCheckCells('long');
  const manifest = buildWeeklyPilotManifest(GBRAIN, 'BGW-long', 'long');
  const lsRemote = () => `${GBRAIN.commit}\trefs/tags/${GBRAIN.release}`;

  // Value: protects=each long pilot cell is the W1-long counted cell on bg1-dev-long-01, leased at its row's BGW-long cell cap with hours a 1,000,000-token ingest fits in, and the long judge check is the grep agent on bg1-dev-long-02 and -03 under the same pause; fails_when=a long pilot cell drifts from its counted cell, runs a 200,000-token world, takes set BGW's caps, plans fewer hours than extract-first's ingest of one long world (about 13), or the 200,000-token pilot changes; why_new=GBEV-3's ruling A (the four-arm pilot reruns on one long dev world, the grep agent on all three); seam=weekly-line.ts generateWeeklyLinePilotCells and generateWeeklyLineJudgeCheckCells at length long; no_claim=measured long-world hours or costs
  test('every long pilot cell is its W1-long counted cell on bg1-dev-long-01 at BGW-long\'s caps, and the judge check runs on -02 and -03', () => {
    const strip = (c: any) => JSON.parse(JSON.stringify(c, (k, v) => (['id', 'cell_id', 'set', 'block', 'benchmark', 'split', 'expected_hours', 'estimate', 'week', 'only_conversations', 'lease'].includes(k) ? undefined : v)));
    const caps = weeklyLinePilotCaps('BGW-long');
    const rowOf = { 'gbrain-defaults': 'gbrain', 'baseline-file-agent': 'grep-agent', 'ext-extract-first': 'extract-first', 'ext-memory-bank': 'memory-bank' } as const;
    expect(pilot.map(c => c.system)).toEqual(longWeek.map(c => c.system));
    for (const c of pilot) {
      const k = longWeek.find(x => x.system === c.system)!;
      expect(strip(c)).toEqual(strip(k));
      expect([c.id, c.set, c.block, c.benchmark, c.split, c.only_conversations]).toEqual([k.id.replace(/^bgw-long\./, 'bgw-pilot-long.'), 'BGW-pilot-long', 'BGW-pilot', 'bg1-dev', 'dev', ['bg1-dev-long-01']]);
      expect(c.lease!.usd).toBe(caps[rowOf[c.system as keyof typeof rowOf]].cells_cap_usd);
      expect(isWeeklyLineCell(c)).toBe(true);
      expect(cellVmHours(c.expected_hours)).toBeLessThanOrEqual(CELL_VM_MAX_HOURS);
    }
    const ef = pilot.find(c => c.system === 'ext-extract-first')!;
    expect(ef.expected_hours).toBeGreaterThanOrEqual(13);
    expect(finishTimeoutFor(ef)).toBeGreaterThan(13 * 3600);
    expect(judge.map(c => [c.id, c.system, c.set, c.block, c.only_conversations, c.lease!.usd])).toEqual([['bgw-judge-long.baseline-file-agent.baseline', 'baseline-file-agent', 'BGW-judge-long', 'BGW-judge', ['bg1-dev-long-02', 'bg1-dev-long-03'], Math.floor((WEEKLY_LINE_JUDGE_CHECK_PAUSE_USD - WEEKLY_LINE_LABEL_CAP_USD) * 100) / 100]]);
    expect(strip(judge[0])).toEqual(strip(pilot.find(c => c.system === 'baseline-file-agent')));
    expect(() => generateWeeklyLinePilotCells(GBRAIN, 'BGW', 'long')).toThrow('a long pilot precedes a W1-long block');
    expect(generateWeeklyLinePilotCells(GBRAIN, 'BGW', 'standard')).toEqual(generateWeeklyLinePilotCells(GBRAIN));
    expect(buildWeeklyPilotManifest(GBRAIN)).toEqual(buildWeeklyPilotManifest(GBRAIN, 'BGW', 'standard'));
    expect([manifest.length, manifest.pilot_caps, manifest.cells.map(c => c.id)]).toEqual(['long', caps, [...pilot, ...judge].map(c => c.id)]);
  });

  // Value: protects=a VM regenerates the long pilot's cells only from the length its command exports, and no long cell runs outside a granted window; fails_when=loadWeeklyPilotManifest ignores the length variable, takes a malformed one as standard, or the window guard skips the long cells; why_new=the long pilot's units run on VMs from `--manifest weekly-pilot`; seam=cell.ts loadWeeklyPilotManifest and windowedRunGuard; no_claim=a granted run  // Value: protects=a long pilot or judge-check cell loads its own long worlds and schedules every one of their questions, while the 200,000-token pilot keeps its load; fails_when=cell.ts loads stage 1's three worlds for a long cell, or schedules none of a long world's questions because the bg1-dev split leaves the long ids out; why_new=/ship review v1/outside-voice#1 (#627: every long unit scheduled zero questions); seam=cell.ts devOnly and scheduledQuestions over the long worlds' template fixtures; no_claim=the rendered worlds
  test('each long cell loads its own worlds and schedules all their questions', () => {
    for (const def of [...pilot, ...judge]) {
      expect(devOnly(def)).toEqual(new Set(def.only_conversations));
      const corpus = loadBg1Dev({ root: BG1_FIXTURES_ROOT, only: devOnly(def)!, worldEnd: WORLD_END, keyless: true });
      expect(scheduledQuestions(def, corpus, null).length).toBe(corpus.questions.length);
      expect(corpus.questions.length).toBe(64 * def.only_conversations!.length);
    }
    for (const def of generateWeeklyLinePilotCells(GBRAIN)) expect(devOnly(def)).toBeNull();
  });


  test('the pilot manifest loads the long cells only from the length variable, and each refuses outside a window', async () => {
    expect(loadWeeklyPilotManifest({ ...GBRAIN_ENV, [WEEKLY_PILOT_LENGTH_ENV]: 'long' }).cells.map(c => c.id)).toEqual(manifest.cells.map(c => c.id));
    expect(loadWeeklyPilotManifest(GBRAIN_ENV).length).toBe('standard');
    expect(refusal(() => loadWeeklyPilotManifest({ ...GBRAIN_ENV, [WEEKLY_PILOT_LENGTH_ENV]: '1m' }))?.code).toBe('PREFLIGHT_FAILED');
    for (const def of [...pilot, ...judge]) {
      let op = null;
      try { await windowedRunGuard([], def, { GBRAIN_EVALS_BG1_WORLD_END: WORLD_END, ...GBRAIN_ENV, [WEEKLY_PILOT_LENGTH_ENV]: 'long' }); } catch (e) { if (e instanceof ScoreboardError) op = e.op; else throw e; }
      expect(op).toMatchObject({ code: 'PAID_FLAGS_MISSING', message: expect.stringContaining(`weekly pilot cell ${def.id}`) });
    }
  });

  // Value: protects=the long pilot's dry run and campaigns name the long worlds, their own campaign ids and the length export, and the launch check prices them only with that export; fails_when=plan --length long prints the 200,000-token cells, a long campaign reuses the 200,000-token campaign ids, a unit's command omits the length, or the launch check prices a long unit against the standard manifest; why_new=the 1M window launches these campaigns; seam=pilot.ts main plan, writePilotCampaigns and bg1/launch.ts bg1LaunchProblems; no_claim=the VM run
  test('plan and campaigns at --length long name the long worlds, campaign ids and length, and the launch check accepts them', () => {
    const lines: string[] = [];
    expect(pilotMain(['plan', '--length', 'long'], { lsRemote, env: {} }, s => lines.push(s))).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('Pilot on bg1-dev-long-01 (long length, R111)');
    for (const c of [...pilot, ...judge]) expect(text).toContain(`| ${c.id} |`);
    expect(text).toContain('(q1-scoreboard-weekly-pilot-long-extract-first)');
    expect(text).toContain('(q1-scoreboard-weekly-judge-check-long)');
    expect(() => pilotMain(['plan', '--length', 'huge'], { lsRemote, env: {} }, () => {})).toThrow();
    const plan = pilotPlan(manifest, null);
    expect(plan.totals.cap_usd).toBeCloseTo(plan.totals.pilot_cap_usd + plan.totals.judge_check_cap_usd, 2);
    const out = join(scratch('campaigns'), 'c');
    const r = writePilotCampaigns(manifest, { out, window: 'weekly-line-pilot-1m', windowCapUsd: 360, worldEnd: WORLD_END });
    expect(r.env[WEEKLY_PILOT_LENGTH_ENV]).toBe('long');
    expect(JSON.parse(readFileSync(join(out, 'plan.json'), 'utf8')).env[WEEKLY_PILOT_LENGTH_ENV]).toBe('long');
    for (const c of r.campaigns) {
      const campaign = JSON.parse(readFileSync(c.file, 'utf8'));
      expect(campaign.campaign_id).toMatch(/^q1-scoreboard-weekly-(pilot|judge-check)-long/);
      for (const cell of campaign.cells) expect(cell.command).toStartWith(`export GBRAIN_EVALS_BG1_WORLD_END=${WORLD_END}; export ${WEEKLY_PILOT_GBRAIN_ENV}=${GBRAIN.release}@${GBRAIN.commit}; export ${WEEKLY_PILOT_LENGTH_ENV}=long; `);
      expect(bg1LaunchProblems(campaign)).toEqual([]);
      const torn = { ...campaign, cells: campaign.cells.map((cell: { command: string }) => ({ ...cell, command: cell.command.replace(/export GBRAIN_EVALS_WEEKLY_PILOT_LENGTH=\S+; /, '') })) };
      expect(bg1LaunchProblems(torn).join('\n')).toContain('is not a unit of the committed the weekly pilot manifest');
    }
  });
});
