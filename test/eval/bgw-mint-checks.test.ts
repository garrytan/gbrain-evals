/**
 * Set W's mint top-up and custody checks (the weekly outcome line; docs/benchmarks/2026-11-23-weekly-outcome-line-
 * preregistration.md, "The worlds", "Custody and exposure" and "Pilots"): mint.sh --bgw validates each slot and keeps
 * minting until 34 pass, a world that fails validation counts as a dropped world for both stops, supply.ts checks Gemini
 * requests per kept world over the batch's first five slots, and bgw-checks.ts runs the phrasing check over a batch, the
 * seed check that keeps Set W's seed and phrasing apart from BG1's and prints the seed commitment, and the batch check
 * that holds each batch to its committed files and to starting where the batch before it ended. Keyless: mint.sh runs in
 * --fake mode, every child process has the provider keys blanked, nothing reaches a provider, and the seeds, phrasing and
 * request logs are synthetic files made at run time outside the checkout.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BG1_CUSTODY_MARKER, buildQuestions, PUBLIC_PHRASING } from '../../eval/generators/changing-facts-gen.ts';
import { batchCheck, bgwBatchEnd } from '../../eval/custody/bg1/bgw-checks.ts';
import { sealedPlan } from '../../eval/custody/bg1/render.ts';
import { bgwBatchDataset, bgwBatchIds, bgwBatchManifest } from '../../eval/runner/bg1/types.ts';

const REPO = resolve(import.meta.dir, '../..');
const MINT = join(REPO, 'eval/custody/bg1/mint.sh');
const VALIDATE = join(REPO, 'eval/custody/bg1/validate.ts');
const SUPPLY = join(REPO, 'eval/custody/bg1/supply.ts');
const CHECKS = join(REPO, 'eval/custody/bg1/bgw-checks.ts');
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const id = (slot: number) => `bgw-${slot}`;
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const BATCH = ['--bgw', '--batch', '1001'];
const BATCH_LINE = 'bgw-batch batch=bgw-1001 set=W1 slots=1001-1056 previous=none status=pass\n';

const roots: string[] = [];
const scratch = (name: string) => { const d = mkdtempSync(join(tmpdir(), `bgw-mint-checks-${name}-`)); roots.push(d); return d; };
afterAll(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });

/** A child process with only PATH and HOME, the provider keys blanked. */
function run(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { cwd: REPO, encoding: 'utf8', timeout: 240_000,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', GEMINI_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', BG1_GEMINI_API_KEY: '' } });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}
const custodyPhrasing = { ...PUBLIC_PHRASING, custody: BG1_CUSTODY_MARKER };
/** Every template string with a prefix: a phrasing set that shares no template with the public one, its placeholders unchanged. */
const reworded = (v: unknown): unknown => (typeof v === 'string' ? `Note: ${v}` : Array.isArray(v) ? v.map(reworded) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, reworded(x)])) : v);
/** Custody inputs of one kind in a fresh directory: an owner-only test seed and phrasing set. */
function inputs(name: string, kind: 'bgw' | 'bg1' = 'bgw', phrasing: object = custodyPhrasing, hex = sha(name)) {
  const dir = scratch(name);
  const seed = join(dir, `test.${kind}-seed`), phrasingFile = join(dir, `test.${kind}-phrasing.json`);
  const seedLine = [kind, 'seed', 'v1'].join('-') + ':' + hex;
  writeFileSync(seed, seedLine + '\n');
  writeFileSync(phrasingFile, JSON.stringify(phrasing));
  chmodSync(seed, 0o600); chmodSync(phrasingFile, 0o600);
  return { dir, seed, phrasing: phrasingFile, seedLine, hex };
}
const mint = (out: string, i: ReturnType<typeof inputs>, extra: string[]) =>
  run('bash', [MINT, '--out', out, '--seed-file', i.seed, '--phrasing', i.phrasing, '--target-tokens', '30000', '--tolerance', '0.25', ...BATCH, ...extra]);
