/**
 * BG1 manifest fill (GST-2010): eval/custody/bg1/fill-manifest.ts over set roots copied from one mint.sh --fake set and
 * checked by validate.ts. Keyless: the mint runs in --fake mode, every child process runs with the provider keys blanked,
 * and nothing reaches a provider. The seeds here are test seeds made at run time; the BG1 seed and phrasing are chosen in
 * custody and are never these.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BG1_CUSTODY_MARKER, PUBLIC_PHRASING } from '../../eval/generators/changing-facts-gen.ts';
import { BG1_CONVERSATIONS } from '../../eval/runner/bg1/types.ts';
import { BG1_MANIFEST, bg1Kept, bg1ManifestFiles, verifyBg1Custody, type Bg1Manifest } from '../../eval/runner/memory-qa/corpus.ts';
import type { ValidationReport } from '../../eval/custody/bg1/validate.ts';

const REPO = resolve(import.meta.dir, '../..');
const MINT = join(REPO, 'eval/custody/bg1/mint.sh');
const VALIDATE = join(REPO, 'eval/custody/bg1/validate.ts');
const FILL = join(REPO, 'eval/custody/bg1/fill-manifest.ts');
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const LINE = /^bg1-fill status=filled files=(\d+) kept=(\d+) first=(bg1-\d{3}) last=(bg1-\d{3}) n_final=(\d+|absent) earlier_fills=(\d+) manifest_sha256=([0-9a-f]{64})\n$/;
const LENGTH = ['--target-tokens', '30000', '--tolerance', '0.25'];

const roots: string[] = [];
afterAll(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });

/** A child process with only PATH and HOME, the provider keys blanked, and whatever the test adds. */
function run(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { cwd: REPO, encoding: 'utf8', timeout: 240_000,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', GEMINI_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', BG1_GEMINI_API_KEY: '' } });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

let dir = '', seed = '', phrasing = '', full = '', reports = 0;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'bg1-fill-test-'));
  roots.push(dir);
  seed = join(dir, 'test.bg1-seed');
  phrasing = join(dir, 'test.bg1-phrasing.json');
  writeFileSync(seed, ['bg1', 'seed', 'v1'].join('-') + ':' + sha('fill-manifest') + '\n');
  writeFileSync(phrasing, JSON.stringify({ ...PUBLIC_PHRASING, custody: BG1_CUSTODY_MARKER }));
  chmodSync(seed, 0o600); chmodSync(phrasing, 0o600);
  mkdirSync(join(dir, 'reports'));
  full = join(dir, 'bg1-custody-full');
  const m = run('bash', [MINT, '--out', full, '--seed-file', seed, '--phrasing', phrasing, '--fake', '--count', '32', '--target-tokens', '30000']);
  if (m.code !== 0) throw new Error(`fake mint failed with exit ${m.code}`);
}, 240_000);

/** Copies the given slots (1-based) of the full fake mint into the set root <dir>/bg1-custody-<name>/set. */
function addSlots(name: string, slots: number[]): string {
  const root = join(dir, `bg1-custody-${name}`, 'set');
  for (const s of slots) cpSync(join(full, 'set', 'worlds', BG1_CONVERSATIONS[s - 1]), join(root, 'worlds', BG1_CONVERSATIONS[s - 1]), { recursive: true });
  return root;
}
function validate(root: string, extra: string[] = []): string {
  const report = join(dir, 'reports', `r${++reports}.json`);
  const v = run('bun', [VALIDATE, '--set', root, '--seed-file', seed, '--phrasing', phrasing, '--report', report, ...LENGTH, ...extra]);
  expect(v.code).toBe(0);
  return report;
}
const fill = (root: string, report: string, extra = LENGTH) => run('bun', [FILL, '--root', root, '--report', report, ...extra]);
function refused(r: ReturnType<typeof run>, text: string) {
  expect(r.code).toBe(2);
  expect(r.out).toBe('');
  expect(r.err).toStartWith('bg1-fill refused: ');
  expect(r.err).toContain(text);
  expect(r.err.trim().split('\n')).toHaveLength(1);
}
const manifestOf = (root: string) => JSON.parse(readFileSync(join(root, 'bg1-manifest.json'), 'utf8')) as Bg1Manifest;

