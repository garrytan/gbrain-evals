/**
 * The long world profile for the weekly line's ceiling rule (docs/benchmarks/2026-11-23-weekly-outcome-line-
 * preregistration.md, "Power", ceiling): changing-facts-gen@2 in eval/generators/changing-facts-gen.ts, Set W's W1-long seed
 * set in eval/runner/memory-qa/bg1-names.ts with its mint, validation and fill in eval/custody/bg1, and the weekly cells on
 * its about 1,000,000-token worlds (eval/runner/q1/cells/weekly-line.ts, eval/runner/weekly-line/launch.ts). Keyless: the
 * mints run --fake in child processes with only PATH and HOME and every provider key blanked, and nothing builds a client.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  BG1_CUSTODY_MARKER, BG1_DATA_DIR, BG1_LONG_FIXTURE, BG1_PROFILES, buildQuestions, bgwWorldSeed, checkPlan, devWorldPlan, longFixturePlan, longFixtureSpread, planWorld, PUBLIC_PHRASING,
  renderBriefs, renderTemplateWorld, sealedWorldSeed, type World, type WorldPlan,
} from '../../eval/generators/changing-facts-gen.ts';
import { BG1_STRATA, bgwBatchIds, bgwBatchSlots, bgwProfileOf, bgwSlotOf } from '../../eval/runner/memory-qa/bg1-names.ts';
import { bgwCommittedProblems } from '../../eval/runner/memory-qa/corpus.ts';
import { sealedPlan, sealedTargetTokens } from '../../eval/custody/bg1/render.ts';
import { ALL_SETS, BG1_MEASURED, f6ExtractionUsd } from '../../eval/runner/q1/cells/definitions.ts';
import { BG1C_RATES } from '../../eval/runner/q1/cells/bg1c.ts';
import {
  buildWeeklyPilotManifest, generateWeeklyLineCells, generateWeeklyLinePilotCells, WEEKLY_LINE_RATES, weeklyLinePilotCaps, weeklyLineRates, weeklyLineRereadPlans, weeklyLineSetOf, type WeeklyLineInput,
} from '../../eval/runner/q1/cells/weekly-line.ts';
import { weeklyLineLaunchProblems, weeklyLineRegistryModels } from '../../eval/runner/weekly-line/launch.ts';

const REPO = resolve(import.meta.dir, '../..');
const MINT = join(REPO, 'eval/custody/bg1/mint.sh');
const VALIDATE = join(REPO, 'eval/custody/bg1/validate.ts');
const FILL = join(REPO, 'eval/custody/bg1/fill-manifest.ts');
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const h = (v: unknown) => sha(JSON.stringify(v));

const roots: string[] = [];
const scratch = (name: string) => { const d = mkdtempSync(join(tmpdir(), `bg1-long-${name}-`)); roots.push(d); return d; };
afterAll(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });

/** A child process with only PATH and HOME, the provider keys blanked. */
function run(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { cwd: REPO, encoding: 'utf8', timeout: 240_000,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', GEMINI_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', BG1_GEMINI_API_KEY: '' } });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}
/** Owner-only Set W test seed and phrasing files, made at run time. */
function inputs(name: string) {
  const dir = scratch(name);
  const seed = join(dir, 'test.bgw-seed'), phrasing = join(dir, 'test.bgw-phrasing.json');
  writeFileSync(seed, ['bgw', 'seed', 'v1'].join('-') + ':' + sha(name) + '\n');
  writeFileSync(phrasing, JSON.stringify({ ...PUBLIC_PHRASING, custody: BG1_CUSTODY_MARKER }));
  chmodSync(seed, 0o600); chmodSync(phrasing, 0o600);
  return { dir, seed, phrasing, seedLine: readFileSync(seed, 'utf8').trim() };
}
const LONG = ['--bgw', '--batch', '2001'];
const LENGTH = ['--target-tokens', '200000', '--tolerance', '0.25'];
const mint = (out: string, i: ReturnType<typeof inputs>, extra: string[]) => run('bash', [MINT, '--out', out, '--seed-file', i.seed, '--phrasing', i.phrasing, ...extra]);
const refusal = (r: ReturnType<typeof run>, text: string) => { expect(r.code).toBe(2); expect(r.err).toContain(text); };

