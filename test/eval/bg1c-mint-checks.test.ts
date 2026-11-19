/**
 * BG1-C's mint top-up and custody checks (harness item 5; docs/benchmarks/2026-11-19-changing-facts-confirmation-
 * preregistration.md, "The worlds", "A pilot for every row" and run order steps 4 and 5): mint.sh --bg1c validates each
 * slot (validate.ts --slot) and keeps minting until 40 pass, a world that fails validation counts as a dropped world for
 * both stops, slot 96 used up pauses the mint, supply.ts checks Gemini requests per kept world over slots 31 to 35, and
 * bg1c-checks.ts runs the phrasing check over slots 31 to 96 and the seed check with its commitment. Keyless: mint.sh
 * runs in --fake mode, every child process has the provider keys blanked, nothing reaches a provider, and the seeds,
 * phrasing, BG1 set and request logs are synthetic files made at run time outside the checkout.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BG1_CUSTODY_MARKER, buildQuestions, PUBLIC_PHRASING } from '../../eval/generators/changing-facts-gen.ts';
import { sealedPlan } from '../../eval/custody/bg1/render.ts';

const REPO = resolve(import.meta.dir, '../..');
const MINT = join(REPO, 'eval/custody/bg1/mint.sh');
const VALIDATE = join(REPO, 'eval/custody/bg1/validate.ts');
const SUPPLY = join(REPO, 'eval/custody/bg1/supply.ts');
const CHECKS = join(REPO, 'eval/custody/bg1/bg1c-checks.ts');
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const id = (slot: number) => `bg1-${String(slot).padStart(3, '0')}`;
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const SEED_PREFIX = ['bg1', 'seed', 'v1'].join('-') + ':';

const roots: string[] = [];
const scratch = (name: string) => { const d = mkdtempSync(join(tmpdir(), `bg1c-mint-checks-${name}-`)); roots.push(d); return d; };
afterAll(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });

/** A child process with only PATH and HOME, the provider keys blanked. */
function run(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { cwd: REPO, encoding: 'utf8', timeout: 240_000,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', GEMINI_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', BG1_GEMINI_API_KEY: '' } });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}
/** Custody inputs in a fresh directory: an owner-only test seed and phrasing set (the public phrasing with the custody marker). */
function inputs(name: string, phrasing: object = { ...PUBLIC_PHRASING, custody: BG1_CUSTODY_MARKER }) {
  const dir = scratch(name);
  const seed = join(dir, 'test.bg1-seed'), phrasingFile = join(dir, 'test.bg1-phrasing.json');
  const seedLine = SEED_PREFIX + sha(name);
  writeFileSync(seed, seedLine + '\n');
  writeFileSync(phrasingFile, JSON.stringify(phrasing));
  chmodSync(seed, 0o600); chmodSync(phrasingFile, 0o600);
  return { dir, seed, phrasing: phrasingFile, seedLine };
}
const mint = (out: string, i: ReturnType<typeof inputs>, extra: string[]) =>
  run('bash', [MINT, '--out', out, '--seed-file', i.seed, '--phrasing', i.phrasing, '--target-tokens', '30000', '--tolerance', '0.25', ...extra]);
const refusal = (r: ReturnType<typeof run>, text: string) => { expect(r.code).toBe(2); expect(r.out).toBe(''); expect(r.err).toContain(text); };
const record = (out: string, slot: number, status: 'pass' | 'fail') => { mkdirSync(join(out, 'render'), { recursive: true }); writeFileSync(join(out, 'render', `${id(slot)}.validation.json`), JSON.stringify({ world: id(slot), status })); };
const dropped = (out: string, slot: number) => { mkdirSync(join(out, 'render'), { recursive: true }); writeFileSync(join(out, 'render', `${id(slot)}.json`), JSON.stringify({ world: id(slot), status: 'dropped' })); };
const validation = (out: string, slot: number) => JSON.parse(readFileSync(join(out, 'render', `${id(slot)}.validation.json`), 'utf8')) as { status: string; failed: string[]; tokens: number | null };