describe('fill-manifest.ts', () => {
  test('fills wave A, then refills to 20 kept worlds and to n_final 30, each fill only adding files', () => {
    const committed = readFileSync(join(REPO, BG1_MANIFEST));
    const root = addSlots('a', range(1, 12));
    const out = join(root, 'bg1-manifest.json');
    const first = fill(root, validate(root));
    expect(first.err).toBe('');
    expect(first.code).toBe(0);
    expect(first.out).toMatch(LINE);
    const m1 = manifestOf(root);
    expect(first.out.match(LINE)!.slice(1)).toEqual(['24', '12', 'bg1-001', 'bg1-012', 'absent', '0', sha(readFileSync(out))]);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    const template = JSON.parse(committed.toString('utf8')) as Bg1Manifest;
    expect(template.status).toBe('unfilled');
    expect({ ...m1, filled_at: null }).toEqual({ ...template, status: 'filled', files: bg1ManifestFiles(root, BG1_CONVERSATIONS.slice(0, 12)), filled_at: null, kept: BG1_CONVERSATIONS.slice(0, 12) });
    expect(bg1Kept(m1)).toEqual({ kept: BG1_CONVERSATIONS.slice(0, 12), n_final: null });
    const m1sha = sha(readFileSync(out));

    addSlots('a', range(13, 20));
    const second = fill(root, validate(root));
    expect(second.code).toBe(0);
    expect(second.out.match(LINE)!.slice(1, 7)).toEqual(['40', '20', 'bg1-001', 'bg1-020', 'absent', '1']);
    const m2 = manifestOf(root);
    expect(m2.kept).toEqual(BG1_CONVERSATIONS.slice(0, 20));
    expect(m2.files.slice(0, 24)).toEqual(m1.files);
    expect(m2.earlier_fills).toEqual([m1sha]);
    const m2sha = sha(readFileSync(out));

    addSlots('a', range(21, 32));
    const third = fill(root, validate(root, ['--n-final', '30']));
    expect(third.code).toBe(0);
    expect(third.out.match(LINE)!.slice(1, 7)).toEqual(['60', '30', 'bg1-001', 'bg1-030', '30', '2']);
    const m3 = manifestOf(root);
    expect(m3.kept).toEqual(BG1_CONVERSATIONS.slice(0, 30));
    expect(m3.n_final).toBe(30);
    expect(m3.earlier_fills).toEqual([m1sha, m2sha]);
    expect(m3.files).toEqual(bg1ManifestFiles(root, BG1_CONVERSATIONS.slice(0, 30)));
    expect(existsSync(`${out}.candidate`)).toBe(false);
    expect(readFileSync(join(REPO, BG1_MANIFEST))).toEqual(committed);

    const saved = { source: process.env.GBRAIN_EVALS_BG1_SOURCE, manifest: process.env.GBRAIN_EVALS_BG1_MANIFEST };
    try {
      process.env.GBRAIN_EVALS_BG1_SOURCE = root;
      process.env.GBRAIN_EVALS_BG1_MANIFEST = out;
      expect(verifyBg1Custody(() => {})).toBe(60);
    } finally {
      for (const [k, v] of [['GBRAIN_EVALS_BG1_SOURCE', saved.source], ['GBRAIN_EVALS_BG1_MANIFEST', saved.manifest]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }

    const filled = readFileSync(out);
    refused(fill(root, validate(root, ['--n-final', '31'])), 'n_final is 30 in the earlier fill and never changes');
    const world1 = join(root, 'worlds', 'bg1-001', 'world.json'), original = readFileSync(world1);
    appendFileSync(world1, ' ');
    refused(fill(root, validate(root, ['--n-final', '30'])), 'a refill only adds files: 1 file(s) the earlier fill pins are missing or changed (first worlds/bg1-001/world.json)');
    writeFileSync(world1, original);
    const plan5 = join(root, 'worlds', 'bg1-005', 'plan.json');
    appendFileSync(plan5, ' ');
    refused(fill(root, validate(root, ['--n-final', '30'])), 'a refill only adds worlds: the earlier fill keeps 30 world(s)');
    expect(readFileSync(out)).toEqual(filled);
  }, 240_000);

  test('refuses a kept list that is too short, or an n_final outside 30 to 40, before writing anything', () => {
    const root = addSlots('b', range(1, 11));
    refused(fill(root, validate(root)), 'the kept list is too short: the report keeps 11 world(s), and a fill without n_final needs wave A\'s 12');
    refused(fill(root, validate(root, ['--n-final', '30'])), 'the kept list is too short: the report keeps 11 world(s), and its n_final needs 30');
    addSlots('b', [12]);
    refused(fill(root, validate(root, ['--n-final', '12'])), 'the report\'s n_final 12 is not a whole number from 30 to 40');
    expect(existsSync(join(root, 'bg1-manifest.json'))).toBe(false);
    expect(existsSync(join(root, 'bg1-manifest.json.candidate'))).toBe(false);
  }, 120_000);

  test('refuses files whose hashes differ from the report, before writing anything', () => {
    const root = addSlots('d', range(1, 12));
    const report = validate(root);
    const path = (id: string, f: string) => join(root, 'worlds', id, f);
    const questions = readFileSync(path('bg1-004', 'questions.json'));
    appendFileSync(path('bg1-004', 'questions.json'), ' ');
    refused(fill(root, report), '1 file(s) of kept worlds are missing or differ from the report\'s SHA-256 (first worlds/bg1-004/questions.json)');
    writeFileSync(path('bg1-004', 'questions.json'), questions);
    appendFileSync(path('bg1-007', 'plan.json'), ' ');
    rmSync(path('bg1-009', 'world.json'));
    refused(fill(root, report), '2 file(s) of kept worlds are missing or differ from the report\'s SHA-256 (first worlds/bg1-007/plan.json)');
    expect(existsSync(join(root, 'bg1-manifest.json'))).toBe(false);
  }, 120_000);

  test('refuses a report with an edited kept list, another schema, no file hashes or another length rule', () => {
    const root = addSlots('e', range(1, 12));
    const report = validate(root);
    const edited = (name: string, edit: (r: ValidationReport) => void) => {
      const r = JSON.parse(readFileSync(report, 'utf8')) as ValidationReport;
      edit(r);
      const p = join(dir, 'reports', name);
      writeFileSync(p, JSON.stringify(r));
      return p;
    };
    refused(fill(root, edited('dropped.json', r => { r.kept = r.kept.filter(id => id !== 'bg1-003'); })), 'the kept list is not the report\'s first passing worlds in slot order');
    refused(fill(root, edited('schema.json', r => { r.schema = 'gbrain-evals/rs1-validation/v1'; })), '--report is not a gbrain-evals/bg1-validation/v1 report');
    refused(fill(root, edited('hashless.json', r => { r.worlds[0].files_sha256 = {}; })), '(first worlds/bg1-001/plan.json)');
    refused(fill(root, report, []), 'the report was validated at 30000 tokens within 0.25, not 200000 within 0.15');
    refused(fill(root, join(dir, 'reports', 'absent.json')), '--report is not a readable JSON file');
    expect(existsSync(join(root, 'bg1-manifest.json'))).toBe(false);
  }, 120_000);

  test('refuses a slot the report does not account for, a pinned link, a manifest link and a root inside the checkout', () => {
    const gap = addSlots('g', [1, ...range(3, 13)]);
    refused(fill(gap, validate(gap)), 'the report does not account for bg1-002, below the last kept world');

    const linked = addSlots('l', range(1, 12));
    const world5 = join(linked, 'worlds', 'bg1-005', 'world.json'), elsewhere = join(dir, 'world-elsewhere.json');
    cpSync(world5, elsewhere);
    rmSync(world5);
    symlinkSync(elsewhere, world5);
    refused(fill(linked, validate(linked)), 'worlds/bg1-005/world.json is a link or resolves outside --root');

    const target = addSlots('m', range(1, 12));
    const decoy = join(dir, 'manifest-elsewhere.json');
    writeFileSync(decoy, '{}');
    symlinkSync(decoy, join(target, 'bg1-manifest.json'));
    refused(fill(target, validate(target)), '<root>/bg1-manifest.json is a link');
    expect(readFileSync(decoy, 'utf8')).toBe('{}');

    refused(fill(join(REPO, 'eval'), validate(target)), 'CUSTODY_MISSING bg1: GBRAIN_EVALS_BG1_SOURCE');
  }, 120_000);
});