const refusal = (r: ReturnType<typeof run>, text: string) => { expect(r.code).toBe(2); expect(r.out).toBe(''); expect(r.err).toContain(text); };
const record = (out: string, slot: number, status: 'pass' | 'fail') => { mkdirSync(join(out, 'render'), { recursive: true }); writeFileSync(join(out, 'render', `${id(slot)}.validation.json`), JSON.stringify({ world: id(slot), status })); };
const dropped = (out: string, slot: number) => { mkdirSync(join(out, 'render'), { recursive: true }); writeFileSync(join(out, 'render', `${id(slot)}.json`), JSON.stringify({ world: id(slot), status: 'dropped' })); };
const validation = (out: string, slot: number) => JSON.parse(readFileSync(join(out, 'render', `${id(slot)}.validation.json`), 'utf8')) as { status: string; failed: string[]; tokens: number | null };

describe('mint.sh --bgw keeps minting until 34 worlds pass validation', () => {
  // Value: protects=a batch's kept set is its first 34 slots that pass validation, not the first 34 written; fails_when=mint.sh counts a Set W world that fails validate.ts's gates as kept, stops before 34 pass, or renders past the 34th; why_new=weekly-line preregistration "Minting" (the first kept worlds by BG1-C's validation rules); seam=mint.sh --bgw --fake with --fake-break <slot>:length and validate.ts --bgw --slot; no_claim=the Gemini claim check or the second validator (fake checks)
  test('a written world that fails the length gate is not kept, and the mint tops up to the 34th passing world', () => {
    const j = inputs('topup');
    const out = join(j.dir, 'bgw-custody-t');
    for (const slot of range(1001, 1031)) record(out, slot, 'pass');
    const m = mint(out, j, ['--start', '1032', '--fake', '--fake-break', '1033:length']);
    expect(m.code).toBe(0);
    expect(m.out).toMatch(/\nbg1-validate slot=1032 world=bgw-1032 status=pass gates=none tokens=\d+ controls_dropped=0\n/);
    expect(m.out).toMatch(/\nbg1-validate slot=1033 world=bgw-1033 status=fail gates=length tokens=\d+ controls_dropped=0\n/);
    expect(m.out).toContain('bg1-mint summary=kept mode=fake kept=34 written=4 skipped=0 dropped=0 dropped_earlier=0 last_slot=1035 invalid=1\n');
    expect(m.out).not.toContain('slot=1036');
    expect(validation(out, 1033)).toMatchObject({ status: 'fail', failed: ['length'] });
    expect(statSync(join(out, 'render', 'bgw-1033.validation.json')).mode & 0o777).toBe(0o600);
    expect(bgwBatchEnd(out, 1001)).toBe(1035);
  }, 240_000);

  // Value: protects=a Set W world that fails validation counts toward the batch's yield gate, and a resumed run pauses before rendering; fails_when=a systematic validation fault spends through the batch's first five slots with no pause; why_new=weekly-line preregistration "Minting" (BG1-C's drop rules); seam=mint.sh --bgw --fake --fake-break <slot>:length; no_claim=a paid render
  test('two worlds failing validation among slots 1001 to 1005 pause the yield gate', () => {
    const j = inputs('invalid-drops');
    const out = join(j.dir, 'bgw-custody-v');
    const m = mint(out, j, ['--count', '5', '--fake', '--fake-break', '1001:length,1003:length']);
    expect(m.code).toBe(3);
    expect(m.out).toContain('bg1-mint summary=paused reason=yield_gate mode=fake written=3 skipped=0 dropped=0 last_slot=1003 early_drops=2 drops=2 invalid=2\n');
    expect(existsSync(join(out, 'set', 'worlds', 'bgw-1004'))).toBe(false);
    const resumed = mint(out, j, ['--fake']);
    expect([resumed.code, resumed.out]).toEqual([3, BATCH_LINE + 'bg1-mint summary=paused reason=yield_gate mode=fake written=0 skipped=0 dropped=0 last_slot=1000 early_drops=2 drops=2\n']);
  }, 240_000);

  test('validate.ts --slot takes --bgw with its batch, only that batch\'s slots and a written world', () => {
    const j = inputs('slot');
    const set = join(j.dir, 'bgw-custody-s', 'set');
    const slot = (n: string, extra: string[]) => run('bun', [VALIDATE, ...extra, '--slot', n, '--set', set, '--seed-file', j.seed, '--phrasing', j.phrasing]);
    expect(slot('1001', ['--bgw']).err).toContain('--bgw needs --batch <first slot>');
    expect(slot('1001', []).err).toContain('or Set W\'s (mint.sh --bgw), which needs --bgw --batch <first slot>');
    expect(slot('1057', BATCH).err).toContain('--slot must be one of batch bgw-1001\'s slots, 1001 to 1056');
    expect(slot('1001', [...BATCH, '--bg1c']).err).toContain('--bgw and --bg1c name two different sealed sets');
    expect(slot('1001', BATCH)).toMatchObject({ code: 2, err: expect.stringContaining('bgw-1001 has no written world to validate') });
  });
});