describe('mint.sh --bg1c keeps minting until 40 worlds pass validation', () => {
  // Value: protects=BG1-C's kept set is the first 40 slots that pass validation, not the first 40 written; fails_when=mint.sh counts a written world that fails validate.ts's gates as kept, stops before 40 pass, or renders past the 40th; why_new=BG1-C harness item 5 (the preregistration's kept set and top-up); seam=mint.sh --bg1c --fake with --fake-break <slot>:length and validate.ts --slot; no_claim=the Gemini claim check or the second validator (fake checks)
  test('a written world that fails the length gate is not kept, and the mint tops up to the 40th passing world', () => {
    const j = inputs('topup');
    const out = join(j.dir, 'bg1-custody-t');
    for (const slot of range(31, 67)) record(out, slot, 'pass');
    const m = mint(out, j, ['--fake', '--bg1c', '--start', '68', '--fake-break', '69:length']);
    expect(m.code).toBe(0);
    expect(m.out).toMatch(/\nbg1-validate slot=68 world=bg1-068 status=pass gates=none tokens=\d+\n/);
    expect(m.out).toMatch(/\nbg1-validate slot=69 world=bg1-069 status=fail gates=length tokens=\d+\n/);
    expect(m.out).toContain('bg1-mint summary=kept mode=fake kept=40 written=4 skipped=0 dropped=0 dropped_earlier=0 last_slot=71 invalid=1\n');
    expect(m.out).not.toContain('slot=72');
    expect(existsSync(join(out, 'set', 'worlds', 'bg1-069', 'world.json'))).toBe(true);
    expect(validation(out, 69)).toMatchObject({ status: 'fail', failed: ['length'] });
    expect(validation(out, 69).tokens).toBeGreaterThan(30000 * 1.25);
    expect([68, 70, 71].map(s => validation(out, s).status)).toEqual(['pass', 'pass', 'pass']);
    expect(statSync(join(out, 'render', 'bg1-069.validation.json')).mode & 0o777).toBe(0o600);
    const again = mint(out, j, ['--fake', '--bg1c', '--start', '68']);
    expect([again.code, again.out]).toEqual([0, 'bg1-mint summary=kept mode=fake kept=40 written=0 skipped=0 dropped=0 dropped_earlier=0 last_slot=67\n']);
  }, 240_000);

  // Value: protects=a world that fails validation counts toward the yield gate and the drop cap, and is never rendered or counted again; fails_when=a systematic validation fault spends through slots 31 to 35 with no pause, or a resumed run re-renders a failed slot; why_new=BG1-C harness item 5 (BG1 Amendment 6: three worlds failing a validation gate stop the mint); seam=mint.sh --bg1c --fake --fake-break <slot>:length; no_claim=a paid render
  test('two worlds failing validation among slots 31 to 35 pause the yield gate, and a resumed run pauses before rendering', () => {
    const j = inputs('invalid-drops');
    const out = join(j.dir, 'bg1-custody-v');
    const m = mint(out, j, ['--fake', '--bg1c', '--count', '5', '--fake-break', '31:length,33:length']);
    expect(m.code).toBe(3);
    expect(m.out).toContain('bg1-mint summary=paused reason=yield_gate mode=fake written=3 skipped=0 dropped=0 last_slot=33 early_drops=2 drops=2 invalid=2\n');
    expect(existsSync(join(out, 'set', 'worlds', 'bg1-034'))).toBe(false);
    const resumed = mint(out, j, ['--fake', '--bg1c']);
    expect([resumed.code, resumed.out]).toEqual([3, 'bg1-mint summary=paused reason=yield_gate mode=fake written=0 skipped=0 dropped=0 last_slot=30 early_drops=2 drops=2\n']);
  }, 240_000);

  // Value: protects=a BG1-C mint that uses up slot 96 with fewer than 40 kept stops for GBEV-3 instead of reporting a finished mint; fails_when=mint.sh exits 0 at slot 96 short of 40 kept, or pauses on a --count run that ends before 96; why_new=BG1-C harness item 5 (slots capped at 96); seam=mint.sh --bg1c --fake over stub records with an acknowledged drop total; no_claim=how GBEV-3 resolves the pause
  test('slot 96 used up with fewer than 40 kept pauses with reason slots_exhausted', () => {
    const j = inputs('exhausted');
    const out = join(j.dir, 'bg1-custody-x');
    for (const slot of range(31, 60)) record(out, slot, 'pass');
    for (const slot of range(61, 94)) dropped(out, slot);
    writeFileSync(join(out, 'render', 'yield-gate-acks.jsonl'), JSON.stringify({ ack: 'a-000000000001', at: '2026-11-19T00:00:00Z', early_drops: 0, drops: 34 }) + '\n');
    const one = mint(out, j, ['--fake', '--bg1c', '--start', '95', '--count', '1']);
    expect(one.code).toBe(0);
    expect(one.out).toContain('bg1-mint summary=mint mode=fake slots=1 written=1 skipped=0 dropped=0 dropped_earlier=0 kept=31\n');
    const last = mint(out, j, ['--fake', '--bg1c', '--start', '95']);
    expect(last.code).toBe(3);
    expect(last.out).toContain('bg1-mint summary=paused reason=slots_exhausted mode=fake kept=32 written=1 skipped=1 dropped=0 dropped_earlier=0 last_slot=96\n');
  }, 240_000);

  test('--tolerance is BG1-C\'s alone and must lie between 0 and 1; validate.ts --slot is BG1-C\'s and needs a written world', () => {
    const j = inputs('flags');
    const out = join(j.dir, 'bg1-custody-f');
    refusal(run('bash', [MINT, '--out', out, '--seed-file', j.seed, '--phrasing', j.phrasing, '--fake', '--tolerance', '0.2', '--count', '1']), '--tolerance sets BG1-C\'s per-slot validation, so it needs --bg1c');
    refusal(mint(out, j, ['--fake', '--bg1c', '--tolerance', '1.5', '--count', '1']), '--tolerance must be a decimal between 0 and 1');
    refusal(run('bash', [MINT, '--dev', '--tolerance', '0.2', '--out', join(j.dir, 'dev-out'), '--fake']), 'so it takes no --tolerance');
    expect(existsSync(out)).toBe(false);
    const set = join(out, 'set');
    const slot = (n: string, extra: string[] = ['--bg1c']) => run('bun', [VALIDATE, ...extra, '--slot', n, '--set', set, '--seed-file', j.seed, '--phrasing', j.phrasing]);
    expect(slot('31', []).err).toContain('--slot is BG1-C\'s check of one minted world (mint.sh --bg1c), so it needs --bg1c');
    expect(slot('30').err).toContain('--slot must be one of BG1-C\'s slots, 31 to 96');
    expect(slot('31')).toMatchObject({ code: 2, err: expect.stringContaining('bg1-031 has no written world to validate') });
  });
});

