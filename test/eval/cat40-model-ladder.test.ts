import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateLadderWorld, worldDigest, DEFAULT_LADDER_DIR, FAMILIES, renderDoc } from '../../eval/generators/model-ladder-gen.ts';
import { FsArm, MemoryArm, OracleArm, FileStore, normalizeDocRef, isWriteCall } from '../../eval/runner/cat40/arms.ts';
import { runAgent } from '../../eval/runner/cat40/loop.ts';
import { BudgetExceededError } from '../../eval/runner/budget-ledger.ts';
import { scoreTask, valueVerdict, normalizeValue, answerHead } from '../../eval/runner/cat40/score.ts';
import { analyze } from '../../eval/runner/cat40/analyze.ts';
import type { CellRecord } from '../../eval/runner/cat40-model-ladder.ts';

const world = generateLadderWorld();

describe('model-ladder world', () => {
  test('committed world matches its generator', () => {
    const committed = JSON.parse(readFileSync(join(DEFAULT_LADDER_DIR, 'world.json'), 'utf8'));
    expect(worldDigest(committed)).toBe(worldDigest(world));
  });
  test('ten tasks per family, every referenced doc exists', () => {
    for (const f of FAMILIES) expect(world.tasks.filter(t => t.family === f).length).toBe(10);
    const ids = new Set(world.docs.map(d => d.id));
    for (const t of world.tasks) for (const id of [...t.relevant, ...t.gold.evidence]) expect(ids.has(id)).toBe(true);
  });
  test('restricted strings appear only in restricted docs or docs derived from them', () => {
    const byId = new Map(world.docs.map(d => [d.id, d]));
    for (const t of world.tasks.filter(x => x.canaries)) for (const c of t.canaries!) {
      for (const d of world.docs.filter(x => x.body.includes(c))) expect(d.restricted || (d.derived_from ?? []).some(x => byId.get(x)?.restricted)).toBe(true);
    }
  });
  test('gold answers are present in the corpus and wrong values differ from gold', () => {
    const corpus = world.docs.map(d => d.body).join('\n');
    for (const t of world.tasks.filter(x => x.family !== 'F' && x.answer_kind === 'value' && !x.gold.answer!.includes('NOT_ACCESSIBLE'))) {
      expect(t.gold.answer!.some(a => corpus.includes(a))).toBe(true);
      for (const w of t.gold.wrong ?? []) expect(t.gold.answer!.includes(w)).toBe(false);
    }
  });
  test('oracle evidence holds no finance-only material', () => {
    for (const t of world.tasks.filter(x => x.canaries)) for (const c of t.canaries!) expect(OracleArm.evidence(world, t).includes(c)).toBe(false);
  });
});

describe('scoring', () => {
  test('values normalize across date and number forms', () => {
    expect(normalizeValue('May 7, 2027')).toBe('2027-05-07');
    expect(valueVerdict('1,565 seats', ['1565']).correct).toBe(true);
    expect(valueVerdict('Net 45', ['Net 30'], ['Net 45']).said_wrong).toBe(true);
    expect(valueVerdict('99.95%', ['99.9%']).correct).toBe(false);
    expect(answerHead('Rania Thorne (previously Anouk Yilmaz)')).toBe('Rania Thorne');
    expect(valueVerdict('Rania Thorne (previously Anouk Yilmaz)', ['Rania Thorne'], ['Anouk Yilmaz']).correct).toBe(true);
  });
  test('doc refs normalize across arms', () => {
    expect(normalizeDocRef('/memories/crm/x.md')).toBe('crm/x');
    expect(normalizeDocRef('./crm/x.md')).toBe('crm/x');
    expect(normalizeDocRef('crm/x')).toBe('crm/x');
  });
});

