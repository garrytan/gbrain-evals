/**
 * Tuned and tuning configurations of the entity-dedupe head-to-head's memory systems (preregistration, "Arms": "Each
 * also gets one tuned configuration where its docs offer a knob (a match threshold or identity properties), tuned only
 * on the held-out seed"; "Budget": tuning runs on the held-out seed at 5 instances per family, at most 4 settings per
 * system, and the chosen setting then runs once on the scored seed).
 *
 * Each system's knob and grid live in its bundle's capability record (docs/comparison-systems/<kind>/entity-h2h/
 * capability.json, entity_h2h_tuning), with the doc links that offer the knob, or the reason there is none. A memory
 * cell's --config is one of
 *
 *   default          the documented defaults (the record's default settings)
 *   tuning:<name>    one grid setting, on the held-out seed at 5 per family only (TUNING_SEED otherwise)
 *   tuned            the setting a recorded choice (run.ts choose) names; never on the held-out seed (TUNING_SEED),
 *                    and never without a choice that covers the system's whole grid (TUNING_CHOICE)
 *
 * The cell records the exact settings (cell.json stack). The launcher starts the stack from them (run.ts stack-env),
 * the shim reports what it applied under GET /health entity_h2h, and the runner refuses a cell whose stack reports any
 * other setting or settings (STACK_CONFIG_MISMATCH) before it opens an attempt. The preregistration does not say how
 * the tuned setting is chosen from the tuning cells, so choose records the operator's pick, the rule it cites and
 * every tuning cell's held-out score; it picks nothing itself.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RunnerRefusal } from '../runner-refusal.ts';
import { readCell } from './ledger.ts';
import { MEMORY_KINDS, TUNING_PER_FAMILY, TUNING_SETTINGS, type MemoryKind } from './rates.ts';
import { parseOutput, scoreOutput, type OutputScore } from './score.ts';
import { HELD_OUT_SEED, loadWorld } from './world.ts';

const BUNDLES = resolve(import.meta.dir, '../../../docs/comparison-systems');

export type Settings = Record<string, number | boolean | string>;
export interface Tuning {
  knob: string | null;
  applied_by: 'shim' | 'server-env' | null;
  docs: string[];
  no_knob?: string;
  default: Settings;
  grid: Record<string, { settings: Settings }>;
}
export interface StackSetting { kind: 'default' | 'tuning' | 'tuned'; setting: string; settings: Settings; choice?: TuningChoice }
export interface TuningChoice {
  choice: 'entity-h2h-tuning-choice';
  system: string;
  setting: string;
  settings: Settings;
  rule: string;
  grid_sha256: string;
  held_out: { seed: number; per_family: number; pages: number; people_ledger_sha256: string; company_ledger_sha256: string };
  cells: Array<{ dir: string; setting: string; cell_sha256: string; output_sha256: string; auto: Record<'person' | 'company', { false_merge: unknown; designed_recall: unknown }> }>;
  at: string;
}

const SETTING_NAME = /^[a-z0-9][a-z0-9.-]{0,40}$/;
const ENV_KEY = /^[A-Z][A-Z0-9_]*$/;

/** Canonical JSON (sorted keys), so two settings objects compare by value. */
export const canonical = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** A memory system's knob and grid, from its bundle's capability record; throws on a record that breaks the rules. */
export function tuningOf(kind: string): Tuning {
  if (!(MEMORY_KINDS as readonly string[]).includes(kind)) throw new Error(`entity-h2h: ${kind} is not a memory-system kind (${MEMORY_KINDS.join(', ')})`);
  const t = (JSON.parse(readFileSync(join(BUNDLES, kind, 'entity-h2h', 'capability.json'), 'utf8')) as { entity_h2h_tuning?: Tuning }).entity_h2h_tuning;
  if (!t) throw new Error(`entity-h2h: ${kind}'s entity-h2h capability record has no entity_h2h_tuning`);
  const names = Object.keys(t.grid);
  if (names.length > TUNING_SETTINGS) throw new Error(`entity-h2h: ${kind}'s tuning grid has ${names.length} settings; the preregistration allows at most ${TUNING_SETTINGS}`);
  if (!t.knob !== !names.length || !t.knob !== !t.applied_by || (!t.knob && !t.no_knob)) throw new Error(`entity-h2h: ${kind}'s entity_h2h_tuning must name a knob, how it is applied and a grid, or no knob with the reason`);
  for (const n of names) {
    if (n === 'default' || !SETTING_NAME.test(n)) throw new Error(`entity-h2h: ${kind}'s tuning setting name ${JSON.stringify(n)} must be lowercase letters, digits, dots and hyphens, and not default`);
    if (canonical(Object.keys(t.grid[n].settings).sort()) !== canonical(Object.keys(t.default).sort())) throw new Error(`entity-h2h: ${kind}'s tuning setting ${n} must set exactly the knobs its default sets`);
  }
  if (t.applied_by === 'server-env') for (const k of Object.keys(t.default)) if (!ENV_KEY.test(k)) throw new Error(`entity-h2h: ${kind}'s server-env knob ${k} is not an environment variable name`);
  return t;
}

