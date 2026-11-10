/**
 * BG1's world generator (GST-2010): eval/generators/changing-facts-gen.ts. The plan's shape, one independent oracle
 * per stratum on hand-built slots, the gold of every committed dev question against its oracle, the intent cross-check,
 * phrasing and seeds, the committed files against a fresh generation, and the template fixtures against the
 * deterministic render check. Keyless and offline.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  BG1_CUSTODY_MARKER, BG1_DATA_DIR, BG1_DEV_SEEDS, BG1_FIXTURE_TOKENS, BG1_FUTURE_DAYS, BG1_SESSIONS, BG1_SLOTS_PER_STRATUM, BG1_WORLD_END_WEEKDAY, PUBLIC_PHRASING,
  PlanError, buildQuestions, checkPhrasing, checkPlan, deriveGold, devFiles, goldFields, oracleAsKnown, oracleAsOf, oracleConflicting, oracleCorrected, oracleHistory,
  oracleRepeatedStale, oracleUpdated, oracleWithdrawn, planWorld, queryDayOf, renderBriefs, sealedWorldSeed, termsOf, weekdayOf, worldTokens,
  type QuestionRecord, type Slot, type SlotEvent, type World, type WorldPlan,
} from '../../eval/generators/changing-facts-gen.ts';
import { BG1_DEV_CONVERSATIONS, BG1_PRIMARY, BG1_QUESTIONS_PER_STRATUM, BG1_STRATA } from '../../eval/runner/bg1/types.ts';

const REPO = resolve(import.meta.dir, '../..');
const read = <T>(rel: string) => JSON.parse(readFileSync(join(BG1_DATA_DIR, rel), 'utf8')) as T;
const plans = Object.fromEntries(BG1_DEV_CONVERSATIONS.map(id => [id, read<WorldPlan>(`dev/worlds/${id}/plan.json`)]));
const questions = Object.fromEntries(BG1_DEV_CONVERSATIONS.map(id => [id, read<QuestionRecord[]>(`dev/worlds/${id}/questions.json`)]));

/** A hand-built slot: events as [type, value, said day, valid day, extra]. */
function slot(stratum: Slot['stratum'], events: Array<[SlotEvent['type'], string, number, number | null, Partial<SlotEvent>?]>): Slot {
  return { id: 'person-01.city', entity: 'person-01', kind: 'city', stratum, intent: { now: null, history: [] },
    events: events.map(([type, value, said, valid_from, extra], i) => ({ id: `e${i}`, type, value, session: `s${i}`, said, valid_from, ...extra })) };
}