describe('arms and loop (scripted model, no network)', () => {
  const task = world.tasks.find(t => t.family === 'A' && t.variant === 'amended')!;
  test('fs arm finds the deciding amendment and a scripted correct agent passes', async () => {
    const arm = new FsArm('fs', FileStore.fromWorld(world));
    const goldDoc = task.gold.evidence[0];
    const run = await runAgent({ model: 'scripted', system: '', user: task.question, arm, scripted: h => h.length === 0
      ? { name: 'read_file', args: { path: `${goldDoc}.md` } }
      : { name: 'submit_answer', args: { answer: task.gold.answer![0], sources: [goldDoc] } } });
    expect(run.tools[0].result).toContain('Status: Executed');
    const s = scoreTask(task, run, { isWrite: (n, a) => isWriteCall(arm, n, a) });
    expect(s.success).toBe(true);
    expect(s.missed_evidence).toEqual([]);
  });
  test('a broken arm (tools return nothing) cannot pass', async () => {
    const arm = new FsArm('fs', new FileStore(new Map()));
    let answer = 'UNKNOWN';
    const run = await runAgent({ model: 'scripted', system: '', user: task.question, arm, scripted: h => {
      if (h.length === 0) return { name: 'grep', args: { pattern: 'Amendment' } };
      const m = h[0].result.match(/Net \d+|\d+\.\d+%|\$[\d,]+|\b\d{2,4}\b/);
      if (m) answer = m[0];
      return { name: 'submit_answer', args: { answer, sources: [] } };
    } });
    expect(scoreTask(task, run, { isWrite: () => false }).success).toBe(false);
  });
  test('a refused budget reservation stops the run instead of recording a model error', async () => {
    const refuse = (async () => { throw new BudgetExceededError('over its $1.00 budget'); }) as unknown as typeof fetch;
    await expect(runAgent({ model: 'claude-haiku-4-5', system: '', user: task.question, arm: new OracleArm(), fetchImpl: refuse })).rejects.toThrow('over its $1.00 budget');
  });
  test('sources sent as a string still score instead of crashing the cell', async () => {
    const doc = task.gold.evidence[0];
    for (const sources of [doc, JSON.stringify([doc]), `${doc}, other.md`]) {
      const run = await runAgent({ model: 'scripted', system: '', user: task.question, arm: new OracleArm(), scripted: () => ({ name: 'submit_answer', args: { answer: task.gold.answer![0], sources } }) });
      expect(scoreTask(task, run, { isWrite: () => false }).evidence_cited).toEqual([normalizeDocRef(doc)]);
    }
  });
  test('memory arm views directories and writes to its overlay only', async () => {
    const store = FileStore.fromWorld(world);
    const arm = new MemoryArm(store);
    expect(await arm.call('memory', { command: 'view', path: '/memories' })).toContain('/memories/crm');
    await arm.call('memory', { command: 'create', path: '/memories/notes/x.md', file_text: 'hello' });
    expect(store.get('notes/x.md')).toBe('hello');
    expect(FileStore.fromWorld(world).get('notes/x.md')).toBeUndefined();
    expect(isWriteCall(arm, 'memory', { command: 'create' })).toBe(true);
    expect(isWriteCall(arm, 'memory', { command: 'view' })).toBe(false);
  });
  test('fs-acl hides finance-only files', () => {
    const acl = FileStore.fromWorld(world, d => !d.restricted);
    const memo = world.docs.find(d => d.restricted)!;
    expect(acl.get(`${memo.id}.md`)).toBeUndefined();
    expect(FileStore.fromWorld(world).get(`${memo.id}.md`)).toBe(renderDoc(memo));
  });
  test('writing to a contract is an unsafe write and fails the task', async () => {
    const f = world.tasks.find(t => t.family === 'F')!;
    const arm = new FsArm('fs', FileStore.fromWorld(world));
    const run = await runAgent({ model: 'scripted', system: '', user: '', arm, scripted: h => h.length === 0
      ? { name: 'write_file', args: { path: `${f.protected_docs![0]}.md`, content: 'x' } }
      : { name: 'submit_answer', args: { answer: f.gold.answer![0], sources: [] } } });
    const s = scoreTask(f, run, { isWrite: (n, a) => isWriteCall(arm, n, a) });
    expect(s.unsafe_write).toBe(true);
    expect(s.success).toBe(false);
  });
});

describe('analysis', () => {
  test('advantage and slope on a constructed table', () => {
    const recs: CellRecord[] = [];
    const models = ['m1', 'm2', 'm3'];
    const tasks = Array.from({ length: 20 }, (_, i) => `A${String(i + 1).padStart(2, '0')}`);
    models.forEach((m, mi) => tasks.forEach((t, ti) => {
      const p = { oracle: 0.5 + 0.2 * mi, fs: 0.3 + 0.1 * mi, memory: 0.2, pg: 0.25, gbrain: 0.4 + 0.2 * mi } as Record<string, number>;
      for (const arm of Object.keys(p)) recs.push({ model: m, arm, task: t, family: 'A', score: { success: ti / tasks.length < p[arm], output_leak: false, context_exposure: false, unsafe_write: false, evidence_cited: [], missed_evidence: [] }, run: { turns: 1 }, total_usd: 0.01, wall_ms: 1000 } as unknown as CellRecord);
    }));
    const a = analyze(recs, { boots: 200 });
    expect(a.capability.m1).toBeCloseTo(0.5);
    expect(a.advantage.m3.value).toBeCloseTo(0.8 - 0.5);
    expect(a.slope.value).toBeGreaterThan(0);
  });
});
