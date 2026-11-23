/**
 * Set W custody (the weekly outcome line; docs/benchmarks/2026-11-23-weekly-outcome-line-preregistration.md, "The
 * worlds" and "Custody and exposure"): mint.sh --bgw on one monthly batch's slots, its four-digit world ids and render
 * records, its custody --out kept apart from BG1's, BG1-C's and other batches', its yield gate on the batch's first five
 * slots, its drop cap of two, its stop at the 34th kept world and at the batch's last slot, validate.ts and
 * fill-manifest.ts --bgw, and the sealed key in .gstack/pregate.json over a Set W custody folder. Keyless: mint.sh runs in
 * --fake mode or stops at a refusal, every child process runs with the provider keys blanked, and nothing reaches a
 * provider. The seeds here are test seeds made at run time; Set W's seed and phrasing are chosen in custody and are never
 * these.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { BG1_CUSTODY_MARKER, PUBLIC_PHRASING } from '../../eval/generators/changing-facts-gen.ts';
import { bgwWorldIdOf, worldIdOf } from '../../eval/custody/bg1/render.ts';
import { bgwBatchDataset, bgwBatchManifest } from '../../eval/runner/bg1/types.ts';
import { bg1Kept, bg1ManifestFiles, bgwSet, bgwWeekWorlds, loadBgw, verifyBg1Custody, type Bg1Manifest } from '../../eval/runner/memory-qa/corpus.ts';

const REPO = resolve(import.meta.dir, '../..');
const MINT = join(REPO, 'eval/custody/bg1/mint.sh');
const VALIDATE = join(REPO, 'eval/custody/bg1/validate.ts');
const FILL = join(REPO, 'eval/custody/bg1/fill-manifest.ts');
const RENDER = join(REPO, 'eval/custody/bg1/render.ts');
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const id = (slot: number) => `bgw-${slot}`;
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const LENGTH = ['--target-tokens', '30000', '--tolerance', '0.25'];
const BATCH = ['--bgw', '--batch', '1001'];

const roots: string[] = [];
const scratch = (name: string) => { const d = mkdtempSync(join(tmpdir(), `bgw-custody-test-${name}-`)); roots.push(d); return d; };
afterAll(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });

/** A child process with only PATH and HOME, the provider keys blanked. */
function run(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { cwd: REPO, encoding: 'utf8', timeout: 240_000,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', GEMINI_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', BG1_GEMINI_API_KEY: '' } });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}
function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) { const p = join(dir, name); if (statSync(p).isDirectory()) files(p, out); else out.push(p); }
  return out;
}
/** Custody inputs in a fresh directory: owner-only test seed and phrasing files of the given kind (the public phrasing with the custody marker). */
function inputs(name: string, kind: 'bgw' | 'bg1' = 'bgw', lineKind: 'bgw' | 'bg1' = kind) {
  const dir = scratch(name);
  const seed = join(dir, `test.${kind}-seed`), phrasing = join(dir, `test.${kind}-phrasing.json`);
  writeFileSync(seed, [lineKind, 'seed', 'v1'].join('-') + ':' + sha(name) + '\n');
  writeFileSync(phrasing, JSON.stringify({ ...PUBLIC_PHRASING, custody: BG1_CUSTODY_MARKER }));
  chmodSync(seed, 0o600); chmodSync(phrasing, 0o600);
  return { dir, seed, phrasing };
}
/** A fake mint at a length the fake renderer meets and per-slot validation passes. */
const mint = (out: string, i: ReturnType<typeof inputs>, extra: string[]) =>
  run('bash', [MINT, '--out', out, '--seed-file', i.seed, '--phrasing', i.phrasing, ...LENGTH, ...extra]);
