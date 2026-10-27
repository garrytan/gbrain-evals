/**
 * Cat 40 Hard amendment A2: multi-account questions (H2 to H5 ask about 2 to 3
 * accounts, answered as one JSON array), smaller H1 sets, the `values` answer
 * kind in the Hard scorer, and the 50k-only held-out path. Hermetic ($0).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HARD_MULTI_KNOB_KEYS, validateKnobs, type HardTask, type HardWorld } from '../../eval/generators/hard/schema.ts';
import { valueAsOf, evaluatePredicate, statedValue } from '../../eval/generators/hard/semantics.ts';
import { hardWorldProblems } from '../../eval/generators/hard/validate.ts';
import { generateHardWorld, buildHardLedger, hardWorldDigest, loadKnobs, h5Resolve, descriptorOf, type HardAccount } from '../../eval/generators/model-ladder-hard.ts';
import { scoreHardTask } from '../../eval/runner/cat40/score-hard.ts';
import { writeDiagnostic } from '../../eval/runner/cat40/hard.ts';
import { referenceProxy } from '../../eval/runner/cat40/hard-proxy.ts';
import { stepPlan, STEPS, RETIRED_STEPS } from '../../eval/runner/cat40/hard-ops.ts';
import { main } from '../../eval/runner/cat40-model-ladder.ts';
import { closeLedgers } from '../../eval/runner/budget-ledger.ts';
import type { AgentRun } from '../../eval/runner/cat40/loop.ts';
import type { CellRecordV2 } from '../../eval/runner/cat40/records.ts';

const ROOT = resolve(import.meta.dir, '../..');
const DOCS = join(ROOT, 'docs/benchmarks/cat40-hard');
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'cat40-hard-a2-')); dirs.push(d); return d; };
afterEach(() => { closeLedgers(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const sh = (args: string[], env: Record<string, string> = {}) => {
  const r = spawnSync('bash', ['scripts/cat40-hard.sh', ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
};

const CAL = 20261005;
const R3 = loadKnobs(join(DOCS, 'knobs.round-3.json'));
const R4 = loadKnobs(join(DOCS, 'knobs.round-4.json'));
const w4 = generateHardWorld(CAL, R4);
const b4 = buildHardLedger(CAL, R4);
const byAccount = new Map([...b4.accounts, ...b4.appended].map(a => [a.id, a]));
const multi = w4.tasks.filter(t => t.answer_kind === 'values');
const clone = (w: HardWorld) => JSON.parse(JSON.stringify(w)) as HardWorld;
const fin = (answer: unknown): AgentRun => ({ final: { answer, sources: [] }, stop: 'submitted' } as unknown as AgentRun);

describe('knobs (amendment A2)', () => {
  test('the multi-account keys go together and need the reference-form keys; round 4 is round 3 plus them, smaller H1 sets, a higher manager weight and fewer appended accounts', () => {
    const { multi_account_max: _m, ...half } = R4;
    expect(() => validateKnobs(half)).toThrow('multi-account keys need each other');
    expect(() => validateKnobs({ ...R4, multi_account_min: 0 })).toThrow('multi_account_min is at least 1');
    expect(() => validateKnobs({ ...R4, multi_account_min: 3, multi_account_max: 2 })).toThrow('above multi_account_max');
    expect(Object.keys(R4).slice(-2)).toEqual([...HARD_MULTI_KNOB_KEYS]);
    const changed = Object.keys(R4).filter(k => (R4 as unknown as Record<string, number>)[k] !== (R3 as unknown as Record<string, number>)[k]).sort();
    expect(changed).toEqual(['h1_max_members', 'h1_min_members', 'large_extra_accounts', 'manager_ref_weight', 'multi_account_max', 'multi_account_min']);
    expect(w4).toMatchObject({ version: 'model-ladder-hard-v2', knob_schema: 3 });
  });
  test('multi_account 1 reproduces the v2 world: identical entities, documents, tasks and references (only knob schema, knobs and digest differ); the round-3 world is unchanged', () => {
    const w3 = generateHardWorld(CAL, R3);
    expect(hardWorldDigest(w3)).toBe('6c1476a3a74353948e999ec4ae388eca8046a65e0e959d847d16c81a29b433be');
    const one = generateHardWorld(CAL, { ...R3, multi_account_min: 1, multi_account_max: 1 });
    expect(one.knob_schema).toBe(3);
    const body = (x: HardWorld) => JSON.stringify({ v: x.version, e: x.entities, d: x.docs, t: x.tasks, r: x.references });
    expect(body(one)).toBe(body(w3));
  });
});

describe('multi-account questions', () => {
  test('every H2 to H5 question asks about 2 or 3 accounts as numbered items answered in one JSON array; H1 sets have 6 to 12 members', () => {
    expect(hardWorldProblems(w4)).toEqual([]);
    for (const t of w4.tasks.filter(x => x.family !== 'H1')) {
      expect(t.answer_kind).toBe('values');
      expect(t.gold.items!.length).toBeGreaterThanOrEqual(2);
      expect(t.gold.items!.length).toBeLessThanOrEqual(3);
      expect(t.question).toStartWith(`Answer each of these ${t.gold.items!.length} questions:\n1. `);
      expect(t.question).toContain('Answer with a JSON array');
      expect(t.gold.wrong).toBeUndefined();
    }
    for (const t of w4.tasks.filter(x => x.family === 'H1')) {
      const n = evaluatePredicate(t.predicate!, b4.facts()).members.length;
      expect(n).toBeGreaterThanOrEqual(6);
      expect(n).toBeLessThanOrEqual(12);
    }
  });
  test('no two accounts of one question share a descriptor, first word, code prefix or account manager', () => {
    for (const t of multi) {
      const as = t.gold.items!.map(it => byAccount.get(it.account)!);
      for (let i = 0; i < as.length; i++) for (let j = i + 1; j < as.length; j++) {
        expect(descriptorOf(as[i])).not.toBe(descriptorOf(as[j]));
        expect(as[i].base).not.toBe(as[j].base);
        expect(as[i].code.slice(0, 3)).not.toBe(as[j].code.slice(0, 3));
        for (const e of as[i].owner) expect(as[j].owner.map(o => o.value)).not.toContain(e.value);
      }
    }
  });
  test('each item\'s key is the single-account key computed from the ledger (H2 as of the item\'s date, H3 and H4 now, H5 from the item\'s statement chain)', () => {
    const today = w4.today;
    const term = (a: HardAccount, attr: string) => (attr === 'owner' ? a.owner : attr === 'renewal_date' ? a.renewal : a.terms[attr as 'seats']);
    for (const t of multi) {
      const lines = t.question.split('\n').slice(1, -1);
      t.gold.items!.forEach((it, n) => {
        const a = byAccount.get(it.account)!, line = lines[n], variant = t.variant.split('|')[n];
        if (t.family === 'H2') expect(it.answer[0]).toBe(valueAsOf(term(a, line.includes('licensed seats') ? 'seats' : 'liability_cap'), line.match(/on (\d{4}-\d{2}-\d{2})\?$/)![1])!);
        if (t.family === 'H3' || t.family === 'H4') expect(it.answer[0]).toBe(valueAsOf(term(a, variant.split(':').at(-1)!), today)!);
        if (t.family === 'H5') {
          const facts = t.session_facts!.filter(f => t.accounts.some(id => f.key.endsWith(id)));
          const mine = facts.filter(f => f.key.endsWith(it.account) || (variant === 'merge' && f.key.startsWith('discount_code:')));
          const ctx = variant === 'routing' ? { x: it.account, y: null, billing: a.billing } : { x: t.accounts[t.accounts.indexOf(it.account) - 1], y: it.account };
          const stated = mine.map(f => ({ session: f.session, key: f.key, value: f.value }));
          expect(h5Resolve(variant, stated, ctx)).toBe(it.answer[0]);
          expect(statedValue(stated, variant === 'routing' ? `invoice_routing:${it.account}` : `merged_into:${it.account}`, null)).not.toBeNull();
        }
        expect(it.wrong).not.toContain(it.answer[0]);
      });
    }
  });
  test('the oracle evidence covers every item\'s account, and the validator catches a dropped account or a linked pair', () => {
    for (const t of multi) for (const it of t.gold.items!) expect(t.relevant).toContain(byAccount.get(it.account)!.crmDoc);
    let m = clone(w4);
    const t = m.tasks.find(x => x.family === 'H2' && x.answer_kind === 'values')!;
    const drop = byAccount.get(t.gold.items![1].account)!;
    t.relevant = t.relevant.filter(id => id !== drop.crmDoc && id !== drop.sheetDoc);
    expect(hardWorldProblems(m).some(p => p.startsWith('H2 task index') && p.includes('do not reach the account\'s name'))).toBe(true);
    m = clone(w4);
    const t2 = m.tasks.find(x => x.family === 'H4' && x.answer_kind === 'values')!;
    const [e0, e1] = t2.gold.items!.map(it => m.entities.find(e => e.id === it.account)!);
    e1.refs = { ...e1.refs!, descriptor: e0.refs!.descriptor };
    expect(hardWorldProblems(m).some(p => p.includes('share a descriptor, first word, code prefix or account manager'))).toBe(true);
  });
  test('H5 chains interleave: each recording session carries one statement per account, and the write diagnostic matches a superseded fact to its own chain', () => {
    for (const t of w4.tasks.filter(x => x.family === 'H5')) {
      expect(t.sessions!.length).toBe(4);
      expect(t.session_facts!.length).toBe(4 * t.gold.items!.length);
      for (let s = 1; s <= 4; s++) expect(t.session_facts!.filter(f => f.session === s).length).toBe(t.gold.items!.length);
    }
    const t = w4.tasks.find(x => x.family === 'H5')!;
    const wrote = (s: number) => ({ tools: [{ name: 'write_file', args: { content: t.session_facts!.filter(f => f.session === s).map(f => f.value).join(' ') } }] as unknown as AgentRun['tools'] });
    const d = writeDiagnostic(t, [1, 2, 3, 4].map(wrote), n => n === 'write_file');
    for (const f of d.filter(x => x.superseded_by)) expect(f.outcome).toBe('updated');
  });
  test('the 50k world keeps every H1 key, holds the 4k documents byte for byte and keeps the non-H1 tasks', () => {
    const large = buildHardLedger(CAL, R4, { scale: 'large' });
    for (const t of b4.tasks.filter(x => x.family === 'H1')) expect(evaluatePredicate(t.predicate!, large.facts()).members.sort()).toEqual(evaluatePredicate(t.predicate!, b4.facts()).members.sort());
    expect(JSON.stringify(large.tasks.filter(t => t.family !== 'H1'))).toBe(JSON.stringify(b4.tasks.filter(t => t.family !== 'H1')));
    const text = (v: string | (() => string)) => (typeof v === 'function' ? v() : v);
    const byId = new Map(large.docs.map(d => [d.id, d]));
    for (const d of b4.docs.filter((_, i) => i % 9 === 0)) expect(text(byId.get(d.id)!.body)).toBe(text(d.body));
  }, 180_000);
  test('the proxy reports oracle documents and accounts per answer', () => {
    const p = referenceProxy(b4);
    for (const r of p.rows.filter(x => x.family !== 'H1')) { expect(r.accounts_per_task).toBeGreaterThanOrEqual(2); expect(r.docs_per_task).toBeGreaterThan(10); }
    expect(p.rows.find(r => r.family === 'H1')!.accounts_per_task).toBeLessThanOrEqual(12);
  });
});

describe('scoring `values` answers', () => {
  const t = multi[0];
  const right = t.gold.items!.map(it => it.answer[0]);
  test('a JSON array in item order passes, as a string, a native array or inside text; numbers count as strings', () => {
    expect(scoreHardTask(w4, t, [fin(JSON.stringify(right))])).toMatchObject({ success: true, items: { correct: right.length, expected: right.length } });
    expect(scoreHardTask(w4, t, [fin(right)]).success).toBe(true);
    expect(scoreHardTask(w4, t, [fin(`Here: ${JSON.stringify(right)}`)]).success).toBe(true);
    const numeric = { ...t, gold: { ...t.gold, items: [{ account: 'a', answer: ['1200'], wrong: ['900'] }, { account: 'b', answer: ['Net 30'], wrong: ['Net 45'] }] } } as HardTask;
    expect(scoreHardTask(w4, numeric, [fin('[1200, "Net 30"]')]).success).toBe(true);
  });
  test('the wrong order, a missing or extra item, a wrong value in any item, or prose fails', () => {
    expect(scoreHardTask(w4, t, [fin(JSON.stringify([...right].reverse()))]).success).toBe(false);
    expect(scoreHardTask(w4, t, [fin(JSON.stringify(right.slice(1)))])).toMatchObject({ success: false, items: { correct: 0 } });
    expect(scoreHardTask(w4, t, [fin(JSON.stringify([...right, 'x']))]).success).toBe(false);
    const withWrong = [...right]; withWrong[1] = `${right[1]} (or ${t.gold.items![1].wrong[0]})`;
    expect(scoreHardTask(w4, t, [fin(JSON.stringify(withWrong))])).toMatchObject({ success: false, said_wrong: true, items: { correct: right.length - 1 } });
    expect(scoreHardTask(w4, t, [fin(right.join(', '))])).toMatchObject({ success: false, unparseable_set: true });
  });
  test('a scripted oracle run on the round-4 world scores every multi-account task', async () => {
    const d = tmp(), path = join(d, 'world.json');
    writeFileSync(path, JSON.stringify(w4));
    await main(['--scripted', '--world', path, '--arms', 'oracle', '--per-family', '2', '--out', join(d, 'cells')]);
    const recs = readFileSync(join(d, 'cells/results.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as CellRecordV2);
    expect(recs.length).toBe(10);
    expect(recs.every(r => r.score.success)).toBe(true);
  }, 300_000);
});

describe('50k-only held-out path (amendment A2)', () => {
  test('the 4k held-out steps are retired; the 50k batches are separate steps in order, memory on two models only', () => {
    for (const s of RETIRED_STEPS) expect(() => stepPlan(s)).toThrow('HARD_STEP_RETIRED');
    expect(STEPS.map(s => s.step).slice(-4)).toEqual(['cells-50k', 'oracle-50k', 'pg-50k', 'memory-50k']);
    expect(stepPlan('cells-50k').arms).toEqual(['gbrain', 'fs']);
    expect(stepPlan('oracle-50k').families).toBeUndefined();
    expect(stepPlan('memory-50k').models).toEqual(['claude-sonnet-5-5', 'gpt-6.1-sol']);
    for (const s of ['heldout-world', 'slots-50k', 'cells-50k', 'oracle-50k', 'pg-50k', 'memory-50k']) expect(stepPlan(s).scale).toBe('large');
  });
  test('each batch prints its own runner command and budget gate, and waits for the batch before it', () => {
    const pg = sh(['step', 'pg-50k'], { PRINT_ONLY: '1', GBRAIN_REF: 'abc' });
    expect(pg.out).toContain('# requires: batch oracle-50k');
    expect(pg.out).toContain('--arms pg');
    expect(pg.out).toContain('--out eval/reports/cat40/hard/pg-50k --step pg-50k');
    expect(sh(['step', 'memory-50k'], { PRINT_ONLY: '1' }).out).toContain('--models claude-sonnet-5-5,gpt-6.1-sol --arms memory');
    const held = sh(['step', 'heldout-world'], { PRINT_ONLY: '1' }).out;
    expect(held).toContain('--out eval/reports/cat40/hard-holdout/base-4k');
    expect(held).toContain('--scale large --base-world eval/reports/cat40/hard-holdout/base-4k/world.json --out eval/reports/cat40/hard-holdout/50k');
    const report = sh(['step', 'report'], { PRINT_ONLY: '1' }).out;
    expect(report).toContain('--hard-headline gbrain-hard,fs --simple fs');
    expect(report).not.toContain('simple-4k');
  });
});
