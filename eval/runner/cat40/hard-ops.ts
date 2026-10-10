/**
 * Cat 40 Hard operator support: the paid-step plan, cost projections, the
 * program ledger roster and the freeze record. No model is called here.
 *
 *   bun eval/runner/cat40/hard-ops.ts project --step <step> [--measured <results.jsonl|attempts.jsonl>,...] [--done <the step's attempts.jsonl>] [--world <world.json>] [--scale v1|large]
 *   bun eval/runner/cat40/hard-ops.ts roster
 *   bun eval/runner/cat40/hard-ops.ts confirm-ledger --world main|sealed
 *   bun eval/runner/cat40/hard-ops.ts oracle-gate --attempts <confirm-oracle attempts.jsonl>
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
export const HARD_MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5', 'gpt-6.1-sol'];
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

export const MEMORY_MODELS = ['claude-sonnet-5-5', 'gpt-6.1-sol'];

/** Paid and free steps in order. Amendment A2: the held-out run is 50k only, in four batches; the 4k held-out steps are retired. */
export const STEPS: StepPlan[] = [
  { step: 'calibrate', order: 1, models: CALIBRATION_MODELS, arms: ['oracle', 'fs', 'pg'], tasksPerFamily: 10, repeats: 1, scale: 'v1' },
  { step: 'freeze-check', order: 2, models: FREEZE_CHECK_MODELS, arms: ['oracle', 'fs', 'pg'], tasksPerFamily: 10, repeats: 1, scale: 'v1' },
  { step: 'freeze', order: 3, models: [], arms: [], tasksPerFamily: 0, repeats: 0, scale: 'v1', free: true },
  { step: 'smoke', order: 4, models: ['claude-sonnet-5-5'], arms: ['gbrain'], tasksPerFamily: 1, repeats: 1, scale: 'v1', slotBuilds: 1 },
  { step: 'heldout-world', order: 5, models: [], arms: [], tasksPerFamily: 0, repeats: 0, scale: 'large', free: true },
  { step: 'slots-50k', order: 6, models: [], arms: [], tasksPerFamily: 0, repeats: 0, scale: 'large', slotBuilds: 5 },
  { step: 'cells-50k', order: 7, models: HARD_MODELS, arms: ['gbrain', 'fs'], tasksPerFamily: 20, repeats: 1, scale: 'large' },
  { step: 'oracle-50k', order: 8, models: HARD_MODELS, arms: ['oracle'], tasksPerFamily: 20, repeats: 1, scale: 'large' },
  { step: 'pg-50k', order: 9, models: HARD_MODELS, arms: ['pg'], tasksPerFamily: 20, repeats: 1, scale: 'large' },
  { step: 'memory-50k', order: 10, models: MEMORY_MODELS, arms: ['memory'], tasksPerFamily: 20, repeats: 1, scale: 'large' },
];

/**
 * Confirmation steps (docs/plans/2026-10-07-cat40-hard-fix/PREREG.md), after the held-out run: each runs once per world, M (main
 * generator, seed HARD_SEEDS.confirmation) and S (sealed generator), on its own machine and ledger (CONFIRM_LEDGERS).
 */
export const CONFIRM_STEPS: StepPlan[] = [
  { step: 'confirm-world', order: 11, models: [], arms: [], tasksPerFamily: 0, repeats: 0, scale: 'large', free: true },
  { step: 'confirm-slots', order: 12, models: [], arms: [], tasksPerFamily: 0, repeats: 0, scale: 'large', slotBuilds: 5 },
  { step: 'confirm-oracle', order: 13, models: HARD_MODELS, arms: ['oracle'], tasksPerFamily: 20, repeats: 1, scale: 'large' },
  { step: 'confirm-cells', order: 14, models: HARD_MODELS, arms: ['gbrain', 'fs'], tasksPerFamily: 20, repeats: 1, scale: 'large' },
];