describe('supply.ts on a Set W batch\'s first five slots (R111)', () => {
  // Value: protects=each batch's mint stops for GBEV-3 once its first five slots used more than 504 Gemini requests per kept world, before its sixth slot spends, until an approval is recorded; fails_when=mint.sh --bgw never runs the check, checks BG1-C's slots, or renders slot 1006 after it fails; why_new=weekly-line preregistration "Minting" (BG1-C's validation and drop rules) and R111; seam=mint.sh --bgw --fake over synthetic Gemini request logs, and supply.ts --bgw; no_claim=the real mint's request counts
  test('over the limit pauses the batch until an approval is recorded; the check reads the batch\'s own slots', () => {
    const j = inputs('supply');
    const out = join(j.dir, 'bgw-custody-o');
    mkdirSync(join(out, 'proxy', 'requests'), { recursive: true });
    for (const slot of range(1001, 1005)) writeFileSync(join(out, 'proxy', 'requests', `${id(slot)}-gemini.jsonl`), '{"refused":false}\n'.repeat(505));
    const paused = mint(out, j, ['--count', '6', '--fake']);
    expect(paused.code).toBe(3);
    expect(paused.out).toContain('bg1-supply slots=1001-1005 gemini_requests=2525 kept=5 per_kept_world=505.0 limit=504 status=fail\n');
    expect(paused.out).toContain('bg1-mint summary=paused reason=supply mode=fake written=5 skipped=0 dropped=0 dropped_earlier=0 last_slot=1005\n');
    expect(existsSync(join(out, 'set', 'worlds', 'bgw-1006'))).toBe(false);
    const acked = mint(out, j, ['--start', '1006', '--count', '1', '--supply-ack', 'a-0123456789ab', '--fake']);
    expect(acked.code).toBe(0);
    expect(acked.out).toContain('bg1-mint supply=acked ack=a-0123456789ab\n');
    expect(existsSync(join(out, 'set', 'worlds', 'bgw-1006', 'world.json'))).toBe(true);
    expect(mint(join(j.dir, 'bgw-custody-n'), j, ['--start', '1006', '--count', '1', '--fake'])).toMatchObject({ code: 2, out: BATCH_LINE, err: expect.stringContaining('slots 1001 to 1005 are not all resolved') });
    expect(run('bun', [SUPPLY, '--bgw', '--out', out])).toMatchObject({ code: 2, err: expect.stringContaining('usage: [--bgw --batch <first slot>]') });
    expect(run('bun', [SUPPLY, ...BATCH, '--out', out])).toMatchObject({ code: 12, out: 'bg1-supply slots=1001-1005 gemini_requests=2525 kept=5 per_kept_world=505.0 limit=504 status=fail\n' });
    expect(run('bun', [SUPPLY, '--out', out])).toMatchObject({ code: 2, err: expect.stringContaining('slots 31 to 35 are not all resolved') });
  }, 240_000);
});

