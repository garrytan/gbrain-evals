/**
 * The custody fixes for BG1-C and Set W (second-model review findings 1 to 5 on #607): validate.ts, fill-manifest.ts,
 * the sealed loaders and verifyBg1Custody refuse template-rendered worlds outside a keyless drill; render.ts refuses an
 * in-checkout --set or --cache for a sealed slot; mint.sh refuses an unresolved slot before it renders on or reports
 * kept; the committed-batch check reads HEAD; and a real mint checks the seed and phrasing against the commitment file
 * the seed check writes. Keyless: mint.sh runs in --fake mode or stops at a refusal before any key, window or proxy,
 * every child process runs with the provider keys blanked, and the seeds are test seeds made at run time.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BG1_CUSTODY_MARKER, PUBLIC_PHRASING } from '../../eval/generators/changing-facts-gen.ts';
import { checkCommitment, commitmentFile, commitmentOf, recordCommitment } from '../../eval/custody/bg1/commitment.ts';
import { BGW_SPLIT, bgwBatchManifest, bgwFilledManifest } from '../../eval/runner/memory-qa/bg1-names.ts';
import { bgwCommittedProblems, bgwSet, bgwWeekWorlds, loadBgw, verifyBg1Custody, type Bg1Manifest } from '../../eval/runner/memory-qa/corpus.ts';

const REPO = resolve(import.meta.dir, '../..');
const MINT = join(REPO, 'eval/custody/bg1/mint.sh');
const VALIDATE = join(REPO, 'eval/custody/bg1/validate.ts');
const FILL = join(REPO, 'eval/custody/bg1/fill-manifest.ts');
const RENDER = join(REPO, 'eval/custody/bg1/render.ts');
const CHECKS = join(REPO, 'eval/custody/bg1/bgw-checks.ts');
const COMMITMENT = join(REPO, 'eval/custody/bg1/commitment.ts');
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const LENGTH = ['--target-tokens', '30000', '--tolerance', '0.25'];
const BATCH = ['--bgw', '--batch', '1001'];
const custodyPhrasing = { ...PUBLIC_PHRASING, custody: BG1_CUSTODY_MARKER };
const reworded = (v: unknown): unknown => (typeof v === 'string' ? `Note: ${v}` : Array.isArray(v) ? v.map(reworded) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, reworded(x)])) : v);

const roots: string[] = [];
const scratch = (name: string) => { const d = mkdtempSync(join(tmpdir(), `sealed-fixes-${name}-`)); roots.push(d); return d; };
afterAll(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });

/** A child process with only PATH and HOME, the provider keys blanked. */
function run(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { cwd: REPO, encoding: 'utf8', timeout: 240_000,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', GEMINI_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', BG1_GEMINI_API_KEY: '' } });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}
/** Owner-only test seed and phrasing files of the given kind, made at run time. */
function inputs(name: string, kind: 'bgw' | 'bg1' = 'bgw', phrasing: object = custodyPhrasing) {
  const dir = scratch(name);
  const seed = join(dir, `test.${kind}-seed`), phrasingFile = join(dir, `test.${kind}-phrasing.json`);
  const seedLine = [kind, 'seed', 'v1'].join('-') + ':' + sha(name);
  writeFileSync(seed, seedLine + '\n');
  writeFileSync(phrasingFile, JSON.stringify(phrasing));
  chmodSync(seed, 0o600); chmodSync(phrasingFile, 0o600);
  return { dir, seed, phrasing: phrasingFile, seedLine };
}
const mint = (out: string, i: ReturnType<typeof inputs>, extra: string[]) => run('bash', [MINT, '--out', out, '--seed-file', i.seed, '--phrasing', i.phrasing, ...LENGTH, ...extra]);
const refusal = (r: ReturnType<typeof run>, text: string) => { expect(r.code).toBe(2); expect(r.out).toBe(''); expect(r.err).toContain(text); };
/** A mint refusal after the batch or supply line it prints on its way. */
const stopped = (r: ReturnType<typeof run>, text: string) => { expect(r.code).toBe(2); expect(r.err).toContain(text); };
const record = (out: string, world: string) => { mkdirSync(join(out, 'render'), { recursive: true }); writeFileSync(join(out, 'render', `${world}.validation.json`), JSON.stringify({ world, status: 'pass' })); };
const withEnv = <T>(vars: Record<string, string>, fn: () => T): T => {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  try { Object.assign(process.env, vars); return fn(); }
  finally { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
};

describe('finding 1: template-rendered worlds stay in keyless drills', () => {
  // Value: protects=no fake-template world is validated, pinned or loaded as a minted world; fails_when=validate.ts passes a render.ts --fake world without --fake, fill-manifest.ts pins one without --fake, or a sealed load or verifyBg1Custody reads a drill manifest or a fake-template world when not keyless; why_new=second-model review finding 1 on #607; seam=validate.ts renderer gate, fill-manifest.ts drill flag, loadBgw and verifyBg1Custody keyless option; no_claim=a real render
  test('validate, fill, the loader and verify refuse a --fake mint unless it is a declared drill', () => {
    const j = inputs('drill');
    const out = join(j.dir, 'bgw-custody-drill');
    expect(mint(out, j, ['--fake', ...BATCH, '--count', '8']).code).toBe(0);
    const set = join(out, 'set');
    const report = join(j.dir, 'report.json');
    const validate = (extra: string[]) => run('bun', [VALIDATE, ...BATCH, '--set', set, '--seed-file', j.seed, '--phrasing', j.phrasing, '--report', report, ...LENGTH, ...extra]);
    expect(validate([]).out).toMatch(/^bg1-validate checked=8 passed=0 failed=8 render_dropped=0 kept=0 gates=renderer:8 /);
    expect(validate(['--fake']).out).toMatch(/^bg1-validate checked=8 passed=8 failed=0 render_dropped=0 kept=8 gates=none /);
    refusal(run('bun', [FILL, ...BATCH, '--root', set, '--report', report, ...LENGTH]), '8 kept world(s) were written by a template renderer (first bgw-1001); only a --fake drill fills template worlds');
    const f = run('bun', [FILL, ...BATCH, '--root', set, '--report', report, ...LENGTH, '--fake']);
    expect(f.err).toBe('');
    const path = join(set, bgwFilledManifest(1001));
    const filled = JSON.parse(readFileSync(path, 'utf8')) as Bg1Manifest;
    expect(filled.drill).toBe(true);
    const week = bgwWeekWorlds(filled, 1, bgwSet(1001));
    const env = { GBRAIN_EVALS_BGW_BATCH: 'bgw-1001', GBRAIN_EVALS_BGW_SOURCE: set, GBRAIN_EVALS_BGW_MANIFEST: path, GBRAIN_EVALS_BGW_UNIT: week.join(',') };
    const load = (keyless: boolean) => loadBgw({ log: join(j.dir, 'access.jsonl'), decisionId: 'test', purpose: 'drill' }, { worldEnd: '2026-11-22', only: new Set(week), keyless });
    withEnv(env, () => {
      expect(() => verifyBg1Custody(() => {}, bgwSet(1001))).toThrow('the manifest was filled by a --fake drill, and this check is not keyless');
      expect(verifyBg1Custody(() => {}, bgwSet(1001), { keyless: true })).toBe(16);
      expect(() => load(false)).toThrow('the manifest was filled by a --fake drill, and this load is not keyless');
      expect(load(true).conversations.map(c => c.id)).toEqual(week);
      const { drill: _, ...real } = filled;
      writeFileSync(path, JSON.stringify(real, null, 1) + '\n');
      expect(() => load(false)).toThrow('bgw-1001 was written by render.ts --fake, and this load is not keyless');
      refusal(run('bun', [FILL, ...BATCH, '--root', set, '--report', report, ...LENGTH, '--fake']), 'the earlier fill was a real fill, and a drill fill and a real fill never refill each other');
    });
  }, 240_000);
});

describe('finding 2: render.ts keeps sealed renders out of a checkout', () => {
  // Value: protects=no sealed plan, world or cached reply is written inside a git checkout; fails_when=render.ts --bgw or a BG1-C slot accepts an in-checkout --set or --cache; why_new=second-model review finding 2 on #607; seam=render.ts main before planning; no_claim=mint.sh's own --out check
  test('an in-checkout --set or --cache refuses for a Set W and a BG1-C slot before anything is written', () => {
    const w = inputs('render'), b = inputs('render-bg1', 'bg1');
    const inRepo = join(REPO, 'sealed-fixes-never-written');
    const outside = join(w.dir, 'set');
    const render = (i: ReturnType<typeof inputs>, extra: string[]) => run('bun', [RENDER, '--seed-file', i.seed, '--phrasing', i.phrasing, '--fake', ...extra]);
    for (const [i, slot] of [[w, ['--bgw', '--slot', '1001']], [b, ['--slot', '31']]] as const) {
      refusal(render(i, [...slot, '--set', join(inRepo, 'set')]), '--set must sit outside any git checkout');
      refusal(render(i, [...slot, '--set', outside, '--cache', join(inRepo, 'cache')]), '--cache must sit outside any git checkout');
    }
    expect(existsSync(inRepo)).toBe(false);
    expect(existsSync(outside)).toBe(false);
  }, 60_000);
});

describe('finding 3: an unresolved slot stops the mint', () => {
  // Value: protects=a mint never renders past, or reports kept over, a slot an in-range --start skipped; fails_when=mint.sh --bgw or --bg1c starts past an unresolved slot or prints summary=kept with one; why_new=second-model review finding 3 on #607; seam=mint.sh unresolved_check before the loop and in kept_stop; no_claim=a real render
  test('a Set W gap past the first five slots refuses, before a kept stop too', () => {
    const j = inputs('gap');
    const out = join(j.dir, 'bgw-custody-gap');
    for (let s = 1001; s <= 1005; s++) record(out, `bgw-${s}`);
    stopped(mint(out, j, ['--fake', ...BATCH, '--start', '1008', '--count', '1']), 'slot 1006 (bgw-1006) is unresolved: it has neither a validation record nor a dropped render record, so resume the mint with --start 1006');
    for (let s = 1006; s <= 1035; s++) if (s !== 1020) record(out, `bgw-${s}`);
    const r = mint(out, j, ['--fake', ...BATCH, '--start', '1036', '--count', '1']);
    stopped(r, 'slot 1020 (bgw-1020) is unresolved');
    expect(r.out + r.err).not.toContain('summary=kept');
    expect(existsSync(join(out, 'set', 'worlds', 'bgw-1036'))).toBe(false);
  }, 120_000);

  test('BG1-C with bg1-038 missing refuses a --start 41 run, before a kept stop too', () => {
    const j = inputs('gap-c', 'bg1');
    const out = join(j.dir, 'bg1-custody-gap-c');
    const bg1 = (s: number) => `bg1-${String(s).padStart(3, '0')}`;
    for (let s = 31; s <= 40; s++) if (s !== 38) record(out, bg1(s));
    stopped(mint(out, j, ['--fake', '--bg1c', '--start', '41', '--count', '1']), 'slot 38 (bg1-038) is unresolved');
    for (let s = 41; s <= 71; s++) record(out, bg1(s));
    const r = mint(out, j, ['--fake', '--bg1c', '--start', '72', '--count', '1']);
    stopped(r, 'slot 38 (bg1-038) is unresolved');
    expect(r.out + r.err).not.toContain('summary=kept');
  }, 120_000);
});

describe('finding 4: the committed-batch check reads HEAD', () => {
  // Value: protects=a batch mints only from a template and split committed at HEAD, byte for byte; fails_when=bgwCommittedProblems accepts an untracked template or a committed one edited in the working tree; why_new=second-model review finding 4 on #607; seam=bgwCommittedProblems; no_claim=the batch check's other refusals
  test('an untracked template and a committed template edited in the working tree refuse', () => {
    const repo = scratch('repo');
    const git = (...args: string[]) => spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { encoding: 'utf8' });
    mkdirSync(join(repo, 'eval/decisions/datasets'), { recursive: true });
    mkdirSync(join(repo, 'eval/decisions/splits'), { recursive: true });
    const template = join(repo, bgwBatchManifest(1001));
    const text = readFileSync(join(REPO, bgwBatchManifest(1001)), 'utf8');
    writeFileSync(join(repo, BGW_SPLIT), readFileSync(join(REPO, BGW_SPLIT)));
    git('init', '-q'); git('add', BGW_SPLIT); git('commit', '-q', '-m', 'split');
    writeFileSync(template, text);
    expect(bgwCommittedProblems(1001, repo)).toEqual([`${bgwBatchManifest(1001)} is not committed`]);
    git('add', '.'); git('commit', '-q', '-m', 'template');
    expect(bgwCommittedProblems(1001, repo)).toEqual([]);
    writeFileSync(template, text.replace('"unfilled"', '"unfilled" '));
    expect(bgwCommittedProblems(1001, repo)).toEqual([`${bgwBatchManifest(1001)} differs from its committed bytes at HEAD`]);
  });
});