describe('the oracles, on hand-built slots', () => {
  test('s1: the value in effect on the question day by valid time; a late report counts from its valid day, a scheduled change after the run does not', () => {
    const s = slot('s1_updated', [['state', 'A', -400, -400], ['late', 'B', -100, -200], ['change', 'C', -50, -50], ['scheduled', 'D', -20, 60]]);
    expect(oracleUpdated(s).values).toEqual(['C']);
    expect(oracleUpdated(s).events.map(e => e.id)).toEqual(['e2', 'e3']);
    expect(oracleAsOf(s, -150).values).toEqual(['B']);
    expect(oracleAsKnown(s, -150).values).toEqual(['A']);
    expect(oracleHistory(s).values).toEqual(['A', 'B', 'C']);
    const pending = slot('s1_updated', [['state', 'A', -400, -400], ['scheduled', 'B', -30, 45]]);
    expect(oracleUpdated(pending).values).toEqual(['A']);
  });

  test('s2: a correction replaces the value it says was never true, from that value\'s valid time', () => {
    const s = slot('s2_corrected', [['state', 'X', -500, -500], ['change', 'A', -300, -300], ['correct', 'B', -100, -300, { replaces: 'e1' }]]);
    expect(oracleCorrected(s).values).toEqual(['B']);
    expect(oracleCorrected(s).events.map(e => e.id)).toEqual(['e1', 'e2']);
    expect(oracleHistory(s).values).toEqual(['X', 'B']);
    expect(oracleAsOf(s, -200).values).toEqual(['B']);
    expect(oracleAsKnown(s, -200).values).toEqual(['A']);
    expect(oracleAsKnown(s, -90).values).toEqual(['B']);
  });

  test('s3: mentions of the old value never outweigh the one later change', () => {
    const s = slot('s3_repeated_stale', [['state', 'A', -500, -500], ...Array.from({ length: 12 }, (_, i) => ['mention', 'A', -480 + 30 * i, null] as [SlotEvent['type'], string, number, null]), ['change', 'B', -60, -60]]);
    expect(oracleRepeatedStale(s).values).toEqual(['B']);
    expect(oracleRepeatedStale(s).events.map(e => e.value)).toEqual(['B']);
  });

  test('s4: the executed or owner-confirmed source wins over later drafts, recaps and notes; a later effective date breaks a tie', () => {
    const s = slot('s4_conflicting', [['source', 'P1', -300, -300, { source: 'recap' }], ['source', 'P2', -250, -250, { source: 'owner_confirmed' }], ['source', 'P3', -200, -200, { source: 'draft' }], ['source', 'P4', -100, -100, { source: 'agent_note' }]]);
    expect(oracleConflicting(s).values).toEqual(['P2']);
    const tie = slot('s4_conflicting', [['source', 'P1', -300, -300, { source: 'executed' }], ['source', 'P2', -100, -100, { source: 'executed' }]]);
    expect(oracleConflicting(tie).values).toEqual(['P2']);
    const executed = slot('s4_conflicting', [['source', 'P1', -300, -300, { source: 'owner_confirmed' }], ['source', 'P2', -310, -310, { source: 'executed' }]]);
    expect(oracleConflicting(executed).values).toEqual(['P2']);
  });

  test('s5: a withdrawn plan or a retracted rumour leaves nothing current', () => {
    const off = slot('s5_withdrawn', [['plan', 'M', -300, -300], ['plan', 'M', -250, -250], ['withdraw', 'M', -100, null]]);
    expect(oracleWithdrawn(off).values).toEqual([]);
    expect(oracleWithdrawn(off).events.map(e => e.type)).toEqual(['plan', 'plan', 'withdraw']);
    const rumour = slot('s5_withdrawn', [['plan', 'M', -300, -300], ['withdraw', 'M', -100, null, { rumour: true }]]);
    expect(oracleWithdrawn(rumour).values).toEqual([]);
    expect(oracleWithdrawn(slot('s5_withdrawn', [['plan', 'M', -300, -300]])).values).toEqual(['M']);
  });

  test('s6 and s7 before anything was said or true answer nothing', () => {
    const s = slot('s1_updated', [['state', 'A', -400, -400]]);
    expect(oracleAsOf(s, -500).values).toEqual([]);
    expect(oracleAsKnown(s, -500).values).toEqual([]);
  });
});

describe('the committed dev plans', () => {
  test('three worlds of 140 to 160 sessions over about 18 months ending on day 0, ending on a Sunday', () => {
    for (const plan of Object.values(plans)) {
      expect(plan.sessions.length).toBeGreaterThanOrEqual(BG1_SESSIONS.min);
      expect(plan.sessions.length).toBeLessThanOrEqual(BG1_SESSIONS.max);
      expect(plan.sessions.at(-1)!.day).toBeLessThanOrEqual(0);
      expect(plan.sessions.at(-1)!.day - plan.sessions[0].day).toBeGreaterThan(530);
      expect(plan.world_end_weekday).toBe('Sunday');
      expect(plan.custody).toBeUndefined();
      expect(plan.seed).toBe(BG1_DEV_SEEDS[plan.id]);
      expect(() => checkPlan(plan)).not.toThrow();
    }
    expect(BG1_WORLD_END_WEEKDAY).toBe('Sunday');
    expect(weekdayOf(0)).toBe('Sunday');
    expect(weekdayOf(-1)).toBe('Saturday');
  });

  test('30 tracked slots, six per primary stratum, and near-name decoys that shadow them', () => {
    for (const plan of Object.values(plans)) {
      for (const st of BG1_PRIMARY) expect(plan.slots.filter(s => s.stratum === st)).toHaveLength(BG1_SLOTS_PER_STRATUM);
      const decoys = plan.slots.filter(s => s.stratum === 'decoy');
      expect(decoys.length).toBeGreaterThan(0);
      for (const d of decoys) {
        const twin = plan.slots.find(s => s.id === d.twin_slot)!;
        expect(twin.kind).toBe(d.kind);
        const a = plan.entities.find(e => e.id === twin.entity)!.name, b = plan.entities.find(e => e.id === d.entity)!.name;
        expect(a).not.toBe(b);
        expect(a.slice(0, 3)).toBe(b.slice(0, 3));
      }
    }
  });

  test('values are unique, and every line holds its own values and no other value\'s term', () => {
    for (const plan of Object.values(plans)) {
      const values = Object.keys(plan.lexicon);
      expect(new Set(values).size).toBe(values.length);
      const all = plan.slots.flatMap(s => s.events.map(e => e.value));
      for (const v of all) expect(values).toContain(v);
      for (const s of plan.sessions) for (const l of s.lines) for (const v of l.values) expect(l.text).toContain(v);
    }
  });

  test('s1 carries scheduled changes past the run, and their gold is still the old value', () => {
    let scheduled = 0;
    for (const plan of Object.values(plans)) for (const s of plan.slots.filter(x => x.stratum === 's1_updated')) {
      const future = s.events.filter(e => e.type === 'scheduled');
      for (const e of future) {
        scheduled++;
        expect(e.valid_from!).toBeGreaterThanOrEqual(BG1_FUTURE_DAYS.min);
        expect(oracleUpdated(s).values).not.toContain(e.value);
        const q = questions[plan.id].find(x => x.bg1.slot === s.id && x.bg1.stratum === 's1_updated')!;
        expect(q.bg1.stale_values).toContain(e.value);
        expect(q.evidence_sessions).toContain(e.session);
      }
    }
    expect(scheduled).toBeGreaterThanOrEqual(BG1_DEV_CONVERSATIONS.length);
  });

  test('s4\'s governing line sits mid-way through a long session of its own, and most other sources come later', () => {
    for (const plan of Object.values(plans)) for (const s of plan.slots.filter(x => x.stratum === 's4_conflicting')) {
      const g = oracleConflicting(s).events[0];
      expect(['executed', 'owner_confirmed']).toContain(g.source!);
      const session = plan.sessions.find(x => x.id === g.session)!;
      expect(session.long).toBe(true);
      expect(session.lines).toHaveLength(1);
      expect(session.lines[0].position).toBe('middle');
      const others = s.events.filter(e => e !== g);
      expect(others.length).toBeGreaterThanOrEqual(2);
      expect(others.filter(e => e.said > g.said).length).toBeGreaterThanOrEqual(others.length - 1);
    }
  });
});

