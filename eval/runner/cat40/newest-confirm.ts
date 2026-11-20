/**
 * Cat 40 Hard newest-build re-measure program (docs/benchmarks/2026-11-19-cat40-hard-newest-preregistration.md): the
 * preregistered worlds, build, readers, judges and ledgers, and the exact command for every step of a world, in order.
 *
 *   bun eval/runner/cat40/newest-confirm.ts plan --world n1|n2 --date YYYY-MM-DD [--json]
 *   bun eval/runner/cat40/newest-confirm.ts check-world --world n1|n2 --file <world.json>
 *
 * Each world runs on its own VM with its own ledger. Every reader runs its own invocation, so each gets the judge the
 * preregistration names: gpt-6.1-sol grades claude-opus-5-5 and particle-1 rows, claude-opus-5-5 grades gpt-6.2-sol
 * rows. particle-1 steps come last and run only inside a granted paid window, one world at a time. Dollar caps are not
 * part of the public program (R79): every `--budget-usd` and the ledger's program cap are `$CAP_<STEP>` placeholders
 * the operator fills from the tracking issue. `plan` refuses unless the preregistration is committed, unchanged and on
 * origin (attestPreregistration), and prints the attestation.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { hardWorldDigest } from '../../generators/model-ladder-hard.ts';
import { HARD_SEEDS, type HardWorld } from '../../generators/hard/schema.ts';
import { attestPreregistration } from '../prereg.ts';
import { checkHardWorld } from './hard.ts';

export type NewestWorld = 'n1' | 'n2';

export const NEWEST_PREREG = 'docs/benchmarks/2026-11-19-cat40-hard-newest-preregistration.md';
export const NEWEST_WORLDS: Record<NewestWorld, { seed: number; digest: string; file_sha256: string }> = {
  n1: { seed: HARD_SEEDS.newest[0], digest: '647d6123621842a5b43ec7291e94b440e18bd03bb0209f6b94c46d36cd5f52ac', file_sha256: '364c578a0986492483d56d161cf0f7f89afb330f70d3c2d6a2c9e8cf4e80e937' },
  n2: { seed: HARD_SEEDS.newest[1], digest: '08120edcd14f7151ef2f785d1e62ec40639ede8fc28c49924c846b28262e3814', file_sha256: '97e791d9bc693de1b06be962de679743b1459916872ac093f23162e0cfddd072' },
};
export const FRONTIER = ['claude-opus-5-5', 'gpt-6.2-sol'] as const;
export const PARTICLE = 'particle-1';
/** The claims judge per reader: the protocol judge for Claude and particle-1 rows, Opus for GPT rows. */
export const JUDGE_FOR: Record<string, string> = { 'claude-opus-5-5': 'gpt-6.1-sol', 'gpt-6.2-sol': 'claude-opus-5-5', 'particle-1': 'gpt-6.1-sol' };
export const NEWEST_LABEL = 'gbrain-newest';
export const NEWEST_SLOTS = 5;
export const NEWEST_REPORTS = 'eval/reports/cat40/hard-newest';
export const ledgerFor = (w: NewestWorld) => `.budget/cat40-hard-newest-${w}.sqlite`;
export const gbrainRootFor = (w: NewestWorld) => `/home/ubi/cat40/hard-newest-${w}`;

/** The gbrain commit package.json pins: the build every slot and gbrain cell of both worlds uses. */
export function pinnedBuild(pkg: { dependencies?: Record<string, string> } = JSON.parse(readFileSync('package.json', 'utf8'))): string {
  const m = /#([0-9a-f]{40})$/.exec(pkg.dependencies?.gbrain ?? '');
  if (!m) throw new Error('package.json pins gbrain to no 40-character commit; run bun eval/runner/gbrain-pin.ts bump');
  return m[1];
}

export function driftNote(harnessSha: string, date: string): string {
  return `${NEWEST_PREREG}: harness ${harnessSha}; drift is listed in docs/benchmarks/cat40-hard/accepted-drift.json (2026-11-19 entries: stateless OpenAI requests and per-request pricing in loop.ts, the newest seeds in schema.ts and hard.ts) (${date})`;
}

