/**
 * Cat 40 Hard generator v2 (amendment A1): reference forms. Event records
 * refer to their account by name, code, nickname or account manager; CRM
 * records, account sheets, rename and merger notices resolve them. Covers the
 * knob schema, v1 reproduction at direct_name_share 1, reference
 * resolvability and the validator's mutation cases, oracle evidence
 * completeness, answer-key invariants against v1, the 50k invariants, the
 * difficulty proxy and the runner and operator plumbing. Hermetic ($0).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HARD_V2_KNOB_KEYS, validateKnobs, knobDigest, type HardKnobs, type HardWorld } from '../../eval/generators/hard/schema.ts';
import { evaluatePredicate, managerKnownOn, managerReadingsOn, managerReference, type ValueEvent } from '../../eval/generators/hard/semantics.ts';
import { hardWorldProblems } from '../../eval/generators/hard/validate.ts';
import { generateHardWorld, buildHardLedger, hardWorldDigest, loadKnobs, aliasesOf, HARD_SIZE } from '../../eval/generators/model-ladder-hard.ts';
import { slugify } from '../../eval/generators/hard/rng.ts';
import { referenceProxy } from '../../eval/runner/cat40/hard-proxy.ts';
import { hardSystemPrompt, checkHardWorld, oracleOversize, HARD_RULES_REFERENCES } from '../../eval/runner/cat40/hard.ts';
import { project, stepPlan, loadCostBasis } from '../../eval/runner/cat40/hard-ops.ts';
import { OracleArm } from '../../eval/runner/cat40/arms.ts';
import { main } from '../../eval/runner/cat40-model-ladder.ts';
import { closeLedgers } from '../../eval/runner/budget-ledger.ts';
import type { CellRecordV2 } from '../../eval/runner/cat40/records.ts';

const ROOT = resolve(import.meta.dir, '../..');
const DOCS = join(ROOT, 'docs/benchmarks/cat40-hard');
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'cat40-hard-v2-')); dirs.push(d); return d; };
afterEach(() => { closeLedgers(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const sh = (cmd: string, args: string[], env: Record<string, string> = {}) => {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
};

const CAL = 20261005;
const R2 = loadKnobs(join(DOCS, 'knobs.round-2.json'));
const R3 = loadKnobs(join(DOCS, 'knobs.round-3.json'));
const v1 = generateHardWorld(CAL, R2);
const v2 = generateHardWorld(CAL, R3);
const docs = new Map(v2.docs.map(d => [d.id, d]));
const entities = new Map(v2.entities.map(e => [e.id, e]));
const refsIn = (id: string) => v2.references!.filter(r => r.doc === id);
const clone = (w: HardWorld) => JSON.parse(JSON.stringify(w)) as HardWorld;

describe('knobs and versions (amendment A1)', () => {
  test('the reference-form keys go together; round 3 is round 2 plus them; v2 knobs select generator v2 and knob schema 2', () => {
    expect(() => validateKnobs({ ...R2, direct_name_share: 0.5 })).toThrow('the reference-form keys go together');
    expect(() => validateKnobs({ ...R3, direct_name_share: 1.5 })).toThrow('fraction');
    expect(() => validateKnobs({ ...R3, code_ref_weight: 0, nickname_ref_weight: 0, manager_ref_weight: 0 })).toThrow('sum above 0');
    const { direct_name_share: _d, code_ref_weight: _c, nickname_ref_weight: _n, manager_ref_weight: _m, ...rest } = R3;
    expect(rest).toEqual(R2);
    expect(Object.keys(R3).slice(-4)).toEqual([...HARD_V2_KNOB_KEYS]);
    expect(v1).toMatchObject({ version: 'model-ladder-hard-v1', knob_schema: 1 });
    expect(v2).toMatchObject({ version: 'model-ladder-hard-v2', knob_schema: 2, knob_digest: knobDigest(R3) });
    expect(v1.references).toBeUndefined();
    expect(v2.docs.length).toBeGreaterThanOrEqual(HARD_SIZE.v1[0]);
    expect(v2.docs.length).toBeLessThanOrEqual(HARD_SIZE.v1[1]);
  });
  test('direct_name_share 1 reproduces v1: identical entities, documents and tasks, no references (only version, knob schema, knobs and digest differ)', () => {
    const same: HardKnobs = { ...R2, direct_name_share: 1, code_ref_weight: 0.25, nickname_ref_weight: 0.25, manager_ref_weight: 0.5 };
    const w = generateHardWorld(CAL, same);
    expect(w.version).toBe('model-ladder-hard-v2');
    expect(w.references).toBeUndefined();
    const body = (x: HardWorld) => JSON.stringify({ e: x.entities, d: x.docs, t: x.tasks, today: x.today, p: x.principal, m: x.max_turns });
    expect(body(w)).toBe(body(v1));
    expect(hardWorldDigest({ ...w, version: v1.version, knob_schema: v1.knob_schema, knobs: v1.knobs, knob_digest: v1.knob_digest })).toBe(hardWorldDigest(v1));
  });
});

describe('reference forms resolve (validator)', () => {
  test('the round-3 world passes every invariant; the forms come out near the knob split', () => {
    expect(hardWorldProblems(v2)).toEqual([]);
    const n = v2.references!.length, share = (f: string) => v2.references!.filter(r => r.form === f).length / n;
    expect(share('name')).toBeCloseTo(0.15, 1);
    for (const f of ['code', 'nickname', 'manager']) { expect(share(f)).toBeGreaterThan(0.2); expect(share(f)).toBeLessThan(0.36); }
  });
  test('a record not by name never names its account, and a nickname or manager record never gives its code; manager references fit one account on their date', () => {
    for (const r of v2.references!) {
      const d = docs.get(r.doc)!, e = entities.get(r.entity)!, text = `${d.title}\n${d.body}`;
      expect(text).toContain(r.text);
      if (r.form === 'name') continue;
      for (const n of [e.name, ...e.aliases.filter(a => !e.refs!.codes.includes(a) && !e.refs!.nicknames.includes(a))]) expect(text).not.toContain(n);
      if (r.form !== 'code') for (const c of e.refs!.codes) expect(text).not.toMatch(new RegExp(`\\b${c}\\b`));
      if (r.form === 'manager') {
        const events = (x: typeof e) => x.refs!.managers.map(m => ({ value: m.name, effective: m.effective, recorded: m.recorded, doc: m.doc, kind: 'change' }) as ValueEvent);
        const m = managerKnownOn(events(e), d.date)!;
        expect(r.text).toBe(managerReference(m, e.refs!.descriptor));
        expect(v2.entities.filter(o => o.refs!.descriptor === e.refs!.descriptor && managerReadingsOn(events(o), d.date).has(m)).map(o => o.id)).toEqual([e.id]);
      }
    }
  });
  test('the validator catches a leaked name, an ambiguous manager reference, a late account sheet and a reference that is not in its document', () => {
    let m = clone(v2);
    const code = m.references!.find(r => r.form === 'code')!;
    m.docs.find(d => d.id === code.doc)!.body += ` ${m.entities.find(e => e.id === code.entity)!.name}`;
    expect(hardWorldProblems(m)).toContain('1 references not by name still name their account');
    m = clone(v2);
    const mr = m.references!.find(r => r.form === 'manager')!;
    const me = m.entities.find(e => e.id === mr.entity)!, other = m.entities.find(e => e.id !== me.id)!;
    other.refs = { ...other.refs!, descriptor: me.refs!.descriptor, managers: me.refs!.managers };
    expect(hardWorldProblems(m).some(p => p.includes('fit more than one account'))).toBe(true);
    m = clone(v2);
    for (const d of m.docs) if (d.id.startsWith('accounts/')) d.date = m.today;
    expect(hardWorldProblems(m).some(p => p.includes('introduced by no resolution document dated on or before them'))).toBe(true);
    m = clone(v2);
    m.references![0].text = 'Nowhere Example';
    expect(hardWorldProblems(m).some(p => p.includes('are not in their document'))).toBe(true);
    m = clone(v2);
    delete m.references;
    expect(hardWorldProblems(m)).toContain('direct_name_share is below 1 but the world lists no references');
  });
  test('event documents have opaque ids that carry no account name or code; resolution documents keep readable ids', () => {
    for (const d of v2.docs) {
      const refs = refsIn(d.id);
      if (!refs.length) continue;
      for (const r of refs) { const e = entities.get(r.entity)!; for (const n of [e.name, ...e.aliases]) expect(d.id).not.toContain(slugify(n)); }
    }
    expect(v2.docs.filter(d => d.id.startsWith('accounts/')).length).toBe(v2.entities.length + v2.entities.reduce((n, e) => n + e.refs!.nicknames.length - 1, 0));
  });
});

describe('oracle evidence completeness', () => {
  test('every oracle record carries the resolution documents its reference needs: CRM for a code, account sheet for a nickname, sheet and manager timeline for a manager form, merger and rename notices for other names', () => {
    const b = buildHardLedger(CAL, R3);
    const byId = new Map(b.docs.map(d => [d.id, d]));
    const mergerOf = (id: string) => b.accounts.flatMap(h => h.mergedIn.map(m => ({ h, m }))).find(({ h, m }) => b.accounts.some(a => a.id === id && a.mergedInto === h.id && a.name === m.name))!.m.doc;
    let checked = 0;
    for (const t of b.tasks) {
      const rel = new Set(t.relevant);
      for (const id of t.relevant) for (const I of byId.get(id)!.refs ?? []) {
        const a = I.account, { form, text } = I.resolved!, date = byId.get(id)!.date;
        checked++;
        if (a.mergedInto) expect(rel.has(mergerOf(a.id))).toBe(true);
        if (form === 'name' && a.former && text === a.former.name) expect(rel.has(a.former.doc)).toBe(true);
        if (form === 'code') expect(rel.has(a.crmDoc)).toBe(true);
        if (form === 'nickname' || form === 'manager') expect(rel.has(a.sheetDoc!)).toBe(true);
        if (form === 'manager') for (const e of a.owner.filter(x => x.recorded <= date)) expect(rel.has(e.doc)).toBe(true);
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });
  test('every oracle prompt stays under the calibration models\' input limits', () => {
    expect(oracleOversize(v2, v2.tasks, ['claude-sonnet-5-5', 'gpt-6-astra'])).toEqual([]);
  });
});

describe('answer keys (computed from the ledger, never from text)', () => {
  test('v2 keeps every v1 answer key for the same knobs: same values, wrong values, counts, members and predicates; questions still ask by name', () => {
    expect(v2.tasks.length).toBe(v1.tasks.length);
    v2.tasks.forEach((t, i) => {
      const o = v1.tasks[i];
      expect([t.id, t.variant, t.answer_kind, t.accounts, t.predicate, t.session_facts, t.sessions]).toEqual([o.id, o.variant, o.answer_kind, o.accounts, o.predicate, o.session_facts, o.sessions]);
      expect([t.gold.answer, t.gold.wrong, t.gold.count, t.gold.members?.map(m => m.id)]).toEqual([o.gold.answer, o.gold.wrong, o.gold.count, o.gold.members?.map(m => m.id)]);
      if (t.family === 'H2' || t.family === 'H4') expect(t.question).toContain(entities.get(t.accounts[0])!.name);
      else expect(t.question).toBe(o.question);
    });
    const b = buildHardLedger(CAL, R3);
    for (const t of v2.tasks.filter(x => x.family === 'H1')) {
      const { members } = evaluatePredicate(t.predicate!, b.facts());
      if (t.answer_kind === 'count') expect(t.gold.count).toBe(members.length);
      else expect(t.gold.members!.map(m => m.id).sort()).toEqual([...members].sort());
    }
  });
  test('set members accept every name of the entity, nicknames included; manager references are not names', () => {
    const set = v2.tasks.find(t => t.answer_kind === 'set')!;
    for (const m of set.gold.members!) {
      const e = entities.get(m.id)!;
      expect(m.names).toEqual([e.name, ...e.aliases]);
      for (const n of e.refs!.nicknames) expect(m.names).toContain(n);
    }
    const b = buildHardLedger(CAL, R3);
    expect(aliasesOf(b.accounts[0])).toContain(b.accounts[0].nickname!);
  });
});

describe('50k (generator v2)', () => {
  test('appended accounts never satisfy an H1 key and have their own account managers; the 4k documents and the non-H1 tasks are identical inside the 50k ledger', () => {
    const small = buildHardLedger(CAL, R3), large = buildHardLedger(CAL, R3, { scale: 'large' });
    for (const t of small.tasks.filter(x => x.family === 'H1')) expect(evaluatePredicate(t.predicate!, large.facts()).members.sort()).toEqual(evaluatePredicate(t.predicate!, small.facts()).members.sort());
    const staff4k = new Set(small.staff);
    for (const a of large.appended) for (const e of a.owner) expect(staff4k.has(e.value)).toBe(false);
    const text = (v: string | (() => string)) => (typeof v === 'function' ? v() : v);
    const byId = new Map(large.docs.map(d => [d.id, d]));
    for (const d of small.docs.filter((_, i) => i % 5 === 0)) { const l = byId.get(d.id)!; expect([text(l.title), text(l.body)]).toEqual([text(d.title), text(d.body)]); }
    expect(JSON.stringify(large.tasks.filter(t => t.family !== 'H1'))).toBe(JSON.stringify(small.tasks.filter(t => t.family !== 'H1')));
    expect(large.docs.length).toBeGreaterThan(HARD_SIZE.large[0]);
    expect(large.docs.length).toBeLessThan(HARD_SIZE.large[1]);
  }, 180_000);
});

describe('difficulty proxy', () => {
  test('round-2 knobs: records name the asked account about 90% of the time; round-3 knobs: about 15%, and only manager-form records stay out of reach of name, code and nickname greps', () => {
    const mean = (r: ReturnType<typeof referenceProxy>, k: 'names_it' | 'one_grep' | 'with_nickname') => r.rows.reduce((s, x) => s + x[k], 0) / r.rows.length;
    const p2 = referenceProxy(buildHardLedger(CAL, R2)), p3 = referenceProxy(buildHardLedger(CAL, R3));
    expect(mean(p2, 'names_it')).toBeGreaterThan(0.85);
    expect(mean(p3, 'names_it')).toBeLessThan(0.25);
    expect(mean(p3, 'one_grep')).toBeLessThan(0.25);
    expect(mean(p3, 'with_nickname')).toBeLessThan(0.9);
    for (const r of p3.rows) expect(r.names_it).toBeLessThan(0.35);
  });
});

describe('runner and operator plumbing', () => {
  test('the runner accepts a v2 world, states the reference rule only to v2 worlds, and the scripted oracle scores the key', async () => {
    const d = tmp(), path = join(d, 'world.json');
    writeFileSync(path, JSON.stringify(v2));
    expect(() => checkHardWorld(v2, path)).not.toThrow();
    expect(hardSystemPrompt(v2, new OracleArm())).toContain(HARD_RULES_REFERENCES);
    expect(hardSystemPrompt(v1, new OracleArm())).not.toContain(HARD_RULES_REFERENCES);
    const out = join(d, 'cells');
    await main(['--scripted', '--world', path, '--arms', 'oracle,fs', '--per-family', '1', '--out', out]);
    const recs = readFileSync(join(out, 'results.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as CellRecordV2);
    expect(recs.filter(r => r.arm === 'oracle').every(r => r.score.success)).toBe(true);
    expect(recs.length).toBe(10);
  });
  test('projections use measured cells at the step\'s scale when there are any, else 4k cells times the 50k factor; a known world size adds the pg setup embedding', () => {
    const basis = loadCostBasis();
    const cell = (scale: 'v1' | 'large', total: number) => ({ key: `claude-sonnet-5-5|fs|H1-01|0|${scale}`, model: 'claude-sonnet-5-5', arm: 'fs', family: 'H1', total_usd: total, judge_usd: 0, harness_clean: true, scale });
    const plan = { ...stepPlan('calibrate'), scale: 'large' as const, families: ['H1'] };
    const row = (p: ReturnType<typeof project>) => p.rows.find(r => r.model === 'claude-sonnet-5-5' && r.arm === 'fs')!;
    expect(row(project(plan, { basis, measured: [cell('v1', 0.5)] as never })).per_cell_usd).toBeCloseTo(0.5 * basis.scale_50k_factor.fs);
    expect(row(project(plan, { basis, measured: [cell('v1', 0.5), cell('large', 2)] as never })).per_cell_usd).toBeCloseTo(2);
    expect(project(plan, { basis }).pg_setup_usd).toBe(0);
    expect(project(plan, { basis, worldBytes: 80_000_000 }).pg_setup_usd).toBeCloseTo(80 / 4 * basis.pg_embed_usd_per_million_tokens);
  });
  test('the calibrate step builds the 50k world from round 3 on (SCALE overrides) and projects at that scale', () => {
    const r3 = sh('bash', ['scripts/cat40-hard.sh', 'step', 'calibrate'], { PRINT_ONLY: '1', ROUND: '3' });
    expect(r3.code).toBe(0);
    expect(r3.out).toContain('--scale large --base-world eval/reports/cat40/hard/calibration/round-3/base-4k/world.json --out eval/reports/cat40/hard/calibration/round-3/world');
    const r2 = sh('bash', ['scripts/cat40-hard.sh', 'step', 'calibrate'], { PRINT_ONLY: '1', ROUND: '2' });
    expect(r2.out).not.toContain('--scale large');
    expect(sh('bash', ['scripts/cat40-hard.sh', 'step', 'calibrate'], { PRINT_ONLY: '1', ROUND: '3', SCALE: 'v1' }).out).not.toContain('--scale large');
    expect(sh('bash', ['scripts/cat40-hard.sh', 'step', 'calibrate'], { PRINT_ONLY: '1', ROUND: '3', SCALE: 'huge' }).code).toBe(2);
    const p = sh('bun', ['eval/runner/cat40/hard-ops.ts', 'project', '--step', 'calibrate', '--scale', 'large']);
    expect(JSON.parse(p.out).total_usd).toBeGreaterThan(JSON.parse(sh('bun', ['eval/runner/cat40/hard-ops.ts', 'project', '--step', 'calibrate']).out).total_usd);
  });
});
