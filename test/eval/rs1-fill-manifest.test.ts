/**
 * RS1 manifest fill (GST-1886): eval/custody/rs1/fill-manifest.ts on synthetic sets in the mint's layout (tiny invented
 * content). It writes ids, paths and hashes only, refills append-only, and refuses files outside the custody root and
 * anything the beam-rs1 loader would refuse. No RS1 byte is used here.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const FILL = join(ROOT, 'eval/custody/rs1/fill-manifest.ts');
const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const writeJson = (path: string, v: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(v)); };
const SECRET = 'invented-sealed-text-marker';

function conversation(set: string, n: number) {
  const dir = join(set, 'conversations', `c${String(n).padStart(3, '0')}`, 'beam', '1');
  writeJson(join(dir, 'chat.json'), [{ batch_number: 1, time_anchor: 'March-01-2024', turns: [[{ role: 'user', id: 0, index: '1,1', content: `${SECRET} ${n}` }, { role: 'assistant', id: 1, index: '1,1', content: 'Noted.' }]] }]);
  writeJson(join(dir, 'probing_questions', 'probing_questions.json'), { information_extraction: [{ question: `${SECRET} question ${n}?`, answer: 'x', source_chat_ids: [0], rubric: ['x'] }] });
}

function custody(slots: number[]) {
  const base = mkdtempSync(join(tmpdir(), 'rs1-fill-'));
  dirs.push(base);
  const set = join(base, 'rs1-custody', 'set');
  for (const n of slots) conversation(set, n);
  return { base, set, out: join(set, 'rs1-manifest.json'), log: join(base, 'access-log.jsonl') };
}

function fill(c: { set: string; out: string; log: string }, kept: string, extra: string[] = [], over: Partial<{ root: string; out: string }> = {}) {
  const r = spawnSync('bun', [FILL, '--root', over.root ?? c.set, '--kept', kept, '--out', over.out ?? c.out, ...extra], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, GBRAIN_EVALS_CUSTODY_LOG: c.log } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('fill-manifest.ts', () => {
  test('fills from the template with every kept slot\'s two files and their hashes, logs each opening, and prints counts and hashes only', () => {
    const c = custody([1, 2, 3]);
    const r = fill(c, 'rs1-001,rs1-003');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const text = readFileSync(c.out, 'utf8');
    const m = JSON.parse(text);
    const template = JSON.parse(readFileSync(join(ROOT, 'eval/decisions/datasets/rs1-manifest.json'), 'utf8'));
    expect(m).toMatchObject({ dataset: template.dataset, generator: template.generator, layout: template.layout, status: 'filled', kept: ['rs1-001', 'rs1-003'] });
    expect(m.filled_at).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(m.files.map((f: { path: string }) => f.path)).toEqual(['conversations/c001/beam/1/chat.json', 'conversations/c001/beam/1/probing_questions/probing_questions.json', 'conversations/c003/beam/1/chat.json', 'conversations/c003/beam/1/probing_questions/probing_questions.json']);
    for (const f of m.files) expect(f.sha256).toBe(sha(readFileSync(join(c.set, f.path))));
    expect(m).not.toHaveProperty('n_final');
    expect(m).not.toHaveProperty('earlier_fills');
    expect(r.out).toBe(`rs1-fill status=filled files=4 kept=2 first=rs1-001 last=rs1-003 n_final=absent earlier_fills=0 manifest_sha256=${sha(text)}\n`);
    expect(text + r.out).not.toContain(SECRET);
    expect(readFileSync(c.log, 'utf8').trim().split('\n')).toHaveLength(2);
    expect(existsSync(`${c.out}.candidate`)).toBe(false);
  });

  test('a refill appends kept ids and files only, keeps n_final once set, and records the earlier fill\'s sha256', () => {
    const c = custody([1, 2, 3, 4]);
    expect(fill(c, 'rs1-001,rs1-002').code).toBe(0);
    const first = sha(readFileSync(c.out));
    expect(fill(c, 'rs1-001,rs1-002,rs1-004', ['--n-final', '20']).code).toBe(0);
    const second = readFileSync(c.out);
    const m = JSON.parse(second.toString());
    expect(m.kept).toEqual(['rs1-001', 'rs1-002', 'rs1-004']);
    expect(m.files).toHaveLength(6);
    expect(m.n_final).toBe(20);
    expect(m.earlier_fills).toEqual([first]);
    const changed = fill(c, 'rs1-001,rs1-002,rs1-004', ['--n-final', '21']);
    expect([changed.code, changed.err]).toEqual([2, 'rs1-fill refused: n_final is 20 in the earlier fill and never changes\n']);
    expect(fill(c, 'rs1-001,rs1-002,rs1-004').code).toBe(0);
    expect(JSON.parse(readFileSync(c.out, 'utf8'))).toMatchObject({ n_final: 20, earlier_fills: [first, sha(second)] });
  });

  test('refuses a kept list that drops, reorders or inserts before an earlier fill\'s ids, and an earlier file whose bytes changed', () => {
    const c = custody([1, 2, 3, 4]);
    expect(fill(c, 'rs1-001,rs1-003').code).toBe(0);
    const before = readFileSync(c.out);
    for (const kept of ['rs1-001', 'rs1-003,rs1-004', 'rs1-001,rs1-002,rs1-003', 'rs1-003,rs1-001']) {
      const r = fill(c, kept);
      expect(r.code).toBe(2);
      expect(r.err).toStartWith('rs1-fill refused: the kept list is append-only');
    }
    writeFileSync(join(c.set, 'conversations/c003/beam/1/chat.json'), '[]');
    const r = fill(c, 'rs1-001,rs1-003,rs1-004');
    expect([r.code, r.err]).toEqual([2, 'rs1-fill refused: a refill only adds files: 1 file(s) the earlier fill pins are missing or changed (first conversations/c003/beam/1/chat.json)\n']);
    expect(readFileSync(c.out)).toEqual(before);
  });

  test('refuses a first fill out of slot order, an id outside the 48 slots and a slot that was never minted', () => {
    const c = custody([1, 2]);
    expect(fill(c, 'rs1-002,rs1-001').err).toContain('DATASET_MISSING beam-rs1: the kept list is not in strictly increasing slot order');
    expect(fill(c, 'rs1-001,rs1-049').code).toBe(2);
    expect(fill(c, 'rs1-001,rs1-005').err).toContain('DATASET_MISSING');
    expect(existsSync(c.out)).toBe(false);
  });

  test('refuses files outside the custody root: a linked chat file, an --out outside the root and a root inside the checkout', () => {
    const c = custody([1, 2]);
    const outside = join(c.base, 'elsewhere.json');
    writeFileSync(outside, readFileSync(join(c.set, 'conversations/c002/beam/1/chat.json')));
    rmSync(join(c.set, 'conversations/c002/beam/1/chat.json'));
    symlinkSync(outside, join(c.set, 'conversations/c002/beam/1/chat.json'));
    expect(fill(c, 'rs1-001,rs1-002').err).toBe('rs1-fill refused: conversations/c002/beam/1/chat.json is a link or resolves outside --root; a filled manifest pins only files inside the custody root\n');
    expect(fill(c, 'rs1-001', [], { out: join(c.base, 'rs1-manifest.json') }).err).toStartWith('rs1-fill refused: --out must sit inside --root');
    expect(fill(c, 'rs1-001', [], { root: join(ROOT, 'eval') }).err).toContain('CUSTODY_MISSING');
    expect(existsSync(c.out)).toBe(false);
  });

  test('refuses what the beam-rs1 loader refuses, writes nothing and prints no sealed text', () => {
    const c = custody([1, 2]);
    writeJson(join(c.set, 'conversations/c002/beam/1/probing_questions/probing_questions.json'), { information_extraction: [{ answer: SECRET }] });
    const r = fill(c, 'rs1-001,rs1-002');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/^rs1-fill (refused|error class=)/);
    expect(r.out + r.err).not.toContain(SECRET);
    expect(existsSync(c.out)).toBe(false);
    expect(existsSync(`${c.out}.candidate`)).toBe(false);
    const noLog = spawnSync('bun', [FILL, '--root', c.set, '--kept', 'rs1-001', '--out', c.out], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, GBRAIN_EVALS_CUSTODY_LOG: '' } });
    expect([noLog.status, noLog.stderr]).toEqual([2, 'rs1-fill refused: GBRAIN_EVALS_CUSTODY_LOG is not set; the check opens each kept conversation and logs it first\n']);
  });
});