/**
 * The one interim look (R113, amendment of 2026-11-19): the counted frontier cells run in two halves of every world's
 * tasks, fixed by id before any counted cell. Half A is tasks 01 to 10 of each family, half B tasks 11 to 20. Both
 * worlds finish half A for both arms and both readers, then the look runs; half B runs only if the look continues.
 */
export const HALVES = { a: [1, 10], b: [11, 20] } as const;
export const halfTasks = (half: keyof typeof HALVES) =>
  ['H1', 'H2', 'H3', 'H4', 'H5'].flatMap(f => Array.from({ length: HALVES[half][1] - HALVES[half][0] + 1 }, (_, i) => `${f}-${String(HALVES[half][0] + i).padStart(2, '0')}`));

/** A hold stops the operator's driver until the named release file exists; it runs nothing. */
export interface Step { id: string; argv: string[]; note?: string; paid_window?: 'particle'; hold?: 'record' | 'look' }

const cap = (id: string) => `$CAP_${id.toUpperCase().replace(/-/g, '_')}`;

/** Every step of one world, in order. */
export function worldPlan(world: NewestWorld, build: string, harnessSha: string, date: string): Step[] {
  const dir = `${NEWEST_REPORTS}/${world}`;
  const file = `${dir}/world/world.json`;
  const ledger = ledgerFor(world);
  const common = ['--world', file, '--concurrency', '10', '--repeat', '1', '--budget-ledger', ledger, '--transcripts', '--accept-freeze-drift', driftNote(harnessSha, date)];
  const gbrain = ['--arms', 'gbrain', '--gbrain-label', NEWEST_LABEL, '--gbrain-repo', '../gbrain', '--gbrain-ref', build, '--gbrain-root', gbrainRootFor(world), '--slots', String(NEWEST_SLOTS), '--no-pglite-analyze'];
  const run = (id: string, model: string, arm: string[], extra: string[] = [], note?: string): Step => ({
    id, argv: ['bun', 'eval/runner/cat40-model-ladder.ts', ...common, '--models', model, '--judge', JUDGE_FOR[model], ...arm, ...extra, '--out', `${dir}/${id}`, '--budget-usd', cap(id)],
    ...(note ? { note } : {}), ...(model === PARTICLE ? { paid_window: 'particle' as const } : {}),
  });
  const short = (m: string) => (m.startsWith('claude') ? 'opus' : m.startsWith('gpt') ? 'sol' : 'particle');
  const steps: Step[] = [
    { id: 'ledger', argv: ['bun', 'eval/runner/budget-ledger.ts', 'init', '--budget-ledger', ledger, '--program-cap-usd', cap('program'), '--reason', `Cat 40 Hard newest-build re-measure, world ${world} (${NEWEST_PREREG})`], note: 'once per VM' },
    { id: 'check-world', argv: ['bun', 'eval/runner/cat40/newest-confirm.ts', 'check-world', '--world', world, '--file', file] },
    { id: 'freshness', argv: ['bun', 'scripts/model-freshness.ts', '--models', [...FRONTIER, PARTICLE].map(m => `${m.startsWith('gpt') ? 'openai' : m.startsWith('particle') ? 'particle' : 'anthropic'}:${m}`).join(',')], note: 'must exit 0 with no newer frontier Opus or GPT (gate 6)' },
    { id: 'slots', argv: ['bun', 'eval/runner/cat40-model-ladder.ts', '--build-slots', '--world', file, '--gbrain-repo', '../gbrain', '--gbrain-ref', build, '--gbrain-root', gbrainRootFor(world), '--slots', String(NEWEST_SLOTS), '--no-pglite-analyze', '--accept-freeze-drift', driftNote(harnessSha, date), '--slot-build-allowance-usd', '4', '--budget-ledger', ledger, '--out', `${dir}/slots`, '--budget-usd', cap('slots')],
      note: `the first counted gbrain run: re-read gbrain's tags first (the build freezes here); every slot passes the write, restore and rerank probes with 0 queued effects; the receipt must name ${build} on both worlds (gate 7)` },
    ...FRONTIER.map(m => run(`oracle-${short(m)}`, m, ['--arms', 'oracle'])),
    { id: 'oracle-gate', argv: ['bun', 'eval/runner/cat40/hard-ops.ts', 'oracle-gate', '--models', FRONTIER.join(','), '--attempts', FRONTIER.map(m => `${dir}/oracle-${short(m)}/attempts.jsonl`).join(',')], note: 'pooled frontier oracle success >= 95% of 200 cells, or stop this world (gate 4)' },
    ...FRONTIER.map(m => run(`smoke-${short(m)}`, m, gbrain, ['--per-family', '1'], 'five gbrain cells; any harness_error stops the world (gate 5); never counted')),
    ...FRONTIER.map(m => run(`smoke-fs-${short(m)}`, m, ['--arms', 'fs'], ['--per-family', '1'], 'five files cells, the files arm\'s pilot (R111); any harness_error stops the world; never counted')),
    { id: 'hold-record', argv: [], hold: 'record', note: 'the slot receipts, oracle gate and pilots are committed to the preregistration before any counted cell' },
    ...(['a', 'b'] as const).flatMap(half => [
      ...(half === 'b' ? [{ id: 'interim-look', argv: [], hold: 'look' as const, note: 'both worlds finished half A; newest_analysis.py --look interim decides; half B runs only if it continues (R113)' }] : []),
      ...FRONTIER.map(m => run(`gbrain-${short(m)}-${half}`, m, gbrain, ['--tasks', halfTasks(half).join(',')])),
      ...FRONTIER.map(m => run(`fs-${short(m)}-${half}`, m, ['--arms', 'fs', '--tasks', halfTasks(half).join(',')])),
    ]),
    run('oracle-particle', PARTICLE, ['--arms', 'oracle'], [], 'descriptive; inside the granted Particle window, one world at a time, after this world\'s frontier cells'),
    run('gbrain-particle', PARTICLE, gbrain),
    run('fs-particle', PARTICLE, ['--arms', 'fs']),
  ];
  return steps;
}

