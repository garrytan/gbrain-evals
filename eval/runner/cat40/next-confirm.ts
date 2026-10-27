/**
 * Cat 40 next wave confirmation program (docs/plans/2026-10-11-cat40-next-wave/PREREG.md): the preregistered worlds,
 * builds, arm recipes, caps and ledgers, and the exact command for every step of a world, in order.
 *
 *   bun eval/runner/cat40/next-confirm.ts plan --world p1|p2|s1|s2 --date YYYY-MM-DD [--json]
 *   bun eval/runner/cat40/next-confirm.ts check-world --world p1|p2|s1|s2 --file <world.json> [--digest <recorded sealed digest>]
 *
 * Two machines: P1 and P2 share the public machine and ledger; S1 and S2 share the owner-custody VM and its ledger.
 * Each gbrain arm runs its own runner invocation (one build per invocation); fs and the oracle run once per world.
 * Gates (PREREG.md): world check, model freshness, slot probes (inside the slot build), the 95% oracle gate
 * (hard-ops.ts oracle-gate), and the per-arm `--budget-usd` caps under a $1,700 program cap per ledger.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { checkHardWorld } from './hard.ts';
import { hardWorldDigest } from '../../generators/model-ladder-hard.ts';
import type { HardWorld } from '../../generators/hard/schema.ts';

export type NextWorld = 'p1' | 'p2' | 's1' | 's2';
export type Machine = 'public' | 'sealed';

/** Public worlds carry their recorded digests; sealed digests are recorded in PREREG.md and passed to check-world. */
export const NEXT_WORLDS: Record<NextWorld, { machine: Machine; seed: number | null; digest: string | null; file_sha256: string | null }> = {
  p1: { machine: 'public', seed: 20262041, digest: '7485a765f4b1981ba9d2541b06cd17e05a78e0bd1399fb4044ee9aed2e2b516e', file_sha256: 'd30ea091734e645336044ee516f7b376cb89db2714ec0558aab87731baf70922' },
  p2: { machine: 'public', seed: 20262051, digest: '885b294f9cf6dcdfd3a21daf9b8f3ae46ab6ddcf949d7c0e3d0f3fcf86b50281', file_sha256: '6a57f0ff6b04b6ca7bf1541ea09a2a06561c35c0d4023a07ce6bc711323b8601' },
  s1: { machine: 'sealed', seed: null, digest: null, file_sha256: null },
  s2: { machine: 'sealed', seed: null, digest: null, file_sha256: null },
};

/** Wave: the Part 1 head with F5 restored (owner override, 2026-10-13). Baseline: the wave's merge base with master. */
export const NEXT_BUILDS = { wave: '4e10136b4b7b79cb99408dca1136d3350f5de5e4', baseline: '09d21554d7ab75cc5643a7f5a0e7f163aa4dae5b' } as const;

/** The development all-on restore-time keys (dev-arms.ts round 1/2 all-on). */
export const WAVE_CONFIG = 'entity.names_references=true,entity.record_types=contract,amendment,entity.row_page_status=true,search.long_page_unit=section,search.long_page_min_chars=20000,mcp.instructions_governing_rule=in_effect';

/** F5 on at slot build, as development all-on (dev-arms.ts SLOT_BUILD_CONFIG f5-on): its own slot family. */
export const WAVE_BUILD_CONFIG = 'mentions.owner_phrases=true';

export const NEXT_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-6.1-sol'] as const;
export const NEXT_JUDGE = 'gpt-6.1-sol';
export const NEXT_LEDGERS: Record<Machine, string> = { public: '.budget/cat40-next-confirm-public.sqlite', sealed: '.budget/cat40-next-confirm-sealed.sqlite' };
export const NEXT_PROGRAM_CAP_USD = 1700;
/** Per-arm `--budget-usd` caps: 1.15 times the priced arm (gbrain $219, fs $317, oracle $28). */
export const NEXT_CAPS_USD = { gbrain: 252, fs: 364, oracle: 32 } as const;
/** Per-slot embedding allowance: the sealed corpus needed more than $4 per slot in #93. */
export const NEXT_SLOT_ALLOWANCE_USD: Record<Machine, number> = { public: 4, sealed: 6 };
export const NEXT_SLOTS = 5;
export const NEXT_REPORTS = 'eval/reports/cat40/next-confirm';
export const NEXT_GBRAIN_ROOTS = { wave: '/home/ubi/cat40/next-confirm-wave', baseline: '/home/ubi/cat40/next-confirm-baseline' } as const;
export const NEXT_LABELS = { wave: 'gbrain-next-wave', baseline: 'gbrain-next-baseline' } as const;

