/**
 * Cat 40 Hard H4 section-delivery confirmation program
 * (docs/benchmarks/2026-11-24-cat40-h4-fix-confirmation-preregistration.md): the preregistered sealed worlds, arms,
 * readers, judges, halves and ledgers, and the exact command for every step of a world, in order.
 *
 *   bun eval/runner/cat40/h4fix-confirm.ts plan --world s3|s4|s5|s6|s7|s8 --build <40-character gbrain commit> --date YYYY-MM-DD [--stopped] [--json]
 *   bun eval/runner/cat40/h4fix-confirm.ts check-world --world <w> --file <world.json> --digest <digest recorded before cells>
 *
 * Each world runs on its own owner-custody VM with its own ledger. Both gbrain arms read the same slots, built once
 * per world by the release under test: `gbrain-section` sets search.long_page_unit=section after every restore and
 * `gbrain-default` runs the release's shipping defaults. Every reader runs its own invocation, so each gets the judge
 * the preregistration names: gpt-6.2-sol grades claude-opus-5-5 rows, claude-opus-5-5 grades gpt-6.2-sol and
 * particle-1 rows. H4 runs on all six worlds; H1, H2, H3 and H5 only on S3 and S4. The gbrain arms' frontier H4 cells
 * run twice (repeat 2); everything else runs once. particle-1 steps come last and run only inside a granted paid
 * window. Dollar caps are `$CAP_<STEP>` placeholders the operator fills from the tracking issue (R79). `plan` refuses
 * unless the preregistration is committed, unchanged and on origin.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { hardWorldDigest } from '../../generators/model-ladder-hard.ts';
import type { HardWorld } from '../../generators/hard/schema.ts';
import { attestPreregistration } from '../prereg.ts';
import { checkHardWorld } from './hard.ts';

export type H4FixWorld = 's3' | 's4' | 's5' | 's6' | 's7' | 's8';

export const H4FIX_PREREG = 'docs/benchmarks/2026-11-24-cat40-h4-fix-confirmation-preregistration.md';
export const H4FIX_WORLDS: readonly H4FixWorld[] = ['s3', 's4', 's5', 's6', 's7', 's8'];
/** S3 and S4 carry every family (the no-harm check); S5 to S8 carry H4 only. */
export const FULL_WORLDS: readonly H4FixWorld[] = ['s3', 's4'];
export const FAMILIES = ['H1', 'H2', 'H3', 'H4', 'H5'] as const;
export const OTHER_FAMILIES = ['H1', 'H2', 'H3', 'H5'] as const;
/** GST-3786's commit (get_page grep reads a|b as alternatives): the release under test must contain it (launch gate). */
export const GREP_FIX_COMMIT = '9df317b1573638986082e5866a5fcd6d5bc9f1ad';
export const SECTION_CONFIG = 'search.long_page_unit=section';
export const ARMS = { section: 'gbrain-section', default: 'gbrain-default' } as const;
export const FRONTIER = ['claude-opus-5-5', 'gpt-6.2-sol'] as const;
export const PARTICLE = 'particle-1';
/** The claims judge per reader: no family grades its own rows, particle-1 never judges. */
export const JUDGE_FOR: Record<string, string> = { 'claude-opus-5-5': 'gpt-6.2-sol', 'gpt-6.2-sol': 'claude-opus-5-5', 'particle-1': 'claude-opus-5-5' };
export const SLOTS: Record<H4FixWorld, number> = { s3: 5, s4: 5, s5: 2, s6: 2, s7: 2, s8: 2 };
export const CONCURRENCY: Record<H4FixWorld, number> = { s3: 10, s4: 10, s5: 4, s6: 4, s7: 4, s8: 4 };
export const H4FIX_REPORTS = 'eval/reports/cat40/h4fix-confirm';
export const ledgerFor = (w: H4FixWorld) => `.budget/cat40-h4fix-${w}.sqlite`;
export const gbrainRootFor = (w: H4FixWorld) => `/home/ubi/cat40/h4fix-${w}`;

