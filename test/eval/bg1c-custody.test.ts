/**
 * BG1-C custody (docs/benchmarks/2026-11-19-changing-facts-confirmation-preregistration.md, harness item 1): mint.sh
 * --bg1c on slots 31 to 96 with its yield gate on 31 to 35, its third-drop stop and its 40-kept stop, validate.ts and
 * fill-manifest.ts --bg1c, render.ts's slot range, the refusals that keep BG1's and BG1-C's slots and custody roots apart,
 * and the sealed key in .gstack/pregate.json over a BG1-C custody folder. Keyless: mint.sh runs in --fake mode or stops
 * at a refusal, every child process runs with the provider keys blanked, and nothing reaches a provider. The seeds here
 * are test seeds made at run time; the BG1 seed and phrasing are chosen in custody and are never these.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { BG1_CUSTODY_MARKER, PUBLIC_PHRASING } from '../../eval/generators/changing-facts-gen.ts';
import { BG1C_CONVERSATIONS, BG1C_DATASET, BG1C_N_FINAL } from '../../eval/runner/bg1/types.ts';
import { worldIdOf } from '../../eval/custody/bg1/render.ts';
import { BG1C_MANIFEST, BG1C_SET, bg1Kept, bg1ManifestFiles, loadBg1c, verifyBg1Custody, type Bg1Manifest } from '../../eval/runner/memory-qa/corpus.ts';

const REPO = resolve(import.meta.dir, '../..');
const MINT = join(REPO, 'eval/custody/bg1/mint.sh');
const VALIDATE = join(REPO, 'eval/custody/bg1/validate.ts');
const FILL = join(REPO, 'eval/custody/bg1/fill-manifest.ts');
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const id = (slot: number) => `bg1-${String(slot).padStart(3, '0')}`;
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const LENGTH = ['--target-tokens', '30000', '--tolerance', '0.25'];

const roots: string[] = [];
const scratch = (name: string) => { const d = mkdtempSync(join(tmpdir(), `bg1c-custody-test-${name}-`)); roots.push(d); return d; };
afterAll(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });

/** A child process with only PATH and HOME, the provider keys blanked. */
function run(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { cwd: REPO, encoding: 'utf8', timeout: 240_000,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', GEMINI_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', BG1_GEMINI_API_KEY: '' } });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '', all: (r.stdout ?? '') + (r.stderr ?? '') };
}
function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) { const p = join(dir, name); if (statSync(p).isDirectory()) files(p, out); else out.push(p); }
  return out;
}
/** Custody inputs in a fresh directory: an owner-only test seed file and phrasing set (public phrasing with the custody marker). */
function inputs(name: string) {
  const dir = scratch(name);
  const seed = join(dir, 'test.bg1-seed'), phrasing = join(dir, 'test.bg1-phrasing.json');
  writeFileSync(seed, ['bg1', 'seed', 'v1'].join('-') + ':' + sha(name) + '\n');
  writeFileSync(phrasing, JSON.stringify({ ...PUBLIC_PHRASING, custody: BG1_CUSTODY_MARKER }));
  chmodSync(seed, 0o600); chmodSync(phrasing, 0o600);
  return { dir, seed, phrasing };
}
/** A fake mint; a BG1-C one validates each slot (mint.sh --bg1c), so its worlds are rendered at a length the fake renderer meets. */
const mint = (out: string, i: ReturnType<typeof inputs>, extra: string[], tokens = '30000') =>
  run('bash', [MINT, '--out', out, '--seed-file', i.seed, '--phrasing', i.phrasing, '--target-tokens', tokens, ...(extra.includes('--bg1c') ? ['--tolerance', '0.25'] : []), ...extra]);