export const configLabel = (s: StackSetting) => (s.kind === 'default' ? 'default' : `${s.kind}:${s.setting}`);
const gridSha = (t: Tuning) => sha256(canonical(t.grid));

/** The stack setting a memory cell's --config names (default, tuning:<name>, or tuned with --choice FILE). */
export function resolveConfig(kind: string, config: string, choicePath?: string): StackSetting {
  const t = tuningOf(kind);
  if (config === 'default') {
    if (choicePath) throw new Error('entity-h2h: --choice goes with --config tuned only');
    return { kind: 'default', setting: 'default', settings: t.default };
  }
  if (!t.knob) throw new Error(`entity-h2h: ${kind} has no dedupe knob in its docs, so it runs --config default only (${t.no_knob})`);
  if (config.startsWith('tuning:')) {
    const name = config.slice('tuning:'.length);
    if (!t.grid[name]) throw new Error(`entity-h2h: ${kind} has no tuning setting ${JSON.stringify(name)}; its grid is ${Object.keys(t.grid).join(', ')} (capability.json entity_h2h_tuning)`);
    if (choicePath) throw new Error('entity-h2h: --choice goes with --config tuned only');
    return { kind: 'tuning', setting: name, settings: t.grid[name].settings };
  }
  if (config === 'tuned') {
    const choice = readChoice(kind, choicePath);
    return { kind: 'tuned', setting: choice.setting, settings: choice.settings, choice };
  }
  throw new Error(`entity-h2h: --config for a memory system is default, tuning:<setting> (${Object.keys(t.grid).join(', ')}) or tuned --choice FILE`);
}

/** A tuning cell runs only on the held-out seed at 5 per family; a tuned cell never runs on the held-out seed. */
export function checkWorldFor(s: StackSetting, world: { seed: number; per_family: number }): void {
  if (s.kind === 'tuning' && (world.seed !== HELD_OUT_SEED || world.per_family !== TUNING_PER_FAMILY))
    throw new RunnerRefusal('TUNING_SEED', `entity-h2h: a tuning cell runs only on the held-out seed ${HELD_OUT_SEED} at ${TUNING_PER_FAMILY} per family; this world is seed ${world.seed} at ${world.per_family} per family`, { seed: world.seed, per_family: world.per_family },
      `write the tuning world with: bun eval/runner/entity-h2h/run.ts world --seed ${HELD_OUT_SEED} --per-family ${TUNING_PER_FAMILY} --output DIR`);
  if (s.kind === 'tuned' && world.seed === HELD_OUT_SEED)
    throw new RunnerRefusal('TUNING_SEED', `entity-h2h: a tuned cell never runs on the held-out seed ${HELD_OUT_SEED}, which chose its setting; nothing scored comes from it`, { seed: world.seed, per_family: world.per_family },
      'run the tuned cell on the scored seed');
}