/** The one interim look (R113): H4 runs in two halves fixed by task id. Half A is H4-01 to H4-10, half B H4-11 to H4-20. */
export const HALVES = { a: [1, 10], b: [11, 20] } as const;
export const h4Half = (half: keyof typeof HALVES) =>
  Array.from({ length: HALVES[half][1] - HALVES[half][0] + 1 }, (_, i) => `H4-${String(HALVES[half][0] + i).padStart(2, '0')}`);

export function driftNote(harnessSha: string, date: string): string {
  return `${H4FIX_PREREG}: harness ${harnessSha}; drift is listed in docs/benchmarks/cat40-hard/accepted-drift.json; the world-shaping code is unchanged (${date})`;
}

/** A hold stops the operator's driver until the named record is committed; it runs nothing. */
export interface Step { id: string; argv: string[]; note?: string; paid_window?: 'particle'; hold?: 'record' | 'look' }

const cap = (id: string) => `$CAP_${id.toUpperCase().replace(/-/g, '_')}`;
const short = (m: string) => (m.startsWith('claude') ? 'opus' : m.startsWith('gpt') ? 'sol' : 'particle');

/** Every step of one world, in order. */
/** After a stop at the look (`stopped`), particle-1 runs H4 half A and, on S3 and S4, the other families, as an explicit task list. */
export function worldPlan(world: H4FixWorld, build: string, harnessSha: string, date: string, stopped = false): Step[] {
  if (!/^[0-9a-f]{40}$/.test(build)) throw new Error(`build ${build} is not a 40-character gbrain commit`);
  const dir = `${H4FIX_REPORTS}/${world}`;
  const file = `${dir}/world/world.json`;
  const ledger = ledgerFor(world);
  const full = FULL_WORLDS.includes(world);
  const drift = ['--accept-freeze-drift', driftNote(harnessSha, date)];
  const common = ['--world', file, '--concurrency', String(CONCURRENCY[world]), '--budget-ledger', ledger, '--transcripts', ...drift];
  const slotArgs = ['--gbrain-repo', '../gbrain', '--gbrain-ref', build, '--gbrain-root', gbrainRootFor(world), '--slots', String(SLOTS[world]), '--no-pglite-analyze'];
  const gbrain = (arm: keyof typeof ARMS) => ['--arms', 'gbrain', '--gbrain-label', ARMS[arm], ...slotArgs, ...(arm === 'section' ? ['--gbrain-config', SECTION_CONFIG] : [])];
  const run = (id: string, model: string, arm: string[], extra: string[], note?: string): Step => ({
    id, argv: ['bun', 'eval/runner/cat40-model-ladder.ts', ...common, '--models', model, '--judge', JUDGE_FOR[model], ...arm, ...extra, '--out', `${dir}/${id}`, '--budget-usd', cap(id)],
    ...(note ? { note } : {}), ...(model === PARTICLE ? { paid_window: 'particle' as const } : {}),
  });
  const families = full ? FAMILIES.join(',') : 'H4';
  const otherTasks = OTHER_FAMILIES.flatMap(f => Array.from({ length: 20 }, (_, i) => `${f}-${String(i + 1).padStart(2, '0')}`));
  const particleSel = stopped ? ['--tasks', [...h4Half('a'), ...(full ? otherTasks : [])].join(',')] : ['--families', families];
  const h4 = (half: keyof typeof HALVES) => ['--tasks', h4Half(half).join(',')];
  const halfSteps = (half: keyof typeof HALVES): Step[] => FRONTIER.flatMap(m => [
    run(`section-${short(m)}-h4${half}`, m, gbrain('section'), [...h4(half), '--repeat', '2']),
    run(`default-${short(m)}-h4${half}`, m, gbrain('default'), [...h4(half), '--repeat', '2']),
    run(`fs-${short(m)}-h4${half}`, m, ['--arms', 'fs', '--hard-tool-limits', 'hard'], [...h4(half), '--repeat', '1']),
  ]);
  const pilots: Step[] = world !== 's3' ? [] : [
    ...FRONTIER.flatMap(m => [
      run(`pilot-section-${short(m)}`, m, gbrain('section'), ['--per-family', '1', '--repeat', '1'], 'five cells; every cell calls gbrain tools with no param_not_on_surface, and the arm\'s pilot or the oracle-gate H4 probe shows a search row delivered {unit: section, reason: long_page}; if none does, rerun this step with --families H4 --per-family 5 into pilot-section-<reader>-h4; never counted'),
      run(`pilot-default-${short(m)}`, m, gbrain('default'), ['--per-family', '1', '--repeat', '1'], 'five cells; every cell calls gbrain tools with no param_not_on_surface, and no search row carries reason long_page; never counted'),
      run(`pilot-fs-${short(m)}`, m, ['--arms', 'fs', '--hard-tool-limits', 'hard'], ['--per-family', '1', '--repeat', '1'], 'five cells; every cell calls grep and read_file; never counted'),
    ]),
  ];
  return [
    { id: 'ledger', argv: ['bun', 'eval/runner/budget-ledger.ts', 'init', '--budget-ledger', ledger, '--program-cap-usd', cap('program'), '--reason', `Cat 40 Hard H4 section-delivery confirmation, world ${world} (${H4FIX_PREREG})`], note: 'once per VM' },
    { id: 'launch-gate', argv: ['git', '-C', '../gbrain', 'merge-base', '--is-ancestor', GREP_FIX_COMMIT, build], note: 'the release under test contains GST-3786; exit 0 or no cell runs' },
    { id: 'check-world', argv: ['bun', 'eval/runner/cat40/h4fix-confirm.ts', 'check-world', '--world', world, '--file', file, '--digest', `<${world} digest recorded before cells>`] },
    { id: 'freshness', argv: ['bun', 'scripts/model-freshness.ts', '--models', [...FRONTIER, PARTICLE].map(m => `${m.startsWith('gpt') ? 'openai' : m.startsWith('particle') ? 'particle' : 'anthropic'}:${m}`).join(',')], note: 'must exit 0 with no newer frontier Opus or GPT (gate 6)' },
    { id: 'slots', argv: ['bun', 'eval/runner/cat40-model-ladder.ts', '--build-slots', '--world', file, ...slotArgs, ...drift, '--slot-build-allowance-usd', cap('slot-allowance'), '--budget-ledger', ledger, '--out', `${dir}/slots`, '--budget-usd', cap('slots')],
      note: `one build for both gbrain arms (section delivery is read-time): re-read gbrain's tags first (the build freezes here); every slot passes the write, restore and rerank probes with 0 queued effects; the receipt names ${build} (gate 3)` },
    ...FRONTIER.map(m => run(`oracle-${short(m)}`, m, ['--arms', 'oracle'], ['--families', families, '--repeat', '1'])),
    { id: 'oracle-gate', argv: ['bun', 'eval/runner/cat40/hard-ops.ts', 'oracle-gate', '--models', FRONTIER.join(','), '--attempts', FRONTIER.map(m => `${dir}/oracle-${short(m)}/attempts.jsonl`).join(',')], note: 'pooled frontier oracle success >= 95%, or stop this world (gate 4)' },
    ...pilots,
    { id: 'hold-record', argv: [], hold: 'record', note: 'the judge check (eval/runner/cat40/h4fix-judge-check.ts on N1, once for all worlds), slot receipts, oracle gate and pilots are committed under "Recorded before cells" before any counted cell' },
    ...halfSteps('a'),
    ...(full ? FRONTIER.flatMap(m => [
      run(`section-${short(m)}-other`, m, gbrain('section'), ['--families', OTHER_FAMILIES.join(','), '--repeat', '1']),
      run(`default-${short(m)}-other`, m, gbrain('default'), ['--families', OTHER_FAMILIES.join(','), '--repeat', '1']),
      run(`fs-${short(m)}-other`, m, ['--arms', 'fs', '--hard-tool-limits', 'hard'], ['--families', OTHER_FAMILIES.join(','), '--repeat', '1']),
    ]) : []),
    { id: 'interim-look', argv: [], hold: 'look', note: 'every world finished half A for both gbrain arms and both frontier readers; h4fix_analysis.py --look interim decides; half B runs only if it continues (R113)' },
    ...(stopped ? [] : halfSteps('b')),
    ...(world === 's3' ? [
      run('pilot-particle-section', PARTICLE, gbrain('section'), ['--per-family', '1', '--repeat', '1'], 'particle-1 pilot inside the granted window; never counted'),
      run('pilot-particle-default', PARTICLE, gbrain('default'), ['--per-family', '1', '--repeat', '1'], 'never counted'),
      run('pilot-particle-fs', PARTICLE, ['--arms', 'fs', '--hard-tool-limits', 'hard'], ['--per-family', '1', '--repeat', '1'], 'never counted'),
    ] : []),
    run('section-particle', PARTICLE, gbrain('section'), [...particleSel, '--repeat', '1'], `descriptive; inside the granted Particle window, one world at a time, after this world's frontier cells${stopped ? '; the look stopped, so H4 half B is dropped' : ''}`),
    run('default-particle', PARTICLE, gbrain('default'), [...particleSel, '--repeat', '1']),
    run('fs-particle', PARTICLE, ['--arms', 'fs', '--hard-tool-limits', 'hard'], [...particleSel, '--repeat', '1']),
  ];
}

