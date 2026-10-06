/**
 * Cat 40 Hard (plan docs/plans/2026-10-05-cat40-hard/PLAN.md): the world
 * contract and knobs, the time/correction/user-statement/name semantics on
 * hand-specified fixtures, the generator (determinism, paired rounds,
 * invariants, H5 counterfactuals, the 50k key-equality check on the ledger),
 * the Hard scorer and its mutation suite, the runner's refusals, identity,
 * turn cap, sessions, retries and stop codes, the operator script, and the
 * v1 regression contract. Everything here is hermetic ($0).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  DEFAULT_HARD_KNOBS, HARD_KNOB_KEYS, HARD_FAMILIES, KNOB_PRIORITY, validateKnobs, knobDigest, RECORDED, type HardKnobs, type HardTask, type HardWorld,
} from '../../eval/generators/hard/schema.ts';
import { eventAsOf, valueAsOf, correctionOf, statedValue, nameRegistry, evaluatePredicate, type ValueEvent, type PredicateFacts } from '../../eval/generators/hard/semantics.ts';
import { hardWorldProblems } from '../../eval/generators/hard/validate.ts';
import { generateHardWorld, buildHardLedger, hardWorldDigest, h5Resolve, aliasesOf, onEdge, loadKnobs, HARD_SIZE } from '../../eval/generators/model-ladder-hard.ts';
import { generateLadderWorld, worldDigest } from '../../eval/generators/model-ladder-gen.ts';
import { scoreHardTask, parseCount, parseSet, coerceAnswer } from '../../eval/runner/cat40/score-hard.ts';
import { hardJudgePrompt, parseHardClaims, judgeHardClaims, HARD_JUDGE_PROMPT_VERSION } from '../../eval/runner/cat40/judge-hard.ts';
import {
  HardStop, HARD_STOP_CODES, hardRefusals, hardSystemPrompt, hardSessions, oracleOversize, runWithRetries, writeDiagnostic, identityRefusal, identityOf, scriptedHardAgent, HARD_RULES,
} from '../../eval/runner/cat40/hard.ts';
import { project, stepPlan, loadCostBasis, checkRoster, budgetCheck, STEPS } from '../../eval/runner/cat40/hard-ops.ts';
import { runAgent, ProviderError, HarnessError, type Arm, type AgentRun } from '../../eval/runner/cat40/loop.ts';
import { OracleArm, FsArm, FileStore } from '../../eval/runner/cat40/arms.ts';
import { main, checkRunnerFlags, experimentFlags, bindExperiment } from '../../eval/runner/cat40-model-ladder.ts';
import { assertScorerRejectsFakeSystems } from '../../eval/runner/mutation-kit.ts';
import { canonicalCells, readRecords, type CellRecordV2 } from '../../eval/runner/cat40/records.ts';
import { closeLedgers, initLedger } from '../../eval/runner/budget-ledger.ts';

const ROOT = resolve(import.meta.dir, '../..');
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'cat40-hard-')); dirs.push(d); return d; };
afterEach(() => { closeLedgers(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const sh = (cmd: string, args: string[], env: Record<string, string> = {}) => {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
};

const CAL = 20261005, SMOKE = 20261099;
const world = generateHardWorld(CAL);
const byFamily = (f: string) => world.tasks.filter(t => t.family === f);
const writeWorld = (w: HardWorld) => { const d = tmp(); const p = join(d, 'world.json'); writeFileSync(p, JSON.stringify(w)); return p; };

describe('world contract and knobs (DX-F2, DX-F14)', () => {
  test('a knob file with unknown or missing keys is refused with the list of valid keys', () => {
    expect(() => validateKnobs({ ...DEFAULT_HARD_KNOBS, extra: 1 })).toThrow(/unknown keys: extra.*Valid keys: accounts/);
    const { accounts: _, ...missing } = DEFAULT_HARD_KNOBS;
    expect(() => validateKnobs(missing)).toThrow('missing keys: accounts');
    expect(() => validateKnobs({ ...DEFAULT_HARD_KNOBS, h1_min_members: 'ten' })).toThrow('h1_min_members must be a number');
    expect(() => validateKnobs({ ...DEFAULT_HARD_KNOBS, h2_correction_rate: 2 })).toThrow('fraction');
    expect(validateKnobs(JSON.parse(readFileSync(join(ROOT, 'docs/benchmarks/cat40-hard/knobs.default.json'), 'utf8')))).toEqual(DEFAULT_HARD_KNOBS);
    for (const r of [1, 2]) {
      const k = loadKnobs(join(ROOT, `docs/benchmarks/cat40-hard/knobs.round-${r}.json`));
      expect(k.max_turns).toBe(16);
      const w = generateHardWorld(CAL, k);
      expect(hardWorldProblems(w)).toEqual([]);
    }
  });
  test('the knob digest is order-independent and changes with any value; the world records knobs, schema version and turn cap', () => {
    const shuffled = Object.fromEntries(Object.entries(DEFAULT_HARD_KNOBS).reverse()) as unknown as HardKnobs;
    expect(knobDigest(shuffled)).toBe(knobDigest(DEFAULT_HARD_KNOBS));
    expect(knobDigest({ ...DEFAULT_HARD_KNOBS, max_turns: 8 })).not.toBe(knobDigest(DEFAULT_HARD_KNOBS));
    expect(world).toMatchObject({ version: 'model-ladder-hard-v1', mode: 'hard', knob_schema: 1, knob_digest: knobDigest(DEFAULT_HARD_KNOBS), max_turns: 16 });
    expect(DEFAULT_HARD_KNOBS.max_turns).toBe(16);
    expect(KNOB_PRIORITY.at(-1)!.keys).toEqual(['max_turns']);
    expect(new Set(KNOB_PRIORITY.flatMap(g => g.keys)).size).toBeLessThanOrEqual(HARD_KNOB_KEYS.length);
  });
});

describe('semantics on hand-specified fixtures (ENG-F4)', () => {
  const ev = (value: string, effective: string, recorded: string, kind: ValueEvent['kind'] = 'change'): ValueEvent => ({ value, effective, recorded, doc: `d-${value}`, kind });
  const owner = [ev('Ana', '2025-01-01', '2025-01-01', 'initial'), ev('Ben', '2026-05-01', '2026-05-20'), ev('Cy', '2026-10-01', '2026-09-01')];
  test('"as of D" uses documents written after D (valid time with hindsight); a future effective date does not apply yet', () => {
    expect(valueAsOf(owner, '2026-05-10')).toBe('Ben');
    expect(valueAsOf(owner, '2026-04-30')).toBe('Ana');
    expect(valueAsOf(owner, '2026-09-15')).toBe('Ben');
    expect(valueAsOf(owner, '2024-06-01')).toBeNull();
  });
  test('a correction replaces the corrected value from its effective date; same-date changes resolve to the later recorded one', () => {
    const fix = correctionOf(owner[1], 'Dee', '2026-06-02', 'd-fix');
    expect(fix.effective).toBe('2026-05-01');
    expect(valueAsOf([...owner, fix], '2026-05-10')).toBe('Dee');
    expect(eventAsOf([ev('X', '2026-03-01', '2026-03-05'), ev('Y', '2026-03-01', '2026-03-02')], '2026-04-01')!.value).toBe('X');
    expect(() => correctionOf(owner[1], 'Dee', '2026-05-01', 'd')).toThrow('recorded after');
  });
  test('user statements outrank documents and a later statement outranks an earlier one', () => {
    const s = [{ session: 1, key: 'k', value: 'A' }, { session: 3, key: 'k', value: 'B' }, { session: 2, key: 'j', value: 'C' }];
    expect(statedValue(s, 'k', 'DOC')).toBe('B');
    expect(statedValue(s, 'z', 'DOC')).toBe('DOC');
  });
  test('names resolve injectively: a name claimed by two entities is refused', () => {
    expect(nameRegistry([{ id: 'a', name: 'Quorvane Systems', aliases: ['QUSE', 'Old Name Labs'] }]).get('old name labs')).toBe('a');
    expect(() => nameRegistry([{ id: 'a', name: 'X Labs', aliases: ['XL'] }, { id: 'b', name: 'Y Labs', aliases: ['xl'] }])).toThrow('refers to both');
  });
  test('the H1 evaluator: members hold every clause, near misses at least one', () => {
    const f = (id: string, o: Partial<PredicateFacts>): PredicateFacts => ({ id, segment: 'growth', region: 'EMEA', owner, renewal: [ev('2026-10-20', '2025-01-01', '2025-01-01', 'initial')], tickets: [], ...o });
    const facts = [f('a', { tickets: [{ opened: '2026-08-01', escalated: '2026-08-03' }] }), f('b', { tickets: [{ opened: '2026-08-01', escalated: '2026-08-03', closed: '2026-09-01' }] }), f('c', { segment: 'enterprise' })];
    const r = evaluatePredicate({ as_of: '2026-09-15', clauses: [{ kind: 'open_escalated_ticket' }, { kind: 'renewal_within', days: 60 }] }, facts);
    expect(r).toEqual({ members: ['a'], nearMisses: ['b', 'c'] });
  });
});

describe('generator (T1, CEO-F1, CEO-F12, CEO-F29, ENG-F14, ENG-F15, ENG-F17)', () => {
  test('same seed and knobs give the same world; tasks per family is the knob; the 4k world is about 4,000 documents', () => {
    expect(hardWorldDigest(generateHardWorld(CAL))).toBe(hardWorldDigest(world));
    expect(hardWorldDigest(generateHardWorld(SMOKE))).not.toBe(hardWorldDigest(world));
    for (const f of HARD_FAMILIES) expect(byFamily(f).length).toBe(20);
    expect(world.docs.length).toBeGreaterThanOrEqual(HARD_SIZE.v1[0]);
    expect(world.docs.length).toBeLessThanOrEqual(HARD_SIZE.v1[1]);
    expect(generateHardWorld(CAL, { ...DEFAULT_HARD_KNOBS, tasks_per_family: 3 }, { skipSizeCheck: true }).tasks.length).toBe(15);
  });
  test('every invariant holds on the calibration and smoke seeds: references, answer kinds, H5 chains, injective names, accepted/wrong never substrings', () => {
    for (const w of [world, generateHardWorld(SMOKE)]) expect(hardWorldProblems(w)).toEqual([]);
    for (const t of byFamily('H5')) { expect(t.sessions!.length).toBe(4); expect(t.gold.wrong!.length).toBeGreaterThan(0); }
    for (const t of byFamily('H1')) expect(['set', 'count']).toContain(t.answer_kind);
    for (const f of ['H2', 'H3', 'H4']) for (const t of byFamily(f)) expect(t.gold.wrong!.length).toBeGreaterThan(0);
  });
  test('every H1 key is the single evaluator over the ledger, 10 to 40 members', () => {
    const b = buildHardLedger(CAL, DEFAULT_HARD_KNOBS);
    for (const t of byFamily('H1')) {
      const { members } = evaluatePredicate(t.predicate!, b.facts());
      expect(members.length).toBeGreaterThanOrEqual(10);
      expect(members.length).toBeLessThanOrEqual(40);
      if (t.answer_kind === 'count') expect(t.gold.count).toBe(members.length);
      else expect(t.gold.members!.map(m => m.id).sort()).toEqual([...members].sort());
    }
  });
  test('set members carry every accepted name: canonical, code, former names and merged names', () => {
    const b = buildHardLedger(CAL, DEFAULT_HARD_KNOBS);
    const renamed = b.accounts.find(a => a.former)!, merged = b.accounts.find(a => a.mergedIn.length)!;
    expect(aliasesOf(renamed)).toContain(renamed.former!.name);
    expect(aliasesOf(merged)).toContain(merged.mergedIn[0].name);
    expect(world.entities.find(e => e.id === merged.id)!.aliases).toContain(merged.mergedIn[0].code);
    expect(world.entities.some(e => e.name === merged.mergedIn[0].name)).toBe(false);
  });
  test('round-1 defect (H1-05, H1-10): a renamed account\'s records after the rename use the new name, earlier ones the old, and H1 evidence carries the rename notice', () => {
    const b = buildHardLedger(CAL, DEFAULT_HARD_KNOBS);
    const byId = new Map(world.docs.map(d => [d.id, d]));
    for (const a of b.accounts.filter(x => x.former)) {
      for (const id of a.docIds) {
        const d = byId.get(id);
        if (!d) continue;
        const text = d.title + d.body;
        if (d.date >= a.former!.date) { expect(text).not.toContain(a.former!.name); expect(text).not.toMatch(new RegExp(`\\b${a.former!.code}\\b`)); }
        else expect(text).not.toContain(a.name);
      }
    }
    // Fixture: a ticket opened after the rename names the account by its new name (the round-1 H1-05/H1-10 miss named the old one).
    const renamed = b.accounts.find(a => a.former && a.tickets.some(t => t.opened >= a.former!.date));
    if (renamed) { const t = renamed.tickets.find(x => x.opened >= renamed.former!.date)!; expect(byId.get(t.doc)!.body).toContain(`Customer: ${renamed.name}`); }
    // Every H1 member's deciding records name it in a way the oracle evidence can resolve: canonical name or code, or an
    // alias whose rename or merger notice is in the evidence too.
    for (const w of [world, generateHardWorld(SMOKE)]) {
      const bw = w === world ? b : buildHardLedger(SMOKE, DEFAULT_HARD_KNOBS);
      const docs = new Map(w.docs.map(d => [d.id, d]));
      for (const t of w.tasks.filter(x => x.family === 'H1')) {
        const memberIds = t.gold.members?.map(m => m.id) ?? evaluatePredicate(t.predicate!, bw.facts()).members;
        for (const id of memberIds) {
          const a = bw.accounts.find(x => x.id === id)!;
          const links = [a.former?.doc, ...a.mergedIn.map(m => m.doc)].filter(Boolean) as string[];
          for (const l of links) expect(t.relevant).toContain(l);
          const kinds = t.predicate!.clauses.map(c => c.kind);
          for (const doc of [...(kinds.includes('open_escalated_ticket') ? a.tickets.map(x => x.doc) : []), ...(kinds.includes('renewal_within') ? a.renewal.map(e => e.doc) : []), ...(kinds.includes('owner') ? a.owner.map(e => e.doc) : [])]) {
            expect(t.relevant).toContain(doc);
            const body = docs.get(doc)!.body;
            expect([a.name, a.code, ...aliasesOf(a)].some(n => body.includes(n))).toBe(true);
          }
        }
      }
    }
  });
  test('a merged account\'s tickets count for the account it merged into (its names map to one entity), and its contract carries that account\'s renewal date', () => {
    const b = buildHardLedger(CAL, DEFAULT_HARD_KNOBS);
    for (const holder of b.accounts.filter(a => a.mergedIn.length)) {
      const merged = b.accounts.find(a => a.mergedInto === holder.id)!;
      for (const t of merged.tickets) expect(holder.tickets).toContain(t);
      expect(merged.renewal).toEqual([{ ...merged.renewal[0], value: holder.renewal[0].value }]);
      expect(b.facts().some(f => f.id === merged.id)).toBe(false);
    }
  });
  test('no H1 member turns on a boundary: no owner change or ticket event on the as-of date, no renewal on a window edge, for an account holding the other clauses', () => {
    for (const seed of [CAL, SMOKE]) {
      const b = buildHardLedger(seed, DEFAULT_HARD_KNOBS);
      for (const t of b.tasks.filter(x => x.family === 'H1')) expect(onEdge(t.predicate!, b.facts())).toBe(false);
    }
    const ev = (value: string, effective: string): ValueEvent => ({ value, effective, recorded: effective, doc: 'd', kind: 'change' });
    const f: PredicateFacts = { id: 'a', segment: 'growth', region: 'EMEA', owner: [ev('Ana', '2025-01-01')], renewal: [ev('2026-11-14', '2025-01-01')], tickets: [{ opened: '2026-08-01', escalated: '2026-08-02' }] };
    expect(onEdge({ as_of: '2026-09-15', clauses: [{ kind: 'open_escalated_ticket' }, { kind: 'renewal_within', days: 60 }] }, [f])).toBe(true);
    expect(onEdge({ as_of: '2026-09-15', clauses: [{ kind: 'open_escalated_ticket' }, { kind: 'renewal_within', days: 90 }] }, [f])).toBe(false);
  });
  test('H5: removing each required earlier statement changes or voids the answer; each final answer depends on two sessions and one superseded fact', () => {
    for (const t of byFamily('H5')) {
      const facts = t.session_facts!;
      const required = facts.filter(f => f.required);
      expect(required.length).toBeGreaterThanOrEqual(2);
      expect(facts.some(f => f.superseded_by !== undefined)).toBe(true);
      const ctx = { x: t.accounts[0], y: t.accounts[1] ?? null, billing: t.variant === 'routing' ? t.gold.wrong![1] : undefined, dx0: t.gold.wrong![1], dy0: t.gold.wrong![2] };
      const all = facts.map(f => ({ session: f.session, key: f.key, value: f.value }));
      expect(h5Resolve(t.variant, all, ctx)).toBe(t.gold.answer![0]);
      for (const r of required) expect(h5Resolve(t.variant, all.filter(s => s.session !== r.session), ctx)).not.toBe(t.gold.answer![0]);
    }
  });
  test('paired rounds: a family knob changes only that family\'s tasks (and the accounts knob only H1)', () => {
    const strip = (w: HardWorld, fams: string[]) => JSON.stringify(w.tasks.filter(t => fams.includes(t.family)).map(t => [t.question, t.gold.answer ?? t.gold.count ?? t.gold.members?.map(m => m.names[0]), t.gold.wrong]));
    const h2 = generateHardWorld(CAL, { ...DEFAULT_HARD_KNOBS, h2_changes_max: 5, h2_intermediate_notes: 0 });
    expect(strip(h2, ['H1', 'H3', 'H4', 'H5'])).toBe(strip(world, ['H1', 'H3', 'H4', 'H5']));
    const h4 = generateHardWorld(CAL, { ...DEFAULT_HARD_KNOBS, h4_sources_max: 4 });
    expect(strip(h4, ['H1', 'H2', 'H3', 'H5'])).toBe(strip(world, ['H1', 'H2', 'H3', 'H5']));
    const acc = generateHardWorld(CAL, { ...DEFAULT_HARD_KNOBS, accounts: 100 }, { skipSizeCheck: true });
    expect(strip(acc, ['H2', 'H3', 'H4', 'H5'])).toBe(strip(world, ['H2', 'H3', 'H4', 'H5']));
  });
  test('50k: on the ledger alone, every H1 key over all appended accounts equals the 4k key and every H3 disambiguation stays unique (calibration and smoke seeds)', () => {
    for (const seed of [CAL, SMOKE]) {
      const small = buildHardLedger(seed, DEFAULT_HARD_KNOBS), large = buildHardLedger(seed, DEFAULT_HARD_KNOBS, { scale: 'large' });
      expect(large.appended.length).toBe(DEFAULT_HARD_KNOBS.large_extra_accounts);
      const h1 = small.tasks.filter(t => t.family === 'H1');
      for (const t of h1) expect(evaluatePredicate(t.predicate!, large.facts()).members.sort()).toEqual(evaluatePredicate(t.predicate!, small.facts()).members.sort());
      const names = new Set(small.accounts.flatMap(a => [a.name, ...aliasesOf(a)]).map(n => n.toLowerCase()));
      for (const a of large.appended) for (const n of [a.name, a.code]) expect(names.has(n.toLowerCase())).toBe(false);
      expect(large.docs.length).toBeGreaterThan(HARD_SIZE.large[0]);
      expect(large.docs.length).toBeLessThan(HARD_SIZE.large[1]);
      expect(JSON.stringify(large.tasks.filter(t => t.family !== 'H1'))).toBe(JSON.stringify(small.tasks.filter(t => t.family !== 'H1')));
    }
  });
  test('50k: the 4k documents are byte-identical inside the 50k ledger, and the H3 oracle evidence keeps the 4k set', () => {
    const large = buildHardLedger(CAL, DEFAULT_HARD_KNOBS, { scale: 'large' });
    const byId = new Map(large.docs.map(d => [d.id, d]));
    for (const d of world.docs.filter((_, i) => i % 7 === 0)) {
      const l = byId.get(d.id)!;
      expect(typeof l.body === 'function' ? l.body() : l.body).toBe(d.body);
    }
    for (const t of byFamily('H3')) expect(large.tasks.find(x => x.id === t.id)!.relevant).toEqual(t.relevant);
  });
  test('the generator CLI refuses unknown flags, bad seeds and a 50k world whose base differs', () => {
    expect(sh('bun', ['eval/generators/model-ladder-gen.ts', '--mode', 'hard', '--bogus', '1']).code).toBe(2);
    expect(sh('bun', ['eval/generators/model-ladder-gen.ts', '--mode', 'hard', '--seed', 'abc']).code).toBe(2);
    const d = tmp();
    writeFileSync(join(d, 'base.json'), JSON.stringify({ ...world, seed: 1 }));
    const r = sh('bun', ['eval/generators/model-ladder-gen.ts', '--mode', 'hard', '--scale', 'large', '--base-world', join(d, 'base.json'), '--out', d]);
    expect(r.code).toBe(2);
    expect(r.out).toContain('differs in seed');
    expect(sh('bun', ['eval/generators/model-ladder-gen.ts', '--mode', 'hard', '--help']).out).toContain('--knobs <file.json>');
  });
});

describe('Hard scorer (T3, T5: CEO-F14, ENG-F5, ENG-F19)', () => {
  const setTask = byFamily('H1').find(t => t.answer_kind === 'set')!;
  const countTask = byFamily('H1').find(t => t.answer_kind === 'count')!;
  const fin = (answer: unknown): AgentRun => ({ final: { answer: answer as string, sources: [] }, stop: 'submitted' } as unknown as AgentRun);
  const names = setTask.gold.members!.map(m => m.names[0]);
  test('set answers: JSON string or native array, aliases count, duplicates count once, substrings never match, prose is unparseable', () => {
    expect(scoreHardTask(world, setTask, [fin(JSON.stringify(names))]).success).toBe(true);
    expect(scoreHardTask(world, setTask, [fin(names)]).success).toBe(true);
    const viaAlias = [...names.slice(1), setTask.gold.members![0].names[1], names[0]];
    expect(scoreHardTask(world, setTask, [fin(JSON.stringify(viaAlias))]).success).toBe(true);
    expect(scoreHardTask(world, setTask, [fin(`Here they are: ${JSON.stringify(names)}`)]).success).toBe(true);
    expect(scoreHardTask(world, setTask, [fin(JSON.stringify(names.map(n => n.split(' ')[0])))]).success).toBe(false);
    const prose = scoreHardTask(world, setTask, [fin(names.join(', '))]);
    expect(prose).toMatchObject({ success: false, unparseable_set: true });
    const partial = scoreHardTask(world, setTask, [fin(JSON.stringify(names.slice(1)))]);
    expect(partial.success).toBe(false);
    expect(partial.set!.recall).toBeCloseTo((names.length - 1) / names.length);
  });
  test('count answers: the leading integer only', () => {
    const n = countTask.gold.count!;
    expect(parseCount(`${n} accounts`)).toBe(n);
    expect(scoreHardTask(world, countTask, [fin(String(n))]).success).toBe(true);
    expect(scoreHardTask(world, countTask, [fin(`As of 2026-07-01, ${n}`)])).toMatchObject({ success: false, unparseable_set: true });
    expect(scoreHardTask(world, countTask, [fin(String(n + 1))]).success).toBe(false);
    expect(parseCount('2026-07-01: 12')).toBeNull();
  });
  test('value answers: coercion, wrong values anywhere fail, H5 records RECORDED per session', () => {
    expect(coerceAnswer(null)).toBe('');
    expect(coerceAnswer(['a'])).toBe('["a"]');
    expect(coerceAnswer(12)).toBe('12');
    const t = byFamily('H4')[0];
    expect(scoreHardTask(world, t, [fin(t.gold.answer![0])]).success).toBe(true);
    expect(scoreHardTask(world, t, [fin(`${t.gold.answer![0]} (or ${t.gold.wrong![0]})`)]).success).toBe(false);
    expect(scoreHardTask(world, t, [fin(null)]).success).toBe(false);
    const h5 = byFamily('H5')[0];
    const runs = [fin(RECORDED), fin('recorded.'), fin('done'), fin(RECORDED), fin(h5.gold.answer![0])];
    expect(scoreHardTask(world, h5, runs)).toMatchObject({ success: true, recorded: [true, true, false, true] });
    expect(parseSet('["a", 1]')).toBeNull();
  });
  test('mutation suite: the scorer rejects fake systems on H1 sets and counts', () => {
    const h1 = byFamily('H1');
    const others = world.entities.filter(e => !setTask.gold.members!.some(m => m.id === e.id));
    assertScorerRejectsFakeSystems<HardTask, string>({
      category: 'cat40-hard-h1', probes: h1,
      space: {
        truth: t => t.answer_kind === 'set' ? JSON.stringify(t.gold.members!.map(m => m.names[0])) : String(t.gold.count),
        empty: t => t.answer_kind === 'set' ? '[]' : '0',
        everything: t => t.answer_kind === 'set' ? JSON.stringify(world.entities.map(e => e.name)) : String(world.entities.length),
        refusal: () => 'UNKNOWN',
        stale: t => t.answer_kind === 'set' ? JSON.stringify([...t.gold.members!.slice(1).map(m => m.names[0]), others[0].name]) : String(t.gold.count! - 1),
        wrongSource: t => t.answer_kind === 'set' ? t.gold.members!.map(m => m.names[0]).join(', ') : `As of ${t.predicate!.as_of}, ${t.gold.count}`,
      },
      score: answers => { const ok = h1.filter((t, i) => scoreHardTask(world, t, [fin(answers[i])]).success).length; return { pass: ok === h1.length, detail: `${ok}/${h1.length}` }; },
    });
  });
  test('mutation suite: H2 to H5 reject a stale value, a look-alike\'s value, a hedge naming both and an array answer', () => {
    const tasks = world.tasks.filter(t => t.family !== 'H1');
    assertScorerRejectsFakeSystems<HardTask, unknown>({
      category: 'cat40-hard-values', probes: tasks,
      space: {
        truth: t => t.gold.answer![0], empty: () => null, everything: t => [t.gold.answer![0], ...t.gold.wrong!].join(' or '), refusal: () => 'UNKNOWN',
        stale: t => t.gold.wrong![0], wrongSource: t => `${t.gold.answer![0]} (or ${t.gold.wrong!.at(-1)})`,
      },
      score: answers => { const ok = tasks.filter((t, i) => scoreHardTask(world, t, [fin(answers[i])]).success).length; return { pass: ok === tasks.length, detail: `${ok}/${tasks.length}` }; },
    });
    for (const t of tasks) expect(scoreHardTask(world, t, [fin([t.gold.answer![0], t.gold.wrong![0]])]).success).toBe(false);
  });
});

describe('Hard judge (T3: ENG-F3)', () => {
  test('H5 prompts carry the chain\'s user messages as trusted evidence; H1 caps near misses; malformed output is a judge failure', async () => {
    const h5 = byFamily('H5')[0];
    const p = hardJudgePrompt(world, h5, { final: { answer: 'x', sources: [] } } as unknown as AgentRun)!;
    for (const s of h5.sessions!) expect(p.user).toContain(s);
    const h1 = byFamily('H1').find(t => (t.near_miss?.in_evidence ?? 0) > 0)!;
    expect(hardJudgePrompt(world, h1, { final: { answer: '[]', sources: [] } } as unknown as AgentRun)!.user).toContain('<near_miss_records');
    expect(parseHardClaims('{"claims":[{"claim":"a","verdict":"supported"}]}')!.total).toBe(1);
    expect(parseHardClaims('{"claims":[{"claim":"a","verdict":"maybe"}]}')).toBeNull();
    const logged: unknown[] = [];
    const r = await judgeHardClaims(world, h5, { final: { answer: 'x', sources: [] } } as unknown as AgentRun, 'gpt-6.1-sol', e => logged.push(e), async () => ({ text: 'not json', usd: 0.01 }));
    expect(r).toMatchObject({ claims: null, usd: 0.01 });
    expect(r.error).toContain('malformed');
    expect(logged).toHaveLength(1);
    expect(HARD_JUDGE_PROMPT_VERSION).toBe('cat40-hard-claims-v1');
  });
});

describe('runner (T1, T2, T6: CEO-F3, CEO-F12, DX-F3, DX-F7, ENG-F1, ENG-F2, ENG-F6, ENG-F20)', () => {
  test('refusals: no judge, judge none, gpt-5.4-mini anywhere, an unpriced model (naming the price table line), fs-acl; scripted runs are exempt from the judge rule', () => {
    const code = (f: () => void) => { try { f(); return null; } catch (e) { return e instanceof HardStop ? e : null; } };
    expect(code(() => hardRefusals({ models: ['claude-sonnet-5-5'], judge: undefined, arms: ['fs'], scripted: false }))!.fix).toContain('--judge gpt-6.1-sol');
    expect(code(() => hardRefusals({ models: ['claude-sonnet-5-5'], judge: 'none', arms: ['fs'], scripted: false }))!.code).toBe('HARD_JUDGE_REQUIRED');
    expect(code(() => hardRefusals({ models: ['gpt-5.4-mini'], judge: 'gpt-6.1-sol', arms: ['fs'], scripted: false }))!.code).toBe('HARD_MODEL_EXCLUDED');
    expect(code(() => hardRefusals({ models: ['claude-sonnet-5-5'], judge: 'gpt-5.4-mini', arms: ['fs'], scripted: false }))!.code).toBe('HARD_MODEL_EXCLUDED');
    const unpriced = code(() => hardRefusals({ models: ['claude-sonnet-9'], judge: 'gpt-6.1-sol', arms: ['fs'], scripted: false }))!;
    expect(unpriced.code).toBe('HARD_MODEL_UNPRICED');
    expect(unpriced.fix).toMatch(/eval\/runner\/budget-ledger\.ts:\d+/);
    expect(code(() => hardRefusals({ models: ['claude-sonnet-5-5'], judge: 'gpt-6.1-sol', arms: ['fs-acl'], scripted: false }))!.code).toBe('HARD_ARM_NOT_APPLICABLE');
    expect(code(() => hardRefusals({ models: [], judge: undefined, arms: ['fs'], scripted: true }))).toBeNull();
  });
  test('a Hard run without --judge exits 3 with its stable code before anything is paid', () => {
    const r = sh('bun', [join(ROOT, 'eval/runner/cat40-model-ladder.ts'), '--world', writeWorld(world), '--models', 'claude-sonnet-5-5', '--out', tmp()]);
    expect(r.code).toBe(3);
    expect(r.out).toContain('STOP HARD_JUDGE_REQUIRED');
    expect(r.out).toContain('--judge gpt-6.1-sol');
  });
  test('the smoke and held-out seeds refuse knobs other than knobs.frozen.json', async () => {
    const heldout = generateHardWorld(SMOKE);
    await expect(main(['--world', writeWorld(heldout), '--models', 'claude-sonnet-5-5', '--judge', 'gpt-6.1-sol', '--arms', 'fs', '--out', tmp(), '--preflight'])).rejects.toThrow('HARD_KNOBS_NOT_FROZEN');
  });
  test('strict flags: unknown flags, missing values, non-numbers and empty selections are refused; --help prints usage', () => {
    expect(() => checkRunnerFlags(['--bogus'])).toThrow('unknown flag --bogus');
    expect(() => checkRunnerFlags(['--repeat', 'two'])).toThrow('must be a number');
    expect(() => checkRunnerFlags(['--models'])).toThrow('needs a value');
    expect(() => checkRunnerFlags(['--arms', ','])).toThrow('is empty');
    expect(() => checkRunnerFlags(['--scripted', '--arms', 'fs', '--max-turns', '8', '--budget-usd=3'])).not.toThrow();
    expect(sh('bun', ['eval/runner/cat40-model-ladder.ts', '--help']).out).toContain('--hard-tool-limits');
  });
  test('identity: a resume on another world names the differing field; --max-turns changes the experiment identity', async () => {
    const out = tmp();
    await main(['--scripted', '--world', writeWorld(world), '--arms', 'oracle', '--families', 'H1', '--per-family', '1', '--out', out]);
    const other = generateHardWorld(CAL, { ...DEFAULT_HARD_KNOBS, h2_intermediate_notes: 1 });
    const err = await main(['--scripted', '--world', writeWorld(other), '--arms', 'oracle', '--families', 'H1', '--per-family', '1', '--out', out]).then(() => null, e => e as HardStop);
    expect(err!.code).toBe('HARD_WORLD_MISMATCH');
    expect(err!.what).toContain('with knobs');
    expect(err!.fix).toContain('repeat the original command');
    expect(() => identityRefusal({ ...identityOf(world), seed: 1 }, identityOf(world), 'x')).toThrow('with seed 1');
    expect(experimentFlags(['--max-turns', '8'])).toEqual({ '--max-turns': '8' });
    await expect(main(['--scripted', '--world', writeWorld(world), '--arms', 'oracle', '--families', 'H1', '--per-family', '1', '--max-turns', '8', '--out', out])).rejects.toThrow('already holds a different experiment');
  });
  test('scripted run: per-world turn cap, five-session H5 cells (one on the oracle), attempts and results as v2 records, scored sets', async () => {
    const out = tmp();
    const capped = { ...world, max_turns: 1, knobs: world.knobs };
    await main(['--scripted', '--world', writeWorld(world), '--arms', 'fs,memory,oracle', '--per-family', '2', '--out', out]);
    const recs = readFileSync(join(out, 'results.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as CellRecordV2);
    expect(recs.length).toBe(30);
    expect(readFileSync(join(out, 'attempts.jsonl'), 'utf8').split('\n').filter(Boolean).length).toBe(30);
    const h5fs = recs.find(r => r.family === 'H5' && r.arm === 'fs')!;
    expect(h5fs.sessions.map(s => s.role)).toEqual(['record', 'record', 'record', 'record', 'question']);
    expect(h5fs.score.recorded).toEqual([true, true, true, true]);
    expect((h5fs as unknown as { write_diagnostic: unknown[] }).write_diagnostic.length).toBe(4);
    expect(recs.find(r => r.family === 'H5' && r.arm === 'oracle')!.sessions.length).toBe(1);
    expect(recs.filter(r => r.arm === 'oracle').every(r => r.score.success)).toBe(true);
    expect(recs.find(r => r.family === 'H1' && r.arm === 'fs' && r.score.set)!.score.unparseable_set).toBe(false);
    expect(recs.every(r => r.experiment.max_turns === 16 && r.experiment.tool_limits === 'hard')).toBe(true);
    const ex = JSON.parse(readFileSync(join(out, 'experiment.json'), 'utf8'));
    expect(ex.hard.identity).toMatchObject({ seed: CAL, scale: 'v1', mode: 'hard', knob_digest: world.knob_digest });
    expect(Object.keys(ex.hard.code)).toContain('eval/runner/cat40/score-hard.ts');
    void capped;
  });
  test('Hard cells run families round-robin, so a step cut short by its budget still covers every family', async () => {
    const out = tmp();
    await main(['--scripted', '--world', writeWorld(world), '--arms', 'oracle', '--per-family', '2', '--out', out]);
    const order = readFileSync(join(out, 'results.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => (JSON.parse(l) as CellRecordV2).task);
    expect(order).toEqual(['H1-01', 'H2-01', 'H3-01', 'H4-01', 'H5-01', 'H1-02', 'H2-02', 'H3-02', 'H4-02', 'H5-02']);
  });
  test('the turn cap comes from --max-turns or the world: a 1-turn cap stops a two-step agent at turn_cap', async () => {
    const out = tmp();
    await main(['--scripted', '--world', writeWorld(world), '--arms', 'fs', '--families', 'H2', '--per-family', '1', '--max-turns', '1', '--out', out]);
    const r = JSON.parse(readFileSync(join(out, 'results.jsonl'), 'utf8').trim()) as CellRecordV2;
    expect(r.stop).toBe('turn_cap');
    expect(r.experiment.max_turns).toBe(1);
  });
  test('stop kinds: a context-length 400 is context_overflow, a 5xx after backoff or a HarnessError is harness_error, other 400s are error; v1 keeps error', async () => {
    const arm: Arm = { name: 'x', systemHint: () => '', tools: () => [], call: async () => '', writeTools: () => [] };
    const reply = (status: number, body: string) => (async () => new Response(body, { status })) as unknown as typeof fetch;
    const ctxLen = await runAgent({ model: 'gpt-6.1-sol', system: '', user: 'q', arm, classifyStops: true, fetchImpl: reply(400, '{"error":{"code":"context_length_exceeded"}}') });
    expect(ctxLen.stop).toBe('context_overflow');
    const bad = await runAgent({ model: 'gpt-6.1-sol', system: '', user: 'q', arm, classifyStops: true, fetchImpl: reply(400, '{"error":"invalid tool schema"}') });
    expect(bad.stop).toBe('error');
    const v1 = await runAgent({ model: 'gpt-6.1-sol', system: '', user: 'q', arm, fetchImpl: reply(400, '{"error":{"code":"context_length_exceeded"}}') });
    expect(v1.stop).toBe('error');
    expect(new ProviderError(503, 'x').status).toBe(503);
    const harness: Arm = { ...arm, tools: () => [{ name: 't', description: '', input_schema: { type: 'object', properties: {} } }], call: async () => { throw new HarnessError('mcp server exited'); } };
    const r = await runAgent({ model: 'scripted', system: '', user: 'q', arm: harness, classifyStops: true, scripted: () => ({ name: 't', args: {} }) });
    expect(r.stop).toBe('harness_error');
  });
  test('only harness_error retries, at most twice over a cell\'s life; other stops are final', async () => {
    const mk = (stop: string, attempt: number) => ({ stop, attempt, key: 'k', attempt_id: `k#${attempt}` }) as unknown as CellRecordV2;
    const seen: number[] = [];
    expect(await runWithRetries(0, async a => mk('harness_error', a), r => seen.push(r.attempt))).toBeNull();
    expect(seen).toEqual([1, 2, 3]);
    const seen2: number[] = [];
    expect((await runWithRetries(1, async a => mk(a === 2 ? 'harness_error' : 'context_overflow', a), r => seen2.push(r.attempt)))!.stop).toBe('context_overflow');
    expect(seen2).toEqual([2, 3]);
    expect((await runWithRetries(0, async a => mk('error', a), () => {}))!.attempt).toBe(1);
    const recs = [mk('harness_error', 1), { ...mk('submitted', 2), score: { success: true }, model: 'm', arm: 'fs', task: 'H1-01', family: 'H1', repeat: 0, total_usd: 1, judge_usd: 0, sessions: [], timings: { agent_ms: 1 }, wall_ms: 1, schema: 'cat40-cell-v2' }];
    for (const r of recs) Object.assign(r, { schema: 'cat40-cell-v2', score: (r as { score?: unknown }).score ?? { success: false }, model: 'm', arm: 'fs', task: 'H1-01', family: 'H1', repeat: 0, total_usd: 1, judge_usd: 0, sessions: [], timings: { agent_ms: 1 }, wall_ms: 1 });
    const c = canonicalCells(recs as unknown as Array<Record<string, unknown>>);
    expect(c.cells.map(x => x.attempt)).toEqual([2]);
    expect(c.cost_all_attempts_usd).toBe(2);
  });
  test('gbrain gets a new session between H5 sessions and a restore only after the chain', async () => {
    const calls: string[] = [];
    const client = { instructions: 'gbrain', tools: [{ name: 'search', description: 'd', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }], call: async () => 'ok' };
    const slot = { id: 'slot0', client, newSession: async () => { calls.push('newSession'); }, restore: async () => { calls.push('restore'); } };
    const pool = { acquire: async () => slot, restoreOrQuarantine: async () => { calls.push('restoreOrQuarantine'); return null; }, quarantined: new Map() };
    const proxy = { bind: () => {}, unbind: () => {}, finalize: async () => ({ usd: 0, requests: 0, unpriced: 0, byModel: {} }) };
    const { runHardCell } = await import('../../eval/runner/cat40/hard.ts');
    const h5 = byFamily('H5')[0];
    const rec = await runHardCell({ world, worldDigest: 'd', files: { all: new Map() }, pool: pool as never, proxy: proxy as never, scripted: true, judge: null, gbrainLabel: 'gbrain', maxToolChars: null, maxTurns: 4, toolLimits: 'hard', budgetRunId: null, logJudge: () => {} }, 'scripted', 'gbrain', h5, 0, 1);
    expect(calls).toEqual(['newSession', 'newSession', 'newSession', 'newSession', 'restoreOrQuarantine']);
    expect(rec.sessions.length).toBe(5);
  });
  test('prompts: the Hard rules are identical for every arm, the oracle included; the oracle runs only the final session with the ideal store note', () => {
    for (const arm of [new OracleArm(), new FsArm('fs', new FileStore(new Map()))]) expect(hardSystemPrompt(world, arm)).toContain(HARD_RULES);
    for (const phrase of ['executed contract or executed amendment outranks a draft amendment', 'later effective date wins', 'stated effective date', 'documents written after that date', 'later statement outranks']) expect(HARD_RULES).toContain(phrase);
    const h5 = byFamily('H5')[0];
    const o = hardSessions(world, h5, 'oracle');
    expect(o.length).toBe(1);
    expect(o[0]).toContain(h5.oracle_notes![0].body);
    expect(hardSessions(world, h5, 'fs').length).toBe(5);
    expect(oracleOversize(world, world.tasks, ['claude-sonnet-5-5', 'gpt-6.1-sol'])).toEqual([]);
    expect(oracleOversize(world, [{ ...world.tasks[0], relevant: world.docs.map(d => d.id) }], ['claude-sonnet-5-5']).length).toBe(1);
  });
  test('write diagnostic: saved, updated, kept stale and lost, from write-call arguments', () => {
    const h5 = byFamily('H5')[0];
    const f = h5.session_facts!;
    const wrote = (v: string) => ({ tools: [{ name: 'write_file', args: { content: v } }] as unknown as AgentRun['tools'] });
    const sessions = f.map(x => (x.superseded_by ? wrote(x.value) : x.required ? wrote(x.value) : { tools: [] as AgentRun['tools'] }));
    const d = writeDiagnostic(h5, sessions, n => n === 'write_file');
    expect(d.find(x => x.superseded_by)!.outcome).toBe('updated');
    expect(d.filter(x => !x.required && !x.superseded_by).every(x => x.outcome === 'lost')).toBe(true);
  });
  test('scripted agent: recording sessions save and submit RECORDED; the scripted oracle submits the key', () => {
    const h5 = byFamily('H5')[0];
    expect(scriptedHardAgent(h5, 'fs', 0, 5)([]).name).toBe('write_file');
    expect(scriptedHardAgent(h5, 'fs', 0, 5)([{ name: 'write_file', args: {}, result: '' }]).args.answer).toBe(RECORDED);
    expect(scriptedHardAgent(h5, 'oracle', 0, 1)([]).args.answer).toBe(h5.gold.answer![0]);
  });
});

describe('operator tools (T1, T3, T5, T11: DX-F1, DX-F4, DX-F7, DX-F13, CEO-F4, ENG-F9)', () => {
  test('hello: a calibration-seed world, scripted fs, memory and oracle over every family, per-family rows and the freeze-rule table, in under 2 minutes', () => {
    const d = tmp();
    const t0 = Date.now();
    const r = sh('bash', ['scripts/cat40-hard.sh', 'hello'], { HELLO_OUT: d });
    expect(r.code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(120_000);
    expect(r.out).toContain('Freeze rule, round 0');
    for (const f of HARD_FAMILIES) expect(r.out).toMatch(new RegExp(`\\| ${f} \\|`));
    const recs = readFileSync(join(d, 'cells/results.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as CellRecordV2);
    expect(recs.some(x => x.family === 'H5' && x.sessions.length === 5)).toBe(true);
    expect(recs.some(x => x.family === 'H1' && x.score.set !== undefined)).toBe(true);
  }, 120_000);
  test('every stop code is in the runbook with its fix, and the script prints every step in print-only mode', () => {
    const runbook = readFileSync(join(ROOT, 'docs/benchmarks/cat40-hard/RUNBOOK.md'), 'utf8');
    for (const code of Object.keys(HARD_STOP_CODES)) expect(runbook).toContain(code);
    const script = readFileSync(join(ROOT, 'scripts/cat40-hard.sh'), 'utf8');
    for (const m of script.matchAll(/stop (HARD_[A-Z_]+)/g)) expect(Object.keys(HARD_STOP_CODES)).toContain(m[1]);
    for (const s of ['calibrate', 'freeze-check', 'freeze', 'smoke', 'heldout-world', 'slots-50k', 'cells-50k', 'oracle-50k', 'pg-50k', 'memory-50k', 'report']) {
      const r = sh('bash', ['scripts/cat40-hard.sh', 'step', s], { PRINT_ONLY: '1', ROUND: '1', GBRAIN_REF: 'abc' });
      expect(r.code).toBe(0);
      if (!['freeze', 'heldout-world', 'report'].includes(s)) expect(r.out).toContain('--budget-usd');
      if (/50k|calibrate|freeze-check|smoke/.test(s) && !s.startsWith('slots')) expect(r.out).toContain('--judge gpt-6.1-sol');
    }
    for (const s of ['slots-4k', 'simple-4k', 'comparator', 'gbrain-4k']) expect(sh('bash', ['scripts/cat40-hard.sh', 'step', s], { PRINT_ONLY: '1', GBRAIN_REF: 'abc' })).toMatchObject({ code: 3, out: expect.stringContaining('HARD_STEP_RETIRED') });
    expect(sh('bash', ['scripts/cat40-hard.sh', 'step', 'nope']).code).toBe(3);
  });
  test('projections: per model, arm and family, from v1 cost x the measured Hard factor plus the measured judge; measured cells replace them; done cells are not projected; 50k scales 4k measurements', () => {
    const basis = loadCostBasis();
    const p1 = project(stepPlan('calibrate'), { basis });
    expect(p1.cells).toBe(300);
    const fam = ['H1', 'H2', 'H3', 'H4', 'H5'];
    const expected = ['claude-sonnet-5-5', 'gpt-6-astra'].flatMap(m => ['oracle', 'fs', 'pg'].flatMap(a => fam.map(f => 10 * (basis.v1_per_cell_usd[m][a] * basis.hard_factor_by_arm_family[a][f] + basis.judge_per_cell_usd_by_family[f]))));
    expect(p1.total_usd).toBeCloseTo(expected.reduce((x, y) => x + y, 0), 6);
    expect(project({ ...stepPlan('calibrate'), models: ['claude-sonnet-5-5'], arms: ['memory'], tasksPerFamily: 20 }, { basis }).agent_usd).toBeCloseTo(20 * fam.reduce((t, f) => t + basis.v1_per_cell_usd['claude-sonnet-5-5'].memory * basis.hard_factor_by_arm_family.fs[f], 0), 6);
    const cell = (task: string, family: string, total: number, judge: number) => ({ key: `claude-sonnet-5-5|fs|${task}|0`, model: 'claude-sonnet-5-5', arm: 'fs', family, total_usd: total, judge_usd: judge, harness_clean: true });
    const measured = [cell('H1-01', 'H1', 0.5, 0.1)] as never;
    const sonnetFs = (p: ReturnType<typeof project>) => p.rows.find(r => r.model === 'claude-sonnet-5-5' && r.arm === 'fs')!;
    const withH1 = project({ ...stepPlan('calibrate'), families: ['H1'] }, { basis, measured });
    expect(sonnetFs(withH1).per_cell_usd).toBeCloseTo(0.6);
    expect(sonnetFs(project({ ...stepPlan('cells-50k'), families: ['H1'] }, { basis, measured })).per_cell_usd).toBeCloseTo(0.6 * 1.8);
    const done = Array.from({ length: 4 }, (_, i) => cell(`H1-0${i + 1}`, 'H1', 0.5, 0)) as never;
    expect(sonnetFs(project({ ...stepPlan('calibrate'), families: ['H1'] }, { basis, done })).cells).toBe(6);
    expect(() => budgetCheck(10, p1)).toThrow('HARD_BUDGET_SHORT');
    expect(STEPS.filter(s => !s.free).every(s => s.step)).toBe(true);
  });
  test('a resume can open a fresh budget run (--new-budget-run) and keeps the run history; it is a budget flag, not part of the identity', () => {
    const out = tmp();
    const run = (id: string) => ({ run: { runId: id }, guard: {} }) as never;
    const manifest = { gbrain_commit: null, slot_commit: null, world_digest: 'w', models: ['m'], arms: ['fs'], label: 'g', flags: {} };
    bindExperiment(out, manifest, () => run('r1'));
    const joined: Array<string | null> = [];
    bindExperiment(out, manifest, rec => { joined.push(rec); return run('r1'); });
    expect(joined).toEqual(['r1']);
    const fresh = bindExperiment(out, manifest, rec => { joined.push(rec); return run('r2'); }, { newBudgetRun: true });
    expect(joined).toEqual(['r1', null]);
    expect(fresh.manifest).toMatchObject({ budget_run_id: 'r2', budget_runs: ['r1', 'r2'] });
    expect(experimentFlags(['--new-budget-run', '--per-family', '10'])).toEqual({ '--per-family': '10' });
    expect(() => checkRunnerFlags(['--new-budget-run'])).not.toThrow();
  });
  test('ledger roster: allocations within the $4,350 authorization; the Hard ledger opens at $1,794; a missing or different ledger refuses', () => {
    const roster = JSON.parse(readFileSync(join(ROOT, 'docs/benchmarks/cat40-hard/ledger-roster.json'), 'utf8'));
    expect(roster.authorization_usd).toBe(4350);
    expect(roster.ledgers.find((l: { hard?: boolean }) => l.hard).allocation_usd).toBe(1794);
    expect(roster.ledgers.find((l: { hard?: boolean }) => l.hard).path).toBe('.budget/cat40-hard.sqlite');
    const followupsCap = roster.ledgers.find((l: { path: string | null }) => l.path === '.budget/cat40-followups.sqlite').allocation_usd;
    expect(roster.ledgers.reduce((t: number, l: { allocation_usd: number }) => t + l.allocation_usd, 0)).toBeLessThanOrEqual(4350);
    const d = tmp();
    expect(() => checkRoster(roster, d)).toThrow('HARD_LEDGER_ROSTER');
    initLedger({ ledgerPath: join(d, '.budget/cat40-followups.sqlite'), programCapUsd: followupsCap, reason: 'test' });
    initLedger({ ledgerPath: join(d, '.budget/cat40-hard.sqlite'), programCapUsd: 1794, reason: 'test' });
    expect(checkRoster(roster, d)).toMatchObject({ capUsd: 1794, remainingUsd: 1794 });
    closeLedgers();
    const d2 = tmp();
    initLedger({ ledgerPath: join(d2, '.budget/cat40-followups.sqlite'), programCapUsd: followupsCap, reason: 'test' });
    initLedger({ ledgerPath: join(d2, '.budget/cat40-hard.sqlite'), programCapUsd: 3000, reason: 'test' });
    expect(() => checkRoster(roster, d2)).toThrow('records a cap of $3000.00');
  });
});

describe('v1 regression contract (T10: CEO-F2, ENG-F20)', () => {
  test('score.ts keeps its preregistered hash', () => {
    expect(createHash('sha256').update(readFileSync(join(ROOT, 'eval/runner/cat40/score.ts'))).digest('hex')).toStartWith('8a448051');
  });
  test('the v1 world matches its generator (--check) and the large manifest digest is unchanged', () => {
    expect(sh('bun', ['eval/generators/model-ladder-gen.ts', '--check']).code).toBe(0);
    const manifest = JSON.parse(readFileSync(join(ROOT, 'eval/data/model-ladder-v1-large/manifest.json'), 'utf8'));
    expect(manifest.digest).toBe('e481a619fa64b3a9e9712f2c499c3ebdac6bf87dd1ab8de0b95218eb00c3831f');
    expect(worldDigest(generateLadderWorld())).toBe(worldDigest(JSON.parse(readFileSync(join(ROOT, 'eval/data/model-ladder-v1/world.json'), 'utf8'))));
  });
  test('a v1 scripted run scores exactly as the recorded fixture from the pre-Hard runner', async () => {
    const out = tmp();
    await main(['--scripted', '--arms', 'fs,memory,oracle', '--out', out]);
    const got = readFileSync(join(out, 'results.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
      .map(r => ({ key: r.key, score: r.score, stop: r.run.stop, turns: r.run.turns, tools: r.run.tool_calls.map((t: { name: string }) => t.name) })).sort((a, b) => a.key.localeCompare(b.key));
    expect(JSON.stringify(got, null, 1)).toBe(JSON.stringify(JSON.parse(readFileSync(join(ROOT, 'test/fixtures/cat40-v1-scripted-scores.json'), 'utf8')), null, 1));
    expect(existsSync(join(out, 'attempts.jsonl'))).toBe(false);
  });
  test('v1 runs refuse Hard-only flags', async () => {
    await expect(main(['--scripted', '--arms', 'fs', '--per-family', '1', '--out', tmp()])).rejects.toThrow('Hard worlds only');
  });
});

void readRecords;