/** Refuses (STACK_CONFIG_MISMATCH) unless the shim's GET /health reports exactly the cell's setting and settings. */
export function checkStack(s: StackSetting, health: Record<string, unknown>, shim: string): void {
  const got = health.entity_h2h as { setting?: unknown; settings?: unknown } | undefined;
  const want = { setting: s.setting, settings: s.settings };
  if (got && canonical({ setting: got.setting, settings: got.settings }) === canonical(want)) return;
  throw new RunnerRefusal('STACK_CONFIG_MISMATCH', `entity-h2h: the stack at ${shim} reports ${got ? canonical({ setting: got.setting, settings: got.settings }) : 'no entity_h2h setting'} under GET /health, not the cell's ${canonical(want)}`,
    { settings_expected: Object.keys(s.settings).length, settings_reported: got?.settings && typeof got.settings === 'object' ? Object.keys(got.settings).length : 0 },
    'start the stack from the cell: bun eval/runner/entity-h2h/run.ts stack-env (eval/runner/entity-h2h/ubicloud/vm-run.sh does), rebuilding its image if its capability record changed');
}

/** The environment that starts a stack in a setting: ENTITY_H2H_SETTING, plus each knob for a server-env system. */
export function stackEnv(kind: string, s: StackSetting): string[] {
  const t = tuningOf(kind);
  if (s.setting !== 'default' && !SETTING_NAME.test(s.setting)) throw new Error(`entity-h2h: setting name ${JSON.stringify(s.setting)} is not a setting name`);
  const lines = [`ENTITY_H2H_SETTING=${s.setting}`];
  if (t.applied_by === 'server-env') for (const [k, v] of Object.entries(s.settings)) {
    if (!ENV_KEY.test(k) || !/^[0-9A-Za-z._-]+$/.test(String(v))) throw new Error(`entity-h2h: ${k}=${v} is not a plain environment setting`);
    lines.push(`${k}=${v}`);
  }
  return lines;
}

const choiceRefusal = (detail: string, fix = 'record the choice from every tuning cell of the system: bun eval/runner/entity-h2h/run.ts choose --system S --setting NAME --rule TEXT --held-out DIR --out FILE CELL...') =>
  new RunnerRefusal('TUNING_CHOICE', `entity-h2h: ${detail}`, { choices: 0 }, fix);

/** A recorded tuning choice, checked against the system's current grid; refuses (TUNING_CHOICE) on any gap. */
export function readChoice(kind: string, path: string | undefined): TuningChoice {
  if (!path) throw choiceRefusal(`a tuned ${kind} cell needs --choice FILE, the recorded choice from its tuning cells`);
  if (!existsSync(path)) throw choiceRefusal(`no recorded choice at ${path}`);
  const t = tuningOf(kind);
  const c = JSON.parse(readFileSync(path, 'utf8')) as TuningChoice;
  const problems: string[] = [];
  if (c.choice !== 'entity-h2h-tuning-choice') problems.push('it is not a tuning choice record');
  if (c.system !== kind) problems.push(`it is for ${c.system}, not ${kind}`);
  if (!t.grid[c.setting]) problems.push(`its setting ${JSON.stringify(c.setting)} is not in the grid (${Object.keys(t.grid).join(', ')})`);
  else if (canonical(c.settings) !== canonical(t.grid[c.setting].settings)) problems.push(`its settings ${canonical(c.settings)} differ from the grid's ${canonical(t.grid[c.setting].settings)}`);
  if (c.grid_sha256 !== gridSha(t)) problems.push('the grid changed since the tuning cells ran');
  if (c.held_out?.seed !== HELD_OUT_SEED || c.held_out?.per_family !== TUNING_PER_FAMILY) problems.push(`its tuning cells ran on seed ${c.held_out?.seed} at ${c.held_out?.per_family} per family, not the held-out seed ${HELD_OUT_SEED} at ${TUNING_PER_FAMILY}`);
  const ran = (c.cells ?? []).map(x => x.setting).sort();
  if (canonical(ran) !== canonical(Object.keys(t.grid).sort())) problems.push(`its tuning cells cover ${ran.join(', ') || 'nothing'}, not the whole grid (${Object.keys(t.grid).sort().join(', ')})`);
  if (!c.rule?.trim()) problems.push('it cites no selection rule');
  if (problems.length) throw choiceRefusal(`the choice at ${path} is not usable: ${problems.join('; ')}`);
  return c;
}

/**
 * Records which grid setting a tuned cell runs, from every tuning cell of the system: each must be complete, on the
 * held-out seed at 5 per family (one world for all) and in one grid setting, and the cells must cover the grid exactly
 * once. Writes each cell's held-out score beside the operator's setting and the rule it cites; picks nothing.
 */
