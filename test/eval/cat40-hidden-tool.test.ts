/**
 * Cat 40 family H (hidden tool), the `wide` scale, strata labels, template
 * sets and custodian mode. Hermetic ($0): scripted agents only.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  generateLadderWorld, worldDigest, validateTemplates, openCustodianTemplates, assertDevWorld, stratumOf, renderDoc,
  LADDER_TEMPLATES_A, TEMPLATE_KEYS, WIDE_FAMILIES, WIDE_LADDER_DIR, WIDE_TASKS_PER_FAMILY, type LadderTemplates, type LadderWorld,
} from '../../eval/generators/model-ladder-gen.ts';
import { FsArm, OracleArm, FileStore, isWriteCall } from '../../eval/runner/cat40/arms.ts';
import { runAgent } from '../../eval/runner/cat40/loop.ts';
import { scoreTask } from '../../eval/runner/cat40/score.ts';
import { analyze } from '../../eval/runner/cat40/analyze.ts';
import { main, type CellRecord } from '../../eval/runner/cat40-model-ladder.ts';

const ROOT = resolve(import.meta.dir, '../..');
/** The pinned gbrain's own takes-fence parser (the one sync uses), so the fence is checked the way gbrain reads it. */
const { parseTakesFence } = await import(join(ROOT, 'node_modules/gbrain/src/core/takes-fence.ts')) as {
  parseTakesFence(body: string): { takes: Array<{ claim: string; holder: string; active: boolean }>; warnings: string[] };
};
const v1 = generateLadderWorld();
const wide = generateLadderWorld(undefined, { scale: 'wide' });
const hTasks = wide.tasks.filter(t => t.family === 'H');
const byId = new Map(wide.docs.map(d => [d.id, d]));
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'cat40-h-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A held-out-shaped template set, written here only to exercise the plumbing. */
const reworded: LadderTemplates = Object.fromEntries(TEMPLATE_KEYS.map(k => [k, `${LADDER_TEMPLATES_A[k]} (reworded)`])) as unknown as LadderTemplates;

describe('wide world', () => {
  test('matches the committed manifest: 120 tasks, 20 per family, 20 hidden-tool', () => {
    const manifest = JSON.parse(readFileSync(join(WIDE_LADDER_DIR, 'manifest.json'), 'utf8'));
    expect(worldDigest(wide)).toBe(manifest.digest);
    expect(wide.scale).toBe('wide');
    expect(wide.templates).toBe('A');
    expect(wide.tasks.length).toBe(WIDE_FAMILIES.length * WIDE_TASKS_PER_FAMILY);
    for (const f of WIDE_FAMILIES) expect(wide.tasks.filter(t => t.family === f).length).toBe(WIDE_TASKS_PER_FAMILY);
    expect(hTasks.length).toBeGreaterThanOrEqual(20);
    expect(wide.tasks.length).toBeGreaterThanOrEqual(100);
  });
  test('every task carries its stratum; v1 tasks stay unlabeled', () => {
    for (const t of wide.tasks) expect(t.stratum).toBe(stratumOf(t.family));
    expect(new Set(wide.tasks.map(t => t.stratum))).toEqual(new Set(['memory-only', 'page-authoring', 'hidden-tool']));
    expect(v1.tasks.some(t => 'stratum' in t)).toBe(false);
    expect('templates' in v1).toBe(false);
  });
  test('referenced docs exist and canaries stay in restricted docs', () => {
    for (const t of wide.tasks) for (const id of [...t.relevant, ...t.gold.evidence, ...(t.protected_docs ?? [])]) expect(byId.has(id)).toBe(true);
    for (const t of wide.tasks.filter(x => x.canaries)) for (const c of t.canaries!) {
      for (const d of wide.docs.filter(x => x.body.includes(c))) expect(d.restricted || (d.derived_from ?? []).some(x => byId.get(x)?.restricted)).toBe(true);
    }
  });
  test('a different seed gives a disjoint set of task accounts', () => {
    const other = generateLadderWorld(20261099, { scale: 'wide' });
    const mine = new Set(wide.tasks.map(t => t.account));
    expect(other.tasks.filter(t => mine.has(t.account)).length).toBeLessThan(other.tasks.length / 4);
    expect(worldDigest(other)).not.toBe(worldDigest(wide));
  });
});