describe('finding 5: a real mint checks the seed commitment', () => {
  // Value: protects=a real mint renders only from the seed and phrasing whose hashes launch amendment A published; fails_when=the seed check writes no commitment file, commitment.ts passes another seed or phrasing or a missing file, or a real mint reaches the window check without the commitment; why_new=second-model review finding 5 on #607; seam=recordCommitment in the seed checks, commitment.ts and mint.sh's real-mode call; no_claim=a paid render
  test('the Set W seed check records the commitment, and commitment.ts and a real mint refuse anything else', () => {
    const bg1 = inputs('commit-bg1', 'bg1', { ...(reworded(PUBLIC_PHRASING) as object), custody: BG1_CUSTODY_MARKER });
    const j = inputs('commit');
    const out = join(j.dir, 'bgw-custody-commit');
    const realMint = () => mint(out, j, [...BATCH, '--count', '1']);
    refusal(realMint(), 'there is no commitment file beside the seed (.bgw-commitment.json)');
    const seed = run('bun', [CHECKS, 'seed', '--seed-file', j.seed, '--phrasing', j.phrasing, '--bg1-seed-file', bg1.seed, '--bg1-phrasing', bg1.phrasing]);
    expect(seed.code).toBe(0);
    const file = commitmentFile(j.seed, 'bgw');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const nonce = readFileSync(join(j.dir, 'test.bgw-nonce'), 'utf8').trim();
    const commitment = commitmentOf('bgw', j.seedLine, nonce);
    expect(seed.out).toContain(`commitment_sha256=${commitment} `);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ schema: 'gbrain-evals/seed-commitment/v1', set: 'bgw', commitment_sha256: commitment, phrasing_sha256: sha(readFileSync(j.phrasing)) });
    const check = () => run('bun', [COMMITMENT, '--bgw', '--seed-file', j.seed, '--phrasing', j.phrasing]);
    expect(check()).toMatchObject({ code: 0, err: '', out: `bg1-commitment set=bgw status=pass commitment_sha256=${commitment} phrasing_sha256=${sha(readFileSync(j.phrasing))}\n` });
    const passed = realMint();
    expect(passed.code).toBe(2);
    expect(passed.err).toContain('real mode spends real keys, so it needs --paid-window');

    const phrasing = readFileSync(j.phrasing), seedText = readFileSync(j.seed);
    writeFileSync(j.phrasing, JSON.stringify({ ...custodyPhrasing, note: 'changed' }));
    refusal(check(), 'the phrasing file does not hash to the recorded phrasing SHA-256');
    refusal(realMint(), 'the phrasing file does not hash to the recorded phrasing SHA-256');
    const again = run('bun', [CHECKS, 'seed', '--seed-file', j.seed, '--phrasing', j.phrasing, '--bg1-seed-file', bg1.seed, '--bg1-phrasing', bg1.phrasing]);
    refusal(again, 'records another commitment or phrasing SHA-256');
    writeFileSync(j.phrasing, phrasing);
    writeFileSync(j.seed, ['bgw', 'seed', 'v1'].join('-') + ':' + sha('another') + '\n');
    refusal(check(), 'the seed and its nonce do not re-derive the recorded commitment');
    writeFileSync(j.seed, seedText);
    expect(check().code).toBe(0);
    unlinkSync(file);
    refusal(check(), 'there is no commitment file beside the seed');
  }, 120_000);

  test('BG1-C records and checks its commitment the same way, and a real BG1-C mint refuses without one', () => {
    const j = inputs('commit-c', 'bg1');
    refusal(mint(join(j.dir, 'bg1-custody-c'), j, ['--bg1c', '--count', '1']), 'there is no commitment file beside the seed (.bg1c-commitment.json)');
    const nonce = sha('nonce');
    writeFileSync(join(j.dir, 'test.bg1c-nonce'), nonce + '\n', { mode: 0o600 });
    const commitment = commitmentOf('bg1c', j.seedLine, nonce), phrasingSha = sha(readFileSync(j.phrasing));
    recordCommitment(j.seed, 'bg1c', commitment, phrasingSha);
    recordCommitment(j.seed, 'bg1c', commitment, phrasingSha);
    expect(statSync(commitmentFile(j.seed, 'bg1c')).mode & 0o777).toBe(0o600);
    expect(checkCommitment('bg1c', j.seed, j.phrasing)).toBe(`bg1-commitment set=bg1c status=pass commitment_sha256=${commitment} phrasing_sha256=${phrasingSha}`);
    expect(() => recordCommitment(j.seed, 'bg1c', commitment, sha('other'))).toThrow('records another commitment or phrasing SHA-256');
    expect(() => checkCommitment('bgw', j.seed, j.phrasing)).toThrow();
    writeFileSync(join(j.dir, 'test.bg1c-nonce'), sha('other nonce') + '\n');
    expect(() => checkCommitment('bg1c', j.seed, j.phrasing)).toThrow('the seed and its nonce do not re-derive the recorded commitment');
  });
});