/** A mint with no --tolerance, as a BG1 mint takes. */
const plain = (out: string, i: ReturnType<typeof inputs>, extra: string[]) => run('bash', [MINT, '--out', out, '--seed-file', i.seed, '--phrasing', i.phrasing, '--target-tokens', '30000', ...extra]);
const refusal = (r: ReturnType<typeof run>, text: string) => { expect(r.code).toBe(2); expect(r.out).toBe(''); expect(r.err).toContain(text); };
const BATCH_LINE = 'bgw-batch batch=bgw-1001 set=W1 slots=1001-1056 previous=none status=pass\n';
const record = (out: string, slot: number, status: 'pass' | 'fail') => { mkdirSync(join(out, 'render'), { recursive: true }); writeFileSync(join(out, 'render', `${id(slot)}.validation.json`), JSON.stringify({ world: id(slot), status })); };
const dropped = (out: string, slot: number) => { mkdirSync(join(out, 'render'), { recursive: true }); writeFileSync(join(out, 'render', `${id(slot)}.json`), JSON.stringify({ world: id(slot), status: 'dropped' })); };

describe('mint.sh --bgw keeps a Set W batch on its own slots, ids and custody --out', () => {
  // Value: protects=a Set W mint covers one committed batch's four-digit slots, with Set W's own seed and phrasing files; fails_when=--bgw mints without a batch, outside its batch's 56 slots, with BG1's seed or phrasing files, into a bg1-custody --out, or a BG1 mint renders a Set W slot; why_new=weekly-line preregistration "The worlds" and harness item 2; seam=mint.sh argument checks and bgw-checks.ts batch; no_claim=a paid render
  test('flags, ranges, file names and the batch check refuse before anything is written', () => {
    const j = inputs('flags'), bg1 = inputs('flags-bg1', 'bg1');
    const out = join(j.dir, 'bgw-custody-f');
    refusal(mint(out, j, ['--fake', '--bgw']), '--bgw needs --batch <first slot>, the four-digit first slot of the batch (1001 for the first)');
    refusal(mint(out, j, ['--fake', '--bgw', '--batch', '101']), '--bgw needs --batch <first slot>');
    refusal(mint(out, j, ['--fake', '--batch', '1001']), '--batch and --previous name a Set W batch, so they need --bgw');
    refusal(mint(out, j, ['--fake', ...BATCH, '--bg1c']), '--bgw and --bg1c name two different sealed sets; give one');
    refusal(mint(out, j, ['--fake', ...BATCH, '--start', '1000', '--count', '1']), '--start must be at least 1001 and the last slot at most 1056 (Set W batch bgw-1001\'s slots)');
    refusal(mint(out, j, ['--fake', ...BATCH, '--start', '1050', '--count', '8']), 'the last slot at most 1056');
    refusal(plain(out, bg1, ['--fake', '--start', '1001', '--count', '1']), 'slots 1001 and up are Set W\'s, so they need --bgw --batch <first slot>');
    refusal(mint(out, bg1, ['--fake', ...BATCH, '--count', '1']), 'the seed file must be named *.bgw-seed');
    refusal(mint(out, { ...j, phrasing: bg1.phrasing }, ['--fake', ...BATCH, '--count', '1']), 'the phrasing file must be named *.bgw-phrasing.json');
    refusal(mint(join(j.dir, 'bg1-custody-w'), j, ['--fake', ...BATCH, '--count', '1']), '--out must be a directory whose name starts with bgw-custody');
    refusal(plain(join(j.dir, 'bg1-custody-b'), j, ['--fake', '--count', '1']), 'the seed file must be named *.bg1-seed');
    refusal(mint(out, inputs('flags-line', 'bgw', 'bg1'), ['--fake', ...BATCH, '--count', '1']), 'the seed file does not hold one bgw-seed-v1 line');
    refusal(mint(out, j, ['--fake', '--bgw', '--batch', '1036', '--count', '1']), 'batch bgw-1036 is not committed: eval/decisions/datasets/bgw-1036-manifest.json is not committed');
    refusal(mint(out, j, ['--fake', ...BATCH, '--previous', j.dir, '--count', '1']), 'bgw-1001 is seed set W1\'s first batch, so it has no previous batch and takes no --previous');
    refusal(run('bash', [MINT, '--dev', ...BATCH, '--out', join(j.dir, 'dev-out'), '--fake']), 'so it takes no --bgw --batch');
    expect(existsSync(out)).toBe(false);
  });

  test('render.ts gives Set W slots four-digit ids and refuses any other slot under --bgw', () => {
    expect([1001, 1056, 1999].map(bgwWorldIdOf)).toEqual(['bgw-1001', 'bgw-1056', 'bgw-1999']);
    for (const slot of [31, 1000, 2000]) expect(() => bgwWorldIdOf(slot)).toThrow('--slot must be a Set W slot (W1: 1001 to 1999)');
    expect(() => worldIdOf(1001)).toThrow('--slot must be a whole number from 1 to 96');
    expect(run('bun', [RENDER, '--dev', 'bg1-dev-01', '--fake', '--bgw', '--set', join(scratch('render-dev'), 'set')])).toMatchObject({ code: 2, err: expect.stringContaining('--dev plans a public dev world, so it takes no --bgw') });
  });

  // Value: protects=Set W's drop counts, kept list and acks never include a BG1, BG1-C or other batch's world; fails_when=a Set W mint renders into an --out holding a bg1-NNN entry, another batch's bgw-NNNN entry, a malformed id or another batch's batch.json, or a BG1 or BG1-C mint renders into one holding a bgw entry; why_new=weekly-line preregistration "A set of its own"; seam=mint.sh --out checks; no_claim=a custody root outside mint.sh
  test('each batch mints into an --out of its own, with four-digit render records, and every mixed --out refuses', () => {
    const j = inputs('mixed'), bg1 = inputs('mixed-bg1', 'bg1');
    const w = join(j.dir, 'bgw-custody-1001');
    const m = mint(w, j, ['--fake', ...BATCH, '--count', '1']);
    expect(m.code).toBe(0);
    expect(m.out.startsWith(BATCH_LINE)).toBe(true);
    expect(m.out).toMatch(/\nbg1-render slot=1001 world=bgw-1001 status=written /);
    expect(m.out).toMatch(/\nbg1-validate slot=1001 world=bgw-1001 status=pass gates=none /);
    expect(readdirSync(join(w, 'render')).sort()).toEqual(['bgw-1001.json', 'bgw-1001.validation.json']);
    expect(readdirSync(join(w, 'set', 'worlds'))).toEqual(['bgw-1001']);
    expect(readFileSync(join(w, 'batch.json'), 'utf8')).toBe('{"set":"W1","batch":"bgw-1001"}\n');
    refusal(mint(w, bg1, ['--fake', '--bg1c', '--count', '1']), '--out must be a directory whose name starts with bg1-custody');
    const c = join(j.dir, 'bg1-custody-c');
    mkdirSync(join(c, 'render'), { recursive: true });
    writeFileSync(join(c, 'render', 'bgw-1001.json'), '{}');
    refusal(mint(c, bg1, ['--fake', '--bg1c', '--start', '32', '--count', '1']), 'this --out holds bgw-1001.json, which is a Set W entry, not one of BG1-C\'s slots (31 to 96)');
    const w2 = join(j.dir, 'bgw-custody-2');
    mkdirSync(join(w2, 'set', 'worlds', 'bg1-031'), { recursive: true });
    refusal(mint(w2, j, ['--fake', ...BATCH, '--count', '1']), 'this --out holds bg1-031, which is not one of Set W batch bgw-1001\'s slots (1001 to 1056); Set W mints into a custody --out of its own');
    rmSync(join(w2, 'set'), { recursive: true });
    for (const stray of ['bgw-1057.json', 'bgw-10010.json', 'bgw-0999.json']) {
      mkdirSync(join(w2, 'render'), { recursive: true });
      writeFileSync(join(w2, 'render', stray), '{}');
      refusal(mint(w2, j, ['--fake', ...BATCH, '--count', '1']), `this --out holds ${stray}, which is not one of Set W batch bgw-1001's slots (1001 to 1056); each Set W batch mints into a custody --out of its own`);
      rmSync(join(w2, 'render', stray));
    }
    writeFileSync(join(w2, 'batch.json'), '{"set":"W1","batch":"bgw-1036"}\n');
    refusal(mint(w2, j, ['--fake', ...BATCH, '--count', '1']), 'this --out is another batch\'s (its batch.json does not name bgw-1001)');
    expect(existsSync(join(w2, 'set', 'worlds', 'bgw-1001'))).toBe(false);
    refusal(run('bash', [MINT, '--dev', '--out', join(j.dir, 'bgw-custody-dev'), '--fake']), 'so its name may not start with bg1-custody or bgw-custody');
    refusal(run('bash', [MINT, '--dev', '--out', w, '--fake']), 'so its name may not start with bg1-custody or bgw-custody');
    const devOut = join(j.dir, 'dev-out');
    mkdirSync(join(devOut, 'render'), { recursive: true });
    writeFileSync(join(devOut, 'render', 'bgw-1001.json'), '{}');
    refusal(run('bash', [MINT, '--dev', '--out', devOut, '--fake']), 'holds a sealed bgw-NNNN entry under set/worlds or render/');
  }, 240_000);
});

