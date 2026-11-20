/**
 * Cat 40 Hard old-build control program (docs/benchmarks/2026-11-19-cat40-hard-old-build-control-preregistration.md):
 * gbrain 09d21554d (v0.60.189.0) on defaults, read by claude-opus-5-5 and gpt-6.2-sol on the November 19 worlds N1 and
 * N2, paired by task with that run's files and newest-gbrain cells. The exact command for every step of a world, in order.
 *
 *   bun eval/runner/cat40/old-build-control.ts plan --world n1|n2 --date YYYY-MM-DD [--json]
 *
 * Every gbrain step is the November 19 counted step with the control's label, ledger, build and an explicit
 * --surface starter, and its own --out and --accept-freeze-drift note; test/eval/cat40-hard-old-build-control.test.ts
 * compares them with the committed receipts. The counted cells keep the November 19 halves' task lists, run one half
 * after the other and take no interim look (the planned spend sits below R113's level). No particle-1 step, no files
 * step and no oracle step: those cells are reused. Dollar caps are $CAP_<STEP> placeholders (R79). plan refuses unless
 * the control preregistration is committed, unchanged and on origin (attestPreregistration).
 */
import { execFileSync } from 'node:child_process';
import { attestPreregistration } from '../prereg.ts';
import { FRONTIER, JUDGE_FOR, NEWEST_REPORTS, NEWEST_SLOTS, NEWEST_WORLDS, halfTasks, type NewestWorld, type Step } from './newest-confirm.ts';

export const CONTROL_PREREG = 'docs/benchmarks/2026-11-19-cat40-hard-old-build-control-preregistration.md';
export const CONTROL_BUILD = '09d21554d7ab75cc5643a7f5a0e7f163aa4dae5b';
export const CONTROL_LABEL = 'gbrain-old-09d';
export const CONTROL_REPORTS = 'eval/reports/cat40/hard-control';
export const controlLedgerFor = (w: NewestWorld) => `.budget/cat40-hard-control-${w}.sqlite`;
export const controlRootFor = (w: NewestWorld) => `/home/ubi/cat40/hard-control-${w}`;

export function controlDriftNote(harnessSha: string, date: string): string {
  return `${CONTROL_PREREG}: harness ${harnessSha}; drift is listed in docs/benchmarks/cat40-hard/accepted-drift.json (the 2026-11-19 entries, and loop.ts recording the served model ids) (${date})`;
}

const cap = (id: string) => `$CAP_${id.toUpperCase().replace(/-/g, '_')}`;
const short = (m: string) => (m.startsWith('claude') ? 'opus' : 'sol');

/** Every step of one world, in order. */
export function controlPlan(world: NewestWorld, harnessSha: string, date: string): Step[] {
  const file = `${NEWEST_REPORTS}/${world}/world/world.json`;
  const dir = `${CONTROL_REPORTS}/${world}`;
  const ledger = controlLedgerFor(world);
  const note = controlDriftNote(harnessSha, date);
  const common = ['--world', file, '--concurrency', '10', '--repeat', '1', '--budget-ledger', ledger, '--transcripts', '--accept-freeze-drift', note];
  const gbrain = ['--arms', 'gbrain', '--gbrain-label', CONTROL_LABEL, '--gbrain-repo', '../gbrain', '--gbrain-ref', CONTROL_BUILD, '--gbrain-root', controlRootFor(world), '--slots', String(NEWEST_SLOTS), '--no-pglite-analyze', '--surface', 'starter'];
  const run = (id: string, model: string, extra: string[], why?: string): Step => ({
    id, argv: ['bun', 'eval/runner/cat40-model-ladder.ts', ...common, '--models', model, '--judge', JUDGE_FOR[model], ...gbrain, ...extra, '--out', `${dir}/${id}`, '--budget-usd', cap(id)],
    ...(why ? { note: why } : {}),
  });
  return [
    { id: 'ledger', argv: ['bun', 'eval/runner/budget-ledger.ts', 'init', '--budget-ledger', ledger, '--program-cap-usd', cap('program'), '--reason', `Cat 40 Hard old-build control, world ${world} (${CONTROL_PREREG})`], note: 'once per VM' },
    { id: 'check-world', argv: ['bun', 'eval/runner/cat40/newest-confirm.ts', 'check-world', '--world', world, '--file', file], note: 'the November 19 world file at its recorded digest (gate 1)' },
    { id: 'slots', argv: ['bun', 'eval/runner/cat40-model-ladder.ts', '--build-slots', '--world', file, '--gbrain-repo', '../gbrain', '--gbrain-ref', CONTROL_BUILD, '--gbrain-root', controlRootFor(world), '--slots', String(NEWEST_SLOTS), '--no-pglite-analyze', '--surface', 'starter', '--accept-freeze-drift', note, '--slot-build-allowance-usd', '4', '--budget-ledger', ledger, '--out', `${dir}/slots`, '--budget-usd', cap('slots')],
      note: `every slot passes the write, restore and fail-closed rerank probes with 0 queued effects, no config, and the receipt names ${CONTROL_BUILD} and surface starter (gate 2)` },
    ...FRONTIER.map(m => run(`smoke-${short(m)}`, m, ['--per-family', '1'], 'five gbrain-old cells; any harness_error stops the world (gate 3, R111 pilot); never counted')),
    { id: 'hold-record', argv: [], hold: 'record', note: 'the slot receipts and smokes are committed under "Recorded before cells" before any counted cell (gate 4)' },
    ...(['a', 'b'] as const).flatMap(half => FRONTIER.map(m => run(`gbrain-old-${short(m)}-${half}`, m, ['--tasks', halfTasks(half).join(',')]))),
  ];
}

const q = (a: string) => (/^[A-Za-z0-9_./:=,@+$-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const opt = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const world = opt('--world') as NewestWorld | undefined;
  const date = opt('--date');
  if (argv[0] !== 'plan' || !world || !(world in NEWEST_WORLDS) || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error('usage: old-build-control.ts plan --world n1|n2 --date YYYY-MM-DD [--json]'); process.exit(2);
  }
  let attestation;
  try { attestation = attestPreregistration(CONTROL_PREREG); } catch (e) { console.error(`[old-build-control] STOP: ${(e as Error).message}`); process.exit(3); }
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const steps = controlPlan(world, sha, date);
  if (argv.includes('--json')) console.log(JSON.stringify({ world, harness: sha, build: CONTROL_BUILD, attestation, steps }, null, 2));
  else { console.log(`# attestation ${JSON.stringify(attestation)}`); for (const s of steps) console.log(`# ${s.id}${s.note ? ` (${s.note})` : ''}\n${s.argv.map(q).join(' ')}`); }
}