/** The confirmation's worlds and their ledgers, one per world because the worlds run on separate machines (PREREG.md, Budget). */
export const CONFIRM_LEDGERS = { main: '.budget/cat40-hard-confirm-main.sqlite', sealed: '.budget/cat40-hard-confirm-sealed.sqlite' } as const;
export type ConfirmWorld = keyof typeof CONFIRM_LEDGERS;
export const CONFIRM_CAP_USD = 650;
/** The oracle gate before counted confirmation cells: pooled oracle success over the three models (PREREG.md, gate 2). */
export const CONFIRM_ORACLE_MIN = 0.95;

export function isConfirmStep(step: string | undefined): boolean {
  return !!step && CONFIRM_STEPS.some(s => s.step === step);
}

/** The 4k held-out steps amendment A2 retired; the operator script refuses them with HARD_STEP_RETIRED. */
export const RETIRED_STEPS = ['slots-4k', 'simple-4k', 'comparator', 'gbrain-4k'];

export function stepPlan(step: string): StepPlan {
  if (RETIRED_STEPS.includes(step)) throw new HardStop('HARD_STEP_RETIRED', `${step} is a 4k held-out step, retired by amendment A2`, 'run the 50k path: heldout-world, slots-50k, cells-50k, oracle-50k, pg-50k, memory-50k, report');
  const p = [...STEPS, ...CONFIRM_STEPS].find(s => s.step === step);
  if (!p) throw new Error(`unknown step ${step}; steps: ${[...STEPS, ...CONFIRM_STEPS].map(s => s.step).join(', ')}`);
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
  /** pg arm setup: embedding price per million tokens; the corpus is embedded once per new world (about 4 characters per token). */
  pg_embed_usd_per_million_tokens: number;
  margin: number;
}

export function loadCostBasis(path = join(HARD_DOCS, 'cost-basis.json')): CostBasis {
  return JSON.parse(readFileSync(path, 'utf8')) as CostBasis;
}

const FAMILIES5 = ['H1', 'H2', 'H3', 'H4', 'H5'];
const FACTOR_ARM: Record<string, string> = { memory: 'fs', gbrain: 'pg' };

export interface Projection { step: string; cells: number; agent_usd: number; judge_usd: number; slot_build_usd: number; pg_setup_usd: number; total_usd: number; with_margin_usd: number; basis: string; rows: Array<{ model: string; arm: string; cells: number; per_cell_usd: number; source: string }> }

/**
 * Project a step's cost, per model, arm and family (Hard cells differ in
 * cost by family far more than by arm: an H1 cell reads dozens of records).
 * Per (model, arm, family): the measured Hard cost per cell when `measured`
 * holds cells for it (cost over every attempt, judge included, divided by
 * canonical cells; cells at the step's scale when there are any, else 4k
 * measurements times the 50k factor for a 50k step);
 * otherwise the v1 cost per cell of that model and arm times the measured Hard
 * factor for the arm and family, plus the measured judge cost for the family.
 * Cells already done (`done`, keys with a harness-clean attempt) are not
 * projected. Slot builds scale with the world's bytes; given the world's size, a step with the pg arm adds
 * embedding the corpus once.
 */