/** Validates a world against its generator and the recorded digest and seed; returns the digest. Never prints content. */
export function checkWorld(world: NewestWorld, w: HardWorld, path: string): string {
  const rec = NEWEST_WORLDS[world];
  checkHardWorld(w, path);
  const digest = hardWorldDigest(w);
  if (digest !== rec.digest) throw new Error(`${world}: world digest ${digest} is not the recorded ${rec.digest}`);
  if (w.seed !== rec.seed) throw new Error(`${world}: seed ${w.seed} is not the preregistered ${rec.seed}`);
  return digest;
}

const q = (a: string) => (/^[A-Za-z0-9_./:=,@+$-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const opt = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const world = opt('--world') as NewestWorld | undefined;
  if (!world || !(world in NEWEST_WORLDS)) { console.error('usage: newest-confirm.ts plan --world n1|n2 --date YYYY-MM-DD [--json] | check-world --world n1|n2 --file <world.json>'); process.exit(2); }
  if (argv[0] === 'plan') {
    const date = opt('--date');
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { console.error('plan needs --date YYYY-MM-DD (the date in the drift note)'); process.exit(2); }
    let attestation;
    try { attestation = attestPreregistration(NEWEST_PREREG); } catch (e) { console.error(`[newest-confirm] STOP: ${(e as Error).message}`); process.exit(3); }
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const steps = worldPlan(world, pinnedBuild(), sha, date);
    if (argv.includes('--json')) console.log(JSON.stringify({ world, harness: sha, build: pinnedBuild(), attestation, steps }, null, 2));
    else { console.log(`# attestation ${JSON.stringify(attestation)}`); for (const s of steps) console.log(`# ${s.id}${s.paid_window ? ' [Particle paid window]' : ''}${s.note ? ` (${s.note})` : ''}\n${s.argv.map(q).join(' ')}`); }
  } else if (argv[0] === 'check-world') {
    const file = opt('--file');
    if (!file) { console.error('check-world needs --file <world.json>'); process.exit(2); }
    try { console.log(JSON.stringify({ world, valid: true, digest: checkWorld(world, JSON.parse(readFileSync(file, 'utf8')) as HardWorld, file) })); }
    catch (e) { console.error(`[newest-confirm] STOP: ${(e as Error).message}`); process.exit(3); }
  } else { console.error('unknown command'); process.exit(2); }
}
