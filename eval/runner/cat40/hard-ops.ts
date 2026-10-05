/**
 * Cat 40 Hard operator support: the paid-step plan, cost projections, the
 * program ledger roster and the freeze record. No model is called here.
 *
 *   bun eval/runner/cat40/hard-ops.ts project --step <step> [--measured <results.jsonl|attempts.jsonl>,...] [--done <the step's attempts.jsonl>] [--world <world.json>]
 *   bun eval/runner/cat40/hard-ops.ts roster
 *   bun eval/runner/cat40/hard-ops.ts freeze write --knobs <knobs.round-N.json> --note "<why this round froze>"
 *   bun eval/runner/cat40/hard-ops.ts freeze check
 *
 * Exit 3 with a stable code (hard.ts HARD_STOP_CODES) on any refusal.
 */
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonicalCells, readRecords, type CellView } from './records.ts';
import { HardStop, codeHashes, settingsDigest } from './hard.ts';
import { ledgerStatus } from '../budget-ledger.ts';
import { knobDigest, validateKnobs, HARD_SEEDS } from '../../generators/hard/schema.ts';

export const HARD_DOCS = resolve(import.meta.dir, '../../../docs/benchmarks/cat40-hard');
export const REPO_ROOT = resolve(import.meta.dir, '../../..');

/** Frontier models in the order people use them most (CEO-F8). */
export const HARD_MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5', 'gpt-6.1-sol', 'claude-fable-5-1', 'gpt-6-astra'];
export const CALIBRATION_MODELS = ['claude-sonnet-5-5', 'gpt-6-astra'];
export const FREEZE_CHECK_MODELS = ['claude-opus-5-5', 'claude-fable-5-1', 'gpt-6.1-sol'];
export const HARD_JUDGE = 'gpt-6.1-sol';

export interface StepPlan {
  step: string;
  /** Number in the plan's paid-step order (CEO-F16). */
  order: number;
  models: string[];
  arms: string[];
  tasksPerFamily: number;
  families?: string[];
  repeats: number;
  scale: 'v1' | 'large';
  slotBuilds?: number;
  /** Free steps have no cells. */
  free?: boolean;
}

export const STEPS: StepPlan[] = [
  { step: 'calibrate', order: 1, models: CALIBRATION_MODELS, arms: ['oracle', 'fs', 'pg'], tasksPerFamily: 10, repeats: 1, scale: 'v1' },
  { step: 'freeze-check', order: 2, models: FREEZE_CHECK_MODELS, arms: ['oracle', 'fs', 'pg'], tasksPerFamily: 10, repeats: 1, scale: 'v1' },
  { step: 'freeze', order: 3, models: [], arms: [], tasksPerFamily: 0, repeats: 0, scale: 'v1', free: true },
  { step: 'smoke', order: 4, models: ['claude-sonnet-5-5'], arms: ['gbrain'], tasksPerFamily: 1, repeats: 1, scale: 'v1', slotBuilds: 1 },
  { step: 'heldout-world', order: 5, models: [], arms: [], tasksPerFamily: 0, repeats: 0, scale: 'v1', free: true },
  { step: 'slots-4k', order: 6, models: [], arms: [], tasksPerFamily: 0, repeats: 0, scale: 'v1', slotBuilds: 5 },
  { step: 'simple-4k', order: 7, models: HARD_MODELS, arms: ['oracle', 'fs', 'pg', 'memory'], tasksPerFamily: 20, repeats: 1, scale: 'v1' },
  { step: 'comparator', order: 8, models: [], arms: [], tasksPerFamily: 0, repeats: 0, scale: 'v1', free: true },
  { step: 'gbrain-4k', order: 9, models: HARD_MODELS, arms: ['gbrain'], tasksPerFamily: 20, repeats: 1, scale: 'v1' },
  { step: 'slots-50k', order: 10, models: [], arms: [], tasksPerFamily: 0, repeats: 0, scale: 'large', slotBuilds: 5 },
  { step: 'cells-50k', order: 11, models: HARD_MODELS, arms: ['gbrain', 'fs'], tasksPerFamily: 20, repeats: 1, scale: 'large' },
  { step: 'oracle-50k', order: 11, models: HARD_MODELS, arms: ['oracle'], tasksPerFamily: 20, families: ['H1'], repeats: 1, scale: 'large' },
];

