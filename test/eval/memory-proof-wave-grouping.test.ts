/**
 * Memory proof wave A2: the grouping manifest. T-A2-1 (determinism from the
 * seed, commitments hash-match, the split is write-once) and T-A2-2 (every
 * validation or sealed open appends to the access log).
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Hex } from '../../eval/runner/sealed-confirmation-lib.ts';
import type { PowerInputs } from '../../eval/runner/memory-proof-wave/harness-inputs.ts';
import { assignStratum, buildManifest, checkPrivate, checkPublic, GROUPS, loadManifest, openSplit, PUBLIC_MANIFEST_PATH, splitCommitment, splitCounts, type PublicManifest } from '../../eval/runner/memory-proof-wave/grouping.ts';
import { DEFAULT_INPUTS } from '../../eval/runner/memory-proof-wave-power.ts';

const ROOT = join(import.meta.dir, '../..');
const inputsRaw = readFileSync(join(ROOT, DEFAULT_INPUTS));
const inputs = JSON.parse(inputsRaw.toString('utf8')) as PowerInputs;
const SALT = Buffer.alloc(32, 7);

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'mpw-grouping-'));
  const built = buildManifest(inputs, { path: DEFAULT_INPUTS, sha256: sha256Hex(inputsRaw) }, SALT, '2026-10-05');
  const privatePath = join(dir, 'grouping-private.json');
  writeFileSync(privatePath, built.privateBytes);
  return { dir, privatePath, log: join(dir, 'access-log.jsonl'), ...built };
}

const prereg = (text: string, committed = true) => ({ path: 'docs/benchmarks/x-preregistration.md', bytes: Buffer.from(text), committed });

describe('split rule', () => {
  test('20/20/60 by cluster: 7/7/21 for 35 conversations, 4/4/12 for 20, 2/2/6 for 10', () => {
    expect(splitCounts(35)).toEqual({ dev: 7, validation: 7, sealed: 21 });
    expect(splitCounts(20)).toEqual({ dev: 4, validation: 4, sealed: 12 });
    expect(splitCounts(10)).toEqual({ dev: 2, validation: 2, sealed: 6 });
  });

  test('assignment is deterministic for a salt, changes with the salt, and partitions the clusters', () => {
    const clusters = inputs.datasets['beam/500k'].clusters.map(c => ({ id: c.id, histories: c.histories, questions: c.items.length }));
    const a = assignStratum(SALT, 'beam/500k', 'conversation', clusters);
    const b = assignStratum(Buffer.from(SALT), 'beam/500k', 'conversation', [...clusters].reverse());
    const c = assignStratum(Buffer.alloc(32, 8), 'beam/500k', 'conversation', clusters);
    expect(b.dev).toEqual(a.dev);
    expect(b.sealed).toEqual(a.sealed);
    expect(c.sealed).not.toEqual(a.sealed);
    const all = [...a.dev, ...a.validation, ...a.sealed];
    expect(new Set(all).size).toBe(35);
    expect(all.sort()).toEqual(clusters.map(x => x.id).sort());
  });

  test('PersonaMem is split by persona: each persona\'s histories land in exactly one split', () => {
    const { manifest } = fixture();
    const pm = manifest.groups.flatMap(g => g.strata).find(s => s.stratum === 'personamem/32k')!;
    expect(pm.grouping).toBe('persona');
    expect(pm.clusters.length).toBe(20);
    expect(pm.clusters.reduce((s, c) => s + c.histories.length, 0)).toBe(37);
    const histories = pm.clusters.flatMap(c => c.histories);
    expect(new Set(histories).size).toBe(histories.length);
  });
});

describe('manifest commitments', () => {
  test('a built manifest passes its public and private checks, and the primary group is 14 / 14 / 42', () => {
    const f = fixture();
    expect(checkPublic(f.manifest)).toEqual([]);
    expect(checkPrivate(f.manifest, f.privatePath)).toEqual([]);
    const primary = f.manifest.groups.find(g => g.group === 'primary')!;
    const sum = (k: 'dev' | 'validation' | 'sealed') => primary.strata.reduce((s, x) => s + x[k].count, 0);
    expect([sum('dev'), sum('validation'), sum('sealed')]).toEqual([14, 14, 42]);
    expect(primary.strata.reduce((s, x) => s + x.sealed.questions, 0)).toBe(840);
    expect(f.manifest.groups.map(g => g.group)).toEqual(GROUPS.map(g => g.group));
  });

  test('the public manifest carries commitments, never validation or sealed ids', () => {
    const { manifest } = fixture();
    for (const s of manifest.groups.flatMap(g => g.strata)) {
      expect(Object.keys(s.validation).sort()).toEqual(['commitment', 'count', 'questions']);
      expect(Object.keys(s.sealed).sort()).toEqual(['commitment', 'count', 'questions']);
    }
    expect(JSON.stringify(manifest)).not.toContain(SALT.toString('hex'));
  });

  test('a split commitment verifies with the salt and changes with any id', () => {
    const f = fixture();
    const s = f.manifest.groups[0].strata[0];
    const ids = f.privateFile.strata.find(x => x.stratum === s.stratum)!.sealed;
    expect(splitCommitment(SALT, s.stratum, 'sealed', ids)).toBe(s.sealed.commitment);
    expect(splitCommitment(SALT, s.stratum, 'sealed', [...ids.slice(1), s.dev.ids[0]])).not.toBe(s.sealed.commitment);
    expect(splitCommitment(Buffer.alloc(32, 9), s.stratum, 'sealed', ids)).not.toBe(s.sealed.commitment);
  });

  test('a tampered private file fails its commitment before anything is parsed', () => {
    const f = fixture();
    writeFileSync(f.privatePath, f.privateBytes.toString('utf8').replace(/"sealed": \[\n\s+"(\w+)"/, '"sealed": [\n        "x$1"'));
    expect(() => checkPrivate(f.manifest, f.privatePath)).toThrow(/commitment mismatch/);
  });

  test('a manifest whose dev ids were edited fails the check', () => {
    const f = fixture();
    const m: PublicManifest = JSON.parse(JSON.stringify(f.manifest));
    const s = m.groups[0].strata[0];
    const swap = f.privateFile.strata.find(x => x.stratum === s.stratum)!.sealed[0];
    s.dev.ids = [swap, ...s.dev.ids.slice(1)];
    expect(checkPrivate(m, f.privatePath).some(p => p.includes('dev ids differ'))).toBe(true);
  });
});

describe('opening splits (access log)', () => {
  test('dev opens without the private file or a log', () => {
    const f = fixture();
    const ids = openSplit(f.manifest, { split: 'dev', strata: ['beam/500k'], purpose: '' });
    expect(ids['beam/500k'].length).toBe(7);
    expect(existsSync(f.log)).toBe(false);
  });

  test('validation needs a purpose and the private file, and every open appends one log line', () => {
    const f = fixture();
    expect(() => openSplit(f.manifest, { split: 'validation', strata: ['beam/500k'], purpose: '', privatePath: f.privatePath, accessLogPath: f.log })).toThrow(/purpose/);
    expect(() => openSplit(f.manifest, { split: 'validation', strata: ['beam/500k'], purpose: 'tuning check' })).toThrow(/--private/);
    const a = openSplit(f.manifest, { split: 'validation', strata: ['beam/500k', 'beam/1m'], purpose: 'confirm fix 1', privatePath: f.privatePath, accessLogPath: f.log });
    openSplit(f.manifest, { split: 'validation', strata: ['beam/500k'], purpose: 'confirm fix 2', privatePath: f.privatePath, accessLogPath: f.log });
    expect(a['beam/1m'].length).toBe(7);
    const lines = readFileSync(f.log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(lines.length).toBe(2);
    expect(lines[0]).toMatchObject({ action: 'open', decision_id: null, labels_sha256: f.manifest.private_file.sha256 });
    expect(lines[0].purpose).toContain('confirm fix 1');
  });

  test('sealed needs a decision id and a committed, fully filled preregistration, whose hash is logged', () => {
    const f = fixture();
    const base = { split: 'sealed' as const, strata: ['beam/500k', 'beam/1m'], purpose: 'primary NI test', privatePath: f.privatePath, accessLogPath: f.log };
    expect(() => openSplit(f.manifest, { ...base, preregistration: prereg('done') })).toThrow(/decision-id/);
    expect(() => openSplit(f.manifest, { ...base, decisionId: 'mpw-primary' })).toThrow(/preregistration/);
    expect(() => openSplit(f.manifest, { ...base, decisionId: 'mpw-primary', preregistration: prereg('done', false) })).toThrow(/not committed/);
    expect(() => openSplit(f.manifest, { ...base, decisionId: 'mpw-primary', preregistration: prereg('model: TODO') })).toThrow(/TODO/);
    expect(existsSync(f.log)).toBe(false);
    const ids = openSplit(f.manifest, { ...base, decisionId: 'mpw-primary', preregistration: prereg('all values filled') });
    expect(ids['beam/500k'].length + ids['beam/1m'].length).toBe(42);
    const [line] = readFileSync(f.log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(line).toMatchObject({ action: 'open', decision_id: 'mpw-primary', preregistration_sha256: sha256Hex('all values filled') });
  });
});

describe('committed manifest', () => {
  const path = join(ROOT, PUBLIC_MANIFEST_PATH);
  test('passes the public checks, matches the committed inputs, and the private file is not in the repository', () => {
    const m = loadManifest(path);
    expect(checkPublic(m)).toEqual([]);
    expect(m.inputs.sha256).toBe(sha256Hex(inputsRaw));
    const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
    expect(tracked).not.toContain('grouping-private.json');
    const strata = m.groups.flatMap(g => g.strata);
    expect(strata.map(s => `${s.stratum}:${s.dev.count}/${s.validation.count}/${s.sealed.count}`)).toEqual([
      'beam/500k:7/7/21', 'beam/1m:7/7/21', 'personamem/32k:4/4/12', 'lifebench/en:2/2/6', 'beam/100k:4/4/12',
    ]);
    for (const s of strata) expect(s.queries_file.sha256).toBe(inputs.datasets[s.stratum].queries_file.sha256);
  });
});