describe('supply.ts: Gemini requests per kept world over slots 31 to 35 (R111)', () => {
  const lines = (n: number, refused = 0) => [...Array(n - refused).fill({ provider: 'gemini', refused: false, status: 200 }), ...Array(refused).fill({ provider: 'gemini', refused: true, status: 429 })].map(l => JSON.stringify(l)).join('\n') + '\n';
  // Value: protects=the preregistered supply condition (at most 1.5 x 336 Gemini requests per kept world over the first five slots) is measured from the mint's own proxy logs before the mint goes on; fails_when=the check counts refused requests, divides by minted rather than kept worlds, passes over 504, or runs before slots 31 to 35 are resolved; why_new=BG1-C harness item 5 (R111 pilot, condition 3); seam=supply.ts over synthetic request logs and records; no_claim=the real mint's request counts
  test('passes at 504 requests per kept world, fails above it, counts only requests sent upstream, and refuses before slot 35 is resolved', () => {
    const out = join(scratch('supply'), 'bg1-custody-s');
    for (const slot of range(31, 34)) record(out, slot, 'pass');
    const logs = join(out, 'proxy', 'requests');
    mkdirSync(logs, { recursive: true });
    for (const [slot, n] of [[32, 500], [33, 450], [34, 300], [35, 380]]) writeFileSync(join(logs, `${id(slot)}-gemini.jsonl`), lines(n));
    writeFileSync(join(logs, 'bg1-031-gemini.jsonl'), lines(390, 4));
    writeFileSync(join(logs, 'bg1-031-anthropic.jsonl'), lines(900));
    expect(run('bun', [SUPPLY, '--out', out])).toMatchObject({ code: 2, out: '', err: expect.stringContaining('bg1-035 has neither a validation record nor a dropped render record') });
    dropped(out, 35);
    expect(run('bun', [SUPPLY, '--out', out])).toEqual({ code: 0, out: 'bg1-supply slots=31-35 gemini_requests=2016 kept=4 per_kept_world=504.0 limit=504 status=pass\n', err: '' });
    expect(JSON.parse(readFileSync(join(out, 'render', 'supply.json'), 'utf8'))).toMatchObject({ gemini_requests: 2016, kept: 4, per_kept_world: 504, limit: 504, status: 'pass' });
    writeFileSync(join(logs, 'bg1-031-gemini.jsonl'), lines(391, 4));
    expect(run('bun', [SUPPLY, '--out', out])).toMatchObject({ code: 12, out: 'bg1-supply slots=31-35 gemini_requests=2017 kept=4 per_kept_world=504.3 limit=504 status=fail\n' });
    for (const slot of range(31, 34)) record(out, slot, 'fail');
    expect(run('bun', [SUPPLY, '--out', out])).toMatchObject({ code: 12, out: expect.stringContaining('kept=0 per_kept_world=none limit=504 status=fail') });
  });
});