/** SHA-256s of changing-facts-gen@1 output, taken at main before the long profile existed (commit ef18cdc9). */
const GOLDEN: Record<string, string> = {
  'bg1-dev-01:plan': '7a8167dda585ea1ae9d71a974af8236ba219cce38a985e92348562212458669e',
  'bg1-dev-01:questions': '377cd9b8aca161d4035a7c5bb51596a3d60d0213569a5adfa00f81a98160d515',
  'bg1-dev-01:world30k': '3cc9568c80cccba0ff632860e497e8f1fc0d34a5e835d28445b1254cb3cdeccf',
  'bg1-dev-01:briefs': 'aedfd1206fb70577ee6699114bf4ea507a1e5cd1e5bf0d87de14ffb2135dfbe4',
  'bg1-dev-02:plan': 'ff2bfebea895c5cd4d8080010e179b09fc1643e753d4bf754eed5b748d1da0de',
  'bg1-dev-02:questions': 'b3bfd706e7317fbe79a66fc0bcdeebb40232efc60f80f62818d2a2371ae61299',
  'bg1-dev-02:world30k': 'd9675a80901660e2931ac1bdebf19b83555e6b9135fdf0ef836812a2c32b8ed9',
  'bg1-dev-02:briefs': '7385426289e60d590b0cff2152c5162fc0cde822f5769faf9174290d25ce187b',
  'bg1-dev-04:plan': 'd46053270f3e99599043c9f523d59e80abc3a293f34f5ccac5f3e126eb286bbf',
  'bg1-dev-04:questions': '47a435483414fd5a5be2886c1ddf296a69d09b1393c5c51bcda8135cb839b204',
  'bg1-dev-04:world30k': '5c7a1a19aea04a51bbedfeae39e7be9b7cc79ae24cf642f77d4e91ebd5cab8c1',
  'bg1-dev-04:briefs': '96a6c3028025978bcabe229c3ca95a5fb93b3af916dc03457726feecfd85153d',
  'bg1-031:plan': '6582c6ad0322d37df6e8a477e510d91b6815c6cd0bcdc72c650de36a1894c763',
  'bg1-031:questions': '95fc9c42198a11be92438d2445e8efae98ec180a1274139534c1d37feefc7308',
  'bgw-1001:plan': 'c4a2091fe36714e09957c8d7e16672fa736ff251005df27adfe386ecd9ff5566',
  'bgw-1001:questions': '5312f8c44783abfbb01b1933503046be70347a8736fa319f4a34e138440d88e0',
  'bgw-1001:briefs': '5f0b81b2216621cac1b54f7828e614696ee4731ec0d796b138f23d6595ec43b0',
  'bg1-dev-01:world200k': '081c6a3c4b35f742a9b2d77658954d9efe627d2f389f2cd253ba68de5b3185cf',
};

describe('changing-facts-gen@1 stays byte-identical', () => {
  // Value: protects=every standard world (BG1, BG1-C, Set W's W1 and the dev worlds) plans, gets its questions, briefs and template render exactly as before the long profile; fails_when=the profile parameter moves any random draw, field or default of a standard plan; why_new=GBEV-3's brief for the long profile ("the 200k path byte-identical"); seam=planWorld, buildQuestions, renderBriefs and renderTemplateWorld at fixed public and test seeds; no_claim=a Gemini render
  test('plans, questions, briefs and template worlds hash as they did at main for public dev seeds and fixed sealed seeds', () => {
    const got: Record<string, string> = {};
    for (const id of ['bg1-dev-01', 'bg1-dev-02', 'bg1-dev-04']) {
      const p = devWorldPlan(id);
      Object.assign(got, { [`${id}:plan`]: h(p), [`${id}:questions`]: h(buildQuestions(p)), [`${id}:world30k`]: h(renderTemplateWorld(p)), [`${id}:briefs`]: h(renderBriefs(p)) });
    }
    const bg1 = planWorld('bg1-031', sealedWorldSeed('bg1-seed-v1:' + 'a'.repeat(64), 31), { custody: true });
    Object.assign(got, { 'bg1-031:plan': h(bg1), 'bg1-031:questions': h(buildQuestions(bg1)) });
    const bgw = planWorld('bgw-1001', bgwWorldSeed('bgw-seed-v1:' + 'b'.repeat(64), 1001), { custody: true });
    Object.assign(got, { 'bgw-1001:plan': h(bgw), 'bgw-1001:questions': h(buildQuestions(bgw)), 'bgw-1001:briefs': h(renderBriefs(bgw)) });
    got['bg1-dev-01:world200k'] = h(renderTemplateWorld(devWorldPlan('bg1-dev-01'), 200_000));
    expect(got).toEqual(GOLDEN);
    expect(bgw.generator).toBe('changing-facts-gen@1');
  });
});