export function project(plan: StepPlan, o: { basis: CostBasis; measured?: CellView[]; measuredScale?: 'v1' | 'large'; worldBytes?: number; done?: CellView[] }): Projection {
  const families = plan.families ?? FAMILIES5;
  const rows: Projection['rows'] = [];
  let agent = 0, judge = 0, cells = 0;
  const doneCount = (model: string, arm: string, f: string) => new Set((o.done ?? []).filter(c => c.harness_clean && c.model === model && c.family === f && (c.arm === arm || (arm === 'gbrain' && c.arm.startsWith('gbrain') && !c.arm.endsWith('+fs')))).map(c => c.key)).size;
  for (const model of plan.models) for (const arm of plan.arms) {
    let rowUsd = 0, rowCells = 0;
    const sources = new Set<string>();
    for (const f of families) {
      const n = Math.max(0, plan.tasksPerFamily * plan.repeats - doneCount(model, arm, f));
      if (!n) continue;
      const all = (o.measured ?? []).filter(c => c.model === model && c.family === f && (c.arm === arm || (arm === 'gbrain' && c.arm.startsWith('gbrain') && !c.arm.endsWith('+fs'))));
      const same = all.filter(c => (o.measuredScale ?? c.scale ?? 'v1') === plan.scale);
      const ms = same.length ? same : all;
      const scale = plan.scale === 'large' && !same.length ? (o.basis.scale_50k_factor[arm] ?? o.basis.scale_50k_factor.default) : 1;
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
  const worldBytes = o.worldBytes ?? (plan.scale === 'large' ? 85_000_000 : 10_500_000);
  const slot_build_usd = (plan.slotBuilds ?? 0) * o.basis.slot_build.usd_per_slot * (worldBytes / o.basis.slot_build.world_bytes);
  const pg_setup_usd = cells && plan.arms.includes('pg') && o.worldBytes ? o.worldBytes / 4 / 1e6 * o.basis.pg_embed_usd_per_million_tokens : 0;
  const total = agent + judge + slot_build_usd + pg_setup_usd;
  return { step: plan.step, cells, agent_usd: agent, judge_usd: judge, slot_build_usd, pg_setup_usd, total_usd: total, with_margin_usd: total * (1 + o.basis.margin), basis: o.measured?.length ? 'measured Hard cells where available, else v1 x measured Hard factor' : 'v1 x measured Hard factor (round 1)', rows };
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

/**
 * A confirmation step's ledger: one of CONFIRM_LEDGERS, present on this machine, with the preregistered cap. The
 * campaign roster (checkRoster) lists the held-out machines' ledgers, which the confirmation machines do not hold.
 */
export function checkConfirmLedger(ledger: string | undefined, root = REPO_ROOT): { hardLedger: string; capUsd: number; committedUsd: number; remainingUsd: number } {
  const known = Object.values(CONFIRM_LEDGERS) as string[];
  if (!ledger || !known.includes(ledger)) throw new HardStop('HARD_LEDGER_ROSTER', `a confirmation step runs on ${known.join(' or ')}, not ${ledger ?? 'no --budget-ledger'}`, 'pass --budget-ledger with the world\'s confirmation ledger (scripts/cat40-hard.sh sets it from CONFIRM_WORLD)');
  const p = resolve(root, ledger);
  if (!existsSync(p)) throw new HardStop('HARD_LEDGER_ROSTER', `${ledger} does not exist on this machine`, `create it once with bun eval/runner/budget-ledger.ts init --budget-ledger ${ledger} --program-cap-usd ${CONFIRM_CAP_USD}; never open a replacement ledger for a world that has spent`);
  const s = ledgerStatus({ ledgerPath: p });
  const cap = s.totals.program_cap_usd ?? NaN;
  if (Math.abs(cap - CONFIRM_CAP_USD) > 0.005) throw new HardStop('HARD_LEDGER_ROSTER', `${ledger} records a cap of $${cap.toFixed(2)}; the preregistration sets $${CONFIRM_CAP_USD}`, 'stop and ask Garry; only his authorization changes a cap');
  return { hardLedger: p, capUsd: cap, committedUsd: s.totals.committed_usd ?? 0, remainingUsd: s.totals.remaining_usd ?? 0 };
}

/**
 * Gate 2 of the confirmation: pooled oracle success over every planned oracle cell (3 models x 100 tasks). A cell
 * with no harness-clean attempt counts as missing, and any missing cell fails the gate.
 */
export function confirmOracleGate(records: Array<Record<string, unknown>>, planned = HARD_MODELS.length * 100): { cells: number; planned: number; successes: number; rate: number; by_model: Record<string, { cells: number; successes: number }>; incomplete: number; pass: boolean } {
  const { cells, incomplete } = canonicalCells(records);
  const oracle = cells.filter(c => c.arm === 'oracle');
  const by_model: Record<string, { cells: number; successes: number }> = {};
  for (const c of oracle) { by_model[c.model] ??= { cells: 0, successes: 0 }; by_model[c.model].cells++; if (c.success) by_model[c.model].successes++; }
  const successes = oracle.filter(c => c.success).length;
  const rate = oracle.length ? successes / oracle.length : 0;
  return { cells: oracle.length, planned, successes, rate, by_model, incomplete: incomplete.length, pass: oracle.length === planned && !incomplete.length && rate >= CONFIRM_ORACLE_MIN };
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
      const scale = flag('--scale');
      if (scale !== undefined && scale !== 'v1' && scale !== 'large') { console.error('--scale must be v1 or large'); process.exit(2); }
      const plan = { ...stepPlan(flag('--step') ?? ''), ...(scale ? { scale: scale as 'v1' | 'large' } : {}) };
      const measured = (flag('--measured') ?? '').split(',').filter(Boolean);
      const views = measured.length ? canonicalCells(readRecords(measured)).attempts : undefined;
      const worldBytes = flag('--world') ? statSync(flag('--world')!).size : undefined;
      const done = flag('--done') && existsSync(flag('--done')!) ? canonicalCells(readRecords([flag('--done')!])).attempts : undefined;
      const p = project(plan, { basis: loadCostBasis(), measured: views, worldBytes, done, measuredScale: flag('--measured-scale') as 'v1' | 'large' | undefined });
      console.log(JSON.stringify(p, null, 2));
    } else if (cmd === 'roster') {
      console.log(JSON.stringify(checkRoster(loadRoster()), null, 2));
    } else if (cmd === 'oracle-gate') {
      const results = flag('--attempts');
      if (!results) { console.error('usage: hard-ops.ts oracle-gate --attempts <confirm-oracle attempts.jsonl>'); process.exit(2); }
      const g = confirmOracleGate(readRecords([results]));
      console.log(JSON.stringify(g, null, 2));
      if (!g.pass) throw new HardStop('HARD_ORACLE_GATE', `pooled oracle success ${(g.rate * 100).toFixed(1)}% on ${g.cells} of ${g.planned} cells (${g.incomplete} without a clean attempt); the gate needs ${CONFIRM_ORACLE_MIN * 100}% on all ${g.planned}`, 'run no counted cells on this world; report it', 'Garry decides what follows a failed oracle gate (PREREG.md, gate 2)');
    } else if (cmd === 'confirm-ledger') {
      const world = flag('--world') as ConfirmWorld | undefined;
      if (world !== 'main' && world !== 'sealed') { console.error('usage: hard-ops.ts confirm-ledger --world main|sealed'); process.exit(2); }
      console.log(JSON.stringify(checkConfirmLedger(CONFIRM_LEDGERS[world]), null, 2));
    } else if (cmd === 'freeze' && argv[1] === 'write') {
      const knobs = flag('--knobs'), note = flag('--note');
      if (!knobs || !note) { console.error('usage: hard-ops.ts freeze write --knobs <knobs.round-N.json> --note "<round and reason>"'); process.exit(2); }
      console.log(JSON.stringify(writeFreeze(resolve(knobs), note), null, 2));
    } else if (cmd === 'freeze' && argv[1] === 'check') {
      const drift = freezeDrift();
      console.log(drift.length ? `frozen code changed: ${drift.join(', ')}` : existsSync(FREEZE_PATH) ? 'frozen code unchanged' : 'no freeze record yet');
      process.exit(drift.length ? 3 : 0);
    } else {
      console.error('usage: bun eval/runner/cat40/hard-ops.ts project --step <step> [--measured <files>] [--world <world.json>] | roster | confirm-ledger --world main|sealed | oracle-gate --attempts <file> | freeze write --knobs <file> --note <text> | freeze check');
      process.exit(2);
    }
  } catch (e) {
    if (e instanceof HardStop) { console.error(e.render()); process.exit(3); }
    throw e;
  }
}

export { HARD_SEEDS };
