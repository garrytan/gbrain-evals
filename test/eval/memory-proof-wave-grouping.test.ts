/**
 * Memory proof wave A2: the grouping manifest. T-A2-1 (determinism from the
 * seed, commitments hash-match, the split is write-once), T-A2-2 (every
 * validation or sealed open appends to the access log) and the reseal that
 * replaces the validation/sealed partition while dev stays fixed.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Hex } from '../../eval/runner/sealed-confirmation-lib.ts';
import type { PowerInputs } from '../../eval/runner/memory-proof-wave/harness-inputs.ts';
import { assignNonDev, assignStratum, buildManifest, checkPrivate, checkPublic, GROUPS, loadManifest, openSplit, PUBLIC_MANIFEST_PATH, resealManifest, splitCommitment, splitCounts, type PublicManifest } from '../../eval/runner/memory-proof-wave/grouping.ts';
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
  test('a built manifest passes its public and private checks, and the primary group is 18 / 18 / 54', () => {
    const f = fixture();
    expect(checkPublic(f.manifest)).toEqual([]);
    expect(checkPrivate(f.manifest, f.privatePath)).toEqual([]);
    const primary = f.manifest.groups.find(g => g.group === 'primary')!;
    const sum = (k: 'dev' | 'validation' | 'sealed') => primary.strata.reduce((s, x) => s + x[k].count, 0);
    expect([sum('dev'), sum('validation'), sum('sealed')]).toEqual([18, 18, 54]);
    expect(primary.strata.reduce((s, x) => s + x.sealed.questions, 0)).toBe(1080);
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
    const base = { split: 'sealed' as const, strata: ['beam/100k', 'beam/500k', 'beam/1m'], purpose: 'primary NI test', privatePath: f.privatePath, accessLogPath: f.log };
    expect(() => openSplit(f.manifest, { ...base, preregistration: prereg('done') })).toThrow(/decision-id/);
    expect(() => openSplit(f.manifest, { ...base, decisionId: 'mpw-primary' })).toThrow(/preregistration/);
    expect(() => openSplit(f.manifest, { ...base, decisionId: 'mpw-primary', preregistration: prereg('done', false) })).toThrow(/not committed/);
    expect(() => openSplit(f.manifest, { ...base, decisionId: 'mpw-primary', preregistration: prereg('model: TODO') })).toThrow(/TODO/);
    expect(existsSync(f.log)).toBe(false);
    const ids = openSplit(f.manifest, { ...base, decisionId: 'mpw-primary', preregistration: prereg('all values filled') });
    expect(ids['beam/100k'].length + ids['beam/500k'].length + ids['beam/1m'].length).toBe(54);
    const [line] = readFileSync(f.log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(line).toMatchObject({ action: 'open', decision_id: 'mpw-primary', preregistration_sha256: sha256Hex('all values filled') });
  });
});

describe('reseal', () => {
  const NEW_SALT = Buffer.alloc(32, 42);
  function resealed() {
    const f = fixture();
    const r = resealManifest(f.manifest, NEW_SALT, { date: '2026-10-05', reason: 'custody exposure' });
    const newPath = join(f.dir, 'grouping-private-new.json');
    writeFileSync(newPath, r.privateBytes);
    return { f, r, newPath };
  }
  const strataOf = (m: PublicManifest) => m.groups.flatMap(g => g.strata);

  test('dev ids, cluster lists and counts are unchanged; validation and sealed partition the rest', () => {
    const { f, r } = resealed();
    for (const s of strataOf(r.manifest)) {
      const before = strataOf(f.manifest).find(x => x.stratum === s.stratum)!;
      expect(s.dev).toEqual(before.dev);
      expect(s.clusters).toEqual(before.clusters);
      expect([s.validation.count, s.sealed.count]).toEqual([before.validation.count, before.sealed.count]);
      const priv = r.privateFile.strata.find(x => x.stratum === s.stratum)!;
      const all = [...s.dev.ids, ...priv.validation, ...priv.sealed];
      expect(new Set(all).size).toBe(s.clusters.length);
      expect(priv).toMatchObject(assignNonDev(NEW_SALT, s.stratum, s.clusters, s.dev.ids));
    }
    expect(checkPublic(r.manifest)).toEqual([]);
  });

  test('the new private file verifies; the old one and the old salt open nothing', () => {
    const { f, r, newPath } = resealed();
    expect(checkPrivate(r.manifest, newPath)).toEqual([]);
    expect(() => checkPrivate(r.manifest, f.privatePath)).toThrow(/commitment mismatch/);
    expect(() => openSplit(r.manifest, { split: 'validation', strata: ['beam/500k'], purpose: 'x', privatePath: f.privatePath, accessLogPath: f.log })).toThrow(/commitment mismatch/);
    for (const s of strataOf(r.manifest)) {
      const priv = r.privateFile.strata.find(x => x.stratum === s.stratum)!;
      expect(splitCommitment(SALT, s.stratum, 'sealed', priv.sealed)).not.toBe(s.sealed.commitment);
      expect(splitCommitment(SALT, s.stratum, 'validation', priv.validation)).not.toBe(s.validation.commitment);
      const oldOrder = assignNonDev(SALT, s.stratum, s.clusters, s.dev.ids);
      expect(splitCommitment(SALT, s.stratum, 'sealed', oldOrder.sealed)).not.toBe(s.sealed.commitment);
    }
    const changed = strataOf(r.manifest).filter(s => canonical(f.privateFile.strata.find(x => x.stratum === s.stratum)!.sealed) !== canonical(r.privateFile.strata.find(x => x.stratum === s.stratum)!.sealed));
    expect(changed.length).toBeGreaterThan(0);
  });

  test('the reseal entry records the reason, date and every previous commitment', () => {
    const { f, r } = resealed();
    expect(r.manifest.reseals).toHaveLength(1);
    const e = r.manifest.reseals![0];
    expect(e).toMatchObject({ date: '2026-10-05', reason: 'custody exposure', previous_private_file: f.manifest.private_file, previous_salt_sha256: f.manifest.salt_sha256 });
    for (const s of strataOf(f.manifest)) expect(e.previous_commitments[s.stratum]).toEqual({ validation: s.validation.commitment, sealed: s.sealed.commitment });
    expect(r.manifest.salt_sha256).toBe(sha256Hex(NEW_SALT));
  });

  test('a reseal refuses the same salt or an empty reason', () => {
    const f = fixture();
    expect(() => resealManifest(f.manifest, SALT, { date: '2026-10-05', reason: 'x' })).toThrow(/new salt/);
    expect(() => resealManifest(f.manifest, NEW_SALT, { date: '2026-10-05', reason: ' ' })).toThrow(/reason/);
  });
});

const canonical = (xs: string[]) => JSON.stringify([...xs].sort());

describe('committed manifest', () => {
  const path = join(ROOT, PUBLIC_MANIFEST_PATH);
  test('passes the public checks, matches the committed inputs, and the private file is not in the repository', () => {
    const m = loadManifest(path);
    expect(checkPublic(m)).toEqual([]);
    expect(m.inputs.sha256).toBe(sha256Hex(inputsRaw));
    const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
    expect(tracked).not.toContain('grouping-private.json');
    const strata = m.groups.flatMap(g => g.strata);
    expect(m.groups.map(g => g.group)).toEqual(['primary', 'secondary']);
    expect(strata.map(s => `${s.stratum}:${s.dev.count}/${s.validation.count}/${s.sealed.count}`)).toEqual([
      'beam/100k:4/4/12', 'beam/500k:7/7/21', 'beam/1m:7/7/21', 'personamem/32k:4/4/12', 'lifebench/en:2/2/6',
    ]);
    for (const s of strata) expect(s.queries_file.sha256).toBe(inputs.datasets[s.stratum].queries_file.sha256);
  });

  test('was resealed after the custody exposure of the first private file, keeping its commitments on record', () => {
    const m = loadManifest(path);
    expect(m.reseals?.length).toBe(1);
    const e = m.reseals![0];
    expect(e.previous_private_file.sha256).toBe('f67da64c277db517f3624d8a77b1bf02f8222c34ca2419263a12880ef3841d67');
    expect(e.previous_salt_sha256).toBe('d7c382d846e546bef6dde52469d6e21a3dd34abb5534a16c8898d18bd4c4373c');
    expect(e.reason).toContain('custody');
    expect(m.private_file.sha256).not.toBe(e.previous_private_file.sha256);
    for (const s of m.groups.flatMap(g => g.strata)) expect(s.sealed.commitment).not.toBe(e.previous_commitments[s.stratum].sealed);
  });
});