export function chooseSetting(kind: string, setting: string, rule: string, heldOutDir: string, cellDirs: readonly string[], out: string): { choice: TuningChoice; scores: OutputScore[] } {
  const t = tuningOf(kind);
  if (!t.knob) throw new Error(`entity-h2h: ${kind} has no dedupe knob in its docs, so it has no tuning cells to choose from`);
  if (!t.grid[setting]) throw new Error(`entity-h2h: ${kind} has no tuning setting ${JSON.stringify(setting)}; its grid is ${Object.keys(t.grid).join(', ')}`);
  if (!rule.trim()) throw new Error('entity-h2h: --rule must cite the selection rule and where it is stated');
  if (existsSync(out)) throw new Error(`entity-h2h: ${out} exists; a choice is recorded once`);
  const w = loadWorld(heldOutDir);
  checkWorldFor({ kind: 'tuning', setting, settings: t.grid[setting].settings }, w);
  const known = new Set(w.pages.map(p => p.key));
  const seen = new Set<string>();
  const cells: TuningChoice['cells'] = [], scores: OutputScore[] = [];
  for (const dir of cellDirs) {
    const s = readCell(dir);
    if (!s) throw choiceRefusal(`${dir} has no cell.json`);
    const stack = (s as { stack?: StackSetting }).stack;
    if (s.system !== kind || stack?.kind !== 'tuning') throw choiceRefusal(`${dir} is a ${s.system} ${s.config} cell, not a ${kind} tuning cell`);
    if (s.status !== 'complete') throw choiceRefusal(`${dir} is ${s.status}; every tuning cell must be complete`);
    if (!t.grid[stack.setting] || canonical(stack.settings) !== canonical(t.grid[stack.setting].settings)) throw choiceRefusal(`${dir} ran ${stack.setting} ${canonical(stack.settings)}, which is not a setting of the grid`);
    if (seen.has(stack.setting)) throw choiceRefusal(`two tuning cells ran ${stack.setting}; pass one per setting`);
    if (s.world.people_ledger_sha256 !== w.fingerprints.people || s.world.company_ledger_sha256 !== w.fingerprints.companies) throw choiceRefusal(`${dir} ran on another world than ${heldOutDir} (seed ${s.world.seed} at ${s.world.per_family} per family)`);
    seen.add(stack.setting);
    const outputText = readFileSync(join(dir, 'output.json'), 'utf8');
    const subjects = existsSync(join(dir, 'subjects.json')) ? (JSON.parse(readFileSync(join(dir, 'subjects.json'), 'utf8')) as Array<{ key: string; node: string | null }>).filter(x => !x.node).map(x => x.key) : undefined;
    const score = scoreOutput(w, parseOutput(JSON.parse(outputText), known), { unresolved: subjects });
    scores.push(score);
    const auto = score.points.auto;
    cells.push({ dir: resolve(dir), setting: stack.setting, cell_sha256: sha256(readFileSync(join(dir, 'cell.json'), 'utf8')), output_sha256: sha256(outputText),
      auto: { person: { false_merge: auto.person.false_merge, designed_recall: auto.person.designed_recall }, company: { false_merge: auto.company.false_merge, designed_recall: auto.company.designed_recall } } });
  }
  const missing = Object.keys(t.grid).filter(n => !seen.has(n));
  if (missing.length) throw choiceRefusal(`no complete tuning cell for ${missing.join(', ')}; the choice is made from the whole grid`, `run the missing settings on the held-out world first (run.ts run --system ${kind} --config tuning:<setting> ...)`);
  const choice: TuningChoice = { choice: 'entity-h2h-tuning-choice', system: kind, setting, settings: t.grid[setting].settings, rule, grid_sha256: gridSha(t),
    held_out: { seed: w.seed, per_family: w.per_family, pages: w.pages.length, people_ledger_sha256: w.fingerprints.people, company_ledger_sha256: w.fingerprints.companies },
    cells: cells.sort((a, b) => a.setting.localeCompare(b.setting)), at: new Date().toISOString() };
  writeFileSync(out, JSON.stringify(choice, null, 2) + '\n', { flag: 'wx' });
  return { choice, scores };
}