export function driftNote(harnessSha: string, date: string): string {
  return `PREREG.md (cat40-next-wave): harness ${harnessSha} preregistered; drift is the confirmation seed registration (schema.ts, hard.ts), the scripted gbrain agent and whole-result transcripts (hard.ts), the write-tool list taken while the gbrain slot is live (hard.ts, arms.ts), and unused loop hooks (loop.ts) and an embedder base URL (pg-arm.ts) merged from main; none changes a model cell (${date})`;
}

export interface Step { id: string; argv: string[]; note?: string }

/** Every step of one world, in order. `harnessSha` and `date` fill the drift note. */
export function worldPlan(world: NextWorld, harnessSha: string, date: string): Step[] {
  const w = NEXT_WORLDS[world];
  const dir = `${NEXT_REPORTS}/${world}`;
  const file = `${dir}/world/world.json`;
  const ledger = NEXT_LEDGERS[w.machine];
  const drift = ['--accept-freeze-drift', driftNote(harnessSha, date)];
  const common = ['--world', file, '--models', NEXT_MODELS.join(','), '--concurrency', '10', '--repeat', '1', '--judge', NEXT_JUDGE, '--budget-ledger', ledger, '--transcripts', ...drift];
  const gbrain = (arm: 'wave' | 'baseline') => ['--arms', 'gbrain', '--gbrain-label', NEXT_LABELS[arm], '--gbrain-repo', '../gbrain', '--gbrain-ref', NEXT_BUILDS[arm], '--gbrain-root', NEXT_GBRAIN_ROOTS[arm], '--slots', String(NEXT_SLOTS), '--no-pglite-analyze', ...(arm === 'wave' ? ['--gbrain-config', WAVE_CONFIG, '--gbrain-build-config', WAVE_BUILD_CONFIG] : [])];
  const slots = (arm: 'wave' | 'baseline'): Step => ({
    id: `slots-${arm}`,
    argv: ['bun', 'eval/runner/cat40-model-ladder.ts', '--build-slots', '--world', file, '--gbrain-repo', '../gbrain', '--gbrain-ref', NEXT_BUILDS[arm], '--gbrain-root', NEXT_GBRAIN_ROOTS[arm], '--slots', String(NEXT_SLOTS), '--no-pglite-analyze', ...(arm === 'wave' ? ['--gbrain-build-config', WAVE_BUILD_CONFIG] : []),
      '--slot-build-allowance-usd', String(NEXT_SLOT_ALLOWANCE_USD[w.machine]), '--budget-ledger', ledger, '--out', `${dir}/slots-${arm}`, '--budget-usd', String(NEXT_SLOTS * NEXT_SLOT_ALLOWANCE_USD[w.machine])],
    note: `every slot must pass the write, restore and rerank probes with 0 queued effects${arm === 'wave' ? ' and hold at least one owner-phrase link' : ' and hold 0 owner-phrase links'}`,
  });
  return [
    { id: 'ledger', argv: ['bun', 'eval/runner/budget-ledger.ts', 'init', '--budget-ledger', ledger, '--program-cap-usd', String(NEXT_PROGRAM_CAP_USD), '--reason', 'Cat 40 next wave confirmation (PREREG.md; $3,400 approved, Garry gate rev 2 via GBRA-40)'], note: 'once per machine' },
    { id: 'check-world', argv: ['bun', 'eval/runner/cat40/next-confirm.ts', 'check-world', '--world', world, '--file', file, ...(w.machine === 'sealed' ? ['--digest', '<digest recorded in PREREG.md>'] : [])] },
    { id: 'freshness', argv: ['bun', 'scripts/model-freshness.ts', '--models', NEXT_MODELS.map(m => `${m.startsWith('gpt') ? 'openai' : 'anthropic'}:${m}`).join(',')], note: 'must exit 0 with no newer counted-family model' },
    slots('wave'),
    slots('baseline'),
    { id: 'oracle', argv: ['bun', 'eval/runner/cat40-model-ladder.ts', ...common, '--arms', 'oracle', '--out', `${dir}/oracle`, '--budget-usd', String(NEXT_CAPS_USD.oracle)] },
    { id: 'oracle-gate', argv: ['bun', 'eval/runner/cat40/hard-ops.ts', 'oracle-gate', '--attempts', `${dir}/oracle/attempts.jsonl`], note: 'pooled oracle success >= 95%, or stop this world' },
    { id: 'cells-baseline', argv: ['bun', 'eval/runner/cat40-model-ladder.ts', ...common, ...gbrain('baseline'), '--out', `${dir}/baseline`, '--budget-usd', String(NEXT_CAPS_USD.gbrain)] },
    { id: 'cells-wave', argv: ['bun', 'eval/runner/cat40-model-ladder.ts', ...common, ...gbrain('wave'), '--out', `${dir}/wave`, '--budget-usd', String(NEXT_CAPS_USD.gbrain)] },
    { id: 'cells-fs', argv: ['bun', 'eval/runner/cat40-model-ladder.ts', ...common, '--arms', 'fs', '--out', `${dir}/fs`, '--budget-usd', String(NEXT_CAPS_USD.fs)] },
  ];
}

