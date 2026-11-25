/**
 * changing-facts-gen@3's described subjects (GBEV-128, Garry's option 1 of 2026-11-25): the three alias public dev worlds
 * bg1-dev-alias-01 to -03 in eval/generators/changing-facts-gen.ts and changing-facts-alias.ts, their leak and uniqueness
 * checks, validate.ts --dev's alias_leak gate, their loader, and the alias pilot and judge check that
 * eval/runner/weekly-line/pilot.ts plans with the grep agent first. Keyless: child processes run with only PATH and HOME
 * and every provider key blanked, renders are --fake, and nothing builds a client.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  ALIAS_PHRASING, aliasPlanProblems, BG1_ALIAS_GENERATOR_VERSION, BG1_DATA_DIR, BG1_DEV_SEEDS, buildQuestions, checkPlan, devFiles, devWorldPlan, PlanError, planWorld,
  questionLeaks, renderLeaks, renderTemplateWorld, resolveSubject, type WorldPlan,
} from '../../eval/generators/changing-facts-gen.ts';
import { misspellings } from '../../eval/generators/changing-facts-alias.ts';
import { BG1_DEV_ALIAS_CONVERSATIONS } from '../../eval/runner/memory-qa/bg1-names.ts';
import { BG1_FIXTURES_ROOT, loadBg1Dev } from '../../eval/runner/memory-qa/corpus.ts';
import { devOnly, scheduledQuestions } from '../../eval/runner/q1/cell.ts';
import { buildWeeklyPilotManifest, generateWeeklyLineJudgeCheckCells, generateWeeklyLinePilotCells, weeklyLinePilotCaps } from '../../eval/runner/q1/cells/weekly-line.ts';
import { CEILING, main as pilotMain, pilotPlan, pilotReport, pooledGrepOpus, STOP_RULE, type RowReading } from '../../eval/runner/weekly-line/pilot.ts';

const REPO = resolve(import.meta.dir, '../..');
const RENDER = join(REPO, 'eval/custody/bg1/render.ts');
const VALIDATE = join(REPO, 'eval/custody/bg1/validate.ts');
const ALIAS = ['bg1-dev-alias-01', 'bg1-dev-alias-02', 'bg1-dev-alias-03'];
const GBRAIN = { release: 'v0.61.10.0', commit: '2'.repeat(40) };
const WORLD_END = '2026-11-22';

const roots: string[] = [];
const scratch = (name: string) => { const d = mkdtempSync(join(tmpdir(), 'bg1-dev-alias-' + name + '-')); roots.push(d); return d; };
afterAll(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });

/** A child process with only PATH and HOME, the provider keys blanked. */
function run(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { cwd: REPO, encoding: 'utf8', timeout: 240_000,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', GEMINI_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', BG1_GEMINI_API_KEY: '' } });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}
const record = (set: string, id: string) => JSON.parse(readFileSync(join(set, 'render', id + '.validation.json'), 'utf8'));
const plans = new Map(ALIAS.map(id => [id, devWorldPlan(id)]));
const textOf = (plan: WorldPlan) => { const w = renderTemplateWorld(plan); const m = new Map(w.sessions.map(s => [s.id, s.turns.map(t => t.content).join('\n')])); return (id: string) => m.get(id)!; };