describe('the committed dev questions', () => {
  test('64 per world, eight per stratum, four exact and four paraphrase', () => {
    for (const qs of Object.values(questions)) {
      expect(qs).toHaveLength(BG1_STRATA.length * BG1_QUESTIONS_PER_STRATUM);
      for (const st of BG1_STRATA) {
        const mine = qs.filter(q => q.bg1.stratum === st);
        expect(mine).toHaveLength(BG1_QUESTIONS_PER_STRATUM);
        expect(mine.filter(q => q.bg1.form === 'exact')).toHaveLength(4);
        expect(new Set(mine.map(q => q.id)).size).toBe(8);
      }
      expect(new Set(qs.map(q => q.id)).size).toBe(qs.length);
    }
  });

  test('every question\'s gold follows from its stratum\'s oracle over the plan', () => {
    for (const id of BG1_DEV_CONVERSATIONS) for (const q of questions[id]) {
      const plan = plans[id];
      const g = goldFields(plan, q);
      expect([q.bg1.gold_values, q.bg1.stale_values, q.bg1.decoy_values, q.evidence_sessions]).toEqual([g.gold_values, g.stale_values, g.decoy_values, g.evidence_sessions]);
      const gold = deriveGold(plan, q).values;
      if (q.bg1.stratum === 's5_withdrawn') expect(gold).toEqual([]);
      else if (q.bg1.stratum === 's8_history') { expect(q.bg1.ordered).toBe(true); expect(q.answer).toBe(gold.join(', then ')); expect(gold.length).toBeGreaterThanOrEqual(2); }
      else { expect(gold).toHaveLength(1); expect(q.answer).toBe(gold[0]); }
      for (const v of q.bg1.stale_values) expect(gold).not.toContain(v);
      if (q.bg1.stratum === 's6_as_of' || q.bg1.stratum === 's7_as_known') expect(queryDayOf(q.question)!).toBeLessThan(0);
      if (q.bg1.stratum === 's4_conflicting') expect(plan.sessions.some(s => s.lines.some(l => l.text === q.bg1.deciding_line))).toBe(true);
    }
  });

  test('every s7 question asks a date on which what the user had been told differs from what was true', () => {
    for (const id of BG1_DEV_CONVERSATIONS) {
      const plan = plans[id];
      const known = questions[id].filter(q => q.bg1.stratum === 's7_as_known');
      const differs = known.filter(q => { const s = plan.slots.find(x => x.id === q.bg1.slot)!; return oracleAsOf(s, queryDayOf(q.question)!).values[0] !== deriveGold(plan, q).values[0]; });
      expect(differs).toHaveLength(known.length);
    }
  });

  test('the builder refuses a plan whose oracle disagrees with what the planner meant', () => {
    const plan = structuredClone(plans['bg1-dev-01']);
    const s = plan.slots.find(x => x.stratum === 's2_corrected')!;
    s.intent.now = s.events[0].value === s.intent.now ? s.events.at(-1)!.value : s.events[0].value;
    expect(() => buildQuestions(plan)).toThrow(PlanError);
    const late = structuredClone(plans['bg1-dev-01']);
    late.slots.find(x => x.stratum === 's1_updated')!.intent.history.reverse();
    expect(() => buildQuestions(late)).toThrow(PlanError);
  });
});