export function stepPlan(step: string): StepPlan {
  const p = STEPS.find(s => s.step === step);
  if (!p) throw new Error(`unknown step ${step}; steps: ${STEPS.map(s => s.step).join(', ')}`);
  return p;
}

// ─── Projection ─────────────────────────────────────────────────────

export interface CostBasis {
  v1_per_cell_usd: Record<string, Record<string, number>>;
  /**
   * Measured Hard cost per cell divided by the v1 cost per cell of the same model and arm, by arm and family
   * (calibration round 1). Arms without a measurement borrow one: memory from fs, gbrain from pg.
   */
  hard_factor_by_arm_family: Record<string, Record<string, number>>;
  /** Measured gpt-6.1-sol judge dollars per cell, by family. */
  judge_per_cell_usd_by_family: Record<string, number>;
  scale_50k_factor: Record<string, number>;
  slot_build: { usd_per_slot: number; world_bytes: number };
  margin: number;
}

export function loadCostBasis(path = join(HARD_DOCS, 'cost-basis.json')): CostBasis {
  return JSON.parse(readFileSync(path, 'utf8')) as CostBasis;
}

const FAMILIES5 = ['H1', 'H2', 'H3', 'H4', 'H5'];
const FACTOR_ARM: Record<string, string> = { memory: 'fs', gbrain: 'pg' };

export interface Projection { step: string; cells: number; agent_usd: number; judge_usd: number; slot_build_usd: number; total_usd: number; with_margin_usd: number; basis: string; rows: Array<{ model: string; arm: string; cells: number; per_cell_usd: number; source: string }> }

/**
 * Project a step's cost, per model, arm and family (Hard cells differ in
 * cost by family far more than by arm: an H1 cell reads dozens of records).
 * Per (model, arm, family): the measured Hard cost per cell when `measured`
 * holds cells for it (cost over every attempt, judge included, divided by
 * canonical cells; a 4k measurement times the 50k factor for a 50k step);
 * otherwise the v1 cost per cell of that model and arm times the measured Hard
 * factor for the arm and family, plus the measured judge cost for the family.
 * Cells already done (`done`, keys with a harness-clean attempt) are not
 * projected. Slot builds scale with the world's bytes.
 */
export function project(plan: StepPlan, o: { basis: CostBasis; measured?: CellView[]; measuredScale?: 'v1' | 'large'; worldBytes?: number; done?: CellView[] }): Projection {
  const families = plan.families ?? FAMILIES5;
  const rows: Projection['rows'] = [];
  let agent = 0, judge = 0, cells = 0;
  const doneCount = (model: string, arm: string, f: string) => new Set((o.done ?? []).filter(c => c.harness_clean && c.model === model && c.family === f && (c.arm === arm || (arm === 'gbrain' && c.arm.startsWith('gbrain')))).map(c => c.key)).size;
  for (const model of plan.models) for (const arm of plan.arms) {
    let rowUsd = 0, rowCells = 0;
    const sources = new Set<string>();
    for (const f of families) {
      const n = Math.max(0, plan.tasksPerFamily * plan.repeats - doneCount(model, arm, f));
      if (!n) continue;
      const ms = (o.measured ?? []).filter(c => c.model === model && c.family === f && (c.arm === arm || (arm === 'gbrain' && c.arm.startsWith('gbrain'))));
      const scale = plan.scale === 'large' && (ms.length ? o.measuredScale !== 'large' : true) ? (o.basis.scale_50k_factor[arm] ?? o.basis.scale_50k_factor.default) : 1;
      let per: number, perJudge: number;
      if (ms.length) {
        const canon = new Set(ms.filter(c => c.harness_clean).map(c => c.key)).size || 1;
        per = ms.reduce((s, c) => s + c.total_usd, 0) / canon * scale;
        perJudge = ms.reduce((s, c) => s + c.judge_usd, 0) / canon * scale;
        sources.add('measured');
      } else {
        const v1 = o.basis.v1_per_cell_usd[model]?.[arm];
        const factor = o.basis.hard_factor_by_arm_family[FACTOR_ARM[arm] ?? arm]?.[f];
        if (v1 === undefined || factor === undefined) throw new Error(`no cost basis for ${model} ${arm} ${f}; add it to docs/benchmarks/cat40-hard/cost-basis.json or pass --measured`);
        per = v1 * factor * scale;
        perJudge = (o.basis.judge_per_cell_usd_by_family[f] ?? 0) * scale;
        sources.add(`v1 x Hard factor${scale !== 1 ? ' x 50k' : ''}`);
      }
      agent += per * n; judge += perJudge * n; rowUsd += (per + perJudge) * n; rowCells += n;
    }
    cells += rowCells;
    if (rowCells) rows.push({ model, arm, cells: rowCells, per_cell_usd: rowUsd / rowCells, source: [...sources].join(' + ') });
  }
  const slot_build_usd = (plan.slotBuilds ?? 0) * o.basis.slot_build.usd_per_slot * ((o.worldBytes ?? (plan.scale === 'large' ? 85_000_000 : 10_500_000)) / o.basis.slot_build.world_bytes);
  const total = agent + judge + slot_build_usd;
  return { step: plan.step, cells, agent_usd: agent, judge_usd: judge, slot_build_usd, total_usd: total, with_margin_usd: total * (1 + o.basis.margin), basis: o.measured?.length ? 'measured Hard cells where available, else v1 x measured Hard factor' : 'v1 x measured Hard factor (round 1)', rows };
}