describe('family H', () => {
  test('the gold value is only in the active row of the task forecast takes fence (holder world)', () => {
    for (const t of hTasks) {
      const page = byId.get(t.gold.evidence[0])!;
      expect(page.type).toBe('forecast');
      const { takes, warnings } = parseTakesFence(page.body);
      expect(warnings).toEqual([]);
      const active = takes.filter(x => x.active);
      expect(takes.every(x => x.holder === 'world')).toBe(true);
      expect(active.some(x => t.gold.answer!.some(a => x.claim.includes(a)))).toBe(true);
      for (const w of t.gold.wrong ?? []) expect(active.some(x => x.claim.includes(w))).toBe(false);
      const standalone = (body: string, v: string) => new RegExp(`(^|[^0-9A-Za-z$,.-])${v.replace(/[$.]/g, m => `\\${m}`)}($|[^0-9A-Za-z,])`).test(body);
      const outside = wide.docs.filter(d => d.id !== page.id && t.gold.answer!.some(a => standalone(d.body, a)));
      expect(outside.map(d => d.id)).toEqual([]);
    }
  });
  test('revised forecasts leave the superseded value struck in the fence and quoted in an email', () => {
    const revised = hTasks.filter(t => t.variant.endsWith('_revised'));
    expect(revised.length).toBeGreaterThanOrEqual(8);
    for (const t of revised) {
      const { takes } = parseTakesFence(byId.get(t.gold.evidence[0])!.body);
      const stale = takes.find(x => !x.active)!;
      expect(t.gold.wrong!.some(w => stale.claim.includes(w))).toBe(true);
      const mail = t.relevant.map(id => byId.get(id)!).find(d => d.type === 'email')!;
      expect(t.gold.wrong!.some(w => mail.body.includes(w))).toBe(true);
    }
  });
  test('the oracle gets the fence, and a file-arm agent that reads it passes', async () => {
    const task = hTasks.find(t => t.variant.endsWith('_revised'))!;
    expect(OracleArm.evidence(wide, task)).toContain('gbrain:takes:begin');
    const arm = new FsArm('fs', FileStore.fromWorld(wide));
    const page = task.gold.evidence[0];
    const run = await runAgent({ model: 'scripted', system: '', user: task.question, arm, scripted: h => h.length === 0
      ? { name: 'read_file', args: { path: `${page}.md` } }
      : { name: 'submit_answer', args: { answer: task.gold.answer![0], sources: [page] } } });
    expect(run.tools[0].result).toContain(task.gold.answer![0]);
    const s = scoreTask(task, run, { isWrite: (n, a) => isWriteCall(arm, n, a) });
    expect(s.success).toBe(true);
    expect(s.missed_evidence).toEqual([]);
  });
  test('answering the superseded value from the email fails as a wrong value', async () => {
    const task = hTasks.find(t => t.variant.endsWith('_revised'))!;
    const stale = task.gold.wrong!.find(w => task.relevant.some(id => byId.get(id)!.type === 'email' && byId.get(id)!.body.includes(w)))!;
    const run = await runAgent({ model: 'scripted', system: '', user: task.question, arm: new OracleArm(), scripted: () => ({ name: 'submit_answer', args: { answer: stale, sources: [] } }) });
    const s = scoreTask(task, run, { isWrite: () => false });
    expect(s.success).toBe(false);
    expect(s.said_wrong).toBe(true);
  });
  test('dollar forecasts accept the value with or without the dollar sign', async () => {
    const task = hTasks.find(t => t.variant.startsWith('arr_'))!;
    for (const answer of task.gold.answer!) {
      const run = await runAgent({ model: 'scripted', system: '', user: '', arm: new OracleArm(), scripted: () => ({ name: 'submit_answer', args: { answer: `${answer} ARR`, sources: [] } }) });
      expect(scoreTask(task, run, { isWrite: () => false }).success).toBe(true);
    }
  });
});