const refusal = (r: ReturnType<typeof run>, text: string) => { expect(r.code).toBe(2); expect(r.out).toBe(''); expect(r.err).toContain(text); };
const acks = (out: string) => readFileSync(join(out, 'render', 'yield-gate-acks.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l) as { ack: string; early_drops: number; drops: number });

describe('mint.sh keeps BG1\'s and BG1-C\'s slots apart', () => {
  // Value: protects=a mint covers one sealed set's slots; fails_when=BG1's mint renders slot 31 onward, BG1-C's renders slot 30 or below or past 96, or one invocation spans both sets; why_new=BG1-C preregistration harness item 1; seam=mint.sh argument checks; no_claim=a paid render
  test('BG1-C takes only slots 31 to 96 and BG1 only 1 to 30; a range that mixes them refuses before anything is written', () => {
    const j = inputs('ranges');
    const out = join(j.dir, 'bg1-custody-r');
    refusal(mint(out, j, ['--fake', '--start', '29', '--count', '3']), 'slots 29 to 31 mix BG1\'s slots (1 to 30) and BG1-C\'s (31 to 96)');
    refusal(mint(out, j, ['--fake', '--count', '31']), 'slots 1 to 31 mix');
    refusal(mint(out, j, ['--fake', '--bg1c', '--start', '30', '--count', '2']), 'slots 30 to 31 mix');
    refusal(mint(out, j, ['--fake', '--bg1c', '--start', '5']), 'slots 5 to 96 mix');
    refusal(mint(out, j, ['--fake', '--start', '31', '--count', '1']), 'slots 31 to 96 are BG1-C\'s, so they need --bg1c');
    refusal(mint(out, j, ['--fake', '--bg1c', '--start', '5', '--count', '2']), '--start must be at least 31 and the last slot at most 96 (BG1-C\'s slots)');
    refusal(mint(out, j, ['--fake', '--bg1c', '--start', '90', '--count', '8']), 'the last slot at most 96');
    refusal(mint(out, j, ['--fake', '--bg1c', '--start', '97', '--count', '0']), 'the last slot at most 96');
    refusal(run('bash', [MINT, '--dev', '--bg1c', '--out', join(j.dir, 'dev-out'), '--fake']), 'so it takes no --bg1c');
    expect(existsSync(out)).toBe(false);
  });

  test('render.ts plans slots 1 to 96 under BG1\'s ids and refuses any other slot', () => {
    expect([1, 30, 31, 96].map(worldIdOf)).toEqual(['bg1-001', 'bg1-030', 'bg1-031', 'bg1-096']);
    for (const slot of [0, 97, 31.5]) expect(() => worldIdOf(slot)).toThrow('--slot must be a whole number from 1 to 96');
    expect(BG1C_CONVERSATIONS).toEqual(range(31, 96).map(id));
  });

  // Value: protects=BG1-C's drop counts and kept list never include a BG1 world, and BG1's never a BG1-C world; fails_when=a mint renders into an --out that holds the other set's slots; why_new=BG1-C preregistration harness item 1 (separate custody roots); seam=mint.sh --out check; no_claim=a custody root outside mint.sh
  test('each set mints into an --out of its own: an --out holding the other set\'s slot refuses before any render', () => {
    const j = inputs('mixed-out');
    const bg1 = join(j.dir, 'bg1-custody-a'), bg1c = join(j.dir, 'bg1-custody-c');
    expect(mint(bg1, j, ['--fake', '--start', '3', '--count', '1']).code).toBe(0);
    refusal(mint(bg1, j, ['--fake', '--bg1c', '--count', '1']), 'this --out holds bg1-003, which is not one of BG1-C\'s slots (31 to 96)');
    mkdirSync(join(bg1c, 'render'), { recursive: true });
    for (const slot of range(31, 39)) writeFileSync(join(bg1c, 'render', `${id(slot)}.validation.json`), JSON.stringify({ world: id(slot), status: 'pass' }));
    expect(mint(bg1c, j, ['--fake', '--bg1c', '--start', '40', '--count', '1']).code).toBe(0);
    refusal(mint(bg1c, j, ['--fake', '--count', '1']), 'this --out holds bg1-040, which is not one of BG1\'s slots (1 to 30)');
    mkdirSync(join(bg1c, 'render'), { recursive: true });
    writeFileSync(join(bg1c, 'render', 'bg1-097.json'), '{}');
    refusal(mint(bg1c, j, ['--fake', '--bg1c', '--start', '41', '--count', '1']), 'this --out holds bg1-097');
    expect(existsSync(join(bg1c, 'set', 'worlds', 'bg1-041'))).toBe(false);
    expect(readdirSync(join(bg1, 'set', 'worlds'))).toEqual(['bg1-003']);
  }, 120_000);
});

describe('BG1-C\'s mint stops', () => {
  // Value: protects=two dropped worlds among slots 31 to 35 pause BG1-C's mint; fails_when=the yield gate counts slots 1 to 5, or counts drops past slot 35; why_new=BG1-C preregistration harness item 1 (yield gate based on the first BG1-C slot); seam=mint.sh --bg1c --fake-break; no_claim=a paid render
  test('the yield gate counts slots 31 to 35: two drops there pause with exit 3, and two drops past 35 do not', () => {
    const j = inputs('bg1c-yield');
    const out = join(j.dir, 'bg1-custody-y');
    const paused = mint(out, j, ['--fake', '--bg1c', '--count', '5', '--fake-break', '31:2:4,33:2:4']);
    expect(paused.code).toBe(3);
    expect(paused.out).toMatch(/slot=31 world=bg1-031 status=dropped dropped_session=2 /);
    expect(paused.out).toContain('bg1-mint summary=paused reason=yield_gate mode=fake written=1 skipped=0 dropped=2 last_slot=33 early_drops=2 drops=2\n');
    expect(existsSync(join(out, 'set', 'worlds', 'bg1-034'))).toBe(false);
    const later = mint(out, j, ['--fake', '--bg1c', '--start', '40', '--count', '1']);
    expect(later.code).toBe(3);
    expect(later.out).toBe('bg1-mint summary=paused reason=yield_gate mode=fake written=0 skipped=0 dropped=0 last_slot=39 early_drops=2 drops=2\n');

    const past = join(j.dir, 'bg1-custody-p');
    mkdirSync(join(past, 'render'), { recursive: true });
    for (const slot of range(31, 35)) writeFileSync(join(past, 'render', `${id(slot)}.validation.json`), JSON.stringify({ world: id(slot), status: 'pass' }));
    const two = mint(past, j, ['--fake', '--bg1c', '--start', '36', '--count', '3', '--fake-break', '36:1:4,37:1:4']);
    expect(two.code).toBe(0);
    expect(two.out).toContain('bg1-mint summary=mint mode=fake slots=3 written=1 skipped=0 dropped=2 dropped_earlier=0 kept=6\n');
  }, 240_000);

  // Value: protects=a third dropped world anywhere in BG1-C's slots pauses the mint, across invocations on one --out; fails_when=the mint goes on past a third drop, or a resumed run renders past it; why_new=BG1-C preregistration harness item 1 (stop on a third dropped world); seam=mint.sh --bg1c --fake-break; no_claim=a paid render
  test('a third dropped world in all pauses with exit 3 and reason drop_cap, and a resumed run pauses before rendering', () => {
    const j = inputs('bg1c-cap');
    const out = join(j.dir, 'bg1-custody-c');
    const first = mint(out, j, ['--fake', '--bg1c', '--count', '6', '--fake-break', '31:2:4,36:2:4']);
    expect(first.code).toBe(0);
    expect(first.out).toContain('summary=mint mode=fake slots=6 written=4 skipped=0 dropped=2 dropped_earlier=0 kept=4\n');
    const third = mint(out, j, ['--fake', '--bg1c', '--start', '37', '--count', '10', '--fake-break', '39:2:4']);
    expect(third.code).toBe(3);
    expect(third.out).toContain('bg1-mint summary=paused reason=drop_cap mode=fake written=2 skipped=0 dropped=1 last_slot=39 drops=3\n');
    expect(existsSync(join(out, 'set', 'worlds', 'bg1-040'))).toBe(false);
    const resumed = mint(out, j, ['--fake', '--bg1c', '--start', '40', '--count', '5']);
    expect(resumed.code).toBe(3);
    expect(resumed.out).toBe('bg1-mint summary=paused reason=drop_cap mode=fake written=0 skipped=0 dropped=0 last_slot=39 drops=3\n');
    expect(existsSync(join(out, 'set', 'worlds', 'bg1-040'))).toBe(false);
  }, 240_000);

  // Value: protects=an approved pause lets BG1-C's mint go on while both stops stay armed; fails_when=an ack for one stop moves the other stop's count, an ack is taken with no pause, or three more drops go on without a pause; why_new=BG1-C preregistration harness item 1 (an ack for the new stop); seam=mint.sh --bg1c --yield-gate-ack; no_claim=a paid render
  test('an ack moves only the paused stop\'s count: after a drop-cap ack three more drops pause again, and after a yield-gate ack the third drop in all still pauses', () => {
    const j = inputs('bg1c-ack');
    const out = join(j.dir, 'bg1-custody-k');
    expect(mint(out, j, ['--fake', '--bg1c', '--count', '8', '--fake-break', '31:2:4,36:2:4,38:2:4']).code).toBe(3);
    refusal(mint(out, j, ['--fake', '--bg1c', '--start', '39', '--count', '1', '--yield-gate-ack', 'a-0123456789a']), 'approval id');
    const acked = mint(out, j, ['--fake', '--bg1c', '--start', '39', '--count', '3', '--yield-gate-ack', 'a-0123456789ab', '--fake-break', '40:2:4,41:2:4']);
    expect(acked.code).toBe(0);
    expect(acked.out).toContain('bg1-mint yield_gate_ack=a-0123456789ab early_drops=0 drops=3\n');
    expect(acked.out).toContain('summary=mint mode=fake slots=3 written=1 skipped=0 dropped=2 dropped_earlier=0 kept=6\n');
    expect(acks(out).map(a => [a.ack, a.early_drops, a.drops])).toEqual([['a-0123456789ab', 0, 3]]);
    refusal(mint(out, j, ['--fake', '--bg1c', '--start', '42', '--count', '1', '--yield-gate-ack', 'a-ba9876543210']), 'neither the yield gate nor the drop cap is paused');
    const again = mint(out, j, ['--fake', '--bg1c', '--start', '42', '--count', '3', '--fake-break', '43:2:4']);
    expect(again.code).toBe(3);
    expect(again.out).toContain('summary=paused reason=drop_cap mode=fake written=1 skipped=0 dropped=1 last_slot=43 drops=6 acked_total_drops=3\n');

    const y = join(j.dir, 'bg1-custody-yk');
    expect(mint(y, j, ['--fake', '--bg1c', '--count', '2', '--fake-break', '31:2:4,32:2:4']).code).toBe(3);
    const yAck = mint(y, j, ['--fake', '--bg1c', '--start', '33', '--count', '5', '--yield-gate-ack', 'a-00000000000a', '--fake-break', '36:2:4']);
    expect(yAck.code).toBe(3);
    expect(yAck.out).toContain('bg1-mint yield_gate_ack=a-00000000000a early_drops=2 drops=0\n');
    expect(yAck.out).toContain('summary=paused reason=drop_cap mode=fake written=3 skipped=0 dropped=1 last_slot=36 drops=3 acked_total_drops=0\n');
    expect(acks(y).map(a => [a.early_drops, a.drops])).toEqual([[2, 0]]);
    const yAck2 = mint(y, j, ['--fake', '--bg1c', '--start', '37', '--count', '1', '--yield-gate-ack', 'a-00000000000b']);
    expect(yAck2.code).toBe(0);
    expect(acks(y).map(a => [a.early_drops, a.drops])).toEqual([[2, 0], [2, 3]]);
  }, 240_000);

  test('a BG1-style acknowledgement line on a BG1-C --out, or a drop total below the acknowledged one, refuses', () => {
    const j = inputs('bg1c-ack-format');
    const out = join(j.dir, 'bg1-custody-f');
    expect(mint(out, j, ['--fake', '--bg1c', '--count', '2', '--fake-break', '31:2:4,32:2:4']).code).toBe(3);
    expect(mint(out, j, ['--fake', '--bg1c', '--start', '33', '--count', '1', '--yield-gate-ack', 'a-0123456789ab']).code).toBe(0);
    const line = readFileSync(join(out, 'render', 'yield-gate-acks.jsonl'), 'utf8');
    writeFileSync(join(out, 'render', 'yield-gate-acks.jsonl'), line.replace(/,"drops":\d+/, ''));
    const bg1Line = mint(out, j, ['--fake', '--bg1c', '--start', '34', '--count', '1']);
    expect(bg1Line.code).toBe(2);
    expect(bg1Line.err).toContain('ends in a line that is not an acknowledgement');
    writeFileSync(join(out, 'render', 'yield-gate-acks.jsonl'), line.replace(/"drops":\d+/, '"drops":5').replace(/"early_drops":\d+/, '"early_drops":2'));
    const fell = mint(out, j, ['--fake', '--bg1c', '--start', '34', '--count', '1']);
    expect(fell.code).toBe(3);
    expect(fell.out).toBe('bg1-mint summary=refused reason=drops_below_ack mode=fake written=0 skipped=0 dropped=0 last_slot=33 drops=2 acked_total_drops=5\n');
    expect(existsSync(join(out, 'set', 'worlds', 'bg1-034'))).toBe(false);
  }, 240_000);

  // Value: protects=BG1-C's mint stops at the 40th kept world, so no slot past it is rendered or spent on; fails_when=the mint renders past 40 kept worlds, or counts worlds outside slots 31 to 96; why_new=BG1-C preregistration harness item 1 (minting stops at the 40th kept world); seam=mint.sh --bg1c with stub kept worlds; no_claim=validate.ts's own kept list (it is checked on a full set below)
  test('the mint stops with exit 0 at the 40th kept world, checked after each slot and before the first', () => {
    const j = inputs('bg1c-kept');
    const out = join(j.dir, 'bg1-custody-k40');
    mkdirSync(join(out, 'render'), { recursive: true });
    for (const slot of range(31, 69)) writeFileSync(join(out, 'render', `${id(slot)}.validation.json`), JSON.stringify({ world: id(slot), status: 'pass' }));
    const stop = mint(out, j, ['--fake', '--bg1c', '--start', '70']);
    expect(stop.code).toBe(0);
    expect(stop.out).toMatch(/^bg1-supply slots=31-35 gemini_requests=0 kept=5 per_kept_world=0\.0 limit=504 status=pass\nbg1-render slot=70 world=bg1-070 status=written /);
    expect(stop.out).toContain('bg1-mint summary=kept mode=fake kept=40 written=1 skipped=0 dropped=0 dropped_earlier=0 last_slot=70\n');
    expect(stop.out).not.toContain('slot=71');
    expect(existsSync(join(out, 'set', 'worlds', 'bg1-071'))).toBe(false);
    const done = mint(out, j, ['--fake', '--bg1c', '--start', '71']);
    expect(done.code).toBe(0);
    expect(done.out).toBe('bg1-mint summary=kept mode=fake kept=40 written=0 skipped=0 dropped=0 dropped_earlier=0 last_slot=70\n');
  }, 240_000);
});

describe('a BG1-C set end to end: mint, validate --bg1c, fill --bg1c and load', () => {
  // Value: protects=BG1-C's kept list is its first 40 passing slots from 31, pinned in its own manifest and loaded only by the bg1c loader; fails_when=validate plans a BG1-C world from the wrong slot, the fill accepts another N or writes BG1's manifest, or the loader reads it as BG1; why_new=BG1-C preregistration harness item 1; seam=mint.sh --bg1c --fake, validate.ts, fill-manifest.ts and corpus.ts loadBg1c; no_claim=the Gemini claim check or the second validator (fake checks)
  test('one drop among the first slots, the stop at the 40th kept world, then a 40-world manifest the bg1c loader reads', () => {
    const j = inputs('bg1c-e2e');
    const out = join(j.dir, 'bg1-custody-e2e'), set = join(out, 'set');
    const m = mint(out, j, ['--fake', '--bg1c', '--fake-break', '33:2:4'], '30000');
    expect(m.code).toBe(0);
    expect(m.out).toContain('bg1-mint summary=kept mode=fake kept=40 written=40 skipped=0 dropped=1 dropped_earlier=0 last_slot=71\n');
    expect(readdirSync(join(set, 'worlds')).sort()).toEqual(range(31, 71).filter(s => s !== 33).map(id));

    const report = join(j.dir, 'report.json');
    refusal(run('bun', [VALIDATE, '--bg1c', '--set', set, '--seed-file', j.seed, '--phrasing', j.phrasing, '--report', report, ...LENGTH, '--n-final', '41']), '--n-final must be a whole number from 1 to 40');
    const v = run('bun', [VALIDATE, '--bg1c', '--set', set, '--seed-file', j.seed, '--phrasing', j.phrasing, '--report', report, ...LENGTH, '--n-final', '40', '--fake']);
    expect(v.err).toBe('');
    expect(v.out).toMatch(/^bg1-validate checked=40 passed=40 failed=1 render_dropped=1 kept=40 gates=render:1 controls_dropped=0 report_sha256=[0-9a-f]{16}\n$/);
    const kept = (JSON.parse(readFileSync(report, 'utf8')) as { kept: string[] }).kept;
    expect(kept).toEqual(range(31, 71).filter(s => s !== 33).map(id));
    refusal(run('bun', [VALIDATE, '--set', set, '--seed-file', j.seed, '--phrasing', j.phrasing, '--report', join(j.dir, 'bg1.json'), ...LENGTH]), 'that are not BG1 mint slots');

    refusal(run('bun', [FILL, '--root', set, '--report', report, ...LENGTH]), 'not among BG1\'s 30 mint slots');
    const noN = join(j.dir, 'report-no-n.json');
    writeFileSync(noN, JSON.stringify({ ...JSON.parse(readFileSync(report, 'utf8')), n_final: null, kept }));
    refusal(run('bun', [FILL, '--bg1c', '--root', set, '--report', noN, ...LENGTH]), 'a BG1-C fill needs the report\'s n_final to be 40, the preregistered N, and it is absent');
    const f = run('bun', [FILL, '--bg1c', '--root', set, '--report', report, ...LENGTH, '--fake']);
    expect(f.err).toBe('');
    expect(f.out).toMatch(/^bg1-fill status=filled files=80 kept=40 first=bg1-031 last=bg1-071 n_final=40 earlier_fills=0 manifest_sha256=[0-9a-f]{64}\n$/);
    expect(existsSync(join(set, 'bg1-manifest.json'))).toBe(false);
    const filled = JSON.parse(readFileSync(join(set, 'bg1c-manifest.json'), 'utf8')) as Bg1Manifest;
    const template = JSON.parse(readFileSync(join(REPO, BG1C_MANIFEST), 'utf8')) as Bg1Manifest;
    expect({ ...filled, filled_at: null }).toEqual({ ...template, status: 'filled', files: bg1ManifestFiles(set, kept, BG1C_SET), filled_at: null, kept, n_final: BG1C_N_FINAL, drill: true });
    expect(filled.dataset).toBe(BG1C_DATASET);
    expect(bg1Kept(filled, BG1C_SET)).toEqual({ kept, n_final: 40 });

    const saved = { source: process.env.GBRAIN_EVALS_BG1C_SOURCE, manifest: process.env.GBRAIN_EVALS_BG1C_MANIFEST };
    try {
      process.env.GBRAIN_EVALS_BG1C_SOURCE = set;
      process.env.GBRAIN_EVALS_BG1C_MANIFEST = join(set, 'bg1c-manifest.json');
      expect(verifyBg1Custody(() => {}, BG1C_SET, { keyless: true })).toBe(80);
      const log = join(j.dir, 'access.jsonl');
      const c = loadBg1c({ log, decisionId: 'test', purpose: 'e2e' }, { worldEnd: '2026-11-15', only: new Set(['bg1-031', 'bg1-071']), keyless: true });
      expect(c.benchmark).toBe('bg1c');
      expect(c.conversations.map(x => x.id)).toEqual(['bg1-031', 'bg1-071']);
      expect(c.questions).toHaveLength(128);
      expect(c.source.revision).toBe(sha(readFileSync(join(set, 'bg1c-manifest.json'))).slice(0, 7));
      expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(2);
    } finally {
      for (const [k, v] of [['GBRAIN_EVALS_BG1C_SOURCE', saved.source], ['GBRAIN_EVALS_BG1C_MANIFEST', saved.manifest]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
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

describe('the sealed key in .gstack/pregate.json covers BG1-C\'s custody folder', () => {
  const sealed = JSON.parse(readFileSync(join(REPO, '.gstack/pregate.json'), 'utf8')).sealed as { paths: string[]; answer_markers: string[]; seed_patterns: string[]; case_insensitive: boolean };
  const pathHit = (rel: string) => sealed.paths.some(g => globRe(g, sealed.case_insensitive).test(rel));
  const textRules = [...sealed.answer_markers, ...sealed.seed_patterns].map(r => new RegExp(r));
  const textHit = (text: string) => text.split('\n').some(line => textRules.some(re => re.test(line)));

  // Value: protects=no BG1-C world, plan, question, render record or cache can be committed; fails_when=a file under a BG1-C custody folder, or one carrying BG1's answer marker under any name, passes the sealed key; why_new=BG1-C preregistration harness item 1 (the sealed pregate test); seam=the sealed key's globs and markers as gstack-pregate reads them; no_claim=gstack-pregate's own matcher (checked by hand on a throwaway repo, not here)
  test('refuses every file a BG1-C mint writes by its custody-folder path, and by the answer marker under any name', () => {
    const j = inputs('bg1c-sealed-key');
    const out = join(j.dir, 'bg1-custody-c');
    expect(mint(out, j, ['--fake', '--bg1c', '--count', '1']).code).toBe(0);
    const written = files(out);
    expect(written.some(p => p.endsWith('worlds/bg1-031/world.json'))).toBe(true);
    for (const path of written) expect(pathHit(relative(j.dir, path))).toBe(true);
    for (const path of files(join(out, 'set'))) {
      expect(textHit(readFileSync(path, 'utf8'))).toBe(true);
      expect(pathHit(`eval/data/innocent/${path.split('/').pop()}`)).toBe(false);
    }
    expect(pathHit('notes/bg1-custody-bg1c/render/bg1-031.json')).toBe(true);
    expect(textHit(`{"custody": "${BG1_CUSTODY_MARKER}"}`)).toBe(true);
  }, 120_000);

  test('the committed BG1-C files, its loader and cell code and these tests pass it', () => {
    const committed = ['eval/decisions/datasets/bg1c-manifest.json', 'eval/decisions/splits/bg1c.json', 'eval/decisions/splits/bg1.json', 'eval/runner/memory-qa/bg1-names.ts',
      'eval/runner/memory-qa/corpus.ts', 'eval/custody/bg1/mint.sh', 'eval/custody/bg1/validate.ts', 'eval/custody/bg1/fill-manifest.ts', 'test/eval/bg1c-loader.test.ts'].map(p => join(REPO, p));
    for (const path of [...committed, import.meta.path]) {
      expect(pathHit(relative(REPO, path))).toBe(false);
      expect(textHit(readFileSync(path, 'utf8'))).toBe(false);
    }
  });
});