describe('the long profile, changing-facts-gen@2', () => {
  const long = longFixturePlan();
  // Value: protects=a long world keeps BG1's shape (30 tracked slots over about 18 months, 64 questions in eight kinds) at about five times the sessions; fails_when=the long profile drops a stratum, changes the span or checkPlan accepts a plan under the wrong version's session range; why_new=GBEV-3's brief (long profile as a new generator version); seam=planWorld with profile long and checkPlan; no_claim=a Gemini render
  test('700 to 800 sessions over about 18 months, 30 tracked slots and 64 questions, eight per kind', () => {
    expect(long.generator).toBe('changing-facts-gen@2');
    expect(long.sessions.length).toBeGreaterThanOrEqual(700);
    expect(long.sessions.length).toBeLessThanOrEqual(800);
    expect(long.sessions[0].day).toBeLessThanOrEqual(-537);
    expect(long.slots.filter(s => s.stratum !== 'decoy').length).toBe(30);
    const qs = buildQuestions(long);
    expect(qs.length).toBe(64);
    for (const st of BG1_STRATA) expect(qs.filter(q => q.bg1.stratum === st).length).toBe(8);
    const seed = 'bgw-seed-v1:' + 'c'.repeat(64);
    for (const slot of [2001, 2002, 2003, 2004, 2005, 2006]) {
      const p = planWorld(`bgw-${slot}`, bgwWorldSeed(seed, slot), { custody: true, profile: 'long' });
      expect([p.generator, p.sessions.length >= 700 && p.sessions.length <= 800, buildQuestions(p).length]).toEqual(['changing-facts-gen@2', true, 64]);
    }
  });

  test('checkPlan holds each version to its own session range and refuses an unknown version', () => {
    expect(() => checkPlan(long)).not.toThrow();
    expect(() => checkPlan({ ...long, generator: 'changing-facts-gen@1' })).toThrow('the session count is outside 140 to 160');
    const std = devWorldPlan('bg1-dev-01');
    expect(() => checkPlan({ ...std, generator: 'changing-facts-gen@2' })).toThrow('the session count is outside 700 to 800');
    expect(() => checkPlan({ ...std, generator: 'changing-facts-gen@9' })).toThrow('is not one of changing-facts-gen@1, changing-facts-gen@2');
  });

  test('briefs default to the profile\'s length: about 1,000,000 tokens long, 200,000 standard', () => {
    const sum = (p: WorldPlan) => renderBriefs(p).reduce((n, b) => n + b.target_tokens, 0);
    expect(Math.abs(sum(long) - 1_000_000)).toBeLessThan(1_000);
    expect(Math.abs(sum(devWorldPlan('bg1-dev-01')) - 200_000)).toBeLessThan(1_000);
    expect(BG1_PROFILES.long).toEqual({ generator: 'changing-facts-gen@2', sessions: { min: 700, max: 800 }, target_tokens: 1_000_000 });
  });

  // Value: protects=the long world's 64 questions draw evidence from across its whole history, not just a padded front or back, as the 200k world's do; fails_when=the long profile crowds the evidence into a few deciles, or the committed spread report drifts from the generator; why_new=GBEV-3's brief (evidence sessions by position decile per kind); seam=longFixtureSpread over template-rendered worlds; no_claim=a Gemini-rendered world's token positions
  test('the committed spread report matches a fresh one, and both worlds spread evidence over the whole history', () => {
    const fresh = longFixtureSpread();
    expect(readFileSync(join(BG1_DATA_DIR, 'long-fixture/spread.json'), 'utf8')).toBe(JSON.stringify(fresh, null, 1) + '\n');
    const [l, s] = fresh.worlds;
    expect([l.world, l.generator, s.world, s.generator]).toEqual([BG1_LONG_FIXTURE, 'changing-facts-gen@2', 'bg1-dev-01', 'changing-facts-gen@1']);
    expect(Math.abs(l.tokens - 1_000_000)).toBeLessThan(0.15 * 1_000_000);
    expect(Math.abs(s.tokens - 200_000)).toBeLessThan(0.15 * 200_000);
    for (const w of fresh.worlds) {
      const all = w.deciles.all, total = all.reduce((a, b) => a + b, 0), firstHalf = all.slice(0, 5).reduce((a, b) => a + b, 0);
      expect(all.filter(n => n > 0).length).toBeGreaterThanOrEqual(9);
      expect(firstHalf / total).toBeGreaterThan(0.3);
      expect(firstHalf / total).toBeLessThan(0.7);
      for (const st of BG1_STRATA) expect(w.deciles[st].reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    }
    expect(readdirSync(join(BG1_DATA_DIR, 'long-fixture'))).toEqual(['spread.json']);
    expect(longFixturePlan().custody).toBeUndefined();
  });
});

describe('Set W\'s W1-long seed set', () => {
  // Value: protects=long worlds live on their own slot range with W1's seed line, and every Set W tool plans and sizes them at the long profile while W1 stays standard; fails_when=W1-long overlaps W1, a batch crosses its end, a W1-long slot plans at changing-facts-gen@1 or a W1 slot at @2, or its batch files are not committed; why_new=GBEV-3's brief (a new set id on its own slot range); seam=bg1-names.ts, render.ts sealedPlan and sealedTargetTokens, corpus.ts bgwCommittedProblems; no_claim=a real mint
  test('slots 2001 to 2999, long profile, W1\'s seed; plans and lengths follow the slot\'s set', () => {
    expect([bgwProfileOf(1001), bgwProfileOf(1999), bgwProfileOf(2001), bgwProfileOf(2999)]).toEqual(['standard', 'standard', 'long', 'long']);
    expect(() => bgwProfileOf(2000)).toThrow('is not in any Set W seed set');
    expect([bgwSlotOf('bgw-2001'), bgwSlotOf('bgw-2999'), bgwSlotOf('bgw-3000')]).toEqual([2001, 2999, null]);
    expect(bgwBatchSlots(2944).at(-1)).toBe(2999);
    expect(() => bgwBatchSlots(2945)).toThrow('past seed set W1-long\'s last slot 2999');
    const seed = 'bgw-seed-v1:' + 'd'.repeat(64), phrasing = { ...PUBLIC_PHRASING, custody: BG1_CUSTODY_MARKER };
    expect(sealedPlan(seed, 2001, phrasing, 'bgw').generator).toBe('changing-facts-gen@2');
    expect(sealedPlan(seed, 1001, phrasing, 'bgw').generator).toBe('changing-facts-gen@1');
    expect([sealedTargetTokens(2001, 'bgw'), sealedTargetTokens(1001, 'bgw'), sealedTargetTokens(31, 'bg1')]).toEqual([1_000_000, 200_000, 200_000]);
    expect(bgwCommittedProblems(2001)).toEqual([]);
    expect(bgwCommittedProblems(2057)).not.toEqual([]);
  });

  // Value: protects=mint.sh, validate.ts and fill-manifest.ts accept the long set with every custody guard of W1, and a real fill pins a long batch only at its own length; fails_when=the long batch mints into another batch's --out, plans at the wrong version, or a real fill pins it at another length; why_new=GBEV-3's brief (mint.sh, render.ts and the loader accept the set; no guard weakened); seam=mint.sh --bgw --batch 2001 --fake, validate.ts --bgw, fill-manifest.ts --bgw; no_claim=a paid render or the Gemini checks
  test('a --fake long batch mints under the same guards, and a real fill refuses another length', () => {
    const j = inputs('w1-long');
    const out = join(j.dir, 'bgw-custody-long');
    const m = mint(out, j, [...LONG, ...LENGTH, '--fake', '--count', '8']);
    expect(m.code).toBe(0);
    expect(m.out.startsWith('bgw-batch batch=bgw-2001 set=W1-long slots=2001-2056 previous=none status=pass\n')).toBe(true);
    expect(m.out).toMatch(/bg1-render slot=2001 world=bgw-2001 status=written /);
    expect(readFileSync(join(out, 'batch.json'), 'utf8')).toBe('{"set":"W1-long","batch":"bgw-2001"}\n');
    const plan = JSON.parse(readFileSync(join(out, 'set/worlds/bgw-2001/plan.json'), 'utf8')) as WorldPlan;
    expect([plan.generator, plan.sessions.length >= 700]).toEqual(['changing-facts-gen@2', true]);
    refusal(mint(out, j, ['--bgw', '--batch', '1001', ...LENGTH, '--fake', '--count', '1']), 'this --out holds bgw-2001, which is not one of Set W batch bgw-1001\'s slots (1001 to 1056)');
    refusal(mint(join(j.dir, 'bgw-custody-x'), j, ['--bgw', '--batch', '2000', ...LENGTH, '--fake']), 'does not start in any Set W seed set');
    refusal(mint(join(j.dir, 'bgw-custody-y'), j, ['--start', '2001', '--target-tokens', '200000', '--fake']), 'slots 1001 and up are Set W\'s');

    for (const id of bgwBatchIds(2001).slice(0, 8)) {
      const path = join(out, 'set/worlds', id, 'world.json');
      const w = JSON.parse(readFileSync(path, 'utf8')) as World;
      writeFileSync(path, JSON.stringify({ ...w, renderer: 'gemini:gemini-3.8-flash' }, null, 1) + '\n');
    }
    const report = join(j.dir, 'report.json');
    const v = run('bun', [VALIDATE, ...LONG, '--set', join(out, 'set'), '--seed-file', j.seed, '--phrasing', j.phrasing, '--report', report, ...LENGTH]);
    expect(v.out).toMatch(/^bg1-validate checked=8 passed=8 failed=0 /);
    refusal(run('bun', [FILL, ...LONG, '--root', join(out, 'set'), '--report', report, '--tolerance', '0.25']), 'the report was validated at 200000 tokens within 0.25, not 1000000 within 0.25');
    refusal(run('bun', [FILL, ...LONG, '--root', join(out, 'set'), '--report', report, ...LENGTH]), 'a real Set W fill pins batch bgw-2001 at its seed set\'s 1000000 tokens, not 200000');
    expect(readdirSync(join(out, 'set')).filter(f => f.endsWith('-manifest.json'))).toEqual([]);
  }, 240_000);
});

describe('the weekly cells on W1-long worlds', () => {
  const GBRAIN = { release: 'v0.60.800.0', commit: 'a'.repeat(40) };
  const input = (batch: string, first: number): WeeklyLineInput => ({ week: { launch: '2026-12-08', world_end: '2026-12-06', batch }, worlds: Array.from({ length: 8 }, (_, i) => `bgw-${first + i}`), gbrain: GBRAIN });
  const std = generateWeeklyLineCells(input('bgw-1001', 1001)), long = generateWeeklyLineCells(input('bgw-2001', 2001));
  const by = (cs: typeof std, system: string) => cs.find(c => c.system === system)!;
  const ingest = (key: string, tokens: number) => BG1_MEASURED.ingest_usd_per_mtok[key] * tokens / 1e6 + (key === 'gbrain-defaults:rs1-stable' ? f6ExtractionUsd(tokens) : 0);

  // Value: protects=a W1-long week runs its own counted set with estimates that grow with world tokens, while the 200k week's rates stay BG1-C's; fails_when=a long week runs set BGW, an 8,000-token row's estimate ignores the longer ingest, or the standard week's estimate or rates change; why_new=GBEV-3's brief (cells take the set and length from their inputs; per-world estimates scale with world tokens; counted 200k rates unchanged); seam=generateWeeklyLineCells, weeklyLineRates and weeklyLinePilotCaps; no_claim=measured long-world costs
  test('the batch picks BGW or BGW-long, and only the ingest part of an 8,000-token row grows', () => {
    expect([weeklyLineSetOf('bgw-1001'), weeklyLineSetOf('bgw-2001')]).toEqual(['BGW', 'BGW-long']);
    expect(long.every(c => c.set === 'BGW-long' && c.block === 'BGW' && c.benchmark === 'bgw')).toBe(true);
    expect(ALL_SETS['BGW-long'].corpus_tokens / ALL_SETS['BGW-long'].conversations).toBe(1_000_000);
    for (const system of ['gbrain-defaults', 'ext-extract-first', 'ext-memory-bank']) {
      const s = by(std, system), l = by(long, system), key = `${s.system}:${s.configuration}`;
      expect(s.estimate).toEqual({ usd: Math.round(8 * BG1C_RATES.row_usd_per_world[key] * 100) / 100, lines: { row_dev_rate: Math.round(8 * BG1C_RATES.row_usd_per_world[key] * 100) / 100 } });
      expect(l.estimate.lines.row_dev_rate).toBe(s.estimate.lines.row_dev_rate);
      expect(l.estimate.lines.ingest_past_rate).toBeCloseTo(8 * (ingest(key, 1_000_000) - ingest(key, 200_000)), 2);
      expect(l.expected_hours).toBeGreaterThan(s.expected_hours);
    }
    expect(by(long, 'baseline-file-agent').estimate).toEqual(by(std, 'baseline-file-agent').estimate);
    expect(Number(by(long, 'gbrain-defaults').launch!.env.GBRAIN_F6_EXTRACT_CAP_USD)).toBeGreaterThan(Number(by(std, 'gbrain-defaults').launch!.env.GBRAIN_F6_EXTRACT_CAP_USD));
    expect(weeklyLineRates('BGW')).toEqual({ ...WEEKLY_LINE_RATES });
    const caps = weeklyLinePilotCaps('BGW-long'), stdCaps = weeklyLinePilotCaps();
    expect(caps.gbrain.cap_usd).toBeGreaterThan(stdCaps.gbrain.cap_usd);
    expect(caps['grep-agent'].cap_usd).toBe(stdCaps['grep-agent'].cap_usd);
    expect(generateWeeklyLinePilotCells(GBRAIN)).toEqual(generateWeeklyLinePilotCells(GBRAIN, 'BGW'));
    expect(generateWeeklyLinePilotCells(GBRAIN, 'BGW-long').every(c => c.set === 'BGW-pilot')).toBe(true);
    const pm = buildWeeklyPilotManifest(GBRAIN, 'BGW-long');
    expect([pm.rates, pm.pilot_caps]).toEqual([weeklyLineRates('BGW-long'), caps]);
    expect(buildWeeklyPilotManifest(GBRAIN)).toEqual(buildWeeklyPilotManifest(GBRAIN, 'BGW'));
    expect(buildWeeklyPilotManifest(GBRAIN).rates).toEqual({ ...WEEKLY_LINE_RATES });
  });

  // Value: protects=the launch check refuses a week whose cells run another length than its batch; fails_when=a W1-long week launches on BGW cells, a W1 week on BGW-long cells, a cell (or launch unit) whose planned hours outrun one VM's limit launches and is stopped after spending, or a split cell's units skip or repeat a world; why_new=GBEV-3's brief (no guard weakened by the long set); seam=weekly-line/launch.ts weeklyLineLaunchProblems; no_claim=the cell VM
  test('the launch check refuses cells whose set is not the length their batch plans at, or that would outrun one VM', () => {
    const deps = { ripgrep: () => 'ripgrep 14.1.1', registry: [...weeklyLineRegistryModels(), { model: 'text-embedding-3-large', role: 'system-internal', system: 'extract-first server (common setup embedder)' }] };
    const problems = (cells: typeof std) => weeklyLineLaunchProblems({ gbrain: GBRAIN, cells, rereads: weeklyLineRereadPlans(cells) }, deps).filter(p => p.includes('length'));
    expect(problems(long)).toEqual([]);
    const vm = (cells: typeof std) => weeklyLineLaunchProblems({ gbrain: GBRAIN, cells, rereads: weeklyLineRereadPlans(cells) }, deps).filter(p => p.includes('-hour limit'));
    expect(vm(std)).toEqual([]);
    expect(vm(long)).toEqual([]);
    const whole = long.map(c => (c.system === 'ext-extract-first' ? { ...c, shards: 1, kept_units: undefined, expected_hours: 121 } : c));
    expect(vm(whole)).toEqual([`cell ${by(long, 'ext-extract-first').id} plans 121 hours, so its VM would need 184 hours with margin, past the 72-hour limit on one VM; it would be stopped before it finished`]);
    const units = (cells: typeof std) => weeklyLineLaunchProblems({ gbrain: GBRAIN, cells, rereads: weeklyLineRereadPlans(cells) }, deps).filter(p => p.includes('launch unit'));
    expect(units(long)).toEqual([]);
    expect(units(long.map(c => (c.system === 'ext-extract-first' ? { ...c, kept_units: 2 } : c)))).toEqual([`cell ${by(long, 'ext-extract-first').id}'s 3 launch units run worlds bgw-2001, bgw-2002, bgw-2003, bgw-2004, bgw-2005, bgw-2006, not each of its week's worlds once`]);
    expect(problems(long.map(c => ({ ...c, set: 'BGW' as const })))[0]).toContain('runs set BGW, and batch bgw-2001\'s worlds are set BGW-long\'s length');
    expect(problems(std.map(c => ({ ...c, set: 'BGW-long' as const })))[0]).toContain('runs set BGW-long, and batch bgw-1001\'s worlds are set BGW\'s length');
  });
});