describe('templates', () => {
  test('set A reproduces the v1 world; a reworded set changes only wording', () => {
    expect(worldDigest(generateLadderWorld(undefined, { templates: 'A' }))).toBe(worldDigest(v1));
    const sealed = generateLadderWorld(undefined, { scale: 'wide', sealedTemplates: { id: 'test', templates: reworded } });
    expect(sealed.templates).toBe('sealed:test');
    expect(sealed.tasks.map(t => t.question).every(q => q.endsWith('(reworded)'))).toBe(true);
    expect(sealed.tasks.map(t => t.gold)).toEqual(wide.tasks.map(t => t.gold));
  });
  test('validation names what is wrong', () => {
    expect(() => validateTemplates({ ...LADDER_TEMPLATES_A, b_as_of: 'Who owned {account}?' })).toThrow('b_as_of lacks {date}');
    expect(() => validateTemplates({ ...LADDER_TEMPLATES_A, h_claim_arr: '{account} | {value}' })).toThrow('break the takes table');
    const { e_brief: _, ...missing } = LADDER_TEMPLATES_A;
    expect(() => validateTemplates(missing)).toThrow('e_brief missing');
    expect(() => validateTemplates({ ...LADDER_TEMPLATES_A, extra: 'x' })).toThrow('unknown keys extra');
  });
  test('a non-dev template name is refused', () => {
    expect(() => generateLadderWorld(undefined, { templates: 'B' })).toThrow('not a development set');
  });
});