describe('a Set W batch\'s mint stops', () => {
  // Value: protects=two dropped worlds among the batch's first five slots pause its mint; fails_when=the yield gate counts BG1-C's slots 31 to 35 or misses the batch's first five; why_new=weekly-line preregistration "Minting" (BG1-C's drop rules); seam=mint.sh --bgw --fake-break; no_claim=a paid render
  test('the yield gate counts slots 1001 to 1005: two drops there pause with exit 3, and a resumed run pauses before rendering', () => {
    const j = inputs('yield');
    const out = join(j.dir, 'bgw-custody-y');
    const paused = mint(out, j, ['--fake', ...BATCH, '--count', '5', '--fake-break', '1001:2:4,1003:2:4']);
    expect(paused.code).toBe(3);
    expect(paused.out).toMatch(/slot=1001 world=bgw-1001 status=dropped dropped_session=2 /);
    expect(paused.out).toContain('bg1-mint summary=paused reason=yield_gate mode=fake written=1 skipped=0 dropped=2 last_slot=1003 early_drops=2 drops=2\n');
    expect(existsSync(join(out, 'render', 'bgw-1001.json'))).toBe(true);
    expect(existsSync(join(out, 'set', 'worlds', 'bgw-1004'))).toBe(false);
    const later = mint(out, j, ['--fake', ...BATCH, '--start', '1010', '--count', '1']);
    expect([later.code, later.out]).toEqual([3, BATCH_LINE + 'bg1-mint summary=paused reason=yield_gate mode=fake written=0 skipped=0 dropped=0 last_slot=1009 early_drops=2 drops=2\n']);
  }, 240_000);

  // Value: protects=a batch's drop cap is BG1-C's three per 40 kept worlds scaled to 34 and rounded down, two, and an ack lets it go on with the cap still armed; fails_when=a second drop in the batch does not pause, the ack code still measures BG1-C's three, or two more drops after an ack go on; why_new=weekly-line preregistration "Minting" (BG1-C's drop rules, scaled to the batch); seam=mint.sh --bgw --fake-break and --yield-gate-ack; no_claim=a paid render
  test('a second dropped world in the batch pauses with reason drop_cap; after an ack two more drops pause again', () => {
    const j = inputs('cap');
    const out = join(j.dir, 'bgw-custody-c');
    const first = mint(out, j, ['--fake', ...BATCH, '--count', '10', '--fake-break', '1001:2:4,1008:2:4']);
    expect(first.code).toBe(3);
    expect(first.out).toContain('bg1-supply slots=1001-1005 gemini_requests=0 kept=4 per_kept_world=0.0 limit=504 status=pass\n');
    expect(first.out).toContain('bg1-mint summary=paused reason=drop_cap mode=fake written=6 skipped=0 dropped=2 last_slot=1008 drops=2\n');
    expect(existsSync(join(out, 'set', 'worlds', 'bgw-1009'))).toBe(false);
    const acked = mint(out, j, ['--fake', ...BATCH, '--start', '1009', '--count', '3', '--yield-gate-ack', 'a-0123456789ab', '--fake-break', '1010:2:4']);
    expect(acked.code).toBe(0);
    expect(acked.out).toContain('bg1-mint yield_gate_ack=a-0123456789ab early_drops=0 drops=2\n');
    expect(acked.out).toContain('summary=mint mode=fake slots=3 written=2 skipped=0 dropped=1 dropped_earlier=0 kept=8\n');
    const again = mint(out, j, ['--fake', ...BATCH, '--start', '1012', '--count', '3', '--fake-break', '1013:2:4']);
    expect(again.code).toBe(3);
    expect(again.out).toContain('summary=paused reason=drop_cap mode=fake written=1 skipped=0 dropped=1 last_slot=1013 drops=4 acked_total_drops=2\n');
  }, 240_000);

  // Value: protects=a batch stops at its 34th kept world (four weeks of eight and two spares), so no slot past it is rendered or spent on, and the next batch starts after it; fails_when=the mint renders past 34 kept, counts BG1-C's 40, or ends a batch at 34 written rather than 34 validated; why_new=weekly-line preregistration "Minting" (four weeks of worlds plus two spares); seam=mint.sh --bgw with stub kept worlds; no_claim=validate.ts's own kept list (checked end to end below)
  test('the mint stops with exit 0 at the 34th kept world, checked after each slot and before the first', () => {
    const j = inputs('kept');
    const out = join(j.dir, 'bgw-custody-k');
    for (const slot of range(1001, 1033)) record(out, slot, 'pass');
    const stop = mint(out, j, ['--fake', ...BATCH, '--start', '1034']);
    expect(stop.code).toBe(0);
    expect(stop.out).toMatch(/^bgw-batch batch=bgw-1001 .*\nbg1-supply slots=1001-1005 gemini_requests=0 kept=5 per_kept_world=0\.0 limit=504 status=pass\nbg1-render slot=1034 world=bgw-1034 status=written /);
    expect(stop.out).toContain('bg1-mint summary=kept mode=fake kept=34 written=1 skipped=0 dropped=0 dropped_earlier=0 last_slot=1034\n');
    expect(stop.out).not.toContain('slot=1035');
    const done = mint(out, j, ['--fake', ...BATCH, '--start', '1035']);
    expect([done.code, done.out]).toEqual([0, BATCH_LINE + 'bg1-mint summary=kept mode=fake kept=34 written=0 skipped=0 dropped=0 dropped_earlier=0 last_slot=1034\n']);
  }, 240_000);

  // Value: protects=a batch that uses up its 56 slots short of 34 kept stops for GBEV-3 instead of reporting a finished mint or running into the next batch's slots; fails_when=mint.sh exits 0 at slot 1056 short of 34 kept, or renders slot 1057; why_new=weekly-line preregistration "Minting" and "When custody is down" (a month's mint can fall short); seam=mint.sh --bgw over stub records with an acknowledged drop total; no_claim=how GBEV-3 resolves the pause
  test('slot 1056 used up with fewer than 34 kept pauses with reason slots_exhausted', () => {
    const j = inputs('exhausted');
    const out = join(j.dir, 'bgw-custody-x');
    for (const slot of range(1001, 1020)) record(out, slot, 'pass');
    for (const slot of range(1021, 1054)) dropped(out, slot);
    writeFileSync(join(out, 'render', 'yield-gate-acks.jsonl'), JSON.stringify({ ack: 'a-000000000001', at: '2026-11-23T00:00:00Z', early_drops: 0, drops: 34 }) + '\n');
    const last = mint(out, j, ['--fake', ...BATCH, '--start', '1055']);
    expect(last.code).toBe(3);
    expect(last.out).toContain('bg1-mint summary=paused reason=slots_exhausted mode=fake kept=22 written=2 skipped=0 dropped=0 dropped_earlier=0 last_slot=1056\n');
    expect(existsSync(join(out, 'set', 'worlds', 'bgw-1057'))).toBe(false);
  }, 240_000);
});