// ─── Ledger roster (ENG-F9) ─────────────────────────────────────────

export interface Roster { authorization_usd: number; ledgers: Array<{ name: string; path: string | null; allocation_usd: number; hard?: boolean }> }

export function loadRoster(path = join(HARD_DOCS, 'ledger-roster.json')): Roster {
  return JSON.parse(readFileSync(path, 'utf8')) as Roster;
}

/** Check every local ledger in the roster; returns the Hard ledger's remaining dollars or throws HARD_LEDGER_ROSTER. */
export function checkRoster(roster: Roster, root = REPO_ROOT): { hardLedger: string; capUsd: number; committedUsd: number; remainingUsd: number } {
  const total = roster.ledgers.reduce((s, l) => s + l.allocation_usd, 0);
  if (total > roster.authorization_usd + 1e-6) throw new HardStop('HARD_LEDGER_ROSTER', `allocations sum to $${total.toFixed(2)}, above the $${roster.authorization_usd} authorization`, 'fix docs/benchmarks/cat40-hard/ledger-roster.json', 'Garry decides any change to the authorization');
  let hard: { hardLedger: string; capUsd: number; committedUsd: number; remainingUsd: number } | null = null;
  for (const l of roster.ledgers) {
    if (!l.path) continue;
    const p = resolve(root, l.path);
    if (!existsSync(p)) throw new HardStop('HARD_LEDGER_ROSTER', `the roster lists ${l.path}, which does not exist on this machine`, `run this step on the machine that holds ${l.path}, or copy the ledger here; never open a replacement ledger`);
    const s = ledgerStatus({ ledgerPath: p });
    const cap = s.totals.program_cap_usd ?? NaN;
    if (Math.abs(cap - l.allocation_usd) > 0.005) throw new HardStop('HARD_LEDGER_ROSTER', `${l.path} records a cap of $${cap.toFixed(2)}, the roster says $${l.allocation_usd.toFixed(2)}`, 'stop and ask Garry; only his authorization changes a cap (bun eval/runner/budget-ledger.ts set-cap ...)');
    if (l.hard) hard = { hardLedger: p, capUsd: cap, committedUsd: s.totals.committed_usd ?? 0, remainingUsd: s.totals.remaining_usd ?? 0 };
  }
  if (!hard) throw new HardStop('HARD_LEDGER_ROSTER', 'the roster has no Hard ledger', 'mark the Hard ledger with "hard": true in ledger-roster.json');
  return hard;
}

export function budgetCheck(remainingUsd: number, projection: Projection): void {
  if (remainingUsd < projection.with_margin_usd) {
    throw new HardStop('HARD_BUDGET_SHORT', `step ${projection.step} projects $${projection.total_usd.toFixed(2)} ($${projection.with_margin_usd.toFixed(2)} with the 15% margin); the Hard ledger has $${remainingUsd.toFixed(2)} left`,
      'do not raise the cap yourself', `Garry decides whether to fund the step (a new authorization and set-cap), narrow it, or stop`);
  }
}