describe('custodian mode', () => {
  const custody = () => {
    const d = tmp();
    const file = join(d, 'templates.json');
    writeFileSync(file, JSON.stringify({ id: 'test', templates: reworded }));
    return { d, file };
  };
  test('logs the access beside the file and returns only its hash with the templates', () => {
    const { d, file } = custody();
    const t = openCustodianTemplates({ file, decisionId: 'p8-test', purpose: 'unit test' });
    const log = readFileSync(join(d, 'access-log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ action: 'open', decision_id: 'p8-test', purpose: 'unit test', labels_sha256: t.sha256 });
    expect(t.id).toBe('test');
  });
  test('refuses without a decision id and purpose, before reading or logging', () => {
    const { d, file } = custody();
    expect(() => openCustodianTemplates({ file, purpose: 'x' })).toThrow('--decision-id and --purpose');
    expect(existsSync(join(d, 'access-log.jsonl'))).toBe(false);
  });
  test('refuses a templates file inside the repository', () => {
    expect(() => openCustodianTemplates({ file: join(ROOT, 'package.json'), decisionId: 'x', purpose: 'x' })).toThrow('inside the repository');
  });
  test('dev mode refuses non-dev seeds and non-dev template names', () => {
    expect(() => assertDevWorld(20261099, undefined)).toThrow('held-out seeds belong to the custodian');
    expect(() => assertDevWorld(20261002, 'sealed:test')).toThrow('not a development set');
    expect(() => assertDevWorld(20261002, 'A')).not.toThrow();
  });
  test('generator CLI: dev refuses a held-out seed; custodian writes only under --custodian-out outside the repo', () => {
    const gen = (args: string[]) => execFileSync('bun', ['eval/generators/model-ladder-gen.ts', ...args], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
    expect(() => gen(['--scale', 'wide', '--seed', '20261099', '--out', tmp()])).toThrow('held-out seeds belong to the custodian');
    const { d, file } = custody();
    const custodian = ['--scale', 'wide', '--seed', '20261099', '--world-templates-file', file, '--decision-id', 'p8-test', '--purpose', 'unit test'];
    expect(() => gen([...custodian, '--custodian-out', join(ROOT, 'eval/data/should-not-exist')])).toThrow('inside the repository');
    expect(existsSync(join(ROOT, 'eval/data/should-not-exist'))).toBe(false);
    const out = join(d, 'world');
    const printed = JSON.parse(gen([...custodian, '--custodian-out', out]).trim());
    const w = JSON.parse(readFileSync(join(out, 'world.json'), 'utf8')) as LadderWorld;
    expect(w.seed).toBe(20261099);
    expect(w.templates).toBe('sealed:test');
    expect(printed.digest).toBe(worldDigest(w));
    expect(JSON.stringify(printed)).not.toContain('reworded');
    const manifest = readFileSync(join(out, 'manifest.json'), 'utf8');
    expect(manifest).not.toContain(file);
    expect(readFileSync(join(d, 'access-log.jsonl'), 'utf8').trim().split('\n').length).toBe(1);
  });
  test('runner: dev mode refuses a held-out world; custodian mode verifies it and records only the file hash', async () => {
    const { d, file } = custody();
    const sealed = generateLadderWorld(20261099, { scale: 'wide', sealedTemplates: { id: 'test', templates: reworded } });
    const worldPath = join(d, 'world.json');
    writeFileSync(worldPath, JSON.stringify(sealed));
    await expect(main(['--scripted', '--arms', 'fs', '--families', 'H', '--world', worldPath, '--out', tmp()])).rejects.toThrow('held-out seeds belong to the custodian');
    const flags = ['--scripted', '--arms', 'fs,memory,oracle', '--families', 'H', '--world', worldPath, '--world-templates-file', file, '--decision-id', 'p8-test', '--purpose', 'unit test'];
    await expect(main([...flags, '--out', join(ROOT, 'eval/reports/cat40/should-not-exist')])).rejects.toThrow('outside the repository');
    const out = tmp();
    await main([...flags, '--out', out]);
    const receipt = JSON.parse(readFileSync(join(out, readdirSync(out).find(f => f.startsWith('receipt-'))!), 'utf8'));
    expect(receipt.world.templates).toBe('sealed:test');
    expect(receipt.world.templates_file_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.world.strata['hidden-tool']).toBe(20);
    expect(JSON.stringify(receipt)).not.toContain('(reworded)');
    const recs = readFileSync(join(out, 'results.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l) as CellRecord);
    expect(recs).toHaveLength(60);
    expect(recs.every(r => r.stratum === 'hidden-tool')).toBe(true);
  });
  test('runner: --gbrain and --gbrain-repo together are refused', async () => {
    await expect(main(['--scripted', '--arms', 'fs', '--tasks', 'A01', '--gbrain', `${ROOT}@HEAD`, '--gbrain-repo', ROOT, '--out', tmp()])).rejects.toThrow('not both');
  });
});

describe('analysis by stratum', () => {
  test('success rates split into memory-only, page-authoring and hidden-tool', () => {
    const recs = ['A01', 'F01', 'H01', 'H02'].map((task, i) => ({
      model: 'm', arm: 'gbrain', task, family: task[0], stratum: stratumOf(task[0] as 'A'), score: { success: i !== 3, output_leak: false, context_exposure: false, unsafe_write: false, evidence_cited: [], missed_evidence: [] }, run: { turns: 1 }, total_usd: 0, wall_ms: 1,
    })) as unknown as CellRecord[];
    const a = analyze(recs, { boots: 10 });
    expect(a.by_stratum['hidden-tool'].m.gbrain).toBeCloseTo(0.5);
    expect(a.by_stratum['memory-only'].m.gbrain).toBe(1);
    expect(a.by_stratum['page-authoring'].m.gbrain).toBe(1);
  });
});

test('rendered forecast pages keep the fence verbatim for the file arms', () => {
  const page = byId.get(hTasks[0].gold.evidence[0])!;
  expect(renderDoc(page)).toContain('<!--- gbrain:takes:end -->');
});