describe('the alias public dev worlds', () => {
  // Value: protects=the three alias dev worlds are changing-facts-gen@3 plans at 200,000 tokens from public seeds, committed as generated, with every earlier dev world untouched and @3 refusing a custody or private phrasing set; fails_when=an alias world plans at @2 or another profile, shares a seed, its committed files drift, @3 accepts a sealed plan before Set W's re-cut, or its phrasing names the entity outright; why_new=Garry's option 1 (2026-11-25) moves the weekly line's pilot to described subjects at 200k; seam=changing-facts-gen.ts devWorldPlan, devFiles, planWorld and ALIAS_PHRASING; no_claim=a rendered world's text
  test('they are @3 plans from public seeds, committed as generated, and @3 has only its public phrasing', () => {
    expect(BG1_DEV_ALIAS_CONVERSATIONS).toEqual(ALIAS);
    const files = devFiles();
    for (const id of ALIAS) {
      const plan = plans.get(id)!;
      expect([plan.generator, plan.seed, 'custody' in plan]).toEqual([BG1_ALIAS_GENERATOR_VERSION, BG1_DEV_SEEDS[id], false]);
      expect(BG1_DEV_SEEDS[id]).toBe('bg1-dev-alias-seed-v1:' + id);
      expect(() => checkPlan(plan)).not.toThrow();
      expect(aliasPlanProblems(plan)).toEqual([]);
      for (const rel of ['dev/worlds/' + id + '/plan.json', 'dev/worlds/' + id + '/questions.json', 'fixtures/worlds/' + id + '/world.json', 'fixtures/worlds/' + id + '/questions.json'])
        expect(readFileSync(join(BG1_DATA_DIR, rel), 'utf8')).toBe(files.get(rel)!);
    }
    expect(new Set(ALIAS.map(id => BG1_DEV_SEEDS[id])).size).toBe(3);
    expect(() => planWorld('bg1-dev-alias-01', 'x', { profile: 'alias', custody: true })).toThrow(PlanError);
    const templates = JSON.stringify(ALIAS_PHRASING.kinds) + JSON.stringify(ALIAS_PHRASING.frames);
    expect(templates).not.toContain('{n}');
    expect(templates).not.toContain("{e}'s");
  });

  // Value: protects=no question shares a distinctive word with the text of any of its evidence sessions, every described subject resolves to exactly one entity through the world's own lines, and some subjects take two steps; fails_when=a question names its subject or a value its evidence session holds, a description fits two entities or none, or the two-step descriptions vanish; why_new=GBEV-3's brief: no shared keyword links a question to its sessions, and every question keeps one right answer; seam=changing-facts-gen.ts questionLeaks, resolveSubject and describeSubject over the template render; no_claim=a Gemini render, which the alias_leak gate checks
  test('no question shares a distinctive word with its evidence sessions, and every subject resolves to one entity', () => {
    for (const plan of plans.values()) {
      const qs = buildQuestions(plan), text = textOf(plan);
      expect(qs).toHaveLength(64);
      expect(qs.filter(q => questionLeaks(q, text).length).map(q => q.id)).toEqual([]);
      for (const q of qs) expect(resolveSubject(plan, q.subject!.steps)).toEqual([q.subject!.entity]);
      expect(qs.filter(q => q.subject!.steps.length === 2).length).toBeGreaterThanOrEqual(8);
    }
  });

  // Value: protects=the leak check bites on the questions it replaces: @2 questions name their subject, so they share words with their evidence; fails_when=questionLeaks returns nothing for any question, so the zero leaks above prove nothing; why_new=the contrast the leak statistic is reported against; seam=questionLeaks on bg1-dev-01 (@2); no_claim=which words a grep agent would choose
  test('the same check finds the entity names @2 questions share with their evidence', () => {
    const plan = devWorldPlan('bg1-dev-01'), qs = buildQuestions(plan), text = textOf(plan);
    expect(qs.filter(q => questionLeaks(q, text).length).length).toBeGreaterThan(qs.length / 2);
  });

  // Value: protects=aliasPlanProblems refuses a plan whose aliases collide, so a nickname never names two entities; fails_when=two entities can share a nickname and the generator still writes the world; why_new=uniqueness is the reason the answer stays fixed by construction; seam=aliasPlanProblems on a mutated copy of bg1-dev-alias-01; no_claim=every way a plan can break
  test('a plan whose two entities share a nickname is refused', () => {
    const plan = structuredClone(plans.get('bg1-dev-alias-01')!) as WorldPlan;
    plan.entities[1].aliases!.nickname = plan.entities[0].aliases!.nickname;
    expect(aliasPlanProblems(plan).length).toBeGreaterThan(0);
  });

  // Value: protects=a misspelling stays readable: it keeps the first two letters, changes one letter, and prefers a vowel swap over a doubled consonant; fails_when=the rule goes back to doubling a letter after the first, which made "Sttonechat" and "Asshgrove"; why_new=the careful-person read of the alias worlds; seam=changing-facts-alias.ts misspellings; no_claim=that no misspelling is a real word
  test('misspellings keep the start of the word and swap a vowel first', () => {
    expect(misspellings('Stonechat')[0]).toBe('Stunechat');
    for (const w of ['Stonechat', 'Ashgrove', 'Bluebell', 'Brackenridge']) for (const m of misspellings(w)) {
      expect(m.slice(0, 2)).toBe(w.slice(0, 2));
      expect(Math.abs(m.length - w.length)).toBeLessThanOrEqual(1);
    }
  });

  // Value: protects=validate.ts --dev passes a template render of an alias world in a drill and fails a world whose session names an entity's canonical name outside its intro line with the alias_leak gate; fails_when=validate.ts skips renderLeaks for @3 worlds or a template render trips it; why_new=a Gemini render could hand a grep the link the plan withheld; seam=render.ts and validate.ts --dev in child processes with --fake; no_claim=Gemini's render
  test('validate.ts --dev passes an alias template render and fails a canonical name outside its intro', () => {
    const set = join(scratch('render'), 'set');
    expect(run('bun', [RENDER, '--dev', 'bg1-dev-alias-01', '--fake', '--set', set]).code).toBe(0);
    const pass = run('bun', [VALIDATE, '--dev', 'bg1-dev-alias-01', '--set', set, '--fake']);
    expect([pass.code, pass.err]).toEqual([0, '']);
    expect(record(set, 'bg1-dev-alias-01')).toMatchObject({ status: 'pass', target_tokens: 200_000 });
    const plan = plans.get('bg1-dev-alias-01')!, e = plan.entities[0];
    const intro = new Set(plan.sessions.filter(s => s.lines.some(l => l.purpose === 'intro' && l.refs!.some(r => r.entity === e.id))).map(s => s.id));
    const file = join(set, 'worlds', 'bg1-dev-alias-01', 'world.json'), world = JSON.parse(readFileSync(file, 'utf8'));
    const victim = world.sessions.find((s: { id: string }) => !intro.has(s.id));
    victim.turns[1].content += ' I also had lunch with ' + e.aliases!.name + '.';
    writeFileSync(file, JSON.stringify(world, null, 2) + '\n');
    expect(renderLeaks(plan, buildQuestions(plan), world).map(l => [l.session, l.kind, l.entity])).toEqual([[victim.id, 'canonical', e.id]]);
    expect(run('bun', [VALIDATE, '--dev', 'bg1-dev-alias-01', '--set', set, '--fake']).code).toBe(12);
    expect(record(set, 'bg1-dev-alias-01').failed).toContain('alias_leak');
  }, 120_000);

  // Value: protects=the bg1-dev loader takes the alias worlds, keyless only on their template fixtures; fails_when=corpus.ts leaves the alias ids out of the dev worlds or loads the fixtures for a paid run; why_new=the alias pilot loads these worlds; seam=corpus.ts loadBg1Dev; no_claim=the rendered worlds
  test('the bg1-dev loader takes the alias worlds', () => {
    const corpus = loadBg1Dev({ root: BG1_FIXTURES_ROOT, only: new Set(ALIAS), worldEnd: WORLD_END, keyless: true });
    expect(corpus.conversations.map(c => c.id)).toEqual(ALIAS);
    expect(corpus.questions).toHaveLength(192);
    expect(() => loadBg1Dev({ root: BG1_FIXTURES_ROOT, only: new Set(['bg1-dev-alias-01']), worldEnd: WORLD_END })).toThrow('template fixtures');
  });
});