describe('bg1c-checks.ts: the phrasing check and the seed check with its commitment', () => {
  // Value: protects=before BG1-C mints, the custody phrasing is checked and every slot from 31 to 96 plans with it, printing counts only; fails_when=the check skips a slot, accepts a phrasing set without the custody marker or a seed that is not owner-only or sits in a checkout, or prints seed text; why_new=BG1-C harness item 5 (run order step 5: the phrasing check over slots 31 to 96); seam=bg1c-checks.ts phrasing with a test seed and the public phrasing; no_claim=the private phrasing's own templates
  test('plans all 66 BG1-C slots with the custody phrasing and refuses unsafe inputs', () => {
    const j = inputs('phrasing');
    const r = run('bun', [CHECKS, 'phrasing', '--seed-file', j.seed, '--phrasing', j.phrasing]);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const questions = range(31, 96).reduce((n, slot) => n + buildQuestions(sealedPlan(j.seedLine, slot, JSON.parse(readFileSync(j.phrasing, 'utf8'))), JSON.parse(readFileSync(j.phrasing, 'utf8'))).length, 0);
    expect(r.out).toBe(`bg1c-phrasing slots=66 planned=66 failed=0 questions=${questions} status=pass phrasing_sha256=${sha(readFileSync(j.phrasing))}\n`);
    expect(r.out).not.toContain(j.seedLine.slice(SEED_PREFIX.length));
    const plain = inputs('phrasing-public', PUBLIC_PHRASING);
    refusal(run('bun', [CHECKS, 'phrasing', '--seed-file', plain.seed, '--phrasing', plain.phrasing]), 'lacks the custody marker');
    chmodSync(j.seed, 0o644);
    refusal(run('bun', [CHECKS, 'phrasing', '--seed-file', j.seed, '--phrasing', j.phrasing]), 'the seed file must be mode 600 or 400');
    const repo = scratch('in-checkout');
    expect(spawnSync('git', ['init', '-q', repo]).status).toBe(0);
    const inside = inputs('phrasing-inside');
    const seed = join(repo, 'test.bg1-seed');
    writeFileSync(seed, readFileSync(inside.seed)); chmodSync(seed, 0o600);
    refusal(run('bun', [CHECKS, 'phrasing', '--seed-file', seed, '--phrasing', inside.phrasing]), 'must sit outside any git checkout');
  }, 120_000);

  /** A synthetic BG1 set root for slots 1 to 3 from the given custody inputs, and its filled manifest. */
  function bg1Set(i: ReturnType<typeof inputs>) {
    const root = join(i.dir, 'bg1-set'), phrasing = JSON.parse(readFileSync(i.phrasing, 'utf8'));
    const files = range(1, 3).flatMap(slot => {
      mkdirSync(join(root, 'worlds', id(slot)), { recursive: true });
      const questions = JSON.stringify(buildQuestions(sealedPlan(i.seedLine, slot, phrasing), phrasing), null, 1) + '\n';
      writeFileSync(join(root, 'worlds', id(slot), 'questions.json'), questions);
      writeFileSync(join(root, 'worlds', id(slot), 'world.json'), `${id(slot)} placeholder world`);
      return [{ path: `worlds/${id(slot)}/world.json`, sha256: sha(`${id(slot)} placeholder world`) }, { path: `worlds/${id(slot)}/questions.json`, sha256: sha(questions) }];
    });
    const manifest = join(i.dir, 'bg1-manifest.json');
    writeFileSync(manifest, JSON.stringify({ dataset: 'BG1 changing-facts set', status: 'filled', files, kept: range(1, 3).map(id) }));
    return { root, manifest };
  }

  // Value: protects=BG1-C keeps BG1's seed, checked against BG1's filled manifest, and launch amendment A gets a stable commitment whose nonce stays in custody; fails_when=a different seed or a changed BG1 file passes, a failed check writes a nonce or prints a commitment, a rerun changes the commitment, or the nonce or seed is printed; why_new=BG1-C harness item 5 ("The seed is BG1's, and stays fixed"); seam=bg1c-checks.ts seed over a synthetic BG1 set and manifest; no_claim=BG1's real files
  test('re-derives BG1\'s questions from the seed, checks every listed file, and prints a stable commitment without the nonce', () => {
    const j = inputs('seed');
    const s = bg1Set(j);
    const check = (i: ReturnType<typeof inputs>, extra: string[] = []) => run('bun', [CHECKS, 'seed', '--seed-file', i.seed, '--phrasing', i.phrasing, '--bg1-root', s.root, '--bg1-manifest', s.manifest, ...extra]);
    const first = check(j);
    expect(first.err).toBe('');
    expect(first.code).toBe(0);
    const nonceFile = join(j.dir, 'test.bg1c-nonce');
    const nonce = readFileSync(nonceFile, 'utf8').trim();
    expect(nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(nonceFile).mode & 0o777).toBe(0o600);
    const commitment = sha(`gbrain-evals bg1-c seed commitment v1|${j.seedLine}|nonce=${nonce}`);
    expect(first.out).toBe(`bg1c-seed slots=30 questions_listed=3 questions_match=3 questions_mismatch=0 files=6 files_match=6 files_missing=0 files_mismatch=0 status=pass nonce=written commitment_sha256=${commitment} phrasing_sha256=${sha(readFileSync(j.phrasing))}\n`);
    expect(first.out).not.toContain(nonce);
    expect(first.out).not.toContain(j.seedLine.slice(SEED_PREFIX.length));
    expect(check(j).out).toContain(`status=pass nonce=reused commitment_sha256=${commitment} `);

    const other = inputs('seed-other');
    writeFileSync(other.phrasing, readFileSync(j.phrasing));
    const wrong = check(other);
    expect([wrong.code, wrong.out]).toEqual([12, 'bg1c-seed slots=30 questions_listed=3 questions_match=0 questions_mismatch=3 files=6 files_match=6 files_missing=0 files_mismatch=0 status=fail\n']);
    expect(existsSync(join(other.dir, 'test.bg1c-nonce'))).toBe(false);
    writeFileSync(join(s.root, 'worlds', 'bg1-002', 'world.json'), 'edited');
    rmSync(join(s.root, 'worlds', 'bg1-003', 'world.json'));
    expect(check(j)).toMatchObject({ code: 12, out: 'bg1c-seed slots=30 questions_listed=3 questions_match=3 questions_mismatch=0 files=6 files_match=4 files_missing=1 files_mismatch=1 status=fail\n' });
    writeFileSync(s.manifest, JSON.stringify({ dataset: 'BG1 changing-facts set', status: 'unfilled', files: [] }));
    refusal(check(j), 'the manifest is not BG1\'s filled manifest');
    expect(readFileSync(nonceFile, 'utf8').trim()).toBe(nonce);
  }, 120_000);
});