/** Validates a world against its generator and the recorded digest; returns the digest. Never prints content. */
export function checkWorld(world: NextWorld, w: HardWorld, path: string, sealedDigest?: string): string {
  const rec = NEXT_WORLDS[world];
  checkHardWorld(w, path);
  const digest = hardWorldDigest(w);
  const want = rec.machine === 'public' ? rec.digest : sealedDigest;
  if (!want || !/^[0-9a-f]{64}$/.test(want)) throw new Error(`${world}: no recorded digest to compare (pass --digest <the digest recorded in PREREG.md> for a sealed world)`);
  if (digest !== want) throw new Error(`${world}: world digest ${digest} is not the recorded ${want}`);
  if (rec.machine === 'public' && w.seed !== rec.seed) throw new Error(`${world}: seed ${w.seed} is not the preregistered ${rec.seed}`);
  if (rec.machine === 'sealed' && !w.version.startsWith('hard-sealed')) throw new Error(`${world}: version ${w.version} is not the sealed generator`);
  return digest;
}

const q = (a: string) => (/^[A-Za-z0-9_./:=,@+-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const opt = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const world = opt('--world') as NextWorld | undefined;
  if (!world || !(world in NEXT_WORLDS)) { console.error('usage: next-confirm.ts plan --world p1|p2|s1|s2 --date YYYY-MM-DD [--json] | check-world --world <w> --file <world.json> [--digest <d>]'); process.exit(2); }
  if (argv[0] === 'plan') {
    const date = opt('--date');
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { console.error('plan needs --date YYYY-MM-DD (the freeze-check date in the drift note)'); process.exit(2); }
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const steps = worldPlan(world, sha, date);
    if (argv.includes('--json')) console.log(JSON.stringify({ world, harness: sha, steps }, null, 2));
    else for (const s of steps) console.log(`# ${s.id}${s.note ? ` (${s.note})` : ''}\n${s.argv.map(q).join(' ')}`);
  } else if (argv[0] === 'check-world') {
    const file = opt('--file');
    if (!file) { console.error('check-world needs --file <world.json>'); process.exit(2); }
    try {
      const digest = checkWorld(world, JSON.parse(readFileSync(file, 'utf8')) as HardWorld, file, opt('--digest'));
      console.log(JSON.stringify({ world, valid: true, digest }));
    } catch (e) { console.error(`[next-confirm] STOP: ${(e as Error).message}`); process.exit(3); }
  } else { console.error('unknown command'); process.exit(2); }
}