describe('the alias pilot and judge check', () => {
  const pilot = generateWeeklyLinePilotCells(GBRAIN, 'BGW', 'alias');
  const judge = generateWeeklyLineJudgeCheckCells('alias');
  const manifest = buildWeeklyPilotManifest(GBRAIN, 'BGW', 'alias');
  const lsRemote = () => GBRAIN.commit + '\trefs/tags/' + GBRAIN.release;

  // Value: protects=each alias pilot cell is the standard pilot's cell moved to bg1-dev-alias-01 at set BGW's caps, the judge check runs on -02 and -03, and every cell schedules all 64 questions of each of its worlds; fails_when=an alias cell runs a standard world, takes BGW-long's caps, or schedules none of its questions because the split leaves the alias ids out (#627's long bug); why_new=the alias pilot; seam=weekly-line.ts at length alias and cell.ts devOnly and scheduledQuestions over the template fixtures; no_claim=measured costs
  test('each alias cell is the standard cell on the alias worlds, and schedules all their questions', () => {
    const standard = generateWeeklyLinePilotCells(GBRAIN);
    const strip = (c: object) => JSON.parse(JSON.stringify(c, (k, v) => (['id', 'cell_id', 'set', 'only_conversations'].includes(k) ? undefined : v)));
    expect(pilot.map(strip)).toEqual(standard.map(strip));
    expect(pilot.map(c => [c.set, c.only_conversations])).toEqual(pilot.map(() => ['BGW-pilot-alias', ['bg1-dev-alias-01']]));
    expect(judge.map(c => [c.set, c.only_conversations])).toEqual([['BGW-judge-alias', ['bg1-dev-alias-02', 'bg1-dev-alias-03']]]);
    expect(manifest.pilot_caps).toEqual(weeklyLinePilotCaps('BGW'));
    expect(() => generateWeeklyLinePilotCells(GBRAIN, 'BGW-long', 'alias')).toThrow('an alias pilot precedes a W1 block');
    for (const def of [...pilot, ...judge]) {
      expect(devOnly(def)).toEqual(new Set(def.only_conversations));
      const corpus = loadBg1Dev({ root: BG1_FIXTURES_ROOT, only: devOnly(def)!, worldEnd: WORLD_END, keyless: true });
      expect(scheduledQuestions(def, corpus, null).length).toBe(64 * def.only_conversations!.length);
    }
  });

  // Value: protects=the alias dry run launches the grep agent first, then the judge check, and marks every other row as launching only below the stop rule, which it prints verbatim, under campaign ids of its own with the scheduled questions per cell; fails_when=another row launches before the grep agent's three worlds are read, the stop rule's words drift from the amendment, or an alias campaign reuses a standard id; why_new=the 2026-11-25 amendment's pilot order; seam=pilot.ts pilotPlan and main plan; no_claim=the VM run
  test('the alias plan runs the grep agent first and prints the stop rule', () => {
    const plan = pilotPlan(manifest, null);
    expect(plan.ledgers.map(l => [l.name, l.after_stop_rule ?? false])).toEqual([
      ['pilot-grep-agent', false], ['judge-check', false], ['judge-check-label', false], ['pilot-extract-first', true], ['pilot-extract-first-reread', true],
      ['pilot-gbrain', true], ['pilot-gbrain-reread', true], ['pilot-memory-bank', true], ['pilot-memory-bank-reread', true]]);
    expect(plan.ledgers.filter(l => l.campaign_id).every(l => /^q1-scoreboard-weekly-(pilot|judge-check)-alias/.test(l.campaign_id!))).toBe(true);
    expect(plan.cells.map(c => c.questions)).toEqual([64, 64, 64, 64, 128]);
    expect(STOP_RULE).toBe('If the Opus grep agent scores 95% or more on the pilot, the line stops and we publish the grep result.');
    expect(plan.stop_rule).toBe(STOP_RULE);
    const lines: string[] = [];
    expect(pilotMain(['plan', '--length', 'alias'], { lsRemote, env: {} }, s => lines.push(s))).toBe(0);
    expect(lines.join('\n')).toContain('Stop rule: ' + STOP_RULE);
    expect(pilotPlan(buildWeeklyPilotManifest(GBRAIN), null).ledgers.map(l => l.name).slice(0, 2)).toEqual(['pilot-extract-first', 'pilot-extract-first-reread']);
  });

  // Value: protects=the stop rule pools the grep agent's claude-opus-5-5 accuracy over all three alias worlds weighted by answers, stops only when every world is read and the pool reaches 0.95, and then reports the rows it kept from launching as not run rather than failed; fails_when=the rule reads one world, averages cells unweighted, stops with a world missing, or fails the line for rows it never launched; why_new=the 2026-11-25 amendment; seam=pilot.ts pooledGrepOpus and pilotReport on fake readings; no_claim=real answers
  test('the stop rule pools all three worlds and leaves the unlaunched rows as not run', () => {
    const row = (block: string, worlds: string[], n: number, acc: number): RowReading => ({ row: 'grep-agent', cell: block, block, worlds, answers: 2 * n, by_reader: { 'anthropic:claude-opus-5-5': n, 'particle:particle-1': n },
      outcomes: { scored: 2 * n }, verdicts: { needed: 2 * n, given: 2 * n, parse_failed: 0 }, accuracy: { 'anthropic:claude-opus-5-5': acc, 'particle:particle-1': 0.5 }, spend_usd: 1, spend_source: 'proxy', part_under_test: { ran: true, detail: {} } });
    const p = row('BGW-pilot', ['bg1-dev-alias-01'], 64, 0.92), j = row('BGW-judge', ['bg1-dev-alias-02', 'bg1-dev-alias-03'], 128, 0.98);
    expect(pooledGrepOpus([p, j], ALIAS)).toMatchObject({ grep_agent_opus_accuracy: 0.96, answers: 192, complete: true, stops_line: true });
    expect(pooledGrepOpus([j], ALIAS)).toMatchObject({ complete: false, stops_line: false });
    expect(pooledGrepOpus([p, row('BGW-judge', ['bg1-dev-alias-02', 'bg1-dev-alias-03'], 128, 0.95)], ALIAS).stops_line).toBe(false);
    const report = pilotReport([p, j], [], manifest);
    expect(report.ceiling).toMatchObject({ grep_agent_opus_accuracy: 0.96, line: CEILING, triggers_longer_worlds: false, stop_rule: { stops_line: true } });
    expect(Object.entries(report.rows).filter(([r]) => r !== 'grep-agent').map(([, x]) => [x.pass, (x as { not_run?: string }).not_run])).toEqual([[true, 'the stop rule'], [true, 'the stop rule'], [true, 'the stop rule']]);
    const below = pilotReport([p, row('BGW-judge', ['bg1-dev-alias-02', 'bg1-dev-alias-03'], 128, 0.9)], [], manifest);
    expect(Object.entries(below.rows).filter(([r]) => r !== 'grep-agent').every(([, x]) => !x.pass)).toBe(true);
  });
});