// ─── Freeze record (ENG-F6, ENG-F18) ────────────────────────────────

export interface FreezeRecord { frozen_at: string; note: string; knobs_file: string; knob_digest: string; settings_digest: string; max_turns: number; tool_limits: 'hard'; judge: string; code: Record<string, string> }

export const FREEZE_PATH = join(HARD_DOCS, 'freeze.json');
export const FROZEN_KNOBS = join(HARD_DOCS, 'knobs.frozen.json');

export function writeFreeze(knobsPath: string, note: string, now = new Date()): FreezeRecord {
  const knobs = validateKnobs(JSON.parse(readFileSync(knobsPath, 'utf8')), knobsPath);
  copyFileSync(knobsPath, FROZEN_KNOBS);
  const kd = knobDigest(knobs);
  const rec: FreezeRecord = {
    frozen_at: now.toISOString(), note, knobs_file: 'docs/benchmarks/cat40-hard/knobs.frozen.json', knob_digest: kd,
    settings_digest: settingsDigest({ knob_digest: kd, max_turns: knobs.max_turns, tool_limits: 'hard', judge: HARD_JUDGE }), max_turns: knobs.max_turns, tool_limits: 'hard', judge: HARD_JUDGE, code: codeHashes(REPO_ROOT),
  };
  writeFileSync(FREEZE_PATH, JSON.stringify(rec, null, 2) + '\n');
  return rec;
}

export function frozenKnobDigest(): string | null {
  return existsSync(FROZEN_KNOBS) ? knobDigest(validateKnobs(JSON.parse(readFileSync(FROZEN_KNOBS, 'utf8')), FROZEN_KNOBS)) : null;
}

/** Frozen files whose hash differs from freeze.json; empty when there is no freeze record or nothing changed. */
export function freezeDrift(): string[] {
  if (!existsSync(FREEZE_PATH)) return [];
  const rec = JSON.parse(readFileSync(FREEZE_PATH, 'utf8')) as FreezeRecord;
  const now = codeHashes(REPO_ROOT);
  return Object.keys({ ...rec.code, ...now }).filter(f => rec.code[f] !== now[f]);
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  try {
    const cmd = argv[0];
    if (cmd === 'project') {
      const plan = stepPlan(flag('--step') ?? '');
      const measured = (flag('--measured') ?? '').split(',').filter(Boolean);
      const views = measured.length ? canonicalCells(readRecords(measured)).attempts : undefined;
      const worldBytes = flag('--world') ? statSync(flag('--world')!).size : undefined;
      const done = flag('--done') && existsSync(flag('--done')!) ? canonicalCells(readRecords([flag('--done')!])).attempts : undefined;
      const p = project(plan, { basis: loadCostBasis(), measured: views, worldBytes, done, measuredScale: (flag('--measured-scale') ?? 'v1') as 'v1' | 'large' });
      console.log(JSON.stringify(p, null, 2));
    } else if (cmd === 'roster') {
      console.log(JSON.stringify(checkRoster(loadRoster()), null, 2));
    } else if (cmd === 'freeze' && argv[1] === 'write') {
      const knobs = flag('--knobs'), note = flag('--note');
      if (!knobs || !note) { console.error('usage: hard-ops.ts freeze write --knobs <knobs.round-N.json> --note "<round and reason>"'); process.exit(2); }
      console.log(JSON.stringify(writeFreeze(resolve(knobs), note), null, 2));
    } else if (cmd === 'freeze' && argv[1] === 'check') {
      const drift = freezeDrift();
      console.log(drift.length ? `frozen code changed: ${drift.join(', ')}` : existsSync(FREEZE_PATH) ? 'frozen code unchanged' : 'no freeze record yet');
      process.exit(drift.length ? 3 : 0);
    } else {
      console.error('usage: bun eval/runner/cat40/hard-ops.ts project --step <step> [--measured <files>] [--world <world.json>] | roster | freeze write --knobs <file> --note <text> | freeze check');
      process.exit(2);
    }
  } catch (e) {
    if (e instanceof HardStop) { console.error(e.render()); process.exit(3); }
    throw e;
  }
}

export { HARD_SEEDS };