describe('a Set W batch end to end: mint, validate --bgw, fill --bgw and load a week', () => {
  // Value: protects=a batch's kept list is its first 34 passing slots from its first slot, pinned in its own manifest, filled in two steps while it mints, and loaded one week at a time only by the bgw loader; fails_when=validate plans a Set W world from BG1's seed derivation or the wrong slot, the fill accepts another batch, a short n_final without every slot accounted for, or writes BG1's or BG1-C's manifest, or a week reads the wrong worlds; why_new=weekly-line preregistration "Minting" and "Custody and exposure" (a filled manifest of the line's own pins every file of set W); seam=mint.sh --bgw --fake, validate.ts, fill-manifest.ts and corpus.ts loadBgw; no_claim=the Gemini claim check or the second validator (fake checks)
  test('one drop among the first slots, the stop at the 34th kept world, a partial fill and its refill, then week 1 and week 4 load', () => {
    const j = inputs('e2e');
    const out = join(j.dir, 'bgw-custody-e2e'), set = join(out, 'set');
    const m = mint(out, j, ['--fake', ...BATCH, '--fake-break', '1003:2:4']);
    expect(m.code).toBe(0);
    expect(m.out).toContain('bg1-mint summary=kept mode=fake kept=34 written=34 skipped=0 dropped=1 dropped_earlier=0 last_slot=1035\n');
    const kept = range(1001, 1035).filter(s => s !== 1003).map(id);
    expect(readdirSync(join(set, 'worlds')).sort()).toEqual(kept);

    const report = join(j.dir, 'report.json');
    const validate = (extra: string[], path = report) => run('bun', [VALIDATE, '--set', set, '--seed-file', j.seed, '--phrasing', j.phrasing, '--report', path, ...LENGTH, ...extra]);
    refusal(validate([...BATCH, '--n-final', '34']), '--bgw takes no --n-final: a Set W batch keeps its first 34 passing worlds');
    refusal(validate(['--bgw']), '--bgw needs --batch <first slot>');
    refusal(validate(['--bgw', '--batch', '1950']), 'batch bgw-1950 would run to slot 2005, past seed set W1\'s last slot 1999');
    refusal(validate(['--bgw', '--batch', '1036']), 'the set holds 34 director(ies) under worlds/ that are not batch bgw-1036\'s mint slots');
    const v = validate(BATCH);
    expect(v.err).toBe('');
    expect(v.out).toMatch(/^bg1-validate checked=34 passed=34 failed=1 render_dropped=1 kept=34 gates=render:1 controls_dropped=0 report_sha256=[0-9a-f]{16}\n$/);
    const full = JSON.parse(readFileSync(report, 'utf8')) as { kept: string[]; n_final: number | null; worlds: Array<{ id: string; status: string }> };
    expect([full.kept, full.n_final]).toEqual([kept, 34]);
    refusal(validate(['--bg1c']), 'the seed file must be named *.bg1-seed');

    refusal(run('bun', [FILL, '--root', set, '--report', report, ...LENGTH]), 'not among BG1\'s 30 mint slots');
    refusal(run('bun', [FILL, '--bg1c', '--root', set, '--report', report, ...LENGTH]), 'a BG1-C fill needs the report\'s n_final to be 40');
    refusal(run('bun', [FILL, '--bgw', '--root', set, '--report', report, ...LENGTH]), '--bgw needs --batch <first slot>');
    refusal(run('bun', [FILL, '--bgw', '--batch', '1036', '--root', set, '--report', report, ...LENGTH]), 'batch bgw-1036 is not committed');
    const short = join(j.dir, 'report-short.json');
    writeFileSync(short, JSON.stringify({ ...full, kept: kept.slice(0, 30), n_final: 30, worlds: full.worlds.slice(0, 31) }));
    refusal(run('bun', [FILL, ...BATCH, '--root', set, '--report', short, ...LENGTH]), 'a Set W fill with n_final 30, under 34, is a short batch, and the report does not account for every one of the batch\'s 56 slots');
    const tiny = join(j.dir, 'report-tiny.json');
    writeFileSync(tiny, JSON.stringify({ ...full, kept: kept.slice(0, 6), n_final: null, worlds: full.worlds.slice(0, 7) }));
    refusal(run('bun', [FILL, ...BATCH, '--root', set, '--report', tiny, ...LENGTH]), 'a Set W fill without n_final needs one week\'s 8');
    const outside = join(j.dir, 'report-outside.json');
    writeFileSync(outside, JSON.stringify({ ...full, kept: [...kept.slice(0, 33), 'bgw-1057'], worlds: [...full.worlds, { ...full.worlds[0], id: 'bgw-1057' }] }));
    refusal(run('bun', [FILL, ...BATCH, '--root', set, '--report', outside, ...LENGTH]), 'the kept list is not the report\'s first passing worlds in slot order');

    const partial = join(j.dir, 'report-partial.json');
    writeFileSync(partial, JSON.stringify({ ...full, kept: kept.slice(0, 10), n_final: null, worlds: full.worlds.slice(0, 11) }));
    const p = run('bun', [FILL, ...BATCH, '--root', set, '--report', partial, ...LENGTH]);
    expect(p.err).toBe('');
    expect(p.out).toMatch(/^bg1-fill status=filled files=20 kept=10 first=bgw-1001 last=bgw-1011 n_final=absent earlier_fills=0 manifest_sha256=[0-9a-f]{64}\n$/);
    const f = run('bun', [FILL, ...BATCH, '--root', set, '--report', report, ...LENGTH]);
    expect(f.err).toBe('');
    expect(f.out).toMatch(/^bg1-fill status=filled files=68 kept=34 first=bgw-1001 last=bgw-1035 n_final=34 earlier_fills=1 manifest_sha256=[0-9a-f]{64}\n$/);
    expect(['bg1-manifest.json', 'bg1c-manifest.json'].map(n => existsSync(join(set, n)))).toEqual([false, false]);
    const filledPath = join(set, 'bgw-1001-manifest.json');
    const filled = JSON.parse(readFileSync(filledPath, 'utf8')) as Bg1Manifest;
    const template = JSON.parse(readFileSync(join(REPO, bgwBatchManifest(1001)), 'utf8')) as Bg1Manifest;
    expect({ ...filled, filled_at: null, earlier_fills: [] }).toEqual({ ...template, status: 'filled', files: bg1ManifestFiles(set, kept, bgwSet(1001)), filled_at: null, kept, n_final: 34, earlier_fills: [] });
    expect(filled.dataset).toBe(bgwBatchDataset(1001));
    expect(bg1Kept(filled, bgwSet(1001))).toEqual({ kept, n_final: 34 });
    expect(bgwWeekWorlds(filled, 1, bgwSet(1001))).toEqual(['bgw-1001', 'bgw-1002', ...range(1004, 1009).map(id)]);
    expect(bgwWeekWorlds(filled, 4, bgwSet(1001))).toEqual(range(1026, 1033).map(id));

    const saved = { batch: process.env.GBRAIN_EVALS_BGW_BATCH, source: process.env.GBRAIN_EVALS_BGW_SOURCE, manifest: process.env.GBRAIN_EVALS_BGW_MANIFEST, unit: process.env.GBRAIN_EVALS_BGW_UNIT };
    try {
      process.env.GBRAIN_EVALS_BGW_BATCH = 'bgw-1001';
      process.env.GBRAIN_EVALS_BGW_SOURCE = set;
      process.env.GBRAIN_EVALS_BGW_MANIFEST = filledPath;
      expect(verifyBg1Custody(() => {}, bgwSet(1001))).toBe(68);
      const week = bgwWeekWorlds(filled, 4, bgwSet(1001));
      process.env.GBRAIN_EVALS_BGW_UNIT = week.join(',');
      const log = join(j.dir, 'access.jsonl');
      const c = loadBgw({ log, decisionId: 'test', purpose: 'e2e' }, { worldEnd: '2026-11-22', only: new Set(week) });
      expect(c.benchmark).toBe('bgw');
      expect(c.conversations.map(x => x.id)).toEqual(week);
      expect(c.questions).toHaveLength(8 * 64);
      expect(c.source.revision).toBe(sha(readFileSync(filledPath)).slice(0, 7));
      expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(8);
    } finally {
      for (const [k, v] of [['GBRAIN_EVALS_BGW_BATCH', saved.batch], ['GBRAIN_EVALS_BGW_SOURCE', saved.source], ['GBRAIN_EVALS_BGW_MANIFEST', saved.manifest], ['GBRAIN_EVALS_BGW_UNIT', saved.unit]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }, 240_000);
});

// ─── the sealed key ──────────────────────────────────────────────────

/** A sealed-key path glob as gstack-pregate reads it: * and ? within a segment, ** across directories (custody-bg1.test.ts globRe). */
function globRe(glob: string, ci: boolean): RegExp {
  let re = '';
  for (let k = 0; k < glob.length; k++) {
    const c = glob[k];
    if (c === '*' && glob[k + 1] === '*') { if (glob[k + 2] === '/') { re += '(?:.*/)?'; k += 2; } else { re += '.*'; k += 1; } }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, ci ? 'i' : '');
}

describe('the sealed key in .gstack/pregate.json covers Set W\'s custody files', () => {
  const sealed = JSON.parse(readFileSync(join(REPO, '.gstack/pregate.json'), 'utf8')).sealed as { paths: string[]; answer_markers: string[]; seed_patterns: string[]; case_insensitive: boolean };
  const pathHit = (rel: string) => sealed.paths.some(g => globRe(g, sealed.case_insensitive).test(rel));
  const textRules = [...sealed.answer_markers, ...sealed.seed_patterns].map(r => new RegExp(r));
  const textHit = (text: string) => text.split('\n').some(line => textRules.some(re => re.test(line)));

  // Value: protects=no Set W world, plan, question, render record, cache, seed, phrasing or nonce can be committed; fails_when=a file under a bgw-custody folder, a *.bgw-seed, *.bgw-phrasing.json or *.bgw-nonce file, a Set W seed line or a world carrying the custody marker passes the sealed key; why_new=weekly-line preregistration "Custody and exposure"; seam=the sealed key's globs and markers as gstack-pregate reads them; no_claim=gstack-pregate's own matcher
  test('refuses every file a Set W mint writes by its custody-folder path, its seed, phrasing and nonce files by name, and its seed line and worlds by text', () => {
    const j = inputs('sealed-key');
    const out = join(j.dir, 'bgw-custody-s');
    expect(mint(out, j, ['--fake', ...BATCH, '--count', '1']).code).toBe(0);
    const written = files(out);
    expect(written.some(p => p.endsWith('worlds/bgw-1001/world.json'))).toBe(true);
    for (const path of written) expect(pathHit(relative(j.dir, path))).toBe(true);
    for (const path of files(join(out, 'set'))) {
      expect(textHit(readFileSync(path, 'utf8'))).toBe(true);
      expect(pathHit(`eval/data/innocent/${path.split('/').pop()}`)).toBe(false);
    }
    for (const name of ['notes/w1.bgw-seed', 'notes/w1.bgw-phrasing.json', 'notes/w1.bgw-nonce', 'notes/BGW-CUSTODY-1001/render/bgw-1001.json']) expect(pathHit(name)).toBe(true);
    expect(textHit(readFileSync(j.seed, 'utf8'))).toBe(true);
  }, 120_000);

  test('the committed Set W files, its loader and custody code and these tests pass it', () => {
    const committed = ['eval/decisions/datasets/bgw-1001-manifest.json', 'eval/decisions/splits/bgw.json', 'eval/runner/memory-qa/bg1-names.ts', 'eval/runner/memory-qa/corpus.ts',
      'eval/custody/bg1/mint.sh', 'eval/custody/bg1/bgw-checks.ts', 'eval/custody/bg1/validate.ts', 'eval/custody/bg1/fill-manifest.ts', 'eval/custody/bg1/render.ts', 'eval/custody/bg1/supply.ts',
      'test/eval/bgw-loader.test.ts', 'test/eval/bgw-mint-checks.test.ts'].map(p => join(REPO, p));
    for (const path of [...committed, import.meta.path]) {
      expect(pathHit(relative(REPO, path))).toBe(false);
      expect(textHit(readFileSync(path, 'utf8'))).toBe(false);
    }
  });
});