describe('determinism, seeds and phrasing', () => {
  test('the committed files match a fresh generation (changing-facts-gen.ts check)', () => {
    for (const [rel, text] of devFiles()) expect(readFileSync(join(BG1_DATA_DIR, rel), 'utf8')).toBe(text);
    const r = spawnSync('bun', ['eval/generators/changing-facts-gen.ts', 'check'], { cwd: REPO, encoding: 'utf8', timeout: 120_000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('differ=0');
  }, 120_000);

  test('a sealed plan carries the custody marker and never its seed, and slots get different seeds', () => {
    const line = ['bg1', 'seed', 'v1'].join('-') + ':' + 'a'.repeat(64);
    expect(sealedWorldSeed(line, 1)).not.toBe(sealedWorldSeed(line, 2));
    expect(sealedWorldSeed(line, 1)).toMatch(/^[0-9a-f]{64}$/);
    const phrasing = { ...PUBLIC_PHRASING, custody: BG1_CUSTODY_MARKER };
    const plan = planWorld('bg1-001', sealedWorldSeed(line, 1), { phrasing, custody: true });
    expect(plan.custody).toBe(BG1_CUSTODY_MARKER);
    expect(plan.seed).toBeUndefined();
    expect(JSON.stringify(plan)).not.toContain(sealedWorldSeed(line, 1));
    expect(buildQuestions(plan, phrasing).every(q => q.custody === BG1_CUSTODY_MARKER)).toBe(true);
    expect(JSON.stringify(planWorld('bg1-001', sealedWorldSeed(line, 1), { phrasing, custody: true }))).toBe(JSON.stringify(plan));
  });

  test('a custody phrasing set needs the marker, every key and the right placeholders', () => {
    expect(() => checkPhrasing(PUBLIC_PHRASING, true)).toThrow('custody marker');
    expect(() => checkPhrasing({ ...PUBLIC_PHRASING, custody: BG1_CUSTODY_MARKER }, true)).not.toThrow();
    const wrong = structuredClone({ ...PUBLIC_PHRASING, custody: BG1_CUSTODY_MARKER }) as any;
    wrong.frames.correct = ['Correction: it is {is}.'];
    expect(() => checkPhrasing(wrong, true)).toThrow('wrong placeholders');
    const missing = structuredClone({ ...PUBLIC_PHRASING, custody: BG1_CUSTODY_MARKER }) as any;
    delete missing.kinds.city.q.asof;
    expect(() => checkPhrasing(missing, true)).toThrow('asof');
  });

  test('render briefs forbid every value, alias and implication and flag the sessions with tracked lines', () => {
    const plan = plans['bg1-dev-02'];
    const briefs = renderBriefs(plan);
    for (const [v, lex] of Object.entries(plan.lexicon)) for (const t of termsOf(v, lex)) expect(briefs[0].forbidden).toContain(t);
    expect(briefs.filter(b => b.tracked).length).toBeGreaterThan(plan.sessions.length / 2);
    expect(briefs.every((b, i) => b.lines.length === plan.sessions[i].lines.length && b.allowed_tokens.includes(`[[D:${b.day}]]`))).toBe(true);
    expect(Math.abs(briefs.reduce((n, b) => n + b.target_tokens, 0) - 200_000)).toBeLessThan(200);
  });
});

describe('the template fixtures', () => {
  test('hold the dev plans\' sessions, rendered from templates near BG1_FIXTURE_TOKENS, with the dev questions beside them', () => {
    for (const id of BG1_DEV_CONVERSATIONS) {
      const world = read<World>(`fixtures/worlds/${id}/world.json`);
      const plan = plans[id];
      expect(world.renderer).toBe('template');
      expect(world.sessions.map(s => [s.id, s.day, s.time])).toEqual(plan.sessions.map(s => [s.id, s.day, s.time]));
      expect(Math.abs(worldTokens(world) - BG1_FIXTURE_TOKENS)).toBeLessThan(0.25 * BG1_FIXTURE_TOKENS);
      expect(readFileSync(join(BG1_DATA_DIR, `fixtures/worlds/${id}/questions.json`), 'utf8')).toBe(readFileSync(join(BG1_DATA_DIR, `dev/worlds/${id}/questions.json`), 'utf8'));
    }
  });
});
