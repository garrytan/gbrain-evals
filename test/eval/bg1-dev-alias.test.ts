/**
 * changing-facts-gen@3's described subjects (GBEV-128, Garry's option 1 of 2026-11-25): the three alias public dev worlds
 * bg1-dev-alias-01 to -03 in eval/generators/changing-facts-gen.ts and changing-facts-alias.ts, their leak and uniqueness
 * checks, validate.ts --dev's alias_leak gate, their loader, and the alias pilot and judge check that
 * eval/runner/weekly-line/pilot.ts plans with the grep agent first. Keyless: child processes run with only PATH and HOME
 * and every provider key blanked, renders are --fake, and nothing builds a client.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  ALIAS_PHRASING, aliasPlanProblems, BG1_ALIAS_GENERATOR_VERSION, BG1_DATA_DIR, BG1_DEV_SEEDS, buildQuestions, checkPlan, devFiles, devWorldPlan, PlanError, planWorld,
  isolatingWords, questionLeaks, renderLeaks, renderTemplateWorld, resolveSubject, type WorldPlan,
} from '../../eval/generators/changing-facts-gen.ts';
import { misspellings } from '../../eval/generators/changing-facts-alias.ts';
import { BG1_DEV_ALIAS_CONVERSATIONS } from '../../eval/runner/memory-qa/bg1-names.ts';
import { BG1_FIXTURES_ROOT, loadBg1Dev, type MemoryQuestion } from '../../eval/runner/memory-qa/corpus.ts';
import { answerId, sha256, type AnswerRecord } from '../../eval/runner/memory-qa/records.ts';
import { devOnly, scheduledQuestions } from '../../eval/runner/q1/cell.ts';
import { bg1JudgeOf } from '../../eval/runner/q1/cells/definitions.ts';
import { buildWeeklyPilotManifest, generateWeeklyLineJudgeCheckCells, generateWeeklyLinePilotCells, WEEKLY_ALIAS_PILOT_MONEY, weeklyLinePilotCaps } from '../../eval/runner/q1/cells/weekly-line.ts';
import {
  CEILING, judgeCheckShortfall, main as pilotMain, pilotPlan, pilotReport, PilotError, pooledGrepOpus, readRow, STOP_RULE, stopRuleLabel, stopRuleReading, writePilotCampaigns, type StopReading,
} from '../../eval/runner/weekly-line/pilot.ts';
import { goldLabel } from '../../eval/runner/weekly-line/judge-check.ts';
import { matchAnswer } from '../../eval/runner/bg1/match.ts';

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

  // Value: protects=the number of questions whose kind word alone finds their evidence (only one entity in the world holds a slot of that kind) stays the 8 of 192 Amendment 1 states; fails_when=a generator change lets more questions be found by a kind word without resolving the subject, or the amendment's count goes stale; why_new=/ship review p1 red-team (the leak check leaves template words out); seam=changing-facts-gen.ts isolatingWords over the committed plans; no_claim=how a grep agent phrases its searches
  test('8 of the 192 questions can be found by their kind word alone, as Amendment 1 states', () => {
    const counts = [...plans.values()].map(plan => buildQuestions(plan).filter(q => isolatingWords(plan, q).length).length);
    expect(counts).toEqual([3, 2, 3]);
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

  // Value: protects=buildQuestions refuses an @3 world whose question shares a distinctive word with its evidence lines or whose description fits two entities, so the generator never writes one (planWorld moves to its next attempt, then refuses); fails_when=the checks run only in this test file, so a future @3 world could be written leaking or ambiguous; why_new=/ship review p2 adversarial #1 and GBEV-3's ruling of 2026-11-25 (item 3); seam=changing-facts-gen.ts buildQuestions on mutated copies of bg1-dev-alias-01; no_claim=a Gemini render, which validate.ts's alias_leak gate checks
  test('the generator refuses a world whose question leaks into its evidence or fits two entities', () => {
    const base = plans.get('bg1-dev-alias-01')!, qs = buildQuestions(base);
    const q = qs[0], leaky = structuredClone(base) as WorldPlan;
    const line = leaky.sessions.find(x => x.id === q.evidence_sessions[0])!.lines.find(l => !l.purpose)!;
    line.text = line.text.replace(/\.$/, ', right after the ' + q.subject!.terms[0] + ' business.');
    expect(() => buildQuestions(leaky)).toThrow(PlanError);
    expect(() => buildQuestions(leaky)).toThrow(q.id + ' shares');
    const one = qs.find(x => x.subject!.steps.length === 1)!, twin = structuredClone(base) as WorldPlan;
    const subject = twin.entities.find(e => e.id === one.subject!.entity)!, other = twin.entities.find(e => e.type === subject.type && e.id !== subject.id)!;
    const session = twin.sessions.find(x => x.lines.some(l => l.purpose === 'property' && l.refs![0].entity === subject.id))!;
    const prop = session.lines.find(l => l.purpose === 'property' && l.refs![0].entity === subject.id)!;
    const said = subject.aliases![prop.refs![0].alias as 'nickname'], at = prop.text.toLowerCase().indexOf(said.toLowerCase());
    expect(at).toBeGreaterThanOrEqual(0);
    session.lines.push({ ...prop, text: prop.text.slice(0, at) + other.aliases!.nickname + prop.text.slice(at + said.length), refs: [{ entity: other.id, alias: 'nickname' }] });
    expect(() => buildQuestions(twin)).toThrow('fits');
  });

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
    const strip = (c: object) => JSON.parse(JSON.stringify(c, (k, v) => (['id', 'cell_id', 'set', 'only_conversations', 'lease'].includes(k) ? undefined : v)));
    expect(pilot.map(strip)).toEqual(standard.map(strip));
    expect(pilot.map(c => [c.set, c.only_conversations])).toEqual(pilot.map(() => ['BGW-pilot-alias', ['bg1-dev-alias-01']]));
    expect(judge.map(c => [c.set, c.only_conversations])).toEqual([['BGW-judge-alias', ['bg1-dev-alias-02', 'bg1-dev-alias-03']]]);
    expect(manifest.pilot_caps).toEqual(weeklyLinePilotCaps('BGW', 'alias'));
    for (const c of pilot) { const cap = Object.values(manifest.pilot_caps).find(x => c.lease!.usd === x.cells_cap_usd)!; expect(Math.round((c.lease!.usd + cap.reread_cap_usd) * 100) / 100).toBe(WEEKLY_ALIAS_PILOT_MONEY.row_cap_usd[cap.row]); }
    expect(judge[0].lease!.usd).toBe(WEEKLY_ALIAS_PILOT_MONEY.judge_check_cells_usd);
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
      ['mint', false], ['pilot-grep-agent', false], ['judge-check', false], ['judge-check-label', false], ['pilot-extract-first', true], ['pilot-extract-first-reread', true],
      ['pilot-gbrain', true], ['pilot-gbrain-reread', true], ['pilot-memory-bank', true], ['pilot-memory-bank-reread', true]]);
    expect(plan.ledgers.filter(l => l.campaign_id).every(l => /^q1-scoreboard-weekly-(pilot|judge-check)-alias/.test(l.campaign_id!))).toBe(true);
    expect(plan.cells.map(c => c.questions)).toEqual([64, 64, 64, 64, 128]);
    expect(plan.window).toEqual({ mint_usd: 15, grep_first_usd: 14, after_stop_rule_usd: 16, total_usd: 45, window_usd: 45 });
    expect(plan.ledgers.filter(l => l.kind === 'reread').map(l => l.cap_usd)).toEqual([1.15, 1.15, 1.15]);
    expect(plan.ledgers.find(l => l.kind === 'mint')!.estimate_usd).toBeLessThanOrEqual(15);
    expect(plan.totals.cap_usd).toBeLessThanOrEqual(WEEKLY_ALIAS_PILOT_MONEY.window_usd);
    expect(STOP_RULE).toBe('If the Opus grep agent scores 95% or more on the pilot, the line stops and we publish the grep result.');
    expect(plan.stop_rule).toBe(STOP_RULE);
    const lines: string[] = [];
    expect(pilotMain(['plan', '--length', 'alias'], { lsRemote, env: {} }, s => lines.push(s))).toBe(0);
    expect(lines.join('\n')).toContain('Stop rule: ' + STOP_RULE);
    expect(pilotPlan(buildWeeklyPilotManifest(GBRAIN), null).ledgers.map(l => l.name).slice(0, 2)).toEqual(['pilot-extract-first', 'pilot-extract-first-reread']);
  });

  const OPUS = 'anthropic:claude-opus-5-5', PARTICLE = 'particle:particle-1';
  const corpus = loadBg1Dev({ root: BG1_FIXTURES_ROOT, only: new Set(ALIAS), worldEnd: WORLD_END, keyless: true });
  const pilotGrep = pilot.find(c => c.system === 'baseline-file-agent')!, judgeGrep = judge[0];
  type Answer = { text: string; outcome?: AnswerRecord['outcome'] };
  const PAID = { keyless: false, paid_window: 'test-window' };
  /** A grep-agent cell's out dir on its alias worlds: each reader's answer from `answer`, its gating judge's verdict from `verdict`, and the receipt's upstream record. */
  function grepCell(def: typeof judgeGrep, answer: (q: MemoryQuestion, reader: string, i: number) => Answer, verdict: (q: MemoryQuestion, reader: string, i: number) => 0 | 1 | null, status = 'complete', upstream: object | null = PAID) {
    const out = scratch('grep-cell'), cell = def.arms[0].cell_id, dir = join(out, 'cells', cell);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'receipt.json'), JSON.stringify({ run_cell: def.id, block: def.block, run_status: status, ...(upstream ? { upstream } : {}), system: { kind: 'baseline-file-agent', versions: { ripgrep: '14.1.0' } } }));
    const answers: string[] = [], judgments: string[] = [];
    corpus.questions.filter(q => def.only_conversations!.includes(q.conversation)).forEach((q, i) => {
      for (const reader of [OPUS, PARTICLE]) {
        const a = answer(q, reader, i), outcome = a.outcome ?? 'scored';
        const rec = { answer_id: answerId(cell, q.id, reader, 0), cell_id: cell, realization_id: 'r', question_id: q.id, conversation: q.conversation, system: 'baseline-file-agent', arm: 'whole-agent', reader, replicate: 0, effort: 'high',
          context_sha256: sha256(q.id), text: a.text, usage: { input: 10, output: 5, cache_read: 0, cache_write: 0 }, provider_input_tokens: 10, latency_ms: 1000, outcome, stop_reason: 'submitted', turns: 3, tool_calls: { grep: { calls: 2, failed: 0 } }, usd: 0.01 };
        answers.push(JSON.stringify(rec));
        const score = verdict(q, reader, i);
        if (outcome === 'scored' && score !== null) judgments.push(JSON.stringify({ answer_id: rec.answer_id, instrument_id: 'bg1', instrument_sha256: sha256('i'), judge: bg1JudgeOf(reader), judge_replicate: 0, temperature: null, score, parse_ok: true, raw_sha256: sha256('[]'), outcome: 'scored' }));
      }
    });
    writeFileSync(join(dir, 'answers.ndjson'), answers.join('\n') + '\n');
    writeFileSync(join(dir, 'judgments.ndjson'), judgments.join('\n') + '\n');
    return out;
  }
  const gold = (q: MemoryQuestion): Answer => ({ text: 'The answer is ' + (q.bg1!.stratum === 's8_history' ? q.bg1!.gold_values.join(', then ') : q.bg1!.gold_values[0]) + '.' });
  const stale = (q: MemoryQuestion): Answer => ({ text: 'The answer is ' + (q.bg1!.stale_values[0] ?? q.bg1!.decoy_values[0] ?? 'purple elephants') + '.' });
  const right = () => 1 as const, wrong = () => 0 as const;
  const read = (answer: (q: MemoryQuestion, reader: string, i: number) => Answer, verdict: (q: MemoryQuestion, reader: string, i: number) => 0 | 1) =>
    [readRow(grepCell(pilotGrep, answer, verdict)), readRow(grepCell(judgeGrep, answer, verdict))].flat();

  // Value: protects=the stop rule scores the grep agent's claude-opus-5-5 answers on all three alias worlds against the construction labels, so judge verdicts never move it across 0.95; a missing or failed answer blocks the reading and never counts as right; a cell outside the manifest or read twice is refused; rows the rule keeps from launching read as not run, and rows a short judge check holds read as held; fails_when=the rule reads judge verdicts, reads one world, counts a reader error as an answer or as right, accepts a stray or repeated cell, or fails the line for rows it never launched; why_new=/ship review p2 (outside voice #1, red-team #3) and GBEV-3's ruling of 2026-11-25 (items 2 and 4); seam=pilot.ts readRow, stopRuleReading and pilotReport over written cells on the alias fixtures; no_claim=real answers
  test('the stop rule reads construction labels over all three worlds and waits for every answer', () => {
    const all = read(gold, wrong);
    expect(stopRuleReading(manifest, all)).toMatchObject({ grep_agent_opus_accuracy: 1, correct: 192, answers: 192, expected_answers: 192, missing: 0, complete: true, stops_line: true, scored_by: 'construction labels' });
    const someStale = (q: MemoryQuestion, r: string, i: number) => (i % 10 === 0 ? stale(q) : gold(q));
    const below = read(someStale, right), b = stopRuleReading(manifest, below);
    expect(b).toMatchObject({ complete: true, stops_line: false });
    expect(b.grep_agent_opus_accuracy!).toBeLessThan(CEILING);
    const failedOne = (q: MemoryQuestion, r: string, i: number): Answer => (i === 3 && r === OPUS ? { text: '', outcome: 'reader_error' } : gold(q));
    expect(stopRuleReading(manifest, read(failedOne, right))).toMatchObject({ answers: 190, missing: 2, failed: 2, complete: false, stops_line: false });
    expect(stopRuleReading(manifest, readRow(grepCell(judgeGrep, gold, right)))).toMatchObject({ missing: 64, complete: false, stops_line: false });
    expect(stopRuleReading(manifest, [readRow(grepCell(pilotGrep, gold, right, 'partial')), readRow(grepCell(judgeGrep, gold, right))].flat())).toMatchObject({ cells_complete: false, complete: false, stops_line: false });
    const one = readRow(grepCell(pilotGrep, gold, right));
    expect(() => stopRuleReading(manifest, [...one, ...one])).toThrow('read more than once');
    expect(() => stopRuleReading(manifest, [{ ...one[0], cell: 'bgw-pilot.baseline-file-agent.baseline' }])).toThrow('not a grep-agent cell of this pilot');
    const report = pilotReport(all, [], manifest);
    expect(report.ceiling).toMatchObject({ grep_agent_opus_accuracy: 1, line: CEILING, triggers_longer_worlds: false, stop_rule: { stops_line: true } });
    const others = (r: ReturnType<typeof pilotReport>) => Object.entries(r.rows).filter(([row]) => row !== 'grep-agent').map(([, x]) => [x.pass, (x as { not_run?: string }).not_run ?? (x as { held?: string }).held]);
    expect(others(report)).toEqual([[true, 'the stop rule'], [true, 'the stop rule'], [true, 'the stop rule']]);
    expect(others(pilotReport(below, [], manifest))).toEqual([[false, undefined], [false, undefined], [false, undefined]]);
    expect(others(pilotReport(below, [], manifest, 'JUDGE_CHECK_SHORT: x'))).toEqual([[false, 'the judge check is short: JUDGE_CHECK_SHORT: x'], [false, 'the judge check is short: JUDGE_CHECK_SHORT: x'], [false, 'the judge check is short: JUDGE_CHECK_SHORT: x']]);
  });

  // Value: protects=the stop rule scores every committed reference answer of the three alias worlds right, 192 of 192, and a stale answer set (each question's latest withdrawn or superseded value) well below 0.95, while BG1's matchAnswer and the judge check's goldLabel read the withdrawal answers exactly as before; fails_when=the stop-rule scorer can't pass its own gold (the 24 withdrawal answers that name the withdrawn partner beside a none-form read as unsettled), passes a stale set, or the fix moves the shared matcher that BG1's and BG1-C's counted verdicts use; why_new=GBEV-3's ruling of 2026-11-25 on #650's blocker 1 ("the 192 reference answers must score 192/192 under the stop-rule scorer, and a deliberately stale answer set must score below 0.95"); seam=pilot.ts stopRuleLabel through readRow and stopRuleReading over written cells on the alias fixtures; no_claim=real answers
  test('the stop rule scores the 192 reference answers 192/192 and a stale answer set below 0.95', () => {
    const reference = (q: MemoryQuestion): Answer => ({ text: q.answer! });
    const ref = stopRuleReading(manifest, read(reference, wrong));
    console.log('reference answers: ' + ref.correct + '/' + ref.expected_answers + ', accuracy ' + ref.grep_agent_opus_accuracy);
    expect(ref).toMatchObject({ correct: 192, answers: 192, expected_answers: 192, unsettled: 0, grep_agent_opus_accuracy: 1, complete: true });
    const staleAnswer = (q: MemoryQuestion): Answer => ({ text: q.bg1!.stale_values.at(-1) ?? (q.bg1!.ordered ? [...q.bg1!.gold_values].reverse().join(', then ') : q.bg1!.decoy_values[0]) });
    const st = stopRuleReading(manifest, read(staleAnswer, right));
    console.log('stale answers: ' + st.correct + '/' + st.expected_answers + ', accuracy ' + st.grep_agent_opus_accuracy);
    expect(st.complete).toBe(true);
    expect(st.grep_agent_opus_accuracy!).toBeLessThan(0.95);
    const withdrawn = corpus.questions.filter(q => q.bg1!.stratum === 's5_withdrawn');
    expect(withdrawn).toHaveLength(24);
    for (const q of withdrawn) {
      expect([matchAnswer(q, q.answer!), goldLabel(q, { stop_reason: null, text: q.answer! }).gold]).toEqual(['unclear', null]);
      const [partner] = q.bg1!.stale_values;
      expect(stopRuleLabel(q, { stop_reason: null, text: partner })).toBe(0);
      expect(stopRuleLabel(q, { stop_reason: null, text: partner + ', and nothing else is planned.' })).toBeNull();
      expect(stopRuleLabel(q, { stop_reason: null, text: "I couldn't find anything; nothing came up about " + partner + '.' })).toBeNull();
      if (q.bg1!.decoy_values.length) expect(stopRuleLabel(q, { stop_reason: null, text: 'None: ' + partner + ' was called off, but ' + q.bg1!.decoy_values[0] + ' is in talks.' })).toBeNull();
    }
    for (const q of corpus.questions.filter(x => x.bg1!.stratum !== 's5_withdrawn'))
      for (const text of [q.answer!, staleAnswer(q).text, 'None: ' + q.answer + ' was called off.'])
        expect(stopRuleLabel(q, { stop_reason: null, text })).toBe(goldLabel(q, { stop_reason: null, text }).gold);
  });

  // Value: protects=the judge check's own sampler reads the grep agent's cells as short when its judges called too few answers wrong, which holds the other rows; fails_when=judgeCheckShortfall reads a sample the judge check would refuse as drawable, or refuses a drawable one; why_new=GBEV-3's ruling of 2026-11-25 (item 4): the other rows wait when the judge check can't get 40 wrong answers; seam=pilot.ts judgeCheckShortfall over judge-check.ts poolAnswers and buildSample on written cells; no_claim=real verdicts
  test('the judge check reads short when its judges called too few answers wrong', () => {
    expect(judgeCheckShortfall([grepCell(pilotGrep, gold, right), grepCell(judgeGrep, gold, right)], 'alias')).toContain('JUDGE_CHECK_SHORT');
    const half = (q: MemoryQuestion, r: string, i: number) => (i % 2 ? 1 : 0) as 0 | 1;
    expect(judgeCheckShortfall([grepCell(pilotGrep, gold, half), grepCell(judgeGrep, gold, half)], 'alias')).toBeNull();
  });

  // Value: protects=a judge with no verdict at all reads as short, so the judge check never passes on the other judge alone and the other rows stay held; fails_when=buildSample draws only the judges that gave a verdict, so a pool where claude-opus-5-5's judge has 100 verdicts with 40 wrong and particle-1's judge has none reads as drawable; why_new=GBEV-3's ruling of 2026-11-25 on #650's blocker 2; seam=pilot.ts judgeCheckShortfall over judge-check.ts buildSample, then pilotReport and writePilotCampaigns, on written cells; no_claim=real verdicts
  test('a judge with no verdicts reads as short and the other rows stay held', () => {
    const at = new Map(corpus.questions.map((q, i) => [q.id, i]));
    const oneJudge = (q: MemoryQuestion, r: string) => { const i = at.get(q.id)!; return r !== OPUS || i >= 100 ? null : i < 40 ? 0 : 1; };
    const someStale = (q: MemoryQuestion, r: string, i: number) => (i % 10 === 0 ? stale(q) : gold(q));
    const dirs = [grepCell(pilotGrep, someStale, oneJudge), grepCell(judgeGrep, someStale, oneJudge)];
    const short = judgeCheckShortfall(dirs, 'alias');
    expect(short).toContain('JUDGE_CHECK_SHORT: ' + bg1JudgeOf(PARTICLE) + ' has 0 answers with a verdict');
    const rows = dirs.flatMap(d => readRow(d)), reading = stopRuleReading(manifest, rows);
    expect(reading).toMatchObject({ complete: true, stops_line: false });
    const held = Object.entries(pilotReport(rows, [], manifest, short).rows).filter(([row]) => row !== 'grep-agent').map(([, x]) => [x.pass, (x as { held?: string }).held]);
    expect(held).toEqual(['extract-first', 'gbrain', 'memory-bank'].map(() => [false, 'the judge check is short: ' + short]));
    expect(() => writePilotCampaigns(manifest, { out: scratch('held'), window: 'test-window', windowCapUsd: 45, worldEnd: WORLD_END, stopReading: { ...reading, judge_check_short: short } })).toThrow('PILOT_JUDGE_CHECK_SHORT');
  });

  // Value: protects=campaigns --grep-cell writes the other rows only from cells whose receipts record real providers under a granted paid window, so a completed keyless rehearsal, which shares the paid cell's id, or a receipt from before the record never moves the stop rule; fails_when=the stop rule reads a keyless or unrecorded cell as complete, or campaigns writes the other rows from one; why_new=GBEV-3's ruling of 2026-11-25 on #650's blocker 3; seam=pilot.ts main campaigns --grep-cell through readRow, stopRuleReading and writePilotCampaigns on written cells; no_claim=the cell runner's own receipt, which weekly-line-execution.test.ts reads
  test('campaigns --grep-cell refuses a completed keyless or rehearsal cell', () => {
    const someStale = (q: MemoryQuestion, r: string, i: number) => (i % 10 === 0 ? stale(q) : gold(q));
    const half = (q: MemoryQuestion, r: string, i: number) => (i % 2 ? 1 : 0) as 0 | 1;
    const campaigns = (dirs: string[]) => pilotMain(['campaigns', '--length', 'alias', '--out', scratch('camp'), '--window-granted', 'test-window', '--window-cap-usd', '45', '--world-end', WORLD_END, ...dirs.flatMap(d => ['--grep-cell', d])], { lsRemote, env: {} }, () => {});
    expect(campaigns([grepCell(pilotGrep, someStale, half), grepCell(judgeGrep, someStale, half)])).toBe(0);
    for (const upstream of [{ keyless: true, paid_window: null }, null, { keyless: false, paid_window: null }]) {
      const rehearsal = grepCell(pilotGrep, someStale, half, 'complete', upstream), paid = grepCell(judgeGrep, someStale, half);
      expect(stopRuleReading(manifest, [...readRow(rehearsal), ...readRow(paid)])).toMatchObject({ cells_complete: true, unpaid: [pilotGrep.id], complete: false, stops_line: false });
      expect(() => campaigns([rehearsal, paid])).toThrow('PILOT_NOT_PAID: ' + pilotGrep.id + ' is not a paid cell');
    }
    const allGold = [grepCell(pilotGrep, gold, half, 'complete', { keyless: true, paid_window: null }), grepCell(judgeGrep, gold, half, 'complete', { keyless: true, paid_window: null })];
    expect(stopRuleReading(manifest, allGold.flatMap(d => readRow(d)))).toMatchObject({ grep_agent_opus_accuracy: 1, complete: false, stops_line: false });
  });

  // Value: protects=the alias campaigns write the mint, the grep agent's pilot, the judge check and its labelling first, hold the other rows until a complete reading below 0.95 that the judge check can sample, and refuse either stage unless the mint and both stages fit one window's cap together; fails_when=campaigns writes a row the stop rule or a short judge check keeps from running, writes the grep stage again with the other rows, or lets the two stages and the mint pass the window between them; why_new=/ship review p1 specialist (the stop rule was only a label), p2 targeted money note and GBEV-3's ruling of 2026-11-25 (items 4 and 6); seam=pilot.ts writePilotCampaigns with fake readings; no_claim=the VM run
  test('the alias campaigns hold the other rows for a complete reading below the line and keep all three stages inside one window', () => {
    const reading = (acc: number, complete = true, short: string | null = null): StopReading => ({ ...pooledGrepOpus([], ['q']), grep_agent_opus_accuracy: acc, answers: 192, expected_answers: 192, worlds: ALIAS, cells_complete: complete, complete, stops_line: complete && acc >= CEILING, judge_check_short: short });
    const write = (stopReading?: StopReading, cap = 45) => writePilotCampaigns(manifest, { out: scratch('campaigns'), window: 'test-window', windowCapUsd: cap, worldEnd: WORLD_END, stopReading });
    const first = write();
    expect(first.campaigns.map(c => c.name)).toEqual(['pilot-grep-agent', 'judge-check']);
    expect(first.commands.map(c => c.name)).toEqual(['judge-check-label', 'mint']);
    expect(first.commands.find(c => c.name === 'mint')!.argv).toEqual(['eval/custody/bg1/mint.sh', '--dev', '--worlds', ALIAS.join(','), '--paid-window', 'test-window', '--window-cap-usd', '15']);
    expect(() => write(reading(0.97))).toThrow(PilotError);
    expect(() => write(reading(0.97))).toThrow(STOP_RULE);
    expect(() => write(reading(0.9, false))).toThrow('not complete');
    expect(() => write(reading(0.9, true, 'JUDGE_CHECK_SHORT: x'))).toThrow('PILOT_JUDGE_CHECK_SHORT');
    expect(() => write({ ...reading(0.9), judge_check_short: undefined })).toThrow('PILOT_JUDGE_CHECK_SHORT');
    const rest = write(reading(0.9));
    expect(rest.campaigns.map(c => c.name)).toEqual(['pilot-extract-first', 'pilot-gbrain', 'pilot-memory-bank']);
    expect(rest.commands.map(c => c.name)).toEqual(['pilot-extract-first-reread', 'pilot-gbrain-reread', 'pilot-memory-bank-reread']);
    expect(() => write(undefined, 44.99)).toThrow('PILOT_OVER_WINDOW');
    expect(() => write(reading(0.9), 44.99)).toThrow('PILOT_OVER_WINDOW');
    expect(() => writePilotCampaigns(buildWeeklyPilotManifest(GBRAIN), { out: scratch('std'), window: 'w', windowCapUsd: 1e6, worldEnd: WORLD_END, stopReading: reading(0.9) })).toThrow('only the alias pilot');
  });
});