describe('bgw-checks.ts: phrasing, seed and batch', () => {
  // Value: protects=before a batch mints, Set W's phrasing is checked and every slot of the batch plans with it, printing counts only; fails_when=the check skips a slot, takes BG1's seed or phrasing files, or prints seed text; why_new=weekly-line preregistration "A new seed and a new phrasing set"; seam=bgw-checks.ts phrasing with a test seed; no_claim=the private phrasing's own templates
  test('plans all 56 slots of a batch with Set W\'s seed and phrasing and refuses BG1\'s files', () => {
    const j = inputs('phrasing');
    const r = run('bun', [CHECKS, 'phrasing', '--seed-file', j.seed, '--phrasing', j.phrasing]);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const questions = range(1001, 1056).reduce((n, slot) => n + buildQuestions(sealedPlan(j.seedLine, slot, custodyPhrasing, 'bgw'), custodyPhrasing).length, 0);
    expect(r.out).toBe(`bgw-phrasing batch=bgw-1001 slots=56 planned=56 failed=0 questions=${questions} status=pass phrasing_sha256=${sha(readFileSync(j.phrasing))}\n`);
    expect(r.out).not.toContain(j.hex);
    const bg1 = inputs('phrasing-bg1', 'bg1');
    refusal(run('bun', [CHECKS, 'phrasing', '--seed-file', bg1.seed, '--phrasing', j.phrasing]), 'the seed file must be named *.bgw-seed');
    refusal(run('bun', [CHECKS, 'phrasing', '--seed-file', j.seed, '--phrasing', bg1.phrasing]), 'the phrasing file must be named *.bgw-phrasing.json');
    refusal(run('bun', [CHECKS, 'phrasing', '--seed-file', j.seed, '--phrasing', j.phrasing, '--batch', '1950']), 'would run to slot 2005');
    expect(() => sealedPlan(bg1.seedLine, 1001, custodyPhrasing, 'bgw')).toThrow('a Set W plan needs a bgw-seed-v1 line');
    chmodSync(j.seed, 0o644);
    refusal(run('bun', [CHECKS, 'phrasing', '--seed-file', j.seed, '--phrasing', j.phrasing]), 'the seed file must be mode 600 or 400');
  }, 120_000);

  // Value: protects=Set W never reuses BG1's seed or private phrasing, and launch amendment A gets a stable seed commitment in the preregistration's form whose nonce stays in custody; fails_when=a Set W seed holding BG1's digits or a phrasing sharing a BG1 template passes, a failed check writes a nonce or prints a commitment, a rerun changes the commitment, or the nonce or seed is printed; why_new=weekly-line preregistration "A new seed and a new phrasing set" (the commitment's exact form); seam=bgw-checks.ts seed; no_claim=the custody files themselves
  test('keeps Set W\'s seed and phrasing apart from BG1\'s and prints a stable commitment without the nonce', () => {
    const bg1 = inputs('seed-bg1', 'bg1', { ...(reworded(PUBLIC_PHRASING) as object), custody: BG1_CUSTODY_MARKER });
    const j = inputs('seed');
    const check = (i: ReturnType<typeof inputs>, extra: string[] = ['--bg1-seed-file', bg1.seed, '--bg1-phrasing', bg1.phrasing]) => run('bun', [CHECKS, 'seed', '--seed-file', i.seed, '--phrasing', i.phrasing, ...extra]);
    const first = check(j);
    expect(first.err).toBe('');
    expect(first.code).toBe(0);
    const nonceFile = join(j.dir, 'test.bgw-nonce');
    const nonce = readFileSync(nonceFile, 'utf8').trim();
    expect(nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(nonceFile).mode & 0o777).toBe(0o600);
    const commitment = sha(`gbrain-evals weekly-line seed commitment v1|${j.seedLine}|nonce=${nonce}`);
    expect(first.out).toBe(`bgw-seed set=W1 slots=999 seed_distinct=pass slot_seed_collisions=0 shared_templates=0 status=pass nonce=written commitment_sha256=${commitment} phrasing_sha256=${sha(readFileSync(j.phrasing))}\n`);
    expect(first.out).not.toContain(nonce);
    expect(first.out).not.toContain(j.hex);
    expect(check(j).out).toContain(`status=pass nonce=reused commitment_sha256=${commitment} `);
    expect(readFileSync(nonceFile, 'utf8').trim()).toBe(nonce);

    const same = inputs('seed-same', 'bgw', custodyPhrasing, bg1.hex);
    expect(check(same)).toMatchObject({ code: 12, out: 'bgw-seed set=W1 slots=999 seed_distinct=fail slot_seed_collisions=0 shared_templates=0 status=fail\n' });
    expect(existsSync(join(same.dir, 'test.bgw-nonce'))).toBe(false);
    const reused = inputs('seed-phrasing', 'bgw', JSON.parse(readFileSync(bg1.phrasing, 'utf8')));
    const r = check(reused);
    expect(r.code).toBe(12);
    expect(r.out).toMatch(/^bgw-seed set=W1 slots=999 seed_distinct=pass slot_seed_collisions=0 shared_templates=[1-9]\d* status=fail\n$/);
    expect(existsSync(join(reused.dir, 'test.bgw-nonce'))).toBe(false);
    refusal(check(j, []), 'seed needs BG1\'s seed and private phrasing (--bg1-seed-file and --bg1-phrasing)');
    refusal(check(j, ['--bg1-seed-file', j.seed, '--bg1-phrasing', bg1.phrasing]), 'the seed file must be named *.bg1-seed');
  }, 120_000);

  /** A throwaway checkout holding committed templates and split entries for the given batches. */
  function repoWith(batches: number[]) {
    const repo = scratch('repo');
    mkdirSync(join(repo, 'eval/decisions/datasets'), { recursive: true });
    mkdirSync(join(repo, 'eval/decisions/splits'), { recursive: true });
    for (const b of batches) writeFileSync(join(repo, bgwBatchManifest(b)), JSON.stringify({ dataset: bgwBatchDataset(b), status: 'unfilled', files: [] }));
    writeFileSync(join(repo, 'eval/decisions/splits/bgw.json'), JSON.stringify({ benchmark: 'bgw', sealed: [...new Set(batches.flatMap(bgwBatchIds))] }));
    return repo;
  }
  /** A previous batch's custody --out: its batch.json and the given records. */
  function previous(first: number, pass: number[], drops: number[] = [], set = 'W1') {
    const out = join(scratch('prev'), `bgw-custody-${first}`);
    mkdirSync(join(out, 'render'), { recursive: true });
    writeFileSync(join(out, 'batch.json'), JSON.stringify({ set, batch: id(first) }) + '\n');
    for (const s of pass) record(out, s, 'pass');
    for (const s of drops) dropped(out, s);
    return out;
  }

  // Value: protects=a batch starts one slot past where the previous batch of its seed set ended, only with its manifest template and split entries committed; fails_when=a batch skips or reuses slots, starts while the previous batch is unfinished, follows a batch of another seed set, or mints with nothing committed; why_new=weekly-line harness item 2 (a batch starts where the previous batch's slots ended); seam=bgw-checks.ts batchCheck over a throwaway checkout and previous --out; no_claim=forged batch records
  test('a later batch needs --previous, a finished previous batch and the next slot; the first batch takes none', () => {
    const repo = repoWith([1001, 1036, 1037, 1057]);
    const line = (argv: string[]) => batchCheck(argv, repo).line;
    expect(line(['--batch', '1001'])).toBe('bgw-batch batch=bgw-1001 set=W1 slots=1001-1056 previous=none status=pass');
    const prev = previous(1001, range(1001, 1035).filter(s => s !== 1003), [1003]);
    expect(bgwBatchEnd(prev, 1001)).toBe(1035);
    expect(line(['--batch', '1036', '--previous', prev])).toBe('bgw-batch batch=bgw-1036 set=W1 slots=1036-1091 previous=bgw-1001 previous_last=1035 status=pass');
    expect(() => line(['--batch', '1037', '--previous', prev])).toThrow('the previous batch bgw-1001 ended at slot 1035, so the next batch is bgw-1036, not bgw-1037');
    expect(() => line(['--batch', '1036'])).toThrow('bgw-1036 is not seed set W1\'s first batch, so it needs --previous');
    expect(() => line(['--batch', '1001', '--previous', prev])).toThrow('takes no --previous');
    const unfinished = previous(1001, range(1001, 1020), [1022]);
    expect(bgwBatchEnd(unfinished, 1001)).toBeNull();
    expect(() => line(['--batch', '1036', '--previous', unfinished])).toThrow('the previous batch bgw-1001 is not finished');
    const short = previous(1001, range(1001, 1020), range(1021, 1056));
    expect(bgwBatchEnd(short, 1001)).toBe(1056);
    expect(line(['--batch', '1057', '--previous', short])).toContain('previous=bgw-1001 previous_last=1056 status=pass');
    expect(() => line(['--batch', '1036', '--previous', previous(1001, [], [], 'W2')])).toThrow('--previous is not an earlier batch of seed set W1');
    expect(() => line(['--batch', '1036', '--previous', scratch('empty')])).toThrow('--previous holds no readable batch.json');
    expect(() => batchCheck(['--batch', '1036', '--previous', prev], repoWith([1001]))).toThrow('batch bgw-1036 is not committed: eval/decisions/datasets/bgw-1036-manifest.json is not committed');
    expect(() => line(['--batch', '101'])).toThrow('--batch takes the four-digit first slot');
    expect(run('bun', [CHECKS, 'batch', '--batch', '1001'])).toEqual({ code: 0, out: BATCH_LINE, err: '' });
    refusal(run('bun', [CHECKS, 'batch', '--batch', '1036', '--previous', prev]), 'batch bgw-1036 is not committed');
  });
});
