/**
 * Cat 40 Hard H4 section-delivery confirmation program (eval/runner/cat40/h4fix-confirm.ts) and its analysis
 * (eval/runner/cat40/h4fix_analysis.py), against the preregistration
 * docs/benchmarks/2026-11-24-cat40-h4-fix-confirmation-preregistration.md. Keyless.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ARMS, FRONTIER, FULL_WORLDS, GREP_FIX_COMMIT, H4FIX_WORLDS, JUDGE_FOR, PARTICLE, SECTION_CONFIG, h4Half, worldPlan } from '../../eval/runner/cat40/h4fix-confirm.ts';

const BUILD = 'e'.repeat(40);
const SHA = 'f'.repeat(40);
const val = (argv: string[], f: string) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined) as string;
const family = (m: string) => (m.startsWith('claude') ? 'anthropic' : m.startsWith('gpt') ? 'openai' : 'particle');

describe('h4fix-confirm plan', () => {
  for (const w of H4FIX_WORLDS) {
    const steps = worldPlan(w, BUILD, SHA, '2026-11-25');
    const ladder = steps.filter(s => s.argv[1] === 'eval/runner/cat40-model-ladder.ts' && !s.argv.includes('--build-slots'));
    test(`${w}: no family judges its own rows, particle-1 never judges, and no suspended or older model appears`, () => {
      for (const s of ladder) {
        const model = val(s.argv, '--models');
        expect(val(s.argv, '--judge')).toBe(JUDGE_FOR[model]);
        expect(family(val(s.argv, '--judge'))).not.toBe(family(model));
        expect(val(s.argv, '--judge')).not.toBe(PARTICLE);
      }
      expect(JSON.stringify(steps)).not.toMatch(/gpt-4o|gpt-4\.1|gpt-5\.4-mini|sonnet|haiku/);
    });
    test(`${w}: particle-1 steps are the last ones and all sit in the paid window`, () => {
      const first = steps.findIndex(s => s.paid_window);
      expect(first).toBeGreaterThan(0);
      expect(steps.slice(first).every(s => s.paid_window === 'particle' && val(s.argv, '--models') === PARTICLE)).toBe(true);
      expect(steps.slice(0, first).some(s => s.argv.includes(PARTICLE))).toBe(false);
    });
    test(`${w}: both gbrain arms read one build and one slot root; only gbrain-section sets section delivery`, () => {
      const g = ladder.filter(s => s.argv.includes('--gbrain-label'));
      expect(new Set(g.map(s => val(s.argv, '--gbrain-ref')))).toEqual(new Set([BUILD]));
      expect(new Set(g.map(s => val(s.argv, '--gbrain-root'))).size).toBe(1);
      for (const s of g) {
        const arm = val(s.argv, '--gbrain-label');
        expect([ARMS.section, ARMS.default]).toContain(arm);
        expect(s.argv.includes('--gbrain-config')).toBe(arm === ARMS.section);
        if (arm === ARMS.section) expect(val(s.argv, '--gbrain-config')).toBe(SECTION_CONFIG);
        expect(s.argv).not.toContain('--gbrain-build-config');
      }
      expect(steps.filter(s => s.argv.includes('--build-slots'))).toHaveLength(1);
      expect(steps.find(s => s.id === 'launch-gate')!.argv).toEqual(['git', '-C', '../gbrain', 'merge-base', '--is-ancestor', GREP_FIX_COMMIT, BUILD]);
    });
    test(`${w}: frontier gbrain H4 cells run twice, everything else once; S5 to S8 carry H4 only`, () => {
      for (const s of ladder) {
        const h4 = (val(s.argv, '--tasks') ?? '').startsWith('H4-');
        const gbrainFrontier = s.argv.includes('--gbrain-label') && FRONTIER.includes(val(s.argv, '--models') as typeof FRONTIER[number]) && !s.id.startsWith('pilot');
        expect(val(s.argv, '--repeat')).toBe(h4 && gbrainFrontier ? '2' : '1');
        if (!FULL_WORLDS.includes(w)) {
          const fam = val(s.argv, '--families');
          if (fam) expect(fam).toBe('H4');
          if (s.argv.includes('--tasks')) expect(val(s.argv, '--tasks').split(',').every(t => t.startsWith('H4-'))).toBe(true);
        }
      }
      expect(steps.some(s => s.id.endsWith('-other'))).toBe(FULL_WORLDS.includes(w));
    });
    test(`${w}: pilots (S3 only), the record hold, half A, the one look, then half B`, () => {
      const ids = steps.map(s => s.id);
      expect(ids.some(i => i.startsWith('pilot-') && !i.includes('particle'))).toBe(w === 's3');
      const record = ids.indexOf('hold-record'), look = ids.indexOf('interim-look');
      expect(ids.findIndex(i => /-h4a$/.test(i))).toBeGreaterThan(record);
      expect(Math.max(...ids.map((i, k) => (/-h4a$|-other$/.test(i) ? k : -1)))).toBeLessThan(look);
      expect(ids.findIndex(i => /-h4b$/.test(i))).toBeGreaterThan(look);
      expect(ids.slice(0, record).some(i => /-h4[ab]$|-other$/.test(i))).toBe(false);
      for (const half of ['a', 'b'] as const) for (const s of steps.filter(x => x.id.endsWith(`-h4${half}`))) expect(val(s.argv, '--tasks')).toBe(h4Half(half).join(','));
    });
    test(`${w}: every cap is a placeholder, never a dollar figure (R79)`, () => {
      for (const s of steps.filter(x => x.argv.includes('--budget-usd'))) expect(val(s.argv, '--budget-usd')).toMatch(/^\$CAP_[A-Z0-9_]+$/);
      expect(val(steps[0].argv, '--program-cap-usd')).toBe('$CAP_PROGRAM');
    });
  }
  test('the halves are disjoint and together are H4-01 to H4-20', () => {
    const a = h4Half('a'), b = h4Half('b');
    expect(a).toHaveLength(10);
    expect(b).toHaveLength(10);
    expect([...a, ...b]).toEqual(Array.from({ length: 20 }, (_, i) => `H4-${String(i + 1).padStart(2, '0')}`));
  });
  test('a build that is not a 40-character commit is refused', () => {
    expect(() => worldPlan('s3', 'v0.60.774.0', SHA, '2026-11-25')).toThrow(/40-character/);
  });
});

describe('h4fix_analysis.py', () => {
  const SCRIPT = 'eval/runner/cat40/h4fix_analysis.py';
  const WORLDS = ['S3', 'S4', 'S5', 'S6', 'S7', 'S8'];
  const H4 = Array.from({ length: 20 }, (_, i) => `H4-${String(i + 1).padStart(2, '0')}`);
  const OTHER = ['H1', 'H2', 'H3', 'H5'].flatMap(f => Array.from({ length: 20 }, (_, i) => `${f}-${String(i + 1).padStart(2, '0')}`));
  type Ok = (arm: string, model: string, task: string, rep: number, world: string) => boolean;
  interface Opts { h4?: string[]; models?: string[]; drop?: string; other?: boolean }
  function worldFile(dir: string, name: string, ok: Ok, o: Opts = {}) {
    const lines: string[] = [];
    const tasks = [...(o.h4 ?? H4), ...((o.other ?? true) && (name === 'S3' || name === 'S4') ? OTHER : [])];
    for (const model of o.models ?? [...FRONTIER, PARTICLE]) for (const arm of ['gbrain-section', 'gbrain-default', 'fs']) for (const t of tasks) {
      const reps = t.startsWith('H4') && arm !== 'fs' && model !== PARTICLE ? 2 : 1;
      for (let rep = 0; rep < reps; rep++) {
        if (o.drop === `${arm}|${model}|${t}|${rep}`) continue;
        lines.push(JSON.stringify({ attempt_id: `${name}|${model}|${arm}|${t}|${rep}#1`, attempt: 1, arm, model, task: t, repeat: rep, stop: 'submitted',
          score: { success: ok(arm, model, t, rep, name), submitted: true }, claims: { supported: 1, unsupported: 0, contradicted: 0 }, total_usd: 0.1, judge_usd: 0.01 }));
      }
    }
    const p = join(dir, `${name}.jsonl`);
    writeFileSync(p, lines.join('\n') + '\n');
    return `${name}=${p}`;
  }
  const analyse = (ok: Ok, extra: string[] = [], o: Opts = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'h4fix-analysis-'));
    const out = join(dir, 'out.json');
    const worlds = WORLDS.map(w => worldFile(dir, w, ok, o));
    const r = spawnSync('python3', [SCRIPT, ...worlds.flatMap(w => ['--world', w]), '--resamples', '1000', '--json', out, ...extra], { encoding: 'utf8' });
    const json = r.status === 0 ? JSON.parse(readFileSync(out, 'utf8')) : null;
    rmSync(dir, { recursive: true, force: true });
    return { code: r.status, json, err: r.stderr };
  };
  const n = (t: string) => Number(t.slice(3));
  const py = (expr: string) => execFileSync('python3', ['-c', `import sys; sys.path.insert(0, 'eval/runner/cat40'); import h4fix_analysis as a; print(${expr})`], { encoding: 'utf8' }).trim();

  describe('the one interim look at H4 half A (R113, as amended)', () => {
    const halfA = { h4: H4.slice(0, 10), other: false, models: [...FRONTIER] };
    const look = (ok: Ok) => analyse(ok, ['--look', 'interim'], halfA);
    test('refuses anything but exactly half A', () => {
      const all = analyse(() => true, ['--look', 'interim'], { models: [...FRONTIER] });
      expect(all.code).not.toBe(0);
      expect(all.err).toContain('INTERIM_INCOMPLETE');
      expect(analyse(() => true, ['--look', 'interim'], { ...halfA, drop: 'gbrain-default|claude-opus-5-5|H4-03|1' }).err).toContain('INTERIM_INCOMPLETE');
    });
    test('a zero bootstrap standard error takes no stop', () => {
      expect(look(() => true).json.headline).toMatchObject({ delta_pp: 0, se_pp: 0, decision: 'continue', stopped_early: false });
    });
    test('stops for a difference at |z| >= 2.80 and calls the estimate possibly overstated', () => {
      const h = look((arm, _m, t) => arm === 'gbrain-section' || n(t) % 2 === 0).json.headline;
      expect(h).toMatchObject({ delta_pp: 50, decision: 'stop: difference, section delivery ahead', possibly_overstated: true });
      expect(h.z).toBeGreaterThanOrEqual(2.8);
    });
    test('stops for futility only when both a gain and harm are out of reach', () => {
      const h = look((arm, _m, t, _r, w) => (arm === 'gbrain-section') === ((n(t) + WORLDS.indexOf(w)) % 2 === 0)).json.headline;
      expect(h).toMatchObject({ delta_pp: 0, decision: 'stop: futility', stopped_early: true });
      expect(h.conditional_power_gain).toBeLessThan(0.1);
      expect(h.conditional_power_harm).toBeLessThan(0.1);
    });
    test('a look trending toward harm keeps running', () => {
      const k = (t: string, w: string) => WORLDS.indexOf(w) + 6 * (n(t) - 1);
      const h = look((arm, _m, t, _r, w) => { const i = k(t, w); return arm === 'gbrain-section' ? !(i < 20) : !(i >= 20 && i < 30); }).json.headline;
      expect(h.delta_pp).toBeLessThan(0);
      expect(Math.abs(h.z)).toBeLessThan(2.8);
      expect(h.conditional_power_gain).toBeLessThan(0.1);
      expect(h.conditional_power_harm).toBeGreaterThanOrEqual(0.1);
      expect(h.decision).toBe('continue');
    });
  });

  describe('the final analysis', () => {
    test('a paired gain with no harm takes the flip to Garry; the gap reads level at a tie', () => {
      const r = analyse((arm, _m, t) => !t.startsWith('H4') || arm !== 'gbrain-default' || n(t) % 2 === 0);
      expect(r.code).toBe(0);
      expect(r.json.primary).toMatchObject({ delta_pp: 50, interval_key: 'ci_z1.98', wording: 'helps' });
      expect(r.json.no_harm_other_families).toMatchObject({ delta_pp: 0, no_harm: true, margin_pp: -5 });
      expect(r.json.decision_row).toBe('flip to Garry');
      expect(r.json.secondary.gap_to_files.pooled.wording).toBe('level with files');
      expect(r.json.secondary.particle.descriptive).toBe(true);
    });
    test('a missing planned frontier cell refuses; a missing particle-1 cell leaves only its row incomplete', () => {
      expect(analyse(() => true, [], { drop: 'gbrain-section|gpt-6.2-sol|H4-07|1' }).err).toContain('FINAL_INCOMPLETE');
      const p = analyse(() => true, [], { drop: 'fs|particle-1|H4-07|0' });
      expect(p.code).toBe(0);
      expect(p.json.secondary.particle.incomplete).toBeDefined();
    });
    test('after a stop for a difference the H4 rows read half A at z 2.80 and say so', () => {
      const r = analyse((arm, _m, t) => arm !== 'gbrain-default' || n(t) % 2 === 0, ['--stopped', 'difference'], { h4: H4.slice(0, 10) });
      expect(r.json.primary).toMatchObject({ interval_key: 'ci_z2.80', possibly_overstated: true, tasks: 60 });
      expect(r.json.h4_secondaries_label).toBe('half A only');
    });
    test('wording: behind takes precedence over level, ahead needs a lower bound above 0, and the margin never widens', () => {
      expect(py("a.gap_wording([-2.5, -0.5]), a.gap_wording([-2.5, 1.0]), a.gap_wording([0.5, 4.0]), a.gap_wording([-4.0, 2.0])"))
        .toBe('behind files level with files ahead of files not distinguishable from files');
      expect(py("a.primary_wording([0.1, 9]), a.primary_wording([-9, -0.1]), a.primary_wording([-1, 9])")).toBe('helps hurts not distinguishable');
      expect(py("a.decision_row('helps', False), '/', a.decision_row('not distinguishable', True), '/', a.decision_row('hurts', True)"))
        .toBe('helps, harm not ruled out: scoped version to GBRA-108 / closed: not distinguishable (Why null) / closed: hurts');
      expect(py('a.NO_HARM_MARGIN')).toBe('-5.0');
    });
    test('conditional power is symmetric between a gain and harm', () => {
      expect(py('round(a.conditional_power(1.0, se_interim=8.0), 6) == round(a.conditional_power(-(-1.0), se_interim=8.0), 6), round(a.conditional_power(0.0, se_interim=12.9), 3)')).toBe('True 0.032');
    });
  });

  test('transcript counts separate setting-driven section delivery from units the agent asked for', () => {
    const dir = mkdtempSync(join(tmpdir(), 'h4fix-tx-'));
    const tx = join(dir, 't.jsonl');
    const call = (name: string, args: object, result: string) => ({ name, args, result });
    writeFileSync(tx, [
      { key: 'claude-opus-5-5|gbrain-section|H4-01|0', tools: [call('search', { query: 'x' }, '{"results":[{"delivered":{"unit":"section","reason":"long_page"}}]}'), call('search', { query: 'y', return_unit: 'section' }, '{"results":[{"delivered":{"unit":"section"}}]}')] },
      { key: 'claude-opus-5-5|gbrain-default|H4-01|0', tools: [call('get_page', { slug: 'p', grep: 'a|b' }, JSON.stringify({ grep: { total_matches: 2 } })), call('get_page', { slug: 'p', grep: 'c|d' }, JSON.stringify({ grep: { total_matches: 0 } }))] },
    ].map(x => JSON.stringify(x)).join('\n') + '\n');
    const out = py(`json.dumps(a.tool_stats(['${tx}']), sort_keys=True)`.replace('json.dumps', '__import__("json").dumps'));
    rmSync(dir, { recursive: true, force: true });
    expect(JSON.parse(out)).toEqual({
      'gbrain-default|claude-opus-5-5': { grep_alternation: 2, grep_alternation_matched: 1 },
      'gbrain-section|claude-opus-5-5': { search: 2, search_long_page: 1, search_explicit_return_unit: 1 },
    });
  });
});