/** Validates a sealed world against its generator and the digest recorded before cells; returns the digest. Never prints content. */
export function checkWorld(world: H4FixWorld, w: HardWorld, path: string, digest: string | undefined): string {
  if (!digest || !/^[0-9a-f]{64}$/.test(digest)) throw new Error(`${world}: pass --digest <the digest recorded before cells for this world>`);
  if (!w.version.startsWith('hard-sealed')) throw new Error(`${world}: version ${w.version} is not the sealed generator`);
  if ((w.scale ?? 'v1') !== 'large') throw new Error(`${world}: scale ${w.scale ?? 'v1'} is not the preregistered --scale large`);
  checkHardWorld(w, path);
  const got = hardWorldDigest(w);
  if (got !== digest) throw new Error(`${world}: world digest ${got} is not the recorded ${digest}`);
  return got;
}

const q = (a: string) => (/^[A-Za-z0-9_./:=,@+$-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const opt = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const world = opt('--world') as H4FixWorld | undefined;
  if (!world || !H4FIX_WORLDS.includes(world)) { console.error('usage: h4fix-confirm.ts plan --world s3..s8 --build <sha> --date YYYY-MM-DD [--json] | check-world --world <w> --file <world.json> --digest <d>'); process.exit(2); }
  if (argv[0] === 'plan') {
    const date = opt('--date');
    const build = opt('--build') ?? '';
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { console.error('plan needs --date YYYY-MM-DD (the date in the drift note)'); process.exit(2); }
    if (!/^[0-9a-f]{40}$/.test(build)) { console.error('plan needs --build <the 40-character commit of the release under test>'); process.exit(2); }
    let attestation;
    try { attestation = attestPreregistration(H4FIX_PREREG); } catch (e) { console.error(`[h4fix-confirm] STOP: ${(e as Error).message}`); process.exit(3); }
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const steps = worldPlan(world, build, sha, date, argv.includes('--stopped'));
    if (argv.includes('--json')) console.log(JSON.stringify({ world, harness: sha, build, attestation, steps }, null, 2));
    else { console.log(`# attestation ${JSON.stringify(attestation)}`); for (const s of steps) console.log(`# ${s.id}${s.paid_window ? ' [Particle paid window]' : ''}${s.hold ? ` [hold: ${s.hold}]` : ''}${s.note ? ` (${s.note})` : ''}\n${s.argv.map(q).join(' ')}`); }
  } else if (argv[0] === 'check-world') {
    const file = opt('--file');
    if (!file) { console.error('check-world needs --file <world.json>'); process.exit(2); }
    try { console.log(JSON.stringify({ world, valid: true, digest: checkWorld(world, JSON.parse(readFileSync(file, 'utf8')) as HardWorld, file, opt('--digest')) })); }
    catch (e) { console.error(`[h4fix-confirm] STOP: ${(e as Error).message}`); process.exit(3); }
  } else { console.error('unknown command'); process.exit(2); }
}
